// src/http/routes/taskPackage.js — 任务卡端点
// 依据：INTERFACES.md §2「API（P1）」+ 设计文档 §8
// 溯源需求：R-ENT-01 / R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09 / R-ENT-10 / R-ENT-12
// 三态状态码（设计文档 §7.3）：列表不满足 → 200+空集；单条不满足 → 404；禁用 → 403
import { AppError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import { checkTaskMix } from '../../domain/solvability.js';
import {
  submitTaskPackage, assessSolvability, approveTaskPackage, listTaskPackages,
} from '../../services/taskPackage.js';

export function registerTaskPackageRoutes({ router, db, rules }) {
  router.add('POST', '/api/task-packages', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:write', { scopeType: 'edition', scopeId: body?.editionId ?? null }, db)) {
      throw new AppError(403, 'FORBIDDEN', '没有提交任务卡的权限');
    }
    return submitTaskPackage({ db, userId: user.id, payload: body, rules });
  });

  router.add('GET', '/api/task-packages', async ({ user, query }) => {
    const items = listTaskPackages({ db, filter: { editionId: query.editionId }, viewer: user, rules });
    // R-ENT-09：配比体检只对组委会开放。
    // ⚠️ 父代理预审修正（Important）：配比体检的对象是**已发布（进池）的任务卡**。
    //    原来直接用 items —— 组委会视图里 items 含未分级的卡（status = submitted /
    //    assessed），它们的 grade 为 null → byGrade 全落在 'ungraded' 上 →
    //    体检结果失真（父代理预审实跑：10 张未分级卡 → A/B/C 级计数全为 0）。
    //    R-ENT-09 的四档（A 40% / B 20% / C 10% / 自由 30%）描述的是**任务池**构成，
    //    未分级的卡还没进池。
    const mix = can(user, 'task_package:approve', { scopeType: 'edition', scopeId: query.editionId ?? null }, db)
      ? checkTaskMix(items.filter((p) => p.status === 'published'), rules.solvability)
      : null;
    return { items, mix };
  });

  router.add('POST', '/api/task-packages/:id/solvability', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:write', { scopeType: 'task_package', scopeId: params.id }, db)) {
      throw new AppError(403, 'FORBIDDEN', '没有评估任务卡的权限');
    }
    return assessSolvability({
      db, taskPackageId: params.id, answers: body?.answers ?? body, actorId: user.id, rules,
    });
  });

  router.add('POST', '/api/task-packages/:id/approve', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:approve', { scopeType: 'task_package', scopeId: params.id }, db)) {
      throw new AppError(403, 'FORBIDDEN', '没有分级签约的权限');
    }
    // ⚠️ P10（W4-a）：**退回理由**一并收（body.reason）——
    //    主动签 D 级时理由必填（服务层校验），理由落进 meta 与审计日志。
    return approveTaskPackage({
      db, taskPackageId: params.id, grade: body?.grade, reason: body?.reason ?? null,
      actorId: user.id, rules,
    });
  });
}

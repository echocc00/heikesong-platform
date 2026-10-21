// src/http/routes/milestone.js — 企业里程碑签字 API
// 依据：INTERFACES.md §3 的 API 约定 + 设计文档 §8（HTTP 层只做解析与鉴权，业务在 service）
//   权限：capability + assignment（唯一入口 can()）—— signoff:create（企业席 / 企业管理员）。
import { AppError } from '../../errors.js';
import { createSignoff, withdrawSignoff } from '../../services/milestone.js';

export function registerMilestoneRoutes(router) {
  router.add('POST', '/api/milestones/:id/signoff', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return createSignoff({
      db: ctx.db,
      milestoneId: ctx.params.id,
      actorId: ctx.user.id,
      body: ctx.body,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  router.add('POST', '/api/milestones/:id/signoff/withdraw', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return withdrawSignoff({
      db: ctx.db,
      milestoneId: ctx.params.id,
      signoffId: ctx.body?.signoffId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });
}

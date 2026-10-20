// src/http/routes/team.js — 战队端点
// 依据：INTERFACES.md §2「API（P1）」+ 设计文档 §8
import { AppError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import {
  createTeam, getTeam, addMember, leaveTeam, replaceMember, updateTeam, listMyTeams,
} from '../../services/team.js';

export function registerTeamRoutes({ router, db, rules }) {
  router.add('POST', '/api/teams', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    // ⚠️ 父代理预审修正（Critical，规格缺陷）：`team:create` 这个能力点被注册、
    //    被 seed 授予（captain 角色），但**路由从不校验它** → 能力点形同虚设，
    //    违反全局约束「权限模型 = capability + assignment，`can()` 是唯一判定入口」。
    //    与 P1 Task 3 的 A1（registration:write）、Task 4 的 T4-5（task_package:write）
    //    同一类病根：**机制写下来了，但没接线**。
    //    作用域带上 edition —— `can()` 传 ctx=null 会跳过资源级授权的 scope 匹配
    //    （Task 3 评审 T3-7 的同一条教训）。
    if (!can(user, 'team:create', { scopeType: 'edition', scopeId: body?.editionId ?? null }, db)) {
      throw new AppError(403, 'FORBIDDEN', '你没有建队的权限');
    }
    return createTeam({
      db,
      userId: user.id,
      editionId: body?.editionId,
      taskPackageId: body?.taskPackageId,
      name: body?.name,
      rules,
    });
  });

  // 我参与的战队（⚠️ 契约外新增端点，见文末偏差 D-2）
  // 可见性天然收敛：只返回自己参与或自己组长的战队，不需要额外能力点。
  router.add('GET', '/api/teams', async ({ user }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return { items: listMyTeams({ db, userId: user.id, rules }) };
  });

  router.add('GET', '/api/teams/:id', async ({ user, params }) => {
    const team = getTeam({ db, id: params.id, viewer: user, rules });
    if (!team) throw new AppError(404, 'NOT_FOUND', '战队不存在');
    return team;
  });

  // 加入 / 退出 / 汰换共用一个端点（设计文档 §8：POST /api/teams/:id/members）
  router.add('POST', '/api/teams/:id/members', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const action = body?.action ?? 'add';
    if (action === 'add') {
      // ⚠️ 父代理预审修正（Critical）：**加入只能是自己加入**。
      //    原来把 `body.userId` 直接交给服务层 → 任何登录用户都能**替别人**加入战队
      //    （服务层只校验「该同学已通过报名且被接收」，不校验 actor 与 userId 的关系）。
      //    「拉人入队」是组委会/队长的事，走 `action=replace`（汰换）或 P2 的邀请流程。
      return addMember({
        db, teamId: params.id, userId: user.id, actorId: user.id, rules,
      });
    }
    if (action === 'leave') {
      // ⚠️ 父代理预审修正（Critical）：**退出只能是自己退出**。
      //    原来 `userId: body?.userId ?? user.id` → 客户端传别人的 id 就能
      //    **把别人踢出战队**（服务层只查「该同学在此战队」，不校验 actor）—— 越权踢人。
      //    组长要换人走 `action=replace`（汰换移交），不是 leave。
      return leaveTeam({ db, teamId: params.id, userId: user.id, rules });
    }
    if (action === 'replace') {
      // 汰换的权限在服务层判定：队长或组委会（team:manage）—— 见 services/team.js
      return replaceMember({
        db, teamId: params.id, outUserId: body?.outUserId, inUserId: body?.inUserId,
        actorId: user.id, rules,
      });
    }
    throw new AppError(400, 'INVALID_ACTION', 'action 只能是 add / leave / replace');
  });

  router.add('PATCH', '/api/teams/:id', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    // 权限在服务层判定：队长或组委会（team:manage）—— 见 services/team.js 的 updateTeam
    return updateTeam({ db, teamId: params.id, patch: body ?? {}, actorId: user.id, rules });
  });
}

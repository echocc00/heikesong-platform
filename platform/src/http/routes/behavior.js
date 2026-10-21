// src/http/routes/behavior.js — 行为分事件提交 API
// 依据：INTERFACES.md §3 的 API 约定 + R-PTS-10 反作弊 5 条
//   权限：capability + assignment（唯一入口 can()）—— behavior:write（队长 / 组员）。
import { AppError } from '../../errors.js';
import { submitBehaviorEvent } from '../../services/behavior.js';

export function registerBehaviorRoutes(router) {
  router.add('POST', '/api/teams/:id/behavior-events', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return submitBehaviorEvent({
      db: ctx.db,
      teamId: ctx.params.id,
      actorId: ctx.user.id,
      body: ctx.body,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });
}

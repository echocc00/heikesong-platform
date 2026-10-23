// src/http/routes/publish.js — 赛段发榜（P11 新建）
//
// 依据：设计文档 §8「API 设计」+ §9「发榜页：榜单 + trace 抽屉 + 降级告警置顶」
//   + 任务书 §七（名次积分 / 奖金 / MVP）
//
// ⛔ **P11 · 这个文件为什么存在（E149）**：
//   设计文档 §8 的 API 清单里**漏了一条 publish 端点** —— 清单里只有
//   `POST /api/stages/:stageId/compute`（算），没有「发榜」这个动作的入口。
//   于是服务层的 `publishLeaderboard`（写榜单快照 + 段位记录 + 名次积分流水 + 发榜审计）
//   **写了、也测了（25 处引用全绿），但路由表里没有任何一条路能触达它**。
//   后果（真机实测）：
//     · `points_ledger` = 0   ⇒ 名次积分从未发放 ⇒ 个人榜恒为空；
//     · `tier_records` = 0    ⇒ 段位永远兜底 D 段 ⇒ **段位权益永不解锁**；
//     · `leaderboard_snapshots` = 0 ⇒ 没有发榜快照 ⇒ 赛后复盘没有权威口径；
//     · `leaderboard.publish` 审计 = 0 ⇒ 发榜这件事**没有留痕**。
//   ⇒ 补这个端点就是把「写好了但接不上」的最后一个动作接上。
//
// ⛔ **计算 ≠ 发榜**（设计文档 §869 明写）：
//   「`compute` 是显式动作，不自动触发。**发榜**是一个有后果的动作（影响奖金），
//     必须有明确的操作者与时间戳。」
//   ⇒ 两个**独立**的显式动作、两个独立的能力点校验点、两次独立的审计留痕。
//   ⇒ 这里**不**顺带调用 computeStage：组委会要先算、看告警、确认无误，再点发榜。
//
// ⚠️ **三态状态码**（设计文档 §7.3）：
//   赛段不存在 → 404；没有发榜权限 → 403；发榜成功 → 200。
//
// ⚠️ **可重发**：发榜不是「一次性动作」—— 组委会改完数据后可以重算重发，
//   差额会走**积分流水的更正记录**（只增不改，更正走新记录，见 services/leaderboard.js）。
import { AppError } from '../../errors.js';
import { publishLeaderboard, getPublishState } from '../../services/leaderboard.js';
import { getStage } from '../../db/repo/stages.js';

/**
 * 发榜权限判定：与服务层 `publishLeaderboard` **同口径**（届期级或赛段级 `stage:compute`）。
 * ⛔ 两边必须一致 —— 否则会出现「前端放行、API 403」或「前端拦下、API 放行」。
 *    （全局授权与角色授权在 can() 里本来就放行，这里只关心「作用域型授权」。）
 */
function requirePublishCapability(ctx, editionId) {
  if (ctx.can('stage:compute', { scopeType: 'edition', scopeId: editionId })) return;
  if (ctx.can('stage:compute', { scopeType: 'stage', scopeId: ctx.params.stageId })) return;
  throw new AppError(403, 'FORBIDDEN', '缺少能力：stage:compute（发榜）');
}

/**
 * 注册发榜端点。
 * @param {object} router createRouter() 的返回值
 */
export function registerPublishRoutes(router) {
  // ── 发榜（写）──────────────────────────────────────────────────────
  // ⚠️ GET 与 POST 同路径不冲突：路由表按 **method + path** 匹配。
  router.add('POST', '/api/stages/:stageId/publish', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const stage = getStage(ctx.db, ctx.params.stageId);
    // ⚠️ 名册判定**先于**权限判定？—— 不，权限先判：404 与 403 的取舍按「有没有这个赛段」，
    //    但**未登录**的人不该知道赛段存不存在 ⇒ 401 最先。
    if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requirePublishCapability(ctx, stage.edition_id);
    return publishLeaderboard({
      db: ctx.db,
      editionId: stage.edition_id,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  // ── 发榜状态（读）──────────────────────────────────────────────────
  // ⛔ 这个读口原先**不存在** ⇒ 前端刷新页面后不知道自己刚发过榜，
  //    也不知道 TOP 名单回访清单（R-JDG-16）是什么。
  router.add('GET', '/api/stages/:stageId/publish', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const stage = getStage(ctx.db, ctx.params.stageId);
    if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requirePublishCapability(ctx, stage.edition_id);
    return getPublishState({
      db: ctx.db,
      stageId: ctx.params.stageId,
      rules: ctx.rules,
    });
  });
}

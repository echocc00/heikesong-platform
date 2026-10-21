// src/http/routes/review.js — 评审 API
//
// 依据：INTERFACES.md §3「API（P2）」+ 设计文档 §8。
//   权限：capability + assignment（唯一入口 can()）。P2 阶段先做「登录 + 能力点」判定，
//   行级 scope 由 P3/P4 的 scopeClause 补齐。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 5 处修正，读代码前先看这段】
//   ① **回避可代他人申报** → 任何有 `score:write` 的人都能把**别的评委**拉下水，
//      那个评委的打分随即被剔除（computeStage 里按回避剔除打分）——
//      这是「打分 sabotage」，不是能力点该给的权限。现在只有本人能给自己申报，
//      代录仅限组委会（`stage:compute`），且被申报人必须在本赛段评委名单里。
//   ② **企业确认可代签 / 可冒名** → 企业确认占初赛 10% / 决赛 25% 的权重，
//      原实现允许任意有 `score:write` 的人为任意队伍、任意企业「签字」，
//      甚至把 `signatoryUserId` 伪造成别人。现在出题企业只能为自己签，
//      跨领域评委必须真实存在于本赛段名单且与签字人不同；组委会可代录（留审计）。
//   ③ **自评可代队伍提交** → 决赛「自评测」占 P 席 5%，
//      原实现允许任意有 `score:write` 的人替任意队伍提交自评 ——
//      等于「给别人加分」。现在自评用独立能力点 `self_review:write`（队长/组员持有），
//      且必须是**本队成员**才能提交。
//   ④ **互评可代队伍提交** → 同理，现在要求提交者是该支互评发起队的在册成员。
//   ⑤ **能力点校验的作用域** → 原来传 `{ scopeType: 'global' }`，
//      只能认全局授权，赛段级授权一律不认。现在同时认赛段级与全局级授权
//      （都走 `can()`，唯一判定入口）。
import { AppError } from '../../errors.js';
import {
  submitReviews,
  getReviewState,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  declareRecusal,
  submitEnterpriseConfirmation,
} from '../../services/review.js';
import { computeStage, getComputation } from '../../services/compute.js';
import { getStage, getStageJudge, listStageTeams } from '../../db/repo/stages.js';
import { getTeamWithPackage } from '../../db/repo/teams.js';
import { listActiveMembers } from '../../db/repo/teamMembers.js';

function requireUser(ctx) {
  if (!ctx.user) {
    throw new AppError(401, 'UNAUTHENTICATED', '未登录');
  }
  return ctx.user;
}

/**
 * 能力点校验：认**赛段级**与**全局级**授权（都走 can()）。
 * ⚠️ 不能只传 `{ scopeType: 'global' }` —— 那等于「只认全局授权」，
 *    赛段级授权（scope_type='stage'）会被静默判成无权。
 */
function requireStageCapability(ctx, capability) {
  requireUser(ctx);
  const stageId = ctx.params?.stageId ?? null;
  if (ctx.can(capability, { scopeType: 'stage', scopeId: stageId })) return;
  if (ctx.can(capability, { scopeType: 'global' })) return;
  throw new AppError(403, 'FORBIDDEN', `缺少能力：${capability}`);
}

/** 是否组委会（可看全局进度、可代录） */
function isCommittee(ctx) {
  if (!ctx.user) return false;
  const stageId = ctx.params?.stageId ?? null;
  return ctx.can('stage:compute', { scopeType: 'stage', scopeId: stageId })
    || ctx.can('stage:compute', { scopeType: 'global' });
}

/** 是否企业席（能签企业确认）—— `signoff:create` 是企业角色的能力点 */
function isEnterpriseSeat(ctx) {
  if (!ctx.user) return false;
  const stageId = ctx.params?.stageId ?? null;
  return ctx.can('signoff:create', { scopeType: 'stage', scopeId: stageId })
    || ctx.can('signoff:create', { scopeType: 'global' });
}

/** 本人是否是该队的在册成员 */
function isTeamMember(db, teamId, userId) {
  if (!teamId || !userId) return false;
  return listActiveMembers(db, teamId).some((m) => m.user_id === userId);
}

/**
 * 评委只能给**评委席维度**打分。
 * ⚠️ 父代理预审修正（Important，I3）：
 *   原来维度键不校验 → 评委可以对 `seat='self'` 的维度（「自评测」）打分，
 *   于是「自评只能本队成员提交」这道闸门被整个绕过去 ——
 *   评委自己填 100 分，自评栏就归他了（R-JDG-13「不加分」直接失效）。
 *   领域层也做了同样的防御（自评席维度不取评委打分记录），这里是写入口的第一道。
 */
function assertJudgeDimensions(ctx, items) {
  const stage = getStage(ctx.db, ctx.params.stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const config = ctx.rules?.scoring?.[stage.scoring_config_key];
  if (!config) {
    throw new AppError(500, 'SCORING_CONFIG_MISSING', `赛段 ${stage.id} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  }
  const dims = new Map((config.dimensions ?? []).map((d) => [d.key, d]));
  for (const item of items) {
    const dim = dims.get(item.dimension);
    if (!dim) {
      throw new AppError(400, 'UNKNOWN_DIMENSION', `未知评分维度：${item.dimension}`);
    }
    if (dim.seat !== 'judge') {
      throw new AppError(403, 'DIMENSION_SEAT_FORBIDDEN', `维度 ${item.dimension} 不属于评委席，不能由评委打分`);
    }
  }
}

export function registerReviewRoutes(router) {
  router.add('POST', '/api/stages/:stageId/reviews', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    const items = ctx.body?.items ?? [];
    assertJudgeDimensions(ctx, items);
    return submitReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items,
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
  });

  router.add('GET', '/api/stages/:stageId/review-state', async (ctx) => {
    requireUser(ctx);
    // 权限：组委会 / 有评分读取能力的人 / 本赛段队伍成员（队长看本队自评进度）
    if (!isCommittee(ctx)
      && !ctx.can('score:read', { scopeType: 'stage', scopeId: ctx.params.stageId })
      && !ctx.can('score:read', { scopeType: 'global' })
      && !getStageJudge(ctx.db, ctx.params.stageId, ctx.user.id)) {
      throw new AppError(403, 'FORBIDDEN', '没有查看评审进度的权限');
    }
    return getReviewState({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
    });
  });

  router.add('POST', '/api/stages/:stageId/calibration', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    return submitCalibration({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items: ctx.body?.items ?? [],
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/peer-reviews', async (ctx) => {
    requireStageCapability(ctx, 'peer_review:write');
    const items = ctx.body?.items ?? [];
    // ⛔ 互评是「队 → 队」的动作：提交者必须在发起队里（父代理预审修正 ④）
    for (const item of items) {
      if (!isTeamMember(ctx.db, item.fromTeamId, ctx.user.id)) {
        throw new AppError(403, 'NOT_TEAM_MEMBER', '只能代表本队提交互评');
      }
    }
    return submitPeerReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      items,
      requestId: ctx.body?.requestId ?? null,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/self-review', async (ctx) => {
    requireStageCapability(ctx, 'self_review:write');
    const teamId = ctx.body?.teamId;
    if (!teamId) {
      throw new AppError(400, 'MISSING_TEAM_ID', '缺少队伍');
    }
    if (!isTeamMember(ctx.db, teamId, ctx.user.id)) {
      throw new AppError(403, 'NOT_TEAM_MEMBER', '只能为本队提交自评');
    }
    return submitSelfReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      teamId,
      items: ctx.body?.items ?? [],
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/enterprise-confirmations', async (ctx) => {
    const stageId = ctx.params.stageId;
    const actorId = ctx.user.id;
    const committee = isCommittee(ctx);
    // ⛔ 只有**企业席**（signoff:create）或组委会能签企业确认（父代理预审修正 ② / C1）
    if (!isEnterpriseSeat(ctx) && !committee) {
      throw new AppError(403, 'FORBIDDEN', '只有出题企业（或组委会）可以签署企业确认');
    }
    requireStageCapability(ctx, 'score:write');
    // 出题企业只能为自己签
    const enterpriseId = ctx.body?.enterpriseId ?? actorId;
    if (enterpriseId !== actorId && !committee) {
      throw new AppError(403, 'FORBIDDEN', '企业确认只能由出题企业本人签署（组委会可代录）');
    }
    if (ctx.body?.signatoryUserId && ctx.body.signatoryUserId !== enterpriseId) {
      throw new AppError(403, 'FORBIDDEN', '签字人必须与出题企业一致');
    }
    // ⛔ 被签的队伍必须在本赛段名册内，且必须**确实由这家企业出题**
    //    （否则一条冒名记录就能把受害队伍的企业席连坐作废 —— 父代理预审 C1）
    const teamId = ctx.body?.teamId;
    const team = teamId ? getTeamWithPackage(ctx.db, teamId) : null;
    if (!team) {
      throw new AppError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    }
    // 名册判定**先于**归属判定：名册外的队伍 → 404（三态：单条不满足 → 404），
    // 而不是「归属不符 → 403」（那会泄露「这支队存在但不是你家的」）。
    const roster = listStageTeams(ctx.db, stageId).map((t) => t.teamId);
    if (!roster.includes(teamId)) {
      throw new AppError(404, 'TEAM_NOT_IN_STAGE', `队伍 ${teamId} 不在本赛段名册内`);
    }
    if (!committee && team.packageEnterpriseId !== actorId) {
      throw new AppError(403, 'FORBIDDEN', '该队伍的任务包不是贵司出的题，不能代签企业确认');
    }
    const crossJudgeId = ctx.body?.crossJudgeId ?? null;
    if (crossJudgeId && crossJudgeId === enterpriseId) {
      throw new AppError(400, 'CROSS_JUDGE_SAME_AS_SIGNATORY', '跨领域评委签字人不能与出题企业签字人相同');
    }
    if (crossJudgeId && !getStageJudge(ctx.db, stageId, crossJudgeId)) {
      throw new AppError(404, 'JUDGE_NOT_ASSIGNED', '跨领域评委不在本赛段名单内');
    }
    return submitEnterpriseConfirmation({
      db: ctx.db,
      stageId,
      teamId,
      enterpriseId,
      dimension: ctx.body?.dimension ?? 'enterprise',
      rawScore: ctx.body?.rawScore,
      crossJudgeId,
      signatoryUserId: enterpriseId,
      content: ctx.body?.content ?? '',
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/recusals', async (ctx) => {
    const stageId = ctx.params.stageId;
    const committee = isCommittee(ctx);
    // ⛔ 不能代他人申报回避（父代理预审修正 ①）
    //    组委会代录不受 `score:write` 约束 —— 否则「有 stage:compute 的人」反而不能代录
    if (!committee) {
      requireStageCapability(ctx, 'score:write');
    }
    const judgeId = ctx.body?.judgeId ?? ctx.user.id;
    if (judgeId !== ctx.user.id && !committee) {
      throw new AppError(403, 'FORBIDDEN', '不能代他人申报回避（组委会可代录）');
    }
    if (!getStageJudge(ctx.db, stageId, judgeId)) {
      throw new AppError(404, 'JUDGE_NOT_ASSIGNED', '该评委未被分配到本赛段');
    }
    return declareRecusal({
      db: ctx.db,
      stageId,
      judgeId,
      teamId: ctx.body?.teamId ?? null,
      reason: ctx.body?.reason,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
  });

  // ⛔ compute 是显式动作：发布权在「stage:compute」能力（组委会）
  router.add('POST', '/api/stages/:stageId/compute', async (ctx) => {
    requireStageCapability(ctx, 'stage:compute');
    return computeStage({
      db: ctx.db,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  router.add('GET', '/api/stages/:stageId/computations/:computationId', async (ctx) => {
    requireStageCapability(ctx, 'audit:read');
    return getComputation({
      db: ctx.db,
      id: ctx.params.computationId,
      stageId: ctx.params.stageId,
    });
  });
}

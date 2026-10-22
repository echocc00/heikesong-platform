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
  getReviewBoard,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  declareRecusal,
  reinstateRecusal,
  getRecusalLedger,
  submitEnterpriseConfirmation,
} from '../../services/review.js';
import { computeStage, getComputation } from '../../services/compute.js';
import { reviewEvents } from '../sse.js';
import { getStage, getStageJudge, listStageTeams } from '../../db/repo/stages.js';
import { getTeamWithPackage } from '../../db/repo/teams.js';
import { listActiveMembers } from '../../db/repo/teamMembers.js';
import { loadOptionalModule } from '../optional-module.js';
import { fileURLToPath } from 'node:url';

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

/**
 * ⛔ P4 跨阶段接线（P4 Task 6）：把 review-state 返回的**分数数组**过一遍
 *    filterVisibleScores({ db, stageId, viewer, scores })。
 *
 * ⚠️ 两处必须说清楚：
 *  ① **过滤发生在 API 层**，不是前端隐藏 —— 设计文档 §6.6：「前端隐藏 = 数据已泄露」。
 *  ② 过滤模块（Task 5 的 `src/services/review-state.js`）由**并行 Task** 落地，
 *     静态 import 会让整个平台在它落地前**加载不了**（server.js 顶层 import 失败
 *     → createApp 抛错 → 全站 500）→ 改成**动态 import**：
 *       · **没有分数可过滤**（当前 P2 的 getReviewState 不返回分数）→ 原样放行
 *         （没有分数 = 没有可泄露的东西，过滤是恒等的）；
 *       · **有分数但过滤模块缺失** → 503（fail closed：宁可报错，
 *         也绝不把未过滤的分数发出去）。
 *
 * ⚠️ 终审修正（Important，I-2）：**只把「目标模块真不存在」当成缺失**。
 *    模块在场但加载期崩了（语法错 / 传递依赖缺失）→ **抛出去**，
 *    绝不装成「模块未就绪」—— 后者会让排查指向错误方向。判据见 optional-module.js。
 */
const REVIEW_STATE_URL = new URL('../../services/review-state.js', import.meta.url).href;
const REVIEW_STATE_PATH = fileURLToPath(REVIEW_STATE_URL);

export async function applyScoreVisibility({ db, stageId, viewer, state }) {
  const scores = Array.isArray(state?.scores) ? state.scores : [];
  if (!scores.length) return state;
  const mod = await loadOptionalModule(REVIEW_STATE_URL, REVIEW_STATE_PATH);
  const filterVisibleScores = mod?.filterVisibleScores;
  if (typeof filterVisibleScores !== 'function') {
    return {
      status: 503,
      body: {
        error: {
          code: 'SCORE_VISIBILITY_UNAVAILABLE',
          message: '分数可见性过滤模块尚未就绪，拒绝返回未过滤的分数',
        },
      },
    };
  }
  return { ...state, scores: filterVisibleScores({ db, stageId, viewer, scores }) };
}

export function registerReviewRoutes(router) {
  router.add('POST', '/api/stages/:stageId/reviews', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    // ⚠️ 维度白名单**不能丢**（D-32）：评委只能给评委席维度打分，
    //    否则评委能对 seat='self' 的维度打分 → 自评栏被评委占掉。
    const items = ctx.body?.items ?? [];
    assertJudgeDimensions(ctx, items);
    const result = await submitReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items,
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
    // 评审进度推送：订阅同一赛段的评审端据此刷新进度条。
    // ⚠️ 发布点在 **HTTP 层**（不是 service 层）：service 不该知道 HTTP 的存在。
    // ⚠️ **载荷不含 judgeId**（D-37）：事件流里带「谁在什么时候提交了评分」，
    //    等于把评委行踪广播给该赛段的每个订阅者。事件只作为**信号**，
    //    客户端收到后重新拉 `review-state` —— 可见性由那一层按观众过滤。
    reviewEvents.publish(
      'review.progress',
      { stageId: ctx.params.stageId, at: new Date().toISOString() },
      `stage:${ctx.params.stageId}`,
    );
    return result;
  });

  router.add('GET', '/api/stages/:stageId/review-state', async (ctx) => {
    requireUser(ctx);
    // 权限：组委会 / 有评分读取能力的人 / 本赛段评委
    // ⚠️ 终审修正 M-5：原注释写「本赛段队伍成员（队长看本队自评进度）」，
    //    但闸门**并不**放行队长 → 注释与行为不符（行为更严，不是更松）。
    //    按实际行为改正注释；若将来要放开队长，需另加一道「只看本队」的过滤，
    //    不能只把注释改回去。
    if (!isCommittee(ctx)
      && !ctx.can('score:read', { scopeType: 'stage', scopeId: ctx.params.stageId })
      && !ctx.can('score:read', { scopeType: 'global' })
      && !getStageJudge(ctx.db, ctx.params.stageId, ctx.user.id)) {
      throw new AppError(403, 'FORBIDDEN', '没有查看评审进度的权限');
    }
    // ⚠️ 终审修正 I-1：**必须把该赛段权重表的评委席维度全集传下去**。
    //    省略 `dimensions` 时服务层退回「已出现过打分的维度」→ 从未有人评过的维度
    //    不进分母 → 真实完成度 20% 时接口报 100%，`missing` 为空。
    //    （计划 Task 6 的修正 ④ 修的是「队伍轴」，这里漏的是「维度轴」。）
    const stateStage = getStage(ctx.db, ctx.params.stageId);
    const stateConfig = stateStage ? ctx.rules?.scoring?.[stateStage.scoring_config_key] : null;
    const stateDimensions = (stateConfig?.dimensions ?? [])
      .filter((d) => d.seat === 'judge')
      .map((d) => d.key);
    return applyScoreVisibility({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: ctx.user,
      state: await getReviewState({
        db: ctx.db,
        stageId: ctx.params.stageId,
        viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
        dimensions: stateDimensions,
      }),
    });
  });

  // ⛔ P8：评审工作台（只读，一次拿齐「名册 + 维度 + 我的分 + 进度」）
  //    前端要拼评分表单，但名册/维度/我的分原先分散在仓储层、规则文件与 stage_reviews 里，
  //    **一个对外读口都没有** ⇒ 前端要么猜口径、要么拼三个请求。
  router.add('GET', '/api/stages/:stageId/review-board', async (ctx) => {
    requireUser(ctx);
    // ⚠️ 权限闸门与 `GET /api/stages/:stageId/review-state` **完全同口径**：
    //    组委会 / 有 score:read（赛段级或全局）/ 本赛段评委 ⇒ 否则 403。
    //    ⚠️ 不按角色判（全局约束：可见性与授权在 API 层裁决），只认能力点与评委身份。
    if (!isCommittee(ctx)
      && !ctx.can('score:read', { scopeType: 'stage', scopeId: ctx.params.stageId })
      && !ctx.can('score:read', { scopeType: 'global' })
      && !getStageJudge(ctx.db, ctx.params.stageId, ctx.user.id)) {
      throw new AppError(403, 'FORBIDDEN', '没有查看评审工作台的权限');
    }
    return getReviewBoard({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
      rules: ctx.rules,
    });
  });

  router.add('POST', '/api/stages/:stageId/calibration', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    // ⚠️ **校准分也必须过维度白名单**（P10 补齐，与 `POST /reviews` **同口径**）：
    //   原来这里**没有**校验 ⇒ 任何有 `score:write` 的人可以给**任意维度键**写校准分，
    //   包括 `seat='self'` 的「自评测」与 `seat='enterprise'` 的「企业确认」。
    //   ⚠️ 校准分**不进总分**（writeCalibrations 不参与计分）—— 但口径不一致的后果是：
    //     ① 审计说不清「这条校准记录是哪一维度的」；
    //     ② `calibrations` 表被污染（混进非评委席维度的记录）；
    //     ③ 口径分叉会让「评委只能给评委席维度打分」这条规则**在校准入口形同虚设**。
    //   ⇒ 复用**同一个** `assertJudgeDimensions` 函数（不是另写一份）——
    //     两处口径必须**逐字同源**，否则改一处就会分叉。
    const items = ctx.body?.items ?? [];
    assertJudgeDimensions(ctx, items);
    return submitCalibration({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items,
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
    // ⛔ 终审修正 M-4：回避的**撤销**（reinstated）原来只有领域层读侧、没有写路径 ——
    //    评委误报回避后，其分数被永久剔除，产品内**没有任何途径撤销**。
    //    ⛔ 撤销**只能由组委会**做：自己申报又自己撤销 = 绕开回避（想不评就不评）。
    //    所以撤销的权限闸门必须比申报**更严**。
    const recusalAction = ctx.body?.action ?? 'recused';
    if (recusalAction === 'reinstated') {
      if (!committee) {
        throw new AppError(403, 'FORBIDDEN', '撤销回避只能由组委会执行');
      }
      return reinstateRecusal({
        db: ctx.db,
        stageId,
        judgeId,
        teamId: ctx.body?.teamId ?? null,
        reason: ctx.body?.reason,
        actorId: ctx.user.id,
        now: new Date().toISOString(),
      });
    }
    if (recusalAction !== 'recused') {
      throw new AppError(400, 'INVALID_RECUSAL_ACTION', `未知的回避动作：${recusalAction}`);
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

  // ⛔ P10：回避台账的**读口**（以前只有 POST ⇒ 前端只能显示「本次会话刚提交的」）。
  //
  // ⚠️ 权限口径（与 `POST /api/stages/:stageId/recusals` 的 isCommittee **完全一致**）：
  //   · **登录即可**读，但普通用户**只看自己的**（服务层收窄到 judge_id = 本人）；
  //   · **组委会**（`stage:compute`）看**全部**（含别的评委的记录）。
  //   ⛔ 「看全部」只给组委会 —— 回避原因是利益冲突（供应方 / 投资方 / 前雇主），
  //      让所有评委互相看见对方的回避理由，等于把「谁跟哪支队有关系」广播出去。
  //
  // ⚠️ 三态状态码：赛段不存在 → 404（STAGE_NOT_FOUND）；赛段存在但没有记录
  //    → **200 + `{ items: [] }`**（⛔ 不是 404 —— 列表端点没有记录是常态，不是错误）。
  router.add('GET', '/api/stages/:stageId/recusals', async (ctx) => {
    requireUser(ctx);
    return getRecusalLedger({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
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

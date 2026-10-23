// src/http/routes/stages.js — 赛段生命周期端点（P11 新建）
//
// 依据：设计文档 §8「API 设计」+ §9「前端 IA：赛段配置与权重表」
//   + §7.3「三态状态码」+ §12「留痕可复算」
//   + S7 §3.4（R-JDG-11 席构成 / R-JDG-18 利益冲突声明）
// 溯源：src/services/stage.js（服务层，规则已在本文件内实现）+ src/db/repo/stages.js（仓储层）
//
// ⛔ **这个文件为什么存在（P11 真机实测的致命缺口）**：
//   真机生产库实测 `stages = 0, stage_team = 0` ⇒ **全新部署的平台一条赛段都没有** ⇒
//     · 评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数 ⇒ **一个都进不去**；
//     · `GET /api/stages` 返回 `items: []` ⇒ 前端没有任何赛段可选。
//   而设计文档 §8 的 API 清单里**没有**创建赛段的端点（与 E149「发榜端点」同型的设计缺口）。
//   ⇒ 这里补齐「建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册」六个端点，
//     让 §9 的「赛段配置与权重表」界面**真的有 API 可用**。
//
// ⚠️ **本文件只接线，不重写规则**（与 routes/tiebreak.js 同一手法）：
//    路由层只做三件服务层不做的事：**鉴权**、**裁剪可见性**、**透传**。
//    校验（时间窗 / 权重表键 / 席构成 / 重复 key / 幂等）**全部**在服务层 ——
//    否则就会有两套规则，两套规则必然漂移（而后一套没人测）。
//
// ⚠️ **三态状态码**（设计文档 §7.3）：
//   不存在 → 404；没权限 → 403；成功 → 200。
//   ⚠️ 取舍与 routes/publish.js **完全一致**：401（未登录）→ 404（资源不存在）→ 403（没能力）。
//      未登录的人不该知道「这个赛段存不存在」⇒ 401 最先。
//
// ⚠️ **能力点闸门口径**（与 routes/publish.js 的 requirePublishCapability 同款）：
//    `stage:compute`，**届期级或赛段级**都放行。
//    ⛔ 不能只查全局 —— 赛段级授权（scope_type='stage'）会被静默判成无权
//      （routes/review.js 与 routes/tiebreak.js 都踩过这个坑）。
//    ⛔ 绝不按角色硬编码：授权只看能力点 + 授权记录（can() 是唯一判定入口）。
import { appError } from '../../errors.js';
import {
  createStage,
  updateStage,
  assignStageJudgeToStage,
  removeStageJudge,
  registerStageTeamRoster,
  removeStageTeam as removeStageTeamFromRoster,
} from '../../services/stage.js';
import { getStage, listStageJudges, listStageJudgeCandidates, listStageSummaries } from '../../db/repo/stages.js';
import { listStageTeamIds } from '../../db/repo/stage-teams.js';
import { getEdition, listEditions } from '../../db/repo/editions.js';
import { listEditionTeams } from '../../db/repo/pool-sources.js';

/** 未登录 → 401（领域错误一律走 appError，status 在前）。 */
function requireUser(ctx) {
  if (!ctx.user) throw appError(401, 'UNAUTHENTICATED', '未登录');
  return ctx.user;
}

/**
 * 能力点闸门：组委会（`stage:compute`）。
 * @param {object} scope { scopeType, scopeId } —— 传给 ctx.can()
 */
function requireStageCompute(ctx, scope) {
  if (ctx.can('stage:compute', scope)) return;
  throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
}

/**
 * 赛段级动作的能力点闸门：**届期级或赛段级**都放行。
 * ⚠️ 与 routes/publish.js 的 requirePublishCapability 同款口径（前后端必须一致）。
 */
function requireStageComputeForStage(ctx, stage) {
  if (ctx.can('stage:compute', { scopeType: 'edition', scopeId: stage.edition_id })) return;
  if (ctx.can('stage:compute', { scopeType: 'stage', scopeId: stage.id })) return;
  throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
}

/**
 * 届期级资源的能力点闸门：**届期级**，或**该届期下任一赛段的赛段级**授权，都放行。
 *
 * ⚠️ 为什么要有这一条（E158 接线时抓到的口径裂缝）：
 *   赛段的**写**端点走 `requireStageComputeForStage` —— 届期级**或**赛段级都放行。
 *   而届期级的**读**口若只认届期级，就会出现「**能改赛段、却读不到权重表**」的
 *   前后端不一致（页面拿不到席构成约束 ⇒ 组委会判断不了席够不够合法）。
 *   ⇒ 口径对齐写端点：只要在这个届期的**任何**赛段上有 stage:compute，就放行。
 *
 * @param {object} ctx
 * @param {object} db   数据库句柄（⛔ 必须显式传：本文件顶层的辅助函数拿不到
 *                      registerStageRoutes 内部的 dbOf 闭包）
 * @param {string} editionId
 */
function requireStageComputeForEdition(ctx, db, editionId) {
  if (ctx.can('stage:compute', { scopeType: 'edition', scopeId: editionId })) return;
  // ⛔ 赛段级授权：把该届期下的赛段逐个问一遍（赛段数量级很小，可接受）。
  for (const st of listStageSummaries(db, { editionId })) {
    if (ctx.can('stage:compute', { scopeType: 'stage', scopeId: st.id })) return;
  }
  throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
}

/**
 * 赛段行 → 对外形状（原始行 + camelCase 别名）。
 * ⚠️ 两层**同源**（别名就是原字段换名）—— 不会出现「两个名字两个值」。
 *    口径同 routes/tiebreak.js 的 presentRound。
 */
function presentStage(row) {
  if (!row) return null;
  return {
    ...row,
    editionId: row.edition_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    freezeAt: row.freeze_at,
    scoringConfigKey: row.scoring_config_key,
  };
}

/** 评委席行 → 对外形状（原始行 + camelCase 别名）。 */
function presentJudge(row) {
  if (!row) return null;
  return {
    ...row,
    stageId: row.stage_id,
    userId: row.user_id,
    seat: row.seat,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    assignedAt: row.assigned_at,
    conflictDeclaredAt: row.conflict_declared_at,
    conflictDeclarationId: row.conflict_declaration_id,
  };
}

/**
 * 注册赛段生命周期端点。
 * @param {object} router createRouter() 的返回值
 * @param {{ db?: object, rules?: object }} [options] 兜底用的 db / 规则（正常路径走 ctx）
 */
export function registerStageRoutes(router, { db = null, rules = null } = {}) {
  const dbOf = (ctx) => ctx.db ?? db;
  const rulesOf = (ctx) => ctx.rules ?? rules;

  // ── ① 建赛段 ───────────────────────────────────────────────────────
  // ⚠️ 路径是 /api/editions/:editionId/stages —— 赛段**从属于届期**（stages.edition_id 外键）。
  router.add('POST', '/api/editions/:editionId/stages', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    // 404 先于 403：先确认「这个届期存不存在」（与 publish.js 同一取舍）
    if (!getEdition(dbOf(ctx), editionId)) {
      throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    }
    requireStageCompute(ctx, { scopeType: 'edition', scopeId: editionId });
    const stage = createStage({
      db: dbOf(ctx),
      editionId,
      key: ctx.body?.key,
      name: ctx.body?.name,
      kind: ctx.body?.kind,
      startsAt: ctx.body?.startsAt,
      endsAt: ctx.body?.endsAt,
      freezeAt: ctx.body?.freezeAt ?? null,
      scoringConfigKey: ctx.body?.scoringConfigKey,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: rulesOf(ctx),
    });
    return { stage: presentStage(stage) };
  });

  // ── ② 改赛段配置（逆向路径）───────────────────────────────────────
  router.add('PATCH', '/api/stages/:stageId', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const updated = updateStage({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      name: ctx.body?.name,
      startsAt: ctx.body?.startsAt,
      endsAt: ctx.body?.endsAt,
      freezeAt: ctx.body?.freezeAt,
      scoringConfigKey: ctx.body?.scoringConfigKey,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: rulesOf(ctx),
    });
    return { stage: presentStage(updated) };
  });

  // ── ③ 派评委 ───────────────────────────────────────────────────────
  // ⛔ 席位与**利益冲突声明**由服务层一次事务写入（assignStageJudge）——
  //    路由层不自己写 stage_judges（那会漏掉 R-JDG-18 的声明）。
  router.add('POST', '/api/stages/:stageId/judges', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const judges = assignStageJudgeToStage({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      userId: ctx.body?.userId,
      seat: ctx.body?.seat,
      scopeType: ctx.body?.scopeType ?? 'global',
      scopeId: ctx.body?.scopeId ?? null,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      declaration: ctx.body?.declaration ?? null,
    });
    return { judges: judges.map(presentJudge) };
  });

  // ── ④ 撤评委（逆向路径）───────────────────────────────────────────
  router.add('DELETE', '/api/stages/:stageId/judges/:userId', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const result = removeStageJudge({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      userId: ctx.params.userId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return {
      removed: result.removed,
      seat: result.seat,
      judges: result.judges.map(presentJudge),
    };
  });

  // ── ⑤ 登记名册 ─────────────────────────────────────────────────────
  // ⚠️ 幂等：重复登记不报错（服务层先查再过滤）。
  router.add('POST', '/api/stages/:stageId/teams', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const result = registerStageTeamRoster({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      teamIds: ctx.body?.teamIds ?? ctx.body?.teamId ?? [],
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return {
      registered: result.registered,
      skipped: result.skipped,
      teamIds: result.teamIds,
    };
  });

  // ── ⑥ 退名册（逆向路径）───────────────────────────────────────────
  router.add('DELETE', '/api/stages/:stageId/teams/:teamId', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const result = removeStageTeamFromRoster({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      teamId: ctx.params.teamId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return { removed: result.removed, teamIds: result.teamIds };
  });

  // ── 读口：赛段的评委席 / 名册 ─────────────────────────────────────
  // ⚠️ 这两个读口是「写完之后前端要回显」用的：派完评委要能看到席位与声明，
  //    报名册要能看到名单（否则前端只能猜）。权限同写口（组委会）。
  router.add('GET', '/api/stages/:stageId/judges', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    return { judges: listStageJudges(dbOf(ctx), ctx.params.stageId).map(presentJudge) };
  });

  router.add('GET', '/api/stages/:stageId/teams', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    return { teamIds: listStageTeamIds(dbOf(ctx), ctx.params.stageId) };
  });

  // ── 读口（⑦）：届期列表 ────────────────────────────────────────────
  // ⚠️ 为什么公开：届期是**公开赛事信息**（与 `GET /api/stages` 的赛段时间线同口径），
  //    落地页/首页都要用。前端要它是因为「建赛段」必须指明届期，而届期 id 只有服务端知道。
  router.add('GET', '/api/editions', async (ctx) => {
    const rows = listEditions(dbOf(ctx));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city ?? null,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
      })),
    };
  });

  // ── 读口（⑧）：该届期的全部战队（名册登记的**候选池**）─────────────
  // ⚠️ 为什么要这个口：`GET /api/teams` 返回的是「**我参与的**战队」（participant 视角），
  //    组委会看不到全部队伍 ⇒ 名册登记页**没有任何可选队伍**（E158 的直接产物）。
  //    届期隔离口径：`listEditionTeams` 只取该届期且未软删除的队伍（顶层文档 §3.1 S2）。
  router.add('GET', '/api/editions/:editionId/teams', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    if (!getEdition(dbOf(ctx), editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    requireStageComputeForEdition(ctx, dbOf(ctx), editionId);
    const items = listEditionTeams(dbOf(ctx), editionId).map((t) => ({
      id: t.id,
      name: t.name,
      tier: t.tier ?? null,
    }));
    return { items };
  });

  // ── 读口（⑨）：评委候选池 ──────────────────────────────────────────
  // ⚠️ 候选池 = **持有评委类角色的人**，不是「全部用户」
  //    （理由见 repo/stages.js 的 listStageJudgeCandidates 注释）。
  router.add('GET', '/api/editions/:editionId/judge-candidates', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    if (!getEdition(dbOf(ctx), editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    requireStageComputeForEdition(ctx, dbOf(ctx), editionId);
    const items = listStageJudgeCandidates(dbOf(ctx)).map((u) => ({
      id: u.id,
      name: u.name,
      org: u.org ?? null,
    }));
    return { items };
  });

  // ── 读口（⑩）：权重表（设计 §9「赛段配置与**权重表**」）─────────────
  // ⚠️ 投影纪律与 `src/domain/event-info.js` **同款**：逐字段白名单 ——
  //    只给「维度 + 权重 + 席」与「席构成约束」，**不给**配置里的内部工作语言
  //    （note / source / conflictRef / 冲突裁决说明）。
  //    维度权重本身已由 `GET /api/event-info` 公开；这里补的是**组委会视角**的
  //    judgePool 席构成约束（派几个人、什么席比例 ⇒ 决定席够不够合法）。
  //
  // ⚠️ 为什么是**届期作用域**而不是 global：
  //    写端点（建赛段 / 改配置 / 派评委…）走 `requireStageComputeForStage`，
  //    它接受 **edition 级或 stage 级**的 `stage:compute`。
  //    若这个读口用 global 作用域，就会出现「**能改赛段却读不到权重表**」的
  //    前后端不一致 ⇒ 页面拿不到权重表 ⇒ 组委会无法判断席够不够合法。
  //    ⇒ 口径对齐写端点：届期级授权即可读。
  router.add('GET', '/api/editions/:editionId/scoring-configs', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    if (!getEdition(dbOf(ctx), editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    requireStageComputeForEdition(ctx, dbOf(ctx), editionId);
    const scoring = rulesOf(ctx)?.scoring ?? {};
    const items = Object.entries(scoring).map(([key, cfg]) => ({
      key,
      wEnterprise: cfg?.wEnterprise ?? null,
      normalizationStrategy: cfg?.normalizationStrategy ?? null,
      minSamplesForJudgeNormalization: cfg?.minSamplesForJudgeNormalization ?? null,
      dimensions: (Array.isArray(cfg?.dimensions) ? cfg.dimensions : []).map((d) => ({
        key: d?.key ?? null,
        name: d?.name ?? null,
        weight: d?.weight ?? null,
        seat: d?.seat ?? null,
      })),
      judgePool: {
        minJudgesPerDimension: cfg?.judgePool?.minJudgesPerDimension ?? null,
        minEnterpriseSeatShare: cfg?.judgePool?.minEnterpriseSeatShare ?? null,
        maxExpertSeatShare: cfg?.judgePool?.maxExpertSeatShare ?? null,
        votingSeats: Array.isArray(cfg?.judgePool?.votingSeats) ? cfg.judgePool.votingSeats : [],
        nonVotingSeats: Array.isArray(cfg?.judgePool?.nonVotingSeats) ? cfg.judgePool.nonVotingSeats : [],
      },
    }));
    return { items };
  });
}

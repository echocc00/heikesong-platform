// src/http/routes/tiebreak.js — 加时陈述 / 一票破同分（HTTP 接线层）
//
// 依据：S7 §3.3（R-JDG-19 同分加时陈述：决赛同分 → 10 分钟加时陈述 → 企业席+评委席共同复议
//       → 仍同分按企业确认原始分）
//     + 设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束
//     + 设计文档 §7.3（三态状态码：列表类不满足 → 200 + 空集；单条不满足 → 404；能力被禁用 → 403）
// 溯源：src/services/tiebreak.js（服务层，规则已测完整）+ src/db/repo/tiebreak.js（仓储层）
//
// ⚠️ **本文件只接线，不重写规则**：服务层已实现并测完「同分组至少 2 队 / 队伍必须在本赛段名册 /
//    同赛段不允许已有 open 轮次 / 投票人必须是本赛段评委 / 观察员无投票权 / 已回避者禁投 /
//    一人一队一票 / 分值 0–100 / 关闭幂等」这一整套 ——
//    路由层再写一遍就是**两套规则**，两套规则必然漂移（而后一套没人测）。
//    ⇒ 路由层只做三件服务层不做的事：**鉴权**、**裁剪可见性**、**补投票的审计**。
//
// ⛔ **可见性在 API 层过滤**（全局约束「可见性在 API 层过滤，前端隐藏 = 数据已泄露」）：
//    `votes` 里带投票人身份（voter_id）⇒ 普通登录用户**不得**看到别人的投票明细。
//    ⇒ 必须「先取全量状态（getTiebreakRoundState），再在路由层裁剪 votes」；
//      视图/前端**不得**自己过滤（前端过滤 = 数据已经发到浏览器了）。
//    ⚠️ 收窄**不得**因此回 403 —— 企业席/选手有权知道复议结果（否则他们只看到「没结果」），
//      所以收窄后的响应里 `votes` 是空数组、`tallies` 照给。
//
// ⚠️ **投票没有审计**：服务层只给 open / close 留了痕（tiebreak.open / tiebreak.close），
//    投票这一动作**没有**审计记录 ⇒ 路由层补一条 `tiebreak.vote`（设计文档 §12「留痕可复算」）。
//    ⚠️ entityId 用**轮次所属赛段**：复议分是赛段级产物（破同分链挂在赛段上），
//    按赛段查审计日志才查得到。
//
// ⚠️ **形状给两层**（原始行 + camelCase 别名）：
//    · 原始行（snake_case）与仓储层/服务层**逐字一致** ⇒ 复算、对账时不必做字段映射；
//    · camelCase 别名给前端用 ⇒ 前端不必自己写映射表。
//    ⚠️ 两层**同源**（别名就是原字段换名），不会出现「两个名字两个值」。
import { appError } from '../../errors.js';
import {
  openTiebreakRound,
  castTiebreakVote,
  getTiebreakRoundState,
  closeTiebreakRound,
} from '../../services/tiebreak.js';
import { getTiebreakRound, listTiebreakRounds } from '../../db/repo/tiebreak.js';
import { getStageJudge } from '../../db/repo/stages.js';
import { writeAuditLog } from '../../audit/log.js';

/** 加时陈述时长默认值（S7 §3.3：10 分钟）与上限。 */
const DEFAULT_STATEMENT_MINUTES = 10;
// ⛔ 上限必须存在：`statementMinutes` 传 100000 会把陈述截止时间推到几年后 ——
//    一个「永远开着的轮次」会让同赛段再也开不了第二轮（服务层禁止同赛段并存两个 open 轮次）。
const MAX_STATEMENT_MINUTES = 240;

/** 未登录 → 401（领域错误一律走 appError，status 在前）。 */
function requireUser(ctx) {
  if (!ctx.user) throw appError(401, 'UNAUTHENTICATED', '未登录');
  return ctx.user;
}

/**
 * 组委会判定：`stage:compute`，**赛段级或全局**（都走 ctx.can()，唯一判定入口）。
 *
 * ⚠️ 不能只查 global —— 赛段级授权（scope_type='stage'）会被静默判成无权
 *   （与 src/http/routes/review.js 的 isCommittee 同一坑，已在那儿踩过）。
 * ⛔ **绝不按角色硬编码**：角色只是导航分区用的，授权只看能力点 + 授权记录。
 */
function isCommittee(ctx, stageId) {
  if (!ctx.user) return false;
  return ctx.can('stage:compute', { scopeType: 'stage', scopeId: stageId })
    || ctx.can('stage:compute', { scopeType: 'global' });
}

/**
 * 同分组队伍 id 的入参规整（路由层只管**形状**，业务规则归服务层）。
 *
 * ⚠️ 为什么要拦：`tiedTeamIds` 传成字符串时，`new Set('ab')` 会按**字符**拆成
 *   {'a','b'} ⇒ 开出一轮指向幽灵队伍的轮次（真正的 400 要等服务层查名册才报，
 *   错误信息还会变成「队伍不属于本赛段」，把「你传错类型」说成「队伍不在名册」）。
 */
function normalizeTiedTeamIds(raw) {
  if (!Array.isArray(raw)) {
    throw appError(400, 'INVALID_REQUEST', 'tiedTeamIds 必须是数组（同分组队伍 id 列表）');
  }
  const ids = raw.map((x) => String(x ?? '').trim()).filter((x) => x !== '');
  if (!ids.length) {
    throw appError(400, 'INVALID_REQUEST', 'tiedTeamIds 不能为空（同分组至少要两支队伍）');
  }
  // ⚠️ 「只有 1 支同分队伍」不在这里判 —— 服务层的 NO_TIED_TEAMS 才是该口径的唯一出处。
  return ids;
}

/**
 * 陈述时长（分钟）的入参规整。
 * ⚠️ 缺省 10 分钟（S7 §3.3）；非数字 / 越界一律 400 ——
 *   `addMinutes(now, 'abc')` 会算出 Invalid Date，`toISOString()` 直接抛 RangeError ⇒ 500。
 */
function normalizeStatementMinutes(raw) {
  if (raw === undefined || raw === null) return DEFAULT_STATEMENT_MINUTES;
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw appError(400, 'INVALID_REQUEST', 'statementMinutes 必须是数字（分钟）');
  }
  const text = String(raw).trim();
  if (text === '') return DEFAULT_STATEMENT_MINUTES;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_STATEMENT_MINUTES) {
    throw appError(400, 'INVALID_REQUEST', `statementMinutes 必须是 1–${MAX_STATEMENT_MINUTES} 之间的数字`);
  }
  return n;
}

/** 轮次行 → 对外形状（原始行 + camelCase 别名）。 */
function presentRound(row) {
  if (!row) return null;
  let tiedTeamIds = [];
  try {
    const parsed = JSON.parse(row.tied_team_ids_json ?? '[]');
    tiedTeamIds = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    // ⚠️ 解析失败**不抛**：一行脏数据不该让整个轮次列表 500（数据损坏由服务层负责报错）。
    tiedTeamIds = [];
  }
  return {
    ...row,
    stageId: row.stage_id,
    tiedTeamIds,
    statementDeadline: row.statement_deadline,
    voteDeadline: row.vote_deadline,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** 投票行 → 对外形状（原始行 + camelCase 别名）。 */
function presentVote(row) {
  if (!row) return null;
  return {
    ...row,
    roundId: row.tiebreak_round_id,
    voterId: row.voter_id,
    teamId: row.team_id,
    votedAt: row.voted_at,
  };
}

/**
 * 注册加时陈述 / 一票破同分的端点。
 * @param {object} router createRouter() 的返回值
 */
export function registerTiebreakRoutes(router) {
  // ── ① 开一轮加时陈述（组委会）──────────────────────────────────────
  router.add('POST', '/api/stages/:stageId/tiebreak/rounds', async (ctx) => {
    requireUser(ctx);
    const stageId = ctx.params.stageId;
    // ⛔ 能力点闸门（403）：开轮次 = 组委会的动作。
    if (!isCommittee(ctx, stageId)) {
      throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
    }
    const round = openTiebreakRound({
      db: ctx.db,
      stageId,
      tiedTeamIds: normalizeTiedTeamIds(ctx.body?.tiedTeamIds),
      statementMinutes: normalizeStatementMinutes(ctx.body?.statementMinutes),
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return { round: presentRound(round) };
  });

  // ── ② 列本赛段的全部轮次（登录即可）──────────────────────────────
  router.add('GET', '/api/stages/:stageId/tiebreak/rounds', async (ctx) => {
    requireUser(ctx);
    const rows = listTiebreakRounds(ctx.db, { stageId: ctx.params.stageId });
    // ⚠️ 列表语义：**没有轮次返回 200 + 空数组**（不是 404）—— 设计文档 §7.3。
    //    「赛段没有轮次」是**正常状态**，不是「这个赛段不存在」。
    return { items: rows.map(presentRound) };
  });

  // ── ③ 读一轮的状态（round + votes + tallies）─────────────────────
  router.add('GET', '/api/tiebreak/rounds/:roundId', async (ctx) => {
    const user = requireUser(ctx);
    // ⚠️ 先取**全量**状态（服务层），再在路由层裁剪 votes ——
    //    可见性必须在 API 层收窄（前端隐藏 = 数据已泄露）。
    const state = getTiebreakRoundState({ db: ctx.db, roundId: ctx.params.roundId });
    const stageId = state.round.stage_id;
    // ⚠️ 谁能看**全部投票明细**：
    //   ① 组委会（stage:compute，赛段级或全局）—— 要核查复议过程；
    //   ② **本赛段评委**（getStageJudge 命中）—— 同赛段互相看得到复议分是「复议」的前提；
    //   ③ 其他人（企业席 / 选手）⇒ 只给 tallies（他们有权知道复议结果），
    //      **不得**因为收窄而回 403。
    const canSeeVotes = isCommittee(ctx, stageId)
      || getStageJudge(ctx.db, stageId, user.id) != null;
    return {
      round: presentRound(state.round),
      votes: canSeeVotes ? state.votes.map(presentVote) : [],
      tallies: state.tallies,
    };
  });

  // ── ④ 投票（登录即可；谁能投由服务层判：评委席 / 观察员 / 回避）────
  router.add('POST', '/api/tiebreak/rounds/:roundId/votes', async (ctx) => {
    const user = requireUser(ctx);
    const roundId = ctx.params.roundId;
    const teamId = String(ctx.body?.teamId ?? '').trim();
    if (!teamId) {
      throw appError(400, 'INVALID_REQUEST', '必须指定被投票的队伍（teamId）');
    }
    // ⚠️ score 原样透传：分值口径（0–100 / 必须是数字）是**服务层**的 SCORE_OUT_OF_RANGE，
    //    路由层不另立一套（前端传字符串分数会被服务层判 400，这是刻意的）。
    const vote = castTiebreakVote({
      db: ctx.db,
      roundId,
      voterId: user.id,
      teamId,
      score: ctx.body?.score,
      now: new Date().toISOString(),
    });
    // ⚠️ 审计的 entityId 用**轮次所属赛段**（复议分是赛段级产物）。
    const round = getTiebreakRound(ctx.db, roundId);
    if (!round) {
      throw appError(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
    }
    writeAuditLog(ctx.db, {
      actorId: user.id,
      action: 'tiebreak.vote',
      entity: 'stage',
      entityId: round.stage_id,
      detail: { roundId, teamId, score: ctx.body?.score },
      now: new Date().toISOString(),
    });
    return { vote: presentVote(vote) };
  });

  // ── ⑤ 关闭轮次（组委会）──────────────────────────────────────────
  router.add('POST', '/api/tiebreak/rounds/:roundId/close', async (ctx) => {
    requireUser(ctx);
    const roundId = ctx.params.roundId;
    // ⚠️ 关闭端点的路径里**没有 stageId** ⇒ 权限必须按**轮次所属赛段**判：
    //    先读轮次拿到 stage_id，再问 can()。
    const round = getTiebreakRound(ctx.db, roundId);
    if (!round) {
      throw appError(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
    }
    if (!isCommittee(ctx, round.stage_id)) {
      throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
    }
    // ⚠️ 关闭是**幂等**的（服务层：已关闭则原样返回）⇒ 重复点「关闭」不会报错。
    const closed = closeTiebreakRound({
      db: ctx.db,
      roundId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return { round: presentRound(closed.round), tallies: closed.tallies };
  });
}

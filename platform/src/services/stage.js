// src/services/stage.js — 赛段生命周期（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
//
// 依据：设计文档 §8「API 设计」+ §9「前端 IA：赛段配置与权重表」+ §12「留痕可复算」
//   + db/migrations/003_review.sql（stages / stage_judges / conflict_declarations 的表注释）
//   + db/migrations/004_leaderboard.sql（stage_team 表）
//   + S7 §3.4（R-JDG-11 席构成 / R-JDG-18 利益冲突声明）
//
// ⛔ **这个文件为什么存在（P11 真机实测的致命缺口）**：
//   真机生产库 `/var/lib/heikesong/data/app.db` 实测 `stages = 0, stage_team = 0`
//   ⇒ **全新部署的平台一条赛段都没有** ⇒
//     · 评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数
//       ⇒ **一个都进不去**；
//     · `GET /api/stages` 返回 `items: []` ⇒ 前端没有任何赛段可选。
//   根因：`src/db/repo/stages.js` 的 insertStage / assignStageJudge 与
//   `src/db/repo/stage-teams.js` 的 registerStageTeams **在生产上零调用方**（只有测试在调）。
//   设计文档 §8 的 API 清单里**没有**创建赛段的端点，但 §9 的前端 IA 里写着「赛段配置与权重表」
//   ⇒ 与 E149（publish）同型的**设计缺口**：界面要求存在，但没有任何 API 能满足它。
//   ⇒ 本文件把那层「写了但接不上」的服务能力补齐；由 src/http/routes/stages.js 暴露成端点。
//
// ⛔ **规则只从 rules/*.json 来**（全局约束）：
//    权重表**不硬编码**在本文件里 —— `scoringConfigKey` 必须能在 `rules.scoring[<key>]` 里找到，
//    找不到 ⇒ 400 SCORING_CONFIG_NOT_FOUND（而不是「悄悄用一张默认权重表」）。
//
// ⛔ **每个写动作都留审计**（设计文档 §12）：
//    action 命名一律 `stage.*`：stage.create / stage.update / stage.judge.assign /
//    stage.judge.remove / stage.roster.register / stage.roster.remove。
//
// ⛔ **每个写动作都有逆向路径**（本任务的硬约束）：
//    建段 ↔ 改配置；派评委 ↔ 撤评委；报名册 ↔ 退名册。
//
// ⛔ **本文件不含 SQL**（全局约束「所有 SQL 收在 src/db/repo/」）：
//    一切读写都走仓储层函数；test/sql-boundary.test.js 会扫。
import {
  getStage,
  listStages,
  insertStage,
  updateStageConfig,
  assignStageJudge,
  removeStageJudgeRow,
  getStageJudge,
  listStageJudges,
} from '../db/repo/stages.js';
import {
  listStageTeamIds,
  isTeamInStage,
  registerStageTeams,
  removeStageTeam as removeStageTeamRow,
} from '../db/repo/stage-teams.js';
import { getEdition } from '../db/repo/editions.js';
import { getUserById } from '../db/repo/users.js';
import { getTeam } from '../db/repo/teams.js';
import { listReviews } from '../db/repo/reviews.js';
import { writeAuditLog } from '../audit/log.js';
import { appError } from '../errors.js';

/** 赛段类型（003_review.sql: `kind` 列注释）。 */
const STAGE_KINDS = ['initial', 'final', 'roadshow', 'landing'];
/** 评委席类型（003_review.sql: `stage_judges.seat` 列注释）。 */
const JUDGE_SEATS = ['judge', 'enterprise', 'observer'];
/** 授权作用域类型（003_review.sql: `stage_judges.scope_type` 列注释）。 */
const JUDGE_SCOPE_TYPES = ['global', 'edition', 'task_package', 'team'];
/** 可用的权重表键（rules/scoring-initial.json / rules/scoring-final.json）。 */
const SCORING_CONFIG_KEYS = ['initial', 'final'];
/** 赛段代号：只允许字母 / 数字 / 连字符 / 下划线（赛段 key 会出现在 URL 与日志里）。 */
const STAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function fail(status, code, message, detail) {
  // ⚠️ 必须用 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    server.js 的错误分支是 `err instanceof AppError ? err.message : '请求无效'`
  //    —— 裸 Error 不是 AppError ⇒ message 被替换成通用文案「请求无效」，
  //    调用方就看不到「为什么错」了。
  return appError(status, code, message, detail);
}

/** 非空字符串（去首尾空白）。 */
function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw fail(400, 'INVALID_STAGE_FIELD', `${label}不能为空`);
  return text;
}

/** 时间必须可解析（`Date.parse`）。 */
function parseTime(value, label) {
  const t = Date.parse(String(value ?? ''));
  if (!Number.isFinite(t)) {
    throw fail(400, 'INVALID_STAGE_WINDOW', `${label} 不是合法时间（应为 ISO 时间或 YYYY-MM-DD）`);
  }
  return t;
}

/**
 * 时间窗：**开始必须早于结束**。
 * ⚠️ 为什么必须查：赛段时间窗反了 ⇒ 「冻结时间」「赛段结束」都比开始早
 *    ⇒ 评审页一打开就是「已结束」，评委提交评分被时间闸挡住，而**错因不可见**。
 */
function assertWindow(startsAt, endsAt) {
  const s = parseTime(startsAt, 'startsAt');
  const e = parseTime(endsAt, 'endsAt');
  if (!(s < e)) {
    throw fail(400, 'INVALID_STAGE_WINDOW', '开始时间必须早于结束时间', { startsAt, endsAt });
  }
  return { startsAt, endsAt };
}

/** 赛段类型必须在枚举内。 */
function assertKind(kind) {
  const k = requireText(kind, 'kind（赛段类型）');
  if (!STAGE_KINDS.includes(k)) {
    throw fail(400, 'INVALID_STAGE_KIND', `赛段类型必须是 ${STAGE_KINDS.join(' | ')} 之一`, { kind: k });
  }
  return k;
}

/**
 * 权重表键必须合法**且**在规则文件里真的存在。
 * ⚠️ 为什么不硬编码权重表（全局约束）：权重表在 rules/scoring-*.json，
 *    这里只做「键存在吗」的判定 —— 找不到就 400，绝不「悄悄用一张默认表」。
 */
function assertScoringConfigKey(key, rules) {
  const k = requireText(key, 'scoringConfigKey（权重表键）');
  if (!SCORING_CONFIG_KEYS.includes(k)) {
    throw fail(400, 'SCORING_CONFIG_NOT_FOUND', `权重表键必须是 ${SCORING_CONFIG_KEYS.join(' | ')} 之一`, { scoringConfigKey: k });
  }
  if (!rules?.scoring?.[k]) {
    throw fail(400, 'SCORING_CONFIG_NOT_FOUND', `规则里没有权重表 ${k}（rules/scoring-*.json）`, { scoringConfigKey: k });
  }
  return k;
}

/** 赛段必须存在（404）。 */
function requireStage(db, stageId) {
  const stage = getStage(db, stageId);
  if (!stage) throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  return stage;
}

/**
 * 建赛段。
 *
 * ⚠️ 校验链（顺序即语义，先便宜后昂贵）：
 *   ① 届期存在？否则 404 EDITION_NOT_FOUND（赛段挂在届期下，届期都没有就没法挂）
 *   ② key / name / kind / scoringConfigKey 合法？
 *   ③ 时间窗合法？（开始 < 结束）
 *   ④ 同一届期下 key 不重复？⇒ 409 STAGE_KEY_EXISTS（DB 上还有 UNIQUE(edition_id,key) 兜底）
 *
 * @returns {object} 赛段行（仓储形状）
 */
export function createStage({
  db, editionId, key, name, kind, startsAt, endsAt, freezeAt = null,
  scoringConfigKey, actorId = null, now, rules = null,
}) {
  if (!getEdition(db, editionId)) {
    throw fail(404, 'EDITION_NOT_FOUND', '届期不存在');
  }
  const stageKey = requireText(key, 'key（赛段代号）');
  if (!STAGE_KEY_PATTERN.test(stageKey)) {
    throw fail(400, 'INVALID_STAGE_KEY', '赛段代号只能包含字母、数字、连字符与下划线（1–64 字符）', { key: stageKey });
  }
  const stageName = requireText(name, 'name（赛段名称）');
  const stageKind = assertKind(kind);
  const scoringKey = assertScoringConfigKey(scoringConfigKey, rules);
  assertWindow(startsAt, endsAt);
  if (freezeAt !== null && freezeAt !== undefined) parseTime(freezeAt, 'freezeAt');

  // 同一届期下 key 不得重复（DB 上还有 UNIQUE(edition_id, key) 兜底，这里先给出友好错误）
  const duplicated = listStages(db, { editionId }).some((s) => s.key === stageKey);
  if (duplicated) {
    throw fail(409, 'STAGE_KEY_EXISTS', `本届期已存在代号为 ${stageKey} 的赛段`, { editionId, key: stageKey });
  }

  let stage;
  try {
    stage = insertStage(db, {
      editionId,
      key: stageKey,
      name: stageName,
      kind: stageKind,
      startsAt,
      endsAt,
      freezeAt: freezeAt ?? null,
      scoringConfigKey: scoringKey,
      status: 'draft', // ⚠️ 新建一律 draft：赛段不是建好就开闸的（开闸是另一个动作）
      now,
    });
  } catch (err) {
    // 并发下两个请求同时建同名赛段 ⇒ 撞 UNIQUE ⇒ 同样给 409（而不是 500）
    // ⚠️ 文案与上面「先查后建」那一档**刻意不同**：
    //    先查 ⇒ 「本届期已有这个代号」（历史存在）；撞约束 ⇒ 「可能是并发创建」（刚刚发生的竞争）。
    //    两档都是 409 STAGE_KEY_EXISTS，但用户要知道下一步动作不同（改代号 vs 刷新重试）。
    if (/UNIQUE constraint failed: stages/i.test(String(err?.message))) {
      throw fail(409, 'STAGE_KEY_EXISTS', `赛段代号 ${stageKey} 已被占用（可能是并发创建），请刷新后重试`, {
        editionId, key: stageKey, reason: 'concurrent_create',
      });
    }
    throw err;
  }

  writeAuditLog(db, {
    actorId,
    action: 'stage.create',
    entity: 'stage',
    entityId: stage.id,
    detail: {
      editionId,
      key: stageKey,
      name: stageName,
      kind: stageKind,
      startsAt,
      endsAt,
      freezeAt: freezeAt ?? null,
      scoringConfigKey: scoringKey,
      status: 'draft',
    },
    now,
  });
  return stage;
}

/**
 * 改赛段配置（**逆向路径**：改配置）。
 *
 * ⚠️ **换权重表要谨慎**：赛段一旦有了评分数据，换 `scoring_config_key`
 *    ⇒ 历史评分是按**旧权重表**打的，新权重表算出来的总分与旧分数**不可复算**
 *    （设计文档 §12「可复算」被破坏）⇒ 有评分时拒绝换表，提示先清数据。
 *
 * ⚠️ 其余字段（name / 时间窗 / freeze_at）随时可改 —— 它们不影响「旧分数怎么算出来」。
 */
export function updateStage({
  db, stageId, name, startsAt, endsAt, freezeAt, scoringConfigKey,
  actorId = null, now, rules = null,
}) {
  const stage = requireStage(db, stageId);
  const next = {
    name: name === undefined ? stage.name : requireText(name, 'name（赛段名称）'),
    startsAt: startsAt === undefined ? stage.starts_at : startsAt,
    endsAt: endsAt === undefined ? stage.ends_at : endsAt,
    freezeAt: freezeAt === undefined ? stage.freeze_at : freezeAt,
    scoringConfigKey: scoringConfigKey === undefined
      ? stage.scoring_config_key
      : assertScoringConfigKey(scoringConfigKey, rules),
  };
  assertWindow(next.startsAt, next.endsAt);
  if (next.freezeAt !== null && next.freezeAt !== undefined) parseTime(next.freezeAt, 'freezeAt');

  const tableChanged = next.scoringConfigKey !== stage.scoring_config_key;
  if (tableChanged) {
    // ⛔ 已有评分 ⇒ 不许换权重表（否则历史评分不可复算）
    const existingReviews = listReviews(db, { stageId });
    if (existingReviews.length) {
      throw fail(
        409,
        'STAGE_HAS_REVIEWS',
        '该赛段已有评分数据，不能更换权重表（历史评分将不可复算）；请先清空该赛段的评分数据',
        { stageId, reviews: existingReviews.length, from: stage.scoring_config_key, to: next.scoringConfigKey },
      );
    }
  }

  const updated = updateStageConfig(db, {
    id: stageId,
    name: next.name,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
    freezeAt: next.freezeAt ?? null,
    scoringConfigKey: next.scoringConfigKey,
  });

  writeAuditLog(db, {
    actorId,
    action: 'stage.update',
    entity: 'stage',
    entityId: stageId,
    detail: {
      before: {
        name: stage.name,
        startsAt: stage.starts_at,
        endsAt: stage.ends_at,
        freezeAt: stage.freeze_at,
        scoringConfigKey: stage.scoring_config_key,
      },
      after: {
        name: next.name,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        freezeAt: next.freezeAt ?? null,
        scoringConfigKey: next.scoringConfigKey,
      },
    },
    now,
  });
  return updated;
}

/**
 * 派评委到赛段（席位 + 利益冲突声明同事务写入）。
 *
 * ⛔ **必须走仓储层的 assignStageJudge**：它内部把「声明（conflict_declarations）」
 *    与「席位（stage_judges）」写在**同一个事务**里，并把声明 id 回填到席位行
 *    （R-JDG-18：评委须签署利益冲突声明）。
 *    ⛔ 本服务**不自己**写 stage_judges 的 INSERT —— 那样会漏掉声明，
 *      正是 003_review.sql 注释里记的那个「机制写下来了但没接线」的病。
 *
 * @param {object|null} declaration { hasConflict?: boolean, statement?: string }
 */
export function assignStageJudgeToStage({
  db, stageId, userId, seat, scopeType = 'global', scopeId = null,
  actorId = null, now, declaration = null,
}) {
  requireStage(db, stageId);
  const targetUserId = requireText(userId, 'userId（被派评委）');
  if (!getUserById(db, targetUserId)) {
    throw fail(404, 'USER_NOT_FOUND', '用户不存在', { userId: targetUserId });
  }
  const seatType = requireText(seat, 'seat（席位类型）');
  if (!JUDGE_SEATS.includes(seatType)) {
    throw fail(400, 'INVALID_JUDGE_SEAT', `席位必须是 ${JUDGE_SEATS.join(' | ')} 之一`, { seat: seatType });
  }
  // 作用域类型必须落在枚举内（003_review.sql 的列注释）—— 否则往库里写的是垃圾值，
  // 而「这个席位的授权范围是什么」事后没人查得出。
  const scope = requireText(scopeType ?? 'global', 'scopeType（授权作用域）');
  if (!JUDGE_SCOPE_TYPES.includes(scope)) {
    throw fail(400, 'INVALID_SCOPE_TYPE', `授权作用域必须是 ${JUDGE_SCOPE_TYPES.join(' | ')} 之一`, { scopeType: scope });
  }
  // 重复分配 ⇒ 409（先查再派：PRIMARY KEY(stage_id, user_id) 撞了只能得到原始 SQL 错误）
  if (getStageJudge(db, stageId, targetUserId)) {
    throw fail(409, 'JUDGE_ALREADY_ASSIGNED', '该用户已被分配到本赛段', { stageId, userId: targetUserId });
  }

  assignStageJudge(db, {
    stageId,
    userId: targetUserId,
    seat: seatType,
    scopeType: scope,
    scopeId,
    now,
    declaration,
  });

  writeAuditLog(db, {
    actorId,
    action: 'stage.judge.assign',
    entity: 'stage',
    entityId: stageId,
    detail: { userId: targetUserId, seat: seatType, scopeType: scope, scopeId },
    now,
  });
  return listStageJudges(db, stageId);
}

/**
 * 撤评委（**逆向路径**：撤评委）。
 * ⚠️ 幂等友好：先查再删 —— 没分配过 ⇒ 404 JUDGE_NOT_ASSIGNED（不静默）。
 * ⚠️ 只删席位，**不删**已签署的利益冲突声明（那是历史事实，见 removeStageJudgeRow 的注释）。
 */
export function removeStageJudge({ db, stageId, userId, actorId = null, now }) {
  requireStage(db, stageId);
  const targetUserId = requireText(userId, 'userId（被撤评委）');
  const seat = getStageJudge(db, stageId, targetUserId);
  if (!seat) {
    throw fail(404, 'JUDGE_NOT_ASSIGNED', '该用户未被分配到本赛段', { stageId, userId: targetUserId });
  }
  const removed = removeStageJudgeRow(db, { stageId, userId: targetUserId });
  writeAuditLog(db, {
    actorId,
    action: 'stage.judge.remove',
    entity: 'stage',
    entityId: stageId,
    detail: { userId: targetUserId, seat: seat.seat, removed },
    now,
  });
  return { removed, seat: seat.seat, judges: listStageJudges(db, stageId) };
}

/**
 * 登记赛段名册（哪些队伍参加这一段）。
 *
 * ⛔ **幂等**：重复登记**不报错**，静默跳过已登记的队伍。
 *    （仓储层的 registerStageTeams 撞 UNIQUE(stage_id, team_id) 会抛错 ⇒ 服务层必须先查再过滤。）
 *    为什么必须幂等：赛段开启时批量登记名册是**流程性动作**，重跑一遍不该把流程打断。
 *
 * @param {string[]} teamIds
 */
export function registerStageTeamRoster({ db, stageId, teamIds, actorId = null, now }) {
  const stage = requireStage(db, stageId);
  const raw = Array.isArray(teamIds) ? teamIds : (teamIds ? [teamIds] : []);
  const ids = raw.map((x) => requireText(x, 'teamId（队伍）')).filter((x, i, arr) => arr.indexOf(x) === i);
  if (!ids.length) {
    throw fail(400, 'INVALID_TEAM_IDS', '必须指定队伍（teamIds 数组）');
  }
  // 队伍必须存在，且必须属于**本赛段所在的届期** ⇒ 否则就是把外届期的队拉进来
  for (const id of ids) {
    const team = getTeam(db, id);
    if (!team) throw fail(404, 'TEAM_NOT_FOUND', '队伍不存在', { teamId: id });
    if (team.edition_id !== stage.edition_id) {
      throw fail(400, 'TEAM_NOT_IN_EDITION', '队伍不属于本届期，不能登记到本赛段', {
        teamId: id, editionId: stage.edition_id,
      });
    }
  }
  const current = new Set(listStageTeamIds(db, stageId));
  const fresh = ids.filter((id) => !current.has(id));
  const registered = fresh.length ? registerStageTeams(db, { stageId, teamIds: fresh, now }) : 0;
  writeAuditLog(db, {
    actorId,
    action: 'stage.roster.register',
    entity: 'stage',
    entityId: stageId,
    detail: { registered, skipped: ids.length - fresh.length, teamIds: ids },
    now,
  });
  return {
    registered,
    skipped: ids.length - fresh.length,
    teamIds: listStageTeamIds(db, stageId),
  };
}

/**
 * 队伍退名册（**逆向路径**：退名册）。
 * ⚠️ 不在名册里 ⇒ 404 TEAM_NOT_IN_ROSTER（不静默 —— 「退名册」这个动作必须有明确结果）。
 */
export function removeStageTeam({ db, stageId, teamId, actorId = null, now }) {
  requireStage(db, stageId);
  const targetTeamId = requireText(teamId, 'teamId（队伍）');
  if (!isTeamInStage(db, stageId, targetTeamId)) {
    throw fail(404, 'TEAM_NOT_IN_ROSTER', '该队伍不在本赛段名册内', { stageId, teamId: targetTeamId });
  }
  const removed = removeStageTeamRow(db, { stageId, teamId: targetTeamId });
  writeAuditLog(db, {
    actorId,
    action: 'stage.roster.remove',
    entity: 'stage',
    entityId: stageId,
    detail: { teamId: targetTeamId, removed },
    now,
  });
  return { removed, teamIds: listStageTeamIds(db, stageId) };
}

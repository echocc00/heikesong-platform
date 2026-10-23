// src/services/anticheat.js — 检测编排与复核队列
// 依据：设计文档 §11.1（检测 → 进人工复核队列）、§9（组委会视角的复核/申诉/改级）
//   R-RNK-08 异常互评检测、R-JDG-16 TOP10 反向抽查
// ⛔ 检测 ≠ 处罚：runDetection 只建 flag（status='open'），不改分、不封号、不自动裁决。
//   裁决是人的动作（resolveFlag），且必须留审计日志。
import {
  detectIdenticalPeerPattern, detectBurstSubmission, detectLowVariance,
  detectMultiAccount, detectTiedMutualPeerRate,
} from '../domain/anticheat.js';
import { normalizeEvidence } from '../domain/evidence.js';
import { assertKnownFields, assertMutuallyExclusive } from '../domain/field-dictionary.js';
import { createFlag, listFlagRows, resolveFlagRow } from '../db/repo/flags.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { badRequest, notFound } from '../errors.js';
import { canonicalJson } from '../domain/canonical-json.js';

// ⚠️ 稳定序列化（键名排序）已抽到 `src/domain/canonical-json.js`
//    （2026-10-23 审计 F25：幂等摘要要用**同一口径** ⇒ 复制一份就是「同一口径写两份 ⇒ 必然漂移」）。
//    语义与原实现**逐字一致**，行为未变。

/**
 * 「同一个问题」的判定：同 kind + 同赛段 + **同明细内容**。
 *
 * ⛔ 预审修正（P4-T4-D4）：原来用 (kind, stage_id, team_id, judge_id) 这个粗键去重。
 *    那个键分不开「同 kind 的不同问题」——两个不同的多账号分组（138…001 / 138…002）
 *    在粗键下 team_id / judge_id 都是 NULL → 第二个被当成「重复」丢掉；
 *    同一位评委的**两个维度**方差异常同理（judge_id 相同、dimension 不同）。
 *    丢掉的不是重复项，是**真问题** —— 防作弊检测漏报。改成按明细内容判定。
 *
 * ⚠️ **稳定标识优先**（F10）：`burst_submit` 的明细里嵌了 `windowStart` / `windowEnd`
 *    两个**时间戳** ⇒ 同一问题在不同时间算出来**不是同一个问题**
 *    ⇒ **每次重算都新增一条 flagged_reviews 行** ⇒ 复核队列被同一个问题刷屏。
 *    ⇒ 检测器给出不含时间戳的 `findingKey`（kind|主体|窗口序号）⇒ 按它去重。
 *    没有 `findingKey` 的旧行退回「明细内容」比较（不丢历史）。
 */
const VOLATILE_DETAIL_KEYS = ['windowStart', 'windowEnd', 'findingKey'];

/** 去掉「每次重算都会变」的字段（时间戳 / 稳定标识本身）后的明细内容 */
function stripVolatile(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return detail;
  const out = {};
  for (const k of Object.keys(detail).sort()) {
    if (VOLATILE_DETAIL_KEYS.includes(k)) continue;
    out[k] = detail[k];
  }
  return out;
}

function isSameFinding(row, flag, stageId) {
  if ((row.stage_id ?? null) !== (stageId ?? null)) return false;
  let detail = null;
  try {
    detail = row.detail_json ? JSON.parse(row.detail_json) : null;
  } catch {
    return false;   // 明细坏掉 → 不当成同一个问题（宁可多建一条让人看，也不漏）
  }
  const a = stripVolatile(detail);
  const b = stripVolatile(flag);
  // 两边都有稳定标识 ⇒ 按标识比（能分开「同一主体的两次不同爆发」）
  if (detail?.findingKey && flag?.findingKey) {
    return detail.findingKey === flag.findingKey;
  }
  // 一边没有稳定标识（历史行）⇒ 退回「去掉易变字段后的明细内容」比较
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * 逐页扫 flagged_reviews。
 * ⚠️ 仓储层的 listFlagRows 默认只回 100 条 —— 一次查全表再 find 会漏，
 *    漏掉的 flag 会被误判成「不存在」（404），或让去重失效（重复建 flag）。所以要翻页。
 */
function scanFlags(db, filter, match) {
  const LIMIT = 200;
  for (let offset = 0; ; offset += LIMIT) {
    const { rows } = listFlagRows(db, { ...filter, limit: LIMIT, offset });
    for (const row of rows) {
      const hit = match(row);
      if (hit) return hit;
    }
    if (rows.length < LIMIT) return null;
  }
}

/**
 * 字段字典闸（R-AUD-06）：返回这条 flag 明细的**全部**违规（空数组 = 合规）。
 * ⛔ 单独抽成导出函数：这条闸是「不在字典里的字段名不进库」的唯一执行点，
 *    抽出来才能被单独测到（不然只能靠「检测器恰好产出越界字段」这种偶然路径）。
 */
export function assertFlagDetail(flag) {
  return [...assertKnownFields(flag.kind, flag), ...assertMutuallyExclusive(flag)];
}

/**
 * `peer_reviews` 的仓储行（snake_case）→ 检测器的入参形状（**队 → 队**）。
 *
 * ⚠️ **互评数据在本仓的真实存储位置**（2026-10-23 审计 F47 的取证结论，不要凭印象）：
 *   · 互评**只**存在 `peer_reviews` 表（db/migrations/003_review.sql:132）：
 *     stage_id / from_team_id / to_team_id / score / request_id / created_at；
 *   · `stage_reviews`（评委打分表）**没有 seat 列** ⇒「stage_reviews 里 seat='peer' 那一路」
 *     在本仓**不存在**；本仓的「互评」是**队 → 队**的行为（from_team_id → to_team_id）。
 *   ⇒ 检测器的「谁投了谁」只能来自 `peer_reviews`。
 *
 * ⚠️ **为什么放在服务层而不是仓储层**：仓储层统一返回**原始行**（snake_case），
 *   而检测器的入参是领域形状 ⇒ 这一层翻译**只在这里发生一次**
 *   （计算期与发榜期两条链路共用同一份）⇒ 不可能漂移
 *   （同一口径写两份 ⇒ 必然漂移 —— 本仓的老教训）。
 *
 * ⚠️ 字段名用 fromId / toId（**队**），不是 judgeId：`pickVoter` / `pickTarget`
 *   在 src/domain/anticheat.js 里读的是 `judgeId ?? fromId` 与 `teamId ?? toId`
 *   ⇒ 两种写法都能命中，这里取语义正确的那个。
 *
 * @param {object[]} rows `peer_reviews` 的仓储行
 * @returns {{fromId: string, toId: string, score: number}[]}
 */
export function toDetectionPeerReviews(rows = []) {
  return rows.map((r) => ({ fromId: r.from_team_id, toId: r.to_team_id, score: r.score }));
}

/**
 * 跑一遍全部检测器，把命中的问题写进 flagged_reviews（status='open'）。
 * @param {object[]} extraCandidates 扩展点：额外候选 flag（默认空）。
 *   给「还没进检测器模块的新检测器」用；同时给「字段字典闸」一条可测的入口 ——
 *   候选里带越界字段 → 必须被 400 挡住，不进库（R-AUD-06）。
 * @returns {{ created: Array, skipped: Array }}
 */
export function runDetection({
  db, stageId = null, peerReviews = [], events = [], scoreStats = [], results = [],
  users = [], rules, now = new Date().toISOString(), extraCandidates = [],
}) {
  const antiCheat = rules?.audit?.antiCheat ?? {};
  const created = [];
  const skipped = [];

  const candidates = [
    ...detectIdenticalPeerPattern({ peerReviews, minOverlap: antiCheat.identicalPeer?.minOverlap ?? 3 }).flags,
    ...detectBurstSubmission({
      events,
      windowSeconds: antiCheat.burst?.windowSeconds ?? 60,
      threshold: antiCheat.burst?.threshold ?? 5,
    }).flags,
    ...detectLowVariance({ scoreStats, threshold: antiCheat.lowVariance ?? { min: 0, max: Infinity } }).flags,
    ...detectMultiAccount({ users, keyFields: antiCheat.multiAccount?.keyFields ?? [] }).flags,
    ...detectTiedMutualPeerRate({
      peerReviews, results, threshold: antiCheat.tiedMutualPeerRate?.threshold ?? 0.8,
    }).flags,
    ...extraCandidates,
  ];

  for (const flag of candidates) {
    // 字段字典校验：不在字典里的字段名不进库（R-AUD-06）
    const fieldErrors = assertFlagDetail(flag);
    if (fieldErrors.length) {
      throw badRequest(`flag 明细字段不合规（${flag.kind}）：${fieldErrors.join('；')}`);
    }
    const judgeId = flag.judgeId ?? flag.voterA ?? flag.subjectId ?? null;
    const teamId = flag.teamId ?? (flag.tiedPairs?.[0]?.[0] ?? null);
    const existing = scanFlags(
      db,
      { status: 'open', kind: flag.kind },
      (row) => (isSameFinding(row, flag, stageId) ? row : null),
    );
    if (existing) {
      skipped.push({ kind: flag.kind, reason: '已存在未决 flag，不重复建', flagId: existing.id });
      continue;
    }
    const id = createFlag(db, {
      stageId, teamId, judgeId, kind: flag.kind, detail: flag, status: 'open', now,
    });
    writeAuditLog(db, {
      action: 'flag.detected',
      entity: 'flag',
      entityId: id,
      detail: { kind: flag.kind, stageId, teamId, judgeId, action: flag.action ?? 'alert_only' },
      now,
    });
    created.push({ id, kind: flag.kind, detail: flag });
  }

  return { created, skipped };
}

/**
 * 裁决一条 flag。必须给理由与证据（可空数组），并写审计日志。
 */
export function resolveFlag({
  db, flagId, status, reviewerId = null, reason, evidence = [], now = new Date().toISOString(),
}) {
  if (!['confirmed', 'rejected'].includes(status)) {
    throw badRequest(`裁决状态只能是 confirmed 或 rejected，收到：${status}`);
  }
  if (!reason || !String(reason).trim()) {
    throw badRequest('裁决必须写理由（无理由的裁决无法复盘）');
  }
  const row = scanFlags(db, {}, (r) => (r.id === flagId ? r : null));
  if (!row) throw notFound(`复核项不存在: ${flagId}`);
  if (row.status !== 'open') {
    throw badRequest(`复核项 ${flagId} 已裁决（当前状态 ${row.status}），不得二次裁决`);
  }

  // 证据三列：缺列直接报错；按发行方去重（R-AUD-04）
  const normalized = normalizeEvidence({ items: evidence });
  if (normalized.violations.length) {
    throw badRequest(
      `证据缺列，必须补齐 URL / 发行方 / 独立性：${normalized.violations.map((v) => `缺 ${v.missing.join(',')}`).join('；')}`,
    );
  }

  const oldDetail = row.detail_json ? JSON.parse(row.detail_json) : {};
  const detail = {
    ...oldDetail,
    resolution: { status, reason, reviewerId, decidedAt: now },
    evidence: normalized,
  };
  const changes = resolveFlagRow(db, {
    id: flagId, status, reviewedBy: reviewerId, reviewedAt: now, detail,
  });
  if (changes !== 1) throw notFound(`复核项不存在: ${flagId}`);

  writeAuditLog(db, {
    actorId: reviewerId,
    action: 'flag.resolve',
    entity: 'flag',
    entityId: flagId,
    detail: { status, reason, uniquePublishers: normalized.uniquePublishers, dropped: normalized.dropped.length },
    now,
  });

  return { id: flagId, kind: row.kind, status, detail };
}

/**
 * 复核队列列表。列表不满足 → 200 + 空集。
 */
export function listFlags({ db, filter = {}, viewer = null }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0 };
  const { rows, total } = listFlagRows(db, filter);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      stageId: r.stage_id,
      teamId: r.team_id,
      judgeId: r.judge_id,
      kind: r.kind,
      status: r.status,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
    })),
    total,
  };
}

/**
 * TOP10 反向抽查任务（R-JDG-16，S7 §4.1「组委会对 TOP10 作品电话回访」）。
 *
 * ⛔ P11：实现**下沉到领域层**（src/domain/anticheat.js）——
 *    它是纯函数，却住在服务层 ⇒ 演示适配器（浏览器端）无法 import
 *    （服务层会拖进 node:sqlite）⇒ 演示站只能另写一份 ⇒ **形状必然漂**。
 *    现在演示站与正式站 import **同一个函数** ⇒ 不可能漂（与 buildEventInfo 同款做法）。
 *    这里保留一个转出，保证既有调用方（src/services/leaderboard.js）一个字都不用改。
 */
export { buildReverseAuditTasks } from '../domain/anticheat.js';

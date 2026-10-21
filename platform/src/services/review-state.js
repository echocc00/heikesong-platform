// src/services/review-state.js — 复核与申诉状态机
// 依据：设计文档 §11.2（人工复核与申诉状态机）
//   SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED
//               ↘ REJECTED ←（选手申诉）──┘
//               ↘ FLAGGED（疑似刷分/串通）→ REJECTED | CONFIRMED
//   借鉴 OpenReview 的状态机思路（MIT）：分阶段 + 幂等守卫（只处理首次 edit）。
// 三条硬规则：
//   ① PENDING_REVIEW 的分数对其他评委/企业不可见 → 必须在【API 层】过滤，前端隐藏 = 已泄露
//   ② 每次状态迁移写 audit_log(from_state, to_state, reason, at) → 否则申诉无法复盘
//   ③ 幂等守卫：重复触发不产生二次迁移
//   ④ 申诉触发 revision + 1 重算，不覆盖历史（旧 revision 保留）
import { findLatestTransition } from '../db/repo/audit-log.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { insertAppeal, getAppeal, listAppealRows, updateAppeal } from '../db/repo/appeals.js';
import { getTeamTierRow } from '../db/repo/tiers.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

export const REVIEW_STATES = ['SUBMITTED', 'PENDING_REVIEW', 'CONFIRMED', 'FINALIZED', 'REJECTED', 'FLAGGED'];

// 合法迁移表。REJECTED → PENDING_REVIEW 是"选手申诉后重新复核"；
// FINALIZED → REJECTED 是"申诉成立、撤销终稿"，随后走 revision + 1 重算。
export const REVIEW_TRANSITIONS = {
  SUBMITTED: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['CONFIRMED', 'REJECTED', 'FLAGGED'],
  CONFIRMED: ['FINALIZED'],
  REJECTED: ['PENDING_REVIEW', 'CONFIRMED'],
  FLAGGED: ['REJECTED', 'CONFIRMED'],
  FINALIZED: ['REJECTED'],
};

export function getSubjectState({ db, subjectType, subjectId }) {
  const latest = findLatestTransition(db, subjectType, subjectId);
  if (!latest || !latest.to) return null;
  return latest.to;
}

/**
 * 把迁移时间戳单调化：同一 subject 的相邻迁移必须**严格递增**。
 *
 * ⚠️ 为什么必须有这个（2026-10-21 Task 5 实跑发现的 Critical 缺陷）：
 *   「当前状态」的真值来源是 audit_log 里最后一条 `review_state.transition`，
 *   而仓储层 `findLatestTransition` 的排序是 `created_at DESC, id DESC` ——
 *   `id` 是 randomUUID()，**同一毫秒内的多条迁移之间的先后是随机的**。
 *   实测：三条迁移共用同一 created_at 时，200 次里有 135 次读到**过期**状态。
 *   后果不是"排序不好看"，而是状态机直接抛 409：
 *     - `decideAppeal` 连续两次迁移**用同一个 now** → 约 50% 概率假报
 *       「状态冲突：当前是 FINALIZED，本次声明 REJECTED」；
 *     - 任何连续两条迁移共用同一时间戳的调用方都会踩到。
 *   修法有两条路：
 *     ① 改仓储层 `findLatestTransition` 的 ORDER BY（用 rowid 做次序）——
 *        治本，但要动 Task 1 的文件（越界）；
 *     ② 在服务层保证「自己写出去的迁移时间戳严格递增」（本函数）——
 *        本服务是 `review_state.transition` 的**唯一写入方**，只要自己严格递增，
 *        就不存在并列，`created_at DESC` 的排序就是确定的。
 *   选 ②：治本且不越界；只有"时间戳完全相同"时才 +1ms，正常调用**不动**调用方的 now。
 *   （治本的 ① 留给上游：见 Task 5 报告「存疑/需上游注意」。）
 */
function monotonicAt(db, subjectType, subjectId, now) {
  const prev = findLatestTransition(db, subjectType, subjectId);
  if (!prev || !prev.at) return now;
  const prevMs = Date.parse(prev.at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(prevMs) || !Number.isFinite(nowMs)) return now;
  if (nowMs > prevMs) return now;
  return new Date(prevMs + 1).toISOString();
}

export function parseAppealSubject(subjectId) {
  const idx = String(subjectId ?? '').indexOf(':');
  if (idx < 0) return { stageId: null, teamId: String(subjectId ?? '') };
  return { stageId: subjectId.slice(0, idx), teamId: subjectId.slice(idx + 1) };
}

/**
 * 状态迁移。三条硬规则见文件头注释。
 * @returns {{ applied: boolean, from: string, to: string, state: string, at: string }}
 */
export function transition({
  db, subjectType, subjectId, from, to, actorId = null, reason,
  idempotencyKey = null, now = new Date().toISOString(),
}) {
  if (!subjectType || !subjectId) throw badRequest('状态迁移必须给 subjectType 与 subjectId');
  if (!REVIEW_STATES.includes(from)) throw badRequest(`未知状态: ${from}`);
  if (!REVIEW_STATES.includes(to)) throw badRequest(`未知状态: ${to}`);

  // 幂等守卫：同一 idempotencyKey 重复触发不产生二次迁移
  if (idempotencyKey) {
    const scope = `review_state:${subjectType}:${subjectId}`;
    const existing = findIdempotency(db, { key: idempotencyKey, scope });
    if (existing) {
      const stored = existing.response_json ? JSON.parse(existing.response_json) : {};
      return { ...stored, applied: false, replayed: true };
    }
  }

  const allowed = REVIEW_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`非法迁移：${from} → ${to}（允许：${allowed.join(' / ') || '无'}）`);
  }

  const current = getSubjectState({ db, subjectType, subjectId }) ?? 'SUBMITTED';
  if (current !== from) {
    throw conflict(`状态冲突：当前是 ${current}，本次声明 ${from}`);
  }

  const at = monotonicAt(db, subjectType, subjectId, now);
  writeAuditLog(db, {
    actorId,
    action: 'review_state.transition',
    entity: subjectType,
    entityId: subjectId,
    detail: { from, to, reason, at, idempotencyKey },
    now: at,
  });

  const result = { applied: true, from, to, state: to, at, replayed: false };

  if (idempotencyKey) {
    const scope = `review_state:${subjectType}:${subjectId}`;
    insertIdempotency(db, {
      key: idempotencyKey,
      scope,
      requestId: idempotencyKey,
      response: result,
      now: at,
    });
  }

  return result;
}

/**
 * 分数可见性过滤（必须在 API 层调用，不是前端隐藏）。
 * PENDING_REVIEW 期间，分数对其他评委/企业不可见。
 */
export function filterVisibleScores({ db, stageId, viewer = null, scores = [] }) {
  const state = getSubjectState({ db, subjectType: 'stage_result', subjectId: stageId });
  if (state !== 'PENDING_REVIEW') return scores;

  const privileged = viewer ? can(viewer, 'audit:read', null, db) : false;
  return scores.map((s) => {
    if (privileged) return s;
    if (viewer && s.judgeId && s.judgeId === viewer.id) return s;
    return { ...s, rawScore: null, hidden: true, hiddenReason: 'pending_review' };
  });
}

/**
 * 提交申诉。范围：已 FINALIZED 且处于低可见档的条目（设计文档 §11.2）。
 */
export function fileAppeal({
  db, subjectType = 'team_result', subjectId, filedBy = null, reason, now = new Date().toISOString(), rules,
}) {
  if (!subjectId) throw badRequest('申诉必须给 subjectId');
  if (!reason || !String(reason).trim()) throw badRequest('申诉必须写理由（空理由 = 无法复核）');

  const { stageId, teamId } = parseAppealSubject(subjectId);
  const state = stageId ? getSubjectState({ db, subjectType: 'stage_result', subjectId: stageId }) : null;
  if (state !== 'FINALIZED') {
    throw conflict(`只有已 FINALIZED 的条目可以申诉（当前状态：${state ?? '未进入复核'}）`);
  }

  const allowedTiers = rules?.audit?.reviewState?.appealAllowedTiers ?? [];
  const tier = teamId ? getTeamTierRow(db, teamId) : null;
  if (!tier) {
    throw conflict(`无法判定档位（队伍 ${teamId}）——档位未知时不得受理申诉`);
  }
  if (!allowedTiers.includes(tier)) {
    throw forbidden(`档位 ${tier} 不在可申诉的低可见档（${allowedTiers.join(' / ')}）范围内`);
  }

  const id = insertAppeal(db, {
    subjectType, subjectId, filedBy, reason, status: 'submitted', now,
  });
  writeAuditLog(db, {
    actorId: filedBy,
    action: 'appeal.filed',
    entity: 'appeal',
    entityId: id,
    detail: { subjectType, subjectId, reason, stageId, teamId, tier },
    now,
  });
  return getAppeal(db, id);
}

/**
 * 裁决申诉。成立 → 撤销终稿（FINALIZED → REJECTED → PENDING_REVIEW）并要求 revision + 1 重算。
 * 旧 revision 保留（重算走新记录，不覆盖历史）。
 */
export function decideAppeal({
  db, appealId, decision, decidedBy = null, note, now = new Date().toISOString(), rules,
}) {
  if (!['accepted', 'rejected'].includes(decision)) {
    throw badRequest(`裁决只能是 accepted 或 rejected，收到：${decision}`);
  }
  if (!note || !String(note).trim()) throw badRequest('裁决必须写说明（无说明的裁决无法复盘）');

  const appeal = getAppeal(db, appealId);
  if (!appeal) throw notFound(`申诉不存在: ${appealId}`);
  if (appeal.status !== 'submitted' && appeal.status !== 'reviewing') {
    throw conflict(`申诉 ${appealId} 已裁决（当前状态 ${appeal.status}）`);
  }

  const transitions = [];
  if (decision === 'accepted') {
    const { stageId } = parseAppealSubject(appeal.subject_id);
    if (stageId) {
      transitions.push(transition({
        db, subjectType: 'stage_result', subjectId: stageId,
        from: 'FINALIZED', to: 'REJECTED', actorId: decidedBy,
        reason: `申诉成立：${note}`, idempotencyKey: `appeal:${appealId}:revoke`, now,
      }));
      transitions.push(transition({
        db, subjectType: 'stage_result', subjectId: stageId,
        from: 'REJECTED', to: 'PENDING_REVIEW', actorId: decidedBy,
        reason: `申诉重新复核：${note}`, idempotencyKey: `appeal:${appealId}:reopen`, now,
      }));
    }
  }

  updateAppeal(db, { id: appealId, status: decision, decidedBy, decidedAt: now, decisionNote: note });
  writeAuditLog(db, {
    actorId: decidedBy,
    action: 'appeal.decided',
    entity: 'appeal',
    entityId: appealId,
    detail: { decision, note, subjectType: appeal.subject_type, subjectId: appeal.subject_id, recomputeRequired: decision === 'accepted' },
    now,
  });

  return {
    appeal: getAppeal(db, appealId),
    transitions,
    // 申诉成立必须重算；重算走 revision + 1，旧 revision 保留（不覆盖历史）
    recomputeRequired: decision === 'accepted',
  };
}

/**
 * 申诉列表。列表不满足 → 200 + 空集。
 */
export function listAppeals({ db, filter = {}, viewer = null }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0 };
  const { rows, total } = listAppealRows(db, filter);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      filedBy: r.filed_by,
      reason: r.reason,
      status: r.status,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
    })),
    total,
  };
}

// src/services/review-state-core.js — 复核状态机的**内核**（迁移表 + 迁移写入 + 终稿推进）
//
// 依据：设计文档 §11.2（人工复核与申诉状态机）
//   SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED
//               ↘ REJECTED ←（选手申诉）──┘
//               ↘ FLAGGED（疑似刷分/串通）→ REJECTED | CONFIRMED
//
// ⚠️ 为什么把内核从 `src/services/review-state.js` 里**抽出来**（E170 / F36）：
//   `review-state.js` 是一个**可选模块** —— 路由层用 `loadOptionalModule` 动态加载它，
//   模块不在时申诉端点回 503 `REVIEW_STATE_UNAVAILABLE`（fail closed），
//   **但整个平台必须照常启动**（见 test/audit-api.test.js 的「终审修正 M-5」活体用例：
//   它删掉副本里的 review-state.js 后，副本的 server.js 仍必须能起来）。
//   ⇒ 而 F36 的修复要求「发榜时生产 FINALIZED」，发榜路径（services/leaderboard.js）
//     **必须**静态依赖这个能力 —— 静态 import 一个可能不存在的模块 ⇒ 整个平台起不来。
//   ⇒ 所以把**状态机内核**（永远存在的那部分）拆到这里：
//     · 本模块：迁移表 + 迁移写入 + 终稿推进 —— 依赖的都是**始终存在**的仓储与工具；
//     · review-state.js：申诉队列 / 报名类申诉 / 档位判定 —— 那才是「可能还没落地」的部分。
//   ⇒ 两边共用**同一份** `transition()` 实现 ⇒ 不会出现「两个写入方各写一套规则」的漂移。
//
// 三条硬规则（与原 review-state.js 文件头一致）：
//   ① PENDING_REVIEW 的分数对其他评委/企业不可见 → 必须在【API 层】过滤，前端隐藏 = 已泄露
//   ② 每次状态迁移写 audit_log(from, to, reason, at) → 否则申诉无法复盘
//   ③ 幂等守卫：重复触发不产生二次迁移
import { findLatestTransition } from '../db/repo/audit-log.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { writeAuditLog } from '../audit/log.js';
import { badRequest, conflict } from '../errors.js';

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
 * ⚠️ 为什么要有这个（2026-10-21 Task 5 实跑发现的 Critical 缺陷）：
 *   「当前状态」的真值来源是 audit_log 里最后一条 `review_state.transition`。
 *   ⚠️ **这条注释里的根因描述已被 P4 终审修正（2026-10-21）** ——
 *   原先写的是「仓储层排序是 `created_at DESC, id DESC`」，**与实际代码不符**：
 *   仓储层 `findLatestTransition` 的破并列键**早已改成 SQLite 隐式 `rowid`**
 *   （P4-13 根因修复，提交 `fba7b6e`；`id` 是 randomUUID()，同毫秒内次序随机）。
 *   当时的缺陷（实测三条迁移共用同一 created_at 时，200 次里有 135 次读到**过期**状态；
 *   `decideAppeal` 连续两次迁移用同一个 now → 约 50% 概率假报 409）因此**已治本**：
 *     · 根因修复：仓储层 `ORDER BY created_at DESC, rowid DESC`；
 *     · 双保险（本函数）：本模块是 `review_state.transition` 的**唯一写入方**，
 *       自己写出去的时间戳严格递增 ⇒ 正常调用根本不会出现并列。
 *   本函数**保留**：① 兼容「同毫秒内多条迁移」的外部写入；② 防止将来有人
 *   把仓储层的 ORDER BY 改回去时，静默退化回随机次序。
 *   只有「时间戳完全相同」时才 +1ms，正常调用**不动**调用方的 now。
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
 * 把**赛段结果**的复核状态推进到 FINALIZED（E170 / F36）。
 *
 * ⚠️ 为什么必须有这个函数（缺陷 F36）：
 *   `fileAppeal` 要求赛段结果处于 FINALIZED 才受理申诉，而
 *   `REVIEW_TRANSITIONS` 里 `CONFIRMED → FINALIZED` 本来是允许的 ——
 *   但**全仓没有任何一处生产它**：仅有的两处 `transition()` 调用都在 `decideAppeal` 内部，
 *   且都是 `from: 'FINALIZED'`（**消费** FINALIZED，不**生产**它）⇒ 状态机是个闭环
 *   ⇒ 「提交申诉 → 裁决 → 撤销终稿 → 重算」这条链在生产上**完全不可达**。
 *   ⇒ 终稿落库（发榜）时必须把这条迁移写出来。
 *
 * ⚠️ 状态是**按赛段**记的（subjectType='stage_result' + subjectId=stageId），
 *   不是按队伍 —— 与 `fileAppeal` / `filterVisibleScores` 的取法**完全一致**（见那两处）。
 *
 * ⚠️ 迁移是**显式写死**每一步的（而不是「沿转移表自动找路径」）：
 *   ① 每一步都能在 `REVIEW_TRANSITIONS` 里查到（自动找路径会把「REJECTED → PENDING_REVIEW
 *      还是 REJECTED → CONFIRMED」这种选择变成隐式约定）；
 *   ② 「谁在生产 FINALIZED」在源码里**一眼可见**（审计的 F36 就是查这个字面量）。
 *
 * @returns {{ applied: object[], state: string }} 已生效的迁移与最终状态
 */
export function finalizeStageResult({
  db, stageId, actorId = null, reason = '发榜终稿', now = new Date().toISOString(),
}) {
  const subjectType = 'stage_result';
  const subjectId = String(stageId);
  const applied = [];
  let current = getSubjectState({ db, subjectType, subjectId }) ?? 'SUBMITTED';

  const step = (from, to) => {
    applied.push(transition({ db, subjectType, subjectId, from, to, actorId, reason, now }));
    current = to;
  };

  // ① 进入复核（首次发榜：SUBMITTED → PENDING_REVIEW；申诉被裁决成立并撤销终稿后：
  //    REJECTED → PENDING_REVIEW ⇒ 重新进入复核）
  if (current === 'SUBMITTED') step('SUBMITTED', 'PENDING_REVIEW');
  if (current === 'REJECTED') step('REJECTED', 'PENDING_REVIEW');
  // ② 复核通过 ⇒ CONFIRMED（FLAGGED 是「有冲突待裁决」，裁决通过后走 CONFIRMED）
  if (current === 'PENDING_REVIEW') step('PENDING_REVIEW', 'CONFIRMED');
  if (current === 'FLAGGED') step('FLAGGED', 'CONFIRMED');
  // ③ 终稿落库 ⇒ FINALIZED（**这一条就是 F36 指认的、此前根本不存在的生产者**）
  if (current === 'CONFIRMED') {
    applied.push(transition({
      db,
      subjectType,
      subjectId,
      from: 'CONFIRMED',
      to: 'FINALIZED',
      actorId,
      reason,
      now,
    }));
    current = 'FINALIZED';
  }
  return { applied, state: current };
}

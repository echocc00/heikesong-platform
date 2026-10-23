// src/services/idempotency.js — 幂等键执行器
// 依据：设计文档 §11.1「重复提交 / 并发灌分 → 幂等键（request_id 唯一）」
//   借鉴 hack-the-back app/services/judging.py 的幂等思路（MIT），只读思路独立实现。
//   ⛔ 同一 request_id 重复提交只生效一次，且重复请求返回【首次的响应】——不是重新算一遍。
//
// ⚠️ **这不是 P2 的 `src/db/repo/request-keys.js`（`claimRequestKey`）** —— 两者看着像，
//    却是**两个不同的能力**，别当重复造轮子：
//    · P2 `review_request_keys`：**只抢键**。抢到 = 首次生效，抢不到 = 重复请求 → 直接短路，
//      幂等键表里**不存业务响应**。用于「一次批量提交写多行、它们共用同一个 request_id」
//      的评审场景（键建在业务表的 request_id 列上会插不进第二批）。
//    · P4 `idempotency_keys`：**存业务响应**。首次执行完把响应 JSON 落库，重复请求
//      **原样返回首次的响应**（调用方不需要再问一次「上次到底成没成」）。
//    一句话：P2 管「别重复写」，P4 管「重复写时也要能给出同样的答复」。
//
// ⚠️ **响应是 JSON 往返**：首次调用返回的是业务函数的**原始返回值**，
//    重放返回的是**落库后再解析**的那份（`JSON.parse(response_json)`）。
//    对 JSON 安全的载荷两者完全一致；对 `undefined` / `Date` / `Map` 这类值会不同
//    （`undefined` 落库成 NULL、重放拿到 `null`）。HTTP 层本来就只吐 JSON，
//    所以对外无感；调用方若直接读对象字段，请只用 JSON 安全的返回值。
import { createHash } from 'node:crypto';
import { withTransaction } from '../db/tx.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { appError, badRequest } from '../errors.js';

/**
 * 请求体摘要（指纹）—— 幂等键必须**绑定操作**，不能只绑定调用方。
 *
 * ⚠️ **为什么需要它**（2026-10-23 审计 F25）：
 *    幂等键的 scope 是**调用方**（`appeal:${user.id}`），原来**没有任何请求体指纹**
 *    ⇒ 同一个 requestId 换了内容再提交 ⇒ 命中同一条记录 ⇒ **返回第一次的响应**，
 *    第二次申诉**从未提交**，而客户端被告知「成功」⇒ **静默重放**。
 *    ⇒ 摘要不同 ⇒ 不是同一笔操作 ⇒ 报 409（口径与 P2 的 `assertSameRequestContent` 一致：
 *      `src/services/review.js` 的 REQUEST_ID_REUSED）。
 *
 * ⚠️ **为什么用 canonicalJson 而不是 JSON.stringify**：
 *    JSON.stringify 的键顺序取决于**构造顺序** ⇒ 等价内容、不同键序会算出不同摘要
 *    ⇒ 客户端重试时被误判成「换了内容」⇒ 用**键名排序**的稳定序列化（与反作弊去重同口径）。
 */
function requestDigest(payload) {
  return createHash('sha256').update(canonicalJson(payload ?? null)).digest('hex');
}

export function withIdempotency({
  db, key, scope, requestId = null, payload = null, now = new Date().toISOString(),
}, fn) {
  if (!key) throw badRequest('幂等执行必须给 key（request_id）');
  if (!scope) throw badRequest('幂等执行必须给 scope（操作域）');
  const digest = requestDigest(payload);

  return withTransaction(db, () => {
    const existing = findIdempotency(db, { key, scope });
    if (existing) {
      // ⚠️ **F25：同一 requestId 换了内容 ⇒ 不是同一笔操作 ⇒ 409（不许静默重放）**
      //    ⚠️ 旧记录没有摘要（NULL）⇒ 不比对（不把历史记录误判成冲突）。
      if (existing.request_digest && existing.request_digest !== digest) {
        throw appError(
          409, 'REQUEST_ID_REUSED',
          '同一个 requestId 被用于了不同的内容（幂等键已绑定首次提交）',
        );
      }
      // ⛔ 重复请求：直接返回首次的响应，不重新执行业务函数
      return {
        replayed: true,
        result: existing.response_json === null ? null : JSON.parse(existing.response_json),
        storedAt: existing.created_at,
      };
    }

    const result = fn();
    const inserted = insertIdempotency(db, {
      key, scope, requestId, response: result, requestDigest: digest, now,
    });
    if (!inserted) {
      // 并发下别人先写进去了：以库里的首次响应为准
      const again = findIdempotency(db, { key, scope });
      // ⚠️ 并发路径同样要判「内容是不是同一份」——否则并发也能静默重放
      if (again?.request_digest && again.request_digest !== digest) {
        throw appError(
          409, 'REQUEST_ID_REUSED',
          '同一个 requestId 被用于了不同的内容（幂等键已绑定首次提交）',
        );
      }
      return {
        replayed: true,
        result: again?.response_json ? JSON.parse(again.response_json) : null,
        storedAt: again?.created_at ?? now,
      };
    }
    return { replayed: false, result, storedAt: now };
  });
}

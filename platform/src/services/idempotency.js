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
import { withTransaction } from '../db/tx.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { badRequest } from '../errors.js';

export function withIdempotency({ db, key, scope, requestId = null, now = new Date().toISOString() }, fn) {
  if (!key) throw badRequest('幂等执行必须给 key（request_id）');
  if (!scope) throw badRequest('幂等执行必须给 scope（操作域）');

  return withTransaction(db, () => {
    const existing = findIdempotency(db, { key, scope });
    if (existing) {
      // ⛔ 重复请求：直接返回首次的响应，不重新执行业务函数
      return {
        replayed: true,
        result: existing.response_json === null ? null : JSON.parse(existing.response_json),
        storedAt: existing.created_at,
      };
    }

    const result = fn();
    const inserted = insertIdempotency(db, { key, scope, requestId, response: result, now });
    if (!inserted) {
      // 并发下别人先写进去了：以库里的首次响应为准
      const again = findIdempotency(db, { key, scope });
      return {
        replayed: true,
        result: again?.response_json ? JSON.parse(again.response_json) : null,
        storedAt: again?.created_at ?? now,
      };
    }
    return { replayed: false, result, storedAt: now };
  });
}

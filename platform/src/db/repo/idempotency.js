// src/db/repo/idempotency.js — 幂等键仓储
// 依据：设计文档 §11.1「重复提交 / 并发灌分 → 幂等键（request_id 唯一）」
//   ⛔ 唯一约束由数据库保证，不靠"先查再插"（设计文档 §6.3 同构风险的教训）。
import { randomUUID } from 'node:crypto';

export function findIdempotency(db, { key, scope }) {
  return db.prepare('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?').get(key, scope) ?? null;
}

export function insertIdempotency(db, {
  key, scope, requestId = null, response = null, now = new Date().toISOString(),
}) {
  try {
    db.prepare(
      `INSERT INTO idempotency_keys (key, scope, request_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(key, scope, requestId, response === null ? null : JSON.stringify(response), now);
    return true;
  } catch (err) {
    // ⚠️ 只认「唯一约束」这一种失败 —— 其他错误必须继续往上抛。
    //    ⛔ 不用 `INSERT OR IGNORE`：那会把**所有**约束冲突（含 NOT NULL 违规、
    //    磁盘写满）一并吞掉 → 调用方把「写失败」误判成「重复请求」，
    //    客户端以为提交成功了，实际一条都没落库。
    //    P1 的 T-7 踩过一次同样的坑（registrations 的兜底正则被收紧），
    //    P2 的 `claimRequestKey` 也是同款实现 —— 这里与全项目口径保持一致。
    if (/UNIQUE constraint failed: idempotency_keys/i.test(String(err.message))) return false;
    throw err;
  }
}

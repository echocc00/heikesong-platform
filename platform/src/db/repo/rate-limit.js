// src/db/repo/rate-limit.js — 限频计数仓储
// 依据：设计文档 §11.1「三层限频：滑动窗口计数 + 提交锁 + 每分钟配额；再加评委级配额」
//   借鉴 CTFd api/v1/challenges.py 的三层限频思路（Apache-2.0），只读思路独立实现。
//   ⛔ 计数必须落库：只在内存计数 = 进程重启即失效 = 等于没有限频。
//
// ⚠️ `durable` 开关（F19）：限频计数写在**业务事务**里 ⇒ 业务一抛错就被
//    `ROLLBACK` 一起带走 ⇒ 「加个 requestId 就能绕过限频」⇒ 全站唯一有限频的端点形同虚设。
//    ⇒ durable = true 时走 `durableWrite`：写入立即执行（并发可见）+ 登记回滚日志
//      ⇒ 事务回滚后**重放**一次 ⇒ 计数存活。
import { randomUUID } from 'node:crypto';
import { durableWrite } from '../tx.js';

export function countBucket(db, { subjectKey, rule, bucket }) {
  const row = db.prepare(
    'SELECT count FROM rate_limit_events WHERE subject_key = ? AND rule = ? AND bucket = ?',
  ).get(subjectKey, rule, bucket);
  return row?.count ?? 0;
}

export function incrementBucket(db, { subjectKey, rule, bucket, now = new Date().toISOString(), durable = false }) {
  const write = () => db.prepare(
    `INSERT INTO rate_limit_events (id, subject_key, rule, bucket, count, window_start, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(subject_key, rule, bucket)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
  ).run(randomUUID(), subjectKey, rule, bucket, now, now);
  if (durable) durableWrite(db, write);
  else write();
}

export function slidingWindowCount(db, { subjectKey, rule, now, windowSeconds }) {
  const from = new Date(Date.parse(now) - windowSeconds * 1000).toISOString();
  const row = db.prepare(
    `SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_events
      WHERE subject_key = ? AND rule = ? AND window_start >= ?`,
  ).get(subjectKey, rule, from);
  return row?.n ?? 0;
}

export function slidingWindowEvents(db, { subjectKey, rule, now, windowSeconds }) {
  const from = new Date(Date.parse(now) - windowSeconds * 1000).toISOString();
  return db.prepare(
    `SELECT bucket, count, window_start FROM rate_limit_events
      WHERE subject_key = ? AND rule = ? AND window_start >= ?
      ORDER BY window_start ASC`,
  ).all(subjectKey, rule, from);
}

// 提交锁：靠 (subject_key, rule, bucket) 的唯一约束 + CAS 改 window_start 实现。
// 锁过期后允许重新获取（window_start + lockSeconds <= now）。
// ⚠️ `durable`（F19）：锁也是「消耗配额」的一部分 ⇒ 业务失败也得留下这把锁
//    ⇒ 否则「5 秒提交锁」形同虚设（失败一次就能立刻再提交）。
export function acquireLock(db, { subjectKey, rule, now = new Date().toISOString(), lockSeconds = 5, durable = false }) {
  const nowMs = Date.parse(now);
  const row = db.prepare(
    'SELECT id, window_start FROM rate_limit_events WHERE subject_key = ? AND rule = ? AND bucket = ?',
  ).get(subjectKey, rule, 'lock');

  if (!row) {
    const write = () => db.prepare(
      `INSERT INTO rate_limit_events (id, subject_key, rule, bucket, count, window_start, updated_at)
       VALUES (?, ?, ?, 'lock', 1, ?, ?)`,
    ).run(randomUUID(), subjectKey, rule, now, now);
    if (durable) durableWrite(db, write); else write();
    return { acquired: true, retryAfterSeconds: 0 };
  }

  const expiresAt = Date.parse(row.window_start) + lockSeconds * 1000;
  if (expiresAt > nowMs) {
    return { acquired: false, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - nowMs) / 1000)) };
  }

  // CAS：只有把 window_start 从旧值改成新值成功的那一方拿到锁
  let changes = 0;
  const write = () => {
    changes = db.prepare(
      'UPDATE rate_limit_events SET window_start = ?, updated_at = ?, count = count + 1 WHERE id = ? AND window_start = ?',
    ).run(now, now, row.id, row.window_start).changes;
  };
  if (durable) durableWrite(db, write); else write();
  if (changes === 1) return { acquired: true, retryAfterSeconds: 0 };
  return { acquired: false, retryAfterSeconds: Math.max(1, lockSeconds) };
}

/**
 * 释放提交锁（**互斥语义**）：把锁行删掉 ⇒ 下一次可以立刻重新获取。
 *
 * 为什么要它：`acquireLock` 原本是**冷却锁**（拿到后 5 秒内谁都拿不到）。
 * 冷却锁对「申诉」是对的（5 秒内重复申诉 = 刷申诉），
 * 但对「评分提交」是错的 —— 评委改分是**先后两次**提交，
 * 冷却锁会把「改分」挡成 429 ⇒ 平台最核心的「改分必须留痕」契约直接失效。
 *
 * ⇒ 评分路径改成**互斥**：锁只在请求处理期间存在，
 *   挡的是「**同时**在跑」的两笔提交，挡不住「先后两次」。
 *   请求结束（无论成功还是失败）即释放 ⇒ 失败也不把评委锁死 5 秒。
 *   `lock.seconds` 退化为**崩溃兜底 TTL**：进程被 kill 时锁不会永远留着。
 */
export function releaseLock(db, { subjectKey, rule }) {
  const r = db.prepare(
    'DELETE FROM rate_limit_events WHERE subject_key = ? AND rule = ? AND bucket = ?',
  ).run(subjectKey, rule, 'lock');
  return r.changes;
}

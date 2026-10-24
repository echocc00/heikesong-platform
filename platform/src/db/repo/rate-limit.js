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

/**
 * 删掉某个 subject 的**全部**限频计数（管理员解锁用）。
 *
 * ⚠️ **为什么需要它**（2026-10-24 评审）：登录限频是**按账号**记的
 *    ⇒ 知道手机号的人可以故意输错口令，把**受害者本人**的配额耗光
 *    ⇒ 评委在自己想登录时被 429 挡在门外（打分窗口里就是「评委进不去」）。
 *    ⇒ 除了「按来源限频」这层自动防护，还要留一条**人工兜底**：
 *      管理员发现某人被锁 ⇒ 立刻清掉他的计数 ⇒ 人马上能登录。
 *
 * ⚠️ **为什么按 subject 删、而不是按 rule 删**：解锁要清的是
 *    **这个人**的配额（`login:<hash>`），不是**所有账号**的计数 ——
 *    按 rule 删会把全场的登录限频一起清掉（等于闸门失效）。
 *
 * @param {object} db
 * @param {string} subjectKey 目标主体（如 `login:<sha256前16位>`）
 * @returns {number} 删除的行数
 */
export function deleteRateLimitEventsBySubject(db, subjectKey) {
  if (!subjectKey) return 0;
  const r = db.prepare('DELETE FROM rate_limit_events WHERE subject_key = ?').run(subjectKey);
  return r.changes;
}

/**
 * 删掉**某个规则名**下的全部限频计数（管理员应急解除用）。
 *
 * ⚠️ **为什么需要它**（2026-10-24 评审轮）：来源维度的预检是**前置**的
 *    （判定在 scrypt 之前 ⇒ 被挡请求不跑 scrypt）⇒ 它会**连正确口令一起挡**。
 *    ⇒ 一旦某个出口 IP 被误判成攻击源（共享出口的办公室/校园网），
 *    **整个出口的人都会被挡** ⇒ 必须有一条**人能立刻执行的**应急通道。
 *
 * ⚠️ **匹配式是「层名冒号 + 规则名」**：计数表里存的 rule 列是
 *    `sliding:<rule>` / `minute:<rule>` / `hour:<rule>` / `lock:<rule>`
 *    ⇒ 规则名在**后缀**位置，不在开头 ⇒ 匹配式必须是 `%:<规则名>%`
 *    （⛔ 写成 `规则名%` 会**匹配不到任何行** —— 那正是本函数第一版的 bug：
 *      应急解除「执行成功但一行没删」，症状是「解了还是 429」）。
 *    ⇒ `%:loginAttempt%` 一次命中**账号维度**（`loginAttempt`）与
 *      **来源维度**（`loginAttemptByIp`）的全部层级 ⇒ 一次清干净。
 *    ⚠️ 反过来说，它**不会**误伤别的规则（申诉/评分限频的规则名是
 *      `appealSubmit` / `reviewSubmit` / `judgeHourly` ⇒ 不含 `loginAttempt`）。
 *
 * @param {object} db
 * @param {string} ruleName 规则名（如 'loginAttempt'）
 * @returns {number} 删除的行数
 */
export function deleteRateLimitEventsByRulePrefix(db, ruleName) {
  if (!ruleName) return 0;
  const esc = String(ruleName).replace(/([%_\\])/g, '\\$1');
  const r = db
    .prepare("DELETE FROM rate_limit_events WHERE rule LIKE ? ESCAPE '\\'")
    .run(`%:${esc}%`);
  return r.changes;
}

/**
 * 删掉**早已过期**的限频计数事件（运维清理用）。
 *
 * ⚠️ **为什么必须按「窗口早已过去」来删，不能按「行数」或「随便删」**：
 *    删掉还在窗口内的行 ⇒ 计数被清零 ⇒ **限频被绕过**（用户可以无限重试）。
 *    ⇒ 判据是「updated_at 早于 now - retentionSeconds」，且 retentionSeconds
 *    必须**大于任何规则的窗口**。
 *    本仓最宽的窗口是 `perHour`（1 小时，见 rules/audit.json）⇒ 默认 24 小时
 *    留了 24 倍余量 ⇒ 任何一条被删的行，其窗口**必定**早已结束。
 *
 * ⚠️ 为什么删旧行**不改变任何限频判定**：
 *    · `sliding:<rule>` 计数按 `window_start >= now - sliding.seconds` 过滤（≤ 60 秒）；
 *    · `minute:<rule>` / `hour:<rule>` 的 bucket 键里带着**分钟/小时戳**
 *      （bucketKey('m'|'h', ...)）⇒ 旧桶的键**永远不会再被查**；
 *    · `lock:<rule>` 是 TTL 锁（5 秒），过期后由 CAS 路径接管。
 *    ⇒ 24 小时前的行对任何一次判定都**不可见**。
 *
 * @param {object} db
 * @param {{ now?: Date|string, retentionSeconds?: number }} [opts]
 * @returns {number} 删除的行数
 */
export function deleteRateLimitEventsOlderThan(db, { now = new Date(), retentionSeconds = 86400 } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const cutoff = new Date(at.getTime() - retentionSeconds * 1000).toISOString();
  const r = db
    .prepare('DELETE FROM rate_limit_events WHERE datetime(updated_at) < datetime(?)')
    .run(cutoff);
  return r.changes;
}

// src/db/repo/sessions.js — 会话仓储
// 依据：设计文档 §7.5 + 全局约束「所有 SQL 收进 src/db/repo/」。
// ⛔ 预审修正（I5-1）：会话的全部 SQL 从 src/auth/session.js 搬到这里。
// ⛔ 库里只存 token_hash（SHA-256 十六进制），**不存明文 token**。
export function insertSession(db, { tokenHash, userId, createdAt, expiresAt }) {
  // ⚠️ last_touch_at 落库时就是 created_at —— 会话**刚签发**时的那次「续期」，
  //    正是「脏才写」的起点（P1-3a）。不落这一列 ⇒ 第一次访问就会写库。
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_touch_at) VALUES (?, ?, ?, ?, ?)',
  ).run(tokenHash, userId, createdAt, expiresAt, createdAt);
}

export function findSessionByHash(db, tokenHash) {
  // ⚠️ created_at 必须一起取：绝对过期上限是从**签发时刻**算起的（设计文档 §7.5），
  //    没有签发时刻就无从判断"这个会话最多能活多久"。
  // ⚠️ last_touch_at 也要取：P1-3a「脏才写」要靠它判断「距上次续期是否已过阈值」。
  return db
    .prepare('SELECT user_id, created_at, expires_at, last_touch_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) ?? null;
}

/**
 * 滑动续期：把 expires_at 顺延，**并记下本次续期时刻**（设计文档 §7.5 + P1-3a）。
 *
 * ⚠️ lastTouchAt 缺省不写 —— 那样只会改 expires_at，「脏才写」的判据就永远停在旧值上，
 *    下一次访问又会再写一次（等于没修）。调用方必须传。
 *
 * @param {string} tokenHash
 * @param {string} expiresAt 新的过期时刻（ISO）
 * @param {string} [lastTouchAt] 本次续期时刻（ISO）
 */
export function touchSessionExpiry(db, tokenHash, expiresAt, lastTouchAt = null) {
  if (lastTouchAt) {
    return db
      .prepare('UPDATE sessions SET expires_at = ?, last_touch_at = ? WHERE token_hash = ?')
      .run(expiresAt, lastTouchAt, tokenHash).changes;
  }
  return db
    .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(expiresAt, tokenHash).changes;
}

export function deleteSessionByHash(db, tokenHash) {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
}

export function deleteSessionsByUser(db, userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/**
 * 吊销某用户的会话，但**保留指定的某一个**。
 *
 * 依据：设计文档 §7.5「强制下线」与「改口令后其它设备掉线」两个场景：
 *   · 强制下线 ⇒ exceptHash = null ⇒ 全删（含当前会话）。
 *   · 改口令   ⇒ exceptHash = 当前会话的哈希 ⇒ 只删别的设备。
 * ⛔ 保留的那一个用 `token_hash <> ?` 排除 —— 数据库只存哈希，
 *    调用方传进来的必须是 tokenHash(token)（见 src/auth/session.js）。
 *
 * @param {string} userId
 * @param {string|null} exceptHash 要保留的会话哈希（null = 全删）
 * @returns {number} 被删除的会话条数
 */
export function deleteSessionsByUserExcept(db, userId, exceptHash = null) {
  if (!exceptHash) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
  }
  return db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
    .run(userId, exceptHash).changes;
}

export function countActiveSessions(db, userId, { now = new Date() } = {}) {
  // ⛔ 预审修正（m5-1）：过期判定**解析时间戳再比较**，不做字符串比较。
  //    字符串比较下 '...T00:00:00Z' 与 '...T00:00:00.000Z' 会给出相反结论。
  //    SQL 侧用 SQLite 的 datetime()（与 JS 侧 new Date(...) 同一口径）。
  return db
    .prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND datetime(expires_at) > datetime(?)',
    )
    .get(userId, new Date(now).toISOString()).n;
}

export function purgeExpiredSessions(db, { now = new Date() } = {}) {
  return db
    .prepare('DELETE FROM sessions WHERE datetime(expires_at) <= datetime(?)')
    .run(new Date(now).toISOString()).changes;
}

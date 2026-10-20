// src/db/repo/sessions.js — 会话仓储
// 依据：设计文档 §7.5 + 全局约束「所有 SQL 收进 src/db/repo/」。
// ⛔ 预审修正（I5-1）：会话的全部 SQL 从 src/auth/session.js 搬到这里。
// ⛔ 库里只存 token_hash（SHA-256 十六进制），**不存明文 token**。
export function insertSession(db, { tokenHash, userId, createdAt, expiresAt }) {
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(tokenHash, userId, createdAt, expiresAt);
}

export function findSessionByHash(db, tokenHash) {
  // ⚠️ created_at 必须一起取：绝对过期上限是从**签发时刻**算起的（设计文档 §7.5），
  //    没有签发时刻就无从判断"这个会话最多能活多久"。
  return db
    .prepare('SELECT user_id, created_at, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) ?? null;
}

/** 滑动续期：把 expires_at 顺延（设计文档 §7.5） */
export function touchSessionExpiry(db, tokenHash, expiresAt) {
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

// src/auth/session.js — 服务端会话
// 依据：设计文档 §7.5。⛔ 不做无状态 JWT —— 难撤销、难审计、难强制下线。
//   token 只在签发时返回一次，数据库只存 SHA-256 哈希。
// ⛔ 本文件**不含任何 SQL**（全局约束「所有 SQL 收进 src/db/repo/」）：
//   这里只做与 SQL 无关的事 —— 生成 token、算 SHA-256 哈希、算过期时间。
//   （预审修正 I5-1：原来 4 处 db.prepare 写在这里，仓储层只剩两个辅助函数。）
import { randomBytes, createHash } from 'node:crypto';
import {
  insertSession,
  findSessionByHash,
  touchSessionExpiry,
  deleteSessionByHash,
  deleteSessionsByUser,
} from '../db/repo/sessions.js';

const DEFAULT_TTL_DAYS = 7;

// 会话有效期（天）。默认 7 天，用 SESSION_TTL_DAYS 覆盖。
// 每次调用时读 env（不在模块加载时固化）→ 改 env 立即生效，测试也好构造。
export function sessionTtlDays() {
  const raw = process.env.SESSION_TTL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function expiryFrom(now, ttlDays) {
  return new Date(now.getTime() + ttlDays * 86400_000).toISOString();
}

export function createSession(db, userId, { ttlDays = sessionTtlDays(), now = new Date() } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = expiryFrom(now, ttlDays);
  insertSession(db, {
    tokenHash: tokenHash(token),
    userId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

export function resolveSession(db, token, { now = new Date(), ttlDays = sessionTtlDays() } = {}) {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = findSessionByHash(db, hash);
  if (!row) return null;
  // 过期判定：解析时间戳再比较，**不做字符串比较**
  // （'...T00:00:00Z' 与 '...T00:00:00.000Z' 字符串比较会给出相反结论）
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    deleteSessionByHash(db, hash);
    return null;
  }
  // 滑动续期（设计文档 §7.5「绝对过期 + 滑动续期」）：命中有效会话就顺延一个 ttl
  const expiresAt = expiryFrom(now, ttlDays);
  touchSessionExpiry(db, hash, expiresAt);
  return { userId: row.user_id, expiresAt };
}

export function revokeSession(db, token) {
  if (!token) return 0;
  return deleteSessionByHash(db, tokenHash(token));
}

export function revokeAllSessions(db, userId) {
  return deleteSessionsByUser(db, userId);
}

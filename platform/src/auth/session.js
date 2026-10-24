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
  deleteSessionsByUserExcept,
} from '../db/repo/sessions.js';

const DEFAULT_TTL_DAYS = 7;

// 绝对过期上限（天）。设计文档 §7.5 明写「绝对过期 + 滑动续期」——
// ⛔ 评审修正（Important）：原来**只实现了滑动续期**。滑动续期意味着：
//    只要一直有人在用，这个会话就永远不过期 —— 令牌一旦泄露，攻击者可以
//    一直用它刷新自己。绝对上限给"最坏情况下多久必须重新登录"一个硬边界。
//    绝对上限从**签发时刻**算起（sessions.created_at），滑动续期不得突破它。
const DEFAULT_ABSOLUTE_TTL_DAYS = 30;

// 会话有效期（天）。默认 7 天，用 SESSION_TTL_DAYS 覆盖。
// 每次调用时读 env（不在模块加载时固化）→ 改 env 立即生效，测试也好构造。
export function sessionTtlDays() {
  const raw = process.env.SESSION_TTL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

/**
 * 滑动续期的「脏」阈值（毫秒）：距上次续期超过这个时长才**真的写库**。
 *
 * 依据：P1-3a「拆掉读路径的隐性写库」（2026-10-24 独立评审轮）。
 *   · 修复前：每次命中有效会话都 UPDATE sessions SET expires_at = ?
 *     ⇒ **每个 GET 请求都产生一次写事务** ⇒ 读路径写放大。
 *   · 现在：只有距上次续期超过阈值才 UPDATE。
 *
 * ⚠️ 取 30 分钟的理由：会话 TTL 默认 7 天 ⇒ 续期粒度从 7 天粗到 30 分钟，
 *    对用户完全无感（少掉的只是「已经快到期时再多用一会儿」的边际），
 *    却把读路径的写量降到原来的 1/350 量级。
 * ⚠️ **不能更粗**：TTL 可被 SESSION_TTL_DAYS 调小 ⇒ 阈值必须远小于 TTL
 *    （否则会话会在用户还在用时过期）。30 分钟 ≪ 最小可用 TTL（1 小时）。
 */
const TOUCH_INTERVAL_MS = 30 * 60 * 1000;

/** 绝对过期上限（天）。默认 30 天，用 SESSION_ABSOLUTE_TTL_DAYS 覆盖。 */
export function sessionAbsoluteTtlDays() {
  const raw = process.env.SESSION_ABSOLUTE_TTL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_ABSOLUTE_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ABSOLUTE_TTL_DAYS;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function expiryFrom(now, ttlDays) {
  return new Date(now.getTime() + ttlDays * 86400_000).toISOString();
}

/** 取两个 ISO 时间戳中**较早**的那个 —— 滑动续期不得越过绝对上限。 */
function earlierIso(a, b) {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

export function createSession(
  db,
  userId,
  { ttlDays = sessionTtlDays(), absoluteTtlDays = sessionAbsoluteTtlDays(), now = new Date() } = {},
) {
  const token = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = expiryFrom(now, absoluteTtlDays);
  const expiresAt = earlierIso(expiryFrom(now, ttlDays), absoluteExpiresAt);
  insertSession(db, {
    tokenHash: tokenHash(token),
    userId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

export function resolveSession(
  db,
  token,
  { now = new Date(), ttlDays = sessionTtlDays(), absoluteTtlDays = sessionAbsoluteTtlDays() } = {},
) {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = findSessionByHash(db, hash);
  if (!row) return null;
  const nowMs = now.getTime();
  // 过期判定：解析时间戳再比较，**不做字符串比较**
  // （'...T00:00:00Z' 与 '...T00:00:00.000Z' 字符串比较会给出相反结论）
  //
  // ⛔ 评审修正（Important）：绝对过期（设计文档 §7.5）。
  //    原来只查 expires_at，而 expires_at 每次滑动续期都被推后 →
  //    一个被持续使用的会话可以永不过期。绝对上限从**签发时刻**算起，
  //    到点一律作废（并删行），不因使用频率而延后。
  const absoluteExpiresAt = expiryFrom(new Date(row.created_at), absoluteTtlDays);
  if (new Date(absoluteExpiresAt).getTime() <= nowMs) {
    deleteSessionByHash(db, hash);
    return null;
  }
  if (new Date(row.expires_at).getTime() <= nowMs) {
    deleteSessionByHash(db, hash);
    return null;
  }
  // 滑动续期（设计文档 §7.5）：命中有效会话就顺延一个 ttl，但不得越过绝对上限。
  // ── P1-3a：改「脏才写」──────────────────────────────────────────────
  //   修复前：每次命中都 UPDATE ⇒ 每个 GET 请求都产生一次写事务（读路径写放大）。
  //   现在：只有距**上次续期**超过 TOUCH_INTERVAL_MS 才真的 UPDATE。
  //
  // ⚠️ 不续期时返回**库里存着的** expires_at（而不是重新算一个）：
  //    返回值必须与数据库始终一致 ⇒ 客户端 cookie 的有效期不会比库里更晚
  //    （否则客户端以为会话还活着，服务端已经按库里的时间判它过期 ⇒ 表现为
  //      「用户还在操作就突然被登出」，而且没有任何报错可查）。
  const lastTouchAt = row.last_touch_at ? Date.parse(row.last_touch_at) : NaN;
  // ⚠️ `nowMs - lastTouchAt` 可能为负（时钟回拨 / 迁移回填异常）⇒ 那时**不写**
  //    （写下去只会把续期时刻推到更早，越写越频繁）。
  const needsTouch = !Number.isFinite(lastTouchAt) || (nowMs - lastTouchAt) >= TOUCH_INTERVAL_MS;
  if (!needsTouch) {
    return { userId: row.user_id, expiresAt: row.expires_at };
  }
  const expiresAt = earlierIso(expiryFrom(now, ttlDays), absoluteExpiresAt);
  touchSessionExpiry(db, hash, expiresAt, now.toISOString());
  return { userId: row.user_id, expiresAt };
}

export function revokeSession(db, token) {
  if (!token) return 0;
  return deleteSessionByHash(db, tokenHash(token));
}

export function revokeAllSessions(db, userId) {
  return deleteSessionsByUser(db, userId);
}

/**
 * 吊销该用户的会话，但**保留指定的那一个**（按 token 判定，不是按哈希）。
 *
 * 用途：改口令后让**其它设备**上的会话全部作废，同时**不把当前这次登录踢下线**
 * —— 否则用户改完口令立刻被登出，体验上像「改失败了」。
 *
 * ⚠️ 传进来的 exceptToken 是**明文 token**（不是哈希）—— 这里负责算哈希，
 *    因为 tokenHash 是本文件的私有实现（对外不暴露）。
 *
 * @param {string} userId
 * @param {string|null} exceptToken 要保留的会话的明文 token（null = 全删）
 * @returns {number} 被吊销的会话条数
 */
export function revokeAllSessionsExcept(db, userId, exceptToken = null) {
  return deleteSessionsByUserExcept(db, userId, exceptToken ? tokenHash(exceptToken) : null);
}

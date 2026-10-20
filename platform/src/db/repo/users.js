// src/db/repo/users.js — 用户仓储
// 依据：设计文档 §7.2。所有 SQL 收进仓储层，handler 内禁止裸 SQL。
//
// ⛔ 预审修正（I5-2）：SELECT 一律**显式列白名单，不含 password_hash**。
//    原来用 SELECT *，listUsers 一次返回全体用户 + 全部 scrypt 哈希 ——
//    P0 的 /api/me 手工挑字段所以当下安全，但任何后续 handler 只要
//    `json(res, 200, user)` 就会把口令哈希发给浏览器。
//    带哈希的行只允许 getCredentialsByPhone 取，且只用于服务端口令校验。
const PUBLIC_COLUMNS = 'id, name, phone, mba_status, org, is_superadmin, active, created_at';

import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../auth/password.js';

/**
 * 对外用户形状（**唯一出口**）：字段转驼峰，绝不带 password_hash。
 * 所有要把用户放进 HTTP 响应的地方都必须走它。
 */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    mbaStatus: row.mba_status,
    org: row.org ?? null,
    isSuperadmin: row.is_superadmin === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function createUser(db, { name, phone, password, mbaStatus = 'other', org = null }) {
  // ⛔ 预审修正（I5-3）：重复手机号**先查后写**，抛领域错误（409 / PHONE_TAKEN）。
  //    原来直接 INSERT，让原始 SQLite 错误 `UNIQUE constraint failed: users.phone`
  //    漏到 HTTP 层 —— 既只能回 500，又把表名列名暴露给客户端。
  //    查重不看 active：停用用户的手机号也不能被再次注册。
  if (findUserByPhone(db, phone)) {
    const err = new Error('该手机号已注册');
    err.status = 409;
    err.code = 'PHONE_TAKEN';
    throw err;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
  ).run(id, name, phone, hashPassword(password), mbaStatus, org, now);
  return getUserById(db, id);
}

export function getUserById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND active = 1`).get(id) ?? null;
}

/** 不看 active —— 唯一性查重用（停用用户的手机号也不能被再次注册）。 */
export function findUserByPhone(db, phone) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE phone = ?`).get(phone) ?? null;
}

export function getUserByPhone(db, phone) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE phone = ? AND active = 1`).get(phone) ?? null;
}

/**
 * ⛔ 唯一会取出 password_hash 的地方 —— 只用于服务端口令校验（登录），
 *    绝不进任何 HTTP 响应。对外一律用 toPublicUser(row)。
 */
export function getCredentialsByPhone(db, phone) {
  return db
    .prepare('SELECT id, password_hash, active FROM users WHERE phone = ?')
    .get(phone) ?? null;
}

export function listUsers(db, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE active = 1 ORDER BY created_at LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

// ⛔ 软删除：禁止硬删（设计文档 §11「事后篡改」防护）
export function deactivateUser(db, id) {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
}

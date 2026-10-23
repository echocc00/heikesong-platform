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
import { appError } from '../../errors.js';

/**
 * 对外用户形状（**唯一出口**）：字段转驼峰，绝不带 password_hash。
 * 所有要把用户放进 HTTP 响应的地方都必须走它。
 *
 * ⚠️ `roles`（P7 新增）：前端要按角色分区导航，必须知道「你是谁」。
 *    此前 toPublicUser 不带角色 ⇒ /api/me 也拿不到 ⇒ 前端只能做出
 *    「所有人看到同一个菜单」的水平导航。
 *    ⇒ 这里加一个可选的 roles 参数（角色**键**列表，来源 listUserRoles）。
 *    ⚠️ roles 只用于**导航入口分区**，**不构成任何授权依据** ——
 *    可见性始终由 can() + scopeClause 在服务端裁决（全局约束）。
 *    ⚠️ 默认空数组：缺省即「没有角色」，不能因为漏传就变成「有全部权限」。
 *
 * ⚠️ `capabilities`（W1-b · DP-105 新增）：前端要按**能力点**拦路由，
 *    必须知道这个人持有哪些能力点（来源 listUserCapabilities）。
 *    ⇒ 这里加第三个可选参数 capabilities（能力点**键**列表）。
 *    ⚠️ capabilities 只用于前端**提示 / 分区级路由守卫**，
 *    **不构成任何授权依据** —— 授权的唯一裁决者仍然是服务端 can() + scopeClause。
 *    ⚠️ 默认空数组：缺省即「没有能力点」，不能因为漏传就变成「有全部权限」。
 */
export function toPublicUser(row, roles = [], capabilities = []) {
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
    roles: Array.isArray(roles) ? roles.filter((r) => typeof r === 'string' && r) : [],
    capabilities: Array.isArray(capabilities)
      ? [...new Set(capabilities.filter((c) => typeof c === 'string' && c))]
      : [],
  };
}

export function createUser(db, { name, phone, password, mbaStatus = 'other', org = null }) {
  // ⛔ 预审修正（I5-3）：重复手机号**先查后写**，抛领域错误（409 / PHONE_TAKEN）。
  //    原来直接 INSERT，让原始 SQLite 错误 `UNIQUE constraint failed: users.phone`
  //    漏到 HTTP 层 —— 既只能回 500，又把表名列名暴露给客户端。
  //    查重不看 active：停用用户的手机号也不能被再次注册。
  if (findUserByPhone(db, phone)) {
    throw appError(409, 'PHONE_TAKEN', '该手机号已注册');
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

/**
 * ⛔ 与 getCredentialsByPhone 同款纪律：**唯一会取出 password_hash 的地方**。
 *    这里按 **userId** 取（改口令场景：已知自己是谁，不必再问手机号）。
 *    取出的 hash 只用于服务端口令校验，**绝不进任何 HTTP 响应**。
 *
 * @param {string} id
 * @returns {{id: string, password_hash: string, active: number}|null}
 */
export function getCredentialsById(db, id) {
  return db
    .prepare('SELECT id, password_hash, active FROM users WHERE id = ?')
    .get(id) ?? null;
}

/**
 * 改口令：写入新的 password_hash。
 * ⛔ **只改口令，不动其它字段**（角色、能力点、停用状态一律不受影响）——
 *    「改口令」不是「改权限」，这两件事混在一起会让审计失去意义。
 *
 * @param {string} userId
 * @param {string} passwordHash 新哈希（hashPassword 的产物）
 * @returns {number} 受影响行数（0 = 该用户不存在）
 */
export function updatePasswordHash(db, userId, passwordHash) {
  return db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(passwordHash, userId).changes;
}

export function listUsers(db, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE active = 1 ORDER BY created_at LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

/**
 * 用户是否存在（不看 active —— 停用是软删除，记录仍在）。
 * ⛔ 评审修正（Important）：授权前校验用 —— 不校验就是让 SQLite 的原始外键错误冒到 HTTP 层。
 */
export function userExists(db, id) {
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) !== undefined;
}

// ⛔ 软删除：禁止硬删（设计文档 §11「事后篡改」防护）
export function deactivateUser(db, id) {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
}

/**
 * 把用户标记为超管（is_superadmin = 1）。
 *
 * ⛔ 评审修正（I-7）：scripts/seed.js 原来在这里写裸 SQL
 *    db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?')
 *    —— 越过 SQL 边界（脚本里禁止裸 SQL）。这里下沉到仓储层。
 *    ⚠️ 只置位、不复位：调用方负责「授权」的语义（种子脚本只在建号时调用一次）。
 */
export function setSuperadmin(db, userId) {
  db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(userId);
}

/**
 * 反作弊检测用的用户清单（**含手机号**）。
 *
 * ⛔ P11 新增：设计 §11.1 明写「**全行业空白**：没有任何一个开源项目做多账号协同投票检测。
 *    我们至少要做到『同一手机号/同一企业注册的多个账号』可被识别」，
 *    而 `rules/audit.json` 的 `antiCheat.multiAccount.keyFields = ["phone", "org"]`。
 *    仓储层原来那份 `listAllUsers`（pool-sources.js）**不返回 phone** ⇒
 *    「同一手机号多个账号」这条最核心的检测**永远不可能命中**。
 *
 * ⚠️ **含手机号 ⇒ 只能在服务端内部用**，绝不进任何公开响应
 *    （手机号不进公开榜单、不进人才池、不进对外 API）。
 */
export function listUsersForDetection(db) {
  return db.prepare('SELECT id, name, org, phone FROM users WHERE active = 1 ORDER BY id, rowid').all();
}

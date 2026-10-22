// src/db/repo/assignments.js — 授权仓储
// 依据：设计文档 §7.2 + 全局约束「所有 SQL 收进 src/db/repo/」。
//
// ⛔ 预审修正（I6-2）：这个文件原本**只出现在 Files 段落与目录树里，没有任何一步创建它**，
//    而 assignments 的 SQL 全写在 src/auth/permissions.js → 既违反「SQL 收进 src/db/repo/」，
//    又留下一份永久缺失的承诺文件。这里补上。
//
// ⛔ 全局约束「SQL 边界」：src/auth/permissions.js 里**不许出现 SQL 字符串** ——
//    角色能力查询（hasRoleCapability）的 SQL 同样收在这里，而不是留在判定入口里。
export function insertAssignment(
  db,
  { id, userId, capability, scopeType, scopeId = null, grantedBy = null, createdAt },
) {
  db.prepare(
    `INSERT INTO assignments (id, user_id, capability, scope_type, scope_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, capability, scopeType, scopeId, grantedBy, createdAt);
}

export function deleteAssignmentById(db, id) {
  return db.prepare('DELETE FROM assignments WHERE id = ?').run(id).changes;
}

export function listAssignmentsByUserAndCapability(db, userId, capability) {
  return db
    .prepare(
      `SELECT id, user_id, capability, scope_type, scope_id, granted_by, created_at
         FROM assignments WHERE user_id = ? AND capability = ?`,
    )
    .all(userId, capability);
}

/**
 * 用户是否通过**角色**获得该能力（角色能力表 → 用户角色表）。
 *
 * ⛔ 预审修正（C6-1）：JOIN 条件必须是 `rc.role_id = ur.role_key`。
 *    001_init.sql:37-41 里 role_capabilities 的列名是 **role_id**（不是 role_key），
 *    写错会得到 `no such column: rc.role_key` → can() 对任何非超管一律抛错
 *    → P1–P6 的权限判定全变 HTTP 500。
 *    （role_capabilities.role_id、user_roles.role_key、roles.key 指的都是同一个角色键。）
 */
export function hasRoleCapability(db, userId, capability) {
  return db
    .prepare(
      `SELECT 1 FROM user_roles ur
       JOIN role_capabilities rc ON rc.role_id = ur.role_key
       WHERE ur.user_id = ? AND rc.capability = ?
       LIMIT 1`,
    )
    .get(userId, capability) !== undefined;
}

/**
 * 列出用户**持有的能力点键**（角色能力 ∪ 全局资源授权）。
 *
 * ⚠️ 为什么需要它（W1-b · DP-105）：
 *    前端要按「能力点」拦路由（而不是按角色），就必须知道自己**持有哪些能力点** ——
 *    授权模型是「能力 + 授权记录」，一个人可以**被直接授权**某个能力点而没有对应角色，
 *    只看角色表会漏掉这种人。
 *
 * ⛔ **只取 scope_type = 'global' 的资源级授权**：
 *    赛段级（stage / edition 等）授权**不算数** —— 前端只声明「API 同样要求**全局**能力点」
 *    的页面（分区级），赛段级页面的可达性由 API 逐资源裁决。
 *    把赛段级授权也算进来，会让前端「以为有权限」而 API 403，或反过来误伤。
 *
 * ⚠️ **去重与确定性排序**：UNION 天然去重；ORDER BY capability 用 SQLite 的
 *    二进制序（不是 localeCompare）⇒ 同一份数据每次跑出来的顺序完全一样。
 *
 * @param {object} db
 * @param {string} userId
 * @returns {string[]} 能力点键数组（原始键，不做驼峰变换）
 */
export function listUserCapabilities(db, userId) {
  return db
    .prepare(
      `SELECT capability FROM (
         SELECT rc.capability AS capability
           FROM user_roles ur
           JOIN role_capabilities rc ON rc.role_id = ur.role_key
          WHERE ur.user_id = ?
         UNION
         SELECT a.capability AS capability
           FROM assignments a
          WHERE a.user_id = ? AND a.scope_type = 'global'
       )
       ORDER BY capability`,
    )
    .all(userId, userId)
    .map((r) => r.capability);
}

/**
 * 能力点是否已注册。
 * ⛔ 评审修正（Important）：授权前校验用 —— 不校验就是让 SQLite 的原始外键错误
 *    「FOREIGN KEY constraint failed」冒到 HTTP 层（只能回 500，且泄露表结构）。
 */
export function capabilityExists(db, capability) {
  return db.prepare('SELECT 1 FROM capabilities WHERE key = ?').get(capability) !== undefined;
}

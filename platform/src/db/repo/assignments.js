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

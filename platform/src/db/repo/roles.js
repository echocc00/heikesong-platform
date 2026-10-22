// src/db/repo/roles.js — 角色仓储
// 依据：设计文档 §7.1（roles / user_roles 表）+ 全局约束「所有 SQL 收进 src/db/repo/」。
//
// ⛔ 评审修正（I-7）：scripts/seed.js 原来直接
//    db.prepare('INSERT OR IGNORE INTO roles (key, description) VALUES (?, ?)')
//    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, 'admin')")
//    —— 越过 SQL 边界（handler / 脚本里禁止裸 SQL）。这里把两条 SQL 下沉到仓储层。
//
// ⚠️ user_roles.role_key 存的是**角色键**（schema: role_key TEXT REFERENCES roles(key)），
//    与 roles.key 是同一个键值域（001_init.sql）。
export function insertRole(db, key, description) {
  db.prepare('INSERT OR IGNORE INTO roles (key, description) VALUES (?, ?)').run(key, description);
}

/** 给用户绑角色（幂等：重复绑定被 INSERT OR IGNORE 吞掉）。 */
export function insertUserRole(db, userId, roleKey) {
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, ?)').run(userId, roleKey);
}

/**
 * 列出一个用户的**角色键**。
 *
 * ⚠️ 为什么需要它（P7「现有页面打磨到生产级」）：
 *    前端要按角色分区导航（用户端 / 管理员端 / 组委会端），
 *    而 `/api/me` 此前只返回 toPublicUser() —— **没有角色信息**，
 *    前端只能做出「所有人都看到同一个菜单」的水平导航。
 *    ⇒ 这里补一个**纯只读**的角色查询，让 /api/me 能带上 roles。
 *
 * ⛔ 只读、只返回角色键（不返回任何授权记录）：角色是**身份**，
 *    能力与授权（assignments）仍然由 can() 在服务端裁决 —— 前端拿到的 roles
 *    只用于**导航入口分区**，不构成任何授权依据（可见性始终在 API 层过滤）。
 */
export function listUserRoles(db, userId) {
  return db
    .prepare('SELECT role_key FROM user_roles WHERE user_id = ? ORDER BY role_key')
    .all(userId)
    .map((r) => r.role_key);
}

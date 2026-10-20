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

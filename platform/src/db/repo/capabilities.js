// src/db/repo/capabilities.js — 能力点仓储
// 依据：设计文档 §7.1（capabilities / role_capabilities 表）+ 全局约束「所有 SQL 收进 src/db/repo/」。
//
// ⛔ 评审修正（I-7）：scripts/seed.js 原来直接
//    db.prepare('INSERT OR IGNORE INTO capabilities (key, description) VALUES (?, ?)')
//    db.prepare('INSERT OR IGNORE INTO role_capabilities (role_id, capability) VALUES (?, ?)')
//    —— 越过 SQL 边界（handler / 脚本里禁止裸 SQL），与同文件第 80 行
//    「查重用仓储层（不写裸 SQL）」的注释自相矛盾。这里把两条 SQL 下沉到仓储层。
//
// ⚠️ role_capabilities.role_id 存的是**角色键**（schema: role_id TEXT REFERENCES roles(key)），
//    不是 roles.id —— 表里 roles 的主键就叫 key（001_init.sql）。
//    沿用 seed.js 原写法，不改语义。
export function insertCapability(db, key, description) {
  db.prepare('INSERT OR IGNORE INTO capabilities (key, description) VALUES (?, ?)').run(key, description);
}

/** 授予角色一个能力点（幂等：重复写入被 INSERT OR IGNORE 吞掉）。 */
export function insertRoleCapability(db, roleKey, capability) {
  db.prepare('INSERT OR IGNORE INTO role_capabilities (role_id, capability) VALUES (?, ?)').run(
    roleKey,
    capability,
  );
}

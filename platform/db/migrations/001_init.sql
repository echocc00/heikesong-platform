-- 001_init.sql — 初始表结构
-- 依据：设计文档 §5.2 + §7.1
-- ⛔ 不含评审/榜单相关表：那些在 P2/P3 阶段单独迁移，便于 expand-contract。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  mba_status    TEXT NOT NULL DEFAULT 'other',  -- mba | member | other
  org           TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,      -- 软删除：禁止硬删（§11 事后篡改）
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,        -- 只存 SHA-256，不存明文 token
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 能力点与角色映射
CREATE TABLE capabilities (
  key         TEXT PRIMARY KEY,       -- 如 score:write / team:manage
  description TEXT NOT NULL
);

CREATE TABLE roles (
  key         TEXT PRIMARY KEY,       -- admin / captain / member / judge / enterprise / observer
  description TEXT NOT NULL
);

CREATE TABLE role_capabilities (
  role_id      TEXT NOT NULL REFERENCES roles(key),
  capability   TEXT NOT NULL REFERENCES capabilities(key),
  PRIMARY KEY (role_id, capability)
);

-- 资源级授权（行级权限的载体）
CREATE TABLE assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  capability  TEXT NOT NULL REFERENCES capabilities(key),
  scope_type  TEXT NOT NULL,         -- global | edition | city | task_package | team | enterprise
  scope_id    TEXT,
  granted_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_assignments_lookup ON assignments(user_id, capability);

-- 用户与角色的多对多
-- 一人可以同时是选手 + 队长 + 评委（借 hackerspace3 assignment 模型的做法）
-- ⚠️ 本表并入 001_init.sql，不单独开 002 迁移：
--    迁移版本号是全局唯一序位，002 必须留给 P1 的 002_registration.sql。
--    两个迁移抢同一个版本号时，后执行的那张表永远建不出来。
--    ⚠️ 现在 applyMigrations 对重复版本号**直接抛错**（fail-fast），
--       不再是"按 version 静默去重"—— 静默跳过会把 schema 缺口固化，运维看不出来。
CREATE TABLE user_roles (
  user_id  TEXT NOT NULL REFERENCES users(id),
  role_key TEXT NOT NULL REFERENCES roles(key),
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_key);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

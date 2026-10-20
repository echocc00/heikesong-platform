-- 002_registration.sql — 报名与组队
-- 依据：INTERFACES.md §2「P1 产出」表清单（列名逐字对齐）
-- 依据：设计文档 §5.1（edition × city 维度）+ §5.2（registrations / teams / team_members）
-- 依据：R-OPS-09（首届只做一城，但模型必须带 edition × city 维度）
-- 依据：R-REG-01/02/03/04/05、R-ENT-01/06/07/08/09/10/11/12、R-STG-01/03
-- ⚠️ 迁移版本号是全局唯一序位：002 = P1，003 = P2 … 006 = P6。
--    P0 原建过 `002_user_roles.sql`，与本迁移抢同一个版本号 → 已修法：
--    user_roles 并入 P0 的 `001_init.sql`，P0 不再单独开迁移。
--    执行前先确认 platform/db/migrations/ 下无重复版本号。

CREATE TABLE editions (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  city       TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE cities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  edition_id TEXT NOT NULL REFERENCES editions(id)
);
CREATE INDEX idx_cities_edition ON cities(edition_id);

CREATE TABLE task_packages (
  id                  TEXT PRIMARY KEY,
  edition_id          TEXT NOT NULL REFERENCES editions(id),
  enterprise_id       TEXT,
  enterprise_name     TEXT,
  title               TEXT NOT NULL,
  pain_point          TEXT NOT NULL,
  expected_delivery   TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  grade               TEXT,
  status              TEXT NOT NULL DEFAULT 'submitted',
  solvability_score   REAL,
  solvability_grade   TEXT,
  commitment          TEXT,
  agreement           TEXT,
  is_free_brief       INTEGER NOT NULL DEFAULT 0,
  submitted_by        TEXT NOT NULL REFERENCES users(id),
  submitted_at        TEXT NOT NULL,
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  -- ⚠️ 契约外新增列：装合规同意记录 + 六维评估明细 + 诊断报告。见文末偏差 D-3
  meta_json           TEXT,
  deleted_at          TEXT
);
CREATE INDEX idx_task_packages_edition ON task_packages(edition_id);
CREATE INDEX idx_task_packages_status ON task_packages(status);

CREATE TABLE registrations (
  id                    TEXT PRIMARY KEY,
  edition_id            TEXT NOT NULL REFERENCES editions(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  answers_json          TEXT NOT NULL,
  dimension_scores_json TEXT,
  raw_score             REAL,
  level                 TEXT,
  level_final           TEXT,
  decided_by            TEXT REFERENCES users(id),
  decided_at            TEXT,
  decision_note         TEXT,
  status                TEXT NOT NULL DEFAULT 'submitted',
  created_at            TEXT NOT NULL,
  deleted_at            TEXT
);
-- 幂等守卫落在数据库层：同一 userId + editionId 只能有一条有效报名
-- （部分唯一索引：软删除后允许重报，硬删行则永久占用）
CREATE UNIQUE INDEX idx_registrations_user_edition
  ON registrations(user_id, edition_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_registrations_edition ON registrations(edition_id);
CREATE INDEX idx_registrations_status ON registrations(status);

CREATE TABLE registration_events (
  id             TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  actor_id       TEXT REFERENCES users(id),
  reason         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_registration_events_reg ON registration_events(registration_id);

CREATE TABLE teams (
  id              TEXT PRIMARY KEY,
  edition_id      TEXT NOT NULL REFERENCES editions(id),
  name            TEXT NOT NULL,
  captain_id      TEXT NOT NULL REFERENCES users(id),
  task_package_id TEXT REFERENCES task_packages(id),
  tier            TEXT,
  status          TEXT NOT NULL DEFAULT 'forming',
  -- ⚠️ 契约外新增列：报名时固定的里程碑清单快照（R-STG-03 防拆单刷里程碑）
  milestones_json TEXT,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_teams_edition ON teams(edition_id);
CREATE INDEX idx_teams_package ON teams(task_package_id);
CREATE INDEX idx_teams_captain ON teams(captain_id);

CREATE TABLE team_members (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL,   -- captain | member
  joined_at TEXT NOT NULL,
  left_at   TEXT
);
CREATE INDEX idx_team_members_team ON team_members(team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);
-- 一个人同时只能在一个战队（有效成员 = left_at IS NULL）
CREATE UNIQUE INDEX idx_team_members_active ON team_members(user_id) WHERE left_at IS NULL;

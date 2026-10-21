-- 006_pools.sql — 工作流与三池底座
-- 依据：INTERFACES.md §6（P5 产出）+ 设计文档 §5.4
-- 边界（三条，都写在表结构里，免得后来人忘了）：
--   ① 三池一期只做底座，不做前台页面（设计文档 §1.2 / §5.4）
--   ② 派生值不做冗余存储：pool_talents.total_points 只由 syncPoolTalents 的
--      单一计算点产出（src/domain/pool-derive.js），不手工维护、不增量累加
--   ③ 任务清单 ≠ 里程碑：workflow_tasks 与 milestones 不共享表、不共享规则
--      （同「两种企业签字必须分表」的同构纪律，设计文档 §5.3）

-- ── 工作流：任务包 → 工作流 → 任务清单（R-OPS-13）────────────────
CREATE TABLE workflows (
  id              TEXT PRIMARY KEY,
  edition_id      TEXT NOT NULL,
  task_package_id TEXT NOT NULL REFERENCES task_packages(id),
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_workflows_edition ON workflows(edition_id);
CREATE INDEX idx_workflows_package ON workflows(task_package_id);

CREATE TABLE workflow_tasks (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  title         TEXT NOT NULL,
  detail        TEXT,
  owner_team_id TEXT REFERENCES teams(id),
  status        TEXT NOT NULL DEFAULT 'todo',   -- todo | in_progress | done | blocked
  due_at        TEXT,
  created_at    TEXT NOT NULL,
  -- ⚠️ 契约里 workflow_tasks 只有 8 列；这 3 列是为了让「完成」这件事留痕
  --    （R-STG-04：提交内容为可运行状态或明确阻塞点）。见偏差章节 D-2。
  evidence_json TEXT,                           -- 完成证据（可运行产物链接+版本 / 明确阻塞点）
  completed_at  TEXT,
  completed_by  TEXT,
  CHECK (status IN ('todo', 'in_progress', 'done', 'blocked'))
);
CREATE INDEX idx_workflow_tasks_workflow ON workflow_tasks(workflow_id);
CREATE INDEX idx_workflow_tasks_team ON workflow_tasks(owner_team_id);

-- ── 领取记录：追加式（只增不改），"有效领取" = released_at IS NULL ──
CREATE TABLE task_claims (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES workflow_tasks(id),
  team_id     TEXT REFERENCES teams(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  claimed_at  TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX idx_task_claims_task ON task_claims(task_id);
CREATE INDEX idx_task_claims_user ON task_claims(user_id);
-- ⛔ 防重复领取：同一 task_id 同时只能有一个有效领取。
--    依据：设计文档 §6.4「一人一票必须由数据库保证。应用层的'先查再插'在并发下会插出两票」。
--    部分唯一索引：不新增 status 列（列清单与契约逐字一致），释放后旧行自动退出索引。
CREATE UNIQUE INDEX ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL;

-- ── 三池（R-POOL-01 / 02 / 03）：一期只有底座，没有前台 ─────────────
-- ⚠️ 三池三张表都带 edition_id（届期维度）：
--    依据：顶层文档 §3.1 S2（届期 × 城市多期租户维度）——"数据模型必须带 edition 维度，
--    否则复制到第 2 城时要改表结构，那就不是『平台统一』了"。
CREATE TABLE pool_projects (
  id             TEXT PRIMARY KEY,
  edition_id     TEXT NOT NULL,
  team_id        TEXT NOT NULL REFERENCES teams(id),
  title          TEXT NOT NULL,
  industry       TEXT,          -- 一期无行业字段来源 → 显式 NULL（不臆造，见偏差章节 D-7）
  stage_reached  TEXT,          -- stages.key（该队到达的最远赛段）
  tier           TEXT,          -- tier_records.tier（D/C/B/A/S）
  business_value REAL,          -- 企业业务部门签字数（商业事实代理；首届不验收入，R-ENT-05）
  summary        TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_pool_projects_edition_team ON pool_projects(edition_id, team_id);

CREATE TABLE pool_talents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  edition_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  org           TEXT,
  total_points  REAL NOT NULL DEFAULT 0,   -- ⛔ 只由 syncPoolTalents 的单一计算点写入，不手工维护
  mba_status    TEXT,
  stages_joined INTEGER NOT NULL DEFAULT 0,
  skills_json   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_pool_talents_edition_user ON pool_talents(edition_id, user_id);
CREATE INDEX idx_pool_talents_user ON pool_talents(user_id);

CREATE TABLE pool_resources (
  id             TEXT PRIMARY KEY,
  edition_id     TEXT NOT NULL,
  enterprise_id  TEXT NOT NULL,
  enterprise_name TEXT,
  kind           TEXT NOT NULL,   -- enterprise_brief | free_brief
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_pool_resources_edition_enterprise ON pool_resources(edition_id, enterprise_id, kind);

-- ── 公开访问令牌（公开榜单 / iCal 用，无需登录）────────────────────
CREATE TABLE public_tokens (
  token      TEXT PRIMARY KEY,   -- 存 SHA-256 十六进制（与 sessions.token_hash 同一纪律）
  scope      TEXT NOT NULL,      -- leaderboard | calendar | all
  edition_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_public_tokens_edition ON public_tokens(edition_id);

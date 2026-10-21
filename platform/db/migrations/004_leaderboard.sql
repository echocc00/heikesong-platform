-- 004_leaderboard.sql — 榜单与积分数据模型
-- 依据：INTERFACES.md §4（P3 产出）+ 设计文档 §5.2 / §5.3 / §6.4
--   ⛔ 追加式：points_ledger / behavior_events 只增不改（无 deleted_at、无 updated_at）。
--      理由：S7 §4.2「赛后 6 个月可查」——要能查，就必须不能被悄悄改掉（设计文档 §5.2 决策）。

-- ── 积分流水（只增不改）────────────────────────────────────────
CREATE TABLE points_ledger (
  id         TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES editions(id),
  stage_id   TEXT REFERENCES stages(id),
  team_id    TEXT REFERENCES teams(id),
  user_id    TEXT REFERENCES users(id),
  kind       TEXT NOT NULL,     -- stage_rank | mvp | roadshow | personal_rollup
  points     REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_points_ledger_edition ON points_ledger(edition_id);
CREATE INDEX idx_points_ledger_user    ON points_ledger(user_id);
CREATE INDEX idx_points_ledger_stage   ON points_ledger(stage_id);
CREATE INDEX idx_points_ledger_kind    ON points_ledger(kind);

-- ── 段位记录（软删除）──────────────────────────────────────────
CREATE TABLE tier_records (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL REFERENCES teams(id),
  tier                  TEXT NOT NULL,   -- D | C | B | A | S
  milestone_count       INTEGER NOT NULL,
  business_signoff_count INTEGER NOT NULL,
  reasons_json          TEXT NOT NULL,
  computed_at           TEXT NOT NULL,
  deleted_at            TEXT
);
CREATE INDEX idx_tier_records_team ON tier_records(team_id, computed_at DESC);

-- ── 行为分事件（★ 与总分完全独立的数据通路，只增不改）────────────
CREATE TABLE behavior_events (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  user_id    TEXT REFERENCES users(id),
  type       TEXT NOT NULL,     -- weekly_progress | workshop_output | milestone_on_time | enterprise_meeting | first_demo
  points     REAL NOT NULL,     -- 本次事件的分值快照（判定口径仍以 rules/behavior-points.json 为准）
  evidence   TEXT,              -- JSON 文本：{"repo":..,"version":..,"artifact":..,"blocker":..,"output":..}
  created_at TEXT NOT NULL
);
CREATE INDEX idx_behavior_events_team ON behavior_events(team_id);

-- ── 榜单快照（可复算的载体）─────────────────────────────────────
CREATE TABLE leaderboard_snapshots (
  id           TEXT PRIMARY KEY,
  edition_id   TEXT NOT NULL REFERENCES editions(id),
  stage_id     TEXT REFERENCES stages(id),
  scope        TEXT NOT NULL,   -- rank | business | personal | rolling
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_leaderboard_snapshots_edition ON leaderboard_snapshots(edition_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 补充表（设计文档 §5.2 定义，但 INTERFACES.md 的 004 清单未列出）
--   ⛔ P3 的段位与战绩卡依赖它们，故在本迁移中一并建表。详见文末偏差。
-- ═══════════════════════════════════════════════════════════════

-- ── 里程碑清单（★ 报名时固定，赛程中不可自行新增）──────────────
CREATE TABLE milestones (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL REFERENCES teams(id),
  stage_id          TEXT REFERENCES stages(id),
  key               TEXT NOT NULL,   -- 对应 rules/milestones.default.json 的 item key
  label             TEXT NOT NULL,
  counts_toward_tier INTEGER NOT NULL DEFAULT 1,
  fixed_at          TEXT NOT NULL,   -- R-PTS-10 防"拆单刷里程碑"
  requires_signoff  INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_milestones_team ON milestones(team_id);

-- ── 企业签字（★ 客观事实确认，不进总分）────────────────────────
-- ★ R-ENT-02「企业签字里程碑」：试点合同 / 业务迭代 N 轮 / 意向客户 M 家 /
--   确认收入 ¥X —— 均由企业签。⚠️ 本表与 enterprise_confirmations（P2 建）是
--   **两张不同的表**：这里签的是「这件事到底发生了没有」（客观事实，单签，不进总分），
--   那里记的是「企业觉得这个做得好不好」（主观评分，双签，进总分）。见设计文档 §5.3。
CREATE TABLE milestone_signoffs (
  id                TEXT PRIMARY KEY,
  milestone_id      TEXT NOT NULL REFERENCES milestones(id),
  enterprise_id     TEXT NOT NULL,
  signatory_user_id TEXT REFERENCES users(id),
  department        TEXT NOT NULL,   -- 业务部门 | 技术部门（★ S 档只认业务部门，R-PTS-03）
  content           TEXT NOT NULL,   -- R-JDG-14：必须写清解决哪个环节 / 落地时间 / 我方角色
  signed_at         TEXT NOT NULL,
  revoked_at        TEXT
);
CREATE INDEX idx_milestone_signoffs_milestone ON milestone_signoffs(milestone_id);

-- ── 赛段队伍名册（★ 赛段级队伍边界，P2 的 D-33 登记在 P3）────────
-- ⛔ 没有这张表时，「某队属于本赛段」只能按**届期**判定 → **同届期另一赛段的队**
--    也能被写进本赛段（评分 / 企业确认 / 行为分 / 里程碑签字都会记到一支
--    「没在这个赛段参赛」的队头上）→ 外队进榜。届期级判定挡不住这种情况
--    （同届期的队就是合法的），**只有赛段级名册能挡**。
-- ⚠️ 登记的**触发时机**（赛段开启时把该届参赛队登记进来）属 P5 的工作流；
--    本阶段提供「表 + 仓储 + 服务层接线」，不是一张没人写的死表。
CREATE TABLE stage_team (
  id            TEXT PRIMARY KEY,
  stage_id      TEXT NOT NULL REFERENCES stages(id),
  team_id       TEXT NOT NULL REFERENCES teams(id),
  registered_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_stage_team_unique ON stage_team(stage_id, team_id);
CREATE INDEX idx_stage_team_team ON stage_team(team_id);

-- ── 加时陈述（决赛同分才启用）──────────────────────────────────
-- ⛔ tiebreak_round / tiebreak_votes 由 **P2 的 003_review.sql** 建，本迁移【不得重复建表】。
--    重复 CREATE TABLE 会让迁移链在第二个文件直接报错中断（"table tiebreak_round already exists"），
--    后面的 005/006 全部不执行。P3 只【消费】这两张表跑破同分链。
--    表结构见 P2 计划 Task 7；本阶段若需加列，走 expand-contract（P4 迁移加列，不改这两张表）。

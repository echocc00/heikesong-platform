-- 003_review.sql — 评审引擎数据模型
-- 依据：设计文档 §5.2 / §12 + INTERFACES.md §3 + S7 §2.4（R1–R5）/ §3.4 / §4.2
-- ⛔ 与 INTERFACES.md 的差异（tiebreak_round / tiebreak_votes / conflict_declarations /
--    review_request_keys / content 列 / 幂等索引）见本计划文末「与接口契约的偏差」。
--
-- ⚠️ 外键（父代理预审修正，Important）：本迁移最初**只给一部分列加了外键**
--    （stage_judges.user_id 有、stage_reviews.judge_id 没有），同一类引用一处有一处没有 ——
--    评审数据可以指向**不存在的评委/队伍**（孤儿行），聚合时不会被发现；
--    而测试用假 id（'j1' / 't1' / 'ed1'）正好**掩盖**了这一点。
--    现在**补齐全部引用型外键**，与 P1 的 002_registration.sql 同一约定：
--      · edition_id → editions(id)（P1 的 editions/teams/cities/task_packages/registrations 全都有）
--      · judge_id / user_id / voter_id / created_by / enterprise_id → users(id)
--      · team_id / from_team_id / to_team_id → teams(id)
--    ⚠️ 代价：**所有测试夹具必须建真实的用户 / 届期 / 战队**（P1 的迁移测试就是这么做的），
--    不能再用 'j1' / 't1' / 'ed1' 这类假 id。
--    ⚠️ 作用域引用（stage_judges.scope_id / stage_reviews.request_id）是**多态/逻辑引用**，
--    不能建外键 —— 保持普通列 + 普通索引。

-- 赛段（一条赛段 = 一套权重表 + 一批评委）
CREATE TABLE stages (
  id                 TEXT PRIMARY KEY,
  edition_id         TEXT NOT NULL REFERENCES editions(id),
  "key"              TEXT NOT NULL,          -- 赛段代号，如 s1..s5
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL,          -- initial | final | roadshow | landing
  starts_at          TEXT NOT NULL,
  ends_at            TEXT NOT NULL,
  freeze_at          TEXT,                   -- 冻结时间：之后不再接受改分
  scoring_config_key TEXT NOT NULL,          -- initial | final → rules/scoring-*.json
  status             TEXT NOT NULL DEFAULT 'draft',   -- draft | open | frozen | computed
  UNIQUE (edition_id, "key")
);

-- 评委席（seat = judge 专家席 / enterprise 企业席 / observer 观察员【无投票权】）
-- 依据：S7 §3.4 评委池与席构成（R-JDG-11）
CREATE TABLE stage_judges (
  stage_id     TEXT NOT NULL REFERENCES stages(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  seat         TEXT NOT NULL,                -- judge | enterprise | observer
                                           --   ★ R-ENT-03 / R-JDG-11：企业席 ≥30%（有投票权）、
                                           --     专家席 ≤50%、其余 observer【无投票权】
                                           --     （observer 在 can() 里不给 score:write）
  scope_type   TEXT NOT NULL,                -- global | edition | task_package | team
  scope_id     TEXT,
  assigned_at  TEXT NOT NULL,
  conflict_declared_at TEXT,                 -- ★ R-JDG-18：评委须签署利益冲突声明
  conflict_declaration_id TEXT REFERENCES conflict_declarations(id),             --   指向 conflict_declarations.id
  -- ⚠️ 这是**前向引用**：被引用的 conflict_declarations 在本文件**后面**才建。
  --    SQLite 的外键父表是**惰性解析**的（建表时不校验，DML 时才查），
  --    所以顺序无害；但若将来把 conflict_declarations 移到别处，务必同步本行。
  PRIMARY KEY (stage_id, user_id)
);
CREATE INDEX idx_stage_judges_user ON stage_judges(user_id);

-- 利益冲突声明（R-JDG-18：评委须签署声明；初赛前公布评审组名单）
--   ⛔ 与 recusal_records 分开：声明是【事前签署】，回避是【个案动作】。
--   合在一起会导致"没签声明"和"这个队要回避"两种完全不同的状态混为一谈。
CREATE TABLE conflict_declarations (
  id            TEXT PRIMARY KEY,
  stage_id      TEXT NOT NULL REFERENCES stages(id),
  judge_id      TEXT NOT NULL REFERENCES users(id),
  declared_at   TEXT NOT NULL,
  has_conflict  INTEGER NOT NULL DEFAULT 0,   -- 0 = 无冲突，1 = 有（须逐案回避）
  statement     TEXT NOT NULL,                 -- 声明正文（可查：赛后 6 个月可查，R-JDG-17）
  signed_at     TEXT NOT NULL
);
CREATE INDEX idx_conflict_decl_judge ON conflict_declarations(stage_id, judge_id);

-- 评委打分（★ 主观评价）
-- UNIQUE(stage_id, judge_id, team_id, dimension) 防重复灌分
CREATE TABLE stage_reviews (
  id           TEXT PRIMARY KEY,
  stage_id     TEXT NOT NULL REFERENCES stages(id),
  judge_id     TEXT NOT NULL REFERENCES users(id),
  team_id      TEXT NOT NULL REFERENCES teams(id),
  dimension    TEXT NOT NULL,
  raw_score    REAL NOT NULL,                -- 0–100 原始分
  submitted_at TEXT NOT NULL,
  request_id   TEXT,                         -- 记录：这条记录由哪次请求写入（幂等键见 review_request_keys）
  calibrated   INTEGER NOT NULL DEFAULT 0,   -- 1 = 校准分，不计入评分（R-JDG-12）
  deleted_at   TEXT,
  UNIQUE (stage_id, judge_id, team_id, dimension)
);
CREATE INDEX idx_stage_reviews_request ON stage_reviews(stage_id, judge_id, request_id);
CREATE INDEX idx_stage_reviews_stage_team ON stage_reviews(stage_id, team_id);
CREATE INDEX idx_stage_reviews_judge ON stage_reviews(stage_id, judge_id);

-- 幂等键表（★ 一次请求 = 一个键，批次内多行共用同一个 request_id）
-- 为什么不能把 UNIQUE 直接加在 stage_reviews.request_id 上：
--   一次批量提交会写入多行，它们共用同一个 request_id —— 那样第二批就插不进去了。
--   正确做法是「先抢键再落数据」：键抢到 = 首次生效；键抢不到 = 重复请求，幂等短路。
-- 依据：设计文档 §11「幂等 + 行锁 + 只接受当前分配」；P4 的 idempotency_keys 是同一种模式。
CREATE TABLE review_request_keys (
  scope       TEXT NOT NULL,                 -- review | peer_review | self_review
  stage_id    TEXT NOT NULL REFERENCES stages(id),
  subject_id  TEXT NOT NULL,                 -- judge_id / from_team_id / team_id
  request_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope, stage_id, subject_id, request_id)
);

-- 校准打分（R-JDG-12：用同一组样例作品校准宽严尺度，结果【不计入评分】）
CREATE TABLE calibrations (
  id         TEXT PRIMARY KEY,
  stage_id   TEXT NOT NULL REFERENCES stages(id),
  judge_id   TEXT NOT NULL REFERENCES users(id),
  dimension  TEXT NOT NULL,
  raw_score  REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_calibrations_stage ON calibrations(stage_id, judge_id);

-- 企业确认（★ 主观评价，进总分；与 milestone_signoffs 客观事实签字【不是同一张表】）
-- 依据：S7 §4.1（R-JDG-14 签字必须有内容）/ §2.4 R2（双签）
CREATE TABLE enterprise_confirmations (
  id               TEXT PRIMARY KEY,
  stage_id         TEXT NOT NULL REFERENCES stages(id),
  team_id          TEXT NOT NULL REFERENCES teams(id),
  enterprise_id    TEXT NOT NULL REFERENCES users(id),
  dimension        TEXT NOT NULL,            -- 企业确认维度
  raw_score        REAL NOT NULL,
  cross_judge_id   TEXT REFERENCES users(id),  -- R2 双签之一：≥1 名跨领域评委签字
  signatory_user_id TEXT REFERENCES users(id), -- R2 双签之二：出题企业签字
  content          TEXT NOT NULL DEFAULT '', -- R-JDG-14：必填「解决哪个环节/落地时间/我方角色」
  created_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE UNIQUE INDEX idx_enterprise_confirmations_cell
  ON enterprise_confirmations(stage_id, team_id, dimension, enterprise_id) WHERE deleted_at IS NULL;

-- 互评（仅在破同分链中生效；R-RNK-07 资格由 checkPeerEligibility 把关）
CREATE TABLE peer_reviews (
  id           TEXT PRIMARY KEY,
  stage_id     TEXT NOT NULL REFERENCES stages(id),
  from_team_id TEXT NOT NULL REFERENCES teams(id),
  to_team_id   TEXT NOT NULL REFERENCES teams(id),
  score        REAL NOT NULL,
  request_id   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (stage_id, from_team_id, to_team_id)
);
CREATE INDEX idx_peer_reviews_request ON peer_reviews(stage_id, from_team_id, request_id);

-- 自评测（R-JDG-13：d = 自评分 − 评委分，只触发「说明」与「提问」，不加分）
CREATE TABLE self_reviews (
  id           TEXT PRIMARY KEY,
  stage_id     TEXT NOT NULL REFERENCES stages(id),
  team_id      TEXT NOT NULL REFERENCES teams(id),
  dimension    TEXT NOT NULL,
  raw_score    REAL NOT NULL,
  submitted_at TEXT NOT NULL,
  request_id   TEXT
);
CREATE UNIQUE INDEX idx_self_reviews_cell ON self_reviews(stage_id, team_id, dimension);
CREATE INDEX idx_self_reviews_request ON self_reviews(stage_id, team_id, request_id);

-- 评委×维度的增量统计（n / mean / sum_sq；stdev 由 sum_sq 现算）
-- 依据：设计文档 §6.2 Step 2【决策】mean/stdev 增量维护
CREATE TABLE score_stats (
  judge_id   TEXT NOT NULL REFERENCES users(id),
  dimension  TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  mean       REAL NOT NULL DEFAULT 0,
  sum_sq     REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (judge_id, dimension)
);

-- 回避记录（R-JDG-09：回避必须留档，S7 §4.2 赛后 6 个月可查）
CREATE TABLE recusal_records (
  id          TEXT PRIMARY KEY,
  stage_id    TEXT NOT NULL REFERENCES stages(id),
  judge_id    TEXT NOT NULL REFERENCES users(id),
  team_id     TEXT REFERENCES teams(id),                          -- NULL = 该赛段整体回避
  reason      TEXT NOT NULL,
  source      TEXT NOT NULL,                 -- declared 自报 | conflict 利益冲突 | audit 组委会
  declared_at TEXT NOT NULL,
  audit_by    TEXT REFERENCES users(id),
  action      TEXT NOT NULL                  -- recused 生效 | reinstated 撤销
);
CREATE INDEX idx_recusals_lookup ON recusal_records(stage_id, judge_id);

-- 计算快照（★ 可复算的载体：input + output + trace 三件套）
CREATE TABLE computation_snapshots (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                -- stage_score
  edition_id   TEXT REFERENCES editions(id),
  stage_id     TEXT REFERENCES stages(id),
  team_id      TEXT REFERENCES teams(id),
  rule_version TEXT NOT NULL,
  input_json   TEXT NOT NULL,
  output_json  TEXT NOT NULL,
  trace_json   TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1,   -- 同一赛段第几次重算
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_snapshots_stage ON computation_snapshots(stage_id, kind, revision);

-- 赛段结果（rank / tied_with / points 由 P3 的 rankTeams / stagePointsFor 填）
CREATE TABLE stage_results (
  id             TEXT PRIMARY KEY,
  stage_id       TEXT NOT NULL REFERENCES stages(id),
  team_id        TEXT NOT NULL REFERENCES teams(id),
  rank           INTEGER,
  total          REAL NOT NULL,
  seat_p         REAL NOT NULL,
  seat_e         REAL NOT NULL,
  tied_with      INTEGER,
  points         REAL,
  computation_id TEXT REFERENCES computation_snapshots(id),
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_stage_results_cell ON stage_results(stage_id, team_id);

-- 加时陈述轮次（S7 §3.3：决赛同分 → 10 分钟加时陈述 → 企业席+评委席共同复议）
CREATE TABLE tiebreak_round (
  id                  TEXT PRIMARY KEY,
  stage_id            TEXT NOT NULL REFERENCES stages(id),
  kind                TEXT NOT NULL DEFAULT 'statement',
  tied_team_ids_json  TEXT NOT NULL,
  statement_deadline  TEXT NOT NULL,
  vote_deadline       TEXT,
  status              TEXT NOT NULL DEFAULT 'open',   -- open | closed
  created_by          TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_tiebreak_rounds_stage ON tiebreak_round(stage_id, status);

-- 一票破同分的投票（★ 主键即「一人一票」）
-- 依据：设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束
--   ⛔ 不用应用层「先查再插」：并发下会插出两票
CREATE TABLE tiebreak_votes (
  tiebreak_round_id TEXT NOT NULL REFERENCES tiebreak_round(id),
  voter_id          TEXT NOT NULL REFERENCES users(id),
  team_id           TEXT NOT NULL REFERENCES teams(id),
  score             REAL NOT NULL,
  voted_at          TEXT NOT NULL,
  PRIMARY KEY (tiebreak_round_id, voter_id, team_id)
);

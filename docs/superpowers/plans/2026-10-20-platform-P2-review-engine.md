# P2 评审引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成全项目最重要的一段代码——**能真实算分、能留痕、能复算的评审引擎**：z-score 评委宽严归一化（4 策略可切换）、去极值、双席加权总分（初赛 `w_E=10%`，C-01 裁决）、企业席 R1/R2/R3/R4、自评差异检测、回避留档、互评资格、加时陈述一票破同分，并且**行为分在算法层面进不了总分**。

**Architecture:** 单进程 Node（仅标准库）。`src/domain/` 是**纯函数规则引擎**（无 IO、无 `Date.now()`、无 `Math.random()`），吃「配置 + 数据」，吐「结果 + trace」；`src/services/` 编排用例并落库；所有 SQL 收在 `src/db/repo/`；`src/http/routes/review.js` 挂 9 条评审 API。每次计算产出**三件套快照**（input + output + trace）写入 `computation_snapshots`，榜单可从原始数据重放（设计文档 §12 / S-1）。

**Tech Stack:** Node ≥22.5（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## Global Constraints

```
运行时      Node ≥ 22.5（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite。data/app.db，WAL 模式。单写者：禁止多 worker 写同一文件
测试        node:test。命令：node --test
密码        node:crypto scrypt，存储格式 scrypt$N$r$p$<salt_b64>$<hash_b64>，比对用 timingSafeEqual
会话        服务端 session 表，token 只存 SHA-256 哈希；Cookie HttpOnly + SameSite=Lax + Path=/
代码目录    platform/
规则配置    platform/rules/*.json，一切可变规则只改 JSON
配置校验    fail-fast：权重合计≠100% / 阈值不单调 / 段位门槛不递增 → 拒绝启动并报错
权限模型    capability + assignment；判定只有一个入口 can(user, capability, ctx)
三态状态码  列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403
SQL 边界    所有 SQL 收进 src/db/repo/；handler 内禁止裸 SQL
规则溯源    每条规则在代码注释里写明来源文档与章节
禁用清单    platform/scripts/forbidden.txt 不得为空

──────────── 本阶段（P2）追加 ────────────
z-score 口径 归一化的是【评委的宽严】，不是【队伍的分数】
            mean(i,d)=评委 i 在维度 d 上对【全部参赛队】打分的均值；z=(s−mean)/stdev
            ⛔ 禁止用 scipy.stats.zscore 的语义（那是「对给定轴做标准化」）
            样本 < minSamplesForJudgeNormalization → 退回全局口径，trace 必须标 fallbackReason
            stdev=0 → z=0 且记 warning
降级显式      任何 fallback / 归零 / 缺签 → 进 warnings + trace.normalization.fallbackReason
            ⛔ 绝不静默当 0（项目教训 5：静默的空产出比报错更危险）
分轨强制      scoreStage() 入参对象里【不存在】行为分字段；传入也必须被丢弃
            单元测试必须断言「行为分变化不影响总分」（S10 §8：分轨必须是算法层面的）
幂等          同一 request_id 重复提交只生效一次；一人一票用【数据库唯一约束】保证，
            ⛔ 不用应用层「先查再插」（并发下会插出两票）
纯函数        src/domain/* 无 IO、无 Date.now()、无 Math.random()；需要随机时传 rng 参数
可复算        同一输入必须产出同一输出（截尾策略的并列打散用确定性散列，不用随机数）
增量统计      score_stats 增量更新（n / mean / sum_sq）；stdev 由 sum_sq 现算
            ⛔ 但每次发榜仍做一次全量重算并落快照（可复算要求能从原始数据重放）
初赛 w_E      = 0.10（【冲突】C-01 裁决：只有 10% 能让权重表合计 100%）
            ⛔ 本阶段【不修改】rules/scoring-initial.json 的 wEnterprise，只引用它
```

## File Structure

**本阶段创建**

```
platform/
├── db/migrations/003_review.sql    评审数据模型（14 张表，含 tiebreak_round / tiebreak_votes / review_request_keys）
├── src/
│   ├── domain/
│   │   ├── normalization.js        评委宽严归一化引擎（zscore / median / trimmed / bayes）
│   │   ├── trim.js                 去极值（去一个最高一个最低）
│   │   ├── enterprise-seat.js      企业席 E + R1 / R2 / R3 / R4
│   │   ├── self-eval.js            自评测差异检测（±10 三区间）
│   │   ├── review-eligibility.js   互评资格 + 回避判定
│   │   ├── judge-pool.js           评委池下限与席构成校验（R-JDG-10 / R-JDG-11）
│   │   └── scoring.js              scoreStage 总装（纯函数）
│   ├── services/
│   │   ├── review.js               提交评分 / 校准 / 互评 / 自评 / 回避 / 进度
│   │   ├── compute.js              computeStage（写快照 + stage_results）
│   │   └── tiebreak.js             加时陈述轮次 + 一票破同分
│   ├── db/repo/
│   │   ├── stages.js               赛段与评委席
│   │   ├── reviews.js              stage_reviews + calibrations + score_stats（幂等 + 增量）
│   │   ├── request-keys.js         幂等键（先抢键再落数据）
│   │   ├── enterprise-confirmations.js  企业确认（R2 双签 / R-JDG-14 内容）
│   │   ├── peer-reviews.js         互评
│   │   ├── self-reviews.js         自评测
│   │   ├── recusals.js             回避记录
│   │   ├── computations.js         computation_snapshots + stage_results
│   │   └── tiebreak.js             tiebreak_round / tiebreak_votes
│   ├── http/routes/
│   │   └── review.js               9 条评审 API 路由
│   └── audit/log.js                审计日志写入（若 P0/P1 未建则本阶段建）
└── test/
    ├── migration-review.test.js    003 迁移与关键唯一约束
    ├── normalization.test.js       4 策略各自的预期值 + 降级分支
    ├── trim.test.js                去极值
    ├── enterprise-seat.test.js     R1 / R2 / R3 / R4
    ├── self-eval.test.js           d 的三个区间
    ├── review-eligibility.test.js  互评资格 + 回避
    ├── judge-pool.test.js          评委池下限与席构成
    ├── scoring.test.js             scoreStage 总装 + 行为分隔离断言
    ├── review-service.test.js      幂等 / 增量 score_stats / 进度
    ├── compute.test.js             快照三件套 + stage_results
    └── tiebreak.test.js            一票破同分（唯一约束）
```

**本阶段修改**

```
platform/rules/scoring-initial.json   加 judgePool 段（R-JDG-10 初赛 ≥7）+ freeBrief 段（R-JDG-08 R4）
platform/rules/scoring-final.json      加 judgePool 段（R-JDG-10 决赛 ≥9）+ freeBrief 段
platform/src/config.js                 校验 judgePool / freeBrief / 归一化策略参数（fail-fast）
platform/src/server.js                 注册评审路由（与 P1 的改动合并，不覆盖）
```

---

### Task 1: 评审数据模型与迁移 `003_review.sql`

**Files:**
- Create: `platform/db/migrations/003_review.sql`
- Create: `platform/test/migration-review.test.js`

**Interfaces:**
- Consumes: P0 `openDatabase()` / `applyMigrations()`；P1 `teams` / `task_packages`（本阶段只读，不建表）
- Produces:
  - 14 张表：`stages` / `stage_judges` / `stage_reviews` / `review_request_keys` / `calibrations` / `enterprise_confirmations` / `peer_reviews` / `self_reviews` / `score_stats` / `recusal_records` / `computation_snapshots` / `stage_results` / `tiebreak_round` / `tiebreak_votes`（其中 `tiebreak_round`、`tiebreak_votes`、`review_request_keys` 为新增，见文末偏差）
  - 关键唯一约束（**并发正确性的地基**）：
    - `stage_reviews` UNIQUE(stage_id, judge_id, team_id, dimension) —— 防重复灌分
    - `peer_reviews` UNIQUE(stage_id, from_team_id, to_team_id) —— 一队对另一队只投一次
    - `self_reviews` UNIQUE(stage_id, team_id, dimension) —— 同一维度只自评一次
    - `score_stats` PRIMARY KEY(judge_id, dimension)
    - `tiebreak_votes` PRIMARY KEY(tiebreak_round_id, voter_id, team_id) —— **一人一票由数据库保证**

- [ ] **Step 1: 写失败的测试**

`platform/test/migration-review.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  // 评审表的 stage_id 有外键，先建一个赛段
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES ('s1', 'ed1', 's1', '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  ).run();
  return { db, close, dataDir };
}

const TABLES = [
  'stages', 'stage_judges', 'stage_reviews', 'review_request_keys', 'calibrations',
  'enterprise_confirmations', 'peer_reviews', 'self_reviews', 'score_stats', 'recusal_records',
  'computation_snapshots', 'stage_results', 'tiebreak_round', 'tiebreak_votes',
];

test('003 迁移建出全部评审表', () => {
  const { db, close, dataDir } = setup();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), `缺表 ${t}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('stage_reviews 唯一约束防重复灌分', () => {
  const { db, close, dataDir } = setup();
  const ins = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', 'j1', 't1', 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1');
  assert.throws(() => ins.run('r2'), /UNIQUE|constraint/i, '同一 (赛段,评委,队伍,维度) 只能有一条');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('peer_reviews 唯一约束：一队对另一队只投一次', () => {
  const { db, close, dataDir } = setup();
  const ins = db.prepare(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
     VALUES (?, 's1', 't1', 't2', 70, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('p1');
  assert.throws(() => ins.run('p2'), /UNIQUE|constraint/i);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('score_stats 主键是 (judge_id, dimension)', () => {
  const { db, close, dataDir } = setup();
  const ins = db.prepare(
    `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
     VALUES (?, ?, 1, 80, 6400, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('j1', 'innovation');
  assert.throws(() => ins.run('j1', 'innovation'), /UNIQUE|constraint/i);
  ins.run('j1', 'feasibility'); // 不同维度可以并存
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('tiebreak_votes 主键保证一人一票（并发下插不出两票）', () => {
  const { db, close, dataDir } = setup();
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '["t1","t2"]', '2026-10-20T00:10:00.000Z', 'admin', '2026-10-20T00:00:00.000Z')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', 'u1', 't1', 80, '2026-10-20T00:05:00.000Z')`,
  );
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE|constraint/i, '同一 (轮次,投票人,队伍) 只能投一次');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等键表：同一 (scope,赛段,主体,request_id) 只能领一次', () => {
  const { db, close, dataDir } = setup();
  const ins = db.prepare(
    `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
     VALUES ('review', 's1', 'u1', 'req-1', '2026-10-20T00:00:00.000Z')`,
  );
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE|constraint/i);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('stage_results 的 rank / points 在 P2 阶段可空（名次由 P3 填）', () => {
  const { db, close, dataDir } = setup();
  const info = db.prepare("PRAGMA table_info(stage_results)").all();
  const rank = info.find((c) => c.name === 'rank');
  const points = info.find((c) => c.name === 'points');
  assert.equal(rank.notnull, 0);
  assert.equal(points.notnull, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/migration-review.test.js`
Expected: FAIL —— 缺表 `stages`（迁移 003 尚未创建）

- [ ] **Step 3: 创建 db/migrations/003_review.sql**

```sql
-- 003_review.sql — 评审引擎数据模型
-- 依据：设计文档 §5.2 / §12 + INTERFACES.md §3 + S7 §2.4（R1–R5）/ §3.4 / §4.2
-- ⛔ 与 INTERFACES.md 的差异（tiebreak_round / tiebreak_votes / content 列 / 幂等索引）
--    见本计划文末「与接口契约的偏差」。

-- 赛段（一条赛段 = 一套权重表 + 一批评委）
CREATE TABLE stages (
  id                 TEXT PRIMARY KEY,
  edition_id         TEXT NOT NULL,
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
  conflict_declaration_id TEXT,             --   指向 conflict_declarations.id
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
  judge_id     TEXT NOT NULL,
  team_id      TEXT NOT NULL,
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
  stage_id    TEXT NOT NULL,
  subject_id  TEXT NOT NULL,                 -- judge_id / from_team_id / team_id
  request_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope, stage_id, subject_id, request_id)
);

-- 校准打分（R-JDG-12：用同一组样例作品校准宽严尺度，结果【不计入评分】）
CREATE TABLE calibrations (
  id         TEXT PRIMARY KEY,
  stage_id   TEXT NOT NULL REFERENCES stages(id),
  judge_id   TEXT NOT NULL,
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
  team_id          TEXT NOT NULL,
  enterprise_id    TEXT NOT NULL,
  dimension        TEXT NOT NULL,            -- 企业确认维度
  raw_score        REAL NOT NULL,
  cross_judge_id   TEXT,                     -- R2 双签之一：≥1 名跨领域评委签字
  signatory_user_id TEXT,                    -- R2 双签之二：出题企业签字
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
  from_team_id TEXT NOT NULL,
  to_team_id   TEXT NOT NULL,
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
  team_id      TEXT NOT NULL,
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
  judge_id   TEXT NOT NULL,
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
  judge_id    TEXT NOT NULL,
  team_id     TEXT,                          -- NULL = 该赛段整体回避
  reason      TEXT NOT NULL,
  source      TEXT NOT NULL,                 -- declared 自报 | conflict 利益冲突 | audit 组委会
  declared_at TEXT NOT NULL,
  audit_by    TEXT,
  action      TEXT NOT NULL                  -- recused 生效 | reinstated 撤销
);
CREATE INDEX idx_recusals_lookup ON recusal_records(stage_id, judge_id);

-- 计算快照（★ 可复算的载体：input + output + trace 三件套）
CREATE TABLE computation_snapshots (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                -- stage_score
  edition_id   TEXT,
  stage_id     TEXT,
  team_id      TEXT,
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
  team_id        TEXT NOT NULL,
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
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_tiebreak_rounds_stage ON tiebreak_round(stage_id, status);

-- 一票破同分的投票（★ 主键即「一人一票」）
-- 依据：设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束
--   ⛔ 不用应用层「先查再插」：并发下会插出两票
CREATE TABLE tiebreak_votes (
  tiebreak_round_id TEXT NOT NULL REFERENCES tiebreak_round(id),
  voter_id          TEXT NOT NULL,
  team_id           TEXT NOT NULL,
  score             REAL NOT NULL,
  voted_at          TEXT NOT NULL,
  PRIMARY KEY (tiebreak_round_id, voter_id, team_id)
);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/migration-review.test.js`
Expected: PASS（7 个测试全过）

- [ ] **Step 5: 实跑迁移脚本**

Run: `cd platform && node scripts/migrate.js`
Expected: 输出 `迁移完成，当前版本 3`

- [ ] **Step 6: 提交**

```bash
cd platform && git add db/migrations/003_review.sql test/migration-review.test.js
git commit -m "feat(P2): 评审数据模型与迁移 003（13 表 + 关键唯一约束）"
```

---

### Task 2: 归一化引擎（4 策略可切换）

**Files:**
- Create: `platform/src/domain/normalization.js`
- Create: `platform/test/normalization.test.js`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `normalizeScores({ samples, strategy, config })` → `{ normalized, values, fallbackReason, stats, judgeStats }`
  - `NORMALIZATION_STRATEGIES` = `['zscore', 'median', 'trimmed', 'bayes']`
  - `samples` 元素：`{ judgeId, value, series }`——`value` 是该评委对**当前 (队伍, 维度) 单元**的原始分；`series` 是该评委在本维度上对**全部参赛队**的原始分序列（样本数 n_i 的来源）
  - `stats` = 全局口径统计 `{ n, mean, stdev }`（n = 该维度全部 (评委, 队伍) 原始分个数）
  - `judgeStats[judgeId]` = `{ n, mean, stdev, center, scale, normalized, fallbackReason }`

- [ ] **Step 1: 写失败的测试**

`platform/test/normalization.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScores, NORMALIZATION_STRATEGIES } from '../src/domain/normalization.js';

const CFG = {
  minSamplesForJudgeNormalization: 5,
  fallback: 'global',
  trimmedIterations: 20,
  bayesPriorStrength: 5,
};

// 数据集 A：经典 5 队 2 评委，样本数恰好 = 5（阈值边界，≥5 即走归一化）
const A1 = [80, 90, 70, 100, 60];
const A2 = [60, 60, 60, 80, 40];
const cfgA = { ...CFG };

// 数据集 S：6 队 2 评委，用来同时验证 4 种策略的【我们的预期值】
const S1 = [10, 20, 30, 31, 32, 200];
const S2 = [60, 65, 70, 70, 70, 70];

function callS(strategy) {
  return normalizeScores({
    samples: [
      { judgeId: 'j1', value: 10, series: S1 },
      { judgeId: 'j2', value: 60, series: S2 },
    ],
    strategy,
    config: CFG,
  });
}

test('策略清单就是约定的 4 个', () => {
  assert.deepEqual([...NORMALIZATION_STRATEGIES], ['zscore', 'median', 'trimmed', 'bayes']);
});

test('zscore：已知评委矩阵 → 期望 z 值（样本数 = 5 恰好达标）', () => {
  const r = normalizeScores({
    samples: [
      { judgeId: 'j1', value: 100, series: A1 },
      { judgeId: 'j2', value: 80, series: A2 },
    ],
    strategy: 'zscore',
    config: cfgA,
  });
  // j1: mean=80, stdev=sqrt(250)=15.811388 → z=(100-80)/15.811388
  // j2: mean=60, stdev=sqrt(200)=14.142136 → z=(80-60)/14.142136
  assert.ok(Math.abs(r.values.j1 - 1.264911064) < 1e-9, `j1 z=${r.values.j1}`);
  assert.ok(Math.abs(r.values.j2 - 1.414213562) < 1e-9, `j2 z=${r.values.j2}`);
  assert.equal(r.normalized, true);
  assert.equal(r.fallbackReason, null);
  assert.equal(r.stats.n, 10);
  assert.ok(Math.abs(r.stats.mean - 70) < 1e-9);
  assert.ok(Math.abs(r.stats.stdev - 17.638342074) < 1e-9);
  assert.equal(r.judgeStats.j1.n, 5);
  assert.ok(Math.abs(r.judgeStats.j1.mean - 80) < 1e-9);
  assert.ok(Math.abs(r.judgeStats.j1.stdev - 15.811388301) < 1e-9);
});

test('zscore：样本数 < 5 → 退回全局口径，normalized=false 且必须带 fallbackReason', () => {
  const r = normalizeScores({
    samples: [
      { judgeId: 'j1', value: 80, series: A1 },
      { judgeId: 'j2', value: 60, series: A2 },
      { judgeId: 'j3', value: 50, series: [50, 60, 55] }, // n=3 < 5
    ],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'judge_sample_too_small');
  assert.equal(r.judgeStats.j3.fallbackReason, 'judge_sample_too_small');
  // 退回全局口径：z = (s − 全局均值) / 全局标准差
  assert.ok(Math.abs(r.stats.mean - 66.538461538) < 1e-9);
  assert.ok(Math.abs(r.stats.stdev - 16.756169931) < 1e-9);
  assert.ok(Math.abs(r.values.j3 - (50 - r.stats.mean) / r.stats.stdev) < 1e-12);
  // 样本足够的评委不受影响
  assert.ok(Math.abs(r.values.j1 - 0) < 1e-12);
});

test('stdev = 0 → z 记 0 且 fallbackReason = zero_stdev', () => {
  const r = normalizeScores({
    samples: [
      { judgeId: 'j1', value: 80, series: A1 },
      { judgeId: 'j2', value: 60, series: A2 },
      { judgeId: 'j4', value: 50, series: [50, 50, 50, 50, 50] },
    ],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.equal(r.values.j4, 0);
  assert.equal(r.judgeStats.j4.fallbackReason, 'zero_stdev');
  assert.equal(r.fallbackReason, 'zero_stdev');
  assert.equal(r.normalized, false);
});

test('median 策略（ORA 思路，独立实现）→ 我们的预期值', () => {
  const r = callS('median');
  // j1: median=30.5, MAD=6 → scale=1.4826*6=8.8956 → z=(10-30.5)/8.8956
  assert.ok(Math.abs(r.values.j1 - -2.304510095) < 1e-9, `j1=${r.values.j1}`);
  // j2: median=70, MAD=0 → scale 退回 stdev=4.183300133 → z=(60-70)/4.183300133
  assert.ok(Math.abs(r.values.j2 - -2.390457219) < 1e-9, `j2=${r.values.j2}`);
  assert.equal(r.normalized, true);
});

test('trimmed 策略（Hangar 截尾思路，确定性实现）→ 我们的预期值', () => {
  const r = callS('trimmed');
  // j1: 截尾中心 = 中间 3 个 (20,30,31) 的均值 = 28.25（20 轮截尾平均）→ z=(10-28.25)/72.106634
  assert.ok(Math.abs(r.values.j1 - -0.253097378) < 1e-9, `j1=${r.values.j1}`);
  // j2: 截尾中心 = 68.75 → z=(60-68.75)/4.183300133
  assert.ok(Math.abs(r.values.j2 - -2.091650066) < 1e-9, `j2=${r.values.j2}`);
  assert.equal(r.normalized, true);
});

test('bayes 策略（crowd_bt.py 的评委偏差层次估计思路）→ 我们的预期值', () => {
  const r = callS('bayes');
  // j1: w=6/11 → center=56.939393939, scale=62.745816319 → z=(10-56.939393939)/62.745816319
  assert.ok(Math.abs(r.values.j1 - -0.748088027) < 1e-9, `j1=${r.values.j1}`);
  // j2: center=64.393939394, scale=33.325136733 → z=(60-64.393939394)/33.325136733
  assert.ok(Math.abs(r.values.j2 - -0.131850604) < 1e-9, `j2=${r.values.j2}`);
  assert.equal(r.normalized, true);
});

test('4 种策略产出【不同】的结果（证明确实可切换，不是同一个函数换名字）', () => {
  const zs = ['zscore', 'median', 'trimmed', 'bayes'].map((s) => callS(s).values.j1);
  assert.equal(new Set(zs.map((z) => z.toFixed(9))).size, 4);
});

test('未知策略不抛错但显式降级（绝不静默）', () => {
  const r = normalizeScores({ samples: [{ judgeId: 'j1', value: 1, series: A1 }], strategy: 'nope', config: cfgA });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'unknown_strategy');
  assert.deepEqual(r.values, {});
});

test('空样本显式返回降级，不返回空成功', () => {
  const r = normalizeScores({ samples: [], strategy: 'zscore', config: cfgA });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'empty_samples');
  assert.equal(r.stats.n, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/normalization.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/normalization.js'`

- [ ] **Step 3: 创建 src/domain/normalization.js**

```javascript
// src/domain/normalization.js — 评委宽严归一化引擎（4 策略可切换）
//
// 依据：S7 §3.1（z-score 口径）+ 设计文档 §6.2 Step 2 + 冲突裁决 C-05。
//   需求：R-JDG-02（评委宽严 z-score 归一化）｜R-JDG-01（初赛/决赛两套权重表里的归一化参数）
//
// ⚠️⚠️ 口径警告（本文件最容易做错的一处，务必读完再改）：
//   归一化的是【评委的宽严】，不是【队伍的分数】。
//     mean(i,d)  = 评委 i 在维度 d 上、对【全部参赛队】给出的原始分的均值
//     stdev(i,d) = 同上标准差
//     z[i][d]    = (s[i][d] − mean(i,d)) / stdev(i,d)
//   例：评委 A 一贯给 85、评委 B 一贯给 70，差异不代表项目更差，只代表 B 更严格。
//   直接加权相加，榜单实际是「谁遇到了宽松的评委」（S7 §2.1 机制归因）。
//
// ⛔ 绝对不要用 scipy.stats.zscore 的语义：那是「对给定轴做标准化」（把一组数标准化到
//    均值 0、标准差 1），我们的是「对每个评委的宽严做标准化」。两者数学形式相似、口径不同。
//    设计文档 §3.5「不借鉴 scipy / numpy」与 §6.2 Step 2 的警告框都写了这一点。
//
// 【为什么是 4 策略而不是写死 z-score】
//   S7 §7 自陈「归一化算法……在本赛事场景下的效果未验证」。写死则首届后发现不合适
//   就要重写聚合层。做成配置项后，换策略 = 改一份 JSON（设计文档 §3.7【决策】）。
//
// 【纯函数】无 IO、无 Date.now()、无 Math.random()：
//   trimmed 策略的「多轮截尾」用确定性散列做并列打散，保证同输入同输出（可复算要求）。

// MAD → 标准差的一致估计系数（正态分布下 MAD 的 1/0.6745 ≈ 1.4826）
const MAD_TO_SIGMA = 1.4826;

export const NORMALIZATION_STRATEGIES = Object.freeze(['zscore', 'median', 'trimmed', 'bayes']);

// 降级原因取值（trace.normalization.fallbackReason）
export const FALLBACK_REASONS = Object.freeze({
  SAMPLE_TOO_SMALL: 'judge_sample_too_small', // 样本数不足 → 退回全局口径
  ZERO_STDEV: 'zero_stdev',                   // 标准差为 0 → z 记 0
  RAW_FALLBACK: 'raw_fallback',               // 配置要求直接用原始分
  UNKNOWN_STRATEGY: 'unknown_strategy',
  EMPTY_SAMPLES: 'empty_samples',
});

function arithmeticMean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** 样本标准差（分母 n−1）。n < 2 时返回 0。 */
function sampleStdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = arithmeticMean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (n - 1));
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function medianAbsoluteDeviation(values, center) {
  return medianOf(values.map((v) => Math.abs(v - center)));
}

/** FNV-1a 32 位散列：用于「截尾」时的确定性并列打散。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 截尾均值中心估计（Hangar 思路：多轮「去一个最高 + 去一个最低」再取均值）。
 * ⛔ 不用 Math.random：每一轮用「值 + 轮次 + 下标」的确定性散列做并列打散，
 *    保证同输入同输出——否则「可复算」（设计文档 S-1）就不成立。
 */
function trimmedCenter(values, iterations) {
  if (values.length <= 2) return arithmeticMean(values);
  let acc = 0;
  for (let k = 0; k < iterations; k += 1) {
    const ordered = values
      .map((value, index) => ({ value, index, tie: fnv1a(`${k}:${index}:${value}`) }))
      .sort((a, b) => a.value - b.value || a.tie - b.tie);
    const kept = ordered.slice(1, ordered.length - 1).map((x) => x.value);
    acc += arithmeticMean(kept);
  }
  return acc / iterations;
}

/**
 * 评委宽严归一化。
 *
 * @param {object} input
 * @param {Array<{judgeId:string, value:number|null, series:number[]}>} input.samples
 *   同一个 (队伍, 维度) 单元内的样本。**一个单元内 judgeId 必须唯一**。
 *   `series` = 该评委在本维度上对【全部参赛队】的原始分序列（n_i 的来源）。
 * @param {'zscore'|'median'|'trimmed'|'bayes'} input.strategy
 * @param {object} input.config 规则配置（minSamplesForJudgeNormalization 等）
 * @returns {{normalized:boolean, values:Object<string,number>, fallbackReason:string|null,
 *            stats:{n:number,mean:number,stdev:number}, judgeStats:Object}}
 */
export function normalizeScores({ samples, strategy = 'zscore', config = {} } = {}) {
  const minSamples = Number(config.minSamplesForJudgeNormalization ?? 5);
  const fallbackMode = config.fallback ?? 'global';
  const iterations = Number(config.trimmedIterations ?? 20);
  const priorStrength = Number(config.bayesPriorStrength ?? 5);

  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.EMPTY_SAMPLES,
      stats: { n: 0, mean: 0, stdev: 0 },
      judgeStats: {},
    };
  }
  if (!NORMALIZATION_STRATEGIES.includes(strategy)) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.UNKNOWN_STRATEGY,
      stats: { n: 0, mean: 0, stdev: 0 },
      judgeStats: {},
    };
  }

  // ── 1) 每个评委的 series（本维度上对全部参赛队的原始分） ──────────────
  const seriesByJudge = new Map();
  for (const sample of list) {
    if (!Array.isArray(sample.series) || !sample.series.length) continue;
    if (seriesByJudge.has(sample.judgeId)) continue; // 同一评委只取一份
    seriesByJudge.set(sample.judgeId, sample.series.filter((v) => Number.isFinite(v)));
  }

  // ── 2) 全局口径统计（该维度全部 (评委, 队伍) 原始分） ────────────────
  const globalPool = [];
  for (const series of seriesByJudge.values()) globalPool.push(...series);
  const globalMean = arithmeticMean(globalPool);
  const globalStdev = sampleStdev(globalPool);

  // ── 3) 逐评委统计与策略口径 ───────────────────────────────────────────
  const judgeStats = {};
  for (const [judgeId, series] of seriesByJudge) {
    judgeStats[judgeId] = {
      n: series.length,
      mean: arithmeticMean(series),
      stdev: sampleStdev(series),
      center: arithmeticMean(series),
      scale: sampleStdev(series),
      normalized: true,
      fallbackReason: null,
    };
  }

  for (const [judgeId, stat] of Object.entries(judgeStats)) {
    const series = seriesByJudge.get(judgeId);
    if (strategy === 'median') {
      // ORA 思路（只读，独立实现）：中心取中位数，尺度取 1.4826×MAD
      const center = medianOf(series);
      let scale = MAD_TO_SIGMA * medianAbsoluteDeviation(series, center);
      if (scale === 0) scale = stat.stdev; // MAD 为 0（如过半同分）→ 退回标准差
      stat.center = center;
      stat.scale = scale;
    } else if (strategy === 'trimmed') {
      // Hangar 思路：多轮截尾均值做中心估计，尺度仍用标准差（便于与 zscore 横向比较）
      stat.center = trimmedCenter(series, iterations);
      stat.scale = stat.stdev;
    } else if (strategy === 'bayes') {
      // 借鉴 hack-the-back app/services/crowd_bt.py（MIT）的「评委偏差层次估计」思路：
      // 用经验贝叶斯收缩替代完整 BT 层次模型（零依赖、无 MCMC）。
      // w = n/(n+k)：样本越少，越向全局均值收缩。
      const w = stat.n / (stat.n + priorStrength);
      stat.center = w * stat.mean + (1 - w) * globalMean;
      stat.scale = Math.sqrt(w * stat.stdev ** 2 + (1 - w) * globalStdev ** 2);
    }
    // zscore（默认，S7 原文）：center = mean，scale = stdev
  }

  // ── 4) 降级判定（必须显式，绝不静默） ─────────────────────────────────
  for (const stat of Object.values(judgeStats)) {
    if (stat.n < minSamples) {
      // 样本不足 → 退回全局口径（S7 §3.1 + C-05 第 1 条）
      // 数值上：center=全局均值、scale=全局标准差 ⇒ 映射回原始单位后等于原始分
      stat.normalized = false;
      stat.fallbackReason =
        fallbackMode === 'raw' ? FALLBACK_REASONS.RAW_FALLBACK : FALLBACK_REASONS.SAMPLE_TOO_SMALL;
      stat.center = globalMean;
      stat.scale = globalStdev;
    }
    if (stat.scale === 0) {
      // 该评委该维度无区分度 → z 记 0（S7 §3.1 + 设计文档 §6.2 Step 2）
      stat.normalized = false;
      stat.fallbackReason = stat.fallbackReason ?? FALLBACK_REASONS.ZERO_STDEV;
    }
  }

  // ── 5) 逐评委产出 z 值 ───────────────────────────────────────────────
  const values = {};
  for (const sample of list) {
    if (!Number.isFinite(sample.value)) continue;
    const stat = judgeStats[sample.judgeId];
    if (!stat) continue;
    values[sample.judgeId] = stat.scale > 0 ? (sample.value - stat.center) / stat.scale : 0;
  }

  const judgeIds = Object.keys(judgeStats).sort();
  return {
    normalized: judgeIds.length > 0 && judgeIds.every((id) => judgeStats[id].normalized),
    values,
    fallbackReason: judgeIds.map((id) => judgeStats[id].fallbackReason).find(Boolean) ?? null,
    stats: { n: globalPool.length, mean: globalMean, stdev: globalStdev },
    judgeStats,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/normalization.test.js`
Expected: PASS（10 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/normalization.js test/normalization.test.js
git commit -m "feat(P2): 评委宽严归一化引擎（zscore/median/trimmed/bayes 4 策略 + 显式降级）"
```

---

### Task 3: 去极值 + 评委席得分 P

**Files:**
- Create: `platform/src/domain/trim.js`
- Create: `platform/test/trim.test.js`

**Interfaces:**
- Consumes: Task 2 的 `normalizeScores`（Task 8 组装时调用）
- Produces:
  - `trimOutliers({ values, minJudges })` → `{ mean, trimmed, removed: { max, min } }`
    - `values` = `[{ judgeId, z }]`（同一 (队伍, 维度) 单元内，全部评委的 z 值）
    - 有效评委数 < `minJudges` → **不去极值**（`trimmed: false`，`removed` 全 null）
    - 并列时按 `judgeId` 字典序确定性打破（保证可复算）
  - `seatScore({ dimensionScores, weights })` → `{ score, weightSum, missing }`
    - 席位加权分（0–100）：`score = Σ(w·s) / Σw`；`Σw = 0` → `score = 0` 且 `missing` 列出全部维度
    - 评委席代入即得 **P**（评委席得分）；企业席代入即得 **E**

- [ ] **Step 1: 写失败的测试**

`platform/test/trim.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimOutliers, seatScore } from '../src/domain/trim.js';

test('去极值：去掉一个最高一个最低后取均值', () => {
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 3 },
      { judgeId: 'j4', z: 4 },
      { judgeId: 'j5', z: 5 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, true);
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.removed.min, 'j1');
  assert.equal(r.mean, 3); // (2+3+4)/3
});

test('有效评委数 < minJudges → 不去极值', () => {
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 100 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, false);
  assert.deepEqual(r.removed, { max: null, min: null });
  assert.ok(Math.abs(r.mean - 103 / 3) < 1e-12);
});

test('并列时按 judgeId 确定性打破（可复算）', () => {
  const r = trimOutliers({
    values: [
      { judgeId: 'j3', z: 0 },
      { judgeId: 'j1', z: 0 },
      { judgeId: 'j2', z: 0 },
      { judgeId: 'j4', z: 0 },
      { judgeId: 'j5', z: 0 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, true);
  assert.equal(r.removed.min, 'j1');
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.mean, 0);
});

test('空值与非法 z 被忽略，不静默当 0', () => {
  const r = trimOutliers({ values: [], minJudges: 5 });
  assert.equal(r.mean, 0);
  assert.equal(r.trimmed, false);
  assert.deepEqual(r.removed, { max: null, min: null });
});

test('评委席得分 P：维度加权的 0–100 分', () => {
  const r = seatScore({
    dimensionScores: { track_fit: 70, innovation: 80, feasibility: 65 },
    weights: { track_fit: 0.1, innovation: 0.2, feasibility: 0.2 },
  });
  // (0.1*70 + 0.2*80 + 0.2*65) / 0.5 = (7+16+13)/0.5 = 72
  assert.ok(Math.abs(r.score - 72) < 1e-12);
  assert.ok(Math.abs(r.weightSum - 0.5) < 1e-12);
  assert.deepEqual(r.missing, []);
});

test('某维度无人打分 → 权重不计入该维度分母，且必须被列进 missing', () => {
  const r = seatScore({
    dimensionScores: { innovation: 80 },
    weights: { innovation: 0.2, completeness: 0.25 },
  });
  assert.ok(Math.abs(r.score - 80) < 1e-12);
  assert.deepEqual(r.missing, ['completeness']);
});

test('权重合计为 0 → 该席位无权重，分数记 0（调用方必须记 warning）', () => {
  const r = seatScore({
    dimensionScores: { innovation: 80 },
    weights: { innovation: 0 },
  });
  assert.equal(r.score, 0);
  assert.equal(r.weightSum, 0);
  // 该维度有分（只是权重为 0），因此不算「缺分」
  assert.deepEqual(r.missing, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/trim.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/trim.js'`

- [ ] **Step 3: 创建 src/domain/trim.js**

```javascript
// src/domain/trim.js — 去极值 + 席位加权分
//
// 依据：S7 §3.2（去极值：同维度去掉一个最高一个最低再取均值；要求该维度评委数 ≥5）
//       + 设计文档 §6.2 Step 3 / Step 4。
//   需求：R-JDG-03（去极值）｜R-JDG-04（双席加权总分 P 的公共原语）
//
// ⚠️ 关于「评委席得分 P」的尺度（重要，别照抄 S7 字面）：
//   S7 §3.1 字面写的是 P = Σ_d (weight_d × mean_over_j(z[j][d]))，单位是 z。
//   但企业席分 E 是 0–100 原始分，z 单位与 0–100 不可通约，公式 (1−w_E)×P + w_E×E
//   在 z 单位下没有意义。本计划的口径：
//     ① 先按 S7 §3.1 对【评委的宽严】做 z 归一化；
//     ② 去极值得到该 (队伍, 维度) 的 z 均值；
//     ③ 用「全局均值 + z均值 × 全局标准差」把 z 还原回 0–100 尺度；
//        （等价于「先做宽严校正，再按维度加权」；当评委完全同质时该式退化为原始分均值）
//     ④ 再按维度权重加权得 P。
//   该口径在 scoring.js 中实现，本模块只提供两个纯函数原语。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

/**
 * 去极值。
 * @param {object} input
 * @param {Array<{judgeId:string, z:number}>} input.values 同一 (队伍, 维度) 单元内全部评委的 z
 * @param {number} input.minJudges 有效评委数下限；不足则不去极值
 * @returns {{mean:number, trimmed:boolean, removed:{max:string|null, min:string|null}}}
 */
export function trimOutliers({ values, minJudges } = {}) {
  const list = (Array.isArray(values) ? values : []).filter(
    (v) => v && Number.isFinite(v.z),
  );

  if (!list.length) {
    return { mean: 0, trimmed: false, removed: { max: null, min: null } };
  }

  const total = list.reduce((acc, v) => acc + v.z, 0) / list.length;
  if (list.length < minJudges) {
    // 有效评委数不足 → 不去极值（S7 §3.2）
    return { mean: total, trimmed: false, removed: { max: null, min: null } };
  }

  // 并列时按 judgeId 字典序确定性打破 —— 否则同分场景的 trace 不可复算
  const sorted = [...list].sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z;
    if (a.judgeId === b.judgeId) return 0;
    return a.judgeId < b.judgeId ? -1 : 1;
  });

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const kept = sorted.slice(1, sorted.length - 1);

  if (!kept.length) {
    // 防御：minJudges 被配成 1 或 2 时会退化为空集，此时不去极值
    return { mean: total, trimmed: false, removed: { max: null, min: null } };
  }

  const mean = kept.reduce((acc, v) => acc + v.z, 0) / kept.length;
  return { mean, trimmed: true, removed: { max: max.judgeId, min: min.judgeId } };
}

/**
 * 席位加权分（0–100）。
 * @param {object} input
 * @param {Object<string, number>} input.dimensionScores 该队各维度的最终分
 * @param {Object<string, number>} input.weights 各维度的生效权重
 * @returns {{score:number, weightSum:number, missing:string[]}}
 *   missing = 有权重但没有分数的维度（调用方必须把它变成 warning，⛔ 不静默当 0）
 */
export function seatScore({ dimensionScores, weights } = {}) {
  const scores = dimensionScores ?? {};
  const w = weights ?? {};
  let weighted = 0;
  let weightSum = 0;
  const missing = [];

  for (const key of Object.keys(w).sort()) {
    const weight = w[key];
    const score = scores[key];
    if (!Number.isFinite(score)) {
      missing.push(key);
      continue;
    }
    weighted += weight * score;
    weightSum += weight;
  }

  if (weightSum === 0) {
    return { score: 0, weightSum: 0, missing };
  }
  return { score: weighted / weightSum, weightSum, missing };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/trim.test.js`
Expected: PASS（7 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/trim.js test/trim.test.js
git commit -m "feat(P2): 去极值与席位加权分（评委席 P / 企业席 E 的公共原语）"
```

---

### Task 4: 企业席 E 与 R1 / R2 / R3 / R4

**Files:**
- Create: `platform/src/domain/enterprise-seat.js`
- Create: `platform/test/enterprise-seat.test.js`

**Interfaces:**
- Consumes: `rules/scoring-*.json` 的 `wEnterprise` / `dimensions` / `freeBrief.judgeDimension`
- Produces:
  - `applyEnterpriseRules({ confirmations, teams, judges, config })` → `{ seatE, weights, warnings, r4Substitute }`
  - `confirmations` 元素：`{ teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content }`
  - `teams` 元素：`{ teamId, packageEnterpriseId, isFreeBrief }`
  - `seatE[teamId]` = 企业席分（0–100）；R4 生效时为 `null`（由评委的「需求真实性」分替代，由 `r4Substitute` 指明替代维度）
  - `weights[teamId]` = 该队**生效的维度权重**（R1/R4 调整后）
  - `r4Substitute[teamId]` = `{ dimension }`（R4：该队企业项改由哪个评委维度替代）

- [ ] **Step 1: 写失败的测试**

`platform/test/enterprise-seat.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';

// 初赛权重表（S7 §2.1，w_E = 10%，依据冲突裁决 C-01）
const CONFIG = {
  wEnterprise: 0.10,
  freeBrief: { judgeDimension: 'track_fit' },
  dimensions: [
    { key: 'track_fit', weight: 0.10, seat: 'judge' },
    { key: 'innovation', weight: 0.20, seat: 'judge' },
    { key: 'feasibility', weight: 0.20, seat: 'judge' },
    { key: 'completeness', weight: 0.25, seat: 'judge' },
    { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    { key: 'collaboration', weight: 0.15, seat: 'judge' },
  ],
};

const TEAMS = [
  { teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false },
  { teamId: 't2', packageEnterpriseId: 'E1', isFreeBrief: false },
  { teamId: 't3', packageEnterpriseId: null, isFreeBrief: true },
  { teamId: 't4', packageEnterpriseId: 'E1', isFreeBrief: false },
];

const CONFIRMATIONS = [
  // t1：双签齐全且是本赛道企业 → 有效
  { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: '解决了库存周转' },
  // t2：缺跨领域评委签字 → R2 按 0 分计
  { teamId: 't2', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 70, crossJudgeId: null, signatoryUserId: 'u_e1', content: '解决了排产' },
  // t4：非本赛道企业签字 → R1 权重降为 0
  { teamId: 't4', enterpriseId: 'E9', dimension: 'enterprise', rawScore: 60, crossJudgeId: 'j2', signatoryUserId: 'u_e9', content: '别家的题' },
];

test('R1：非本赛道 → 该队企业项权重置 0，并记 warning', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.weights.t4.enterprise, 0);
  assert.ok(r.warnings.some((w) => w.code === 'R1_out_of_track' && w.teamId === 't4'));
});

test('R2：缺双签 → 按 0 分计 + warning（权重保留，绝不静默）', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t2, 0);
  assert.equal(r.weights.t2.enterprise, 0.10, 'R2 是「分数按 0 计」，不是「权重降为 0」');
  assert.ok(r.warnings.some((w) => w.code === 'R2_missing_dual_signature' && w.teamId === 't2'));
});

test('R2 双签齐全 → 企业席分 = 确认分', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t1, 80);
});

test('R3：企业席合计权重不得超过 wEnterprise（超出即封顶 + warning）', () => {
  const over = {
    ...CONFIG,
    wEnterprise: 0.25,
    dimensions: [
      { key: 'innovation', weight: 0.60, seat: 'judge' },
      { key: 'enterprise', weight: 0.40, seat: 'enterprise' },
    ],
  };
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    judges: [],
    config: over,
  });
  assert.ok(Math.abs(r.weights.t1.enterprise - 0.25) < 1e-12, `实际 ${r.weights.t1.enterprise}`);
  assert.ok(r.warnings.some((w) => w.code === 'R3_enterprise_weight_capped'));
});

test('R4：自由命题组无企业签字 → 企业项改由评委按需求真实性的公开证据打分', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t3, null, 'R4 生效时企业分交由评委维度替代');
  assert.deepEqual(r.r4Substitute.t3, { dimension: 'track_fit' });
  assert.equal(r.weights.t3.track_fit, 0, '替代维度从评委席移出，避免双重计分');
  assert.equal(r.weights.t3.enterprise, 0.10, '替代维度的权重搬到企业席');
  assert.ok(r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored' && w.teamId === 't3'));
});

test('没有企业确认记录 → 0 分 + warning（不静默当 0）', () => {
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [{ teamId: 't9', packageEnterpriseId: 'E1', isFreeBrief: false }],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t9, 0);
  assert.ok(r.warnings.some((w) => w.code === 'no_enterprise_confirmation' && w.teamId === 't9'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/enterprise-seat.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/enterprise-seat.js'`

- [ ] **Step 3: 创建 src/domain/enterprise-seat.js**

```javascript
// src/domain/enterprise-seat.js — 企业席得分 E 与 R1 / R2 / R3 / R4
//
// 依据：S7 §2.4 R1–R4（分赛道 / 双签 / 权重封顶 / 自由命题组）+ S7 §3.1 评分公式 + §4.1 签字内容。
//   R-JDG-05 ← R1；R-JDG-06 ← R2；R-JDG-07 ← R3；R-JDG-08 ← R4。
//
// ⚠️ R1 与 R2 的区别（本文件最容易做错的一处）：
//   R1（非本赛道）→ 该队【企业项权重】降为 0（该项不参与该队加权，权重让给评委席）
//   R2（缺双签）  → 该队【企业席分数】按 0 分计（权重保留，总分因此被扣）
//   两者都是 S7 原文，语义不同，不要合并。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

/**
 * @param {object} input
 * @param {Array} input.confirmations
 *   [{ teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content }]
 * @param {Array} input.teams [{ teamId, packageEnterpriseId, isFreeBrief }]
 * @param {Array} input.judges 评委池（当前仅用于留档口径，预留企业席归属校验）
 * @param {object} input.config rules.scoring.initial | rules.scoring.final
 * @returns {{seatE:Object<string, number|null>, weights:Object<string,Object<string,number>>,
 *            warnings:Array<{code:string,message:string,teamId?:string}>,
 *            r4Substitute:Object<string,{dimension:string}>}}
 */
export function applyEnterpriseRules({ confirmations = [], teams = [], judges = [], config = {} } = {}) {
  const warnings = [];
  const seatE = {};
  const weights = {};
  const r4Substitute = {};

  const dimensions = Array.isArray(config.dimensions) ? config.dimensions : [];
  const enterpriseKeys = dimensions.filter((d) => d.seat === 'enterprise').map((d) => d.key);
  const enterpriseKey = enterpriseKeys[0] ?? null;
  const demandKey = config.freeBrief?.judgeDimension ?? null;
  const wEnterprise = Number(config.wEnterprise ?? 0);

  for (const team of teams) {
    const base = {};
    for (const d of dimensions) base[d.key] = d.weight;
    const eff = { ...base };

    const mine = (confirmations ?? []).filter(
      (c) => c.teamId === team.teamId && enterpriseKeys.includes(c.dimension),
    );
    // 自由命题组没有「本赛道企业」概念 → R1 不适用（否则会与 R4 打架）
    const outOfTrack = team.isFreeBrief
      ? []
      : mine.filter((c) => c.enterpriseId !== team.packageEnterpriseId);
    const inTrack = mine.filter((c) => c.enterpriseId === team.packageEnterpriseId);
    // R2 双签：出题企业签字 + ≥1 名跨领域评委签字，缺任一即不成立
    const valid = inTrack.filter((c) => c.crossJudgeId && c.signatoryUserId);
    const r2Fail = inTrack.filter((c) => !(c.crossJudgeId && c.signatoryUserId));

    let score = null;

    if (outOfTrack.length) {
      // R1：企业评委给非本企业题目打分 → 该队企业项权重自动降为 0
      if (enterpriseKey) eff[enterpriseKey] = 0;
      warnings.push({
        code: 'R1_out_of_track',
        message: '企业席评了非本赛道题目，该队「企业确认」权重降为 0',
        teamId: team.teamId,
      });
    }

    if (r2Fail.length) {
      // R2：缺双签 → 该项按 0 分计（权重保留）
      score = 0;
      warnings.push({
        code: 'R2_missing_dual_signature',
        message: '企业确认缺双签（出题企业签字 / 跨领域评委签字），该项按 0 分计',
        teamId: team.teamId,
      });
    } else if (valid.length) {
      score = valid.reduce((acc, c) => acc + c.rawScore, 0) / valid.length;
    } else if (!outOfTrack.length) {
      score = 0;
      warnings.push({
        code: 'no_enterprise_confirmation',
        message: '该队没有有效的企业确认记录，企业席按 0 分计',
        teamId: team.teamId,
      });
    }

    // R4：自由命题组（is_free_brief=1）无企业签字 → 该项改由评委按「需求真实性的公开证据」打分
    if (team.isFreeBrief && !valid.length) {
      if (demandKey && base[demandKey] != null) {
        eff[demandKey] = 0;                 // 替代维度从评委席移出，避免双重计分
        if (enterpriseKey) eff[enterpriseKey] = base[demandKey]; // 权重搬到企业席
        r4Substitute[team.teamId] = { dimension: demandKey };
        score = null;                        // 具体分数由评分流水线用评委维度分填充
      }
      warnings.push({
        code: 'R4_free_brief_judge_scored',
        message: '自由命题组无企业签字，「企业确认」项改由评委按需求真实性的公开证据打分',
        teamId: team.teamId,
      });
    }

    // R3：企业席合计权重 ≤ wEnterprise（25% 决赛 / 10% 初赛），超出即封顶
    if (enterpriseKey && wEnterprise > 0) {
      let wE = 0;
      for (const key of enterpriseKeys) wE += eff[key] ?? 0;
      if (wE > wEnterprise + 1e-12) {
        const factor = wE === 0 ? 0 : wEnterprise / wE;
        for (const key of enterpriseKeys) eff[key] = (eff[key] ?? 0) * factor;
        warnings.push({
          code: 'R3_enterprise_weight_capped',
          message: `企业席合计权重 ${wE} 超过上限 ${wEnterprise}，已封顶`,
          teamId: team.teamId,
        });
      }
    }

    seatE[team.teamId] = score;
    weights[team.teamId] = eff;
  }

  return { seatE, weights, warnings, r4Substitute };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/enterprise-seat.test.js`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/enterprise-seat.js test/enterprise-seat.test.js
git commit -m "feat(P2): 企业席 E 与 R1 分赛道 / R2 双签 / R3 封顶 / R4 自由命题组"
```

---

### Task 5: 自评测差异检测 + 回避制度 + 互评资格 + 评委池校验

**Files:**
- Create: `platform/src/domain/self-eval.js`
- Create: `platform/src/domain/review-eligibility.js`
- Create: `platform/src/domain/judge-pool.js`
- Create: `platform/test/self-eval.test.js`
- Create: `platform/test/review-eligibility.test.js`
- Create: `platform/test/judge-pool.test.js`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `detectSelfEvalDiff({ selfReviews, judgeScores, threshold })` → `{ flags: [{ teamId, dimension, d, action }] }`
    - `d = 自评分 − 评委分`（同一尺度）；`|d| ≤ threshold` → 无 flag；`d > threshold` → `action='written_explanation'`；`d < −threshold` → `action='judge_question'`
  - `checkPeerEligibility({ teams, deliverables })` → `{ eligible, ineligible }`
    - `teams` = `[{ teamId }]`；`deliverables` = `[{ teamId, hasRealDeliverable }]`
    - 只有该赛段有**真实交付物**的队伍才可参与互评（R-RNK-07）
  - `checkRecusal({ judge, team, recusalRecords })` → `{ recused, record? }`
    - `judge` = `{ userId }`；`team` = `{ teamId }`；`recusalRecords` = `[{ judge_id, team_id, action, reason }]`
  - `checkJudgePool({ judges, config })` → `{ ok, errors, stats }`
    - `judges` = `[{ judgeId, seat }]`；`config` = `rules.scoring.*.judgePool` 段
    - 观察员（`seat='observer'`）**无投票权**，不计入任何比例

- [ ] **Step 1: 写失败的测试**

`platform/test/self-eval.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSelfEvalDiff } from '../src/domain/self-eval.js';

const SELF = [
  { teamId: 't1', dimension: 'innovation', rawScore: 95 }, // d = 95-80 = +15 → 书面说明
  { teamId: 't2', dimension: 'innovation', rawScore: 80 }, // d = 0     → 无影响
  { teamId: 't3', dimension: 'innovation', rawScore: 50 }, // d = 50-80 = -30 → 评委提问
  { teamId: 't4', dimension: 'innovation', rawScore: 90 }, // d = +10   → 边界，无影响
  { teamId: 't5', dimension: 'innovation', rawScore: 70 }, // d = -10   → 边界，无影响
];
const JUDGE = [
  { teamId: 't1', dimension: 'innovation', score: 80 },
  { teamId: 't2', dimension: 'innovation', score: 80 },
  { teamId: 't3', dimension: 'innovation', score: 80 },
  { teamId: 't4', dimension: 'innovation', score: 80 },
  { teamId: 't5', dimension: 'innovation', score: 80 },
];

test('d > 10 → 触发书面说明（written_explanation）', () => {
  const r = detectSelfEvalDiff({ selfReviews: SELF, judgeScores: JUDGE, threshold: 10 });
  const flag = r.flags.find((f) => f.teamId === 't1');
  assert.equal(flag.d, 15);
  assert.equal(flag.action, 'written_explanation');
});

test('d < -10 → 触发评委提问（judge_question，只提问不改分）', () => {
  const r = detectSelfEvalDiff({ selfReviews: SELF, judgeScores: JUDGE, threshold: 10 });
  const flag = r.flags.find((f) => f.teamId === 't3');
  assert.equal(flag.d, -30);
  assert.equal(flag.action, 'judge_question');
});

test('|d| <= 10 → 无影响（含 ±10 边界）', () => {
  const r = detectSelfEvalDiff({ selfReviews: SELF, judgeScores: JUDGE, threshold: 10 });
  assert.equal(r.flags.filter((f) => f.teamId === 't2').length, 0);
  assert.equal(r.flags.filter((f) => f.teamId === 't4').length, 0);
  assert.equal(r.flags.filter((f) => f.teamId === 't5').length, 0);
  assert.equal(r.flags.length, 2);
});

test('缺少对应评委分 → 不产生 flag（缺数据不当成异常）', () => {
  const r = detectSelfEvalDiff({
    selfReviews: [{ teamId: 'tx', dimension: 'innovation', rawScore: 99 }],
    judgeScores: [],
    threshold: 10,
  });
  assert.deepEqual(r.flags, []);
});
```

`platform/test/review-eligibility.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPeerEligibility, checkRecusal } from '../src/domain/review-eligibility.js';

test('只有该赛段有真实交付物的队伍才可参与互评（R-RNK-07）', () => {
  const r = checkPeerEligibility({
    teams: [{ teamId: 't1' }, { teamId: 't2' }, { teamId: 't3' }],
    deliverables: [
      { teamId: 't1', hasRealDeliverable: true },
      { teamId: 't2', hasRealDeliverable: false },
    ],
  });
  assert.deepEqual(r.eligible, ['t1']);
  assert.deepEqual(r.ineligible, ['t2', 't3']);
});

test('回避记录命中该队 → recused=true 并回传记录', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主' },
    ],
  });
  assert.equal(r.recused, true);
  assert.equal(r.record.reason, '前雇主');
});

test('赛段级回避（team_id = null）对该赛段所有队生效', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't9' },
    recusalRecords: [{ judge_id: 'u1', team_id: null, action: 'recused', reason: '供方' }],
  });
  assert.equal(r.recused, true);
});

test('无匹配回避记录 → recused=false', () => {
  const r = checkRecusal({
    judge: { userId: 'u2' },
    team: { teamId: 't1' },
    recusalRecords: [{ judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主' }],
  });
  assert.equal(r.recused, false);
  assert.equal(r.record, undefined);
});

test('撤回回避（action=reinstated）后不再视为回避', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [{ judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核' }],
  });
  assert.equal(r.recused, false);
});
```

`platform/test/judge-pool.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkJudgePool } from '../src/domain/judge-pool.js';

const CFG_INITIAL = {
  minJudgesPerDimension: 7,
  minEnterpriseSeatShare: 0.30,
  maxExpertSeatShare: 0.50,
  votingSeats: ['judge', 'enterprise'],
  nonVotingSeats: ['observer'],
};

function pool(expert, enterprise, observer) {
  const list = [];
  for (let i = 1; i <= expert; i += 1) list.push({ judgeId: `e${i}`, seat: 'judge' });
  for (let i = 1; i <= enterprise; i += 1) list.push({ judgeId: `c${i}`, seat: 'enterprise' });
  for (let i = 1; i <= observer; i += 1) list.push({ judgeId: `o${i}`, seat: 'observer' });
  return list;
}

test('评委池满足下限与席构成 → ok', () => {
  // 4 专家 + 5 企业 = 9 名有投票权评委：≥7 下限；专家 44.4% ≤ 50%；企业 55.6% ≥ 30%
  const r = checkJudgePool({ judges: pool(4, 5, 2), config: CFG_INITIAL });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stats.voting, 9);
  assert.equal(r.stats.observer, 2);
});

test('每维度评委数不足 → 报错（初赛 ≥7）', () => {
  const r = checkJudgePool({ judges: pool(2, 1, 0), config: CFG_INITIAL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'judge_pool_too_small'));
});

test('企业席占比不足 30% → 报错', () => {
  const r = checkJudgePool({ judges: pool(7, 1, 0), config: CFG_INITIAL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'enterprise_share_too_low'));
});

test('专家席占比超过 50% → 报错', () => {
  const r = checkJudgePool({ judges: pool(8, 1, 0), config: CFG_INITIAL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'expert_share_too_high'));
});

test('观察员无投票权，不计入人数与占比', () => {
  const withObs = checkJudgePool({ judges: pool(4, 5, 20), config: CFG_INITIAL });
  const without = checkJudgePool({ judges: pool(4, 5, 0), config: CFG_INITIAL });
  assert.equal(withObs.ok, without.ok);
  assert.equal(withObs.stats.voting, without.stats.voting);
  assert.equal(withObs.stats.observer, 20);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/self-eval.test.js test/review-eligibility.test.js test/judge-pool.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/self-eval.js'`

- [ ] **Step 3: 创建 src/domain/self-eval.js**

```javascript
// src/domain/self-eval.js — 自评测差异检测
//
// 依据：S7 §4.3（R-JDG-13）｜设计文档 §6.2 Step 7。
//   d = 自评分 − 评委分（同一尺度）
//   |d| ≤ 10 → 无影响
//   d >  10 → 触发复核：要求团队书面说明自评理由；不成立则自评分对齐评委分（不加分）
//   d < -10 → 触发复核：评委向团队提问（只提问，不改分）
//
// 机制归因（S7 §4.3）：「一旦自评可以加分，它就变成了纯粹的博弈项。
//   让它只触发『解释』和『提问』，它才真正对治黑箱。」
// → 所以本模块【只产出 flag】，不产出分数；分数的处理在 scoring.js 里按 action 显式执行。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

export const SELF_EVAL_ACTIONS = Object.freeze({
  WRITTEN_EXPLANATION: 'written_explanation',
  JUDGE_QUESTION: 'judge_question',
});

/**
 * @param {object} input
 * @param {Array<{teamId:string, dimension:string, rawScore:number}>} input.selfReviews
 * @param {Array<{teamId:string, dimension:string, score:number}>} input.judgeScores 评委席同尺度分
 * @param {number} input.threshold 阈值（默认 10，配置在 rules/*.json）
 * @returns {{flags:Array<{teamId:string, dimension:string, d:number, action:string}>}}
 */
export function detectSelfEvalDiff({ selfReviews = [], judgeScores = [], threshold = 10 } = {}) {
  const judgeMap = new Map();
  for (const j of judgeScores) {
    judgeMap.set(`${j.teamId}::${j.dimension}`, j.score);
  }

  const flags = [];
  for (const s of selfReviews) {
    const judgeScore = judgeMap.get(`${s.teamId}::${s.dimension}`);
    if (!Number.isFinite(judgeScore) || !Number.isFinite(s.rawScore)) continue; // 缺数据不当异常
    const d = s.rawScore - judgeScore;
    if (d > threshold) {
      flags.push({ teamId: s.teamId, dimension: s.dimension, d, action: SELF_EVAL_ACTIONS.WRITTEN_EXPLANATION });
    } else if (d < -threshold) {
      flags.push({ teamId: s.teamId, dimension: s.dimension, d, action: SELF_EVAL_ACTIONS.JUDGE_QUESTION });
    }
  }
  flags.sort((a, b) => a.teamId.localeCompare(b.teamId) || a.dimension.localeCompare(b.dimension));
  return { flags };
}
```

- [ ] **Step 4: 创建 src/domain/review-eligibility.js**

```javascript
// src/domain/review-eligibility.js — 互评资格 + 回避判定
//
// 依据：S10 §0.4（R-RNK-07 互评资格门槛：只对该赛段有真实交付物的队伍开放）
//       + S7 §2.4 R5（R-JDG-09 回避制度：评委为供应方/投资方/前雇主必须回避，回避记录留档）
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

/**
 * 互评资格：只对该赛段有真实交付物的队伍开放互评（R-RNK-07）。
 * @param {object} input
 * @param {Array<{teamId:string}>} input.teams
 * @param {Array<{teamId:string, hasRealDeliverable:boolean}>} input.deliverables
 * @returns {{eligible:string[], ineligible:string[]}}
 */
export function checkPeerEligibility({ teams = [], deliverables = [] } = {}) {
  const deliverableMap = new Map();
  for (const d of deliverables) deliverableMap.set(d.teamId, !!d.hasRealDeliverable);

  const eligible = [];
  const ineligible = [];
  for (const t of teams) {
    if (deliverableMap.get(t.teamId)) eligible.push(t.teamId);
    else ineligible.push(t.teamId);
  }
  eligible.sort();
  ineligible.sort();
  return { eligible, ineligible };
}

/**
 * 回避判定：命中回避记录即不可评该队。
 * @param {object} input
 * @param {{userId:string}} input.judge
 * @param {{teamId:string}} input.team
 * @param {Array<{judge_id:string, team_id:string|null, action:string, reason:string}>} input.recusalRecords
 * @returns {{recused:boolean, record?:object}}
 */
export function checkRecusal({ judge, team, recusalRecords = [] } = {}) {
  if (!judge?.userId) return { recused: false };
  for (const record of recusalRecords) {
    if (record.judge_id !== judge.userId) continue;
    if (record.action !== 'recused') continue; // reinstated = 已撤销
    if (record.team_id === null || record.team_id === team?.teamId) {
      return { recused: true, record };
    }
  }
  return { recused: false };
}
```

- [ ] **Step 5: 创建 src/domain/judge-pool.js**

```javascript
// src/domain/judge-pool.js — 评委池规模与席构成校验
//
// 依据：S7 §3.4（R-JDG-10 评委池下限：初赛每维度 ≥7 人 / 决赛 ≥9 人；
//       R-JDG-11 席构成：企业席 ≥30%，专家席 ≤50%，其余观察员【无投票权】）
// 规则数值全部来自 rules/scoring-*.json 的 judgePool 段（⛔ 不硬编码）。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

/**
 * @param {object} input
 * @param {Array<{judgeId:string, seat:string}>} input.judges
 * @param {object} input.config rules.scoring.*.judgePool
 * @returns {{ok:boolean, errors:Array<{code:string,message:string}>, stats:object}}
 */
export function checkJudgePool({ judges = [], config = {} } = {}) {
  const votingSeats = config.votingSeats ?? ['judge', 'enterprise'];
  const nonVotingSeats = config.nonVotingSeats ?? ['observer'];
  const minJudges = Number(config.minJudgesPerDimension ?? 0);
  const minEnterpriseShare = Number(config.minEnterpriseSeatShare ?? 0);
  const maxExpertShare = Number(config.maxExpertSeatShare ?? 1);

  const errors = [];
  const voting = judges.filter((j) => votingSeats.includes(j.seat));
  const nonVoting = judges.filter((j) => nonVotingSeats.includes(j.seat));
  const enterprise = voting.filter((j) => j.seat === 'enterprise');
  const expert = voting.filter((j) => j.seat === 'judge');

  // 评委池按赛段统一组织（冲突裁决 C-05 第 1 条：专家席跨任务包评分以保证样本量 ≥5）
  // → 每个评委维度都覆盖全部有投票权的评委
  const perDimension = {};
  if (minJudges > 0 && voting.length < minJudges) {
    errors.push({
      code: 'judge_pool_too_small',
      message: `评委池人数 ${voting.length} 低于下限 ${minJudges}（每维度有投票权的评委数不足）`,
    });
  }
  perDimension.all = voting.length;

  const votingCount = voting.length || 1;
  const enterpriseShare = enterprise.length / votingCount;
  const expertShare = expert.length / votingCount;

  if (minEnterpriseShare > 0 && enterpriseShare < minEnterpriseShare - 1e-9) {
    errors.push({
      code: 'enterprise_share_too_low',
      message: `企业席占比 ${(enterpriseShare * 100).toFixed(1)}% 低于下限 ${(minEnterpriseShare * 100).toFixed(1)}%`,
    });
  }
  if (maxExpertShare < 1 && expertShare > maxExpertShare + 1e-9) {
    errors.push({
      code: 'expert_share_too_high',
      message: `专家席占比 ${(expertShare * 100).toFixed(1)}% 超过上限 ${(maxExpertShare * 100).toFixed(1)}%`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      total: judges.length,
      voting: voting.length,
      enterprise: enterprise.length,
      expert: expert.length,
      observer: nonVoting.length,
      enterpriseShare,
      expertShare,
      perDimension,
    },
  };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/self-eval.test.js test/review-eligibility.test.js test/judge-pool.test.js`
Expected: PASS（14 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/domain/self-eval.js src/domain/review-eligibility.js src/domain/judge-pool.js test/self-eval.test.js test/review-eligibility.test.js test/judge-pool.test.js
git commit -m "feat(P2): 自评差异检测、回避制度、互评资格与评委池校验"
```

---

### Task 6: 评分提交服务 + 幂等 + 增量 score_stats

**Files:**
- Create: `platform/src/db/repo/stages.js`
- Create: `platform/src/db/repo/reviews.js`
- Create: `platform/src/db/repo/request-keys.js`
- Create: `platform/src/db/repo/enterprise-confirmations.js`
- Create: `platform/src/db/repo/peer-reviews.js`
- Create: `platform/src/db/repo/self-reviews.js`
- Create: `platform/src/db/repo/recusals.js`
- Create: `platform/src/audit/log.js`
- Create: `platform/src/services/review.js`
- Create: `platform/test/review-service.test.js`

**Interfaces:**
- Consumes: P0 `openDatabase`；Task 1 的表；Task 5 的 `checkRecusal` / `checkPeerEligibility`
- Produces:
  - `submitReviews({ db, stageId, judgeId, items, requestId, now })` → `{ stageId, judgeId, requestId, submitted, items }`
    - 幂等：同一 `requestId` 重复提交只生效一次
    - 观察员 → 403；已回避该队 → 403
    - 写 `stage_reviews` + **增量**更新 `score_stats`（n / mean / sum_sq）
  - `getReviewState({ db, stageId, viewer })` → `{ submitted, total, missing, dimensionProgress }`
  - `submitCalibration({ db, stageId, judgeId, items, now })` → `{ stageId, judgeId, submitted }`（写 `calibrations`，**不计入评分**）
  - `submitPeerReviews({ db, stageId, items, requestId, now })` → `{ stageId, submitted }`
  - `submitSelfReviews({ db, stageId, teamId, items, requestId, now })` → `{ stageId, teamId, submitted }`
  - `declareRecusal({ db, stageId, judgeId, teamId, reason, actorId, now })` → recusal record
  - `writeAuditLog(db, { actorId, action, entity, entityId, detail, now })` → audit id

- [ ] **Step 1: 写失败的测试**

`platform/test/review-service.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import {
  submitReviews,
  getReviewState,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  declareRecusal,
} from '../src/services/review.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const NOW = '2026-10-20T10:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rev-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  const judge = createUser(db, { name: '评委甲', phone: '13900000011', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000012', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000013', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000014', password: 'pw' });

  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES ('s1', 'ed1', 's1', '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  ).run();
  const seat = db.prepare(
    'INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  seat.run('s1', judge.id, 'judge', 'global', null, NOW);
  seat.run('s1', observer.id, 'observer', 'global', null, NOW);
  db.prepare(
    'INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('s2', 'ed1', 's2', '决赛', 'final', '2026-10-26', '2026-10-28', 'final', 'open');
  return { db, close, dataDir, judge, observer, captain, admin };
}

test('提交评分：写入 stage_reviews 并增量更新 score_stats', () => {
  const { db, close, dataDir, judge } = setup();
  const res = submitReviews({
    db,
    stageId: 's1',
    judgeId: judge.id,
    items: [
      { teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { teamId: 't2', dimension: 'innovation', rawScore: 60 },
    ],
    requestId: 'req-1',
    now: NOW,
  });
  assert.equal(res.submitted, 2);

  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 2);
  assert.ok(Math.abs(stat.mean - 70) < 1e-12);
  assert.ok(Math.abs(stat.sum_sq - (6400 + 3600)) < 1e-9);

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：同一 requestId 重复提交只生效一次', () => {
  const { db, close, dataDir, judge } = setup();
  const items = [{ teamId: 't1', dimension: 'innovation', rawScore: 80 }];
  submitReviews({ db, stageId: 's1', judgeId: judge.id, items, requestId: 'req-1', now: NOW });
  const second = submitReviews({ db, stageId: 's1', judgeId: judge.id, items, requestId: 'req-1', now: NOW });
  assert.equal(second.submitted, 0, '重复提交不产生新记录');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_reviews').get().n, 1);
  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 1, 'score_stats 不得被重复累加');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('观察员无投票权 → 403', () => {
  const { db, close, dataDir, observer } = setup();
  assert.throws(
    () => submitReviews({
      db, stageId: 's1', judgeId: observer.id,
      items: [{ teamId: 't1', dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-o', now: NOW,
    }),
    (err) => err.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('改分：同一 (评委,队伍,维度) 覆盖写，score_stats 同步修正', () => {
  const { db, close, dataDir, judge } = setup();
  submitReviews({
    db, stageId: 's1', judgeId: judge.id,
    items: [{ teamId: 't1', dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-a', now: NOW,
  });
  submitReviews({
    db, stageId: 's1', judgeId: judge.id,
    items: [{ teamId: 't1', dimension: 'innovation', rawScore: 90 }],
    requestId: 'req-b', now: NOW,
  });
  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 1);
  assert.ok(Math.abs(stat.mean - 90) < 1e-12);
  assert.ok(Math.abs(stat.sum_sq - 8100) < 1e-9);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('校准打分写入 calibrations，不进 stage_reviews（不计入评分）', () => {
  const { db, close, dataDir, judge } = setup();
  submitCalibration({
    db, stageId: 's1', judgeId: judge.id,
    items: [{ dimension: 'innovation', rawScore: 50 }], now: NOW,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calibrations').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_reviews').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('进度查询：返回已交/应交/缺谁/维度进度', () => {
  const { db, close, dataDir, judge } = setup();
  submitReviews({
    db, stageId: 's1', judgeId: judge.id,
    items: [{ teamId: 't1', dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-1', now: NOW,
  });
  const state = getReviewState({ db, stageId: 's1', viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.submitted, 1);
  assert.ok(state.total >= 1);
  assert.ok(Array.isArray(state.missing));
  assert.ok('innovation' in state.dimensionProgress);
  assert.equal(state.dimensionProgress.innovation.submitted, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('互评：一队对另一队只投一次；重复 requestId 幂等', () => {
  const { db, close, dataDir, judge } = setup();
  // 两队都已有真实交付物（评委已对其打分）→ 才有互评资格（R-RNK-07）
  submitReviews({
    db, stageId: 's1', judgeId: judge.id,
    items: [
      { teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { teamId: 't2', dimension: 'innovation', rawScore: 70 },
    ],
    requestId: 'r-1', now: NOW,
  });
  const items = [{ fromTeamId: 't1', toTeamId: 't2', score: 70 }];
  const first = submitPeerReviews({ db, stageId: 's1', items, requestId: 'p-1', now: NOW });
  assert.equal(first.submitted, 1);
  const second = submitPeerReviews({ db, stageId: 's1', items, requestId: 'p-1', now: NOW });
  assert.equal(second.submitted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_reviews').get().n, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('无真实交付物的队伍不能参与互评（R-RNK-07）', () => {
  const { db, close, dataDir, judge } = setup();
  submitReviews({
    db, stageId: 's1', judgeId: judge.id,
    items: [{ teamId: 't1', dimension: 'innovation', rawScore: 80 }],
    requestId: 'r-1', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: 's1', items: [{ fromTeamId: 't1', toTeamId: 't9', score: 70 }], requestId: 'p-2', now: NOW,
    }),
    (err) => err.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自评测提交并幂等', () => {
  const { db, close, dataDir } = setup();
  const items = [{ dimension: 'innovation', rawScore: 85 }];
  submitSelfReviews({ db, stageId: 's1', teamId: 't1', items, requestId: 's-1', now: NOW });
  const again = submitSelfReviews({ db, stageId: 's1', teamId: 't1', items, requestId: 's-1', now: NOW });
  assert.equal(again.submitted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_reviews').get().n, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('回避：留档后该评委不能再评该队', () => {
  const { db, close, dataDir, judge, admin } = setup();
  declareRecusal({ db, stageId: 's1', judgeId: judge.id, teamId: 't1', reason: '前雇主', actorId: admin.id, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recusal_records').get().n, 1);
  assert.throws(
    () => submitReviews({
      db, stageId: 's1', judgeId: judge.id,
      items: [{ teamId: 't1', dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-r', now: NOW,
    }),
    (err) => err.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/review-service.test.js`
Expected: FAIL —— `Cannot find module '../src/services/review.js'`

- [ ] **Step 3: 创建仓储层（所有 SQL 收在这里）**

`platform/src/db/repo/request-keys.js`：

```javascript
// src/db/repo/request-keys.js — 幂等键
//
// 依据：设计文档 §11（幂等 + 行锁 + 只接受当前分配）。
//   ⛔ 一次批量提交会写入多行、它们共用同一个 request_id —— 所以幂等键不能直接建在
//      业务表的 request_id 列上（那样第二批就插不进去）。
//   ✅ 正确做法：先在键表里「抢键」，抢到 = 首次生效；抢不到 = 重复请求 → 幂等短路。
//      唯一约束在数据库层，因此并发下不会双写。
export function claimRequestKey(db, { scope, stageId, subjectId, requestId, now }) {
  try {
    db.prepare(
      `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, stageId, subjectId, requestId, now);
    return true;
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err.message))) return false; // 键已存在 = 重复请求
    throw err;
  }
}

export function findRequestKey(db, { scope, stageId, subjectId, requestId }) {
  return db
    .prepare(
      `SELECT * FROM review_request_keys WHERE scope = ? AND stage_id = ? AND subject_id = ? AND request_id = ?`,
    )
    .get(scope, stageId, subjectId, requestId) ?? null;
}
```

`platform/src/db/repo/stages.js`：

```javascript
// src/db/repo/stages.js — 赛段与评委席
import { randomUUID } from 'node:crypto';

export function insertStage(db, { editionId, key, name, kind, startsAt, endsAt, freezeAt = null, scoringConfigKey, status = 'draft', now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, key, name, kind, startsAt, endsAt, freezeAt, scoringConfigKey, status, now);
  return getStage(db, id);
}

export function getStage(db, id) {
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(id) ?? null;
}

export function listStages(db, { editionId } = {}) {
  if (editionId) return db.prepare('SELECT * FROM stages WHERE edition_id = ? ORDER BY starts_at').all(editionId);
  return db.prepare('SELECT * FROM stages ORDER BY starts_at').all();
}

export function assignStageJudge(db, { stageId, userId, seat, scopeType = 'global', scopeId = null, now }) {
  db.prepare(
    `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(stageId, userId, seat, scopeType, scopeId, now);
  return listStageJudges(db, stageId);
}

/** 评委池：seat = judge 专家席 / enterprise 企业席 / observer 观察员（无投票权） */
export function listStageJudges(db, stageId) {
  return db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? ORDER BY user_id').all(stageId);
}

export function getStageJudge(db, stageId, userId) {
  return db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?').get(stageId, userId) ?? null;
}
```

`platform/src/db/repo/reviews.js`：

```javascript
// src/db/repo/reviews.js — 评委打分、校准打分、增量统计
import { randomUUID } from 'node:crypto';

export function findReviewsByRequestId(db, { stageId, judgeId, requestId }) {
  if (!requestId) return [];
  return db
    .prepare('SELECT * FROM stage_reviews WHERE stage_id = ? AND judge_id = ? AND request_id = ?')
    .all(stageId, judgeId, requestId);
}

export function findReview(db, { stageId, judgeId, teamId, dimension }) {
  return db
    .prepare('SELECT * FROM stage_reviews WHERE stage_id = ? AND judge_id = ? AND team_id = ? AND dimension = ?')
    .get(stageId, judgeId, teamId, dimension) ?? null;
}

export function insertReview(db, { stageId, judgeId, teamId, dimension, rawScore, requestId = null, calibrated = 0, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at, request_id, calibrated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, judgeId, teamId, dimension, rawScore, now, requestId, calibrated);
  return db.prepare('SELECT * FROM stage_reviews WHERE id = ?').get(id);
}

/** 改分：同一 (赛段,评委,队伍,维度) 覆盖写，request_id 保留首次提交的那一个 */
export function updateReviewScore(db, { id, rawScore, now }) {
  db.prepare('UPDATE stage_reviews SET raw_score = ?, submitted_at = ? WHERE id = ?').run(rawScore, now, id);
  return db.prepare('SELECT * FROM stage_reviews WHERE id = ?').get(id);
}

export function listReviews(db, { stageId, judgeId = null, teamId = null } = {}) {
  const where = ['stage_id = ?'];
  const params = [stageId];
  if (judgeId) { where.push('judge_id = ?'); params.push(judgeId); }
  if (teamId) { where.push('team_id = ?'); params.push(teamId); }
  return db
    .prepare(`SELECT * FROM stage_reviews WHERE ${where.join(' AND ')} AND calibrated = 0 ORDER BY team_id, dimension, judge_id`)
    .all(...params);
}

export function listReviewCells(db, stageId) {
  return db
    .prepare('SELECT DISTINCT team_id, dimension FROM stage_reviews WHERE stage_id = ? AND calibrated = 0')
    .all(stageId);
}

export function insertCalibration(db, { stageId, judgeId, dimension, rawScore, now }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO calibrations (id, stage_id, judge_id, dimension, raw_score, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, stageId, judgeId, dimension, rawScore, now);
  return id;
}

export function listCalibrations(db, stageId) {
  return db.prepare('SELECT * FROM calibrations WHERE stage_id = ? ORDER BY created_at').all(stageId);
}

/** score_stats：增量维护 n / mean / sum_sq（stdev 由 sum_sq 现算） */
export function getScoreStat(db, judgeId, dimension) {
  return db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judgeId, dimension) ?? null;
}

export function upsertScoreStat(db, { judgeId, dimension, n, mean, sumSq, now }) {
  db.prepare(
    `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (judge_id, dimension) DO UPDATE SET n = excluded.n, mean = excluded.mean,
       sum_sq = excluded.sum_sq, updated_at = excluded.updated_at`,
  ).run(judgeId, dimension, n, mean, sumSq, now);
  return getScoreStat(db, judgeId, dimension);
}

/** 从 (n, mean, sum_sq) 现算样本标准差 */
export function stdevFromStats(n, mean, sumSq) {
  if (n < 2) return 0;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * 增量更新某个 (评委, 维度) 的统计量。
 * @param {number[]} added 新增的原始分
 * @param {number[]} removed 被改分替换掉的旧原始分
 */
export function applyScoreStatDelta(db, { judgeId, dimension, added = [], removed = [], now }) {
  const cur = getScoreStat(db, judgeId, dimension);
  const n0 = cur?.n ?? 0;
  const mean0 = cur?.mean ?? 0;
  const sumSq0 = cur?.sum_sq ?? 0;
  const sum0 = n0 * mean0;

  const addSum = added.reduce((a, v) => a + v, 0);
  const remSum = removed.reduce((a, v) => a + v, 0);
  const addSq = added.reduce((a, v) => a + v * v, 0);
  const remSq = removed.reduce((a, v) => a + v * v, 0);

  const n1 = n0 + added.length - removed.length;
  const sum1 = sum0 + addSum - remSum;
  const sumSq1 = sumSq0 + addSq - remSq;
  const mean1 = n1 > 0 ? sum1 / n1 : 0;

  upsertScoreStat(db, { judgeId, dimension, n: n1, mean: mean1, sumSq: sumSq1, now });
  return { judgeId, dimension, n: n1, mean: mean1, sumSq: sumSq1, stdev: stdevFromStats(n1, mean1, sumSq1) };
}
```

`platform/src/db/repo/enterprise-confirmations.js`：

```javascript
// src/db/repo/enterprise-confirmations.js — 企业确认（R2 双签 / R-JDG-14 签字内容）
import { randomUUID } from 'node:crypto';

export function insertEnterpriseConfirmation(db, { stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId = null, signatoryUserId = null, content = '', now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO enterprise_confirmations
       (id, stage_id, team_id, enterprise_id, dimension, raw_score, cross_judge_id, signatory_user_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content, now);
  return db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ?').get(id);
}

export function listEnterpriseConfirmations(db, { stageId, teamId = null } = {}) {
  if (teamId) {
    return db
      .prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND team_id = ? AND deleted_at IS NULL ORDER BY created_at')
      .all(stageId, teamId);
  }
  return db
    .prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(stageId);
}

export function softDeleteEnterpriseConfirmation(db, id, now) {
  db.prepare('UPDATE enterprise_confirmations SET deleted_at = ? WHERE id = ?').run(now, id);
}
```

`platform/src/db/repo/peer-reviews.js`：

```javascript
// src/db/repo/peer-reviews.js — 互评
import { randomUUID } from 'node:crypto';

export function findPeerReviewsByRequestId(db, { stageId, fromTeamId, requestId }) {
  if (!requestId) return [];
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND request_id = ?')
    .all(stageId, fromTeamId, requestId);
}

export function findPeerReview(db, { stageId, fromTeamId, toTeamId }) {
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND to_team_id = ?')
    .get(stageId, fromTeamId, toTeamId) ?? null;
}

export function insertPeerReview(db, { stageId, fromTeamId, toTeamId, score, requestId = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, fromTeamId, toTeamId, score, requestId, now);
  return db.prepare('SELECT * FROM peer_reviews WHERE id = ?').get(id);
}

export function updatePeerReviewScore(db, { id, score, now }) {
  db.prepare('UPDATE peer_reviews SET score = ?, created_at = ? WHERE id = ?').run(score, now, id);
  return db.prepare('SELECT * FROM peer_reviews WHERE id = ?').get(id);
}

export function listPeerReviews(db, stageId) {
  return db.prepare('SELECT * FROM peer_reviews WHERE stage_id = ? ORDER BY from_team_id, to_team_id').all(stageId);
}
```

`platform/src/db/repo/self-reviews.js`：

```javascript
// src/db/repo/self-reviews.js — 自评测
import { randomUUID } from 'node:crypto';

export function findSelfReviewsByRequestId(db, { stageId, teamId, requestId }) {
  if (!requestId) return [];
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND request_id = ?')
    .all(stageId, teamId, requestId);
}

export function findSelfReview(db, { stageId, teamId, dimension }) {
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND dimension = ?')
    .get(stageId, teamId, dimension) ?? null;
}

export function insertSelfReview(db, { stageId, teamId, dimension, rawScore, requestId = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, teamId, dimension, rawScore, now, requestId);
  return db.prepare('SELECT * FROM self_reviews WHERE id = ?').get(id);
}

export function updateSelfReviewScore(db, { id, rawScore, now }) {
  db.prepare('UPDATE self_reviews SET raw_score = ?, submitted_at = ? WHERE id = ?').run(rawScore, now, id);
  return db.prepare('SELECT * FROM self_reviews WHERE id = ?').get(id);
}

export function listSelfReviews(db, stageId) {
  return db.prepare('SELECT * FROM self_reviews WHERE stage_id = ? ORDER BY team_id, dimension').all(stageId);
}
```

`platform/src/db/repo/recusals.js`：

```javascript
// src/db/repo/recusals.js — 回避记录（R-JDG-09 留档）
import { randomUUID } from 'node:crypto';

export function insertRecusal(db, { stageId, judgeId, teamId = null, reason, source = 'declared', auditBy = null, action = 'recused', now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, judgeId, teamId, reason, source, now, auditBy, action);
  return db.prepare('SELECT * FROM recusal_records WHERE id = ?').get(id);
}

export function listRecusals(db, { stageId, judgeId = null } = {}) {
  if (judgeId) {
    return db
      .prepare('SELECT * FROM recusal_records WHERE stage_id = ? AND judge_id = ? ORDER BY declared_at')
      .all(stageId, judgeId);
  }
  return db.prepare('SELECT * FROM recusal_records WHERE stage_id = ? ORDER BY declared_at').all(stageId);
}
```

`platform/src/audit/log.js`：

```javascript
// src/audit/log.js — 审计日志
// 依据：设计文档 §11 / §12（可复算与留痕）。若 P0/P1 已建同名模块，按本签名对齐，不要重复实现。
import { randomUUID } from 'node:crypto';

export function writeAuditLog(db, { actorId = null, action, entity = null, entityId = null, detail = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actorId, action, entity, entityId, detail ? JSON.stringify(detail) : null, now);
  return id;
}

export function listAuditLog(db, { entity = null, entityId = null, limit = 100 } = {}) {
  if (entity) {
    return db
      .prepare('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(entity, entityId, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
```

- [ ] **Step 4: 创建 src/services/review.js**

```javascript
// src/services/review.js — 评审提交类用例
//
// 依据：INTERFACES.md §3 服务层 + S7 §3.1 / §4.3 + S10 §0.4。
//   幂等：同一 request_id 重复提交只生效一次（⛔ 不用「先查再插」判断重复灌分，
//         唯一约束在数据库层；这里只对 request_id 做幂等短路）。
//   增量：写 stage_reviews 后增量更新 score_stats（n / mean / sum_sq），
//         stdev 由 sum_sq 现算 —— 避免每次发榜全表重算（成本随评委数×队伍数相乘增长）。
//   ⛔ 但每次发榜仍会做一次全量重算并落快照（可复算要求能从原始数据重放）。
import {
  findReviewsByRequestId,
  findReview,
  insertReview,
  updateReviewScore,
  listReviews,
  listReviewCells,
  insertCalibration,
  applyScoreStatDelta,
} from '../db/repo/reviews.js';
import { listStageJudges, getStageJudge } from '../db/repo/stages.js';
import { claimRequestKey } from '../db/repo/request-keys.js';
import { insertEnterpriseConfirmation, listEnterpriseConfirmations } from '../db/repo/enterprise-confirmations.js';
import { findPeerReviewsByRequestId, findPeerReview, insertPeerReview, updatePeerReviewScore } from '../db/repo/peer-reviews.js';
import { findSelfReviewsByRequestId, findSelfReview, insertSelfReview, updateSelfReviewScore } from '../db/repo/self-reviews.js';
import { insertRecusal, listRecusals } from '../db/repo/recusals.js';
import { writeAuditLog } from '../audit/log.js';
import { checkRecusal, checkPeerEligibility } from '../domain/review-eligibility.js';

function fail(status, code, message, detail) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function assertVotingJudge(db, stageId, judgeId) {
  const seat = getStageJudge(db, stageId, judgeId);
  if (!seat) throw fail(403, 'NOT_ASSIGNED_JUDGE', '该评委未被分配到本赛段');
  if (seat.seat === 'observer') {
    // R-JDG-11：观察员无投票权
    throw fail(403, 'OBSERVER_NO_VOTE', '观察员无投票权，不能提交评分');
  }
  return seat;
}

function assertNotRecused(db, stageId, judgeId, teamId) {
  const records = listRecusals(db, { stageId, judgeId });
  const check = checkRecusal({ judge: { userId: judgeId }, team: { teamId }, recusalRecords: records });
  if (check.recused) {
    throw fail(403, 'RECUSED', `该评委已回避本队（原因：${check.record?.reason ?? '未填写'}）`);
  }
}

/**
 * 提交评委打分（幂等 + 增量 score_stats）。
 * @param {object} input
 * @param {number} input.items [{ teamId, dimension, rawScore }]
 */
export function submitReviews({ db, stageId, judgeId, items = [], requestId = null, now }) {
  assertVotingJudge(db, stageId, judgeId);

  // 幂等：先抢键。抢不到 = 同一次请求已经生效过 → 直接返回上次结果，不重复落数据
  if (requestId) {
    const claimed = claimRequestKey(db, { scope: 'review', stageId, subjectId: judgeId, requestId, now });
    if (!claimed) {
      const prior = findReviewsByRequestId(db, { stageId, judgeId, requestId });
      return { stageId, judgeId, requestId, submitted: 0, items: prior };
    }
  }

  const written = [];
  // 按维度分桶的增量（新增分 / 被改分替换掉的旧分）——score_stats 必须同步修正
  const byDimension = new Map();
  const bucketOf = (dimension) => {
    if (!byDimension.has(dimension)) byDimension.set(dimension, { added: [], removed: [] });
    return byDimension.get(dimension);
  };

  for (const item of items) {
    assertNotRecused(db, stageId, judgeId, item.teamId);
    const bucket = bucketOf(item.dimension);
    const existing = findReview(db, { stageId, judgeId, teamId: item.teamId, dimension: item.dimension });
    if (existing) {
      // 改分：覆盖写并同步修正统计量（n 不变，mean/sum_sq 修正）
      updateReviewScore(db, { id: existing.id, rawScore: item.rawScore, now });
      bucket.removed.push(existing.raw_score);
      bucket.added.push(item.rawScore);
    } else {
      const row = insertReview(db, {
        stageId, judgeId, teamId: item.teamId, dimension: item.dimension,
        rawScore: item.rawScore, requestId, calibrated: 0, now,
      });
      written.push(row);
      bucket.added.push(item.rawScore);
    }
  }

  // 增量更新 score_stats（stdev 由 sum_sq 现算）
  for (const [dimension, bucket] of byDimension) {
    applyScoreStatDelta(db, { judgeId, dimension, added: bucket.added, removed: bucket.removed, now });
  }

  writeAuditLog(db, {
    actorId: judgeId, action: 'review.submit', entity: 'stage', entityId: stageId,
    detail: { requestId, count: items.length }, now,
  });

  return { stageId, judgeId, requestId, submitted: written.length, items: written };
}

/** 评分进度：已交 / 应交 / 缺谁 / 维度进度 */
export function getReviewState({ db, stageId, viewer }) {
  const seat = viewer?.userId ? getStageJudge(db, stageId, viewer.userId) : null;
  const isAdmin = viewer?.isAdmin === true;
  const all = listReviews(db, { stageId });
  const cells = listReviewCells(db, stageId);
  const teams = [...new Set(cells.map((c) => c.team_id))].sort();
  const dimensions = [...new Set(cells.map((c) => c.dimension))].sort();
  const judges = listStageJudges(db, stageId).filter((j) => j.seat !== 'observer');

  const dimensionProgress = {};
  for (const dim of dimensions) {
    const total = isAdmin ? judges.length * teams.length : teams.length;
    const submitted = all.filter((r) => r.dimension === dim && (isAdmin || r.judge_id === viewer.userId)).length;
    dimensionProgress[dim] = { submitted, total };
  }

  const missing = [];
  if (isAdmin) {
    for (const j of judges) {
      for (const t of teams) {
        for (const dim of dimensions) {
          const hit = all.find((r) => r.judge_id === j.user_id && r.team_id === t && r.dimension === dim);
          if (!hit) missing.push({ judgeId: j.user_id, teamId: t, dimension: dim });
        }
      }
    }
  } else if (seat) {
    for (const t of teams) {
      for (const dim of dimensions) {
        const hit = all.find((r) => r.judge_id === viewer.userId && r.team_id === t && r.dimension === dim);
        if (!hit) missing.push({ teamId: t, dimension: dim });
      }
    }
  }

  const submitted = isAdmin ? all.length : all.filter((r) => r.judge_id === viewer?.userId).length;
  const total = isAdmin ? judges.length * teams.length * dimensions.length : teams.length * dimensions.length;
  return { submitted, total, missing, dimensionProgress };
}

/** 校准打分（R-JDG-12）：写 calibrations，【不计入评分】 */
export function submitCalibration({ db, stageId, judgeId, items = [], now }) {
  assertVotingJudge(db, stageId, judgeId);
  for (const item of items) {
    insertCalibration(db, { stageId, judgeId, dimension: item.dimension, rawScore: item.rawScore, now });
  }
  writeAuditLog(db, {
    actorId: judgeId, action: 'review.calibrate', entity: 'stage', entityId: stageId,
    detail: { count: items.length }, now,
  });
  return { stageId, judgeId, submitted: items.length };
}

/** 企业确认（R2 双签 + R-JDG-14 签字必须有内容） */
export function submitEnterpriseConfirmation({ db, stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId = null, signatoryUserId = null, content = '', now }) {
  // R-JDG-14：空白签字不予采信
  if (!content || !String(content).trim()) {
    throw fail(400, 'SIGNATURE_CONTENT_REQUIRED', '企业签字必须填写内容（解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色）');
  }
  const row = insertEnterpriseConfirmation(db, {
    stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content, now,
  });
  writeAuditLog(db, {
    actorId: signatoryUserId, action: 'enterprise.confirm', entity: 'team', entityId: teamId,
    detail: { stageId, dimension, rawScore, hasCrossJudge: !!crossJudgeId }, now,
  });
  return row;
}

/** 互评（幂等；资格由 checkPeerEligibility 把关） */
export function submitPeerReviews({ db, stageId, items = [], requestId = null, now }) {
  const fromTeams = [...new Set(items.map((i) => i.fromTeamId))].sort();
  if (requestId) {
    const subject = fromTeams.join('+');
    const claimed = claimRequestKey(db, { scope: 'peer_review', stageId, subjectId: subject, requestId, now });
    if (!claimed) {
      const prior = fromTeams.flatMap((f) => findPeerReviewsByRequestId(db, { stageId, fromTeamId: f, requestId }));
      return { stageId, submitted: 0, items: prior };
    }
  }

  // R-RNK-07：只对该赛段有真实交付物的队伍开放互评
  // P2 阶段以「该赛段已有评委打分记录」作为「有真实交付物」的判据；
  // P5 的任务清单落地后改为按交付物表判定（改这一处即可）。
  const scoredTeams = [...new Set(listReviews(db, { stageId }).map((r) => r.team_id))].sort();
  const eligibility = checkPeerEligibility({
    teams: scoredTeams.map((teamId) => ({ teamId })),
    deliverables: scoredTeams.map((teamId) => ({ teamId, hasRealDeliverable: true })),
  });
  const eligible = new Set(eligibility.eligible);

  const written = [];
  for (const item of items) {
    if (item.fromTeamId === item.toTeamId) {
      throw fail(400, 'SELF_PEER_REVIEW', '不能给自己互评');
    }
    if (!eligible.has(item.fromTeamId) || !eligible.has(item.toTeamId)) {
      throw fail(403, 'PEER_REVIEW_INELIGIBLE', '只有该赛段有真实交付物的队伍可参与互评');
    }
    const existing = findPeerReview(db, { stageId, fromTeamId: item.fromTeamId, toTeamId: item.toTeamId });
    if (existing) {
      updatePeerReviewScore(db, { id: existing.id, score: item.score, now });
      written.push(existing);
    } else {
      written.push(insertPeerReview(db, {
        stageId, fromTeamId: item.fromTeamId, toTeamId: item.toTeamId, score: item.score, requestId, now,
      }));
    }
  }

  writeAuditLog(db, {
    actorId: null, action: 'peer_review.submit', entity: 'stage', entityId: stageId,
    detail: { requestId, count: items.length }, now,
  });
  return { stageId, submitted: written.length, items: written };
}

/** 自评测（幂等） */
export function submitSelfReviews({ db, stageId, teamId, items = [], requestId = null, now }) {
  if (requestId) {
    const claimed = claimRequestKey(db, { scope: 'self_review', stageId, subjectId: teamId, requestId, now });
    if (!claimed) {
      const prior = findSelfReviewsByRequestId(db, { stageId, teamId, requestId });
      return { stageId, teamId, submitted: 0, items: prior };
    }
  }
  const written = [];
  for (const item of items) {
    const existing = findSelfReview(db, { stageId, teamId, dimension: item.dimension });
    if (existing) {
      updateSelfReviewScore(db, { id: existing.id, rawScore: item.rawScore, now });
      written.push(existing);
    } else {
      written.push(insertSelfReview(db, {
        stageId, teamId, dimension: item.dimension, rawScore: item.rawScore, requestId, now,
      }));
    }
  }
  writeAuditLog(db, {
    actorId: null, action: 'self_review.submit', entity: 'team', entityId: teamId,
    detail: { requestId, count: items.length }, now,
  });
  return { stageId, teamId, submitted: written.length, items: written };
}

/** 回避申报（R-JDG-09）：必须留档 */
export function declareRecusal({ db, stageId, judgeId, teamId = null, reason, actorId = null, now }) {
  if (!reason || !String(reason).trim()) {
    throw fail(400, 'RECUSAL_REASON_REQUIRED', '回避必须填写原因（供应方 / 投资方 / 前雇主）');
  }
  const row = insertRecusal(db, {
    stageId, judgeId, teamId, reason, source: 'declared', auditBy: actorId, action: 'recused', now,
  });
  writeAuditLog(db, {
    actorId: actorId ?? judgeId, action: 'recusal.declare', entity: 'stage', entityId: stageId,
    detail: { judgeId, teamId, reason }, now,
  });
  return row;
}

export { listRecusals, listReviews, listEnterpriseConfirmations };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/review-service.test.js`
Expected: PASS（10 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/db/repo src/audit/log.js src/services/review.js test/review-service.test.js
git commit -m "feat(P2): 评分提交服务（幂等 + 增量 score_stats + 校准/互评/自评/回避）"
```

---

### Task 7: 加时陈述与一票破同分（tiebreak_round / tiebreak_votes）

**Files:**
- Create: `platform/src/db/repo/tiebreak.js`
- Create: `platform/src/services/tiebreak.js`
- Create: `platform/test/tiebreak.test.js`

**Interfaces:**
- Consumes: Task 1 的 `tiebreak_round` / `tiebreak_votes` 表
- Produces:
  - `openTiebreakRound({ db, stageId, tiedTeamIds, statementMinutes, actorId, now })` → round
  - `castTiebreakVote({ db, roundId, voterId, teamId, score, now })` → vote
  - `closeTiebreakRound({ db, roundId, actorId, now })` → `{ round, tallies }`
  - `getTiebreakRoundState({ db, roundId })` → `{ round, votes, tallies }`
  - `getTiebreakExtraScores({ db, stageId, teamIds })` → `{ [teamId]: 加时陈述复议分 }`（供 P3 的破同分链 `tiebreak_extra` 项消费）

- [ ] **Step 1: 写失败的测试**

`platform/test/tiebreak.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import {
  openTiebreakRound,
  castTiebreakVote,
  closeTiebreakRound,
  getTiebreakRoundState,
  getTiebreakExtraScores,
} from '../src/services/tiebreak.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const NOW = '2026-10-20T10:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tb-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const admin = createUser(db, { name: '组委会', phone: '13900000021', password: 'pw' });
  const voter = createUser(db, { name: '评委甲', phone: '13900000022', password: 'pw' });
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES ('s1', 'ed1', 's1', '决赛', 'final', '2026-10-26', '2026-10-28', 'final', 'open')`,
  ).run();
  return { db, close, dataDir, admin, voter };
}

test('开启加时陈述轮次：同分组 + 10 分钟陈述截止', () => {
  const { db, close, dataDir, admin } = setup();
  const round = openTiebreakRound({
    db, stageId: 's1', tiedTeamIds: ['t1', 't2'], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.equal(round.kind, 'statement');
  assert.equal(round.status, 'open');
  assert.deepEqual(JSON.parse(round.tied_team_ids_json), ['t1', 't2']);
  assert.equal(round.statement_deadline, '2026-10-20T10:10:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('一人一票：同一 (轮次, 投票人, 队伍) 第二次投票被数据库拒绝', () => {
  const { db, close, dataDir, admin, voter } = setup();
  const round = openTiebreakRound({
    db, stageId: 's1', tiedTeamIds: ['t1', 't2'], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't1', score: 80, now: NOW });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't1', score: 90, now: NOW }),
    (err) => err.status === 409,
    '重复投票必须被拒绝（唯一约束保证）',
  );
  // 同一人对另一支队伍投票是允许的
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't2', score: 70, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tiebreak_votes').get().n, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('轮次状态与票数统计', () => {
  const { db, close, dataDir, admin, voter } = setup();
  const round = openTiebreakRound({
    db, stageId: 's1', tiedTeamIds: ['t1', 't2'], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't1', score: 80, now: NOW });
  const state = getTiebreakRoundState({ db, roundId: round.id });
  assert.equal(state.votes.length, 1);
  assert.equal(state.tallies.t1.count, 1);
  assert.ok(Math.abs(state.tallies.t1.mean - 80) < 1e-12);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('关闭轮次后不能继续投票', () => {
  const { db, close, dataDir, admin, voter } = setup();
  const round = openTiebreakRound({
    db, stageId: 's1', tiedTeamIds: ['t1', 't2'], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't1', score: 80, now: NOW }),
    (err) => err.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('加时陈述复议分可供破同分链消费', () => {
  const { db, close, dataDir, admin, voter } = setup();
  const round = openTiebreakRound({
    db, stageId: 's1', tiedTeamIds: ['t1', 't2'], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't1', score: 80, now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 't2', score: 60, now: NOW });
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  const extra = getTiebreakExtraScores({ db, stageId: 's1', teamIds: ['t1', 't2'] });
  assert.ok(Math.abs(extra.t1 - 80) < 1e-12);
  assert.ok(Math.abs(extra.t2 - 60) < 1e-12);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/tiebreak.test.js`
Expected: FAIL —— `Cannot find module '../src/services/tiebreak.js'`

- [ ] **Step 3: 创建 src/db/repo/tiebreak.js**

```javascript
// src/db/repo/tiebreak.js — 加时陈述轮次与投票
import { randomUUID } from 'node:crypto';

export function insertTiebreakRound(db, { stageId, kind = 'statement', tiedTeamIds, statementDeadline, voteDeadline = null, createdBy, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, vote_deadline, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(id, stageId, kind, JSON.stringify(tiedTeamIds), statementDeadline, voteDeadline, createdBy, now);
  return getTiebreakRound(db, id);
}

export function getTiebreakRound(db, id) {
  return db.prepare('SELECT * FROM tiebreak_round WHERE id = ?').get(id) ?? null;
}

export function listTiebreakRounds(db, { stageId, status = null } = {}) {
  if (status) {
    return db.prepare('SELECT * FROM tiebreak_round WHERE stage_id = ? AND status = ? ORDER BY created_at').all(stageId, status);
  }
  return db.prepare('SELECT * FROM tiebreak_round WHERE stage_id = ? ORDER BY created_at').all(stageId);
}

export function closeTiebreakRoundRow(db, id, now) {
  db.prepare("UPDATE tiebreak_round SET status = 'closed' WHERE id = ?").run(id);
  return getTiebreakRound(db, id);
}

/**
 * 写入一票。
 * ⛔ 依赖主键 (tiebreak_round_id, voter_id, team_id) 保证「一人一票」——
 *    应用层「先查再插」在并发下会插出两票（设计文档 §6.4【决策】）。
 */
export function insertTiebreakVote(db, { roundId, voterId, teamId, score, now }) {
  db.prepare(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(roundId, voterId, teamId, score, now);
  return db.prepare('SELECT * FROM tiebreak_votes WHERE tiebreak_round_id = ? AND voter_id = ? AND team_id = ?')
    .get(roundId, voterId, teamId);
}

export function listTiebreakVotes(db, roundId) {
  return db.prepare('SELECT * FROM tiebreak_votes WHERE tiebreak_round_id = ? ORDER BY voter_id, team_id').all(roundId);
}
```

- [ ] **Step 4: 创建 src/services/tiebreak.js**

```javascript
// src/services/tiebreak.js — 加时陈述与一票破同分
//
// 依据：S7 §3.3（R-JDG-19 同分加时陈述：决赛同分 → 10 分钟加时陈述 → 企业席+评委席共同复议
//       → 仍同分按企业确认原始分）+ 设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束。
import {
  insertTiebreakRound,
  getTiebreakRound,
  listTiebreakRounds,
  closeTiebreakRoundRow,
  insertTiebreakVote,
  listTiebreakVotes,
} from '../db/repo/tiebreak.js';
import { writeAuditLog } from '../audit/log.js';

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** 开启一轮加时陈述（S7 §3.3：10 分钟） */
export function openTiebreakRound({ db, stageId, tiedTeamIds = [], statementMinutes = 10, actorId, now }) {
  if (!tiedTeamIds.length) throw fail(400, 'NO_TIED_TEAMS', '没有同分队伍，无需加时陈述');
  const round = insertTiebreakRound(db, {
    stageId,
    kind: 'statement',
    tiedTeamIds,
    statementDeadline: addMinutes(now, statementMinutes),
    createdBy: actorId,
    now,
  });
  writeAuditLog(db, {
    actorId, action: 'tiebreak.open', entity: 'stage', entityId: stageId,
    detail: { roundId: round.id, tiedTeamIds }, now,
  });
  return round;
}

/** 投票（一人一票由数据库主键保证） */
export function castTiebreakVote({ db, roundId, voterId, teamId, score, now }) {
  const round = getTiebreakRound(db, roundId);
  if (!round) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  if (round.status !== 'open') throw fail(409, 'TIEBREAK_ROUND_CLOSED', '该轮加时陈述已关闭');
  const tied = JSON.parse(round.tied_team_ids_json);
  if (!tied.includes(teamId)) throw fail(400, 'TEAM_NOT_IN_TIE_GROUP', '该队伍不在同分组中');
  try {
    return insertTiebreakVote(db, { roundId, voterId, teamId, score, now });
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      throw fail(409, 'DUPLICATE_TIEBREAK_VOTE', '同一人对同一队伍只能投一次');
    }
    throw err;
  }
}

function tally(votes) {
  const buckets = new Map();
  for (const v of votes) {
    if (!buckets.has(v.team_id)) buckets.set(v.team_id, []);
    buckets.get(v.team_id).push(v.score);
  }
  const out = {};
  for (const [teamId, scores] of buckets) {
    out[teamId] = {
      count: scores.length,
      sum: scores.reduce((a, b) => a + b, 0),
      mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    };
  }
  return out;
}

export function getTiebreakRoundState({ db, roundId }) {
  const round = getTiebreakRound(db, roundId);
  if (!round) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  const votes = listTiebreakVotes(db, roundId);
  return { round, votes, tallies: tally(votes) };
}

export function closeTiebreakRound({ db, roundId, actorId, now }) {
  const round = closeTiebreakRoundRow(db, roundId, now);
  const votes = listTiebreakVotes(db, roundId);
  writeAuditLog(db, {
    actorId, action: 'tiebreak.close', entity: 'stage', entityId: round.stage_id,
    detail: { roundId, votes: votes.length }, now,
  });
  return { round, tallies: tally(votes) };
}

/** 加时陈述复议分（供 P3 的破同分链 tiebreak_extra 项消费） */
export function getTiebreakExtraScores({ db, stageId, teamIds = [] }) {
  const rounds = listTiebreakRounds(db, { stageId });
  const scores = {};
  for (const round of rounds) {
    const votes = listTiebreakVotes(db, round.id);
    const t = tally(votes);
    for (const [teamId, bucket] of Object.entries(t)) {
      if (teamIds.length && !teamIds.includes(teamId)) continue;
      // 同一队多轮取最新一轮
      scores[teamId] = bucket.mean;
    }
  }
  return scores;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/tiebreak.test.js`
Expected: PASS（5 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/db/repo/tiebreak.js src/services/tiebreak.js test/tiebreak.test.js
git commit -m "feat(P2): 加时陈述轮次与一票破同分（数据库唯一约束保证一人一票）"
```

---

### Task 8: `scoreStage` 总装 + `compute` 服务 + 评审 API

**Files:**
- Create: `platform/src/domain/scoring.js`
- Create: `platform/src/services/compute.js`
- Create: `platform/src/db/repo/computations.js`
- Create: `platform/src/http/routes/review.js`
- Modify: `platform/rules/scoring-initial.json`、`platform/rules/scoring-final.json`（加 `judgePool` / `freeBrief` / 归一化策略参数）
- Modify: `platform/src/config.js`（校验新增字段，fail-fast）
- Modify: `platform/src/server.js`（注册评审路由）
- Create: `platform/test/scoring.test.js`
- Create: `platform/test/compute.test.js`

**Interfaces:**
- Consumes: Task 2 `normalizeScores`、Task 3 `trimOutliers` / `seatScore`、Task 4 `applyEnterpriseRules`、Task 5 `detectSelfEvalDiff`、Task 6 服务与仓储
- Produces:
  - `scoreStage({ config, judges, submissions, enterpriseConfirmations, peerReviews, teams, selfReviews })`
    → `{ teams: [{ teamId, seatP, seatE, total, perDimension: { key: { weight, raw, z, mean } } }],
         warnings: [{ code, message, teamId?, dimension? }],
         trace: { normalization, steps, weights, perTeam } }`
    - ⚠️ **入参对象里不存在行为分字段**：调用方即使传 `behaviorScore` 也会被丢弃（S10 §8 分轨在算法层）
  - `computeStage({ db, stageId, actorId, now, rules })` → `{ computationId, teams, warnings, trace }`
    - 写 `computation_snapshots`（input + output + trace 三件套）+ `stage_results`
    - **显式动作，不自动触发**（发榜影响奖金，必须有明确操作者与时间戳）
  - 9 条 API（见下）

- [ ] **Step 1: 写失败的测试**

`platform/test/scoring.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreStage } from '../src/domain/scoring.js';

// 初赛权重表（S7 §2.1；w_E = 10%，依据冲突裁决 C-01）
const CONFIG = {
  id: 'scoring-initial',
  wEnterprise: 0.10,
  normalizationStrategy: 'zscore',
  minSamplesForJudgeNormalization: 5,
  trimOutliers: true,
  minJudgesForTrim: 5,
  selfEvalThreshold: 10,
  freeBrief: { judgeDimension: 'track_fit' },
  dimensions: [
    { key: 'track_fit', weight: 0.10, seat: 'judge' },
    { key: 'innovation', weight: 0.20, seat: 'judge' },
    { key: 'feasibility', weight: 0.20, seat: 'judge' },
    { key: 'completeness', weight: 0.25, seat: 'judge' },
    { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    { key: 'collaboration', weight: 0.15, seat: 'judge' },
  ],
};

const JUDGES = [{ judgeId: 'j1', seat: 'judge' }, { judgeId: 'j2', seat: 'judge' }];

const SUBMISSIONS = [
  { judgeId: 'j1', teamId: 't1', dimension: 'track_fit', rawScore: 80 },
  { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 90 },
  { judgeId: 'j1', teamId: 't1', dimension: 'feasibility', rawScore: 70 },
  { judgeId: 'j1', teamId: 't1', dimension: 'completeness', rawScore: 100 },
  { judgeId: 'j1', teamId: 't1', dimension: 'collaboration', rawScore: 60 },
  { judgeId: 'j1', teamId: 't2', dimension: 'track_fit', rawScore: 70 },
  { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 80 },
  { judgeId: 'j1', teamId: 't2', dimension: 'feasibility', rawScore: 80 },
  { judgeId: 'j1', teamId: 't2', dimension: 'completeness', rawScore: 90 },
  { judgeId: 'j1', teamId: 't2', dimension: 'collaboration', rawScore: 70 },
  { judgeId: 'j2', teamId: 't1', dimension: 'track_fit', rawScore: 60 },
  { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 70 },
  { judgeId: 'j2', teamId: 't1', dimension: 'feasibility', rawScore: 60 },
  { judgeId: 'j2', teamId: 't1', dimension: 'completeness', rawScore: 80 },
  { judgeId: 'j2', teamId: 't1', dimension: 'collaboration', rawScore: 50 },
  { judgeId: 'j2', teamId: 't2', dimension: 'track_fit', rawScore: 50 },
  { judgeId: 'j2', teamId: 't2', dimension: 'innovation', rawScore: 60 },
  { judgeId: 'j2', teamId: 't2', dimension: 'feasibility', rawScore: 50 },
  { judgeId: 'j2', teamId: 't2', dimension: 'completeness', rawScore: 70 },
  { judgeId: 'j2', teamId: 't2', dimension: 'collaboration', rawScore: 40 },
];

const TEAMS = [
  { teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false },
  { teamId: 't2', packageEnterpriseId: 'E1', isFreeBrief: false },
];

const CONFIRMATIONS = [
  { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: '解决了库存周转' },
];

test('总分 = (1−w_E)×P + w_E×E，初赛 w_E = 0.10（冲突裁决 C-01）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  // 样本不足 → 退回全局口径 → 维度分退化为原始分均值
  // P = (0.10*70 + 0.20*80 + 0.20*65 + 0.25*90 + 0.15*55) / 0.90 = 66.75/0.9
  assert.ok(Math.abs(t1.seatP - 74.166666667) < 1e-6, `seatP=${t1.seatP}`);
  assert.equal(t1.seatE, 80);
  assert.ok(Math.abs(t1.total - 74.75) < 1e-6, `total=${t1.total}`);
  assert.ok(Math.abs(t1.total - (1 - 0.10) * t1.seatP - 0.10 * t1.seatE) < 1e-9);
});

test('⭐ 行为分变化不影响总分（S10 §8：分轨必须是算法层面的，不是纪律层面的）', () => {
  const a = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const b = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS,
    behaviorScore: 999, behaviorPoints: 999, behavior: { total: 999 },
  });
  assert.deepEqual(b.teams, a.teams, '传入行为分不得改变任何队伍的总分');
  assert.deepEqual(b.warnings, a.warnings);
});

test('trace 具备 normalization / steps / weights / perTeam 四段', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.trace.normalization.track_fit);
  assert.equal(r.trace.normalization.track_fit.normalized, false);
  assert.equal(r.trace.normalization.track_fit.fallbackReason, 'judge_sample_too_small');
  assert.equal(r.trace.normalization.track_fit.judgeSampleSizes.j1, 2);
  assert.ok(Array.isArray(r.trace.steps));
  assert.ok(r.trace.steps.some((s) => s.step === 'trim' && s.dimension === 'track_fit'));
  assert.equal(r.trace.weights.enterprise, 0.10);
  assert.ok(r.trace.perTeam.t1);
  assert.ok(Math.abs(r.trace.perTeam.t1.seatP - 74.166666667) < 1e-6);
});

test('降级必须显式：样本不足进 warnings，不静默', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.warnings.some((w) => w.code === 'normalization_fallback' && w.dimension === 'track_fit'));
});

test('R2 缺双签 → 企业席 0 分 + warning，权重保留', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [{ ...CONFIRMATIONS[0], crossJudgeId: null }],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 0);
  assert.ok(r.warnings.some((w) => w.code === 'R2_missing_dual_signature'));
});

test('R1 非本赛道 → 企业项权重降为 0，总分不再含企业席', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [{ ...CONFIRMATIONS[0], enterpriseId: 'E9' }],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 0);
  assert.ok(Math.abs(t1.total - t1.seatP) < 1e-9, 'R1 后总分 = 评委席分');
  assert.ok(r.warnings.some((w) => w.code === 'R1_out_of_track'));
});

test('没有企业确认 → 0 分 + warning（不静默当 0）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: [], teams: TEAMS });
  const t2 = r.teams.find((t) => t.teamId === 't2');
  assert.equal(t2.seatE, 0);
  assert.ok(r.warnings.some((w) => w.code === 'no_enterprise_confirmation' && w.teamId === 't2'));
});

test('样本足够时走真归一化：已知评委矩阵 → 期望维度分', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.8, seat: 'judge' },
      { key: 'enterprise', weight: 0.2, seat: 'enterprise' },
    ],
  };
  const ser = {
    j1: [60, 65, 70, 75, 80],
    j2: [55, 60, 65, 70, 75],
    j3: [70, 70, 70, 70, 70],
    j4: [50, 60, 70, 80, 90],
    j5: [58, 63, 68, 73, 78],
  };
  const teams5 = ['t1', 't2', 't3', 't4', 't5'];
  const subs = [];
  for (const [j, arr] of Object.entries(ser)) {
    teams5.forEach((teamId, i) => subs.push({ judgeId: j, teamId, dimension: 'innovation', rawScore: arr[i] }));
  }
  const r = scoreStage({
    config: cfg,
    judges: Object.keys(ser).map((judgeId) => ({ judgeId, seat: 'judge' })),
    submissions: subs,
    enterpriseConfirmations: [],
    teams: teams5.map((teamId) => ({ teamId, packageEnterpriseId: 'E1', isFreeBrief: false })),
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  // 全局均值 68.6、全局标准差 8.770214745；t1 截尾后 z 均值 -1.264911064
  // → 维度分 = 68.6 + (-1.264911064) * 8.770214745 = 57.506458335
  assert.ok(Math.abs(t1.perDimension.innovation.mean - 57.506458335) < 1e-6, `实际 ${t1.perDimension.innovation.mean}`);
  assert.ok(Math.abs(t1.seatP - 57.506458335) < 1e-6);
  // j3 恒定 70 → stdev=0 → z=0 且必须显式标记
  assert.equal(r.trace.normalization.innovation.judgeReasons.j3, 'zero_stdev');
  assert.ok(r.warnings.some((w) => w.code === 'normalization_fallback'));
});

test('自评测 d > 10 → 对齐评委分（不加分）+ warning；d < -10 → 只提问', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.9, seat: 'judge' },
      { key: 'enterprise', weight: 0.1, seat: 'enterprise' },
    ],
  };
  const subs = [
    { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
  ];
  const r = scoreStage({
    config: cfg, judges: JUDGES, submissions: subs, enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
  });
  assert.ok(r.warnings.some((w) => w.code === 'self_eval_written_explanation' && w.teamId === 't1'));
});

test('评委池缺失 → 记 warning，绝不静默', () => {
  const r = scoreStage({ config: CONFIG, judges: [], submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.warnings.some((w) => w.code === 'judge_roster_missing'));
});
```

`platform/test/compute.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { loadRules } from '../src/config.js';
import { computeStage } from '../src/services/compute.js';
import { createRouter } from '../src/http/router.js';
import { registerReviewRoutes } from '../src/http/routes/review.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-cmp-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const judge = createUser(db, { name: '评委甲', phone: '13900000031', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000032', password: 'pw' });
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES ('s1', 'ed1', 's1', '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  ).run();
  db.prepare(
    'INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('s1', judge.id, 'judge', 'global', null, NOW);
  return { db, close, dataDir, rules, judge, admin };
}

test('computeStage 写快照三件套 + stage_results', () => {
  const { db, close, dataDir, rules, admin, judge } = setup();
  db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
     VALUES ('r1', 's1', ?, 't1', 'innovation', 80, ?)`,
  ).run(judge.id, NOW);

  const res = computeStage({ db, stageId: 's1', actorId: admin.id, now: NOW, rules });
  assert.ok(res.computationId);
  assert.ok(Array.isArray(res.teams));

  const snap = db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(res.computationId);
  assert.ok(snap.input_json, '必须有 input');
  assert.ok(snap.output_json, '必须有 output');
  assert.ok(snap.trace_json, '必须有 trace');
  assert.equal(snap.revision, 1);
  const trace = JSON.parse(snap.trace_json);
  assert.ok(trace.normalization);
  assert.ok(trace.weights);

  const row = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get('s1', 't1');
  assert.equal(row.computation_id, res.computationId);
  assert.equal(row.rank, null, '名次由 P3 填');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复 compute → revision 递增（可复算的历史留档）', () => {
  const { db, close, dataDir, rules, admin } = setup();
  const a = computeStage({ db, stageId: 's1', actorId: admin.id, now: NOW, rules });
  const b = computeStage({ db, stageId: 's1', actorId: admin.id, now: NOW, rules });
  const revs = db.prepare('SELECT revision FROM computation_snapshots ORDER BY revision').all().map((r) => r.revision);
  assert.deepEqual(revs, [1, 2]);
  assert.notEqual(a.computationId, b.computationId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('compute 路由已注册且计算快照可读', () => {
  const { db, close, dataDir, rules, admin } = setup();
  const router = createRouter();
  registerReviewRoutes(router);
  const paths = router.list().map((r) => `${r.method} ${r.pattern}`);
  for (const p of [
    'POST /api/stages/:stageId/reviews',
    'GET /api/stages/:stageId/review-state',
    'POST /api/stages/:stageId/calibration',
    'POST /api/stages/:stageId/peer-reviews',
    'POST /api/stages/:stageId/self-review',
    'POST /api/stages/:stageId/compute',
    'GET /api/stages/:stageId/computations/:computationId',
    'POST /api/stages/:stageId/recusals',
    'POST /api/stages/:stageId/enterprise-confirmations',
  ]) {
    assert.ok(paths.includes(p), `缺路由 ${p}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/scoring.test.js test/compute.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/scoring.js'`

- [ ] **Step 3: 创建 src/domain/scoring.js**

```javascript
// src/domain/scoring.js — 赛段评分总装（★ 全项目最重要的纯函数）
//
// 依据：设计文档 §6.2 Step 1–10 + §12 trace 结构 + S7 §3.1 / §3.2 / §3.3 / §4.3。
//   需求：R-JDG-01（初赛/决赛两套权重表）｜R-JDG-04（双席加权总分 (1−w_E)×P + w_E×E）
//        ｜R-JDG-13（自评测差异检测）｜R-JDG-19（加时陈述复议分进 trace）
//
// ⛔ 行为分（behavior score）在本模块【完全不参与】：
//   S10 §8 第三条风险原文：「行为分被当成主评分……⭐ 算法层面强制分离，不依赖人的自觉」
//   「分轨必须是算法层面的，不是纪律层面的」。
//   → 实现方式：入参对象里【根本不存在】行为分字段；本函数只解构白名单字段，
//     调用方即使传入 behaviorScore / behaviorPoints 也会被丢弃。
//     对应的单元测试见 test/scoring.test.js「行为分变化不影响总分」。
//
// 【尺度说明】P 与 E 必须在同一尺度上，S7 §3.1 的 z 单位与企业席分（0–100）不可通约。
//   本实现把 z 还原回 0–100 再加权：维度分 = 全局均值 + 截尾 z 均值 × 全局标准差。
//   当评委完全同质时该式退化为原始分均值（详见 src/domain/trim.js 顶部说明）。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

import { normalizeScores } from './normalization.js';
import { trimOutliers, seatScore } from './trim.js';
import { applyEnterpriseRules } from './enterprise-seat.js';
import { detectSelfEvalDiff } from './self-eval.js';

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * @param {object} input
 * @param {object} input.config rules.scoring.initial | rules.scoring.final
 * @param {Array<{judgeId:string, seat:string}>} input.judges 评委池
 * @param {Array<{judgeId:string, teamId:string, dimension:string, rawScore:number}>} input.submissions
 * @param {Array} input.enterpriseConfirmations 企业确认（R2 双签）
 * @param {Array<{fromTeamId:string, toTeamId:string, score:number}>} input.peerReviews
 * @param {Array<{teamId:string, packageEnterpriseId:string|null, isFreeBrief:boolean}>} input.teams
 *   可选：R1 / R4 需要知道队伍的任务包归属与是否自由命题。缺失时相关判定跳过并记 warning。
 * @param {Array<{teamId:string, dimension:string, rawScore:number}>} input.selfReviews
 *   可选：决赛「自评测」维度需要。缺失时该维度无分并记 warning。
 */
export function scoreStage({
  config,
  judges = [],
  submissions = [],
  enterpriseConfirmations = [],
  peerReviews = [],
  teams = [],
  selfReviews = [],
} = {}) {
  // ⚠️ 刻意只解构白名单字段：任何行为分相关字段都不会进入本函数（分轨在算法层）
  const warnings = [];
  const steps = [];
  const normalization = {};
  const traceWeights = {};

  const dimensions = config?.dimensions ?? [];
  for (const d of dimensions) traceWeights[d.key] = d.weight;

  const judgeDims = dimensions.filter((d) => d.seat === 'judge');
  const enterpriseDims = dimensions.filter((d) => d.seat === 'enterprise');
  const selfDims = dimensions.filter((d) => d.seat === 'self');
  const pSeatKeys = [...judgeDims.map((d) => d.key), ...selfDims.map((d) => d.key)];

  // 评委池：观察员无投票权（R-JDG-11），其打分一律不计入
  const votingIds = new Set(judges.filter((j) => j.seat !== 'observer').map((j) => j.judgeId));
  if (!judges.length) {
    warnings.push({ code: 'judge_roster_missing', message: '没有评委池信息，宽严归一化无法判定，判定已跳过' });
  }

  // ── Step 1｜分组：按维度收集原始分 ──────────────────────────────────
  const byDim = new Map();
  for (const s of submissions) {
    if (!votingIds.has(s.judgeId)) continue;
    if (!byDim.has(s.dimension)) byDim.set(s.dimension, []);
    byDim.get(s.dimension).push(s);
  }

  // ── Step 2/3/4｜逐维度归一化 → 去极值 → 还原到 0–100 ────────────────
  const dimScores = new Map(); // dim -> Map(teamId -> { score, zMean, z, raw })
  for (const [dim, rows] of byDim) {
    const pool = [...new Set(rows.map((r) => r.judgeId))].sort();
    const dimTeams = [...new Set(rows.map((r) => r.teamId))].sort();

    const scoreOf = new Map(); // judgeId -> Map(teamId -> rawScore)
    const seriesOf = new Map(); // judgeId -> number[]（该评委在本维度对全部参赛队的分）
    for (const j of pool) {
      scoreOf.set(j, new Map());
      const series = [];
      for (const t of dimTeams) {
        const hit = rows.find((r) => r.judgeId === j && r.teamId === t);
        if (!hit) continue;
        scoreOf.get(j).set(t, hit.rawScore);
        series.push(hit.rawScore);
      }
      seriesOf.set(j, series);
    }

    const agg = { normalized: true, fallbackReason: null, judgeSampleSizes: {}, judgeReasons: {} };
    for (const j of pool) agg.judgeSampleSizes[j] = seriesOf.get(j).length;

    const perTeam = new Map();
    for (const teamId of dimTeams) {
      const samples = pool.map((j) => ({
        judgeId: j,
        value: scoreOf.get(j).get(teamId) ?? null,
        series: seriesOf.get(j),
      }));
      const res = normalizeScores({
        samples,
        strategy: config.normalizationStrategy ?? 'zscore',
        config,
      });

      for (const j of pool) {
        const st = res.judgeStats[j];
        if (st && st.fallbackReason) {
          agg.normalized = false;
          agg.judgeReasons[j] = st.fallbackReason;
          if (!agg.fallbackReason) agg.fallbackReason = st.fallbackReason;
        }
      }

      const zValues = pool
        .map((j) => ({ judgeId: j, z: res.values[j] }))
        .filter((v) => Number.isFinite(v.z));
      const trimmed = trimOutliers({ values: zValues, minJudges: config.minJudgesForTrim ?? 5 });
      // z 单位 → 原始分单位（与 E 同尺度，才能加权成一个总分）
      const score = clamp(res.stats.mean + trimmed.mean * res.stats.stdev, 0, 100);
      // 该队该维度的【原始分】均值（trace 的 raw 必须是原始分，不是 z）
      const rawScores = pool
        .map((j) => scoreOf.get(j).get(teamId))
        .filter((v) => Number.isFinite(v));

      steps.push({
        step: 'trim',
        dimension: dim,
        teamId,
        trimmed: trimmed.trimmed,
        removed: trimmed.removed,
      });

      perTeam.set(teamId, {
        score,
        zMean: trimmed.mean,
        z: res.values,
        raw: mean(rawScores),
      });
    }

    dimScores.set(dim, perTeam);
    normalization[dim] = agg;
    if (agg.fallbackReason) {
      const degraded = Object.entries(agg.judgeReasons).map(([j, r]) => `${j}:${r}`).join('、');
      warnings.push({
        code: 'normalization_fallback',
        message: `维度 ${dim} 评委宽严归一化降级（${degraded}）——本维度未按评委宽严做校正`,
        dimension: dim,
      });
    }
  }

  // ── Step 5｜企业席 E + R1/R2/R3/R4 ───────────────────────────────────
  const roster = teams.length
    ? teams
    : [...new Set([...byDim.values()].flat().map((r) => r.teamId))].map((teamId) => ({
        teamId,
        packageEnterpriseId: null,
        isFreeBrief: false,
      }));
  if (!teams.length) {
    warnings.push({
      code: 'team_roster_missing',
      message: '没有队伍名册（R1 / R4 需要任务包归属与自由命题标记），相关判定按「不适用」处理',
    });
  }
  const ent = applyEnterpriseRules({
    confirmations: enterpriseConfirmations,
    teams: roster,
    judges,
    config,
  });
  warnings.push(...ent.warnings);

  // ── Step 7｜自评测差异检测（R-JDG-13） ───────────────────────────────
  // ⛔ 检测不依赖权重表里有没有「自评测」维度：只要团队提交了自评，就要检测并留痕。
  const selfAligned = new Set();
  if (selfReviews.length) {
    const judgeScores = [];
    for (const [dim, perTeam] of dimScores) {
      for (const [teamId, cell] of perTeam) {
        judgeScores.push({ teamId, dimension: dim, score: cell.raw });
      }
    }
    const { flags } = detectSelfEvalDiff({
      selfReviews,
      judgeScores,
      threshold: config.selfEvalThreshold ?? 10,
    });
    for (const flag of flags) {
      if (flag.action === 'written_explanation') {
        // 须书面说明自评理由；不成立则自评分对齐评委分（不加分）
        selfAligned.add(`${flag.teamId}::${flag.dimension}`);
        warnings.push({
          code: 'self_eval_written_explanation',
          message: `自评分比评委分高 ${flag.d} 分，须提交书面说明；不成立则自评分对齐评委分（不加分）`,
          teamId: flag.teamId,
          dimension: flag.dimension,
        });
      } else {
        warnings.push({
          code: 'self_eval_judge_question',
          message: `自评分比评委分低 ${Math.abs(flag.d)} 分，评委须向团队提问（只提问，不改分）`,
          teamId: flag.teamId,
          dimension: flag.dimension,
        });
      }
    }
  }

  // ── 逐队装配（P 席 / E 席 / 总分） ───────────────────────────────────
  const teamIds = [
    ...new Set([
      ...[...byDim.values()].flat().map((r) => r.teamId),
      ...roster.map((t) => t.teamId),
    ]),
  ].sort();

  const peerByTeam = new Map();
  for (const p of peerReviews) {
    if (!peerByTeam.has(p.toTeamId)) peerByTeam.set(p.toTeamId, []);
    peerByTeam.get(p.toTeamId).push(p.score);
  }

  const teamsOut = [];
  for (const teamId of teamIds) {
    const effW = { ...(ent.weights[teamId] ?? {}) };
    for (const d of dimensions) if (effW[d.key] == null) effW[d.key] = d.weight;

    // R4：企业项由评委的「需求真实性」分替代
    let enterpriseScore = ent.seatE[teamId];
    const r4 = ent.r4Substitute[teamId];
    if (r4 && enterpriseScore === null) {
      const substitute = dimScores.get(r4.dimension)?.get(teamId)?.score ?? 0;
      enterpriseScore = substitute;
    }

    // 席位权重：企业席封顶（R3 已在 applyEnterpriseRules 内封顶）→ 评委席补足到 1 − w_E
    const eKeys = enterpriseDims.map((d) => d.key);
    let wE = eKeys.reduce((acc, k) => acc + (effW[k] ?? 0), 0);
    const cap = Number(config.wEnterprise ?? 0);
    if (wE > cap + 1e-12) wE = cap;
    let wP = pSeatKeys.reduce((acc, k) => acc + (effW[k] ?? 0), 0);
    const factor = wP > 0 ? (1 - wE) / wP : 0;
    for (const k of pSeatKeys) effW[k] = (effW[k] ?? 0) * factor;
    wP = 1 - wE;

    // 评委席 + 自评席的维度分
    const pScores = {};
    for (const k of pSeatKeys) {
      const cell = dimScores.get(k)?.get(teamId);
      if (cell) {
        pScores[k] = cell.score;
        continue;
      }
      // 自评维度：从自评测记录取分（必要时按对齐规则替换为评委分）
      const selfRows = selfReviews.filter((r) => r.teamId === teamId);
      const exact = selfRows.find((r) => r.dimension === k);
      if (exact) {
        pScores[k] = exact.rawScore;
      } else {
        let num = 0;
        let den = 0;
        for (const jd of judgeDims) {
          const row = selfRows.find((r) => r.dimension === jd.key);
          if (!row) continue;
          const judgeSide = dimScores.get(jd.key)?.get(teamId)?.score;
          const value = selfAligned.has(`${teamId}::${jd.key}`) && judgeSide != null ? judgeSide : row.rawScore;
          num += jd.weight * value;
          den += jd.weight;
        }
        if (den > 0) pScores[k] = num / den;
        else {
          warnings.push({
            code: 'dimension_no_scores',
            message: `队伍 ${teamId} 在维度 ${k} 上没有任何评分，该维度权重记 0`,
            teamId,
            dimension: k,
          });
        }
      }
      // 自评维度的分也要进 trace（否则发榜页看不到该维度的来由）
      if (pScores[k] != null && !dimScores.has(k)) dimScores.set(k, new Map());
      if (pScores[k] != null) {
        dimScores.get(k).set(teamId, { score: pScores[k], zMean: null, z: {}, raw: pScores[k] });
      }
    }

    // ⚠️ seatScore 的权重必须【只含本席位】的维度，否则另一席位的维度会被算成 missing
    const pWeights = {};
    for (const k of pSeatKeys) pWeights[k] = effW[k] ?? 0;
    const pSeat = seatScore({ dimensionScores: pScores, weights: pWeights });
    for (const missing of pSeat.missing) {
      warnings.push({
        code: 'dimension_no_scores',
        message: `队伍 ${teamId} 在维度 ${missing} 上没有任何评分，该维度权重记 0`,
        teamId,
        dimension: missing,
      });
    }
    const seatP = pSeat.score;

    let seatE = 0;
    if (wE > 0) {
      const eScores = {};
      const eWeights = {};
      for (const k of eKeys) {
        eScores[k] = enterpriseScore ?? 0;
        eWeights[k] = effW[k] ?? 0;
      }
      seatE = seatScore({ dimensionScores: eScores, weights: eWeights }).score;
    }

    // 总分 = (1 − w_E) × P + w_E × E（S7 §3.1；w_E 为该队生效值，R1 时为 0）
    const total = (1 - wE) * seatP + wE * seatE;

    const perDimension = {};
    for (const d of dimensions) {
      const cell = dimScores.get(d.key)?.get(teamId);
      const isEnterprise = d.seat === 'enterprise';
      perDimension[d.key] = {
        weight: effW[d.key] ?? 0,
        raw: isEnterprise ? (enterpriseScore ?? null) : (cell?.raw ?? null),
        z: isEnterprise ? null : (cell?.zMean ?? null),
        mean: isEnterprise ? (enterpriseScore ?? null) : (cell?.score ?? null),
      };
    }

    teamsOut.push({ teamId, seatP, seatE, total, perDimension });
  }

  // 没有任何评分的队伍不参与排名（设计文档 §11）
  for (const t of teamsOut) {
    const hasAny = Object.values(t.perDimension).some((d) => d.mean != null);
    if (!hasAny) {
      warnings.push({
        code: 'team_no_reviews',
        message: `队伍 ${t.teamId} 没有任何评分，不参与排名`,
        teamId: t.teamId,
      });
    }
  }

  const perTeam = {};
  for (const t of teamsOut) {
    const raw = {};
    const z = {};
    for (const [k, v] of Object.entries(t.perDimension)) {
      raw[k] = v.raw;
      z[k] = v.z;
    }
    perTeam[t.teamId] = {
      raw,
      z,
      seatP: t.seatP,
      seatE: t.seatE,
      total: t.total,
      peerScore: peerByTeam.has(t.teamId) ? mean(peerByTeam.get(t.teamId)) : null,
    };
  }

  return {
    teams: teamsOut,
    warnings,
    trace: { normalization, steps, weights: traceWeights, perTeam },
  };
}
```

- [ ] **Step 4: 创建 src/db/repo/computations.js**

```javascript
// src/db/repo/computations.js — 计算快照与赛段结果
import { randomUUID } from 'node:crypto';

export function nextRevision(db, { stageId, kind }) {
  const row = db
    .prepare('SELECT MAX(revision) AS rev FROM computation_snapshots WHERE stage_id = ? AND kind = ?')
    .get(stageId, kind);
  return (row?.rev ?? 0) + 1;
}

/** 三件套快照：input + output + trace（P4 的 recomputeAndDiff 依赖它重放） */
export function insertSnapshot(db, { kind, editionId = null, stageId = null, teamId = null, ruleVersion, input, output, trace, revision, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO computation_snapshots
       (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, editionId, stageId, teamId, ruleVersion, JSON.stringify(input), JSON.stringify(output), JSON.stringify(trace), revision, now);
  return id;
}

export function getSnapshot(db, id) {
  return db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(id) ?? null;
}

export function listSnapshots(db, { stageId, kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = ? ORDER BY revision').all(stageId, kind);
  }
  return db.prepare('SELECT * FROM computation_snapshots WHERE stage_id = ? ORDER BY revision').all(stageId);
}

/** 赛段结果：rank / tied_with / points 由 P3 填（P2 显式留空，不假装有名次） */
export function upsertStageResult(db, { stageId, teamId, total, seatP, seatE, computationId, now }) {
  db.prepare(
    `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, computation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (stage_id, team_id) DO UPDATE SET total = excluded.total, seat_p = excluded.seat_p,
       seat_e = excluded.seat_e, computation_id = excluded.computation_id, created_at = excluded.created_at`,
  ).run(randomUUID(), stageId, teamId, total, seatP, seatE, computationId, now);
  return db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stageId, teamId);
}
```

- [ ] **Step 5: 创建 src/services/compute.js**

```javascript
// src/services/compute.js — 赛段计算（显式动作）
//
// 依据：INTERFACES.md §3 + 设计文档 §8【决策】与 §12。
//   ⛔ compute 是【显式动作，不自动触发】：发榜影响奖金，必须有明确的操作者与时间戳。
//   每次计算产出三件套（input + output + trace）写入 computation_snapshots → 榜单可复算。
//   ⛔ 但计算用的是【原始数据全量重算】，不是 score_stats 增量值 —— 可复算要求能从原始数据重放。
import { getStage } from '../db/repo/stages.js';
import { listReviews } from '../db/repo/reviews.js';
import { listEnterpriseConfirmations } from '../db/repo/enterprise-confirmations.js';
import { listPeerReviews } from '../db/repo/peer-reviews.js';
import { listSelfReviews } from '../db/repo/self-reviews.js';
import { listRecusals } from '../db/repo/recusals.js';
import { listStageJudges } from '../db/repo/stages.js';
import { insertSnapshot, nextRevision, upsertStageResult, getSnapshot } from '../db/repo/computations.js';
import { writeAuditLog } from '../audit/log.js';
import { scoreStage } from '../domain/scoring.js';
import { checkRecusal } from '../domain/review-eligibility.js';

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** 队伍名册（需要 P1 的 teams / task_packages；表未就绪时返回空并由调用方记 warning） */
export function listStageTeams(db, stageId) {
  try {
    return db
      .prepare(
        `SELECT t.id AS team_id, tp.enterprise_id AS package_enterprise_id,
                COALESCE(tp.is_free_brief, 0) AS is_free_brief
         FROM teams t
         LEFT JOIN task_packages tp ON tp.id = t.task_package_id
         WHERE t.edition_id = (SELECT edition_id FROM stages WHERE id = ?)
           AND t.deleted_at IS NULL
         ORDER BY t.id`,
      )
      .all(stageId)
      .map((r) => ({
        teamId: r.team_id,
        packageEnterpriseId: r.package_enterprise_id ?? null,
        isFreeBrief: !!r.is_free_brief,
      }));
  } catch {
    return [];
  }
}

/**
 * 计算一个赛段的分数并落快照。
 * @param {object} input
 * @param {string} input.rules 规则集合（rules.scoring.initial / rules.scoring.final）
 */
export function computeStage({ db, stageId, actorId, now, rules }) {
  const stage = getStage(db, stageId);
  if (!stage) throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  if (!rules?.scoring) {
    // fail-fast：没有规则就不算，绝不用默认值凑一个榜单
    throw fail(500, 'RULES_MISSING', '缺少规则配置，拒绝计算');
  }
  const config = rules.scoring[stage.scoring_config_key];
  if (!config) throw fail(500, 'SCORING_CONFIG_MISSING', `赛段 ${stageId} 指向的权重表 ${stage.scoring_config_key} 不存在`);

  const judges = listStageJudges(db, stageId).map((j) => ({ judgeId: j.user_id, seat: j.seat }));

  // 回避的评委对该队的打分不计入（R-JDG-09）
  const recusalRecords = listRecusals(db, { stageId });
  const allReviews = listReviews(db, { stageId });
  const excluded = [];
  const submissions = [];
  for (const r of allReviews) {
    const check = checkRecusal({
      judge: { userId: r.judge_id },
      team: { teamId: r.team_id },
      recusalRecords,
    });
    if (check.recused) {
      excluded.push({ judgeId: r.judge_id, teamId: r.team_id, dimension: r.dimension });
      continue;
    }
    submissions.push({ judgeId: r.judge_id, teamId: r.team_id, dimension: r.dimension, rawScore: r.raw_score });
  }

  const teams = listStageTeams(db, stageId);
  const result = scoreStage({
    config,
    judges,
    submissions,
    enterpriseConfirmations: listEnterpriseConfirmations(db, { stageId }),
    peerReviews: listPeerReviews(db, stageId),
    teams,
    selfReviews: listSelfReviews(db, stageId),
  });

  if (excluded.length) {
    result.warnings.push({
      code: 'recusal_excluded',
      message: `因回避剔除 ${excluded.length} 条打分（记录见 recusal_records）`,
    });
  }

  // 三件套快照
  const revision = nextRevision(db, { stageId, kind: 'stage_score' });
  const input = {
    config,
    judges,
    submissions,
    enterpriseConfirmations: listEnterpriseConfirmations(db, { stageId }),
    peerReviews: listPeerReviews(db, stageId),
    selfReviews: listSelfReviews(db, stageId),
    teams,
    ruleVersion: config.version ?? 'unknown',
  };
  const computationId = insertSnapshot(db, {
    kind: 'stage_score',
    editionId: stage.edition_id,
    stageId,
    ruleVersion: config.version ?? 'unknown',
    input,
    output: { teams: result.teams, warnings: result.warnings },
    trace: result.trace,
    revision,
    now,
  });

  for (const t of result.teams) {
    upsertStageResult(db, {
      stageId, teamId: t.teamId, total: t.total, seatP: t.seatP, seatE: t.seatE, computationId, now,
    });
  }

  writeAuditLog(db, {
    actorId,
    action: 'stage.compute',
    entity: 'stage',
    entityId: stageId,
    detail: { computationId, revision, teams: result.teams.length, warnings: result.warnings.length },
    now,
  });

  return { computationId, teams: result.teams, warnings: result.warnings, trace: result.trace };
}

/** 读取计算快照（三件套） */
export function getComputation({ db, id }) {
  const row = getSnapshot(db, id);
  if (!row) throw fail(404, 'COMPUTATION_NOT_FOUND', '计算快照不存在');
  return {
    id: row.id,
    kind: row.kind,
    ruleVersion: row.rule_version,
    revision: row.revision,
    createdAt: row.created_at,
    input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json),
    trace: JSON.parse(row.trace_json),
  };
}
```

- [ ] **Step 6: 创建 src/http/routes/review.js**

```javascript
// src/http/routes/review.js — 评审 API
//
// 依据：INTERFACES.md §3「API（P2）」+ 设计文档 §8。
//   权限：capability + assignment（唯一入口 can()）。P2 阶段先做「登录 + 能力点」判定，
//   行级 scope 由 P3/P4 的 scopeClause 补齐。
import { json } from '../respond.js';
import {
  submitReviews,
  getReviewState,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  declareRecusal,
  submitEnterpriseConfirmation,
} from '../../services/review.js';
import { computeStage, getComputation } from '../../services/compute.js';

function requireUser(ctx) {
  if (!ctx.user) {
    const e = new Error('未登录');
    e.status = 401;
    e.code = 'UNAUTHENTICATED';
    throw e;
  }
  return ctx.user;
}

function requireCapability(ctx, capability) {
  requireUser(ctx);
  if (!ctx.can(capability, { scopeType: 'global' })) {
    const e = new Error(`缺少能力：${capability}`);
    e.status = 403;
    e.code = 'FORBIDDEN';
    throw e;
  }
}

export function registerReviewRoutes(router) {
  router.add('POST', '/api/stages/:stageId/reviews', async (ctx) => {
    requireCapability(ctx, 'score:write');
    return submitReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items: ctx.body?.items ?? [],
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
  });

  router.add('GET', '/api/stages/:stageId/review-state', async (ctx) => {
    requireUser(ctx);
    return getReviewState({ db: ctx.db, stageId: ctx.params.stageId, viewer: { userId: ctx.user.id, isAdmin: ctx.user.is_superadmin === 1 } });
  });

  router.add('POST', '/api/stages/:stageId/calibration', async (ctx) => {
    requireCapability(ctx, 'score:write');
    return submitCalibration({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items: ctx.body?.items ?? [],
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/peer-reviews', async (ctx) => {
    requireCapability(ctx, 'peer_review:write');
    return submitPeerReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      items: ctx.body?.items ?? [],
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/self-review', async (ctx) => {
    requireCapability(ctx, 'score:write');
    return submitSelfReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      teamId: ctx.body?.teamId,
      items: ctx.body?.items ?? [],
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/enterprise-confirmations', async (ctx) => {
    requireCapability(ctx, 'score:write');
    return submitEnterpriseConfirmation({
      db: ctx.db,
      stageId: ctx.params.stageId,
      teamId: ctx.body?.teamId,
      enterpriseId: ctx.body?.enterpriseId,
      dimension: ctx.body?.dimension ?? 'enterprise',
      rawScore: ctx.body?.rawScore,
      crossJudgeId: ctx.body?.crossJudgeId ?? null,
      signatoryUserId: ctx.body?.signatoryUserId ?? ctx.user.id,
      content: ctx.body?.content ?? '',
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/recusals', async (ctx) => {
    requireCapability(ctx, 'score:write');
    return declareRecusal({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.body?.judgeId ?? ctx.user.id,
      teamId: ctx.body?.teamId ?? null,
      reason: ctx.body?.reason,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
  });

  // ⛔ compute 是显式动作：发布权在「stage:compute」能力（组委会）
  router.add('POST', '/api/stages/:stageId/compute', async (ctx) => {
    requireCapability(ctx, 'stage:compute');
    return computeStage({
      db: ctx.db,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  router.add('GET', '/api/stages/:stageId/computations/:computationId', async (ctx) => {
    requireCapability(ctx, 'audit:read');
    return getComputation({ db: ctx.db, id: ctx.params.computationId });
  });
}

export { json };
```

- [ ] **Step 7: 修改 rules/scoring-initial.json 与 rules/scoring-final.json**

`platform/rules/scoring-initial.json`（在 `minJudgesForTrim` 之后插入）：

```json
  "minJudgesForTrim": 5,
  "fallback": "global",
  "trimmedIterations": 20,
  "bayesPriorStrength": 5,
  "selfEvalThreshold": 10,
  "judgePool": {
    "minJudgesPerDimension": 7,
    "minEnterpriseSeatShare": 0.30,
    "maxExpertSeatShare": 0.50,
    "votingSeats": ["judge", "enterprise"],
    "nonVotingSeats": ["observer"]
  },
  "freeBrief": {
    "judgeDimension": "track_fit",
    "label": "需求真实性的公开证据"
  },
```

`platform/rules/scoring-final.json`（`minJudgesForTrim` 之后插入；决赛下限 ≥9，R-JDG-10）：

```json
  "minJudgesForTrim": 5,
  "fallback": "global",
  "trimmedIterations": 20,
  "bayesPriorStrength": 5,
  "selfEvalThreshold": 10,
  "judgePool": {
    "minJudgesPerDimension": 9,
    "minEnterpriseSeatShare": 0.30,
    "maxExpertSeatShare": 0.50,
    "votingSeats": ["judge", "enterprise"],
    "nonVotingSeats": ["observer"]
  },
  "freeBrief": {
    "judgeDimension": "feasibility",
    "label": "需求真实性的公开证据"
  },
```

- [ ] **Step 8: 修改 src/config.js（新增字段 fail-fast 校验）**

在 `validateRules` 的「── 评分配置 ──」循环里，`wEnterprise` 合法性判断之后追加：

```javascript
    // ── P2 追加：评委池 / 自由命题替代维度 / 归一化策略参数 ──
    const pool = cfg.judgePool;
    if (!pool) {
      errors.push(`scoring.${key} 缺少 judgePool 段（R-JDG-10 / R-JDG-11）`);
    } else {
      if (!(Number(pool.minJudgesPerDimension) > 0)) {
        errors.push(`scoring.${key} judgePool.minJudgesPerDimension 必须 > 0`);
      }
      if (Number(pool.minEnterpriseSeatShare) < 0 || Number(pool.minEnterpriseSeatShare) > 1) {
        errors.push(`scoring.${key} judgePool.minEnterpriseSeatShare 必须在 0..1`);
      }
      if (Number(pool.maxExpertSeatShare) < 0 || Number(pool.maxExpertSeatShare) > 1) {
        errors.push(`scoring.${key} judgePool.maxExpertSeatShare 必须在 0..1`);
      }
      if (!Array.isArray(pool.votingSeats) || !pool.votingSeats.length) {
        errors.push(`scoring.${key} judgePool.votingSeats 缺失`);
      }
      if (!Array.isArray(pool.nonVotingSeats) || !pool.nonVotingSeats.length) {
        errors.push(`scoring.${key} judgePool.nonVotingSeats 缺失`);
      }
    }
    const demand = cfg.freeBrief?.judgeDimension;
    if (!demand) {
      errors.push(`scoring.${key} 缺少 freeBrief.judgeDimension（R-JDG-08 R4）`);
    } else if (!cfg.dimensions.some((d) => d.key === demand && d.seat === 'judge')) {
      errors.push(`scoring.${key} freeBrief.judgeDimension=${demand} 必须是一个评委席维度`);
    }
    if (cfg.selfEvalThreshold != null && Number(cfg.selfEvalThreshold) < 0) {
      errors.push(`scoring.${key} selfEvalThreshold 必须 ≥ 0`);
    }
```

- [ ] **Step 9: 修改 src/server.js（注册评审路由）**

在 `import` 区加入：

```javascript
import { registerReviewRoutes } from './http/routes/review.js';
```

在 `createApp` 内、`router.add('GET', '/api/me', ...)` 之后加入：

```javascript
  // P2 评审 API（报名/组队等 P1 路由由 P1 追加，不要互相覆盖）
  registerReviewRoutes(router);
```

- [ ] **Step 10: 运行测试确认通过**

Run: `cd platform && node --test test/scoring.test.js test/compute.test.js`
Expected: PASS（10 + 3 = 13 个测试全过）

- [ ] **Step 11: 全量测试**

Run: `cd platform && node --test`
Expected: 全部通过

- [ ] **Step 12: 提交**

```bash
cd platform && git add src/domain/scoring.js src/services/compute.js src/db/repo/computations.js src/http/routes/review.js src/config.js src/server.js rules test/scoring.test.js test/compute.test.js
git commit -m "feat(P2): scoreStage 总装、compute 快照服务与 9 条评审 API"
```

---

## 需求覆盖对照（本阶段负责的 15 条）

| 需求 ID | 落在哪 | 实现要点 |
|---|---|---|
| R-JDG-01 | Task 8 Step 7 | `rules/scoring-initial.json` / `scoring-final.json` 两套权重表；**本阶段不改 `wEnterprise`** |
| R-JDG-02 | Task 2 | `normalizeScores`：评委宽严口径、样本不足退回全局口径、`fallbackReason` 显式 |
| R-JDG-03 | Task 3 | `trimOutliers`：去一个最高一个最低，有效评委 < 5 不去极值 |
| R-JDG-04 | Task 3 / Task 8 | `总分 = (1−w_E)×P + w_E×E`；初赛 `w_E = 0.10`（C-01） |
| R-JDG-05 | Task 4 | R1 非本赛道 → 该队企业项权重置 0 |
| R-JDG-06 | Task 4 | R2 缺双签 → 该项按 0 分计 + warning（权重保留） |
| R-JDG-07 | Task 4 | R3 企业席合计权重 ≤ `wEnterprise`，超出即封顶 |
| R-JDG-08 | Task 4 | R4 自由命题组无企业签字 → 改由评委按需求真实性的公开证据打分 |
| R-JDG-09 | Task 5 / Task 6 | `checkRecusal` + `declareRecusal` 留档；回避后该评委对该队的分不计入 |
| R-JDG-10 | Task 5 | `checkJudgePool`：初赛每维度 ≥7 / 决赛 ≥9（配置在 `judgePool` 段） |
| R-JDG-11 | Task 5 | 席构成校验；**观察员无投票权**（提交 403、统计不计入） |
| R-JDG-12 | Task 6 | `submitCalibration` → `calibrations` 表，**不计入评分** |
| R-JDG-13 | Task 5 / Task 8 | `detectSelfEvalDiff`：d>10 要书面说明（不成立则对齐评委分）；d<−10 只提问 |
| R-JDG-14 | Task 6 | 企业确认必须带 `content`，空白签字 400 拒收 |
| R-JDG-19 | Task 7 | `tiebreak_round` + `tiebreak_votes`（一人一票由主键保证）→ 复议分进 trace 供 P3 破同分链 |

---

## P2 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P2-1 | z-score 口径正确 | `node --test test/normalization.test.js` 通过：已知评委矩阵 → 期望 z 值（j1=1.264911064 / j2=1.414213562），且 `judgeStats.j1.mean=80`、`stdev=15.811388301` |
| P2-2 | 降级显式 | 同文件「样本不足」用例：`normalized=false`、`fallbackReason='judge_sample_too_small'`；「stdev=0」用例：`values.j4=0` 且 `fallbackReason='zero_stdev'` |
| P2-3 | 4 策略可切换 | 同文件「4 种策略产出不同结果」用例通过；4 组预期值（zscore / median / trimmed / bayes）逐一命中 |
| P2-4 | 初赛 w_E = 10% | `node --test test/scoring.test.js`「总分 = (1−w_E)×P + w_E×E」用例：t1 `seatP=74.166666667`、`seatE=80`、`total=74.75`；且 `rules/scoring-initial.json` 的 `wEnterprise` 仍为 `0.10`（本阶段不改） |
| P2-5 | ⭐ 行为分进不了总分 | 同文件「行为分变化不影响总分」用例：传入 `behaviorScore=999` 后 `teams` 深度相等 |
| P2-6 | 企业席 R1–R4 | `node --test test/enterprise-seat.test.js` 6 个用例通过：R1 权重置 0、R2 分数 0 分且权重保留、R3 封顶、R4 自由命题组替代维度 |
| P2-7 | 自评三区间 | `node --test test/self-eval.test.js` 通过：d=+15 → `written_explanation`、d=−30 → `judge_question`、±10 边界无 flag |
| P2-8 | 幂等 + 一票一人 | `node --test test/review-service.test.js` 通过：同一 `requestId` 重复提交 `submitted=0` 且 `score_stats.n` 不变；`node --test test/tiebreak.test.js` 通过：同一 (轮次,投票人,队伍) 第二次投票抛 409 |
| P2-9 | 关键唯一约束 | `node --test test/migration-review.test.js` 通过：重复 `stage_reviews` / `peer_reviews` 插入被数据库拒绝；`score_stats` 主键为 (judge_id, dimension) |
| P2-10 | 可复算 | `node --test test/compute.test.js` 通过：快照含 `input_json` / `output_json` / `trace_json`；重复 compute 的 revision 为 1、2 |
| P2-11 | 零依赖 | `node --test test/zero-deps.test.js` 通过；`platform/` 下无 `node_modules`、无 `package-lock.json` |
| P2-12 | 全量回归 | `cd platform && node --test` 全部通过（含 P0 原有用例） |

---

## 与接口契约的偏差

`INTERFACES.md` 是跨阶段的唯一事实来源。以下是本计划**必须**与它不一致的地方，全部在此登记，便于后续阶段与组委会追认。

| # | 偏差 | 契约原文 | 本计划做法 | 理由 | 影响 |
|---|---|---|---|---|---|
| D-1 | `normalizeScores` 的 `samples` 元素多一个可选字段 | `samples: [{ judgeId, value }]` | 允许 `{ judgeId, value, series }`，`series` = 该评委在本维度对**全部参赛队**的原始分序列 | 归一化的是评委宽严，必须知道该评委在维度 d 上的**全部打分**才能算 mean(i,d)/stdev(i,d)；只给单元值无法算 | 无破坏性：不传 `series` 时退回「同 judgeId 在 samples 中的全部 value」 |
| D-2 | `normalizeScores` 返回值多一个字段 | `{ normalized, values, fallbackReason, stats }` | 追加 `judgeStats[judgeId] = { n, mean, stdev, center, scale, normalized, fallbackReason }` | 契约的 4 个字段无法表达「同一维度内不同评委的降级状态不同」；trace 需要逐评委样本量 | 纯追加，不改原有字段语义 |
| D-3 | `003_review.sql` 多两张表 | 未列 `tiebreak_round` / `tiebreak_votes` | 新增这两张表 | 设计文档 §6.4【决策】已明确要求「加时陈述用独立表 + 唯一约束」；R-JDG-19 需要落库 | P3 的 `applyTiebreakChain` 直接消费 |
| D-4 | `enterprise_confirmations` 多一列 | 无 `content` 列 | 增加 `content TEXT NOT NULL DEFAULT ''` | R-JDG-14「企业签字必须有内容」需要落库；服务层拒绝空白内容 | 需 P3/P4 的签字表同步对齐 |
| D-5 | 幂等机制的实现方式 | 业务表上有 `request_id` 列，未规定唯一性 | 新增 `review_request_keys(scope, stage_id, subject_id, request_id)` 表做「先抢键再落数据」；业务表的 `request_id` 只作记录、另建普通索引 | ⛔ 一次批量提交会写多行且共用同一个 `request_id` —— 把 UNIQUE 直接建在业务表的 `request_id` 上会让第二批插不进去。键表方案既保证「同一 request 只生效一次」，又天然支持批量 | 新增一张表 + 一个仓储文件；P4 的 `idempotency_keys` 是同一模式，可复用思路 |
| D-6 | `applyEnterpriseRules` 返回值多一个字段 | `{ seatE, weights, warnings }` | 追加 `r4Substitute[teamId] = { dimension }` | R4 的替代分数来自评委维度分，由 `scoring.js` 填充；纯企业确认表算不出来 | 纯追加 |
| D-7 | `scoreStage` 多两个可选入参 | `{ config, judges, submissions, enterpriseConfirmations, peerReviews }` | 追加可选的 `teams`、`selfReviews` | R1 需要队伍的任务包归属、R4 需要 `is_free_brief`、决赛「自评测」维度需要自评记录；契约的 5 个入参里没有这些数据 | 两个参数均可省略；省略时相关判定跳过并记 `team_roster_missing` warning（不静默） |
| D-8 | `scoreStage` 多一个入参名 | —— | `teams` 同时是入参名与返回值字段名 | 与契约的返回结构 `{ teams: [...] }` 对齐 | 返回值形状未变 |
| D-9 | `submitCalibration` 的落点 | 注释写 `calibrated=1` | 写进专用表 `calibrations`；`stage_reviews.calibrated` 列保留为防御性过滤（评分开 query 恒带 `calibrated = 0`） | `stage_reviews` 有 `team_id NOT NULL`，校准是打**样例作品**、没有真实队伍，塞进去会造假数据 | 校准分同样不计入评分，语义未变 |
| D-10 | `computeStage` 多一个可选入参 | `{ db, stageId, actorId, now }` | 追加可选 `rules` | 权重表按 `stage.scoring_config_key` 取，但服务层拿不到规则集；没有规则就**拒绝计算**（fail-fast） | 不传 rules 直接报错，不出「默认权重算出的榜单」 |
| D-11 | API 数量 | 8 条 | 9 条（追加 `POST /api/stages/:stageId/enterprise-confirmations`） | R2 双签 / R-JDG-14 内容 / R1 都需要企业确认的写入口，否则这三条规则无处落地 | 追加一条，不改既有 8 条路径与语义 |
| D-12 | `stage_results` 的 `rank` / `tied_with` / `points` | 列存在 | P2 阶段显式写 `NULL` | 名次与积分由 P3 的 `rankTeams` / `stagePointsFor` 产出；P2 若自己排一份名次会与破同分链打架 | 列改为可空，不影响既有写入 |
| D-13 | 破同分链的消费时机 | `rankTeams` 在 P3 | P2 只落「加时陈述轮次 + 投票 + 复议分」，`getTiebreakExtraScores` 供 P3 取用 | 破同分链本身属 P3；P2 只保证数据齐备且一人一票 | 无 |
| D-14 | 归一化「全局口径」的数值 | 「退回全局均值与标准差」 | z = (s − 全局均值)/全局标准差，再按「全局均值 + z×全局标准差」还原回 0–100 尺度 | 还原回原始单位后，全局口径等价于「不做宽严校正」；否则 P（z 单位）与 E（0–100）不可通约 | 语义等价，trace 里 `fallbackReason` 照常标出 |
| D-15 | P 席包含自评维度 | 决赛权重表含「自评测 5%」 | P 席 = 评委维度 ∪ 自评维度 | 决赛权重表 70+25+5=100%，而公式 (1−w_E)=75% 只能覆盖「评委 70% + 自评 5%」 | 初赛无自评维度，完全不受影响 |
| D-16 | 规则文件新增字段 | 9 份规则的字段未列 | `scoring-initial.json` / `scoring-final.json` 增加 `judgePool` / `freeBrief` / `fallback` / `trimmedIterations` / `bayesPriorStrength` / `selfEvalThreshold` | R-JDG-10 / R-JDG-11 / R-JDG-08 的数值必须配置化（⛔ 不硬编码） | 只加字段，不改已有权重与 `wEnterprise` |
| D-17 | `fallbackReason` 取值 | INTERFACES 用 `zero_stdev`；C-05 用 `stdev_zero` | 统一用 INTERFACES 的 `zero_stdev` | INTERFACES 是跨阶段唯一事实来源 | 另两处取值为 `judge_sample_too_small` / `raw_fallback` / `unknown_strategy` / `empty_samples` |
| D-18 | 迁移版本号 | P0 建了 `002_user_roles.sql`；INTERFACES 把 P1 的报名迁移编为 `002_registration.sql` | P2 的迁移用 `003_review.sql`（不冲突） | ⚠️ **P0 与 P1 的 002 版本号重复**：`applyMigrations` 按版本号去重，后者的 `002` 会被跳过 | ⛔ **需 P1 改名为 `002_registration.sql` 之外的版本，或 P0 改名**。本阶段不擅自改动他人文件，但**必须在上线前解决**，否则报名表不会建 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

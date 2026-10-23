# P2 评审引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成全项目最重要的一段代码——**能真实算分、能留痕、能复算的评审引擎**：z-score 评委宽严归一化（4 策略可切换）、去极值、双席加权总分（初赛 `w_E=10%`，C-01 裁决）、企业席 R1/R2/R3/R4、自评差异检测、回避留档、互评资格、加时陈述一票破同分，并且**行为分在算法层面进不了总分**。

**Architecture:** 单进程 Node（仅标准库）。`src/domain/` 是**纯函数规则引擎**（无 IO、无 `Date.now()`、无 `Math.random()`），吃「配置 + 数据」，吐「结果 + trace」；`src/services/` 编排用例并落库；所有 SQL 收在 `src/db/repo/`；`src/http/routes/review.js` 挂 9 条评审 API。每次计算产出**三件套快照**（input + output + trace）写入 `computation_snapshots`，榜单可从原始数据重放（设计文档 §12 / S-1）。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## Global Constraints

```
运行时      Node ≥ 22.16.0（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
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
├── db/migrations/003_review.sql    评审数据模型（15 张表，含 tiebreak_round / tiebreak_votes / review_request_keys / conflict_declarations）
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
│   │   ├── audit-log.js              审计日志（audit_log 的 SQL 唯一归宿）
│   │   ├── stages.js               赛段与评委席
│   │   ├── reviews.js              stage_reviews + calibrations + score_stats（幂等 + 增量）
│   │   ├── request-keys.js         幂等键（先抢键再落数据）
│   │   ├── enterprise-confirmations.js  企业确认（R2 双签 / R-JDG-14 内容）
│   │   ├── peer-reviews.js         互评
│   │   ├── self-reviews.js         自评测
│   │   ├── recusals.js             回避记录
│   │   ├── computations.js         computation_snapshots + stage_results
│   │   └── tiebreak.js             tiebreak_round / tiebreak_votes
│   ├── http/
│   │   ├── sse.js                  SSE 单向推送（评审进度；兑现 web/api.js 的承诺）
│   │   └── routes/
│   │       └── review.js           9 条评审 API 路由
│   └── audit/log.js                审计日志服务门面（**不含 SQL**，SQL 在 db/repo/audit-log.js）
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
    ├── tiebreak.test.js            一票破同分（唯一约束）
    └── sse.test.js                 SSE 帧格式 / 事件中心 / 端点首帧
```

**本阶段修改**

```
platform/rules/scoring-initial.json   加 judgePool 段（R-JDG-10 初赛 ≥7）+ freeBrief 段（R-JDG-08 R4）
platform/rules/scoring-final.json      加 judgePool 段（R-JDG-10 决赛 ≥9）+ freeBrief 段
platform/src/config.js                 校验 judgePool / freeBrief / 归一化策略参数（fail-fast）
platform/src/server.js                 注册评审路由（与 P1 的改动合并，不覆盖）+ SSE 独立分支
platform/src/http/routes/review.js     提交评审后发布进度事件
```

---

### Task 1: 评审数据模型与迁移 `003_review.sql`

**Files:**
- Create: `platform/db/migrations/003_review.sql`
- Create: `platform/test/migration-review.test.js`

**Interfaces:**
- Consumes: P0 `openDatabase()` / `applyMigrations()`；P1 `teams` / `task_packages`（本阶段只读，不建表）
- Produces:
  - **15 张表**：`stages` / `stage_judges` / `conflict_declarations` / `stage_reviews` / `review_request_keys` / `calibrations` / `enterprise_confirmations` / `peer_reviews` / `self_reviews` / `score_stats` / `recusal_records` / `computation_snapshots` / `stage_results` / `tiebreak_round` / `tiebreak_votes`
    - 相对 `INTERFACES.md` §3 的 11 张表，**新增 4 张**：`tiebreak_round` / `tiebreak_votes`（D-3）、`review_request_keys`（D-5）、**`conflict_declarations`**（D-3）
    - ⚠️ 原规格写「14 张表」，但 SQL 里实际有 **15** 张 —— 差的那张是 `conflict_declarations`，**既没进表数声明、也没进测试的表清单、也没进偏差表**（父代理预审修正）
  - ⚠️ **引用型外键必须齐全**（父代理预审修正，Important）：
    与 P1 的 `002_registration.sql` 同一约定 —— 每一处「指向别的表的 id」都要有 `REFERENCES`。
    **最终 15 张表共 38 条引用型外键**，覆盖 `editions` / `users` / `teams` / `stages` /
    `conflict_declarations` / `computation_snapshots` / `tiebreak_round` 七个父表。
    ⚠️ **代价**：所有测试夹具必须建**真实的**用户 / 届期 / 战队（不能再用 `'j1'` / `'t1'` / `'ed1'` 假 id）
    ⚠️ **有意不加外键的多态 / 逻辑引用**（加了反而会锁死语义）：
    `stage_judges.scope_id`（global|edition|task_package|team 四态）、
    `stage_reviews.request_id` / `peer_reviews.request_id` / `self_reviews.request_id`（幂等键，见 D-5）、
    `review_request_keys.subject_id`（judge_id|from_team_id|team_id 三态）。
  - 关键唯一约束（**并发正确性的地基**）：
    - `stage_reviews` UNIQUE(stage_id, judge_id, team_id, dimension) —— 防重复灌分
      ⚠️ 这是**非偏序**索引（契约原文，没有 `WHERE deleted_at IS NULL`），软删不腾格子 —— 陷阱已登记并被测试钉住
    - `peer_reviews` UNIQUE(stage_id, from_team_id, to_team_id) —— 一队对另一队只投一次
    - `self_reviews` UNIQUE(stage_id, team_id, dimension) —— 同一维度只自评一次
    - `stage_results` UNIQUE(stage_id, team_id) —— 同一赛段同一队伍只有一条结果
    - `stages` UNIQUE(edition_id, "key") —— 同一届期下赛段代号不重复
    - `enterprise_confirmations` 偏序唯一索引 (stage_id, team_id, dimension, enterprise_id) WHERE deleted_at IS NULL
    - `score_stats` PRIMARY KEY(judge_id, dimension)
    - `tiebreak_votes` PRIMARY KEY(tiebreak_round_id, voter_id, team_id) —— **一人一队一票由数据库保证**

- [ ] **Step 1: 写失败的测试**

`platform/test/migration-review.test.js`：

```javascript
// platform/test/migration-review.test.js —— 评审数据模型（003_review.sql）
//
// 依据：P2 计划 Task 1「评审数据模型与迁移 003_review.sql」
// 溯源需求：R-JDG-09 / R-JDG-11 / R-JDG-13 / R-JDG-14 / R-JDG-18 / R-JDG-19 / R-RNK-07
//
// ⚠️ **夹具必须建真实的用户 / 届期 / 战队**（父代理预审修正，Important）：
//    003_review.sql 补齐了引用型外键（edition_id → editions、judge_id → users、
//    team_id → teams）。原规格的夹具用假 id（'j1' / 't1' / 'ed1'）——
//    那**只**在「没有外键」时成立，而且正好**掩盖**了「评审数据可以指向不存在的
//    评委/队伍」这个问题。P1 的迁移测试（migration-002.test.js）就是建真实数据的，
//    这里与它对齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertTeam } from '../src/db/repo/teams.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const NOW = '2026-10-20T00:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  // 真实届期 / 用户 / 战队 —— 外键要指向真实存在的行
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900002001', password: 'pw' });
  const captain = createUser(db, {
    name: '队长甲', phone: '13900002002', password: 'pw', mbaStatus: 'mba',
  });
  const team = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, status: 'forming', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain.id, status: 'forming', now: NOW,
  });
  // 赛段（stage_id 有外键，先建一个赛段）
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES ('s1', ?, 's1', '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  ).run(edition.id);
  return { db, close, dataDir, edition, judge, captain, team, team2 };
}

const TABLES = [
  'stages', 'stage_judges', 'conflict_declarations', 'stage_reviews', 'review_request_keys',
  'calibrations', 'enterprise_confirmations', 'peer_reviews', 'self_reviews', 'score_stats',
  'recusal_records', 'computation_snapshots', 'stage_results', 'tiebreak_round', 'tiebreak_votes',
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
  const { db, close, dataDir, judge, team } = setup();
  const ins = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', ?, ?, 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1', judge.id, team.id);
  assert.throws(() => ins.run('r2', judge.id, team.id), /UNIQUE|constraint/i, '同一 (赛段,评委,队伍,维度) 只能有一条');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('peer_reviews 唯一约束：一队对另一队只投一次', () => {
  const { db, close, dataDir, team, team2 } = setup();
  const ins = db.prepare(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
     VALUES (?, 's1', ?, ?, 70, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('p1', team.id, team2.id);
  assert.throws(() => ins.run('p2', team.id, team2.id), /UNIQUE|constraint/i);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('score_stats 主键是 (judge_id, dimension)', () => {
  const { db, close, dataDir, judge } = setup();
  const ins = db.prepare(
    `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
     VALUES (?, ?, 1, 80, 6400, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run(judge.id, 'innovation');
  assert.throws(() => ins.run(judge.id, 'innovation'), /UNIQUE|constraint/i);
  ins.run(judge.id, 'feasibility'); // 不同维度可以并存
  // 统计行必须挂在真实评委上
  assert.throws(
    () => db.prepare(
      `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
       VALUES ('no-such-judge', 'innovation', 1, 80, 6400, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'score_stats.judge_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('tiebreak_votes 主键保证一人一队一票（并发下插不出两票）', () => {
  const { db, close, dataDir, judge, team, team2 } = setup();
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '["t1","t2"]', '2026-10-20T00:10:00.000Z', ?, '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  const ins = db.prepare(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', ?, ?, 80, '2026-10-20T00:05:00.000Z')`,
  );
  ins.run(judge.id, team.id);
  // ⚠️ 准确语义是「一人**一队**一票」：同一人对**不同**队伍各投一次是允许的
  //    （破同分时每位评委都要给每支并列队打分）。
  //    若主键退化成 (轮次,投票人)，这条会被数据库拒掉 —— 所以它必须能插进去。
  ins.run(judge.id, team2.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tiebreak_votes').get().n,
    2,
    '同一人对两支队伍各投一票，共两行',
  );
  // 同一 (轮次,投票人,队伍) 第二次投票 → 被数据库拒绝（并发下插不出两票）
  assert.throws(() => ins.run(judge.id, team.id), /UNIQUE|constraint/i, '同一 (轮次,投票人,队伍) 只能投一次');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等键表：同一 (scope,赛段,主体,request_id) 只能领一次', () => {
  const { db, close, dataDir, judge } = setup();
  const ins = db.prepare(
    `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
     VALUES ('review', 's1', ?, ?, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run(judge.id, 'req-1');
  assert.throws(() => ins.run(judge.id, 'req-1'), /UNIQUE|constraint/i);
  // ⚠️ **不同的** request_id 必须能并存 —— 否则第二次请求会被误判成重复请求而丢数据。
  //    幂等键的语义是「同一个 request_id 只能生效一次」，不是「这个主体只能来一次」。
  ins.run(judge.id, 'req-2');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM review_request_keys').get().n,
    2,
    '同一主体的两个不同 request_id 应各占一行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('同一届期下赛段代号唯一（不能有两个初赛）', () => {
  const { db, close, dataDir, edition } = setup();
  const ins = db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES (?, ?, ?, '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  );
  // setup 里已有一个 key='s1' 的赛段 → 再插一个同代号必须被拒
  assert.throws(() => ins.run('s2', edition.id, 's1'), /UNIQUE|constraint/i, '同一届期下赛段代号不能重复');
  // 不同代号可以并存
  ins.run('s3', edition.id, 's2');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('stage_results 的 rank / points 在 P2 阶段可空（名次由 P3 填）', () => {
  const { db, close, dataDir } = setup();
  const info = db.prepare('PRAGMA table_info(stage_results)').all();
  const rank = info.find((c) => c.name === 'rank');
  const points = info.find((c) => c.name === 'points');
  assert.equal(rank.notnull, 0);
  assert.equal(points.notnull, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 外键（父代理预审修正，Important）──────────────────────────────────────
// ⚠️ 原规格只给一部分列加了外键（stage_judges.user_id 有、stage_reviews.judge_id 没有），
//    同一类引用一处有一处没有 —— 评审数据可以指向**不存在的评委/队伍**，
//    聚合时不会被发现；而假 id 夹具正好掩盖了这一点。
//    P1 的 002_registration.sql 里 editions/teams/cities/task_packages/registrations
//    的 edition_id **全都有**外键 —— 这里与它对齐。
test('外键：赛段必须挂在真实届期上（不存在的届期插不进去）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => db.prepare(
      `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
       VALUES ('s2', 'no-such-edition', 's2', '决赛', 'final', '2026-10-26', '2026-10-28', 'final', 'open')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stages.edition_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：评分必须挂在真实的评委与队伍上（孤儿评分插不进去）', () => {
  const { db, close, dataDir, team } = setup();
  // 评委不存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('r9', 's1', 'no-such-judge', ?, 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'stage_reviews.judge_id 必须有外键',
  );
  // 队伍不存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('r10', 's1', (SELECT id FROM users WHERE name = '评委甲'), 'no-such-team', 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stage_reviews.team_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：互评 / 自评 / 结果表也不能指向不存在的队伍', () => {
  const { db, close, dataDir, judge, team } = setup();
  assert.throws(
    () => db.prepare(
      `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
       VALUES ('p9', 's1', ?, 'no-such-team', 70, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'peer_reviews.to_team_id 必须有外键',
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('sr9', 's1', 'no-such-team', 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'self_reviews.team_id 必须有外键',
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, created_at)
       VALUES ('sr9', 's1', 'no-such-team', 80, 60, 20, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stage_results.team_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：评委席必须挂在真实评委上，声明必须指向真实声明', () => {
  const { db, close, dataDir, judge } = setup();
  const judge2 = createUser(db, { name: '评委乙', phone: '13900002003', password: 'pw' });
  // 正常插入：评委席挂在真实评委上
  db.prepare(
    `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at)
     VALUES ('s1', ?, 'judge', 'global', NULL, '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  // 评委不存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at)
       VALUES ('s1', 'no-such-judge', 'judge', 'global', NULL, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stage_judges.user_id 必须有外键',
  );
  // 声明不存在（用另一个评委 —— 否则会先撞上主键 (stage_id, user_id)）
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at, conflict_declaration_id)
       VALUES ('s1', ?, 'judge', 'global', NULL, '2026-10-20T00:00:00.000Z', 'no-such-declaration')`,
    ).run(judge2.id),
    /FOREIGN KEY constraint failed/i,
    'stage_judges.conflict_declaration_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('利益冲突声明表存在（R-JDG-18：评委须签署声明）', () => {
  // ⚠️ 这张表在原规格的**测试表清单里是漏的** —— 建表漏了测试也不报。
  const { db, close, dataDir, edition, judge } = setup();
  const info = db.prepare('PRAGMA table_info(conflict_declarations)').all().map((c) => c.name);
  for (const col of ['id', 'stage_id', 'judge_id', 'declared_at', 'has_conflict', 'statement', 'signed_at']) {
    assert.ok(info.includes(col), `conflict_declarations 缺列 ${col}`);
  }
  // 声明可落库，且指向真实赛段与真实评委
  db.prepare(
    `INSERT INTO conflict_declarations (id, stage_id, judge_id, declared_at, has_conflict, statement, signed_at)
     VALUES ('cd1', 's1', ?, '2026-10-20T00:00:00.000Z', 0, '本人与参赛企业无利益关系', '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conflict_declarations').get().n, 1);
  // 评委必须存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO conflict_declarations (id, stage_id, judge_id, declared_at, has_conflict, statement, signed_at)
       VALUES ('cd2', 's1', 'no-such-judge', '2026-10-20T00:00:00.000Z', 0, 'x', '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('企业确认：同格只能有一条有效记录，软删后可重签（R2 双签 / R-JDG-14）', () => {
  const { db, close, dataDir, judge, team } = setup();
  const ins = db.prepare(
    `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, content, created_at)
     VALUES (?, 's1', ?, ?, 'delivery', 85, '由我方提供落地资源', '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('e1', team.id, judge.id);
  // 同 (赛段,队伍,维度,企业) 只能有一条有效记录
  assert.throws(
    () => ins.run('e2', team.id, judge.id),
    /UNIQUE|constraint/i,
    '同格重复确认必须被数据库拒绝',
  );
  // 软删之后同格可重签 —— 这是**偏序**唯一索引（WHERE deleted_at IS NULL）的语义
  db.prepare(`UPDATE enterprise_confirmations SET deleted_at = '2026-10-21T00:00:00.000Z' WHERE id = 'e1'`).run();
  ins.run('e3', team.id, judge.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE deleted_at IS NULL').get().n,
    1,
    '软删后同格只有一条有效记录',
  );
  // 引用型外键：队伍 / 企业必须真实存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, created_at)
       VALUES ('e4', 's1', 'no-such-team', ?, 'delivery', 85, '2026-10-20T00:00:00.000Z')`,
    ).run(judge.id),
    /FOREIGN KEY constraint failed/i,
    'enterprise_confirmations.team_id 必须有外键',
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, created_at)
       VALUES ('e5', 's1', ?, 'no-such-enterprise', 'delivery', 85, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'enterprise_confirmations.enterprise_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自评 / 结果：同格唯一，且都挂在真实赛段与队伍上', () => {
  const { db, close, dataDir, team } = setup();
  // 自评：同一 (赛段,队伍,维度) 只能一条
  const selfIns = db.prepare(
    `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', ?, 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
  );
  selfIns.run('sr1', team.id);
  assert.throws(() => selfIns.run('sr2', team.id), /UNIQUE|constraint/i, '同一 (赛段,队伍,维度) 自评只能一条');
  // 自评的赛段也必须真实
  assert.throws(
    () => db.prepare(
      `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('sr3', 'no-such-stage', ?, 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'self_reviews.stage_id 必须有外键',
  );
  // 赛段结果：同一 (赛段,队伍) 只能一条
  const resIns = db.prepare(
    `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, created_at)
     VALUES (?, 's1', ?, 80, 60, 20, '2026-10-20T00:00:00.000Z')`,
  );
  resIns.run('st1', team.id);
  assert.throws(() => resIns.run('st2', team.id), /UNIQUE|constraint/i, '同一 (赛段,队伍) 结果只能一条');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：计算快照的赛段 / 队伍，以及加时投票的投票人 / 队伍', () => {
  const { db, close, dataDir, judge, team } = setup();
  const fkFail = (sql, ...params) => assert.throws(
    () => db.prepare(sql).run(...params),
    /FOREIGN KEY constraint failed/i,
  );
  // 计算快照（可复算的载体）：赛段与队伍都要真实
  fkFail(
    `INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, created_at)
     VALUES ('cs1', 'stage_score', (SELECT id FROM editions LIMIT 1), 'no-such-stage', ?, 'v1', '{}', '{}', '{}', '2026-10-20T00:00:00.000Z')`,
    team.id,
  );
  fkFail(
    `INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, created_at)
     VALUES ('cs2', 'stage_score', (SELECT id FROM editions LIMIT 1), 's1', 'no-such-team', 'v1', '{}', '{}', '{}', '2026-10-20T00:00:00.000Z')`,
  );
  // 加时投票：投票人与队伍都要真实
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '[]', '2026-10-20T00:10:00.000Z', ?, '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  fkFail(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', 'no-such-voter', ?, 80, '2026-10-20T00:05:00.000Z')`,
    team.id,
  );
  fkFail(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', ?, 'no-such-team', 80, '2026-10-20T00:05:00.000Z')`,
    judge.id,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('登记口径：stage_reviews 的 UNIQUE 是【非偏序】—— 软删不会腾出格子', () => {
  // ⚠️ 这是**已登记的陷阱**，不是笔误：契约原文的 UNIQUE(stage_id, judge_id, team_id, dimension)
  //    **没有** WHERE deleted_at IS NULL，而改分走的是覆盖写 UPDATE（不软删）。
  //    所以今天的语义是「一个格子终身只有一条」，软删后也插不进第二条。
  //    将来若要实现「撤回评审」，必须同步把索引改成偏序 —— 那时这条断言会先失败，
  //    提醒改动者同步改索引。
  const { db, close, dataDir, judge, team } = setup();
  const ins = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', ?, ?, 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1', judge.id, team.id);
  db.prepare(`UPDATE stage_reviews SET deleted_at = '2026-10-21T00:00:00.000Z' WHERE id = 'r1'`).run();
  assert.throws(
    () => ins.run('r2', judge.id, team.id),
    /UNIQUE|constraint/i,
    '非偏序唯一索引：软删不腾格子',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：校准 / 回避 / 加时轮次 / 快照 / 互评 也都指向真实主体', () => {
  const { db, close, dataDir, judge, team } = setup();
  const fkFail = (sql, ...params) => assert.throws(
    () => db.prepare(sql).run(...params),
    /FOREIGN KEY constraint failed/i,
  );
  // 校准（R-JDG-12）：校准分不计入评分，但赛段/评委必须真实
  fkFail(
    `INSERT INTO calibrations (id, stage_id, judge_id, dimension, raw_score, created_at)
     VALUES ('c1', 'no-such-stage', ?, 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
    judge.id,
  );
  fkFail(
    `INSERT INTO calibrations (id, stage_id, judge_id, dimension, raw_score, created_at)
     VALUES ('c2', 's1', 'no-such-judge', 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
  );
  // 回避记录（R-JDG-09）：回避必须留档
  fkFail(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, action)
     VALUES ('r1', 's1', ?, 'no-such-team', '有利益关系', 'conflict', '2026-10-20T00:00:00.000Z', 'recused')`,
    judge.id,
  );
  fkFail(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, action)
     VALUES ('r2', 's1', 'no-such-judge', ?, '有利益关系', 'conflict', '2026-10-20T00:00:00.000Z', 'recused')`,
    team.id,
  );
  // 加时陈述轮次（S7 §3.3）
  fkFail(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '[]', '2026-10-20T00:10:00.000Z', 'no-such-user', '2026-10-20T00:00:00.000Z')`,
  );
  // 计算快照与赛段结果（可复算的载体）
  fkFail(
    `INSERT INTO computation_snapshots (id, kind, edition_id, rule_version, input_json, output_json, trace_json, created_at)
     VALUES ('cs1', 'stage_score', 'no-such-edition', 'v1', '{}', '{}', '{}', '2026-10-20T00:00:00.000Z')`,
  );
  fkFail(
    `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, computation_id, created_at)
     VALUES ('sr1', 's1', ?, 80, 60, 20, 'no-such-snapshot', '2026-10-20T00:00:00.000Z')`,
    team.id,
  );
  // 互评的起点队伍也要真实
  fkFail(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
     VALUES ('p1', 's1', 'no-such-team', ?, 70, '2026-10-20T00:00:00.000Z')`,
    team.id,
  );
  // 回避记录的审计人（audit_by）也是用户引用
  fkFail(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES ('r3', 's1', ?, ?, '有利益关系', 'audit', '2026-10-20T00:00:00.000Z', 'no-such-auditor', 'recused')`,
    judge.id,
    team.id,
  );
  // 幂等键表的赛段也要真实
  fkFail(
    `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
     VALUES ('review', 'no-such-stage', ?, 'req-9', '2026-10-20T00:00:00.000Z')`,
    judge.id,
  );
  // 企业双签的两个签字人也要真实
  fkFail(
    `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, cross_judge_id, created_at)
     VALUES ('e9', 's1', ?, ?, 'delivery', 85, 'no-such-cross-judge', '2026-10-20T00:00:00.000Z')`,
    team.id,
    judge.id,
  );
  fkFail(
    `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, signatory_user_id, created_at)
     VALUES ('e10', 's1', ?, ?, 'delivery', 85, 'no-such-signatory', '2026-10-20T00:00:00.000Z')`,
    team.id,
    judge.id,
  );
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/migration-review.test.js`
Expected: PASS（18 个测试全过：migration-review 18）

- [ ] **Step 5: 实跑迁移脚本**

Run: `cd platform && node scripts/migrate.js`
Expected: 输出 `迁移完成，当前版本 3`

- [ ] **Step 6: 提交**

```bash
cd platform && git add db/migrations/003_review.sql test/migration-review.test.js
git commit -m "feat(P2): 评审数据模型与迁移 003（15 表 + 关键唯一约束 + 引用型外键齐全）"
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
    - ⛔ **一个单元内 `judgeId` 必须唯一** —— 违反 → `TypeError`（响亮报错，不静默覆盖）
    - ✅ **`series` 缺省时按 D-1 回退**到「同 `judgeId` 在本单元内的全部 `value`」（**原实现漏了这条，已修正**）
  - `stats` = 全局口径统计 `{ n, mean, stdev }`（n = 该维度全部 (评委, 队伍) 原始分个数）
    - ⚠️ 全局口径**与策略无关** —— 策略名写错时照样给出（**原实现会一起丢掉，已修正**）
  - `judgeStats[judgeId]` = `{ n, mean, stdev, center, scale, normalized, fallbackReason }`
  - `FALLBACK_REASONS` = `{ SAMPLE_TOO_SMALL, ZERO_STDEV, RAW_FALLBACK, UNKNOWN_STRATEGY, EMPTY_SAMPLES, NO_FINITE_VALUES }`
  - `FALLBACK_MODES` = `['global', 'raw']`
  - ⛔ **配置 fail-fast**（父代理预审修正）：`minSamplesForJudgeNormalization`（整数 ≥0）、
    `trimmedIterations`（整数 ≥1）、`bayesPriorStrength`（有限数 ≥0）、`fallback`（枚举）
    任一非法 → 抛 `TypeError`。⛔ **不退回默认值** —— 静默改默认值会重演 P1 T5-8
    「配置与实现各说各话」，且坏阈值会产出 NaN，NaN 进榜单比崩掉更可怕。
    同一原则同构于 P0 的 `validateRules`（权重合计 ≠ 100% 拒绝启动）。
  - ⚠️ **「未知策略」不抛错、「配置非法」抛错** —— 这不是不一致，而是两种不同的失败性质：
    策略名写错时「不归一化」是一个**安全且有意义的降级结果**（显式标 `unknown_strategy`）；
    而数值阈值写错时我们**猜不出**安全的值，只能炸出来。

- [ ] **Step 1: 写失败的测试**

`platform/test/normalization.test.js`：

```javascript
// platform/test/normalization.test.js —— 评委宽严归一化引擎（4 策略可切换）
//
// 依据：P2 计划 Task 2「归一化引擎（4 策略可切换）」
// 溯源需求：R-JDG-02（评委宽严 z-score 归一化）｜R-JDG-01（初赛/决赛两套权重表里的归一化参数）
// 冲突裁决：C-05（归一化口径与降级策略）
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

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// ⚠️ 这 8 条都是**先复现缺陷、再补的回归用例**：
//    规格自带的 10 条用例全绿，但下面的缺陷在它们**全都看不见**。

test('D-1 回退：不传 series 时用同 judgeId 在本单元的 value 当 series（不再是空结果）', () => {
  // ⚠️ 原实现**根本没实现** D-1 承诺的这条回退：直接 `continue` 跳过没有 series 的样本，
  //    于是契约形状（INTERFACES.md 的 `samples: [{ judgeId, value }]`）产出
  //    **空 values + fallbackReason = null** —— 一个「静默空成功」。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80 }],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.notDeepEqual(r.values, {}, 'values 不能是空集（否则调用方拿到 0 个 z 值）');
  assert.equal(Object.keys(r.values).length, 1);
  // 回退后的 series 长度为 1 → 样本不足 → 显式降级（不能是 null）
  assert.equal(r.fallbackReason, 'judge_sample_too_small');
  assert.equal(r.stats.n, 1);
  assert.equal(r.values.j1, 0);
});

test('未知策略时全局统计仍然给出（策略名写错不该把原始分统计一起丢掉）', () => {
  // ⚠️ 原实现把策略校验放在最前面直接 return，stats 全部返回 0 ——
  //    而全局口径**与策略无关**，trace 里记的全局统计是假的。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: A1 }],
    strategy: 'nope',
    config: cfgA,
  });
  assert.equal(r.fallbackReason, 'unknown_strategy');
  assert.equal(r.stats.n, 5, '全局样本数不该因为策略名写错就变成 0');
  assert.ok(Math.abs(r.stats.mean - 80) < 1e-9);
  assert.ok(Math.abs(r.stats.stdev - 15.811388301) < 1e-9);
});

test('配置非法直接抛错（绝不让 NaN 静默污染榜单）', () => {
  // ⚠️ 原实现：trimmedIterations=0 → 0/0 = NaN；trimmedIterations='x' → NaN；
  //    而 normalized 仍报 true、fallbackReason 仍是 null —— **NaN 静默进榜**。
  for (const bad of [0, 'x', NaN, -1, 1.5]) {
    assert.throws(
      () => normalizeScores({
        samples: [{ judgeId: 'j1', value: 80, series: A1 }],
        strategy: 'trimmed',
        config: { ...cfgA, trimmedIterations: bad },
      }),
      /trimmedIterations/,
      `trimmedIterations=${String(bad)} 必须报错`,
    );
  }
  assert.throws(
    () => normalizeScores({
      samples: [{ judgeId: 'j1', value: 80, series: A1 }],
      strategy: 'zscore',
      config: { ...cfgA, minSamplesForJudgeNormalization: 'x' },
    }),
    /minSamplesForJudgeNormalization/,
  );
  assert.throws(
    () => normalizeScores({
      samples: [{ judgeId: 'j1', value: 80, series: A1 }],
      strategy: 'bayes',
      config: { ...cfgA, bayesPriorStrength: -1 },
    }),
    /bayesPriorStrength/,
  );
  // ⚠️ bayesPriorStrength **不是整数**约束项 —— 「整数」与「最小值」两道守卫都拦不住
  //    非数值：'x' 与 0 比较是 false、NaN 的整数检查也是 false。
  //    所以「必须是有限数」那道守卫是**唯一**的拦截点，必须有自己的用例。
  for (const bad of ['x', NaN, Infinity, null]) {
    if (bad === null) continue; // null = 缺省，走默认值，合法
    assert.throws(
      () => normalizeScores({
        samples: [{ judgeId: 'j1', value: 80, series: A1 }],
        strategy: 'bayes',
        config: { ...cfgA, bayesPriorStrength: bad },
      }),
      /bayesPriorStrength/,
      `bayesPriorStrength=${String(bad)} 必须报错`,
    );
  }
  assert.throws(
    () => normalizeScores({
      samples: [{ judgeId: 'j1', value: 80, series: A1 }],
      strategy: 'zscore',
      config: { ...cfgA, fallback: 'nope' },
    }),
    /fallback/,
  );
});

test('fallback=raw 真的给原始分（名实相符，不是全局 z 值）', () => {
  // ⚠️ 原实现：reason 写着 raw_fallback，center/scale 却还是全局的 ——
  //    trace 说「用了原始分」，实际算的是全局归一化值。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: [70, 80, 90] }],
    strategy: 'zscore',
    config: { ...cfgA, fallback: 'raw' },
  });
  assert.equal(r.fallbackReason, 'raw_fallback');
  assert.equal(r.values.j1, 80, 'raw 模式下 z 必须等于原始分');
  assert.equal(r.judgeStats.j1.center, 0);
  assert.equal(r.judgeStats.j1.scale, 1);
});

test('同一 judgeId 在一个单元内出现两次 → 响亮报错，不静默覆盖', () => {
  // ⚠️ 原实现：后者直接覆盖前者，调用方看不出发生过覆盖。
  assert.throws(
    () => normalizeScores({
      samples: [
        { judgeId: 'j1', value: 80, series: A1 },
        { judgeId: 'j1', value: 95, series: A1 },
      ],
      strategy: 'zscore',
      config: cfgA,
    }),
    /judgeId/,
  );
});

test('配置缺省时用默认值（阈值默认 5）—— 不许因为没传就换口径', () => {
  // ⚠️ 原规格**所有**用例都显式传了 `minSamplesForJudgeNormalization: 5`，
  //    于是「规则文件漏写这个键时怎么办」从来没被验证过 ——
  //    把默认值改成 6，全部用例照样绿。
  const r5 = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: A1 }], // A1 长度 5
    strategy: 'zscore',
    config: {},
  });
  assert.equal(r5.normalized, true, 'n=5 恰好达到默认阈值，应当走归一化');
  assert.equal(r5.judgeStats.j1.n, 5);
  assert.equal(r5.fallbackReason, null);

  const r4 = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: [70, 80, 90, 60] }], // 长度 4
    strategy: 'zscore',
    config: {},
  });
  assert.equal(r4.normalized, false, 'n=4 低于默认阈值，应当降级');
  assert.equal(r4.fallbackReason, 'judge_sample_too_small');
});

test('样本的 value 全是非有限数 → 显式降级，不谎称「归一化成功」', () => {
  // ⚠️ 原来的行为：`normalized = true`（评委本身没降级）但 `values` 是空集 ——
  //    「声称成功却一个分数都没产出」，调用方会以为一切正常。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: null, series: A1 }],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'no_finite_values');
  assert.deepEqual(r.values, {});
});

test('产出值与统计量必须全是有限数（防御性：NaN 不许逃逸到榜单）', () => {
  for (const strategy of NORMALIZATION_STRATEGIES) {
    const r = normalizeScores({
      samples: [
        { judgeId: 'j1', value: 80, series: A1 },
        { judgeId: 'j2', value: 60, series: A2 },
      ],
      strategy,
      config: cfgA,
    });
    for (const [id, v] of Object.entries(r.values)) {
      assert.ok(Number.isFinite(v), `${strategy}/${id} 产出非有限数：${v}`);
    }
    for (const [id, st] of Object.entries(r.judgeStats)) {
      for (const k of ['n', 'mean', 'stdev', 'center', 'scale']) {
        assert.ok(Number.isFinite(st[k]), `${strategy}/${id}.${k} 非有限数：${st[k]}`);
      }
    }
    assert.ok(Number.isFinite(r.stats.mean) && Number.isFinite(r.stats.stdev));
  }
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 5 处修正，读代码前先看这段】
//   ① D-1 的 series 缺省回退**原实现根本没做**：直接 `continue` 跳过没有 series 的样本，
//      于是契约形状（INTERFACES.md 的 `samples: [{ judgeId, value }]`）产出
//      **空 values + fallbackReason = null** —— 一个「静默空成功」。现在按 D-1 兑现。
//   ② 未知策略时**全局统计被一起丢掉**（stats.n 返回 0）。全局口径与策略无关，
//      现在无论策略是否认识都照常给出。
//   ③ 配置项坏值会让 **NaN 静默逃逸**到榜单（trimmedIterations=0 → 0/0 = NaN，
//      而 normalized 仍报 true）。现在配置**fail-fast 抛错**（同构于 P0 的 validateRules）。
//   ④ `fallback: 'raw'` **名实不符**：原来仍然算全局 z 值，只是把 reason 写成 raw_fallback。
//      现在 raw 模式真的给原始分（center = 0、scale = 1 ⇒ z ≡ 原始分）。
//   ⑤ 同一 judgeId 在一个单元内出现两次会被**静默覆盖**。这是契约前提被破坏，
//      现在响亮报错。

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
  NO_FINITE_VALUES: 'no_finite_values',
});

export const FALLBACK_MODES = Object.freeze(['global', 'raw']);

/**
 * 读一个数值型配置项并做 fail-fast 校验。
 * ⛔ 为什么是「抛错」而不是「退回默认值」：配置写错若被静默改成默认值，
 *    就会重演 P1 Task 5 的 T5-8（「配置项从未被读取，行为硬编码」——
 *    配置与实现各说各话）。而且坏阈值会产出 NaN，NaN 进榜单比崩掉更可怕。
 * @param {object} config
 * @param {string} key
 * @param {number} fallback 缺省值（key 缺失时用）
 * @param {{min?:number, integer?:boolean}} opts
 */
function readConfigNumber(config, key, fallback, opts = {}) {
  const raw = config[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new TypeError(
      `归一化配置项 ${key} 非法：${JSON.stringify(raw)}（必须是有限数）`,
    );
  }
  if (opts.integer && !Number.isInteger(raw)) {
    throw new TypeError(
      `归一化配置项 ${key} 非法：${JSON.stringify(raw)}（必须是整数）`,
    );
  }
  if (opts.min !== undefined && raw < opts.min) {
    throw new TypeError(
      `归一化配置项 ${key} 非法：${JSON.stringify(raw)}（必须 ≥ ${opts.min}）`,
    );
  }
  return raw;
}

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
 * @param {Array<{judgeId:string, value:number|null, series?:number[]}>} input.samples
 *   同一个 (队伍, 维度) 单元内的样本。**一个单元内 judgeId 必须唯一**（违反 → 抛错）。
 *   `value` 是该评委对当前单元的原始分；
 *   `series` 是该评委在本维度上对**全部参赛队**的原始分序列（样本数 n_i 的来源）。
 *   **不传 series 时按 D-1 退回「同 judgeId 在本单元内的全部 value」**。
 * @param {'zscore'|'median'|'trimmed'|'bayes'} input.strategy
 * @param {object} input.config 规则配置（minSamplesForJudgeNormalization 等）
 * @returns {{normalized:boolean, values:Object<string,number>, fallbackReason:string|null,
 *            stats:{n:number,mean:number,stdev:number}, judgeStats:Object}}
 */
export function normalizeScores({ samples, strategy = 'zscore', config = {} } = {}) {
  // ── 0) 配置 fail-fast（坏配置绝不让 NaN 逃逸） ────────────────────────
  const minSamples = readConfigNumber(config, 'minSamplesForJudgeNormalization', 5, {
    min: 0,
    integer: true,
  });
  const iterations = readConfigNumber(config, 'trimmedIterations', 20, {
    min: 1,
    integer: true,
  });
  const priorStrength = readConfigNumber(config, 'bayesPriorStrength', 5, { min: 0 });
  const fallbackMode = config.fallback ?? 'global';
  if (!FALLBACK_MODES.includes(fallbackMode)) {
    throw new TypeError(
      `归一化配置项 fallback 非法：${JSON.stringify(fallbackMode)}（必须是 ${FALLBACK_MODES.join(' / ')} 之一）`,
    );
  }

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

  // ── 1) 一个单元内 judgeId 必须唯一（契约前提，违反 → 响亮报错） ───────
  const occurrence = new Map();
  for (const sample of list) {
    occurrence.set(sample.judgeId, (occurrence.get(sample.judgeId) ?? 0) + 1);
  }
  for (const [judgeId, times] of occurrence) {
    if (times > 1) {
      throw new TypeError(
        `归一化样本中评委 ${judgeId} 出现 ${times} 次 —— 一个 (队伍,维度) 单元内 judgeId 必须唯一`,
      );
    }
  }

  // ── 2) 每个评委在本单元内的原始分（D-1 的 series 缺省回退来源） ──────
  const valuesByJudge = new Map();
  for (const sample of list) {
    if (!Number.isFinite(sample.value)) continue;
    if (!valuesByJudge.has(sample.judgeId)) valuesByJudge.set(sample.judgeId, []);
    valuesByJudge.get(sample.judgeId).push(sample.value);
  }

  // ── 3) 每个评委的 series（本维度上对全部参赛队的原始分） ──────────────
  const seriesByJudge = new Map();
  for (const sample of list) {
    const judgeId = sample.judgeId;
    if (seriesByJudge.has(judgeId)) continue; // 同一评委只取一份
    const provided = Array.isArray(sample.series)
      ? sample.series.filter((v) => Number.isFinite(v))
      : [];
    // D-1：不传（或传了无效的）series → 退回「同 judgeId 在 samples 中的全部 value」
    const series = provided.length ? provided : (valuesByJudge.get(judgeId) ?? []);
    if (series.length) seriesByJudge.set(judgeId, series);
  }

  // ── 4) 全局口径统计（该维度全部 (评委, 队伍) 原始分） ────────────────
  //    ⚠️ 与策略**无关**：策略名写错也不该把全局统计一起丢掉（父代理预审修正 ②）
  const globalPool = [];
  for (const series of seriesByJudge.values()) globalPool.push(...series);
  const globalMean = arithmeticMean(globalPool);
  const globalStdev = sampleStdev(globalPool);
  const globalStats = { n: globalPool.length, mean: globalMean, stdev: globalStdev };

  if (!NORMALIZATION_STRATEGIES.includes(strategy)) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.UNKNOWN_STRATEGY,
      stats: globalStats,
      judgeStats: {},
    };
  }

  // ── 5) 逐评委统计与策略口径 ───────────────────────────────────────────
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

  // ── 6) 降级判定（必须显式，绝不静默） ─────────────────────────────────
  for (const stat of Object.values(judgeStats)) {
    if (stat.n < minSamples) {
      // 样本不足 → 退回（S7 §3.1 + C-05 第 1 条）
      stat.normalized = false;
      if (fallbackMode === 'raw') {
        // raw 模式**真的**给原始分：center = 0、scale = 1 ⇒ z ≡ 原始分（父代理预审修正 ④）
        stat.fallbackReason = FALLBACK_REASONS.RAW_FALLBACK;
        stat.center = 0;
        stat.scale = 1;
      } else {
        // 全局口径：center = 全局均值、scale = 全局标准差
        // ⇒ 映射回原始单位后等价于「不做宽严校正」（D-14）
        stat.fallbackReason = FALLBACK_REASONS.SAMPLE_TOO_SMALL;
        stat.center = globalMean;
        stat.scale = globalStdev;
      }
    }
    if (stat.scale === 0) {
      // 该评委该维度无区分度 → z 记 0（S7 §3.1 + 设计文档 §6.2 Step 2）
      stat.normalized = false;
      stat.fallbackReason = stat.fallbackReason ?? FALLBACK_REASONS.ZERO_STDEV;
    }
  }

  // ── 7) 逐评委产出 z 值 ───────────────────────────────────────────────
  const values = {};
  for (const sample of list) {
    if (!Number.isFinite(sample.value)) continue;
    const stat = judgeStats[sample.judgeId];
    if (!stat) continue;
    const z = stat.scale > 0 ? (sample.value - stat.center) / stat.scale : 0;
    // 防御性：任何非有限数都不许逃逸到榜单（父代理预审修正 ③）
    values[sample.judgeId] = Number.isFinite(z) ? z : 0;
  }

  const judgeIds = Object.keys(judgeStats).sort();
  // ⚠️ 「声称归一化成功，却一个分数都没产出」是误导 —— 必须显式降级。
  //    触发场景：样本全在，但 value 全是 null / NaN（该单元没人真正打了分）。
  if (!Object.keys(values).length) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.NO_FINITE_VALUES,
      stats: globalStats,
      judgeStats,
    };
  }
  return {
    normalized: judgeIds.length > 0 && judgeIds.every((id) => judgeStats[id].normalized),
    values,
    fallbackReason: judgeIds.map((id) => judgeStats[id].fallbackReason).find(Boolean) ?? null,
    stats: globalStats,
    judgeStats,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/normalization.test.js`
Expected: PASS（18 个测试全过：normalization.test.js 18）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/normalization.js test/normalization.test.js
git commit -m "feat(P2): 评委宽严归一化引擎（zscore/median/trimmed/bayes 4 策略 + 显式降级 + 配置 fail-fast）"
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
    - ⛔ **`minJudges` 必填且必须是 ≥1 的整数**，否则抛 `TypeError`（父代理预审修正）
      —— 缺省 / 非法会让 `list.length < minJudges` **恒为 false**，去极值闸门直接失效：
      3 个评委也去极值 → 去掉一高一低后只剩 1 个 → **该队分数完全由单个评委决定**，
      评委宽严偏差直接变成队伍分差（S7 §3.2 要求评委数达标才去极值）。
    - ⛔ 同一 `judgeId` 出现多次 → 抛 `TypeError`（否则同一个人被算成两个评委）
  - `seatScore({ dimensionScores, weights })` → `{ score, weightSum, missing }`
    - 席位加权分（0–100）：`score = Σ(w·s) / Σw`；`Σw = 0` → `score = 0` 且 `missing` 列出全部维度
    - 评委席代入即得 **P**（评委席得分）；企业席代入即得 **E**
    - ⛔ **权重必须是有限非负数**，否则抛 `TypeError`（父代理预审修正）
      —— 权重为字符串时 `weightSum += weight` 会把 `weightSum` **变成字符串**（`0 + 'x' === '0x'`），
      再拿它做除数 → NaN。类型污染 + 数值污染同时发生。
    - ⚠️ **零权重的维度不启用**：不参与分子分母，没有分也**不算缺分**
      （报进 `missing` 就是虚假告警 —— 权重表里写 0 本身就是「不启用」的意思）
    - ⚠️ **分母是实际参与计算的权重和，不是权重表全量**：
      某维度缺分时它的权重被**剔除**（并进 `missing`），
      于是结果是「**已有维度上的相对加权平均**」，不是绝对分数。
      例：`weights {a:0.5, b:0.5}`、只有 a 有分 → `score = a 的分`、`weightSum = 0.5`。
      ⛔ **Task 8 总装必须知道这条**，否则 P 的绝对值会被误读。
    - ⚠️ `dimensionScores` 里权重表**没有**的维度被忽略（权重表定义席位的构成）
    - ⚠️ `weightSum === 0`（整个席位没启用任何维度）→ `score = 0`，
      调用方**必须**自行记 warning —— `missing` 此时是空的，看不出来。

- [ ] **Step 1: 写失败的测试**

`platform/test/trim.test.js`：

```javascript
// platform/test/trim.test.js —— 去极值 + 席位加权分
//
// 依据：P2 计划 Task 3「去极值 + 评委席得分 P」
// 溯源需求：R-JDG-03（去极值）｜R-JDG-04（双席加权总分 P 的公共原语）
// 依据来源：S7 §3.2（去极值：同维度去掉一个最高一个最低再取均值，评委数 ≥5 才做）
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
      { judgeId: 'j5', z: 0 },
      { judgeId: 'j4', z: 0 },
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

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// ⚠️ 规格自带的 7 条用例全绿，但下面的缺陷在它们**全都看不见**。

test('minJudges 缺省或非法 → 响亮报错（绝不让去极值闸门失效）', () => {
  // ⚠️ 原实现：`list.length < minJudges` 在 minJudges 为 undefined/'x'/0 时**恒为 false**
  //    → 3 个评委也去极值 → 去掉一高一低后只剩 1 个 →
  //    **该队的分数完全由单个评委决定**，评委宽严偏差直接变成队伍分差。
  for (const bad of [undefined, null, 'x', 0, -1, 2.5, NaN]) {
    assert.throws(
      () => trimOutliers({
        values: [
          { judgeId: 'j1', z: 1 },
          { judgeId: 'j2', z: 2 },
          { judgeId: 'j3', z: 100 },
        ],
        minJudges: bad,
      }),
      /minJudges/,
      `minJudges=${String(bad)} 必须报错`,
    );
  }
  // 闸门真的有效：3 个评委 + minJudges=5 → 不去极值
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 100 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, false);
});

test('席位权重非法 → 响亮报错（绝不让 NaN 或字符串混进榜单）', () => {
  // ⚠️ 原实现：权重 NaN → score 变 NaN；
  //    权重 'x' → `weightSum += weight` 让 weightSum **变成字符串 "0x"**（`0 + 'x'`），
  //    再拿它做除数 → NaN。类型污染 + 数值污染同时发生。
  for (const bad of [NaN, Infinity, 'x', undefined, null]) {
    assert.throws(
      () => seatScore({ dimensionScores: { a: 80 }, weights: { a: bad } }),
      /席位权重/,
      `权重=${String(bad)} 必须报错`,
    );
  }
  // 负权重会让分数倒挂
  assert.throws(
    () => seatScore({ dimensionScores: { a: 80 }, weights: { a: -0.5 } }),
    /席位权重/,
  );
});

test('零权重的维度不启用：没有分也【不算缺分】（不要虚假告警）', () => {
  // ⚠️ 原实现：权重 0 的维度没有分时被塞进 `missing` →
  //    trace 里出现「某维度缺分」的虚假告警，而它本来就是「不启用」的维度。
  const r = seatScore({
    dimensionScores: { b: 60 },
    weights: { a: 0, b: 1 },
  });
  assert.equal(r.missing.length, 0, '权重为 0 的维度不该报缺分');
  assert.ok(Math.abs(r.score - 60) < 1e-12);
  assert.ok(Math.abs(r.weightSum - 1) < 1e-12);
});

test('同一 judgeId 出现多次 → 响亮报错，不当成两个评委', () => {
  // ⚠️ 原实现：重复的 judgeId 被当成两个评委，
  //    `removed` 甚至会出现 max === min === 'j1'（同一个人既最高又最低）。
  assert.throws(
    () => trimOutliers({
      values: [
        { judgeId: 'j1', z: 1 },
        { judgeId: 'j1', z: 50 },
        { judgeId: 'j2', z: 2 },
        { judgeId: 'j3', z: 3 },
        { judgeId: 'j4', z: 4 },
        { judgeId: 'j5', z: 5 },
      ],
      minJudges: 5,
    }),
    /judgeId/,
  );
});

test('登记口径：缺分维度的权重被剔除 → 结果是【已有维度上的相对加权平均】', () => {
  // ⚠️ Task 8 总装必须知道这条：分母是**实际参与计算的权重和**，不是权重表全量。
  const r = seatScore({
    dimensionScores: { a: 80 },
    weights: { a: 0.5, b: 0.5 },
  });
  assert.ok(Math.abs(r.score - 80) < 1e-12, '不是 40（那是把缺失维度当 0 分）');
  assert.ok(Math.abs(r.weightSum - 0.5) < 1e-12, '分母只算参与计算的权重');
  assert.deepEqual(r.missing, ['b']);
});

test('登记口径：权重表之外的维度分被忽略（权重表定义席位构成）', () => {
  const r = seatScore({
    dimensionScores: { a: 80, zzz: 999 },
    weights: { a: 1 },
  });
  assert.ok(Math.abs(r.score - 80) < 1e-12);
  assert.deepEqual(r.missing, []);
});

test('去极值的均值必须真的是【去极值后】的均值（不能等于全体均值）', () => {
  // ⚠️ 规格自带那条用例的期望值 **3 恰好**等于「去极值后均值」与「全体均值」两种算法的
  //    结果（1+2+3+4+5 的均值也是 3）—— 所以它**区分不了**「有没有真的去掉极值」。
  //    这里用一个两者结果不同的数据集把这条缝补上。
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 0 },
      { judgeId: 'j2', z: 0 },
      { judgeId: 'j3', z: 0 },
      { judgeId: 'j4', z: 0 },
      { judgeId: 'j5', z: 10 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, true);
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.removed.min, 'j1'); // 并列的 0 里字典序最小
  assert.equal(r.mean, 0, '去极值后的均值是 0；全体均值是 2 —— 两者必须不同');
});

test('非法 z 的样本被忽略，不参与去极值（不静默当 0）', () => {
  // ⚠️ 规格自带那条用例名叫「空值与非法 z 被忽略」，但它**只传了空数组** ——
  //    「非法 z」这半句从来没被验证过。
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 3 },
      { judgeId: 'j4', z: 4 },
      { judgeId: 'j5', z: 5 },
      { judgeId: 'j6', z: null },
      { judgeId: 'j7', z: NaN },
      { judgeId: 'j8', z: undefined },
      { judgeId: 'j9', z: '80' },
    ],
    minJudges: 5,
  });
  // 只有 5 个有效评委 → 去极值后 (2+3+4)/3 = 3
  assert.equal(r.trimmed, true);
  assert.equal(r.mean, 3);
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.removed.min, 'j1');
});

test('minJudges 配成 2 → 去极值会退化成空集，此时不去极值（不许算出 NaN）', () => {
  // ⚠️ 防御分支原来**零覆盖** —— minJudges=1 或 2 时 kept 为空，
  //    `kept.reduce(...) / kept.length` 就是 0/0 = NaN。
  const r = trimOutliers({
    values: [{ judgeId: 'j1', z: 10 }, { judgeId: 'j2', z: 20 }],
    minJudges: 2,
  });
  assert.equal(r.trimmed, false);
  assert.equal(r.mean, 15);
  assert.deepEqual(r.removed, { max: null, min: null });
});

test('missing 按维度名字典序输出（与权重表的写入顺序无关）', () => {
  const r = seatScore({
    dimensionScores: { innovation: 80 },
    weights: { zzz_missing: 0.1, aaa_missing: 0.2, innovation: 0.3 },
  });
  assert.deepEqual(r.missing, ['aaa_missing', 'zzz_missing']);
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 4 处修正，读代码前先看这段】
//   ① `minJudges` 缺省 / 非法 → 去极值闸门**完全失效**：
//      `list.length < undefined` 恒为 false，于是**3 个评委也去极值** ——
//      去掉一个最低一个最高后只剩 1 个，该队的分数**完全由单个评委决定**，
//      评委宽严偏差直接变成队伍分差（S7 §3.2 要求评委数达标才去极值）。
//      现在 minJudges 必填且必须是 ≥1 的整数，否则抛 TypeError。
//   ② `seatScore` 的权重**没有校验** → NaN 静默进榜单；
//      更糟的是权重为字符串时 `weightSum += weight` 会把 weightSum **变成字符串**
//      （`0 + 'x' === '0x'`）—— 类型污染，下游比较全乱。
//      现在权重必须是**有限非负数**，否则抛 TypeError。
//   ③ **零权重的维度被误报进 `missing`** → 虚假告警污染 trace 与 warning。
//      权重表里写 0 的维度是「不启用」，既不参与计算，也**不算缺分**。
//   ④ 同一 judgeId 出现两次被当成两个评委（removed 甚至会出现 max === min === 'j1'）。
//      现在响亮报错。

/**
 * 去极值。
 * @param {object} input
 * @param {Array<{judgeId:string, z:number}>} input.values 同一 (队伍, 维度) 单元内全部评委的 z
 * @param {number} input.minJudges 有效评委数下限（**必填**，≥1 的整数）；不足则不去极值
 * @returns {{mean:number, trimmed:boolean, removed:{max:string|null, min:string|null}}}
 */
export function trimOutliers({ values, minJudges } = {}) {
  if (!Number.isInteger(minJudges) || minJudges < 1) {
    throw new TypeError(
      `去极值的 minJudges 非法：${JSON.stringify(minJudges)}（必须是 ≥1 的整数 —— S7 §3.2 要求该维度评委数达标才去极值）`,
    );
  }

  const list = (Array.isArray(values) ? values : []).filter(
    (v) => v && Number.isFinite(v.z),
  );

  // 一个 (队伍, 维度) 单元内 judgeId 必须唯一 —— 否则「去掉最高最低」会把同一个人算两次
  const seen = new Set();
  for (const v of list) {
    if (seen.has(v.judgeId)) {
      throw new TypeError(
        `去极值样本中评委 ${v.judgeId} 出现多次 —— 一个 (队伍,维度) 单元内 judgeId 必须唯一`,
      );
    }
    seen.add(v.judgeId);
  }

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
 * @param {Object<string, number>} input.dimensionScores 该队各维度的最终分（0–100，由上游保证区间）
 * @param {Object<string, number>} input.weights 各维度的生效权重（**必须有限非负数**）
 * @returns {{score:number, weightSum:number, missing:string[]}}
 *   missing = 有**正权重**但没有分数的维度（调用方必须把它变成 warning，⛔ 不静默当 0）
 *
 * ⚠️ 口径提醒（Task 8 总装时必须知道）：
 *   ① `score = Σ(w·s) / Σw` 的分母是**实际参与计算的权重和**，不是权重表的全量。
 *      某维度缺分时它的权重被**剔除**（并进 `missing`），
 *      于是结果是「**已有维度上的相对加权平均**」，不是绝对分数。
 *      例：weights {a:0.5, b:0.5}、只有 a 有分 → score = a 的分、weightSum = 0.5。
 *   ② 权重为 0 的维度**不启用**：不参与分子分母、没有分也**不算缺分**。
 *   ③ `dimensionScores` 里权重表**没有**的维度被忽略（权重表定义席位的构成）。
 *   ④ `weightSum === 0`（整个席位没启用任何维度）→ `score = 0`，
 *      调用方**必须**自行记 warning —— `missing` 此时是空的，看不出来。
 */
export function seatScore({ dimensionScores, weights } = {}) {
  const scores = dimensionScores ?? {};
  const w = weights ?? {};
  let weighted = 0;
  let weightSum = 0;
  const missing = [];

  for (const key of Object.keys(w).sort()) {
    const weight = w[key];
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      throw new TypeError(`席位权重 ${key} 非法：${JSON.stringify(weight)}（必须是有限数）`);
    }
    if (weight < 0) {
      throw new TypeError(`席位权重 ${key} 非法：${weight}（不能为负）`);
    }
    if (weight === 0) {
      // 权重为 0 → 该维度在席位里**不启用**：不参与分子分母，
      // 没有分也**不算缺分**（报了就是虚假告警 —— 权重表里写 0 本身就是「不启用」的意思）。
      continue;
    }
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
Expected: PASS（17 个测试全过：trim.test.js 17）

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
  - `seatE[teamId]` = 企业席分（0–100）；**`null` 的唯一含义是「R4 生效，待评委维度替代」**，
    由 `r4Substitute[teamId].dimension` 指明替代维度
    （R1 命中时记 **0** 而不是 `null` —— 它的权重本已是 0，但形状要统一）
  - `weights[teamId]` = 该队**生效的维度权重**（R1/R4 调整后）
  - `r4Substitute[teamId]` = `{ dimension }`（R4：该队企业项改由哪个评委维度替代）
- ⛔ **确认有效性的三层判定**（父代理预审修正）—— 任何一层不过，该确认**无效**：
  1. **双签**：出题企业签字 + ≥1 名跨领域评委签字（R2 / R-JDG-06）
  2. **内容**：`content` trim 后非空（R-JDG-14「企业签字必须有内容」）
  3. **分数**：`rawScore` 是 0–100 的有限数（否则 `(1−w_E)×P + w_E×E` 会让**榜单总分破 100**）
  ⚠️ 第 ② 层必须放在**领域层**：本函数会被 `computeStage` 从库里读数据时调用，
  服务层的写入口校验挡不住历史数据与旁路写入。
- ⚠️ **R1 与 R2 语义不同，别合并**：R1（非本赛道）→ **权重**降为 0；
  R2（缺双签）→ **分数**按 0 计、权重保留。
- ⚠️ **自由命题组的有效判定与 `packageEnterpriseId` 无关**（父代理预审修正）：
  自由命题组本来就没有「本赛道企业」（`packageEnterpriseId` 为 null），
  若按赛道过滤，它的企业确认**永远**无法被认定有效 → 永远触发 R4。
  现在自由组按「三层判定」判有效。
- ⚠️ **R4 只在「该队完全没有企业确认」时接管**；
  确认存在但无效 → 按无效处理（走 R2 / R-JDG-14 / 分数越界），
  **不是** R4 —— 否则一条坏确认会被 R4 悄悄盖掉。
- ⛔ **fail-fast 抛错的三种情况**（父代理预审修正）：
  ① 配置里没有 `dimensions` ② 配置里没有 `seat="enterprise"` 的维度
  ③ **R4 触发但替代维度不可用**（`freeBrief.judgeDimension` 不在维度表里）
  —— 第 ③ 种最危险：原实现会警告「改由评委打分」，但 `r4Substitute` 为空、
  企业项按 0 分计 → **队伍被无故扣掉企业席权重，且没人知道为什么**。
- ⚠️ **R3 封顶后权重总和会小于 1**（评委席权重不动，被封掉的那部分权重凭空消失）。
  因为 `seatScore` 按 `Σw` 归一化，P 的**绝对值**不受影响；但**评委席的相对份额**变大了。
  ⛔ Task 8 总装必须知道这条。
- ⚠️ **同一企业多条有效确认 → 取平均**（库里有偏序唯一索引，正常不会发生；领域层防御性取平均）。

- [ ] **Step 1: 写失败的测试**

`platform/test/enterprise-seat.test.js`：

```javascript
// platform/test/enterprise-seat.test.js —— 企业席 E 与 R1 / R2 / R3 / R4
//
// 依据：P2 计划 Task 4「企业席 E 与 R1 / R2 / R3 / R4」
// 溯源需求：R-JDG-05（R1 分赛道）｜R-JDG-06（R2 双签）｜R-JDG-07（R3 权重封顶）
//          ｜R-JDG-08（R4 自由命题组）｜R-JDG-14（签字必须有内容）
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

const oneTeam = (teamId, extra = {}) => ({
  teamId,
  packageEnterpriseId: 'E1',
  isFreeBrief: false,
  ...extra,
});

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

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// ⚠️ 规格自带的 6 条用例全绿，但下面的缺陷在它们**全都看不见**。

test('R-JDG-14：签字内容为空或纯空白 → 该确认无效，按 0 分计 + warning', () => {
  // ⚠️ 原实现**零校验** content —— 空白的签字照样计入分数。
  //    领域层会被 computeStage 从库里读数据时调用，服务层的写入口校验挡不住
  //    历史数据与旁路写入。
  for (const content of ['', '   ', '\t\n']) {
    const r = applyEnterpriseRules({
      confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content }],
      teams: [oneTeam('t1')],
      judges: [],
      config: CONFIG,
    });
    assert.equal(r.seatE.t1, 0, `content=${JSON.stringify(content)} 必须判为无效`);
    assert.ok(
      r.warnings.some((w) => w.code === 'R_JDG14_missing_content' && w.teamId === 't1'),
      `content=${JSON.stringify(content)} 必须告警`,
    );
  }
});

test('企业确认分越界 → 该确认无效（绝不让破 100 分的分进榜）', () => {
  // ⚠️ 原实现零校验：rawScore = 1000 直接进企业席 →
  //    总分公式 (1−w_E)×P + w_E×E 会让**榜单总分破 100**。
  for (const rawScore of [1000, -1, NaN, Infinity]) {
    const r = applyEnterpriseRules({
      confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'x' }],
      teams: [oneTeam('t1')],
      judges: [],
      config: CONFIG,
    });
    assert.equal(r.seatE.t1, 0, `rawScore=${String(rawScore)} 必须判为无效`);
    assert.ok(r.warnings.some((w) => w.code === 'enterprise_score_out_of_range'));
  }
});

test('自由命题组有【有效】企业确认 → 用确认分，R4 不接管', () => {
  // ⚠️ 原实现把自由组的有效性绑在 `packageEnterpriseId` 上 ——
  //    自由命题组本来就**没有**「本赛道企业」（packageEnterpriseId 为 null），
  //    于是它的企业确认**永远**无法被认定有效 → 永远触发 R4。
  const r = applyEnterpriseRules({
    confirmations: [{ teamId: 't3', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 75, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: '由我方提供场景' }],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t3, 75, '自由组的有效确认必须被采信');
  assert.deepEqual(r.r4Substitute.t3, undefined, 'R4 不该接管');
  assert.equal(
    r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored'),
    false,
  );
});

test('自由命题组【有确认但缺双签】→ 走 R2（不是 R4）', () => {
  const r = applyEnterpriseRules({
    confirmations: [{ teamId: 't3', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 75, crossJudgeId: null, signatoryUserId: 'u_e1', content: 'x' }],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t3, 0);
  assert.ok(r.warnings.some((w) => w.code === 'R2_missing_dual_signature'));
  assert.equal(r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored'), false);
});

test('R4 生效时不发「没有企业确认」告警（自由组没有确认是预期状态）', () => {
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: CONFIG,
  });
  assert.equal(
    r.warnings.some((w) => w.code === 'no_enterprise_confirmation'),
    false,
    'R4 已经接管，再发「没有企业确认」是误导性告警',
  );
});

test('R4 触发但替代维度不可用 → 响亮报错（规则静默失效最危险）', () => {
  // ⚠️ 原实现：警告说「改由评委打分」，但 r4Substitute 为空、企业项按 0 分计
  //    —— **队伍被无故扣掉企业席权重，且没人知道为什么**。
  for (const cfg of [
    { ...CONFIG, freeBrief: { judgeDimension: 'no_such_dim' } },
    { ...CONFIG, freeBrief: undefined },
  ]) {
    assert.throws(
      () => applyEnterpriseRules({
        confirmations: [],
        teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
        judges: [],
        config: cfg,
      }),
      /R4|替代维度/,
    );
  }
});

test('配置里没有 enterprise 维度 → 响亮报错（不是静默丢分）', () => {
  const cfg = { ...CONFIG, dimensions: CONFIG.dimensions.filter((d) => d.seat !== 'enterprise') };
  assert.throws(
    () => applyEnterpriseRules({
      confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'x' }],
      teams: [oneTeam('t1')],
      judges: [],
      config: cfg,
    }),
    /enterprise/,
  );
  assert.throws(
    () => applyEnterpriseRules({ confirmations: [], teams: [oneTeam('t1')], judges: [], config: { ...CONFIG, dimensions: [] } }),
    /dimensions/,
  );
});

test('R1 命中时 seatE 记 0 而不是 null（null 的唯一含义留给 R4）', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t4, 0, 'R1 时权重已归 0，分数记 0；null 只能表示「R4 待替代」');
  assert.equal(r.seatE.t3, null, 'R4 才是 null');
});

test('wEnterprise 非法 → 响亮报错', () => {
  for (const bad of ['x', NaN, -1, Infinity]) {
    assert.throws(
      () => applyEnterpriseRules({
        confirmations: [],
        teams: [oneTeam('t1')],
        judges: [],
        config: { ...CONFIG, wEnterprise: bad },
      }),
      /wEnterprise/,
      `wEnterprise=${String(bad)} 必须报错`,
    );
  }
});

test('登记口径：R3 封顶后权重总和会小于 1（评委席权重不动）', () => {
  // R3 只压企业席的权重，评委席不动 → 被封掉的那部分权重**凭空消失**。
  // 因为 seatScore 按 Σw 归一化，P 的绝对值不受影响；但**评委席的相对份额**变大了。
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
    teams: [oneTeam('t1')],
    judges: [],
    config: over,
  });
  const sum = Object.values(r.weights.t1).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 0.85) < 1e-12, `权重和应是 0.85，实际 ${sum}`);
});

test('登记口径：同一企业多条有效确认 → 取平均', () => {
  const r = applyEnterpriseRules({
    confirmations: [
      { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'a' },
      { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 60, crossJudgeId: 'j3', signatoryUserId: 'u_e1', content: 'b' },
    ],
    teams: [oneTeam('t1')],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t1, 70, '(80+60)/2');
});

test('R4 的权重搬运：替代维度的权重真的搬到企业席了（两者不同时才验得出来）', () => {
  // ⚠️ 默认配置里 `track_fit` 与 `enterprise` 的权重**恰好都是 0.10** ——
  //    所以「搬了」与「没搬」的结果**完全一样**，这条规则从来没被真正验证过。
  //    这里把两个权重拉开、并把 wEnterprise 提到不会被 R3 压回去，才能验出差别。
  const cfg = {
    ...CONFIG,
    wEnterprise: 0.40,
    dimensions: [
      { key: 'track_fit', weight: 0.30, seat: 'judge' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: cfg,
  });
  assert.equal(r.weights.t3.track_fit, 0, '替代维度从评委席移出');
  assert.equal(r.weights.t3.enterprise, 0.30, '替代维度的权重搬到企业席（不是原来的 0.10）');
});

test('只有企业维度的确认才算企业确认（其他维度的确认不参与）', () => {
  const r = applyEnterpriseRules({
    confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'track_fit', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'x' }],
    teams: [oneTeam('t1')],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t1, 0, 'track_fit 维度的确认不是企业确认');
  assert.ok(r.warnings.some((w) => w.code === 'no_enterprise_confirmation'));
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
//   R-JDG-05 ← R1；R-JDG-06 ← R2；R-JDG-07 ← R3；R-JDG-08 ← R4；R-JDG-14（签字必须有内容）。
//
// ⚠️ R1 与 R2 的区别（本文件最容易做错的一处）：
//   R1（非本赛道）→ 该队【企业项权重】降为 0（该项不参与该队加权，权重让给评委席）
//   R2（缺双签）  → 该队【企业席分数】按 0 分计（权重保留，总分因此被扣）
//   两者都是 S7 原文，语义不同，不要合并。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【告警文案分层 2026-10-23 —— 与 src/domain/scoring.js 同一套口径】
//   { code, message, detail?, ...原有字段 }
//   ⛔ **触发条件与口径没改**，只改文案分层：
//   ① `message` 只给人读（禁止英文维度键 / 队伍 id / 评委 id / 内部原因码）。
//      本文件的告警正文本来就是人话（R1–R4 / R-JDG-14 的中文说法）⇒ **保持不变**。
//   ② `detail` 是内部明细（队伍 id）⇒ 只给有 `audit:read` 的人看，
//      由 API 层（src/services/leaderboard.js）裁剪。
//   ③ `code` 保留（审计与机器判据要用）。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 8 处修正，读代码前先看这段】
//   ① **R-JDG-14「签字必须有内容」零校验**：content 为空/纯空白的确认照样计入分数。
//      领域层会被 `computeStage` 从库里读数据时调用 —— 服务层的写入口校验挡不住
//      历史数据与旁路写入。现在内容不合规的确认**无效**。
//   ② **确认分没有 0–100 区间校验**：rawScore = 1000 直接进企业席 →
//      总分公式 (1−w_E)×P + w_E×E → 榜单破 100 分。现在越界的确认**无效**。
//   ③ **自由命题组的有效判定错误地依赖 `packageEnterpriseId`** —— 自由命题组
//      本来就没有「本赛道企业」（packageEnterpriseId 为 null），
//      于是它的企业确认**永远**无法被认定有效 → 永远触发 R4，
//      且同时发出「没有企业确认」的**误导性告警**（明明有确认记录）。
//      现在自由组按「双签齐全 + 内容合规 + 分数合法」判有效，与赛道无关。
//   ④ **R4 触发但替代维度不可用 → 规则静默失效**：demandKey 不在维度表里时，
//      警告说「改由评委打分」，但 r4Substitute 为空、企业项按 0 分计
//      —— **队伍被无故扣掉企业席权重，且没人知道为什么**。现在 fail-fast 抛错。
//   ⑤ **R4 生效时仍发「没有企业确认」告警** → 误导（自由组没有企业确认是预期状态）。
//   ⑥ **配置里没有 enterprise 维度 → 企业确认被完全忽略**，却告警说「没有有效的
//      企业确认记录」—— 实为配置缺陷。现在 fail-fast 抛错。
//   ⑦ **R1 命中时 seatE 是 `null`** —— 但计划只说「R4 生效时为 null」。
//      现在 null 的**唯一含义**是「R4 待评委维度替代」，R1 记 0（其权重本已是 0）。
//   ⑧ `wEnterprise` 非法（NaN / 字符串）→ 静默不封顶。现在 fail-fast 抛错。

/**
 * @param {object} input
 * @param {Array} input.confirmations
 *   [{ teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content }]
 * @param {Array} input.teams [{ teamId, packageEnterpriseId, isFreeBrief }]
 * @param {Array} input.judges 评委池（**当前未使用**，预留企业席归属校验）
 * @param {object} input.config rules.scoring.initial | rules.scoring.final
 * @returns {{seatE:Object<string, number|null>, weights:Object<string,Object<string,number>>,
 *            warnings:Array<{code:string,message:string,teamId?:string}>,
 *            r4Substitute:Object<string,{dimension:string}>}}
 *   `seatE[teamId] === null` 的**唯一**含义是「R4 生效，待评委维度替代」，
 *   由 `r4Substitute[teamId].dimension` 指明替代维度。
 */
export function applyEnterpriseRules({ confirmations = [], teams = [], judges = [], config = {} } = {}) {
  const warnings = [];
  const seatE = {};
  const weights = {};
  const r4Substitute = {};

  const dimensions = Array.isArray(config.dimensions) ? config.dimensions : [];
  const enterpriseKeys = dimensions.filter((d) => d.seat === 'enterprise').map((d) => d.key);
  const enterpriseKey = enterpriseKeys[0] ?? null;

  // ── 配置 fail-fast（坏规则宁可炸掉，也不要静默算出错的 E） ─────────────
  if (!dimensions.length) {
    throw new TypeError('规则配置里没有 dimensions —— 无法计算企业席');
  }
  if (!enterpriseKeys.length) {
    throw new TypeError(
      '规则配置里没有 seat="enterprise" 的维度 —— 企业席是双席制的基本组成',
    );
  }
  const demandKey = config.freeBrief?.judgeDimension ?? null;
  const rawWEnterprise = config.wEnterprise ?? 0;
  if (typeof rawWEnterprise !== 'number' || !Number.isFinite(rawWEnterprise) || rawWEnterprise < 0) {
    throw new TypeError(
      `规则配置项 wEnterprise 非法：${JSON.stringify(rawWEnterprise)}（必须是 ≥0 的有限数）`,
    );
  }
  const wEnterprise = rawWEnterprise;

  for (const team of teams) {
    const base = {};
    for (const d of dimensions) base[d.key] = d.weight;
    const eff = { ...base };

    const mine = (confirmations ?? []).filter(
      (c) => c.teamId === team.teamId && enterpriseKeys.includes(c.dimension),
    );
    // 自由命题组没有「本赛道企业」概念 → R1 不适用（否则会与 R4 打架）
    // 自由命题组按「内容合规」判有效，与 packageEnterpriseId 无关（父代理预审修正 ③）
    const inTrack = team.isFreeBrief
      ? mine
      : mine.filter((c) => c.enterpriseId === team.packageEnterpriseId);

    // ── 有效性三层判定 ──────────────────────────────────────────────────
    //   ① 双签：出题企业签字 + ≥1 名跨领域评委签字，缺任一即不成立（R2）
    //   ② 内容：R-JDG-14「企业签字必须有内容」（解决哪个环节/落地时间/我方角色）
    //   ③ 分数：必须在 0–100，否则企业席会算出破 100 分的总分
    const classified = inTrack.map((c) => {
      if (!c.crossJudgeId || !c.signatoryUserId) return { c, reason: 'dual_signature' };
      if (typeof c.content !== 'string' || !c.content.trim()) return { c, reason: 'content' };
      if (!Number.isFinite(c.rawScore) || c.rawScore < 0 || c.rawScore > 100) {
        return { c, reason: 'score_range' };
      }
      return { c, reason: null };
    });
    const valid = classified.filter((x) => x.reason === null).map((x) => x.c);
    const failed = classified.filter((x) => x.reason !== null);
    const hasReason = (reason) => failed.some((x) => x.reason === reason);

    // ⚠️ 父代理预审修正（Critical，C1 / D-30）：**R1 只依据「有效的」非本赛道确认判定**。
    //    原来 `outOfTrack` 是「全部非本赛道确认」，于是一条**无效**的记录（缺双签 / 内容空白 /
    //    分数越界）也能把该队的**企业项权重整段归零** —— 而写入口一旦被绕过（冒名签字），
    //    攻击者就能用一条垃圾记录「连坐」掉受害队伍的企业席（初赛 10% / 决赛 25%）。
    //    现在：无效记录不触发 R1；**本赛道企业已合法确认时，R1 也不再把权重归零**
    //    （R1 的本意是「本赛道企业没确认 ⇒ 企业席不适用」，不是「有人冒签就整队作废」）。
    const outOfTrackClassified = (team.isFreeBrief
      ? []
      : mine.filter((c) => c.enterpriseId !== team.packageEnterpriseId)).map((c) => {
      if (!c.crossJudgeId || !c.signatoryUserId) return { c, reason: 'dual_signature' };
      if (typeof c.content !== 'string' || !c.content.trim()) return { c, reason: 'content' };
      if (!Number.isFinite(c.rawScore) || c.rawScore < 0 || c.rawScore > 100) return { c, reason: 'score_range' };
      return { c, reason: null };
    });
    const validOutOfTrack = outOfTrackClassified.filter((x) => x.reason === null).map((x) => x.c);
    const outOfTrack = validOutOfTrack;

    // R4 只在「该队**完全没有**企业确认」时接管；确认存在但无效 → 按无效处理
    const r4Candidate = Boolean(team.isFreeBrief) && inTrack.length === 0;
    if (r4Candidate && (!demandKey || base[demandKey] == null)) {
      // 规则要替代却替代不了 → 宁可炸掉，也不能「警告说替代、实际按 0 分计」
      throw new TypeError(
        `自由命题组 ${team.teamId} 触发 R4，但替代维度 ${JSON.stringify(demandKey)} 不在维度表里 —— `
        + '规则无法执行（企业项既不能由企业打分，也没有评委维度可替代）',
      );
    }

    let score = null;

    if (outOfTrack.length) {
      // R1：企业评委给非本企业题目打分 → 该队企业项权重自动降为 0
      // ⚠️ 但**本赛道企业已合法确认时不得降权**（D-30）：
      //    「别家企业也签了一条」不该把本赛道企业的合法签字一起废掉。
      if (enterpriseKey && !valid.length) eff[enterpriseKey] = 0;
      warnings.push({
        code: 'R1_out_of_track',
        message: valid.length
          ? '有非本赛道企业的有效确认（已忽略，不影响本赛道企业的签字）'
          : '企业席评了非本企业题目，该队「企业确认」权重降为 0',
        detail: `队伍 ${team.teamId}`,
        teamId: team.teamId,
      });
    }

    if (hasReason('dual_signature')) {
      // R2：缺双签 → 该项按 0 分计（权重保留）
      score = 0;
      warnings.push({
        code: 'R2_missing_dual_signature',
        message: '企业确认缺双签（出题企业签字 / 跨领域评委签字），该项按 0 分计',
        detail: `队伍 ${team.teamId}`,
        teamId: team.teamId,
      });
    } else if (hasReason('content')) {
      // R-JDG-14：签字必须有内容
      score = 0;
      warnings.push({
        code: 'R_JDG14_missing_content',
        message: '企业确认缺签字内容（R-JDG-14 要求写明解决哪个环节 / 落地时间 / 我方角色），该项按 0 分计',
        detail: `队伍 ${team.teamId}（规则 R-JDG-14：签字必须有内容）`,
        teamId: team.teamId,
      });
    } else if (hasReason('score_range')) {
      // 分数越界 → 该项按 0 分计（绝不让破 100 分的分进榜）
      score = 0;
      warnings.push({
        code: 'enterprise_score_out_of_range',
        message: '企业确认分不在 0–100 区间，该项按 0 分计',
        detail: `队伍 ${team.teamId}`,
        teamId: team.teamId,
      });
    } else if (valid.length) {
      score = valid.reduce((acc, c) => acc + c.rawScore, 0) / valid.length;
    } else if (!outOfTrack.length && !r4Candidate) {
      score = 0;
      warnings.push({
        code: 'no_enterprise_confirmation',
        message: '该队没有有效的企业确认记录，企业席按 0 分计',
        detail: `队伍 ${team.teamId}`,
        teamId: team.teamId,
      });
    }

    // R1：权重已归 0，分数无意义 —— 但记 0 而不是 null，
    // 让 `seatE === null` 的唯一含义留给 R4（父代理预审修正 ⑦）
    if (outOfTrack.length && score === null) score = 0;

    // R4：自由命题组无企业签字 → 该项改由评委按「需求真实性的公开证据」打分
    if (r4Candidate) {
      eff[demandKey] = 0;                      // 替代维度从评委席移出，避免双重计分
      if (enterpriseKey) eff[enterpriseKey] = base[demandKey]; // 权重搬到企业席
      r4Substitute[team.teamId] = { dimension: demandKey };
      score = null;                            // 具体分数由评分流水线用评委维度分填充
      warnings.push({
        code: 'R4_free_brief_judge_scored',
        message: '自由命题组无企业签字，「企业确认」项改由评委按需求真实性的公开证据打分',
        detail: `队伍 ${team.teamId}`,
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
          detail: `队伍 ${team.teamId}：企业席合计权重 ${wE}，封顶后为 ${wEnterprise}`,
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
Expected: PASS（19 个测试全过：enterprise-seat.test.js 19）

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
    - ⛔ `threshold` 必须是有限数（否则比较恒 false → **静默产出零 flag**，看上去像「所有自评都正常」）
    - ⛔ `judgeScores` 每个 `(teamId, dimension)` **只能一条**（重复 → 抛错；
      否则 Map.set 静默覆盖，结果取决于数组顺序 → 不可复算）
    - ⚠️ `flags` 排序用**普通字典序**而非 `localeCompare` —— 后者依赖 locale 与 ICU 版本，
      跨机器结果可能不同 → 破坏「可复算」（与 `trim.js` 一致）
  - `checkPeerEligibility({ teams, deliverables })` → `{ eligible, ineligible }`
    - `teams` = `[{ teamId }]`；`deliverables` = `[{ teamId, hasRealDeliverable }]`
    - 只有该赛段有**真实交付物**的队伍才可参与互评（R-RNK-07）
    - ⚠️ `eligible` / `ineligible` 按队号字典序输出；`teams` 重复 → 去重；
      `deliverables` 重复 → 抛错（不静默取最后一条）
  - `checkRecusal({ judge, team, recusalRecords })` → `{ recused, record? }`
    - `judge` = `{ userId }`；`team` = `{ teamId }`；`recusalRecords` = `[{ judge_id, team_id, action, reason, declared_at? }]`
    - ⛔ **取最后一条匹配记录**（按 `declared_at`，缺省按数组顺序）——
      回避记录是 **append-only** 的，「回避 → 复核 → 撤销」会留下**两条**；
      取第一条会让 `action='reinstated'` 的那条**从未被读到** → **撤销功能整个是死的**
    - ⚠️ `team_id` 为 `null` / `undefined` = **赛段级回避**，对该赛段所有队生效
  - `checkJudgePool({ judges, config })` → `{ ok, errors, stats }`
    - `judges` = `[{ judgeId, seat }]`；`config` = `rules.scoring.*.judgePool` 段
    - 观察员（`seat='observer'`）**无投票权**，不计入任何比例
    - ⛔ **配置项必须是有限数**（否则 `Number('x')` = NaN → 对应校验**整条静默失效**）
    - ⚠️ **席类型不在名单里的评委 → 报错 `unknown_seat`**（既不计入 voting 也不计入 observer，
      `stats.total` 与 `voting + observer` 对不上却无告警，而且他们本该属于哪个席会影响占比判断）
    - ⚠️ **重复 `judgeId` → 报错 `duplicate_judge`**（否则专家席/企业席占比算错），
      且统计按**去重后**的人数算（`stats` 反映真实人数，`error` 标记问题）

- [ ] **Step 1: 写失败的测试**

`platform/test/self-eval.test.js`：

```javascript
// platform/test/self-eval.test.js —— 自评测差异检测
//
// 依据：P2 计划 Task 5「自评测差异检测」
// 溯源需求：R-JDG-13（d>10 要书面说明 / d<−10 只提问）
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

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('threshold 非法 → 响亮报错（绝不静默产出零 flag）', () => {
  // ⚠️ 原实现：threshold='x' → NaN → `d > NaN` 恒 false → **静默零 flag**，
  //    看上去像「所有自评都正常」。
  for (const bad of ['x', NaN, Infinity, null]) {
    if (bad === null) continue; // null = 缺省，走默认值 10，合法
    assert.throws(
      () => detectSelfEvalDiff({
        selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
        judgeScores: JUDGE,
        threshold: bad,
      }),
      /threshold/,
      `threshold=${String(bad)} 必须报错`,
    );
  }
});

test('同一 (队伍,维度) 的评委分出现多条 → 响亮报错（不静默取最后一条）', () => {
  // ⚠️ 原实现：Map.set 静默覆盖 → 结果取决于数组顺序 → 不可复算。
  assert.throws(
    () => detectSelfEvalDiff({
      selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
      judgeScores: [
        { teamId: 't1', dimension: 'innovation', score: 90 },
        { teamId: 't1', dimension: 'innovation', score: 80 },
      ],
      threshold: 10,
    }),
    /队伍|维度/,
  );
});

test('flags 排序用【普通字典序】而非 localeCompare（跨机器可复算）', () => {
  // ⚠️ 原实现用 `localeCompare` → 依赖运行环境的 locale 与 ICU 版本，
  //    同一份数据在不同机器上可能排出**不同顺序** → 破坏「可复算」。
  //    ASCII 序：'1'(49) < '2'(50) < 'B'(66) < 'a'(97)，且 'T'(84) < 't'(116)。
  const teams = ['tB', 'ta', 'T1', 't2', 't10'];
  const r = detectSelfEvalDiff({
    selfReviews: teams.map((teamId) => ({ teamId, dimension: 'innovation', rawScore: 95 })),
    judgeScores: teams.map((teamId) => ({ teamId, dimension: 'innovation', score: 80 })),
    threshold: 10,
  });
  assert.deepEqual(
    r.flags.map((f) => f.teamId),
    ['T1', 't10', 't2', 'tB', 'ta'],
    '必须按普通字典序（ASCII）排序，不受 locale 影响',
  );
});
```

`platform/test/review-eligibility.test.js`：

```javascript
// platform/test/review-eligibility.test.js —— 互评资格 + 回避判定
//
// 依据：P2 计划 Task 5「回避制度 + 互评资格」
// 溯源需求：R-RNK-07（互评资格门槛）｜R-JDG-09（回避制度，回避记录留档）
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

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('回避被撤销时，撤销必须生效（记录是 append-only 的，要取最后一条）', () => {
  // ⚠️ 原实现：`for` 循环遇到**第一条**匹配记录就 return。
  //    而 `recusal_records` 是 append-only 的 ——「回避 → 组委会复核 → 撤销」
  //    会留下**两条**记录，于是取到的是第一条 `recused`，
  //    `action='reinstated'` 的那条**从未被读到** → 撤销功能整个是死的。
  //    规格自带的用例只给了**单条** reinstated 记录，正好掩盖了这一点。
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主' },
      { judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核' },
    ],
  });
  assert.equal(r.recused, false, '后一条 reinstated 必须覆盖前面的 recused');
  assert.equal(r.record, undefined);
});

test('撤销之后又重新回避 → 以最后一条 recused 为准', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核' },
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '又查出了利益关系' },
    ],
  });
  assert.equal(r.recused, true);
  assert.equal(r.record.reason, '又查出了利益关系');
});

test('多条记录按 declared_at 取最新（不看数组顺序）', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核', declared_at: '2026-10-21T00:00:00.000Z' },
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主', declared_at: '2026-10-20T00:00:00.000Z' },
    ],
  });
  assert.equal(r.recused, false, 'declared_at 更新的那条作数');
});

test('赛段级回避：team_id 为 undefined 也算（数据来源变化不漏判）', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't9' },
    recusalRecords: [{ judge_id: 'u1', team_id: undefined, action: 'recused', reason: '赛段级' }],
  });
  assert.equal(r.recused, true);
});

test('teams 有重复 → 同一队只判一次（eligible 里不出现重复队号）', () => {
  const r = checkPeerEligibility({
    teams: [{ teamId: 't1' }, { teamId: 't1' }],
    deliverables: [{ teamId: 't1', hasRealDeliverable: true }],
  });
  assert.deepEqual(r.eligible, ['t1']);
  assert.deepEqual(r.ineligible, []);
});

test('eligible / ineligible 按队号字典序输出（与输入顺序无关）', () => {
  // ⚠️ 规格自带那条用例的 teams 恰好已是字典序 → 排序**从来没被验证过**。
  //    这里刻意把输入顺序打乱（tb,td,ta,tc）—— 否则「排序」与「不排序」结果一样。
  const r = checkPeerEligibility({
    teams: [{ teamId: 'tb' }, { teamId: 'td' }, { teamId: 'ta' }, { teamId: 'tc' }],
    deliverables: [
      { teamId: 'ta', hasRealDeliverable: true },
      { teamId: 'tb', hasRealDeliverable: true },
    ],
  });
  assert.deepEqual(r.eligible, ['ta', 'tb']);
  assert.deepEqual(r.ineligible, ['tc', 'td']);
});

test('deliverables 有重复 → 响亮报错（不静默取最后一条）', () => {
  assert.throws(
    () => checkPeerEligibility({
      teams: [{ teamId: 't1' }],
      deliverables: [
        { teamId: 't1', hasRealDeliverable: true },
        { teamId: 't1', hasRealDeliverable: false },
      ],
    }),
    /交付物/,
  );
});
```

`platform/test/judge-pool.test.js`：

```javascript
// platform/test/judge-pool.test.js —— 评委池规模与席构成校验
//
// 依据：P2 计划 Task 5「评委池校验」
// 溯源需求：R-JDG-10（初赛每维度 ≥7 人 / 决赛 ≥9 人）｜R-JDG-11（席构成；观察员无投票权）
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

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('配置项非法 → 响亮报错（绝不静默跳过对应校验）', () => {
  // ⚠️ 原实现：`Number('x')` = NaN → `minJudges > 0` 恒 false →
  //    **「人数不足」这条校验整条失效**，组委会会以为评委池合规。
  for (const key of ['minJudgesPerDimension', 'minEnterpriseSeatShare', 'maxExpertSeatShare']) {
    for (const bad of ['x', NaN, Infinity]) {
      assert.throws(
        () => checkJudgePool({ judges: pool(2, 1, 0), config: { ...CFG_INITIAL, [key]: bad } }),
        new RegExp(key),
        `${key}=${String(bad)} 必须报错`,
      );
    }
  }
});

test('席类型写错的评委 → 报错（绝不静默消失）', () => {
  // ⚠️ 原实现：既不计入 voting 也不计入 observer，
  //    `stats.total` 与 `voting + observer` **对不上**，却没有任何告警 ——
  //    而且这些评委本该属于哪个席会影响占比判断。
  const r = checkJudgePool({
    judges: [...pool(4, 5, 0), { judgeId: 'x1', seat: 'guest' }, { judgeId: 'x2', seat: 'guest' }],
    config: CFG_INITIAL,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'unknown_seat'));
  assert.equal(r.stats.unknownSeat, 2);
  // 账要能对上：total = voting + observer + unknown
  assert.equal(
    r.stats.total,
    r.stats.voting + r.stats.observer + r.stats.unknownSeat,
  );
});

test('重复 judgeId → 报错，且统计按去重后的人数算', () => {
  // ⚠️ 原实现：重复的 judgeId 被当成两个人 → 专家席占比算错。
  const r = checkJudgePool({
    judges: [...pool(4, 5, 0), { judgeId: 'e1', seat: 'judge' }],
    config: CFG_INITIAL,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate_judge'));
  assert.equal(r.stats.voting, 9, '统计必须按去重后的评委算');
  assert.equal(r.stats.expert, 4);
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 3 处修正，读代码前先看这段】
//   ① `threshold` 非法（NaN / 字符串）→ 比较恒为 false → **静默产出零 flag**，
//      看上去像「所有自评都正常」。现在 fail-fast 抛错。
//   ② `judgeScores` 同一 (teamId, dimension) 出现多条 → **后者静默覆盖前者**，
//      而结果取决于数组顺序 → 不可复算。现在响亮报错（契约前提：每格一条聚合分）。
//   ③ `flags` 排序用 `localeCompare` → **依赖运行环境的 locale 与 ICU 版本**，
//      同一份数据在不同机器上可能排出不同顺序 → 破坏「可复算」。
//      现在改用与 `trim.js` 一致的普通字典序比较（ASCII 序）。

export const SELF_EVAL_ACTIONS = Object.freeze({
  WRITTEN_EXPLANATION: 'written_explanation',
  JUDGE_QUESTION: 'judge_question',
});

/**
 * @param {object} input
 * @param {Array<{teamId:string, dimension:string, rawScore:number}>} input.selfReviews
 * @param {Array<{teamId:string, dimension:string, score:number}>} input.judgeScores 评委席同尺度分
 *   ⚠️ **每个 (teamId, dimension) 只能一条**（重复 → 抛错）
 * @param {number} input.threshold 阈值（默认 10，配置在 rules/*.json）
 * @returns {{flags:Array<{teamId:string, dimension:string, d:number, action:string}>}}
 */
export function detectSelfEvalDiff({ selfReviews = [], judgeScores = [], threshold = 10 } = {}) {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new TypeError(
      `自评差异检测的 threshold 非法：${JSON.stringify(threshold)}（必须是有限数）`,
    );
  }

  const judgeMap = new Map();
  for (const j of judgeScores) {
    const key = `${j.teamId}::${j.dimension}`;
    if (judgeMap.has(key)) {
      throw new TypeError(
        `评委分里 (队伍 ${j.teamId}, 维度 ${j.dimension}) 出现多条 —— 每格只能有一条聚合分`,
      );
    }
    judgeMap.set(key, j.score);
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
  // ⚠️ 用普通字典序而非 localeCompare —— 后者依赖 locale 与 ICU 版本，跨机器结果可能不同
  flags.sort((a, b) => {
    if (a.teamId !== b.teamId) return a.teamId < b.teamId ? -1 : 1;
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    return 0;
  });
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 3 处修正，读代码前先看这段】
//   ① **回避的「撤销」永远失效**（本文件最严重的一处）：原实现 `for` 循环遇到**第一条**
//      匹配记录就 return，而 `recusal_records` 是 **append-only** 的 ——
//      「回避 → 组委会复核 → 撤销回避」会留下**两条**记录，
//      于是取到的是第一条 `recused`，`action='reinstated'` 的那条**从未被读到**。
//      规格自带的用例只给了**单条** reinstated 记录，正好掩盖了这一点。
//      现在取**最后一条**匹配记录（按 `declared_at`，缺省按数组顺序）再判它的 action。
//   ② `team_id` 为 `undefined` 时不当作赛段级回避（只有 `null` 才算）——
//      数据来源变化就会漏判。现在 `null` / `undefined` 都算赛段级。
//   ③ `teams` 有重复 → `eligible` 里出现重复队号；`deliverables` 有重复 → 后者静默覆盖前者。
//      现在 teams 去重、deliverables 重复报错。

/**
 * 互评资格：只对该赛段有真实交付物的队伍开放互评（R-RNK-07）。
 * @param {object} input
 * @param {Array<{teamId:string}>} input.teams
 * @param {Array<{teamId:string, hasRealDeliverable:boolean}>} input.deliverables
 *   ⚠️ 同一队只能一条（重复 → 抛错）
 * @returns {{eligible:string[], ineligible:string[]}}
 */
export function checkPeerEligibility({ teams = [], deliverables = [] } = {}) {
  const deliverableMap = new Map();
  for (const d of deliverables) {
    if (deliverableMap.has(d.teamId)) {
      throw new TypeError(`互评资格：队伍 ${d.teamId} 有多条交付物记录 —— 数据异常`);
    }
    deliverableMap.set(d.teamId, !!d.hasRealDeliverable);
  }

  const eligible = [];
  const ineligible = [];
  const seen = new Set();
  for (const t of teams) {
    if (seen.has(t.teamId)) continue; // 同一队只判一次
    seen.add(t.teamId);
    if (deliverableMap.get(t.teamId)) eligible.push(t.teamId);
    else ineligible.push(t.teamId);
  }
  eligible.sort();
  ineligible.sort();
  return { eligible, ineligible };
}

/**
 * 回避判定：命中**最新一条**回避记录即不可评该队。
 * @param {object} input
 * @param {{userId:string}} input.judge
 * @param {{teamId:string}} input.team
 * @param {Array<{judge_id:string, team_id:string|null, action:string, reason:string, declared_at?:string}>} input.recusalRecords
 *   ⚠️ 记录是 append-only 的：「回避 → 复核 → 撤销」会留下两条，**最后一条**才作数。
 * @returns {{recused:boolean, record?:object}}
 */
export function checkRecusal({ judge, team, recusalRecords = [] } = {}) {
  if (!judge?.userId) return { recused: false };
  const teamId = team?.teamId;

  // 收集该评委对该队（或对该赛段整体）的全部记录
  const matching = recusalRecords.filter((record) => {
    if (record.judge_id !== judge.userId) return false;
    const scope = record.team_id;
    // team_id 为 null / undefined = 赛段级回避，对该赛段所有队生效
    return scope === null || scope === undefined || scope === teamId;
  });
  if (!matching.length) return { recused: false };

  // ⛔ 取**最后**一条：`action='reinstated'`（已撤销）必须能覆盖前面的 `recused`。
  //    有 declared_at 就按时间取最新的；都没有就按数组顺序取靠后的。
  const latest = matching.reduce((acc, r) => {
    if (!acc) return r;
    const a = acc.declared_at ?? '';
    const b = r.declared_at ?? '';
    if (a === b) return r;        // 时间相同 → 数组里靠后的更新
    return b > a ? r : acc;       // 时间新的作数
  }, null);

  if (latest.action !== 'recused') return { recused: false };
  return { recused: true, record: latest };
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 3 处修正，读代码前先看这段】
//   ① **配置项非法时，对应的校验被静默跳过**：`Number('x')` = NaN，
//      `minJudges > 0` 恒为 false → 「人数不足」这条校验**整条失效**，
//      组委会会以为评委池合规。现在配置 fail-fast 抛错。
//   ② **席类型写错的评委被静默消失**：既不计入 voting 也不计入 observer，
//      `stats.total` 与 `voting + observer` **对不上**，却没有任何告警 ——
//      而且这些评委本该属于哪个席会影响占比判断。现在报错 `unknown_seat`。
//   ③ **重复 judgeId 被当成两个人** → 专家席/企业席占比算错。现在报错 `duplicate_judge`，
//      且统计按**去重后**的评委算（stats 反映真实人数，error 标记问题）。

/**
 * @param {object} input
 * @param {Array<{judgeId:string, seat:string}>} input.judges
 * @param {object} input.config rules.scoring.*.judgePool
 * @returns {{ok:boolean, errors:Array<{code:string,message:string}>, stats:object}}
 */
export function checkJudgePool({ judges = [], config = {} } = {}) {
  const votingSeats = config.votingSeats ?? ['judge', 'enterprise'];
  const nonVotingSeats = config.nonVotingSeats ?? ['observer'];

  // ── 配置 fail-fast（坏配置会让整条校验静默失效） ─────────────────────
  const readNumber = (key, fallback, label) => {
    const raw = config[key] ?? fallback;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new TypeError(
        `评委池配置项 ${key} 非法：${JSON.stringify(raw)}（必须是有限数）`,
      );
    }
    return raw;
  };
  const minJudges = readNumber('minJudgesPerDimension', 0);
  const minEnterpriseShare = readNumber('minEnterpriseSeatShare', 0);
  const maxExpertShare = readNumber('maxExpertSeatShare', 1);

  const errors = [];

  // ── 去重 + 识别异常数据 ──────────────────────────────────────────────
  const seenIds = new Set();
  const unique = [];
  const duplicated = [];
  for (const j of judges) {
    if (seenIds.has(j.judgeId)) {
      duplicated.push(j.judgeId);
      continue;
    }
    seenIds.add(j.judgeId);
    unique.push(j);
  }
  if (duplicated.length) {
    errors.push({
      code: 'duplicate_judge',
      message: `评委名单里有 ${duplicated.length} 个重复的 judgeId：${[...new Set(duplicated)].join(', ')}`,
    });
  }

  const knownSeats = new Set([...votingSeats, ...nonVotingSeats]);
  const unknownSeat = unique.filter((j) => !knownSeats.has(j.seat));
  if (unknownSeat.length) {
    errors.push({
      code: 'unknown_seat',
      message: `有 ${unknownSeat.length} 名评委的席类型不在 votingSeats / nonVotingSeats 名单里：${[...new Set(unknownSeat.map((j) => j.seat))].join(', ')}`,
    });
  }

  const voting = unique.filter((j) => votingSeats.includes(j.seat));
  const nonVoting = unique.filter((j) => nonVotingSeats.includes(j.seat));
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
      unknownSeat: unknownSeat.length,
      enterpriseShare,
      expertShare,
      perDimension,
    },
  };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/self-eval.test.js test/review-eligibility.test.js test/judge-pool.test.js`
Expected: PASS（27 个测试全过：self-eval.test.js 7 + review-eligibility.test.js 12 + judge-pool.test.js 8）

> **【2026-10-21 漂移审计修正 M-1】** 本计划的条数声明与代码块实测**逐条相符**（无需改数字），
> 但格式与其他四份计划不一致。**改成什么**：把本计划**全部 8 处** `Expected: PASS` 统一成
> `Expected: PASS（N 个测试全过：file N）` 的格式；多文件时逐文件列出
> （如上面这一行：`self-eval.test.js 4 + review-eligibility.test.js 5 + judge-pool.test.js 5`）。
> **依据**：与审计报告 M-1 末行的格式统一建议一致；
> 本轮改动后**对五份计划全量复算**：每一条 `Expected: PASS（N …）` 现已与代码块实测条数
> **逐条相等**，且五份计划的格式统一。

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/domain/self-eval.js src/domain/review-eligibility.js src/domain/judge-pool.js test/self-eval.test.js test/review-eligibility.test.js test/judge-pool.test.js
git commit -m "feat(P2): 自评差异检测、回避制度、互评资格与评委池校验"
```

---

### Task 6: 评分提交服务 + 幂等 + 增量 score_stats

**Files:**
- Create: `platform/src/db/repo/audit-log.js`
- Create: `platform/src/db/repo/stages.js`
- Create: `platform/src/db/repo/reviews.js`
- Create: `platform/src/db/repo/request-keys.js`
- Create: `platform/src/db/repo/enterprise-confirmations.js`
- Create: `platform/src/db/repo/peer-reviews.js`
- Create: `platform/src/db/repo/self-reviews.js`
- Create: `platform/src/db/repo/recusals.js`
- Create: `platform/src/audit/log.js`（**薄服务门面**：本文件**不含 SQL**）
- Create: `platform/src/services/review.js`
- Create: `platform/test/review-service.test.js`

**Interfaces:**
- Consumes: P0 `openDatabase`；Task 1 的表；Task 5 的 `checkRecusal` / `checkPeerEligibility`
- Produces:
  - ⚠️ **利益冲突声明的接线（R-JDG-18，父代理预审修正 Important）**：
    `assignStageJudge` 在写入 `stage_judges` 的**同时**写入 `conflict_declarations`
    并回填 `conflict_declared_at` / `conflict_declaration_id`；
    配套用例必须断言「分配评委后声明表多一行、且 `stage_judges` 两列被填上」。
    **不接线 = R-JDG-18 静默失效**（与 P1 的 A1 / T4-5 同一类病根：机制写下来了但没接线）
  - ⚠️ **测试夹具必须建真实数据**（父代理预审修正 Important）：Task 1 补齐了引用型外键
    （`judge_id → users`、`team_id → teams`、`stage_id → stages`），
    本任务及 Task 7 / Task 8 的夹具**不能再用** `'j1'` / `'t1'` / `'ed1'` 假 id
  - `submitReviews({ db, stageId, judgeId, items, requestId, now })` → `{ stageId, judgeId, requestId, submitted, items }`
    - 幂等：同一 `requestId` 重复提交只生效一次
    - 观察员 → 403；已回避该队 → 403
    - 写 `stage_reviews` + **增量**更新 `score_stats`（n / mean / sum_sq）
    - ⛔ **「抢幂等键」与「写数据」必须在同一个事务里**（父代理预审修正，Critical）：
      原来抢键成功后写数据失败（如评委被回避 → 403），**键已经占住** →
      客户端用同一个 `requestId` 重试会被判成「重复请求」而返回 `submitted: 0`
      —— **评委以为提交成功了，实际一条都没落库**。
      现在「抢键 + 写数据 + 更新统计 + 审计」在一个事务里，要么全成要么全回滚。
    - ⛔ **同一个 `requestId` 用于不同内容 → 409**（`REQUEST_ID_REUSED`），
      不静默继续写 —— 否则「这个 request 到底写了什么」永远说不清。
    - ⛔ **分数必须在 0–100**（否则污染 `score_stats` 与后续归一化）→ 400 `SCORE_OUT_OF_RANGE`
    - ⛔ **赛段不存在 → 404** `STAGE_NOT_FOUND`（不把外键原文漏给调用方）
  - `getReviewState({ db, stageId, viewer, dimensions? })` → `{ submitted, total, missing, dimensionProgress }`
    - ⚠️ **应交队伍必须来自赛段真实名册**（`listStageTeams`），⛔ 不是「已有打分记录里
      出现过的队伍」—— 后者会让「完全没人打分的队」从名单里消失，
      进度显示 100% 而实际有队没被评。
    - ⚠️ `dimensions` 省略时取「已出现过的维度」；Task 8 的 API 层应显式传规则里的维度全集，
      否则「从未有人评过的维度」不会出现在进度里。
  - `submitCalibration({ db, stageId, judgeId, items, now })` → `{ stageId, judgeId, submitted }`（写 `calibrations`，**不计入评分**）
  - `submitPeerReviews({ db, stageId, items, requestId, actorId?, now })` → `{ stageId, submitted }`
    - ⚠️ **幂等键的 `subjectId` 用提交方（`actorId`）**，⛔ 不用 `items` 推导 ——
      `items` 变了主体也变 → 键抢不到自己 → **幂等被绕过**。
      没有 `actorId` 时主体退化成 `'*'`，靠「同 `requestId` 内容比对」兜住复用。
  - `submitSelfReviews({ db, stageId, teamId, items, requestId, now })` → `{ stageId, teamId, submitted }`
  - `declareRecusal({ db, stageId, judgeId, teamId, reason, actorId, now })` → recusal record
  - `writeAuditLog(db, { actorId, action, entity, entityId, detail, now })` → audit id

- [ ] **Step 1: 写失败的测试**

`platform/test/review-service.test.js`：

```javascript
// platform/test/review-service.test.js —— 评审提交类用例
//
// 依据：P2 计划 Task 6「评分提交服务 + 幂等 + 增量 score_stats」
// 溯源需求：R-JDG-09（回避留档）｜R-JDG-11（观察员无投票权）｜R-JDG-12（校准不计入评分）
//          ｜R-JDG-13（自评）｜R-JDG-18（利益冲突声明）｜R-RNK-07（互评资格）
//
// ⚠️ **夹具必须建真实数据**（父代理预审修正，Important）：
//    Task 1 补齐了引用型外键（`judge_id → users`、`team_id → teams`、`stage_id → stages`），
//    原规格用的假 id（'j1' / 't1' / 'ed1'）**必然触发外键失败** —— 那只在「没有外键」时成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { claimRequestKey } from '../src/db/repo/request-keys.js';
import {
  submitReviews,
  getReviewState,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  submitEnterpriseConfirmation,
  declareRecusal,
} from '../src/services/review.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const NOW = '2026-10-20T10:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rev-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  // 真实届期 / 用户 / 战队 / 赛段 —— 外键要指向真实存在的行
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000011', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000012', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000013', password: 'pw' });
  const captain2 = createUser(db, { name: '队长乙', phone: '13900000015', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000014', password: 'pw' });

  const teamA = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, status: 'forming', now: NOW,
  });
  const teamB = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain2.id, status: 'forming', now: NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  const stage2 = insertStage(db, {
    editionId: edition.id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-10-26', endsAt: '2026-10-28', scoringConfigKey: 'final', status: 'open', now: NOW,
  });

  // 分配评委 = 签署利益冲突声明（R-JDG-18 接线）
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });

  return { db, close, dataDir, edition, judge, observer, captain, captain2, admin, teamA, teamB, stage, stage2 };
}

function cleanup({ db, close, dataDir }) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

test('提交评分：写入 stage_reviews 并增量更新 score_stats', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  const res = submitReviews({
    db,
    stageId: stage.id,
    judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamB.id, dimension: 'innovation', rawScore: 60 },
    ],
    requestId: 'req-1',
    now: NOW,
  });
  assert.equal(res.submitted, 2);

  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 2);
  assert.ok(Math.abs(stat.mean - 70) < 1e-12);
  assert.ok(Math.abs(stat.sum_sq - (6400 + 3600)) < 1e-9);

  cleanup(ctx);
});

test('幂等：同一 requestId 重复提交只生效一次', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  const items = [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }];
  submitReviews({ db, stageId: stage.id, judgeId: judge.id, items, requestId: 'req-1', now: NOW });
  const second = submitReviews({ db, stageId: stage.id, judgeId: judge.id, items, requestId: 'req-1', now: NOW });
  assert.equal(second.submitted, 0, '重复提交不产生新记录');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_reviews').get().n, 1);
  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 1, 'score_stats 不得被重复累加');
  cleanup(ctx);
});

test('观察员无投票权 → 403', () => {
  const ctx = setup();
  const { db, observer, teamA, stage } = ctx;
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: observer.id,
      items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-o', now: NOW,
    }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

test('改分：同一 (评委,队伍,维度) 覆盖写，score_stats 同步修正', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-a', now: NOW,
  });
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 90 }],
    requestId: 'req-b', now: NOW,
  });
  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 1);
  assert.ok(Math.abs(stat.mean - 90) < 1e-12);
  assert.ok(Math.abs(stat.sum_sq - 8100) < 1e-9);
  cleanup(ctx);
});

test('校准打分写入 calibrations，不进 stage_reviews（不计入评分）', () => {
  const ctx = setup();
  const { db, judge, stage } = ctx;
  submitCalibration({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ dimension: 'innovation', rawScore: 50 }], now: NOW,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calibrations').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_reviews').get().n, 0);
  cleanup(ctx);
});

test('进度查询：返回已交/应交/缺谁/维度进度', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-1', now: NOW,
  });
  const state = getReviewState({ db, stageId: stage.id, viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.submitted, 1);
  assert.ok(state.total >= 1);
  assert.ok(Array.isArray(state.missing));
  assert.ok('innovation' in state.dimensionProgress);
  assert.equal(state.dimensionProgress.innovation.submitted, 1);
  cleanup(ctx);
});

test('互评：一队对另一队只投一次；重复 requestId 幂等', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  // 两队都已有真实交付物（评委已对其打分）→ 才有互评资格（R-RNK-07）
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamB.id, dimension: 'innovation', rawScore: 70 },
    ],
    requestId: 'r-1', now: NOW,
  });
  const items = [{ fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 }];
  const first = submitPeerReviews({ db, stageId: stage.id, items, requestId: 'p-1', now: NOW });
  assert.equal(first.submitted, 1);
  const second = submitPeerReviews({ db, stageId: stage.id, items, requestId: 'p-1', now: NOW });
  assert.equal(second.submitted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_reviews').get().n, 1);
  cleanup(ctx);
});

test('无真实交付物的队伍不能参与互评（R-RNK-07）', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'r-1', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: stage.id, items: [{ fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 }], requestId: 'p-2', now: NOW,
    }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

test('自评测提交并幂等', () => {
  const ctx = setup();
  const { db, teamA, stage } = ctx;
  const items = [{ dimension: 'innovation', rawScore: 85 }];
  submitSelfReviews({ db, stageId: stage.id, teamId: teamA.id, items, requestId: 's-1', now: NOW });
  const again = submitSelfReviews({ db, stageId: stage.id, teamId: teamA.id, items, requestId: 's-1', now: NOW });
  assert.equal(again.submitted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_reviews').get().n, 1);
  cleanup(ctx);
});

test('回避：留档后该评委不能再评该队', () => {
  const ctx = setup();
  const { db, judge, teamA, stage, admin } = ctx;
  declareRecusal({ db, stageId: stage.id, judgeId: judge.id, teamId: teamA.id, reason: '前雇主', actorId: admin.id, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recusal_records').get().n, 1);
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: judge.id,
      items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-r', now: NOW,
    }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('R-JDG-18 接线：分配评委即签署利益冲突声明', () => {
  // ⚠️ 原规格把 `conflict_declarations` 建好了、两列也留了，
  //    却**没有任何代码写入** → 「评委须签署声明」在产品上静默失效，CI 全绿。
  const ctx = setup();
  const { db, judge, stage } = ctx;
  const decls = db.prepare('SELECT * FROM conflict_declarations WHERE stage_id = ? AND judge_id = ?')
    .all(stage.id, judge.id);
  assert.equal(decls.length, 1, '分配评委后声明表必须多一行');
  assert.equal(decls[0].has_conflict, 0);
  assert.ok(decls[0].statement.length > 0, '声明正文不能为空');
  const seat = db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?')
    .get(stage.id, judge.id);
  assert.equal(seat.conflict_declared_at, NOW, '签署时间必须回填');
  assert.equal(seat.conflict_declaration_id, decls[0].id, '声明 id 必须回填');
  cleanup(ctx);
});

test('写数据失败时幂等键不得残留（否则重试会被静默吞掉）', () => {
  // ⚠️ 原实现：先抢键再写数据。写数据失败（403）时**键已经占住** →
  //    客户端用同一个 requestId 重试会被判成「重复请求」，
  //    返回 submitted: 0 —— **评委以为提交成功了，实际一条都没落库**。
  const ctx = setup();
  const { db, judge, teamA, teamB, stage, admin } = ctx;
  declareRecusal({ db, stageId: stage.id, judgeId: judge.id, teamId: teamA.id, reason: '前雇主', actorId: admin.id, now: NOW });
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: judge.id,
      items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-x', now: NOW,
    }),
    (err) => err.status === 403,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM review_request_keys').get().n,
    0,
    '失败的事务不得留下幂等键',
  );
  // 换个没被回避的队，用**同一个** requestId 重试 → 必须真写进去
  const retry = submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamB.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-x', now: NOW,
  });
  assert.equal(retry.submitted, 1, '重试必须真的写入，不能被幂等短路吞掉');
  cleanup(ctx);
});

test('同一个 requestId 用于不同内容 → 409（响亮报错，不静默继续写）', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-dup', now: NOW,
  });
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: judge.id,
      items: [{ teamId: teamB.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-dup', now: NOW,
    }),
    (err) => err.status === 409,
  );
  cleanup(ctx);
});

test('互评：同一个 requestId 用于不同内容 → 409（幂等键主体不能从 items 推导）', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamB.id, dimension: 'innovation', rawScore: 70 },
    ],
    requestId: 'r-1', now: NOW,
  });
  submitPeerReviews({
    db, stageId: stage.id,
    items: [{ fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 }],
    requestId: 'p-dup', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: stage.id,
      items: [
        { fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 },
        { fromTeamId: teamB.id, toTeamId: teamA.id, score: 60 },
      ],
      requestId: 'p-dup', now: NOW,
    }),
    (err) => err.status === 409,
  );
  cleanup(ctx);
});

test('分数越界 → 400（绝不让 1000 分污染 score_stats 与归一化）', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  for (const bad of [1000, -1, NaN, Infinity]) {
    assert.throws(
      () => submitReviews({
        db, stageId: stage.id, judgeId: judge.id,
        items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: bad }],
        requestId: `req-bad-${String(bad)}`, now: NOW,
      }),
      (err) => err.status === 400,
      `rawScore=${String(bad)} 必须被拒`,
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_stats').get().n, 0);
  cleanup(ctx);
});

test('评分进度按赛段真实名册算（完全没人打分的队也必须计入）', () => {
  // ⚠️ 原实现把「已有打分记录里出现过的队伍」当成「应交队伍」——
  //    某个队完全没人打分时它根本不在名单里 → 进度显示 100% 而实际有队没被评。
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-1', now: NOW,
  });
  const state = getReviewState({ db, stageId: stage.id, viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.total, 2, '两个队都应交 —— 乙队完全没人打分也算');
  assert.equal(state.submitted, 1);
  assert.equal(state.missing.length, 1);
  assert.equal(state.missing[0].teamId, teamB.id);
  cleanup(ctx);
});

test('赛段不存在 → 404（不把外键原文漏给调用方）', () => {
  const ctx = setup();
  const { db, judge } = ctx;
  assert.throws(
    () => submitReviews({
      db, stageId: 'no-such-stage', judgeId: judge.id,
      items: [], requestId: 'req-none', now: NOW,
    }),
    (err) => err.status === 404,
  );
  cleanup(ctx);
});

test('企业确认：空白签字内容 → 400（R-JDG-14）', () => {
  const ctx = setup();
  const { db, teamA, stage } = ctx;
  assert.throws(
    () => submitEnterpriseConfirmation({
      db, stageId: stage.id, teamId: teamA.id, enterpriseId: 'E1',
      dimension: 'enterprise', rawScore: 80, content: '   ', now: NOW,
    }),
    (err) => err.status === 400,
  );
  cleanup(ctx);
});

test('每次提交都留下审计日志', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-audit', now: NOW,
  });
  const rows = db.prepare('SELECT * FROM audit_log WHERE action = ?').all('review.submit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, 'stage');
  assert.equal(rows[0].entity_id, stage.id);
  cleanup(ctx);
});

test('幂等键的 UNIQUE 兜底只认「唯一约束」，其它约束错必须继续往上抛', () => {
  // ⚠️ 兜底正则若放宽成 /UNIQUE|constraint/i，「外键失败」会被**误判成重复请求**
  //    → 静默吞掉（返回 submitted: 0），评委以为提交成功了。
  //    P1 的 T-7 已经踩过一次同样的坑（registrations 的兜底正则被收紧）。
  const ctx = setup();
  const { db } = ctx;
  assert.throws(
    () => claimRequestKey(db, {
      scope: 'review', stageId: 'no-such-stage', subjectId: 'x', requestId: 'r', now: NOW,
    }),
    /FOREIGN KEY/i,
    '外键失败不得被当成「重复请求」',
  );
  cleanup(ctx);
});

test('进度：应交总数 = 队伍数 × 维度数（不能漏乘维度）', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamA.id, dimension: 'feasibility', rawScore: 70 },
    ],
    requestId: 'req-2d', now: NOW,
  });
  const state = getReviewState({ db, stageId: stage.id, viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.total, 4, '2 队 × 2 维度 = 4');
  assert.equal(state.submitted, 2);
  cleanup(ctx);
});

test('不能给自己互评 → 400', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'r-1', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: stage.id,
      items: [{ fromTeamId: teamA.id, toTeamId: teamA.id, score: 70 }],
      requestId: 'p-self', now: NOW,
    }),
    (err) => err.status === 400,
  );
  cleanup(ctx);
});

// ── 写入口的队伍边界（父代理预审 I1 / I5 / D-33）─────────────────────────

test('服务层：给名册外的队伍打分 → 404（不是外键报错 500）', () => {
  const ctx = setup();
  const otherEdition = createEdition(ctx.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(ctx.db, {
    editionId: otherEdition.id, name: '外队', captainId: ctx.admin.id, status: 'active', now: NOW,
  });
  assert.throws(
    () => submitReviews({
      db: ctx.db, stageId: ctx.stage.id, judgeId: ctx.judge.id,
      items: [{ teamId: outsider.id, dimension: 'innovation', rawScore: 99 }], now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_IN_STAGE',
  );
  cleanup(ctx);
});

test('服务层：企业确认名册外的队伍 → 404', () => {
  const ctx = setup();
  const otherEdition = createEdition(ctx.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(ctx.db, {
    editionId: otherEdition.id, name: '外队', captainId: ctx.admin.id, status: 'active', now: NOW,
  });
  assert.throws(
    () => submitEnterpriseConfirmation({
      db: ctx.db, stageId: ctx.stage.id, teamId: outsider.id, enterpriseId: ctx.admin.id,
      dimension: 'enterprise', rawScore: 90, crossJudgeId: ctx.judge.id,
      signatoryUserId: ctx.admin.id, content: '外队确认', now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_IN_STAGE',
  );
  cleanup(ctx);
});

test('服务层：互评的被评队不在名册内 → 404', () => {
  const ctx = setup();
  const otherEdition = createEdition(ctx.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(ctx.db, {
    editionId: otherEdition.id, name: '外队', captainId: ctx.admin.id, status: 'active', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db: ctx.db, stageId: ctx.stage.id,
      items: [{ fromTeamId: ctx.teamA.id, toTeamId: outsider.id, score: 80 }], now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_IN_STAGE',
  );
  cleanup(ctx);
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
//      业务表的 request_id 列上（那样第二批就插不进去了）。
//   ✅ 正确做法：先在键表里「抢键」，抢到 = 首次生效；抢不到 = 重复请求 → 幂等短路。
//      唯一约束在数据库层，因此并发下不会双写。
//
// ⚠️ 父代理预审修正（2026-10-21，Important）：
//    「先抢键」与「写数据」必须放进**同一个事务** —— 否则写数据失败时键已经被占用，
//    客户端用同一个 requestId 重试会被判成「重复请求」而**静默丢数据**
//    （返回 submitted: 0，评委以为提交成功了，实际一条都没落库）。
//    事务边界由服务层负责（src/services/review.js）。
export function claimRequestKey(db, { scope, stageId, subjectId, requestId, now }) {
  try {
    db.prepare(
      `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, stageId, subjectId, requestId, now);
    return true;
  } catch (err) {
    // ⚠️ 只认「唯一约束」这一种失败 —— 其他错误必须继续往上抛，
    //    否则「磁盘满了」会被误判成「重复请求」。
    if (/UNIQUE constraint failed: review_request_keys/i.test(String(err.message))) return false;
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
// 依据：设计文档 §5.2 / §12 + INTERFACES.md §3 + S7 §3.4（评委池与席构成）
import { randomUUID } from 'node:crypto';

export function insertStage(db, {
  editionId, key, name, kind, startsAt, endsAt, freezeAt = null, scoringConfigKey,
  status = 'draft', now,
}) {
  const id = randomUUID();
  // ⚠️ `stages` 表**没有** created_at 列（created_at 在 stage_reviews / enterprise_confirmations
  //    等「评分行为」表上，赛段本身不是行为）—— 所以这里**不能**多传一个 now，
  //    否则参数个数与占位符对不上 → "column index out of range"。
  //    `now` 保留在签名里是为了调用方接口统一（传不传都行）。
  void now;
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, key, name, kind, startsAt, endsAt, freezeAt, scoringConfigKey, status);
  return getStage(db, id);
}

export function getStage(db, id) {
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(id) ?? null;
}

/**
 * 改赛段配置（**逆向路径**：改配置）。
 *
 * ⚠️ 为什么没有 `updated_at` 列：`stages` 表（003_review.sql）**只有** created 语义上的
 *    「赛段本身不是行为表」这一口径 —— 详见 insertStage 的注释。
 *    ⇒「什么时候改的」由 `audit_log` 的 `stage.update` 承担（可复算，见设计文档 §12），
 *      **不在 stages 表上另开一列**（那会让「表结构 = 事实」这条口径分叉）。
 *
 * ⛔ **只改这五项**：name / starts_at / ends_at / freeze_at / scoring_config_key。
 *    `id` / `edition_id` / `key` / `kind` / `status` **不可改**：
 *    · key 与 edition 变了 = 这个赛段「变成另一个赛段」⇒ 历史评分全部张冠李戴；
 *    · kind 变了 = 权重表与席构成的语义变了（同上）；
 *    · status 的迁移（draft → open → frozen → computed）是**独立的动作**，
 *      不塞进「改配置」里（那会让「改个名字」顺手把赛段开闸了）。
 *
 * @param {*} db
 * @param {string} id 赛段 id
 * @param {string|null} [name] 传 undefined = 不改；传 null = 清空（本表这几列都不允许 null，调用方保证）
 * @returns {object} 改完后的赛段行
 */
export function updateStageConfig(db, {
  id, name, startsAt, endsAt, freezeAt, scoringConfigKey,
}) {
  const sets = [];
  const params = [];
  // ⚠️ 用 `undefined` 判「有没有传」而不是 `null`：
  //    freeze_at 允许为 null（未设冻结时间），传 null 是「清空」而不是「不改」。
  const put = (col, val) => {
    if (val === undefined) return;
    sets.push(`${col} = ?`);
    params.push(val);
  };
  put('name', name);
  put('starts_at', startsAt);
  put('ends_at', endsAt);
  put('freeze_at', freezeAt);
  put('scoring_config_key', scoringConfigKey);
  if (!sets.length) return getStage(db, id);
  params.push(id);
  db.prepare(`UPDATE stages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getStage(db, id);
}

/**
 * 撤掉一个评委席（**逆向路径**：撤评委）。
 *
 * ⚠️ **只删 stage_judges 一行，不删 conflict_declarations**：
 *    利益冲突声明是「事前签署」的历史事实（R-JDG-17：赛后 6 个月可查），
 *    撤席不等于「这份声明没发生过」⇒ 删掉它就是篡改审计证据。
 *    （声明表对 stage_judges 没有外键 ⇒ 留着不会孤儿。）
 *
 * @returns {number} 实际删除的行数（0 = 本来就没分配）
 */
export function removeStageJudgeRow(db, { stageId, userId }) {
  const res = db
    .prepare('DELETE FROM stage_judges WHERE stage_id = ? AND user_id = ?')
    .run(stageId, userId);
  return Number(res?.changes ?? 0);
}

export function listStages(db, { editionId } = {}) {
  if (editionId) return db.prepare('SELECT * FROM stages WHERE edition_id = ? ORDER BY starts_at').all(editionId);
  return db.prepare('SELECT * FROM stages ORDER BY starts_at').all();
}

/**
 * 赛段**摘要**列表（P7 新增，给前端做赛段选择器 / 赛事时间线）。
 *
 * ⚠️ 为什么另起一个函数而不是直接复用 listStages()：
 *    listStages 返回 `SELECT *`（含 freeze_at / scoring_config_key 等内部字段），
 *    那是对内形状；对外只暴露「哪一段、叫什么、什么时候、什么状态」这四项。
 *    ⛔ 仍然**不做任何可见性过滤** —— 赛段时间线是公开赛事信息，
 *    真正需要按人过滤的是评分与名单（那些走 /api/leaderboard 等端点）。
 */
export function listStageSummaries(db, { editionId } = {}) {
  // ⚠️ E158：补 freeze_at / scoring_config_key 两个字段。
  //    起因：「赛段配置」页（设计 §9「赛段配置与权重表」）刷新后要能回填
  //    「冻结时间」与「用的哪张权重表」—— 摘要里没有这两项 ⇒ 页面只能把
  //    PATCH 的 body 留空（服务端语义「不传=不改」），改配置时**看不出当前值**。
  //    ⛔ 公开面不变宽：freezeAt 是赛程信息（与 startsAt/endsAt 同类）；
  //       scoringConfigKey 只是「用 initial 还是 final 这张权重表」——
  //       而两张权重表的维度与权重早已由 `GET /api/event-info` 公开。
  const sql = `SELECT id, "key" AS key, name, kind, status, starts_at AS startsAt, ends_at AS endsAt,
                       freeze_at AS freezeAt, scoring_config_key AS scoringConfigKey
                 FROM stages ${editionId ? 'WHERE edition_id = ?' : ''}
                ORDER BY starts_at, id`;
  return editionId ? db.prepare(sql).all(editionId) : db.prepare(sql).all();
}

/**
 * 赛段**名册**（带队名与任务包标题）—— P8 新增，给前端「评审打分页」用。
 *
 * ⚠️ 为什么不能直接用 `listStageTeams`：
 *    `listStageTeams` 只返回 `{ teamId, packageEnterpriseId, isFreeBrief }` ——
 *    **没有队名**。前端要渲染「队伍名 + 任务包」，没有队名就没法显示。
 *    ⇒ 这里 JOIN 出队名与任务包标题。
 *
 * ⚠️ 名册口径与 listStageTeams **保持一致**（同一张表、同一 edition 口径、同样过滤软删除）：
 *    两个函数口径一旦分叉，评审页看到的队伍就会和计算时算的队伍**不是同一批** ——
 *    那是最难查的一类 bug（榜单里凭空少一支队）。
 *
 * ⚠️ **排序兜底键用 SQLite 隐式 `rowid`**（全局约束）：
 *    `t.id` 是 `crypto.randomUUID()` ⇒ **随机 UUID** ⇒ 排序随机 ⇒ 列表顺序每次刷新都可能变。
 *    `created_at` 相等时由 `rowid`（插入顺序）兜底 ⇒ 顺序确定。
 */
export function listStageTeamRows(db, stageId) {
  return db
    .prepare(
      `SELECT t.id AS team_id, t.name AS team_name, t.task_package_id,
              tp.title AS package_title, tp.enterprise_id AS package_enterprise_id,
              COALESCE(tp.is_free_brief, 0) AS is_free_brief
       FROM teams t
       LEFT JOIN task_packages tp ON tp.id = t.task_package_id
       WHERE t.edition_id = (SELECT edition_id FROM stages WHERE id = ?)
         AND t.deleted_at IS NULL
       ORDER BY t.created_at, t.rowid`,
    )
    .all(stageId)
    .map((r) => ({
      id: r.team_id,
      name: r.team_name,
      taskPackageId: r.task_package_id ?? null,
      taskPackageTitle: r.package_title ?? null,
      enterpriseId: r.package_enterprise_id ?? null,
      isFreeBrief: !!r.is_free_brief,
    }));
}

/**
 * 默认利益冲突声明正文（评委被分配到赛段时即签署）。
 * 评委可另行声明存在冲突 → `has_conflict = 1` → 逐案回避（R-JDG-09 / R-JDG-18）。
 */
export const DEFAULT_CONFLICT_STATEMENT =
  '本人确认与本届参赛队伍及其出题企业不存在利益关系；如存在关联，本人将主动申报并逐案回避。';

/**
 * 把评委分配到赛段。
 *
 * ⚠️ 父代理预审修正（Important，R-JDG-18：**机制写下来了，但没接线**）：
 *    原来这里只 `INSERT stage_judges` —— `conflict_declarations` 表建了、
 *    `stage_judges.conflict_declared_at` / `conflict_declaration_id` 两列也留了，
 *    却**没有任何代码写入或读取它们** → 需求溯源表里的 R-JDG-18
 *    「评委须签署利益冲突声明」在产品上**静默失效**，CI 全绿。
 *    与 P1 Task 3 的 A1（`registration:write` 被注册却从不校验）、
 *    P1 Task 4 的 T4-5（未做六维评估也能签 A 级）**同一类病根**。
 *    现在：**分配评委即签署声明** —— 声明落 `conflict_declarations`，
 *    并把声明 id 与签署时间回填到 `stage_judges`。
 *
 * ⚠️ 两条 INSERT 必须在**同一个事务**里 —— 否则「声明写了但席位没写成」会留下孤儿声明。
 */
export function assignStageJudge(db, {
  stageId, userId, seat, scopeType = 'global', scopeId = null, now, declaration = null,
}) {
  const declarationId = randomUUID();
  const nested = db.isTransaction === true;
  if (!nested) db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO conflict_declarations (id, stage_id, judge_id, declared_at, has_conflict, statement, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      declarationId, stageId, userId, now,
      declaration?.hasConflict === true ? 1 : 0,
      declaration?.statement ?? DEFAULT_CONFLICT_STATEMENT,
      now,
    );
    db.prepare(
      `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at,
                                 conflict_declared_at, conflict_declaration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(stageId, userId, seat, scopeType, scopeId, now, now, declarationId);
    if (!nested) db.exec('COMMIT');
  } catch (err) {
    if (!nested) db.exec('ROLLBACK');
    throw err;
  }
  return listStageJudges(db, stageId);
}

/** 评委池：seat = judge 专家席 / enterprise 企业席 / observer 观察员（无投票权） */
export function listStageJudges(db, stageId) {
  return db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? ORDER BY user_id').all(stageId);
}

export function getStageJudge(db, stageId, userId) {
  return db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?').get(stageId, userId) ?? null;
}

/**
 * 评委**候选池**（组委会派评委时可选的人）。
 *
 * ⚠️ 为什么不用 `listAllUsers`（pool-sources.js）：
 *   那个函数返回**全部在册用户**（不分角色、不分届期），机器闸的 allow.json 已把它
 *   明确判为「未被消费是语义上正确的结果」—— 顶层文档 §3.1 S2「一切按 edition 隔离」。
 *   ⇒ 评委候选池**不是「全部用户」**，而是「**持有评委类角色**的人」。
 *
 * ⚠️ 角色集合的来源（P0 seed.js 的 ROLE_CAPABILITIES）：
 *   `judge` 专家席 / `enterprise` 企业席 / `observer` 观察员（无投票权）。
 *   ⛔ 角色本身**不带 edition_id**（一人可跨多届当评委）⇒ 这里不做届期过滤，
 *     与 S2 的隔离要求不冲突：S2 隔离的是**参赛者/队伍/积分**这类赛事数据，
 *     评委是**组委会资源**，跨届复用是正常的。
 *
 * ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约束）：
 *   `u.created_at` 相等时由 `rowid`（插入顺序）兜底 ⇒ 顺序确定，不随机。
 *
 * @param {object} db
 * @returns {Array<{id: string, name: string, org: string|null}>}
 */
export function listStageJudgeCandidates(db) {
  return db
    .prepare(
      `SELECT DISTINCT u.id AS id, u.name AS name, u.org AS org
         FROM users u
         JOIN user_roles r ON r.user_id = u.id
        WHERE u.active = 1
          AND r.role_key IN ('judge', 'enterprise', 'observer')
        ORDER BY u.created_at, u.rowid`,
    )
    .all();
}

/**
 * 某赛段的队伍名册（需要 P1 的 teams / task_packages）。
 * ⚠️ 表未就绪（P1 尚未落地）时**抛错**，由调用方兜底 —— 仓储层不吞异常。
 */
export function listStageTeams(db, stageId) {
  return db
    .prepare(
      `SELECT t.id AS team_id, tp.enterprise_id AS package_enterprise_id,
              COALESCE(tp.is_free_brief, 0) AS is_free_brief
       FROM teams t
       LEFT JOIN task_packages tp ON tp.id = t.task_package_id
       WHERE t.edition_id = (SELECT edition_id FROM stages WHERE id = ?)
         AND t.deleted_at IS NULL
       ORDER BY t.created_at, t.rowid`,
    )
    .all(stageId)
    .map((r) => ({
      teamId: r.team_id,
      packageEnterpriseId: r.package_enterprise_id ?? null,
      isFreeBrief: !!r.is_free_brief,
    }));
}
```

`platform/src/db/repo/reviews.js`：

```javascript
// src/db/repo/reviews.js — 评委打分、校准打分、增量统计
// 依据：S7 §3.1（评委宽严归一化的原始分来源）+ 设计文档 §6.2 Step 2（mean/stdev 增量维护）
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
  // ⚠️ 父代理预审修正（Important，I5 的同源问题）：软删除的打分**不得**再计入计算。
  //    `stage_reviews` 有 `deleted_at` 列（软删除语义：评分只增不改，删除用软删除），
  //    但这里原来不滤 —— 删掉的分还在榜单里。
  return db
    .prepare(`SELECT * FROM stage_reviews WHERE ${where.join(' AND ')} AND calibrated = 0 AND deleted_at IS NULL ORDER BY team_id, dimension, judge_id`)
    .all(...params);
}

export function listReviewCells(db, stageId) {
  // ⚠️ 软删除的打分**不能**留在进度分母里（终审修正 M-1）：
  //    `listReviews` 已带 `deleted_at IS NULL`（D-35），这里若不过滤，
  //    被撤回的维度仍占着「应交」名额 → 进度条永远填不满 / missing 算错。
  return db
    .prepare(
      'SELECT DISTINCT team_id, dimension FROM stage_reviews '
      + 'WHERE stage_id = ? AND calibrated = 0 AND deleted_at IS NULL',
    )
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

// ── 【P10 评委前置】校准分的「我交过哪些」读口 ──────────────────────────────
//
// ⚠️ 校准分是**按评委**记的（judge_id）⇒ 「我的校准」= judge_id = 自己。
//    与互评/自评（按队记、我在队里才算）口径不同 —— 校准本来就是评委个人行为
//    （R-JDG-12：用同一组样例作品校准**宽严尺度**，是评委自己的事）。
//
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43）：
//    `id` 是 randomUUID（随机）⇒ 不能排序；`created_at` 同毫秒并列时必须有 rowid 兜底。
export function listCalibrationsForJudge(db, { stageId, judgeId }) {
  if (!judgeId) return [];
  return db
    .prepare(
      `SELECT dimension, raw_score AS rawScore, created_at AS createdAt
         FROM calibrations
        WHERE stage_id = ? AND judge_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(stageId, judgeId);
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
 * 全部评分统计（反作弊「评委宽严异常」检测用）。
 *
 * ⛔ P11 新增：设计 §11.1「评委宽严异常：某评委 stddev 异常小/大 → **告警但不自动处罚**」
 *    需要「一位评委 × 一个维度」的统计集合，而仓储层原来**只有单条查询**
 *    （getScoreStat）⇒ 检测器拿不到集合，只能传空数组 ⇒ **这条检测形同虚设**。
 *    排序兜底用 SQLite 隐式 `rowid`（不用随机 id）。
 */
export function listScoreStats(db) {
  return db.prepare('SELECT judge_id, dimension, n, mean, sum_sq FROM score_stats ORDER BY judge_id, dimension, rowid').all();
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
//
// ⛔ P11 追加（本文件此前只有「插入 + 列表 + 软删」三样，且软删**无人调用**）：
//   ① `getEnterpriseConfirmationById` —— 逆向路径（撤回 / 改签）要按 id 取记录；
//   ② `findActiveEnterpriseConfirmation` —— **同格重签**的判据（E148②：原来直接撞唯一索引 ⇒ 500）；
//   ③ `updateEnterpriseConfirmation` —— **改签**要能就地更正内容 / 分数 / 跨领域签字人。
//
// ⚠️ 软删（deleted_at）而不是物理删除：企业确认是**计分证据**，事后要能查「谁在什么时候签过、后来撤了」。
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

/**
 * 按 id 取一条**未撤回**的企业确认。
 * ⛔ 撤回过的（deleted_at 非空）取不到 ⇒ 单条不满足 → 404（不泄露「曾经存在过」）。
 */
export function getEnterpriseConfirmationById(db, id) {
  return db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

/**
 * 查「同格」的企业确认：(赛段, 队伍, 维度, 企业)。
 * ⚠️ **同格** = 唯一索引 `idx_enterprise_confirmations_cell` 的那四列
 *    （stage_id, team_id, dimension, enterprise_id，且 deleted_at IS NULL）。
 *    E148②：同格重签原来直接撞唯一索引 → SQLite 抛 UNIQUE → **HTTP 500「服务内部错误」**
 *    （违反设计文档 §7.3 的三态口径）。现在先查、明确报 409。
 */
export function findActiveEnterpriseConfirmation(db, { stageId, teamId, dimension, enterpriseId }) {
  return db.prepare(
    `SELECT * FROM enterprise_confirmations
      WHERE stage_id = ? AND team_id = ? AND dimension = ? AND enterprise_id = ? AND deleted_at IS NULL
      ORDER BY created_at, rowid LIMIT 1`,
  ).get(stageId, teamId, dimension, enterpriseId) ?? null;
}

export function softDeleteEnterpriseConfirmation(db, id, now) {
  db.prepare('UPDATE enterprise_confirmations SET deleted_at = ? WHERE id = ?').run(now, id);
}
```

`platform/src/db/repo/peer-reviews.js`：

```javascript
// src/db/repo/peer-reviews.js — 互评
import { randomUUID } from 'node:crypto';

export function findPeerReviewsByRequestId(db, { stageId, fromTeamId = null, requestId }) {
  if (!requestId) return [];
  if (fromTeamId) {
    return db
      .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND request_id = ?')
      .all(stageId, fromTeamId, requestId);
  }
  // 赛段级查找：用于「同一个 requestId 是否被用于了不同内容」的判定
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND request_id = ?')
    .all(stageId, requestId);
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

// ── 【P10 评委前置】互评的「我交过哪些」读口 ────────────────────────────────
//
// ⚠️ **口径与写入口完全一致**（src/http/routes/review.js 的 POST /peer-reviews）：
//    「提交者必须是**发起队**的在册成员」⇒ 所以「我的互评」= **我参与的那些队发起的互评**。
//    ⛔ 不是「我打过分」——互评是「队 → 队」的行为，记录里没有评委维度。
//
// ⚠️ **队长也算参与**（与正式站 listMyTeams 同一口径，src/services/team.js）：
//    建队时只写 `teams.captain_id`，**不一定**有 team_members 行
//    ⇒ 只查 team_members 会把队长漏掉（队长的互评就消失了）。
//
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43）：
//    `id` 是 randomUUID（随机）⇒ 不能排序；`from/to_team_id` 是 UUID ⇒ 也不是稳定序。
export function listPeerReviewsForViewer(db, { stageId, userId }) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT pr.from_team_id AS fromTeamId,
              pr.to_team_id   AS toTeamId,
              pr.score        AS score,
              pr.created_at   AS createdAt
         FROM peer_reviews pr
         JOIN teams t ON t.id = pr.from_team_id
        WHERE pr.stage_id = ?
          AND ( t.captain_id = ?
                OR EXISTS (SELECT 1 FROM team_members m
                            WHERE m.team_id = t.id AND m.user_id = ? AND m.left_at IS NULL) )
        ORDER BY pr.from_team_id, pr.to_team_id, pr.rowid`,
    )
    .all(stageId, userId, userId);
}
```

`platform/src/db/repo/self-reviews.js`：

```javascript
// src/db/repo/self-reviews.js — 自评测
import { randomUUID } from 'node:crypto';

export function findSelfReviewsByRequestId(db, { stageId, teamId = null, requestId }) {
  if (!requestId) return [];
  if (teamId) {
    return db
      .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND request_id = ?')
      .all(stageId, teamId, requestId);
  }
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND request_id = ?')
    .all(stageId, requestId);
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

// ── 【P10 评委前置】自评的「我交过哪些」读口 ────────────────────────────────
//
// ⚠️ **口径与写入口完全一致**（src/http/routes/review.js 的 POST /self-review）：
//    「自评只能由**本队成员**提交」⇒ 「我的自评」= **我参与的队**的自评。
//    ⛔ 不是「评委的自评」——自评是队伍行为（R-JDG-13：不加分，只触发说明与提问）。
//
// ⚠️ **队长也算参与**（与正式站 listMyTeams 同一口径）：队长不一定有 team_members 行。
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43，不用随机 UUID 的 id）。
export function listSelfReviewsForViewer(db, { stageId, userId }) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT sr.team_id    AS teamId,
              sr.dimension  AS dimension,
              sr.raw_score  AS rawScore,
              sr.submitted_at AS createdAt
         FROM self_reviews sr
         JOIN teams t ON t.id = sr.team_id
        WHERE sr.stage_id = ?
          AND ( t.captain_id = ?
                OR EXISTS (SELECT 1 FROM team_members m
                            WHERE m.team_id = t.id AND m.user_id = ? AND m.left_at IS NULL) )
        ORDER BY sr.team_id, sr.dimension, sr.rowid`,
    )
    .all(stageId, userId, userId);
}
```

`platform/src/db/repo/recusals.js`：

```javascript
// src/db/repo/recusals.js — 回避记录（R-JDG-09 留档）
// 依据：S7 §4.2（回避必须留档，赛后 6 个月可查）
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
      .prepare('SELECT * FROM recusal_records WHERE stage_id = ? AND judge_id = ? ORDER BY declared_at, rowid')
      .all(stageId, judgeId);
  }
  // ⚠️ `declared_at` 并列时必须有**确定性**兜底（全局约定 #43：用 rowid，不用随机 UUID）。
  //    「取最后一条记录」是回避撤销语义的基础（同秒申报两条时必须可复现）。
  return db.prepare('SELECT * FROM recusal_records WHERE stage_id = ? ORDER BY declared_at, rowid').all(stageId);
}

// ── 【P10 评委前置】回避台账的**读口** ─────────────────────────────────────
//
// ⚠️ 为什么另起一个函数，**不改** listRecusals：
//   listRecusals 是领域层在用的**原始行**读取（assertNotRecused / reinstateRecusal
//   都要拿 `action` / `declared_at` 的原始值，且 reinstateRecusal 取「最后一条」）。
//   改它的返回形状 ⇒ 会牵动回避的**撤销语义**（checkRecusal 取最后一条记录）——
//   ⇒ 读口另起函数，原始行一个字节都不动。
//
// ⚠️ 队伍名/评委名不是敏感数据：榜单本来就公开队名（R1/R2 公示口径）。
//    但**可见性在 API 层**裁决（全局约束「前端隐藏 = 数据已泄露」）——
//    这里只负责「取数 + 确定性排序」，「谁能看哪些行」由服务层按 viewer 决定。
//
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43）：
//    `id` 是 `crypto.randomUUID()` ⇒ 随机 UUID ⇒ 不能当排序键；
//    `declared_at` 是 ISO 字符串（毫秒精度）⇒ 同刻并列时必须有 rowid 兜底。
export function listRecusalViews(db, { stageId, judgeId = null } = {}) {
  const where = ['r.stage_id = ?'];
  const params = [stageId];
  if (judgeId) {
    where.push('r.judge_id = ?');
    params.push(judgeId);
  }
  return db
    .prepare(
      `SELECT r.id                AS id,
              r.stage_id          AS stageId,
              r.judge_id          AS judgeId,
              r.team_id           AS teamId,
              r.reason            AS reason,
              r.source            AS source,
              r.declared_at       AS createdAt,
              r.audit_by          AS auditBy,
              r.action            AS status,
              t.name              AS teamName,
              u.name              AS judgeName
         FROM recusal_records r
         LEFT JOIN teams t ON t.id = r.team_id
         LEFT JOIN users u ON u.id = r.judge_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.declared_at, r.rowid`,
    )
    .all(...params);
}
```

`platform/src/db/repo/audit-log.js`（**新建** —— `audit_log` 的 SQL 唯一归宿）：

```javascript
// src/db/repo/audit-log.js — 审计日志仓储
// 依据：设计文档 §11.2 / §12（可复算与留痕）；表由 P0 的 001_init.sql 建好。
// ⛔ 全局约束「所有 SQL 收在 src/db/repo/」—— 本文件是 audit_log 的 SQL 唯一归宿，
//    P0 的 test/sql-boundary.test.js 会扫描 src/ 与 scripts/ 下**除 src/db/repo/ 外**的一切 .js。
import { randomUUID } from 'node:crypto';

export function insertAuditLogRow(db, {
  id = randomUUID(),
  actorId = null,
  action,
  entity = null,
  entityId = null,
  detailJson = null,
  createdAt,
}) {
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actorId, action, entity, entityId, detailJson, createdAt);
  return id;
}

export function queryAuditLogRows(db, { entity = null, entityId = null, limit = 100 } = {}) {
  if (entity) {
    return db
      .prepare('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(entity, entityId, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
```

`platform/src/audit/log.js`（**薄服务门面** —— 本文件**不含任何 SQL**）：

```javascript
// src/audit/log.js — 审计日志（服务门面）
// 依据：设计文档 §11 / §12（可复算与留痕）。设计文档 §4.3 已预留 src/audit/ 目录。
// ⚠️ 本文件【不含 SQL】—— SQL 全在 src/db/repo/audit-log.js（全局约束：SQL 边界；
//    P0 的 test/sql-boundary.test.js 会把 src/ 下任何裸 SQL 判为违规）。
// ⛔ action 必须给：没有 action 的日志无法检索，缺了它这条记录等于没写。
import { insertAuditLogRow, queryAuditLogRows } from '../db/repo/audit-log.js';

export function writeAuditLog(db, { actorId = null, action, entity = null, entityId = null, detail = null, now }) {
  if (!action) throw new Error('写审计日志必须给 action（没有 action 的日志无法检索）');
  const id = insertAuditLogRow(db, {
    actorId,
    action,
    entity,
    entityId,
    detailJson: detail ? JSON.stringify(detail) : null,
    createdAt: now,
  });
  return id;
}

export function listAuditLog(db, { entity = null, entityId = null, limit = 100 } = {}) {
  return queryAuditLogRows(db, { entity, entityId, limit });
}
```

> **【2026-10-21 漂移审计修正 C-3 + I-8 + M-7 + M-8】**
> **原来错在哪**：`src/audit/log.js` 的两条 SQL（`db.prepare('INSERT INTO audit_log …')` 与
> `db.prepare('SELECT * FROM audit_log …')`）是**内联在这个门面文件里的裸 SQL**。
> P0 终审 I-7 立了全局约束「所有 SQL 收进 `platform/src/db/repo/`」，并由
> `platform/test/sql-boundary.test.js` 守卫：扫描 `src/` 与 `scripts/` 下**除 `src/db/repo/`
> 与 `src/db/migrate.js` 外**的一切 `.js`，只要出现 `db.prepare(`/`db.exec(` 且参数里含
> `SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/DROP/ALTER` 就判违规。
> `src/audit/log.js` **不在豁免名单里** → 照本计划实施，P0 自带用例当场变红
> （审计实跑：`not ok 1 - src/ 与 scripts/ 里除仓储层外没有裸 SQL`，
> 报 `src/audit/log.js:6 出现 SQL：INSERT INTO audit_log (…)` 等 3 条违规）。
> **为什么错**：服务层/门面层写 SQL 正是 I-7 修复要消灭的形态；且 I-8 指出同一张 `audit_log`
> 在 P2（门面内联 SQL）与 P4（另建 `src/db/repo/audit-log.js`）有**两条写路径**，
> 「审计日志唯一入口」失守。
> **改成什么**：① 新建 `platform/src/db/repo/audit-log.js`，导出 `insertAuditLogRow` /
> `queryAuditLogRows`（两个 SQL 全在里面）；② `platform/src/audit/log.js` 退化为**薄服务门面**，
> `import { insertAuditLogRow, queryAuditLogRows }` 后转调，**函数签名一个字都不改**
> （`writeAuditLog(db, { actorId, action, entity, entityId, detail, now })` /
> `listAuditLog(db, { entity, entityId, limit })`），P2 自己的调用点不需要跟着改；
> ③ 门面的 `writeAuditLog` 补一条 `!action` 守卫（原来只有 P4 的改造块里有，
> 现在 P2 就有 —— 少了它，`action` 为 undefined 时会把 undefined 绑进 SQLite 抛错）。
> **依据**：P0 终态 `platform/test/sql-boundary.test.js:282-292`（扫描范围 + 豁免名单）、
> `platform/src/db/repo/users.js`（仓储层文件头「所有 SQL 收进仓储层，handler 内禁止裸 SQL」）
> 与漂移审计报告 C-3 / I-8 / M-7 / M-8。
> **连带**：`git add` 列表改为显式点名 `src/db/repo/audit-log.js`（M-8：原来只有
> `src/audit/log.js`，与 SQL 边界约束的直觉相悖）；P4 侧的对应改动见
> `2026-10-20-platform-P4-audit-anticheat.md` 的 I-8 修正记录。

- [ ] **Step 4: 创建 src/services/review.js**

```javascript
// src/services/review.js — 评审提交类用例 + 评审读口
//
// 依据：INTERFACES.md §3 服务层 + S7 §3.1 / §4.3 + S10 §0.4。
//   幂等：同一 request_id 重复提交只生效一次（⛔ 不用「先查再插」判断重复灌分，
//         唯一约束在数据库层；这里只对 request_id 做幂等短路）。
//   增量：写 stage_reviews 后增量更新 score_stats（n / mean / sum_sq），
//         stdev 由 sum_sq 现算 —— 避免每次发榜全表重算（成本随评委数×队伍数相乘增长）。
//   ⛔ 但每次发榜仍会做一次全量重算并落快照（可复算要求能从原始数据重放）。
//
// ⚠️ **读口也在这一层**（P10 补齐）：`getReviewBoard`（评审工作台，附带
//    `myPeerReviews` / `mySelfReviews` / `myCalibrations`）与 `getRecusalLedger`
//    （回避台账）—— ⛔ 可见性一律在**服务层（= API 层）**裁决，
//    前端拿到的就已经是「该给他看的」（全局约束：前端隐藏 = 数据已泄露）。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 6 处修正，读代码前先看这段】
//   ① **「先抢键」与「写数据」必须同事务**：原来抢键成功后写数据失败（如评委被回避 → 403），
//      键已经占住 → 客户端用同一个 requestId 重试会被判成「重复请求」，
//      返回 `submitted: 0` —— **评委以为提交成功了，实际一条都没落库**。
//      现在「抢键 + 写数据 + 更新统计 + 审计」在**一个事务**里，要么全成要么全回滚。
//   ② **同一个 requestId 被用于不同内容 → 409 响亮报错**（原来静默继续写）。
//      幂等的含义是「同一个 requestId 只生效一次」；若内容变了，那是**客户端复用 requestId**
//      的 bug —— 静默写进去会让「这个 request 到底写了什么」永远说不清。
//   ③ **分数没有 0–100 区间校验** → 评委提交 1000 分会污染 score_stats 与后续归一化。
//      与 Task 4 的企业确认分同类。
//   ④ **评分进度把「已有打分记录」当成「应评队伍」** —— 某个队**完全没人打分**时，
//      它根本不在名单里 → 进度显示 100% 而实际有队没被评。必须用赛段真实队伍名册。
//   ⑤ **赛段不存在 → 外键原文漏到调用方**。现在先校验 → 404。
//   ⑥ **互评的幂等键主体不能从 items 推导**（原来用 fromTeams.join('+')）——
//      items 变了主体也变 → 键抢不到自己 → 幂等被绕过。现在主体是提交方，
//      并用「同 requestId 内容比对」兜住复用。
import {
  findReviewsByRequestId,
  findReview,
  insertReview,
  updateReviewScore,
  listReviews,
  listReviewCells,
  insertCalibration,
  listCalibrationsForJudge,
  applyScoreStatDelta,
} from '../db/repo/reviews.js';
import { listStageJudges, getStageJudge, getStage, listStageTeams, listStageTeamRows } from '../db/repo/stages.js';
import { hasStageRoster, listStageTeamIds } from '../db/repo/stage-teams.js';
import { claimRequestKey } from '../db/repo/request-keys.js';
import {
  insertEnterpriseConfirmation,
  listEnterpriseConfirmations,
  getEnterpriseConfirmationById,
  findActiveEnterpriseConfirmation,
  softDeleteEnterpriseConfirmation,
} from '../db/repo/enterprise-confirmations.js';
import {
  findPeerReviewsByRequestId,
  findPeerReview,
  insertPeerReview,
  updatePeerReviewScore,
  listPeerReviewsForViewer,
} from '../db/repo/peer-reviews.js';
import {
  findSelfReviewsByRequestId,
  findSelfReview,
  insertSelfReview,
  updateSelfReviewScore,
  listSelfReviewsForViewer,
} from '../db/repo/self-reviews.js';
import { insertRecusal, listRecusals, listRecusalViews } from '../db/repo/recusals.js';
import { writeAuditLog } from '../audit/log.js';
import { checkRecusal, checkPeerEligibility } from '../domain/review-eligibility.js';
import { appError } from '../errors.js';

function fail(status, code, message, detail) {
  // ⚠️ 必须用 P0 的 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    P0 终审 I-C 的错误分支是 `err instanceof AppError ? err.message : '请求无效'` ——
  //    裸 Error 不是 AppError → message 被替换成通用文案「请求无效」，
  //    计划里想给用户看的中文文案会被**吞掉**。
  return appError(status, code, message, detail || undefined);
}

/**
 * 单事务执行：要么全成功，要么全回滚。
 * ⛔ 用 `BEGIN IMMEDIATE`（不是默认的 DEFERRED）：立即取写锁，
 *    避免「抢键」与「写数据」之间被另一个连接插进来。
 */
function inTransaction(db, fn) {
  const nested = db.isTransaction === true;
  if (!nested) db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    if (!nested) db.exec('COMMIT');
    return out;
  } catch (err) {
    if (!nested) db.exec('ROLLBACK');
    throw err;
  }
}

/** 同一 requestId 被用于**不同内容** → 409（响亮报错，不静默继续写） */
function assertSameRequestContent({ prior, currentKeys, label }) {
  const priorKeys = [...new Set(prior.map((p) => p.key))].sort();
  const cur = [...new Set(currentKeys)].sort();
  if (priorKeys.length !== cur.length || priorKeys.some((k, i) => k !== cur[i])) {
    throw fail(
      409,
      'REQUEST_ID_REUSED',
      `同一个 requestId 被用于了不同的${label}内容 —— 每次提交必须使用唯一的 requestId`,
    );
  }
}

/** 分数必须在 0–100（否则会污染 score_stats 与后续归一化） */
function assertScoreInRange(score, label) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw fail(400, 'SCORE_OUT_OF_RANGE', `${label}必须是 0–100 之间的数字`, { score });
  }
  return score;
}

function assertStageExists(db, stageId) {
  if (!getStage(db, stageId)) {
    throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  }
}

/**
 * 队伍必须在本赛段名册内。
 * ⚠️ 父代理预审修正（Important，I1 / I5）：
 *   ① 原来写入口**不校验队伍** → 评委能给**别的届期**的队打分，
 *      那支队会被算进本赛段榜单（外队进榜）。
 *   ② 队伍不存在时直接撞外键 → `FOREIGN KEY constraint failed` 漏到 HTTP 层
 *      → **500**（而不是三态状态码要求的 404）。
 * 现在统一按「本赛段名册」判定，不在册 → 404。
 *
 * ⛔⛔ **P11 · E156：名册粒度改为「赛段级优先、届期级兜底」**
 *   原来这里用的是**届期级**名册（`listStageTeams` = 同届期的所有队）
 *   ⇒ **同届期另一赛段的队伍照样能被写进本赛段**（外队进榜）。
 *   `stage_team` 表（P3 建、P11 · W5 才有写入方）就是为关这个闸门而存在的，
 *   但它此前**只写不读**（`hasStageRoster` 在生产上零调用方）。
 *   现在按 P3 计划偏差表 3c 的口径实现：
 *     · **赛段级名册有数据** ⇒ 以它为准（外队进榜被挡住）；
 *     · **赛段级名册为空**（赛段刚建、还没报名册）⇒ 回落到届期级
 *       （否则会把所有评分都拒掉 —— 那是「全死」，比外队进榜更糟）。
 */
function assertTeamInStage(db, stageId, teamId, label = '队伍') {
  if (!teamId) {
    throw fail(400, 'MISSING_TEAM_ID', `缺少${label}`);
  }
  const roster = resolveStageRoster(db, stageId);
  if (!roster.includes(teamId)) {
    throw fail(404, 'TEAM_NOT_IN_STAGE', `${label} ${teamId} 不在本赛段名册内`);
  }
}

/**
 * 解析「本赛段名册」（P11 · E156 抽出来的**唯一入口**）。
 *
 * ⚠️ **必须走这个函数，不要再直接调 `listStageTeams`** ——
 *    直接调 = 届期级口径 = 外队进榜的闸门没关上。
 *    （P3 计划偏差表 3c：名册有数据时优先赛段级、否则回落到届期级。）
 *
 * @returns {string[]} 本赛段可写的队伍 id 列表
 */
export function resolveStageRoster(db, stageId) {
  // 赛段级名册有登记 ⇒ 以它为准（**外队进榜在这里被挡住**）
  if (hasStageRoster(db, stageId)) {
    return listStageTeamIds(db, stageId);
  }
  // 没有登记 ⇒ 回落到届期级（赛段刚建、名册还没录 ⇒ 不能把评分全拒了）
  return listStageTeams(db, stageId).map((t) => t.teamId);
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
 * @param {Array} input.items [{ teamId, dimension, rawScore }]
 */
export function submitReviews({ db, stageId, judgeId, items = [], requestId = null, now }) {
  assertStageExists(db, stageId);
  assertVotingJudge(db, stageId, judgeId);
  // 队伍必须在本赛段名册内（外队进榜 / 不存在 → 404）
  for (const item of items) {
    assertTeamInStage(db, stageId, item.teamId);
  }

  // 幂等快速路径：同一次请求已经生效过 → 直接返回上次结果，不重复落数据
  if (requestId) {
    const prior = findReviewsByRequestId(db, { stageId, judgeId, requestId });
    if (prior.length) {
      assertSameRequestContent({
        prior: prior.map((r) => ({ key: `${r.team_id}::${r.dimension}` })),
        currentKeys: items.map((i) => `${i.teamId}::${i.dimension}`),
        label: '评分',
      });
      return { stageId, judgeId, requestId, submitted: 0, items: prior };
    }
  }

  return inTransaction(db, () => {
    // 抢键：抢不到 = 同一次请求已被另一次并发提交处理 → 幂等短路
    if (requestId) {
      const claimed = claimRequestKey(db, { scope: 'review', stageId, subjectId: judgeId, requestId, now });
      if (!claimed) {
        const prior = findReviewsByRequestId(db, { stageId, judgeId, requestId });
        assertSameRequestContent({
          prior: prior.map((r) => ({ key: `${r.team_id}::${r.dimension}` })),
          currentKeys: items.map((i) => `${i.teamId}::${i.dimension}`),
          label: '评分',
        });
        return { stageId, judgeId, requestId, submitted: 0, items: prior };
      }
    }

    const written = [];
    // 改分留痕：旧分与新分一起进审计（父代理预审 Minor 7）
    // ⚠️ 原来只记「条数」—— 评委改分后，**当时榜单用的是几分**再也还原不出来。
    const changed = [];
    // 按维度分桶的增量（新增分 / 被改分替换掉的旧分）——score_stats 必须同步修正
    const byDimension = new Map();
    const bucketOf = (dimension) => {
      if (!byDimension.has(dimension)) byDimension.set(dimension, { added: [], removed: [] });
      return byDimension.get(dimension);
    };

    for (const item of items) {
      assertNotRecused(db, stageId, judgeId, item.teamId);
      assertScoreInRange(item.rawScore, '评委打分');
      const bucket = bucketOf(item.dimension);
      const existing = findReview(db, { stageId, judgeId, teamId: item.teamId, dimension: item.dimension });
      if (existing) {
        // 改分：覆盖写并同步修正统计量（n 不变，mean/sum_sq 修正）
        updateReviewScore(db, { id: existing.id, rawScore: item.rawScore, now });
        bucket.removed.push(existing.raw_score);
        bucket.added.push(item.rawScore);
        changed.push({ teamId: item.teamId, dimension: item.dimension, from: existing.raw_score, to: item.rawScore });
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
      detail: { requestId, count: items.length, changed }, now,
    });

    return { stageId, judgeId, requestId, submitted: written.length, items: written };
  });
}

/**
 * 评分进度：已交 / 应交 / 缺谁 / 维度进度
 *
 * ⚠️ **应交队伍必须来自赛段真实名册**（`listStageTeams`），
 *    而不是「已有打分记录里出现过的队伍」—— 后者会让「完全没人打分的队」从名单里消失，
 *    进度显示 100% 而实际有队没被评。
 * ⚠️ **维度列表**默认取「已出现过的维度」；调用方（Task 8 的 API 层）可以传
 *    `dimensions` 显式指定规则里的维度全集，否则「从未有人评过的维度」不会出现在进度里。
 */
export function getReviewState({ db, stageId, viewer, dimensions = null }) {
  assertStageExists(db, stageId);
  const seat = viewer?.userId ? getStageJudge(db, stageId, viewer.userId) : null;
  const isAdmin = viewer?.isAdmin === true;
  const all = listReviews(db, { stageId });
  const cells = listReviewCells(db, stageId);
  const observedTeams = [...new Set(cells.map((c) => c.team_id))].sort();
  const observedDimensions = [...new Set(cells.map((c) => c.dimension))].sort();
  // 赛段真实名册（P11 · E156：赛段级优先、届期级兜底）；名册为空时退回已出现的队伍（赛段还没建队的情况）
  const roster = resolveStageRoster(db, stageId);
  const teams = roster.length ? roster : observedTeams;
  const dimList = Array.isArray(dimensions) && dimensions.length ? [...dimensions].sort() : observedDimensions;
  const judges = listStageJudges(db, stageId).filter((j) => j.seat !== 'observer');

  // ⛔ P9.1 修正（真机复验抓出）：**有投票权的席位数**必须同时决定 `total` 与 `dimensionProgress`。
  //    原来非评委视角的 `total` 照算「队伍数 × 维度数」，可 `missing` 只在下面
  //    `else if (seat)` 分支里填 ⇒ **没有本赛段席位**的账号拿到
  //    `{submitted: 0, total: 20, missing: []}` —— 三个数自相矛盾：
  //    前端据此把「missing 为空」当成「都交了」，于是同一屏上
  //    「0 我的已交 / 应交 20 格 / 完成度 0%」与「本赛段的评分都交了」并排出现。
  //    口径：**没有席位 ⇒ 这个人在这个赛段没有任何属于他的格子 ⇒ total 必须是 0**。
  //    （写路径本来就被 `assertVotingJudge` 挡住 —— 这里是让「读到的数」与「写得到的」一致。）
  const seatCount = isAdmin ? judges.length : (seat ? 1 : 0);

  const dimensionProgress = {};
  for (const dim of dimList) {
    const total = seatCount * teams.length;
    const submitted = all.filter((r) => r.dimension === dim && (isAdmin || r.judge_id === viewer.userId)).length;
    dimensionProgress[dim] = { submitted, total };
  }

  const missing = [];
  if (isAdmin) {
    for (const j of judges) {
      for (const t of teams) {
        for (const dim of dimList) {
          const hit = all.find((r) => r.judge_id === j.user_id && r.team_id === t && r.dimension === dim);
          if (!hit) missing.push({ judgeId: j.user_id, teamId: t, dimension: dim });
        }
      }
    }
  } else if (seat) {
    for (const t of teams) {
      for (const dim of dimList) {
        const hit = all.find((r) => r.judge_id === viewer.userId && r.team_id === t && r.dimension === dim);
        if (!hit) missing.push({ teamId: t, dimension: dim });
      }
    }
  }

  const submitted = isAdmin ? all.length : all.filter((r) => r.judge_id === viewer?.userId).length;
  const total = seatCount * teams.length * dimList.length;
  return { submitted, total, missing, dimensionProgress };
}

/**
 * 评审工作台（**只读**）：一次拿齐前端拼评分表单要的三样东西。
 *
 * ⚠️ 为什么需要这个函数（P8）：
 *   前端要显示「本赛段有哪些队伍 + 有哪些可打分维度 + 我已经给了多少分」，
 *   而这三样东西原先**分散在三个地方，且都没有对外读口**：
 *     名册   → listStageTeams（仓储层，且**只有 teamId、没有队名**）
 *     维度   → rules.scoring[stage.scoring_config_key].dimensions（规则文件）
 *     我的分 → stage_reviews（**没有任何读端点**）
 *   ⇒ 前端要么拼三个请求（慢），更要命的是**三个口径会各自漂移**
 *      （名册口径与维度口径不在一处 ⇒ 前端拼出来的表可能自相矛盾）。
 *
 * ⛔ **只返回本人的分**（`myScores`）：改分要回填本人已给的分；
 *    别人的分不该出现在评审页上（全局可见性由 filterVisibleScores 管，本页不需要那份全局数组）。
 */
export function getReviewBoard({ db, stageId, viewer, rules = null }) {
  const stage = getStage(db, stageId);
  if (!stage) throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const config = rules?.scoring?.[stage.scoring_config_key];
  if (!config) {
    throw fail(500, 'SCORING_CONFIG_MISSING', `赛段 ${stageId} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  }
  const dimensions = (config.dimensions ?? []).map((d) => ({
    key: d.key,
    name: d.name,
    weight: d.weight,
    seat: d.seat,
  }));
  // 评委只能给**评委席**维度打分（与 POST /reviews 的维度白名单同一口径）
  const judgeDimensions = dimensions.filter((d) => d.seat === 'judge');
  const teams = listStageTeamRows(db, stageId);
  const myScores = listReviews(db, { stageId, judgeId: viewer?.userId ?? null })
    .map((r) => ({ teamId: r.team_id, dimension: r.dimension, rawScore: r.raw_score }));
  // ── 【P10 评委前置】三个「我已经交过哪些」 ──────────────────────────────
  // ⚠️ **同族口径**：`myScores` 只返回本人 ⇒ 这三个字段也**只返回当前 viewer 自己的**。
  //    ⛔ **组委会也只看自己的**（不实现「看全部」）——
  //    「看全部」要额外判定（谁能看别人的互评/自评？评委能看同赛段其他评委的？
  //    答案必须是「不能」）⇒ 一律不做，避免出现「有的页面看得到、有的看不到」的漂移。
  //    若将来要放开，必须**同时**放开 `myScores` 并写清口径（否则评审页会出现两套口径）。
  //
  // ⚠️ **三者的「我的」含义各不相同**（与各自的写入口对齐）：
  //   myPeerReviews  互评是「队 → 队」的行为 ⇒ 「我的」= **我参与的那些队**发起的互评
  //                  （写入口：提交者必须是发起队的在册成员）
  //   mySelfReviews  自评是**队伍**行为（R-JDG-13 不加分）⇒ 「我的」= **我参与的队**的自评
  //                  （写入口：只能由本队成员提交）
  //   myCalibrations 校准是**评委个人**行为（R-JDG-12 对齐宽严尺度）⇒ 「我的」= judge_id = 自己
  const viewerUserId = viewer?.userId ?? null;
  const myPeerReviews = listPeerReviewsForViewer(db, { stageId, userId: viewerUserId })
    .map((r) => ({ fromTeamId: r.fromTeamId, toTeamId: r.toTeamId, score: r.score }));
  const mySelfReviews = listSelfReviewsForViewer(db, { stageId, userId: viewerUserId })
    .map((r) => ({ teamId: r.teamId, dimension: r.dimension, rawScore: r.rawScore }));
  const myCalibrations = listCalibrationsForJudge(db, { stageId, judgeId: viewerUserId })
    .map((r) => ({ dimension: r.dimension, rawScore: r.rawScore }));
  const progress = getReviewState({
    db,
    stageId,
    viewer: { userId: viewer?.userId ?? null, isAdmin: viewer?.isAdmin === true },
    dimensions: judgeDimensions.map((d) => d.key),
  });
  return {
    stage: {
      id: stage.id,
      key: stage.key,
      name: stage.name,
      kind: stage.kind,
      status: stage.status,
      scoringConfigKey: stage.scoring_config_key,
    },
    dimensions,
    judgeDimensions,
    teams,
    myScores,
    // ⚠️ 【P10 评委前置】三个「我已经交过哪些」——**只含当前 viewer 自己的**（同 myScores 口径）。
    myPeerReviews,
    mySelfReviews,
    myCalibrations,
    // ⚠️ **scope 必须带上**（P8 DP-99）：getReviewState 对两种身份返回的是**两套口径** ——
    //    组委会 = 全赛段（已交 N 格 / 缺了谁的哪一格），评委 = 只看自己（我还差几格）。
    //    前端拿到同一个 {submitted,total,missing} 却不知道是哪套口径 ⇒
    //    标签必然有一半是错的（这正是 P7 的 B1「数字与标签对不上」的同款事故）。
    progress: { ...progress, scope: viewer?.isAdmin === true ? 'stage' : 'mine' },
  };
}

/** 校准打分（R-JDG-12）：写 calibrations，【不计入评分】 */
export function submitCalibration({ db, stageId, judgeId, items = [], now }) {
  assertStageExists(db, stageId);
  assertVotingJudge(db, stageId, judgeId);
  return inTransaction(db, () => {
    for (const item of items) {
      assertScoreInRange(item.rawScore, '校准打分');
      insertCalibration(db, { stageId, judgeId, dimension: item.dimension, rawScore: item.rawScore, now });
    }
    writeAuditLog(db, {
      actorId: judgeId, action: 'review.calibrate', entity: 'stage', entityId: stageId,
      detail: { count: items.length }, now,
    });
    return { stageId, judgeId, submitted: items.length };
  });
}

/** 企业确认（R2 双签 + R-JDG-14 签字必须有内容） */
export function submitEnterpriseConfirmation({ db, stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId = null, signatoryUserId = null, content = '', now }) {
  // R-JDG-14：空白签字不予采信
  if (!content || !String(content).trim()) {
    throw fail(400, 'SIGNATURE_CONTENT_REQUIRED', '企业签字必须填写内容（解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色）');
  }
  assertScoreInRange(rawScore, '企业确认分');
  assertTeamInStage(db, stageId, teamId);
  // ⛔ P11 · E148②：同格重签原来直接撞唯一索引 `idx_enterprise_confirmations_cell`
  //    → SQLite 抛 UNIQUE constraint → **HTTP 500「服务内部错误」**（违反设计文档 §7.3 的三态口径）。
  //    现在先查同格是否已有**未撤回**的确认 ⇒ 明确报 409，并告诉客户端「要改请走改签」。
  const existing = findActiveEnterpriseConfirmation(db, { stageId, teamId, dimension, enterpriseId });
  if (existing) {
    throw fail(409, 'CONFIRMATION_EXISTS',
      '该队伍在该维度已有企业确认（同一格只能有一条）。要更正请用「改签」，要撤销请用「撤回」。',
      { confirmationId: existing.id });
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

/**
 * ⛔ P11 · E141：**撤回企业确认**（逆向路径）。
 *
 * ⚠️ **为什么必须有它**（E141 实测）：
 *   企业确认一旦落库就**没有任何改动的途径** ⇒
 *   ① 签错了（内容写错 / 分数写错）只能永远错下去；
 *   ② **缺跨领域评委签字**（R2 双签只签了一半）的确认**没法补签** ⇒
 *      该队的企业席按 R2 计 0 分并挂 warning，而**产品内没有任何办法把它修好**。
 *   ⇒ 只有正向流程、没有逆向流程，是本项目这一类 bug 的共同病根。
 *
 * ⚠️ 撤回是**软删**（deleted_at）：企业确认是计分证据，事后要能查「谁在什么时候签过、后来撤了」。
 * ⚠️ 撤回**不自动重算**：计分与发榜都是显式动作（设计文档 §869），
 *    这里只把「需要重算」这件事显式告诉调用方（needsRecompute）。
 *
 * @param {object} args
 * @param {boolean} [args.isCommittee] 组委会可撤任何人的（代录与纠错都需要）
 */
export function withdrawEnterpriseConfirmation({ db, id, stageId, actorId, isCommittee = false, now }) {
  const row = getEnterpriseConfirmationById(db, id);
  // ⛔ 单条不满足 → 404（不泄露「这条曾经存在过」）
  if (!row) throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  if (stageId && row.stage_id !== stageId) {
    throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  }
  // ⛔ 权限：只有**签字的那家出题企业**本人或组委会能撤。
  //    跨领域评委**不能**撤（撤了就把人家的签字也一起撤了 —— 那不是他的权限范围）。
  if (!isCommittee && row.enterprise_id !== actorId) {
    throw fail(403, 'FORBIDDEN', '只有签字的出题企业（或组委会）可以撤回这条企业确认');
  }
  softDeleteEnterpriseConfirmation(db, id, now);
  writeAuditLog(db, {
    actorId, action: 'enterprise.confirm.withdraw', entity: 'team', entityId: row.team_id,
    detail: {
      stageId: row.stage_id, confirmationId: id, dimension: row.dimension,
      rawScore: row.raw_score, hasCrossJudge: !!row.cross_judge_id,
      reason: '企业确认被撤回（软删，证据留痕）',
    },
    now,
  });
  return {
    id, withdrawn: true, teamId: row.team_id, stageId: row.stage_id, dimension: row.dimension,
    needsRecompute: true,
    hint: '撤回已生效：该队的企业席计分已变化，请重新计算并重新发榜。',
  };
}

/**
 * ⛔ P11 · E141：**改签企业确认**（正向纠错 + R2「后补」路径）。
 *
 * ⚠️ **改签 = 软删旧行 + 追加新行**（同格），不是就地覆盖 ——
 *    企业确认是**计分证据**（INTERFACES.md §0「追加式」：只增不改，更正走新记录）。
 *    历史留在旧行的 deleted_at 与审计日志里。
 *
 * ⛔ **谁可以改什么**（三条硬边界）：
 *   ① 内容与分数 ⇒ 只有**签字的那家出题企业**本人或组委会（换内容 = 换这家企业的主张）；
 *   ② **后补跨领域签字** ⇒ 本赛段评委可以给自己补签（crossJudgeId = 自己）；
 *   ③ **撤销自己的补签** ⇒ 当前 cross_judge_id 本人可以把它清掉（不能动别人的）。
 *
 * ⚠️ 这三条同时解决了两个问题：
 *   · E148①「写端点要不要强制 crossJudgeId」—— **不强制**（R2 是计分口径，不是写入校验），
 *     改由「后补」路径补齐 ⇒ 不改变 S7 语义；
 *   · E141「缺双签恒 0 分且产品内修不了」—— 现在能补签了。
 */
export function resignEnterpriseConfirmation({
  db, id, stageId, actorId, isCommittee = false,
  rawScore = null, content = null, crossJudgeId = undefined, now,
}) {
  const row = getEnterpriseConfirmationById(db, id);
  if (!row) throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  if (stageId && row.stage_id !== stageId) {
    throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  }
  const isEnterprise = row.enterprise_id === actorId;
  const setCross = crossJudgeId !== undefined;
  const nextCrossJudgeId = setCross ? (crossJudgeId || null) : row.cross_judge_id;
  const changes = {};

  // ① 内容 / 分数
  if (rawScore !== null || content !== null) {
    if (!isCommittee && !isEnterprise) {
      throw fail(403, 'FORBIDDEN', '只有签字的出题企业（或组委会）可以更正企业确认的内容与分数');
    }
    if (rawScore !== null) {
      assertScoreInRange(rawScore, '企业确认分');
      if (rawScore !== row.raw_score) changes.rawScore = { from: row.raw_score, to: rawScore };
    }
    if (content !== null) {
      if (!String(content).trim()) {
        throw fail(400, 'SIGNATURE_CONTENT_REQUIRED', '企业签字必须填写内容（解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色）');
      }
      if (content !== row.content) changes.content = { from: row.content, to: content };
    }
  }

  // ② 跨领域签字人
  if (setCross && nextCrossJudgeId !== row.cross_judge_id) {
    if (!isCommittee) {
      // 后补：自己给自己补签（本赛段评委）
      const isBackfill = nextCrossJudgeId === actorId;
      // 撤自己的补签：当前就是他签的
      const isSelfRevoke = nextCrossJudgeId === null && row.cross_judge_id === actorId;
      if (!isBackfill && !isSelfRevoke) {
        throw fail(403, 'FORBIDDEN', '跨领域评委只能给自己补签，或撤销自己已补的签字');
      }
    }
    if (nextCrossJudgeId) {
      if (nextCrossJudgeId === row.enterprise_id) {
        throw fail(400, 'CROSS_JUDGE_SAME_AS_SIGNATORY', '跨领域评委签字人不能与出题企业签字人相同');
      }
      if (!getStageJudge(db, row.stage_id, nextCrossJudgeId)) {
        throw fail(404, 'JUDGE_NOT_ASSIGNED', '跨领域评委不在本赛段名单内');
      }
    }
    changes.crossJudgeId = { from: row.cross_judge_id, to: nextCrossJudgeId };
  }

  if (!Object.keys(changes).length) {
    throw fail(400, 'NOTHING_TO_CHANGE', '没有要改的内容：改签必须至少变更一项（内容 / 分数 / 跨领域签字人）');
  }

  // 软删旧行 + 追加新行（同格）⇒ 唯一索引仍然只允许一条「有效」确认
  softDeleteEnterpriseConfirmation(db, id, now);
  const fresh = insertEnterpriseConfirmation(db, {
    stageId: row.stage_id,
    teamId: row.team_id,
    enterpriseId: row.enterprise_id,
    dimension: row.dimension,
    rawScore: rawScore !== null ? rawScore : row.raw_score,
    crossJudgeId: nextCrossJudgeId,
    signatoryUserId: row.signatory_user_id,
    content: content !== null ? content : row.content,
    now,
  });
  writeAuditLog(db, {
    actorId, action: 'enterprise.confirm.resign', entity: 'team', entityId: row.team_id,
    detail: {
      stageId: row.stage_id, replacedId: id, confirmationId: fresh.id, dimension: row.dimension,
      changes,
    },
    now,
  });
  return {
    ...fresh,
    replacedId: id,
    needsRecompute: true,
    hint: '改签已生效：该队的企业席计分已变化，请重新计算并重新发榜。',
  };
}

/**
 * 互评（幂等；资格由 checkPeerEligibility 把关）
 *
 * ⚠️ 幂等键的 `subjectId` 用**提交方**（actorId），⛔ 不用 items 推导 ——
 *    items 变了主体也变 → 键抢不到自己 → 幂等被绕过。
 *    主体退化成 '*' 时（没有 actorId），靠「同 requestId 内容比对」兜住复用。
 */
export function submitPeerReviews({ db, stageId, items = [], requestId = null, actorId = null, now }) {
  assertStageExists(db, stageId);
  const subject = actorId ?? '*';
  // 互评的两端都必须是本赛段名册内的队伍（外队 / 不存在 → 404）
  for (const item of items) {
    assertTeamInStage(db, stageId, item.fromTeamId, '发起队');
    assertTeamInStage(db, stageId, item.toTeamId, '被评队');
  }

  if (requestId) {
    const prior = findPeerReviewsByRequestId(db, { stageId, requestId });
    if (prior.length) {
      assertSameRequestContent({
        prior: prior.map((r) => ({ key: `${r.from_team_id}->${r.to_team_id}` })),
        currentKeys: items.map((i) => `${i.fromTeamId}->${i.toTeamId}`),
        label: '互评',
      });
      return { stageId, submitted: 0, items: prior };
    }
  }

  return inTransaction(db, () => {
    if (requestId) {
      const claimed = claimRequestKey(db, { scope: 'peer_review', stageId, subjectId: subject, requestId, now });
      if (!claimed) {
        const prior = findPeerReviewsByRequestId(db, { stageId, requestId });
        assertSameRequestContent({
          prior: prior.map((r) => ({ key: `${r.from_team_id}->${r.to_team_id}` })),
          currentKeys: items.map((i) => `${i.fromTeamId}->${i.toTeamId}`),
          label: '互评',
        });
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
      assertScoreInRange(item.score, '互评分');
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
      actorId, action: 'peer_review.submit', entity: 'stage', entityId: stageId,
      detail: { requestId, count: items.length }, now,
    });
    return { stageId, submitted: written.length, items: written };
  });
}

/** 自评测（幂等） */
export function submitSelfReviews({ db, stageId, teamId, items = [], requestId = null, now }) {
  assertStageExists(db, stageId);
  assertTeamInStage(db, stageId, teamId);
  if (requestId) {
    const prior = findSelfReviewsByRequestId(db, { stageId, teamId, requestId });
    if (prior.length) {
      assertSameRequestContent({
        prior: prior.map((r) => ({ key: r.dimension })),
        currentKeys: items.map((i) => i.dimension),
        label: '自评',
      });
      return { stageId, teamId, submitted: 0, items: prior };
    }
  }
  return inTransaction(db, () => {
    if (requestId) {
      const claimed = claimRequestKey(db, { scope: 'self_review', stageId, subjectId: teamId, requestId, now });
      if (!claimed) {
        const prior = findSelfReviewsByRequestId(db, { stageId, teamId, requestId });
        assertSameRequestContent({
          prior: prior.map((r) => ({ key: r.dimension })),
          currentKeys: items.map((i) => i.dimension),
          label: '自评',
        });
        return { stageId, teamId, submitted: 0, items: prior };
      }
    }
    const written = [];
    for (const item of items) {
      assertScoreInRange(item.rawScore, '自评分');
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
  });
}

/** 回避申报（R-JDG-09）：必须留档 */
/**
 * 撤销回避（R-JDG-09 的「撤销」语义；终审修正 M-4 补上写路径）。
 *
 * ⛔ 领域层 `checkRecusal` 取**最后一条**记录，`action='reinstated'` 覆盖前面的 `'recused'` ——
 *    所以撤销的实现是**再写一条**记录，而不是 UPDATE 前一条（记录只增不改，可复算）。
 * ⚠️ 撤销必须与申报**同一队伍范围**（stage 级回避的 team_id 为 null）——
 *    否则「赛段级回避」会被一支队的撤销记录意外盖掉。
 */
export function reinstateRecusal({ db, stageId, judgeId, teamId = null, reason, actorId = null, now }) {
  assertStageExists(db, stageId);
  if (!reason || !String(reason).trim()) {
    throw fail(400, 'RECUSAL_REASON_REQUIRED', '撤销回避必须填写原因（误报 / 利益关系已澄清 / 其他）');
  }
  if (!getStageJudge(db, stageId, judgeId)) {
    throw fail(404, 'JUDGE_NOT_ASSIGNED', '该评委未被分配到本赛段');
  }
  const scoped = listRecusals(db, { stageId, judgeId })
    .filter((r) => (r.team_id ?? null) === (teamId ?? null));
  const latest = scoped.length ? scoped[scoped.length - 1] : null;
  if (!latest) {
    throw fail(404, 'RECUSAL_NOT_FOUND', '没有找到可撤销的回避记录');
  }
  if (latest.action !== 'recused') {
    throw fail(409, 'RECUSAL_NOT_ACTIVE', '该回避已经被撤销过了');
  }
  const row = insertRecusal(db, {
    stageId, judgeId, teamId, reason, source: 'reinstated', auditBy: actorId, action: 'reinstated', now,
  });
  writeAuditLog(db, {
    actorId, action: 'recusal.reinstate', entity: 'stage', entityId: stageId,
    detail: { judgeId, teamId, reason, supersedes: latest.id }, now,
  });
  return row;
}

export function declareRecusal({ db, stageId, judgeId, teamId = null, reason, actorId = null, now }) {
  assertStageExists(db, stageId);
  if (!reason || !String(reason).trim()) {
    throw fail(400, 'RECUSAL_REASON_REQUIRED', '回避必须填写原因（供应方 / 投资方 / 前雇主）');
  }
  if (teamId != null) {
    assertTeamInStage(db, stageId, teamId);
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

/**
 * 回避台账（**读**）—— P10 评委前置页的「已回避清单」数据源。
 *
 * ⚠️ 为什么以前没有这个读口（这正是 P10 补上的缺口）：
 *   全仓只有 `POST /api/stages/:stageId/recusals`，**没有**配套的 GET ——
 *   `recusal_records` 只在计算（computeStage）与复核（checkRecusal）里被读。
 *   ⇒ 前端只能显示「本次会话里我刚提交过的那一条」，
 *      历史上申报过的、别的评委申报过的（组委会要看的），**全都看不到**。
 *
 * ⛔ **可见性在服务层（= API 层）裁决**（全局约束「可见性在 API 层过滤，
 *    前端隐藏 = 数据已泄露」）：
 *   · **本人**（普通登录用户）⇒ 只看**自己**的回避记录；
 *   · **组委会**（`stage:compute`，与 POST /recusals 的 isCommittee 口径一致）
 *     ⇒ 看**全部**（含别的评委的记录）。
 *   ⛔ 「看全部」**只给组委会** —— 回避原因是利益冲突（供应方 / 投资方 / 前雇主），
 *      让所有评委互相看见对方的回避理由，等于把「谁跟哪支队有关系」广播出去。
 *
 * ⚠️ **记录只增不改**（R-JDG-09 留档）：撤销是**再写一条** `action='reinstated'`，
 *    所以台账里同一支队的回避会有**两行**（原申报 + 撤销）——
 *    这是「留档 + 可复算」的语义，**不是**重复行。
 *    每行都带自己的 `status`（recused / reinstated），前端按需取最后一条。
 *
 * ⚠️ 三态状态码：赛段不存在 → 404；赛段存在但没有记录 → **200 + `{ items: [] }`**（不是 404）。
 */
export function getRecusalLedger({ db, stageId, viewer }) {
  assertStageExists(db, stageId);
  const isAdmin = viewer?.isAdmin === true;
  // ⛔ 非组委会一律收窄到「本人」—— 判定在**这里**（服务层），不在前端。
  const judgeId = isAdmin ? null : (viewer?.userId ?? null);
  const rows = listRecusalViews(db, { stageId, judgeId });
  return {
    items: rows.map((r) => ({
      id: r.id,
      stageId: r.stageId,
      judgeId: r.judgeId,
      judgeName: r.judgeName,
      teamId: r.teamId,
      teamName: r.teamName,
      reason: r.reason,
      source: r.source,
      auditBy: r.auditBy,
      createdAt: r.createdAt,
      // ⚠️ `status` = 记录自身的动作（recused 生效 / reinstated 撤销）
      status: r.status,
    })),
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/review-service.test.js`
Expected: PASS（22 个测试全过：review-service.test.js 22）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/db/repo src/db/repo/audit-log.js src/audit/log.js src/services/review.js test/review-service.test.js
git commit -m "feat(P2): 评分提交服务（幂等 + 增量 score_stats + 校准/互评/自评/回避）"
```

> **【2026-10-21 漂移审计修正 M-8】** 原来 `git add` 列表里只有 `src/audit/log.js`
> （在 `src/` 而非 `src/db/repo/`），与「SQL 收在仓储层」的直觉相悖 —— 读起来像
> 「审计日志的 SQL 在 `src/` 里」。C-3 修正后 `audit_log` 的 SQL 落在
> `src/db/repo/audit-log.js`，故在 add 列表里**显式点名**该文件（`src/db/repo` 目录项保留：
> 本 Task 还新建了 stages / reviews / request-keys / enterprise-confirmations /
> peer-reviews / self-reviews / recusals 七个仓储文件）。

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
// platform/test/tiebreak.test.js —— 加时陈述与一票破同分
//
// 依据：P2 计划 Task 7「加时陈述与一票破同分（tiebreak_round / tiebreak_votes）」
// 溯源需求：R-JDG-19（同分 → 加时陈述 → 共同复议）
//
// ⚠️ **夹具必须建真实数据**（父代理预审修正，Important）：
//    Task 1 补齐了引用型外键（`stage_id → stages`、`team_id → teams`、`voter_id → users`），
//    原规格用的假 id（'ed1' / 't1' / 't2'）**必然触发外键失败**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTiebreakVote } from '../src/db/repo/tiebreak.js';
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
  const observer = createUser(db, { name: '观察员', phone: '13900000023', password: 'pw' });
  const captain = createUser(db, { name: '队长甲', phone: '13900000024', password: 'pw' });
  const captain2 = createUser(db, { name: '队长乙', phone: '13900000025', password: 'pw' });

  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const teamA = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, status: 'forming', now: NOW,
  });
  const teamB = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain2.id, status: 'forming', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '决赛', kind: 'final',
    startsAt: '2026-10-26', endsAt: '2026-10-28', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: voter.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });

  return { db, close, dataDir, admin, voter, observer, teamA, teamB, stage };
}

function cleanup({ db, close, dataDir }) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

test('开启加时陈述轮次：同分组 + 10 分钟陈述截止', () => {
  const ctx = setup();
  const { db, admin, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.equal(round.kind, 'statement');
  assert.equal(round.status, 'open');
  assert.deepEqual(JSON.parse(round.tied_team_ids_json), [teamA.id, teamB.id]);
  assert.equal(round.statement_deadline, '2026-10-20T10:10:00.000Z');
  cleanup(ctx);
});

test('一人一队一票：同一 (轮次, 投票人, 队伍) 第二次投票被数据库拒绝', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 90, now: NOW }),
    (err) => err.status === 409,
    '重复投票必须被拒绝（唯一约束保证）',
  );
  // 同一人对另一支队伍投票是允许的
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamB.id, score: 70, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tiebreak_votes').get().n, 2);
  cleanup(ctx);
});

test('轮次状态与票数统计', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  const state = getTiebreakRoundState({ db, roundId: round.id });
  assert.equal(state.votes.length, 1);
  assert.equal(state.tallies[teamA.id].count, 1);
  assert.ok(Math.abs(state.tallies[teamA.id].mean - 80) < 1e-12);
  cleanup(ctx);
});

test('关闭轮次后不能继续投票', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 409,
  );
  cleanup(ctx);
});

test('加时陈述复议分可供破同分链消费', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamB.id, score: 60, now: NOW });
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  const extra = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: [teamA.id, teamB.id] });
  assert.ok(Math.abs(extra[teamA.id] - 80) < 1e-12);
  assert.ok(Math.abs(extra[teamB.id] - 60) < 1e-12);
  cleanup(ctx);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('关闭一个不存在的轮次 → 404（不把裸 TypeError 漏给调用方）', () => {
  // ⚠️ 原实现：UPDATE 0 行 → 返回 null → `round.stage_id` 抛
  //    「Cannot read properties of null」—— 它**不是 AppError**，
  //    HTTP 层只能回通用文案「请求无效」，调用方既拿不到状态码也拿不到原因。
  const ctx = setup();
  const { db, admin } = ctx;
  assert.throws(
    () => closeTiebreakRound({ db, roundId: 'no-such-round', actorId: admin.id, now: NOW }),
    (err) => err.status === 404,
  );
  cleanup(ctx);
});

test('投票人必须是有投票权的评委：观察员 → 403，未分配 → 403', () => {
  const ctx = setup();
  const { db, admin, observer, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: observer.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 403,
    '观察员无投票权（R-JDG-11）',
  );
  const outsider = createUser(db, { name: '路人', phone: '13900000026', password: 'pw' });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: outsider.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 403,
    '未被分配到赛段的人不能投票',
  );
  cleanup(ctx);
});

test('投票分越界 → 400（不让破 100 分的复议分进榜）', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  for (const bad of [1000, -1, NaN]) {
    assert.throws(
      () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: bad, now: NOW }),
      (err) => err.status === 400,
      `score=${String(bad)} 必须被拒`,
    );
  }
  cleanup(ctx);
});

test('未关闭的轮次不得被算进复议分（榜单不能随投票进行而漂移）', () => {
  // ⚠️ 原实现：取全部轮次 → 还在开放投票的轮次，其**当前均值**被当成最终复议分。
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  const before = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: [teamA.id, teamB.id] });
  assert.deepEqual(before, {}, '开放中的轮次不产生复议分');
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  const after = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: [teamA.id, teamB.id] });
  assert.ok(Math.abs(after[teamA.id] - 80) < 1e-12);
  cleanup(ctx);
});

test('同分组至少两支队伍；同一赛段不允许两个进行中的轮次', () => {
  const ctx = setup();
  const { db, admin, teamA, teamB, stage } = ctx;
  assert.throws(
    () => openTiebreakRound({
      db, stageId: stage.id, tiedTeamIds: [teamA.id], statementMinutes: 10, actorId: admin.id, now: NOW,
    }),
    (err) => err.status === 400,
  );
  openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.throws(
    () => openTiebreakRound({
      db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
    }),
    (err) => err.status === 409,
    '同一赛段不能同时开两个轮次 —— 否则票会分散在两轮里',
  );
  cleanup(ctx);
});

test('投票给不在同分组里的队伍 → 400', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 'no-such-team', score: 80, now: NOW }),
    (err) => err.status === 400,
  );
  cleanup(ctx);
});

test('关闭轮次是幂等的（重复关闭原样返回）', () => {
  const ctx = setup();
  const { db, admin, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  const first = closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.equal(first.round.status, 'closed');
  const second = closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.equal(second.round.status, 'closed');
  cleanup(ctx);
});

test('回避中的评委不能投票（R-JDG-09）', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  db.prepare(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES ('r1', ?, ?, ?, '前雇主', 'declared', ?, ?, 'recused')`,
  ).run(stage.id, voter.id, teamA.id, NOW, admin.id);
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

test('均分：两票时 mean ≠ sum（一条票时两者恰好相同，测不出来）', () => {
  // ⚠️ 规格自带那条用例只有**一票** → mean 与 sum **恰好都是 80**，根本区分不了。
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  const voter2 = createUser(db, { name: '评委乙', phone: '13900000027', password: 'pw' });
  assignStageJudge(db, { stageId: stage.id, userId: voter2.id, seat: 'enterprise', now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter2.id, teamId: teamA.id, score: 60, now: NOW });
  const state = getTiebreakRoundState({ db, roundId: round.id });
  assert.equal(state.tallies[teamA.id].count, 2);
  assert.equal(state.tallies[teamA.id].sum, 140);
  assert.ok(Math.abs(state.tallies[teamA.id].mean - 70) < 1e-12, 'mean 必须是 (80+60)/2 = 70，不是 sum');
  cleanup(ctx);
});

test('投票给不存在的轮次 → 404（不把裸 TypeError 漏给调用方）', () => {
  const ctx = setup();
  const { db, voter, teamA } = ctx;
  assert.throws(
    () => castTiebreakVote({ db, roundId: 'no-such-round', voterId: voter.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 404,
  );
  cleanup(ctx);
});

test('投票的 UNIQUE 兜底只认「唯一约束」，其它约束错必须继续往上抛', () => {
  // ⚠️ 兜底正则若放宽成 /UNIQUE|constraint/i，「外键失败」会被误判成「重复投票」
  //    → 409 → 真实错误被伪装成幂等冲突。Task 6 已踩过一次同样的坑。
  //    这里**绕过开轮次的校验**直接插一个「同分组含幽灵队伍」的轮次，从服务层打通。
  const ctx = setup();
  const { db, voter, teamB, stage } = ctx;
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, vote_deadline, status, created_by, created_at)
     VALUES ('tr-x', ?, 'statement', ?, '2026-10-20T10:10:00.000Z', NULL, 'open', ?, ?)`,
  ).run(stage.id, JSON.stringify(['no-such-team', teamB.id]), voter.id, NOW);
  assert.throws(
    () => castTiebreakVote({ db, roundId: 'tr-x', voterId: voter.id, teamId: 'no-such-team', score: 80, now: NOW }),
    /FOREIGN KEY/i,
    '外键失败不得被当成「重复投票」',
  );
  cleanup(ctx);
});

test('开轮次时同分组里的队伍必须真实存在且属于本赛段', () => {
  const ctx = setup();
  const { db, admin, teamB, stage } = ctx;
  assert.throws(
    () => openTiebreakRound({
      db, stageId: stage.id, tiedTeamIds: ['no-such-team', teamB.id],
      statementMinutes: 10, actorId: admin.id, now: NOW,
    }),
    (err) => err.status === 400,
    '幽灵队伍不得进入同分组',
  );
  cleanup(ctx);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/tiebreak.test.js`
Expected: FAIL —— `Cannot find module '../src/services/tiebreak.js'`

- [ ] **Step 3: 创建 src/db/repo/tiebreak.js**

```javascript
// src/db/repo/tiebreak.js — 加时陈述轮次与投票
// 依据：S7 §3.3（R-JDG-19）+ 设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束
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

/**
 * 轮次列表。
 * ⚠️ 排序必须**确定**：只按 `created_at` 排是不够的 —— 同一秒开启的两个轮次
 *    `created_at` 相同，而 SQLite 的 ORDER BY 对并列行**不保证稳定** →
 *    「同一队多轮取最新一轮」就取到了哪一轮随缘 → 破同分链的结果**不可复算**。
 *    `rowid` 是隐式的插入序，作为兜底排序键（全局约定：兜底排序键一律用 rowid）。
 */
export function listTiebreakRounds(db, { stageId, status = null } = {}) {
  if (status) {
    return db
      .prepare('SELECT * FROM tiebreak_round WHERE stage_id = ? AND status = ? ORDER BY created_at, rowid')
      .all(stageId, status);
  }
  return db.prepare('SELECT * FROM tiebreak_round WHERE stage_id = ? ORDER BY created_at, rowid').all(stageId);
}

export function closeTiebreakRoundRow(db, id, now) {
  db.prepare("UPDATE tiebreak_round SET status = 'closed' WHERE id = ?").run(id);
  return getTiebreakRound(db, id);
}

/**
 * 写入一票。
 * ⛔ 依赖主键 (tiebreak_round_id, voter_id, team_id) 保证「一人一队一票」——
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 7 处修正，读代码前先看这段】
//   ① **关闭一个不存在的轮次 → 裸 TypeError 漏到调用方**：
//      `closeTiebreakRoundRow` 对不存在的 id 是 0 行受影响 → 返回 null →
//      紧接着 `round.stage_id` 抛「Cannot read properties of null」，
//      而它**不是 AppError** → HTTP 层只能回通用文案「请求无效」。现在 404。
//   ② **UNIQUE 兜底正则过宽** —— `/UNIQUE|constraint/i` 会把「外键失败」也当成
//      「重复投票」→ 409 → 真实错误被伪装成幂等冲突。收紧为只认唯一约束。
//   ③ **投票分没有 0–100 区间校验** → 1000 分进票 → 复议分破 100。
//   ④ **投票人不校验是否有投票权** —— 观察员、回避中的评委都能投票（R-JDG-09 / R-JDG-11）。
//   ⑤ **轮次排序不确定** —— 只按 `created_at` 排，而同一秒开启的两个轮次时间戳相同，
//      SQLite 的 ORDER BY 对并列行不保证稳定 → 「多轮取最新一轮」取到哪一轮随缘
//      → **破同分链的结果不可复算**。现在加 `rowid` 兜底。
//   ⑥ **未关闭的轮次也被算进复议分** —— `getTiebreakExtraScores` 取了全部轮次，
//      一个还在开放投票的轮次，其**当前均值**会被当成最终复议分消费
//      → 榜单随投票进行而漂移。现在只消费 `status='closed'` 的轮次。
//   ⑦ **开轮次不校验「同分组」是否合法** —— 可以开一个只有一支队伍的「同分」轮次；
//      同一赛段也能同时开两个 open 轮次 → 票分散在两轮里。
import {
  insertTiebreakRound,
  getTiebreakRound,
  listTiebreakRounds,
  closeTiebreakRoundRow,
  insertTiebreakVote,
  listTiebreakVotes,
} from '../db/repo/tiebreak.js';
import { getStageJudge } from '../db/repo/stages.js';
import { resolveStageRoster } from './review.js';
import { listRecusals } from '../db/repo/recusals.js';
import { checkRecusal } from '../domain/review-eligibility.js';
import { writeAuditLog } from '../audit/log.js';
import { appError } from '../errors.js';

function fail(status, code, message) {
  // ⚠️ 必须用 P0 的 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    P0 终审 I-C 的错误分支是 `err instanceof AppError ? err.message : '请求无效'` ——
  //    裸 Error 不是 AppError → message 被替换成通用文案「请求无效」。
  return appError(status, code, message);
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * 开启一轮加时陈述（S7 §3.3：10 分钟）
 *
 * ⛔ 同分组至少两支队伍（去重后）；同一赛段不允许已有 open 轮次 ——
 *    否则票会分散在两个轮次里，破同分链取到的是哪一轮随缘。
 */
export function openTiebreakRound({ db, stageId, tiedTeamIds = [], statementMinutes = 10, actorId, now }) {
  const unique = [...new Set(tiedTeamIds)];
  if (unique.length < 2) {
    throw fail(400, 'NO_TIED_TEAMS', '没有同分队伍，无需加时陈述（至少需要两支同分队伍）');
  }
  // ⛔ 同分组的队伍必须真实存在且属于本赛段 —— 否则会开出一个「指向幽灵队伍」的轮次，
  //    投票时在外键上炸（而且错误信息是原始 SQL 原文）。
  // ⚠️ P11 · E156：走 `resolveStageRoster`（赛段级优先、届期级兜底）——
  //    直接用届期级名册 ⇒ 同届期另一赛段的队伍能被拉进破同分轮次。
  const roster = new Set(resolveStageRoster(db, stageId));
  const unknown = unique.filter((id) => !roster.has(id));
  if (unknown.length) {
    throw fail(400, 'TIED_TEAM_NOT_IN_STAGE', '同分组里有队伍不属于本赛段或不存在', { unknown });
  }
  if (listTiebreakRounds(db, { stageId, status: 'open' }).length) {
    throw fail(409, 'TIEBREAK_ROUND_ALREADY_OPEN', '该赛段已有一轮进行中的加时陈述，请先关闭');
  }
  const round = insertTiebreakRound(db, {
    stageId,
    kind: 'statement',
    tiedTeamIds: unique,
    statementDeadline: addMinutes(now, statementMinutes),
    createdBy: actorId,
    now,
  });
  writeAuditLog(db, {
    actorId, action: 'tiebreak.open', entity: 'stage', entityId: stageId,
    detail: { roundId: round.id, tiedTeamIds: unique }, now,
  });
  return round;
}

/**
 * 投票（一人一队一票由数据库主键保证）
 *
 * ⛔ 投票人必须**有投票权**（R-JDG-11：观察员无投票权）且**未回避**该队（R-JDG-09）。
 */
export function castTiebreakVote({ db, roundId, voterId, teamId, score, now }) {
  const round = getTiebreakRound(db, roundId);
  if (!round) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  if (round.status !== 'open') throw fail(409, 'TIEBREAK_ROUND_CLOSED', '该轮加时陈述已关闭');

  const seat = getStageJudge(db, round.stage_id, voterId);
  if (!seat) throw fail(403, 'NOT_ASSIGNED_JUDGE', '该投票人未被分配到本赛段');
  if (seat.seat === 'observer') {
    throw fail(403, 'OBSERVER_NO_VOTE', '观察员无投票权，不能参与破同分投票');
  }
  const recusal = checkRecusal({
    judge: { userId: voterId },
    team: { teamId },
    recusalRecords: listRecusals(db, { stageId: round.stage_id, judgeId: voterId }),
  });
  if (recusal.recused) {
    throw fail(403, 'RECUSED', `该投票人已回避本队（原因：${recusal.record?.reason ?? '未填写'}）`);
  }

  const tied = JSON.parse(round.tied_team_ids_json);
  if (!tied.includes(teamId)) throw fail(400, 'TEAM_NOT_IN_TIE_GROUP', '该队伍不在同分组中');
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw fail(400, 'SCORE_OUT_OF_RANGE', '投票分必须是 0–100 之间的数字');
  }
  try {
    return insertTiebreakVote(db, { roundId, voterId, teamId, score, now });
  } catch (err) {
    // ⚠️ 只认「唯一约束」这一种失败 —— 外键失败等其他错误必须继续往上抛，
    //    否则真实错误会被伪装成「重复投票」。
    if (/UNIQUE constraint failed: tiebreak_votes/i.test(String(err.message))) {
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

/** 关闭轮次（幂等：已关闭则原样返回） */
export function closeTiebreakRound({ db, roundId, actorId, now }) {
  const existing = getTiebreakRound(db, roundId);
  if (!existing) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  const round = existing.status === 'closed' ? existing : closeTiebreakRoundRow(db, roundId, now);
  const votes = listTiebreakVotes(db, roundId);
  writeAuditLog(db, {
    actorId, action: 'tiebreak.close', entity: 'stage', entityId: round.stage_id,
    detail: { roundId, votes: votes.length }, now,
  });
  return { round, tallies: tally(votes) };
}

/**
 * 加时陈述复议分（供 P3 的破同分链 tiebreak_extra 项消费）
 *
 * ⛔ **只消费已关闭的轮次** —— 还在开放投票的轮次，其当前均值不是最终复议分，
 *    榜单不能随着投票进行而漂移。
 */
export function getTiebreakExtraScores({ db, stageId, teamIds = [] }) {
  const rounds = listTiebreakRounds(db, { stageId, status: 'closed' });
  const scores = {};
  for (const round of rounds) {
    const votes = listTiebreakVotes(db, round.id);
    const t = tally(votes);
    for (const [teamId, bucket] of Object.entries(t)) {
      if (teamIds.length && !teamIds.includes(teamId)) continue;
      // 同一队多轮取最新一轮（轮次列表已按 created_at, rowid 确定排序）
      scores[teamId] = bucket.mean;
    }
  }
  return scores;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/tiebreak.test.js`
Expected: PASS（17 个测试全过：tiebreak.test.js 17）

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
- Modify: `platform/scripts/seed.js`（新增 `self_review:write` 能力点 + 队长/组员持有；见 D-27）
- Modify: `platform/src/domain/enterprise-seat.js`（R1 收窄；见 D-30）
- Modify: `platform/src/services/review.js`（写入口的队伍边界 + 改分留痕；见 D-33 / D-36）
- Modify: `platform/src/db/repo/reviews.js`（软删除过滤；见 D-35）
- Modify: `platform/src/db/repo/teams.js`（新增 `getTeamWithPackage`；见 D-31）
- Create: `platform/test/scoring.test.js`
- Create: `platform/test/compute.test.js`
- Create: `platform/test/review-api.test.js`（9 条 API 的**权限闸门**用例；见 D-23~D-27 / D-31~D-34）

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
  - **能力点**（`scripts/seed.js` 注册）：
    | 能力点 | 持有者 | 用途 |
    |---|---|---|
    | `score:write` | 评委 / 企业 / 组委会 | 打分、签企业确认 |
    | `score:read` | 评委 / 企业 / 组委会 | 看评审进度 |
    | `peer_review:write` | 评委 / 队长 / 组员 | 互评 |
    | **`self_review:write`**（P2 新增） | **队长 / 组员** | 提交**本队**自评 |
    | `signoff:create` | 企业 / 企业管理员 | 签署企业确认（证明是出题企业） |
    | `stage:compute` | 组委会 | 触发计算发榜 / 代录回避与企业确认 |
    | `audit:read` | 评委 / 组委会 | 读取计算快照（三件套） |

- [ ] **Step 1: 写失败的测试**

`platform/test/scoring.test.js`：

```javascript
// platform/test/scoring.test.js —— scoreStage 总装
//
// 规则溯源：
//   - 「总分 = (1−w_E)×P + w_E×E，初赛 w_E=10%」→ S7 §2.1 权重表 + §3.1 评分公式
//     + 冲突裁决 C-01（rule-decisions.md）
//   - 「行为分不得影响总分」→ S10 §8 第三条风险（分轨必须在算法层，不靠纪律）
//   - 「降级必须显式」→ 设计文档 §6.2【决策】+ §12 trace 结构
//   - 「R1/R2/R3/R4」→ S7 §2.4（R-JDG-05~08）
//   - 「自评测不加分」→ S7 §4.3（R-JDG-13）
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

/** 生效权重合计（每队各自一份） */
function weightSum(perDimension) {
  return Object.values(perDimension).reduce((acc, d) => acc + d.weight, 0);
}

test('总分 = (1−w_E)×P + w_E×E，初赛 w_E = 0.10（冲突裁决 C-01）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  // 样本不足 → 退回全局口径 → 维度分退化为原始分均值
  // P = (0.10*70 + 0.20*80 + 0.20*65 + 0.25*90 + 0.15*55) / 0.90 = 66.75/0.9
  assert.ok(Math.abs(t1.seatP - 74.166666667) < 1e-6, `seatP=${t1.seatP}`);
  assert.equal(t1.seatE, 80);
  assert.ok(Math.abs(t1.total - 74.75) < 1e-6, `total=${t1.total}`);
  assert.ok(Math.abs(t1.total - (1 - 0.10) * t1.seatP - 0.10 * t1.seatE) < 1e-9);
  // 生效权重合计必须是 1（席位权重按 (1−w_E) 归一后与 w_E 拼回 100%）
  assert.ok(Math.abs(weightSum(t1.perDimension) - 1) < 1e-9, `生效权重合计=${weightSum(t1.perDimension)}`);
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
  // R3 把企业项从 0.2 封顶到 w_E=0.1 后，评委席权重必须补足到 0.9（合计仍是 1）
  assert.ok(Math.abs(weightSum(t1.perDimension) - 1) < 1e-9, `生效权重合计=${weightSum(t1.perDimension)}`);
  assert.ok(Math.abs(t1.perDimension.innovation.weight - 0.9) < 1e-9, `创新性生效权重=${t1.perDimension.innovation.weight}`);
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
  // ⛔ 关键断言：**用评委分 80，不是自评的 95** —— 自评不得加分（S7 §4.3 / S10 §8）
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.mean, 80, '自评 95 分不得进入评委席维度');
  assert.equal(t1.seatP, 80);
});

test('评委池缺失 → 记 warning，绝不静默', () => {
  const r = scoreStage({ config: CONFIG, judges: [], submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.warnings.some((w) => w.code === 'judge_roster_missing'));
});

test('⛔ 自评不得填补评委席维度（自评加分路径封堵）', () => {
  // 评委没给「创新性」打分，但队伍自己给了 95 分 —— 该维度必须**缺分**（权重记 0），
  // 而不是拿自评分顶上（S7 §4.3「不加分」+ S10 §8「自评不得成为博弈项」）。
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'track_fit', weight: 0.50, seat: 'judge' },
      { key: 'innovation', weight: 0.40, seat: 'judge' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg,
    judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'track_fit', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'track_fit', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.mean, null, '评委席维度不得由自评填补');
  assert.equal(t1.seatP, 80, '只有「赛题契合度」有分 → 席位分 = 80');
  assert.ok(r.warnings.some((w) => w.code === 'dimension_no_scores' && w.dimension === 'innovation'));
});

test('自评席维度（seat=self）取自自评记录并进 trace', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg,
    judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'self_eval', rawScore: 88 }],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, 88);
  assert.equal(t1.perDimension.self_eval.raw, 88);
  assert.equal(t1.perDimension.self_eval.z, null);
  // P = (0.80*80 + 0.10*88) / 0.90 = 72.8/0.9
  assert.ok(Math.abs(t1.seatP - 80.888888888) < 1e-6, `seatP=${t1.seatP}`);
});

test('自评席维度缺自评记录 → 该维度缺分（权重记 0）+ warning', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg,
    judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, null);
  assert.ok(r.warnings.some((w) => w.code === 'dimension_no_scores' && w.dimension === 'self_eval'));
});

test('⛔ 观察员无投票权（R-JDG-11）：观察员的打分不计入', () => {
  // 观察员给 100 分、评委给 80 分 —— 维度分必须是 80（不是 90）
  const r = scoreStage({
    config: CONFIG,
    judges: [{ judgeId: 'j1', seat: 'judge' }, { judgeId: 'obs', seat: 'observer' }],
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'obs', teamId: 't1', dimension: 'innovation', rawScore: 100 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.mean, 80, '观察员的分不得计入');
});

test('⛔ R4：自由命题组无企业签字 → 企业项改由评委的「需求真实性」维度替代', () => {
  const dims = ['innovation', 'feasibility', 'completeness', 'collaboration'];
  const subs = [];
  for (const dim of dims) {
    subs.push({ judgeId: 'j1', teamId: 'tFree', dimension: dim, rawScore: 70 });
    subs.push({ judgeId: 'j2', teamId: 'tFree', dimension: dim, rawScore: 70 });
  }
  subs.push({ judgeId: 'j1', teamId: 'tFree', dimension: 'track_fit', rawScore: 70 });
  subs.push({ judgeId: 'j2', teamId: 'tFree', dimension: 'track_fit', rawScore: 80 });

  const r = scoreStage({
    config: CONFIG,
    judges: JUDGES,
    submissions: subs,
    enterpriseConfirmations: [],
    teams: [{ teamId: 'tFree', packageEnterpriseId: null, isFreeBrief: true }],
  });
  const t = r.teams.find((x) => x.teamId === 'tFree');
  assert.ok(r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored'), '必须显式记 R4');
  // 企业项由评委的 track_fit 分替代（(70+80)/2 = 75）
  assert.equal(t.perDimension.enterprise.mean, 75, '企业项须由评委的替代维度分填充');
  assert.equal(t.perDimension.track_fit.weight, 0, '替代维度要从评委席移出，避免双重计分');
  assert.ok(Math.abs(weightSum(t.perDimension) - 1) < 1e-9);
  // 总分 = 0.9×70 + 0.1×75 = 70.5
  assert.ok(Math.abs(t.total - 70.5) < 1e-6, `total=${t.total}`);
});

test('perDimension.raw 必须是原始分（不是 z 值）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.raw, 80, '创新性原始分 = (90+70)/2');
  assert.equal(t1.perDimension.completeness.raw, 90, '完成度原始分 = (100+80)/2');
  assert.equal(t1.perDimension.enterprise.raw, 80, '企业项的 raw 就是企业确认分');
});

test('没有任何 P 席评分的队伍 → 记 team_no_reviews（不参与排名）', () => {
  const r = scoreStage({
    config: CONFIG,
    judges: JUDGES,
    submissions: [],
    enterpriseConfirmations: [],
    teams: [
      { teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false },
      { teamId: 't2', packageEnterpriseId: 'E1', isFreeBrief: false },
    ],
  });
  const warned = r.warnings.filter((w) => w.code === 'team_no_reviews').map((w) => w.teamId).sort();
  assert.deepEqual(warned, ['t1', 't2'], '两支队都没有评委分 → 都应标记不参与排名');
});

test('⛔ 冒名的非本赛道确认不得连坐掉本赛道企业的合法签字（D-30）', () => {
  // 一条「非本赛道企业」的**有效**双签 + 本赛道企业的合法双签同时存在：
  // 本赛道企业对自己出的题签字是天经地义的，不能被别人的一条记录废掉。
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [
      CONFIRMATIONS[0],
      { teamId: 't1', enterpriseId: 'E9', dimension: 'enterprise', rawScore: 100, crossJudgeId: 'j2', signatoryUserId: 'u_e9', content: '冒名' },
    ],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 80, '本赛道企业的合法签字必须保留');
  assert.ok(r.warnings.some((w) => w.code === 'R1_out_of_track'), '仍然要留下 R1 告警（不能静默）');
  assert.ok(Math.abs(weightSum(t1.perDimension) - 1) < 1e-9, '企业项权重不得被归零');
});

test('⛔ 自评席维度高于评委席分 10 分以上 → 对齐到评委席分（不加分）', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg, judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'self_eval', rawScore: 95 }], // 95 − 80 = 15 > 10
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, 80, '自评 95 必须对齐到评委席分 80（不加分）');
  assert.ok(r.warnings.some((w) => w.code === 'self_eval_written_explanation'));
});

test('⛔ 评委打分不得填自评席维度（领域层第二道防线）', () => {
  // 即使写入口被绕过（服务层直调），领域层也绝不能让评委的打分填进自评席维度。
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg, judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j1', teamId: 't1', dimension: 'self_eval', rawScore: 100 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, null, '评委的打分不得填自评席维度');
  assert.ok(r.warnings.some((w) => w.code === 'dimension_no_scores' && w.dimension === 'self_eval'));
});

test('⛔ R4 替代维度没有评委分 → 必须显式告警（不能静默丢 20%）', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 'tFree', dimension: 'innovation', rawScore: 70 },
      { judgeId: 'j2', teamId: 'tFree', dimension: 'innovation', rawScore: 70 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 'tFree', packageEnterpriseId: null, isFreeBrief: true }],
  });
  const t = r.teams.find((x) => x.teamId === 'tFree');
  assert.equal(t.perDimension.enterprise.mean, 0, '替代维度无分 → 企业项按 0 分计');
  assert.ok(
    r.warnings.some((w) => w.code === 'R4_substitute_no_scores' && w.teamId === 'tFree'),
    '必须显式说明替代维度没有评委分',
  );
});

test('⛔ 无效的非本赛道记录不得触发 R1 把企业权重归零（D-30）', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [
      // 非本赛道企业 + 缺双签（**无效**）→ 不得把企业项权重归零
      { teamId: 't1', enterpriseId: 'E9', dimension: 'enterprise', rawScore: 100, crossJudgeId: null, signatoryUserId: 'u_e9', content: '冒名' },
    ],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 0, '没有有效的企业确认 → 企业席 0 分');
  assert.ok(!r.warnings.some((w) => w.code === 'R1_out_of_track'), '无效记录不得触发 R1');
  assert.ok(
    Math.abs(t1.total - 0.9 * t1.seatP) < 1e-9,
    '无效记录不得把企业项权重归零（归零后总分会从 0.9×P 变成 P）',
  );
});
```

`platform/test/review-api.test.js`（9 条 API 的**权限闸门**用例；本轮预审新增）：

```javascript
// platform/test/review-api.test.js —— 评审 API 的权限闸门
//
// 规则溯源：
//   - 「权限模型 = capability + assignment，can() 是唯一判定入口」→ 设计文档 §7.1/§7.2
//   - 「三态状态码」→ 设计文档 §7.3（禁用 → 403；单条不存在 → 404）
//   - 「回避必须留档、不能代他人申报」→ S7 §2.4 R5（R-JDG-09）
//   - 「企业签字必须有内容 + 双签」→ S7 §4.1（R-JDG-06 / R-JDG-14）
//   - 「自评不加分、只能本队提交」→ S7 §4.3（R-JDG-13）
//
// ⚠️ 这些闸门一旦没有测试钉住，就会**静默失效**（能力点形同虚设、越权可写入分数）——
//    与 P1 Task 3 的 A1（registration:write 被注册却从不校验）同一类病根。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['peer_review:write', '互评'],
  ['self_review:write', '提交本队自评'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['signoff:create', '企业签字'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-revapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000041', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000042', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000043', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900000044', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000045', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000046', password: 'pw' });
  const enterprise2 = createUser(db, { name: '别家企业', phone: '13900000048', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(judge.id, 'audit:read');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(captain.id, 'self_review:write');
  grant(captain.id, 'peer_review:write');
  // 企业席要 score:write（企业确认就是企业席分）+ signoff:create（证明是出题企业）
  // —— 与 seed 的 enterprise 角色一致
  grant(enterprise.id, 'score:write');
  grant(enterprise.id, 'signoff:create');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  // 第二支队的任务包属于**别家企业** —— 用来验「企业只能给自己出的题签字」
  const pkg2 = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise2.id, enterpriseName: '别家企业',
    title: '门店排班', painPoint: '排班靠人肉',
    expectedDelivery: '可用的排班建议', acceptanceCriteria: '能给出人力节省测算',
    submittedBy: admin.id, now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg2.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: captain.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, judge, judge2, admin, enterprise, enterprise2, captain, outsider, team1, team2, stage,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenCaptain: createSession(db, captain.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

test('未登录提交评分 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('有能力点但**不是**该赛段评委 → 403（NOT_ASSIGNED_JUDGE）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('评委提交打分 → 200', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).submitted, 1);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能代他人申报回避（打分 sabotage）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenJudge,
    body: { judgeId: s.judge2.id, teamId: s.team1.id, reason: '投资方' },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 确认没有落库
  const rows = s.db.prepare('SELECT * FROM recusal_records WHERE stage_id = ?').all(s.stage.id);
  assert.equal(rows.length, 0, '被拒绝的回避申报不得留下记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('评委为自己申报回避 → 200（本人可申报）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenJudge,
    body: { teamId: s.team1.id, reason: '前雇主' },
  });
  assert.equal(res.status, 200);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能冒名签企业确认（企业项占初赛 10% / 决赛 25% 权重）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenJudge,
    body: {
      teamId: s.team1.id, enterpriseId: s.enterprise.id, rawScore: 100,
      crossJudgeId: s.judge2.id, content: '我们认可这支队伍',
    },
  });
  assert.equal(res.status, 403);
  const rows = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ?').all(s.stage.id);
  assert.equal(rows.length, 0, '被拒绝的企业确认不得落库');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('出题企业为自己签确认 → 200；跨领域评委不在名单 → 404', async () => {
  const s = setup();
  const bad = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, rawScore: 90,
      crossJudgeId: s.captain.id, content: '解决了我方库存周转环节',
    },
  });
  assert.equal(bad.status, 404, '跨领域评委必须在本赛段名单里');
  assert.equal(JSON.parse(bad.body).error.code, 'JUDGE_NOT_ASSIGNED');

  const ok = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '解决了我方库存周转环节',
    },
  });
  assert.equal(ok.status, 200);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能替别的队伍交自评（自评加分路径）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/self-review`, {
    token: s.tokenJudge,
    body: { teamId: s.team1.id, items: [{ dimension: 'self_eval', rawScore: 95 }] },
  });
  assert.equal(res.status, 403, '评委连自评能力点都没有，先被能力点拦下');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 队长不能替别的队伍交自评', async () => {
  const s = setup();
  const other = insertTeam(s.db, {
    editionId: s.stage.edition_id, name: '二队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/self-review`, {
    token: s.tokenCaptain,
    body: { teamId: other.id, items: [{ dimension: 'self_eval', rawScore: 95 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_TEAM_MEMBER');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('队长为本队交自评 → 200', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/self-review`, {
    token: s.tokenCaptain,
    body: { teamId: s.team1.id, items: [{ dimension: 'self_eval', rawScore: 90 }] },
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).submitted, 1);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 互评必须由本队成员发起', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/peer-reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ fromTeamId: '别人的队', toTeamId: s.team1.id, score: 80 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_TEAM_MEMBER');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('compute 权限：评委 403 / 组委会 200', async () => {
  const s = setup();
  const denied = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenJudge });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.body).error.code, 'FORBIDDEN');

  const allowed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
  assert.equal(allowed.status, 200);
  const body = JSON.parse(allowed.body);
  assert.ok(body.computationId);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 计算快照不得跨赛段读取（404）', async () => {
  const s = setup();
  const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
  const computationId = JSON.parse(computed.body).computationId;

  const other = insertStage(s.db, {
    editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-11-01', endsAt: '2026-11-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  const res = await call(s.app, 'GET', `/api/stages/${other.id}/computations/${computationId}`, {
    token: s.tokenAdmin,
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'COMPUTATION_NOT_FOUND');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 跨领域评委不能与出题企业签字人相同（双签必须真是两个人）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, rawScore: 90,
      crossJudgeId: s.enterprise.id, content: '自己给自己当跨领域评委',
    },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'CROSS_JUDGE_SAME_AS_SIGNATORY');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('赛段级作用域授权可用（不只是全局授权）', async () => {
  const s = setup();
  // 另建一个赛段 + 一个只在 s1 上有 score:write 授权的评委
  const scopedJudge = createUser(s.db, { name: '赛段评委', phone: '13900000047', password: 'pw' });
  assignStageJudge(s.db, { stageId: s.stage.id, userId: scopedJudge.id, seat: 'judge', now: NOW });
  grantAssignment(s.db, {
    userId: scopedJudge.id, capability: 'score:write', scopeType: 'stage', scopeId: s.stage.id, grantedBy: s.admin.id,
  });
  const token = createSession(s.db, scopedJudge.id).token;

  const ok = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 70 }] },
  });
  assert.equal(ok.status, 200, '赛段级授权必须被认');

  // 换一个赛段 → 该授权不覆盖 → 403
  const other = insertStage(s.db, {
    editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-11-01', endsAt: '2026-11-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  const denied = await call(s.app, 'POST', `/api/stages/${other.id}/reviews`, {
    token,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 70 }] },
  });
  assert.equal(denied.status, 403, '赛段级授权不得跨赛段生效');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('没有能力的账号 → 403（三态：禁用 → 403，不是 404）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenOutsider,
    body: { items: [] },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能以自己名义替别人家的队签企业确认（C1：连坐作废对手的企业席）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenJudge,
    body: {
      teamId: s.team1.id, enterpriseId: s.judge.id, rawScore: 100,
      crossJudgeId: s.judge2.id, content: '我替这家签了',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(
    s.db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE stage_id = ?').get(s.stage.id).n,
    0,
    '被拒绝的冒名确认不得落库（否则会连坐掉受害队伍的企业席）',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 评委不能给名册外的队伍打分（外队进榜）', async () => {
  const s = setup();
  // 另一个届期的队伍：不在本赛段名册内
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(s.db, {
    editionId: otherEdition.id, name: '外队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: outsider.id, dimension: 'innovation', rawScore: 99 }] },
  });
  assert.equal(res.status, 404, '名册外的队伍 → 404（不是 500）');
  assert.equal(JSON.parse(res.body).error.code, 'TEAM_NOT_IN_STAGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 评委不能给自评席维度打分（绕过「自评只能本队成员」）', async () => {
  const s = setup();
  // 决赛权重表里「自评测」是 seat=self 的维度
  const finalStage = insertStage(s.db, {
    editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-11-01', endsAt: '2026-11-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(s.db, { stageId: finalStage.id, userId: s.judge.id, seat: 'judge', now: NOW });
  const res = await call(s.app, 'POST', `/api/stages/${finalStage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'self_eval', rawScore: 100 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'DIMENSION_SEAT_FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 回避对象不在本赛段名单 → 404', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenAdmin,
    body: { judgeId: s.outsider.id, teamId: s.team1.id, reason: '投资方' },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'JUDGE_NOT_ASSIGNED');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 有能力点但不是本赛段评委 → 403 NOT_ASSIGNED_JUDGE', async () => {
  const s = setup();
  // 给队长发 score:write：他有能力点，但不是本赛段评委
  insertCapability(s.db, 'score:write', '写入评分');
  grantAssignment(s.db, {
    userId: s.captain.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: s.admin.id,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_ASSIGNED_JUDGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 企业席只能给自己出的题签字（别家企业的队 → 403）', async () => {
  const s = setup();
  // 授予企业席能力（signoff:create）—— 闸门 N02 通过，但 N03（是不是你出的题）不通过
  insertCapability(s.db, 'signoff:create', '企业签字');
  grantAssignment(s.db, {
    userId: s.enterprise.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: s.admin.id,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team2.id, rawScore: 100,
      crossJudgeId: s.judge2.id, content: '我给别家企业的队也签一个',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(
    s.db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE stage_id = ?').get(s.stage.id).n,
    0,
    '被拒绝的确认不得落库',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 签字人必须与请求里的 enterpriseId 一致（不能顶着别人的名义签）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, enterpriseId: s.enterprise2.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '顶着别家的名义签',
    },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 企业确认不得签名册外的队伍', async () => {
  const s = setup();
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsiderTeam = insertTeam(s.db, {
    editionId: otherEdition.id, name: '外队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: outsiderTeam.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '外队确认',
    },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TEAM_NOT_IN_STAGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 改分必须把旧分写进审计（事后能还原当时榜单）', async () => {
  const s = setup();
  const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(first.status, 200);
  await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 85 }] },
  });
  const rows = s.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY rowid').all('review.submit');
  const last = JSON.parse(rows[rows.length - 1].detail_json);
  assert.ok(Array.isArray(last.changed) && last.changed.length === 1, '改分必须留痕');
  assert.equal(last.changed[0].from, 80);
  assert.equal(last.changed[0].to, 85);
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 没有评审权限的人读不到评审进度', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', `/api/stages/${s.stage.id}/review-state`, {
    token: s.tokenOutsider,
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 互评的被评队不在名册内 → 404', async () => {
  const s = setup();
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsiderTeam = insertTeam(s.db, {
    editionId: otherEdition.id, name: '外队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/peer-reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ fromTeamId: s.team1.id, toTeamId: outsiderTeam.id, score: 80 }] },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TEAM_NOT_IN_STAGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 请求里的 signatoryUserId 与出题企业不符 → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, signatoryUserId: s.judge2.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '签字人写成了别人',
    },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 不是企业席的人不能签企业确认（哪怕他就是出题企业）', async () => {
  const s = setup();
  // 一支任务包属于 outsider 的队伍；outsider 有 score:write，但**没有** signoff:create
  const pkg3 = createTaskPackage(s.db, {
    editionId: s.stage.edition_id, enterpriseId: s.outsider.id, enterpriseName: '某企业',
    title: '别的题', painPoint: '痛点',
    expectedDelivery: '交付物', acceptanceCriteria: '验收标准',
    submittedBy: s.admin.id, now: NOW,
  });
  const team3 = insertTeam(s.db, {
    editionId: s.stage.edition_id, name: '三队', captainId: s.admin.id, taskPackageId: pkg3.id, status: 'active', now: NOW,
  });
  insertCapability(s.db, 'score:write', '写入评分');
  grantAssignment(s.db, {
    userId: s.outsider.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: s.admin.id,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenOutsider,
    body: {
      teamId: team3.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '我出的题我签',
    },
  });
  assert.equal(res.status, 403, '不是企业席 → 403');
  assert.equal(
    s.db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE stage_id = ?').get(s.stage.id).n,
    0,
  );
  s.close();
  rmSync(s.dataDir, { recursive: true });
});
```

`platform/test/compute.test.js`：

```javascript
// platform/test/compute.test.js —— computeStage 计算快照 + 评审路由
//
// 规则溯源：
//   - 「compute 是显式动作，产出 input+output+trace 三件套」→ 设计文档 §8【决策】+ §12
//   - 「rank / points 留给 P3」→ 设计文档 §6.2 + INTERFACES.md §3
//   - 「回避的评委不打分不计入」→ S7 §2.4 R5（R-JDG-09）
//   - 「企业确认进总分」→ S7 §4.1（R-JDG-05/06）
//
// ⚠️ 夹具纪律：迁移 003 补齐了 38 条引用型外键，**所有 id 必须是真实行**
//    （不能再用 'ed1' / 't1' 这类假 id —— 那样夹具会掩盖孤儿行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertEnterpriseConfirmation } from '../src/db/repo/enterprise-confirmations.js';
import { insertPeerReview } from '../src/db/repo/peer-reviews.js';
import { insertRecusal } from '../src/db/repo/recusals.js';
import { loadRules } from '../src/config.js';
import { computeStage, getComputation } from '../src/services/compute.js';
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

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000031', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000035', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000032', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900000033', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000034', password: 'pw' });

  const pkg = createTaskPackage(db, {
    editionId: edition.id,
    enterpriseId: enterprise.id,
    enterpriseName: '某某企业',
    title: '库存周转',
    painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型',
    acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id,
    now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  // ⚠️ 必须走 assignStageJudge：它会**同时**写利益冲突声明并回填 stage_judges
  //    （R-JDG-18；直插 stage_judges 会绕过这条接线，测试就再也拦不住它坏掉）。
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  return { db, close, dataDir, rules, judge, judge2, admin, enterprise, captain, team1, team2, stage };
}

test('computeStage 写快照三件套 + stage_results', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
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

  const row = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id);
  assert.equal(row.computation_id, res.computationId);
  assert.equal(row.rank, null, '名次由 P3 填');
  assert.equal(row.points, null, '积分由 P3 填');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重算后 stage_results 必须指向最新一次计算', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  const a = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const b = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const row = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id);
  assert.equal(row.computation_id, b.computationId, '结果行必须跟着最新一次计算走');
  assert.notEqual(row.computation_id, a.computationId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复 compute → revision 递增（可复算的历史留档）', () => {
  const { db, close, dataDir, rules, admin, stage } = setup();
  const a = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const b = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const revs = db.prepare('SELECT revision FROM computation_snapshots ORDER BY revision').all().map((r) => r.revision);
  assert.deepEqual(revs, [1, 2]);
  assert.notEqual(a.computationId, b.computationId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('compute 必须写审计日志（action=stage.compute）', () => {
  const { db, close, dataDir, rules, admin, stage } = setup();
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const row = db.prepare('SELECT * FROM audit_log WHERE action = ? AND entity_id = ?').get('stage.compute', stage.id);
  assert.ok(row, '计算是显式动作，必须留下操作者与时间戳');
  assert.equal(row.actor_id, admin.id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('compute 路由已注册且计算快照可读', () => {
  const { db, close, dataDir } = setup();
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

test('⛔ 企业确认必须真的进总分（仓储 snake_case → 领域 camelCase 映射）', () => {
  const { db, close, dataDir, rules, admin, judge, judge2, enterprise, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertEnterpriseConfirmation(db, {
    stageId: stage.id, teamId: team1.id, enterpriseId: enterprise.id, dimension: 'enterprise',
    rawScore: 90, crossJudgeId: judge2.id, signatoryUserId: enterprise.id, content: '解决库存周转环节', now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const t1 = res.teams.find((t) => t.teamId === team1.id);
  assert.equal(t1.seatE, 90, '企业确认分必须进入企业席');
  assert.ok(!res.warnings.some((w) => w.code === 'no_enterprise_confirmation' && w.teamId === team1.id),
    '有有效企业确认却报「没有企业确认」说明映射断了');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 没有任何评分的队伍不写 stage_results（不参与排名）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, team2, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  assert.ok(db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id));
  assert.equal(
    db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team2.id),
    undefined,
    '没被任何评委打分的队不该有结果行（否则会以 0 分被排进榜单）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 回避的评委其打分不计入本次计算', () => {
  const { db, close, dataDir, rules, admin, judge, judge2, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertReview(db, {
    stageId: stage.id, judgeId: judge2.id, teamId: team1.id, dimension: 'innovation', rawScore: 20, now: NOW,
  });
  insertRecusal(db, {
    stageId: stage.id, judgeId: judge2.id, teamId: team1.id, reason: '投资方', source: 'declared', action: 'recused', now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const t1 = res.teams.find((t) => t.teamId === team1.id);
  assert.ok(Math.abs(t1.seatP - 80) < 1e-6, `seatP=${t1.seatP}（回避后只剩评委甲的 80 分）`);
  assert.ok(res.warnings.some((w) => w.code === 'recusal_excluded'));
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 计算快照不得跨赛段读取（D-26）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  // 本赛段读得到
  const ok = getComputation({ db, id: res.computationId, stageId: stage.id });
  assert.equal(ok.id, res.computationId);

  // 换一个赛段读 → 404（不是「找到但不给看」）
  assert.throws(
    () => getComputation({ db, id: res.computationId, stageId: 'other-stage' }),
    (err) => err.status === 404 && err.code === 'COMPUTATION_NOT_FOUND',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 互评分必须进 trace.perTeam.peerScore（破同分链的输入）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, team2, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertPeerReview(db, {
    stageId: stage.id, fromTeamId: team2.id, toTeamId: team1.id, score: 70, now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  assert.equal(res.trace.perTeam[team1.id].peerScore, 70, '互评分必须落在被评队的 trace 上');
  assert.equal(res.trace.perTeam[team2.id].peerScore, null, '发起方不因此拿到互评分');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 快照的 input 必须含原始打分（可复算的载体）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const snap = db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(res.computationId);
  const input = JSON.parse(snap.input_json);
  assert.equal(input.submissions.length, 1, 'input 必须带原始打分，否则无法从快照重放');
  assert.equal(input.submissions[0].rawScore, 80);
  assert.ok(input.config, 'input 必须带生效的权重表');
  assert.ok(input.ruleVersion);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ compute 中途失败 → 整体回滚（不留半成品快照与结果行）', () => {
  const { db, close, dataDir, rules, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  // actor_id 有外键 → 用一个不存在的用户当操作者，让审计写入失败
  assert.throws(
    () => computeStage({ db, stageId: stage.id, actorId: '不存在的用户', now: NOW, rules }),
    (err) => /FOREIGN KEY/i.test(String(err.message)),
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM computation_snapshots WHERE stage_id = ?').get(stage.id).n,
    0,
    '失败的事务不能留下快照',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM stage_results WHERE stage_id = ?').get(stage.id).n,
    0,
    '失败的事务不能留下结果行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computeStage 对不存在的赛段 → 404', () => {
  const { db, close, dataDir, rules, admin } = setup();
  assert.throws(
    () => computeStage({ db, stageId: 'nope', actorId: admin.id, now: NOW, rules }),
    (err) => err.status === 404 && err.code === 'STAGE_NOT_FOUND',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computeStage 缺规则 → 500（绝不用默认值凑一个榜单）', () => {
  const { db, close, dataDir, admin, stage } = setup();
  assert.throws(
    () => computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules: {} }),
    (err) => err.status === 500 && err.code === 'RULES_MISSING',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 重算必须清空旧名次/积分，并删掉本轮已无评分的旧结果行', () => {
  const { db, close, dataDir, rules, admin, judge, team1, team2, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team2.id, dimension: 'innovation', rawScore: 60, now: NOW,
  });
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  // 模拟 P3 已经发过榜（名次 / 积分已填）
  db.prepare('UPDATE stage_results SET rank = 1, tied_with = 2, points = 99 WHERE stage_id = ?').run(stage.id);

  // 把二队的打分撤掉 → 重算
  // 软删除（评分只增不改，删除用软删除）—— 软删掉的分不得再计入计算
  db.prepare('UPDATE stage_reviews SET deleted_at = ? WHERE stage_id = ? AND team_id = ?').run(NOW, stage.id, team2.id);
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  const row1 = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id);
  assert.equal(row1.rank, null, '重算后名次必须回到 NULL（由 P3 重新填）');
  assert.equal(row1.points, null, '重算后积分必须回到 NULL');
  assert.equal(row1.tied_with, null);
  assert.equal(
    db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team2.id),
    undefined,
    '本轮已无评分的队伍必须从结果表里消失（否则会以旧总分留在榜单上）',
  );
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
//
// 【告警文案分层 2026-10-23 —— 本文件产出的每条 warning 都是两层】
//   { code, message, detail?, ...原有字段 }
//   ⛔ **触发条件与口径一个字没改**（那是 P2 的计算逻辑，有大量测试钉着）；
//      这一轮只改【文案怎么分层】：
//   ① `message` —— **只给人读**。禁止出现英文维度键（feasibility / self_eval …）、
//      队伍 id、评委 id、内部原因码（partial:judge_sample_too_small …）。
//      维度中文名取 config.dimensions[].name（取不到就不写维度名，**不许退回英文 key**）。
//   ② `detail` —— **内部明细**（评委 id + 原因码、队伍 id、原始片段），
//      只给有 `audit:read` 的人看 ⇒ 由 API 层（src/services/leaderboard.js）裁剪。
//   ③ `code` —— **保留**（审计与机器判据要用），只是前端不再把它当正文渲染。
//   ⚠️ 队伍名领域层取不到（纯函数没有 db；SQL 只能写在 src/db/repo/）⇒ 正文不写队伍名。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 4 处修正，读代码前先看这段】
//   ① **自评能填补评委席维度 → 自评加分路径**（本文件最严重的一处）。
//      原实现里，评委席维度若没有评委打分，会去 `selfReviews` 里找同维度的自评记录顶上；
//      「精确命中」分支还完全绕过了对齐规则（自评 95 分 / 评委 80 分 → 直接用 95 分进榜）。
//      这与 R-JDG-13「不成立则自评分对齐评委分（**不加分**）」和 S10 §8「自评不得变成加分项」
//      直接冲突 —— 团队可以自己给自己加分。
//      现在：**评委席维度只由评委打分**；评委没打分就是没打分（该维度权重记 0 + warning）。
//      自评记录只能填 **seat='self'** 的维度。
//   ② **对齐规则在「精确命中」分支失效**（同 ① 的另一面）。
//      现在自评维度的取值也走同一套对齐判定：命中 `written_explanation` 时改用评委分。
//   ③ **自评席维度的分写回了 `dimScores`** → 污染后续队伍的 `perDimension`，
//      且让「评委分」查表可能取到**别的队伍的自评分**。
//      现在自评席维度单独放在 `selfDimScores`，与评委维度的 `dimScores` 完全隔离。
//   ④ **「没有任何评分」判定被企业席污染** → `team_no_reviews` 永远不会触发，
//      任何在名册里的队都会拿到一条 total=0 的结果行（进而被排进榜单）。
//      现在「是否参评」只看 **P 席**（评委席 + 自评席）有没有分。

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

/** 按维度权重取加权平均（只算有分的维度）；一个都没有 → null */
function weightedAverage(scores, dims) {
  let num = 0;
  let den = 0;
  for (const d of dims) {
    const v = scores[d.key];
    if (!Number.isFinite(v)) continue;
    num += d.weight * v;
    den += d.weight;
  }
  return den > 0 ? num / den : null;
}

/**
 * 维度 key → 中文名（config.dimensions[].name）。
 * ⚠️ 取不到就返回 **null**，**不许退回英文 key**：
 *    告警正文是给人读的（公开榜单页会把它们原样展示给每一个访客），
 *    英文维度键（feasibility / self_eval …）属于**内部标识**，
 *    出现在正文里等于把内部工作语言摊给所有人。
 * @returns {string|null}
 */
function dimensionLabel(dimensions, key) {
  const hit = (Array.isArray(dimensions) ? dimensions : []).find((d) => d.key === key);
  const name = hit?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * 分差取 2 位小数（去掉浮点噪声）。
 * ⚠️ 为什么不用 toFixed(2)：toFixed 会补零（15.20），而 15.200000000000003
 *    这种二进制误差的正解是「四舍五入到 2 位小数」⇒ 15.2（见 S-5 文案层）。
 * @returns {string} 便于直接拼进文案（不会把 15.200000000000003 漏给人看）
 */
function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100);
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
  const selfSeatKeys = selfDims.map((d) => d.key);
  const pSeatKeys = [...judgeDims.map((d) => d.key), ...selfSeatKeys];
  const selfSeatKeySet = new Set(selfSeatKeys);
  const selfThreshold = config.selfEvalThreshold ?? 10;

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
  // dimScores 只装**评委席**维度；自评席维度另装 selfDimScores（父代理预审修正 ③）
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
      const label = dimensionLabel(dimensions, dim);
      warnings.push({
        code: 'normalization_fallback',
        // ⚠️ 文案分层（S-5 / C-05 的「显式展示」不变）：
        //    正文只给人话 —— 英文维度键与「评委 id : 原因码」是**内部明细**，进 detail。
        message: label
          ? `维度「${label}」的评委宽严归一化已降级 —— 本维度未按评委宽严做校正`
          : '相关维度的评委宽严归一化已降级 —— 本维度未按评委宽严做校正',
        detail: `降级明细（评委 id : 原因码）：${degraded}`,
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
          // ⚠️ round2：${flag.d} 是二进制浮点差值，直接拼会露出 15.200000000000003。
          message: `自评分比评委分高 ${round2(flag.d)} 分，须提交书面说明；不成立则自评分对齐评委分（不加分）`,
          detail: `队伍 ${flag.teamId} / 维度 ${flag.dimension}：自评分与评委分相差 ${round2(flag.d)} 分`,
          teamId: flag.teamId,
          dimension: flag.dimension,
        });
      } else {
        warnings.push({
          code: 'self_eval_judge_question',
          message: `自评分比评委分低 ${round2(Math.abs(flag.d))} 分，评委须向团队提问（只提问，不改分）`,
          detail: `队伍 ${flag.teamId} / 维度 ${flag.dimension}：自评分与评委分相差 ${round2(flag.d)} 分`,
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

  // 自评席维度的分（与评委维度隔离，父代理预审修正 ③）
  const selfDimScores = new Map(); // dim -> Map(teamId -> { score, zMean, z, raw })
  // 每队的席位权重分母（seatP 的真实分母）
  const seatWeightSums = new Map();

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
      if (substitute === 0 && !dimScores.get(r4.dimension)?.has(teamId)) {
        // ⚠️ 父代理预审修正（Important，I4）：替代维度**没有评委分**时，
        //    企业席会静默变成 0 分（自由命题组白丢 20%），而告警却写着
        //    「改由评委打分」—— 队伍和组委会都看不出来少了这一块。
        //    现在必须显式说清楚：替代维度没分，企业项按 0 分计。
        const r4Label = dimensionLabel(dimensions, r4.dimension);
        warnings.push({
          code: 'R4_substitute_no_scores',
          message: r4Label
            ? `自由命题组触发 R4，但替代维度「${r4Label}」上该队没有任何评委打分，企业项按 0 分计`
            : '自由命题组触发 R4，但替代维度上该队没有任何评委打分，企业项按 0 分计',
          detail: `队伍 ${teamId} / 替代维度 ${r4.dimension}`,
          teamId,
          dimension: r4.dimension,
        });
      }
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

    // ── 评委席维度：只由评委打分 ────────────────────────────────────
    // ⛔ 自评**永不**填补评委席维度（父代理预审修正 ①）；
    //    ⛔ 而且自评席维度**绝不能**取评委打分记录（父代理预审修正 ⑤）：
    //    评委若能对 `seat='self'` 的维度打分，就能把「自评只能本队成员提交」
    //    这道闸门整个绕过去 —— 评委自己填 100 分，自评栏就归他了。
    for (const k of pSeatKeys) {
      if (selfSeatKeySet.has(k)) continue;
      const cell = dimScores.get(k)?.get(teamId);
      if (cell) pScores[k] = cell.score;
      // 评委没打分就是没打分 —— 该维度权重记 0，并由 seatScore().missing 统一出 warning。
    }

    // 评委席（不含自评席）的加权分 —— 自评席维度的对照基准（R-JDG-13 同一尺度）
    const judgeSeatAvg = weightedAverage(pScores, judgeDims);

    // ── 自评席维度 ─────────────────────────────────────────────────
    for (const k of selfSeatKeys) {
      const selfRows = selfReviews.filter((r) => r.teamId === teamId);
      const exact = selfRows.find((r) => r.dimension === k);
      if (exact) {
        const raw = exact.rawScore;
        // ⛔ D-29：自评分必须与「该队评委席分」比 —— 高出阈值就对齐（**不加分**）。
        //    自评席维度没有同维度的评委分可比，若放任不管，队伍把自评维度填到 100
        //    就是白拿 5% 的加权分 —— 正是 S7 §4.3 说的「一旦自评可以加分，它就变成了纯粹的博弈项」。
        if (judgeSeatAvg != null) {
          const d = raw - judgeSeatAvg;
          if (d > selfThreshold) {
            pScores[k] = judgeSeatAvg;
            warnings.push({
              code: 'self_eval_written_explanation',
              message: `自评分比评委席分高 ${round2(d)} 分，须提交书面说明；不成立则自评分对齐评委席分（不加分）`,
              detail: `队伍 ${teamId} / 维度 ${k}：自评分与评委席分相差 ${round2(d)} 分`,
              teamId,
              dimension: k,
            });
            continue;
          }
          if (d < -selfThreshold) {
            warnings.push({
              code: 'self_eval_judge_question',
              message: `自评分比评委席分低 ${round2(Math.abs(d))} 分，评委须向团队提问（只提问，不改分）`,
              detail: `队伍 ${teamId} / 维度 ${k}：自评分与评委席分相差 ${round2(d)} 分`,
              teamId,
              dimension: k,
            });
          }
        }
        pScores[k] = raw;
      } else {
        // 没有该维度的自评 → 用「本队对评委维度的自评」加权平均（命中对齐的用评委分）
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
      }
    }

    // ⚠️ seatScore 的权重必须【只含本席位】的维度，否则另一席位的维度会被算成 missing
    const pWeights = {};
    for (const k of pSeatKeys) pWeights[k] = effW[k] ?? 0;
    const pSeat = seatScore({ dimensionScores: pScores, weights: pWeights });
    for (const missing of pSeat.missing) {
      const missingLabel = dimensionLabel(dimensions, missing);
      warnings.push({
        code: 'dimension_no_scores',
        // ⚠️ 队伍名在领域层**取不到**：scoreStage 是纯函数（无 db），
        //    队伍名要查 teams 表 ⇒ SQL 只能写在 src/db/repo/ ⇒ 这里不写队伍名，
        //    队伍 id 与英文维度键进 detail（只给有 audit:read 的人看）。
        message: missingLabel
          ? `有队伍在「${missingLabel}」维度上没有任何评分，该维度权重记 0`
          : '有队伍在某个维度上没有任何评分，该维度权重记 0',
        detail: `队伍 ${teamId} / 维度 ${missing}`,
        teamId,
        dimension: missing,
      });
    }
    const seatP = pSeat.score;
    // 席位分的**真实分母**（缺分维度被剔除后的权重和）——
    // 不记进 trace 的话，从 trace 复算 seatP 会得到不同的数（父代理预审 Minor 8）。
    seatWeightSums.set(teamId, pSeat.weightSum);

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

    // 自评席维度的分进 trace（否则发榜页看不到该维度的来由）
    for (const k of selfSeatKeySet) {
      if (pScores[k] == null) continue;
      if (!selfDimScores.has(k)) selfDimScores.set(k, new Map());
      selfDimScores.get(k).set(teamId, { score: pScores[k], zMean: null, z: {}, raw: pScores[k] });
    }

    const perDimension = {};
    for (const d of dimensions) {
      const isEnterprise = d.seat === 'enterprise';
      const cell = isEnterprise
        ? null
        : (selfSeatKeySet.has(d.key) ? selfDimScores.get(d.key)?.get(teamId) : dimScores.get(d.key)?.get(teamId));
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
  // ⚠️ 判定只看 **P 席**（评委席 + 自评席）：企业席缺分时企业项按 0 分计，
  //    若把它算作「有评分」，则名册里没被任何人评过的队会拿到 total=0 的结果行，
  //    进而被排进榜单 —— 与「不参与排名」相悖（父代理预审修正 ④）。
  for (const t of teamsOut) {
    const hasAny = pSeatKeys.some((k) => t.perDimension[k]?.mean != null);
    if (!hasAny) {
      warnings.push({
        code: 'team_no_reviews',
        message: '有队伍没有任何评分，不参与排名',
        detail: `队伍 ${t.teamId}`,
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
      seatPWeightSum: seatWeightSums.get(t.teamId) ?? 0,
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
// 依据：设计文档 §12（可复算：input + output + trace 三件套）+ §8【决策】（compute 是显式动作）
// ⚠️ 本文件**不含裸 SQL 之外的任何逻辑**，全部 SQL 收在此处（全局约束「SQL 边界」）。
import { randomUUID } from 'node:crypto';

export function nextRevision(db, { stageId, kind, teamId = null }) {
  // ⚠️ **P4 扩展**（本函数由 P2 建立）：P4 需要「同一赛段内按队伍各自编号」，
  //    所以加了一个**可选**的 teamId 收窄条件。
  //    ⛔ 不传 teamId 时**行为与 P2 一字不差**（P2 的调用点
  //       `nextRevision(db, { stageId, kind })` 不受影响）。
  //    ⛔ 绝不在本文件里**再定义一个 nextRevision** —— 同名导出重复声明会让整个
  //       模块抛 SyntaxError，`src/services/compute.js` 连带**整个平台**都加载不了。
  const where = ['stage_id = ?', 'kind = ?'];
  const params = [stageId, kind];
  if (teamId != null) { where.push('team_id = ?'); params.push(teamId); }
  const row = db
    .prepare(`SELECT MAX(revision) AS rev FROM computation_snapshots WHERE ${where.join(' AND ')}`)
    .get(...params);
  return (row?.rev ?? 0) + 1;
}

/** 三件套快照：input + output + trace（P4 的 recomputeAndDiff 依赖它重放） */
export function insertSnapshot(db, { kind, editionId = null, stageId = null, teamId = null, ruleVersion, input, output, trace, revision, now, id = randomUUID() }) {
  // ⚠️ **P4 扩展**：加了可选的 `id`（默认仍是随机 UUID）——
  //    P4 的审计留痕需要「自己指定 id 以便测试与外部引用」。
  //    不传 id 时行为与 P2 一字不差。
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

/**
 * 取快照并**校验它属于该赛段**。
 * ⚠️ 父代理预审修正（Critical，D-26）：接口是
 *    `GET /api/stages/:stageId/computations/:computationId`，
 *    但原实现只按 id 取 —— 路径里的 stageId 形同虚设，
 *    任何有 `audit:read` 的人都能拿**别的赛段**的计算快照来读（跨赛段越权读）。
 *    现在传入 stageId 时必须匹配，不匹配返回 null（上层回 404）。
 */
export function getSnapshotInStage(db, { id, stageId = null }) {
  const row = getSnapshot(db, id);
  if (!row) return null;
  if (stageId != null && row.stage_id !== stageId) return null;
  return row;
}

export function listSnapshots(db, { stageId, kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = ? ORDER BY revision').all(stageId, kind);
  }
  return db.prepare('SELECT * FROM computation_snapshots WHERE stage_id = ? ORDER BY revision').all(stageId);
}

/**
 * 重算前清场：名次/并列/积分一律置 NULL，并删掉「本轮已无评分」的旧结果行。
 * ⚠️ 父代理预审修正（Important，I2）：`upsertStageResult` 的 ON CONFLICT 只更新
 *    total / seat_p / seat_e / computation_id —— **rank / tied_with / points 原样保留**。
 *    于是「P3 已经发过榜 → 之后又重算一次」的结果是：**旧名次 + 新总分**并排躺在同一行上，
 *    榜单自相矛盾。撤掉某队的全部打分后重算，旧行也仍在（total 还是老的）。
 *    现在重算前先清场（P3 会在新一轮计算后重新填名次与积分）。
 * @param {string[]} keepTeamIds 本轮**有**评分的队伍；不在名单里的旧行一律删除
 */
export function resetStageResults(db, { stageId, keepTeamIds = [] }) {
  db.prepare('UPDATE stage_results SET rank = NULL, tied_with = NULL, points = NULL WHERE stage_id = ?').run(stageId);
  if (keepTeamIds.length) {
    const placeholders = keepTeamIds.map(() => '?').join(', ');
    db
      .prepare(`DELETE FROM stage_results WHERE stage_id = ? AND team_id NOT IN (${placeholders})`)
      .run(stageId, ...keepTeamIds);
    return;
  }
  db.prepare('DELETE FROM stage_results WHERE stage_id = ?').run(stageId);
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

// ── P4 追加：按「最近优先」列快照（审计列表用）────────────────────────
// 依据：设计文档 §12「可复算：input + output + trace 三件套」
//   ⛔ 重算走 revision + 1，旧 revision 保留（设计文档 §11.1「事后篡改」防护）。
// ⚠️ 与 P2 的 listSnapshots 语义**不同**，不是同一件事的第二个名字：
//    · listSnapshots(stageId)  =「某赛段的全部快照，按 revision 升序」→ 给**重放**用
//    · listComputationRows()   =「最近的快照，倒序 + 可分页」→ 给**审计列表**用
export function listComputationRows(db, { kind = null, stageId = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (stageId) { where.push('stage_id = ?'); params.push(stageId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM computation_snapshots ${clause}`).get(...params).n;
  // ⛔ 确定性排序：破并列键用 SQLite 隐式 `rowid`，**不用 `id`** ——
  //    `id` 是 randomUUID() ⇒ 同 `created_at` 的两条记录**次序随机**。
  //    全局约束同 `src/db/repo/audit-log.js`（P4-13 根因修复）。
  const rows = db.prepare(
    `SELECT * FROM computation_snapshots ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
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
//
// 【父代理预审修正 2026-10-21 —— 本文件有 4 处修正，读代码前先看这段】
//   ① **仓储返回的是 snake_case 行，规格却把三张表的原始行直接喂给领域层** ——
//      企业确认 / 互评 / 自评三张表全部被**静默忽略**：
//        · enterprise_confirmations 的列是 team_id / enterprise_id / raw_score /
//          cross_judge_id / signatory_user_id，而领域层读的是 teamId / rawScore / …
//          → 领域层按 `c.teamId === team.teamId` 过滤，一条都匹配不上
//          → 每支队都拿到「没有企业确认」→ 企业席恒为 0 分（初赛 10% / 决赛 25% 直接蒸发）。
//        · 互评分（trace.perTeam.peerScore）恒为 null。
//        · 自评测恒为空 → 决赛的「自评测 5%」维度恒缺分。
//      现在三张表都**显式映射**成领域层的驼峰形状。
//   ② **「抢 revision + 写快照 + 写结果 + 写审计」不在同一事务** →
//      中途失败会留下「有快照没结果」或「结果指向不存在的快照」的半成品。
//      现在整段在一个 `BEGIN IMMEDIATE` 事务里。
//   ③ **没有任何评分的队伍也写进了 stage_results**（total = 0）→
//      它们会被 P3 排进榜单。设计文档 §11 明写「不参与排名」。
//      现在只写「P 席有分」的队伍。
//   ④ **计算快照可跨赛段读取**（D-26）→ 见 db/repo/computations.js 的 getSnapshotInStage。
import { getStage, listStageTeams as listStageTeamsRows, listStageJudges } from '../db/repo/stages.js';
import { listReviews, listScoreStats } from '../db/repo/reviews.js';
import { listEnterpriseConfirmations } from '../db/repo/enterprise-confirmations.js';
import { listPeerReviews } from '../db/repo/peer-reviews.js';
import { listSelfReviews } from '../db/repo/self-reviews.js';
import { listRecusals } from '../db/repo/recusals.js';
import { listUsersForDetection } from '../db/repo/users.js';
import { upsertStageResult, getSnapshotInStage, resetStageResults } from '../db/repo/computations.js';
import { writeAuditLog } from '../audit/log.js';
import { scoreStage } from '../domain/scoring.js';
import { checkRecusal } from '../domain/review-eligibility.js';
import { checkJudgePool } from '../domain/judge-pool.js';
import { recordComputation } from './audit.js';
import { runDetection } from './anticheat.js';
import { appError } from '../errors.js';

function fail(status, code, message) {
  // ⚠️ 必须用 P0 的 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    P0 终审 I-C 的错误分支是 `err instanceof AppError ? err.message : '请求无效'` ——
  //    裸 Error 不是 AppError → message 被替换成通用文案「请求无效」。
  return appError(status, code, message);
}

/**
 * 队伍名册（需要 P1 的 teams / task_packages）。
 * ⚠️ 只吞「表还没建」这一种错误（表未就绪时返回空并由调用方记 warning）；
 *    其它错误（SQL 写错、约束冲突）**必须上抛** —— 静默返回空名册会让
 *    R1 / R4 判定整段跳过，榜单分数静默出错。
 */
export function listStageTeams(db, stageId) {
  try {
    // SQL 在仓储层（src/db/repo/stages.js）；本文件**不含 SQL**。
    return listStageTeamsRows(db, stageId);
  } catch (err) {
    const msg = String(err?.message ?? '');
    if (/no such table/i.test(msg)) return [];
    throw err;
  }
}

/** 单事务执行：要么全成功，要么全回滚（⛔ BEGIN IMMEDIATE：立即取写锁） */
function inTransaction(db, fn) {
  const nested = db.isTransaction === true;
  if (!nested) db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    if (!nested) db.exec('COMMIT');
    return out;
  } catch (err) {
    if (!nested) db.exec('ROLLBACK');
    throw err;
  }
}

/** 仓储行（snake_case）→ 领域层形状（camelCase）—— 见文件头修正 ① */
function mapConfirmations(rows) {
  return rows.map((c) => ({
    teamId: c.team_id,
    enterpriseId: c.enterprise_id,
    dimension: c.dimension,
    rawScore: c.raw_score,
    crossJudgeId: c.cross_judge_id ?? null,
    signatoryUserId: c.signatory_user_id ?? null,
    content: c.content ?? '',
  }));
}

function mapPeerReviews(rows) {
  return rows.map((p) => ({
    fromTeamId: p.from_team_id,
    toTeamId: p.to_team_id,
    score: p.score,
  }));
}

function mapSelfReviews(rows) {
  return rows.map((r) => ({
    teamId: r.team_id,
    dimension: r.dimension,
    rawScore: r.raw_score,
  }));
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
  // ⚠️ judgePool 段缺失 = 评委池下限/席构成**无法校验** —— 那种情况下算出来的榜单
  //    不可能合规。与其「静默按默认值 0/0/1 算」，不如当场拒绝计算。
  if (!config.judgePool) {
    throw fail(500, 'JUDGE_POOL_CONFIG_MISSING', `权重表 ${stage.scoring_config_key} 缺少 judgePool 段，拒绝计算`);
  }

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
  const confirmations = mapConfirmations(listEnterpriseConfirmations(db, { stageId }));
  const peerReviews = mapPeerReviews(listPeerReviews(db, stageId));
  const selfReviews = mapSelfReviews(listSelfReviews(db, stageId));

  const result = scoreStage({
    config,
    judges,
    submissions,
    enterpriseConfirmations: confirmations,
    peerReviews,
    teams,
    selfReviews,
  });

  if (excluded.length) {
    result.warnings.push({
      code: 'recusal_excluded',
      message: `因回避剔除 ${excluded.length} 条打分（记录见 recusal_records）`,
    });
  }

  // ⚠️ 终审修正 I-2：R-JDG-10（评委池下限）/ R-JDG-11（席构成）的校验原来**零调用方** ——
  //    `checkJudgePool` 只有自己的单元测试在跑 → 1 名评委、0 企业席的赛段照样能算出
  //    total=72 的榜单，规则里的 minJudgesPerDimension:7 / minEnterpriseSeatShare:0.30
  //    形同虚设。**后果**：组委会可以在不合规的池子上发榜，而快照里看不出池子不合规。
  //    口径：**不阻断发榜，但必须显式暴露** —— 与本阶段其余「业务状态类」判定一致
  //    （自评差异 / 企业席规则 / 归一化降级 都是「算 + 显式告警」）。
  //    「池子不合规就不许发榜」是**组委会口径**，要加这道闸只需在 compute 路由上判
  //    `warnings` 里的 `judge_pool_invalid`，不必改领域层。
  const judgePool = checkJudgePool({ judges, config: config.judgePool });
  if (!judgePool.ok) {
    result.warnings.push({
      code: 'judge_pool_invalid',
      message: `评委池不合规（${judgePool.errors.length} 项）：${judgePool.errors.map((e) => e.code).join(', ')}`,
      errors: judgePool.errors,
      stats: judgePool.stats,
    });
  }

  // 三件套快照
  const input = {
    config,
    judges,
    submissions,
    excludedReviews: excluded,
    enterpriseConfirmations: confirmations,
    peerReviews,
    selfReviews,
    teams,
    // ⚠️ 池子构成与合规性必须进快照：事后复算时要能看出「当次发榜的评委池合不合规」
    //    （R-AUD-01 可复算 / 可审计）。只放 warnings 不够 —— warnings 不进 input。
    judgePool: { ok: judgePool.ok, errors: judgePool.errors, stats: judgePool.stats },
    ruleVersion: config.version ?? 'unknown',
  };
  // trace 里也留一份：trace 是「计算过程」的完整留痕
  result.trace = { ...(result.trace ?? {}), judgePool: { ok: judgePool.ok, errors: judgePool.errors, stats: judgePool.stats } };

  const out = inTransaction(db, () => {
    const scoredTeamIds = [];
    // ⛔ P11：快照改走**服务层**的 recordComputation（原来这里直接调仓储层 insertSnapshot），
    //    于是 `computation_snapshots` 有了**两个写者**：compute.js 自己拼参数写一份，
    //    services/audit.js 的 recordComputation 又写一份（还带一条 `computation.record` 审计）。
    //    两份实现必然漂 ⇒ 统一到一个写者，服务层那层（校验 + 审计）才是**唯一**入口。
    const { id: computationId, revision } = recordComputation({
      db,
      kind: 'stage_score',
      editionId: stage.edition_id,
      stageId,
      ruleVersion: config.version ?? 'unknown',
      input,
      output: { teams: result.teams, warnings: result.warnings },
      trace: result.trace,
      actorId,
      now,
    });

    for (const t of result.teams) {
      // 没有 P 席评分的队伍不写结果行（不参与排名，见文件头修正 ③）
      const hasPSeat = Object.entries(t.perDimension).some(
        ([key, d]) => config.dimensions.some((dim) => dim.key === key && dim.seat !== 'enterprise') && d.mean != null,
      );
      if (!hasPSeat) continue;
      scoredTeamIds.push(t.teamId);
    }

    // ⛔ 重算前清场：名次/并列/积分置 NULL + 删掉本轮已无评分的旧行
    //    （否则「旧名次 + 新总分」会并排躺在同一行上 —— 父代理预审修正 I2）
    resetStageResults(db, { stageId, keepTeamIds: scoredTeamIds });

    for (const teamId of scoredTeamIds) {
      const t = result.teams.find((x) => x.teamId === teamId);
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

    return { computationId, revision, teams: result.teams, warnings: result.warnings, trace: result.trace };
  });

  // ⛔ P11：反作弊检测**必须有一个生产触发点**。
  //    此前 `runDetection`（设计 §11.1「检测 → 进人工复核队列」）**只有单测在调**，
  //    路由表里没有任何一条路能触达它 ⇒ 生产上**永远不会建出 flag** ⇒
  //    「复核队列」页永远是空的 ⇒ 整条防串通/防刷分链是死的。
  //    ⇒ 挂在「算完之后」这个时机：数据齐了才检测得出来。
  //    ⛔ 检测 ≠ 处罚：只建 flag（status='open'），不改分、不封号、不自动裁决（裁决是人的动作）。
  //    ⛔ 检测失败**不许**让计算失败（计算本身已经落库成功）⇒ 降级成一条显式告警，不静默。
  try {
    const detection = runDetection({
      db,
      stageId,
      peerReviews: peerReviews.map((p) => ({ judgeId: p.fromTeamId, teamId: p.toTeamId, score: p.score })),
      // 提交事件（用于「刷分」突发检测）：评委在某时刻提交了一条打分
      events: allReviews.map((r) => ({ subjectId: r.judge_id, at: r.submitted_at })),
      scoreStats: listScoreStats(db),
      users: listUsersForDetection(db),
      // ⚠️ 名次相关的检测（detectTiedMutualPeerRate）需要**最终名次**，
      //    而名次是发榜时（破同分链跑完）才有的 ⇒ 计算阶段给不了，这里传空。
      //    设计 §11.1 的核心要求「两位评委对全部重叠项目给出完全相同的相对顺序」
      //    （detectIdenticalPeerPattern）**不需要名次** ⇒ 已覆盖。
      results: [],
      rules,
      now,
    });
    if (detection?.created?.length) {
      out.warnings.push({
        code: 'anticheat_flags_created',
        message: `本轮检测出 ${detection.created.length} 条疑似异常，已进人工复核队列（只告警，不改分）`,
        flags: detection.created.length,
      });
    }
  } catch (err) {
    out.warnings.push({
      code: 'anticheat_detection_failed',
      message: `反作弊检测未能完成：${String(err?.message ?? err)}（检测失败不影响已算出的分数）`,
    });
  }

  return out;
}

/** 读取计算快照（三件套）；给了 stageId 时必须属于该赛段（D-26） */
export function getComputation({ db, id, stageId = null }) {
  const row = getSnapshotInStage(db, { id, stageId });
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


> **【2026-10-21 漂移审计修正 N-2（审计报告未覆盖，本次新发现）】**
> **原来错在哪**：`src/services/compute.js` 的 `listStageTeams()` 原来在**服务层直接写 SQL**：
> ```javascript
> export function listStageTeams(db, stageId) {
>   try {
>     return db
>       .prepare(
>         `SELECT t.id AS team_id, tp.enterprise_id AS package_enterprise_id,
>                 COALESCE(tp.is_free_brief, 0) AS is_free_brief
>          FROM teams t
>          LEFT JOIN task_packages tp ON tp.id = t.task_package_id
>          WHERE t.edition_id = (SELECT edition_id FROM stages WHERE id = ?)
>            AND t.deleted_at IS NULL
>          ORDER BY t.id`,
>       )
>       .all(stageId)
>       ...
> ```
> **为什么错**：与 C-3 / C-4 / C-5 **完全同类** —— 越过全局约束「所有 SQL 收进
> `platform/src/db/repo/`」，`platform/test/sql-boundary.test.js` 守卫会判违规。
> **审计为什么没抓到**：审计的实跑只把**三个文件**放进 pristine 树
> （`src/audit/log.js` / `src/services/review-state.js` / `scripts/restore.js`），
> 所以它报的是「6 条违规」；本文件**没被放进去** → 这一条被漏掉了。
> 本次用「把五份计划的**全部**代码块按 P0 的判定规则扫一遍」的方式把它找了出来
> （扫描器复刻了 `sql-boundary.test.js` 的 `stripComments` + `findDbCalls` + `SQL_KEYWORD` 规则）。
> **改成什么**：① SQL **下沉**到本阶段 Task 6 已建的 `src/db/repo/stages.js`
> （新增 `listStageTeams(db, stageId)`）；② `src/services/compute.js` 改为
> `import { getStage, listStageTeams as listStageTeamsRows } from '../db/repo/stages.js';`
> 并把服务层函数改成「调仓储 + 保留原来的 try/catch 兜底」
> （**行为完全不变**：表未就绪时仍然返回 `[]`，由调用方记 warning ——
> 差别只在于「抛错」这件事现在由仓储层做、由服务层兜住）。
> **依据**：基线 `platform/test/sql-boundary.test.js:282-292`（扫描范围 + 豁免名单）
> + 漂移审计报告 C-3 / C-4 / C-5 的同一规则。

- [ ] **Step 6: 创建 src/http/routes/review.js**

```javascript
// src/http/routes/review.js — 评审 API
//
// 依据：INTERFACES.md §3「API（P2）」+ 设计文档 §8。
//   权限：capability + assignment（唯一入口 can()）。P2 阶段先做「登录 + 能力点」判定，
//   行级 scope 由 P3/P4 的 scopeClause 补齐。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 5 处修正，读代码前先看这段】
//   ① **回避可代他人申报** → 任何有 `score:write` 的人都能把**别的评委**拉下水，
//      那个评委的打分随即被剔除（computeStage 里按回避剔除打分）——
//      这是「打分 sabotage」，不是能力点该给的权限。现在只有本人能给自己申报，
//      代录仅限组委会（`stage:compute`），且被申报人必须在本赛段评委名单里。
//   ② **企业确认可代签 / 可冒名** → 企业确认占初赛 10% / 决赛 25% 的权重，
//      原实现允许任意有 `score:write` 的人为任意队伍、任意企业「签字」，
//      甚至把 `signatoryUserId` 伪造成别人。现在出题企业只能为自己签，
//      跨领域评委必须真实存在于本赛段名单且与签字人不同；组委会可代录（留审计）。
//   ③ **自评可代队伍提交** → 决赛「自评测」占 P 席 5%，
//      原实现允许任意有 `score:write` 的人替任意队伍提交自评 ——
//      等于「给别人加分」。现在自评用独立能力点 `self_review:write`（队长/组员持有），
//      且必须是**本队成员**才能提交。
//   ④ **互评可代队伍提交** → 同理，现在要求提交者是该支互评发起队的在册成员。
//   ⑤ **能力点校验的作用域** → 原来传 `{ scopeType: 'global' }`，
//      只能认全局授权，赛段级授权一律不认。现在同时认赛段级与全局级授权
//      （都走 `can()`，唯一判定入口）。
import { AppError } from '../../errors.js';
import {
  submitReviews,
  getReviewState,
  getReviewBoard,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  declareRecusal,
  reinstateRecusal,
  getRecusalLedger,
  submitEnterpriseConfirmation,
  withdrawEnterpriseConfirmation,
  resignEnterpriseConfirmation,
  resolveStageRoster,
} from '../../services/review.js';
import { computeStage, getComputation } from '../../services/compute.js';
import { reviewEvents } from '../sse.js';
import { getStage, getStageJudge, listStageTeams } from '../../db/repo/stages.js';
import { getTeamWithPackage } from '../../db/repo/teams.js';
import { listActiveMembers } from '../../db/repo/teamMembers.js';
import { loadOptionalModule } from '../optional-module.js';
import { fileURLToPath } from 'node:url';

function requireUser(ctx) {
  if (!ctx.user) {
    throw new AppError(401, 'UNAUTHENTICATED', '未登录');
  }
  return ctx.user;
}

/**
 * 能力点校验：认**赛段级**与**全局级**授权（都走 can()）。
 * ⚠️ 不能只传 `{ scopeType: 'global' }` —— 那等于「只认全局授权」，
 *    赛段级授权（scope_type='stage'）会被静默判成无权。
 */
function requireStageCapability(ctx, capability) {
  requireUser(ctx);
  const stageId = ctx.params?.stageId ?? null;
  if (ctx.can(capability, { scopeType: 'stage', scopeId: stageId })) return;
  if (ctx.can(capability, { scopeType: 'global' })) return;
  throw new AppError(403, 'FORBIDDEN', `缺少能力：${capability}`);
}

/** 是否组委会（可看全局进度、可代录） */
function isCommittee(ctx) {
  if (!ctx.user) return false;
  const stageId = ctx.params?.stageId ?? null;
  return ctx.can('stage:compute', { scopeType: 'stage', scopeId: stageId })
    || ctx.can('stage:compute', { scopeType: 'global' });
}

/** 是否企业席（能签企业确认）—— `signoff:create` 是企业角色的能力点 */
function isEnterpriseSeat(ctx) {
  if (!ctx.user) return false;
  const stageId = ctx.params?.stageId ?? null;
  return ctx.can('signoff:create', { scopeType: 'stage', scopeId: stageId })
    || ctx.can('signoff:create', { scopeType: 'global' });
}

/** 本人是否是该队的在册成员 */
function isTeamMember(db, teamId, userId) {
  if (!teamId || !userId) return false;
  return listActiveMembers(db, teamId).some((m) => m.user_id === userId);
}

/**
 * 评委只能给**评委席维度**打分。
 * ⚠️ 父代理预审修正（Important，I3）：
 *   原来维度键不校验 → 评委可以对 `seat='self'` 的维度（「自评测」）打分，
 *   于是「自评只能本队成员提交」这道闸门被整个绕过去 ——
 *   评委自己填 100 分，自评栏就归他了（R-JDG-13「不加分」直接失效）。
 *   领域层也做了同样的防御（自评席维度不取评委打分记录），这里是写入口的第一道。
 */
function assertJudgeDimensions(ctx, items) {
  const stage = getStage(ctx.db, ctx.params.stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const config = ctx.rules?.scoring?.[stage.scoring_config_key];
  if (!config) {
    throw new AppError(500, 'SCORING_CONFIG_MISSING', `赛段 ${stage.id} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  }
  const dims = new Map((config.dimensions ?? []).map((d) => [d.key, d]));
  for (const item of items) {
    const dim = dims.get(item.dimension);
    if (!dim) {
      throw new AppError(400, 'UNKNOWN_DIMENSION', `未知评分维度：${item.dimension}`);
    }
    if (dim.seat !== 'judge') {
      throw new AppError(403, 'DIMENSION_SEAT_FORBIDDEN', `维度 ${item.dimension} 不属于评委席，不能由评委打分`);
    }
  }
}

/**
 * ⛔ P4 跨阶段接线（P4 Task 6）：把 review-state 返回的**分数数组**过一遍
 *    filterVisibleScores({ db, stageId, viewer, scores })。
 *
 * ⚠️ 两处必须说清楚：
 *  ① **过滤发生在 API 层**，不是前端隐藏 —— 设计文档 §6.6：「前端隐藏 = 数据已泄露」。
 *  ② 过滤模块（Task 5 的 `src/services/review-state.js`）由**并行 Task** 落地，
 *     静态 import 会让整个平台在它落地前**加载不了**（server.js 顶层 import 失败
 *     → createApp 抛错 → 全站 500）→ 改成**动态 import**：
 *       · **没有分数可过滤**（当前 P2 的 getReviewState 不返回分数）→ 原样放行
 *         （没有分数 = 没有可泄露的东西，过滤是恒等的）；
 *       · **有分数但过滤模块缺失** → 503（fail closed：宁可报错，
 *         也绝不把未过滤的分数发出去）。
 *
 * ⚠️ 终审修正（Important，I-2）：**只把「目标模块真不存在」当成缺失**。
 *    模块在场但加载期崩了（语法错 / 传递依赖缺失）→ **抛出去**，
 *    绝不装成「模块未就绪」—— 后者会让排查指向错误方向。判据见 optional-module.js。
 */
const REVIEW_STATE_URL = new URL('../../services/review-state.js', import.meta.url).href;
const REVIEW_STATE_PATH = fileURLToPath(REVIEW_STATE_URL);

export async function applyScoreVisibility({ db, stageId, viewer, state }) {
  const scores = Array.isArray(state?.scores) ? state.scores : [];
  if (!scores.length) return state;
  const mod = await loadOptionalModule(REVIEW_STATE_URL, REVIEW_STATE_PATH);
  const filterVisibleScores = mod?.filterVisibleScores;
  if (typeof filterVisibleScores !== 'function') {
    return {
      status: 503,
      body: {
        error: {
          code: 'SCORE_VISIBILITY_UNAVAILABLE',
          message: '分数可见性过滤模块尚未就绪，拒绝返回未过滤的分数',
        },
      },
    };
  }
  return { ...state, scores: filterVisibleScores({ db, stageId, viewer, scores }) };
}

export function registerReviewRoutes(router) {
  router.add('POST', '/api/stages/:stageId/reviews', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    // ⚠️ 维度白名单**不能丢**（D-32）：评委只能给评委席维度打分，
    //    否则评委能对 seat='self' 的维度打分 → 自评栏被评委占掉。
    const items = ctx.body?.items ?? [];
    assertJudgeDimensions(ctx, items);
    const result = await submitReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items,
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
    // 评审进度推送：订阅同一赛段的评审端据此刷新进度条。
    // ⚠️ 发布点在 **HTTP 层**（不是 service 层）：service 不该知道 HTTP 的存在。
    // ⚠️ **载荷不含 judgeId**（D-37）：事件流里带「谁在什么时候提交了评分」，
    //    等于把评委行踪广播给该赛段的每个订阅者。事件只作为**信号**，
    //    客户端收到后重新拉 `review-state` —— 可见性由那一层按观众过滤。
    reviewEvents.publish(
      'review.progress',
      { stageId: ctx.params.stageId, at: new Date().toISOString() },
      `stage:${ctx.params.stageId}`,
    );
    return result;
  });

  router.add('GET', '/api/stages/:stageId/review-state', async (ctx) => {
    requireUser(ctx);
    // 权限：组委会 / 有评分读取能力的人 / 本赛段评委
    // ⚠️ 终审修正 M-5：原注释写「本赛段队伍成员（队长看本队自评进度）」，
    //    但闸门**并不**放行队长 → 注释与行为不符（行为更严，不是更松）。
    //    按实际行为改正注释；若将来要放开队长，需另加一道「只看本队」的过滤，
    //    不能只把注释改回去。
    if (!isCommittee(ctx)
      && !ctx.can('score:read', { scopeType: 'stage', scopeId: ctx.params.stageId })
      && !ctx.can('score:read', { scopeType: 'global' })
      && !getStageJudge(ctx.db, ctx.params.stageId, ctx.user.id)) {
      throw new AppError(403, 'FORBIDDEN', '没有查看评审进度的权限');
    }
    // ⚠️ 终审修正 I-1：**必须把该赛段权重表的评委席维度全集传下去**。
    //    省略 `dimensions` 时服务层退回「已出现过打分的维度」→ 从未有人评过的维度
    //    不进分母 → 真实完成度 20% 时接口报 100%，`missing` 为空。
    //    （计划 Task 6 的修正 ④ 修的是「队伍轴」，这里漏的是「维度轴」。）
    const stateStage = getStage(ctx.db, ctx.params.stageId);
    const stateConfig = stateStage ? ctx.rules?.scoring?.[stateStage.scoring_config_key] : null;
    const stateDimensions = (stateConfig?.dimensions ?? [])
      .filter((d) => d.seat === 'judge')
      .map((d) => d.key);
    return applyScoreVisibility({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: ctx.user,
      state: await getReviewState({
        db: ctx.db,
        stageId: ctx.params.stageId,
        viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
        dimensions: stateDimensions,
      }),
    });
  });

  // ⛔ P8：评审工作台（只读，一次拿齐「名册 + 维度 + 我的分 + 进度」）
  //    前端要拼评分表单，但名册/维度/我的分原先分散在仓储层、规则文件与 stage_reviews 里，
  //    **一个对外读口都没有** ⇒ 前端要么猜口径、要么拼三个请求。
  router.add('GET', '/api/stages/:stageId/review-board', async (ctx) => {
    requireUser(ctx);
    // ⚠️ 权限闸门与 `GET /api/stages/:stageId/review-state` **完全同口径**：
    //    组委会 / 有 score:read（赛段级或全局）/ 本赛段评委 ⇒ 否则 403。
    //    ⚠️ 不按角色判（全局约束：可见性与授权在 API 层裁决），只认能力点与评委身份。
    if (!isCommittee(ctx)
      && !ctx.can('score:read', { scopeType: 'stage', scopeId: ctx.params.stageId })
      && !ctx.can('score:read', { scopeType: 'global' })
      && !getStageJudge(ctx.db, ctx.params.stageId, ctx.user.id)) {
      throw new AppError(403, 'FORBIDDEN', '没有查看评审工作台的权限');
    }
    return getReviewBoard({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
      rules: ctx.rules,
    });
  });

  router.add('POST', '/api/stages/:stageId/calibration', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    // ⚠️ **校准分也必须过维度白名单**（P10 补齐，与 `POST /reviews` **同口径**）：
    //   原来这里**没有**校验 ⇒ 任何有 `score:write` 的人可以给**任意维度键**写校准分，
    //   包括 `seat='self'` 的「自评测」与 `seat='enterprise'` 的「企业确认」。
    //   ⚠️ 校准分**不进总分**（writeCalibrations 不参与计分）—— 但口径不一致的后果是：
    //     ① 审计说不清「这条校准记录是哪一维度的」；
    //     ② `calibrations` 表被污染（混进非评委席维度的记录）；
    //     ③ 口径分叉会让「评委只能给评委席维度打分」这条规则**在校准入口形同虚设**。
    //   ⇒ 复用**同一个** `assertJudgeDimensions` 函数（不是另写一份）——
    //     两处口径必须**逐字同源**，否则改一处就会分叉。
    const items = ctx.body?.items ?? [];
    assertJudgeDimensions(ctx, items);
    return submitCalibration({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/peer-reviews', async (ctx) => {
    requireStageCapability(ctx, 'peer_review:write');
    const items = ctx.body?.items ?? [];
    // ⛔ 互评是「队 → 队」的动作：提交者必须在发起队里（父代理预审修正 ④）
    for (const item of items) {
      if (!isTeamMember(ctx.db, item.fromTeamId, ctx.user.id)) {
        throw new AppError(403, 'NOT_TEAM_MEMBER', '只能代表本队提交互评');
      }
    }
    return submitPeerReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      items,
      requestId: ctx.body?.requestId ?? null,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/self-review', async (ctx) => {
    requireStageCapability(ctx, 'self_review:write');
    const teamId = ctx.body?.teamId;
    if (!teamId) {
      throw new AppError(400, 'MISSING_TEAM_ID', '缺少队伍');
    }
    if (!isTeamMember(ctx.db, teamId, ctx.user.id)) {
      throw new AppError(403, 'NOT_TEAM_MEMBER', '只能为本队提交自评');
    }
    return submitSelfReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      teamId,
      items: ctx.body?.items ?? [],
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/enterprise-confirmations', async (ctx) => {
    const stageId = ctx.params.stageId;
    const actorId = ctx.user.id;
    const committee = isCommittee(ctx);
    // ⛔ 只有**企业席**（signoff:create）或组委会能签企业确认（父代理预审修正 ② / C1）
    if (!isEnterpriseSeat(ctx) && !committee) {
      throw new AppError(403, 'FORBIDDEN', '只有出题企业（或组委会）可以签署企业确认');
    }
    requireStageCapability(ctx, 'score:write');
    // 出题企业只能为自己签
    const enterpriseId = ctx.body?.enterpriseId ?? actorId;
    if (enterpriseId !== actorId && !committee) {
      throw new AppError(403, 'FORBIDDEN', '企业确认只能由出题企业本人签署（组委会可代录）');
    }
    if (ctx.body?.signatoryUserId && ctx.body.signatoryUserId !== enterpriseId) {
      throw new AppError(403, 'FORBIDDEN', '签字人必须与出题企业一致');
    }
    // ⛔ 被签的队伍必须在本赛段名册内，且必须**确实由这家企业出题**
    //    （否则一条冒名记录就能把受害队伍的企业席连坐作废 —— 父代理预审 C1）
    const teamId = ctx.body?.teamId;
    const team = teamId ? getTeamWithPackage(ctx.db, teamId) : null;
    if (!team) {
      throw new AppError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    }
    // 名册判定**先于**归属判定：名册外的队伍 → 404（三态：单条不满足 → 404），
    // 而不是「归属不符 → 403」（那会泄露「这支队存在但不是你家的」）。
    // ⚠️ P11 · E156：走服务层的 `resolveStageRoster`（赛段级优先、届期级兜底）——
    //    直接用届期级的 `listStageTeams` ⇒ 同届期另一赛段的队会被写进本赛段（外队进榜）。
    const roster = resolveStageRoster(ctx.db, stageId);
    if (!roster.includes(teamId)) {
      throw new AppError(404, 'TEAM_NOT_IN_STAGE', `队伍 ${teamId} 不在本赛段名册内`);
    }
    if (!committee && team.packageEnterpriseId !== actorId) {
      throw new AppError(403, 'FORBIDDEN', '该队伍的任务包不是贵司出的题，不能代签企业确认');
    }
    const crossJudgeId = ctx.body?.crossJudgeId ?? null;
    if (crossJudgeId && crossJudgeId === enterpriseId) {
      throw new AppError(400, 'CROSS_JUDGE_SAME_AS_SIGNATORY', '跨领域评委签字人不能与出题企业签字人相同');
    }
    if (crossJudgeId && !getStageJudge(ctx.db, stageId, crossJudgeId)) {
      throw new AppError(404, 'JUDGE_NOT_ASSIGNED', '跨领域评委不在本赛段名单内');
    }
    return submitEnterpriseConfirmation({
      db: ctx.db,
      stageId,
      teamId,
      enterpriseId,
      dimension: ctx.body?.dimension ?? 'enterprise',
      rawScore: ctx.body?.rawScore,
      crossJudgeId,
      signatoryUserId: enterpriseId,
      content: ctx.body?.content ?? '',
      now: new Date().toISOString(),
    });
  });

  // ⛔ P11 · E141：**企业确认的逆向路径**（撤回 / 改签）。
  //
  // ⚠️ 为什么必须有（E141 实测）：企业确认落库后**没有任何改动的途径** ⇒
  //    ① 签错了改不了；② **缺跨领域评委签字**（R2 双签只签一半）没法补签
  //    ⇒ 该队企业席按 R2 恒计 0 分并挂 warning，而**产品内修不了**。
  //
  // ⚠️ 权限口径与**同一条正向端点**完全一致（出题企业本人或组委会）：
  //    跨领域评委**不在这条端点上**——他要补签走下面的「改签」端点（只动 cross_judge_id）。
  router.add('POST', '/api/stages/:stageId/enterprise-confirmations/:id/withdraw', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const committee = isCommittee(ctx);
    if (!isEnterpriseSeat(ctx) && !committee) {
      throw new AppError(403, 'FORBIDDEN', '只有出题企业（或组委会）可以撤回企业确认');
    }
    return withdrawEnterpriseConfirmation({
      db: ctx.db,
      id: ctx.params.id,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      isCommittee: committee,
      now: new Date().toISOString(),
    });
  });

  // ⛔ P11 · E141 + E148①：**改签**（更正内容/分数 + **R2 后补**跨领域签字）。
  router.add('POST', '/api/stages/:stageId/enterprise-confirmations/:id/resign', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const committee = isCommittee(ctx);
    // ⚠️ 评委**也要能进这个端点**（给自己补签 R2 双签的另一半）⇒ 闸门是「企业席 或 组委会 或 本赛段评委」。
    const isJudge = !!getStageJudge(ctx.db, ctx.params.stageId, ctx.user.id);
    if (!isEnterpriseSeat(ctx) && !committee && !isJudge) {
      throw new AppError(403, 'FORBIDDEN', '只有出题企业、组委会或本赛段评委可以改签企业确认');
    }
    // ⛔ crossJudgeId 允许**显式传 null**（= 撤销已补的签字）⇒ 用 `!== undefined` 判「有没有传」
    const hasCross = Object.prototype.hasOwnProperty.call(ctx.body ?? {}, 'crossJudgeId');
    return resignEnterpriseConfirmation({
      db: ctx.db,
      id: ctx.params.id,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      isCommittee: committee,
      rawScore: ctx.body?.rawScore ?? null,
      content: ctx.body?.content ?? null,
      crossJudgeId: hasCross ? (ctx.body.crossJudgeId || null) : undefined,
      now: new Date().toISOString(),
    });
  });

  router.add('POST', '/api/stages/:stageId/recusals', async (ctx) => {
    const stageId = ctx.params.stageId;
    const committee = isCommittee(ctx);
    // ⛔ 不能代他人申报回避（父代理预审修正 ①）
    //    组委会代录不受 `score:write` 约束 —— 否则「有 stage:compute 的人」反而不能代录
    if (!committee) {
      requireStageCapability(ctx, 'score:write');
    }
    const judgeId = ctx.body?.judgeId ?? ctx.user.id;
    if (judgeId !== ctx.user.id && !committee) {
      throw new AppError(403, 'FORBIDDEN', '不能代他人申报回避（组委会可代录）');
    }
    if (!getStageJudge(ctx.db, stageId, judgeId)) {
      throw new AppError(404, 'JUDGE_NOT_ASSIGNED', '该评委未被分配到本赛段');
    }
    // ⛔ 终审修正 M-4：回避的**撤销**（reinstated）原来只有领域层读侧、没有写路径 ——
    //    评委误报回避后，其分数被永久剔除，产品内**没有任何途径撤销**。
    //    ⛔ 撤销**只能由组委会**做：自己申报又自己撤销 = 绕开回避（想不评就不评）。
    //    所以撤销的权限闸门必须比申报**更严**。
    const recusalAction = ctx.body?.action ?? 'recused';
    if (recusalAction === 'reinstated') {
      if (!committee) {
        throw new AppError(403, 'FORBIDDEN', '撤销回避只能由组委会执行');
      }
      return reinstateRecusal({
        db: ctx.db,
        stageId,
        judgeId,
        teamId: ctx.body?.teamId ?? null,
        reason: ctx.body?.reason,
        actorId: ctx.user.id,
        now: new Date().toISOString(),
      });
    }
    if (recusalAction !== 'recused') {
      throw new AppError(400, 'INVALID_RECUSAL_ACTION', `未知的回避动作：${recusalAction}`);
    }
    return declareRecusal({
      db: ctx.db,
      stageId,
      judgeId,
      teamId: ctx.body?.teamId ?? null,
      reason: ctx.body?.reason,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
  });

  // ⛔ P10：回避台账的**读口**（以前只有 POST ⇒ 前端只能显示「本次会话刚提交的」）。
  //
  // ⚠️ 权限口径（与 `POST /api/stages/:stageId/recusals` 的 isCommittee **完全一致**）：
  //   · **登录即可**读，但普通用户**只看自己的**（服务层收窄到 judge_id = 本人）；
  //   · **组委会**（`stage:compute`）看**全部**（含别的评委的记录）。
  //   ⛔ 「看全部」只给组委会 —— 回避原因是利益冲突（供应方 / 投资方 / 前雇主），
  //      让所有评委互相看见对方的回避理由，等于把「谁跟哪支队有关系」广播出去。
  //
  // ⚠️ 三态状态码：赛段不存在 → 404（STAGE_NOT_FOUND）；赛段存在但没有记录
  //    → **200 + `{ items: [] }`**（⛔ 不是 404 —— 列表端点没有记录是常态，不是错误）。
  router.add('GET', '/api/stages/:stageId/recusals', async (ctx) => {
    requireUser(ctx);
    return getRecusalLedger({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: { userId: ctx.user.id, isAdmin: isCommittee(ctx) },
    });
  });

  // ⛔ compute 是显式动作：发布权在「stage:compute」能力（组委会）
  router.add('POST', '/api/stages/:stageId/compute', async (ctx) => {
    requireStageCapability(ctx, 'stage:compute');
    return computeStage({
      db: ctx.db,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  router.add('GET', '/api/stages/:stageId/computations/:computationId', async (ctx) => {
    requireStageCapability(ctx, 'audit:read');
    return getComputation({
      db: ctx.db,
      id: ctx.params.computationId,
      stageId: ctx.params.stageId,
    });
  });
}
```

> **【2026-10-21 漂移审计修正 N-1（审计报告未覆盖，本次新发现）】**
> **原来错在哪**：本文件（以及 P2 计划里所有路由守卫）原来这样构造领域错误：
> ```javascript
> const e = new Error('未登录');
> e.status = 401;
> e.code = 'UNAUTHENTICATED';
> throw e;
> ```
> **为什么错**：P0 终审 I-C 把错误分支收口成
> `const message = err instanceof AppError ? err.message : '请求无效';` ——
> **裸 `Error` 不是 `AppError`** → `message` 被替换成通用文案「请求无效」，
> 计划里想给用户看的「未登录」/「缺少能力：score:write」**全部被吞掉**。
> `code` 还能出去（`domainCode()` 只过滤 `ERR_` 前缀），于是响应变成
> `{"error":{"code":"UNAUTHENTICATED","message":"请求无效"}}` ——
> 状态码对、文案丢，**属于静默的行为回退**，而且没有任何测试会拦（断言多半只看 status）。
> 审计报告 §3 检查项 2 声称「未发现任何 `new Error()` + 挂 `.status` 的裸错误构造」——
> **该结论不成立**，P2 的这个文件就是反例（本条为本次新发现，已修）。
> **改成什么**：改用 P0 建立的 `src/errors.js` 的 `AppError`（**status-first**）：
> `throw new AppError(401, 'UNAUTHENTICATED', '未登录')` /
> `throw new AppError(403, 'FORBIDDEN', \`缺少能力：${capability}\`)`，
> 并在文件顶部加 `import { AppError } from '../../errors.js';`。
> **⚠️ 本条不只这一处**：本计划的**三个服务层**也各有一个 `fail()` 辅助函数用同样的写法 ——
> `src/services/review.js`（`fail(status, code, message, detail)`）、
> `src/services/tiebreak.js`（`fail(status, code, message)`）、
> `src/services/compute.js`（`fail(status, code, message)`）。
> 三处**一律改为** `appError(status, code, message, detail || undefined)`
> （`detail || undefined` 保留了原来 `if (detail)` 的「falsy 就不设」语义），
> 并各自加 `import { appError } from '../errors.js';`。
> 受影响的具体文案：`赛段不存在`（404）、`缺少规则配置，拒绝计算`（500）、
> `赛段 X 指向的权重表 Y 不存在`（500）—— 照原写法它们**全部**会被换成「请求无效」。
> **依据**：P0 终态 `platform/src/errors.js`（`AppError(status, code, message, detail)`，
> 文件头明写「全项目统一由这里产生领域错误」）+ P1 终态
> `platform/src/http/routes/registration.js` 的同一写法（`throw new AppError(401, 'UNAUTHENTICATED', '未登录')`）。

- [ ] **Step 7: 修改 rules/scoring-initial.json 与 rules/scoring-final.json**

`platform/rules/scoring-initial.json`（在 `minJudgesForTrim` 之后、`dimensions` 之前插入）：

```json
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

`platform/rules/scoring-final.json`（同位置插入；决赛下限 ≥9，R-JDG-10）：

```json
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
    // ⛔ 为什么要在这里 fail-fast（而不是等到运行时才报）：
    //    这些字段直接决定「谁有投票权」「自由命题组的企业项由谁顶」——
    //    写错时不会崩，会**静默算出一份错的榜单**（与「权重合计≠100% 拒绝启动」同一类病）。
    const pool = cfg.judgePool;
    if (!pool) {
      push(`scoring.${key} 缺少 judgePool 段（R-JDG-10 / R-JDG-11）`);
    } else {
      if (!(Number(pool.minJudgesPerDimension) > 0)) {
        push(`scoring.${key} judgePool.minJudgesPerDimension 必须 > 0`);
      }
      if (Number(pool.minEnterpriseSeatShare) < 0 || Number(pool.minEnterpriseSeatShare) > 1) {
        push(`scoring.${key} judgePool.minEnterpriseSeatShare 必须在 0..1`);
      }
      if (Number(pool.maxExpertSeatShare) < 0 || Number(pool.maxExpertSeatShare) > 1) {
        push(`scoring.${key} judgePool.maxExpertSeatShare 必须在 0..1`);
      }
      if (!Array.isArray(pool.votingSeats) || !pool.votingSeats.length) {
        push(`scoring.${key} judgePool.votingSeats 缺失`);
      }
      if (!Array.isArray(pool.nonVotingSeats) || !pool.nonVotingSeats.length) {
        push(`scoring.${key} judgePool.nonVotingSeats 缺失`);
      }
    }
    const demand = cfg.freeBrief?.judgeDimension;
    if (!demand) {
      push(`scoring.${key} 缺少 freeBrief.judgeDimension（R-JDG-08 R4）`);
    } else if (!cfg.dimensions.some((d) => d.key === demand && d.seat === 'judge')) {
      push(`scoring.${key} freeBrief.judgeDimension=${demand} 必须是一个评委席维度`);
    }
    if (cfg.selfEvalThreshold != null && Number(cfg.selfEvalThreshold) < 0) {
      push(`scoring.${key} selfEvalThreshold 必须 ≥ 0`);
    }
    if (cfg.trimmedIterations != null && !(Number.isInteger(cfg.trimmedIterations) && cfg.trimmedIterations >= 1)) {
      push(`scoring.${key} trimmedIterations 必须是 ≥1 的整数`);
    }
    if (cfg.bayesPriorStrength != null && !(Number.isFinite(cfg.bayesPriorStrength) && cfg.bayesPriorStrength >= 0)) {
      push(`scoring.${key} bayesPriorStrength 必须是 ≥0 的有限数`);
    }
```

> ⚠️ **写法统一**：本项目 `validateRules` 里的报错收集函数名是 **`push`**（`const push = (msg) => errors.push(msg);`）。
> 原计划片段写的是 `errors.push(...)` —— **两者行为完全相同**（`errors` 就在同一函数作用域里），
> 但该循环内**其余全部检查项用的都是 `push(...)`**。现在统一成 `push(...)`，
> 免得同一段里两种写法混着，让「这行到底累加到哪」变得需要读心。

- [ ] **Step 9: 修改 src/server.js（注册评审路由）**

在 `import` 区加入：

```javascript
import { registerReviewRoutes } from './http/routes/review.js';
```

在 `createApp` 内、P1 的三组路由注册之后加入：

```javascript
  // P2 评审 API（报名/组队等 P1 路由由 P1 追加，不要互相覆盖）
  registerReviewRoutes(router);
```

> ⚠️ **位置说明**：原计划写的是「`router.add('GET', '/api/me', ...)` 之后」。
> 实际实现放在 **P1 三组路由注册之后**（`registerRegistrationRoutes` / `registerTaskPackageRoutes` /
> `registerTeamRoutes` 之后、`/api/health` 之前）—— 理由是「按阶段分组注册」比「按具体某条路由的位置」
> 更不容易在后续阶段插队出错，且与 P1 已有代码的组织方式一致。行为无差异（注册顺序不影响路由匹配：
> `router.match` 按逐段比较排序，静态段恒胜参数段）。

- [ ] **Step 10: 运行测试确认通过**

Run: `cd platform && node --test test/scoring.test.js test/compute.test.js test/review-api.test.js test/review-service.test.js`
Expected: PASS（22 + 15 + 29 + 25 = 91 个测试全过）

- [ ] **Step 11: 全量测试**

Run: `cd platform && node --test`
Expected: 全部通过（P2 全量 517/517）

- [ ] **Step 12: 提交**

```bash
cd platform && git add src/domain/scoring.js src/domain/enterprise-seat.js src/services/compute.js src/services/review.js src/db/repo/computations.js src/db/repo/reviews.js src/db/repo/teams.js src/http/routes/review.js src/config.js src/server.js rules scripts/seed.js test/scoring.test.js test/compute.test.js test/review-api.test.js test/review-service.test.js
git commit -m "feat(P2): scoreStage 总装、compute 快照服务与 9 条评审 API"
```

### Task 8 的独立预审与变异检验（2026-10-21）

**预审结论**：**不能过** —— 1 条 Critical + 5 条 Important + 8 条 Minor + 5 条规格歧义。
全部已修，修复登记为 **D-29 ~ D-36**（见文末偏差表）。

| 级别 | 问题 | 修法 | 登记 |
|---|---|---|---|
| **Critical** | 任何持有 `score:write` 的人都能替**别人家**的队签一条「非本赛道」的企业确认 → R1 触发 → 该队企业席（初赛 10% / 决赛 25%）整段作废，合法 90 分被一条伪造记录**连坐**掉 | 写入口必须核验「签署人 = 该队任务包的出题企业」+ `signoff:create` 能力点；领域层 R1 只认**有效**的非本赛道记录，且本赛道企业已合法确认时不再降权 | D-31 / D-30 |
| Important | 评委能给**别的届期**的队打分 → 外队进榜；队伍不存在时外键报错漏到 HTTP 层 → **500**（破坏三态状态码） | 写入口统一按「本赛段名册」判定 → 404 `TEAM_NOT_IN_STAGE` | D-33 |
| Important | 重算**不回收** `stage_results` → 「旧名次 + 新总分」并排躺在一行；撤掉全部打分的队伍旧行仍在 | 重算前同事务清场：名次/并列/积分置 NULL + 删掉本轮无分的旧行 | D-34 |
| Important | 维度键不校验 → 评委能对 `seat='self'` 的维度打分 → 「自评只能本队成员」被绕开，自评栏归评委 | 写入口按权重表校验维度白名单（非评委席维度 → 403）；领域层再兜一道 | D-32 |
| Important | R4 替代维度没有评委分 → 企业席静默变 0（自由命题组白丢 20%），告警却写着「改由评委打分」 | 显式告警 `R4_substitute_no_scores` | — |
| Important | 自评席维度**没有**同维度评委分可比 → R-JDG-13 恒不触发 → 队伍把自评填到 100 就是白拿 5% | 自评席维度与「该队评委席分」比，超阈值则对齐（不加分） | D-29 |
| Minor | 软删除的打分仍计入计算；改分不留旧分；席位分的真实分母没进 trace；`review-state` 无权限闸门；组委会代录回避受 `score:write` 约束 | 逐条修复 | D-35 / D-36 |

**变异检验**（独立脚本 `/tmp/p2t8/mutate.mjs`，62 个变异体，测试集 = scoring / compute /
review-api / review-service / config 五个文件）：
`KILLED 61 / 等价变异体 1 / 存活 0 / 构造失败 0`。
唯一的存活者是 **C12**（`listStageTeams` 的 catch 吞掉一切错误）—— 已显式标注为**等价变异体**：
测试里不会触发任何错误，两条路径结果完全相同（按构造正确性接受，不追求用例会话覆盖）。

存活变异体全部转成了**回归用例**（不靠「变异体恰好没被抓住」蒙混）：
R02（签字人一致性）、V02/V04（服务端的名册边界）、N02（企业席身份）、E02（无效记录不触发 R1）。
> ⚠️ 其中 V02 一度「存活」的原因是**变异脚本没跑 `test/review-service.test.js`**
> —— 覆盖它的那条用例正好在那个文件里。**变异脚本的测试集必须覆盖被测文件的全部用例**，
> 否则「存活」只说明脚本漏跑了文件，不说明代码没被测。

> **⚠️ 变异构造自身失效的三个坑（本轮又踩到，记录在案）**：
> ① **改配置缺省值等于没改**：`minJudges: config.minJudgesForTrim ?? 5` 里把 `?? 5` 改成 `?? 6`
>    是**零效果**的 —— 配置永远有值，`??` 分支走不到。必须改**取值本身**（`+ 1`）。
> ② **锚点会随重构漂移**：本轮把评分装配拆成「评委席循环 + 自评席循环」后，
>    三个旧锚点全部命中 0 次（`if (!selfSeatKeySet.has(k)) {` 等）→ 变异「构造失败」而非「存活」，
>    两者含义完全不同，必须分开统计。
> ③ **两个闸门会互相掩盖**：企业确认的「只有企业席能签」与「必须是自己出的题」，
>    单独去掉任意一个，用例都仍然绿 —— 因为另一个会先拒。
>    补法是**造出让另一个闸门放行的场景**（给对手企业 `signoff:create`、
>    让出题企业本人没有 `signoff:create`），否则等于没测。

> **【Task 8 的已知限制（移交 P3）】**
> ① **赛段名册目前是届期级的**：`stages → edition_id → teams`，
>    所以「后段赛事的队伍」会出现在初赛名册里并参与初赛计分。
>    本轮已经把「名册外的队伍」挡在写入口之外（D-33），
>    但**赛段级队伍边界**需要一张 `stage_team` 表 —— 属于迁移层改动，登记在 P3。
> ② **缺分维度被剔出席位分的分母**（`seatScore` 的口径），
>    于是「缺分多的队」拿到的是「已有维度上的相对加权平均」。
>    本轮已把席位分的**真实分母**记进 `trace.perTeam[teamId].seatPWeightSum`，
>    但口径本身要不要改（如缺分计 0）留给 P3 与规则委员会裁决。
> ③ **R1 收窄后，「本赛道企业已确认 + 别的企业也签了」的组合**按 D-30 走
>    「保留本赛道签字 + 记 R1 告警」；如果规则委员会认为这种情况应当更严，
>    改 `src/domain/enterprise-seat.js` 一处即可。

---

### Task 9: SSE 评审进度推送（兑现 `web/api.js` 的承诺）

**Files:**
- Create: `platform/src/http/sse.js`
- Modify: `platform/src/server.js`（新增**独立于 router** 的 SSE 分支；`createApp` / `handle` 签名不变）
- Modify: `platform/src/http/routes/review.js`（提交评审成功后发布一条进度事件）
- Test: `platform/test/sse.test.js`

**Interfaces:**
- Consumes: P0 的 `createApp` / `handle`（`src/server.js`，**签名不变**）；server.js 内部的 `parseCookie` / `resolveSession` / `getUserById`（模块私有，只在 server.js 内使用）
- Produces:
  - `parseSsePath(url)` → `{ stageId }` 或 `null`
  - `openSseStream(res)` → 写 200 + `text/event-stream` 响应头
  - `sendSseEvent(res, event, data)` → 写一帧（`event:` + 单行 `data:` + 空行）；响应已结束则返回 `false`
  - `closeSseStream(res)` → 结束响应
  - `createSseHub()` → `{ add, remove, publish, size, closeAll }`
  - `reviewEvents` → 评审进度事件中心（`createSseHub()` 的单例）
  - 端点：`GET /api/stages/:stageId/events`（SSE，需登录；评审进度推送）

> **⚠️ 为什么这个 Task 必须落在 P2（本 Task 是 I-6 的唯一落点）**
> P0 终态 `platform/web/api.js:28-30` 的 `subscribe()` 明确写着：
> 「SSE：单向推送，走普通 HTTP，穿透代理容易，EventSource 自带断线重连
> ⚠️ SSE 端点在 **P2** 才实现（src/http/sse.js）—— P0/P1 调用会 404，不要在 P0/P1 用。」
> 而 P2–P6 五份计划**全部没有承接**这个承诺（`grep -c 'sse\.js'` 五份全为 0）——
> 结果是一条**指向不存在实现的活引用**：`web/api.js` 永远走 404，注释却指向 P2。
> 审计报告 I-6 给的两条路里，②「改 P0 的 `web/api.js` 注释」**落在 `platform/` 下**（P0 的地盘，
> 本阶段不得改动），因此本 Task 走 ①：**P2 补齐 `src/http/sse.js` 与对应端点**。

- [ ] **Step 1: 写失败的测试**

`platform/test/sse.test.js`：

```javascript
// platform/test/sse.test.js — SSE 评审进度推送
// 依据：P0 终态 web/api.js:28-30 承诺「SSE 端点在 P2 才实现（src/http/sse.js）」
//   + 设计文档 §4.3 的目录清单 + INTERFACES.md §3（API（P2））
//
// ⚠️ 本轮（2026-10-21 父代理预审）追加的用例：
//   ① **权限闸门**：规格只要求「登录」→ 任何登录用户都能订阅任意赛段，
//      等于把「谁在什么时候提交了评分」广播给所有人。现在要求
//      组委会 / score:read / 本赛段评委。
//   ② **畸形百分号编码**不得让 parseSsePath 抛 URIError（P0 的教训）。
//   ③ **心跳注释帧**存在（否则中间代理 60s 掐线，前端每分钟重连）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import {
  parseSsePath, sendSseEvent, sendSseComment, createSseHub, reviewEvents,
} from '../src/http/sse.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sse-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const webDir = mkdtempSync(join(tmpdir(), 'hks-sse-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  const app = createApp({ db, rules, webDir });

  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13800000901', password: 'pw123' });
  const outsider = createUser(db, { name: '路人甲', phone: '13800000902', password: 'pw123' });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });

  return {
    db, close, dataDir, webDir, app, stage, judge, outsider,
    tokenJudge: createSession(db, judge.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function cleanup(ctx) {
  reviewEvents.closeAll();
  rmSync(ctx.dataDir, { recursive: true, force: true });
  rmSync(ctx.webDir, { recursive: true, force: true });
  ctx.close();
}

/** 假响应：只记录 writeHead / write / end（测帧格式用，不必起真服务器）。 */
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    chunks,
    writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

/**
 * 开一条 SSE 连接，返回一个小工具对象。
 * ⚠️ 错误必须吞掉：客户端主动 destroy 时 res 会抛 ECONNRESET，
 *    不接 error 处理器会变成 unhandled → 整个测试文件崩掉。
 */
function openSse(port, path, token) {
  const chunks = [];
  let status = null;
  let headers = null;
  let reqRef = null;
  const ready = new Promise((resolve, reject) => {
    reqRef = http.get(
      {
        host: '127.0.0.1', port, path,
        headers: token ? { cookie: `hk_session=${token}` } : {},
      },
      (res) => {
        status = res.statusCode;
        headers = res.headers;
        res.on('data', (c) => chunks.push(c.toString()));
        res.on('error', () => {});
        resolve();
      },
    );
    // ⚠️ 连接出错时**必须 reject**：只吞掉错误的话，`ready` 永远不 settle
    //    → 等待它的用例**永久挂起**（而不是干净地失败）。
    reqRef.on('error', (e) => reject(e));
  });
  return {
    ready,
    get status() { return status; },
    get headers() { return headers; },
    text: () => chunks.join(''),
    waitForEvent(name, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          const t = chunks.join('');
          if (t.includes(`event: ${name}`)) return resolve(t);
          if (Date.now() > deadline) return reject(new Error(`等待事件 ${name} 超时`));
          setTimeout(tick, 20);
        };
        tick();
      });
    },
    close() { try { reqRef?.destroy(); } catch { /* ignore */ } },
  };
}

/** 轮询等待某个条件成立（用于「客户端断开后订阅者被摘掉」这类异步收尾）。 */
async function waitUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

test('parseSsePath 能解析 /api/stages/:stageId/events，非 SSE 路径返回 null', () => {
  assert.deepEqual(parseSsePath('/api/stages/st-1/events'), { stageId: 'st-1' });
  assert.deepEqual(parseSsePath('/api/stages/st-1/events?x=1'), { stageId: 'st-1' });
  assert.equal(parseSsePath('/api/stages/st-1/reviews'), null);
  assert.equal(parseSsePath('/api/health'), null);
  // ⛔ 路径必须在 `events` **之后**就结束（或紧跟一个 `?`）：
  //    `/eventsX` 不是 SSE 路径 —— 否则后缀匹配会误开一条流。
  assert.equal(parseSsePath('/api/stages/st-1/eventsX'), null);
  assert.equal(parseSsePath('/api/stages/st-1/events/'), null);
});

test('⛔ 畸形百分号编码不得让 parseSsePath 抛错（P0 的教训）', () => {
  assert.equal(parseSsePath('/api/stages/%E0%A4%A/events'), null);
  assert.equal(parseSsePath('/api/stages/%/events'), null);
});

test('sendSseEvent 写出的帧符合 SSE 规范：event + 单行 data + 空行结尾', () => {
  const res = fakeRes();
  assert.equal(sendSseEvent(res, 'review.progress', { stageId: 'st-1' }), true);
  assert.equal(res.text(), 'event: review.progress\ndata: {"stageId":"st-1"}\n\n');
});

test('sendSseEvent 对已结束的响应静默返回 false（客户端已断开）', () => {
  const res = fakeRes();
  res.end();
  assert.equal(sendSseEvent(res, 'x', {}), false);
  assert.equal(res.text(), '');
});

test('sendSseEvent 的载荷在数据缺省时必须是 null（不能写出 undefined）', () => {
  const res = fakeRes();
  assert.equal(sendSseEvent(res, 'x'), true);
  assert.equal(res.text(), 'event: x\ndata: null\n\n');
});

test('sendSseComment 写的是注释帧（心跳），EventSource 会忽略它', () => {
  const res = fakeRes();
  assert.equal(sendSseComment(res, 'ping'), true);
  assert.equal(res.text(), ': ping\n\n');
});

test('sendSseComment 对已结束的响应静默返回 false', () => {
  const res = fakeRes();
  res.end();
  assert.equal(sendSseComment(res, 'ping'), false);
  assert.equal(res.text(), '');
});

test('createSseHub 的 publish 只发给同 topic 的订阅者', () => {
  const hub = createSseHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.add(a, 'stage:st-1');
  hub.add(b, 'stage:st-2');
  assert.equal(hub.publish('review.progress', { n: 1 }, 'stage:st-1'), 1);
  assert.ok(a.text().includes('event: review.progress'));
  assert.equal(b.text(), '');
  hub.closeAll();
});

test('createSseHub 的 closeAll 会结束所有订阅连接并清空订阅者', () => {
  const hub = createSseHub();
  const a = fakeRes();
  hub.add(a, 'stage:st-1');
  assert.equal(hub.size, 1);
  hub.closeAll();
  assert.equal(a.writableEnded, true);
  assert.equal(hub.size, 0);
});

test('GET /api/stages/:stageId/events 建立 SSE 连接并先发 connected 首帧', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // ⚠️ 断言必须放在 promise **之外**：断言写在 http 回调里抛错时，
    //    promise 既不 resolve 也不 reject → 用例**永远挂起**（而不是干净地失败）。
    //    这会让变异检出信号从「断言失败」退化成「测试挂住」，很难区分。
    const frame = await new Promise((resolve, reject) => {
      // ⚠️ 用**墙钟定时器**而不是 req.setTimeout：后者是 socket 超时，
      //    响应一旦结束就被清掉 → 承诺永不 settle → 用例挂起而不是失败。
      const guard = setTimeout(() => reject(new Error('SSE 首帧超时')), 3000);
      const done = (v) => { clearTimeout(guard); resolve(v); };
      const fail = (e) => { clearTimeout(guard); reject(e); };
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}` },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString();
            if (buf.includes('\n\n')) done({ buf, status: res.statusCode, headers: res.headers });
          });
          res.on('end', () => done({ buf, status: res.statusCode, headers: res.headers }));
          res.on('error', fail);
        },
      );
      req.on('error', fail);
    });
    assert.equal(frame.status, 200);
    assert.match(String(frame.headers['content-type']), /text\/event-stream/);
    assert.match(frame.buf, /^event: connected\n/);
    assert.match(frame.buf, new RegExp(`"stageId":"${ctx.stage.id}"`));
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 未登录订阅 SSE → 401', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/stages/${ctx.stage.id}/events` },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('超时')));
    });
    assert.equal(status, 401);
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 无权限的人订阅 SSE → 403（登录不等于有权看评审进度）', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenOutsider}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('超时')));
    });
    assert.equal(status, 403);
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 权限闸门的 5 条放行路径都真的放行（score:read 赛段/全局、stage:compute 赛段/全局、本赛段评委）', async () => {
  const ctx = setup();
  insertCapability(ctx.db, 'score:read', '读取评分');
  insertCapability(ctx.db, 'stage:compute', '发榜');
  const users = {};
  const scopes = [
    ['u1', 'score:read', 'stage'],
    ['u2', 'score:read', 'global'],
    ['u3', 'stage:compute', 'stage'],
    ['u4', 'stage:compute', 'global'],
  ];
  let phone = 13800001000;
  for (const [name, capability, scopeType] of scopes) {
    const u = createUser(ctx.db, { name, phone: String(phone++), password: 'pw123' });
    grantAssignment(ctx.db, {
      userId: u.id, capability, scopeType, scopeId: scopeType === 'stage' ? ctx.stage.id : null, grantedBy: null,
    });
    users[name] = { id: u.id, token: createSession(ctx.db, u.id).token, desc: `${capability}@${scopeType}` };
  }

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const [name, u] of Object.entries(users)) {
      const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, u.token);
      await sse.ready;
      assert.equal(sse.status, 200, `${name}（${u.desc}）应被放行`);
      sse.close();
    }
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 端到端：评委提交评分 → 同赛段的 SSE 订阅者收到 review.progress（载荷不含评委身份）', async () => {
  const ctx = setup();
  // 评分需要：score:write 能力点 + 一支在本赛段名册内的队伍
  insertCapability(ctx.db, 'score:write', '写入评分');
  grantAssignment(ctx.db, {
    userId: ctx.judge.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: null,
  });
  const captain = createUser(ctx.db, { name: '队长', phone: '13800000903', password: 'pw123' });
  const team = insertTeam(ctx.db, {
    editionId: ctx.stage.edition_id, name: '一队', captainId: captain.id, status: 'active', now: NOW,
  });

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const post = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/reviews`,
        headers: { cookie: `hk_session=${ctx.tokenJudge}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => reject(new Error('提交超时')));
    req.end(payload);
  });

  try {
    // 先建立 SSE 连接，拿到首帧后再提交评分
    // ⚠️ 提交结果**不能**在 setTimeout 回调里断言：那里抛错 = unhandled rejection，
    //    既不会让用例失败、也不会让 promise settle → 用例挂起。改成把结果交给主流程断言。
    let settlePost;
    const posted = new Promise((resolve) => { settlePost = resolve; });
    const frames = await new Promise((resolve, reject) => {
      const chunks = [];
      // ⚠️ 墙钟定时器 + 「响应结束即失败」双保险：
      //    只靠 req.setTimeout 的话，错误响应一结束 socket 超时就被清掉 → 挂起。
      const guard = setTimeout(() => reject(new Error('SSE 未收到进度事件')), 5000);
      const done = (v) => { clearTimeout(guard); resolve(v); };
      const fail = (e) => { clearTimeout(guard); reject(e); };
      const req = http.get(
        {
          host: '127.0.0.1', port, path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}` },
        },
        (res) => {
          res.on('data', (c) => {
            chunks.push(c.toString());
            const text = chunks.join('');
            if (text.includes('event: review.progress')) done(text);
          });
          // 响应结束却没等到进度事件 → 失败（错误响应就是这种：403 / 404 的 JSON 体）
          res.on('end', () => fail(new Error(`SSE 响应已结束但未收到进度事件（status=${res.statusCode}）`)));
          res.on('error', fail);
        },
      );
      req.on('error', fail);
      // 连接建好后稍等一下再提交，确保订阅已登记
      setTimeout(() => {
        post({ items: [{ teamId: team.id, dimension: 'innovation', rawScore: 80 }] })
          .then(settlePost, (e) => fail(e));
      }, 150);
    });
    const r = await posted;
    assert.equal(r.status, 200, `评分提交失败：${r.body}`);
    assert.match(frames, /event: review\.progress/);
    assert.ok(!frames.includes('judgeId'), '载荷不得带评委身份（可见性由 API 层过滤）');
    // 载荷形状必须钉死：stageId 指向赛段、at 是时间戳字符串、**没有** judgeId
    const lines = frames.split('\n');
    const idx = lines.findIndex((l) => l === 'event: review.progress');
    assert.ok(idx >= 0, '未找到 review.progress 帧');
    const dataLine = lines[idx + 1];
    assert.ok(dataLine.startsWith('data: '), `帧格式不对：${dataLine}`);
    const payload = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(payload.stageId, ctx.stage.id);
    assert.equal(typeof payload.at, 'string');
    assert.ok(!('judgeId' in payload));
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 父代理变异检验追加的用例（2026-10-21）
//   —— 这些行为在实现里是对的，但**没有用例钉住** → 变异体会存活。
//      先补用例再跑变异，是「先跑后派」纪律的体现。
// ═══════════════════════════════════════════════════════════════════════════

test('parseSsePath 必须解码百分号编码的 stageId', () => {
  assert.deepEqual(parseSsePath('/api/stages/a%20b/events'), { stageId: 'a b' });
  assert.deepEqual(parseSsePath('/api/stages/%E5%8F%82%E8%B5%9B/events'), { stageId: '参赛' });
});

test('⛔ SSE 响应头必须带 X-Accel-Buffering: no（否则 nginx 缓冲 → 看起来「不推送」）', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  try {
    await sse.ready;
    assert.equal(sse.status, 200);
    assert.match(String(sse.headers['content-type']), /text\/event-stream/);
    assert.match(String(sse.headers['cache-control']), /no-cache/);
    assert.equal(sse.headers['x-accel-buffering'], 'no');
  } finally {
    sse.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 非 GET 方法不得开 SSE（方法闸门）→ 404', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}` },
        },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('超时')));
      req.end();
    });
    assert.equal(status, 404);
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 客户端断开后订阅者必须被摘掉（否则连接泄漏，进程内存单调增长）', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  try {
    await sse.ready;
    await sse.waitForEvent('connected');
    assert.ok(reviewEvents.size >= 1, '订阅后应登记到事件中心');
    sse.close();
    const ok = await waitUntil(() => reviewEvents.size === 0);
    assert.equal(ok, true, `断开后仍有 ${reviewEvents.size} 个订阅者未摘除`);
  } finally {
    sse.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 跨赛段串台：赛段 B 的订阅者不得收到赛段 A 的进度事件', async () => {
  const ctx = setup();
  // 第二个赛段：同一评委也在里面 → 对 B 也有订阅权限
  const stage2 = insertStage(ctx.db, {
    editionId: ctx.stage.edition_id, key: 's2', name: '复赛', kind: 'final',
    startsAt: '2026-10-11', endsAt: '2026-10-20', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(ctx.db, { stageId: stage2.id, userId: ctx.judge.id, seat: 'judge', now: NOW });
  insertCapability(ctx.db, 'score:write', '写入评分');
  grantAssignment(ctx.db, {
    userId: ctx.judge.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: null,
  });
  const captain = createUser(ctx.db, { name: '队长二', phone: '13800000904', password: 'pw123' });
  const team = insertTeam(ctx.db, {
    editionId: ctx.stage.edition_id, name: '二队', captainId: captain.id, status: 'active', now: NOW,
  });

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const a = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  const b = openSse(port, `/api/stages/${stage2.id}/events`, ctx.tokenJudge);
  try {
    await a.ready;
    await b.ready;
    await a.waitForEvent('connected');
    await b.waitForEvent('connected');
    const payload = JSON.stringify({ items: [{ teamId: team.id, dimension: 'innovation', rawScore: 80 }] });
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/reviews`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c.toString(); });
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('提交超时')));
      req.end(payload);
    });
    assert.equal(r.status, 200, `评分提交失败：${r.body}`);
    await a.waitForEvent('review.progress');
    await new Promise((x) => setTimeout(x, 300));
    assert.ok(
      !b.text().includes('event: review.progress'),
      '赛段 B 的订阅者不得收到赛段 A 的进度事件（跨赛段串台）',
    );
  } finally {
    a.close();
    b.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 提交失败（分数越界）不得推送进度事件', async () => {
  const ctx = setup();
  insertCapability(ctx.db, 'score:write', '写入评分');
  grantAssignment(ctx.db, {
    userId: ctx.judge.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: null,
  });
  const captain = createUser(ctx.db, { name: '队长三', phone: '13800000905', password: 'pw123' });
  const team = insertTeam(ctx.db, {
    editionId: ctx.stage.edition_id, name: '三队', captainId: captain.id, status: 'active', now: NOW,
  });

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  try {
    await sse.ready;
    await sse.waitForEvent('connected');
    const payload = JSON.stringify({ items: [{ teamId: team.id, dimension: 'innovation', rawScore: 150 }] });
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/reviews`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c.toString(); });
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('提交超时')));
      req.end(payload);
    });
    assert.equal(r.status, 400, `越界分数应被拒绝：${r.body}`);
    await new Promise((x) => setTimeout(x, 400));
    assert.ok(
      !sse.text().includes('event: review.progress'),
      '失败提交不得触发进度推送（事件只是「有进展」的信号，不该撒谎）',
    );
  } finally {
    sse.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/sse.test.js`
Expected: FAIL —— `Cannot find module '../src/http/sse.js'`

- [ ] **Step 3: 创建 `src/http/sse.js`**

```javascript
// src/http/sse.js — Server-Sent Events（单向推送）
// 依据：设计文档 §4.3 的目录清单（http/ 下含 sse.js）+ P0 终态 `platform/web/api.js:28-30`
//   的明确承诺：「⚠️ SSE 端点在 **P2** 才实现（src/http/sse.js）」—— 本文件就是那个承诺的兑现。
//
// ⚠️ 为什么 SSE **不挂 router**：P0 的 router handler 约定是「返回一个值 → server.js
//    统一 json() 序列化并结束响应」。SSE 要**长期持有这条连接**（多次推帧）——
//    走 router 会被 server.js 的 json() 提前收尾 → 客户端只收到第一帧就断。
//    所以 SSE 走 server.js 里**独立的分支**：自己写头、自己推帧、自己收尾。
//
// ⛔ 帧格式（SSE 规范）：`event: <name>\ndata: <单行 JSON>\n\n`
//    data 里不能有裸换行（会截断帧）→ 一律 JSON.stringify。
// ⛔ 不能用 json() / text() 写响应头 —— 那会把 Content-Type 定死成 application/json。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 2 处修正】
//   ① **畸形百分号编码会让 parseSsePath 抛 URIError** ——
//      P0 的教训（「畸形 URL 编码不能让进程退出」）在这里同样成立：
//      `/api/stages/%E0%A4%A/events` 会让 decodeURIComponent 抛错。
//      现在解析失败**返回 null** → 走正常的路由/400 分支，绝不逸出到 server.js 之外。
//   ② **没有心跳帧**：SSE 连接长时间空闲时，中间的 nginx（proxy_read_timeout 默认 60s）
//      会把连接掐掉 —— 现象是「前端每隔一分钟重连一次」。现在提供 `sendSseComment()`
//      注释帧（`: ping\n\n`），由 server.js 用 `unref()` 的定时器定期发。

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx 默认缓冲响应 → 事件被攒着一起发，前端看起来像「不推送」。
  'X-Accel-Buffering': 'no',
};

/** 解析 SSE 路径：/api/stages/:stageId/events → { stageId }；不是 SSE 路径 → null。 */
export function parseSsePath(url) {
  const m = /^\/api\/stages\/([^/?#]+)\/events(?:\?|$)/.exec(String(url || ''));
  if (!m) return null;
  try {
    return { stageId: decodeURIComponent(m[1]) };
  } catch {
    // 畸形百分号编码：不是合法路径 → 交给上层按「非法 URL」处理（父代理预审修正 ①）
    return null;
  }
}

/** 写 SSE 响应头并保持连接。 */
export function openSseStream(res) {
  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return true;
}

/** 写一帧。响应已结束（客户端断开）时静默返回 false。 */
export function sendSseEvent(res, event, data) {
  if (!res || res.writableEnded) return false;
  const payload = JSON.stringify(data ?? null);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
  return true;
}

/**
 * 写一条 SSE **注释帧**（心跳）。
 * 注释帧以 `:` 开头，EventSource 会忽略它 —— 用途是让中间代理知道连接还活着。
 */
export function sendSseComment(res, text = 'ping') {
  if (!res || res.writableEnded) return false;
  res.write(`: ${text}\n\n`);
  return true;
}

/** 结束 SSE 响应。 */
export function closeSseStream(res) {
  if (res && !res.writableEnded) res.end();
}

/**
 * 事件中心：按 topic 分发的订阅者集合。
 * ⛔ 订阅者（res）在客户端断开时必须被移除 —— 否则连接泄漏，进程内存单调增长。
 *    调用方（server.js）在 res.on('close') 里调 remove()。
 */
export function createSseHub() {
  const clients = new Map(); // res → topic
  return {
    add(res, topic = null) {
      clients.set(res, topic);
      return () => clients.delete(res);
    },
    remove(res) {
      clients.delete(res);
    },
    /** 向同一 topic 的订阅者推一帧，返回送达数。 */
    publish(event, data, topic = null) {
      let sent = 0;
      for (const [res, t] of clients) {
        if (topic !== null && t !== topic) continue;
        if (sendSseEvent(res, event, data)) sent += 1;
      }
      return sent;
    },
    get size() {
      return clients.size;
    },
    /** 结束并清空所有订阅连接（测试收尾用）。 */
    closeAll() {
      for (const res of [...clients.keys()]) {
        closeSseStream(res);
        clients.delete(res);
      }
    },
  };
}

/** 评审进度事件中心（P2 唯一的事件源）。 */
export const reviewEvents = createSseHub();
```

- [ ] **Step 4: 修改 `src/server.js`（新增 SSE 分支）**

在 `import` 区加入：

```javascript
import { parseSsePath, openSseStream, sendSseEvent, sendSseComment, reviewEvents } from './http/sse.js';
import { getStage, getStageJudge } from './db/repo/stages.js';
```

在 `handleRequest()` 里、`if (url.startsWith('/api/')) {` 的 **try 块内、`const match = router.match(req.method, url);` 之前**插入：

```javascript
        // ── P2：SSE（评审进度推送）────────────────────────────────
        // ⚠️ 必须**独立于 router**，且**在 router.match 之前**：
        //    P0 的 router handler 约定是「返回一个值 → server.js 统一 json() 序列化
        //    并结束响应」；SSE 要**长期持有这条连接**（多次推帧）——
        //    挂到 router 上会被 json() 提前收尾，客户端只收到第一帧就断。
        //    放在 router.match 之前还有第二个原因：SSE 路径**不在 router 里**，
        //    若先 match 会直接走 404 分支。
        const ssePath = req.method === 'GET' ? parseSsePath(url) : null;
        if (ssePath) {
          const sseToken = parseCookie(req.headers?.cookie || '')['hk_session'];
          const sseSession = sseToken ? resolveSession(db, sseToken) : null;
          const sseUser = sseSession ? getUserById(db, sseSession.userId) : null;
          if (!sseUser) {
            error(res, 401, 'UNAUTHENTICATED', '未登录');
            return;
          }
          // ⛔ 权限闸门（父代理预审修正）：**登录还不够**。
          //    进度事件流会暴露「谁在什么时候提交了评分」——
          //    任何登录用户都能订阅任意赛段 = 评委行踪可被任意账号看到。
          //    与 review-state 同一套口径：组委会 / 有 score:read 的人 / 本赛段评委。
          const sseStage = getStage(db, ssePath.stageId);
          const sseIsJudge = sseStage
            ? getStageJudge(db, ssePath.stageId, sseUser.id) != null
            : false;
          const sseAllowed = can(sseUser, 'score:read', { scopeType: 'stage', scopeId: ssePath.stageId }, db)
            || can(sseUser, 'score:read', { scopeType: 'global' }, db)
            || can(sseUser, 'stage:compute', { scopeType: 'stage', scopeId: ssePath.stageId }, db)
            || can(sseUser, 'stage:compute', { scopeType: 'global' }, db)
            || sseIsJudge;
          if (!sseAllowed) {
            error(res, 403, 'FORBIDDEN', '没有订阅评审进度的权限');
            return;
          }
          openSseStream(res);
          const topic = `stage:${ssePath.stageId}`;
          reviewEvents.add(res, topic);
          // ⛔ 客户端断开时必须摘掉订阅者 —— 否则连接泄漏，进程内存单调增长。
          //    同一处把心跳定时器也清掉（否则定时器会一直跑）。
          const heartbeat = setInterval(() => sendSseComment(res, 'ping'), 25000);
          if (typeof heartbeat.unref === 'function') heartbeat.unref();
          res.on('close', () => {
            clearInterval(heartbeat);
            reviewEvents.remove(res);
          });
          // 首帧必须给：EventSource 的 onopen 拿不到业务数据，客户端靠它确认订阅成功。
          sendSseEvent(res, 'connected', { stageId: ssePath.stageId, at: new Date().toISOString() });
          return;
        }
```

- [ ] **Step 5: 修改 `src/http/routes/review.js`（提交后发布进度事件）**

在文件顶部加入：

```javascript
import { reviewEvents } from '../sse.js';
```

把 `POST /api/stages/:stageId/reviews` 的 handler 改成（**只改这一条路由**，其余路由不动）：

```javascript
  router.add('POST', '/api/stages/:stageId/reviews', async (ctx) => {
    requireStageCapability(ctx, 'score:write');
    // ⚠️ 维度白名单**不能丢**（D-32）：评委只能给评委席维度打分，
    //    否则评委能对 seat='self' 的维度打分 → 自评栏被评委占掉。
    const items = ctx.body?.items ?? [];
    assertJudgeDimensions(ctx, items);
    const result = await submitReviews({
      db: ctx.db,
      stageId: ctx.params.stageId,
      judgeId: ctx.user.id,
      items,
      requestId: ctx.body?.requestId ?? null,
      now: new Date().toISOString(),
    });
    // 评审进度推送：订阅同一赛段的评审端据此刷新进度条。
    // ⚠️ 发布点在 **HTTP 层**（不是 service 层）：service 不该知道 HTTP 的存在。
    // ⚠️ **载荷不含 judgeId**（D-37）：事件流里带「谁在什么时候提交了评分」，
    //    等于把评委行踪广播给该赛段的每个订阅者。事件只作为**信号**，
    //    客户端收到后重新拉 `review-state` —— 可见性由那一层按观众过滤。
    reviewEvents.publish(
      'review.progress',
      { stageId: ctx.params.stageId, at: new Date().toISOString() },
      `stage:${ctx.params.stageId}`,
    );
    return result;
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/sse.test.js`
Expected: PASS（**20 个测试全过**：sse.test.js 20 —— 规格自带 11 + 变异检验补测 9）

- [ ] **Step 7: 全量测试**

Run: `cd platform && node --test`
Expected: 全部通过（P2 全量 **537/537**）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/http/sse.js src/server.js src/http/routes/review.js test/sse.test.js
git commit -m "feat(P2): SSE 评审进度推送（src/http/sse.js + GET /api/stages/:stageId/events）"
```

> ⚠️ 计划文件本身也在本次提交范围内（仓库根的 `docs/superpowers/plans/…`）——
> 「计划是规格」意味着**计划与实现必须同一次提交落盘**，否则规格与代码会分叉。

> **【2026-10-21 漂移审计修正 I-6】**
> **原来错在哪**：P0 终态 `platform/web/api.js:28-30` 的 `subscribe()` 明写「⚠️ SSE 端点在 **P2**
> 才实现（src/http/sse.js）」，而 P2–P6 五份计划**没有一份承接**（`grep -c 'sse\.js'`
> 五份全为 0，`grep -c 'api\.subscribe'` 亦全为 0）→ 一条**指向不存在实现的活引用**：
> `web/api.js` 的 `subscribe()` 永远是 404 路径，注释却指向 P2。
> **为什么错**：设计文档 §4.3 的目录清单里 `http/` 下确实列了 `sse.js`，P0 又在代码注释里
> 把这条债正式立给了 P2 —— 五份计划无人认领，等于这条债永远悬着。
> **改成什么**：在 P2 增设 **Task 9**（`src/http/sse.js` + 端点 `GET /api/stages/:stageId/events`
> + `src/server.js` 的独立 SSE 分支 + `src/http/routes/review.js` 的进度事件发布 + **20 条用例**）。
> 审计报告给的第 ② 条路（「改 P0 `web/api.js` 的注释」）**落在 `platform/` 目录下**，
> 属 P0 的地盘、本阶段不得改动 → 只能走第 ① 条路「P2 补齐」。
> **依据**：P0 终态 `platform/web/api.js:28-30`（承诺原文）+ 设计文档 §4.3 的目录清单
> （`http/ router.js respond.js body.js static.js sse.js`）+ 审计报告 I-6。
> **接口取舍留痕**：SSE **不挂 router** —— P0 的 router handler 约定是「返回值 → server.js
> 统一 json() 序列化并结束响应」，而 SSE 要长期持有连接（多次推帧），挂 router 上会被
> `json()` 提前收尾 → 客户端只收到第一帧就断。故 SSE 走 `src/server.js` 里**独立于 router**
> 的分支，并放在 `router.match` **之前**（SSE 路径不在 router 里，先 match 会直接走 404）。
> 该分支插在 P0 的 `handleRequest()` try 块内、`const match = router.match(...)` 之前，
> **不动** P0 的 I7-4 handler 返回契约块与 I-C 错误分支（见 C-1 的教训）。

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
| R-JDG-10 | Task 5 / **Task 10** | `checkJudgePool`：初赛每维度 ≥7 / 决赛 ≥9（配置在 `judgePool` 段）。⚠️ **Task 10 补**：Task 5 只交付了纯函数、**零调用方** —— 由 `computeStage` 接线（D-47） |
| R-JDG-11 | Task 5 / **Task 10** | 席构成校验；**观察员无投票权**（提交 403、统计不计入）。⚠️ **Task 10 补**：同上，接线在 `computeStage`（D-47） |
| R-JDG-12 | Task 6 | `submitCalibration` → `calibrations` 表，**不计入评分** |
| R-JDG-13 | Task 5 / Task 8 | `detectSelfEvalDiff`：d>10 要书面说明（不成立则对齐评委分）；d<−10 只提问 |
| R-JDG-14 | Task 6 | 企业确认必须带 `content`，空白签字 400 拒收 |
| R-JDG-19 | Task 7 | `tiebreak_round` + `tiebreak_votes`（一人一票由主键保证）→ 复议分进 trace 供 P3 破同分链 |

---

### Task 10: P2 整分支终审的修复（2 Important + 5 Minor）

> **【2026-10-21 阶段终审闸门】** P2 的 9 个 Task 全部完成后，做了一次**独立实跑审计**
> （verifier 子代理在 `/tmp` 里搭独立探针，不看实现代码、只按契约与计划核对）。
> 结论：**NOT PASS** —— **0 Critical / 2 Important / 5 Minor**，且**全部未在偏差表登记**。
> 两条 Important 都是**已上线接口的可达缺陷**，修复面很小（各 1–3 行），但**必须改掉才能合 main**。
>
> | # | 级别 | 缺陷 | 实跑证据 | 处置 |
> |---|---|---|---|---|
> | **I-1** | **Important** | **`GET /api/stages/:stageId/review-state` 的进度分母只统计「已经出现过打分的维度」** → 真实完成度 20% 时接口报 100%，`missing` 为空 | 探针：2 评委 × 2 队，只交 `innovation` 一个维度 → `total = 4`（应为 2×2×5=20），`dimensionProgress` 里只有 `innovation` 这一个键，其余 4 个评委席维度**完全不可见**。根因：`routes/review.js` 调 `getReviewState` 时**没传 `dimensions`**，服务层于是退回「已出现过的维度」 | 路由把该赛段权重表的**评委席维度全集**传下去。⚠️ **这是计划自身的半截错**：计划 Task 6 的修正 ④ 明写「Task 8 的 API 层应显式传规则里的维度全集，否则『从未有人评过的维度』不会出现在进度里」，而计划自己的 Task 8 路由块**没传** —— 实现与该块逐字一致，于是实现继承了计划的这一半错误 |
> | **I-2** | **Important** | **R-JDG-10 / R-JDG-11 的评委池校验从未接线** —— `checkJudgePool` 在 `platform/src/` 下**零调用方** | `grep -rn "checkJudgePool" platform/src/` → 只有定义，没有调用方。探针：1 名评委的赛段提交评分 → compute → **200**，产出 `total=72` 的榜单，`warnings` 里**无任何评委池告警**（而 `rules/scoring-initial.json` 写着 `minJudgesPerDimension: 7` / `minEnterpriseSeatShare: 0.30`）。单独调 `checkJudgePool` 则报出 3 条错误 | `computeStage` 调用 `checkJudgePool`，不合规时写入 `warnings`（`judge_pool_invalid`）+ 快照 `input.judgePool` / `trace.judgePool`；**不阻断发榜**（口径见 D-47）。权重表缺 `judgePool` 段 → **拒绝计算**。⚠️ 这是「能力被建好却从不校验」的同款病根（P1 Task 3 的 A1、P2 Task 6 的 P2-4） |
> | **M-1** | Minor | `listReviewCells` 不过滤 `deleted_at`，与 D-35 的 `listReviews` 口径不一致 | 软删全部打分后，被删维度仍留在进度分母里 | `listReviewCells` 补 `AND deleted_at IS NULL` |
> | **M-2** | Minor | 「改分走覆盖写 UPDATE、不是追加式 + `supersedes_id`」这条偏离**只在 Task 6 台账里，没进 D 表** | `grep -rc supersedes platform/` → 全为 0（既没有列也没有代码） | 补 **D-46**：D 表才是 P3/P4/P5 被要求查阅的跨阶段偏差清单 |
> | **M-3** | Minor | D-3 与 Task 1 台账 P2-3 的契约表数口径写错（13 → 实为 11） | `INTERFACES.md` §3 迁移段实际列 **11** 张表；11 + 4 = 15 = `003_review.sql` 实际建表数，总数自洽、基数写错 | 三处 `13 张` → `11 张` |
> | **M-4** | Minor | **「撤回回避」只有领域层读、没有任何写路径** —— 评委一旦误报回避，其分数被永久剔除，产品内无任何途径撤销 | `grep -rn reinstated platform/src/` 只命中 `domain/review-eligibility.js`（读侧）；`declareRecusal` 恒写 `action='recused'` | 补 `reinstateRecusal` 服务 + `POST /api/stages/:stageId/recusals` 的 `action='reinstated'` 分支。⛔ **撤销只能由组委会做**（自己申报又自己撤销 = 绕开回避）→ 撤销的闸门比申报**更严**；撤销要填原因、要写审计（`recusal.reinstate`）；记录**只增不改**（再写一条 `reinstated`） |
> | **M-5** | Minor | `review-state` 路由注释声称「本赛段队伍成员（队长看本队自评进度）」可访问，实际 403 | 探针：队长读 `review-state` → `403 FORBIDDEN` | **按实际行为改正注释**（行为更严，不更松）。若将来要放开队长，须另加一道「只看本队」的过滤，不能只把注释改回去 |
> | **M-6** | Minor | `listStageTeams` 用随机 UUID 作排序键，与「兜底排序键用 rowid」的全局约定口径未对齐 | `ORDER BY t.id` 而 `t.id` 是 `randomUUID()` → 同一次查询两次跑出不同顺序 | `ORDER BY t.created_at, t.rowid`（补 **D-48**，并写清它与 P3 的 `team_id` 兜底是**不同层**的事） |

**Files:**
- Create: `platform/test/p2-final-gate.test.js`（**终审修复的专项回归闸门**，16 条用例）
- Modify: `platform/src/http/routes/review.js`（I-1 传维度全集 / M-4 撤销分支 / M-5 注释）
- Modify: `platform/src/services/review.js`（M-4 `reinstateRecusal`）
- Modify: `platform/src/services/compute.js`（I-2 评委池接线）
- Modify: `platform/src/db/repo/reviews.js`（M-1）
- Modify: `platform/src/db/repo/stages.js`（M-6）
- Modify: `platform/src/db/repo/recusals.js`（M-4 配套：排序加 `rowid` 兜底）
- Modify: `docs/superpowers/plans/2026-10-20-platform-P2-review-engine.md`（本节 + D-46~D-48 + M-3 订正）

**为什么单独开一个测试文件**（而不是并进 `review-api` / `compute` 的既有用例）：这 7 条是**终审修复**这一组变更的验收物，单独成文件才能一眼看出「修了什么、有没有回归」。既有用例测的是**功能**，这个文件测的是**修复**。

- [ ] **Step 1: 写终审修复的回归用例**

`platform/test/p2-final-gate.test.js`（**整文件块，内容与实现逐字一致**）：

```javascript
// platform/test/p2-final-gate.test.js —— P2 整分支终审的回归闸门
//
// 依据：P2 阶段终审（verifier 独立实跑审计）结论 **NOT PASS**：
//   0 Critical / **2 Important** / **5 Minor** —— 全部是「已上线接口的可达缺陷」
//   且**未在偏差表登记**。本文件是这 7 条修复的**专项回归**：
//   每一处修完的行为都在这里钉死，防止后续阶段改回去。
//
// ⚠️ 为什么单独开一个文件而不是并进 review-api / compute 的既有用例：
//   这 7 条是**终审修复**这一组变更的验收物，单独成文件才能一眼看出「修了什么、
//   有没有回归」。既有测试文件的用例是「功能」的，不是「修复」的。
//
// 规则溯源：
//   - 进度分母必须用维度全集 → 设计文档 §11「没有任何评分的队伍不参与排名」
//     + P2 计划 Task 6 修正 ④（队伍轴）+ 本次 I-1（维度轴）
//   - 评委池下限与席构成 → S7 §3.4（R-JDG-10 / R-JDG-11）
//   - 回避必须留档、撤销也要留痕 → S7 §4.2（R-JDG-09）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge, listStageTeams } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { listReviewCells } from '../src/db/repo/reviews.js';
import { computeStage } from '../src/services/compute.js';
import { reinstateRecusal } from '../src/services/review.js';
import { listRecusals } from '../src/db/repo/recusals.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/** 初赛权重表里的**评委席**维度全集（D-32 的白名单同源）。 */
const JUDGE_DIMS_INITIAL = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p2gate-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900009001', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900009002', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900009003', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900009004', password: 'pw' });
  const captain2 = createUser(db, { name: '队长二', phone: '13900009005', password: 'pw' });

  for (const [key, description] of [
    ['score:write', '写入评分'], ['stage:compute', '触发计算发榜'],
    ['audit:read', '读取审计与计算快照'], ['self_review:write', '提交本队自评'],
  ]) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(captain.id, 'self_review:write');

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  const captainUser = captain;
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captainUser.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: captain2.id, status: 'active', now: NOW,
  });

  return {
    db, close, dataDir, app, stage, team, team2, judge, judge2, admin, captain,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenCaptain: createSession(db, captain.id).token,
  };
}

function cleanup(ctx) {
  rmSync(ctx.dataDir, { recursive: true, force: true });
  ctx.close();
}

const postReviews = (app, token, stageId, teamId, dimension, rawScore) => call(app, 'POST', `/api/stages/${stageId}/reviews`, {
  token, body: { items: [{ teamId, dimension, rawScore }] },
});

// ═══════════════════════════════════════════════════════════════════════
// I-1（Important）：进度分母只统计「已出现过打分的维度」
// ═══════════════════════════════════════════════════════════════════════

test('★ I-1 组委会视角的进度分母用维度全集（只交 1 个维度时报 100% 的老 bug）', async () => {
  const ctx = setup();
  try {
    // 只交 innovation 一个维度（2 评委 × 1 队）
    const r1 = await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const r2 = await postReviews(ctx.app, ctx.tokenJudge2, ctx.stage.id, ctx.team.id, 'innovation', 85);
    assert.equal(r1.status, 200, r1.body);
    assert.equal(r2.status, 200, r2.body);

    const res = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/review-state`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    const teamCount = listStageTeams(ctx.db, ctx.stage.id).length;
    // 分母 = 评委数(2) × 队伍数(名册) × 评委席维度全集(5)
    assert.equal(body.total, 2 * teamCount * JUDGE_DIMS_INITIAL.length,
      `分母应为 ${2 * teamCount * JUDGE_DIMS_INITIAL.length}（维度全集），实际 ${body.total}`);
    assert.deepEqual(Object.keys(body.dimensionProgress).sort(), [...JUDGE_DIMS_INITIAL].sort(),
      '从未有人评过的维度也必须出现在 dimensionProgress 里');
    // missing = 应交单元格总数 − 已交 = 评委数 × 队伍数 × 维度全集 − 已交(2)
    const cells = 2 * teamCount * JUDGE_DIMS_INITIAL.length;
    assert.equal(body.missing.length, cells - 2,
      `missing 应为 ${cells - 2} 条，实际 ${body.missing.length}`);
    // 每个评委席维度都必须出现在 missing 里
    // （哪怕 innovation 已经交过 —— 「二队」的 innovation 单元格仍未交）
    const dimsInMissing = new Set(body.missing.map((m) => m.dimension));
    assert.deepEqual([...dimsInMissing].sort(), [...JUDGE_DIMS_INITIAL].sort(),
      '每个评委席维度都必须出现在 missing 里');
    const innovationMissing = body.missing.filter((m) => m.dimension === 'innovation');
    assert.equal(innovationMissing.length, 2,
      'innovation 只交了「一队」——「二队」的 2 个单元格必须出现在 missing 里');
    assert.ok(innovationMissing.every((m) => m.teamId === ctx.team2.id));
  } finally {
    cleanup(ctx);
  }
});

test('★ I-1 评委视角的进度分母同样用维度全集', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const res = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/review-state`, { token: ctx.tokenJudge });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    const teamCount = listStageTeams(ctx.db, ctx.stage.id).length;
    // 评委视角：分母 = 队伍数(名册) × 维度全集(5)
    assert.equal(body.total, teamCount * JUDGE_DIMS_INITIAL.length, `实际 ${body.total}`);
    assert.equal(body.missing.length, teamCount * JUDGE_DIMS_INITIAL.length - 1, `实际 ${body.missing.length}`);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// I-2（Important）：checkJudgePool 零调用方 → 评委池规则形同虚设
// ═══════════════════════════════════════════════════════════════════════

test('★ I-2 评委池不合规时 compute 必须显式告警（judge_pool_invalid）', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    const w = body.warnings.find((x) => x.code === 'judge_pool_invalid');
    assert.ok(w, `warnings 里必须有 judge_pool_invalid：${JSON.stringify(body.warnings)}`);
    // 初赛下限 7 人，本赛段只有 2 人 → 必须报出「人数不足」
    assert.ok(w.errors.some((e) => e.code === 'judge_pool_too_small'), JSON.stringify(w.errors));
    // 企业席占比 0% < 30% → 也必须报出来
    assert.ok(w.errors.some((e) => e.code === 'enterprise_share_too_low'), JSON.stringify(w.errors));
  } finally {
    cleanup(ctx);
  }
});

test('★ I-2 评委池构成必须进快照（input + trace）—— 事后复算要能看出当次发榜合不合规', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    const body = JSON.parse(res.body);
    const snap = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/computations/${body.computationId}`, { token: ctx.tokenAdmin });
    assert.equal(snap.status, 200, snap.body);
    const s = JSON.parse(snap.body);
    assert.ok(s.input.judgePool, '快照 input 里必须有 judgePool');
    assert.equal(s.input.judgePool.ok, false);
    assert.ok(Array.isArray(s.input.judgePool.errors) && s.input.judgePool.errors.length > 0);
    assert.ok(s.trace.judgePool, '快照 trace 里必须有 judgePool');
    assert.equal(s.trace.judgePool.stats.voting, 2);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-1：listReviewCells 不过滤 deleted_at（与 D-35 的 listReviews 口径不一致）
// ═══════════════════════════════════════════════════════════════════════

test('★ M-1 软删除的打分不进「已评分单元格」集合（与 listReviews 的 D-35 口径一致）', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    assert.equal(listReviewCells(ctx.db, ctx.stage.id).length, 1);
    ctx.db.prepare('UPDATE stage_reviews SET deleted_at = ? WHERE stage_id = ?').run(NOW, ctx.stage.id);
    assert.deepEqual(listReviewCells(ctx.db, ctx.stage.id), [],
      '软删除的打分不得留在「已评分单元格」集合里（否则进度分母永远填不满）');
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-4：回避「撤销」只有读侧、没有写路径
// ═══════════════════════════════════════════════════════════════════════

test('★ M-4 评委本人不能撤销自己的回避（撤销比申报更严）', async () => {
  const ctx = setup();
  try {
    const rec = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '利益冲突' },
    });
    assert.equal(rec.status, 200, rec.body);
    const back = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { action: 'reinstated', teamId: ctx.team.id, reason: '其实没关系' },
    });
    assert.equal(back.status, 403, `自撤销应被拒：${back.body}`);
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 组委会可以撤销回避，且撤销后该评委的打分重新计入榜单', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    await postReviews(ctx.app, ctx.tokenJudge2, ctx.stage.id, ctx.team.id, 'innovation', 60);
    const rec = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '误报' },
    });
    assert.equal(rec.status, 200, rec.body);

    // 回避生效 → 评委甲的分被剔除
    const first = JSON.parse((await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin })).body);
    const firstTeam = first.teams.find((t) => t.teamId === ctx.team.id);
    assert.ok(first.warnings.some((w) => w.code === 'recusal_excluded'), '应报告回避剔除');
    assert.ok(firstTeam, '应有结果行');

    // 组委会撤销
    const back = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '核实后无冲突' },
    });
    assert.equal(back.status, 200, back.body);

    // 撤销后重新计算 → 不再有 recusal_excluded
    const second = JSON.parse((await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin })).body);
    assert.ok(!second.warnings.some((w) => w.code === 'recusal_excluded'),
      '撤销后不应再剔除该评委的打分');
    const secondTeam = second.teams.find((t) => t.teamId === ctx.team.id);
    assert.ok(secondTeam.seatP > firstTeam.seatP,
      `撤销后评委席分应回升：${firstTeam.seatP} → ${secondTeam.seatP}`);
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 撤销不存在的回避记录 → 404（单条不存在）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '撤销' },
    });
    assert.equal(res.status, 404, res.body);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-5：review-state 注释声称队长可访问，实际 403（注释与行为不符）
// ═══════════════════════════════════════════════════════════════════════

test('★ M-5 队长读 review-state → 403（注释已按实际行为改正，行为不得放宽）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/review-state`, { token: ctx.tokenCaptain });
    assert.equal(res.status, 403, `队长当前不应被放行：${res.body}`);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-6：listStageTeams 用随机 UUID 排序（未对齐「兜底排序键用 rowid」约定）
// ═══════════════════════════════════════════════════════════════════════

test('★ M-6 赛段名册的排序必须确定（同一 created_at 时按 rowid，即登记顺序）', () => {
  const ctx = setup();
  try {
    const sameTime = '2026-10-20T00:00:00.000Z';
    const a = insertTeam(ctx.db, { editionId: ctx.stage.edition_id, name: '甲队', captainId: ctx.captain.id, status: 'active', now: sameTime });
    const b = insertTeam(ctx.db, { editionId: ctx.stage.edition_id, name: '乙队', captainId: ctx.captain.id, status: 'active', now: sameTime });
    const c = insertTeam(ctx.db, { editionId: ctx.stage.edition_id, name: '丙队', captainId: ctx.captain.id, status: 'active', now: sameTime });
    const ids = listStageTeams(ctx.db, ctx.stage.id).map((t) => t.teamId);
    const mine = ids.filter((id) => [a.id, b.id, c.id].includes(id));
    assert.deepEqual(mine, [a.id, b.id, c.id],
      '同一 created_at 时必须按登记顺序（rowid），不得按随机 UUID');
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// I-2 配套：权重表缺 judgePool 段 → 拒绝计算（而不是按默认值静默算）
// ═══════════════════════════════════════════════════════════════════════

test('★ I-2 权重表缺 judgePool 段时 compute 必须拒绝计算', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const { rules } = loadRules(rulesDir);
    const broken = structuredClone(rules);
    delete broken.scoring.initial.judgePool;
    assert.throws(
      () => computeStage({
        db: ctx.db, stageId: ctx.stage.id, actorId: ctx.admin.id, now: NOW, rules: broken,
      }),
      /judgePool 段/,
    );
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-4 配套：同秒多条回避必须可复现地取最后一条；重复撤销 / 不填原因都要挡住
// ═══════════════════════════════════════════════════════════════════════

test('★ M-4 同一秒申报的多条回避必须可复现地取最后一条（rowid 兜底）', async () => {
  const ctx = setup();
  try {
    const sameTime = '2026-10-20T08:00:00.000Z';
    ctx.db.prepare(
      `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('rec-1', ctx.stage.id, ctx.judge.id, ctx.team.id, '第一次', 'declared', sameTime, ctx.judge.id, 'recused');
    ctx.db.prepare(
      `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('rec-2', ctx.stage.id, ctx.judge.id, ctx.team.id, '第二次', 'declared', sameTime, ctx.judge.id, 'recused');
    const rows = listRecusals(ctx.db, { stageId: ctx.stage.id, judgeId: ctx.judge.id });
    assert.deepEqual(rows.map((r) => r.id), ['rec-1', 'rec-2'], '同秒并列时必须按 rowid 排序');
    assert.equal(rows[rows.length - 1].id, 'rec-2');
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 赛段级回避列表在同秒并列时必须按登记顺序（rowid 兜底，索引序会乱）', () => {
  const ctx = setup();
  try {
    // 本条针对 `listRecusals(db, { stageId })` 这条**赛段级**分支：
    // 它走 `idx_recusals_lookup(stage_id, judge_id)` 的索引扫描，
    // 并列行的自然顺序是「judge_id 升序」而不是「登记顺序」。
    // 少了 `, rowid` 兜底，SQLite 的临时 B 树会把这个索引序原样吐出来 → 顺序错乱。
    // （上面那条带 `judgeId` 过滤的用例查不到这个洞：同 judge_id 时索引序恰好等于 rowid 序。）
    const judge3 = createUser(ctx.db, { name: '评委丙', phone: '13900009006', password: 'pw' });
    assignStageJudge(ctx.db, { stageId: ctx.stage.id, userId: judge3.id, seat: 'judge', now: NOW });

    const sameTime = '2026-10-20T09:00:00.000Z';
    // 按 id 升序排列后【倒序插入】—— 登记顺序必然与 judge_id 升序相反
    const judgeIds = [ctx.judge.id, ctx.judge2.id, judge3.id].sort();
    const insert = ctx.db.prepare(
      `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const inserted = [];
    for (const [i, judgeId] of [...judgeIds].reverse().entries()) {
      const id = `rec-par-${i}`;
      insert.run(id, ctx.stage.id, judgeId, ctx.team.id, '同秒申报', 'declared', sameTime, judgeId, 'recused');
      inserted.push(id);
    }
    const rows = listRecusals(ctx.db, { stageId: ctx.stage.id });
    assert.deepEqual(rows.map((r) => r.id), inserted,
      '赛段级 listRecusals 在 declared_at 并列时必须按登记顺序（rowid）返回，不能是索引序');
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 重复撤销 → 409；撤销不填原因 → 400', async () => {
  const ctx = setup();
  try {
    const rec = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '误报' },
    });
    assert.equal(rec.status, 200, rec.body);

    const noReason = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id },
    });
    assert.equal(noReason.status, 400, `撤销必须填原因：${noReason.body}`);

    const first = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '核实后无冲突' },
    });
    assert.equal(first.status, 200, first.body);
    const second = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '再来一次' },
    });
    assert.equal(second.status, 409, `重复撤销应 409：${second.body}`);
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 撤销必须写审计（事后要能查是谁撤的、为什么撤）', async () => {
  const ctx = setup();
  try {
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '误报' },
    });
    const back = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '核实后无冲突' },
    });
    assert.equal(back.status, 200, back.body);
    const row = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'recusal.reinstate'").get();
    assert.ok(row, 'audit_log 里必须有 recusal.reinstate');
    assert.equal(row.actor_id, ctx.admin.id);
    const detail = JSON.parse(row.detail_json);
    assert.equal(detail.judgeId, ctx.judge.id);
    assert.ok(detail.supersedes, '审计里要记被撤销的那条记录 id');
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 服务层 reinstateRecusal 也要校验评委在名单内（不靠路由层代偿）', () => {
  const ctx = setup();
  try {
    const stranger = createUser(ctx.db, { name: '陌生人', phone: '13900009099', password: 'pw' });
    assert.throws(
      () => reinstateRecusal({
        db: ctx.db, stageId: ctx.stage.id, judgeId: stranger.id,
        teamId: ctx.team.id, reason: '撤销', actorId: ctx.admin.id, now: NOW,
      }),
      /未被分配到本赛段/,
    );
  } finally {
    cleanup(ctx);
  }
});
```

- [ ] **Step 2: 实施 7 条修复**

见上方表格「处置」列。**每条修复都要能被变异体杀死** —— 「改完了」不等于「改对了」。

- [ ] **Step 3: 变异检验（独立工程）**

变异脚本：`/tmp/p2t10/mutate.mjs`（20 个变异体，覆盖 7 条修复的每一个闸门）。
测试集：`p2-final-gate.test.js` + `review-api.test.js` + `compute.test.js` + `review-service.test.js` + `judge-pool.test.js`。
→ 实跑结果见下方「终审修复台账」。

- [ ] **Step 4: 全量回归**

Run: `cd platform && node --test` → Expected: **553/553** 全绿（P2 原有 537 + 终审修复 16）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/http/routes/review.js src/services/review.js src/services/compute.js src/db/repo/reviews.js src/db/repo/stages.js src/db/repo/recusals.js test/p2-final-gate.test.js
git commit -m "fix(P2): 终审修复 —— 进度分母用维度全集 / 评委池校验接线 / 回避撤销写路径"
```

> ⚠️ 计划文件本身也在本次提交范围内（仓库根的 `docs/superpowers/plans/…`）——
> 「计划是规格」意味着**计划与实现必须同一次提交落盘**，否则规格与代码会分叉。

#### 终审修复台账

**变异检验（第二轮实跑，`/tmp/p2t10/mutate.mjs`）**

| 组 | 变异体 | 覆盖的闸门 | 结果 |
|---|---|---|---|
| I-1 | F01 / F02 / F03 | 进度分母传维度全集 / 只算评委席维度 / 权限闸门不得摘掉 | 3/3 KILLED |
| I-2 | F04 / F05 / F06 / F07 / F08 / F09 | 评委池必须被调用 / 不合规必须告警 / 进快照 input / 进快照 trace / 缺配置拒算 / 告警 code | 6/6 KILLED |
| M-1 | F10 | `listReviewCells` 必须过滤 `deleted_at` | 1/1 KILLED |
| M-4 | F12–F19 / F20 | 组委会独占 / 路由认 `reinstated` / 写回 action / 必填原因 / 必写审计 / 拒绝重复撤销 / 记录不存在 404 / 评委在名单内 / `rowid` 兜底 | 9/9 KILLED |
| M-6 | F11 | 名册排序必须确定 | 1/1 KILLED |
| **合计** | **20** | — | **KILLED 20 / SURVIVED 0 / 构造失败 0** |

**F20 的存活与定性（第一轮 → 第二轮）**

第一轮实跑：19/20 KILLED，**F20 存活**（`listRecusals` 去掉 `, rowid` 兜底 → 竞态同秒并列的顺序不可复现）。
按纪律「存活变异必须修、或显式标注为等价 / 不可观测」，先要**定性**再动手，不能直接当盲区补测试也不能直接放过。

- **原以为会「等价」**：SQLite 对并列行的自然顺序在单表全扫下常常恰好等于 `rowid` 序。
- **探针实测推翻**：建同款表 + `idx_recusals_lookup(stage_id, judge_id)`，插 4 条 `declared_at` 相同、
  `judge_id` 字母序与插入序**相反**的记录 → `EXPLAIN QUERY PLAN` 显示走
  `SEARCH recusal_records USING INDEX idx_recusals_lookup` + `USE TEMP B-TREE FOR ORDER BY`；
  带 `, rowid` 返回插入序（`id-1,id-2,id-3,id-4`），**去掉后返回索引序**（`id-3,id-4,id-2,id-1`）。
  → **可观测，不是等价变异体**：`rowid` 兜底是真正承重的。
- **已有用例为什么查不到**：那条「同一秒申报的多条回避」用例查的是**带 `judgeId` 过滤**的分支；
  同一个 `judge_id` 下索引序恰好等于 `rowid` 序 → 天然查不出。而 `listRecusals` 还有一条
  **赛段级**分支（不带 `judgeId` 过滤），走的是同一条索引 —— 那里才有洞。
- **补测（第 16 条用例）**：赛段级分支 + 三个评委 id 按字典序排好后**倒序插入**，
  于是「登记顺序」与「judge_id 升序」必然相反，断言返回顺序 = 登记顺序。
  再跑变异 → **F20 KILLED**。

> **教训（值得写进全局纪律）**：变异体存活时，先问「**它真的改变行为了吗**」——
> 构造失效与真盲区长得一模一样，但处置相反：前者要重写变异体，后者要补测试。
> 这次的判断依据是**独立探针**（另建同款表复现查询计划与返回顺序），不是猜。

**测试条数口径**

| 项 | 条数 |
|---|---|
| P2 原有（Task 1–9） | 537 |
| 终审修复专项（`p2-final-gate.test.js`） | 16 |
| **P2 全量** | **553/553 全绿** |

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
| P2-13 | ⭐ SSE 评审进度推送 | `node --test test/sse.test.js` **20/20** 通过：未登录 401 / 无权限 403 / 本赛段评委可订阅 / 首帧 `connected` / 提交评分后收到 `review.progress`（载荷不含 `judgeId`）/ **跨赛段不串台** / 失败提交不推送 / 断开后摘订阅者 |

---

## 与接口契约的偏差

`INTERFACES.md` 是跨阶段的唯一事实来源。以下是本计划**必须**与它不一致的地方，全部在此登记，便于后续阶段与组委会追认。

| # | 偏差 | 契约原文 | 本计划做法 | 理由 | 影响 |
|---|---|---|---|---|---|
| D-1 | `normalizeScores` 的 `samples` 元素多一个可选字段 | `samples: [{ judgeId, value }]` | 允许 `{ judgeId, value, series }`，`series` = 该评委在本维度对**全部参赛队**的原始分序列 | 归一化的是评委宽严，必须知道该评委在维度 d 上的**全部打分**才能算 mean(i,d)/stdev(i,d)；只给单元值无法算 | 无破坏性：不传 `series` 时退回「同 judgeId 在 samples 中的全部 value」。⚠️ **父代理预审修正**：这条回退**原实现根本没做**（直接 `continue` 跳过），导致契约形状产出**空 values + null fallbackReason**（静默空成功）——现已实现并补回归用例 |
| D-2 | `normalizeScores` 返回值多一个字段 | `{ normalized, values, fallbackReason, stats }` | 追加 `judgeStats[judgeId] = { n, mean, stdev, center, scale, normalized, fallbackReason }` | 契约的 4 个字段无法表达「同一维度内不同评委的降级状态不同」；trace 需要逐评委样本量 | 纯追加，不改原有字段语义 |
| D-3 | `003_review.sql` 多**四**张表 | 契约只列 11 张，未列 `tiebreak_round` / `tiebreak_votes` / `review_request_keys` / `conflict_declarations` | 新增这四张表 | ① `tiebreak_round` / `tiebreak_votes`：设计文档 §6.4【决策】已明确要求「加时陈述用独立表 + 唯一约束」，R-JDG-19 需要落库，P3 的 `applyTiebreakChain` 直接消费；② `review_request_keys`：见 D-5；③ `conflict_declarations`：R-JDG-18「评委须签署利益冲突声明」需要独立表 —— **声明（事前签署）与回避（个案动作）不是一回事**，合在一起会让「没签声明」和「这个队要回避」两种状态混为一谈 | P3 的 `applyTiebreakChain` 直接消费；`conflict_declarations` 由 P2 Task 6 的 `assignStageJudge` 写入 |
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
| D-14 | 归一化「全局口径」的数值 | 「退回全局均值与标准差」 | z = (s − 全局均值)/全局标准差，再按「全局均值 + z×全局标准差」还原回 0–100 尺度 | 还原回原始单位后，全局口径等价于「不做宽严校正」；否则 P（z 单位）与 E（0–100）不可通约 | 语义等价，trace 里 `fallbackReason` 照常标出。⚠️ **父代理预审修正**：`fallback: 'raw'` 这一档原来**名实不符**（reason 写 `raw_fallback`，实际仍算全局 z 值）；现已改为 `center = 0 / scale = 1` ⇒ **z ≡ 原始分**，与「还原回原始单位」的统一公式 `score = center + z×scale` 自洽 |
| D-15 | P 席包含自评维度 | 决赛权重表含「自评测 5%」 | P 席 = 评委维度 ∪ 自评维度 | 决赛权重表 70+25+5=100%，而公式 (1−w_E)=75% 只能覆盖「评委 70% + 自评 5%」 | 初赛无自评维度，完全不受影响 |
| D-16 | 规则文件新增字段 | 9 份规则的字段未列 | `scoring-initial.json` / `scoring-final.json` 增加 `judgePool` / `freeBrief` / `fallback` / `trimmedIterations` / `bayesPriorStrength` / `selfEvalThreshold` | R-JDG-10 / R-JDG-11 / R-JDG-08 的数值必须配置化（⛔ 不硬编码） | 只加字段，不改已有权重与 `wEnterprise` |
| D-17 | `fallbackReason` 取值 | INTERFACES 用 `zero_stdev`；C-05 用 `stdev_zero` | 统一用 INTERFACES 的 `zero_stdev` | INTERFACES 是跨阶段唯一事实来源 | 另两处取值为 `judge_sample_too_small` / `raw_fallback` / `unknown_strategy` / `empty_samples`；⚠️ **父代理预审修正**新增第 6 个 `no_finite_values`（样本在但 `value` 全是 null/NaN → 一个 z 值都没产出，**不能谎称 `normalized: true`**） |
| D-18 | 迁移版本号 | 全局唯一序位：`001=P0`、`002=P1`、`003=P2`、`004=P3`、`005=P4`、`006=P5` | P2 的迁移用 `003_review.sql`（不冲突） | ✅ **已消解**（2026-10-21 订正）：P0 终态 `platform/db/migrations/` **只有 `001_init.sql`**，**从未建过 `002_user_roles.sql`**；P1 的迁移是 `002_registration.sql`，与 P2 的 `003_review.sql` 无冲突。`applyMigrations` 按 version 去重，重复版本号会**响亮抛错**（P0 `src/db/migrate.js` 有专门的重复检测），不存在「后者被静默跳过」。⚠️ 不要再按原写法提「需 P1 改名」或「需 P0 改名」—— 那个冲突在 P1 落地时就不存在了 |
| D-19 | **`audit_log` 的写入口与 SQL 落点** | 契约未规定 `audit_log` 的仓储落点 | `src/db/repo/audit-log.js`（**新建**，SQL 唯一归宿）+ `src/audit/log.js`（**薄服务门面**，不含 SQL） | ⚠️ 原写法是把两条 SQL **内联在 `src/audit/log.js`** 里 —— 那会越过全局约束「所有 SQL 收进 `src/db/repo/`」，P0 的 `test/sql-boundary.test.js` 守卫**当场判违规**（审计实跑：`not ok 1`，3 条违规）。同时 P4 原计划另建 `src/db/repo/audit-log.js` → 同一张表**两条写路径**。现改为**单一归属**：SQL 全在仓储层，门面只转调。见 C-3 / I-8 修正记录 |
| D-20 | **新增 SSE 端点 `GET /api/stages/:stageId/events`** | 契约的 P2 API 清单里没有这一条 | 新增该端点 + `src/http/sse.js`（新建） | P0 的 `platform/web/api.js:28-30` 的 `subscribe()` 明写「⚠️ SSE 端点在 **P2** 才实现（`src/http/sse.js`）」，而 P2–P6 五份计划**全都没有承接** → 一条**指向不存在实现的活引用**。现由 P2 的 **Task 9** 落地（审计报告 I-6 的第 ① 条路；第 ② 条路要改 `platform/web/api.js`，属 P0 的地盘，本阶段不得改动）。契约已同步更新 |
| D-21 | **自评不得填补评委席维度**（算法层封堵自评加分路径） | 规格原写法：评委席维度若没有评委打分，就去 `selfReviews` 里找同维度的自评记录顶上；「精确命中」分支还完全绕过对齐规则 | 评委席维度**只由评委打分**；评委没打分就是没打分（该维度权重记 0 + `dimension_no_scores` warning）。自评记录只能填 `seat='self'` 的维度 | S7 §4.3 明写自评「**不加分**、只触发说明与提问」；S10 §8 第三条风险明写「分轨必须是算法层面的，不是纪律层面的」。原写法让**团队可以自己给自己加分**（自评 95 分顶掉缺失的评委分），与两条原文直接冲突 | 评委席维度缺分时该队少拿权重（不是拿自评补），是这个方向上的「更严」。⚠️ 规格自带的用例只断言了 warning 存在、**没断言分数**——现在补了断言（`perDimension.innovation.mean === 80` 而非 95） |
| D-22 | **自评席维度与评委维度隔离** | 规格原写法把自评席维度的分写回 `dimScores` | 自评席维度另装 `selfDimScores`，与评委维度的 `dimScores` 完全隔离 | 原写法污染后续队伍的 `perDimension`，且让「查评委分」可能取到**别的队伍的自评分** | trace 的 `perDimension` 形状不变 |
| D-23 | **对齐规则覆盖「精确命中」分支** | 规格原写法：自评被判定 `written_explanation` 时，只在「加权平均兜底」分支用评委分；「精确命中」分支直接用自评分 | 两条分支都走同一套对齐判定：命中 `written_explanation` 时改用评委分；找不到评委分则该维度缺分 | R-JDG-13「不成立则自评分对齐评委分（不加分）」——对齐规则不能有例外分支 | 无 |
| D-24 | **`computeStage` 的仓储行 → 领域形状映射** | 规格原写法：企业确认 / 互评 / 自评三张表的仓储行**原样**喂给领域层 | 三张表都**显式映射**成驼峰形状（`teamId` / `rawScore` / `crossJudgeId` / …） | 仓储返回 snake_case（`team_id` / `raw_score`），领域层读的是驼峰 → **三张表全部被静默忽略**：企业席恒为 0 分（初赛 10% / 决赛 25% 的权重直接蒸发）、互评恒为 null、自评恒为空（决赛 5% 恒缺分）。**没有一条报错**——榜单只是「安静地少算了一块」 | 已补 `compute.test.js` 的「企业确认必须真的进总分」用例钉住 |
| D-25 | **compute 的事务边界** | 规格原写法：抢 revision → 写快照 → 写结果 → 写审计，四步各自独立 | 四步在**一个 `BEGIN IMMEDIATE` 事务**里 | 中途失败会留下「有快照没结果」或「结果指向不存在的快照」的半成品 | 与 Task 6 的「抢幂等键与写数据同事务」同一纪律 |
| D-26 | **计算快照不得跨赛段读取** | 规格原写法：`getComputation` 只按 id 取，路径里的 `:stageId` 形同虚设 | 传入 `stageId` 时必须匹配，不匹配返回 404 | 任何有 `audit:read` 的人都能拿**别的赛段**的计算快照来读（跨赛段越权读） | 已补跨赛段 404 用例 |
| D-27 | **评审 API 的越权闸门 + 独立能力点** | 规格原写法：9 条 API 全部只校验「登录 + 一个能力点」 | ① 回避**不能代他人申报**（只有本人或组委会可申报，且被申报人必须在名单内）；② 企业确认**不能冒名**（出题企业只能为自己签，组委会可代录；跨领域评委必须在名单内且与签字人不同）；③ 自评用**独立能力点 `self_review:write`** 且必须本队成员；④ 互评必须由发起队成员提交；⑤ 能力点校验同时认**赛段级**与**全局级**授权 | 原写法里，任何有 `score:write` 的人都能①让别人被剔除打分、②替任意队伍签出占 10–25% 权重的企业确认、③替任意队伍提交自评 —— 全是**直接影响奖金**的越权。与 P1 Task 3 的 A1（能力点被注册却从不校验）同一类病根 | ① 需要 `seed.js` 新增 `self_review:write` 能力点并授予队长/组员；② 能力点作用域从 `{scopeType:'global'}` 改为「赛段级 ∨ 全局级」（原来只认全局，赛段级授权会被静默判成无权） |
| D-28 | **没有 P 席评分的队伍不写 `stage_results`** | 规格原写法：`result.teams` 里的每一队都写一条结果行 | 只写「P 席（评委席 + 自评席）有分」的队伍 | 设计文档 §11 明写「没有任何评分的队伍不参与排名」；原写法会让名册里没被任何人评过的队拿到 `total=0` 的结果行，**被 P3 排进榜单** | 「是否参评」的判定也相应改为只看 P 席（企业席单独有分不算参评） |
| D-29 | **自评席维度与「该队评委席分」比（R-JDG-13 覆盖到自评席）** | 规格只让自评与**同维度**的评委分比；而 `seat='self'` 的维度（如决赛「自评测 5%」）**没有**同维度评委分 → 判定恒不触发 → 队伍把自评维度填到 100 就是白拿 5% 的加权分 | 自评席维度的分与**该队的评委席分（不含自评席）**比：高出 `selfEvalThreshold` → 对齐到评委席分（不加分）+ warning；低出同样阈值 → 只提问 | S7 §4.3 机制归因：「一旦自评可以加分，它就变成了纯粹的博弈项。让它只触发『解释』和『提问』，它才真正对治黑箱。」自评席维度是**唯一**能让自评真正进入总分的口子，不封住它，R-JDG-13 就是空的 | 备选口径是「自评席维度分硬顶到评委席分」—— 本轮选了「±阈值比较」，因为它复用了 R-JDG-13 已经确立的 ±10 语义，两处口径一致 |
| D-30 | **R1 只依据「有效的」非本赛道确认判定；本赛道企业已合法确认时不再降权** | 规格：`outOfTrack` = 全部非本赛道确认（**不看是否有效**）；只要有一条就把企业项权重归零 | ① 无效的（缺双签 / 内容空白 / 分数越界）非本赛道记录**不触发** R1；② 本赛道企业已合法确认时，R1 **不再**把权重归零（只记 warning） | ① 原来一条**垃圾记录**就能把受害队伍的企业席整段作废（初赛 10% / 决赛 25%）；② R1 的本意是「本赛道企业没确认 ⇒ 企业席不适用」，不是「有人冒签就整队作废」—— 本赛道企业对自己出的题签字是天经地义的 | 保留了 R1 的告警（`R1_out_of_track`），不静默 |
| D-31 | **企业确认的写入口必须核验「出题企业」身份** | 规格：只校验「有 `score:write` 能力点」 | ① 签署人必须有 `signoff:create`（企业席的能力点）或 `stage:compute`（组委会代录）；② 签署人必须是**该队任务包的出题企业**；③ 被签队伍必须存在 | 父代理预审实测：只持有 `score:write` 的**评委**可以替任意队伍签一条「非本赛道」的企业确认 → R1 触发 → 该队企业席整段作废（合法 90 分被一条伪造记录连坐掉） | 与 D-30 配套：写入口堵死 + 领域层不再被冒名记录劫持，两道防线 |
| D-32 | **评委打分的维度白名单** | 规格：维度键不校验 | 写入口按该赛段 `scoring_config_key` 的 dimensions 校验：未知维度 → 400；**非评委席维度**（`seat='self'` / `seat='enterprise'`）→ 403 `DIMENSION_SEAT_FORBIDDEN`。领域层再兜一道：自评席维度**绝不**取评委的打分记录 | 父代理预审实测：评委对 `self_eval` 维度打 100 分 → 200 → 自评栏被评委占掉 → 「自评只能本队成员提交」的闸门整个失效（R-JDG-13「不加分」失效） | 写入口在路由层（请求级校验），语义层在领域层（算法级防护） |
| D-33 | **写入口的队伍边界 + 三态状态码补齐** | 规格：`submitReviews` 等不校验队伍 | 评分 / 企业确认 / 互评 / 自评 / 回避的**队伍 id** 必须在本赛段名册内，否则 404 `TEAM_NOT_IN_STAGE`（不再是外键报错 → 500） | ① 父代理预审实测：评委能给**别的届期**的队打分 → 那支队被算进本赛段榜单（外队进榜）；② 队伍不存在时 `FOREIGN KEY constraint failed` 漏到 HTTP 层 → 500（破坏三态状态码） | ⚠️ **已知限制**：名册目前是**届期级**（stages → edition_id → teams），赛段级队伍边界需要一张 `stage_team` 表 —— 登记在 P3 |
| D-34 | **重算前清场 `stage_results`** | 规格：`upsertStageResult` 只 upsert，不回收旧行 | 重算前（同一事务内）：`rank` / `tied_with` / `points` 一律置 NULL，并**删除**本轮已无 P 席评分的旧行 | 父代理预审实测：P3 发过榜（rank=1, points=99）后重算 → **旧名次 + 新总分**并排躺在同一行；撤掉某队全部打分后重算 → 旧行 total 仍在 | 名次与积分由 P3 在新一轮计算后重新填 |
| D-35 | **软删除的打分不再计入计算** | 规格：`listReviews` 不过滤 `deleted_at` | `listReviews` 增加 `AND deleted_at IS NULL` | `stage_reviews` 的删除语义是**软删除**（评分只增不改），但被删掉的分还在榜单里 | 全局约束「评分只增不改，删除用软删除」 |
| D-36 | **改分留痕** | 规格：审计只记「条数」 | 审计 detail 带上 `changed: [{ teamId, dimension, from, to }]` | 原来评委改分后，**当时榜单用的是几分**再也还原不出来（可复算要求断链） | 审计字段追加，不改已有字段 |
| D-37 | **SSE 进度事件载荷不含 `judgeId`** | 规格：事件载荷是 `{ stageId, judgeId, at }` | 载荷只带 `{ stageId, at }` —— 事件只作为**信号**，客户端收到后重新拉 `review-state` | 事件流会把「谁在什么时候提交了评分」广播给该赛段的**每一个**订阅者 —— 可见性必须由 API 层按观众过滤（全局约束「可见性在 API 层过滤」）。带着 judgeId 推 = 绕过可见性层 | 客户端拿不到「谁交了」，改由 `review-state` 按身份返回 |
| D-38 | **SSE 订阅的权限闸门** | 规格：只要**登录**就能订阅任意赛段 | 与 `review-state` 同一套口径：组委会 / 有 `score:read` 的人 / 本赛段评委 → 否则 403 | 规格的口子等于「任何登录账号都能监听任意赛段的评审动态」—— 评审过程与评委行踪不该对所有人开放（与 D-27 同一条纪律） | 评委会用 `stage:compute` / `score:read` 订阅；普通评委靠「本赛段评委」身份订阅 |
| D-39 | **SSE 心跳注释帧** | 规格：无心跳 | `sendSseComment()` 发 `: ping\n\n` 注释帧；server.js 用 `setInterval(...).unref()` 每 25s 发一次，连接关闭时 `clearInterval` | SSE 连接长时间空闲时，中间的 nginx（`proxy_read_timeout` 默认 60s）会掐线 → 现象是「前端每隔一分钟重连一次」。`unref()` 保证定时器**不**拖住进程退出 | 心跳频率 25s 可调；帧是注释，EventSource 会忽略 |
| D-40 | **畸形百分号编码不得让 `parseSsePath` 抛错** | 规格：`decodeURIComponent(m[1])` 直接调用 | 解析失败**返回 null** → 走正常的「非法 URL」分支（400） | P0 的教训（「畸形 URL 编码不能让进程退出」）在这里同样成立：`/api/stages/%E0%A4%A/events` 会让 decodeURIComponent 抛 URIError | 无 |
| D-41 | **进度事件按赛段隔离（topic 必须带 `stageId`）** | 规格：事件中心是**单一全局**订阅者集合，`publish` 不带 topic | 订阅时登记 `topic = stage:<stageId>`，`publish` 只投给同 topic 的订阅者；payload 的 `stageId` 与 topic 同时约束 | 评审进度是**按赛段**的：A 赛段的评委提交评分，不该让 B 赛段的订阅者收到「有进展」——否则前端会刷新一个**跟自己无关**的进度条，甚至被诱导去看别的赛段的评审状态 | 无（客户端契约不变，只是多了隔离） |
| D-42 | **失败的提交不得推送进度事件** | 规格：`publish` 的位置未约束 | `publish` 放在 `submitReviews` **成功返回之后**（服务层抛错 → 路由层抛错 → 不 publish） | 进度事件的语义是「**评审有进展了**」。失败的提交（分数越界 / 队伍不在名册 / 幂等键冲突）**没有进展** —— 却推了「有进展」，前端会把进度条推满，而榜单上一个分都没进 | 无 |
| D-43 | **客户端断开必须摘掉订阅者** | 规格：无连接生命周期约定 | `res.on('close')` 里 `clearInterval(heartbeat)` + `reviewEvents.remove(res)`；事件中心的 `remove` 真正从 `Map` 里删 | 订阅者（`res`）只增不减 ⇒ 每开一条 SSE 连接就**泄漏一个 response 对象 + 一个定时器**，进程内存单调增长，长跑必被打挂 | 无 |
| D-44 | **非 GET 方法不得开 SSE** | 规格：端点只说「`GET /api/stages/:stageId/events`」 | server.js 的分支条件是 `req.method === 'GET' ? parseSsePath(url) : null`；其他方法按普通路由走（404） | 少了方法闸门，`POST` 到同一路径会被当成 SSE 订阅 —— **用 POST 请求开一条长连接**是典型的协议混淆（且 CSRF 形态下更容易被诱导） | 无 |
| D-45 | **SSE 响应头必须显式声明不被代理缓冲** | 规格：未规定响应头 | `Content-Type: text/event-stream; charset=utf-8` + `Cache-Control: no-cache, no-transform` + `Connection: keep-alive` + **`X-Accel-Buffering: no`** | nginx 默认会缓冲上游响应 → 事件被攒着一起发，前端看起来像「**不推送**」；`X-Accel-Buffering: no` 是唯一能在不改 nginx 配置的前提下关掉缓冲的响应头 | 无 |
| D-46 | **改分走「覆盖写 UPDATE」而不是追加式新记录**（`supersedes_id` 未实现） | `INTERFACES.md` §0「追加式：评分/签字类记录**只增不改**，更正走新记录 + `supersedes_id`」 | 改分用 `UPDATE stage_reviews SET raw_score = ?`（**原地覆盖**），可追溯性由**审计**补回（D-36：`changed[{from,to}]`） | ⚠️ 终审（Minor M-2）指出：这条偏离**只登记在 Task 6 台账的「刻意保持的行为」里，没进 D 表** —— 而 D 表才是 P3/P4/P5 被要求查阅的跨阶段偏差清单。**实质影响可控**（可追溯性未断链），但**登记必须补上**：若后续阶段要改成追加式链，必须同时把 `stage_reviews` 的 UNIQUE 改成**偏序索引**（见 Task 1 台账 M2-6），否则第二条记录插不进去 | P3/P4 若要接 `supersedes_id`，须先改 `stage_reviews` 的唯一约束（expand-contract） |
| D-47 | **评委池下限与席构成（R-JDG-10 / R-JDG-11）在发榜时**不阻断、只显式告警** | 计划：Task 5 交付了 `checkJudgePool`（纯函数），但**没有任何调用方** —— 1 名评委、0 企业席的赛段照样能算出 `total=72` 的榜单 | `computeStage` 调用 `checkJudgePool({ judges, config })`：不合规时写入 `result.warnings`（`judge_pool_invalid`），并把池子构成与错误写进快照的 `input.judgePool` 与 `trace.judgePool`；**不阻断发榜** | ⚠️ 终审（Important I-2）指出这是「能力被建好却从不校验」的同款病根（P1 Task 3 的 A1 / P2 Task 6 的 P2-4）。**口径选择**：不阻断 = 与本阶段其余「业务状态类」判定一致（自评差异 / 企业席规则 / 归一化降级 都是「算 + 显式告警」），且阻断会让「1 名评委的内部彩排」也发不出榜（P6 演示版需要小规模跑通）。**「池子不合规就不许发榜」是组委会口径** —— 要加这道闸只需在 compute 路由上判 `warnings` 里的 `judge_pool_invalid`，不必改领域层。合规性**必须进快照**：事后复算要能看出当次发榜的池子合不合规 | 权重表缺 `judgePool` 段 → **拒绝计算**（500 `JUDGE_POOL_CONFIG_MISSING`），不按默认值静默算 |
| D-48 | **赛段名册（`listStageTeams`）的排序键** | 契约未规定；全局约定 #43「兜底排序键一律用 SQLite 隐式 `rowid`」 | `ORDER BY t.created_at, t.rowid` | ⚠️ 终审（Minor M-6）指出：原实现是 `ORDER BY t.id`，而 `t.id` 是 `randomUUID()` → **顺序不可复现**（同一次查询两次跑出不同顺序）。虽无并列行、不构成榜单风险，但与「兜底排序键用 rowid」的约定**口径未对齐**。⚠️ 与 P3 的关系：P3 的破同分链最后一级兜底是 **`team_id`**（契约 §4 明写），P3 用 `cmpStr` 按码位序比 —— 两者是**不同层**的事：P2 管「名册列举顺序」，P3 管「并列时的排序依据」 | 无 |

> **【2026-10-21 漂移审计修正 I-9 + M-4】** D-18 这一行原来描述的是一个**早已不存在**的冲突：
> 「P0 建了 `002_user_roles.sql`；…⛔ **需 P1 改名为 `002_registration.sql` 之外的版本，或 P0 改名**」。
> **为什么错**：① **事实过期** —— P0 终态 `platform/db/migrations/` 下**只有 `001_init.sql`**，
> `002_user_roles.sql` 从未被创建；P1 落地的是 `002_registration.sql`，两者本就不同号。
> ② 更危险的是这条「建议」本身 —— 若被采纳，把 P1 的 `002` 改成 `003`，就会与 **P2 自己的
> `003_review.sql` 撞号**（全局唯一序位 `001=P0 / 002=P1 / 003=P2 / 004=P3 / 005=P4 / 006=P5`），
> `applyMigrations` 的重复检测会直接抛错，评审表全部建不出来。
> **改成什么**：改写为「**已消解**」的现状陈述，并显式钉住全局唯一序位；删除「需改名」的建议。
> **依据**：`git ls-tree` 实测 —— `.worktrees/p0-foundation` 的 `platform/db/migrations/` 只有
> `001_init.sql`；`.worktrees/p1-registration` 的有 `001_init.sql` + `002_registration.sql`；
> P0 终态 `platform/src/db/migrate.js` 的 `readMigrationFiles()` 对重复版本号**响亮抛错**
> （「迁移版本号重复」），不存在「静默跳过」。同一事实的另一半在 P4 的 §E-1，
> 已按同一口径删除（见 P4 计划里的 I-9 修正记录）。

---

## Task 1 父代理预审修正台账（2026-10-21）

> Task 1 的规格在**实施前**被父代理逐条实跑预审，发现 **1 Important + 4 Minor**；
> 实施完成后又做了一轮**变异检验**，变异体一度出现 **7 条存活**（暴露 7 处约束**零覆盖**），
> 补完测试后 **44/44 杀灭**。全部缺陷均**实跑复现**。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P2-1** | **Important** | **引用型外键只加了一半**：同一类引用一处有一处没有（`stage_judges.user_id` 有、`stage_reviews.judge_id` 没有）→ 评审数据可以指向**不存在的评委 / 队伍**，聚合时不会被发现；而测试用假 id（`'j1'` / `'t1'` / `'ed1'`）正好**掩盖**了这一点 | P1 的 `002_registration.sql` 里 `edition_id` **全都有**外键；003 里只有一半 | 逐列扫描所有 `*_id` / `*_by` 列，**该有外键的全部补齐** —— 最终 15 张表 **38 条**引用型外键，覆盖 `editions` / `users` / `teams` / `stages` / `conflict_declarations` / `computation_snapshots` / `tiebreak_round` 七个父表 |
| **P2-2** | Minor | 测试夹具用**假 id**（`'j1'` / `'t1'` / `'ed1'`） | 夹具里 `judge_id = 'j1'` 之类 | 改建**真实的** edition / user / team（与 P1 的 `migration-002.test.js` 对齐）。⚠️ **代价**：Task 6/7/8 计划里 14 处 DB INSERT 点的假 id 夹具，实施时**必须一并改掉** |
| **P2-3** | Minor | `conflict_declarations` 的**表数口径三处不一致**：正文说 14 张 / SQL 里 15 张 / 测试表清单 14 张 | `003_review.sql` 实际建出 15 张表 | 统一为 **15**，并在「Produces」里显式登记「相对契约 §3 的 11 张新增 4 张」 |
| **P2-4** | Minor | R-JDG-18「评委须签署利益冲突声明」**零接线**：表建了但没有任何代码写入 | 计划全文搜不到 `conflict_declarations` 的 INSERT | 接线放到 **Task 6**（`assignStageJudge` = 分配评委即签署声明），并把 `assignStageJudge` 的代码块改成「写 `conflict_declarations` + 回填 `stage_judges.conflict_declared_at` / `conflict_declaration_id`」 |
| **P2-5** | Minor | 「**一人一票**」措辞不准 | `tiebreak_votes` 主键是 `(轮次, 投票人, 队伍)` —— 准确语义是「一人**一队**一票」：同一人对不同队伍各投一次**允许**（破同分时每位评委都要给每支并列队打分） | 全文改为「一人一队一票」，并配套常量 `DEFAULT_CONFLICT_STATEMENT`；⚠️ 该语义**必须**有测试区分（见 M2-4） |

### 二、变异检验发现的实现盲区

> 变异体 **44** 个，全部作用在 `003_review.sql` 上（约束删除 / 主键退化 / 外键摘除 / 列改 NOT NULL / 整表删除），
> 在 `/tmp` 副本上跑 `migration-review.test.js`，**测试必须失败才算杀灭**。
> 变异脚本：`/tmp/p2t1/mutate.mjs`（锚点按「表块内定位」而非裸词替换，避免被注释里的同名串劫持）。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **M2-1** | **Important** | **第一轮补的外键仍然不齐全** —— 预审只盯着「表与表之间的 id」，漏掉了**同层引用**：8 处真实引用型列仍是裸的 | 变异存活：`computation_snapshots.stage_id` / `.team_id` / `enterprise_confirmations.cross_judge_id` / `.signatory_user_id` / `score_stats.judge_id` / `recusal_records.audit_by` / `review_request_keys.stage_id` 去外键后**测试全绿** | 补齐这 8 条 → 外键总数 16 → **38**；逐条加 FK 拒绝用例 |
| **M2-2** | Minor | `stage_judges.conflict_declaration_id` 是**前向引用外键**（被引用的表在文件**后面**才建）→ 零覆盖 | 变异存活：去外键后测试全绿 | 补 1 条用例（正常插入 + 评委不存在被拒 + 声明不存在被拒）。⚠️ 第二个用例必须用**另一个评委** —— 否则会先撞上主键 `(stage_id, user_id)`，外键根本轮不到触发（**实测踩过**） |
| **M2-3** | **Important** | 7 处关键约束**零覆盖**：`self_reviews` 唯一索引、`stage_results` 唯一索引、`stages` 唯一索引、`computation_snapshots.stage_id`/`.team_id`、`tiebreak_votes.voter_id`/`.team_id`、`self_reviews.stage_id` | 变异存活 7 条 | 补 4 条用例（自评/结果同格唯一 / 快照与加时投票的引用完整性 / 赛段代号唯一 / 自评赛段外键） |
| **M2-4** | Minor | 「一人一队一票」与「一人一票」在测试里**无法区分** —— 原用例只测了「同一人对同一队投两次被拒」，主键退化成 `(轮次,投票人)` 照样绿 | 变异存活：主键退化为 `(tiebreak_round_id, voter_id)` 后测试全绿 | 补断言：同一人对**两支不同队伍**各投一次 → 必须能插进去、COUNT == 2 |
| **M2-5** | Minor | 幂等键表未测「**不同** `request_id` 可并存」→ 主键退化成 `(scope,赛段,主体)` 也照样绿（会误判第二次请求为重复而丢数据） | 变异存活：主键去掉 `request_id` 后测试全绿 | 补断言：同主体同 scope 下 `req-1` / `req-2` 各占一行 |
| **M2-6** | Minor | `stage_reviews` 的 UNIQUE 是**非偏序**（契约原文，没有 `WHERE deleted_at IS NULL`），而 `deleted_at` 列**全计划无人使用** → 这个「软删不腾格子」的行为**没被钉住** | 登记在案的陷阱，但无测试 | 补断言把该行为**显式钉住**：软删后同格仍插不进第二条。将来若要实现「撤回评审」，必须同步把索引改成偏序 —— 那时这条断言会**先失败**，提醒改动者 |

### 三、刻意**不**加外键的多态 / 逻辑引用

> 加外键会**锁死语义**，所以这四类列有意保持普通列 + 普通索引：

| 列 | 为什么不能加外键 |
|---|---|
| `stage_judges.scope_id` | 四态多态引用（`global` / `edition` / `task_package` / `team`），父表随态而变 |
| `stage_reviews.request_id` / `peer_reviews.request_id` / `self_reviews.request_id` | 幂等键的**逻辑引用**，真身在 `review_request_keys`（见 D-5） |
| `review_request_keys.subject_id` | 三态多态引用（`judge_id` / `from_team_id` / `team_id`） |

**Task 1 的测试条数口径**：migration-review **18**（建表存在性 1 + 关键唯一约束 5 + 引用型外键 8 + 企业确认偏序索引 1 + 非偏序 UNIQUE 登记 1 + 赛段代号唯一 1 + 自评/结果同格唯一 1 …）。

**最终结果**：变异体 44 → **KILLED 44 / SURVIVED 0**；`migration-review.test.js` **18/18**；P2 全量 **324/324**。

---

## Task 2 父代理预审修正台账（2026-10-21）

> Task 2 的规格在**实施前**被父代理逐条实跑预审（把计划里的代码块抽到 `/tmp` 独立工程里跑）。
> 规格自带的 **10 条用例全绿** —— 但预审用**探针脚本**逐个探测边界，发现 **1 Critical + 4 Important + 1 Minor**，
> 全部在实现里修掉后再补 **8 条回归用例**；
> 实施完成后又做了一轮**变异检验**，变异体一度出现 **2 条存活**，补完后 **27/27 杀灭**。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **N-1** | **Critical** | **D-1 承诺的「不传 `series` 时退回同 judgeId 在 samples 中的全部 value」根本没实现** —— 原实现对没有 `series` 的样本直接 `continue` 跳过 | 探针：`samples: [{judgeId:'j1', value:80}]` → `{"normalized":false,"values":{},"fallbackReason":null,"stats":{"n":0,…}}` —— **契约形状（`INTERFACES.md` 的 `samples: [{ judgeId, value }]`）产出「空 values + 无原因」的静默空成功** | 兑现 D-1：`series` 缺省（或所给序列全是非有限数）时，用「同 `judgeId` 在本单元内的全部 `value`」当序列。修复后同一探针 → `{"values":{"j1":0},"fallbackReason":"judge_sample_too_small","stats":{"n":1,…}}` |
| **N-2** | **Important** | **未知策略时全局统计被一起丢掉** —— 策略校验放在最前面直接 `return`，`stats` 全部返回 0 | 探针：`strategy:'nope'` + 3 个原始分 → `stats.n = 0`（真实值 3） | 全局口径**与策略无关**，把全局池统计提到策略校验**之前**计算；未知策略时照样返回真实 `stats` |
| **N-3** | **Important** | **配置坏值让 NaN 静默逃逸到榜单** —— `trimmedIterations: 0` → `0/0 = NaN`；`'x'` → `NaN`；而 `normalized` 仍报 `true`、`fallbackReason` 仍是 `null` | 探针：`trimmedIterations: 0` → `values.j1 = NaN`（JSON 序列化成 `null`），`normalized: true` | 配置 **fail-fast 抛 `TypeError`**：`minSamplesForJudgeNormalization`（整数 ≥0）、`trimmedIterations`（整数 ≥1）、`bayesPriorStrength`（有限数 ≥0）、`fallback`（枚举）。⛔ **不退回默认值** —— 那会重演 P1 T5-8「配置与实现各说各话」，且坏阈值直接产出 NaN |
| **N-4** | **Important** | **`fallback: 'raw'` 名实不符** —— reason 写着 `raw_fallback`，但 `center/scale` 仍是全局的，产出的是**全局 z 值**不是原始分 | 探针：`fallback:'raw'` → `values.j1 = 0`（全局 z），而非原始分 80 | raw 模式改为 `center = 0 / scale = 1` ⇒ **z ≡ 原始分**，与统一还原公式 `score = center + z×scale` 自洽（D-14 同步订正） |
| **N-5** | Minor | **同一 `judgeId` 在一个单元内出现两次被静默覆盖**（后者覆盖前者，调用方看不出发生过覆盖） | 探针：两个 `j1` → `values.j1 = 1.5`（第二个 value 生效，第一个无声消失） | 契约前提被破坏 → 响亮抛 `TypeError`（与「坏配置抛错」同源：没有安全的猜测） |
| **N-6** | Minor | **「声称归一化成功，却一个分数都没产出」** —— 样本 `value` 全是 null/NaN 时，`judgeStats` 里的评委没降级 → `normalized: true`，但 `values` 是空集 | 探针：`value: null` → `{"normalized":false,"values":{}}`（此条 `normalized` 侥幸为 false，但原因是「无评委」而非「无值」） | 新增第 6 个降级原因 `no_finite_values`：一个 z 值都没产出 ⇒ 显式降级，绝不谎称成功（D-17 同步登记） |

### 二、变异检验发现的实现盲区

> 变异体 **27** 个（系数改错 / 标准差分母改口径 / 阈值改边界 / 收缩权重失效 / 截尾不去极值 /
> 守卫被摘 / 符号取反 / 全局池换源 / 阈值漏除 …），在 `/tmp` 副本上跑 `normalization.test.js`，
> **测试必须失败才算杀灭**。变异脚本：`/tmp/p2t2/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **N-7** | Minor | **阈值默认值 5 从没被验证过** —— 规格里**所有**用例都显式传了 `minSamplesForJudgeNormalization: 5` | 变异存活：把默认值改成 6，18 条用例全绿 | 补用例「配置缺省时用默认值」：`config: {}` 时 n=5 走归一化、n=4 降级 |
| **N-8** | Minor | **「必须是有限数」那道守卫是唯一拦截点，却没有自己的用例** —— `bayesPriorStrength` 不受「整数」与「最小值」两道守卫保护（`'x' < 0` 为 false、`isInteger('x')` 为 false），摘掉「有限数」守卫后 `'x'` 能溜过去 | 变异存活：摘掉 `typeof/finite` 守卫后用例全绿 | 补 `bayesPriorStrength` 的 `'x'` / `NaN` / `Infinity` 断言 |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **标准差用 n−1（样本标准差）** | 已实测锁定：`A1=[80,90,70,100,60]` → `stdev = √250 = 15.811388301`。⚠️ 口径提醒：评委的 `series` 其实是「他在该维度上的**全部**打分」，从统计上说更像**总体**而非样本；但 S7 原文与计划预期值都用 n−1，**本阶段不改**，差异登记在此 |
| **`judgeStats.n` = 该评委 `series` 的长度**（不是他在本单元打了几个分） | n_i 的定义就是「该评委在该维度上的样本量」，是宽严估计的样本量 |
| **评委没在本单元打分（`value` 非有限）→ 不产出 z 值，但他的 `series` 仍计入全局池** | 评委的宽严尺度是【该维度整体】的记录，与他在这一队打不打分无关。全局池的完整性由调用方传**完整 series** 保证 |
| **顶层 `fallbackReason` 只报第一个降级原因** | 顶层是**摘要**；逐评委的完整降级状态在 `judgeStats[judgeId].fallbackReason` 里（契约 D-2 的 `judgeStats` 就是为此而设） |
| **「未知策略」不抛错、「配置非法」抛错** | 不是不一致，是两种不同的失败性质：策略名写错时「不归一化」是**安全且有意义**的降级结果；数值阈值写错时我们**猜不出**安全的值 |

**Task 2 的测试条数口径**：normalization **18**（规格自带 10 + 预审回归 8）。

**最终结果**：变异体 27 → **KILLED 27 / SURVIVED 0**；`normalization.test.js` **18/18**；P2 全量 **342/342**。

---

## Task 3 父代理预审修正台账（2026-10-21）

> Task 3 的规格在**实施前**被父代理逐条实跑预审（抽到 `/tmp` 独立工程跑）。
> 规格自带的 **7 条用例全绿** —— 但预审用**探针脚本**逐个探测边界，发现 **2 Critical + 2 Important + 1 Minor**，
> 全部在实现里修掉后再补 **10 条回归用例**；
> 实施完成后做**变异检验**，变异体一度出现 **4 条存活**（其中 1 条是**测试期望值写巧了**
> 导致根本区分不出两种算法），补完后 **21/21 有效变异杀灭**（另 1 条等价变异体）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **T-1** | **Critical** | **`minJudges` 缺省 / 非法 → 去极值闸门完全失效** —— `list.length < minJudges` 在 `minJudges` 为 `undefined` / `'x'` / `0` 时**恒为 false** | 探针：3 个评委、**不传 `minJudges`** → `{"mean":2,"trimmed":true,"removed":{"max":"j3","min":"j1"}}` —— **去极值了**。S7 §3.2 要求该维度评委数 ≥5 才去极值；去掉一高一低后只剩 1 个评委 → **该队的分数完全由单个评委决定**，评委宽严偏差直接变成队伍分差 | `minJudges` 改为**必填**且必须是 ≥1 的整数，否则抛 `TypeError`（同构于 Task 2 的配置 fail-fast）。S7 的「≥5」由规则文件里的值传入，不在代码里硬编码 |
| **T-2** | **Critical** | **席位权重没有校验 → NaN 静默进榜单 + 类型污染** | 探针：权重 `NaN` → `score = NaN`；权重 `'x'` → **`weightSum` 变成字符串 `"0x"`**（`0 + 'x'` 的字符串拼接），再拿它做除数 → NaN | 权重必须是**有限非负数**，否则抛 `TypeError`。负权重会让分数倒挂，一并拦掉 |
| **T-3** | **Important** | **零权重的维度被误报进 `missing`** → 虚假告警污染 trace 与 warning | 探针：`weights {a:0, b:1}`、`scores {b:60}` → `missing = ['a']` —— 但 `a` 的权重是 0，权重表里写 0 本身就是「不启用」 | 权重为 0 的维度直接 `continue`：不参与分子分母，**没有分也不算缺分** |
| **T-4** | **Important** | 同一 `judgeId` 出现两次被当成**两个**评委 | 探针：重复的 `j1` → `removed = {max:'j1', min:'j1'}` —— 同一个人既被当最高又被当最低 | 响亮抛 `TypeError`（与 Task 2 同一处理原则：契约前提被破坏 → 报错，不静默） |
| **T-5** | Minor | 缺分维度的权重被剔除后，`score` 是「**已有维度上的相对加权平均**」而非绝对分数 —— 这个口径原计划**完全没写** | 探针：`weights {a:0.5,b:0.5}`、只有 a 有分 → `score = 80`（不是 40） | **登记口径**并写进 Interfaces —— ⛔ Task 8 总装必须知道，否则 P 的绝对值会被误读 |

### 二、变异检验发现的实现盲区

> 变异体 **22** 个（只去一端 / 不去极值 / 均值用全体 / 并列不打破 / 闸门摘掉 /
> 权重校验摘掉 / 零权重不跳过 / 缺失当 0 分 / 不排序 / 席位由分数驱动 …），
> 在 `/tmp` 副本上跑 `trim.test.js`，**测试必须失败才算杀灭**。变异脚本：`/tmp/p2t3/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **T-6** | **Important** | **规格自带那条用例根本区分不出「有没有真的去极值」** —— 期望值 `3` **恰好**等于「去极值后均值 (2+3+4)/3 = 3」**与**「全体均值 (1+2+3+4+5)/5 = 3」两种算法的结果 | 变异存活：把 `mean` 换成全体均值，用例照样绿 | 补一条两者结果不同的数据集（`0,0,0,0,10` → 去极值后 0，全体 2），把这条缝补上 |
| **T-7** | **Important** | **「非法 z 被忽略」这半句从来没被验证过** —— 用例名叫「空值与非法 z 被忽略」，实际**只传了空数组** | 变异存活：把过滤条件从 `v && Number.isFinite(v.z)` 改成 `v`，用例照样绿 | 补用例：混入 `null` / `NaN` / `undefined` / 字符串 z，断言它们既不参与去极值也不影响 `removed` |
| **T-8** | Minor | **`kept` 为空的防御分支零覆盖** —— `minJudges` 配成 1 或 2 时 `kept` 为空，`kept.reduce(...) / kept.length` = 0/0 = **NaN** | 变异存活：摘掉防御分支，用例照样绿 | 补用例：`minJudges: 2` + 2 个评委 → 不去极值、mean = 15（不是 NaN） |
| **T-9** | Minor | **`missing` 的输出顺序零覆盖** —— 规格只测过单个 missing 维度，字典序从未被验证 | 变异存活：把 `Object.keys(w).sort()` 改成不排序，用例照样绿 | 补用例：权重表按「写入顺序 ≠ 字典序」排 3 个维度、2 个缺分 → 断言 `missing` 按字典序 |
| — | — | **等价变异体 T18**（`weightSum === 0` → `<= 0`）：T-2 修好后负权重直接抛错，`weightSum` **不可能为负**，两个判断**语义等价** | 变异存活 | **不是盲区**，标记为等价变异体、允许存活（已在变异脚本里显式标注） |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **去极值的 `mean` 单位是 z，不是 0–100** | 还原回 0–100 由 `scoring.js` 做（Task 8），本模块只提供原语。还原公式见 Task 3 的文件头注释 |
| **`removed` 只给 `judgeId`，不给被去掉的 z 值** | 契约形状是 `{max, min}`；被去掉的分数可由 `judgeId` 回查输入。⚠️ 若将来要「按行 ID 兜底排序」那类需求，这里要同步扩展 |
| **`dimensionScores` 的 0–100 区间不在本模块校验** | 上游（Task 6 的评分服务）负责区间校验；本模块只做加权 |
| **`weightSum === 0` 时 `missing` 是空的** | 「整个席位没启用任何维度」与「某维度缺分」是两种不同的事，调用方要靠 `weightSum` 判断并自己记 warning |

**Task 3 的测试条数口径**：trim **17**（规格自带 7 + 预审回归 6 + 变异补测 4）。

**最终结果**：变异体 22 → **KILLED 21 / 等价变异体 1 / 有效缺口 0**；`trim.test.js` **17/17**；P2 全量 **359/359**。

---

## Task 4 父代理预审修正台账（2026-10-21）

> Task 4 是 R1–R4 四条规则的引擎，**逻辑最密**，因此预审的探针覆盖了每条规则的分支组合。
> 规格自带的 **6 条用例全绿** —— 但探针发现 **3 Critical + 3 Important + 2 Minor**，
> 全部在实现里修掉后再补 **13 条回归用例**；
> 实施完成后做**变异检验**，变异体一度出现 **2 条存活**，补完后 **25/25 杀灭**。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **E-1** | **Critical** | **R4 触发但替代维度不可用 → 规则静默失效** —— `demandKey` 不在维度表里（或 `freeBrief` 段缺失）时，代码**发出**「改由评委按需求真实性打分」的警告，却**不产生** `r4Substitute`、企业项**按 0 分计** | 探针：`freeBrief.judgeDimension = 'no_such_dim'` → `{"seatE":{"t3":0},"w":["no_enterprise_confirmation","R4_free_brief_judge_scored"],"sub":{}}` —— **警告说替代、实际没替代，队伍被无故扣掉 10% 企业席权重，且没人知道为什么** | **fail-fast 抛错**：R4 触发但替代维度不可用 → 直接炸。规则要替代却替代不了，比算出错的 E 危险得多 |
| **E-2** | **Critical** | **R-JDG-14「签字必须有内容」零校验** —— `content` 为空或纯空白的确认照样计入分数 | 探针：`content: ''` → `seatE = 80`、**零 warning**；`content: '   '` → 同样 | 纳入「确认有效性三层判定」。⚠️ 必须放在**领域层**：本函数会被 `computeStage` 从库里读数据时调用，服务层的写入口校验挡不住历史数据与旁路写入 |
| **E-3** | **Critical** | **确认分没有 0–100 区间校验** | 探针：`rawScore: 1000` → `seatE = 1000` —— 总分公式 `(1−w_E)×P + w_E×E` → **榜单总分破 100** | 纳入三层判定；越界的确认**无效**（按 0 分计 + warning `enterprise_score_out_of_range`） |
| **E-4** | **Important** | **自由命题组的有效判定错误地依赖 `packageEnterpriseId`** —— 自由组本来就没有「本赛道企业」（该值为 null），于是它的企业确认**永远**无法被认定有效 → **永远触发 R4**，且同时发出「没有企业确认」的**误导性告警**（明明有确认记录） | 探针：自由组 + 一条**双签齐全**的有效确认 → `seatE = null`（走了 R4）、warning 含 `no_enterprise_confirmation` | 自由组按「三层判定」判有效，与赛道无关。R4 改为只在「**完全没有**企业确认」时接管 |
| **E-5** | **Important** | **R4 生效时仍发「没有企业确认」告警** → 误导（自由组没有企业确认是**预期状态**，不是漏签） | 探针：自由组无确认 → warning 列表同时含 `no_enterprise_confirmation` 与 `R4_free_brief_judge_scored` | R4 接管时**不发** `no_enterprise_confirmation` |
| **E-6** | **Important** | **配置里没有 `seat="enterprise"` 的维度 → 企业确认被完全忽略**，却告警说「没有有效的企业确认记录」—— 实为**配置缺陷** | 探针：dimensions 去掉 enterprise 维度 → `seatE = 0`、warning = `no_enterprise_confirmation`、权重表里根本没有 enterprise 键 | fail-fast 抛错（`dimensions` 为空、`enterprise` 维度缺失都抛） |
| **E-7** | Minor | **R1 命中时 `seatE` 是 `null`** —— 但计划只说「R4 生效时为 `null`」 | 探针：t4（R1）→ `seatE.t4 = null` | R1 时记 **0**（权重本已是 0），让 `null` 的**唯一含义**留给 R4 |
| **E-8** | Minor | `wEnterprise` 非法（NaN / 字符串）→ `wEnterprise > 0` 恒 false → **静默不封顶** | 探针：`wEnterprise: 'x'` → 无 `R3_enterprise_weight_capped` 警告 | fail-fast 抛错 |

### 二、变异检验发现的实现盲区

> 变异体 **25** 个（R1 不置权重 / R1 判定失效 / R2 不按 0 分 / R2 判定失效 /
> R3 不封顶 / R4 不移权重 / R4 不搬权重 / R4 不记 substitute / R4 不置 null /
> 内容校验摘掉 / 区间校验摘掉 / 自由组绑回赛道 / 三处 fail-fast 摘掉 / 告警误发 …）。
> 变异脚本：`/tmp/p2t4/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **E-9** | **Important** | **R4 的「权重搬运」从来没被真正验证过** —— 默认配置里 `track_fit` 与 `enterprise` 的权重**恰好都是 0.10**，所以「搬了」与「没搬」的结果**完全一样** | 变异存活：删掉 `eff[enterpriseKey] = base[demandKey]` 后 19 条用例全绿 | 补用例：把两个权重**拉开**（0.30 / 0.10）并把 `wEnterprise` 提到 0.40（不被 R3 压回去），才能验出差别 |
| **E-10** | Minor | **非企业维度的确认没被排除** —— `mine` 的过滤条件 `enterpriseKeys.includes(c.dimension)` 零覆盖 | 变异存活：删掉该过滤条件后 19 条用例全绿 | 补用例：一条 `dimension: 'track_fit'` 的确认 → 必须不参与企业席（`seatE = 0` + `no_enterprise_confirmation`） |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **R3 封顶只压企业席，评委席权重不动** → 权重总和会 **< 1** | R3 的原文只约束「企业席合计权重」。因为 `seatScore` 按 `Σw` 归一化，P 的**绝对值**不受影响；但**评委席的相对份额**被放大。⛔ Task 8 总装必须知道 |
| **R1 是「全体连坐」** —— 只要有**任何一家**外赛道企业签了字，该队企业项权重就归 0（哪怕本赛道企业的确认是好的） | S7 原文是「企业席评了非本企业题目 → 该队企业项权重自动降为 0」，没有「只罚那一家」的细分。⚠️ 这条**连坐口径**已用测试锁定，将来若要改成按企业分别处罚，改这里 |
| **同一企业多条有效确认 → 取平均** | 库里有偏序唯一索引（`stage_id, team_id, dimension, enterprise_id WHERE deleted_at IS NULL`），正常不会发生；领域层防御性取平均 |
| **`judges` 参数当前未使用** | 预留「企业席归属校验」；R1 目前靠 `packageEnterpriseId` 比对，不依赖评委名单 |
| **R2 / R-JDG-14 / 分数越界 三类失效的优先级是「先到先判」** | 一条确认同时缺双签又没内容 → 只报 R2（先判到的那个）。⚠️ 登记口径：一条确认只报一个原因 |

**Task 4 的测试条数口径**：enterprise-seat **19**（规格自带 6 + 预审回归 13）。

**最终结果**：变异体 25 → **KILLED 25 / SURVIVED 0**；`enterprise-seat.test.js` **19/19**；P2 全量 **378/378**。

---

## Task 5 父代理预审修正台账（2026-10-21）

> Task 5 含三个独立模块（自评差异 / 互评资格+回避 / 评委池校验），
> 预审对每条规则的分支组合都做了探针。规格自带的 **14 条用例全绿** —— 但探针发现
> **1 Critical + 4 Important + 3 Minor**，全部在实现里修掉后再补 **13 条回归用例**；
> 实施完成后做**变异检验**，变异体一度出现 **2 条存活**，补完后 **23/23 有效变异杀灭**
> （另 1 条等价变异体）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **N-1** | **Critical** | **回避的「撤销」永远失效** —— `checkRecusal` 的 `for` 循环遇到**第一条**匹配记录就 return，而 `recusal_records` 是 **append-only** 的：「回避 → 组委会复核 → 撤销」会留下**两条**记录，于是取到的是第一条 `recused`，`action='reinstated'` 的那条**从未被读到** | 探针：`[{recused}, {reinstated}]` → `{"recused":true}` —— **无论顺序如何结果都是回避中**。规格自带的用例只给了**单条** reinstated 记录，正好掩盖了这一点 | 取**最后一条**匹配记录（按 `declared_at`，缺省按数组顺序）再判它的 action。⚠️ 这条修正让「撤回回避」这个功能第一次真正生效 |
| **N-2** | **Important** | **席类型写错的评委静默消失** —— 既不计入 voting 也不计入 observer，`stats.total` 与 `voting + observer` **对不上**，却没有任何告警；而且这些评委本该属于哪个席会影响占比判断 | 探针：9 voting + 2 个 `seat:'guest'` → `{"ok":true,"total":11,"voting":9,"observer":0,"errors":[]}` | 报错 `unknown_seat`；`stats.unknownSeat` 单独计数，账能对上 |
| **N-3** | **Important** | **评委池的配置项非法 → 对应校验整条静默失效** —— `Number('x')` = NaN，`minJudges > 0` 恒 false → 「人数不足」这条校验**不执行** | 探针：`minJudgesPerDimension:'x'` + 只有 3 名评委 → errors 里**没有** `judge_pool_too_small` | 配置 fail-fast 抛错（同构于 Task 2/3） |
| **N-4** | **Important** | **重复 judgeId 被当成两个人** → 专家席/企业席占比算错 | 探针：4 专家 + 5 企业 + 重复的 `e1` → `expert: 5`（应为 4） | 报错 `duplicate_judge`，且统计按**去重后**的人数算 |
| **N-5** | **Important** | **自评的 `threshold` 非法 → 静默产出零 flag** —— `d > NaN` 恒 false，看上去像「所有自评都正常」 | 探针：`threshold:'x'` → `flags: []` | fail-fast 抛错 |
| **N-6** | Minor | **自评的 `judgeMap` 重复键静默覆盖** —— 结果取决于数组顺序 → 不可复算 | 探针：两条评委分 90 / 80 → 用了 80（最后一条） | 响亮报错（契约前提：每格一条聚合分） |
| **N-7** | Minor | **`flags` 排序用 `localeCompare`** → 依赖运行环境 locale 与 ICU 版本，同一份数据在不同机器上可能排出**不同顺序** → 破坏「可复算」 | 探针：`localeCompare` 得 `["T1","t10","t2","ta","tB"]`，普通字典序得 `["T1","t10","t2","tB","ta"]` | 改用与 `trim.js` 一致的普通字典序比较 |
| **N-8** | Minor | **赛段级回避只认 `null` 不认 `undefined`** → 数据来源一变就漏判 | 探针：`team_id: undefined` → `recused: false` | `null` / `undefined` 都算赛段级 |
| **N-9** | Minor | 互评的 `teams` 重复 → `eligible` 里出现重复队号；`deliverables` 重复 → 后者静默覆盖前者 | 探针：`teams:[t1,t1]` → `eligible:['t1','t1']` | teams 去重、deliverables 重复报错 |

### 二、变异检验发现的实现盲区

> 变异体 **24** 个（threshold 校验摘掉 / 重复检查摘掉 / 排序改回 localeCompare /
> 回避取第一条 / reinstated 不解除 / 赛段级不生效 / 席类型不报错 / 重复 id 不报错 /
> 占比分母换错 / 观察员算进 voting / ok 恒 true …）。
> 变异脚本：`/tmp/p2t5/mutate.mjs`（三个模块共用一个 harness）。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **N-10** | Minor | **`eligible` / `ineligible` 的排序零覆盖** —— 规格那条用例的 teams **恰好已是字典序**，排序与不排序结果一样 | 变异存活：删掉两行 `.sort()` 后 27 条用例全绿 | 补用例：刻意把输入顺序打乱（`tb,td,ta,tc`）→ 断言输出按字典序 |
| — | — | **等价变异体 S06**（缺评委分时也硬算 `d`）：`d` 变成 NaN，自然命不中阈值，**输出的 flag 完全相同** | 变异存活 | **不是盲区**，标记为等价变异体、允许存活（已在变异脚本里显式标注） |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **`checkJudgePool` 用 `errors` 而不是抛错来处理「未知席 / 重复 id」** | 这个函数的契约就是 `{ok, errors, stats}` —— 「池子有问题」是**可预期的业务结果**，由调用方决定是否放行；而「配置项写坏」是**代码级错误**，只能抛（与 Task 2/3 一致） |
| **`perDimension` 目前只有 `{all: voting.length}` 一个键** | 冲突裁决 C-05 第 1 条：专家席跨任务包评分 → 每个维度都覆盖**全部**有投票权的评委 → 「每维度人数」== 总有投票权人数。⚠️ 将来若改为「按维度分组配评委」，这个结构要跟着改 |
| **互评资格里「没有交付物记录」与「交付物为 false」同样算不合格** | 缺记录本身就是「没有真实交付物」的默认读法（`deliverableMap.get()` 返回 undefined → falsy） |
| **`detectSelfEvalDiff` 只产出 flag，不产出分数** | 机制归因（S7 §4.3）：自评一旦能加分就变成博弈项 → 只触发「解释」与「提问」。分数处理在 `scoring.js` 按 `action` 显式执行 |

**Task 5 的测试条数口径**：self-eval **7** + review-eligibility **12** + judge-pool **8** = **27**。

**最终结果**：变异体 24 → **KILLED 23 / 等价变异体 1 / 有效缺口 0**；三个测试文件 **27/27**；P2 全量 **405/405**。

---

## Task 6 父代理预审修正台账（2026-10-21）

> Task 6 是 P2 第一个**碰数据库**的任务，缺陷密度最高。
> 规格自带的 **10 条用例全绿** —— 但预审发现 **2 Critical + 4 Important + 3 Minor**，
> 全部在实现里修掉后再补 **12 条回归用例**；
> 实施完成后做**变异检验**，变异体一度出现 **4 条存活**，补完后 **19/19 有效变异杀灭**
> （另 1 条等价变异体）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **V-1** | **Critical** | **「抢幂等键」与「写数据」不在同一事务** —— 抢键成功后写数据失败（如评委被回避 → 403），**键已经占住** → 客户端用同一个 `requestId` 重试会被判成「重复请求」并返回 `submitted: 0` → **评委以为提交成功了，实际一条都没落库** | 实跑：先 `declareRecusal` 再提交 → 403；查 `review_request_keys` → **键已存在**；换一支没被回避的队用**同一个** `requestId` 重试 → `submitted: 0`，`stage_reviews` 仍是 0 行 | 「抢键 + 写数据 + 更新统计 + 审计」放进**同一个事务**（`BEGIN IMMEDIATE`），失败回滚。⚠️ 用 `IMMEDIATE` 而非默认的 `DEFERRED`：立即取写锁，避免抢键与写数据之间被另一个连接插进来 |
| **V-2** | **Critical** | **`insertStage` 的参数个数与占位符对不上** —— `stages` 表**没有** `created_at` 列，但 INSERT 传了 11 个参数而只有 10 个占位符 | 实跑：建赛段 → `Error: column index out of range`，**全部 19 条用例一条都跑不起来** | 去掉多传的 `now`（`now` 保留在签名里只为调用方接口统一）。**这是计划规格里自带的 bug** |
| **V-3** | **Important** | **测试夹具用假 id**（`'ed1'` / `'t1'` / `'t2'` / `'t9'`）→ Task 1 补齐外键后**必然失败** | 实跑：插入 `stage_reviews` 时 `FOREIGN KEY constraint failed` | 夹具改建**真实的**届期 / 用户 / 战队 / 赛段（与 P1 的 `migration-002.test.js` 对齐）。⚠️ Task 7 / Task 8 的夹具**同样必须改** |
| **V-4** | **Important** | **同一个 `requestId` 用于不同内容 → 静默继续写** —— 幂等的含义是「只生效一次」，内容变了说明客户端复用了 `requestId`，是 bug；静默写进去会让「这个 request 到底写了什么」永远说不清 | 实跑：同 `requestId` 换成另一支队 → 直接写进去了 | 409 `REQUEST_ID_REUSED`（响亮报错），先比对上一次落库的内容键集合 |
| **V-5** | **Important** | **评分进度把「已有打分记录」当成「应交队伍」** —— 某个队**完全没人打分**时它根本不在名单里 → 进度显示 100% 而实际有队没被评 | 实跑：2 支队只给 1 支打分 → `total = 1`（应为 2）、`missing = []` | 应交队伍改用赛段**真实名册**（`listStageTeams`） |
| **V-6** | **Important** | **互评的幂等键主体从 `items` 推导**（`fromTeams.join('+')`）→ `items` 变了主体也变 → 键抢不到自己 → **幂等被绕过** | 实跑：同 `requestId` 换一批互评对象 → 又写进去了 | 主体改用**提交方**（`actorId`），没有时退化成 `'*'` 并靠内容比对兜住 |
| **V-7** | Important | **分数没有 0–100 区间校验** → 评委提交 1000 分会污染 `score_stats` 与后续归一化 | 实跑：`rawScore: 1000` → 原样落库 | 400 `SCORE_OUT_OF_RANGE`（评委打分 / 校准 / 互评 / 自评 / 企业确认**五处**统一） |
| **V-8** | Minor | **赛段不存在 → 外键原文漏到调用方** | 实跑：`stageId: 'no-such-stage'` → SQLite 原文 | 先校验赛段存在 → 404 `STAGE_NOT_FOUND`（与 P1「届期不存在 → 404」同款） |
| **V-9** | Minor | **幂等键的 UNIQUE 兜底正则过宽** —— P1 的 T-7 已经踩过一次同样的坑 | 实跑：把 `request-keys.js` 的正则放宽成 `/UNIQUE\|constraint/i` → 「外键失败」被误判成「重复请求」而**静默吞掉** | 收紧为 `/UNIQUE constraint failed: review_request_keys/i`，其它约束错继续往上抛 |

### 二、变异检验发现的实现盲区

> 变异体 **20** 个（不开事务 / 不回滚 / 不查内容复用 / 摘掉分数校验 / 摘掉回避检查 /
> 旧分不扣 / 新分不加 / 进度用已有记录 / 漏乘维度 / 摘掉互评资格 / 摘掉自评互评检查 /
> 不写声明 / 不回填两列 / 不写审计 …）。变异脚本：`/tmp/p2t6/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **V-10** | Minor | **幂等兜底正则的「只认唯一约束」零覆盖** —— 测试里没有任何一条会触发**非唯一约束**的失败 | 变异存活：放宽正则后 19 条用例全绿 | 补用例：直接调 `claimRequestKey` 传入不存在的 `stageId` → 必须抛 `FOREIGN KEY`，不得被当成「重复请求」 |
| **V-11** | Minor | **进度的 `total` 漏乘维度数零覆盖** —— 测试里只有一个维度，乘不乘都一样 | 变异存活：`total` 不乘维度后全绿 | 补用例：2 队 × 2 维度 → `total = 4` |
| **V-12** | Minor | **「不能给自己互评」零覆盖** | 变异存活：摘掉检查后全绿 | 补用例：`fromTeamId === toTeamId` → 400 |
| — | — | **等价变异体 V04**（去掉幂等快速路径）：事务内 claim 键失败时同样幂等短路，快速路径只是省一次查询 | 变异存活 | **不是盲区**，标记为等价变异体、允许存活（已在变异脚本里显式标注） |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **`submitPeerReviews` / `submitSelfReviews` 不校验「调用者是不是该队成员」** | 服务层签名里没有 actor 概念（互评的 actor 是「队」）。⚠️ **Task 8 的 API 层必须做这个校验** —— 否则任何登录用户都能替别的队伍互评 / 自评。已在 P2 计划里登记为 API 层的责任 |
| **互评的「真实交付物」判据 = 「该赛段已有评委打分记录」** | P2 阶段没有交付物表（Task 5 的三池工作流在 P5）。⚠️ **P5 落地后要改这一处** —— 判据换成交付物表 |
| **`submitCalibration` 不做幂等** | 校准分不计入评分，重复插入只影响校准记录数；⛔ 但校准记录是「赛后 6 个月可查」的留痕，将来若要统计校准次数需补幂等 |
| **改分走「覆盖写 UPDATE」**（不是软删 + 新增） | `stage_reviews` 的 UNIQUE 是**非偏序**的（Task 1 已登记的陷阱）—— 软删不腾格子，所以改分只能覆盖写 |
| **`audit_log` 的 SQL 唯一归宿是 `src/db/repo/audit-log.js`** | 全局约束「所有 SQL 收进 `src/db/repo/`」；`src/audit/log.js` 是**薄服务门面**，不含任何 SQL（P0 的 `sql-boundary.test.js` 会扫描并判违规） |

**Task 6 的测试条数口径**：review-service **22**（规格自带 10 + 预审回归 12）。

**最终结果**：变异体 20 → **KILLED 19 / 等价变异体 1 / 有效缺口 0**；`review-service.test.js` **22/22**；P2 全量 **427/427**。

---

## Task 7 父代理预审修正台账（2026-10-21）

> Task 7 是 P2 的「破同分」链，规格自带的 **5 条用例全绿** —— 但预审发现
> **2 Critical + 3 Important + 2 Minor**，全部在实现里修掉后再补 **12 条回归用例**；
> 实施完成后做**变异检验**，变异体一度出现 **7 条存活**，补完后 **13/13 有效变异杀灭**
> （另 1 条等价变异体 + 2 条不可黑盒观测的变异体）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **B-1** | **Critical** | **未关闭的轮次也被算进复议分** —— `getTiebreakExtraScores` 取了**全部**轮次，于是一个还在开放投票的轮次，其**当前均值**被当成最终复议分 → **榜单随投票进行而漂移**，而且未完成的轮次就参与了排名 | 实跑：开轮次 + 投一票后 → `extra = {t1: 80}`；关闭后才是「最终」值 | 只消费 `status='closed'` 的轮次 |
| **B-2** | **Critical** | **关闭一个不存在的轮次 → 裸 TypeError 漏到调用方** —— UPDATE 0 行 → 返回 `null` → 紧接着 `round.stage_id` 抛「Cannot read properties of null」，而它**不是 AppError** → HTTP 层只能回通用文案「请求无效」，调用方既拿不到状态码也拿不到原因 | 实跑：`closeTiebreakRound({roundId:'no-such-round'})` → `TypeError` | 先校验轮次存在 → 404 `TIEBREAK_ROUND_NOT_FOUND` |
| **B-3** | **Important** | **投票人不校验是否有投票权** —— 观察员（R-JDG-11 无投票权）、未被分配到赛段的人、**回避该队的评委**（R-JDG-09）都能投票 | 实跑：观察员投票 → 原样写入 | 三道闸门：已分配 + 非 observer + 未回避 |
| **B-4** | **Important** | **投票分没有 0–100 区间校验** → 1000 分进票 → 复议分破 100 | 实跑：`score: 1000` → 原样落库 | 400 `SCORE_OUT_OF_RANGE` |
| **B-5** | **Important** | **UNIQUE 兜底正则过宽** —— `/UNIQUE\|constraint/i` 会把「外键失败」也当成「重复投票」→ 409 → 真实错误被伪装成幂等冲突（Task 6 已踩过一次） | 实跑：放宽正则后，外键失败被回成 409 | 收紧为只认 `/UNIQUE constraint failed: tiebreak_votes/i` |
| **B-6** | Minor | **轮次排序不确定** —— 只按 `created_at` 排，同一秒开启的两个轮次时间戳相同，而 SQLite 的 ORDER BY 对并列行**不保证稳定** → 「多轮取最新一轮」取到哪一轮随缘 → **破同分链不可复算** | 代码审查（并列排序的不稳定性） | 加 `rowid` 兜底（全局约定：兜底排序键一律用 SQLite 隐式 `rowid`）。⚠️ 该修正**不可黑盒观测**（见下方） |
| **B-7** | Minor | **开轮次不校验「同分组」是否合法** —— 可以开一个只有一支队伍的「同分」轮次；同一赛段也能同时开两个 open 轮次 → 票分散在两轮里 | 实跑：`tiedTeamIds: ['t1']` → 成功开轮 | 同分组去重后 ≥2 支；同赛段只允许一个 open 轮次；同分组队伍必须真实存在且属于本赛段 |
| **B-8** | Minor | 测试夹具用假 id（`'ed1'` / `'t1'` / `'t2'`）→ Task 1 补外键后必然失败 | 实跑：插入时 `FOREIGN KEY constraint failed` | 夹具改建真实届期 / 用户 / 战队 / 赛段 |

### 二、变异检验发现的实现盲区

> 变异体 **16** 个（关不存在的轮次不 404 / UNIQUE 兜底放宽 / 摘掉分数校验 /
> 摘掉观察员与回避检查 / 摘掉同分组检查 / 摘掉「只允许一个 open 轮次」 /
> 复议分消费全部轮次 / 均分用 sum / 排序去 rowid …）。变异脚本：`/tmp/p2t7/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **B-9** | Minor | **UNIQUE 兜底只认唯一约束这条规则零覆盖** —— 没有任何一条测试会触发**非唯一约束**的失败 | 变异存活：放宽正则后 17 条用例全绿 | 补用例：直接插一个「同分组含幽灵队伍」的轮次（绕过开轮次的校验），从**服务层**打通 → 外键失败必须继续往上抛 |
| **B-10** | Minor | **回避中的评委能不能投票零覆盖** | 变异存活：摘掉回避检查后全绿 | 补用例：先写回避记录 → 投票 403 |
| **B-11** | Minor | **均分算错测不出来** —— 规格自带那条用例只有**一票**，`mean` 与 `sum` **恰好都是 80** | 变异存活：用 sum 代替 mean 后全绿 | 补用例：两票（80 / 60）→ `sum = 140`、`mean = 70` |
| **B-12** | Minor | **轮次不存在时投票的 404 零覆盖** | 变异存活 | 补用例：`roundId: 'no-such-round'` → 404 |
| — | — | **等价变异体 B12**（关闭轮次不再幂等）：UPDATE 把 `closed` 再写成 `closed`，结果完全相同 | 变异存活 | **不是盲区**，标记为等价变异体 |
| — | — | **不可黑盒观测 B15 / B16**（排序去掉 `rowid` 兜底）：并列行在 SQLite 内部排序器里本就按扫描序返回，**黑盒测试无法区分** | 变异存活 | 保留 `rowid` 兜底（全局约定 #43），**按构造正确性**接受，不追求用例会话覆盖 |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **复议分 = 该队在该轮所有投票的均值** | R-JDG-19 的原文是「企业席 + 评委席共同复议」→ 均分（不是最高分、不是加权） |
| **`closeTiebreakRound` 幂等** | 重复关闭原样返回，不报错（网络重试不该让组委会看到 500） |
| **投票不给「改票」能力** | `tiebreak_votes` 的主键是 `(轮次,投票人,队伍)`，同一人对同一队只能投一次；⛔ 要改票得开新一轮 |
| **同一人对不同队伍各投一次是允许的** | 破同分时每位评委都要给每支并列队打分。⚠️ 精确语义是「一人**一队**一票」，不是「一人一票」（Task 1 已登记） |

**Task 7 的测试条数口径**：tiebreak **17**（规格自带 5 + 预审回归 12）。

**最终结果**：变异体 16 → **KILLED 13 / 等价变异体 1 / 不可观测 2 / 有效缺口 0**；`tiebreak.test.js` **17/17**；P2 全量 **444/444**。

---

## Task 9 父代理预审修正台账（2026-10-21）

> Task 9 兑现的是 P0 在 `platform/web/api.js:28-30` 里**欠下的一条债**（漂移审计 I-6 的第 ① 条路）。
> 实施前的父代理预审在 `src/http/sse.js` 的规格里发现 **2 处 Important**；
> 实施完成后做**变异检验**，变异体一度出现 **4 条存活**（另有 2 条只能靠「测试挂起」才被检出），
> 补完用例后 **43/43 有效变异杀灭**（另 2 条等价变异体 + 2 条不可观测变异体）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **S9-1** | **Important** | **`parseSsePath` 直接调 `decodeURIComponent`** → 畸形百分号编码（`/api/stages/%E0%A4%A/events`）抛 `URIError` | 探针：`parseSsePath('/api/stages/%E0%A4%A/events')` → `URIError: URI malformed`。该异常若逸出 server.js 的 try 之外 → **整个进程退出**（P0 的原教训，一字不差地重演） | 解析失败**返回 null** → 走正常的「非法 URL」分支（400）。补 1 条用例钉住 |
| **S9-2** | **Important** | **没有心跳帧** → 中间的 nginx（`proxy_read_timeout` 默认 60s）会掐线，现象是「前端每隔一分钟重连一次」 | 规格的 `sse.js` 全文无任何心跳相关代码 | 增加 `sendSseComment()`（`: ping\n\n` 注释帧）；server.js 用 `setInterval(...).unref()` 每 25s 发一次，`res.on('close')` 里 `clearInterval`（D-39） |

### 二、变异检验发现的实现盲区

> 变异体 **47** 个（权限闸门逐条摘掉 / 帧格式改错 / 头字段删掉 / topic 写错 → 跨赛段串台 /
> 载荷加回 `judgeId` / publish 挪到提交之前 / 断开不摘订阅者 / 方法闸门摘掉 …），
> 在 `/tmp` 副本上跑 `sse.test.js` + `server.test.js` + `review-api.test.js` + `review-service.test.js` + `zero-deps.test.js`
> （**测试集必须覆盖被测文件的全部用例**，否则会制造假存活），
> **测试必须失败才算杀灭**。变异脚本：`/tmp/p2t9/mutate.mjs`。
>
> ⚠️ 首轮变异跑出的 2 个「挂起式检出」暴露了**用例自身**的三个问题，已一并修掉（M9-10 / M9-11）——
> 检出信号从「测试挂住」升级为「断言失败」，两者强度完全不同。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **M9-1** | **Important** | **跨赛段串台零覆盖** —— `publish` 的 topic 过滤、订阅端的 topic 登记都没有用例 | 变异存活：`publish` 去掉 topic 过滤 / topic 写死 `stage:all` / 订阅不带 topic → 用例全绿 | 补「赛段 B 的订阅者不得收到赛段 A 的进度事件」用例（D-41） |
| **M9-2** | **Important** | **「失败的提交不推送」零覆盖** —— `publish` 的位置（提交成功**之后**）没有约束 | 变异存活：publish 挪到 `submitReviews` 之前 → 用例全绿 | 补「分数越界 400 时不得收到进度事件」用例（D-42） |
| **M9-3** | **Important** | **连接泄漏零覆盖** —— `res.on('close')` 里 `reviewEvents.remove(res)` 没有用例 | 变异存活：`remove` 退化成 no-op → 用例全绿 | 补「客户端断开后订阅者必须被摘掉」用例（D-43） |
| **M9-4** | Minor | **权限闸门 5 条放行路径只测了 1 条** —— 只测了「本赛段评委」，另外 4 条（赛段/全局 × `score:read`/`stage:compute`）零覆盖 | 变异存活：摘掉任一 `can()` 分支 → 用例全绿 | 补「5 条放行路径都真的放行」用例（4 个用户逐一订阅） |
| **M9-5** | Minor | **响应头零覆盖** —— `X-Accel-Buffering: no` / `Cache-Control` 删掉后用例照样绿 | 变异存活 | 补响应头断言（D-45） |
| **M9-6** | Minor | **方法闸门零覆盖** —— 非 GET 方法会不会误开 SSE 没有用例 | 变异存活：去掉 `req.method === 'GET'` 判断 → 用例全绿 | 补「POST → 404」用例（D-44） |
| **M9-7** | Minor | **载荷形状只断言了「没有 judgeId」** —— `stageId` / `at` 的形状没钉住 | 变异存活：`at` 改成数字 → 用例全绿 | e2e 用例把 `data:` 行解析成 JSON 逐字段断言 |
| **M9-8** | Minor | **`sendSseEvent` 的缺省载荷 / 结束守卫零覆盖** —— `data ?? null` 与 `writableEnded` 守卫都没有自己的用例 | 变异存活 | 补 2 条用例（缺省 → `data: null`；已结束 → 返回 false） |
| **M9-9** | Minor | **`parseSsePath` 的路径尾部没钉死** —— 正则去掉 `(?:\?|$)` 后，`/api/stages/x/eventsY` 也会被当成 SSE 路径（正则**没有** `$` 锚） | 变异存活：去掉 `(?:\?|$)` → 用例全绿 | 补边界断言：`/eventsX` 与 `/events/` 必须返回 null |
| **M9-10** | Minor | **测试进程不退出** —— `finally` 里只 `server.close()`，SSE 长连接仍占着 socket → `node --test` 一直等，**CI 上直接挂死** | 首轮变异跑出 4 个孤儿 `node test/sse.test.js` 进程（每个存活 10 分钟以上），把整轮变异拖成小时级 | 收尾加 `server.closeAllConnections?.()`；`sse.test.js` 耗时 **5.6s → 1.65s** |
| **M9-11** | Minor | **用例里的超时用错了 API** —— `req.setTimeout` 是**socket 超时**，响应一结束就被清掉 → 错误响应下 promise 永不 settle → 用例**挂起**而不是失败；断言写在 http 回调里 / `setTimeout` 回调里同理 | 首轮变异里 B02 / B12 只能靠「挂起」被检出；探针复现：`node --test test/sse.test.js` 停在第 13 条用例不退出 | 改用**墙钟定时器** + 「响应结束即 reject」；断言一律移到 promise **之外**。改完后同一变异体 → **6 条干净失败、进程正常退出** |
| — | — | **等价变异体 B04 / B06**（删掉权限闸门里的「全局级 `score:read`」/「全局级 `stage:compute`」分支）：`can()` 第 107 行「`if (row.scope_type === 'global') return true;`」—— 只要有全局授权，**赛段级那次 `can()` 调用就已经返回 true**，因此「赛段级分支 ⊇ 全局级分支」，删掉全局分支不改变任何判定结果 | 变异存活（如标注） | **不是盲区**，标记为等价变异体、允许存活 |
| — | — | **不可观测变异体 B09 / B10**（断开时不清心跳定时器 / 心跳定时器不 `unref`）：定时器在 `res.on('close')` 里被 `clearInterval`，而用例收尾会把连接全关掉 → 定时器随之消失；`unref` 真正的差别在「进程退出时仍有活跃 SSE 连接」这一**生产场景**（优雅停机），黑盒用例覆盖不到 | 变异存活（如标注） | **不是盲区**，标记为不可观测变异体、允许存活 |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **SSE 不挂 router** | P0 的 router handler 约定是「返回一个值 → server.js 统一 `json()` 序列化并结束响应」；SSE 要**长期持有这条连接** → 挂 router 会被 `json()` 提前收尾，客户端只收到第一帧就断。故 SSE 走 `src/server.js` 里**独立于 router** 的分支，且放在 `router.match` **之前**（SSE 路径不在 router 里，先 match 会直接 404） |
| **事件只作「信号」，不带业务数据** | 载荷只有 `{ stageId, at }`，**没有 judgeId、没有分数、没有队伍**（D-37）。客户端收到后**重新拉 `review-state`** —— 可见性由那一层按观众过滤（全局约束「可见性在 API 层过滤」）。事件流一旦带业务数据，就等于**绕过可见性层** |
| **发布点在 HTTP 层（不在 service 层）** | `submitReviews` 是纯业务服务，不该知道 HTTP 的存在；「这次请求造成了可观察的进展」属于 HTTP 层的判断 |
| **心跳用注释帧而不是事件帧** | 注释帧以 `:` 开头，EventSource 会忽略它 —— 心跳**不该**让前端触发业务处理；`unref()` 保证定时器不拖住进程退出 |
| **权限闸门保留「赛段级 ∨ 全局级」两条 `can()` 调用** | 两条在语义上**冗余**（`can()` 的全局判定与 ctx 无关，赛段级那次已覆盖），但与 P2 其余接口的 `requireStageCapability` 写法保持一致 —— 一致性比消除冗余更重要；该冗余已登记为等价变异体 B04 / B06 |

**Task 9 的测试条数口径**：sse **20**（规格自带 11 + 变异检验补测 9）。

**最终结果**：变异体 47 → **KILLED 43 / 等价变异体 2 / 不可观测变异体 2 / 有效缺口 0**；`sse.test.js` **20/20**；P2 全量 **537/537**。

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*
## 计划块逐字同步台账（2026-10-21 · 漂移审计统一同步轮）

> **背景**：计划里的代码块是「该文件**当前实现**的逐字副本」。后续阶段按
> 「**最早建立者 owns、后续阶段 Modify（追加）不得重建**」改了实现，owning 阶段的计划块就会漂移。
> 本轮用 `docs/tools/plan-block-audit.mjs`（**可复算**）判定 C 类漂移，并分两档处置：
>
> - **真重写（C-RW）**：实现被后续阶段**重写**（改动落在既有行上）⇒ 计划块**必须逐字同步**回本计划；
> - **良性扩展（C-EXT）**：后续阶段只是**追加**（结构性现象）⇒ 计划块**保持原样**，只在此记明「谁追加了什么」。
>
> **同步工具**：`docs/tools/plan-block-sync.mjs`（定位信号与 `--verify` **同源**，避免外部脚本的定位歧义）。
> 本轮同步后漂移审计从 **C-RW 9 条 → 0 条**、A 类从 **184 → 192**。

### 真重写（已逐字同步）

| 编号 | 文件 | 漂移来源（哪个后续阶段改了什么） | 同步后行数 | 核验 |
|---|---|---|---|---|
| SYNC-5 | `src/db/repo/computations.js` | P4 审计数据模型（005 迁移、仓储层与错误/事务基础设施）→ P4 终审修复轮（4 条 Important + 7 条 Minor） | 113 | `--verify` 逐字一致 |
| SYNC-6 | `src/http/routes/review.js` | P2 SSE 评审进度推送 → P2 终审修复（进度分母用维度全集 / 评委池校验接线 / 回避撤销写路径）→ P4 审计 API → P4 终审修复轮 | 386 | `--verify` 逐字一致 |

> **注意**：`src/http/routes/review.js` 是本仓「**路由优先级 = 逐段比较**」的关键落点，
> P4 的审计路由是**插在既有评审路由之间**的 —— 计划块原本停在 P2 终审修复轮，
> 少了 P4 那几段会让读者以为评审路由与审计路由的相对次序是另一回事。

### 良性扩展（仅记录，计划块保持原样）

本计划本轮无 C-EXT 条目。

> ⚠️ **口径**：C-EXT 的「良性」指**结构上**是追加，不等于内容永远不变。
> 漂移审计可随时复算：`node docs/tools/plan-block-audit.mjs platform`。
> 若某个文件后续被**重写**（而非追加），它会自动从 C-EXT 升到 C-RW，届时必须再做一次同步。


# P3 榜单与积分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 能真实发榜：A 榜（赛段名次）/ B 榜（商业战绩）/ 个人积分榜三条线并列不合成一个总分；破同分链 6 级有序并落到确定性兜底；名次积分 10/8/5；MVP 每任务包 1 个；个人积分终生上榜；段位锚定企业签字里程碑并可降级；行为分与总分**在算法层隔离**；可见性在 API 层过滤。

**Architecture:** 延续 P0 分层：`src/domain/*` 纯函数（无 IO、无 `Date.now()`、无 `Math.random()`），`src/services/*` 编排用例，`src/db/repo/*` 收全部 SQL，`web/views/*` 原生 ESM 前端。P3 消费 P2 的 `stage_results`（总分口径）与 `computation_snapshots`（trace 与降级告警）、P1 的 `teams` / `task_packages` / `team_members`，**新增一条独立的行为分数据通路**（`behavior_events`），行为分只从这条路进破同分链的最后一档。发榜是显式动作（`publishLeaderboard`），每次发榜写 `leaderboard_snapshots` 快照 + 审计日志，满足"可复算"。

**Tech Stack:** Node ≥22.5（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## Global Constraints

```
运行时      Node ≥ 22.5（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite。data/app.db，WAL 模式。单写者：禁止多 worker 写同一文件
测试        node:test。命令：node --test test/
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
```

**P3 追加约束（每条都要在代码里能找到对应物）**

```
分轨强制    行为分【只】允许出现在破同分链的 'behavior' 项（scope=tied_only，链中最后一项
            实质依据）。⛔ 绝不进 scoreStage() 入参、绝不进 total / seatP / seatE、绝不进名次
            积分、绝不进 points_ledger 的 stage_rank 积分。
            数据来源是独立表 behavior_events，⛔ 不从 stage_results 派生。
            实现保障：rankTeams 的 assertChainInvariants() 在 behavior 排链首 /
            scope 非 tied_only / 不是最后一项实质依据时直接抛错。
段位公示    冲突裁决 C-02：C 段及以上公示队名与名次；D 段【不公示排名】，只给本人进度卡。
            落地：rules/visibility.json 的 rank.publicFromTier="C" / privateBelowTier="D"，
            实现在 domain/visibility.js 的 scope='tier' 分支。
破同分链    冲突裁决 C-03 的 6 级有序链以 rules/tiebreak.json 为准，P3【只消费不修改】：
            总分(always) → 加时陈述复议分(final_only) → 互评分(tied_only) →
            企业确认原始分(tied_only) → 行为分(tied_only) → 队伍编号(always, 确定性兜底)。
            ⚠️ 最后一级用【队伍编号（行 ID）】而不是时间戳：借 CTFd 的双保险写法
            `ORDER BY score DESC, date ASC, id ASC`，官方注释理由是【不同数据库的时间精度
            不同】，只用时间字段排序不稳。
积分        赛段名次积分 10/8/5（rules/points.json.stagePoints），仅前 3 名计分。
            ⚠️ 回归测试写死【我们的预期值 = 10/8/5】：上游 HackSC/hibiscus 的
            `calculatePoints.ts`（MIT）switch 无 break 穿透，实际发 18/8/3/1（上游自己写的
            是 10/5/2/1），相对顺序不变但数值错——抄时必须修。
可见性      在 API 层过滤，前端拿不到无权数据；前端隐藏 = 数据已泄露。
            B 榜响应体不含评分与签字人；段位榜 D 段不出现在 rows；互评来源不公示；企业名不公示。
追加式      points_ledger / behavior_events 只增不改（无 deleted_at、无 updated_at）。
纯函数      src/domain/* 无 IO、无 Date.now()、无 Math.random()；时间与随机数由参数传入。
错误        服务层抛 AppError（code + message + status）；领域层只抛编程错误（配置非法）。
```

## File Structure

**本阶段创建**

```
platform/
├── rules/
│   ├── points.json                     ★ 名次积分 / MVP / 个人积分（INTERFACES.md §4 逐字 + fallbackPolicy 注释位）
│   └── criteria.json                   ★ 段位附加条件、行为分证据要求、MVP 积分口径（P3 自有，见文末偏差）
├── db/migrations/004_leaderboard.sql   ★ points_ledger / tier_records / behavior_events / leaderboard_snapshots
│                                          （+ 里程碑、签字、加时陈述四张补充表，见文末偏差）
├── src/
│   ├── domain/    util.js · ranking.js · points.js · tier.js · behavior.js · visibility.js（全部纯函数）
│   ├── services/  leaderboard.js · performance-card.js · tier.js
│   ├── db/repo/   leaderboard.js · points.js · tiers.js（全部 SQL）
│   └── errors.js                      ★ AppError（**P1 已建**，本阶段只复用不重建）
├── web/views/    leaderboard.js · tier.js · card.js
└── test/         leaderboard-migration · ranking · points · tier · behavior · visibility
                  · leaderboard-service · leaderboard-web（8 个 .test.js）
```

**本阶段修改**：`platform/src/config.js`（载入 + 校验 points/criteria + `getDefaultRules()`）｜`platform/src/server.js`（4 个 P3 路由）｜`platform/web/app.js`（3 组路由 + query 透传）｜`platform/web/api.demo.js`（演示版补 P3 接口）。

**本阶段【不】修改（只消费）**：`rules/tiebreak.json`、`rules/ranks.json`、`rules/behavior-points.json`、`rules/visibility.json`（P0 已定稿）。

---

## ★ 数据流图：行为分与总分的两条独立通路（本阶段最关键的一张图）

```
┌── 通路 A：总分（进 A 榜名次 / 奖金 / MVP）──────────────────────────────┐
│  stage_reviews ─┐                                                     │
│  enterprise_confirmations ─┼→ domain/scoring.scoreStage()             │
│  self_reviews ─┤           ⛔ 入参对象【不存在】行为分字段（P2 强制）  │
│  peer_reviews ──┘           ↓                                          │
│                          → stage_results.total / seat_p / seat_e       │
│                          ↓                                            │
│        domain/ranking.rankTeams({ teams: [{ total, ... }] })            │
│                          ↓                                            │
│          ★ total 是破同分链第 1 项（scope=always）                      │
│          → A 榜名次 / 奖金 / 名次积分(10/8/5)                          │
└────────────────────────────────────────────────────────────────────────┘

┌── 通路 B：行为分（★ 与通路 A 完全不相交）──────────────────────────────┐
│  behavior_events（★ P3 专属表，append-only）                            │
│      │ type / evidence / created_at                                    │
│      ↓                                                                  │
│  domain/behavior.behaviorScore({ events, behaviorConfig })              │
│      → { total, items, completed }                                     │
│      ↓                                                                  │
│  ⛔ 不进 total  ⛔ 不进 seatP/seatE  ⛔ 不进名次积分  ⛔ 不进 MVP 总分     │
│      ↓                                                                  │
│  rankTeams 的 tiebreakData.byTeam[teamId].behaviorScore                │
│      ↓                                                                  │
│  ★ 破同分链第 5 项 'behavior'（scope=tied_only，最后一项实质依据）      │
│      → 只在【完全同分】时改变相对顺序                                   │
│      → 行为分达标线 60 → completed=true → 完赛认定（独立于名次）        │
└────────────────────────────────────────────────────────────────────────┘

两路唯一的接触点 = rankTeams 的破同分链第 5 项。
⛔ 通路 B 的任何数值都没有进入通路 A 的任何一个函数调用。
```

**这张图对应的可执行断言（必须出现在测试里）**

- 给同一批队伍加/减行为分，**总分不变**、**A 榜名次不变**（非完全同分时）、**只在完全同分时**改变相对顺序 → `test/behavior.test.js`
- `rankTeams` 的行为分键不是链首、scope 是 `tied_only`、且是最后一项实质依据 → `test/ranking.test.js` → `assertChainInvariants`
- `stage_results` 里**没有任何行为分字段**（表结构层隔离） → `test/leaderboard-migration.test.js`

---

### Task 1: 榜单数据模型与迁移 `004_leaderboard.sql` + `rules/points.json`

**Files:** Create `platform/db/migrations/004_leaderboard.sql`、`platform/rules/points.json`、`platform/rules/criteria.json`、`platform/test/leaderboard-migration.test.js`；Modify `platform/src/config.js`

**Interfaces:**
- Consumes: P0 的 `openDatabase` / `applyMigrations` / `loadRules`；P1 的 `editions` / `task_packages` / `teams` 表；P2 的 `stages` / `stage_results` / `computation_snapshots` 表
- Produces: 表 `points_ledger` / `tier_records` / `behavior_events` / `leaderboard_snapshots`（字段与 INTERFACES.md §4 逐字一致）；表 `milestones` / `milestone_signoffs` / `tiebreak_round` / `tiebreak_votes`（补充，见文末偏差）；`loadRules()` → `rules.points`、`rules.criteria`；`getDefaultRules()` → 从 `platform/rules/` 懒加载并缓存的规则对象（服务层无显式注入时的兜底）

- [ ] **Step 1: 写失败的测试**

`platform/test/leaderboard-migration.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules, validateRules, getDefaultRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p3-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  return { db, close, dataDir };
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);

test('004 迁移建出 4 张榜单表，字段与 INTERFACES.md §4 逐字一致', () => {
  const { db, close, dataDir } = setup();
  assert.deepEqual(cols(db, 'points_ledger'),
    ['id', 'edition_id', 'stage_id', 'team_id', 'user_id', 'kind', 'points', 'created_at']);
  assert.deepEqual(cols(db, 'tier_records'),
    ['id', 'team_id', 'tier', 'milestone_count', 'business_signoff_count', 'reasons_json', 'computed_at', 'deleted_at']);
  assert.deepEqual(cols(db, 'behavior_events'),
    ['id', 'team_id', 'user_id', 'type', 'points', 'evidence', 'created_at']);
  assert.deepEqual(cols(db, 'leaderboard_snapshots'),
    ['id', 'edition_id', 'stage_id', 'scope', 'payload_json', 'created_at']);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ stage_results 里没有任何行为分字段（表结构层隔离）', () => {
  const { db, close, dataDir } = setup();
  const bad = cols(db, 'stage_results').filter((c) => /behavior|bonus|event_points/i.test(c));
  assert.deepEqual(bad, [], `stage_results 出现行为分字段：${bad.join(',')}`);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('points_ledger 与 behavior_events 是追加式：没有 deleted_at / updated_at', () => {
  const { db, close, dataDir } = setup();
  for (const t of ['points_ledger', 'behavior_events']) {
    assert.ok(!cols(db, t).includes('deleted_at'), `${t} 不该有 deleted_at`);
    assert.ok(!cols(db, t).includes('updated_at'), `${t} 不该有 updated_at`);
  }
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('补齐了里程碑 / 签字 / 加时陈述四张补充表，且一人一票由唯一约束保证', () => {
  const { db, close, dataDir } = setup();
  for (const t of ['milestones', 'milestone_signoffs', 'tiebreak_round', 'tiebreak_votes']) {
    assert.ok(cols(db, t).length > 0, `缺表 ${t}`);
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tiebreak_votes'").get().sql;
  assert.ok(sql.includes('PRIMARY KEY (tiebreak_round_id, voter_id, team_id)'));
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('rules/points.json 与 INTERFACES.md §4 一致（10/8/5 · 前 3 名 · MVP 4 赛段 · 1224）', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(rules.points.stagePoints, [10, 8, 5]);
  assert.equal(rules.points.stagePointsOnlyTopN, 3);
  assert.deepEqual(rules.points.mvp, { stagesCounted: 4, roadshowWeight: 1.0, perPackage: 1 });
  assert.deepEqual(rules.points.personal, { lifetime: true, includeMvpVote: true });
  assert.equal(rules.points.tieRankStyle, '1224');
  assert.equal(rules.points.fallbackPolicy.enabled, false, 'R-JDG-21 权重回退默认关闭');
  assert.equal(rules.points.fallbackPolicy.enterpriseWeight, 0.15);
});

test('rules/criteria.json 承载段位附加条件与行为分证据要求', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(rules.criteria.tier.dataOrPrototypeMilestones, ['data_connected', 'demo_ready']);
  assert.ok(rules.criteria.tier.businessDepartmentKeywords.includes('业务'));
  assert.ok(rules.criteria.tier.technicalDepartmentKeywords.includes('技术'));
  assert.equal(rules.criteria.mvp.awardPointsSource, 'stage_points_sum');
  assert.deepEqual(rules.criteria.behaviorEvidence.weekly_progress.required, ['repo', 'version']);
});

test('配置校验会拒绝非法的 points 配置', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.points.stagePointsOnlyTopN = 5;              // 与 stagePoints 长度不一致
  assert.ok(validateRules(bad).some((e) => e.includes('points')));
  const bad2 = structuredClone(rules);
  bad2.points.tieRankStyle = 'dense';
  assert.ok(validateRules(bad2).some((e) => e.includes('tieRankStyle')));
  const bad3 = structuredClone(rules);
  bad3.points.mvp.perPackage = 2;                  // 每个任务包只能 1 个 MVP
  assert.ok(validateRules(bad3).some((e) => e.includes('perPackage')));
});

test('getDefaultRules 能独立读出 rules/ 目录（服务层无注入时的兜底）', () => {
  const r = getDefaultRules();
  assert.deepEqual(r.points.stagePoints, [10, 8, 5]);
  assert.equal(r.tiebreak.chain.at(-1).key, 'team_id');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/leaderboard-migration.test.js`
Expected: FAIL —— `ENOENT: no such file or directory, open '.../db/migrations/004_leaderboard.sql'`（或 `getDefaultRules` 尚未导出）

- [ ] **Step 3: 创建 db/migrations/004_leaderboard.sql**

```sql
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

-- ── 加时陈述（决赛同分才启用）──────────────────────────────────
-- ⛔ tiebreak_round / tiebreak_votes 由 **P2 的 003_review.sql** 建，本迁移【不得重复建表】。
--    重复 CREATE TABLE 会让迁移链在第二个文件直接报错中断（"table tiebreak_round already exists"），
--    后面的 005/006 全部不执行。P3 只【消费】这两张表跑破同分链。
--    表结构见 P2 计划 Task 7；本阶段若需加列，走 expand-contract（P4 迁移加列，不改这两张表）。
```

- [ ] **Step 4: 创建 rules/points.json 与 rules/criteria.json**

`platform/rules/points.json`（INTERFACES.md §4 原文 + 任务书要求的 `fallbackPolicy` 注释位）：

```json
{
  "id": "points",
  "version": "2026-10-20",
  "source": "任务书 §七 + S10 §3.3",
  "stagePoints": [10, 8, 5],
  "stagePointsOnlyTopN": 3,
  "mvp": { "stagesCounted": 4, "roadshowWeight": 1.0, "perPackage": 1 },
  "personal": { "lifetime": true, "includeMvpVote": true },
  "tieRankStyle": "1224",
  "prizeStructure": {
    "resourceToCashRatio": 1.55,
    "source": "R-OPS-12：顶层文档 §3.1 S8「以试点合同/客户资源/现金为主，荣誉类边际效用低；资源:现金 ≈ 1:1.55（CICC 实测）」",
    "note": "资源与现金的相对配比。⚠️ 具体金额未定（首届奖金总额由组委会拍板），此处只存配比与口径，金额由调用方传入 computePrizeShares 的 prizeTable。⛔ 段位权益【不解锁】任何现金（R-PTS-05）。"
  },
  "demoDayAudienceVote": {
    "enabled": false,
    "weight": null,
    "status": "待组委会确认",
    "source": "R-OPS-11：顶层文档 §3.1 S12「线上公开路演 + 企业/投资方在线 + 观众投票权重」",
    "note": "⚠️ 观众票与评审分如何合成，S7 §3.1 的总分公式**没有**这一项 —— 权重取多少、观众票是否进 A 榜、是否只作参考分，目前【无规则依据】。因此本阶段【只占位不启用】：enabled=false 且 weight=null，代码路径存在但恒不生效。启用需要组委会先拍板权重口径，否则就是凭空加一条影响奖金的规则。"
  },
  "fallbackPolicy": {
    "enabled": false,
    "rule": "R-JDG-21",
    "note": "权重回退方案：若首届发现企业给分虚高，企业确认权重回退 15%，差额补给完成度等维度。本阶段【不启用】，仅占位；启用需同时改 rules/scoring-*.json 并重算赛段。",
    "enterpriseWeight": 0.15,
    "redistributeTo": ["completeness"],
    "appliesTo": "scoring.final",
    "status": "首届后回测"
  }
}
```

`platform/rules/criteria.json`（P3 自有，见文末偏差）：

```json
{
  "id": "criteria",
  "version": "2026-10-20",
  "source": "S10 §2.2 段位表附加条件 + R-PTS-03 + R-STG-04 + R-PTS-10 + 任务书 §七（MVP 口径待确认）",
  "tier": {
    "dataOrPrototypeMilestones": ["data_connected", "demo_ready"],
    "businessDepartmentKeywords": ["业务", "商务", "市场", "销售", "运营", "客户", "business", "commercial"],
    "technicalDepartmentKeywords": ["技术", "研发", "工程", "算法", "架构", "tech", "engineering"],
    "unknownDepartmentCountsAsBusiness": false,
    "businessSignoffRequiresContent": true
  },
  "mvp": {
    "awardPointsSource": "stage_points_sum",
    "awardPointsNote": "MVP 积分 = 该队计入的 4 个赛段的名次积分之和。rules/points.json 未规定 mvp 数值，此为待组委会确认口径；改这里即可，不改代码。"
  },
  "behaviorEvidence": {
    "weekly_progress": { "required": ["repo", "version"], "oneOf": ["artifact", "blocker"] },
    "workshop_output": { "required": ["output"], "oneOf": [] },
    "enterprise_meeting": { "required": ["enterpriseConfirmationId"], "oneOf": [] }
  },
  "enterpriseCompliance": {
    "source": "R-JDG-15（S7 §4.1「签字有成本」）：进入 TOP 名单后企业须 2 周内召开 30 分钟需求对接会，不配合则下届降权/取消席位",
    "meetingDurationMinutes": 30,
    "deadlineDays": 14,
    "appliesTo": "top_list",
    "penaltyScope": "next_edition",
    "penaltyNote": "⚠️ 处罚只作用于【下届席位权重/取消席位】，不影响本届名次与奖金。因此本平台【只负责记录与暴露】：对接会是否完成、何时完成。⛔ 不得据此在本届直接扣分或改榜 —— 那会凭空加一条源文档没有的规则。下届降权的执行不在本平台范围内（无届期间的席位权重数据模型）。",
    "evidenceFields": ["enterpriseId", "teamId", "meetingAt", "durationMinutes", "attendees"]
  }
}
```

- [ ] **Step 5: 修改 src/config.js（载入 + 校验 + 兜底加载）**

`FILES` 追加 `points: 'points.json'`、`criteria: 'criteria.json'`；`grouped` 追加 `points: rules.points`、`criteria: rules.criteria`；顶部补 `import { fileURLToPath } from 'node:url';` 与 `import { dirname } from 'node:path';`；`validateRules` 末尾（`return errors` 之前）追加：

```javascript
  // ── 名次积分（P3）────────────────────────────────────────
  const pts = rules.points;
  if (!pts) {
    errors.push('points 缺失');
  } else {
    if (!Array.isArray(pts.stagePoints) || !pts.stagePoints.length) {
      errors.push('points.stagePoints 缺失或为空');
    } else if (Number.isFinite(pts.stagePointsOnlyTopN)
      && pts.stagePointsOnlyTopN !== pts.stagePoints.length) {
      errors.push(`points.stagePointsOnlyTopN=${pts.stagePointsOnlyTopN} 与 stagePoints 长度 ${pts.stagePoints.length} 不一致`);
    }
    if (pts.tieRankStyle !== '1224') errors.push(`points.tieRankStyle 必须是 "1224"（当前 ${pts.tieRankStyle}）`);
    if (!pts.mvp || pts.mvp.perPackage !== 1) errors.push('points.mvp.perPackage 必须是 1（每个任务包 1 个 MVP，任务书 §七）');
    if (!pts.personal || typeof pts.personal.lifetime !== 'boolean') errors.push('points.personal.lifetime 必须是布尔值');
  }

  // ── 段位附加条件（P3）────────────────────────────────────
  const crit = rules.criteria;
  if (!crit?.tier) {
    errors.push('criteria.tier 缺失');
  } else {
    if (!Array.isArray(crit.tier.dataOrPrototypeMilestones) || !crit.tier.dataOrPrototypeMilestones.length) {
      errors.push('criteria.tier.dataOrPrototypeMilestones 缺失或为空');
    }
    if (!Array.isArray(crit.tier.businessDepartmentKeywords) || !crit.tier.businessDepartmentKeywords.length) {
      errors.push('criteria.tier.businessDepartmentKeywords 缺失或为空');
    }
  }
```

文件末尾追加兜底加载器：

```javascript
// ── P3 追加：默认规则加载器 ────────────────────────────────────
// 用途：服务层在调用方没有显式注入 rules 时用它，避免"静默用默认规则"的降级。
// ⚠️ 只在没有注入时兜底；注入的 rules 优先（配置文件里的值永远是权威）。
let defaultRulesCache = null;

export function getDefaultRules() {
  if (!defaultRulesCache) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
    defaultRulesCache = loadRules(dir).rules;
  }
  return defaultRulesCache;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/leaderboard-migration.test.js` → Expected: PASS（8 个测试全过）
Run: `cd platform && node --test test/` → Expected: 全部通过（P0 的 `config.test.js` 仍通过——新增规则文件不影响既有断言）

- [ ] **Step 7: 提交**

```bash
cd platform && git add db/migrations/004_leaderboard.sql rules/points.json rules/criteria.json src/config.js test/leaderboard-migration.test.js
git commit -m "feat(P3): 榜单数据模型 004 迁移与名次积分规则配置"
```

---

### Task 2: 破同分链执行器 + 1224 并列名次

**Files:** Create `platform/src/domain/util.js`、`platform/src/domain/ranking.js`、`platform/test/ranking.test.js`

**Interfaces:**
- Consumes: `rules.tiebreak.chain`（P0 已定稿，**只读不写**）、`rules.points.tieRankStyle`
- Produces: `assertChainInvariants(chain, { behaviorConfig }?)` → `string[]`（空 = 通过）；`applyTiebreakChain({ candidates, chain, data })` → `{ ordered, applied, groups, warnings }`；`rankTeams({ teams, tiebreakChain, tiebreakData, pointsConfig })` → `{ ordered, tieGroups, rankStyle, applied, warnings }`；`data.isFinal` → boolean（决定 `final_only` 是否启用，服务层按 `stages.scoring_config_key === 'final'` 传入）

- [ ] **Step 1: 写失败的测试**

`platform/test/ranking.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { rankTeams, applyTiebreakChain, assertChainInvariants } from '../src/domain/ranking.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const CHAIN = rules.tiebreak.chain;
const teamsOf = (rows) => rows.map((r) => ({ teamId: r.teamId, total: r.total, ...r.extra }));
const rank = (teams, isFinal = false) => rankTeams({
  teams, tiebreakChain: CHAIN, tiebreakData: { isFinal }, pointsConfig: rules.points,
});

test('rules/tiebreak.json 的破同分链仍是裁决后的 6 级有序链（不得被 P3 改动）', () => {
  assert.deepEqual(CHAIN.map((c) => c.key),
    ['total', 'tiebreak_extra', 'peer', 'enterprise_raw', 'behavior', 'team_id']);
  assert.deepEqual(CHAIN.map((c) => c.scope),
    ['always', 'final_only', 'tied_only', 'tied_only', 'tied_only', 'always']);
  assert.equal(CHAIN.at(-1).deterministic, true, '最后一级必须是确定性兜底');
});

test('不同总分 → 按总分降序，名次 1/2/3', () => {
  const r = rank(teamsOf([{ teamId: 't_c', total: 70 }, { teamId: 't_a', total: 90 }, { teamId: 't_b', total: 80 }]));
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_a', 't_b', 't_c']);
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 2, 3]);
  assert.equal(r.rankStyle, '1224');
});

test('★ 1224 式并列名次：1,1,3（不是 1,1,2）', () => {
  // ⚠️ 真正的并列要求两队在【所有实质破同分键】上都相等（总分、互评、企业原始分、行为分）。
  //    只让总分相等是不够的——互评分不等就会在链的第 3 级被分开，名次变成 1,2（那是正确的）。
  const r = rank(teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_b', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_c', total: 80, extra: { peerScore: 9 } },
  ]));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1, 3]);
  assert.deepEqual(r.ordered[0].tiedWith, ['t_b']);
  assert.deepEqual(r.ordered[2].tiedWith, []);
  assert.deepEqual(r.tieGroups, [['t_a', 't_b'], ['t_c']]);
});

test('总分相等但互评分不等 → 在链的第 3 级被分开，名次是 1,2（不是并列）', () => {
  const r = rank(teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_b', total: 90, extra: { peerScore: 3 } },
    { teamId: 't_c', total: 80, extra: { peerScore: 9 } },
  ]));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 2, 3]);
  assert.deepEqual(r.ordered[0].tiedWith, []);
});

test('★ 全同分时落到队伍编号兜底，结果稳定可复算', () => {
  const teams = teamsOf([{ teamId: 't_z', total: 100 }, { teamId: 't_a', total: 100 }, { teamId: 't_m', total: 100 }]);
  const a = rank(teams);
  const b = rank(teams);
  assert.deepEqual(a.ordered.map((o) => o.teamId), ['t_a', 't_m', 't_z']);
  assert.deepEqual(a.ordered.map((o) => o.teamId), b.ordered.map((o) => o.teamId));
  assert.deepEqual(a.ordered.map((o) => o.rank), [1, 1, 1], '兜底只决定组内顺序，不拆名次');
});

test('破同分链优先级：加时陈述 > 互评 > 企业原始分 > 行为分', () => {
  const r = rank(teamsOf([
    { teamId: 't_peer', total: 80, extra: { peerScore: 9, enterpriseRaw: 1, behaviorScore: 0, tiebreakExtra: 0 } },
    { teamId: 't_ent', total: 80, extra: { peerScore: 1, enterpriseRaw: 9, behaviorScore: 0, tiebreakExtra: 0 } },
    { teamId: 't_beh', total: 80, extra: { peerScore: 1, enterpriseRaw: 1, behaviorScore: 9, tiebreakExtra: 0 } },
    { teamId: 't_final', total: 80, extra: { peerScore: 1, enterpriseRaw: 1, behaviorScore: 1, tiebreakExtra: 9 } },
  ]), true);
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_final', 't_peer', 't_ent', 't_beh']);
});

test('final_only：非决赛时加时陈述复议分不参与', () => {
  const teams = teamsOf([
    { teamId: 't_a', total: 80, extra: { peerScore: 1, enterpriseRaw: 1, behaviorScore: 1, tiebreakExtra: 99 } },
    { teamId: 't_b', total: 80, extra: { peerScore: 9, enterpriseRaw: 1, behaviorScore: 1, tiebreakExtra: 0 } },
  ]);
  assert.deepEqual(rank(teams, false).ordered.map((o) => o.teamId), ['t_b', 't_a']);
  assert.deepEqual(rank(teams, true).ordered.map((o) => o.teamId), ['t_a', 't_b']);
});

test('组内缺可比较的值时该键不可用（不静默当 0），并给出 warning', () => {
  const r = rank(teamsOf([
    { teamId: 't_a', total: 80, extra: { peerScore: 9 } },
    { teamId: 't_b', total: 80, extra: {} },
  ]));
  assert.ok(r.warnings.some((w) => w.code === 'tiebreak_key_unusable'));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1], '互评分不可用 → 仍并列');
});

test('★ 破同分链不变量：行为分不得排链首 / 必须 tied_only / 必须是最后一项实质依据', () => {
  assert.deepEqual(assertChainInvariants(CHAIN), []);
  const headFirst = [CHAIN[4], ...CHAIN.filter((_, i) => i !== 4)];
  assert.ok(assertChainInvariants(headFirst).some((e) => e.includes('链首')));
  const wrongScope = CHAIN.map((c) => (c.key === 'behavior' ? { ...c, scope: 'always' } : c));
  assert.ok(assertChainInvariants(wrongScope).some((e) => e.includes('tied_only')));
  const notLast = CHAIN.filter((c) => c.key !== 'team_id');
  assert.ok(assertChainInvariants(notLast).some((e) => e.includes('确定性兜底')));
});

test('applyTiebreakChain 返回 applied 轨迹（哪一档被用到）', () => {
  const { applied } = applyTiebreakChain({
    candidates: teamsOf([
      { teamId: 't_a', total: 80, extra: { peerScore: 9 } },
      { teamId: 't_b', total: 80, extra: { peerScore: 1 } },
    ]),
    chain: CHAIN, data: { isFinal: false },
  });
  const peer = applied.find((a) => a.key === 'peer');
  assert.ok(peer, '互评分应被用到');
  assert.equal(peer.separated, true);
  assert.deepEqual(peer.usedBy.sort(), ['t_a', 't_b']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/ranking.test.js` → Expected: FAIL —— `Cannot find module '../src/domain/ranking.js'`

- [ ] **Step 3: 创建 src/domain/util.js**

```javascript
// src/domain/util.js — 领域层通用纯函数（依据 INTERFACES.md §0「领域层是纯函数」）

/** 字符串比较：不用 localeCompare，保证不同机器/语言环境下结果一致（可复算要求） */
export function cmpStr(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** 安全取数：非有限数按 null（缺值）处理，不静默当 0 */
export function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 取对象的一部分字段，返回新对象（不改原对象） */
export function pick(obj, keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (keys.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: 创建 src/domain/ranking.js**

```javascript
// src/domain/ranking.js — 名次计算与破同分链（纯函数）
// 依据：设计文档 §6.4 + 冲突裁决 C-03 + R-RNK-06 + R-PTS-08
//   ⛔ 本模块【绝不】把行为分并进总分：行为分只以破同分链的 'behavior' 键出现，
//      且 scope 必须是 tied_only（链的最后一项实质依据）——见 assertChainInvariants()。
//      依据 S10 §3.3「行为分只做垫底排序：同分时的第一排序依据 ❌、最后排序依据 ✅」。
//   ✅ 借鉴 HackSC/hibiscus `libs/calculateRankings.ts`（MIT）的 1224 并列名次算法，
//      本实现独立编写；上游 `calculatePoints.ts` 的 switch 穿透 bug 不在此处（见 points.js）。
//   ✅ 破同分最后一级用【队伍编号（行 ID）】而不是时间戳：借 CTFd
//      `utils/scores/__init__.py` 的 `ORDER BY score DESC, date ASC, id ASC` 双保险，
//      官方注释理由是【不同数据库的时间精度不同】，只用时间字段排序不稳。
import { cmpStr, toNumber } from './util.js';

// 破同分链的键 → 候选队伍上的字段名（INTERFACES.md §4 的 teams 字段名）
const KEY_FIELD = {
  total: 'total', tiebreak_extra: 'tiebreakExtra', peer: 'peerScore',
  enterprise_raw: 'enterpriseRaw', behavior: 'behaviorScore', team_id: 'teamId',
};
const fieldOf = (key) => KEY_FIELD[key] || key;

function readValue(candidate, key, data) {
  const bucket = (data?.byTeam || {})[candidate.teamId];
  if (bucket) {
    if (bucket[key] !== undefined && bucket[key] !== null) return bucket[key];
    const f = fieldOf(key);
    if (bucket[f] !== undefined && bucket[f] !== null) return bucket[f];
  }
  const f = fieldOf(key);
  if (candidate[f] !== undefined && candidate[f] !== null) return candidate[f];
  if (candidate[key] !== undefined && candidate[key] !== null) return candidate[key];
  return null;
}

function compareValues(a, b, direction) {
  if (a === b) return 0;
  const dir = direction === 'asc' ? 1 : -1;
  if (typeof a === 'string' || typeof b === 'string') return cmpStr(a, b) * dir;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na === null || nb === null) return 0;
  return (na - nb) * dir;
}

/** 破同分链不变量校验（C-03 链 + R-PTS-08）。返回错误数组，空 = 通过。 */
export function assertChainInvariants(chain, { behaviorConfig } = {}) {
  const errors = [];
  if (!Array.isArray(chain) || !chain.length) return ['破同分链缺失或为空'];
  if (!chain[chain.length - 1]?.deterministic) {
    errors.push('破同分链必须以确定性兜底项结尾（deterministic: true），否则榜单不可复算（R-AUD-01）');
  }
  if (!chain.some((c) => c.key === 'total')) errors.push('破同分链缺少总分项');
  const bi = chain.findIndex((c) => c.key === 'behavior');
  if (bi >= 0) {
    if (chain[bi].scope !== 'tied_only') errors.push(`破同分项 'behavior' 的 scope 必须是 tied_only（当前 ${chain[bi].scope}）——R-PTS-08`);
    if (bi === 0) errors.push("破同分项 'behavior' 不得排在链首（R-PTS-08：同分时的第一排序依据不可用）");
    if (bi !== chain.length - 2) errors.push("破同分项 'behavior' 必须是最后一项实质依据（其后只能是确定性兜底项）");
    if (behaviorConfig?.sortUse && behaviorConfig.sortUse !== 'tiebreak_only') {
      errors.push(`行为分 sortUse 必须是 tiebreak_only（当前 ${behaviorConfig.sortUse}）`);
    }
  }
  return errors;
}

/**
 * 按链顺序逐项细分并列组。
 * - scope=always     ：对每个并列组都生效
 * - scope=tied_only  ：只对尚未分开的并列组生效
 * - scope=final_only ：只在决赛（data.isFinal=true）生效
 * - deterministic    ：只决定组内展示顺序，【不】拆组（并列名次不变）
 * 缺可比较值时该键在本组【不可用】并给 warning——绝不静默当 0 分。
 */
export function applyTiebreakChain({ candidates, chain, data }) {
  const errors = assertChainInvariants(chain);
  if (errors.length) throw new Error(`破同分链配置非法，拒绝计算：${errors.join('；')}`);

  const list = Array.isArray(candidates) ? [...candidates] : [];
  const isFinal = Boolean(data?.isFinal);
  const warnings = [];
  const applied = [];
  let groups = list.length ? [list] : [];

  for (const item of chain) {
    const scopeActive = (item.scope || 'always') !== 'final_only' || isFinal;
    const next = [];
    const usedBy = [];
    let separated = false;

    for (const group of groups) {
      if (group.length < 2 || !scopeActive) { next.push(group); continue; }
      const missing = group.filter((c) => readValue(c, item.key, data) === null);
      if (missing.length) {
        warnings.push({
          code: 'tiebreak_key_unusable',
          message: `破同分键「${item.label || item.key}」在本组缺少可比较的值，本组不使用该键`,
          teamIds: missing.map((c) => c.teamId),
        });
        next.push(group);
        continue;
      }
      if (item.deterministic) {
        // 确定性兜底：只决定组内顺序，【不】拆组（并列名次不变）
        next.push([...group].sort((a, b) => compareValues(
          readValue(a, item.key, data), readValue(b, item.key, data), item.direction,
        )));
        usedBy.push(...group.map((c) => c.teamId));
        continue;
      }
      const buckets = new Map();
      for (const c of group) {
        const k = String(readValue(c, item.key, data));
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(c);
      }
      const parts = [...buckets.values()];
      if (parts.length > 1) {
        parts.sort((a, b) => compareValues(
          readValue(a[0], item.key, data), readValue(b[0], item.key, data), item.direction,
        ));
        separated = true;
        usedBy.push(...group.map((c) => c.teamId));
        next.push(...parts);
      } else {
        next.push(group);
      }
    }
    groups = next;
    if (usedBy.length) applied.push({ key: item.key, label: item.label || item.key, usedBy, separated });
  }
  return { ordered: groups.flat(), applied, groups, warnings };
}

/** A 榜名次（1224 式并列）。teams: [{ teamId, total, seatP, seatE, peerScore, enterpriseRaw, behaviorScore }] */
export function rankTeams({ teams, tiebreakChain, tiebreakData, pointsConfig }) {
  const { ordered, applied, groups, warnings } = applyTiebreakChain({
    candidates: (Array.isArray(teams) ? teams : []).map((t) => ({ ...t })),
    chain: tiebreakChain || [],
    data: tiebreakData || {},
  });
  const out = [];
  let before = 0;
  for (const group of groups) {
    const rank = before + 1;              // 1224 式：名次 = 本组之前的队伍数 + 1（并列占位，名次跳号）
    const ids = group.map((c) => c.teamId);
    for (const c of group) {
      out.push({
        teamId: c.teamId,
        rank,
        total: c.total ?? null,
        tiedWith: ids.filter((x) => x !== c.teamId),
      });
    }
    before += group.length;
  }
  return {
    ordered: out,
    tieGroups: groups.map((g) => g.map((c) => c.teamId)),
    rankStyle: pointsConfig?.tieRankStyle || '1224',
    applied,
    warnings,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/ranking.test.js` → Expected: PASS（11 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/domain/util.js src/domain/ranking.js test/ranking.test.js
git commit -m "feat(P3): 破同分链执行器与 1224 并列名次"
```

---

### Task 3: 名次积分 + MVP + 个人积分

**Files:** Create `platform/src/domain/points.js`、`platform/test/points.test.js`

**Interfaces:**
- Consumes: `rules.points`（Task 1）、`rules.criteria.mvp`（MVP 积分口径）
- Produces: `stagePointsFor(rank, pointsConfig)` → `10 / 8 / 5 / 0`；`computeStagePoints({ ordered, pointsConfig })` → `[{ teamId, rank, position, points }]`；`computeMvp({ stagePoints, roadshowScores, packageId, pointsConfig })` → `{ packageId, mvp, mvpList, ranked, stagesCounted, roadshowWeight }`；`computePersonalPoints({ ledger, pointsConfig })` → `{ lifetime, includeMvpVote, rows, excludedEntries }`；`computePrizeShares({ ordered, prizeTable })` → `{ shares, totalPool, groups }`（**本阶段新增**，R-JDG-20 奖金共享总额不变）

- [ ] **Step 1: 写失败的测试**

`platform/test/points.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { stagePointsFor, computeStagePoints, computeMvp, computePersonalPoints, computePrizeShares } from '../src/domain/points.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const P = rules.points;

test('★ 回归测试：名次积分必须写死 10/8/5', () => {
  // ⚠️ 上游 HackSC/hibiscus `calculatePoints.ts`（MIT）的 switch 没有 break，
  //    穿透后实际发的是 18/8/3/1（上游自己写的目标值是 10/5/2/1）。
  //    相对顺序不变，但数值全错——不写死这个断言，bug 会被一起搬进来。
  //    我们的口径来自 任务书 §七 + R-STG-02：第一/二/三名 = 10/8/5。
  assert.equal(stagePointsFor(1, P), 10);
  assert.equal(stagePointsFor(2, P), 8);
  assert.equal(stagePointsFor(3, P), 5);
  assert.equal(stagePointsFor(4, P), 0);
  assert.equal(stagePointsFor(0, P), 0);
  assert.equal(stagePointsFor(-1, P), 0);
  assert.equal(stagePointsFor(99, P), 0);
  assert.notEqual(stagePointsFor(1, P), 18);   // 上游 bug 的具体形态
  assert.notEqual(stagePointsFor(2, P), 5);
  assert.notEqual(stagePointsFor(3, P), 2);
});

test('只给前 3 名计分（stagePointsOnlyTopN = 3）', () => {
  const pts = computeStagePoints({
    ordered: [{ teamId: 't1', rank: 1 }, { teamId: 't2', rank: 2 }, { teamId: 't3', rank: 3 }, { teamId: 't4', rank: 4 }],
    pointsConfig: P,
  });
  assert.deepEqual(pts.map((p) => p.points), [10, 8, 5, 0]);
  assert.deepEqual(pts.map((p) => p.position), [1, 2, 3, 4]);
});

test('★ 并列时按位置分配积分（1224 名次下的确定性口径）', () => {
  // 名次是 1,1,3（并列第一占了两席），但积分按位置发放，总额恒为 10+8+5=23。
  const pts = computeStagePoints({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 1 }, { teamId: 't_c', rank: 3 }],
    pointsConfig: P,
  });
  assert.deepEqual(pts.map((p) => p.points), [10, 8, 5]);
  assert.equal(pts.reduce((s, p) => s + p.points, 0), 23);
});

test('computeMvp：4 赛段总积分 + S4 路演评审综合，每任务包 1 个', () => {
  const stagePoints = [
    { teamId: 't_a', stageId: 'S1', points: 10 }, { teamId: 't_a', stageId: 'S2', points: 8 },
    { teamId: 't_a', stageId: 'S3', points: 5 }, { teamId: 't_a', stageId: 'S4', points: 8 },
    { teamId: 't_b', stageId: 'S1', points: 5 }, { teamId: 't_b', stageId: 'S2', points: 10 },
    { teamId: 't_b', stageId: 'S3', points: 0 }, { teamId: 't_b', stageId: 'S4', points: 10 },
  ];
  const out = computeMvp({
    stagePoints, roadshowScores: [{ teamId: 't_a', score: 70 }, { teamId: 't_b', score: 90 }],
    packageId: 'tp_1', pointsConfig: P,
  });
  assert.equal(out.packageId, 'tp_1');
  assert.equal(out.mvpList.length, 1, '每个任务包 1 个 MVP');
  // t_a 赛段积分 31 + 路演第 2 名积分 8（roadshowWeight=1）= 39；t_b 25 + 10 = 35
  assert.equal(out.mvp.teamId, 't_a');
  assert.equal(out.mvp.stageTotal, 31);
  assert.equal(out.mvp.roadshowContribution, 8);
  assert.equal(out.mvp.score, 39);
  assert.equal(out.ranked[1].teamId, 't_b');
  assert.equal(out.ranked[1].score, 35);
});

test('computeMvp：同分时结果确定且可复算（队伍编号兜底）；只取前 4 个赛段', () => {
  const stagePoints = [{ teamId: 't_z', stageId: 'S1', points: 10 }, { teamId: 't_a', stageId: 'S1', points: 10 }];
  const roadshowScores = [{ teamId: 't_z', score: 50 }, { teamId: 't_a', score: 50 }];
  const a = computeMvp({ stagePoints, roadshowScores, packageId: 'tp_1', pointsConfig: P });
  const b = computeMvp({ stagePoints, roadshowScores, packageId: 'tp_1', pointsConfig: P });
  assert.equal(a.mvp.teamId, 't_a');
  assert.equal(a.mvp.teamId, b.mvp.teamId);

  const five = ['S1', 'S2', 'S3', 'S4', 'S5'].map((s) => ({ teamId: 't_a', stageId: s, points: 10 }));
  const out = computeMvp({ stagePoints: five, roadshowScores: [], packageId: 'tp_1', pointsConfig: P });
  assert.equal(out.stagesCounted, 4);
  assert.equal(out.mvp.stageTotal, 40, 'S5 不计入（只取前 4 个赛段）');
});

test('★ computePersonalPoints：终生上榜 + MVP 投决积分可开关 + 1224 并列', () => {
  const ledger = [
    { id: 'l1', userId: 'u_1', kind: 'stage_rank', points: 10 },
    { id: 'l2', userId: 'u_1', kind: 'mvp', points: 31 },
    { id: 'l3', userId: 'u_2', kind: 'stage_rank', points: 8 },
    { id: 'l4', userId: 'u_3', kind: 'personal_rollup', points: 99 },   // 派生快照，不重复累加
    { id: 'l5', userId: 'u_4', kind: 'stage_rank', points: 10 },
    { id: 'l6', userId: 'u_5', kind: 'stage_rank', points: 5 },
  ];
  const on = computePersonalPoints({ ledger, pointsConfig: P });
  assert.equal(on.lifetime, true);
  assert.equal(on.includeMvpVote, true);
  assert.equal(on.rows[0].userId, 'u_1');
  assert.equal(on.rows[0].total, 41, '赛段积分 + MVP 投决积分');
  assert.equal(on.rows[0].byKind.stage_rank, 10);
  assert.equal(on.rows[0].byKind.mvp, 31);
  assert.ok(!on.rows.some((r) => r.userId === 'u_3'), 'personal_rollup 不参与累加');
  assert.deepEqual(on.rows.map((r) => r.rank), [1, 2, 1, 3], '同分并列 → 1224');

  const off = computePersonalPoints({
    ledger, pointsConfig: { ...P, personal: { lifetime: true, includeMvpVote: false } },
  });
  assert.equal(off.rows[0].total, 10, '关闭 MVP 投决积分后只剩赛段积分');
});

test('★ R-JDG-20：并列共享奖金，总额不变', () => {
  const prizeTable = { 1: 10000, 2: 5000, 3: 2000 };
  const tied = computePrizeShares({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 1 }, { teamId: 't_c', rank: 3 }],
    prizeTable,
  });
  const solo = computePrizeShares({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 2 }, { teamId: 't_c', rank: 3 }],
    prizeTable,
  });
  assert.equal(tied.totalPool, solo.totalPool, '总额不变');
  assert.equal(tied.totalPool, 17000);
  assert.equal(tied.shares.find((s) => s.teamId === 't_a').share, 7500);
  assert.equal(tied.shares.find((s) => s.teamId === 't_b').share, 7500);
  assert.equal(tied.shares.find((s) => s.teamId === 't_c').share, 2000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/points.test.js` → Expected: FAIL —— `Cannot find module '../src/domain/points.js'`

- [ ] **Step 3: 创建 src/domain/points.js**

```javascript
// src/domain/points.js — 名次积分 / MVP / 个人积分（纯函数）
// 依据：任务书 §七 + 设计文档 §6.3 + R-STG-02（10/8/5）+ R-RNK-09（MVP）+ R-RNK-10（终生上榜）
//
// ⚠️ 上游借鉴记录：HackSC/hibiscus `calculatePoints.ts`（MIT）的 switch【无 break 穿透】，
//    实际发的是 18/8/3/1（上游自己写的目标值是 10/5/2/1）——相对顺序不变但数值全错。
//    本实现不复用其代码，口径以 任务书 §七（第一/二/三名 = 10/8/5）为准，
//    并由 test/points.test.js 写死断言，防止把上游 bug 一起搬进来。
//
// ⛔ 本模块【不】产生任何影响段位或行为分的数值；行为分不在这里出现。
import { cmpStr } from './util.js';

/** 赛段名次积分：第 1/2/3 名 = 10/8/5，其余 0（任务书 §七 + R-STG-02，已定）。 */
export function stagePointsFor(rank, pointsConfig) {
  const table = Array.isArray(pointsConfig?.stagePoints) ? pointsConfig.stagePoints : [];
  const topN = Number.isFinite(pointsConfig?.stagePointsOnlyTopN) ? pointsConfig.stagePointsOnlyTopN : table.length;
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1) return 0;
  if (r > topN) return 0;
  return typeof table[r - 1] === 'number' ? table[r - 1] : 0;
}

/**
 * 按【位置】发放名次积分。
 * 依据：设计文档 §6.3「任务包内全量战队排名，第一/二/三名 = 10/8/5」。
 * ⚠️ 并列（1224 名次）时按位置发放：并列第一的两队占第 1、2 席 → 10 与 8。
 *    这样任一赛段的积分总额恒为 10+8+5=23，MVP 跨赛段比较才是同一把尺子。
 *    位置由破同分链末级的队伍编号兜底稳定排序 → 可复算。
 */
export function computeStagePoints({ ordered, pointsConfig }) {
  const rows = Array.isArray(ordered) ? ordered : [];
  return rows.map((row, i) => ({
    teamId: row.teamId,
    rank: row.rank ?? null,
    position: i + 1,
    points: stagePointsFor(i + 1, pointsConfig),
  }));
}

/**
 * MVP：4 赛段总积分 + S4 路演评审综合，每个任务包 1 个（任务书 §七 + 设计文档 §6.3 + R-RNK-09）。
 * - stagePoints: [{ teamId, stageId?, points }]，带 stageId 时只取前 stagesCounted 个赛段
 * - roadshowScores: [{ teamId, score }]，S4 路演评审综合分（0–100）
 * 路演综合分先折算成【路演名次积分】（与赛段名次同一 10/8/5 口径），再乘 roadshowWeight
 * 计入总分 —— 两部分量纲一致，不需要另造一套权重。
 */
export function computeMvp({ stagePoints, roadshowScores, packageId, pointsConfig }) {
  const mvpCfg = pointsConfig?.mvp || {};
  const stagesCounted = Number.isFinite(mvpCfg.stagesCounted) ? mvpCfg.stagesCounted : 4;
  const roadshowWeight = Number.isFinite(mvpCfg.roadshowWeight) ? mvpCfg.roadshowWeight : 1;
  const perPackage = Number.isFinite(mvpCfg.perPackage) ? mvpCfg.perPackage : 1;

  // ① 赛段积分聚合（只取前 stagesCounted 个赛段；赛段键按字典序，S1..S4 顺序稳定）
  const stageTotals = new Map();
  const entries = Array.isArray(stagePoints) ? stagePoints : [];
  const withStage = entries.filter((e) => e && e.stageId !== undefined && e.stageId !== null);
  if (withStage.length) {
    const stageIds = [...new Set(withStage.map((e) => String(e.stageId)))].sort();
    const counted = new Set(stageIds.slice(0, stagesCounted));
    for (const e of withStage) {
      if (!counted.has(String(e.stageId))) continue;
      stageTotals.set(e.teamId, (stageTotals.get(e.teamId) || 0) + (Number(e.points) || 0));
    }
  } else {
    for (const e of entries) {
      if (!e) continue;
      stageTotals.set(e.teamId, (stageTotals.get(e.teamId) || 0) + (Number(e.points) || 0));
    }
  }

  // ② S4 路演评审综合 → 路演名次 → 路演积分（同 10/8/5 口径）
  const roadRanked = (Array.isArray(roadshowScores) ? roadshowScores : [])
    .filter((r) => r && r.teamId)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || cmpStr(a.teamId, b.teamId));
  const roadPoints = new Map();
  roadRanked.forEach((r, i) => { roadPoints.set(r.teamId, stagePointsFor(i + 1, pointsConfig)); });

  // ③ 综合分 = 4 赛段总积分 + roadshowWeight × 路演积分
  const teamIds = new Set([...stageTotals.keys(), ...roadPoints.keys()]);
  const ranked = [...teamIds].map((teamId) => {
    const stageTotal = stageTotals.get(teamId) || 0;
    const road = roadPoints.get(teamId) || 0;
    return {
      teamId,
      stageTotal,
      roadshowPoints: road,
      roadshowContribution: roadshowWeight * road,
      score: stageTotal + roadshowWeight * road,
    };
  }).sort((a, b) => b.score - a.score || cmpStr(a.teamId, b.teamId));

  const winners = ranked.slice(0, Math.max(1, perPackage));
  return {
    packageId: packageId ?? null,
    stagesCounted,
    roadshowWeight,
    mvp: winners[0] ?? null,
    mvpList: winners,
    ranked,
  };
}

/**
 * 个人积分：赛段积分 + MVP 投决积分，终生上榜（任务书 §七 + R-RNK-10 + rules.points.personal）。
 * ⛔ kind='personal_rollup' 是派生快照，不参与累加（否则重复计分）。
 */
export function computePersonalPoints({ ledger, pointsConfig }) {
  const personalCfg = pointsConfig?.personal || {};
  const lifetime = personalCfg.lifetime !== false;
  const includeMvpVote = personalCfg.includeMvpVote !== false;

  const totals = new Map();
  const kinds = new Map();
  let excluded = 0;
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry || !entry.userId) continue;
    const kind = entry.kind || 'unknown';
    if (kind === 'personal_rollup') { excluded += 1; continue; }
    if (kind === 'mvp' && !includeMvpVote) { excluded += 1; continue; }
    const pts = Number(entry.points) || 0;
    totals.set(entry.userId, (totals.get(entry.userId) || 0) + pts);
    if (!kinds.has(entry.userId)) kinds.set(entry.userId, {});
    const km = kinds.get(entry.userId);
    km[kind] = (km[kind] || 0) + pts;
  }

  const rows = [...totals.entries()]
    .map(([userId, total]) => ({ userId, total, byKind: kinds.get(userId) || {} }))
    .sort((a, b) => b.total - a.total || cmpStr(a.userId, b.userId));

  let before = 0;
  let prev = null;
  for (const r of rows) {
    if (prev === null || r.total !== prev) {
      r.rank = before + 1;      // 1224 式并列名次
      prev = r.total;
    }
    before += 1;
  }
  return { lifetime, includeMvpVote, rows, excludedEntries: excluded };
}

/**
 * 奖金分配（并列共享总额不变）。
 * 依据：R-JDG-20「同分即并列，共享该名次奖金（总额不变）」+ C-03 的 1224 名次。
 * ⚠️ 本函数是本阶段【新增】的（INTERFACES.md 未列）："总额不变"需要一条可执行算法，
 *    否则并列时奖金会被重复发放或漏发。
 *    语义：并列组占据名次区间 [k, k+n-1]，该区间的奖金总额由组内平分；名次 k+n 及之后
 *    的队伍按自己的名次领奖 —— 于是发放总额与无并列时一致。
 */
export function computePrizeShares({ ordered, prizeTable }) {
  const table = prizeTable || {};
  const groups = [];
  let cur = null;
  for (const row of Array.isArray(ordered) ? ordered : []) {
    if (!cur || cur.rank !== row.rank) {
      cur = { rank: row.rank, teamIds: [] };
      groups.push(cur);
    }
    cur.teamIds.push(row.teamId);
  }

  const shares = [];
  let consumed = 0;
  let totalPool = 0;
  for (const g of groups) {
    const slots = g.teamIds.map((_, i) => consumed + i + 1);
    const pool = slots.reduce((s, r) => s + (Number(table[r]) || 0), 0);
    totalPool += pool;
    const share = g.teamIds.length ? pool / g.teamIds.length : 0;
    for (const t of g.teamIds) shares.push({ teamId: t, rank: g.rank, share, pool, slots: slots.slice() });
    consumed += g.teamIds.length;
  }
  return {
    shares,
    totalPool,
    groups: groups.map((g) => ({ rank: g.rank, teamIds: g.teamIds })),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/points.test.js` → Expected: PASS（8 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/points.js test/points.test.js
git commit -m "feat(P3): 名次积分 10/8/5、MVP 与个人积分"
```

---

### Task 4: 段位计算与降级

**Files:** Create `platform/src/domain/tier.js`、`platform/test/tier.test.js`

**Interfaces:**
- Consumes: `rules.ranks`（P0 已定稿：**只读不写**）、`rules.criteria.tier`
- Produces: `computeTier({ milestones, signoffs, ranksConfig })` → `{ tier, tierName, milestoneCount, businessSignoffCount, reasons, benefits, neverUnlocks }`；`applyTierDemotion({ tier, daysSinceLastActivity, revokedSignoffs, ranksConfig })` → `{ tier, demoted, reason, publish, from }`；`classifyDepartment(department, criteriaConfig)` → `'business' | 'technical' | 'unknown'`；`isDataOrPrototypeMilestone(key, criteriaConfig)` → `boolean`

- [ ] **Step 1: 写失败的测试**

`platform/test/tier.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { computeTier, applyTierDemotion, classifyDepartment, isDataOrPrototypeMilestone } from '../src/domain/tier.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const R = rules.ranks;
const C = rules.criteria;

const MS = {
  problem_confirmed: { key: 'problem_confirmed', countsTowardTier: true, achieved: true },
  data_connected: { key: 'data_connected', countsTowardTier: true, achieved: true, isDataOrPrototype: true },
  demo_ready: { key: 'demo_ready', countsTowardTier: true, achieved: true, isDataOrPrototype: true },
  pilot_contract: { key: 'pilot_contract', countsTowardTier: true, achieved: true },
  iterations: { key: 'iterations', countsTowardTier: true, achieved: true },
};
const ms = (keys) => keys.map((k) => ({ ...MS[k] }));
const FIVE = ['problem_confirmed', 'data_connected', 'demo_ready', 'pilot_contract', 'iterations'];
const biz = { milestoneKey: 'pilot_contract', department: '业务部门', revokedAt: null, isBusinessDepartment: true };
const tech = { milestoneKey: 'pilot_contract', department: '技术部门', revokedAt: null, isBusinessDepartment: false };

test('D 段：报名即入档（0 里程碑）；C 段 1 个；B 段 2 个', () => {
  assert.equal(computeTier({ milestones: [], signoffs: [], ranksConfig: R }).tier, 'D');
  assert.equal(computeTier({ milestones: [], signoffs: [], ranksConfig: R }).milestoneCount, 0);
  assert.equal(computeTier({ milestones: ms(['problem_confirmed']), signoffs: [], ranksConfig: R }).tier, 'C');
  assert.equal(computeTier({ milestones: ms(['problem_confirmed', 'data_connected']), signoffs: [], ranksConfig: R }).tier, 'B');
});

test('★ 边界：3 项含接入 → A；3 项不含数据接入/原型交付 → 退回 B', () => {
  assert.equal(computeTier({ milestones: ms(['problem_confirmed', 'data_connected', 'demo_ready']), signoffs: [], ranksConfig: R }).tier, 'A');
  const out = computeTier({ milestones: ms(['problem_confirmed', 'pilot_contract', 'iterations']), signoffs: [], ranksConfig: R });
  assert.equal(out.tier, 'B');
  assert.equal(out.milestoneCount, 3);
});

test('★ 边界：5 项含企业业务部门签字 → S；技术部门签字不计入 S（R-PTS-03）', () => {
  const s = computeTier({ milestones: ms(FIVE), signoffs: [biz], ranksConfig: R });
  assert.equal(s.tier, 'S');
  assert.equal(s.businessSignoffCount, 1);
  const t = computeTier({ milestones: ms(FIVE), signoffs: [tech], ranksConfig: R });
  assert.equal(t.tier, 'A', '技术部门签字不算 S');
  assert.equal(t.businessSignoffCount, 0);
});

test('撤回的签字不计入段位；未达成 / 不计段的里程碑不计数', () => {
  const revoked = computeTier({
    milestones: ms(FIVE),
    signoffs: [{ ...biz, revokedAt: '2026-10-20T00:00:00Z' }], ranksConfig: R,
  });
  assert.equal(revoked.tier, 'A');
  const out = computeTier({
    milestones: [
      { key: 'problem_confirmed', countsTowardTier: true, achieved: true },
      { key: 'data_connected', countsTowardTier: true, achieved: false },
      { key: 'x', countsTowardTier: false, achieved: true },
    ],
    signoffs: [], ranksConfig: R,
  });
  assert.equal(out.milestoneCount, 1);
  assert.equal(out.tier, 'C');
});

test('★ 段位只换资源不换钱（R-PTS-05）：权益来自配置，永不出现奖金', () => {
  const out = computeTier({ milestones: ms(['problem_confirmed', 'data_connected', 'demo_ready']), signoffs: [], ranksConfig: R });
  assert.deepEqual(out.benefits, R.benefits.A);
  assert.deepEqual(out.neverUnlocks, ['奖金', '决赛名次']);
  assert.ok(!JSON.stringify(out.benefits).includes('奖金'));
});

test('★ 降级：撤回签字 → 降回对应档；连续 14 天零提交 → 降 1 档并公示；不低于 D 段', () => {
  const revoked = applyTierDemotion({
    tier: 'S', daysSinceLastActivity: 0,
    revokedSignoffs: [{ milestoneKey: 'pilot_contract', revokedAt: '2026-10-20T00:00:00Z' }],
    ranksConfig: R,
  });
  assert.equal(revoked.demoted, true);
  assert.equal(revoked.tier, 'A');
  assert.equal(revoked.from, 'S');
  assert.equal(revoked.publish, true, '降级必须公示');
  assert.ok(revoked.reason.includes('signoff_revoked'));

  const idle = applyTierDemotion({ tier: 'B', daysSinceLastActivity: 14, revokedSignoffs: [], ranksConfig: R });
  assert.equal(idle.demoted, true);
  assert.equal(idle.tier, 'C');
  assert.equal(idle.publish, true);
  assert.ok(idle.reason.includes('inactive_14days'));
  const notYet = applyTierDemotion({ tier: 'B', daysSinceLastActivity: 13, revokedSignoffs: [], ranksConfig: R });
  assert.equal(notYet.demoted, false);
  assert.equal(notYet.tier, 'B');

  const floor = applyTierDemotion({ tier: 'D', daysSinceLastActivity: 99, revokedSignoffs: [{ revokedAt: 'x' }], ranksConfig: R });
  assert.equal(floor.tier, 'D');
});

test('部门归类与数据接入/原型交付识别', () => {
  assert.equal(classifyDepartment('业务部门', C), 'business');
  assert.equal(classifyDepartment('技术部门', C), 'technical');
  assert.equal(classifyDepartment('市场部', C), 'business');
  assert.equal(classifyDepartment('研发中心', C), 'technical');
  assert.equal(classifyDepartment('法务部', C), 'unknown');
  assert.equal(classifyDepartment('', C), 'unknown');
  assert.equal(isDataOrPrototypeMilestone('data_connected', C), true);
  assert.equal(isDataOrPrototypeMilestone('demo_ready', C), true);
  assert.equal(isDataOrPrototypeMilestone('revenue', C), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/tier.test.js` → Expected: FAIL —— `Cannot find module '../src/domain/tier.js'`

- [ ] **Step 3: 创建 src/domain/tier.js**

```javascript
// src/domain/tier.js — 段位计算与降级（纯函数）
// 依据：S10 §2.1 段位锚定企业签字里程碑 + §2.2 段位表 + §2.3 降级与权益
//   + R-PTS-01/02/03/04/05/06 + 冲突裁决 C-02（公示范围）
//   ⛔ 段位【只】影响同分排序，不制造额外名额（S10 §2.3 要点 3）——本模块不产出任何"名额"。
//   ⛔ 段位换资源不换钱：权益全部来自 ranks.benefits，ranks.neverUnlocks 常驻返回。
//   ✅ 段位锚定【企业签字的里程碑】：工作室能刷打卡，刷不到企业签字（R-PTS-01）。

/** 部门归类：命中业务关键词 → business；命中技术关键词 → technical；否则 unknown */
export function classifyDepartment(department, criteriaConfig) {
  const t = criteriaConfig?.tier || {};
  const biz = (t.businessDepartmentKeywords || []).map((k) => String(k).toLowerCase());
  const tech = (t.technicalDepartmentKeywords || []).map((k) => String(k).toLowerCase());
  const d = String(department ?? '').trim().toLowerCase();
  if (!d) return 'unknown';
  if (biz.some((k) => d.includes(k))) return 'business';
  if (tech.some((k) => d.includes(k))) return 'technical';
  return 'unknown';
}

/** 该里程碑是否计入 A 段的"含 ≥1 项数据接入或原型交付"附加条件 */
export function isDataOrPrototypeMilestone(key, criteriaConfig) {
  const list = criteriaConfig?.tier?.dataOrPrototypeMilestones || [];
  return list.includes(key);
}

/**
 * 计算段位。
 * milestones: [{ key, countsTowardTier, achieved, isDataOrPrototype? }]
 *   ⚠️ isDataOrPrototype 由服务层按 rules/criteria.tier 判定后写入（本函数只读不判）。
 * signoffs:   [{ milestoneKey, department, revokedAt, isBusinessDepartment? }]
 *   ⚠️ isBusinessDepartment 同理由服务层按 rules/criteria.tier 判定后写入。
 */
export function computeTier({ milestones, signoffs, ranksConfig }) {
  const tiers = ranksConfig?.tiers || [];
  const counted = (Array.isArray(milestones) ? milestones : [])
    .filter((m) => m && m.achieved === true && m.countsTowardTier !== false);
  const milestoneCount = counted.length;
  const dataOrPrototypeCount = counted.filter((m) => m.isDataOrPrototype === true).length;
  const active = (Array.isArray(signoffs) ? signoffs : []).filter((s) => s && !s.revokedAt);
  const businessSignoffCount = active.filter((s) => s.isBusinessDepartment === true).length;

  // 从最高档往下找第一个满足条件的（tiers 按门槛递增，P0 校验过严格递增）
  let chosen = null;
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    const t = tiers[i];
    if (milestoneCount < (t.minMilestones ?? 0)) continue;
    if (t.requiresDataOrPrototype && dataOrPrototypeCount < 1) continue;
    if (t.requiresBusinessSignoff && businessSignoffCount < 1) continue;
    chosen = t;
    break;
  }
  if (!chosen) chosen = tiers[0] || { key: 'D', name: '出题', minMilestones: 0 };

  const reasons = [`milestones=${milestoneCount}`];
  if (dataOrPrototypeCount) reasons.push(`data_or_prototype=${dataOrPrototypeCount}`);
  if (businessSignoffCount) reasons.push(`business_signoff=${businessSignoffCount}`);
  reasons.push(`tier=${chosen.key}`);

  return {
    tier: chosen.key,
    tierName: chosen.name ?? chosen.key,
    milestoneCount,
    businessSignoffCount,
    reasons,
    benefits: (ranksConfig?.benefits || {})[chosen.key] || [],
    neverUnlocks: ranksConfig?.neverUnlocks || [],
  };
}

/**
 * 段位降级。
 * 依据：S10 §2.3 要点 2「里程碑被撤回签字 → 降回对应档；连续 14 天零提交且无合理说明
 *   → 降 1 档并公示」+ R-PTS-04。
 * ⛔ 两条规则同时命中时【只降 1 档】（取较大值而不是叠加）：降级是"回到对应档"，不是惩罚。
 * ⛔ 永不低于 D 段。
 */
export function applyTierDemotion({ tier, daysSinceLastActivity, revokedSignoffs, ranksConfig }) {
  const demotion = ranksConfig?.demotion || {};
  const order = (ranksConfig?.tiers || []).map((t) => t.key);
  const current = order.includes(tier) ? tier : (order[0] ?? tier);
  const idx = Math.max(0, order.indexOf(current));

  const reasons = [];
  let levels = 0;
  if (demotion.onSignoffRevoked === true && (Array.isArray(revokedSignoffs) ? revokedSignoffs : []).length > 0) {
    reasons.push('signoff_revoked');
    levels = Math.max(levels, 1);
  }
  const inactiveDays = Number.isFinite(demotion.inactiveDays) ? demotion.inactiveDays : 14;
  const days = Number(daysSinceLastActivity) || 0;
  if (days >= inactiveDays) {
    reasons.push(`inactive_${inactiveDays}days`);
    levels = Math.max(levels, Number(demotion.inactiveDropLevels) || 1);
  }

  if (!levels) return { tier: current, demoted: false, reason: null, publish: false, from: current };
  const next = order[Math.max(0, idx - levels)] ?? current;
  return {
    tier: next,
    demoted: true,
    reason: reasons.join('+'),
    publish: demotion.publishDemotion === true,
    from: current,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/tier.test.js` → Expected: PASS（7 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/tier.js test/tier.test.js
git commit -m "feat(P3): 段位计算与降级规则"
```

---

### Task 5: 行为分（与总分隔离的独立通路）

**Files:** Create `platform/src/domain/behavior.js`、`platform/test/behavior.test.js`

**Interfaces:**
- Consumes: `rules.behavior`（P0 已定稿：**只读不写**）、`rules.criteria.behaviorEvidence`（由服务层注入 `behaviorConfig.evidenceRequirements`）
- Produces: `behaviorScore({ events, behaviorConfig })` → `{ total, items, completed, completionThreshold, maxWeightShare, sortUse }`；`items[]` 每项为 `{ type, points, label, counted, reason }`（`reason` 非空 = 未计分的具体原因，**不静默**）

> ⛔ **本 Task 的核心职责**：行为分只能从 `behavior_events` 独立通路进来，且只能流向破同分链的 `behavior` 键。下面的「隔离断言」是本阶段硬验收项。

- [ ] **Step 1: 写失败的测试**

`platform/test/behavior.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { rankTeams } from '../src/domain/ranking.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const B = rules.behavior;
const CHAIN = rules.tiebreak.chain;
const OK = JSON.stringify({ repo: 'git@x', version: 'v1.2.3', artifact: 'demo.zip' });
const ev = (type, extra = {}) => ({
  id: `e_${type}_${extra.created_at || '1'}`, type,
  created_at: extra.created_at || '2026-10-10T00:00:00.000Z',
  evidence: extra.evidence === undefined ? OK : extra.evidence,
});

test('行为分明细：每周进度 2 / workshop 3 / 按时交付里程碑 5 / 企业对接会 5 / 首次 Demo 10', () => {
  const out = behaviorScore({
    events: [
      ev('weekly_progress'),
      ev('workshop_output', { evidence: JSON.stringify({ output: '课后产出.pdf' }) }),
      ev('milestone_on_time'),
      ev('enterprise_meeting', { evidence: JSON.stringify({ enterpriseConfirmationId: 'ec_1' }) }),
      ev('first_demo'),
    ],
    behaviorConfig: B,
  });
  assert.equal(out.total, 2 + 3 + 5 + 5 + 10);
  assert.equal(out.items.length, 5);
  assert.ok(out.items.every((i) => i.counted));
  assert.equal(out.completionThreshold, 60, '达标线 60 = 完赛（R-PTS-09）');
  assert.equal(out.maxWeightShare, 0.10);
  assert.equal(out.sortUse, 'tiebreak_only', '行为分只做破同分（R-PTS-08）');
});

test('★ 反作弊 5 条：签到 0 分 / 纯文字进度不给分 / 提交须带版本记录+代码仓', () => {
  const checkin = behaviorScore({ events: [ev('checkin')], behaviorConfig: B });
  assert.equal(checkin.total, 0);
  assert.equal(checkin.items[0].counted, false);
  assert.equal(checkin.items[0].reason, 'unknown_event_type');

  const plain = behaviorScore({ events: [ev('weekly_progress', { evidence: '今天我们把进度更新了一下' })], behaviorConfig: B });
  assert.equal(plain.total, 0);
  assert.equal(plain.items[0].reason, 'evidence_not_json');

  const noRepo = behaviorScore({ events: [ev('weekly_progress', { evidence: JSON.stringify({ version: 'v1', artifact: 'a' }) })], behaviorConfig: B });
  assert.equal(noRepo.total, 0);
  assert.equal(noRepo.items[0].reason, 'evidence_missing_repo');

  const noVersion = behaviorScore({ events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', artifact: 'a' }) })], behaviorConfig: B });
  assert.equal(noVersion.total, 0);
  assert.equal(noVersion.items[0].reason, 'evidence_missing_version');

  const blocked = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', version: 'v1', blocker: '缺 API key' }) })],
    behaviorConfig: B,
  });
  assert.equal(blocked.total, 2, '明确阻塞点也算有效提交（R-STG-04）');
});

test('workshop 必须有课后产出；企业对接会必须有企业确认记录；once 事件只计第一次', () => {
  const noOutput = behaviorScore({ events: [ev('workshop_output', { evidence: JSON.stringify({}) })], behaviorConfig: B });
  assert.equal(noOutput.total, 0);
  assert.equal(noOutput.items[0].reason, 'evidence_missing_output');

  const noConfirm = behaviorScore({ events: [ev('enterprise_meeting', { evidence: JSON.stringify({ note: '聊了' }) })], behaviorConfig: B });
  assert.equal(noConfirm.total, 0);
  assert.equal(noConfirm.items[0].reason, 'evidence_missing_enterpriseConfirmationId');

  const twice = behaviorScore({
    events: [ev('first_demo', { created_at: '2026-10-10T00:00:00.000Z' }), ev('first_demo', { created_at: '2026-10-11T00:00:00.000Z' })],
    behaviorConfig: B,
  });
  assert.equal(twice.total, 10);
  assert.equal(twice.items[1].counted, false);
  assert.equal(twice.items[1].reason, 'once_limit');
});

test('★ 隔离断言：行为分变化【不影响总分】与【不影响非完全同分队伍的 A 榜名次】', () => {
  const base = [
    { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5 },
    { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5 },
    { teamId: 't_c', total: 70, peerScore: 5, enterpriseRaw: 5 },
  ];
  const run = (behaviorScoreValue) => rankTeams({
    teams: base.map((t) => ({ ...t, behaviorScore: behaviorScoreValue })),
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  const low = run(0);
  const high = run(100);
  assert.deepEqual(low.ordered.map((o) => o.total), high.ordered.map((o) => o.total), '总分不变');
  assert.deepEqual(low.ordered.map((o) => o.rank), high.ordered.map((o) => o.rank), '名次数组不变');
  assert.equal(low.ordered.find((o) => o.teamId === 't_c').rank, 3);
  assert.equal(high.ordered.find((o) => o.teamId === 't_c').rank, 3);
  assert.deepEqual(high.ordered.map((o) => o.rank), [1, 1, 3]);
});

test('★ 隔离断言：完全同分时，行为分只改变相对顺序，不改变名次数字', () => {
  const r = rankTeams({
    teams: [
      { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: 1 },
      { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: 99 },
    ],
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_b', 't_a'], '行为分高者在前');
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1], '名次数字不变（仍然并列）');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/behavior.test.js` → Expected: FAIL —— `Cannot find module '../src/domain/behavior.js'`

- [ ] **Step 3: 创建 src/domain/behavior.js**

```javascript
// src/domain/behavior.js — 行为分计算（纯函数，★ 与总分完全隔离的独立通路）
// 依据：S10 §3.1 计分明细 + §3.2 达标线 60 + §3.3 只做"垫底排序" + R-PTS-07/08/09/10
//
// ⛔ 本模块的产出【只】允许流向破同分链的 'behavior' 键（scope=tied_only）。
//    ⛔ 绝不进入 scoreStage() 入参、绝不进入 total / seatP / seatE、绝不进入名次积分。
//    ⛔ 数据来源是独立表 behavior_events，不从 stage_results 派生。
//    依据：S10 §8 第三条风险原文「分轨必须是算法层面的，不是纪律层面的」。
//
// ✅ 借鉴 HackSC/hibiscus 的行为分发放日志表结构（MIT），但排序时【不】与赛事分相加
//    （上游 getRank 把 bonus_points + event_points 相加，与本规则直接冲突——只抄表结构）。

// 证据要求（默认口径）。服务层会用 rules/criteria.behaviorEvidence 注入的版本覆盖它。
// 依据：R-STG-04「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」
//     + R-PTS-10 反作弊第 3/5 条「提交须带版本记录 + 代码仓」「纯文字进度不给分」
const DEFAULT_EVIDENCE_REQUIREMENTS = {
  weekly_progress: { required: ['repo', 'version'], oneOf: ['artifact', 'blocker'] },
  workshop_output: { required: ['output'], oneOf: [] },
  enterprise_meeting: { required: ['enterpriseConfirmationId'], oneOf: [] },
};

function parseEvidence(ev) {
  const raw = ev?.evidence;
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'missing_evidence' };
  if (typeof raw === 'object') return { ok: true, data: raw };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'evidence_not_object' };
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'evidence_not_json' };   // ⛔ 纯文字进度：不给分（R-STG-04 / R-PTS-10）
  }
}

function checkEvidence(def, ev, requirements) {
  const rule = requirements[def.key];
  if (!rule) return { ok: true };
  const parsed = parseEvidence(ev);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  for (const field of rule.required || []) {
    const v = parsed.data[field];
    if (v === undefined || v === null || String(v).trim() === '') {
      return { ok: false, reason: `evidence_missing_${field}` };
    }
  }
  const oneOf = rule.oneOf || [];
  if (oneOf.length) {
    const hit = oneOf.some((f) => {
      const v = parsed.data[f];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
    if (!hit) return { ok: false, reason: `evidence_missing_any_of_${oneOf.join('_or_')}` };
  }
  return { ok: true };
}

/**
 * 计算行为分。
 * events: [{ id, type, evidence, created_at }]
 *   ⚠️ 分值【不】取自事件本身，一律以 rules/behavior-points.json 为准（防篡改）。
 * behaviorConfig: rules.behavior（可额外带 evidenceRequirements 覆盖默认证据要求）
 */
export function behaviorScore({ events, behaviorConfig }) {
  const cfg = behaviorConfig || {};
  const defs = Array.isArray(cfg.events) ? cfg.events : [];
  const threshold = Number.isFinite(cfg.completionThreshold) ? cfg.completionThreshold : 60;
  const requirements = { ...DEFAULT_EVIDENCE_REQUIREMENTS, ...(cfg.evidenceRequirements || {}) };
  const byKey = new Map(defs.map((d) => [d.key, d]));

  // 按创建时间升序（域内排序，无 IO、无 Date.now）
  const sorted = [...(Array.isArray(events) ? events : [])].sort((a, b) => {
    const ca = String(a?.created_at ?? '');
    const cb = String(b?.created_at ?? '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a?.id ?? '') < String(b?.id ?? '') ? -1 : (String(a?.id ?? '') > String(b?.id ?? '') ? 1 : 0);
  });

  const seenOnce = new Set();
  const items = [];
  let total = 0;
  for (const ev of sorted) {
    const type = ev?.type;
    const def = byKey.get(type);
    if (!def) {
      // 未知类型（如"签到"）→ 0 分并明确记录，不静默（R-PTS-10 反作弊第 1 条）
      items.push({ type, points: 0, label: String(type), counted: false, reason: 'unknown_event_type' });
      continue;
    }
    if (def.once && seenOnce.has(def.key)) {
      items.push({ type: def.key, points: 0, label: def.label, counted: false, reason: 'once_limit' });
      continue;
    }
    const check = checkEvidence(def, ev, requirements);
    if (!check.ok) {
      items.push({ type: def.key, points: 0, label: def.label, counted: false, reason: check.reason });
      continue;
    }
    seenOnce.add(def.key);
    const pts = Number(def.points) || 0;
    total += pts;
    items.push({ type: def.key, points: pts, label: def.label, counted: true, reason: null });
  }
  return {
    total,
    items,
    completed: total >= threshold,          // R-PTS-09：达标线 60 → 完赛认定
    completionThreshold: threshold,
    maxWeightShare: cfg.maxWeightShare ?? null,
    sortUse: cfg.sortUse ?? null,           // 恒为 'tiebreak_only'（R-PTS-08）
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/behavior.test.js` → Expected: PASS（5 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/behavior.js test/behavior.test.js
git commit -m "feat(P3): 行为分独立通路与总分隔离断言"
```

---

### Task 6: 可见性过滤（API 层）

**Files:** Create `platform/src/domain/visibility.js`、`platform/test/visibility.test.js`

**Interfaces:**
- Consumes: `rules.visibility`（P0 已定稿：**只读不写**）、`rules.ranks.tiers`（段位顺序）
- Produces: `applyVisibility({ payload, viewer, visibilityConfig, context })` → 过滤后的 payload；`context = { scope, viewerTeamIds?, viewerTeamId?, tierOrder? }`，`scope ∈ 'rank' | 'business' | 'personal' | 'tier'`

> ⛔ **在前端隐藏 = 数据已泄露**。本函数是【唯一】的过滤入口，服务层必须在返回前调用；前端只做渲染。

- [ ] **Step 1: 写失败的测试**

`platform/test/visibility.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { applyVisibility } from '../src/domain/visibility.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const V = rules.visibility;
const ORDER = rules.ranks.tiers.map((t) => t.key);
const tierPayload = () => ({
  scope: 'tier',
  rows: [
    { teamId: 't_s', teamName: 'S队', tier: 'S', tierRank: 1, enterpriseName: '某某公司' },
    { teamId: 't_a', teamName: 'A队', tier: 'A', tierRank: 2, enterpriseName: '乙公司' },
    { teamId: 't_d', teamName: 'D队', tier: 'D', tierRank: 9, enterpriseName: '丙公司', progress: { done: 0, total: 7 } },
  ],
});
const apply = (payload, context, viewer = null, cfg = V) => applyVisibility({
  payload, viewer, visibilityConfig: cfg, context: { tierOrder: ORDER, ...context },
});

test('★ C-02 裁决：段位榜里 D 段不出现在榜单，只给本人进度卡（且不含名次）', () => {
  const out = apply(tierPayload(), { scope: 'tier' });
  assert.deepEqual(out.rows.map((r) => r.teamId), ['t_s', 't_a']);
  assert.ok(!out.rows.some((r) => r.tier === 'D'));

  const self = apply(tierPayload(), { scope: 'tier', viewerTeamId: 't_d' }, { id: 'u_1' });
  assert.deepEqual(self.rows.map((r) => r.teamId), ['t_s', 't_a']);
  assert.ok(self.selfProgress, '本人应拿到进度卡');
  assert.equal(self.selfProgress.teamId, 't_d');
  assert.equal(self.selfProgress.rank, undefined, '本人进度卡不含名次');
  assert.deepEqual(self.selfProgress.progress, { done: 0, total: 7 });
});

test('★ 段位榜与 A 榜都不公示企业名', () => {
  const out = apply(tierPayload(), { scope: 'tier' });
  for (const r of out.rows) assert.equal(r.enterpriseName, undefined, '企业名不公示（S10 §8）');
  const rank = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, enterpriseName: '某某公司' }],
  }, { scope: 'rank' });
  assert.equal(rank.rows[0].enterpriseName, undefined);
});

test('★ B 榜：里程碑公开，但评分与签字人不公开；互评来源不公示', () => {
  const out = apply({
    scope: 'business',
    rows: [{
      teamId: 't_a', teamName: 'A队',
      milestones: [{ key: 'data_connected', label: '真实数据接入', achieved: true }],
      score: 88, rawScore: 90, seatE: 91,
      signatory: '张三', signatoryUserId: 'u_9', signatoryName: '张三',
      enterpriseName: '某某公司', enterpriseId: 'e_1',
    }],
  }, { scope: 'business' });
  const row = out.rows[0];
  assert.equal(row.milestones[0].achieved, true, '里程碑进度公开');
  for (const k of ['score', 'rawScore', 'seatE', 'signatory', 'signatoryUserId', 'signatoryName', 'enterpriseName', 'enterpriseId']) {
    assert.equal(row[k], undefined, `${k} 不应出现在 B 榜`);
  }

  const rank = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, peerSource: 't_x', fromTeamId: 't_x', fromUserId: 'u_7', peerScore: 5 }],
  }, { scope: 'rank' });
  for (const k of ['peerSource', 'fromTeamId', 'fromUserId', 'peerScore']) {
    assert.equal(rank.rows[0][k], undefined, `${k} 互评来源不公示`);
  }
});

test('A 榜与滚动总榜全员公开（任务书 §七 明文）；个人榜标出本人且不泄露手机号', () => {
  const rank = apply({
    scope: 'rank',
    rows: [{ teamId: 't_d', teamName: 'D队', rank: 9, total: 60, tier: 'D' },
      { teamId: 't_s', teamName: 'S队', rank: 1, total: 90, tier: 'S' }],
  }, { scope: 'rank' });
  assert.equal(rank.rows.length, 2, 'A 榜不因段位低而隐藏');

  const personal = apply({
    scope: 'personal',
    rows: [{ userId: 'u_1', name: '张三', total: 41, rank: 1, phone: '13800000000', org: '某公司' }],
  }, { scope: 'personal' }, { id: 'u_1' });
  assert.equal(personal.rows[0].isSelf, true);
  assert.equal(personal.rows[0].phone, undefined);
  assert.equal(personal.rows[0].org, undefined);
});

test('配置关闭时字段才会回来（可见性是配置驱动的，不是硬编码）；过滤不改原对象', () => {
  const payload = { scope: 'business', rows: [{ teamId: 't_a', signatory: '张三', enterpriseName: '某某公司', score: 88 }] };
  const out = apply(payload, { scope: 'business' }, null, {
    ...V,
    business: { ...V.business, scoresPublic: true, signatoryPublic: true },
    rank: { ...V.rank, showEnterpriseName: true },
  });
  assert.equal(out.rows[0].signatory, '张三');
  assert.equal(out.rows[0].score, 88);
  assert.equal(out.rows[0].enterpriseName, '某某公司');
  assert.equal(payload.rows[0].signatory, '张三', '原对象必须保持不变（不能污染快照）');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/visibility.test.js` → Expected: FAIL —— `Cannot find module '../src/domain/visibility.js'`

- [ ] **Step 3: 创建 src/domain/visibility.js**

```javascript
// src/domain/visibility.js — 可见性过滤（纯函数，★ 唯一过滤入口）
// 依据：设计文档 §6.6 + S10 §0.3 分层公开 + §0.4 互评来源 + §8 风险表
//   + 冲突裁决 C-02（C 段及以上公示名次；D 段只给本人进度卡）
//   ⛔ 可见性必须在 API 层过滤：前端隐藏 = 数据已经发到浏览器 = 任何人都能看到。
//      前端只负责渲染，不承担过滤职责。
import { pick } from './util.js';

const DEFAULT_TIER_ORDER = ['D', 'C', 'B', 'A', 'S'];
// 互评来源字段：visibility.peerReview.showSource=false 时清空
const PEER_SOURCE_KEYS = ['peerSource', 'fromTeamId', 'fromUserId', 'peerFrom', 'peerScore'];
// 企业名字段：段位公示时不公示（S10 §8）
const ENTERPRISE_NAME_KEYS = ['enterpriseName', 'enterprise_name', 'enterpriseId', 'enterprise_id'];

/**
 * @param payload    { scope, rows: [...] }
 * @param viewer     当前查看者（可为 null = 未登录 / 旁观）
 * @param visibilityConfig rules.visibility
 * @param context    { scope, viewerTeamIds?, viewerTeamId?, tierOrder? }
 */
export function applyVisibility({ payload, viewer, visibilityConfig, context }) {
  const cfg = visibilityConfig || {};
  const ctx = context || {};
  const scope = ctx.scope || payload?.scope || 'rank';
  const tierOrder = (Array.isArray(ctx.tierOrder) && ctx.tierOrder.length) ? ctx.tierOrder : DEFAULT_TIER_ORDER;
  const viewerTeamIds = new Set([
    ...(Array.isArray(ctx.viewerTeamIds) ? ctx.viewerTeamIds : []),
    ...(ctx.viewerTeamId ? [ctx.viewerTeamId] : []),
    ...(viewer?.teamId ? [viewer.teamId] : []),
  ]);

  const peerKeys = cfg.peerReview?.showSource === false ? PEER_SOURCE_KEYS : [];
  const entKeys = cfg.rank?.showEnterpriseName === false ? ENTERPRISE_NAME_KEYS : [];

  const src = Array.isArray(payload?.rows) ? payload.rows : [];
  const out = { ...(payload || {}), rows: [] };
  let rows = src;

  if (scope === 'rank') {
    // A 榜与滚动总榜：全员公开（任务书 §七 明文）
    rows = src.map((r) => pick(r, [...peerKeys, ...entKeys]));
  } else if (scope === 'business') {
    // B 榜：里程碑进度公开；评分与签字人不公开；企业名不公示
    const drop = [...peerKeys];
    if (cfg.business?.scoresPublic !== true) drop.push('score', 'rawScore', 'raw_score', 'seatE', 'seatP', 'total', 'enterpriseRaw');
    if (cfg.business?.signatoryPublic !== true) drop.push('signatory', 'signatoryUserId', 'signatoryName', 'signatory_user_id', 'signedBy');
    rows = src.map((r) => pick(r, [...drop, ...entKeys]));
  } else if (scope === 'tier') {
    // 段位榜：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡
    const fromIdx = Math.max(0, tierOrder.indexOf(cfg.rank?.publicFromTier || 'C'));
    const visible = [];
    let self = null;
    for (const r of src) {
      const idx = tierOrder.indexOf(r.tier);
      if (idx >= 0 && idx >= fromIdx) {
        visible.push(pick(r, [...peerKeys, ...entKeys]));
      } else if (viewerTeamIds.has(r.teamId)) {
        self = {
          ...pick(r, [...peerKeys, ...entKeys, 'rank', 'tierRank', 'teamName']),
          teamId: r.teamId,
          tier: r.tier,
          progress: r.progress ?? null,
          self: true,
        };
      }
    }
    rows = visible;
    if (self) out.selfProgress = self;
  } else if (scope === 'personal') {
    // 个人榜：终生上榜，但手机号与单位不外泄
    rows = src.map((r) => ({
      ...pick(r, [...peerKeys, 'phone', 'org', 'idCard', 'password_hash']),
      isSelf: Boolean(viewer && r.userId === viewer.id),
    }));
  } else {
    rows = src.map((r) => pick(r, peerKeys));
  }

  out.rows = rows;
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/visibility.test.js` → Expected: PASS（5 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/visibility.js test/visibility.test.js
git commit -m "feat(P3): API 层可见性过滤与 C-02 段位公示裁决"
```

---

### Task 7: 榜单服务 + 战绩卡 + API

**Files:**
- Create: `platform/src/db/repo/leaderboard.js`、`platform/src/db/repo/points.js`、`platform/src/db/repo/tiers.js`、`platform/src/services/leaderboard.js`、`platform/src/services/performance-card.js`、`platform/src/services/tier.js`、`platform/test/leaderboard-service.test.js`
- Modify: `platform/src/errors.js`（P1 已建，本阶段**只复用**：统一为 status-first 顺序 `AppError(status, code, message, detail)`，不新建 `errors/app-error.js`）
- Modify: `platform/src/server.js`

**Interfaces:**
- Consumes: `rankTeams` / `computeStagePoints` / `computeMvp` / `computePersonalPoints` / `behaviorScore` / `applyVisibility` / `computeTier`（Task 2–6）、P2 的 `stage_results` / `peer_reviews` / `enterprise_confirmations` / `computation_snapshots`、P1 的 `teams` / `team_members` / `task_packages`
- Produces: `getLeaderboard({ db, stageId, scope, viewer })` → `{ scope, stageId, editionId, rows, warnings, ... }`（**已过滤**）；`getRollingLeaderboard({ db, editionId, viewer })` → 滚动总榜（已过滤）；`publishLeaderboard({ db, editionId, stageId, actorId, now })` → `{ editionId, stageId, snapshots, awarded, createdAt }`（写快照 + 审计 + 积分流水）；`getPerformanceCard({ db, teamId, viewer })` → 战绩卡（不含签字人）；`getTeamTier({ db, teamId, viewer })` → 段位与权益；API `GET /api/leaderboard/:stageId?scope=rank|business|personal`｜`GET /api/leaderboard/rolling?editionId=`｜`GET /api/teams/:id/performance-card`｜`GET /api/teams/:id/tier`

- [ ] **Step 1: 写失败的测试**

`platform/test/leaderboard-service.test.js`：

```javascript
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
import { createSession } from '../src/auth/session.js';
import { getLeaderboard, publishLeaderboard } from '../src/services/leaderboard.js';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-20T00:00:00.000Z';

function seed(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会管理员','13800000000','x','mba',NULL,1,1,'${NOW}'),
           ('u_cap','A队队长','13800000001','x','mba',NULL,0,1,'${NOW}'),
           ('u_obs','观察员','13800000003','x','other',NULL,0,1,'${NOW}'),
           ('u_d','D队队员','13800000004','x','other',NULL,0,1,'${NOW}');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2026-10-31','${NOW}');
    INSERT INTO cities (id, name, edition_id) VALUES ('c_1','上海','ed_1');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, created_at)
    VALUES ('tp_1','ed_1','e_1','某某公司','任务一','痛点一','交付物一','验收一','A','approved',10,'A','试点承诺','承诺书',0,'${NOW}'),
           ('tp_2','ed_1','e_2','乙公司','任务二','痛点二','交付物二','验收二','A','approved',10,'A','试点承诺','承诺书',0,'${NOW}');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
    VALUES ('t_a','ed_1','A队','u_cap','tp_1','A','active','${NOW}'),
           ('t_b','ed_1','B队','u_cap','tp_1','A','active','${NOW}'),
           ('t_c','ed_1','C队','u_cap','tp_2','C','active','${NOW}'),
           ('t_d','ed_1','D队','u_cap','tp_2','D','active','${NOW}');
    INSERT INTO team_members (team_id, user_id, role, joined_at)
    VALUES ('t_a','u_cap','captain','${NOW}'), ('t_d','u_d','captain','${NOW}');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed'),
           ('st_2','ed_1','S2','空赛段','initial','2026-10-10','2026-10-13','2026-10-14','initial','closed'),
           ('st_r','ed_1','S4','路演','roadshow','2026-10-26','2026-10-28','2026-10-29','initial','closed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1','st_1','t_a',1,90,88,95,0,10,NULL,'${NOW}'),
           ('sr_2','st_1','t_b',2,90,90,85,1,8,NULL,'${NOW}'),
           ('sr_3','st_1','t_c',3,70,70,NULL,0,5,NULL,'${NOW}'),
           ('sr_4','st_1','t_d',4,60,60,NULL,0,0,NULL,'${NOW}');
    INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
    VALUES ('pr_1','st_1','t_b','t_a',9,'rq_1','${NOW}'),
           ('pr_2','st_1','t_a','t_b',3,'rq_2','${NOW}');
    INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score,
      cross_judge_id, signatory_user_id, created_at, deleted_at)
    VALUES ('ec_1','st_1','t_a','e_1','enterprise',80,'j_1','u_cap','${NOW}',NULL),
           ('ec_2','st_1','t_b','e_2','enterprise',60,'j_1','u_cap','${NOW}',NULL);
    INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version,
      input_json, output_json, trace_json, revision, created_at)
    VALUES ('cs_1','stage_score','ed_1','st_1',NULL,'scoring-initial@2026-10-20','{}',
      '{"warnings":[{"code":"judge_sample_too_small","message":"本轮该维度未做评委宽严归一化（样本不足 5）"}]}','{}',1,'${NOW}');
    INSERT INTO milestones (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at)
    VALUES ('ms_1','t_a',NULL,'problem_confirmed','企业问题确认',1,'${NOW}',1,'${NOW}'),
           ('ms_2','t_a',NULL,'data_connected','真实数据接入',1,'${NOW}',1,'${NOW}'),
           ('ms_3','t_a',NULL,'demo_ready','可演示原型',1,'${NOW}',1,'${NOW}'),
           ('ms_4','t_c',NULL,'problem_confirmed','企业问题确认',1,'${NOW}',1,'${NOW}');
    INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
    VALUES ('sg_1','ms_1','e_1','u_cap','业务部门','解决库存周转环节','${NOW}',NULL),
           ('sg_2','ms_2','e_1','u_cap','技术部门','接口已打通','${NOW}',NULL);
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1','t_a','A',3,1,'["milestones=3"]','${NOW}',NULL),
           ('tr_2','t_c','C',1,1,'["milestones=1"]','${NOW}',NULL),
           ('tr_3','t_d','D',0,0,'["milestones=0"]','${NOW}',NULL);
  `);
  // 行为分事件（★ 独立通路的数据源）
  db.prepare('INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('be_1', 't_b', 'u_cap', 'weekly_progress', 2, JSON.stringify({ repo: 'git@x', version: 'v1', artifact: 'demo.zip' }), NOW);
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p3-svc-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  seed(db);
  const { rules } = loadRules(join(here, '..', 'rules'));
  const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
  return { db, close, dataDir, rules, app };
}

function call(app, method, path, { cookie = null } = {}) {
  return new Promise((resolve) => {
    const req = {
      method, url: path, headers: cookie ? { cookie } : {},
      async *[Symbol.asyncIterator]() {},
      on() {},
    };
    const res = {
      statusCode: 200, headers: {}, body: '',
      writeHead(s, h) { this.statusCode = s; this.headers = h || {}; },
      end(p) { if (p) this.body = p.toString(); resolve({ status: this.statusCode, body: this.body }); },
    };
    app.handle(req, res);
  });
}
const sessionCookie = (db, userId) => `hk_session=${createSession(db, userId, { ttlDays: 7, now: new Date(NOW) }).token}`;

test('★ GET /api/leaderboard/:stageId?scope=rank 返回 A 榜并把 P2 的降级告警带上来', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/st_1?scope=rank');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.scope, 'rank');
  assert.deepEqual(data.rows.map((r) => r.teamId), ['t_a', 't_b', 't_c', 't_d']);
  assert.equal(data.rows[0].rank, 1);
  assert.ok(data.warnings.length > 0);
  assert.ok(data.warnings.some((w) => w.code === 'judge_sample_too_small'), '降级告警必须显式带上来');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ B 榜响应体不含评分与签字人；名次积分按任务包内排名发放', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/st_1?scope=business');
  assert.equal(res.status, 200);
  const row = JSON.parse(res.body).rows.find((r) => r.teamId === 't_a');
  assert.equal(row.milestones.length, 3);
  assert.equal(row.milestones[0].achieved, true);
  for (const k of ['signatory', 'signatoryUserId', 'score', 'seatE', 'enterpriseName']) {
    assert.equal(row[k], undefined, `${k} 不应出现在 B 榜`);
  }
  assert.ok(!res.body.includes('A队队长'), '响应体不得出现签字人姓名');

  const rank = JSON.parse((await call(app, 'GET', '/api/leaderboard/st_1?scope=rank')).body);
  const byId = Object.fromEntries(rank.rows.map((r) => [r.teamId, r]));
  assert.equal(byId.t_a.points, 10);   // tp_1 内第 1 席
  assert.equal(byId.t_b.points, 8);    // tp_1 内第 2 席
  assert.equal(byId.t_c.points, 10);   // tp_2 内第 1 席
  assert.equal(byId.t_d.points, 8);    // tp_2 内第 2 席
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 三态：列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403；非法 scope → 400', async () => {
  const { db, close, dataDir, rules, app } = setup();
  const empty = await call(app, 'GET', '/api/leaderboard/st_2?scope=rank');
  assert.equal(empty.status, 200);
  assert.deepEqual(JSON.parse(empty.body).rows, []);
  assert.equal((await call(app, 'GET', '/api/leaderboard/st_nope?scope=rank')).status, 404);
  assert.equal((await call(app, 'GET', '/api/leaderboard/st_1?scope=whatever')).status, 400);

  const broken = structuredClone(rules);
  broken.visibility.rank.public = false;
  const app2 = createApp({ db, rules: broken, webDir: join(here, '..', 'web') });
  assert.equal((await call(app2, 'GET', '/api/leaderboard/st_1?scope=rank')).status, 403);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/leaderboard/rolling 走滚动总榜（不被 :stageId 抢走）', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.scope, 'rolling');
  assert.equal(data.rows.length, 4);
  assert.ok(data.rows[0].points >= data.rows[3].points);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ C-02：非成员看不到 D 段队伍的段位（404），C 段及以上公开；本人看得到无名次进度卡', async () => {
  const { db, close, dataDir, app } = setup();
  const cookie = sessionCookie(db, 'u_obs');
  assert.equal((await call(app, 'GET', '/api/teams/t_d/tier', { cookie })).status, 404, 'D 段不公示 → 外部读者 404');
  const shown = await call(app, 'GET', '/api/teams/t_a/tier', { cookie });
  assert.equal(shown.status, 200);
  const data = JSON.parse(shown.body);
  assert.equal(data.tier, 'A');
  assert.deepEqual(data.neverUnlocks, ['奖金', '决赛名次']);

  const self = JSON.parse((await call(app, 'GET', '/api/teams/t_d/tier', { cookie: sessionCookie(db, 'u_d') })).body);
  assert.equal(self.tier, 'D');
  assert.equal(self.tierRank, undefined, '本人进度卡不含名次');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 战绩卡：里程碑勾选式 + 企业签字标识，不显示签字人', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/teams/t_a/performance-card', { cookie: sessionCookie(db, 'u_cap') });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 3);
  assert.equal(data.items[0].signed, true, '有企业签字 → 标识为已签');
  assert.equal(data.items[0].signatory, undefined);
  assert.ok(!res.body.includes('A队队长'));
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 观察员不能发榜（403）；发榜写快照+审计+积分流水且幂等', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_obs', now: NOW }),
    (err) => err.status === 403,
  );
  const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
  assert.equal(Object.keys(out.snapshots).length, 3, 'rank / business / personal 各一份快照');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leaderboard_snapshots').get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'leaderboard.publish'").get().n, 1);
  const ledger1 = db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
  assert.ok(ledger1 > 0, '名次积分要写进流水');
  publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n, ledger1,
    '重复发榜不得重复发分');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 服务层返回体不含互评来源与行为分明细', () => {
  const { db, close, dataDir } = setup();
  const out = getLeaderboard({ db, stageId: 'st_1', scope: 'rank', viewer: null });
  const row = out.rows.find((r) => r.teamId === 't_b');
  assert.equal(row.peerScore, undefined);
  assert.equal(row.behaviorScore, undefined);
  assert.equal(row.fromTeamId, undefined);
  close(); rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/leaderboard-service.test.js` → Expected: FAIL —— `Cannot find module '../src/services/leaderboard.js'`

- [ ] **Step 3: 接入 src/errors.js 与创建三个仓储文件**

`platform/src/errors.js` 由 **P1 的 Task 3 建立**，本阶段**只复用、不重建**（重建会产生两套参数顺序相反的错误构造器）：
```javascript
// src/errors.js — 由 P1 建立，P3 直接 import（不复制、不改）
// 签名：appError(status, code, message, detail)
//   ⚠️ 参数顺序是 status 在前。P3 文末偏差表里原本写的 appError(code, message, status)
//      已统一为 status-first，与 P1/P4 一致。
import { AppError, appError } from '../errors.js';
```

**本阶段所有 `new AppError(...)` 调用一律用 status-first 顺序**：`new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在')`。

`platform/src/db/repo/leaderboard.js`：

```javascript
// src/db/repo/leaderboard.js — 榜单相关 SQL
// 依据：INTERFACES.md §0「数据层」条——所有 SQL 收在 src/db/repo/，service/handler 内禁止裸 SQL。
import { randomUUID } from 'node:crypto';

export function getStage(db, stageId) {
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId) ?? null;
}

export function listEditionStages(db, editionId) {
  return db.prepare('SELECT * FROM stages WHERE edition_id = ? ORDER BY key ASC').all(editionId);
}

export function listStageResults(db, stageId) {
  return db.prepare(`
    SELECT sr.id, sr.stage_id, sr.team_id, sr.rank, sr.total, sr.seat_p, sr.seat_e,
           sr.tied_with, sr.points, sr.computation_id, sr.created_at,
           t.name AS team_name, t.task_package_id, t.edition_id
    FROM stage_results sr JOIN teams t ON t.id = sr.team_id
    WHERE sr.stage_id = ? ORDER BY sr.rank ASC, sr.team_id ASC`).all(stageId);
}

export function getTeam(db, teamId) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(teamId) ?? null;
}

export function listTeamMembers(db, teamId) {
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL').all(teamId);
}

export function listTeamIdsByUser(db, userId) {
  if (!userId) return [];
  return db.prepare('SELECT team_id FROM team_members WHERE user_id = ? AND left_at IS NULL')
    .all(userId).map((r) => r.team_id);
}

export function isTeamMember(db, teamId, userId) {
  if (!userId) return false;
  return Boolean(db.prepare(
    'SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL',
  ).get(teamId, userId));
}

export function listUserNames(db, userIds) {
  const ids = (Array.isArray(userIds) ? userIds : []).filter(Boolean);
  if (!ids.length) return {};
  const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const out = {};
  for (const r of rows) out[r.id] = r.name;
  return out;
}

/** 互评分：队伍收到的互评均分（破同分链第 3 项） */
export function listPeerScoreTotals(db, stageId) {
  return db.prepare(`SELECT to_team_id AS team_id, AVG(score) AS peer_score, COUNT(*) AS n
    FROM peer_reviews WHERE stage_id = ? GROUP BY to_team_id`).all(stageId);
}

/** 企业确认原始分：队伍的企业确认均分（破同分链第 4 项） */
export function listEnterpriseRawTotals(db, stageId) {
  return db.prepare(`SELECT team_id, AVG(raw_score) AS enterprise_raw, COUNT(*) AS n
    FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL GROUP BY team_id`).all(stageId);
}

/** 加时陈述复议分（破同分链第 2 项，仅决赛） */
export function listTiebreakVoteTotals(db, stageId) {
  return db.prepare(`SELECT v.team_id, AVG(v.score) AS tiebreak_extra, COUNT(*) AS n
    FROM tiebreak_votes v JOIN tiebreak_round r ON r.id = v.tiebreak_round_id
    WHERE r.stage_id = ? GROUP BY v.team_id`).all(stageId);
}

/** 最近一次计算快照：降级告警的来源（P2 写，P3 读） */
export function getLatestComputation(db, stageId) {
  return db.prepare(`SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = 'stage_score'
    ORDER BY revision DESC, created_at DESC LIMIT 1`).get(stageId) ?? null;
}

export function insertSnapshot(db, { id, editionId, stageId, scope, payloadJson, createdAt }) {
  db.prepare('INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, editionId, stageId ?? null, scope, payloadJson, createdAt);
}

export function insertAuditLog(db, { id = randomUUID(), actorId, action, entity, entityId, detailJson, createdAt }) {
  db.prepare('INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, actorId ?? null, action, entity ?? null, entityId ?? null, detailJson ?? null, createdAt);
}
```

`platform/src/db/repo/points.js`：

```javascript
// src/db/repo/points.js — 积分流水与行为分事件 SQL
// 依据：INTERFACES.md §0「追加式」条——评分/积分类记录只增不改，更正走新记录。
export function insertLedgerEntry(db, { id, editionId, stageId, teamId, userId, kind, points, createdAt }) {
  db.prepare(`INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, editionId, stageId ?? null, teamId ?? null, userId ?? null, kind, points, createdAt);
}

export function listLedgerByEdition(db, editionId) {
  return db.prepare('SELECT * FROM points_ledger WHERE edition_id = ? ORDER BY created_at ASC, id ASC').all(editionId);
}

export function listLedgerByStage(db, stageId) {
  return db.prepare('SELECT * FROM points_ledger WHERE stage_id = ? ORDER BY created_at ASC, id ASC').all(stageId);
}

export function insertBehaviorEvent(db, { id, teamId, userId, type, points, evidence, createdAt }) {
  db.prepare(`INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, teamId, userId ?? null, type, points, evidence ?? null, createdAt);
}

/** ★ 行为分的数据源：独立表，绝不从 stage_results 派生 */
export function listBehaviorEventsByTeams(db, teamIds) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM behavior_events WHERE team_id IN (${ids.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC`).all(...ids);
}
```

`platform/src/db/repo/tiers.js`：

```javascript
// src/db/repo/tiers.js — 段位记录、里程碑与企业签字 SQL
export function insertTierRecord(db, { id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt }) {
  db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count,
    reasons_json, computed_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)`)
    .run(id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt);
}

export function getLatestTierRecord(db, teamId) {
  return db.prepare(`SELECT * FROM tier_records WHERE team_id = ? AND deleted_at IS NULL
    ORDER BY computed_at DESC, id DESC LIMIT 1`).get(teamId) ?? null;
}

/** 每支队伍最新的一条段位记录 */
export function listLatestTiersByEdition(db, editionId) {
  const rows = db.prepare(`SELECT tr.* FROM tier_records tr JOIN teams t ON t.id = tr.team_id
    WHERE t.edition_id = ? AND tr.deleted_at IS NULL ORDER BY tr.computed_at ASC, tr.id ASC`).all(editionId);
  const latest = new Map();
  for (const r of rows) latest.set(r.team_id, r);
  return [...latest.values()];
}

export function listMilestonesByTeam(db, teamId) {
  return db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY fixed_at ASC, key ASC').all(teamId);
}

export function listMilestonesByTeams(db, teamIds) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM milestones WHERE team_id IN (${ids.map(() => '?').join(',')})
    ORDER BY fixed_at ASC, key ASC`).all(...ids);
}

export function listSignoffsByTeam(db, teamId) {
  return db.prepare(`SELECT s.* FROM milestone_signoffs s JOIN milestones m ON m.id = s.milestone_id
    WHERE m.team_id = ? ORDER BY s.signed_at ASC`).all(teamId);
}

export function listSignoffsByTeams(db, teamIds) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare(`SELECT s.* FROM milestone_signoffs s JOIN milestones m ON m.id = s.milestone_id
    WHERE m.team_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.signed_at ASC`).all(...ids);
}
```

- [ ] **Step 4: 创建 src/services/leaderboard.js**

```javascript
// src/services/leaderboard.js — 榜单用例编排
// 依据：设计文档 §6.3 / §6.6 + 任务书 §七 + R-RNK-01/02/03/04
//   ⛔ 双榜并列不合成一个总分：A 榜（名次/奖金/MVP）与 B 榜（商业战绩/完赛/资源解锁）
//      走两条不同的表、两条不同的计算路径，任何一条都不读另一条的分数字段。
//   ⛔ 可见性在 API 层过滤：本模块【读】原始 payload，【写】快照；对外一律走 applyVisibility。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getDefaultRules } from '../config.js';
import { rankTeams } from '../domain/ranking.js';
import { computeStagePoints, computeMvp, computePersonalPoints } from '../domain/points.js';
import { behaviorScore } from '../domain/behavior.js';
import { applyVisibility } from '../domain/visibility.js';
import { cmpStr } from '../domain/util.js';
import * as repo from '../db/repo/leaderboard.js';
import * as pointsRepo from '../db/repo/points.js';
import * as tierRepo from '../db/repo/tiers.js';

const SCOPES = ['rank', 'business', 'personal'];
const indexBy = (rows, k, v) => Object.fromEntries(rows.map((r) => [r[k], r[v]]));

/** ★ 行为分独立通路：behavior_events → behaviorScore。绝不从 stage_results 派生。 */
function behaviorScoresByTeam(db, teamIds, R) {
  const out = {};
  const events = pointsRepo.listBehaviorEventsByTeams(db, teamIds);
  if (!events.length) return out;
  const byTeam = new Map();
  for (const e of events) {
    if (!byTeam.has(e.team_id)) byTeam.set(e.team_id, []);
    byTeam.get(e.team_id).push(e);
  }
  const behaviorConfig = { ...(R.behavior || {}), evidenceRequirements: R.criteria?.behaviorEvidence || undefined };
  for (const [teamId, list] of byTeam) out[teamId] = behaviorScore({ events: list, behaviorConfig }).total;
  return out;
}

/** 单赛段的完整排名计算（名次 + 包内积分 + 告警），A 榜与滚动总榜共用 */
function buildStageRanking({ db, stage, R }) {
  const results = repo.listStageResults(db, stage.id);
  const peerTotals = indexBy(repo.listPeerScoreTotals(db, stage.id), 'team_id', 'peer_score');
  const entTotals = indexBy(repo.listEnterpriseRawTotals(db, stage.id), 'team_id', 'enterprise_raw');
  const extraTotals = indexBy(repo.listTiebreakVoteTotals(db, stage.id), 'team_id', 'tiebreak_extra');
  const behaviorTotals = behaviorScoresByTeam(db, results.map((r) => r.team_id), R);

  const candidates = results.map((r) => ({
    teamId: r.team_id,
    total: r.total,
    seatP: r.seat_p,
    seatE: r.seat_e,
    peerScore: peerTotals[r.team_id] ?? null,
    enterpriseRaw: entTotals[r.team_id] ?? null,
    behaviorScore: behaviorTotals[r.team_id] ?? null,
    tiebreakExtra: extraTotals[r.team_id] ?? null,
  }));
  const byTeam = Object.fromEntries(candidates.map((c) => [c.teamId, {
    peerScore: c.peerScore, enterpriseRaw: c.enterpriseRaw,
    behaviorScore: c.behaviorScore, tiebreakExtra: c.tiebreakExtra,
  }]));

  const isFinal = stage.scoring_config_key === 'final';
  const tiebreakData = { isFinal, byTeam };
  const ranking = rankTeams({
    teams: candidates, tiebreakChain: R.tiebreak?.chain || [], tiebreakData, pointsConfig: R.points,
  });

  // ★ 名次积分按【任务包内】排名发放（设计文档 §6.3「任务包内全量战队排名」）
  const packageOf = new Map(results.map((r) => [r.team_id, r.task_package_id]));
  const groups = new Map();
  for (const c of candidates) {
    const key = packageOf.get(c.teamId) ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const points = {};
  const packageRank = {};
  for (const [, group] of groups) {
    const ranked = rankTeams({
      teams: group, tiebreakChain: R.tiebreak?.chain || [], tiebreakData, pointsConfig: R.points,
    });
    for (const p of computeStagePoints({ ordered: ranked.ordered, pointsConfig: R.points })) points[p.teamId] = p.points;
    for (const o of ranked.ordered) packageRank[o.teamId] = o.rank;
  }
  return { results, ranking, points, packageRank, warnings: collectWarnings({ db, stage, ranking }) };
}

/** 降级告警：来自 P2 的计算快照 + 破同分链自身的告警（绝不静默） */
function collectWarnings({ db, stage, ranking }) {
  const out = [];
  const snap = repo.getLatestComputation(db, stage.id);
  if (!snap) {
    out.push({ source: 'computation', code: 'NO_COMPUTATION_SNAPSHOT',
      message: '本赛段尚无计算快照，当前榜单可能不是最终结果' });
  } else {
    try {
      for (const w of JSON.parse(snap.output_json || '{}').warnings || []) out.push({ source: 'computation', ...w });
    } catch {
      out.push({ source: 'computation', code: 'SNAPSHOT_PARSE_FAILED',
        message: '计算快照无法解析，榜单已降级展示，请人工核对' });
    }
  }
  for (const w of ranking.warnings) out.push({ source: 'tiebreak', ...w });
  return out;
}

function buildRankPayload({ db, stage, R }) {
  const built = buildStageRanking({ db, stage, R });
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, stage.edition_id), 'team_id', 'tier');
  const rows = built.ranking.ordered.map((row) => {
    const res = built.results.find((r) => r.team_id === row.teamId);
    return {
      teamId: row.teamId,
      teamName: res?.team_name ?? null,
      taskPackageId: res?.task_package_id ?? null,
      rank: row.rank,
      tiedWith: row.tiedWith,
      packageRank: built.packageRank[row.teamId] ?? null,
      points: built.points[row.teamId] ?? 0,
      total: row.total,
      tier: tiers[row.teamId] ?? 'D',
      enterpriseName: null,   // ⛔ 企业名不公示（S10 §8）
      // ⛔ 评分构成（seatP / seatE / peerScore / behaviorScore）不进公开榜，
      //    需要的人看 P4 的 trace 抽屉（按权限）。
    };
  });
  return {
    scope: 'rank', stageId: stage.id, editionId: stage.edition_id, rows,
    warnings: built.warnings, rankStyle: built.ranking.rankStyle, tiebreakApplied: built.ranking.applied,
  };
}

function buildBusinessPayload({ db, stage }) {
  const results = repo.listStageResults(db, stage.id);
  const milestones = tierRepo.listMilestonesByTeams(db, results.map((r) => r.team_id));
  const signoffs = tierRepo.listSignoffsByTeams(db, results.map((r) => r.team_id));
  const rows = results.map((r) => {
    const ms = milestones.filter((m) => m.team_id === r.team_id);
    const ids = new Set(ms.map((m) => m.id));
    const signed = new Set(signoffs.filter((s) => ids.has(s.milestone_id) && !s.revoked_at).map((s) => s.milestone_id));
    return {
      teamId: r.team_id,
      teamName: r.team_name,
      taskPackageId: r.task_package_id,
      milestones: ms.map((m) => ({ key: m.key, label: m.label, achieved: signed.has(m.id), signed: signed.has(m.id) })),
      achievedCount: signed.size,
      milestoneCount: ms.length,
      // ⛔ 这里【不】放任何评分与签字人：评分与签字人不公开（S10 §0.3 / R-ENT-04）
    };
  });
  return { scope: 'business', stageId: stage.id, editionId: stage.edition_id, rows, warnings: [] };
}

function buildPersonalPayload({ db, stage, R }) {
  const ledger = pointsRepo.listLedgerByEdition(db, stage.edition_id);
  const personal = computePersonalPoints({ ledger, pointsConfig: R.points });
  const names = repo.listUserNames(db, personal.rows.map((r) => r.userId));
  const rows = personal.rows.map((r) => ({
    userId: r.userId, name: names[r.userId] ?? null, total: r.total, rank: r.rank, byKind: r.byKind,
  }));
  return { scope: 'personal', stageId: stage.id, editionId: stage.edition_id, rows, warnings: [] };
}

const buildPayload = ({ db, stage, scope, rules: R }) => (scope === 'rank'
  ? buildRankPayload({ db, stage, R })
  : scope === 'business' ? buildBusinessPayload({ db, stage }) : buildPersonalPayload({ db, stage, R }));

/** 对外读接口：先算原始 payload，再在 API 层过滤 */
export function getLeaderboard({ db, stageId, scope = 'rank', viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  if (!SCOPES.includes(scope)) throw new AppError(400, 'INVALID_SCOPE', `榜单口径非法：${scope}`);
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  if (scope === 'rank' && R.visibility?.rank?.public === false) {
    throw new AppError(403, 'LEADERBOARD_DISABLED', '该赛段榜单已关闭');
  }
  if (scope === 'business' && R.visibility?.business?.milestoneProgressPublic === false) {
    throw new AppError(403, 'LEADERBOARD_DISABLED', '该赛段 B 榜已关闭');
  }
  return applyVisibility({
    payload: buildPayload({ db, stage, scope, rules: R }),
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope,
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: (R.ranks?.tiers || []).map((t) => t.key),
    },
  });
}

/** 滚动总榜：全程公开（任务书 §七 明文） */
export function getRollingLeaderboard({ db, editionId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  if (R.visibility?.rank?.public === false) throw new AppError(403, 'LEADERBOARD_DISABLED', '总榜已关闭');
  const stages = repo.listEditionStages(db, editionId);
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, editionId), 'team_id', 'tier');
  const totals = new Map();

  for (const stage of stages) {
    const built = buildStageRanking({ db, stage, R });
    if (!built.results.length) continue;
    for (const row of built.ranking.ordered) {
      const res = built.results.find((r) => r.team_id === row.teamId);
      const cur = totals.get(row.teamId) || {
        teamId: row.teamId, teamName: res?.team_name ?? null, taskPackageId: res?.task_package_id ?? null,
        points: 0, stages: 0, bestRank: null,
      };
      cur.points += built.points[row.teamId] ?? 0;
      cur.stages += 1;
      cur.bestRank = cur.bestRank === null ? row.rank : Math.min(cur.bestRank, row.rank);
      totals.set(row.teamId, cur);
    }
  }

  const rows = [...totals.values()]
    .map((r) => ({ ...r, tier: tiers[r.teamId] ?? 'D' }))
    .sort((a, b) => b.points - a.points || (a.bestRank ?? 99) - (b.bestRank ?? 99) || cmpStr(a.teamId, b.teamId));

  return applyVisibility({
    payload: {
      scope: 'rolling', editionId, rows, warnings: [],
      stages: stages.map((s) => ({ id: s.id, key: s.key, name: s.name })),
    },
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope: 'rank',   // 滚动总榜与 A 榜同口径：全员公开
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: (R.ranks?.tiers || []).map((t) => t.key),
    },
  });
}

/** 发榜：显式动作。写快照 + 审计日志 + 积分流水（追加式 + 幂等）。 */
export function publishLeaderboard({ db, editionId, stageId, actorId, now }) {
  const R = getDefaultRules();
  const user = getUserById(db, actorId);
  if (!can(user, 'stage:compute', { scopeType: 'edition', scopeId: editionId }, db)) {
    throw new AppError(403, 'FORBIDDEN', '无发榜权限');
  }
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const createdAt = now ?? new Date().toISOString();

  const snapshots = {};
  for (const scope of SCOPES) {
    const payload = buildPayload({ db, stage, scope, rules: R });   // 原始快照（内部可见）
    const id = randomUUID();
    repo.insertSnapshot(db, { id, editionId, stageId, scope, payloadJson: JSON.stringify(payload), createdAt });
    snapshots[scope] = { id, scope, createdAt };
  }

  const awarded = {
    stage: awardStagePoints({ db, editionId, stageId, rules: R, createdAt }),
    mvp: awardMvp({ db, editionId, stageId, rules: R, createdAt }),
  };
  repo.insertAuditLog(db, {
    id: randomUUID(), actorId, action: 'leaderboard.publish', entity: 'stage', entityId: stageId,
    detailJson: JSON.stringify({ editionId, stageId, snapshots, awarded }), createdAt,
  });
  return { editionId, stageId, snapshots, awarded, createdAt };
}

/** 名次积分写入流水：只增不改 + 幂等（同一赛段同一队伍不重复发） */
function awardStagePoints({ db, editionId, stageId, rules: R, createdAt }) {
  const built = buildStageRanking({ db, stage: repo.getStage(db, stageId), R });
  const existing = new Set(pointsRepo.listLedgerByStage(db, stageId).map((r) => `${r.team_id}|${r.kind}`));
  const awarded = [];
  for (const row of built.ranking.ordered) {
    const pts = built.points[row.teamId] ?? 0;
    if (!pts) continue;
    if (existing.has(`${row.teamId}|stage_rank`)) continue;    // 幂等
    for (const m of repo.listTeamMembers(db, row.teamId)) {
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId: row.teamId, userId: m.user_id,
        kind: 'stage_rank', points: pts, createdAt,
      });
    }
    awarded.push({ teamId: row.teamId, points: pts });
  }
  return awarded;
}

/** MVP：4 赛段总积分 + S4 路演评审综合，每任务包 1 个（写入个人积分流水） */
function awardMvp({ db, editionId, stageId, rules: R, createdAt }) {
  const stages = repo.listEditionStages(db, editionId);
  const roadshowStage = stages.find((s) => s.kind === 'roadshow');
  const stagePoints = [];
  const packageOf = new Map();
  for (const stage of stages) {
    if (stage.kind === 'roadshow') continue;
    const built = buildStageRanking({ db, stage, rules: R });
    for (const row of built.ranking.ordered) {
      const res = built.results.find((r) => r.team_id === row.teamId);
      stagePoints.push({ teamId: row.teamId, stageId: stage.key, points: built.points[row.teamId] ?? 0 });
      packageOf.set(row.teamId, res?.task_package_id ?? null);
    }
  }
  if (!stagePoints.length) return [];

  const roadshowScores = roadshowStage
    ? repo.listStageResults(db, roadshowStage.id).map((r) => ({ teamId: r.team_id, score: r.total }))
    : [];
  const byPackage = new Map();
  for (const p of stagePoints) {
    const key = packageOf.get(p.teamId) ?? '__none__';
    if (!byPackage.has(key)) byPackage.set(key, []);
    byPackage.get(key).push(p);
  }

  const existing = new Set(pointsRepo.listLedgerByStage(db, stageId).map((r) => `${r.team_id}|${r.kind}`));
  const awarded = [];
  for (const [pkgId, points] of byPackage) {
    const out = computeMvp({ stagePoints: points, roadshowScores, packageId: pkgId, pointsConfig: rules.points });
    if (!out.mvp) continue;
    const teamId = out.mvp.teamId;
    if (existing.has(`${teamId}|mvp`)) continue;    // 幂等
    // MVP 积分口径：rules/criteria.mvp.awardPointsSource = 'stage_points_sum'
    const awardPoints = points.filter((p) => p.teamId === teamId).reduce((s, p) => s + (Number(p.points) || 0), 0);
    for (const m of repo.listTeamMembers(db, teamId)) {
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId, userId: m.user_id,
        kind: 'mvp', points: awardPoints, createdAt,
      });
    }
    awarded.push({ teamId, packageId: pkgId, points: awardPoints });
  }
  return awarded;
}
```

- [ ] **Step 5: 创建 src/services/performance-card.js 与 src/services/tier.js**

`platform/src/services/performance-card.js`：

```javascript
// src/services/performance-card.js — 项目商业战绩卡
// 依据：设计文档 §9 关键界面「7 类里程碑勾选式 + 企业签字标识 + 不显示签字人」
//   + S10 §4 商业里程碑 7 类 + R-ENT-04「B 榜签字不公开」
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getDefaultRules } from '../config.js';
import * as repo from '../db/repo/leaderboard.js';
import * as tierRepo from '../db/repo/tiers.js';

export function getPerformanceCard({ db, teamId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  const team = repo.getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const isMember = viewer ? repo.isTeamMember(db, teamId, viewer.id) : false;
  const isAdmin = viewer ? viewer.is_superadmin === 1 : false;
  if (!isMember && !isAdmin && !can(viewer, 'team:read', { scopeType: 'team', scopeId: teamId }, db)) {
    throw new AppError(404, 'NOT_FOUND', '战队不存在');   // 单条不满足 → 404
  }
  const milestones = tierRepo.listMilestonesByTeam(db, teamId);
  const signoffs = tierRepo.listSignoffsByTeam(db, teamId);
  const items = milestones.map((m) => {
    const sg = signoffs.find((s) => s.milestone_id === m.id && !s.revoked_at);
    return {
      key: m.key, label: m.label, achieved: Boolean(sg), signed: Boolean(sg),
      // ⛔ 不返回签字人：签字人不公开（S10 §0.3 / R-ENT-04）
    };
  });
  const record = tierRepo.getLatestTierRecord(db, teamId);
  const tier = record?.tier ?? 'D';
  return {
    teamId, teamName: team.name, taskPackageId: team.task_package_id ?? null,
    items, achievedCount: items.filter((i) => i.achieved).length, total: items.length,
    tier, benefits: (R.ranks?.benefits || {})[tier] || [], neverUnlocks: R.ranks?.neverUnlocks || [],
  };
}
```

`platform/src/services/tier.js`：

```javascript
// src/services/tier.js — 队伍段位查询
// 依据：S10 §2.2 段位表 + §2.3 权益 + 冲突裁决 C-02（公示范围）
import { AppError } from '../errors.js';
import { getDefaultRules } from '../config.js';
import { cmpStr } from '../domain/util.js';
import * as repo from '../db/repo/leaderboard.js';
import * as tierRepo from '../db/repo/tiers.js';

export function getTeamTier({ db, teamId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  const team = repo.getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const tiers = R.ranks?.tiers || [];
  const order = tiers.map((t) => t.key);
  const record = tierRepo.getLatestTierRecord(db, teamId);
  const tier = record?.tier ?? 'D';
  const idx = Math.max(0, order.indexOf(tier));
  const publicFromIdx = Math.max(0, order.indexOf(R.visibility?.rank?.publicFromTier || 'C'));
  const isPublic = idx >= publicFromIdx;
  const isMember = viewer ? repo.isTeamMember(db, teamId, viewer.id) : false;
  const isAdmin = viewer ? viewer.is_superadmin === 1 : false;
  if (!isPublic && !isMember && !isAdmin) {
    // D 段不公示排名 → 外部读者拿不到（单条不满足 → 404）
    throw new AppError(404, 'NOT_FOUND', '战队不存在');
  }
  const milestones = tierRepo.listMilestonesByTeam(db, teamId);
  const out = {
    teamId, teamName: team.name, tier, tierName: tiers.find((t) => t.key === tier)?.name ?? tier,
    benefits: (R.ranks?.benefits || {})[tier] || [], neverUnlocks: R.ranks?.neverUnlocks || [],
    reasons: record?.reasons_json ? JSON.parse(record.reasons_json) : [],
    progress: {
      milestones: milestones.map((m) => ({ key: m.key, label: m.label })),
      milestoneCount: record?.milestone_count ?? 0,
    },
  };
  if (isPublic) out.tierRank = tierBoardRank(db, team, order);   // C 段及以上公示名次（C-02）
  else out.self = true;                                            // 本人进度卡：不含名次
  return out;
}

function tierBoardRank(db, team, order) {
  const board = [...tierRepo.listLatestTiersByEdition(db, team.edition_id)].sort((a, b) => {
    const ia = order.indexOf(a.tier);
    const ib = order.indexOf(b.tier);
    if (ia !== ib) return ib - ia;                    // 段位高的在前
    if (a.milestone_count !== b.milestone_count) return b.milestone_count - a.milestone_count;
    return cmpStr(a.team_id, b.team_id);              // 确定性兜底
  });
  const idx = board.findIndex((t) => t.team_id === team.id);
  return idx < 0 ? null : idx + 1;
}
```

- [ ] **Step 6: 修改 src/server.js（注册 4 个 P3 路由）**

顶部 import 区追加：

```javascript
import { AppError } from './errors.js';
import { getLeaderboard, getRollingLeaderboard } from './services/leaderboard.js';
import { getPerformanceCard } from './services/performance-card.js';
import { getTeamTier } from './services/tier.js';
```

`createApp` 内、`router.add('GET', '/api/me', ...)` 之后追加：

```javascript
  // ── P3 榜单与积分 ───────────────────────────────────────────
  // ⚠️ 路由顺序由 P0 的 router 按「参数段数量降序」排序：
  //    /api/leaderboard/rolling（0 参）先于 /api/leaderboard/:stageId（1 参）匹配，
  //    所以 "rolling" 不会被当成 stageId。
  router.add('GET', '/api/leaderboard/rolling', async (ctx) => {
    const editionId = ctx.query.editionId;
    if (!editionId) throw new AppError(400, 'MISSING_PARAM', '缺少 editionId');
    return getRollingLeaderboard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/leaderboard/:stageId', async (ctx) => {
    const scope = ctx.query.scope || 'rank';
    return getLeaderboard({ db: ctx.db, stageId: ctx.params.stageId, scope, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/teams/:id/performance-card', async (ctx) => {
    return getPerformanceCard({ db: ctx.db, teamId: ctx.params.id, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/teams/:id/tier', async (ctx) => {
    return getTeamTier({ db: ctx.db, teamId: ctx.params.id, viewer: ctx.user, rules: ctx.rules });
  });
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/leaderboard-service.test.js` → Expected: PASS（9 个测试全过）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/errors src/db/repo src/services src/server.js test/leaderboard-service.test.js
git commit -m "feat(P3): 榜单服务、战绩卡与 4 个榜单 API"
```

---

### Task 8: 前端榜单页 + 段位榜 + 战绩卡 + 回归验收

**Files:**
- Create: `platform/web/views/leaderboard.js`、`platform/web/views/tier.js`、`platform/web/views/card.js`、`platform/test/leaderboard-web.test.js`
- Modify: `platform/web/app.js`（注册路由 + query 透传）、`platform/web/api.demo.js`（演示版补 P3 接口）

**Interfaces:**
- Consumes: Task 7 的 4 个 API
- Produces: `leaderboardHtml(model)` / `tierHtml(model)` / `cardHtml(model)` → HTML 字符串（纯函数，可单测）；路由 `#/leaderboard`（滚动总榜）｜`#/leaderboard/:stageId`（赛段榜）｜`#/tier`（段位榜）｜`#/card/:teamId`（战绩卡）

> ⛔ **前端只渲染，不做过滤**（可见性已在 API 层完成）。
> ⛔ **降级告警置顶**：P2 计算出的 warnings 必须显式展示在榜单页顶部，不静默。

- [ ] **Step 1: 写失败的测试**

`platform/test/leaderboard-web.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaderboardHtml } from '../web/views/leaderboard.js';
import { tierHtml } from '../web/views/tier.js';
import { cardHtml } from '../web/views/card.js';

const here = dirname(fileURLToPath(import.meta.url));

test('★ 降级告警置顶：warnings 出现在榜单之前', () => {
  const html = leaderboardHtml({
    scope: 'rank',
    warnings: [{ code: 'judge_sample_too_small', message: '本轮该维度未做评委宽严归一化（样本不足 5）' }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  assert.ok(html.includes('judge_sample_too_small'), '告警必须渲染');
  assert.ok(html.indexOf('judge_sample_too_small') < html.indexOf('A队'), '告警必须排在榜单之前（置顶）');
});

test('榜单渲染并列名次与积分；队名必须转义', () => {
  const html = leaderboardHtml({
    scope: 'rank', warnings: [],
    rows: [
      { teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A', tiedWith: ['t_b'] },
      { teamId: 't_b', teamName: 'B队', rank: 1, total: 90, points: 8, tier: 'A', tiedWith: ['t_a'] },
      { teamId: 't_x', teamName: '<img src=x onerror=alert(1)>', rank: 2, total: 80, points: 0, tier: 'D' },
    ],
  });
  assert.ok(html.includes('A队'));
  assert.ok(html.includes('B队'));
  assert.ok(html.includes('10'));
  assert.ok(html.includes('8'));
  assert.ok(!html.includes('<img src=x'), '队名必须转义');
  assert.ok(html.includes('&lt;img'));
});

test('★ 段位榜：D 段不出现在榜单里；本人进度卡单独展示', () => {
  const html = tierHtml({
    rows: [{ teamId: 't_s', teamName: 'S队', tier: 'S', tierRank: 1 }, { teamId: 't_a', teamName: 'A队', tier: 'A', tierRank: 2 }],
    selfProgress: { teamId: 't_d', tier: 'D', progress: { milestones: [{ key: 'k', label: '企业问题确认' }] } },
  });
  assert.ok(html.includes('S队'));
  assert.ok(html.includes('A队'));
  assert.ok(!html.includes('D队'), 'D 段队名不得出现在段位榜');
  assert.ok(html.includes('本人进度'), 'D 段只给本人进度卡');
});

test('★ 战绩卡：里程碑勾选式 + 企业签字标识，不出现签字人字段', () => {
  const html = cardHtml({
    teamName: 'A队', tier: 'A',
    items: [
      { key: 'problem_confirmed', label: '企业问题确认', achieved: true, signed: true },
      { key: 'data_connected', label: '真实数据接入', achieved: false, signed: false },
    ],
    benefits: ['辅导期名额候选'], neverUnlocks: ['奖金', '决赛名次'],
  });
  assert.ok(html.includes('企业问题确认'));
  assert.ok(html.includes('真实数据接入'));
  assert.ok(html.includes('已签'), '企业签字标识要显示');
  assert.ok(!html.includes('signatory'), '不得渲染签字人字段');
  assert.ok(!html.includes('签字人'));
  assert.ok(html.includes('辅导期名额候选'));
});

test('前端不做过滤：渲染函数只输出 API 给的数据', () => {
  assert.ok(leaderboardHtml({ scope: 'rank', warnings: [], rows: [] }).includes('暂无数据'));
});

test('app.js 注册了榜单 / 段位 / 战绩卡路由', () => {
  const src = readFileSync(join(here, '..', 'web', 'app.js'), 'utf8');
  assert.ok(src.includes("route('/leaderboard"), '缺榜单路由');
  assert.ok(src.includes("route('/tier"), '缺段位路由');
  assert.ok(src.includes("route('/card/:teamId'"), '缺战绩卡路由');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/leaderboard-web.test.js` → Expected: FAIL —— `Cannot find module '../web/views/leaderboard.js'`

- [ ] **Step 3: 创建三个视图文件**

`platform/web/views/leaderboard.js`：

```javascript
// web/views/leaderboard.js — 榜单页（A 榜 / B 榜 / 个人榜 + 滚动总榜）
// ⛔ 前端只渲染，不做过滤：可见性已在 API 层完成。
// ⛔ 降级告警置顶：P2 计算出的 warnings 显式展示在最上方，不静默（S-5 / C-05）。
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function warningsHtml(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return '';
  const items = list.map((w) => `<li class="warn-item"><span class="warn-code">${escapeHtml(w.code || 'WARN')}</span> <span class="warn-msg">${escapeHtml(w.message || '')}</span></li>`).join('');
  return `<div class="warnings" role="alert"><h3>⚠ 本轮降级提示（${list.length}）</h3><ul>${items}</ul></div>`;
}

function rankRowsHtml(rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  const body = rows.map((r) => {
    const tied = Array.isArray(r.tiedWith) && r.tiedWith.length ? '（并列）' : '';
    const pkg = r.packageRank ? `包内第 ${escapeHtml(r.packageRank)} 名` : '';
    return `<tr><td class="rank">${escapeHtml(r.rank)}</td><td class="name">${escapeHtml(r.teamName || r.teamId)}${tied}</td>`
      + `<td class="total">${escapeHtml(r.total)}</td><td class="points">${escapeHtml(r.points)}</td>`
      + `<td class="tier">${escapeHtml(r.tier || '')}</td><td class="pkg">${pkg}</td></tr>`;
  }).join('');
  return `<table class="board"><thead><tr><th>名次</th><th>队伍</th><th>总分</th><th>积分</th><th>段位</th><th>包内</th></tr></thead><tbody>${body}</tbody></table>`;
}

function businessRowsHtml(rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  return `<div class="biz-grid">${rows.map((r) => {
    const items = (r.milestones || []).map((m) => `<li class="${m.achieved ? 'done' : 'todo'}"><span class="mark">${m.achieved ? '☑' : '☐'}</span>${escapeHtml(m.label)}</li>`).join('');
    return `<div class="card biz-card"><h3>${escapeHtml(r.teamName || r.teamId)}</h3><ul class="milestones">${items}</ul>`
      + `<p class="muted">达成 ${escapeHtml(r.achievedCount)} / ${escapeHtml(r.milestoneCount)}</p></div>`;
  }).join('')}</div>`;
}

function personalRowsHtml(rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  const body = rows.map((r) => `<tr><td class="rank">${escapeHtml(r.rank)}</td><td class="name">${escapeHtml(r.name || r.userId)}${r.isSelf ? '（我）' : ''}</td><td class="total">${escapeHtml(r.total)}</td></tr>`).join('');
  return `<table class="board"><thead><tr><th>名次</th><th>选手</th><th>个人积分</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** 纯函数渲染（可单测） */
export function leaderboardHtml(model) {
  const scope = model?.scope || 'rank';
  const body = scope === 'business' ? businessRowsHtml(model?.rows || [])
    : scope === 'personal' ? personalRowsHtml(model?.rows || [])
      : rankRowsHtml(model?.rows || []);
  const title = scope === 'business' ? 'B 榜 · 商业战绩' : scope === 'personal' ? '个人积分榜' : 'A 榜 · 赛段名次';
  return `<section class="board-view">${warningsHtml(model?.warnings)}<h2>${title}</h2>${body}</section>`;
}

/** 挂载（真实 API） */
export async function renderLeaderboard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  const stageId = ctx.params?.stageId || ctx.getState().stageId || '';
  const scope = ctx.query?.scope || 'rank';
  const url = stageId
    ? `/api/leaderboard/${encodeURIComponent(stageId)}?scope=${encodeURIComponent(scope)}`
    : `/api/leaderboard/rolling?editionId=${encodeURIComponent(ctx.query?.editionId || ctx.getState().editionId || '')}`;
  try {
    const data = await ctx.api.get(url);
    wrap.innerHTML = leaderboardHtml({ ...data, scope: stageId ? scope : 'rolling' });
  } catch (e) {
    wrap.innerHTML = `<section class="board-view"><p class="err">${escapeHtml(e.message)}</p></section>`;
  }
  return wrap;
}
```

`platform/web/views/tier.js`：

```javascript
// web/views/tier.js — 段位榜
// 依据：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡。
// ⛔ 前端不隐藏 D 段，而是【不渲染】它：D 段根本不会出现在 API 返回的 rows 里。
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function tierHtml(model) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const self = model?.selfProgress || null;
  const board = rows.length
    ? `<table class="board tier-board"><thead><tr><th>名次</th><th>队伍</th><th>段位</th></tr></thead><tbody>`
      + rows.map((r) => `<tr><td class="rank">${escapeHtml(r.tierRank)}</td><td class="name">${escapeHtml(r.teamName || r.teamId)}</td><td class="tier">${escapeHtml(r.tier)}</td></tr>`).join('')
      + `</tbody></table>`
    : '<p class="muted">暂无数据</p>';
  const selfCard = self
    ? `<div class="card self-progress"><h3>本人进度</h3><p>当前段位：<strong>${escapeHtml(self.tier)}</strong></p>`
      + `<ul>${(self.progress?.milestones || []).map((m) => `<li>${escapeHtml(m.label)}</li>`).join('')}</ul></div>`
    : '';
  return `<section class="tier-view"><h2>段位榜</h2>`
    + `<p class="muted">C 段及以上公示队名与名次；D 段只公示个人进度，不公示排名。</p>${board}${selfCard}</section>`;
}

export async function renderTier(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  try {
    wrap.innerHTML = tierHtml(await ctx.api.get('/api/leaderboard/tier'));
  } catch (e) {
    wrap.innerHTML = `<section class="tier-view"><p class="err">${escapeHtml(e.message)}</p></section>`;
  }
  return wrap;
}
```

`platform/web/views/card.js`：

```javascript
// web/views/card.js — 项目商业战绩卡
// 依据：设计文档 §9「7 类里程碑勾选式 + 企业签字标识 + 不显示签字人」
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function cardHtml(model) {
  const items = Array.isArray(model?.items) ? model.items : [];
  const list = items.map((m) => `<li class="${m.achieved ? 'done' : 'todo'}"><span class="mark">${m.achieved ? '☑' : '☐'}</span>`
    + `<span class="label">${escapeHtml(m.label)}</span>${m.signed ? '<span class="signed">已签</span>' : ''}</li>`).join('');
  const benefits = (model?.benefits || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  const never = (model?.neverUnlocks || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  return `<section class="card-view"><h2>${escapeHtml(model?.teamName || '')} · 商业战绩卡</h2>`
    + `<p class="muted">当前段位：<strong>${escapeHtml(model?.tier || '')}</strong></p>`
    + `<ul class="milestones">${list || '<li class="muted">暂无里程碑</li>'}</ul>`
    + `<p class="muted">达成 ${escapeHtml(model?.achievedCount)} / ${escapeHtml(model?.total)}</p>`
    + `<div class="benefits"><h3>已解锁权益</h3><ul>${benefits || '<li class="muted">暂无</li>'}</ul>`
    + `<h3>永不解锁</h3><ul>${never || '<li class="muted">暂无</li>'}</ul></div></section>`;
}

export async function renderCard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  try {
    const data = await ctx.api.get(`/api/teams/${encodeURIComponent(ctx.params?.teamId || '')}/performance-card`);
    wrap.innerHTML = cardHtml(data);
  } catch (e) {
    wrap.innerHTML = `<section class="card-view"><p class="err">${escapeHtml(e.message)}</p></section>`;
  }
  return wrap;
}
```

- [ ] **Step 4: 修改 web/app.js（注册路由 + query 透传）**

```javascript
import { renderLeaderboard } from './views/leaderboard.js';
import { renderTier } from './views/tier.js';
import { renderCard } from './views/card.js';
```

```javascript
route('/leaderboard', (c) => renderLeaderboard(c));
route('/leaderboard/:stageId', (c) => renderLeaderboard(c));
route('/tier', (c) => renderTier(c));
route('/card/:teamId', (c) => renderCard(c));
```

> ⚠️ P0 的 `web/app.js` 里 `render()` 只把 `found.view(ctx)` 的结果塞进 `#app`，没有把路由参数传给视图。
> 实现时把 `render()` 里的调用改成 `const el = await found.view({ ...ctx, params: found.params, query: currentQuery() });`，
> 并新增：
> ```javascript
> function currentQuery() {
>   const q = currentPath().split('?')[1] || '';
>   return Object.fromEntries(new URLSearchParams(q));
> }
> ```
> ⛔ P0 的 `web/router.js` 的 `match()` 会把 `?query` 剥掉再匹配（`path.split('?')[0]`），所以 query 要自己解析。

- [ ] **Step 5: 修改 web/api.demo.js（演示版补 P3 接口）**

在 `api.get` 里，把原来的 `if (path.startsWith('/api/leaderboard')) { return { rows: db.leaderboard || [], demo: true }; }` 替换为：

```javascript
    if (path.startsWith('/api/leaderboard/rolling')) {
      return { scope: 'rolling', rows: db.leaderboard || [], demo: true };
    }
    if (path.startsWith('/api/leaderboard/')) {
      const scope = new URL(path, 'http://x').searchParams.get('scope') || 'rank';
      return { scope, rows: db.leaderboard || [], warnings: db.warnings || [], demo: true };
    }
    if (path.endsWith('/performance-card')) {
      return { teamName: '演示战队', tier: 'A', items: db.milestones || [], benefits: [], neverUnlocks: ['奖金', '决赛名次'], demo: true };
    }
    if (path.endsWith('/tier')) {
      return { rows: db.tiers || [], demo: true };
    }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/leaderboard-web.test.js` → Expected: PASS（6 个测试全过）

- [ ] **Step 7: 全量回归**

Run: `cd platform && node --test test/` → Expected: 全部通过（P0–P3 的全部用例）
Run: `cd platform && node scripts/migrate.js` → Expected: 输出 `迁移完成，当前版本 4`

- [ ] **Step 8: 提交**

```bash
cd platform && git add web test/leaderboard-web.test.js
git commit -m "feat(P3): 榜单页、段位榜与战绩卡前端"
```

---

## 需求覆盖对照表（本阶段负责的 22 条）

| 需求 ID | 落到哪个 Task / 哪个函数 | 怎么验 |
|---|---|---|
| R-RNK-01 双榜并列不合成一个总分 | Task 7 `buildRankPayload` / `buildBusinessPayload`：A 榜与 B 榜读不同的表、走不同的计算路径，B 榜 payload 里没有 total / points / rank | Task 7 测试「B 榜响应体不含评分与签字人」 |
| R-RNK-02 B 榜不碰奖金与名次 | 同上：B 榜只输出里程碑达成情况，不输出名次、不输出积分、不输出总分 | 同上 + B 榜 payload 断言 |
| R-RNK-03 A 榜不碰资源解锁 | Task 7 `buildRankPayload`：A 榜无里程碑/权益字段；解锁只由 Task 4 的 `computeTier` 产生 | A 榜 payload 断言 + Task 4「段位只换资源不换钱」 |
| R-RNK-04 滚动榜单全程公开 + 分层公开 | Task 7 `getRollingLeaderboard`（滚动总榜）+ Task 6 `applyVisibility`（分层） | Task 7「滚动总榜」用例 + Task 6 全部用例 |
| R-RNK-05 互评权重 ≤20% | Task 7 `buildStageRanking`：互评分只进破同分链，**不进 total**，实际占比恒为 0% ≤ 20% | Task 5「隔离断言」+ Task 2 链不变量 |
| R-RNK-06 互评只用于破同分 | Task 2 `applyTiebreakChain`：peer 键 `scope=tied_only` | Task 2「组内缺可比较的值」+「破同分链优先级」 |
| R-RNK-07 互评资格门槛 | Task 7：互评分只从 P2 的 `peer_reviews` 取（只有有真实交付物的队伍才有互评记录），空交付队无记录 → 该键对本组不可用 | Task 2「tiebreak_key_unusable」warning 用例 |
| R-RNK-08 异常互评检测 + 来源不公示 | 来源不公示：Task 6 `peerReview.showSource=false` → 清空 `peerSource` / `fromTeamId` / `fromUserId`；异常检测（同分互投率）由 P4 `anticheat` 承接 | Task 6「互评来源不公示」用例 |
| R-RNK-09 MVP（4 赛段总积分 + S4 路演，每包 1 个） | Task 3 `computeMvp` + Task 7 `awardMvp` | Task 3「computeMvp」用例 + Task 7 发榜用例 |
| R-RNK-10 个人积分终生上榜 | Task 3 `computePersonalPoints`（`personal.lifetime`）+ Task 7 `buildPersonalPayload` | Task 3「computePersonalPoints」用例 |
| R-PTS-01 段位锚定企业签字里程碑 | Task 4 `computeTier`（只数"已达成 + 有企业签字"的里程碑） | Task 4「撤回的签字不计入段位」 |
| R-PTS-02 段位表 D/C/B/A/S | Task 4 `computeTier`（读 `rules.ranks.tiers`，门槛全部来自配置） | Task 4 段位边界用例 |
| R-PTS-03 S 段只认企业业务部门签字 | Task 4 `classifyDepartment` + `computeTier`（技术部门签字不计入 S） | Task 4「技术部门签字不计入 S」 |
| R-PTS-04 段位可降级且规则公开 | Task 4 `applyTierDemotion`（撤回签字降档 / 14 天零提交降 1 档 / `publishDemotion` 公示） | Task 4「降级」用例 |
| R-PTS-05 段位换资源不换钱 | Task 4 `computeTier`（`benefits` 来自配置、`neverUnlocks` 常驻返回） | Task 4「段位只换资源不换钱」 |
| R-PTS-06 段位只影响同分排序不制造额外名额 | Task 4 `computeTier` 不产出任何名额；Task 7 名次计算完全不读段位（段位只进展示字段 `tier`） | Task 5「隔离断言」+ Task 7 名次用例 |
| R-PTS-07 行为分明细 | Task 5 `behaviorScore`（分值全部读 `rules/behavior-points.json`） | Task 5「行为分明细」用例 |
| R-PTS-08 行为分 ≤10% 且只做"垫底排序" | Task 2 `assertChainInvariants`（behavior 必须是 `tied_only`、非链首、最后一项实质依据）+ Task 5（不进 total） | Task 2 链不变量 + Task 5 两条隔离断言 |
| R-PTS-09 行为分达标线 60 = 完赛 | Task 5 `behaviorScore` → `completed`；未达标不影响名次与已获奖金（行为分不进 total / points） | Task 5「达标线 60」+ 隔离断言 |
| R-PTS-10 反作弊 5 条 | 签到 0 分 / 纯文字进度不给分 / 须带版本记录 + 代码仓 → Task 5；里程碑报名时固定 → Task 1 迁移（`milestones.fixed_at`）；企业签字须部门+联系人+内容 → Task 1 迁移（`milestone_signoffs.department` / `signatory_user_id` / `content` NOT NULL）；TOP 名单事后回访 = 运营事项（代码侧只保证签字有内容） | Task 5「反作弊 5 条」用例 |
| R-PTS-11 L2 商业里程碑 7 类 | Task 1 `004_leaderboard.sql` 的 `milestones`（key 取 `rules/milestones.default.json` 的 7 类）+ Task 7 `buildBusinessPayload` + Task 8 `cardHtml` 勾选式 | Task 7 B 榜用例 + Task 8「战绩卡」用例 |
| R-PTS-12 L2 与段位同源但规则不共享 | 同一张 `milestone_signoffs` 表（数据源同源）→ Task 4 段位只读签字的"部门/撤回"两列；Task 7 B 榜只读"是否达成"；两条路径不共享任何规则字段 | Task 4 段位用例 + Task 7 B 榜用例（B 榜无评分） |

---

## P3 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P3-1 | 迁移幂等且到版本 4 | `node scripts/migrate.js` 连跑两次 → 第二次「本次无新迁移」；`PRAGMA table_info` 列出 4 张榜单表 |
| P3-2 | 名次积分写死 10/8/5 | `node --test test/points.test.js` → 「名次积分必须写死 10/8/5」通过：1→10、2→8、3→5、4→0，且 1≠18、2≠5、3≠2 |
| P3-3 | 1224 并列名次 | `node --test test/ranking.test.js` → 「1224 式并列名次：1,1,3」通过 |
| P3-4 | 全同分落到队伍编号兜底 | 同上「全同分时落到队伍编号兜底」：两次调用顺序一致，名次仍是 1,1,1 |
| P3-5 | ★ 行为分与总分隔离 | `node --test test/behavior.test.js` → 「隔离断言」两条通过；`PRAGMA table_info(stage_results)` 无 behavior/bonus/event_points 字段 |
| P3-6 | ★ 段位边界 | `node --test test/tier.test.js` → 3 项含接入→A；5 项含业务部门签字→S；技术部门签字→A；撤回签字→降档并公示 |
| P3-7 | ★ 段位公示按 C-02 | `node --test test/visibility.test.js` → 「D 段不出现在榜单」「只给本人进度卡」通过；`GET /api/teams/t_d/tier` 对非成员 404 |
| P3-8 | ★ B 榜不泄露评分与签字人 | `GET /api/leaderboard/st_1?scope=business` 响应体没有 `signatory`/`signatoryUserId`/`score`/`seatE`/`enterpriseName`，也不含签字人姓名 |
| P3-9 | ★ 降级告警置顶 | `GET /api/leaderboard/st_1?scope=rank` 的 `warnings` 里有 P2 的 `judge_sample_too_small`；前端 `leaderboardHtml` 中告警位置在榜单之前 |
| P3-10 | 三态状态码 | 无结果赛段 → 200 + `rows: []`；不存在赛段 → 404；`visibility.rank.public=false` → 403；非法 scope → 400 |
| P3-11 | 观察员不能发榜 | `publishLeaderboard({actorId:'u_obs'})` 抛 403；发榜后 `leaderboard_snapshots` 3 条、`audit_log` 1 条 `leaderboard.publish` |
| P3-12 | 发榜幂等且可复算 | 连续两次 `publishLeaderboard` → `points_ledger` 行数不变；`leaderboard_snapshots.payload_json` 能重放出同样的名次 |

---

## 与接口契约的偏差

> 本节只列**与 `INTERFACES.md` 不完全一致**的地方。**`INTERFACES.md` 本身未被修改**。

| # | 偏差 | INTERFACES.md 的写法 | 本计划的写法 | 理由 |
|---|---|---|---|---|
| 1 | `rules/points.json` 多一个 `fallbackPolicy` 键 | 给出的是完整 JSON（无 `fallbackPolicy`） | 原文 + 追加 `fallbackPolicy`（`enabled:false` + R-JDG-21 权重回退 15% 的注释位） | 任务书明确要求「在 points.json 留 `fallbackPolicy` 注释位」；该键不被任何代码消费，只作占位 |
| 2 | 新增 `rules/criteria.json` | P3 只列了 `rules/points.json` | 新增 `rules/criteria.json`，承载「A 段的数据接入/原型交付键」「业务/技术部门关键词」「行为分证据要求」「MVP 积分口径」 | 这些判定必须配置化（R-PTS-03 / R-PTS-10），但 `rules/ranks.json` 与 `rules/behavior-points.json` 是 P0 已定稿文件**不得修改**；域函数签名（`computeTier({milestones, signoffs, ranksConfig})` / `behaviorScore({events, behaviorConfig})`）已定死，无法再传入新参数，故由服务层把配置解析成标志位（`isDataOrPrototype` / `isBusinessDepartment` / `evidenceRequirements`）后注入 |
| 3 | 迁移 `004_leaderboard.sql` 多 2 张表 | 只列 `points_ledger` / `tier_records` / `behavior_events` / `leaderboard_snapshots` | 追加 `milestones` / `milestone_signoffs` | 这 2 张表在设计文档 §5.2 有明确定义，但 INTERFACES 的 P0/P1/P2/P4 表清单都没有；本阶段的段位（R-PTS-01）与战绩卡（R-PTS-11）都依赖它们。字段按设计文档 §5.2 写，`milestones` 另加 `key`（设计文档只有 `title`，但 7 类里程碑的 key 是段位判定必需的） |
| 3b | **`tiebreak_round` / `tiebreak_votes` 不在本迁移建** | 契约未指定归属 | **由 P2 的 `003_review.sql` 建，本迁移只消费** | ⚠️ 原写法是本迁移也建这两张表，与 P2 撞表 → 第二个迁移报 `table tiebreak_round already exists`，**整条迁移链（004/005/006）全部不执行**。归属裁决：**P2 拥有**（P2 的 Task 7 就是"互评、加时陈述与一票破同分"，投票入口在那儿）；P3 只在破同分链里读它。P2 的表结构含 `tiebreak_votes` 的 `PRIMARY KEY(tiebreak_round_id, voter_id, team_id)`（一人一票由数据库唯一约束保证），满足 C-03 第 2 级 |
| 4 | `src/services/leaderboard.js` 三个函数多了可选参数 `rules` | `getLeaderboard({ db, stageId, scope, viewer })` 等 | 追加可选的 `rules` 参数（原有参数逐字保留） | 服务层需要 `rules.tiebreak` / `rules.visibility` / `rules.points`，而契约签名里没有。调用方（HTTP 层）有 `ctx.rules` 直接注入；未注入时由 `getDefaultRules()` 从 `platform/rules/` 懒加载兜底，**不产生静默默认值** |
| 5 | `src/domain/points.js` 新增 `computePrizeShares` | 未列 | 新增 `computePrizeShares({ ordered, prizeTable })` | R-JDG-20「并列共享奖金（总额不变）」需要一条可执行算法才能被验证；奖金表本身仍由调用方传入（目前无配置文件规定金额） |
| 6 | `applyTiebreakChain` / `rankTeams` 的返回值是超集 | `{ ordered, applied }` / `{ ordered, tieGroups, rankStyle }` | 分别追加 `groups` / `warnings` / `applied` | `applied` 与 `groups` 是计算 1224 名次与「降级告警置顶」所必需的中间量；契约里已有的字段全部保留且语义不变 |
| 7 | `applyVisibility` 的 `context` 追加 `viewerTeamIds` | `context` 未展开 | `{ scope, viewerTeamIds?, viewerTeamId?, tierOrder? }` | 一名选手可同时在多支队伍里，单个 `viewerTeamId` 表达不了 |
| 8 | ~~新增 `src/errors/app-error.js`~~ → **改为复用 P1 的 `src/errors.js`** | §0 要求「抛 AppError」，但 P0 未建该类 | 本阶段**不新建**错误模块；直接 `import { AppError, appError } from '../errors.js'`（P1 Task 3 建立），签名统一为 **status-first**：`AppError(status, code, message, detail)` / `appError(status, code, message, detail)` | ⚠️ 原写法是 `appError(code, message, status)`（code 在前），与 P1/P4 的 `appError(status, code, message)` **参数顺序相反**。两套并存必然有一半调用点写错顺序，且 `err.status` / `err.code` 会互换——HTTP 层会返回错误的状态码。已统一为 status-first，并把 P3 内 12 处调用点全部改写 |
| 9 | `rules/*.json` 的加载与校验在 `src/config.js` 里扩展 | §1 只列了 9 份 P0 规则文件 | `src/config.js` 的 `FILES` / `grouped` / `validateRules` 追加 `points` 与 `criteria` | P3 新增 2 份规则文件，必须走同一条 fail-fast 校验通路，否则「改 JSON 即改规则」这条 S-2 会破 |
| 10 | 新增 3 个仓储文件 | 未列仓储文件名 | `src/db/repo/leaderboard.js` / `points.js` / `tiers.js` | 所有 SQL 必须收在 `src/db/repo/`；文件名带 P3 语义，避免与 P1/P2 的仓储重名冲突 |

**待组委会确认的判断（非接口偏差，是本阶段做的口径选择）**

| # | 判断 | 本阶段的取值 | 依据与影响 |
|---|---|---|---|
| A | 并列时的名次积分分配 | **按位置**（并列第一占第 1、2 席 → 10 分、8 分），任一赛段积分总额恒为 23 | 任务书 §七「第一/二/三名 = 10/8/5」+ 设计文档 §6.3「任务包内全量战队排名」。按名次分配会让并列时积分总额膨胀（10+10+5=25），MVP 跨赛段比较的尺子就不一致了。**可改**：改 `computeStagePoints` 一处即可 |
| B | 名次积分的排名范围 | **任务包内**（每个任务包各自排 1/2/3 名） | 设计文档 §6.3 原文「任务包内全量战队排名」+ R-RNK-09「每个任务包决出 1 个 MVP」。A 榜页面上同时给出全赛段名次与包内名次两个字段 |
| C | MVP 积分的数值口径 | **该队计入的 4 个赛段的名次积分之和** | `rules/points.json` 没有规定 mvp 数值 → 口径写在 `rules/criteria.json.mvp.awardPointsSource`，改配置即可，不改代码 |
| D | 「连续 14 天零提交」的计时起点 | 取该队 `behavior_events` 的最新时间；从未提交过的队伍按 0 天计（不降级） | 「连续 14 天零提交」隐含已有提交历史；从未开始的新队不应因未提交被降级 |
| E | D 段队伍的段位接口对外表现 | 非成员 → **404**；成员 → 本人进度卡（无名次） | 冲突裁决 C-02「D 段只公示个人进度，不公示排名」+ 三态语义「单条不满足 → 404」 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

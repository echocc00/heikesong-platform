# P3 榜单与积分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 能真实发榜：A 榜（赛段名次）/ B 榜（商业战绩）/ 个人积分榜三条线并列不合成一个总分；破同分链 6 级有序并落到确定性兜底；名次积分 10/8/5；MVP 每任务包 1 个；个人积分终生上榜；段位锚定企业签字里程碑并可降级；行为分与总分**在算法层隔离**；可见性在 API 层过滤。

**Architecture:** 延续 P0 分层：`src/domain/*` 纯函数（无 IO、无 `Date.now()`、无 `Math.random()`），`src/services/*` 编排用例，`src/db/repo/*` 收全部 SQL，`web/views/*` 原生 ESM 前端。P3 消费 P2 的 `stage_results`（总分口径）与 `computation_snapshots`（trace 与降级告警）、P1 的 `teams` / `task_packages` / `team_members`，**新增一条独立的行为分数据通路**（`behavior_events`），行为分只从这条路进破同分链的最后一档。发榜是显式动作（`publishLeaderboard`），每次发榜写 `leaderboard_snapshots` 快照 + 审计日志，满足"可复算"。

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
│   └── errors.js                      ★ AppError（**P0 已建**，本阶段只复用不重建）
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

**Files:** Create `platform/db/migrations/004_leaderboard.sql`、`platform/rules/points.json`、`platform/rules/criteria.json`、`platform/src/db/repo/stage-teams.js`、`platform/test/leaderboard-migration.test.js`；Modify `platform/src/config.js`

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
import { createEdition } from '../src/db/repo/editions.js';
import { createUser } from '../src/db/repo/users.js';
import { insertStage } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { registerStageTeams, listStageTeamIds, isTeamInStage, hasStageRoster } from '../src/db/repo/stage-teams.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

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
  // ⚠️ personal 组在 P5 修复轮（I-3）里多了两项：atomicKinds / rollupKind ——
  //    个人积分口径的**唯一规则来源**（原来散在 rules.pools.talentPointKinds 与
  //    rules.points.personal 两处，两处口径还不一样）。
  assert.deepEqual(rules.points.personal, {
    lifetime: true,
    includeMvpVote: true,
    atomicKinds: ['stage_rank', 'mvp', 'roadshow'],
    rollupKind: 'personal_rollup',
  });
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
  assert.deepEqual(rules.criteria.mvp.tiebreak, ['roadshow_points', 'team_id'], 'MVP 决胜链默认以 team_id 收尾');
  assert.deepEqual(rules.criteria.behaviorEvidence.weekly_progress.required, ['repo', 'version']);
});

test('配置校验会拒绝非法 / 缺失的 MVP 决胜链', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  delete bad.criteria.mvp.tiebreak;                        // 缺决胜链 → 同分 MVP 由入参顺序决定
  assert.ok(validateRules(bad).some((e) => e.includes('tiebreak')));
  const bad2 = structuredClone(rules);
  bad2.criteria.mvp.tiebreak = ['roadshow_points', 'lottery'];   // 未知决胜键
  assert.ok(validateRules(bad2).some((e) => e.includes('lottery')));
  const bad3 = structuredClone(rules);
  bad3.criteria.mvp.tiebreak = ['roadshow_points'];        // 缺 team_id 收尾 → 非确定性兜底
  assert.ok(validateRules(bad3).some((e) => e.includes('team_id')));
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

// ═══════════════════════════════════════════════════════════════════════════
// 父代理变异检验追加的用例（2026-10-21）
//   —— 下面这些行为在实现里是对的，但**没有用例钉住** → 变异体会存活。
// ═══════════════════════════════════════════════════════════════════════════

test('★ 004 迁移的引用型外键齐全（引用完整性不留裸列）', () => {
  const { db, close, dataDir } = setup();
  const fks = (t) => db.prepare(`PRAGMA foreign_key_list(${t})`).all()
    .map((r) => `${r.from}->${r.table}`).sort();
  assert.deepEqual(fks('points_ledger'),
    ['edition_id->editions', 'stage_id->stages', 'team_id->teams', 'user_id->users']);
  assert.deepEqual(fks('tier_records'), ['team_id->teams']);
  assert.deepEqual(fks('behavior_events'), ['team_id->teams', 'user_id->users']);
  assert.deepEqual(fks('leaderboard_snapshots'), ['edition_id->editions', 'stage_id->stages']);
  assert.deepEqual(fks('milestones'), ['stage_id->stages', 'team_id->teams']);
  assert.deepEqual(fks('milestone_signoffs'), ['milestone_id->milestones', 'signatory_user_id->users']);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('004 迁移的 NOT NULL / DEFAULT / 类型约束符合契约', () => {
  const { db, close, dataDir } = setup();
  const col = (t, name) => db.prepare(`PRAGMA table_info(${t})`).all().find((r) => r.name === name);
  // 积分流水：kind 必填、points 是数值（不是字符串）
  assert.equal(col('points_ledger', 'kind').notnull, 1);
  assert.equal(col('points_ledger', 'points').type, 'REAL');
  // 榜单快照：scope 必填
  assert.equal(col('leaderboard_snapshots', 'scope').notnull, 1);
  // 里程碑：默认计入段位
  assert.equal(col('milestones', 'counts_toward_tier').dflt_value, '1');
  // 段位记录是软删除（必须有 deleted_at）
  assert.ok(col('tier_records', 'deleted_at'), 'tier_records 必须有 deleted_at（软删除）');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ stage_team 赛段名册表：字段 + 唯一约束 + 外键（P2 的 D-33 登记在 P3）', () => {
  const { db, close, dataDir } = setup();
  assert.deepEqual(cols(db, 'stage_team'), ['id', 'stage_id', 'team_id', 'registered_at']);
  const fks = db.prepare('PRAGMA foreign_key_list(stage_team)').all()
    .map((r) => `${r.from}->${r.table}`).sort();
  assert.deepEqual(fks, ['stage_id->stages', 'team_id->teams']);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 赛段名册仓储：登记 / 判定 / 重复登记被唯一约束挡住', () => {
  const { db, close, dataDir } = setup();
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  const captain = createUser(db, { name: '队长', phone: '13800002001', password: 'pw123' });
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, status: 'active', now: NOW,
  });
  const outsider = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: captain.id, status: 'active', now: NOW,
  });

  assert.equal(isTeamInStage(db, stage.id, team.id), false, '未登记前不得判定为在册');
  assert.equal(hasStageRoster(db, stage.id), false, '登记前名册为空');
  const added = registerStageTeams(db, { stageId: stage.id, teamIds: [team.id], now: NOW });
  assert.equal(added, 1);
  assert.equal(hasStageRoster(db, stage.id), true, '登记后名册非空');
  assert.equal(isTeamInStage(db, stage.id, team.id), true);
  assert.equal(isTeamInStage(db, stage.id, outsider.id), false, '未登记的队伍不在赛段名册内');
  assert.deepEqual(listStageTeamIds(db, stage.id), [team.id]);
  // 重复登记必须被唯一约束挡住（幂等由服务层判定，仓储层不吞）
  assert.throws(() => registerStageTeams(db, { stageId: stage.id, teamIds: [team.id], now: NOW }));
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('配置校验会拒绝非法 criteria 配置 / 缺 points / personal.lifetime 非布尔', () => {
  const { rules } = loadRules(rulesDir);
  const bad1 = structuredClone(rules);
  bad1.criteria.tier = undefined;
  assert.ok(validateRules(bad1).some((e) => e.includes('criteria.tier')));
  const bad2 = structuredClone(rules);
  bad2.criteria.tier.dataOrPrototypeMilestones = [];
  assert.ok(validateRules(bad2).some((e) => e.includes('dataOrPrototypeMilestones')));
  const bad3 = structuredClone(rules);
  bad3.criteria.tier.businessDepartmentKeywords = [];
  assert.ok(validateRules(bad3).some((e) => e.includes('businessDepartmentKeywords')));
  const bad4 = structuredClone(rules);
  bad4.points = undefined;
  assert.ok(validateRules(bad4).some((e) => e.includes('points 缺失')));
  const bad5 = structuredClone(rules);
  bad5.points.personal.lifetime = 'yes';
  assert.ok(validateRules(bad5).some((e) => e.includes('personal.lifetime')));
});

test('⛔ 行为分 sortUse 必须恒为 tiebreak_only（R-PTS-08 是硬保证，不是可配置项）', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.behavior.sortUse = 'primary';
  assert.ok(validateRules(bad).some((e) => e.includes('sortUse')),
    '行为分被改成主评分口径时必须拒绝启动');
  assert.equal(validateRules(rules).length, 0, '出厂配置必须零报错');
});

test('⛔ 占位策略不得被擅自启用（观众票 / 权重回退 / 未知部门口径 / 对接会时长）', () => {
  const { rules } = loadRules(rulesDir);
  // R-OPS-11 观众票：权重无规则依据，只占位不启用
  assert.equal(rules.points.demoDayAudienceVote.enabled, false);
  assert.equal(rules.points.demoDayAudienceVote.weight, null);
  // R-JDG-21 权重回退：首届后回测
  assert.equal(rules.points.fallbackPolicy.enabled, false);
  // 签字部门写错**不得**默认算业务部门（S 档会凭空达标）
  assert.equal(rules.criteria.tier.unknownDepartmentCountsAsBusiness, false);
  // R-JDG-15 对接会：30 分钟 / 2 周内
  assert.equal(rules.criteria.enterpriseCompliance.meetingDurationMinutes, 30);
  assert.equal(rules.criteria.enterpriseCompliance.deadlineDays, 14);
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
```

- [ ] **Step 3b: 创建 `src/db/repo/stage-teams.js`（赛段级队伍边界的仓储）**

> **【2026-10-21 父代理补充 —— 兑现 P2 的 D-33 承诺】**
> **原来错在哪**：P2 计划 D-33 的「已知限制」栏明写「赛段级队伍边界需要一张 `stage_team` 表 —— **登记在 P3**」，
> 但 P3 计划的**全文**（`grep -c 'stage_team\|名册\|roster'` 全为 0）**一个字都没提** ——
> 一条**指向不存在实现的活引用**，与 P0 终审发现的 SSE 那条（审计报告 I-6）**同一类病**。
> **为什么不能拖到下一阶段**：届期级名册挡不住「**同届期另一赛段**的队」被写进本赛段 ——
> 那支队在同届期里「合法」，届期级判定放行 → 评分 / 企业确认 / 行为分 / 里程碑签字
> 全记到一支没在这个赛段参赛的队头上 → **外队进榜**。**只有赛段级名册能挡**。
> **改成什么**：本阶段**建表 + 建仓储**（本 Step），**服务层接线**在 Task 7（`isTeamInStage` 用于
> P3 自己的写入口：行为分事件 / 里程碑签字 / MVP 投票）；**名册的登记时机**（赛段开启时把该届
> 参赛队登记进来）属 **P5 的工作流** —— 见偏差表 3c。
>
> ⚠️ **仓储层不吞异常**：重复登记会撞唯一约束 `(stage_id, team_id)` → **抛错**。
>    幂等判定是**服务层**的事（它要先查再决定）；仓储层静默忽略 = 名册里出现两条同队记录。

`platform/src/db/repo/stage-teams.js`：

```javascript
// src/db/repo/stage-teams.js — 赛段队伍名册（赛段级队伍边界）
// 依据：P2 计划 D-33 的**已知限制**——「名册目前是**届期级**（stages → edition_id → teams），
//   赛段级队伍边界需要一张 `stage_team` 表 —— 登记在 P3」。
//   本文件是那条承诺的兑现：把「某队属于本赛段」从**届期粒度**落到**赛段粒度**。
//
// ⚠️ 为什么必须有这张表（不建的后果）：
//   只有届期名册时，**同届期另一赛段的队伍**也能被写进本赛段 —— 评分 / 企业确认 /
//   行为分 / 里程碑签字都会记到一支「没在这个赛段参赛」的队头上 → 外队进榜。
//   届期级判定挡不住这种情况（同届期的队就是合法的），**只有赛段级名册能挡**。
//
// ⛔ 归属：本文件是 **P3 建立**（P2 计划 D-33 明确「登记在 P3」）。
//    P2 的 `services/review.js` 的 `assertTeamInStage` 仍是**届期级**判定 ——
//    切换到赛段级需要「名册有数据时优先赛段级、否则回落到届期级」的口径，
//    属 P3 Task 7 的服务层接线范围（见 P3 计划偏差表 3c）。
//
// ⚠️ 登记的**触发时机**（赛段开启时把该届参赛队登记进来）属 **P5 的工作流**；
//    本阶段只提供「表 + 仓储」，写入由后续流程调用 —— 表本身不是死表。
import { randomUUID } from 'node:crypto';

/**
 * 把队伍登记进赛段名册。
 * @returns {number} 实际登记的队数
 * ⚠️ 重复登记会撞唯一约束（stage_id, team_id）→ **抛错**，不静默忽略。
 *    幂等判定是**服务层**的事（它要先查再决定），仓储层不吞异常。
 */
export function registerStageTeams(db, { stageId, teamIds, now }) {
  const ids = Array.isArray(teamIds) ? teamIds : [teamIds];
  const stmt = db.prepare(
    `INSERT INTO stage_team (id, stage_id, team_id, registered_at) VALUES (?, ?, ?, ?)`,
  );
  let n = 0;
  for (const teamId of ids) {
    stmt.run(randomUUID(), stageId, teamId, now);
    n += 1;
  }
  return n;
}

/** 某赛段名册里的全部队伍 id（按登记时间、再按登记顺序（rowid）排序 → 确定性）。 */
export function listStageTeamIds(db, stageId) {
  return db
    .prepare('SELECT team_id FROM stage_team WHERE stage_id = ? ORDER BY registered_at ASC, rowid ASC')
    .all(stageId)
    .map((r) => r.team_id);
}

/** 该队是否在赛段名册内。 */
export function isTeamInStage(db, stageId, teamId) {
  const row = db
    .prepare('SELECT 1 AS x FROM stage_team WHERE stage_id = ? AND team_id = ?')
    .get(stageId, teamId);
  return row != null;
}

/** 赛段名册是否已登记过任何队伍（区分「名册为空」与「名册未启用」）。 */
export function hasStageRoster(db, stageId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stageId);
  return Number(row?.n ?? 0) > 0;
}

/**
 * 把队伍从赛段名册里退出去（**逆向路径**：退名册）。
 *
 * ⚠️ 与 registerStageTeams 相反的方向：**不静默** ——
 *    重复退同一个队伍会返回 0 行受影响（调用方据此判「本来就不在册」）。
 *    幂等与否是**服务层**的事（它要先查再决定要不要报错），仓储层只如实报告影响行数。
 *
 * @returns {number} 实际删除的行数（0 = 本来就不在名册里）
 */
export function removeStageTeam(db, { stageId, teamId }) {
  const res = db
    .prepare('DELETE FROM stage_team WHERE stage_id = ? AND team_id = ?')
    .run(stageId, teamId);
  return Number(res?.changes ?? 0);
}
```

- [ ] **Step 4: 创建 rules/points.json 与 rules/criteria.json**

`platform/rules/points.json`（INTERFACES.md §4 原文 + 任务书要求的 `fallbackPolicy` 注释位）：

```javascript
{
  "id": "points",
  "version": "2026-10-23",
  "source": "任务书 §七 + S10 §3.3",
  "stagePoints": [10, 8, 5],
  "stagePointsOnlyTopN": 3,
  "mvp": { "stagesCounted": 4, "roadshowWeight": 1.0, "perPackage": 1 },
  "personal": {
    "lifetime": true,
    "includeMvpVote": true,
    "atomicKinds": ["stage_rank", "mvp", "roadshow"],
    "rollupKind": "personal_rollup"
  },
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

```javascript
{
  "id": "criteria",
  "version": "2026-10-23",
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
    "awardPointsNote": "MVP 积分 = 该队计入的 4 个赛段的名次积分之和。rules/points.json 未规定 mvp 数值，此为待组委会确认口径；改这里即可，不改代码。",
    "tiebreak": ["roadshow_points", "team_id"],
    "tiebreakNote": "MVP 综合分并列时的决胜链（顺序即优先级）。⚠️ 任务书 §七 只给了「4 赛段总积分 + S4 路演评审综合」的加法公式，未写并列怎么办；S10 §0.3「互评的真正用途是破同分」+ §4「行为分用于同分垫底排序」确立了本赛事通则 —— 同分必须用实质依据决出，不许用字母序。故默认：路演名次积分高者胜（仍是评审实质依据）→ 仍并列则 team_id 码位序（确定性兜底，跨机器可复算）。**此为 P3 自有口径 · 待组委会确认**；改这里即可，不改代码。"
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

> **【2026-10-21 漂移审计修正 I-2】** **version 一致性校验这一步【不需要改】** ——
> 原计划隐含的「新增规则文件要同步加进 `versionValues` 数组」**不适用**，照做反而会出事。
> **原来错在哪**：P0 终审时的 `src/config.js` 里，version 全等校验是**硬编码的 9 项列表**
> （`rules.scoring.initial.version` … `rules.milestones.version`）+ 硬编码的 `9`。
> 新增的规则文件即使注册进了 `FILES` / `grouped`，它的 `version` **从不参与比较**
> （审计实跑：注入 `points.version='2099-01-01'`、`criteria.version='2099-12-31'` →
> `validateRules` **零报错**）→ 设计文档写明的「版本号漂移 = 审计链在说谎」这条被打破。
> **现状（基线已修好）**：基线的 `src/config.js` **已经不是**那个硬编码形态了 ——
> `validateRules(rules, expectedCount = null)` 改成**按「有 id 的是一份配置」自动派生**
> （`collectConfigObjects` 摊平配置对象），`expectedCount` 由 `loadRules()` 传
> `Object.keys(FILES).length`。**加多少份配置都自动覆盖** → `versionValues` 那个数组
> **已经不存在了**，P3 无需（也无法）去改它。
> **改成什么**：本步**只**做三件事 —— ① `FILES` 加 2 行；② `grouped` 加 2 行；
> ③ `validateRules` 末尾追加 points / criteria 的**内容**校验段。
> **version 一致性校验一个字都不动。**
> **⚠️ 两个硬前提（漏了会直接拒绝启动）**：
> ① **每份新配置文件必须带 `"id"` 字段** —— 识别「一份配置」用的是 `id` 而不是 `version`
> （一份配置**缺了 version** 时仍要能被认出来，否则它会被当成命名空间 →「缺少 version」
> 那条检查反过来失效）。`rules/points.json` 有 `"id": "points"`、`rules/criteria.json` 有
> `"id": "criteria"` ✓。**嵌套对象里的 `id` 不算**（`collectConfigObjects` 命中配置对象即 `return`，
> 不再往里递归）。
> ② **份数必须对上**：`expectedCount = Object.keys(FILES).length`，
> 识别到的配置份数与之不等 → 报「规则配置应有 N 份，实际只识别到 M 份」→ **拒绝启动**。
> P3 落地时 `FILES` 从 12 份变 14 份，`grouped` 里能被识别到的配置份数也必须是 14。
> **依据**：基线 `platform/src/config.js`（`collectConfigObjects` / `validateRules(rules, expectedCount)`
> / `loadRules` 传 `Object.keys(FILES).length`）+ 漂移审计报告 I-2 与 D-3
> （「P3 的 config.js 改造必须先于 P4/P5」——但**改造内容已由 P1 提前完成**）。

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

  // ── MVP 决胜链（P3）──────────────────────────────────────
  // ⛔ 综合分并列时必须有决胜链，且必须以确定性键收尾 —— 否则同分 MVP 由输入顺序决定，
  //    换台机器重算可能选出不同的 MVP。
  if (!crit?.mvp || !Array.isArray(crit.mvp.tiebreak) || !crit.mvp.tiebreak.length) {
    errors.push('criteria.mvp.tiebreak 缺失或为空');
  } else {
    const known = new Set(['roadshow_points', 'team_id']);
    for (const k of crit.mvp.tiebreak) {
      if (!known.has(k)) errors.push(`criteria.mvp.tiebreak 含未知决胜键：${k}`);
    }
    if (crit.mvp.tiebreak.at(-1) !== 'team_id') {
      errors.push('criteria.mvp.tiebreak 必须以 team_id 收尾（确定性兜底）');
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

Run: `cd platform && node --test test/leaderboard-migration.test.js` → Expected: PASS（**16 个测试全过**：leaderboard-migration.test.js 16 —— 规格自带 8 + 变异检验补测 6 + Task 7 补测 2）
Run: `cd platform && node --test` → Expected: 全部通过（P2 全量 **551/551**；P0 的 `config.test.js` 仍通过——新增规则文件不影响既有断言）

- [ ] **Step 7: 提交**

```bash
cd platform && git add db/migrations/004_leaderboard.sql rules/points.json rules/criteria.json src/config.js src/db/repo/stage-teams.js test/leaderboard-migration.test.js
git commit -m "feat(P3): 榜单数据模型 004 迁移与名次积分规则配置"
```

> ⚠️ 计划文件本身也在本次提交范围内（仓库根的 `docs/superpowers/plans/…`）——
> 「计划是规格」意味着**计划与实现必须同一次提交落盘**，否则规格与代码会分叉。

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
import { toNumber, cmpStr, omit } from '../src/domain/util.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// 父代理变异检验追加的用例（2026-10-21）—— 三条都是**规格自带的缺陷**
// ═══════════════════════════════════════════════════════════════════════════

test('★ 数值键必须按数值比较（字符串形态的 "100" 不能排在 "90" 后面）', () => {
  // ⚠️ 字典序下 '100' < '90' → 100 分的队被排到 90 分的队**后面**，且没有任何报错。
  const r = rank(teamsOf([{ teamId: 't_a', total: '100' }, { teamId: 't_b', total: '90' }]));
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_a', 't_b']);
});

test('★ 数值键的「相等」按数值判定：90 与 "90" 是同一个分（并列，不是 1,2）', () => {
  const r = rank(teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_b', total: '90', extra: { peerScore: 5 } },
  ]));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1]);
  assert.deepEqual(r.tieGroups, [['t_a', 't_b']]);
});

test('★ 缺值绝不被当成 0（toNumber(null) 必须是 null 而不是 0）', () => {
  // ⚠️ `Number(null)` 是 0 —— 直接 Number() 会把「缺值」静默变成「0 分」。
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(0), 0, '真正的 0 就是 0，不能与缺值混为一谈');
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber('88.5'), 88.5);
});

test('★ 破同分链缺少总分项必须被拦下（没有总分就不是破同分链）', () => {
  const noTotal = CHAIN.filter((c) => c.key !== 'total');
  assert.ok(assertChainInvariants(noTotal).some((e) => e.includes('总分')));
});

test('★ tiebreakData.byTeam 传值路径与候选内联字段等价', () => {
  // ⚠️ 服务层是按 byTeam 传破同分数据的；候选对象内联只是等价写法。
  //    两条路径必须给出一致的名次 —— 否则「接口换个传法榜单就变了」。
  const teams = teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 9 } },
    { teamId: 't_b', total: 90, extra: { peerScore: 1 } },
  ]);
  const inline = rank(teams);
  const byTeam = rankTeams({
    teams: teams.map((t) => ({ teamId: t.teamId, total: t.total })),
    tiebreakChain: CHAIN,
    tiebreakData: { isFinal: false, byTeam: { t_a: { peerScore: 9 }, t_b: { peerScore: 1 } } },
    pointsConfig: rules.points,
  });
  assert.deepEqual(byTeam.ordered.map((o) => o.teamId), inline.ordered.map((o) => o.teamId));
  assert.deepEqual(byTeam.ordered.map((o) => o.rank), [1, 2]);
});

test('★ cmpStr 走的是码位序（不是 localeCompare）—— 跨机器可复算', () => {
  // ⚠️ localeCompare 依赖 ICU / locale，同一份数据在不同机器上可能不同序 →
  //    榜单不可复算（R-AUD-01）。码位序是确定性的。
  assert.ok(cmpStr('a', 'B') > 0, "码位序下 'B'(0x42) < 'a'(0x61)");
  assert.ok(cmpStr('a', 'B') !== 'a'.localeCompare('B'), '不得使用 localeCompare');
  assert.equal(cmpStr('t_a', 't_a'), 0);
  assert.equal(cmpStr(null, 'x'), -1);
});

test('★ omit 是「剔除」语义（名字与行为一致）', () => {
  const src = { teamId: 't_a', peerScore: 90, enterpriseRaw: 80, password_hash: 'x' };
  const out = omit(src, ['peerScore', 'enterpriseRaw', 'password_hash']);
  assert.deepEqual(out, { teamId: 't_a' });
  assert.deepEqual(src, { teamId: 't_a', peerScore: 90, enterpriseRaw: 80, password_hash: 'x' }, '原对象不得被改');
  assert.equal(omit({}, ['a']).a, undefined);
});

test('★ toNumber 对 NaN / Infinity 一律当缺值', () => {
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(-Infinity), null);
});

test('★ 不变量隔离：behavior 不在「最后一项实质依据」位置（其余检查都不触发）', () => {
  // ⚠️ 必须**只**触发这一条检查：链尾是确定性兜底、含总分、behavior 不在链首、scope 正确。
  //    否则「行为分位置」与「确定性兜底」两条检查会互相掩盖，谁被摘掉都测不出来。
  const chain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always' },
    { key: 'behavior', label: '行为分', direction: 'desc', scope: 'tied_only' },
    { key: 'peer', label: '互评分', direction: 'desc', scope: 'tied_only' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always', deterministic: true },
  ];
  const errs = assertChainInvariants(chain);
  assert.ok(errs.some((e) => e.includes('最后一项实质依据')), `应报「最后一项实质依据」：${errs.join(' | ')}`);
});

test('★ 不变量隔离：链尾不是确定性兜底（且链里没有 behavior）', () => {
  const chain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always' },
  ];
  const errs = assertChainInvariants(chain);
  assert.ok(errs.some((e) => e.includes('确定性兜底')), `应报「确定性兜底」：${errs.join(' | ')}`);
});

test('★ 链非法时 applyTiebreakChain 必须抛错（不得照算出一份榜单）', () => {
  const badChain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always' },
  ];
  assert.throws(
    () => applyTiebreakChain({ candidates: teamsOf([{ teamId: 't_a', total: 90 }]), chain: badChain, data: {} }),
    /破同分链配置非法/,
  );
});

test('★ ordered 里必须带 total（榜单行要显示总分）', () => {
  const r = rank(teamsOf([{ teamId: 't_a', total: 90 }, { teamId: 't_b', total: 80 }]));
  assert.deepEqual(r.ordered.map((o) => o.total), [90, 80]);
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
  // ⚠️ null / undefined / '' 必须先判掉：`Number(null)` 是 **0**、`Number('')` 也是 **0** ——
  //    直接 Number() 会把「缺值」静默变成「0 分」，与本函数的承诺（不静默当 0）**直接矛盾**。
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 剔除对象里指定的一批键，返回**新**对象（不改原对象）。
 * ⚠️ 名字从 `pick` 改成 `omit`：原实现是「剔除」，但名字叫 pick（挑出）——
 *    名实相反的函数一定会在某次调用里被用错方向（Task 6 的可见性过滤就是靠它
 *    剔除 peer / enterprise / password_hash 等敏感字段，用错方向 = 泄露）。
 */
export function omit(obj, keys) {
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
//
// 【告警文案分层 2026-10-23 —— 与 src/domain/scoring.js 同一套口径】
//   { code, message, detail?, ...原有字段 }
//   ⛔ 触发条件与口径没改，只改文案分层：
//   ① `message` 只给人读 ⇒ 破同分键用**中文 label**（rules/tiebreak.json 的 label），
//      label 缺失时**不许**退回英文 key（team_id / peer …），退成中性说法。
//   ② `detail` 是内部明细（键的英文 key + 缺可比值的队伍 id）⇒ 只给 audit:read 的人看。
import { cmpStr, toNumber } from './util.js';

// 破同分链的键 → 候选队伍上的字段名（INTERFACES.md §4 的 teams 字段名）
const KEY_FIELD = {
  total: 'total', tiebreak_extra: 'tiebreakExtra', peer: 'peerScore',
  enterprise_raw: 'enterpriseRaw', behavior: 'behaviorScore', team_id: 'teamId',
};
const fieldOf = (key) => KEY_FIELD[key] || key;

/**
 * 数值型破同分键 —— 这些键必须按**数值**比较。
 * ⚠️ 为什么不能「是字符串就按字符串比」：字符串形态的 `"100" < "90"`（字典序），
 *    100 分的队会被排到 90 分的队**后面** —— 榜单顺序错，且**没有任何报错**。
 *    `team_id` 不在此列：队伍编号是标识符，永远按字符串比（'0123' 与 '123' 是两支队）。
 */
const NUMERIC_KEYS = new Set(['total', 'tiebreak_extra', 'peer', 'enterprise_raw', 'behavior']);

/**
 * 数值型破同分键的**比较容差**（F35）。
 *
 * ⚠️ 为什么不能按 `String(value)` 分桶（原来的写法）：
 *    `70` 与 `70.00000000000001`（差 1 ULP ≈ 1.42e-14）**数学上完全相等**，
 *    但字符串不同 ⇒ 被判成**两个组** ⇒ 两队拿到**不同名次 + 不同赛段积分（10 vs 8）**，
 *    而且同分却**没记成同分**（tiedWith 为空）⇒ 破同分链在最该并列的地方拆开了并列。
 *    审计实测的可达性：当前 `scoreStage` 对两队用**同一个表达式**算 total ⇒ 位级相同，
 *    端到端尚未触发；**但只要两队的 total 来自不同代码路径**（一队的企业席分来自 R4 替换、
 *    另一队来自 seatScore，或某赛段由旧规则版本写过）⇒ DB 里的 REAL 就存下不同的位 ⇒ 触发。
 *    ⇒ 这是**潜伏缺陷**，必须按「数学相等即同分」修。
 *
 * ⛔ 容差取 **1e-9**：分数量级 0–100 ⇒ 1e-9 比任何**真实**分差（最小 0.01）小 7 个数量级，
 *    只用来吸收浮点表示误差（1 ULP ≈ 1.4e-14 @ 70），不会把真的不同分判成同分。
 */
const NUMERIC_EPSILON = 1e-9;

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

function compareValues(a, b, direction, key) {
  if (a === b) return 0;
  const dir = direction === 'asc' ? 1 : -1;
  if (NUMERIC_KEYS.has(key)) {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na === null || nb === null) return 0;
    return (na - nb) * dir;
  }
  return cmpStr(a, b) * dir;
}

/**
 * 按破同分键把一个并列组分成若干「桶」（同桶 = 同分）。
 *
 * ⛔ **数值键不许用 `String(value)` 分桶**（F35）—— 见 NUMERIC_EPSILON 的注释。
 *    数值键改成：**按数值排序后，相邻差 ≤ 容差的归同一个桶**（连续游程）。
 *    为什么用「排序 + 相邻游程」而不是「量化取整」：量化（`round(n/eps)*eps`）
 *    在大数上会因 `n/eps` 超出 2^53 丢精度 ⇒ 反而把**相等**的值分到不同桶；
 *    游程比较只看**相邻差**，与量级无关。
 *
 * 非数值键（如 `team_id`）保持字符串分桶 —— 队伍编号是**标识符**，
 * '0123' 与 '123' 是两支队，不能按数值合并。
 *
 * @returns {Array<Array>} 每个元素是一个桶（队伍数组）
 */
function bucketByKey(group, item, data) {
  const key = item.key;
  const values = group.map((c) => readValue(c, key, data));

  const stringBuckets = () => {
    const buckets = new Map();
    group.forEach((c, i) => {
      const k = String(values[i]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    });
    return [...buckets.values()];
  };

  if (!NUMERIC_KEYS.has(key)) return stringBuckets();

  const nums = values.map((v) => toNumber(v));
  // ⛔ 有**非数值**（脏数据 / 口径不符）⇒ 不猜：退回字符串分桶（与历史行为一致）。
  if (nums.some((n) => n === null)) return stringBuckets();

  const rows = group.map((c, i) => ({ c, v: nums[i] }));
  rows.sort((a, b) => a.v - b.v);
  const parts = [];
  let cur = [rows[0]];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].v - cur[cur.length - 1].v > NUMERIC_EPSILON) {
      parts.push(cur.map((r) => r.c));
      cur = [];
    }
    cur.push(rows[i]);
  }
  parts.push(cur.map((r) => r.c));
  return parts;
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
        const label = item.label || '未命名依据';
        const missingIds = missing.map((c) => c.teamId);
        warnings.push({
          code: 'tiebreak_key_unusable',
          message: `破同分键「${label}」在本组缺少可比较的值，本组不使用该键`,
          detail: `破同分键 ${item.key}：以下队伍在本组没有可比较的值（${missingIds.join('、')}）`,
          teamIds: missingIds,
        });
        next.push(group);
        continue;
      }
      if (item.deterministic) {
        // 确定性兜底：只决定组内顺序，【不】拆组（并列名次不变）
        next.push([...group].sort((a, b) => compareValues(
          readValue(a, item.key, data), readValue(b, item.key, data), item.direction, item.key,
        )));
        usedBy.push(...group.map((c) => c.teamId));
        continue;
      }
      const parts = bucketByKey(group, item, data);
      if (parts.length > 1) {
        parts.sort((a, b) => compareValues(
          readValue(a[0], item.key, data), readValue(b[0], item.key, data), item.direction, item.key,
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

Run: `cd platform && node --test test/ranking.test.js` → Expected: PASS（**22 个测试全过**：ranking.test.js 22 —— 规格自带 10 + 预审补测 3 + 变异检验补测 9）

> **【2026-10-21 漂移审计修正 M-1】** **原来错在哪**：本计划三处「Expected: PASS」的条数声明
> 与代码块里实际的 `test(` 数量不符 —— `ranking.test.js` 声明 **11** 实为 **10**、
> `points.test.js` 声明 **8** 实为 **7**、`leaderboard-service.test.js` 声明 **9** 实为 **8**。
> **为什么错**：条数是**实施时的验收闸**。实施者跑出 10 个而计划写 11 个，会误判「测试缺失」
> 而去改测试代码迁就声明，或者干脆失去对闸的信任。三个数字方向一致（都少 1），
> 说明是**手工维护漂移**，不是有意为之。
> **改成什么**：① 三个数字改成实测值；② 把本计划**全部 8 处** `Expected: PASS` 统一成
> `Expected: PASS（N 个测试全过：file N）` 的格式（多文件时逐文件列出）。
> **依据**：按「就近 `Run:` 行指向的测试文件 → 该文件的 fenced code block 内 `^test(` 出现次数」
> 逐个统计（与审计报告 M-1 同一口径），并在本次改动后**对五份计划全量复算**：
> 每一条 `Expected: PASS（N …）` 现已与代码块实测条数**逐条相等**。

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
  // 配置缺 stagePoints 段 → 0 分，**不静默套用默认表**
  // （启动期 config 校验会 fail-fast，这里只是不让「默认值」悄悄兜底）
  assert.equal(stagePointsFor(1, {}), 0);
  assert.equal(stagePointsFor(1, undefined), 0);
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

test('computeMvp：stagePoints 不带 stageId 时走退化路径（不按赛段数截断）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', points: 10 }, { teamId: 't_a', points: 5 }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.stagesCounted, 4, '配置口径仍是 4');
  assert.equal(out.mvp.stageTotal, 15, '不带 stageId 时全部计入，不做赛段截断');
  assert.equal(out.mvp.score, 15);
});

test('★ computePersonalPoints：终生上榜 + MVP 投决积分可开关 + 1224 并列', () => {
  const ledger = [
    { id: 'l1', userId: 'u_1', kind: 'stage_rank', points: 10 },
    { id: 'l2', userId: 'u_1', kind: 'mvp', points: 31 },
    { id: 'l3', userId: 'u_2', kind: 'stage_rank', points: 10 },
    { id: 'l4', userId: 'u_3', kind: 'personal_rollup', points: 99 },   // 汇总快照：有它就以它为准
    { id: 'l5', userId: 'u_4', kind: 'stage_rank', points: 10 },
    { id: 'l6', userId: 'u_5', kind: 'stage_rank', points: 5 },
  ];
  const on = computePersonalPoints({ ledger, pointsConfig: P });
  assert.equal(on.lifetime, true);
  assert.equal(on.includeMvpVote, true);
  // ⚠️ 口径（P5 修复轮 I-3 统一后的**唯一**口径，见 src/domain/personal-points.js）：
  //    「有 personal_rollup 行 ⇒ 以 rollup 为准；否则 ⇒ atomic 白名单之和」。
  //    原来本函数**排除** personal_rollup、且**任何 kind 都计入** —— 与人才池那套
  //    口径算出的是两个不同的名次（同一份流水 ⇒ 两处不一致）。
  assert.equal(on.rows[0].userId, 'u_3', 'rollup 99 分排第一');
  assert.equal(on.rows[0].total, 99, '有 rollup 行时以 rollup 为准（不是 10+99 也不是 0）');
  assert.equal(on.rows[0].byKind.personal_rollup, 99, '分项来源看得见');
  const u1 = on.rows.find((r) => r.userId === 'u_1');
  assert.equal(u1.total, 41, '赛段积分 + MVP 投决积分');
  assert.equal(u1.byKind.stage_rank, 10);
  assert.equal(u1.byKind.mvp, 31);
  assert.equal(on.excludedEntries, 0, 'rollup 行与 atomic 行都已被计入（rollup 决定 total、atomic 进 breakdown）');
  // 1224 式并列：u_2 与 u_4 都是 10 分 → 并列第 3；下一个（u_5，5 分）名次跳到 5
  assert.deepEqual(on.rows.map((r) => r.rank), [1, 2, 3, 3, 5], '同分并列 → 1224（并列后名次跳号）');

  const off = computePersonalPoints({
    ledger, pointsConfig: { ...P, personal: { ...P.personal, lifetime: true, includeMvpVote: false } },
  });
  const u1off = off.rows.find((r) => r.userId === 'u_1');
  assert.equal(u1off.total, 10, '关闭 MVP 投决积分后只剩赛段积分');
  assert.equal(off.excludedEntries, 1, '只有被关掉的 mvp 那一行没被计入');
  assert.equal(off.includeMvpVote, false);
  // 关掉 MVP 投决后 u_1 / u_2 / u_4 都是 10 分 → 三方并列第 2，u_5（5 分）名次跳到 5
  assert.deepEqual(off.rows.map((r) => r.rank), [1, 2, 2, 2, 5], '三方并列 → 同名次，下一名跳号');
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

test('stagePointsFor：只有数组形态的 stagePoints 才认；onlyTopN 与表长相互独立', () => {
  // 非数组 → 不认（不当成表用）
  assert.equal(stagePointsFor(1, { stagePoints: { 0: 10, length: 1 }, stagePointsOnlyTopN: 1 }), 0);
  // onlyTopN 小于表长 → 第 4 名拿不到分（onlyTopN 独立于表长）
  assert.equal(stagePointsFor(4, { stagePoints: [10, 8, 5, 2], stagePointsOnlyTopN: 3 }), 0);
  assert.equal(stagePointsFor(3, { stagePoints: [10, 8, 5, 2], stagePointsOnlyTopN: 3 }), 5);
  // 表项不是数字 → 不认
  assert.equal(stagePointsFor(1, { stagePoints: ['10'], stagePointsOnlyTopN: 1 }), 0);
});

test('computeStagePoints：ordered 里没有 rank 的行，rank 记 null（不是 undefined）', () => {
  const pts = computeStagePoints({ ordered: [{ teamId: 't1' }], pointsConfig: P });
  assert.equal(pts[0].rank, null);
  assert.equal(pts[0].position, 1);
  assert.equal(pts[0].points, 10);
});

test('computeMvp：赛段键按字典序取前 N 个（乱序输入也取对）', () => {
  const out = computeMvp({
    stagePoints: [
      { teamId: 't_a', stageId: 'S3', points: 3 },
      { teamId: 't_a', stageId: 'S1', points: 1 },
      { teamId: 't_a', stageId: 'S5', points: 100 },
      { teamId: 't_a', stageId: 'S2', points: 2 },
      { teamId: 't_a', stageId: 'S4', points: 4 },
    ],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.mvp.stageTotal, 10, '按字典序取 S1..S4 = 1+2+3+4 = 10（S5 的 100 不计）');
});

test('computeMvp：stageId 为 null 的条目不算「带赛段」', () => {
  const out = computeMvp({
    stagePoints: [
      { teamId: 't_a', stageId: null, points: 5 },
      { teamId: 't_a', stageId: 'S1', points: 10 },
    ],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.mvp.stageTotal, 10, 'stageId=null 的条目不参与赛段口径');
});

test('★ computeMvp：路演综合分先折算成路演名次积分再计入（判别性数据集）', () => {
  const out = computeMvp({
    stagePoints: [
      { teamId: 't_a', stageId: 'S1', points: 10 },
      { teamId: 't_b', stageId: 'S1', points: 8 },
      { teamId: 't_c', stageId: 'S1', points: 5 },
    ],
    roadshowScores: [{ teamId: 't_a', score: 50 }, { teamId: 't_b', score: 70 }, { teamId: 't_c', score: 90 }],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  // 路演名次积分：t_c 90 → 10、t_b 70 → 8、t_a 50 → 5（与赛段名次同一把尺子）
  // 综合分：t_a 15 / t_b 16 / t_c 15 → t_b
  assert.equal(out.mvp.teamId, 't_b');
  assert.equal(out.ranked.find((r) => r.teamId === 't_b').roadshowPoints, 8);
  assert.equal(out.ranked.find((r) => r.teamId === 't_c').roadshowPoints, 10);
  // ⚠️ 这个数据集能区分三种实现：
  //    ① 折算成名次积分（正确）→ t_b
  //    ② 把路演原始 0–100 分直接相加 → t_c（5+90=95）
  //    ③ 完全不计路演 → t_a（10）
});

test('★ computeMvp：综合分并列时按路演名次积分决出（不是 team_id 字母序）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 10 }, { teamId: 't_b', stageId: 'S1', points: 8 }],
    roadshowScores: [{ teamId: 't_b', score: 90 }, { teamId: 't_a', score: 50 }],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked[0].score, out.ranked[1].score, '综合分真并列（18 : 18）');
  assert.equal(out.mvp.teamId, 't_b', '路演名次积分高者胜（按 team_id 码位序会选 t_a）');
  assert.deepEqual(out.tiebreak, ['roadshow_points', 'team_id']);
});

test('computeMvp：决胜链可配置；未知键被剔除、缺 team_id 收尾时自动补上', () => {
  const base = {
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 10 }, { teamId: 't_b', stageId: 'S1', points: 8 }],
    roadshowScores: [{ teamId: 't_b', score: 90 }, { teamId: 't_a', score: 50 }],
    packageId: 'tp_1',
  };
  const onlyTeam = computeMvp({ ...base, pointsConfig: { ...P, mvp: { ...P.mvp, tiebreak: ['team_id'] } } });
  assert.equal(onlyTeam.mvp.teamId, 't_a', '决胜链配成只用 team_id → 按码位序');
  const noTail = computeMvp({ ...base, pointsConfig: { ...P, mvp: { ...P.mvp, tiebreak: ['roadshow_points'] } } });
  assert.deepEqual(noTail.tiebreak, ['roadshow_points', 'team_id'], '自动补上 team_id 收尾（确定性兜底）');
  const bogus = computeMvp({ ...base, pointsConfig: { ...P, mvp: { ...P.mvp, tiebreak: ['lottery', 'roadshow_points'] } } });
  assert.deepEqual(bogus.tiebreak, ['roadshow_points', 'team_id'], '未知决胜键被剔除');
});

test('computeMvp：roadshowWeight 配成 2 时路演积分按倍数计入', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }],
    roadshowScores: [{ teamId: 't_a', score: 70 }],
    packageId: 'tp_1',
    pointsConfig: { ...P, mvp: { ...P.mvp, roadshowWeight: 2 } },
  });
  assert.equal(out.mvp.roadshowPoints, 10);
  assert.equal(out.mvp.roadshowContribution, 20);
  assert.equal(out.mvp.score, 25);
});

test('computeMvp：综合分相同时按 teamId 码位序（结果与入参顺序无关）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_b', stageId: 'S1', points: 10 }, { teamId: 't_a', stageId: 'S1', points: 10 }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked.length, 2);
  assert.equal(out.ranked[0].teamId, 't_a');
  assert.equal(out.ranked[0].score, out.ranked[1].score);
});

test('computeMvp：只有路演分、没有赛段积分的队伍也要参与排名', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }],
    roadshowScores: [{ teamId: 't_b', score: 60 }],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked.length, 2);
  assert.equal(out.ranked[0].teamId, 't_b', '只有路演分也拿 10 分路演积分 → 排第一');
  assert.equal(out.ranked[0].stageTotal, 0);
  assert.equal(out.ranked[0].roadshowPoints, 10);
  assert.equal(out.ranked[1].teamId, 't_a');
  assert.equal(out.ranked[1].stageTotal, 5);
});

test('computeMvp：perPackage 配成 0 也至少产出 1 个 MVP（不产出空榜）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 10 }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: { ...P, mvp: { ...P.mvp, perPackage: 0 } },
  });
  assert.equal(out.mvpList.length, 1);
  assert.equal(out.mvp.teamId, 't_a');
});

test('computeMvp：配置缺 mvp 段时按兜底口径（4 赛段 / 权重 1 / 每包 1 个）', () => {
  const out = computeMvp({
    // ⚠️ 至少两支队：perPackage 兜底被改成 2 时，只有 1 支队是测不出来的
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }, { teamId: 't_b', stageId: 'S1', points: 3 }],
    roadshowScores: [{ teamId: 't_a', score: 70 }],
    packageId: 'tp_1',
    pointsConfig: { ...P, mvp: {} },
  });
  assert.equal(out.stagesCounted, 4, '缺配置 → 兜底 4 个赛段');
  assert.equal(out.roadshowWeight, 1, '缺配置 → 兜底权重 1');
  assert.equal(out.mvpList.length, 1, '缺配置 → 兜底每包 1 个 MVP');
  assert.equal(out.mvp.teamId, 't_a');
  assert.equal(out.mvp.score, 15, '5 赛段积分 + 10 路演积分');
});

test('computeMvp：路演分里没有 teamId 的条目不参与排名（不产出无名队伍）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }],
    roadshowScores: [{ teamId: 't_a', score: 70 }, { score: 50 }],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked.length, 1);
  assert.equal(out.ranked[0].teamId, 't_a');
  assert.equal(out.ranked[0].roadshowPoints, 10, 't_a 是唯一有效路演条目 → 第 1 位');
});

test('computeMvp：积分字段缺值 / 非数字按 0 计（不产生 NaN）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 7 }, { teamId: 't_a', stageId: 'S2' }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.mvp.stageTotal, 7, '缺 points 的条目按 0 计');
  assert.ok(Number.isFinite(out.mvp.score));
});

test('computePersonalPoints：lifetime=false 原样透出（不擅自改口径）', () => {
  const out = computePersonalPoints({
    ledger: [{ id: 'l1', userId: 'u_1', kind: 'stage_rank', points: 10 }],
    pointsConfig: { ...P, personal: { lifetime: false, includeMvpVote: true } },
  });
  assert.equal(out.lifetime, false);
});

test('computePersonalPoints：同 kind 的多条记录按 kind 累加（不是后一条覆盖前一条）', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', userId: 'u_x', kind: 'stage_rank', points: 10 },
      { id: 'l2', userId: 'u_x', kind: 'stage_rank', points: 5 },
    ],
    pointsConfig: P,
  });
  assert.equal(out.rows[0].total, 15);
  assert.equal(out.rows[0].byKind.stage_rank, 15);
});

test('computePersonalPoints：同分时按 userId 码位序稳定排序（不靠入参顺序）', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', userId: 'u_b', kind: 'stage_rank', points: 10 },
      { id: 'l2', userId: 'u_a', kind: 'stage_rank', points: 10 },
    ],
    pointsConfig: P,
  });
  assert.deepEqual(out.rows.map((r) => r.userId), ['u_a', 'u_b']);
});

test('computePersonalPoints：无 userId 的条目不参与累加；口径外的 kind 不计入并告警', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', kind: 'stage_rank', points: 5 },          // 没有 userId → 跳过
      { id: 'l2', userId: 'u_1', points: 7 },              // 没有 kind → unknown（不在白名单里）
      { id: 'l3', userId: 'u_2' },                         // 缺 points → 按 0 计
    ],
    pointsConfig: P,
  });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].userId, 'u_1');
  // ⚠️ 口径（P5 修复轮 I-3 统一后）：口径外的 kind **不计入**（原来本函数是「任何 kind 都计入」）
  assert.equal(out.rows[0].total, 0, 'unknown 不在白名单里 ⇒ 不计入（不是 7）');
  assert.deepEqual(out.rows[0].byKind, {}, '没被计入的 kind 不进 byKind');
  assert.equal(out.rows[1].userId, 'u_2');
  assert.equal(out.rows[1].total, 0, '缺 points 按 0 计（不产生 NaN）');
  assert.equal(out.excludedEntries, 3, '三行都没被计入：l1 无 userId、l2 与 l3 的 kind 是 unknown');
  assert.ok(
    out.warnings.some((w) => w.code === 'points_kind_ignored' && w.userId === 'u_1' && w.kind === 'unknown'),
    '口径外的 kind 必须显式告警（不静默），且 kind 要能看出是什么',
  );
});

test('★ computePrizeShares：奖金表缺该名次时按 0 计（总额不产生 NaN）', () => {
  const out = computePrizeShares({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 1 }],
    prizeTable: { 1: 10000 },
  });
  assert.equal(out.totalPool, 10000, '第 2 名奖金表里没有 → 按 0 计');
  assert.equal(out.shares[0].share, 5000);
  assert.ok(Number.isFinite(out.totalPool));
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
 * MVP 综合分并列时的决胜键（有序）。
 * ⚠️ 口径来源：任务书 §七只给了「4 赛段总积分 + S4 路演评审综合」的**加法**公式，
 *    没写综合分并列怎么办；但 S10 §0.3「互评的真正用途是破同分」+ §4「行为分用于同分垫底排序」
 *    确立了本赛事的通则：**同分必须用实质依据决出，不许用字母序**。
 *    因此默认决胜链 = 路演名次积分（高者胜，仍是评审实质依据）→ team_id 码位序（确定性兜底）。
 *    可由 rules/criteria.json.mvp.tiebreak 配置（顺序即优先级）。
 */
export const MVP_TIEBREAK_KEYS = ['roadshow_points', 'team_id'];

/** 决胜链规范化：只认已知键、去重、强制以 team_id 收尾（确定性兜底，跨机器可复算） */
function normalizeTiebreak(raw) {
  const out = [];
  for (const k of Array.isArray(raw) ? raw : MVP_TIEBREAK_KEYS) {
    if (MVP_TIEBREAK_KEYS.includes(k) && !out.includes(k)) out.push(k);
  }
  if (!out.includes('team_id')) out.push('team_id');
  return out;
}

/**
 * MVP：4 赛段总积分 + S4 路演评审综合，每个任务包 1 个（任务书 §七 + 设计文档 §6.3 + R-RNK-09）。
 * - stagePoints: [{ teamId, stageId?, points }]，带 stageId 时只取前 stagesCounted 个赛段
 * - roadshowScores: [{ teamId, score }]，S4 路演评审综合分（0–100）
 * 路演综合分先折算成【路演名次积分】（与赛段名次同一 10/8/5 口径），再乘 roadshowWeight
 * 计入总分 —— 两部分量纲一致，不需要另造一套权重。
 * ⚠️ 调用方必须只传【本任务包】的队伍：路演名次积分是「包内第几名」，
 *    混进别的包的队伍会挤掉本包真冠军（P3-27）。
 */
export function computeMvp({ stagePoints, roadshowScores, packageId, pointsConfig }) {
  const mvpCfg = pointsConfig?.mvp || {};
  const stagesCounted = Number.isFinite(mvpCfg.stagesCounted) ? mvpCfg.stagesCounted : 4;
  const roadshowWeight = Number.isFinite(mvpCfg.roadshowWeight) ? mvpCfg.roadshowWeight : 1;
  const perPackage = Number.isFinite(mvpCfg.perPackage) ? mvpCfg.perPackage : 1;
  const tiebreak = normalizeTiebreak(mvpCfg.tiebreak);

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
  //    ⚠️ 候选集 = 赛段积分有分的队 ∪ 路演有分的队；调用方保证路演分只含本包队伍。
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
  }).sort((a, b) => compareMvp(a, b, tiebreak));

  const winners = ranked.slice(0, Math.max(1, perPackage));
  return {
    packageId: packageId ?? null,
    stagesCounted,
    roadshowWeight,
    tiebreak,
    mvp: winners[0] ?? null,
    mvpList: winners,
    ranked,
  };
}

/** MVP 排序比较：综合分降序 → 决胜链依次比较 → team_id 码位序 */
function compareMvp(a, b, tiebreak) {
  if (b.score !== a.score) return b.score - a.score;
  for (const key of tiebreak) {
    if (key === 'roadshow_points') {
      if (b.roadshowPoints !== a.roadshowPoints) return b.roadshowPoints - a.roadshowPoints;
    } else if (key === 'team_id') {
      const c = cmpStr(a.teamId, b.teamId);
      if (c !== 0) return c;
    }
  }
  return 0;
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
  let curRank = 0;
  for (const r of rows) {
    if (prev === null || r.total !== prev) {
      prev = r.total;
      curRank = before + 1;     // 1224 式：名次 = 本组之前的行数 + 1（并列占位，名次跳号）
    }
    r.rank = curRank;           // ⛔ 并列的行**也必须**拿到名次
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

Run: `cd platform && node --test test/points.test.js` → Expected: PASS（**27** 个测试全过：points.test.js 27 —— 规格自带 7 + 预审补测 1 + 变异检验补测 16 + Task 7 补测 3；变异体 45 → KILLED 43 / 等价 2 / 有效缺口 0；Task 7 后追加 5 个变异体（W31–W35）→ 全部 KILLED）

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

test('段位的展示字段：tierName / reasons / benefits / neverUnlocks 都来自配置', () => {
  const out = computeTier({ milestones: ms(['problem_confirmed', 'data_connected', 'demo_ready']), signoffs: [], ranksConfig: R });
  assert.equal(out.tier, 'A');
  assert.equal(out.tierName, '接入', 'tierName 来自配置的中文名');
  assert.deepEqual(out.benefits, R.benefits.A);
  assert.deepEqual(out.neverUnlocks, ['奖金', '决赛名次']);
  assert.deepEqual(out.reasons, ['milestones=3', 'data_or_prototype=2', 'tier=A']);

  const d = computeTier({ milestones: [], signoffs: [], ranksConfig: R });
  assert.equal(d.tierName, '出题');
  assert.deepEqual(d.benefits, [], 'D 段配置里没有权益 → 空数组（不是 undefined）');
  assert.deepEqual(d.reasons, ['milestones=0', 'tier=D'], '没有数据接入时不得凭空出现该理由');
});

test('配置缺字段时的容错：段位名 / 权益 / neverUnlocks 都不许是 undefined', () => {
  const custom = { tiers: [{ key: 'D', name: 'D 档', minMilestones: 0 }] };
  const out = computeTier({ milestones: [], signoffs: [], ranksConfig: custom });
  assert.equal(out.tier, 'D');
  assert.equal(out.tierName, 'D 档', '段位名来自配置，不许退回硬编码');
  assert.deepEqual(out.benefits, []);
  assert.deepEqual(out.neverUnlocks, [], '配置缺 neverUnlocks → 空数组');
});

test('★ 里程碑的取值口径：achieved 必须是 true、countsTowardTier 缺省计入', () => {
  const out = computeTier({
    milestones: [
      { key: 'problem_confirmed', achieved: true },                  // 缺 countsTowardTier → 计入
      { key: 'data_connected', achieved: 1, isDataOrPrototype: true }, // achieved=1 不是 true → 不计入
      { key: 'demo_ready', achieved: true, isDataOrPrototype: true },
    ],
    signoffs: [], ranksConfig: R,
  });
  assert.equal(out.milestoneCount, 2, 'achieved=1 不是布尔 true → 不计入；缺 countsTowardTier → 计入');
  assert.equal(out.tier, 'B', '2 个里程碑 → B 段（D0 / C1 / B2 / A3 / S5）');
});

test('缺 milestones / signoffs 参数时按空集处理（不崩）', () => {
  const out = computeTier({ signoffs: [], ranksConfig: R });
  assert.equal(out.tier, 'D');
  assert.equal(out.milestoneCount, 0);
  const out2 = computeTier({ milestones: ms(FIVE), ranksConfig: R });
  assert.equal(out2.tier, 'A', '没有 signoffs → 最高只到 A');
  assert.equal(out2.businessSignoffCount, 0);
});

test('部门归类的容错：大小写、配置里的大写关键词、缺 tier 段', () => {
  assert.equal(classifyDepartment('BUSINESS', C), 'business', '关键词大小写不敏感');
  assert.equal(classifyDepartment('biz', { tier: { businessDepartmentKeywords: ['BIZ'] } }), 'business',
    '配置里的大写业务关键词也要能匹配');
  assert.equal(classifyDepartment('tech', { tier: { technicalDepartmentKeywords: ['TECH'] } }), 'technical',
    '配置里的大写技术关键词也要能匹配');
  assert.equal(classifyDepartment('业务部门', {}), 'unknown', '配置缺 tier 段 → 一律 unknown');
  assert.equal(classifyDepartment(undefined, C), 'unknown');
  assert.equal(isDataOrPrototypeMilestone('data_connected', {}), false, '配置缺 tier 段 → 不认任何里程碑');
});

test('★ 没标 isBusinessDepartment 的签字不得算业务签字（S 段不得凭空达标）', () => {
  const out = computeTier({
    milestones: ms(FIVE),
    signoffs: [{ milestoneKey: 'pilot_contract', department: '某部门', revokedAt: null }],   // 没有 isBusinessDepartment
    ranksConfig: R,
  });
  assert.equal(out.businessSignoffCount, 0, '标志位缺失 ≠ 业务部门');
  assert.equal(out.tier, 'A', 'S 段不得凭空达标');
});

test('★ 降级：两条规则同时命中时只降 1 档，原因两条都记', () => {
  const both = applyTierDemotion({
    tier: 'S', daysSinceLastActivity: 14,
    revokedSignoffs: [{ milestoneKey: 'pilot_contract', revokedAt: '2026-10-20T00:00:00Z' }],
    ranksConfig: R,
  });
  assert.equal(both.demoted, true);
  assert.equal(both.tier, 'A', '只降 1 档（不叠加）');
  assert.equal(both.reason, 'signoff_revoked+inactive_14days', '两条原因都要记');
});

test('降级的配置口径：onSignoffRevoked / inactiveDays / inactiveDropLevels / publishDemotion 都要生效', () => {
  const base = { tiers: R.tiers, demotion: { ...R.demotion } };

  const noRevoke = applyTierDemotion({
    tier: 'S', daysSinceLastActivity: 0,
    revokedSignoffs: [{ revokedAt: 'x' }],
    ranksConfig: { ...base, demotion: { ...base.demotion, onSignoffRevoked: false } },
  });
  assert.equal(noRevoke.demoted, false, '配置关掉撤回降级 → 不降');

  const noPublish = applyTierDemotion({
    tier: 'B', daysSinceLastActivity: 14, revokedSignoffs: [],
    ranksConfig: { ...base, demotion: { ...base.demotion, publishDemotion: false } },
  });
  assert.equal(noPublish.demoted, true);
  assert.equal(noPublish.publish, false, '配置关掉公示 → 不公示');

  const missing = applyTierDemotion({
    tier: 'B', daysSinceLastActivity: 14, revokedSignoffs: [],
    ranksConfig: { tiers: R.tiers, demotion: {} },
  });
  assert.equal(missing.demoted, true, '配置缺 inactiveDays → 兜底 14 天');
  assert.equal(missing.tier, 'C', '配置缺 inactiveDropLevels → 兜底降 1 档');
  assert.ok(missing.reason.includes('inactive_14days'));

  const twoLevels = applyTierDemotion({
    tier: 'C', daysSinceLastActivity: 14, revokedSignoffs: [],
    ranksConfig: { ...base, demotion: { ...base.demotion, inactiveDropLevels: 2 } },
  });
  assert.equal(twoLevels.tier, 'D', '配置降 2 档 → 从 C 降到 D（不越界到 D 以下）');
});

test('降级：未命中的段位名回落到最低档，且不下探到 D 以下', () => {
  const unknown = applyTierDemotion({ tier: 'X', daysSinceLastActivity: 0, revokedSignoffs: [], ranksConfig: R });
  assert.equal(unknown.from, 'D', '未知段位按最低档处理');
  assert.equal(unknown.demoted, false);

  const floor = applyTierDemotion({ tier: 'D', daysSinceLastActivity: 99, revokedSignoffs: [{ revokedAt: 'x' }], ranksConfig: R });
  assert.equal(floor.tier, 'D', 'D 段是地板');
  assert.equal(floor.from, 'D');

  const notYet = applyTierDemotion({ tier: 'B', daysSinceLastActivity: 13, revokedSignoffs: [], ranksConfig: R });
  assert.equal(notYet.demoted, false);
  assert.equal(notYet.reason, null, '没降级时原因必须是 null');
  assert.equal(notYet.publish, false);
  assert.equal(notYet.from, 'B');
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

Run: `cd platform && node --test test/tier.test.js` → Expected: PASS（**16** 个测试全过：tier.test.js 16 —— 规格自带 7 + 变异检验补测 9；变异体 40 → KILLED 34 / 等价 6 / 有效缺口 0）

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

test('★ 隔离断言：完全同分时行为分只当破同分用 —— 可比较时拆开、不可比较时保持并列', () => {
  const r = rankTeams({
    teams: [
      { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: 1 },
      { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: 99 },
    ],
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_b', 't_a'], '行为分高者在前');
  // ⚠️ 行为分是链上的**实质依据**（scope=tied_only、非 deterministic）→ 可比较时【拆开并列】，
  //    名次变成 1、2。只有链末的 team_id（deterministic:true）才是「只排序不拆组」。
  //    规格原写法期望 [1,1]（以为行为分不拆组）—— 与 R-PTS-08「同分时的最后排序依据」矛盾。
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 2], '行为分可用时把并列拆开 → 名次 1、2');

  // 行为分不可比较（缺值）→ 该键在本组不可用 → 保持并列，名次仍是 1、1
  const tie = rankTeams({
    teams: [
      { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: null },
      { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: null },
    ],
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  assert.deepEqual(tie.ordered.map((o) => o.rank), [1, 1], '行为分不可用 → 保持并列');
  assert.ok(tie.warnings.some((w) => w.code === 'tiebreak_key_unusable'), '键不可用必须显式告警，不静默');
});

test('★ 证据边界：缺证据 / 非 JSON / 非对象 / oneOf 全不满足', () => {
  const missing = behaviorScore({ events: [ev('weekly_progress', { evidence: null })], behaviorConfig: B });
  assert.equal(missing.total, 0);
  assert.equal(missing.items[0].reason, 'missing_evidence');

  const empty = behaviorScore({ events: [ev('weekly_progress', { evidence: '' })], behaviorConfig: B });
  assert.equal(empty.items[0].reason, 'missing_evidence');

  const notObject = behaviorScore({ events: [ev('weekly_progress', { evidence: '123' })], behaviorConfig: B });
  assert.equal(notObject.total, 0);
  assert.equal(notObject.items[0].reason, 'evidence_not_object', 'JSON 但不是对象 → 不认');

  const array = behaviorScore({ events: [ev('weekly_progress', { evidence: '[1,2]' })], behaviorConfig: B });
  assert.equal(array.items[0].reason, 'evidence_not_object', '数组也不是对象 → 不认');

  const none = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', version: 'v1' }) })],
    behaviorConfig: B,
  });
  assert.equal(none.total, 0, '既没有 artifact 也没有 blocker → 不给分');
  assert.equal(none.items[0].reason, 'evidence_missing_any_of_artifact_or_blocker');
});

test('once 事件：证据不合格的提交【不占用】once 名额', () => {
  const cfg = {
    ...B,
    events: B.events.map((e) => (e.key === 'first_demo' ? { ...e, requiresEvidence: true } : e)),
    evidenceRequirements: { first_demo: { required: ['artifact'], oneOf: [] } },
  };
  const out = behaviorScore({
    events: [
      ev('first_demo', { created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({}) }),
      ev('first_demo', { created_at: '2026-10-11T00:00:00.000Z', evidence: JSON.stringify({ artifact: 'demo.zip' }) }),
    ],
    behaviorConfig: cfg,
  });
  assert.equal(out.items[0].counted, false, '证据不合格 → 0 分');
  assert.equal(out.items[1].counted, true, '不合格的那次不占用 once 名额，后面合格的可计分');
  assert.equal(out.total, 10);
});

test('行为分配置的兜底：缺阈值/缺占比/缺 sortUse 时如实返回 null', () => {
  const out = behaviorScore({ events: [], behaviorConfig: {} });
  assert.equal(out.total, 0);
  assert.equal(out.completionThreshold, 60, '缺阈值 → 兜底 60');
  assert.equal(out.maxWeightShare, null);
  assert.equal(out.sortUse, null, '配置没写就是 null（不硬编一个值出来）');
  assert.equal(out.completed, false);

  const noArgs = behaviorScore({ behaviorConfig: B });
  assert.equal(noArgs.total, 0, '连 events 都不传 → 空集，不崩');
  assert.equal(noArgs.items.length, 0);
});

test('★ 证据对象形态：evidence 已经是对象时不必再是 JSON 字符串', () => {
  const out = behaviorScore({
    events: [ev('weekly_progress', { evidence: { repo: 'r', version: 'v1', artifact: 'a.zip' } })],
    behaviorConfig: B,
  });
  assert.equal(out.total, 2, '对象形态的证据同样认');
  assert.equal(out.items[0].counted, true);
});

test('证据要求：没写 required / oneOf 的规则不得崩', () => {
  const cfg = { ...B, evidenceRequirements: { weekly_progress: {} } };
  const out = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ anything: 1 }) })],
    behaviorConfig: cfg,
  });
  assert.equal(out.total, 2, '没有必填字段 → 不拦');
});

test('★ 空白值不算有效证据（trim 后为空）', () => {
  const blank = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: '   ', version: 'v1', artifact: 'a' }) })],
    behaviorConfig: B,
  });
  assert.equal(blank.total, 0);
  assert.equal(blank.items[0].reason, 'evidence_missing_repo', '全是空白的 repo 视为没填');

  const blankBlocker = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', version: 'v1', blocker: '   ' }) })],
    behaviorConfig: B,
  });
  assert.equal(blankBlocker.total, 0);
  assert.equal(blankBlocker.items[0].reason, 'evidence_missing_any_of_artifact_or_blocker');
});

test('事件配置缺 points 时按 0 计（不产生 NaN）', () => {
  const cfg = { ...B, events: [{ key: 'weekly_progress', label: '每周进度' }] };
  const out = behaviorScore({ events: [ev('weekly_progress')], behaviorConfig: cfg });
  assert.equal(out.total, 0);
  assert.ok(Number.isFinite(out.total));
});

test('★ 达标线是「≥」不是「>」：刚好到线算完赛', () => {
  const cfg = { ...B, completionThreshold: 25 };
  const out = behaviorScore({
    events: [
      ev('weekly_progress'), ev('workshop_output', { evidence: JSON.stringify({ output: 'o' }) }),
      ev('milestone_on_time'), ev('enterprise_meeting', { evidence: JSON.stringify({ enterpriseConfirmationId: 'e' }) }),
      ev('first_demo'),
    ],
    behaviorConfig: cfg,
  });
  assert.equal(out.total, 25);
  assert.equal(out.completed, true, '刚好 25 = 达标（>=）');
});

test('★ 事件按创建时间升序处理；同一时刻按 id 兜底（顺序可复现）', () => {
  const out = behaviorScore({
    events: [
      ev('first_demo', { created_at: '2026-10-11T00:00:00.000Z', evidence: JSON.stringify({ artifact: 'ok.zip' }) }),
      ev('first_demo', { created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({}) }),
    ],
    behaviorConfig: { ...B, evidenceRequirements: { ...{}, first_demo: { required: ['artifact'], oneOf: [] } } },
  });
  assert.deepEqual(out.items.map((i) => i.counted), [false, true], '早的那条先判 → 早的不合格不算占用 once');
  assert.equal(out.total, 10);

  const same = behaviorScore({
    events: [
      { id: 'e_b', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({ repo: 'r', version: 'v', artifact: 'a' }) },
      { id: 'e_a', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({ repo: 'r', version: 'v', artifact: 'a' }) },
    ],
    behaviorConfig: B,
  });
  assert.deepEqual(same.items.map((i) => i.type), ['weekly_progress', 'weekly_progress']);
  // ⚠️ `weekly_progress` 现在带**周期约束**（7 天 1 次，F38）⇒ 同一时刻的两条只计第一条。
  //    夹具跟着新契约走，但**判别性变强了**：现在能直接断言「哪一条被计分」⇒
  //    钉住的正是「同一时刻按 id 码位序」这条口径（e_a < e_b ⇒ e_a 先判 ⇒ e_a 计分）。
  assert.equal(same.total, 2, '同一时刻的两条 weekly_progress 只计第一条（周期约束）');
  assert.equal(same.items.find((i) => i.counted).id, 'e_a', '同一时刻按 id 码位序 ⇒ e_a 先判 ⇒ e_a 计分');
  assert.equal(same.items.find((i) => !i.counted).reason, 'cadence_limit');
});

test('★ 排序口径：先按创建时间，同一时刻再按 id 码位序（两条都要钉住）', () => {
  const byTime = behaviorScore({
    events: [
      { id: 'e_1', type: 'milestone_on_time', created_at: '2026-10-11T00:00:00.000Z', evidence: OK },
      { id: 'e_2', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: OK },
    ],
    behaviorConfig: B,
  });
  assert.deepEqual(byTime.items.map((i) => i.type), ['weekly_progress', 'milestone_on_time'],
    '按创建时间升序（不是按 id）');

  const byId = behaviorScore({
    events: [
      { id: 'e_2', type: 'milestone_on_time', created_at: '2026-10-10T00:00:00.000Z', evidence: OK },
      { id: 'e_1', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: OK },
    ],
    behaviorConfig: B,
  });
  assert.deepEqual(byId.items.map((i) => i.type), ['weekly_progress', 'milestone_on_time'],
    '同一时刻按 id 码位序兜底（e_1 < e_2）');
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
 * 次数约束（F38）：一个行为事件**最多能计几次分**。
 *
 * ⚠️ **修复前的病根**：5 个事件里只有 `first_demo` 有 `once` ⇒ 其余 4 个**无上限**
 *    ⇒ 提交 40 次 `weekly_progress` = 80 分 ⇒ **超过完赛线 60**
 *    ⇒ 「完赛认定」可在一分钟 API 调用内达成 ⇒ 而行为分是破同分链的**倒数第二个键**
 *    ⇒ 刷行为分 ⇒ 决定同分队伍的排名 ⇒ 决定 10/8/5 的赛段积分 ⇒ **决定钱**。
 *
 * ⛔ **口径**（写在规则文件里，代码只执行它）：
 *   · `once: true` **且无 cadence** ⇒ **终身一次**（reason: `once_limit`）
 *   · `once: true` **且有 cadence** ⇒ 每个滚动窗口内最多 `maxCount` 次
 *     （reason: `cadence_limit`）—— 「每周提交一次进度」真的按**周**算，
 *     而不是「一次性事件」也不是「无限次」。
 *
 * ⚠️ 为什么用**滚动窗口**而不是「自然周」：自然周要定时区（跨时区队伍会差一天），
 *    而滚动窗口只依赖事件自身的时间戳 ⇒ **可复算**（R-AUD-01）。
 *
 * @returns {{max:number, windowMs:number|null}|null} null = 无次数约束
 */
function countLimitOf(def) {
  if (!def?.once) return null;
  const cadence = def.cadence ?? null;
  if (!cadence) return { max: 1, windowMs: null };
  const maxCount = Number.isInteger(cadence.maxCount) && cadence.maxCount > 0 ? cadence.maxCount : 1;
  const windowDays = Number.isFinite(cadence.windowDays) && cadence.windowDays > 0 ? cadence.windowDays : null;
  return { max: maxCount, windowMs: windowDays === null ? null : windowDays * 86_400_000 };
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

  /** 已计分事件的时间戳（按 key）—— 用于次数约束（F38） */
  const countedAt = new Map();
  const items = [];
  let total = 0;
  for (const ev of sorted) {
    const type = ev?.type;
    const def = byKey.get(type);
    if (!def) {
      // 未知类型（如"签到"）→ 0 分并明确记录，不静默（R-PTS-10 反作弊第 1 条）
      items.push({ id: ev?.id ?? null, type, points: 0, label: String(type), counted: false, reason: 'unknown_event_type' });
      continue;
    }
    const limit = countLimitOf(def);
    if (limit) {
      const atMs = Date.parse(ev?.created_at ?? '');
      const times = countedAt.get(def.key) ?? [];
      // ⛔ 时间戳坏掉 ⇒ **不猜**：按「无法归入任何窗口」处理 ⇒ 不计分（宁可漏一分也不可无限刷）
      if (!Number.isFinite(atMs)) {
        items.push({ id: ev?.id ?? null, type: def.key, points: 0, label: def.label, counted: false, reason: 'cadence_unknown_time' });
        continue;
      }
      const inWindow = limit.windowMs === null
        ? times.length
        : times.filter((t) => atMs - t < limit.windowMs).length;
      if (inWindow >= limit.max) {
        items.push({
          id: ev?.id ?? null, type: def.key, points: 0, label: def.label, counted: false,
          reason: limit.windowMs === null ? 'once_limit' : 'cadence_limit',
        });
        continue;
      }
    }
    const check = checkEvidence(def, ev, requirements);
    if (!check.ok) {
      items.push({ id: ev?.id ?? null, type: def.key, points: 0, label: def.label, counted: false, reason: check.reason });
      continue;
    }
    if (limit) {
      const times = countedAt.get(def.key) ?? [];
      times.push(Date.parse(ev.created_at));
      countedAt.set(def.key, times);
    }
    const pts = Number(def.points) || 0;
    total += pts;
    items.push({ id: ev?.id ?? null, type: def.key, points: pts, label: def.label, counted: true, reason: null });
  }
  return {
    total,
    items,
    completed: total >= threshold,          // R-PTS-09：达标线 60 → 完赛认定
    completionThreshold: threshold,
    maxWeightShare: cfg.maxWeightShare ?? null,
    sortUse: cfg.sortUse ?? null,           // 取自配置；配置层 fail-fast 校验它必须是 'tiebreak_only'（R-PTS-08）
  };
}
```

- [ ] **Step 3b: 修改 src/config.js（行为分 `sortUse` 的 fail-fast 校验）**

在 `validateRules` 的「── 行为分 ──」段里（`behavior.completionThreshold` 校验之后、`behavior.events` 校验之前）追加：

```javascript
    // ⚠️ sortUse **不是可配置项**，它是 R-PTS-08 的硬保证：行为分只能做破同分，
    //    绝不能变成主评分（决赛名次 0% / 奖金 0%）。
    //    链不变量里的那处检查（assertChainInvariants）在生产链路上【拿不到 behaviorConfig】，
    //    属于「建好却从不校验」的同款病根 —— 所以必须在这里 fail-fast：
    //    配置被改成 'primary' 之类的值时**拒绝启动**，而不是带着违规口径上线。
    if (behavior.sortUse !== 'tiebreak_only') {
      push('behavior.sortUse 必须是 tiebreak_only（R-PTS-08：行为分只做破同分，不进总分/奖金）');
    }
```

> **为什么必须在这里校验**：全仓唯一检查 `sortUse` 的地方是 `assertChainInvariants`，
> 而它的签名里**没有 behaviorConfig 参数**（`rankTeams({teams, tiebreakChain, tiebreakData, pointsConfig})`
> 是契约定死的），生产链路**拿不到**这个值 → 那处检查**永远不生效**。
> 与 P2 终审 I-2（`checkJudgePool` 零调用方）同款：能力建好了却从不调用。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/behavior.test.js` → Expected: PASS（**15** 个测试全过：behavior.test.js 15 —— 规格自带 5 + 预审补测 1 + 变异检验补测 9；变异体 28 → KILLED 28 / 等价 0 / 有效缺口 0）

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
    // ⚠️ D 队行刻意带一个通用的 `rank` 字段：段位榜的排名字段是 `tierRank`，
    //    但 payload 未必不会带通用 `rank` → 本人进度卡必须把它一起剔掉。
    { teamId: 't_d', teamName: 'D队', tier: 'D', tierRank: 9, rank: 9, enterpriseName: '丙公司', progress: { done: 0, total: 7 } },
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

test('★ 默认口径必须是【关】：配置漏写时也不公示（fail-closed）', () => {
  // 互评来源：配置里没有 peerReview 段 → 仍然不公示
  const peer = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', peerSource: 't_x', fromTeamId: 't_x', fromUserId: 'u_7', peerScore: 5 }],
  }, { scope: 'rank' }, null, { ...V, peerReview: undefined });
  for (const k of ['peerSource', 'fromTeamId', 'fromUserId', 'peerScore']) {
    assert.equal(peer.rows[0][k], undefined, `配置漏写 peerReview 时 ${k} 仍不公示`);
  }

  // 企业名：配置里没有 rank 段 → 仍然不公示
  const ent = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', enterpriseName: '某某公司', enterpriseId: 'e_1' }],
  }, { scope: 'rank' }, null, { ...V, rank: undefined });
  assert.equal(ent.rows[0].enterpriseName, undefined, '配置漏写 rank 时企业名仍不公示');
  assert.equal(ent.rows[0].enterpriseId, undefined);

  // B 榜评分：配置里没有 business 段 → 仍然不公示
  const biz = apply({
    scope: 'business',
    rows: [{ teamId: 't_a', score: 88, signatory: '张三', signatoryUserId: 'u_9' }],
  }, { scope: 'business' }, null, { ...V, business: undefined });
  assert.equal(biz.rows[0].score, undefined, '配置漏写 business 时评分仍不公示');
  assert.equal(biz.rows[0].signatory, undefined, '配置漏写 business 时签字人仍不公示');

  // 段位公示起点：配置里没有 publicFromTier → 仍按 C 段起公示（D 段不公示）
  const tier = apply(tierPayload(), { scope: 'tier' }, null, { ...V, rank: { ...V.rank, publicFromTier: undefined } });
  assert.deepEqual(tier.rows.map((r) => r.teamId), ['t_s', 't_a'], '漏写 publicFromTier 时仍按 C 段起公示');
});

test('过滤的输入输出边界：scope 兜底、空 rows、payload 其他字段保留', () => {
  // scope 优先取 context；context 没有就取 payload.scope
  const fromPayload = applyVisibility({
    payload: { scope: 'business', rows: [{ teamId: 't_a', signatory: '张三' }] },
    viewer: null, visibilityConfig: V, context: {},
  });
  assert.equal(fromPayload.rows[0].signatory, undefined, 'scope 从 payload 取时也要按 B 榜口径过滤');

  // payload 没有 rows → 空集，不崩
  const empty = applyVisibility({ payload: { scope: 'rank' }, viewer: null, visibilityConfig: V, context: { scope: 'rank' } });
  assert.deepEqual(empty.rows, []);

  // payload 的其他字段（scope / warnings 等）必须原样带出
  const kept = apply({
    scope: 'rank', warnings: [{ code: 'x' }], editionId: 'e_1',
    rows: [{ teamId: 't_a', rank: 1 }],
  }, { scope: 'rank' });
  assert.equal(kept.scope, 'rank');
  assert.equal(kept.editionId, 'e_1');
  assert.deepEqual(kept.warnings, [{ code: 'x' }]);
});

test('段位榜：段位顺序取自上下文、旁观者拿不到任何进度卡、本人卡片不含名次', () => {
  const byOrder = apply(tierPayload(), { scope: 'tier', tierOrder: ['D', 'C', 'B', 'A', 'S'] });
  assert.deepEqual(byOrder.rows.map((r) => r.teamId), ['t_s', 't_a']);

  // 段位顺序真的取自上下文（换个顺序 → 公示边界跟着变）
  const custom = apply(tierPayload(), { scope: 'tier', tierOrder: ['C', 'B', 'A', 'S', 'D'] });
  assert.deepEqual(custom.rows.map((r) => r.teamId), ['t_s', 't_a', 't_d'],
    'C 排在首位时公示起点变成最低档 → D 也公示');

  // viewerTeamIds（本人可能在多支队里）也要认
  const multi = apply(tierPayload(), { scope: 'tier', viewerTeamIds: ['t_d'] }, { id: 'u_1' });
  assert.equal(multi.selfProgress?.teamId, 't_d', 'context.viewerTeamIds 也要认');

  const stranger = apply(tierPayload(), { scope: 'tier' });
  assert.equal(stranger.selfProgress, undefined, '旁观者拿不到任何人的进度卡');

  // viewer 自带 teamId 时也认（不只认 context.viewerTeamId）
  const byViewer = apply(tierPayload(), { scope: 'tier' }, { id: 'u_1', teamId: 't_d' });
  assert.equal(byViewer.selfProgress?.teamId, 't_d', 'viewer.teamId 也要认');

  const self = apply(tierPayload(), { scope: 'tier', viewerTeamId: 't_d' }, { id: 'u_1' });
  assert.equal(self.selfProgress.tierRank, undefined, '本人进度卡不含段位名次');
  assert.equal(self.selfProgress.teamName, undefined, '本人进度卡不含队名');

  const noProgress = apply({
    scope: 'tier',
    rows: [{ teamId: 't_d', teamName: 'D队', tier: 'D', tierRank: 9 }],
  }, { scope: 'tier', viewerTeamId: 't_d' }, { id: 'u_1' });
  assert.equal(noProgress.selfProgress.progress, null, '没有进度时给 null（不是 undefined）');
});

test('B 榜也清互评来源；个人榜清密码哈希；未知 scope 也清互评来源', () => {
  const biz = apply({
    scope: 'business',
    rows: [{ teamId: 't_a', score: 88, peerSource: 't_x', fromTeamId: 't_x', peerScore: 5 }],
  }, { scope: 'business' });
  for (const k of ['peerSource', 'fromTeamId', 'peerScore']) {
    assert.equal(biz.rows[0][k], undefined, `B 榜的 ${k} 也要清`);
  }

  const personal = apply({
    scope: 'personal',
    rows: [{ userId: 'u_1', name: '张三', total: 41, phone: '13800000000', org: '某公司', idCard: '310', password_hash: 'x' }],
  }, { scope: 'personal' }, { id: 'u_1' });
  for (const k of ['phone', 'org', 'idCard', 'password_hash']) {
    assert.equal(personal.rows[0][k], undefined, `个人榜的 ${k} 要清`);
  }

  const unknown = apply({
    scope: 'whatever',
    rows: [{ teamId: 't_a', peerSource: 't_x', peerScore: 5 }],
  }, { scope: 'whatever' });
  assert.equal(unknown.rows[0].peerSource, undefined, '未知 scope 也要清互评来源');
  assert.equal(unknown.rows[0].peerScore, undefined);
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
//   ⛔ **告警的内部明细也是可见性问题**（DP-107）：`detail`（评委 id + 内部原因码 +
//      队伍 id / 英文维度键）只给有 `audit:read` 的人看。裁剪放在**这个唯一入口**里，
//      演示站（web/api.demo.js）与正式站（src/services/leaderboard.js）因此**自动同口径**
//      —— 以前两处各写一份，演示站把内部明细泄给了匿名访客。
import { omit } from './util.js';

const DEFAULT_TIER_ORDER = ['D', 'C', 'B', 'A', 'S'];
// 互评来源字段：visibility.peerReview.showSource=false 时清空
const PEER_SOURCE_KEYS = ['peerSource', 'fromTeamId', 'fromUserId', 'peerFrom', 'peerScore'];
// 企业名字段：段位公示时不公示（S10 §8）
const ENTERPRISE_NAME_KEYS = ['enterpriseName', 'enterprise_name', 'enterpriseId', 'enterprise_id'];
// 告警内部明细字段：只给有 audit:read 的人看（DP-107）
const WARNING_INTERNAL_KEYS = ['detail', 'teamId', 'teamIds', 'dimension'];

/**
 * 告警可见性裁剪（纯函数，⛔ 必须在 API 层裁决 —— 「前端隐藏 = 数据已经发到浏览器」）。
 *
 * 口径：
 *   - 有 `audit:read` 能力点 ⇒ 完整告警（含 `detail` 内部明细与内部标识）。
 *   - 没有（匿名访客 / 普通参与者）⇒ 只保留**人话部分**：
 *       `detail`（内部明细：评委 id + 原因码、队伍 id、原始片段）
 *       `teamId` / `teamIds` / `dimension`（内部标识：队伍 id、英文维度键）
 *     这三类字段前端**根本不渲染** ⇒ 不发出去。
 *   - `code` **保留**（机器判据 / 审计要靠它定位），`message` 保留（人话正文）。
 *
 * ⚠️ 告警**一条都不许少**：裁剪的是字段，不是告警本身
 *    （S-5 / C-05「降级必须显式展示，不静默」—— 降级不许藏）。
 *
 * @param warnings 告警数组
 * @param canAudit 是否具备 audit:read 能力点（默认 false = fail-closed）
 */
export function applyWarningVisibility(warnings, { canAudit = false } = {}) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (canAudit === true) return list;
  return list.map((w) => omit(w ?? {}, WARNING_INTERNAL_KEYS));
}

/**
 * @param payload    { scope, rows: [...] }
 * @param viewer     当前查看者（可为 null = 未登录 / 旁观）
 * @param visibilityConfig rules.visibility
 * @param context    { scope, viewerTeamIds?, viewerTeamId?, tierOrder?, canAudit? }
 *                  canAudit = 是否具备 `audit:read` 能力点（决定告警内部明细可见与否，
 *                  缺省 false = fail-closed，与本文件「默认关」的取向一致）
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

  // ⚠️ 默认必须是【关】而不是【开】：可见性是「不公示」才安全。
  //    「前端隐藏 = 数据已泄露」—— 配置里没写这个字段时，按「关」处理（fail-closed），
  //    宁可少公示也不能因为漏配就把互评来源 / 企业名直接发出去。
  //    （business.scoresPublic / signatoryPublic 一直是 fail-closed，这里对齐口径。）
  const peerKeys = cfg.peerReview?.showSource !== true ? PEER_SOURCE_KEYS : [];
  const entKeys = cfg.rank?.showEnterpriseName !== true ? ENTERPRISE_NAME_KEYS : [];

  const src = Array.isArray(payload?.rows) ? payload.rows : [];
  const out = { ...(payload || {}), rows: [] };
  let rows = src;

  if (scope === 'rank') {
    // A 榜与滚动总榜：全员公开（任务书 §七 明文）
    rows = src.map((r) => omit(r, [...peerKeys, ...entKeys]));
  } else if (scope === 'business') {
    // B 榜：里程碑进度公开；评分与签字人不公开；企业名不公示
    const drop = [...peerKeys];
    if (cfg.business?.scoresPublic !== true) drop.push('score', 'rawScore', 'raw_score', 'seatE', 'seatP', 'total', 'enterpriseRaw');
    if (cfg.business?.signatoryPublic !== true) drop.push('signatory', 'signatoryUserId', 'signatoryName', 'signatory_user_id', 'signedBy');
    rows = src.map((r) => omit(r, [...drop, ...entKeys]));
  } else if (scope === 'tier') {
    // 段位榜：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡
    const fromIdx = Math.max(0, tierOrder.indexOf(cfg.rank?.publicFromTier || 'C'));
    const visible = [];
    let self = null;
    for (const r of src) {
      const idx = tierOrder.indexOf(r.tier);
      if (idx >= 0 && idx >= fromIdx) {
        visible.push(omit(r, [...peerKeys, ...entKeys]));
      } else if (viewerTeamIds.has(r.teamId)) {
        self = {
          ...omit(r, [...peerKeys, ...entKeys, 'rank', 'tierRank', 'teamName']),
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
      ...omit(r, [...peerKeys, 'phone', 'org', 'idCard', 'password_hash']),
      isSelf: Boolean(viewer && r.userId === viewer.id),
    }));
  } else {
    rows = src.map((r) => omit(r, peerKeys));
  }

  out.rows = rows;

  // ⛔ 告警的内部明细同属「可见性」⇒ 也在这个**唯一入口**里裁掉（DP-107）。
  //    口径与 src/services/leaderboard.js 的旧口径逐字一致：无 audit:read ⇒ 只留 code + message。
  //    ⚠️ 告警一条都不许少（S-5 / C-05）：裁的是字段，不是告警本身。
  if (Array.isArray(payload?.warnings)) {
    out.warnings = applyWarningVisibility(payload.warnings, { canAudit: ctx.canAudit === true });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/visibility.test.js` → Expected: PASS（**9** 个测试全过：visibility.test.js 9 —— 规格自带 5 + 变异检验补测 4；变异体 31 → KILLED 31 / 等价 0 / 有效缺口 0）

- [ ] **Step 5: 提交**

```bash
cd platform && git add src/domain/visibility.js test/visibility.test.js
git commit -m "feat(P3): API 层可见性过滤与 C-02 段位公示裁决"
```

---

### Task 7: 榜单服务 + 战绩卡 + API

**Files:**
- Create: `platform/src/db/repo/leaderboard.js`、`platform/src/db/repo/points.js`、`platform/src/db/repo/tiers.js`、`platform/src/services/leaderboard.js`、`platform/src/services/performance-card.js`、`platform/src/services/tier.js`、`platform/test/leaderboard-service.test.js`
- Reuse: `platform/src/errors.js`（P0 已建，本阶段**只复用、一行不改**：已是 status-first 顺序 `AppError(status, code, message, detail)`；不新建 `errors/app-error.js`）
- Modify: `platform/src/server.js`
- Modify（Task 3 建立的，本 Task 只追加）：`platform/src/domain/points.js`（MVP 决胜链 P3-28）、`platform/test/points.test.js`
- Modify（Task 1 建立的，本 Task 只追加）：`platform/rules/criteria.json`（`mvp.tiebreak` 决胜链 P3-28）、`platform/test/leaderboard-migration.test.js`（决胜链的 fail-fast 校验）

**Interfaces:**
- Consumes: `rankTeams` / `computeStagePoints` / `computeMvp` / `computePersonalPoints` / `behaviorScore` / `applyVisibility` / `computeTier`（Task 2–6）、P2 的 `stage_results` / `peer_reviews` / `enterprise_confirmations` / `computation_snapshots`、P1 的 `teams` / `team_members` / `task_packages`
- Produces: `getLeaderboard({ db, stageId, scope, viewer })` → `{ scope, stageId, editionId, rows, warnings, ... }`（**已过滤**）；`getRollingLeaderboard({ db, editionId, viewer })` → 滚动总榜（已过滤）；`publishLeaderboard({ db, editionId, stageId, actorId, now, rules? })` → `{ editionId, stageId, snapshots, awarded, createdAt }`（写快照 + 审计 + 积分流水；`rules` 缺省走 `getDefaultRules()`，**注入口只为让「配置说了算」可被观测**）；`getPerformanceCard({ db, teamId, viewer })` → 战绩卡（不含签字人）；`getTeamTier({ db, teamId, viewer })` → 段位与权益；API `GET /api/leaderboard/:stageId?scope=rank|business|personal`｜`GET /api/leaderboard/rolling?editionId=`｜`GET /api/teams/:id/performance-card`｜`GET /api/teams/:id/tier`

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
import { computeTeamTier, getTeamTier } from '../src/services/tier.js';
import { getLatestTierRecord } from '../src/db/repo/tiers.js';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-20T00:00:00.000Z';

function seed(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会管理员','13800000000','x','mba',NULL,1,1,'${NOW}'),
           ('u_cap','A队队长','13800000001','x','mba',NULL,0,1,'${NOW}'),
           ('u_b','B队队长','13800000002','x','mba',NULL,0,1,'${NOW}'),
           ('u_obs','观察员','13800000003','x','other',NULL,0,1,'${NOW}'),
           ('u_d','D队队员','13800000004','x','other',NULL,0,1,'${NOW}'),
           ('u_c','C队队长','13800000005','x','mba',NULL,0,1,'${NOW}'),
           ('u_j1','跨领域评委','13800000006','x','mba',NULL,0,1,'${NOW}');
    -- ⚠️ 结束日推到 2099：让「当届」解析（pickCurrentEdition 取尚未结束的最早一届）
    --    与真实日期无关 —— 否则这条用例会随日历过期而红。
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','${NOW}');
    INSERT INTO cities (id, name, edition_id) VALUES ('c_1','上海','ed_1');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at)
    VALUES ('tp_1','ed_1','e_1','某某公司','任务一','痛点一','交付物一','验收一','A','approved',10,'A','试点承诺','承诺书',0,'u_cap','${NOW}'),
           ('tp_2','ed_1','e_2','乙公司','任务二','痛点二','交付物二','验收二','A','approved',10,'A','试点承诺','承诺书',0,'u_cap','${NOW}');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
    VALUES ('t_a','ed_1','A队','u_cap','tp_1','A','active','${NOW}'),
           ('t_b','ed_1','B队','u_b','tp_1','A','active','${NOW}'),
           ('t_c','ed_1','C队','u_c','tp_2','C','active','${NOW}'),
           ('t_d','ed_1','D队','u_cap','tp_2','D','active','${NOW}');
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES ('tm_1','t_a','u_cap','captain','${NOW}'), ('tm_2','t_d','u_d','captain','${NOW}'),
           ('tm_3','t_b','u_b','captain','${NOW}'), ('tm_4','t_c','u_c','captain','${NOW}');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed'),
           ('st_2','ed_1','S2','空赛段','initial','2026-10-10','2026-10-13','2026-10-14','initial','closed'),
           ('st_r','ed_1','S4','路演','roadshow','2026-10-26','2026-10-28','2026-10-29','initial','closed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1','st_1','t_a',1,90,88,95,0,10,NULL,'${NOW}'),
           ('sr_2','st_1','t_b',2,90,90,85,1,8,NULL,'${NOW}'),
           ('sr_3','st_1','t_c',3,70,70,0,0,5,NULL,'${NOW}'),
           ('sr_4','st_1','t_d',4,60,60,0,0,0,NULL,'${NOW}');
    INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
    VALUES ('pr_1','st_1','t_b','t_a',9,'rq_1','${NOW}'),
           ('pr_2','st_1','t_a','t_b',3,'rq_2','${NOW}');
    INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score,
      cross_judge_id, signatory_user_id, created_at, deleted_at)
    VALUES ('ec_1','st_1','t_a','u_cap','enterprise',80,'u_j1','u_cap','${NOW}',NULL),
           ('ec_2','st_1','t_b','u_cap','enterprise',60,'u_j1','u_cap','${NOW}',NULL);
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

  // B 榜被关闭同样 403（不是 404 —— 是「规则禁用」不是「不存在」）
  const brokenBiz = structuredClone(rules);
  brokenBiz.visibility.business.milestoneProgressPublic = false;
  const app3 = createApp({ db, rules: brokenBiz, webDir: join(here, '..', 'web') });
  assert.equal((await call(app3, 'GET', '/api/leaderboard/st_1?scope=business')).status, 403,
    'B 榜关闭 → 403');
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

test('★ 段位榜 API：C 段及以上公示队名与名次，D 段不公示（非成员看不到）', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_1');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.scope, 'tier');
  // 种子：t_a = A 段、t_c = C 段；t_b（无段位记录）与 t_d = D 段 → 不公示
  assert.deepEqual(data.rows.map((r) => r.teamId), ['t_a', 't_c']);
  assert.deepEqual(data.rows.map((r) => r.tierRank), [1, 2]);
  assert.deepEqual(data.rows.map((r) => r.tier), ['A', 'C']);
  assert.ok(!res.body.includes('D队'), 'D 段队名不得公示');
  assert.ok(data.selfProgress === undefined, '非成员不该拿到任何人的进度卡');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 段位榜 API：本人看得到自己的 D 段进度卡（无名次、无队名）', async () => {
  const { db, close, dataDir, app } = setup();
  // 给 t_d 加一个「未签字的里程碑」→ 它仍是 D 段（不算达成），但进度卡要列出这条里程碑
  db.prepare("INSERT INTO milestones (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at) VALUES ('ms_9','t_d',NULL,'problem_confirmed','企业问题确认',1,'${NOW}',1,'${NOW}')").run();
  const res = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_1', { cookie: sessionCookie(db, 'u_d') });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.selfProgress, '本人应有进度卡');
  assert.equal(data.selfProgress.teamId, 't_d');
  assert.equal(data.selfProgress.tier, 'D');
  assert.equal(data.selfProgress.teamName, undefined, '进度卡不公示队名');
  assert.equal(data.selfProgress.tierRank, undefined, '进度卡不含名次（C-02）');
  assert.ok(data.selfProgress.progress, '进度卡要带里程碑进度');
  assert.equal(data.selfProgress.progress.milestones.length, 1, '进度卡要列出该队的里程碑清单');
  assert.equal(data.selfProgress.progress.milestones[0].label, '企业问题确认');
  assert.ok(!data.rows.some((r) => r.teamId === 't_d'), 'D 段队伍不进入榜单');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 段位榜排序：同段位时里程碑多的在前；兜底键是 team_id 码位序', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    // 三支 A 段队伍，两条不同的次级口径分别被钉住：
    //   t_0a（1 个里程碑）→ 同段位时【里程碑多的在前】占优（t_a 3 > t_0a 1）
    //   t_x （3 个里程碑）→ 与 t_a 完全同分 → 【team_id 码位序】占优（'t_a' < 't_x'）
    // ⚠️ 三支的 created_at 都【早于】种子里的队伍 —— 这样「按入库顺序」的错误实现
    //    会给出不同的名次，数据集才判别得出来。
    db.prepare("INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at) VALUES ('t_0a','ed_1','零A队','u_cap','tp_1','A','active','2026-10-15T00:00:00.000Z'), ('t_x','ed_1','X队','u_cap','tp_1','A','active','2026-10-16T00:00:00.000Z')").run();
    db.prepare("INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at) VALUES ('tr_0a','t_0a','A',1,0,'[]','${NOW}',NULL), ('tr_x','t_x','A',3,0,'[]','${NOW}',NULL)").run();

    const res = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_1');
    assert.equal(res.status, 200);
    const rows = JSON.parse(res.body).rows;
    // 正确序：t_a（3 个里程碑，码位序也最前）→ t_x（3 个，同分靠码位序）→ t_0a（1 个）
    assert.deepEqual(rows.map((r) => r.teamId).slice(0, 3), ['t_a', 't_x', 't_0a'], '同段位先比里程碑数，再按 team_id 码位序');
    assert.deepEqual(rows.map((r) => r.tierRank).slice(0, 3), [1, 2, 3]);
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 届期缺省取当届（不带 editionId 也能拿到榜单 / 段位榜；显式传错 → 404）', async () => {
  const { db, close, dataDir, app } = setup();
  const rolling = await call(app, 'GET', '/api/leaderboard/rolling');
  assert.equal(rolling.status, 200, '滚动总榜：缺省取当届');
  const tier = await call(app, 'GET', '/api/leaderboard/tier');
  assert.equal(tier.status, 200, '段位榜：缺省取当届');
  const bad = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_nope');
  assert.equal(bad.status, 404, '显式传了不存在的届期 → 404（资源不存在）');
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
  const mvp1 = db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n;
  publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n, ledger1,
    '重复发榜不得重复发分');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, mvp1,
    '重复发榜不得重复发 MVP 积分');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 发榜可复算：快照里的名次能重放出同样的结果（P3-12 验收标准）', () => {
  const { db, close, dataDir } = setup();
  try {
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    const snap = db.prepare("SELECT payload_json FROM leaderboard_snapshots WHERE scope = 'rank'").get();
    assert.ok(snap, '要写 rank 快照');
    const payload = JSON.parse(snap.payload_json);
    assert.ok(payload.rows.length > 0, '快照里要有榜单行');
    // 重放：快照的名次与积分必须与「重新算一遍」完全一致（可复算 = 跨机器重算同结果）
    const fresh = getLeaderboard({ db, stageId: 'st_1', scope: 'rank', viewer: null });
    assert.deepEqual(
      payload.rows.map((r) => [r.teamId, r.rank, r.points]),
      fresh.rows.map((r) => [r.teamId, r.rank, r.points]),
      '快照必须能重放出同样的名次与积分',
    );
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
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

test('★ P3-15：发榜时【重算】段位 —— 段位来自「里程碑 + 未撤回签字」，不是历史记录', () => {
  const { db, close, dataDir } = setup();
  try {
    const before = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(before.tier, 'A', '种子里的历史记录是 A');

    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-10-21T00:00:00.000Z' });

    const after = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(after.tier, 'B', '3 个里程碑里只有 2 个有未撤回签字 → 2 个达成 → B 段');
    assert.equal(after.milestone_count, 2, '没有签字的里程碑不算达成（R-PTS-01）');
    assert.equal(after.business_signoff_count, 1, '技术部门的签字不算业务部门（R-PTS-03）');

    const noMs = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_b' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(noMs.tier, 'D', '没有任何里程碑的队伍 → D 段');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ P3-15：连续 14 天零提交 → 降 1 档并公示（相对重算出的段位降，不叠加）', () => {
  const { db, close, dataDir } = setup();
  try {
    // 20 天后再发榜 → 队伍「零提交」20 天 → 触发闲置降档
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-11-09T00:00:00.000Z' });
    const after = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(after.tier, 'C', '重算出 B → 闲置降 1 档 → C');
    const reasons = JSON.parse(after.reasons_json);
    assert.ok(reasons.some((r) => String(r).includes('inactive_14days')), '降级原因要写进 reasons');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 段位口径的边界（W01~W05 / W07 / W10~W13）
// ═══════════════════════════════════════════════════════════════════

test('★ 段位口径：未知部门不算业务签字、撤回的签字不计入、不计段位的里程碑不计数', () => {
  const { db, close, dataDir } = setup();
  try {
    // ① 未知部门（法务部）的签字：不是业务部门 → 不算 S 段的那 1 个业务签字
    db.prepare(`INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
      VALUES ('sg_3','ms_1','e_1','u_cap','法务部','内容','${NOW}',NULL)`).run();
    // ② 撤回的签字：对应里程碑不再算「已达成」
    db.prepare(`INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
      VALUES ('sg_4','ms_3','e_1','u_cap','业务部门','内容','${NOW}','${NOW}')`).run();
    // ③ 不计段位的里程碑（counts_toward_tier = 0）
    db.prepare(`INSERT INTO milestones (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at)
      VALUES ('ms_5','t_a',NULL,'iterations','迭代','0','${NOW}',0,'${NOW}')`).run();

    const out = computeTeamTier({ db, teamId: 't_a', now: '2026-10-21T00:00:00.000Z', record: false });
    assert.equal(out.milestoneCount, 2, '撤回的签字与不计段位的里程碑都不算达成');
    assert.equal(out.businessSignoffCount, 1, '只有业务部门的签字算业务签字（法务部 = unknown，不算）');
    assert.equal(out.tier, 'B', '2 个达成 → B 段（撤回归档已由重算体现，不再叠加降档）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 降级后的段位名要跟着最终档位走（不能用降级前的名字）', () => {
  const { db, close, dataDir } = setup();
  try {
    const out = computeTeamTier({ db, teamId: 't_a', now: '2026-11-09T00:00:00.000Z', record: false });
    assert.equal(out.tier, 'C', '闲置 20 天 → B 降 C');
    assert.equal(out.tierName, '立项', '段位名要跟着【最终】档位走（C 段 = 立项）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 「取最新一条段位记录」在 computed_at 并列时按 rowid（登记顺序），不用随机 id', () => {
  const { db, close, dataDir } = setup();
  try {
    // 两条 computed_at 完全相同；id 的字典序与登记顺序【故意相反】
    db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
      VALUES ('tr_z','t_b','C',1,0,'[]','${NOW}',NULL)`).run();
    db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
      VALUES ('tr_a','t_b','B',2,0,'[]','${NOW}',NULL)`).run();
    const latest = getLatestTierRecord(db, 't_b');
    assert.equal(latest.id, 'tr_a', '后登记的那条才是最新的（id 是随机 UUID，不能用它兜底排序）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 「零提交」口径不含积分流水 —— 发榜不能给自己豁免降级', () => {
  const { db, close, dataDir } = setup();
  try {
    // 第一次发榜会写 points_ledger
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-10-25T00:00:00.000Z' });
    // 第二次发榜：距【队伍真实提交】(2026-10-20) 16 天 → 仍应降级；
    // 若把积分流水当成「提交」，末次活动是 10-25 → 只隔 11 天 → 不会降级
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-11-05T00:00:00.000Z' });
    const after = db.prepare("SELECT * FROM tier_records WHERE team_id='t_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(after.tier, 'C', '积分流水不算「提交」→ 第二次发榜仍然降级');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 行为分与 MVP 的数据通路（W27 / W28）
// ═══════════════════════════════════════════════════════════════════

test('★ 破同分时行为分只从独立表 behavior_events 来（分轨强制）', () => {
  const { db, close, dataDir } = setup();
  try {
    // 新赛段：t_c 与 t_d 同分，peer / enterprise 都没有可比较的值
    //   → 破同分链只能落到 behavior；若行为分不从 behavior_events 读，两人仍是并列
    db.prepare("INSERT INTO stages (id, edition_id, \"key\", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status) VALUES ('st_3','ed_1','S3','行为分赛段','initial','2026-10-11','2026-10-12','2026-10-13','initial','closed')").run();
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_5','st_3','t_c',1,70,70,0,0,NULL,NULL,'${NOW}'), ('sr_6','st_3','t_d',1,70,70,0,0,NULL,NULL,'${NOW}')").run();
    db.prepare('INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('be_2', 't_c', 'u_cap', 'first_demo', 10, JSON.stringify({ artifact: 'demo.zip' }), NOW);
    db.prepare('INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('be_3', 't_d', 'u_cap', 'weekly_progress', 2, JSON.stringify({ repo: 'git@x', version: 'v1', artifact: 'demo.zip' }), NOW);

    const out = getLeaderboard({ db, stageId: 'st_3', scope: 'rank', viewer: null });
    const rows = out.rows.filter((r) => r.teamId === 't_c' || r.teamId === 't_d');
    assert.deepEqual(rows.map((r) => r.teamId), ['t_c', 't_d'], '行为分高者在前');
    assert.deepEqual(rows.map((r) => r.rank), [1, 2], '行为分把并列拆开（不是仍然并列）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 的路演分要折算成路演名次积分再计入（判别性：折算 / 不折算 / 不计路演 给出三个不同赢家）', () => {
  const { db, close, dataDir } = setup();
  try {
    // tp_1 扩到 3 队（t_a / t_b / t_e）：两队时路演名次积分（10/8）与赛段名次积分（10/8）
    // 恰好等量，合计永远并列，测不出「路演有没有真的计入」。
    db.prepare("INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at) VALUES ('u_e','E队队长','13800000007','x','mba',NULL,0,1,'${NOW}')").run();
    db.prepare("INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at) VALUES ('t_e','ed_1','E队','u_e','tp_1','D','active','${NOW}')").run();
    db.prepare("INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ('tm_5','t_e','u_e','captain','${NOW}')").run();
    // 赛段 st_1：t_a / t_b 同分 90（破同分链后 t_a 在前）、t_e 垫底 50
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_9','st_1','t_e',5,50,50,0,0,NULL,NULL,'${NOW}')").run();
    // 路演 st_r：名次与赛段【完全相反】t_e 90 > t_b 70 > t_a 50
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_e',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_b',2,70,70,0,0,NULL,NULL,'${NOW}'), ('sr_10','st_r','t_a',3,50,50,0,0,NULL,NULL,'${NOW}')").run();

    // ★ MVP 只在【路演赛段】发榜时发放（终审 I-1）：路演评审综合分是 MVP 公式的最后一个输入，
    //    在它之前发榜拿不到路演分 → MVP 金额偏小，而积分只增不改 ⇒ 补不回来。
    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    const tp1 = out.awarded.mvp.find((m) => m.packageId === 'tp_1');
    // 赛段名次积分 t_a 10 / t_b 8 / t_e 5；路演名次积分 t_e 10 / t_b 8 / t_a 5
    //   → 综合分 t_a 15 / t_b 16 / t_e 15 → t_b 拿 MVP
    // ⚠️ 三种错实现会给出三个不同赢家，数据集能区分：
    //    ① 折算成路演名次积分（正确）→ t_b
    //    ② 把路演原始 0–100 分直接相加 → t_e（95）
    //    ③ 完全不计路演 → t_a（10）
    assert.ok(tp1, 'tp_1 要选出 MVP');
    assert.equal(tp1.teamId, 't_b', '路演名次积分要计入，并能反超赛段领先者');
    assert.equal(tp1.points, 8, 'MVP 积分 = 该队计入的赛段名次积分之和（stage_points_sum）');

    const ledger = db.prepare("SELECT * FROM points_ledger WHERE kind = 'mvp' AND team_id = 't_b'").all();
    assert.equal(ledger.length, 1, 'MVP 积分要写进流水');
    assert.equal(ledger[0].points, 8);
    assert.equal(ledger[0].user_id, 'u_b', '写给队内成员');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 决胜口径是配置项（rules.criteria.mvp.tiebreak 说了算，不写死在代码里）', () => {
  const { db, close, dataDir, rules } = setup();
  try {
    // tp_1 两队：赛段名次积分 t_a 10 / t_b 8；路演名次积分 t_b 10 / t_a 8 → 综合分 18 : 18 真并列
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    // 注入一份把决胜链改成「只按 team_id」的规则 → 并列时选 t_a（码位序）
    const custom = {
      ...rules,
      criteria: { ...rules.criteria, mvp: { ...rules.criteria.mvp, tiebreak: ['team_id'] } },
    };
    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW, rules: custom });
    const tp1 = out.awarded.mvp.find((m) => m.packageId === 'tp_1');
    assert.equal(tp1.teamId, 't_a', '决胜口径由配置决定 → 改成 team_id 后并列时选 t_a');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 跨任务包队伍不得挤掉本任务包的 MVP（路演名次积分按包内排名）', () => {
  const { db, close, dataDir } = setup();
  try {
    // tp_1 的 t_b 路演分最高（90）；tp_2 的 t_c / t_d 没有路演结果
    //   若不按包过滤路演分：t_b 会带着「路演 10 分、赛段 0 分」进入 tp_2 的候选，
    //   与 t_c 的「赛段 10 分」并列 10 : 10 → 旧的 team_id 兜底会让 t_b 赢（t_b < t_c）
    //   → 外队挤掉本包真冠军，且拿到的 MVP 积分是 0
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    const tp2 = out.awarded.mvp.find((m) => m.packageId === 'tp_2');
    assert.ok(tp2, 'tp_2 要选出 MVP');
    assert.equal(tp2.teamId, 't_c', '本包真冠军是 t_c，不能被外队 t_b 挤掉');
    assert.equal(tp2.points, 10, 'MVP 积分按本包赛段名次积分计');
    assert.ok(!out.awarded.mvp.some((m) => m.teamId === 't_b' && m.packageId === 'tp_2'), '外队不得出现在本包 MVP');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 综合分并列时按路演名次积分决胜（不许按队名字母序）', () => {
  const { db, close, dataDir } = setup();
  try {
    // tp_1 两队：赛段名次积分 t_a 10 / t_b 8；路演名次积分 t_b 10 / t_a 8
    //   → 综合分 18 : 18 真并列 → 决胜链 roadshow_points → t_b
    // ⚠️ 若按 team_id 码位序兜底会选 t_a（'t_a' < 't_b'）→ 数据集能区分两种兜底
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    const tp1 = out.awarded.mvp.find((m) => m.packageId === 'tp_1');
    assert.equal(tp1.teamId, 't_b', '综合分并列由路演名次积分决出');
    const ledger = db.prepare("SELECT * FROM points_ledger WHERE kind = 'mvp'").all();
    const teams = new Set(ledger.map((r) => r.team_id));
    assert.ok(teams.has('t_b'), 'MVP 流水写给 t_b');
    assert.ok(!teams.has('t_a'), 't_a 只是并列，不能拿到 MVP');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 个人积分榜端到端：仓储真实行 → 域函数 → API 必须有行（终审 C-1：曾恒为空）', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    const ledger = db.prepare("SELECT * FROM points_ledger WHERE kind = 'stage_rank'").all();
    assert.ok(ledger.length > 0, '名次积分要写进流水');
    assert.ok(ledger.every((r) => r.user_id), '每条流水都要有归属人');

    const res = await call(app, 'GET', '/api/leaderboard/st_1?scope=personal');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.scope, 'personal');
    // ⚠️ 这条断言是本次修复的判别点：修复前仓储给的是 snake_case 行，域函数读 entry.userId
    //    读不到 → 每一行都被当成「没有归属人」丢弃 → rows 恒为空（且不报任何错）。
    assert.equal(data.rows.length, ledger.length, '个人积分榜的行数必须与流水条数一致');
    const row = data.rows.find((r) => r.userId === 'u_cap');
    assert.ok(row, 'u_cap 必须在榜上');
    assert.equal(row.name, 'A队队长', '要有姓名，不是只有 id');
    assert.equal(row.total, 10, 'u_cap 是 A 队队长，拿的是 A 队的名次积分 10');
    assert.equal(row.rank, 1, '要有名次');
    assert.deepEqual(row.byKind, { stage_rank: 10 }, '要能看出分项来源');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 只在路演赛段发榜时发放，且整届只发一次（终审 I-1：曾每赛段重复发）', () => {
  const { db, close, dataDir } = setup();
  try {
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    // ① 非路演赛段发榜 → 不发 MVP（路演评审综合分是公式的最后一个输入，还没到）
    const s1 = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    assert.deepEqual(s1.awarded.mvp, [], '非路演赛段发榜不得发 MVP');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, 0, '一条都不能写');

    // ② 路演赛段发榜 → 发一次（两个任务包各选出一个 MVP）
    const sr = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    assert.equal(sr.awarded.mvp.length, 2, '两个任务包各选出一个 MVP');
    const after1 = db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n;
    assert.ok(after1 > 0, '路演赛段发榜要写 MVP 流水');

    // ③ 再发别的赛段 → 不得重复发（幂等键是届期级，不是赛段级）
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, after1,
      '跨赛段重复发榜不得重复发 MVP 积分');

    // ④ 再发一次路演赛段 → 同样不得重复发
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, after1,
      '同一路演赛段重复发榜也不得重复发');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 滚动总榜必须汇总各赛段的降级告警（终审 I-2：曾静默丢弃全部告警）', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    const res = await call(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.scope, 'rolling');
    // ⚠️ 判别点：st_1 的计算快照带 judge_sample_too_small —— 修复前滚动榜 warnings 恒为 []
    assert.ok(data.warnings.length > 0, '滚动总榜不得把降级告警静默丢掉');
    const w = data.warnings.find((x) => x.code === 'judge_sample_too_small');
    assert.ok(w, 'st_1 的降级告警必须出现在滚动总榜上');
    assert.equal(w.stageId, 'st_1', '告警要标注来源赛段');
    assert.equal(w.stageKey, 'S1', '告警要标注赛段键');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 段位记录的原因说明是脏数据时降级为空列表并显式告警，不得 500（终审 M-3）', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    db.prepare("UPDATE tier_records SET reasons_json = '{not json' WHERE team_id = 't_a'").run();
    const out = getTeamTier({ db, teamId: 't_a', viewer: { id: 'u_cap' } });
    assert.deepEqual(out.reasons, [], '脏 reasons_json 降级为空数组');
    assert.ok(out.warnings.some((w) => w.code === 'REASONS_PARSE_FAILED'), '必须显式告警，不静默');
    assert.equal(out.tier, 'A', '其它字段照常返回');
    // 走一遍真实 HTTP：修复前这里会 500（INTERNAL）
    const res = await call(app, 'GET', '/api/teams/t_a/tier', { cookie: sessionCookie(db, 'u_cap') });
    assert.equal(res.status, 200, '脏数据不得让接口 500');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/leaderboard-service.test.js` → Expected: FAIL —— `Cannot find module '../src/services/leaderboard.js'`

- [ ] **Step 3: 接入 src/errors.js 与创建三个仓储文件**

`platform/src/errors.js` 由 **P0 的 Task 4 建立**，本阶段**只复用、不重建**（重建会产生两套参数顺序相反的错误构造器）：
```javascript
// src/errors.js — 由 P0 建立，P3 直接 import（不复制、不改）
// 签名：appError(status, code, message, detail)
//   ⚠️ 参数顺序是 status 在前。P3 文末偏差表里原本写的 appError(code, message, status)
//      已统一为 status-first，与 P1/P4 一致。
import { AppError, appError } from '../errors.js';
```

**本阶段所有 `new AppError(...)` 调用一律用 status-first 顺序**：`new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在')`。

> **【2026-10-21 漂移审计修正 M-3】** 本阶段的 Files 清单原来写的是
> `- Modify: platform/src/errors.js`（"只复用"），**标注与正文自相矛盾**：
> 正文明确说「只复用、不重建」，Files 却标 `Modify` → 实施者会以为自己要改这个文件，
> 而 `git add src/errors` 又把它**纳入提交**（一个一行没改的文件被提交，等于制造噪音，
> 也让「本阶段到底动了哪些文件」失真）。
> **为什么错**：`src/errors.js` **P0 的 Task 4 就建好了**，而且**已经是 status-first**
> （`constructor(status, code, message, detail = undefined)`）—— 本阶段没有任何理由动它。
> **改成什么**：Files 清单改为 `- Reuse: platform/src/errors.js`（本阶段**只复用、一行不改**），
> 并从 `git add` 列表里**删掉 `src/errors`**。
> **依据**：基线 `platform/src/errors.js:9`（`constructor(status, code, message, detail = undefined)`，
> 文件头注释明写「参数顺序是 status-first」）+ 漂移审计报告 M-3。

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

/**
 * 回写赛段结果的**名次 / 并列数 / 积分**（E170 / F7）。
 *
 * ⚠️ 为什么这三列此前永远是 NULL：
 *   P2 建表时留了三列空位并约定「**P3 来填**」，而 P3 从来没填 ——
 *   全仓唯一碰这三列的 SQL 是 `resetStageResults` 的 `SET rank = NULL, tied_with = NULL, points = NULL`
 *   （**只置 NULL**）⇒ 公开榜单的 `rank` / `points` / `tiedWith` 恒为 null，
 *   而排序退化成 `team_id` 序（**低分队排在高分队前面**）⇒ 榜单的名次是错的。
 *   （与本仓已修的 E149/E150「服务写好了但没有路由触达」同款病根：P2 留了坑，P3 没填。）
 *
 * @param {number} rank      名次（1 起）
 * @param {number} tiedWith  **与本队并列的队伍数**（0 = 不并列）。
 *   ⚠️ 口径：领域层的 `rankTeams` 给的是「并列组里除自己外的队 id 数组」，
 *      而本列是 INTEGER ⇒ 落库的是**个数**（0/1/2…），与 P3 计划里的夹具口径一致。
 * @param {number} points    本赛段名次积分
 */
export function updateStageResultRanking(db, { stageId, teamId, rank, tiedWith = 0, points = null }) {
  db.prepare(
    'UPDATE stage_results SET rank = ?, tied_with = ?, points = ? WHERE stage_id = ? AND team_id = ?',
  ).run(rank, tiedWith, points, stageId, teamId);
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
/**
 * ⛔ P11 · **已删除**：`listTiebreakVoteTotals`（原按 `tiebreak_votes` 直接 AVG 的聚合）。
 *
 *    为什么删：它是 `src/services/tiebreak.js::getTiebreakExtraScores` 的**孪生实现**，
 *    少了两条口径：
 *      ① 「只消费**已关闭**的轮次」—— 开放中的轮次，其当前均值会被当成最终复议分消费
 *         ⇒ **榜单随投票进行而漂移**（破同分必须可复算 ⇒ 这条直接违规）；
 *      ② 「同一队多轮取**最新一轮**」。
 *    ⇒ 排名路径已统一走服务层（src/services/leaderboard.js 的 buildStageRanking），
 *      留着一份语义不同又没人调的实现 = 下一个改口径的人会踩坑。
 *    （机器闸 docs/tools/dead-service-scan.mjs 的存在意义就在这里。）
 */

/** 最近一次计算快照：降级告警的来源（P2 写，P3 读） */
export function getLatestComputation(db, stageId) {
  return db.prepare(`SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = 'stage_score'
    ORDER BY revision DESC, created_at DESC LIMIT 1`).get(stageId) ?? null;
}

export function insertSnapshot(db, { id, editionId, stageId, scope, payloadJson, createdAt }) {
  db.prepare('INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, editionId, stageId ?? null, scope, payloadJson, createdAt);
}

/**
 * 某赛段的发榜快照列表（按发榜时间升序）。
 * ⛔ P11：原先**没有任何读口**能回答「这个赛段发了榜没有」⇒ 前端刷新页面后
 *    就不知道自己刚做过什么。排序兜底用 SQLite 隐式 `rowid`（不用随机 id 列）。
 */
export function listSnapshotsByStage(db, stageId) {
  return db.prepare('SELECT id, stage_id, scope, created_at FROM leaderboard_snapshots WHERE stage_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(stageId);
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
//
// ⚠️ 排序兜底键一律用 SQLite 隐式 `rowid`（不用 `id` 列）——`id` 是 randomUUID(),
//    同一批写入的记录 id 顺序随机 ⇒ 排序结果逐次运行不同，跨机器不可复算。
//    依据：硬约束「任何排序兜底键不得用随机 UUID」（与 tiers.js 的 getLatestTierRecord 同款口径）。
export function insertLedgerEntry(db, { id, editionId, stageId, teamId, userId, kind, points, createdAt }) {
  db.prepare(`INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, editionId, stageId ?? null, teamId ?? null, userId ?? null, kind, points, createdAt);
}

export function listLedgerByEdition(db, editionId) {
  return db.prepare('SELECT * FROM points_ledger WHERE edition_id = ? ORDER BY created_at ASC, rowid ASC').all(editionId);
}

export function listLedgerByStage(db, stageId) {
  return db.prepare('SELECT * FROM points_ledger WHERE stage_id = ? ORDER BY created_at ASC, rowid ASC').all(stageId);
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
    ORDER BY created_at ASC, rowid ASC`).all(...ids);
}
```

`platform/src/db/repo/tiers.js`：

```javascript
// src/db/repo/tiers.js — 段位记录、里程碑与企业签字 SQL
import { randomUUID } from 'node:crypto';
export function insertTierRecord(db, { id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt }) {
  db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count,
    reasons_json, computed_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)`)
    .run(id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt);
}

export function getLatestTierRecord(db, teamId) {
  return db.prepare(`SELECT * FROM tier_records WHERE team_id = ? AND deleted_at IS NULL
    ORDER BY computed_at DESC, rowid DESC LIMIT 1`).get(teamId) ?? null;
}

/** 每支队伍最新的一条段位记录 */
export function listLatestTiersByEdition(db, editionId) {
  const rows = db.prepare(`SELECT tr.* FROM tier_records tr JOIN teams t ON t.id = tr.team_id
    WHERE t.edition_id = ? AND tr.deleted_at IS NULL ORDER BY tr.computed_at ASC, tr.rowid ASC`).all(editionId);
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

/**
 * 队伍最近一次「提交」的时间（R-PTS-04 降级规则里的「连续 N 天零提交」口径）。
 * ⛔ 只算队伍**自己**的产出：行为分事件 / 里程碑固定 / 企业签字。
 *    绝不算 points_ledger —— 发榜会写积分流水，算进去等于发榜把「零提交」刷新掉了，
 *    降级规则就永远不触发（发榜自我豁免）。
 */
export function getTeamLastActivityAt(db, teamId) {
  const row = db.prepare(`
    SELECT MAX(t) AS last_at FROM (
      SELECT MAX(created_at) AS t FROM behavior_events WHERE team_id = ?
      UNION ALL SELECT MAX(fixed_at) FROM milestones WHERE team_id = ?
      UNION ALL SELECT MAX(s.signed_at) FROM milestone_signoffs s JOIN milestones m ON s.milestone_id = m.id WHERE m.team_id = ?
    )`).get(teamId, teamId, teamId);
  return row?.last_at ?? null;
}

/**
 * 里程碑清单落表（R-STG-03：报名 / 组队时固定，赛程中不可自行新增）。
 * ⚠️ 清单来源是 teams.milestones_json（建队时按 rules/milestones.default.json 固定），
 *    这里把它落成**行** —— P3 的段位引擎与 B 榜只读这张表（两处同源，不共享规则字段）。
 * ⛔ requires_signoff 一律为 1：7 类里程碑都要有「确认」（企业签字或评委确认）才算达成。
 */
export function insertMilestones(db, { teamId, items, now }) {
  const stmt = db.prepare(`INSERT INTO milestones
    (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?)`);
  for (const item of Array.isArray(items) ? items : []) {
    stmt.run(randomUUID(), teamId, item.key, item.label, item.countsTowardTier === false ? 0 : 1, now, now);
  }
}

export function getMilestone(db, milestoneId) {
  return db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId) ?? null;
}

/**
 * 企业签字：★ 只确认「这件事到底发生了没有」（客观事实，单签，不进总分）。
 *   与 P2 的 enterprise_confirmations（主观评分、双签、进总分）是**两张不同的表**。
 * 追加式：只增不改；撤回走 revoked_at 软删除（不物理删除、不改其它列）。
 */
export function insertSignoff(db, { id, milestoneId, enterpriseId, signatoryUserId, department, content, signedAt }) {
  db.prepare(`INSERT INTO milestone_signoffs
    (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
    VALUES (?,?,?,?,?,?,?,NULL)`).run(id, milestoneId, enterpriseId, signatoryUserId ?? null, department, content, signedAt);
}

export function getSignoff(db, signoffId) {
  return db.prepare('SELECT * FROM milestone_signoffs WHERE id = ?').get(signoffId) ?? null;
}

/** 撤回签字 = 软删除（置 revoked_at）；已撤回的返回 0（幂等） */
export function revokeSignoff(db, { id, revokedAt }) {
  const r = db.prepare('UPDATE milestone_signoffs SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(revokedAt, id);
  return Number(r.changes || 0);
}
```

- [ ] **Step 4: 创建 src/services/leaderboard.js**

```javascript
// src/services/leaderboard.js — 榜单用例编排
// 依据：设计文档 §6.3 / §6.6 + 任务书 §七 + R-RNK-01/02/03/04
//   ⛔ 双榜并列不合成一个总分：A 榜（名次/奖金/MVP）与 B 榜（商业战绩/完赛/资源解锁）
//      走两条不同的表、两条不同的计算路径，任何一条都不读另一条的分数字段。
//   ⛔ 可见性在 API 层过滤：本模块【读】原始 payload，【写】快照；对外一律走 applyVisibility。
//   ⛔ 告警的内部明细同理在 API 层裁剪（applyWarningVisibility，在 applyVisibility 内执行）：
//      公开端点（滚动总榜 / 赛段榜）只有拿到 `audit:read` 的人才能看到 `detail` 与
//      队伍 id / 英文维度键 —— 前端不判断权限。
//      ⚠️ 裁剪口径放在**领域层唯一入口**（src/domain/visibility.js），演示站与正式站
//         复用同一份 ⇒ 不可能再漂（以前两处各写一份，演示站把内部明细泄给了匿名访客）。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getDefaultRules } from '../config.js';
import { rankTeams } from '../domain/ranking.js';
import { computeStagePoints, computeMvp, computePersonalPoints } from '../domain/points.js';
import { behaviorScore } from '../domain/behavior.js';
import { applyVisibility } from '../domain/visibility.js';
import { computeTeamTier } from './tier.js';
import { buildReverseAuditTasks } from './anticheat.js';
import { getTiebreakExtraScores } from './tiebreak.js';
import { cmpStr } from '../domain/util.js';
import { withTransaction } from '../db/tx.js';
// ⚠️ 从 **core** 模块 import（不是 review-state.js）：
//   review-state.js 是**可选模块**（路由层动态加载；模块不在 ⇒ 申诉端点 503，
//   但平台必须照常启动）⇒ 发榜这条**始终在场**的路径不能静态依赖它。
//   状态机内核（迁移表 / transition / 终稿推进）已抽到 core 模块 ⇒ 两边共用同一份实现。
import { finalizeStageResult } from './review-state-core.js';
import * as repo from '../db/repo/leaderboard.js';
import * as pointsRepo from '../db/repo/points.js';
import * as tierRepo from '../db/repo/tiers.js';

const SCOPES = ['rank', 'business', 'personal'];
const indexBy = (rows, k, v) => Object.fromEntries(rows.map((r) => [r[k], r[v]]));

/**
 * 仓储行（snake_case）→ 域函数契约（camelCase）。
 * ⚠️ 终审 C-1 的根因就在这条缝上：`points_ledger` 的行是 snake_case（`user_id`），
 *    而域函数 `computePersonalPoints` 的契约是 camelCase（`entry.userId`）。
 *    两者对不上时，域函数里的 `if (!entry.userId) continue;` 会把**每一行**都当成
 *    「这条流水没有归属人」**静默丢弃** ⇒ 个人积分榜恒为空（R-RNK-10 整条线生产上不可观测），
 *    而且**不报任何错** —— 流水明明写进去了，只是永远读不出来。
 *    仓储层统一返回原始行（与 leaderboard / teams / tiers 仓储同风格），
 *    所以**翻译只在这一处发生一次**；`test/leaderboard-service.test.js` 有一条端到端用例
 *    把「仓储真实行 → 域函数 → 榜单响应」三者绑住，防止再漂。
 */
function toLedgerEntry(row) {
  return {
    id: row.id,
    editionId: row.edition_id,
    stageId: row.stage_id,
    teamId: row.team_id,
    userId: row.user_id,
    kind: row.kind,
    points: row.points,
    createdAt: row.created_at,
  };
}

/** ★ 行为分独立通路：behavior_events → behaviorScore。绝不从 stage_results 派生。 */
function behaviorScoresByTeam(db, teamIds, R) {
  // ⚠️ 终审 I-3 的配套修正：「一条没提交」= 0 分，**不是**「没有可比较的值」。
  //    行为分对每支队都有定义：提交了就按 rules/behavior-points.json 计分，没提交就是 0。
  //    原实现只给「有事件」的队伍返回值，其余留 null → 破同分链读到 null 会判定
  //    「本组缺少可比较的值」⇒ **整组都不用行为分**（warning: tiebreak_key_unusable）
  //    ⇒ 提交过的队伍与没提交的队伍永远并列，行为分这一级形同虚设（正是 I-3 要修的东西）。
  //    ⛔ 与 R-RNK-07 的口径区别：互评分「空交付队无记录」= 该维度**没被应用**（不可用）；
  //    行为分「没提交」= 这一维度的值**就是 0**（可用）。两者不能混为一谈。
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  const out = Object.fromEntries(ids.map((id) => [id, 0]));
  const events = pointsRepo.listBehaviorEventsByTeams(db, ids);
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
  // ⛔ P11：**破同分复议分必须走服务层**（getTiebreakExtraScores），不能用仓储层那份 SQL 聚合。
  //    仓储层的 `listTiebreakVoteTotals` 是它的**孪生实现**，少了两条口径：
  //      ① 「只消费**已关闭**的轮次」—— 还在开放投票的轮次，其当前均值会被当成最终复议分消费
  //         ⇒ **榜单随投票进行而漂移**（services/tiebreak.js 文件头第 ⑥ 条修的就是这件事，SQL 那份没跟上）；
  //      ② 「同一队多轮取**最新一轮**」。
  //    ⇒ 一旦投了票但轮次还没关，榜单就会变 —— 这与「破同分必须可复算」直接冲突。
  const extraTotals = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: results.map((r) => r.team_id) });
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

function buildRankPayload({ db, stage, R, built = null }) {
  // ⚠️ `built` 可由调用方传入（发榜路径已经算过一次 ⇒ 复用，别算两遍）；
  //    读路径不传 ⇒ 这里现算。
  const ranking = built ?? buildStageRanking({ db, stage, R });
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, stage.edition_id), 'team_id', 'tier');
  const rows = ranking.ranking.ordered.map((row) => {
    const res = ranking.results.find((r) => r.team_id === row.teamId);
    return {
      teamId: row.teamId,
      teamName: res?.team_name ?? null,
      taskPackageId: res?.task_package_id ?? null,
      rank: row.rank,
      tiedWith: row.tiedWith,
      packageRank: ranking.packageRank[row.teamId] ?? null,
      points: ranking.points[row.teamId] ?? 0,
      total: row.total,
      tier: tiers[row.teamId] ?? 'D',
      enterpriseName: null,   // ⛔ 企业名不公示（S10 §8）
      // ⛔ 评分构成（seatP / seatE / peerScore / behaviorScore）不进公开榜，
      //    需要的人看 P4 的 trace 抽屉（按权限）。
    };
  });
  return {
    scope: 'rank', stageId: stage.id, editionId: stage.edition_id, rows,
    warnings: ranking.warnings, rankStyle: ranking.ranking.rankStyle, tiebreakApplied: ranking.ranking.applied,
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
  // ★ 必须过 toLedgerEntry：仓储给的是 snake_case 行，域函数认的是 camelCase（终审 C-1）
  const ledger = pointsRepo.listLedgerByEdition(db, stage.edition_id).map(toLedgerEntry);
  const personal = computePersonalPoints({ ledger, pointsConfig: R.points });
  const names = repo.listUserNames(db, personal.rows.map((r) => r.userId));
  const rows = personal.rows.map((r) => ({
    userId: r.userId, name: names[r.userId] ?? null, total: r.total, rank: r.rank, byKind: r.byKind,
  }));
  return { scope: 'personal', stageId: stage.id, editionId: stage.edition_id, rows, warnings: [] };
}

const buildPayload = ({ db, stage, scope, rules: R, built = null }) => (scope === 'rank'
  ? buildRankPayload({ db, stage, R, built })
  : scope === 'business' ? buildBusinessPayload({ db, stage }) : buildPersonalPayload({ db, stage, R }));

/**
 * 告警可见性裁剪的**能力判定**：有 `audit:read` 才能看内部明细。
 * ⛔ 真正的裁剪在领域层唯一入口（src/domain/visibility.js 的 applyWarningVisibility，
 *    由 applyVisibility 内部调用）—— 本函数只回答「这个人有没有审计权限」。
 * ⚠️ `can(null, ...)` 安全返回 false（见 src/auth/permissions.js）⇒ 匿名访客自动落到「无权限」。
 */
function canAuditWarnings({ db, viewer }) {
  return viewer ? can(viewer, 'audit:read', null, db) : false;
}

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
  const out = applyVisibility({
    payload: buildPayload({ db, stage, scope, rules: R }),
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope,
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: (R.ranks?.tiers || []).map((t) => t.key),
      // ⛔ 告警的内部明细也要在 API 层裁剪（公开端点任何人可看）
      canAudit: canAuditWarnings({ db, viewer }),
    },
  });
  return out;
}

/** 滚动总榜：全程公开（任务书 §七 明文） */
export function getRollingLeaderboard({ db, editionId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  if (R.visibility?.rank?.public === false) throw new AppError(403, 'LEADERBOARD_DISABLED', '总榜已关闭');
  const stages = repo.listEditionStages(db, editionId);
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, editionId), 'team_id', 'tier');
  const totals = new Map();
  // ★ 终审 I-2：滚动总榜原来把各赛段的降级告警**全部丢掉**（warnings 恒为 []），
  //    而 `#/leaderboard`（不带 stageId）默认就走滚动总榜 ⇒ 用户看到的是一份「干净」的榜单，
  //    底层计算其实已降级。违反 P3-9「降级告警置顶」与 R-AUD-05「静默的空产出比报错更危险」。
  //    口径：滚动总榜汇总**每一届赛段**的告警，并标注来源赛段（stageId / stageKey / stageName），
  //    让读者知道是哪一段降级了；前端按 stageName 渲染。
  const warnings = [];

  for (const stage of stages) {
    const built = buildStageRanking({ db, stage, R });
    for (const w of built.warnings) {
      warnings.push({ ...w, stageId: stage.id, stageKey: stage.key, stageName: stage.name });
    }
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

  const out = applyVisibility({
    payload: {
      scope: 'rolling', editionId, rows, warnings,
      stages: stages.map((s) => ({ id: s.id, key: s.key, name: s.name })),
    },
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope: 'rank',   // 滚动总榜与 A 榜同口径：全员公开
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: (R.ranks?.tiers || []).map((t) => t.key),
      // ⛔ 滚动总榜是**公开端点**（任何人可看）⇒ 告警的内部明细必须在这里裁掉
      canAudit: canAuditWarnings({ db, viewer }),
    },
  });
  return out;
}

/** 发榜：显式动作。写快照 + 审计日志 + 积分流水（追加式 + 幂等）。 */
export function publishLeaderboard({ db, editionId, stageId, actorId, now, rules = null }) {
  const R = rules || getDefaultRules();
  const user = getUserById(db, actorId);
  // ⛔ P11 修正：原先只认**届期级**授权 ⇒「赛段级授权」的 `stage:compute` 明明能
  //    `POST /api/stages/:id/compute`（路由层认赛段级），却发不了榜 ⇒ 前后端口径不一致。
  //    现在两种都认（全局授权与角色授权在 can() 里本来就放行）。
  const allowed = can(user, 'stage:compute', { scopeType: 'edition', scopeId: editionId }, db)
    || can(user, 'stage:compute', { scopeType: 'stage', scopeId: stageId }, db);
  if (!allowed) {
    throw new AppError(403, 'FORBIDDEN', '无发榜权限');
  }
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const createdAt = now ?? new Date().toISOString();

  // ⛔ F12：**没有计算结果的赛段不得发榜**。
  //    修复前这条路径对「算过没有」零检查 ⇒ 对一个从未算过的赛段发榜会**成功**，
  //    产出一个**空榜**，而且 `leaderboard.publish` 审计照写不误
  //    （实测 getPublishState → published:true、snapshotCount:3、rows 为 0）。
  //    ⇒ 「发榜」的对象是**赛段结果**：没有结果就没有可发的东西（发出来是空榜），
  //      而且 F7 的名次回写也无处可写。
  //    ⚠️ 判据为什么用「**stage_results 非空**」而不是「有没有计算快照」：
  //      重算中途失败时 computeStage 已把旧结果清空、而旧快照还在
  //      ⇒ 只看快照会放行一个**空榜**。结果才是发榜的对象。
  //      （「没有计算快照」这件事由 collectWarnings 的 NO_COMPUTATION_SNAPSHOT 告警暴露，
  //        它是**告警**不是**闸门** —— 快照缺失不影响「结果是否存在」这个事实。）
  if (!repo.listStageResults(db, stage.id).length) {
    throw new AppError(409, 'STAGE_NOT_COMPUTED', '该赛段还没有计算结果，不能发榜（请先计算再发榜）');
  }

  // ⚠️ F37：**整体包进一个事务**。
  //    修复前的写入序列是「写 3 个快照 → 写档位 → 记积分 → 写 MVP 积分 → 写审计」，
  //    **没有事务** ⇒ 中途失败（例如 MVP 分写入时外键失败）会留下**半成品**：
  //    快照已写、赛段积分已写、档位已写，却**没有审计行、也没有 MVP 积分**，
  //    而 `getPublishState` 还报 `published: true` ⇒ R-AUD-01 依赖的审计轨迹缺失。
  //    （同一份纪律，compute 路径遵守了、publish 路径没有 —— 见 src/services/compute.js。）
  return withTransaction(db, () => {
    // 一次排名结果，发榜全程复用（buildStageRanking 不便宜：破同分/行为分/企业分都要算）
    const built = buildStageRanking({ db, stage, R });

    // ⚠️ F7：**名次 / 并列 / 积分必须回写 stage_results**。
    //    这三列 P2 建表时留了空位并约定「P3 来填」，P3 从来没填 ⇒
    //    公开榜单的 rank / points / tiedWith 恒为 null，而排序退化成 team_id 序
    //    （**低分队排在高分队前面**）⇒ 榜单的名次是错的。
    //    ⇒ 现在发榜时把 rankTeams 产出的名次与名次积分落库。
    //    ⚠️ 口径：`rankTeams` 给的 `tiedWith` 是「并列组里除自己外的队 id 数组」，
    //    而本列是 INTEGER ⇒ 落库的是**并列队伍数**（0 = 不并列）。
    for (const row of built.ranking.ordered) {
      repo.updateStageResultRanking(db, {
        stageId: stage.id,
        teamId: row.teamId,
        rank: row.rank,
        tiedWith: Array.isArray(row.tiedWith) ? row.tiedWith.length : 0,
        points: built.points[row.teamId] ?? 0,
      });
    }

    const snapshots = {};
    for (const scope of SCOPES) {
      const payload = buildPayload({ db, stage, scope, rules: R, built });   // 原始快照（内部可见）
      const id = randomUUID();
      repo.insertSnapshot(db, { id, editionId, stageId, scope, payloadJson: JSON.stringify(payload), createdAt });
      snapshots[scope] = { id, scope, createdAt };
    }

    // ★ 发榜前重算段位：段位记录是榜单快照与段位公示的依据，
    //    不重算就永远是兜底的 D 段（P3-15）。
    const tierUpdates = [];
    for (const row of repo.listStageResults(db, stageId)) {
      if (tierUpdates.some((t) => t.teamId === row.team_id)) continue;
      tierUpdates.push(computeTeamTier({ db, teamId: row.team_id, now: createdAt, rules: R }));
    }

    const awarded = {
      stage: awardStagePoints({ db, editionId, stageId, rules: R, createdAt }),
      mvp: awardMvp({ db, editionId, stageId, rules: R, createdAt }),
    };

    // ⚠️ F36：**终稿落库 ⇒ 复核状态推进到 FINALIZED**。
    //    修复前全仓**没有任何一处**生产 FINALIZED ⇒ `fileAppeal` 对 team_result 永远 409
    //    ⇒「提交申诉 → 裁决 → 撤销终稿 → 重算」整条链在生产上不可达。
    //    ⇒ 现在随终稿一起写这条迁移（与终稿同事务 ⇒ 要么都有、要么都没有）。
    const reviewState = finalizeStageResult({
      db, stageId: stage.id, actorId, reason: '发榜终稿', now: createdAt,
    });

    repo.insertAuditLog(db, {
      id: randomUUID(), actorId, action: 'leaderboard.publish', entity: 'stage', entityId: stageId,
      detailJson: JSON.stringify({ editionId, stageId, snapshots, awarded, reviewState: reviewState.state }),
      createdAt,
    });
    return {
      editionId, stageId, snapshots, awarded, reviewState: reviewState.state,
      createdAt, reverseAuditTasks: buildTopReverseAuditTasks({ db, stage, R }),
    };
  });
}

/**
 * TOP 名单反向抽查任务（R-JDG-16 / S7 §4.1「组委会对 TOP10 作品电话回访」）。
 *
 * ⛔ P11：这份清单原先**只有服务层纯函数**（buildReverseAuditTasks），没有任何生产调用方
 *    ⇒ TOP 名单回访这件事在产品里**根本做不了**。现在发榜时一并产出。
 * ⚠️ 口径：只给**名次**与**未撤回的里程碑签字**，不代劳、不自动结案（检测 ≠ 处罚）。
 */
function buildTopReverseAuditTasks({ db, stage, R, topN = 10 }) {
  const built = buildStageRanking({ db, stage, R });
  const results = built.ranking.ordered.map((row) => ({
    teamId: row.teamId,
    rank: row.rank,
    total: row.total,
  }));
  const signoffs = [];
  for (const row of results.slice(0, topN)) {
    for (const s of tierRepo.listSignoffsByTeam(db, row.teamId)) {
      // ⛔ 撤回的签字不算「已签字」—— 回访时要能看出「签了又撤」
      if (s.revoked_at) continue;
      signoffs.push({ ...s, teamId: row.teamId });
    }
  }
  return buildReverseAuditTasks({ results, signoffs, topN });
}

/**
 * 发榜状态（读口）：这个赛段发过榜没有？发了什么？TOP 回访清单是什么？
 *
 * ⛔ P11：原先**没有任何读口**能回答「这个赛段发了榜没有」——
 *    前端只能靠「有没有快照」猜，页面刷新后就不知道自己刚做过什么。
 */
export function getPublishState({ db, stageId, rules = null, topN = 10 }) {
  const R = rules || getDefaultRules();
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const snaps = repo.listSnapshotsByStage(db, stageId);
  const published = snaps.length > 0;
  return {
    stageId,
    editionId: stage.edition_id,
    published,
    publishedAt: published ? snaps[snaps.length - 1].created_at : null,
    snapshots: snaps.map((s) => ({ id: s.id, scope: s.scope, createdAt: s.created_at })),
    reverseAuditTasks: published ? buildTopReverseAuditTasks({ db, stage, R, topN }) : [],
    warnings: published ? [] : [{ code: 'STAGE_NOT_PUBLISHED', message: '该赛段尚未发榜：榜单快照、段位记录与名次积分都还没写' }],
  };
}

/**
 * 名次积分写入流水：**只增不改 + 更正走新记录**（INTERFACES.md §0「追加式」）。
 *
 * ⛔ P11 修正：原实现拿「同一赛段同一队伍不重复发」当幂等 ⇒ **重发榜时名次变了也不改分**。
 *    榜单快照是新的、段位是重算的，唯独个人积分还停在上一轮 ⇒ 奖金依据与榜单对不上，
 *    而且**没有任何告警**（静默的不一致比报错更危险）。
 *    现在改成**差额更正**：把「本轮该发多少」与「已发多少」逐人相减，
 *    差多少就补/扣多少，差额本身作为**新记录**写进流水（原记录一个字都不动 ⇒ 仍满足「只增不改」）。
 *
 * ⚠️ 口径边界（写在这里，避免以后被人当成 bug 改掉）：
 *   · **只纠正当前在册成员**：已离队的成员保留他已挣到的分（与 R-RNK-10「终生上榜」一致）；
 *   · **中途入队的成员**在下次发榜时补齐他应得的那份（因为他此前没有流水行）；
 *   · 队内成员之间的份额是**同额**的（该队名次积分），不按贡献分配。
 */
function awardStagePoints({ db, editionId, stageId, rules: R, createdAt }) {
  const built = buildStageRanking({ db, stage: repo.getStage(db, stageId), R });
  // 本轮该发多少：队 → 名次积分
  const desired = new Map();
  for (const row of built.ranking.ordered) {
    desired.set(row.teamId, built.points[row.teamId] ?? 0);
  }
  // 已发多少：逐人累加（同一队有多人 ⇒ 每人一份）
  const already = new Map();
  for (const r of pointsRepo.listLedgerByStage(db, stageId)) {
    if (r.kind !== 'stage_rank') continue;
    const key = `${r.team_id}|${r.user_id}`;
    already.set(key, (already.get(key) ?? 0) + (Number(r.points) || 0));
  }
  // 参与过本赛段名次积分的队伍（含「本轮掉出前三」的队 —— 它们要被扣回差额）
  const teams = new Set(desired.keys());
  for (const key of already.keys()) teams.add(String(key).split('|')[0]);

  const awarded = [];
  const corrections = [];
  for (const teamId of teams) {
    const pts = desired.get(teamId) ?? 0;
    for (const m of repo.listTeamMembers(db, teamId)) {
      const key = `${teamId}|${m.user_id}`;
      const delta = pts - (already.get(key) ?? 0);
      if (!delta) continue;
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId, userId: m.user_id,
        kind: 'stage_rank', points: delta, createdAt,
      });
      corrections.push({ teamId, userId: m.user_id, points: delta });
    }
    if (pts) awarded.push({ teamId, points: pts });
  }
  awarded.corrections = corrections;
  return awarded;
}

/**
 * MVP：4 赛段总积分 + S4 路演评审综合，每任务包 1 个（写入个人积分流水）
 *
 * ★ 终审 I-1 的修正：MVP 是【届期级】的最终奖项，而发榜是【赛段级】动作 ——
 *    让赛段级动作产生届期级奖项是**层级错配**。
 *    原实现每次发榜都算一遍 MVP，幂等键却按【当前发榜的赛段】查
 *    ⇒ 每发一个赛段就再写一条同额流水（发 st_1 写一条、发 st_2 又写一条，金额还一样），
 *    个人积分被重复累加；而且在路演赛段之前发榜时，MVP 金额缺了路演分而偏小，
 *    积分只增不改 ⇒ 后面补不回来。
 *    修正后的口径（两条，缺一不可）：
 *      ① 【发放时机】只在【路演赛段】发榜时发放 —— 路演评审综合分是 MVP 公式的
 *         最后一个输入（任务书 §七「4 赛段总积分 + S4 路演评审综合」）。
 *      ② 【幂等键】(届期, 队伍) —— 同一支队的 MVP 整届只发一次，跨赛段发榜不再重发。
 *    ⛔ 本届没有路演赛段、或路演赛段尚无评分结果 ⇒ **不发 MVP**
 *       （公式缺最后一个输入，不做半个公式的奖 —— 见 P3 计划「已知限制」）。
 */
function awardMvp({ db, editionId, stageId, rules: R, createdAt }) {
  const stages = repo.listEditionStages(db, editionId);
  const roadshowStage = stages.find((s) => s.kind === 'roadshow');
  // ① 发放时机：只有路演赛段发榜才发 MVP
  if (!roadshowStage || roadshowStage.id !== stageId) return [];
  const roadshowScores = repo.listStageResults(db, roadshowStage.id)
    .map((r) => ({ teamId: r.team_id, score: r.total }));
  if (!roadshowScores.length) return [];      // 路演还没评分 → 公式的最后一个输入缺失 → 不发

  const stagePoints = [];
  const packageOf = new Map();
  for (const stage of stages) {
    if (stage.kind === 'roadshow') continue;
    const built = buildStageRanking({ db, stage, R });
    for (const row of built.ranking.ordered) {
      const res = built.results.find((r) => r.team_id === row.teamId);
      stagePoints.push({ teamId: row.teamId, stageId: stage.key, points: built.points[row.teamId] ?? 0 });
      packageOf.set(row.teamId, res?.task_package_id ?? null);
    }
  }
  if (!stagePoints.length) return [];

  // MVP 决胜口径在 criteria.json（P3 自有），computeMvp 只认 pointsConfig.mvp → 服务层合并注入
  const mvpPointsConfig = {
    ...R.points,
    mvp: { ...R.points.mvp, tiebreak: R.criteria?.mvp?.tiebreak },
  };
  const byPackage = new Map();
  for (const p of stagePoints) {
    const key = packageOf.get(p.teamId) ?? '__none__';
    if (!byPackage.has(key)) byPackage.set(key, []);
    byPackage.get(key).push(p);
  }

  // ② 幂等键 = (届期, 队伍)：同一支队的 MVP 整届只发一次（跨赛段发榜不再重发）
  //    ⛔ P11 修正：原实现是「这一队发过就整队跳过」⇒ **重发路演赛段时 MVP 赢家变了也不改分**
  //    （榜单快照是新的，MVP 积分却还是上一轮的）。现在改成**差额更正**，与名次积分同款口径：
  //    「本轮该发多少」减「已发多少」，差额作为新记录写进流水（原记录不动）。
  const already = new Map();   // `${teamId}|${userId}` → 已发合计
  const alreadyTeams = new Set();
  for (const r of pointsRepo.listLedgerByEdition(db, editionId)) {
    if (r.kind !== 'mvp') continue;
    alreadyTeams.add(r.team_id);
    const key = `${r.team_id}|${r.user_id}`;
    already.set(key, (already.get(key) ?? 0) + (Number(r.points) || 0));
  }

  // 先把本轮每个包的 MVP 赢家与分值算出来
  const desired = new Map();   // teamId → { points, packageId }
  for (const [pkgId, points] of byPackage) {
    // ★ 路演名次积分是【包内第几名】→ 必须先按包过滤，否则外队会挤掉本包真冠军（P3-27）
    const pkgTeamIds = new Set(points.map((p) => p.teamId));
    const pkgRoadshowScores = roadshowScores.filter((r) => pkgTeamIds.has(r.teamId));
    const out = computeMvp({
      stagePoints: points, roadshowScores: pkgRoadshowScores, packageId: pkgId, pointsConfig: mvpPointsConfig,
    });
    if (!out.mvp) continue;
    const teamId = out.mvp.teamId;
    if (!pkgTeamIds.has(teamId)) continue;      // 防御：获奖队必须属于本任务包
    // MVP 积分口径：rules/criteria.mvp.awardPointsSource = 'stage_points_sum'
    const awardPoints = points.filter((p) => p.teamId === teamId).reduce((s, p) => s + (Number(p.points) || 0), 0);
    desired.set(teamId, { points: awardPoints, packageId: pkgId });
  }

  // 差额更正：本轮没人拿 MVP 的队（已发过的）要把差额扣回去
  const teams = new Set([...desired.keys(), ...alreadyTeams]);
  const awarded = [];
  const corrections = [];
  for (const teamId of teams) {
    const want = desired.get(teamId);
    const target = want ? want.points : 0;
    for (const m of repo.listTeamMembers(db, teamId)) {
      const key = `${teamId}|${m.user_id}`;
      const delta = target - (already.get(key) ?? 0);
      if (!delta) continue;
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId, userId: m.user_id,
        kind: 'mvp', points: delta, createdAt,
      });
      corrections.push({ teamId, userId: m.user_id, points: delta });
    }
    if (want) awarded.push({ teamId, packageId: want.packageId, points: want.points });
  }
  awarded.corrections = corrections;
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
import { applyVisibility } from '../domain/visibility.js';
import { randomUUID } from 'node:crypto';
import { computeTier, applyTierDemotion, classifyDepartment, isDataOrPrototypeMilestone } from '../domain/tier.js';
import { listTeamRows } from '../db/repo/teams.js';
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
  // ★ 终审 M-3：`reasons_json` 解析加保护 —— 脏数据直接 JSON.parse 会抛错 → 接口 500。
  //    口径与榜单侧一致（collectWarnings 对快照 JSON 解析有 try/catch）：解析失败降级为空数组，
  //    并**显式带一条告警**（不静默 —— 静默的空产出比报错更危险，R-AUD-05）。
  const warnings = [];
  let reasons = [];
  if (record?.reasons_json) {
    try {
      const parsed = JSON.parse(record.reasons_json);
      reasons = Array.isArray(parsed) ? parsed : [];
    } catch {
      reasons = [];
      warnings.push({
        source: 'tier', code: 'REASONS_PARSE_FAILED',
        message: '段位记录的原因说明无法解析，已降级为空列表，请人工核对',
      });
    }
  }
  const out = {
    teamId, teamName: team.name, tier, tierName: tiers.find((t) => t.key === tier)?.name ?? tier,
    benefits: (R.ranks?.benefits || {})[tier] || [], neverUnlocks: R.ranks?.neverUnlocks || [],
    reasons,
    warnings,
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

/**
 * 段位榜：C 段及以上公示队名与名次；D 段只给本人进度卡（冲突裁决 C-02）。
 * ⛔ 可见性在 API 层过滤：本函数产出**原始 payload**，过滤交给 applyVisibility(scope='tier')。
 *    —— 这也是 applyVisibility 里 `scope==='tier'` 分支的**唯一生产调用方**
 *    （Task 7 台账 W26 发现：该分支当时零调用方，`viewerTeamIds` 在榜单服务里是死接线）。
 * @param editionId 届期 id（由调用方解析：缺省取当届）
 */
export function getTierBoard({ db, editionId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  const order = (R.ranks?.tiers || []).map((t) => t.key);
  const teams = listTeamRows(db, { editionId });
  const records = new Map(tierRepo.listLatestTiersByEdition(db, editionId).map((r) => [r.team_id, r]));
  const rows = teams.map((t) => {
    const rec = records.get(t.id);
    const milestones = tierRepo.listMilestonesByTeam(db, t.id);
    return {
      teamId: t.id,
      teamName: t.name,
      tier: rec?.tier ?? 'D',                 // 没有段位记录 = D 段（兜底口径）
      tierRank: null,
      milestoneCount: rec?.milestone_count ?? 0,
      progress: {
        milestones: milestones.map((m) => ({ key: m.key, label: m.label })),
        milestoneCount: rec?.milestone_count ?? 0,
      },
    };
  }).sort((a, b) => {
    const ia = order.indexOf(a.tier);
    const ib = order.indexOf(b.tier);
    if (ia !== ib) return ib - ia;                    // 段位高的在前
    if (a.milestoneCount !== b.milestoneCount) return b.milestoneCount - a.milestoneCount;
    return cmpStr(a.teamId, b.teamId);                // 确定性兜底（不用随机 id）
  });
  rows.forEach((r, i) => { r.tierRank = i + 1; });
  return applyVisibility({
    payload: { scope: 'tier', editionId, rows, warnings: [] },
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope: 'tier',
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: order,
    },
  });
}

/**
 * ★ 段位计算（唯一的生产入口）：里程碑 + 企业签字 → 段位 → 写 tier_records。
 * ⚠️ 没有这个函数，Task 4 的整套段位引擎就只是死代码（队伍永远兜底 D 段）。
 * ⛔ 域函数签名定死（不能加参数），所以「配置 → 标志位」的解析必须在这一层做：
 *    isDataOrPrototype   ← rules.criteria.tier.dataOrPrototypeMilestones
 *    isBusinessDepartment ← 部门关键词 + unknownDepartmentCountsAsBusiness
 * @param record 是否写入 tier_records（发榜时写；只读查询用 false）
 */
export function computeTeamTier({ db, teamId, now, rules = null, record = true }) {
  const R = rules || getDefaultRules();
  const criteria = R.criteria || {};
  const tierCfg = criteria.tier || {};
  const milestones = tierRepo.listMilestonesByTeam(db, teamId);
  const signoffs = tierRepo.listSignoffsByTeam(db, teamId);
  const keyOf = new Map(milestones.map((m) => [m.id, m.key]));

  const active = signoffs.filter((s) => !s.revoked_at);
  const signedIds = new Set(active.map((s) => s.milestone_id));

  const domainMilestones = milestones.map((m) => ({
    key: m.key,
    countsTowardTier: m.counts_toward_tier !== 0,
    // R-PTS-01：默认 requires_signoff=1 → 必须有未撤回的企业签字才算达成
    achieved: m.requires_signoff === 0 || signedIds.has(m.id),
    isDataOrPrototype: isDataOrPrototypeMilestone(m.key, criteria),
  }));

  const domainSignoffs = active.map((s) => {
    const kind = classifyDepartment(s.department, criteria);
    const isBusinessDepartment = kind === 'business'
      || (kind === 'unknown' && tierCfg.unknownDepartmentCountsAsBusiness === true);
    return {
      milestoneKey: keyOf.get(s.milestone_id) ?? null,
      department: s.department,
      revokedAt: null,
      isBusinessDepartment,
    };
  });

  const computed = computeTier({ milestones: domainMilestones, signoffs: domainSignoffs, ranksConfig: R.ranks });

  // 闲置降档：相对**本次重算出的**段位降（不相对历史记录 → 不会每发一次榜再降一档）
  const lastAt = tierRepo.getTeamLastActivityAt(db, teamId);
  const at = now ?? new Date().toISOString();
  const daysSinceLastActivity = lastAt
    ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(lastAt)) / 86400000))
    : 0;
  const demotion = applyTierDemotion({
    tier: computed.tier,
    daysSinceLastActivity,
    revokedSignoffs: [],     // ⛔ 撤回归档已由「重算」体现，再喂一次会重复降级
    ranksConfig: R.ranks,
  });
  const tier = demotion.demoted ? demotion.tier : computed.tier;

  if (record) {
    tierRepo.insertTierRecord(db, {
      id: randomUUID(), teamId, tier,
      milestoneCount: computed.milestoneCount,
      businessSignoffCount: computed.businessSignoffCount,
      reasonsJson: JSON.stringify([...computed.reasons, ...(demotion.demoted ? [demotion.reason] : [])]),
      computedAt: at,
    });
  }
  const tierName = (R.ranks?.tiers || []).find((t) => t.key === tier)?.name ?? tier;
  return {
    ...computed, tier, tierName,
    demoted: demotion.demoted, demotionReason: demotion.reason, publish: demotion.publish,
  };
}
```

- [ ] **Step 5b: 段位计算接线（P3-15 修复 —— 段位引擎不许是死代码）**

> **【为什么有这一步】** Task 4 的 `computeTier` / `applyTierDemotion` / `classifyDepartment` /
> `isDataOrPrototypeMilestone` 若只有测试调用方，**整套段位引擎就是死代码** ——
> `tier_records` 永远没有生产写入路径，`getTeamTier` 只能回落到兜底的 `'D'`，
> R-PTS-01/02/03/05 全部落空。这与 P2 终审的 **I-2**（`checkJudgePool` 零调用方）、
> P1 Task 3 的 **A1** 同一类病根：**能力被建好却从不校验 / 从不被调用**。
> 本步把「段位怎么被算出来」写成可执行规格，而不是留一句「Consumes: computeTier」的悬空承诺。

**段位口径（必须按这个口径实现，不许各写各的）**

| 概念 | 口径 | 依据 |
|---|---|---|
| 里程碑「已达成」 | `requires_signoff = 0` → 已固定即达成；`requires_signoff = 1` → **必须有未撤回的企业签字**才算达成 | R-PTS-01「工作室能刷打卡，刷不到企业签字」 |
| 「企业业务部门签字」 | `classifyDepartment(department) === 'business'`；`unknown` 按 `criteria.tier.unknownDepartmentCountsAsBusiness` 决定（出厂 `false`） | R-PTS-03 + `unknownDepartmentCountsAsBusiness` 这个配置项**不许形同虚设** |
| 「撤回签字 → 降回对应档」 | **由「按未撤回签字重算段位」实现**（该里程碑不再达成 → 门槛不够 → 自然落到低一档） | R-PTS-04 |
| 「连续 14 天零提交 → 降 1 档」 | 由 `applyTierDemotion` 承担，**相对本次重算出的段位**降 | R-PTS-04 |
| 「提交」的时间口径 | 队伍**自己**的产出：行为分事件 / 里程碑固定 / 企业签字。⛔ **不含 `points_ledger`** —— 发榜会写积分流水，若把它算作提交，发榜就把「零提交」刷新掉了，降级规则永远不触发 | 降级规则不能被发榜动作自我豁免 |
| 降级不叠加 | 撤回归档与闲置降档同时命中时**只降 1 档** | `applyTierDemotion` 的 `Math.max` 口径 |

> ⚠️ **不要把 `revokedSignoffs` 喂给 `applyTierDemotion`**：撤回签字的影响已经由「重算」体现，
> 再喂一次会**重复降级**（S → A 之后再 A → B）。生产链路里 `applyTierDemotion` 只负责闲置降档。

**实现位置**：本步的三段代码**已并入**下面三个**整文件块**（避免「片段块 + 整文件块」两处维护、
以及 `/tmp/splice-plan.mjs` 把片段块覆盖成整文件的老坑）：

- `src/db/repo/tiers.js` → 追加 `getTeamLastActivityAt`（**并把「取最新一条」的兜底排序键
  从 `id DESC` 改成 `rowid DESC`** —— `tier_records.id` 是 `randomUUID()`，用它兜底等于
  「取最新一条」顺序不可复现，与全局约定 #39 冲突）
- `src/services/tier.js` → 追加 `computeTeamTier`（`getTeamTier` 保持不变，这是**新增**的写路径）
- `src/services/leaderboard.js` → `publishLeaderboard` 里在 `const awarded = {` **之前**重算段位；
  文件顶部追加 `import { computeTeamTier } from './tier.js';`

> ⚠️ `computeTeamTier` 返回的 `tierName` 必须取**最终档位**（降级后档位可能变了）的中文名：
> 用 `R.ranks.tiers.find((t) => t.key === tier)?.name ?? tier`，
> **不要**直接透传 `computed.tierName`（那是降级**前**的名字）。

**验收用例**（已含在 `test/leaderboard-service.test.js` 里）：

| 用例 | 钉住什么 |
|---|---|
| 「发榜时【重算】段位」 | 种子里的 `tier_records` 是 A；发榜后 t_a 变成 **B**（3 个里程碑里只有 2 个有未撤回签字）、`business_signoff_count = 1`（技术部门签字不算业务部门）；没有里程碑的 t_b 是 D。**没有接线的话这条会红** —— 历史记录还是 A |
| 「连续 14 天零提交 → 降 1 档并公示」 | 发榜时刻比队伍最后提交晚 20 天 → t_a 从 B 降到 **C**，且 `reasons_json` 里有 `inactive_14days` |

- [ ] **Step 6: 修改 src/server.js（注册 4 个 P3 路由）**

顶部 import 区追加：

> ⚠️ **【不要】再 import 一次 AppError** —— server.js 第 20 行已有
> `import { appError, AppError } from './errors.js';`。重复声明会让**整个模块加载失败**
> （SyntaxError: Identifier 'AppError' has already been declared）→ 平台全挂（P3-23）。
> ⚠️ 同时把 P1 的 `import { registerRegistrationRoutes } from './http/routes/registration.js';`
> 改成 `import { registerRegistrationRoutes, pickCurrentEdition } from './http/routes/registration.js';`
> （届期缺省解析要用 `pickCurrentEdition` —— P1 已导出它，改的是**引用**不是新增导出）。

```javascript
import { registerMilestoneRoutes } from './http/routes/milestone.js';
import { registerBehaviorRoutes } from './http/routes/behavior.js';
import { getLeaderboard, getRollingLeaderboard } from './services/leaderboard.js';
import { getPerformanceCard } from './services/performance-card.js';
import { getTeamTier, getTierBoard } from './services/tier.js';
import { listEditions, getEdition } from './db/repo/editions.js';
```

`createApp` 内、`router.add('GET', '/api/me', ...)` 之后追加：

```javascript
  // ── P3 榜单与积分 ───────────────────────────────────────────
  // ⚠️ 路由优先级由 P0 的 router **逐段比较**决定：静态段胜参数段
  //    （P0 终审 C4-1 修的就是「比参数段个数」那个错版）。
  //    ⇒ '/api/leaderboard/rolling' 与 '/api/leaderboard/tier' 都不会被
  //    '/api/leaderboard/:stageId' 劫持。
  router.add('GET', '/api/leaderboard/rolling', async (ctx) => {
    const editionId = resolveEditionId(ctx.db, ctx.query.editionId);
    return getRollingLeaderboard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
  });
  // ⚠️ 静态段 'tier' 优先于参数段 ':stageId'（router 逐段比较：静态胜参数）
  router.add('GET', '/api/leaderboard/tier', async (ctx) => {
    const editionId = resolveEditionId(ctx.db, ctx.query.editionId);
    return getTierBoard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
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

**终审修复轮追加**（I-3 / I-4 的两条写入口，与上面的只读路由分开注册）：

```javascript
  // P3 写入路由（企业里程碑签字 / 行为分事件）
  registerMilestoneRoutes(router);
  registerBehaviorRoutes(router);
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/leaderboard-service.test.js` → Expected: PASS（**24** 个测试全过：leaderboard-service.test.js 24 —— 规格自带 8 + 变异检验补测 7 + 规格缺陷补测 4 + Task 8 补测 5）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/db/repo src/services src/server.js test/leaderboard-service.test.js
git commit -m "feat(P3): 榜单服务、战绩卡与 4 个榜单 API"
```

---

### Task 8: 前端榜单页 + 段位榜 + 战绩卡 + 回归验收

**Files:**
- Create: `platform/web/views/leaderboard.js`、`platform/web/views/tier.js`、`platform/web/views/card.js`、`platform/test/leaderboard-web.test.js`
- Modify: `platform/web/app.js`（注册路由 + query 透传）、`platform/web/api.demo.js`（演示版补 P3 接口）
- Modify（Task 7 建立的，本 Task 只追加）：`platform/src/services/tier.js`（新增 `getTierBoard`）、`platform/src/server.js`（新增 `/api/leaderboard/tier` 路由 + 届期缺省解析）、`platform/test/leaderboard-service.test.js`（段位榜与届期解析的用例）

**Interfaces:**
- Consumes: Task 7 的 4 个 API
- Produces: `leaderboardHtml(model)` / `tierHtml(model)` / `cardHtml(model)` → HTML 字符串（纯函数，可单测）；路由 `#/leaderboard`（滚动总榜）｜`#/leaderboard/:stageId`（赛段榜）｜`#/tier`（段位榜）｜`#/card/:teamId`（战绩卡）

> ⛔ **前端只渲染，不做过滤**（可见性已在 API 层完成）。
> ⛔ **降级告警置顶**：P2 计算出的 warnings 必须显式展示在榜单页顶部，不静默。

- [ ] **Step 1: 写失败的测试**

`platform/test/leaderboard-web.test.js`：

```javascript
// platform/test/leaderboard-web.test.js —— P3 前端三页的渲染行为
//
// 规则溯源：
//   - 「前端只渲染，不做过滤」→ 可见性在 API 层完成（设计文档 §6.6 / 冲突裁决 C-02）
//   - 「降级告警置顶」→ S-5 / C-05：降级状态必须显式展示，不静默
//   - 「队名必须转义」→ 设计文档 §14.2 + P0 终审 I-2（innerHTML 插值 = 存储型 XSS）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaderboardHtml } from '../web/views/leaderboard.js';
import { tierHtml } from '../web/views/tier.js';
import { cardHtml } from '../web/views/card.js';
import { loadRules } from '../src/config.js';

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

test('★ 滚动总榜的告警要标出是哪一段降级（多赛段来源）', () => {
  const html = leaderboardHtml({
    scope: 'rolling',
    warnings: [{ code: 'NO_COMPUTATION_SNAPSHOT', message: '本赛段尚无计算快照', stageId: 'st_2', stageKey: 'S2', stageName: '空赛段' }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  assert.ok(html.includes('空赛段'), '告警要标出来源赛段名');
  assert.ok(html.indexOf('空赛段') < html.indexOf('A队'), '告警仍然置顶');
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
    rows: [
      { teamId: 't_s', teamName: 'S队', tier: 'S', tierRank: 1 },
      { teamId: 't_a', teamName: 'A队', tier: 'A', tierRank: 2 },
      // ⚠️ 队名同样可能带 HTML → 段位榜也必须转义
      { teamId: 't_x', teamName: '<img src=x onerror=alert(1)>', tier: 'B', tierRank: 3 },
    ],
    selfProgress: { teamId: 't_d', tier: 'D', progress: { milestones: [{ key: 'k', label: '企业问题确认' }] } },
  });
  assert.ok(html.includes('S队'));
  assert.ok(html.includes('A队'));
  assert.ok(!html.includes('D队'), 'D 段队名不得出现在段位榜');
  assert.ok(html.includes('本人进度'), 'D 段只给本人进度卡');
  assert.ok(!html.includes('<img src=x'), '段位榜队名必须转义');
  assert.ok(html.includes('&lt;img'));
});

test('★ 战绩卡：里程碑勾选式 + 企业签字标识，不出现签字人字段', () => {
  const html = cardHtml({
    teamName: 'A队', tier: 'A',
    items: [
      { key: 'problem_confirmed', label: '企业问题确认', achieved: true, signed: true },
      { key: 'data_connected', label: '真实数据接入', achieved: false, signed: false },
      // ⚠️ 里程碑标签也可能来自企业自定义 → 同样必须转义
      { key: 'x', label: '<img src=x onerror=alert(1)>', achieved: false, signed: false },
    ],
    benefits: ['辅导期名额候选'], neverUnlocks: ['奖金', '决赛名次'],
  });
  assert.ok(html.includes('企业问题确认'));
  assert.ok(html.includes('真实数据接入'));
  assert.ok(html.includes('已签'), '企业签字标识要显示');
  assert.ok(!html.includes('signatory'), '不得渲染签字人字段');
  assert.ok(!html.includes('签字人'));
  assert.ok(html.includes('辅导期名额候选'));
  assert.ok(!html.includes('<img src=x'), '里程碑标签必须转义');
  assert.ok(html.includes('&lt;img'));
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

test('★ app.js 必须把路由参数与 query 透传给视图', () => {
  const src = readFileSync(join(here, '..', 'web', 'app.js'), 'utf8');
  assert.ok(src.includes('params: found.params'), '视图拿不到路由参数（stageId / teamId）');
  assert.ok(src.includes('query: currentQuery()'), '视图拿不到 query（scope / editionId）');
  assert.ok(src.includes('function currentQuery()'), '必须自己解析 hash 上的 query');
});

test('★ 演示版适配器：段位榜分支必须排在赛段榜分支之前', async () => {
  // ⚠️ 实施补记 2026-10-21（P6 Task 5，D5-03）：演示适配器从 P0 的「假数据桩」换成
  //    「浏览器内真跑规则引擎的适配器」。默认导出的 api 走 fetch 取种子与规则
  //    （浏览器里才对；Node 的 fetch 不认相对 URL ⇒ 报 "Failed to parse URL from ./seed/..."），
  //    所以本用例改为【显式注入】种子与规则（createDemoApi）。
  //    ⚠️ 断言一条没少，还多了两条（段位榜 / 滚动总榜必须真有队伍）——
  //    「段位分支排在赛段分支之前」这条陷阱依然被守着（scope 断言 + rows 非空）。
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage, seed, rules });
  // ⚠️ P11：演示站的 compute 与正式站**同口径** —— 都要先登录
  await api.post('/api/auth/login', { name: '演示管理员' });
  await api.post('/api/stages/stage_final/compute', {});

  const tier = await api.get('/api/leaderboard/tier');
  assert.equal(tier.scope, 'tier', '段位榜不能被赛段榜分支吃掉');
  assert.ok(tier.rows.length > 0, '段位榜要有队伍');
  const rolling = await api.get('/api/leaderboard/rolling');
  assert.equal(rolling.scope, 'rolling');
  assert.ok(rolling.rows.length > 0, '滚动总榜要有队伍');
  const stage = await api.get('/api/leaderboard/st_1?scope=business');
  assert.equal(stage.scope, 'business');
  const card = await api.get('/api/teams/t_alpha/performance-card');
  assert.ok(Array.isArray(card.items), '战绩卡要有 items');
});

test('★ 转义必须复用 web/escape.js（全站唯一入口），视图不得各写一份', () => {
  for (const f of ['leaderboard.js', 'tier.js', 'card.js']) {
    const src = readFileSync(join(here, '..', 'web', 'views', f), 'utf8');
    assert.ok(src.includes("from '../escape.js'"), `${f} 必须复用 web/escape.js`);
    assert.ok(!/export function escapeHtml/.test(src), `${f} 不得重复定义 escapeHtml（会与 P0 的实现漂移）`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/leaderboard-web.test.js` → Expected: FAIL —— `Cannot find module '../web/views/leaderboard.js'`

- [ ] **Step 3: 创建三个视图文件**

`platform/web/views/leaderboard.js`：

```javascript
// web/views/leaderboard.js — 榜单页（A 榜 / B 榜 / 个人榜 + 滚动总榜）
//
// 依据：本轮（P7）「现有页面打磨到生产级」
//   + 设计文档 §9「榜单页：口径切换 + 赛段选择 + 降级告警置顶」+ §12 三件套
//   + S-5 / C-05「降级状态必须显式展示，不静默」
//
// ⛔ 前端只渲染，不做过滤：可见性已在 API 层完成（设计文档 §6.6）。
// ⛔ 降级告警置顶：P2 计算出的 warnings 显式展示在最上方，不静默（S-5 / C-05）。
//    ⚠️ **位置是硬契约**：测试断言「告警的字符索引 < 队名的字符索引」，
//        所以告警块必须排在整页最前（页头之前），不能塞到表格下面。
// ⛔ 告警正文不许出现内部工作语言：英文维度键 / 队伍 id / 评委 id / 内部原因码
//    一律由后端分层（message = 人话，detail = 内部明细），前端只渲染。
// ⚠️ 口径切换靠 URL（?scope=）而不是前端状态机 —— 刷新 / 分享链接都停在同一屏。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）——
//    这里**不重复定义** escapeHtml：三个视图各写一份会漂移，且漏改一处就是一处 XSS。
import { escapeHtml } from '../escape.js';
import { milestoneMark } from '../icons.js';
import {
  barRow, emptyState, errorState, loadingState, pageHead,
  rankBadge, sectionTitle, statRow, tableWrap, tabs,
} from '../ui.js';
// ⚠️ 段位徽章的映射住在 ./tier.js（段位语义的归属地），这里只取用不重复定义。
import { tierBadge } from './tier.js';

/**
 * 口径元数据（纯数据）：标题 / 副标题 / 空态口径。
 * ⚠️ 标题语义是既有契约：rank → A 榜、business → B 榜 · 商业战绩、
 *    personal → 个人积分榜、rolling → 滚动总榜 · 全赛段累计（沿用打磨前的措辞）。
 */
const SCOPES = {
  rank: {
    id: 'rank',
    label: 'A 榜',
    title: 'A 榜 · 赛段名次',
    sub: '本赛段名次：按总分排名，积分按赛段规则发放。',
    empty: '本赛段还没有发榜 —— 组委会完成该赛段的评审、计算与发榜后，榜单会出现在这里。',
  },
  business: {
    id: 'business',
    label: 'B 榜',
    title: 'B 榜 · 商业战绩',
    sub: '商业战绩：里程碑达成进度公示（评分与签署细节不公开）。',
    empty: '本赛段还没有商业里程碑记录 —— 企业确认后，这里会公示每支队伍的里程碑进度。',
  },
  personal: {
    id: 'personal',
    label: '个人榜',
    title: '个人积分榜',
    sub: '个人积分榜：按届期累计的个人积分排名，终生上榜。',
    empty: '本届还没有个人积分 —— 赛段发榜后积分会累计到个人名下。',
  },
  rolling: {
    id: 'rolling',
    label: '滚动总榜',
    title: '滚动总榜 · 全赛段累计',
    sub: '滚动总榜：跨全部赛段累计积分，任意赛段发榜后自动更新。',
    empty: '本届还没有已发榜的赛段 —— 任意一个赛段发榜后，总榜会自动出现。',
  },
};

/**
 * 降级告警（置顶）。
 * ⚠️ 滚动总榜的告警来自【多个赛段】，必须标出是哪一段降级了（否则读者不知道该查哪段）。
 *    赛段榜 / B 榜 / 个人榜的告警没有 stageName → 不渲染这一段。
 *
 * 【文案分层 2026-10-23 —— 内部工作语言不许出现在公开页正文】
 *   ⛔ 原来把 `[code]`（normalization_fallback / R2_missing_dual_signature 这种
 *      内部审计键）当正文前缀直接打出来 ⇒ 每个访客都看得见内部规则键。
 *      现在：**人话 message 为主体**，code 降级成**小号等宽标签**跟在后面
 *      （`.warn__code`，title 属性做 tooltip），`detail`（内部明细）单独一行
 *      （`.warn__detail`，更弱的颜色）。
 *   ⚠️ 可见性在 API 层裁决：`detail` 有没有、是什么，由后端按 `audit:read` 决定
 *      （领域层唯一入口 src/domain/visibility.js 的 applyWarningVisibility，
 *      由 applyVisibility 内部调用；正式站与演示站共用同一份）⇒ 前端只「有就显示」，不自己判断。
 *   ⚠️ **位置是硬契约**：告警块仍然置顶（S-5 / C-05；测试断言「告警的字符索引 < 队名的字符索引」）。
 *   ⚠️ 这一段不直接用 ui.js 的 noticeState()：它的 items 是**纯文本**（统一 escapeHtml），
 *      渲染不出「正文 + 代码标签 + 明细行」的三段结构；这里自己拼这段结构，
 *      但沿用 notice 的 class 契约（notice / notice--warn / notice__title / notice__list）。
 */
function warningsHtml(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return '';
  const items = list.map((w) => {
    const stage = w?.stageName ? `【${escapeHtml(w.stageName)}】` : '';
    const msg = escapeHtml(w?.message ?? '');
    const code = w?.code
      ? `<span class="warn__code" title="内部规则键：${escapeHtml(w.code)}">${escapeHtml(w.code)}</span>`
      : '';
    const detail = w?.detail
      ? `<div class="warn__detail">${escapeHtml(String(w.detail))}</div>`
      : '';
    return `<li class="warn__item">${stage}${msg}${code ? ` ${code}` : ''}${detail}</li>`;
  });
  const title = `本轮降级提示（${list.length}）—— 以下维度未按标准口径计算`;
  return `<div class="notice notice--warn" role="alert">`
    + `<p class="notice__title">${escapeHtml(title)}</p>`
    + `<ul class="notice__list">${items.join('')}</ul>`
    + `</div>`;
}

/** 页头（标题 + 副标题 + 跨页入口）。 */
function headHtml(meta) {
  return pageHead({
    title: meta.title,
    sub: meta.sub,
    actions: [{ label: '段位榜', href: '#/tier' }, { label: '总览', href: '#/' }],
  });
}

/**
 * 口径切换（tabs）。
 * ⚠️ 靠 URL 而不是前端状态机：刷新不丢状态、链接可分享。
 * ⚠️ 赛段口径（A/B/个人）必须带上赛段 id —— 滚动总榜是**届期级**的，没有赛段维度。
 */
function scopeTabsHtml(scope, stageId, stages) {
  const target = stageId || stages[0]?.id || '';
  const link = (id) => (target
    ? `#/leaderboard/${encodeURIComponent(String(target))}?scope=${id}`
    : `#/leaderboard?scope=${id}`);
  return tabs({
    items: [
      { id: 'rank', label: SCOPES.rank.label, href: link('rank') },
      { id: 'business', label: SCOPES.business.label, href: link('business') },
      { id: 'personal', label: SCOPES.personal.label, href: link('personal') },
      { id: 'rolling', label: SCOPES.rolling.label, href: '#/leaderboard?scope=rolling' },
    ],
    active: scope,
  });
}

/**
 * 赛段选择器。
 * ⚠️ 拉不到赛段列表时**静默降级**（返回空串）：赛段列表挂了不能让整个榜单页报错。
 * ⚠️ 滚动总榜是届期级的 ⇒ 此时点某个赛段 = 切到那个赛段的 A 榜。
 */
function stagePickerHtml(scope, stageId, stages) {
  if (!stages.length) return '';
  const stageScope = scope === 'rolling' ? 'rank' : scope;
  const current = scope === 'rolling' ? '' : String(stageId ?? '');
  const items = stages.map((s) => {
    const id = String(s?.id ?? '');
    const label = s?.name || s?.key || id;
    const href = `#/leaderboard/${encodeURIComponent(id)}?scope=${stageScope}`;
    return id === current
      ? `<span class="btn btn--primary btn--sm" aria-current="page">${escapeHtml(label)}</span>`
      : `<a class="btn btn--ghost btn--sm" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
  return `<div class="row"><span class="muted small">赛段</span><div class="btn-group">${items.join('')}</div></div>`;
}

/** 指标行：一眼可见的队伍数 / 分数 / 降级条数。 */
function statsHtml(scope, rows, warnings) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const totals = rows.map((r) => num(r?.total)).filter((v) => v !== null);
  const points = rows.map((r) => num(r?.points)).filter((v) => v !== null);
  const max = (arr) => (arr.length ? Math.max(...arr) : null);
  const warnCount = Array.isArray(warnings) ? warnings.length : 0;
  const cards = [];

  if (scope === 'personal') {
    const self = rows.find((r) => r?.isSelf);
    cards.push({ label: '上榜选手', value: rows.length, tone: 'brand' });
    cards.push({ label: '最高个人积分', value: max(totals) ?? '—', tone: 'success' });
    cards.push({ label: '我的名次', value: self?.rank ?? '—' });
  } else if (scope === 'business') {
    const done = rows.reduce((acc, r) => acc + (num(r?.achievedCount) ?? 0), 0);
    const all = rows.reduce((acc, r) => acc + (num(r?.milestoneCount) ?? 0), 0);
    cards.push({ label: '上榜队伍', value: rows.length, tone: 'brand' });
    cards.push({ label: '里程碑达成', value: done, tone: 'success', hint: `共 ${all} 项` });
    cards.push({ label: '有进展队伍', value: rows.filter((r) => (num(r?.achievedCount) ?? 0) > 0).length });
  } else if (scope === 'rolling') {
    const stages = rows.map((r) => num(r?.stages)).filter((v) => v !== null);
    cards.push({ label: '在榜队伍', value: rows.length, tone: 'brand' });
    cards.push({ label: '最高累计积分', value: max(points) ?? '—', tone: 'success' });
    cards.push({ label: '最多参赛赛段', value: max(stages) ?? '—' });
  } else {
    cards.push({ label: '在榜队伍', value: rows.length, tone: 'brand' });
    cards.push({ label: '榜首总分', value: max(totals) ?? '—', tone: 'success' });
    cards.push({ label: '最高积分', value: max(points) ?? '—' });
  }
  cards.push({
    label: '降级告警',
    value: warnCount,
    tone: warnCount ? 'warn' : 'neutral',
    hint: '降级必须显式处理，不静默',
  });
  return statRow(cards);
}

/** A 榜（赛段名次）表格。 */
function rankRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const body = rows.map((r, i) => {
    // ⚠️ 名次：优先用 API 给的 rank；滚动总榜没有 rank 字段 ⇒ 用行序兜底
    const rank = r?.rank ?? i + 1;
    const tied = Array.isArray(r?.tiedWith) && r.tiedWith.length;
    const pkg = r?.packageRank ? `包内第 ${escapeHtml(r.packageRank)} 名` : '—';
    return `<tr>`
      + `<td>${rankBadge(rank)}</td>`
      + `<td>${escapeHtml(r?.teamName || r?.teamId)}`
      + `${tied ? ' <span class="muted small">（并列）</span>' : ''}</td>`
      + `<td class="td-num num">${escapeHtml(r?.total ?? '—')}</td>`
      + `<td class="td-num num">${escapeHtml(r?.points ?? '—')}</td>`
      + `<td>${tierBadge(r?.tier)}</td>`
      + `<td class="td-num num">${pkg}</td>`
      + `</tr>`;
  }).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">总分</th>`
    + `<th class="td-num">积分</th><th>段位</th><th class="td-num">包内</th></tr></thead>`
    + `<tbody>${body}</tbody>`,
    { caption: 'A 榜：本赛段名次' },
  );
}

/** 滚动总榜表格（届期级：累计积分 + 参赛赛段数 + 最好名次）。 */
function rollingRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const body = rows.map((r, i) => {
    const rank = r?.rank ?? i + 1;
    const best = r?.bestRank ?? '—';
    return `<tr>`
      + `<td>${rankBadge(rank)}</td>`
      + `<td>${escapeHtml(r?.teamName || r?.teamId)}</td>`
      + `<td class="td-num num">${escapeHtml(r?.points ?? '—')}</td>`
      + `<td class="td-num num">${escapeHtml(r?.stages ?? '—')}</td>`
      + `<td class="td-num num">${escapeHtml(best)}</td>`
      + `<td>${tierBadge(r?.tier)}</td>`
      + `</tr>`;
  }).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">累计积分</th>`
    + `<th class="td-num">参赛赛段</th><th class="td-num">最好名次</th><th>段位</th></tr></thead>`
    + `<tbody>${body}</tbody>`,
    { caption: '滚动总榜：全赛段累计' },
  );
}

/** 个人榜表格。 */
function personalRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const body = rows.map((r, i) => `<tr>`
    + `<td>${rankBadge(r?.rank ?? i + 1)}</td>`
    + `<td>${escapeHtml(r?.name || r?.userId)}`
    + `${r?.isSelf ? ' <span class="muted small">（我）</span>' : ''}</td>`
    + `<td class="td-num num">${escapeHtml(r?.total ?? '—')}</td>`
    + `</tr>`).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>选手</th><th class="td-num">个人积分</th></tr></thead>`
    + `<tbody>${body}</tbody>`,
    { caption: '个人积分榜' },
  );
}

/** B 榜（商业战绩）：卡片网格 —— 每支队伍一张进度卡。 */
function businessRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const cards = rows.map((r) => {
    const ms = Array.isArray(r?.milestones) ? r.milestones : [];
    const done = ms.filter((m) => m?.achieved);
    const items = ms.map((m) => `<li class="${m?.achieved ? 'done' : 'todo'}">`
      + `<span class="mark">${milestoneMark(Boolean(m?.achieved))}</span>`
      + `<span>${escapeHtml(m?.label)}</span></li>`).join('');
    const total = r?.milestoneCount ?? ms.length;
    return `<article class="card biz-card">
      <div class="row row--between">
        <h3>${escapeHtml(r?.teamName || r?.teamId)}</h3>
        ${tierBadge(r?.tier)}
      </div>
      ${barRow({
        label: '里程碑达成',
        value: r?.achievedCount ?? done.length,
        max: total,
        // ⚠️ 备注改成「共 N」（不是「/ N」）：条形图的值与备注是相邻的两段文本，
        //    「/ N」拼上去会变成「3/ 5」这种怪读法；「共 5」更清楚。
        note: `共 ${total}`,
        tone: 'success',
      })}
      <ul class="milestones">${items || '<li class="muted">暂无数据</li>'}</ul>
    </article>`;
  }).join('');
  return `<div class="grid grid--2">${cards}</div>`;
}

/**
 * 榜单页渲染（纯函数，可单测）。
 *
 * ⚠️ model.loading / model.error 是**视图自有的状态位**（不属于 API 返回形状）——
 *    纯函数没法发请求，就靠这两个位表达外壳三件套。
 * ⚠️ model.stages / model.stageId 是**赛段选择器**需要的额外字段（可选，缺了就不渲染选择器）。
 */
export function leaderboardHtml(model) {
  const scope = SCOPES[model?.scope] ? model.scope : 'rank';
  const meta = SCOPES[scope];
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const warnings = Array.isArray(model?.warnings) ? model.warnings : [];
  const stages = Array.isArray(model?.stages) ? model.stages : [];
  const stageId = String(model?.stageId ?? '');

  // ⚠️ 告警置顶（硬契约）：必须排在整页最前，不能排在表格后面。
  const warnHtml = warningsHtml(warnings);
  const head = headHtml(meta);
  const switcher = scopeTabsHtml(scope, stageId, stages);

  if (model?.loading) return `${warnHtml}${head}${switcher}${loadingState({ rows: 3, label: '正在加载榜单…' })}`;
  if (model?.error) return `${warnHtml}${head}${switcher}${errorState({ message: model.error })}`;

  const body = scope === 'business' ? businessRowsHtml(rows, meta)
    : scope === 'personal' ? personalRowsHtml(rows, meta)
      : scope === 'rolling' ? rollingRowsHtml(rows, meta)
        : rankRowsHtml(rows, meta);

  return `${warnHtml}${head}${switcher}`
    + `${statsHtml(scope, rows, warnings)}`
    + `${stagePickerHtml(scope, stageId, stages)}`
    + `${sectionTitle(scope === 'business' ? '商业战绩' : '榜单')}`
    + `${body}`;
}

/** 挂载（真实 API / 演示适配器） */
export async function renderLeaderboard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'leaderboard-view';
  const routeStageId = String(ctx.params?.stageId ?? '');
  const scopeParam = String(ctx.query?.scope ?? '');
  // ⚠️ 届期缺省取「当届」由服务端解析（resolveEditionId），前端不必先查届期
  const editionQuery = ctx.query?.editionId ? `?editionId=${encodeURIComponent(ctx.query.editionId)}` : '';

  const load = async () => {
    wrap.innerHTML = leaderboardHtml({
      scope: scopeParam || (routeStageId ? 'rank' : 'rolling'),
      loading: true,
    });

    // ⚠️ 赛段列表：拉失败**静默降级**（空列表 ⇒ 不渲染选择器），
    //    绝不能因为赛段列表挂了就让整个榜单页报错。
    const stages = await ctx.api.get(`/api/stages${editionQuery}`)
      .then((r) => (Array.isArray(r?.items) ? r.items : []))
      .catch(() => []);

    // 口径与赛段的解析（口径靠 URL，赛段没有就取赛段列表的第一个）
    let scope = scopeParam || (routeStageId ? 'rank' : 'rolling');
    let stageId = routeStageId;
    if (!stageId && scope !== 'rolling') {
      stageId = String(stages[0]?.id ?? '');
      if (!stageId) scope = 'rolling';   // 没有赛段可用 ⇒ 退回届期级的滚动总榜
    }
    if (scope === 'rolling') stageId = '';   // ⚠️ 滚动总榜是届期级的，没有赛段维度

    let data = null;
    let error = null;
    try {
      const url = scope === 'rolling'
        ? `/api/leaderboard/rolling${editionQuery}`
        : `/api/leaderboard/${encodeURIComponent(stageId)}?scope=${encodeURIComponent(scope)}`;
      data = await ctx.api.get(url);
    } catch (e) {
      error = e.message;
    }

    wrap.innerHTML = leaderboardHtml({
      scope,
      stageId,
      stages,
      rows: data?.rows ?? [],
      warnings: data?.warnings ?? [],
      error,
    });
    // ⚠️ 错误态的重试按钮必须真的能重跑（生产级错误态不能是死路一条）
    wrap.querySelector('[data-action="retry"]')?.addEventListener('click', () => { load().catch(() => {}); });
  };
  await load();
  return wrap;
}
```

`platform/web/views/tier.js`：

```javascript
// web/views/tier.js — 段位榜
// 依据：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡。
//   + 本轮（P7）「现有页面打磨到生产级」：外壳三件套 + 页头 + 指标行 + 设计系统表格。
// ⛔ 前端不隐藏 D 段，而是【不渲染】它：D 段根本不会出现在 API 返回的 rows 里
//   （可见性在 API 层裁决，设计文档 §6.6 / C-02）⇒ 视图**不许自己 filter**。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）。
import { escapeHtml } from '../escape.js';
import { iconDot } from '../icons.js';
import {
  badge, emptyState, errorState, loadingState, pageHead, panel,
  rankBadge, sectionTitle, statRow, tableWrap,
} from '../ui.js';

/**
 * 段位 → 徽章色调（**全站唯一一份**）。
 *
 * ⚠️ 为什么住在段位视图里：段位徽章是「段位语义」的映射，
 *    榜单页（./leaderboard.js）与战绩卡（./card.js）都要用同一套 ——
 *    否则同一个 A 段在三个页面颜色不同，读者会以为它们是不同段位。
 *    ⇒ 这里导出，那两个视图 import（视图之间**只共享这一份语义映射**，不共享渲染逻辑）。
 *
 * 映射口径（依据：设计文档 §9「段位 S / A / B / C / D」的强弱次序）：
 *    S / A → brand（顶尖）｜ B → info ｜ C → success（刚够公示名次）｜ D → neutral（未公开）
 */
const TIER_TONES = { S: 'brand', A: 'brand', B: 'info', C: 'success', D: 'neutral' };

/** 段位 → 色调；未知段位一律 neutral（颜色静默失效比样式错更糟）。 */
export function tierTone(tier) {
  return TIER_TONES[String(tier ?? '').trim().toUpperCase()] ?? 'neutral';
}

/** 段位徽章；空段位不渲染徽章（免得出现一个没有意义的空胶囊）。 */
export function tierBadge(tier) {
  const text = String(tier ?? '').trim();
  return text ? badge(text, tierTone(text)) : '';
}

/**
 * 段位榜渲染（纯函数，可单测）。
 *
 * ⚠️ `model.loading` / `model.error` 是**视图自有的状态位**（不属于 API 返回形状）——
 *    纯函数没法发请求，就靠这两个位表达外壳三件套；
 *    测试直接喂 API 形状时它们都是 undefined ⇒ 走正常渲染分支。
 */
export function tierHtml(model) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const self = model?.selfProgress || null;

  const head = pageHead({
    title: '段位榜',
    sub: 'C 段及以上公示队名与名次；D 段只公示本人进度，不公示排名（C-02）。',
    actions: [{ label: '看榜单', href: '#/leaderboard' }],
  });
  if (model?.loading) return `${head}${loadingState({ rows: 3, label: '正在加载段位榜…' })}`;
  if (model?.error) return `${head}${errorState({ message: model.error })}`;

  const board = rows.length
    ? tableWrap(
      `<thead><tr><th>名次</th><th>队伍</th><th>段位</th><th class="td-num">里程碑</th></tr></thead>`
      + `<tbody>${rows.map((r) => `<tr>`
        + `<td>${rankBadge(r.tierRank)}</td>`
        + `<td>${escapeHtml(r.teamName || r.teamId)}</td>`
        + `<td>${tierBadge(r.tier)}</td>`
        + `<td class="td-num num">${escapeHtml(r.milestoneCount ?? '—')}</td>`
        + `</tr>`).join('')}</tbody>`,
      { caption: '段位榜：C 段及以上公示队名与名次' },
    )
    : emptyState({
      title: '暂无数据',
      hint: '还没有可公示的段位记录 —— 队伍完成里程碑并经企业确认后，段位会在发榜时出现在这里。',
    });

  // ⚠️ selfProgress 是 D 段选手**唯一**能看到的自己的信息（视图不渲染别人），
  //    所以它必须自成一块、说清「这是你的」。
  const selfPanel = self
    ? panel({
      title: '本人进度',
      desc: '仅你可见：当前段位与里程碑清单（达成状态以发榜结果为准）。',
      body: selfBodyHtml(self),
    })
    : '';

  return `${head}${statRow(tierStats(rows))}`
    + `${panel({ title: '公示榜单', desc: '按段位从高到低排列，名次为段位榜名次。', body: board })}`
    + `${selfPanel}`;
}

/**
 * 指标行：公示队伍总数 + 各段位队伍数。
 * ⚠️ 只统计**确实出现在 rows 里**的段位：给没出现的段位写 0 是假数据
 *    （D 段队伍的数前端根本看不到 —— API 不返回它们）。
 */
function tierStats(rows) {
  const counts = new Map();
  for (const r of rows) {
    const t = String(r?.tier ?? '').trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const cards = [{ label: '公示队伍', value: rows.length, tone: 'brand', hint: 'C 段及以上' }];
  for (const t of ['S', 'A', 'B', 'C', 'D']) {
    if (!counts.has(t)) continue;
    cards.push({ label: `${t} 段`, value: counts.get(t), tone: tierTone(t) });
  }
  return cards;
}

/**
 * 本人进度面板内容。
 *
 * ⚠️ **这里不能用 milestoneMark()**：服务层 `progress.milestones` 只给
 *    `{ key, label }`（见 src/services/tier.js），**没有 achieved 字段** ——
 *    「哪些已达成」这个信息服务端没给前端。
 *    ⇒ 若此处渲染成「未达成」，就是**前端在编造状态** ⇒ 读屏用户会被告知错误信息。
 *    ⇒ 用中性圆点（纯装饰），达成数由旁边的「已计分里程碑 N 项」承担。
 */
function selfBodyHtml(self) {
  const ms = Array.isArray(self?.progress?.milestones) ? self.progress.milestones : [];
  const counted = self?.milestoneCount ?? self?.progress?.milestoneCount;
  const items = ms.map((m) => `<li class="todo"><span class="mark">${iconDot(14)}</span>`
    + `<span>${escapeHtml(m.label)}</span></li>`).join('');
  return `<div class="row row--between">
      <span class="muted small">当前段位</span>
      ${tierBadge(self?.tier) || '<span class="muted">—</span>'}
    </div>
    <p class="muted small">已计分里程碑 ${escapeHtml(counted ?? '—')} 项</p>
    <ul class="milestones">${items || '<li class="muted">暂无数据</li>'}</ul>`;
}

/** 挂载（真实 API / 演示适配器） */
export async function renderTier(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'tier-view';
  // ⚠️ 届期缺省取「当届」由服务端解析（resolveEditionId）
  const edition = ctx.query?.editionId ? `?editionId=${encodeURIComponent(ctx.query.editionId)}` : '';

  const load = async () => {
    wrap.innerHTML = tierHtml({ loading: true });
    try {
      wrap.innerHTML = tierHtml(await ctx.api.get(`/api/leaderboard/tier${edition}`));
    } catch (e) {
      wrap.innerHTML = tierHtml({ error: e.message });
    }
    // ⚠️ 错误态的重试按钮必须真的能重跑（生产级错误态不能是死路一条）
    wrap.querySelector('[data-action="retry"]')?.addEventListener('click', () => { load().catch(() => {}); });
  };
  await load();
  return wrap;
}
```

`platform/web/views/card.js`：

```javascript
// web/views/card.js — 项目商业战绩卡
// 依据：设计文档 §9「7 类里程碑勾选式 + 企业签字标识 + 不显示签字人」
//   + 本轮（P7）「现有页面打磨到生产级」：外壳三件套 + 页头 + 指标行 + 分组面板。
// ⛔ 不渲染签字人字段（企业签字不公开，R-ENT-04 / S10 §0.3）。
// ⚠️ 渲染出去的 HTML 里**不许出现「签字人」三个字**（同一条约束的文案侧）——
//    代码注释里可以写，输出里不行（测试直接扫输出字符串）。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）。
import { escapeHtml } from '../escape.js';
import { milestoneMark } from '../icons.js';
import {
  badge, emptyState, errorState, loadingState, pageHead, panel,
  sectionTitle, statRow,
} from '../ui.js';
import { tierTone } from './tier.js';

/**
 * 战绩卡渲染（纯函数，可单测）。
 *
 * ⚠️ `model.loading` / `model.error` 是**视图自有的状态位**（不属于 API 返回形状）——
 *    纯函数没法发请求，就靠这两个位表达外壳三件套。
 */
export function cardHtml(model) {
  const items = Array.isArray(model?.items) ? model.items : [];
  const teamName = String(model?.teamName ?? '');
  const tier = String(model?.tier ?? '');
  // ⚠️ 达成数 / 总数优先用 API 给的值；缺了才按 items 现算（视图不编造口径）。
  const achieved = model?.achievedCount ?? items.filter((m) => m?.achieved).length;
  const total = model?.total ?? items.length;

  const head = pageHead({
    title: teamName ? `${teamName} · 商业战绩卡` : '商业战绩卡',
    sub: '里程碑按赛制清单逐项勾选；达成项自动打勾。',
  });
  if (model?.loading) return `${head}${loadingState({ rows: 3, label: '正在加载战绩卡…' })}`;
  if (model?.error) return `${head}${errorState({ message: model.error })}`;

  const done = items.filter((m) => m?.achieved);
  const todo = items.filter((m) => !m?.achieved);

  const milestoneBody = items.length
    ? `${milestoneGroup('已达成', done, 'success', doneItemHtml)}`
      + `${milestoneGroup('未达成', todo, 'neutral', todoItemHtml)}`
    : emptyState({
      title: '暂无数据',
      hint: '这支队伍还没有登记任何里程碑 —— 报名组队后系统会按赛制生成里程碑清单。',
    });

  const benefits = Array.isArray(model?.benefits) ? model.benefits : [];
  const never = Array.isArray(model?.neverUnlocks) ? model.neverUnlocks : [];

  return `${head}${statRow([
    { label: '当前段位', value: tier || '—', tone: tierTone(tier) },
    { label: '已达成里程碑', value: achieved, tone: 'success', hint: `共 ${total} 项` },
    { label: '里程碑总数', value: total },
  ])}`
    + `${panel({
      title: '里程碑',
      desc: '达成项自动打勾；企业确认后会补上「已签」标识。',
      body: milestoneBody,
    })}`
    + `${panel({
      title: '已解锁权益',
      desc: `按当前段位（${tier || '—'}）解锁`,
      body: benefits.length
        ? `<ul class="list-divided">${benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '<p class="muted small">当前段位还没有解锁额外权益 —— 段位提升后会自动出现在这里。</p>',
    })}`
    // ⚠️ 「永不解锁」用 warn 面板：它需要和「已解锁权益」在视觉上分开 ——
    //    否则读者会把它当成一份还没拿到的清单。
    + `${panel({
      title: '永不解锁',
      desc: '以下权益与本赛段赛制不符，任何段位都不会解锁。',
      body: never.length
        ? `<ul class="list-divided">${never.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '<p class="muted small">暂无数据</p>',
      tone: 'warn',
    })}`;
}

/** 里程碑分组（标题 + 计数徽章 + 勾选列表）。 */
function milestoneGroup(title, items, tone, itemHtml) {
  return `${sectionTitle(title, badge(`${items.length} 项`, tone))}`
    + `${items.length
      ? `<ul class="milestones">${items.map(itemHtml).join('')}</ul>`
      : '<p class="muted small">暂无数据</p>'}`;
}

/** 已达成项：✓ 图标 + 标签 + 「已签」标识。 */
function doneItemHtml(m) {
  return `<li class="done"><span class="mark">${milestoneMark(true)}</span>`
    + `<span>${escapeHtml(m?.label)}</span>`
    + `${m?.signed ? `<span class="signed">${badge('已签', 'success')}</span>` : ''}</li>`;
}

/** 未达成项：○ 图标 + 标签。 */
function todoItemHtml(m) {
  return `<li class="todo"><span class="mark">${milestoneMark(false)}</span>`
    + `<span>${escapeHtml(m?.label)}</span></li>`;
}

/** 挂载（真实 API / 演示适配器） */
export async function renderCard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card-view';
  const teamId = String(ctx.params?.teamId ?? '');

  const load = async () => {
    wrap.innerHTML = cardHtml({ loading: true });
    try {
      const data = await ctx.api.get(`/api/teams/${encodeURIComponent(teamId)}/performance-card`);
      wrap.innerHTML = cardHtml(data);
    } catch (e) {
      wrap.innerHTML = cardHtml({ error: e.message });
    }
    // ⚠️ 错误态的重试按钮必须真的能重跑（生产级错误态不能是死路一条）
    wrap.querySelector('[data-action="retry"]')?.addEventListener('click', () => { load().catch(() => {}); });
  };
  await load();
  return wrap;
}
```

- [ ] **Step 3b: 补后端缺口 —— 段位榜接口 `GET /api/leaderboard/tier` + 届期缺省解析**

> ⛔ **本步是实施时补的**：规格的 `tier.js` 视图写的是 `ctx.api.get('/api/leaderboard/tier')`，
> 但 **Task 7 只建了 4 个接口**（`/api/leaderboard/:stageId`、`/api/leaderboard/rolling`、
> `/api/teams/:id/performance-card`、`/api/teams/:id/tier`）—— **没有段位榜这个列表接口**。
> 按规格原样落地 ⇒ 段位榜页必然 404（`/api/leaderboard/tier` 会被 `:stageId` 当成赛段 id 吃掉 → `STAGE_NOT_FOUND`）。
> 与 Task 1 偏差表 3c 的「指向不存在实现的活引用」同款病根。
>
> **代码折叠**：本步的三处新增已并入 Task 7 的两个整文件块（**逐字等于实现**，不在此重复维护）：
> ① `src/services/tier.js` → `getTierBoard({ db, editionId, viewer, rules })`
> ② `src/server.js` → `router.add('GET', '/api/leaderboard/tier', ...)`
> ③ `src/server.js` → `resolveEditionId(db, editionId)`（届期缺省取当届）
> 见 **Task 7 Step 7 的代码块**。

本步新增的届期解析辅助函数（放在 `createApp` 之前）：

```javascript
/**
 * 届期解析：显式传了 → 不存在就 404；没传 → 取【当届】（与 /api/registration-criteria 同一口径）。
 * ⚠️ 「当届」= 尚未结束（ends_at >= 今天）的最早一届，都没有就退回最后一届（pickCurrentEdition）。
 *    理由：榜单 / 段位榜都是「本届」视图，前端不必先查一遍届期再传进来。
 */
function resolveEditionId(db, editionId) {
  if (editionId) {
    if (!getEdition(db, editionId)) throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
    return editionId;
  }
  const edition = pickCurrentEdition(listEditions(db));
  if (!edition) throw new AppError(404, 'EDITION_NOT_FOUND', '尚无届期');
  return edition.id;
}
```

>
> **三条口径**（写在这里，代码块只落实现）：
> 1. **段位榜的数据源** = 该届**全部队伍**的最新段位记录（`tier_records`；没有记录 = D 段兜底），
>    排序 = 段位高 → 里程碑多 → `team_id` 码位序（确定性兜底）。
> 2. **可见性在 API 层**：段位榜走 `applyVisibility({ scope: 'tier' })` ——
>    **C 段及以上公示队名与名次；D 段只给本人进度卡（无名次、无队名）**（冲突裁决 C-02）。
>    ⛔ 这条同时**补上了 Task 7 台账 W26 的发现**：`applyVisibility` 里 `scope==='tier'` 分支
>    此前**零生产调用方**，`viewerTeamIds` 在榜单服务里是死接线 —— 本步把它接上。
> 3. **届期缺省取当届**：`resolveEditionId` —— 显式传了但不存在 → 404；没传 → `pickCurrentEdition`
>    （与 `/api/registration-criteria` 同一口径：尚未结束的最早一届）。
>    ⚠️ **「当届」解析与真实日期有关** ⇒ 测试里把种子届期的 `ends_at` 推到 2099，
>    否则那条用例会随日历过期而红。

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
// web/api.demo.js — 演示版适配器（浏览器内 localStorage）
// ⛔ 数据不跨人共享。这是当前无云主机条件下的客观边界。
// ✅ 但规则引擎在浏览器里真实运行，演示出来的算法行为与正式系统一致。
const KEY = 'hks_demo_db';

function load() {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify({}));
  return JSON.parse(localStorage.getItem(KEY));
}
function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

export const api = {
  async get(path) {
    const db = load();
    if (path === '/api/health') return { ok: true, demo: true };
    if (path === '/api/me') {
      return db.me ? { user: db.me } : (() => { throw Object.assign(new Error('未登录'), { status: 401 }); })();
    }
    // ⚠️ 顺序要紧：'tier' 必须排在 '/api/leaderboard/' 之前，
    //    否则段位榜会拿到赛段榜的形状（前端渲染成空段位列）。
    if (path.startsWith('/api/leaderboard/rolling')) {
      return { scope: 'rolling', rows: db.leaderboard || [], warnings: db.warnings || [], demo: true };
    }
    if (path.startsWith('/api/leaderboard/tier')) {
      return { scope: 'tier', rows: db.tiers || [], demo: true };
    }
    if (path.startsWith('/api/leaderboard/')) {
      const scope = new URL(path, 'http://x').searchParams.get('scope') || 'rank';
      return { scope, rows: db.leaderboard || [], warnings: db.warnings || [], demo: true };
    }
    if (path.endsWith('/performance-card')) {
      return {
        teamName: '演示战队', tier: 'A', items: db.milestones || [],
        benefits: [], neverUnlocks: ['奖金', '决赛名次'], demo: true,
      };
    }
    if (path.endsWith('/tier')) {
      return { rows: db.tiers || [], demo: true };
    }
    throw Object.assign(new Error(`演示版未实现该接口：${path}`), { status: 404 });
  },
  async post(path, body) {
    const db = load();
    if (path === '/api/auth/login') {
      db.me = { id: 'demo_admin', name: body?.name || '演示管理员', mbaStatus: 'mba', org: '演示' };
      save(db);
      return { user: db.me };
    }
    if (path === '/api/auth/logout') { db.me = null; save(db); return { ok: true }; }
    throw Object.assign(new Error(`演示版未实现该接口：${path}`), { status: 404 });
  },
  async patch() { throw Object.assign(new Error('演示版不支持写操作'), { status: 404 }); },
  async del() { throw Object.assign(new Error('演示版不支持写操作'), { status: 404 }); },
  subscribe() { return () => {}; },
};
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/leaderboard-web.test.js` → Expected: PASS（**9** 个测试全过：leaderboard-web.test.js 9 —— 规格自带 6 + 转义复用补测 1 + 透传/演示适配器补测 2）

- [ ] **Step 7: 全量回归**

Run: `cd platform && node --test` → Expected: 全部通过（P0–P3 的全部用例，**709/709** —— Task 8 落地时是 691，终审修复轮又补 18 条）
Run: `cd platform && node scripts/migrate.js` → Expected: 输出 `迁移完成，当前版本 4`

- [ ] **Step 8: 提交**

```bash
cd platform && git add web src/services/tier.js src/server.js test/leaderboard-web.test.js test/leaderboard-service.test.js
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
| R-RNK-09 MVP（4 赛段总积分 + S4 路演，每包 1 个） | Task 3 `computeMvp` + Task 7 `awardMvp`（**发放时机 = 路演赛段发榜；幂等键 = (届期, 队伍)** —— 见终审修复轮 P3-36） | Task 3「computeMvp」用例 + Task 7 发榜用例 + 终审修复轮「MVP 只在路演赛段发榜时发放，且整届只发一次」 |
| R-RNK-10 个人积分终生上榜 | Task 3 `computePersonalPoints`（`personal.lifetime`）+ Task 7 `buildPersonalPayload`（**仓储行 → 域契约的映射在服务层** `toLedgerEntry`，见终审修复轮 P3-35） | Task 3「computePersonalPoints」用例 + 终审修复轮「个人积分榜端到端」（发榜 → API 行数 = 流水条数，姓名 / 名次 / byKind 齐全） |
| R-PTS-01 段位锚定企业签字里程碑 | Task 4 `computeTier`（只数"已达成 + 有企业签字"的里程碑） | Task 4「撤回的签字不计入段位」 |
| R-PTS-02 段位表 D/C/B/A/S | Task 4 `computeTier`（读 `rules.ranks.tiers`，门槛全部来自配置） | Task 4 段位边界用例 |
| R-PTS-03 S 段只认企业业务部门签字 | Task 4 `classifyDepartment` + `computeTier`（技术部门签字不计入 S） | Task 4「技术部门签字不计入 S」 |
| R-PTS-04 段位可降级且规则公开 | Task 4 `applyTierDemotion`（撤回签字降档 / 14 天零提交降 1 档 / `publishDemotion` 公示） | Task 4「降级」用例 |
| R-PTS-05 段位换资源不换钱 | Task 4 `computeTier`（`benefits` 来自配置、`neverUnlocks` 常驻返回） | Task 4「段位只换资源不换钱」 |
| R-PTS-06 段位只影响同分排序不制造额外名额 | Task 4 `computeTier` 不产出任何名额；Task 7 名次计算完全不读段位（段位只进展示字段 `tier`） | Task 5「隔离断言」+ Task 7 名次用例 |
| R-PTS-07 行为分明细 | Task 5 `behaviorScore`（分值全部读 `rules/behavior-points.json`）+ **终审修复轮补的写入口** `services/behavior.js`（分值取规则值，提交方自报分被忽略） | Task 5「行为分明细」用例 + 终审修复轮「提交合规证据 → 200 + 落库 + 分值取自规则」 |
| R-PTS-08 行为分 ≤10% 且只做"垫底排序" | Task 2 `assertChainInvariants`（behavior 必须是 `tied_only`、非链首、最后一项实质依据）+ Task 5（不进 total）+ **终审修复轮：「没提交」= 0 分**（原实现留 null → 破同分链判「本组缺少可比较的值」⇒ 整组都不用行为分，提交过的队与没提交的队永远并列） | Task 2 链不变量 + Task 5 两条隔离断言 + 终审修复轮「端到端：API 提交的事件真的进了破同分链的 behavior 级」 |
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
| 3c | **迁移 `004_leaderboard.sql` 多 1 张表 `stage_team` + 多 1 个仓储文件 `src/db/repo/stage-teams.js`** | 契约的 P3 表清单里没有 `stage_team` | 追加 `stage_team`（`stage_id` + `team_id` 唯一索引 + 双外键）与配套仓储 `registerStageTeams` / `listStageTeamIds` / `isTeamInStage` / `hasStageRoster` | **兑现 P2 计划 D-33 的承诺**（P2 的 D-33「已知限制」栏明写「赛段级队伍边界需要一张 `stage_team` 表 —— 登记在 P3」）。⚠️ 原 P3 计划**全文没有一处提到 `stage_team` / 名册**（`grep -c` 全为 0）→ 一条**指向不存在实现的活引用**，与 P0 终审发现的 SSE 那条（审计 I-6）同一类病。**不能拖**：届期级名册挡不住「**同届期另一赛段**的队」被写进本赛段 → 外队进榜，**只有赛段级名册能挡**。⚠️ **本阶段只建表 + 建仓储**；服务层接线在 **Task 7**（P3 自己的写入口：行为分事件 / 里程碑签字 / MVP 投票），**名册的登记时机**（赛段开启时把该届参赛队登记进来）属 **P5 的工作流** |
| 4 | `src/services/leaderboard.js` 三个函数多了可选参数 `rules` | `getLeaderboard({ db, stageId, scope, viewer })` 等 | 追加可选的 `rules` 参数（原有参数逐字保留） | 服务层需要 `rules.tiebreak` / `rules.visibility` / `rules.points`，而契约签名里没有。调用方（HTTP 层）有 `ctx.rules` 直接注入；未注入时由 `getDefaultRules()` 从 `platform/rules/` 懒加载兜底，**不产生静默默认值** |
| 5 | `src/domain/points.js` 新增 `computePrizeShares` | 未列 | 新增 `computePrizeShares({ ordered, prizeTable })` | R-JDG-20「并列共享奖金（总额不变）」需要一条可执行算法才能被验证；奖金表本身仍由调用方传入（目前无配置文件规定金额） |
| 6 | `applyTiebreakChain` / `rankTeams` 的返回值是超集 | `{ ordered, applied }` / `{ ordered, tieGroups, rankStyle }` | 分别追加 `groups` / `warnings` / `applied` | `applied` 与 `groups` 是计算 1224 名次与「降级告警置顶」所必需的中间量；契约里已有的字段全部保留且语义不变 |
| 7 | `applyVisibility` 的 `context` 追加 `viewerTeamIds` | `context` 未展开 | `{ scope, viewerTeamIds?, viewerTeamId?, tierOrder? }` | 一名选手可同时在多支队伍里，单个 `viewerTeamId` 表达不了 |
| 8 | ~~新增 `src/errors/app-error.js`~~ → **改为复用 P0 的 `src/errors.js`** | §0 要求「抛 AppError」，P0 已建该类（Task 4） | 本阶段**不新建**错误模块；直接 `import { AppError, appError } from '../errors.js'`（**P0 建立**），签名统一为 **status-first**：`AppError(status, code, message, detail)` / `appError(status, code, message, detail)` | ⚠️ 原写法是 `appError(code, message, status)`（code 在前），与 P1/P4 的 `appError(status, code, message)` **参数顺序相反**。两套并存必然有一半调用点写错顺序，且 `err.status` / `err.code` 会互换——HTTP 层会返回错误的状态码。已统一为 status-first，并把 P3 内 12 处调用点全部改写 |
| 9 | `rules/*.json` 的加载与校验在 `src/config.js` 里扩展 | §1 只列了 9 份 P0 规则文件 | `src/config.js` 的 `FILES` / `grouped` / `validateRules` 追加 `points` 与 `criteria` | P3 新增 2 份规则文件，必须走同一条 fail-fast 校验通路，否则「改 JSON 即改规则」这条 S-2 会破 |
| 10 | 新增 3 个仓储文件 | 未列仓储文件名 | `src/db/repo/leaderboard.js` / `points.js` / `tiers.js` | 所有 SQL 必须收在 `src/db/repo/`；文件名带 P3 语义，避免与 P1/P2 的仓储重名冲突 |
| 11 | **新增规则文件的 `version` 参与一致性校验的方式** | 契约只写「规则配置的 version 必须全等」 | **不需要在本阶段改 `src/config.js` 的 version 校验** —— 基线已按「有 `id` 的是一份配置」**自动派生**（`validateRules(rules, expectedCount)` + `loadRules` 传 `Object.keys(FILES).length`），加多少份配置都自动覆盖 | ⚠️ 原计划隐含「要把 points / criteria 加进 `versionValues` 数组」—— 那个数组**已不存在**（P0 当时是硬编码 9 项，P1 已改成自动派生）。若照原意去改，会动到一份**不该动**的校验代码。**硬前提**：新配置文件必须带 `"id"`（`points.json` → `"id": "points"`、`criteria.json` → `"id": "criteria"`），且识别到的配置份数必须等于 `FILES` 的键数，否则**拒绝启动**。依据：基线 `platform/src/config.js` + 漂移审计报告 I-2 / D-3 |

| 12 | **新增 3 个写入口（终审修复轮）** | 契约的 P3 API 只列 4 个 `GET`（榜单 / 滚动总榜 / 战绩卡 / 段位） | 追加 `POST /api/teams/:id/behavior-events`、`POST /api/milestones/:id/signoff`、`POST /api/milestones/:id/signoff/withdraw`；并在 `createTeam` 里落 `milestones` 表行 | ⚠️ 契约**只列了读接口**，但 `behavior_events` / `milestone_signoffs` 两张表是 P3 自己建的、`signoff:create` 能力点 P0 就已注册 —— **表建了、能力点授了，却没有端点消费** ⇒ 段位恒为兜底 D 档、破同分链第 5 级永不生效。偏差表 3c 早已承诺「P3 自己的写入口」在 Task 7 接线，本阶段兑现。**INTERFACES.md 本身未修改** |
| 13 | **`publishLeaderboard` 的 MVP 发放时机与幂等键** | 契约只写 `publishLeaderboard({ db, editionId, stageId, actorId, now })` // 写 leaderboard_snapshots，**未规定积分流水的发放口径** | **只在路演赛段发榜时发放 MVP**；幂等键 = **(届期, 队伍)**；本届无路演赛段或路演未评分 ⇒ 不发 | MVP 是**届期级**奖项而发榜是**赛段级**动作，层级错配。终审实证：原实现每发一个赛段就再写一条同额流水（个人积分被重复累加），且在路演之前发榜时金额偏小而积分只增不改、补不回来。**可改**：`awardMvp` 一处 |
| 14 | **仓储行 → 域函数契约的映射放在服务层** | 契约未规定仓储返回值的形状 | `src/db/repo/points.js` 返回**原始行**（snake_case），服务层用 `toLedgerEntry` 映射成 camelCase 再喂 `computePersonalPoints` | 仓储层统一返回原始行（与 leaderboard / teams / tiers 仓储同风格），**只有仓储层知道列名** ⇒ 翻译只在一处发生一次。⚠️ 终审实证：原先两边对不上时，域函数的 `if (!entry.userId) continue;` 会把**每一条流水**静默丢弃 ⇒ 个人积分榜恒为空且不报错 |
| 15 | **行为分「没提交 = 0 分」** | 契约只写 `behaviorScore({ events, behaviorConfig })`，未规定「无事件」时的取值 | 服务层给**每支队**都填行为分（无事件 = 0），域函数的「显式缺值 → 该键不可用」语义**保持不变** | ⚠️ 「没提交」是 0 分（这一维度的值**就是 0**），不是「没有可比较的值」。原先留 null ⇒ 破同分链判「本组缺少可比较的值」⇒ **整组都不用行为分** ⇒ 提交过的队与没提交的队永远并列。⛔ 与 R-RNK-07 的口径区别：互评分「空交付队无记录」= 该维度**没被应用**（不可用）；行为分「没提交」= 值**就是 0**（可用） |

**待组委会确认的判断（非接口偏差，是本阶段做的口径选择）**

| # | 判断 | 本阶段的取值 | 依据与影响 |
|---|---|---|---|
| A | 并列时的名次积分分配 | **按位置**（并列第一占第 1、2 席 → 10 分、8 分），任一赛段积分总额恒为 23 | 任务书 §七「第一/二/三名 = 10/8/5」+ 设计文档 §6.3「任务包内全量战队排名」。按名次分配会让并列时积分总额膨胀（10+10+5=25），MVP 跨赛段比较的尺子就不一致了。**可改**：改 `computeStagePoints` 一处即可 |
| B | 名次积分的排名范围 | **任务包内**（每个任务包各自排 1/2/3 名） | 设计文档 §6.3 原文「任务包内全量战队排名」+ R-RNK-09「每个任务包决出 1 个 MVP」。A 榜页面上同时给出全赛段名次与包内名次两个字段 |
| C | MVP 积分的数值口径 | **该队计入的 4 个赛段的名次积分之和** | `rules/points.json` 没有规定 mvp 数值 → 口径写在 `rules/criteria.json.mvp.awardPointsSource`，改配置即可，不改代码 |
| D | 「连续 14 天零提交」的计时起点 | 取该队 `behavior_events` 的最新时间；从未提交过的队伍按 0 天计（不降级） | 「连续 14 天零提交」隐含已有提交历史；从未开始的新队不应因未提交被降级 |
| E | D 段队伍的段位接口对外表现 | 非成员 → **404**；成员 → 本人进度卡（无名次） | 冲突裁决 C-02「D 段只公示个人进度，不公示排名」+ 三态语义「单条不满足 → 404」 |
| F | **MVP 综合分并列时的决胜口径** | **`roadshow_points`（路演名次积分高者胜）→ `team_id` 码位序（确定性兜底）**，链在 `rules/criteria.json.mvp.tiebreak` 可配 | 任务书 §七 只给了「4 赛段总积分 + S4 路演评审综合」的**加法**公式，**没写并列怎么办**；S10 §0.3「互评的真正用途是破同分」+ §4「行为分用于同分垫底排序」确立了本赛事通则 —— **同分必须用实质依据决出，不许用字母序**。⚠️ 这不是边角：一个任务包只有 2 支队时，赛段名次积分与路演名次积分**都是 10/8**，量级相同 ⇒ 综合分**必然并列**。**属 P3 自有口径 · 待组委会确认**；**可改**：改 `rules/criteria.json.mvp.tiebreak` 一处即可（顺序即优先级），`config.js` 会对缺失/未知键/不以 `team_id` 收尾**拒绝启动** |
| G | **MVP 路演名次积分的排名范围** | **任务包内**（与其它赛段同一把尺子） | 名次积分按任务包内排名发放（偏差表 B），路演是 S4 赛段 ⇒ 同一把尺子。⚠️ 若按全赛段名次折算，外包队伍会把路演前 3 名占满，本包队伍的路演贡献被压成 0 ⇒ **跨任务包不公平**，且会让外队挤掉本包真冠军（P3-27） |

---

## Task 1 父代理预审修正台账（2026-10-21）

> Task 1 是 P3 的地基：**4 张榜单表 + 2 张补充表 + 2 份规则配置 + 配置校验**。
> 实施前做了一次**独立工程实跑**（把规格的代码块抽到 `/tmp` 的副本里跑通再落盘 —— 「先跑后派」），
> 规格自带 **8 条用例全绿**；实施完成后做**变异检验**，变异体一度出现 **12 条存活**，
> 补完用例后 **46/47 杀灭**（另 1 条等价变异体）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-1** | **Important** | **P2 的 D-33 承诺的 `stage_team` 表在本阶段一个字都没提** —— P2 的 D-33「已知限制」栏明写「赛段级队伍边界需要一张 `stage_team` 表 —— **登记在 P3**」，而 P3 计划全文 `grep -c 'stage_team\|名册\|roster'` **全为 0** | 静态核对：P3–P6 **四份计划**里 `stage_team` 只在 P2 的一句索引名里出现过；P3/P4/P5 的「名册 / roster / 赛段开启」**全部为 0** → 一条**指向不存在实现的活引用**，与 P0 终审发现的 SSE 那条（审计报告 I-6）**同一类病** | **本阶段建表 + 建仓储**（Task 1 Step 3 / Step 3b），服务层接线在 Task 7，登记时机归 P5。⚠️ **不能拖**：届期级名册挡不住「同届期**另一赛段**的队」被写进本赛段 → 外队进榜（见偏差表 3c） |

### 二、变异检验发现的实现盲区

> 变异体 **47** 个（外键摘除 / NOT NULL 与 DEFAULT 改写 / 列类型改写 / 规则值篡改 /
> 校验段摘除 / 校验段挪位 / 名册仓储语义改写 …），在 `/tmp` 副本上跑
> `leaderboard-migration.test.js` + `config.test.js` + `migrate.test.js` + `zero-deps.test.js`，
> **测试必须失败才算杀灭**。变异脚本：`/tmp/p3t1/mutate.mjs`。
>
> ⚠️ 首轮变异跑出的 **12 条存活**里，有 **1 条是变异构造自身失效**（G11：只在原位插了个注释，
> 代码块根本没挪动 → 被误判成「盲区」）。这正是纪律里点名的坑：**变异体必须真的改变行为**，
> 否则会被算成测试的锅。修正构造后立即被杀灭。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-2** | **Important** | **004 迁移的引用型外键零覆盖** —— 规格自带用例只断言**列名**，没断言外键 | 变异存活：`points_ledger` 的 4 条外键全部去掉 → 用例全绿 | 补「004 迁移的引用型外键齐全」用例：逐表断言 `PRAGMA foreign_key_list` 的 `列→父表` 映射（6 张表 12 条外键）。依据：P2 Task 1 的同一条纪律（38 条引用型外键） |
| **P3-3** | **Important** | **NOT NULL / DEFAULT / 列类型零覆盖** —— `kind` 必填、`points` 是数值、`scope` 必填、`counts_toward_tier` 默认 1、`tier_records` 有 `deleted_at`，全都没有断言 | 变异存活：`points_ledger.points` 从 REAL 改成 TEXT、`kind` 的 NOT NULL 去掉、`milestones.counts_toward_tier` 默认值改 0 → 用例全绿 | 补「NOT NULL / DEFAULT / 类型约束符合契约」用例（用 `PRAGMA table_info` 的 `notnull` / `dflt_value` / `type`） |
| **P3-4** | **Important** | **`stage_team` 名册仓储零覆盖** —— 建了表却没有写路径与判定路径的用例 | 变异存活：`isTeamInStage` 恒返回 true、`listStageTeamIds` 不过滤赛段 → 用例全绿 | 补「赛段名册仓储：登记 / 判定 / 重复登记被唯一约束挡住」用例 + 5 个 S 系列变异体 |
| **P3-5** | Minor | **配置校验的 4 条分支零覆盖** —— `criteria.tier` 缺失 / `dataOrPrototypeMilestones` 为空 / `businessDepartmentKeywords` 为空 / `points` 整份缺失 / `personal.lifetime` 非布尔 | 变异存活：逐条摘掉对应校验分支 → 用例全绿 | 补「配置校验会拒绝非法 criteria 配置 / 缺 points / personal.lifetime 非布尔」用例（5 个断言） |
| **P3-6** | Minor | **「占位策略不得被擅自启用」零覆盖** —— `demoDayAudienceVote.enabled` / `fallbackPolicy.enabled` / `unknownDepartmentCountsAsBusiness` / 企业对接会时长，全部没有断言 | 变异存活：观众票被擅自启用、未知部门默认算业务部门、对接会时长改 0 → 用例全绿 | 补「占位策略不得被擅自启用」用例（6 个断言）。⛔ 这几条都是**直接影响奖金与段位**的口子：观众票凭空进榜 = 凭空加一条没有规则依据的规则 |
| — | — | **等价变异体 G08**（`getDefaultRules` 不再缓存，每次重读 `rules/`）：缓存与否只影响读盘次数，返回的规则对象内容完全相同 ⇒ 语义等价 | 变异存活（如标注） | **不是盲区**，标记为等价变异体、允许存活 |

**Task 1 的测试条数口径**：leaderboard-migration **14**（规格自带 8 + 变异检验补测 6）。

**最终结果**：变异体 47 → **KILLED 46 / 等价变异体 1 / 有效缺口 0**；`leaderboard-migration.test.js` **14/14**；P3 全量 **551/551**。

---

## Task 2 父代理预审修正台账（2026-10-21）

> Task 2 是**名次计算**的地基：破同分链执行器 + 1224 并列名次。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**10/10 全绿**）再落盘 —— 「先跑后派」。
> 但**规格自带全绿 ≠ 规格正确**：本轮在逐行审规格时发现 **2 Important + 1 Minor 缺陷**，
> 都在**规格自己的代码块**里（实现只是忠实照抄）；实施完成后做**变异检验**，
> 变异体一度出现 **5 条存活**，补完用例后 **28/29 杀灭**（另 1 条等价变异体）。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-4** | **Important** | **`toNumber(null)` 返回 0 —— 与本函数自己的注释「非有限数按 null（缺值）处理，**不静默当 0**」直接矛盾** | 探针：`toNumber(null)` → **0**；`toNumber('')` → **0**（`Number(null)` 与 `Number('')` 都是 0，不是 NaN）。该函数是 points / tier / behavior 三个领域模块的**共同取数入口** → 「缺值」在下游被当成「0 分」，且**一路无报错** | 先判掉 `null` / `undefined` / `''` 再 `Number()`。补 2 条用例（缺值三态 + NaN/Infinity） |
| **P3-5** | **Important** | **数值型破同分键在值是字符串时按字典序比较** —— 原 `compareValues` 只要有一边是字符串就整体走 `cmpStr` | 探针：`total: '100'` 与 `total: '90'` → 排序结果 `t_b(90) , t_a(100)`：**100 分的队排在 90 分的队后面**，且没有任何报错。根因：`'100' < '90'`（字典序） | 按**键**判定口径：数值键（total / tiebreak_extra / peer / enterprise_raw / behavior）一律走数值比较；`team_id` 是标识符，永远按码位序比（'0123' 与 '123' 是两支队）。补 2 条用例（字符串总分排序 + `90` 与 `'90'` 视为同分） |
| **P3-6** | Minor | **`pick()` 名实相反** —— 名字是「挑出」，实现是「剔除」 | 规格自己给的调用点（Task 6 可见性过滤）就是剔除语义：`omit(r, [...peerKeys, 'phone', 'org', 'idCard', 'password_hash'])`。名实相反的函数一定会在某次调用里被用错方向 —— 用错方向 = **敏感字段全泄露** | 改名 `omit` 并改正文档注释；Task 6 的 6 处调用点同步改名（**在 Task 6 落地时一并改**，本阶段只改定义侧） |

### 二、变异检验发现的实现盲区

> 变异体 **29** 个（数值键表删项 / 排序方向反转 / 1224 名次偏移 / 确定性兜底拆组 /
> final_only 判定反转 / 缺值警告 code 改写 / 不变量检查逐条摘除 / `cmpStr` 换 localeCompare /
> `omit` 方向反转 / `omit` 改原对象 …），在 `/tmp` 副本上跑 `ranking.test.js` + `zero-deps.test.js`，
> **测试必须失败才算杀灭**。变异脚本：`/tmp/p3t2/mutate.mjs`。
>
> ⚠️ 首轮的 **5 条存活**里有 **2 条是「检查互相掩盖」**（行为分位置检查与确定性兜底检查
> 会同时触发）—— 必须写**隔离用例**（只让一条检查触发）才测得出来。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-7** | Minor | **两条不变量检查互相掩盖** —— 「behavior 必须是最后一项实质依据」与「必须以确定性兜底项结尾」同时触发，用例只断言错误文案包含其中一句 → 谁被摘掉都测不出 | 变异存活：逐条摘掉两个检查 → 用例全绿 | 补 2 条**隔离**用例：链里没有 behavior 时只触发兜底检查；behavior 不在末位但链尾是兜底时只触发位置检查 |
| **P3-8** | Minor | **链非法时不抛错零覆盖** —— `applyTiebreakChain` 在链不合法时抛错，但没有任何用例断言它会抛 | 变异存活：把抛错改成「照算」→ 用例全绿 | 补用例：非法链必须抛 `/破同分链配置非法/` |
| **P3-9** | Minor | **`ordered` 的 `total` 字段零覆盖** —— 榜单行要显示总分，但没断言 | 变异存活：`total: null` → 用例全绿 | 补断言 |
| **P3-10** | Minor | **`tiebreakData.byTeam` 这条数据通路零覆盖** —— 服务层按 `byTeam` 传数据，候选对象内联只是等价写法；两条路径必须给出一致名次 | 变异存活：`readValue` 不再查 `byTeam` → 用例全绿 | 补用例：两条路径名次一致 |
| **P3-11** | Minor | **`cmpStr` 的码位序口径零覆盖** —— 「不得用 localeCompare」是全局约定 #61，但没有任何断言 | 变异存活：`cmpStr` 换成 `localeCompare` → 用例全绿（`'a'/'B'` 这类才区分得开） | 补用例：`cmpStr('a','B') > 0` 且 `!== localeCompare('a','B')` |
| — | — | **等价变异体 R04**（`compareValues` 的「相等」短路被摘掉）：`a === b` 时数值路径与码位序路径都返回 0 ⇒ 两条路径结果完全相同 | 变异存活（如标注） | **不是盲区**，标记为等价变异体、允许存活 |

**Task 2 的测试条数口径**：ranking **22**（规格自带 10 + 预审补测 3 + 变异检验补测 9）。

**最终结果**：变异体 29 → **KILLED 28 / 等价变异体 1 / 有效缺口 0**；`ranking.test.js` **22/22**；P3 全量 **564/564**。


---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

---

## Task 3 父代理预审修正台账（2026-10-21）

> Task 3 是**积分口径**的落地：名次积分 10/8/5 + MVP + 个人积分 + 奖金共享。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**先跑后派**）——
> 规格自带 **6/7 绿、1 红**，红的那条牵出**两个真缺陷**。
> 实施完成后做**变异检验**：变异体 **45** 个 → **KILLED 43 / 等价存活 2 / 有效缺口 0**。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-12** | **Important** | **`computePersonalPoints` 的 1224 名次实现漏赋值** —— 并列行的 `rank` **始终是 `undefined`**。根因：赋值语句写在「名次发生变化」的分支里（`if (prev === null \|\| r.total !== prev) { r.rank = before + 1; }`），并列行走不进分支 ⇒ `rank` 从未被赋值 | 探针：ledger 造出真并列（u_2 与 u_4 都是 10 分）→ 规格实现返回 `rank = [1, 2, undefined, 4]`。**这是会流到线上的缺陷**：个人积分榜上并列的用户没有名次 → 前端渲染与「我的名次」查询都拿到 `undefined` | 改成 **Task 2 `rankTeams` 的同款范式**（按组算名次、组内**每个成员**都赋值）：`curRank` 承载当前组名次，`r.rank = curRank` **无条件赋值**。补 3 条断言：`[1,2,2,4]`（两方并列）、`[1,1,1,4]`（三方并列，下一名跳号）、以及容错三态 |
| **P3-13** | **Important** | **规格自带的 `computePersonalPoints` 用例期望值自相矛盾** —— 断言 `rank` 期望 `[1, 2, 1, 3]`，但这个序列在**降序排名**下**不可能成立**（名次 1 只能属于首组；第 3 行拿名次 1 意味着它与第 1 行同组，而第 2 行夹在中间却拿了名次 2）。更根本的是：**该用例的 ledger 根本没有并列**（总分 41 / 10 / 8 / 5）→ 用例标题写着「1224 并列」，实际从未造过并列 | 实跑：规格实现给出 `[1, 2, 3, 4]`，与期望 `[1,2,1,3]` 不符 → 用例红。**原用例的 ledger 恰好没有并列，把 P3-12 的缺陷完全盖住了** | 把 `l3` 的 8 分改成 10 分**造出真并列**，期望值改为 1224 的正确值 `[1, 2, 2, 4]`；用例标题「1224 并列」才名副其实。顺带补 `excludedEntries` 的两条断言（`personal_rollup` 排除 1 条；关掉 MVP 投决后排除 2 条） |

> **为什么这两条必须一起改**：P3-12 是**实现的错**、P3-13 是**用例的错**，而用例的错**正好把实现的错遮住了**。
> 只改实现 → 期望值仍然不成立（红）；只改用例 → 换成有并列的 ledger 后实现立刻露馅（红）。
> 这就是「规格自带全绿 ≠ 规格正确」的又一层：这一版连「自带全绿」都没达到。

### 二、变异检验发现的实现盲区

> 变异体 **45** 个（名次积分表 / onlyTopN 口径 / 位置 vs 名次发分 / MVP 赛段截断与字典序 /
> 路演折算与权重 / 队伍集合来源 / 配置兜底三项 / 个人榜累加与 kind 分桶 /
> 排除计数 / 1224 名次赋值 / 奖金分组与槽位与总额 / 浅拷贝 …），
> 在 `/tmp` 副本上跑 `points.test.js`，**测试必须失败才算杀灭**。变异脚本：`/tmp/p3t3/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-14** | Minor | **`computeMvp` 的三项配置兜底零覆盖** —— `stagesCounted` / `roadshowWeight` / `perPackage` 在 `rules/points.json` 里都有值，兜底分支**走不到** | 变异存活：把兜底 4→3 / 1→2 全部存活 | 补「配置缺 `mvp` 段时按兜底口径」的用例。⚠️ 该用例**必须造出至少两支队** —— 只有 1 支队时 `slice(0, 2)` 仍只取到 1 个，`perPackage` 的兜底值测不出来（首版就踩了这个坑，补测后复杀） |
| — | — | **等价变异体 M01**（`stagePointsFor` 的 `r < 1` 判断被摘掉）：末尾 `typeof table[r - 1] === 'number'` 这个闸门**已经把 r<1 挡成 0** ⇒ 两处闸门等价 | 探针：9 种配置 × 19 种名次 = **171 组差分，差异 0** | **不是盲区**，标记为等价变异体、允许存活。⚠️ 但它说明 `r < 1` 这个判断目前是**冗余**的 —— 保留（防御 + 自解释），**不能再算它「有测试覆盖」** |
| — | — | **等价变异体 M45**（`groups` 不做浅拷贝）：返回值的**内容完全一致**，只差对象身份 | 探针：9 组差分，差异 0 | **不是盲区**，标记为等价变异体、允许存活 |
| — | — | **构造失效 1 条**（M17 的锚点 `+ (Number(e.points) || 0));` 在文件里出现 2 次） | 构造阶段就报「锚点命中 2 次」 | 换成带上下文的更长锚点后复跑 —— 提醒：**锚点必须精确到调用点**，不能只靠一行代码 |

**Task 3 的测试条数口径**：points **24**（规格自带 7 + 预审补测 1 + 变异检验补测 16）。

**最终结果**：变异体 45 → **KILLED 43 / 等价变异体 2 / 有效缺口 0**；`points.test.js` **24/24**；P3 全量 **613/613**。

---

## Task 4 父代理预审修正台账（2026-10-21）

> Task 4 是**段位**的落地：段位表 D/C/B/A/S + 降级规则 + 权益。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**先跑后派**）—— 规格自带 **7/7 全绿**。
> 但**规格自带全绿 ≠ 规格正确**：本轮在**逐条 Task 通读**时发现 **1 条 Important 计划级缺陷**
> （段位引擎零调用方），并在**变异检验**中补掉 2 条真盲区。
> 变异体 **40** 个 → **KILLED 34 / 等价存活 6 / 有效缺口 0**。

### 一、预审发现的计划级缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-15** | **Important** | **整套段位引擎在本阶段【零生产调用方】** —— `computeTier` / `applyTierDemotion` / `classifyDepartment` / `isDataOrPrototypeMilestone` 在整份 P3 计划里**只出现在 Task 4 的定义与测试里**。Task 7 的 `src/services/tier.js` 只从 `tier_records` **读**段位（`record?.tier ?? 'D'`），**从不计算**；`publishLeaderboard` 也不重算 | `grep -n "computeTier\|applyTierDemotion\|insertTierRecord" <P3 计划>` → 命中全部落在 Task 4 段内（定义 + 测试 + 仓储定义）；Task 7 的「Consumes: … `computeTier`（Task 2–6）」是**一句没有落点的承诺**（悬空引用）。**后果**：没有任何生产路径写 `tier_records` → 所有队伍段位永远是兜底的 `'D'` → R-PTS-01（锚定企业签字）、R-PTS-02（段位表）、R-PTS-03（业务部门签字）、R-PTS-05（换资源不换钱）**四条需求全部落空**，R-PTS-04（降级）连触发点都没有 | **在 Task 7 增设「Step 5b: 段位计算接线」**，把「段位怎么被算出来」写成**可执行规格**（仓储函数 + 服务函数 + `publishLeaderboard` 接入点 + 段位口径表），而不是留一句悬空的「Consumes」。⚠️ 口径里写死了三件容易做错的事：① 里程碑「已达成」= **有未撤回的企业签字**（`requires_signoff=1` 时），否则 R-PTS-01 被架空；② 「零提交」的时间口径**不含 `points_ledger`**（发榜会写积分流水，算进去等于发榜自我豁免，降级规则永远不触发）；③ 撤回归档**由重算实现**、不再喂给 `applyTierDemotion`（否则 S→A 之后再 A→B，重复降级） |

> **为什么在 Task 4 就发现、却修在 Task 7**：段位引擎是 Task 4 建的，但**写路径**属于 Task 7 的
> `src/services/tier.js`（文件归属：最早建立者 owns）。与 P3 Task 1 处理 `stage_team` 同一手法：
> **最早发现处登记 + 最早的可行处落地**。区别在于这次不是「表建好了没写路径」，
> 而是「引擎建好了没调用方」—— 后果更隐蔽（引擎的 16 条用例全绿，但线上没有一段位）。

### 二、变异检验发现的实现盲区

> 变异体 **40** 个（部门归类的关键词 / 空值与大小写 / 里程碑取值口径 / 撤回签字 /
> 档位门槛与附加条件 / 展示字段 / 降级开关与阈值 / 公示与原因 / 索引下限 …），
> 在 `/tmp` 副本上跑 `tier.test.js`，**测试必须失败才算杀灭**。变异脚本：`/tmp/p3t4/mutate.mjs`。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-16** | Minor | **配置里的【技术】关键词不转小写零覆盖** —— 业务关键词那条有「配置写大写 `BIZ`」的用例守着，技术关键词没有对称的用例 | 变异存活：技术关键词的 `.toLowerCase()` 被摘掉 → 用例全绿 | 补对称用例：配置写大写 `TECH` 时仍能匹配 `tech` |
| **P3-17** | Minor | **`isBusinessDepartment` 标志位缺失时的口径零覆盖** —— 判定写的是 `=== true`（缺标志位 = 不是业务部门），但**没有用例钉住这一点** | 变异存活：判定改成 `!== false` → **缺标志位的签字会被当成业务部门** → S 段凭空达标（正是 `rules/criteria.json` 注释里警告的「签字部门写错不得默认算业务部门」） | 补用例：没有 `isBusinessDepartment` 的签字 → `businessSignoffCount = 0`、段位不得升到 S |
| — | — | **等价变异体 6 条**：`!d` 空值闸门（空串对任何关键词的 `includes` 都是 false）、部门名不 `trim`（`includes` 是子串匹配，首尾空格不影响）、档位查找不查最低档（`chosen` 为 null 时落到兜底 `tiers[0]`，而 `tiers[0]` 正是 D 档）、兜底不取 `tiers[0]`（`chosen` 为空 ⟺ `tiers` 为空 ⟺ `tiers[0]` 必是 undefined）、索引不做下限保护（`current` 必在 `order` 里）、闲置天数不兜底 0（`NaN` 与 `0` 比较都不大于阈值） | 探针：每条都做 **1551 组差分比对**（15 部门名 × 5 配置 × 6 里程碑集 × 6 签字集 × 6 档位配置 × 7 段位 × 10 天数 × 3 撤回集），**差异 0** | **不是盲区**，标记为等价变异体、允许存活。⚠️ 但它们说明这几处闸门是**冗余**的 —— 保留（防御 + 自解释），**不能再算它们「有测试覆盖」** |

**Task 4 的测试条数口径**：tier **16**（规格自带 7 + 变异检验补测 9）。

**最终结果**：变异体 40 → **KILLED 34 / 等价变异体 6 / 有效缺口 0**；`tier.test.js` **16/16**；P3 全量 **629/629**。

---

## Task 5 父代理预审修正台账（2026-10-21）

> Task 5 是**行为分**的落地：R-PTS-07/08/09/10 的计分明细 + 反作弊 5 条 + 与总分的算法级隔离。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**先跑后派**）—— 规格自带 **4/5 绿、1 红**，
> 红的那条牵出一个**方向性错误**的断言。另发现 1 条**配置项形同虚设**。
> 变异体 **28** 个 → **KILLED 28 / 等价 0 / 有效缺口 0**。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-18** | **Important** | **规格自带的「隔离断言 #5」期望值方向性错误** —— 断言「完全同分时行为分只改变相对顺序，**不改变名次数字**」、期望 `rank = [1, 1]`。实际实现给出 `[1, 2]` | 实跑：期望 `[1,1]`、实到 `[1,2]`。**根因**：破同分链里**只有链末的 `team_id` 是 `deterministic: true`**（`applyTiebreakChain` 明确注释「确定性兜底：只决定组内顺序，**【不】拆组**（并列名次不变）」）；而 `behavior` 是 `scope: tied_only` 的**实质依据**（非 deterministic）→ 行为分**可用时必然拆开并列组** → 名次变成 1、2。规格把「确定性兜底项不拆组」的语义**错套到了行为分身上** | 拆成两个断言，把「隔离」这条真正的性质钉住：① 行为分**可用**时拆开并列 → 名次 `[1, 2]`、顺序按行为分；② 行为分**不可用**（缺值 → `readValue` 返回 null → 该键在本组不可用）时**保持并列** → 名次 `[1, 1]`，且必须带 `tiebreak_key_unusable` 告警（不静默）。依据：R-PTS-08 原文「同分时的**最后**排序依据 ✅」—— 行为分就是破同分依据，拆开后名次理应不同 |
| **P3-19** | Minor | **`behavior.sortUse` 是一个【从未被校验】的配置项** —— 全仓唯一检查它的地方是 `assertChainInvariants`，而它的签名里**没有 `behaviorConfig` 参数**（`rankTeams` 的签名是契约定死的），生产链路**永远拿不到**这个值 → 那处检查**从不生效** | `grep -n "sortUse" platform/src/` → 只有 `behavior.js` 读它、`ranking.js` 有一处**拿不到值的**检查；`config.js` 的 `validateRules` 里**没有** `sortUse` 的校验。后果：把 `rules/behavior-points.json` 的 `sortUse` 改成 `'primary'`（行为分变主评分口径，直接违反 R-PTS-08）→ **零报错、照常启动** | 在 `src/config.js` 的 `validateRules` 里 **fail-fast**：`behavior.sortUse !== 'tiebreak_only'` → 报错拒绝启动；并加用例（改配置 → 校验报错 / 出厂配置零报错）。⚠️ 与 P2 终审 I-2（`checkJudgePool` 零调用方）、P3-15（段位引擎零调用方）**同一类病根**：能力建好了却从不调用 —— 这次是**校验**建好了却从不执行 |

### 二、变异检验

> 变异体 **28** 个（证据解析的各条分支 / 必填与 oneOf 的空白判定 / once 名额的占用时机 /
> 未知类型与 once 被拒的原因码 / 分值与达标的边界 / 配置兜底 / 排序的时间与 id 两条口径 …），
> 在 `/tmp` 副本上跑 `behavior.test.js`，**测试必须失败才算杀灭**。变异脚本：`/tmp/p3t5/mutate.mjs`。
>
> 首轮曾有 **10 条存活** —— 原因是**变异脚本拷的是仓库里的旧版测试文件**（新补的用例还没回写落地）。
> 回写后复跑 → **28/28 全杀**。教训：变异脚本必须指向**已落地的**测试文件，
> 否则「存活」会被误判成「盲区」，白补一堆用例。

**Task 5 的测试条数口径**：behavior **15**（规格自带 5 + 预审补测 1 + 变异检验补测 9）。

**最终结果**：变异体 28 → **KILLED 28 / 等价变异体 0 / 有效缺口 0**；`behavior.test.js` **15/15**；P3 全量 **645/645**。

---

## Task 6 父代理预审修正台账（2026-10-21）

> Task 6 是**可见性**的落地：唯一过滤入口（前端隐藏 = 数据已泄露）+ C-02 段位公示裁决。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**先跑后派**）——
> 这次规格**连模块都加载不了**（见 P3-20），修正后 9/9 全绿。
> 变异体 **31** 个 → **KILLED 31 / 等价 0 / 有效缺口 0**。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-20** | **Important** | **规格的 import 写的是 `pick` —— Task 2 已经把它改名成 `omit`** —— 按原样落地**整个模块加载失败** | 实跑：`SyntaxError: The requested module './util.js' does not provide an export named 'pick'` → `visibility.test.js` **一条用例都跑不起来**。这不是新问题，是 **Task 2 台账 P3-6 明确留下的承诺**：「改名 `omit` 并改正文档注释；Task 6 的 6 处调用点同步改名（**在 Task 6 落地时一并改**，本阶段只改定义侧）」。规格里 6 处调用点**本来就写的是 `omit`**，只有 import 行是旧的 —— 说明这两处**不是同一次编辑** | import 改成 `omit` → **兑现 Task 2 的 P3-6 承诺**。⚠️ 这条的价值不在「修一个 typo」，而在于它证明了**跨 Task 的改名承诺必须留痕**：Task 2 台账不写那句「Task 6 落地时一并改」，这个洞就会一直留到集成时才炸 |
| **P3-21** | Minor | **可见性的默认值是【fail-open】** —— `peerReview.showSource === false` 与 `rank.showEnterpriseName === false`：**配置里没写这两个字段时判定为「公示」**。而同一个函数里 `business.scoresPublic` / `signatoryPublic` 用的是 `!== true`（fail-closed）→ **同一个函数里两套口径** | 代码对照：`peerKeys` / `entKeys` 用 `=== false`，`drop.push('score'…)` / `drop.push('signatory'…)` 用 `!== true`。后果：配置里**漏写** `peerReview` 段 → 互评来源（`peerSource` / `fromTeamId` / `fromUserId` / `peerScore`）**直接发到浏览器**；漏写 `rank` 段 → 企业名 + 企业 id 全部公开 | 全部改成 `!== true`（**fail-closed**）：「不公示才安全」。⚠️ 出厂配置这两个字段本来都是 `false` → **生产行为完全不变**，只是把「漏配就泄露」的口子堵上。补「默认口径必须是【关】」用例（4 组漏配场景全钉住） |

### 二、变异检验

> 变异体 **31** 个（scope 取值 / 段位顺序来源 / 本人队伍的三种来源 / 空 rows 与 payload 其他字段 /
> **四个 fail-closed 判定** / 公示起点兜底 / 五个分支的路由 / 各分支内部的剔除清单 /
> 本人进度卡的四个字段 / isSelf 判定 / 两个字段清单 / 写回 rows …），
> 在 `/tmp` 副本上跑 `visibility.test.js`，**测试必须失败才算杀灭**。变异脚本：`/tmp/p3t6/mutate.mjs`。

首轮有 **1 条存活**（V21：本人进度卡保留名次）—— 根因是**夹具里 D 队行压根没有 `rank` 字段**，
省掉这个剔除项在数据上看不出差别。处置：给 D 队行**刻意补一个通用 `rank` 字段**，
把这条防御性剔除钉住（段位榜的排名字段是 `tierRank`，但 payload 未必不会带通用 `rank`）。

**Task 6 的测试条数口径**：visibility **9**（规格自带 5 + 变异检验补测 4）。

**最终结果**：变异体 31 → **KILLED 31 / 等价变异体 0 / 有效缺口 0**；`visibility.test.js` **9/9**；P3 全量 **654/654**。

---

## Task 7 父代理预审修正台账（2026-10-21）

> Task 7 是**榜单服务 + 战绩卡 + API** 的落地，也是 **Task 4 段位引擎的唯一生产调用方**（P3-15 兑现）。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**先跑后派**）——
> 规格自带的代码块在**发榜主路径**上有 4 处硬伤：其中 2 处让发榜必崩、1 处让**整个平台加载失败**、
> 1 处让排序结果不可复现。落地后又用**变异检验**挖出 2 个真缺陷（跨包污染 + 并列决胜口径缺失）。
> 变异体 **40** 个 → **KILLED 37 / 等价存活 3 / 有效缺口 0**。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-22** | **Critical** | **`awardMvp` 里的 `buildStageRanking` 调用与函数签名不匹配** —— 签名是 `buildStageRanking({ db, stage, R })`，规格却写成 `buildStageRanking({ db, stage, rules: R })` ⇒ 解构出的 `R` 是 `undefined` ⇒ 函数内 `R.behavior` 抛 `TypeError` | **本轮复核实证**：把规格原写法还原进 `src/services/leaderboard.js` 后，`leaderboard-service.test.js` 有 **6 条用例红**（7 / 9 / 10 / 14 / 16 / 17），error 全是 `Cannot read properties of undefined (reading 'behavior')` —— **发榜主路径整条崩**（不只是 MVP，连段位重算、幂等校验一起挂） | 改成 `buildStageRanking({ db, stage, R })`。⚠️ 这类是**签名漂移**：同一个对象形参在规格里前后写了两套键名，靠通读代码块不会发现，只有实跑才会炸 |
| **P3-23** | **Critical** | **`server.js` 的片段块重复 `import { AppError }`** —— 文件第 20 行已有 `import { appError, AppError } from './errors.js';`，片段块又 import 一次 ⇒ `SyntaxError: Identifier 'AppError' has already been declared` ⇒ **整个 server.js 加载失败 ⇒ 平台全挂**（不是单个接口挂，是全部路由挂） | 实跑：模块加载即 `SyntaxError`，`node --test` 里**所有走 server 的用例一起红** | 片段块里删掉那行 import，复用文件顶部已有的。⚠️ **片段块与整文件块混排时最容易出这种事故**：片段块的作者看不到文件顶部已经 import 过 |
| **P3-24** | **Critical** | **`awardMvp` 里用了 `rules.points`** —— 该函数形参名是 `R`（`awardMvp({ db, editionId, stageId, rules: R, createdAt })`）⇒ 函数体里 `rules` 未定义 ⇒ `ReferenceError` | 实跑：`ReferenceError: rules is not defined` | 统一改成 `R.points` |
| **P3-25** | **Critical** | **种子 SQL 与真实 schema 4 处不符** —— ① `task_packages` 写了 `created_at`，真实列是 `submitted_by` + `submitted_at`（**没有** `created_at`）；② `team_members` 缺 `id` 列（真实 schema 里 `id TEXT PRIMARY KEY` **NOT NULL**）；③ `stage_results.seat_e` 是 **NOT NULL**（P2 无企业席时写 0，不是 NULL）；④ `enterprise_confirmations` 的 `enterprise_id` / `cross_judge_id` 都是 `REFERENCES users(id)`，不能写 `e_1` 这种不存在的企业 id | 实跑：4 处**先后**报 `NOT NULL constraint failed` / `FOREIGN KEY constraint failed` —— 一次只暴露一处，必须逐条修 | 逐条对齐真实 schema（查 `sqlite_master` 的建表 SQL，不靠记忆）。⚠️ **种子里的一处错会掩盖后面所有错**，必须一条一条试出来 |
| **P3-26** | **Important** | **`getLatestTierRecord` 用随机 id 兜底排序** —— `ORDER BY computed_at DESC, id DESC`：id 是随机 UUID ⇒ 两条 `computed_at` 相同时，**哪条是最新取决于 UUID 的字典序**，与登记顺序无关 ⇒ 段位可能取到旧记录 | 实跑：两条 `computed_at` 完全相同、id 的字典序与登记顺序**故意相反**时，取到的是**先登记**那条 | 改用 SQLite 隐式 **`rowid`**（登记顺序，确定性）。⚠️ 与 Task 2「破同分兜底必须确定性」是同一条纪律：**任何排序兜底都不能用随机 id** |
| **P3-15 兑现** | **Important** | **Task 4 整套段位引擎零生产调用方** —— 引擎建好了，但没有一处调用它 ⇒ 队伍永远兜底 D 段 | 实跑：发榜前后 `tier_records` 一条没变 | `publishLeaderboard` 里对**本赛段有成绩的每支队**调 `computeTeamTier` 重算并落库；顺带把「段位公示」接上（`getTeamTier` 读最新记录）。⚠️ 段位口径（撤签降档、闲置降档、零提交口径）由 Task 4 台账的 Step 5b 写死，本 Task 只做**接线**，不改口径 |

### 二、变异检验挖出的两个真缺陷（本 Task 新写代码里的漏洞）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-27** | **Critical** | **MVP 的路演分没有按任务包过滤** —— `awardMvp` 把**全赛段**的路演结果原样喂给每个任务包的 `computeMvp` ⇒ 外包队伍带着「路演 10 分 + 赛段 0 分」进入本包候选 ⇒ 与本包真冠军「赛段 10 分」打平 10 : 10 ⇒ **旧的 team_id 兜底让外队 `t_b` 赢**（`'t_b' < 't_c'`）⇒ **外队挤掉本包真冠军，且它拿到的 MVP 积分是 0** | 探针（`/tmp/p3t7/debug-mvp.mjs`）：种子数据下 `awarded.mvp` = `[{t_a, tp_1, 10}, {t_b, tp_2, 0}]` —— **tp_2 的 MVP 是 tp_1 的队伍 `t_b`，积分 0** | 服务层按包过滤：`const pkgRoadshowScores = roadshowScores.filter((r) => pkgTeamIds.has(r.teamId));`。⚠️ 根因是**名次积分按任务包内排名发放**（设计文档 §6.3），而路演名次积分沿用了同一把尺子 —— **尺子必须和被量的对象同域**。补一条专门钉住跨包隔离的用例 |
| **P3-28** | **Important** | **MVP 综合分并列时没有任何决胜口径** —— 任务书 §七 只给了「4 赛段总积分 + S4 路演评审综合」的**加法**公式；综合分并列时实现直接落到 `cmpStr(teamId)` ⇒ **MVP 由队名字母序决定**。这与 S10 §0.3「互评的真正用途是**破同分**」、§4「行为分用于同分垫底排序」确立的通则（**同分必须用实质依据决出，不许用字母序**）直接冲突 | 探针：两队赛段名次积分 10 / 8、路演名次积分 10 / 8 ⇒ 综合分 **18 : 18 真并列** ⇒ 旧实现选 `t_a`（纯字母序）。⚠️ **这不是罕见边界**：一个任务包只有 2 支队时，赛段名次积分与路演名次积分**都是 10 / 8**，量级完全相同 ⇒ 综合分**必然并列** ⇒ 「按字母序决出 MVP」是**常态路径**而非边角 | ① 新增配置项 `rules/criteria.json.mvp.tiebreak`（默认 `["roadshow_points", "team_id"]`）：综合分并列 → **路演名次积分高者胜**（仍是评审实质依据）→ 仍并列 → `team_id` 码位序（确定性兜底，跨机器可复算）。② `computeMvp` 支持有序决胜链并在返回值里带出 `tiebreak`（可追溯）。③ `normalizeTiebreak` 强制以 `team_id` 收尾 + 剔除未知键；④ `config.js` 对该段 **fail-fast**（缺失 / 未知键 / 不以 `team_id` 收尾 ⇒ 拒绝启动）。⑤ **不写进 `rules/points.json`** —— 该文件的 `mvp` 段被 `INTERFACES.md §4` 逐字钉死（`assert.deepEqual(rules.points.mvp, {...})`），P3 自有口径一律进 `criteria.json` |

### 三、等价 / 不可观测变异体（**有探针差分实证**，不是凭推理放过）

> 变异脚本：`/tmp/p3t7/mutate.mjs`（40 个变异体，覆盖段位接线 / 发榜幂等 / 可见性调用 / 仓储排序 /
> MVP 按包过滤 / MVP 决胜链 / 配置 fail-fast）；探针：`/tmp/p3t7/probe.mjs`。

| # | 级别 | 变异体 | 差分实证 | 结论 |
|---|---|---|---|---|
| **W10** | — | 没有最后活动时间的队伍按「闲置 999 天」处理 | 探针跑 4 支队伍：无活动的 2 支都是 **0 里程碑 ⇒ D 段 ⇒ 降档已到地板**（`order[max(0, idx-1)]` 仍是 D）⇒ **差异 0 处** | **不可观测**：无活动 ⟹ 0 里程碑 ⟹ D 段地板 ⟹ 闲置降档无对象。降级逻辑本身有覆盖（`inactive_14days` 用例），只是这条分支**在数据上不可达** |
| **W26** | **Minor（真实发现）** | 榜单服务的 `viewerTeamIds` 传空 | 探针对 `rank` / `business` / `personal` / `rolling` **4 个可达 scope** 各跑一次「真实值 vs 空数组」，**差异 0 处** | **不可观测 —— 而且这是一条真实发现**：`applyVisibility` 里**唯一消费 `viewerTeamIds` 的是 `scope === 'tier'` 分支**，而榜单服务只传 rank/business/personal/rolling 四个 scope ⇒ **这根接线在榜单服务里是死的**。段位榜走的是 `services/tier.js` 自己的 `repo.isTeamMember` 判定（C-02 已实现、且有专门用例），**不走 `applyVisibility`**。⚠️ 与 P2 终审 I-2（`checkJudgePool` 零调用方）、Task 4 P3-15（段位引擎零调用方）同款病根：**能力建好了没接线**。**已知限制**：段位榜的「D 段只给本人进度卡」目前由 `services/tier.js` 单点保证，不在可见性模块内 —— Task 8 的段位榜前端要沿用这条链路，**不要另起一套过滤** |
| **W40** | — | `awardMvp` 的「获奖队必须属于本任务包」防御闸门被摘掉 | 探针跑 30 组 `computeMvp` 输入，**获奖队落在输入队伍集合外的 0 组** | **不可观测**：候选集 = 赛段积分队 ∪ 路演队 ⊆ 输入队 ⇒ 闸门**不可达**（纯防御）。保留（不依赖它正确，但依赖它**出错时兜住**） |

### 四、变异检验发现的其他盲区（已补测）

| # | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|
| — | **「MVP 的路演分要折算成路演名次积分再计入」这条用例原本身是坏的**：它假设「t_a / t_b 赛段积分同分」⇒ 但**名次积分按任务包内排名发放**（并列第一占第 1、2 席 ⇒ 10 与 8）⇒ **同包两队的赛段积分恒为 10 / 8，永远不同分** ⇒ 该用例的前提在结构上不成立 | 原用例实跑红；把它拆成**判别性数据集**后才测得出东西 | 重写为 3 条：① **判别性**（`tp_1` 扩到 3 队、路演名次与赛段名次**完全相反** ⇒ 折算 → `t_b` 胜；不折算 → `t_e` 胜；不计路演 → `t_a` 胜 ⇒ **三种错实现给出三个不同赢家**）；② **跨包隔离**（P3-27）；③ **并列决胜**（P3-28） |
| — | **MVP 的决胜口径无法被观测** —— `publishLeaderboard` 硬编码 `getDefaultRules()` ⇒ 无法注入一份不同的决胜链来验证「配置说了算」 | 变异 W30（决胜口径不注入）**存活** | `publishLeaderboard` 增加 `rules` 注入口（默认仍走 `getDefaultRules()`）⇒ 补一条用例：注入 `tiebreak: ['team_id']` ⇒ 并列时改选 `t_a`。**变异 W30 随即被 KILLED** |
| — | **`rules/criteria.json` 的出厂决胜链无人看守** | 变异 W38 / W39（出厂顺序颠倒 / 缺 team_id 收尾）虽被现有用例抓住，但抓它的是**别的**断言 | 补 `config.js` 的 fail-fast 校验 + `leaderboard-migration.test.js` 的专门用例（缺失 / 未知键 / 不以 `team_id` 收尾 三种非法配置） |

**Task 7 的测试条数口径**：leaderboard-service **19**（规格自带 8 + 变异检验补测 7 + 规格缺陷补测 4）；
points **27**（Task 3 的 24 + Task 7 补测 3）；leaderboard-migration **16**（Task 1 的 14 + Task 7 补测 2）。

**最终结果**：变异体 40 → **KILLED 37 / 等价变异体 3 / 有效缺口 0**；
`leaderboard-service.test.js` **19/19**、`points.test.js` **27/27**、`leaderboard-migration.test.js` **16/16**；P3 全量 **677/677**。

---

## Task 8 父代理预审修正台账（2026-10-21）

> Task 8 是**前端三页**（榜单 / 段位榜 / 战绩卡）的落地，也是 P3 阶段的**回归验收**。
> 实施前把规格的代码块抽到 `/tmp` 的独立工程实跑（**先跑后派**）——
> 规格自带的**前端视图能跑，但段位榜页必然 404**：规格写的是 `ctx.api.get('/api/leaderboard/tier')`，
> 而 Task 7 只建了 4 个接口，**没有段位榜这个列表接口**。
> 变异体 **26** 个 → **KILLED 26 / 等价 0 / 有效缺口 0**。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-29** | **Critical** | **规格引用了一个【不存在的接口】** —— `web/views/tier.js` 写 `ctx.api.get('/api/leaderboard/tier')`，但 Task 7 只建了 4 个 API（`/api/leaderboard/:stageId`、`/api/leaderboard/rolling`、`/api/teams/:id/performance-card`、`/api/teams/:id/tier`）—— **没有段位榜列表接口**。按规格原样落地 ⇒ `/api/leaderboard/tier` 被 `/api/leaderboard/:stageId` 当成赛段 id 吃掉 → `404 STAGE_NOT_FOUND` ⇒ **段位榜页永远打不开** | 实跑：按规格落地后 `GET /api/leaderboard/tier` → **404**（`'tier'` 被当成 stageId）。与 Task 1 偏差表 3c 的「指向不存在实现的活引用」同款病根 —— **规格里的接口调用必须逐个对回 Task 7 的路由表** | 补三处：① 服务层 `getTierBoard({ db, editionId, viewer, rules })`（`src/services/tier.js`）；② 路由 `GET /api/leaderboard/tier`（静态段胜参数段 ⇒ 不会被 `:stageId` 劫持）；③ 届期缺省解析 `resolveEditionId`。**这一步同时补上了 Task 7 台账 W26 的发现** —— `applyVisibility` 的 `scope==='tier'` 分支此前**零生产调用方**，现在它是段位榜的唯一过滤入口 |
| **P3-30** | **Important** | **三个视图各自重写一份 `escapeHtml`** —— 规格把 `escapeHtml` 的实现复制进 `leaderboard.js` / `tier.js` / `card.js` 三处，而 P0 早就建立了全站唯一的 `web/escape.js`（终审 I-2 就是为了收口转义） | 代码对照：`web/escape.js`（P0）vs 规格三份拷贝 —— 内容相同但**会漂移**：将来改一处漏两处就是两处 XSS | 三份拷贝全删，改成 `import { escapeHtml } from '../escape.js';`。补一条用例用**源码扫描**钉住「视图不得重复定义 escapeHtml」 |
| **P3-31** | **Important** | **演示适配器的分支顺序有坑** —— 规格的 `api.demo.js` 只加了 `'/api/leaderboard/rolling'` 与 `'/api/leaderboard/'` 两个分支 ⇒ `GET /api/leaderboard/tier` 会落进**赛段榜**分支，返回 `{scope:'rank', rows: db.leaderboard}` ⇒ 段位榜渲染成空榜 | 实跑：按规格落地后演示版的段位榜拿到的是赛段榜数据 | 补 `'/api/leaderboard/tier'` 分支，**且必须排在 `'/api/leaderboard/'` 之前**（前缀匹配，顺序即语义）。补一条用例直接调演示适配器断言三个接口各自的 `scope` |
| **P3-32** | Minor | **届期必填 ⇒ 前端得先查一遍届期** —— 规格的 `/api/leaderboard/rolling` 缺 `editionId` 就 400，而前端 store 里**根本没有 `editionId`**（`getState().editionId` 恒 `undefined`）⇒ 滚动总榜页永远 400 | 实跑：规格的 `renderLeaderboard` 取 `ctx.getState().editionId` —— store 只有 `user` 等字段 | ① 服务端加 `resolveEditionId`：显式传了但不存在 → **404**；没传 → **取当届**（`pickCurrentEdition`，与 `/api/registration-criteria` 同一口径）；② 滚动总榜与段位榜**都**改成缺省取当届；③ 前端不再需要知道届期。⚠️ **「当届」与真实日期有关** ⇒ 测试里把种子届期的 `ends_at` 推到 2099，否则那条用例会随日历过期而红 |
| **P3-33** | Minor | **server.js 里的路由注释是过时的** —— 注释写「路由顺序由 P0 的 router 按『参数段数量降序』排序」，但 P0 的 router 早就在终审 C4-1 改成**逐段比较（静态段胜参数段）** | 代码对照：`src/http/router.js` 的注释与实现都是「逐段比较」 | 注释改成实际口径（并说明 `rolling` / `tier` 两个静态段为什么不会被 `:stageId` 劫持）。⚠️ **注释写错比不写更坏**：下一个人会照着错注释去推理路由优先级 |

### 二、变异检验

> 变异体 **26** 个（段位榜的段位来源 / 兜底口径 / 排序两级口径 / 可见性 scope / 本人队伍识别 /
> 进度卡内容 / 名次赋值 / 段位榜路由 / 届期解析两项 / 三个视图的转义与置顶与空态与已签标识 /
> app.js 的路由注册与参数透传 / 演示适配器的分支顺序与 scope 解析），
> 在 `/tmp` 副本上跑 `leaderboard-web.test.js` + `leaderboard-service.test.js`，**测试必须失败才算杀灭**。
> 变异脚本：`/tmp/p3t8/mutate.mjs`。

**首轮 8 条存活 + 2 条构造失败**，三条根因：

| 现象 | 根因 | 处置 |
|---|---|---|
| Y18/Y20/Y23/Y24/Y25/Y26 存活 | **变异脚本指向的是仓库里【没同步】的测试文件** —— 判别性断言只加在 `/tmp` 沙箱里，仓库的测试还是旧版 ⇒ 「存活」是假象 | 先把测试同步进仓库再复跑（Task 5 首轮踩过同款坑：*变异脚本必须指向已落地的测试文件*） |
| Y04/Y05 存活 | **判别性数据造得不够狠** —— 「同段位比里程碑数」和「team_id 码位序兜底」两条口径，在「DB 入库顺序 == 正确顺序」时**结果一致** | 让三支 A 段队伍的 `created_at` **早于**种子队伍：`t_a`（3 个里程碑）、`t_x`（3 个，码位序在 `t_a` 之后）、`t_0a`（1 个）。正确序 = `t_a → t_x → t_0a`；去掉「比里程碑数」⇒ `t_x → t_a → t_0a`；去掉「码位序兜底」⇒ 同样变成 `t_x → t_a → t_0a`。**探针实证**（`/tmp/p3t8cmp-*`）：原始实现 `[t_a, t_x, t_0a]`，变异实现 `[t_x, t_a, t_0a]` —— 两条口径各被一条断言钉住 |
| Y03/Y08 构造失败 | 锚点命中 2 次（`getTierBoard` 与旧的 `tierBoardRank` 里有**同文**的排序行） | 锚点加长到带下一行上下文（`if (a.milestoneCount !== ...)`），把两处区分开 |
| Y08 存活（补测后） | 「进度卡不带里程碑清单」改成空数组后**形状没变**（还是数组），断言只查了类型 | 断言改成查**内容**：给 `t_d` 加一条未签字的里程碑（仍是 D 段，但清单里要有它）⇒ `milestones.length === 1` |

**Task 8 的测试条数口径**：leaderboard-web **9**（规格自带 6 + 转义复用补测 1 + 透传/演示适配器补测 2）；
leaderboard-service **23**（Task 7 的 19 + Task 8 补测 4）。

**最终结果**：变异体 26 → **KILLED 26 / 等价变异体 0 / 有效缺口 0**；
`leaderboard-web.test.js` **9/9**、`leaderboard-service.test.js` **24/24**；P3 全量 **691/691**；
`node scripts/migrate.js` 输出 `迁移完成，当前版本 4`。

| **P3-34** | Minor | **验收标准 P3-12 的后半句「`leaderboard_snapshots.payload_json` 能重放出同样的名次」没有任何用例** —— 原用例只断言了「快照写了 3 条 + 幂等」，**没断言快照里的名次与重算一致**。而「可复算」恰恰是段位/积分这类数值结果**跨机器复算同结果**的保证（S-5 / R-RNK-10 的可追溯性） | 自查脚本按「P3 验收标准」逐条跑时发现：P3-12 的前两句（幂等、快照条数）有用例，第三句（能重放）**无覆盖** | 补一条用例：发榜后读 `scope='rank'` 的 `payload_json`，把快照里的 `[teamId, rank, points]` 与**重新算一遍**的 `getLeaderboard` 结果逐项比对 ⇒ 快照必须能重放出同样的名次 |

### 三、已知限制（明确不在本阶段解决）

| # | 限制 | 说明 |
|---|---|---|
| 1 | **赛段名册仍是届期级** | `stage_team` 表在 P3 建好了（Task 1 兑现 D-33），但**没有写入流程** —— 名册的登记时机（赛段开启时把该届参赛队登记进来）属 **P5 的工作流**。当前赛段榜按「该赛段有成绩的队」判定，外队理论上仍可能进榜 |
| 2 | **段位榜不公示 D 段队伍的队名与名次** | 冲突裁决 C-02 的直接落地；D 段只有本人能看到进度卡。**段位公示的「谁在 D 段」信息不外泄** |
| 3 | **滚动总榜与段位榜的届期缺省取「当届」** | 想看历史届期要显式传 `?editionId=`；显式传了不存在的届期 → 404 |

---

## 终审修复轮（2026-10-21 · 独立 verifier 终审的修复）

> 独立 verifier 对 P3 整分支的终审结论是 **NOT PASS**：**Critical × 1 / Important × 4 / Minor × 4**。
> 本节是这 9 条发现的落盘处 —— **每一条「怎么发现的、为什么这么改、改完怎么验的」**。
>
> ⚠️ 修复轮遵守的三条纪律：
> ① **先跑后派** —— 每处规格改动先在 `/tmp/p3fix/scratch-platform` 的独立工程里实跑通过，再回写仓库与计划；
> ② **计划是规格** —— 本节新增的代码块与最终实现**逐字一致**（用 `/tmp/verify-blocks.mjs` 核验）；
> ③ **差分检验** —— 每处修复都做「改回旧写法 ⇒ 对应用例必须变红」的差分实证；
>    存活变异体要么修、要么**显式标注为不可观测并给探针差分实证**（不凭推理放过）。

### 一、终审发现的 9 条与处置

| # | 级别 | 终审发现 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P3-35** | **Critical** | **个人积分榜恒为空** —— 仓储 `listLedgerByEdition` 返回 `SELECT *` 的 **snake_case** 行（`user_id`），域函数 `computePersonalPoints` 读的是 **camelCase** 的 `entry.userId` ⇒ `if (!entry.userId) continue;` 把**每一条流水**都当成「没有归属人」**静默丢弃** ⇒ 个人积分榜永远 `rows: []`，**且不报任何错** | 探针：流水 3 行真实存在，`scope=personal` 的 `rows` = 0；把仓储改成 `user_id AS userId` 后 `rows` = 2。**R-RNK-10「个人积分终生上榜」整条线生产上不可观测** | **服务层加 `toLedgerEntry` 映射**（仓储仍统一返回原始行，与 leaderboard / teams / tiers 仓储同风格）→ `buildPersonalPayload` 过映射再喂域函数；**补端到端用例**：发榜 → `GET /api/leaderboard/st_1?scope=personal` → 断言行数 = 流水条数、姓名 / 名次 / byKind 齐全 |
| **P3-36** | **Important** | **MVP 在每个赛段发榜时重复发放** —— `awardMvp` 算的是**整届**的 MVP（遍历全部赛段），幂等键却按**当前发榜的 stageId** 查 ⇒ 每发一个赛段就再写一条同额流水（发 st_1 写一条、发 st_2 又一条，金额还一样），个人积分被重复累加 | 探针：3 个赛段，发 st_1 与 st_2 各写一条 `kind=mvp points=20`；把幂等键改届期级后第二次发榜 `awarded.mvp = []` | **发放时机 + 幂等键两条一起改**（见下方「MVP 口径」小节） |
| **P3-37** | **Important** | **滚动总榜静默丢弃全部降级告警** —— `getRollingLeaderboard` 内部调 `buildStageRanking`（该函数返回 `warnings`），却把告警全丢了（`warnings: []`）⇒ 而 `#/leaderboard`（不带 stageId）**默认就走滚动总榜** ⇒ 用户看到一份「干净」的榜单，底层计算其实已降级。违反 P3-9「降级告警置顶」与 R-AUD-05「静默的空产出比报错更危险」 | 探针：单赛段榜 `warnings` 有 `judge_sample_too_small`，滚动总榜 `warnings` = `[]` | 滚动总榜**汇总每一届赛段的告警**，并标注来源赛段（`stageId` / `stageKey` / `stageName`）；前端 `warningsHtml` 在有 `stageName` 时渲染赛段名（读者才知道该查哪一段）；**补用例**：某赛段有快照告警 → 滚动榜 `warnings` 非空且带 `stageId` |
| **P3-38** | **Important** | **行为分通路在生产里没有任何写入口** —— `insertBehaviorEvent` 全仓零生产调用方 ⇒ `behavior_events` 表只能读不能写 ⇒ 行为分总分恒为 0 ⇒ **破同分链第 5 级 `'behavior'` 永不参与排序**，R-PTS-07/08/09 在生产链路上不可观测 | `grep -rn "insertBehaviorEvent" src/ scripts/ web/` 只有仓储定义本身 | **补写入口**：`services/behavior.js` + `http/routes/behavior.js` + `POST /api/teams/:id/behavior-events`；分值**一律取规则值**（防篡改），证据不合规直接 400 拒收（见下方「三条写入通路」小节） |
| **P3-39** | **Important** | **里程碑 / 企业签字无写入口** —— 全仓无 `INSERT INTO milestones` / `INSERT INTO milestone_signoffs` ⇒ `computeTeamTier` 的输入表恒空 ⇒ `milestoneCount=0` ⇒ 永远落 D 段 ⇒ R-PTS-01/02/03/05 生产不可观测；B 榜与战绩卡的里程碑清单恒空（R-PTS-11 不可观测）。`scripts/seed.js` 注册了 `signoff:create` 能力点却**没有任何端点消费它** | `grep -rn "INSERT INTO milestones\|INSERT INTO milestone_signoffs" src/ scripts/` 零命中；`grep -n "milestones\|behavior_events" scripts/seed.js` 零命中 | **补写入口**：`services/milestone.js`（签字 / 撤回）+ `http/routes/milestone.js`（2 个路由）+ 建队时落里程碑清单（`services/team.js` 调 `insertMilestones`） |
| **P3-40** | Minor | **积分流水的排序兜底键用了随机 UUID** —— `ORDER BY created_at ASC, id ASC`（`id` 是 `randomUUID()`），且 `publishLeaderboard` 给同一次发榜的所有流水写**同一个 `createdAt`** ⇒ 兜底键**每次都真的会被用到** ⇒ 流水顺序逐次运行不同。与同分支 P3-26 在 `tiers.js` 修掉的是同款模式 | 探针：12 条同 `created_at` 的流水，两种兜底给出的顺序**确实不同** | 改成 `ORDER BY created_at ASC, rowid ASC`（SQLite 隐式 `rowid`，与 `tiers.js` 同款） |
| **P3-41** | Minor | **`stage-teams.js` 的注释声称「确定性」，实现却是随机 UUID** —— 注释写「按登记时间、再按 id 排序 → 确定性」，而 `id` 是 `randomUUID()` ⇒ 同批登记的队伍顺序取决于随机 UUID 字典序 | `stage-teams.js:18` `import { randomUUID }` + `:33` `stmt.run(randomUUID(), ...)` + `:42` `ORDER BY registered_at ASC, id ASC` | 兜底键改 `rowid`，注释同步改成「再按登记顺序（rowid）排序 → 确定性」 |
| **P3-42** | Minor | **`getTeamTier` 解析 `reasons_json` 无保护** —— 该列一旦不是合法 JSON，接口直接 500（`SyntaxError`），而同文件 `collectWarnings` 对快照 JSON 的解析**有** try/catch ⇒ 口径不一致 | 探针：`UPDATE tier_records SET reasons_json = '{not json'` → `status = 500`、`{"error":{"code":"INTERNAL"}}` | 加 try/catch：解析失败降级为 `[]` 并**显式带一条告警**（`REASONS_PARSE_FAILED`），不静默 |
| **P3-43** | Minor | **计划文档内部口径不一致** —— Task 8 的 Step 7 验收命令仍写 `690/690`，而 Task 8 台账已改成 `691/691` ⇒ 同一份规格里两个总数 | `grep -n "690" <plan>` 仅 1 处残留；实跑 `node --test` → `# tests 691` | 统一成 `691/691`（终审修复轮落地后为 **709/709**） |

### 二、「MVP 口径」：为什么发放时机与幂等键要一起改

MVP 是**届期级**的最终奖项，而发榜是**赛段级**动作 —— 让赛段级动作产生届期级奖项是**层级错配**。
原实现两处错叠在一起：

| 维度 | 原实现 | 问题 | 修正后 |
|---|---|---|---|
| **发放时机** | 每次发榜都算一遍 MVP | 在路演赛段**之前**发榜时，路演评审综合分（公式的最后一个输入，任务书 §七）还不存在 ⇒ MVP 金额偏小；积分只增不改 ⇒ 后面补不回来 | **只在路演赛段发榜时发放**；本届没有路演赛段、或路演尚无评分结果 ⇒ **不发 MVP**（公式缺最后一个输入，不做半个公式的奖） |
| **幂等键** | `(当前发榜的 stageId, teamId, 'mvp')` | 幂等只在**同一赛段内**成立 ⇒ 每发一个赛段就再写一条同额流水 | **`(届期, teamId)`** —— 同一支队的 MVP 整届只发一次 |

> ⛔ 为什么不是「只把幂等键改届期级」就收工：那样第一次发榜（很可能是 S1）就会把**缺了路演分**的 MVP 金额定死，
> 而积分只增不改 ⇒ 后面再发榜也不会被纠正。**两条必须一起改**，否则只是把「重复发」换成「发早了」。

**连带的口径变化**：Task 7 的 4 条 MVP 用例原本发榜 `st_1`，修正后改发 `st_r`（路演赛段）。
用例的**断言内容一字未改** —— 变的只是「在哪个赛段发榜」，这正是要钉住的那条口径。

### 三、「三条写入通路」：P3 自己欠自己的写入口

P3 计划偏差表 3c 明写「服务层接线在 Task 7（P3 自己的写入口：**行为分事件** / 里程碑签字 / MVP 投票）」，
但**三个写入口一个都没接线**，且 §已知限制 只登记了 `stage_team` 名册那一条 —— 读台账的人会以为行为分通路已生产可用。
终审修复轮把三条补齐（**MVP 投票**不补：它属 P2 的 `tiebreak_votes`，P3 只在破同分链里读）：

| 通路 | 服务层 | HTTP 层 | 能力点 | 为什么必须有 |
|---|---|---|---|---|
| **行为分事件** | `services/behavior.js` → `submitBehaviorEvent` | `POST /api/teams/:id/behavior-events` | `behavior:write`（captain / member） | 不补则破同分链第 5 级永不生效（P3-38） |
| **企业里程碑签字** | `services/milestone.js` → `createSignoff` / `withdrawSignoff` | `POST /api/milestones/:id/signoff`（body：`{ department, content }`）/ `POST /api/milestones/:id/signoff/withdraw`（body：`{ signoffId }`） | `signoff:create`（enterprise / enterprise_admin，**能力点 P0 就已注册**，只是没有端点消费） | 不补则段位恒为兜底 D 档、B 榜与战绩卡里程碑清单恒空（P3-39） |
| **建队时落里程碑清单** | `services/team.js` → `createTeam` 追加 `insertMilestones` | （随建队） | — | P1 已把清单写进 `teams.milestones_json`，但 P3 的段位引擎与 B 榜读的是 `milestones` **表** —— 缺了它，段位输入表恒空 |

**分值与证据的口径**（防篡改，反作弊 R-PTS-10）：
行为分事件的**分值一律取 `rules/behavior-points.json`**，提交方自报的 `points` 直接忽略；
证据不合规（纯文字 / 缺必填字段 / 不是对象）→ **400 拒收**，不给分、不落库。

### 四、新增文件（整文件块，与实现逐字一致）

`platform/src/db/repo/tiers.js` 的里程碑与签字仓储函数（`insertMilestones` / `getMilestone` /
`insertSignoff` / `getSignoff` / `revokeSignoff`）见上方 Task 7 的 `src/db/repo/tiers.js` 整文件块。

`platform/src/services/milestone.js`：

```javascript
// src/services/milestone.js — 企业里程碑签字（★ 只确认客观事实，不进总分）
// 依据：S10 §4 商业里程碑 7 类 + R-ENT-02「企业签字里程碑」
//   + R-JDG-14（签字必须写清解决哪个环节 / 落地时间 / 我方角色）
//   + R-PTS-03（S 段只认业务部门签字）+ 规则表 rules/milestones.default.json 的 signoffRequires。
//
// ⛔ 本模块与 P2 的 enterprise_confirmations 是**两张不同的表**：
//    这里签的是「这件事到底发生了没有」（客观事实，单签，不进总分）；
//    那里记的是「企业觉得这个做得好不好」（主观评分，双签，进总分）。
// ⛔ 签字**只增不改**；撤回走 revoked_at 软删除（不物理删除）。
// ⛔ 权限模型 = capability + assignment，can() 是唯一判定入口。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getTeam } from '../db/repo/leaderboard.js';
import * as tierRepo from '../db/repo/tiers.js';

/**
 * 企业签字：确认某支队伍的某个里程碑「确实发生了」。
 * @param body { department, content } —— 部门与内容都必填（rules/milestones.default.json.signoffRequires）
 */
export function createSignoff({ db, milestoneId, actorId, body, now = new Date().toISOString(), rules }) {
  const actor = getUserById(db, actorId);
  if (!actor) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
  const milestone = tierRepo.getMilestone(db, milestoneId);
  if (!milestone) throw new AppError(404, 'MILESTONE_NOT_FOUND', '里程碑不存在');
  const team = getTeam(db, milestone.team_id);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  // 能力点闸门：只有企业席 / 企业管理员能签（seed 里 signoff:create 授予这两个角色）
  if (!can(actor, 'signoff:create', { scopeType: 'edition', scopeId: team.edition_id }, db)) {
    throw new AppError(403, 'FORBIDDEN', '你没有企业签字的权限');
  }
  const req = rules.milestones?.signoffRequires ?? {};
  const department = String(body?.department ?? '').trim();
  const content = String(body?.content ?? '').trim();
  if (req.department !== false && !department) {
    throw new AppError(400, 'MISSING_DEPARTMENT', '必须填写签字部门');
  }
  if (req.content !== false && !content) {
    throw new AppError(400, 'MISSING_CONTENT', '必须写清签字内容（解决哪个环节 / 落地时间 / 我方角色）');
  }
  const id = randomUUID();
  // enterprise_id = 签字的企业席账号（P2 的 enterprise_confirmations 同样用 users.id 当企业 id）
  tierRepo.insertSignoff(db, {
    id, milestoneId, enterpriseId: actor.id, signatoryUserId: actor.id, department, content, signedAt: now,
  });
  return { id, milestoneId, teamId: team.id, department, content, signedAt: now, revokedAt: null };
}

/**
 * 撤回签字：软删除（置 revoked_at）—— 撤回后该里程碑回到「未达成」，段位由**重算**体现降档。
 * ⛔ 只能撤回**自己**（本企业席）的签字；组委会可代撤（留审计）。
 */
export function withdrawSignoff({ db, milestoneId, signoffId, actorId, now = new Date().toISOString(), rules }) {
  const actor = getUserById(db, actorId);
  if (!actor) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
  const milestone = tierRepo.getMilestone(db, milestoneId);
  if (!milestone) throw new AppError(404, 'MILESTONE_NOT_FOUND', '里程碑不存在');
  const team = getTeam(db, milestone.team_id);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  if (!can(actor, 'signoff:create', { scopeType: 'edition', scopeId: team.edition_id }, db)) {
    throw new AppError(403, 'FORBIDDEN', '你没有撤回企业签字的权限');
  }
  const signoff = tierRepo.getSignoff(db, signoffId);
  if (!signoff || signoff.milestone_id !== milestoneId) {
    throw new AppError(404, 'SIGNOFF_NOT_FOUND', '签字不存在');
  }
  if (signoff.revoked_at) {
    throw new AppError(409, 'ALREADY_REVOKED', '该签字已被撤回');
  }
  // ⛔ 非超管只能撤回自己签的（不能替别的企业撤）
  if (actor.is_superadmin !== 1 && signoff.enterprise_id !== actor.id) {
    throw new AppError(403, 'NOT_YOUR_SIGNOFF', '只能撤回本企业自己的签字');
  }
  const changed = tierRepo.revokeSignoff(db, { id: signoffId, revokedAt: now });
  if (!changed) throw new AppError(409, 'ALREADY_REVOKED', '该签字已被撤回');
  return { id: signoffId, milestoneId, revokedAt: now };
}
```

`platform/src/services/behavior.js`：

```javascript
// src/services/behavior.js — 行为分事件的写入入口（★ 独立通路，与总分隔离）
// 依据：S10 §3.1 计分明细 + §3.2 达标线 + R-STG-04（提交须为可运行状态或明确阻塞点，
//   纯文字进度说明不给分）+ R-PTS-10 反作弊 5 条（分值不由提交方给定）。
//
// ⛔ 分值【不】由提交方给定：一律取 rules/behavior-points.json 里该类型的分值（防篡改）。
//    域函数 behaviorScore 在**读取**时也会重算一遍 —— 存进去的 points 只是留痕，不是权威。
// ⛔ 证据不合规 → 直接拒收（400），**不给分、不落库**（S10「纯文字进度说明不给分」）。
//    证据口径由域函数统一裁决（rules.criteria.behaviorEvidence 覆盖默认要求），
//    服务层**不重复实现**一套证据规则 —— 两套规则必然漂移。
// ⛔ 权限模型 = capability + assignment，can() 是唯一判定入口（behavior:write）。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getTeam } from '../db/repo/leaderboard.js';
import { insertBehaviorEvent, listBehaviorEventsByTeams } from '../db/repo/points.js';
import { behaviorScore } from '../domain/behavior.js';

/**
 * 提交一条行为分事件。
 * @param body { type, evidence } —— type 取 rules.behavior.events 的 key；evidence 为对象或 JSON 串
 */
export function submitBehaviorEvent({ db, teamId, actorId, body, now = new Date().toISOString(), rules }) {
  const actor = getUserById(db, actorId);
  if (!actor) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
  const team = getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  if (!can(actor, 'behavior:write', { scopeType: 'edition', scopeId: team.edition_id }, db)) {
    throw new AppError(403, 'FORBIDDEN', '你没有提交行为分记录的权限');
  }
  const type = String(body?.type ?? '').trim();
  const def = (rules.behavior?.events ?? []).find((d) => d.key === type);
  if (!def) throw new AppError(400, 'UNKNOWN_EVENT_TYPE', `未知的行为事件类型：${type}`);

  // 证据校验：借用域函数同一套口径（不另写一份）
  const behaviorConfig = {
    ...(rules.behavior || {}),
    evidenceRequirements: rules.criteria?.behaviorEvidence || undefined,
  };
  // ⚠️ **次数约束必须连同历史一起算**（F38）：只看候选事件当然「没超限」，
  //    而真实的刷分手法正是「同一条事件反复提交」⇒ 必须把**本队已有事件**一起喂进去。
  const prior = listBehaviorEventsByTeams(db, [teamId]).map((e) => ({
    id: e.id, type: e.type, evidence: e.evidence, created_at: e.created_at,
  }));
  const probe = behaviorScore({
    events: [...prior, { id: 'probe', type, evidence: body?.evidence, created_at: now }],
    behaviorConfig,
  });
  const item = probe.items.find((i) => i.id === 'probe');
  if (!item || !item.counted) {
    // ⛔ **次数/频次超限**与**证据不合规**是两回事，必须分开报：
    //    证据不合规 = 400（重写证据再来）；次数超限 = 409（这个周期已经计过分了）。
    if (item?.reason === 'once_limit' || item?.reason === 'cadence_limit') {
      throw new AppError(
        409, 'BEHAVIOR_CADENCE_LIMIT',
        `该行为事件在本计分周期内已提交过（${def.label}），不能重复计分`,
        { type, reason: item.reason, once: Boolean(def.once), cadence: def.cadence ?? null },
      );
    }
    throw new AppError(400, 'EVIDENCE_REJECTED', `证据不合规，不予计分：${item?.reason ?? 'unknown'}`);
  }

  const id = randomUUID();
  const evidence = typeof body?.evidence === 'string' ? body.evidence : JSON.stringify(body?.evidence ?? {});
  insertBehaviorEvent(db, {
    id, teamId, userId: actor.id, type, points: Number(item.points) || 0, evidence, createdAt: now,
  });
  return { id, teamId, userId: actor.id, type, points: item.points, counted: true, createdAt: now };
}
```

`platform/src/http/routes/milestone.js`：

```javascript
// src/http/routes/milestone.js — 企业里程碑签字 API
// 依据：INTERFACES.md §3 的 API 约定 + 设计文档 §8（HTTP 层只做解析与鉴权，业务在 service）
//   权限：capability + assignment（唯一入口 can()）—— signoff:create（企业席 / 企业管理员）。
import { AppError } from '../../errors.js';
import { createSignoff, withdrawSignoff } from '../../services/milestone.js';

export function registerMilestoneRoutes(router) {
  router.add('POST', '/api/milestones/:id/signoff', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return createSignoff({
      db: ctx.db,
      milestoneId: ctx.params.id,
      actorId: ctx.user.id,
      body: ctx.body,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  router.add('POST', '/api/milestones/:id/signoff/withdraw', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return withdrawSignoff({
      db: ctx.db,
      milestoneId: ctx.params.id,
      signoffId: ctx.body?.signoffId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });
}
```

`platform/src/http/routes/behavior.js`：

```javascript
// src/http/routes/behavior.js — 行为分事件提交 API
// 依据：INTERFACES.md §3 的 API 约定 + R-PTS-10 反作弊 5 条
//   权限：capability + assignment（唯一入口 can()）—— behavior:write（队长 / 组员）。
import { AppError } from '../../errors.js';
import { submitBehaviorEvent } from '../../services/behavior.js';

export function registerBehaviorRoutes(router) {
  router.add('POST', '/api/teams/:id/behavior-events', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return submitBehaviorEvent({
      db: ctx.db,
      teamId: ctx.params.id,
      actorId: ctx.user.id,
      body: ctx.body,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });
}
```

`platform/test/milestone-service.test.js`：

```javascript
// platform/test/milestone-service.test.js —— 企业里程碑签字的写入通路
//
// 规则溯源：
//   - 「里程碑清单在报名（组队）时固定，之后不可自行新增」→ R-STG-03 / R-PTS-10
//   - 「企业签字里程碑」→ R-ENT-02（S10 §4 商业里程碑 7 类）
//   - 「签字须写清解决哪个环节 / 落地时间 / 我方角色」→ R-JDG-14
//   - 「S 段只认企业业务部门签字」→ R-PTS-03
//   - 权限模型 = capability + assignment，can() 是唯一判定入口
//
// ⛔ 本表与 P2 的 enterprise_confirmations 是两张不同的表：
//    这里签的是「这件事到底发生了没有」（客观事实，不进总分）。
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
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
import { computeTeamTier } from '../src/services/tier.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const GOOD = {
  direction: [4, 4, 4, 4, 5], capability: [4, 4, 4, 4, 5], collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题', consent: { accepted: true },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-ms-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2099-12-31',
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900007001', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const captain = createUser(db, { name: '队长甲', phone: '13900007002', password: 'pw', mbaStatus: 'mba' });
  const seat = createUser(db, { name: '企业席乙', phone: '13900007003', password: 'pw', mbaStatus: 'other' });
  const seat2 = createUser(db, { name: '企业席丙', phone: '13900007004', password: 'pw', mbaStatus: 'other' });
  const admin = createUser(db, { name: '组委会', phone: '13900007005', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  insertRegistration(db, {
    editionId: edition.id, userId: captain.id, answers: GOOD, rawScore: 80,
    level: 'S', status: 'submitted', now: NOW,
  });

  insertCapability(db, 'team:create', '创建战队');
  insertCapability(db, 'signoff:create', '企业里程碑签字');
  grantAssignment(db, {
    userId: captain.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: seat.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: seat2.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, edition, pkg, captain, seat, seat2, admin,
    tokenCaptain: createSession(db, captain.id).token,
    tokenSeat: createSession(db, seat.id).token,
    tokenSeat2: createSession(db, seat2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
  };
}

async function createTeam(s) {
  const res = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name: '甲队' },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

test('★ R-STG-03：建队时里程碑清单落表（7 类，固定不可自行新增）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const rows = s.db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY key ASC').all(team.id);
    const expected = s.rules.milestones.items.map((i) => i.key).sort();
    assert.deepEqual(rows.map((r) => r.key), expected, '里程碑清单必须与规则一致（7 类）');
    assert.equal(rows.length, s.rules.milestones.items.length);
    for (const r of rows) {
      assert.equal(r.counts_toward_tier, 1, '7 类都计入段位里程碑数');
      assert.equal(r.requires_signoff, 1, '都要有确认才算达成');
      assert.equal(r.stage_id, null, '里程碑属于整届，不是某个赛段');
      assert.ok(r.fixed_at, '要有固定时间（防拆单刷里程碑）');
    }
    // 清单本身仍来自 teams.milestones_json（两处同源）
    const stored = JSON.parse(s.db.prepare('SELECT milestones_json FROM teams WHERE id = ?').get(team.id).milestones_json);
    assert.deepEqual(stored.items.map((i) => i.key).sort(), expected, '清单仍是报名时固定的那份');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 企业签字 → 里程碑达成 → 段位从 D 升到 C（事实确认进段位）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? AND key = 'problem_confirmed'").get(team.id);
    assert.ok(ms, '要有该里程碑');

    const before = computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false });
    assert.equal(before.tier, 'D', '没签字前没有达成 → D 段');

    const res = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认问题在排班环节，我方负责接口对接，落地时间 11 月' },
    });
    assert.equal(res.status, 200, res.body);

    const signoffs = s.db.prepare('SELECT * FROM milestone_signoffs WHERE milestone_id = ?').all(ms.id);
    assert.equal(signoffs.length, 1, '要写一条签字');
    assert.equal(signoffs[0].department, '业务部门');
    assert.equal(signoffs[0].enterprise_id, s.seat.id, 'enterprise_id = 签字的企业席账号');
    assert.equal(signoffs[0].revoked_at, null);

    const after = computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false });
    assert.equal(after.milestoneCount, 1, '1 个里程碑达成');
    assert.equal(after.tier, 'C', '有 1 个达成 → C 段');
    assert.equal(after.businessSignoffCount, 1, '业务部门签字计入业务签字数');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 无 signoff:create 能力的人签字 → 403（能力点必须真的被校验）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? LIMIT 1").get(team.id);
    const res = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenCaptain, body: { department: '业务部门', content: '我自己签自己' },
    });
    assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs').get().n, 0, '拒绝后不得留下签字');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 签字缺内容 / 缺部门 → 400（R-JDG-14：签字必须写清内容）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? LIMIT 1").get(team.id);
    const noContent = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '   ' },
    });
    assert.equal(noContent.status, 400);
    assert.equal(JSON.parse(noContent.body).error.code, 'MISSING_CONTENT');
    const noDept = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { content: '有内容没部门' },
    });
    assert.equal(noDept.status, 400);
    assert.equal(JSON.parse(noDept.body).error.code, 'MISSING_DEPARTMENT');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs').get().n, 0);
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 签一个不存在的里程碑 → 404', async () => {
  const s = setup();
  try {
    const res = await call(s.app, 'POST', '/api/milestones/ms_nope/signoff', {
      token: s.tokenSeat, body: { department: '业务部门', content: '内容内容内容内容内容' },
    });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.code, 'MILESTONE_NOT_FOUND');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 撤回签字 → 里程碑回到未达成（段位由重算体现降档）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? AND key = 'problem_confirmed'").get(team.id);
    const signed = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认问题在排班环节，落地时间 11 月' },
    });
    assert.equal(signed.status, 200, signed.body);
    const signoffId = JSON.parse(signed.body).id;
    assert.equal(computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false }).tier, 'C');

    const wd = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat, body: { signoffId },
    });
    assert.equal(wd.status, 200, wd.body);
    const row = s.db.prepare('SELECT * FROM milestone_signoffs WHERE id = ?').get(signoffId);
    assert.ok(row.revoked_at, '撤回 = 软删除（置 revoked_at），不物理删除');

    const after = computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false });
    assert.equal(after.milestoneCount, 0, '撤回后不再算达成');
    assert.equal(after.tier, 'D', '段位回到 D');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 不能撤回别的企业的签字 → 403；重复撤回 → 409', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? LIMIT 1").get(team.id);
    const signed = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认问题在排班环节，落地时间 11 月' },
    });
    const signoffId = JSON.parse(signed.body).id;

    const other = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat2, body: { signoffId },
    });
    assert.equal(other.status, 403, '只能撤回本企业自己的签字');
    assert.equal(JSON.parse(other.body).error.code, 'NOT_YOUR_SIGNOFF');

    const first = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat, body: { signoffId },
    });
    assert.equal(first.status, 200);
    const again = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat, body: { signoffId },
    });
    assert.equal(again.status, 409);
    assert.equal(JSON.parse(again.body).error.code, 'ALREADY_REVOKED');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 未登录签字 → 401', async () => {
  const s = setup();
  try {
    const res = await call(s.app, 'POST', '/api/milestones/ms_x/signoff', {
      body: { department: '业务部门', content: '内容内容内容内容' },
    });
    assert.equal(res.status, 401);
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});
```

`platform/test/behavior-service.test.js`：

```javascript
// platform/test/behavior-service.test.js —— 行为分事件的写入通路（★ 独立通路，与总分隔离）
//
// 规则溯源：
//   - 「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」→ R-STG-04
//   - 反作弊 5 条（签到 0 分 / 纯文字不给分 / 须带版本记录 + 代码仓）→ R-PTS-10
//   - 行为分只做破同分垫底排序，不进总分 → R-PTS-08 / S10 §3.3
//   - 权限模型 = capability + assignment，can() 是唯一判定入口
//
// ⛔ 分值【不】由提交方给定：一律取 rules/behavior-points.json 里该类型的分值（防篡改）。
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
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
import { getLeaderboard } from '../src/services/leaderboard.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const GOOD = {
  direction: [4, 4, 4, 4, 5], capability: [4, 4, 4, 4, 5], collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题', consent: { accepted: true },
};
const WEEKLY_EVIDENCE = { repo: 'git@example.com:team/repo', version: 'v1.2.0', artifact: 'demo.zip' };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-beh-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2099-12-31',
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900008001', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const captain = createUser(db, { name: '队长甲', phone: '13900008002', password: 'pw', mbaStatus: 'mba' });
  const captainB = createUser(db, { name: '队长乙', phone: '13900008005', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '路人', phone: '13900008003', password: 'pw', mbaStatus: 'mba' });
  const admin = createUser(db, { name: '组委会', phone: '13900008004', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  insertRegistration(db, {
    editionId: edition.id, userId: captain.id, answers: GOOD, rawScore: 80,
    level: 'S', status: 'submitted', now: NOW,
  });

  insertCapability(db, 'team:create', '创建战队');
  insertCapability(db, 'behavior:write', '提交行为分记录');
  grantAssignment(db, {
    userId: captain.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: captain.id, capability: 'behavior:write', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, edition, pkg, captain, captainB, outsider, admin,
    tokenCaptain: createSession(db, captain.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

async function createTeam(s, name = '甲队') {
  const res = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

test('★ 提交合规证据 → 200 + 落库 + 分值取自规则（不给提交方自报分）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const res = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      token: s.tokenCaptain,
      body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE, points: 99 },
    });
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).points, 2, 'weekly_progress = 2 分（规则值），提交方传的 99 必须被忽略');

    const rows = s.db.prepare('SELECT * FROM behavior_events WHERE team_id = ?').all(team.id);
    assert.equal(rows.length, 1, '要落一条事件');
    assert.equal(rows[0].points, 2, '落库的分值也必须是规则值（防篡改）');
    assert.equal(rows[0].type, 'weekly_progress');
    assert.equal(rows[0].user_id, s.captain.id);
    assert.ok(rows[0].evidence.includes('v1.2.0'), '证据要留痕');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 纯文字进度 / 缺必填证据 → 400 拒收（不给分、不落库）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const cases = [
      ['纯文字说明', { repo: 'git@example.com:team/repo', version: 'v1', note: '我们做了很多工作' }, 'EVIDENCE_REJECTED'],
      ['缺 version', { repo: 'git@example.com:team/repo', artifact: 'demo.zip' }, 'EVIDENCE_REJECTED'],
      ['缺 repo', { version: 'v1', artifact: 'demo.zip' }, 'EVIDENCE_REJECTED'],
      ['既无产物也无阻塞点', { repo: 'git@example.com:team/repo', version: 'v1' }, 'EVIDENCE_REJECTED'],
      ['证据不是对象', '就是一段纯文字', 'EVIDENCE_REJECTED'],
    ];
    for (const [label, evidence] of cases) {
      const res = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
        token: s.tokenCaptain, body: { type: 'weekly_progress', evidence },
      });
      assert.equal(res.status, 400, `${label} 必须被拒收，实际 ${res.status}`);
      assert.equal(JSON.parse(res.body).error.code, 'EVIDENCE_REJECTED');
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n, 0, '一条都不能落库');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 未知事件类型 → 400（未知类型不给分，也不静默接受）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const res = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      token: s.tokenCaptain, body: { type: 'daily_checkin', evidence: { repo: 'x', version: 'v1', artifact: 'a' } },
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, 'UNKNOWN_EVENT_TYPE');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 无 behavior:write 能力 → 403；未登录 → 401；未知队伍 → 404', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const forbidden = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      token: s.tokenOutsider, body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(JSON.parse(forbidden.body).error.code, 'FORBIDDEN');

    const anon = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(anon.status, 401);

    const noTeam = await call(s.app, 'POST', '/api/teams/t_nope/behavior-events', {
      token: s.tokenCaptain, body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(noTeam.status, 404);
    assert.equal(JSON.parse(noTeam.body).error.code, 'TEAM_NOT_FOUND');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 端到端：API 提交的事件真的进了破同分链的 behavior 级（同分时行为分高的排前）', async () => {
  const s = setup();
  try {
    const teamA = await createTeam(s, '甲队');
    // 第二支队：换队长建（一个账号不能同时在两支队 —— team_members.user_id 唯一）
    s.db.prepare(`INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
      VALUES ('t_b', ?, '乙队', ?, ?, 'D', 'active', ?)`)
      .run(s.edition.id, s.captainB.id, s.pkg.id, NOW);
    s.db.prepare("INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ('tm_b','t_b',?,'captain',?)")
      .run(s.captainB.id, NOW);

    // 赛段：两队总分完全相同（90 : 90）→ 破同分链只能落到 behavior / team_id
    s.db.prepare(`INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
      VALUES ('st_1', ?, 'S1', '调研赛段', 'initial', '2026-10-01', '2026-10-10', '2026-10-11', 'initial', 'closed')`).run(s.edition.id);
    s.db.prepare(`INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
      VALUES ('sr_a','st_1',?,1,90,90,90,1,NULL,NULL,?), ('sr_b','st_1','t_b',1,90,90,90,1,NULL,NULL,?)`)
      .run(teamA.id, NOW, NOW);

    const before = getLeaderboard({ db: s.db, stageId: 'st_1', scope: 'rank', viewer: null });
    assert.deepEqual(before.rows.map((r) => r.teamId), [teamA.id, 't_b'], '同分时先按 team_id 码位序');

    // 走**写入通路**给甲队提交一条合规周进度（2 分）
    const res = await call(s.app, 'POST', `/api/teams/${teamA.id}/behavior-events`, {
      token: s.tokenCaptain, body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(res.status, 200, res.body);

    const after = getLeaderboard({ db: s.db, stageId: 'st_1', scope: 'rank', viewer: null });
    assert.deepEqual(after.rows.map((r) => r.teamId), [teamA.id, 't_b'], '行为分高的甲队排到前面（破同分生效）');
    assert.deepEqual(after.rows.map((r) => r.rank), [1, 2], '行为分把并列拆开');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});
```

### 五、终审修复轮的差分检验

对每处修复做「**改回旧写法 ⇒ 对应用例必须变红**」的差分实证（脚本 `/tmp/p3fix/mutate-final.mjs`，
在 `/tmp/p3fix/diffwork` 的副本上跑，**测试必须失败才算杀灭**）：

| 变异体 | 改回旧写法 | 结果 |
|---|---|---|
| C-1 | `buildPersonalPayload` 去掉 `toLedgerEntry` 映射 | ✅ KILLED —— 「个人积分榜端到端」变红 |
| I-1a | `awardMvp` 去掉「只在路演赛段发榜」的限制 | ✅ KILLED —— 「MVP 只在路演赛段发榜时发放」变红 |
| I-1b | 幂等键改回赛段级 `(stageId, teamId, kind)` | ✅ KILLED —— 同上变红 |
| I-2 | 滚动总榜 `warnings` 改回 `[]` | ✅ KILLED —— 「滚动总榜必须汇总各赛段的降级告警」变红 |
| M-3 | `reasons_json` 去掉 try/catch | ✅ KILLED —— 「原因说明是脏数据时降级为空列表」变红 |
| I-3z | 行为分映射去掉「没提交 = 0 分」的默认值 | ✅ KILLED —— 「端到端：API 提交的事件真的进了破同分链」变红 |
| M-1 | `points.js` 兜底键改回 `id` | — **不可观测变异体**（探针差分实证见下） |
| M-2 | `stage-teams.js` 兜底键改回 `id` | — **不可观测变异体**（探针差分实证见下） |

**M-1 / M-2 的探针差分实证**（脚本 `/tmp/p3fix/probe-order.mjs`）：

```
=== 探针 1：两种兜底键给出的顺序真的不同 ===
按 id  ASC : 035fd7a3 0b4970ce 18cbcfad 22d164b8 …
按 rowid ASC: ba485b06 92684db4 7129e0ce 035fd7a3 …
顺序是否不同 : true ✅ 变异体真的改变了行为（不是空变异）

=== 探针 2：对外产出（个人积分榜）不受影响 ===
按 id  兜底 → [{"userId":"u_0","total":22},{"userId":"u_1","total":18},{"userId":"u_2","total":14}]
按 rowid 兜底 → [{"userId":"u_0","total":22},{"userId":"u_1","total":18},{"userId":"u_2","total":14}]
产出是否相同 : true ✅ 差异不传导 ⇒ 不可观测变异体
```

⇒ 两者是**不可观测变异体**（不是等价变异体）：SQL 层的排序**真的变了**，
但个人积分榜最终按「总分降序 + userId 码位序」重排 ⇒ 差异不传导到任何对外产出。
**仍然要修**：硬约束「任何排序兜底键不得用随机 UUID」是**跨机器可复算**的地基，
今天不传导不代表明天不传导（多插一条流水就可能传导）。

**终审修复轮的结果**：变异体 **8** → **KILLED 6 / 不可观测变异体 2（均有探针差分实证）/ 有效缺口 0**；
P3 全量 **709/709**；`node scripts/migrate.js` 输出 `迁移完成，当前版本 4`；
P3 验收标准自查 **8/8 通过**。

### 六、终审修复轮之后的已知限制

| # | 限制 | 说明 |
|---|---|---|
| 1 | **MVP 只在路演赛段发榜时产生** | 本届**没有路演赛段**、或路演赛段**尚无评分结果** ⇒ 不发 MVP（公式缺最后一个输入，不做半个公式的奖）。**运营要求**：组委会必须对路演赛段发榜，MVP 才会产生。⚠️ 积分只增不改 ⇒ MVP 一旦发出不再调整（这是「只增不改」纪律的必然结果，不是缺陷） |
| 2 | **里程碑清单的固定时点 = 组队时** | `milestones` 表的行在**建队**时落一次（对齐 R-STG-03「里程碑报名时固定」）。**组队之后**新增的里程碑不会自动补进已有队伍 —— 补录归 **P5 的工作流** |
| 3 | **赛段名册仍是届期级** | `stage_team` 表在 P3 建好了（Task 1 兑现 D-33），但**没有写入流程** —— 名册的登记时机（赛段开启时把该届参赛队登记进来）属 **P5 的工作流**（终审修复轮未改这一条） |
| 4 | **企业签字的「撤回」有归属限制** | `POST /api/milestones/:id/signoff/withdraw` 要求 `signoff:create` 能力点（企业 / 企业管理员），且**只能撤回自己签的那条**（`signoffId` 必填且必须属于该里程碑）；**组委会（超管）可代撤**。撤回是**软删除**（置 `revoked_at`），撤回后该里程碑回到「未达成」，段位降档由**重算**体现 |
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
| SYNC-7 | `test/leaderboard-migration.test.js` | P3 自身后续（榜单服务、战绩卡与 4 个榜单 API）→ P5 Task 3 修复轮（3 条 Important + 3 条 Minor） | 241 | `--verify` 逐字一致 |
| SYNC-8 | `test/points.test.js` | P5 Task 3 修复轮 **I-3**：个人积分口径**唯一化**（`atomicKinds` / `rollupKind` 收进 `rules.points.personal`；「有 `personal_rollup` 行 ⇒ 以 rollup 为准，否则 ⇒ atomic 白名单之和」） | 398 | `--verify` 逐字一致 |

> **注意**：SYNC-8 同步进来的**不是「多写了几行断言」，而是口径变了** ——
> 原计划块断言「`personal_rollup` 不参与累加、任何 kind 都计入」，
> 现行实现断言「有 rollup 行就以 rollup 为准、否则取 atomic 白名单之和」。
> 两者在**同一份流水**下会算出**两个不同的名次**（这正是 I-3 要消灭的不一致）。

### 良性扩展（仅记录，计划块保持原样）

| 编号 | 文件 | 后续阶段的追加内容 |
|---|---|---|
| SYNC-17 | `src/domain/points.js` | P5 Task 3 修复轮（个人积分口径唯一化的**唯一计算点** `computePersonalTotals`） |
| SYNC-18 | `src/services/milestone.js` | P3 终审修复轮（个人积分榜 / MVP / 滚动榜告警相关写入通路）；溯源注释补齐 |
| SYNC-19 | `test/leaderboard-web.test.js` | P3 终审修复轮；P6 Task 5（演示版适配器扩展为完整流程） |

> ⚠️ **口径**：C-EXT 的「良性」指**结构上**是追加，不等于内容永远不变。
> 漂移审计可随时复算：`node docs/tools/plan-block-audit.mjs platform`。
> 若某个文件后续被**重写**（而非追加），它会自动从 C-EXT 升到 C-RW，届时必须再做一次同步。


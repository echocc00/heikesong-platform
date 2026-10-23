# P1 报名与组队 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通「报名 → 自动算分分级 → 建队并认领任务包 → 加人/汰换」全链路：SABC 3 维 100 分自动分级、企业任务卡六维可解性准入与分级签约、组队硬门槛（MBA 组长 / ≥2 人 / 任务包已分级）、赛程中成员持续招募汰换与单、并队触发。

**Architecture:** 沿用 P0 单进程 Node（仅标准库）骨架。`src/domain/` 放纯函数规则引擎（`registration.js` 算分分级、`solvability.js` 六维可解性，无 IO / 无 `Date.now()` / 无 `Math.random()`）；`src/services/` 做用例编排（报名 / 战队 / 任务卡）；`src/db/repo/` 收全部 SQL（7 张新表 + 7 个仓储模块）；`src/http/routes/` 挂 P1 的 14 个 API 端点（报名 5 + 战队 5 + 任务卡 4）。可见性在 API 层过滤：报名筛选标准公开可读，个人报名明细只对本人与组委会可见。

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

── P1 追加 ─────────────────────────────────────────────────────────────
领域层      src/domain/* 是纯函数：无 IO、无 Date.now()、无 Math.random()；时间由 now 参数传入
时间参数    服务层用 now ?? new Date().toISOString()；领域层一律从入参取
ID          crypto.randomUUID()，字符串主键
追加式      registration_events 只增不改；改级/申诉都写新事件，不覆盖历史
软删除      业务表带 deleted_at；删除 = 写时间戳，不删行
错误        抛 AppError(status + code + message + detail)（status-first），HTTP 层转 error(res, status, code, message, detail)
纯函数出口  scoreRegistration / classifyLevel / validateRegistrationAnswers / scoreSolvability
            的入参里【不存在】now / db / 随机数；传入也被忽略
硬门槛      队长必须一堂 MBA 在籍（R-REG-05 已定）；人数 ≥2（R-REG-02 已定）；
            任务包可解性已分级 —— 三条在配置里被改坏 → 配置校验 fail-fast 拒绝启动
任务包      D 级不是静默丢弃：必须生成《问题可解性诊断报告》（R-ENT-08）
自由命题    is_free_brief=1 的任务卡没有企业签字，不得签署企业协议（R-ENT-10）
可见性      报名筛选标准公开；个人报名明细仅本人与组委会可见；过滤在 API 层
```

## File Structure

**本阶段创建**

```
platform/
├── rules/
│   ├── team-formation.json        组队规则（内容逐字取自 INTERFACES.md §2）
│   ├── schedule.json              5 赛段时间轴与交付物（R-STG-01）
│   └── compliance.json            IP 归属 + 合规红线 + 同意清单（R-ENT-11 / R-ENT-12）
├── src/
│   ├── errors.js                  AppError（契约 §0 要求的错误类型，**P0 已建**，本阶段只复用）
│   ├── domain/
│   │   ├── registration.js        报名算分分级纯函数
│   │   └── solvability.js         六维可解性纯函数
│   ├── services/
│   │   ├── registration.js        报名服务（提交/读取/列表/改级）
│   │   ├── team.js                战队服务（建队/加人/退出/汰换/换包）
│   │   └── taskPackage.js         任务卡服务（提交/可解性评估/分级签约）
│   ├── db/repo/
│   │   ├── editions.js
│   │   ├── cities.js
│   │   ├── taskPackages.js
│   │   ├── registrations.js
│   │   ├── registrationEvents.js
│   │   ├── teams.js
│   │   └── teamMembers.js
│   └── http/routes/
│       ├── registration.js        报名 5 个端点
│       ├── team.js                战队 5 个端点
│       └── taskPackage.js         任务卡 4 个端点
├── db/migrations/002_registration.sql
├── web/views/
│   ├── registration.js            报名问卷（明示筛选标准 + 可解释明细）
│   ├── team.js                    我的战队（组队/汰换）
│   └── admin-registration.js      组委会筛选台（可解释明细 + 复核/申诉/改级 + 任务包配比）
└── test/
    ├── migration-002.test.js
    ├── registration-domain.test.js
    ├── registration-service.test.js
    ├── registration-api.test.js
    ├── solvability-domain.test.js
    ├── task-package-service.test.js
    ├── team-service.test.js
    ├── p1-frontend.test.js
    └── e2e-p1.test.js
```

**本阶段修改**

```
platform/src/config.js                       新增 team-formation / schedule / compliance 的加载与 fail-fast 校验
platform/rules/registration-scoring.json     新增 scale / questions（15 题 + 1 开放题）/ funnel
platform/rules/solvability.json              新增 taskMix.enterpriseGradeSplit 与 taskMix.tolerance
platform/src/server.js                        装配 P1 路由（registerP1Routes）
platform/scripts/seed.js                      扩充 P1 种子：届期/城市/任务包/报名/战队
platform/web/app.js                           注册 P1 三页路由
```

---

### Task 1: 报名数据模型与迁移 `002_registration.sql`

**Files:**
- Create: `platform/db/migrations/002_registration.sql`
- Create: `platform/src/db/repo/editions.js`
- Create: `platform/src/db/repo/cities.js`
- Create: `platform/src/db/repo/taskPackages.js`
- Create: `platform/src/db/repo/registrations.js`
- Create: `platform/src/db/repo/registrationEvents.js`
- Create: `platform/src/db/repo/teams.js`
- Create: `platform/src/db/repo/teamMembers.js`
- Create: `platform/test/migration-002.test.js`
- Modify: `platform/test/migrate.test.js`（**P0 遗留的跨里程碑缺口**：该文件的迁移集快照断言
  自带 TODO「P1 加入 002 之后…到 P1 时按此提示修改」，但 P1 计划的 7 个 Task **无一 owns 它**
  → 002 一落地必红。002 落地后必须按 TODO 处方把「恰好 N 张表 / 恰好 1 行 / version 仍为 1」
  改成「期望值从迁移目录推导」，**断言强度不减**（漏建表 / 迁移没被应用 / 历史对不上账仍被抓））

**Interfaces:**
- Consumes: `openDatabase()`（P0 Task 2）、`applyMigrations()`（P0 Task 2）、`users` 表（P0 Task 2）
- Produces:
  - 表 `editions` / `cities` / `task_packages` / `registrations` / `registration_events` / `teams` / `team_members`（列名逐字对齐 INTERFACES.md §2）
  - `createEdition(db, {...})` / `getEdition(db, id)` / `listEditions(db)`
  - `createCity(db, {...})` / `listCitiesByEdition(db, editionId)`
  - `createTaskPackage(db, {...})` / `getTaskPackage(db, id)` / `listTaskPackagesByEdition(db, editionId)` / `updateTaskPackage(db, id, patch)`
  - `insertRegistration(db, {...})` / `getRegistration(db, id)` / `findActiveRegistration(db, userId, editionId)` / `listRegistrationRows(db, filter)` / `updateRegistrationRow(db, id, patch)`
  - `insertRegistrationEvent(db, {...})` / `listRegistrationEvents(db, registrationId)`
  - `insertTeam(db, {...})` / `getTeam(db, id)` / `listTeamRows(db, filter)` / `updateTeamRow(db, id, patch)` / `countActiveTeamsByPackage(db, taskPackageId)`
  - `insertTeamMember(db, {...})` / `listActiveMembers(db, teamId)` / `listMemberHistory(db, teamId)` / `markMemberLeft(db, id, leftAt)` / `countActiveMembers(db, teamId)` / `findActiveMembershipByUser(db, userId)` / `lastLeaveAt(db, teamId)`

- [ ] **Step 1: 写失败的测试**

`platform/test/migration-002.test.js`：

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

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-mig2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

test('P1 的 7 张表都建出来了', () => {
  const { db, close, dataDir } = setup();
  const names = tableNames(db);
  for (const t of [
    'editions', 'cities', 'task_packages',
    'registrations', 'registration_events', 'teams', 'team_members',
  ]) {
    assert.ok(names.includes(t), `缺少表 ${t}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('registrations 的列与 INTERFACES.md §2 逐字一致', () => {
  const { db, close, dataDir } = setup();
  const cols = columnsOf(db, 'registrations');
  const expected = [
    'id', 'edition_id', 'user_id', 'answers_json', 'dimension_scores_json',
    'raw_score', 'level', 'level_final', 'decided_by', 'decided_at',
    'decision_note', 'status', 'created_at', 'deleted_at',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `registrations 缺少列 ${c}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('task_packages 的列与 INTERFACES.md §2 逐字一致', () => {
  const { db, close, dataDir } = setup();
  const cols = columnsOf(db, 'task_packages');
  const expected = [
    'id', 'edition_id', 'enterprise_id', 'enterprise_name', 'title', 'pain_point',
    'expected_delivery', 'acceptance_criteria', 'grade', 'status',
    'solvability_score', 'solvability_grade', 'commitment', 'agreement',
    'is_free_brief', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at',
    'deleted_at',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `task_packages 缺少列 ${c}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('teams / team_members / registration_events 的列齐全', () => {
  const { db, close, dataDir } = setup();
  const teams = columnsOf(db, 'teams');
  for (const c of ['id', 'edition_id', 'name', 'captain_id', 'task_package_id', 'tier', 'status', 'created_at', 'deleted_at']) {
    assert.ok(teams.includes(c), `teams 缺少列 ${c}`);
  }
  const members = columnsOf(db, 'team_members');
  for (const c of ['team_id', 'user_id', 'role', 'joined_at', 'left_at']) {
    assert.ok(members.includes(c), `team_members 缺少列 ${c}`);
  }
  const events = columnsOf(db, 'registration_events');
  for (const c of ['id', 'registration_id', 'from_status', 'to_status', 'actor_id', 'reason', 'created_at']) {
    assert.ok(events.includes(c), `registration_events 缺少列 ${c}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('软删除列存在且可空', () => {
  const { db, close, dataDir } = setup();
  for (const t of ['task_packages', 'registrations', 'teams']) {
    const info = db.prepare(`PRAGMA table_info(${t})`).all();
    const col = info.find((c) => c.name === 'deleted_at');
    assert.ok(col, `${t} 缺少 deleted_at`);
    assert.equal(col.notnull, 0, `${t}.deleted_at 必须可空`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键真的生效：edition_id 不存在时插入失败', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900001001', password: 'pw', mbaStatus: 'mba' });
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO registrations (id, edition_id, user_id, answers_json, status, created_at)
           VALUES ('r1', 'edition_missing', ?, '{}', 'submitted', '2026-10-20T00:00:00.000Z')`,
        )
        .run(user.id),
    /FOREIGN KEY|constraint/i,
    '外键未被强制',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('同一 userId + editionId 不能重复报名（幂等守卫在数据库层）', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900001002', password: 'pw', mbaStatus: 'mba' });
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('e1', '首届', '上海', '2026-10-01', '2026-10-31', '2026-10-20T00:00:00.000Z')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO registrations (id, edition_id, user_id, answers_json, status, created_at)
     VALUES (?, 'e1', ?, '{}', 'submitted', '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1', user.id);
  assert.throws(() => ins.run('r2', user.id), /UNIQUE|constraint/i, '重复报名未被拦截');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('一个用户只能同时属于一个战队（部分唯一索引）', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900001003', password: 'pw', mbaStatus: 'mba' });
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('e1', '首届', '上海', '2026-10-01', '2026-10-31', '2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO teams (id, edition_id, name, captain_id, status, created_at)
     VALUES ('t1', 'e1', '一队', ?, 'forming', '2026-10-20T00:00:00.000Z')`,
  ).run(user.id);
  const ins = db.prepare(
    `INSERT INTO team_members (id, team_id, user_id, role, joined_at, left_at)
     VALUES (?, 't1', ?, 'member', '2026-10-20T00:00:00.000Z', NULL)`,
  );
  ins.run('m1', user.id);
  assert.throws(
    () => ins.run('m2', user.id),
    /UNIQUE|constraint/i,
    '同一用户同时加入两个战队未被拦截',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```


- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/migration-002.test.js`
Expected: FAIL —— `缺少表 editions`（迁移 002 还不存在）

- [ ] **Step 3: 创建 db/migrations/002_registration.sql**

```sql
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
```

- [ ] **Step 4: 创建 src/db/repo/editions.js 与 cities.js**

`platform/src/db/repo/editions.js`：

```javascript
// src/db/repo/editions.js — 届期仓储
// 依据：设计文档 §5.1 + R-OPS-09（模型必须带 edition × city 维度）
import { randomUUID } from 'node:crypto';

export function createEdition(db, {
  name, city, startsAt, endsAt, now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, city, startsAt, endsAt, now);
  return getEdition(db, id);
}

export function getEdition(db, id) {
  return db.prepare('SELECT * FROM editions WHERE id = ?').get(id) ?? null;
}

export function listEditions(db) {
  return db.prepare('SELECT * FROM editions ORDER BY starts_at').all();
}
```

`platform/src/db/repo/cities.js`：

```javascript
// src/db/repo/cities.js — 城市仓储
// 依据：INTERFACES.md §2（cities(id, name, edition_id)）
import { randomUUID } from 'node:crypto';

export function createCity(db, { name, editionId }) {
  const id = randomUUID();
  db.prepare('INSERT INTO cities (id, name, edition_id) VALUES (?, ?, ?)').run(
    id, name, editionId,
  );
  return db.prepare('SELECT * FROM cities WHERE id = ?').get(id);
}

export function listCitiesByEdition(db, editionId) {
  return db.prepare('SELECT * FROM cities WHERE edition_id = ? ORDER BY name').all(editionId);
}
```

- [ ] **Step 5: 创建 src/db/repo/taskPackages.js**

```javascript
// src/db/repo/taskPackages.js — 任务卡仓储
// 依据：INTERFACES.md §2 + R-ENT-01（痛点/期望交付/验收标准）
import { randomUUID } from 'node:crypto';

// 可更新列白名单：列名只能从这里出，杜绝把用户输入拼进 SET 子句
const UPDATABLE = new Set([
  'title', 'pain_point', 'expected_delivery', 'acceptance_criteria',
  'grade', 'status', 'solvability_score', 'solvability_grade',
  'commitment', 'agreement', 'approved_by', 'approved_at', 'meta_json',
]);

export function createTaskPackage(db, {
  editionId,
  enterpriseId = null,
  enterpriseName = null,
  title,
  painPoint,
  expectedDelivery,
  acceptanceCriteria,
  isFreeBrief = false,
  submittedBy,
  meta = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_packages (
       id, edition_id, enterprise_id, enterprise_name, title, pain_point,
       expected_delivery, acceptance_criteria, grade, status,
       solvability_score, solvability_grade, commitment, agreement,
       is_free_brief, submitted_by, submitted_at, approved_by, approved_at,
       meta_json, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'submitted', NULL, NULL, NULL, NULL,
               ?, ?, ?, NULL, NULL, ?, NULL)`,
  ).run(
    id, editionId, enterpriseId, enterpriseName, title, painPoint,
    expectedDelivery, acceptanceCriteria,
    isFreeBrief ? 1 : 0, submittedBy, now,
    meta ? JSON.stringify(meta) : null,
  );
  return getTaskPackage(db, id);
}

export function getTaskPackage(db, id) {
  return db.prepare('SELECT * FROM task_packages WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

/**
 * 按届期列任务卡。
 *
 * ⚠️ 父代理预审修正（Important）：editionId 缺省时**不按届期过滤**（列全部届期），
 *    而不是把 undefined 绑进 SQL。
 *    原来写死 `WHERE edition_id = ?` → GET /api/task-packages 不带 editionId 时
 *    node:sqlite 抛「Provided value cannot be bound to SQLite parameter 1.」
 *    → 裸 TypeError 漏到 HTTP 层 → 只能回 500（父代理预审实跑复现）。
 *    约定与报名的 listRegistrationRows 完全一致：过滤条件缺省即不生效。
 */
export function listTaskPackagesByEdition(db, editionId = null) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare(
      `SELECT * FROM task_packages WHERE ${where.join(' AND ')} ORDER BY submitted_at, rowid`,
    )
    .all(...params);
}

export function updateTaskPackage(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'meta_json' && patch[k] && typeof patch[k] === 'object'
        ? JSON.stringify(patch[k])
        : patch[k],
    );
    db.prepare(`UPDATE task_packages SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getTaskPackage(db, id);
}
```

- [ ] **Step 6: 创建 src/db/repo/registrations.js 与 registrationEvents.js**

`platform/src/db/repo/registrations.js`：

```javascript
// src/db/repo/registrations.js — 报名仓储
// 依据：INTERFACES.md §2（registrations 列清单）+ 设计文档 §5.2
import { randomUUID } from 'node:crypto';

const UPDATABLE = new Set([
  'level', 'level_final', 'decided_by', 'decided_at', 'decision_note', 'status',
]);

export function insertRegistration(db, {
  editionId,
  userId,
  answers,
  dimensionScores = null,
  rawScore = null,
  level = null,
  status = 'submitted',
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO registrations (
       id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
       level, level_final, decided_by, decided_at, decision_note,
       status, created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    id, editionId, userId,
    JSON.stringify(answers),
    dimensionScores ? JSON.stringify(dimensionScores) : null,
    rawScore, level, status, now,
  );
  return getRegistration(db, id);
}

export function getRegistration(db, id) {
  return db
    .prepare('SELECT * FROM registrations WHERE id = ? AND deleted_at IS NULL')
    .get(id) ?? null;
}

export function findActiveRegistration(db, userId, editionId) {
  return db
    .prepare(
      `SELECT * FROM registrations
       WHERE user_id = ? AND edition_id = ? AND deleted_at IS NULL`,
    )
    .get(userId, editionId) ?? null;
}

export function listRegistrationRows(db, {
  editionId = null, status = null, level = null, limit = 200, offset = 0,
} = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (level) { where.push('level = ?'); params.push(level); }
  params.push(limit, offset);
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare(
      `SELECT * FROM registrations WHERE ${where.join(' AND ')}
       ORDER BY created_at, rowid LIMIT ? OFFSET ?`,
    )
    .all(...params);
}

export function updateRegistrationRow(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    db.prepare(`UPDATE registrations SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getRegistration(db, id);
}
```

`platform/src/db/repo/registrationEvents.js`：

```javascript
// src/db/repo/registrationEvents.js — 报名状态事件仓储（只增不改）
// 依据：INTERFACES.md §0「追加式：评分/签字类记录只增不改」+ §2 registration_events
import { randomUUID } from 'node:crypto';

export function insertRegistrationEvent(db, {
  registrationId,
  fromStatus = null,
  toStatus,
  actorId = null,
  reason = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO registration_events
       (id, registration_id, from_status, to_status, actor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, registrationId, fromStatus, toStatus, actorId, reason, now);
  return id;
}

/**
 * 批量取多条报名的状态事件，按报名 id 分组返回。
 *
 * ⚠️ P1 Task 6 修正（Important，列表端点的轨迹恒空）：
 *    组委会筛选台读的是 `GET /api/registrations`（**列表**），而事件轨迹此前只有
 *    `getRegistration`（**单条**）才挂 `events` → 列表里的 `r.events` 恒为 undefined
 *    → 筛选台「事件轨迹」一栏永远是空的（计划声称的功能实际没落地）。
 *    修法有两种：① 前端逐行再拉一次详情（N+1 次 HTTP）；② 后端批量带上。
 *    选 ②：**一次 SQL** 把这一页报名的事件全捞回来，不新增往返。
 *
 * 排序键与 `listRegistrationEvents` 一致：`created_at, rowid` —— 兜底键必须是
 * **确定性**的（rowid 按插入顺序单调递增），不能用随机 UUID（见上面的说明）。
 *
 * @param {string[]} registrationIds 报名 id 列表
 * @returns {Map<string, object[]>} 报名 id → 事件行数组（没有事件的报名不出现在 Map 里）
 */
export function listRegistrationEventsForRegistrations(db, registrationIds) {
  const ids = [...new Set((registrationIds ?? []).filter((id) => typeof id === 'string' && id !== ''))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM registration_events
        WHERE registration_id IN (${placeholders})
        ORDER BY created_at, rowid`,
    )
    .all(...ids);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.registration_id)) grouped.set(row.registration_id, []);
    grouped.get(row.registration_id).push(row);
  }
  return grouped;
}

export function listRegistrationEvents(db, registrationId) {
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare('SELECT * FROM registration_events WHERE registration_id = ? ORDER BY created_at, rowid')
    .all(registrationId);
}
```

- [ ] **Step 7: 创建 src/db/repo/teams.js 与 teamMembers.js**

`platform/src/db/repo/teams.js`：

```javascript
// src/db/repo/teams.js — 战队仓储
// 依据：INTERFACES.md §2（teams 列清单）+ R-REG-01（建队即认领任务包）
import { randomUUID } from 'node:crypto';

const UPDATABLE = new Set([
  'name', 'captain_id', 'task_package_id', 'tier', 'status', 'milestones_json',
]);

export function insertTeam(db, {
  editionId,
  name,
  captainId,
  taskPackageId = null,
  tier = null,
  status = 'forming',
  milestones = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO teams (
       id, edition_id, name, captain_id, task_package_id, tier, status,
       milestones_json, created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id, editionId, name, captainId, taskPackageId, tier, status,
    milestones ? JSON.stringify(milestones) : null, now,
  );
  return getTeam(db, id);
}

export function getTeam(db, id) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

export function listTeamRows(db, {
  editionId = null, taskPackageId = null, captainId = null, status = null,
} = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  if (taskPackageId) { where.push('task_package_id = ?'); params.push(taskPackageId); }
  if (captainId) { where.push('captain_id = ?'); params.push(captainId); }
  if (status) { where.push('status = ?'); params.push(status); }
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare(`SELECT * FROM teams WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`)
    .all(...params);
}

export function updateTeamRow(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'milestones_json' && patch[k] && typeof patch[k] === 'object'
        ? JSON.stringify(patch[k])
        : patch[k],
    );
    db.prepare(`UPDATE teams SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getTeam(db, id);
}

// R-REG-01 + 顶层文档：每个任务包 2–3 支战队（上限在服务层校验）
export function countActiveTeamsByPackage(db, taskPackageId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM teams WHERE task_package_id = ? AND deleted_at IS NULL')
    .get(taskPackageId).n;
}
```

`platform/src/db/repo/teamMembers.js`：

```javascript
// src/db/repo/teamMembers.js — 战队成员仓储
// 依据：R-REG-03（赛程中成员可持续招募汰换，退出报备）→ 保留进出历史，不硬删
import { randomUUID } from 'node:crypto';

export function insertTeamMember(db, {
  teamId, userId, role = 'member', now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO team_members (id, team_id, user_id, role, joined_at, left_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, teamId, userId, role, now);
  return id;
}

export function listActiveMembers(db, teamId) {
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare('SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL ORDER BY joined_at, rowid')
    .all(teamId);
}

export function listMemberHistory(db, teamId) {
  return db
    .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at, rowid')
    .all(teamId);
}

export function findActiveMembershipByUser(db, userId) {
  return db
    .prepare('SELECT * FROM team_members WHERE user_id = ? AND left_at IS NULL LIMIT 1')
    .get(userId) ?? null;
}

export function markMemberLeft(db, id, leftAt = new Date().toISOString()) {
  return db
    .prepare('UPDATE team_members SET left_at = ? WHERE id = ? AND left_at IS NULL')
    .run(leftAt, id).changes;
}

export function countActiveMembers(db, teamId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL')
    .get(teamId).n;
}

// R-REG-04：并队期限 = 最后一次离队时间 + singleMemberMergeDeadlineDays（由服务层加天数）
export function lastLeaveAt(db, teamId) {
  return db
    .prepare('SELECT MAX(left_at) AS t FROM team_members WHERE team_id = ? AND left_at IS NOT NULL')
    .get(teamId).t ?? null;
}
```

- [ ] **Step 8: 放宽 migrate.test.js 的迁移集快照断言（P0 遗留 TODO）**

> ⛔ **【2026-10-21 父代理预审修正】** `platform/test/migrate.test.js` 里有一组**跨里程碑**的快照断言
> （「恰好 9 张表 / 恰好 1 行迁移 / version 仍为 1」），该文件自带 TODO：
> 「P1 加入 002 之后…到 P1 时按此提示修改」。但 P1 计划的 7 个 Task **无一 owns 这个文件**
> → 002 一落地必红（父代理预审实跑：147 pass / 1 fail）。
> 修法：把期望值改成**从迁移目录推导**（读 `platform/db/migrations/` 实际内容算张数与行数），
> 而不是写死数字。**断言强度不减**：漏建表 / 迁移没被应用 / 历史对不上账仍会被抓住
> （已用「把 cities 改名」变异实测）。

- [ ] **Step 10: 运行测试确认通过**

Run: `cd platform && node --test test/migration-002.test.js`
Expected: PASS（8 个测试全过：migration-002 8）

- [ ] **Step 11: 提交**

```bash
cd platform && git add db/migrations/002_registration.sql src/db/repo test/migration-002.test.js test/migrate.test.js
git commit -m "feat(P1): 报名与组队数据模型（7 张表 + 仓储层）

对应需求：R-REG-01 / R-REG-02 / R-REG-03 / R-REG-04 / R-ENT-01 / R-ENT-10 / R-OPS-09"
```

---

### Task 2: 报名算分分级纯函数

**Files:**
- Create: `platform/src/domain/registration.js`
- Modify: `platform/rules/registration-scoring.json`
- Create: `platform/test/registration-domain.test.js`

**Interfaces:**
- Consumes: `rules.registration`（P0 Task 3 的 `rules/registration-scoring.json`）
- Produces:
  - `scoreRegistration({ answers, config })` → `{ score, dimensionScores, level, accepted, explain }`
    - `answers`: `{ direction: number[5], capability: number[5], collaboration: number[5], open: string }`
    - `dimensionScores`: `{ direction, capability, collaboration }`（每维 5 题的均值）
    - `explain`: `[{ dimension, label, raw, weight, weighted, note }]`（可解释明细）
  - `classifyLevel(score, config)` → `'S' | 'A' | 'B' | 'C'`
  - `validateRegistrationAnswers(answers, config)` → `string[]`（错误信息，空数组 = 通过）
  - ⛔ 纯函数：入参里没有 `now` / `db` / 随机数；时间一律由调用方传入

- [ ] **Step 1: 写失败的测试**

`platform/test/registration-domain.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreRegistration, classifyLevel, validateRegistrationAnswers,
} from '../src/domain/registration.js';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const config = JSON.parse(readFileSync(join(rulesDir, 'registration-scoring.json'), 'utf8'));

// ── 边界样例：每维 5 题，取值 1..5 ──────────────────────────────
// 79 分：方向 [4,4,4,4,3]=19→3.8 ｜能力 [5,5,5,4,4]=23→4.6 ｜协作 [4,4,4,4,4]=20→4.0
//        0.25×3.8 + 0.35×4.6 + 0.40×4.0 = 4.16 → (4.16−1)/4×100 = 79
// 80 分：三维均值皆 4.2（[4,4,4,4,5]=21）→ 4.2 → 80
// 60 分：三维均值皆 3.4（[3,3,3,4,4]=17）→ 3.4 → 60
// 59 分：3.4 / 2.6 / 4.0 → 3.36 → 59
// 40 分：三维均值皆 2.6（[3,2,2,3,3]=13）→ 2.6 → 40
// 39 分：1.6 / 1.6 / 4.0 → 2.56 → 39
const D79 = [4, 4, 4, 4, 3];
const D80 = [4, 4, 4, 4, 5];
const M34 = [3, 3, 3, 4, 4];
const M26 = [3, 2, 2, 3, 3];
const M40 = [4, 4, 4, 4, 4];
const M46 = [5, 5, 5, 4, 4];
const M16 = [2, 2, 2, 1, 1];

function answers(direction, capability, collaboration, open = '占位说明') {
  return { direction, capability, collaboration, open };
}

test('边界 79 分判 A 级（R-REG-07：60–79 → A）', () => {
  const r = scoreRegistration({ answers: answers(D79, M46, M40), config });
  assert.equal(r.score, 79);
  assert.equal(r.level, 'A');
  assert.equal(r.accepted, true);
});

test('边界 80 分判 S 级（R-REG-07：80–100 → S）', () => {
  const r = scoreRegistration({ answers: answers(D80, D80, D80), config });
  assert.equal(r.score, 80);
  assert.equal(r.level, 'S');
});

test('边界 59 分判 B 级（R-REG-07：40–59 → B）', () => {
  const r = scoreRegistration({ answers: answers(M34, M26, M40), config });
  assert.equal(r.score, 59);
  assert.equal(r.level, 'B');
});

test('边界 60 分判 A 级', () => {
  const r = scoreRegistration({ answers: answers(M34, M34, M34), config });
  assert.equal(r.score, 60);
  assert.equal(r.level, 'A');
});

test('边界 39 分判 C 级', () => {
  const r = scoreRegistration({ answers: answers(M16, M16, M40), config });
  assert.equal(r.score, 39);
  assert.equal(r.level, 'C');
});

test('边界 40 分判 B 级', () => {
  const r = scoreRegistration({ answers: answers(M26, M26, M26), config });
  assert.equal(r.score, 40);
  assert.equal(r.level, 'B');
});

test('C 级不接收（R-REG-08）', () => {
  const r = scoreRegistration({ answers: answers(M16, M16, M16), config });
  assert.equal(r.level, 'C');
  assert.equal(r.accepted, false);
  const s = scoreRegistration({ answers: answers(M34, M34, M34), config });
  assert.equal(s.accepted, true);
});

test('维度得分是 5 题均值，并进入 dimensionScores', () => {
  const r = scoreRegistration({ answers: answers(D79, M46, M40), config });
  assert.equal(r.dimensionScores.direction, 3.8);
  assert.equal(r.dimensionScores.capability, 4.6);
  assert.equal(r.dimensionScores.collaboration, 4);
});

test('explain 给出每维 raw / weight / weighted（可解释明细）', () => {
  const r = scoreRegistration({ answers: answers(D79, M46, M40), config });
  assert.equal(r.explain.length, 3);
  const dir = r.explain.find((e) => e.dimension === 'direction');
  assert.equal(dir.raw, 3.8);
  assert.equal(dir.weight, 0.25);
  assert.equal(dir.weighted, 0.95);
  assert.ok(dir.note.includes('方向维度'), 'note 必须说明这一维怎么算的');
  // ⚠️ 父代理预审补充（弱断言 → 强断言）：原来只断言 note 含维度名，
  //    把 note 里的「权重 25%」「加权 0.95」删掉照样全绿 —— 而 note 是
  //    「可解释明细」界面给用户看的**唯一**说明（设计文档 §9 / R-REG-09）。
  //    少了权重，用户看到的「这一维凭什么拿 0.95 分」就无从核对。
  assert.ok(dir.note.includes('权重 25%'), `note 必须写出这一维的权重：${dir.note}`);
  assert.ok(dir.note.includes('加权 0.95'), `note 必须写出这一维的加权分：${dir.note}`);
  assert.ok(dir.note.includes('5 题'), `note 必须写出题数：${dir.note}`);
});

test('classifyLevel 阈值边界与 scoreRegistration 判定一致', () => {
  assert.equal(classifyLevel(79, config), 'A');
  assert.equal(classifyLevel(80, config), 'S');
  assert.equal(classifyLevel(59, config), 'B');
  assert.equal(classifyLevel(60, config), 'A');
  assert.equal(classifyLevel(39, config), 'C');
  assert.equal(classifyLevel(40, config), 'B');
  assert.equal(classifyLevel(0, config), 'C');
  assert.equal(classifyLevel(100, config), 'S');
});

test('validate：三个维度每维必须 5 题', () => {
  const errs = validateRegistrationAnswers(answers([4, 4], M46, M40), config);
  assert.ok(errs.some((e) => e.includes('方向维度') && e.includes('5 道题')), errs.join('；'));
});

test('validate：每题取值必须在 1–5 之间且为整数', () => {
  const errs = validateRegistrationAnswers(answers([4, 4, 4, 4, 9], M46, M40), config);
  assert.ok(errs.some((e) => e.includes('1–5')), errs.join('；'));
  const errs2 = validateRegistrationAnswers(answers([4, 4, 4, 4, 2.5], M46, M40), config);
  assert.ok(errs2.some((e) => e.includes('整数')), errs2.join('；'));
});

test('validate：开放式题必填且有长度上限（R-REG-11）', () => {
  const errs = validateRegistrationAnswers(answers(D80, D80, D80, '   '), config);
  assert.ok(errs.some((e) => e.includes('开放式题')), errs.join('；'));
  const long = 'x'.repeat(config.openQuestion.maxLength + 1);
  const errs2 = validateRegistrationAnswers(answers(D80, D80, D80, long), config);
  assert.ok(errs2.some((e) => e.includes('开放式题')), errs2.join('；'));
});

test('validate：全部合法时返回空数组', () => {
  const errs = validateRegistrationAnswers(answers(D80, D80, D80, '我想解决门店排班问题'), config);
  assert.deepEqual(errs, []);
});

test('权重合计必须为 1（配置自检，防 C-01 类错位）', () => {
  const sum = config.dimensions.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重合计 = ${sum}`);
});

test('问卷题目数与维度数一致（R-REG-11：3 维各 5 题 + 1 开放题）', () => {
  for (const d of config.dimensions) {
    assert.equal(config.questions.dimensionItems[d.key].length, 5, `${d.key} 必须是 5 题`);
  }
  assert.equal(config.questions.status, 'open_question');
  assert.ok(config.questions.openQuestionItem);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/registration-domain.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/registration.js'`

- [ ] **Step 3: 改写 rules/registration-scoring.json**

`platform/rules/registration-scoring.json`（整份替换；**题面是占位**，SABC v1 §六 待补 1 未定，组委会给了正式清单后只改本文件）：

```javascript
{
  "id": "registration",
  "version": "2026-10-24",
  "source": "SABC v1 §二 3 维画像筛选 + §六 待补 1 问卷字段设计",
  "scale": { "min": 1, "max": 5, "scoreMax": 100 },
  "dimensions": [
    { "key": "direction",    "label": "方向维度", "weight": 0.25, "min": 1, "max": 5 },
    { "key": "capability",   "label": "能力维度", "weight": 0.35, "min": 1, "max": 5 },
    { "key": "collaboration","label": "协作维度", "weight": 0.40, "min": 1, "max": 5 }
  ],
  "levels": [
    { "key": "S", "label": "顶级种子", "minScore": 80, "accept": true },
    { "key": "A", "label": "优秀候选", "minScore": 60, "accept": true },
    { "key": "B", "label": "潜力候选", "minScore": 40, "accept": true },
    { "key": "C", "label": "底线外",   "minScore": 0,  "accept": false }
  ],
  "openQuestion": { "required": true, "maxLength": 500 },
  "questions": {
    "status": "open_question",
    "source": "SABC v1 §六 待补 1 —— 3 维各 5 题的具体题目清单尚未确定",
    "note": "⚠️ 以下题面为【占位题面】，首届启用。组委会提供正式清单后只改本文件，不改任何代码。",
    "dimensionItems": {
      "direction": [
        { "id": "d1", "text": "我能清楚说出想解决的商业问题是什么" },
        { "id": "d2", "text": "我了解目标行业真实的业务痛点" },
        { "id": "d3", "text": "我能判断一项 AI 能力是否真的适合我的问题" },
        { "id": "d4", "text": "我的方向与本届任务包的方向匹配" },
        { "id": "d5", "text": "我能说清这个方向上可能的商业化路径" }
      ],
      "capability": [
        { "id": "c1", "text": "我能独立做出可运行的原型" },
        { "id": "c2", "text": "我能把 AI 能力接入真实业务流程" },
        { "id": "c3", "text": "我能评估技术方案的可行性、成本与风险" },
        { "id": "c4", "text": "我能处理数据准备、清洗与接口对接" },
        { "id": "c5", "text": "我能在时间压力下按期交付" }
      ],
      "collaboration": [
        { "id": "l1", "text": "我习惯与他人分工协作推进项目" },
        { "id": "l2", "text": "我会主动补位队友的阻塞点" },
        { "id": "l3", "text": "我能清晰汇报进展与阻塞" },
        { "id": "l4", "text": "我接受队友的方案并能快速调整" },
        { "id": "l5", "text": "我愿意按赛程节奏承诺交付物" }
      ]
    },
    "openQuestionItem": {
      "id": "q_open",
      "text": "请用 100–500 字说明：你最想用 AI 解决的商业问题是什么，以及你打算怎么验证它是否真的有用。",
      "required": true,
      "maxLength": 500
    }
  },
  "funnel": [
    { "key": "registration", "label": "报名筛选", "rate": 0.30 },
    { "key": "incubation",   "label": "孵化",     "rate": 0.30 },
    { "key": "sprint",       "label": "冲刺",     "rate": 0.20 },
    { "key": "demo_day",     "label": "Demo Day", "rate": 0.10 },
    { "key": "coaching",     "label": "辅导期",   "rate": null }
  ],
  "funnelNote": "R-REG-10：5 阶段筛选漏斗。报名筛选 30% → 孵化 30% → 冲刺 20% → Demo Day 10% → 辅导期。P1 只落地第一段，后续阶段由 P2/P3 的实际数据填充。"
}
```

- [ ] **Step 4: 创建 src/domain/registration.js**

```javascript
// src/domain/registration.js — 报名算分分级（纯函数）
// 依据：SABC v1 §二（3 维权重 25/35/40、每维 1–5 分、阈值 80/60/40）
// 依据：SABC v1 §一/§五（C 级不接收、筛选标准对外透明）
// 依据：设计文档 §13（报名分级边界：79/80、59/60、39/40）
// 溯源需求：R-REG-06 / R-REG-07 / R-REG-08 / R-REG-09 / R-REG-11
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。时间由调用方传入。
// ✅ 口径：每维 5 题取【均值】∈ [1,5] → 三维加权求和 ∈ [1,5] → 线性折算到 0–100 → 阈值判级。

// SABC v1 §六 待补 1：3 维各 5 题。配置里若给了题目清单，以配置为准
const DEFAULT_ITEMS_PER_DIM = 5;

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function dimensionItems(config, key) {
  return config.questions?.dimensionItems?.[key] ?? [];
}

/**
 * 总分 → 等级。阈值取自配置（80/60/40），边界为"分数 ≥ 阈值"即进档。
 * 依据：R-REG-07（SABC v1 §二 原文「80-100→S；60-79→A；40-59→B；0-39→C」）
 */
export function classifyLevel(score, config) {
  const levels = [...config.levels].sort((a, b) => b.minScore - a.minScore);
  for (const lv of levels) {
    if (score >= lv.minScore) return lv.key;
  }
  return levels[levels.length - 1].key;
}

/**
 * 校验问卷填写。返回错误信息数组，空数组 = 通过。
 * 依据：R-REG-11（3 维各 5 题 + 1 道开放式题，SABC v1 §六 待补 1）
 */
export function validateRegistrationAnswers(answers, config) {
  const errors = [];
  const a = answers && typeof answers === 'object' ? answers : {};

  for (const dim of config.dimensions) {
    const list = a[dim.key];
    const expected = dimensionItems(config, dim.key).length || DEFAULT_ITEMS_PER_DIM;
    if (!Array.isArray(list)) {
      errors.push(`${dim.label}：必须提交 ${expected} 道题`);
      continue;
    }
    if (list.length !== expected) {
      errors.push(`${dim.label}：必须提交 ${expected} 道题，实际 ${list.length} 道`);
    }
    list.forEach((v, i) => {
      if (!Number.isInteger(v)) {
        errors.push(`${dim.label} 第 ${i + 1} 题：必须为整数`);
      } else if (v < dim.min || v > dim.max) {
        errors.push(`${dim.label} 第 ${i + 1} 题：取值须在 ${dim.min}–${dim.max} 之间`);
      }
    });
  }

  const openCfg = config.openQuestion ?? {};
  const open = a.open;
  if (openCfg.required) {
    if (typeof open !== 'string' || open.trim() === '') {
      errors.push('开放式题：必填');
    } else if (open.length > (openCfg.maxLength ?? 500)) {
      errors.push(`开放式题：不超过 ${openCfg.maxLength ?? 500} 字`);
    }
  }
  return errors;
}

/**
 * 算分 + 判级 + 可解释明细。
 * 依据：R-REG-06（3 维 100 分）、R-REG-07（阈值）、R-REG-08（C 级不接收）
 * 返回的 explain 直接用于「可解释明细」界面（R-REG-09 / 设计文档 §9 报名问卷）
 */
export function scoreRegistration({ answers, config }) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const scaleMin = config.scale?.min ?? 1;
  const scaleMax = config.scale?.max ?? 5;
  const scoreMax = config.scale?.scoreMax ?? 100;

  const dimensionScores = {};
  const explain = [];
  let weighted = 0;

  for (const dim of config.dimensions) {
    const list = Array.isArray(a[dim.key]) ? a[dim.key] : [];
    const raw = list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0;
    const w = raw * dim.weight;
    weighted += w;
    dimensionScores[dim.key] = round(raw, 4);
    explain.push({
      dimension: dim.key,
      label: dim.label,
      raw: round(raw, 4),
      weight: dim.weight,
      weighted: round(w, 4),
      note: `${dim.label} ${list.length} 题均值 ${round(raw, 2)}/${dim.max}，权重 ${round(dim.weight * 100, 0)}%，加权 ${round(w, 4)}`,
    });
  }

  // 线性折算：加权均值 ∈ [scaleMin, scaleMax] → [0, scoreMax]
  const normalized = scaleMax === scaleMin ? 0 : (weighted - scaleMin) / (scaleMax - scaleMin);
  const score = round(normalized * scoreMax, 2);
  const level = classifyLevel(score, config);
  const levelCfg = config.levels.find((l) => l.key === level);

  return {
    score,
    dimensionScores,
    level,
    // R-REG-08：C 级不接收（"某些画像的同学可能就不适合，是要删掉的"）
    accepted: levelCfg ? levelCfg.accept === true : false,
    explain,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/registration-domain.test.js`
Expected: PASS（16 个测试全过：registration-domain 16）
> **条数订正（2026-10-21 父代理验收）**：本行原文写「13 个测试全过」，与代码块里的
> **16 条**不符（多出的 3 条是加强后的 `explain[].note` 断言 + 两条配置自检）。
> 「计划是规格」→ 计划里的条数必须与实现一致，故按实跑改为 16。

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/domain/registration.js rules/registration-scoring.json test/registration-domain.test.js
git commit -m "feat(P1): 报名算分分级纯函数与 SABC 问卷配置

对应需求：R-REG-06 / R-REG-07 / R-REG-08 / R-REG-09 / R-REG-10 / R-REG-11"
```

---

### Task 3: 报名服务与 API

**Files:**
- Modify: `platform/src/errors.js`（**P0 已建**，本阶段**只复用**：核对签名为 status-first，**不重建**）
- Create: `platform/src/services/registration.js`
- Create: `platform/src/http/routes/registration.js`
- Create: `platform/rules/team-formation.json`
- Create: `platform/rules/schedule.json`
- Create: `platform/rules/compliance.json`
- Modify: `platform/src/config.js`（加载并校验 P1 新增的 3 份规则）
- Modify: `platform/src/server.js`
- Create: `platform/test/registration-service.test.js`
- Create: `platform/test/registration-api.test.js`
- Create: `platform/test/config-p1.test.js`

**Interfaces:**
- Consumes: Task 1 仓储、Task 2 `scoreRegistration` / `classifyLevel` / `validateRegistrationAnswers`、P0 `can()` 与 `createSession()`
- Produces:
  - `AppError`（`status` + `code` + `message` + `detail`）、`appError(status, code, message, detail)`
  - `submitRegistration({ db, userId, editionId, answers, now, rules })` → registration
    - ⛔ 幂等：同一 `userId + editionId` 重复提交 → 409 `DUPLICATE_REGISTRATION`，不静默覆盖
  - `getRegistration({ db, id, viewer, rules })` → registration | null（不可见也返回 null → API 404）
  - `listRegistrations({ db, filter, viewer, rules })` → registration[]（无权限 → 空数组 → API 200）
  - `decideRegistration({ db, id, level, decidedBy, note, now, rules })` → registration（写 `registration_events`）
  - API：`POST /api/registrations`｜`GET /api/registrations`｜`GET /api/registrations/:id`｜`POST /api/registrations/:id/level`｜`GET /api/registration-criteria`（公开）
  - 规则命名空间新增：`rules.teamFormation`（组队规则）｜`rules.schedule`（赛段时间轴）｜`rules.compliance`（IP 与合规）
    - ⚠️ 这 3 份文件与 `src/config.js` 的加载/校验**在本 Task 落地**（不是 Task 5）——
      因为 `loadRules()` 一旦加载失败，后面每个用 `loadRules()` 的测试都会连带失败，
      而 Task 3/4/5 的测试都要用 `loadRules()`。Task 5 直接消费它们。

- [ ] **Step 1: 写失败的测试**

`platform/test/registration-service.test.js`：

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
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { listRegistrationEvents } from '../src/db/repo/registrationEvents.js';
import { getRegistration as findRegistrationRow } from '../src/db/repo/registrations.js';
import {
  submitRegistration, getRegistration, listRegistrations, decideRegistration, presentRegistration,
} from '../src/services/registration.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

const NOW = '2026-10-20T12:00:00.000Z';
const GOOD = {
  direction: [4, 4, 4, 4, 5],
  capability: [4, 4, 4, 4, 5],
  collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题',
  consent: { accepted: true, items: ['no_data_export', 'privacy_protection'] },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-reg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const user = createUser(db, { name: '甲', phone: '13900002001', password: 'pw', mbaStatus: 'mba' });
  return { db, close, dataDir, rules, edition, user };
}

test('提交报名：自动算分分级并写入可解释明细', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({
    db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules,
  });
  assert.equal(reg.level, 'S');
  assert.equal(reg.rawScore, 80);
  assert.equal(reg.status, 'submitted');
  assert.equal(reg.grading.explain.length, 3);
  assert.equal(reg.grading.accepted, true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复提交同一 userId + editionId → 409，且原记录不被覆盖', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  assert.throws(
    () => submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules }),
    (err) => err.status === 409 && err.code === 'DUPLICATE_REGISTRATION',
  );
  const list = listRegistrations({ db, filter: { editionId: edition.id }, viewer: { id: user.id, is_superadmin: 1 }, rules });
  assert.equal(list.length, 1, '重复提交不得产生第二条记录');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('问卷不合法 → 400 并给出错误明细', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  assert.throws(
    () => submitRegistration({
      db, userId: user.id, editionId: edition.id,
      answers: { ...GOOD, direction: [4, 4] }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'INVALID_ANSWERS' && err.detail.length > 0,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未同意合规红线 → 400（R-ENT-12 同意记录）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  assert.throws(
    () => submitRegistration({
      db, userId: user.id, editionId: edition.id,
      answers: { ...GOOD, consent: { accepted: false } }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'CONSENT_REQUIRED',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交后写入一条 registration_events（状态机留痕）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].to_status, 'submitted');
  assert.equal(events[0].from_status, null);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('可见性：本人可读，别人的记录读不到（返回 null）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const other = createUser(db, { name: '乙', phone: '13900002002', password: 'pw', mbaStatus: 'mba' });
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  assert.ok(getRegistration({ db, id: reg.id, viewer: user, rules }));
  assert.equal(getRegistration({ db, id: reg.id, viewer: other, rules }), null);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('列表：无组委会权限 → 空数组（对应 API 200 + 空集）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  assert.deepEqual(listRegistrations({ db, filter: { editionId: edition.id }, viewer: user, rules }), []);
  const admin = { id: user.id, is_superadmin: 1, active: 1 };
  assert.equal(listRegistrations({ db, filter: { editionId: edition.id }, viewer: admin, rules }).length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('改级：写 level_final 并追加一条事件（不覆盖历史）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const updated = decideRegistration({
    db, id: reg.id, level: 'B', decidedBy: user.id, note: '委员会复核：能力维证据不足', now: NOW, rules,
  });
  assert.equal(updated.levelFinal, 'B');
  assert.equal(updated.status, 'accepted');
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].from_status, 'submitted');
  assert.equal(events[1].to_status, 'accepted');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('改级为 C 级 → status=rejected（R-REG-08 不接收）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const updated = decideRegistration({ db, id: reg.id, level: 'C', decidedBy: user.id, note: '复核不通过', now: NOW, rules });
  assert.equal(updated.status, 'rejected');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：level 省略时只留痕不改级', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const updated = decideRegistration({ db, id: reg.id, level: null, decidedBy: user.id, note: '我对能力维的打分有补充说明', now: NOW, rules });
  assert.equal(updated.levelFinal, null);
  assert.equal(updated.status, 'appealed');
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events[events.length - 1].to_status, 'appealed');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉不得抹掉委员会的终态裁定（status 保持终态，裁定留在 level_final）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4）：原来申诉**无条件**把 status 改成
  //    'appealed' —— 委员会已裁定 'rejected' 的行被选手申诉一次，终态就从
  //    status 列上消失了（裁定只留在 level_final 与事件流里，按 status 统计的下游会漏人）。
  //    独立评审探针实测：改 C 后 status=rejected → 申诉后 status=appealed。
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  decideRegistration({ db, id: reg.id, level: 'C', decidedBy: user.id, note: '复核不通过', now: NOW, rules });
  const afterDecision = getRegistration({ db, id: reg.id, viewer: user, rules });
  assert.equal(afterDecision.status, 'rejected', '前置：委员会裁定后应是终态');

  const appealed = decideRegistration({
    db, id: reg.id, level: null, decidedBy: user.id, note: '我补充了材料', now: NOW, rules,
  });
  assert.equal(appealed.status, 'rejected', '申诉不得把委员会的终态翻走');
  assert.equal(appealed.levelFinal, 'C', '裁定必须仍在 level_final 上');
  // 申诉本身仍然要留痕（追加式，不覆盖历史）
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events.length, 3);
  assert.equal(events[2].to_status, 'appealed');
  assert.equal(events[2].from_status, 'rejected');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('低分问卷 → C 级且 accepted=false（R-REG-08 C 级不接收）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-1：近似恒绿断言）。
  //    原来唯一的 accepted 断言针对的是一份 **S 级** 报名（accepted 本就为 true），
  //    把实现改成恒 true 照样通过（独立评审变异 V16 实测：199 条仍全绿）。
  //    这条用例断言的是 C 级 —— 真值与硬编码在这里分得开。
  const { db, close, dataDir, rules, edition, user } = setup();
  const low = {
    direction: [1, 1, 1, 1, 1],
    capability: [1, 1, 1, 1, 1],
    collaboration: [1, 1, 1, 1, 1],
    open: '我的方向还在探索中',
    consent: { accepted: true, items: [] },
  };
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: low, now: NOW, rules });
  assert.equal(reg.rawScore, 0);
  assert.equal(reg.level, 'C');
  assert.equal(reg.grading.accepted, false, 'C 级必须不接收');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('grading 是按当前配置重算的；库内快照 level 不随后续改配置而变', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**口径无登记、断言缺失**）。
  //    `level` / `rawScore` 是提交那一刻的快照（存库），`grading` 是按当前配置重算的结果。
  //    改配置后两者不一致是**有意为之**（快照留痕 + 重算可追），但必须写明并钉住。
  const { db, close, dataDir, rules, edition, user } = setup();
  const skewed = {
    ...GOOD,
    direction: [5, 5, 5, 5, 5],
    capability: [1, 1, 1, 1, 1],
    collaboration: [1, 1, 1, 1, 1],
  };
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: skewed, now: NOW, rules });
  assert.equal(reg.level, 'C', '提交时的快照等级');
  assert.equal(reg.rawScore, 25);

  // 换一份权重明显不同的配置重算
  const shifted = {
    ...rules.registration,
    dimensions: rules.registration.dimensions.map((d) => (
      d.key === 'direction' ? { ...d, weight: 0.9 } : { ...d, weight: 0.05 }
    )),
  };
  const row = findRegistrationRow(db, reg.id);
  const recomputed = presentRegistration(row, shifted);
  assert.equal(recomputed.grading.level, 'S', '换配置后重算结果应当变化');
  assert.equal(recomputed.grading.score, 90);
  assert.equal(recomputed.level, 'C', '库内快照不随后配置变');
  assert.equal(recomputed.rawScore, 25);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('非唯一约束的插入失败不得被报成 DUPLICATE_REGISTRATION', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-3：**错误码用错**）。
  //    原来的兜底正则 `/UNIQUE|constraint/i` 连外键失败也一起吞掉
  //    （"FOREIGN KEY constraint failed" 里含 "constraint"）
  //    → 客户端被告知「你已提交过本届报名」，而真实原因是外键失败。
  const { db, close, dataDir, rules, edition } = setup();
  let caught = null;
  try {
    submitRegistration({
      db, userId: 'no-such-user', editionId: edition.id, answers: GOOD, now: NOW, rules,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, '必须抛错');
  assert.notEqual(caught.code, 'DUPLICATE_REGISTRATION', '外键失败不得报成重复报名');
  assert.ok(!/DUPLICATE/.test(String(caught.message)), '错误信息不得提到重复报名');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 列表端点必须带上状态事件轨迹（父代理预审修正 Important）──────────────
// ⚠️ 此前**只有单条** getRegistration 挂 `events`，列表 listRegistrations 不挂 →
//    组委会筛选台读列表 → 事件轨迹一栏恒空（计划声称的功能实际没落地）。
test('listRegistrations：每条报名都带上状态事件轨迹（与单条口径一致）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({
    db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules,
  });
  // 走一次改级 → 追加一条事件（提交事件 + 改级事件 = 2 条）
  decideRegistration({
    db, id: reg.id, level: 'B', decidedBy: user.id, note: '复核降级', now: NOW, rules,
  });

  const viewer = { id: user.id, is_superadmin: 1 };
  const list = listRegistrations({ db, filter: { editionId: edition.id }, viewer, rules });
  assert.equal(list.length, 1);
  assert.ok(Array.isArray(list[0].events), '列表里的每条报名都必须有 events 数组');
  assert.equal(list[0].events.length, 2, '提交 + 改级 = 2 条轨迹');

  // 与单条口径逐字一致
  const single = getRegistration({ db, id: reg.id, viewer, rules });
  assert.deepEqual(list[0].events, single.events, '列表与单条的事件形状必须一致');
  assert.equal(list[0].events[0].toStatus, 'submitted');
  assert.equal(list[0].events[1].toStatus, 'accepted', 'B 级 accept=true → 终态 accepted');
  assert.equal(list[0].events[1].fromStatus, 'submitted');
  assert.equal(list[0].events[1].reason, '复核降级');
});

test('listRegistrations：批量取事件时不得把不同报名的轨迹串在一起', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const other = createUser(db, { name: '乙', phone: '13900002002', password: 'pw', mbaStatus: 'mba' });
  const r1 = submitRegistration({
    db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules,
  });
  const r2 = submitRegistration({
    db, userId: other.id, editionId: edition.id, answers: GOOD, now: NOW, rules,
  });
  decideRegistration({ db, id: r1.id, level: 'A', decidedBy: user.id, now: NOW, rules });

  const list = listRegistrations({
    db, filter: { editionId: edition.id }, viewer: { id: user.id, is_superadmin: 1 }, rules,
  });
  assert.equal(list.length, 2);
  const byId = new Map(list.map((r) => [r.id, r]));
  assert.equal(byId.get(r1.id).events.length, 2, 'r1 有提交 + 改级两条');
  assert.equal(byId.get(r2.id).events.length, 1, 'r2 只有提交一条');
  // r2 的轨迹里不能混进 r1 的改级事件
  assert.ok(
    byId.get(r2.id).events.every((e) => e.id !== byId.get(r1.id).events[1].id),
    '两条报名的轨迹不得串台',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/registration-service.test.js`
Expected: FAIL —— `Cannot find module '../src/services/registration.js'`

- [ ] **Step 3: 核对 src/errors.js（P0 已建，本阶段只复用）**

⚠️ **不重建**。`src/errors.js` 已由 **P0 的 Task 4** 建立（文件归属裁决表：`src/errors.js` 归 **P0**，
P1 / P3 直接复用，P4 只追加快捷函数）。重建会产生两套参数顺序相反的错误构造器 ——
`err.status` 与 `err.code` 互换 → HTTP 层返回错误状态码。

核对签名是否与契约一致（**status-first**）：

```bash
cd platform && node -e "
import('./src/errors.js').then((m) => {
  const e = m.appError(400, 'X', 'msg');
  console.log(e.status, e.code, e.message, e instanceof m.AppError);
});
"
# 期望输出：400 X msg true
```

- [ ] **Step 4: 创建 src/services/registration.js**

```javascript
// src/services/registration.js — 报名服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）+ 设计文档 §10 流 1
// 溯源需求：R-REG-01 / R-REG-06 / R-REG-07 / R-REG-08 / R-REG-09 / R-ENT-12
import { AppError } from '../errors.js';
import {
  scoreRegistration, validateRegistrationAnswers,
} from '../domain/registration.js';
import {
  insertRegistration, getRegistration as findRegistrationRow,
  findActiveRegistration, listRegistrationRows, updateRegistrationRow,
} from '../db/repo/registrations.js';
import {
  insertRegistrationEvent, listRegistrationEvents, listRegistrationEventsForRegistrations,
} from '../db/repo/registrationEvents.js';
import { getEdition } from '../db/repo/editions.js';
import { can } from '../auth/permissions.js';

function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * DB 行 → 前端视图。grading 由配置重算（纯函数，可复算），
 * 不额外存一份 explain —— 换配置后重算即得新口径，不留陈旧快照。
 *
 * ⚠️ 口径登记（2026-10-21 独立评审 Minor M-2：**同一响应里两个等级可能不同，这是有意的**）：
 *   - `level` / `rawScore`：**报名提交那一刻**按当时配置算出的**快照**（存库，不可变）
 *   - `grading.level` / `grading.score`：**按当前配置重算**的结果（不存库）
 *   - `levelFinal`：**组委会的裁定**（改级后写 `level_final`，只有组委会能改）
 *   改了 `rules/registration-scoring.json` 的权重或阈值后，重读同一条报名会看到
 *   `level`（旧快照）与 `grading.level`（新口径）不一致 —— 这**不是 bug**，而是
 *   「评分可复算、裁定不可篡改」两条原则的必然结果：
 *   - 快照留痕：事后复算能对上当时的判分依据
 *   - 重算可追：换配置后能立刻看到「按新口径这个人会是几级」
 *   列表的 `level` 过滤走**库内快照**（`src/db/repo/registrations.js`），
 *   与 `grading` 不同源 —— 客户端按等级筛选时以快照为准。
 */
export function presentRegistration(row, config) {
  if (!row) return null;
  const answers = parseJson(row.answers_json, {});
  const graded = scoreRegistration({ answers, config });
  return {
    id: row.id,
    editionId: row.edition_id,
    userId: row.user_id,
    level: row.level,
    levelFinal: row.level_final,
    status: row.status,
    rawScore: row.raw_score,
    dimensionScores: parseJson(row.dimension_scores_json, {}),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    // 可解释明细（R-REG-09 筛选标准透明 + 设计文档 §9 报名问卷）
    grading: {
      score: graded.score,
      level: graded.level,
      accepted: graded.accepted,
      explain: graded.explain,
    },
    // 开放式题与同意记录：只对本人与组委会可见
    answers: { open: answers.open ?? null, consent: answers.consent ?? null },
  };
}

export function submitRegistration({
  db, userId, editionId, answers, now = new Date().toISOString(), rules,
}) {
  const config = rules.registration;
  if (!getEdition(db, editionId)) {
    throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
  }

  // R-ENT-12：合规红线与同意记录 —— 未明确同意不收
  const consentCfg = rules.compliance?.consent ?? {};
  if (consentCfg.required && answers?.consent?.accepted !== true) {
    throw new AppError(400, 'CONSENT_REQUIRED', '必须同意参赛协议、IP 归属说明与数据合规红线');
  }

  const errors = validateRegistrationAnswers(answers, config);
  if (errors.length) {
    throw new AppError(400, 'INVALID_ANSWERS', '报名问卷填写不完整', errors);
  }

  // 幂等：同一 userId + editionId 重复提交 → 409，不静默覆盖（INTERFACES.md §2）
  if (findActiveRegistration(db, userId, editionId)) {
    throw new AppError(409, 'DUPLICATE_REGISTRATION', '你已提交过本届报名，不能重复提交');
  }

  const grading = scoreRegistration({ answers, config });
  const payload = {
    ...answers,
    consent: { ...(answers.consent ?? {}), acceptedAt: now },
  };

  let row;
  try {
    row = insertRegistration(db, {
      editionId,
      userId,
      answers: payload,
      dimensionScores: grading.dimensionScores,
      rawScore: grading.score,
      level: grading.level,
      status: 'submitted',
      now,
    });
  } catch (err) {
    // 并发下由数据库唯一索引兜底 → 同样 409，绝不静默覆盖
    //
    // ⚠️ 2026-10-21 独立评审修正（Minor M-3，错误码用错）：原来用 `/UNIQUE|constraint/i`
    //    —— 这条正则**连外键失败也一起吞掉**（"FOREIGN KEY constraint failed" 里有
    //    "constraint"）。后果：user_id 指向不存在的用户（外键失败）会被报成
    //    409 DUPLICATE_REGISTRATION「你已提交过本届报名」—— 客户端被告知一个
    //    完全错误的原因（独立评审探针实测复现）。
    //    收紧为**只认 registrations 的唯一索引**：
    //    实测原文 = "UNIQUE constraint failed: registrations.user_id, registrations.edition_id"
    if (/UNIQUE constraint failed: registrations\./i.test(String(err.message))) {
      throw new AppError(409, 'DUPLICATE_REGISTRATION', '你已提交过本届报名，不能重复提交');
    }
    throw err;
  }

  insertRegistrationEvent(db, {
    registrationId: row.id,
    fromStatus: null,
    toStatus: 'submitted',
    actorId: userId,
    reason: `报名提交，系统自动算分 ${grading.score} 分，判为 ${grading.level} 级`,
    now,
  });

  return presentRegistration(row, config);
}

/**
 * 报名状态事件 → 对外形状。
 * 单条（getRegistration）与列表（listRegistrations）**共用**这一个映射：
 * 两套口径迟早漂移（列表漏字段、字段名不一致），而筛选台读的是列表。
 */
export function presentRegistrationEvent(e) {
  return {
    id: e.id,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    actorId: e.actor_id,
    reason: e.reason,
    createdAt: e.created_at,
  };
}

export function getRegistration({ db, id, viewer, rules }) {
  const row = findRegistrationRow(db, id);
  if (!row) return null;
  // 可见性在 API 层过滤（设计文档 §6.6 / §7.3）：本人或组委会（registration:review）
  const isOwner = viewer && viewer.id === row.user_id;
  const isCommittee = viewer
    && can(viewer, 'registration:review', { scopeType: 'edition', scopeId: row.edition_id }, db);
  if (!isOwner && !isCommittee) return null;

  const out = presentRegistration(row, rules.registration);
  out.events = listRegistrationEvents(db, id).map(presentRegistrationEvent);
  return out;
}

export function listRegistrations({ db, filter = {}, viewer, rules }) {
  // 列表权限不满足 → 空数组（API 层返回 200 + 空集，不暴露"有但不给看"）
  const ok = viewer
    && can(viewer, 'registration:review', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  if (!ok) return [];
  const rows = listRegistrationRows(db, filter);
  const items = rows.map((row) => presentRegistration(row, rules.registration));
  // ⚠️ P1 Task 6 修正（Important，列表端点的轨迹恒空）：
  //    此前只有**单条** getRegistration 才挂 `events`，列表不带 →
  //    组委会筛选台（读列表）的事件轨迹一栏恒空 —— 计划声称的功能实际没落地。
  //    现在批量挂上：**一次 SQL**，不新增往返。
  //    事件行的对外形状与单条口径**逐字一致**（同一个映射函数，避免两套口径）。
  const grouped = listRegistrationEventsForRegistrations(db, rows.map((r) => r.id));
  for (const item of items) {
    item.events = (grouped.get(item.id) ?? []).map(presentRegistrationEvent);
  }
  return items;
}

/**
 * 复核 / 申诉 / 改级。
 * level 非空 → 改级（level_final），status 落到 accepted / rejected；
 * level 为空 → 视为选手申诉，只写事件不改级。
 * 每次都追加 registration_events（追加式，历史不覆盖）。
 */
export function decideRegistration({
  db, id, level, decidedBy, note = null, now = new Date().toISOString(), rules,
}) {
  const row = findRegistrationRow(db, id);
  if (!row) throw new AppError(404, 'REGISTRATION_NOT_FOUND', '报名记录不存在');
  const config = rules.registration;

  if (level === undefined || level === null || level === '') {
    insertRegistrationEvent(db, {
      registrationId: id,
      fromStatus: row.status,
      toStatus: 'appealed',
      actorId: decidedBy,
      reason: note ?? '选手申诉',
      now,
    });
    // ⚠️ 2026-10-21 独立评审修正（Minor M-4，**申诉不得抹掉委员会的终态裁定**）：
    //    原来无条件把 status 改成 'appealed' —— 委员会已裁定 'accepted' / 'rejected'
    //    的行，被选手申诉一次就把 status 从终态翻走（裁定只留在 level_final 与事件流里，
    //    按 status 统计/放行的下游会漏掉这个人）。
    //    独立评审探针实测：
    //      B1 委员会改 C 后: status=rejected  levelFinal=C
    //      B2 选手申诉后  : status=appealed  levelFinal=C   ← 终态被抹
    //    现在：**只有尚无终态的行**才把 status 标成 'appealed'（表示「有申诉待处理」）；
    //    已有终态的行保持 status 不变，申诉只进事件流 —— 终态裁定不可被选手改写。
    const patch = {};
    if (!['accepted', 'rejected'].includes(row.status)) patch.status = 'appealed';
    const updated = updateRegistrationRow(db, id, patch);
    return presentRegistration(updated, config);
  }

  const levelCfg = config.levels.find((l) => l.key === level);
  if (!levelCfg) {
    throw new AppError(
      400, 'INVALID_LEVEL',
      `等级必须是 ${config.levels.map((l) => l.key).join(' / ')}`,
    );
  }
  const toStatus = levelCfg.accept ? 'accepted' : 'rejected';
  const updated = updateRegistrationRow(db, id, {
    level_final: level,
    decided_by: decidedBy,
    decided_at: now,
    decision_note: note,
    status: toStatus,
  });
  insertRegistrationEvent(db, {
    registrationId: id,
    fromStatus: row.status,
    toStatus,
    actorId: decidedBy,
    reason: note ?? `复核改级为 ${level}`,
    now,
  });
  return presentRegistration(updated, config);
}
```

- [ ] **Step 5: 创建 src/http/routes/registration.js**

```javascript
// src/http/routes/registration.js — 报名端点
// 依据：INTERFACES.md §2「API（P1）」+ 设计文档 §8
// 三态状态码（设计文档 §7.3）：列表不满足 → 200+空集；单条不满足 → 404；禁用 → 403
import { AppError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import { getRegistration as findRegistrationRow } from '../../db/repo/registrations.js';
import { listEditions } from '../../db/repo/editions.js';
import {
  submitRegistration, getRegistration, listRegistrations, decideRegistration,
} from '../../services/registration.js';

export function registerRegistrationRoutes({ router, db, rules }) {
  // 报名筛选标准对外透明（R-REG-09）：公开可读，不需要登录
  router.add('GET', '/api/registration-criteria', async () => buildCriteria(rules, db));

  router.add('POST', '/api/registrations', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const { editionId, answers } = body ?? {};
    if (!editionId) throw new AppError(400, 'MISSING_EDITION_ID', '缺少届期');
    // ⚠️ 2026-10-21 验收修正（规格缺陷）：`registration:write` 这个能力点被注册、
    //    被授予（seed 里给了 captain / member，测试里也显式授予），
    //    但**路由从不校验它** → 能力点形同虚设，违反全局约束
    //    「权限模型 = capability + assignment，`can()` 是唯一判定入口」。
    //    已登录但没有该能力 → 403（三态：禁用 → 403；不是 404，资源不存在才用 404）。
    //
    // ⚠️ 2026-10-21 独立评审修正（Minor M-6）：能力点校验**要带 edition 作用域**。
    //    原来传 `ctx = null` —— `can()` 遇到 `ctx === null` 时**跳过**资源级授权的
    //    scope 匹配 → 只有 `scope_type='global'` 的授权能通过，
    //    委员会若用 `scope_type='edition'` 授予 `registration:write`，该用户**无法报名**
    //    （独立评审探针实测：global 授权 can(null ctx)=true / edition 授权 can(null ctx)=false /
    //    edition 授权 can(edition ctx)=true）。
    //    现在把已经解析出来的 editionId 传进去，作用域授权与全局授权都能认。
    if (!can(user, 'registration:write', { scopeType: 'edition', scopeId: editionId }, db)) {
      throw new AppError(403, 'FORBIDDEN', '你没有提交报名的权限');
    }
    return submitRegistration({ db, userId: user.id, editionId, answers, rules });
  });

  router.add('GET', '/api/registrations', async ({ user, query }) => {
    // 无组委会权限 → 200 + 空集
    const items = listRegistrations({
      db,
      filter: { editionId: query.editionId, status: query.status, level: query.level },
      viewer: user,
      rules,
    });
    return { items };
  });

  router.add('GET', '/api/registrations/:id', async ({ user, params }) => {
    const reg = getRegistration({ db, id: params.id, viewer: user, rules });
    if (!reg) throw new AppError(404, 'NOT_FOUND', '报名记录不存在');
    return reg;
  });

  router.add('POST', '/api/registrations/:id/level', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const row = findRegistrationRow(db, params.id);
    if (!row) throw new AppError(404, 'NOT_FOUND', '报名记录不存在');

    const isOwner = row.user_id === user.id;
    const isCommittee = can(
      user, 'registration:review', { scopeType: 'edition', scopeId: row.edition_id }, db,
    );
    if (!isOwner && !isCommittee) throw new AppError(404, 'NOT_FOUND', '报名记录不存在');

    const level = body?.level ?? null;
    // 选手只能申诉（不改级）；改级是组委会的能力
    if (isOwner && !isCommittee && level) {
      throw new AppError(403, 'FORBIDDEN', '改级由组委会执行，你只能提交申诉');
    }
    return decideRegistration({
      db, id: params.id, level, decidedBy: user.id, note: body?.note ?? null, rules,
    });
  });
}

// 对外的筛选标准：权重、量表、阈值、题目、漏斗、合规与赛程，全部公开
function buildCriteria(rules, db) {
  const reg = rules.registration;
  const comp = rules.compliance ?? {};
  // 当届届期一并返回：前端据此提交报名 / 建队，省掉一个契约外的端点
  // ⚠️ 2026-10-21 独立评审修正（Minor M-9）：取**当届**，不是「最早的一届」。
  //    listEditions 按 starts_at 排序 → [0] 永远是历史最早的那届；
  //    多届期场景下前端拿到的 editionId 不是当前届 → 报名页会引导用户报错届期
  //    （独立评审探针实测：多届期时返回的是历史届期）。
  //    判据：**尚未结束**（ends_at >= 今天）的最早一届；都没有就退回最后一届。
  const edition = db ? pickCurrentEdition(listEditions(db)) : null;
  return {
    editionId: edition?.id ?? null,
    editionName: edition?.name ?? null,
    scale: reg.scale,
    dimensions: reg.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      weight: d.weight,
      min: d.min,
      max: d.max,
      items: (reg.questions?.dimensionItems?.[d.key] ?? []).map((it) => ({ id: it.id, text: it.text })),
    })),
    openQuestion: {
      ...reg.openQuestion,
      prompt: reg.questions?.openQuestionItem?.text ?? '',
    },
    levels: reg.levels.map((l) => ({
      key: l.key, label: l.label, minScore: l.minScore, accept: l.accept,
    })),
    // R-REG-10：5 阶段筛选漏斗
    funnel: reg.funnel ?? [],
    funnelNote: reg.funnelNote ?? '',
    // R-ENT-11 / R-ENT-12：IP 归属与合规红线在报名页明示
    ipOwnership: comp.ipOwnership ?? {},
    redLines: comp.redLines ?? [],
    consent: comp.consent ?? {},
    // R-STG-01：赛段时间轴
    schedule: rules.schedule?.stages ?? [],
  };
}

/**
 * 挑「当届」：尚未结束（ends_at >= 今天）的最早一届；都没有就退回最后一届。
 * 单独导出便于直接测边界（与 domainCode / isSameFile 同款：纯函数一律导出）。
 *
 * ⚠️ `today` 可注入：默认取真实日期，但**测试必须能钉住「今天」**，
 *    否则「哪一届是当届」这条断言会随日历漂移变成 flaky。
 */
export function pickCurrentEdition(editions, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(editions) || editions.length === 0) return null;
  return editions.find((e) => String(e.ends_at) >= today) ?? editions[editions.length - 1];
}
```

- [ ] **Step 6: 修改 src/server.js**

`platform/src/server.js` 追加三处改动：

```javascript
// ① 顶部 import 追加
import { registerRegistrationRoutes } from './http/routes/registration.js';

// ② createApp 内、router 创建之后追加（注册 P1 报名端点）
  registerRegistrationRoutes({ router, db, rules });

// ③ 错误响应把 detail 一起带出去（否则前端看不到问卷缺哪几题）
//    ⚠️ **必须沿用 P0 终审（Important I-C）的 AppError-only 规则**：
//    P0 现在的错误分支是 `const message = err instanceof AppError ? err.message : '请求无效';`
//    然后 `error(res, status, code, message)` —— 裸 Error / Node 内置错误 / SQLite 错误的
//    message 里含内部原文（表名列名、SQL 参数位置、文件路径），一律回落为通用文案。
//    本片段**不得**改回 `err.message`（那会把 I-C 的修复回退掉，等于重新引入 SQLite 原文泄漏）。
//    detail 同理：detail 可能含表名 → **只透传 AppError 的 detail**。
        error(res, status, code, message, err instanceof AppError ? err.detail : undefined);
```

> **【2026-10-21 父代理验收修正（规格缺陷）】** P0 的 `validateRules()` 里，version 全等校验是
> **硬编码的 9 项列表**（`rules.scoring.initial.version` … `rules.milestones.version`）。
> P1 加了 `teamFormation` / `schedule` / `compliance` 三份配置之后 ——
> **这三份的 version 漂移根本不会被发现**，校验对新增配置形同虚设
> （实跑：把 `teamFormation.version` 改成 `2099-01-01`，`validateRules` 零报错）。
> 这与 P2–P6 漂移审计的 **I-2** 是同一条问题。
> **修法**：`validateRules(rules, expectedCount = null)` —— 把配置对象**自动派生**出来
> （「有 `id` 的是一份配置，没 `id` 的是命名空间」，如 `scoring = { initial, final }`），
> 加多少份配置都自动覆盖；`expectedCount` 由 `loadRules()` 传 `Object.keys(FILES).length`，
> 用于发现「整份配置没被识别到」。**用 `id` 而不是 `version` 做识别**：
> 一份配置**缺了 version** 时仍要被认出来，否则它会被当成命名空间 → 「缺少 version」这条检查反而失效。
>
> **⚠️ 为什么新增配置不写进 P0 的 `test/config.test.js`**：那个文件是 **P0 建立**的，
> 条数已在 P0 计划里声明（23 条）。往里加用例会让 P0 计划的条数声明当场过期
> → 跨阶段的同一条纪律是「计划声明的条数 == 实跑条数」，改一处要改两处。
> P1 自己新增配置的断言放在 **P1 自己的文件** `test/config-p1.test.js`（4 条）→
> **P0 的文件不加用例**。
>
> **⚠️ 2026-10-21 独立评审修正（M-7：原来说法「一字不动」与实现不符）**：
> P1 分支里 `platform/test/config.test.js` 的**措辞**被订正过 3 处
> （「9 份」→「全部规则配置」三处测试名与一条注释）——
> P1 加了 3 份配置后，「9 份」这个数字已经过期，属于事实性错误。
> **条数（23）与断言一字未动**，只是把随配置份数会过期的措辞改成版本无关的说法。
>
> **为什么 P0 计划的代码块不跟着改**：P0 计划是 **P0 阶段的历史规格**，
> 必须与 main / `feat/p0-foundation` 保持**同一份**（P0 阶段确实是 9 份配置，那三条表述在当时准确无误）。
> 本分支把 P0 计划改一份，等于让同一个历史文档在不同分支有两副面孔 ——
> 合并 P1 回 main 时还要再解一次冲突。
> 跨阶段的纪律靠**变更登记**兜住，不靠改历史规格：
> 本计划已逐条登记 P1 对 P0 文件的修改（`test/migrate.test.js` 见 Task 1 Files 段；
> `test/config.test.js` 的措辞订正见上）。
> 用「P0 计划的代码块 ↔ 实现」这条一致性检查时，**基准只能是 P0 worktree** ——
> 拿 P0 计划去比一棵更晚的树，天然会看到 P1 声明过的那些差异。
>

- [ ] **Step 7: 创建 P1 新增的 3 份规则配置并扩展 src/config.js**

> ⚠️ 放在本 Task 而不是 Task 5：`loadRules()` 会一次性加载 `rules/` 下全部文件。
> 只要有一份缺失，**后面所有用 `loadRules()` 的测试都会连带失败**（Task 3/4/5/7 的测试都要用）。
> 因此「新增规则文件 + 配置加载与校验」必须先于任何消费它们的测试落地。

`platform/rules/team-formation.json`（**内容逐字取自 INTERFACES.md §2，不得改动**）：

```javascript
{
  "id": "team-formation",
  "version": "2026-10-24",
  "source": "任务书 §六 组队规则 + 顶层文档 §3.1",
  "teamSize": { "min": 2, "max": 5 },
  "captainMustBeMba": true,
  "teamsPerPackage": { "min": 2, "max": 3 },
  "packageQuotaMix": { "enterprise": 0.70, "free": 0.30 },
  "memberChange": { "allowedDuringStage": true, "requireCaptainOrAdmin": true },
  "singleMemberTriggersMerge": true,
  "singleMemberMergeDeadlineDays": 3
}
```

`platform/rules/schedule.json`：

```javascript
{
  "id": "schedule",
  "version": "2026-10-24",
  "source": "任务书 2.0 §六 赛段表（R-STG-01）",
  "note": "日期为赛段相对日序（月-日）；落到具体日历日期由 edition.starts_at 偏移。",
  "stages": [
    { "key": "S1", "name": "调研", "start": "10-01", "end": "10-10",
      "deliverables": ["企业问题确认书", "数据可得性说明"] },
    { "key": "S2", "name": "任务", "start": "10-10", "end": "10-13",
      "deliverables": ["任务清单", "里程碑清单确认"] },
    { "key": "S3", "name": "开发", "start": "10-13", "end": "10-25",
      "deliverables": ["可运行原型", "版本记录与代码仓"] },
    { "key": "S4", "name": "路演", "start": "10-26", "end": "10-28",
      "deliverables": ["路演材料", "演示 Demo"] },
    { "key": "S5", "name": "落地", "start": "10-29", "end": "10-31",
      "deliverables": ["试点或意向确认", "成果归属确认"],
      "hardRequirement": false,
      "note": "R-STG-05：任务书 §六「由于时间关系，商业验证赛段不做要求，以甲方投决积分为主」→ S5 不做硬性交付要求" }
  ],
  "advancement": {
    "rate": 0.25,
    "finalTopN": 32,
    "source": "R-OPS-10：顶层文档 §3.1 S11「入围率 25%（对标 CICC 24%、浙大站 26%）；决赛 TOP32」"
  }
}
```

`platform/rules/compliance.json`：

```javascript
{
  "id": "compliance",
  "version": "2026-10-24",
  "source": "顶层文档 §3.1 S9（R-ENT-11 IP 与成果归属）+ §3.1 S15 与 §3.9（R-ENT-12 合规红线与同意记录）",
  "ipOwnership": {
    "team": "团队保留全部知识产权",
    "committee": "组委会仅享有非商业性的展示与宣传权",
    "enterprise": "企业享有成果优先对接洽谈权（不自动获得知识产权）"
  },
  "redLines": [
    { "key": "no_data_export", "label": "数据出境：未经授权不得将参赛数据传出中国境内" },
    { "key": "privacy_protection", "label": "隐私保护：涉及个人信息须取得授权并脱敏" },
    { "key": "ai_generated_content", "label": "AI 生成内容：须标注来源与生成方式" },
    { "key": "ip_no_infringement", "label": "知识产权：不得使用未授权的第三方成果" },
    { "key": "identity_real", "label": "参赛者身份：报名信息须真实，冒名参赛取消资格" }
  ],
  "consent": {
    "required": true,
    "prompt": "我已阅读并同意《参赛协议》《IP 与成果归属说明》《数据与隐私合规红线》",
    "enterprisePrompt": "我确认本任务卡不涉及未授权数据出境，且我方已指定唯一责任人"
  }
}
```

`platform/src/config.js` 三处改动：

```javascript

// ④ version 全等校验改为**自动派生**（2026-10-21 父代理验收修正：
//    原实现把 version 校验硬编码成 9 项 → P1 新增的 3 份配置漂移不会被发现，
//    与 P2–P6 漂移审计的 I-2 同一条）。改为按「有 id 的是一份配置」摊平收集，
//    加多少份配置都自动覆盖；expectedCount 由 loadRules 传 Object.keys(FILES).length。
// ① FILES 追加三项
  teamFormation: 'team-formation.json',
  schedule: 'schedule.json',
  compliance: 'compliance.json',

// ② grouped 追加三项
    teamFormation: rules.teamFormation,
    schedule: rules.schedule,
    compliance: rules.compliance,

// ③ validateRules 追加 P1 校验块（fail-fast：已定硬门槛被改坏就拒绝启动）
  // ── 组队规则（R-REG-02 / R-REG-04 / R-REG-05 已定，不可被配置改掉）──
  const tf = rules.teamFormation;
  if (!tf) {
    errors.push('teamFormation 缺失');
  } else {
    if (!(tf.teamSize?.min >= 2)) {
      errors.push('teamFormation.teamSize.min 必须 ≥ 2（R-REG-02 已定：不接受 1 人组队）');
    }
    if (tf.teamSize?.max < tf.teamSize?.min) {
      errors.push('teamFormation.teamSize.max 必须 ≥ min');
    }
    if (tf.captainMustBeMba !== true) {
      errors.push('teamFormation.captainMustBeMba 必须为 true（R-REG-05 已定：组长必须一堂 MBA 在籍）');
    }
    if (!(tf.teamsPerPackage?.min >= 1) || tf.teamsPerPackage?.max < tf.teamsPerPackage?.min) {
      errors.push('teamFormation.teamsPerPackage 必须满足 1 ≤ min ≤ max（R-REG-01：每任务包 2–3 队）');
    }
    const mixSum = (tf.packageQuotaMix?.enterprise ?? 0) + (tf.packageQuotaMix?.free ?? 0);
    if (Math.abs(mixSum - 1) > 1e-9) {
      errors.push(`teamFormation.packageQuotaMix 合计 = ${mixSum.toFixed(4)}，必须等于 1`);
    }
    if (tf.singleMemberTriggersMerge !== true) {
      errors.push('teamFormation.singleMemberTriggersMerge 必须为 true（R-REG-04 已定）');
    }
    if (!(tf.singleMemberMergeDeadlineDays > 0)) {
      errors.push('teamFormation.singleMemberMergeDeadlineDays 必须为正整数');
    }
  }

  // ── 赛程时间轴（R-STG-01）──
  const stages = rules.schedule?.stages;
  if (!Array.isArray(stages) || stages.length !== 5) {
    errors.push('schedule.stages 必须是 5 个赛段（R-STG-01）');
  } else {
    // ⚠️ 父代理预审修正（规格自相矛盾，原实现会让服务器**拒绝启动**）：
    //    原来判 `stages[i].start <= stages[i - 1].end`（要求严格递增），
    //    但 R-STG-01 的赛段表本身就是**交接式相接**的：
    //      S1 调研 10/1-10/10 → S2 任务 10/10-13 → S3 开发 10/13-25
    //      → S4 路演 10/26-28 → S5 落地 10/29-31
    //    （见 docs/requirements-traceability.md 的 R-STG-01 一行）
    //    上一段的**结束当天就是下一段的开始日** → `start == 上一段 end` 恒成立
    //    → 原规则会让计划自带的 schedule.json 校验失败 → **fail-fast 拒绝启动**
    //    → P1 一上线就是死的。父代理预审实跑复现：18 条用例全红，
    //    报错「schedule.stages 必须按时间递增（第 3 段）」。
    //    正确的判据是**不许重叠**（`start < 上一段 end`），相接是合法的；
    //    同时补一条「本段 end 不得早于本段 start」。
    for (let i = 1; i < stages.length; i += 1) {
      if (stages[i].start < stages[i - 1].end) {
        errors.push(`schedule.stages 第 ${i + 1} 段与上一段时间重叠（R-STG-01）`);
      }
    }
    for (const st of stages) {
      if (st.end < st.start) {
        errors.push(`schedule.stages ${st.key} 的结束日早于开始日`);
      }
    }
  }

  // ── 合规与 IP（R-ENT-11 / R-ENT-12）──
  if (!rules.compliance?.redLines?.length) {
    errors.push('compliance.redLines 不得为空（R-ENT-12 合规红线）');
  }
  if (!rules.compliance?.ipOwnership?.team) {
    errors.push('compliance.ipOwnership.team 缺失（R-ENT-11 团队保留 IP）');
  }

  // ── 报名问卷（R-REG-11）──
  const q = rules.registration?.questions;
  if (!q?.dimensionItems) {
    errors.push('registration.questions.dimensionItems 缺失（R-REG-11）');
  } else {
    for (const d of rules.registration.dimensions) {
      const items = q.dimensionItems[d.key] ?? [];
      if (items.length !== 5) {
        errors.push(`registration.questions.dimensionItems.${d.key} 必须是 5 题（SABC v1 §六：3 维各 5 题）`);
      }
    }
  }
  const funnel = rules.registration?.funnel;
  if (!Array.isArray(funnel) || funnel.length !== 5) {
    errors.push('registration.funnel 必须是 5 阶段（R-REG-10）');
  } else {
    for (let i = 1; i < funnel.length; i += 1) {
      const prev = funnel[i - 1].rate;
      const cur = funnel[i].rate;
      if (prev !== null && cur !== null && cur > prev) {
        errors.push(`registration.funnel 必须逐级收窄（第 ${i + 1} 段）`);
      }
    }
  }

  // ── 任务卡配比（R-ENT-09）──
  const tm = rules.solvability?.taskMix;
  if (tm) {
    const sum = (tm.enterprise ?? 0) + (tm.free ?? 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errors.push(`solvability.taskMix 合计 = ${sum.toFixed(4)}，必须等于 1（R-ENT-09：70% B 端 + 30% 自由）`);
    }
    const splitSum = Object.values(tm.enterpriseGradeSplit ?? {}).reduce((a, b) => a + b, 0);
    if (Object.keys(tm.enterpriseGradeSplit ?? {}).length && Math.abs(splitSum - (tm.enterprise ?? 0)) > 1e-9) {
      errors.push(`solvability.taskMix.enterpriseGradeSplit 合计 = ${splitSum.toFixed(4)}，必须等于 enterprise = ${tm.enterprise}`);
    }
  }

  // ④ validateRules 追加 solvability.vetoes 校验（Task 4 独立评审修正 M-2）
  //    位置：solvability 段内、**紧跟 grades 校验之后**（复用已有的 `const sol` 变量，不要重复声明）
    // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**vetoes 完全没有校验**）：
    //    原来这里只校验 dimensions 与 grades，`solvability.vetoes` 一个字都没查 ——
    //    否决项写成空数组、或两条同名、或 `auto.dimension` 指向一个不存在的维度，
    //    全都能通过校验、直到算分时才出问题（或者干脆**静默失效**）。
    //    现在校验：非空、key 唯一、label 非空、`auto` 的形状与指向的维度存在。
    if (!Array.isArray(sol?.vetoes) || sol.vetoes.length === 0) {
      push('solvability.vetoes 缺失或为空（R-ENT-07 三条一票否决）');
    } else if (hasBadItem(sol.vetoes)) {
      push('solvability.vetoes 含非对象元素');
    } else if (hasDuplicateKeys(sol.vetoes)) {
      push('solvability.vetoes 存在重复 key');
    } else {
      const dimensionKeys = new Set((sol.dimensions ?? []).map((d) => d.key));
      for (const v of sol.vetoes) {
        if (typeof v.label !== 'string' || !v.label) {
          push(`solvability.vetoes ${v.key} 缺少 label`);
        }
        if (v.auto === undefined || v.auto === null) continue;
        if (typeof v.auto !== 'object' || typeof v.auto.dimension !== 'string'
          || typeof v.auto.equals !== 'number') {
          push(`solvability.vetoes ${v.key} 的 auto 必须是 { dimension: string, equals: number }`);
        } else if (dimensionKeys.size && !dimensionKeys.has(v.auto.dimension)) {
          push(`solvability.vetoes ${v.key} 的 auto.dimension 引用了不存在的维度 ${v.auto.dimension}`);
        }
      }
    }
  
```

> ⚠️ P0 的 `validateRules` 里已有一处 `const sol = rules.solvability;` —— 追加本段时**复用同一个 `sol` 变量**，
> 不要重复声明 `const sol`（否则 `const` 重复声明会直接语法报错）。上面这段用的是 `rules.solvability?.taskMix`，不冲突。

- [ ] **Step 8: 创建 test/registration-api.test.js**

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
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { pickCurrentEdition } from '../src/http/routes/registration.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

const GOOD = {
  direction: [4, 4, 4, 4, 5],
  capability: [4, 4, 4, 4, 5],
  collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题',
  consent: { accepted: true, items: [] },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-regapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31',
  });
  const user = createUser(db, { name: '选手甲', phone: '13900003001', password: 'pw', mbaStatus: 'mba' });
  const other = createUser(db, { name: '选手乙', phone: '13900003002', password: 'pw', mbaStatus: 'mba' });
  const admin = createUser(db, { name: '组委会', phone: '13900003003', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 用 P0 的仓储函数，不写裸 SQL（SQL 边界：SQL 只允许出现在 src/db/repo/）。
  //    验收修正：原来这里写的是 db.prepare('UPDATE users SET is_superadmin = 1 ...')，
  //    而本文件自己的注释又声称「不写裸 SQL」—— 自相矛盾。
  setSuperadmin(db, admin.id);
  // 「有账号但没有 registration:write 能力」的用户 —— 用来验证能力点真的被校验。
  const outsider = createUser(db, { name: '无权限者', phone: '13900003004', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 父代理预审修正（规格缺口）：**能力点必须先注册**。
  //    `grantAssignment` 会先校验 capability 是否在 `capabilities` 表里注册过
  //    （P0 的评审修正 I5 同类：入参要先校验，不把 SQLite 原文漏到 HTTP 层），
  //    不注册就抛 400 CAPABILITY_UNKNOWN —— 父代理预审实跑：9 条用例全红，
  //    报错「能力点未注册：registration:write」。
  //    这里用 P0 的仓储函数注册（**不写裸 SQL**，守住 SQL 边界）。
  insertCapability(db, 'registration:write', '提交报名');
  insertCapability(db, 'registration:review', '审核报名分级');
  grantAssignment(db, {
    userId: user.id, capability: 'registration:write', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: other.id, capability: 'registration:write', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, user, other, admin, outsider,
    tokenUser: createSession(db, user.id).token,
    tokenOther: createSession(db, other.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

test('GET /api/registration-criteria 无需登录即可读（筛选标准对外透明）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/registration-criteria');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.dimensions.length, 3);
  assert.equal(body.levels.find((l) => l.key === 'S').minScore, 80);
  assert.equal(body.funnel.length, 5);
  // ⚠️ 2026-10-21 独立评审修正（Important I-1：合规 / IP / 赛程披露**零断言**）。
  //    这四项是 R-ENT-11 / R-ENT-12 / R-STG-01 的**唯一对外出口**
  //    （前端读不到 rules/*.json 目录，见计划 D-3）。
  //    原来把它们从 buildCriteria 里删掉，全量用例照样全绿 —— 需求在产品上静默失效。
  //    独立评审变异 V14 实测：删掉这 4 个字段 → 199 条仍全绿。
  assert.ok(body.ipOwnership && body.ipOwnership.team, 'R-ENT-11：IP 归属必须在报名页明示');
  assert.ok(Array.isArray(body.redLines) && body.redLines.length >= 5, 'R-ENT-12：合规红线必须公开');
  assert.equal(body.consent?.required, true, 'R-ENT-12：同意条款必须公开');
  assert.equal(body.schedule?.length, 5, 'R-STG-01：5 个赛段时间轴必须公开');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', { body: { editionId: s.edition.id, answers: GOOD } });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations 成功 → 返回等级与可解释明细', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.level, 'S');
  assert.equal(body.grading.explain.length, 3);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('重复提交 → 409 DUPLICATE_REGISTRATION', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  const res = await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).error.code, 'DUPLICATE_REGISTRATION');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registrations 无组委会权限 → 200 + 空集', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  const res = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenUser });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).items, []);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registrations 组委会 → 200 + 明细', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  const res = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).items.length, 1);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registrations/:id 本人可读、他人 → 404', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  const id = JSON.parse(created.body).id;
  const mine = await call(s.app, 'GET', `/api/registrations/${id}`, { token: s.tokenUser });
  assert.equal(mine.status, 200);
  // ⚠️ 2026-10-21 独立评审修正（Important I-2：状态机**留痕零断言**）。
  //    GET /api/registrations/:id 是 registration_events 唯一的对外出口，
  //    也是 Task 3「改级留痕」承诺的落点。
  //    原来把 events 拼装改成空数组，全量用例照样全绿（独立评审变异 V15 实测）。
  const mineBody = JSON.parse(mine.body);
  assert.equal(mineBody.events.length, 1, '刚提交完应当只有一条「提交」事件');
  assert.equal(mineBody.events[0].toStatus, 'submitted');
  assert.equal(mineBody.events[0].fromStatus, null);
  const theirs = await call(s.app, 'GET', `/api/registrations/${id}`, { token: s.tokenOther });
  assert.equal(theirs.status, 404);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations/:id/level 组委会改级成功，选手改级 → 403', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  const id = JSON.parse(created.body).id;
  const byPlayer = await call(s.app, 'POST', `/api/registrations/${id}/level`, {
    token: s.tokenUser, body: { level: 'S' },
  });
  assert.equal(byPlayer.status, 403);
  const byAdmin = await call(s.app, 'POST', `/api/registrations/${id}/level`, {
    token: s.tokenAdmin, body: { level: 'B', note: '复核：能力维需补材料' },
  });
  assert.equal(byAdmin.status, 200);
  const adminBody = JSON.parse(byAdmin.body);
  assert.equal(adminBody.levelFinal, 'B');
  // ⚠️ 2026-10-21 独立评审修正（Important I-2：改级后**留痕零断言**）。
  //    改级必须追加一条事件，且 from_status 是改级前的状态 —— 审计链的落点。
  //    留痕的对外出口是 GET /api/registrations/:id（events 字段），
  //    所以这里改级后回读一次，把「留痕」钉在 API 层而不是只钉在仓储层。
  const after = await call(s.app, 'GET', `/api/registrations/${id}`, { token: s.tokenAdmin });
  assert.equal(after.status, 200);
  const afterBody = JSON.parse(after.body);
  assert.equal(afterBody.events.length, 2, '提交 + 改级 = 两条事件');
  assert.equal(afterBody.events[1].fromStatus, 'submitted');
  assert.equal(afterBody.events[1].toStatus, 'accepted');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations/:id/level 未登录 → 401', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-5：401 路径零断言）。
  //    独立评审变异 V21：删掉路由里的 401 判断 → 全量用例照样全绿，
  //    行为会退化成 404 / 500。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/registrations/${id}/level`, { body: { level: 'S' } });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'UNAUTHENTICATED');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registration-criteria 返回当届，不是历史最早的一届', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-9：取「最早的一届」而不是「当届」）。
  //    原来 listEditions(db)[0] 永远是 starts_at 最早的那届 → 多届期场景下
  //    前端拿到的 editionId 不是当前届，报名页会引导用户报错届期。
  //    这里只断言「**历史届期不得被当成当届**」—— 不绑定具体是哪一届，
  //    避免把断言写成随日历漂移的 flaky 用例（当届是谁由真实日期决定）。
  const s = setup();
  createEdition(s.db, {
    name: '往届', city: '上海', startsAt: '2020-01-01', endsAt: '2020-12-31',
  });
  createEdition(s.db, {
    name: '在办', city: '上海', startsAt: '2099-01-01', endsAt: '2099-12-31',
  });
  const res = await call(s.app, 'GET', '/api/registration-criteria');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.notEqual(body.editionName, '往届', '历史届期不得被当成当届');
  assert.ok(body.editionId, '必须给出届期 id');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('pickCurrentEdition：按「尚未结束」挑当届，且 today 可注入（不随日历漂移）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-9）：today 必须可注入 ——
  //    否则「哪一届是当届」这条断言会随真实日历变成 flaky 用例。
  const editions = [
    { id: 'past', ends_at: '2020-12-31' },
    { id: 'now', ends_at: '2026-10-31' },
    { id: 'later', ends_at: '2099-12-31' },
  ];
  assert.equal(pickCurrentEdition(editions, '2026-10-21').id, 'now');
  assert.equal(pickCurrentEdition(editions, '2026-10-31').id, 'now', '结束当天仍算当届');
  assert.equal(pickCurrentEdition(editions, '2020-06-01').id, 'past');
  // 全部已结束 → 退回最后一届
  assert.equal(pickCurrentEdition([{ id: 'a', ends_at: '2019-01-01' }], '2026-10-21').id, 'a');
  // 空集 → null
  assert.equal(pickCurrentEdition([], '2026-10-21'), null);
  assert.equal(pickCurrentEdition(null, '2026-10-21'), null);
});

test('问卷不完整 → 400 INVALID_ANSWERS，且响应体带 detail（前端要知道缺哪几题）', async () => {
  // ⚠️ 2026-10-21 验收修正（worker 报为 M7，是真实覆盖缺口）：
  //    HTTP 层的 `error.detail` 此前**零断言** —— 把 server.js 里的
  //    `error(res, status, code, message, err instanceof AppError ? err.detail : undefined)`
  //    改成不传 detail，18 条用例照样全绿。
  //    而「缺哪几题」正是前端报名页要显示的东西（detail 被吞 → 页面只能报「填写不完整」）。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser,
    body: { editionId: s.edition.id, answers: { ...GOOD, direction: [4, 4] } },
  });
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'INVALID_ANSWERS');
  assert.ok(Array.isArray(body.error.detail), `error.detail 必须是数组，实际 ${JSON.stringify(body.error.detail)}`);
  assert.ok(body.error.detail.length > 0, 'detail 必须指出缺哪几题');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('已登录但没有 registration:write 能力 → 403（能力点必须真的被校验）', async () => {
  // ⚠️ 2026-10-21 验收修正（规格缺陷）：`registration:write` 被注册、被授予，
  //    但路由从不校验 → 能力点形同虚设，违反「can() 是唯一判定入口」。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, answers: GOOD },
  });
  assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 拒绝之后不能留下任何报名记录
  const list = await call(s.app, 'GET', '/api/registrations?editionId=' + s.edition.id, { token: s.tokenAdmin });
  assert.equal(JSON.parse(list.body).items.length, 0, '被拒绝的提交不得留下记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('edition 作用域的 registration:write 授权也能报名（能力点校验要带作用域）', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-6：作用域授权被误拒）。
  //    原来路由传 `ctx = null` —— `can()` 在 ctx 为空时**跳过**资源级授权的 scope 匹配
  //    → 只有 scope_type='global' 的授权能通过，
  //    组委会若用 scope_type='edition' 授予 registration:write，该用户**无法报名**
  //    （独立评审探针实测：global 授权 can(null ctx)=true / edition 授权 can(null ctx)=false）。
  const s = setup();
  const scoped = createUser(s.db, { name: '届期授权者', phone: '13900003005', password: 'pw', mbaStatus: 'mba' });
  grantAssignment(s.db, {
    userId: scoped.id, capability: 'registration:write',
    scopeType: 'edition', scopeId: s.edition.id, grantedBy: s.admin.id,
  });
  const token = createSession(s.db, scoped.id).token;
  const res = await call(s.app, 'POST', '/api/registrations', {
    token, body: { editionId: s.edition.id, answers: GOOD },
  });
  assert.equal(res.status, 200, `edition 作用域授权必须放行，实际 ${res.status}`);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 9: 创建 test/config-p1.test.js**

`platform/test/config-p1.test.js`：

```javascript
// platform/test/config-p1.test.js —— P1 阶段新增配置的配置校验守卫
//
// 为什么单独开一个文件（而不是往 P0 的 test/config.test.js 里加）：
//   P0 的 config.test.js 是 **P0 建立**的文件，条数已在 P0 计划里声明（23 条）。
//   往里加用例会让 P0 计划的条数声明当场过期 —— 跨阶段的同一条纪律是
//   「计划声明的条数 == 实跑条数」，改一处要改两处。
//   P1 自己新增的配置（P1 加了 teamFormation / schedule / compliance 三份）
//   相关断言放在 P1 自己的文件里 → P0 的文件与计划**一字不动**。
//
// 依据：设计文档 §4.2「运行时与依赖」+ §6.1「三条设计原则」+ §6.7「配置清单」
//   「version 会写进计算 trace」—— version 漂移 = 审计链在说谎。
//   全局约束「配置校验 fail-fast」：配置改坏就拒绝启动，不静默降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, validateRules } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

// P1 新增的三份配置
const P1_KEYS = ['teamFormation', 'schedule', 'compliance'];

test('P1 新增的 3 份配置都存在、都带 version、且与全体同版本', () => {
  const { rules } = loadRules(rulesDir);
  for (const key of P1_KEYS) {
    assert.ok(rules[key], `${key} 必须存在`);
    assert.equal(typeof rules[key].version, 'string', `${key} 必须带 version`);
  }
  const versions = new Set();
  const collect = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (typeof value.id === 'string') { versions.add(value.version); return; }
    for (const inner of Object.values(value)) collect(inner);
  };
  collect(rules);
  assert.equal(versions.size, 1, `全部配置的 version 必须同版本，实际 ${[...versions].join(' / ')}`);
});

test('新增配置的 version 漂移会被拒绝（不是只校验 P0 那 9 份）', () => {
  // ⚠️ 2026-10-21 验收修正（与 P2–P6 漂移审计的 I-2 同一条）：
  //    version 校验原先是**硬编码的 9 项列表** —— P1 新增的 3 份配置
  //    的 version 漂移**根本不会被发现**（实跑：零报错）。
  //    改成自动派生后，新增配置漂移立刻被抓。
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.teamFormation.version = '2099-01-01';
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('version')), `必须报 version 不一致，实际 ${JSON.stringify(errors)}`);
});

test('新增的配置缺少 version 会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.schedule.version;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('缺少 version')), `必须报缺少 version，实际 ${JSON.stringify(errors)}`);
});

test('配置份数对不上会被拒绝（整份配置没被识别到）', () => {
  // expectedCount 来自 FILES 的键数 —— 有配置**没被识别到**时必须报错，
  // 否则「少一份配置」会静默通过（计算 trace 上的 version 就是错的）。
  const { rules } = loadRules(rulesDir);
  const errors = validateRules(rules, 99);
  assert.ok(errors.some((e) => e.includes('份')), `必须报份数不符，实际 ${JSON.stringify(errors)}`);
});

test('solvability 的否决项配置坏了会被拒绝（vetoes 非空 / key 唯一 / auto 指向真实维度）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**vetoes 完全没有校验**）：
  //    原来 validateRules 只查 dimensions 与 grades，`solvability.vetoes` 一个字都没查 ——
  //    否决项写成空数组、或两条同名、或 auto 指向不存在的维度，都能通过校验、
  //    直到算分时才出问题（或者干脆**静默失效**：维度推导出的否决项整个消失）。
  const { rules } = loadRules(rulesDir);

  const empty = structuredClone(rules);
  empty.solvability.vetoes = [];
  assert.ok(
    validateRules(empty).some((e) => e.includes('vetoes')),
    'vetoes 为空必须被拒绝',
  );

  const duplicated = structuredClone(rules);
  duplicated.solvability.vetoes[1].key = duplicated.solvability.vetoes[0].key;
  assert.ok(
    validateRules(duplicated).some((e) => e.includes('重复 key')),
    'vetoes 的 key 重复必须被拒绝',
  );

  const dangling = structuredClone(rules);
  dangling.solvability.vetoes[0].auto.dimension = 'no_such_dimension';
  assert.ok(
    validateRules(dangling).some((e) => e.includes('auto.dimension')),
    'auto 指向不存在的维度必须被拒绝',
  );
});
```


> **【2026-10-21 父代理验收修正（两条规格缺陷）】**
> **①（能力点形同虚设）** `registration:write` 这个能力点被 `insertCapability` 注册、
>    被 seed 授予（captain / member）、被测试显式授予 —— 但**路由从不校验它**：
>    `POST /api/registrations` 只判了「有没有登录」。
>    能力点形同虚设 = 违反全局约束「权限模型 = capability + assignment，`can()` 是唯一判定入口」。
>    **修法**：已登录但 `can(user, 'registration:write', null, db)` 为假 → **403**
>    （三态：禁用 → 403；404 是「资源不存在」，不能拿来表示「无权」）。
> **②（HTTP 层 `error.detail` 零断言）** worker 交付时自报的 M7：
>    把 server.js 的 `error(res, status, code, message, err instanceof AppError ? err.detail : undefined)`
>    改成不传 detail，**18 条用例照样全绿** ——
>    而「缺哪几题」正是前端报名页要显示的东西（detail 被吞 → 页面只能报「填写不完整」）。
>    **修法**：补一条用例断言 400 `INVALID_ANSWERS` 的 `error.detail` 是**非空数组**。
>
> **③（测试里的裸 SQL）** 本文件原来用 `db.prepare('UPDATE users SET is_superadmin = 1 …')`，
>    而文件自己的注释却写着「不写裸 SQL，守住 SQL 边界」—— 自相矛盾。
>    P0 的 `src/db/repo/users.js` 已有 `setSuperadmin(db, userId)` → 直接调它。

- [ ] **Step 10: 运行测试确认通过**

Run: `cd platform && node --test test/registration-service.test.js test/registration-api.test.js test/config-p1.test.js`
Expected: PASS（35 个测试全过：registration-service 16 + registration-api 14 + config-p1 5）

- [ ] **Step 11: 提交**

```bash
cd platform && git add src/services/registration.js src/http/routes/registration.js rules/team-formation.json rules/schedule.json rules/compliance.json src/config.js src/server.js test/registration-service.test.js test/registration-api.test.js
git commit -m "feat(P1): 报名服务与 API（幂等 409 / 改级留痕 / 可见性过滤）+ P1 规则加载

对应需求：R-REG-06 / R-REG-07 / R-REG-08 / R-REG-09 / R-REG-11 / R-ENT-12 / R-STG-01"
```

---

### Task 4: 任务卡与六维可解性

**Files:**
- Create: `platform/src/domain/solvability.js`
- Create: `platform/src/services/taskPackage.js`
- Create: `platform/src/http/routes/taskPackage.js`
- Modify: `platform/rules/solvability.json`
- Modify: `platform/src/db/repo/taskPackages.js`（**Task 1 建立、本 Task 追加**：`listTaskPackagesByEdition` 加 editionId 缺省守卫）
- Modify: `platform/src/server.js`（追加任务卡路由注册）
- Create: `platform/test/solvability-domain.test.js`
- Create: `platform/test/task-package-service.test.js`
- Create: `platform/test/task-package-api.test.js`

**Interfaces:**
- Consumes: Task 1 任务卡仓储、P0 `rules.solvability`、P0 `can()`
- Produces:
  - `scoreSolvability({ answers, config })` → `{ score, grade, computedGrade, vetoes, commitment, agreement, explain }`
    - `answers`: `{ problem_clarity: 0..3, data_access: 0..3, validation: 0..2, decision_chain: 0..1, accountability: 0..1, precedent: 0..1, vetoes?: string[] }`
    - `score` ∈ [0, 12]；`grade` ∈ A/B/C/D；`vetoes` = 命中的否决项 key 列表
  - `checkTaskMix(packages, config)` → `{ ok, total, free, enterprise, actualFree, actualEnterprise, byGrade, errors }`（R-ENT-09 配比校验）
    - ⚠️ **入参形状 = 服务层已呈现（present）的任务卡**（`isFreeBrief` 驼峰），**不是数据库行**（`is_free_brief`）
    - ⚠️ **分母是全体任务卡（total）**，不是 B 端子集 —— 见 Step 4 的分母说明与需求原文 R-ENT-09
  - `submitTaskPackage({ db, userId, payload, now, rules })` → task package
    - 错误码：`MISSING_EDITION_ID`(400) / `EDITION_NOT_FOUND`(404) / `INCOMPLETE_TASK_PACKAGE`(400) / `CONSENT_REQUIRED`(400) / `FREE_BRIEF_NO_ENTERPRISE`(400)
  - `assessSolvability({ db, taskPackageId, answers, actorId, now, rules })` → task package
    - 错误码：`TASK_PACKAGE_NOT_FOUND`(404) / `TASK_PACKAGE_STATE_INVALID`(409) / `INVALID_SOLVABILITY_ANSWERS`(400) / `INVALID_VETO_KEY`(400)
  - `approveTaskPackage({ db, taskPackageId, grade, actorId, now, rules })` → task package
    - 错误码：`TASK_PACKAGE_NOT_FOUND`(404) / `SOLVABILITY_NOT_ASSESSED`(400) / `TASK_PACKAGE_STATE_INVALID`(409) / `INVALID_GRADE`(400)
  - `listTaskPackages({ db, filter, viewer, rules })` → task package[]
  - API：`POST /api/task-packages`｜`GET /api/task-packages`｜`POST /api/task-packages/:id/solvability`｜`POST /api/task-packages/:id/approve`
  - ⚠️ 与 `INTERFACES.md §2` 的偏差：这里的四个服务签名多了 `rules` 参数（规则配置按依赖注入传入，不用全局单例）。
    与 Task 3 的报名服务同款偏差；契约文件里的签名仍成立（多一个可选依赖参数不算破坏契约）。

- [ ] **Step 1: 写失败的测试**

`platform/test/solvability-domain.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreSolvability, checkTaskMix } from '../src/domain/solvability.js';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const config = JSON.parse(readFileSync(join(rulesDir, 'solvability.json'), 'utf8'));

// 六维满分 = 12 分 → A 级（顶层文档 §3.2：A 10-12）
const FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

test('六维满分 → 12 分 A 级，承诺试点', () => {
  const r = scoreSolvability({ answers: FULL, config });
  assert.equal(r.score, 12);
  assert.equal(r.grade, 'A');
  assert.equal(r.commitment, '试点承诺');
  assert.equal(r.agreement, '试点承诺书 + 数据授权说明');
  assert.deepEqual(r.vetoes, []);
});

test('中档 8.6 分 → B 级（对标试点协议）', () => {
  const r = scoreSolvability({
    answers: {
      problem_clarity: 2, data_access: 2, validation: 2,
      decision_chain: 0, accountability: 1, precedent: 1,
    },
    config,
  });
  assert.equal(r.score, 8.6);
  assert.equal(r.grade, 'B');
  assert.equal(r.agreement, '对标试点协议');
});

test('低档 4.6 分 → C 级（场景提供协议，不承诺试点）', () => {
  const r = scoreSolvability({
    answers: {
      problem_clarity: 1, data_access: 1, validation: 0,
      decision_chain: 1, accountability: 1, precedent: 0,
    },
    config,
  });
  assert.equal(r.score, 4.6);
  assert.equal(r.grade, 'C');
  assert.equal(r.commitment, '不承诺试点');
});

test('全 0 → D 级 + 自动命中两条一票否决，commitment = 无', () => {
  const r = scoreSolvability({
    answers: {
      problem_clarity: 0, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    config,
  });
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'D');
  assert.equal(r.commitment, '无');
  assert.ok(r.vetoes.includes('no_data_authorization'));
  assert.ok(r.vetoes.includes('no_responsible_owner'));
  assert.equal(r.agreement, '退回，但必出问题可解性诊断报告');
});

test('自报「涉及生产系统且未谈责任归属」→ 一票否决，承诺为无', () => {
  const r = scoreSolvability({
    answers: { ...FULL, vetoes: ['production_undisclosed'] },
    config,
  });
  assert.equal(r.computedGrade, 'A');
  assert.equal(r.grade, 'D');
  assert.equal(r.commitment, '无');
  assert.ok(r.vetoes.includes('production_undisclosed'));
});

test('explain 给出每维取值 / 权重 / 折算分', () => {
  const r = scoreSolvability({ answers: FULL, config });
  assert.equal(r.explain.length, 6);
  const pc = r.explain.find((e) => e.dimension === 'problem_clarity');
  assert.equal(pc.value, 3);
  assert.equal(pc.max, 3);
  assert.equal(pc.weight, 0.3);
  assert.equal(pc.contribution, 3.6);
});

test('配比：自由题 30% / B 端 70%，A 40% B 20% C 10%（R-ENT-09）', () => {
  // ⚠️ 父代理预审修正（Critical，规格缺陷）：夹具字段名从 `is_free_brief` 改成
  //    `isFreeBrief`（驼峰 = 服务层 presentTaskPackage 的输出形状）。
  //    checkTaskMix 消费的是**已呈现的任务卡**，不是数据库行。
  //    原来夹具用下划线、实现也读下划线 → 形状错配在夹具与实现之间互相抵消，
  //    测试全绿；但路由层喂的是**驼峰的 presented 对象** → 实现读不到 →
  //    自由题恒算 0 → 配比体检恒报「自由命题占比 0%」。
  //    父代理预审实跑复现（3 张自由卡被算成 0 张）。现在夹具与路由同形，回归可见。
  const packages = [
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'B' }, { isFreeBrief: false, grade: 'B' },
    { isFreeBrief: false, grade: 'C' },
    { isFreeBrief: true, grade: null }, { isFreeBrief: true, grade: null },
    { isFreeBrief: true, grade: null },
  ];
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.total, 10);
  assert.equal(r.free, 3);
  assert.equal(r.enterprise, 7);
  // R-ENT-09 原文：「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」——
  // 四档瓜分**整个任务池**（合计 100%），不是 B 端子集。
  assert.equal(r.byGrade.A, 4);
  assert.equal(r.byGrade.B, 2);
  assert.equal(r.byGrade.C, 1);
});

test('配比偏离 → 报错而不是静默通过', () => {
  const packages = Array.from({ length: 9 }, () => ({ isFreeBrief: false, grade: 'A' }));
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('TASK_MIX_FREE')), r.errors.join('；'));
});

test('配比分母是全体任务卡：7 张 B 端 + 3 张自由，误差在校准内才算达标', () => {
  // ⚠️ 父代理预审修正（Critical）：分母必须是 **total**，不是 B 端子集。
  //    需求原文（R-ENT-09）：「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」。
  //    原来实现用 enterprise * ratio → 10 张池子里 4 张 A 级被判成
  //    「4/7 超出目标 40%」→ 明明合规却报错（父代理预审实跑复现）。
  const packages = [
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'B' }, { isFreeBrief: false, grade: 'B' },
    { isFreeBrief: false, grade: 'C' },
    { isFreeBrief: true, grade: null }, { isFreeBrief: true, grade: null },
    { isFreeBrief: true, grade: null },
  ];
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.actualFree, 0.3);
});

test('配比偏离 → 分母用 total 时仍能识别超标（防「改成永远通过」）', () => {
  const packages = Array.from({ length: 10 }, () => ({ isFreeBrief: false, grade: 'A' }));
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('TASK_MIX_GRADE_A')), r.errors.join('；'));
});

test('分档边界值：10→A、9→B、7→B、6→C、4→C、3→D（边界不可判错）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-1：**分档边界值零覆盖**）。
  //    原来只测了 12 / 8.6 / 4.6 / 0 四个点 —— 把 `gradeOf` 里的 `>=` 改成 `>`，
  //    全量用例照样全绿（独立评审变异 M14 SURVIVED）。
  //    而这些边界分**业务上完全可达**（独立评审枚举 288 组组合：10 分 1 组、
  //    9 分 9 组、7 分 8 组、6 分 16 组、4 分 8 组、3 分 9 组），
  //    档位直接决定 R-ENT-08 的承诺与协议 → 判错一档 = 承诺错一级。
  //    这里用 computedGrade（不含一票否决）单独钉住「分数 → 档位」这条映射。
  const cases = [
    { score: 10, grade: 'A', answers: { problem_clarity: 3, data_access: 1, validation: 2, decision_chain: 1, accountability: 1, precedent: 1 } },
    { score: 9, grade: 'B', answers: { problem_clarity: 1, data_access: 3, validation: 2, decision_chain: 1, accountability: 1, precedent: 0 } },
    { score: 7, grade: 'B', answers: { problem_clarity: 1, data_access: 1, validation: 2, decision_chain: 1, accountability: 1, precedent: 0 } },
    { score: 6, grade: 'C', answers: { problem_clarity: 0, data_access: 3, validation: 0, decision_chain: 1, accountability: 1, precedent: 1 } },
    { score: 4, grade: 'C', answers: { problem_clarity: 0, data_access: 1, validation: 0, decision_chain: 1, accountability: 1, precedent: 1 } },
    { score: 3, grade: 'D', answers: { problem_clarity: 0, data_access: 0, validation: 0, decision_chain: 1, accountability: 1, precedent: 1 } },
  ];
  for (const c of cases) {
    const r = scoreSolvability({ answers: c.answers, config });
    assert.equal(r.score, c.score, `${c.score} 分的算分必须精确`);
    assert.equal(r.computedGrade, c.grade, `${c.score} 分必须判为 ${c.grade} 级`);
  }
});

test('explain.note 必须写清取值与折算（可解释明细是给企业看的）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-5：`explain.note` 零断言）。
  const r = scoreSolvability({ answers: FULL, config });
  const pc = r.explain.find((e) => e.dimension === 'problem_clarity');
  assert.ok(pc.note.includes('问题确定性'), `note 必须含维度标签，实际 ${pc.note}`);
  assert.ok(pc.note.includes('3/3'), `note 必须含取值/上限，实际 ${pc.note}`);
  assert.ok(pc.note.includes('3.6'), `note 必须含折算分，实际 ${pc.note}`);
});

test('否决项的自动触发条件来自配置（改 key 不得让维度推导静默失效）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-1：**key 硬编码在领域层**）：
  //    原来领域层写死 'no_data_authorization' / 'no_responsible_owner' 两个 key ——
  //    把配置里的 key 改名 → 维度推导出的否决项**整个消失**，
  //    实跑表现为「grade=B, vetoes=[]」，即「数据可得性 = 0 → 一票否决」
  //    这条规则可以被一次配置改名**静默关掉**。
  //    现在触发条件写在配置的 `auto` 里，key 只是标识 —— 改名不影响判定。
  const renamed = {
    ...config,
    vetoes: config.vetoes.map((v) => (v.auto ? { ...v, key: `${v.key}_renamed` } : v)),
  };
  const r = scoreSolvability({
    answers: {
      problem_clarity: 3, data_access: 0, validation: 2,
      decision_chain: 1, accountability: 1, precedent: 1,
    },
    config: renamed,
  });
  assert.equal(r.vetoes.length, 1, '数据可得性 = 0 仍必须命中一条否决项');
  assert.equal(r.vetoes[0], 'no_data_authorization_renamed');
  assert.equal(r.grade, 'D', '命中否决项必须强制降到 D');
});
```

`platform/test/task-package-service.test.js`：

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
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import {
  submitTaskPackage, assessSolvability, approveTaskPackage, listTaskPackages,
} from '../src/services/taskPackage.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

const FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tp-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900004001', password: 'pw', mbaStatus: 'other' });
  return { db, close, dataDir, rules, edition, enterprise };
}

const PAYLOAD = {
  title: '门店排班优化',
  painPoint: '排班靠店长经验，旺季人不够、淡季人浪费',
  expectedDelivery: '可运行的排班推荐原型',
  acceptanceCriteria: '用真实门店历史数据跑出一版排班表，店长认可',
  enterpriseName: '某零售',
  consent: { accepted: true, items: ['no_data_export'] },
};

test('提交任务卡：字段齐全则入库，状态为 submitted', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assert.equal(pkg.status, 'submitted');
  assert.equal(pkg.title, '门店排班优化');
  assert.equal(pkg.isFreeBrief, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('任务卡缺痛点/期望交付/验收标准 → 400（R-ENT-01）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: edition.id, painPoint: '' }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'INCOMPLETE_TASK_PACKAGE',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未同意合规红线 → 400（R-ENT-12）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: edition.id, consent: { accepted: false } }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'CONSENT_REQUIRED',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自由命题不得挂企业主体（R-ENT-10）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: edition.id, isFreeBrief: true }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'FREE_BRIEF_NO_ENTERPRISE',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('六维评估满分 → A 级 + 试点承诺书与数据授权说明（R-ENT-08）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  const assessed = assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  assert.equal(assessed.solvabilityScore, 12);
  assert.equal(assessed.solvabilityGrade, 'A');
  assert.equal(assessed.commitment, '试点承诺');
  assert.equal(assessed.agreement, '试点承诺书 + 数据授权说明');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('D 级必须出《问题可解性诊断报告》，不得静默丢弃（R-ENT-08）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 0, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', reason: '可解性不足：补齐数据授权与责任归属后重提', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.grade, 'D');
  assert.equal(approved.status, 'returned');
  assert.equal(approved.commitment, '无');
  assert.ok(approved.meta.solvability.diagnosticReport, 'D 级必须有诊断报告');
  assert.equal(approved.meta.solvability.diagnosticReport.title, '问题可解性诊断报告');
  assert.ok(approved.meta.solvability.diagnosticReport.vetoes.length > 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('P10：主动退回（D 级）必须写退回理由 —— 没说为什么，企业就不知道要改什么', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 0, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  // ⛔ 缺理由 ⇒ 400（理由是**给人看的话**，不是数据）
  assert.throws(
    () => approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', actorId: enterprise.id, now: NOW, rules }),
    (err) => err.status === 400 && err.code === 'RETURN_REASON_REQUIRED',
  );
  assert.throws(
    () => approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', reason: '   ', actorId: enterprise.id, now: NOW, rules }),
    (err) => err.status === 400 && err.code === 'RETURN_REASON_REQUIRED',
  );
  // 给了理由 ⇒ 通过，且理由**留痕**（meta 里能读到）
  const ok = approveTaskPackage({
    db, taskPackageId: pkg.id, grade: 'D', reason: '数据授权拿不到', actorId: enterprise.id, now: NOW, rules,
  });
  assert.equal(ok.status, 'returned');
  assert.equal(ok.meta.solvability.decision.grade, 'D');
  assert.equal(ok.meta.solvability.decision.reason, '数据授权拿不到');
  assert.equal(ok.meta.solvability.decision.decidedBy, enterprise.id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('存在一票否决时不得签成 A 级（强制降到 D）', () => {  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id, answers: { ...FULL, vetoes: ['production_undisclosed'] },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.grade, 'D');
  assert.equal(approved.status, 'returned');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自由题不签企业协议（R-ENT-10）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id,
    payload: { ...PAYLOAD, editionId: edition.id, isFreeBrief: true, enterpriseName: null }, now: NOW, rules,
  });
  const assessed = assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.commitment, '无');
  assert.equal(approved.agreement, '自由命题不签约，无企业协议');
  assert.ok(assessed.solvabilityGrade);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('列表：无 task_package:read 权限 → 空数组', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  submitTaskPackage({ db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules });
  assert.deepEqual(listTaskPackages({ db, filter: { editionId: edition.id }, viewer: enterprise, rules }), []);
  const admin = { id: enterprise.id, is_superadmin: 1, active: 1 };
  assert.equal(listTaskPackages({ db, filter: { editionId: edition.id }, viewer: admin, rules }).length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未做六维评估就签级 → 400 SOLVABILITY_NOT_ASSESSED（评估闸门必须真的生效）', () => {
  // ⚠️ 父代理预审修正（Important，规格缺陷）：原来 approveTaskPackage 只读
  //    meta.solvability.vetoes —— 没评估过 → vetoes 为空 → 跳过否决降级 →
  //    直接签 A 并发布（父代理预审实跑：grade=A / status=published /
  //    solvabilityScore=null）。六维可解性评估闸门形同虚设。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assert.throws(
    () => approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules }),
    (err) => err.status === 400 && err.code === 'SOLVABILITY_NOT_ASSESSED',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('届期不存在 → 404 EDITION_NOT_FOUND（不得漏出 SQLite 外键原文）', () => {
  // ⚠️ 父代理预审修正（Important）：原来只判 `!editionId` 就 INSERT →
  //    edition_id 外键约束失败 → SQLite 原文漏到 HTTP 层（只能回 500）。
  const { db, close, dataDir, rules, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: 'not-a-real-edition' }, now: NOW, rules,
    }),
    (err) => err.status === 404 && err.code === 'EDITION_NOT_FOUND',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('D 级诊断报告必须带上分数（不能恒为 null）', () => {
  // ⚠️ 父代理预审修正（Important）：原来 meta.solvability 不存 score →
  //    诊断报告里 `solvability.score ?? null` 恒为 null —— 报告是给企业看的
  //    退回理由，分数却是空的（父代理预审实跑：diagnosticReport.score = null）。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 1, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', reason: '可解性不足：补齐数据授权与责任归属后重提', actorId: enterprise.id, now: NOW, rules });
  const report = approved.meta.solvability.diagnosticReport;
  assert.equal(typeof report.score, 'number', '诊断报告必须带分数');
  assert.equal(report.grade, 'D');
  assert.ok(report.suggestions.length > 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('已发布的卡不能重新评估 → 409（任务卡状态机）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.throws(
    () => assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules }),
    (err) => err.status === 409 && err.code === 'TASK_PACKAGE_STATE_INVALID',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交方在列表里能看到自己提交的卡', () => {
  // ⚠️ 父代理预审修正（Minor）：原来非组委会视图只返回 status === 'published'
  //    → 企业提交完任务卡，列表里一条都看不到。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  submitTaskPackage({ db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules });
  // 给该用户授予 task_package:read（走 P0 的授权函数，不写裸 SQL）
  insertCapability(db, 'task_package:read', '读取任务卡');
  grantAssignment(db, {
    userId: enterprise.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: enterprise.id,
  });
  const viewer = { id: enterprise.id, active: 1, is_superadmin: 0 };
  const items = listTaskPackages({ db, filter: { editionId: edition.id }, viewer, rules });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'submitted');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('returned → 重新评估 → 复活为 published（D 级退回后可以补短板再来一次）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-2：**状态机复活链零断言**）。
  //    原来只测了「提交 → 评估 → 签级」这一条正向链；
  //    把 ASSESSABLE 里的 'returned' 删掉、把 approve 的状态守卫放宽，
  //    全量用例照样全绿（独立评审变异 M18/M19 SURVIVED）。
  //    实跑确认实现本身正确（returned 的卡能重新评估并复活）—— 但**没有断言保护**。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 0, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  const returned = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', reason: '可解性不足：补齐数据授权与责任归属后重提', actorId: enterprise.id, now: NOW, rules });
  assert.equal(returned.status, 'returned');
  assert.ok(returned.meta.solvability.diagnosticReport, 'D 级必须带诊断报告');

  // 补齐短板后重新评估 → 再签级 → 复活
  const reassessed = assessSolvability({
    db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules,
  });
  assert.equal(reassessed.status, 'assessed');
  assert.equal(reassessed.solvabilityGrade, 'A');
  const revived = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.equal(revived.status, 'published');
  assert.equal(revived.grade, 'A');
  // ⚠️ Minor M-6：复活后**旧的 D 级诊断报告不得残留** ——
  //    否则已发布的卡上挂着一份「grade: D, score: 0」的过期报告。
  assert.equal(revived.meta.solvability.diagnosticReport, undefined, '复活后不得残留旧 D 级诊断报告');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('D 级诊断报告的内容必须能指导企业补短板（不是空壳）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-5：**报告实质内容零断言**）：
  //    原来只断言 `suggestions.length > 0` —— 但 `suggestions` 有两个独立生产者
  //    （短板维度 + 否决项提示），只删掉其中一个断言照样通过
  //    （独立评审变异 M50 / M16 / M17 各自 SURVIVED）。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 3, data_access: 0, validation: 0,
      decision_chain: 1, accountability: 0, precedent: 1,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', reason: '可解性不足：补齐数据授权与责任归属后重提', actorId: enterprise.id, now: NOW, rules });
  const report = approved.meta.solvability.diagnosticReport;
  assert.equal(report.title, '问题可解性诊断报告');
  assert.equal(report.grade, 'D');
  assert.equal(typeof report.score, 'number');
  assert.equal(report.dimensions.length, 6, '六个维度都要在报告里');
  // 短板建议必须**点名具体维度**
  assert.ok(
    report.suggestions.some((s) => s.includes('数据可得性') || s.includes('责任可归属')),
    `建议必须点名短板维度，实际 ${JSON.stringify(report.suggestions)}`,
  );
  // 否决项必须带**中文标签**（不是 key）
  assert.ok(report.vetoLabels.length > 0, '否决项标签不得为空');
  assert.ok(report.vetoLabels.every((l) => !/^[a-z_]+$/.test(l)), '标签必须是中文而不是 key');
  assert.ok(report.vetoLabels.includes('无法提供《数据授权说明》'));
  assert.ok(report.vetoLabels.includes('无企业侧唯一责任人'));
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重签级后旧的 D 级诊断报告不得残留（published 卡上不能挂着退回结论）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-6：**旧 D 级报告残留**）。
  //    独立评审实跑复现：一张被签成 D 级（带《问题可解性诊断报告》）的卡，
  //    之后**重新签级为 A 并发布**时，旧的诊断报告还挂在 meta 上 ——
  //    已发布的卡上挂着一份「grade: D, score: 12」的退回结论。
  //    注意：走「重新评估 → 再签级」这条路时，`assessSolvability` 会整份替换
  //    meta.solvability，旧报告自然消失 —— **那条路查不出这个缺陷**。
  //    真正的暴露路径是「D 级 → 直接重签 A」（状态机允许 returned 再签）。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  // 先评估（六维满分、无否决）→ 组委会直接签 D 级
  assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  const downgraded = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', reason: '可解性不足：补齐数据授权与责任归属后重提', actorId: enterprise.id, now: NOW, rules });
  assert.equal(downgraded.status, 'returned');
  assert.ok(downgraded.meta.solvability.diagnosticReport, 'D 级必须带诊断报告');

  // 组委会复核后改签 A 级 → published
  const revived = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.equal(revived.status, 'published');
  assert.equal(revived.grade, 'A');
  assert.equal(
    revived.meta.solvability.diagnosticReport, undefined,
    '已发布的卡上不得残留旧的 D 级诊断报告',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

`platform/test/task-package-api.test.js`：

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
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

const FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

const PAYLOAD = {
  title: '门店排班优化',
  painPoint: '排班靠店长经验，旺季人不够、淡季人浪费',
  expectedDelivery: '可运行的排班推荐原型',
  acceptanceCriteria: '用真实门店历史数据跑出一版排班表，店长认可',
  enterpriseName: '某零售',
  consent: { accepted: true, items: ['no_data_export'] },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tpapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31',
  });
  const enterprise = createUser(db, { name: '企业甲', phone: '13900005001', password: 'pw', mbaStatus: 'other' });
  const admin = createUser(db, { name: '组委会', phone: '13900005002', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900005003', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 2026-10-21 独立评审修正（Important I-3：**三条路由的能力点常量不可区分**）：
  //    独立评审变异 M37/M37b/M37c：`write`↔`read`、`approve`↔`read` 互换后
  //    全量用例照样全绿 —— 因为测试里的企业账号同时有 write + read，
  //    超管又绕过一切检查 → 换掉常量没有任何用例会红。
  //    这里造两个**只有单一能力点**的账号，把「哪个端点要哪个能力点」钉死。
  const reader = createUser(db, { name: '只读账号', phone: '13900005006', password: 'pw', mbaStatus: 'mba' });
  const writer = createUser(db, { name: '可写不可签级账号', phone: '13900005007', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);
  // 能力点必须先注册（grantAssignment 会校验 capabilities 表）
  insertCapability(db, 'task_package:read', '读取任务卡');
  insertCapability(db, 'task_package:write', '提交/编辑任务卡');
  insertCapability(db, 'task_package:approve', '任务卡分级签约');
  grantAssignment(db, {
    userId: enterprise.id, capability: 'task_package:write',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: enterprise.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: reader.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: writer.id, capability: 'task_package:write',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  // 「可写不可签级」账号**同时给 read** —— 这样把 approve 端点的能力点
  // 换成 read 时它仍然能通过 → 用例必须变红（否则换掉常量无人察觉）。
  grantAssignment(db, {
    userId: writer.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, enterprise, admin, outsider, reader, writer,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
    tokenReader: createSession(db, reader.id).token,
    tokenWriter: createSession(db, writer.id).token,
  };
}

test('POST /api/task-packages 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', {
    body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages 已登录但无 task_package:write → 403（能力点必须真的被校验）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（覆盖缺口）：Task 4 原计划的 17 条用例
  //    **一条都不碰路由**。而 P1 Task 3 验收发现的两个真实缺陷
  //    （A1 能力点从未被校验 / A2 error.detail 零断言）正是在路由层。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenOutsider, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 拒绝之后不得留下任何任务卡
  const list = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(JSON.parse(list.body).items.length, 0, '被拒绝的提交不得留下记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages 缺 editionId → 400 MISSING_EDITION_ID', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', { token: s.tokenEnterprise, body: PAYLOAD });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'MISSING_EDITION_ID');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages 成功 → 200 + 状态 submitted', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'submitted');
  assert.equal(body.isFreeBrief, false);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 不带 editionId → 200（不得因绑定 undefined 抛 500）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Important）：仓储层原来写死
  //    `WHERE edition_id = ?` → editionId 缺省时 node:sqlite 抛
  //    「Provided value cannot be bound to SQLite parameter 1.」→ 500。
  const s = setup();
  const res = await call(s.app, 'GET', '/api/task-packages', { token: s.tokenAdmin });
  assert.equal(res.status, 200, `缺 editionId 不得 500，实际 ${res.status}`);
  assert.ok(Array.isArray(JSON.parse(res.body).items));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 无 task_package:read 权限 → 200 + 空集', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenOutsider });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).items, []);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 配比体检数得出自由题，且只算已进池的卡（分母 + 形状回归）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical ×2）：
  //    ① **形状错配**：路由把 presentTaskPackage 的**驼峰**视图对象喂给
  //       checkTaskMix，而实现读的是 `p.is_free_brief` → 自由题恒算 0 →
  //       体检恒报「自由命题占比 0%」（父代理预审实跑复现）。
  //    ② **分母用错**：R-ENT-09 原文「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」
  //       是四档瓜分**整个任务池**；原来实现用 `enterprise * ratio`（B 端子集为分母）
  //       → 10 张池子里 4 张 A 级被判成「4/7 超出目标 40%」→ 明明合规却报错。
  //    这条用例把 4A/2B/1C/3自由（= 40%/20%/10%/30%）全部发布进池后断言体检达标：
  //    分母用错、形状错配、只看未分级卡 —— 三种错法都会让它变红。
  const s = setup();
  const enterprisePlan = [
    { title: 'E0', grade: 'A' }, { title: 'E1', grade: 'A' },
    { title: 'E2', grade: 'A' }, { title: 'E3', grade: 'A' },
    { title: 'E4', grade: 'B' }, { title: 'E5', grade: 'B' },
    { title: 'E6', grade: 'C' },
  ];
  async function submitAndPublish(body, grade) {
    const created = await call(s.app, 'POST', '/api/task-packages', {
      token: s.tokenEnterprise, body: { ...body, editionId: s.edition.id },
    });
    assert.equal(created.status, 200, created.body);
    const id = JSON.parse(created.body).id;
    const assessed = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
      token: s.tokenEnterprise, body: { answers: FULL },
    });
    assert.equal(assessed.status, 200, assessed.body);
    const approved = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
      token: s.tokenAdmin, body: { grade },
    });
    assert.equal(approved.status, 200, approved.body);
  }
  for (const p of enterprisePlan) {
    await submitAndPublish({ ...PAYLOAD, title: p.title }, p.grade);
  }
  for (let i = 0; i < 3; i += 1) {
    await submitAndPublish(
      { ...PAYLOAD, title: `F${i}`, isFreeBrief: true, enterpriseName: null },
      'A',
    );
  }
  // 再交一张**未分级**的卡：它不进池，配比体检不该把它算进去
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, title: 'PENDING', editionId: s.edition.id },
  });

  const res = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 11, '组委会看到全部 11 张');
  assert.ok(body.mix, '组委会必须拿到配比体检结果');
  assert.equal(body.mix.total, 10, '配比只算已发布（进池）的卡');
  assert.equal(body.mix.free, 3, `自由题应被算成 3，实际 ${body.mix.free}`);
  assert.equal(body.mix.enterprise, 7);
  assert.deepEqual(body.mix.byGrade, { A: 4, B: 2, C: 1 });
  assert.equal(body.mix.ok, true, body.mix.errors.join('；'));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 无权限 → 403', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenOutsider, body: { answers: FULL },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 有权限 → 200 + 等级与承诺', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.solvabilityScore, 12);
  assert.equal(body.solvabilityGrade, 'A');
  assert.equal(body.commitment, '试点承诺');
  assert.equal(body.status, 'assessed');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 取值越界 → 400 INVALID_SOLVABILITY_ANSWERS', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, validation: 9 } },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_SOLVABILITY_ANSWERS');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 无权限 → 403', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenOutsider, body: { grade: 'A' },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 未评估就签级 → 400 SOLVABILITY_NOT_ASSESSED', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Important）：评估闸门必须在 HTTP 层也拦得住。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'SOLVABILITY_NOT_ASSESSED');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 组委会签级 → 200 + published', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.grade, 'A');
  assert.equal(body.status, 'published');
  assert.equal(body.agreement, '试点承诺书 + 数据授权说明');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 非法等级 → 400 INVALID_GRADE', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenAdmin, body: { grade: 'X' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_GRADE');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 任务卡不存在 → 404', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages/not-a-real-id/solvability', {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TASK_PACKAGE_NOT_FOUND');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('能力点常量钉死：只有 task_package:read 不能评估，只有 task_package:write 不能签级', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-3）。
  //    「提交/评估」要 write，「分级签约」要 approve，「读列表」要 read ——
  //    三个常量互换，任何一个用例都不会红（独立评审变异 M37/M37b/M37c SURVIVED）。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(created.status, 200, created.body);
  const id = JSON.parse(created.body).id;

  // 只读账号：有 read 没有 write → 评估必须 403
  const byReader = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenReader, body: { answers: FULL },
  });
  assert.equal(byReader.status, 403, '只有 read 的账号不得评估');

  // 只写账号：有 write 没有 approve → 签级必须 403
  const byWriter = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenWriter, body: { grade: 'A' },
  });
  assert.equal(byWriter.status, 403, '只有 write 的账号不得分级签约');
  assert.equal(JSON.parse(byWriter.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('配比体检只对组委会开放（非组委会拿不到 mix）', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-4）：
  //    原来「mix 只对组委会开放」这条规则**没有任何断言** ——
  //    把 mix 对所有人开放，全量用例照样全绿（独立评审变异 M46/M47 SURVIVED）。
  //    mix 是任务池的经营数据（配比是否达标），不该流向普通选手/企业。
  const s = setup();
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const byEnterprise = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenEnterprise });
  assert.equal(byEnterprise.status, 200);
  assert.equal(JSON.parse(byEnterprise.body).mix, null, '非组委会不得拿到配比体检结果');
  const byAdmin = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.ok(JSON.parse(byAdmin.body).mix, '组委会必须拿到配比体检结果');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('六维取值越界（负数 / 非整数）→ 400 INVALID_SOLVABILITY_ANSWERS', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4：负数取值分支零断言）。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const negative = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, problem_clarity: -1 } },
  });
  assert.equal(negative.status, 400);
  assert.equal(JSON.parse(negative.body).error.code, 'INVALID_SOLVABILITY_ANSWERS');
  const fractional = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, validation: 1.5 } },
  });
  assert.equal(fractional.status, 400);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('自报未知否决项 → 400 INVALID_VETO_KEY', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4：INVALID_VETO_KEY 分支零断言）。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, vetoes: ['not_a_real_veto'] } },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_VETO_KEY');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('approve 不存在的任务卡 → 404', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4：approve 的 404 分支零断言）。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages/not-a-real-id/approve', {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TASK_PACKAGE_NOT_FOUND');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 不带 editionId → 返回全部届期的卡', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-3：editionId 缺省语义未钉住）。
  //    只断言「不 500」不够 —— 语义必须写死：缺省 = 不按届期过滤。
  const s = setup();
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '北京', startsAt: '2027-10-01', endsAt: '2027-10-31',
  });
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, title: '第二届的题', editionId: otherEdition.id },
  });
  const all = await call(s.app, 'GET', '/api/task-packages', { token: s.tokenAdmin });
  assert.equal(all.status, 200);
  assert.equal(JSON.parse(all.body).items.length, 2, '不带 editionId 必须返回全部届期');
  const one = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(JSON.parse(one.body).items.length, 1, '带 editionId 必须只返回本届');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/solvability-domain.test.js test/task-package-service.test.js test/task-package-api.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/solvability.js'`

- [ ] **Step 3: 改写 rules/solvability.json 的 taskMix 段**

`platform/rules/solvability.json` 里的 `taskMix` 换成：

```json
  "taskMix": {
    "enterprise": 0.70,
    "free": 0.30,
    "enterpriseGradeSplit": { "A": 0.40, "B": 0.20, "C": 0.10 },
    "tolerance": 0.10
  },
  "taskMixNote": "R-ENT-09（顶层文档 §3.1）：任务卡 70% B 端 + 30% 自由；任务池内 A 40% / B 20% / C 10% / 自由 30%（四档合计 100%，分母是**全体任务卡**，不是 B 端子集）。tolerance=0.10 为【我方假设】的配比浮动容忍度，首届后按实测调整。"
```

`platform/rules/solvability.json` 里的 `vetoes` 换成（**其余字段逐字保留**）：

```json
  "vetoes": [
    { "key": "no_data_authorization", "label": "无法提供《数据授权说明》",
      "auto": { "dimension": "data_access", "equals": 0 } },
    { "key": "no_responsible_owner",  "label": "无企业侧唯一责任人",
      "auto": { "dimension": "accountability", "equals": 0 } },
    { "key": "production_undisclosed","label": "涉及生产系统且未谈责任归属" }
  ],
```

> ⚠️ 2026-10-21 独立评审修正（Minor M-1：**否决项 key 硬编码在领域层 → 配置改名即静默失效**）：
> 领域层原来写死两个 key（`no_data_authorization` / `no_responsible_owner`）。
> 把配置里的 key 改名 → 维度推导出的否决项**整个消失**，实跑表现为
> 「grade=B, vetoes=[]」—— 也就是说「数据可得性 = 0 → 一票否决」这条规则
> 可以被一次配置改名**静默关掉**，没有任何报错。
> 现在**触发条件写在配置的 `auto` 里**（`auto.dimension` + `auto.equals`），
> key 只当标识用 —— 改名不影响判定。
> `auto` 的形状与「指向的维度必须真实存在」由 `validateRules` 校验（见 Task 3 Step 7 的 ④）。

> ⚠️ 父代理预审修正（Important，**配置与实现必须同口径**）：
> `enterpriseGradeSplit` 的三档比例合计 = 0.70 = `taskMix.enterprise`。
> 这条等式只在「四档瓜分**整个任务池**」的口径下成立 ——
> P0 已实现的 `validateRules`（`src/config.js`）正是按这条等式校验的：
> `enterpriseGradeSplit` 合计 ≠ `taskMix.enterprise` → 直接拒绝启动。
> 所以**实现侧的分母也必须是 total**，不能是 B 端子集（详见 Step 4）。
> 本次把 `taskMixNote` 里的「B 端内部 …（40+20+10=70）」改成
> 「任务池内 A 40% / B 20% / C 10% / 自由 30%（四档合计 100%，分母是全体任务卡）」，
> 消除与实现不一致的旧表述。

- [ ] **Step 4: 创建 src/domain/solvability.js**

```javascript
// src/domain/solvability.js — 六维可解性评估（纯函数）
// 依据：顶层文档 §3.2（六维 + A 10-12 / B 7-9 / C 4-6 / D ≤3 + 三条一票否决）
// 依据：顶层文档 §3.1.1 / §3.2（R-ENT-08 分级签约与对应协议）
// 依据：顶层文档 §3.1（R-ENT-09 配比 70% B 端 + 30% 自由）
// 溯源需求：R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

// 分档：按 minScore 向下匹配。分值落在两档之间时取更低一档（不向上取整）
function gradeOf(score, config) {
  const grades = [...config.grades].sort((a, b) => b.minScore - a.minScore);
  for (const g of grades) {
    if (score >= g.minScore) return g.key;
  }
  return grades[grades.length - 1].key;
}

// 一票否决（R-ENT-07）：
//   ① 无法提供《数据授权说明》 ← 数据可得性 = 0
//   ② 无企业侧唯一责任人     ← 责任可归属 = 0
//   ③ 涉及生产系统且未谈责任归属 ← 只能由出题方自报
// ① ② 由六维推导（这两维本身就是同一件事的两种说法），③ 只能自报。
//
// ⚠️ 2026-10-21 独立评审修正（Minor M-1：**key 硬编码在领域层 → 配置改名即静默失效**）：
//    原来这里写死两个 key（'no_data_authorization' / 'no_responsible_owner'）。
//    后果：把配置里的 key 改名（或者新增一条同类否决项）→ 领域层仍然按老 key 判定
//    → **维度推导出的否决项整个消失**，且实跑表现为「grade=B, vetoes=[]」
//    （独立评审探针实测）—— 也就是说「数据可得性 = 0 → 一票否决」这条规则
//    可以被一次配置改名**静默关掉**，没有任何报错。
//    现在改成**从配置读触发条件**：带 `auto: { dimension, equals }` 的否决项
//    由「该维度取值等于该值」自动触发。key 只是标识，判定逻辑不再依赖它。
function detectVetoes({ answers, config }) {
  const hit = new Set();
  for (const key of Array.isArray(answers.vetoes) ? answers.vetoes : []) {
    if (config.vetoes.some((v) => v.key === key)) hit.add(key);
  }
  // 维度推导：配置里带 auto 的否决项，按「某维度取值等于某值」自动命中
  for (const v of config.vetoes) {
    const auto = v.auto;
    if (!auto || typeof auto.dimension !== 'string') continue;
    const value = Number(answers[auto.dimension] ?? 0);
    const target = Number(auto.equals ?? 0);
    if (value === target) hit.add(v.key);
  }
  return config.vetoes.filter((v) => hit.has(v.key)).map((v) => v.key);
}

/**
 * 六维加权 → 0–12 分 → A/B/C/D → 承诺与协议。
 * 命中任一否决项 → grade 强制为 D、commitment = '无'，
 * 但仍必须出《问题可解性诊断报告》（不静默丢弃）。
 */
export function scoreSolvability({ answers, config }) {
  const a = answers && typeof answers === 'object' ? answers : {};
  // 分制上限取自配置的档位上限（A 的 maxScore = 12），不写死
  const scoreMax = Math.max(...config.grades.map((g) => g.maxScore));

  const explain = [];
  let total = 0;
  for (const dim of config.dimensions) {
    const raw = Number(a[dim.key] ?? 0);
    const value = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), dim.max) : 0;
    const contribution = dim.max > 0 ? (value / dim.max) * dim.weight * scoreMax : 0;
    total += contribution;
    explain.push({
      dimension: dim.key,
      label: dim.label,
      value,
      max: dim.max,
      weight: dim.weight,
      contribution: round(contribution, 2),
      note: `${dim.label} ${value}/${dim.max}，权重 ${round(dim.weight * 100, 0)}%，折算 ${round(contribution, 2)}/${scoreMax}`,
    });
  }

  const score = round(total, 2);
  const computedGrade = gradeOf(score, config);
  const vetoes = detectVetoes({ answers: a, config });
  const grade = vetoes.length ? 'D' : computedGrade;
  const gradeCfg = config.grades.find((g) => g.key === grade) ?? config.grades[config.grades.length - 1];
  const dGrade = config.grades.find((g) => g.key === 'D');

  return {
    score,
    grade,
    computedGrade,
    vetoes,
    // R-ENT-08：分级签约与对应协议（A 试点承诺书+数据授权说明 / B 对标试点协议 / C 场景提供协议 / D 退回但出诊断报告）
    commitment: vetoes.length ? '无' : gradeCfg.commitment,
    agreement: vetoes.length
      ? (dGrade?.agreement ?? '退回，但必出问题可解性诊断报告')
      : gradeCfg.agreement,
    explain,
  };
}

/**
 * 任务卡配比校验（R-ENT-09）：任务池 = A 级 40% / B 级 20% / C 级 10% / 自由题 30%。
 *
 * ⚠️ 父代理预审修正（Critical，规格缺陷）：**分母是全体任务卡（total），不是 B 端子集**。
 *    需求原文（docs/requirements-traceability.md R-ENT-09）：
 *      「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」—— 四档相加正好 100%，
 *      即**四类瓜分整个任务池**。
 *    原来的实现用 `expected = enterprise * ratio`（分母 = B 端卡数），
 *    与计划自带的测试用例直接冲突（父代理预审实跑复现）：
 *      「[TASK_MIX_GRADE_A] B 端内部 A 级 4/7，目标占比 40%」→ 17 条用例挂 1 条。
 *    三处独立佐证「分母 = total」：
 *      ① P0 已实现的 validateRules（src/config.js）校验
 *         `enterpriseGradeSplit` 合计 == `taskMix.enterprise`（0.40+0.20+0.10 = 0.70）；
 *         只有「占总池比例」的口径才成立（若是 B 端子集占比，三者之和不必等于 0.70）。
 *      ② 计划自己的注记「40+20+10=70」把三档比例锚在 70% 这个**总量占比**上。
 *      ③ 测试夹具 4A/2B/1C/3自由（10 张）= 40%/20%/10%/30%，正是总量口径。
 *
 * ⚠️ 父代理预审修正（Critical，形状错配）：入参是**服务层已呈现（present）的任务卡**，
 *    其自由题标记字段名是 `isFreeBrief`（驼峰）。原来的实现读 `p.is_free_brief`（下划线）
 *    —— 对 presented 对象恒为 undefined → 自由题恒算 0 → 配比体检恒报
 *    「自由命题占比 0%」（父代理预审实跑复现：3 张自由卡被算成 0 张）。
 *    现在统一读 presented 形状（`Number(p.isFreeBrief) === 1` 对 boolean 与 0/1 都成立）。
 *    领域层不认数据库行形状 —— 要传数据库行必须先经 presentTaskPackage 转换。
 */
export function checkTaskMix(packages, config) {
  const mix = config.taskMix ?? {};
  const tolerance = mix.tolerance ?? 0.1;
  const list = Array.isArray(packages) ? packages : [];
  const total = list.length;
  const free = list.filter((p) => Number(p.isFreeBrief) === 1).length;
  const enterprise = total - free;
  const actualFree = total ? round(free / total, 4) : 0;
  const actualEnterprise = total ? round(enterprise / total, 4) : 0;

  const byGrade = {};
  for (const p of list) {
    if (Number(p.isFreeBrief) === 1) continue;
    const g = p.grade ?? 'ungraded';
    byGrade[g] = (byGrade[g] ?? 0) + 1;
  }

  const errors = [];
  if (total > 0 && Math.abs(actualFree - (mix.free ?? 0)) > tolerance) {
    errors.push(
      `[TASK_MIX_FREE] 自由命题占比 ${round(actualFree * 100, 1)}%，目标 ${round((mix.free ?? 0) * 100, 1)}%（容差 ±${round(tolerance * 100, 1)} 个百分点）`,
    );
  }
  for (const [g, ratio] of Object.entries(mix.enterpriseGradeSplit ?? {})) {
    const actual = byGrade[g] ?? 0;
    const expected = total * ratio;
    if (enterprise > 0 && Math.abs(actual - expected) > total * tolerance) {
      errors.push(
        `[TASK_MIX_GRADE_${g}] 任务池内 ${g} 级 ${actual}/${total}，目标占比 ${round(ratio * 100, 1)}%`,
      );
    }
  }

  return { ok: errors.length === 0, total, free, enterprise, actualFree, actualEnterprise, byGrade, errors };
}
```

- [ ] **Step 5: 创建 src/services/taskPackage.js**

```javascript
// src/services/taskPackage.js — 任务卡服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）+ 顶层文档 §3.1/§3.2
// 溯源需求：R-ENT-01 / R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09 / R-ENT-10 / R-ENT-11 / R-ENT-12
import { AppError } from '../errors.js';
import { scoreSolvability } from '../domain/solvability.js';
import {
  createTaskPackage, getTaskPackage, listTaskPackagesByEdition, updateTaskPackage,
} from '../db/repo/taskPackages.js';
import { getEdition } from '../db/repo/editions.js';
import { getUserById } from '../db/repo/users.js';
import { listUserRoles } from '../db/repo/roles.js';
import { writeAuditLog } from '../audit/log.js';
import { can, isCommitteeActor, isEnterpriseOwner } from '../auth/permissions.js';

// ⚠️ 父代理预审修正（Important，状态机）：任务卡的生命周期是
//    submitted → assessed → published | returned →（补短板后）assessed → …
//    没有状态机 = 任何状态都能被评估/签级，审计轨迹失真。
const ASSESSABLE = new Set(['submitted', 'assessed', 'returned']);
const APPROVABLE = new Set(['assessed', 'returned']);

function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function presentTaskPackage(row) {
  if (!row) return null;
  const meta = parseJson(row.meta_json, {}) ?? {};
  return {
    id: row.id,
    editionId: row.edition_id,
    enterpriseId: row.enterprise_id,
    enterpriseName: row.enterprise_name,
    title: row.title,
    painPoint: row.pain_point,
    expectedDelivery: row.expected_delivery,
    acceptanceCriteria: row.acceptance_criteria,
    grade: row.grade,
    status: row.status,
    solvabilityScore: row.solvability_score,
    solvabilityGrade: row.solvability_grade,
    commitment: row.commitment,
    agreement: row.agreement,
    isFreeBrief: Number(row.is_free_brief) === 1,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    meta,
  };
}

export function submitTaskPackage({ db, userId, payload, now = new Date().toISOString(), rules }) {
  const {
    editionId, title, painPoint, expectedDelivery, acceptanceCriteria,
    enterpriseId = null, enterpriseName = null, isFreeBrief = false, consent = null,
  } = payload ?? {};

  if (!editionId) throw new AppError(400, 'MISSING_EDITION_ID', '缺少届期');
  // ⚠️ 父代理预审修正（Important）：届期必须真实存在。
  //    原来只判 `!editionId` 就直接 INSERT → edition_id 外键约束失败，
  //    SQLite 原文「FOREIGN KEY constraint failed」漏到 HTTP 层（只能回 500，
  //    还把表结构暴露给客户端）。报名服务 submitRegistration 早就查过 getEdition，
  //    任务卡这边漏了 —— 与 P0 评审修正 I5（重复手机号先查后写）同一类问题。
  if (!getEdition(db, editionId)) {
    throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
  }
  // R-ENT-01：痛点、期望交付、验收标准三者缺一不可
  if (!title || !painPoint || !expectedDelivery || !acceptanceCriteria) {
    throw new AppError(400, 'INCOMPLETE_TASK_PACKAGE', '任务卡必须填写痛点、期望交付与验收标准');
  }
  // R-ENT-12：合规红线与同意记录
  const consentCfg = rules.compliance?.consent ?? {};
  if (consentCfg.required && consent?.accepted !== true) {
    throw new AppError(400, 'CONSENT_REQUIRED', '必须确认合规红线与唯一责任人');
  }
  // R-ENT-10：自由命题没有企业签字，不得挂企业主体
  if (isFreeBrief && (enterpriseId || enterpriseName)) {
    throw new AppError(400, 'FREE_BRIEF_NO_ENTERPRISE', '自由命题任务卡不得挂企业主体');
  }

  // ⚛️ F31（Medium，2026-10-23 审计）：任务卡的 enterprise_id 原来**照抄请求体** ——
  //   ⇒ 任何人都能把任务卡挂到**别人**的企业名下（冒用企业主体；该字段会进公开榜与签级链路）。
  //   ⇒ 企业主体**由提交人自己决定**，请求体里的 enterpriseId 只在**与提交人身份一致**时采纳：
  //     ① 企业席本人提交      ⇒ 挂自己（enterprise_id = 自己的 user id）；
  //     ② 企业管理员提交      ⇒ 目标企业的 org 必须与自己的 org 相同，否则不挂；
  //     ③ 组委会提交          ⇒ 受信任，按请求体挂（赛制需要代挂）；
  //     ④ 其它角色            ⇒ 不挂企业主体。
  //   ⇒ id 与 name 必须一致：id 被改写时，name 一并改成该企业自己的名字
  //     （否则会出现「id 指向 A、名字写着 B」的错挂）。
  const actor = getUserById(db, userId);
  const actorRoles = listUserRoles(db, userId);
  const requestedEnterpriseId = enterpriseId ?? null;
  let effectiveEnterpriseId = null;
  if (actorRoles.includes('enterprise')) {
    effectiveEnterpriseId = userId;
  } else if (actorRoles.includes('enterprise_admin')) {
    const target = requestedEnterpriseId ? getUserById(db, requestedEnterpriseId) : null;
    if (target && target.org && actor && target.org === actor.org) {
      effectiveEnterpriseId = requestedEnterpriseId;
    }
  } else if (actorRoles.includes('admin')) {
    effectiveEnterpriseId = requestedEnterpriseId;
  }
  let effectiveEnterpriseName = enterpriseName ?? null;
  if (effectiveEnterpriseId !== requestedEnterpriseId) {
    const eff = effectiveEnterpriseId ? getUserById(db, effectiveEnterpriseId) : null;
    effectiveEnterpriseName = eff ? (eff.name ?? null) : null;
  }

  // R-ENT-11：IP 与成果归属 —— 同意记录随任务卡一起留存
  const meta = {
    consent: { ...(consent ?? {}), acceptedAt: now },
    ipOwnership: rules.compliance?.ipOwnership ?? {},
  };

  const row = createTaskPackage(db, {
    editionId, enterpriseId: effectiveEnterpriseId, enterpriseName: effectiveEnterpriseName,
    title, painPoint,
    expectedDelivery, acceptanceCriteria, isFreeBrief, submittedBy: userId, meta, now,
  });
  return presentTaskPackage(row);
}

export function assessSolvability({ db, taskPackageId, answers, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
  // ⚠️ **企业归属闸**（F42）：`task_package:write` 能力点被 `enterprise` 角色持有，
  //    而角色授权是**全局**的（INTERFACES.md:22）⇒ 原来企业 A 可以对**企业 B 的**任务卡
  //    重评六维可解性与分数 —— 而这两项正是 `grade`（进池的等级）与承诺的**输入**。
  //    ⇒ 归属口径与「企业确认」端点（routes/review.js 的 N03 闸）**逐字同源**：
  //    提交人本人 / 出题企业本人 / 同一企业（org 相同）三者之一；组委会可代评。
  const actor = getUserById(db, actorId);
  if (!isCommitteeActor(db, actor) && !isEnterpriseOwner(db, actorId, {
    enterpriseId: row.enterprise_id, submittedBy: row.submitted_by,
  })) {
    throw new AppError(403, 'FORBIDDEN', '只能重新评估自己企业的任务卡');
  }
  // ⚠️ 父代理预审修正（Important，状态机）：已发布的卡不能再评估。
  if (!ASSESSABLE.has(row.status)) {
    throw new AppError(409, 'TASK_PACKAGE_STATE_INVALID', `当前状态（${row.status}）不允许重新评估`);
  }
  // 六维取值范围校验（服务层做输入校验，领域层保持纯）
  for (const dim of config.dimensions) {
    const v = Number(answers?.[dim.key]);
    if (!Number.isInteger(v) || v < 0 || v > dim.max) {
      throw new AppError(
        400, 'INVALID_SOLVABILITY_ANSWERS',
        `${dim.label} 必须为 0–${dim.max} 的整数`,
      );
    }
  }
  const declared = Array.isArray(answers?.vetoes) ? answers.vetoes : [];
  for (const key of declared) {
    if (!config.vetoes.some((v) => v.key === key)) {
      throw new AppError(400, 'INVALID_VETO_KEY', `未知的否决项：${key}`);
    }
  }

  const result = scoreSolvability({ answers, config });
  const meta = parseJson(row.meta_json, {}) ?? {};
  meta.solvability = {
    // ⚠️ 父代理预审修正（Important）：score / grade 必须一起存。
    //    原来只存 vetoes/explain/computedGrade → buildDiagnosticReport 里
    //    `solvability.score ?? null` 恒为 null —— 《问题可解性诊断报告》
    //    （D 级退回时给企业的唯一凭据）里分数永远是空的。
    //    父代理预审实跑复现：诊断报告 score = null。
    score: result.score,
    grade: result.grade,
    vetoes: result.vetoes,
    explain: result.explain,
    computedGrade: result.computedGrade,
    // ⚛️ F16（Critical）：**档位定义必须一并投影出来**。
    //    原来这里只投影维度 explain（不含 minScore/maxScore）⇒ 前端的「服务端投影」
    //    只能反推出**档位键**、没有分数区间 ⇒ `gradeTiers()` 判「档位未就绪」
    //    ⇒ **一旦有任意一张卡被评估过，签级控件就整片消失**（自锁：评估更多卡也修不好）。
    //    为什么必须服务端带：生产部署**不挂** /rules/（只有 DEMO_MODE=1 才挂）
    //    ⇒ 规则投影那条路在生产是断的 ⇒ 服务端不带完整档位定义，前端就没有可用规格。
    //    （前端侧还有一道兜底：投影不出完整档位就返回 null，降级到规则投影 —— 见
    //      web/views/admin-task-packages.js 的 solvabilitySpecFromPackages。）
    grades: config.grades.map((g) => ({
      key: g.key,
      minScore: Number(g.minScore),
      maxScore: Number(g.maxScore),
      commitment: String(g.commitment ?? ''),
      agreement: String(g.agreement ?? ''),
    })),
    // 否决项的**完整定义**（key/label/auto）—— 与 `vetoes`（本次命中的那几项）不是一回事：
    // 前端要靠 `auto` 区分「由维度取值自动命中」与「委员会自报」。
    vetoesSpec: config.vetoes.map((v) => ({
      key: v.key,
      label: String(v.label ?? v.key),
      auto: Boolean(v.auto),
    })),
    assessedBy: actorId,
    assessedAt: now,
  };

  const updated = updateTaskPackage(db, taskPackageId, {
    solvability_score: result.score,
    solvability_grade: result.grade,
    commitment: result.commitment,
    agreement: result.agreement,
    status: 'assessed',
    meta_json: meta,
  });
  return presentTaskPackage(updated);
}

export function approveTaskPackage({
  db, taskPackageId, grade, reason = null, actorId, now = new Date().toISOString(), rules,
}) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');

  let gradeCfg = config.grades.find((g) => g.key === grade);
  if (!gradeCfg) {
    throw new AppError(400, 'INVALID_GRADE', `等级必须是 ${config.grades.map((g) => g.key).join(' / ')}`);
  }
  // ⚠️ P10（W4-a）：**主动退回（D 级）必须写理由** ——
  //    「退回了但没说为什么」= 企业拿到一张退回通知，却不知道该改什么
  //    （R-ENT-08 的《问题可解性诊断报告》是产物，但退回理由是**给人看的话**，不是数据）。
  //    ⛔ 只在**委员会自己选 D** 时强制：因一票否决被系统强制降到 D 的情形
  //    已有诊断报告说明原因（命中了哪条否决项）⇒ 不在这里卡人。
  if (grade === 'D' && (!reason || !String(reason).trim())) {
    throw new AppError(400, 'RETURN_REASON_REQUIRED', '退回任务卡必须写明退回理由（企业要照着改）');
  }

  const meta = parseJson(row.meta_json, {}) ?? {};
  const solvability = meta.solvability ?? {};
  const vetoes = solvability.vetoes ?? [];

  // ⚠️ 父代理预审修正（Important，规格缺陷）：**必须先做六维评估才能签级**。
  //    原来只读 meta.solvability.vetoes —— 没评估过的卡，meta.solvability 是空的，
  //    vetoes 为空 → 跳过「一票否决强制降级」→ 直接签 A 并发布。
  //    父代理预审实跑复现：grade = A、status = published、solvabilityScore = null。
  //    这等于**六维可解性评估闸门形同虚设**，与 P1 Task 3 验收发现的 A1
  //    （registration:write 能力点被注册但从不校验）同一类：
  //    「机制被写下来了，但没接线」。
  if (typeof solvability.score !== 'number') {
    throw new AppError(
      400, 'SOLVABILITY_NOT_ASSESSED',
      '任务卡必须先完成六维可解性评估，才能分级签约',
    );
  }
  // ⚠️ 父代理预审修正（Important，状态机）：只有已评估/已退回的卡才可签级。
  if (!APPROVABLE.has(row.status)) {
    throw new AppError(409, 'TASK_PACKAGE_STATE_INVALID', `当前状态（${row.status}）不允许分级签约`);
  }

  // 存在未解除的一票否决 → 不得签成 A/B/C，强制退回
  if (vetoes.length && grade !== 'D') {
    gradeCfg = config.grades.find((g) => g.key === 'D');
  }
  const finalGrade = gradeCfg.key;
  const isFree = Number(row.is_free_brief) === 1;

  const patch = {
    grade: finalGrade,
    approved_by: actorId,
    approved_at: now,
    status: finalGrade === 'D' ? 'returned' : 'published',
    // R-ENT-10：自由命题无企业签字 → 不签任何企业协议
    commitment: isFree ? '无' : gradeCfg.commitment,
    agreement: isFree ? '自由命题不签约，无企业协议' : gradeCfg.agreement,
  };

  if (finalGrade === 'D') {
    // R-ENT-08：D 级不是静默丢弃 —— 必须出《问题可解性诊断报告》
    solvability.diagnosticReport = buildDiagnosticReport({ row, solvability, config, now });
  } else if (solvability.diagnosticReport) {
    // ⚠️ 2026-10-21 独立评审修正（Minor M-6：**旧 D 级报告残留**）：
    //    原来只在 finalGrade === 'D' 时写 meta_json。一张被退回过（D 级、带诊断报告）
    //    的卡，重新评估后被签成 A 级时，**旧的诊断报告还挂在 meta 上** ——
    //    已发布的卡上挂着一份「grade: D, score: 12」的过期报告，
    //    前端会把退回结论和当前结论一起显示出来（独立评审实跑复现）。
    //    现在签非 D 级时**清掉**旧报告：诊断报告只对 D 级成立。
    delete solvability.diagnosticReport;
  }
  // ⚠️ P10：签级结论写进 meta（前端可见、可复盘）
  solvability.decision = {
    grade: finalGrade,
    requestedGrade: grade,
    reason: reason ? String(reason).trim() : null,
    decidedBy: actorId,
    decidedAt: now,
  };
  meta.solvability = solvability;
  patch.meta_json = meta;
  const updated = updateTaskPackage(db, taskPackageId, patch);
  // ⚠️ P10：签级结论**必须留痕**（可复盘）。
  //    · meta.solvability.decision ⇒ 前端能看到「谁在什么时候签的、理由是什么」；
  //    · 审计日志 ⇒ 与其它「改级会留痕」的动作同规格（可被复核队列检索）。
  writeAuditLog(db, {
    actorId,
    action: 'task_package.approve',
    entity: 'task_package',
    entityId: taskPackageId,
    detail: { grade: finalGrade, requestedGrade: grade, reason: reason ? String(reason).trim() : null },
    now,
  });
  return presentTaskPackage(updated);
}

// 《问题可解性诊断报告》：D 级任务卡的强制产物
function buildDiagnosticReport({ row, solvability, config, now }) {
  const explain = solvability.explain ?? [];
  const weakest = [...explain].sort((a, b) => a.contribution - b.contribution).slice(0, 2);
  const suggestions = weakest.map(
    (d) => `「${d.label}」当前 ${d.value}/${d.max}（折算 ${d.contribution} 分），是拉低可解性的主要短板，建议先补齐这一维。`,
  );
  const vetoLabels = (solvability.vetoes ?? []).map(
    (k) => config.vetoes.find((v) => v.key === k)?.label ?? k,
  );
  if (vetoLabels.length) {
    suggestions.push(`命中一票否决项：${vetoLabels.join('、')}。未解除前不进入任务包池。`);
  }
  return {
    title: '问题可解性诊断报告',
    generatedAt: now,
    packageTitle: row.title,
    score: solvability.score ?? null,
    grade: 'D',
    vetoes: solvability.vetoes ?? [],
    vetoLabels,
    dimensions: explain,
    suggestions,
    disposition: '退回出题方并附本诊断报告；补齐短板后可重新提交六维评估。',
  };
}

export function listTaskPackages({ db, filter = {}, viewer, rules }) {
  // 列表权限不满足 → 空数组（API 层 200 + 空集）
  const ok = viewer
    && can(viewer, 'task_package:read', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  if (!ok) return [];
  const all = listTaskPackagesByEdition(db, filter.editionId);
  // 组委会看全部；选手与普通企业侧只看已分级发布的（未分级的不进任务包池）
  const isCommittee = viewer
    && can(viewer, 'task_package:approve', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  // ⚠️ 父代理预审修正（Minor）：**提交方能看到自己提交的卡**。
  //    原来非组委会一律只返回 status === 'published' —— 企业提交完任务卡，
  //    在列表里却一条都看不到（提交方视角形同虚设）。
  //    「未分级的不进任务池」针对的是**选题池**，不等于提交方看不到自己的卡。
  const visible = isCommittee
    ? all
    : all.filter((p) => p.status === 'published' || p.submitted_by === viewer.id);
  return visible.map(presentTaskPackage);
}
```

- [ ] **Step 6: 修改 src/db/repo/taskPackages.js（Task 1 建立，本 Task 追加）**

> ⚠️ 父代理预审修正（Important）：`listTaskPackagesByEdition` 原来写死 `WHERE edition_id = ?`。
> `GET /api/task-packages` 不带 `editionId` 时，node:sqlite 抛
> 「Provided value cannot be bound to SQLite parameter 1.」→ 裸 TypeError 漏到 HTTP 层 → 只能回 500。
> 报名的 `listRegistrationRows` 早就加了「过滤条件缺省即不生效」的守卫，任务卡仓储漏了 —— 本步补齐，
> 两者约定完全一致。

`platform/src/db/repo/taskPackages.js`：

```javascript
export function listTaskPackagesByEdition(db, editionId = null) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  return db
    // ⚠️ 父代理预审修正（确定性排序）：兜底排序键是 SQLite 隐式 `rowid`，
    //    不用随机 UUID（`id` 是 crypto.randomUUID()）—— 排序键必须确定性。
    .prepare(
      `SELECT * FROM task_packages WHERE ${where.join(' AND ')} ORDER BY submitted_at, rowid`,
    )
    .all(...params);
}
```

- [ ] **Step 7: 创建 src/http/routes/taskPackage.js**

```javascript
// src/http/routes/taskPackage.js — 任务卡端点
// 依据：INTERFACES.md §2「API（P1）」+ 设计文档 §8
// 溯源需求：R-ENT-01 / R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09 / R-ENT-10 / R-ENT-12
// 三态状态码（设计文档 §7.3）：列表不满足 → 200+空集；单条不满足 → 404；禁用 → 403
import { AppError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import { checkTaskMix } from '../../domain/solvability.js';
import {
  submitTaskPackage, assessSolvability, approveTaskPackage, listTaskPackages,
} from '../../services/taskPackage.js';

export function registerTaskPackageRoutes({ router, db, rules }) {
  router.add('POST', '/api/task-packages', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:write', { scopeType: 'edition', scopeId: body?.editionId ?? null }, db)) {
      throw new AppError(403, 'FORBIDDEN', '没有提交任务卡的权限');
    }
    return submitTaskPackage({ db, userId: user.id, payload: body, rules });
  });

  router.add('GET', '/api/task-packages', async ({ user, query }) => {
    const items = listTaskPackages({ db, filter: { editionId: query.editionId }, viewer: user, rules });
    // R-ENT-09：配比体检只对组委会开放。
    // ⚠️ 父代理预审修正（Important）：配比体检的对象是**已发布（进池）的任务卡**。
    //    原来直接用 items —— 组委会视图里 items 含未分级的卡（status = submitted /
    //    assessed），它们的 grade 为 null → byGrade 全落在 'ungraded' 上 →
    //    体检结果失真（父代理预审实跑：10 张未分级卡 → A/B/C 级计数全为 0）。
    //    R-ENT-09 的四档（A 40% / B 20% / C 10% / 自由 30%）描述的是**任务池**构成，
    //    未分级的卡还没进池。
    const mix = can(user, 'task_package:approve', { scopeType: 'edition', scopeId: query.editionId ?? null }, db)
      ? checkTaskMix(items.filter((p) => p.status === 'published'), rules.solvability)
      : null;
    return { items, mix };
  });

  router.add('POST', '/api/task-packages/:id/solvability', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:write', { scopeType: 'task_package', scopeId: params.id }, db)) {
      throw new AppError(403, 'FORBIDDEN', '没有评估任务卡的权限');
    }
    return assessSolvability({
      db, taskPackageId: params.id, answers: body?.answers ?? body, actorId: user.id, rules,
    });
  });

  router.add('POST', '/api/task-packages/:id/approve', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:approve', { scopeType: 'task_package', scopeId: params.id }, db)) {
      throw new AppError(403, 'FORBIDDEN', '没有分级签约的权限');
    }
    // ⚠️ P10（W4-a）：**退回理由**一并收（body.reason）——
    //    主动签 D 级时理由必填（服务层校验），理由落进 meta 与审计日志。
    return approveTaskPackage({
      db, taskPackageId: params.id, grade: body?.grade, reason: body?.reason ?? null,
      actorId: user.id, rules,
    });
  });
}
```

- [ ] **Step 8: 修改 src/server.js**

```javascript
// ① 顶部 import 追加
import { registerTaskPackageRoutes } from './http/routes/taskPackage.js';

// ② createApp 内追加（注册 P1 任务卡端点）
  registerTaskPackageRoutes({ router, db, rules });
```

- [ ] **Step 9: 运行测试确认通过**

Run: `cd platform && node --test test/solvability-domain.test.js test/task-package-service.test.js test/task-package-api.test.js`
Expected: PASS（51 个测试全过：solvability-domain 13 + task-package-service 17 + task-package-api 21）

> ⚠️ 父代理预审修正（Important，**路由层覆盖空洞**）：原计划的 17 条用例
> **一条都不碰路由** —— 而 P1 Task 3 验收发现的两个真实缺陷
> （A1 能力点从未被校验 / A2 `error.detail` 零断言）正是在路由层。
> 本次补 `test/task-package-api.test.js`（15 条），覆盖三态状态码与权限：
> 401 未登录 / 403 无能力点 / 400 参数与状态机 / 404 资源不存在 / 200+空集列表。

- [ ] **Step 10: 提交**

```bash
cd platform && git add src/domain/solvability.js src/services/taskPackage.js src/http/routes/taskPackage.js src/db/repo/taskPackages.js rules/solvability.json src/server.js test/solvability-domain.test.js test/task-package-service.test.js test/task-package-api.test.js
git commit -m "feat(P1): 任务卡与六维可解性（分级签约 + 一票否决 + D 级诊断报告）

对应需求：R-ENT-01 / R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09 / R-ENT-10 / R-ENT-11 / R-ENT-12"
```

---

### Task 5: 战队与成员管理

**Files:**
- Create: `platform/src/services/team.js`
- Create: `platform/src/http/routes/team.js`
- Modify: `platform/src/server.js`（追加战队路由注册）
- Create: `platform/test/team-service.test.js`
- Create: `platform/test/team-api.test.js`

**Interfaces:**
- Consumes: Task 1 战队仓储、Task 3 报名仓储、P0 `can()` 与 `users` 表、Task 3 的 `rules.teamFormation`
- Produces:
  - `rules.teamFormation` → `rules/team-formation.json`（内容逐字取自 INTERFACES.md §2）
  - `checkTeamFormation({ team, captain, members, taskPackage, config })` → `{ ok, errors: string[] }`
    - 错误串格式：`[错误码] 说明`，便于服务层按码分流
  - `createTeam({ db, userId, editionId, taskPackageId, name, now, rules })` → team
  - `getTeam({ db, id, viewer, rules })` → team | null
  - `addMember({ db, teamId, userId, actorId, now, rules })` → team
  - `leaveTeam({ db, teamId, userId, now, rules })` → team
  - `replaceMember({ db, teamId, outUserId, inUserId, actorId, now, rules })` → team
  - `updateTeam({ db, teamId, patch, actorId, now, rules })` → team
  - API：`POST /api/teams`｜`GET /api/teams`｜`GET /api/teams/:id`｜`POST /api/teams/:id/members`｜`PATCH /api/teams/:id`
    - ⚠️ 父代理预审修正（Critical，能力点与越权）：
      - `POST /api/teams` 必须 `can(user, 'team:create', { scopeType:'edition', scopeId: editionId })` → 否则 **403**
      - `POST /api/teams/:id/members` 的 `add` / `leave` 分支**固定用发起人自己**（`user.id`），
        **不接受** `body.userId` —— 否则任何登录用户都能替别人入队、**把别人踢出战队**；
        换人走 `replace`（汰换移交，服务层校验队长或组委会 `team:manage`）
      - `PATCH /api/teams/:id` 的权限在服务层判定（队长或组委会 `team:manage`）
    - 错误码：`TEAM_NOT_FOUND`(404) / `CAPTAIN_MBA_REQUIRED`(409) / `TASK_PACKAGE_NOT_GRADED`(409) /
      `ALREADY_IN_TEAM`(409) / `TEAM_FULL`(409) / `TEAM_DISSOLVED`(409) / `MEMBER_NOT_FOUND`(404) /
      `CAPTAIN_MUST_REPLACE`(409) / `FORBIDDEN`(403) / `INVALID_ACTION`(400)

- [ ] **Step 1: 写失败的测试**

`platform/test/team-service.test.js`：

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
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
import {
  createTeam, getTeam, addMember, leaveTeam, replaceMember, updateTeam, checkTeamFormation,
} from '../src/services/team.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

const GOOD = {
  direction: [4, 4, 4, 4, 5], capability: [4, 4, 4, 4, 5], collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题', consent: { accepted: true },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-team-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900005901', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const pkg2 = createTaskPackage(db, {
    editionId: edition.id, title: '供应链预测', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg2.id, { solvability_grade: 'B', solvability_score: 8, status: 'published' });

  const ungraded = createTaskPackage(db, {
    editionId: edition.id, title: '未评估的题', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });

  const captain = createUser(db, { name: '队长甲', phone: '13900005001', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(db, { name: '成员乙', phone: '13900005002', password: 'pw', mbaStatus: 'mba' });
  const nonMba = createUser(db, { name: '非 MBA 丙', phone: '13900005003', password: 'pw', mbaStatus: 'other' });
  const cLevel = createUser(db, { name: 'C 级丁', phone: '13900005004', password: 'pw', mbaStatus: 'mba' });

  for (const u of [captain, member, nonMba, cLevel]) {
    insertRegistration(db, {
      editionId: edition.id, userId: u.id, answers: GOOD, rawScore: 80,
      level: u.id === cLevel.id ? 'C' : 'S', status: 'submitted', now: NOW,
    });
  }

  return { db, close, dataDir, rules, edition, pkg, pkg2, ungraded, captain, member, nonMba, cLevel };
}

test('checkTeamFormation：人数不足 / 组长非 MBA / 任务包未分级 各自报错', () => {
  const { rules } = setup();
  const captain = { mba_status: 'other' };
  const members = [{ user_id: 'u1' }];
  const r = checkTeamFormation({
    team: { id: 't1' }, captain, members, taskPackage: { solvability_grade: null },
    config: rules.teamFormation,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('[CAPTAIN_MBA_REQUIRED]')));
  assert.ok(r.errors.some((e) => e.includes('[TEAM_BELOW_MIN_SIZE]')));
  assert.ok(r.errors.some((e) => e.includes('[TASK_PACKAGE_NOT_GRADED]')));
});

test('队长非 MBA → 建队被拒（R-REG-05 硬门槛）', () => {
  const s = setup();
  assert.throws(
    () => createTeam({
      db: s.db, userId: s.nonMba.id, editionId: s.edition.id,
      taskPackageId: s.pkg.id, name: '丙队', now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'CAPTAIN_MBA_REQUIRED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('任务包未分级 → 建队被拒', () => {
  const s = setup();
  assert.throws(
    () => createTeam({
      db: s.db, userId: s.captain.id, editionId: s.edition.id,
      taskPackageId: s.ungraded.id, name: '甲队', now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'TASK_PACKAGE_NOT_GRADED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('建队即认领任务包；单人时状态为 forming 且人数校验不通过（R-REG-01 / R-REG-02）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.equal(team.taskPackageId, s.pkg.id);
  assert.equal(team.status, 'forming');
  assert.equal(team.memberCount, 1);
  assert.equal(team.formation.ok, false);
  assert.ok(team.formation.errors.some((e) => e.includes('[TEAM_BELOW_MIN_SIZE]')));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('加入第 2 人 → 战队转 active，人数校验通过', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  const after = addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  assert.equal(after.memberCount, 2);
  assert.equal(after.status, 'active');
  assert.equal(after.formation.ok, true);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('C 级报名者不能入队（R-REG-08）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.throws(
    () => addMember({ db: s.db, teamId: team.id, userId: s.cLevel.id, actorId: s.captain.id, now: NOW, rules: s.rules }),
    (err) => err.status === 409 && err.code === 'REGISTRATION_NOT_ACCEPTED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('同一个人不能同时在两支战队', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  const secondCaptain = createUser(s.db, { name: '另一队队长', phone: '13900005301', password: 'pw', mbaStatus: 'mba' });
  insertRegistration(s.db, {
    editionId: s.edition.id, userId: secondCaptain.id, answers: GOOD, rawScore: 80, level: 'S', status: 'submitted', now: NOW,
  });
  const second = createTeam({
    db: s.db, userId: secondCaptain.id, editionId: s.edition.id,
    taskPackageId: s.pkg2.id, name: '另一队', now: NOW, rules: s.rules,
  }).id;
  assert.throws(
    () => addMember({ db: s.db, teamId: second, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules }),
    (err) => err.status === 409 && err.code === 'ALREADY_IN_TEAM',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('每个任务包最多 3 支战队（R-REG-01 + 顶层文档）', () => {
  const s = setup();
  const captains = [
    createUser(s.db, { name: '队一', phone: '13900005101', password: 'pw', mbaStatus: 'mba' }),
    createUser(s.db, { name: '队二', phone: '13900005102', password: 'pw', mbaStatus: 'mba' }),
    createUser(s.db, { name: '队三', phone: '13900005103', password: 'pw', mbaStatus: 'mba' }),
    createUser(s.db, { name: '队四', phone: '13900005104', password: 'pw', mbaStatus: 'mba' }),
  ];
  for (const c of captains) {
    insertRegistration(s.db, {
      editionId: s.edition.id, userId: c.id, answers: GOOD, rawScore: 80, level: 'S', status: 'submitted', now: NOW,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    createTeam({
      db: s.db, userId: captains[i].id, editionId: s.edition.id,
      taskPackageId: s.pkg.id, name: `队${i + 1}`, now: NOW, rules: s.rules,
    });
  }
  assert.throws(
    () => createTeam({
      db: s.db, userId: captains[3].id, editionId: s.edition.id,
      taskPackageId: s.pkg.id, name: '队4', now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'PACKAGE_TEAM_LIMIT',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('赛程中成员退出 → 仅剩 1 人触发并队标记（R-REG-03 / R-REG-04）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  const after = leaveTeam({ db: s.db, teamId: team.id, userId: s.member.id, now: NOW, rules: s.rules });
  assert.equal(after.memberCount, 1);
  assert.equal(after.status, 'needs_merge');
  assert.equal(after.needsMerge, true);
  assert.ok(after.mergeDeadline, '并队期限必须给出');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('组长不能直接退出，必须先汰换移交', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.throws(
    () => leaveTeam({ db: s.db, teamId: team.id, userId: s.captain.id, now: NOW, rules: s.rules }),
    (err) => err.status === 409 && err.code === 'CAPTAIN_MUST_REPLACE',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('汰换：非队长发起 → 403；队长发起 → 成功且历史留痕', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  const outsider = createUser(s.db, { name: '路人', phone: '13900005201', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 汰换进来的新人必须**已完成本届报名且被接收**（R-REG-08）——
  // 原用例漏了这一步，服务层的 assertAcceptedRegistration 直接把用例挡在门外。
  insertRegistration(s.db, {
    editionId: s.edition.id, userId: outsider.id, answers: GOOD, rawScore: 80,
    level: 'S', status: 'submitted', now: NOW,
  });
  assert.throws(
    () => replaceMember({
      db: s.db, teamId: team.id, outUserId: s.member.id, inUserId: outsider.id,
      actorId: outsider.id, now: NOW, rules: s.rules,
    }),
    (err) => err.status === 403,
  );
  const after = replaceMember({
    db: s.db, teamId: team.id, outUserId: s.member.id, inUserId: outsider.id,
    actorId: s.captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(after.memberCount, 2);
  assert.ok(after.members.some((m) => m.userId === outsider.id));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('换任务包：新的包必须已分级，且不改变已固定的里程碑清单（R-STG-03）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.ok(team.milestones.items.length > 0, '建队时必须固定里程碑清单');
  assert.throws(
    () => updateTeam({
      db: s.db, teamId: team.id, patch: { taskPackageId: s.ungraded.id },
      actorId: s.captain.id, now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'TASK_PACKAGE_NOT_GRADED',
  );
  const after = updateTeam({
    db: s.db, teamId: team.id, patch: { taskPackageId: s.pkg2.id, name: '甲队改' },
    actorId: s.captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(after.taskPackageId, s.pkg2.id);
  assert.equal(after.name, '甲队改');
  assert.deepEqual(after.milestones.items, team.milestones.items);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('可见性：非成员读不到战队（返回 null）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.ok(getTeam({ db: s.db, id: team.id, viewer: s.captain, rules: s.rules }));
  assert.equal(getTeam({ db: s.db, id: team.id, viewer: s.nonMba, rules: s.rules }), null);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('singleMemberTriggersMerge=false → 退出后不触发并队标记（配置真的被读了）', () => {
  // ⚠️ 2026-10-21 父代理预审修正（Important，配置没接线）：原来「仅剩 1 人触发并队」
  //    是**硬编码**在实现里的，配置项 `singleMemberTriggersMerge` 一次都没被读过 ——
  //    配置改成 false，行为照旧触发并队。这条用例把配置关掉，断言行为**跟着变**。
  const s = setup();
  const offRules = {
    ...s.rules,
    teamFormation: { ...s.rules.teamFormation, singleMemberTriggersMerge: false },
  };
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: offRules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: offRules });
  const after = leaveTeam({ db: s.db, teamId: team.id, userId: s.member.id, now: NOW, rules: offRules });
  assert.equal(after.status, 'active', '配置关掉时不得触发并队标记');
  assert.equal(after.needsMerge, false);
});
```

`platform/test/team-api.test.js`：

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
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
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
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-teamapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31',
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900006001', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const captain = createUser(db, { name: '队长甲', phone: '13900006002', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(db, { name: '成员乙', phone: '13900006003', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900006004', password: 'pw', mbaStatus: 'mba' });
  const admin = createUser(db, { name: '组委会', phone: '13900006005', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  for (const u of [captain, member, outsider]) {
    insertRegistration(db, {
      editionId: edition.id, userId: u.id, answers: GOOD, rawScore: 80,
      level: 'S', status: 'submitted', now: NOW,
    });
  }

  // 能力点必须先注册（grantAssignment 会校验 capabilities 表）
  insertCapability(db, 'team:create', '创建战队');
  insertCapability(db, 'team:read', '读取战队');
  insertCapability(db, 'team:manage', '管理战队成员');
  grantAssignment(db, {
    userId: captain.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: member.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, pkg, captain, member, outsider, admin,
    tokenCaptain: createSession(db, captain.id).token,
    tokenMember: createSession(db, member.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
    tokenAdmin: createSession(db, admin.id).token,
  };
}

async function createTeamViaApi(s, token, name = '甲队') {
  const res = await call(s.app, 'POST', '/api/teams', {
    token, body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

test('POST /api/teams 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/teams', {
    body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name: '甲队' },
  });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams 已登录但无 team:create 能力 → 403（能力点必须真的被校验）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical）：`team:create` 被注册、被 seed 授予，
  //    但路由从不校验 → 能力点形同虚设（与 Task 3 的 A1、Task 4 的 T4-5 同类）。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name: '甲队' },
  });
  assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 拒绝之后不得留下任何战队
  const list = await call(s.app, 'GET', '/api/teams', { token: s.tokenCaptain });
  assert.equal(JSON.parse(list.body).items.length, 0);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams 有权限 → 200 + 战队视图', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  assert.equal(team.status, 'forming');
  assert.equal(team.memberCount, 1);
  assert.equal(team.members[0].role, 'captain');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/teams 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/teams');
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/teams/:id 非成员读不到 → 404；成员可读 → 200', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const theirs = await call(s.app, 'GET', `/api/teams/${team.id}`, { token: s.tokenOutsider });
  assert.equal(theirs.status, 404);
  const mine = await call(s.app, 'GET', `/api/teams/${team.id}`, { token: s.tokenCaptain });
  assert.equal(mine.status, 200);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 add 只能自己加入（不能替别人加）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical）：原来把 `body.userId` 直接交给服务层
  //    → 任何登录用户都能替别人加入战队。
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'add', userId: s.captain.id },
  });
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.memberCount, 2);
  // 加进来的是**发起人自己**，不是 body 里指定的别人
  assert.ok(body.members.some((m) => m.userId === s.member.id));
  assert.equal(body.members.filter((m) => m.userId === s.captain.id).length, 1, '组长只能有一条成员记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 leave 不能踢别人（越权踢人防护）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical）：原来 `userId: body?.userId ?? user.id`
  //    → 客户端传别人的 id 就能把别人踢出战队（服务层不校验 actor）。
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'add' },
  });
  // 成员乙试图「退出」组长（body.userId 指向组长）
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'leave', userId: s.captain.id },
  });
  assert.ok(res.status === 200 || res.status === 404, `实际 ${res.status}`);
  // 关键断言：退出的是**发起人自己**，body.userId 指向的组长不得被踢
  const after = await call(s.app, 'GET', `/api/teams/${team.id}`, { token: s.tokenCaptain });
  const body = JSON.parse(after.body);
  assert.ok(body.members.some((m) => m.userId === s.captain.id), '组长不得被踢出');
  assert.ok(!body.members.some((m) => m.userId === s.member.id), '退出的必须是发起人自己');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 replace 非队长发起 → 403', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'add' },
  });
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember,
    body: { action: 'replace', outUserId: s.member.id, inUserId: s.outsider.id },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 action 非法 → 400 INVALID_ACTION', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenCaptain, body: { action: 'destroy' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_ACTION');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('PATCH /api/teams/:id 非队长 → 403；队长 → 200', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const byOther = await call(s.app, 'PATCH', `/api/teams/${team.id}`, {
    token: s.tokenMember, body: { name: '被改的名字' },
  });
  assert.equal(byOther.status, 403);
  const byCaptain = await call(s.app, 'PATCH', `/api/teams/${team.id}`, {
    token: s.tokenCaptain, body: { name: '甲队新名字' },
  });
  assert.equal(byCaptain.status, 200);
  assert.equal(JSON.parse(byCaptain.body).name, '甲队新名字');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/teams 只返回自己参与的战队', async () => {
  const s = setup();
  await createTeamViaApi(s, s.tokenCaptain);
  const mine = await call(s.app, 'GET', '/api/teams', { token: s.tokenCaptain });
  assert.equal(JSON.parse(mine.body).items.length, 1);
  const others = await call(s.app, 'GET', '/api/teams', { token: s.tokenMember });
  assert.equal(JSON.parse(others.body).items.length, 0);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/team-service.test.js test/team-api.test.js`
Expected: FAIL —— `Cannot find module '../src/services/team.js'`

- [ ] **Step 3: 确认组队规则已就位**

`rules/team-formation.json` 与 `src/config.js` 的加载/校验**已在 Task 3 Step 7 落地**（见那里）——
本 Task 直接消费 `rules.teamFormation`，不重复创建。

- [ ] **Step 4: 创建 src/services/team.js**

```javascript
// src/services/team.js — 战队与成员服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）
// 依据：任务书 §六 组队规则（2–3 人+ / MBA 组长 / 持续招募汰换 / 仅剩一人须并队）
// 溯源需求：R-REG-01 / R-REG-02 / R-REG-03 / R-REG-04 / R-REG-05 / R-STG-03
import { AppError } from '../errors.js';
import { getUserById } from '../db/repo/users.js';
import { getEdition } from '../db/repo/editions.js';
import { getTaskPackage } from '../db/repo/taskPackages.js';
import { findActiveRegistration } from '../db/repo/registrations.js';
import {
  // ⚠️ 父代理预审修正（Critical，规格缺陷）：仓储的 getTeam 必须**改别名**导入。
  //    原来直接 `import { getTeam }`，而本文件下面又 `export function getTeam(...)`
  //    → **同名重复声明** → `SyntaxError: Identifier 'getTeam' has already been declared`
  //    → 整个模块根本无法导入 → 计划自带的 13 条用例**一条都跑不起来**。
  //    父代理预审实跑复现。服务层对外仍是 `getTeam({db,id,viewer,rules})`（契约不变）。
  insertTeam, getTeam as findTeamRow, listTeamRows, updateTeamRow, countActiveTeamsByPackage,
} from '../db/repo/teams.js';
import {
  insertTeamMember, listActiveMembers, listMemberHistory, markMemberLeft,
  countActiveMembers, findActiveMembershipByUser, lastLeaveAt,
} from '../db/repo/teamMembers.js';
import { insertMilestones } from '../db/repo/tiers.js';
import { can, canScoped, isCommitteeActor } from '../auth/permissions.js';

/**
 * 组队硬校验。错误串格式：[错误码] 说明，服务层按码分流。
 * 依据：R-REG-02（人数 ≥2）、R-REG-05（队长 MBA）、R-REG-01（任务包已分级才可认领）
 */
export function checkTeamFormation({ team, captain, members, taskPackage, config }) {
  const errors = [];
  if (config.captainMustBeMba && captain?.mba_status !== 'mba') {
    errors.push('[CAPTAIN_MBA_REQUIRED] 组长必须是一堂 MBA 在籍（任务书 §六 硬性门槛）');
  }
  const count = Array.isArray(members) ? members.length : 0;
  if (count < config.teamSize.min) {
    errors.push(`[TEAM_BELOW_MIN_SIZE] 组队人数 ${count} 人，低于下限 ${config.teamSize.min} 人（不接受 1 人组队）`);
  }
  if (count > config.teamSize.max) {
    errors.push(`[TEAM_ABOVE_MAX_SIZE] 组队人数 ${count} 人，超过上限 ${config.teamSize.max} 人`);
  }
  if (!taskPackage || !taskPackage.solvability_grade) {
    errors.push('[TASK_PACKAGE_NOT_GRADED] 认领的任务包尚未完成六维可解性分级');
  }
  return { ok: errors.length === 0, errors };
}

// 报名等级是否被接收（R-REG-08：C 级不接收）
function assertAcceptedRegistration(db, userId, editionId, rules) {
  const reg = findActiveRegistration(db, userId, editionId);
  if (!reg) {
    throw new AppError(409, 'REGISTRATION_REQUIRED', '请先完成本届报名');
  }
  const effective = reg.level_final ?? reg.level;
  const cfg = rules.registration.levels.find((l) => l.key === effective);
  if (!cfg || cfg.accept !== true) {
    throw new AppError(
      409, 'REGISTRATION_NOT_ACCEPTED',
      `你的报名尚未被接收（当前 ${effective ?? '未分级'} 级，C 级不接收）`,
    );
  }
  return reg;
}

// 战队视图：成员、组队校验、并队信息、固定里程碑
function teamView(db, teamId, rules) {
  const team = findTeamRow(db, teamId);
  if (!team) return null;
  const members = listActiveMembers(db, teamId);
  const captain = getUserById(db, team.captain_id);
  const pkg = team.task_package_id ? getTaskPackage(db, team.task_package_id) : null;
  const formation = checkTeamFormation({
    team, captain, members, taskPackage: pkg, config: rules.teamFormation,
  });
  const left = lastLeaveAt(db, teamId);
  const mergeDeadline = left
    ? new Date(new Date(left).getTime() + rules.teamFormation.singleMemberMergeDeadlineDays * 86400000).toISOString()
    : null;
  let milestones = null;
  try {
    milestones = team.milestones_json ? JSON.parse(team.milestones_json) : null;
  } catch {
    milestones = null;
  }
  return {
    id: team.id,
    editionId: team.edition_id,
    name: team.name,
    captainId: team.captain_id,
    taskPackageId: team.task_package_id,
    tier: team.tier,
    status: team.status,
    members: members.map((m) => ({ id: m.id, userId: m.user_id, role: m.role, joinedAt: m.joined_at })),
    memberCount: members.length,
    // R-REG-03：退出报备 —— 进出历史留档，不硬删
    history: listMemberHistory(db, teamId).map((m) => ({
      id: m.id, userId: m.user_id, role: m.role, joinedAt: m.joined_at, leftAt: m.left_at,
    })),
    // R-REG-04：仅剩 1 人 → 触发并队标记与期限
    needsMerge: team.status === 'needs_merge',
    mergeDeadline,
    // R-STG-03：报名时固定的里程碑清单，赛程中不可自行新增
    milestones,
    formation,
  };
}

export function createTeam({
  db, userId, editionId, taskPackageId, name, now = new Date().toISOString(), rules,
}) {
  const config = rules.teamFormation;
  if (!getEdition(db, editionId)) throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
  const captain = getUserById(db, userId);
  if (!captain) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');

  const pkg = taskPackageId ? getTaskPackage(db, taskPackageId) : null;
  if (taskPackageId && !pkg) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
  if (pkg && pkg.edition_id !== editionId) {
    throw new AppError(409, 'EDITION_MISMATCH', '任务包不属于本届');
  }
  // 硬门槛 1：组长必须一堂 MBA 在籍（R-REG-05，已定）
  if (config.captainMustBeMba && captain.mba_status !== 'mba') {
    throw new AppError(409, 'CAPTAIN_MBA_REQUIRED', '组长必须是一堂 MBA 在籍（硬性门槛）');
  }
  // 硬门槛 2：任务包可解性已分级（R-ENT-06 准入）
  if (!pkg || !pkg.solvability_grade) {
    throw new AppError(409, 'TASK_PACKAGE_NOT_GRADED', '认领的任务包尚未完成六维可解性分级');
  }
  // R-REG-01 + 顶层文档 §3.1：每个任务包 2–3 支战队
  //
  // ⚠️ 父代理预审修正（Important，两处口径登记）：
  //  ① `teamsPerPackage.min`（每包**至少** 2 支）**不在建队时强制**：
  //     建队是选手行为，某个包的第一支队在建队那一刻还不存在 ——
  //     强制 min 会让这个包**永远建不出第一支队**（死锁）。min 是组委会的运营目标，不是创建闸门。
  //  ② `packageQuotaMix`（企业包 70% / 自由包 30% 的战队配额）**本期不强制**：
  //     需求溯源表里没有对应条目（只有 R-ENT-09 的**任务卡池**配比，
  //     那条由 Task 4 的 checkTaskMix 体检）；且建队时无法预知最终配比，
  //     强制会让某个类型的包建不出队。该键保留在配置里（INTERFACES.md §2 的契约形状），
  //     由组委会在配比体检里人工看。
  const teamCount = countActiveTeamsByPackage(db, taskPackageId);
  if (teamCount >= config.teamsPerPackage.max) {
    throw new AppError(
      409, 'PACKAGE_TEAM_LIMIT',
      `该任务包已有 ${teamCount} 支战队，上限 ${config.teamsPerPackage.max} 支`,
    );
  }
  if (findActiveMembershipByUser(db, userId)) {
    throw new AppError(409, 'ALREADY_IN_TEAM', '你已在一支战队中');
  }
  assertAcceptedRegistration(db, userId, editionId, rules);

  // R-STG-03：里程碑清单在报名（组队）时固定，之后不可自行新增
  const milestones = {
    version: rules.milestones.version,
    source: rules.milestones.source,
    items: rules.milestones.items.map((i) => ({
      key: i.key, label: i.label, countsTowardTier: i.countsTowardTier,
    })),
  };

  const team = insertTeam(db, {
    editionId,
    name: name?.trim() || `第 ${teamCount + 1} 队`,
    captainId: userId,
    taskPackageId,
    status: 'forming',
    milestones,
    now,
  });
  insertTeamMember(db, { teamId: team.id, userId, role: 'captain', now });
  // R-STG-03 / R-PTS-10：里程碑清单在【组队时】固定 —— 同时落成 P3 的 milestones 表行。
  //   （P3 的段位引擎与 B 榜只读这张表；清单本身仍来自 teams.milestones_json，两处同源。）
  insertMilestones(db, { teamId: team.id, items: milestones.items, now });
  return teamView(db, team.id, rules);
}

export function getTeam({ db, id, viewer, rules }) {
  const row = findTeamRow(db, id);
  if (!row) return null;
  // 可见性：战队成员 / 组长 / 组委会 / 有**该队作用域**授权的人
  const isMember = listActiveMembers(db, id).some((m) => m.user_id === viewer?.id);
  const isCaptain = row.captain_id === viewer?.id;
  // ⚛️ F41（Low，2026-10-23 审计）：原来用 can(viewer, 'team:read', {scopeType:'team', scopeId:id}) ——
  //    但 `team:read` 由 **captain / member / observer 三个角色全局持有**
  //    （role_capabilities 没有 scope 列 ⇒ 角色授权是全局的）⇒ **任意登录用户**
  //    都能读任意队伍的名单与成员变动历史 ⇒ 传进来的 scope 形同虚设。
  //    ⇒ 改为「组委会（身份）+ 该队作用域的资源级授权」。
  const hasRight = viewer && (isCommitteeActor(db, viewer)
    || canScoped(viewer, 'team:read', { scopeType: 'team', scopeId: id }, db));
  if (!isMember && !isCaptain && !hasRight) return null;
  return teamView(db, id, rules);
}

export function addMember({ db, teamId, userId, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  if (team.status === 'dissolved') throw new AppError(409, 'TEAM_DISSOLVED', '战队已解散');
  if (findActiveMembershipByUser(db, userId)) {
    throw new AppError(409, 'ALREADY_IN_TEAM', '该同学已在一支战队中');
  }
  const count = countActiveMembers(db, teamId);
  if (count >= config.teamSize.max) {
    throw new AppError(409, 'TEAM_FULL', `战队已满（上限 ${config.teamSize.max} 人）`);
  }
  assertAcceptedRegistration(db, userId, team.edition_id, rules);

  insertTeamMember(db, { teamId, userId, role: 'member', now });
  // 人数达标 → 战队成立（R-REG-02）
  if (countActiveMembers(db, teamId) >= config.teamSize.min) {
    updateTeamRow(db, teamId, { status: 'active' });
  }
  return teamView(db, teamId, rules);
}

export function leaveTeam({ db, teamId, userId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const member = listActiveMembers(db, teamId).find((m) => m.user_id === userId);
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', '该同学不在此战队');
  if (member.role === 'captain') {
    throw new AppError(409, 'CAPTAIN_MUST_REPLACE', '组长不能直接退出，请先汰换成员并移交组长职责');
  }
  markMemberLeft(db, member.id, now);
  // R-REG-04：仅剩 1 人 → 触发并队
  // ⚠️ 父代理预审修正（Important，配置没接线）：原来把「仅剩 1 人」硬编码在实现里，
  //    配置项 `singleMemberTriggersMerge` 一次都没被读过 ——
  //    配置与实现可以各说各话（把配置改成 false，行为照旧触发并队）。
  //    现在**从配置读**：`singleMemberTriggersMerge === false` 时不触发并队标记。
  if (config.singleMemberTriggersMerge !== false && countActiveMembers(db, teamId) <= 1) {
    updateTeamRow(db, teamId, { status: 'needs_merge' });
  }
  return teamView(db, teamId, rules);
}

export function replaceMember({
  db, teamId, outUserId, inUserId, actorId, now = new Date().toISOString(), rules,
}) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');

  // R-REG-03：换人要队长或组委会同意（memberChange.requireCaptainOrAdmin）
  if (config.memberChange.requireCaptainOrAdmin) {
    const actor = getUserById(db, actorId);
    const isCaptain = team.captain_id === actorId;
    // ⚛️ F14（High，2026-10-23 审计）：原来这里是
    //   can(actor, 'team:manage', { scopeType:'team', scopeId: teamId })
    //   —— 但 `team:manage` 由 **captain 角色也持有**（全局授权）⇒
    //   **任何一支队伍的队长**都通过了「组委会」这一支 ⇒ 跨队越权（可汰换他队成员）。
    //   ⇒ 「组委会」改判**身份**（admin 角色），作用域化授权走 canScoped()。
    const isAdmin = actor && (isCommitteeActor(db, actor)
      || canScoped(actor, 'team:manage', { scopeType: 'team', scopeId: teamId }, db));
    if (!isCaptain && !isAdmin) {
      throw new AppError(403, 'FORBIDDEN', '只有队长或组委会可以汰换成员');
    }
  }

  const members = listActiveMembers(db, teamId);
  const out = members.find((m) => m.user_id === outUserId);
  if (!out) throw new AppError(404, 'MEMBER_NOT_FOUND', '被汰换的同学不在此战队');
  if (findActiveMembershipByUser(db, inUserId)) {
    throw new AppError(409, 'ALREADY_IN_TEAM', '新成员已在一支战队中');
  }
  assertAcceptedRegistration(db, inUserId, team.edition_id, rules);

  // 组长汰换：新人接任组长，必须仍是 MBA 在籍（R-REG-05）
  const replacingCaptain = out.role === 'captain';
  if (replacingCaptain) {
    const inUser = getUserById(db, inUserId);
    if (config.captainMustBeMba && inUser?.mba_status !== 'mba') {
      throw new AppError(409, 'CAPTAIN_MBA_REQUIRED', '接任组长必须是一堂 MBA 在籍（硬性门槛）');
    }
  }

  markMemberLeft(db, out.id, now);
  insertTeamMember(db, { teamId, userId: inUserId, role: replacingCaptain ? 'captain' : 'member', now });
  if (replacingCaptain) updateTeamRow(db, teamId, { captain_id: inUserId });

  const remaining = countActiveMembers(db, teamId);
  // ⚠️ 父代理预审修正（Important，配置没接线）：同上，改读 `singleMemberTriggersMerge`
  if (config.singleMemberTriggersMerge !== false && remaining <= 1) {
    updateTeamRow(db, teamId, { status: 'needs_merge' });
  } else if (team.status === 'forming') {
    updateTeamRow(db, teamId, { status: 'active' });
  }
  return teamView(db, teamId, rules);
}

export function updateTeam({ db, teamId, patch, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');

  const actor = getUserById(db, actorId);
  const isCaptain = team.captain_id === actorId;
  // ⚛️ F29（High，2026-10-23 审计）：与 F14 同一个病根 ——
  //   `team:manage` 由 captain 角色**全局**持有 ⇒ 带 scope 的 can() 挡不住「别队的队长」
  //   ⇒ 任意队长可改名并改挂**他队**的任务包。
  const isAdmin = actor && (isCommitteeActor(db, actor)
    || canScoped(actor, 'team:manage', { scopeType: 'team', scopeId: teamId }, db));
  if (!isCaptain && !isAdmin) {
    throw new AppError(403, 'FORBIDDEN', '只有队长或组委会可以修改战队');
  }

  const update = {};
  if (typeof patch?.name === 'string' && patch.name.trim()) {
    update.name = patch.name.trim();
  }
  if (patch?.taskPackageId && patch.taskPackageId !== team.task_package_id) {
    const pkg = getTaskPackage(db, patch.taskPackageId);
    if (!pkg) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
    if (pkg.edition_id !== team.edition_id) {
      throw new AppError(409, 'EDITION_MISMATCH', '任务包不属于本届');
    }
    if (!pkg.solvability_grade) {
      throw new AppError(409, 'TASK_PACKAGE_NOT_GRADED', '新任务包尚未完成六维可解性分级');
    }
    const count = countActiveTeamsByPackage(db, pkg.id);
    if (count >= config.teamsPerPackage.max) {
      throw new AppError(
        409, 'PACKAGE_TEAM_LIMIT',
        `该任务包已有 ${count} 支战队，上限 ${config.teamsPerPackage.max} 支`,
      );
    }
    update.task_package_id = pkg.id;
    // ⛔ 换任务包【不】改动已固定的里程碑清单（R-STG-03 防拆单刷里程碑）
  }
  if (Object.keys(update).length) updateTeamRow(db, teamId, update);
  return teamView(db, teamId, rules);
}

// 我参与的所有战队（供「我的战队」页使用）
export function listMyTeams({ db, userId, rules }) {
  const rows = listTeamRows(db, {});
  return rows
    .filter((t) => t.captain_id === userId || listActiveMembers(db, t.id).some((m) => m.user_id === userId))
    .map((t) => teamView(db, t.id, rules));
}
```

- [ ] **Step 5: 创建 src/http/routes/team.js**

```javascript
// src/http/routes/team.js — 战队端点
// 依据：INTERFACES.md §2「API（P1）」+ 设计文档 §8
import { AppError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import {
  createTeam, getTeam, addMember, leaveTeam, replaceMember, updateTeam, listMyTeams,
} from '../../services/team.js';

export function registerTeamRoutes({ router, db, rules }) {
  router.add('POST', '/api/teams', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    // ⚠️ 父代理预审修正（Critical，规格缺陷）：`team:create` 这个能力点被注册、
    //    被 seed 授予（captain 角色），但**路由从不校验它** → 能力点形同虚设，
    //    违反全局约束「权限模型 = capability + assignment，`can()` 是唯一判定入口」。
    //    与 P1 Task 3 的 A1（registration:write）、Task 4 的 T4-5（task_package:write）
    //    同一类病根：**机制写下来了，但没接线**。
    //    作用域带上 edition —— `can()` 传 ctx=null 会跳过资源级授权的 scope 匹配
    //    （Task 3 评审 T3-7 的同一条教训）。
    if (!can(user, 'team:create', { scopeType: 'edition', scopeId: body?.editionId ?? null }, db)) {
      throw new AppError(403, 'FORBIDDEN', '你没有建队的权限');
    }
    return createTeam({
      db,
      userId: user.id,
      editionId: body?.editionId,
      taskPackageId: body?.taskPackageId,
      name: body?.name,
      rules,
    });
  });

  // 我参与的战队（⚠️ 契约外新增端点，见文末偏差 D-2）
  // 可见性天然收敛：只返回自己参与或自己组长的战队，不需要额外能力点。
  router.add('GET', '/api/teams', async ({ user }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return { items: listMyTeams({ db, userId: user.id, rules }) };
  });

  router.add('GET', '/api/teams/:id', async ({ user, params }) => {
    const team = getTeam({ db, id: params.id, viewer: user, rules });
    if (!team) throw new AppError(404, 'NOT_FOUND', '战队不存在');
    return team;
  });

  // 加入 / 退出 / 汰换共用一个端点（设计文档 §8：POST /api/teams/:id/members）
  router.add('POST', '/api/teams/:id/members', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const action = body?.action ?? 'add';
    if (action === 'add') {
      // ⚠️ 父代理预审修正（Critical）：**加入只能是自己加入**。
      //    原来把 `body.userId` 直接交给服务层 → 任何登录用户都能**替别人**加入战队
      //    （服务层只校验「该同学已通过报名且被接收」，不校验 actor 与 userId 的关系）。
      //    「拉人入队」是组委会/队长的事，走 `action=replace`（汰换）或 P2 的邀请流程。
      return addMember({
        db, teamId: params.id, userId: user.id, actorId: user.id, rules,
      });
    }
    if (action === 'leave') {
      // ⚠️ 父代理预审修正（Critical）：**退出只能是自己退出**。
      //    原来 `userId: body?.userId ?? user.id` → 客户端传别人的 id 就能
      //    **把别人踢出战队**（服务层只查「该同学在此战队」，不校验 actor）—— 越权踢人。
      //    组长要换人走 `action=replace`（汰换移交），不是 leave。
      return leaveTeam({ db, teamId: params.id, userId: user.id, rules });
    }
    if (action === 'replace') {
      // 汰换的权限在服务层判定：队长或组委会（team:manage）—— 见 services/team.js
      return replaceMember({
        db, teamId: params.id, outUserId: body?.outUserId, inUserId: body?.inUserId,
        actorId: user.id, rules,
      });
    }
    throw new AppError(400, 'INVALID_ACTION', 'action 只能是 add / leave / replace');
  });

  router.add('PATCH', '/api/teams/:id', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    // 权限在服务层判定：队长或组委会（team:manage）—— 见 services/team.js 的 updateTeam
    return updateTeam({ db, teamId: params.id, patch: body ?? {}, actorId: user.id, rules });
  });
}
```

- [ ] **Step 6: 修改 src/server.js**

```javascript
// ① 顶部 import 追加
import { registerTeamRoutes } from './http/routes/team.js';

// ② createApp 内追加（注册 P1 战队端点）
  registerTeamRoutes({ router, db, rules });
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/team-service.test.js test/team-api.test.js`
Expected: PASS（25 个测试全过：team-service 14 + team-api 11）

> ⚠️ 2026-10-21 父代理预审修正（Important，**路由层覆盖空洞**）：原计划只有
> `test/team-service.test.js`（12 条），**一条都不碰路由**。
> 而 Task 3 / Task 4 的真实缺陷（A1 能力点未校验、越权踢人）都出在路由层 ——
> 本次补 `test/team-api.test.js`（11 条），覆盖 401 / 403 / 404 / 200+空集、
> 「加入只能自己加」「退出不能踢别人」「非队长不能汰换」「非组长不能改战队」。

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/services/team.js src/http/routes/team.js src/server.js test/team-service.test.js test/team-api.test.js
git commit -m "feat(P1): 战队与成员管理（MBA 组长硬门槛 / 并队触发 / 里程碑报名固定）

对应需求：R-REG-01 / R-REG-02 / R-REG-03 / R-REG-04 / R-REG-05 / R-STG-03"
```

---

### Task 6: 前端三页（报名 / 我的战队 / 组委会筛选台）

**Files:**
- Create: `platform/web/views/registration.js`
- Create: `platform/web/views/team.js`
- Create: `platform/web/views/admin-registration.js`
- Modify: `platform/web/app.js`
- Create: `platform/test/p1-frontend.test.js`
- Modify: `platform/src/db/repo/registrationEvents.js`（Task 1 建立；Task 6 追加 `listRegistrationEventsForRegistrations`）
- Modify: `platform/src/services/registration.js`（Task 3 建立；Task 6 让列表端点也带事件轨迹）
- Modify: `platform/test/registration-service.test.js`（Task 3 建立；Task 6 追加 2 条事件轨迹用例）

**Interfaces:**
- Consumes: Task 3 `GET /api/registration-criteria`、`POST /api/registrations`；Task 4 `GET /api/task-packages`；Task 5 `GET /api/teams`、`GET /api/teams/:id`、`POST /api/teams`、`POST /api/teams/:id/members`、`PATCH /api/teams/:id`；Task 3 `GET /api/registrations`、`POST /api/registrations/:id/level`
- Produces:
  - `web/views/registration.js` → `buildQuestionnaire(criteria)`、`formatExplain(explain, scale)`、`renderRegistration(ctx)`
  - `web/views/team.js` → `summarizeTeam(team)`、`canLeaveTeam(team, viewerId)`、`buildTeamCards(teams, viewerId)`、`renderTeam(ctx)`
  - `web/views/admin-registration.js` → `buildScreeningRows(registrations, criteria)`、`buildFunnelView(registrations, funnel)`、`formatEventTrail(events)`、`renderAdminRegistration(ctx)`
  - 路由：`#/apply`｜`#/team`｜`#/admin/registration`
  - ⛔ 每个视图模块的**纯逻辑导出**不得触碰 `document`（这样 `node:test` 能在无 DOM 环境直接测）
  - ⚠️ **所有插进 `innerHTML` 的服务端数据必须走 P0 的 `escapeHtml`**（战队名称、任务包标题、userId、message、agreement 都是**用户自填**的 → 不转义即存储型 XSS）

- [ ] **Step 1: 写失败的测试**

`platform/test/p1-frontend.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuestionnaire, formatExplain } from '../web/views/registration.js';
import { summarizeTeam, canLeaveTeam, buildTeamCards } from '../web/views/team.js';
import {
  buildScreeningRows, buildFunnelView, formatEventTrail,
} from '../web/views/admin-registration.js';

const CRITERIA = {
  scale: { min: 1, max: 5, scoreMax: 100 },
  dimensions: [
    { key: 'direction', label: '方向维度', weight: 0.25, min: 1, max: 5, items: [
      { id: 'd1', text: 'A' }, { id: 'd2', text: 'B' }, { id: 'd3', text: 'C' },
      { id: 'd4', text: 'D' }, { id: 'd5', text: 'E' },
    ] },
    { key: 'capability', label: '能力维度', weight: 0.35, min: 1, max: 5, items: [
      { id: 'c1', text: 'A' }, { id: 'c2', text: 'B' }, { id: 'c3', text: 'C' },
      { id: 'c4', text: 'D' }, { id: 'c5', text: 'E' },
    ] },
    { key: 'collaboration', label: '协作维度', weight: 0.40, min: 1, max: 5, items: [
      { id: 'l1', text: 'A' }, { id: 'l2', text: 'B' }, { id: 'l3', text: 'C' },
      { id: 'l4', text: 'D' }, { id: 'l5', text: 'E' },
    ] },
  ],
  openQuestion: { required: true, maxLength: 500, prompt: '请说明你的商业问题' },
  levels: [
    { key: 'S', label: '顶级种子', minScore: 80, accept: true },
    { key: 'A', label: '优秀候选', minScore: 60, accept: true },
    { key: 'B', label: '潜力候选', minScore: 40, accept: true },
    { key: 'C', label: '底线外', minScore: 0, accept: false },
  ],
  funnel: [
    { key: 'registration', label: '报名筛选', rate: 0.3 },
    { key: 'incubation', label: '孵化', rate: 0.3 },
    { key: 'sprint', label: '冲刺', rate: 0.2 },
    { key: 'demo_day', label: 'Demo Day', rate: 0.1 },
    { key: 'coaching', label: '辅导期', rate: null },
  ],
};

test('问卷结构：三维各 5 题，每题带维度与分值（R-REG-09 / R-REG-11）', () => {
  const q = buildQuestionnaire(CRITERIA);
  assert.equal(q.dims.length, 3);
  for (const d of q.dims) {
    assert.equal(d.items.length, 5);
    assert.ok(d.weightLabel.endsWith('%'));
    assert.equal(d.max, 5);
  }
  assert.equal(q.open.maxLength, 500);
});

test('明示筛选标准：权重、量表、阈值、且写明 C 级不接收', () => {
  const q = buildQuestionnaire(CRITERIA);
  const text = q.criteriaLines.join('\n');
  assert.ok(text.includes('25%') && text.includes('35%') && text.includes('40%'), text);
  assert.ok(text.includes('80') && text.includes('60') && text.includes('40'), text);
  assert.ok(text.includes('不接收'), '必须明示 C 级不接收');
});

test('可解释明细可读化：每维给出均值 / 权重 / 加权', () => {
  const lines = formatExplain([
    { dimension: 'direction', label: '方向维度', raw: 4.2, weight: 0.25, weighted: 1.05, note: 'x' },
  ], CRITERIA.scale);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.includes('4.2'));
  assert.ok(lines[0].text.includes('25%'));
  assert.ok(lines[0].text.includes('1.05'));
});

test('战队摘要：仅剩 1 人时标出须并队', () => {
  const s = summarizeTeam({
    id: 't1', name: '甲队', status: 'needs_merge', needsMerge: true, mergeDeadline: '2026-10-23T00:00:00.000Z',
    members: [{ userId: 'u1', role: 'captain' }],
    milestones: { items: [{}, {}, {}] },
    formation: { ok: false, errors: ['[TEAM_BELOW_MIN_SIZE]'] },
  });
  assert.equal(s.memberCount, 1);
  assert.equal(s.needsMerge, true);
  assert.ok(s.statusLabel.includes('并队'));
  assert.equal(s.milestoneCount, 3);
  assert.equal(s.formationOk, false);
});

test('筛选台：按等级统计 + 每行带可解释明细与事件轨迹', () => {
  const { rows, distribution, total } = buildScreeningRows([
    {
      id: 'r1', userId: 'u1', level: 'S', levelFinal: 'B', status: 'accepted',
      rawScore: 80, grading: { score: 80, accepted: true, explain: [
        { dimension: 'direction', label: '方向维度', raw: 4.2, weight: 0.25, weighted: 1.05, note: 'x' },
      ] },
      events: [{ toStatus: 'accepted', reason: '复核通过' }],
    },
    { id: 'r2', userId: 'u2', level: 'C', levelFinal: null, status: 'rejected', grading: { score: 30, accepted: false, explain: [] } },
  ], CRITERIA);
  assert.equal(total, 2);
  assert.equal(distribution.B, 1);
  assert.equal(distribution.C, 1);
  assert.equal(rows[0].level, 'B');
  assert.equal(rows[0].autoLevel, 'S');
  assert.equal(rows[0].explain.length, 1);
  assert.equal(rows[0].events.length, 1);
});

test('漏斗视图：5 阶段，第一段给实数，后续标注待填充', () => {
  const view = buildFunnelView([{}, {}, {}], CRITERIA.funnel);
  assert.equal(view.length, 5);
  assert.equal(view[0].current, 3);
  assert.equal(view[1].current, null);
  assert.equal(view[0].target, 1); // round(3 × 0.3)
});

// ── 退出战队的可用性判定（父代理预审修正 Important）─────────────────────
// ⚠️ 原实现把条件**取反**了：按钮只在「当前用户是组长」时可点，
//    而服务端 leaveTeam 对组长抛 409 CAPTAIN_MUST_REPLACE，
//    组员又被禁用 → **两个角色都退不了队**。
//    判定被抽成纯函数 canLeaveTeam（不碰 document），这里直接测边界。
test('退出战队：组员可退、组长不可退（组长要移交）、非成员不可退、未登录不可退', () => {
  const team = {
    id: 't1', name: '甲队', status: 'active',
    members: [
      { userId: 'u1', role: 'captain' },
      { userId: 'u2', role: 'member' },
    ],
  };
  assert.equal(canLeaveTeam(team, 'u2'), true, '组员应当能退出');
  assert.equal(canLeaveTeam(team, 'u1'), false, '组长不能直接退出（服务端 409）');
  assert.equal(canLeaveTeam(team, 'u3'), false, '非成员不能退出别人的队');
  assert.equal(canLeaveTeam(team, null), false, '未登录不能退出');
  assert.equal(canLeaveTeam(null, 'u2'), false, '队不存在时不能退出');
});

test('退出战队：只有 role=captain 的成员才算组长（captainId 缺失时看 team.captainId）', () => {
  const noRoleCaptain = {
    id: 't2', captainId: 'u1', members: [{ userId: 'u1', role: 'member' }, { userId: 'u2', role: 'member' }],
  };
  assert.equal(canLeaveTeam(noRoleCaptain, 'u1'), false, 'team.captainId 是组长 → 不可退');
  assert.equal(canLeaveTeam(noRoleCaptain, 'u2'), true, '其他成员可退');
});

// ── 渲染路径本身也要有覆盖（父代理变异检验发现调用点是盲区）───────────────
// ⚠️ 变异检验实测：把 `canLeaveTeam(t, viewerId)` 换成老写法 `s.captainId === viewerId`，
//    变异体**存活** —— 因为 canLeaveTeam 本身测对了，但**调用点**写错没人知道。
//    修法：把卡片构建抽成纯函数 buildTeamCards，直接断言它产出的 HTML。
test('我的战队页：组员的「退出」按钮可点，组长的不可点（渲染路径）', () => {
  const teams = [{
    id: 't1', name: '甲队', status: 'active',
    members: [
      { userId: 'u1', role: 'captain' },
      { userId: 'u2', role: 'member' },
    ],
  }];
  const asMember = buildTeamCards(teams, 'u2');
  assert.equal(asMember.length, 1);
  assert.ok(!asMember[0].includes(' disabled'), '组员的退出按钮必须可点');
  assert.ok(asMember[0].includes('data-team="t1"'), '必须带上队 id');
  assert.ok(!asMember[0].includes('data-user'), '客户端不再传 userId（服务端只认发起人自己）');

  const asCaptain = buildTeamCards(teams, 'u1');
  assert.ok(asCaptain[0].includes(' disabled'), '组长的退出按钮必须禁用（服务端会 409）');

  const asOutsider = buildTeamCards(teams, 'u9');
  assert.ok(asOutsider[0].includes(' disabled'), '非成员的退出按钮必须禁用');
});

test('我的战队页：队名与成员名仍然走 escapeHtml（渲染路径的转义不能因为抽函数而丢）', () => {
  const cards = buildTeamCards([{
    id: 't1', name: '<img src=x onerror=alert(1)>', status: 'active',
    members: [{ userId: '<script>bad()</script>', role: 'member' }],
  }], 'u2');
  assert.ok(!cards[0].includes('<img src=x'), '队名必须被转义');
  assert.ok(!cards[0].includes('<script>'), '成员 id 必须被转义');
});

// ── 存储型 XSS 防护（父代理预审修正 Critical）────────────────────────────
// ⚠️ 2026-10-21 父代理预审修正（Critical，**存储型 XSS**）：
//    三个新视图把**服务端返回的数据**直接插进 innerHTML，而 P0 的
//    `web/escape.js` 注释早就写明了这个危险：
//      「前端把服务端返回的数据插进 innerHTML……P1 的『报名』端点让用户自选
//        name → 立刻变成可远程利用」。
//    用户可控的插值点（实跑确认）：
//      · 战队名称（POST /api/teams 的 name，选手自填）→ 我的战队页
//      · 任务包标题（POST /api/task-packages 的 title，企业自填）→ 筛选台页
//    两者都进了 innerHTML 且未转义 → 存储型 XSS。
//
// 这条用例做**结构性扫描**：凡是「用户可控字段的裸插值」都必须被 escapeHtml 包住。
// 扫描规则（刻意保守，避免误报）：
//   ① 只看**简单成员链**插值（`${a.b.c}`，不含函数调用）——
//      复合插值（`${xs.map(...)}`）的转义在各自内部单独保证；
//   ② 只盯**用户可控的字段名**：title / name / message / userId / agreement。

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');

// 用户可控的字段名：服务端数据里这些值由**用户自己填**
const USER_CONTROLLED = ['title', 'name', 'message', 'userId', 'agreement'];

function bareInterpolations(source) {
  // 抓出模板字面量里的 ${a.b.c} 形式（不含括号 = 不是函数调用）
  const out = [];
  const re = /\$\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}/g;
  let m = re.exec(source);
  while (m) {
    out.push({ expr: m[1], raw: m[0] });
    m = re.exec(source);
  }
  return out;
}

test('三个视图：用户可控的字段必须经过 escapeHtml 才能进 innerHTML（存储型 XSS 防护）', () => {
  const views = ['views/registration.js', 'views/team.js', 'views/admin-registration.js'];
  const offenders = [];
  for (const v of views) {
    const source = readFileSync(join(webDir, v), 'utf8');
    assert.ok(
      source.includes("from '../escape.js'"),
      `${v} 必须 import escapeHtml`,
    );
    for (const { expr, raw } of bareInterpolations(source)) {
      const last = expr.split('.').pop();
      if (!USER_CONTROLLED.includes(last)) continue;
      // 被 escapeHtml(...) 包住的（形如 escapeHtml(x)）不算裸插值
      if (source.includes(`escapeHtml(${expr})`)) continue;
      offenders.push(`${v}: ${raw}`);
    }
  }
  assert.deepEqual(offenders, [], `以下插值未转义：\n${offenders.join('\n')}`);
});

// ── 筛选台的「事件轨迹」一栏必须真的渲染（父代理预审修正 Important）────────
// ⚠️ 两处空转：
//    ① 后端 `GET /api/registrations`（列表）此前**不挂 events**（只有单条挂）→
//       `buildScreeningRows` 拿到的 `r.events` 恒为 undefined → 轨迹恒空；
//    ② 前端表格里**根本没有「事件轨迹」这一列** → 就算数据有了也没地方显示。
//    后端已在 src/services/registration.js 修好；这里钉住前端这一侧。
test('筛选台：事件轨迹既要在表头出现，也要把每条事件渲染成行', () => {
  const source = readFileSync(join(webDir, 'views', 'admin-registration.js'), 'utf8');
  // ⚠️ 断言必须精确到表头单元格：`includes('事件轨迹')` 会被 formatEventTrail 的
  //    文档注释里的同名串满足 → 删掉表头的变异体会**存活**（父代理变异检验实测）。
  assert.ok(source.includes('<th>事件轨迹</th>'), '表头必须有「事件轨迹」一列');
  // ⚠️ 断言必须精确到**调用点**：原来只查 `includes('r.events')`，
  //    而 buildScreeningRows 里也有 `r.events` → 把渲染换成 `<td>${[].map(...)}</td>`
  //    这个变异体照样存活（父代理变异检验实测）。这里钉住 `formatEventTrail(r.events)`。
  assert.ok(
    source.includes('formatEventTrail(r.events)'),
    '表格里的轨迹单元格必须调用 formatEventTrail(r.events)',
  );
});

test('筛选台：事件轨迹的纯文本格式（状态变迁 + 原因）', () => {
  const lines = formatEventTrail([
    { fromStatus: 'submitted', toStatus: 'screening', reason: '进入筛选' },
    { fromStatus: 'screening', toStatus: 'accepted', reason: null },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('submitted') && lines[0].includes('screening'));
  assert.ok(lines[0].includes('进入筛选'));
  assert.ok(lines[1].includes('accepted'));
  assert.deepEqual(formatEventTrail(null), [], '事件缺省时不得抛错');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/p1-frontend.test.js`
Expected: FAIL —— `Cannot find module '../web/views/registration.js'`

- [ ] **Step 3: 创建 web/views/registration.js**

```javascript
// web/views/registration.js — 报名问卷（选手视角）
// 依据：设计文档 §9「报名问卷：每题显示该题所属维度与分值；明示筛选标准（R-REG-09）；
//       提交后展示『你被判为 X 级』及可解释明细」
// 溯源需求：R-REG-06（3 维 100 分）/ R-REG-07（阈值）/ R-REG-08（C 级不接收）
//            R-REG-09（筛选标准对外透明）/ R-REG-11（3 维各 5 题 + 1 道开放题）
//
// 本轮（P7）「现有页面打磨到生产级」的改动要点：
//   ① 评分控件从 <select> 下拉换成**横排按钮组**（.radio-group / .radio）——
//      1–5 分用下拉框要展开才看得见量表，15 题就是 15 次展开；
//   ② 加载 / 空 / 错三件套统一走 ui.js 的 loadingState / emptyState / errorState，
//      错误态带**真的会重跑**的「重试」按钮；
//   ③ 表单走 .field / .field__label / .input / .textarea 体系，必填项标 .field--required；
//   ④ 顶部加「答题进度」指标卡，提交前就知道还差几题；
//   ⑤ 提交成功展示分级结果（等级 + 总分 + 逐维可解释明细），失败给**说清楚原因**的错误提示。
//
// 本轮（P10 · W4-c）「申诉提交（选手侧）」的改动要点：
//   ⑥ 报名**不接收**时，结果区多一个「提交申诉」入口（R-REG-08）——
//      此前这句话只写在提示条里，**全站没有任何可点的申诉按钮**，
//      选手被告知可以做一件做不到的事；
//   ⑦ 申诉理由**必填**（服务端 fileAppeal 会拒收空理由），提交后就地反馈（成功 / 失败 + 重试）；
//   ⑧ 已接收的选手**看不到**这个入口（没有可申诉的东西，给了就是死路）。
//
// ⛔ buildQuestionnaire / formatExplain / buildResultHtml 是纯函数，不得触碰 document（便于 node:test 直接测）
import { escapeHtml } from '../escape.js';
import {
  emptyState, errorState, kvList, loadingState, noticeState, pageHead, panel,
  statCard, statRow,
} from '../ui.js';

/**
 * 问卷模型（纯函数）。
 *
 * ⚠️ **criteriaLines 的内容不许改**（R-REG-09 的对外承诺）：
 *    「三维权重 25%/35%/40%、每题 1–5 分、阈值 80/60/40、C 级不接收」必须逐字留在页面上，
 *    打磨只改**呈现方式**（noticeState / panel），不改文案本身。
 */
export function buildQuestionnaire(criteria) {
  const dims = (criteria?.dimensions ?? []).map((d) => ({
    key: d.key,
    label: d.label,
    weight: d.weight,
    weightLabel: `${Math.round(d.weight * 100)}%`,
    min: d.min,
    max: d.max,
    items: (d.items ?? []).map((it) => ({ id: it.id, text: it.text })),
  }));
  const levels = criteria?.levels ?? [];
  const scale = criteria?.scale ?? { min: 1, max: 5, scoreMax: 100 };
  const rejected = levels.find((l) => l.accept === false);
  const criteriaLines = [
    `三维权重：${dims.map((d) => `${d.label} ${d.weightLabel}`).join('｜')}`,
    `每题 ${scale.min}–${scale.max} 分，每维 ${dims[0]?.items.length ?? 5} 题取均值后加权，满分 ${scale.scoreMax} 分`,
    `等级阈值：${levels.map((l) => `${l.label} ≥${l.minScore}`).join('｜')}${rejected ? `（${rejected.label} 不接收）` : ''}`,
  ];
  return {
    scale,
    dims,
    levels,
    open: {
      text: criteria?.openQuestion?.prompt ?? '',
      required: criteria?.openQuestion?.required === true,
      maxLength: criteria?.openQuestion?.maxLength ?? 500,
    },
    criteriaLines,
    funnel: criteria?.funnel ?? [],
    ipOwnership: criteria?.ipOwnership ?? {},
    redLines: criteria?.redLines ?? [],
    consentPrompt: criteria?.consent?.prompt ?? '',
  };
}

// 可解释明细：每维「均值 / 权重 / 加权」一行
export function formatExplain(explain, scale = { max: 5 }) {
  return (explain ?? []).map((e) => ({
    dimension: e.dimension,
    label: e.label,
    text: `${e.label}：均值 ${e.raw}/${scale.max}，权重 ${Math.round(e.weight * 100)}%，加权 ${e.weighted}`,
  }));
}

/**
 * 单题的评分控件：1–5 分**横排按钮组**。
 *
 * ⚠️ 为什么不用 <select>：下拉框默认收起，量表（1–5 各代表什么强度）看不见，
 *    选手只能「展开 → 看一眼 → 再收起」，15 题的成本极高。
 *    按钮组把量表摊平成一眼可见的横排（依据：设计文档 §9「每题显示该题所属维度与分值」）。
 */
export function buildRatingField(dim, item, index) {
  const name = `${dim.key}-${index}`;
  const labelId = `lbl-${name}`;
  const values = Array.from({ length: dim.max - dim.min + 1 }, (_, k) => dim.min + k);
  const options = values.map((v) => `
          <label class="radio">
            <input type="radio" name="${escapeHtml(name)}" value="${v}" />
            <span>${v}</span>
          </label>`).join('');
  return `
        <div class="field">
          <span class="field__label" id="${escapeHtml(labelId)}">${escapeHtml(item.text)}</span>
          <div class="radio-group" role="radiogroup" aria-labelledby="${escapeHtml(labelId)}">${options}
          </div>
          <p class="field__hint">每题 ${dim.min}–${dim.max} 分，选一个即可。</p>
        </div>`;
}

/** 一个维度的面板：标题带权重，desc 带量表区间（R-REG-09 明示权重与分值）。 */
export function buildDimensionPanel(dim) {
  return panel({
    title: `${dim.label}（权重 ${dim.weightLabel}）`,
    desc: `共 ${dim.items.length} 题 · 每题 ${dim.min}–${dim.max} 分`,
    body: dim.items.map((it, i) => buildRatingField(dim, it, i)).join(''),
  });
}

/**
 * 合规红线 → 可读文本。
 * ⚠️ 规则文件里 redLines 是**对象数组**（{ key, label }），
 *    直接丢进 noticeState 会被 String() 成「[object Object]」—— 必须取 label。
 */
export function redLineTexts(redLines) {
  return (redLines ?? [])
    .map((r) => (typeof r === 'string' ? r : (r?.label ?? r?.key ?? '')))
    .filter(Boolean);
}

/** 答题进度指标卡（已填题数 / 总题数）。 */
export function buildProgressCard(answered, total) {
  const left = Math.max(0, total - answered);
  return statCard({
    label: '答题进度',
    value: `${answered} / ${total}`,
    hint: left === 0 ? '全部题目已评分，可以提交' : `还有 ${left} 题未评分`,
    tone: left === 0 ? 'success' : 'brand',
  });
}

/**
 * 可解释明细 → 键值表（键 = 维度，值 = 去掉重复维度前缀后的明细）。
 * ⚠️ formatExplain 的文案格式是**契约**（测试直接断言），
 *    所以这里不改文案，只在展示时去掉与键重复的那一段前缀。
 */
export function explainPairs(lines) {
  return (lines ?? []).map((e) => {
    const prefix = `${e.label}：`;
    const value = e.text.startsWith(prefix) ? e.text.slice(prefix.length) : e.text;
    return [e.label, value];
  });
}

// ── 申诉（R-REG-08 · 选手侧）───────────────────────────────────────────────
//
// ⚠️ **端点契约一律以源码为准**（src/http/routes/audit.js + src/services/review-state.js）：
//   POST /api/appeals  body = { subjectType, subjectId, reason }
//     · reason **必填**：服务端 fileAppeal 对空理由抛 400「申诉必须写理由（空理由 = 无法复核）」；
//     · 需要 appeal:write 能力点（seed 里给了 captain / admin）；
//     · 限频：5 秒提交锁 + 60 秒 3 次滑动窗（触发即 429 + Retry-After）。
//   ⇒ 前端**先本地校验空理由**，不发无谓请求；失败必须说清「下一步怎么办」。

/** 申诉理由长度上限（与输入框 maxlength 一致）。 */
export const APPEAL_REASON_MAX = 1000;

/**
 * 申诉入口的出现条件（R-REG-08）：报名**不接收**时才给。
 * ⚠️ 判定口径与结果区的 accepted **逐字一致**（grading.accepted === true 即接收），
 *    两处各判各的会出现「文案说不接收、却没有申诉入口」。
 * ⛔ 没有报名记录 ⇒ 不给入口（没有可申诉的对象）。
 */
export function isAppealable(reg) {
  if (!reg) return false;
  return reg.grading?.accepted !== true;
}

/**
 * 申诉理由校验（纯函数）：空理由**不得提交**（服务端也会拒收）。
 * @returns {{ok: boolean, reason?: string, message?: string}}
 */
export function validateAppealReason(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return { ok: false, message: '申诉理由必填：空理由的申诉无法复核。' };
  if (text.length > APPEAL_REASON_MAX) {
    return { ok: false, message: `申诉理由最多 ${APPEAL_REASON_MAX} 字。` };
  }
  return { ok: true, reason: text };
}

/**
 * 申诉表单（纯函数）：标题 + 理由输入 + 提交按钮 + 反馈区。
 * ⚠️ 表单里的 id 是**契约**（#reg-appeal-reason / #reg-appeal-error /
 *    #reg-appeal-submit / #reg-appeal-feedback）—— 视图与测试都按它取节点。
 */
export function buildAppealForm() {
  return panel({
    title: '提交申诉（R-REG-08）',
    desc: '本级不接收：把理由交给组委会复核。理由必填 —— 空理由的申诉无法复核。',
    body: `
        <div class="field field--required">
          <label class="field__label" for="reg-appeal-reason">申诉理由</label>
          <textarea class="textarea" id="reg-appeal-reason" maxlength="${APPEAL_REASON_MAX}"
            placeholder="说明你为什么认为自己应当被接收（必填）"></textarea>
          <p class="field__hint">最多 ${APPEAL_REASON_MAX} 字。组委会会逐条给结论并写明理由。</p>
          <p class="field__error" id="reg-appeal-error" hidden></p>
        </div>
        <div class="btn-group">
          <button type="button" class="btn btn--primary" id="reg-appeal-submit">提交申诉</button>
        </div>
        <div id="reg-appeal-feedback" class="stack"></div>`,
  });
}

/**
 * 挂载申诉表单并绑定提交（渲染与事件绑定分离）。
 *
 * ⚠️ 为什么**就地反馈**而不是刷新页面：刷新会冲掉选手已经写好的理由，
 *    而且「提交成功/失败」必须一眼可见（点了没反应 = 事故）。
 *
 * @param {object} o
 * @param {HTMLElement} o.container 挂载容器（结果区里的 #reg-appeal）
 * @param {object} o.reg            报名记录（取 id 当申诉对象）
 * @param {object} o.api            API 客户端
 */
export function mountAppealForm({ container, reg, api }) {
  if (!container) return null;
  container.innerHTML = buildAppealForm();
  const btn = container.querySelector('#reg-appeal-submit');
  const reasonBox = container.querySelector('#reg-appeal-reason');
  const errBox = container.querySelector('#reg-appeal-error');
  const out = container.querySelector('#reg-appeal-feedback');

  /** 提交申诉：空理由本地拦下；失败给**可点重试**；成功禁用表单（防重复提交）。 */
  async function submitAppeal() {
    const check = validateAppealReason(reasonBox?.value ?? '');
    if (!check.ok) {
      if (errBox) {
        errBox.textContent = check.message;
        errBox.hidden = false;
      }
      return;
    }
    if (errBox) {
      errBox.textContent = '';
      errBox.hidden = true;
    }
    if (out) out.innerHTML = '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '提交中…';
    }
    try {
      const res = await api.post('/api/appeals', {
        subjectType: 'registration',
        subjectId: reg?.id ?? '',
        reason: check.reason,
      });
      if (out) {
        out.innerHTML = noticeState({
          tone: 'success',
          title: '申诉已提交',
          items: [
            `申诉编号：${res?.id ?? '—'}。组委会会逐条给结论。`,
            '裁决结果会留在报名记录的事件轨迹里，你可以随时回来看。',
          ],
        });
      }
      if (reasonBox) reasonBox.disabled = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '已提交';
      }
    } catch (e) {
      if (out) {
        out.innerHTML = errorState({
          message: '申诉提交失败',
          hint: '服务端返回：' + e.message
            + '。可点「重试」再提交一次；若持续失败，请联系组委会在报名筛选台直接复核你的报名。',
        });
        out.querySelector('[data-action="retry"]')?.addEventListener('click', submitAppeal);
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = '提交申诉';
      }
    }
  }

  btn?.addEventListener('click', submitAppeal);
  return container;
}

/**
 * 结果区 HTML（纯函数）：分级结果 + 申诉入口。
 * ⚠️ **申诉入口只在「不接收」时出现**（R-REG-08）——
 *    已接收的选手没有可申诉的东西，给了入口就是给一条死路。
 */
export function buildResultHtml(reg, model, crit) {
  const levelLabel = model.levels.find((l) => l.key === reg.level)?.label ?? reg.level;
  const accepted = reg.grading?.accepted === true;
  const lines = formatExplain(reg.grading?.explain, crit.scale);
  return `
        ${noticeState({
          tone: accepted ? 'success' : 'warn',
          title: `报名已提交：你被判为 ${reg.level} 级（${levelLabel}）`,
          items: [accepted
            ? '你已被接收，现在可以去组队了。'
            : '本级不接收，可向组委会提交申诉（R-REG-08）。'],
        })}
        ${statRow([
          { label: '总分', value: `${reg.grading?.score ?? 0} 分`, tone: 'brand' },
          { label: '等级', value: `${reg.level}（${levelLabel}）` },
          { label: '是否接收', value: accepted ? '已接收' : '不接收', tone: accepted ? 'success' : 'danger' },
        ])}
        ${panel({
          title: '可解释明细',
          desc: '每一维的均值、权重与加权值 —— 判分口径完全公开（R-REG-09）。',
          body: kvList(explainPairs(lines)),
        })}
        ${accepted ? '' : '<div id="reg-appeal"></div>'}
        <div class="btn-group">
          <button type="button" class="btn btn--primary" id="go-team">去组队</button>
        </div>`;
}

export function renderRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'apply';
  const { api, navigate } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '报名问卷',
      sub: '三个维度的评分 + 1 道开放题；提交后立即给出等级、总分与逐维可解释明细。',
    })}
    <div id="reg-body">${loadingState({ rows: 4, label: '正在加载报名问卷…' })}</div>`;

  const body = wrap.querySelector('#reg-body');

  /** 已评分的题目数（.radio-group 里被勾选的题）。 */
  function countAnswered(form) {
    return form.querySelectorAll('.radio-group input[type="radio"]:checked').length;
  }

  /** 加载问卷；错误态的「重试」按钮复用它（真的重跑一次，不是摆设）。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 4, label: '正在加载报名问卷…' });
    let criteria;
    try {
      criteria = await api.get('/api/registration-criteria');
    } catch (e) {
      body.innerHTML = errorState({
        message: '报名问卷加载失败',
        hint: '接口返回：' + e.message + '。点「重试」重新加载；若持续失败，请确认服务端已启动。',
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
      return;
    }
    renderForm(criteria);
  }

  function renderForm(criteria) {
    const q = buildQuestionnaire(criteria);
    const total = q.dims.reduce((n, d) => n + d.items.length, 0);

    // 空态：配置里还没有维度（本届问卷尚未发布）——必须告诉访客下一步做什么。
    if (!q.dims.length) {
      body.innerHTML = emptyState({
        title: '本届还没有发布报名问卷',
        hint: '组委会发布问卷后，这里会出现三维评分题与开放题；在此之前可以先去看榜单了解赛况。',
      });
      return;
    }

    const form = document.createElement('form');
    form.className = 'stack';
    form.noValidate = true;
    form.innerHTML = `
      ${noticeState({
        tone: 'brand',
        title: '筛选标准（公开透明：报名之前就告诉你）',
        items: q.criteriaLines,
        list: true,
      })}
      ${panel({
        title: '合规与 IP 归属',
        desc: '报名即代表你已阅读并接受下列约定（R-ENT-12）。',
        body: `${kvList([
          ['战队', q.ipOwnership?.team],
          ['组委会', q.ipOwnership?.committee],
          ['企业', q.ipOwnership?.enterprise],
        ])}
        ${redLineTexts(q.redLines).length
          ? noticeState({ tone: 'warn', title: '合规红线', items: redLineTexts(q.redLines), list: true })
          : ''}`,
      })}
      <div id="reg-progress">${buildProgressCard(0, total)}</div>
      ${q.dims.map((d) => buildDimensionPanel(d)).join('')}
      <div class="card">
        <div class="field field--required">
          <label class="field__label" for="reg-open">${escapeHtml(q.open.text || '开放题')}</label>
          <textarea class="textarea" id="reg-open" name="open" maxlength="${q.open.maxLength}"
            placeholder="请说明你的商业问题、目标客户与打算怎么验证（最多 ${q.open.maxLength} 字）"></textarea>
          <p class="field__hint">${q.open.required ? '必填。' : '选填。'}最多 ${q.open.maxLength} 字。</p>
          <p class="field__error" data-role="open-error" hidden></p>
        </div>
        <div class="field field--required">
          <span class="field__label">参赛协议与数据合规</span>
          <label class="checkbox">
            <input type="checkbox" name="consent" />
            <span>${escapeHtml(q.consentPrompt || '我已阅读并同意参赛协议、IP 归属说明与数据合规红线')}</span>
          </label>
          <p class="field__error" data-role="consent-error" hidden></p>
        </div>
        <div class="btn-group">
          <button type="submit" class="btn btn--primary">提交报名</button>
        </div>
        <div id="reg-feedback" class="stack"></div>
      </div>`;

    // 进度随作答实时更新（「我答了几题」必须一眼可见）。
    form.addEventListener('change', () => {
      const box = form.querySelector('#reg-progress');
      if (box) box.innerHTML = buildProgressCard(countAnswered(form), total);
    });

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });

    /** 提交（表单提交与错误态的「重试」都走它）。 */
    async function submit() {
      const feedback = form.querySelector('#reg-feedback');
      const openErr = form.querySelector('[data-role="open-error"]');
      const consentErr = form.querySelector('[data-role="consent-error"]');
      const submitBtn = form.querySelector('button[type="submit"]');
      feedback.innerHTML = '';
      openErr.hidden = true;
      openErr.textContent = '';
      consentErr.hidden = true;
      consentErr.textContent = '';

      const answered = countAnswered(form);
      const missing = total - answered;
      const openValue = form.querySelector('[name="open"]').value.trim();
      const consented = form.querySelector('[name="consent"]').checked;
      // 同意项是否必填：以服务端配置为准（compliance.consent.required）。
      const consentRequired = criteria?.consent?.required === true || Boolean(q.consentPrompt);
      let invalid = false;

      if (missing > 0) {
        invalid = true;
        feedback.innerHTML = noticeState({
          tone: 'danger',
          title: '还有题目没评分',
          items: [`共 ${total} 题，已评分 ${answered} 题，还差 ${missing} 题 —— 每题都要选一个分数（${q.scale.min}–${q.scale.max}）才能提交。`],
        });
      }
      if (q.open.required && !openValue) {
        invalid = true;
        openErr.textContent = '开放题必填：请说明你的商业问题。';
        openErr.hidden = false;
      }
      if (consentRequired && !consented) {
        invalid = true;
        consentErr.textContent = '必须勾选同意参赛协议、IP 归属说明与数据合规红线。';
        consentErr.hidden = false;
      }
      if (invalid) return;

      const answers = { open: openValue };
      for (const d of q.dims) {
        answers[d.key] = d.items.map((_, i) => {
          const hit = form.querySelector(`input[name="${d.key}-${i}"]:checked`);
          return hit ? Number(hit.value) : null;
        });
      }
      answers.consent = { accepted: consented };

      submitBtn.disabled = true;
      submitBtn.textContent = '提交中…';
      try {
        const reg = await api.post('/api/registrations', {
          editionId: criteria.editionId,
          answers,
        });
        showResult(reg, q, criteria);
        // 提交成功后不再允许重复提交（服务端也会以 409 拒绝）。
        submitBtn.disabled = true;
        submitBtn.textContent = '已提交';
      } catch (e) {
        // ⚠️ 失败提示必须说清「下一步怎么办」，不能只回一句 e.message。
        feedback.innerHTML = errorState({
          message: '报名提交失败',
          hint: '服务端返回：' + e.message + '。若是「已提交过本届报名」，说明你此前已报名成功，可直接去「我的战队」；若提示问卷不完整，请确认每题都已评分。',
        });
        // 错误态的「重试」= **重发同一份答案**（不是重新加载页面 —— 那会冲掉已答内容）。
        feedback.querySelector('[data-action="retry"]')?.addEventListener('click', submit);
        submitBtn.disabled = false;
        submitBtn.textContent = '提交报名';
      }
    }

    /** 提交成功：分级结果（等级 + 总分 + 逐维可解释明细）+ 申诉入口（不接收时才给）。 */
    function showResult(reg, model, crit) {
      const feedback = form.querySelector('#reg-feedback');
      feedback.innerHTML = buildResultHtml(reg, model, crit);
      feedback.querySelector('#go-team')?.addEventListener('click', () => navigate('/team'));
      // ⚠️ 申诉入口**只在不接收时**出现（R-REG-08）：容器由 buildResultHtml 一并给出。
      const appealBox = feedback.querySelector('#reg-appeal');
      if (appealBox) mountAppealForm({ container: appealBox, reg, api });
    }

    body.replaceChildren(form);
  }

  load();
  return wrap;
}
```

- [ ] **Step 4: 创建 web/views/team.js**

```javascript
// web/views/team.js — 我的战队（选手视角）
// 依据：设计文档 §9「我的战队 + 组队/汰换」
// 依据：R-REG-01（建队即认领任务包）、R-REG-03（持续招募汰换）、R-REG-04（仅剩 1 人须并队）
//
// 本轮（P7）「现有页面打磨到生产级」的改动要点：
//   ① 战队卡片用 .team-card + badge 标状态（组建中 / 已成立 / 须并队 / 已解散，四种色调）；
//   ② 成员列表从裸 <ul> 改成紧凑表格，组长用 badge('组长','brand') 标出；
//   ③ 成员数 / 里程碑数提到 statCard（信息密度）；
//   ④ needsMerge 用 noticeState(danger) 醒目提示并写清并队截止时间；
//   ⑤ 退出按钮按 canLeaveTeam 决定 disabled，并把「为什么不能退」写在按钮上；
//   ⑥ 组队表单走 .field / .input / .select 体系，**空队名本地拦下**（不发无谓请求）；
//   ⑦ 建队 / 退出后**就地刷新列表**，不再 location.reload()（整页刷新会冲掉用户输入）。
import { escapeHtml } from '../escape.js';
import { iconDot } from '../icons.js';
import {
  badge, emptyRow, emptyState, errorState, loadingState, noticeState,
  pageHead, panel, statRow, tableWrap,
} from '../ui.js';

const STATUS_LABELS = {
  forming: '组建中（未满 2 人）',
  active: '已成立',
  needs_merge: '仅剩 1 人，须并队',
  dissolved: '已解散',
};

/** 卡片上的状态徽章：短标签 + 色调（四种状态四种色调，扫一眼就知道战队处于什么阶段）。 */
const STATUS_BADGES = {
  forming: { label: '组建中', tone: 'info' },
  active: { label: '已成立', tone: 'success' },
  needs_merge: { label: '须并队', tone: 'danger' },
  dissolved: { label: '已解散', tone: 'neutral' },
};

// 组长是谁：优先看成员表里的 role=captain，退回 team.captainId
function resolveCaptainId(team) {
  const members = team?.members ?? [];
  const captain = members.find((m) => m.role === 'captain');
  return captain?.userId ?? team?.captainId ?? '';
}

export function summarizeTeam(team) {
  const members = team?.members ?? [];
  return {
    id: team?.id ?? null,
    title: team?.name ?? '',
    memberCount: members.length,
    status: team?.status ?? 'forming',
    statusLabel: STATUS_LABELS[team?.status] ?? team?.status ?? '',
    captainId: resolveCaptainId(team),
    needsMerge: team?.needsMerge === true,
    mergeDeadline: team?.mergeDeadline ?? null,
    formationOk: team?.formation?.ok === true,
    formationErrors: team?.formation?.errors ?? [],
    milestoneCount: team?.milestones?.items?.length ?? 0,
  };
}

/**
 * 「退出」按钮能不能点：**本人是组员、且不是组长**。
 *
 * ⚠️ P1 Task 6 修正（Important，退出功能完全不可用）：
 *    原来的判定是 `captainId === 当前用户 ? 可点 : 禁用` —— 条件**取反**了：
 *      · 组长可点 → 但服务端 `leaveTeam` 对组长抛 409 `CAPTAIN_MUST_REPLACE`
 *        （组长要移交职责，不能直接退）→ 点了必然报错；
 *      · 组员被禁用 → 明明可以退，却点不动。
 *    结果：**两个角色都退不了队**，整条「持续招募汰换（R-REG-03）」的退出路径在 UI 上是死的。
 *    现在按服务端规则对齐：**组员可退，组长不可退**（移交走汰换接口）。
 */
export function canLeaveTeam(team, viewerId) {
  if (!team || !viewerId) return false;
  if (resolveCaptainId(team) === viewerId) return false;
  return (team?.members ?? []).some((m) => m.userId === viewerId);
}

/** 并队截止时间：能解析就显示本地时间，解析不了就原样显示（不吞数据）。 */
export function formatDeadline(value) {
  if (!value) return '（服务端未给出截止时间）';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 战队卡片 HTML（纯函数，不碰 document）。
 *
 * ⚠️ 为什么抽出来：`renderTeam` 里内联模板时，「退出按钮能不能点」这条**渲染路径**
 *    完全没有测试覆盖 —— canLeaveTeam 本身测对了，但调用点写错也没人知道
 *    （父代理变异检验实测：把 `canLeaveTeam(t, viewerId)` 换成老写法
 *     `s.captainId === viewerId`，变异体**存活** —— 说明调用点是盲区）。
 *    抽成纯函数后，这条路径能被直接断言。
 *
 * ⛔ 两条硬约束（测试直接断言渲染结果）：
 *    ① 不许出现 data-user —— 服务端只认发起人自己，不接受 body.userId；
 *    ② 组员视角的 HTML 里不许出现 disabled —— 组员**必须**能点退出。
 */
export function buildTeamCards(teams, viewerId) {
  return (teams ?? []).map((t) => {
    const s = summarizeTeam(t);
    const leaveable = canLeaveTeam(t, viewerId);
    const isCaptain = Boolean(viewerId) && s.captainId === viewerId;
    const badgeInfo = STATUS_BADGES[s.status] ?? { label: s.status, tone: 'neutral' };
    const hint = leaveable
      ? '退出后若队内仅剩 1 人将触发并队（R-REG-04）；进出记录留档（R-REG-03），可重新组队。'
      : (isCaptain
        ? '组长不能直接退出：需先汰换成员并移交组长职责，否则服务端返回 409 CAPTAIN_MUST_REPLACE。'
        : '你不是该战队成员，无法退出别人的战队。');
    const members = t.members ?? [];
    const memberRows = members.length
      ? members.map((m) => `
            <tr>
              <td>${escapeHtml(m.userId)}</td>
              <td>${m.role === 'captain' ? badge('组长', 'brand') : badge('组员', 'neutral')}</td>
              <td class="muted small">${escapeHtml(m.joinedAt ?? '—')}</td>
            </tr>`).join('')
      : emptyRow(3, '暂无成员');
    return `
        <section class="team-card" data-team="${escapeHtml(s.id)}">
          <div class="row row--between">
            <h2 class="panel__title">${escapeHtml(s.title)}</h2>
            <div class="btn-group">${badge(badgeInfo.label, badgeInfo.tone)}</div>
          </div>
          <p class="muted small">状态：${escapeHtml(s.statusLabel)}</p>
          ${s.needsMerge ? noticeState({
            tone: 'danger',
            title: '须并队：队内仅剩 1 人',
            items: [`请在 ${formatDeadline(s.mergeDeadline)} 前并入其他战队，逾期将无法继续参赛（R-REG-04）。`],
          }) : ''}
          ${s.formationErrors.length ? noticeState({
            tone: 'warn',
            title: '组队校验未通过',
            items: s.formationErrors,
            list: true,
          }) : ''}
          ${statRow([
            { label: '成员', value: s.memberCount, hint: isCaptain ? '你是本队组长' : '' },
            { label: '固定里程碑', value: s.milestoneCount, hint: '报名时固定，赛程中不可自行新增（R-STG-03）' },
            { label: '你的角色', value: isCaptain ? '组长' : (leaveable ? '组员' : '非成员') },
          ])}
          ${tableWrap(`
            <thead><tr><th>成员</th><th>角色</th><th>加入时间</th></tr></thead>
            <tbody>${memberRows}</tbody>`)}
          <div class="btn-group">
            <button type="button" class="btn btn--ghost btn--sm" data-action="leave" data-team="${escapeHtml(s.id)}"${leaveable ? '' : ' disabled'} title="${escapeHtml(hint)}">${leaveable ? '退出战队' : (isCaptain ? '组长不可退' : '非成员不可退')}</button>
          </div>
          <p class="muted small">${escapeHtml(hint)}</p>
        </section>`;
  });
}

/** 战队列表区（纯函数）：空数据时给「下一步做什么」。 */
export function buildTeamList(teams, viewerId) {
  if (!(teams ?? []).length) {
    return emptyState({
      title: '你还没有战队',
      hint: '在下方认领一个任务包并建队 —— 报名是组队的前提（R-REG-01），建队后你自动成为组长。',
    });
  }
  return `<div class="stack">${buildTeamCards(teams, viewerId).join('')}</div>`;
}

/**
 * 段位与权益（纯函数）。
 * ⛔ P11：设计文档 §9 明写「段位与权益」是选手视角的一块界面，
 *    而 `GET /api/teams/:id/tier` 这个端点**早就存在**却**前端从不调用** ⇒ 段位权益永远看不见。
 * @param {object|null} tier GET /api/teams/:id/tier 的返回
 */
export function renderTeamTierHtml(tier) {
  if (!tier) {
    return emptyState({
      title: '还没有段位记录',
      hint: '队伍完成里程碑并经企业确认后，段位会在发榜时出现在这里。',
    });
  }
  const benefits = Array.isArray(tier.benefits) ? tier.benefits : [];
  const neverUnlocks = Array.isArray(tier.neverUnlocks) ? tier.neverUnlocks : [];
  const reasons = Array.isArray(tier.reasons) ? tier.reasons : [];
  const milestones = Array.isArray(tier.progress?.milestones) ? tier.progress.milestones : [];
  return `
    <div class="row">
      ${badge(tier.tier ?? 'D', 'brand')}
      ${badge(tier.tierName ?? '—', 'info')}
      ${badge(`已计分里程碑 ${tier.milestoneCount ?? '—'} 项`, 'neutral')}
    </div>
    ${benefits.length
      ? `<h3 class="section-title">已解锁的权益</h3>
         <ul class="milestones">${benefits.map((b) => `<li class="todo"><span class="mark">${iconDot(14)}</span><span>${escapeHtml(b)}</span></li>`).join('')}</ul>`
      : `<p class="muted small">当前段位还没有解锁任何权益。</p>`}
    ${neverUnlocks.length
      ? noticeState({
        tone: 'info',
        title: '不解锁的权益',
        items: neverUnlocks,
        list: true,
      })
      : ''}
    ${reasons.length
      ? noticeState({ tone: 'info', title: '段位原因', items: reasons.map((r) => String(r)), list: true })
      : ''}
    ${milestones.length
      ? `<h3 class="section-title">里程碑</h3>
         <ul class="milestones">${milestones.map((m) => `<li class="todo"><span class="mark">${iconDot(14)}</span><span>${escapeHtml(m.label ?? m.key)}</span></li>`).join('')}</ul>`
      : ''}`;
}

/**
 * 行为分提交表单（纯函数）。
 * ⛔ P11：`POST /api/teams/:id/behavior-events` 这个写端点**前端从不调用**
 *    ⇒ rules/behavior-points.json 的五类事件**一条都采不到** ⇒ 行为分永远是 0
 *    ⇒ 破同分链的最后一级（行为分）恒为 0 ⇒ 这一级形同虚设。
 * ⚠️ 事件清单**来自服务端**（GET /api/event-info 的 behaviorEvents）⇒ 前端不硬编码赛制数字。
 * @param {Array<object>} events 服务端给的行为事件定义
 */
export function renderBehaviorFormHtml(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    return emptyState({
      title: '没有可提交的行为事件',
      hint: '行为事件清单来自服务端规则（rules/behavior-points.json），没有配置就是没有。',
    });
  }
  const options = list
    .map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.label ?? e.key)}（${escapeHtml(e.points ?? '—')} 分）</option>`)
    .join('');
  return `
    <div class="field">
      <label class="field__label" for="behavior-type">事件类型</label>
      <select class="select" id="behavior-type" data-behavior="type">${options}</select>
    </div>
    <div class="field field--required">
      <label class="field__label" for="behavior-evidence">证据（可运行链接 / 阻塞点 / 会议纪要）</label>
      <textarea class="textarea" id="behavior-evidence" rows="3" data-behavior="evidence"></textarea>
      <p class="field__hint">证据不合规不予计分（服务端用同一套口径校验）。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="behavior-submit">提交行为记录</button>
    </div>
    <div class="form-feedback" data-feedback="behavior"></div>`;
}

export function renderTeam(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'team';
  const { api } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '我的战队',
      sub: '查看你参与的战队、认领任务包并组队；组长需先移交职责才能退出（R-REG-03）。',
    })}
    <div id="team-body">${loadingState({ rows: 3, label: '正在加载我的战队…' })}</div>`;

  const body = wrap.querySelector('#team-body');
  const viewerId = ctx.getState().user?.id ?? null;
  let criteria = null;

  /** 只刷新「战队列表」这一块：建队 / 退出后不必重载整页（也就不用 location.reload()）。 */
  async function refreshTeams() {
    const listBox = body.querySelector('#team-list');
    if (!listBox) return;
    const res = await api.get('/api/teams');
    const teams = res?.items ?? res?.rows ?? [];
    listBox.innerHTML = buildTeamList(teams, viewerId);
    bindLeaveButtons();
  }

  /** 加载页面：问卷 + 战队 + 任务包一起取。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 3, label: '正在加载我的战队…' });
    try {
      const [crit, teamsRes, packagesRes] = await Promise.all([
        api.get('/api/registration-criteria'),
        api.get('/api/teams'),
        api.get('/api/task-packages'),
      ]);
      criteria = crit;
      const teams = teamsRes?.items ?? teamsRes?.rows ?? [];
      const packages = packagesRes?.items ?? packagesRes?.rows ?? [];
      render(teams, packages);
    } catch (e) {
      body.innerHTML = errorState({
        message: '我的战队加载失败',
        hint: '接口返回：' + e.message + '。点「重试」重新加载；若持续失败，请确认服务端已启动且你已登录。',
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
    }
  }

  function render(teams, packages) {
    const opts = packages
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)}</option>`)
      .join('');
    body.innerHTML = `
      <div class="stack">
        <div id="team-list-feedback"></div>
        <div id="team-list">${buildTeamList(teams, viewerId)}</div>
        ${panel({
          title: '组队（报名即认领任务包）',
          desc: '认领的任务包必须已完成六维可解性分级（R-REG-01）；建队后你是组长。',
          body: `
            <div class="field field--required">
              <label class="field__label" for="team-name">队名</label>
              <input class="input" id="team-name" name="team-name" maxlength="40" placeholder="例：甲队" />
              <p class="field__hint">队名会展示给组委会与对手，请勿填写敏感信息。</p>
              <p class="field__error" data-role="name-error" hidden></p>
            </div>
            <div class="field">
              <label class="field__label" for="team-package">认领任务包</label>
              <select class="select" id="team-package" name="package">${opts}</select>
              <p class="field__hint">${packages.length
                ? '认领后不可自行更换（R-REG-01）。'
                : '当前没有可认领的任务包 —— 请等组委会发布任务卡后再建队。'}</p>
            </div>
            <div class="btn-group">
              <button type="button" class="btn btn--primary" id="create-team"${packages.length ? '' : ' disabled'}>建队</button>
            </div>
            <div id="team-feedback"></div>`,
        })}
        ${panel({
          title: '段位与权益',
          desc: '设计文档 §9 的「段位与权益」：段位来自里程碑与未撤回的企业签字，发榜时重算。',
          body: `
            <div class="field">
              <label class="field__label" for="tier-team">选择战队</label>
              <select class="select" id="tier-team" data-tier="team">
                ${teams.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name ?? t.id)}</option>`).join('')
                  || '<option value="">（你还没有战队）</option>'}
              </select>
            </div>
            <div id="tier-box">${loadingState({ rows: 1, label: '正在加载段位…' })}</div>`,
        })}
        ${panel({
          title: '行为分记录',
          desc: '行为分只用于破同分（排序末级，权重上限 10%）。不提交就是 0 分。',
          body: `
            <div class="field">
              <label class="field__label" for="behavior-team">选择战队</label>
              <select class="select" id="behavior-team" data-behavior="team">
                ${teams.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name ?? t.id)}</option>`).join('')
                  || '<option value="">（你还没有战队）</option>'}
              </select>
            </div>
            <div id="behavior-box">${loadingState({ rows: 1, label: '正在加载行为事件清单…' })}</div>`,
        })}
      </div>`;

    bindCreateButton(packages.length > 0);
    bindLeaveButtons();
    bindTierAndBehavior(teams);
  }

  /**
   * 段位与权益 + 行为分提交（P11）。
   * ⛔ 这两个读口/写口早就存在，但**前端从不调用** ⇒
   *    · 段位权益永远看不见；· 行为分永远是 0。
   */
  function bindTierAndBehavior(teams) {
    const tierTeam = body.querySelector('#tier-team');
    const tierBox = body.querySelector('#tier-box');
    const behaviorTeam = body.querySelector('#behavior-team');
    const behaviorBox = body.querySelector('#behavior-box');
    if (!tierBox || !behaviorBox) return;

    const loadTier = async () => {
      const teamId = tierTeam?.value ?? '';
      if (!teamId) {
        tierBox.innerHTML = emptyState({ title: '你还没有战队', hint: '建队之后这里会显示段位与已解锁的权益。' });
        return;
      }
      tierBox.innerHTML = loadingState({ rows: 1, label: '正在加载段位…' });
      try {
        const tier = await api.get(`/api/teams/${encodeURIComponent(teamId)}/tier`);
        tierBox.innerHTML = renderTeamTierHtml(tier);
      } catch (e) {
        tierBox.innerHTML = errorState({
          message: e.message,
          hint: '段位记录可能在发榜后才生成（D 段队伍对外不可见，这是设计口径）。',
        });
      }
    };

    const loadBehavior = async () => {
      const teamId = behaviorTeam?.value ?? '';
      if (!teamId) {
        behaviorBox.innerHTML = emptyState({ title: '你还没有战队', hint: '建队之后这里可以提交行为记录。' });
        return;
      }
      behaviorBox.innerHTML = loadingState({ rows: 1, label: '正在加载行为事件清单…' });
      try {
        const info = await api.get('/api/event-info');
        behaviorBox.innerHTML = renderBehaviorFormHtml(info?.behaviorEvents ?? []);
        behaviorBox.dataset.teamId = teamId;
      } catch (e) {
        behaviorBox.innerHTML = errorState({ message: e.message, hint: '行为事件清单来自服务端规则，拉不到就点重试。' });
      }
    };

    tierTeam?.addEventListener('change', () => { loadTier(); });
    behaviorTeam?.addEventListener('change', () => { loadBehavior(); });
    void loadTier();
    void loadBehavior();

    // 提交行为记录
    behaviorBox.addEventListener('click', async (ev) => {
      const btn = ev.target?.closest?.('[data-action="behavior-submit"]');
      if (!btn) return;
      const teamId = behaviorTeam?.value ?? '';
      const type = body.querySelector('[data-behavior="type"]')?.value ?? '';
      const evidence = body.querySelector('[data-behavior="evidence"]')?.value ?? '';
      const slot = behaviorBox.querySelector('[data-feedback="behavior"]');
      if (!teamId || !type) {
        if (slot) slot.innerHTML = errorState({ message: '还差一点信息', hint: '先选战队与事件类型。' });
        return;
      }
      btn.disabled = true;
      try {
        const out = await api.post(`/api/teams/${encodeURIComponent(teamId)}/behavior-events`, { type, evidence });
        if (slot) {
          slot.innerHTML = noticeState({
            tone: 'success',
            title: '已提交行为记录',
            items: [`本条计 ${escapeHtml(String(out?.points ?? 0))} 分（行为分只用于破同分，不进主分）。`],
          });
        }
      } catch (e) {
        if (slot) {
          slot.innerHTML = errorState({ message: e.message, hint: '证据不合规会被服务端拒（不予计分）。' });
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  /** 建队：空队名**本地拦下**（不发请求），成功后就地刷新列表。 */
  function bindCreateButton(enabled) {
    const btn = body.querySelector('#create-team');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const nameInput = body.querySelector('[name="team-name"]');
      const nameErr = body.querySelector('[data-role="name-error"]');
      const feedback = body.querySelector('#team-feedback');
      nameErr.hidden = true;
      nameErr.textContent = '';
      feedback.innerHTML = '';

      const name = nameInput.value.trim();
      if (!name) {
        // ⛔ 空队名本地拦下：发过去也是被服务端拒，没必要打一次网络。
        nameErr.textContent = '队名不能为空：请先给战队起一个名字。';
        nameErr.hidden = false;
        nameInput.focus();
        return;
      }
      const pkg = body.querySelector('[name="package"]');
      if (!pkg || !pkg.value) {
        feedback.innerHTML = errorState({
          message: '建队失败',
          hint: '没有可认领的任务包：请等组委会发布任务卡后再建队（R-REG-01）。',
          retry: false,
        });
        return;
      }

      btn.disabled = true;
      btn.textContent = '建队中…';
      try {
        await api.post('/api/teams', {
          editionId: criteria?.editionId,
          name,
          taskPackageId: pkg.value,
        });
        nameInput.value = '';
        feedback.innerHTML = noticeState({
          tone: 'success',
          title: '建队成功',
          items: ['你已成为本队组长：可以招募组员，也可以在成员卡里管理退出与汰换。'],
        });
        await refreshTeams();
      } catch (e) {
        feedback.innerHTML = errorState({
          message: '建队失败',
          hint: '服务端返回：' + e.message + '。若是「没有建队的权限」或「任务包未分级」，请先完成报名或等组委会完成任务卡分级。',
        });
        // 重试 = 用**当前输入**再发一次（队名还在输入框里）。
        feedback.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
          feedback.innerHTML = '';
          btn.click();
        });
      } finally {
        btn.disabled = !enabled;
        btn.textContent = '建队';
      }
    });
  }

  /** 退出：组员可退，组长 / 非成员由 canLeaveTeam 判定为 disabled（服务端会 409）。 */
  function bindLeaveButtons() {
    for (const btn of body.querySelectorAll('[data-action="leave"]')) {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const teamId = btn.dataset.team;
        const feedback = body.querySelector('#team-list-feedback');
        btn.disabled = true;
        btn.textContent = '退出中…';
        try {
          // ⚠️ 父代理预审修正：退出**只作用于发起人自己** ——
          //    服务端不再接受 body.userId（否则任何人都能把别人踢出战队）。
          await api.post(`/api/teams/${encodeURIComponent(teamId)}/members`, { action: 'leave' });
          if (feedback) {
            feedback.innerHTML = noticeState({
              tone: 'success',
              title: '已退出战队',
              items: ['退出记录已留档（R-REG-03）；若队内仅剩 1 人，本队将进入并队观察期（R-REG-04）。'],
            });
          }
          await refreshTeams();
        } catch (e) {
          if (feedback) {
            feedback.innerHTML = errorState({
              message: '退出失败',
              hint: '服务端返回：' + e.message + '。若提示 CAPTAIN_MUST_REPLACE，说明你是组长：需先汰换成员并移交组长职责。',
            });
            feedback.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
              feedback.innerHTML = '';
              btn.click();
            });
          }
          btn.disabled = false;
          btn.textContent = '退出战队';
        }
      });
    }
  }

  load();
  return wrap;
}
```

- [ ] **Step 5: 创建 web/views/admin-registration.js**

```javascript
// web/views/admin-registration.js — 组委会筛选台
// 依据：设计文档 §9「报名筛选台（含可解释明细）+ 复核/申诉/改级」「任务包与配比 70/30」
// 溯源：R-REG-09 / R-REG-10（5 阶段筛选漏斗）/ R-ENT-09（任务包配比）
//
// 本轮（P7）「现有页面打磨到生产级」的改动要点：
//   ① 顶部 statRow：报名总数 + 各等级人数 + 任务包配比是否达标；
//   ② 漏斗与分级分布从纯文本 <ul> 改成 barRow 条形图（第一段是实数，后续段标「待填充」）；
//   ③ 主表用 tableWrap 包起来（窄屏横向滚动，表头 sticky），表头含「事件轨迹」一列；
//   ④ 改级操作放在每行的操作列：复核级别 .select + 复核意见 .input + .btn--primary 按钮；
//   ⑤ 改级成功**就地更新该行**并给成功提示，失败给错误提示 —— 不用 location.reload()
//      （整页刷新会冲掉其他行已填的复核意见，是生产级事故）。
//
// ⛔ 前端**不做可见性过滤**（全局约束）：API 返回什么就渲染什么，一个都不许丢。
import { escapeHtml } from '../escape.js';
import { formatExplain } from './registration.js';
import {
  badge, barRow, emptyRow, emptyState, errorState, kvList, loadingState, noticeState,
  pageHead, panel, statRow, tableWrap,
} from '../ui.js';

const STATUS_LABELS = {
  submitted: '已提交',
  screening: '筛选中',
  accepted: '已接收',
  rejected: '不接收',
  appealed: '申诉中',
};

/** 状态 → 徽章色调。 */
const STATUS_TONES = {
  submitted: 'info',
  screening: 'info',
  accepted: 'success',
  rejected: 'danger',
  appealed: 'warn',
};

export function buildScreeningRows(registrations, criteria) {
  const levels = criteria?.levels ?? [];
  const rows = (registrations ?? []).map((r) => {
    const effective = r.levelFinal ?? r.level;
    return {
      id: r.id,
      userId: r.userId,
      level: effective,
      autoLevel: r.level,
      levelLabel: levels.find((l) => l.key === effective)?.label ?? '',
      score: r.grading?.score ?? r.rawScore ?? null,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status] ?? r.status,
      accepted: r.grading?.accepted === true,
      explain: formatExplain(r.grading?.explain, criteria?.scale),
      events: r.events ?? [],
    };
  });
  const distribution = {};
  for (const l of levels) {
    distribution[l.key] = rows.filter((r) => r.level === l.key).length;
  }
  return { rows, distribution, total: rows.length };
}

/**
 * 事件轨迹 → 一行一条的纯文本（纯函数，不碰 document）。
 *
 * ⚠️ 为什么要抽出来：轨迹的**渲染路径**此前既没有单元测试，结构扫描也只查
 *    `source.includes('r.events')` —— 而 `buildScreeningRows` 里也有 `r.events`，
 *    于是「把渲染改成 `<td>${[].map(...)}</td>`」这个变异体**存活**
 *    （父代理变异检验实测）。抽成纯函数后可以直接断言它的输出。
 */
export function formatEventTrail(events) {
  return (events ?? []).map((ev) => (
    `${ev.fromStatus ?? '—'} → ${ev.toStatus ?? '—'}${ev.reason ? `（${ev.reason}）` : ''}`
  ));
}

export function buildFunnelView(registrations, funnel) {
  const total = (registrations ?? []).length;
  return (funnel ?? []).map((stage, i) => ({
    key: stage.key,
    label: stage.label,
    rate: stage.rate,
    current: i === 0 ? total : null,
    target: stage.rate === null ? null : Math.round(total * stage.rate),
    note: i === 0 ? '本届报名实数' : '待 P2/P3 的赛段结果填充',
  }));
}

/** 等级键 → 「S（顶级种子）」这样的可读文本。 */
export function levelText(key, levels) {
  if (!key) return '—';
  const label = (levels ?? []).find((l) => l.key === key)?.label ?? '';
  return label ? `${key}（${label}）` : key;
}

/**
 * 报名明细表（纯函数）：表头 + 每一行。
 * ⚠️ 「事件轨迹」这一列必须真的渲染（测试直接断言表头与调用点）。
 */
export function buildScreeningTable(rows, criteria) {
  const levels = criteria?.levels ?? [];
  const head = `
        <thead>
          <tr>
            <th>用户</th>
            <th>系统分级</th>
            <th>复核级别</th>
            <th>分数</th>
            <th>状态</th>
            <th>可解释明细</th>
            <th>事件轨迹</th>
            <th>操作</th>
          </tr>
        </thead>`;
  const body = (rows ?? []).map((r) => {
    const trail = formatEventTrail(r.events);
    return `
          <tr data-id="${escapeHtml(r.id)}">
            <td>${escapeHtml(r.userId)}</td>
            <td>${escapeHtml(r.autoLevel)}</td>
            <td data-cell="level">${escapeHtml(levelText(r.level, levels))}</td>
            <td class="td-num" data-cell="score">${escapeHtml(r.score ?? '—')}</td>
            <td data-cell="status">${badge(r.statusLabel, STATUS_TONES[r.status] ?? 'neutral')}</td>
            <td>${r.explain.map((e) => escapeHtml(e.text)).join('<br />')}</td>
            <td data-cell="events">${trail.length
              ? trail.map((line) => escapeHtml(line)).join('<br />')
              : '<span class="muted">—</span>'}</td>
            <td>
              <select class="select" data-role="level">
                ${levels.map((l) => `<option value="${escapeHtml(l.key)}"${l.key === r.level ? ' selected' : ''}>${escapeHtml(l.key)}（${escapeHtml(l.label)}）</option>`).join('')}
              </select>
              <input class="input" data-role="note" placeholder="复核意见" />
              <button type="button" class="btn btn--primary btn--sm" data-role="save">改级</button>
              <p class="small" data-role="feedback" hidden></p>
            </td>
          </tr>`;
  }).join('');
  return `${head}
        <tbody>${body || emptyRow(8, '本届还没有报名记录')}</tbody>`;
}

export function renderAdminRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-registration';
  const { api } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '报名筛选台',
      sub: '委员会工作台：查看分级分布与筛选漏斗，逐份复核并改级（每一行都能改，不需要刷新页面）。',
    })}
    <div id="admin-body">${loadingState({ rows: 4, label: '正在加载报名筛选台…' })}</div>`;

  const body = wrap.querySelector('#admin-body');
  let criteria = null;

  /** 加载筛选台；错误态的「重试」按钮复用它（真的重跑一次）。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 4, label: '正在加载报名筛选台…' });
    let registrations = [];
    let packages = [];
    let mix = null;
    try {
      criteria = await api.get('/api/registration-criteria');
      const edition = encodeURIComponent(criteria?.editionId ?? '');
      const [regRes, pkgRes] = await Promise.all([
        api.get(`/api/registrations?editionId=${edition}`),
        api.get(`/api/task-packages?editionId=${edition}`),
      ]);
      // ⚠️ 真实后端返回 { items }，演示适配器返回 { rows } —— 两种都收下，
      //    但**不按任何条件过滤**：API 返回什么就渲染什么。
      registrations = regRes?.items ?? regRes?.rows ?? [];
      packages = pkgRes?.items ?? pkgRes?.rows ?? [];
      mix = pkgRes?.mix ?? null;
    } catch (e) {
      body.innerHTML = errorState({
        message: '报名筛选台加载失败',
        hint: '接口返回：' + e.message + '。点「重试」重新加载；若持续失败，请确认服务端已启动且你的账号有组委会权限。',
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
      return;
    }
    render(registrations, packages, mix);
  }

  function render(registrations, packages, mix) {
    const { rows, distribution, total } = buildScreeningRows(registrations, criteria);
    const funnel = buildFunnelView(registrations, criteria?.funnel);
    const levels = criteria?.levels ?? [];

    const statCards = [
      { label: '报名总数', value: total, tone: 'brand' },
      ...levels.map((l) => ({
        label: `${l.key} 级 · ${l.label}`,
        value: distribution[l.key] ?? 0,
      })),
      {
        label: '任务包配比',
        value: mix ? (mix.ok ? '达标' : '未达标') : '无数据',
        hint: mix ? '自由命题 30% + B 端 70%' : '需要组委会权限且任务包已发布',
        tone: mix ? (mix.ok ? 'success' : 'danger') : 'neutral',
      },
    ];

    const funnelBars = funnel.map((f) => barRow({
      label: f.label,
      // 第一段是本届报名实数；后续段还没有赛段结果 ⇒ 明确标注「待填充」，不假装有数。
      value: f.current === null ? '待填充' : f.current,
      max: total || 1,
      note: f.target === null ? '无目标人数' : `目标 ${f.target} 人`,
      tone: f.current === null ? 'info' : 'brand',
    })).join('');

    const distributionBars = levels.map((l) => {
      const count = distribution[l.key] ?? 0;
      return barRow({
        label: `${l.key}（${l.label}）`,
        value: count,
        max: total || 1,
        note: `占 ${Math.round((count / (total || 1)) * 100)}%`,
        tone: 'brand',
      });
    }).join('');

    const packageRows = packages.map((p) => `
            <tr>
              <td>${escapeHtml(p.title)}</td>
              <td>${p.isFreeBrief
                ? badge('自由命题', 'brand')
                : badge(`B 端 ${p.solvabilityGrade ?? '未分级'}`, p.solvabilityGrade ? 'info' : 'warn')}</td>
              <td>${escapeHtml(p.agreement ?? '')}</td>
            </tr>`).join('');

    body.innerHTML = `
      <div class="stack">
        ${statRow(statCards)}
        ${panel({
          title: '筛选漏斗（R-REG-10）',
          desc: '第一段是本届报名实数，后续阶段的结果要等赛段跑完才有。',
          body: `${funnelBars || '<p class="muted">本届还没有配置筛选漏斗。</p>'}
            ${criteria?.funnelNote ? noticeState({ tone: 'info', items: [criteria.funnelNote] }) : ''}`,
        })}
        ${panel({
          title: `分级分布（共 ${total} 人）`,
          desc: '按最终级别统计（含组委会改级后的结果）。',
          body: distributionBars || '<p class="muted">本届还没有配置等级档位。</p>',
        })}
        ${panel({
          title: '任务包配比（R-ENT-09：70% B 端 + 30% 自由）',
          desc: '体检对象是已发布（进池）的任务卡。',
          body: `${mix ? kvList([
            ['自由命题', `${mix.free} / ${mix.total}（${Math.round(mix.actualFree * 100)}%）`],
            ['B 端任务包', `${mix.enterprise} 张`],
            ['目标', '自由命题 30% + B 端 70%（A 40% / B 20% / C 10%，容差 ±10 个百分点）'],
            ['结论', mix.ok ? '配比达标' : '配比未达标'],
          ]) : '<p class="muted">暂无配比体检数据（需要组委会权限且任务包已发布）。</p>'}
            ${mix && !mix.ok ? noticeState({ tone: 'danger', title: '配比未达标', items: mix.errors ?? [], list: true }) : ''}
            ${packageRows
              ? tableWrap(`
            <thead><tr><th>任务包</th><th>类型</th><th>企业承诺</th></tr></thead>
            <tbody>${packageRows}</tbody>`)
              : emptyState({ title: '还没有任务包', hint: '组委会提交并分级任务卡后，这里会列出全部任务包与配比体检结果。' })}`,
        })}
        ${panel({
          title: '报名明细',
          desc: '每行都能复核改级：选级别 → 写意见 → 点「改级」，结果就地更新。',
          body: `${rows.length ? '' : emptyState({
            title: '本届还没有报名记录',
            hint: '有选手提交报名后，这里会逐条列出分级、分数、可解释明细与事件轨迹。',
          })}
            <div id="admin-feedback"></div>
            ${rows.length ? tableWrap(buildScreeningTable(rows, criteria), { caption: '报名明细' }) : ''}`,
        })}
      </div>`;

    bindSaveButtons();
  }

  /** 改级成功后就地刷新这一行（不整页刷新 —— 那会冲掉其他行已填的复核意见）。 */
  function paintRow(tr, data) {
    const levels = criteria?.levels ?? [];
    const level = data.levelFinal ?? data.level;
    const levelCell = tr.querySelector('[data-cell="level"]');
    const scoreCell = tr.querySelector('[data-cell="score"]');
    const statusCell = tr.querySelector('[data-cell="status"]');
    const eventsCell = tr.querySelector('[data-cell="events"]');
    if (levelCell) levelCell.textContent = levelText(level, levels);
    if (scoreCell) scoreCell.textContent = String(data.grading?.score ?? data.rawScore ?? '—');
    if (statusCell) {
      statusCell.innerHTML = badge(STATUS_LABELS[data.status] ?? data.status, STATUS_TONES[data.status] ?? 'neutral');
    }
    if (eventsCell && Array.isArray(data.events)) {
      const trail = formatEventTrail(data.events);
      eventsCell.innerHTML = trail.length
        ? trail.map((line) => escapeHtml(line)).join('<br />')
        : '<span class="muted">—</span>';
    }
  }

  /** 重新拉这一条报名（拿到权威的轨迹）；拉不到就用改级接口的返回值兜底。 */
  async function refreshOne(regId, fallback) {
    try {
      return await api.get(`/api/registrations/${encodeURIComponent(regId)}`);
    } catch {
      return fallback;
    }
  }

  function bindSaveButtons() {
    for (const btn of body.querySelectorAll('[data-role="save"]')) {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const regId = tr.dataset.id;
        const levelSelect = tr.querySelector('[data-role="level"]');
        const noteInput = tr.querySelector('[data-role="note"]');
        const feedbackCell = tr.querySelector('[data-role="feedback"]');
        const level = levelSelect.value;
        const note = noteInput.value.trim();
        btn.disabled = true;
        btn.textContent = '提交中…';
        if (feedbackCell) feedbackCell.hidden = true;
        try {
          const updated = await api.post(`/api/registrations/${encodeURIComponent(regId)}/level`, { level, note });
          const fresh = await refreshOne(regId, updated);
          paintRow(tr, fresh);
          if (levelSelect) levelSelect.value = fresh.levelFinal ?? fresh.level ?? level;
          const who = fresh.userId ?? '';
          showFeedback('success', `已改级：${who} → ${levelSelect.value} 级`);
          if (feedbackCell) {
            feedbackCell.textContent = `已改级为 ${levelSelect.value} 级`;
            feedbackCell.className = 'small muted';
            feedbackCell.hidden = false;
          }
        } catch (e) {
          const message = '改级失败：' + e.message;
          if (feedbackCell) {
            feedbackCell.textContent = message;
            feedbackCell.className = 'small err';
            feedbackCell.hidden = false;
          }
          showFeedback('danger', message);
        } finally {
          btn.disabled = false;
          btn.textContent = '改级';
        }
      });
    }
  }

  /** 全局提示区（表格正上方）：成功 / 失败都看得见。 */
  function showFeedback(tone, message) {
    const box = body.querySelector('#admin-feedback');
    if (!box) return;
    box.innerHTML = noticeState({
      tone,
      title: tone === 'success' ? '改级成功' : '改级未完成',
      items: [message],
    });
  }

  load();
  return wrap;
}
```

- [ ] **Step 6: 修改 web/app.js**

```javascript
// ① 顶部 import 追加
import { renderRegistration } from './views/registration.js';
import { renderTeam } from './views/team.js';
import { renderAdminRegistration } from './views/admin-registration.js';

// ② route 追加三页
// P1 三页：报名 / 我的战队 / 组委会筛选台
route('/apply', () => renderRegistration(ctx));
route('/team', () => renderTeam(ctx));
route('/admin/registration', () => renderAdminRegistration(ctx));

// ③ renderHome 的 nav 追加入口
      <a href="#/apply">报名</a>
      <a href="#/team">我的战队</a>
      <a href="#/admin/registration">筛选台</a>
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/p1-frontend.test.js`
Expected: PASS（13 个测试全过：p1-frontend 13）

- [ ] **Step 8: 提交**

```bash
cd platform && git add web/views web/app.js test/p1-frontend.test.js \
  src/db/repo/registrationEvents.js src/services/registration.js test/registration-service.test.js
git commit -m "feat(P1): 前端三页（报名问卷明示筛选标准 / 我的战队 / 组委会筛选台）

对应需求：R-REG-09 / R-REG-10 / R-REG-03 / R-REG-04 / R-ENT-09"
```

---

### Task 7: 端到端串联 + 种子扩充 + 验收

**Files:**
- Create: `platform/test/e2e-p1.test.js`
- Create: `platform/test-helpers/http-call.js`（三个 API 测试文件里逐字相同的 HTTP 调用器抽成共享工具）
- Modify: `platform/scripts/seed.js`（P0 建立；P1 追加 P1 种子 + 角色能力补 `task_package:read`）
- Modify: `platform/test/registration-api.test.js`（Task 3 建立；改用共享调用器）
- Modify: `platform/test/task-package-api.test.js`（Task 4 建立；改用共享调用器）
- Modify: `platform/test/team-api.test.js`（Task 5 建立；改用共享调用器）

**Interfaces:**
- Consumes: Task 1–6 全部产物
- Produces:
  - `test/e2e-p1.test.js` —— 三层：① **服务层**全链路（「报名 → 分级 → 建队 → 认领任务包 → 加人」）；② **HTTP 层**全链路（出题 → 评估 → 签级 → 报名 → 建队 → 加人 → 成立）+ 能力点拦截与可见性；③ **种子产物**的三条断言（角色已授予且能力点真的生效 / 配比达标且自由题进池 / 幂等重入）
  - `test-helpers/http-call.js` —— `call(app, method, path, {token, body})`、`callJson(...)`（进程内 HTTP 调用器）
  - `scripts/seed.js` 的 P1 种子：1 届期 + 1 城市 + **11 张任务卡**（进池 10 = 4A + 2B + 1C + 3 自由；另 1 张 D 级退回）+ 4 名选手报名（S/A/B/C 四档）+ 1 支已成立的战队
  - 角色能力映射补 `captain`/`member` 的 `task_package:read`（选手要能看见已发布的任务包才能认领）
  - ⚠️ **每个种子用户都必须显式授角色** —— `createUser` 不分配角色，不授则演示版是死的

- [ ] **Step 1: 写失败的测试**

`platform/test/e2e-p1.test.js`：

```javascript
// platform/test/e2e-p1.test.js —— P1 端到端串联
//
// 依据：P1 计划 Task 7「端到端串联 + 种子扩充 + 验收」
// 溯源需求：R-REG-01 / R-REG-02 / R-REG-05 / R-REG-08 / R-STG-03 / R-ENT-08 / R-ENT-09
//
// ⚠️ 本文件刻意分两层：
//   ① **服务层**全链路（计划原规格的两条）：验证业务规则串起来是对的；
//   ② **HTTP 层**全链路（Task 7 预审新增）：验证**路由层**也串得起来。
//      为什么必须补这一层：Task 3 / Task 4 / Task 5 的真实缺陷**全部出在路由层**
//      （能力点校验没接线、列表端点缺字段、越权踢人），服务层测不出来。
//   ③ **种子产物**的三条：种子是演示版唯一的数据来源，它的正确性不能靠肉眼看控制台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { submitRegistration } from '../src/services/registration.js';
import { assessSolvability, approveTaskPackage, listTaskPackages } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';
import { checkTaskMix } from '../src/domain/solvability.js';
import { can, grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');
const webDir = join(platformDir, 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const ANSWERS = {
  direction: [5, 5, 5, 5, 5],
  capability: [5, 5, 5, 5, 5],
  collaboration: [5, 5, 5, 5, 5],
  open: '我想解决连锁门店的排班与库存协同问题',
  consent: { accepted: true },
};
const FULL_SOLVABILITY = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  return { db, close, dataDir, rules, edition };
}

// ── ① 服务层全链路 ────────────────────────────────────────────────────────

test('全链路：报名 → 分级 → 建队（认领任务包）→ 加人 → 战队成立', () => {
  const s = setup();
  const captain = createUser(s.db, { name: '队长', phone: '13900006001', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(s.db, { name: '组员', phone: '13900006002', password: 'pw', mbaStatus: 'mba' });

  // 1) 企业出题 → 2) 六维评估 → 3) 分级签约
  const pkg = createTaskPackage(s.db, {
    editionId: s.edition.id, enterpriseName: '某零售', title: '门店排班优化',
    painPoint: 'p', expectedDelivery: 'd', acceptanceCriteria: 'a',
    submittedBy: captain.id, now: NOW,
  });
  assessSolvability({
    db: s.db, taskPackageId: pkg.id, answers: FULL_SOLVABILITY, actorId: captain.id, now: NOW, rules: s.rules,
  });
  const approved = approveTaskPackage({
    db: s.db, taskPackageId: pkg.id, grade: 'A', actorId: captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(approved.grade, 'A');
  assert.equal(approved.status, 'published');

  // 4) 报名 → 自动分级
  const reg1 = submitRegistration({
    db: s.db, userId: captain.id, editionId: s.edition.id, answers: ANSWERS, now: NOW, rules: s.rules,
  });
  const reg2 = submitRegistration({
    db: s.db, userId: member.id, editionId: s.edition.id, answers: ANSWERS, now: NOW, rules: s.rules,
  });
  assert.equal(reg1.level, 'S');
  assert.equal(reg1.grading.accepted, true);
  assert.equal(reg2.level, 'S');

  // 5) 建队即认领任务包
  const team = createTeam({
    db: s.db, userId: captain.id, editionId: s.edition.id,
    taskPackageId: pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.equal(team.taskPackageId, pkg.id);
  assert.equal(team.status, 'forming');
  assert.equal(team.memberCount, 1);
  assert.equal(team.milestones.items.length, 7, 'R-STG-03：里程碑清单在组队时固定');

  // 6) 加人 → 满 2 人即成立
  const after = addMember({
    db: s.db, teamId: team.id, userId: member.id, actorId: captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(after.memberCount, 2);
  assert.equal(after.status, 'active');
  assert.equal(after.formation.ok, true);

  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('全链路：C 级报名被拒 → 不能入队（R-REG-08）', () => {
  const s = setup();
  const captain = createUser(s.db, { name: '队长', phone: '13900006101', password: 'pw', mbaStatus: 'mba' });
  const weak = createUser(s.db, { name: '弱', phone: '13900006102', password: 'pw', mbaStatus: 'mba' });
  const pkg = createTaskPackage(s.db, {
    editionId: s.edition.id, title: '题', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: captain.id, now: NOW,
  });
  assessSolvability({
    db: s.db, taskPackageId: pkg.id, answers: FULL_SOLVABILITY, actorId: captain.id, now: NOW, rules: s.rules,
  });
  approveTaskPackage({ db: s.db, taskPackageId: pkg.id, grade: 'A', actorId: captain.id, now: NOW, rules: s.rules });

  submitRegistration({
    db: s.db, userId: captain.id, editionId: s.edition.id, answers: ANSWERS, now: NOW, rules: s.rules,
  });
  const weakReg = submitRegistration({
    db: s.db, userId: weak.id, editionId: s.edition.id,
    answers: {
      direction: [1, 1, 1, 1, 1], capability: [1, 1, 1, 1, 1], collaboration: [1, 1, 1, 1, 1],
      open: '还在想', consent: { accepted: true },
    },
    now: NOW, rules: s.rules,
  });
  assert.equal(weakReg.level, 'C');
  assert.equal(weakReg.grading.accepted, false);

  const team = createTeam({
    db: s.db, userId: captain.id, editionId: s.edition.id,
    taskPackageId: pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.throws(
    () => addMember({
      db: s.db, teamId: team.id, userId: weak.id, actorId: captain.id, now: NOW, rules: s.rules,
    }),
    (err) => err.code === 'REGISTRATION_NOT_ACCEPTED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

// ── ② HTTP 层全链路（Task 7 预审新增）────────────────────────────────────

function setupHttp() {
  const s = setup();
  const { db, rules, edition } = s;
  const captain = createUser(db, { name: '队长', phone: '13900006201', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(db, { name: '组员', phone: '13900006202', password: 'pw', mbaStatus: 'mba' });
  const enterprise = createUser(db, { name: '企业', phone: '13900006203', password: 'pw', mbaStatus: 'other' });
  const admin = createUser(db, { name: '组委会', phone: '13900006204', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '路人', phone: '13900006205', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  // 能力点必须先注册（grantAssignment 会校验）—— 不注册会抛 CAPABILITY_UNKNOWN
  for (const [key, desc] of [
    ['registration:write', '提交报名'], ['registration:review', '审核报名分级'],
    ['team:create', '创建战队'], ['team:read', '读取战队'], ['team:manage', '管理战队成员'],
    ['task_package:read', '读取任务卡'], ['task_package:write', '提交/编辑任务卡'],
    ['task_package:approve', '任务卡分级签约'],
  ]) insertCapability(db, key, desc);

  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  for (const cap of ['registration:write', 'team:create', 'team:read', 'task_package:read']) grant(captain.id, cap);
  for (const cap of ['registration:write', 'team:read', 'task_package:read']) grant(member.id, cap);
  for (const cap of ['task_package:write', 'task_package:read']) grant(enterprise.id, cap);

  const app = createApp({ db, rules, webDir });
  return {
    ...s,
    app,
    captain, member, enterprise, admin, outsider,
    tokenCaptain: createSession(db, captain.id).token,
    tokenMember: createSession(db, member.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

test('HTTP 全链路：出题 → 评估 → 签级 → 报名 → 建队 → 加人 → 成立', async () => {
  const s = setupHttp();
  const json = (res) => JSON.parse(res.body);

  // 1) 企业提交任务卡（HTTP 层走能力点校验）
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise,
    body: {
      editionId: s.edition.id, title: '门店排班优化', painPoint: 'p',
      expectedDelivery: 'd', acceptanceCriteria: 'a', consent: { accepted: true },
    },
  });
  assert.equal(created.status, 200, `企业出题应成功：${created.body}`);
  const pkgId = json(created).id;

  // 2) 六维评估 → 3) 组委会签级（超管）
  const assessed = await call(s.app, 'POST', `/api/task-packages/${pkgId}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL_SOLVABILITY },
  });
  assert.equal(assessed.status, 200, `六维评估应成功：${assessed.body}`);
  const approved = await call(s.app, 'POST', `/api/task-packages/${pkgId}/approve`, {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(approved.status, 200, `签级应成功：${approved.body}`);
  assert.equal(json(approved).grade, 'A');

  // 4) 队长报名 → 5) 建队（认领任务包）
  const reg = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, answers: ANSWERS },
  });
  assert.equal(reg.status, 200, `报名应成功：${reg.body}`);
  assert.equal(json(reg).level, 'S');
  const regId = json(reg).id;

  const team = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenCaptain,
    body: { editionId: s.edition.id, taskPackageId: pkgId, name: '甲队' },
  });
  assert.equal(team.status, 200, `建队应成功：${team.body}`);
  const teamId = json(team).id;
  assert.equal(json(team).status, 'forming');
  assert.equal(json(team).taskPackageId, pkgId, '建队即认领任务包（R-REG-01）');

  // 6) 组员自助加入 → 满 2 人即成立
  const memberReg = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenMember, body: { editionId: s.edition.id, answers: ANSWERS },
  });
  assert.equal(memberReg.status, 200);
  const joined = await call(s.app, 'POST', `/api/teams/${teamId}/members`, {
    token: s.tokenMember, body: { action: 'add' },
  });
  assert.equal(joined.status, 200, `组员加入应成功：${joined.body}`);
  assert.equal(json(joined).memberCount, 2);
  assert.equal(json(joined).status, 'active');

  // 7) 「我的战队」可见
  const mine = await call(s.app, 'GET', '/api/teams', { token: s.tokenCaptain });
  assert.equal(mine.status, 200);
  assert.equal(json(mine).items.length, 1);
  assert.equal(json(mine).items[0].id, teamId);

  // 8) 组委会看得到报名 + 事件轨迹（Task 6 的列表端点修复在 HTTP 层生效）
  const all = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(all.status, 200);
  assert.equal(json(all).items.length, 2);
  assert.ok(Array.isArray(json(all).items[0].events), '列表必须带事件轨迹');
  assert.ok(json(all).items[0].events.length >= 1, '提交报名本身就是一条轨迹');

  // 9) 委员会改级 → 选手读到的终态
  const decided = await call(s.app, 'POST', `/api/registrations/${regId}/level`, {
    token: s.tokenAdmin, body: { level: 'B', note: '复核降级' },
  });
  assert.equal(decided.status, 200, `改级应成功：${decided.body}`);
  assert.equal(json(decided).levelFinal, 'B');

  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('HTTP 层：能力点拦截 + 可见性过滤（三态状态码）', async () => {
  const s = setupHttp();
  const json = (res) => JSON.parse(res.body);

  // 无 team:create 的路人 → 403（禁用），不是 404
  const denied = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, taskPackageId: 'nope', name: '野队' },
  });
  assert.equal(denied.status, 403, `无建队权限应 403：${denied.body}`);

  // 未登录 → 401
  const anon = await call(s.app, 'POST', '/api/teams', {
    body: { editionId: s.edition.id, taskPackageId: 'nope', name: '野队' },
  });
  assert.equal(anon.status, 401);

  // 选手读报名列表 → 200 + 空集（可见性在 API 层过滤）
  const list = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenCaptain });
  assert.equal(list.status, 200);
  assert.deepEqual(json(list).items, [], '无 registration:review 的选手看不到任何报名');

  // 读他人报名 → 404
  const reg = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, answers: ANSWERS },
  });
  const other = await call(s.app, 'GET', `/api/registrations/${json(reg).id}`, { token: s.tokenMember });
  assert.equal(other.status, 404, `读他人报名应 404：${other.body}`);

  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

// ── ③ 种子产物（Task 7 预审新增）──────────────────────────────────────────

/**
 * 跑真实种子脚本（子进程）。
 * ⛔ 用**子进程**而不是 import：种子脚本有顶层副作用（建管理员、退出码 1 等），
 *    部署手册里执行的就是这个脚本 —— 测它就该测它本身。
 */
function runSeed(dataDir) {
  return execFileSync(process.execPath, [join(platformDir, 'scripts', 'seed.js')], {
    cwd: platformDir,
    env: { ...process.env, ADMIN_PASSWORD: 'e2e-test-admin-pw', DATA_DIR: dataDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function openSeeded(dataDir) {
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  return { db, close, rules };
}

test('种子产物：每个用户都被授予角色，能力点真的生效（演示版不能是死的）', () => {
  // ⚠️ Task 7 预审修正（Critical）：原规格建了 4 个选手 + 1 个企业代表却**没授角色**
  //    → 演示版里他们登录后报名 403、建队 403、看不到任务包，整个演示是死的。
  //    这里断言的是**能力点的实际效果**（can() 是唯一判定入口），不是数据表内容。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  runSeed(dataDir);
  const { db, close, rules } = openSeeded(dataDir);

  const byName = (name) => db.prepare(
    "SELECT id, name FROM users WHERE name = ? AND active = 1",
  ).get(name);

  const captain = byName('队长甲');
  const member = byName('组员乙');
  const enterprise = byName('某零售·企业代表');
  assert.ok(captain && member && enterprise, '种子必须建出这三个用户');

  assert.equal(can(captain, 'registration:write', null, db), true, '队长必须能报名');
  assert.equal(can(captain, 'team:create', null, db), true, '队长必须能建队');
  assert.equal(can(captain, 'task_package:read', null, db), true, '队长必须能看见已发布的任务包');
  assert.equal(can(member, 'registration:write', null, db), true, '组员必须能报名');
  assert.equal(can(member, 'task_package:read', null, db), true, '组员必须能看见已发布的任务包');
  assert.equal(can(member, 'team:create', null, db), false, '组员不该有建队权限');
  assert.equal(can(enterprise, 'task_package:write', null, db), true, '企业必须能出题');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('种子产物：进池 10 张卡，配比精确命中 R-ENT-09（40/20/10/30），D 级已出诊断报告', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  runSeed(dataDir);
  const { db, close, rules } = openSeeded(dataDir);

  // ⚠️ 只能用**服务层呈现的驼峰形状**喂 checkTaskMix ——
  //    它读 `p.isFreeBrief`，喂数据库行（`is_free_brief`）会把自由题算成 0
  //    （Task 4 的 T4-2 形状错配，预审时本任务自己又踩了一次）。
  const items = listTaskPackages({ db, filter: {}, viewer: { id: 'seed', is_superadmin: 1 }, rules });
  const published = items.filter((p) => p.status === 'published');
  const mix = checkTaskMix(published, rules.solvability);
  assert.equal(mix.ok, true, `配比必须达标：${JSON.stringify(mix.errors)}`);
  assert.equal(mix.total, 10);
  assert.equal(mix.free, 3);
  assert.equal(mix.byGrade.A, 4);
  assert.equal(mix.byGrade.B, 2);
  assert.equal(mix.byGrade.C, 1);

  // 自由题必须**已签级并进池**（原规格 grade: null → 永远不进池 → 自由占比恒 0）
  const free = published.filter((p) => p.isFreeBrief);
  assert.equal(free.length, 3, '三张自由题必须进池');
  assert.ok(free.every((p) => p.grade), '自由题也必须签级');
  assert.ok(free.every((p) => p.commitment === '无'), 'R-ENT-10：自由命题无企业签字');

  // D 级卡：退回 + 出《问题可解性诊断报告》（R-ENT-08）
  const d = items.find((p) => p.grade === 'D');
  assert.ok(d, '必须有一张 D 级卡用于演示');
  assert.equal(d.status, 'returned');
  assert.equal(d.meta?.solvability?.diagnosticReport?.title, '问题可解性诊断报告');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('种子产物：跑第二遍不崩、数据不翻倍（部署时会重跑种子）', () => {
  // ⚠️ Task 7 预审修正（Important）：原规格直接 createUser → 第二次跑
  //    PHONE_TAKEN（409）直接崩 —— 部署手册里的「跑一次种子」会变成地雷。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  runSeed(dataDir);
  const out = runSeed(dataDir);
  assert.ok(out.includes('P1 种子'), `第二遍种子仍应跑通：${out}`);

  const { db, close, rules } = openSeeded(dataDir);
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count('SELECT COUNT(*) n FROM task_packages'), 11, '任务卡不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM registrations'), 4, '报名不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM teams'), 1, '战队不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM editions'), 1, '届期不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM cities'), 1, '城市不得翻倍');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/e2e-p1.test.js`
Expected: FAIL —— 断言不成立（Task 1–6 尚未全部落地时跑）

- [ ] **Step 3: 创建共享 HTTP 调用器 + 修改 scripts/seed.js**

**先抽共享调用器**：三个 API 测试文件（registration-api / task-package-api / team-api）里
**各抄了一份逐字相同**的进程内 HTTP 调用器（md5 一致）—— 改一处要改三处，必然漂移。
按全局约束「共享测试 helper 必须放 `platform/test-helpers/`」抽出去，三个文件改为 import。

`platform/test-helpers/http-call.js`：

```javascript
// platform/test-helpers/http-call.js — 进程内 HTTP 调用器（测试专用共享工具）
//
// 依据：P1 Task 7 预审（重复代码清理）。
//   `call(app, method, path, {token, body})` 此前在**三个** API 测试文件里
//   各抄了一份（**逐字相同**，md5 一致）—— 改一处要改三处，必然漂移。
//   三个文件分别是：registration-api / task-package-api / team-api。
//
// ⛔ 它是**测试辅助工具**，不是被测代码：放在 test-helpers/ 下，
//    零依赖守卫（test/zero-deps.test.js 的 SCAN_DIRS 含 'test-helpers'）会一起扫，
//    本文件只用 Node 标准库（Buffer / Promise），符合「零 npm 依赖」承诺。
//
// ⚠️ 为什么是「进程内」而不是真起一个服务器：
//    它走的是 **app.handle → 路由 → 中间件 → 会话解析 → 错误映射** 的完整链路，
//    只是省掉了 socket 与 HTTP 报文编解码 —— 路由层的缺陷（能力点校验、
//    三态状态码、可见性过滤）一样能被测到。真正的 socket 级用例在
//    test/server.test.js（路径穿越 / 静态文件）。
//
// ⚠️ 返回值是 `{ status, headers, body }`（body 是**字符串**，要自己 JSON.parse）。
//
// ⛔ 纯函数、零依赖、零 IO。

/**
 * 在进程内发一次请求。
 *
 * @param {object} app `createApp({ db, rules, webDir })` 的返回值
 * @param {string} method HTTP 方法（GET / POST / PATCH / DELETE）
 * @param {string} path 请求路径（含 query）
 * @param {{ token?: string|null, body?: any }} [options]
 *   `token` → 带上 `Cookie: hk_session=<token>`（P0 的会话 cookie 名）
 *   `body`  → 会被 JSON 序列化并声明 `Content-Type: application/json`
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function call(app, method, path, { token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers: token ? { cookie: `hk_session=${token}` } : {},
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
      on() {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
      end(payload) {
        if (payload) this.body = payload.toString();
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };
    app.handle(req, res);
  });
}

/**
 * `call` + JSON 解析的便捷封装。
 * 响应体不是合法 JSON 时把原文挂在 `res.text` 上（便于断言错误文本）。
 */
export async function callJson(app, method, path, options = {}) {
  const res = await call(app, method, path, options);
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { ...res, json, text: res.body };
}
```

**再改种子**（`scripts/seed.js` 是 **P0 建立**的文件，本阶段是 **Modify**）：

`platform/scripts/seed.js`：

> ⚠️ **2026-10-21 父代理预审后改为「整文件」呈现**（原规格是「追加 import 与 P1 种子块」的
> 操作指令型片段）。原因：本任务对种子的改动覆盖了 import、角色能力映射、种子主流程调用、
> 以及新增的 `seedP1` 函数**四处**，片段式呈现无法逐字校验；
> 改成整文件后，一致性检查器能对 `scripts/seed.js` 做**逐字比对**（计划是规格）。
> `scripts/seed.js` 是 **P0 建立**的文件，本阶段是 **Modify（追加语义）**，不是重建。

`platform/scripts/seed.js`：

```javascript
// scripts/seed.js — 种子数据：能力点、角色、角色能力映射、初始管理员
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser, findUserByPhone, setSuperadmin } from '../src/db/repo/users.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { createEdition, listEditions } from '../src/db/repo/editions.js';
import { createCity, listCitiesByEdition } from '../src/db/repo/cities.js';
import { listTaskPackagesByEdition } from '../src/db/repo/taskPackages.js';
import { findActiveRegistration } from '../src/db/repo/registrations.js';
import { listTeamRows } from '../src/db/repo/teams.js';
import { submitRegistration } from '../src/services/registration.js';
import { submitTaskPackage, assessSolvability, approveTaskPackage } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';
import { loadRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

// ⛔ 预审修正（I7-2）：管理员口令**不兜底**。
//    原来写 `process.env.ADMIN_PASSWORD || 'change-me-now'` —— 一个写死在代码里的
//    公开口令当组委会超管口令（预审实测已打印出来）。P6 之后这套脚本要跑在公网机器上，
//    与项目原则「校验不过就拒绝启动，绝不降级为默认值」直接冲突。
//    没有 ADMIN_PASSWORD → 明确报错 + 退出码 1，**不创建任何账号**。
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  console.error('缺少环境变量 ADMIN_PASSWORD，拒绝创建管理员账号（不提供默认口令）。');
  console.error("用法：ADMIN_PASSWORD='你的密码' node scripts/seed.js");
  process.exit(1);
}

const CAPABILITIES = [
  ['registration:write', '提交报名'],
  ['registration:review', '审核报名分级'],
  ['team:create', '创建战队'],
  ['team:read', '读取战队'],
  ['team:manage', '管理战队成员'],
  ['task_package:read', '读取任务卡'],
  ['task_package:write', '提交/编辑任务卡'],
  ['task_package:approve', '任务卡分级签约'],
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['peer_review:write', '互评'],
  ['self_review:write', '提交本队自评'],
  ['signoff:create', '企业里程碑签字'],
  ['behavior:write', '提交行为分记录（周进度 / workshop 产出 / 企业对接会）'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['audit:write', '裁决复核项与申诉'],
  ['appeal:write', '提交申诉'],
  ['pool:read', '读取三池'],
  ['pool:write', '维护三池'],
];

const ROLES = [
  ['admin', '组委会'],
  ['captain', '队长'],
  ['member', '组员'],
  ['judge', '评委席'],
  ['enterprise', '企业席'],
  ['observer', '观察员（无投票权）'],
  ['enterprise_admin', '企业管理员'],
];

/** P1 演示届期名（种子幂等的锚点：按名字认领已存在的届期，不重复建）。 */
const EDITION_NAME = '首届 · 上海';

const ROLE_CAPABILITIES = [
  ['admin', 'registration:review'], ['admin', 'team:read'], ['admin', 'team:manage'],
  ['admin', 'task_package:read'], ['admin', 'task_package:approve'], ['admin', 'score:read'],
  ['admin', 'stage:compute'], ['admin', 'audit:read'], ['admin', 'audit:write'], ['admin', 'appeal:write'], ['admin', 'pool:read'], ['admin', 'pool:write'],
  ['captain', 'registration:write'], ['captain', 'team:create'], ['captain', 'team:read'], ['captain', 'behavior:write'],
  ['captain', 'team:manage'], ['captain', 'pool:read'], ['captain', 'task_package:read'],
  ['captain', 'peer_review:write'], ['captain', 'self_review:write'], ['captain', 'appeal:write'],
  ['member', 'registration:write'], ['member', 'team:read'], ['member', 'pool:read'], ['member', 'behavior:write'],
  ['member', 'task_package:read'], ['member', 'peer_review:write'], ['member', 'self_review:write'],
  // ⚠️ DP-106：**组员也是选手** —— 他同样要对自己的**报名分级结果**提申诉
  //    （R-REG-08：分级不接收时选手可向组委会申诉）。
  //    此前只有 captain 与 admin 持有 appeal:write ⇒ 组员点「提交申诉」被 403「无权提交申诉」。
  ['member', 'appeal:write'],
  ['judge', 'score:write'], ['judge', 'score:read'], ['judge', 'peer_review:write'], ['judge', 'task_package:read'],
  ['enterprise', 'score:write'], ['enterprise', 'score:read'], ['enterprise', 'signoff:create'],
  ['enterprise', 'task_package:read'], ['enterprise', 'task_package:write'], ['enterprise', 'pool:read'],
  ['observer', 'score:read'], ['observer', 'team:read'], ['observer', 'task_package:read'],
  ['enterprise_admin', 'task_package:write'], ['enterprise_admin', 'signoff:create'], ['enterprise_admin', 'pool:read'],
];

const { db, close } = openDatabase({ dataDir });
try {
  applyMigrations(db, join(here, '..', 'db', 'migrations'));

  // ⛔ 评审修正（I-7）：种子数据写入一律走仓储层 ——
  //    本文件**不再出现任何 SQL 字符串**（全局约束「所有 SQL 收进 src/db/repo/」）。
  for (const [key, description] of CAPABILITIES) insertCapability(db, key, description);

  for (const [key, description] of ROLES) insertRole(db, key, description);

  for (const [role, cap] of ROLE_CAPABILITIES) insertRoleCapability(db, role, cap);

  const adminPhone = process.env.ADMIN_PHONE || '13800000000';
  // 查重走仓储层（findUserByPhone 取的行里不含 password_hash）
  // ⛔ 评审修正（I-7）：这条注释原来写「不写裸 SQL」，**却和同一文件里的裸 SQL 自相矛盾**
  //    —— 现在本文件确实一条 SQL 字符串都没有了：种子写入全部下沉到 src/db/repo/。
  let admin = findUserByPhone(db, adminPhone);
  if (!admin) {
    admin = createUser(db, {
      name: '组委会管理员', phone: adminPhone, password: adminPassword, mbaStatus: 'mba',
    });
    setSuperadmin(db, admin.id);
    insertUserRole(db, admin.id, 'admin');
    // 只打印账号，不回显口令
    console.log(`已创建管理员：${adminPhone}  ← 请立即修改密码`);
  } else {
    console.log(`管理员已存在：${adminPhone}`);
  }
  // P1 演示数据（届期 / 任务卡 / 选手报名 / 战队）
  const { rules } = loadRules(join(here, '..', 'rules'));
  seedP1({ db, rules, adminId: admin.id });
  console.log(`种子完成：${CAPABILITIES.length} 个能力点，${ROLES.length} 个角色，${ROLE_CAPABILITIES.length} 条角色能力映射`);
} finally {
  close();
}

// ── P1 演示数据 ─────────────────────────────────────────────────────────
/**
 * P1 种子：1 届期 + 1 城市 + 11 张任务卡 + 4 名选手报名 + 1 支已成立的战队。
 *
 * ⚠️ **角色必须显式授予**（P1 Task 7 预审修正 Critical）：
 *    `createUser` **不分配任何角色**（角色在 `user_roles` 表）。
 *    原规格建了 4 个选手 + 1 个企业代表却没授角色 →
 *    演示版里这些人登录后报名 403、建队 403、看不到任务包，
 *    整个演示是死的（预审探针：`user_roles` 里他们的 `role_key` 全是 `null`；
 *    只有管理员有 `admin` 角色）。原规格自己加的
 *    「captain/member 补 `task_package:read`」也因此**完全落空** ——
 *    根本没人持有 captain / member 这两个角色。
 *
 * ⚠️ **配比必须达标**（P1 Task 7 预审修正 Important）：
 *    R-ENT-09 要求任务池构成 A 40% / B 20% / C 10% / 自由 30%（容差 ±10%）。
 *    原规格 6 张卡凑不出这个比例，而且自由题 `grade: null` → 永远签不了级 →
 *    不进池 → 自由占比恒为 0%。预审实跑 `checkTaskMix`：
 *    `[TASK_MIX_FREE] 自由命题占比 0%，目标 30%`。
 *    现在进池 **10 张**：4 张 A + 2 张 B + 1 张 C + 3 张自由 = 精确命中 40/20/10/30；
 *    另加 1 张 **D 级**卡（六维 0 分 → 退回 + 出《问题可解性诊断报告》）演示 D 档。
 *
 * ⚠️ **幂等**（P1 Task 7 预审修正 Important）：
 *    种子会被重复执行（部署时重跑、崩溃后重跑）。原规格直接 `createUser` →
 *    第二次跑 `PHONE_TAKEN`（409）直接崩掉 —— 部署手册里的「跑一次种子」会变成地雷。
 *    现在每个实体都「先查后建」，与 P0 种子自己的 `findUserByPhone` 同一约定。
 *
 * ⚠️ **走服务层而不是仓储层**（P1 Task 7 预审修正 Important）：
 *    原规格直接调 `createTaskPackage` 仓储并手搓 `meta`，
 *    于是 R-ENT-01（字段完整）/ R-ENT-12（同意记录）/ R-ENT-10（自由题不挂企业）
 *    这些**服务层才有的校验**在种子路径上全部绕开 —— 种子与生产两套口径。
 *    现在改调 `submitTaskPackage` 服务层，`meta` 由服务层生成。
 */
function seedP1({ db, rules, adminId, now = '2026-10-20T00:00:00.000Z' }) {
  // 先查后建（幂等）
  const ensureUser = (spec) => {
    const found = findUserByPhone(db, spec.phone);
    return found ?? createUser(db, spec);
  };

  const edition = listEditions(db).find((e) => e.name === EDITION_NAME)
    ?? createEdition(db, {
      name: EDITION_NAME, city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now,
    });
  if (!listCitiesByEdition(db, edition.id).some((c) => c.name === '上海')) {
    createCity(db, { name: '上海', editionId: edition.id });
  }

  const enterprise = ensureUser({
    name: '某零售·企业代表', phone: '13800000001', password: 'demo-pw',
    mbaStatus: 'other', org: '某零售',
  });
  insertUserRole(db, enterprise.id, 'enterprise');

  // 六维作答模板：每一档都按「该档位的分值区间」构造，
  // 让卡片的评估分与组委会签的级**自洽**（否则演示里会出现「评估 11 分却签 C」的怪事）。
  // ⚠️ data_access 与 accountability 都不能取 0 —— 取 0 会命中一票否决
  //    （无法提供数据授权说明 / 无企业侧唯一责任人），被强制退回 D。
  const ANSWERS = {
    A: { problem_clarity: 3, data_access: 3, validation: 2, decision_chain: 1, accountability: 1, precedent: 1 },
    B: { problem_clarity: 2, data_access: 2, validation: 2, decision_chain: 1, accountability: 1, precedent: 1 },
    C: { problem_clarity: 1, data_access: 1, validation: 1, decision_chain: 0, accountability: 1, precedent: 1 },
    D: { problem_clarity: 2, data_access: 0, validation: 1, decision_chain: 0, accountability: 0, precedent: 0 },
  };

  // 进池 10 张：4×A + 2×B + 1×C + 3×自由（R-ENT-09 精确命中 40/20/10/30）
  // ＋ 1 张 D 级卡（退回 + 诊断报告，演示 D 档）
  const specs = [
    { title: '门店排班优化', grade: 'A', free: false },
    { title: '供应链需求预测', grade: 'A', free: false },
    { title: '会员复购预测', grade: 'A', free: false },
    { title: '门店能耗优化', grade: 'A', free: false },
    { title: '客服知识库问答', grade: 'B', free: false },
    { title: '选品需求预测', grade: 'B', free: false },
    { title: '门店陈列合规巡检', grade: 'C', free: false },
    { title: '开源模型微调实验', grade: 'A', free: true },
    { title: '公共数据问诊助手', grade: 'B', free: true },
    { title: '公益法律问答助手', grade: 'A', free: true },
    { title: '社区养老排班助手', grade: 'D', free: false },
  ];

  const existing = new Map(listTaskPackagesByEdition(db, edition.id).map((p) => [p.title, p]));
  const packages = [];
  for (const spec of specs) {
    let pkg = existing.get(spec.title) ?? null;
    if (!pkg) {
      const submitted = submitTaskPackage({
        db,
        userId: spec.free ? adminId : enterprise.id,
        payload: {
          editionId: edition.id,
          title: spec.title,
          painPoint: `${spec.title}：目前靠人工，效率低且不可复制`,
          expectedDelivery: '可运行原型 + 一次真实数据验证',
          acceptanceCriteria: '门店负责人认可并愿意试点',
          // R-ENT-10：自由命题**不挂企业主体**（企业签字对自由题不成立）
          enterpriseId: spec.free ? null : enterprise.id,
          enterpriseName: spec.free ? null : '某零售',
          isFreeBrief: spec.free,
          consent: { accepted: true },
        },
        now,
        rules,
      });
      pkg = { id: submitted.id, status: 'submitted' };
    }
    // 幂等续跑：卡在哪个阶段就从哪个阶段往下走
    if (pkg.status === 'submitted') {
      assessSolvability({
        db, taskPackageId: pkg.id, answers: ANSWERS[spec.grade], actorId: enterprise.id, now, rules,
      });
      pkg = { ...pkg, status: 'assessed' };
    }
    if (pkg.status === 'assessed') {
      approveTaskPackage({
        db, taskPackageId: pkg.id, grade: spec.grade, actorId: adminId, now, rules,
        // ⚠️ P10（W4-a）：**D 级退回必须写明退回理由**（企业要照着改）——
        //    种子里的 D 级卡是「六维 0 分」那张，不给理由 ⇒ 服务层抛 400 RETURN_REASON_REQUIRED
        //    ⇒ 整个种子跑不完（演示数据缺失）。非 D 级不给理由（不改原语义）。
        reason: spec.grade === 'D' ? '六维全 0：任务描述不可执行，退回让企业重写后再提交' : null,
      });
      pkg = { ...pkg, status: spec.grade === 'D' ? 'returned' : 'published' };
    }
    packages.push(pkg);
  }

  // 选手：四档画像（S / A / B / C），覆盖「被接收 / 不接收」两条分支
  const profiles = [
    { name: '队长甲', phone: '13800000011', mbaStatus: 'mba', role: 'captain', answers: [5, 5, 5, 5, 5] },
    { name: '组员乙', phone: '13800000012', mbaStatus: 'mba', role: 'member', answers: [4, 4, 4, 4, 4] },
    { name: '组员丙', phone: '13800000013', mbaStatus: 'mba', role: 'member', answers: [3, 3, 3, 3, 3] },
    { name: '落选丁', phone: '13800000014', mbaStatus: 'mba', role: 'member', answers: [1, 1, 1, 1, 1] },
  ];
  const users = [];
  for (const p of profiles) {
    const u = ensureUser({
      name: p.name, phone: p.phone, password: 'demo-pw', mbaStatus: p.mbaStatus,
    });
    insertUserRole(db, u.id, p.role);
    let level = null;
    if (!findActiveRegistration(db, u.id, edition.id)) {
      const reg = submitRegistration({
        db,
        userId: u.id,
        editionId: edition.id,
        answers: {
          direction: p.answers, capability: p.answers, collaboration: p.answers,
          open: '我想用 AI 解决真实门店的排班与库存协同问题',
          consent: { accepted: true },
        },
        now,
        rules,
      });
      level = reg.level;
    } else {
      const found = findActiveRegistration(db, u.id, edition.id);
      level = found.level;
    }
    users.push({ user: u, level });
  }

  // 一支已成立的战队（认领第一张 A 级任务卡）
  const captain = users[0].user;
  const member = users[1].user;
  const existingTeam = listTeamRows(db, { editionId: edition.id }).find((t) => t.name === '甲队');
  if (!existingTeam) {
    const team = createTeam({
      db, userId: captain.id, editionId: edition.id,
      taskPackageId: packages[0].id, name: '甲队', now, rules,
    });
    addMember({ db, teamId: team.id, userId: member.id, actorId: captain.id, now, rules });
  }

  console.log(
    `P1 种子：届期 ${edition.name}｜任务卡 ${packages.length} 张（进池 10 + D 级退回 1）｜`
    + `选手 ${users.length} 人（等级 ${users.map((u) => u.level).join('/')}）｜战队 甲队`,
  );
  return { edition, packages, users };
}
```

- [ ] **Step 4: 运行全量测试**

Run: `cd platform && node --test`
Expected: PASS（7 个测试全过：e2e-p1 7）
（`node --test` 无参、cwd 发现；全量应为 P0 的 151 条 + P1 的 155 条 = **306 条**）

- [ ] **Step 5: 实跑种子与迁移**

Run: `cd platform && rm -rf data && node scripts/migrate.js && node scripts/seed.js`
Expected: 输出 `迁移完成，当前版本 2`；种子输出
`P1 种子：届期 首届 · 上海｜任务卡 11 张（进池 10 + D 级退回 1）｜选手 4 人（等级 S/A/B/C）｜战队 甲队`

⚠️ 种子必须**可重复执行**：再跑一遍不应报错，也不应把数据翻倍
（Task 7 预审修正 Important —— 原规格第二次跑直接 `PHONE_TAKEN` 崩掉）。

Run: `cd platform && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

Run: `curl -s http://127.0.0.1:8080/api/registration-criteria | head -c 200`
Expected: JSON 含 `"dimensions"`、`"levels"`、`"funnel"`

- [ ] **Step 6: 提交**

```bash
cd platform && git add scripts/seed.js test/e2e-p1.test.js test-helpers/http-call.js \
  test/registration-api.test.js test/task-package-api.test.js test/team-api.test.js
git commit -m "feat(P1): 端到端串联与种子扩充（报名→分级→建队→认领→加人）

对应需求：R-REG-01 / R-REG-02 / R-REG-05 / R-REG-08 / R-STG-03 / R-ENT-08 / R-ENT-09"
```

---

## P1 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P1-1 | 报名分级三个边界 | `cd platform && node --test test/registration-domain.test.js` → 79→A、80→S、59→B、60→A、39→C、40→B 六个边界断言全过 |
| P1-2 | C 级不接收 | 同上，`level='C'` 时 `accepted === false`；且 C 级报名者 `addMember` 抛 `REGISTRATION_NOT_ACCEPTED` |
| P1-3 | 重复报名 409 且不覆盖 | `node --test test/registration-api.test.js` → 同一 userId+editionId 二次 `POST /api/registrations` 返回 409 `DUPLICATE_REGISTRATION`，且 `registrations` 表仍只有 1 行 |
| P1-4 | 改级留痕 | `POST /api/registrations/:id/level` 后 `registration_events` 多一条 from→to 记录，`GET /api/registrations/:id` 能读到事件轨迹 |
| P1-5 | 组队三条硬门槛 | `node --test test/team-service.test.js` → 非 MBA 队长 → 409 `CAPTAIN_MBA_REQUIRED`；人数 <2 → 错误码 `[TEAM_BELOW_MIN_SIZE]`；任务包未分级 → 409 `TASK_PACKAGE_NOT_GRADED` |
| P1-6 | 赛程中招募汰换与并队 | 成员退出后 `teams.status === 'needs_merge'` 且 `mergeDeadline` 非空；汰换由非队长发起 → 403 |
| P1-7 | D 级必须出诊断报告 | 六维 0 分任务卡 `approveTaskPackage(grade='D')` 后 `meta_json.solvability.diagnosticReport.title === '问题可解性诊断报告'`；一票否决命中时不得签成 A 级 |
| P1-8 | 任务卡配比 | `checkTaskMix` 在自由题 30%、B 端 A40/B20/C10 时 `ok === true`；偏离时返回带 `[TASK_MIX_*]` 错误码的数组 |
| P1-9 | 可见性 | 选手 `GET /api/registrations` → 200 + `items: []`；读他人报名 → 404；`GET /api/registration-criteria` → 200 公开；`GET /api/task-packages` 选手只看到 `published` |
| P1-10 | 全链路 + 零依赖 | `node --test` 全过；`node --test test/e2e-p1.test.js` 跑通「报名→分级→建队→认领→加人」；`node --test test/zero-deps.test.js` 仍过且无 `node_modules` |

---

## 与 P0 终态的对齐（2026-10-21 父代理复核）

> P0 在本计划成文之后又经过**三轮评审修复**（`feat/p0-foundation` 的 HEAD `38c6713`），
> 期间 `src/server.js` / `src/http/static.js` / `src/http/router.js` / `src/auth/permissions.js`
> 与全部测试文件都变了。本计划 Task 3–7 的「修改 P0 文件」片段**逐条复核过落点锚点**，
> 结果如下（**只有一条真冲突**，已修）：

| 片段 | 落点锚点（P0 终态） | 结论 |
|---|---|---|
| Task 3 ① ② `src/server.js` import + 注册路由 | `createApp` 内 `router` 创建之后 | ✅ 锚点成立，直接追加 |
| Task 3 ③ `src/server.js` 错误分支带 `detail` | P0 终审 **Important I-C** 已把该分支改成 `const message = err instanceof AppError ? err.message : '请求无效'` + `error(res, status, code, message)` | ❌ **冲突，已修**：原片段写的是 `error(res, status, code, err.message, err.detail)` —— 直接改回 `err.message` 会**回退 I-C 的修复**（4xx 重新泄漏 SQLite 原文）。已改为 `error(res, status, code, message, err instanceof AppError ? err.detail : undefined)`：**沿用 P0 的 AppError-only 规则**，只额外透传 AppError 的 detail |
| Task 3 ④ `src/config.js`（FILES / grouped / validateRules 三处追加） | `FILES`（9 项，`registration` / `solvability` 在列）、`grouped`（同名 9 项）、`validateRules(grouped)` | ✅ 纯**追加**，锚点成立 |
| Task 4 `rules/solvability.json` 的 `taskMix` | P0 的 `taskMix` = `{enterprise: 0.7, free: 0.3}`（**无** `taskMixNote`） | ✅ 计划原文即「把 `taskMix` 换成（其余字段逐字保留）」，是**替换**不是冲突；`taskMixNote` 是新增键 |
| Task 4 ⑤ `src/server.js` import + 注册路由 | 同 Task 3 ①② | ✅ 锚点成立 |
| Task 5 ⑥ `src/server.js` import + 注册路由 | 同 Task 3 ①② | ✅ 锚点成立 |
| Task 6 ⑦ `web/app.js` import + route + nav | `route('/', () => renderHome())` + `renderHome()` 内 `<nav>`（两处 `<a>`） | ✅ 锚点成立，**追加** 3 个 `<a>`；注意 P0 的 `renderHome` 已改用 `escapeHtml(user.name)`（I-2 修复），**不得回退** |
| Task 7 ⑧ `scripts/seed.js` import + ROLE_CAPABILITIES + `seedP1` | `ROLE_CAPABILITIES`（`['captain', …]` / `['member', …]` 各在列）+ 种子主流程 | ✅ 锚点成立。注意 P0 已把 seed 的裸 SQL **下沉到 `src/db/repo/`**（I-7 修复），P1 的 `seedP1` **必须同样只调仓储层**，不得出现裸 SQL |

> ⚠️ **跨阶段纪律**：P1 在实施时若发现上表某条锚点又变了，**先更新本计划再动手** ——
> 「计划是规格」：计划里的代码块必须与最终实现逐字一致。

---

## Task 3 独立评审处置台账（2026-10-21）

> Task 3 完工后由**独立 verifier** 评审（报告：`.superpowers/sdd/2026-10-20-platform-P1-registration/task-3-review.md`），
> 结论 **Needs fixes：0 Critical / 2 Important / 10 Minor**。基线 199/199 连跑 3 次一致，
> 9 个文件级代码块与计划逐字一致，P0 的 3 Important + 8 Minor + 复核 F-1~F-6 **全部未回退**。
> 下表是逐条处置结果；**9 条修复全部做了变异检验（9/9 杀灭，见「变异验证」列）**。

| # | 级别 | 缺陷 | 实跑证据 | 处置 | 变异验证 |
|---|---|---|---|---|---|
| **T3-1** | **Important** | `buildCriteria` 的合规 / IP / 赛程披露（`ipOwnership` / `redLines` / `consent` / `schedule`）**零断言** —— 这四项是 R-ENT-11 / R-ENT-12 / R-STG-01 的**唯一对外出口**，删掉后需求在产品上静默失效而 CI 全绿 | 评审变异 V14：删掉这 4 个字段 → **全量 199 条仍全绿** | `test/registration-api.test.js` 的 criteria 用例补 4 条断言 | ✅ 杀灭 |
| **T3-2** | **Important** | `getRegistration` 的 `events` 状态机留痕**零断言** —— `registration_events` 唯一的对外出口，审计链在 API 层消失无人察觉 | 评审变异 V15：`out.events` 置空 → **全量 199 条仍全绿** | 补 `mine.events.length === 1` / `toStatus === 'submitted'` / `fromStatus === null`；改级用例改后回读一次，断言 `events.length === 2` / `fromStatus === 'submitted'` / `toStatus === 'accepted'` | ✅ 杀灭 |
| **T3-3** | Minor | `grading.accepted` 断言**无区分能力**（唯一一条断言针对 S 级报名，把实现改成恒 `true` 照样通过） | 评审变异 V16：`accepted: graded.accepted` → `accepted: true` → **全量仍全绿** | 新增低分问卷用例 → `level === 'C'` 且 `grading.accepted === false`（C 级不接收） | ✅ 杀灭 |
| **T3-4** | Minor | 幂等兜底正则 `/UNIQUE\|constraint/i` **过宽** → `FOREIGN KEY constraint failed` 也被吞成 409 `DUPLICATE_REGISTRATION`（客户端被告知「你已重复报名」） | 评审探针：传不存在的 `userId` → 实测 `409 / DUPLICATE_REGISTRATION` | 正则收紧为 `/UNIQUE constraint failed: registrations\./i`（实测原文 `UNIQUE constraint failed: registrations.user_id, registrations.edition_id`）；新增用例断言外键失败**不得**报成重复报名 | ✅ 杀灭 |
| **T3-5** | Minor | 选手申诉**无条件**把 `status` 改成 `'appealed'` → 委员会已裁定 `'accepted'` / `'rejected'` 的行，终态从 `status` 列上消失（按 status 统计的下游会漏人） | 评审探针：改 C 后 `status=rejected` → 申诉后 `status=appealed` | 只有**尚无终态**的行才标 `'appealed'`；已有终态的行保持 status 不变，申诉只进事件流 | ✅ 杀灭 |
| **T3-6** | Minor | `POST /api/registrations/:id/level` 的 **401 未登录路径零断言** | 评审变异 V21：删掉 401 判断 → **全量仍全绿** | 补用例：匿名 → 401 + `error.code === 'UNAUTHENTICATED'` | ✅ 杀灭 |
| **T3-7** | Minor | 能力点校验传 `ctx = null` → `scope_type='edition'` 的 `registration:write` 授权**被误拒**（该用户无法报名） | 评审探针：global 授权 `can(null ctx)=true` / edition 授权 `can(null ctx)=false` | 校验移到解析 `editionId` 之后并带 `{ scopeType:'edition', scopeId: editionId }`；新增用例断言 edition 作用域授权能报名 | ✅ 杀灭 |
| **T3-8** | Minor | `GET /api/registration-criteria` 返回的是**最早开始**的一届，不是**当届** | 评审探针：多届期时返回历史届期 | 新增 `pickCurrentEdition(editions, today?)`：取尚未结束的最早一届；`today` **可注入**（否则断言会随日历漂移变成 flaky）；配套单测 | ✅ 杀灭 |
| **T3-9** | Minor | `level`（库内快照）与 `grading.level`（当前配置重算）**口径无登记、断言缺失** → 换配置后同一响应里两个等级矛盾 | 评审探针：换配置后 `level='B'` 与 `grading.level='A'` 并存；变异 V17（grading 改读库值）→ 全量仍全绿 | 在 `presentRegistration` 上方**登记口径**（快照留痕 + 重算可追 + 裁定不可篡改）；新增用例断言「换配置后 `grading` 变、快照不变」 | ✅ 杀灭 |
| **T3-10** | Minor | P0 的 `test/config.test.js` 的措辞（「9 份」）在 P1 分支过期 → P1 计划却写「一字不动」，与实现自相矛盾 | 评审核对：P1 分支该文件已改成「全部规则配置」，P1 计划仍写「一字不动」 | ① P1 计划的「一字不动」改成**准确表述**（「不加用例」—— 条数 23 与断言一字未动，只订正了 3 处会随配置份数过期的措辞）；② **P0 计划保持历史原样**（它是 P0 阶段的历史规格，必须与 main / `feat/p0-foundation` 同一份；跨阶段的一致性靠变更登记兜住，不靠改历史规格）；③ 提交信息里的用例数订正为 193 → 199 | — |
| **T3-11** | Minor | 列表端点未暴露分页参数，`limit` 硬编码 200 | — | **本期不提供分页**（口径已登记，见下方「口径」表）；报名量级在一届之内不会到 200+ | — |

**Task 3 的测试条数口径**：registration-service **16** + registration-api **14** + config-p1 **5** = **35**。
（registration-service 由 14 增至 16：Task 6 的「列表端点也带事件轨迹」修正在此文件追加了 2 条用例，见 Task 6 台账 T6-4。）

---

## Task 4 父代理预审修正台账（2026-10-21）

> Task 4 的规格在**实施前**先被父代理逐条实跑预审，发现 **2 Critical + 5 Important + 3 Minor**，
> 全部在本计划里改完后再实施（「先跑后派」纪律：规格改动必须抽取成独立工程实跑通过，再落盘）。
> 全部缺陷均**实跑复现**，复现方式见「实跑证据」列。
> 实施后又经**独立 verifier** 评审（报告：`.superpowers/sdd/2026-10-20-platform-P1-registration/task-4-review.md`，
> 结论 Needs fixes：0 Critical / 5 Important / 7 Minor，62 个变异 44 杀 18 活）——
> 处置见下方「Task 4 独立评审处置台账」。

| # | 级别 | 缺陷 | 实跑证据 | 修法 |
|---|---|---|---|---|
| **T4-1** | **Critical** | `checkTaskMix` 的等级配比**分母用错**：实现用 `enterprise * ratio`（B 端子集为分母） | 计划自带的用例「配比：自由题 30% / B 端 70%，A 40% B 20% C 10%」**直接失败**：`[TASK_MIX_GRADE_A] B 端内部 A 级 4/7，目标占比 40%`（17 条挂 1 条） | 分母改为 `total`。三处独立佐证：① 需求原文 R-ENT-09「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」四档合计 100%（瓜分整个池）；② P0 已实现的 `validateRules` 校验 `enterpriseGradeSplit` 合计 == `taskMix.enterprise`（0.70），只有总量口径成立；③ 测试夹具 4A/2B/1C/3自由（10 张）正是总量口径 |
| **T4-2** | **Critical** | **形状错配**：路由把 `presentTaskPackage` 的**驼峰**视图对象喂给 `checkTaskMix`，实现却读 `p.is_free_brief` → 自由题恒算 0 | 3 张自由卡 + 7 张企业卡 → 体检结果「自由命题占比 0%，目标 30%」 | 领域层统一消费**已呈现**形状（`Number(p.isFreeBrief) === 1`）；测试夹具同步改成驼峰（原来夹具与实现同为下划线 → 错配互相抵消，测试全绿也测不出来）；路由层补回归用例 |
| **T4-3** | Important | `GET /api/task-packages` 不带 `editionId` → **500** | `listTaskPackagesByEdition(db, undefined)` 抛 `TypeError: Provided value cannot be bound to SQLite parameter 1.` | 仓储层加「过滤条件缺省即不生效」守卫（与报名的 `listRegistrationRows` 约定一致）→ Step 6 |
| **T4-4** | Important | `meta.solvability` 不存 `score`/`grade` → 《问题可解性诊断报告》的分数**恒为 null** | 诊断报告 `score = null` | 评估时把 `score`/`grade` 一并存进 `meta.solvability` |
| **T4-5** | Important | **未做六维评估就能签 A 级** —— 评估闸门形同虚设 | `grade = A`、`status = published`、`solvabilityScore = null` | `approveTaskPackage` 要求 `meta.solvability.score` 是数字，否则 `400 SOLVABILITY_NOT_ASSESSED`。与 Task 3 验收发现的 A1（`registration:write` 被注册但从不校验）同类：**机制写下来了但没接线** |
| **T4-6** | Important | 配比体检口径错：组委会视图的 `items` 含未分级卡 → `byGrade` 全落在 `ungraded` 上 | 10 张未分级卡 → A/B/C 计数全为 0 | 体检只算**已发布（进池）**的卡：`items.filter(p => p.status === 'published')`。R-ENT-09 的四档描述的是任务池构成，未分级的卡还没进池 |
| **T4-7** | Important | **路由层零测试覆盖** —— 17 条用例全在 domain + service | 原计划无 `test/task-package-api.test.js` | 新增 15 条路由层用例：401 未登录 / 403 无能力点 / 400 参数与状态机 / 404 资源不存在 / 200+空集列表 / 配比口径回归。Task 3 的两个真实缺陷正是在路由层发现的 |
| **T4-8** | Minor | 任务卡**没有状态机**：任何状态都能被评估/签级 | — | `ASSESSABLE = {submitted, assessed, returned}` / `APPROVABLE = {assessed, returned}`；违规 → `409 TASK_PACKAGE_STATE_INVALID` |
| **T4-9** | Minor | 企业提交完任务卡，在列表里**一条都看不到**（非组委会视图只返回 `published`） | — | 非组委会视图加上「自己提交的」（`submitted_by === viewer.id`）。「未分级的不进**选题池**」≠ 提交方看不到自己的卡 |
| **T4-10** | Minor | 届期不存在 → SQLite 外键原文漏到 HTTP 层（只能回 500，还暴露表结构） | 与 P0 评审修正 I5（重复手机号先查后写）同类 | 提交时先 `getEdition` 校验 → `404 EDITION_NOT_FOUND`（与报名服务一致） |

**Task 4 的测试条数口径**：solvability-domain **10** + task-package-service **14** + task-package-api **15** = **39**。

---

## Task 4 独立评审处置台账（2026-10-21）

> 独立 verifier 结论 **Needs fixes：0 Critical / 5 Important / 7 Minor**。
> 评审的判断是「**实现本身无功能性缺陷**，问题集中在测试强度（恒绿断言）与 2 处加固」。
> 62 个变异 → 44 KILLED / 18 SURVIVED（其中 2 个是等价变异体 → 有效缺口 16 条）。
> 下表逐条处置；**13 条修复全部做了变异检验（13/13 杀灭）**。

| # | 级别 | 缺陷 | 证据 | 处置 | 变异 |
|---|---|---|---|---|---|
| **T4R-1** | **Important** | 六维**分档边界值零覆盖** —— 把 `gradeOf` 的 `>=` 改成 `>`，全量照样全绿 | 评审变异 M14 SURVIVED；而这些边界分**业务上完全可达**（独立评审枚举 288 组：10 分 1 组、9 分 9 组、7 分 8 组、6 分 16 组、4 分 8 组、3 分 9 组），档位直接决定 R-ENT-08 的承诺与协议 | 新增边界用例：10→A、9→B、7→B、6→C、4→C、3→D，用 `computedGrade`（不含一票否决）单独钉住「分数 → 档位」 | ✅ |
| **T4R-2** | **Important** | 状态机「`returned` → 再评估 → 复活 `published`」整条链**零断言** | 评审变异 M18/M19 SURVIVED；实跑确认实现本身正确（复活成功） | 新增用例走完整条复活链 | ✅ |
| **T4R-3** | **Important** | 三条路由的**能力点常量不可区分**（`write`↔`read`、`approve`↔`read` 互换后无人察觉） | 评审变异 M37/M37b/M37c SURVIVED；seed 角色矩阵下 admin 有 read+approve 无 write | 测试里造两个**单一能力点**账号：「只读账号」（read）与「可写不可签级账号」（read+write）；前者评估必须 403、后者签级必须 403 | ✅ |
| **T4R-4** | **Important** | 「配比体检只对组委会开放」没被钉住 —— mix 对所有人开放也无人察觉 | 评审变异 M46/M47 SURVIVED；mix 是任务池经营数据 | 新增用例：企业侧 `mix === null`，组委会侧 `mix` 非空 | ✅ |
| **T4R-5** | **Important** | D 级诊断报告的**实质内容没被钉住** —— `suggestions` 有两个独立生产者，只删一个断言照样通过 | 评审变异 M50 / M16 / M17 各自 SURVIVED | 新增用例：报告必须点名短板维度、必须带**中文**否决标签（不是 key）、六个维度齐全 | ✅ |
| **T4R-6** | Minor | 领域层**硬编码两个否决项 key** → 配置改名即让「数据可得性 = 0 → 一票否决」**静默失效** | 评审探针实测：改名后 `grade=B, vetoes=[]` | 触发条件写进配置的 `auto: { dimension, equals }`，领域层按配置判定，key 只当标识 | ✅ |
| **T4R-7** | Minor | `validateRules` **不校验 `solvability.vetoes`**（空数组 / key 重复 / auto 指向不存在的维度都能通过） | 评审实测 | 补校验：`vetoes` 非空、key 唯一、label 非空、`auto` 形状与指向的维度存在（Task 3 Step 7 的 ④ 段） | ✅ |
| **T4R-8** | Minor | 重签级后**旧 D 级诊断报告残留**（已发布的卡上挂着「grade: D, score: 12」的退回结论） | 评审实跑复现 | 签非 D 级时清掉旧报告。⚠️ 注意暴露路径是「D 级 → **直接**重签 A」；走「重新评估 → 再签级」时 `assessSolvability` 会整份替换 `meta.solvability`，旧报告自然消失 —— **那条路查不出这个缺陷** | ✅ |
| **T4R-9** | Minor | `editionId` 缺省语义未钉住（只断言「不 500」不够） | 评审实测 | 新增用例：不带 `editionId` 返回**全部届期**的卡，带上则只返回本届 | ✅ |
| **T4R-10** | Minor | 负数取值 / `INVALID_VETO_KEY` / approve 404 三个分支零断言 | 评审实测 | 三条各补一条用例 | ✅ |
| **T4R-11** | Minor | `explain.note` 零断言（可解释明细是给企业看的） | 评审实测 | 断言 note 必须含维度标签、取值/上限、折算分 | ✅ |
| **T4R-12** | Minor | 路由文件缺「溯源需求编号」行 | 评审核对 | 补 `// 溯源需求：R-ENT-01 / R-ENT-06 / …` | — |
| **T4R-13** | Minor | 预审台账的表头计数写成 2C+5I+2M，实为 2C+5I+3M | 评审核对 | 订正表头 | — |

**Task 4 的测试条数口径**：solvability-domain **13** + task-package-service **17** + task-package-api **21** = **51**。

---

## Task 5 父代理预审修正台账（2026-10-21）

> Task 5 的规格在**实施前**被父代理逐条实跑预审（把计划里的代码块抽到独立工程里跑），
> 发现 **4 Critical + 4 Important**，全部在本计划里改完后再实施。
> 全部缺陷均**实跑复现**；**6 条修复做了变异检验（6/6 杀灭）**。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **T5-1** | **Critical** | `src/services/team.js` 里 `getTeam` **重复声明**（仓储导入 + 服务层导出同名） | `SyntaxError: Identifier 'getTeam' has already been declared` → 整个模块**根本无法导入** → 计划自带的 13 条用例**一条都跑不起来** | 仓储导入改别名 `getTeam as findTeamRow`；服务层对外签名不变 |
| **T5-2** | **Critical** | 汰换用例漏了「新成员必须已完成本届报名且被接收」 | 实跑 `REGISTRATION_REQUIRED`（服务层行为**正确**，R-ENT-08；是用例夹具错了） | 夹具给汰换对象补一条已接收的报名 |
| **T5-3** | **Critical** | 路由层**零能力点校验**：`POST /api/teams` 不校验 `team:create` | 与 Task 3 的 A1、Task 4 的 T4-5 同类：能力点被注册、被 seed 授予，却从不校验 | 路由补 `can(user, 'team:create', { scopeType:'edition', scopeId: editionId }, db)` → 403 |
| **T5-4** | **Critical** | **越权踢人**：`POST /api/teams/:id/members` 的 `leave` 分支把 `body.userId` 直接交给服务层 | 服务层只查「该同学在此战队」，不校验 actor → 任何登录用户能把**别人**踢出战队 | `leave` 分支**固定用 `user.id`**，不接受 `body.userId`；换人走 `replace`（汰换移交） |
| **T5-5** | Important | `add` 分支同样可**替别人**加入战队 | `body.userId` 直通服务层 | `add` 分支固定 `userId: user.id`（自助加入） |
| **T5-6** | Important | `packageQuotaMix`（企业包 70% / 自由包 30% 的战队配额）在配置里但**从未被使用** | 服务层 0 次引用 | **登记口径**：需求溯源表里没有对应条目（只有 R-ENT-09 的**任务卡池**配比，那条由 Task 4 的 `checkTaskMix` 体检）；且建队时无法预知最终配比，强制会让某个类型的包建不出队。该键保留（INTERFACES.md §2 的契约形状） |
| **T5-7** | Important | `teamsPerPackage.min`（每包**至少** 2 支）从未校验 | — | **登记口径**：min 是组委会的运营目标，不是创建闸门 —— 建队是选手行为，某个包的第一支队在建队那一刻还不存在，强制 min 会让它**永远建不出第一支队** |
| **T5-8** | Important | `singleMemberTriggersMerge` 配置项从未被读取（行为硬编码 `count <= 1`） | 配置与实现可以各说各话（把配置改成 false，行为照旧触发并队） | 改读配置；新增用例把配置关掉并断言行为**跟着变** |
| **T5-9** | Minor | 路由层**零测试覆盖**（只有 `test/team-service.test.js`） | Task 3 / Task 4 的真实缺陷都出在路由层 | 新增 `test/team-api.test.js`（11 条） |

**Task 5 的测试条数口径**：team-service **14** + team-api **11** = **25**。

---

## Task 6 父代理预审修正台账（2026-10-21）

> Task 6 的规格在**实施前**被父代理逐条实跑预审（把计划里的代码块抽到独立工程里跑），
> 发现 **1 Critical + 2 Important**；实施完成后又做了一轮**变异检验**，
> 变异体一度出现 **2 条存活**（暴露了「渲染路径无覆盖」这一类盲区），补完测试后 **12/12 杀灭**。
> 全部缺陷均**实跑复现**。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **T6-1** | **Critical** | 三个新视图把**服务端返回的数据**直接插进 `innerHTML`，**未走 P0 的 `escapeHtml`** | 用户可控字段有实测入口：战队名称（`POST /api/teams` 的 `name`，选手自填）、任务包标题（`POST /api/task-packages` 的 `title`，企业自填）。P0 的 `web/escape.js` 注释早就写明了这个危险（「P1 的『报名』端点让用户自选 name → 立刻变成可远程利用」），但 Task 6 的三个视图**没照做** → **存储型 XSS** | 三个视图统一 `import { escapeHtml } from '../escape.js'`，所有服务端数据插值点逐个转义；新增**结构性回归测试**（扫描用户可控字段的裸插值），修复前红、修复后绿 |
| **T6-2** | Important | 「退出战队」按钮的禁用条件**取反**：只在「当前用户是组长」时可点 | 服务端 `leaveTeam` 对组长抛 **409 `CAPTAIN_MUST_REPLACE`**（组长要移交职责，不能直接退），组员又被禁用 → **两个角色都退不了队**，整条「持续招募汰换（R-REG-03）」的退出路径在 UI 上是死的 | 判定抽成纯函数 `canLeaveTeam(team, viewerId)`：**组员可退、组长不可退**（与服务端规则对齐）；渲染路径抽成纯函数 `buildTeamCards(teams, viewerId)` 便于直接断言 |
| **T6-3** | Important | 筛选台的「事件轨迹」一栏**恒为空** | 两处空转：① 后端 `GET /api/registrations`（**列表**）此前**不挂 `events`**（只有单条 `getRegistration` 挂）→ `r.events` 恒为 `undefined`；② 前端表格里**根本没有这一列** → 数据有了也没地方显示 | 后端：仓储层追加 `listRegistrationEventsForRegistrations`（**一次 SQL** 批量取，`IN (...)` + `ORDER BY created_at, rowid`），服务层 `listRegistrations` 挂上事件；前端：表格加「事件轨迹」列，纯函数 `formatEventTrail(events)` 逐条渲染 |
| **T6-4** | Minor | `data-user="${s.captainId}"` 是**死属性** | Task 5 的 T5-4 已把「退出只作用于发起人自己」落到服务端（不再接受 `body.userId`），前端却还留着一个指向组长的 `data-user` → 读代码的人会以为客户端仍在传别人的 id | 删除该属性 |
| **T6-5** | Minor | **渲染路径无覆盖**（变异检验暴露的盲区） | 首轮变异检验 **10 条变异体存活 2 条**：把 `canLeaveTeam(t, viewerId)` 换成老写法 `s.captainId === viewerId` → **存活**（`canLeaveTeam` 本身测对了，但**调用点**写错没人知道）；把轨迹渲染换成 `<td>${[].map(...)}</td>` → **存活**（结构断言只查 `includes('r.events')`，而 `buildScreeningRows` 里也有 `r.events`） | 渲染路径抽成纯函数（`buildTeamCards` / `formatEventTrail`）并直接断言其输出；结构断言收紧到**调用点**（`formatEventTrail(r.events)`）与**表头单元格**（`<th>事件轨迹</th>`）—— 原来的 `includes('事件轨迹')` 会被文档注释里的同名串满足，删掉表头的变异体照样存活 |

**Task 6 的测试条数口径**：p1-frontend **13**（原计划 6 + T6-2 追加 2 条 + T6-3 追加 1 条 + T6-5 追加 4 条）；registration-service 由 **14** 增至 **16**（T6-3 追加 2 条）。

**Task 6 的变异检验口径**：12 个变异体，**12/12 杀灭**（`/tmp/p1t6/mutate.mjs`）。变异体覆盖：组长判定、成员判定、事件挂载、事件分组、事件累积、事件字段、轨迹表头、轨迹渲染、`formatEventTrail`、队名转义、退出按钮条件、`buildTeamCards` 调用点。

---

## Task 7 父代理预审修正台账（2026-10-21）

> Task 7 的规格在**实施前**被父代理逐条实跑预审（把计划里的代码块抽到独立工程里跑，
> 并把种子脚本**真的执行了一遍**、再探针查库），发现 **1 Critical + 4 Important + 2 Minor**。
> 全部缺陷均**实跑复现**；实施后做了变异检验，**9/9 杀灭**。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **T7-1** | **Critical** | 种子创建的**所有用户都没被授予任何角色** —— `createUser` **不分配角色**（角色在 `user_roles` 表），原规格建了 4 个选手 + 1 个企业代表却没授角色 | 探针查种子库：`user_roles` 里 4 个选手与企业代表的 `role_key` 全是 `null`，只有管理员有 `admin`。后果：演示版里这些人登录后**报名 403、建队 403、看不到任务包**，整个演示是死的；原规格自己加的「captain/member 补 `task_package:read`」也因此**完全落空**（没人持有这两个角色） | 逐个 `insertUserRole`：队长甲→`captain`、组员乙/丙/落选丁→`member`、企业代表→`enterprise`；e2e 用 `can()` 断言**能力点的实际效果**（不是查表），确保接线真的通了 |
| **T7-2** | Important | 种子**不可重入**：直接 `createUser` → 第二次跑 `PHONE_TAKEN`（409）直接崩 | 实跑：同一 `DATA_DIR` 跑第二遍 → 409 `PHONE_TAKEN` 栈。部署手册里的「跑一次种子」会变成地雷 | 每个实体「先查后建」（用户按手机号、届期按名字、卡按标题、报名按 `findActiveRegistration`、战队按名字），与 P0 种子自己的 `findUserByPhone` 同一约定；e2e 跑两遍并断言数据不翻倍 |
| **T7-3** | Important | 种子**绕过服务层**直连 `createTaskPackage` 仓储并手搓 `meta` | 服务层才有 R-ENT-01（字段完整）/ R-ENT-12（同意记录）/ R-ENT-10（自由题不挂企业主体）的校验 —— 种子路径把这些**全部绕开**，与生产两套口径 | 改调 `submitTaskPackage` 服务层，`meta` 由服务层生成 |
| **T7-4** | Important | 自由命题卡 `grade: null` → **永远签不了级、不进选题池** → 演示数据里没有自由题，R-ENT-09 的 30% 自由**必然不达标** | 探针：自由卡 `grade=null`、`status=assessed`；`checkTaskMix` 实跑 → `[TASK_MIX_FREE] 自由命题占比 0%，目标 30%` | 自由题也走六维评估 + 分级签约 → 进池 |
| **T7-5** | Important | 种子数据的**配比必然不达标**（6 张卡凑不出 40/20/10/30） | `checkTaskMix` 容差 ±10%：6 张卡凑不出 30% 自由（1/6 = 16.7%，差 13.3 个百分点 > 10） | 种子扩到 **10 张进池卡**（4×A + 2×B + 1×C + 3×自由）—— **精确命中** 40%/20%/10%/30%；另加 1 张 **D 级**卡（六维 0 分 → 退回 + 出《问题可解性诊断报告》）演示 D 档 |
| **T7-6** | Minor | 三个 API 测试文件里各抄了一份**逐字相同**的 HTTP 调用器（md5 一致） | `md5` 比对：三个 `call` 函数哈希完全相同 —— 改一处要改三处 | 抽成 `platform/test-helpers/http-call.js`（全局约束：共享 helper 必须放 `test-helpers/`），三个文件改为 import；**变异复测确认覆盖率未丢**（撤掉 `team:create` 校验 → 三个 API 测试仍能抓住） |
| **T7-7** | Minor | e2e 只走**服务层**，不覆盖路由层 | Task 3 / Task 4 / Task 5 的真实缺陷**全部出在路由层**（能力点校验没接线、列表端点缺字段、越权踢人），服务层测不出来 | 补 **HTTP 层**全链路（出题 → 评估 → 签级 → 报名 → 建队 → 加人 → 成立）+ 能力点拦截（403）+ 可见性（200+空集 / 404）+ 事件轨迹 |
| **T7-8** | Minor | `enterpriseId: 'ent_retail'` 是**魔法字符串**，不对应任何用户 | 探针：`users` 表里没有该 id（`enterprise_id` 无外键所以不报错，但值是假的） | 改用真实的 `enterprise.id` |

**Task 7 的测试条数口径**：e2e-p1 **7**（服务层 2 + HTTP 层 2 + 种子产物 3）。

**Task 7 的变异检验口径**：9 个变异体，**9/9 杀灭**（`/tmp/p1t7/mutate.mjs`）。变异体覆盖：不给选手授角色、不给企业授角色、种子不幂等、自由题不签级、配比不达标、D 级不出诊断报告、列表不带事件轨迹、路由不校验 `team:create`、建队不认领任务包。

**⚠️ 预审时自己踩到的坑（登记）**：`checkTaskMix` 消费的是**服务层呈现的驼峰形状**（`p.isFreeBrief`），
喂**数据库行**（`p.is_free_brief`）会把自由题算成 0 —— 预审探针第一次就是这么写的，
结果「自由占比 0%」的假象差点被当成真缺陷。这与 Task 4 的 T4-2（形状错配）是**同一个坑**：
领域层统一消费**已呈现对象**，任何直接拿仓储行喂领域层的调用都会算错。

---

## 与接口契约的偏差

> 以下 7 条是本计划相对 `INTERFACES.md` §2「P1 产出」的实现偏差。**INTERFACES.md 未被本计划修改**。
> 每条都给了「为什么必须这样」与「要撤销它需要改什么」。
> **D-1 已在上游修复**：P0 计划已把 `user_roles` 表并入 `001_init.sql`，不再单独开 `002_user_roles.sql`；
> 迁移版本号恢复为全局唯一序位 002→P1、003→P2 … 006→P6。下表的 D-1 行保留，作为该修复的留痕。

| # | 偏差 | 契约原文 | 本计划做法 | 为什么 / 怎么撤销 |
|---|---|---|---|---|
| **D-1** ✅ | **迁移版本号撞车（已在上游修复）** | 契约要求 P1 的迁移叫 `db/migrations/002_registration.sql` | 沿用契约命名 | P0 计划 Task 6 原建 `002_user_roles.sql`（版本号 2）。`schema_migrations.version` 是主键，两个版本 2 的迁移会让 `applyMigrations` 在第二次插入时 UNIQUE 失败、整个迁移回滚。**已修法：P0 把 `user_roles` 并入 `001_init.sql`，不单独开迁移**（见 P0 计划 Task 2/Task 6 的最新版本）。本计划沿用该修法，002 留给 P1 |
| **D-2** | 新增端点 `GET /api/teams` | 契约 P1 端点清单只有 `GET /api/teams/:id` | 新增 `GET /api/teams` → `{ items: [我的战队] }` | 设计文档 §9 的「我的战队」页需要知道自己属于哪些战队；只有 `/:id` 时前端拿不到 id。撤销办法：把「我的战队」改成注册/建队后由服务端回传 id 存到本地 |
| **D-3** | 新增端点 `GET /api/registration-criteria` | 契约 P1 端点清单无此条 | 新增，返回公开的筛选标准（权重/量表/阈值/题目/漏斗/合规/赛程） | R-REG-09 要求筛选标准对外透明；前端无构建、读不到服务端 `rules/*.json` 目录。撤销办法：把 `rules/registration-scoring.json` 复制一份到 `web/` 并用 `import ... with { type: 'json' }`（浏览器支持面较窄） |
| **D-4** | `task_packages` 增加 1 列 `meta_json` | 契约列清单止于 `deleted_at` | 装合规同意记录、六维评估明细与《问题可解性诊断报告》 | R-ENT-12 要求同意记录、R-ENT-08 要求 D 级必须出诊断报告，契约无字段可放；拆成三张表会让契约的表清单再多三张。撤销办法：拆成 `task_package_assessments` / `task_package_consents` 两张表 |
| **D-5** | `teams` 增加 1 列 `milestones_json` | 契约列清单止于 `deleted_at` | 存建队时固定的里程碑清单快照 | R-STG-03 要求「里程碑清单报名时即公布、不可自行新增」。若不落快照，改一次 `rules/milestones.default.json` 就会追溯改变已组队的队伍。撤销办法：改由 P2 的 `milestones` 表承担（P2 迁移需增表，契约 §3 未含） |
| **D-6** | `team_members` 增加代理主键 `id` | 契约只列了 5 个字段，未指定主键 | `id TEXT PRIMARY KEY` + `UNIQUE(user_id) WHERE left_at IS NULL` | 不加主键则无法同时满足「保留进出历史（R-REG-03 退出报备）」与「同一人只能同时在一个战队」两条。用 `PRIMARY KEY (team_id, user_id)` 会让「退出后再加入」无法留痕。撤销办法：改用 `PRIMARY KEY (team_id, user_id, joined_at)`，并放弃「一人一队」的部分唯一索引 |
| **D-7** | 服务层签名统一追加 `rules` 参数；`decideRegistration` 的 `level` 可省略 | 契约签名未含 `rules`；`decideRegistration` 六个参数齐备 | 契约里的每个字段名与顺序逐字不变，只在对象里**追加** `rules`；`level` 为空表示「只登记申诉、不改级」 | 契约没说服务层从哪里拿规则（`createApp({db, rules})` 已有 rules，但 `computeStage` 这类签名里同样没有）。追加是侵入最小的做法。`decideRegistration` 契约里没有单独的申诉入口，而 §9 要求筛选台有「复核/申诉/改级」三件事 |

**另有 3 条「契约未禁止但本阶段自行决定」的口径，写明以免被当成原文**：

> ⚠️ 标题里的「3 条」是 Task 3 成文时的数字，后续 Task 4/5/6 又追加了几条 —— 以**表里的实际行数**为准。

| 口径 | 本阶段实现 | 出处与状态 |
|---|---|---|
| 六维的一票否决 ①② 由维度推导 | `data_access = 0` → 自动命中「无法提供数据授权说明」；`accountability = 0` → 自动命中「无企业侧唯一责任人」；③「涉及生产系统且未谈责任归属」只能由出题方自报 | 顶层文档 §3.2 的六维与三条否决是同一件事的两种说法（原文把「责任可归属」列为维度、把「唯一责任人」列为否决）。**属我方推断，需组委会追认** |
| 分级落在档位间隙时向下取档 | 分值落在两档之间（例如 6.8）取更低一档 | 六维分值是 0–12 的连续量，档位是 10-12 / 7-9 / 4-6 / 0-3，间隙必然存在。**我方假设** |
| R-REG-01「报名即认领任务包」的落点 | 认领动作落在**建队时刻**（`teams.task_package_id`），报名表不带任务包字段 | 设计文档 §10 流 1 写的是「队长建队 → 认领任务包 → 成员加入」，且契约的 `registrations` 表无任务包列。**若组委会要求「报名表里就选任务包」**，需在 `002_registration.sql` 给 `registrations` 加列 → 契约变更 |
| `GET /api/registrations` 不带 `editionId` 的含义 | 返回**全部届期**的报名（组委会视角）；带 `editionId` 才按届期过滤 | 与「全局授权不做行级过滤」一致（`scopeClause` 对 `scope_type='global'` 的授权不设限）。**带版期授权的组委会成员**（`scope_type='edition'`）在不带 `editionId` 时看不到任何行 —— 因为 `scopeId` 为空、匹配不上任何一版。⚠️ 若组委会希望「不带 editionId 时只看自己有权限的届期」，需要把 `editionId` 变成**必填**（契约变更） |
| `POST /api/registrations` 的能力点校验 | 已登录 + `can(user, 'registration:write', { scopeType:'edition', scopeId: editionId })` 才放行，否则 **403** | **【2026-10-21 父代理验收修正】** 计划原文只判「有没有登录」→ `registration:write` 这个被注册、被 seed 授予的能力点**形同虚设**，违反全局约束「`can()` 是唯一判定入口」。⚠️ **副作用**：新注册的账号若没有任何角色 / 授权，将无法报名（seed 里 captain 与 member 都有 `registration:write`，所以正常路径不受影响）。若组委会要求「任何人注册后即可报名」，则应改为「报名成功时自动授予 member 角色」—— 那是契约变更。**【2026-10-21 独立评审修正 T3-7】** 作用域从 `null` 改成 edition —— 原来传 `ctx = null` 时 `can()` 会**跳过**资源级授权的 scope 匹配 → `scope_type='edition'` 的授权会被误拒（该用户无法报名） |
| `GET /api/registrations` 列表**不提供分页** | `limit` 硬编码 200、offset 恒 0；query 里的 `limit` / `offset` 被忽略 | **【2026-10-21 独立评审 Minor T3-11】** 仓储层（`listRegistrationRows`）已经支持 `limit` / `offset`，但路由没有透传。一届的报名量级远不到 200 条，**本期不开放分页**；若报名量超 200 条，第 201 条起取不到 → 届期规模扩大前必须补路由透传 + 上界校验 |
| `level` / `grading.level` / `levelFinal` 三者的口径 | `level` + `rawScore` = **提交那一刻**的快照（存库）；`grading` = **按当前配置重算**（不存库）；`levelFinal` = **组委会裁定**（只有组委会能改） | **【2026-10-21 独立评审 Minor T3-9】** 改 `rules/registration-scoring.json` 的权重或阈值后，重读同一条报名会看到 `level`（旧快照）与 `grading.level`（新口径）不一致 —— 这**不是 bug**，而是「评分可复算、裁定不可篡改」两条原则的必然结果。列表的 `level` 过滤走**库内快照**，客户端按等级筛选时以快照为准 |
| `GET /api/registrations`（列表）**带 events** | 列表里的每条报名都带 `events` 数组（与单条 `GET /api/registrations/:id` 形状**逐字一致**） | **【2026-10-21 父代理预审 Important T6-3】** 契约没写列表带不带事件。此前只有单条挂 → 组委会筛选台读列表 → 轨迹一栏恒空。现在仓储层用**一次 SQL**（`IN (...)` + `ORDER BY created_at, rowid`）批量取，服务层挂上。⚠️ 代价：一届的报名量级下 N+1 与批量差别不大，但**报名量上万时列表会变重** —— 届期规模扩大前要改成分页 + 分批取 |
| 「退出战队」按钮的可用性口径 | **组员可退、组长不可退**（组长移交走汰换 `action=replace`） | **【2026-10-21 父代理预审 Important T6-2】** 与服务端 `leaveTeam` 的 409 `CAPTAIN_MUST_REPLACE` 对齐。契约没规定前端按钮的禁用规则 |
| 前端视图的**纯逻辑导出**范围 | `buildQuestionnaire` / `formatExplain` / `summarizeTeam` / `canLeaveTeam` / `buildTeamCards` / `buildScreeningRows` / `buildFunnelView` / `formatEventTrail` 全部**不碰 `document`**，可在 `node:test` 里直接测 | **【2026-10-21 父代理预审 Minor T6-5】** 变异检验暴露「渲染路径无覆盖」的盲区 —— 把渲染逻辑从 DOM 里剥出来，纯函数才能被直接断言 |
| 种子**必须显式授角色** | 种子里的每个用户都 `insertUserRole`（队长→`captain`、组员→`member`、企业代表→`enterprise`） | **【2026-10-21 父代理预审 Critical T7-1】** `createUser` 不分配角色（角色在 `user_roles` 表）。契约 §2 规定了角色模型，但没说「谁负责授」—— 种子是**唯一的**账号来源，不授则演示版全死。⚠️ P2–P6 的种子扩充同样必须显式授角色 |
| 种子数据的**配比构成** | 进池 10 张 = 4×A + 2×B + 1×C + 3×自由（精确命中 R-ENT-09 的 40/20/10/30，容差 ±10%）；另 1 张 D 级卡用于演示退回 + 诊断报告 | **【2026-10-21 父代理预审 Important T7-5】** 契约只给了 R-ENT-09 的比例，没给演示数据的张数。选 10 张是因为 10 的整数分之一能精确落档（4/2/1/3），不触发容差边界 |
| 种子**幂等**约定 | 每个实体「先查后建」：用户按手机号、届期按名字、任务卡按标题、报名按 `findActiveRegistration`、战队按名字 | **【2026-10-21 父代理预审 Important T7-2】** 契约没规定。P6 的部署手册会写「跑一次种子」—— 不可重入的种子是地雷。与 P0 种子自己的 `findUserByPhone` 同一约定 |
| 领域层**只消费已呈现对象** | `checkTaskMix` 吃服务层的驼峰形状（`p.isFreeBrief`），**不吃数据库行**（`p.is_free_brief`） | **【2026-10-21 父代理预审 Task 7 预审踩坑登记】** 预审探针自己写错了一次，得出「自由占比 0%」的假象。与 Task 4 的 T4-2 是同一个坑 |

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
| SYNC-4 | `scripts/seed.js` | P0 修复轮（I-3 零依赖 import 守卫、I-7 裸 SQL 全部下沉仓储层）→ P1 端到端串联与种子扩充 → P2 `scoreStage` → P3 终审修复轮（个人积分榜 / MVP / 滚动榜告警）→ P4 审计 API 的种子位 | 293 | `--verify` 逐字一致 |

> **注意**：种子里的**能力点**在 P2 之后被扩过一轮（`peer_review:write` / `self_review:write` /
> `behavior:write` / `audit:write` / `appeal:write`），本计划块原本停留在 P1 的旧能力表 ——
> 这正是「同步」要消掉的漂移，而不是新需求。

### 良性扩展（仅记录，计划块保持原样）

| 编号 | 文件 | 后续阶段的追加内容 |
|---|---|---|
| SYNC-14 | `src/db/repo/taskPackages.js` | P1 修复轮（兜底排序键从随机 UUID 改为 `rowid`）；P5 Task 3 修复轮（三池派生相关追加） |
| SYNC-15 | `src/db/repo/teams.js` | P1 修复轮（同上：`rowid` 兜底键）；P2 追加赛段名册相关查询 |
| SYNC-16 | `src/services/team.js` | P1 Task 4 独立评审处置与 Task 5 战队成员管理；P3 终审修复轮（个人积分榜相关写入通路） |

> ⚠️ **口径**：C-EXT 的「良性」指**结构上**是追加，不等于内容永远不变。
> 漂移审计可随时复算：`node docs/tools/plan-block-audit.mjs platform`。
> 若某个文件后续被**重写**（而非追加），它会自动从 C-EXT 升到 C-RW，届时必须再做一次同步。


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

```json
{
  "id": "registration",
  "version": "2026-10-20",
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
import {
  submitRegistration, getRegistration, listRegistrations, decideRegistration,
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
  insertRegistrationEvent, listRegistrationEvents,
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
    if (/UNIQUE|constraint/i.test(String(err.message))) {
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

export function getRegistration({ db, id, viewer, rules }) {
  const row = findRegistrationRow(db, id);
  if (!row) return null;
  // 可见性在 API 层过滤（设计文档 §6.6 / §7.3）：本人或组委会（registration:review）
  const isOwner = viewer && viewer.id === row.user_id;
  const isCommittee = viewer
    && can(viewer, 'registration:review', { scopeType: 'edition', scopeId: row.edition_id }, db);
  if (!isOwner && !isCommittee) return null;

  const out = presentRegistration(row, rules.registration);
  out.events = listRegistrationEvents(db, id).map((e) => ({
    id: e.id,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    actorId: e.actor_id,
    reason: e.reason,
    createdAt: e.created_at,
  }));
  return out;
}

export function listRegistrations({ db, filter = {}, viewer, rules }) {
  // 列表权限不满足 → 空数组（API 层返回 200 + 空集，不暴露"有但不给看"）
  const ok = viewer
    && can(viewer, 'registration:review', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  if (!ok) return [];
  return listRegistrationRows(db, filter).map((row) => presentRegistration(row, rules.registration));
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
    const updated = updateRegistrationRow(db, id, { status: 'appealed' });
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
    // ⚠️ 2026-10-21 验收修正（规格缺陷）：`registration:write` 这个能力点被注册、
    //    被授予（seed 里给了 captain / member，测试里也显式授予），
    //    但**路由从不校验它** → 能力点形同虚设，违反全局约束
    //    「权限模型 = capability + assignment，`can()` 是唯一判定入口」。
    //    已登录但没有该能力 → 403（三态：禁用 → 403；不是 404，资源不存在才用 404）。
    if (!can(user, 'registration:write', null, db)) {
      throw new AppError(403, 'FORBIDDEN', '你没有提交报名的权限');
    }
    const { editionId, answers } = body ?? {};
    if (!editionId) throw new AppError(400, 'MISSING_EDITION_ID', '缺少届期');
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
  const edition = db ? (listEditions(db)[0] ?? null) : null;
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
> P0 的文件与计划**一字不动**。
>

- [ ] **Step 7: 创建 P1 新增的 3 份规则配置并扩展 src/config.js**

> ⚠️ 放在本 Task 而不是 Task 5：`loadRules()` 会一次性加载 `rules/` 下全部文件。
> 只要有一份缺失，**后面所有用 `loadRules()` 的测试都会连带失败**（Task 3/4/5/7 的测试都要用）。
> 因此「新增规则文件 + 配置加载与校验」必须先于任何消费它们的测试落地。

`platform/rules/team-formation.json`（**内容逐字取自 INTERFACES.md §2，不得改动**）：

```json
{
  "id": "team-formation",
  "version": "2026-10-20",
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

```json
{
  "id": "schedule",
  "version": "2026-10-20",
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

```json
{
  "id": "compliance",
  "version": "2026-10-20",
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

function call(app, method, path, { token = null, body = null } = {}) {
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

test('GET /api/registration-criteria 无需登录即可读（筛选标准对外透明）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/registration-criteria');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.dimensions.length, 3);
  assert.equal(body.levels.find((l) => l.key === 'S').minScore, 80);
  assert.equal(body.funnel.length, 5);
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
  assert.equal(JSON.parse(byAdmin.body).levelFinal, 'B');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
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
Expected: PASS（24 个测试全过：registration-service 10 + registration-api 10 + config-p1 4）

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
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.grade, 'D');
  assert.equal(approved.status, 'returned');
  assert.equal(approved.commitment, '无');
  assert.ok(approved.meta.solvability.diagnosticReport, 'D 级必须有诊断报告');
  assert.equal(approved.meta.solvability.diagnosticReport.title, '问题可解性诊断报告');
  assert.ok(approved.meta.solvability.diagnosticReport.vetoes.length > 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('存在一票否决时不得签成 A 级（强制降到 D）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
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
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', actorId: enterprise.id, now: NOW, rules });
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
  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, enterprise, admin, outsider,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function call(app, method, path, { token = null, body = null } = {}) {
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/solvability-domain.test.js test/task-package-service.test.js test/task-package-api.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/solvability.js'`

- [ ] **Step 3: 改写 rules/solvability.json 的 taskMix 段**

`platform/rules/solvability.json` 里的 `taskMix` 换成（其余字段逐字保留）：

```json
  "taskMix": {
    "enterprise": 0.70,
    "free": 0.30,
    "enterpriseGradeSplit": { "A": 0.40, "B": 0.20, "C": 0.10 },
    "tolerance": 0.10
  },
  "taskMixNote": "R-ENT-09（顶层文档 §3.1）：任务卡 70% B 端 + 30% 自由；任务池内 A 40% / B 20% / C 10% / 自由 30%（四档合计 100%，分母是**全体任务卡**，不是 B 端子集）。tolerance=0.10 为【我方假设】的配比浮动容忍度，首届后按实测调整。"
```

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
function detectVetoes({ answers, config }) {
  const hit = new Set();
  for (const key of Array.isArray(answers.vetoes) ? answers.vetoes : []) {
    if (config.vetoes.some((v) => v.key === key)) hit.add(key);
  }
  if (Number(answers.data_access ?? 0) <= 0) hit.add('no_data_authorization');
  if (Number(answers.accountability ?? 0) <= 0) hit.add('no_responsible_owner');
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
import { can } from '../auth/permissions.js';

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

  // R-ENT-11：IP 与成果归属 —— 同意记录随任务卡一起留存
  const meta = {
    consent: { ...(consent ?? {}), acceptedAt: now },
    ipOwnership: rules.compliance?.ipOwnership ?? {},
  };

  const row = createTaskPackage(db, {
    editionId, enterpriseId, enterpriseName, title, painPoint,
    expectedDelivery, acceptanceCriteria, isFreeBrief, submittedBy: userId, meta, now,
  });
  return presentTaskPackage(row);
}

export function assessSolvability({ db, taskPackageId, answers, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
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

export function approveTaskPackage({ db, taskPackageId, grade, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');

  let gradeCfg = config.grades.find((g) => g.key === grade);
  if (!gradeCfg) {
    throw new AppError(400, 'INVALID_GRADE', `等级必须是 ${config.grades.map((g) => g.key).join(' / ')}`);
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
    meta.solvability = solvability;
    patch.meta_json = meta;
  }

  const updated = updateTaskPackage(db, taskPackageId, patch);
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
    return approveTaskPackage({ db, taskPackageId: params.id, grade: body?.grade, actorId: user.id, rules });
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
Expected: PASS（39 个测试全过：solvability-domain 10 + task-package-service 14 + task-package-api 15）

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/team-service.test.js`
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
  insertTeam, getTeam, listTeamRows, updateTeamRow, countActiveTeamsByPackage,
} from '../db/repo/teams.js';
import {
  insertTeamMember, listActiveMembers, listMemberHistory, markMemberLeft,
  countActiveMembers, findActiveMembershipByUser, lastLeaveAt,
} from '../db/repo/teamMembers.js';
import { can } from '../auth/permissions.js';

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
  const team = getTeam(db, teamId);
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
  return teamView(db, team.id, rules);
}

export function getTeam({ db, id, viewer, rules }) {
  const row = getTeam(db, id);
  if (!row) return null;
  // 可见性：战队成员 / 组长 / 有 team:read 授权的人
  const isMember = listActiveMembers(db, id).some((m) => m.user_id === viewer?.id);
  const isCaptain = row.captain_id === viewer?.id;
  const hasRight = viewer && can(viewer, 'team:read', { scopeType: 'team', scopeId: id }, db);
  if (!isMember && !isCaptain && !hasRight) return null;
  return teamView(db, id, rules);
}

export function addMember({ db, teamId, userId, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = getTeam(db, teamId);
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
  const team = getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const member = listActiveMembers(db, teamId).find((m) => m.user_id === userId);
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', '该同学不在此战队');
  if (member.role === 'captain') {
    throw new AppError(409, 'CAPTAIN_MUST_REPLACE', '组长不能直接退出，请先汰换成员并移交组长职责');
  }
  markMemberLeft(db, member.id, now);
  // R-REG-04：仅剩 1 人 → 触发并队
  if (countActiveMembers(db, teamId) <= 1) {
    updateTeamRow(db, teamId, { status: 'needs_merge' });
  }
  return teamView(db, teamId, rules);
}

export function replaceMember({
  db, teamId, outUserId, inUserId, actorId, now = new Date().toISOString(), rules,
}) {
  const config = rules.teamFormation;
  const team = getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');

  // R-REG-03：换人要队长或组委会同意（memberChange.requireCaptainOrAdmin）
  if (config.memberChange.requireCaptainOrAdmin) {
    const actor = getUserById(db, actorId);
    const isCaptain = team.captain_id === actorId;
    const isAdmin = actor && can(actor, 'team:manage', { scopeType: 'team', scopeId: teamId }, db);
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
  if (remaining <= 1) {
    updateTeamRow(db, teamId, { status: 'needs_merge' });
  } else if (team.status === 'forming') {
    updateTeamRow(db, teamId, { status: 'active' });
  }
  return teamView(db, teamId, rules);
}

export function updateTeam({ db, teamId, patch, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');

  const actor = getUserById(db, actorId);
  const isCaptain = team.captain_id === actorId;
  const isAdmin = actor && can(actor, 'team:manage', { scopeType: 'team', scopeId: teamId }, db);
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
import {
  createTeam, getTeam, addMember, leaveTeam, replaceMember, updateTeam, listMyTeams,
} from '../../services/team.js';

export function registerTeamRoutes({ router, db, rules }) {
  router.add('POST', '/api/teams', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
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
      return addMember({
        db, teamId: params.id, userId: body?.userId ?? user.id, actorId: user.id, rules,
      });
    }
    if (action === 'leave') {
      return leaveTeam({ db, teamId: params.id, userId: body?.userId ?? user.id, rules });
    }
    if (action === 'replace') {
      return replaceMember({
        db, teamId: params.id, outUserId: body?.outUserId, inUserId: body?.inUserId,
        actorId: user.id, rules,
      });
    }
    throw new AppError(400, 'INVALID_ACTION', 'action 只能是 add / leave / replace');
  });

  router.add('PATCH', '/api/teams/:id', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
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

Run: `cd platform && node --test test/team-service.test.js test/config.test.js`
Expected: PASS（12 个测试全过：team-service 12）
> `test/config.test.js` 是 **P0 已有文件**，本 Task 追加的配置校验用例会让它的条数增长 ——
> 实施后必须同步更新 **P0 计划**里 `config.test.js` 的条数声明（跨计划的同一条纪律）。

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/services/team.js src/http/routes/team.js src/server.js test/team-service.test.js
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

**Interfaces:**
- Consumes: Task 3 `GET /api/registration-criteria`、`POST /api/registrations`；Task 4 `GET /api/task-packages`；Task 5 `GET /api/teams`、`GET /api/teams/:id`、`POST /api/teams`、`POST /api/teams/:id/members`、`PATCH /api/teams/:id`；Task 3 `GET /api/registrations`、`POST /api/registrations/:id/level`
- Produces:
  - `web/views/registration.js` → `buildQuestionnaire(criteria)`、`formatExplain(explain, scale)`、`renderRegistration(ctx)`
  - `web/views/team.js` → `summarizeTeam(team)`、`renderTeam(ctx)`
  - `web/views/admin-registration.js` → `buildScreeningRows(registrations, criteria)`、`buildFunnelView(registrations, funnel)`、`renderAdminRegistration(ctx)`
  - 路由：`#/apply`｜`#/team`｜`#/admin/registration`
  - ⛔ 每个视图模块的**纯逻辑导出**不得触碰 `document`（这样 `node:test` 能在无 DOM 环境直接测）

- [ ] **Step 1: 写失败的测试**

`platform/test/p1-frontend.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionnaire, formatExplain } from '../web/views/registration.js';
import { summarizeTeam } from '../web/views/team.js';
import { buildScreeningRows, buildFunnelView } from '../web/views/admin-registration.js';

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/p1-frontend.test.js`
Expected: FAIL —— `Cannot find module '../web/views/registration.js'`

- [ ] **Step 3: 创建 web/views/registration.js**

```javascript
// web/views/registration.js — 报名问卷（选手视角）
// 依据：设计文档 §9「报名问卷：每题显示该题所属维度与分值；明示筛选标准（R-REG-09）；
//       提交后展示『你被判为 X 级』及可解释明细」
// ⛔ buildQuestionnaire / formatExplain 是纯函数，不得触碰 document（便于 node:test 直接测）
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

export function renderRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card apply';
  wrap.innerHTML = '<p class="muted">正在加载报名问卷…</p>';
  const { api, navigate } = ctx;

  (async () => {
    const criteria = await api.get('/api/registration-criteria');
    const q = buildQuestionnaire(criteria);
    const form = document.createElement('form');
    form.innerHTML = `
      <h1>报名</h1>
      <section class="criteria">
        <h2>筛选标准（公开透明，报名之前就告诉你）</h2>
        <ul>${q.criteriaLines.map((l) => `<li>${l}</li>`).join('')}</ul>
        <p class="muted">${q.open.text}</p>
        <p class="muted">${q.ipOwnership.team ?? ''} ${q.ipOwnership.committee ?? ''} ${q.ipOwnership.enterprise ?? ''}</p>
      </section>
      ${q.dims.map((d) => `
        <section class="dim" data-dim="${d.key}">
          <h2>${d.label}（权重 ${d.weightLabel}，每题 ${d.min}–${d.max} 分）</h2>
          ${d.items.map((it, i) => `
            <label>${it.text}
              <select name="${d.key}-${i}">
                ${Array.from({ length: d.max - d.min + 1 }, (_, k) => d.min + k)
                  .map((v) => `<option value="${v}">${v}</option>`).join('')}
              </select>
            </label>`).join('')}
        </section>`).join('')}
      <label>${q.open.text}<textarea name="open" maxlength="${q.maxLength}"></textarea></label>
      <label><input type="checkbox" name="consent" /> ${q.consentPrompt}</label>
      <button type="submit">提交报名</button>
      <p id="reg-err" class="err"></p>
      <div id="reg-result"></div>
    `;

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = form.querySelector('#reg-err');
      const result = form.querySelector('#reg-result');
      err.textContent = '';
      result.innerHTML = '';
      const answers = { open: form.querySelector('[name=open]').value.trim() };
      for (const d of q.dims) {
        answers[d.key] = d.items.map((_, i) => Number(form.querySelector(`[name="${d.key}-${i}"]`).value));
      }
      answers.consent = { accepted: form.querySelector('[name=consent]').checked };
      try {
        const reg = await api.post('/api/registrations', {
          editionId: criteria.editionId,
          answers,
        });
        const levelLabel = q.levels.find((l) => l.key === reg.level)?.label ?? reg.level;
        result.innerHTML = `
          <h2>你被判为 ${reg.level} 级（${levelLabel}）</h2>
          <p>总分 ${reg.grading.score} 分</p>
          <ul>${formatExplain(reg.grading.explain, criteria.scale).map((e) => `<li>${e.text}</li>`).join('')}</ul>
          <p>${reg.grading.accepted ? '你已被接收，可以去组队。' : '本级不接收，可向组委会提交申诉。'}</p>
          <button id="go-team" type="button">去组队</button>`;
        result.querySelector('#go-team').addEventListener('click', () => navigate('/team'));
      } catch (e) {
        err.textContent = e.message;
      }
    });

    wrap.replaceChildren(form);
  })().catch((e) => {
    wrap.innerHTML = `<div class="card err">${e.message}</div>`;
  });

  return wrap;
}
```

- [ ] **Step 4: 创建 web/views/team.js**

```javascript
// web/views/team.js — 我的战队（选手视角）
// 依据：设计文档 §9「我的战队 + 组队/汰换」
// 依据：R-REG-01（建队即认领任务包）、R-REG-03（持续招募汰换）、R-REG-04（仅剩 1 人须并队）
const STATUS_LABELS = {
  forming: '组建中（未满 2 人）',
  active: '已成立',
  needs_merge: '仅剩 1 人，须并队',
  dissolved: '已解散',
};

export function summarizeTeam(team) {
  const members = team?.members ?? [];
  const captain = members.find((m) => m.role === 'captain');
  return {
    id: team?.id ?? null,
    title: team?.name ?? '',
    memberCount: members.length,
    status: team?.status ?? 'forming',
    statusLabel: STATUS_LABELS[team?.status] ?? team?.status ?? '',
    captainId: captain?.userId ?? team?.captainId ?? '',
    needsMerge: team?.needsMerge === true,
    mergeDeadline: team?.mergeDeadline ?? null,
    formationOk: team?.formation?.ok === true,
    formationErrors: team?.formation?.errors ?? [],
    milestoneCount: team?.milestones?.items?.length ?? 0,
  };
}

export function renderTeam(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card team';
  wrap.innerHTML = '<p class="muted">正在加载我的战队…</p>';
  const { api } = ctx;

  (async () => {
    const [criteria, teamsRes, packagesRes] = await Promise.all([
      api.get('/api/registration-criteria'),
      api.get('/api/teams'),
      api.get('/api/task-packages'),
    ]);
    const teams = teamsRes.items ?? [];
    const packages = packagesRes.items ?? [];

    const cards = teams.map((t) => {
      const s = summarizeTeam(t);
      return `
        <section class="team-card">
          <h2>${s.title}</h2>
          <p class="muted">状态：${s.statusLabel}｜成员 ${s.memberCount} 人｜固定里程碑 ${s.milestoneCount} 项</p>
          ${s.needsMerge ? `<p class="err">⚠️ 仅剩 1 人，须在 ${s.mergeDeadline ?? '期限内'} 前并入其他战队</p>` : ''}
          ${s.formationErrors.map((e) => `<p class="err">${e}</p>`).join('')}
          <ul>${t.members.map((m) => `<li>${m.userId}（${m.role === 'captain' ? '组长' : '组员'}）</li>`).join('')}</ul>
          <button data-action="leave" data-team="${t.id}" data-user="${s.captainId}" ${s.captainId === ctx.getState().user?.id ? '' : 'disabled'}>退出</button>
        </section>`;
    });

    const opts = packages.map((p) => `<option value="${p.id}">${p.title}</option>`).join('');
    wrap.innerHTML = `
      <h1>我的战队</h1>
      ${cards.join('') || '<p class="muted">你还没有战队</p>'}
      <section class="create">
        <h2>组队（报名即认领任务包）</h2>
        <label>队名<input name="team-name" placeholder="甲队" /></label>
        <label>认领任务包<select name="package">${opts}</select></label>
        <button id="create-team">建队</button>
        <p id="team-err" class="err"></p>
      </section>`;

    wrap.querySelector('#create-team').addEventListener('click', async () => {
      const err = wrap.querySelector('#team-err');
      err.textContent = '';
      try {
        await api.post('/api/teams', {
          editionId: criteria.editionId,
          name: wrap.querySelector('[name=team-name]').value,
          taskPackageId: wrap.querySelector('[name=package]').value,
        });
        ctx.setState({});
        location.reload();
      } catch (e) {
        err.textContent = e.message;
      }
    });

    for (const btn of wrap.querySelectorAll('[data-action=leave]')) {
      btn.addEventListener('click', async () => {
        try {
          await api.post(`/api/teams/${btn.dataset.team}/members`, {
            action: 'leave', userId: btn.dataset.user,
          });
          location.reload();
        } catch (e) {
          wrap.querySelector('#team-err').textContent = e.message;
        }
      });
    }
  })().catch((e) => {
    wrap.innerHTML = `<div class="card err">${e.message}</div>`;
  });

  return wrap;
}
```

- [ ] **Step 5: 创建 web/views/admin-registration.js**

```javascript
// web/views/admin-registration.js — 组委会筛选台
// 依据：设计文档 §9「报名筛选台（含可解释明细）+ 复核/申诉/改级」「任务包与配比 70/30」
// 溯源：R-REG-09 / R-REG-10 / R-ENT-09
import { formatExplain } from './registration.js';

const STATUS_LABELS = {
  submitted: '已提交',
  screening: '筛选中',
  accepted: '已接收',
  rejected: '不接收',
  appealed: '申诉中',
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

export function renderAdminRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card admin-registration';
  wrap.innerHTML = '<p class="muted">正在加载报名筛选台…</p>';
  const { api } = ctx;

  (async () => {
    const criteria = await api.get('/api/registration-criteria');
    const editionId = criteria.editionId;
    const [{ items: registrations }, { items: packages, mix }] = await Promise.all([
      api.get(`/api/registrations?editionId=${editionId}`),
      api.get(`/api/task-packages?editionId=${editionId}`),
    ]);
    const { rows, distribution, total } = buildScreeningRows(registrations, criteria);
    const funnel = buildFunnelView(registrations, criteria.funnel);

    wrap.innerHTML = `
      <h1>报名筛选台</h1>
      <section class="funnel">
        <h2>筛选漏斗（R-REG-10）</h2>
        <ul>${funnel.map((f) => `<li>${f.label}：${f.rate === null ? '—' : `${Math.round(f.rate * 100)}%`}｜${f.current === null ? '待填充' : `当前 ${f.current} 人`}</li>`).join('')}</ul>
      </section>
      <section class="distribution">
        <h2>分级分布（共 ${total} 人）</h2>
        <ul>${Object.entries(distribution).map(([k, v]) => `<li>${k} 级 ${v} 人</li>`).join('')}</ul>
      </section>
      <section class="mix">
        <h2>任务包配比（R-ENT-09：70% B 端 + 30% 自由）</h2>
        <p>${mix ? `自由题 ${mix.free}/${mix.total}（${Math.round(mix.actualFree * 100)}%）｜B 端 ${mix.enterprise}｜${mix.ok ? '配比达标' : '配比未达标'}` : '无数据'}</p>
        ${mix && !mix.ok ? `<ul class="err">${mix.errors.map((e) => `<li>${e}</li>`).join('')}</ul>` : ''}
        <ul>${packages.map((p) => `<li>${p.title}｜${p.isFreeBrief ? '自由命题' : `B 端 ${p.solvabilityGrade ?? '未分级'} 级`}｜${p.agreement ?? ''}</li>`).join('')}</ul>
      </section>
      <table class="screening">
        <thead><tr><th>用户</th><th>系统分级</th><th>复核级别</th><th>分数</th><th>状态</th><th>可解释明细</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-id="${r.id}">
              <td>${r.userId}</td>
              <td>${r.autoLevel}</td>
              <td>${r.level}</td>
              <td>${r.score}</td>
              <td>${r.statusLabel}</td>
              <td>${r.explain.map((e) => e.text).join('<br />')}</td>
              <td>
                <select data-role="level">
                  ${criteria.levels.map((l) => `<option value="${l.key}" ${l.key === r.level ? 'selected' : ''}>${l.key}</option>`).join('')}
                </select>
                <input data-role="note" placeholder="复核意见" />
                <button data-role="save">改级</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p id="admin-err" class="err"></p>`;

    for (const btn of wrap.querySelectorAll('[data-role=save]')) {
      btn.addEventListener('click', async () => {
        const row = btn.closest('tr');
        const level = row.querySelector('[data-role=level]').value;
        const note = row.querySelector('[data-role=note]').value;
        try {
          await api.post(`/api/registrations/${row.dataset.id}/level`, { level, note });
          location.reload();
        } catch (e) {
          wrap.querySelector('#admin-err').textContent = e.message;
        }
      });
    }
  })().catch((e) => {
    wrap.innerHTML = `<div class="card err">${e.message}</div>`;
  });

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
Expected: PASS（6 个测试全过：p1-frontend 6）

- [ ] **Step 8: 提交**

```bash
cd platform && git add web/views web/app.js test/p1-frontend.test.js
git commit -m "feat(P1): 前端三页（报名问卷明示筛选标准 / 我的战队 / 组委会筛选台）

对应需求：R-REG-09 / R-REG-10 / R-REG-03 / R-REG-04 / R-ENT-09"
```

---

### Task 7: 端到端串联 + 种子扩充 + 验收

**Files:**
- Create: `platform/test/e2e-p1.test.js`
- Modify: `platform/scripts/seed.js`（P1 种子 + 角色能力补 `task_package:read`）

**Interfaces:**
- Consumes: Task 1–6 全部产物
- Produces:
  - `test/e2e-p1.test.js` —— 「报名 → 分级 → 建队 → 认领任务包 → 加人」全链路
  - `scripts/seed.js` 扩充：1 届期 + 1 城市 + 6 张任务卡（A/A/B/C/D/自由）+ 若干用户与报名 + 1 支已成立的战队
  - 角色能力映射补 `captain`/`member` 的 `task_package:read`（选手要能看见已发布的任务包才能认领）

- [ ] **Step 1: 写失败的测试**

`platform/test/e2e-p1.test.js`：

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
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { submitRegistration } from '../src/services/registration.js';
import { assessSolvability, approveTaskPackage } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/e2e-p1.test.js`
Expected: FAIL —— 断言不成立（Task 1–6 尚未全部落地时跑）

- [ ] **Step 3: 修改 scripts/seed.js**

`platform/scripts/seed.js` 追加 import 与 P1 种子块：

```javascript
// ① 顶部 import 追加
import { createEdition } from '../src/db/repo/editions.js';
import { createCity } from '../src/db/repo/cities.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { submitRegistration } from '../src/services/registration.js';
import { assessSolvability, approveTaskPackage } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';
import { loadRules } from '../src/config.js';

// ② ROLE_CAPABILITIES 补两行（选手要能读已发布的任务包才能认领）
//    ['captain', 'task_package:read'], ['member', 'task_package:read'],

// ③ 在种子主流程末尾追加调用
//    seedP1({ db, rules, adminId: admin.id });

// ④ 新增函数
function seedP1({ db, rules, adminId }) {
  const NOW = '2026-10-20T00:00:00.000Z';
  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  createCity(db, { name: '上海', editionId: edition.id });

  const enterprise = createUser(db, {
    name: '某零售·企业代表', phone: '13800000001', password: 'demo-pw', mbaStatus: 'other', org: '某零售',
  });

  const FULL = {
    problem_clarity: 3, data_access: 3, validation: 2,
    decision_chain: 1, accountability: 1, precedent: 1,
  };
  const ZERO = {
    problem_clarity: 0, data_access: 0, validation: 0,
    decision_chain: 0, accountability: 0, precedent: 0,
  };
  const specs = [
    { title: '门店排班优化', grade: 'A', free: false, answers: FULL },
    { title: '供应链需求预测', grade: 'A', free: false, answers: FULL },
    { title: '客服知识库问答', grade: 'B', free: false, answers: FULL },
    { title: '门店陈列合规巡检', grade: 'C', free: false, answers: FULL },
    { title: '社区养老排班助手', grade: 'D', free: false, answers: ZERO },
    { title: '开源模型微调实验', grade: null, free: true, answers: FULL },
  ];

  const packages = [];
  for (const spec of specs) {
    const pkg = createTaskPackage(db, {
      editionId: edition.id,
      enterpriseId: spec.free ? null : 'ent_retail',
      enterpriseName: spec.free ? null : '某零售',
      title: spec.title,
      painPoint: `${spec.title}：目前靠人工，效率低且不可复制`,
      expectedDelivery: '可运行原型 + 一次真实数据验证',
      acceptanceCriteria: '门店负责人认可并愿意试点',
      isFreeBrief: spec.free,
      submittedBy: enterprise.id,
      meta: { consent: { accepted: true, acceptedAt: NOW }, ipOwnership: rules.compliance.ipOwnership },
      now: NOW,
    });
    assessSolvability({ db, taskPackageId: pkg.id, answers: spec.answers, actorId: enterprise.id, now: NOW, rules });
    if (spec.grade) {
      approveTaskPackage({ db, taskPackageId: pkg.id, grade: spec.grade, actorId: adminId, now: NOW, rules });
    }
    packages.push(pkg);
  }

  // 选手：一组画像强度不同的报名，覆盖 S/A/B/C 四档
  const profiles = [
    { name: '队长甲', phone: '13800000011', mbaStatus: 'mba', answers: [5, 5, 5, 5, 5] },
    { name: '组员乙', phone: '13800000012', mbaStatus: 'mba', answers: [4, 4, 4, 4, 4] },
    { name: '组员丙', phone: '13800000013', mbaStatus: 'mba', answers: [3, 3, 3, 3, 3] },
    { name: '落选丁', phone: '13800000014', mbaStatus: 'mba', answers: [1, 1, 1, 1, 1] },
  ];
  const users = [];
  for (const p of profiles) {
    const u = createUser(db, { name: p.name, phone: p.phone, password: 'demo-pw', mbaStatus: p.mbaStatus });
    const answers = {
      direction: p.answers, capability: p.answers, collaboration: p.answers,
      open: '我想用 AI 解决真实门店的排班与库存协同问题',
      consent: { accepted: true },
    };
    const reg = submitRegistration({ db, userId: u.id, editionId: edition.id, answers, now: NOW, rules });
    users.push({ user: u, level: reg.level });
  }

  // 一支已成立的战队（认领第一张 A 级任务卡）
  const captain = users[0].user;
  const member = users[1].user;
  const team = createTeam({
    db, userId: captain.id, editionId: edition.id,
    taskPackageId: packages[0].id, name: '甲队', now: NOW, rules,
  });
  addMember({ db, teamId: team.id, userId: member.id, actorId: captain.id, now: NOW, rules });

  console.log(
    `P1 种子：届期 ${edition.name}｜任务卡 ${packages.length} 张｜选手 ${users.length} 人（等级 ${users.map((u) => u.level).join('/')}）｜战队 甲队`,
  );
}
```

- [ ] **Step 4: 运行全量测试**

Run: `cd platform && node --test`
Expected: 全部通过（P0 的用例 + P1 的 9 个测试文件）

- [ ] **Step 5: 实跑种子与迁移**

Run: `cd platform && rm -rf data && node scripts/migrate.js && node scripts/seed.js`
Expected: 输出 `迁移完成，当前版本 2`；种子输出 `P1 种子：届期 首届 · 上海｜任务卡 6 张｜选手 4 人（等级 S/A/B/C）｜战队 甲队`

Run: `cd platform && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

Run: `curl -s http://127.0.0.1:8080/api/registration-criteria | head -c 200`
Expected: JSON 含 `"dimensions"`、`"levels"`、`"funnel"`

- [ ] **Step 6: 提交**

```bash
cd platform && git add scripts/seed.js test/e2e-p1.test.js
git commit -m "feat(P1): 端到端串联与种子扩充（报名→分级→建队→认领→加人）

对应需求：R-REG-01 / R-REG-02 / R-REG-05 / R-REG-08 / R-STG-03 / R-ENT-08"
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

## Task 4 父代理预审修正台账（2026-10-21）

> Task 4 的规格在**实施前**先被父代理逐条实跑预审，发现 **2 Critical + 5 Important + 2 Minor**，
> 全部在本计划里改完后再实施（「先跑后派」纪律：规格改动必须抽取成独立工程实跑通过，再落盘）。
> 全部缺陷均**实跑复现**，复现方式见「实跑证据」列。

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

| 口径 | 本阶段实现 | 出处与状态 |
|---|---|---|
| 六维的一票否决 ①② 由维度推导 | `data_access = 0` → 自动命中「无法提供数据授权说明」；`accountability = 0` → 自动命中「无企业侧唯一责任人」；③「涉及生产系统且未谈责任归属」只能由出题方自报 | 顶层文档 §3.2 的六维与三条否决是同一件事的两种说法（原文把「责任可归属」列为维度、把「唯一责任人」列为否决）。**属我方推断，需组委会追认** |
| 分级落在档位间隙时向下取档 | 分值落在两档之间（例如 6.8）取更低一档 | 六维分值是 0–12 的连续量，档位是 10-12 / 7-9 / 4-6 / 0-3，间隙必然存在。**我方假设** |
| R-REG-01「报名即认领任务包」的落点 | 认领动作落在**建队时刻**（`teams.task_package_id`），报名表不带任务包字段 | 设计文档 §10 流 1 写的是「队长建队 → 认领任务包 → 成员加入」，且契约的 `registrations` 表无任务包列。**若组委会要求「报名表里就选任务包」**，需在 `002_registration.sql` 给 `registrations` 加列 → 契约变更 |
| `GET /api/registrations` 不带 `editionId` 的含义 | 返回**全部届期**的报名（组委会视角）；带 `editionId` 才按届期过滤 | 与「全局授权不做行级过滤」一致（`scopeClause` 对 `scope_type='global'` 的授权不设限）。**带版期授权的组委会成员**（`scope_type='edition'`）在不带 `editionId` 时看不到任何行 —— 因为 `scopeId` 为空、匹配不上任何一版。⚠️ 若组委会希望「不带 editionId 时只看自己有权限的届期」，需要把 `editionId` 变成**必填**（契约变更） |
| `POST /api/registrations` 的能力点校验 | 已登录 + `can(user, 'registration:write', …)` 才放行，否则 **403** | **【2026-10-21 父代理验收修正】** 计划原文只判「有没有登录」→ `registration:write` 这个被注册、被 seed 授予的能力点**形同虚设**，违反全局约束「`can()` 是唯一判定入口」。⚠️ **副作用**：新注册的账号若没有任何角色 / 授权，将无法报名（seed 里 captain 与 member 都有 `registration:write`，所以正常路径不受影响）。若组委会要求「任何人注册后即可报名」，则应改为「报名成功时自动授予 member 角色」—— 那是契约变更 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

# P0 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一个能登录的空系统：零依赖运行时、SQLite 数据层、fail-fast 规则配置、HTTP 路由、服务端会话、capability + assignment 权限骨架、静态前端。

**Architecture:** 单进程 Node（仅标准库）。`src/http/` 提供路由与响应；`src/db/` 提供 SQLite 封装、迁移与仓储层（所有 SQL 收在这里）；`src/domain/` 放纯函数规则引擎（无 IO，本阶段先建空壳接口）；`src/auth/` 管认证与权限判定；`src/config.js` 加载并校验 `rules/*.json`，校验不过直接拒绝启动。前端为原生 ESM，`web/` 静态托管，`web/api.js` 与 `web/api.demo.js` 双适配器共用同一套视图。

**Tech Stack:** Node ≥22.5（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## Global Constraints

```
运行时      Node ≥ 22.5（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite。data/app.db，WAL 模式。单写者：禁止多 worker 写同一文件
测试        node:test。命令：node --test
            ⚠️ 不要写成 `node --test test/`：Node 22 的位置参数按 glob/模块路径处理，
               目录【不会】被展开 → MODULE_NOT_FOUND，pass 0 / fail 1。
               实测（Node v22.23.2）：`node --test` ✅ ｜ `node --test test/` ❌ ｜
               `node --test test/xxx.test.js` ✅（单文件形式合法）
               依据：设计文档 §4.3 的 package.json 片段本身就是 `"test":"node --test"`。
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

## File Structure

**本阶段创建**

```
platform/
├── package.json                  零依赖，仅 type:module + scripts
├── rules/                        9 份规则配置（配置驱动的基础）
│   ├── scoring-initial.json
│   ├── scoring-final.json
│   ├── tiebreak.json
│   ├── ranks.json
│   ├── behavior-points.json
│   ├── visibility.json
│   ├── registration-scoring.json
│   ├── solvability.json
│   └── milestones.default.json
├── src/
│   ├── server.js                 进程入口：建库 → 迁移 → 校验配置 → 装配路由 → 监听
│   ├── config.js                 配置加载 + fail-fast 校验
│   ├── http/
│   │   ├── router.js             方法+路径 → handler，支持 :param
│   │   ├── respond.js            JSON / 文本 / 错误响应
│   │   ├── body.js               JSON body 解析（带大小上限）
│   │   ├── static.js             静态文件服务（ETag）
│   │   └── sse.js                SSE 事件总线
│   ├── auth/
│   │   ├── password.js           scrypt 哈希与校验
│   │   ├── session.js            会话签发/校验/吊销
│   │   └── permissions.js        capability + assignment 判定
│   ├── db/
│   │   ├── sqlite.js             连接封装 + 迁移执行
│   │   ├── migrate.js            迁移文件读取与应用
│   │   └── repo/
│   │       ├── users.js
│   │       ├── sessions.js
│   │       └── assignments.js
│   └── audit/
│       └── log.js                审计日志写入
├── db/migrations/001_init.sql    初始表结构
├── web/
│   ├── index.html
│   ├── app.js
│   ├── router.js
│   ├── store.js
│   ├── api.js
│   ├── api.demo.js
│   ├── styles.css
│   └── views/login.js
├── scripts/
│   ├── migrate.js
│   ├── seed.js
│   └── forbidden.txt
└── test/
    ├── config.test.js
    ├── password.test.js
    ├── permissions.test.js
    └── router.test.js
```

---

### Task 1: 零依赖骨架与"零依赖"守卫

**Files:**
- Create: `platform/package.json`
- Create: `platform/test/zero-deps.test.js`
- Create: `platform/README.md`

**Interfaces:**
- Consumes: 无
- Produces: `npm test` 可用（`node --test`）；`npm start` 指向 `src/server.js`（本阶段先占位，后续 Task 替换）

- [ ] **Step 1: 写失败的测试**

`platform/test/zero-deps.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json 没有任何 dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '禁止新增 dependencies');
  assert.equal(pkg.devDependencies, undefined, '禁止新增 devDependencies');
});

test('仓库里没有 node_modules（证明未联网安装过）', () => {
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('platform/ 下不存在 package-lock.json 或 node_modules', () => {
  assert.equal(existsSync(join(root, 'package-lock.json')), false);
});

test('每个 src 子目录都有 .js 文件且无空文件', () => {
  const srcDir = join(root, 'src');
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readdirSync(join(srcDir, entry.name)).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, `src/${entry.name} 没有 .js 文件`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/zero-deps.test.js`
Expected: FAIL —— `ENOENT: no such file or directory, open 'platform/package.json'`

- [ ] **Step 3: 创建 package.json**

`platform/package.json`：

```json
{
  "name": "heikesong-platform",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5.0" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test",
    "migrate": "node scripts/migrate.js",
    "seed": "node scripts/seed.js"
  }
}
```

- [ ] **Step 4: 创建 README.md**

`platform/README.md`：

```markdown
# AI 商业黑客松赛事平台

零依赖 Node 单体。`git clone` 后不需要 `npm install`，直接：

```bash
node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test         # 跑测试
```

## 硬约束

- **npm 依赖 0 个**。只用 Node 标准库。`test/zero-deps.test.js` 会守住这条。
- **规则不写死在代码里**。可变规则全在 `rules/*.json`，改 JSON 即改规则。
- **配置校验 fail-fast**。权重合计不等于 100% 就拒绝启动，不静默降级。
- **行为分不进总分**。总分函数的签名里就没有行为分参数。
- **两种"企业签字"是两张表**。`enterprise_confirmations`（主观评分，进总分）/ `milestone_signoffs`（客观事实，不进总分）。
- **可见性在 API 层过滤**。前端拿不到无权数据。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `DATA_DIR` | `./data` | 数据库与上传目录 |
| `SESSION_TTL_DAYS` | 7 | 会话有效期 |

## 设计文档

`../docs/superpowers/specs/2026-10-20-heikesong-platform-design.md`
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/zero-deps.test.js`
Expected: PASS（4 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add package.json README.md test/zero-deps.test.js
git commit -m "feat(P0): 零依赖骨架与零依赖守卫测试"
```

---

### Task 2: SQLite 封装与迁移机制

**Files:**
- Create: `platform/src/db/sqlite.js`
- Create: `platform/src/db/migrate.js`
- Create: `platform/db/migrations/001_init.sql`
- Create: `platform/scripts/migrate.js`
- Create: `platform/test/migrate.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `openDatabase({ dataDir })` → `{ db, close() }`，已开启 WAL 与 foreign_keys
  - `applyMigrations(db, migrationsDir)` → `{ applied: string[], version: number }`
  - `readMigrationFiles(dir)` → `[{ version, name, sql }]`（按 version 升序）

- [ ] **Step 1: 写失败的测试**

`platform/test/migrate.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations, readMigrationFiles } from '../src/db/migrate.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-mig-'));
}

test('迁移按版本升序读取', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '002_second.sql'), 'CREATE TABLE b (x INTEGER);');
  writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
  const files = readMigrationFiles(dir);
  assert.deepEqual(files.map((f) => f.version), [1, 2]);
  rmSync(dir, { recursive: true, force: true });
});

test('迁移是幂等的：重复执行不重复应用', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  const first = applyMigrations(db, dir);
  assert.equal(first.applied.length, 1);

  const second = applyMigrations(db, dir);
  assert.equal(second.applied.length, 0, '第二次不应再应用');
  assert.equal(second.version, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('WAL 与 foreign_keys 已开启', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/migrate.test.js`
Expected: FAIL —— `Cannot find module '../src/db/sqlite.js'`

- [ ] **Step 3: 创建 src/db/sqlite.js**

```javascript
// src/db/sqlite.js — SQLite 连接封装
// 依据：设计文档 §4.2。node:sqlite 是同步 API，慢查询会阻塞 event loop，
//       因此所有 SQL 必须在仓储层预编译 + 参数化。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase({ dataDir = './data', filename = 'app.db' } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, filename));

  // WAL：读不阻塞写、写不阻塞读（sqlite.org/wal.html）
  // ⚠️ WAL 要求所有进程在同一台主机；数据库文件不能放 NFS（sqlite.org/faq.html）
  db.exec('PRAGMA journal_mode = WAL');
  // 外键约束默认关闭，必须显式打开
  db.exec('PRAGMA foreign_keys = ON');
  // 遇到锁等待 5 秒再报错，避免瞬时并发直接失败
  db.exec('PRAGMA busy_timeout = 5000');

  return {
    db,
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: 创建 src/db/migrate.js**

```javascript
// src/db/migrate.js — 迁移机制
// 依据：设计文档 §14.2。迁移只向前，不回滚；用 schema_migrations 表记录版本。
//   ⛔ 不赌原生 ALTER TABLE 的能力边界（node:sqlite 捆绑的 SQLite 版本未核实），
//      一律"新表 + 迁移"，expand-contract 三步走。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

export function readMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      const version = Number(name.split('_')[0]);
      if (!Number.isInteger(version)) {
        throw new Error(`迁移文件名必须以数字版本开头: ${name}`);
      }
      return { version, name, sql: readFileSync(join(dir, name), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);
}

export function applyMigrations(db, migrationsDir) {
  db.exec(MIGRATION_TABLE);
  const done = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );

  const applied = [];
  for (const m of readMigrationFiles(migrationsDir)) {
    if (done.has(m.version)) continue;
    // 单事务内串行执行：要么全成功，要么全不成功
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(m.name);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.name} 失败: ${err.message}`);
    }
  }

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return { applied, version: row?.v ?? 0 };
}
```

- [ ] **Step 5: 创建 db/migrations/001_init.sql**

```sql
-- 001_init.sql — 初始表结构
-- 依据：设计文档 §5.2 + §7.1
-- ⛔ 不含评审/榜单相关表：那些在 P2/P3 阶段单独迁移，便于 expand-contract。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  mba_status    TEXT NOT NULL DEFAULT 'other',  -- mba | member | other
  org           TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,      -- 软删除：禁止硬删（§11 事后篡改）
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,        -- 只存 SHA-256，不存明文 token
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 能力点与角色映射
CREATE TABLE capabilities (
  key         TEXT PRIMARY KEY,       -- 如 score:write / team:manage
  description TEXT NOT NULL
);

CREATE TABLE roles (
  key         TEXT PRIMARY KEY,       -- admin / captain / member / judge / enterprise / observer
  description TEXT NOT NULL
);

CREATE TABLE role_capabilities (
  role_id      TEXT NOT NULL REFERENCES roles(key),
  capability   TEXT NOT NULL REFERENCES capabilities(key),
  PRIMARY KEY (role_id, capability)
);

-- 资源级授权（行级权限的载体）
CREATE TABLE assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  capability  TEXT NOT NULL REFERENCES capabilities(key),
  scope_type  TEXT NOT NULL,         -- global | edition | city | task_package | team | enterprise
  scope_id    TEXT,
  granted_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_assignments_lookup ON assignments(user_id, capability);

-- 用户与角色的多对多
-- 一人可以同时是选手 + 队长 + 评委（借 hackerspace3 assignment 模型的做法）
-- ⚠️ 本表并入 001_init.sql，不单独开 002 迁移：
--    迁移版本号是全局唯一序位，002 必须留给 P1 的 002_registration.sql。
--    两个迁移抢同一个版本号时，后执行的那张表永远建不出来（applyMigrations 按 version 去重）。
CREATE TABLE user_roles (
  user_id  TEXT NOT NULL REFERENCES users(id),
  role_key TEXT NOT NULL REFERENCES roles(key),
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_key);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
```

- [ ] **Step 6: 创建 scripts/migrate.js**

```javascript
// scripts/migrate.js — 命令行迁移入口
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

const { db, close } = openDatabase({ dataDir });
try {
  const result = applyMigrations(db, join(here, '..', 'db', 'migrations'));
  console.log(`迁移完成，当前版本 ${result.version}`);
  if (result.applied.length) {
    console.log(`本次应用：\n  ${result.applied.join('\n  ')}`);
  } else {
    console.log('本次无新迁移');
  }
} finally {
  close();
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/migrate.test.js`
Expected: PASS（3 个测试全过）

- [ ] **Step 8: 实跑迁移脚本**

Run: `cd platform && node scripts/migrate.js`
Expected: 输出 `迁移完成，当前版本 1`

- [ ] **Step 9: 提交**

```bash
cd platform && git add src/db db/migrations scripts/migrate.js test/migrate.test.js
git commit -m "feat(P0): SQLite 封装、迁移机制与初始表结构"
```

---

### Task 3: 规则配置与 fail-fast 校验

**Files:**
- Create: `platform/src/config.js`
- Create: `platform/rules/scoring-initial.json`
- Create: `platform/rules/scoring-final.json`
- Create: `platform/rules/tiebreak.json`
- Create: `platform/rules/ranks.json`
- Create: `platform/rules/behavior-points.json`
- Create: `platform/rules/visibility.json`
- Create: `platform/rules/registration-scoring.json`
- Create: `platform/rules/solvability.json`
- Create: `platform/rules/milestones.default.json`
- Create: `platform/test/config.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `loadRules(rulesDir)` → `{ rules: object, version: string }`，校验不过**抛错**
  - `validateRules(rules)` → 抛错信息数组（空数组 = 通过）
  - `rules.scoring.initial` / `rules.scoring.final` / `rules.tiebreak` / `rules.ranks` / `rules.behavior` / `rules.visibility` / `rules.registration` / `rules.solvability` / `rules.milestones`

- [ ] **Step 1: 写失败的测试**

`platform/test/config.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, validateRules } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

test('仓库自带的 9 份规则配置能通过校验', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(validateRules(rules), []);
});

test('权重合计不等于 100% 会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.dimensions[0].weight = 0.30; // 合计变 105%
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('scoring.final') && e.includes('权重合计')));
});

test('初赛企业确认权重必须是 10%（裁决 C-01）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.scoring.initial.wEnterprise, 0.10);
  const broken = structuredClone(rules);
  broken.scoring.initial.wEnterprise = 0.20;
  assert.ok(validateRules(broken).some((e) => e.includes('wEnterprise')));
});

test('wEnterprise 必须等于企业确认维度的权重', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.wEnterprise = 0.30;
  assert.ok(validateRules(broken).some((e) => e.includes('wEnterprise')));
});

test('段位门槛必须严格递增', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.ranks.tiers[2].minMilestones = 0;
  assert.ok(validateRules(broken).some((e) => e.includes('ranks')));
});

test('报名等级阈值必须单调且覆盖 0-100', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.registration.levels[1].minScore = 90; // A 级阈值高于 S 级
  assert.ok(validateRules(broken).some((e) => e.includes('registration')));
});

test('破同分链必须以确定性兜底项结尾', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.tiebreak.chain.pop();
  assert.ok(validateRules(broken).some((e) => e.includes('tiebreak')));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/config.test.js`
Expected: FAIL —— `Cannot find module '../src/config.js'`

- [ ] **Step 3: 创建 9 份规则配置**

`platform/rules/scoring-initial.json`：

```json
{
  "id": "scoring-initial",
  "version": "2026-10-20",
  "conflictRef": "C-01",
  "source": "S7 §2.1 初赛权重表 + §3.1 评分公式",
  "note": "初赛 wEnterprise=0.10 —— 依据权重表合计正好 100% 反推，见 rule-decisions.md C-01",
  "wEnterprise": 0.10,
  "normalizationStrategy": "zscore",
  "minSamplesForJudgeNormalization": 5,
  "trimOutliers": true,
  "minJudgesForTrim": 5,
  "dimensions": [
    { "key": "track_fit",     "name": "赛题契合度", "weight": 0.10, "seat": "judge" },
    { "key": "innovation",    "name": "创新性",     "weight": 0.20, "seat": "judge" },
    { "key": "feasibility",   "name": "技术可行性", "weight": 0.20, "seat": "judge" },
    { "key": "completeness",  "name": "完成度",     "weight": 0.25, "seat": "judge" },
    { "key": "enterprise",    "name": "企业确认",   "weight": 0.10, "seat": "enterprise" },
    { "key": "collaboration", "name": "团队协作",   "weight": 0.15, "seat": "judge" }
  ]
}
```

`platform/rules/scoring-final.json`：

```json
{
  "id": "scoring-final",
  "version": "2026-10-20",
  "source": "S7 §2.2 决赛权重表 + §3.1 评分公式",
  "wEnterprise": 0.25,
  "normalizationStrategy": "zscore",
  "minSamplesForJudgeNormalization": 5,
  "trimOutliers": true,
  "minJudgesForTrim": 5,
  "dimensions": [
    { "key": "enterprise",    "name": "企业确认",   "weight": 0.25, "seat": "enterprise" },
    { "key": "innovation",    "name": "创新性",     "weight": 0.20, "seat": "judge" },
    { "key": "feasibility",   "name": "技术可行性", "weight": 0.20, "seat": "judge" },
    { "key": "completeness",  "name": "完成度",     "weight": 0.20, "seat": "judge" },
    { "key": "collaboration", "name": "团队协作",   "weight": 0.10, "seat": "judge" },
    { "key": "self_eval",     "name": "自评测",     "weight": 0.05, "seat": "self" }
  ]
}
```

`platform/rules/tiebreak.json`：

```json
{
  "id": "tiebreak",
  "version": "2026-10-20",
  "conflictRef": "C-03",
  "source": "S7 §3.3 + S10 §0.4 + S10 §3.3（原文互相冲突，此处为裁决后的有序链）",
  "chain": [
    { "key": "total",          "label": "总分",             "direction": "desc", "scope": "always" },
    { "key": "tiebreak_extra", "label": "加时陈述复议分",   "direction": "desc", "scope": "final_only", "manual": true },
    { "key": "peer",           "label": "互评分",           "direction": "desc", "scope": "tied_only" },
    { "key": "enterprise_raw", "label": "企业确认原始分",   "direction": "desc", "scope": "tied_only" },
    { "key": "behavior",       "label": "行为分",           "direction": "desc", "scope": "tied_only" },
    { "key": "team_id",        "label": "队伍编号",         "direction": "asc",  "scope": "always", "deterministic": true }
  ]
}
```

`platform/rules/ranks.json`：

```json
{
  "id": "ranks",
  "version": "2026-10-20",
  "source": "S10 §2.2 段位表 + §2.3 降级与权益",
  "tiers": [
    { "key": "D", "name": "出题", "minMilestones": 0, "requiresBusinessSignoff": false },
    { "key": "C", "name": "立项", "minMilestones": 1, "requiresBusinessSignoff": false },
    { "key": "B", "name": "原型", "minMilestones": 2, "requiresBusinessSignoff": false },
    { "key": "A", "name": "接入", "minMilestones": 3, "requiresBusinessSignoff": false, "requiresDataOrPrototype": true },
    { "key": "S", "name": "验证", "minMilestones": 5, "requiresBusinessSignoff": true }
  ],
  "demotion": {
    "onSignoffRevoked": true,
    "inactiveDays": 14,
    "inactiveDropLevels": 1,
    "publishDemotion": true
  },
  "benefits": {
    "C": ["企业对接会", "导师匹配资格"],
    "B": ["Demo Day 路演资格"],
    "A": ["辅导期名额候选"],
    "S": ["辅导期名额优先", "完赛证明"]
  },
  "neverUnlocks": ["奖金", "决赛名次"]
}
```

`platform/rules/behavior-points.json`：

```json
{
  "id": "behavior",
  "version": "2026-10-20",
  "source": "S10 §3.1 计分明细 + §3.2 达标线 + §3.3 占比上限",
  "completionThreshold": 60,
  "maxWeightShare": 0.10,
  "events": [
    { "key": "weekly_progress",   "label": "每周提交一次进度",   "points": 2,  "requiresRunnableOrBlocker": true },
    { "key": "workshop_output",   "label": "参加 workshop 并提交课后产出", "points": 3, "requiresOutput": true },
    { "key": "milestone_on_time", "label": "按时交付里程碑",     "points": 5 },
    { "key": "enterprise_meeting","label": "完成一次企业对接会", "points": 5,  "requiresEnterpriseConfirm": true },
    { "key": "first_demo",        "label": "首次提交 Demo",      "points": 10, "once": true }
  ],
  "sortUse": "tiebreak_only"
}
```

`platform/rules/visibility.json`：

```json
{
  "id": "visibility",
  "version": "2026-10-20",
  "conflictRef": "C-02",
  "source": "S10 §0.3 分层公开 + §8 风险表",
  "rank": {
    "public": true,
    "publicFromTier": "C",
    "privateBelowTier": "D",
    "showEnterpriseName": false
  },
  "business": {
    "milestoneProgressPublic": true,
    "scoresPublic": false,
    "signatoryPublic": false
  },
  "peerReview": {
    "showSource": false
  }
}
```

`platform/rules/registration-scoring.json`：

```json
{
  "id": "registration",
  "version": "2026-10-20",
  "source": "SABC v1 §二 3 维画像筛选",
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
  "openQuestion": { "required": true, "maxLength": 500 }
}
```

`platform/rules/solvability.json`：

```json
{
  "id": "solvability",
  "version": "2026-10-20",
  "source": "顶层文档 §3.2 六维可解性准入",
  "dimensions": [
    { "key": "problem_clarity", "label": "问题确定性", "weight": 0.30, "max": 3 },
    { "key": "data_access",     "label": "数据可得性", "weight": 0.25, "max": 3 },
    { "key": "validation",      "label": "验证周期",   "weight": 0.20, "max": 2 },
    { "key": "decision_chain",  "label": "决策链长度", "weight": 0.10, "max": 1 },
    { "key": "accountability",  "label": "责任可归属", "weight": 0.10, "max": 1 },
    { "key": "precedent",       "label": "先例存在性", "weight": 0.05, "max": 1 }
  ],
  "grades": [
    { "key": "A", "minScore": 10, "maxScore": 12, "commitment": "试点承诺",   "agreement": "试点承诺书 + 数据授权说明" },
    { "key": "B", "minScore": 7,  "maxScore": 9,  "commitment": "对标试点",   "agreement": "对标试点协议" },
    { "key": "C", "minScore": 4,  "maxScore": 6,  "commitment": "不承诺试点", "agreement": "场景提供协议" },
    { "key": "D", "minScore": 0,  "maxScore": 3,  "commitment": "无",         "agreement": "退回，但必出问题可解性诊断报告" }
  ],
  "vetoes": [
    { "key": "no_data_authorization", "label": "无法提供《数据授权说明》" },
    { "key": "no_responsible_owner",  "label": "无企业侧唯一责任人" },
    { "key": "production_undisclosed","label": "涉及生产系统且未谈责任归属" }
  ],
  "taskMix": { "enterprise": 0.70, "free": 0.30 }
}
```

`platform/rules/milestones.default.json`：

```json
{
  "id": "milestones-default",
  "version": "2026-10-20",
  "source": "S10 §4 商业里程碑 7 类 + §3.4 里程碑清单报名时固定",
  "note": "报名时随战队固定，赛程中不可自行新增（S10 §3.4 防拆单刷里程碑）",
  "items": [
    { "key": "problem_confirmed", "label": "企业问题确认", "confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "data_connected",    "label": "真实数据接入", "confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "demo_ready",        "label": "可演示原型",   "confirmedBy": "judge",      "countsTowardTier": true },
    { "key": "pilot_contract",    "label": "试点合同",     "confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "iterations",        "label": "业务迭代 N 轮","confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "intents",           "label": "意向客户 M 家","confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "revenue",           "label": "确认收入 ¥X",  "confirmedBy": "enterprise", "countsTowardTier": true }
  ],
  "signoffRequires": { "content": true, "department": true, "signatory": true }
}
```

- [ ] **Step 4: 创建 src/config.js**

```javascript
// src/config.js — 规则配置加载与 fail-fast 校验
// 依据：设计文档 §6.7 + §2 第二条结论。
//   60 条机制件级需求全部来自尚未被组委会确认的设计 → 全部走配置。
//   校验不过就拒绝启动，绝不降级为默认值 —— 否则会安静地算出一个错位的榜单。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FILES = {
  scoringInitial: 'scoring-initial.json',
  scoringFinal: 'scoring-final.json',
  tiebreak: 'tiebreak.json',
  ranks: 'ranks.json',
  behavior: 'behavior-points.json',
  visibility: 'visibility.json',
  registration: 'registration-scoring.json',
  solvability: 'solvability.json',
  milestones: 'milestones.default.json',
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`规则配置读取失败 ${path}: ${err.message}`);
  }
}

export function validateRules(rules) {
  const errors = [];

  // ── 评分配置 ──────────────────────────────────────────────
  for (const key of ['initial', 'final']) {
    const cfg = rules.scoring?.[key];
    if (!cfg) {
      errors.push(`scoring.${key} 缺失`);
      continue;
    }
    const sum = cfg.dimensions.reduce((a, d) => a + d.weight, 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errors.push(`scoring.${key} 权重合计 = ${sum.toFixed(4)}，必须等于 1（100%）`);
    }
    const ent = cfg.dimensions.find((d) => d.seat === 'enterprise');
    if (!ent) {
      errors.push(`scoring.${key} 缺少 seat=enterprise 的维度`);
    } else if (Math.abs(ent.weight - cfg.wEnterprise) > 1e-9) {
      errors.push(
        `scoring.${key} wEnterprise=${cfg.wEnterprise} 与企业确认维度权重 ${ent.weight} 不一致`,
      );
    }
    if (cfg.wEnterprise < 0 || cfg.wEnterprise > 1) {
      errors.push(`scoring.${key} wEnterprise 必须在 0..1`);
    }
    if (!['zscore', 'median', 'trimmed', 'bayes'].includes(cfg.normalizationStrategy)) {
      errors.push(`scoring.${key} normalizationStrategy 非法`);
    }
  }

  // ── 破同分链 ──────────────────────────────────────────────
  const chain = rules.tiebreak?.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    errors.push('tiebreak.chain 缺失或为空');
  } else {
    const last = chain[chain.length - 1];
    if (!last.deterministic) {
      errors.push('tiebreak.chain 必须以确定性兜底项结尾（deterministic: true），否则榜单不可复算');
    }
    if (!chain.some((c) => c.key === 'total')) {
      errors.push('tiebreak.chain 缺少总分项');
    }
  }

  // ── 段位 ─────────────────────────────────────────────────
  const tiers = rules.ranks?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push('ranks.tiers 缺失或为空');
  } else {
    for (let i = 1; i < tiers.length; i += 1) {
      if (tiers[i].minMilestones <= tiers[i - 1].minMilestones) {
        errors.push(`ranks.tiers 门槛必须严格递增（第 ${i + 1} 档）`);
      }
    }
  }

  // ── 报名等级 ─────────────────────────────────────────────
  const levels = rules.registration?.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    errors.push('registration.levels 缺失或为空');
  } else {
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i].minScore > levels[i - 1].minScore) {
        errors.push(`registration.levels 阈值必须单调不增（第 ${i + 1} 级）`);
      }
    }
    const sum = rules.registration.dimensions.reduce((a, d) => a + d.weight, 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errors.push(`registration.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }

  // ── 可解性 ───────────────────────────────────────────────
  const sol = rules.solvability;
  if (!sol?.dimensions?.length) {
    errors.push('solvability.dimensions 缺失');
  } else {
    const sum = sol.dimensions.reduce((a, d) => a + d.weight, 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errors.push(`solvability.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }
  if (!Array.isArray(sol?.grades) || !sol.grades.length) {
    errors.push('solvability.grades 缺失');
  }

  return errors;
}

export function loadRules(rulesDir) {
  const rules = {};
  for (const [key, file] of Object.entries(FILES)) {
    rules[key] = readJson(join(rulesDir, file));
  }

  // 重组成嵌套结构，供调用方按语义取用
  const grouped = {
    scoring: { initial: rules.scoringInitial, final: rules.scoringFinal },
    tiebreak: rules.tiebreak,
    ranks: rules.ranks,
    behavior: rules.behavior,
    visibility: rules.visibility,
    registration: rules.registration,
    solvability: rules.solvability,
    milestones: rules.milestones,
  };

  const errors = validateRules(grouped);
  if (errors.length) {
    const list = errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`规则配置校验失败，拒绝启动：\n${list}`);
  }

  const versions = Object.values(grouped)
    .map((r) => r.version)
    .filter(Boolean);
  const version = versions.length ? versions[0] : 'unknown';

  return { rules: grouped, version };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/config.test.js`
Expected: PASS（6 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/config.js rules test/config.test.js
git commit -m "feat(P0): 9 份声明式规则配置与 fail-fast 校验"
```

---

### Task 4: HTTP 路由、响应与 body 解析

**Files:**
- Create: `platform/src/http/router.js`
- Create: `platform/src/http/respond.js`
- Create: `platform/src/http/body.js`
- Create: `platform/test/router.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createRouter()` → `{ add(method, pattern, handler), match(method, path) }`
  - `pattern` 形如 `/api/teams/:teamId/members`，`:name` 捕获一个路径段
  - `match()` 返回 `{ handler, params }` 或 `null`
  - `json(res, status, body)`、`text(res, status, body)`、`error(res, status, code, message)`
  - `readJsonBody(req, { limit })` → 解析后的对象；超限抛错

- [ ] **Step 1: 写失败的测试**

`platform/test/router.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/http/router.js';

test('精确路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/me', () => 'me');
  assert.equal(r.match('GET', '/api/me').handler(), 'me');
});

test(':param 捕获路径段', () => {
  const r = createRouter();
  r.add('GET', '/api/teams/:teamId/members', (ctx) => ctx.params.teamId);
  const m = r.match('GET', '/api/teams/t_42/members');
  assert.equal(m.params.teamId, 't_42');
});

test('方法不匹配返回 null', () => {
  const r = createRouter();
  r.add('POST', '/api/teams', () => 1);
  assert.equal(r.match('GET', '/api/teams'), null);
});

test('路径不匹配返回 null', () => {
  const r = createRouter();
  r.add('GET', '/api/teams', () => 1);
  assert.equal(r.match('GET', '/api/team'), null);
});

test('注册顺序不影响匹配（静态段优先于参数段）', () => {
  const r = createRouter();
  r.add('GET', '/api/teams/me', () => 'static');
  r.add('GET', '/api/teams/:id', () => 'param');
  assert.equal(r.match('GET', '/api/teams/me').handler(), 'static');
  assert.equal(r.match('GET', '/api/teams/other').handler(), 'param');
});

test('URL 里的 query 不影响路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/leaderboard', () => 'lb');
  assert.ok(r.match('GET', '/api/leaderboard?scope=rank'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/router.test.js`
Expected: FAIL —— `Cannot find module '../src/http/router.js'`

- [ ] **Step 3: 创建 src/http/router.js**

```javascript
// src/http/router.js — 极简路由
// ⛔ Node 22 没有 URLPattern（Node 24 才有），所以手写。
//   不抬高运行时门槛 = 22 与 24 都能跑 = 可移植。
export function createRouter() {
  const routes = [];

  function compile(pattern) {
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${source}/?$`), names };
  }

  return {
    add(method, pattern, handler) {
      const { regex, names } = compile(pattern);
      routes.push({ method: method.toUpperCase(), pattern, regex, names, handler });
      return this;
    },
    match(method, path) {
      const clean = path.split('?')[0];
      const m = method.toUpperCase();
      // 先匹配静态段更多的路由 → 静态优先于参数
      const ordered = [...routes].sort(
        (a, b) => b.names.length - a.names.length || a.pattern.length - b.pattern.length,
      );
      for (const route of ordered) {
        if (route.method !== m) continue;
        const hit = route.regex.exec(clean);
        if (!hit) continue;
        const params = {};
        route.names.forEach((name, i) => {
          params[name] = decodeURIComponent(hit[i + 1]);
        });
        return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
    list() {
      return routes.map((r) => ({ method: r.method, pattern: r.pattern }));
    },
  };
}
```

- [ ] **Step 4: 创建 src/http/respond.js**

```javascript
// src/http/respond.js — 统一响应
// 三态状态码约定（设计文档 §7.3）：
//   列表查询权限不满足 → 200 + 空集（不暴露"有但不给看"）
//   单条读取权限不满足 → 404（不泄露记录是否存在）
//   规则本身被禁用     → 403
export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function error(res, status, code, message, detail) {
  json(res, status, { error: { code, message, ...(detail ? { detail } : {}) } });
}
```

- [ ] **Step 5: 创建 src/http/body.js**

```javascript
// src/http/body.js — 请求体解析
// 体积上限防止一个超大 body 打满内存（可移植性约束下的最基本防护）
export async function readJsonBody(req, { limit = 1024 * 512 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是 JSON 对象');
      err.status = 400;
      err.code = 'INVALID_BODY';
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    const e = new Error('请求体不是合法 JSON');
    e.status = 400;
    e.code = 'INVALID_JSON';
    throw e;
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/router.test.js`
Expected: PASS（6 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/http test/router.test.js
git commit -m "feat(P0): HTTP 路由、响应与 body 解析"
```

---

### Task 5: 认证（scrypt + 服务端会话）

**Files:**
- Create: `platform/src/auth/password.js`
- Create: `platform/src/auth/session.js`
- Create: `platform/src/db/repo/users.js`
- Create: `platform/src/db/repo/sessions.js`
- Create: `platform/test/password.test.js`

**Interfaces:**
- Consumes: `openDatabase()`（Task 2）
- Produces:
  - `hashPassword(plain)` → `scrypt$N$r$p$<saltB64>$<hashB64>`
  - `verifyPassword(plain, stored)` → `boolean`（用 `timingSafeEqual`）
  - `createSession(db, userId, { ttlDays })` → `{ token, expiresAt }`（明文 token 只返回一次，库中只存 SHA-256）
  - `resolveSession(db, token)` → `{ userId, expiresAt }` 或 `null`
  - `revokeSession(db, token)` / `revokeAllSessions(db, userId)`
  - `createUser(db, { name, phone, password, mbaStatus, org })` → user

- [ ] **Step 1: 写失败的测试**

`platform/test/password.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('相同密码两次哈希结果不同（盐随机）', () => {
  const a = hashPassword('pw123');
  const b = hashPassword('pw123');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
});

test('正确密码校验通过', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
});

test('错误密码校验失败', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('wrong horse', stored), false);
});

test('存储格式包含成本参数', () => {
  const parts = hashPassword('x').split('$');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], 'scrypt');
  assert.ok(Number.isInteger(Number(parts[1])));
});

test('损坏的存储串不抛异常，返回 false', () => {
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', ''), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/password.test.js`
Expected: FAIL —— `Cannot find module '../src/auth/password.js'`

- [ ] **Step 3: 创建 src/auth/password.js**

```javascript
// src/auth/password.js — 密码哈希
// 依据：设计文档 §7.5。用 node:crypto 内置 scrypt，零 npm 依赖。
// 存储格式：scrypt$N$r$p$<saltB64>$<hashB64>
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = scryptSync(String(plain), salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
  } catch {
    return false;
  }
  // 常时比较，避免时序侧信道
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: 创建 src/auth/session.js**

```javascript
// src/auth/session.js — 服务端会话
// 依据：设计文档 §7.5。⛔ 不做无状态 JWT —— 难撤销、难审计、难强制下线。
//   token 只在签发时返回一次，数据库只存 SHA-256 哈希。
import { randomBytes, createHash } from 'node:crypto';

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId, { ttlDays = 7, now = new Date() } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlDays * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(tokenHash(token), userId, now.toISOString(), expiresAt);
  return { token, expiresAt };
}

export function resolveSession(db, token, { now = new Date() } = {}) {
  if (!token) return null;
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return { userId: row.user_id, expiresAt: row.expires_at };
}

export function revokeSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function revokeAllSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
```

- [ ] **Step 5: 创建 src/db/repo/users.js 与 src/db/repo/sessions.js**

`platform/src/db/repo/users.js`：

```javascript
// src/db/repo/users.js — 用户仓储
// 依据：设计文档 §7.2。所有 SQL 收进仓储层，handler 内禁止裸 SQL。
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../auth/password.js';

export function createUser(db, { name, phone, password, mbaStatus = 'other', org = null }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
  ).run(id, name, phone, hashPassword(password), mbaStatus, org, now);
  return getUserById(db, id);
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id) ?? null;
}

export function getUserByPhone(db, phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone) ?? null;
}

export function listUsers(db, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare('SELECT * FROM users WHERE active = 1 ORDER BY created_at LIMIT ? OFFSET ?')
    .all(limit, offset);
}

// ⛔ 软删除：禁止硬删（设计文档 §11「事后篡改」防护）
export function deactivateUser(db, id) {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
}
```

`platform/src/db/repo/sessions.js`：

```javascript
// src/db/repo/sessions.js — 会话仓储
export function countActiveSessions(db, userId, { now = new Date() } = {}) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?')
    .get(userId, now.toISOString()).n;
}

export function purgeExpiredSessions(db, { now = new Date() } = {}) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString()).changes;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/password.test.js`
Expected: PASS（5 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/auth src/db/repo test/password.test.js
git commit -m "feat(P0): scrypt 密码哈希与服务端会话"
```

---

### Task 6: capability + assignment 权限模型

**Files:**
- Create: `platform/src/auth/permissions.js`
- Create: `platform/src/db/repo/assignments.js`
- Create: `platform/test/permissions.test.js`

**Interfaces:**
- Consumes: `openDatabase()`（Task 2）、迁移里的 `capabilities` / `roles` / `role_capabilities` / `assignments` 表（Task 2）
- Produces:
  - `can(user, capability, ctx, db)` → `boolean`（**唯一判定入口**）
  - `ctx` 形如 `{ scopeType, scopeId }`
  - `grantAssignment(db, { userId, capability, scopeType, scopeId, grantedBy })`
  - `revokeAssignment(db, assignmentId)`
  - `listAssignments(db, userId, capability)`
  - `scopeClause(userId, capability, ctx)` → `{ sql, params }`——生成 WHERE 片段（**必须在 SQL 层过滤，不能先查全量再在 JS 里 filter**）

- [ ] **Step 1: 写失败的测试**

`platform/test/permissions.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { can, grantAssignment, scopeClause } from '../src/auth/permissions.js';
import { createUser } from '../src/db/repo/users.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations',
);

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-perm-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO capabilities (key, description) VALUES
      ('score:write', '评分写入'),
      ('team:read', '战队读取');
    INSERT INTO roles (key, description) VALUES ('judge', '评委');
  `);
  const user = createUser(db, { name: '评委甲', phone: '13900000001', password: 'pw' });
  return { db, close, dataDir, user };
}

test('超级管理员拥有一切能力', () => {
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('没有授权时能力为 false', () => {
  const { db, close, dataDir, user } = setup();
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('角色能力命中即为 true', () => {
  const { db, close, dataDir, user } = setup();
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  // 注：user_roles 表在后续迁移补齐；本用例先跳过断言用户角色
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('assignment 精确匹配 scope 时为 true', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id,
    capability: 'score:write',
    scopeType: 'task_package',
    scopeId: 'tp_7',
    grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_7' }, db), true);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_8' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('global scope 匹配任何资源', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_x' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 生成带参数的 SQL 片段，不做字符串插值', () => {
  const { db, close, dataDir, user } = setup();
  const { sql, params } = scopeClause(user.id, 'score:write');
  assert.ok(sql.includes('EXISTS'));
  assert.ok(sql.includes('?'));
  assert.ok(params.includes(user.id));
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/permissions.test.js`
Expected: FAIL —— `Cannot find module '../src/auth/permissions.js'`

- [ ] **Step 3: 创建 src/auth/permissions.js**

```javascript
// src/auth/permissions.js — 权限判定
// 依据：设计文档 §7.1 / §7.2。
//   权限不靠角色枚举，靠「能力 + 授权记录」。
//   can() 是唯一判定入口；scopeClause() 把行级过滤下推到 SQL。
import { randomUUID } from 'node:crypto';

export function grantAssignment(
  db,
  { userId, capability, scopeType, scopeId = null, grantedBy = null },
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO assignments (id, user_id, capability, scope_type, scope_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, capability, scopeType, scopeId, grantedBy, new Date().toISOString());
  return id;
}

export function revokeAssignment(db, assignmentId) {
  return db.prepare('DELETE FROM assignments WHERE id = ?').run(assignmentId).changes;
}

export function listAssignments(db, userId, capability) {
  return db
    .prepare('SELECT * FROM assignments WHERE user_id = ? AND capability = ?')
    .all(userId, capability);
}

function roleGrants(db, userId, capability) {
  return db
    .prepare(
      `SELECT 1 FROM user_roles ur
       JOIN role_capabilities rc ON rc.role_key = ur.role_key
       WHERE ur.user_id = ? AND rc.capability = ?
       LIMIT 1`,
    )
    .get(userId, capability) !== undefined;
}

export function can(user, capability, ctx = null, db = null) {
  if (!user) return false;
  if (user.active === 0) return false;
  if (user.is_superadmin === 1) return true;

  // 角色能力
  if (db && roleGrants(db, user.id, capability)) return true;

  // 资源级授权
  if (!db) return false;
  const rows = listAssignments(db, user.id, capability);
  for (const row of rows) {
    if (row.scope_type === 'global') return true;
    if (!ctx) continue;
    if (row.scope_type === ctx.scopeType && row.scope_id === ctx.scopeId) return true;
  }
  return false;
}

/**
 * 生成行级过滤的 SQL 片段。
 * ⛔ 关键：权限过滤必须在 SQL 的 WHERE 里，不能"先查全量再在 JS 里 filter"，
 *    否则单条读取接口会绕过列表过滤导致越权（设计文档 §7.2 约束 2）。
 */
export function scopeClause(userId, capability, { scopeType, scopeId, alias = null } = {}) {
  const prefix = alias ? `${alias}.` : '';
  const params = [userId, capability];
  const scopeCond = [];

  if (scopeType) {
    scopeCond.push(`(a.scope_type = ? AND a.scope_id = ${prefix}id)`);
    params.push(scopeType, scopeId);
  }
  const scopeSql = scopeCond.length ? ` OR ${scopeCond.join(' OR ')}` : '';

  return {
    sql: `EXISTS (SELECT 1 FROM assignments a
            WHERE a.user_id = ? AND a.capability = ?
              AND (a.scope_type = 'global'${scopeSql}))`,
    params,
  };
}
```

- [ ] **Step 4: 确认 user_roles 表已在 001_init.sql 中**

`user_roles` 表**已在 Task 2 的 `001_init.sql` 里建好**（迁移版本号是全局唯一序位，002 留给 P1 的 `002_registration.sql`）。
本步只需确认它存在：

```bash
cd platform && node scripts/migrate.js && node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('./data/app.db');
const r=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='user_roles'\").get();
console.log(r ? 'user_roles 存在' : '缺失');
db.close();
"
```
Expected: `user_roles 存在`

- [ ] **Step 5: 修正测试中的角色用例**

把 `test/permissions.test.js` 里的「角色能力命中即为 true」改成：

```javascript
test('角色能力命中即为 true', () => {
  const { db, close, dataDir, user } = setup();
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/permissions.test.js`
Expected: PASS（6 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/auth/permissions.js src/db/repo test/permissions.test.js
git commit -m "feat(P0): capability + assignment 权限模型与 SQL 层行级过滤"
```

---

### Task 7: 静态文件服务、前端骨架与服务器入口

**Files:**
- Create: `platform/src/http/static.js`
- Create: `platform/src/server.js`
- Create: `platform/scripts/seed.js`
- Create: `platform/web/index.html`
- Create: `platform/web/app.js`
- Create: `platform/web/router.js`
- Create: `platform/web/store.js`
- Create: `platform/web/api.js`
- Create: `platform/web/api.demo.js`
- Create: `platform/web/styles.css`
- Create: `platform/web/views/login.js`
- Modify: `platform/package.json`（`start` 脚本已在 Task 1 建好，本步不改）
- Test: `platform/test/server.test.js`

**Interfaces:**
- Consumes: Task 2 `openDatabase`、Task 3 `loadRules`、Task 4 `createRouter/json/error`、Task 5 `createSession/resolveSession`、Task 6 `can`
- Produces:
  - `serveStatic(webDir, req, res)` → `boolean`（命中返回 true）
  - `createApp({ db, rules, webDir })` → `{ router, handle(req, res) }`——可测的请求处理入口
  - `src/server.js` 进程入口：加载配置 → 校验 → 建库 → 迁移 → 装配 → 监听
  - 前端：`api.js` 导出 `{ get, post, patch, del, subscribe }`；`api.demo.js` 导出同名接口的 localStorage 实现

- [ ] **Step 1: 写失败的测试**

`platform/test/server.test.js`：

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

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-srv-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app };
}

function call(app, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers,
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

test('GET /api/health 返回 ok', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未登录访问 /api/me 返回 401', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/me');
  assert.equal(res.status, 401);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未知路径返回 404', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/nope');
  assert.equal(res.status, 404);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('配置非法时 createApp 抛错（fail-fast）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-bad-'));
  const { db, close } = openDatabase({ dataDir });
  assert.throws(
    () => createApp({ db, rules: { scoring: { initial: { dimensions: [{ weight: 0.5 }] } } }, webDir }),
    /规则|校验/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/server.test.js`
Expected: FAIL —— `Cannot find module '../src/server.js'`

- [ ] **Step 3: 创建 src/http/static.js**

```javascript
// src/http/static.js — 静态文件服务
// 依据：设计文档 §14.2。生产环境静态资源由 nginx 直出，这里是内网/本地兜底。
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { createHash } from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serveStatic(webDir, req, res) {
  const url = (req.url || '/').split('?')[0];
  const rel = url === '/' ? '/index.html' : url;
  // 防目录穿越：normalize 后必须仍在 webDir 内
  const target = normalize(join(webDir, rel));
  if (!target.startsWith(normalize(webDir))) return false;

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = extname(target).toLowerCase();
  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  createReadStream(target).pipe(res);
  return true;
}
```

- [ ] **Step 4: 创建 src/server.js**

```javascript
// src/server.js — 进程入口 + 可测的应用装配
// 依据：设计文档 §4.1 / §14.1
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './db/sqlite.js';
import { applyMigrations } from './db/migrate.js';
import { loadRules } from './config.js';
import { createRouter } from './http/router.js';
import { json, error } from './http/respond.js';
import { readJsonBody } from './http/body.js';
import { serveStatic } from './http/static.js';
import { resolveSession } from './auth/session.js';
import { can } from './auth/permissions.js';
import { getUserById } from './db/repo/users.js';
import { validateRules } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, rules, webDir }) {
  // fail-fast：规则不合法直接拒绝启动
  const errors = validateRules(rules);
  if (errors.length) {
    throw new Error(`规则配置校验失败，拒绝启动：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const router = createRouter();

  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));

  router.add('GET', '/api/me', async ({ user }) => {
    if (!user) {
      const e = new Error('未登录');
      e.status = 401;
      e.code = 'UNAUTHENTICATED';
      throw e;
    }
    return { user: { id: user.id, name: user.name, mbaStatus: user.mba_status, org: user.org } };
  });

  async function handle(req, res) {
    const url = req.url || '/';
    if (url.startsWith('/api/')) {
      const match = router.match(req.method, url);
      if (!match) {
        error(res, 404, 'NOT_FOUND', `无此接口: ${req.method} ${url}`);
        return;
      }
      try {
        const sessionToken = parseCookie(req.headers?.cookie || '')['hk_session'];
        const session = sessionToken ? resolveSession(db, sessionToken) : null;
        const user = session ? getUserById(db, session.user_id) : null;
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
          ? await readJsonBody(req)
          : null;
        const ctx = {
          user,
          db,
          rules,
          params: match.params,
          body,
          query: Object.fromEntries(new URL(url, 'http://x').searchParams),
          can: (capability, c) => can(user, capability, c, db),
        };
        const result = await match.handler(ctx);
        json(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err.status || 500;
        const code = err.code || 'INTERNAL';
        if (status >= 500) console.error('[server]', err);
        error(res, status, code, err.message);
      }
      return;
    }
    if (req.method === 'GET' && serveStatic(webDir, req, res)) return;
    error(res, 404, 'NOT_FOUND', '页面不存在');
  }

  return { router, handle };
}

function parseCookie(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// ── 进程启动 ────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const port = Number(process.env.PORT || 8080);
  const webDir = join(here, '..', 'web');
  const migrationsDir = join(here, '..', 'db', 'migrations');
  const rulesDir = join(here, '..', 'rules');

  const { rules, version } = loadRules(rulesDir);
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const app = createApp({ db, rules, webDir });

  const server = http.createServer(app.handle);
  server.listen(port, () => {
    console.log(`heikesong-platform 启动于 http://127.0.0.1:${port}（规则版本 ${version}）`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => {
        close();
        process.exit(0);
      });
    });
  }
}
```

- [ ] **Step 5: 创建 scripts/seed.js**

```javascript
// scripts/seed.js — 种子数据：能力点、角色、角色能力映射、初始管理员
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

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
  ['signoff:create', '企业里程碑签字'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
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

const ROLE_CAPABILITIES = [
  ['admin', 'registration:review'], ['admin', 'team:read'], ['admin', 'team:manage'],
  ['admin', 'task_package:read'], ['admin', 'task_package:approve'], ['admin', 'score:read'],
  ['admin', 'stage:compute'], ['admin', 'audit:read'], ['admin', 'pool:read'], ['admin', 'pool:write'],
  ['captain', 'registration:write'], ['captain', 'team:create'], ['captain', 'team:read'],
  ['captain', 'team:manage'], ['captain', 'pool:read'],
  ['member', 'registration:write'], ['member', 'team:read'], ['member', 'pool:read'],
  ['judge', 'score:write'], ['judge', 'score:read'], ['judge', 'peer_review:write'], ['judge', 'task_package:read'],
  ['enterprise', 'score:write'], ['enterprise', 'score:read'], ['enterprise', 'signoff:create'],
  ['enterprise', 'task_package:read'], ['enterprise', 'task_package:write'], ['enterprise', 'pool:read'],
  ['observer', 'score:read'], ['observer', 'team:read'], ['observer', 'task_package:read'],
  ['enterprise_admin', 'task_package:write'], ['enterprise_admin', 'signoff:create'], ['enterprise_admin', 'pool:read'],
];

const { db, close } = openDatabase({ dataDir });
try {
  applyMigrations(db, join(here, '..', 'db', 'migrations'));

  const insCap = db.prepare('INSERT OR IGNORE INTO capabilities (key, description) VALUES (?, ?)');
  for (const c of CAPABILITIES) insCap.run(...c);

  const insRole = db.prepare('INSERT OR IGNORE INTO roles (key, description) VALUES (?, ?)');
  for (const r of ROLES) insRole.run(...r);

  const insRc = db.prepare('INSERT OR IGNORE INTO role_capabilities (role_id, capability) VALUES (?, ?)');
  for (const [role, cap] of ROLE_CAPABILITIES) insRc.run(role, cap);

  const adminPhone = process.env.ADMIN_PHONE || '13800000000';
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-me-now';
  let admin = db.prepare('SELECT * FROM users WHERE phone = ?').get(adminPhone);
  if (!admin) {
    admin = createUser(db, {
      name: '组委会管理员', phone: adminPhone, password: adminPassword, mbaStatus: 'mba',
    });
    db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(admin.id);
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, 'admin')").run(admin.id);
    console.log(`已创建管理员：${adminPhone} / ${adminPassword}  ← 请立即修改密码`);
  } else {
    console.log(`管理员已存在：${adminPhone}`);
  }
  console.log(`种子完成：${CAPABILITIES.length} 个能力点，${ROLES.length} 个角色，${ROLE_CAPABILITIES.length} 条角色能力映射`);
} finally {
  close();
}
```

- [ ] **Step 6: 创建前端骨架**

`platform/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI 商业黑客松 · 赛事平台</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="app"><div class="boot">正在加载…</div></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

`platform/web/router.js`：

```javascript
// web/router.js — 哈希路由
const routes = [];

export function route(pattern, view) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ regex: new RegExp(`^${source}/?$`), names, view, pattern });
}

export function match(path) {
  const clean = (path || '').split('?')[0];
  for (const r of routes) {
    const hit = r.regex.exec(clean);
    if (!hit) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(hit[i + 1]); });
    return { view: r.view, params, pattern: r.pattern };
  }
  return null;
}

export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}
```

`platform/web/store.js`：

```javascript
// web/store.js — 极简响应式 store
const state = {};
const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(getState());
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
```

`platform/web/api.js`：

```javascript
// web/api.js — 真实 API 客户端
// ⛔ 演示版用 api.demo.js 替换本模块，视图代码完全复用。
const BASE = '';

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败 ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  subscribe(path, onMessage) {
    // SSE：单向推送，走普通 HTTP，穿透代理容易，EventSource 自带断线重连
    const es = new EventSource(BASE + path);
    es.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { onMessage(e.data); }
    };
    return () => es.close();
  },
};
```

`platform/web/api.demo.js`：

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
    if (path.startsWith('/api/leaderboard')) {
      return { rows: db.leaderboard || [], demo: true };
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

`platform/web/views/login.js`：

```javascript
// web/views/login.js — 登录视图
export function renderLogin(ctx) {
  const { api, navigate } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'card login';
  wrap.innerHTML = `
    <h1>AI 商业黑客松 · 赛事平台</h1>
    <p class="muted">用报名手机号登录</p>
    <label>手机号<input id="phone" autocomplete="username" placeholder="13800000000" /></label>
    <label>密码<input id="password" type="password" autocomplete="current-password" /></label>
    <button id="submit">登录</button>
    <p id="err" class="err"></p>
  `;
  const err = wrap.querySelector('#err');
  wrap.querySelector('#submit').addEventListener('click', async () => {
    err.textContent = '';
    try {
      const phone = wrap.querySelector('#phone').value.trim();
      const password = wrap.querySelector('#password').value;
      const res = await api.post('/api/auth/login', { phone, password });
      ctx.setState({ user: res.user });
      navigate('/');
    } catch (e) {
      err.textContent = e.message;
    }
  });
  return wrap;
}
```

`platform/web/app.js`：

```javascript
// web/app.js — 前端入口
import { route, match, navigate, currentPath } from './router.js';
import { getState, setState, subscribe } from './store.js';
import { renderLogin } from './views/login.js';

// 演示版：?demo=1 时用 localStorage 适配器；正式版走真实 API。
const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
const { api } = isDemo ? await import('./api.demo.js') : await import('./api.js');

route('/', () => renderHome());
route('/login', () => renderLogin(ctx));
route('/logout', () => renderLogout());

function renderHome() {
  const el = document.createElement('div');
  el.className = 'card';
  const { user } = getState();
  el.innerHTML = `
    <h1>赛事平台</h1>
    ${user ? `<p>已登录：${user.name}</p>` : '<p class="muted">未登录</p>'}
    <nav>
      <a href="#/login">登录</a>
      <a href="#/leaderboard">榜单</a>
    </nav>
  `;
  return el;
}

function renderLogout() {
  api.post('/api/auth/logout').finally(() => {
    setState({ user: null });
    navigate('/login');
  });
  return document.createElement('div');
}

const ctx = { api, navigate, setState, getState };

async function render() {
  const app = document.getElementById('app');
  const found = match(currentPath());
  if (!found) {
    app.innerHTML = '<div class="card">页面不存在</div>';
    return;
  }
  try {
    const el = await found.view(ctx);
    app.replaceChildren(el);
  } catch (e) {
    app.innerHTML = `<div class="card err">${e.message}</div>`;
  }
}

window.addEventListener('hashchange', render);
subscribe(() => render());
render();
```

`platform/web/styles.css`：

```css
/* web/styles.css — 基础样式 */
:root {
  --bg: #0f1115;
  --card: #171a21;
  --fg: #e8eaed;
  --muted: #9aa0a6;
  --accent: #4c8dff;
  --err: #ff6b6b;
  --line: #262a33;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
#app { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: 12px; padding: 24px; margin-bottom: 16px;
}
h1 { font-size: 22px; margin: 0 0 12px; }
.muted { color: var(--muted); }
.err { color: var(--err); }
label { display: block; margin: 12px 0; }
input {
  display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
  background: #0e1016; color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px; font-size: 15px;
}
button {
  margin-top: 16px; padding: 10px 18px; border: 0; border-radius: 8px;
  background: var(--accent); color: #fff; font-size: 15px; cursor: pointer;
}
button:hover { filter: brightness(1.08); }
nav a { color: var(--accent); margin-right: 16px; }
.boot { color: var(--muted); padding: 40px; text-align: center; }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/server.test.js`
Expected: PASS（4 个测试全过）

- [ ] **Step 8: 全量测试 + 实跑**

Run: `cd platform && node --test`
Expected: 全部通过

Run: `cd platform && node scripts/migrate.js && node scripts/seed.js && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

Run: `curl -s http://127.0.0.1:8080/api/health`
Expected: `{"ok":true,"at":"..."}`

- [ ] **Step 9: 提交**

```bash
cd platform && git add src web scripts/seed.js test/server.test.js
git commit -m "feat(P0): 静态服务、前端骨架、种子数据与服务器入口"
```

---

## P0 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P0-1 | 零依赖 | `node --test test/zero-deps.test.js` 通过；无 `node_modules`、无 `package-lock.json` |
| P0-2 | 配置 fail-fast | 故意把 `scoring-final.json` 某权重改成 0.30 → 启动报「权重合计 = 1.05」并拒绝启动 |
| P0-3 | 迁移幂等 | 连续跑两次 `scripts/migrate.js`，第二次输出「本次无新迁移」 |
| P0-4 | 权限判定唯一入口 | `permissions.test.js` 6 个用例通过；`scopeClause` 生成的是参数化 SQL |
| P0-5 | 密码与会话 | `password.test.js` 5 个用例通过；库中只存 `token_hash` |
| P0-6 | 跨平台 | 在 Mac 上 `node src/server.js` 成功；把 `platform/` 拷到另一台机器重复同样命令 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

# P0 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一个能登录的空系统：零依赖运行时、SQLite 数据层、fail-fast 规则配置、HTTP 路由、服务端会话、capability + assignment 权限骨架、静态前端。

**Architecture:** 单进程 Node（仅标准库）。`src/http/` 提供路由与响应；`src/db/` 提供 SQLite 封装、迁移与仓储层（所有 SQL 收在这里）；`src/domain/` 放纯函数规则引擎（无 IO，本阶段先建空壳接口）；`src/auth/` 管认证与权限判定；`src/config.js` 加载并校验 `rules/*.json`，校验不过直接拒绝启动。前端为原生 ESM，`web/` 静态托管，`web/api.js` 与 `web/api.demo.js` 双适配器共用同一套视图。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## Global Constraints

```
运行时      Node ≥ 22.16.0（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
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
作用域      上级作用域**不隐式下推**：edition 授权不自动覆盖其下的 task_package
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
│   │   └── sse.js                SSE 事件总线（**P2 才建**；P0/P1 没有这个端点）
│   ├── auth/
│   │   ├── password.js           scrypt 哈希与校验
│   │   ├── session.js            会话签发/校验/吊销（不含 SQL）
│   │   └── permissions.js        capability + assignment 判定（不含 SQL）
│   ├── db/
│   │   ├── sqlite.js             连接封装 + 迁移执行
│   │   ├── migrate.js            迁移文件读取与应用
│   │   └── repo/
│   │       ├── users.js           用户仓储 + toPublicUser（唯一对外形状）
│   │       ├── sessions.js        会话仓储（SQL 全在这）
│   │       └── assignments.js     授权仓储（SQL 全在这）
│   └── audit/
│       └── log.js                审计日志写入（**P2 才建**；P0 不创建）
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
    ├── zero-deps.test.js
    ├── migrate.test.js
    ├── config.test.js
    ├── router.test.js
    ├── body.test.js
    ├── password.test.js
    ├── session.test.js
    ├── users.test.js
    ├── permissions.test.js
    └── server.test.js
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
  "engines": { "node": ">=22.16.0" },
  "scripts": {
    "start": "node --disable-warning=ExperimentalWarning src/server.js",
    "test": "node --disable-warning=ExperimentalWarning --test",
    "migrate": "node --disable-warning=ExperimentalWarning scripts/migrate.js",
    "seed": "node --disable-warning=ExperimentalWarning scripts/seed.js"
  }
}
```

- [ ] **Step 4: 创建 README.md**

`platform/README.md`：

```markdown
# AI 商业黑客松赛事平台

零依赖 Node 单体。`git clone` 后不需要 `npm install`，直接：

```bash
cd platform                                  # 下面所有命令都在 platform/ 下跑

node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test               # 跑测试
```

> **为什么命令里没有 `--disable-warning=ExperimentalWarning`**：`npm run start` / `npm test` 等
> 脚本里已经带上了。直接 `node xxx.js` 时 Node 22 会对内置 `node:sqlite` 打印
> `ExperimentalWarning`（实验特性提示），不影响功能，只影响输出整洁度。

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

> **【2026-10-20 评审后修正 · 第 2 轮】** 复评 Approved 后又发现 2 处**同源**缺陷，已一并修正：
> **④** 版本号解析过宽 —— `Number(name.split('_')[0])` 会把 `_init.sql` 当成版本 0、
>      把 `1e3_x.sql` 静默解析成版本 1000，在「全局唯一序位」（001=P0 … 006=P5）上
>      开出静默缺口。改为严格正则 `/^(\d+)_/`，错误文案也改准（"必须形如 NNN_name.sql"）。
> **⑤** 同版本号冲突时，错误信息里两个文件名的先后取决于 `readdirSync` 的返回顺序 ——
>      POSIX 未定义该顺序（ext4/xfs 是 hash 序），本机 APFS 实测稳定但换平台可能翻转，
>      会让测试正则偶发失配 → CI 偶发红，违反 R-OPS-02 跨平台稳定。
>      改为同版本号按文件名**字节序**二次排序。
>
> **【2026-10-20 评审后修正 · 第 1 轮】** 本 Task 的代码块已按实现回写（评审判定 Needs fixes，3 条 Important）。
> 修正三处：**①** `engines.node` 由 `>=22.5.0` 改为 `>=22.16.0`（22.5.0 只是 `node:sqlite` 的引入版本，
> 22.5.0–22.12.x 免不了 `--experimental-sqlite` 标志会直接抛错；`sqlite.backup()` 又需 ≥22.16.0，取并集）；
> **②** `readMigrationFiles` 增加**重复版本号 fail-fast**（原实现按 version 静默去重 → 第二次运行
> 打印"本次无新迁移"、退出码 0，而被遮蔽的那张表永远建不出来，schema 缺口被静默固化）；
> **③** 新增**真实 `001_init.sql` 冒烟测试**（原实现的测试全部用临时目录内联 SQL，
> 真实 DDL 从未被 apply 过，可带错而 CI 全绿）。详见 Step 1 的测试清单与下方代码块。
> 归因与官方出处见设计文档 §4.2「运行时与依赖」。

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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations, readMigrationFiles } from '../src/db/migrate.js';

// 真实迁移目录（platform/db/migrations）—— 本文件在 platform/test/ 下，故取上一级。
// 真实 DDL 必须被真正 apply 过：否则 001_init.sql 可以带着语法/外键/类型错误
// 而 CI 全绿（迁移文件本身从不进任何测试夹具）。
const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

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

test('重复版本号：响亮报错，而不是静默跳过', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE b (x INTEGER);');

  // 错误信息必须同时含版本号与冲突的两个文件名
  assert.throws(
    () => readMigrationFiles(dir),
    /迁移版本号重复: 001 \(001_a\.sql, 001_b\.sql\)/,
  );

  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  assert.throws(() => applyMigrations(db, dir), /迁移版本号重复/);

  // 报错发生在应用任何 SQL 之前：连 schema_migrations 都不该被建出来
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [], '重复版本号时不应执行任何迁移 SQL');

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('已应用的迁移文件被改名：响亮报错，而不是静默跳过', () => {
  const dir = tempDir();
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  const first = applyMigrations(db, dir);
  assert.deepEqual(first.applied, ['001_a.sql']);

  // 模拟迁移文件被改名/挪位：版本号不变，文件名变了
  rmSync(join(dir, '001_a.sql'));
  writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE a (x INTEGER);');

  assert.throws(
    () => applyMigrations(db, dir),
    /迁移 001 已以 001_a\.sql 应用，当前文件名为 001_b\.sql；迁移文件名不可变更/,
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('退化迁移文件名会被拒绝（不静默开版本缺口）', () => {
  // "_init.sql" —— Number('') === 0，会被当成版本 0
  const dirA = tempDir();
  writeFileSync(join(dirA, '_init.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirA), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirA, { recursive: true, force: true });

  // "1e3_x.sql" —— Number('1e3') === 1000，会静默跳到版本 1000，
  // 在「全局唯一序位」（001=P0 … 006=P5）上开出一个静默缺口
  const dirB = tempDir();
  writeFileSync(join(dirB, '1e3_x.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirB), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirB, { recursive: true, force: true });

  // "001.sql" —— 缺下划线
  const dirC = tempDir();
  writeFileSync(join(dirC, '001.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirC), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirC, { recursive: true, force: true });
});

test('同版本号冲突时错误信息里的文件名顺序是确定的（跨平台稳定）', () => {
  // readdirSync 的返回顺序在 POSIX 里未定义：APFS 按名序、ext4/xfs 按 hash 序。
  // 错误信息里的两个文件名由实现**显式**按字节序排好 —— 跨平台保证由构造成立，
  // 不依赖 readdir 恰好有序（这条保证在 macOS 上无法用变异检出，靠的是构造本身）。
  for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
    const dir = tempDir();
    writeFileSync(join(dir, `001_${first}.sql`), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, `001_${second}.sql`), 'CREATE TABLE b (x INTEGER);');
    assert.throws(
      () => readMigrationFiles(dir),
      /迁移版本号重复: 001 \(001_a\.sql, 001_b\.sql\)/,
      '同版本号冲突的错误信息必须始终按文件名排序',
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本号必须从 001 起，且描述符不能为空', () => {
  // 0 不是合法序位（001=P0 … 006=P5）
  const dirA = tempDir();
  writeFileSync(join(dirA, '0_x.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirA), /迁移版本号必须从 001 起/);
  rmSync(dirA, { recursive: true, force: true });

  // "01_.sql" —— 描述符为空
  const dirB = tempDir();
  writeFileSync(join(dirB, '01_.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirB), /迁移文件名必须形如/);
  rmSync(dirB, { recursive: true, force: true });
});

// ⚠️ 下面两条断言的是「当前迁移集」的快照：P1 加入 002_registration.sql 之后，
//    「恰好 9 张表 / schema_migrations 恰好 1 行 / version 仍为 1」需要放宽为
//    「包含 001_init.sql 的那几项」。到 P1 时按此提示修改。
test('真实迁移目录：建出全部表并记录版本', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  const first = applyMigrations(db, REAL_MIGRATIONS);
  assert.deepEqual(first.applied, ['001_init.sql']);
  assert.equal(first.version, 1);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of [
    'users',
    'sessions',
    'capabilities',
    'roles',
    'role_capabilities',
    'assignments',
    'user_roles',
    'audit_log',
    'schema_migrations',
  ]) {
    assert.ok(tables.includes(t), `真实迁移应建出表 ${t}`);
  }
  assert.equal(tables.length, 9, '真实迁移应恰好建出 9 张表');

  const rows = db.prepare('SELECT version, name FROM schema_migrations').all();
  assert.equal(rows.length, 1, 'schema_migrations 应恰好 1 行');
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].name, '001_init.sql');

  // 幂等：再跑一次不应再应用
  const second = applyMigrations(db, REAL_MIGRATIONS);
  assert.deepEqual(second.applied, [], '真实迁移重复执行不应再应用');
  assert.equal(second.version, 1);

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('真实 schema 下外键约束确实生效', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  applyMigrations(db, REAL_MIGRATIONS);

  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('u1', '张三', '13800000000', 'hash', now);

  // 指向存在的用户 → 外键放行
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run('token-hash-1', 'u1', now, now);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    1,
    '指向真实用户的 session 应插入成功',
  );

  // 指向不存在的用户 → 外键拦下
  assert.throws(
    () => {
      db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run('token-hash-2', 'no-such-user', now, now);
    },
    /FOREIGN KEY constraint failed/,
    '指向不存在用户的 session 应被外键拦下',
  );

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
//
// ⚠️ Node 版本下限 = 22.16.0（package.json engines）。这是两个下限的**并集**：
//    - 22.13.0：node:sqlite 不再需要 --experimental-sqlite 标志。
//      v22.5.0–v22.12.x 上 import 本文件会直接抛错（而本项目四个 scripts 都不带该 flag）。
//    - 22.16.0：sqlite.backup() —— §14 备份方案依赖的一致性备份 API（P6 的备份/恢复脚本）。
//    依据：Node v22 官方文档 SQLite 页 History 表
//    （https://nodejs.org/docs/latest-v22.x/api/sqlite.html）原文：
//      v22.5.0   Added in: v22.5.0
//      v22.13.0  SQLite is no longer behind --experimental-sqlite but still experimental.
//    以及 `sqlite.backup(sourceDb, destination[, options])` 条目：Added in: v22.16.0。
//    详见设计文档 §4.2「运行时与依赖」。
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
//   ⛔ 版本号重复 → **响亮抛错**，绝不静默跳过。
//      依据：全局约束「配置校验 fail-fast：权重合计≠100% / 阈值不单调 → 拒绝启动并报错」。
//      同一类缺陷在迁移层的表现是"两个文件抢同一个版本号"：若静默跳过，
//      先跑通的那个版本会把后一个永久遮蔽 —— schema 缺口被固化，
//      而运维看到的是"迁移完成 / 本次无新迁移"、退出码 0，看不出任何异常。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

// 版本号在文件名里的原始写法（保留前导零），仅用于错误信息展示
function versionLabel(name) {
  return name.split('_')[0];
}

export function readMigrationFiles(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      // 严格解析：文件名必须形如 <版本号>_<名称>.sql。
      // ⛔ 不能用 Number(name.split('_')[0])：那样 '_init.sql'（Number('')===0）、
      //    '1e3_x.sql'（Number('1e3')===1000）会被静默当成合法版本号 ——
      //    在「全局唯一序位」（001=P0、002=P1 … 006=P5）上开出一个静默缺口。
      //    依据：docs/superpowers/plans/INTERFACES.md「迁移版本号是全局唯一序位，
      //    002 起依次是 P1→P5」；同文档的重复版本号检查也以 '_' 为分隔符
      //    （ls -1 *.sql | cut -d_ -f1 | sort | uniq -d）。
      const m = /^(\d+)_(.+)\.sql$/.exec(name);
      if (!m) {
        throw new Error(`迁移文件名必须形如 <版本号>_<名称>.sql: ${name}`);
      }
      const version = Number(m[1]);
      // 版本号从 001 起 —— 0 不是合法序位（001=P0 … 006=P5）。
      if (version < 1) {
        throw new Error(`迁移版本号必须从 001 起: ${name}`);
      }
      return { version, name, sql: readFileSync(join(dir, name), 'utf8') };
    })
    // 排序：版本号升序 + 同版本号按文件名字节序。
    // ⚠️ readdirSync 的返回顺序在 POSIX 里未定义：APFS 按名序、ext4/xfs 按 hash 序，
    //    只按 version 排序会让同版本号的两个文件谁在前**因平台而异** →
    //    跨平台不一致（R-OPS-02）。
    //    比较用字节序（< / >），**不用 localeCompare**：后者依赖 locale，跨平台不一致。
    //    依据：R-OPS-02「跨平台稳定」。
    .sort((a, b) => (a.version - b.version) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // 重复版本号 → 抛错。必须在任何迁移 SQL 落地**之前**发现，
  // 否则先落地的那张表会把后一个永久遮蔽（静默跳过 = schema 缺口被固化）。
  const seen = new Map();
  for (const f of files) {
    const prev = seen.get(f.version);
    if (prev) {
      // 两个文件名**显式**按字节序排好再拼进错误信息 ——
      // 这样即使上面的排序被改回去，错误信息本身仍然确定（不依赖 readdir 顺序）。
      // 跨平台保证由**构造**成立，而不是靠"恰好 readdir 有序"。
      const [x, y] = prev.name < f.name ? [prev.name, f.name] : [f.name, prev.name];
      throw new Error(
        `迁移版本号重复: ${versionLabel(x)} (${x}, ${y})`,
      );
    }
    seen.set(f.version, f);
  }

  return files;
}

export function applyMigrations(db, migrationsDir) {
  // 先读文件并校验：重复版本号 / 文件名格式错误必须在任何 SQL 执行前失败
  const files = readMigrationFiles(migrationsDir);

  db.exec(MIGRATION_TABLE);
  // 已应用版本 → 当初应用时的文件名（用于校验迁移文件有没有被改名/挪位）
  const appliedMap = new Map(
    db.prepare('SELECT version, name FROM schema_migrations').all().map((r) => [r.version, r.name]),
  );

  const applied = [];
  for (const m of files) {
    const recordedName = appliedMap.get(m.version);
    if (recordedName !== undefined) {
      // 已应用过：文件名必须与当初一致。
      // 被改名/挪位 → 抛错，而不是"跳过"（跳过会让迁移历史与文件对不上账）。
      if (recordedName !== m.name) {
        throw new Error(
          `迁移 ${versionLabel(m.name)} 已以 ${recordedName} 应用，当前文件名为 ${m.name}；迁移文件名不可变更`,
        );
      }
      continue;
    }
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
      // 防御性纵深：循环内登记已应用版本，
      // 不让"同一版本被应用两次"这类问题依赖循环外的快照。
      appliedMap.set(m.version, m.name);
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
--    两个迁移抢同一个版本号时，后执行的那张表永远建不出来。
--    ⚠️ 现在 applyMigrations 对重复版本号**直接抛错**（fail-fast），
--       不再是"按 version 静默去重"—— 静默跳过会把 schema 缺口固化，运维看不出来。
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
Expected: PASS（10 个测试全过）

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

> **【2026-10-20 派单前补强】** 原计划的 `validateRules` 只校验了 9 份配置里的 5 份
> （scoring / tiebreak / ranks / registration / solvability），**behavior、visibility、milestones
> 这 3 份只被读出来、零内容校验** —— 与本 Task 自己的目标「9 份规则配置与 fail-fast 校验」矛盾，
> 也与全局约束「配置校验 fail-fast：权重合计≠100% / 阈值不单调 → 拒绝启动并报错」矛盾：
> 这三份一旦写错，症状要到 P2/P3 算分、算榜单时才爆出来，而那时榜单可能已经发出去了。
> 补强内容：① behavior 的 `maxWeightShare` / `completionThreshold` / 事件 `points` / key 唯一；
> ② visibility 的段位引用必须真实存在于 `ranks.tiers`（悬空引用会让公示门槛静默失效）；
> ③ milestones 的 `confirmedBy` 枚举 / key 唯一 / 至少一项 `countsTowardTier`；
> ④ 缺失 `dimensions` 等子结构时报**友好校验错误**而不是抛 `TypeError`；
> ⑤ 各处 key 唯一性检查。对应测试从 7 条增至 13 条。
>
> **【2026-10-20 派单后第 2 轮补强】** 实现者按简报**逐字**实现后，用探针实测出 3 条漏检并交回裁决，
> 父代理复核后**全部采纳**（实测证据见 `task-3-report.md`）：
> **⑥** **9 份配置的 `version` 必须全等** —— 实现者实测把 `tiebreak.json` 的 version 改成
> `2099-01-01` 后 `loadRules` **静默接受**并对外报 `version=2099-01-01`。version 会写进计算 trace
> （设计原则「每次计算留 trace」）—— 版本号漂移 = 审计链在说谎，事后复算无法自证。
> **⑦** **数组元素为 null 时报友好错误而非裸 `TypeError`** —— 第 ④ 条只护住了 `scoring.*.dimensions`，
> 同类的 `behavior.events` / `milestones.items` / `ranks.tiers` 等无防护，
> 实测 `TypeError: Cannot read properties of null (reading 'points')`。
> **⑧** **`solvability.grades` 的评分区间不得重叠** —— A/B/C/D 是**互斥**区间（A 10-12 / B 7-9 / C 4-6 / D 0-3），
> 实测改成重叠后**不报错**；重叠会让同一分数落进两个等级，评级结果取决于查表顺序 → 不可复算。
> 对应测试从 13 条增至 **16 条**。
>
> **【2026-10-20 评审后第 3 轮补强】** Task 3 首轮评审 Approved，但评审挖出一条**规格级 Important**：
> `docs/rule-decisions.md:119-121` 的 **C-05 裁决**要求 `rules/scoring-*.json` 里必须有
> `fallback: "global" | "raw"`（归一化在样本不足时的兜底策略，**可配**），实测 **9 份 JSON 一处都没有** ——
> 裁决没有写进规则配置文件，与该文件开篇「每条冲突必须有裁决，且裁决必须写进规则配置文件」直接冲突。
> 顺带补齐另两条裁决的落地方式：**C-03** 要求 tiebreak 有序链**逐项**标注来源文档（原来只有文件级 source）；
> **C-04** 要求 `scoring-final.json` 加说明字段说明「完成度以 §2.2 的 20% 为准」。
> 本轮新增/修正 6 条校验 + 6 条测试：
> **⑨** `fallback` 必须是 `global` / `raw`（C-05）；**⑩** `conflictRef: C-01` ⇒ `wEnterprise === 0.10`
> **由运行时校验器锁住**（原来只靠测试，同时改 wEnterprise 与企业维度权重可绕过）；
> **⑪** `solvability.grades` 反向区间 `min > max` 当场拒绝；**⑫** 维度缺 `key` 当场拒绝；
> **⑬** 9 份配置缺 `version` 当场拒绝（原来只校验「存在的那几份全等」）；
> **⑭** tiebreak 每项必须有 `source`（C-03）。对应测试从 16 条增至 **22 条**。
>
> ⚠️ 本轮父代理自己写的校验代码里也踩了一个坑（已修正）：`[...new Set(arr)]` 得到的是**数组**，
> 判重数要用 `.length`；写成 `.size` 会拿到 `undefined`，`undefined > 1` 恒为 false，
> **这条校验会静默失效**。派单前用"抽取代码块 → 临时目录实跑"校验规格，抓到了它。
> 补强后的规格实跑：**16/16 通过**。
> 另修正一处测试标题与实现不符（"覆盖 0-100" → "单调不增"，本就不校验 0-100 覆盖）。

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

test('报名等级阈值必须单调不增', () => {
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

// ── 以下 6 条覆盖「9 份配置全部有内容校验」这条要求 ──────────────
// 行为分 / 可见性 / 里程碑这三份配置如果只被读出来、不被校验，
// 写错了也要等到 P2/P3 算分算榜时才发现 —— 那时榜单可能已经发出去了。

test('behavior 的行为分占比上限必须在 0..1', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.maxWeightShare = 1.5;
  assert.ok(validateRules(broken).some((e) => e.includes('behavior')));
});

test('behavior 事件的 points 必须为正数', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events[0].points = 0;
  assert.ok(validateRules(broken).some((e) => e.includes('behavior')));
});

test('visibility 引用的段位必须真实存在', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.visibility.rank.publicFromTier = 'Z';
  assert.ok(validateRules(broken).some((e) => e.includes('visibility')));
});

test('milestones 的确认方枚举必须合法', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.milestones.items[0].confirmedBy = 'nobody';
  assert.ok(validateRules(broken).some((e) => e.includes('milestones')));
});

test('缺失 dimensions 时报友好错误，而不是抛 TypeError', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.final.dimensions;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('scoring.final') && e.includes('dimensions')),
    '缺失 dimensions 应被当作校验错误报告，而不是抛 TypeError',
  );
});

test('维度 key 重复会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.dimensions[1].key = broken.scoring.final.dimensions[0].key;
  assert.ok(validateRules(broken).some((e) => e.includes('重复 key')));
});

// ── 以下 3 条来自实现者实测反馈的 3 条漏检（父代理裁决后采纳）──────────

test('9 份配置的 version 必须一致（漂移会让计算 trace 说谎）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.tiebreak.version = '2099-01-01';
  assert.ok(validateRules(broken).some((e) => e.includes('version')));
});

test('数组里混入 null 元素时报友好错误，而不是抛 TypeError', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events[0] = null;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('behavior.events')),
    'null 元素应被当作校验错误报告，而不是抛 TypeError',
  );
});

test('solvability.grades 的评分区间不得重叠', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.solvability.grades[1].minScore = broken.solvability.grades[0].minScore; // B 覆盖到 A
  assert.ok(validateRules(broken).some((e) => e.includes('区间重叠')));
});

// ── 以下 6 条来自 Task 3 评审（rule-decisions 裁决的落地方式未落实）──────────

test('归一化的兜底策略 fallback 必须是 global 或 raw（C-05 裁决）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.scoring.initial.fallback, 'global');
  assert.equal(rules.scoring.final.fallback, 'global');
  const broken = structuredClone(rules);
  delete broken.scoring.final.fallback;
  assert.ok(validateRules(broken).some((e) => e.includes('fallback')));
});

test('C-01 裁决由运行时校验器锁住（不只靠测试）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  // 同时改 wEnterprise 与企业维度权重，并把完成度调低 —— 合计仍是 100%。
  // 这正是「只靠测试锁不住」的绕过路径。
  broken.scoring.initial.wEnterprise = 0.20;
  const ent = broken.scoring.initial.dimensions.find((d) => d.seat === 'enterprise');
  ent.weight = 0.20;
  broken.scoring.initial.dimensions.find((d) => d.key === 'completeness').weight = 0.15;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('C-01')),
    'C-01 裁决的初赛企业确认权重 10% 必须由校验器锁住',
  );
});

test('solvability.grades 的反向区间（min > max）会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.solvability.grades[0].maxScore = 6; // A 变成 10-6，永远匹配不到
  assert.ok(validateRules(broken).some((e) => e.includes('区间非法')));
});

test('维度缺少 key 会被拒绝（否则算分无法映射回维度）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.final.dimensions[0].key;
  assert.ok(validateRules(broken).some((e) => e.includes('缺少 key')));
});

test('某份配置缺少 version 会被拒绝（不能只校验存在的那几份）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.tiebreak.version;
  assert.ok(validateRules(broken).some((e) => e.includes('缺少 version')));
});

test('破同分链每一项都必须标注来源文档（C-03 落地要求）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.tiebreak.chain[1].source;
  assert.ok(validateRules(broken).some((e) => e.includes('source')));
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
  "note": "初赛 wEnterprise=0.10 —— 依据权重表合计正好 100% 反推，见 rule-decisions.md C-01；fallback=global 依据 C-05 裁决（S7 §3.1 原文：样本数<5 退回全局均值方差）",
  "wEnterprise": 0.10,
  "normalizationStrategy": "zscore",
  "minSamplesForJudgeNormalization": 5,
  "fallback": "global",
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
  "conflictRef": "C-04",
  "source": "S7 §2.2 决赛权重表 + §3.1 评分公式",
  "note": "完成度以 §2.2 权重表的 20% 为准；S7 §6 的「25%→15%」是历史叙述章节、不具规则效力（rule-decisions.md C-04）。fallback=global 依据 C-05 裁决",
  "wEnterprise": 0.25,
  "normalizationStrategy": "zscore",
  "minSamplesForJudgeNormalization": 5,
  "fallback": "global",
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
    { "key": "total",          "label": "总分",           "direction": "desc", "scope": "always",     "source": "S7 §3.1 总分" },
    { "key": "tiebreak_extra", "label": "加时陈述复议分", "direction": "desc", "scope": "final_only", "manual": true, "source": "S10 §0.4 加时陈述复议" },
    { "key": "peer",           "label": "互评分",         "direction": "desc", "scope": "tied_only",  "source": "S7 §3.3 互评（唯一破同分工具）" },
    { "key": "enterprise_raw", "label": "企业确认原始分", "direction": "desc", "scope": "tied_only",  "source": "S7 §3.3 兜底（主观但独立于互评）" },
    { "key": "behavior",       "label": "行为分",         "direction": "desc", "scope": "tied_only",  "source": "S10 §3.3 过程参与度，≤10%，最弱" },
    { "key": "team_id",        "label": "队伍编号",       "direction": "asc",  "scope": "always", "deterministic": true, "source": "C-03 新增：三份文档都没写的最终确定性兜底，保证排序永远可复现（满足 R-AUD-01）" }
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
//   ⚠️ 9 份配置**全部**都要有内容校验（不只是能被 JSON.parse 出来）：
//      "能读出 JSON" 不等于 "配置是对的"。漏检的那几份一旦写错，症状要到
//      P2/P3 算分、算榜单时才爆出来 —— 而那时榜单可能已经发出去了。
import { readFileSync } from 'node:fs';
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

// 归一化策略四选一（设计文档 §6.2 裁决：可切换）
const VALID_NORMALIZATIONS = ['zscore', 'median', 'trimmed', 'bayes'];
// 归一化的兜底策略二选一（rule-decisions.md C-05 裁决）：
//   global —— 退回全局均值方差（S7 §3.1 原文）；raw —— 直接用原始分。
//   缺这个键 = 样本不足时的归一化行为无定义，必须当场拒绝。
const VALID_FALLBACKS = ['global', 'raw'];
// 里程碑确认方只有两种：企业侧确认 / 评委确认
const VALID_CONFIRMERS = ['enterprise', 'judge'];

function weightSum(dimensions) {
  return dimensions.reduce((a, d) => a + (typeof d.weight === 'number' ? d.weight : 0), 0);
}

function hasDuplicateKeys(items) {
  const keys = items.map((i) => i?.key).filter((k) => k !== undefined);
  return new Set(keys).size !== keys.length;
}

// 数组元素必须是非 null 对象 —— 否则下面访问 item.key / item.points 会抛 TypeError。
// 校验器的第一职责是**自己不崩**、给出可读错误，而不是把裸 TypeError 抛给调用方。
function hasBadItem(items) {
  return items.some((i) => i === null || typeof i !== 'object');
}

// 维度必须都有 key —— 否则算分时无法把分数映射回维度。
function hasMissingKey(items) {
  return items.some((i) => typeof i.key !== 'string' || !i.key);
}

export function validateRules(rules) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  // ── 版本号一致性 ─────────────────────────────────────────
  // 9 份配置的 version 必须全等。version 会写进计算 trace（设计原则
  // 「每次计算留 trace」）—— 版本号漂移 = 审计链在说谎：trace 上标注的版本
  // 与实际生效的规则对不上，事后复算无法自证。
  const versionValues = [
    rules?.scoring?.initial?.version,
    rules?.scoring?.final?.version,
    rules?.tiebreak?.version,
    rules?.ranks?.version,
    rules?.behavior?.version,
    rules?.visibility?.version,
    rules?.registration?.version,
    rules?.solvability?.version,
    rules?.milestones?.version,
  ].filter((v) => v !== undefined && v !== null && v !== '');
  // 9 份必须**都有** version —— 只校验「存在的那几份全等」是不够的：
  // 缺一份时 loadRules 对外报的 version 会取到别人的值，等于说谎。
  if (versionValues.length < 9) {
    push(`规则配置有 ${9 - versionValues.length} 份缺少 version 字段`);
  }
  if (versionValues.length > 1) {
    const distinct = [...new Set(versionValues)];
    // ⚠️ distinct 是**数组**（Set 被展开），判重数用 .length —— 用 .size 会拿到
    //    undefined，比较恒为 false，这条校验会静默失效。
    if (distinct.length > 1) {
      push(`规则配置 version 不一致：${distinct.join(' / ')} —— 9 份配置必须同版本`);
    }
  }

  // ── 评分配置 ──────────────────────────────────────────────
  for (const key of ['initial', 'final']) {
    const cfg = rules?.scoring?.[key];
    if (!cfg) {
      push(`scoring.${key} 缺失`);
      continue;
    }
    if (!Array.isArray(cfg.dimensions) || cfg.dimensions.length === 0) {
      push(`scoring.${key}.dimensions 缺失或为空`);
      continue;
    }
    if (hasBadItem(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 含非对象元素`);
      continue;
    }
    const sum = weightSum(cfg.dimensions);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`scoring.${key} 权重合计 = ${sum.toFixed(4)}，必须等于 1（100%）`);
    }
    const ent = cfg.dimensions.find((d) => d.seat === 'enterprise');
    if (!ent) {
      push(`scoring.${key} 缺少 seat=enterprise 的维度`);
    } else if (Math.abs(ent.weight - cfg.wEnterprise) > 1e-9) {
      push(
        `scoring.${key} wEnterprise=${cfg.wEnterprise} 与企业确认维度权重 ${ent.weight} 不一致`,
      );
    }
    if (typeof cfg.wEnterprise !== 'number' || cfg.wEnterprise < 0 || cfg.wEnterprise > 1) {
      push(`scoring.${key} wEnterprise 必须在 0..1`);
    }
    if (!VALID_NORMALIZATIONS.includes(cfg.normalizationStrategy)) {
      push(`scoring.${key} normalizationStrategy 非法`);
    }
    // C-05 裁决：兜底策略可配 —— "global" 退回全局均值方差（S7 §3.1 原文），
    // "raw" 直接用原始分。缺这个键 = 样本不足时归一化怎么走没有定义。
    if (!VALID_FALLBACKS.includes(cfg.fallback)) {
      push(`scoring.${key}.fallback 必须是 ${VALID_FALLBACKS.join(' / ')}（C-05 裁决）`);
    }
    // C-01 裁决：初赛企业确认权重锁定 10%（由 S7 §2.1 权重表合计正好 100% 反推）。
    // 只靠测试锁不住 —— 同时改 wEnterprise 与企业维度权重（保持合计 100%）能绕过测试，
    // 所以校验器也要锁。改动此项须同步改 rule-decisions.md 的 C-01。
    if (cfg.conflictRef === 'C-01' && Math.abs(cfg.wEnterprise - 0.10) > 1e-9) {
      push(`scoring.${key}.wEnterprise 必须为 0.10（C-01 裁决）`);
    }
    if (hasMissingKey(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 存在缺少 key 的维度`);
    }
    if (hasDuplicateKeys(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 存在重复 key`);
    }
  }

  // ── 破同分链 ──────────────────────────────────────────────
  const chain = rules?.tiebreak?.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    push('tiebreak.chain 缺失或为空');
  } else if (hasBadItem(chain)) {
    push('tiebreak.chain 含非对象元素');
  } else {
    const last = chain[chain.length - 1];
    if (!last.deterministic) {
      push('tiebreak.chain 必须以确定性兜底项结尾（deterministic: true），否则榜单不可复算');
    }
    if (!chain.some((c) => c.key === 'total')) {
      push('tiebreak.chain 缺少总分项');
    }
    if (hasDuplicateKeys(chain)) {
      push('tiebreak.chain 存在重复 key');
    }
    // C-03 落地要求：有序链的**每一项**都要标注来源文档与生效条件
    // （生效条件 = scope，已有；来源文档 = source，必须有）。
    if (chain.some((c) => typeof c.source !== 'string' || !c.source)) {
      push('tiebreak.chain 存在缺少 source 的项（C-03 要求逐项标注来源文档）');
    }
  }

  // ── 段位 ─────────────────────────────────────────────────
  const tiers = rules?.ranks?.tiers;
  const tierKeys = new Set();
  if (!Array.isArray(tiers) || tiers.length === 0) {
    push('ranks.tiers 缺失或为空');
  } else if (hasBadItem(tiers)) {
    push('ranks.tiers 含非对象元素');
  } else {
    for (const t of tiers) tierKeys.add(t.key);
    for (let i = 1; i < tiers.length; i += 1) {
      if (tiers[i].minMilestones <= tiers[i - 1].minMilestones) {
        push(`ranks.tiers 门槛必须严格递增（第 ${i + 1} 档）`);
      }
    }
    if (hasDuplicateKeys(tiers)) {
      push('ranks.tiers 存在重复 key');
    }
  }

  // ── 报名等级 ─────────────────────────────────────────────
  const levels = rules?.registration?.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    push('registration.levels 缺失或为空');
  } else if (hasBadItem(levels)) {
    push('registration.levels 含非对象元素');
  } else {
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i].minScore > levels[i - 1].minScore) {
        push(`registration.levels 阈值必须单调不增（第 ${i + 1} 级）`);
      }
    }
    if (hasDuplicateKeys(levels)) {
      push('registration.levels 存在重复 key');
    }
  }
  const regDims = rules?.registration?.dimensions;
  if (!Array.isArray(regDims) || regDims.length === 0) {
    push('registration.dimensions 缺失或为空');
  } else if (hasBadItem(regDims)) {
    push('registration.dimensions 含非对象元素');
  } else {
    if (hasMissingKey(regDims)) {
      push('registration.dimensions 存在缺少 key 的维度');
    }
    const sum = weightSum(regDims);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`registration.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }

  // ── 可解性 ───────────────────────────────────────────────
  const sol = rules?.solvability;
  if (!Array.isArray(sol?.dimensions) || sol.dimensions.length === 0) {
    push('solvability.dimensions 缺失或为空');
  } else if (hasBadItem(sol.dimensions)) {
    push('solvability.dimensions 含非对象元素');
  } else {
    if (hasMissingKey(sol.dimensions)) {
      push('solvability.dimensions 存在缺少 key 的维度');
    }
    const sum = weightSum(sol.dimensions);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`solvability.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }
  if (!Array.isArray(sol?.grades) || sol.grades.length === 0) {
    push('solvability.grades 缺失或为空');
  } else if (hasBadItem(sol.grades)) {
    push('solvability.grades 含非对象元素');
  } else if (hasDuplicateKeys(sol.grades)) {
    push('solvability.grades 存在重复 key');
  } else {
    // 反向区间（minScore > maxScore）永远匹配不到任何分数 —— 当场拒绝。
    for (const g of sol.grades) {
      if (typeof g.minScore !== 'number' || typeof g.maxScore !== 'number'
        || g.minScore > g.maxScore) {
        push(
          `solvability.grades 等级 ${g.key} 的区间非法`
          + `（minScore=${g.minScore}, maxScore=${g.maxScore}）`,
        );
      }
    }
    // A/B/C/D 是**互斥**的评分区间：重叠会让同一个分数落进两个等级，
    // 评级结果取决于查表顺序 —— 不可复算。
    const sorted = [...sol.grades].sort((a, b) => a.minScore - b.minScore);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].minScore <= sorted[i - 1].maxScore) {
        push(
          `solvability.grades 分值区间重叠：${sorted[i - 1].key}`
          + `(${sorted[i - 1].minScore}-${sorted[i - 1].maxScore}) 与 `
          + `${sorted[i].key}(${sorted[i].minScore}-${sorted[i].maxScore})`,
        );
      }
    }
  }

  // ── 行为分 ───────────────────────────────────────────────
  // 行为分只用于破同分、不进总分（分轨强制）；但它仍有自己的阈值与上限，必须校验。
  const behavior = rules?.behavior;
  if (!behavior) {
    push('behavior 缺失');
  } else {
    if (typeof behavior.maxWeightShare !== 'number'
      || behavior.maxWeightShare < 0 || behavior.maxWeightShare > 1) {
      push('behavior.maxWeightShare 必须在 0..1');
    }
    if (typeof behavior.completionThreshold !== 'number'
      || behavior.completionThreshold < 0 || behavior.completionThreshold > 100) {
      push('behavior.completionThreshold 必须在 0..100');
    }
    if (!Array.isArray(behavior.events) || behavior.events.length === 0) {
      push('behavior.events 缺失或为空');
    } else if (hasBadItem(behavior.events)) {
      push('behavior.events 含非对象元素');
    } else {
      if (hasDuplicateKeys(behavior.events)) {
        push('behavior.events 存在重复 key');
      }
      for (const e of behavior.events) {
        if (typeof e.points !== 'number' || e.points <= 0) {
          push(`behavior.events 事件 ${e.key} 的 points 必须为正数`);
        }
      }
    }
  }

  // ── 可见性 ───────────────────────────────────────────────
  // 段位引用必须真实存在 —— 悬空引用会让"公示门槛"静默失效，
  // 而症状要到 P3 算榜单、对可见性过滤时才出现。
  const vis = rules?.visibility;
  if (!vis) {
    push('visibility 缺失');
  } else {
    for (const field of ['publicFromTier', 'privateBelowTier']) {
      const ref = vis.rank?.[field];
      if (typeof ref !== 'string' || !ref) {
        push(`visibility.rank.${field} 缺失`);
      } else if (tierKeys.size > 0 && !tierKeys.has(ref)) {
        push(`visibility.rank.${field} 引用了不存在的段位 ${ref}`);
      }
    }
  }

  // ── 里程碑 ───────────────────────────────────────────────
  const ms = rules?.milestones;
  if (!ms) {
    push('milestones 缺失');
  } else {
    if (!Array.isArray(ms.items) || ms.items.length === 0) {
      push('milestones.items 缺失或为空');
    } else if (hasBadItem(ms.items)) {
      push('milestones.items 含非对象元素');
    } else {
      if (hasDuplicateKeys(ms.items)) {
        push('milestones.items 存在重复 key');
      }
      for (const it of ms.items) {
        if (!VALID_CONFIRMERS.includes(it.confirmedBy)) {
          push(`milestones.items 里程碑 ${it.key} 的 confirmedBy=${it.confirmedBy} 非法`);
        }
      }
      if (!ms.items.some((it) => it.countsTowardTier)) {
        push('milestones.items 没有任何 countsTowardTier=true 的里程碑，段位将永远无法晋升');
      }
    }
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
Expected: PASS（22 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/config.js rules test/config.test.js
git commit -m "feat(P0): 9 份声明式规则配置与 fail-fast 校验"
```

---

### Task 4: HTTP 路由、响应与 body 解析

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **2 Critical + 1 Important**（Task 4 自带的 6 条测试里 **5 条会红**，主功能不可用）。
> 修正三处：
> **①（C4-1 Critical）路由优先级比较器写反 → 静态路径被参数路由劫持。**
>      原比较器 `b.names.length - a.names.length` 的效果是**参数段多的排前面**，与注释相反；
>      第二排序键 `a.pattern.length - b.pattern.length` 是字符串长度，与静态优先无关。
>      后果：`GET /api/leaderboard/rolling` 命中 `GET /api/leaderboard/:stageId` → **发榜数据取错**
>      （P1–P6 有 20+ 条带参路由全落在这个匹配器上）。
>      改为**逐段比较**（不是比数量，也不是比字符串长度）：第一处不同的段上**静态段胜参数段**；
>      两段都是静态但字面量不同（不可能同时匹配同一路径）→ 按字节序，保证确定性；
>      两段都是参数 → 继续比下一段；一个 pattern 先结束（另一个是它的前缀）→ **短的在前**；
>      完全相同 → 保持注册顺序。**匹配结果与注册顺序无关**（同形状两条路由谁先注册都一样）。
>      测试从 6 条增至 8 条（新增「rolling 不被 :stageId 劫持」+「正序/反序注册结果一致」）。
> **②（C4-2 Critical）畸形 URL 打死整个服务器进程。**
>      `params[name] = decodeURIComponent(hit[i + 1])` 遇到 `'%E0%A4%A'` 抛 `URIError`，
>      而 `server.js` 里 `router.match(...)` 在 `try {` **之外** → 异常越过 handle 的 try/catch →
>      Node 默认未捕获异常退出（退出码 1），**整个服务器进程死亡**。
>      P0 只有无参路由所以打不到，**P1 起（`/api/teams/:id`）即刻可远程触发**。
>      两处都改：router 内对每个捕获段做 `try { decodeURIComponent(v) } catch { 该路由不匹配 }`
>      （畸形百分号编码**不允许抛出到路由匹配之外**），`server.js` 里把 `router.match(...)`
>      **移进 `try` 块内**，并把「URL 编码非法」与「没这个接口」区分开：前者 **400**、后者 404。
> **③（I4-1 Important）body 超限时请求流未消费 → 连接悬挂。**
>      `readJsonBody` 超限直接 `throw`，客户端还在发剩余 body → 连接占住不放（慢速上传可占连接）。
>      改为超限时先 `req.destroy()`（销毁请求流）再抛 413；上层 413 响应带 `Connection: close`。
> 另：`text(res, status, body, contentType?)` 的第 4 个可选参数与契约 `text(res, status, body)`
> 不一致，但**向后兼容**，保留不动（m4-1）。

**Files:**
- Create: `platform/src/http/router.js`
- Create: `platform/src/http/respond.js`
- Create: `platform/src/http/body.js`
- Create: `platform/test/router.test.js`
- Create: `platform/test/body.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createRouter()` → `{ add(method, pattern, handler), match(method, path) }`
  - `pattern` 形如 `/api/teams/:teamId/members`，`:name` 捕获一个路径段
  - `match()` 返回 `{ handler, params }` 或 `null`（**畸形百分号编码 → 视为不匹配，返回 null**，由上层回 400）
  - `json(res, status, body)`、`text(res, status, body)`、`error(res, status, code, message)`
  - `readJsonBody(req, { limit })` → 解析后的对象；超限抛错（`status=413`，且请求流已被销毁）

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

test('注册顺序不影响匹配（静态段优先于参数段）：正序与反序注册结果一致', () => {
  // ⛔ 预审修正（C4-1）：原用例只测了一种注册顺序，而用例名承诺的是"注册顺序不影响"。
  //    现在两种注册顺序都断言同样的结果。
  const forward = createRouter();
  forward.add('GET', '/api/teams/me', () => 'static');
  forward.add('GET', '/api/teams/:id', () => 'param');
  const backward = createRouter();
  backward.add('GET', '/api/teams/:id', () => 'param');
  backward.add('GET', '/api/teams/me', () => 'static');
  for (const r of [forward, backward]) {
    assert.equal(r.match('GET', '/api/teams/me').handler(), 'static');
    assert.equal(r.match('GET', '/api/teams/other').handler(), 'param');
  }
});

test('URL 里的 query 不影响路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/leaderboard', () => 'lb');
  assert.ok(r.match('GET', '/api/leaderboard?scope=rank'));
});

test('静态路由 /api/leaderboard/rolling 不会被参数路由 /api/leaderboard/:stageId 劫持', () => {
  // ⛔ 预审修正（C4-1）：原比较器把参数段多的排前面 → rolling 会被 :stageId 劫持 → 发榜取错数据。
  for (const build of [
    (r) => {
      r.add('GET', '/api/leaderboard/rolling', () => 'rolling');
      r.add('GET', '/api/leaderboard/:stageId', () => 'stage');
    },
    (r) => {
      r.add('GET', '/api/leaderboard/:stageId', () => 'stage');
      r.add('GET', '/api/leaderboard/rolling', () => 'rolling');
    },
  ]) {
    const r = createRouter();
    build(r);
    assert.equal(r.match('GET', '/api/leaderboard/rolling').handler(), 'rolling');
    assert.equal(r.match('GET', '/api/leaderboard/st1').handler(), 'stage');
  }
});

test('畸形百分号编码不抛异常，且不匹配该路由', () => {
  // ⛔ 预审修正（C4-2）：decodeURIComponent('%E0%A4%A') 抛 URIError，
  //    抛出到路由匹配之外会打死整个服务器进程（server.js 里 router.match 在 try 之外）。
  const r = createRouter();
  r.add('GET', '/api/teams/:teamId', () => 'team');
  assert.equal(r.match('GET', '/api/teams/%E0%A4%A'), null);
});
```

`platform/test/body.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../src/http/body.js';

test('正常 JSON body 解析成对象', async () => {
  const req = Readable.from([Buffer.from('{"a":1}')]);
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('body 超限抛 413，并销毁请求流（不留下悬挂连接）', async () => {
  // ⛔ 预审修正（I4-1）：超限时先销毁请求流再抛错，
  //    否则客户端继续发剩余 body → 连接悬挂（慢速上传可占住连接）。
  const req = Readable.from([Buffer.alloc(1024, 0x61)]);
  await assert.rejects(
    () => readJsonBody(req, { limit: 10 }),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
  );
  assert.equal(req.destroyed, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/router.test.js test/body.test.js`
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

  /**
   * 路由优先级比较器：**逐段比较**（2026-10-20 预审修正 C4-1）。
   *
   * ⛔ 不能比"参数段个数"，也不能比"pattern 字符串长度"：
   *    前者把参数路由排到静态路由前面（与静态优先相反），
   *    后者与静态优先无关 —— 两者都会让 `/api/leaderboard/rolling` 被
   *    `/api/leaderboard/:stageId` 劫持（发榜数据取错）。
   *
   * 规则（从左往右逐段比，第一处不同的段决定胜负）：
   *   ① 静态段胜参数段
   *   ② 两段都是静态但字面量不同（不可能同时匹配同一路径）→ 按字节序，保证确定性
   *   ③ 两段都是参数 → 继续比下一段
   *   ④ 一个 pattern 先结束（另一个是它的前缀）→ 短的在前（更具体）
   *   ⑤ 完全相同 → 保持注册顺序（Array.sort 稳定）
   *
   * 效果：同形状（同参数段数、同静态段数）的两条路由，先注册哪条都不影响匹配结果。
   */
  function compareRoutes(a, b) {
    const as = a.segments;
    const bs = b.segments;
    const len = Math.min(as.length, bs.length);
    for (let i = 0; i < len; i++) {
      const x = as[i];
      const y = bs[i];
      if (x === y) continue;
      const xIsParam = x.startsWith(':');
      const yIsParam = y.startsWith(':');
      if (xIsParam !== yIsParam) return xIsParam ? 1 : -1; // ① 静态段优先
      if (xIsParam && yIsParam) continue; // ③ 都是参数 → 看下一段
      return x < y ? -1 : 1; // ② 都是静态 → 字节序
    }
    return as.length - bs.length; // ④ 前缀 → 短的在前
  }

  return {
    add(method, pattern, handler) {
      const { regex, names } = compile(pattern);
      routes.push({
        method: method.toUpperCase(),
        pattern,
        segments: pattern.split('/'),
        regex,
        names,
        handler,
      });
      return this;
    },
    match(method, path) {
      const clean = path.split('?')[0];
      const m = method.toUpperCase();
      // 静态优先于参数：逐段比较（见 compareRoutes）
      const ordered = [...routes].sort(compareRoutes);
      for (const route of ordered) {
        if (route.method !== m) continue;
        const hit = route.regex.exec(clean);
        if (!hit) continue;
        const params = {};
        let malformed = false;
        route.names.forEach((name, i) => {
          if (malformed) return;
          try {
            params[name] = decodeURIComponent(hit[i + 1]);
          } catch {
            // ⛔ 畸形百分号编码（如 '%E0%A4%A'）会让 decodeURIComponent 抛 URIError。
            //    绝不能让它抛出到路由匹配之外：server.js 里 router.match 一旦在 try 块外，
            //    一个畸形 URL 就能让 Node 以未捕获异常退出（退出码 1）→ 整个服务器进程死亡。
            //    视为非法 URL → 该路由不匹配（match 返回 null），由上层回 400。
            malformed = true;
          }
        });
        if (malformed) return null;
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
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    // ⛔ 预审修正（I4-1）：必须先把请求流消费/销毁掉再抛错。
    //    客户端可能还在发剩余 body，不消费就抛 → 连接悬挂（慢速上传能占住连接不放）。
    //    销毁请求流后，上层回 413 并带 Connection: close（连接不再复用）。
    if (typeof req.destroy === 'function') req.destroy();
    else if (typeof req.resume === 'function') req.resume();
    const err = new Error('请求体过大');
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
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

Run: `cd platform && node --test test/router.test.js test/body.test.js`
Expected: PASS（10 个测试全过：router 8 + body 2）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/http test/router.test.js test/body.test.js
git commit -m "feat(P0): HTTP 路由、响应与 body 解析"
```

---

### Task 5: 认证（scrypt + 服务端会话）

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **1 Critical + 4 Important + 2 Minor**（简报自带的 5 条测试里 **3 条会红**，
> 且「正确密码校验通过」直接红 → **没有人能登录**）。
> 修正六处：
> **①（C5-1 Critical）密码格式字段数自相矛盾 → 没有任何人能登录。**
>      `hashPassword` 产出 **6 段**（`scrypt$N$r$p$salt$hash`），
>      `verifyPassword` 的守卫却要求 **5 段**（`parts.length !== 5`），
>      守卫之后的解构又按 **6 段**写，测试也断言 `parts.length === 5` ——
>      实测 `verifyPassword` 对**所有合法哈希一律返回 false**。
>      连带 `createUser` 把这个哈希写进 `users.password_hash` → 全库口令都无法验证。
>      **规范侧是对的（6 段）**：INTERFACES.md:62 写 `scrypt$N$r$p$saltB64$hashB64`，
>      README 全局约束与设计文档 §7.5 同款 → 改守卫为 `parts.length !== 6`，测试断言改 6。
> **②（I5-1 Important）违反「SQL 边界」全局约束。**
>      会话的 4 处 `db.prepare` 写在 `src/auth/session.js`，而同时建的
>      `src/db/repo/sessions.js` 只剩两个辅助函数。全部 SQL 移入仓储层；
>      `src/auth/session.js` 只保留**与 SQL 无关**的逻辑（token 生成 + SHA-256 哈希 + 过期计算）。
> **③（I5-2 Important）`SELECT *` 把 password_hash 交给调用方。**
>      `listUsers` 一次性返回全体用户 + 全部 scrypt 哈希；P0 的 `/api/me` 手工挑字段所以当下安全，
>      但任何后续 handler 只要 `json(res, 200, user)` 就会把口令哈希发给浏览器。
>      仓储层 SELECT 改成**显式列白名单（不含 password_hash）**，
>      并提供 `toPublicUser(row)` 作为**唯一的对外形状**；所有返回用户的地方强制走它。
>      带哈希的行只允许 `getCredentialsByPhone` 取，且只用于服务端口令校验、绝不进响应。
> **④（I5-3 Important）重复手机号抛原始 SQLite 错误。**
>      `users.phone` 是 UNIQUE，重复注册会抛 `UNIQUE constraint failed: users.phone`
>      → 上层只能回 500，且错误原文带表名列名。P1 契约要求「重复提交 → 409，不静默覆盖」。
>      改为**先查后写**：已存在则抛**领域错误**（`status=409` / `code='PHONE_TAKEN'`）。
> **⑤（I5-4 Important）会话代码零覆盖（「只存 token_hash」无任何断言）。**
>      `password.test.js` 全程不碰数据库，`createSession`/`resolveSession`/`revoke*` **零覆盖**，
>      而 P0 验收标准明确要求「库中只存 token_hash」—— 四份简报里找不到任何断言
>      （与 Task 2「真实 DDL 从未被 apply」是同一型问题）。
>      新增 `platform/test/session.test.js`（**用真实 SQLite 库**）断言 4 条：
>      ① 库里不存在明文 token，`token_hash` 是 64 位 sha256 十六进制；
>      ② 过期 token 解析为 null 且该行被顺手删掉；
>      ③ `revokeAllSessions` 之后该用户的全部会话都失效；
>      ④ 滑动续期（见 ⑥）。
>      另加 `platform/test/users.test.js` 覆盖 ③ 与 ④ 的对外形状：
>      重复手机号 → 409 领域错误；仓储层行与对外形状都**不含 password_hash**。
> **⑥（m5-2 Minor）设计文档 §7.5 要求「绝对过期 + 滑动续期」，简报只实现了绝对过期。**
>      P0 补上**滑动续期**：`resolveSession` 命中有效会话时把 `expires_at` 顺延 `ttlDays`
>      （默认 7 天，`SESSION_TTL_DAYS` 环境变量可覆盖）→ 设计文档与实现不再不符。
> 另（m5-1 Minor）过期判定**两种口径不一致**：`resolveSession` 用 `new Date(...)`，
>      `purgeExpiredSessions` 用字符串比较 —— 不带毫秒的 ISO 串会给出相反结论。
>      统一为「**解析时间戳再比较**」：JS 侧用 `new Date(...)`，
>      SQL 侧用 SQLite 的 `datetime()`（不是字符串比较），`now` 一律归一化成 `new Date(now).toISOString()`。

**Files:**
- Create: `platform/src/auth/password.js`
- Create: `platform/src/auth/session.js`
- Create: `platform/src/db/repo/users.js`
- Create: `platform/src/db/repo/sessions.js`
- Create: `platform/test/password.test.js`
- Create: `platform/test/session.test.js`
- Create: `platform/test/users.test.js`

**Interfaces:**
- Consumes: `openDatabase()`（Task 2）
- Produces:
  - `hashPassword(plain)` → `scrypt$N$r$p$<saltB64>$<hashB64>`（**6 段**）
  - `verifyPassword(plain, stored)` → `boolean`（用 `timingSafeEqual`）
  - `createSession(db, userId, { ttlDays, now })` → `{ token, expiresAt }`（明文 token 只返回一次，库中只存 SHA-256）
  - `resolveSession(db, token, { now, ttlDays })` → `{ userId, expiresAt }` 或 `null`（命中即**滑动续期**）
  - `revokeSession(db, token)` / `revokeAllSessions(db, userId)`
  - `sessionTtlDays()` → 天数（默认 7，`SESSION_TTL_DAYS` 覆盖）
  - `createUser(db, { name, phone, password, mbaStatus, org })` → user 行（**不含 password_hash**）
  - `toPublicUser(row)` → 对外用户形状（**唯一出口**）
  - `getCredentialsByPhone(db, phone)` → 含 `password_hash` 的行（**只用于服务端口令校验**）

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
  // ⛔ 预审修正（C5-1）：6 段 —— scrypt$N$r$p$salt$hash
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.ok(Number.isInteger(Number(parts[1])));
});

test('损坏的存储串不抛异常，返回 false', () => {
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', ''), false);
});
```

`platform/test/session.test.js`（**预审修正 I5-4 新增**：会话代码此前零覆盖，
P0 验收标准要求的「库中只存 token_hash」没有任何断言）：

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
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
} from '../src/auth/session.js';

// 真实迁移目录（platform/db/migrations）：会话表必须真的被建出来。
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sess-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const user = createUser(db, { name: '会话甲', phone: '13900000002', password: 'pw' });
  return { db, close, dataDir, user };
}

test('库里只存 token_hash（SHA-256 十六进制），不存在明文 token', () => {
  const { db, close, dataDir, user } = setup();
  const { token } = createSession(db, user.id);
  const rows = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(user.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.length, 64);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  // 整张表里任何一列都不含明文 token
  for (const row of db.prepare('SELECT * FROM sessions').all()) {
    assert.ok(!Object.values(row).includes(token));
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('过期 token 解析为 null，并顺手删掉该行', () => {
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 1, now });
  assert.ok(resolveSession(db, token, { now: new Date('2026-01-01T12:00:00.000Z'), ttlDays: 1 }));
  const later = new Date('2026-01-03T00:00:00.000Z');
  assert.equal(resolveSession(db, token, { now: later, ttlDays: 1 }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('revokeAllSessions 之后该用户的全部会话都失效', () => {
  const { db, close, dataDir, user } = setup();
  const a = createSession(db, user.id);
  const b = createSession(db, user.id);
  assert.ok(resolveSession(db, a.token));
  assert.ok(resolveSession(db, b.token));
  revokeAllSessions(db, user.id);
  assert.equal(resolveSession(db, a.token), null);
  assert.equal(resolveSession(db, b.token), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('有效会话被访问时滑动续期（expires_at 顺延 ttlDays）', () => {
  // 依据：设计文档 §7.5「绝对过期 + 滑动续期」
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token, expiresAt } = createSession(db, user.id, { ttlDays: 1, now });
  assert.equal(expiresAt, '2026-01-02T00:00:00.000Z');
  const later = new Date('2026-01-01T06:00:00.000Z');
  const got = resolveSession(db, token, { now: later, ttlDays: 1 });
  assert.ok(got);
  assert.equal(got.expiresAt, '2026-01-02T06:00:00.000Z');
  // 库里也确实续期了
  const row = db.prepare('SELECT expires_at FROM sessions').get();
  assert.equal(row.expires_at, '2026-01-02T06:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

`platform/test/users.test.js`（**预审修正 I5-2 / I5-3 新增**）：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser, getUserById, listUsers, toPublicUser } from '../src/db/repo/users.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-users-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

test('重复手机号抛 409 领域错误，不漏原始 SQLite 错误', () => {
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000003', password: 'pw' });
  assert.throws(
    () => createUser(db, { name: '乙', phone: '13900000003', password: 'pw' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PHONE_TAKEN');
      assert.ok(!/UNIQUE constraint/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('仓储层的行与对外形状都不含 password_hash', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900000004', password: 'pw' });
  assert.equal(user.password_hash, undefined);
  assert.equal(getUserById(db, user.id).password_hash, undefined);
  for (const row of listUsers(db)) {
    assert.equal(row.password_hash, undefined);
  }
  const pub = toPublicUser(user);
  assert.equal(pub.password_hash, undefined);
  assert.equal(pub.passwordHash, undefined);
  assert.equal(pub.id, user.id);
  assert.equal(pub.mbaStatus, user.mba_status);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/password.test.js test/session.test.js test/users.test.js`
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
  // ⛔ 预审修正（C5-1）：守卫原来写 5 段，但 hashPassword 产出的是 6 段
  //    （scrypt$N$r$p$salt$hash）→ 合法哈希一律被判为 false，没有人能登录。
  //    规范侧是 6 段（INTERFACES.md:62 / 设计文档 §7.5），守卫与解构必须一致。
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

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
// ⛔ 本文件**不含任何 SQL**（全局约束「所有 SQL 收进 src/db/repo/」）：
//   这里只做与 SQL 无关的事 —— 生成 token、算 SHA-256 哈希、算过期时间。
//   （预审修正 I5-1：原来 4 处 db.prepare 写在这里，仓储层只剩两个辅助函数。）
import { randomBytes, createHash } from 'node:crypto';
import {
  insertSession,
  findSessionByHash,
  touchSessionExpiry,
  deleteSessionByHash,
  deleteSessionsByUser,
} from '../db/repo/sessions.js';

const DEFAULT_TTL_DAYS = 7;

// 会话有效期（天）。默认 7 天，用 SESSION_TTL_DAYS 覆盖。
// 每次调用时读 env（不在模块加载时固化）→ 改 env 立即生效，测试也好构造。
export function sessionTtlDays() {
  const raw = process.env.SESSION_TTL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function expiryFrom(now, ttlDays) {
  return new Date(now.getTime() + ttlDays * 86400_000).toISOString();
}

export function createSession(db, userId, { ttlDays = sessionTtlDays(), now = new Date() } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = expiryFrom(now, ttlDays);
  insertSession(db, {
    tokenHash: tokenHash(token),
    userId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

export function resolveSession(db, token, { now = new Date(), ttlDays = sessionTtlDays() } = {}) {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = findSessionByHash(db, hash);
  if (!row) return null;
  // 过期判定：解析时间戳再比较，**不做字符串比较**
  // （'...T00:00:00Z' 与 '...T00:00:00.000Z' 字符串比较会给出相反结论）
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    deleteSessionByHash(db, hash);
    return null;
  }
  // 滑动续期（设计文档 §7.5「绝对过期 + 滑动续期」）：命中有效会话就顺延一个 ttl
  const expiresAt = expiryFrom(now, ttlDays);
  touchSessionExpiry(db, hash, expiresAt);
  return { userId: row.user_id, expiresAt };
}

export function revokeSession(db, token) {
  if (!token) return 0;
  return deleteSessionByHash(db, tokenHash(token));
}

export function revokeAllSessions(db, userId) {
  return deleteSessionsByUser(db, userId);
}
```

- [ ] **Step 5: 创建 src/db/repo/users.js 与 src/db/repo/sessions.js**

`platform/src/db/repo/users.js`：

```javascript
// src/db/repo/users.js — 用户仓储
// 依据：设计文档 §7.2。所有 SQL 收进仓储层，handler 内禁止裸 SQL。
//
// ⛔ 预审修正（I5-2）：SELECT 一律**显式列白名单，不含 password_hash**。
//    原来用 SELECT *，listUsers 一次返回全体用户 + 全部 scrypt 哈希 ——
//    P0 的 /api/me 手工挑字段所以当下安全，但任何后续 handler 只要
//    `json(res, 200, user)` 就会把口令哈希发给浏览器。
//    带哈希的行只允许 getCredentialsByPhone 取，且只用于服务端口令校验。
const PUBLIC_COLUMNS = 'id, name, phone, mba_status, org, is_superadmin, active, created_at';

import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../auth/password.js';

/**
 * 对外用户形状（**唯一出口**）：字段转驼峰，绝不带 password_hash。
 * 所有要把用户放进 HTTP 响应的地方都必须走它。
 */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    mbaStatus: row.mba_status,
    org: row.org ?? null,
    isSuperadmin: row.is_superadmin === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function createUser(db, { name, phone, password, mbaStatus = 'other', org = null }) {
  // ⛔ 预审修正（I5-3）：重复手机号**先查后写**，抛领域错误（409 / PHONE_TAKEN）。
  //    原来直接 INSERT，让原始 SQLite 错误 `UNIQUE constraint failed: users.phone`
  //    漏到 HTTP 层 —— 既只能回 500，又把表名列名暴露给客户端。
  //    查重不看 active：停用用户的手机号也不能被再次注册。
  if (findUserByPhone(db, phone)) {
    const err = new Error('该手机号已注册');
    err.status = 409;
    err.code = 'PHONE_TAKEN';
    throw err;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
  ).run(id, name, phone, hashPassword(password), mbaStatus, org, now);
  return getUserById(db, id);
}

export function getUserById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND active = 1`).get(id) ?? null;
}

/** 不看 active —— 唯一性查重用（停用用户的手机号也不能被再次注册）。 */
export function findUserByPhone(db, phone) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE phone = ?`).get(phone) ?? null;
}

export function getUserByPhone(db, phone) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE phone = ? AND active = 1`).get(phone) ?? null;
}

/**
 * ⛔ 唯一会取出 password_hash 的地方 —— 只用于服务端口令校验（登录），
 *    绝不进任何 HTTP 响应。对外一律用 toPublicUser(row)。
 */
export function getCredentialsByPhone(db, phone) {
  return db
    .prepare('SELECT id, password_hash, active FROM users WHERE phone = ?')
    .get(phone) ?? null;
}

export function listUsers(db, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE active = 1 ORDER BY created_at LIMIT ? OFFSET ?`)
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
// 依据：设计文档 §7.5 + 全局约束「所有 SQL 收进 src/db/repo/」。
// ⛔ 预审修正（I5-1）：会话的全部 SQL 从 src/auth/session.js 搬到这里。
// ⛔ 库里只存 token_hash（SHA-256 十六进制），**不存明文 token**。
export function insertSession(db, { tokenHash, userId, createdAt, expiresAt }) {
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(tokenHash, userId, createdAt, expiresAt);
}

export function findSessionByHash(db, tokenHash) {
  return db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) ?? null;
}

/** 滑动续期：把 expires_at 顺延（设计文档 §7.5） */
export function touchSessionExpiry(db, tokenHash, expiresAt) {
  return db
    .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(expiresAt, tokenHash).changes;
}

export function deleteSessionByHash(db, tokenHash) {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
}

export function deleteSessionsByUser(db, userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function countActiveSessions(db, userId, { now = new Date() } = {}) {
  // ⛔ 预审修正（m5-1）：过期判定**解析时间戳再比较**，不做字符串比较。
  //    字符串比较下 '...T00:00:00Z' 与 '...T00:00:00.000Z' 会给出相反结论。
  //    SQL 侧用 SQLite 的 datetime()（与 JS 侧 new Date(...) 同一口径）。
  return db
    .prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND datetime(expires_at) > datetime(?)',
    )
    .get(userId, new Date(now).toISOString()).n;
}

export function purgeExpiredSessions(db, { now = new Date() } = {}) {
  return db
    .prepare('DELETE FROM sessions WHERE datetime(expires_at) <= datetime(?)')
    .run(new Date(now).toISOString()).changes;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/password.test.js test/session.test.js test/users.test.js`
Expected: PASS（11 个测试全过：password 5 + session 4 + users 2）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/auth src/db/repo test/password.test.js test/session.test.js test/users.test.js
git commit -m "feat(P0): scrypt 密码哈希与服务端会话"
```

---

### Task 6: capability + assignment 权限模型

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **2 Critical + 3 Important + 1 Minor**（简报自带的 6 条测试里 **4 条会红**，
> 且「没有授权时能力为 false」直接抛 `no such column: rc.role_key`
> → **普通用户的一切权限判定全变 500**）。
> 修正六处：
> **①（C6-1 Critical）SQL 用了 schema 里不存在的列 → 权限判定对任何普通用户都抛错。**
>      简报写 `JOIN role_capabilities rc ON rc.role_key = ur.role_key`，
>      而 `platform/db/migrations/001_init.sql:37-41` 的列名是 **`role_id`**
>      （`role_id TEXT NOT NULL REFERENCES roles(key)`）。
>      `can()` 是全项目**唯一**权限入口（P1–P6 全部依赖），它对非超管一律抛错 → HTTP 层全变 500。
>      同一份 Task 7 的 seed.js 写的是对的（`INSERT OR IGNORE INTO role_capabilities (role_id, capability)`）
>      → 这是 Task 6 的单点笔误。改为 `rc.role_id`。
> **②（C6-2 Critical）scopeClause 占位符数与 params 数不一致 + 语义自相矛盾。**
>      原实现 SQL 里 3 个占位符却推了 4 个值 → `column index out of range`；
>      去掉多出的 param 后能执行，但**恒返回空集** —— `a.scope_id = t.id` 拿的是**行主键**，
>      与传入的 `scopeId` 无关。语义被混成两件事：「按行过滤」vs「按资源过滤」。
>      **语义写死（本 Task 定稿）**：`scopeClause` 只做**行级过滤** ——
>      把用户的授权映射到资源表的每一行；「用户对某一个具体资源有没有权限」
>      是 `can()` 的职责（走 ctx），不是 `scopeClause` 的。
>      模式一（行级，推荐）：传 scopeType + alias → `params [userId, capability, scopeType]`；
>      模式二（单资源）：传 scopeType + scopeId（不传 alias）→ `params [userId, capability, scopeType, scopeId]`；
>      都不传 → 只认 global 授权 → `params [userId, capability]`。
>      **alias 与 scopeId 互斥**（同时给 → 抛错，fail-fast，不静默挑一个）；
>      **给了 scopeType 但 alias / scopeId 都没给 → 抛错**；
>      **params 个数必须永远等于 SQL 里的占位符个数**（这次出事的根因）。
>      配套用例改成**真执行 SQL**：造两张资源行（一张有权、一张无权），
>      用 `db.prepare('SELECT id FROM <表> t WHERE ' + sql).all(...params)` 断言结果集，
>      不再只断言 `sql.includes('?')`（那是恒真条件 —— 实现是坏的时候用例照样 PASS）。
> **③（I6-1 Important）listAssignments 签名与跨阶段契约冲突。**
>      契约（INTERFACES.md:76，唯一事实来源）是 `listAssignments(db, { userId, capability })`，
>      简报写的是 `listAssignments(db, userId, capability)` →
>      P1–P6 按契约调用会把对象当 userId 绑定（node:sqlite 抛错/查不到）。
>      统一为**契约形式**（**不改 INTERFACES.md** —— 改契约 = 后面所有阶段都要改）。
> **④（I6-2 Important）Files 声明要建 `src/db/repo/assignments.js`，但没有任何一步创建它。**
>      assignments 的 SQL 全写在 `src/auth/permissions.js` → 既违反「SQL 收进 src/db/repo/」，
>      又留下一份永久缺失的承诺文件（P0 计划的目录树也列了它）。
>      补一步：新建 `platform/src/db/repo/assignments.js`（grant / revoke / list 三条 SQL），
>      `src/auth/permissions.js` 改为 import 仓储层；**Files 段落与 P0 目录树两边同步**。
> **⑤（I6-3 Important）Step 1 的「角色能力命中即为 true」用例没有任何断言。**
>      插完数据就 `close()` → 恒真用例，中间任何一次"跑测试确认通过"都无法证明角色能力这条路径。
>      **Step 1 直接写带断言的版本**（断言 `can()` 对有该角色能力的用户返回 true）；
>      原来的 Step 5「修正测试」改为「**核对列名与 `001_init.sql` 一致**」的说明步骤。
> **⑥（m6-1 Minor）`user.active` 判断依赖调用方传的对象形状。**
>      `if (user.active === 0) return false;` —— 传入 `{ id, is_superadmin: 1 }`（无 `active` 字段）时，
>      被停用的用户会被判为有权。改为 `if (user.active !== undefined && !user.active) return false;`
> 另：**上级作用域不隐式下推**（edition 授权不自动覆盖其下的 task_package）
>      —— 写进代码注释与规则文档（本计划 Global Constraints 的「作用域」一行）。
> 测试从 6 条增至 **12 条**。

**Files:**
- Create: `platform/src/auth/permissions.js`
- Create: `platform/src/db/repo/assignments.js`
- Create: `platform/test/permissions.test.js`

**Interfaces:**
- Consumes: `openDatabase()`（Task 2）、迁移里的 `capabilities` / `roles` / `role_capabilities` / `assignments` / `user_roles` 表（Task 2）
- Produces:
  - `can(user, capability, ctx, db)` → `boolean`（**唯一判定入口**）
  - `ctx` 形如 `{ scopeType, scopeId }`
  - `grantAssignment(db, { userId, capability, scopeType, scopeId, grantedBy })`
  - `revokeAssignment(db, assignmentId)`
  - `listAssignments(db, { userId, capability })`（**契约形式**，INTERFACES.md:76）
  - `scopeClause(userId, capability, { scopeType, scopeId, alias })` → `{ sql, params }`
    ——生成 WHERE 片段（**必须在 SQL 层过滤，不能先查全量再在 JS 里 filter**）；
    `alias` 与 `scopeId` 互斥，给错组合直接抛错

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
import { can, grantAssignment, listAssignments, scopeClause } from '../src/auth/permissions.js';
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

/** 造两张资源行：r_ok 有权、r_no 无权（用来真跑 scopeClause 生成的 SQL） */
function seedResources(db) {
  db.exec('CREATE TABLE fake_resources (id TEXT PRIMARY KEY, title TEXT)');
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('r_ok', '有权'), ('r_no', '无权')");
}

test('超级管理员拥有一切能力', () => {
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('超管标志两种形状都认（仓储行 / toPublicUser 的驼峰形状）', () => {
  // ⛔ 跨 Task 接口缝：can() 只认 snake_case 时，调用方传 toPublicUser() 的
  //    驼峰形状会让**超管静默失去全部权限**（症状：管理员登进去什么都点不动）。
  //    can() 是全项目唯一权限入口，必须两种形状都认。
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, isSuperadmin: true, active: true }, 'score:write', null, db), true);
  // 反向：非超管的驼峰形状不能被误判成超管
  assert.equal(
    can({ id: user.id, isSuperadmin: false, active: true }, 'score:write', null, db),
    false,
  );
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
  // ⛔ 预审修正（I6-3）：原用例插完数据就 close()，**一条断言都没有** ——
  //    实现坏掉时它照样 PASS，"跑测试确认通过"证明不了角色能力这条路径。
  const { db, close, dataDir, user } = setup();
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
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

test('listAssignments 按契约签名（对象参数）返回该用户该能力的授权', () => {
  // ⛔ 预审修正（I6-1）：契约是 listAssignments(db, { userId, capability })
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  const rows = listAssignments(db, { userId: user.id, capability: 'score:write' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].scope_type, 'global');
  assert.equal(listAssignments(db, { userId: user.id, capability: 'team:read' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 行级过滤真跑 SQL：有权那行在结果里、无权那行不在', () => {
  // ⛔ 预审修正（C6-2）：原用例只断言 sql.includes('?')（恒真）→ 实现坏掉也 PASS。
  //    现在真执行 SQL：造两张资源行，一张有权一张无权。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), ['r_ok']);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 单资源模式：scopeId 命中才放行', () => {
  // 模式二是**单资源守卫**：它回答「用户对 scopeId 这个资源有没有权限」，
  // 用法是配合 `WHERE t.id = ?` 一起用（P1 的单条读取接口就是这种用法），
  // 它本身不是行过滤器 —— 行过滤用模式一（alias）。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const allowed = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_ok' });
  const denied = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_no' });
  const ok = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + allowed.sql)
    .all('r_ok', ...allowed.params);
  const no = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + denied.sql)
    .all('r_no', ...denied.params);
  assert.deepEqual(ok.map((r) => r.id), ['r_ok']);
  assert.deepEqual(no.map((r) => r.id), []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 的占位符个数恒等于 params 个数', () => {
  // ⛔ 预审修正（C6-2）：原实现 SQL 3 个占位符却推 4 个值 → column index out of range。
  const { db, close, dataDir, user } = setup();
  const modes = [
    scopeClause(user.id, 'score:write'),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' }),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }),
  ];
  for (const { sql, params } of modes) {
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(placeholders, params.length);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause：alias 与 scopeId 互斥，同时给直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias: 't', scopeId: 'tp_1' }),
    /互斥/,
  );
});

test('scopeClause：给了 scopeType 却没给 alias / scopeId 直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package' }),
    /alias|scopeId/,
  );
});

test('停用用户判 false；没有 active 字段的精简对象不当成停用', () => {
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 ——
  //    传入 { id, is_superadmin: 1 }（无 active 字段）时，被停用的用户会被判为有权。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0 }, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0, active: 0 }, 'score:write', null, db), false);
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
// ⛔ 本文件**不含裸 SQL**：assignments 的 SQL 收在 src/db/repo/assignments.js
//    （预审修正 I6-2 —— Files 段落声明了这个文件，却没有任何一步创建它）。
import { randomUUID } from 'node:crypto';
import {
  insertAssignment,
  deleteAssignmentById,
  listAssignmentsByUserAndCapability,
} from '../db/repo/assignments.js';

export function grantAssignment(
  db,
  { userId, capability, scopeType, scopeId = null, grantedBy = null },
) {
  const id = randomUUID();
  insertAssignment(db, {
    id,
    userId,
    capability,
    scopeType,
    scopeId,
    grantedBy,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export function revokeAssignment(db, assignmentId) {
  return deleteAssignmentById(db, assignmentId);
}

// 契约（INTERFACES.md:76）：listAssignments(db, { userId, capability })
// ⛔ 预审修正（I6-1）：原来写成 (db, userId, capability) —— P1–P6 按契约调用
//    会把对象当 userId 绑定（node:sqlite 抛错/查不到）。统一为契约形式。
export function listAssignments(db, { userId, capability }) {
  return listAssignmentsByUserAndCapability(db, userId, capability);
}

function roleGrants(db, userId, capability) {
  return db
    .prepare(
      `SELECT 1 FROM user_roles ur
       JOIN role_capabilities rc ON rc.role_id = ur.role_key
       WHERE ur.user_id = ? AND rc.capability = ?
       LIMIT 1`,
    )
    .get(userId, capability) !== undefined;
}

export function can(user, capability, ctx = null, db = null) {
  if (!user) return false;
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 —— 传入没有 active 字段的
  //    精简对象 { id, is_superadmin: 1 } 时，被停用的用户会被判为有权。
  //    只有**明确带 active 且为假**才拒绝。
  if (user.active !== undefined && !user.active) return false;
  // ⚠️ 超管标志**同时认两种形状**：仓储层行是 `is_superadmin: 0|1`（snake_case），
  //    toPublicUser() 的对外形状是 `isSuperadmin: boolean`（camelCase）。
  //    can() 是全项目**唯一**权限入口（P1–P6 全部依赖）。若只认一种形状，
  //    调用方传错形状会让**超管静默失去全部权限** —— 症状是"管理员登进去
  //    什么都点不动"，极难定位。多认一种形状，把这类静默降级从根上消除。
  //    （失败方向是 fail-closed：认不出超管只会少给权限，不会多给。）
  if (user.is_superadmin === 1 || user.isSuperadmin === true) return true;
  if (!db) return false;

  // 角色能力
  if (roleGrants(db, user.id, capability)) return true;

  // 资源级授权
  const rows = listAssignments(db, { userId: user.id, capability });
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
 *
 * 语义（2026-10-20 预审修正 C6-2 定稿）：
 *   scopeClause 只做**行级过滤** —— 把用户的授权映射到资源表的每一行。
 *   「用户对某一个具体资源有没有权限」是 can() 的职责（走 ctx），不是 scopeClause 的。
 *
 *   模式一（行级，推荐）：传 scopeType + alias
 *     SQL  : ... AND (a.scope_type = 'global' OR (a.scope_type = ? AND a.scope_id = <alias>.id))
 *     params: [userId, capability, scopeType]
 *   模式二（单资源）：传 scopeType + scopeId（不传 alias）
 *     SQL  : ... AND (a.scope_type = 'global' OR (a.scope_type = ? AND a.scope_id = ?))
 *     params: [userId, capability, scopeType, scopeId]
 *     ⚠️ 模式二是**单资源守卫**（回答「用户对 scopeId 这个资源有没有权限」），
 *        用法是配合 `WHERE t.id = ?` 一起用；它本身不是行过滤器 —— 行过滤用模式一。
 *   都不传：只认 global 授权
 *     params: [userId, capability]
 *
 * ⚠️ alias 与 scopeId **互斥**：同时给 → 抛错（fail-fast，不静默挑一个）。
 * ⚠️ 给了 scopeType 但 alias 与 scopeId 都没给 → 抛错（fail-fast）。
 * ⚠️ **params 的个数必须永远等于 SQL 里的占位符个数** —— 2026-10-20 预审实测：
 *    原实现 SQL 3 个占位符却推了 4 个值 → `column index out of range`。
 * ⚠️ 上级作用域**不隐式下推**：edition 授权不自动覆盖其下的 task_package
 *    （要覆盖必须显式再授权一条 task_package 的记录）。
 */
export function scopeClause(userId, capability, { scopeType, scopeId, alias = null } = {}) {
  const hasScopeId = scopeId !== undefined && scopeId !== null;
  if (alias && hasScopeId) {
    throw new Error('scopeClause：alias 与 scopeId 互斥，只能给一个');
  }
  if (scopeType && !alias && !hasScopeId) {
    throw new Error('scopeClause：给了 scopeType 就必须给 alias（行级）或 scopeId（单资源）');
  }
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    // alias 是 SQL 标识符（会被拼进 SQL），必须限制成安全的标识符字符
    throw new Error(`scopeClause：alias 必须是合法 SQL 标识符：${alias}`);
  }

  const params = [userId, capability];
  const scopeCond = [];

  if (scopeType) {
    if (alias) {
      scopeCond.push(`(a.scope_type = ? AND a.scope_id = ${alias}.id)`);
      params.push(scopeType);
    } else {
      scopeCond.push(`(a.scope_type = ? AND a.scope_id = ?)`);
      params.push(scopeType, scopeId);
    }
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

- [ ] **Step 4: 创建 src/db/repo/assignments.js**

> ⛔ 预审修正（I6-2）：这个文件原本**只出现在 Files 段落与目录树里，没有任何一步创建它**，
> 而 assignments 的 SQL 全写在 `src/auth/permissions.js` → 既违反「SQL 收进 src/db/repo/」，
> 又留下一份永久缺失的承诺文件。这里补上。

`platform/src/db/repo/assignments.js`：

```javascript
// src/db/repo/assignments.js — 授权仓储
// 依据：设计文档 §7.2 + 全局约束「所有 SQL 收进 src/db/repo/」。
export function insertAssignment(
  db,
  { id, userId, capability, scopeType, scopeId = null, grantedBy = null, createdAt },
) {
  db.prepare(
    `INSERT INTO assignments (id, user_id, capability, scope_type, scope_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, capability, scopeType, scopeId, grantedBy, createdAt);
}

export function deleteAssignmentById(db, id) {
  return db.prepare('DELETE FROM assignments WHERE id = ?').run(id).changes;
}

export function listAssignmentsByUserAndCapability(db, userId, capability) {
  return db
    .prepare(
      `SELECT id, user_id, capability, scope_type, scope_id, granted_by, created_at
         FROM assignments WHERE user_id = ? AND capability = ?`,
    )
    .all(userId, capability);
}
```

- [ ] **Step 5: 确认 user_roles 表已在 001_init.sql 中**

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

- [ ] **Step 6: 核对列名与 001_init.sql 一致**

⛔ 预审修正（I6-3）：原 Step 5 是「修正测试里的角色用例」—— 但带断言的版本现在**直接写在 Step 1**
（`test/permissions.test.js` 的「角色能力命中即为 true」），本步不再改测试代码。
本步改成**核对列名**（C6-1 的根因就是列名笔误，必须当场对着 DDL 核一遍）：

```bash
cd platform && node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('./data/app.db');
for (const t of ['role_capabilities','user_roles']) {
  console.log(t, db.prepare('PRAGMA table_info(' + t + ')').all().map(r => r.name).join(','));
}
db.close();
"
```
Expected: `role_capabilities role_id,capability` ｜ `user_roles user_id,role_key`

> `permissions.js` 里角色能力查询的 JOIN 条件必须是 `rc.role_id = ur.role_key`
> （`role_capabilities.role_id` 与 `roles.key`、`user_roles.role_key` 与 `roles.key` 指的是同一个角色键）。
> 写成 `rc.role_key` 会得到 `no such column: rc.role_key` → `can()` 对非超管一律抛错。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/permissions.test.js`
Expected: PASS（13 个测试全过）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/auth/permissions.js src/db/repo/assignments.js test/permissions.test.js
git commit -m "feat(P0): capability + assignment 权限模型与 SQL 层行级过滤"
```

---

### Task 7: 静态文件服务、前端骨架与服务器入口

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **2 Critical + 4 Important + 4 Minor**。
> 注意：简报自带的 4 条测试**全绿** —— 因为**一条都没碰登录态与静态文件**，
> 下面两个 Critical 全都测不出来（"测试全过"≠"主功能可用"，这正是预审存在的意义）。
> **② 波及 P3**：P3 计划用 `hk_session=${createSession(...).token}` 写测试，
> P3 旗舰用例「GET /api/leaderboard/:stageId?scope=rank 返回 A 榜」会整片 500。
> 修正十处：
> **①（C7-1 Critical）目录穿越防护缺路径分隔符边界 → 可读出 web 目录的兄弟目录。**
>      原判断 `target.startsWith(normalize(webDir))` **没有分隔符边界** ——
>      `'/…/web-secret/passwd'.startsWith('/…/web')` 为真 → 预审实测 **200 + 兄弟目录文件内容**。
>      改为**三重防护**：① 用 `resolve` + **带分隔符的前缀比较**
>      （`target !== root && !target.startsWith(root + sep)` → 拒绝）；
>      ② `rel` 先 `decodeURIComponent`，并显式拒绝含 `..` 的路径段（`%2e%2e` 也挡住）；
>      ③ `rel` 以 `/` 开头时用 `resolve(root, '.' + rel)`（`.` 前缀）避免被当成绝对路径。
>      补 1 条测试：构造 `web/` 的兄弟目录 `web-secret/`，请求 `/../web-secret/passwd` 必须拿不到内容。
> **②（C7-2 Critical）已登录用户访问 `/api/me` 返回 500。**
>      Task 5 的 `resolveSession` 返回 `{ userId, expiresAt }`，
>      Task 7 却读 `session.user_id`（undefined）→ node:sqlite 绑定 undefined 直接抛错
>      （`TypeError: Provided value cannot be bound to SQLite parameter 1.`）。
>      契约 INTERFACES.md:67 就是 `{ userId, expiresAt }` → 改为 `session.userId`。
>      补 1 条测试：**带有效 session cookie → `/api/me` 返回 200 且 body 含当前用户**。
> **③（I7-1 Important）P0 没有登录接口，也从不下发 Session Cookie。**
>      P0 README 宣称的交付物是「**能登录的空系统**」，但 Task 7 只注册 `/api/health` 与 `/api/me`，
>      预审实测 `POST /api/auth/login` → 404、无 `Set-Cookie`；
>      前端登录视图 `api.post('/api/auth/login', {...})` 必然 404；
>      服务端从不调用 `createSession` → Task 5 产出的会话能力**没有任何调用方**；
>      设计文档 §7.5 要求的 `HttpOnly + SameSite=Lax + Secure(生产) + Path=/` 全项目无处落地。
>      补两条路由：`POST /api/auth/login`（按手机号取用户 → `verifyPassword` → `createSession` → 下发
>      `Set-Cookie: hk_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttlSeconds>`，生产加 `Secure`；
>      密码错 / 用户不存在**一律 401**，不区分二者，避免用户枚举）、
>      `POST /api/auth/logout`（`revokeSession` + 清 Cookie）。
>      补 2 条测试：① 正确手机号+密码登录 → 200 + 有 `Set-Cookie` + 响应里不含口令哈希等敏感信息；
>      ② 错误密码 → 401 + **不**下发 Cookie。
> **④（I7-2 Important）种子脚本用硬编码默认口令创建超管。**
>      `process.env.ADMIN_PASSWORD || 'change-me-now'` —— 典型的「缺省兜底掩盖缺失」：
>      没配环境变量就用一个写死在代码里的公开口令当组委会超管口令（预审实测已打印出来），
>      P6 之后这套脚本要在公网机器上跑。与项目原则「校验不过就拒绝启动，绝不降级为默认值」冲突。
>      改为**不兜底**：没有 `ADMIN_PASSWORD` → `console.error` 明确报错 + `process.exit(1)`，**不创建任何账号**；
>      创建成功后只打印账号与「请立即修改密码」的提示（口令本身绝不兜底，也不再打印到 stdout）。
> **⑤（I7-3 Important）500 响应把内部错误原文回给客户端。**
>      预审实测那条 500 直接带出了 `Provided value cannot be bound to SQLite parameter 1.`，
>      SQLite 错误还会带表名列名；另外 `err.code` 取的是 Node 错误码（`ERR_INVALID_ARG_TYPE`）而非领域码。
>      改为：`status >= 500` 时对外只回 `{ error: { code: 'INTERNAL', message: '服务内部错误' } }`，
>      详细信息只进 `console.error`；4xx 的领域错误统一用约定的 `code` 字段（Node 的 `ERR_*` 不外泄）。
> **⑥（I7-4 Important）handler 协议只能返回 200。**
>      成功状态码无法表达 201/204，P1 起大量「POST 创建资源 → 201 Created」实现不了。
>      约定 handler 可返回 `{ status, body }`（可选 `headers` 附加响应头）：
>      返回 `undefined` → 视为 200（保持现有行为）；返回 `{ status, body }` → 按返回的状态码与 body 响应。
>      同步写进 INTERFACES.md 的 handler 说明（**只加这一句，不改其他契约**）。
> **⑦（m7-1 Minor）`server.listen(port)` 默认绑 0.0.0.0，但启动日志写 `http://127.0.0.1:8080`。**
>      改为显式 `server.listen(port, '127.0.0.1')`（云主机部署时再改 `0.0.0.0`），日志与实际绑定一致。
> **⑧（m7-2 Minor）`parseCookie` 对 cookie 值直接 `decodeURIComponent`，畸形编码抛 URIError。**
>      改为 try/catch，失败时原样透传该 cookie 值。
> **⑨（m7-3 Minor）前端 `api.js` 的 `subscribe()`（SSE）指向的端点整个 P0–P6 都没实现。**
>      **不在本期实现**，但在 `web/api.js` 的 `subscribe()` 上加注释标明「端点在 P2 启用；P0/P1 调用会 404」，
>      并把 P0 计划目录树里的 `src/http/sse.js` 标注为 P2 建 —— 不留一个必然 404 却没有说明的接口。
> **⑩（m7-4 Minor）P0-2 验收文案与实际输出不符。**
>      验收标准写「启动报『权重合计 = 1.05』」，实现实际输出「权重合计 = 1.1000，必须等于 1（100%）」
>      （`toFixed(4)` + 后缀）。验收口径改为「报错里出现『权重合计』且进程以**非 0 退出码**退出」。
> 测试从 4 条增至 **9 条**。

**Files:**
- Create: `platform/src/http/static.js`
- Create: `platform/src/server.js`
- Create: `platform/scripts/seed.js`
- Create: `platform/test/server.test.js`
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
- Consumes: Task 2 `openDatabase`、Task 3 `loadRules`、Task 4 `createRouter/json/error`、Task 5 `createSession/resolveSession/revokeSession/verifyPassword`、Task 6 `can`、Task 5 `toPublicUser`
- Produces:
  - `serveStatic(webDir, req, res)` → `boolean`（命中返回 true）
  - `createApp({ db, rules, webDir })` → `{ router, handle(req, res) }`——可测的请求处理入口
  - 路由：`GET /api/health` ｜ `GET /api/me` ｜ `POST /api/auth/login` ｜ `POST /api/auth/logout`
  - **handler 返回约定**：返回 `undefined` → 200；返回 `{ status, body }`（可选 `headers`）→ 按返回值应答
  - `src/server.js` 进程入口：加载配置 → 校验 → 建库 → 迁移 → 装配 → 监听
  - 前端：`api.js` 导出 `{ get, post, patch, del, subscribe }`；`api.demo.js` 导出同名接口的 localStorage 实现

- [ ] **Step 1: 写失败的测试**

`platform/test/server.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-srv-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  // web/ 旁边造一个兄弟目录 web-secret/ —— 用来验证目录穿越防护（C7-1）
  const webRoot = mkdtempSync(join(tmpdir(), 'hks-web-'));
  const webDir = join(webRoot, 'web');
  mkdirSync(webDir, { recursive: true });
  mkdirSync(join(webRoot, 'web-secret'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(webRoot, 'web-secret', 'passwd'), 'TOP-SECRET');
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, webRoot, app };
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
    () => createApp({ db, rules: { scoring: { initial: { dimensions: [{ weight: 0.5 }] } } }, webDir: '/tmp' }),
    /规则|校验/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('正确手机号+密码登录返回 200 并下发 Session Cookie', async () => {
  // ⛔ 预审修正（I7-1）：P0 原本**没有登录接口**，README 宣称的「能登录的空系统」不成立。
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000001', password: 'pw123' });
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000001', password: 'pw123' },
  });
  assert.equal(res.status, 200);
  const cookie = res.headers['Set-Cookie'];
  assert.ok(cookie, '必须下发 Set-Cookie');
  assert.match(cookie, /^hk_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);
  // 响应体不得含口令哈希等敏感信息
  assert.equal(res.body.includes('scrypt$'), false);
  assert.equal(res.body.includes('password'), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('密码错误返回 401 且不下发 Cookie（用户不存在同码，不泄露用户是否存在）', async () => {
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000002', password: 'pw123' });
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000002', password: 'wrong' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers['Set-Cookie'], undefined);
  const missing = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13900000009', password: 'pw123' },
  });
  assert.equal(missing.status, 401);
  assert.equal(
    JSON.parse(missing.body).error.code,
    JSON.parse(res.body).error.code,
    '用户不存在与密码错必须同一个错误码（防用户枚举）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('带有效 session cookie 的 /api/me 返回 200 且 body 含当前用户', async () => {
  // ⛔ 预审修正（C7-2）：原来读 session.user_id（undefined）→ node:sqlite 绑定 undefined 抛错 → 500。
  const { db, close, dataDir, app } = setup();
  const user = createUser(db, { name: '甲', phone: '13800000003', password: 'pw123' });
  const { token } = createSession(db, user.id);
  const res = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.name, '甲');
  assert.equal(body.user.password_hash, undefined);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('畸形百分号编码的 URL 返回 400，不抛异常', async () => {
  // ⛔ 预审修正（C4-2）：畸形编码不能打死进程，也不能被当成 404。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/teams/%E0%A4%A');
  assert.equal(res.status, 400);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('目录穿越拿不到 web 兄弟目录的内容', async () => {
  // ⛔ 预审修正（C7-1）：'/…/web-secret/passwd'.startsWith('/…/web') 为真 → 兄弟目录可被读出。
  const { db, close, dataDir, webRoot, app } = setup();
  const res = await call(app, 'GET', '/../web-secret/passwd');
  assert.notEqual(res.status, 200);
  assert.equal(res.body.includes('TOP-SECRET'), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
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
import { resolve, sep, extname } from 'node:path';
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
  let rel;
  try {
    rel = decodeURIComponent(url === '/' ? '/index.html' : url);
  } catch {
    // 畸形百分号编码 → 不当静态资源处理
    return false;
  }
  // ⛔ 预审修正（C7-1）：路径段里显式拒绝 '..'。
  //    必须在 decode **之后**判，否则 %2e%2e 能绕过。
  if (rel.split('/').some((seg) => seg === '..')) return false;

  // 防目录穿越（三重）：
  // ① rel 以 '/' 开头时用 '.' 前缀，resolve 不会把它当成绝对路径
  // ② 前缀比较必须带分隔符边界：'/x/web-secret'.startsWith('/x/web') 为真，
  //    只比前缀会把 web 的**兄弟目录**也放进来（预审实测 200 + 兄弟目录文件内容）
  const root = resolve(webDir);
  const relPath = rel.startsWith('/') ? rel : `/${rel}`;
  const target = resolve(root, `.${relPath}`);
  if (target !== root && !target.startsWith(root + sep)) return false;

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
import { loadRules, validateRules } from './config.js';
import { createRouter } from './http/router.js';
import { json, error } from './http/respond.js';
import { readJsonBody } from './http/body.js';
import { serveStatic } from './http/static.js';
import { createSession, resolveSession, revokeSession } from './auth/session.js';
import { can } from './auth/permissions.js';
import { verifyPassword } from './auth/password.js';
import { getUserById, getCredentialsByPhone, toPublicUser } from './db/repo/users.js';

const here = dirname(fileURLToPath(import.meta.url));

// 会话 Cookie（设计文档 §7.5）：HttpOnly + SameSite=Lax + Path=/ + Secure(生产)
function sessionCookie(token, maxAge, secure) {
  const parts = [
    `hk_session=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 畸形百分号编码（如 '%E0%A4%A'）会让 decodeURIComponent 抛 URIError。
 * router 内部已把这类段视为「不匹配」，这里再判一次是为了把
 * 「请求本身非法（400）」与「没这个接口（404）」区分开。
 */
function hasMalformedEncoding(path) {
  try {
    decodeURIComponent(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * 领域错误码：Node 内置错误的 .code（如 ERR_INVALID_ARG_TYPE）不是领域码，
 * 不能原样回给客户端 —— 那会暴露内部实现细节。
 */
function domainCode(err, fallback) {
  const code = err && err.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) && !code.startsWith('ERR_')) {
    return code;
  }
  return fallback;
}

export function createApp({ db, rules, webDir }) {
  // fail-fast：规则不合法直接拒绝启动
  const errors = validateRules(rules);
  if (errors.length) {
    throw new Error(`规则配置校验失败，拒绝启动：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const router = createRouter();
  // 生产环境 Cookie 加 Secure；开发环境不加（http://127.0.0.1 会被浏览器拒收）
  const secureCookies = process.env.NODE_ENV === 'production';

  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));

  router.add('GET', '/api/me', async ({ user }) => {
    if (!user) {
      const e = new Error('未登录');
      e.status = 401;
      e.code = 'UNAUTHENTICATED';
      throw e;
    }
    return { user: toPublicUser(user) };
  });

  // ⛔ 预审修正（I7-1）：P0 原本**没有登录接口** → README 宣称的「能登录的空系统」不成立，
  //    Task 5 产出的 createSession 也没有任何调用方。补上登录/登出。
  router.add('POST', '/api/auth/login', async ({ body }) => {
    const phone = String(body?.phone ?? '').trim();
    const password = String(body?.password ?? '');
    const cred = getCredentialsByPhone(db, phone);
    // 用户不存在与密码错误返回**同一个**错误码 → 避免用户枚举
    const ok = !!cred && cred.active === 1 && verifyPassword(password, cred.password_hash);
    if (!ok) {
      const e = new Error('手机号或密码不正确');
      e.status = 401;
      e.code = 'INVALID_CREDENTIALS';
      throw e;
    }
    const { token, expiresAt } = createSession(db, cred.id);
    const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return {
      status: 200,
      body: { user: toPublicUser(getUserById(db, cred.id)) },
      headers: { 'Set-Cookie': sessionCookie(token, maxAge, secureCookies) },
    };
  });

  router.add('POST', '/api/auth/logout', async ({ sessionToken }) => {
    if (sessionToken) revokeSession(db, sessionToken);
    return {
      status: 200,
      body: { ok: true },
      headers: { 'Set-Cookie': sessionCookie('', 0, secureCookies) },
    };
  });

  async function handle(req, res) {
    const url = req.url || '/';
    if (url.startsWith('/api/')) {
      try {
        // ⛔ 预审修正（C4-2）：router.match 必须**在 try 块内**。
        //    原来它在 try 之外 → 畸形百分号编码抛出的 URIError 越过 catch
        //    → Node 默认未捕获异常退出 → 整个服务器进程死亡。
        const match = router.match(req.method, url);
        if (!match) {
          // 畸形 URL 编码 → 400（请求本身非法）；真没这个接口 → 404
          if (hasMalformedEncoding(url)) {
            error(res, 400, 'BAD_REQUEST', 'URL 编码非法');
            return;
          }
          error(res, 404, 'NOT_FOUND', `无此接口: ${req.method} ${url}`);
          return;
        }
        const sessionToken = parseCookie(req.headers?.cookie || '')['hk_session'];
        const session = sessionToken ? resolveSession(db, sessionToken) : null;
        // ⛔ 预审修正（C7-2）：resolveSession 返回 { userId, expiresAt }（契约 INTERFACES.md:67），
        //    原来读 session.user_id（undefined）→ node:sqlite 绑定 undefined 抛错 → 500。
        const user = session ? getUserById(db, session.userId) : null;
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
          ? await readJsonBody(req)
          : null;
        const ctx = {
          user,
          session,
          sessionToken,
          db,
          rules,
          params: match.params,
          body,
          query: Object.fromEntries(new URL(url, 'http://x').searchParams),
          can: (capability, c) => can(user, capability, c, db),
        };
        const result = await match.handler(ctx);
        // ⛔ 预审修正（I7-4）：handler 返回约定 ——
        //   undefined → 200（保持原行为）；{ status, body }（可选 headers）→ 按返回值应答。
        if (result && typeof result === 'object' && typeof result.status === 'number') {
          const { status, body: payload } = result;
          if (status === 204) {
            res.writeHead(204);
            res.end();
            return;
          }
          json(res, status, payload ?? null, result.headers || {});
          return;
        }
        json(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) {
          // ⛔ 预审修正（I7-3）：内部错误原文不外泄 ——
          //    SQLite 错误带表名列名，Node 错误带内部实现细节。只进日志。
          console.error('[server]', err);
          json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
          return;
        }
        const code = domainCode(err, 'BAD_REQUEST');
        if (status === 413) {
          // 请求体超限：连接已不可用 → 关掉，不复用
          json(res, 413, { error: { code, message: err.message } }, { Connection: 'close' });
          return;
        }
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
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // ⛔ 预审修正（m7-2）：畸形编码不能抛 URIError —— 原样透传该 cookie 值
      value = raw;
    }
    out[name] = value;
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
  // ⛔ 预审修正（m7-1）：显式绑 127.0.0.1（默认是 0.0.0.0，会暴露到局域网/公网），
  //    日志与实际绑定保持一致；云主机部署时再显式改成 '0.0.0.0'。
  server.listen(port, '127.0.0.1', () => {
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
import { createUser, findUserByPhone } from '../src/db/repo/users.js';

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
  // 查重用仓储层（不写裸 SQL；行里不含 password_hash）
  let admin = findUserByPhone(db, adminPhone);
  if (!admin) {
    admin = createUser(db, {
      name: '组委会管理员', phone: adminPhone, password: adminPassword, mbaStatus: 'mba',
    });
    db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(admin.id);
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, 'admin')").run(admin.id);
    // 只打印账号，不回显口令
    console.log(`已创建管理员：${adminPhone}  ← 请立即修改密码`);
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
    // ⚠️ SSE 端点在 **P2** 才实现（src/http/sse.js）—— P0/P1 调用会 404，不要在 P0/P1 用。
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
Expected: PASS（9 个测试全过）

- [ ] **Step 8: 全量测试 + 实跑**

Run: `cd platform && node --test`
Expected: 全部通过

Run: `cd platform && node scripts/migrate.js && ADMIN_PASSWORD='change-me-now-temporary' node scripts/seed.js && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

> ⛔ 预审修正（I7-2）：`scripts/seed.js` **不再兜底默认口令** ——
> 没有 `ADMIN_PASSWORD` 会直接报错退出（退出码 1），所以实跑命令里必须显式带上。

Run: `curl -s http://127.0.0.1:8080/api/health`
Expected: `{"ok":true,"at":"..."}`

Run: `curl -s -i -X POST http://127.0.0.1:8080/api/auth/login -H 'Content-Type: application/json' -d '{"phone":"13800000000","password":"change-me-now-temporary"}'`
Expected: `HTTP/1.1 200 OK` + `Set-Cookie: hk_session=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=...`

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
| P0-2 | 配置 fail-fast | 故意把 `scoring-final.json` 某权重改成 0.30 → 启动报错里出现「权重合计」，且进程以**非 0 退出码**退出（实际文案是「权重合计 = 1.1000，必须等于 1（100%）」，用 `toFixed(4)`） |
| P0-3 | 迁移幂等 | 连续跑两次 `scripts/migrate.js`，第二次输出「本次无新迁移」 |
| P0-4 | 权限判定唯一入口 | `permissions.test.js` **13** 个用例通过；`scopeClause` 生成的 SQL **能真跑**（有权那行在结果里、无权那行不在），且占位符个数 == `params.length`；超管标志的**两种形状**（仓储行 snake_case / `toPublicUser` 驼峰）都认 |
| P0-5 | 密码与会话 | `password.test.js` 5 + `session.test.js` 4 + `users.test.js` 2 个用例通过；**库中只存 `token_hash`**（`session.test.js` 断言：库里无明文 token，`token_hash` 是 64 位 sha256 十六进制） |
| P0-6 | 登录闭环 | `server.test.js` **9** 个用例通过：登录 200 + 下发 `hk_session` Cookie（HttpOnly/SameSite=Lax/Path=/）；带 Cookie 访问 `/api/me` 返回 200；密码错 401 且不下发 Cookie |
| P0-7 | 跨平台 | 在 Mac 上 `node src/server.js` 成功；把 `platform/` 拷到另一台机器重复同样命令 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

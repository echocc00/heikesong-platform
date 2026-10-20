# P6 部署与演示版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交齐两件东西——① **拿到云主机就能一键起**的部署资产（systemd / nginx / docker-compose / install.sh）+ 一致性备份与恢复；② **现在就能拿到的公网演示 URL**（静态站 + 浏览器内真实运行规则引擎）。

**Architecture:** 正式版 = 单进程 Node（仅标准库）+ SQLite 单文件 + nginx 反代。**⛔ 单写者**：禁止多 Node worker 进程同时写同一个 `.db`（SQLite 官方：single writer at a time），扩容只能加「读」（静态资源交给 nginx 直出）；⚠️ WAL 要求所有进程在同一台主机，**一旦要多机部署必须换 Postgres，没有第三条路**。演示版 = **同源静态前端 + `web/api.demo.js`（localStorage 适配器）**，它**直接 import `../src/domain/*.js`**（领域层本来就是无 IO 的纯函数 ESM，相对路径 import 即可，**不需要打包器**）→ **规则引擎在浏览器里真实运行**，演示出来的算法行为与正式系统一致。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`（含 `backup()` API）｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## 需求覆盖（本阶段负责的 8 条 NFR）

| 需求 ID | 需求 | 本阶段的落点 | 怎么验 |
|---|---|---|---|
| **R-OPS-01** | 可移植（组员 Mac/Windows、组委会云主机、城市联络员机器；不依赖联网 `npm install` 或原生编译） | 全阶段零 npm 依赖；`install.sh` 幂等；Task 8 跨平台复现 | `test/portability.test.js` + Task 8 Step 4（换机器只跑 3 条命令） |
| **R-OPS-02** | 跨平台稳定 | `node:sqlite` / `node:crypto` / `node:test` 全是内置；shell 脚本用 `$(dirname "$0")` 定位 | 同上；`portability.test.js` 断言无本机绝对路径 |
| **R-OPS-03** | 可扩容 | ⛔ 单写者：扩容只加「读」（静态资源交给 nginx 直出）；⚠️ 多机必须换 Postgres | `test/deploy-assets.test.js`（无 `--workers`/`cluster`）+ `docs/deployment.md` §4 |
| **R-OPS-04** | 性能（瓶颈在网络不在计算） | 静态资源 nginx 直出（不进 Node）；`node:sqlite` 同步 API → 全部 SQL 预编译 | `test/deploy-assets.test.js`（`location /assets/` + 缓存策略存在） |
| **R-OPS-05** | 云主机部署（一键部署 + 备份恢复） | Task 1 备份/恢复；Task 2 systemd/nginx/compose/install.sh | `test/backup.test.js` + `test/restore.test.js` + `test/deploy-assets.test.js` |
| **R-OPS-06** | 公网可访问（先出公网演示版 + 同时备好云主机部署资产） | Task 5/6 演示版（静态站 + 浏览器内真实规则引擎）；Task 2 云主机资产 | `test/demo-parity.test.js` + Task 6 Step 11（发布并拿到公网 URL） |
| **R-OPS-07** | 零 npm 依赖 | 全阶段；`package.json` 只有 `type: module` + scripts | `test/portability.test.js` 断言无 `dependencies` / 无 `node_modules` |
| **R-OPS-08** | 单文件数据库 | `node:sqlite` 单文件 + WAL；备份 = `backup()` API（不是 `cp`） | `test/backup.test.js`：备份可独立打开、数据一致、WAL 事务不丢 |

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
────────── 以下为 P6 追加 ──────────────────────────────────────────
备份方式    ⛔ 不用 cp。用 node:sqlite 的 backup() API（sqlite.org/backup.html）：
            增量拷贝、源库只在真正读取的瞬间短暂加锁、结果是 bit-wise identical snapshot。
            ⚠️ WAL 模式下只 cp .db 不 cp -wal 会丢数据（已提交未 checkpoint 的事务还在 WAL 里）
保留策略    备份文件名 = app-<UTC 时间戳>.db；保留最近 keepCount 份 且 保留 keepDays 天内的
恢复前置    ⛔ 恢复前必须先停服务：脚本用 pid 文件 + systemd 探测，服务在跑 → 拒绝执行。
            恢复后必须删掉旧的 -wal / -shm（它们属于旧库，留着会污染新库）
单写者      ⛔ 禁止多 Node worker 进程同时写同一 SQLite 文件（SQLITE_BUSY 的真正来源）
            ✅ 扩容只能加「读」：静态资源交给 nginx 直出
            ⚠️ WAL 要求所有进程在同一台主机；多机部署必须换 Postgres
nginx       proxy_set_header Connection '';  proxy_http_version 1.1;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            # SSE 必须关闭缓冲：
            proxy_buffering off;  proxy_read_timeout 360s;  add_header X-Accel-Buffering no;
            （审计日志要读真实客户端 IP，所以上面两个头必须透传）
演示版边界  ⛔ 数据不跨人共享（各自浏览器独立）——无云主机条件下的客观边界
            ✅ 但规则引擎在浏览器里【真实运行】，不是假数据硬编码的结果
领域层约束  ⛔ src/domain/** 不得 import 任何 Node 内置模块（node:fs / node:path / node:crypto …）
            ——否则浏览器跑不起来。scripts/build-demo.js 在构建时强制校验，违反即构建失败
脚本纪律    shell 脚本 set -euo pipefail；路径用 $(cd "$(dirname "$0")" && pwd)，不依赖当前工作目录
不硬编码    install.sh / nginx.conf / systemd 单元里的域名、证书路径、密钥、口令一律占位符 + 注释说明怎么替换
证据链      ⛔ 禁用清单为空 = 闸未生效 → 扫描闸直接报错退出；⛔ 静默的空产出比报错更危险
```

## File Structure

**本阶段创建**

```
platform/
├── deploy/
│   ├── heikesong.service         systemd 守护（Restart=always / WorkingDirectory / EnvironmentFile / journald）
│   ├── nginx.conf                反代 + TLS 占位 + 静态资源缓存 + SSE 关缓冲
│   ├── docker-compose.yml        单容器编排（⛔ 不配 --workers / cluster）
│   └── install.sh                一键部署（幂等 + 不硬编码口令）
├── scripts/
│   ├── backup.js                 sqlite.backup() 一致性备份 + 保留策略
│   ├── restore.js                从备份恢复（先停服务 → 验完整性 → 换库 → 清 -wal/-shm）
│   ├── build-demo.js             构建静态演示站（复制 domain/rules/seed + 校验领域层无 Node 导入）
│   └── serve-demo.js             本地静态服务器（验证构建产物用）
├── src/runtime/
│   └── pidfile.js                进程 pid 文件（让「恢复前先停服务」可被机器检查）
├── web/
│   ├── seed/demo-data.json       演示种子数据（含 expectations 断言块）
│   └── dist/                     构建产物（gitignore，不入库）
├── test/
│   ├── backup.test.js            备份可独立打开 + 数据一致 + WAL 事务不丢 + 保留策略
│   ├── restore.test.js           服务在跑拒绝恢复 + 恢复后数据正确 + 旧 -wal 被清
│   ├── deploy-assets.test.js     systemd / nginx / compose / install.sh 的硬约束
│   ├── audit-scan-release.test.js 清单为空报错 / 故意写错被拦 / 更正语境被豁免 / 不依赖 skill
│   ├── demo-seed.test.js         种子数据结构与 expectations 自洽
│   ├── demo-engine.test.js       演示引擎：同分破链 / 归一化降级 / 缺双签告警 / 段位 / 行为分不影响总分
│   ├── demo-parity.test.js       演示版与正式引擎逐字一致（deep equal）
│   ├── demo-static.test.js       静态站构建产物结构 + 领域层无 Node 导入守卫
│   ├── p6-e2e.test.js            全链路 + 正式服务路由契约
│   └── portability.test.js       跨平台可移植性（零依赖 / 无本机路径 / 领域层纯函数）
└── (仓库根) docs/deployment.md   部署与运维手册
```

**本阶段修改**

```
platform/src/config.js              导出 RULE_FILES（供演示构建校验规则文件清单一致）
platform/src/server.js              启动时写 pid 文件、退出时删（供 restore.js 探测"服务是否在跑"）
platform/src/http/static.js         增加两个只读挂载：/src/domain/* 与 /rules/*（演示模式开发服务器用）
platform/scripts/audit-scan.js      增加 --forbidden / --json / --evidence-chain；扫描范围含 web/dist
platform/scripts/forbidden.txt      增加 P6 词条（含「CICC 四维各 25%」的更正语境豁免）+ @skip-path 生成目录
platform/web/api.demo.js            扩展为完整流程：报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API
platform/web/index.html             资源路径改相对路径 + 演示版横幅 + 规则/种子预加载
platform/web/app.js                 演示模式路由与数据加载
platform/package.json               scripts 增加 backup / restore / build:demo / serve:demo
(仓库根) .gitignore                  忽略 platform/web/dist/、platform/data/
```

---

### Task 1: 备份与恢复脚本（`sqlite.backup()` API，不用 `cp`）

**Files:**
- Create: `platform/scripts/backup.js`
- Create: `platform/scripts/restore.js`
- Create: `platform/src/runtime/pidfile.js`
- Modify: `platform/src/server.js`（启动写 pid 文件、退出删）
- Test: `platform/test/backup.test.js`
- Test: `platform/test/restore.test.js`

**Interfaces:**
- Consumes: `openDatabase({ dataDir, filename })`（P0 `src/db/sqlite.js`）
- Produces:
  - `backupDatabase({ dataDir, filename, backupDir, now, keepDays, keepCount })` → `Promise<{ file, path, bytes, pages, removed: string[] }>`
  - `listBackups(backupDir)` → `[{ file, path, bytes, mtimeMs }]`（新 → 旧）
  - `pruneBackups(backupDir, { keepDays, keepCount, now })` → `string[]`（被删除的文件名）
  - `backupFileName(now)` → `'app-<UTC 时间戳>.db'`
  - `checkServiceState({ dataDir, serviceName })` → `{ running: boolean, reason: string, pid?: number, stale?: boolean }`
  - `verifyBackupFile(path)` → `{ ok: boolean, integrity: string, schemaVersion: number|null, error?: string }`
  - `restoreDatabase({ dataDir, backupFile, filename, now, force })` → `{ ok: boolean, steps: string[], error?: string }`
  - `src/runtime/pidfile.js`：`pidFilePath(dataDir)` / `writePidFile(dataDir, pid)` / `removePidFile(dataDir)` / `readPidFile(dataDir)` / `isProcessAlive(pid)`

> **⚠️ 本 Task 的灵魂（R-OPS-05 + 设计文档 §14.2）**
> **备份用 `sqlite.backup()` API，不用 `cp`。** SQLite 官方 `backup.html` 列出 cp 方式的三个缺点：
> ① 备份期间其他写者须等锁释放；② 不能用于内存库；③ **复制过程中掉电可能导致备份损坏**。
> `backup()` 是增量拷贝、源库只在真正读取的瞬间短暂加锁、结果是源库的 **bit-wise identical snapshot**。
> **⚠️ WAL 模式下只 cp `.db` 不 cp `-wal` 会丢数据**——已提交但未 checkpoint 的事务还在 WAL 文件里。
> 本 Task 的测试**同时证明这两件事**：备份文件里有那笔事务，而只复制 `.db` 的副本里没有。

- [ ] **Step 1: 写失败的测试**

`platform/test/backup.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, copyFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/sqlite.js';
import { backupDatabase, listBackups, pruneBackups, backupFileName } from '../scripts/backup.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('备份产出的文件能独立打开且数据一致', async () => {
  const dataDir = tempDir('hks-bk-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('第一行');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('第二行');
  close();

  const result = await backupDatabase({
    dataDir,
    backupDir: join(dataDir, 'backups'),
    now: new Date('2026-10-20T12:00:00Z'),
  });
  assert.ok(existsSync(result.path), '备份文件必须落盘');
  assert.equal(result.file, 'app-20261020T120000Z.db');

  // 独立打开：完全脱离原库
  const backupDb = new DatabaseSync(result.path);
  const rows = backupDb.prepare('SELECT v FROM t ORDER BY id').all();
  backupDb.close();
  assert.equal(rows.length, 2, '备份必须含全部行');
  assert.deepEqual(rows.map((r) => r.v), ['第一行', '第二行']);

  rmSync(dataDir, { recursive: true, force: true });
});

test('WAL 模式下备份包含已提交但未 checkpoint 的事务（而只 cp .db 会丢）', async () => {
  const dataDir = tempDir('hks-bkwal-');
  const { db, close } = openDatabase({ dataDir });
  // 关掉自动 checkpoint：这笔事务确定留在 WAL 文件里
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('只有 WAL 里有');

  const walPath = join(dataDir, 'app.db-wal');
  assert.ok(existsSync(walPath) && statSync(walPath).size > 0, '前置条件：这笔事务必须还在 WAL 文件里');

  // 反例：只 cp .db（不 cp -wal）→ 数据丢失（这就是 sqlite.org/backup.html 说的风险）
  const cpOnly = join(dataDir, 'cp-only.db');
  copyFileSync(join(dataDir, 'app.db'), cpOnly);
  const cpDb = new DatabaseSync(cpOnly);
  const hasTable = cpDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").get();
  const cpCount = hasTable ? cpDb.prepare('SELECT COUNT(*) AS n FROM t').get().n : 0;
  cpDb.close();
  assert.equal(cpCount, 0, '只复制 .db 会丢掉 WAL 里已提交的事务（本断言证明该风险真实存在）');

  // 正例：backup() 拷的是逻辑库 → 包含 WAL 里的事务
  const result = await backupDatabase({
    dataDir,
    backupDir: join(dataDir, 'backups'),
    now: new Date('2026-10-20T12:00:00Z'),
  });
  const bkDb = new DatabaseSync(result.path);
  const bkCount = bkDb.prepare('SELECT COUNT(*) AS n FROM t').get().n;
  bkDb.close();
  assert.equal(bkCount, 1, 'backup() 必须包含已提交但未 checkpoint 的事务');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('保留策略：保留最近 keepCount 份，超份数且超天数的被清理', () => {
  const dir = tempDir('hks-prune-');
  const now = new Date('2026-10-20T12:00:00Z');
  const names = [];
  for (let i = 0; i < 12; i += 1) {
    const name = backupFileName(new Date(now.getTime() - i * 3600_000));
    const p = join(dir, name);
    writeFileSync(p, 'x');
    // 前 3 份在 1 小时内（keepDays=7 内），其余 13~21 天前（超期）
    const ageSec = i < 3 ? 3600 : (10 + i) * 86400;
    const t = (now.getTime() - ageSec * 1000) / 1000;
    utimesSync(p, t, t);
    names.push(name);
  }

  const removed = pruneBackups(dir, { keepDays: 7, keepCount: 10, now });
  assert.equal(removed.length, 2, '只有超出份数且超过保留天数的才清理');
  assert.deepEqual(removed.sort(), [names[10], names[11]].sort());

  const left = listBackups(dir).map((b) => b.file);
  assert.equal(left.length, 10, '保留最近 10 份');
  assert.ok(left.includes(names[0]), '最新一份必须保留');

  rmSync(dir, { recursive: true, force: true });
});

test('备份文件名按 UTC 时间戳命名，可按字典序排序（跨时区也单调）', () => {
  const a = backupFileName(new Date('2026-10-20T08:00:00Z'));
  const b = backupFileName(new Date('2026-10-20T09:00:00Z'));
  assert.equal(a, 'app-20261020T080000Z.db');
  assert.ok(a < b, '文件名必须可字典序排序');
  assert.equal(backupFileName(new Date('2026-10-20T09:00:00Z')), 'app-20261020T090000Z.db');
});
```

`platform/test/restore.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/sqlite.js';
import { backupDatabase } from '../scripts/backup.js';
import { checkServiceState, verifyBackupFile, restoreDatabase } from '../scripts/restore.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function makeBackup(dataDir) {
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('备份里的数据');
  close();
  return backupDatabase({ dataDir, backupDir: join(dataDir, 'backups'), now: new Date('2026-10-20T12:00:00Z') });
}

test('服务在跑时拒绝恢复（不碰数据）', async () => {
  const dataDir = tempDir('hks-rs-busy-');
  const backup = await makeBackup(dataDir);

  // 当前测试进程还活着 → 模拟"服务在跑"
  writeFileSync(join(dataDir, 'app.pid'), String(process.pid), 'utf8');
  const state = checkServiceState({ dataDir });
  assert.equal(state.running, true);
  assert.ok(state.reason.includes('pid'), '必须说明为什么判定服务在跑');

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false, '服务在跑必须拒绝恢复');
  assert.ok(result.error.includes('服务'), `错误信息必须点明原因，实际：${result.error}`);

  rmSync(dataDir, { recursive: true, force: true });
});

test('恢复后数据与备份一致，且旧的 -wal / -shm 被清掉', async () => {
  const dataDir = tempDir('hks-rs-ok-');
  const backup = await makeBackup(dataDir);

  // 恢复前：当前库是另一份数据
  const { db, close } = openDatabase({ dataDir });
  db.exec('DELETE FROM t');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('恢复前的数据');
  close();

  // 制造一个残留的 -wal（模拟没干净关库的现场）
  writeFileSync(join(dataDir, 'app.db-wal'), 'stale-wal', 'utf8');
  writeFileSync(join(dataDir, 'app.db-shm'), 'stale-shm', 'utf8');

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, result.error ?? '');

  const after = new DatabaseSync(join(dataDir, 'app.db'));
  const rows = after.prepare('SELECT v FROM t').all();
  after.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].v, '备份里的数据', '恢复后必须是备份里的数据');
  assert.equal(existsSync(join(dataDir, 'app.db-wal')), false, '旧 -wal 必须被删除（它属于旧库）');
  assert.equal(existsSync(join(dataDir, 'app.db-shm')), false, '旧 -shm 必须被删除');

  rmSync(dataDir, { recursive: true, force: true });
});

test('备份文件损坏时拒绝恢复（integrity_check 不通过就不换库）', async () => {
  const dataDir = tempDir('hks-rs-bad-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  close();

  const bad = join(dataDir, 'bad.db');
  writeFileSync(bad, 'this is not a sqlite database at all', 'utf8');
  const check = verifyBackupFile(bad);
  assert.equal(check.ok, false);
  assert.ok(check.error, '必须给出错误原因');

  const result = restoreDatabase({ dataDir, backupFile: bad, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('完整性') || result.error.includes('损坏') || result.error.includes('integrity'));

  rmSync(dataDir, { recursive: true, force: true });
});

test('恢复前会留一份 .before-restore-<时间戳> 的旧库', async () => {
  const dataDir = tempDir('hks-rs-keep-');
  const backup = await makeBackup(dataDir);
  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, result.error ?? '');
  assert.ok(
    result.steps.some((s) => s.includes('.before-restore-')),
    `恢复步骤里必须记录旧库留存，实际：${result.steps.join(' | ')}`,
  );
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/backup.test.js test/restore.test.js`
Expected: FAIL —— `Cannot find module '../scripts/backup.js'`

- [ ] **Step 3: 创建 `src/runtime/pidfile.js`**

```javascript
// src/runtime/pidfile.js — 进程 pid 文件
// 用途：让「恢复前必须先停服务」这条约束【可被机器检查】，而不是靠人记得停。
// 依据：设计文档 §14.2 单写者约束 —— 多个进程同时写同一个 SQLite 文件会导致 SQLITE_BUSY / 数据损坏。
// 跨平台：process.kill(pid, 0) 在 macOS / Linux / Windows 上都可用。
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function pidFilePath(dataDir) {
  return join(dataDir, 'app.pid');
}

export function writePidFile(dataDir, pid = process.pid) {
  mkdirSync(dataDir, { recursive: true });
  const p = pidFilePath(dataDir);
  writeFileSync(p, String(pid), 'utf8');
  return p;
}

export function removePidFile(dataDir) {
  const p = pidFilePath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

export function readPidFile(dataDir) {
  const p = pidFilePath(dataDir);
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 进程是否还活着。
 * ESRCH = 不在；EPERM = 在但没权限（仍算活着）。
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
```

- [ ] **Step 4: 创建 `scripts/backup.js`**

```javascript
// scripts/backup.js — 一致性备份（SQLite 官方 backup API）
//
// 依据：设计文档 §14.2【决策】备份用 sqlite.backup() API，不用 cp。
//   sqlite.org/backup.html 列出 cp 方式的三个缺点：
//     ① 备份期间其他写者须等锁释放
//     ② 不能用于内存库
//     ③ 复制过程中掉电可能导致备份损坏
//   backup() 是增量拷贝、源库只在真正读取的瞬间短暂加锁，结果是源库的 bit-wise identical snapshot。
// ⚠️ WAL 模式下只 cp .db 不 cp -wal 会丢数据：已提交但未 checkpoint 的事务还在 WAL 文件里。
//   backup() 拷贝的是【逻辑库】的页，所以这些事务会被包含进去。
// ✅ 可以在服务运行中执行（只加读锁，不阻塞写入）。
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const BACKUP_PREFIX = 'app-';
export const BACKUP_SUFFIX = '.db';

/** 备份文件名：app-<UTC 时间戳>.db（字典序 = 时间序，跨时区也单调） */
export function backupFileName(now = new Date()) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return `${BACKUP_PREFIX}${iso}${BACKUP_SUFFIX}`;
}

/** 列出备份（新 → 旧） */
export function listBackups(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .map((f) => {
      const st = statSync(join(backupDir, f));
      return { file: f, path: join(backupDir, f), bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : -1));
}

/**
 * 保留策略：最近 keepCount 份无条件保留；keepDays 天内的也保留；其余删除。
 * 返回被删除的文件名。
 */
export function pruneBackups(backupDir, { keepDays = 7, keepCount = 10, now = new Date() } = {}) {
  const all = listBackups(backupDir);
  const cutoff = new Date(now).getTime() - keepDays * 86400_000;
  const keep = new Set();

  for (const b of all.slice(0, keepCount)) keep.add(b.file);
  for (const b of all) {
    if (b.mtimeMs >= cutoff) keep.add(b.file);
  }

  const removed = [];
  for (const b of all) {
    if (keep.has(b.file)) continue;
    unlinkSync(b.path);
    removed.push(b.file);
  }
  return removed;
}

/**
 * 做一次一致性备份。
 * @returns {Promise<{file:string,path:string,bytes:number,pages:number,removed:string[]}>}
 */
export async function backupDatabase({
  dataDir = './data',
  filename = 'app.db',
  backupDir = null,
  now = new Date(),
  keepDays = 7,
  keepCount = 10,
} = {}) {
  const outDir = backupDir || join(dataDir, 'backups');
  mkdirSync(outDir, { recursive: true });

  const sourcePath = join(dataDir, filename);
  if (!existsSync(sourcePath)) throw new Error(`源库不存在：${sourcePath}`);

  const target = join(outDir, backupFileName(now));
  const source = new DatabaseSync(sourcePath);
  let pages = 0;
  try {
    await backup(source, target, {
      rate: 100,
      progress: (_db, copied) => { pages = copied; },
    });
  } finally {
    source.close();
  }

  const st = statSync(target);
  const removed = pruneBackups(outDir, { keepDays, keepCount, now });
  return { file: basename(target), path: target, bytes: st.size, pages, removed };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args['data-dir'] || process.env.DATA_DIR || join(here, '..', 'data');
  const result = await backupDatabase({
    dataDir,
    backupDir: args.out ? String(args.out) : null,
    keepDays: Number(args['keep-days'] ?? 7),
    keepCount: Number(args['keep-count'] ?? 10),
  });
  console.log(`[backup] 完成：${result.file}（${result.bytes} 字节，${result.pages} 页）`);
  if (result.removed.length) console.log(`[backup] 按保留策略清理：${result.removed.join(', ')}`);
}
```

- [ ] **Step 5: 创建 `scripts/restore.js`**

```javascript
// scripts/restore.js — 从备份恢复
//
// ⛔ 恢复前必须先停服务：SQLite 拒绝在有其他连接写同一文件时安全替换文件；
//    强行替换会丢数据或损坏库（且服务可能继续往被换掉的旧 inode 写）。
//    本脚本用【pid 文件 + systemd 探测】把这条约束变成机器检查。
// ⚠️ 恢复后必须删掉旧的 -wal / -shm：它们属于旧库，留着会污染新库。
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPidFile, isProcessAlive } from '../src/runtime/pidfile.js';

/** 列出备份文件（新 → 旧）：文件名是 UTC 时间戳，字典序倒排即时间倒序。 */
function listBackupFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .map((f) => join(dir, f));
}

/** 服务是否还在跑。优先看 pid 文件（跨平台），Linux 上再兜底 systemd。 */
export function checkServiceState({ dataDir, serviceName = 'heikesong' } = {}) {
  const pid = readPidFile(dataDir);
  if (pid && isProcessAlive(pid)) {
    return { running: true, reason: `pid 文件显示进程 ${pid} 仍在运行`, pid };
  }
  if (pid) {
    return { running: false, reason: `pid 文件存在但进程 ${pid} 已退出（可能是异常终止的残留）`, pid, stale: true };
  }
  if (process.platform === 'linux' && existsSync('/run/systemd/system')) {
    try {
      const res = spawnSync('systemctl', ['is-active', serviceName], { encoding: 'utf8' });
      if (res.status === 0 && String(res.stdout).trim() === 'active') {
        return { running: true, reason: `systemd 服务 ${serviceName} 处于 active` };
      }
    } catch {
      // systemctl 不可用 → 忽略这一路探测
    }
  }
  return { running: false, reason: '未发现运行中的服务进程' };
}

/** 校验备份文件：能不能打开 + 完整性检查。 */
export function verifyBackupFile(path) {
  if (!existsSync(path)) return { ok: false, integrity: 'missing', schemaVersion: null, error: `备份文件不存在：${path}` };
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    let schemaVersion = null;
    try {
      schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? null;
    } catch {
      schemaVersion = null; // 备份里没有迁移表（还没 migrate 过）——不算损坏
    }
    db.close();
    if (integrity !== 'ok') {
      return { ok: false, integrity: String(integrity), schemaVersion, error: `备份完整性检查未通过：${integrity}` };
    }
    return { ok: true, integrity: 'ok', schemaVersion };
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    return { ok: false, integrity: 'unopenable', schemaVersion: null, error: `备份文件无法打开：${err.message}` };
  }
}

/**
 * 恢复。返回 { ok, steps, error? }，不抛异常（便于测试与 CLI 共用）。
 */
export function restoreDatabase({
  dataDir = './data',
  backupFile = null,
  backupDir = null,
  filename = 'app.db',
  now = new Date(),
  force = false,
} = {}) {
  const steps = [];

  // 1. 选定备份文件
  let backupPath = backupFile;
  if (!backupPath) {
    const dir = backupDir || join(dataDir, 'backups');
    const all = listBackupFiles(dir);
    if (!all.length) return { ok: false, steps, error: `没有可用的备份：${dir}` };
    backupPath = all[0];
  }
  steps.push(`使用备份：${basename(backupPath)}`);

  // 2. 停服务检查
  const state = checkServiceState({ dataDir });
  if (state.running && !force) {
    return { ok: false, steps, error: `服务仍在运行，拒绝恢复（${state.reason}）。请先停服务再恢复。` };
  }
  steps.push(`服务状态：${state.reason}`);

  // 3. 备份完整性
  const check = verifyBackupFile(backupPath);
  if (!check.ok) return { ok: false, steps, error: `备份不可用（完整性检查未通过）：${check.error}` };
  steps.push(`备份完整性：ok（schema 版本 ${check.schemaVersion ?? '未知'}）`);

  // 4. 落到临时文件并再验一次
  const dbPath = join(dataDir, filename);
  const tmpPath = `${dbPath}.restore.tmp`;
  copyFileSync(backupPath, tmpPath);
  const tmpCheck = verifyBackupFile(tmpPath);
  if (!tmpCheck.ok) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, steps, error: `落盘后的临时文件校验失败：${tmpCheck.error}` };
  }
  steps.push('备份已落到临时文件并复验通过');

  // 5. 旧库留存 + 换库
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  if (existsSync(dbPath)) {
    const before = `${dbPath}.before-restore-${stamp}`;
    renameSync(dbPath, before);
    steps.push(`旧库已留存为 ${basename(before)}`);
  }
  // ⚠️ 旧 -wal / -shm 属于旧库，必须删掉，否则新库打开时会读到不相干的 WAL
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      unlinkSync(p);
      steps.push(`已删除旧 ${suffix} 文件（属于旧库）`);
    }
  }
  renameSync(tmpPath, dbPath);
  steps.push(`新库已就位：${dbPath}`);

  return { ok: true, steps, backup: basename(backupPath) };
}

const here = dirname(fileURLToPath(import.meta.url));

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const backupFile = args.find((a) => !a.startsWith('--')) || null;
  const result = restoreDatabase({ dataDir, backupFile, force: args.includes('--force') });
  for (const s of result.steps) console.log(`[restore] ${s}`);
  if (!result.ok) {
    console.error(`[restore] 失败：${result.error}`);
    process.exit(1);
  }
  console.log('[restore] 成功。请重新启动服务： systemctl restart heikesong');
}
```

- [ ] **Step 6: 修改 `src/server.js`（写 pid 文件）**

在 `src/server.js` 的 `isMain` 分支里，`openDatabase` 之后加：

```javascript
import { writePidFile, removePidFile } from './runtime/pidfile.js';
// …（在 openDatabase 之后）
  writePidFile(dataDir);
// …（在 SIGINT / SIGTERM 处理里，close() 之前）
  removePidFile(dataDir);
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/backup.test.js test/restore.test.js`
Expected: PASS（backup 4 个用例 + restore 4 个用例全过）

- [ ] **Step 8: 实跑一次备份与恢复**

Run: `cd platform && node scripts/migrate.js && node scripts/seed.js && node scripts/backup.js`
Expected: 输出 `[backup] 完成：app-<时间戳>.db（… 字节，… 页）`，且 `data/backups/` 下出现一个 `.db` 文件

Run: `cd platform && node scripts/restore.js && node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('./data/app.db');console.log(db.prepare('SELECT COUNT(*) n FROM users').get().n);db.close();"`
Expected: 输出一个正整数（恢复后库可正常打开读表）

- [ ] **Step 9: 提交**

```bash
cd platform && git add src/runtime scripts/backup.js scripts/restore.js src/server.js test/backup.test.js test/restore.test.js
git commit -m "feat(P6): 一致性备份与恢复脚本（sqlite.backup() API + 停服务前置检查）"
```

---

### Task 2: 部署资产（systemd / nginx / docker-compose / install.sh）

**Files:**
- Create: `platform/deploy/heikesong.service`
- Create: `platform/deploy/nginx.conf`
- Create: `platform/deploy/docker-compose.yml`
- Create: `platform/deploy/install.sh`
- Test: `platform/test/deploy-assets.test.js`

**Interfaces:**
- Consumes: 无（纯资产文件）
- Produces:
  - `deploy/heikesong.service` → systemd 单元，占位符 `__APP_DIR__` / `__DATA_DIR__` / `__RUN_USER__`
  - `deploy/nginx.conf` → nginx 站点，占位符 `__SERVER_NAME__` / `__CERT_PATH__` / `__KEY_PATH__` / `__APP_DIR__`
  - `deploy/docker-compose.yml` → 单容器编排（⛔ 无 `--workers` / `cluster`）
  - `deploy/install.sh` → 一键部署（幂等；口令从 `ADMIN_PASSWORD` 环境变量或交互读取，⛔ 不硬编码）

> **⚠️ 本 Task 的三条硬约束**
> ① **单写者**：⛔ 禁止多 Node worker 进程同时写同一个 SQLite 文件（SQLite 官方：single writer at a time）——这是 `SQLITE_BUSY` 的真正来源。✅ 扩容只能加**读**（静态资源交给 nginx 直出，几百并发静态请求根本不进 Node 进程）。⚠️ WAL 要求所有进程**在同一台主机**；**一旦要多机部署，必须换 Postgres，没有第三条路**。
> ② **不硬编码任何口令/域名/证书路径**：一律占位符 + 注释说明怎么替换。
> ③ **install.sh 幂等**：可重复执行不炸（用户已存在、目录已存在、文件已存在、systemd 已 enable → 都不炸）。

- [ ] **Step 1: 写失败的测试**

`platform/test/deploy-assets.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');

function read(name) {
  return readFileSync(join(deployDir, name), 'utf8');
}

test('systemd 单元：常驻守护 + 工作目录 + 环境文件 + journald 日志 + 非 root 运行', () => {
  const unit = read('heikesong.service');
  assert.match(unit, /^Restart=always$/m, '必须崩溃后自动拉起');
  assert.match(unit, /^WorkingDirectory=/m, '必须写明工作目录');
  assert.match(unit, /^EnvironmentFile=/m, '必须用环境文件承载配置');
  assert.match(unit, /^User=\w+/m, '必须指定运行用户');
  assert.match(unit, /^Group=\w+/m, '必须指定运行组');
  assert.match(unit, /^StandardOutput=journal$/m, '日志必须走 journald');
  assert.match(unit, /^StandardError=journal$/m, '日志必须走 journald');
  assert.doesNotMatch(unit, /^User=root$/m, '⛔ 禁止以 root 运行');
  assert.match(unit, /__APP_DIR__/, '必须用占位符，不硬编码部署路径');
});

test('systemd 单元：⛔ 不得出现多 worker / cluster', () => {
  const unit = read('heikesong.service');
  assert.doesNotMatch(unit, /--workers/, '⛔ 禁止多 worker 进程写同一个 SQLite 文件');
  assert.doesNotMatch(unit, /\bcluster\b/, '⛔ 禁止 cluster 模式');
  assert.doesNotMatch(unit, /ExecStart=.*\snode\s+--cluster/, '⛔ 禁止 cluster 模式');
});

test('nginx：反代 + 真实客户端 IP 透传 + SSE 关缓冲，四组指令一字不差', () => {
  const conf = read('nginx.conf');
  assert.match(conf, /proxy_set_header Connection '';/, '必须清掉 Connection 头（配合 HTTP/1.1 keepalive）');
  assert.match(conf, /proxy_http_version 1\.1;/, '必须 HTTP/1.1');
  assert.match(conf, /proxy_set_header X-Real-IP \$remote_addr;/, '审计日志要读真实客户端 IP');
  assert.match(conf, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/, '审计日志要读真实客户端 IP');
  assert.match(conf, /proxy_buffering off;/, 'SSE 必须关闭缓冲');
  assert.match(conf, /proxy_read_timeout 360s;/, 'SSE 长连接超时');
  assert.match(conf, /add_header X-Accel-Buffering no;/, 'SSE 必须关掉 nginx 缓冲');
  assert.match(conf, /__SERVER_NAME__/, '域名必须是占位符');
  assert.match(conf, /__CERT_PATH__/, '证书路径必须是占位符');
  assert.match(conf, /__KEY_PATH__/, '密钥路径必须是占位符');
});

test('nginx：静态资源直出 + 缓存（扩容只能加读）', () => {
  const conf = read('nginx.conf');
  assert.match(conf, /location \/assets\//, '静态资源必须单独 location');
  assert.match(conf, /expires \d+d;/, '静态资源必须有缓存期');
  assert.match(conf, /Cache-Control "no-cache"/, 'index.html 不能被缓存');
});

test('docker-compose：单容器、⛔ 不配 workers/cluster、数据持久化、有健康检查', () => {
  const yml = read('docker-compose.yml');
  assert.doesNotMatch(yml, /--workers/, '⛔ 禁止多 worker 进程写同一个 SQLite 文件');
  assert.doesNotMatch(yml, /^\s*cluster\s*:/m, '⛔ 禁止 cluster 编排');
  assert.match(yml, /restart:\s*always/, '必须自动重启');
  assert.match(yml, /DATA_DIR/, '必须声明数据目录');
  assert.match(yml, /volumes:/, '必须持久化数据');
  assert.match(yml, /healthcheck:/, '必须有健康检查');
});

test('install.sh：set -euo pipefail + 路径不依赖当前工作目录 + 不硬编码口令', () => {
  const sh = read('install.sh');
  assert.match(sh, /^set -euo pipefail$/m, '必须开启严格模式');
  assert.match(sh, /\$\(cd "\$\(dirname "\$0"\)" && pwd\)/, '必须用脚本自身位置定位，不依赖 cwd');
  assert.doesNotMatch(sh, /PASSWORD\s*=\s*["'][^"'$][^"']*["']/, '⛔ 不得出现硬编码口令');
  assert.doesNotMatch(sh, /password\s*=\s*["'][^"'$][^"']*["']/i, '⛔ 不得出现硬编码口令');
  assert.match(sh, /ADMIN_PASSWORD/, '管理员口令必须来自环境变量');
  assert.match(sh, /id -u/, '必须做幂等守卫（用户已存在则跳过）');
  assert.match(sh, /systemctl daemon-reload/, '必须 reload systemd');
  assert.match(sh, /nginx -t/, '必须先 nginx -t 再 reload');
});

test('install.sh：占位符与被替换的资产一一对应', () => {
  const sh = read('install.sh');
  for (const ph of ['__APP_DIR__', '__DATA_DIR__', '__RUN_USER__', '__SERVER_NAME__', '__CERT_PATH__', '__KEY_PATH__']) {
    assert.ok(sh.includes(ph), `install.sh 必须替换占位符 ${ph}`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/deploy-assets.test.js`
Expected: FAIL —— `ENOENT: no such file or directory, open 'platform/deploy/heikesong.service'`

- [ ] **Step 3: 创建 `deploy/heikesong.service`**

```ini
# deploy/heikesong.service — systemd 守护单元
#
# 依据：设计文档 §14.2「deploy/heikesong.service（systemd 守护）」
#
# ⚠️ 占位符说明（由 deploy/install.sh 自动替换，也可手工替换后 cp 到 /etc/systemd/system/）：
#   __APP_DIR__   程序目录（默认 /opt/heikesong/platform）
#   __DATA_DIR__  数据目录（默认 /var/lib/heikesong/data）
#   __RUN_USER__  运行用户（默认 heikesong）
#
# ⛔ 单写者约束：这里【绝不】加 --workers=N 或 cluster 模式。
#    SQLite 官方：There can only be a single writer at a time。
#    多个 Node worker 进程同时写同一个 .db 文件是 SQLITE_BUSY 的真正来源。
# ✅ 扩容只能加「读」：静态资源交给 nginx 直出，几百并发静态请求根本不进 Node 进程。
# ⚠️ WAL 要求所有进程在同一台主机；要多机部署必须换 Postgres，没有第三条路。

[Unit]
Description=Heikesong Platform (单进程 Node · 单写者 SQLite)
Documentation=file:/opt/heikesong/platform/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__APP_DIR__

# 环境文件：PORT / DATA_DIR / SESSION_TTL_DAYS
# ⛔ 这里不放任何口令：口令只在初始化管理员时用一次，不落盘。
EnvironmentFile=-/etc/heikesong/platform.env

ExecStart=/usr/bin/env node __APP_DIR__/src/server.js

# 崩溃自动拉起
Restart=always
RestartSec=3
# 优雅停机：先 SIGTERM 等它关库，再 SIGKILL
KillSignal=SIGTERM
TimeoutStopSec=30

# 日志走 journald： journalctl -u heikesong -f
StandardOutput=journal
StandardError=journal
SyslogIdentifier=heikesong

# 环境默认值（EnvironmentFile 里的同名变量优先）
Environment=PORT=8080
Environment=DATA_DIR=__DATA_DIR__
Environment=NODE_ENV=production

# 资源与安全
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=__DATA_DIR__
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: 创建 `deploy/nginx.conf`**

```nginx
# deploy/nginx.conf — 反向代理 + TLS + 静态资源缓存 + SSE 关缓冲
#
# 依据：设计文档 §14.2【决策】nginx 配置要点
#   proxy_set_header Connection '';  proxy_http_version 1.1;
#   proxy_set_header X-Real-IP $remote_addr;
#   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#   # SSE 必须关闭缓冲：
#   proxy_buffering off;  proxy_read_timeout 360s;  add_header X-Accel-Buffering no;
#
# ⚠️ 审计日志要读真实客户端 IP，所以上面两个头必须透传（否则审计里全是 127.0.0.1，
#    事后追责与异常检测全部失效）。
#
# ⚠️ 替换下面四个占位符再启用（deploy/install.sh 会自动 sed 替换）：
#   __SERVER_NAME__  正式域名，如 heikesong.example.com
#   __CERT_PATH__    证书路径，如 /etc/letsencrypt/live/heikesong.example.com/fullchain.pem
#   __KEY_PATH__     私钥路径，如 /etc/letsencrypt/live/heikesong.example.com/privkey.pem
#   __APP_DIR__      程序目录，如 /opt/heikesong/platform
#
# ⚠️ nginx 需要 ≥ 1.25.1（用 `http2 on;` 语法）。更低版本请把
#    `http2 on;` 换成 `listen 443 ssl http2;`。

upstream heikesong_app {
    # ⛔ 只能起【一个】后端进程（单写者）。要加读能力就加 nginx 副本，不要加 Node 副本。
    server 127.0.0.1:8080;
    keepalive 32;
}

# ── HTTP → HTTPS ─────────────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    server_name __SERVER_NAME__;

    # 证书续期用的 ACME 校验目录（certbot webroot 模式）
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# ── HTTPS 主站 ──────────────────────────────────────────────
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name __SERVER_NAME__;

    ssl_certificate     __CERT_PATH__;
    ssl_certificate_key __KEY_PATH__;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    # 业务上传很小，8m 足够；防止超大 body 打满内存
    client_max_body_size 8m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # ── 静态资源直出（不进 Node 进程）────────────────────────
    # ✅ 这是「扩容只能加读」的落点：几百并发静态请求根本不进 Node。
    location /assets/ {
        alias __APP_DIR__/web/assets/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        access_log off;
    }

    # index.html 不缓存（其余静态资源走上面的缓存策略）
    location = /index.html {
        proxy_pass http://heikesong_app;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        add_header Cache-Control "no-cache" always;
    }

    # ── 动态请求（含 SSE）──────────────────────────────────
    location / {
        proxy_pass http://heikesong_app;

        # ⚠️ SSE 必须 HTTP/1.1 + 空 Connection，否则事件被攒住，页面看起来"不实时"
        proxy_http_version 1.1;
        proxy_set_header Connection '';

        # ⚠️ 透传真实客户端 IP：审计日志要读它
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ⚠️ SSE 必须关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 360s;
        proxy_send_timeout 360s;
        add_header X-Accel-Buffering no;
    }
}
```

- [ ] **Step 5: 创建 `deploy/docker-compose.yml`**

```yaml
# deploy/docker-compose.yml — 单容器编排
#
# 依据：设计文档 §14.2「deploy/docker-compose.yml（单容器编排）」
#
# ⛔ 单写者约束：这里的 command 里【绝不】加 --workers=N，也不要用 compose 的 scale 扩副本。
#    SQLite 官方：There can only be a single writer at a time。
#    多个 Node 进程同时写同一个 .db 文件是 SQLITE_BUSY 的真正来源。
# ✅ 扩容只能加「读」：静态资源交给 nginx 直出。
# ⚠️ WAL 要求所有进程在同一台主机；要多机部署必须换 Postgres，没有第三条路。
#
# ⚠️ 本文件在 platform/deploy/ 下，compose 的相对路径以本文件所在目录为基准。
#    运行： cd platform && docker compose -f deploy/docker-compose.yml up -d
#    宿主机 127.0.0.1:8080 出来，Node 不直接暴露到公网，由 nginx 反代。

name: heikesong

services:
  app:
    image: node:24-alpine
    container_name: heikesong-app
    working_dir: /app
    # ⛔ 不要改成 ["node", "--cluster", "src/server.js"] 或加 --workers
    command: ["node", "src/server.js"]
    restart: always
    environment:
      PORT: "8080"
      DATA_DIR: "/data"
      NODE_ENV: "production"
    ports:
      # 只绑回环：对外由 nginx 反代
      - "127.0.0.1:8080:8080"
    volumes:
      # platform/ 只读挂载：代码不进容器，升级靠替换宿主机目录
      - ..:/app:ro
      # 数据目录持久化（备份与恢复都在这个卷里）
      - app_data:/data
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

volumes:
  app_data:
```

- [ ] **Step 6: 创建 `deploy/install.sh`**

```bash
#!/usr/bin/env bash
# deploy/install.sh — 一键部署（幂等）
#
# 依据：设计文档 §14.2「deploy/install.sh（一键：装 Node → 写 service → 配 nginx → 建库 → 初始化管理员账号）」
#
# ✅ 幂等：可重复执行不炸（用户/目录/文件已存在 → 跳过或覆盖，不报错）。
# ⛔ 不硬编码任何口令：管理员口令来自环境变量 ADMIN_PASSWORD，或交互读取（不回显）。
#    环境文件 /etc/heikesong/platform.env 里【不放口令】——口令只用于初始化那一次。
#
# 用法：
#   sudo SERVER_NAME=heikesong.example.com \
#        CERT_PATH=/etc/letsencrypt/live/heikesong.example.com/fullchain.pem \
#        KEY_PATH=/etc/letsencrypt/live/heikesong.example.com/privkey.pem \
#        ADMIN_PASSWORD='...' ./deploy/install.sh
#
# 全部变量（都有默认值，见下）：
#   APP_DIR       程序目录            默认 /opt/heikesong/platform
#   DATA_DIR      数据目录            默认 /var/lib/heikesong/data
#   SERVICE_NAME  systemd 服务名       默认 heikesong
#   RUN_USER      运行用户            默认 heikesong
#   SERVER_NAME   正式域名            默认空（空 = 跳过 nginx 配置）
#   CERT_PATH     证书路径            默认 /etc/letsencrypt/live/<域名>/fullchain.pem
#   KEY_PATH      私钥路径            默认 /etc/letsencrypt/live/<域名>/privkey.pem
#   ADMIN_PHONE   管理员手机号         默认 13800000000
#   ADMIN_PASSWORD 管理员口令          默认空（空 = 交互读取）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"     # platform/ 根目录
APP_DIR="${APP_DIR:-/opt/heikesong/platform}"
DATA_DIR="${DATA_DIR:-/var/lib/heikesong/data}"
SERVICE_NAME="${SERVICE_NAME:-heikesong}"
RUN_USER="${RUN_USER:-heikesong}"
SERVER_NAME="${SERVER_NAME:-}"
ENV_FILE="${ENV_FILE:-/etc/heikesong/platform.env}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/heikesong.conf}"
NGINX_LINK="${NGINX_LINK:-/etc/nginx/sites-enabled/heikesong.conf}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] 错误：%s\n' "$*" >&2; exit 1; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "需要 root 权限（请用 sudo 运行）"
  fi
}

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor rest
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then return 1; fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; then return 1; fi
  return 0
}

install_node() {
  log "安装 Node.js 24（生产建议；代码在 22 与 24 上都能跑）"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  else
    die "未识别的包管理器：请手动安装 Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 后重跑本脚本"
  fi
}

create_service_user() {
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    log "运行用户 $RUN_USER 已存在，跳过"
    return 0
  fi
  log "创建系统用户 $RUN_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/heikesong --shell /usr/sbin/nologin "$RUN_USER"
  else
    adduser -S -D -H -h /var/lib/heikesong -s /sbin/nologin "$RUN_USER"
  fi
}

prepare_dirs() {
  install -d -m 0755 "$APP_DIR"
  install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR"
  install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR/backups"
}

copy_app() {
  log "同步程序到 $APP_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'data/' --exclude 'node_modules/' --exclude '.git/' --exclude 'web/dist/' \
      "$ROOT/" "$APP_DIR/"
  else
    # 没有 rsync 时的兜底：先删后拷（不删 data/）
    find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'data' -exec rm -rf {} +
    cp -a "$ROOT/." "$APP_DIR/"
  fi
}

write_env_file() {
  log "写环境文件 $ENV_FILE"
  install -d -m 0750 "$(dirname "$ENV_FILE")"
  umask 077
  {
    printf 'PORT=8080\n'
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'SESSION_TTL_DAYS=7\n'
  } > "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  chown root:"$RUN_USER" "$ENV_FILE" 2>/dev/null || true
  # ⛔ 这里【不写】任何口令：口令只在初始化管理员时用一次，不落盘。
}

as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- "$@"
  else
    local cmd=""
    for a in "$@"; do cmd="$cmd $(printf '%q' "$a")"; done
    su -s /bin/sh -c "$cmd" "$RUN_USER"
  fi
}

init_database() {
  log "建库 + 迁移（以运行用户执行，避免库文件属主变成 root）"
  ( cd "$APP_DIR" && as_service_user env DATA_DIR="$DATA_DIR" node scripts/migrate.js )

  local phone="${ADMIN_PHONE:-13800000000}"
  local password="${ADMIN_PASSWORD:-}"
  if [ -z "$password" ]; then
    printf '请输入管理员口令（不回显，仅用于本次初始化，不写入任何文件）：'
    read -rs password
    printf '\n'
  fi
  [ -n "$password" ] || die "未提供管理员口令（ADMIN_PASSWORD 环境变量或交互输入）"
  log "初始化能力点 / 角色 / 管理员账号（手机号 $phone）"
  ( cd "$APP_DIR" && as_service_user env DATA_DIR="$DATA_DIR" ADMIN_PHONE="$phone" ADMIN_PASSWORD="$password" node scripts/seed.js )
  unset password
}

write_systemd_unit() {
  log "写 systemd 单元 $SERVICE_NAME"
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__RUN_USER__|$RUN_USER|g" \
      "$ROOT/deploy/heikesong.service" > "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

write_nginx_site() {
  if [ -z "$SERVER_NAME" ]; then
    log "跳过 nginx：未设置 SERVER_NAME（正式对外域名）"
    return 0
  fi
  log "写 nginx 站点配置 $NGINX_SITE"
  install -d -m 0755 "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"
  local cert="${CERT_PATH:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
  local key="${KEY_PATH:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"
  sed -e "s|__SERVER_NAME__|$SERVER_NAME|g" \
      -e "s|__CERT_PATH__|$cert|g" \
      -e "s|__KEY_PATH__|$key|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      "$ROOT/deploy/nginx.conf" > "$NGINX_SITE"
  ln -sfn "$NGINX_SITE" "$NGINX_LINK"
  nginx -t                 # ⛔ 先验配置再 reload：配置错了不炸线上
  if systemctl reload nginx 2>/dev/null; then
    log "nginx 已 reload"
  else
    systemctl restart nginx
    log "nginx 已重启"
  fi
}

start_service() {
  log "启动服务 $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  sleep 1
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "服务运行中。健康检查： curl -s http://127.0.0.1:8080/api/health"
  else
    log "服务未处于 active 状态，请看日志： journalctl -u $SERVICE_NAME -n 50 --no-pager"
    return 1
  fi
}

main() {
  need_root
  if ! node_version_ok; then
    install_node
  fi
  node_version_ok || die "Node 版本仍不满足要求（需要 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}）"

  create_service_user
  prepare_dirs
  copy_app
  write_env_file
  init_database
  write_systemd_unit
  start_service
  write_nginx_site

  log "部署完成。"
  log "  程序目录：$APP_DIR"
  log "  数据目录：$DATA_DIR"
  log "  备份命令： cd $APP_DIR && DATA_DIR=$DATA_DIR node scripts/backup.js"
  log "  查看日志： journalctl -u $SERVICE_NAME -f"
}

main "$@"
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/deploy-assets.test.js`
Expected: PASS（7 个测试全过）

- [ ] **Step 8: 语法自检（不执行）**

Run: `cd platform && bash -n deploy/install.sh && echo "install.sh 语法 OK"`
Expected: `install.sh 语法 OK`

Run: `cd platform && sh -c 'grep -c "proxy_buffering off;" deploy/nginx.conf'`
Expected: `1`

- [ ] **Step 9: 提交**

```bash
cd platform && git add deploy test/deploy-assets.test.js
git commit -m "feat(P6): 部署资产（systemd / nginx / docker-compose / 幂等 install.sh）"
```

---

### Task 3: 发布前扫描闸（发布产物也扫 · 清单为空即报错 · 更正语境豁免）

**Files:**
- Modify: `platform/scripts/audit-scan.js`（P4 已建；P6 追加发布产物扫描 / `--forbidden` / `--json` / `--evidence-chain`）
- Modify: `platform/scripts/forbidden.txt`（P4 已建；P6 追加词条与 `@skip-path`）
- Test: `platform/test/audit-scan-release.test.js`（**新建**，不改 P4 的 `test/audit-scan.test.js`）

**Interfaces:**
- Consumes: P4 的 `parseManifest(text)` / `scanText(text, terms, { file })` / `scanRoots(roots, opts)` / `main(argv)`（**签名不变**）
- Produces:
  - `main(argv)` 新增参数：`--forbidden <path>`（指定别的清单）、`--json`（机器可读输出）、`--evidence-chain <path>`（可选增强）
  - 默认扫描范围扩展为：仓库 `docs/` + `platform/` + `platform/web/dist/`（存在才扫，发布产物本身也必须过闸）

> **⚠️ 为什么本 Task 是"修改"而不是"创建"**
> `scripts/audit-scan.js` 已由 **P4（审计与防作弊）** Task 7 建立，`INTERFACES.md` §5 与 §7 都列了它。
> 本阶段**不重建**这个文件（P0–P6 严格串行，两个 writer 写同一个路径必然冲突），
> 只在 P4 的实现上**追加发布相关的能力**，并新增一个独立测试文件守住验收标准。
>
> **⚠️ 本 Task 的灵魂（R-AUD-03）**
> **禁用清单必须真有词条，空清单 ≠ 已保护。** 项目自己的踩坑记录写得很直白：
> 「跑扫描发现 forbidden.txt 存在但无词条 —— 该闸未生效」。
> → **清单为空 → 脚本直接报错并以非 0 退出**，绝不能"扫了 0 个词，0 个违规，闸通过"。
> **⚠️ 但也不能一刀切**：像「CICC 四维各 25%」这类**引用并纠正原始错误表述**的写法必须能出现在文档里。
> → 清单语法 `词条|豁免正则`：同一行命中豁免正则 → 记为「更正语境」，不计违规，但会出现在报告里。
>
> **⚠️ 平台自身必须能独立跑**：不依赖用户机器上的 `evidence-chain` skill。
> `--evidence-chain` 只是**可选增强**：skill 在就多跑一份报告，不在就打印一行说明并继续，**绝不影响本闸结论**。

- [ ] **Step 1: 写失败的测试**

`platform/test/audit-scan-release.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, scanText, main } from '../scripts/audit-scan.js';

const here = dirname(fileURLToPath(import.meta.url));

test('清单为空时扫描闸报错（空清单 ≠ 已保护）', () => {
  const parsed = parseManifest('# 只有注释，没有词条\n\n');
  assert.equal(parsed.terms.length, 0);
  assert.ok(parsed.errors.length > 0, '必须报"闸未生效"');
  assert.ok(parsed.errors[0].includes('闸未生效'), `实际错误：${parsed.errors[0]}`);
});

test('故意写错的文本能被拦下', () => {
  const parsed = parseManifest('积分占决赛 30%\n');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  const bad = '依据 AdventureX 经验，积分占决赛 30%，可以进 A 榜。\n';
  const r = scanText(bad, parsed.terms, { file: 'docs/x.md' });
  assert.equal(r.violations.length, 1, '必须拦下');
  assert.equal(r.violations[0].term, '积分占决赛 30%');
  assert.equal(r.violations[0].line, 1);
  assert.equal(r.exempted.length, 0);
});

test('更正语境不被误拦（词条|豁免正则 语法）', () => {
  // ⚠️ 词条是【字面串】匹配（scanText 用 line.includes），不是正则。
  //    所以空格变体必须各写一条（这也是平台自带 forbidden.txt 的既有约定）。
  const parsed = parseManifest('CICC 四维各 25%|已更正|S7 §1.1|不是|六维\n');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  assert.equal(parsed.terms[0].term, 'CICC 四维各 25%');
  assert.ok(parsed.terms[0].exemptRegex instanceof RegExp);

  // 更正语境：同一行里出现豁免标记 → 不计违规
  const correction = 'S7 §1.1 已更正：CICC 四维各 25% 的说法有误，本平台改为六维权重表。\n';
  const ok = scanText(correction, parsed.terms, { file: 'docs/spec.md' });
  assert.equal(ok.violations.length, 0, '更正语境不得被拦下');
  assert.equal(ok.exempted.length, 1, '更正语境必须被记录（豁免不静默）');

  // 没有豁免标记的裸引用 → 必须拦下
  const bare = 'CICC 四维各 25% 是行业通行做法。\n';
  const bad = scanText(bare, parsed.terms, { file: 'docs/spec.md' });
  assert.equal(bad.violations.length, 1, '裸引用必须被拦下');
});

test('仓库自带清单里必须有「CICC 四维各 25%」的更正语境豁免条目', () => {
  const text = readFileSync(join(here, '..', 'scripts', 'forbidden.txt'), 'utf8');
  const parsed = parseManifest(text);
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  const cicc = parsed.terms.find((t) => t.term.includes('CICC'));
  assert.ok(cicc, '清单里必须有 CICC 相关词条');
  assert.ok(cicc.exemptRegex instanceof RegExp, 'CICC 词条必须带豁免正则（更正语境要能出现）');
  assert.ok(!cicc.term.includes('?'), '词条是字面串，不能用 ? 占位（否则永远命中不了）');
  assert.ok(!cicc.term.includes('.*'), '词条是字面串，不能写正则片段');
});

test('平台自身不依赖用户机器上的 evidence-chain skill（增强不可用也不影响结论）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-ev-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '禁用词Y\n', 'utf8');
  const clean = join(dir, 'clean.md');
  writeFileSync(clean, '这里没有任何禁用词\n', 'utf8');
  const code = main([
    '--forbidden', manifest,
    '--evidence-chain', '/绝对不存在的路径/audit-evidence.js',
    clean,
  ]);
  assert.equal(code, 0, '增强不可用时不得把闸判成失败（平台必须能独立跑）');
  rmSync(dir, { recursive: true, force: true });
});

test('发布产物目录也必须过闸（--forbidden 可指定别的清单）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '禁用词X\n', 'utf8');
  const target = join(dir, 'a.md');
  writeFileSync(target, '这里有禁用词X\n', 'utf8');
  const code = main(['--forbidden', manifest, target]);
  assert.equal(code, 1, '命中禁用词必须返回非 0（发布中止）');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/audit-scan-release.test.js`
Expected: FAIL —— `main(['--evidence-chain', ...])` 返回值不是 0（参数未实现），或 `--forbidden` 未生效

- [ ] **Step 3: 修改 `scripts/audit-scan.js`**

在 P4 的 `main(argv)` 里加上参数解析与发布产物扫描。**保留 P4 已有的所有行为**（清单为空报错、豁免语境、排除项打印）：

```javascript
/**
 * 命令行入口。
 * P4 已有：node scripts/audit-scan.js [root...]
 * P6 追加：--forbidden <path>  指定别的清单（试跑用，不动默认清单）
 *          --json             机器可读输出
 *          --evidence-chain <path>
 *          可选增强：复用 evidence-chain skill 的 audit-evidence.js。
 *          ⚠️ 平台自身必须能独立跑：找不到该脚本时只打印一行说明并继续，
 *             绝不影响本闸结论（工具失败不应成为跳过检查的理由）。
 */
export function main(argv = []) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..');

  let manifestPath = join(here, 'forbidden.txt');
  let evidenceChainPath = null;
  let asJson = false;
  const roots = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { asJson = true; continue; }
    if (a === '--forbidden') { manifestPath = argv[i + 1] || manifestPath; i += 1; continue; }
    if (a === '--evidence-chain') { evidenceChainPath = argv[i + 1] || null; i += 1; continue; }
    roots.push(a);
  }

  if (!existsSync(manifestPath)) {
    console.error('[audit-scan] 禁用清单缺失：scripts/forbidden.txt —— 闸未生效，发布中止');
    return 2;
  }
  const parsed = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (parsed.errors.length) {
    console.error('[audit-scan] 禁用清单不合规：');
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 2;
  }

  // 默认扫描范围：仓库 docs/ + platform/ + 发布产物 platform/web/dist/（存在才扫）
  const targets = roots.length ? roots : [join(repoRoot, 'docs'), join(repoRoot, 'platform')];
  const distDir = join(repoRoot, 'platform', 'web', 'dist');

  const report = scanRoots(targets, { terms: parsed.terms, skipPaths: parsed.skipPaths });

  // 发布产物单独扫一遍：
  // ⚠️ P4 的 DEFAULT_EXCLUDES 里有 'dist'，主扫描会把它当构建目录跳过 —— 但这里要扫的
  //    恰恰是【我们自己发布的静态站】，所以显式传 excludePaths: []（只扫我们自己产出的文件）。
  if (!roots.length && existsSync(distDir)) {
    const distReport = scanRoots([distDir], {
      terms: parsed.terms,
      skipPaths: parsed.skipPaths,
      excludePaths: [],
    });
    report.violations.push(...distReport.violations);
    report.exempted.push(...distReport.exempted);
    report.scannedFiles.push(...distReport.scannedFiles);
    report.excludedPaths.push(...distReport.excludedPaths);
  }
  const evidence = runEvidenceChain(evidenceChainPath, targets);

  if (asJson) {
    console.log(JSON.stringify({
      manifest: manifestPath,
      terms: parsed.terms.length,
      scannedFiles: report.scannedFiles.length,
      violations: report.violations,
      exempted: report.exempted,
      excludedPaths: report.excludedPaths,
      evidenceChain: evidence,
    }, null, 2));
  } else {
    console.log(`[audit-scan] 词条 ${parsed.terms.length} 条｜扫描 ${report.scannedFiles.length} 个文件`);
    console.log(`[audit-scan] 排除 ${report.excludedPaths.length} 项（排除不静默）：`);
    for (const e of report.excludedPaths.slice(0, 50)) console.log(`  - ${e.path}（${e.reason}）`);
    if (report.exempted.length) {
      console.log(`[audit-scan] 豁免命中 ${report.exempted.length} 处（更正语境，不计违规）：`);
      for (const e of report.exempted) console.log(`  - ${e.file}:${e.line} 「${e.term}」`);
    }
    if (report.violations.length) {
      console.error(`[audit-scan] ✗ 发现 ${report.violations.length} 处禁用表述：`);
      for (const v of report.violations) console.error(`  - ${v.file}:${v.line} 「${v.term}」 ${v.text}`);
    } else {
      console.log('[audit-scan] ✓ 未发现禁用表述');
    }
    if (evidence.available) {
      console.log(`[audit-scan] evidence-chain 增强报告（${evidence.path}）：`);
      console.log(evidence.output.trim());
    } else {
      console.log(`[audit-scan] evidence-chain 增强不可用：${evidence.reason}（不影响本闸结论）`);
    }
  }

  return report.violations.length ? 1 : 0;
}

/**
 * 可选增强：复用 evidence-chain skill 的 audit-evidence.js。
 * ⛔ 平台自身必须能独立跑：找不到就返回 available=false，不影响闸结论。
 */
function runEvidenceChain(scriptPath, targets) {
  const candidates = [
    scriptPath,
    join(process.env.HOME || '', '.minimax', 'skills', 'evidence-chain', 'scripts', 'audit-evidence.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const res = spawnSync(process.execPath, [p, ...targets], { encoding: 'utf8' });
      return { available: true, path: p, output: `${res.stdout || ''}${res.stderr || ''}` };
    } catch (err) {
      return { available: false, path: p, reason: `执行失败：${err.message}` };
    }
  }
  return { available: false, path: null, reason: '未找到 evidence-chain 扫描器（可选增强）' };
}
```

并在文件顶部补一行 import：

```javascript
import { spawnSync } from 'node:child_process';
```

- [ ] **Step 4: 修改 `scripts/forbidden.txt`（追加 P6 词条 + 修正 P4 词条的字面匹配问题）**

> **⚠️ 匹配语义（必须知道，否则清单写了也不生效）**
> P4 的 `scanText()` 用的是 **`line.includes(term)` —— 字面串匹配，不是正则**。
> 所以词条里写 `?` 或 `.*` **永远不会命中**（`四维各 ?25%` 匹配不到 `四维各 25%`）。
> **本项目自带的 `platform/scripts/forbidden.txt` 的既有约定就是「空格变体各写一条」**
> （`积分占决赛30%` 与 `积分占决赛 30%` 分两行列出）—— 本阶段沿用这个约定。

在 P4 已有的内容后面**追加**（不要删改 P4 的其它词条），并把 P4 里带 `?` 的两条**拆成空格变体**：

```text
# ── P6 追加（部署与演示版）────────────────────────────────────
#
# 演示版种子数据与部署文档也必须过闸：发布产物 web/dist/ 会被一起扫描。
# 生成目录不扫（它们是上面源文件的拷贝，扫源就够）。
@skip-path ^platform/web/dist/
@skip-path ^platform/data/
#
# 「CICC 四维各 25%」必须能在【更正语境】里出现（说明当初错在哪），
# 但裸引用（当作现行规则）必须被拦下 —— 这就是 词条|豁免正则 的用法。
# ⚠️ 词条是字面串，空格变体各写一条。
CICC 四维各25%|已更正|S7 §1.1|不是|六维
CICC 四维各 25%|已更正|S7 §1.1|不是|六维
#
# 行为分进总分的其它变体（S10 §3.3：行为分只做垫底排序，不进总分）
行为分进入总分|已更正|S10 §3.3|只做垫底排序
行为分算进总分|已更正|S10 §3.3|只做垫底排序
```

同时把 P4 的两条带 `?` 的词条**替换成空格变体**（否则它们永远命中不了 = 闸形同虚设）：

```text
# P4 原文（带 ? 的字面串永远命中不了）→
# 初赛企业确认权重 ?20%|C-01|冲突|裁决|已更正
# w_E ?= ?20%.*初赛|C-01|冲突|裁决|已更正
# 四维各 ?25%|原表述|有误|已更正|CICC[^，。]*已
# ↓ P6 改为（字面串 + 空格变体各一条，豁免正则不变）：
初赛企业确认权重20%|C-01|冲突|裁决|已更正
初赛企业确认权重 20%|C-01|冲突|裁决|已更正
四维各25%|原表述|有误|已更正|CICC[^，。]*已
四维各 25%|原表述|有误|已更正|CICC[^，。]*已
```

> ⚠️ `w_E ?= ?20%.*初赛` 这一条**整条删掉**：它把正则片段（`.*`）写进了字面串，
> 在字面匹配下没有意义；要覆盖「初赛 w_E 20%」这类表述，用上面两条
> `初赛企业确认权重20%` / `初赛企业确认权重 20%` 已经够。
> **改完后必须跑一次 `node scripts/audit-scan.js` 确认退出码仍是 0**（没有误伤）。

- [ ] **Step 4b: 实跑一次扫描闸，确认改词条没有误伤**

Run: `cd platform && node scripts/audit-scan.js`
Expected: 输出 `[audit-scan] 词条 N 条｜扫描 M 个文件` … `[audit-scan] ✓ 未发现禁用表述`，退出码 0
（若出现命中，多半是豁免正则的标记词（如「已更正」）没写在那行上 → 补标记或改词条，**不要**删掉词条）

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/audit-scan-release.test.js`
Expected: PASS（6 个测试全过）

Run: `cd platform && node scripts/audit-scan.js`
Expected: 输出 `[audit-scan] 词条 N 条｜扫描 M 个文件` … `[audit-scan] ✓ 未发现禁用表述`，退出码 0

- [ ] **Step 6: 提交**

```bash
cd platform && git add scripts/audit-scan.js scripts/forbidden.txt test/audit-scan-release.test.js
git commit -m "feat(P6): 发布前扫描闸接发布产物 + 更正语境豁免 + 可选 evidence-chain 增强"
```

---

### Task 4: 演示版种子数据（`web/seed/demo-data.json`）

**Files:**
- Create: `platform/web/seed/demo-data.json`
- Test: `platform/test/demo-seed.test.js`

**Interfaces:**
- Consumes: 无（纯数据）
- Produces: 一份**能触发每一条 trace 分支**的种子数据。结构见下，`web/api.demo.js` 按此结构读取。

> **⚠️ 本 Task 的灵魂**
> **种子数据不是"好看的假数据"，而是"每一条 trace 分支的触发器"。** 演示版的价值在于：
> 点一下"计算"，就能看到 z-score 降级、去极值、双签告警、破同分链、自评差异、段位判定**全部真实发生**。
> → 所以每条设计好的分支都要在种子里**有对应的一条数据**，并在 `expectations` 块里写明"预期会发生什么"，
> 让测试能**机器校验**（Task 5 的 `demo-engine.test.js` 逐条断言）。

**种子数据结构（`web/api.demo.js` 按此读取）**

| 键 | 类型 | 说明 |
|---|---|---|
| `meta` | object | 版本、说明、规则版本 |
| `edition` | object | 届期 |
| `users` | `[{id, name, mbaStatus}]` | 演示用户（`mbaStatus` 用于组长硬门槛判定） |
| `taskPackages` | `[{id, title, enterpriseId, enterpriseName, isFreeBrief, grade, commitment}]` | 任务包（含 1 个自由命题） |
| `judges` | `[{id, name, seat}]` | 评委池（`seat` = `expert` / `enterprise`） |
| `teams` | `[{id, name, packageId, captainId, memberIds}]` | 战队 |
| `reviews` | `{ [judgeId]: { [teamId]: { [dimension]: rawScore } } }` | 打分矩阵 |
| `enterpriseConfirmations` | `[{id, teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content}]` | 企业确认 |
| `peerReviews` | `[{fromTeamId, toTeamId, score}]` | 互评 |
| `selfReviews` | `[{teamId, dimension, rawScore}]` | 自评（用于自评差异检测） |
| `milestones` | `[{teamId, key, achieved, countsTowardTier, isDataOrPrototype}]` | 里程碑 |
| `signoffs` | `[{teamId, milestoneKey, department, revokedAt, isBusinessDepartment}]` | 企业签字 |
| `behaviorEvents` | `[{id, teamId, type, evidence, created_at}]` | 行为分事件 |
| `expectations` | object | **预期触发的分支**（测试据此断言） |

- [ ] **Step 1: 写失败的测试**

`platform/test/demo-seed.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(here, '..', 'rules'));

test('种子数据结构完整', () => {
  for (const key of [
    'meta', 'edition', 'users', 'taskPackages', 'judges', 'teams',
    'reviews', 'enterpriseConfirmations', 'peerReviews', 'selfReviews',
    'milestones', 'signoffs', 'behaviorEvents', 'expectations',
  ]) {
    assert.ok(seed[key] !== undefined, `种子缺少 ${key}`);
  }
  assert.ok(seed.teams.length >= 4, '至少 4 支队伍');
  assert.ok(seed.judges.length >= 5, '至少 5 位评委');
});

test('打分矩阵的维度都必须是规则里存在的维度', () => {
  const valid = new Set(rules.scoring.final.dimensions.map((d) => d.key));
  for (const [judgeId, byTeam] of Object.entries(seed.reviews)) {
    for (const [teamId, byDim] of Object.entries(byTeam)) {
      for (const dim of Object.keys(byDim)) {
        assert.ok(valid.has(dim), `维度 ${dim} 不在 rules.scoring.final 里（评委 ${judgeId} 队 ${teamId}）`);
        assert.equal(typeof byDim[dim], 'number', '分数必须是数字');
      }
    }
  }
});

test('每个期望的同分队伍在所有评委的所有维度上原始分完全相同（保证真的同分）', () => {
  const [a, b] = seed.expectations.tiedTeams;
  for (const [judgeId, byTeam] of Object.entries(seed.reviews)) {
    if (!byTeam[a] || !byTeam[b]) continue;
    assert.deepEqual(byTeam[a], byTeam[b], `评委 ${judgeId} 给 ${a}/${b} 的分必须完全相同`);
  }
  // 企业确认也要相同，否则总分不可能相等
  const ca = seed.enterpriseConfirmations.filter((c) => c.teamId === a);
  const cb = seed.enterpriseConfirmations.filter((c) => c.teamId === b);
  assert.equal(ca.length, cb.length);
  for (let i = 0; i < ca.length; i += 1) {
    assert.equal(ca[i].rawScore, cb[i].rawScore, '企业确认原始分也必须相同');
  }
});

test('存在一个评委样本不足的维度（用于演示归一化降级告警）', () => {
  const dim = seed.expectations.unnormalizedDimension;
  const judge = seed.expectations.unnormalizedJudge;
  const samples = Object.keys(seed.reviews[judge] ?? {}).filter(
    (teamId) => seed.reviews[judge][teamId][dim] !== undefined,
  );
  assert.ok(samples.length < rules.scoring.final.minSamplesForJudgeNormalization,
    `评委 ${judge} 在维度 ${dim} 上的样本数必须小于 ${rules.scoring.final.minSamplesForJudgeNormalization}`);
});

test('存在一个缺双签的企业确认（用于演示 R2 告警）', () => {
  const teamId = seed.expectations.missingDualSignatureTeam;
  const mine = seed.enterpriseConfirmations.filter((c) => c.teamId === teamId);
  assert.ok(mine.length > 0, `${teamId} 必须有企业确认记录`);
  assert.ok(mine.some((c) => !c.crossJudgeId || !c.signatoryUserId),
    `${teamId} 必须有一条缺双签的企业确认`);
});

test('存在一个自由命题队伍（用于演示 R4）', () => {
  const teamId = seed.expectations.freeBriefTeam;
  const team = seed.teams.find((t) => t.id === teamId);
  assert.ok(team, '自由命题队必须在队伍列表里');
  const pkg = seed.taskPackages.find((p) => p.id === team.packageId);
  assert.ok(pkg, '自由命题队必须挂在某个任务包上');
  assert.equal(pkg.isFreeBrief, true, '任务包必须标记为自由命题');
});

test('每支队伍都有互评（否则破同分链的 peer 键不可用）', () => {
  for (const t of seed.teams) {
    const incoming = seed.peerReviews.filter((p) => p.toTeamId === t.id);
    assert.ok(incoming.length > 0, `${t.id} 没有任何互评`);
  }
});

test('expectations 覆盖了全部要演示的 trace 分支', () => {
  const e = seed.expectations;
  for (const key of [
    'tiedTeams', 'tiebreakSeparatedBy', 'unnormalizedDimension', 'unnormalizedJudge',
    'missingDualSignatureTeam', 'freeBriefTeam', 'selfEvalWrittenExplanationTeam',
    'selfEvalJudgeQuestionTeam', 'tiers',
  ]) {
    assert.ok(e[key] !== undefined, `expectations 缺少 ${key}`);
  }
  assert.equal(e.tiedTeams.length, 2, '必须正好是两支同分队伍');
  assert.deepEqual(Object.keys(e.tiers).sort(), seed.teams.map((t) => t.id).sort());
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/demo-seed.test.js`
Expected: FAIL —— `ENOENT: no such file or directory, open 'platform/web/seed/demo-data.json'`

- [ ] **Step 3: 创建 `web/seed/demo-data.json`**

```json
{
  "meta": {
    "id": "demo-2026-10-20",
    "title": "演示数据 · 一字 AI 商业黑客松",
    "ruleVersion": "2026-10-20",
    "note": "演示数据不跨人共享（各自浏览器独立）。每条 trace 分支都有对应数据，见 expectations。"
  },
  "edition": { "id": "ed_demo", "name": "2026 一字 AI 商业黑客松（演示）", "city": "杭州" },
  "users": [
    { "id": "mba_captain", "name": "演示队长（MBA）", "mbaStatus": "mba" },
    { "id": "mba_captain2", "name": "演示队长乙（MBA）", "mbaStatus": "mba" },
    { "id": "demo_member_1", "name": "演示组员甲", "mbaStatus": "member" },
    { "id": "demo_member_2", "name": "演示组员乙", "mbaStatus": "member" },
    { "id": "demo_member_3", "name": "演示组员丙", "mbaStatus": "other" }
  ],
  "taskPackages": [
    { "id": "tp_retail", "title": "门店缺货预测与补货建议", "enterpriseId": "ent_demo_retail", "enterpriseName": "演示零售集团", "isFreeBrief": false, "grade": "A", "commitment": "试点承诺" },
    { "id": "tp_manu", "title": "质检工单智能分派", "enterpriseId": "ent_demo_mfg", "enterpriseName": "演示制造集团", "isFreeBrief": false, "grade": "B", "commitment": "对标试点" },
    { "id": "tp_free", "title": "自由命题 · 社区助餐排班", "enterpriseId": null, "enterpriseName": null, "isFreeBrief": true, "grade": null, "commitment": "无" }
  ],
  "judges": [
    { "id": "j_lenient", "name": "评委甲（宽松）", "seat": "expert" },
    { "id": "j_strict", "name": "评委乙（严格）", "seat": "expert" },
    { "id": "j_mid1", "name": "评委丙", "seat": "expert" },
    { "id": "j_mid2", "name": "评委丁", "seat": "expert" },
    { "id": "j_cross", "name": "评委戊（跨领域）", "seat": "expert" },
    { "id": "j_partial", "name": "评委己（只交了一份打分）", "seat": "expert" }
  ],
  "teams": [
    { "id": "t_alpha", "name": "拾光队", "packageId": "tp_retail", "captainId": "mba_captain", "memberIds": ["mba_captain", "demo_member_1", "demo_member_2"] },
    { "id": "t_beta", "name": "回声队", "packageId": "tp_retail", "captainId": "mba_captain2", "memberIds": ["mba_captain2", "demo_member_3"] },
    { "id": "t_gamma", "name": "北斗队", "packageId": "tp_manu", "captainId": "mba_captain", "memberIds": ["mba_captain", "demo_member_1"] },
    { "id": "t_delta", "name": "风信子队", "packageId": "tp_manu", "captainId": "mba_captain2", "memberIds": ["mba_captain2", "demo_member_2", "demo_member_3"] },
    { "id": "t_epsilon", "name": "自由花队", "packageId": "tp_free", "captainId": "mba_captain", "memberIds": ["mba_captain", "demo_member_1"] }
  ],
  "reviews": {
    "j_lenient": { "t_alpha": { "track_fit": 86, "innovation": 88, "feasibility": 84, "completeness": 85, "collaboration": 90 }, "t_beta": { "track_fit": 86, "innovation": 88, "feasibility": 84, "completeness": 85, "collaboration": 90 }, "t_gamma": { "track_fit": 74, "innovation": 70, "feasibility": 78, "completeness": 72, "collaboration": 75 }, "t_delta": { "track_fit": 80, "innovation": 82, "feasibility": 79, "completeness": 81, "collaboration": 78 }, "t_epsilon": { "track_fit": 70, "innovation": 66, "feasibility": 72, "completeness": 68, "collaboration": 70 } },
    "j_strict": { "t_alpha": { "track_fit": 72, "innovation": 74, "feasibility": 70, "completeness": 73, "collaboration": 75 }, "t_beta": { "track_fit": 72, "innovation": 74, "feasibility": 70, "completeness": 73, "collaboration": 75 }, "t_gamma": { "track_fit": 60, "innovation": 58, "feasibility": 64, "completeness": 61, "collaboration": 62 }, "t_delta": { "track_fit": 66, "innovation": 68, "feasibility": 63, "completeness": 65, "collaboration": 64 }, "t_epsilon": { "track_fit": 56, "innovation": 52, "feasibility": 58, "completeness": 55, "collaboration": 57 } },
    "j_mid1": { "t_alpha": { "track_fit": 80, "innovation": 81, "feasibility": 77, "completeness": 79, "collaboration": 83 }, "t_beta": { "track_fit": 80, "innovation": 81, "feasibility": 77, "completeness": 79, "collaboration": 83 }, "t_gamma": { "track_fit": 68, "innovation": 65, "feasibility": 70, "completeness": 66, "collaboration": 69 }, "t_delta": { "track_fit": 74, "innovation": 76, "feasibility": 72, "completeness": 75, "collaboration": 71 }, "t_epsilon": { "track_fit": 63, "innovation": 60, "feasibility": 65, "completeness": 61, "collaboration": 64 } },
    "j_mid2": { "t_alpha": { "track_fit": 78, "innovation": 79, "feasibility": 76, "completeness": 77, "collaboration": 81 }, "t_beta": { "track_fit": 78, "innovation": 79, "feasibility": 76, "completeness": 77, "collaboration": 81 }, "t_gamma": { "track_fit": 67, "innovation": 64, "feasibility": 69, "completeness": 67, "collaboration": 68 }, "t_delta": { "track_fit": 73, "innovation": 75, "feasibility": 71, "completeness": 74, "collaboration": 70 }, "t_epsilon": { "track_fit": 62, "innovation": 59, "feasibility": 64, "completeness": 60, "collaboration": 63 } },
    "j_cross": { "t_alpha": { "track_fit": 82, "innovation": 83, "feasibility": 80, "completeness": 81, "collaboration": 85 }, "t_beta": { "track_fit": 82, "innovation": 83, "feasibility": 80, "completeness": 81, "collaboration": 85 }, "t_gamma": { "track_fit": 71, "innovation": 69, "feasibility": 73, "completeness": 70, "collaboration": 72 }, "t_delta": { "track_fit": 77, "innovation": 79, "feasibility": 75, "completeness": 78, "collaboration": 76 }, "t_epsilon": { "track_fit": 66, "innovation": 63, "feasibility": 67, "completeness": 65, "collaboration": 67 } },
    "j_partial": { "t_gamma": { "feasibility": 90 } }
  },
  "enterpriseConfirmations": [
    { "id": "ec_alpha", "teamId": "t_alpha", "enterpriseId": "ent_demo_retail", "dimension": "enterprise", "rawScore": 82, "crossJudgeId": "j_cross", "signatoryUserId": "u_ent_retail", "content": "解决门店缺货预测环节，预计 2 周内接入试点，我方投入数据接口" },
    { "id": "ec_beta", "teamId": "t_beta", "enterpriseId": "ent_demo_retail", "dimension": "enterprise", "rawScore": 82, "crossJudgeId": "j_cross", "signatoryUserId": "u_ent_retail", "content": "解决门店缺货预测环节，预计 2 周内接入试点，我方投入数据接口" },
    { "id": "ec_gamma", "teamId": "t_gamma", "enterpriseId": "ent_demo_mfg", "dimension": "enterprise", "rawScore": 75, "crossJudgeId": null, "signatoryUserId": "u_ent_mfg", "content": "解决质检工单分派环节，预计 4 周内对标试点" },
    { "id": "ec_delta", "teamId": "t_delta", "enterpriseId": "ent_demo_mfg", "dimension": "enterprise", "rawScore": 80, "crossJudgeId": "j_cross", "signatoryUserId": "u_ent_mfg", "content": "解决质检工单分派环节，预计 4 周内对标试点" }
  ],
  "peerReviews": [
    { "fromTeamId": "t_gamma", "toTeamId": "t_alpha", "score": 70 },
    { "fromTeamId": "t_delta", "toTeamId": "t_alpha", "score": 72 },
    { "fromTeamId": "t_gamma", "toTeamId": "t_beta", "score": 60 },
    { "fromTeamId": "t_delta", "toTeamId": "t_beta", "score": 58 },
    { "fromTeamId": "t_alpha", "toTeamId": "t_gamma", "score": 65 },
    { "fromTeamId": "t_beta", "toTeamId": "t_gamma", "score": 66 },
    { "fromTeamId": "t_alpha", "toTeamId": "t_delta", "score": 68 },
    { "fromTeamId": "t_epsilon", "toTeamId": "t_delta", "score": 67 },
    { "fromTeamId": "t_alpha", "toTeamId": "t_epsilon", "score": 60 },
    { "fromTeamId": "t_beta", "toTeamId": "t_epsilon", "score": 61 }
  ],
  "selfReviews": [
    { "teamId": "t_alpha", "dimension": "innovation", "rawScore": 95 },
    { "teamId": "t_gamma", "dimension": "innovation", "rawScore": 50 },
    { "teamId": "t_beta", "dimension": "innovation", "rawScore": 81 }
  ],
  "milestones": [
    { "teamId": "t_alpha", "key": "problem_confirmed", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": false },
    { "teamId": "t_alpha", "key": "data_connected", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": true },
    { "teamId": "t_beta", "key": "problem_confirmed", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": false },
    { "teamId": "t_gamma", "key": "problem_confirmed", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": false },
    { "teamId": "t_gamma", "key": "data_connected", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": true },
    { "teamId": "t_gamma", "key": "demo_ready", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": true },
    { "teamId": "t_delta", "key": "problem_confirmed", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": false },
    { "teamId": "t_delta", "key": "data_connected", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": true },
    { "teamId": "t_delta", "key": "demo_ready", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": true },
    { "teamId": "t_delta", "key": "pilot_contract", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": false },
    { "teamId": "t_delta", "key": "iterations", "achieved": true, "countsTowardTier": true, "isDataOrPrototype": false }
  ],
  "signoffs": [
    { "teamId": "t_delta", "milestoneKey": "pilot_contract", "department": "业务部", "revokedAt": null, "isBusinessDepartment": true },
    { "teamId": "t_gamma", "milestoneKey": "problem_confirmed", "department": "技术部", "revokedAt": null, "isBusinessDepartment": false }
  ],
  "behaviorEvents": [
    { "id": "be_1", "teamId": "t_alpha", "type": "weekly_progress", "evidence": "第 1 周进度", "created_at": "2026-10-12T10:00:00Z" },
    { "id": "be_2", "teamId": "t_alpha", "type": "weekly_progress", "evidence": "第 2 周进度", "created_at": "2026-10-19T10:00:00Z" },
    { "id": "be_3", "teamId": "t_alpha", "type": "workshop_output", "evidence": "workshop 课后产出", "created_at": "2026-10-19T12:00:00Z" },
    { "id": "be_4", "teamId": "t_alpha", "type": "first_demo", "evidence": "首次可运行 Demo", "created_at": "2026-10-20T09:00:00Z" },
    { "id": "be_5", "teamId": "t_beta", "type": "weekly_progress", "evidence": "第 1 周进度", "created_at": "2026-10-12T10:00:00Z" },
    { "id": "be_6", "teamId": "t_delta", "type": "weekly_progress", "evidence": "第 1 周进度", "created_at": "2026-10-12T10:00:00Z" },
    { "id": "be_7", "teamId": "t_delta", "type": "milestone_on_time", "evidence": "按时交付里程碑", "created_at": "2026-10-18T10:00:00Z" },
    { "id": "be_8", "teamId": "t_gamma", "type": "enterprise_meeting", "evidence": "完成一次企业对接会", "created_at": "2026-10-17T10:00:00Z" }
  ],
  "expectations": {
    "tiedTeams": ["t_alpha", "t_beta"],
    "tiebreakSeparatedBy": "peer",
    "unnormalizedDimension": "feasibility",
    "unnormalizedJudge": "j_partial",
    "missingDualSignatureTeam": "t_gamma",
    "freeBriefTeam": "t_epsilon",
    "selfEvalWrittenExplanationTeam": "t_alpha",
    "selfEvalJudgeQuestionTeam": "t_gamma",
    "tiers": { "t_alpha": "B", "t_beta": "C", "t_gamma": "A", "t_delta": "S", "t_epsilon": "D" }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/demo-seed.test.js`
Expected: PASS（7 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd platform && git add web/seed test/demo-seed.test.js
git commit -m "feat(P6): 演示种子数据（每条 trace 分支都有触发器 + expectations 断言块）"
```

---

### Task 5: 演示版适配器（浏览器内真实运行规则引擎）

**Files:**
- Modify: `platform/web/api.demo.js`（P0 建的 3 接口桩 → 完整流程）
- Test: `platform/test/demo-engine.test.js`
- Test: `platform/test/demo-parity.test.js`

**Interfaces:**
- Consumes（**只读消费**，不改签名）：
  - `src/domain/registration.js` → `scoreRegistration({ answers, config })`、`classifyLevel(score, config)`、`validateRegistrationAnswers(answers, config)`
  - `src/domain/solvability.js` → `scoreSolvability({ answers, config })`
  - `src/domain/scoring.js` → `scoreStage({ config, judges, submissions, enterpriseConfirmations, peerReviews, teams, selfReviews })`
  - `src/domain/enterprise-seat.js` → `applyEnterpriseRules({ confirmations, teams, judges, config })`
  - `src/domain/self-eval.js` → `detectSelfEvalDiff({ selfReviews, judgeScores, threshold })`
  - `src/domain/ranking.js` → `rankTeams({ teams, tiebreakChain, tiebreakData, pointsConfig })`
  - `src/domain/points.js` → `computeStagePoints({ ordered, pointsConfig })`
  - `src/domain/tier.js` → `computeTier({ milestones, signoffs, ranksConfig })`
  - `src/domain/behavior.js` → `behaviorScore({ events, behaviorConfig })`
  - `src/domain/visibility.js` → `applyVisibility({ payload, viewer, visibilityConfig, context })`
- Produces:
  - `buildDemoState(seed)` → store
  - `expandSubmissions(state)` → `[{ judgeId, teamId, dimension, rawScore }]`
  - `demoTeamsRoster(state)` → `[{ teamId, packageEnterpriseId, isFreeBrief }]`
  - `runDemoCompute({ state, rules, stageId })` → `{ computationId, teams, warnings, trace, ordered, chain, points, selfEvalFlags }`
  - `demoLeaderboard({ state, rules, scope, viewer })`
  - `demoTier({ state, rules, teamId })`
  - `demoPerformanceCard({ state, rules, teamId })`
  - `demoPools({ state, rules, kind })`
  - `demoSelfEvalFlags({ state, threshold })`
  - `createDemoApi({ storage, seed, rules })` → `{ get, post, patch, del, subscribe }`（与 `web/api.js` 同名接口）
  - `loadDemoSeed(url)` / `loadDemoRules(base)`（浏览器侧取种子与规则）

> **⚠️ 本 Task 的灵魂：演示版 = 静态站 + 浏览器内跑同一套规则引擎**
> **为什么这样做**（设计文档 §14.3 的兜底设计）：公网**正式版**后端需要云主机，而**当前没有云账号 / 隧道 / Docker 环境**；
> 静态站发布工具只能发布**静态文件**（要求目录里有 `index.html`），**不能跑 Node 后端**。
> → 所以公网演示版 = **同源静态前端 + `api.demo.js`（localStorage 适配器）**，数据不跨人共享（各自浏览器独立）。
> **✅ 但规则引擎在浏览器里真实运行** —— 演示出来的算法行为与正式系统一致，不会出现"演示好看、正式不一样"。
> **⛔ 正式版后端仍要按云主机部署资产准备好**（Task 2 的 systemd / nginx / docker-compose / install.sh + Task 1 的备份恢复），
> 这样拿到云主机就能一键起。
>
> **⚠️ 由此给 P2/P3 领域层加的硬约束**：`src/domain/*` 是纯函数 ESM，**不得 import 任何 Node 内置模块**
> （`node:fs` / `node:path` / `node:crypto` …），否则浏览器跑不起来。
> **这条约束由 `scripts/build-demo.js` 在构建时强制校验**（Task 6），违反即构建失败。
> 本 Task 的 `web/api.demo.js` 因此**直接用相对路径 import** `../src/domain/scoring.js` 等——**不需要打包器**。

- [ ] **Step 1: 写失败的测试**

`platform/test/demo-engine.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import {
  buildDemoState, expandSubmissions, runDemoCompute, demoSelfEvalFlags,
  demoTier, demoPerformanceCard, demoLeaderboard, demoPools, createDemoApi,
} from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(here, '..', 'rules'));

function fresh() {
  return buildDemoState(seed);
}

test('打分矩阵能展开成 submissions', () => {
  const state = fresh();
  const subs = expandSubmissions(state);
  assert.ok(subs.length > 0);
  const first = subs[0];
  for (const k of ['judgeId', 'teamId', 'dimension', 'rawScore']) {
    assert.ok(k in first, `submissions 缺字段 ${k}`);
  }
  assert.equal(typeof first.rawScore, 'number');
});

test('两支设计为同分的队伍总分完全相等（构造保证，不靠手算）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assert.ok(ta && tb, '两支队伍都必须参与计算');
  assert.equal(ta.total, tb.total, '同分队伍的总分必须完全相等');
});

test('破同分链把同分队伍分开，且分开的那一级是 peer', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const ra = out.ordered.find((r) => r.teamId === a);
  const rb = out.ordered.find((r) => r.teamId === b);
  assert.notEqual(ra.rank, rb.rank, '同分队伍必须被破同分链分开');
  assert.ok(ra.rank < rb.rank, '互评分高的一方名次在前');
  const used = out.chain.find((c) => c.key === seed.expectations.tiebreakSeparatedBy);
  assert.ok(used, `破同分链里必须用到 ${seed.expectations.tiebreakSeparatedBy} 这一级`);
});

test('评委样本不足的维度会产生归一化降级告警（不静默）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const dim = seed.expectations.unnormalizedDimension;
  const label = rules.scoring.final.dimensions.find((d) => d.key === dim).name;
  const hit = out.warnings.find(
    (w) => w.code === 'normalization_fallback' && (String(w.message).includes(dim) || String(w.message).includes(label)),
  );
  assert.ok(hit, `必须出现维度 ${dim} 的归一化降级告警，实际告警：${JSON.stringify(out.warnings.map((w) => w.code))}`);
  assert.ok(out.trace && out.trace.normalization, 'trace 必须带 normalization 段');
  assert.ok(Object.keys(out.trace.normalization).length > 0, 'trace.normalization 不能是空的');
});

test('缺双签的企业确认会产生 R2 告警并按 0 分计', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const teamId = seed.expectations.missingDualSignatureTeam;
  const hit = out.warnings.find((w) => w.code === 'R2_missing_dual_signature');
  assert.ok(hit, '必须出现 R2_missing_dual_signature 告警');
  assert.ok(!hit.teamId || hit.teamId === teamId, `告警应指向 ${teamId}`);
});

test('行为分变化不影响总分（分轨在算法层，不靠人的自觉）', () => {
  const stateA = fresh();
  const stateB = fresh();
  stateB.behaviorEvents = stateB.behaviorEvents.map((e) => ({ ...e, points: 999, type: 'first_demo' }));
  const a = runDemoCompute({ state: stateA, rules, stageId: 'stage_final' });
  const b = runDemoCompute({ state: stateB, rules, stageId: 'stage_final' });
  const totalsA = a.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  const totalsB = b.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.deepEqual(totalsB, totalsA, '行为分变化不得影响总分');
});

test('自评差异检测：高的要书面说明，低的要评委提问', () => {
  const state = fresh();
  const flags = demoSelfEvalFlags({ state, threshold: 10 });
  const hi = seed.expectations.selfEvalWrittenExplanationTeam;
  const lo = seed.expectations.selfEvalJudgeQuestionTeam;
  const fHi = flags.find((f) => f.teamId === hi);
  const fLo = flags.find((f) => f.teamId === lo);
  assert.ok(fHi, `${hi} 必须触发自评差异告警`);
  assert.equal(fHi.action, 'written_explanation');
  assert.ok(fHi.d > 10);
  assert.ok(fLo, `${lo} 必须触发自评差异告警`);
  assert.equal(fLo.action, 'judge_question');
  assert.ok(fLo.d < -10);
});

test('段位按里程碑与业务部门签字判定', () => {
  const state = fresh();
  for (const [teamId, tier] of Object.entries(seed.expectations.tiers)) {
    const info = demoTier({ state, rules, teamId });
    assert.equal(info.tier, tier, `${teamId} 的段位应为 ${tier}，实际 ${info.tier}`);
  }
});

test('战绩卡：7 类里程碑勾选式，且不出现签字人', () => {
  const state = fresh();
  const card = demoPerformanceCard({ state, rules, teamId: 't_delta' });
  assert.equal(card.items.length, rules.milestones.items.length, '里程碑必须 7 类齐全');
  assert.ok(card.items.some((i) => i.achieved), 't_delta 必须有已达成项');
  const json = JSON.stringify(card);
  assert.ok(!json.includes('u_ent_mfg'), '⛔ 战绩卡不得出现签字人 id（S10 §0.3）');
});

test('榜单过可见性过滤后仍可读', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  const lb = demoLeaderboard({ state, rules, scope: 'rank', viewer: { id: 'demo_admin', teamId: 't_alpha' } });
  assert.ok(Array.isArray(lb.rows));
  assert.ok(lb.rows.length > 0, '榜单不能是空的');
  assert.ok(lb.rows[0].rank >= 1);
});

test('三池：项目池/人才池/资源池都有内容', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  assert.ok(demoPools({ state, rules, kind: 'projects' }).rows.length > 0);
  assert.ok(demoPools({ state, rules, kind: 'talents' }).rows.length > 0);
  assert.ok(demoPools({ state, rules, kind: 'resources' }).rows.length > 0);
});

test('演示适配器：完整流程走通（登录 → 报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡）', async () => {
  const api = createDemoApi({ storage: makeStorage(), seed, rules });

  const health = await api.get('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.demo, true);

  const me = await api.get('/api/me');
  assert.equal(me.status, 401, '未登录时 /api/me 必须 401');

  const login = await api.post('/api/auth/login', { name: '演示管理员' });
  assert.equal(login.user.name, '演示管理员');

  const reg = await api.post('/api/registrations', {
    answers: {
      direction: [5, 5, 4, 5, 5], capability: [4, 5, 5, 4, 5], collaboration: [5, 4, 5, 5, 4],
      open: '希望把门店补货预测做成可落地的试点。',
    },
  });
  assert.ok(['S', 'A', 'B', 'C'].includes(reg.level), '报名必须算出等级');
  assert.ok(typeof reg.rawScore === 'number');

  const team = await api.post('/api/teams', { name: '演示新队', taskPackageId: 'tp_retail', memberIds: ['mba_captain', 'demo_member_1'] });
  assert.ok(team.id);

  const reviews = await api.post('/api/stages/stage_final/reviews', {
    items: [{ judgeId: 'j_lenient', teamId: 't_alpha', dimension: 'innovation', rawScore: 91 }],
  });
  assert.ok(reviews.submitted >= 1);

  const computed = await api.post('/api/stages/stage_final/compute', {});
  assert.ok(computed.computationId);
  assert.ok(computed.teams.length > 0);
  assert.ok(computed.trace);

  const lb = await api.get('/api/leaderboard/stage_final?scope=rank');
  assert.ok(lb.rows.length > 0);

  const tier = await api.get('/api/teams/t_gamma/tier');
  assert.equal(tier.tier, seed.expectations.tiers.t_gamma);

  const card = await api.get('/api/teams/t_gamma/performance-card');
  assert.ok(card.items.length > 0);

  const pub = await api.get('/api/public/leaderboard?editionId=ed_demo&token=demo');
  assert.ok(pub.rows.length > 0);
});

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}
```

`platform/test/demo-parity.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { scoreStage } from '../src/domain/scoring.js';
import { buildDemoState, expandSubmissions, demoTeamsRoster, runDemoCompute } from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(here, '..', 'rules'));

test('演示版与正式引擎逐字一致：同一输入 → 同一 teams / warnings / trace', () => {
  const state = buildDemoState(seed);

  // 正式引擎：直接调 domain/scoring.js
  const direct = scoreStage({
    config: rules.scoring.final,
    judges: seed.judges.map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(state),
    enterpriseConfirmations: seed.enterpriseConfirmations,
    peerReviews: seed.peerReviews,
    teams: demoTeamsRoster(state),
    selfReviews: seed.selfReviews,
  });

  // 演示版：走完整适配器
  const demo = runDemoCompute({ state: buildDemoState(seed), rules, stageId: 'stage_final' });

  assert.deepEqual(demo.teams, direct.teams, '演示版与正式引擎算出的每队分数必须完全一致');
  assert.deepEqual(demo.warnings, direct.warnings, '告警必须完全一致');
  assert.deepEqual(demo.trace, direct.trace, 'trace 必须完全一致');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/demo-engine.test.js test/demo-parity.test.js`
Expected: FAIL —— `buildDemoState is not a function`（`web/api.demo.js` 还是 P0 的 3 接口桩）

- [ ] **Step 3: 重写 `web/api.demo.js`**

```javascript
// web/api.demo.js — 演示版适配器（浏览器内 localStorage + 【真实运行的规则引擎】）
//
// 依据：设计文档 §14.3「公网演示版（现在就能拿到的 URL）」
//   前端代码 100% 复用，只换数据层：
//     web/api.js      → 真实 HTTP 客户端
//     web/api.demo.js → localStorage 适配器 + web/seed/demo-data.json
//
// ✅ 演示版能做什么：完整走一遍 报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API，
//    所有规则引擎【在浏览器里真实运行】（不是假数据硬编码的结果）。
//    实现方式：直接 import ../src/domain/*.js —— 领域层本来就是无 IO 的纯函数 ESM，
//    相对路径 import 即可，【不需要打包器】。
// ⛔ 演示版不能做什么：数据不跨人共享（各自浏览器独立）。这是无云主机条件下的客观边界。
//
// ⚠️ 由此给领域层的硬约束：src/domain/** 不得 import 任何 Node 内置模块
//    （node:fs / node:path / node:crypto …），否则浏览器跑不起来。
//    scripts/build-demo.js 在构建时强制校验这一条，违反即构建失败。
//
// ⚠️ 服务层（src/services/*）做 SQL 编排，【不能】进浏览器。
//    演示版对纯判定逻辑（组队校验）在本地做等价实现，并在注释里写明对应关系。
import { scoreRegistration, classifyLevel, validateRegistrationAnswers } from '../src/domain/registration.js';
import { scoreSolvability } from '../src/domain/solvability.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';
import { detectSelfEvalDiff } from '../src/domain/self-eval.js';
import { rankTeams } from '../src/domain/ranking.js';
import { computeStagePoints } from '../src/domain/points.js';
import { computeTier } from '../src/domain/tier.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { applyVisibility } from '../src/domain/visibility.js';

export const STORAGE_KEY = 'hks_demo_store_v1';
export const SEED_URL = './seed/demo-data.json';
export const RULES_BASE = './rules/';

/** 演示版需要的规则文件（构建脚本会校验这些文件都在 rules/ 下） */
export const DEMO_RULE_FILES = {
  scoringInitial: 'scoring-initial.json',
  scoringFinal: 'scoring-final.json',
  tiebreak: 'tiebreak.json',
  ranks: 'ranks.json',
  behavior: 'behavior-points.json',
  visibility: 'visibility.json',
  registration: 'registration-scoring.json',
  solvability: 'solvability.json',
  milestones: 'milestones.default.json',
  teamFormation: 'team-formation.json',
  points: 'points.json',
  criteria: 'criteria.json',
};

export function createMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function defaultStorage() {
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // 隐私模式下访问 localStorage 会抛错 → 退化成内存存储，不报错
  }
  return createMemoryStorage();
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// ── 状态 ────────────────────────────────────────────────────────

export function buildDemoState(seed) {
  return {
    meta: seed?.meta ?? {},
    edition: seed?.edition ?? {},
    users: seed?.users ?? [],
    taskPackages: seed?.taskPackages ?? [],
    judges: seed?.judges ?? [],
    teams: seed?.teams ?? [],
    reviews: seed?.reviews ?? {},
    enterpriseConfirmations: seed?.enterpriseConfirmations ?? [],
    peerReviews: seed?.peerReviews ?? [],
    selfReviews: seed?.selfReviews ?? [],
    milestones: seed?.milestones ?? [],
    signoffs: seed?.signoffs ?? [],
    behaviorEvents: seed?.behaviorEvents ?? [],
    registrations: [],
    computations: {},
    results: {},
    me: null,
  };
}

export function expandSubmissions(state) {
  const out = [];
  for (const [judgeId, byTeam] of Object.entries(state.reviews ?? {})) {
    for (const [teamId, byDim] of Object.entries(byTeam ?? {})) {
      for (const [dimension, rawScore] of Object.entries(byDim ?? {})) {
        out.push({ judgeId, teamId, dimension, rawScore: Number(rawScore) });
      }
    }
  }
  return out;
}

/** 队伍名册：R1（分赛道）与 R4（自由命题）需要知道任务包归属 */
export function demoTeamsRoster(state) {
  const pkgById = new Map((state.taskPackages ?? []).map((p) => [p.id, p]));
  return (state.teams ?? []).map((t) => {
    const pkg = pkgById.get(t.packageId) ?? {};
    return {
      teamId: t.id,
      packageEnterpriseId: pkg.enterpriseId ?? null,
      isFreeBrief: pkg.isFreeBrief === true,
    };
  });
}

// ── 计算（核心：真实规则引擎）────────────────────────────────────

export function runDemoCompute({ state, rules, stageId = 'stage_final', now = null }) {
  const config = rules.scoring.final;
  const submissions = expandSubmissions(state);
  const judges = (state.judges ?? []).map((j) => ({ judgeId: j.id, seat: j.seat ?? 'expert' }));
  const teams = demoTeamsRoster(state);

  const scored = scoreStage({
    config,
    judges,
    submissions,
    enterpriseConfirmations: state.enterpriseConfirmations ?? [],
    peerReviews: state.peerReviews ?? [],
    teams,
    selfReviews: state.selfReviews ?? [],
  });

  // 企业席单独跑一遍（拿 seatE 明细，供破同分链的 enterprise_raw 用）
  const enterprise = applyEnterpriseRules({
    confirmations: state.enterpriseConfirmations ?? [],
    teams,
    judges,
    config,
  });

  // 破同分链的输入
  const byTeam = {};
  for (const row of scored.teams) {
    const team = (state.teams ?? []).find((t) => t.id === row.teamId) ?? {};
    const peer = (state.peerReviews ?? []).filter((p) => p.toTeamId === row.teamId);
    const conf = (state.enterpriseConfirmations ?? []).filter((c) => c.teamId === row.teamId);
    byTeam[row.teamId] = {
      peerScore: peer.length
        ? peer.reduce((a, p) => a + Number(p.score || 0), 0) / peer.length
        : undefined,
      enterpriseRaw: conf.length
        ? conf.reduce((a, c) => a + Number(c.rawScore || 0), 0) / conf.length
        : undefined,
      behaviorScore: behaviorScore({
        events: (state.behaviorEvents ?? []).filter((e) => e.teamId === row.teamId),
        behaviorConfig: rules.behavior,
      }).total,
      tiebreakExtra: team.tiebreakExtra ?? undefined,
    };
  }

  const candidates = scored.teams.map((row) => ({
    teamId: row.teamId,
    total: row.total,
    seatP: row.seatP,
    seatE: row.seatE,
    peerScore: byTeam[row.teamId].peerScore,
    enterpriseRaw: byTeam[row.teamId].enterpriseRaw,
    behaviorScore: byTeam[row.teamId].behaviorScore,
  }));

  const ranked = rankTeams({
    teams: candidates,
    tiebreakChain: rules.tiebreak.chain,
    tiebreakData: { isFinal: true, byTeam },
    pointsConfig: rules.points,
  });

  const points = computeStagePoints({ ordered: ranked.ordered, pointsConfig: rules.points });
  const selfEvalFlags = demoSelfEvalFlags({ state, threshold: 10 });

  const computationId = `cmp_demo_${(state.computations ? Object.keys(state.computations).length : 0) + 1}`;
  const result = {
    computationId,
    stageId,
    computedAt: now ?? null,
    teams: scored.teams,
    warnings: [...scored.warnings, ...(enterprise.warnings ?? [])],
    trace: scored.trace,
    enterprise: { seatE: enterprise.seatE, weights: enterprise.weights },
    ordered: ranked.ordered,
    chain: ranked.applied,
    points,
    selfEvalFlags,
  };

  state.computations[computationId] = result;
  state.results[stageId] = result;
  state.lastStageId = stageId;
  return result;
}

export function demoSelfEvalFlags({ state, threshold = 10 }) {
  const submissions = expandSubmissions(state);
  const buckets = new Map();
  for (const s of submissions) {
    const key = `${s.teamId}::${s.dimension}`;
    const cur = buckets.get(key) ?? { sum: 0, n: 0 };
    cur.sum += s.rawScore;
    cur.n += 1;
    buckets.set(key, cur);
  }
  // 评委席同尺度分 = 该队该维度上评委分的均值
  const judgeScores = [];
  for (const [key, cur] of buckets) {
    const [teamId, dimension] = key.split('::');
    judgeScores.push({ teamId, dimension, score: cur.sum / cur.n });
  }
  const { flags } = detectSelfEvalDiff({
    selfReviews: state.selfReviews ?? [],
    judgeScores,
    threshold,
  });
  return flags;
}

// ── 段位 / 战绩卡 / 榜单 / 三池 ────────────────────────────────

export function demoTier({ state, rules, teamId }) {
  const milestones = (state.milestones ?? [])
    .filter((m) => m.teamId === teamId)
    .map((m) => ({
      key: m.key,
      countsTowardTier: m.countsTowardTier !== false,
      achieved: m.achieved === true,
      isDataOrPrototype: m.isDataOrPrototype === true,
    }));
  const signoffs = (state.signoffs ?? [])
    .filter((s) => s.teamId === teamId)
    .map((s) => ({
      milestoneKey: s.milestoneKey,
      department: s.department,
      revokedAt: s.revokedAt ?? null,
      isBusinessDepartment: s.isBusinessDepartment === true,
    }));
  const tier = computeTier({ milestones, signoffs, ranksConfig: rules.ranks });
  const behavior = behaviorScore({
    events: (state.behaviorEvents ?? []).filter((e) => e.teamId === teamId),
    behaviorConfig: rules.behavior,
  });
  return { ...tier, behavior };
}

export function demoPerformanceCard({ state, rules, teamId }) {
  const tierInfo = demoTier({ state, rules, teamId });
  const team = (state.teams ?? []).find((t) => t.id === teamId) ?? {};
  const items = (rules.milestones?.items ?? []).map((def) => {
    const m = (state.milestones ?? []).find((x) => x.teamId === teamId && x.key === def.key);
    const signoff = (state.signoffs ?? []).find((s) => s.teamId === teamId && s.milestoneKey === def.key);
    return {
      key: def.key,
      label: def.label,
      confirmedBy: def.confirmedBy,
      achieved: m?.achieved === true,
      countsTowardTier: def.countsTowardTier !== false,
      // ⛔ 只给部门，不给签字人：S10 §0.3「B 榜签字人不公开」
      signedByDepartment: signoff ? signoff.department : null,
      revoked: Boolean(signoff?.revokedAt),
    };
  });
  return {
    teamId,
    teamName: team.name ?? teamId,
    tier: tierInfo.tier,
    milestoneCount: tierInfo.milestoneCount,
    businessSignoffCount: tierInfo.businessSignoffCount,
    items,
    behavior: tierInfo.behavior,
  };
}

export function demoLeaderboard({ state, rules, scope = 'rank', viewer = null }) {
  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (!result) return { scope, rows: [], demo: true, empty: true };
  const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
  const rows = result.ordered.map((row) => {
    const team = (state.teams ?? []).find((t) => t.id === row.teamId) ?? {};
    const tier = demoTier({ state, rules, teamId: row.teamId });
    return {
      teamId: row.teamId,
      teamName: team.name ?? row.teamId,
      rank: row.rank,
      total: row.total,
      tiedWith: row.tiedWith ?? [],
      points: pointsByTeam.get(row.teamId) ?? 0,
      tier: tier.tier,
    };
  });
  // 可见性在【这一层】过滤（与服务端同一套规则）：
  //   rank 榜全员公开但不含企业名与互评来源；business 榜不含评分与签字人。
  // ⚠️ 段位榜（scope='tier'）另走 applyVisibility 的 tier 分支：C 段及以上公示，D 段只给本人进度卡。
  return applyVisibility({
    payload: { scope, rows },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope, viewerTeamId: viewer?.teamId ?? null },
  });
}

export function demoPools({ state, rules, kind }) {
  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (kind === 'projects') {
    const rows = (state.teams ?? []).map((t) => {
      const tier = demoTier({ state, rules, teamId: t.id });
      const rank = result?.ordered?.find((r) => r.teamId === t.id)?.rank ?? null;
      return {
        id: t.id,
        title: t.name,
        teamId: t.id,
        industry: (state.taskPackages ?? []).find((p) => p.id === t.packageId)?.title ?? null,
        stageReached: stageId,
        tier: tier.tier,
        businessValue: tier.businessSignoffCount > 0 ? '已获企业业务部门签字' : '推进中',
        summary: `段位 ${tier.tier}｜里程碑 ${tier.milestoneCount} 项`,
        rank,
      };
    });
    return { kind, rows, demo: true };
  }
  if (kind === 'talents') {
    // 个人积分 = 该队在本赛段拿到的名次积分之和（赛段积分本身由 computeStagePoints 算）
    const pointsByTeam = new Map((result?.points ?? []).map((p) => [p.teamId, p.points]));
    const totalByUser = new Map();
    for (const t of state.teams ?? []) {
      const pts = pointsByTeam.get(t.id) ?? 0;
      for (const uid of t.memberIds ?? []) {
        totalByUser.set(uid, (totalByUser.get(uid) ?? 0) + pts);
      }
    }
    const rows = (state.users ?? []).map((u) => {
      const teamIds = (state.teams ?? []).filter((t) => (t.memberIds ?? []).includes(u.id)).map((t) => t.id);
      return {
        id: u.id,
        name: u.name,
        org: '演示组委会',
        total_points: totalByUser.get(u.id) ?? 0,
        mba_status: u.mbaStatus,
        stages_joined: teamIds.length,
        skills: [],
      };
    });
    return { kind, rows, demo: true };
  }
  if (kind === 'resources') {
    const rows = (state.taskPackages ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      enterprise_id: p.enterpriseId,
      enterprise_name: p.enterpriseName,
      kind: p.isFreeBrief ? '自由命题' : '企业命题',
      detail: p.commitment ?? '无',
    }));
    return { kind, rows, demo: true };
  }
  return { kind, rows: [], demo: true };
}

// ── 组队（浏览器内的等价实现）──────────────────────────────────
// ⚠️ 服务层 src/services/team.js 的 checkTeamFormation 做 SQL 编排，不能进浏览器；
//    这里按 rules/team-formation.json 做等价的纯判定（口径一致，来源同一份配置）。
export function demoTeamFormation({ team, state, rules }) {
  const errors = [];
  const cfg = rules.teamFormation ?? {};
  const size = (team.memberIds ?? []).length;
  const min = cfg.teamSize?.min ?? 2;
  const max = cfg.teamSize?.max ?? 5;
  if (size < min) errors.push(`组队人数 ${size} 少于下限 ${min}`);
  if (size > max) errors.push(`组队人数 ${size} 超过上限 ${max}`);
  if (cfg.captainMustBeMba) {
    const captain = (state.users ?? []).find((u) => u.id === team.captainId);
    if (!captain) errors.push('组长不存在');
    else if (captain.mbaStatus !== 'mba') errors.push('组长必须是一堂 MBA 在籍（硬性门槛）');
  }
  const pkg = (state.taskPackages ?? []).find((p) => p.id === team.packageId);
  if (!pkg) errors.push('必须认领一个任务包（报名即认领）');
  return { ok: errors.length === 0, errors };
}

// ── API 层 ─────────────────────────────────────────────────────

function parseQuery(path) {
  const i = path.indexOf('?');
  if (i < 0) return { path, query: {} };
  const q = {};
  for (const [k, v] of new URLSearchParams(path.slice(i + 1))) q[k] = v;
  return { path: path.slice(0, i), query: q };
}

export function createDemoApi({ storage = defaultStorage(), seed = null, rules = null } = {}) {
  let state = null;

  const ensure = () => {
    if (state) return state;
    const raw = storage.getItem(STORAGE_KEY);
    state = raw ? JSON.parse(raw) : buildDemoState(seed);
    return state;
  };
  const persist = () => storage.setItem(STORAGE_KEY, JSON.stringify(state));

  const dispatch = (method, path, body) => {
    const { path: clean, query } = parseQuery(path);
    const s = ensure();
    const r = rules;
    if (!r) throw httpError(500, 'RULES_MISSING', '演示版规则配置未加载');

    // 健康检查
    if (method === 'GET' && clean === '/api/health') {
      return { ok: true, demo: true, ruleVersion: r.tiebreak?.version ?? null };
    }
    // 当前用户
    if (method === 'GET' && clean === '/api/me') {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      return { user: s.me };
    }
    if (method === 'POST' && clean === '/api/auth/login') {
      s.me = {
        id: 'demo_admin',
        name: body?.name || '演示管理员',
        mbaStatus: 'mba',
        org: '演示组委会',
        teamId: (s.teams ?? [])[0]?.id ?? null,
      };
      persist();
      return { user: s.me };
    }
    if (method === 'POST' && clean === '/api/auth/logout') {
      s.me = null;
      persist();
      return { ok: true };
    }
    // 报名
    if (method === 'POST' && clean === '/api/registrations') {
      const answers = body?.answers ?? {};
      const errors = validateRegistrationAnswers(answers, r.registration);
      if (errors.length) throw httpError(400, 'INVALID_ANSWERS', errors.join('；'));
      const scored = scoreRegistration({ answers, config: r.registration });
      const level = classifyLevel(scored.score, r.registration);
      const reg = {
        id: `reg_demo_${s.registrations.length + 1}`,
        userId: s.me?.id ?? 'demo_user',
        editionId: s.edition?.id ?? 'ed_demo',
        answers,
        rawScore: scored.score,
        level,
        levelFinal: level,
        dimensionScores: scored.dimensionScores,
        explain: scored.explain,
        status: level === 'C' ? 'rejected' : 'accepted',
        createdAt: new Date().toISOString(),
      };
      s.registrations.push(reg);
      persist();
      return reg;
    }
    if (method === 'GET' && clean === '/api/registrations') {
      return { rows: s.registrations };
    }
    // 任务卡可解性评估（演示"六维准入 + 一票否决"）
    if (method === 'POST' && clean === '/api/task-packages/solvability') {
      const out = scoreSolvability({ answers: body?.answers ?? {}, config: r.solvability });
      return out;
    }
    // 组队
    if (method === 'POST' && clean === '/api/teams') {
      const team = {
        id: `team_demo_${(s.teams ?? []).length + 1}`,
        name: body?.name ?? '演示战队',
        packageId: body?.taskPackageId ?? null,
        captainId: body?.captainId ?? s.me?.id ?? null,
        memberIds: body?.memberIds ?? [],
        tier: 'D',
        status: 'forming',
      };
      const formation = demoTeamFormation({ team, state: s, rules: r });
      if (!formation.ok) throw httpError(400, 'TEAM_FORMATION_INVALID', formation.errors.join('；'));
      s.teams.push(team);
      persist();
      return { ...team, formation };
    }
    let m = clean.match(/^\/api\/teams\/([^/]+)$/);
    if (method === 'GET' && m) {
      const team = (s.teams ?? []).find((t) => t.id === m[1]);
      if (!team) throw httpError(404, 'NOT_FOUND', '队伍不存在');
      return team;
    }
    m = clean.match(/^\/api\/teams\/([^/]+)\/performance-card$/);
    if (method === 'GET' && m) return demoPerformanceCard({ state: s, rules: r, teamId: m[1] });
    m = clean.match(/^\/api\/teams\/([^/]+)\/tier$/);
    if (method === 'GET' && m) return demoTier({ state: s, rules: r, teamId: m[1] });
    // 打分
    m = clean.match(/^\/api\/stages\/([^/]+)\/reviews$/);
    if (method === 'POST' && m) {
      const items = Array.isArray(body?.items) ? body.items : [];
      for (const it of items) {
        const judgeId = it.judgeId;
        if (!s.reviews[judgeId]) s.reviews[judgeId] = {};
        if (!s.reviews[judgeId][it.teamId]) s.reviews[judgeId][it.teamId] = {};
        s.reviews[judgeId][it.teamId][it.dimension] = Number(it.rawScore);
      }
      persist();
      return { submitted: items.length, stageId: m[1] };
    }
    m = clean.match(/^\/api\/stages\/([^/]+)\/review-state$/);
    if (method === 'GET' && m) {
      const subs = expandSubmissions(s);
      const byJudge = new Map();
      for (const sub of subs) byJudge.set(sub.judgeId, (byJudge.get(sub.judgeId) ?? 0) + 1);
      return {
        stageId: m[1],
        submitted: subs.length,
        dimensionProgress: Object.fromEntries(byJudge),
        judges: (s.judges ?? []).map((j) => ({ judgeId: j.id, submitted: byJudge.get(j.id) ?? 0 })),
      };
    }
    // 计算
    m = clean.match(/^\/api\/stages\/([^/]+)\/compute$/);
    if (method === 'POST' && m) {
      const out = runDemoCompute({ state: s, rules: r, stageId: m[1], now: new Date().toISOString() });
      s.lastStageId = m[1];
      persist();
      return out;
    }
    m = clean.match(/^\/api\/stages\/([^/]+)\/computations\/([^/]+)$/);
    if (method === 'GET' && m) {
      const c = s.computations?.[m[2]];
      if (!c) throw httpError(404, 'NOT_FOUND', '计算快照不存在');
      return c;
    }
    // 榜单
    if (method === 'GET' && clean === '/api/leaderboard/rolling') {
      return demoLeaderboard({ state: s, rules: r, scope: 'rank', viewer: s.me });
    }
    m = clean.match(/^\/api\/leaderboard\/([^/]+)$/);
    if (method === 'GET' && m) {
      const scope = query.scope || 'rank';
      return demoLeaderboard({ state: s, rules: r, scope, viewer: s.me });
    }
    // 三池
    m = clean.match(/^\/api\/pools\/(projects|talents|resources)$/);
    if (method === 'GET' && m) return demoPools({ state: s, rules: r, kind: m[1] });
    // 公开 API（无需登录）
    if (method === 'GET' && clean === '/api/public/leaderboard') {
      if (!query.token) throw httpError(401, 'UNAUTHENTICATED', '缺少公开访问令牌');
      return demoLeaderboard({ state: s, rules: r, scope: 'rank', viewer: null });
    }
    throw httpError(404, 'NOT_FOUND', `演示版未实现该接口：${method} ${clean}`);
  };

  return {
    async get(path) { return dispatch('GET', path, null); },
    async post(path, body) { return dispatch('POST', path, body ?? {}); },
    async patch(path, body) { return dispatch('PATCH', path, body ?? {}); },
    async del(path) { return dispatch('DELETE', path, null); },
    subscribe() { return () => {}; },
    _state: ensure,
    _persist: persist,
  };
}

// ── 浏览器入口 ─────────────────────────────────────────────────

export async function loadDemoSeed(url = SEED_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`演示种子数据加载失败：${url}（HTTP ${res.status}）`);
  return res.json();
}

export async function loadDemoRules(base = RULES_BASE) {
  const loaded = {};
  const missing = [];
  for (const [key, file] of Object.entries(DEMO_RULE_FILES)) {
    const res = await fetch(base + file);
    if (!res.ok) {
      missing.push(`${file}（HTTP ${res.status}）`);
      continue;
    }
    loaded[key] = await res.json();
  }
  if (missing.length) {
    throw new Error(
      `演示规则配置缺失：${missing.join('、')}。请先执行 node scripts/build-demo.js 生成静态站。`,
    );
  }
  return {
    scoring: { initial: loaded.scoringInitial, final: loaded.scoringFinal },
    tiebreak: loaded.tiebreak,
    ranks: loaded.ranks,
    behavior: loaded.behavior,
    visibility: loaded.visibility,
    registration: loaded.registration,
    solvability: loaded.solvability,
    milestones: loaded.milestones,
    teamFormation: loaded.teamFormation,
    points: loaded.points,
    criteria: loaded.criteria,
  };
}

let runtimePromise = null;

export function getDemoRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [seed, rules] = await Promise.all([loadDemoSeed(), loadDemoRules()]);
      return createDemoApi({ seed, rules });
    })();
  }
  return runtimePromise;
}

/** 与 web/api.js 同名的默认导出：视图代码完全复用 */
export const api = {
  async get(path) { return (await getDemoRuntime()).get(path); },
  async post(path, body) { return (await getDemoRuntime()).post(path, body); },
  async patch(path, body) { return (await getDemoRuntime()).patch(path, body); },
  async del(path) { return (await getDemoRuntime()).del(path); },
  subscribe() { return () => {}; },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/demo-engine.test.js test/demo-parity.test.js`
Expected: PASS（demo-engine 12 个 + demo-parity 1 个全过）

> ⚠️ **如果 `demo-parity.test.js` 报 `teams` 不一致**，说明演示版在某处自己又算了一遍分。
> **修法**：删掉演示版里的重复计算，一律以 `scoreStage()` 的返回为准（`runDemoCompute` 里已经是这么写的）。
> **不要**在测试里放宽断言——这条断言就是"演示版与正式版算法一致"的机器保证。

- [ ] **Step 5: 提交**

```bash
cd platform && git add web/api.demo.js test/demo-engine.test.js test/demo-parity.test.js
git commit -m "feat(P6): 演示版适配器扩展为完整流程（浏览器内真实运行规则引擎）"
```

---

### Task 6: 演示版前端补齐 + 静态站构建与发布

**Files:**
- Create: `platform/scripts/build-demo.js`
- Create: `platform/scripts/serve-demo.js`
- Modify: `platform/web/index.html`（资源路径改相对路径 + 演示版横幅）
- Modify: `platform/web/app.js`（演示模式数据加载 + 演示路由）
- Modify: `platform/src/server.js`（挂载 `/src/domain/*` 与 `/rules/*`，供开发服务器的演示模式）
- Modify: `platform/package.json`（scripts 增加 `backup` / `restore` / `build:demo` / `serve:demo`）
- Modify: `platform/.gitignore` 或仓库根 `.gitignore`（忽略 `web/dist/`、`data/`）
- Test: `platform/test/demo-static.test.js`

**Interfaces:**
- Consumes: `serveStatic(webDir, req, res)`（P0，**签名不变**）、`web/api.demo.js`（Task 5）
- Produces:
  - `buildDemoSite({ outDir, webDir, platformDir, rulesDir })` → `{ files: string[], domainFiles: string[], ruleFiles: string[] }`
  - `assertDomainIsBrowserSafe(domainDir)` → `string[]`（违规说明；空数组 = 通过）
  - 产物目录 `platform/web/dist/`：自包含静态站（根目录有 `index.html`）
  - `node scripts/serve-demo.js` → 本地预览 `http://127.0.0.1:8090/`

> **⚠️ 本 Task 回答的是"公网演示版怎么做"这个最关键的问题**
> **客观边界**（不粉饰）：公网**正式版**后端需要云主机；**当前没有云账号 / 隧道 / Docker 环境**；
> 静态站发布工具只能发布**静态文件**（要求目录里有 `index.html`），**不能跑 Node 后端**。
> → 所以公网演示版 = **同源静态前端 + `api.demo.js`（localStorage 适配器）**，数据不跨人共享（各自浏览器独立）。
> **✅ 但规则引擎在浏览器里真实运行**——演示出来的算法行为与正式系统一致，不会出现"演示好看、正式不一样"。
> **⛔ 正式版后端仍要按云主机部署资产准备好**（Task 2 + Task 1），拿到云主机就能一键起。
>
> **静态站怎么带上规则引擎**（不需要打包器）：
> `web/api.demo.js` 里写的是 `import { scoreStage } from '../src/domain/scoring.js'`。
> 在浏览器里，这个说明符从 `/api.demo.js` 解析出来是 **`/src/domain/scoring.js`**（URL 里 `..` 到根就被截断）。
> → 所以构建时把 `platform/src/domain/*.js` 原样拷到 **`web/dist/src/domain/`**，
> 把 `platform/rules/*.json` 拷到 **`web/dist/rules/`**，构建产物就是自包含的静态站。
> **⚠️ 领域层里的相对 import（`./normalization.js`）在拷贝后依然成立**（整目录原样拷，结构不变）。

- [ ] **Step 1: 写失败的测试**

`platform/test/demo-static.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoSite, assertDomainIsBrowserSafe } from '../scripts/build-demo.js';
import { DEMO_RULE_FILES } from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('构建产物是自包含静态站：根目录有 index.html，且没有绝对路径资源引用', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });
  assert.ok(existsSync(join(out, 'index.html')), '根目录必须有 index.html（静态托管的硬要求）');

  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)="\//, '⛔ 资源路径不能以 / 开头（换 base path 会全挂）');
  assert.match(html, /\.\/app\.js/);
  assert.match(html, /\.\/styles\.css/);

  rmSync(out, { recursive: true, force: true });
});

test('构建产物带上领域层与规则配置（浏览器里才跑得起来）', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });

  assert.ok(existsSync(join(out, 'src', 'domain', 'scoring.js')), '领域层必须拷进产物');
  assert.ok(existsSync(join(out, 'rules', 'scoring-final.json')), '规则配置必须拷进产物');
  assert.ok(existsSync(join(out, 'seed', 'demo-data.json')), '种子数据必须拷进产物');
  assert.ok(existsSync(join(out, 'api.demo.js')), '演示适配器必须在产物里');

  for (const file of Object.values(DEMO_RULE_FILES)) {
    assert.ok(existsSync(join(out, 'rules', file)), `规则文件 ${file} 必须拷进产物`);
  }

  rmSync(out, { recursive: true, force: true });
});

test('领域层不得 import 任何 Node 内置模块（否则浏览器跑不了）', () => {
  const domainDir = join(platformDir, 'src', 'domain');
  const violations = assertDomainIsBrowserSafe(domainDir);
  assert.deepEqual(violations, [], `领域层有 Node 依赖：${violations.join('；')}`);
});

test('守卫真的会拦下 Node 内置模块的导入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-dom-'));
  writeFileSync(join(dir, 'bad.js'), "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n", 'utf8');
  const violations = assertDomainIsBrowserSafe(dir);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes('node:fs'));
  rmSync(dir, { recursive: true, force: true });
});

test('构建产物里不出现 data/ 与 node_modules/（不泄漏本机数据）', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });
  const rel = walk(out).map((f) => relative(out, f).split(sep).join('/'));
  assert.ok(!rel.some((f) => f.startsWith('data/')), '产物里不能有 data/');
  assert.ok(!rel.some((f) => f.includes('node_modules')), '产物里不能有 node_modules/');
  rmSync(out, { recursive: true, force: true });
});
```

（测试文件顶部需要 `import { writeFileSync } from 'node:fs';`——实现时把它加进第一行的 import 里。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/demo-static.test.js`
Expected: FAIL —— `Cannot find module '../scripts/build-demo.js'`

- [ ] **Step 3: 创建 `scripts/build-demo.js`**

```javascript
// scripts/build-demo.js — 构建公网演示版静态站
//
// 依据：设计文档 §14.3「公网演示版（现在就能拿到的 URL）」
//   静态站发布工具只能发布静态文件（要求目录里有 index.html），不能跑 Node 后端。
//   → 演示版 = 同源静态前端 + web/api.demo.js（localStorage 适配器）+ 浏览器内真实运行的规则引擎。
//
// ⚠️ 领域层进浏览器的硬约束：src/domain/** 不得 import 任何 Node 内置模块
//    （node:fs / node:path / node:crypto …），否则浏览器跑不起来。
//    本脚本在构建时强制校验，违反即构建失败 —— 这条约束由机器守住，不靠自觉。
//
// 用法：node scripts/build-demo.js [--out web/dist]
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync, statSync,
} from 'node:fs';
import { join, dirname, relative, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_RULE_FILES } from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 拷贝一个目录（跳过 exclude 里的顶层名字） */
function copyDir(from, to, { exclude = [] } = {}) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

/** 抽出模块里的 import 说明符（静态 import / export from / 动态 import） */
export function extractImportSpecifiers(code) {
  const specs = [];
  const re1 = /(?:^|\n)\s*(?:import|export)\s[^;'"\n]*?from\s*['"]([^'"]+)['"]/g;
  const re2 = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  const re3 = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [re1, re2, re3]) {
    let m;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
  }
  return specs;
}

/**
 * 收集领域层【连同它相对引用到的其它文件】。
 * 返回 { domainFiles, extraFiles }：
 *   domainFiles = src/domain/ 内的文件
 *   extraFiles  = 领域层之外、但被相对 import 引到的文件（例如 src/domain/../shared/x.js）
 * ⚠️ extraFiles 也要拷进产物：相对 import 的结构必须原样保留，否则浏览器里会 404。
 */
export function collectBrowserModules(domainDir) {
  const domainFiles = [];
  const extraFiles = [];
  const seen = new Set();
  const queue = readdirSync(domainDir)
    .filter((n) => n.endsWith('.js'))
    .map((n) => join(domainDir, n));

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith(domainDir)) domainFiles.push(file);
    else extraFiles.push(file);

    const code = readFileSync(file, 'utf8');
    for (const spec of extractImportSpecifiers(code)) {
      if (!spec.startsWith('.')) continue;          // node: 与裸模块名交给守卫报错
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) continue;            // 指不到的文件由守卫单独报
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { domainFiles, extraFiles };
}

/**
 * 领域层浏览器安全守卫。
 * 返回违规说明数组（空数组 = 通过）。违反的两种情况：
 *   ① import 了 Node 内置模块（node:fs / node:path / …）
 *   ② import 了裸模块名（不是 './' 或 '../' 开头）—— 浏览器没有 node_modules
 *   ③ 相对导入指不到文件（拷进 dist 后会 404）
 */
export function assertDomainIsBrowserSafe(domainDir) {
  const violations = [];
  if (!existsSync(domainDir)) return [`领域层目录不存在：${domainDir}`];

  const { domainFiles, extraFiles } = collectBrowserModules(domainDir);
  for (const file of [...domainFiles, ...extraFiles]) {
    const rel = relative(dirname(domainDir), file);
    const code = readFileSync(file, 'utf8');
    for (const spec of extractImportSpecifiers(code)) {
      if (spec.startsWith('node:')) {
        violations.push(`${rel} 导入了 Node 内置模块 ${spec}（浏览器跑不了）`);
        continue;
      }
      if (!spec.startsWith('.')) {
        violations.push(`${rel} 导入了裸模块名 ${spec}（浏览器没有 node_modules）`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) {
        violations.push(`${rel} 的相对导入 ${spec} 指不到文件（拷贝进 dist 后会 404）`);
      }
    }
  }
  return violations;
}

/**
 * 构建静态站。
 * 产物结构（自包含）：
 *   <out>/index.html  app.js  api.js  api.demo.js  router.js  store.js  styles.css  views/…
 *   <out>/src/domain/*.js     ← 从 platform/src/domain 整目录原样拷贝
 *   <out>/rules/*.json         ← 从 platform/rules 拷贝
 *   <out>/seed/demo-data.json  ← 从 platform/web/seed 拷贝
 */
export function buildDemoSite({
  outDir = join(here, '..', 'web', 'dist'),
  platformDir = join(here, '..'),
  webDir = join(here, '..', 'web'),
  rulesDir = join(here, '..', 'rules'),
} = {}) {
  const domainDir = join(platformDir, 'src', 'domain');

  // 1. 先守卫：领域层有 Node 依赖 → 构建失败（不产出半成品）
  const violations = assertDomainIsBrowserSafe(domainDir);
  if (violations.length) {
    throw new Error(
      `领域层不满足浏览器约束，构建中止：\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  // 2. 规则文件必须齐全（缺一个就报错，绝不静默少一个）
  const missing = Object.values(DEMO_RULE_FILES).filter((f) => !existsSync(join(rulesDir, f)));
  if (missing.length) {
    throw new Error(`规则配置缺失，演示站无法启动引擎：${missing.join('、')}`);
  }

  // 3. 清空并重建产物目录
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 4. web/ 全部拷过去（排除 dist/ 自身）
  copyDir(webDir, outDir, { exclude: ['dist'] });

  // 5. 领域层 + 它相对引用到的其它文件（按 platform/ 下的相对路径镜像拷贝，结构不变）
  const { domainFiles, extraFiles } = collectBrowserModules(domainDir);
  for (const file of [...domainFiles, ...extraFiles]) {
    const rel = relative(platformDir, file);          // 例：src/domain/scoring.js
    const dst = join(outDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(file, dst);
  }

  // 6. 规则配置拷过去
  copyDir(rulesDir, join(outDir, 'rules'));

  // 7. 种子数据（web/seed 已在步骤 4 拷过，这里确保存在并补齐）
  const seedSrc = join(webDir, 'seed', 'demo-data.json');
  if (!existsSync(seedSrc)) throw new Error(`缺少演示种子数据：${seedSrc}`);
  mkdirSync(join(outDir, 'seed'), { recursive: true });
  copyFileSync(seedSrc, join(outDir, 'seed', 'demo-data.json'));

  // 8. index.html 的资源路径必须相对（静态托管换 base path 才不会挂）
  const htmlPath = join(outDir, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace(/(src|href)="\/(?!\/)/g, '$1="./');
  writeFileSync(htmlPath, html, 'utf8');

  // 9. 构建清单（可追溯：规则版本 + 构建时间 + 文件数）
  const manifest = {
    builtAt: new Date().toISOString(),
    ruleFiles: Object.values(DEMO_RULE_FILES),
    note: '演示站：规则引擎在浏览器里真实运行；数据不跨人共享（各自浏览器独立）。',
  };
  writeFileSync(join(outDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    outDir,
    files: readdirSync(outDir),
    domainFiles: readdirSync(join(outDir, 'src', 'domain')),
    ruleFiles: Object.values(DEMO_RULE_FILES),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? resolve(process.cwd(), args[outIdx + 1]) : join(here, '..', 'web', 'dist');
  try {
    const result = buildDemoSite({ outDir });
    console.log(`[build-demo] 产物目录：${result.outDir}`);
    console.log(`[build-demo] 顶层条目：${result.files.join(', ')}`);
    console.log(`[build-demo] 领域层文件 ${result.domainFiles.length} 个，规则文件 ${result.ruleFiles.length} 个`);
    console.log('[build-demo] ✅ 领域层浏览器安全检查通过');
  } catch (err) {
    console.error(`[build-demo] ✗ ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: 创建 `scripts/serve-demo.js`**

```javascript
// scripts/serve-demo.js — 本地预览演示站构建产物
// 用途：发布前在本机把 web/dist/ 跑起来看一眼（不启后端、不建库）。
// 用法：node scripts/serve-demo.js   → http://127.0.0.1:8090/
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/http/static.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web', 'dist');
const port = Number(process.env.PORT || 8090);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && serveStatic(webDir, req, res)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 页面不存在（演示站只有静态资源）');
});

server.listen(port, () => {
  console.log(`演示站本地预览：http://127.0.0.1:${port}/`);
});
```

- [ ] **Step 5: 修改 `web/index.html`（相对路径）**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI 商业黑客松 · 赛事平台</title>
  <!-- ⚠️ 资源路径必须是相对路径：静态托管（公网演示站）可能挂在任意 base path 下 -->
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="app"><div class="boot">正在加载…</div></div>
  <noscript>本演示版需要启用 JavaScript——规则引擎是在你的浏览器里真实运行的。</noscript>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

> ⚠️ 若 P1–P5 已在 `index.html` 里加了别的 `<script>` 标签或横幅，**保留它们**，只把资源路径改成 `./` 形式。

- [ ] **Step 6: 修改 `web/app.js`（演示模式）**

在 P1–P5 之后的 `web/app.js` 里，把开头的适配器选择替换为下面这段（**保留其余路由与视图代码**）：

```javascript
// 演示版：?demo=1 时用 localStorage 适配器；正式版走真实 API。
// ⚠️ 演示版的规则引擎在浏览器里真实运行（web/api.demo.js 直接 import ../src/domain/*.js），
//    所以「演示好看、正式不一样」这件事不会发生。
const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
const { api } = isDemo ? await import('./api.demo.js') : await import('./api.js');
```

并在 `render()` 之前插入演示版横幅：

```javascript
function demoBanner() {
  if (!isDemo) return null;
  const el = document.createElement('div');
  el.className = 'card demo-banner';
  el.innerHTML = `
    <strong>演示版</strong>：当前是公网演示站——所有数据只存在你的浏览器里（不跨人共享），
    但<b>规则引擎是在你的浏览器里真实运行的</b>（z-score 归一化 / 去极值 / 双签 / 破同分链 / 段位判定），
    算法行为与正式系统一致。
  `;
  return el;
}
```

- [ ] **Step 7: 修改 `src/server.js`（挂载领域层与规则配置，供开发服务器演示模式）**

在 `src/server.js` 的 `handle()` 里，把静态托管那段替换为：

```javascript
    if (req.method === 'GET') {
      if (serveStatic(webDir, req, res)) return;
      // 演示模式（?demo=1）：领域层与规则配置不在 web/ 下，挂出去。
      // ⚠️ serveStatic 的签名不变（webDir, req, res）——这里只换 webDir，不改它。
      if (serveMounted(req, res)) return;
    }
    error(res, 404, 'NOT_FOUND', '页面不存在');
```

并在文件顶部加：

```javascript
// 演示模式的静态挂载：/src/domain/* 与 /rules/* 在 platform/ 下，不在 web/ 下。
// ⛔ 只读、只挂这两个白名单目录，不开放整个 platform/。
const DEMO_MOUNTS = [
  { prefix: '/src/domain/', dir: join(here, '..', 'src', 'domain') },
  { prefix: '/rules/', dir: join(here, '..', 'rules') },
];

function serveMounted(req, res) {
  for (const m of DEMO_MOUNTS) {
    if (!req.url || !req.url.startsWith(m.prefix)) continue;
    const rel = req.url.split('?')[0].slice(m.prefix.length);
    if (!rel) continue;
    // 浅拷贝一个只带 url/headers 的请求代理（serveStatic 只读这两个字段）
    const proxy = { url: `/${rel}`, headers: req.headers || {} };
    if (serveStatic(m.dir, proxy, res)) return true;
  }
  return false;
}
```

- [ ] **Step 8: 修改 `package.json` 与 `.gitignore`**

`platform/package.json` 的 `scripts` 改成（其余字段保持 P0 原样）：

```json
{
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test",
    "migrate": "node scripts/migrate.js",
    "seed": "node scripts/seed.js",
    "backup": "node scripts/backup.js",
    "restore": "node scripts/restore.js",
    "build:demo": "node scripts/build-demo.js",
    "serve:demo": "node scripts/serve-demo.js",
    "audit": "node scripts/audit-scan.js"
  }
}
```

仓库根 `.gitignore` 追加：

```gitignore
platform/web/dist/
platform/data/
```

- [ ] **Step 9: 运行测试确认通过**

Run: `cd platform && node --test test/demo-static.test.js`
Expected: PASS（5 个测试全过）

Run: `cd platform && node scripts/build-demo.js`
Expected: 输出 `[build-demo] 产物目录：…/web/dist` 与 `[build-demo] ✅ 领域层浏览器安全检查通过`

- [ ] **Step 10: 本地预览验证**

Run: `cd platform && node scripts/serve-demo.js &`
Run: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/`
Expected: `200`
Run: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/src/domain/scoring.js`
Expected: `200`（领域层在静态站里能直接被浏览器 import）
Run: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/rules/scoring-final.json`
Expected: `200`

- [ ] **Step 11: 发布为公网静态站并拿到 URL**

⚠️ **公开发布，需要用户确认**（任何人拿到链接都能打开）。

1. 先跑发布前扫描闸（发布闸不过不发布）：
   Run: `cd platform && node scripts/audit-scan.js`
   Expected: `[audit-scan] ✓ 未发现禁用表述`，退出码 0
2. 用静态站发布工具发布 `platform/web/dist/`：
   - `path` = `platform/web/dist`（**必须是构建产物**，目录里有 `index.html`）
   - `source_path` = `platform/web/dist`（自包含静态站，源码与产物同目录）
   - `project_name` = `heikesong-platform-demo`
3. **发布前必须得到用户明确确认**（公网可访问 + 源码会上传到私有云存储）。
4. 发布后把公网 URL 写进 `docs/deployment.md` 的「公网演示版」一节。

- [ ] **Step 12: 提交**

```bash
cd platform && git add scripts/build-demo.js scripts/serve-demo.js web/index.html web/app.js src/server.js package.json test/demo-static.test.js ../.gitignore
git commit -m "feat(P6): 演示站构建（领域层浏览器安全守卫）+ 相对路径 + 本地预览"
```

---

### Task 7: 部署与运维文档（`docs/deployment.md`）

**Files:**
- Create: `docs/deployment.md`（**仓库根 `docs/` 下**，与 `requirements-traceability.md` / `rule-decisions.md` 同级）

**Interfaces:**
- Consumes: 无
- Produces: 一份可照着做的运维手册（本地 / 内网 / 云主机 / 公网演示版 / 备份恢复 / 排障 / 扩容边界）

- [ ] **Step 1: 创建 `docs/deployment.md`**

```markdown
# 部署与运维手册 · AI 商业黑客松赛事平台

> 依据：设计文档 §14 部署（14.1 本地/内网、14.2 云主机、14.3 公网演示版）。
> **本手册是给人照着做的**——每条命令都能复制粘贴执行。

---

## 0. 三条必须先知道的硬约束

### 0.1 单写者：⛔ 禁止多 Node worker 进程同时写同一个 SQLite 文件

SQLite 官方原文：「There can only be a single writer at a time」。
**这是 `SQLITE_BUSY` 的真正来源**——不是"偶尔会重试一下"，是架构上不允许。

- ✅ **扩容只能加「读」**：静态资源交给 nginx 直出，几百并发静态请求根本不进 Node 进程。
- ⛔ `deploy/docker-compose.yml` 里**不要**配 `--workers` / `cluster`，也不要用 `scale` 扩副本。
- ⛔ `deploy/heikesong.service` 的 `ExecStart` 里**不要**加 `--cluster`。

### 0.2 WAL 要求所有进程在同一台主机

SQLite 官方原文：「All processes using a database must be on the same host computer;
WAL does not work over a network filesystem」。

- ⛔ 数据库文件**不能放 NFS / 网络盘**。
- ⚠️ **一旦要多机部署，必须换 Postgres，没有第三条路。**
  - 需要多机 → 换 Postgres（这时才允许多副本）。
  - 只有一台机 → 一直用 SQLite + nginx 单写者。

### 0.3 备份用 `sqlite.backup()` API，不用 `cp`

SQLite 官方 `backup.html` 列出 cp 方式的三个缺点：
① 备份期间其他写者须等锁释放；② 不能用于内存库；③ **复制过程中掉电可能导致备份损坏**。
`backup()` 是增量拷贝、源库只在真正读取的瞬间短暂加锁、结果是源库的 **bit-wise identical snapshot**。

**⚠️ WAL 模式下只 cp `.db` 不 cp `-wal` 会丢数据**——已提交但未 checkpoint 的事务还在 WAL 文件里。

```bash
# ✅ 正确
cd platform && node scripts/backup.js
# ⛔ 错误（会丢 WAL 里已提交的事务）
cp data/app.db /backup/app.db
```

---

## 1. 本地 / 内网

```bash
cd platform
node scripts/migrate.js     # 建库 + 迁移
node scripts/seed.js        # 种子数据（可选）
node src/server.js          # 默认 http://127.0.0.1:8080
```

环境变量：`PORT` `DATA_DIR` `SESSION_TTL_DAYS`

**零依赖**：不需要 `npm install`。`git clone` 完直接跑。

## 2. 云主机（一键部署）

### 2.1 前置条件

- Linux（systemd）；Ubuntu 22.04 / Debian 12 / Rocky 9 实测形态一致
- root 权限（`sudo`）
- 一个域名 + 已签发的 TLS 证书（certbot 签发即可）
- **单机**（见 §0.2：多机必须换 Postgres）

### 2.2 一键部署

```bash
git clone <仓库地址> heikesong && cd heikesong/platform
sudo SERVER_NAME=heikesong.example.com \
     CERT_PATH=/etc/letsencrypt/live/heikesong.example.com/fullchain.pem \
     KEY_PATH=/etc/letsencrypt/live/heikesong.example.com/privkey.pem \
     ADMIN_PASSWORD='<你的管理员口令>' \
     ./deploy/install.sh
```

`install.sh` 做这些事（**幂等，可重复执行**）：

1. 检查 Node ≥ 22.16.0，不满足则装 Node 24
2. 创建系统用户 `heikesong` 与数据目录 `/var/lib/heikesong/data`
3. 同步程序到 `/opt/heikesong/platform`
4. 写 `/etc/heikesong/platform.env`（**不含任何口令**）
5. 建库 + 迁移 + 初始化管理员（口令只在这一次用，不落盘）
6. 写并 enable systemd 单元 → 启动服务
7. 写 nginx 站点配置 → `nginx -t` 通过后 reload

**不设置 `SERVER_NAME` 就跳过 nginx 配置**（只跑 Node，直接用 `http://<ip>:8080`）。

### 2.3 常用运维命令

```bash
systemctl status heikesong           # 状态
journalctl -u heikesong -f           # 实时日志（走 journald）
systemctl restart heikesong          # 重启
curl -s http://127.0.0.1:8080/api/health
```

### 2.4 不用 Docker 的话

`deploy/docker-compose.yml` 是可选路径。它起**一个**容器（不配 `--workers`），
数据在 `app_data` 卷里，Node 只绑 `127.0.0.1:8080`，对外仍由 nginx 反代。

```bash
cd platform && docker compose -f deploy/docker-compose.yml up -d
```

---

## 3. 备份与恢复

### 3.1 备份

```bash
cd platform
node scripts/backup.js                       # 默认存 data/backups/
node scripts/backup.js --out /mnt/backup/    # 存到别处
node scripts/backup.js --keep-days 30 --keep-count 50
```

**保留策略**：文件名 `app-<UTC 时间戳>.db`；**最近 keepCount 份无条件保留，keepDays 天内的也保留**，其余删除。

**定时备份**（crontab，注意 crontab 里路径要写绝对路径）：

```cron
0 3 * * * cd /opt/heikesong/platform && DATA_DIR=/var/lib/heikesong/data /usr/bin/node scripts/backup.js >> /var/log/heikesong-backup.log 2>&1
```

### 3.2 恢复

⛔ **恢复前必须先停服务**——SQLite 拒绝在有其他连接写同一文件时安全替换文件，
强行替换会丢数据或损坏库（而且服务可能继续往被换掉的旧文件写）。

```bash
systemctl stop heikesong
cd platform
node scripts/restore.js                       # 恢复最近一份备份
node scripts/restore.js /path/to/app-xxx.db  # 恢复指定备份
systemctl start heikesong
```

脚本会：
1. 用 **pid 文件 + systemd** 探测服务是否在跑 → **在跑就拒绝执行**（`--force` 可跳过，但不建议）
2. 对备份文件跑 `PRAGMA integrity_check` → 不通过就拒绝
3. 把旧库留成 `app.db.before-restore-<时间戳>`
4. **删掉旧的 `app.db-wal` / `app.db-shm`**（它们属于旧库，留着会污染新库）
5. 换上新库

---

## 4. 扩容边界：什么时候必须换 Postgres

| 场景 | 能不能用 SQLite | 说明 |
|---|---|---|
| 一台云主机，几十到几千并发静态请求 | ✅ 可以 | 静态资源由 nginx 直出，不进 Node |
| 一台云主机，几十到几百并发 API 请求 | ✅ 可以 | 数据量极小（~50 人 → 几千行） |
| **多台机器同时写同一个库** | ⛔ 不行 | WAL 不能跨主机；SQLite 只能单写者 |
| 读写分离（多副本 + 独立读库） | ⛔ 不行 | 必须换 Postgres |

**换 Postgres 的信号**：需要多机部署 / 需要多写者 / 需要在线扩容。
在那之前，**先加 nginx 副本（只加读）**，不要加 Node 副本。

---

## 5. 公网演示版

**当前没有云主机**时，公网演示版 = **同源静态前端 + `web/api.demo.js`（localStorage 适配器）**。

- ✅ 规则引擎**在浏览器里真实运行**（直接 import `src/domain/*.js`），算法行为与正式系统一致
- ⛔ 数据不跨人共享（各自浏览器独立）

```bash
cd platform
node scripts/build-demo.js     # 产出 web/dist/（自包含静态站）
node scripts/serve-demo.js     # 本地预览 http://127.0.0.1:8090/
```

发布到公网：把 `web/dist/` 作为静态站发布（根目录必须有 `index.html`）。
**发布前必须跑扫描闸**：`node scripts/audit-scan.js`（退出码非 0 = 发布中止）。

**正式版后端仍然是云主机部署**（见 §2）——演示版不替代它。

---

## 6. 排障

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| `SQLITE_BUSY` | 起了多个写进程 | 查 `ps aux \| grep 'src/server.js'`；只留一个（见 §0.1） |
| 榜单名次每次重算都不一样 | 破同分链没落到底 | 查 `rules/tiebreak.json` 末项是否 `deterministic: true` |
| 备份文件比源库小很多 | 用了 `cp` 而没带 `-wal` | 改用 `node scripts/backup.js`（见 §0.3） |
| 恢复后启动报 `database disk image is malformed` | 旧 `-wal` 没删 | 删掉 `data/app.db-wal`、`data/app.db-shm` 再恢复 |
| 页面一直转圈（SSE 不更新） | nginx 开了缓冲 | 确认 `proxy_buffering off;` 与 `add_header X-Accel-Buffering no;` |
| 审计日志里 IP 全是 127.0.0.1 | nginx 没透传真实 IP | 确认 `X-Real-IP` / `X-Forwarded-For` 两个头都在 |
| 改了 `rules/*.json` 但榜单没变 | 读的是旧快照 | 重算（`POST /api/stages/:stageId/compute`）后重新发榜 |
| 演示站白屏 | 浏览器拒绝了模块导入 | 看控制台：多半是 `src/domain/*` 里有 Node 内置模块导入（构建时会拦） |

---

## 7. 发布前检查清单

```bash
cd platform
node --test            # 全绿
node scripts/audit-scan.js   # 扫描闸：禁用表述 0 命中
node scripts/build-demo.js   # 演示站构建：领域层浏览器安全检查通过
```

---

*配套：[`superpowers/specs/2026-10-20-heikesong-platform-design.md`](superpowers/specs/2026-10-20-heikesong-platform-design.md)｜[`requirements-traceability.md`](requirements-traceability.md)｜[`rule-decisions.md`](rule-decisions.md)｜[``]()*
```

- [ ] **Step 2: 校验文档里的关键约束确实写进去了**

Run: `cd .. && grep -c "single writer at a time" docs/deployment.md && grep -c "proxy_buffering off" docs/deployment.md && grep -c "backup()" docs/deployment.md`
Expected: 三个数字都 ≥ 1（`1`、`1`、`2`）

- [ ] **Step 3: 提交**

```bash
cd /Users/mac/soft/AI/orca/heikesong && git add docs/deployment.md
git commit -m "docs(P6): 部署与运维手册（单写者 / WAL 同主机 / 备份用 backup API / nginx SSE）"
```

---

### Task 8: 端到端与跨平台验收

**Files:**
- Test: `platform/test/p6-e2e.test.js`
- Test: `platform/test/portability.test.js`

**Interfaces:**
- Consumes: 全部上游阶段产出的 API（`INTERFACES.md` §1–§6）
- Produces: 一条覆盖「报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API」的全链路验收测试 + 跨平台可移植性验收

- [ ] **Step 1: 写失败的测试**

`platform/test/p6-e2e.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/server.js';
import { buildDemoState, createDemoApi } from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(here, '..', 'rules'));

test('全链路：报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API', async () => {
  const api = createDemoApi({ storage: makeStorage(), seed, rules });

  await api.post('/api/auth/login', { name: '演示管理员' });

  // 1. 报名
  const reg = await api.post('/api/registrations', {
    answers: {
      direction: [5, 4, 5, 5, 4], capability: [4, 4, 5, 5, 5], collaboration: [5, 5, 4, 5, 5],
      open: '演示报名：把门店缺货预测做成可落地的试点。',
    },
  });
  assert.ok(['S', 'A', 'B'].includes(reg.level), `报名等级应为 S/A/B，实际 ${reg.level}`);
  assert.ok(reg.explain.length > 0, '报名必须给出可解释明细');

  // 2. 组队
  const team = await api.post('/api/teams', {
    name: '验收队', taskPackageId: 'tp_manu', captainId: 'mba_captain',
    memberIds: ['mba_captain', 'demo_member_1'],
  });
  assert.ok(team.id);
  assert.equal(team.formation.ok, true);

  // 3. 打分
  const review = await api.post('/api/stages/stage_final/reviews', {
    items: [{ judgeId: 'j_mid1', teamId: 't_gamma', dimension: 'completeness', rawScore: 88 }],
  });
  assert.equal(review.submitted, 1);

  // 4. 计算
  const computed = await api.post('/api/stages/stage_final/compute', {});
  assert.ok(computed.computationId);
  assert.ok(computed.teams.length === seed.teams.length);
  assert.ok(computed.trace && computed.trace.normalization);

  // 5. 发榜
  const lb = await api.get('/api/leaderboard/stage_final?scope=rank');
  assert.equal(lb.rows.length, seed.teams.length);
  assert.equal(lb.rows[0].rank, 1);

  // 6. 段位
  const tier = await api.get('/api/teams/t_delta/tier');
  assert.equal(tier.tier, 'S', 't_delta 有 5 项里程碑 + 业务部门签字 → S 段');

  // 7. 战绩卡
  const card = await api.get('/api/teams/t_delta/performance-card');
  assert.equal(card.items.length, rules.milestones.items.length);
  assert.ok(card.items.filter((i) => i.achieved).length >= 5);

  // 8. 三池
  for (const kind of ['projects', 'talents', 'resources']) {
    const pool = await api.get(`/api/pools/${kind}`);
    assert.ok(pool.rows.length > 0, `三池 ${kind} 不能是空的`);
  }

  // 9. 公开 API（无登录，靠 token）
  const pub = await api.get('/api/public/leaderboard?editionId=ed_demo&token=demo');
  assert.ok(pub.rows.length > 0);
});

test('正式服务的路由清单覆盖 INTERFACES.md 里约定的全部 API', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  const webDir = join(here, '..', 'web');
  const app = createApp({ db, rules, webDir });
  const routes = app.router.list();
  close();
  rmSync(dataDir, { recursive: true, force: true });

  // INTERFACES.md §2–§6 里约定的 API（路径里的 :param 统一成 :*）
  const expected = [
    'POST /api/registrations',
    'GET /api/registrations',
    'POST /api/teams',
    'GET /api/teams/*',
    'POST /api/task-packages',
    'GET /api/task-packages',
    'POST /api/stages/*/reviews',
    'GET /api/stages/*/review-state',
    'POST /api/stages/*/compute',
    'GET /api/stages/*/computations/*',
    'GET /api/leaderboard/*',
    'GET /api/leaderboard/rolling',
    'GET /api/teams/*/performance-card',
    'GET /api/teams/*/tier',
    'GET /api/audit/computations/*',
    'GET /api/audit/log',
    'GET /api/workflows/*/tasks',
    'POST /api/tasks/*/claim',
    'GET /api/pools/projects',
    'GET /api/pools/talents',
    'GET /api/pools/resources',
    'GET /api/public/leaderboard',
  ];
  const norm = (s) => s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':*');
  const actual = new Set(routes.map((r) => `${r.method} ${norm(r.pattern)}`));
  const missing = expected.filter((e) => !actual.has(e));
  assert.deepEqual(missing, [], `正式服务缺少这些路由：${missing.join('、')}`);
});

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
```

`platform/test/portability.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDomainIsBrowserSafe } from '../scripts/build-demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const repoRoot = join(platformDir, '..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('零 npm 依赖：没有 node_modules、没有 package-lock.json', () => {
  assert.equal(existsSync(join(platformDir, 'node_modules')), false);
  assert.equal(existsSync(join(platformDir, 'package-lock.json')), false);
  const pkg = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('领域层不得依赖 Node 内置模块（跨平台 + 浏览器双重约束）', () => {
  const violations = assertDomainIsBrowserSafe(join(platformDir, 'src', 'domain'));
  assert.deepEqual(violations, [], violations.join('；'));
});

test('所有 shell 脚本都 set -euo pipefail 且不依赖当前工作目录', () => {
  const scripts = walk(platformDir).filter((f) => f.endsWith('.sh'));
  assert.ok(scripts.length > 0, '至少要有一个 shell 脚本');
  for (const f of scripts) {
    const code = readFileSync(f, 'utf8');
    assert.match(code, /^set -euo pipefail$/m, `${relative(repoRoot, f)} 缺 set -euo pipefail`);
  }
  const install = readFileSync(join(platformDir, 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /\$\(cd "\$\(dirname "\$0"\)" && pwd\)/, 'install.sh 必须用脚本自身位置定位');
});

test('仓库里没有写死的本机绝对路径（换机器就能跑）', () => {
  const files = walk(platformDir).filter((f) => /\.(js|json|sh|md|yml|service|conf)$/.test(f));
  const offenders = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    if (code.includes('/Users/') || code.includes('/Volumes/')) {
      offenders.push(relative(repoRoot, f));
    }
  }
  assert.deepEqual(offenders, [], `这些文件里写死了本机路径：${offenders.join('、')}`);
});

test('部署资产里没有硬编码口令', () => {
  for (const name of ['install.sh', 'heikesong.service', 'nginx.conf', 'docker-compose.yml']) {
    const code = readFileSync(join(platformDir, 'deploy', name), 'utf8');
    assert.doesNotMatch(code, /PASSWORD\s*=\s*["'][^"'$]/, `${name} 里出现了硬编码口令`);
    assert.doesNotMatch(code, /password\s*[:=]\s*["'][^"'$]/i, `${name} 里出现了硬编码口令`);
  }
});

test('领域层是纯函数：不碰 IO、不读时钟、不用随机数', () => {
  const domainDir = join(platformDir, 'src', 'domain');
  for (const name of readdirSync(domainDir).filter((n) => n.endsWith('.js'))) {
    const code = readFileSync(join(domainDir, name), 'utf8');
    assert.doesNotMatch(code, /Date\.now\(\)/, `${name} 用了 Date.now()（时间必须由参数传入）`);
    assert.doesNotMatch(code, /Math\.random\(\)/, `${name} 用了 Math.random()（随机数必须由参数传入）`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/p6-e2e.test.js test/portability.test.js`
Expected: FAIL —— 缺 `test/p6-e2e.test.js` / `test/portability.test.js`（本步是先建文件再跑）

> ⚠️ `p6-e2e.test.js` 的「路由清单」用例依赖 **P1–P5 已经把路由挂进 `src/server.js`**。
> **如果这条用例失败，说明上游某个阶段没挂路由 → 修上游，不要放宽断言。**
> 同理，`portability.test.js` 的「领域层是纯函数」用例如果失败，说明 P2/P3 的领域层里混进了 `Date.now()` / `Math.random()`
> → 修领域层（`INTERFACES.md` §0 规定：时间与随机数一律由参数传入）。

- [ ] **Step 3: 全量测试**

Run: `cd platform && node --test`
Expected: 全部通过（0 fail）

- [ ] **Step 4: 跨平台复现（在另一台机器上）**

```bash
# 在源机器
cd /path/to/heikesong && git add -A && git commit -m "chore(P6): 跨平台复现基线"
# 把 platform/ 拷到另一台机器（Mac / Windows / Linux 都行）
scp -r platform/ other-machine:/tmp/platform
# 在另一台机器上，只跑这三条命令（不联网、不 npm install）
cd /tmp/platform
node scripts/migrate.js
node --test
node scripts/build-demo.js
```

Expected: 三条命令全部成功，**不需要 `npm install`**，**不需要任何原生编译**。

> ⚠️ **Windows 特别说明**：Windows 上没有零依赖的守护方案（Node 进程不是 Windows 服务）。
> 组员本地手动起进程即可；**云主机一律 Linux + systemd**（设计文档 §16 风险 11）。

- [ ] **Step 5: 提交**

```bash
cd platform && git add test/p6-e2e.test.js test/portability.test.js
git commit -m "test(P6): 全链路验收 + 跨平台可移植性验收"
```

---

## P6 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P6-1 | 备份用 `backup()` API 且不丢 WAL 事务 | `node --test test/backup.test.js` 通过：WAL 用例断言「备份里有那笔事务、只 cp .db 的副本里没有」 |
| P6-2 | 恢复前必须停服务，且恢复后数据正确、旧 `-wal`/`-shm` 被清 | `node --test test/restore.test.js` 通过：pid 文件指向活进程时恢复被拒且数据未动；恢复后读到的是备份里的数据；`app.db-wal` 不存在 |
| P6-3 | 部署资产齐全且守住单写者 | `node --test test/deploy-assets.test.js` 通过：service/compose 均无 `--workers`/`cluster`，unit 非 root |
| P6-4 | nginx 四组指令一字不差 | 同上用例断言 `Connection ''` / `X-Real-IP` / `X-Forwarded-For` / `proxy_buffering off` / `X-Accel-Buffering no` 全部存在 |
| P6-5 | install.sh 幂等且不硬编码口令 | `bash -n deploy/install.sh` 通过；测试断言无字面口令、`ADMIN_PASSWORD` 来自环境变量 |
| P6-6 | 扫描闸能识别「闸未生效」 | `node --test test/audit-scan-release.test.js` 通过：空清单 → errors 含「闸未生效」 |
| P6-7 | 故意写错的被拦、更正语境被豁免 | 同上：`积分占决赛 30%` 被拦 1 处；`CICC 四维各 25%` 带更正标记 → 0 违规 1 豁免；裸引用仍被拦 |
| P6-8 | 演示版规则引擎真实运行且与正式版一致 | `node --test test/demo-parity.test.js` 通过：`demo.teams` 与直接调 `scoreStage()` 的结果 `deepEqual` |
| P6-9 | 种子数据触发每条 trace 分支 | `node --test test/demo-engine.test.js` 通过：同分两队总分严格相等、破同分链在 `peer` 级分开、`normalization_fallback` 告警命中、`R2_missing_dual_signature` 告警命中、行为分变化不影响总分 |
| P6-10 | 领域层不得依赖 Node 内置模块 | `node --test test/demo-static.test.js` 通过：`assertDomainIsBrowserSafe()` 返回空数组；守卫用例证明它能拦下 `node:fs` |
| P6-11 | 静态站产物自包含且路径相对 | 同上：`web/dist/index.html` 存在，HTML 里没有 `src="/…"`；产物含 `src/domain/`、`rules/`、`seed/` |
| P6-12 | 公网演示 URL 可访问 | 发布 `platform/web/dist/` 后打开公网 URL：页面能加载、能登录、能点「计算」并看到 trace 与破同分链 |
| P6-13 | 全链路 + 跨平台 | `node --test` 全绿；把 `platform/` 拷到另一台机器，只跑 `migrate` / `test` / `build-demo` 三条命令即通过 |
| P6-14 | 文档写清边界与升级条件 | `docs/deployment.md` 含「single writer at a time」「proxy_buffering off」「backup()」「多机必须换 Postgres」四处 |

---

## 与接口契约的偏差

> 本节列出本计划与 `INTERFACES.md`（跨阶段接口契约，最高权威）**不完全一致**的地方，以及采取的处理方式。
> **`INTERFACES.md` 未被修改。**

| # | 偏差 | 处理 |
|---|---|---|
| 1 | `INTERFACES.md` §5（P4）与 §7（P6）**都**列了 `scripts/audit-scan.js`，存在归属重叠 | **P6 不重建该文件**（两个 writer 写同一路径必然冲突）。P6 在 P4 已建的实现上**追加**发布产物扫描 / `--forbidden` / `--json` / `--evidence-chain`，并新建独立测试文件 `test/audit-scan-release.test.js`（不改 P4 的 `test/audit-scan.test.js`）。`parseManifest` / `scanText` / `scanRoots` / `main` 的**签名一律不变**。 |
| 2 | `INTERFACES.md` §4.3 的目录结构写 `seed/ demo-data.json`（在 `platform/` 根下），而 §7 与本计划写 `web/seed/demo-data.json` | **以 `INTERFACES.md` §7（P6 产出清单）为准**：用 `web/seed/demo-data.json`。理由：演示站要发布 `web/` 目录，种子数据必须在其中才能被静态站 fetch 到。 |
| 3 | `INTERFACES.md` §1 规定 `serveStatic(webDir, req, res)` | **签名保持不变**。演示模式需要的 `/src/domain/*` 与 `/rules/*` 两个挂载点**在 `src/server.js` 里**用「换 webDir + 浅拷贝请求代理」实现，不改 `serveStatic` 本体。 |
| 4 | `INTERFACES.md` §1 规定 `createApp({ db, rules, webDir })` | **签名与参数保持不变**（没有新增任何必填或可选参数）。演示模式挂载是模块级常量 + 模块级函数，与 `createApp` 无关。 |
| 5 | `INTERFACES.md` §2–§6 没有收录 P6 需要的 `src/runtime/pidfile.js` | 这是 P6 **新增**的模块（服务于「恢复前先停服务」这条约束），不与任何既有接口冲突。 |
| 6 | `INTERFACES.md` §1 的 P0 产出清单里没有 `scripts/backup.js` / `scripts/restore.js`（P6 §7 才有） | 一致，无偏差。`backupDatabase` / `restoreDatabase` / `checkServiceState` / `verifyBackupFile` 是 P6 **新增**导出，不覆盖任何既有签名。 |
| 7 | `web/api.demo.js` 里的规则加载方式 | `INTERFACES.md` 未规定前端如何取规则。P6 用「按文件名逐个 `fetch` `rules/*.json`」的方式，**不新增 `rules/index.json` 这类聚合文件**（避免与 `src/config.js` 的 `RULE_FILES` 产生第二份真相），并由 `scripts/build-demo.js` 校验所需文件齐全。 |
| 8 | **P4 的 `scripts/forbidden.txt` 有三条词条永远命中不了** | P4 的 `scanText()` 用 **`line.includes(term)` 字面串匹配**，但 P4 清单里有 `四维各 ?25%` / `初赛企业确认权重 ?20%` / `w_E ?= ?20%.*初赛` —— `?` 与 `.*` 在字面匹配下没有意义，**这三条词条等于没写**（R-AUD-03 被架空）。P6 在「修改 `scripts/forbidden.txt`」这一步里把这几条**拆成空格变体**（沿用平台自带 `platform/scripts/forbidden.txt` 的既有约定：空格变体各写一条），P6 自己新增的词条也一律用字面串。**不改 `scanText` 的匹配语义**（P4 的行为与测试都不动）。 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*


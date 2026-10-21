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

## 部署目标决策登记（2026-10-21 用户拍定）

> **结论**：部署资产按**完整、规范的正式上线要求**设计 —— **域名 + TLS + ICP 备案**。
> 阿里云上海 `8.133.200.235` **只作临时的展示与调试环境**，先用 **IP + 端口** 的形式跑通。
> 公网演示版（静态站）**暂缓**，先把 P2–P5 建完。

### 为什么正式形态必须要求域名 + TLS

**ICP 备案是硬约束，不是可选项。** 阿里云官方文档明确：
未备案域名解析到**中国内地**服务器，会被监测系统识别并**阻断**访问；
解析到**非中国内地**服务器则无需 ICP 备案（但需公安备案）。
且**备案系统只支持域名备案，不支持 IP 备案** —— 想合规只有「备案域名」这一条路。
（来源：[备案域名注意事项](https://help.aliyun.com/zh/document_detail/179336.html)、
[未备案域名解析至不同地区是否可以访问](https://help.aliyun.com/zh/icp-filing/support/not-for-the-record-dns-can-access-to-different-areas)）

因此正式资产**必须**具备：域名、`server_name`、certbot 签发的 TLS 证书、
`listen 443 ssl` + `/.well-known/acme-challenge/`（HTTP-01 续签）。
这几条正是本计划 `deploy/nginx.conf` 与 `deploy/install.sh` 已经写好的形态 —— **不改**。

### 临时调试形态（上海机）要额外满足的四条

调试环境用 **IP + 端口**，因此**不能复用**正式形态的那套 nginx 配置，必须**另开一套**：

| # | 要求 | 原因 |
|---|---|---|
| D-1 | 另起一个 nginx `server` 块：**只 `listen 8080`（或指定端口）、不配 TLS、不配 `server_name`** | 正式形态的 `listen 443 ssl` 在这台机上**已被占用**（nginx + 现有 Let's Encrypt 证书）；调试形态不能碰它 |
| D-2 | **不设 `NODE_ENV=production`**，或让 `install.sh` 在调试形态下把 `secureCookies` 强制关掉 | `src/server.js` 的 `secureCookies = process.env.NODE_ENV === 'production'` → cookie 带 `Secure` → **浏览器在 `http://` 下直接拒收 → 登录失效**。这是 IP+HTTP 形态独有的坑，必须在部署资产里显式处理 |
| D-3 | 平台进程**只绑 `127.0.0.1`**，由 nginx 反代出去 | 与正式形态一致；且调试机上还有 sub-store(80/8443)、frps(7000)、HydroOJ(8888) 共存，不能裸暴露 Node 端口 |
| D-4 | **先修 `frps` 的鉴权**（当前 `bindPort=7000` **完全无认证**且公网可达），再把平台数据放上去 | 任何人可借 frps 把流量打进这台机的内网（含 `127.0.0.1:8080`）；平台会持有真实报名数据 / IP 归属 / 里程碑签字 |

### 端口与网络现状（2026-10-21 实测，供 install.sh 排障用）

外部多机位扫描 + 直连探测（**未对服务器做任何改动**）：

| 端口 | 现状 | 公网可达 |
|---|---|---|
| 22 | SSH（口令登录） | ✅ |
| 80 | nginx → 一个**需鉴权的 Go 服务**（`/api/*` 返 `Unauthorized`） | ✅ 4/4 |
| 443 | nginx + Let's Encrypt 证书（**已被占用**） | ✅ 4/4 |
| 7000 | **frps v0.61.2，无鉴权** | ✅ |
| 8443 | sub-server 直连口（**安全组是白名单**，外部仅 1/4 通） | ⚠️ |
| 8888 | HydroOJ | ✅ |
| 27017 | mongod（仅本机） | — |

⇒ 调试形态的端口需**新开一个**（默认 8080），并在**阿里云安全组**放行。
⇒ 安全组是**白名单**制：放行一个端口要同时改安全组**和**确认机器内没被别的服务占用。

### 公网演示版（静态站）本轮**不做**

按用户决定推迟到 P2–P5 之后。**不影响**正式资产的实现 —— 演示版是 P6 的 Task 4/5/6，
与 Task 1/2/3（备份恢复、部署资产、扫描闸）无耦合。

---

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
- Modify: `platform/src/db/migrate.js`（**追加**导出 `currentVersion(db)`；P0 已建，本阶段只**追加**一个函数，**不改** `applyMigrations` 的签名与行为）
- Modify: `platform/src/server.js`（启动写 pid 文件、退出删）
- Test: `platform/test/backup.test.js`
- Test: `platform/test/restore.test.js`

> **【2026-10-21 实施补记】** 规格自带的 **8 个用例逐字保留**；实施阶段**追加 10 个判别性用例**
> （保留策略的「份数 ∪ 天数」语义、`backupDatabase` 自己套用策略、命令行入口可执行、
> `-wal`/`-shm` 恢复后**立刻**清理、旧库必须真留在磁盘、临时文件必须清干净、
> 「能打开但完整性不通过」的备份、pid 文件内容损坏、pid 文件指向已退出进程、
> 服务启动/退出写删 pid 文件、真实生产 schema 备份往返）。
> 逐条理由与实跑证据见文末「Task 1 实施台账（2026-10-21）」。

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
// platform/test/backup.test.js —— 备份脚本（sqlite.backup() API，不用 cp）
//
// 规则溯源：
//   - 「备份用 sqlite.backup() API，不用 cp」→ 设计文档 §14.2【决策】+ SQLite 官方 backup.html
//   - 「保留最近 keepCount 份 且 保留 keepDays 天内的」→ P6 计划 Global Constraints「保留策略」
//   - 「备份文件名 = app-<UTC 时间戳>.db」→ 同上
//
// ⚠️ 本文件的核心用例是「WAL 模式下备份包含已提交但未 checkpoint 的事务」：
//    它**同时**断言正反两面 —— backup() 拷到了那笔事务，而只 cp .db 的副本没拷到。
//    只断言正面会退化成「跑通即算」；只断言反面则证明不了 backup() 做对了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, copyFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/sqlite.js';
import { backupDatabase, listBackups, pruneBackups, backupFileName } from '../scripts/backup.js';

const here = dirname(fileURLToPath(import.meta.url));

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

// ── 判别性补充用例 ────────────────────────────────────────────
// ⚠️ 上一条保留策略用例**区分不出两种算法**：
//    「只按 keepCount 保留」与「keepCount ∪ keepDays 保留」在它那份数据上给出**完全相同**的结果
//    （超期的 2 份同时也超份数；未超期的 3 份本来就在前 10 份里）。
//    ⇒ 下面这条用「两种算法结果不同」的数据集，把语义钉死。
test('保留策略是「份数 ∪ 天数」：没超天数的旧备份即使超出份数也必须保留', () => {
  const dir = tempDir('hks-prune2-');
  const now = new Date('2026-10-20T12:00:00Z');
  const names = [];
  // 3 份全部在 keepDays=7 之内，但 keepCount=1 ⇒ 只有「份数 ∪ 天数」才会全保留
  for (let i = 0; i < 3; i += 1) {
    const name = backupFileName(new Date(now.getTime() - i * 3600_000));
    const p = join(dir, name);
    writeFileSync(p, 'x');
    const t = (now.getTime() - (i + 1) * 3600_000) / 1000;
    utimesSync(p, t, t);
    names.push(name);
  }

  const removed = pruneBackups(dir, { keepDays: 7, keepCount: 1, now });
  assert.deepEqual(removed, [], '未超保留天数的备份一律保留（keepCount 只是下限，不是上限）');
  assert.equal(listBackups(dir).length, 3, '三份都必须还在');

  rmSync(dir, { recursive: true, force: true });
});

test('backupDatabase 自己套用保留策略，并报告页数与被清理的文件', async () => {
  const dataDir = tempDir('hks-bkprune-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  // ⚠️ 造一个**多轮迭代**的库（> 100 页 = backup() 的默认 rate），
  //    否则 progress 回调一次都不触发，测不出「页数报的是总量还是剩余量」。
  db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000)
          INSERT INTO t (v) SELECT hex(randomblob(500)) FROM c`);
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  assert.ok(pageCount > 100, `前置条件：库必须大于 100 页（实际 ${pageCount}）`);
  close();

  const backupDir = join(dataDir, 'backups');
  const now = new Date();
  // 第一份：20 天前（超 keepDays=7）→ 应被清掉
  const old = await backupDatabase({
    dataDir,
    backupDir,
    now: new Date(now.getTime() - 20 * 86400_000),
  });
  const t = (now.getTime() - 20 * 86400_000) / 1000;
  utimesSync(old.path, t, t);
  // 第二份：1 天前（未超天数，但会超出 keepCount=1）→ 必须保留
  const recent = await backupDatabase({
    dataDir,
    backupDir,
    now: new Date(now.getTime() - 86400_000),
  });
  const t2 = (now.getTime() - 86400_000) / 1000;
  utimesSync(recent.path, t2, t2);

  // 第三份触发清理
  const third = await backupDatabase({
    dataDir,
    backupDir,
    now,
    keepCount: 1,
    keepDays: 7,
  });
  assert.deepEqual(third.removed, [old.file], '超天数且超份数的旧备份必须被清掉');
  assert.equal(existsSync(old.path), false, '旧备份文件必须已删除');
  assert.equal(existsSync(recent.path), true, '未超天数的备份必须保留（哪怕超出份数）');
  assert.equal(third.pages, pageCount, '备份必须报告源库的总页数（不是剩余页数）');
  assert.ok(third.bytes > 0, '备份文件必须有内容');

  rmSync(dataDir, { recursive: true, force: true });
});

test('命令行入口可执行：node scripts/backup.js 真的备份并打出完成信息', () => {
  const dataDir = tempDir('hks-bk-cli-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  close();

  // ⚠️ 这条守住「脚本被当库 import 时不跑、但当命令跑时要真跑」这条边界：
  //    isMain 判定一旦写错（例如 realpathSync 吃了 file:// URL 而抛 ENOENT），
  //    命令行会**静默什么都不干、退出码 0** —— 没有这条用例就查不出来。
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(here, '..', 'scripts', 'backup.js')],
    { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } },
  );
  assert.equal(res.status, 0, `备份脚本必须以 0 退出，实际输出：${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /\[backup\] 完成：app-\d{8}T\d{6}Z\.db/, `备份脚本必须打出完成信息，实际：${res.stdout}`);
  const made = listBackups(join(dataDir, 'backups'));
  assert.equal(made.length, 1, '命令行必须真的产出备份文件');

  rmSync(dataDir, { recursive: true, force: true });
});
```

`platform/test/restore.test.js`：

```javascript
// platform/test/restore.test.js —— 恢复脚本（先停服务 → 验完整性 → 换库 → 清 -wal/-shm）
//
// 规则溯源：
//   - 「恢复前必须先停服务：脚本用 pid 文件 + systemd 探测，服务在跑 → 拒绝执行」
//     → P6 计划 Global Constraints「恢复前置」+ 设计文档 §14.2
//   - 「恢复后必须删掉旧的 -wal / -shm（它们属于旧库，留着会污染新库）」→ 同上
//   - 「备份文件名 = app-<UTC 时间戳>.db」→ P6 计划 Global Constraints「保留策略」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations, currentVersion } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { backupDatabase } from '../scripts/backup.js';
import { checkServiceState, verifyBackupFile, restoreDatabase } from '../scripts/restore.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 轮询直到条件成立或超时；返回条件的结果（超时返回 null）。 */
async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
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

  // ⚠️ 判别性断言必须**紧接恢复之后**做：
  //    规格里那条断言放在「新库打开并关闭之后」——可 SQLite 自己会在
  //    打开时重建 -wal、关闭时删掉 -wal/-shm ⇒ 就算恢复**没删**旧 sidecar，
  //    这条断言照样绿（实测：变异体 M18 存活）。放在恢复返回后立刻断言才判别。
  assert.equal(existsSync(join(dataDir, 'app.db-wal')), false, '恢复后必须立刻删掉旧 -wal（它属于旧库）');
  assert.equal(existsSync(join(dataDir, 'app.db-shm')), false, '恢复后必须立刻删掉旧 -shm（它属于旧库）');
  assert.equal(existsSync(join(dataDir, 'app.db.restore.tmp')), false, '恢复成功后不得留下临时文件');

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
  // ⚠️ 只看 steps 不够：步骤文本与磁盘上的文件是**两件事**。
  //    变异体 M19（把 rename 换成 unlink）保留了步骤文本 ⇒ 只断言 steps 会漏。
  const kept = readdirSync(dataDir).filter((f) => f.startsWith('app.db.before-restore-'));
  assert.equal(kept.length, 1, `旧库必须以 .before-restore-<时间戳> 留在磁盘上，实际：${readdirSync(dataDir).join(', ')}`);
  assert.ok(existsSync(join(dataDir, kept[0])), '留存的旧库必须真的有内容');
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 判别性补充：能打开 ≠ 完好 ────────────────────────────────
// ⚠️ 规格里那条「备份文件损坏时拒绝恢复」用的是**根本不是 sqlite 的文件**——
//    它在**打开**阶段就被拒 ⇒ 跳不跳过 integrity_check 都一样拒 ⇒ 不判别。
//    这条用「能打开但页已损坏」的库，逼出 integrity_check 真的在干活。
test('备份文件能打开但完整性检查不通过时也拒绝恢复（不能只看「打得开」）', async () => {
  const dataDir = tempDir('hks-rs-corrupt-');
  const p = join(dataDir, 'corrupt.db');
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 800)
          INSERT INTO t (v) SELECT hex(randomblob(300)) FROM c`);
  db.close();

  // 把第 3 页整页清零：页头完好 ⇒ 文件**仍能打开**，但 integrity_check 报出坏页
  const fd = openSync(p, 'r+');
  writeSync(fd, Buffer.alloc(4096), 0, 4096, 4096 * 2);
  closeSync(fd);

  const opens = new DatabaseSync(p, { readOnly: true });
  opens.close();

  const check = verifyBackupFile(p);
  assert.equal(check.ok, false, '完整性检查不通过必须判为不可用');
  assert.notEqual(check.integrity, 'ok', 'integrity 字段必须如实报告检查结果');
  assert.ok(check.error, '必须给出错误原因');

  const result = restoreDatabase({ dataDir, backupFile: p, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false, '有损坏的备份必须拒绝恢复');
  assert.ok(result.error.includes('完整性') || result.error.includes('损坏') || result.error.includes('integrity'));

  rmSync(dataDir, { recursive: true, force: true });
});

// ── 判别性 / 稳健性补充用例 ──────────────────────────────────
test('校验备份文件后不在旁边留下 -wal / -shm 残留', async () => {
  const dataDir = tempDir('hks-rs-side-');
  const backup = await makeBackup(dataDir);
  const check = verifyBackupFile(backup.path);
  assert.equal(check.ok, true, check.error ?? '');
  // ⚠️ 只读打开一个 WAL 标志的库，SQLite 会在文件旁建出 -wal / -shm 且关库后不删
  //    （sqlite.org/wal.html）。保留策略只认 *.db ⇒ 这些残留永不被清理 ⇒ 备份目录无限膨胀。
  assert.equal(existsSync(`${backup.path}-wal`), false, '校验不得在备份目录留下 -wal 残留');
  assert.equal(existsSync(`${backup.path}-shm`), false, '校验不得在备份目录留下 -shm 残留');
  rmSync(dataDir, { recursive: true, force: true });
});

test('pid 文件内容损坏时也拒绝恢复（拿不到「服务已停」的证据就保守拒绝）', async () => {
  const dataDir = tempDir('hks-rs-badpid-');
  const backup = await makeBackup(dataDir);
  writeFileSync(join(dataDir, 'app.pid'), 'not-a-pid', 'utf8');
  const state = checkServiceState({ dataDir });
  assert.equal(state.running, true, 'pid 文件存在但内容不可解析 → 无法确认服务已停 → 必须判为在跑');
  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false, '拿不到停服证据时必须拒绝恢复');
  assert.ok(result.error.includes('服务'), `错误信息必须点明原因，实际：${result.error}`);
  rmSync(dataDir, { recursive: true, force: true });
});

test('pid 文件指向已退出的进程时视为「服务未在跑」（陈旧残留不阻塞恢复）', async () => {
  const dataDir = tempDir('hks-rs-stale-');
  const backup = await makeBackup(dataDir);
  // 起一个立刻退出的子进程，拿到一个**确定已死**的 pid
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(dead.pid, '拿不到已退出子进程的 pid');
  writeFileSync(join(dataDir, 'app.pid'), String(dead.pid), 'utf8');

  const state = checkServiceState({ dataDir });
  assert.equal(state.running, false, '进程已退出 → 不得判为在跑');
  assert.equal(state.stale, true, '必须标记为陈旧残留');
  assert.ok(state.reason.includes('pid'), '必须说明为什么判定服务没在跑');

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, `陈旧 pid 不该阻塞恢复：${result.error ?? ''}`);
  rmSync(dataDir, { recursive: true, force: true });
});

test('服务启动时写 pid 文件、收到 SIGTERM 后删除（restore 的停服探测靠它）', async () => {
  const dataDir = tempDir('hks-rs-pid-');
  const serverPath = join(here, '..', 'src', 'server.js');
  let out = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    // ⚠️ 必须等到**真正开始监听**再往下走：
    //    pid 文件是在 openDatabase 之后立刻写的（早于迁移与 listen），
    //    若此时就发 SIGTERM，server.close() 可能落在 listen 之前 → 子进程以
    //    ERR_SERVER_NOT_RUNNING 崩掉 → pid 文件不删 → 本用例变成随机失败。
    const ready = await waitFor(() => out.includes('启动于'), 20000);
    assert.ok(ready, `服务必须能启动（子进程输出：${out}）`);

    const pidPath = join(dataDir, 'app.pid');
    assert.ok(existsSync(pidPath), `服务启动后必须写 pid 文件（子进程输出：${out}）`);
    const content = readFileSync(pidPath, 'utf8');
    assert.equal(Number(content.trim()), child.pid, 'pid 文件必须写当前进程 pid');

    const state = checkServiceState({ dataDir });
    assert.equal(state.running, true, '服务在跑时必须判为在跑');

    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 20000);
    const gone = await waitFor(() => !existsSync(pidPath), 5000);
    assert.ok(gone, `退出后必须删掉 pid 文件（子进程输出：${out}）`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test('真实生产 schema 的备份能往返：恢复后数据与 schema 版本都不变', async () => {
  const dataDir = tempDir('hks-rs-real-');
  // 用真实的迁移脚本建库（形状 = 真实写入方写出来的库）
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const version = currentVersion(db);
  assert.ok(version > 0, '真实 schema 必须有版本号');
  const created = createUser(db, { name: '备份测试', phone: '13800000001', password: 'pw-for-backup-test' });
  close();

  const backup = await backupDatabase({
    dataDir,
    backupDir: join(dataDir, 'backups'),
    now: new Date('2026-10-20T12:00:00Z'),
  });
  const check = verifyBackupFile(backup.path);
  assert.equal(check.ok, true, check.error ?? '');
  assert.equal(check.schemaVersion, version, '备份必须带出真实 schema 版本（走 migrate.js 的 currentVersion）');

  // 改库 → 再恢复
  const again = openDatabase({ dataDir });
  again.db.exec('DELETE FROM users');
  again.close();

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, result.error ?? '');

  const after = openDatabase({ dataDir });
  const user = after.db.prepare('SELECT name, phone FROM users WHERE id = ?').get(created.id);
  const afterVersion = currentVersion(after.db);
  after.close();
  assert.ok(user, '恢复后真实用户必须还在');
  assert.equal(user.phone, '13800000001');
  assert.equal(afterVersion, version, '恢复后 schema 版本必须不变');

  rmSync(dataDir, { recursive: true, force: true });
});

test('命令行入口可执行：node scripts/restore.js 真的恢复并打出成功信息', async () => {
  const dataDir = tempDir('hks-rs-cli-');
  const backup = await makeBackup(dataDir);

  // ⚠️ 守住 isMain 判定这条边界：判定写错时命令会**静默什么都不干、退出码 0**。
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(here, '..', 'scripts', 'restore.js')],
    { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } },
  );
  assert.equal(res.status, 0, `恢复脚本必须以 0 退出，实际输出：${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /\[restore\] 成功/, `恢复脚本必须打出成功信息，实际：${res.stdout}`);
  assert.ok(
    readdirSync(dataDir).some((f) => f.startsWith('app.db.before-restore-')),
    '命令行恢复也必须留存旧库',
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
import { backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';

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
  // ⚠️ 走 openDatabase 而不是裸 new DatabaseSync：
  //   ① 本 Task 的接口契约写明「Consumes: openDatabase({ dataDir, filename })」；
  //   ② openDatabase 带 busy_timeout=5000 —— 服务运行中备份时对 SQLITE_BUSY 有退避
  //      （WAL 下读者不阻塞写者，但取锁仍可能撞上 SQLITE_BUSY）。
  const { db, close } = openDatabase({ dataDir, filename });
  let pages = 0;
  try {
    // ⚠️ progress 回调的真实签名是**一个对象** { totalPages, remainingPages }
    //   （Node v22 的 node:sqlite 实测），不是 (db, copied)；
    //   而且它只在【多轮迭代】时触发 —— 库小到一次迭代就拷完时根本不触发。
    //   ⇒ 取 totalPages 当页数；一次都没触发时回落到源库 PRAGMA page_count。
    await backup(db, target, {
      rate: 100,
      progress: (info) => { pages = info.totalPages; },
    });
    if (!pages) {
      pages = db.prepare('PRAGMA page_count').get().page_count;
    }
  } finally {
    close();
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

// ⚠️ 符号链接入口：Node 会把主入口 realpath 化，import.meta.url 是**真实路径**，
//    而 process.argv[1] 是**链接路径** → 字符串全等为假 → 脚本静默不执行、退出码 0。
//    与 src/server.js 的同一处判定保持一致（两边都 realpath 再比）。
//    ⚠️ realpathSync 吃的是**路径**，不是 file:// URL —— 必须先 fileURLToPath
//    （实测：直接 realpathSync(import.meta.url) 抛 ENOENT ⇒ isMain 恒假 ⇒
//      命令行跑起来什么都不干、退出码 0）。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
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

- [ ] **Step 5: 追加 `src/db/migrate.js` 的 `currentVersion(db)`（**P0 已建**）**

`platform/src/db/migrate.js` 由 **P0 建立**（迁移执行器：`readMigrationFiles` / `applyMigrations`）。
本阶段**只追加**下面这个导出，**不改** `applyMigrations` 的签名与行为
（`applyMigrations` 内部原本就有一行同样的 SQL，本步让它改调 `currentVersion`，**行为不变**）：

```javascript
// src/db/migrate.js —— 【追加】到 P0 已建的文件里
//
// 读当前已应用的 schema 版本（迁移表里的 MAX(version)）。
// 依据：运维脚本（backup / restore）需要知道「这个备份对应哪个 schema 版本」，
//   但**不能自己写 SQL** —— 全局约束「所有 SQL 收在 src/db/repo/」，
//   而 src/db/migrate.js 是该守卫**唯一豁免的文件**（见 platform/test/sql-boundary.test.js
//   的豁免清单与「迁移执行器确实执行 SQL」那条断言）。
// @returns {number|null} 一次迁移都没应用过时返回 null
export function currentVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row?.v ?? null;
}
```

并把 `applyMigrations` 末尾那一行

```javascript
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return { applied, version: row?.v ?? 0 };
```

改成

```javascript
  return { applied, version: currentVersion(db) ?? 0 };
```

（**语义完全等价**：`currentVersion` 返回 `row?.v ?? null`，外面再 `?? 0`。）

> **【2026-10-21 漂移审计修正 C-5】**
> **原来错在哪**：`scripts/restore.js` 的 `verifyBackupFile()` 原来自己写 SQL 读 schema 版本：
> ```javascript
> schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? null;
> ```
> **为什么错**：P0 终审 I-7 立了全局约束「**所有 SQL 收进 `platform/src/db/repo/`**」，
> 并由 `platform/test/sql-boundary.test.js` 守卫：扫描 `src/` 与 **`scripts/`** 下
> **除 `src/db/repo/` 与 `src/db/migrate.js` 外**的一切 `.js`，
> 只要出现 `db.prepare(`/`db.exec(` 且参数里含 `SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/DROP/ALTER`
> 就判违规。`scripts/` **在扫描范围内**，`scripts/restore.js` **不在豁免名单里**
> → 照本计划实施，P0 自带用例当场变红（审计实跑：
> `not ok 1 - src/ 与 scripts/ 里除仓储层外没有裸 SQL`，
> 报 `scripts/restore.js:55 出现 SQL：SELECT MAX(version) AS v FROM schema_migrations`）。
> 另外从设计上讲：`scripts/` 是**运维脚本**，理应复用 `src/db/migrate.js` 那套读版本逻辑，
> 而不是自己抄一份 SQL —— 抄的那份迟早与执行器那份漂移（执行器改了，脚本没改，
> 就会出现「备份显示 schema 版本 5，实际是 6」这种查不出来的错）。
> **改成什么**：
> ① 在 `platform/src/db/migrate.js`（**P0 已建**，该文件是 SQL 守卫的唯一豁免文件）
> **追加**导出 `currentVersion(db)`；
> ② `applyMigrations` 末尾改调它（**语义等价**，签名与行为不变）；
> ③ `scripts/restore.js` 改为 `import { currentVersion } from '../src/db/migrate.js';`
> 并把那一行改成 `schemaVersion = currentVersion(db);`（**返回值语义一致**：
> 未迁移过时两边都是 `null`）。
> **依据**：基线 `platform/test/sql-boundary.test.js:282-292`（扫描范围含 `scripts/` + 豁免名单）
> + 基线 `platform/src/db/migrate.js`（`applyMigrations` 末尾那行 SQL 的原样）
> + 漂移审计报告 C-5。

- [ ] **Step 6: 创建 `scripts/restore.js`**

```javascript
// scripts/restore.js — 从备份恢复
//
// ⛔ 恢复前必须先停服务：SQLite 拒绝在有其他连接写同一文件时安全替换文件；
//    强行替换会丢数据或损坏库（且服务可能继续往被换掉的旧 inode 写）。
//    本脚本用【pid 文件 + systemd 探测】把这条约束变成机器检查。
// ⚠️ 恢复后必须删掉旧的 -wal / -shm：它们属于旧库，留着会污染新库。
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync, existsSync, renameSync, unlinkSync, readdirSync, mkdirSync, realpathSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPidFile, pidFilePath, isProcessAlive } from '../src/runtime/pidfile.js';
import { currentVersion } from '../src/db/migrate.js';

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
export function checkServiceState({ dataDir = './data', serviceName = 'heikesong' } = {}) {
  const pid = readPidFile(dataDir);
  if (pid && isProcessAlive(pid)) {
    return { running: true, reason: `pid 文件显示进程 ${pid} 仍在运行`, pid };
  }
  if (pid) {
    return { running: false, reason: `pid 文件存在但进程 ${pid} 已退出（可能是异常终止的残留）`, pid, stale: true };
  }
  // ⚠️ pid 文件在，但内容不是合法 pid（写坏了）→ 证明不了服务已停 → 保守判为「还在跑」。
  //    依据：设计文档 §14.2【决策】恢复前必须先停服务 —— 这条是**安全闸**，
  //    拿不到证据时必须拒绝，而不是当成「服务没在跑」。
  //    运维确认服务确实停了，删掉这个 pid 文件即可继续。
  if (existsSync(pidFilePath(dataDir))) {
    return { running: true, reason: 'pid 文件存在但内容无法解析，无法确认服务已停止' };
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

/**
 * 校验备份文件：能不能打开 + 完整性检查。
 *
 * ⚠️ 只读打开一个 WAL 标志的库时，SQLite 会在文件旁建出 `-wal` 与 `-shm`
 *   （sqlite.org/wal.html：只读 WAL 库靠 wal-index 读，索引文件建在库文件旁）。
 *   实测：readOnly 打开备份产物 → 留下 `xxx.db-wal`(0B) 与 `xxx.db-shm`(32KB)，
 *   且关库后**不删**。而保留策略只认 `*.db` → 这些残留永不被清理 → 备份目录无限膨胀。
 *   ⇒ 记下「打开前有没有」，关库后把【本次自己造出来的】删掉；
 *     打开前就存在的 -wal（可能带真实数据）一律保留不动。
 */
export function verifyBackupFile(path) {
  if (!existsSync(path)) return { ok: false, integrity: 'missing', schemaVersion: null, error: `备份文件不存在：${path}` };
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  const walBefore = existsSync(walPath);
  const shmBefore = existsSync(shmPath);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    let schemaVersion = null;
    try {
      schemaVersion = currentVersion(db);
    } catch {
      schemaVersion = null; // 备份里没有迁移表（还没 migrate 过）——不算损坏
    }
    db.close();
    db = null;
    if (integrity !== 'ok') {
      return { ok: false, integrity: String(integrity), schemaVersion, error: `备份完整性检查未通过：${integrity}` };
    }
    return { ok: true, integrity: 'ok', schemaVersion };
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    return { ok: false, integrity: 'unopenable', schemaVersion: null, error: `备份文件无法打开：${err.message}` };
  } finally {
    // 只删「本次打开造出来的」sidecar，绝不碰打开前就存在的 -wal（可能带真实数据）
    if (!walBefore) { try { if (existsSync(walPath)) unlinkSync(walPath); } catch { /* ignore */ } }
    if (!shmBefore) { try { if (existsSync(shmPath)) unlinkSync(shmPath); } catch { /* ignore */ } }
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
  mkdirSync(dataDir, { recursive: true });
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

// ⚠️ 符号链接入口：与 src/server.js 同一处判定（两边都 realpath 再比）——
//    见 src/server.js 的注释：Node 会把主入口 realpath 化，
//    而 process.argv[1] 保留链接路径 → 字符串全等为假 → 脚本静默不执行。
// ⚠️ realpathSync 吃的是**路径**，不是 file:// URL —— 必须先 fileURLToPath
//    （实测：直接 realpathSync(import.meta.url) 抛 ENOENT ⇒ isMain 恒假 ⇒
//      命令行跑起来什么都不干、退出码 0）。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
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

- [ ] **Step 7: 修改 `src/server.js`（写 pid 文件）**

在 `src/server.js` 里加三处（**每处都是 `src/server.js` 里的连续片段**，可逐字 diff）：

`src/server.js` —— ① 顶部 import（与其它 import 放在一起）：

```javascript
import { writePidFile, removePidFile } from './runtime/pidfile.js';
```

`src/server.js` —— ② `isMain` 分支里，`openDatabase` 之后（**写 pid 文件**：让「恢复前先停服务」可被机器检查）：

```javascript
  const { db, close } = openDatabase({ dataDir });
  // ── P6：写 pid 文件 ──────────────────────────────────────────
  // 用途：让「恢复前必须先停服务」这条约束**可被机器检查**（scripts/restore.js 读它）。
  // 依据：设计文档 §14.2【决策】恢复前置约束。
  writePidFile(dataDir);
  // ────────────────────────────────────────────────────────────
  applyMigrations(db, migrationsDir);
```

`src/server.js` —— ③ `SIGINT` / `SIGTERM` 处理里，`close()` 之前（**删 pid 文件**：否则留下陈旧 pid）：

```javascript
      server.close(() => {
        // ── P6：退出前删 pid 文件（否则留下陈旧 pid）─────────────
        removePidFile(dataDir);
        // ────────────────────────────────────────────────────────
        close();
        process.exit(0);
      });
```

> ⚠️ **这三处刻意写成彼此独立、可分离的小改动**：`src/server.js` 在 P4 阶段还有审计路由的改动，
> 两边将来合并时会在同一文件冲突。三处都带 `── P6：… ──` 注释边界，冲突时按边界取即可。

- [ ] **Step 8: 运行测试确认通过**

Run: `cd platform && node --test test/backup.test.js test/restore.test.js`
Expected: PASS（backup **7** 个用例 + restore **11** 个用例 = **18** 个全过）

> 规格自带的 8 个用例**逐字保留**；另追加 10 个判别性用例（理由见文末 Task 1 实施台账 D-05）。

- [ ] **Step 9: 实跑一次备份与恢复**

Run: `cd platform && node scripts/migrate.js && ADMIN_PASSWORD='<你的口令>' node scripts/seed.js && node scripts/backup.js`
Expected: 输出 `[backup] 完成：app-<时间戳>.db（… 字节，… 页）`，且 `data/backups/` 下出现一个 `.db` 文件

> ⚠️ 规格原命令 `node scripts/seed.js` **不带 `ADMIN_PASSWORD` 会 fail-fast 拒绝**
> （`scripts/seed.js` 明写「不提供默认口令」）→ 整条 `&&` 链在此中断，后面的备份根本没跑。
> 实跑证据见文末 Task 1 实施台账 D-06。

Run: `cd platform && node scripts/restore.js && node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('./data/app.db');console.log(db.prepare('SELECT COUNT(*) n FROM users').get().n);db.close();"`
Expected: 输出一个正整数（恢复后库可正常打开读表）

- [ ] **Step 10: 提交**

```bash
cd platform && git add src/runtime/pidfile.js scripts/backup.js scripts/restore.js src/db/migrate.js src/server.js test/backup.test.js test/restore.test.js
git commit -m "feat(P6): 一致性备份与恢复脚本（sqlite.backup() API + 停服务前置检查）" -- src/runtime/pidfile.js scripts/backup.js scripts/restore.js src/db/migrate.js src/server.js test/backup.test.js test/restore.test.js
```

> ⚠️ 规格原命令的 `git commit` **不带 `-- <paths>`** —— 违反「先 `git add <paths>`，
> 再 `git commit -m "…" -- <paths>`」这条纪律（`-m` 必须在 `--` 之前）。已按纪律补上。

---

### Task 2: 部署资产（systemd / nginx / docker-compose / install.sh）

**Files:**
- Create: `platform/deploy/heikesong.service`
- Create: `platform/deploy/nginx.conf`
- Create: `platform/deploy/docker-compose.yml`
- Create: `platform/deploy/install.sh`
- Create: `platform/deploy/nginx-http2-compat.sh`
- Test: `platform/test/deploy-assets.test.js`

**Interfaces:**
- Consumes: 无（纯资产文件）
- Produces:
  - `deploy/heikesong.service` → systemd 单元，占位符 `__APP_DIR__` / `__DATA_DIR__` / `__RUN_USER__`
  - `deploy/nginx.conf` → nginx 站点，占位符 `__SERVER_NAME__` / `__CERT_PATH__` / `__KEY_PATH__` / `__APP_DIR__`
  - `deploy/docker-compose.yml` → 单容器编排（⛔ 无 `--workers` / `cluster`）
  - `deploy/install.sh` → 一键部署（幂等；口令从 `ADMIN_PASSWORD` 环境变量或交互读取，⛔ 不硬编码）
  - `deploy/nginx-http2-compat.sh` → HTTP/2 语法兼容层（按目标机 nginx 版本决定保留 `http2 on;` 还是降级成 `listen ... ssl http2;`）

> **⚠️ 本 Task 的三条硬约束**
> ① **单写者**：⛔ 禁止多 Node worker 进程同时写同一个 SQLite 文件（SQLite 官方：single writer at a time）——这是 `SQLITE_BUSY` 的真正来源。✅ 扩容只能加**读**（静态资源交给 nginx 直出，几百并发静态请求根本不进 Node 进程）。⚠️ WAL 要求所有进程**在同一台主机**；**一旦要多机部署，必须换 Postgres，没有第三条路**。
> ② **不硬编码任何口令/域名/证书路径**：一律占位符 + 注释说明怎么替换。
> ③ **install.sh 幂等**：可重复执行不炸（用户已存在、目录已存在、文件已存在、systemd 已 enable → 都不炸）。

- [ ] **Step 1: 写失败的测试**

`platform/test/deploy-assets.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');
const srcDir = join(here, '..', 'src');

function read(name) {
  return readFileSync(join(deployDir, name), 'utf8');
}

function readSrc(name) {
  return readFileSync(join(srcDir, name), 'utf8');
}

/**
 * 去掉整行注释，只留**真正参与配置语义**的行。
 * systemd 的 '#' 与 YAML 的 '#' 都从行首起，shell 的 '#' 同理。
 * 为什么要这一步：注释里写「默认值 /opt/heikesong/platform」是**文档**，
 * 不是「把部署路径写死在配置里」；两件事必须分开断言，
 * 否则断言会把有用的注释也一起禁掉（→ 假红 / 假绿）。
 */
function effective(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

// ── 真实代码里的口径（部署资产必须与它一致，不能各写各的）────────────────
const serverSrc = readSrc(join('server.js'));
const sessionSrc = readSrc(join('auth', 'session.js'));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

/** 应用真实默认端口：src/server.js 的 `process.env.PORT || <数字>` */
const APP_PORT = (serverSrc.match(/process\.env\.PORT\s*\|\|\s*(\d+)/) || [])[1];
/** 应用真实的数据目录环境变量名 */
const APP_DATA_DIR_VAR = (serverSrc.match(/process\.env\.([A-Z_]*DATA_DIR)/) || [])[1];
/** 应用真实的会话有效期环境变量名 */
const APP_SESSION_TTL_VAR = (sessionSrc.match(/process\.env\.([A-Z_]*SESSION_TTL_DAYS)/) || [])[1];
/** 应用真实的健康检查路径 */
const APP_HEALTH_PATH = (serverSrc.match(/router\.add\('GET',\s*'([^']+)'/) || [])[1];
/** package.json engines.node 的主版本与次版本（部署脚本的下限必须与它一致） */
const ENGINE = (pkg.engines.node || '').match(/(\d+)\.(\d+)/) || [];
const APP_ENGINE_MAJOR = Number(ENGINE[1]);
const APP_ENGINE_MINOR = Number(ENGINE[2]);

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

// ── 以下为预审追加：把「字面扫一遍」升级成「对配置本身断言」──────────────

test('systemd 单元：只起【一个】Node 进程 + 入口是真实入口 + ⛔ 不得设 DEMO_MODE=1', () => {
  const unit = read('heikesong.service');
  const eff = effective(unit);
  const execStarts = eff.match(/^ExecStart=.*$/gm) || [];
  assert.equal(execStarts.length, 1, '⛔ 只能有一条 ExecStart（多进程 = 多写者 = SQLITE_BUSY）');
  assert.match(execStarts[0], /src\/server\.js$/, '入口必须是应用真实入口 src/server.js');
  assert.doesNotMatch(execStarts[0], /--worker|--cluster|-c\s*\d/i, '⛔ ExecStart 不得带多进程参数');
  assert.doesNotMatch(eff, /DEMO_MODE\s*=\s*1/, '⛔ 生产部署绝对不得设 DEMO_MODE=1（会挂出 /src/domain/* 与 /rules/*）');
  assert.doesNotMatch(eff, /\/opt\/heikesong\/platform/, '⛔ 部署路径必须走占位符，不得硬编码');
  assert.match(eff, /^Documentation=file:__APP_DIR__\/README\.md$/m, '文档路径也要走占位符');
});

test('nginx：正式形态（域名 + TLS）+ 上游只绑回环 + 端口与真实默认一致', () => {
  const conf = read('nginx.conf');
  assert.ok(APP_PORT, '读不到 src/server.js 的默认端口，测试本身失效');
  assert.match(conf, /listen 443 ssl;/, '正式形态必须是 443 + TLS（备案域名的硬要求）');
  assert.match(conf, /ssl_certificate\s+__CERT_PATH__;/, '必须挂证书');
  assert.match(conf, /ssl_certificate_key\s+__KEY_PATH__;/, '必须挂私钥');
  const upstream = (conf.match(/server\s+([\d.]+):(\d+);/) || []);
  assert.equal(upstream[1], '127.0.0.1', '⛔ 上游必须只绑回环（Node 不直接暴露到公网）');
  assert.equal(upstream[2], APP_PORT, '上游端口必须与应用真实默认端口一致');
  assert.doesNotMatch(conf, /server\s+0\.0\.0\.0/, '⛔ 上游不得绑 0.0.0.0');
});

test('docker-compose：⛔ 不扩副本 + 只绑回环 + ⛔ 不得设 DEMO_MODE=1 + 容器网络可达', () => {
  const yml = read('docker-compose.yml');
  const eff = effective(yml);
  assert.doesNotMatch(eff, /^\s*replicas\s*:/m, '⛔ 禁止 compose 扩副本（多写者）');
  assert.doesNotMatch(eff, /^\s*scale\b/m, '⛔ 禁止 compose scale');
  assert.doesNotMatch(eff, /^\s*deploy\s*:/m, '⛔ 禁止用 deploy.replicas 扩副本');
  assert.doesNotMatch(eff, /DEMO_MODE\s*:\s*"?1"?/, '⛔ 生产部署绝对不得设 DEMO_MODE=1');
  assert.doesNotMatch(eff, /"0\.0\.0\.0:/, '⛔ 端口发布不得绑 0.0.0.0');
  // src/server.js 只绑 127.0.0.1 ⇒ 容器必须与宿主机共享网络栈，
  // 否则宿主机侧 127.0.0.1:8080 连不上（容器 healthy 但宿主 curl 不通）。
  assert.match(eff, /network_mode:\s*host/, 'Node 只绑回环 ⇒ 容器网络必须用 host，否则宿主机反代连不上');
  const health = (eff.match(/http:\/\/127\.0\.0\.1:\d+(\/[^\s'"]*)/) || [])[1];
  assert.equal(health, APP_HEALTH_PATH, '健康检查路径必须是应用真实健康检查路径');
  // 容器里的 Node 必须满足 package.json 的 engines（node:sqlite.backup() 要 22.16.0）
  const imageMajor = Number((eff.match(/image:\s*node:(\d+)/) || [])[1]);
  assert.ok(imageMajor >= APP_ENGINE_MAJOR, `⛔ 容器镜像的 Node 主版本 ${imageMajor} 低于 engines 要求的 ${APP_ENGINE_MAJOR}`);
  // 代码挂载必须只读（代码不进容器，升级靠替换宿主机目录）
  const codeMounts = eff.match(/-\s*\.\.:\/app:\w+/g) || [];
  assert.equal(codeMounts.length, 1, '⛔ 代码只能挂一次（多挂一份 = 多一份可写副本）');
  assert.ok(codeMounts[0].endsWith(':ro'), '⛔ 代码挂载必须只读（:ro）');
  // 容器加固：根文件系统只读 + 丢掉全部 capability
  assert.match(eff, /read_only:\s*true/, '⛔ 容器根文件系统必须只读');
  assert.match(eff, /cap_drop:\s*\n\s*-\s*ALL/, '⛔ 容器必须丢掉全部 capability');
});

test('install.sh：环境文件不落口令 + 幂等守卫齐备 + 口令只能来自环境变量或交互', () => {
  const sh = read('install.sh');
  const envBlock = effective(sh.slice(sh.indexOf('write_env_file()'), sh.indexOf('as_service_user()')));
  assert.ok(envBlock.length > 0, '找不到 write_env_file 函数');
  assert.doesNotMatch(envBlock, /PASSWORD/i, '⛔ 环境文件里绝不能出现口令（口令只用一次、不落盘）');
  assert.doesNotMatch(envBlock, /ADMIN_PHONE/, '环境文件里不写管理员手机号');
  // 幂等守卫：每一条都对应「重复执行不炸」的一种具体机制
  assert.match(sh, /id -u "\$RUN_USER"/, '用户已存在 ⇒ 跳过（不能重复创建）');
  assert.match(sh, /install -d/, '目录已存在 ⇒ install -d 不报错');
  assert.match(sh, /ln -sfn/, '软链已存在 ⇒ ln -sfn 不报错');
  assert.match(sh, /systemctl enable/, 'systemd enable 可重复执行');
  assert.match(sh, /read -rs/, '没有 ADMIN_PASSWORD 时必须交互读取（不回显）');
  assert.match(sh, /\[ -n "\$password" \] \|\| die/, '⛔ 口令读不到时必须明确报错退出（不能带空口令继续）');
});

test('nginx / install.sh：注释不能掩盖配置错误（必须对**有效配置**断言）', () => {
  const conf = effective(read('nginx.conf'));
  const sh = effective(read('install.sh'));
  // 规格的用例 3/6 是「全文扫一遍」：把真指令注释掉，注释里那份文字仍会被扫到 ⇒ 假绿。
  // 这里对**去掉整行注释后**的配置再断言一遍，堵住这个洞。
  assert.match(conf, /proxy_buffering off;/, '⛔ SSE 必须关缓冲（有效配置里不能被注释掉）');
  assert.match(conf, /add_header X-Accel-Buffering no;/, '⛔ SSE 必须关掉 nginx 缓冲（有效配置里不能被注释掉）');
  assert.match(conf, /proxy_read_timeout 360s;/, '⛔ SSE 长连接超时（有效配置里不能被注释掉）');
  assert.match(conf, /proxy_set_header Connection '';/, '⛔ Connection 头必须清空（有效配置里不能被注释掉）');
  assert.match(conf, /proxy_http_version 1\.1;/, '⛔ 必须 HTTP/1.1（有效配置里不能被注释掉）');
  assert.match(sh, /systemctl daemon-reload/, '⛔ 必须 reload systemd（有效配置里不能被注释掉）');
  assert.match(sh, /nginx -t/, '⛔ 必须先 nginx -t 再 reload（有效配置里不能被注释掉）');
  // 静态资源的两个缓存头必须一致：expires N 天 ≡ max-age N*86400 秒
  const expDays = (conf.match(/expires (\d+)d;/) || [])[1];
  const maxAge = (conf.match(/max-age=(\d+)/) || [])[1];
  assert.ok(expDays && maxAge, '读不到 expires / max-age，测试本身失效');
  assert.equal(Number(maxAge), Number(expDays) * 86400, '⛔ expires 与 Cache-Control max-age 必须一致');
  // 每一处 X-Real-IP 都必须透传 $remote_addr（有一处被置空，审计里就是空 IP）
  const realIpTotal = (conf.match(/proxy_set_header X-Real-IP/g) || []).length;
  const realIpOk = (conf.match(/proxy_set_header X-Real-IP \$remote_addr;/g) || []).length;
  assert.equal(realIpOk, realIpTotal, '⛔ 每一处 X-Real-IP 都必须是 $remote_addr（审计要真实客户端 IP）');
});

test('install.sh：Node 下限 / 环境文件权限 / umask / 占位符映射 / locale 安全展开', () => {
  const sh = read('install.sh');
  // ① Node 版本下限必须与 package.json engines 一致（22.16.0 = sqlite.backup() 引入版本）
  assert.ok(APP_ENGINE_MAJOR, '读不到 package.json engines，测试本身失效');
  assert.match(sh, new RegExp(`MIN_NODE_MAJOR=${APP_ENGINE_MAJOR}\\b`), '⛔ Node 主版本下限必须与 engines 一致');
  assert.match(sh, new RegExp(`MIN_NODE_MINOR=${APP_ENGINE_MINOR}\\b`), '⛔ Node 次版本下限必须与 engines 一致');
  // ② 环境文件必须组可读（systemd 以 root 读，但服务组要能读到；0600 会让环境变量全丢）
  assert.match(sh, /chmod 0640 "\$ENV_FILE"/, '⛔ 环境文件权限必须是 0640（组可读）');
  // ③ umask 必须存取成对（不恢复的话，后面的 nginx 站点文件会被建成 600）
  assert.match(sh, /old_umask="\$\(umask\)"/, '⛔ 写环境文件前必须先存 umask');
  assert.match(effective(sh), /umask "\$old_umask"/, '⛔ 写完必须恢复 umask（否则后面的站点文件权限被带偏）');
  // ④ 占位符 → 变量必须一一对应（不能把 __DATA_DIR__ 替换成程序目录），且**每一处**替换值都必须转义
  const appSites = (sh.match(/s\|__APP_DIR__\|/g) || []).length;
  const appEscaped = (sh.match(/s\|__APP_DIR__\|.*sed_escape "\$APP_DIR"/g) || []).length;
  assert.ok(appSites > 0, '读不到 __APP_DIR__ 的替换点，测试本身失效');
  assert.equal(appEscaped, appSites, '⛔ 每一处 __APP_DIR__ 替换都必须走 sed_escape（路径含 & 或 | 时 sed 会写坏）');
  const dataSites = (sh.match(/s\|__DATA_DIR__\|/g) || []).length;
  const dataEscaped = (sh.match(/s\|__DATA_DIR__\|.*sed_escape "\$DATA_DIR"/g) || []).length;
  assert.ok(dataSites > 0, '读不到 __DATA_DIR__ 的替换点，测试本身失效');
  assert.equal(dataEscaped, dataSites, '⛔ 每一处 __DATA_DIR__ 替换都必须走 sed_escape（且必须是数据目录，不是程序目录）');
  // ⑤ locale 安全：$变量 紧跟非 ASCII 字符时，bash 在 C/C.UTF-8 locale 下会把高位字节
  //    并进变量名 → set -u 下直接 unbound variable 崩掉（必须写成 ${变量}）
  const unsafe = [...sh.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*([^\x00-\x7F])/g)].map((m) => m[0]);
  assert.deepEqual(unsafe, [], `⛔ $变量 紧跟非 ASCII 字符会炸（bash 会把高位字节并进变量名）：${unsafe.join(' ')}`);
  // ⑥ 交互读口令必须被保护（read 失败时不能被 set -e 静默打断）
  assert.match(sh, /read -rs password \|\| true/, '⛔ 交互读口令失败必须被显式处理');
});

test('跨资产口径一致：端口 / 数据目录变量 / 会话变量 / 入口 / 健康检查必须与应用真实代码一致', () => {
  const unit = read('heikesong.service');
  const conf = read('nginx.conf');
  const yml = read('docker-compose.yml');
  const sh = read('install.sh');
  assert.ok(APP_PORT, '读不到 src/server.js 的默认端口，测试本身失效');
  assert.ok(APP_DATA_DIR_VAR, '读不到 src/server.js 的数据目录变量，测试本身失效');
  assert.ok(APP_SESSION_TTL_VAR, '读不到 src/auth/session.js 的会话变量，测试本身失效');
  assert.ok(APP_HEALTH_PATH, '读不到 src/server.js 的健康检查路径，测试本身失效');

  // 端口四处同口径
  assert.match(unit, new RegExp(`^Environment=PORT=${APP_PORT}$`, 'm'), 'systemd 端口必须与真实默认一致');
  assert.match(conf, new RegExp(`server 127\\.0\\.0\\.1:${APP_PORT};`), 'nginx 上游端口必须与真实默认一致');
  assert.match(yml, new RegExp(`PORT:\\s*"${APP_PORT}"`), 'compose 端口必须与真实默认一致');
  assert.match(sh, new RegExp(`printf 'PORT=${APP_PORT}`), 'install.sh 写的环境文件端口必须与真实默认一致');

  // 数据目录变量名四处同口径
  assert.match(unit, new RegExp(`^Environment=${APP_DATA_DIR_VAR}=__DATA_DIR__$`, 'm'), 'systemd 数据目录变量名必须与真实代码一致');
  assert.match(yml, new RegExp(`${APP_DATA_DIR_VAR}:\\s*"/data"`), 'compose 数据目录变量名必须与真实代码一致');
  assert.match(sh, new RegExp(`printf '${APP_DATA_DIR_VAR}=%s`), 'install.sh 写的环境文件数据目录变量名必须与真实代码一致');

  // 会话有效期变量名
  assert.match(sh, new RegExp(`${APP_SESSION_TTL_VAR}=`), '环境文件必须写会话有效期变量');

  // 入口与健康检查路径
  assert.match(unit, /src\/server\.js/, 'systemd 入口必须与应用真实入口一致');
  assert.match(yml, new RegExp(APP_HEALTH_PATH.replace(/\//g, '\\/')), 'compose 健康检查路径必须与应用真实健康检查路径一致');
});

// ── P6 部署资产修复轮（父代理）：F-1~F-4 的回归用例 ──────────────────────
// 这四条缺口都不是「样式问题」，每一条都能让一次真实的云主机部署**装到一半**：
//   F-1 前端产物目录三处口径不一致（计划 web/dist/ vs nginx web/assets/ vs install.sh 排除项）
//   F-2 nginx 是最后一步且不检查装没装 ⇒ 前面全都装完了才炸，还留一份坏配置在 sites-enabled
//   F-3 systemd/环境文件漏 SESSION_ABSOLUTE_TTL_DAYS ⇒ 实际生效值与配置对不上
//   F-4 nginx ≥ 1.25.1 才有 `http2 on;`，而 Ubuntu 22.04=1.18 / 24.04=1.24 都没有
//
// ⚠️ 本组用例的断言必须**判别**：把修复改回去（挪顺序 / 删回滚 / 改回降级）必须变红。

test('install.sh：⛔ nginx 必须【在动任何东西之前】检查（否则装到一半才炸）', () => {
  const sh = read('install.sh');
  assert.match(sh, /command -v nginx/, '必须探测 nginx 是否安装');
  assert.match(sh, /require_nginx\(\)\s*\{/, '必须有独立的 nginx 前置检查函数');
  // 顺序断言：main() 里 require_nginx 必须排在所有「会改变机器状态」的调用之前。
  // ⚠️ 这条是判别性的：把 require_nginx 挪到 copy_app 之后 → 立刻变红。
  const mainIdx = sh.indexOf('\nmain() {');
  assert.ok(mainIdx > 0, '找不到 main()，测试本身失效');
  const mainBody = sh.slice(mainIdx);
  const requireIdx = mainBody.indexOf('require_nginx');
  assert.ok(requireIdx > 0, 'main() 里必须调用 require_nginx');
  for (const mutating of [
    'create_service_user', 'prepare_dirs', 'copy_app', 'write_env_file',
    'init_database', 'write_systemd_unit', 'start_service', 'write_nginx_site',
  ]) {
    const idx = mainBody.indexOf(mutating);
    assert.ok(idx > 0, `找不到 ${mutating} 调用，测试本身失效`);
    assert.ok(requireIdx < idx, `⛔ require_nginx 必须排在 ${mutating} 之前（先查前置条件，再动手）`);
  }
});

test('install.sh：nginx -t 失败必须回滚（坏配置绝不能留在 sites-enabled）', () => {
  const sh = read('install.sh');
  // 裸 `nginx -t` + set -e ⇒ 失败即退出，**来不及回滚** ⇒ 必须放在 if 保护下
  assert.match(sh, /if ! nginx -t; then/, 'nginx -t 必须在 if 保护下，失败分支才能做回滚');
  assert.match(sh, /cp -p "\$NGINX_SITE" "\$backup"/, '写新配置前必须先备份旧配置（否则回滚无源可回）');
  const guardIdx = sh.indexOf('if ! nginx -t; then');
  assert.ok(guardIdx > 0, '找不到 nginx -t 保护块，测试本身失效');
  const guardEnd = sh.indexOf('\n  fi', guardIdx);
  assert.ok(guardEnd > guardIdx, '找不到 nginx -t 保护块的结尾，测试本身失效');
  const block = sh.slice(guardIdx, guardEnd);
  assert.match(block, /mv -f "\$backup" "\$NGINX_SITE"/, '失败时必须还原上一版站点配置');
  assert.match(block, /rm -f "\$NGINX_SITE" "\$NGINX_LINK"/, '没有旧配置时必须撤销站点文件与软链');
});

test('会话有效期：环境文件必须写绝对过期变量，且默认值与真实代码一致', () => {
  const sh = read('install.sh');
  const unit = read('heikesong.service');
  // 变量名从真实代码里取，不写死（代码改名时这条测试必须跟着变）
  const absVar = (sessionSrc.match(/process\.env\.([A-Z_]*ABSOLUTE_TTL_DAYS)/) || [])[1];
  assert.ok(absVar, '读不到 src/auth/session.js 的绝对过期变量名，测试本身失效');
  assert.match(sh, new RegExp(`printf '${absVar}=%s`), `环境文件必须写 ${absVar}（不写就静默用代码默认值）`);
  assert.match(unit, new RegExp(absVar), `systemd 单元的环境文件注释必须列出 ${absVar}`);
  // 默认值必须与代码里的默认值一致
  const codeDefault = (sessionSrc.match(/DEFAULT_ABSOLUTE_TTL_DAYS\s*=\s*(\d+)/) || [])[1];
  assert.ok(codeDefault, '读不到代码里的默认绝对过期天数，测试本身失效');
  assert.match(
    sh,
    new RegExp(`${absVar}="\\$\\{${absVar}:-${codeDefault}\\}"`),
    `默认值必须与代码一致（${codeDefault} 天），否则「文件里写的」≠「生效的」`,
  );
  // 非法值必须 fail-fast（代码对非法值是**静默**回退到默认值 ⇒ 环境文件写错没人会发现）
  assert.match(sh, /validate_session_ttls/, '必须有会话天数的合法性校验');
  assert.match(sh, /validate_session_ttls\n/, 'main() 必须真的调用它');
});

test('nginx HTTP/2 兼容：旧版本自动降级、新版本保留（真跑脚本，不看注释）', () => {
  const compatPath = join(deployDir, 'nginx-http2-compat.sh');
  assert.ok(existsSync(compatPath), '必须存在 deploy/nginx-http2-compat.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-nginx-'));
  try {
    const run = (version) => {
      const out = join(tmp, `conf-${version}`);
      execFileSync('bash', [compatPath, join(deployDir, 'nginx.conf'), out], {
        env: { ...process.env, NGINX_VERSION: version },
        encoding: 'utf8',
      });
      return readFileSync(out, 'utf8');
    };
    // 旧版（Ubuntu 24.04 = nginx 1.24.0）：必须降级
    const old = run('1.24.0');
    assert.match(old, /^\s*listen 443 ssl http2;$/m, '旧版 nginx 必须降级成 listen ... ssl http2;');
    assert.match(old, /^\s*listen \[::\]:443 ssl http2;$/m, 'IPv6 那一支也必须降级');
    assert.doesNotMatch(old, /^\s*http2 on;$/m, '⛔ 旧版 nginx 不认 `http2 on;`，残留就是必然 nginx -t 失败');
    // 临界前一版：1.25.1 才引入该指令，1.25.0 一样不认
    const justUnder = run('1.25.0');
    assert.doesNotMatch(justUnder, /^\s*http2 on;$/m, '1.25.0 仍不认 `http2 on;`（该指令 1.25.1 引入）');
    assert.match(justUnder, /^\s*listen 443 ssl http2;$/m, '1.25.0 必须降级');
    // 新版：保留原写法
    const neu = run('1.25.1');
    assert.match(neu, /^\s*http2 on;$/m, '≥ 1.25.1 必须保留 `http2 on;`');
    assert.match(neu, /^\s*listen 443 ssl;$/m, '≥ 1.25.1 不应改动 listen 行');
    // 端口 80 的 listen 不能被误改（降级只针对 443）
    const old80 = run('1.24.0');
    assert.match(old80, /^\s*listen 80;$/m, '80 端口的 listen 不能被降级脚本改掉');
    assert.match(old80, /^\s*listen \[::\]:80;$/m, '80 端口的 IPv6 listen 不能被降级脚本改掉');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // install.sh 必须真的调用它（否则兼容脚本只是一份没人用的文档）
  assert.match(read('install.sh'), /nginx-http2-compat\.sh/, 'install.sh 必须调用兼容脚本');
});

test('前端产物目录口径：唯一构建产物目录是 web/dist/，nginx 的 web/assets/ 是预留位', () => {
  const conf = read('nginx.conf');
  const sh = read('install.sh');
  // ⛔ nginx 不得再声称 web/assets/ 是「前端构建产物目录」—— 那个目录是 web/dist/
  assert.doesNotMatch(
    conf,
    /web\/assets\/[^\n]*是【前端构建产物目录】/,
    '⛔ web/assets/ 不是构建产物目录（构建产物在 web/dist/）',
  );
  assert.match(conf, /web\/dist/, 'nginx.conf 必须写明真正的构建产物目录是 web/dist/');
  assert.match(sh, /--exclude 'web\/dist\/'/, 'install.sh 必须排除构建产物目录（它是发布物，不随程序同步）');
  assert.match(sh, /--exclude 'web\/assets\/'/, 'install.sh 必须排除预留的静态资源目录');
});

test('nginx HTTP/2 兼容：自动探测必须认得 nginx 真实输出格式（回归 D7-4）', () => {
  const compatPath = join(deployDir, 'nginx-http2-compat.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-nginxver-'));
  try {
    // 造一个假 nginx：`-v` 把版本号打在 **stderr**，格式与官方构建一致
    // （`nginx version: nginx/1.24.0 (Ubuntu)` —— 版本号前有 `nginx/` 前缀）。
    const fakeBin = join(tmp, 'bin');
    mkdirSync(fakeBin, { recursive: true });

    // ⚠️ 版本号要**烤进**假脚本里：真 nginx 是 `nginx -v` 被调用（**无参数**），
    //    假脚本若写 `nginx/$1` 会输出成 `nginx version: nginx/ (Ubuntu)` —— 那是假失败。
    const run = (version) => {
      const fakeNginx = join(fakeBin, 'nginx');
      writeFileSync(fakeNginx, `#!/bin/sh\necho "nginx version: nginx/${version} (Ubuntu)" >&2\nexit 0\n`);
      chmodSync(fakeNginx, 0o755);
      const out = join(tmp, `auto-${version}`);
      const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
      delete env.NGINX_VERSION;            // ⛔ 不给覆盖 ⇒ 走**自动探测**这条真实路径
      execFileSync('bash', [compatPath, join(deployDir, 'nginx.conf'), out], { env, encoding: 'utf8' });
      return readFileSync(out, 'utf8');
    };

    // 旧版：必须被**探测到**并降级（不是靠「探测不到 ⇒ 保守降级」蒙对）
    const old = run('1.24.0');
    assert.match(old, /^\s*listen 443 ssl http2;$/m, '探测到 1.24.0 必须降级');
    assert.doesNotMatch(old, /^\s*http2 on;$/m, '1.24.0 不认 `http2 on;`');
    // 新版：必须被**探测到**并保留（这条最关键 —— 探测失败会误降级）
    const neu = run('1.25.1');
    assert.match(neu, /^\s*http2 on;$/m, '探测到 1.25.1 必须保留 `http2 on;`（探测失败会误降级）');
    assert.match(neu, /^\s*listen 443 ssl;$/m, '探测到 1.25.1 不应改动 listen 行');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/deploy-assets.test.js`
Expected: FAIL —— `ENOENT: no such file or directory, open 'platform/deploy/heikesong.service'`

> ⚠️ **2026-10-21 预审补记（Task 2）**：本步只证明了「文件不存在」。预审把**规格自己的**
> 四个资产文件原样抽到 `/tmp` 再跑同一条命令，**7 个用例里 3 个仍然红** ——
> 规格的资产文件与规格的验收用例**互相矛盾**（注释里写了被禁词、`$0` 定位写法对不上、
> 口令示例被自己的正则判成硬编码口令）。
> 逐条缺陷与证据见本文件末尾「Task 2 父代理预审修正台账（2026-10-21）」。

- [ ] **Step 3: 创建 `deploy/heikesong.service`**

```systemd
# deploy/heikesong.service — systemd 守护单元
#
# 依据：设计文档 §14.2「deploy/heikesong.service（systemd 守护）」
#
# ⚠️ 占位符说明（由 deploy/install.sh 自动替换，也可手工替换后 cp 到 /etc/systemd/system/）：
#   __APP_DIR__   程序目录（默认 /opt/heikesong/platform）
#   __DATA_DIR__  数据目录（默认 /var/lib/heikesong/data）
#   __RUN_USER__  运行用户（默认 heikesong）
#
# ⛔ 单写者约束：这里【绝不】加「多 worker 进程」或「多进程集群」启动参数。
#    SQLite 官方：There can only be a single writer at a time。
#    多个 Node worker 进程同时写同一个 .db 文件是 SQLITE_BUSY 的真正来源。
#    R-OPS-03（可扩容）：**扩容只能加「读」** —— 静态资源交给 nginx 直出，几百并发静态请求
#    根本不进 Node 进程；本单元**永远只起一个** Node 进程（见下方 ExecStart 与下面的断言）。
#    ⚠️ 本文件【不】写出多进程参数的具体名字：规格 test/deploy-assets.test.js
#       按字面扫全文（注释里出现同样判违规），参数名见 P6 计划 Task 2 章节。
# ✅ 扩容只能加「读」：静态资源交给 nginx 直出，几百并发静态请求根本不进 Node 进程。
# ⚠️ WAL 要求所有进程在同一台主机；要多机部署必须换 Postgres，没有第三条路。

[Unit]
Description=Heikesong Platform (单进程 Node · 单写者 SQLite)
Documentation=file:__APP_DIR__/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__APP_DIR__

# 环境文件：PORT / DATA_DIR / SESSION_TTL_DAYS / SESSION_ABSOLUTE_TTL_DAYS / NODE_ENV
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
# ⛔⛔ **绝对不要打开 DEMO_MODE**（2026-10-21 漂移审计修正 I-5）：
#    DEMO_MODE 一旦打开，会把 /src/domain/* 与 /rules/* 挂到 HTTP 上 ——
#    那是**领域层算法源码**（打分 / 破同分 / 防作弊判定）与**全部规则配置**
#    （权重表、破同分链、行为分、段位表）。生产部署下必须一律 404。
#    这道门只给本地预览（scripts/serve-demo.js）与开发服务器用。

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
#    ✅ 不用手工改：deploy/install.sh 会先跑 deploy/nginx-http2-compat.sh，
#    它按**目标机**的 nginx 版本自动决定：≥ 1.25.1 保留本写法，
#    < 1.25.1（Ubuntu 22.04=1.18 / 24.04=1.24 都是）自动降级成
#    `listen 443 ssl http2;`（这个写法在**所有** nginx 版本上都合法）。
#
# ⚠️ 端口口径：上游固定 127.0.0.1:8080，与 systemd 单元 / 环境文件 / compose
#    的 PORT=8080 是同一口径。改端口要三处一起改，否则反代连不上。

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
    # ⚠️ web/assets/ 是【预留】的静态资源目录（带内容哈希、可长期缓存的版本位）：
    #    **本仓库当前没有任何构建步骤产出它**（演示版静态站的产物在
    #    platform/web/dist/，走**独立发布通道**，不经本 nginx）。
    #    目录不存在时本段对 /assets/ 请求返 404，不影响其它路径。
    #    ⚠️ 别把它和「前端构建产物目录」混为一谈 —— 那个目录是 platform/web/dist/。
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

同时创建 `deploy/nginx-http2-compat.sh`（HTTP/2 版本兼容脚本）——
`http2 on;` 这个指令要 nginx **≥ 1.25.1** 才认识，而 Ubuntu 22.04(1.18) /
24.04(1.24) 都没有 ⇒ 旧版本自动降级成 `listen ... ssl http2;`（所有版本都合法）：

```bash
#!/usr/bin/env bash
# deploy/nginx-http2-compat.sh — HTTP/2 指令的 nginx 版本兼容层
#
# 背景：deploy/nginx.conf 用的是 `http2 on;`，**nginx ≥ 1.25.1** 才认识这个指令；
#   1.25.1 之前只认 `listen 443 ssl http2;` 这一种写法。
#   发行版现状：Ubuntu 22.04 = nginx 1.18.x、Ubuntu 24.04 = nginx 1.24.0
#   —— 都 < 1.25.1。直接用本仓库的 nginx.conf，`nginx -t` 会报
#   "unknown directive \"http2\""，而这一步在 install.sh 的**最后**，
#   于是部署变成「装完了才炸」，还把一份坏配置留在 sites-enabled 里
#   （那会毒化这台机器上**下一次**任何 nginx reload）。
#   本脚本按**目标机**的 nginx 版本把配置改写成该版本认识的语法。
#
# 用法：
#   nginx-http2-compat.sh <输入 conf> <输出 conf>
#   两种走法：
#     · 版本够新（≥ 1.25.1）⇒ 原样拷贝（保留 `http2 on;`）
#     · 版本偏旧         ⇒ 降级：删掉独立的 `http2 on;` 行，
#                          并把 `listen ... 443 ssl;` 改成 `listen ... 443 ssl http2;`
#                          （旧语法在**所有** nginx 版本上都合法 ⇒ 降级永远安全）
#
# 环境变量：
#   NGINX_VERSION  覆盖探测到的版本（形如 1.24.0）。默认用 `nginx -v` 探测；
#                  探测不到时按「需要降级」处理（保守：降级后的语法处处合法）。
#                  显式给出这个变量的另一个用途是「在没装 nginx 的机器上预演渲染结果」。
#
# 退出码：0 成功；2 用法错 / 输入文件不存在 / 降级后仍残留 `http2 on;`。
set -euo pipefail

# `http2 on;` 的引入版本：nginx 1.25.1
MIN_NGINX_MAJOR=1
MIN_NGINX_MINOR=25
MIN_NGINX_PATCH=1

usage() {
  printf '用法：nginx-http2-compat.sh <输入 conf> <输出 conf>\n' >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

IN_CONF="$1"
OUT_CONF="$2"

if [ ! -f "$IN_CONF" ]; then
  printf '[nginx-compat] 错误：输入文件不存在：%s\n' "$IN_CONF" >&2
  exit 2
fi

# ── 探测版本 ────────────────────────────────────────────────────────────
detect_version() {
  if [ -n "${NGINX_VERSION:-}" ]; then
    printf '%s' "$NGINX_VERSION"
    return 0
  fi
  if command -v nginx >/dev/null 2>&1; then
    # nginx -v 把版本号打在 **stderr**。
    # ⚠️ 真实输出是 `nginx version: nginx/1.24.0 (Ubuntu)` —— 版本号前有 `nginx/` 前缀
    #    （官方构建的 VERSION 串就是 "nginx/" + 版本号）。只写 `nginx version: 1.24.0`
    #    的正则**匹配不到** ⇒ 真机上永远探测失败、永远走保守降级。
    #    ⇒ 这里两种形态都要吃下（用 POSIX BRE 的 \{0,1\}，BSD sed（macOS）也认）。
    nginx -v 2>&1 | sed -n 's|^nginx version: *\(nginx/\)\{0,1\}\([0-9][0-9.]*\).*|\2|p' | head -n 1
    return 0
  fi
  printf ''
}

VERSION="$(detect_version)"

version_supports_http2_on() {
  # $1 = 版本号（形如 1.24.0 / 1.25.1）；空 = 探测不到 ⇒ 判「不支持」⇒ 降级
  local v="$1" major minor patch
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  local rest="${v#*.}"
  minor="${rest%%.*}"
  local rest2="${rest#*.}"
  case "$rest2" in
    ''|*[!0-9]*) patch=0 ;;
    *) patch="${rest2%%.*}" ;;
  esac
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$major" -ne "$MIN_NGINX_MAJOR" ]; then
    [ "$major" -gt "$MIN_NGINX_MAJOR" ]
    return
  fi
  if [ "$minor" -ne "$MIN_NGINX_MINOR" ]; then
    [ "$minor" -gt "$MIN_NGINX_MINOR" ]
    return
  fi
  [ "$patch" -ge "$MIN_NGINX_PATCH" ]
}

# ── 渲染 ────────────────────────────────────────────────────────────────
# 先记住输入里**独立成行**的 `http2 on;` 有没有（注释里提到的不算）
had_http2_on=0
if grep -qE '^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$' "$IN_CONF"; then
  had_http2_on=1
fi

if version_supports_http2_on "$VERSION"; then
  cp "$IN_CONF" "$OUT_CONF"
  printf '[nginx-compat] nginx %s ≥ %s.%s.%s：保留 `http2 on;` 写法\n' \
    "$VERSION" "$MIN_NGINX_MAJOR" "$MIN_NGINX_MINOR" "$MIN_NGINX_PATCH"
  # 保持路径的自检：输入有 `http2 on;` ⇒ 输出必须也有（不能被悄悄改掉）
  out_http2_on=0
  if grep -qE '^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$' "$OUT_CONF"; then
    out_http2_on=1
  fi
  if [ "$had_http2_on" -ne "$out_http2_on" ]; then
    printf '[nginx-compat] 错误：保持路径下 `http2 on;` 指令丢失（输入有=%s，输出有=%s）\n' \
      "$had_http2_on" "$out_http2_on" >&2
    exit 2
  fi
else
  # 用 awk 而不是 sed：sed 的 BRE 扩展（\+ / \d）在 BSD sed（macOS）上不通用，
  # 而本脚本要在 macOS 上被测试实跑，必须可移植。
  awk '
    # 删掉独立的 `http2 on;` 行（前后允许空白）
    /^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$/ { next }
    {
      line = $0
      # 把 `listen [::]:443 ssl;` / `listen 443 ssl;` 改成 `... ssl http2;`
      # ⚠️ IPv6 那一支是 `[::]:443` —— `]` 后面还有一个 `:`，正则必须带上它
      if (line ~ /^[[:space:]]*listen[[:space:]]+(\[[^]]*\]:[[:space:]]*)?443[[:space:]]+ssl;[[:space:]]*$/) {
        sub(/;[[:space:]]*$/, " http2;", line)
        changed = 1
      }
      print line
    }
  ' "$IN_CONF" > "$OUT_CONF"
  printf '[nginx-compat] nginx %s < %s.%s.%s：已降级为 `listen ... ssl http2;`（旧语法在所有版本都合法）\n' \
    "${VERSION:-未探测到（按需降级处理）}" "$MIN_NGINX_MAJOR" "$MIN_NGINX_MINOR" "$MIN_NGINX_PATCH"
  # 降级路径的自检：**绝不能**还残留独立的 `http2 on;`（否则 nginx -t 必然失败）
  if grep -qE '^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$' "$OUT_CONF"; then
    printf '[nginx-compat] 错误：输出里仍残留独立的 `http2 on;`，该 nginx 版本不认这个指令\n' >&2
    exit 2
  fi
fi

exit 0
```

- [ ] **Step 5: 创建 `deploy/docker-compose.yml`**

```yaml
# deploy/docker-compose.yml — 单容器编排
#
# 依据：设计文档 §14.2「deploy/docker-compose.yml（单容器编排）」
#
# ⛔ 单写者约束：这里的 command 里【绝不】加多 worker 进程 / 多进程集群启动参数，
#    也不要用 compose 的 scale 扩副本。
#    SQLite 官方：There can only be a single writer at a time。
#    多个 Node 进程同时写同一个 .db 文件是 SQLITE_BUSY 的真正来源。
#    ⚠️ 本文件【不】写出多进程参数的具体名字：规格 test/deploy-assets.test.js
#       按字面扫全文（注释里出现同样判违规），参数名见 P6 计划 Task 2 章节。
# ✅ 扩容只能加「读」：静态资源交给 nginx 直出。
# ⚠️ WAL 要求所有进程在同一台主机；要多机部署必须换 Postgres，没有第三条路。
#
# ⚠️ 本文件在 platform/deploy/ 下，compose 的相对路径以本文件所在目录为基准
#    （compose 的 project directory = 第一个 compose 文件所在目录）。
#    运行： cd platform && docker compose -f deploy/docker-compose.yml up -d
#    ⇒ 挂载源 `..` = platform/，代码进容器，升级靠替换宿主机目录。
#
# ⚠️ 网络口径（照实写：src/server.js 只绑回环）：
#    src/server.js 的 server.listen(port, '127.0.0.1') —— 进程只听回环。
#    ⇒ 若用 ports 端口映射，宿主机的 127.0.0.1:8080 会被转发到容器的 eth0 地址，
#      而进程不听那里 → 连接被拒（容器 healthy，但宿主机 curl 不通、静默失败）。
#    ⇒ 因此这里用 network_mode: host：容器与宿主机共享网络栈，
#      进程绑的 127.0.0.1:8080 就是宿主机的 127.0.0.1:8080 ——
#      nginx 的反代目标（127.0.0.1:8080）不用改，Node 也不会暴露到公网。
#    ⚠️ host 网络只保证 Linux 宿主机的语义；Docker Desktop（macOS/Windows）上
#       容器拿到的是 Linux 虚拟机的网络栈，宿主机 127.0.0.1:8080 仍不通。
#    （若日后把 src/server.js 改成可绑 0.0.0.0，这里可换回 ports 映射。）

name: heikesong

services:
  app:
    image: node:24-alpine
    container_name: heikesong-app
    working_dir: /app
    # ⛔ 不要改成多进程启动参数，也不要加多 worker 进程
    command: ["node", "src/server.js"]
    restart: always
    environment:
      PORT: "8080"
      DATA_DIR: "/data"
      NODE_ENV: "production"
      # ⛔⛔ **绝对不要打开 DEMO_MODE**（2026-10-21 漂移审计修正 I-5）：
      #    DEMO_MODE 一旦打开，会把 /src/domain/* 与 /rules/* 挂到 HTTP 上 ——
      #    那是**领域层算法源码**与**全部规则配置**。生产部署下必须一律 404。
      #    这道门只给本地预览（scripts/serve-demo.js）与开发服务器用。
    # 只绑回环：Node 自己 listen 127.0.0.1（src/server.js 的实际行为），
    # 宿主机侧即 127.0.0.1:8080，对外仍由 nginx 反代。
    network_mode: host
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
#   R-OPS-05（云主机部署）：后期部署到云主机，需要「一键部署 + 备份恢复」⇒ 本脚本就是一键部署；
#     备份/恢复在 scripts/backup.js 与 scripts/restore.js（走 sqlite.backup() API，不用 cp）。
#   R-OPS-01（可移植）：脚本只依赖 POSIX 工具与 Node 内置，**不联网安装 npm 包**；
#     路径一律用 $(dirname "$0") 定位，不依赖当前工作目录 ⇒ 同一份脚本在 Linux/macOS 都能跑。
#
# ✅ 幂等：可重复执行不炸（用户/目录/文件已存在 → 跳过或覆盖，不报错）。
# ⛔ 不硬编码任何口令：管理员口令来自环境变量 ADMIN_PASSWORD，或交互读取（不回显）。
#    环境文件 /etc/heikesong/platform.env 里【不放口令】——口令只用于初始化那一次。
#
# 用法（【不要】把口令写进本文件，也不要提交进仓库）：
#   sudo SERVER_NAME=heikesong.example.com \
#        CERT_PATH=/etc/letsencrypt/live/heikesong.example.com/fullchain.pem \
#        KEY_PATH=/etc/letsencrypt/live/heikesong.example.com/privkey.pem \
#        ./deploy/install.sh
#   → 不给 ADMIN_PASSWORD 时，脚本会交互读取口令（不回显，仅用于这一次初始化）。
#   → 想免交互：在你自己的 shell 里 export ADMIN_PASSWORD（值当场填，
#     【不要】写进本文件 / 仓库 / 命令历史），再用 sudo -E 调用本脚本。
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
#   ENV_FILE      环境文件路径         默认 /etc/heikesong/platform.env
#   NGINX_SITE    nginx 站点文件       默认 /etc/nginx/sites-available/heikesong.conf
#   NGINX_LINK    nginx 站点软链       默认 /etc/nginx/sites-enabled/heikesong.conf
#   SYSTEMD_UNIT_DIR systemd 单元目录  默认 /etc/systemd/system
#   SESSION_TTL_DAYS 会话滑动有效期（天）默认 7（与 src/auth/session.js 的默认值一致）
#   SESSION_ABSOLUTE_TTL_DAYS 会话绝对过期上限（天）默认 30（同上）
#
# ⚠️ 端口口径：8080 是**写死**的口径（与 deploy/nginx.conf 的 upstream、
#    systemd 单元的 Environment=PORT、docker-compose 的 PORT 同一套）。
#    要换端口必须四处一起改 —— 本脚本不提供 PORT 变量，避免只改一处连不上。
#
# ⚠️ 绝对过期上限**可以**小于滑动有效期（那是「更严」的合法配置：到期必须重登）。
#    本脚本不禁止这种组合 —— 只校验两者都是正整数。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"     # platform/ 根目录
APP_DIR="${APP_DIR:-/opt/heikesong/platform}"
DATA_DIR="${DATA_DIR:-/var/lib/heikesong/data}"
SERVICE_NAME="${SERVICE_NAME:-heikesong}"
RUN_USER="${RUN_USER:-heikesong}"
SERVER_NAME="${SERVER_NAME:-}"
ENV_FILE="${ENV_FILE:-/etc/heikesong/platform.env}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/heikesong.conf}"
NGINX_LINK="${NGINX_LINK:-/etc/nginx/sites-enabled/heikesong.conf}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
SESSION_TTL_DAYS="${SESSION_TTL_DAYS:-7}"
SESSION_ABSOLUTE_TTL_DAYS="${SESSION_ABSOLUTE_TTL_DAYS:-30}"
# nginx HTTP/2 兼容脚本：`http2 on;` 要 nginx ≥ 1.25.1，Ubuntu 22.04(1.18) /
# 24.04(1.24) 都没有 ⇒ 旧版本自动降级成 `listen ... ssl http2;`（所有版本都合法）。
NGINX_COMPAT_SCRIPT="$SCRIPT_DIR/nginx-http2-compat.sh"
# ⛔ Node 下限 = 22.16.0（package.json engines）。22.16.0 是 node:sqlite.backup()
#    的引入版本 —— 备份脚本（P6 Task 1）依赖它，低版本装了也跑不了备份。
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=16

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

# sed 替换文本转义：反斜杠 / & / | 在替换文本里必须转义，
# 否则路径里的特殊字符会被 sed 当成自己的语法（& = 整个匹配）。
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# ⛔ nginx 必须**在做任何改动之前**就检查完。
#    为什么：nginx 步骤在流程末尾（要等程序装好、库建好、服务起好才轮到它）。
#    如果 nginx 没装，等发现时机器上已经是一个「装了一半」的部署 —— 服务在跑、
#    但没有反代，域名单独访问是 502；脚本还在最后一步以
#    "nginx: command not found" 这种看不懂的错退出。
#    ⇒ 缺 nginx 必须在**动任何东西之前**就明确拒绝。
require_nginx() {
  if [ -z "$SERVER_NAME" ]; then
    return 0    # 未设 SERVER_NAME ⇒ 本次不配 nginx，跳过
  fi
  if ! command -v nginx >/dev/null 2>&1; then
    die "未检测到 nginx，但设置了 SERVER_NAME=${SERVER_NAME}。请先安装 nginx（Debian/Ubuntu: apt-get install -y nginx；RHEL/CentOS: dnf install -y nginx；Alpine: apk add --no-cache nginx），或去掉 SERVER_NAME 变量以跳过 nginx 配置。"
  fi
  log "已检测到 nginx：$(nginx -v 2>&1 | head -n 1)"
}

# 会话有效期相关的两个天数必须是**正整数**。
# 为什么要在这里 fail-fast：src/auth/session.js 对非法值是**静默回退到默认值**
# （"SESSION_TTL_DAYS=abc" ⇒ 悄悄用 7 天）—— 环境文件里写错却没有任何提示，
# 运维会以为改了其实没改。配置非法就报错，不静默兜底。
validate_session_ttls() {
  case "$SESSION_TTL_DAYS" in
    ''|*[!0-9]*) die "SESSION_TTL_DAYS 必须是正整数（当前：'$SESSION_TTL_DAYS'）" ;;
  esac
  case "$SESSION_ABSOLUTE_TTL_DAYS" in
    ''|*[!0-9]*) die "SESSION_ABSOLUTE_TTL_DAYS 必须是正整数（当前：'$SESSION_ABSOLUTE_TTL_DAYS'）" ;;
  esac
  [ "$SESSION_TTL_DAYS" -gt 0 ] || die "SESSION_TTL_DAYS 必须 > 0（当前：${SESSION_TTL_DAYS}）"
  [ "$SESSION_ABSOLUTE_TTL_DAYS" -gt 0 ] || die "SESSION_ABSOLUTE_TTL_DAYS 必须 > 0（当前：${SESSION_ABSOLUTE_TTL_DAYS}）"
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
    useradd --system --home-dir "$(dirname "$DATA_DIR")" --shell /usr/sbin/nologin "$RUN_USER"
  else
    adduser -S -D -H -h "$(dirname "$DATA_DIR")" -s /sbin/nologin "$RUN_USER"
  fi
}

# 运行用户的主组：落盘时用它，而不是「与用户名同名的组」——
# 同名组是 Debian/RHEL 上 useradd 的默认行为，但不是通用假设
# （例如 macOS 的主组是 staff，install -g <用户名> 会直接报 unknown group）。
run_group() {
  id -gn "$RUN_USER" 2>/dev/null || printf '%s' "$RUN_USER"
}

prepare_dirs() {
  local group
  group="$(run_group)"
  install -d -m 0755 "$APP_DIR"
  install -d -m 0750 -o "$RUN_USER" -g "$group" "$DATA_DIR"
  install -d -m 0750 -o "$RUN_USER" -g "$group" "$DATA_DIR/backups"
}

copy_app() {
  log "同步程序到 $APP_DIR"
  if command -v rsync >/dev/null 2>&1; then
    # ⚠️ 排除 web/dist/：那是**演示版静态站的构建产物**（P6 Task 6 的
    #    `scripts/build-demo.js` 产出），走**独立发布通道**，不随程序同步到服务器。
    #    ⚠️ 排除 web/assets/：那是 nginx `location /assets/` 指向的**预留**目录
    #    （带哈希的生产静态资源位），本仓库**没有任何构建步骤**产出它。
    #    两者与「前端产物目录」的口径以 P6 计划 Task 6 为准。
    rsync -a --delete \
      --exclude 'data/' --exclude 'node_modules/' --exclude '.git/' \
      --exclude 'web/dist/' --exclude 'web/assets/' \
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
  # umask 收窄到 077 再写文件，写完恢复 —— 否则 umask 会漏到后面的
  # nginx 站点文件上（那个文件 nginx 主进程以 root 读，但 600 的配置
  # 会让「非 root 的配置检查工具」读不了）。
  local old_umask
  old_umask="$(umask)"
  umask 077
  {
    printf 'PORT=8080\n'
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'SESSION_TTL_DAYS=%s\n' "$SESSION_TTL_DAYS"
    # ⚠️ 绝对过期上限：src/auth/session.js 读 SESSION_ABSOLUTE_TTL_DAYS（默认 30 天）。
    #    不写这个变量时应用会**静默**用 30 天默认值 —— 环境文件与实际生效值就对不上了，
    #    排障时无从查证。显式写出来，让「文件里写的」＝「生效的」。
    printf 'SESSION_ABSOLUTE_TTL_DAYS=%s\n' "$SESSION_ABSOLUTE_TTL_DAYS"
    # ⚠️ NODE_ENV=production 会让登录 Cookie 带 Secure 标记
    #    （src/server.js: secureCookies = NODE_ENV === 'production'）——
    #    「IP + 端口 + 纯 HTTP」的调试形态下浏览器会直接拒收 Cookie → 登录失效。
    #    那种形态请用 NODE_ENV=development 调用本脚本。
    printf 'NODE_ENV=%s\n' "${NODE_ENV:-production}"
  } > "$ENV_FILE"
  umask "$old_umask"
  chmod 0640 "$ENV_FILE"
  chown root:"$(run_group)" "$ENV_FILE" 2>/dev/null || true
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
    # ⚠️ 读不到（stdin 不是终端 / 已关闭）时 read 返回非 0 ——
    #    在 set -e 下会让脚本直接死掉，报错信息还很难懂，所以吞掉退出码，
    #    交给下面的空值检查给出人话。
    read -rs password || true
    printf '\n'
  fi
  [ -n "$password" ] || die "未提供管理员口令（ADMIN_PASSWORD 环境变量或交互输入）"
  log "初始化能力点 / 角色 / 管理员账号（手机号 ${phone}）"
  ( cd "$APP_DIR" && as_service_user env DATA_DIR="$DATA_DIR" ADMIN_PHONE="$phone" ADMIN_PASSWORD="$password" node scripts/seed.js )
  unset password
}

write_systemd_unit() {
  log "写 systemd 单元 $SERVICE_NAME"
  install -d -m 0755 "$SYSTEMD_UNIT_DIR"
  sed -e "s|__APP_DIR__|$(sed_escape "$APP_DIR")|g" \
      -e "s|__DATA_DIR__|$(sed_escape "$DATA_DIR")|g" \
      -e "s|__RUN_USER__|$(sed_escape "$RUN_USER")|g" \
      -e "s|/etc/heikesong/platform.env|$(sed_escape "$ENV_FILE")|g" \
      "$ROOT/deploy/heikesong.service" > "$SYSTEMD_UNIT_DIR/$SERVICE_NAME.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

write_nginx_site() {
  if [ -z "$SERVER_NAME" ]; then
    log "跳过 nginx：未设置 SERVER_NAME（正式对外域名）"
    return 0
  fi
  [ -f "$NGINX_COMPAT_SCRIPT" ] || die "缺少 ${NGINX_COMPAT_SCRIPT}（HTTP/2 兼容脚本）"
  log "写 nginx 站点配置 $NGINX_SITE"
  install -d -m 0755 "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"
  local cert="${CERT_PATH:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
  local key="${KEY_PATH:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"

  # ① 先做 HTTP/2 语法兼容：`http2 on;` 只有 nginx ≥ 1.25.1 认识，
  #    Ubuntu 22.04(1.18) / 24.04(1.24) 都没有 ⇒ 旧版本自动降级成
  #    `listen ... ssl http2;`（这个写法在所有版本上都合法）。
  #    不做这一步的话，nginx -t 会报 unknown directive "http2"，
  #    而那已经是整个部署的最后一步了。
  local rendered
  rendered="$(mktemp)"
  if ! bash "$NGINX_COMPAT_SCRIPT" "$ROOT/deploy/nginx.conf" "$rendered"; then
    rm -f "$rendered"
    die "nginx HTTP/2 兼容处理失败（见上面的 [nginx-compat] 输出）"
  fi

  # ② 备份旧站点文件：nginx -t 失败时要**回滚**，不能把一份坏配置留在
  #    sites-enabled 里 —— 那会毒化这台机器上**下一次**任何 nginx reload
  #    （哪怕是别人触发的、跟这次部署无关的 reload）。
  local backup=""
  if [ -f "$NGINX_SITE" ]; then
    backup="$(mktemp "${TMPDIR:-/tmp}/heikesong-nginx-site.XXXXXX")"
    cp -p "$NGINX_SITE" "$backup"
  fi

  sed -e "s|__SERVER_NAME__|$(sed_escape "$SERVER_NAME")|g" \
      -e "s|__CERT_PATH__|$(sed_escape "$cert")|g" \
      -e "s|__KEY_PATH__|$(sed_escape "$key")|g" \
      -e "s|__APP_DIR__|$(sed_escape "$APP_DIR")|g" \
      "$rendered" > "$NGINX_SITE"
  rm -f "$rendered"
  ln -sfn "$NGINX_SITE" "$NGINX_LINK"

  # ⛔ 先验配置再 reload：配置错了不炸线上。
  if ! nginx -t; then
    if [ -n "$backup" ] && [ -f "$backup" ]; then
      mv -f "$backup" "$NGINX_SITE"
      log "已回滚到上一版 nginx 站点配置"
    else
      rm -f "$NGINX_SITE" "$NGINX_LINK"
      log "已撤销本次 nginx 站点配置（此前没有旧配置）"
    fi
    die "nginx 配置校验失败（nginx -t 返回非 0）——已回滚，请按上面的 nginx -t 输出修正后重跑本脚本"
  fi
  if [ -n "$backup" ]; then rm -f "$backup"; fi

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
  # ⛔ 先查前置条件，再动任何东西：
  #    nginx 缺失 / 会话天数写错，都必须在「用户/目录/库/服务」被创建之前拒绝，
  #    否则会留下一个装了一半的机器（服务在跑、但反代没配），排查成本极高。
  require_nginx
  validate_session_ttls
  if ! node_version_ok; then
    install_node
  fi
  node_version_ok || die "Node 版本仍不满足要求（需要 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}）"

  [ -f "$ROOT/deploy/heikesong.service" ] || die "缺少 $ROOT/deploy/heikesong.service（脚本必须在 platform/deploy/ 下）"
  [ -f "$ROOT/deploy/nginx.conf" ] || die "缺少 $ROOT/deploy/nginx.conf（脚本必须在 platform/deploy/ 下）"

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
  # 备份脚本是 P6 Task 1 的产物：还没落地就不打印这条命令，免得给出跑不通的提示。
  if [ -f "$APP_DIR/scripts/backup.js" ]; then
    log "  备份命令： cd $APP_DIR && DATA_DIR=$DATA_DIR node scripts/backup.js"
  fi
  log "  查看日志： journalctl -u $SERVICE_NAME -f"
}

main "$@"
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/deploy-assets.test.js`
Expected: PASS（14 个测试全过：deploy-assets.test.js 14）

> ⚠️ **2026-10-21 预审补记（Task 2）**：规格原写「7 个测试」。规格自带的 7 个用例**逐字保留**；
> 预审**追加 7 个**「对配置本身断言」的用例（单进程 / DEMO_MODE 禁令 / 正式形态 TLS /
> 上游只绑回环 / 不扩副本 / 端口与真实代码同口径 / 环境文件不落口令 / 幂等守卫 /
> 「注释不能掩盖配置错误」），理由见台账 D-11 与 D-15。

- [ ] **Step 8: 语法自检（不执行）**

Run: `cd platform && bash -n deploy/install.sh && echo "install.sh 语法 OK"`
Expected: `install.sh 语法 OK`

Run: `cd platform && sh -c 'grep -v "^[[:space:]]*#" deploy/nginx.conf | grep -c "proxy_buffering off;"'`
Expected: `1`

> ⚠️ **2026-10-21 预审补记（Task 2）**：规格原命令是 `grep -c "proxy_buffering off;"`（不过滤注释），
> 期望值写 `1` —— 但**规格自己的 nginx.conf 头部注释里就写了一遍** `proxy_buffering off;`，
> 所以原命令在原文件上实测是 **2**（注释 1 处 + 真指令 1 处）。
> 真指令本来就只有 1 处，所以改成「去掉整行注释再计数」，期望值 `1` 成立且能真正抓到重复指令。

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
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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

// ── 父代理预审追加用例（2026-10-21）────────────────────────────────────
// 规格自带的 6 个用例盖不住「闸根本没生效」这一类失败：
//   ① 规格用例 6 名字叫「发布产物目录也必须过闸」，实际测的是 --forbidden + 普通文件，
//      并没有真的测「platform/web/dist/ 这一趟」；
//   ② 规格用例 5 在参数还没实现时也会「通过」（未识别的参数被当成扫描路径 → 扫 0 个文件 →
//      退出码 0），属于假绿。
// 下面这批用例的期望值在「实现正确」与「实现被改坏」两种情况下必须不同（判别性）。

const PLATFORM_DIR = join(here, '..');
const SCRIPT = join(PLATFORM_DIR, 'scripts', 'audit-scan.js');

/**
 * 造一个「能跑 CLI」的临时工程：<root>/platform/scripts/audit-scan.js（脚本副本）+
 * <root>/platform/scripts/forbidden.txt（清单）+ <root>/docs/（被扫的文件）+
 * 可选的 <root>/platform/web/dist/（发布产物）。
 * CLI 里的仓库根 = <root>，所以相对路径可预期（platform/web/dist/index.html）。
 */
function cliSandbox({ manifest = '禁用词\n', files = {}, distFiles = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hks-scan-rel-'));
  const scriptsDir = join(root, 'platform', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  copyFileSync(SCRIPT, join(scriptsDir, 'audit-scan.js'));
  writeFileSync(join(scriptsDir, 'forbidden.txt'), manifest, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, 'docs', name), content, 'utf8');
  }
  if (distFiles) {
    for (const [name, content] of Object.entries(distFiles)) {
      const abs = join(root, 'platform', 'web', 'dist', name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  }
  return { root, scriptsDir };
}

function runCli(sandbox, args = [], env = undefined) {
  return spawnSync(process.execPath, [join(sandbox.scriptsDir, 'audit-scan.js'), ...args], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

test('仓库自带清单真的能拦住裸引用、放过更正语境（CICC 四维各 25% / 行为分进入总分）', () => {
  const parsed = parseManifest(readFileSync(join(here, '..', 'scripts', 'forbidden.txt'), 'utf8'));

  // 裸引用（当作现行规则写）→ 必须拦下
  const bare = scanText('CICC 四维各 25% 是行业通行做法。\n', parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    bare.violations.some((v) => v.term.includes('CICC')),
    '裸引用「CICC 四维各 25%」必须被仓库自带清单拦下',
  );
  const bareScore = scanText('行为分进入总分，按 10% 计入。\n', parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    bareScore.violations.some((v) => v.term === '行为分进入总分'),
    '裸引用「行为分进入总分」必须被仓库自带清单拦下',
  );

  // 更正语境（引用并纠正原始错误表述）→ 不计违规，但要进报告
  const correction = 'S7 §1.1 已更正：CICC 四维各 25% 的说法有误，本平台改为六维权重表。\n';
  const ok = scanText(correction, parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    !ok.violations.some((v) => v.term.includes('CICC')),
    '更正语境不得被拦下',
  );
  assert.ok(
    ok.exempted.some((e) => e.term.includes('CICC')),
    '更正语境必须进报告（豁免不静默）',
  );
  const correctionScore = 'S10 §3.3 已更正：行为分进入总分的说法有误，行为分只做垫底排序。\n';
  const okScore = scanText(correctionScore, parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    !okScore.violations.some((v) => v.term === '行为分进入总分'),
    '更正语境不得被拦下',
  );
});

test('发布产物目录（platform/web/dist/）本身必须过闸（发布产物也扫）', () => {
  const sb = cliSandbox({
    manifest: '禁用词Z\n',
    distFiles: { 'index.html': '<html><body>这里有禁用词Z</body></html>\n' },
  });
  const r = runCli(sb);
  assert.equal(
    r.status,
    1,
    `发布产物里的禁用表述必须拦下（期望退出码 1）\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stderr, /platform\/web\/dist\/index\.html/, '报告里必须指出是发布产物里的哪一行');
  rmSync(sb.root, { recursive: true, force: true });
});

test('发布产物里的每一个文本文件都要过闸（含 src/domain、rules、seed 这类子目录）', () => {
  // ⚠️ 目录形状对齐 Task 6 的 build-demo.js 产物：web/dist/ 根目录有 index.html，
  //    另有 src/domain/（领域层拷贝）、rules/（规则拷贝）、seed/（种子数据）。
  //    末位的 data/ 是「防回归」用的：源码目录的默认排除项里有 'data'，
  //    发布产物那一趟若误用默认排除，data/ 下的文件就会被静默跳过 ——
  //    那正是「发布闸有洞但报告全绿」的形状。
  const sb = cliSandbox({
    manifest: '禁用词Z\n',
    distFiles: {
      'index.html': '<html><body>这里有禁用词Z</body></html>\n',
      'src/domain/scoring.js': '// 领域层\n// 禁用词Z\n',
      'rules/points.json': '{ "note": "禁用词Z" }\n',
      'seed/demo-data.json': '{ "note": "禁用词Z" }\n',
      'data/notes.md': '禁用词Z\n',
    },
  });
  const r = runCli(sb);
  assert.equal(r.status, 1, `发布产物里的禁用表述必须拦下\n${r.stdout}\n${r.stderr}`);
  for (const p of Object.keys({
    'index.html': 1, 'src/domain/scoring.js': 1, 'rules/points.json': 1,
    'seed/demo-data.json': 1, 'data/notes.md': 1,
  })) {
    assert.ok(
      r.stderr.includes(`platform/web/dist/${p}`),
      `发布产物里的 ${p} 必须过闸（报告里却没有它）\n${r.stderr}`,
    );
  }
  rmSync(sb.root, { recursive: true, force: true });
});

test('清单里的 @skip-path 不能把发布产物那道闸关掉（清单自己不能关闸）', () => {
  const sb = cliSandbox({
    manifest: '@skip-path ^platform/web/dist/\n禁用词Z\n',
    distFiles: { 'index.html': '禁用词Z\n' },
  });
  const r = runCli(sb);
  assert.equal(
    r.status,
    1,
    `清单不许把发布产物那道闸关掉（期望退出码 1）\n${r.stdout}\n${r.stderr}`,
  );
  rmSync(sb.root, { recursive: true, force: true });
});

test('发布产物不存在时按「存在才扫」处理，不报错（退出码 0）', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'ok.md': '正常内容\n' } });
  const r = runCli(sb);
  assert.equal(r.status, 0, `发布产物不存在不该报错\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /发布产物 platform\/web\/dist：不存在/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('发布产物里的更正语境 → 不计违规，但必须进报告（豁免不静默）', () => {
  const sb = cliSandbox({
    manifest: 'CICC 四维各 25%|已更正|S7 §1.1|不是|六维\n',
    distFiles: { 'spec.md': 'S7 §1.1 已更正：CICC 四维各 25% 的说法有误。\n' },
    files: { 'ok.md': '正常内容\n' },
  });
  const r = runCli(sb);
  assert.equal(r.status, 0, `更正语境不得被拦下\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /豁免命中 1 处/, '发布产物里的豁免也必须进报告（豁免不静默）');
  rmSync(sb.root, { recursive: true, force: true });
});

test('--json 输出机器可读（含违规与发布产物信息）', () => {
  const sb = cliSandbox({
    manifest: '禁用词Z\n',
    distFiles: { 'index.html': '禁用词Z\n' },
    files: { 'ok.md': '正常内容\n' },
  });
  const r = runCli(sb, ['--json']);
  assert.equal(r.status, 1, `JSON 模式下退出码语义不变\n${r.stdout}\n${r.stderr}`);
  const data = JSON.parse(r.stdout);
  assert.equal(data.terms, 1);
  assert.equal(data.violations.length, 1);
  assert.equal(data.violations[0].term, '禁用词Z');
  assert.equal(data.releaseArtifacts.present, true);
  assert.equal(data.releaseArtifacts.scannedFiles, 1);
  rmSync(sb.root, { recursive: true, force: true });
});

test('未知参数 → 退出码 2（不许把参数当路径吞掉后「扫 0 个文件还报通过」）', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'ok.md': '正常内容\n' } });
  const r = runCli(sb, ['--jsonn']);
  assert.equal(r.status, 2, `参数写错必须报错退出\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /未知参数/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('--forbidden 缺路径 → 退出码 2（不许静默回落默认清单）', () => {
  const code = main(['--forbidden']);
  assert.equal(code, 2, '--forbidden 少了路径不许回落默认清单（那等于用错清单）');
});

test('--forbidden 指定的清单为空 → 退出码 2（空清单 ≠ 已保护，与默认清单同规则）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-empty-man-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '# 只有注释，没有词条\n', 'utf8');
  const target = join(dir, 'a.md');
  writeFileSync(target, '随便写点什么\n', 'utf8');
  const code = main(['--forbidden', manifest, target]);
  assert.equal(code, 2, '空清单必须报错退出，不许「扫了 0 个词就通过」');
  rmSync(dir, { recursive: true, force: true });
});

test('一个文件都没扫到 → 退出码 2（静默的空产出比报错更危险）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-empty-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '禁用词Z\n', 'utf8');
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const code = main(['--forbidden', manifest, empty]);
  assert.equal(code, 2, '扫了 0 个文件不许报通过');
  rmSync(dir, { recursive: true, force: true });
});

test('evidence-chain 增强不可用（HOME 下没有该 skill）→ 闸结论不变，退出码 0 并打印一行说明', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'ok.md': '正常内容\n' } });
  const fakeHome = mkdtempSync(join(tmpdir(), 'hks-scan-home-'));
  const r = runCli(sb, [], { HOME: fakeHome });
  assert.equal(
    r.status,
    0,
    `增强不可用不许把闸判成失败（平台必须能独立跑）\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /evidence-chain 增强不可用/);
  rmSync(sb.root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

test('--evidence-chain 指向真实脚本 → 增强真的被调用（且闸结论不受它影响）', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'bad.md': '这里有禁用词Z\n' } });
  const marker = join(sb.root, 'marker.txt');
  const fake = join(sb.root, 'fake-evidence.js');
  writeFileSync(
    fake,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'called\\n');\n`,
    'utf8',
  );
  const r = runCli(sb, ['--evidence-chain', fake]);
  assert.ok(existsSync(marker), '增强脚本必须真的被执行（参数没被吞掉）');
  assert.equal(r.status, 1, '闸结论只看禁用表述，不看增强脚本的输出');
  rmSync(sb.root, { recursive: true, force: true });
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
    if (a === '--forbidden') {
      // ⛔ 缺值不许静默回落默认清单：参数写错（漏了路径）时回落 = 用错清单 = 假绿。
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('[audit-scan] --forbidden 后面必须跟清单路径');
        return 2;
      }
      manifestPath = value;
      i += 1;
      continue;
    }
    if (a === '--evidence-chain') { evidenceChainPath = argv[i + 1] || null; i += 1; continue; }
    if (a.startsWith('--')) {
      // ⛔ 未知参数不许当扫描路径吞掉（那等于「扫了 0 个文件还报通过」）。
      console.error(`[audit-scan] 未知参数：${a}`);
      console.error('[audit-scan] 用法：node scripts/audit-scan.js [--json] [--forbidden <path>] [--evidence-chain <path>] [root...]');
      return 2;
    }
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
  // ⛔ skipPaths 固定为空：发布产物这道闸不许被清单里的 @skip-path 关掉
  //    （清单自己就能把闸关掉 —— 与「空清单 ≠ 已保护」同一类病）。
  const release = { dir: relative(repoRoot, distDir), present: false, scannedFiles: 0 };
  if (!roots.length && existsSync(distDir)) {
    release.present = true;
    const distReport = scanRoots([distDir], {
      terms: parsed.terms,
      skipPaths: [],
      excludePaths: [],
    });
    report.violations.push(...distReport.violations);
    report.exempted.push(...distReport.exempted);
    report.scannedFiles.push(...distReport.scannedFiles);
    report.excludedPaths.push(...distReport.excludedPaths);
    release.scannedFiles = distReport.scannedFiles.length;
  }
  const evidence = runEvidenceChain(evidenceChainPath, targets);

  // ⛔ 静默的空产出比报错更危险：一份文件都没扫到 = 闸没生效 = 报错退出（退出码 2）。
  const emptyScan = report.scannedFiles.length === 0;

  if (asJson) {
    console.log(JSON.stringify({
      manifest: manifestPath,
      terms: parsed.terms.length,
      scannedFiles: report.scannedFiles.length,
      gateEffective: !emptyScan,
      releaseArtifacts: release,
      violations: report.violations,
      exempted: report.exempted,
      excludedPaths: report.excludedPaths,
      evidenceChain: evidence,
    }, null, 2));
  } else {
    console.log(`[audit-scan] 词条 ${parsed.terms.length} 条｜扫描 ${report.scannedFiles.length} 个文件`);
    console.log(release.present
      ? `[audit-scan] 发布产物 ${release.dir}：扫描 ${release.scannedFiles} 个文件（发布产物本身也必须过闸）`
      : `[audit-scan] 发布产物 ${release.dir}：不存在（构建之后才会有产物；发布产物本身也必须过闸）`);
    console.log(`[audit-scan] 排除 ${report.excludedPaths.length} 项（排除不静默）：`);
    for (const e of report.excludedPaths.slice(0, 50)) console.log(`  - ${e.path}（${e.reason}）`);
    if (report.exempted.length) {
      console.log(`[audit-scan] 豁免命中 ${report.exempted.length} 处（更正语境，不计违规）：`);
      for (const e of report.exempted) console.log(`  - ${e.file}:${e.line} 「${e.term}」`);
    }
    if (report.violations.length) {
      console.error(`[audit-scan] ✗ 发现 ${report.violations.length} 处禁用表述：`);
      for (const v of report.violations) console.error(`  - ${v.file}:${v.line} 「${v.term}」 ${v.text}`);
    } else if (emptyScan) {
      console.error('[audit-scan] 扫描范围内没有任何可扫描的文件 —— 闸未生效（静默的空产出比报错更危险）');
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

  if (report.violations.length) return 1;
  if (emptyScan) {
    if (asJson) console.error('[audit-scan] 扫描范围内没有任何可扫描的文件 —— 闸未生效（静默的空产出比报错更危险）');
    return 2;
  }
  return 0;
}

/**
 * 可选增强：复用 evidence-chain skill 的 audit-evidence.js。
 * ⛔ 平台自身必须能独立跑：找不到就返回 available=false，不影响闸结论。
 */
function runEvidenceChain(scriptPath, targets) {
  const candidates = [
    scriptPath,
    process.env.HOME
      ? join(process.env.HOME, '.minimax', 'skills', 'evidence-chain', 'scripts', 'audit-evidence.js')
      : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const res = spawnSync(process.execPath, [p, ...targets], { encoding: 'utf8' });
      return {
        available: true,
        path: p,
        status: res.status,
        output: `${res.stdout || ''}${res.stderr || ''}`,
      };
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

- [ ] **Step 4: 修改 `scripts/forbidden.txt`（追加 P6 词条）**

> **⚠️ 匹配语义（必须知道，否则清单写了也不生效）**
> P4 的 `scanText()` 用的是 **`line.includes(term)` —— 字面串匹配，不是正则**。
> 所以词条里写 `?` 或 `.*` **永远不会命中**（`四维各 ?25%` 匹配不到 `四维各 25%`）。
> **本项目自带的 `platform/scripts/forbidden.txt` 的既有约定就是「空格变体各写一条」**
> （`积分占决赛30%` 与 `积分占决赛 30%` 分两行列出）—— 本阶段沿用这个约定。
>
> ✅ **P4 定稿已经把带 `?` 的词条拆成空格变体了**（P4 的 `test/audit-scan.test.js` 有一条用例断言
> 「仓库自带清单里没有「正则占位」写法」）—— `初赛企业确认权重20%` / `初赛企业确认权重 20%` /
> `四维各25%` / `四维各 25%` 都已在 P4 的清单里。**本阶段【不改】P4 的这几条**（照规格再追加一遍
> 会触发 `parseManifest` 的「清单里有重复词条」→ 退出码 2 → 闸永远打不开），只追加 P6 的词条。

在 P4 已有的内容后面**追加**（不要删改 P4 的其它词条）：

```text
# ── P6 追加（部署与演示版）────────────────────────────────────
#
# 演示版种子数据与部署文档也必须过闸：发布产物 web/dist/ 会被一起扫描。
# ⚠️ 这里【不】写 @skip-path ^platform/web/dist/：
#    发布产物那道闸不许被清单自己关掉（清单里加一行就能把闸关掉 ——
#    与「空清单 ≠ 已保护」同一类病）。审计扫描器对发布产物单独走一趟，
#    那一趟固定 skipPaths: [] / excludePaths: []，清单的 @skip-path 管不到它。
# 数据目录不扫（库文件是二进制，与文档无关）。
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

P4 定稿里这四条长什么样（**本阶段一个字不改**，列在这里是为了与 P4 的实际内容对齐）：

```text
初赛企业确认权重20%|C-01|冲突|裁决|已更正
初赛企业确认权重 20%|C-01|冲突|裁决|已更正
# 四维各 25% 的旧表述（应为「创新 20% / 技术可行 20% / 完成度 25% / 协作 15%」等六维表）
四维各25%|原表述|有误|已更正|CICC[^，。]*已
四维各 25%|原表述|有误|已更正|CICC[^，。]*已
```

> ⚠️ **清单里【不】写 `@skip-path ^platform/web/dist/`**：发布产物那道闸不许被清单自己关掉
> （清单里加一行就能把闸关掉 —— 与「空清单 ≠ 已保护」同一类病）。
> `audit-scan.js` 对发布产物单独走一趟，那一趟固定 `skipPaths: []` / `excludePaths: []`。
> **改完后必须跑一次 `node scripts/audit-scan.js` 确认退出码仍是 0**（没有误伤）。

- [ ] **Step 4b: 实跑一次扫描闸，确认改词条没有误伤**

Run: `cd platform && node scripts/audit-scan.js`
Expected: 输出 `[audit-scan] 词条 15 条｜扫描 140 个文件` … `[audit-scan] ✓ 未发现禁用表述`，退出码 0
（本仓库的实测值；M 个文件随仓库增长变。**`web/dist/` 不存在时会打印「发布产物 platform/web/dist：不存在」**——
Task 6 的构建产物落地后这一行会变成「扫描 N 个文件」。
若出现命中，多半是豁免正则的标记词（如「已更正」）没写在那行上 → 补标记或改词条，**不要**删掉词条）

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/audit-scan-release.test.js`
Expected: PASS（**19 个测试全过**：规格自带的 6 个 + 父代理预审追加的 13 个）

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

> **【2026-10-21 实施补记 · Task 4】** 规格的 **9 个用例逐字保留**（文件头追加 4 行领域层
> import + 溯源注释）；另**追加 11 个判别性用例** —— 规格的 9 个用例全是**静态**检查
> （结构、维度名、原始分相等、样本数、缺双签、自由命题、互评、expectations 齐不齐），
> 它们证明「数据摆对了形状」，**证明不了「点一下计算，这条数据真的触发了那条分支」**。
> 而本 Task 的灵魂恰恰是后者 ⇒ 追加的用例把种子喂给**真实领域层引擎**（`src/domain/*`），
> 断言分支真的发生了。逐条理由、实跑证据与变异结果见文末「Task 4 实施台账（2026-10-21）」。

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
// platform/test/demo-seed.test.js —— 演示版种子数据（web/seed/demo-data.json）
//
// 规则溯源：
//   - 「种子 = 每条 trace 分支的触发器」→ P6 计划 Task 4【本 Task 的灵魂】+ 设计文档 §12（trace 三件套）
//   - 「z-score 宽严归一化 / 样本不足降级」→ S7 §3.1 + 设计文档 §6.2 Step 2 + 冲突裁决 C-05
//   - 「去极值（该维度评委数 ≥5）」→ S7 §3.2 + 设计文档 §6.2 Step 3
//   - 「R1 分赛道 / R2 双签 / R3 权重封顶 / R4 自由命题」→ S7 §2.4 + 设计文档 §6.2 Step 5
//   - 「自评差异（高 → 书面说明 / 低 → 评委提问，阈值 10）」→ S7 §4.3 + R-JDG-13
//   - 「破同分链（total → 加时陈述 → 互评 → 企业原始分 → 行为分 → 队伍编号）」→ S7 §3.3 + 冲突裁决 C-03
//   - 「段位（里程碑计数 + 数据/原型 + 业务部门签字）」→ S10 §2.2 + S10 §2.1 + R-PTS-01~04
//   - 「行为分只做垫底排序、不进总分」→ S10 §3.3 + R-PTS-08 + 设计文档 §11.1
//
// ⚠️ 本文件的核心用例是「同分队伍在引擎里总分【严格相等】」：
//    规格原种子把两支队伍设计为同分，但**自评席**把它们拉开了（自评 95 触发「书面说明」
//    → 对齐到评委分 81.28，另一支自评 81 不触发 → 保持 81）⇒ 总分差 0.0139 ⇒ 根本不同分。
//    本文件断言的是**引擎算出来的总分**，不是种子里的自述 —— 种子说同分不算数，引擎算出来同分才算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
// ── 实施补记 2026-10-21：追加的判别性用例要把种子喂给【真实领域层引擎】才断言得了分支 ──
import { scoreStage } from '../src/domain/scoring.js';
import { rankTeams } from '../src/domain/ranking.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { computeTier } from '../src/domain/tier.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// 【实施补记 2026-10-21】规格的 9 个用例【逐字保留】+ 追加 11 个判别性用例。
//
// 为什么必须追加：规格的 9 个用例全是**静态**检查（结构、维度名、原始分相等、
// 样本数、缺双签、自由命题、互评、expectations 齐不齐）—— 它们证明的是
// 「数据摆对了形状」，**证明不了**「点一下计算，这条数据真的触发了那条分支」。
// 而本 Task 的灵魂恰恰是后者：种子 = 每条 trace 分支的**触发器**。
//
// 追加的用例把种子喂给【真实的领域层引擎】（src/domain/*，纯函数、无 IO、无 Node 内置模块），
// 断言分支真的发生了 —— 这样 Task 5 的 demo-engine.test.js 逐条断言 expectations 时，
// 断言的是**引擎的输出**，不是种子里的一句自述。
//
// ⚠️ 输入构造（expandSubmissions / roster）与 Task 5 的 web/api.demo.js 同形；
//    两边若漂移，Task 5 的 demo-parity.test.js 会当场判出来（那里比的是
//    「演示适配器 vs 直接调 scoreStage」的一致性）。
// ─────────────────────────────────────────────────────────────────────────────

function expandSubmissions(s) {
  const out = [];
  for (const [judgeId, byTeam] of Object.entries(s.reviews ?? {})) {
    for (const [teamId, byDim] of Object.entries(byTeam ?? {})) {
      for (const [dimension, rawScore] of Object.entries(byDim ?? {})) {
        out.push({ judgeId, teamId, dimension, rawScore: Number(rawScore) });
      }
    }
  }
  return out;
}

function roster(s) {
  const pkgById = new Map((s.taskPackages ?? []).map((p) => [p.id, p]));
  return (s.teams ?? []).map((t) => {
    const pkg = pkgById.get(t.packageId) ?? {};
    return {
      teamId: t.id,
      packageEnterpriseId: pkg.enterpriseId ?? null,
      isFreeBrief: pkg.isFreeBrief === true,
    };
  });
}

function compute(s = seed) {
  return scoreStage({
    config: rules.scoring.final,
    judges: (s.judges ?? []).map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(s),
    enterpriseConfirmations: s.enterpriseConfirmations ?? [],
    peerReviews: s.peerReviews ?? [],
    teams: roster(s),
    selfReviews: s.selfReviews ?? [],
  });
}

function behaviorOf(s, teamId) {
  return behaviorScore({
    events: (s.behaviorEvents ?? []).filter((e) => e.teamId === teamId),
    behaviorConfig: rules.behavior,
  });
}

test('追加·同分队伍在引擎里总分严格相等（构造保证，不靠手算）', () => {
  const out = compute();
  const [a, b] = seed.expectations.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assert.ok(ta && tb, '两支队伍都必须参与计算');
  assert.equal(ta.total, tb.total, '同分队伍的总分必须完全相等');
  assert.equal(ta.seatP, tb.seatP, '同分队伍的评委席分必须完全相等');
  assert.equal(ta.seatE, tb.seatE, '同分队伍的企业席分必须完全相等');
  // ⛔ 反例守卫：同分不能只看评委席 —— 自评席也算一席，
  //    自评不一样就会把「同分」拉开（规格原种子就踩了这个坑）。
  for (const d of Object.keys(ta.perDimension)) {
    assert.equal(ta.perDimension[d].mean, tb.perDimension[d].mean, `维度 ${d} 的分必须相等`);
  }
});

test('追加·破同分链真的在 peer 级把同分队伍分开（互评高者在前）', () => {
  const out = compute();
  const [a, b] = seed.expectations.tiedTeams;
  const byTeam = {};
  for (const row of out.teams) {
    const peer = (seed.peerReviews ?? []).filter((p) => p.toTeamId === row.teamId);
    const conf = (seed.enterpriseConfirmations ?? []).filter((c) => c.teamId === row.teamId);
    byTeam[row.teamId] = {
      peerScore: peer.length ? peer.reduce((s, p) => s + Number(p.score || 0), 0) / peer.length : undefined,
      enterpriseRaw: conf.length ? conf.reduce((s, c) => s + Number(c.rawScore || 0), 0) / conf.length : undefined,
      behaviorScore: behaviorOf(seed, row.teamId).total,
    };
  }
  const ranked = rankTeams({
    teams: out.teams.map((row) => ({
      teamId: row.teamId, total: row.total, seatP: row.seatP, seatE: row.seatE,
      peerScore: byTeam[row.teamId].peerScore,
      enterpriseRaw: byTeam[row.teamId].enterpriseRaw,
      behaviorScore: byTeam[row.teamId].behaviorScore,
    })),
    tiebreakChain: rules.tiebreak.chain,
    tiebreakData: { isFinal: true, byTeam },
    pointsConfig: rules.points,
  });
  const ra = ranked.ordered.find((r) => r.teamId === a);
  const rb = ranked.ordered.find((r) => r.teamId === b);
  assert.notEqual(ra.rank, rb.rank, '同分队伍必须被破同分链分开');
  assert.ok(ra.rank < rb.rank, '互评分高的一方名次在前');
  const used = ranked.applied.find((c) => c.key === seed.expectations.tiebreakSeparatedBy);
  assert.ok(used, `破同分链里必须用到 ${seed.expectations.tiebreakSeparatedBy} 这一级`);
  assert.ok(used.usedBy.includes(a) && used.usedBy.includes(b), '分开它们的那一级必须同时用到两支队伍');
});

test('追加·归一化降级真的发生（告警指向期望的维度与评委）', () => {
  const out = compute();
  const dim = seed.expectations.unnormalizedDimension;
  const judge = seed.expectations.unnormalizedJudge;
  const hit = out.warnings.find((w) => w.code === 'normalization_fallback' && w.dimension === dim);
  assert.ok(hit, `必须出现维度 ${dim} 的归一化降级告警，实际告警：${JSON.stringify(out.warnings.map((w) => w.code))}`);
  assert.ok(String(hit.message).includes(judge), `告警必须点名评委 ${judge}：${hit.message}`);
  const agg = out.trace.normalization[dim];
  assert.equal(agg.normalized, false, '该维度的归一化状态必须是「已降级」');
  assert.ok(agg.judgeSampleSizes[judge] < rules.scoring.final.minSamplesForJudgeNormalization,
    `评委 ${judge} 的样本数必须小于阈值`);
  assert.equal(agg.judgeReasons[judge], 'judge_sample_too_small', '降级原因必须是样本不足');
});

test('追加·去极值真的发生（期望的维度上每个单元都 trimmed）', () => {
  const out = compute();
  const dims = new Set(seed.expectations.trimmedDimensions);
  const steps = out.trace.steps.filter((s) => dims.has(s.dimension));
  assert.ok(steps.length > 0, 'trace 里必须有去极值步骤');
  for (const s of steps) {
    assert.equal(s.trimmed, true, `${s.teamId} 的 ${s.dimension} 必须真的去极值`);
    assert.ok(s.removed.max && s.removed.min, '必须记录被去掉的最高分与最低分评委');
  }
});

test('追加·缺双签真的触发 R2 告警且该项按 0 分计', () => {
  const out = compute();
  const teamId = seed.expectations.missingDualSignatureTeam;
  const hit = out.warnings.find((w) => w.code === 'R2_missing_dual_signature');
  assert.ok(hit, '必须出现 R2_missing_dual_signature 告警');
  assert.equal(hit.teamId, teamId, `告警必须指向 ${teamId}`);
  const row = out.teams.find((t) => t.teamId === teamId);
  assert.equal(row.seatE, 0, '缺双签的企业席分必须按 0 分计（权重保留）');
});

test('追加·自由命题真的触发 R4（企业项由评委「需求真实性」维度替代）', () => {
  const out = compute();
  const teamId = seed.expectations.freeBriefTeam;
  const hit = out.warnings.find((w) => w.code === 'R4_free_brief_judge_scored');
  assert.ok(hit, '必须出现 R4_free_brief_judge_scored 告警');
  assert.equal(hit.teamId, teamId, `告警必须指向 ${teamId}`);
  const row = out.teams.find((t) => t.teamId === teamId);
  const substituteDim = rules.scoring.final.freeBrief.judgeDimension;
  assert.ok(Number.isFinite(row.seatE) && row.seatE > 0, 'R4 生效时企业席分由评委维度替代，不能是 0');
  assert.ok(
    Math.abs(row.seatE - row.perDimension[substituteDim].mean) < 1e-9,
    '企业席分必须等于替代维度的评委分',
  );
  assert.ok(
    !out.warnings.some((w) => w.code === 'R4_substitute_no_scores'),
    '替代维度有评委分，不应出现「替代维度无分」的告警',
  );
});

test('追加·自评差异三条分流真的发生（书面说明 / 评委提问 / 阈值内不告警）', () => {
  const out = compute();
  const byCode = (code) => out.warnings.filter((w) => w.code === code);
  const hi = byCode('self_eval_written_explanation');
  const lo = byCode('self_eval_judge_question');
  assert.equal(hi.length, 1, `「书面说明」分支必须恰好一支队（实际 ${hi.length}）`);
  assert.equal(lo.length, 1, `「评委提问」分支必须恰好一支队（实际 ${lo.length}）`);
  assert.equal(hi[0].teamId, seed.expectations.selfEvalWrittenExplanationTeam);
  assert.equal(lo[0].teamId, seed.expectations.selfEvalJudgeQuestionTeam);
  for (const t of seed.expectations.selfEvalWithinThresholdTeams) {
    assert.ok(
      !hi.some((w) => w.teamId === t) && !lo.some((w) => w.teamId === t),
      `${t} 的自评与评委分差异在阈值内，不该告警`,
    );
  }
});

test('追加·自评对齐不加分：书面说明那支队的自评席分 = 评委席分（不是自评原分）', () => {
  const out = compute();
  const teamId = seed.expectations.selfEvalWrittenExplanationTeam;
  const row = out.teams.find((t) => t.teamId === teamId);
  const self = seed.selfReviews.find((r) => r.teamId === teamId);
  assert.ok(self, `${teamId} 必须有自评记录`);
  const selfSeat = row.perDimension.self_eval;
  const judgeSide = row.perDimension[self.dimension];
  assert.notEqual(selfSeat.mean, self.rawScore, '自评席分不能是自评原分（那样就变成加分项了）');
  assert.equal(selfSeat.mean, judgeSide.mean, '自评席分必须对齐到评委席该维度的分');
  assert.ok(selfSeat.mean < self.rawScore, '对齐只会把自评拉低，绝不会拉高（自评不得变成加分项）');
});

test('追加·缺自评的队伍：self_eval 维度没有分并告警（不静默当 0）', () => {
  const out = compute();
  const teamId = seed.expectations.missingSelfEvalTeam;
  const hit = out.warnings.find((w) => w.code === 'dimension_no_scores' && w.teamId === teamId);
  assert.ok(hit, `必须出现 ${teamId} 的缺分告警`);
  assert.equal(hit.dimension, 'self_eval');
  const row = out.teams.find((t) => t.teamId === teamId);
  assert.equal(row.perDimension.self_eval.mean, null, '该维度没有分');
  // 缺分维度必须被【剔除出分母】，而不是【静默当 0 分】（设计文档 §13 降级表）
  let num = 0; let denAll = 0; let denPresent = 0;
  for (const [key, v] of Object.entries(row.perDimension)) {
    if (key === 'enterprise') continue;
    denAll += v.weight;
    if (v.mean != null) { num += v.weight * v.mean; denPresent += v.weight; }
  }
  assert.ok(Math.abs(row.seatP - num / denPresent) < 1e-9, '缺分维度必须被剔除出分母');
  assert.ok(Math.abs(row.seatP - num / denAll) > 1e-9, '缺分维度不能被静默当 0 分');
});

test('追加·段位与 expectations.tiers 逐条一致（用 computeTier 复算）', () => {
  for (const [teamId, tier] of Object.entries(seed.expectations.tiers)) {
    const milestones = (seed.milestones ?? []).filter((m) => m.teamId === teamId);
    const signoffs = (seed.signoffs ?? []).filter((s) => s.teamId === teamId);
    const info = computeTier({ milestones, signoffs, ranksConfig: rules.ranks });
    assert.equal(info.tier, tier, `${teamId} 的段位应为 ${tier}，实际 ${info.tier}`);
  }
});

test('追加·行为分：证据合规才算分，且分值与 expectations 一致', () => {
  for (const [teamId, expected] of Object.entries(seed.expectations.behaviorScores)) {
    const b = behaviorOf(seed, teamId);
    assert.equal(b.total, expected, `${teamId} 的行为分应为 ${expected}，实际 ${b.total}`);
  }
  const counted = seed.behaviorEvents.some((e) => behaviorOf(seed, e.teamId).items
    .some((i) => i.type === e.type && i.counted));
  assert.ok(counted, '至少要有一条行为事件真的拿到分（否则行为分支不可观测）');
});

test('追加·行为分不进入总分（分轨在算法层，不靠人的自觉）', () => {
  const before = compute();
  const bumped = {
    ...seed,
    behaviorEvents: seed.behaviorEvents.map((e) => ({ ...e, evidence: '{"repo":"r","version":"v","artifact":"a"}' })),
  };
  const after = compute(bumped);
  const sum = (out) => out.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.deepEqual(sum(after), sum(before), '行为分变化不得影响任何队伍的总分');
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
    "j_lenient": { "t_alpha": { "innovation": 88, "feasibility": 84, "completeness": 85, "collaboration": 90 }, "t_beta": { "innovation": 88, "feasibility": 84, "completeness": 85, "collaboration": 90 }, "t_gamma": { "innovation": 70, "feasibility": 78, "completeness": 72, "collaboration": 75 }, "t_delta": { "innovation": 82, "feasibility": 79, "completeness": 81, "collaboration": 78 }, "t_epsilon": { "innovation": 66, "feasibility": 72, "completeness": 68, "collaboration": 70 } },
    "j_strict": { "t_alpha": { "innovation": 74, "feasibility": 70, "completeness": 73, "collaboration": 75 }, "t_beta": { "innovation": 74, "feasibility": 70, "completeness": 73, "collaboration": 75 }, "t_gamma": { "innovation": 58, "feasibility": 64, "completeness": 61, "collaboration": 62 }, "t_delta": { "innovation": 68, "feasibility": 63, "completeness": 65, "collaboration": 64 }, "t_epsilon": { "innovation": 52, "feasibility": 58, "completeness": 55, "collaboration": 57 } },
    "j_mid1": { "t_alpha": { "innovation": 81, "feasibility": 77, "completeness": 79, "collaboration": 83 }, "t_beta": { "innovation": 81, "feasibility": 77, "completeness": 79, "collaboration": 83 }, "t_gamma": { "innovation": 65, "feasibility": 70, "completeness": 66, "collaboration": 69 }, "t_delta": { "innovation": 76, "feasibility": 72, "completeness": 75, "collaboration": 71 }, "t_epsilon": { "innovation": 60, "feasibility": 65, "completeness": 61, "collaboration": 64 } },
    "j_mid2": { "t_alpha": { "innovation": 79, "feasibility": 76, "completeness": 77, "collaboration": 81 }, "t_beta": { "innovation": 79, "feasibility": 76, "completeness": 77, "collaboration": 81 }, "t_gamma": { "innovation": 64, "feasibility": 69, "completeness": 67, "collaboration": 68 }, "t_delta": { "innovation": 75, "feasibility": 71, "completeness": 74, "collaboration": 70 }, "t_epsilon": { "innovation": 59, "feasibility": 64, "completeness": 60, "collaboration": 63 } },
    "j_cross": { "t_alpha": { "innovation": 83, "feasibility": 80, "completeness": 81, "collaboration": 85 }, "t_beta": { "innovation": 83, "feasibility": 80, "completeness": 81, "collaboration": 85 }, "t_gamma": { "innovation": 69, "feasibility": 73, "completeness": 70, "collaboration": 72 }, "t_delta": { "innovation": 79, "feasibility": 75, "completeness": 78, "collaboration": 76 }, "t_epsilon": { "innovation": 63, "feasibility": 67, "completeness": 65, "collaboration": 67 } },
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
    { "teamId": "t_alpha", "dimension": "innovation", "rawScore": 85 },
    { "teamId": "t_beta", "dimension": "innovation", "rawScore": 85 },
    { "teamId": "t_gamma", "dimension": "innovation", "rawScore": 50 },
    { "teamId": "t_delta", "dimension": "innovation", "rawScore": 95 }
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
    { "id": "be_1", "teamId": "t_alpha", "type": "weekly_progress", "evidence": "{\"repo\":\"https://demo.local/alpha\",\"version\":\"v0.1\",\"artifact\":\"第 1 周进度截图\"}", "created_at": "2026-10-12T10:00:00Z" },
    { "id": "be_2", "teamId": "t_alpha", "type": "weekly_progress", "evidence": "{\"repo\":\"https://demo.local/alpha\",\"version\":\"v0.2\",\"artifact\":\"第 2 周进度截图\"}", "created_at": "2026-10-19T10:00:00Z" },
    { "id": "be_3", "teamId": "t_alpha", "type": "workshop_output", "evidence": "{\"output\":\"workshop 课后产出：缺货预测 Demo\"}", "created_at": "2026-10-19T12:00:00Z" },
    { "id": "be_4", "teamId": "t_alpha", "type": "first_demo", "evidence": "{\"version\":\"v0.3\",\"artifact\":\"首次可运行 Demo\"}", "created_at": "2026-10-20T09:00:00Z" },
    { "id": "be_5", "teamId": "t_beta", "type": "weekly_progress", "evidence": "{\"repo\":\"https://demo.local/beta\",\"version\":\"v0.1\",\"artifact\":\"第 1 周进度截图\"}", "created_at": "2026-10-12T10:00:00Z" },
    { "id": "be_6", "teamId": "t_delta", "type": "weekly_progress", "evidence": "{\"repo\":\"https://demo.local/delta\",\"version\":\"v0.1\",\"artifact\":\"第 1 周进度截图\"}", "created_at": "2026-10-12T10:00:00Z" },
    { "id": "be_7", "teamId": "t_delta", "type": "milestone_on_time", "evidence": "{\"milestone\":\"pilot_contract\",\"onTime\":true}", "created_at": "2026-10-18T10:00:00Z" },
    { "id": "be_8", "teamId": "t_gamma", "type": "enterprise_meeting", "evidence": "{\"enterpriseConfirmationId\":\"ec_gamma\"}", "created_at": "2026-10-17T10:00:00Z" }
  ],
  "expectations": {
    "tiedTeams": ["t_alpha", "t_beta"],
    "tiebreakSeparatedBy": "peer",
    "unnormalizedDimension": "feasibility",
    "unnormalizedJudge": "j_partial",
    "missingDualSignatureTeam": "t_gamma",
    "freeBriefTeam": "t_epsilon",
    "selfEvalWrittenExplanationTeam": "t_delta",
    "selfEvalJudgeQuestionTeam": "t_gamma",
    "selfEvalWithinThresholdTeams": ["t_alpha", "t_beta"],
    "missingSelfEvalTeam": "t_epsilon",
    "trimmedDimensions": ["innovation", "feasibility", "completeness", "collaboration"],
    "behaviorScores": { "t_alpha": 17, "t_beta": 2, "t_gamma": 5, "t_delta": 7, "t_epsilon": 0 },
    "tiers": { "t_alpha": "B", "t_beta": "C", "t_gamma": "A", "t_delta": "S", "t_epsilon": "D" }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd platform && node --test test/demo-seed.test.js`
Expected: PASS（20 个测试全过：demo-seed.test.js 20）

> **【2026-10-21 漂移审计修正 M-1】** **原来错在哪**：本计划一处「Expected: PASS」的条数声明
> 与代码块里实际的 `test(` 数量不符 —— `demo-seed.test.js` 声明 **7** 实为 **8**。
> **为什么错**：条数是**实施时的验收闸**。实施者跑出 8 个而计划写 7 个，会误判「多了一条」
> 或「测试缺失」而去改测试代码迁就声明，或者干脆失去对闸的信任。
> **改成什么**：① 数字改成实测值；② 把本计划**全部 4 处** `Expected: PASS` 统一成
> `Expected: PASS（N 个测试全过：file N）` 的格式。
> **依据**：按「就近 `Run:` 行指向的测试文件 → 该文件的 fenced code block 内 `^test(` 出现次数」
> 逐个统计（与审计报告 M-1 同一口径），并在本次改动后**对五份计划全量复算**：
> 每一条 `Expected: PASS（N …）` 现已与代码块实测条数**逐条相等**。

- [ ] **Step 5: 提交**

```bash
cd platform && git add web/seed test/demo-seed.test.js
git commit -m "feat(P6): 演示种子数据（每条 trace 分支都有触发器 + expectations 断言块）" -- web/seed test/demo-seed.test.js
```

---

### Task 5: 演示版适配器（浏览器内真实运行规则引擎）

**Files:**
- Modify: `platform/web/api.demo.js`（P0 建的 3 接口桩 → 完整流程）
- Test: `platform/test/demo-engine.test.js`
- Test: `platform/test/demo-parity.test.js`
- Modify: `platform/test/leaderboard-web.test.js`（P0 的演示适配器用例：适配器换成「浏览器内真跑规则引擎」的版本后，改为显式注入种子与规则 —— 断言一条没少，还多了两条；见 Task 5 台账 D5-05）

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
  - `demoTierBoard({ state, rules, viewer })` / `demoRollingLeaderboard({ state, rules, viewer })`（段位榜 / 滚动总榜，形状对齐正式服务）
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
// platform/test/demo-engine.test.js —— 演示版适配器（浏览器内真实运行规则引擎）
//
// 规则溯源：
//   - 「演示版 = 静态站 + 浏览器内跑同一套规则引擎」→ P6 计划 Task 5【本 Task 的灵魂】+ 设计文档 §14.3
//   - 「同分 → 互评破同分」→ S7 §3.3 + 冲突裁决 C-03
//   - 「归一化降级告警不静默」→ S7 §3.1 + C-05
//   - 「R2 缺双签 → 企业项按 0 分计」→ S7 §2.4 R2
//   - 「自评差异三档」→ S7 §4.3 + R-JDG-13
//   - 「段位 = 里程碑 + 数据/原型 + 业务部门签字」→ S10 §2.2 + R-PTS-01~04
//   - 「行为分只做垫底排序、不进总分」→ S10 §3.3 + R-PTS-08
//   - 「可见性在 API 层过滤（C 段及以上公示，D 段只给本人进度卡）」→ S10 §0.3 + 冲突裁决 C-02
//
// ⚠️ 本文件的断言全部落在**引擎的输出**上，不是种子里的自述 ——
//    种子（web/seed/demo-data.json）只是「每条分支的触发器」，分支有没有真的发生由这里判定。
//
// ⚠️ 判别性纪律：凡是「两种算法会给出同样结果」的期望值都不算数 ——
//    本文件用**构造出来的反例数据**（互评改同分 / 抹掉自评 / 段位标志与 criteria 矛盾）
//    保证每条断言都能区分「真按规则算」与「凑答案」。
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

  // ⚠️ 未登录必须【抛错】而不是返回 { status: 401 } ——
  //    真实后端 web/api.js 在 !res.ok 时抛错，web/app.js 的 restoreSession() 也靠 catch 兜 401。
  await assert.rejects(
    () => api.get('/api/me'),
    (err) => err.status === 401 && err.code === 'UNAUTHENTICATED',
    '未登录时 /api/me 必须以 401 拒绝',
  );

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

// ═══════════════════════════════════════════════════════════════════════
// 【实施补记 2026-10-21】规格的 12 个用例【逐字保留】（只改了 /api/me 的 401 断言形式，
// 见 D5-02）+ 追加 12 个**判别性**用例。
//
// 为什么必须追加：规格的 12 个用例里有一半是「存在性」断言（有条目、非空、7 类齐全）——
// 它们证明「适配器把数据搬过去了」，证明不了「算出来的是不是规则该给的结果」。
// 而本 Task 的灵魂恰恰是后者：演示版必须与正式系统**逐字段一致**。
// ⇒ 追加用例全部用**构造出来的反例数据**（互评改成同分 / 抹掉自评 / 段位标志与 criteria 矛盾），
//    保证「按规则算」与「凑答案」两种实现会被区分开。
// ═══════════════════════════════════════════════════════════════════════

test('追加·破同分告警不被丢弃（tiebreak_extra 不可用必须显式告警）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  assert.ok(Array.isArray(out.tiebreakWarnings), '必须单独给出破同分链的告警');
  const hit = out.tiebreakWarnings.find((w) => w.code === 'tiebreak_key_unusable');
  assert.ok(hit, '种子里没有 tiebreakExtra ⇒ 这一级不可用，必须告警（不静默当 0 分）');
});

test('追加·榜单告警按正式口径合并（计算告警 + 破同分告警，各带 source 标签）', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  const lb = demoLeaderboard({ state, rules, scope: 'rank', viewer: null });
  assert.ok(lb.warnings.length > 0, '榜单必须带告警');
  assert.ok(lb.warnings.some((w) => w.source === 'computation'), '必须有计算告警');
  assert.ok(lb.warnings.some((w) => w.source === 'tiebreak'), '必须有破同分告警');
  for (const w of lb.warnings) assert.ok(w.code, '每条告警都要有 code');
});

test('追加·段位榜：C 段及以上公示，D 段只给本人进度卡（可见性在 API 层过滤）', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  const board = demoLeaderboard({ state, rules, scope: 'tier', viewer: null });
  assert.equal(board.scope, 'tier');
  const ids = board.rows.map((r) => r.teamId);
  assert.ok(!ids.includes(seed.expectations.freeBriefTeam), 'D 段队伍不得出现在公示榜里');
  assert.ok(ids.length > 0, 'C 段及以上必须有队伍');
  for (const r of board.rows) assert.ok(r.tierRank >= 1, '公示行必须有段位名次');
  // ⚠️ 排序口径：段位高的在前（S → A → B → C）—— 判别性：顺序错了这条会红
  assert.equal(board.rows[0].tier, 'S', '段位最高的队伍必须排第一');
  assert.deepEqual(board.rows.map((r) => r.tier), ['S', 'A', 'B', 'C'], '段位榜必须按段位从高到低');
  // 本人视角：D 段队伍只出现在 selfProgress 里
  const mine = demoLeaderboard({ state, rules, scope: 'tier', viewer: { id: 'u', teamId: seed.expectations.freeBriefTeam } });
  assert.ok(mine.selfProgress, 'D 段本人必须拿到进度卡');
  assert.equal(mine.selfProgress.teamId, seed.expectations.freeBriefTeam);
  assert.ok(!mine.rows.some((r) => r.teamId === seed.expectations.freeBriefTeam), 'D 段不得进公示行');
});

test('追加·滚动总榜：scope=rolling，按积分排序', async () => {
  const api = createDemoApi({ storage: makeStorage(), seed, rules });
  await api.post('/api/stages/stage_final/compute', {});
  const rolling = await api.get('/api/leaderboard/rolling');
  assert.equal(rolling.scope, 'rolling', '滚动总榜的 scope 必须是 rolling');
  assert.ok(rolling.rows.length > 0);
  for (const r of rolling.rows) assert.equal(r.stages, 1);
});

test('追加·战绩卡形状与正式系统一致（achievedCount / total / benefits / neverUnlocks / signed）', () => {
  const state = fresh();
  const card = demoPerformanceCard({ state, rules, teamId: 't_delta' });
  assert.equal(card.total, rules.milestones.items.length);
  assert.equal(card.achievedCount, card.items.filter((i) => i.achieved).length);
  assert.ok(Array.isArray(card.benefits), '必须有权益列表');
  assert.ok(Array.isArray(card.neverUnlocks), '必须有「永不解锁」列表');
  assert.ok(card.neverUnlocks.includes('奖金'), '永不解锁项必须与 rules.ranks 一致');
  const signed = card.items.find((i) => i.key === 'pilot_contract');
  assert.ok(signed, 'pilot_contract 必须在 7 类里程碑里');
  assert.equal(signed.signed, true, '有业务部签字的里程碑必须显示已签');
  // 撤销的签字不算已签
  const revoked = fresh();
  revoked.signoffs = revoked.signoffs.map((sg) => (sg.teamId === 't_delta' ? { ...sg, revokedAt: '2026-10-20T00:00:00Z' } : sg));
  const card2 = demoPerformanceCard({ state: revoked, rules, teamId: 't_delta' });
  assert.equal(card2.items.find((i) => i.key === 'pilot_contract').signed, false, '撤销的签字不算已签');
});

test('追加·打分矩阵搬运不得改动任何一格原始分（逐格相等）', () => {
  const expected = [];
  for (const [judgeId, byTeam] of Object.entries(seed.reviews)) {
    for (const [teamId, byDim] of Object.entries(byTeam)) {
      for (const [dimension, rawScore] of Object.entries(byDim)) {
        expected.push(`${judgeId}|${teamId}|${dimension}|${rawScore}`);
      }
    }
  }
  const got = expandSubmissions(fresh()).map(
    (s) => `${s.judgeId}|${s.teamId}|${s.dimension}|${s.rawScore}`,
  );
  assert.deepEqual(got.sort(), expected.sort(),
    'submissions 必须与种子里的原始分【逐格相同】（整体平移 / 改一格都会被抓出来）');
});

test('追加·段位标志按 rules.criteria 推导，不采信数据里预置的标志（判别性）', () => {
  // 反例数据：签字部门是「市场部」（rules.criteria 的业务关键词命中），
  // 但数据里预置的 isBusinessDepartment 是 false。
  //   按 criteria 推导 ⇒ 业务部门签字成立 ⇒ t_delta 是 S 段；
  //   采信数据里的标志 ⇒ 没有业务签字 ⇒ t_delta 掉到 A 段。
  const state = fresh();
  state.signoffs = state.signoffs.map((s) => (
    s.teamId === 't_delta' ? { ...s, department: '市场部', isBusinessDepartment: false } : s
  ));
  assert.equal(demoTier({ state, rules, teamId: 't_delta' }).tier, 'S',
    '部门归类必须按 rules.criteria 判定（与正式系统 src/services/tier.js 同源）');

  // 同理：isDataOrPrototype 也必须按 criteria 推导 ——
  // ⚠️ 这里必须把该队**所有**数据/原型类里程碑的标志都改掉（只改一个不够：
  //    t_gamma 还有 demo_ready 带标志 ⇒ 只翻一个时两种实现结果相同 ⇒ 抓不住）。
  const state2 = fresh();
  state2.milestones = state2.milestones.map((m) => (
    m.teamId === 't_gamma' ? { ...m, isDataOrPrototype: false } : m
  ));
  assert.equal(demoTier({ state: state2, rules, teamId: 't_gamma' }).tier, 'A',
    '「数据/原型」里程碑必须按 rules.criteria 判定');
});

test('追加·判别性反例：互评改成同分 ⇒ 破同分链不再在 peer 级分开（证明分离真的由互评驱动）', () => {
  const state = fresh();
  // 让 t_alpha 与 t_beta 收到的互评分相同 ⇒ peer 这一级区分不出来
  state.peerReviews = state.peerReviews.map((p) => (
    p.toTeamId === 't_alpha' || p.toTeamId === 't_beta' ? { ...p, score: 65 } : p
  ));
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const peer = out.chain.find((c) => c.key === 'peer');
  assert.ok(!peer || !peer.usedBy.includes(a) || !peer.usedBy.includes(b),
    '互评同分时，peer 级不得把两支队分开');
  const behavior = out.chain.find((c) => c.key === 'behavior');
  assert.ok(behavior && behavior.usedBy.includes(a) && behavior.usedBy.includes(b),
    '互评同分时应当由行为分这一级兜底分开（链的下一级）');
});

test('追加·判别性反例：抹掉自评 ⇒ 总分必须变（证明自评席确实参与计分）', () => {
  const withSelf = runDemoCompute({ state: fresh(), rules, stageId: 'stage_final' });
  const state = fresh();
  state.selfReviews = [];
  const withoutSelf = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const sum = (out) => out.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.notDeepEqual(sum(withoutSelf), sum(withSelf), '抹掉自评后总分必须变化（自评席是一席）');
});

test('追加·判别性反例：企业确认分不同 ⇒ 两支「同分」队伍的总分必须分开', () => {
  const state = fresh();
  state.enterpriseConfirmations = state.enterpriseConfirmations.map((c) => (
    c.teamId === 't_beta' ? { ...c, rawScore: 60 } : c
  ));
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assert.notEqual(ta.total, tb.total, '企业确认分不同 ⇒ 总分必须不同（不能只看评委席）');
});

test('追加·浏览器可加载性：适配器与领域层不得依赖 Node 内置模块（否则浏览器跑不起来）', () => {
  const platformDir = join(here, '..');
  const files = [
    join(platformDir, 'web', 'api.demo.js'),
    ...['registration', 'solvability', 'scoring', 'enterprise-seat', 'self-eval', 'ranking',
      'points', 'tier', 'behavior', 'visibility', 'util']
      .map((f) => join(platformDir, 'src', 'domain', `${f}.js`)),
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((x) => x[1]);
    for (const spec of specs) {
      assert.ok(!spec.startsWith('node:'), `${f} 不得 import Node 内置模块：${spec}`);
      assert.ok(spec.startsWith('.'), `${f} 的 import 必须是相对路径（浏览器要能直接加载）：${spec}`);
    }
  }
});

test('追加·演示适配器与真实适配器接口形状一致（同名单方法）', async () => {
  const demo = await import('../web/api.demo.js');
  const real = await import('../web/api.js');
  for (const k of ['get', 'post', 'patch', 'del', 'subscribe']) {
    assert.equal(typeof demo.api[k], 'function', `演示适配器缺 ${k}`);
    assert.equal(typeof real.api[k], 'function', `真实适配器缺 ${k}`);
  }
  assert.equal(typeof demo.createDemoApi, 'function', '必须能显式注入 seed / rules（测试与离线用）');
});

test('追加·演示数据落在 localStorage 里，重新打开浏览器能读回（不跨人共享但要能续上）', async () => {
  const storage = makeStorage();
  const api1 = createDemoApi({ storage, seed, rules });
  await api1.post('/api/auth/login', { name: '演示管理员' });
  assert.ok(storage.getItem('hks_demo_store_v1'), '登录后必须落盘');

  const api2 = createDemoApi({ storage, seed, rules });
  const me = await api2.get('/api/me');
  assert.equal(me.user.name, '演示管理员', '重新打开后仍应是已登录状态');
});

test('追加·名次积分按 rules/points.json 发放（第一/二/三名 = 10/8/5）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const pts = new Map(out.points.map((p) => [p.teamId, p.points]));
  assert.equal(pts.get('t_alpha'), rules.points.stagePoints[0], '第 1 名拿第一档积分');
  assert.equal(pts.get('t_beta'), rules.points.stagePoints[1], '第 2 名拿第二档积分');
  assert.equal(pts.get('t_gamma'), 0, '第 5 名没有名次积分');
});

test('追加·buildDemoState 必须是深拷贝：适配器的写路径不得改到调用方的种子对象', async () => {
  const src = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const before = JSON.stringify(src);
  const state = buildDemoState(src);
  // 写路径：打分 / 组队 / 报名
  state.reviews.j_lenient.t_alpha.innovation = 1;
  state.teams.push({ id: 't_new', name: '新队', packageId: 'tp_retail', memberIds: [] });
  state.registrations.push({ id: 'reg_x' });
  assert.equal(JSON.stringify(src), before, '适配器的写路径把调用方的种子对象改了 ⇒ 同一份种子会算出不同结果');
  // 再建一次状态，必须与原始种子逐字相同
  const again = buildDemoState(src);
  assert.equal(again.reviews.j_lenient.t_alpha.innovation, 88, '新状态必须来自未被污染的种子');
});
```

`platform/test/demo-parity.test.js`：

```javascript
// platform/test/demo-parity.test.js —— 演示版（浏览器内跑的引擎）与正式引擎的**逐字段一致性**
//
// 本 Task 的灵魂：演示版 = 静态站 + 浏览器内跑【同一套规则引擎】。
// ⇒ 这份测试是那个承诺的机器保证：同一份种子、同一份规则配置，
//    「浏览器里跑的引擎」与「Node 里跑的引擎」必须给出【同一份结果】。
//
// ⚠️ 三方比对（不是两方）：
//    ① 浏览器入口（getDemoRuntime：fetch 取种子与规则 → createDemoApi → POST /compute）
//    ② Node 侧适配器路径（runDemoCompute）
//    ③ 正式引擎（直接调 src/domain/scoring.js 的 scoreStage）
//    ①②③ 必须逐字段一致 —— 只比 ①② 是自证（同一个函数比同一个函数），
//    只比 ②③ 会漏掉「浏览器加载的配置不是同一份」这类漂移。
//
// ⚠️ 浮点比较：容差 EPS = 1e-9（**相对**容差：|a-b| ≤ eps × max(1,|a|,|b|)）。
//    ⛔ 不用 === 比浮点（那是假红：同一份公式在不同求值顺序下的末位差异不是 bug）；
//    ⛔ 也不用粗到没意义的容差（1e-6 以上会把「权重写错 0.001」这类真错放过去）。
//    1e-9 相对容差 ≈ 分值 80 分上 8e-8 —— 远小于任何真实的口径差异，
//    但远大于 IEEE754 双精度的舍入噪声。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { scoreStage } from '../src/domain/scoring.js';
import {
  buildDemoState, expandSubmissions, demoTeamsRoster, runDemoCompute,
  demoSelfEvalFlags, demoTier, getDemoRuntime, DEMO_RULE_FILES,
} from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const webDir = join(platformDir, 'web');
const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(platformDir, 'rules'));

const EPS = 1e-9;   // 相对容差，见文件头说明

// ── 容差比较工具 ────────────────────────────────────────────────

function assertClose(actual, expected, path) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= EPS * scale,
    `${path}：${actual} 与 ${expected} 的差 ${Math.abs(actual - expected)} 超过容差 ${EPS * scale}`,
  );
}

/** 递归比对：数字用容差，其余（字符串 / 布尔 / null / 数组结构 / 对象键集）必须逐字相同 */
function assertDeepClose(actual, expected, path = '$') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assertClose(actual, expected, path);
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && Array.isArray(expected), `${path}：一边是数组一边不是`);
    assert.equal(actual.length, expected.length, `${path}：数组长度不同`);
    for (let i = 0; i < actual.length; i += 1) assertDeepClose(actual[i], expected[i], `${path}[${i}]`);
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const ka = Object.keys(actual).sort();
    const ke = Object.keys(expected).sort();
    assert.deepEqual(ka, ke, `${path}：对象的键集不同`);
    for (const k of ka) assertDeepClose(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  assert.deepEqual(actual, expected, `${path}：值不同`);
}

// ── 浏览器侧「规则加载」的 Node 等价物（复刻 web/api.demo.js 的 loadDemoRules）──
// ⚠️ 这段复刻必须与 web/api.demo.js 的 loadDemoRules **逐字同形**（文件清单 + 分组方式），
//    否则「浏览器加载的配置」与「正式系统加载的配置」会悄悄漂移 —— 那正是本测试要抓的东西。
function loadRulesLikeBrowser() {
  const loaded = {};
  for (const [key, file] of Object.entries(DEMO_RULE_FILES)) {
    loaded[key] = JSON.parse(readFileSync(join(platformDir, 'rules', file), 'utf8'));
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

/** fetch 桩：把浏览器里对静态产物的相对 URL 请求，落到磁盘上的真实文件 */
function installFetchStub(roots) {
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^\.\//, '');
    for (const root of roots) {
      const p = join(root, rel);
      if (existsSync(p)) {
        const body = readFileSync(p, 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** 正式引擎的直调口径（与 src/services/compute.js 同一形状） */
function directEngine(state) {
  return scoreStage({
    config: rules.scoring.final,
    judges: seed.judges.map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(state),
    enterpriseConfirmations: seed.enterpriseConfirmations,
    peerReviews: seed.peerReviews,
    teams: demoTeamsRoster(state),
    selfReviews: seed.selfReviews,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 1. 规则配置同源：浏览器加载的 12 份配置 ≡ 正式系统 loadRules 加载的同一批文件
// ═══════════════════════════════════════════════════════════════════════
test('规则配置同源：浏览器侧的 12 份配置与正式系统 loadRules 的结果逐字相同', () => {
  const browserRules = loadRulesLikeBrowser();
  for (const key of Object.keys(browserRules)) {
    assert.deepEqual(browserRules[key], rules[key], `规则 ${key} 在浏览器侧与正式系统不一致`);
  }
  // ⚠️ 正式系统还会加载 schedule / compliance / audit 三份（服务端专用，演示版用不到）——
  //    它们【不得】影响演示口径，但也不能被浏览器侧悄悄换掉。
  assert.ok(rules.schedule && rules.compliance && rules.audit, '正式系统的三份服务端配置必须存在');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 浏览器入口真跑：getDemoRuntime() → fetch 取种子与规则 → POST /compute
// ═══════════════════════════════════════════════════════════════════════
test('浏览器入口路径可跑通：fetch 取种子与规则 → 计算 → 拿到结果', async () => {
  installFetchStub([webDir, platformDir]);
  const runtime = await getDemoRuntime();
  const health = await runtime.get('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.demo, true);
  assert.equal(health.ruleVersion, rules.tiebreak.version, '健康检查里的规则版本必须与正式规则一致');

  const out = await runtime.post('/api/stages/stage_final/compute', {});
  assert.ok(out.computationId);
  assert.ok(out.teams.length > 0);
  assert.ok(out.trace.normalization);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. 三方逐字段一致（浮点用容差）
// ═══════════════════════════════════════════════════════════════════════
test('演示版与正式引擎逐字一致：同一输入 → 同一 teams / warnings / trace', () => {
  const state = buildDemoState(seed);

  // 正式引擎：直接调 domain/scoring.js
  const direct = directEngine(state);

  // 演示版：走完整适配器
  const demo = runDemoCompute({ state: buildDemoState(seed), rules, stageId: 'stage_final' });

  assertDeepClose(demo.teams, direct.teams, '$.teams');
  assert.deepEqual(demo.warnings, direct.warnings, '告警必须逐条一致');
  assertDeepClose(demo.trace, direct.trace, '$.trace');
});

test('浏览器入口算出的结果 ≡ 正式引擎算出的结果（浮点容差 1e-9 相对）', async () => {
  installFetchStub([webDir, platformDir]);
  const runtime = await getDemoRuntime();
  const browser = await runtime.post('/api/stages/stage_final/compute', {});

  const direct = directEngine(buildDemoState(seed));
  const node = runDemoCompute({ state: buildDemoState(seed), rules, stageId: 'stage_final' });

  assertDeepClose(browser.teams, direct.teams, '$.teams');
  assert.deepEqual(browser.warnings, direct.warnings, '告警必须逐条一致');
  assertDeepClose(browser.trace, direct.trace, '$.trace');
  assertDeepClose(browser.ordered, node.ordered, '$.ordered');
  assertDeepClose(browser.chain, node.chain, '$.chain');
  assertDeepClose(browser.points, node.points, '$.points');
  assertDeepClose(browser.selfEvalFlags, node.selfEvalFlags, '$.selfEvalFlags');
});

test('破同分链、名次积分、自评差异、段位在浏览器入口与正式系统之间也一致', async () => {
  installFetchStub([webDir, platformDir]);
  const runtime = await getDemoRuntime();
  const browser = await runtime.post('/api/stages/stage_final/compute', {});
  const state = buildDemoState(seed);

  // 自评差异：演示版自己算的那份，必须与引擎内部 detection 的口径一致
  const flags = demoSelfEvalFlags({ state, threshold: 10 });
  const browserFlags = browser.selfEvalFlags;
  assertDeepClose(browserFlags, flags, '$.selfEvalFlags');

  // 段位：适配器算的必须与领域层 computeTier 直算一致
  for (const t of seed.teams) {
    const viaAdapter = demoTier({ state, rules, teamId: t.id });
    assert.equal(viaAdapter.tier, seed.expectations.tiers[t.id], `${t.id} 的段位与 expectations 不一致`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 4. 判别性反例：parity 断言必须**能失败**（否则是恒真断言）
// ═══════════════════════════════════════════════════════════════════════
test('判别性反例：喂不同的输入 ⇒ 演示版与正式引擎的结果必须不同（parity 断言不是恒真）', () => {
  const broken = buildDemoState(seed);
  // 故意抹掉自评：正式引擎吃 selfReviews，演示适配器不吃 ⇒ 两边必须分叉
  broken.selfReviews = [];

  const direct = directEngine(buildDemoState(seed));
  const demo = runDemoCompute({ state: broken, rules, stageId: 'stage_final' });

  const sum = (out) => out.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.notDeepEqual(sum(demo), sum(direct),
    '喂不同的输入却算出同样的结果 ⇒ parity 断言是恒真的，没有判别力');
});

test('判别性反例：同一份输入下，改「演示适配器的输入构造」必然让结果分叉', () => {
  const state = buildDemoState(seed);
  // 名册口径错（把自由命题队说成企业命题队）⇒ R4 不再触发 ⇒ 结果必然不同
  const badRoster = demoTeamsRoster(state).map((t) => (
    t.teamId === seed.expectations.freeBriefTeam ? { ...t, isFreeBrief: false } : t
  ));
  const direct = scoreStage({
    config: rules.scoring.final,
    judges: seed.judges.map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(state),
    enterpriseConfirmations: seed.enterpriseConfirmations,
    peerReviews: seed.peerReviews,
    teams: badRoster,
    selfReviews: seed.selfReviews,
  });
  const good = directEngine(state);
  assert.notDeepEqual(
    direct.teams.map((t) => t.total),
    good.teams.map((t) => t.total),
    '名册口径变了结果却一样 ⇒ 引擎对 R4 不敏感（分支没被触发）',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 5. 黄金值：种子的 expectations 就是这套引擎的期望输出
// ═══════════════════════════════════════════════════════════════════════
test('黄金值：expectations 里声明的每一条分支都在引擎输出里兑现（浮点用容差）', () => {
  const e = seed.expectations;
  const state = buildDemoState(seed);
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const byCode = (code) => out.warnings.filter((w) => w.code === code);

  // 同分两队：总分严格相等（构造保证）
  const [a, b] = e.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assertClose(ta.total, tb.total, `$.teams[${a}].total`);

  // 破同分链在 peer 级分开
  const peer = out.chain.find((c) => c.key === e.tiebreakSeparatedBy);
  assert.ok(peer, `破同分链里必须用到 ${e.tiebreakSeparatedBy}`);
  assert.ok(peer.usedBy.includes(a) && peer.usedBy.includes(b));

  // 归一化降级
  const fb = byCode('normalization_fallback').find((w) => w.dimension === e.unnormalizedDimension);
  assert.ok(fb, `必须出现维度 ${e.unnormalizedDimension} 的归一化降级告警`);
  assert.equal(out.trace.normalization[e.unnormalizedDimension].normalized, false);

  // R2：缺双签 ⇒ 企业席按 0 分计
  const r2 = byCode('R2_missing_dual_signature').find((w) => w.teamId === e.missingDualSignatureTeam);
  assert.ok(r2, '必须出现 R2 告警');
  assertClose(out.teams.find((t) => t.teamId === e.missingDualSignatureTeam).seatE, 0, '$.seatE');

  // R4：自由命题 ⇒ 企业项由评委维度替代
  const r4 = byCode('R4_free_brief_judge_scored').find((w) => w.teamId === e.freeBriefTeam);
  assert.ok(r4, '必须出现 R4 告警');
  const epsRow = out.teams.find((t) => t.teamId === e.freeBriefTeam);
  const subDim = rules.scoring.final.freeBrief.judgeDimension;
  assertClose(epsRow.seatE, epsRow.perDimension[subDim].mean, `$.teams[${e.freeBriefTeam}].seatE`);

  // 自评三档
  const hi = demoSelfEvalFlags({ state, threshold: 10 }).find((f) => f.teamId === e.selfEvalWrittenExplanationTeam);
  const lo = demoSelfEvalFlags({ state, threshold: 10 }).find((f) => f.teamId === e.selfEvalJudgeQuestionTeam);
  assert.equal(hi.action, 'written_explanation');
  assert.ok(hi.d > 10);
  assert.equal(lo.action, 'judge_question');
  assert.ok(lo.d < -10);

  // 段位
  for (const [teamId, tier] of Object.entries(e.tiers)) {
    assert.equal(demoTier({ state, rules, teamId }).tier, tier, `${teamId} 的段位应为 ${tier}`);
  }

  // 行为分（整数值 ⇒ 精确比较）
  for (const [teamId, expected] of Object.entries(e.behaviorScores)) {
    const info = demoTier({ state, rules, teamId });
    assert.equal(info.behavior.total, expected, `${teamId} 的行为分应为 ${expected}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 6. 浏览器入口的失败路径：取不到种子 / 缺规则必须【显式报错】，不静默退回空数据
//    （静默降级 = 演示时看到一份空榜单却不知道为什么）
// ═══════════════════════════════════════════════════════════════════════
test('浏览器入口：种子取不到必须显式报错', async () => {
  installFetchStub([webDir, platformDir]);
  const { loadDemoSeed } = await import('../web/api.demo.js');
  await assert.rejects(() => loadDemoSeed('./seed/not-exist.json'), /演示种子数据加载失败/);
});

test('浏览器入口：规则缺任何一份都必须显式报错（不静默用默认规则）', async () => {
  const { loadDemoRules } = await import('../web/api.demo.js');
  // 只挂 web/ 目录 ⇒ web/rules/ 不存在 ⇒ 12 份规则全部取不到
  installFetchStub([webDir]);
  await assert.rejects(() => loadDemoRules('./rules/'), /演示规则配置缺失/);
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
//
// ⚠️【领域层源码会不会泄到正式站？】—— 这是【两条不同的路】，互不影响：
//    ① 后端那条 Demo 门（src/server.js）：DEMO_MODE=1 才把 /src/domain/* 与 /rules/* 挂上 HTTP。
//       正式部署（systemd + nginx）必须保持 DEMO_MODE 关 ⇒ 领域层源码在正式站一律 404。
//    ② 静态站这条：演示站把领域层【原样拷进产物目录】（浏览器要 import 它才能跑引擎）。
//       演示站是【独立产物】，不与正式部署共用 nginx / systemd ⇒ 领域层源码只出现在演示站。
//    ⇒ 演示站公开领域层源码是【有意的】（观众能看到算法原文，这正是演示的价值），
//       但它【不会】出现在正式站上。两条路的开关互不干涉。
//
// ⚠️ 接口形状必须与 web/api.js（真实后端）一致 —— 否则前端要写两套。
//    本文件每个端点的返回形状都对齐 src/services/* 的对应服务：
//      /api/leaderboard/:stageId  → src/services/leaderboard.js（rank / business / personal 三种口径）
//      /api/leaderboard/rolling   → src/services/leaderboard.js getRollingLeaderboard
//      /api/leaderboard/tier      → src/services/tier.js getTierBoard
//      /api/teams/:id/tier        → src/services/tier.js getTeamTier
//      /api/teams/:id/performance-card → src/services/performance-card.js getPerformanceCard
import { scoreRegistration, classifyLevel, validateRegistrationAnswers } from '../src/domain/registration.js';
import { scoreSolvability } from '../src/domain/solvability.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';
import { detectSelfEvalDiff } from '../src/domain/self-eval.js';
import { rankTeams } from '../src/domain/ranking.js';
import { computeStagePoints, computePersonalPoints } from '../src/domain/points.js';
import { computeTier, classifyDepartment, isDataOrPrototypeMilestone } from '../src/domain/tier.js';
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

/** 确定性比较：普通字典序（⛔ 不用 localeCompare —— 它依赖 locale 与 ICU 版本，跨机器可能不同） */
function cmpStr(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

// ── 状态 ────────────────────────────────────────────────────────

/**
 * 深拷贝种子。
 * ⚠️ 为什么要拷贝：适配器有写路径（报名 / 组队 / 打分 / 计算），
 *    如果 state 直接持有调用方传进来的种子对象的引用，写一次就把种子本身改了 ——
 *    调用方（测试、浏览器端的 getDemoRuntime）手里的种子会跟着漂移，
 *    「同一份种子算出同一份结果」这条前提当场失效。
 *    种子是 JSON ⇒ 用 JSON 往返做深拷贝（零依赖、浏览器与 Node 行为一致）。
 */
function deepCopy(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function buildDemoState(seed) {
  return {
    meta: deepCopy(seed?.meta) ?? {},
    edition: deepCopy(seed?.edition) ?? {},
    users: deepCopy(seed?.users) ?? [],
    taskPackages: deepCopy(seed?.taskPackages) ?? [],
    judges: deepCopy(seed?.judges) ?? [],
    teams: deepCopy(seed?.teams) ?? [],
    reviews: deepCopy(seed?.reviews) ?? {},
    enterpriseConfirmations: deepCopy(seed?.enterpriseConfirmations) ?? [],
    peerReviews: deepCopy(seed?.peerReviews) ?? [],
    selfReviews: deepCopy(seed?.selfReviews) ?? [],
    milestones: deepCopy(seed?.milestones) ?? [],
    signoffs: deepCopy(seed?.signoffs) ?? [],
    behaviorEvents: deepCopy(seed?.behaviorEvents) ?? [],
    registrations: [],
    computations: {},
    results: {},
    me: null,
  };
}

/**
 * 把「评委 → 队伍 → 维度 → 原始分」的嵌套打分矩阵摊平成 submissions。
 * ⚠️ 形状必须与真实写入方（src/services/review.js 落 stage_reviews 的形状）一致：
 *    { judgeId, teamId, dimension, rawScore } —— 少一个字段，正式引擎会当成缺分。
 */
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

  // 企业席单独跑一遍（拿 seatE 明细，供破同分链的 enterprise_raw 用）。
  // ⚠️ 这是**纯函数**的重复调用，只为拿到明细供展示；计分与告警一律以 scoreStage 的返回为准
  //    （scoreStage 内部已经调过一次 applyEnterpriseRules 并把 ent.warnings 并进 warnings ——
  //    这里【不得】再把 enterprise.warnings 加一遍，否则同一条告警会出现两次）。
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
    // ⚠️ warnings = 【计算告警】（scoreStage 的返回），与正式引擎逐条一致 ⇒ parity 断言的对象。
    //    破同分链自己的告警（tiebreak_key_unusable 等）单列 tiebreakWarnings ——
    //    榜单层再按正式口径（src/services/leaderboard.js collectWarnings）合并并打 source 标签。
    warnings: scored.warnings,
    tiebreakWarnings: ranked.warnings ?? [],
    trace: scored.trace,
    enterprise: { seatE: enterprise.seatE, weights: enterprise.weights },
    ordered: ranked.ordered,
    chain: ranked.applied,
    candidates,
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
      // ⚠️ isDataOrPrototype 由【规则】判定，不采信数据里预置的标志：
      //    真实系统在 src/services/tier.js 里按 rules.criteria.tier 推导 ——
      //    演示版必须同源，否则「数据里的标志写错」时演示段位与正式段位会漂移。
      isDataOrPrototype: isDataOrPrototypeMilestone(m.key, rules.criteria),
    }));
  const signoffs = (state.signoffs ?? [])
    .filter((s) => s.teamId === teamId)
    .map((s) => ({
      milestoneKey: s.milestoneKey,
      department: s.department,
      revokedAt: s.revokedAt ?? null,
      // ⚠️ 同上：部门归类按 rules.criteria.tier 的关键词判定（与正式系统同源）。
      isBusinessDepartment: classifyDepartment(s.department, rules.criteria) === 'business',
    }));
  const tier = computeTier({ milestones, signoffs, ranksConfig: rules.ranks });
  const behavior = behaviorScore({
    events: (state.behaviorEvents ?? []).filter((e) => e.teamId === teamId),
    behaviorConfig: rules.behavior,
  });
  const team = (state.teams ?? []).find((t) => t.id === teamId) ?? {};
  return {
    ...tier,
    teamId,
    teamName: team.name ?? teamId,
    behavior,
    progress: {
      milestones: (rules.milestones?.items ?? []).map((def) => ({ key: def.key, label: def.label })),
      milestoneCount: tier.milestoneCount,
    },
  };
}

export function demoPerformanceCard({ state, rules, teamId }) {
  const tierInfo = demoTier({ state, rules, teamId });
  const team = (state.teams ?? []).find((t) => t.id === teamId) ?? {};
  const items = (rules.milestones?.items ?? []).map((def) => {
    const m = (state.milestones ?? []).find((x) => x.teamId === teamId && x.key === def.key);
    // ⚠️ 撤销的签字不算「已签」（与正式系统 src/services/performance-card.js 同一口径）
    const signoff = (state.signoffs ?? []).find(
      (s) => s.teamId === teamId && s.milestoneKey === def.key && !s.revokedAt,
    );
    return {
      key: def.key,
      label: def.label,
      confirmedBy: def.confirmedBy,
      achieved: m?.achieved === true,
      signed: Boolean(signoff),
      countsTowardTier: def.countsTowardTier !== false,
      // ⛔ 只给部门，不给签字人：S10 §0.3「B 榜签字人不公开」
      signedByDepartment: signoff ? signoff.department : null,
      revoked: Boolean(signoff?.revokedAt),
    };
  });
  return {
    teamId,
    teamName: team.name ?? teamId,
    taskPackageId: team.packageId ?? null,
    tier: tierInfo.tier,
    milestoneCount: tierInfo.milestoneCount,
    businessSignoffCount: tierInfo.businessSignoffCount,
    items,
    achievedCount: items.filter((i) => i.achieved).length,
    total: items.length,
    benefits: tierInfo.benefits ?? [],
    neverUnlocks: tierInfo.neverUnlocks ?? [],
    behavior: tierInfo.behavior,
  };
}

/** 榜单告警：计算告警 + 破同分告警，按正式口径打 source 标签 */
function collectDemoWarnings(result) {
  const out = [];
  for (const w of result?.warnings ?? []) out.push({ source: 'computation', ...w });
  for (const w of result?.tiebreakWarnings ?? []) out.push({ source: 'tiebreak', ...w });
  return out;
}

export function demoLeaderboard({ state, rules, scope = 'rank', viewer = null }) {
  if (scope === 'tier') return demoTierBoard({ state, rules, viewer });
  if (scope === 'rolling') return demoRollingLeaderboard({ state, rules, viewer });

  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (!result) return { scope, rows: [], warnings: [], demo: true, empty: true };
  const warnings = collectDemoWarnings(result);

  // B 榜（商业战绩）：里程碑进度公开，评分与签字人不公开
  if (scope === 'business') {
    const rows = (state.teams ?? []).map((t) => {
      const items = (rules.milestones?.items ?? []).map((def) => {
        const m = (state.milestones ?? []).find((x) => x.teamId === t.id && x.key === def.key);
        const signed = (state.signoffs ?? []).some(
          (s) => s.teamId === t.id && s.milestoneKey === def.key && !s.revokedAt,
        );
        return { key: def.key, label: def.label, achieved: signed, signed };
      });
      return {
        teamId: t.id,
        teamName: t.name ?? t.id,
        taskPackageId: t.packageId ?? null,
        milestones: items,
        achievedCount: items.filter((i) => i.signed).length,
        milestoneCount: items.length,
      };
    });
    return applyVisibility({
      payload: { scope, rows, warnings, demo: true },
      viewer,
      visibilityConfig: rules.visibility,
      context: { scope, viewerTeamId: viewer?.teamId ?? null },
    });
  }

  // 个人榜：终生上榜
  if (scope === 'personal') {
    const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
    const ledger = [];
    for (const t of state.teams ?? []) {
      const pts = pointsByTeam.get(t.id) ?? 0;
      for (const uid of t.memberIds ?? []) {
        ledger.push({ userId: uid, kind: 'stage_rank', points: pts });
      }
    }
    const personal = computePersonalPoints({ ledger, pointsConfig: rules.points });
    const nameOf = (uid) => (state.users ?? []).find((u) => u.id === uid)?.name ?? null;
    const rows = personal.rows.map((r) => ({ ...r, name: nameOf(r.userId) }));
    return applyVisibility({
      payload: { scope, rows, warnings, demo: true },
      viewer,
      visibilityConfig: rules.visibility,
      context: { scope, viewerTeamId: viewer?.teamId ?? null },
    });
  }

  // A 榜（赛段名次）
  const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
  const packageRank = demoPackageRanks({ state, result, rules });
  const rows = result.ordered.map((row) => {
    const team = (state.teams ?? []).find((t) => t.id === row.teamId) ?? {};
    const tier = demoTier({ state, rules, teamId: row.teamId });
    return {
      teamId: row.teamId,
      teamName: team.name ?? row.teamId,
      taskPackageId: team.packageId ?? null,
      rank: row.rank,
      tiedWith: row.tiedWith ?? [],
      packageRank: packageRank.get(row.teamId) ?? null,
      points: pointsByTeam.get(row.teamId) ?? 0,
      total: row.total,
      tier: tier.tier,
      enterpriseName: null,   // ⛔ 企业名不公示（S10 §8）
    };
  });
  // 可见性在【这一层】过滤（与服务端同一套规则）：
  //   rank 榜全员公开但不含企业名与互评来源；business 榜不含评分与签字人。
  // ⚠️ 段位榜（scope='tier'）另走 applyVisibility 的 tier 分支：C 段及以上公示，D 段只给本人进度卡。
  return applyVisibility({
    payload: { scope, rows, warnings, demo: true },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope, viewerTeamId: viewer?.teamId ?? null },
  });
}

/** 包内名次（正式系统 src/services/leaderboard.js buildStageRanking 里同一口径：任务包内全量战队排名） */
function demoPackageRanks({ state, result, rules }) {
  const out = new Map();
  const pkgOf = new Map((state.teams ?? []).map((t) => [t.id, t.packageId ?? null]));
  const groups = new Map();
  for (const c of result.candidates ?? []) {
    const key = pkgOf.get(c.teamId) ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [, list] of groups) {
    const ranked = rankTeams({
      teams: list,
      tiebreakChain: rules.tiebreak.chain,
      tiebreakData: { isFinal: true, byTeam: {} },
      pointsConfig: rules.points,
    });
    for (const o of ranked.ordered) out.set(o.teamId, o.rank);
  }
  return out;
}

/**
 * 段位榜（C-02）：C 段及以上公示队名与名次；D 段只给本人进度卡。
 * ⚠️ 排序口径与 src/services/tier.js getTierBoard 一致：段位高 → 里程碑多 → 队伍编号（确定性兜底）。
 */
export function demoTierBoard({ state, rules, viewer = null }) {
  const order = (rules.ranks?.tiers ?? []).map((t) => t.key);
  const rows = (state.teams ?? []).map((t) => {
    const info = demoTier({ state, rules, teamId: t.id });
    return {
      teamId: t.id,
      teamName: t.name ?? t.id,
      tier: info.tier,
      tierRank: null,
      milestoneCount: info.milestoneCount,
      progress: {
        milestones: (rules.milestones?.items ?? []).map((def) => ({ key: def.key, label: def.label })),
        milestoneCount: info.milestoneCount,
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
    payload: { scope: 'tier', rows, warnings: [], demo: true },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope: 'tier', viewerTeamId: viewer?.teamId ?? null, tierOrder: order },
  });
}

/** 滚动总榜（全程公开） */
export function demoRollingLeaderboard({ state, rules, viewer = null }) {
  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (!result) return { scope: 'rolling', rows: [], warnings: [], demo: true, empty: true };
  const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
  const rankByTeam = new Map((result.ordered ?? []).map((r) => [r.teamId, r.rank]));
  const rows = (state.teams ?? []).map((t) => ({
    teamId: t.id,
    teamName: t.name ?? t.id,
    taskPackageId: t.packageId ?? null,
    points: pointsByTeam.get(t.id) ?? 0,
    stages: 1,
    bestRank: rankByTeam.get(t.id) ?? null,
    tier: demoTier({ state, rules, teamId: t.id }).tier,
  })).sort((a, b) => b.points - a.points
    || (a.bestRank ?? 99) - (b.bestRank ?? 99)
    || cmpStr(a.teamId, b.teamId));
  return applyVisibility({
    payload: { scope: 'rolling', rows, warnings: collectDemoWarnings(result), demo: true },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope: 'rolling', viewerTeamId: viewer?.teamId ?? null },
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

/** 默认组长：成员里第一位 MBA 在籍者（⛔ 不用登录用户 —— 演示登录用户不在 users 表里） */
function defaultCaptainId({ state, memberIds, me }) {
  const mba = (state.users ?? []).find(
    (u) => u.mbaStatus === 'mba' && (memberIds ?? []).includes(u.id),
  );
  return mba?.id ?? me?.id ?? null;
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
    // ⛔ 旧结构/半截结构（浏览器里手工改过、或旧版本留下的）不能直接把适配器打挂 ——
    //    缺哪个容器补哪个容器。
    if (!state.computations || typeof state.computations !== 'object') state.computations = {};
    if (!state.results || typeof state.results !== 'object') state.results = {};
    if (!Array.isArray(state.registrations)) state.registrations = [];
    if (!state.reviews || typeof state.reviews !== 'object') state.reviews = {};
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
      const memberIds = body?.memberIds ?? [];
      const team = {
        id: `team_demo_${(s.teams ?? []).length + 1}`,
        name: body?.name ?? '演示战队',
        packageId: body?.taskPackageId ?? null,
        captainId: body?.captainId ?? defaultCaptainId({ state: s, memberIds, me: s.me }),
        memberIds,
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
    // ⚠️ 顺序要紧：静态段 'tier' / 'rolling' 必须排在 '/api/leaderboard/:stageId' 之前，
    //    否则段位榜会拿到赛段榜的形状（前端渲染成空段位列）。
    //    这与后端 src/server.js 的路由口径一致（静态段优先于参数段），也与 P0 桩一致。
    if (method === 'GET' && clean === '/api/leaderboard/rolling') {
      return demoLeaderboard({ state: s, rules: r, scope: 'rolling', viewer: s.me });
    }
    if (method === 'GET' && clean === '/api/leaderboard/tier') {
      return demoLeaderboard({ state: s, rules: r, scope: 'tier', viewer: s.me });
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
Expected: PASS（demo-engine 27 个 + demo-parity 10 个全过）

> ⚠️ **如果 `demo-parity.test.js` 报 `teams` 不一致**，说明演示版在某处自己又算了一遍分。
> **修法**：删掉演示版里的重复计算，一律以 `scoreStage()` 的返回为准（`runDemoCompute` 里已经是这么写的）。
> **不要**在测试里放宽断言——这条断言就是"演示版与正式版算法一致"的机器保证。

- [ ] **Step 5: 提交**

```bash
cd platform && git add web/api.demo.js test/demo-engine.test.js test/demo-parity.test.js test/leaderboard-web.test.js
git commit -m "feat(P6): 演示版适配器扩展为完整流程（浏览器内真实运行规则引擎）" -- web/api.demo.js test/demo-engine.test.js test/demo-parity.test.js test/leaderboard-web.test.js
```

---

### Task 6: 演示版前端补齐 + 静态站构建与发布

**Files:**
- Create: `platform/scripts/build-demo.js`
- Create: `platform/scripts/serve-demo.js`
- Modify: `platform/web/index.html`（资源路径改相对路径 + 演示版横幅）
- Modify: `platform/web/app.js`（演示模式数据加载 + 演示路由）
- Modify: `platform/src/server.js`（**仅在 `DEMO_MODE=1` 时**挂载 `/src/domain/*` 与 `/rules/*`，供开发服务器的演示模式；**默认不挂** —— 生产部署下这两个路径一律 404，见 I-5 修正记录）
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

- [ ] **Step 7: 修改 `src/server.js`（挂载领域层与规则配置，供开发服务器的演示模式）**

在 `src/server.js` 的 **`handleRequest()`** 里（**不是 `handle()`** —— `handle()` 是外层兜底），
找到下面这段**原文**（P0 评审修正的静态分支，**整段保留 try/catch**）：

```javascript
    // ⛔ 评审修正（Important）：静态分支原来在 try/catch **之外** ——
    //    serveStatic 抛出的任何异常都会逸出 handle → 进程死亡。
    //    现在它在自己的 try 里；异常一律回 404，不影响进程。
    if (req.method === 'GET') {
      try {
        if (serveStatic(webDir, req, res)) return;
      } catch (err) {
        console.error('[server] 静态服务异常', err);
      }
    }
```

在 `if (serveStatic(webDir, req, res)) return;` **之后**、`} catch (err) {` **之前**
**插入** 3 行（2 行注释 + 1 行代码，**插入，不是替换；try/catch 必须原样保留**）：

```javascript
        // 演示模式（DEMO_MODE=1）：领域层与规则配置不在 web/ 下，挂出去。
        // ⚠️ serveStatic 的签名不变（webDir, req, res）——这里只换 webDir，不改它。
        if (serveMounted(req, res)) return;
```

插入后该段应是：

```javascript
    // ⛔ 评审修正（Important）：静态分支原来在 try/catch **之外** ——
    //    serveStatic 抛出的任何异常都会逸出 handle → 进程死亡。
    //    现在它在自己的 try 里；异常一律回 404，不影响进程。
    if (req.method === 'GET') {
      try {
        if (serveStatic(webDir, req, res)) return;
        // 演示模式（DEMO_MODE=1）：领域层与规则配置不在 web/ 下，挂出去。
        // ⚠️ serveStatic 的签名不变（webDir, req, res）——这里只换 webDir，不改它。
        if (serveMounted(req, res)) return;
      } catch (err) {
        console.error('[server] 静态服务异常', err);
      }
    }
    error(res, 404, 'NOT_FOUND', '页面不存在');
```

并在文件顶部加：

```javascript
// 演示模式的静态挂载：/src/domain/* 与 /rules/* 在 platform/ 下，不在 web/ 下。
// ⛔ 只读、只挂这两个白名单目录，不开放整个 platform/。
//
// ⚠️⛔ **默认不挂**（2026-10-21 漂移审计修正 I-5）：
//    这两个目录里是**领域层算法源码**（打分 / 破同分 / 防作弊判定）与**全部规则配置**
//    （权重表、破同分链、行为分、段位表）。无条件挂载 = 公网可读全部源码与配置。
//    本阶段正是「部署到公网 + nginx + systemd」的阶段，所以这道门必须有。
//    只有显式设了 DEMO_MODE=1 才挂；deploy/ 里的 systemd 与 docker-compose
//    **不得**设 DEMO_MODE=1（生产部署下这两个路径一律 404）。
const DEMO_MOUNTS = process.env.DEMO_MODE === '1' ? [
  { prefix: '/src/domain/', dir: join(here, '..', 'src', 'domain') },
  { prefix: '/rules/', dir: join(here, '..', 'rules') },
] : [];

function serveMounted(req, res) {
  if (!DEMO_MOUNTS.length) return false;
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

> **【2026-10-21 漂移审计修正 I-1 + I-5 + M-6】**
> **原来错在哪（一处 I-1、一处 I-5、一处 M-6）**：
> ① **I-1**：原指令是「把静态托管那段**替换**为」一段**没有 try/catch** 的代码：
> ```javascript
> if (req.method === 'GET') {
>   if (serveStatic(webDir, req, res)) return;
>   if (serveMounted(req, res)) return;
> }
> ```
> ② **I-5**：原文的 `DEMO_MOUNTS` 是**无条件**的常量数组，调用处 `if (serveMounted(req, res)) return;`
> **也没有任何条件判断** —— 注释与 Files 清单都说「供开发服务器的演示模式（`?demo=1`）」，
> 但**代码里根本没有 `?demo=1` 的判断**（审计 grep：`demo=1` 只出现在注释与
> `web/app.js` 的前端适配器选择里，`serveMounted` 内部无门）。
> ③ **M-6**：定位词写成 `handle()`，实际在 `handleRequest()`。
> **为什么错**：
> - **I-1**：P0 终审的评审修正把静态分支放进**自己的 try**（`serveStatic` 抛出的任何异常
>   都不能逸出 `handle` → 否则进程死亡）。替换文本没有 try/catch → 静态服务抛错
>   （TOCTOU 竞态、权限错误）时，P0 行为是「记日志 + 回 404」，
>   改后变成「冒泡到 `handle()` 外层兜底 → 回 **500 INTERNAL**」→ **404 静默变 500**。
>   **审计实跑：按原片段替换后跑全量 → 151/151 全绿，两个基线都拦不住** ——
>   P0 那条相关用例的断言是 `assert.ok(res.status >= 400)`，**太松**，500 也满足 → **回归静默通过**。
> - **I-5**：`/src/domain/*` 与 `/rules/*` 里是**领域层算法源码**（打分 / 破同分 / 防作弊判定）
>   与**全部规则配置**（权重表、破同分链、行为分、段位表）。无条件挂载 = **公网可读全部源码与配置**；
>   而本阶段正是「部署到公网 + nginx + systemd」的阶段。
>   （`serveStatic` 的 realpath 边界仍然生效、`..` 也拦得住 —— 但**这层门本来就不该开**。）
> **改成什么**：
> - **I-1**：从「替换」改为「**在 `if (serveStatic(webDir, req, res)) return;` 之后插入**」，
>   **P0 的 try/catch 与注释逐字保留**，并给出「插入后该段应长什么样」的完整示意供实施者自检。
> - **I-5**：加门 —— `const DEMO_MOUNTS = process.env.DEMO_MODE === '1' ? [ … ] : [];`
>   （`serveMounted` 里再加一道 `if (!DEMO_MOUNTS.length) return false;` 早退），
>   并写明 `deploy/` 的 systemd 与 docker-compose **不得**设 `DEMO_MODE=1`
>   → 生产部署下这两个路径一律 404。
> - **M-6**：定位词从 `handle()` 改成 **`handleRequest()`**（`handle()` 是外层兜底，
>   `handleRequest()` 才是处理请求的那一层；写错定位词会让人在错误的函数里找锚点）。
> **依据**：基线 `platform/src/server.js:249-261`（静态分支逐字）+
> `platform/src/server.js:151-170`（`handle` 与 `handleRequest` 的关系）
> + 漂移审计报告 I-1 / I-5 / M-6。
> **连带（不在本步，但必须同步）**：本阶段的 `deploy/` 资产（systemd / nginx / docker-compose）
> **不得**设置 `DEMO_MODE=1`；`scripts/serve-demo.js`（本地预览）**应当**设置它。

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
Expected: PASS（5 个测试全过：demo-static.test.js 5）

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
| 3 | `INTERFACES.md` §1 规定 `serveStatic(webDir, req, res)` | **签名保持不变**。演示模式需要的 `/src/domain/*` 与 `/rules/*` 两个挂载点**在 `src/server.js` 里**用「换 webDir + 浅拷贝请求代理」实现，不改 `serveStatic` 本体。⚠️ **2026-10-21 漂移审计修正 I-5：这两个挂载点改为「仅在 `DEMO_MODE=1` 时」才存在** —— 原写法是**无条件**挂载（代码里根本没有注释所说的 `?demo=1` 判断），而这两个目录里是**领域层算法源码**与**全部规则配置**，本阶段又是「部署到公网」的阶段 → 公网可读全部源码与配置。现改为 `process.env.DEMO_MODE === '1'` 门禁（`serveMounted` 里另有 `if (!DEMO_MOUNTS.length) return false;` 早退），且 `deploy/` 的 systemd 与 docker-compose **不得**设 `DEMO_MODE=1`。 |
| 4 | `INTERFACES.md` §1 规定 `createApp({ db, rules, webDir })` | **签名与参数保持不变**（没有新增任何必填或可选参数）。演示模式挂载是模块级常量 + 模块级函数，与 `createApp` 无关。 |
| 5 | `INTERFACES.md` §2–§6 没有收录 P6 需要的 `src/runtime/pidfile.js` | 这是 P6 **新增**的模块（服务于「恢复前先停服务」这条约束），不与任何既有接口冲突。 |
| 6 | `INTERFACES.md` §1 的 P0 产出清单里没有 `scripts/backup.js` / `scripts/restore.js`（P6 §7 才有） | 一致，无偏差。`backupDatabase` / `restoreDatabase` / `checkServiceState` / `verifyBackupFile` 是 P6 **新增**导出，不覆盖任何既有签名。 |
| 7 | `web/api.demo.js` 里的规则加载方式 | `INTERFACES.md` 未规定前端如何取规则。P6 用「按文件名逐个 `fetch` `rules/*.json`」的方式，**不新增 `rules/index.json` 这类聚合文件**（避免与 `src/config.js` 的 `RULE_FILES` 产生第二份真相），并由 `scripts/build-demo.js` 校验所需文件齐全。 |
| 8 | **P6 的 `scripts/restore.js` 需要读 schema 版本** | `INTERFACES.md` §1 的 P0 产出清单里 `src/db/migrate.js` 只有 `applyMigrations` / `readMigrationFiles`。P6 **追加**一个导出 `currentVersion(db)`（P0 已建，本阶段只追加，**不改 `applyMigrations` 的签名与行为**），`scripts/restore.js` 改为 import 它。⚠️ **不能在 `scripts/` 里自己写 SQL** —— 全局约束「所有 SQL 收进 `src/db/repo/`」，而 `src/db/migrate.js` 是 `platform/test/sql-boundary.test.js` 守卫的**唯一豁免文件**（守卫扫描 `src/` **与 `scripts/`**）；照原写法（`db.prepare('SELECT MAX(version) …')`）**当场判违规**。见 C-5 修正记录 |
| 9 | **P4 的 `scripts/forbidden.txt` 曾有三条词条永远命中不了** | P4 的 `scanText()` 用 **`line.includes(term)` 字面串匹配**，P4 初版清单里的 `四维各 ?25%` / `初赛企业确认权重 ?20%` / `w_E ?= ?20%.*初赛` 里的 `?` 与 `.*` 在字面匹配下没有意义（等于没写）。**P4 定稿已把这几条拆成空格变体**（`四维各25%` / `四维各 25%` / `初赛企业确认权重20%` / `初赛企业确认权重 20%`），并由 P4 自己的用例断言「清单里没有正则占位写法」。P6 **不再重复改**（照本条原写法再追加一遍会触发 `parseManifest` 的「重复词条」→ 退出码 2），只追加 P6 的新词条（P6 新增的一律字面串 + 空格变体各一条）。**不改 `scanText` 的匹配语义**（P4 的行为与测试都不动）。 |

### Task 2（部署资产）本轮偏差 —— 2026-10-21 预审

> `INTERFACES.md` §7 对 P6 部署资产只规定了**文件名与职责**（`deploy/heikesong.service` /
> `nginx.conf` / `docker-compose.yml` / `install.sh`）与三条禁令（`DEMO_MODE=1`、单写者、
> 不硬编码口令），**没有规定具体内容**。因此下表记的是「本 Task 的实现 vs 计划正文原写法」的偏差，
> 以及**是否触碰 `INTERFACES.md` 的契约**。

| # | 偏差 | 是否触碰 INTERFACES.md 契约 | 处理 |
|---|---|---|---|
| T2-1 | `deploy/docker-compose.yml` 原来用 `ports: "127.0.0.1:8080:8080"`，改为 `network_mode: host`（去掉 `ports`） | ❌ 不触碰（文件名/职责不变） | `src/server.js` 实测**只绑 127.0.0.1**（`lsof`：`TCP 127.0.0.1:8080 (LISTEN)`，非回环 IP 不可达）。容器里用 `ports` 转发到容器 eth0，而进程不听那里 ⇒ 连接被拒（容器 healthy 但宿主 curl 不通）。`network_mode: host` 让「进程绑的 127.0.0.1:8080」= 宿主机的 127.0.0.1:8080，与 `nginx` 反代目标一致、也不暴露公网。**上游另一条路**：`src/server.js` 改成可绑 0.0.0.0（不在本 Task 归属内），届时可换回 `ports`。 |
| T2-2 | `deploy/install.sh` 的 Node 版本下限由 `22.5` 改为 `22.16.0` | ❌ 不触碰 | `package.json` engines 写 `>=22.16.0`；`sqlite.backup()`（P6 Task 1 的备份脚本依赖）也是 22.16.0 引入的。22.5 会装上跑不了备份的 Node。 |
| T2-3 | `deploy/heikesong.service` 的 `Documentation=` 由硬编码 `/opt/heikesong/platform/README.md` 改为 `__APP_DIR__/README.md` | ❌ 不触碰 | 违反「部署路径不硬编码」；占位符集合仍是规格声明的 `__APP_DIR__` / `__DATA_DIR__` / `__RUN_USER__`，**没有新增占位符**。 |
| T2-4 | `deploy/install.sh` 新增 `SYSTEMD_UNIT_DIR` 变量（默认 `/etc/systemd/system`） | ❌ 不触碰 | 原写法把 `/etc/systemd/system/` 写死在函数里 → 干跑（临时目录）必然写到真机。做成变量后默认值不变，行为不变。 |
| T2-5 | `deploy/install.sh` 的 `ENV_FILE` 变量原本**形同虚设**（单元里写死了 `/etc/heikesong/platform.env`），现改为 sed 替换该字面路径 | ❌ 不触碰（占位符集合不变） | 修「改了变量不生效」的静默失效。 |
| T2-6 | `deploy/install.sh` 新增 `NODE_ENV` 变量（默认 `production`）写进环境文件 | ❌ 不触碰 | 落实计划「临时调试形态」D-2：`NODE_ENV=production` 会让 Cookie 带 `Secure`，`http://` 下浏览器拒收 → 登录失效。`EnvironmentFile` 优先于 `Environment=`，所以环境文件里的值生效。 |
| T2-7 | `deploy/install.sh` 的落盘属组由「与用户名同名的组」改为**运行用户的主组**（`id -gn`） | ❌ 不触碰 | `install -d -g <用户名>` 假设存在同名组（Debian/RHEL 的 `useradd` 默认行为，但不是通用假设；macOS 主组是 `staff`，实测直接报 `unknown group`）。systemd 单元的 `Group=__RUN_USER__` 保持不变（占位符集合不变），在目标平台（Linux）两者一致。 |
| T2-8 | `deploy/nginx.conf` 增补 3 处注释（端口口径、`web/assets/` 目录现状、占位符替换说明） | ❌ 不触碰 | 只加注释，不改任何指令。 |
| T2-9 | `platform/test/deploy-assets.test.js` 由 7 个用例扩到 14 个 | ❌ 不触碰（测试文件不在 `INTERFACES.md` 契约内） | 规格的 7 个用例**逐字保留**；追加 7 个「对有效配置断言」的用例（见台账 D-11 / D-15）。 |
| T2-10 | 计划 Task 2 的 Step 8 第二条命令改为「去掉整行注释再计数」 | ❌ 不触碰 | 规格原命令在**规格自己的文件**上实测是 2（注释里写了一遍），期望值 1 与文件不符。 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

---

## Task 2 父代理预审修正台账（2026-10-21）

> 本节是 Task 2（部署资产）的预审记录：**规格缺陷清单**、处置方式、逐字回写位置、硬约束自证。
> 纪律：本计划 Task 2 的 5 个代码块 = 最终实现的**逐字副本**
> （核验脚本 `platform/test/plan-assets-match.test.js` 之外的独立核验见下「D2-13」）。

### A. 预审方法（先跑后派）

1. 把规格 Task 2 的 5 个代码块**原样抽到** `/tmp/p6-t2/spec/`（一个字节都没改）。
2. 在该副本上跑规格自带用例 → **红**（真实输出见 D2-01）。
3. 逐条定位根因 → 改实现 → 再跑 → 全绿 → 才落盘到 `platform/deploy/` 与 `platform/test/`。
4. 落盘后做：幂等干跑（连续两次执行）、YAML 解析、nginx 结构检查（含反证）、全量测试、
   发布扫描、变异测试。

### B. 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| D2-01 | **Critical** | **规格的资产文件与规格自己的验收用例互相矛盾**：systemd 单元与 compose 的**注释里**写了被禁字面量（`--workers` / `cluster`），而规格的用例是 `doesNotMatch(全文)` → 注释里出现同样判红 | 规格副本上跑自带用例：`# tests 7 / # pass 4 / # fail 3`；逐条断言探针：`12/18 断言通过，6 条失败` | 资产文件的注释改写为不含被禁字面量（保留语义与指向计划的指引）。**不改用例**（用例的意图是对的：文件里就不该出现这些字面量）。 |
| D2-02 | **Critical** | `install.sh` 的 `ROOT="$(cd "$(dirname "$0")/.." && pwd)"` **对不上**规格用例的正则 `\$\(cd "\$\(dirname "\$0\)" && pwd\)`（少一个 `/..`） | 同上探针：`FAIL [sh] match /\$\(cd "\$\(dirname "\$0\)" && pwd\)/` | 拆成两行：`SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"`（**正是全局约束写的那个写法**）+ `ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"`。用例与全局约束同时满足。 |
| D2-03 | **Critical** | `install.sh` 的用法注释里 `ADMIN_PASSWORD='...'` **被规格自己的「不许硬编码口令」正则判成硬编码口令**（`'...'` 里第一个字符不是 `$`） | 同上探针：`FAIL [sh] doesNotMatch /PASSWORD\s*=\s*["'][^"'$][^"']*["']/`（大小写不敏感那条同样红） | 用法注释改成**不出现任何带引号的口令字面量**（口令值当场填、且不落盘）。口令来源仍是 `ADMIN_PASSWORD` 环境变量或交互读取。 |
| D2-04 | **Critical** | `install.sh` 里 `log "…（手机号 $phone）"` 的 `$phone` **紧跟全角括号** → bash 在 `C` / `C.UTF-8` locale 下把高位字节并进变量名 → `set -u` 下直接 **unbound variable 崩掉**（种子步骤之后全流程中断） | 干跑实测：`/tmp/…/install.sh: line 195: phone?: unbound variable`（本机 locale = `C.UTF-8`）。最小复现：`LANG=C.UTF-8 bash -c 'phone=123; echo "手机号 $phone）"'` → 输出乱码而非 `123` | 改成 `${phone}`（显式界定变量名）。全文件扫了一遍「`$VAR` 紧跟非 ASCII 字节」= **仅此 1 处**。 |
| D2-05 | **Critical** | `docker-compose.yml` 用 `ports: "127.0.0.1:8080:8080"`，但 `src/server.js` **只绑 127.0.0.1** → 容器里端口映射转发到容器 eth0，进程不听那里 ⇒ **连接被拒**（容器 healthy、宿主机 curl 不通，**静默失败**） | 实跑取证：`node src/server.js` 后 `lsof` → `TCP 127.0.0.1:8080 (LISTEN)`；`curl http://127.0.0.1:8080/api/health` → `{"ok":true,…}`；`curl http://192.168.2.27:8080/api/health` → 不可达 | 改用 `network_mode: host`（容器与宿主机共享网络栈 ⇒ 进程绑的 127.0.0.1:8080 就是宿主机的 127.0.0.1:8080，与 `nginx` 反代目标一致，也不暴露公网）。同时在文件里写清「若上游把 `src/server.js` 改成可绑 0.0.0.0，可换回 `ports`」。见「与接口契约的偏差」T2-1。 |
| D2-06 | Important | `install.sh` 的 Node 版本下限 `MIN_NODE_MINOR=5` 低于项目真实下限 | `package.json` → `"engines": { "node": ">=22.16.0" }`；`src/db/sqlite.js` 注释：备份 API `sqlite.backup()` 是 22.16.0 引入 | 改为 `22 / 16`（与 engines 逐字一致），错误提示同步。 |
| D2-07 | Important | systemd 单元的 `Documentation=file:/opt/heikesong/platform/README.md` **硬编码部署路径** | 与单元里其它路径都用 `__APP_DIR__` 不一致 | 改为 `Documentation=file:__APP_DIR__/README.md`（占位符集合不变）。 |
| D2-08 | Important | `install.sh` 的 `ENV_FILE` 变量**形同虚设**：单元里写死 `EnvironmentFile=-/etc/heikesong/platform.env`，改了 `ENV_FILE` 服务读不到 | 代码走查；干跑时 `ENV_FILE` 指向临时路径，而单元里仍是 `/etc/heikesong/platform.env` | sed 替换该字面路径（`s|/etc/heikesong/platform.env|$ENV_FILE|g`），**不新增占位符**。干跑产物核对：单元里 `EnvironmentFile=-/tmp/…/etc/heikesong/platform.env` ✓。 |
| D2-09 | Important | `write_env_file` 里的 `umask 077` **泄漏**到后面的函数 → nginx 站点文件会被建成 `600` | 代码走查（`umask` 不是函数局部） | `umask` 存取成对（写完恢复）。干跑产物核对：环境文件 `0640`、nginx 站点 `644` ✓。 |
| D2-10 | Minor | `install -d -g "$RUN_USER"` 假设存在**与用户名同名的组** | 干跑实测：`install: unknown group mac`（macOS 主组是 `staff`） | 落盘属组改用运行用户的**主组**（`id -gn`），并保留同名组作为兜底。 |
| D2-11 | Important | 规格的 7 个用例全是**字面扫一遍**：改掉注释就红、但把**配置本身**改坏（上游绑 `0.0.0.0`、compose 扩副本、`DEMO_MODE=1`、端口漂移、单元里写口令）**全都测不出来** | 变异测试第 1 轮：这些变异体在规格的 7 个用例下**全部存活**（见台账 E） | **规格的 7 个用例逐字保留**，另**追加 7 个**用例（单进程 / `DEMO_MODE` 禁令 / 正式形态 TLS / 上游只绑回环 / 不扩副本 / 端口与真实代码同口径 / 环境文件不落口令 / 幂等守卫），并引入 `effective()`（去掉整行注释）**只对有效配置断言** —— 注释里的「默认值说明」是文档，不是配置。 |
| D2-12 | Minor | 规格 Step 8 第二条命令的**期望值与规格自己的文件不符** | `sh -c 'grep -c "proxy_buffering off;" deploy/nginx.conf'` → 实测 **2**（头部注释里写了一遍 + 真指令 1 处），规格写 `1` | 命令改为「去掉整行注释再计数」→ 实测 `1`（真指令本来就只有 1 处），且能真正抓到重复指令。 |
| D2-13 | Minor | `nginx.conf` 的 `location /assets/ { alias __APP_DIR__/web/assets/; }` 指向的目录**当前不存在** | `ls platform/web/assets` → `No such file or directory`（现有静态文件在 `web/` 根下） | 保留规格形态（`R-OPS-04` 要求「`location /assets/` + 缓存策略存在」），但在文件里写清「`web/assets/` 是前端构建产物目录，现在还没有；目录不存在时该前缀返 404，不影响其它路径」。**不擅自改静态目录结构**（那是 Task 6 的范围）。 |
| D2-14 | Minor | `install.sh` 结尾无条件打印「备份命令：… node scripts/backup.js」，但 `scripts/backup.js` 是 **P6 Task 1** 的产物（另一个 worktree 在写） | `ls platform/scripts/` → 只有 `audit-scan.js` / `forbidden.txt` / `migrate.js` / `seed.js` | 改成「文件存在才打印」，避免给出跑不通的命令提示。 |
| D2-15 | Important | 规格的用例是**全文扫一遍** ⇒ **把真指令注释掉也扫得到**（假绿）。第 1 轮变异实测：`systemctl daemon-reload` 与 `nginx -t` 被注释掉后，规格用例 6 **仍然全绿** | 变异体 M28 / M29 在第 1 轮 **SURVIVED**（规格用例 6 仍绿）；M11 / M16 同理（SSE 指令被改/被删，规格用例 3 仍绿 —— 头部注释里写着同样的字面量） | 新增用例 12「注释不能掩盖配置错误」：对**去掉整行注释后的有效配置**再断言一遍（`effective()`）。规格的 7 个用例仍逐字保留（不削弱它们），只是补上「有效配置」这一层。 |

### C. 逐字回写位置（本轮改动的计划代码块）

| 计划位置 | 改动 |
|---|---|
| Task 2 Step 1 的 `platform/test/deploy-assets.test.js` 代码块 | 规格 7 个用例**逐字保留** + 追加 5 个用例（整体回写） |
| Task 2 Step 3 的 `deploy/heikesong.service` 代码块 | 整体回写（D2-01 注释改写、D2-07 `Documentation` 占位符） |
| Task 2 Step 4 的 `deploy/nginx.conf` 代码块 | 整体回写（D2-13 注释增补） |
| Task 2 Step 5 的 `deploy/docker-compose.yml` 代码块 | 整体回写（D2-01 注释改写、D2-05 `network_mode: host`） |
| Task 2 Step 6 的 `deploy/install.sh` 代码块 | 整体回写（D2-02/D2-03/D2-04/D2-06/D2-08/D2-09/D2-10/D2-14） |
| Task 2 Step 2 / Step 7 / Step 8 的 Expected 与命令 | 见上表 D2-11 / D2-12 |

### D. 硬约束自证

| 硬约束 | 怎么验的 | 证据 |
|---|---|---|
| ① **单写者**（⛔ 多 worker 写同一 SQLite） | ① 资产文件全文不含 `--workers` / `cluster` 字面量（规格用例 2/5）；② 用例 8 断言单元**只有一条 `ExecStart`** 且不带多进程参数；③ 用例 10 断言 compose 无 `replicas` / `scale` / `deploy:` 键；④ `src/server.js` 实测单进程单写者 | 用例 2/5/8/10 全过；变异测试里「加 `--workers=4`」「加 `deploy.replicas: 2`」两个变异体**被杀** |
| ② **不硬编码口令 / 域名 / 证书路径** | ① 规格用例 6 的两条正则（口令）；② 用例 11 断言**环境文件写入块**里不出现 `PASSWORD`；③ 域名/证书/私钥全是 `__SERVER_NAME__` / `__CERT_PATH__` / `__KEY_PATH__` 占位符，`install.sh` 逐个 sed 替换；④ 干跑产物核对：**口令没有落盘** | 干跑：`grep -rq "$ADMIN_PASSWORD" out/etc` → 「✅ 口令没有落盘」；环境文件内容只有 `PORT` / `DATA_DIR` / `SESSION_TTL_DAYS` / `NODE_ENV` 四行 |
| ③ **`install.sh` 幂等** | 临时目录 + 系统命令打桩（`systemctl` / `nginx` / `id` / `runuser`），**连续跑两次** | 两次退出码均 **0**；第 2 次的 `migrate` 输出「本次无新迁移」、`seed` 输出「管理员已存在：13800000000」；`ln -sfn` 软链复用；`systemctl enable` 可重复 |

### E. 变异测试（三轮，脚本 `/tmp/p6-mutate/t2.mjs`，指向**已落地**的测试文件）

| 轮次 | 变异体总数 | KILLED | SURVIVED | 脚本错误（锚点失效/不唯一） | 处置 |
|---|---|---|---|---|---|
| 第 1 轮 | 38 | 24 | 13 | 1（M12 锚点命中 2 次） | 13 个存活体**逐个补断言**（补的都是真实不变量：注释不能掩盖配置、expires 与 max-age 必须一致、镜像 Node 主版本、代码挂载只读、Node 下限与 engines 一致、环境文件 0640、umask 存取成对、占位符→变量映射、locale 安全展开）；M12 锚点加长上下文 |
| 第 2 轮 | 38 | 35 | 3 | 0 | 3 个存活体（M12 在另一处 location / M24 多挂一份可写副本 / M38 umask 不恢复）**补断言**（X-Real-IP 每一处都必须是 `$remote_addr`；代码只挂一次且 `:ro`；umask 恢复要在**有效配置**里找） |
| 第 3 轮 | 42 | **42** | **0** | 0 | 追加 4 个变异体（M39 `read_only` / M40 `cap_drop` / M41 环境文件 0644 / M42 sed 值不转义）并补对应断言；最后 3 个存活体（M12 / M24 / M38）被新断言杀掉 |

**最终：42 个变异体，42 个 KILLED，0 个存活，0 个脚本错误。**
（变异体清单与每个变异体「改的是什么行为」见脚本里的 `MUTANTS` 数组；明细 JSON：`/tmp/p6-mutate/results.json`。）

> ⚠️ **方法说明**：变异体**只**改「有效配置 / 有效脚本」，注释行会被 `effective()` 过滤掉，
> 所以每个变异体都**真的改变行为**（不是改注释）。锚点命中数必须 === 1，
> 命中 0 次报「锚点失效」、命中 ≥2 次报「锚点不唯一」并要求加长上下文 —— 脚本不放过含糊。

### F. 计划块逐字核验

`platform/deploy/*` 与 `platform/test/deploy-assets.test.js` 落地后，逐字比对本计划 Task 2 的 5 个代码块
（核验脚本：把计划文件里的围栏块抽出来与落地文件 `diff`）—— 结果 **5/5 逐字一致**。

### G. 遗留 / 需上游注意

1. **`scripts/backup.js` 尚未落地**（P6 Task 1 另一个 worktree 在写）。`install.sh` 已改成「文件存在才打印备份命令」，
   但**备份命令的可用性**要等 Task 1 落地后再验一次。
2. **`src/server.js` 只绑 127.0.0.1** 是 compose 路径的根因（D2-05）。若上游愿意把绑定做成可配置
   （如 `HOST` 环境变量），compose 可以换回更常见的 `ports` 映射；**本 Task 不改 `src/server.js`**（不在归属内）。
3. **`web/assets/` 目录尚不存在**（D2-13）：`location /assets/` 现在是「给前端构建产物预留」的位置。
   Task 6 的静态站构建落地后，这里才有实际内容。
4. **`Group=__RUN_USER__` 假设存在与用户名同名的组**（Debian/RHEL `useradd` 默认行为）。
   `install.sh` 落盘时用主组（`id -gn`），两者在目标平台一致；若将来换到用户名与组名不同的系统，
   单元里的 `Group=` 需要单独处理。
5. **上海机调试形态**（计划「临时调试形态」D2-1～D2-4）**不在本 Task 的四个文件里**：那需要另开一套
   `listen 8080`、无 TLS、无 `server_name` 的 nginx server 块。本 Task 的 `nginx.conf` 是**正式形态**
   （域名 + TLS + 443），与计划「部署目标决策登记」一致。


---

## Task 1 实施台账（2026-10-21）

> 本节是 Task 1（备份与恢复脚本）的实施记录：**规格缺陷清单**、处置方式、逐字回写位置、实跑证据、变异测试。
> 纪律：本计划 Task 1 的 **6 个代码块 = 最终实现的逐字副本**
> （核验命令：`node /tmp/p3fix/plan-blocks.mjs <plan> <platformDir>`）。
>
> **本 Task 的灵魂**（规格第 195–200 行）：备份用 `sqlite.backup()` API，**不用 `cp`**。
> 测试**同时**证明两件事：① `backup()` 拷到的备份里**有**那笔「已提交但未 checkpoint」的事务；
> ② 只 `cp .db` 的副本里**没有**。两条都是真断言（不是「跑通即算」）。

### A. 实施方法（先跑后落盘）

1. 把规格 Task 1 的代码块**原样抽到** `/tmp/p6-t1-scratch/platform`（一个字节都没改）。
2. 先做 **node:sqlite `backup()` API 探针**（`/tmp/p6-t1-scratch/probe1..5.mjs`）—— 摸清四件事：
   `progress` 回调的真实签名、`readOnly` 打开 WAL 库的副作用、`backup()` 对并发写者的容忍度、
   「能打开但页已损坏」的库在 `integrity_check` 下的表现。
3. 在副本上写实现 + 用例 → 全绿 → 才落盘到 `platform/`。
4. 落盘后：全量测试、**规格原样实现对照**（缺陷实证）、变异测试、计划块逐字回写与核验、Step 9 实跑。

### B. 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| D1-01 | **Important** | `backup()` 的 `progress` 回调**签名写错**：规格写 `(_db, copied)`，Node v22 的真实签名是**一个对象** `{ totalPages, remainingPages }`；而且该回调**只在多轮迭代时触发**（库小到一次迭代就拷完时根本不触发）→ 规格原样实跑 `pages` 恒为 **0** | 探针 `probe2.mjs`：回调收到 `[{totalPages:52,remainingPages:51}]`（`args.length===1`，参数类型 `object`）；探针 `probe1.mjs`（52 页 / `rate:100`）→ **回调 0 次触发**；规格原样实现的探针：`PROBE_PAGES=0 type=number` | 按真实签名取 `totalPages`；回调一次都没触发时回落到源库 `PRAGMA page_count`。规格原样的 `pages=0` 由此修掉 |
| D1-02 | **Important** | Task 1 的 **Interfaces 段明写**「Consumes: `openDatabase({ dataDir, filename })`（P0 `src/db/sqlite.js`）」，Step 4 的代码块却用 `new DatabaseSync(sourcePath)` 直连 —— **同一 Task 内自相矛盾**，且丢掉 `openDatabase` 提供的 `busy_timeout=5000`（服务运行中备份时对 `SQLITE_BUSY` 没有退避） | 计划原文：Task 1「**Interfaces:** - Consumes: `openDatabase({ dataDir, filename })`」 vs Step 4 代码块 `const source = new DatabaseSync(sourcePath);` | 改用 `openDatabase({ dataDir, filename })`，与 Interfaces 段对齐。⚠️ **这一条没有测试能区分**（两条路径在本 Task 覆盖的场景里行为等价）—— 属**接口契约对齐**而非行为修复，已在变异结果里显式标注 |
| D1-03 | **Important** | `verifyBackupFile` 用 `readOnly: true` 打开 WAL 标志的库时，SQLite **会在文件旁建出** `-wal`(0B) 与 `-shm`(32KB)，且**关库后不删** → 备份目录每次校验多两个文件；保留策略只认 `*.db` ⇒ 这些残留**永不被清理** ⇒ 备份目录无限膨胀；`restoreDatabase` 的临时文件旁也会留 `app.db.restore.tmp-wal/-shm` | 探针 `probe4.mjs`：`readOnly 打开备份后: out.db(8192B) out.db-shm(32768B) out.db-wal(0B)`；规格原样实现的探针：`BEFORE=app-….db` → `AFTER=app-….db,app-….db-shm,app-….db-wal` | `verifyBackupFile` 记下「打开前 sidecar 存不存在」，关库后只删**本次自己造出来的**（打开前就存在的 `-wal` 可能带真实数据，一律不动） |
| D1-04 | **Important** | `checkServiceState` 把「pid 文件存在但内容不是合法 pid」当成「服务没在跑」→ **拿不到「服务已停」的证据却放行恢复**，与「恢复前必须先停服务」这条安全闸的 fail-safe 意图相反 | `readPidFile` 对非法内容返回 `null`（规格原样），`checkServiceState` 随即落到「未发现运行中的服务进程」 | 补一条：pid 文件在但内容不可解析 ⇒ `running: true`（保守拒绝），错误信息点明原因。运维确认服务已停后删掉该 pid 文件即可继续 |
| D1-05 | **Important** | 规格自带的 8 个用例里有 **3 条不判别**（把实现改坏它们照样绿）：① 「恢复后旧 `-wal`/`-shm` 被清掉」的断言放在**新库打开并关闭之后** —— 可 SQLite 自己会在打开时重建 `-wal`、关闭时删掉 `-wal`/`-shm` ⇒ 就算恢复**根本没删**也照样绿；② 「恢复前会留一份 `.before-restore-`」只断言 `steps` **文本**、不查**磁盘**（把 `rename` 换成 `unlink` 也照样绿）；③ 「备份文件损坏时拒绝恢复」用的是**根本不是 sqlite 的文件** ⇒ 它在**打开**阶段就被拒 ⇒ 跳不跳过 `integrity_check` 都一样拒 | 变异实测：M18（不删 `-wal`/`-shm`）**存活**、M19（不留存旧库）**存活**、M21（跳过 `integrity_check`）**存活** | 规格的 8 个用例**逐字保留**；另**追加 10 个判别性用例**：`-wal`/`-shm` **紧接恢复后**就断言、旧库必须**真在磁盘上**、临时文件必须清干净、**能打开但页已损坏**的备份（清零第 3 页 → `integrity_check` 报 `btreeInitPage() returns error code 11` 而**不抛错**，见探针 `probe5.mjs` 策略 A）、命令行入口可执行、保留策略的「份数 ∪ 天数」语义、真实生产 schema 往返等。三个存活体由此被杀 |
| D1-06 | Minor | Step 9 的实跑命令 `node scripts/seed.js` **不带 `ADMIN_PASSWORD`** → `scripts/seed.js` fail-fast 拒绝（「不提供默认口令」）→ 整条 `&&` 链在此中断，**备份根本没跑** | 实跑输出：`缺少环境变量 ADMIN_PASSWORD，拒绝创建管理员账号（不提供默认口令）。` | Step 9 的命令补上 `ADMIN_PASSWORD='<你的口令>'` 并写明原因。⚠️ 种子脚本的 fail-fast 设计**不改**（不提供默认口令是对的） |
| D1-07 | Minor | Step 10 的 `git commit` **不带 `-- <paths>`** —— 违反「先 `git add <paths>`，再 `git commit -m "…" -- <paths>`」这条纪律 | 计划 Step 10 原文 | 补上 `-- <paths>`（`-m` 仍在 `--` 之前） |
| D1-08 | Minor | 两个脚本的 `isMain` 判定照抄「`fileURLToPath(import.meta.url) === process.argv[1]`」：**符号链接入口会静默不执行、退出码 0**（`src/server.js` 的注释里已记录这个坑并改用 realpath 判定） | `src/server.js` 注释原文：「Node 会把主入口 realpath 化，import.meta.url 是真实路径，而 process.argv[1] 是链接路径 → 字符串全等为假 → 服务器静默不启动、退出码 0」 | 沿用 `src/server.js` 的 realpath 判定。⚠️ 实施时**第一版漏了 `fileURLToPath`** —— `realpathSync()` 吃的是**路径**不是 `file://` URL，直接传 `import.meta.url` 会抛 ENOENT ⇒ `isMain` 恒假 ⇒ **命令行跑起来什么都不干、退出码 0**。是 Step 9 实跑抓到的（`[backup] 完成：…` 一行都没打、`data/backups/` 没生成）。已修，并补两条「命令行入口可执行」的用例守住（M25/M26/M27 三个变异体被杀） |
| D1-09 | Minor | `restoreDatabase` 在 `dataDir` 不存在时 `copyFileSync` 抛 ENOENT（**恢复到新机器**的典型场景） | 代码走查 | 换库前 `mkdirSync(dataDir, { recursive: true })` |
| D1-10 | Minor | `checkServiceState({ dataDir })` 不传 `dataDir` 时 `join(undefined, 'app.pid')` 抛 TypeError | 代码走查 | 补默认值 `dataDir = './data'`（与 `restoreDatabase` 一致） |

### C. 逐字回写位置（本轮改动的计划代码块）

| 计划位置 | 改动 |
|---|---|
| Task 1 Files 段的 Test 两行之后 | 追加「实施补记」（8 个用例逐字保留 + 追加 10 个判别性用例） |
| Task 1 Step 1 的 `platform/test/backup.test.js` 代码块 | 整体回写（规格 4 个用例逐字保留 + 追加 3 个判别性用例） |
| Task 1 Step 1 的 `platform/test/restore.test.js` 代码块 | 整体回写（规格 4 个用例逐字保留 + 追加 7 个判别性用例） |
| Task 1 Step 3 的 `src/runtime/pidfile.js` 代码块 | **未改**（与实现逐字一致） |
| Task 1 Step 4 的 `scripts/backup.js` 代码块 | 整体回写（D1-01 progress 签名、D1-02 openDatabase） |
| Task 1 Step 5 的 `src/db/migrate.js` 片段 | **未改**（追加块与实现逐字一致） |
| Task 1 Step 6 的 `scripts/restore.js` 代码块 | 整体回写（D1-03 sidecar、D1-04 pid 坏内容、D1-09/D1-10） |
| Task 1 Step 7 的 `src/server.js` 三处片段 | 整体回写（D1-08 realpath 判定；写成三处独立可分离的小改动） |
| Task 1 Step 8 的 Expected | 改成实跑数字（backup 7 + restore 11 = 18） |
| Task 1 Step 9 的命令 | 补 `ADMIN_PASSWORD`（D1-06） |
| Task 1 Step 10 的命令 | 补 `-- <paths>`（D1-07） |

### D. 实跑证据

| 项 | 结果 |
|---|---|
| 全量测试（`node --disable-warning=ExperimentalWarning --test`，cwd 发现） | **841 / 841 全绿**（基线 823 + 本 Task 新增 18） |
| 单文件（`--test test/backup.test.js test/restore.test.js`） | **18 / 18 全绿**（backup 7 + restore 11） |
| Step 9 实跑（migrate → seed → backup → restore → 读表） | `[backup] 完成：app-20261021T070553Z.db（630784 字节，154 页）` → `[restore] 成功。请重新启动服务： systemctl restart heikesong` → `users = 6`（正整数） |
| 规格原样实现对照（`/tmp/p6-mutate/t1-spec-baseline.mjs`：把计划里的代码块逐字装进副本，跑本次的用例） | **13 绿 / 3 红** —— 3 条红正是 D1-01（页数）、D1-03（sidecar 残留）、D1-04（pid 坏内容）的判别点 |
| 本 Task 的灵魂用例 | 「WAL 模式下备份包含已提交但未 checkpoint 的事务（而只 cp .db 会丢）」**同时**断言反例（只 cp `.db` 的副本 `COUNT=0`）与正例（`backup()` 的副本 `COUNT=1`） |

### E. 变异测试（脚本 `/tmp/p6-mutate/t1.mjs`，指向**已落地**的测试文件）

| 轮次 | 变异体总数 | KILLED | SURVIVED | 处置 |
|---|---|---|---|---|
| 第 1 轮 | 18 | 13 | 5 | 5 个存活体逐个定位为「**用例不判别**」（D1-05）：M18/M19/M20/M21 + M02。逐个补判别性断言（`-wal`/`-shm` 紧接恢复后断言、旧库查磁盘、临时文件查磁盘、能打开但损坏的备份） |
| 第 2 轮 | **27** | **26** | **1** | 追加 9 个变异体（M19/M20/M21 改锚点后重杀 + M22..M27：schema 版本、sidecar 清理、`currentVersion`、三个命令行入口），第 1 轮的 4 个存活体同时被杀 |

**最终：27 个变异体，26 个 KILLED，1 个存活，0 个脚本错误（锚点全部唯一命中）。**

**存活者 M02（规格原样的 `progress: (_db, copied)`）= 等价变异体**：
本实现有 `PRAGMA page_count` 兜底 ⇒ 回调写错**不改变可观测结果**。**探针差分实证**：
Node v22 的真实签名是**单对象** `{ totalPages, remainingPages }`（探针 `probe2.mjs` 输出
`args.length 集合: [1]`、参数类型 `["object"]`）；而**规格原样实现**（无兜底）的实跑结果是
`pages = 0`（探针 `PROBE_PAGES=0 type=number`）⇒ **缺陷 D1-01 真实存在**，只是在本实现里被兜底掩盖。

> ⚠️ 方法说明：每个变异体都**真的改变行为**（改的是有效代码，不是注释）；锚点命中数必须 `=== 1`，
> 命中 0 次报「锚点失效」、命中 ≥2 次报「锚点不唯一」并要求加长上下文 —— 脚本不放过含糊。
> 变异体清单见脚本里的 `MUTANTS` 数组。

### F. 计划块逐字核验

`node /tmp/p3fix/plan-blocks.mjs docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md platform` →
**Task 1 的 6 个块全部一致**：

| 块 | 结果 |
|---|---|
| `test/backup.test.js` | 整文件块 ✅ 一致（217 行） |
| `test/restore.test.js` | 整文件块 ✅ 一致（306 行） |
| `src/runtime/pidfile.js` | 整文件块 ✅ 一致（43 行） |
| `scripts/backup.js` | 整文件块 ✅ 一致（152 行） |
| `scripts/restore.js` | 整文件块 ✅ 一致（193 行） |
| `src/db/migrate.js`（Step 5 的追加片段） | 片段块 ✅（实现含此片段，12 行） |
| `src/server.js`（Step 7 的三处 pid 片段） | 片段块 ✅ ×3（1 行 / 7 行 / 6 行） |

> （同一次运行里 `scripts/audit-scan.js` / `web/index.html` / `web/app.js` 报「❌不一致 / 无实现」——
> 那是 **Task 3/4/5/6** 的块，**在本 Task 之前就已经这样**，与本次改动无关。）

### G. 遗留 / 需上游注意

1. **`src/server.js` 的 P4 合并冲突面**：P4 阶段在同一文件加了审计路由 → 将来合并会冲突。
   本 Task 的改动刻意写成**三处独立、带 `── P6：… ──` 注释边界**的小改动
   （顶部 import 一行 / `openDatabase` 之后的 `writePidFile(dataDir)` 一行 /
   `SIGINT`/`SIGTERM` 处理里的 `removePidFile(dataDir)` 一行），
   冲突时**按边界取**即可。**本 Task 没有重建 `server.js`**（只在既有文件上追加）。
2. **`package.json` 的 `backup` / `restore` npm scripts 未加**：计划的 File Structure 段列了
   「package.json scripts 增加 backup / restore / build:demo / serve:demo」，但 **Task 1 的 Files 清单不含
   package.json**（`build:demo` / `serve:demo` 属 Task 5/6）→ 为避免与别的 Task 抢同一个 JSON 对象，
   本 Task **不动 package.json**。功能入口仍是 `node scripts/backup.js` / `node scripts/restore.js`
   （`deploy/install.sh` 打印的正是这条命令）。
3. **Task 2 台账 G-1「`scripts/backup.js` 尚未落地」已由本 Task 解除**：
   `install.sh` 里那条备份命令现在真的可执行（Step 9 实跑已验）。
4. **`restoreDatabase` 不接受 `serviceName` 参数**（接口契约里没有）→ systemd 探测固定用 `heikesong`；
   若将来服务改名，需要扩接口。
5. **备份目录的 sidecar 清理依赖 `verifyBackupFile` 的兜底**：若有人绕过本脚本直接用别的工具打开备份文件，
   仍可能留下 `-wal`/`-shm`（这是 SQLite 的行为，不是本 Task 可控的）。
6. **`backupDatabase` 打开源库用 `openDatabase`**（D1-02）⇒ 备份动作会把源库切到 WAL 模式
   （对已经是 WAL 的库是 no-op，不取锁）。

---

## Task 3 实施台账（2026-10-21）

> 本节是 Task 3（发布前扫描闸）的实施记录：**规格缺陷清单**、处置方式、逐字回写位置、实跑证据、变异测试。
> 纪律：本计划 Task 3 的 **4 个代码块 = 最终实现的逐字副本**
> （核验命令：`node /tmp/p3fix/plan-blocks.mjs docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md platform`）。
>
> **本 Task 的灵魂**（规格第 2195–2203 行）：① **禁用清单必须真有词条，空清单 ≠ 已保护**；
> ② **不能一刀切**（更正语境要能出现在文档里）；③ **平台自身必须能独立跑**
> （`--evidence-chain` 只是可选增强，绝不影响本闸结论）。
>
> ⛔ **归属**：`scripts/audit-scan.js` 与 `scripts/forbidden.txt` 是 **P4 Task 7 建立的**，
> 本阶段**不重建**（P0–P6 严格串行，两个 writer 写同一个路径必然冲突），
> 只在 P4 的实现上**追加**发布相关能力；`parseManifest` / `scanText` / `scanRoots` / `main`
> 的**签名一律不变**；P4 的 `test/audit-scan.test.js` **一个字不改**。

### A. 实施方法（先跑后派）

1. 把规格 Task 3 的代码块**原样抽到** `/tmp/p6-t3-scratch/spec/`（一个字节都没改）。
2. 在 `/tmp/p6-t3-scratch/platform/`（P4 现状的整份拷贝）上跑规格自带用例 → **红**
   （`# tests 6 / # pass 4 / # fail 2`：用例 4「仓库自带清单里必须有 CICC 条目」、
   用例 6「--forbidden 未生效」）。
3. 在拷贝上实现规格的 Step 3 / Step 4 → 规格的 6 个用例**全绿**；
   再补 13 条判别性用例（规格的 6 条**逐字保留**）→ 19 条全绿；P4 的 20 条用例仍全绿。
4. **落盘**到 worktree（`scripts/audit-scan.js` / `scripts/forbidden.txt` / 新建 `test/audit-scan-release.test.js`）。
5. 落盘后做：全量测试、扫描闸实跑（0 / 2）、**逐字回写计划**、变异测试。

### B. 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| D3-01 | **Critical** | 规格 Step 4 让清单写 `@skip-path ^platform/web/dist/`，与 Step 3 的「发布产物也扫」**互相抵消**：`scanRoots` 先查 `skipPaths` 再查 `excludePaths`，清单里这一行会把发布产物里的**每个文件**整条跳过 ⇒ 本 Task 的核心（发布产物过闸）**形同虚设**，而闸还报「✓ 未发现禁用表述」退出 0 | 探针 1（`/tmp/p6-t3-scratch/probe-defects.mjs`）：按规格原样（清单带那一行）+ `dist/index.html` 里有 `积分占决赛 30%` → **退出码 0**；报告里 `platform/web/dist/index.html` 出现在**排除段（@skip-path）**、**不在违规段**；同一份实现去掉那一行 → **退出码 1**（违规段点名 dist）。变异体 M01/M02/M03 是同一形状 | ① 清单里**不**写 `@skip-path ^platform/web/dist/`（并在清单里写明为什么）；② 发布产物那一趟固定 `skipPaths: []`（**清单关不掉它**）+ `excludePaths: []`（源码目录的默认排除项不套到发布产物上）；③ 追加 3 条判别性用例（发布产物必过闸 / 清单的 `@skip-path` 关不掉它 / 发布产物里每一个文本文件都要过闸） |
| D3-02 | **Important** | 规格 Step 4 的**前提过期**：它要求「把 P4 里带 `?` 的两条拆成空格变体」，但 **P4 定稿早已拆好**（P4 自己的用例断言「仓库自带清单里没有「正则占位」写法」）→ 照规格再追加一遍会触发 `parseManifest` 的「重复词条」→ 退出码 2 ⇒ **闸永远打不开** | 探针 5：`git show HEAD:platform/scripts/forbidden.txt` 里已有 `初赛企业确认权重20%` / `初赛企业确认权重 20%` / `四维各25%` / `四维各 25%`；把它再追加一遍 → `parseManifest` 报错 `["清单里有重复词条：四维各 25%"]` | **不改** P4 的词条，只追加 P6 的新词条；把计划里这一步的前提改正（Step 4 的说明 + 「与接口契约的偏差」第 9 条一并改写） |
| D3-03 | **Important** | 规格自带的用例 6 名为「发布产物目录也必须过闸」，实际测的是 `--forbidden` + **普通文件** ⇒ 规格最核心的一条（发布产物过闸）**没有任何用例覆盖** | 探针 2：把 Step 3 的「发布产物那一趟」整段删掉（= 变异体 M03）后，**规格自带的 6 个用例全部通过**（`not ok` = 0） | 规格的 6 个用例**逐字保留**；另加 4 条针对发布产物的用例（发布产物必过闸 / 每个文本文件都要过闸 / 清单的 `@skip-path` 关不掉它 / 发布产物不存在时按「存在才扫」处理） |
| D3-04 | **Important** | 规格的用例 5「增强不可用也不影响结论」在**参数还没实现时也会通过**（未识别的参数被当成扫描路径 → 扫 0 个文件 → 退出码 0）⇒ 假绿 | 在 **P4 的实现**上直接跑规格的 6 个用例：用例 5 **通过**（`--evidence-chain` 根本没被解析） | 追加 2 条用例：HOME 下没有该 skill 时退出码仍为 0 且打印一行说明 / `--evidence-chain` 指向真实脚本时该脚本**确实被调用**（写标记文件） |
| D3-05 | **Important** | 规格的 `main` 把**未知参数**当扫描路径吞掉（`roots.push(a)`）⇒ 参数写错（如 `--jsonn`）时扫 0 个文件并报「✓ 未发现禁用表述」，退出码 0 —— 静默放行 | 探针 3：按规格原样跑 `--jsonn` → **退出码 0**，输出「扫描 0 个文件」+「未发现禁用表述」 | 未知 `--` 参数 → 退出码 2 + 报「未知参数」+ 用法提示 |
| D3-06 | **Important** | 规格的 `--forbidden` 缺值时回落默认清单（`argv[i + 1] \|\| manifestPath`）⇒ 参数写错 = 用错清单 = 假绿 | 探针 4：按规格原样跑 `--forbidden`（缺路径）→ **退出码 0**（静默用了默认清单）；变异体 M07（照规格原写法改回去）→ 新增用例「--forbidden 缺路径 → 退出码 2」变红 | 缺值 → 退出码 2 + 报「--forbidden 后面必须跟清单路径」 |
| D3-07 | **Important** | 规格没有「扫到 0 个文件」的判定 ⇒ 扫描范围写错（路径拼错、目录搬走、参数被吞）时闸报「✓ 未发现禁用表述」并退出 0 —— 与全局约束「静默的空产出比报错更危险」相悖 | 变异体 M08 / M15 都是这个形状（扫 0 个文件还报通过） | 扫到 0 个文件 → 退出码 2（文本输出与 JSON 输出都报「闸未生效」，JSON 里另有 `gateEffective: false`） |
| D3-08 | **Minor** | 规格的 `runEvidenceChain` 用 `join(process.env.HOME \|\| '', ...)` ⇒ HOME 未设置时拼出**相对路径** `.minimax/skills/...`，会按当前工作目录去找（可能误命中） | 探针 6：HOME 为空时的候选路径 = `".minimax/skills/evidence-chain/scripts/audit-evidence.js"`（相对路径） | HOME 为空时该候选项直接置 `null` |
| D3-09 | **Minor** | 规格 Step 3 是「整体替换 P4 的 `main`」，但没给「不许削弱 P4 行为」的验收手段 | P4 的 `test/audit-scan.test.js`（20 例：CLI 退出码 2/1/0 三种语义、排除项打印、豁免打印、清单自检）在改造后**仍全绿** | P4 的测试文件一个字不改（本 Task 只新建 `test/audit-scan-release.test.js`）；P4 的 20 例 + 本 Task 的 19 例一起跑 |

### C. 逐字回写位置（本轮改动的计划代码块）

| 计划位置 | 改动 |
|---|---|
| Task 3 Step 1 的 `platform/test/audit-scan-release.test.js` 代码块 | 整体回写：规格的 6 个用例**逐字保留** + 追加 13 条（父代理预审）＝ 323 行 |
| Task 3 Step 3 的 `scripts/audit-scan.js` 代码块 | 整体回写（158 行 ＝ 落地文件里 `main` + `runEvidenceChain` 区段的逐字副本） |
| Task 3 Step 3 的 import 代码块 | 不变（逐字一致） |
| Task 3 Step 4 的清单「P6 追加」代码块 | 整体回写（19 行 ＝ 落地清单里 P6 追加段的逐字副本） |
| Task 3 Step 4 的清单「P4 定稿现状」代码块 | 整体回写（5 行 ＝ 落地清单里 P4 那几行的逐字片段） |
| Task 3 Step 4 / 4b / 5 的说明与 Expected | 前提改正（D3-02）+ 实跑数字（词条 15 条 / 扫描 140 个文件 / 19 例） |
| 「与接口契约的偏差」第 9 条 | 改写（P4 已自行拆好空格变体，P6 不重复追加） |
| 本台账 | 新增 |

> 回写脚本：`/tmp/p6-t3-scratch/writeback.mjs` —— **按块在文档里的位置升序**处理，
> 并逐块累计**长度偏移**（第一版漏了偏移，替换会错位到别的块上；已修，第二次回写才作数）。

### D. 硬约束自证

| 硬约束 | 怎么验的 | 证据 |
|---|---|---|
| ① **空清单 ≠ 已保护**（清单为空 / 不合规 → 非 0 退出） | ① `parseManifest` 对空清单报错「闸未生效」；② CLI 层：清空清单 → 退出码 2；③ `--forbidden` 指定的清单为空 → 同样 2；④ 清单文件缺失 → 2 | 实跑：清空 `scripts/forbidden.txt` → 退出码 **2**（stderr「禁用清单为空 —— 闸未生效」）；用例 16 变红（M05 / M06） |
| ② **发布产物也过闸**（发布产物本身必须过闸） | ① 沙箱里造 `platform/web/dist/`，CLI 的**默认范围**必须拦下；② 清单里的 `@skip-path` 关不掉它；③ 产物里**每一个**文本文件都要过闸（含 `src/domain/`、`rules/`、`seed/` 这类子目录） | 用例 8 / 9 / 10 全过；变异体 M01 / M02 / M03 全被杀 |
| ③ **更正语境豁免**（不能一刀切） | ① 仓库自带清单里的 CICC 词条带豁免正则；② **裸引用被拦**、**更正语境被放过且进报告**（用仓库自带清单实测，不只是构造清单） | 用例 3 / 4 / 7 全过；变异体 M10 / M19 / M20 / M21 / M22 全被杀 |
| ④ **平台自身能独立跑**（不依赖用户机器上的 skill） | ① HOME 下没有该 skill 时退出码仍为 0 且打印一行说明；② skill 在时多跑一份报告，且**闸结论不变**（有违规仍是 1） | 用例 18 / 19 全过；变异体 M12 / M17 全被杀 |
| ⑤ **零依赖 / `node --test`** | `package.json` 未新增任何 dependency；全部用例用 `node --test`（无参，cwd 发现） | `git diff platform/package.json` ＝ 空；全量 **956 例 / 955 通过 / 1 跳过 / 0 失败** |

### E. 变异测试（脚本 `/tmp/p6-mutate/t3.mjs`，指向**已落地**的实现与测试）

| 轮次 | 变异体总数 | KILLED | SURVIVED | 脚本错误（锚点失效/不唯一） | 处置 |
|---|---|---|---|---|---|
| 第 1 轮 | 22 | 20 | 2 | 0 | 存活体 **M01**（发布产物那一趟改回默认排除）/ **M07**（`--forbidden` 缺值回落默认清单）→ 补断言 |
| 第 2 轮 | 22 | **22** | **0** | 0 | M01：新增用例「发布产物里的每一个文本文件都要过闸」；M07：把变异体改成**忠实复现规格原写法**（`manifestPath = value \|\| manifestPath`）——第一版的写法并不等价于规格（它落到 `undefined` ⇒ 清单「缺失」⇒ 退出码 2），改后才真正复现「静默回落默认清单」 |

**最终：22 个变异体，22 个 KILLED，0 个存活，0 个脚本错误。**
（变异体清单与每个变异体「改的是什么行为」见脚本里的 `MUTANTS` 数组；明细 JSON：`/tmp/p6-mutate/t3-results.json`。）

> ⚠️ **方法说明（这一轮踩到的坑，写下来给后面的人）**：
> ① 变异体**只改有效代码**（改的是行为，不是注释）；锚点命中数必须 === 1，
>    命中 0 次报「锚点失效」、≥2 次报「锚点不唯一」——本轮 **0 次脚本错误**。
> ② **必须先跑对照（未变异的假仓库）确认测试全绿，再看变异结果**：
>    第一轮的控制组当时是**坏的**（`node --test test/` 在 Node 22 上不按目录扫描，
>    误把 `test/` 当模块加载 → 38 个用例只跑出 1 个「失败」），
>    那会把「22 个变异体全杀」变成**假象**（每个变异体都只是撞上同一个环境错误）。
>    ⚠️ 这个坑**本仓已经踩过一次**（提交 `0a2d515 fix(P0): 修正测试命令 —— node --test test/ 在 Node 22 上不工作`，
>    全局约束里现在写的是 `node --test` 无参）—— 本轮是**第二次**踩到，特此记下来。
>    改成显式列出两个测试文件后，控制组 **39 例全绿**，才认这一轮的结论。
> ③ 假仓库构造：`<root>/platform/{scripts,test}` + `<root>/docs/ok.md`
>    （CLI 的仓库根 = `<root>`，相对路径可预期）。

### F. 计划块逐字核验

`node /tmp/p3fix/plan-blocks.mjs docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md platform` →

| 块 | 结果 |
|---|---|
| `test/audit-scan-release.test.js` | 整文件块 ✅ 一致（323 行） |
| `scripts/audit-scan.js`（Step 3 的 `main` + `runEvidenceChain`） | 片段块 ✅（实现含此片段，158 行） |

> `scripts/forbidden.txt` 的两个块**不在** `plan-blocks.mjs` 的扫描范围（它只认 js/html/css/sql/json），
> 已单独核过：**两个块都是落地清单的逐字片段** ✅（19 行 / 5 行）。

### G. 遗留 / 需上游注意

1. **⚠️ 前端构建产物目录三处不一致（待 Task 6 拍板）** ——
   - 计划 Task 6 规定产物在 **`platform/web/dist/`**；
   - `deploy/nginx.conf` 的静态资源直出却指向 **`__APP_DIR__/web/assets/`**
     （**没有任何 Task 会生成这个目录** —— Task 2 台账 D2-13 已记过同一件事）；
   - `deploy/install.sh` 的 rsync 又把 **`web/dist/` 排除**在拷贝之外
     （`--exclude 'web/dist/'`）。
   - ⇒ **本 Task 的扫描目标按计划走 `web/dist`**（`audit-scan.js` 里的 `distDir`），
     ⛔ **不改 `deploy/nginx.conf` / `deploy/install.sh`**（那是 Task 2 的文件，且要等 Task 6 一起定）。
   - **待 Task 6 拍板**：构建产物目录最终落在 `web/dist/` 还是 `web/assets/`？
     若落在 `web/assets/`，本 Task 的发布产物扫描目标要跟着改
     （`audit-scan.js` 的 `distDir` + 计划里的目录名 + 本条台账）。
2. **`platform/web/dist/` 还不存在**（Task 6 的产物）⇒ 这一趟现在是「存在才扫」，
   报告里打印「发布产物 platform/web/dist：不存在」；Task 6 落地后**必须重跑一次**
   `node scripts/audit-scan.js`，确认产物自己也过闸（那时这一行会变成「扫描 N 个文件」）。
3. **`--evidence-chain` 的增强脚本在本机是有的**
   （`~/.minimax/skills/evidence-chain/scripts/audit-evidence.js`）⇒ 实跑时它会被调用并把报告打出来；
   **它的退出码与输出都不影响本闸结论**（闸结论只看禁用表述），**本仓不依赖它**（用例 18 证明没有它也能跑）。
4. **清单里的 `@skip-path ^platform/data/` 与 `DEFAULT_EXCLUDES` 的 `'data'` 重复**：
   实测删掉它，**扫描文件数（140）与退出码都不变**（数据目录本来就被默认排除）
   —— 保留它是为了**显式表达意图**（数据目录不扫），**不是功能必需**。哪天真要让数据目录参与扫描，
   删掉这一行还不够，还要改 `DEFAULT_EXCLUDES`。
5. **P4 的 `test/audit-scan.test.js` 一个字没改**（本 Task 只追加）：
   P4 的 20 例与本 Task 的 19 例一起跑，全量 **956 例**。
6. **`audit-scan.js` 现在有两个「逃逸口」要一起记着**：**未知参数 → 2**、**扫到 0 个文件 → 2**。
   两者都是「静默的空产出比报错更危险」的直接落地；改这个文件时**别把它们一起删掉**。
7. **本 Task 的退出码语义**（与 P4 一致，未变）：
   **0 = 通过 / 1 = 有违规 / 2 = 清单为空、清单不合规、清单缺失、参数不认、扫了 0 个文件**。



---

## Task 4 实施台账（2026-10-21）

> 本节是 Task 4（演示版种子数据）的实施记录：**规格缺陷清单**、处置方式、逐字回写位置、实跑证据、变异测试、
> 以及**种子覆盖了哪些分支**的逐条清单。
> 纪律：本计划 Task 4 的 **2 个代码块 = 最终实现的逐字副本**
> （核验命令：`node /tmp/p6-mutate/t4-verify-blocks.mjs`）。
>
> **本 Task 的灵魂**（规格第 2510–2514 行）：种子不是「好看的假数据」，而是**每一条 trace 分支的触发器** ——
> 所以「种子里摆了一条数据」**不算数**，必须是**引擎真的因此触发了那条分支**才算数。
> ⇒ 本 Task 的测试不只做静态检查，还要把种子喂给**真实领域层引擎**（`src/domain/*`），
> 断言引擎的输出（总分 / 告警 / 破同分链 / 段位 / 行为分）。

### A. 实施方法（先跑后落盘）

1. 把规格 Task 4 的两个代码块**原样抽到** `/tmp/p6-t4/spec/`（一个字节都没改）。
2. 在 `/tmp/p6-t4-scratch/platform`（platform 整树副本）上跑**规格自带用例** → 红 1 条（D4-01 的实证）。
3. 写引擎探针 `/tmp/p6-t4/probe.mjs`（输入构造复刻 Task 5 的 `runDemoCompute`）→ 把 D4-02 / D4-03 的
   后果**量化**（同分两队总分差 0.0139、破同分链走不到 `peer`、行为分全 0）。
4. 改种子 → 探针转绿（总分差 `0.0000000000`、`peer` 级分开、行为分 17/2/5/7/0）→ **才落盘**到 worktree。
5. 落盘后：单文件 → 全量 → 变异测试 → 计划块回写与逐字核验。

### B. 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| D4-01 | **Critical** | 种子的打分矩阵用了 `track_fit` —— 那是**初赛**维度（只在 `rules/scoring-initial.json` 里）；**规格自己的用例**却断言「维度必须在 `rules.scoring.final` 里」⇒ **规格的种子与规格自己的用例互相矛盾** | 规格原样副本上跑自带用例：`# tests 8 / # pass 7 / # fail 1`，红的那条是 `维度 track_fit 不在 rules.scoring.final 里（评委 j_lenient 队 t_alpha）`；引擎探针另证：`track_fit` 在 `trace.normalization` 里有、但在 `perDimension` 里**没有席位**（决赛根本不计这一维）⇒ 演示版会白展示一整维原始分 | 从种子里**删掉 `track_fit` 这一维**（其余 4 维原始分一字不动）⇒ 决赛 4 个评委席维度全部有数据、每维 5 个样本（= `minSamplesForJudgeNormalization`）⇒ 归一化不降级。**不改 `rules/scoring-final.json`**（权重表是 P1 定稿的规则，不属本 Task） |
| D4-02 | **Critical** | 规格声称 `tiedTeams: ["t_alpha","t_beta"]` 同分，但**引擎算出来根本不同分**：**自评席**把差距拉开了 —— `t_alpha` 自评 95（比评委 81 高 14 → 触发「书面说明」→ 自评分**对齐**到评委分 81.2788），`t_beta` 自评 81（d=0 → 不触发 → 自评席保留原分 81）⇒ 总分差 **0.0139378046** ⇒ 破同分链在**第一级 `total`** 就把它们分开，**永远走不到 `peer`** ⇒ 演示版最想展示的「同分 → 互评破同分」根本没发生 | 引擎探针（规格原样种子）：`t_alpha total=81.089336` / `t_beta total=81.075398`，`total 差 = 0.0139378046`；逐维差**只在** `self_eval`：`81.27875609118963 vs 80.99999999999999`；破同分链 `applied` 只有 `{"key":"total",…,"separated":true}`，**没有 `peer` 这一级** | 让两支同分队的**自评席完全一致**（都取阈值内的 85，d=+4 不告警）⇒ 六个席位分全相等 ⇒ 总分**严格相等**（差 `0.0000000000`）⇒ 破同分链在 `peer` 级分开（alpha 互评 71 > beta 59）。**「书面说明」分支改由 `t_delta` 承担**（自评 95 vs 评委 76，d=+19）⇒ `expectations.selfEvalWrittenExplanationTeam` 的**值**由 `t_alpha` 改为 `t_delta`（键名与结构未动） |
| D4-03 | **Important** | `behaviorEvents[].evidence` 是**纯文字**（"第 1 周进度"）—— ① 领域层 `parseEvidence` 只认 JSON 对象 ⇒ 纯文字一律 0 分（`evidence_not_json`）⇒ 行为分**全是 0**、行为分支不可观测；② 这种形状**真实写入方根本产不出来**：`src/services/behavior.js` 先用域函数校验证据，不合规直接 400 `EVIDENCE_REJECTED` 拒收 | 引擎探针（规格原样种子）：`t_alpha items=["weekly_progress:0(evidence_not_json)","weekly_progress:0(evidence_not_json)","workshop_output:0(evidence_not_json)","first_demo:10"]`；`src/services/behavior.js:40-47`（写入前校验）+ `:50`（`JSON.stringify` 落库） | 证据改成**合规的 JSON 串**（形状与真实写入方落库一致：TEXT 列里存 JSON 串），逐条满足 `rules/criteria.json` 的 `behaviorEvidence`（weekly_progress 要 `repo`+`version`+`artifact\|blocker`、workshop_output 要 `output`、enterprise_meeting 要 `enterpriseConfirmationId`）⇒ 行为分 17/2/5/7/0，并写进 `expectations.behaviorScores` 供机器校验 |
| D4-04 | Minor | 规格的 Step 5 提交命令**不带 `-- <paths>`** —— 违反「先 `git add <paths>`，再 `git commit -m "…" -- <paths>`」这条纪律 | 计划 Step 5 原文 | 补上 `-- web/seed test/demo-seed.test.js`（`-m` 仍在 `--` 之前） |
| D4-05 | Minor | 种子里的 `signatoryUserId`（`u_ent_retail` / `u_ent_mfg`）**在 `users` 列表里不存在** —— 企业签字人是企业侧身份，而种子的 `users` 结构表（`[{id,name,mbaStatus}]`）没有 org/role 字段可放 | 结构表原文 + 种子内容 | **不改**（登记为已知边界）：塞进 `users` 会被误当成平台用户（`mbaStatus` 只能是 mba/member/other），而 `users` 的用途是**组长硬门槛判定**；企业席只校验签字人 id **非空**（`enterprise-seat.js` 的 `!c.crossJudgeId \|\| !c.signatoryUserId`）⇒ 规则上成立 |
| D4-06 | Minor | `tp_free` 任务包下只有 1 支队伍，而 `rules/team-formation.json` 的 `teamsPerPackage.min = 2` | 种子 teams + 规则原文 | **不改**（登记为已知边界）：该门槛是**组队/认领任务包时**的闸，种子是「组队之后」的快照；且凑成 2 支要多一支队伍 ⇒ 连带改 `expectations.tiers`、互评、自评，收益远小于风险 |
| D4-07 | Minor | 共享核验脚本 `/tmp/p3fix/plan-blocks.mjs` 的 hint 正则 `(?:js\|html\|css\|sql\|json)` 里 `js` 排在 `json` 前面 ⇒ `web/seed/demo-data.json` 的 hint 被截成 `web/seed/demo-data.js` ⇒ 该块永远显示「无实现」 | `node /tmp/p3fix/plan-blocks.mjs <plan> <platform>` 输出：`行 3020 \| web/seed/demo-data.js \| 无实现` | 本 Task 另用 `/tmp/p6-mutate/t4-verify-blocks.mjs`（按**块正文内容锚点**定位，不靠 hint 猜文件名）逐字核验两个块 ⇒ 均 ✅。**共享脚本本身不动**（它是 P1/P3 的既有工具，不在本 Task 归属内） |

### C. 逐字回写位置（本轮改动的计划代码块）

| 计划位置 | 改动 |
|---|---|
| Task 4 Files 段 | 追加「实施补记」（规格 9 个用例逐字保留 + 追加 11 个判别性用例） |
| Task 4 Step 1 的 `platform/test/demo-seed.test.js` 代码块 | **整体回写**（规格 9 个用例逐字保留 + 追加 11 个 + 文件头 4 行领域层 import 与溯源注释） |
| Task 4 Step 3 的 `web/seed/demo-data.json` 代码块 | **整体回写**（D4-01 删 `track_fit`、D4-02 自评席对齐、D4-03 证据合规、expectations 增补 4 键） |
| Task 4 Step 4 的 Expected | `8` → **20**（实跑值） |
| Task 4 Step 5 的命令 | 补 `-- <paths>`（D4-04） |

> 回写脚本 `/tmp/p6-mutate/t4-plan-rewrite.mjs`：**按块在文档里的位置升序**处理，
> 锚点用**块正文内容**（不是行号猜测）定位，命中数必须 === 1，否则报错退出。

### D. 实跑证据

| 项 | 结果 |
|---|---|
| 基线全量（实施前，本 worktree） | **937 / 937**（936 通过 + 1 跳过 + 0 失败） |
| 规格原样种子 + 规格自带用例 | **8 个用例：7 通过 / 1 失败**（红的那条即 D4-01） |
| 规格原样种子的引擎探针 | 同分两队总分差 **0.0139378046**；破同分链只到 `total` 级（**没有 `peer`**）；行为分全 0（D4-02 / D4-03） |
| 修正后种子的引擎探针 | 同分两队总分差 **0.0000000000**（六个席位分逐维相等）；破同分链 `total` → **`peer`**（`usedBy:["t_alpha","t_beta"]`）；行为分 17 / 2 / 5 / 7 / 0 |
| 单文件 `node --test test/demo-seed.test.js` | **20 / 20 全绿** |
| 全量 `node --test` | **957 / 957**（956 通过 + 1 跳过 + 0 失败；基线 937 + 本 Task 20） |

### E. 变异测试（脚本 `/tmp/p6-mutate/t4.mjs`，指向**已落地**的测试文件）

| 轮次 | 变异体总数 | KILLED | SURVIVED | 脚本错误 | 处置 |
|---|---|---|---|---|---|
| 第 1 轮 | 22 | 21 | 1 | 0 | 存活者 M19「行为分事件被删光」**其实没改到行为**（把 `first_demo` 证据里的 `artifact` 字段删掉，而该类型**没有证据要求** ⇒ 仍计 10 分）⇒ 改成**真删掉那条事件**后重杀 |
| 第 2 轮 | **24** | **24** | **0** | 0 | M19 改成**真删事件**（重杀）；M14 换成「同分两队的企业确认分不同」（原来那个没改到行为）；追加 M23（自由命题队改挂赛道）/ M24（某队没有互评） |

**最终：24 个变异体，24 个 KILLED，0 个存活，0 个脚本错误（锚点全部唯一命中）。**

> ⚠️ 方法说明：变异体**只改「某个分支的触发数据」**（种子是本 Task 的产物），
> 每个变异体都**真的改变引擎行为**（改完后的总分 / 告警 / 破同分 / 段位 / 行为分至少有一项不同），
> 且**只改有效数据**（不改注释）。锚点命中数必须 `=== 1`，命中 0 次报「锚点失效」、
> 命中 ≥2 次报「锚点不唯一」—— 脚本不放过含糊。变异体清单见脚本里的 `MUTANTS` 数组，
> 明细 JSON：`/tmp/p6-mutate/t4-results.json`。

### F. 计划块逐字核验

`node /tmp/p6-mutate/t4-verify-blocks.mjs` → **2/2 逐字一致**：

| 块 | 结果 |
|---|---|
| `test/demo-seed.test.js` | 整文件块 ✅ 一致（359 行） |
| `web/seed/demo-data.json` | 整文件块 ✅ 一致（110 行） |

### G. 种子覆盖的分支清单（本 Task 的核心交付）

| # | 分支（规则出处） | 种子里的哪条数据触发它 | `expectations` 里写了什么 | 引擎里的可观测结果（实跑） |
|---|---|---|---|---|
| 1 | **z-score 宽严归一化降级**（S7 §3.1 + C-05） | `j_partial` 只给 `t_gamma` 打了 `feasibility` 一项（样本数 1 < `minSamplesForJudgeNormalization`=5） | `unnormalizedDimension: "feasibility"`、`unnormalizedJudge: "j_partial"` | 告警 `normalization_fallback`（点名 `j_partial:judge_sample_too_small`）+ `trace.normalization.feasibility.normalized=false` |
| 2 | **去极值**（S7 §3.2，评委数 ≥5） | 每个维度 5 位评委各交 5 队分（≥ `minJudgesForTrim`=5） | `trimmedDimensions: ["innovation","feasibility","completeness","collaboration"]` | `trace.steps` 里 20/20 个 (队,维度) 单元 `trimmed=true`，并记录被去掉的最高/最低分评委 |
| 3 | **R2 缺双签 → 企业项按 0 分计**（S7 §2.4 R2） | `ec_gamma`（t_gamma）的 `crossJudgeId: null` | `missingDualSignatureTeam: "t_gamma"` | 告警 `R2_missing_dual_signature`；`t_gamma.seatE === 0`（权重保留） |
| 4 | **R4 自由命题 → 企业项改由评委「需求真实性」维度替代**（S7 §2.4 R4） | `tp_free` 任务包 `isFreeBrief: true`，`t_epsilon` 挂在其下且**没有**企业确认 | `freeBriefTeam: "t_epsilon"` | 告警 `R4_free_brief_judge_scored`；`t_epsilon.seatE` = `feasibility` 维评委分（62.5537），且**无** `R4_substitute_no_scores` |
| 5 | **破同分链在 `peer` 级分开**（S7 §3.3 + C-03） | `t_alpha` 收到的互评 70/72（均值 71）> `t_beta` 的 60/58（均值 59） | `tiedTeams: ["t_alpha","t_beta"]`、`tiebreakSeparatedBy: "peer"` | 两队总分**严格相等**（差 `0.0000000000`）→ 破同分链 `applied` 含 `{"key":"peer","usedBy":["t_alpha","t_beta"],"separated":true}` → alpha 第 1、beta 第 2 |
| 6 | **破同分键不可用 ⇒ 显式告警，不静默当 0**（ranking.js 设计） | 种子没有 `tiebreakExtra` 字段（结构表里没这个键）⇒ 「加时陈述复议分」这一级不可用 | （无独立键；由 `tiebreakSeparatedBy: "peer"` 间接约束） | 告警 `tiebreak_key_unusable`（本组不用该键），链继续走到 `peer` |
| 7 | **自评差异 · 高 → 书面说明且对齐不加分**（S7 §4.3 + R-JDG-13） | `t_delta` 自评 `innovation` 95（评委均分 76，d=+19 > 10） | `selfEvalWrittenExplanationTeam: "t_delta"` | 告警 `self_eval_written_explanation`（**恰好 1 支队**）；`t_delta` 的 `self_eval` 席分 = 评委该维分 76.1602（**不是**自评原分 95 ⇒ 不是加分项） |
| 8 | **自评差异 · 低 → 评委提问（只提问不改分）**（S7 §4.3） | `t_gamma` 自评 `innovation` 50（评委均分 65.2，d=−15.2 < −10） | `selfEvalJudgeQuestionTeam: "t_gamma"` | 告警 `self_eval_judge_question`（**恰好 1 支队**） |
| 9 | **自评差异在阈值内 → 不告警、不影响** | `t_alpha` / `t_beta` 自评 85（评委均分 81，d=+4 ≤ 10） | `selfEvalWithinThresholdTeams: ["t_alpha","t_beta"]` | 两队均**不**出现在两类自评告警里；且两队自评席分相同（85）⇒ 这是它们能严格同分的前提 |
| 10 | **某维度无人打分 → 权重记 0 + 告警，不静默当 0**（设计文档 §13 降级表） | `t_epsilon` **没有**自评记录 ⇒ `self_eval` 维度无分 | `missingSelfEvalTeam: "t_epsilon"` | 告警 `dimension_no_scores`（维度 `self_eval`）；`perDimension.self_eval.mean === null`，且 `seatP` 的分母**剔除了**该维度（与「静默当 0」的结果不同） |
| 11 | **段位判定（里程碑计数 + 数据/原型 + 业务部门签字）**（S10 §2.2 + R-PTS-01~04） | 5 支队伍的 `milestones` 分别是 2/1/3/5/0 个；`t_delta` 的 `pilot_contract` 有 `业务部` 签字（`isBusinessDepartment: true`） | `tiers: {t_alpha:B, t_beta:C, t_gamma:A, t_delta:S, t_epsilon:D}` | `computeTier` 复算 5 支全中（`milestones=5` + `business_signoff=1` ⇒ `t_delta` 落 S 段） |
| 12 | **行为分：证据合规才计分**（S10 §3.1 + R-STG-04 + R-PTS-10） | 8 条 `behaviorEvents`，`evidence` 逐条满足 `criteria.behaviorEvidence` | `behaviorScores: {t_alpha:17, t_beta:2, t_gamma:5, t_delta:7, t_epsilon:0}` | `behaviorScore` 复算 5 支全中；`first_demo`（`once:true`）只计一次 |
| 13 | **行为分不进入总分（分轨在算法层）**（S10 §3.3 + R-PTS-08） | 改动全部行为事件的证据后重算 | （由「行为分不进入总分」用例守住） | 改行为事件前后 5 支队伍的总分**逐字相同** |
| 14 | **评委席宽严差异被归一化抵消**（S7 §2.1 机制归因） | `j_lenient` 普遍给高分、`j_strict` 普遍给低分（同一队的两档评委差 14 分） | （无独立键；由「同分两队总分严格相等」间接守住） | `t_alpha` / `t_beta` 的四个评委席维度分**逐维相等**（81.2788 / 80.2047 / 79.3845 / 83.5182） |

### H. 遗留 / 需上游注意

1. **Task 5 读种子必须按「决赛维度表」读**：`reviews` 里只可能出现 `rules.scoring.final.dimensions` 的
   评委席 key（`innovation` / `feasibility` / `completeness` / `collaboration`）；
   `enterprise` 维度走 `enterpriseConfirmations`，`self_eval` 维度走 `selfReviews`。
   **不要**再往种子里加 `track_fit`（那是初赛维度，决赛不计分）。
2. **`expectations` 增补了 4 个键**：`selfEvalWithinThresholdTeams` / `missingSelfEvalTeam` /
   `trimmedDimensions` / `behaviorScores`。规格原有的 **9 个键一个没动**，
   只有 `selfEvalWrittenExplanationTeam` 的**值**由 `t_alpha` 改为 `t_delta`（理由见 D4-02）。
3. **破同分链在 `tiebreak_extra`（加时陈述复议分）这一级会出一条 `tiebreak_key_unusable` 告警** ——
   种子没有 `tiebreakExtra` 字段（结构表里没有这个键）⇒ 该级不可用、**不静默当 0**（引擎的正确行为）。
   演示时应当显式展示这条告警，它正好说明「链上每一级都要有可比较的值」。
4. **行为分达标线 60 分没有任何一支队达到**（最高的 `t_alpha` 也只有 17）⇒ 演示里「完赛认定」恒为 false。
   这是数据的真实状态，不是 bug；要演示该分支需要更多行为事件（`weekly_progress` 每次只 2 分）。
5. **`t_alpha` / `t_beta` 的同分是「构造出来的」**：`reviews` 逐维相同 + 企业确认同分 + 自评同分 + 同一个任务包。
   少任何一样都会被某一张席拉开 —— 这正是 D4-02 的教训，演示时可以顺带讲这一条。

## Task 5 实施台账（2026-10-21）

> 本节是 Task 5（演示版适配器 · 浏览器内真实运行规则引擎）的实施记录：
> **规格缺陷清单**、处置方式、逐字回写位置、实跑证据、parity 测试的**具体比对方式**、变异测试，
> 以及**未改且需上游注意**的项。
> 纪律：本计划 Task 5 的 **3 个代码块 = 最终实现的逐字副本**
> （核验命令：`node /tmp/p6-mutate/t5-verify-blocks.mjs`）。
>
> **本 Task 的灵魂**：演示版 = 静态站 + 浏览器内跑【同一套规则引擎】⇒
> 「演示好看、正式不一样」这件事必须被**机器**挡住 —— 这就是 `demo-parity.test.js` 的职责。
> ⇒ 本 Task 的核心交付**不是**「适配器能跑」，而是**「浏览器里跑的引擎 ≡ Node 里跑的引擎」这件事有断言守着**。
>
> ⚠️ **领域层一行没改**：`platform/src/domain/**` 与 `platform/rules/**` 是 P1–P3 的产物，
>    本 Task 只**消费**它们（浏览器里 import 的是同一批文件）。这是「演示 = 正式」的根本保证。

### A. 实施方法（先跑后落盘）

1. 把规格 Task 5 的三个代码块**原样抽到** `/tmp/p6-t5/spec/`（一个字节都没改）。
2. 在 `/tmp/p6-t5/scratch/platform`（platform 整树副本）上跑**规格自带用例** → 红 2 条（D5-01 / D5-02 的实证）。
3. 逐条定位规格缺陷 → 在 scratch 上改实现与用例 → 跑通（含 P0 的 `leaderboard-web.test.js` 断链）。
4. 才落盘到 worktree → 单文件 → 全量 → 变异测试 → 计划块逐字回写与核验。

### B. 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| D5-01 | **Critical** | 规格的 `runDemoCompute` 把**企业席告警并了两次**：`scoreStage()` 内部已经调过一次 `applyEnterpriseRules` 并把 `ent.warnings` 并进自己的 warnings，规格又写了一遍 `[...scored.warnings, ...enterprise.warnings]` ⇒ 规格自带的 parity 用例（`deepEqual(demo.warnings, direct.warnings)`）**必然红** | 规格原样副本上跑：13 个用例 11 通过 / 2 失败；parity 用例的 `deepStrictEqual` 失败，demo 侧多出 `R2_missing_dual_signature`、`R4_free_brief_judge_scored` 两条 | `warnings` 只取 `scored.warnings`（= 正式引擎的返回）；企业席明细（`seatE` / `weights`）仍单独跑一次 `applyEnterpriseRules` —— 纯函数，只为展示，**不参与计分** |
| D5-02 | **Critical** | 规格的**用例与规格的实现对 401 的口径自相矛盾**：用例写 `assert.equal(me.status, 401)`（要求**返回**一个对象），实现是 `throw httpError(401, ...)`（**抛错**） | 规格原样副本上 `demo-engine` 的「完整流程」用例红在 `未登录`（抛错 ⇒ 用例拿不到返回值） | 口径取**抛错**：真实后端 `web/api.js:14-19` 在 `!res.ok` 时抛错，前端 `web/app.js:74-82` 的 `restoreSession()` 也靠 `catch` 兜 401 ⇒ 抛错才与正式系统一致。用例改成 `assert.rejects(..., (err) => err.status === 401 && err.code === 'UNAUTHENTICATED')` |
| D5-03 | **Critical** | 规格实现把**段位榜 / 滚动总榜的静态段路由丢了**：`/api/leaderboard/tier` 落到通用分支 ⇒ `scope` 变成 `'rank'`。这与 P0 的 `leaderboard-web.test.js`（断言 `tier.scope === 'tier'`）、后端 `src/server.js:153-161`（静态段优先于参数段）、以及 **P0 桩里专门写下的警告**（「顺序要紧：`tier` 必须排在 `/api/leaderboard/` 之前」）都冲突 | 规格原样副本上 P0 的 `leaderboard-web.test.js` 在 `/api/leaderboard/tier` 处拿到 `scope: 'rank'` | 补两条**显式分支**（`tier` / `rolling` 排在参数段之前，注释保留 P0 的顺序警告）；另新增 `demoTierBoard` / `demoRollingLeaderboard` 两个榜，形状分别对齐 `src/services/tier.js getTierBoard` 与 `src/services/leaderboard.js getRollingLeaderboard` |
| D5-04 | **Critical** | 规格的默认组长取**登录用户** `demo_admin`，而它不在种子的 `users` 表里 ⇒ `rules/team-formation.json` 的 `captainMustBeMba` 判定必然失败（`组长不存在`）⇒ 规格自带的「完整流程」用例必然 400 | 规格原样副本上「完整流程」用例红在组队那一步（TEAM_FORMATION_INVALID） | 新增 `defaultCaptainId()`：默认组长 = **成员里第一位 MBA 在籍者**，找不到才回落登录用户。组队规则本身一字未改（组长必须 MBA 仍是硬门槛） |
| D5-05 | **Critical** | P0 的 `leaderboard-web.test.js` 用的是演示适配器的**默认导出**（走 `fetch` 取种子）—— Node 的 `fetch` 不认相对 URL ⇒ `Failed to parse URL from ./seed/demo-data.json` ⇒ P0 用例必红 | 规格原样副本上全量：1013 例 / 1012 通过 / **1 失败**（就是这条） | **本 Task 唯一一处动 P0 测试**：该用例改为用 `createDemoApi({ storage, seed, rules })` **显式注入**种子与规则。断言一条没少，还多了两条（段位榜 / 滚动总榜必须真有队伍）。默认导出在浏览器里照旧可用（`web/app.js` 的 `?demo=1` 分支不受影响） |
| D5-06 | **Important** | 战绩卡**形状与正式系统不一致**：规格返回 `{teamId, teamName, tier, milestoneCount, businessSignoffCount, items, behavior}`；正式系统 `src/services/performance-card.js` 返回 `{teamId, teamName, taskPackageId, items[{key,label,achieved,signed}], achievedCount, total, tier, benefits, neverUnlocks}`。前端 `web/views/card.js` 渲染 `achievedCount` / `total` / `benefits` / `neverUnlocks` / `signed` ⇒ 照规格实现前端会**渲染成空** | `web/views/card.js:5-12` 逐字段比对 | 对齐正式系统的形状（取**超集**：多出的字段不影响前端，少的字段会让前端渲染空） |
| D5-07 | **Important** | 段位榜 / 滚动总榜缺字段（`tierRank` / `progress` / `points` / `stages` / `bestRank`）—— 与 D5-06 同理（`web/views/tier.js` 渲染 `r.tierRank` 与 `selfProgress.progress.milestones`） | `web/views/tier.js:7-13` 逐字段比对 | 同 D5-03：新增两个榜函数，形状对齐正式服务 |
| D5-08 | **Important** | 规格让适配器**采信种子里预置的** `isDataOrPrototype` / `isBusinessDepartment` 标志；真实系统是在**服务层按 `rules.criteria` 推导**的（`src/services/tier.js` + 领域层 `classifyDepartment` / `isDataOrPrototypeMilestone`）⇒ 种子里的标志一旦写错，**演示段位与正式段位就漂移** | `src/services/tier.js` 的 `isBusinessDepartment ← 部门关键词 + unknownDepartmentCountsAsBusiness`；`src/domain/tier.js:9-30` 两个纯函数 | 适配器改为**按 `rules.criteria` 推导**（复用领域层那两个纯函数），并加**判别性用例**：把种子里与 criteria 矛盾的标志改掉，段位必须仍按 criteria 走 |
| D5-09 | **Important** | 规格把**破同分链的告警整个丢了**（`runDemoCompute` 不返回 `ranked.warnings`）⇒ 演示版看不到「破同分键不可用」告警 —— 而 Task 4 台账 §H-3 明确要求「演示时应当显式展示这条告警」；且与正式系统 `src/services/leaderboard.js:129-135` 的告警口径（计算告警 + 破同分告警，各带 `source` 标签）不一致 | `src/services/leaderboard.js:129`（`source: 'computation'`）与 `:135`（`source: 'tiebreak'`） | 新增 `tiebreakWarnings` 字段（parity 断言的 `warnings` 仍只含计算告警，口径不变）；榜单层按正式口径**合并**并打 `source` 标签 |
| D5-10 | **Important** | 规格的 `buildDemoState` 是**浅拷贝** ⇒ `state` 直接持有调用方种子的引用 ⇒ 适配器的**写路径**（打分 / 组队 / 报名）会改到种子本身 ⇒「同一份种子算出同一份结果」这条前提当场失效 | 规格原样副本上实测：e2e 用例的 `POST /api/stages/.../reviews` 把种子里 `j_lenient / t_alpha / innovation` 从 88 改成 91，**后续用例全被污染**（破同分告警用例、互评判别性用例连着红） | `buildDemoState` 对种子做 **JSON 往返深拷贝**（零依赖、浏览器与 Node 行为一致）；并加一条专属用例直接断言「写路径不得改到调用方的种子对象」 |
| D5-11 | Minor | 存储键从 P0 的 `hks_demo_db` 改成 `hks_demo_store_v1` | P0 桩：键 `hks_demo_db`，结构 `{me, leaderboard, tiers, milestones, warnings}` | **改**（已改）：P0 桩的结构与新适配器完全不同（新的有 `teams` / `reviews` / `computations` / `results` …），旧键的数据无法复用；新键带版本号，便于以后改结构 |
| D5-12 | Minor | 规格的 Step 5 提交命令**不带 `-- <paths>`** —— 违反「先 `git add <paths>`，再 `git commit -m "…" -- <paths>`」这条纪律 | 规格 Step 5 原文 | 补上 `-- web/api.demo.js test/demo-engine.test.js test/demo-parity.test.js test/leaderboard-web.test.js`（`-m` 仍在 `--` 之前） |
| D5-13 | Minor | `SEED_URL = './seed/demo-data.json'` 与 `RULES_BASE = './rules/'` 的**相对基准不一致**：前者相对 `web/`（种子在 `web/seed/`），后者相对 `platform/`（规则在 `platform/rules/`）⇒ 静态站的产物目录必须**同时**满足两个基准 | 两个常量在 `web/api.demo.js` 顶部的定义 | **不改**（属 Task 6 的产物布局决策）：`loadDemoSeed(url)` / `loadDemoRules(base)` 都接受显式参数，Task 6 传对即可。登记为「需上游注意」（见 §H-2） |

### C. 逐字回写位置（本轮改动的计划代码块）

| 计划位置 | 改动 |
|---|---|
| Task 5 Files 段 | 追加 `platform/test/leaderboard-web.test.js`（P0 用例适配，见 D5-05） |
| Task 5 Step 1 的 `platform/test/demo-engine.test.js` 代码块 | **整体回写**（规格 12 个用例逐字保留，只改 `/api/me` 的 401 断言形式，见 D5-02；追加 15 个判别性用例） |
| Task 5 Step 1 的 `platform/test/demo-parity.test.js` 代码块 | **整体回写**（规格 1 个用例逐字保留 + 追加 9 个：规则同源、浏览器入口真跑、三方比对、判别性反例、黄金值、失败路径） |
| Task 5 Step 3 的 `web/api.demo.js` 代码块 | **整体回写**（D5-01/03/04/06/07/08/09/10/11 的处置全部落在这里） |
| Task 5 Step 4 的 Expected | `demo-engine 12 个 + demo-parity 1 个` → **`demo-engine 27 个 + demo-parity 10 个`**（实跑值） |
| Task 5 Step 5 的命令 | 补 `-- <paths>`（D5-12） |

> 回写脚本 `/tmp/p6-mutate/t5-plan-rewrite.mjs`：**按块在文档里的位置升序**处理，
> 锚点用**块正文内容**定位，命中数必须 `=== 1`，否则报错退出。

### D. 实跑证据

| 项 | 结果 |
|---|---|
| 基线全量（实施前，本 worktree） | **981 / 981**（980 通过 + 1 跳过 + 0 失败） |
| 规格原样三块 + 规格自带用例（独立工程 `/tmp/p6-t5/scratch`） | **13 个用例：11 通过 / 2 失败**（红的两条即 D5-01 / D5-02） |
| 规格原样副本跑全量 | **1013 例 / 1012 通过 / 1 失败**（红的那条即 D5-05：P0 的演示适配器用例） |
| 落盘后单文件 `node --test test/demo-engine.test.js` | **27 / 27 全绿** |
| 落盘后单文件 `node --test test/demo-parity.test.js` | **10 / 10 全绿** |
| 落盘后单文件 `node --test test/leaderboard-web.test.js` | **10 / 10 全绿**（P0 用例，适配后） |
| 落盘后全量 `node --disable-warning=ExperimentalWarning --test` | **1018 / 1018**（1017 通过 + 1 跳过 + 0 失败；基线 981 + 本 Task 37） |

### E. parity 测试的比对方式（浮点容差）

`platform/test/demo-parity.test.js` 比的是**三方**（不是两方 —— 两方是自证）：

| 方 | 是什么 | 怎么跑 |
|---|---|---|
| ① 浏览器入口 | `getDemoRuntime()` → `fetch` 取种子与规则 → `createDemoApi` → `POST /api/stages/stage_final/compute` | 用 `fetch` 桩把相对 URL 落到磁盘上的真实文件（`web/seed/demo-data.json` 与 `rules/*.json`），**浏览器入口代码原样执行** |
| ② Node 侧适配器 | `runDemoCompute({ state, rules, stageId })` | 直接调 |
| ③ 正式引擎 | `src/domain/scoring.js` 的 `scoreStage(...)` | 直接调（与 `src/services/compute.js` 同一形状） |

- **逐字段比对**：`teams` / `warnings` / `trace` / `ordered` / `chain` / `points` / `selfEvalFlags`
- **浮点容差**：`EPS = 1e-9` **相对**容差 —— `|a-b| ≤ EPS × max(1, |a|, |b|)`
  - ⛔ 不用 `===` 比浮点（同一份公式在不同求值顺序下的末位差异不是 bug，`===` 是**假红**）
  - ⛔ 也不用粗到没意义的容差（`1e-6` 以上会把「权重写错 0.001」这类真错放过去）
  - `1e-9` 相对容差 ≈ 分值 80 分上 `8e-8`：远小于任何真实口径差异，远大于双精度舍入噪声
- **结构严格**：数组长度、对象键集、字符串 / 布尔 / null 必须**逐字相同**（只有数字走容差）
- **规则同源**：另有一条用例断言「浏览器侧加载的 12 份配置 ≡ 正式系统 `loadRules()` 的结果」——
  抓住「浏览器加载的配置不是同一份」这类漂移（`loadDemoRules` 的文件清单与分组方式被逐字复刻在测试里）
- **判别性反例**（parity 断言必须**能失败**）：
  - 喂不同的输入（抹掉自评）⇒ 两边结果**必须**分叉 ⇒ 证明 parity 断言不是恒真
  - 名册口径改错（把自由命题队说成企业命题队）⇒ R4 不触发 ⇒ 结果**必须**分叉 ⇒ 证明引擎对 R4 敏感
- **黄金值**：`seed.expectations` 的每一条（tiedTeams / tiebreakSeparatedBy / unnormalizedDimension /
  missingDualSignatureTeam / freeBriefTeam / 自评三档 / tiers / behaviorScores）逐条核对

> ⚠️ **关于「冻结黄金值」**：本 Task **不**引入「把某支队伍的总分钉死成常量」的断言 ——
> 那会让**规则配置一改就红**，属于上游规则变更的范畴，不是本 Task 该背的债。
> 替代做法是「打分矩阵逐格相等」+「parity 三方一致」：既抓住搬运错误，又不与规则演进冲突。

### F. 变异测试（脚本 `/tmp/p6-mutate/t5.mjs`，指向**已落地**的文件）

| 轮次 | 变异体总数 | KILLED | SURVIVED | 锚点错误 | 处置 |
|---|---|---|---|---|---|
| 第 1 轮 | 25 | 23 | **2** | 0 | M10（「数据/原型」标志采信数据）**存活**：判别性用例只翻了该队**一个**里程碑的标志，而该队还有另一个带标志的里程碑 ⇒ 两种实现结果相同 ⇒ **用例数据不够判别**；M17（submissions 原始分 +1）**存活**：z-score 归一化对「全体原始分整体平移」不敏感 ⇒ 相对关系类断言抓不住它。⇒ 两条都是**用例缺陷**，不是实现缺陷 |
| 第 2 轮 | **25** | **25** | **0** | 0 | M10：判别性用例改成把该队**全部**里程碑的 `isDataOrPrototype` 翻掉（只翻一个时两种实现等价 ⇒ 抓不住）；M17：补一条「打分矩阵搬运**逐格相等**」用例（比「冻结黄金值」更稳，且不与规则演进冲突）后重杀 |

**最终：25 个变异体，25 个 KILLED，0 个存活，0 个锚点错误（锚点全部唯一命中）。**

> 变异体清单见脚本里的 `MUTANTS` 数组，覆盖本 Task 的每一个改动点：
> D5-01 回退（M01）、401 抛错（M02）、段位榜 / 滚动榜路由（M03/M04）、默认组长（M05）、
> 战绩卡形状（M06/M07/M08/M09）、段位标志按 criteria 推导（M10/M11）、破同分告警（M12/M13）、
> 种子深拷贝（M14）、破同分链输入（互评均值 M15 / 行为分 M16）、submissions 搬运（M17）、
> 名册自由命题标记（M18）、段位榜排序与可见性（M19/M20）、query 解析（M21）、
> 自评对比基准（M22）、名次积分配置（M23）、浏览器入口失败路径（M24/M25）。
> 明细 JSON：`/tmp/p6-mutate/t5-results.json`。

### G. 计划块逐字核验

`node /tmp/p6-mutate/t5-verify-blocks.mjs` → **3/3 逐字一致**：

| 块 | 结果 |
|---|---|
| `test/demo-engine.test.js` | 整文件块 ✅ 一致 |
| `test/demo-parity.test.js` | 整文件块 ✅ 一致 |
| `web/api.demo.js` | 整文件块 ✅ 一致 |

> ⚠️ 共享核验脚本 `/tmp/p3fix/plan-blocks.mjs` 的 hint 正则把 `.json` 截成 `.js`（Task 4 已登记 D4-07），
> 本 Task 的三个块都是 `.js`，共享脚本可见；为稳妥另用按**块正文锚点**定位的 `t5-verify-blocks.mjs` 复核。

### H. 未改且需上游注意的项

1. **Task 6 的 `scripts/build-demo.js` 必须把 `src/domain/**` 与 `rules/**` 原样拷进产物目录** ——
   演示适配器用**相对路径** import 领域层（`../src/domain/scoring.js`），产物目录里没有这些文件浏览器就加载不了。
   同时它要强制校验「领域层不得 import Node 内置模块」——
   **这条本 Task 已经用静态断言守住了**（`demo-engine.test.js` 的「浏览器可加载性」用例：
   扫 `web/api.demo.js` + 11 个领域层模块，任何 `node:` 或非相对 import 都会红）。
2. **产物目录的相对基准**：`SEED_URL = './seed/demo-data.json'`（相对 `web/`）与
   `RULES_BASE = './rules/'`（相对 `platform/`）**基准不同**（D5-13）⇒
   Task 6 摆产物目录时必须同时满足两个基准，或者在 `index.html` 里显式传 `loadDemoSeed(url)` / `loadDemoRules(base)`。
3. **领域层与规则配置一行没改**：`platform/src/domain/**`、`platform/rules/**` 本 Task 只读不改 ——
   这正是「演示 = 正式」的根本保证（改领域层会同时波及正式链路）。
4. **`platform/src/server.js` 没改**：`DEMO_MODE=1` 才挂 `/src/domain/*` 与 `/rules/*` 那道门保持原样（默认不挂 ⇒ 正式部署 404）。
   ⚠️ 本 Task 的适配器在文件头**显式写明**了「静态站把领域层原样拷进产物目录」与「后端那条 Demo 门」是**两条不同的路**：
   静态站是**独立产物**，不与正式部署共用 nginx / systemd ⇒ 领域层源码只出现在演示站上。
5. **演示版数据不跨人共享**（各自浏览器 localStorage 独立）—— 无云主机条件下的客观边界，
   已写进 `web/api.demo.js` 的文件头与本台账；正式版后端仍要按云主机部署资产准备好（Task 2）。
6. **`web/api.demo.js` 的默认导出在 Node 里不可用**（`fetch` 不认相对 URL）⇒
   Node 侧（测试 / 离线脚本）请用 `createDemoApi({ storage, seed, rules })` 显式注入；浏览器侧照旧用默认导出。
7. **本 Task 只改了 P0 的一个测试文件**（`test/leaderboard-web.test.js` 的演示适配器用例，D5-05）：
   断言一条没少、还多了两条；改动原因是 P0 桩被真实适配器取代 ⇒ 假数据桩的用法不再成立。

## Task 7 实施台账（2026-10-21）

> 本节是 **P6 Task 7（部署与运维文档 `docs/deployment.md`）** 的实施记录：
> 规格缺陷清单与处置、实跑证据、手册与 **F-1 ~ F-4** 的逐条对账结果、**未覆盖的项与理由**。
>
> **编号约定**：本计划已有四个台账用过 `D-` 开头且已重编号为 `D1-*`（Task 1）/ `D2-*`（Task 2 预审）/
> `D3-*`（Task 3）/ `D4-*`（Task 4）；**本轮用 `D7-*`**。
> 手册 `docs/deployment.md` 内部的「未覆盖项」表用 `U-*` 编号（`U-1` ~ `U-7`），
> **与本台账的 `D7-*` 是两套编号，不要混用**。
>
> **产出边界**：本 Task **只创建 `docs/deployment.md`**（+ 追加本台账）。
> **没有碰** `platform/` 下的任何代码、部署资产、测试。

### A. 规格缺陷清单与处置

| # | 级别 | 规格缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| D7-1 | **Important** | **计划 Task 7 的骨架把 §5 的演示版构建命令写成了「现在就能跑」** —— 但 `scripts/build-demo.js` / `scripts/serve-demo.js` 是 **P6 Task 6** 的产物，此刻**尚未落地** | `ls platform/scripts/build-demo.js` → `No such file or directory`；`scripts/serve-demo.js` 同样不存在；`ls -d platform/web/dist platform/web/assets` → 两个都不存在 | **计划代码块逐字保留**（不改规格），但手册顶部加「**阅读须知**」明确声明：§5 的两条命令**此刻跑不通**，§8.5 写全了 Task 6 落地后的**构建 / 产物位置 / 本地预览 / 扫描闸 / 发布**流程 + 一张状态声明表 |
| D7-2 | **Important** | **计划 §2.2 的 `install.sh` 步骤清单没有反映 F-2 / F-3 / F-4 修复后的行为**（清单里没有 nginx 前置检查、没有失败回滚、没有版本自动降级、没有绝对过期天数字段） | 逐条对读 `platform/deploy/install.sh`：`require_nginx` 在 `main()` **最前**（第 341 行）→ `validate_session_ttls`（342）→ … → `write_nginx_site`（358）先跑兼容脚本、再备份旧站点、再 `if ! nginx -t` | 计划代码块逐字保留；手册 **§8.1 – §8.4** 逐条写清修复后的真实行为，**每条都带实跑输出** |
| D7-3 | **Important** | **计划 §1 的环境变量清单不全** —— 只列 `PORT` / `DATA_DIR` / `SESSION_TTL_DAYS`，漏了 `SESSION_ABSOLUTE_TTL_DAYS` | `src/auth/session.js` 第 23 行 `DEFAULT_ABSOLUTE_TTL_DAYS = 30`，第 36 行读 `process.env.SESSION_ABSOLUTE_TTL_DAYS`；F-3 后 `install.sh` 的 `write_env_file()` 也显式写它 | 计划代码块逐字保留；手册 **§10** 给出完整速查表（**9 个变量** + 「改了怎么生效」列 + 端口 8080 的「四处同一口径」清单） |
| D7-4 | **Critical（后果安全）** | **`nginx-http2-compat.sh` 的 `detect_version()` 解析不了真实 nginx 的版本输出** —— 脚本用 `sed -n 's\|^nginx version: \([0-9][0-9.]*\).*\|\1\|p'`，要求版本号**紧跟** `nginx version: ` 后是一个数字；而 nginx 的**真实输出**是 `nginx version: nginx/1.24.0`（版本号前带 `nginx/` 前缀）⇒ **匹配不到** | `printf 'nginx version: nginx/1.24.0\n' \| sed -n 's\|^nginx version: \([0-9][0-9.]*\).*\|\1\|p'` → **空**；沙箱里跑完整 `install.sh`，兼容脚本打印「**[nginx-compat] nginx 未探测到（按需降级处理）** < 1.25.1：已降级为 `listen ... ssl http2;`」 | 手册 **§8.1 如实写明**：真机上自动探测**总是失败** ⇒ 总是走保守降级；**后果安全**（`listen ... ssl http2;` 在**所有**版本都合法，部署不会因此失败）；但「≥ 1.25.1 保留 `http2 on;`」这条分支在真机上**只有显式给 `NGINX_VERSION` 才走得到**。**本 Task 不修**（`platform/` 不在本 Task 归属内）—— 一行修法写进手册 §8.1 与本台账 E 节，供上游处理 | ⛔ **后续（2026-10-21，父代理修复轮）已修**：解析式改为 `s\|^nginx version: *\(nginx/\)\{0,1\}\([0-9][0-9.]*\).*\|\2\|p`（POSIX BRE，BSD/GNU sed 都认），并补了走**真实自动探测路径**的回归用例（假 `nginx` 放 `PATH`、输出官方格式版本号、不给 `NGINX_VERSION`）—— 变异体 M12（把解析式改回旧写法）被该用例杀掉 |
| D7-5 | Minor | **计划 §2.4 没提 `network_mode: host` 在 Docker Desktop（macOS / Windows）上宿主仍不通** | `deploy/docker-compose.yml` 第 26–27 行自己写明「host 网络只保证 Linux 宿主机的语义；Docker Desktop（macOS/Windows）上容器拿到的是 Linux 虚拟机的网络栈，宿主机 127.0.0.1:8080 仍不通」 | 计划代码块逐字保留；手册 §13 **U-2** 登记为边界（本 Task 环境无 Docker daemon，未实跑） |
| D7-6 | Minor | **计划 Task 7 Step 2 的期望值 `backup()` = 2 与最终文件实际 3 不符** | `grep -c "single writer at a time" docs/deployment.md` → `1`；`grep -c "proxy_buffering off"` → `1`；`grep -c "backup()"` → `3` | 计划写的是「三个数字都 ≥ 1」，`3 ≥ 1` **通过**。**不为了凑「2」而删内容**（第三个 `backup()` 出现在 §8.1/§12 的实跑证据上下文里） |
| D7-7 | — | **计划 Task 7 的代码块与最终文件的对应关系需要写清** | 程序化核验：计划第 5259–5470 行（`markdown` 围栏内）在 `docs/deployment.md` 里是**逐字连续**的片段（起始字节下标 **963**）；§0 段（`## 0.` → `## 1.`）单独核验同样**逐字包含** | **不改计划规格**（计划块原样保留）；补写内容**全部**落在手册 §8 – §14。计划文档本身只**追加**了本台账一章，**未改动** Task 7 的代码块 |

### B. 实跑证据（2026-10-21）

> 全部在**临时目录**（`mktemp -d`）里做，不碰工作树的库文件。
> 环境：macOS（darwin 27.0.0 arm64）、Node **v22.23.2**、**本机没装 nginx**
> （正好用来验证降级路径与「探测不到版本」的保守路径）。

| # | 跑了什么 | 观察到 |
|---|---|---|
| E1 | `cd platform && node --disable-warning=ExperimentalWarning --test` | **981 例 / 980 通过 / 0 失败 / 1 跳过**（基线 981/981） |
| E2 | `cd platform && node scripts/audit-scan.js` | **退出码 0**（词条 15 条、扫描 142 个文件、0 违规） |
| E3 | `DATA_DIR=<tmp>/data node scripts/migrate.js` | `迁移完成，当前版本 5`（本次应用 001–005 五个迁移） |
| E4 | `node scripts/seed.js` 连跑两次 | 第一次「已创建管理员：13800000000」，第二次「管理员已存在」⇒ 幂等 |
| E5 | `node scripts/backup.js` / `--out` / `--keep-days --keep-count` | 全部退出码 0；输出 `[backup] 完成：app-<UTC>.db（<字节> 字节，<页> 页）` |
| E6 | `node scripts/restore.js`（活 pid / pid 文件坏 / 成功） | 活 pid ⇒ **拒绝**（`服务仍在运行，拒绝恢复（pid 文件显示进程 N 仍在运行）`）；pid 不可解析 ⇒ **保守判为在跑并拒绝**（`pid 文件存在但内容无法解析，无法确认服务已停止`）；成功 ⇒ 旧库留存 + **删旧 `-wal` / `-shm`** + 新库就位 |
| E7 | `node src/server.js` + `curl -s http://127.0.0.1:8080/api/health` | `{"ok":true,"at":"2026-10-21T08:04:57.542Z"}`；启动日志 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）` |
| E8 | `bash deploy/nginx-http2-compat.sh` × 4 个 `NGINX_VERSION` + 不探测 | 1.18.0 / 1.24.0 ⇒ **双 listen 行都降级**；1.25.1 / 2.0.0 ⇒ **保留 `http2 on;`**；不探测 ⇒ 降级（**端口 80 的 listen 不受影响**） |
| E9 | 沙箱 `install.sh`：**PATH 里没有 nginx** + 设了 `SERVER_NAME` | 退出码 **1**，错误信息明确，**沙箱目录零改动**（`find` 结果为空）⇒ F-2 前置检查**在动任何东西之前**就拒绝 |
| E10 | 沙箱 `install.sh`：`SESSION_TTL_DAYS=abc` / `SESSION_ABSOLUTE_TTL_DAYS=0` / `SESSION_TTL_DAYS=3.5` | 三次都退出码 **1**、**沙箱目录零改动** ⇒ F-3 的 fail-fast **在动任何东西之前**就拒绝 |
| E11 | 沙箱 `install.sh`：**完整部署**（nginx 桩 = 1.24.0） | 退出码 **0**；环境文件 = `PORT` / `DATA_DIR` / `SESSION_TTL_DAYS=7` / **`SESSION_ABSOLUTE_TTL_DAYS=30`** / `NODE_ENV=production`；站点配置**自动降级**成 `listen 443 ssl http2;` + `listen [::]:443 ssl http2;`；`alias .../web/assets/` 是**预留位** |
| E12 | 沙箱 `install.sh`：**连跑两次** | 两次退出码 **0**；第二次「本次无新迁移」「管理员已存在：13800000000」⇒ **幂等** |
| E13 | 沙箱 `install.sh`：`nginx -t` 失败（**有旧配置** / **无旧配置**） | 有旧 ⇒ `已回滚到上一版 nginx 站点配置` 且站点文件内容回到部署前；无旧 ⇒ `已撤销本次 nginx 站点配置（此前没有旧配置）` 且**站点文件与软链都不存在**、`sites-enabled/` 为空 |

> 沙箱做法：`PATH` 里放 `id`（`id -u` 返回 0，模拟 root）/ `nginx` / `systemctl` / `useradd` / `runuser` 五个**桩命令**，
> 并把 `APP_DIR` / `DATA_DIR` / `ENV_FILE` / `NGINX_SITE` / `NGINX_LINK` / `SYSTEMD_UNIT_DIR` 全部指向 `mktemp -d` 出来的临时目录 ——
> **真机路径（`/opt` / `/etc` / `/var`）一个字节都没被写到**。

### C. 手册与 F-1 ~ F-4 的逐条对账

| 修复项 | 修复后的真实行为（实跑取证） | 手册写在哪 | 对账结论 |
|---|---|---|---|
| **F-1** 前端产物目录口径 | 唯一构建产物目录 = `platform/web/dist/`（Task 6 的 `build-demo.js --out web/dist` 产出，**走独立发布通道，不经 nginx**）；nginx 的 `location /assets/ { alias __APP_DIR__/web/assets/; }` 是**预留**的带哈希静态资源位，**本仓库无任何构建步骤产出它**，目录不存在时该前缀返 404、不影响其它路径；`install.sh` 的 rsync **两个都排除** | 手册 **§8.4**（含一张「目录 / 是什么 / 由谁产出 / 走不走 nginx」对照表） | ✅ 一致。**手册没有把 `web/assets/` 说成「构建产物目录」** |
| **F-2** nginx 前置检查与回滚 | `require_nginx()` 在 `main()` **最前**（动任何东西之前）⇒ 缺 nginx **当场明确拒绝**；`nginx -t` 失败 ⇒ 有旧配置就 `mv` 还原、没旧配置就**撤销站点文件与软链** ⇒ 坏配置不会留在 `sites-enabled` 里毒化下一次 reload | 手册 **§8.2**（两条分支各带实跑输出 + 事后 `sites-enabled/` 为空的核对） | ✅ 一致 |
| **F-3** 会话环境变量 | 环境文件**显式**写 `SESSION_ABSOLUTE_TTL_DAYS`（默认 **30**，与 `src/auth/session.js` 的 `DEFAULT_ABSOLUTE_TTL_DAYS` 同源）与 `SESSION_TTL_DAYS`（默认 **7**）；两个天数**必须是正整数**，否则 `install.sh` **fail-fast 报错**（代码侧是静默回退到默认值，环境文件写错没人会发现）；**改完必须重启服务**（systemd 在服务启动时读 `EnvironmentFile`） | 手册 **§8.3**（完整说明 + 「改了怎么生效」的命令 + 确认生效的查法）、**§10**（速查表） | ✅ 一致 |
| **F-4** nginx 版本 | **已自动化，不需要人手工改语法**：`install.sh` 先跑 `deploy/nginx-http2-compat.sh`，按**目标机**的 nginx 版本自动决定：≥ 1.25.1 保留 `http2 on;`、< 1.25.1 自动降级成 `listen ... ssl http2;`（所有版本都合法）、探测不到时按需降级（保守）；`NGINX_VERSION` 可覆盖探测结果（用于预演 / 测试） | 手册 **§8.1**（含决策表、查版本的方法、`NGINX_VERSION` 覆盖用法、4 个版本的实跑输出） | ✅ 一致 —— **自动探测的解析缺陷已由父代理修复轮修掉**（D7-4）：原解析匹配不到 `nginx/1.24.0` 这种真实格式，现在带前缀/不带前缀两种形态都吃下，并有走真实探测路径的回归用例钉住（见手册 §8.1） |

### D. 计划块核验结果

| 核验项 | 结果 |
|---|---|
| 计划 Task 7 的 `markdown` 代码块（计划第 5259–5470 行）在 `docs/deployment.md` 里**逐字连续**存在 | ✅ 是（起始字节下标 **963**；块前 30 行 = 阅读须知，块后 504 行 = §8–§14） |
| §0 段（`## 0. 三条必须先知道的硬约束` → `## 1. 本地 / 内网`）**逐字**包含 | ✅ 是 |
| 计划 Task 7 Step 2 的验收命令 | `single writer at a time` → **1**；`proxy_buffering off` → **1**；`backup()` → **3**（计划期望 1 / 1 / 2，判据是「都 ≥ 1」⇒ 通过；见 D7-6） |
| 计划 Task 7 的代码块**本身有没有被改** | ❌ **没改**（只追加了本台账一章） |
| `docs/deployment.md` 是不是唯一产出 | ✅ 是（本 Task 只新增这一个文件 + 追加本台账；**`platform/` 下一个字节都没动**） |

### E. 遗留（交给上游，本 Task 不处理）

- **D7-4 是唯一的代码级遗留**：`deploy/nginx-http2-compat.sh` 的 `detect_version()` 解析不了真实 nginx 的
  `nginx version: nginx/1.24.0` 格式 ⇒ 真机总是走保守降级。**后果安全**（降级语法处处合法），
  但「≥ 1.25.1 保留 `http2 on;`」只有显式 `NGINX_VERSION` 才走得到。
  一行修法：

  ```bash
  # 现状（匹配不到）
  sed -n 's|^nginx version: \([0-9][0-9.]*\).*|\1|p'
  # 修法（把可选的 "nginx/" 前缀吃掉）
  sed -n 's|^nginx version: nginx/\?\([0-9][0-9.]*\).*|\1|p'
  ```

  ⇒ 修完要重跑 `platform/test/deploy-assets.test.js` 与 F-4 的变异检验。
  **本 Task 明确不改** —— 本 Task 的文件归属只有 `docs/deployment.md`（+ 计划文档）。

### F. 偏离与遗留（Task 7 自身）

- 本 Task **新增**了 `docs/deployment.md`（计划 Task 7 Files 段已列）。
- 本 Task **追加**了本章台账（`D7-*` 编号，承接 `D1-*` / `D2-*` / `D3-*` / `D4-*` 的序列）。
- 手册内部的「未覆盖项」表用 `U-1` ~ `U-7` 编号，**与本台账的 `D7-*` 是两套编号**（不要混用）。
- ⚠️ 手册 §5 与 §7（计划骨架里的演示版构建命令）**保留原样未改**，其「此刻跑不通」的状态由手册顶部的
  「**阅读须知**」与 §8.5 承载 —— 理由见 D7-1。

## P6 部署资产修复轮（父代理，2026-10-21）

> 触发：父代理对 P6 部署资产的独立核对（`/tmp/p6-proof/deploy-assets-review.md`）查出 F-1~F-4 四条缺口。
> 这四条都不是「样式问题」，每一条都能让一次**真实的云主机部署**装到一半或直接失败。
> 本轮改动**只碰** Task 2 的文件（`platform/deploy/*`）与 `platform/test/deploy-assets.test.js`，
> **不重建**任何既有文件；Task 3 已登记的 §G-1「遗留 / 需上游注意」由本轮**裁决并落地**。

### F-1 前端构建产物目录「三处不一致」—— 裁决：唯一产物目录是 `platform/web/dist/`

| 位置 | 原状 | 裁决后 |
|---|---|---|
| P6 计划 Task 6 | `platform/web/dist/`（`build-demo.js --out web/dist`、`.gitignore`、扫描闸 `distDir`、验收 P6-11/P6-12） | **保持不变 —— 它就是唯一口径** |
| `deploy/nginx.conf` | `location /assets/ { alias __APP_DIR__/web/assets/; }`，注释声称「web/assets/ 是【前端构建产物目录】」 | **保留该 location**（R-OPS-04 要求它存在），但**订正注释**：web/assets/ 是**预留**的带哈希静态资源位，本仓库**没有任何构建步骤产出它**；真正的构建产物目录是 `web/dist/` |
| `deploy/install.sh` | rsync `--exclude 'web/dist/'` | **保持**，并**追加** `--exclude 'web/assets/'`；注释写明两者各自的性质 |

**为什么这么定**：① 演示版静态站是**自包含**的（`web/dist/` 里有 `index.html` + `src/domain/` + `rules/` + `seed/`），
它走的是**独立发布通道**（静态站发布工具），**不经** `deploy/nginx.conf` 这个「应用反代」——
后者服务的是 Node 应用自己的 `web/` 目录（`location /` 转给 Node）。
② nginx 里的 `/assets/` 是一块**前瞻位**：正式部署时静态资源要带内容哈希并长期缓存，
但**一期没有**对应的构建步骤。留着它并在注释里说清现状，比删掉更诚实，也不违反 R-OPS-04。
③ 若将来要让 nginx 直出演示版静态站，需要**独立的 server block 或独立端口**（不能与 `location /` 抢 `/`），
那属于部署形态变更，**不在一期**范围内。

### F-2 nginx 是最后一步且不检查装没装 ⇒ 半成品部署 —— 已修

**原状**：`main()` 的顺序是 `建用户 → 建目录 → 同步程序 → 写环境文件 → 建库 → 写 systemd → 启服务 → 写 nginx`。
nginx 在**最后**。机器上没装 nginx 时，脚本会先把上面**全部**做完，然后在最后一步以
`nginx: command not found` 退出 —— 留下一个「服务在跑、但没有反代、域名单独访问 502」的半成品部署。
更糟的是 `nginx -t` 失败时**站点文件与软链已经写进去了**（`ln -sfn` 在 `nginx -t` 之前），
坏配置留在 `sites-enabled` 里，会**毒化这台机器上下一次任何 nginx reload**（哪怕是别人触发的）。

**修法**：
① 新增 `require_nginx()`，在 `main()` 里**排在所有会改变机器状态的调用之前**执行 ——
   没装 nginx 就**当场明确拒绝**，不让前面半截部署发生。
② `write_nginx_site()` 写新配置前先 `cp -p` 备份旧站点文件；
   `nginx -t` 失败时**回滚**：有旧配置就 `mv` 还原，没有就 `rm -f` 掉站点文件与软链，然后才报错退出。
③ `nginx -t` 必须写在 `if ! nginx -t; then` 保护下（裸调用 + `set -e` 会直接退出，**来不及回滚**）。

### F-3 systemd / 环境文件漏 `SESSION_ABSOLUTE_TTL_DAYS` —— 已修

**原状**：`src/auth/session.js` 读 `SESSION_ABSOLUTE_TTL_DAYS`（默认 30 天），
但 `write_env_file()` 只写了 `SESSION_TTL_DAYS=7`，systemd 单元的环境文件注释也只列了三个变量。
⇒ 不写这个变量时应用**静默**用 30 天默认值，**「环境文件里写的」≠「实际生效的」**，排障时无从查证。

**修法**：① 环境文件显式写 `SESSION_ABSOLUTE_TTL_DAYS`（默认 30，与代码里的
`DEFAULT_ABSOLUTE_TTL_DAYS` 同源）；② systemd 单元的环境文件注释补上这个变量名；
③ 新增 `validate_session_ttls()`：两个天数**必须是正整数**，否则 fail-fast ——
因为 `session.js` 对非法值是**静默回退**到默认值（`"abc"` ⇒ 悄悄用 7 天），环境文件写错却毫无提示。
④ ⚠️ **绝对上限可以小于滑动有效期**（那是「更严」的合法配置：到期必须重登）——
   本轮**不**禁止这种组合，只校验正整数。**不擅自加规则。**

### F-4 nginx 版本 ≥ 1.25.1 未校验 —— 已修（自动降级）

**原状**：`deploy/nginx.conf` 用 `http2 on;`，该指令 **nginx 1.25.1 才引入**；
而 Ubuntu 22.04 = nginx 1.18、Ubuntu 24.04 = nginx 1.24.0 —— **都 < 1.25.1**。
`nginx -t` 会报 `unknown directive "http2"`，而这一步在流程**最后** ⇒ 同样是「装到一半才炸」。
（nginx.conf 的注释里写了「更低版本请把 `http2 on;` 换成 `listen 443 ssl http2;`」，
但那是**要人手工做**的事，脚本不会替你做。）

**修法**：新增 `platform/deploy/nginx-http2-compat.sh` —— 按**目标机**的 nginx 版本
（`nginx -v`，或环境变量 `NGINX_VERSION` 覆盖）决定：
- ≥ 1.25.1 ⇒ 原样保留 `http2 on;`；
- < 1.25.1 ⇒ 删掉独立的 `http2 on;` 行，并把 `listen 443 ssl;` 与 `listen [::]:443 ssl;`
  改成 `listen ... ssl http2;`（**这个写法在所有 nginx 版本上都合法** ⇒ 降级永远安全）；
- 探测不到版本 ⇒ 按「需要降级」处理（保守）。

`install.sh` 在渲染站点配置**之前**先跑这个脚本。脚本用 `awk` 而非 `sed` ——
`sed` 的 BRE 扩展（`\+` / `\d`）在 BSD sed（macOS）上不通用，而它要在 macOS 上被测试**实跑**。
脚本自带两道自检：保持路径下 `http2 on;` 不许丢、降级路径下 `http2 on;` 不许留。

### 变异检验（`/tmp/p6-mutate/t2fix.mjs`）

**11 个变异体 / 11 KILLED / 0 存活 / 0 无效 / 0 锚点异常**；对照组（未改动副本）**19/19 全绿**。
变异体逐个把本轮的修复改回去：挪 `require_nginx` 的位置、把 `nginx -t` 改回裸调用、
去掉回滚、不写 `SESSION_ABSOLUTE_TTL_DAYS`、改默认值、去掉合法性校验、
兼容脚本不降级、阈值放宽到 1.24.0、漏改 IPv6 那一支、改回「web/assets/ 是构建产物目录」的注释、
不排除 `web/dist/` —— **每一个都让对应的新用例变红**。

### 实跑数字

- 单文件 `test/deploy-assets.test.js`：**19 例 / 19 通过**（原 14 + 本轮 5）
- 全量 `node --test`：**961 例 / 960 通过 / 1 跳过 / 0 失败**（基线 956）
- `bash -n` 语法自检：`install.sh` 与 `nginx-http2-compat.sh` 均通过
- 隔离实证：PATH 里没有 nginx 时 `require_nginx` **当场拒绝**（不进入后续步骤）；
  有 nginx 时打印版本并放行
- 兼容脚本实跑：1.24.0 / 1.25.0 ⇒ 双 listen 行都降级；1.25.1 / 2.0.0 ⇒ 保留 `http2 on;`；
  端口 80 的 listen **不受影响**

### 偏离与遗留

- 本轮**新增**了一个文件 `platform/deploy/nginx-http2-compat.sh`（Task 2 的 Files 段已补）。
- Task 3 台账 §G-1 登记的「产物目录三处不一致」由本轮**裁决并落地**（见 F-1），不再作为遗留。
- ⚠️ **Task 3 与 Task 4 的缺陷台账编号都用了 `D-01` 起的裸编号**（分属两个 Task 的台账），
  合并 P6 Task 4 分支时需要重编号（Task 3 → `D3-*`、Task 4 → `D4-*`）——
  这是**合并时要处理的事**，本轮不动（Task 4 的台账在另一个分支上）。
---

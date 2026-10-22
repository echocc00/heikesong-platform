> ⚠️ **阅读须知（P6 Task 7 补写 · 不属于计划骨架 · 请先读完再动手）**
>
> 本手册的 **§0–§7 骨架逐字取自 P6 计划 Task 7**（未作任何改动，含 §0 三条硬约束）；
> **§8–§14 是本 Task 实跑核对后补写的**。三件事先说清楚：
>
> 1. **§5 的演示版构建命令此刻还跑不通。**
>    `scripts/build-demo.js` / `scripts/serve-demo.js` 是 **P6 Task 6** 的产物，
>    **截至本 Task（Task 7，2026-10-21）尚未落地** —— 仓库里没有这两个文件，
>    `web/dist/` 也不存在。§5 写的是**目标形态**；
>    完整的构建 / 产物位置 / 发布 / 本地预览流程见 **§8.5**。
> 2. **§2 的一键部署描述的是「当前真实行为」。**
>    上游刚做完一轮部署资产修复（**F-1 ~ F-4**，提交 `214d3f1`），
>    `install.sh` 现在的行为与修复前**不一样**：
>    nginx **前置检查 + 失败回滚**、nginx 版本**自动降级**、会话**绝对过期天数字段**。
>    逐条对账见 **§8.1 – §8.4**。
> 3. **标注约定**：
>    ✅ = 本 Task **实跑验证过**（证据见 **§14**）；
>    ⚙️ = 需要 Linux root 权限或真实域名，**本 Task 未实跑**（在云主机上执行）。
>
> | 你要做的事 | 看哪一节 |
> |---|---|
> | 在本机 / 内网跑起来 | §1 |
> | 部署到云主机（域名 + TLS） | §2 · §9 |
> | 只想先要一个公网演示 URL | §5 · §8.5 |
> | 备份 / 恢复 | §3 |
> | 出问题了 | §6 · §12 |
> | 能不能加机器 / 加副本 | §0 · §4 |
> | 改配置（端口 / 会话天数 / 环境变量） | §8.3 · §10 |
> | 这条命令会不会动我的机器 | §11 |

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

环境变量：`PORT` `DATA_DIR` `SESSION_TTL_DAYS` `SESSION_ABSOLUTE_TTL_DAYS`
（后两个是**会话有效期**的两个天数；**完整 9 个变量的速查表见 §10** —— 本地跑不用配，缺省值就能用）

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
node scripts/temp-leak-scan.js   # 泄漏闸：测试不许往临时目录里留垃圾
node scripts/build-demo.js   # 演示站构建：领域层浏览器安全检查通过
```

> **为什么清单里要有泄漏闸**：测试用 `mkdtempSync` 建临时目录，清理写在用例体末尾 ——
> 断言一失败就漏。macOS 的 `$TMPDIR` 系统会清（**开发机看不见**），
> 而 Linux 的 `/tmp` 不会自动清 ⇒ **在服务器上跑一次全量就是几十个 `hks-*` 目录**，
> 跑得越多堆得越多，终将把磁盘吃满。
> 现在测试进程退出时会把本进程的临时目录**整体回收**，泄漏闸负责守住这条不被回退。

---

*配套：[`superpowers/specs/2026-10-20-heikesong-platform-design.md`](superpowers/specs/2026-10-20-heikesong-platform-design.md)｜[`requirements-traceability.md`](requirements-traceability.md)｜[`rule-decisions.md`](rule-decisions.md)｜[``]()*

---

## 8. 与「P6 部署资产修复轮（F-1 ~ F-4）」的对账

> 本节是 Task 7 的**核心**：上游刚做完一轮部署资产修复（提交 `214d3f1`），
> 本手册必须反映**修复后**的真实行为，不能照抄修复前的说法。逐条如下。

### 8.1 F-4 · nginx 版本 ≥ 1.25.1 —— **已自动化，不需要人手工改语法**

`deploy/nginx.conf` 用的是 `http2 on;`，这个指令 **nginx ≥ 1.25.1** 才认识。
发行版现状：**Ubuntu 22.04 = nginx 1.18.x、Ubuntu 24.04 = nginx 1.24.0 —— 都 < 1.25.1**。

✅ **这一条已经自动化了，不需要人手工改**：`deploy/install.sh` 在渲染站点配置**之前**先跑
`deploy/nginx-http2-compat.sh`，它按**目标机**的 nginx 版本自动决定：

| 目标机 nginx 版本 | 脚本做的事 | 结果语法 |
|---|---|---|
| ≥ 1.25.1 | 原样保留 | `http2 on;` |
| < 1.25.1 | 删掉独立的 `http2 on;` 行，并把 `listen 443 ssl;` 与 `listen [::]:443 ssl;` 改成 `listen ... ssl http2;` | **这个写法在所有 nginx 版本上都合法 ⇒ 降级永远安全** |
| 探测不到版本 | 按「需要降级」处理（保守） | `listen ... ssl http2;` |

**「nginx 装没装、版本多少」怎么查**：

```bash
command -v nginx || echo "没装 nginx"   # 装没装
nginx -v                                 # 版本多少（版本号打在 stderr：nginx version: nginx/1.24.0）
```

**怎么用 `NGINX_VERSION` 覆盖（用于预演 / 测试）** —— 覆盖探测结果，
**在没装 nginx 的机器上也能预演渲染结果**：

```bash
cd platform
NGINX_VERSION=1.24.0 bash deploy/nginx-http2-compat.sh deploy/nginx.conf /tmp/site-1240.conf
NGINX_VERSION=1.25.1 bash deploy/nginx-http2-compat.sh deploy/nginx.conf /tmp/site-1251.conf
```

✅ 实跑输出（2026-10-21）：

```
[nginx-compat] nginx 1.24.0 < 1.25.1：已降级为 `listen ... ssl http2;`（旧语法在所有版本都合法）
[nginx-compat] nginx 1.25.1 ≥ 1.25.1：保留 `http2 on;` 写法
```

渲染结果的差异（同一份 `deploy/nginx.conf`）：

```
1.24.0 降级后：  listen 443 ssl http2;   /   listen [::]:443 ssl http2;
1.25.1 保留后：  listen 443 ssl;         /   listen [::]:443 ssl;   /   http2 on;
```

✅ **已修复（2026-10-21，父代理修复轮）**：`detect_version()` 的解析式已改为
`sed -n 's|^nginx version: *\(nginx/\)\{0,1\}\([0-9][0-9.]*\).*|\2|p'` ——
**带 `nginx/` 前缀与不带前缀两种形态都吃下**，且用的是 POSIX BRE（`\{0,1\}`），
BSD sed（macOS）与 GNU sed（Linux）都认。

> **这条曾经是真缺陷**：原式要求版本号紧跟 `nginx version: `，
> 而 nginx 的**真实输出**是 `nginx version: nginx/1.24.0`（版本号前带 `nginx/` 前缀）
> ⇒ 匹配不到 ⇒ 真机上自动探测**总是失败**、**总是**走保守降级。
> 后果当时是安全的（降级语法在所有版本都合法），但「≥ 1.25.1 保留 `http2 on;`」
> 这条分支在真机上只有显式给 `NGINX_VERSION` 才走得到。
> 修复后有**回归用例**钉住（`test/deploy-assets.test.js` 的「自动探测必须认得 nginx 真实输出格式」：
> 用一个假 `nginx` 放在 `PATH` 上、输出官方格式的版本号，**不**给 `NGINX_VERSION`，
> 走真实的自动探测路径，分别断言 1.24.0 被降级、1.25.1 被保留）。

### 8.2 F-2 · nginx 前置检查 + 失败回滚 —— 坏配置不会留在 `sites-enabled` 里

**① 前置检查（排在「动任何东西」之前）**

`install.sh` 的 `require_nginx()` 在 `main()` 里排在**所有会改变机器状态的调用之前**：

- 设了 `SERVER_NAME` 但机器上**没装 nginx** ⇒ **当场明确拒绝并退出**。
  不会留下「服务在跑、但没有反代、域名单独访问 502」的**半成品部署**。
- **没设 `SERVER_NAME`** ⇒ 本次不配 nginx，**跳过**这道检查（这是合法的纯 IP + 端口形态，见 §2.2）。

✅ 实跑（沙箱：把 `nginx` 从 `PATH` 里拿掉）：

```
[install] 错误：未检测到 nginx，但设置了 SERVER_NAME=heikesong.example.com。请先安装 nginx（Debian/Ubuntu: apt-get install -y nginx；RHEL/CentOS: dnf install -y nginx；Alpine: apk add --no-cache nginx），或去掉 SERVER_NAME 变量以跳过 nginx 配置。
```

⇒ 退出码 **1**，且**沙箱目录零改动**（没建用户、没建目录、没建库、没起服务）。

**② `nginx -t` 失败 ⇒ 回滚**

| 情况 | 脚本做的事 | 结果 |
|---|---|---|
| 有旧站点配置 | `mv` 还原成上一版 | 站点文件回到部署前的内容 |
| 没有旧站点配置 | **撤销站点文件与软链**（`rm -f`） | `sites-enabled/` 里**不留**任何东西 |

⇒ 坏配置**不会**留在 `sites-enabled` 里，**不会毒化这台机器上下一次任何 nginx reload**
（哪怕是别人触发的、与这次部署无关的 reload）。

✅ 实跑（沙箱：把 `nginx -t` 打桩成固定返回 1）—— 有旧配置时：

```
[install] 已回滚到上一版 nginx 站点配置
[install] 错误：nginx 配置校验失败（nginx -t 返回非 0）——已回滚，请按上面的 nginx -t 输出修正后重跑本脚本
```

没有旧配置时：

```
[install] 已撤销本次 nginx 站点配置（此前没有旧配置）
[install] 错误：nginx 配置校验失败（nginx -t 返回非 0）——已回滚，请按上面的 nginx -t 输出修正后重跑本脚本
```

⇒ 事后 `ls /etc/nginx/sites-enabled/` **是空的**。

**排障时的查法**：

```bash
sudo nginx -t                                     # 手工验证当前生效的配置
ls -l /etc/nginx/sites-enabled/heikesong.conf     # 软链在不在
sudo systemctl reload nginx
```

### 8.3 F-3 · 会话有效期：两个天数字段

**环境文件现在显式写这两个字段**（`install.sh` 的 `write_env_file()` 落的盘内容）：

```
PORT=8080
DATA_DIR=/var/lib/heikesong/data
SESSION_TTL_DAYS=7
SESSION_ABSOLUTE_TTL_DAYS=30
NODE_ENV=production
```

| 字段 | 默认 | 来源 | 含义 |
|---|---|---|---|
| `SESSION_TTL_DAYS` | **7** | 与 `src/auth/session.js` 的 `DEFAULT_TTL_DAYS` 同源 | 会话**滑动**有效期（天）：每次活动都续期 |
| `SESSION_ABSOLUTE_TTL_DAYS` | **30** | 与 `src/auth/session.js` 的 `DEFAULT_ABSOLUTE_TTL_DAYS` 同源 | 会话**绝对过期上限**（天）：到这个天数**必须**重新登录 |

**两个天数必须是正整数**，否则 `install.sh` **fail-fast 报错**（不是警告、不是静默兜底）。
并且**不得超过 3650 天（10 年）** —— 超过这个量级的数字在 bash 里会溢出整数比较，
而且真写进环境文件后 `new Date(now + 1e20 * 86400000)` 会得到 **Invalid Date**，
`.toISOString()` 直接抛 `RangeError` ⇒ 部署会在**签发会话时崩**（而不是安静地退回默认值）。
上界把它挡在部署这一步。

**为什么要 fail-fast**：代码对非法值是**静默回退到默认值**
（`SESSION_TTL_DAYS=abc` ⇒ 悄悄用 7 天）—— 环境文件里写错却**没有任何提示**，
运维会以为改了其实没改。**配置非法就报错，不静默兜底。**

✅ 实跑（沙箱）：

```
$ SESSION_TTL_DAYS=abc ./deploy/install.sh
[install] 错误：SESSION_TTL_DAYS 必须是正整数（当前：'abc'）

$ SESSION_ABSOLUTE_TTL_DAYS=0 ./deploy/install.sh
[install] 错误：SESSION_ABSOLUTE_TTL_DAYS 必须 > 0（当前：0）

$ SESSION_TTL_DAYS=99999999999999999999 ./deploy/install.sh
[install] 错误：SESSION_TTL_DAYS 不能超过 3650 天（当前：99999999999999999999）
```

⇒ 三次都是**退出码 1** 且**机器状态零改动**（校验排在建用户 / 建目录 / 建库之前），
且第一行永远是**可执行的人话**（不是 bash 的 `integer expression expected` 噪音）。

⚠️ **绝对过期上限可以小于滑动有效期** —— 那是「更严」的合法配置（到期必须重登）。
脚本**不禁止**这种组合，只校验两者都是正整数且不超过上界。

**「改了怎么生效」** —— 环境文件由 systemd 在**服务启动时**读
（单元里 `EnvironmentFile=-/etc/heikesong/platform.env`）⇒ **改完必须重启服务**：

```bash
sudo sed -i 's/^SESSION_ABSOLUTE_TTL_DAYS=.*/SESSION_ABSOLUTE_TTL_DAYS=14/' /etc/heikesong/platform.env
sudo systemctl restart heikesong
```

确认「文件里写的」＝「生效的」：

```bash
# ① 文件里写了什么
sudo grep SESSION_ /etc/heikesong/platform.env

# ② systemd 读的是**哪个**环境文件（只报路径，不内联内容）
sudo systemctl show -p EnvironmentFiles heikesong

# ③ **进程实际拿到的**环境变量（这才是「生效的」）
sudo tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value heikesong)/environ | grep SESSION_
```

> ⚠️ **别用 `systemctl show heikesong --property=Environment` 来确认环境文件的值** ——
> systemd 的 `Environment` 属性只由单元里的 `Environment=` 构建；
> `EnvironmentFile=` 的内容走**另一个**属性（`EnvironmentFiles=`，只报**路径**、不内联内容）。
> ⇒ 跑那条命令只会看到 `PORT=… DATA_DIR=… NODE_ENV=production`（单元里写的那些），
> **看不到 `SESSION_*`** —— 容易误判成「环境文件没生效」。
> 上游 issue：<https://github.com/systemd/systemd/issues/14723>（`EnvironmentFile` 是 `systemctl show` 的已知例外）。

> `EnvironmentFile=` 里的同名变量**优先于**单元里的 `Environment=` ——
> 所以「改环境文件」是改这些值的正确入口，不要去改单元模板。

### 8.4 F-1 · 前端产物目录口径：唯一的构建产物目录是 `platform/web/dist/`

| 目录 | 是什么 | 由谁产出 | 走不走本手册的 nginx |
|---|---|---|---|
| `platform/web/dist/` | **唯一的构建产物目录**（自包含静态站：根目录有 `index.html`） | P6 Task 6 的 `scripts/build-demo.js --out web/dist` | ⛔ **不走** —— 走**独立发布通道**（静态站发布工具） |
| `platform/web/assets/` | nginx `location /assets/` 指向的**预留位**（带内容哈希、可长期缓存的静态资源位） | **本仓库当前没有任何构建步骤产出它** | 走；但目录不存在 ⇒ 该前缀返 404，**不影响其它路径** |

⇒ **不要把 `web/assets/` 说成「构建产物目录」** —— 那是**预留**的静态资源位。
⇒ `install.sh` 的 rsync **两个都排除**（`--exclude 'web/dist/'` `--exclude 'web/assets/'`）：
演示站产物**不随程序同步到服务器**（它走独立发布通道）；`web/assets/` 本来就不存在。

✅ 实跑核对（沙箱 `install.sh` 生成的站点文件，第 80 行）：

```
80:        alias /opt/heikesong/platform/web/assets/;
```

—— 是**预留位**，不是产物目录。

### 8.5 公网演示版：Task 6 尚未落地，本节是**目标流程**

⚠️ **状态声明（截至 P6 Task 7，2026-10-21）**：

| 东西 | 状态 |
|---|---|
| `platform/scripts/build-demo.js` | **不存在**（P6 Task 6 的产物） |
| `platform/scripts/serve-demo.js` | **不存在**（P6 Task 6 的产物） |
| `platform/web/dist/` | **不存在**（Task 6 构建之后才出现） |

⇒ **§5 的两条命令此刻跑不通**（`node scripts/build-demo.js` 会报
`Cannot find module '.../scripts/build-demo.js'`）。
**Task 6 落地后**，下面这套流程就是可执行的（接口以 P6 计划 Task 6 为准）：

**① 构建**（产物在 `platform/web/dist/`）：

```bash
cd platform
node scripts/build-demo.js --out web/dist
```

**② 本地预览**（Task 6 的 `serve-demo.js`，端口 8090）：

```bash
cd platform
node scripts/serve-demo.js
# 浏览器打开 http://127.0.0.1:8090/
```

**③ 发布前必须跑扫描闸** —— 发布产物本身也过闸（`web/dist/` 会被一起扫）：

```bash
cd platform
node scripts/audit-scan.js
```

**退出码非 0 = 发布中止。**

**④ 发布**：`platform/web/dist/` 作为静态站发布（**根目录必须有 `index.html`** ——
这是静态托管的硬要求）。发布通道**独立于**云主机上的 nginx 反代。

⚠️ **两条别搞混的边界**：

- **演示版** = 同源静态前端 + `web/api.demo.js`（localStorage 适配器）
  ⇒ **数据不跨人共享**（各自浏览器独立）；
  ⇒ **规则引擎在浏览器里真实运行**（直接 import `src/domain/*.js`）
  ⇒ 算法行为与正式系统一致，不会出现「演示好看、正式不一样」。
- **演示版不替代正式后端** —— 正式版后端仍然按 §2 部署到云主机。

---

## 9. 云主机部署：分步详解

> ⚙️ 本节命令需要 **Linux + root**（本 Task 未实跑，实跑证据与边界见 §13 U-3 / §14）。
> §2 的**一键部署**是首选；本节是「一键脚本内部到底做了什么」的展开，
> 供需要手工分步执行、或需要定位某个步骤失败时使用。

### 9.1 前置条件

- Linux（systemd）；Ubuntu 22.04 / Debian 12 / Rocky 9 形态一致
- root 权限（`sudo`）
- 一个域名 + **已签发**的 TLS 证书（certbot 签发即可，见 §9.5）
- **单机**（见 §0.2：多机必须换 Postgres）

#### ⚠️ 从 macOS 把代码拷到 Linux：**别让 `._*` 伴生文件跟过去**

2026-10-21 在真机（Debian 12 / ext4）上实测踩到过：macOS 往**非 HFS 文件系统**
（exFAT/FAT U 盘、或 `tar` 打进 Linux 的流）拷时，每个文件旁边会多出一个
**AppleDouble 伴生文件** `._xxx`（资源叉载体，内容是二进制）：

```
$ node scripts/migrate.js
Error: 迁移文件名必须形如 <版本号>_<名称>.sql: ._001_init.sql
```

✅ **推荐**（`scp` 不产生伴生文件）：

```bash
scp -r platform/ other-machine:/tmp/platform
scp .gitignore other-machine:/tmp/.gitignore   # ⚠️ 仓库根这个也要（demo-static.test.js 会读它）
```

✅ 或者用 `tar` 但**必须**关掉 xattr / AppleDouble：

```bash
COPYFILE_DISABLE=1 tar -cf - --no-xattrs --exclude='._*' --exclude='.DS_Store' platform/ .gitignore \
  | ssh other-machine 'mkdir -p /tmp/platform && tar -xf - -C /tmp'
```

⛔ **不要**用 `rsync`（默认带 xattr），也**不要**经 **exFAT/FAT U 盘**中转
（那个格式**必然**生成 `._*`，而且 macOS 往里拷时也会自动造）。

⇒ 代码侧**已有兜底**（`src/db/migrate.js` 跳过 `._*`、`scripts/build-demo.js` 丢弃 `._*`），
但**正确做法仍是别把它们拷过去** —— 加固只是兜底。

### 9.2 先查前置条件（**都在动手之前查**）

```bash
# 1) Node 版本（下限 22.16.0 —— package.json engines）
node --version
# 2) nginx 装没装、版本多少
command -v nginx || echo "没装 nginx"
nginx -v
# 3) systemd 在不在
systemctl --version | head -n 1
# 4) 证书在不在
ls -l /etc/letsencrypt/live/<你的域名>/fullchain.pem /etc/letsencrypt/live/<你的域名>/privkey.pem
```

### 9.3 安装 Node ≥ 22.16.0

```bash
# Debian / Ubuntu（NodeSource 24.x）
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update -y
sudo apt-get install -y nodejs
node --version
```

> `install.sh` 在发现 Node 版本不满足时**自动**走这套流程
> （Debian/Ubuntu / RHEL / Alpine 各一条分支），所以**通常不用手工装**。
> 手工装的意义是：先装好再跑脚本，省掉脚本里的 apt 步骤。
>
> ⛔ **Node 下限是 22.16.0，不是 22.5** —— 22.16.0 才是 `node:sqlite.backup()` 的引入版本，
> 备份脚本（P6 Task 1）依赖它。低版本装了也**跑不了备份**。

### 9.4 写环境文件

`install.sh` 会写 `/etc/heikesong/platform.env`（**不含任何口令**）。内容与权限见 §8.3。

- 权限：`0640`；属主 `root`，属组 = **运行用户的主组**。
- ⛔ **不要在这里写任何口令**（口令只在初始化管理员时用一次，不落盘）。
- ⚠️ `NODE_ENV=production` 会让登录 Cookie 带 `Secure` 标记
  （`src/server.js`：`secureCookies = NODE_ENV === 'production'`）——
  **「IP + 端口 + 纯 HTTP」的临时调试形态下浏览器会直接拒收 Cookie → 登录失效**。
  那种形态请用 `NODE_ENV=development` 调 `install.sh`。
- **改完必须重启服务**才生效（见 §8.3）。

### 9.5 systemd 单元

`install.sh` 把 `deploy/heikesong.service` 渲染后写到 `/etc/systemd/system/heikesong.service`：

```bash
sudo systemctl daemon-reload
sudo systemctl enable heikesong
sudo systemctl restart heikesong
sudo systemctl status heikesong --no-pager
sudo journalctl -u heikesong -n 50 --no-pager
```

单元要点（排查时先看这几行）：

| 行 | 值 | 为什么 |
|---|---|---|
| `User=` / `Group=` | `heikesong` | **不用 root 跑** |
| `EnvironmentFile=-` | `/etc/heikesong/platform.env` | 环境变量的唯一入口（`Environment=` 只给兜底默认值） |
| `ExecStart=` | `/usr/bin/env node /opt/heikesong/platform/src/server.js` | **只有一条** —— ⛔ 不要加多进程 / 多 worker 启动参数（见 §0.1） |
| `Restart=` / `RestartSec=` | `always` / `3` | 崩溃自动拉起 |
| `KillSignal=` / `TimeoutStopSec=` | `SIGTERM` / `30` | 优雅停机：先 SIGTERM 等它关库，再 SIGKILL |
| `ReadWritePaths=` | `/var/lib/heikesong/data` | 只有数据目录可写（`ProtectSystem=strict`） |
| `StandardOutput=` / `StandardError=` | `journal` | 日志走 journald ⇒ `journalctl -u heikesong -f` |

⛔⛔ **绝对不要打开 `DEMO_MODE`**：打开会把 `/src/domain/*` 与 `/rules/*` 挂到 HTTP 上 ——
那是**领域层算法源码**与**全部规则配置**。生产部署下必须一律 404。
这道门只给本地预览与开发服务器用。

### 9.6 nginx + TLS

- 站点文件：`/etc/nginx/sites-available/heikesong.conf`
- 软链：`/etc/nginx/sites-enabled/heikesong.conf` → 上面那个
- 证书：`ssl_certificate` / `ssl_certificate_key` 指向 certbot 的 `fullchain.pem` / `privkey.pem`
- HTTP → HTTPS 301：`listen 80` 那个 server 块；ACME 校验目录
  `location /.well-known/acme-challenge/ { root /var/www/certbot; }`

⚙️ 签发证书（需要真实域名 + 公网 DNS 已生效；**本 Task 未实跑**）：

```bash
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /var/www/certbot -d <你的域名>
```

certbot 的 `webroot` 模式要往 `/var/www/certbot` 写校验文件 ⇒ nginx 里那个
`location /.well-known/acme-challenge/` 就是给它用的。**先让 HTTP 端口通**再签发。

改完站点配置：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

（`install.sh` 内部就是先 `nginx -t` 再 reload；**`nginx -t` 失败会回滚**，见 §8.2）

### 9.7 建库 + 初始化管理员

```bash
sudo -u heikesong DATA_DIR=/var/lib/heikesong/data \
  node /opt/heikesong/platform/scripts/migrate.js
sudo -u heikesong DATA_DIR=/var/lib/heikesong/data \
  ADMIN_PHONE=13800000000 ADMIN_PASSWORD='<你的口令>' \
  node /opt/heikesong/platform/scripts/seed.js
```

- 口令**只用于这一次**，**不落盘**。`install.sh` 不给 `ADMIN_PASSWORD` 时会**交互读取**（不回显）；
  两种都没有 ⇒ 报错并**以非 0 退出**。
- 幂等：再跑一次 `seed.js` 输出「管理员已存在：13800000000」，不会重复建。
- ⚠️ 跑 `migrate.js` / `seed.js` 要用**运行用户**（`heikesong`）身份，
  否则库文件属主会变成 root。

### 9.8 验收

```bash
curl -s http://127.0.0.1:8080/api/health     # 期望 {"ok":true,"at":"..."}
sudo systemctl is-active heikesong           # 期望 active
sudo nginx -t                                # 期望 syntax is ok / test is successful
```

✅ 实跑输出（Task 7 环境，macOS）：

```
$ curl -s http://127.0.0.1:8080/api/health
{"ok":true,"at":"2026-10-21T08:04:57.542Z"}
```

```
heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）
```

---

## 10. 环境变量速查表

| 变量 | 默认 | 谁读它 | 改完怎么生效 | 备注 |
|---|---|---|---|---|
| `PORT` | `8080` | `src/server.js` | 重启服务 | ⛔ **写死口径**，见下方 |
| `DATA_DIR` | 本地 `platform/data`；安装时 `/var/lib/heikesong/data` | 服务 + `migrate` / `seed` / `backup` / `restore` | 重启服务 | 数据库与备份目录的根 |
| `SESSION_TTL_DAYS` | `7` | `src/auth/session.js` | 重启服务 | 会话**滑动**有效期（天），**必须正整数** |
| `SESSION_ABSOLUTE_TTL_DAYS` | `30` | `src/auth/session.js` | 重启服务 | 会话**绝对过期上限**（天），**必须正整数** |
| `NODE_ENV` | 安装时 `production` | `src/server.js` | 重启服务 | `production` ⇒ Cookie 带 `Secure`（纯 HTTP 调试形态用 `development`） |
| `ADMIN_PASSWORD` | 无 | `scripts/seed.js` | 一次性 | ⛔ **不落盘**；不给就交互读取（不回显） |
| `ADMIN_PHONE` | `13800000000` | `scripts/seed.js` | 一次性 | 初始化管理员用的手机号 |
| `NGINX_VERSION` | 无（自动探测） | `deploy/nginx-http2-compat.sh` | 渲染时立即生效 | 覆盖 nginx 版本探测，**用于预演 / 测试**（见 §8.1） |
| `DEMO_MODE` | 未设置 | `src/server.js` | 重启服务 | ⛔⛔ **生产部署绝对不要打开**（见 §9.5） |

⛔ **端口 8080 是写死口径** —— 同一套端口出现在**四处**，要换必须**四处一起改**：

1. `deploy/nginx.conf` 的 `upstream`（`server 127.0.0.1:8080;`）
2. `deploy/heikesong.service` 的 `Environment=PORT=8080`
3. `deploy/docker-compose.yml` 的 `PORT: "8080"`
4. `install.sh` 写进环境文件的那行 `PORT=8080`

⇒ `install.sh` **故意不提供 `PORT` 变量** —— 免得只改一处、服务与反代连不上。

---

## 11. 哪些命令会改动机器状态（风险标注）

| 命令 | 改什么 | 风险 | 怎么更安全 |
|---|---|---|---|
| `node scripts/migrate.js` | **改数据库**（建表 / 加表加列） | 中 | 先备份（§3.1）；迁移在单事务里跑 |
| `node scripts/seed.js` | **写库**（能力点 / 角色 / 管理员） | 中 | 幂等；管理员已存在时不会重复建 |
| `node scripts/backup.js` | 写备份文件 + **按保留策略删旧备份** | 低-中 | `--keep-count` / `--keep-days` 调大；`--out` 指到另一块盘 |
| `node scripts/restore.js` | **换掉当前数据库** | ⛔ 高 | 必须先停服务（脚本会强制检查）；旧库自动留存为 `app.db.before-restore-<时间戳>` |
| `node scripts/restore.js --force` | 同上，且**跳过停服务检查** | ⛔⛔ 很高 | 不要用。`--force` 存在的唯一理由是「服务确实停了、但 pid 文件没清干净」 |
| `sudo ./deploy/install.sh` | **改整台机器**（建用户 / 目录 / 环境文件 / systemd / nginx / 建库） | ⛔ 高 | 可重复执行（幂等）；跑之前 `git diff` 看清楚要同步什么 |
| `sudo systemctl restart heikesong` | 重启服务（短暂中断） | 低 | — |
| `sudo systemctl reload nginx` | 重载 nginx 配置 | 低 | 先 `sudo nginx -t` |
| `sudo rm /etc/nginx/sites-enabled/heikesong.conf` | 摘掉站点 | 高 | 先 `nginx -t` 确认还有别的站点在 |
| `node scripts/build-demo.js --out web/dist` | **覆盖 `web/dist/`** | 低 | 产物目录，可随时重建 |
| `node scripts/serve-demo.js` | 监听 8090 | 低 | 本地预览，Ctrl-C 结束 |

⚠️ **恢复脚本的安全闸**（不是「建议停服务」，是**机器检查**）：

| 探测结果 | 脚本的判断 |
|---|---|
| pid 文件指向**活进程** | ⛔ **拒绝执行** |
| pid 文件存在但**内容不可解析** | ⛔ **保守判为「在跑」并拒绝**（拿不到证据时必须拒绝） |
| pid 文件存在但进程**已退出**（异常终止的残留） | ✅ 放行（并告诉你「可能是异常终止的残留」） |
| 没有 pid 文件 | 继续查 `systemctl is-active heikesong`（Linux） |
| 以上都不是 | ✅ 放行 |

---

## 12. 排障补充（§6 之外的常见症状）

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| `nginx -t` 报 `unknown directive "http2"` | 站点配置是**手工改的**、绕过了兼容脚本 | 用 `install.sh` 重写站点配置；或先跑 `deploy/nginx-http2-compat.sh` 渲染（见 §8.1） |
| 域名单独访问 502 | nginx 没装 / 没配 / 没 reload | `command -v nginx`；`ls -l /etc/nginx/sites-enabled/heikesong.conf`；`sudo nginx -t && sudo systemctl reload nginx` |
| 部署跑到一半才报 nginx 相关错 | 跑的是**修复前**的 `install.sh` | 用当前分支的 `deploy/install.sh` 重跑；现在缺 nginx 会**在动手之前**就拒绝（见 §8.2） |
| 改了 `SESSION_TTL_DAYS` 但行为没变 | ① 改的是代码里的默认值不是环境文件；② 改了没重启 | `sudo grep SESSION_ /etc/heikesong/platform.env` → `sudo systemctl restart heikesong`（见 §8.3） |
| `SESSION_TTL_DAYS` 写成了 `abc`，服务照常启动、天数还是 7 | 应用层**静默回退**到默认值 | 由 `install.sh` 的 fail-fast 拦住（见 §8.3）；已经写进环境文件的非法值要手工改回正整数 |
| 登录页提交后一直「未登录」 | `NODE_ENV=production` + 纯 HTTP ⇒ Cookie 带 `Secure` 被浏览器拒收 | 纯 HTTP 调试形态用 `NODE_ENV=development` 重装；正式形态走域名 + TLS（见 §9.4） |
| `/assets/` 下所有请求 404 | `web/assets/` 是**预留**目录，**本仓库没有构建步骤产出它** | 正常现象，不影响其它路径。真正的构建产物目录是 `platform/web/dist/`（见 §8.4） |
| `/src/domain/*` 或 `/rules/*` 本该 404 却能访问 | 部署环境里打开了 `DEMO_MODE` | ⛔ 立刻关掉（systemd 单元与 compose 里都**不许**有 `DEMO_MODE=1`），重启服务 |
| 备份目录无限膨胀 | 目录里堆了 `*.db-wal` / `*.db-shm` 残留 | 保留策略只认 `*.db`；残留是只读打开备份时 SQLite 造出来的，关库时脚本会清掉自己造的那份 |
| 恢复报「备份不可用（完整性检查未通过）」 | 备份文件损坏 / 路径不存在 | 换一份：`node scripts/restore.js <另一份>.db`（脚本会把完整原因打出来） |

---

## 13. 未覆盖的项与理由

| # | 没覆盖什么 | 为什么 / 怎么办 |
|---|---|---|
| U-1 | **证书签发的完整流程未实跑** | 需要真实域名 + 公网 DNS。手册只把它当**前置条件**（`install.sh` 收 `CERT_PATH` / `KEY_PATH`），certbot 的命令按需自取（§9.6） |
| U-2 | **Docker 形态未实跑** | 本 Task 环境无 Docker daemon。`deploy/docker-compose.yml` 的形态与注意事项写在 §2.4。⚠️ 它用的是 `network_mode: host` —— 那是 **Linux 宿主机的语义**；在 macOS / Windows 的 Docker Desktop 上容器拿的是 Linux 虚拟机的网络栈，宿主 `127.0.0.1:8080` 仍不通 |
| U-3 | **`install.sh` 的完整执行未在真机实跑** | 需要 Linux + root + systemd + nginx，且会**接管 nginx 站点**。**沙箱实跑**已覆盖：fail-fast 三条（缺 nginx / TTL 非法 / Node 版本不足）、一次完整部署（所有落盘产物 + 自动降级 + 幂等重跑）、`nginx -t` 失败的两条回滚路径（见 §14 E9–E14）。<br>⚠️ **2026-10-21 补充**：已在**真机**（Debian 12 / nginx 1.22.1 / systemd 252）上把它的**各个可独立验证的部分**验过：HTTP/2 自动降级判定、降级后站点配置的 `nginx -t` 语法校验、`heikesong.service` 的 `systemd-analyze verify`（零告警）—— 见 §14 E18–E20。**完整执行仍未做**，因为本机承载着既有业务（80 是 headscale 控制台的 `default_server`、443 被 xray 占用），跑它必须改端口并接管 nginx 站点，属于会动生产配置的动作<br>⚠️ **2026-10-21 晚补充**：已在同一台真机上用**让路形态**（§14：纯 HTTP + 8081，`NGINX_TEMPLATE=…/nginx-plain-http.conf`）**完整执行过一遍** `install.sh` —— 退出码 0，迁移/种子/系统单元/nginx 站点全部落地，服务 active，登录链路与 SSE 实跑通过（证据 E24–E28）。**没有**动 headscale 的 `default_server`、没有碰 443 |
| U-4 | ~~`nginx-http2-compat.sh` 的版本探测在真机上总是失败~~ **已修** | 原 `detect_version()` 的 sed 匹配不到 nginx 的真实输出格式 `nginx version: nginx/1.24.0`（版本号前带 `nginx/` 前缀）⇒ 真机总是走保守降级。**后果安全**（降级语法在所有版本都合法），但「≥ 1.25.1 保留 `http2 on;`」只有显式 `NGINX_VERSION` 才走得到。**已由父代理修复轮修掉**（2026-10-21）：解析式改为同时吃下带前缀/不带前缀两种形态，并补了走**真实自动探测路径**的回归用例（假 `nginx` 放 `PATH` 上）—— 见 §8.1 |
| U-5 | **演示版构建 / 发布流程未实跑** | `scripts/build-demo.js` / `scripts/serve-demo.js` 是 **P6 Task 6** 的产物，**本 Task 时点尚未落地**。§8.5 写的是**目标流程**（接口以 P6 计划 Task 6 为准） |
| U-6 | **多机 / Postgres 方案** | 超出本阶段范围。§0.2 与 §4 只把**边界**说清楚（多机必须换 Postgres，没有第三条路） |
| U-7 | **计划代码块原样保留，未作改动** | 计划 Task 7 的 `docs/deployment.md` 代码块在本文件里**逐字连续**保留（§0–§7），补写内容全部落在 §8–§18。计划文档本身只**追加**了「Task 7 实施台账」一章 |
| U-8 | **systemd 侧未在真机验证** | 本手册写作环境是 macOS（无 systemd）。§8.3 的「确认生效」三条命令里，②（`systemctl show -p EnvironmentFiles`）与 ③（读 `/proc/<pid>/environ`）**未在真机跑过** —— 但 ③ 读的是内核暴露的进程环境，语义不依赖 systemd 版本。⚠️ 刻意**不用** `systemctl show -p Environment`：那条**看不到** `EnvironmentFile=` 的内容（systemd issue #14723），会让人误判「环境文件没生效」。<br>⚠️ **2026-10-21 补充**：单元文件本身已在**真机 systemd 252** 上过 `systemd-analyze verify`（零告警，见 §18 E20）；仍未验证的是「**服务真跑起来之后**那三条确认命令」（那需要真的把服务装上并启动）<br>✅ **2026-10-21 晚补充**：让路形态部署后服务**真的跑起来了**（`systemctl is-active heikesong` ⇒ `active`，`Main PID` 为 `node /opt/heikesong/platform/src/server.js`），见 §18 E25；「确认生效」三条命令仍可自行跑 |
| U-9 | **平台在公网打不开**（真机部署后实测） | 主机侧**零防火墙规则**（iptables INPUT 0 条 / nftables 空 / firewalld 未装），`8081` 确实在监听 `0.0.0.0` ⇒ **过滤在云侧**（安全组 / 端口映射只放行了 22 / 80 / 443 / 7000 / 8888）。让路形态部署在 8081 ⇒ 机内全通（E26/E27），公网不通（E29）。<br>⇒ **不是应用问题**：在云控制台加一条 **TCP 8081** 的入方向规则即可（代码与主机配置零改动）；在此之前可用 `ssh -L 8081:127.0.0.1:8081` 本机隧道访问<br>✅ **2026-10-22 已解决**：用户放行 **TCP 8081** ⇒ 公网 `http://8.133.200.235:8081/` 实测 200（见 §18 E37）。<br>✅ **2026-10-22 再进一步**：该入口已升级为 **TLS**（`https://8.133.200.235:8444/`，见 §17），**8444 公网直接可达**（当时**未**改安全组 —— 此前只探过一组固定端口，8444 不在其中）；8081 入口已改为 **301 跳转到 https**，明文入口不再承载任何业务流量 |

---

## 14. 让路形态：复用既有主机（80/443 被占时）

> 适用场景：目标机**已经在跑别的业务**，80 / 443 被占（nginx 的 `default_server`、
> xray 直接 bind 443……），没法按 §9 的正式形态（域名 + 443 TLS）部署。
> 本节是**真机实跑过的形态**（8.133.200.235 / Debian 12 / nginx 1.22.1，证据 E24–E29）。

### 14.1 三个新开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `NGINX_TEMPLATE` | `deploy/nginx.conf` | 站点模板。令路形态用 **`deploy/nginx-plain-http.conf`**（纯 HTTP、无 TLS、无 301 跳转） |
| `NGINX_HTTP_PORT` | `8081` | 让路模板的对外 HTTP 端口（模板里的 `__HTTP_PORT__` 占位符） |
| `COOKIE_SECURE` | 不设 = 跟随 `NODE_ENV` | 登录 Cookie 的 `Secure` 属性。**纯 HTTP 形态必须显式给 `false`** |

```bash
# 让路形态（复用既有主机）
sudo SERVER_NAME=8.133.200.235 \
     NGINX_TEMPLATE="$(pwd)/platform/deploy/nginx-plain-http.conf" \
     NGINX_HTTP_PORT=8081 \
     COOKIE_SECURE=false \
     ADMIN_PASSWORD=… \
     ./platform/deploy/install.sh
```

### 14.2 为什么 `COOKIE_SECURE` 要单独一个开关（而不是用 `NODE_ENV=development`）

`src/server.js` 的判定是：`COOKIE_SECURE` **不设** ⇒ 跟随 `NODE_ENV`（=production ⇒ `Secure`）。
明文 HTTP 下浏览器会**直接拒收**带 `Secure` 的 Cookie ⇒ 登录失效。
用 `NODE_ENV=development` 能绕过，但会**连带改掉其它生产行为**（错误信息、缓存头……）⇒
只关一个开关更可控。

应用侧语义是**失败即安全**：只有**显式的 `false`** 才关掉 `Secure`；
其它取值（含拼错的 `flase`）一律按「要 Secure」处理 ⇒ 拼错的后果是「登录失败」（症状明显），
而不是「会话 Cookie 明文发出」（症状不可见）。

### 14.3 上游端口口径不变

让路形态**只改对外入口**，上游仍是 `127.0.0.1:8080`（与 systemd 单元的 `Environment=PORT`、
环境文件的 `PORT=8080`、docker-compose 的 `PORT` 同一套）⇒ **应用侧一行不用改**。
应用本身仍只绑 `127.0.0.1`（不是 `0.0.0.0`）⇒ 8080 **不直接暴露公网**，入口只有 nginx。

### 14.4 ⚠️ 公网可达性取决于**云侧端口映射**，不由本手册决定

真机实测：这台机的内网地址是 `172.17.106.68`，`8.133.200.235` 是**云上的端口映射**，
只转发了 **22 / 80 / 443 / 7000 / 8888** 五个端口 ⇒ 部署到 8081 后**公网打不开**。
⇒ **部署前先确认云侧能不能放行这个端口**（本机零防火墙规则，纯粹是云侧入方向规则的事）；
放行之后本节形态即可直接对外，**主机与代码都不用再改**。

### 14.5 回滚

```bash
systemctl stop heikesong && systemctl disable heikesong
rm -f /etc/systemd/system/heikesong.service && systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/heikesong.conf /etc/nginx/sites-available/heikesong.conf
nginx -t && systemctl reload nginx          # ⛔ nginx -t 不过就**不要** reload
rm -rf /opt/heikesong /var/lib/heikesong /etc/heikesong
userdel heikesong && groupdel heikesong
```

> 回滚只删**本次部署创建**的东西；`default`（headscale）、`headscale-tls`、xray、frps、
> HydroOJ、mongod 一律不碰。

## 15. 改口令与强制下线（运维操作）

> 为什么要单独一节：管理员口令是 `scripts/seed.js` **一次定死**的（幂等、不覆盖已有账号），
> 所以「换口令」只能走 API —— 平台现在有 `POST /api/auth/password` 了。

### 15.1 改口令

```bash
# ① 登录，取会话 Cookie
curl -s -i -X POST http://127.0.0.1:8081/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800000000","password":"<旧口令>"}' | grep -i '^set-cookie:'

# ② 用这个会话改口令
curl -s -X POST http://127.0.0.1:8081/api/auth/password \
  -H 'Content-Type: application/json' \
  -H 'Cookie: hk_session=<上一步的 token>' \
  -d '{"oldPassword":"<旧口令>","newPassword":"<新口令>"}'
```

| 情况 | HTTP | `error.code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `UNAUTHENTICATED` | |
| 原口令错 | 401 | `INVALID_CREDENTIALS` | 口令**不**改动 |
| 新口令为空 | 400 | `PASSWORD_REQUIRED` | |
| 新口令 < 8 位 | 400 | `PASSWORD_TOO_SHORT` | |
| 新口令 > 128 位 | 400 | `PASSWORD_TOO_LONG` | 防超长口令把 scrypt 拖成 DoS |
| 新口令 = 原口令 | 400 | `PASSWORD_REUSED` | 不算「改成功」 |
| 成功 | 200 | — | `{ ok: true, revokedSessions: N }` |

⚠️ 改完之后：**其它设备**上的会话全部作废（`revokedSessions` = 被作废的个数），
**当前这次仍有效**（改完不会被自己踢下线）⇒ 换到别的设备时要用**新口令**重新登录。

⚠️ **口令策略只约束「新设」的口令**：存量账号（seed 出来的、历史导入的）仍可用旧口令登录
—— 新策略不会把老账号**锁死**在外；但**新设**必须 ≥ 8 位。

### 15.2 强制下线

```bash
curl -s -X POST http://127.0.0.1:8081/api/auth/logout-all -H 'Cookie: hk_session=<token>'
```

⇒ 该用户**全部**会话作废（**含当前**），并下发清空会话的 Cookie。
用途：账号疑似泄露、或明确要「把他踢下线」。

### 15.3 轮换 seed 出来的初始口令（部署后第一件事）

`install.sh` 用 `ADMIN_PASSWORD` 建管理员，而那个口令**改不掉**
（`scripts/seed.js` 幂等、不覆盖已有账号）⇒ 部署后**立刻**用 §15.1 换掉它。

⚠️ 若口令曾出现在**日志 / 截图 / 聊天记录**里 ⇒ **一律当作已泄露**，必须换。
⚠️ 纯 HTTP 形态下口令每次登录都**明文过网** ⇒ 换口令的同时把安全组来源 IP 限定住。

---
| U-10 | **正式形态（域名 + 443 TLS）的 `install.sh` 完整执行仍未实跑** | 真机跑通的是**让路形态**（§14 纯 HTTP）与**TLS 端口形态**（§17 `nginx-tls-port.conf`）。正式形态 `deploy/nginx.conf`（80 301 → 443 + 域名）依赖**真实域名 + 80/443 空闲**，这台机两个前提都不满足 ⇒ 未跑。<br>⚠️ 但它的**关键部件已分别验过**：TLS 监听与证书挂载（§17 E35–E37）、HTTP→HTTPS 跳转（§17 E38）、HTTP/2 兼容降级（§18 E34）、证书续期链路（§18 E39） |
| U-11 | **Windows 从未实跑** | 跨平台只验到 macOS（darwin arm64）与 Linux（Debian 12 / ext4）。`test/portability.test.js` 覆盖的是**代码层**的可移植性（路径、换行、locale 排序），不等于在 Windows 上跑过。<br>⚠️ 风险点：`install.sh` 是 bash 脚本（Windows 需 WSL/Git Bash）；`node:sqlite` 在 Windows 上路径分隔符与文件锁的行为与 POSIX 不同 |

## 17. HTTPS 升级：TLS + 自定义端口（80/443 被占，但手上有证书）

> 适用场景：与 §14 同一前提（80 / 443 被既有业务占用），**但手上有一张可用证书** ——
> 域名证书，或者 Let's Encrypt 的 **IP 短周期证书**（`/etc/letsencrypt/live/<IP>/`）。
> 与 §14 的差别只有一个：**加密**。真机 8.133.200.235 实跑形态。

### 17.1 三个模板怎么选

| 场景 | 模板 | 对外形态 |
|---|---|---|
| 有域名、443 空闲（正式形态） | `deploy/nginx.conf` | `https://<域名>/`（80 301 → 443） |
| 80/443 被占，**无**证书 | `deploy/nginx-plain-http.conf` | `http://<IP>:<端口>/`（**明文**） |
| 80/443 被占，**有**证书 | `deploy/nginx-tls-port.conf` | `https://<IP>:<端口>/` |
| 已上 TLS，想**关掉明文入口** | `deploy/nginx-https-redirect.conf` | `http://<IP>:<端口>/` ⇒ 301 到 TLS 端口 |

### 17.2 开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `NGINX_TEMPLATE` | `deploy/nginx.conf` | 指向 `deploy/nginx-tls-port.conf`（或跳转模板） |
| `NGINX_TLS_PORT` | `443` | TLS 监听端口（模板里的 `__TLS_PORT__` 占位符） |
| `NGINX_HTTP_PORT` | `8081` | 明文监听端口（模板里的 `__HTTP_PORT__` 占位符） |
| `COOKIE_SECURE` | 不设 = 跟随 `NODE_ENV` | 走 https 后应显式给 `true`；**明文入口还在时只能给 `false`** |

### 17.3 两个必须知道的坑（模板注释里也写了）

**① ⛔ TLS 模板**没有** 80 端口的 server 块，两个原因缺一不可：**

- 80 常被既有业务以 `default_server` 占用。再加一个 `server_name` 更精确的块，
  **IP 直访时命中的是精确 `server_name`**（nginx 先精确后通配）⇒ 等于我们上线、
  别人的控制台被我们抢走入口。
- 证书续期靠 ACME HTTP-01 校验，而校验目录（certbot webroot）**恰好**挂在 80 的
  `default_server` 上 ⇒ 我们抢走 80 就等于**掐断自己的续期链路**
  （短周期证书一旦续不上，过期当天服务直接不可用）。

**② ⛔ upstream 名字必须与别的站点文件不同**（本模板用 `heikesong_app_tls`，
另两个模板用 `heikesong_app`）：nginx 的 upstream 名是**全局**的 —— 同名会让
`nginx -t` 报 `duplicate upstream`，且**整个 nginx 起不来**（连带把别人的业务一起带崩）。

### 17.4 两阶段切换（顺序不能反）

> ⚠️ 为什么不能一把梭：`COOKIE_SECURE=true` 会让**明文入口的登录直接失效** ——
> 浏览器拒收带 `Secure` 标记的 Cookie（明文 HTTP 下收不了）。所以必须**先让 https 验证通过**，
> 再切 Cookie。

**Stage 1：先只加 TLS 入口，不动 Cookie。** 用**另一个站点文件**落 TLS 站点，
明文站点原样保留 ⇒ 这一步**不影响现有访问**：

```bash
sudo SERVER_NAME=8.133.200.235 \
     NGINX_TEMPLATE="$(pwd)/platform/deploy/nginx-tls-port.conf" \
     NGINX_TLS_PORT=8444 \
     NGINX_SITE=/etc/nginx/sites-available/heikesong-tls.conf \
     NGINX_LINK=/etc/nginx/sites-enabled/heikesong-tls.conf \
     COOKIE_SECURE=false \
     ADMIN_PASSWORD=… \
     ./platform/deploy/install.sh
```

验证（**在本机**就能验，证书链用系统信任库校验，不要加 `-k`）：

```bash
curl --resolve 8.133.200.235:8444:127.0.0.1 https://8.133.200.235:8444/api/health
```

> `--resolve` 是为了绕开「云上映射无 hairpin ⇒ 机内 curl 公网 IP 不通」；
> 用 `--resolve` 指定回环地址后，**TLS 握手仍按 IP 走**（证书 SAN = IP），
> 所以它验的是**真证书链**，不是绕过校验。

**Stage 2：确认 https 能用之后**，再切 Cookie 并关掉明文入口：

```bash
# ① 切 COOKIE_SECURE=true（同一套 install.sh 重跑即可）
sudo SERVER_NAME=8.133.200.235 \
     NGINX_TEMPLATE="$(pwd)/platform/deploy/nginx-tls-port.conf" \
     NGINX_TLS_PORT=8444 \
     NGINX_SITE=/etc/nginx/sites-available/heikesong-tls.conf \
     NGINX_LINK=/etc/nginx/sites-enabled/heikesong-tls.conf \
     COOKIE_SECURE=true \
     ADMIN_PASSWORD=… \
     ./platform/deploy/install.sh

# ② 明文入口改成 301 跳转（**替换**掉原来的明文站点文件）
sudo SERVER_NAME=8.133.200.235 \
     NGINX_TEMPLATE="$(pwd)/platform/deploy/nginx-https-redirect.conf" \
     NGINX_HTTP_PORT=8081 \
     NGINX_TLS_PORT=8444 \
     NGINX_SITE=/etc/nginx/sites-available/heikesong.conf \
     NGINX_LINK=/etc/nginx/sites-enabled/heikesong.conf \
     COOKIE_SECURE=true \
     ADMIN_PASSWORD=… \
     ./platform/deploy/install.sh
```

> ② 也可以**直接删掉**明文入口（`rm` 站点文件 + 软链 + `nginx -t && systemctl reload nginx`）——
> 最干净，但**旧链接直接断**。用跳转模板则是「旧链接仍落到正确地址，且没有业务流量再走明文」。

### 17.5 明文入口的三个选项

| 选项 | 做法 | 结果 |
|---|---|---|
| **留着**（不推荐） | 什么都不动 | 明文入口仍可访问；`COOKIE_SECURE=true` 后**登录会失败**（浏览器拒收 Secure Cookie）⇒ 半残状态 |
| **301 跳转**（推荐） | `deploy/nginx-https-redirect.conf` | 旧链接自动落到 https；无业务流量走明文 |
| **删掉** | `rm` 站点文件 + 软链 + reload | 最干净；旧链接断 |

### 17.6 证书续期（**短周期证书必看**）

Let's Encrypt 的 **IP 短周期证书**只有 **6 天**有效期 ⇒ 续期链路断了就是**当天服务不可用**。

- 续期由 certbot 的 timer 驱动（如 `certbot-renew.timer`，一天两次）；
- 续期成功后必须 `systemctl reload nginx`，否则 nginx 还在用旧证书；
- certbot 的 deploy hook（`/etc/letsencrypt/renewal-hooks/deploy/`）通常已经做了 reload ——
  **部署前先确认这个 hook 在不在**：

```bash
ls -l /etc/letsencrypt/renewal-hooks/deploy/
systemctl list-timers | grep -i cert
```

⚠️ 本模板**不碰 80**，所以 ACME 的 webroot 校验仍由既有 `default_server` 提供 ⇒ 续期链路不受影响。

### 17.7 回滚

```bash
# 只回滚 TLS 入口（保留明文入口原样）
rm -f /etc/nginx/sites-enabled/heikesong-tls.conf /etc/nginx/sites-available/heikesong-tls.conf
nginx -t && systemctl reload nginx

# 只回滚 Cookie 开关（改回明文可用）
sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=false/' /etc/heikesong/platform.env
systemctl restart heikesong
```

> 回滚只删**本次新增**的东西；`default`（headscale）、`headscale-tls`、xray、frps、
> HydroOJ、mongod 一律不碰。

## 18. 实跑证据台账（2026-10-21 起）

> 全部在**临时目录**（`mktemp -d`）里做，不碰工作树的库文件。
> 环境：macOS（darwin 27.0.0 arm64）、Node **v22.23.2**、**本机没装 nginx**（正好用来验证降级路径与探测失败路径）。

| # | 跑了什么 | 观察到 |
|---|---|---|
| E1 | `cd platform && node --disable-warning=ExperimentalWarning --test` | **1290 例 / 1289 通过 / 0 失败 / 1 跳过**（macOS / darwin arm64；测于「测试临时目录泄漏修复轮」的工作树；此前基线 981/981）<br>⚠️ 数字是**测得时**的实况；后续阶段合入会变（用例数只增不减）⇒ **以实跑为准** |
| E2 | `cd platform && node scripts/audit-scan.js` | **退出码 0**（词条 15 条、扫描 224 个文件、发布产物 `platform/web/dist` 另扫 60 个、0 违规） |
| E3 | `DATA_DIR=<tmp>/data node scripts/migrate.js` | `迁移完成，当前版本 6`（本次应用 001–006 六个迁移） |
| E4 | `node scripts/seed.js` 连跑两次 | 第一次「已创建管理员：13800000000」，第二次「管理员已存在」⇒ 幂等 |
| E5 | `node scripts/backup.js` / `--out` / `--keep-days --keep-count` | 全部退出码 0；输出 `[backup] 完成：app-<UTC>.db（<字节> 字节，<页> 页）` |
| E6 | `node scripts/restore.js`（活 pid / pid 文件坏 / 成功） | 活 pid ⇒ 拒绝；pid 不可解析 ⇒ **保守判为在跑并拒绝**；成功 ⇒ 旧库留存 + **删旧 `-wal`/`-shm`** + 新库就位 |
| E7 | `node src/server.js` + `curl -s http://127.0.0.1:8080/api/health` | `{"ok":true,"at":"..."}` |
| E8 | `bash deploy/nginx-http2-compat.sh` × 4 个 `NGINX_VERSION` + 不探测 | 1.18.0 / 1.24.0 ⇒ 降级；1.25.1 / 2.0.0 ⇒ 保留 `http2 on;`；不探测 ⇒ 降级 |
| E9 | 父代理修复轮：`test/deploy-assets.test.js` 的「自动探测必须认得 nginx 真实输出格式」（假 `nginx` 放 `PATH`、输出官方格式版本号、**不**给 `NGINX_VERSION`） | 1.24.0 ⇒ 被探测到并降级；1.25.1 ⇒ 被探测到并保留 `http2 on;`（这条钉住的正是原缺陷） |
| E10 | 沙箱 `install.sh`：**缺 nginx** | 退出码 1，错误信息明确，**沙箱目录零改动** |
| E11 | 沙箱 `install.sh`：`SESSION_TTL_DAYS=abc` / `SESSION_ABSOLUTE_TTL_DAYS=0` / `SESSION_TTL_DAYS=3.5` | 三次都退出码 1，**沙箱目录零改动** |
| E12 | 沙箱 `install.sh`：完整部署（nginx 桩 = 1.24.0） | 退出码 0；环境文件含 `SESSION_ABSOLUTE_TTL_DAYS=30`；站点配置**自动降级**成 `listen 443 ssl http2;`；`alias .../web/assets/` 为**预留位** |
| E13 | 沙箱 `install.sh`：连跑两次 | 两次退出码 0；第二次「本次无新迁移」「管理员已存在」⇒ 幂等 |
| E14 | 沙箱 `install.sh`：`nginx -t` 失败（有旧配置 / 无旧配置） | 有旧 ⇒ 还原旧配置；无旧 ⇒ **站点文件与软链都撤销**，`sites-enabled/` 为空 |
| E15 | 沙箱：会话天数取值矩阵（12 组） | 合法（`7/30`、`1/1`、**更严的 `7/3`**、带前导零 `007/030`）⇒ 放行；`0`、`abc`、`3.5`、`-1`、空串 ⇒ **退出码 1** + 人话提示；`99999999999999999999` ⇒ **退出码 1** + 「不能超过 3650 天」，**第一行没有 bash 的 `integer expression expected` 噪音** |
| E16 | 沙箱：`nginx -t` 失败 + **预置软链指向别的文件** | 退出码 1；**软链被还原成部署前的指向**（`OTHER.conf` 没被删）；本次写入的站点文件已撤销；**没有预置软链**时软链同样撤销、`sites-enabled/` 为空 |
| E17 | 变异检验（`/tmp/p6-mutate/t2fix2.mjs`） | **18 个变异体 / 18 KILLED / 0 存活 / 0 无效 / 0 锚点异常**；对照组（未改动副本）**22/22 全绿** |
| E18 | **真机**（8.133.200.235 / Debian 12 / ext4 / Node v22.22.2 / nginx 1.22.1 / systemd 252）跑 `nginx-http2-compat.sh` | `nginx 1.22.1 < 1.25.1：已降级为 listen ... ssl http2;`；独立的 `http2 on;` 行**已消失** |
| E19 | 真机上把降级后的站点配置（替换占位符 + 临时自签证书）喂给 `nginx -t -c <临时主配置>` | `syntax is ok` / `test is successful`（退出码 0）；**系统既有配置的 `nginx -t` 仍然正常**（本轮没写 `/etc/nginx/**`、没 reload） |
| E20 | 真机上 `heikesong.service`（替换占位符后）`systemd-analyze verify` | 退出码 0、**零告警**（systemd 252） |
| E21 | **真机跨平台复现**（P6 Task 8 Step 4 的原配方，三条命令） | `node scripts/migrate.js` ⇒ `迁移完成，当前版本 6`；`node --test` ⇒ **1290 例 / 1288 通过 / 0 失败 / 2 跳过**（2 跳过各有一条：Task 5 已落地故不适用；**以 root 跑、mode 000 也读得到**）；`node scripts/build-demo.js` ⇒ 产物 60 文件、**伴生文件 0 个** |
| E22 | **临时目录泄漏闸 + 泄漏差分**（本轮新增 `scripts/temp-leak-scan.js`） | 静态闸：本机与真机**各 0 违规**（退出码 0）；跑完全量后**两侧临时目录残留都是 0 个**（修前：本机 3 个、真机 4 个，真机历史累计 80+ 个）<br>⇒ 这条是**服务器运维口径**：测试跑完不会再往 `/tmp` 里堆 `hks-*` 目录把磁盘吃满 |
| E23 | 清理历史残留（本机 macOS） | `$TMPDIR` 下 **24 252 个** `hks-*` 目录 / **5.7 GB** ⇒ 同盘暂存后一次性交给 `mavis-trash` 回收（可恢复）⇒ `$TMPDIR` 从 ~5.9 GB 降到 **229 MB** |
| E24 | 真机部署**前置预检**（让路形态：渲染 `deploy/nginx-plain-http.conf` → 临时主配置 `nginx -t`） | 占位符**零残留**；8081 空闲；`nginx -t -c <临时主配置>` ⇒ `syntax is ok` / `test is successful`（退出码 0）；**系统既有配置的 `nginx -t` 仍正常**（全程未写 `/etc/nginx/**`、未 reload） |
| E25 | 真机执行 `install.sh`（`SERVER_NAME=8.133.200.235` + `NGINX_TEMPLATE=…/nginx-plain-http.conf` + `NGINX_HTTP_PORT=8081` + `COOKIE_SECURE=false`） | 退出码 **0**；用户/目录/环境文件/迁移（版本 6）/种子/系统单元/nginx 站点全部落地；`nginx -t` 通过后 **reload 成功**；`systemctl is-active heikesong` ⇒ **active** |
| E26 | 真机部署后的健康检查（应用直连 8080 / 经 nginx 8081） | `127.0.0.1:8080/api/health` ⇒ **200**；`127.0.0.1:8081/api/health` ⇒ **200**；返回 `{"ok":true,"at":"2026-10-21T15:10:40.300Z"}` |
| E27 | 真机**登录链路**（经 nginx 8081，重点验 `COOKIE_SECURE=false`） | 登录 ⇒ **200**，响应头 `Set-Cookie: hk_session=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=604799` —— **不带 Secure** ✅（否则明文 HTTP 下浏览器会拒收 ⇒ 登录失效）；带该 Cookie 访问 `/api/me` ⇒ **200**、`/api/registrations` ⇒ **200**；公开榜单 `/api/leaderboard/rolling` ⇒ **200**；SSE `/api/stages/ed_1/events` ⇒ 首段 `event: connected` ✅（经 nginx 未被缓冲） |
| E28 | 真机上**既有业务未受影响**（部署前后逐项比对） | `nginx` / `xray` / `headscale` / `frps` / `mongod` **全部 active**；80 / 443 / 7000 / 8888 仍在听；`/etc/nginx/sites-enabled/` 里 `default`（headscale）与 `headscale-tls` **原样保留**，只是**新增**了 `heikesong.conf` 软链；headscale 控制台（80）仍 HTTP **200** |
| E29 | **公网可达性实测**（从公网侧扫这台机的端口） | 公网可达的只有 **22 / 80 / 443 / 7000 / 8888** 五个端口；`8080`/`8081`/`6000`/`7001`/`18080`/`19090`/`8443`/`27017`/`18443`/`8082`/`8088`/`9090`/`10000` **全部不通**。<br>⚠️ **对照（决定性）**：主机侧 `8081` **确实在监听 0.0.0.0**（`ss -lnt` 可见），且主机**零防火墙规则**（`iptables -L INPUT` 0 条 / nftables 空 / firewalld 未装）⇒ **过滤发生在云侧**，不在主机。<br>⇒ 结论：这是**云控制台入方向规则**的事（安全组 / 端口映射）：加一条 **TCP 8081** 的入方向规则即可，**代码与主机配置零改动**。<br>⚠️ 旁证：`7001`（frp 隧道的对外端口）现在也不通，而 2026-10-14 的 frps 日志里还有人连它 ⇒ **云侧的白名单被改过** |
| E30 | **本机全量测试**（提交 `788b582`） | **1339 例 / 1338 通过 / 0 失败 / 1 跳过**（macOS / darwin arm64，耗时 12.1 秒）；`audit-scan` 与 `temp-leak-scan` 两个机器闸**退出码均 0** |
| E31 | 判别性用例 `platform/test/deploy-tls-port.test.js` | **19 条全绿**（含判别性对照：模板混入 80 块 / upstream 撞名 / 跳转目标丢端口 / 端口校验被架空 / http2 降级丢失） |
| E32 | **变异检验**（`/tmp/mutate-tls-port.mjs`） | **15 个变异体 / 15 KILLED / 0 存活 / 0 失配**；覆盖：模板去 TLS、模板塞 80 块、upstream 撞名、删 SSE 关缓冲、放宽 TLS 版本下限、占位符串台、`install.sh` 不替换占位符、不调校验、默认值被改、校验复制成两份、兼容脚本退回只认 443、兼容脚本不删 `http2 on;`、证书路径写死、跳转目标丢端口、跳转模板也定义 upstream |
| E33 | **漂移审计 + 计划块同步** | A 151 ｜ B 4 ｜ C-EXT 59 ｜ **C-RW 0** ｜ D 18；被改的两个文件（`deploy/install.sh`、`deploy/nginx-http2-compat.sh`）已用 `plan-block-sync.mjs` **逐字同步回 P6 计划块**，`--verify` 复验 ⇒ 计划第 2364 行 / 2120 行**逐字一致** |
| E34 | **真机部署前预检**（TLS 端口形态；全程未写 `/etc/nginx/**`、未 reload） | `8444` 空闲；兼容脚本在 **nginx 1.22.1** 上正确降级为 `listen 8444 ssl http2;`（`http2 on;` 独立行已消失）；占位符**零残留**；**临时主配置** `nginx -t -c <临时>` ⇒ `syntax is ok` / `test is successful`（退出码 0）；**系统既有配置的 `nginx -t` 仍正常** |
| E35 | **真机 Stage 1**：`install.sh`（`NGINX_TEMPLATE=…/nginx-tls-port.conf` + `NGINX_TLS_PORT=8444` + **独立站点文件** `heikesong-tls.conf` + `COOKIE_SECURE=false`） | 退出码 **0**：迁移（版本 6）/种子（管理员已存在 ⇒ **口令用不上**，故真口令不必上机）/系统单元/nginx 站点全部落地；`nginx -t` 通过后 reload；服务 **active**；`8444` 监听 `0.0.0.0`；**明文 8081 未受影响**（仍 200）；既有业务全 active |
| E36 | 本机 TLS 验证（`curl --resolve 8.133.200.235:8444:127.0.0.1`，**不用 `-k`** ⇒ 验的是真证书链） | `ssl_verify=0`（**校验通过**）；`/api/health` ⇒ 200 `{"ok":true,...}`；首页 ⇒ 200（707 字节） |
| E37 | **公网 https 实测** | `8444` **公网直接可达**（**未改安全组** —— 此前那轮只探过一组固定端口清单，8444 不在其中）；首页 200 / `styles.css` 200（1192B）/ `app.js` 200（5784B，`text/javascript`）/ 健康检查 200 / 公开榜单 200；登录 ⇒ **HTTP/2 200** |
| E38 | **真机 Stage 2**（明文入口 301 + `COOKIE_SECURE=true`） | `install.sh` 退出码 **0**；`http://…:8081/api/health` ⇒ **301** → `https://8.133.200.235:8444/api/health`；https 登录 ⇒ `Set-Cookie: …; HttpOnly; SameSite=Lax; Path=/; Max-Age=604799; **Secure**`；带该 Cookie 访问 `/api/me` ⇒ 200、`/api/registrations` ⇒ 200；SSE `/api/stages/ed_1/events` ⇒ 首段 `event: connected` ✅（经 https 未被缓冲） |
| E39 | **证书续期链路演练**（`certbot renew --dry-run`，6 天短周期证书的关键前置） | `Congratulations, all simulated renewals succeeded: /etc/letsencrypt/live/8.133.200.235/fullchain.pem (success)` ⇒ **ACME webroot 校验链路未被本次部署掐断**（TLS 模板不碰 80 就是为了这个） |
| E40 | 真机最终体检 | `nginx`/`xray`/`headscale`/`frps`/`mongod`/`heikesong` **全部 active**；headscale 控制台（80）仍 **200**；ACME 校验路径仍由 `default_server` 提供（探测 404 = webroot 命中）；环境文件 `COOKIE_SECURE=true`；监听端口：80 / 443(xray) / 7000(frps) / 8081(跳转) / **8444(TLS)** / 8888(HydroOJ)，应用仍只绑 `127.0.0.1:8080` |

---

*配套：[`superpowers/specs/2026-10-20-heikesong-platform-design.md`](superpowers/specs/2026-10-20-heikesong-platform-design.md)｜[`requirements-traceability.md`](requirements-traceability.md)｜[`rule-decisions.md`](rule-decisions.md)｜[``]()*

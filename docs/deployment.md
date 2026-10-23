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

# ② 明文入口改成 308 跳转（**替换**掉原来的明文站点文件；⛔ 必须是 308 不是 301，见 §17.5）
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

### 17.5 ⛔ 踩过的坑：重定向会吃掉 POST 请求体（301 ⇒ 登录报「手机号或密码不正确」）

**症状**：用户在**旧的明文地址**上登录，提示「手机号和密码错误」；但同一组凭据在 https 地址下**登录成功**。

**真凶**：重定向状态码用错了。浏览器对重定向的处理分两类：

| 状态码 | 浏览器行为 |
|---|---|
| 301 / 302 / 303 | **把 POST 降级成 GET，并丢掉请求体** |
| 307 / 308 | **保留方法与请求体**，原样重发 |

我们的明文入口后面跟着**登录接口**（`POST /api/auth/login`）。用 301 时：

```
POST /api/auth/login  →  301  →  浏览器改成 GET、body 为空  →  服务端收到空 body
                       →  判定为「手机号或密码不正确」  →  401 INVALID_CREDENTIALS
```

⇒ **口令是对的，是重定向把请求体吃掉了**。而错误信息指向「口令错」，排障方向会被完全带偏。

⇒ **正解：用 308**（307 的永久版，永久迁移到 https 就该用永久码）—— 保留方法与请求体，
POST 原样送达。`deploy/nginx-https-redirect.conf` 固定用 308，并在模板注释里写明了这个原因。

**判别性钉子**：`platform/test/deploy-tls-port.test.js` 里有一条用例把
「301/302/303 丢请求体、307/308 保留」这条规则写成了**可执行断言**
（并附一条对照组，断言这条规则本身写反了也会红）⇒ 任何人把 308 改回 301，测试立刻红。

### 17.6 ⛔ 踩过的坑：reload 没生效，脚本却报成功

**症状**：`install.sh` 退出码 **0**、日志一路绿灯，但**线上跑的还是旧配置**。

**真凶**：机器上残留着**另一个** nginx 实例（一个遗留的测试进程），它把 `/run/nginx.pid` 覆盖了 ⇒
`systemctl reload nginx` 把 SIGHUP 发给了**那个测试进程**，真正的 master 从没收到信号。

⇒ 这比部署失败更危险：运维看到「成功」就不会再查，直到线上行为与预期不符才发现。

**已加的护栏**（`deploy/install.sh` 的 `assert_nginx_reload_took_effect`）：

- reload 前后记录 nginx master 及其 **worker 集合**；
- 判据：nginx 收到 SIGHUP **一定会起新 worker**（配置一个字没改也一样会换 ——
  实测：reload 前 `{488927,488928}` → reload 后 `{488927,488955,488956}`）；
- worker 集合**没变** ⇒ 信号没送到真正的 master ⇒ **直接失败并说清原因**（不许报成功）；
- 读不到 pid 文件 / worker 集合时 ⇒ **放行并告警**（首次部署、BusyBox 的 `ps` 不支持 `--ppid` 等情况不能误伤）。

⚠️ 顺带一条运维纪律：**不要在生产机上留测试进程**。本次事故的起点就是一次用来验证
`return 308` 语法的临时 nginx（`nginx -c /tmp/xxx.conf`）没被杀掉 ——
它抢走了 pid 文件，还让 systemd 把它误认成 MainPID，kill 它时 systemd 对整个 cgroup 发了 SIGTERM，
把真 nginx 一起带走了（本次已修复，nginx 已重新拉起并自检通过）。

### 17.6.5 排查「偶发失败」：先查工作树是不是**中间态**

全量测试偶发挂一条、但**单独跑每个测试文件都绿** —— 别急着怀疑并发时序。

**本仓最常见的中间态**：改了实现（`src/`、`web/`）但**还没同步回 owning 阶段的计划块**
⇒ 漂移审计的 **C-RW ≠ 0** ⇒ `platform/test/plan-block-audit.test.js` 里那条
「审计工具在本仓跑出的判定：无 D、无 C-RW」**按设计报红**。

⇒ 排查顺序：

1. 单独跑可疑的测试文件 —— 全绿 ⇒ 不是并发问题；
2. 跑 `node docs/tools/plan-block-audit.mjs platform` —— **C-RW 是否 ≠ 0**；
3. C-RW ≠ 0 ⇒ 是**中间态**，把改动同步回计划块即可（`plan-block-sync.mjs`），
   **不是代码缺陷**。

> 反过来这条也是好消息：**计划块漂移闸在按设计工作** —— 它能在提交前就把「忘了同步」
> 变成一次可见的失败，而不是悄悄溜进主干。

### 17.7 明文入口的三个选项

| 选项 | 做法 | 结果 |
|---|---|---|
| **留着**（不推荐） | 什么都不动 | 明文入口仍可访问；`COOKIE_SECURE=true` 后**登录会失败**（浏览器拒收 Secure Cookie）⇒ 半残状态 |
| **308 跳转**（推荐） | `deploy/nginx-https-redirect.conf` | 旧链接自动落到 https；无业务流量走明文。⛔ **必须 308**（见 §17.5 的坑） |
| **删掉** | `rm` 站点文件 + 软链 + reload | 最干净；旧链接断 |

### 17.8 证书续期（**短周期证书必看**）

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

### 17.9 回滚

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

## 18. 公网演示站（静态包）的发布

> 演示站 = `node scripts/build-demo.js` 的产物：规则引擎在**浏览器里**真实运行，
> **不启后端、不建库、不连数据库**。与平台本体是**两个独立站点、两个独立 origin**。
> 本节形态已在真机（8.133.200.235）实跑。

### 18.1 三个交付路径（选哪个都不需要「云账号」，只有第三条要）

| 路径 | 需要什么 | 得到什么 |
|---|---|---|
| **① 独立端口的静态站**（本节形态，推荐） | 云侧放行一个 TCP 端口 | `https://8.133.200.235:8445/`；与平台**不同 origin**（cookie / localStorage 互不串） |
| ② 对方本地起静态服务 | 对方有 Node 或 Python | 解压后 `node scripts/serve-demo.js` → `http://127.0.0.1:8090/`（**完全离线**） |
| ③ 第三方静态托管 | **要云账号**（GitHub Pages / Cloudflare Pages / 对象存储…） | 一个公共 URL；这条路只是选项之一 |

### 18.2 ⛔ 演示包不能「双击打开」

`index.html` 用的是 `<script type="module">` ⇒ **ES module 受 CORS 约束** ⇒
浏览器会拦截 `file://` 下的模块脚本（Chrome / Edge / Firefox / Safari 都拦）⇒
**压缩包发过去双击 index.html 是打不开的**，必须「起个静态服务」（路径 ① 或 ②）。

⇒ 正因如此，演示站的 `index.html` 里资源引的是**相对路径**（`./web/app.js`），
挂到任意 base path 下都能正常加载。

### 18.3 发布命令

```bash
sudo SERVER_NAME=8.133.200.235 \
     DEMO_PORT=8445 \
     CERT_PATH=/etc/letsencrypt/live/8.133.200.235/fullchain.pem \
     KEY_PATH=/etc/letsencrypt/live/8.133.200.235/privkey.pem \
     ./platform/deploy/deploy-demo-site.sh
```

这个脚本（`platform/deploy/deploy-demo-site.sh`）会依次做：

1. **构建**：`cd /opt/heikesong/platform && node scripts/build-demo.js --out /opt/heikesong/demo`
   ⇒ 演示站与平台本体**永远来自同一份源码**，不存在「演示站是旧版本」；
2. **写 nginx 站点**（模板 `deploy/nginx-demo-static.conf`）：只发静态文件，
   ⛔ **没有 upstream、也没有 proxy_pass** ⇒ 演示站碰不到平台的任何 API；
3. **HTTP/2 兼容**（与 `install.sh` 同一套兼容层、同一顺序：先兼容、后替换占位符）；
4. **nginx -t 通过才 reload**；不通过 ⇒ **回滚**（撤销站点文件与软链，坏配置不留在线上）；
5. **实跑校验**：首页 / index.html / web/app.js 三项都必须 200，否则判失败。

### 18.4 ⚠️ 云侧端口要放行

主机侧**零防火墙**（iptables INPUT 0 条 / nftables 空 / firewalld 未装）⇒
**能不能从公网访问，取决于云侧的入方向规则**。

⚠️ 端口是**逐个放行**的，不是区间：实测 **8444 通、8445 不通**（8443 / 8082 / 8088 也不通）⇒
新开一个端口就要加一条规则。

### 18.5 更新演示站

重跑同一条命令即可（幂等）：构建会先清空产物目录 ⇒ 不会有残留旧文件。
⚠️ 注意：演示站的资源文件名**没有内容哈希** ⇒ 缓存只给 5 分钟（`max-age=300`），
不要改成长期缓存，否则发新版后浏览器还用旧文件。

### 18.6 回滚

```bash
rm -f /etc/nginx/sites-enabled/heikesong-demo.conf /etc/nginx/sites-available/heikesong-demo.conf
nginx -t && systemctl reload nginx
```

> 只删**本次新增**的东西；平台本体的站点文件（`heikesong.conf` / `heikesong-tls.conf`）不碰。
> 产物目录（`/opt/heikesong/demo`）建议先改名留档，确认无影响后再清理。

### 18.7 机器闸：bash 变量名吞非 ASCII

⚠️ **bash 允许非 ASCII 字符出现在标识符里** ⇒ `"$NGINX_SITE（模板…"` 里的变量名会被
解析成 `NGINX_SITE（` ⇒ **运行时 unbound variable** ⇒ 脚本当场死。
而 `bash -n` **查不出来**（那行语法是合法的，只是运行时才炸）。

⇒ 一律写 `${VAR}`。机器闸：

```bash
cd platform && node scripts/bash-var-scan.js ; echo "退出码=$?"
```

> 这个坑本项目**踩过两次**，所以做成了闸（而不是靠人记）。

### 18.8 计划块漂移审计：⚠️ 工具自己也会骗人

```bash
cd <repo> && node docs/tools/plan-block-audit.mjs platform
node docs/tools/plan-block-audit.mjs platform --selftest   # 自检（防假绿）
```

判定含义：`A` 逐字一致 ｜ `B` 实现含该片段 ｜ `C-EXT` 良性扩展（中间被插入，只需台账记一句）｜
`C-RW` **真漂移（必须同步回计划）** ｜ `D` 计划里有、实现里没有。

⛔ **这个工具本身出过 bug，而且症状极具欺骗性**：

- 扩展名正则写成 `(?:js|html|css|sql|json)` ⇒ **`js` 排在 `json` 前面**、路径部分贪婪
  ⇒ `rules/tiebreak.json` 被匹配成 `rules/tiebreak.js`
  ⇒ 文件明明在实现里，却被判成 **D(无实现)**。
- ⛔ **D 类当时只计数、不打印明细** ⇒ 工具「有输出」⇒ **没人发现判据本身是错的**
  ⇒ 18 个 `rules/*.json` 全是假阳性，而**真正的 C-RW 被淹没在噪声里**。

⇒ 已修：扩展名**长的在前** + 负向断言整体匹配 ｜ 路径提取抽成可测函数 ｜
**D 类打印明细** ｜ 新增 `--selftest`（正反样本判定不符即退出码 2）｜
主流程用 `import.meta.main` 守卫（可被测试 import）。回归用例见
`platform/test/plan-block-audit.test.js`（7 条，变异 7/7 全杀）。

> **教训**：**审计工具必须自带自检 + 失败必须打印明细**。
> 一个「有输出但判据是错的」工具，比没有工具更危险 —— 它会让人误以为已经查过了。

## 19. 实跑证据台账（2026-10-21 起）

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
| E41 | **用户报障复现**：旧地址 `http://8.133.200.235:8081/` 上用正确口令登录 | ① 直接 POST 旧地址 ⇒ **301**（`Location: https://8.133.200.235:8444/api/auth/login`）；② **跟随跳转** ⇒ **401 `INVALID_CREDENTIALS`「手机号或密码不正确」**；③ 同一凭据直接走 https ⇒ **200** ⇒ **口令是对的，问题在重定向** |
| E42 | 根因定位 | 浏览器对 301/302/303 会**把 POST 降级成 GET 并丢掉请求体** ⇒ 登录接口收到空 body ⇒ 报「手机号或密码不正确」。**真凶是状态码用错，不是凭据错** |
| E43 | 修复一：跳转状态码 301 → **308** | 308（307 的永久版）**保留方法与请求体** ⇒ POST 原样送达。真机复测：旧地址 POST ⇒ **308** ⇒ 跟随 ⇒ **HTTP/2 200** + 完整用户对象 + `Set-Cookie …; Secure`；旧地址 GET 首页 ⇒ 跟随 ⇒ **200** |
| E44 | 根因定位（第二个坑）：**reload 没生效却报成功** | 真机 `ps` 显示**两个 nginx master**：`445717`（真 master，10-14 启动，持 8081 监听套接字）与 `488602`（**我用来验证 `return 308` 语法的临时 `nginx -c /tmp/t308.conf`**，未杀掉）。它把 `/run/nginx.pid` 覆盖了 ⇒ `systemctl reload nginx` 的 SIGHUP **发给了那个临时进程** ⇒ 真 master 从没收到 ⇒ 磁盘上是 308、线上仍在跑 301，而 `install.sh` **退出码 0** |
| E45 | 清理与恢复 | kill 临时进程时，systemd 把它误认成 MainPID ⇒ 对**整个 cgroup** 发 SIGTERM ⇒ 真 nginx 一并倒下（80/18443/8081/8444 全部短暂不可用）。`systemctl reset-failed nginx` + `systemctl start nginx` ⇒ `active`、MainPID 与 pid 文件一致、`nginx -t` 通过；headscale 控制台（80）**200**、https 8444 **200**、明文口 **308** |
| E46 | 修复二：`install.sh` 加 **reload 生效校验**（`assert_nginx_reload_took_effect`） | 判据：nginx 收到 SIGHUP **一定会起新 worker**（实测配置未变时 worker 仍从 `{488927,488928}` 换到 `{488927,488955,488956}`）⇒ reload 后 worker 集合没变 ⇒ **直接失败并说清原因**，不许报成功；读不到 pid 文件/worker 集合时**放行并告警**（不误伤首次部署与 BusyBox `ps`） |
| E47 | 判别性用例 | `platform/test/deploy-tls-port.test.js` 增至 **24 条**（新增：308 保留 POST body 的可执行断言 + 规则写反的对照组 + reload 生效校验的三条）；变异检验 **18 个变异体**（新增 M16 退回 301 / M17 去掉校验调用 / M18 校验永远放行） |
| E53 | **新增机器闸 `scripts/bash-var-scan.js`** | 扫全仓 **12 个 shell 文件，0 违规**（退出码 0）；自检通过（正反样本判定正确）。⚠️ 这个闸抓到的是**本轮真实踩的坑**：bash 允许非 ASCII 出现在标识符里 ⇒ `"$NGINX_SITE（模板…"` 会被解析成变量名 `NGINX_SITE（` ⇒ **运行时 unbound variable**（`bash -n` 查不出来）⇒ 写脚本时实际踩了 **8 处**，已全部改成 `${VAR}` |
| E48 | **真机构建演示站**（`node scripts/build-demo.js --out /opt/heikesong/demo`） | 产物 **60 个文件 / 464K**；顶层 `build-manifest.json, index.html, rules, seed, src, web`；**规则文件 12 个**、领域层文件 23 个；「✅ 领域层浏览器安全检查通过」 |
| E49 | **真机第一次发布**（`deploy-demo-site.sh`） | ⛔ **失败**：`nginx -t` 报 `unknown directive "http2"`（nginx **1.22.1** 不认 `http2 on;`，那是 ≥ 1.25.1 的语法）⇒ **回滚按设计生效**（站点文件与软链都撤销、平台未受影响）⇒ 补上 `nginx-http2-compat.sh` 兼容层（与 `install.sh` 同一套、同一顺序）后重跑 ⇒ **退出码 0** |
| E50 | 真机发布成功的自检 | 兼容层输出 `nginx 1.22.1 < 1.25.1：已降级为 listen ... ssl http2;`；`nginx -t` 通过后 reload；**首页 200 ｜ index.html 200 ｜ web/app.js 200** |
| E51 | 本机验证演示站（`--resolve` 走**真证书链**，不用 `-k`） | `/` 200（715B）/ `/index.html` 200 / `/web/app.js` 200（5784B）/ `/rules/points.json` 200（1993B）；`ssl_verify=0`（**证书链真实校验通过**） |
| E52 | ⚠️ **公网 8445 不通** | 公网侧全部 `000`（连不上）；对照：**8444 通**、8443 / 8082 / 8088 / 9090 等均不通 ⇒ 云侧是**逐个端口放行**、不是区间 ⇒ 新端口要加一条入方向规则（我此前说「8444 不需要改安全组 ⇒ 8445 也不用」是基于 8444 的经验，对 8445 **不成立**） |
| E54 | ⚠️ **真实浏览器实测发现演示站「打开即坏」** | 用浏览器打开演示站（**不带任何参数**）⇒ 榜单页白屏报 **`Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)`**；网络面板显示它在请求 `/api/me`、`/api/leaderboard/rolling` ⇒ 静态站上这两个路径全 **404** |
| E55 | 根因 | 源前端用**查询参数**判定演示模式：`const isDemo = new URLSearchParams(window.location.search).get('demo') === '1'` ⇒ 不带 `?demo=1` 就走**真实 API 适配器**（`web/api.js`）。<br>⚠️ 同一份前端要同时当「正式版」和「演示版」，所以判定放在运行时 —— 但**对外发布的静态包没人会记得加这个参数**。⇒ 构建层必须钉死 |
| E56 | 修复 | `scripts/build-demo.js` 在**产物**里把 `const isDemo = ...` 那一行改写成 `const isDemo = true;`（源文件不动 ⇒ 正式版的 `?demo=1` 行为完全不变）。<br>⛔ **找不到那一行就构建失败**（fail-fast）：宁可构建不出来，也不发一个「打开即坏」的包 |
| E57 | 浏览器复测（换端口避开 5 分钟缓存） | **不带任何参数**打开 ⇒ 演示横幅出现（「当前是公网演示站……规则引擎是在你的浏览器里真实运行的」）、榜单页正常渲染、**控制台 0 错误** ⇒ 访客路径打通 |
| E58 | 真机重新发布 | `install.sh` 同步源码（退出码 0）→ `deploy-demo-site.sh` 重建并发布（退出码 0）⇒ 产物 `isDemo = true` ✅；平台本体 **8444 → 200**、**8081 → 308**、演示站 **8445 → 200**，全绿 |
| E59 | ⛔ **漂移审计工具自身有 bug**（本轮由 `plan-block-sync --verify` 报「找不到代码块」而暴露） | 工具的扩展名正则写成 `(?:js\|html\|css\|sql\|json)` —— **`js` 排在 `json` 前面**、而路径部分贪婪 ⇒ `rules/tiebreak.json` 被匹配成 `rules/tiebreak.js` ⇒ 该文件在实现里明明存在，却被判成 **D(无实现)**。<br>⚠️ **D 类只计数不打印明细** ⇒ 工具「有输出」⇒ 没人发现判据本身是错的 ⇒ **18 个 `rules/*.json` 全是假阳性**，而**真正的 C-RW 被淹没在噪声里** |
| E60 | 修工具（根因修，不是打补丁） | 扩展名清单改为**长的在前**（`json` 在 `js` 前）并加**负向断言** `(?![A-Za-z0-9])` 兜住整体匹配；路径提取抽成可测函数 `extractPath()`；**D 类开始打印明细**（只计数不列清单 ⇒ 假阳性必然静默潜伏）；新增 **`--selftest`**（正反样本判定不符即退出码 2，防假绿）；主流程用 **`import.meta.main`** 守卫（否则被 import 时就去读相对路径下的计划文件 ⇒ cwd 不对直接抛错） |
| E61 | 修第二个归因 bug | hint 归因信号①-b 原本是「行首是反引号 ⇒ 从**整行**里挑一个路径」⇒ 散文里的**提及**被当成文件声明（`` `user_roles` 表**已在 Task 2 的 `001_init.sql` 里建好** `` ⇒ `001_init.sql` 被误归因成规格块）⇒ 收紧为「只认**行首第一个反引号 token**」 |
| E62 | 修完后的审计数字（**旧 → 新**） | **A 151 → 166 ｜ B 4 → 6 ｜ C-EXT 59 → 61 ｜ C-RW 0 → 3 → 0 ｜ D 18 → 0**<br>⚠️ 中途 C-RW 冒出 **3** 条（`rules/points.json`、`rules/tiebreak.json`、`rules/milestones.default.json`）—— 那是被假 D 掩盖的**真漂移**（后续阶段给规则加了溯源注释/字段，实现更新了但计划块没同步）⇒ 已用 `plan-block-sync.mjs` **逐字同步回 owning 阶段计划**（P0 两份 / P3 一份）⇒ `--verify` 复验**全部逐字一致** ⇒ C-RW 归零<br>⚠️ **归因总数 232 → 233**，数量对得上 ⇒ 是**重新归因**而非丢失 |
| E63 | 新增回归用例 | `platform/test/plan-block-audit.test.js`（**7 条**）：`.json` 整体匹配不截断 / 其它扩展名整体匹配 / 无扩展名返回 null / 工具 `--selftest` 退出码 0 / 本仓审计 D=0 且 C-RW=0 / D 类必须打印明细 / 散文提及不得被误归因 |
| E64 | 变异检验（**判别性**） | **7 个变异体 / 7 全杀 / 0 存活 / 0 失配**：M1 扩展名顺序退回 / M2 去掉负向断言 / M3 `extractPath` 恒返回 null / M4 hint 归因退回整行挑路径 / M5 D 类明细不打印 / M6 自检判别性失效 / M7 `import.meta.main` 守卫失效 |
| E65 | 演示站发布资产变异检验（**第 9 轮 M4/M9 修复后的复跑**） | **9 个变异体 / 9 全杀 / 0 存活 / 0 失配**：M4（去掉 `DEMO_DIR` 在 `APP_DIR` 内部的守卫）改用**行为断言**后落地被杀；M9（塞进真实违规「$变量紧跟全角括号」）锚点修正后落地被杀 |
| E66 | 本轮全量复跑 | `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1371 例 / 1370 通过 / 0 失败 / 1 跳过**（测于本轮工作树；**以实跑为准**）；三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` **退出码均 0** |
| E67 | ✅ **公网 8445 已放行**（用户操作） | 公网 `https://8.133.200.235:8445/` ⇒ **HTTP 200**；`ssl_verify=0`（**真实证书链校验通过**，未用 `-k`）；**HTTP/2**（`http_version=2`）；关键路径 `/` `/index.html` `/web/app.js` `/seed/demo-data.json` `/web/seed/demo-data.json` `/rules/points.json` **全 200** |
| E68 | ⛔ **浏览器实测发现「访客打开就是空榜单」** | 真实浏览器打开公网演示站（**不带任何参数**）⇒ 榜单页显示「**暂无数据**」（演示横幅正常、控制台 0 错误、网络 0 失败请求 ⇒ **不是**加载失败，是**真的没数据**） |
| E69 | 根因 | 榜单数据来自 `state.results[stageId]`，而 results **只在 `POST /api/stages/:stageId/compute` 时被写入** —— 正式平台由管理员在后台发榜时触发，**演示站没有后台** ⇒ 访客永远拿不到计算结果。<br>⚠️ 计划里写的是「**点一下「计算」**，就能看到…」⇒ 但**前端根本没有任何地方调 compute**（`web/app.js` 与 10 个 view 全都没有）⇒ 那个「计算」按钮在 UI 上并不存在 |
| E70 | 修复（**用户选定：构建期预计算**） | `scripts/build-demo.js` 在构建时用**真实引擎**跑一次（`runDemoCompute`），把 `results` / `lastStageId` / `computations` 写进**产物里的两份种子**（根 `seed/` 与 `web/seed/`）⇒ 访客打开即见榜单。<br>⚠️ **源种子不动**（`web/seed/demo-data.json` 保持人可读、可评审）⇒ 产物与源码分离。<br>⚠️ 规则引擎**仍在浏览器里真实可复算** —— 访客自己触发 compute 会重算。<br>⚠️ 构建期加载的规则**必须与浏览器侧同一批**（用 `DEMO_RULE_FILES` 那 12 份，**不用** `src/config.js` 的 `loadRules` —— 那份含演示站用不到的 schedule/compliance/pools/audit）⇒ 否则「构建时算的」≠「浏览器里跑的」 |
| E71 | ⛔ **fail-fast** | 算出**空排名** ⇒ 构建**失败**（退出码非 0，报「演示种子预计算没有产出任何排名，拒绝构建」）⇒ 宁可构建不出来，也不发一个「打开就是空榜单」的包 |
| E72 | ⛔ **老访客兜底**（第二个 bug，浏览器实测揪出） | 演示站把访客状态存 localStorage（`STORAGE_KEY`），而 `ensure()` 是 **storage 优先、seed 兜底** ⇒ **旧版演示站访问过的人** localStorage 里留着一份**不带 results** 的旧 state ⇒ 榜单仍空（明明是第一次看到新版）。<br>⇒ 兜底：localStorage 的 results **一个赛段都没有** ⇒ 视为旧版遗留 ⇒ 从种子补 `results`/`computations`/`lastStageId`。<br>⛔ **只补计算结果，不覆盖访客自己的操作数据**（报名/评审等）⇒ 已有断言守住 |
| E73 | 判别性用例 | `platform/test/demo-static.test.js` 增至 **31 条**（新增 5 条：产物种子必须带 results / 结果必须真能算出榜单行 / 源种子不得被改写 / 空排名必须 fail-fast / 老访客 localStorage 兜底且不覆盖访客数据）。⚠️ 既有 D5-13 用例的**比较口径**改了：原断言「浏览器加载的种子 ≡ 仓库里的种子」与预计算冲突 ⇒ 改为「**两份产物种子彼此逐字相同** + **产物种子是源种子的超集**」（D5-13 的**意图**是「两个相对基准取到同一份」，未变） |
| E74 | 变异检验 | **9 个变异体 / 9 全杀 / 0 存活 / 0 失配**：M1 `buildDemoState` 退回丢弃 results / M2 退回不透传 lastStageId / M3 不写回 `web/seed` 那份 / M4 不写回根 `seed` 那份 / M5 空排名不再 fail-fast / M6 预计算用**不同的规则集** / M7 构建期改写源种子 / M8 去掉老访客兜底 / M9 兜底时覆盖访客数据 |
| E75 | 真机重新发布 | 源码同步 → `deploy-demo-site.sh` **退出码 0**；真机构建输出「✅ 构建期预计算完成：赛段 stage_final，排名 **5 支队伍**」；产物 60 文件 / 464K → **536K**（预计算结果 +12K，含 trace 留痕 5.4K） |
| E76 | 浏览器最终验收（公网） | 真实浏览器打开 `https://8.133.200.235:8445/` ⇒ **滚动总榜 5 支队伍带数据**（拾光队 10 分 B 段 / 回声队 8 分 C 段 / 风信子队 5 分 S 段 / 自由花队 0 分 D 段 / 北斗队 0 分 A 段）+ **降级告警 7 条全部真实展示**（归一化降级 / 缺双签 / 自由命题 / 自评差异 ×2 / 维度无评分 / 破同分键不可用）；**控制台 0 错误**、**网络 0 失败请求** |
| E77 | 本轮全量复跑 | `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1376 例 / 1375 通过 / 0 失败 / 1 跳过**（测于本轮工作树；**以实跑为准**）；三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` **退出码均 0**；漂移审计 **A 167 ｜ B 6 ｜ C-EXT 60 ｜ C-RW 0 ｜ D 0** |
| E78 | ⛔ **报障：登录仍报「手机号和密码错误」** | 用户用 `13800000000` / `XpLEdKLuUV2iDLriXHZ7TbZJ` 在 `https://8.133.200.235:8444/` 登录 ⇒ 报「手机号或密码不正确」。 |
| E79 | ⛔ **先证伪「凭据错」** | ① `curl` 同一手机号 + 同一口令 ⇒ **HTTP 200** + 完整用户对象（`isSuperadmin: true`）+ `Set-Cookie: hk_session=…; Secure`；② 真机库里该账号 **1 行、`active=1`、超管**、scrypt 哈希长度 130；③ 真机上逐字跑 `verifyPassword` ⇒ **只有「原样」24 位通过**，带首/尾空格、小写、大写、截断、多一位、拿手机号当口令 —— **全部拒绝** ⇒ **口令本身是对的**；④ 8081 明文口 ⇒ **308** 跳 8444（保留 POST body），跟随后 **200**。⇒ **凭据、账号、跳转链路全部正常**。 |
| E80 | ⛔ **真凶（临时诊断日志抓到的铁证）** | 在后端登录失败分支临时注入诊断（**只记长度与 SHA-256，绝不记明文**）⇒ 浏览器那次提交的原文：<br>`{"phoneLen":0,"phoneSha":"e3b0c442","pwLen":24,"pwSha":"2645b65c","pwCodes":[88,112,76,69,100,75,76,117,85,86,50,105,68,76,114,105,88,72,90,55,84,98,90,74],"hasCred":false}`<br>⇒ ⛔ **`phone` 是空字符串**（`e3b0c442` = 空串的 SHA-256 前缀、`hasCred:false` = 查不到账号）；**口令 24 位码点逐个正确**。<br>⇒ **浏览器根本没把手机号送出去** —— 用户看到的「13800000000」是输入框的**灰色 placeholder**，不是已填内容。⚠️ **后端对「手机号为空」与「口令错」返回同一个 401** ⇒ 提示**完全指错方向**。 |
| E81 | ⚠️ **诊断口径的坑（自己踩的）** | ① 第一版诊断注入点选在 `if (!ok)` 之后 ⇒ **成功时不打日志** ⇒ curl 基线 200 却查不到 DIAG 行（一度以为日志没生效）。② 首轮「清空后手输」的 401 来自**我的内置浏览器**（UA 是 `MiniMax/3.1.4 … Electron/42.8.0`），**不是用户的 Chrome**（UA `Chrome/155.0.0.0`）⇒ 差点归因到错误的对象。⇒ 结论：**分诊先看 UA 与时间戳**，别把工具的请求当成用户的请求。 |
| E82 | 修复 | `web/views/login.js` 抽出两个**可测纯函数** `readLoginForm()` / `validateLoginInput()`：手机号为空 / 格式不对 / 口令为空 ⇒ **本地拦下，一个请求都不发**，且提示**指向真正的原因**（手机号为空时**只提手机号**，不提密码）。⛔ 口令**不 trim、不变换**（口令里的空格是有效字符）；只 trim 手机号。 |
| E83 | 判别性用例 | 新增 `platform/test/login-view.test.js`（**5 条，DOM 级**：用手搓最小 DOM mock —— 本仓**零 npm 依赖**，不引 jsdom）：手机号为空 ⇒ **零请求**且提示指向手机号 / 格式不对 ⇒ 零请求 / 口令为空 ⇒ 零请求且指向密码 / 都填对 ⇒ 发出的请求体与输入一致 / 手机号被 trim 而口令不被 trim。<br>`platform/test/p1-frontend.test.js` 增 5 条纯函数用例（共 **23 条**）。 |
| E84 | 变异检验 | **8 个变异体 / 8 全杀 / 0 存活 / 0 失配**：M1 去掉手机号为空拦截 / M2 去掉格式校验 / M3 去掉口令为空校验 / M4 拦截后**仍然发请求** / M5 手机号不再 trim / M6 口令也被 trim / M7 提示改成「手机号或密码不正确」/ M8 提示里提到「密码」（指错方向） |
| E85 | 临时诊断代码已清理 | 诊断注入后用完即删（`cp` 回备份 ⇒ 重启 ⇒ `grep -c DIAG-login` = **0**）⇒ 线上 `server.js` 与仓库一致，**不留任何调试残留**。 |
| E86 | ⛔ **修复引入的回归风险（自查抓到的）** | 登录视图是**平台与演示站共用**的 ⇒ 新增的「手机号 11 位格式」校验会**连带打到演示站**。而演示站适配器**根本不校验凭据**（`api.demo.js` 的 `/api/auth/login` 直接返回演示管理员）⇒ 强制 11 位格式会把「随便看看」变成**填表** ⇒ 破坏演示体验。<br>⇒ 分档：`app.js` 把 `api.isDemo = isDemo` 挂到适配器上，登录校验按 `ctx.api.isDemo` 走**两档** —— 演示站只要求**非空**，真实平台才校验格式。 |
| E87 | 判别性用例（补） | `platform/test/login-view.test.js` 增至 **8 条**（新增 3 条：演示站不强制格式 / 真实平台默认仍强制（防分档带偏）/ 演示站 DOM 视图按演示口径放行）。 |
| E88 | 变异检验（补） | **10 个变异体 / 10 全杀 / 0 存活 / 0 失配**（在 M1–M8 之上加 M9 演示站也强制格式 / M10 `ctx.api.isDemo` 没传进校验）。⚠️ 首轮跑出 **1 条失配**（M2）—— 变异脚本的锚点还是改格式校验**之前**的文本 ⇒ **锚点必须跟着实现一起改**，否则「失配」会被误读成「测试没判别力」。 |
| E89 | ⚠️ **「偶发失败」的真相：不是偶发，是工作树中间态** | 全量跑出一轮 `1389 例 / fail 1`，单独跑每个测试文件都绿 ⇒ 看似偶发。**复现验证**：把 `web/app.js` 临时还原成改动前的版本 ⇒ 漂移审计立刻变成 **C-RW = 1** ⇒ `test/plan-block-audit.test.js` 的「审计工具在本仓跑出的判定：无 D、无 C-RW」**按设计报红**（`not ok 5`）⇒ 还原后 C-RW 归零、该用例复绿。<br>⇒ 那轮失败正是「改了 `login.js`/`app.js`、**还没同步回 P0 计划**」的中间态 ⇒ **不是缺陷，是上一轮专门加的审计回归闸在按设计工作**。<br>⇒ **教训**：「偶发失败」先查**工作树是不是中间态**（改动未同步 / 计划未回写），再查并发时序；本例连跑 **5 轮全量 + 8 轮针对性** 全绿。 |
| E90 | ✅ **登录闭环确认** | 用户在**自己电脑的 Chrome** 里重新登录 ⇒ **成功**。服务端证据：① nginx 日志 `POST /api/auth/login` ⇒ **200**，响应 **206 字节**（与 curl 成功时**完全一致**；失败时是 401 / 80 字节）；② 数据库 `sessions` 表最新一条 `created_at = 2026-10-22T07:14:20Z`（= 北京时间 **15:14:20**）⇒ 对应 `13800000000 / 组委会管理员`，`expires_at = 2026-10-29T07:14:45Z`（**7 天**）。⇒ **报障闭环**。 |
| E40 | 真机最终体检 | `nginx`/`xray`/`headscale`/`frps`/`mongod`/`heikesong` **全部 active**；headscale 控制台（80）仍 **200**；ACME 校验路径仍由 `default_server` 提供（探测 404 = webroot 命中）；环境文件 `COOKIE_SECURE=true`；监听端口：80 / 443(xray) / 7000(frps) / 8081(跳转) / **8444(TLS)** / **8445(演示站)** / 8888(HydroOJ)，应用仍只绑 `127.0.0.1:8080` |
| E91 | 📏 **本轮起点的实测量化** | 前端 **13 条路由 / 11 个视图 / 1067 行**，只消费 **11 个端点** ⇒ **46/57 端点（81%）没有任何界面入口**；导航是 **6 个平铺链接**、**所有人看到的一模一样**；`web/styles.css` 仅 **36 行 / 8 个颜色变量**（无 token 体系、无响应式、无表格样式、无状态样式）。<br>⇒ **根因**：P0–P6 的 108 条验收**全部锁在后端行为** ⇒ 后端被严验收、前端从没被验收过 ⇒ 前端停在「能跑通 Demo」的规模。 |
| E92 | 🎨 **设计系统** | `web/styles.css` **36 → 649 行**：① **设计 token**（语义色 20+ / 间距 4px 基数 9 档 / 圆角 5 档 / 字号 8 档 / 阴影 3 档 / 层级 3 档 / 布局 / 中文字体栈）② **组件层**（顶栏 + 导航组 / 面板 / 表格 + sticky 表头 / 指标卡 / 条形 / 徽章 / 按钮 4 变体 / 表单 4 件套 / 标签页 / 提示条 / 骨架屏 / 里程碑）③ **状态层**（加载 / 空 / 错三件套 + 响应式 900/560px + `:focus-visible` 焦点环 + `.sr-only` + 打印样式）④ **亮暗双主题**（`[data-theme]` + `prefers-color-scheme`）。<br>⇒ 换主题只换变量，**不改任何组件规则**。 |
| E93 | 🧩 **外壳三件套**（`web/ui.js`，新建） | `loadingState` / `emptyState` / `errorState` / `noticeState` / `badge` / `statCard` / `statRow` / `kvList` / `rankBadge` / `barRow` / `pageHead` / `panel` / `tabs` / `tableWrap` / `emptyRow` / `toast` / `sectionTitle` / `tone`。<br>⚠️ **全部是纯函数** —— 写成 innerHTML 模板字符串就没法断言「错误态必须带重试按钮」「空态必须有引导动作」，只能靠肉眼。`tone()` 白名单 **fail-closed**（非法色调降级 neutral，不拼进 class）。 |
| E94 | 🧭 **导航按角色分区**（`web/nav.js`，新建） | 分区是**声明式数据**：赛事（公开）/ 我的赛事（需登录）/ 组委会（角色含 `admin`，超管直通）。加页面 = 加一条数据，不改渲染逻辑。<br>⛔⛔ **设计红线：路由守卫只判「是否登录」，绝不按角色拦路** —— 能力点可以**直接授权给个人**（`assignments` 表），根本不经角色 ⇒ 前端手里只有角色 ⇒ 按角色拦 = **误伤有权限的人**。授权的唯一裁决者是 API（`can()` + `scopeClause`）。角色只用于**导航入口的呈现**，不阻断任何页面的可达性。 |
| E95 | 🔌 **后端最小扩展（只读 / 纯追加）** | ① `/api/me` 与登录响应带 `roles`（**角色键列表**，不构成任何授权依据，不属于泄露）② 新增 `GET /api/stages`（赛段选择器）③ 新增 `GET /api/workflows`（任务清单入口 + 任务计数）。<br>⚠️ 后两条的仓储函数**本来就有**（`listStages` / `listWorkflowsByEdition`），只是**没有端点** ⇒ 前端只能人肉拼 URL ⇒ 页面在生产上走不通。 |
| E96 | ⛔ **演示站缺 8 个端点（真坑）** | 演示适配器**完全没有**：`GET /api/registration-criteria`、`GET /api/teams`、`GET /api/task-packages`、`POST /api/teams/:id/members`、`GET/POST /api/registrations/:id*`、**整个 `/api/audit/*`**（复核队列 / 计算留痕 / 复算 diff）⇒ 公网演示站的**报名 / 我的战队 / 报名筛选台 / 复核队列 / 计算留痕 / 任务清单六页全是 404**（打磨前错误态是裸 `.card err`，**看不出来是端点缺失**）。<br>⇒ 全部补齐（形状逐字对齐真实后端）＋ 兜底错误码改用**专属** `DEMO_ENDPOINT_MISSING`（业务上的「单条不存在」也是 404，撞码就分不开）＋ 新增回归闸 `test/demo-api-parity.test.js`（**7 条**：表驱动扫 **21 个端点** + 形状逐字段断言）。 |
| E97 | 🛠️ **11 个视图打磨** | `web/views/*.js` **1067 → 2630 行**（+146%）：外壳三件套齐全（空态必须说清「为什么空 + 什么时候会有」、错误态必须带**真的能点**的重试）＋ 页头统一 `pageHead` ＋ 关键数字提指标卡 ＋ 表格化（sticky 表头 / 数字右对齐 / 窄屏横向滚动 / 紧凑密度）＋ 表单本地校验前置（不发无谓请求）＋ 提交有可见反馈 ＋ **全部去掉 `location.reload()`**（整页刷新会冲掉用户已填内容 = 生产级事故）＋ 前端**不做可见性过滤**（API 给什么渲染什么）。<br>⇒ 另修两个真 bug：trace 的去极值步骤**只取本队**（原来把别人的队伍也列进来）、破同分键的 `removed.max/min` 是**评委 id**（原文案写成「去掉最高 95」是误导）。 |
| E98 | 🧪 **class 清单核对（新增机器可复算的差集检查）** | 把 11 个视图 + `ui.js` + `nav.js` + `app.js` 里用到的 class 全量抽出来，与设计系统求差集 ⇒ **15 个 class 用了但 CSS 里没有**（`page__titles` / `state--loading` / `panel--brand|success|info|neutral` / `home__*` / 三个 view 根类 …）⇒ 「class 拼错 / 没定义」在页面上只表现为「样式没生效」，**完全看不出来**。⇒ 已全部补进设计系统并复验差集为空。 |
| E99 | 🔧 **审计器改进：C-RW 打印「失配明细」** | C-RW 的判据是**贪心子序列匹配** ⇒ 块里**靠前**的某一行一旦不存在（哪怕只改了一行），匹配器会一路扫到文件末尾 ⇒ 后面所有行**全部失配** ⇒ 保持率从 ~1 掉到 ~0.02。<br>⇒ 实测：`src/server.js` 只改**一行 import** + `src/db/repo/users.js` 只改**一个函数签名** ⇒ 双双被判 C-RW（保持率 **0.043 / 0.176**），而其余 ~505 / ~85 行**原封不动**。**「C-RW 变多」的第一嫌疑永远是「你改了一行」。**<br>⇒ 审计器现在**打印第一处失配行**（沿用「D 类必须打印明细」的纪律）⇒ 判据是「要不要同步计划块」不变，但**诊断信息自足**。 |
| E100 | 🧬 **变异检验** | **21 个变异体 / 20 KILLED / 0 存活 / 1 等价（显式标注）/ 0 失配**。<br>⚠️ **首轮跑出 4 存活 + 2 失配**，逐条处置：① 存活 M9（表格扩展位不清洗）⇒ **判据太弱**（用正则抽 class 属性会截到第一个引号 ⇒ 属性**逃逸**根本看不见）⇒ 改成「**整个标签里只允许一个属性**」；② 存活 M15（导航不转义用户名）⇒ **测试压根没覆盖** ⇒ 补断言；③ 存活 M17（兜底错误码改回 `NOT_FOUND`）⇒ 该错误码已是**契约** ⇒ 补直接断言；④ 存活 M11（守卫按角色拦路）⇒ 实为**等价变异体**（路由表里没有 `roles` ⇒ 那段是死代码）⇒ 改写成真实回归场景（「有人给路由表加回 roles」）并补「路由表**不许**有 roles 字段」的断言；⑤ 失配 M2/M4 ⇒ **锚点不唯一**（同一段文本在文件里出现两次）⇒ 改用更长的锚点。 |
| E101 | 📚 **计划块同步** | 11 个视图 + `app.js` + `styles.css` + `api.demo.js` + `users.js` + `server.js` 的计划块**逐字同步回 owning 阶段**（P0 / P1 / P3 / P4 / P5 / P6）；新建的 `web/ui.js`、`web/nav.js`、`web/views/task-index.js` 与两个新测试文件入 **P7 计划**（`docs/superpowers/plans/2026-10-22-platform-P7-ui-production.md`）。<br>⇒ 漂移审计：**A 169 ｜ B 8 ｜ C-EXT 61 ｜ C-RW 0 ｜ D 0**（C-EXT 是结构性现象，只需台账记一句）。<br>⚠️ 工具 `plan-block-audit.mjs` 的 PLANS 数组新增 P7 条目；`plan-block-sync.mjs` 的 `.bak` 已被 `.gitignore` 的 `*.md.bak` 覆盖。 |
| E102 | ✅ **本轮最终验收（实跑数字，以实跑为准）** | ① 全量 `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1431 例 / 1430 通过 / 0 失败 / 1 跳过**（基线 1389/1388/0/1 ⇒ **+42 例**）。<br>② 三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` ⇒ 退出码 **全 0**。<br>③ 漂移审计 + 自检 ⇒ **A 169 ｜ B 8 ｜ C-EXT 61 ｜ C-RW 0 ｜ D 0**。<br>④ 变异检验 ⇒ **21 变异体 / 20 全杀 / 0 存活 / 1 等价（已标注）/ 0 失配**。<br>⑤ class 清单差集 ⇒ 视图用到的 class **全部有对应规则**（原缺 15 个，已补齐）。<br>⑥ 计划块逐字核验 ⇒ 本阶段触及的 **19 个文件**在 7 份计划里 **全部逐字一致**。 |
| E103 | 🐛 **浏览器实测抓到 5 个真 bug（测试全绿也没抓到）** | P7.1 在**真实浏览器**里点页面，抓到 5 个**全部通过了 P7 全部机器闸**的缺陷：<br>**B1** 未登录时首页「参赛队伍」显示的是**榜单数**、「在榜队伍」是空的 —— `jobs` 数组按登录态**改变长度** ⇒ `const [teamCount, boardCount] = await Promise.all(jobs)` **解构错位**；<br>**B2** 榜单每行渲染成「. 拾光队」+「分」（名次与积分**两个空值**）—— 滚动总榜的行字段是 `points` 且**没有 `rank` 也没有 `total`**（`getRollingLeaderboard` 与演示适配器**形状一致**）⇒ 前端用了不存在的字段；<br>**B3** 榜单错误态的「重试」按钮**点了没反应** —— `errorState` 渲染了按钮但调用方**没绑定 click**（违反 DP-80）；<br>**B4** 首页「报名入口」点了是「页面不存在」 —— 链接写的是 `#/register`，路由表里只有 `/apply`；<br>**B5** 网络层失败把英文 `Failed to fetch` 甩给用户，且**一次失败后整个演示站永久瘫痪** —— `getDemoRuntime()` 把**被 reject 的 promise** 存进模块级变量。<br>⇒ **教训**：机器闸覆盖不到的口径错误，只有真机能抓（E104–E107 记录处置）。 |
| E104 | 🏠 **总览页从 `app.js` 抽成 `web/views/home.js`（新建）** | 12 个视图里原先**只有首页**住在 `app.js`；且首页的「指标形状 / 榜单字段口径 / 入口死链」三条判据**藏在异步闭包里 ⇒ 只能靠人点页面发现**。<br>⇒ 把「数据 → 卡片/行」的映射抽成**纯函数** `homeKpiCards` / `homeBoardHtml` / `homeEntryCards` / `homeEntryCardsHtml`，`app.js` 只留 `route('/', (c) => renderHome(c))` ⇒ 新增 `platform/test/web-home.test.js`（**22 条**）可对**结果本身**断言。 |
| E105 | 🔗 **死链闸（新增机器可复算的检查）** | `#/register` 在路由表里**根本不存在** ⇒ 点了是「页面不存在」，而这**没有任何测试会报**（它不是崩溃，只是一段没人点的 HTML）。⇒ 新增**死链闸**：从 `app.js` 扫出路由表（`route('...')` 调用点），与首页入口卡 + 主导航的每个 href **逐一比对**（含 `:param` 段匹配），不匹配即红；另加「路由表必须含首页与报名页」的自检，防止扫描正则失效导致闸**空转假绿**。 |
| E106 | 🛡 **失败不缓存 + 错误消息友好化** | ① `getDemoRuntime()` 原来把**被 reject 的 promise** 存进模块级 `runtimePromise` ⇒ 一次瞬时网络故障（演示站重新发布时 nginx 短暂拿不到静态文件）就让整个演示站**永久瘫痪**，且「重试」重试的是同一份坏 promise ⇒ **永远救不回来**。⇒ 失败时**清掉缓存**，下一次调用重新加载。<br>② 浏览器网络层失败抛的是英文 `TypeError` ⇒ 新增 `friendlyError()`，放在 **`errorState()` 这个唯一出口**（11 个视图一次受益，不用改 11 个文件）。<br>⚠️ 首次浏览器验证看到的「Failed to fetch」复查为**瞬时故障**：reload 后 **48 个请求全部成功**（含 1 份种子 + 13 份规则）⇒ 不把瞬时故障当 bug 修，但把「失败被缓存 ⇒ 永久瘫痪」这个**放大器**修掉。 |
| E107 | ✅ **P7.1 最终验收（实跑数字，以实跑为准）** | ① 全量 `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1461 例 / 1460 通过 / 0 失败 / 1 跳过**（P7 收尾前 1431/1430/0/1 ⇒ **+30 例**）。<br>② 三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` ⇒ 退出码 **全 0**。<br>③ 漂移审计 + 自检 ⇒ **A 171 ｜ B 8 ｜ C-EXT 61 ｜ C-RW 0 ｜ D 0**（A 由 169 升到 171：新增两个视图文件入计划）。<br>④ 变异检验（P7.1 新判据）⇒ **14 变异体 / 14 全杀 / 0 存活 / 0 失配**；⚠️ 首轮跑出 **1 条存活**（M4「points / total 优先级颠倒」）⇒ **判据太弱**（滚动总榜的行根本没有 `total` ⇒ 两种写法结果一样）⇒ 补「两个字段都在时 points 优先」的断言 + 补「M4b 积分只取 total」（= B2 原始写法）⇒ 再跑全杀。<br>⑤ 计划块逐字核验 ⇒ 本轮触及的 **7 个文件**（P7 计划 5 个 + P0 计划 `web/app.js` + P6 计划 `web/api.demo.js`）**全部逐字一致**。<br>⑥ 浏览器复验 ⇒ 演示站首页 KPI 标签与数值**对得上**、榜单行**有名次与积分**、入口卡**无死链**、错误态**无英文技术错误**。 |
| E108 | 🔍 **P8 侦察结论：后端早就齐了，缺的只是界面** | 评审打分与赛段发榜的后端链路 **P2/P3/P4 已全部实现**（`POST /reviews`、`GET /review-state`、`POST /compute`、`GET /computations/:id`、`GET /audit/computations/:id/diff`），**46 个端点里没有一条缺实现** ⇒ 赛事跑不起来**纯粹是前端没有入口**。<br>⇒ P8 的主体是前端；后端**只补一个读口**（见 E109）。 |
| E109 | 🔌 **新增唯一的后端读口：`GET /api/stages/:stageId/review-board`** | 前端要拼评分表单要三样东西，而它们**分散在三个地方且都没有对外读口**：名册（仓储层，**只有 teamId 没有队名**）/ 维度（规则文件里的权重表）/ 我已给的分（`stage_reviews`，**无任何读端点**）⇒ 前端要么猜口径、要么拼三个请求（还会各自漂移）。<br>⇒ 一个端点一次拿齐：`{ stage, dimensions, judgeDimensions, teams, myScores, progress }`；权限闸门与 `GET /review-state` **完全同口径**（组委会 / `score:read` / 本赛段评委 ⇒ 否则 403）；`myScores` **只返回本人的**；仓储层新增 `listStageTeamRows`（**队名 + 任务包标题**，排序兜底键用 SQLite 隐式 `rowid`）。 |
| E110 | 🧩 **P8 两个新页面（前端主体）** | ① **评审打分页** `#/review/:stageId`（新增 `web/views/review.js`）：名册 + 每队一块评分表单 + 逐维度 **0–100 数字输入** + 本地校验前置 + 提交后**就地反馈**（不整页刷新）。② **赛段计算发榜页** `#/publish/:stageId`（新增 `web/views/publish.js`）：发榜前检查（进度 / 缺评队伍 / 评委池）→ **二次确认**（内联确认块，写明赛段 + 影响面）→ 结果表（名次 / P 席 / E 席 / 总分）+ 告警（硬降级 / 提示两级）+ 留痕与赛段榜链接。<br>⚠️ **评分控件用数字输入而不是 1–5 单选**（DP-95）：后端口径是**百分制**（`assertScoreInRange` 卡 0–100），1–5 会丢分辨率；报名页的 1–5 是**问卷量表**，两者口径不同、不共用控件。仍然**不用 `<select>`**（DP-82）。<br>⇒ 导航新增「**评审席**」分区（**不按角色限定** —— 评委是**赛段级**指派的，前端手里没有这个信息，硬按角色限定会误伤）；组委会分区加「赛段发榜」。 |
| E111 | 🐛 **修两处「演示适配器 ≠ 真实后端」的形状不一致** | P8 对齐端点时查出：① 演示的 `POST /api/stages/:id/reviews` 从 **body 里读 `judgeId`**，而真实后端从**会话**取 ⇒ 前端按真实契约发（body 无 judgeId）时，演示站会把分记到**空评委名下** ⇒「提交成功但进度不涨」；② 演示的 `GET /review-state` 的 `dimensionProgress` 是**按评委分组的数字**，真实后端是**按维度分组的 `{submitted,total}`**，且还有 `total` / `missing` ⇒ 两边的进度条**根本不是一回事**。<br>⇒ 两处都改成与真实后端**逐字段一致**，并进 `demo-api-parity` 闸。<br>⇒ 顺带发现演示的**打分不生效**：引擎只认**评委池内**评委的分（`scoring.js` 的 `votingIds`）⇒ 演示站打分时**自动入池**（对应真实系统「评委须被指派才能打分」）；实测「入池但不打分」对种子 showcase **零影响**、**并列关系保持**。 |
| E112 | 🐛 **修条形图的「125%」歧义（真机巡检发现）** | 登录态逐页巡检时看到「分级分布」四条都显示 **125%** —— 实为 `1`（1 支队伍）与 `25%`（占比）**相邻拼成**的假数字（条形图的值与备注是相邻两段文本，中间只有 4px 视觉间距 ⇒ **文本提取 / 读屏会读成 125%**）。<br>⇒ `barRow` 的备注统一加「·」分隔；备注文案改成自然写法（「占 25%」「共 5」）；并补 class 差集核对 ⇒ 查出 **`.icon` 缺规则**（P6 遗留）⇒ 补齐，**差集归零**。 |
| E113 | ✅ **P8 最终验收（实跑数字，以实跑为准）** | ① 全量 `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1503 例 / 1502 通过 / 0 失败 / 1 跳过**（P7.1 收尾 1461/1460/0/1 ⇒ **+42 例**）。<br>② 三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` ⇒ 退出码 **全 0**。<br>③ 漂移审计 + 自检 ⇒ **A 173 ｜ B 8 ｜ C-EXT 59 ｜ C-RW 0 ｜ D 0**。<br>④ 变异检验（P8 新判据）⇒ **24 变异体 / 23 全杀 / 0 存活 / 0 失配 / 1 等价（已显式标注）**；⚠️ 首轮跑出 **2 条存活**：M17「进度不带口径」⇒ **真缺口**（后端没钉住 `progress.scope`）⇒ 补后端断言（评委 = `mine`、组委会 = `stage`）；M21「演示打分回到 body 取 judgeId」⇒ 实为**等价变异体**（我写的变异体带了兜底 ⇒ 行为与原实现相同）⇒ 改写成**真回归**（去掉兜底 ⇒ 被杀）并把带兜底的版本**显式标注为等价**。<br>⑤ class 清单差集 ⇒ **0 缺失**。<br>⑥ 计划块逐字核验 ⇒ 本阶段触及的 **16 个文件**在 7 份计划里**全部逐字一致**（P8 计划 4 个新建 + P0/P1/P2/P3/P6/P7 的 12 个改动文件）。 |
| E114 | 🏠 **P9：首页从「仪表盘」改成「落地页」** | 用户要求：「要有落地页，也就是首页，首页用来介绍赛事和赛制，吸引报名」。<br>⇒ **`/` = 落地页（公开）**；原「赛事总览」仪表盘**一行没删**，迁到 **`/dashboard`**（登录后可达，导航「我的赛事」分区加「工作台」条目）。<br>⚠️ **不是替换而是并存**：仪表盘对已登录的人有用，落地页对访客有用，两者定位不同 ⇒ 硬把仪表盘删掉会伤到已登录用户。 |
| E115 | 📐 **设计契约（ui-design skill）** | 三轴**刻意**选：`macrostructure = split-hero`（**不用**默认的 hero-led —— 赛程脊直接进首屏，首屏本身就是赛制说明）、`style = midnight`（暗色优先 / 1px 边框分隔 / 强调色只留给焦点环与主 CTA）、`pairing = plex-family`。<br>⚠️ **零依赖 ⇒ 不引网络字体**：字体栈写 `"IBM Plex Sans/Mono", <系统栈>`，本机未装 Plex ⇒ **截图即真实**，不假装（skill：never claim a visual improvement you have not looked at）。<br>⇒ 契约落在 `docs/superpowers/plans/2026-10-22-platform-P9-ui-redesign.md` §1，含 **M1–M10** 十条可复算阈值。 |
| E116 | 🎨 **签名元素：「规则即图形」** | 本赛事每条规则用**同一个几何语法**呈现，从不用段落散文：**条**=评审权重 / **脊**=五段赛程 / **阶**=段位 D→S / **流**=筛选漏斗。一个语法、四种载体 ⇒ 这页是「黑客松的赛制页」而不是通用 SaaS 首页。<br>⇒ 落地页因此**没有一张配图**，全部用数据形状说话（也顺带避开了「AI 落地页 = 渐变插画」的俗套）。 |
| E117 | 🔌 **新增唯一的后端读口：`GET /api/event-info`（公开、免 token）** | 落地页要「介绍赛事与赛制」⇒ 前端需要赛段起止与交付物、评审维度权重、段位表、漏斗、组队规则、名次积分、破同分链、合规红线 —— 这些**全部**只在 `platform/rules/*.json` 里（赛制的唯一出处），而 rules 是**服务端**配置、浏览器读不到。<br>⇒ 新建 **`src/domain/event-info.js`（纯函数 · 白名单投影）**，服务端 `GET /api/event-info` 与**演示适配器 import 同一个函数** ⇒ 正式站与演示站的落地页内容**不可能漂移**（P8 的教训：演示适配器曾把「错误的形状」锁进测试）。<br>⛔ **白名单**：rules 里大量字段是**内部工作备注**（「此为待组委会确认口径」「首届后回测」「R-STG-05：任务书 §六…」）⇒ **一律不进公开响应**；「这个赛段不做硬性要求」由布尔位 `hardRequirement` 表达。<br>⚠️ **与 `/api/public/*` 的区别**：那两条吐的是**比赛数据**（榜单行、赛程实例）⇒ 要 token；这一条吐的是**规则本身**（参赛者有权知道自己被怎么评）⇒ 匿名可读。 |
| E118 | 🐛 **演示站规则集缺 `schedule.json`（真缺口）** | 演示适配器的 `DEMO_RULE_FILES` 只加载 13 份规则，**不含 `schedule.json`** ⇒ 演示站落地页的**赛程脊一个节点都没有**（正式平台读服务端 `loadRules`，那份加载全部 17 份 ⇒ 两边不一致）。<br>⇒ 补进 `DEMO_RULE_FILES` + `loadDemoRules()` 的返回形状 ⇒ 两边一致。 |
| E119 | 🐛 **错误路径在最小 DOM 桩上抛 TypeError ⇒ 变成 unhandledRejection ⇒ 把别的用例搞挂** | 落地页的 catch 分支里写 `spineBox.querySelector('[data-action="retry"]')` ⇒ 在**没有 querySelector 的桩上**抛 TypeError ⇒ 新异常没人接 ⇒ **unhandledRejection** ⇒ 归到**正在跑的另一个用例**头上（真事故：`demo-static` 的「演示版横幅」用例被它带崩，症状与落地页毫无关系，极难定位）。<br>⇒ 全链路可选链：`spineBox.querySelector?.(...)?.addEventListener?.(...)`。 |
| E120 | 🧪 **变异检验：首轮 3 条存活 ⇒ 判据太弱（已修）** | P9 新判据 **18 个变异体**，首轮 **14 杀 / 3 存活 / 1 失配**。存活的三条**全是同一个病根**：「断言文件里有某个字符串」而不是「断言**那处构造**正确」——<br>· M7「节点不带 data-stage-key」：文件里 `data-stage-key` 在**接线代码**里也出现 ⇒ 断言被顶替；<br>· M8「联动高亮断掉」：`is-active` 字样仍在，条件被改成恒 false；<br>· M10「重试按钮不绑 click」：`addEventListener?.('click'` 在**赛程点选**处也有一处。<br>⇒ 三条断言全部**钉到具体构造**（节点模板的属性、toggle 的比较条件、重试按钮自己那一次绑定）⇒ 复跑 **18/18 全杀 / 0 存活 / 0 失配**。<br>⇒ M15 失配是**变异脚本的锚点不唯一**（`weight: num(d?.weight)` 出现两次）⇒ 加上下文改唯一 ⇒ 与「测试没判别力」无关。 |
| E121 | 🧪 **temp-leak 闸抓到新测试漏了临时目录隔离** | `scripts/temp-leak-scan.js` 的 R1 闸：`test/event-info-api.test.js` 用了临时目录却**没 import** `test-helpers/tmp.js` ⇒ 临时 SQLite 库会留在系统临时目录里（Linux 上跑一次全量就堆一批）。<br>⇒ 补 `isolateTempDir()`；R2 闸又指出「隔离器必须早于第一处临时目录调用」⇒ 一并满足。 |
| E122 | 🎯 **视觉验证（真浏览器，六视口）** | Playwright 六视口（360 / 390 / 768 / 1024 / 1440 / 1920）截图并**逐张读图**：<br>· **无横向滚动**（六档全部 `scrollWidth == clientWidth`）；**无文字裁切**（0 处 `scrollWidth > clientWidth`）；<br>· **数字卡等宽**（实测 140/140/140/140 px）；**权重条与漏斗条比例实测正确**（轨道 131px ⇒ 10%/20%/20%/25%/10%/15% ⇒ 13/26/26/32/13/19 px）；<br>· **对比度实测**（暗色）：正文 7.55–16.39、弱文 4.92、主 CTA 7.46、导航 10.7 ⇒ **全部 ≥ 4.5:1**；<br>· 读图后改掉的真问题：**① 中文标题被拆成「方 / 案」**（默认可在任意两字间断行 ⇒ 加 `word-break: keep-all` + 窄屏降档 26px）；**② 4 个 tile 排成「3+1」的残行** ⇒ 改用显式两列栅格并补两块真内容（晋级口径 / 分级门槛）；**③ 强调色过载**（破同分链 6 个序号 + 顶栏实心登录按钮都是强调色）⇒ 序号转弱化色、顶栏登录改描边 ⇒ 每屏强调色元素收到 **≤ 3**。 |
| E123 | 🧭 **P9 的两条设计原则（DP-100 / DP-101）** | **DP-100 · 赛制只从配置来**：落地页**一个字都不许硬编码**赛制数字 ⇒ 新增机器闸扫源码里的 `'10-01'` / `0.25` / `'0.10'` 等**规则里出现过的字面量**，命中即红（改 rules/*.json 即改落地页，不必改前端）。<br>**DP-101 · 降级路径也必须可点**：错误态里的「重试」要**真的绑在那一个按钮上**，且降级代码在**任何 DOM 环境**下都不能抛（最小测试桩没有 `querySelector`）⇒ 抛出的新异常会变成 unhandledRejection 并**归到别的用例头上**（E119）。 |
| E124 | ✅ **P9 最终验收（实跑数字，以实跑为准）** | ① 全量 `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1552 例 / 1551 通过 / 0 失败 / 1 跳过**（P8 收尾 1503/1502/0/1 ⇒ **+49 例**）。<br>② 三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` ⇒ 退出码 **全 0**。<br>③ 漂移审计 + 自检 ⇒ **A 177 ｜ B 8 ｜ C-EXT 59 ｜ C-RW 0 ｜ D 0**（`plan-block-audit.mjs` 的 PLANS 数组新增 P9 条目）。<br>④ 变异检验（P9 新判据）⇒ **18 变异体 / 18 全杀 / 0 存活 / 0 失配 / 0 等价**（首轮 3 存活 + 1 失配 ⇒ 已修，见 E120）。<br>⑤ 计划块逐字核验 ⇒ 本阶段触及的文件在 8 份计划里**全部逐字一致**（P9 计划 4 个新建 + 其余改动文件同步回各自 owning 阶段）。 |
| E125 | 🔍 **P8 的两个详情页在正式库上根本点不到 ⇒ 复验必须另起隔离实例** | 正式库 `stages` 表**一行都没有** ⇒ `#/review` 与 `#/publish` 的列表页只显示「还没有赛段」，**详情页从未被任何人点过**（机器闸全绿也没发现）。<br>⇒ 复验办法：真机上用 `DATA_DIR=/tmp/hks-verify` 起**第二个实例**（同一份代码、同一个 Node，`PORT=8099`），种子 + 补赛段/队伍/评委席 ⇒ 再用 `ssh -L 8099:127.0.0.1:8099` 转发到本地浏览器。<br>⚠️ 应用只绑 `127.0.0.1`，**不转发就连不上**；隔离实例**全程不碰生产库**（生产库至今 0 赛段 0 队伍）。 |
| E126 | 🐛 **进度三个数不自洽 ⇒ 同一屏出现两句打架的话** | 评委视角同一屏：「0 我的已交 / 应交 20 格 / 完成度 0%」**和**「本赛段的评分都交了」。<br>根因：`getReviewState` 给**没有本赛段席位**的账号算出 `total = 队伍数 × 维度数`，却把 `missing` 留空（missing 只在 `else if (seat)` 分支里填）⇒ `{submitted:0, total:20, missing:[]}` 自相矛盾；前端再把「missing 为空」当「都交了」⇒ 矛盾被放大成一句**假话**。<br>⇒ 后端：**没有席位 ⇒ total = 0**（DP-102）；前端：状态行**只能由数字推出**（DP-103）。 |
| E127 | 🐛 **发榜前检查误报「名册里的队伍都有打分」** | 赛段**一个评委都没派**时 `total = 0 / submitted = 0 / missing = []` ⇒ 旧判据（missing 为空 ⇒ 都打了分）报「名册里的队伍都有打分 / 可以执行计算发榜」，而**真发榜后引擎对每队每维度产出 `dimension_no_scores` 告警（实测 30 条）**。<br>⇒ 三个分支各自由数字决定：`total === 0` ⇒ 直说「一格都还没打」；有缺格 ⇒ 催评；只有 `submitted >= total > 0` 才说「都有打分」。 |
| E128 | 🐛 **UI 组件参数名写错 = 静默丢内容（机器闸全绿也抓不到）** | `noticeState` 的签名是 `{tone, title, items, list}`，P8 两页传的是 **`text`** ⇒ **所有提示条的说明文字从来没渲染过**（页面上只剩标题）。不报错、不崩、测试全绿。<br>⇒ 全部改成 `items: [...]`；并加**机器闸**：任何视图不得给 `noticeState` 传 `text`（闸自身带**阳性对照** —— 注入坏用法必须被抓到，见 DP-104）。 |
| E129 | 🐛 **演示适配器与真实后端「形状对、数值漂移」** | ① 演示站的「应交 N 格 / 完成度 %」**漏乘评委数**（种子有 6 名评委 ⇒ 演示站的数只有正式站的 1/6）；② 席型词表写的是 `expert`，而真实词表是 `judge / enterprise / observer` ⇒ 真实引擎的 `checkJudgePool` 认不出来，演示站**每次计算都多一条 `judge_pool_invalid` 告警**（正式站不会有）。<br>⛔ P8 的 parity 闸只比**形状**、不比数值 ⇒ 这两条它一条都抓不到（这正是 P8 复盘写下的「演示适配器把错误形状锁进测试」的**数值版**）。<br>⇒ 演示适配器与真实后端**同口径**（乘席位因子、过滤 observer、席型词表对齐）；并补一条**同数据 ⇒ 数值逐项相等**的闸。 |
| E130 | ✅ **P9.1 修复轮最终验收（实跑数字，以实跑为准）** | ① 全量 `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **1568 例 / 1567 通过 / 0 失败 / 1 跳过**（P9 收尾 1552/1551/0/1 ⇒ **+16 例**）。<br>② 三个机器闸 `audit-scan` / `temp-leak-scan` / `bash-var-scan` ⇒ 退出码 **全 0**。<br>③ 漂移审计 + 自检 ⇒ **A 178 ｜ B 8 ｜ C-EXT 59 ｜ C-RW 0 ｜ D 0**（A +1 = 新测试文件进了 P9 计划块）。<br>④ 变异检验（P9.1 新判据）⇒ **14 变异体 / 14 全杀 / 0 存活 / 0 失配**（含「机器闸判据改坏」「观察员被算进席位」「演示漏乘评委数」三类）。<br>⑤ 计划块逐字核验 ⇒ `src/services/review.js`（P2）/ `web/api.demo.js` + `web/seed/demo-data.json`（P6）/ `web/views/review.js` + `web/views/publish.js`（P8）**同步回各自 owning 阶段**，新测试文件进 P9 计划 ⇒ 全部逐字一致。 |
| E131 | 🎨 **落地页的「暗色优先」只对少数人生效（真机截图即证据）** | P9 写了 `@media (prefers-color-scheme: light)` 自动切亮色 ⇒ **系统是亮色偏好的访客第一眼看到的是亮色**（头less Chromium 默认浅色，截图直接复现）。<br>⇒ P10：删掉自动切亮色，**暗色是默认**（契约 M7，`web-landing.test.js` 有机器闸）；底色由 `#0b0d12` 加深到 `#08090d`，工程网格从 48px/对比 .32 降到 64px/对比 .055 并用**径向遮罩**只在一角显影，卡片加「顶边 inset 高光 + 顶面渐变」的材质（**零外阴影**不变）。 |
| E132 | 📐 **两张权重表并排放着，看不出「权重怎么随赛段变」** | 用户点名的第一条「不够专业」：落地页原来把初赛表与决赛表做成**两张独立表**。<br>⇒ P10 改成**双轨对照**：同一维度**上下两轨共用一条轴**，中间标 Δ（百分点）；悬停一行 ⇒ **两端同时**亮（契约 M10）。<br>✅ 上线后**双轨自己讲出了真事实**：`track_fit`（赛题契合度）**只在初赛**评、`self_eval`（自评测）**只在决赛**评、`enterprise`（企业确认）**10% → 25%（+15pp）** —— 这三条在旧版两张表里**一个都看不出来**。 |
| E133 | 🕳️ **31 个「只有接口没有界面」的功能点** | 端点覆盖盘点（只读 agent）：后端 61 个端点只有 29 个接了界面；真实后端 0 条死链，演示适配器 1 条死链；`/card/:teamId` 全站无入链（孤岛）；`POST /api/teams/:id/members` 后端支持 add/leave/replace 而前端只发 leave；4 处「文案已承诺但无触发器」。<br>⇒ 用户拍板**四组全补**：任务卡分级审批 / 企业双签 + 里程碑签字（含撤回）/ 申诉提交 + 裁决 / 评委前置（回避 + 互评自评校准）。P10 全部落地并接线（`/admin/task-packages`、`/signoff`、`/admin/appeals`、`/review/prep`）。 |
| E134 | 🚫 **选手点「提交申诉」必然 409（前端做完了，后端接不住）** | W4-c 的前端按端点形状提交 `{subjectType:'registration', subjectId:<报名 id>, reason}`，但 `fileAppeal` **无条件**按赛段结果校验：拆 `stageId:teamId`、要求 `stage_result` 已 `FINALIZED`、要求队伍档位在 `appealAllowedTiers`（= `["D"]`）⇒ 选手永远拿不到 409 以外的结果。<br>⇒ **DP-106**：报名类申诉与赛段结果类申诉**进同一条队列**但**校验口径不同**（报名类：存在 404 → 本人/组委会 403 → 无终态裁定 409 → 无重复申诉 409）；裁决成立 ⇒ 撤销分级裁定、回到待复核、**不触发赛段重算**；`listAppeals` 仍只对 `audit:read` 可见（放宽 = 回归）。<br>⇒ 另：`member` 角色原先没有 `appeal:write` ⇒ 组员也是选手却 403，seed 补上。 |
| E135 | 🔊 **公开榜单把内部工作语言摊给了每一个访客** | 真机截图：滚动总榜顶部「本轮降级提示（7）」里直接出现 `[normalization_fallback]`、`j1:partial:judge_sample_too_small`、`t_epsilon`、`15.200000000000003 分` —— 内部规则键、评委 id、队伍 id、浮点噪声。<br>⇒ **DP-107**：告警统一成 `{ code, message, detail? }` —— `message` **只给人读**（中文维度名、分数四舍五入），`detail` 是内部明细并**由 API 层按可见性裁剪**（只有 `audit:read` 的人拿得到）。<br>⛔ 「降级必须显式展示，不静默」（S-5 / C-05）是硬契约 ⇒ **一条告警都不许少**，只改分层。 |
| E136 | 🧊 **生产站画不出六维评估表（`/rules/` 在生产根本不挂）** | 任务卡审批页的六维规格原本只能读站点里的 `rules/solvability.json`，而部署脚本**只有 `DEMO_MODE=1` 才挂 `/rules/`** ⇒ 生产环境冷启动（一张卡都没评估过）拿不到维度清单 ⇒ 页面画不出表。<br>⇒ **DP-108**：`buildEventInfo`（`src/domain/event-info.js`）增加 `solvability` 投影（逐字段白名单：维度 / 档位 / 否决项；**不投影**判定条件与内部备注）⇒ **演示站与正式站同源**（演示适配器 import 的是同一个函数）⇒ 形状与数值天然对齐；静态规则文件只作兜底。 |
| E137 | 🧷 **工作台副标题把 HTML 当字面文本渲染** | `pageHead` 的 `sub` 会**转义**（防 XSS，正确），但 `web/views/home.js` 往里塞了 `<a href="#/">首页</a>` ⇒ 页面上直接显示出一串 `<a href="#/">首页</a>` 的字面文本（真机截图证据）。<br>⇒ 链接改走 `pageHead` 的 `actions`（那里本来就是渲染 `<a>` 的地方），`sub` 只放纯文本。**不改 `pageHead` 的转义**（那个转义是对的）。 |
| E138 | 🔓 **校准打分没有维度白名单（与普通打分口径不一致）** | `POST /api/stages/:stageId/reviews` 有 `assertJudgeDimensions`（只允许 `seat==='judge'` 的维度），`POST /api/stages/:stageId/calibration` **没有** ⇒ 任何有 `score:write` 的人可以给任意维度键（包括「自评测」「企业确认」）写校准分。校准分不进总分，但**口径不一致**会让审计说不清、也会污染 `calibrations` 表。<br>⇒ 校准端点改用**同一个** `assertJudgeDimensions`（不是复制一份）⇒ 未知维度 400 `UNKNOWN_DIMENSION`、非评委席维度 403 `DIMENSION_SEAT_FORBIDDEN`，与打分端点**逐字一致**（有测试断言两个入口的状态码与错误码都相同）。 |
| E139 | 🔀 **演示站 `GET /api/teams` 返回全部队伍（与正式站口径分叉）** | 正式站只返回「我参与的」队伍（`listMyTeams`），演示站返回**全部** ⇒ 互评页的「被评队」列表口径与正式站不同（发起队 = 全部 ⇒ 被评队 = 空）。<br>⇒ 演示适配器改为 `demoMyTeams`（队长 / 在册组员 / `me.teamId`）⇒ 与正式站同口径；演示站的 P10 五件套（回避 / 互评 / 自评 / 校准 / 回避清单）端点也一并补齐，错误码与正式站逐字一致。 |
| E140 | 🎭 **「漏斗进入视口依次伸展」是句空话（观察器加了类，没有 CSS 认）** | `wireLanding` 给 `.funnel__bar` 加 `is-revealed`，但**没有任何 CSS 规则认这个组合** ⇒ 漏斗从来不动；代码注释却写着「⑥ 漏斗进入视口依次伸展」。<br>⇒ P10 补上关键帧动画（按 `--i` 逐段延迟）。<br>⛔ 第一版用「加 `.reveal` 就把宽度收到 0」，结果**未进视口的漏斗整块是空的**（静态截图里是空的）⇒ 内容不可见是不可接受的降级 ⇒ 改用 `animation-fill-mode: both`，**播放前仍是满宽**（没进视口 / 没 JS / 观察器没触发，三种情况都是正确的）。 |
| E141 | 🧷 **企业确认落库后修不了（缺双签 ⇒ 恒 0 分且无写路径）** | `enterprise_confirmations` 的唯一索引是 `(stage_id, team_id, dimension, enterprise_id) WHERE deleted_at IS NULL`，而仓储层的 `softDeleteEnterpriseConfirmation` **无任何调用方** ⇒ 一条**缺跨领域评委签字**的确认一旦落库，按 R2 计 0 分且**产品内修不了**。<br>⇒ 界面层如实显示「缺跨领域评委这一签（R2：该项按 0 分计）」，并在提交前**强制一次带齐双签**（从源头避免产生半条确认）；**写端点未新增**（超出本轮边界，如实记录为遗留）。 |
| E142 | 🧭 **P10 的四条用户拍板决定与三条新增决策** | **决定 1 视觉**：暗色为主 + 弱化网格 + 加深度材质（E131）。<br>**决定 2 范围**：落地页 + **全部内页**统一设计系统。<br>**决定 3 功能缺口**：四组全补（E133）。<br>**决定 4 权限**：前端**按能力点**拦分区级页面（**不是**按角色硬编码；DP-77 已修订）—— ⛔ 只声明「API 同样要求全局能力点」的页面，赛段级页面一律不拦（前端无从判断，拦了就是误伤）。<br>**DP-106** 申诉两件事同队列（E134）｜**DP-107** 告警分层（E135）｜**DP-108** 赛制规格走服务端投影（E136）。 |
| E143 | ✅ **P10 总验收：设计系统 2.0 + 落地页 + 四组功能缺口 + 能力点拦路** | **① 视觉**：token 层 2.0（暗色默认 / 弱化网格 / 深度材质）+ 落地页重做（权重双轨 / 真阶梯 / 真漏斗 / 分节交替底色）。<br>**② 四组功能缺口全补**：任务卡分级审批（+ 服务端六维规格投影 + 退回理由必填）｜企业双签 + 里程碑签字（含撤回）｜申诉提交 + 裁决（含报名类申诉）｜评委前置四件套（回避 / 互评 / 自评 / 校准）。<br>**③ 权限**：`/api/me` 带能力点 → 前端按**能力点**拦分区级页面（DP-77 修订为「不按角色硬编码」）。<br>**④ 实跑**：六视口（360/390/768/1024/1440/1920）无横向滚动、无 console 错误、暗色默认、阶梯高度严格递增、漏斗各段可见；内页逐页读图四个新页面全部渲染成功。<br>**⑤ 验收**：全量 `node --test` = **1773 例 / 1772 通过 / 0 失败 / 1 跳过**；三机器闸（audit-scan / temp-leak-scan / bash-var-scan）退出码全 0；漂移审计 **A 179 ｜ B 8 ｜ C-EXT 58 ｜ C-RW 0 ｜ D 0**。<br>⚠️ 本轮总验收期间又抓出 **4 个真问题**（E144 告警泄漏 / E145 演示站死页 / E146 计数不刷新 / 演示站通用端点 URL 形状不对），已全部修掉并补了回归闸。 |
| E144 | 🔓 **演示站把告警的内部明细泄给了匿名访客（正式站是对的，两处各写一份 ⇒ 漂）** | DP-107 的裁剪原本只在 `src/services/leaderboard.js` 的 `visibleWarnings` 里；演示适配器 `web/api.demo.js` **没有这一步** ⇒ 公网演示站（`?demo=1`）的**未登录访客**在榜单页能看到 `detail` 里的内部明细（评委 id + 内部原因码 `j1:partial:judge_sample_too_small`、队伍 id、英文维度键、破同分键名）。<br>⇒ 裁剪口径**下沉到领域层唯一入口** `src/domain/visibility.js`（新增 `applyWarningVisibility`，由 `applyVisibility` 内部调用，`context.canAudit` 决定是否给 `detail`）—— 正式站与演示站**复用同一份**，结构上不可能再漂。<br>⇒ 演示站用 `demoCanAudit(viewer)` 判权限（真实矩阵里 `audit:read` **只有 admin** 持有；演示站只有 admin 一个身份 ⇒ 同口径；fail-closed）。<br>✅ 实测：匿名访客页面上 7 条内部记号从 **7 个**降到 **0 个**（`code` 机器判据按 DP-107 故意保留）。<br>⇒ 新增 3 条测试（领域层契约 ×2 + 演示站同口径 ×1），并做**变异检验**：领域层不裁剪 ⇒ 4 条测试红；演示站恒有审计权 ⇒ 1 条测试红（变异全部存活 = 测试无判别力，必须修）。 |
| E145 | ☠️ **演示站上三个页面是「只做展示、点不动」（用户诉求直接命中）** | 用户问「是否存在只做了功能上的展示，直接没办法点击触发的接口」⇒ 真查出来 **7 个端点缺失**：<br>① **企业签字台**：读口 `GET /api/signoffs/mine`、`GET /api/stages/:stageId/enterprise-confirmations` 与写口 `POST /api/milestones/:id/signoff`、`POST /api/milestones/:id/signoff/withdraw`、`POST /api/stages/:stageId/enterprise-confirmations` **一个都没实现** ⇒ 公网演示站那页是**两块错误卡片**。<br>② **任务卡审批**：写口 `POST /api/task-packages/:id/solvability`、`POST /api/task-packages/:id/approve` 没实现；且适配器里那个**不带 id** 的通用口 `POST /api/task-packages/solvability` **没有任何调用方**（前端调的是带 id 的那个）⇒ 「提交评估 / 签级」两个按钮点了就 404。<br>③ **种子状态**：三张演示任务卡都没有 `status` ⇒ 视图的 `canAssess` / `canSign` 全为 false ⇒ 即使端点补上了，控件仍是**锁着的**。<br>⇒ 补齐 7 个端点（与正式站**同码同判**：MISSING_DEPARTMENT / MISSING_CONTENT / ALREADY_REVOKED / INVALID_SOLVABILITY_ANSWERS / INVALID_VETO_KEY / INVALID_GRADE / RETURN_REASON_REQUIRED / SOLVABILITY_NOT_ASSESSED / SCORE_OUT_OF_RANGE / JUDGE_NOT_ASSIGNED / TEAM_NOT_FOUND），种子补两张可流转的卡（`tp_demo_assess` 已提交 / `tp_demo_sign` 已评估），删掉那个无调用方的通用口；配比体检口径对齐正式站（只算**已发布**的卡）。<br>⇒ **端点覆盖闸扩容**：`test/demo-api-parity.test.js` 的 `VIEW_ENDPOINTS` 补进 P10 全部端点 ⇒ 以后新增页面漏端点会被立刻抓住（**这条闸当场就抓出了②那两个**）。<br>⇒ 新增 `platform/test/demo-admin-write-flows.test.js`（9 例）把两条链真的走一遍。 |
| E146 | 📉 **提交成功后顶部计数不刷新（页面在骗人）** | 「任务卡审批」页提交六维评估 / 签级后只换**那一张卡**，顶部「待评估 / 待签级 / 已发布」三个计数还停在提交前 ⇒ 页面写着「1 待评估」，而那张卡已经评完了。浏览器实跑复现（评估后卡片已是「已评估」，计数仍是 1）。<br>⇒ 提交成功后**重拉一次列表**（配比体检的对象是已发布的卡 ⇒ 本地数组算不出来），只刷新顶部统计与体检面板，**不重画卡片列表**（重画会把别的卡已填的评分冲掉）。浏览器实测：评估后「待评估 1→0、待签级 0→2」，签级后「待签级 2→1、已发布 3→4」。 |
| E147 | ✅ **P10 真机复验（隔离实例 + 公网演示站）** | **部署**：`403ce3b` 推到真机 ⇒ `systemctl restart heikesong` ⇒ 平台 `https://8.133.200.235:8444/` 200、`/api/health` 200；演示站 `https://8.133.200.235:8445/` 200（`?demo=1` 200）。<br>**隔离实例**（`DATA_DIR=/tmp/hks-p10b` + `ssh -L 8099` 隧道，复验后已停、临时库已清；生产库仍 0 赛段 0 队伍）：<br>① **四类账号的 `/api/me`**：管理员 12 个能力点 ｜ 企业代表 6 ｜ 队长 10 ｜ 组员 8；角色回 `["admin"]` / `["enterprise"]` / `["captain"]` / `["member"]`。<br>② **API 层按角色过滤**：`GET /api/task-packages` 管理员 11 张 vs 队长 / 组员 **10 张**（D 级退回卡对无 `task_package:approve` 的人不可见）；`GET /api/signoffs/mine` 管理员 `scope=committee`、企业代表 `scope=enterprise` 且只看自己出题的队（7 条 vs 0 条）、队长 / 组员 **403**。<br>③ **前端按能力点拦路**（真机浏览器实跑）：队长与组员访问 `/admin/task-packages`、`/admin/appeals`、`/flags`、`/publish` **四页全部被拦**，显示「「任务卡审批」需要「task_package:approve」能力点，当前账号没有这个权限…请联系组委会开通」；导航分区也随之收敛（管理员 5 个分区 / 企业代表 4 个 / 队长 3 个）。<br>④ `/signoff` 对队长**不拦**（企业席按**角色**分区、签字能力点可能是届期级授权 ⇒ 按能力点过滤会误伤，DP-105 同一条原则）⇒ 由 API 裁决，页面显示「缺少能力：signoff:create」+ 重试按钮。<br>**公网演示站**（`https://8.133.200.235:8445/?demo=1`，浏览器实跑）：登录 ✓；落地页暗色、无横向滚动、console 0 错；**任务卡审批**六维评估 → 签级 → 待签级 2→1、已发布 3→4 ✓；**企业签字台**签字 → 待签 33→32 ✓；console 错误 **0**。<br>⇒ 三个机器闸（audit-scan / temp-leak-scan / bash-var-scan）exit 全 0；漂移审计 A 179 ｜ B 8 ｜ C-EXT 58 ｜ **C-RW 0** ｜ D 0；计划块逐字核验全部一致。 |
| E148 | 📉 **E141 的影响面实测（用户追问「这个问题影响什么」）** | **复现**（真实服务端 + 隔离库，`platform/src/domain/enterprise-seat.js` 真引擎）：<br>① **写端点不强制 `crossJudgeId`** ⇒ `POST /api/stages/:id/enterprise-confirmations` 不带跨领域评委**照样 200**，落库行 `cross_judge_id = NULL` ⇒ **界面强制 ≠ 接口强制**（界面是 P10 新做的，接口是 P2 的旧契约）。<br>② **同格重签撞唯一索引** ⇒ 第二次带 `crossJudgeId` 的提交报 `UNIQUE constraint failed: enterprise_confirmations.stage_id, team_id, dimension, enterprise_id`，**HTTP 500「服务内部错误」**（不是 409/400 ⇒ 违反三态状态码口径；且「提交企业确认」按钮提交期间不禁用 ⇒ 双击/代录撞车时用户看到的就是这句）。<br>③ **分数影响（量化）**：`total = (1−w_E)×P + w_E×E`（S7 §3.1）。半条确认 ⇒ `E=0`、告警 `R2_missing_dual_signature`：**初赛 w_E=10% ⇒ 总分 72（正常 80，−8 分）｜决赛 w_E=25% ⇒ 总分 60（正常 80，−20 分）**。双签齐全 ⇒ `E=80`、无告警、总分 80。<br>④ **连锁**：总分直接进榜单排序 ⇒ 名次掉 ⇒ 名次积分只有前 3 名有（10/8/5）⇒ 掉出前 3 奖金直接归零；MVP / 破同分链用总分 ⇒ 连带；**段位不受影响**（段位 = 里程碑 + 签字，与企业确认分无关）。<br>⑤ **公开负面信息**：`R2_missing_dual_signature` 告警会**永久置顶**在公开榜单上（「该队企业确认缺双签」）—— 对该队是公开的。<br>⑥ **唯一出路是裸 SQL**（`UPDATE … SET deleted_at = …`）⇒ 绕过产品 ⇒ **改分不留审计日志**（最实质的损害）。<br>**修复建议**：① 把 R2 从「计算期判定」前移到「写入期校验」（缺 `crossJudgeId` 直接 400 `CROSS_JUDGE_REQUIRED`）⇒ 半条不再产生，E141 自然消失；② 同格重签的 500 改 409 `CONFIRMATION_EXISTS`（纯 bug，改动极小）；③ 若要保留「组委会代录」例外，给 committee 一个显式的「记为缺签」参数，而不是默认允许。 |
| E149 | ☠️ **正式站的「发榜」只做了计算，没做发榜（比 E141 严重一个数量级）** | 追 E141 的根因时撞出来的**新问题**（此前台账无记录）：<br>· 「赛段发榜」页只调 `POST /api/stages/:stageId/compute` ⇒ `computeStage` 只写 **`stage_results` + `computation_snapshots`** 两张表。<br>· 而**名次积分入台账、段位重算、榜单快照写入、发榜审计日志**这四件事全在 `publishLeaderboard` 里 —— 而 `publishLeaderboard` **全仓无生产调用方**（`src/` 内只有定义；生产路由表里没有任何 publish 端点；调用它的只有 `test/leaderboard-service.test.js` 的**服务层直调**）。<br>· 连带：`computeTeamTier`（`tier_records` 的唯一写者）也只有 `publishLeaderboard` 调 ⇒ 段位记录**从不被写**。<br>**实测（真实服务端 + 隔离库，模拟发榜页的真实动作）**：<br>`POST /api/stages/:id/compute` → 200，then：`stage_results` = 1 ✓、`computation_snapshots` = 1 ✓、**`points_ledger` = 0 ✗**、**`tier_records` = 0 ✗**、**`leaderboard_snapshots` = 0 ✗**、`audit_log('leaderboard.publish')` = **0 ✗**。<br>**读端表现**：`GET /api/leaderboard/tier` → `rows: []`（段位榜是空的）；`GET /api/leaderboard/:id?scope=personal` → `rows: []`（个人榜是空的）；滚动总榜正常（它从 `stage_results` 现算 points，不读台账）⇒ **只有滚动总榜是对的**。<br>手工补调一次 `publishLeaderboard` ⇒ `points_ledger` 1 行、`tier_records` 1 行、`leaderboard_snapshots` 3 行、个人榜立刻出现「队长 10 分 / 第 1 名」。<br>**业务影响**：① **段位永远兜底 D 段** ⇒ `getTeamTier` 对非成员直接 404「战队不存在」⇒ **段位权益（资源解锁）永远不解锁**（R-PTS）；② **名次积分与 MVP 永不入台账** ⇒ 个人榜空、MVP 无候选、人才池积分聚合（`pool-derive` 读 `points_ledger`）为空；③ **发榜无审计留痕**。<br>**病根与本项目旧账同款**：「机制写下来了、服务层测试也绿了，但**没接到产品路径**」——与 P1 Task 3 的 A1（`registration:write` 注册了却从不校验）同一类。⇒ **闸只测服务层函数、不测产品路径**，所以这类缺陷能一路绿灯到今天。<br>⇒ 修法：`computeStage` 之后**链上** `publishLeaderboard`（或新增一个 `POST /api/stages/:id/publish` 端点并让发榜页调它），并补一条**经 HTTP 路由**的回归测试（断言 compute/publish 后四张表都有数、段位榜与个人榜非空）。 |

| E150 | ☠️ **全新部署的平台一条赛段都没有 ⇒ 评审/榜单/段位/发榜整条链在真机上是死的（比 E149 更靠上游）** | W4 的机器闸（`docs/tools/dead-service-scan.mjs`，P11 新建）首跑报出 47 个死函数，其中三条同属一族：<br>`insertStage`（`src/db/repo/stages.js`）、`assignStageJudge`（同文件）、`registerStageTeams`（`src/db/repo/stage-teams.js`）—— **在生产上零调用方**，只有测试在调（分别 17 / 15 / 1 处）。<br>**真机实测（决定性证据）**：直查生产库 `/var/lib/heikesong/data/app.db` ⇒ **`stages` = 0、`stage_team` = 0**、`teams` = 1、`users` = 6、`editions` = 1。<br>**后果（不是「少一个功能」，是主流程全断）**：<br>① `GET /api/stages` ⇒ `items: []` ⇒ 前端**没有任何赛段可选**；<br>② 评审打分页（`/review`）、发榜页（`/publish`）、破同分（`/tiebreak`）、企业签字台全部以 `:stageId` 为路径参数 ⇒ **一个都进不去**（拿不到合法 stageId）；<br>③ 即使硬塞一个 stageId，`assertTeamInStage` / `assertVotingJudge` 也会因「赛段不存在 / 评委未分配」而 404 / 403；<br>④ ⇒ **E149 修好的发榜端点在真机上依然不可达** —— 端点是对的，但**没有赛段可发**。<br>**判定：设计缺口（与 E149 同型，工程量更大）** —— 设计 §9 的前端 IA 里明写「**赛段配置与权重表**」（组委会视角），但设计 §8 的 API 清单里**没有任何建赛段 / 派评委 / 报名册的端点** ⇒ 界面要求存在，却没有 API 能满足它。E149 漏的是「发榜」这一个动作的入口；本条漏的是**「赛段」这个主数据本身**的创建入口。<br>⇒ 修法：新增 `src/services/stage.js` + `src/http/routes/stages.js`（建赛段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册，**每个写端点都配逆向路径**）；`scripts/seed.js` 依据 `rules/schedule.json` 补建 5 个赛段（S1 调研 / S2 任务 / S3 开发 / S4 路演 / S5 落地）并派评委、登记名册；补一条**经 HTTP 路由**的端到端闸（全新库 ⇒ 种子 ⇒ 赛段存在 ⇒ 评审可提交 ⇒ 计算 ⇒ 发榜 ⇒ 五张表都有数据）。 |
| E151 | 🧭 **P11 复盘结论：四个问题是「设计漏一条」还是「代码写错」** | 用户追问 E141/E148/E149 是设计问题还是代码问题，复盘结论：<br>· **E149 发榜只做计算** ⇒ **设计清单漏一条（接口契约层）** + 缺「服务层动作 ⇒ 必有路由」对账；<br>· **E141 企业确认无法撤回/改签** ⇒ **设计缺口（业务闭环缺失）**：只有正向没有逆向纠错 —— 「部分生效」被实现成「直接按 0 分 + 告警」的**终态**，没有「推进到完全生效」的路径；<br>· **E148① 写端点不强制 `crossJudgeId`** ⇒ **不是 bug**，符合设计（R2 是**计分口径**，不是写入校验）⇒ **撤回**「写入期强制」这条建议（会改变 S7 语义），改走「后补 / 撤回 / 改签」的逆向路径；<br>· **E148② 同格重签返 500** ⇒ **纯实现 bug**（违反三态状态码口径）。<br>**三条可复用的病根**：① **闸的形态不对** —— 现有闸大量是「服务层单测」，**没有一条经 HTTP 路由的端到端闸** ⇒ 「服务层写了、路由没挂」可以一路绿灯；② **设计清单是实现依据，但清单本身没与「业务动作清单」对账**；③ **逆向流程缺席** —— 全产品只有正向流程。<br>⇒ P11 三条对策：**补经 HTTP 路由的端到端闸** + **新增机器闸「服务层导出函数 ⇒ 生产必有调用方」** + **所有新写端点必须配逆向路径**。 |
| E152 | 🧪 **新增机器闸：服务层导出函数 ⇒ 生产必有调用方（`dead-service-scan.mjs`）** | 新建 `docs/tools/dead-service-scan.mjs`（P11）+ `docs/tools/dead-service-scan.allow.json` + 17 例自测。<br>**口径**：扫 `platform/src/services/*.js` + `platform/src/db/repo/*.js` 的导出函数；**调用方范围 = `platform/src/**`**（排除 `test/` / `scripts/` / `web/` —— 运维脚本不是产品路径）；区分「调用 / 回调值引用 / 同文件 / 脚本 / 从未提起」五类；**有死函数 ⇒ 退出码 1**；支持 `--json` 与 `--allow`。<br>**首跑结果**：57 文件 / 317 导出 / 267 有调用方 / **50 死函数** / 0 无法判定。<br>**它当场抓出 3 个真缺口**：① 破同分复议分**没走「只消费已关闭轮次」口径** ⇒ 榜单随投票漂移（已改走服务层 `getTiebreakExtraScores` 并删掉仓储层孪生实现）；② 反作弊 `runDetection` **无生产触发点** ⇒ 复核队列永远空（已接进 `computeStage`，失败降级为 `anticheat_detection_failed` 告警，**不静默**）；③ `recordComputation` 与 `compute.js` **各写一份快照**（两个写者）⇒ 已统一走服务层。<br>⇒ 配套新增 `listScoreStats` / `listUsersForDetection`（后者含 phone —— `listAllUsers` 不返回 phone 导致「同一手机号多账号」检测**永远不可能命中**）；`buildReverseAuditTasks` 从服务层**下沉到 `src/domain/`**（纯函数、浏览器安全）⇒ 演示站与正式站 import 同一个函数。 |
| E153 | 🪞 **计划块漂移审计漏掉了三个阶段（P8 / P10 / P11）** | `docs/tools/plan-block-audit.mjs` 的 `PLANS` 数组只列了 P0–P7、P9，而 `docs/superpowers/plans/` 下**实际还有 P8 / P10 / P11** 三个计划文件。<br>⇒ **这三个阶段拥有的文件的计划块漂移永远查不出来** —— 与 E149/E150 同族的「闸有盲区」，闸本身绿灯但它压根没看那些文件。<br>⇒ 补齐 `PLANS` 覆盖面后重新审计，**新暴露的 C-RW 逐条用 `plan-block-sync.mjs` 同步回 owning 阶段计划块**（含本轮改动的 `web/views/publish.js` → P8、`web/views/signoff.js` → P10、`web/api.demo.js` → P6、`web/app.js` → P0、`web/nav.js` → P7、`web/views/team.js` → P1、`test/web-review-publish.test.js` → P8、`src/server.js` → P0、`src/http/routes/review.js` → P2、`src/db/repo/*` → P0/P2/P3、`src/services/anticheat.js` → P4）。<br>⇒ **纪律不变**：改既有文件 ⇒ 逐字同步回 owning 阶段计划块 ⇒ **C-RW 必须清零**。 |
| E154 | 🧩 **审计日志页交付了但从未接线（worker 交付 ≠ 产品可达）** | `platform/web/views/audit-log.js`（451 行）交付后**没有**注册进 `web/app.js`，`web/nav.js` 里也没有导航项与能力点声明 ⇒ 设计 §9 明写的「审计与复算 → 审计流水」界面在产品里**不存在**。<br>⇒ 接线时撞出**第二个真问题**：前端路由是**注册顺序**先匹配（`web/router.js` 的 `match()` 遍历取第一个命中）⇒ `/audit/log` 若注册在 `/audit/:computationId` **之后**，会被后者吃掉（`computationId='log'`）⇒ **审计日志页永远打不开**（与 P10 的 `/review/prep` 必须先于 `/review/:stageId` 是**同一个坑**）。<br>⇒ 已把 `/audit/log` 移到 `/audit/:computationId` **之前**注册，并补 `ROUTE_CAPABILITIES['/audit/log'] = 'audit:read'`（与 API 的**全局**能力点同口径 —— 注意 API 无权时返回的是 **200 + 空集**而非 403，前端不声明能力点就会把「无权」误读成「没记录」）。<br>⇒ 演示适配器侧：`GET /api/audit/log` 端点**早就实现**但**没有任何写方** ⇒ 公网演示站那页永远是空表（页面接上了却什么也看不到）⇒ 新增 `demoWriteAuditLog`，让演示站的「重新计算」「发布榜单」都留痕（`stage.compute` / `leaderboard.publish`，与正式站 action 同名）。 |
| E155 | 🧭 **演示适配器与正式站的「同形」纪律（本轮统一由集成人改）** | `web/api.demo.js` 历史上被多个 worker 并行改过 ⇒ 出现过两处各写一份形状的漂移（E144 告警明细泄漏、E146 计数不刷新）。<br>⇒ **P11 决定：演示适配器本轮统一由集成人改**，worker 只写新文件。<br>⇒ 演示适配器本轮补齐：容器 `published` / `tiebreakRounds` / `tiebreakVotes` / `publicTokens` / `auditLog`；端点 —— 发榜读写、企业确认 withdraw/resign + 同格 409、破同分 5 端点、公开令牌 3 端点、`POST /api/teams/:id/behavior-events`、`GET /api/audit/log`（读口早已存在，本轮补上**写方**）。<br>⇒ `test/demo-api-parity.test.js` 的 `VIEW_ENDPOINTS` 补进本轮全部新端点 ⇒ **以后新增页面漏端点会被立刻抓住**（这条闸在 P10 当场就抓出过两个）。 |
| E156 | 🚧 **赛段级名册「写了但评审路径不读」⇒「外队进榜」的闸门始终没关上（E150 的同族尾巴）** | 机器闸把死函数清到只剩一条时，剩下的那条就是 `src/db/repo/stage-teams.js::hasStageRoster` —— 它在生产上**零调用方**。<br>**为什么它不是「合理豁免」**：该文件的头注释明写「P2 的 `services/review.js` 的 `assertTeamInStage` 仍是**届期级**判定 —— 切换到赛段级需要『名册有数据时优先赛段级、否则回落到届期级』的口径」（P3 计划偏差表 3c）。<br>⇒ **届期级名册挡不住「同届期另一赛段的队伍」**：那支队会被写进本赛段的评分 / 企业确认 / 破同分轮次 ⇒ **外队进榜**（db/migrations/004_leaderboard.sql 的 `stage_team` 表注释原文：「只有届期名册时，同届期另一赛段的队伍也能被写进本赛段 → 外队进榜」）。<br>⇒ E150 把 `stage_team` 的**写方**接上了（建赛段时登记名册），但**读方**没接 ⇒ 表变成了「只写不读的死表」。<br>⇒ **修法**：服务层抽**唯一入口** `resolveStageRoster(db, stageId)`（P11 新增）：赛段级名册有数据 ⇒ 以它为准（外队进榜被挡住）；赛段级名册为空（赛段刚建、还没报名册）⇒ **回落到届期级**（否则会把所有评分都拒掉 —— 那是「全死」，比外队进榜更糟）。<br>⇒ 三处读点统一走它：`services/review.js`（`assertTeamInStage` + `getReviewState`）、`http/routes/review.js`（企业确认的名册判定）、`services/tiebreak.js`（破同分同分组判定）。<br>⇒ **端到端闸**（`platform/test/stage-roster-guard.test.js`，3 例全绿）：经 HTTP 路由提交评分，外队 ⇒ 404 `TEAM_NOT_IN_STAGE`；名册内的队 ⇒ 200（反向对照，防「闸门关上」变成「全死」）；名册为空 ⇒ 回落到届期级；企业确认同样受约束。<br>⇒ **变异检验 3/3 全部被杀死**（回落到届期级 / 恒返回空名册 / 不回落）：每条都精准杀死 1–2 条断言 ⇒ 闸有判别力，不是恒绿。 |
| E157 | ✅ **P11 真机部署与复验（发榜全链第一次在真机上跑通）** | **部署**（提交 `02d113e` + `eefad52`）⇒ 真机（8.133.200.235 / Debian 12 / Node v22.22.2）⇒ `systemctl restart heikesong` ⇒ **active**；演示站 `https://8.133.200.235:8445/` 重新发布（首页 / index.html / web/app.js 均 200，nginx reload 成功）。<br>**① 修完 E150 后的生产库**：重跑种子 ⇒ `stages` 0 → **5**、`stage_team` 0 → **5**、`stage_judges` → **15**、`conflict_declarations` → **15**；赛段 = s1 调研 / s2 任务 / s3 开发 / s4 路演 / s5 落地（来自 `rules/schedule.json`）。⚠️ 种子打印「**管理员已存在**」⇒ **管理员口令未被改动**（按设计不落盘、不覆盖）。<br>**② 生产接口** `GET /api/stages` ⇒ **返回 5 个赛段**（此前是 `items: []`）。<br>**③ 隔离实例全链复验**（`DATA_DIR=/tmp/hks-p11` + 独立端口，复验后已停、临时库与 cookie 已清）：<br>· 评委登录（13800000021）⇒ `POST /api/stages/:id/reviews` **200**（`submitted: 1`）—— 此前因无赛段/无席位，这里只能是 403；<br>· 管理员 `POST /api/stages/:id/compute` ⇒ 200（`computationId` + 1 支队伍）；<br>· 管理员 `POST /api/stages/:id/publish` ⇒ 200（**3 个快照** + awarded）；<br>· **发榜后五张表 + 审计全部落库**：`stage_results` = 1、`computation_snapshots` = 2、**`points_ledger` = 2**、**`leaderboard_snapshots` = 6**、**`tier_records` = 1**、`audit_log('leaderboard.publish')` = **2** ⇒ **E149 的四样「一个都不写」已全部修复**；<br>· 读端：`GET /api/leaderboard/:id?scope=personal` ⇒ **2 行**（此前恒空）；`GET /api/audit/log` ⇒ 3 行、首条 `action=leaderboard.publish`；`GET /api/stages/:id/tiebreak/rounds` / `GET /api/public/tokens` ⇒ 200；<br>· **E156 闸门实测**：名册外的队提交评分 ⇒ **404 `TEAM_NOT_IN_STAGE`**（同届期但不在赛段名册的队被挡住）。<br>**④ 公网演示站浏览器实跑**（用户登录后）：审计日志 / 加时陈述 / 公开访问链接 / 赛段发榜**四页全部渲染成功**，暗色默认，**console 错误 0**；发榜页四个新面板到位（「发榜前检查」已交 101 / 应交 120 / 名册 5 支 / 5 支还缺打分；「缺谁该打分」19 格按评委分组；「重新计算」与「发布榜单」两个独立动作；「发榜状态」）。<br>**⑤ 本机验收**：全量 `node --test` = **1882 例 / 1881 通过 / 0 失败 / 1 跳过**；四机器闸（audit-scan / temp-leak-scan / bash-var-scan / **dead-service-scan**）退出码**全 0**；漂移审计 **A 219 | B 8 | C-EXT 58 | C-RW 0 | D 0**；P11 §5 新建文件规格块 **21 份逐字 `--verify` 全一致**。 |
| E158 | 🚧 **设计 §9 明写的「赛段配置与权重表」界面不存在 ⇒ P11 做好的 6 个赛段写端点在产品里零 UI 调用方（E149/E150 同族的「写了没接线」）** | **起因**：P11 的 E150 把建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册 **6 个写端点**全做完了（服务层 + 路由 + 种子 + 端到端闸都绿），**却一个前端界面都没有** ⇒ 端点在产品里零调用方。而设计文档 §9 的 IA 图第 883 行明写「**赛段配置与权重表**」（组委会视角）⇒ 界面要求存在，却既没有界面也没有「能选人」的读口。<br>**补界面时又撞出下一层缺口**（与 E149/E150 同一族的「清单没对账」）：页面要能选队伍、选评委、看权重表，而这三个读口**一个都不存在** —— ① `GET /api/teams` 返回的是「**我参与的**战队」（participant 视角）⇒ 组委会看到的永远是空数组 ⇒ 名册登记页**没有任何可选队伍**；② 没有任何端点能列出「可当评委的人」；③ 权重表的维度虽已由 `GET /api/event-info` 公开，但组委会要的**席构成约束**（judgePool）没有对外投影。<br>**⇒ 后端新增 4 个组委会读端点**（`src/http/routes/stages.js`，P11 owns）：`GET /api/editions`（公开，届期是公开赛事信息）、`GET /api/editions/:editionId/teams`（候选队伍）、`GET /api/editions/:editionId/judge-candidates`（评委候选池）、`GET /api/editions/:editionId/scoring-configs`（权重表 + 席构成约束）。新增仓储函数 `listStageJudgeCandidates`：**评委候选池 = 持评委类角色的人，不是全部用户** —— 机器闸 allow.json 已把 `listAllUsers` 判为「未被消费是语义上正确的结果」（用它会破坏顶层文档 §3.1 S2「一切按 edition 隔离」）⇒ 复用它等于推翻既有裁决。<br>**投影纪律**：权重表逐字段白名单（只给 维度/权重/席 + judgePool 席构成约束），**不给** note / source / conflictRef 等内部工作语言（与 `src/domain/event-info.js` 同款纪律）。<br>**能力点口径**（接线时抓到的裂缝）：新增 `requireStageComputeForEdition` —— **届期级或该届期下任一赛段的赛段级**都放行，与写端点 `requireStageComputeForStage` 同口径 ⇒ 不出现「**能改赛段、却读不到权重表**」；而「建赛段」保持**届期级**严格口径（赛段级授权是「针对某个已存在赛段」，不该允许建新段）。<br>**⇒ 界面**：新建 `platform/web/views/stages.js`（1368 行）—— 届期选择器 / 赛段列表 / 建段表单 / 改配置表单 / **只读**权重表 + 席构成约束 / 评委席（派·撤）/ 名册（登记·退），逆向路径（撤评委 / 退名册）带**影响面**二次确认（不是「确定吗？」）；接线 `web/app.js`（`/stages` 与 `/stages/:stageId`）与 `web/nav.js`（组委会分区 + `ROUTE_CAPABILITIES['/stages'] = 'stage:compute'`）。<br>**顺带修**：`GET /api/stages` 的摘要原本不带 `freezeAt` / `scoringConfigKey` ⇒ 页面刷新后回填不了这两项 ⇒ 补上（两者都是赛程/权重表键，落地页早已公开，不扩大公开面）。<br>**演示适配器**（P6 owns，本轮统一由集成人改）：补 11 个端点 + 3 个容器（`stages` / `stageJudges` / `stageTeams`），并把「从计算结果推导的赛段」**实体化**进 `state.stages`（否则演示站上点 `stage_final` 一律 404「赛段不存在」）。<br>**闸**：新增 `test/stage-config-api.test.js`（7 例，走**真实 HTTP 路由**，含 401/403/404 三态与届期级/赛段级两种授权口径）+ `test/stage-config-view.test.js`（45 例，纯函数渲染 + 端点路径与 `ctx.api.del` 的静态钉）；演示端点平价闸 `test/demo-api-parity.test.js` 的 `VIEW_ENDPOINTS` 补进本轮 9 个端点。<br>**变异检验 9/9 全部被杀死**（去掉角色过滤 / 放进已停用用户 / 漏出内部 note / 漏掉 tier / 漏掉 judgePool / 闸门失效 / 404 变空集 / 读口退回「只认届期级」/ 摘要漏 freezeAt+scoringConfigKey）⇒ 每条都精准杀死 1 条以上断言，闸有判别力、不是恒绿。<br>**本机验收**：全量 `node --test` = **1937 例 / 1936 通过 / 0 失败 / 1 跳过**；四机器闸（audit-scan / temp-leak-scan / bash-var-scan / dead-service-scan）退出码**全 0**；漂移审计 **A 223 | B 8 | C-EXT 58 | C-RW 0 | D 0**；P11 §6 规格块 **25 份**逐字 `--verify` 全一致。<br>**真机复验**（8.133.200.235）：部署 ⇒ `systemctl restart heikesong` ⇒ active；演示站 8445 重新发布（首页 / index.html / web/app.js 全 200，nginx reload 成功）。<br>· **生产公开接口**：`GET /api/editions` ⇒ 返回当届（首届 · 上海）；`GET /api/stages` ⇒ **5 个赛段**，且摘要已带 `freezeAt` / `scoringConfigKey`（页面回填用）。<br>· **隔离实例全链**（`DATA_DIR=/tmp/hks-e158` + 端口 8099，复验后已停、临时库与 cookie 已清）：4 个读端点 + 6 个写端点 + **2 条逆向路径**全部 200；`GET /api/editions/:id/scoring-configs` ⇒ 两张权重表各 6 维度 + `judgePool` 约束（最少评委 9 / 企业席 30% / 专家席 50% / 观察席无投票权），**无 `note` / `source` / `conflictRef` 泄漏**；评委候选池 = 4 人（企业代表 + 评委甲/乙 + 观察员），**参赛队长不在池里**；三态：无 cookie ⇒ **401**、错误届期 ⇒ **404**、无能力 ⇒ **403**。<br>· **库里到底有什么**：`stages` 5 → **6**、`stage_judges` 15、`stage_team` 5、`conflict_declarations` 15 → **16**；审计动作齐了 **`stage.create` / `stage.update` / `stage.judge.assign` / `stage.judge.remove` / `stage.roster.register` / `stage.roster.remove`** 六类。<br>· **公网演示站浏览器实跑**：`#/stages` 页**六个面板全部渲染成功**（届期与赛段 / 新建赛段 / 赛段配置 / 权重表只读 / 评委席 / 名册），暗色默认，**console 错误 0、警告 0**；导航「组委会」分区**新增「赛段配置」入口**；权重表只读面板正确显示 6 维度 + 合计 100% + 席构成约束（每维度最少评委 9 / 企业席 ≥30% / 专家席 ≤50% / 观察席无投票权）；`stage-cfg-key`（赛段代号）**置灰不可改**、`stage-cfg-name` 正确回填「决赛赛段」。<br>· **写路径实测（浏览器真点）**：选人 + 选席 ⇒ 点「派评委」⇒ 成功提示「**已派评委** / 席位 评委席 已派出。/ 席位与利益冲突声明同一次写入（已留审计）」，统计「本赛段评委席」**0 → 1**；评委席表格正确回填姓名 + 席徽章 + 声明时间。<br>· **逆向路径实测（浏览器真点）**：点「撤评委」⇒ 出现**写明赛段与影响面**的二次确认块（不是「确定吗？」）⇒ 点「确认撤回」⇒ DELETE 成功 ⇒ 提示「已撤回该评委 / 该评委在本赛段的席位已失效，其在本赛段签署的利益冲突声明一并解除（声明记录作为历史事实保留）」。<br>· ⚠️ **演示站加载慢是客户端现象，不是站点故障**：本机到演示站经代理，页面要并发取约 40 个模块与规则文件，实测**冷加载约 40 秒**（nginx access.log 里 200/304 全部正常到达、HTTP/2 正常）；同一构建在**本地**起静态服务则秒开。 |
| E159 | 🚧 **前端不渲染 markdown ⇒ 文案里的 `**` 在页面上原样漏出（浏览器实测抓到的显示缺陷）** | **怎么发现的**：E158 在公网演示站浏览器实跑「赛段配置」页时，在「席位」下方看到「观察席**无投票权**」—— 两个字面的星号躺在页面上。<br>**根因**：本仓前端**不渲染 markdown** —— `noticeState` 走 `escapeHtml`（`web/ui.js:128-135`）⇒ 提示条里是纯文本；`field__hint` / `muted small` 同理。⇒ 文案里写 `**…**` 用户看到的就是**字面星号**。<br>⇒ 修掉 `web/views/stages.js` 的 **10 处**用户可见文案（`field__hint` / `muted small` 按仓库 house style 改成**纯散文**；裸 HTML 的 `notice__text` 改成 `<strong>` —— `noticeState` 会 escapeHtml，那两处不能用标签）。<br>⇒ 顺手扫出**同型旧账**：`web/views/publish.js` 的发榜二次确认文案「会按**当前评分**清空旧名次…」（P8 起）⇒ 一并修掉。<br>⇒ **全站扫描**：除上述两处外，全站 `web/views/*.js` 的用户可见文案里**再无** markdown 标记（`landing.js` 的 `1 - (1 - t) ** 3` 是 JS 幂运算，非文案）。<br>⇒ **新增全站级闸** `platform/test/view-markdown-leak.test.js`（2 例）：扫 `web/views/*.js` 的**非注释行**，禁止 `**`；另有一条收窄判据的「落单星号」检查（**紧邻中文**才算 —— 免得误伤乘法运算符 `* 100` 与文件名通配 `scoring-*.json`）。<br>⇒ **变异检验**：把 `publish.js` 的 `<strong>` 改回 `**` ⇒ 闸变红（抓住了）；把 `stages.js` 的星号放回去 ⇒ 视图级闸变红（抓住了）。<br>⇒ **屏上复验**（重新部署 + 演示站浏览器实跑）：页面文本已是**纯散文** —— 「观察席无投票权；企业席 ≥30%、专家席 ≤50% 由服务端校验（页面不复制这套判定）。」「代号建后不可改（它进 URL 与日志）…」「权重表只读：要改权重，改 rules/scoring-*.json 这一份 JSON，重启即生效。」——**再无字面星号**；部署产物（`/opt/heikesong/demo/web/views/*.js`）核对：旧文案命中数 **0**。 |
| E160 | 🎨 **诊断：四个委员会页「页面专属 class 数为 0」⇒ 四页长得一模一样（设计缺口，不是实现写错）** | **起因**：用户要求「重新调用 ui-design 优化 UI」。本轮先**量后改**（不先入为主地改样式）。<br>**量法**：本地演示站（`PORT=8092` + `platform/web/dist`）+ Playwright，六视口（360/390/768/1024/1440/1920），测**页面高度 / 表面签名 / 触控目标 / 强调色档数 / console 错误**；静态侧跑 `extract-design.mjs`（70 个 custom props、797 处 `var()`、18 色 = 15 token + 3 字面）与 `ui-source-audit.mjs`。<br>⚠️ **量法上的一个坑（已踩）**：移动视口必须 `isMobile + hasTouch` ⇒ Chromium 才报 `pointer: coarse`；否则 ⑯ 段的触控规则不生效，量到的是「桌面鼠标口径」的假数据。<br>**发现 ①（结构）**：`stages` 页用到的 **77 个 class 全是通用类**（panel / card / stack / field / btn / badge / notice / stat / table…），**页面专属 class 数为 0**；顶层结构恒为 `div.stack > header.page__head + div.stat-row + section.panel × 6` ⇒ 四个委员会页（赛段配置 / 破同分 / 公开链接 / 审计日志）**用的是同一套通用卡片栈**，访客分不清自己在哪一页、六个面板同权重同材质、**「我现在操作的是哪一个赛段 / 哪一组筛选条件」在页面上没有位置放**。<br>**对照**：同仓的 `signoff.js` 有 **10 个专属 class** + `styles.css` ⑪ 配套块 ⇒ **本仓已有「页面专属 class 集 + styles.css 专属块」这个范式**，P11 的四个新页面只是**没用上它**。<br>**发现 ②（材质同质）**：`tiebreak` 页 **6/10 个面共用同一签名**（`10px` + 顶边 inset 高光 + 零 padding）⇒ card-kit 中危项。<br>**发现 ③（形状）**：赛段配置页是**扁平拼接的 panel 序列**（无包裹层）⇒ 移动端 360px 下该页 **5763px** 高。<br>**判定**：**设计缺口**（页面没有自己的宏观结构）⇒ 修法是**改造式（retrofit）**：保留 P10「midnight」视觉语言与信息架构、**不换调色盘**，差异化靠**形状（macrostructure）**而非新皮肤。 |
| E161 | ⛔ **勾选框只有 13×13（低于 WCAG 2.5.8「目标尺寸（最小）」24×24 的 AA 硬线）+ 勾选色是设计系统里从未声明过的色相（真缺陷）** | **怎么发现的**：量触控目标时抓到 `stages` 页 **5 个**、`tiebreak` 页 **5 个** `<input>` 只有 **13×13 CSS px** —— 那是**浏览器默认复选框的尺寸**（本仓的 `styles.css` 只给 `.checkbox input` / `.radio-group input` 写过 `width: auto`，而 P11 的两个新页面用的是**裸 `<input type="checkbox">`** ⇒ 完全没被样式接管）。<br>⇒ 13×13 低于 **WCAG 2.5.8 AA 级「目标尺寸（最小）」的 24×24 硬线** ⇒ 「登记队伍」「勾选同分队伍」这两个列表在手机上**点不准**。<br>**顺带撞出第二个缺陷**：浏览器默认的勾选蓝是 **Chrome 的 `#0075FF`** —— 那是一个**设计系统里从未声明过的色相** ⇒ ① 违反「颜色只经 token」；② 把「**每屏强调色 ≤ 3**」顶破（实测 `stages` 桌面端 **4 档**强调色）。<br>⇒ **一条规则同时修掉两个**：`input[type="checkbox"], input[type="radio"] { width: 24px; height: 24px; accent-color: var(--brand); }`（同时把 `.checkbox input` / `.radio-group input` 里与它冲突的 `width: auto` 去掉）。<br>⇒ 这条规则是**全站级**的 ⇒ `registration.js` / `flags.js` / `admin-task-packages.js` / `review-prep.js` 里的裸勾选框 / 单选框**一并受益**（它们此前同样是 13×13）。<br>⇒ **闸**：新增 `platform/test/ui-committee-contract.test.js` 的两条断言（尺寸必须 ≥24px、accent-color 必须经 token）。 |
| E162 | 👆 **触屏目标：赛程脊节点 35px、页脚链接 43.8px（差 0.2px 到不了 44）；落地页 1 处字面色值越界（真缺陷）** | **① 赛程脊节点**：落地页的「赛程脊」节点高度 **∝ 时间占比**（P10 签名）⇒ 短赛段的节点只有 **35px** 高，触屏上点不准。<br>⇒ 触屏加 **`min-height: 44px` 底线**（时间占比仍在底线**之上**继续生效，长赛段的相对关系不变）。<br>⚠️ **踩过的坑**：这条规则**写进 ⑯ 段不生效** —— 上游 `.spine__node { min-height: 0 }` 在源码里**更靠后**，同特异性下把它盖掉（实测：写进 ⑯ 段时测出来还是 35px）⇒ 必须写在**赛程脊自己的段落里**。<br>**② 页脚链接**：`--fs-xs` 12px × 1.65 行高 ≈ 19.8px + 上下内边距 2×12px = **43.8px** ⇒ **差 0.2px** 到不了 44（子像素）⇒ 改用 `min-height: 44px` 兜住（不靠内边距算高度），并补左右内边距把**宽度**从 24–36px 补到 48–60px。<br>**③ 字面色值越界**：落地页 hero 的品牌辉光写死在 CSS 里 ⇒ 亮色主题**切不掉**它（切了还是暗蓝辉光），且违反「颜色只经 token」⇒ 提到 token 层，新增 **`--brand-glow`**（暗 `rgba(124,156,255,.13)` / 亮 `rgba(47,95,224,.10)`）。<br>⇒ **另外 4 处 1px / 2px 的间距偏离 4pt 网格**：逐个看过，**全部是有意的** —— 1px = **发丝线分隔法**（`.landing__stats` 的 1px 缝漏出 `--border` 当分隔线，4px 会变成黑沟）；2px = **光学紧距**（`.landing__fact` 标签与数值是一组）与**赛程脊节点间的缝要小到看不见**（轴才读成一条连续的线）；7px / 14px = **赛程脊轴的对齐解算**（圆点横跨 2–11px、中心 ≈6.5px ⇒ 轴取 7px 才是穿过圆点中心）⇒ **数值不动**，但按「规则溯源」纪律**逐处补注释**。 |
| E163 | ✅ **P12 落地：四个委员会页改成「操作台双栏」+ 新增 UI 契约闸（18 例）+ 复审数据** | **形状（signature）**：⛔ **不新增任何颜色、不换调色盘**（P10「midnight」语言保持）⇒ 差异化只发生在**宏观结构**：**左轨选对象 + 右画布做操作**。四页各有**页面根 class**（`stagecfg-view` / `tiebreak-view` / `publinks-view` / `auditlog-view`），左轨材质按**角色**分化：赛段配置＝导航器⇒**凹陷**；破同分＝上下文选择器⇒**描边**；公开链接＝操作表单⇒**浮起**；审计日志＝过滤条⇒**平**；画布内面板一律 **raised**（材质三件套）；轨内当前对象 = **tinted**。卡片**零外阴影**不变。<br>**组件层**（`web/ui.js`，P7 owns）：新增 `workbench({rail, canvas})`（四页共用一份骨架）与 `workbenchItem({...})`（条件 class 走组件层 —— 视图里**不许**用模板表达式拼 class，机器闸按 `class="…"` 字面量抽类名）。<br>**视图层**（P11 owns）：`stages.js` 根 class + 页结构改操作台 + **赛段列表由 6 列表格改成左轨条目列表**（300px 轨放不下宽表；当前赛段用 `is-active` + `aria-current`，**不用 disabled** —— 禁用按钮会被读屏跳过）+ 加载中**不闪假空态**（原来会先闪一句「本届期还没有赛段」）；`tiebreak.js` 轨标题「赛段」→「选择赛段」（原来与字段标签重复）；`public-links.js` / `audit-log.js` 各自把「动作」与「结果」分到轨 / 画布，**局部重绘的挂载点全部保留**（`data-stats` / `data-issued` / `data-list`、`#al-stats` / `#al-msg` / `#al-state` / `#al-body`）。<br>**闸**：新建 `platform/test/ui-committee-contract.test.js`（**18 例**）—— 形状 / 页面身份 / 触控尺寸 / 勾选色 / 零外阴影 / 颜色只经 token / 视图层纪律 / 左轨条目形状，八组契约全机器化。<br>**复审（改后实测，同口径）**：<br>· 勾选框 **13×13 → 24×24**；「< 24px 目标」**5 → 0**（`stages` 与 `tiebreak` 各 5 个）⇒ **WCAG 2.5.8 AA 硬线通过**；<br>· `stages` 桌面端**强调色 4 档 → 2 档**（≤3 纪律恢复）；<br>· 落地页**触屏 <44px 目标 6 → 0**（`design-audit` 的 touch-target-comfort **消失**）；<br>· 落地页 card-kit **12/35 → 8/35**（规则磁贴补上材质三件套 + 宽幅磁贴抬高一档）；<br>· 渐变背景上的文字工具测不了 ⇒ **实算**：把文字 `visibility:hidden` 后截图采样背景像素，**最低对比度 5.66:1**（正文需 4.5）⇒ **AA 通过**；<br>· `ui-source-audit`（含测试文件）**9 findings / 1 high**（那个 high 是改动前就有的测试文件 `<img>` 无 alt）⇒ **不引入新债**；<br>· 全量 `node --test` = **1955 例 / 1953 通过**（新增 18 例）；漂移审计 **A 224 / B 8 / C-EXT 58 / C-RW 0 / D 0**（P12 已登记进 `plan-block-audit.mjs` 的 `PLANS`）。<br>**已知误报（登记备查）**：落地页 8 个**窄规则磁贴**仍共用一个签名 ⇒ `design-audit` 的 card-kit 仍报中危。但它们是**同一个栅格里的同级条目**，统一才是语义（宽幅磁贴已按「另一种角色」分化）⇒ 记为**已知误报**，不为凑闸而做无意义的差异化。<br>**真机部署与屏上复验**（提交 `6ebc758`）：真机（8.133.200.235）`tar` 同步 ⇒ `systemctl restart heikesong` ⇒ **active**；演示站 8445 重新发布（`build-demo` 预计算通过、nginx 配置语法检查通过、reload 成功；首页 / index.html / web/app.js 全 200）。平台 `https://8.133.200.235:8444/api/health` ⇒ **200** `{"ok":true,...}`，且**真证书链校验通过**（`ssl_verify_result=0`，不用 `-k`）。部署产物核对：`demo/web/styles.css` 含 `workbench` 21 处、`brand-glow` 3 处、勾选框 24×24 规则在位；四个视图的页面根 class 全部到位。**公网演示站浏览器实跑**：`#/stages` 页**左轨（届期与赛段 + 赛段条目）与右画布（指标行 + 新建赛段 / 赛段配置 / 权重表只读 / 评委席 / 名册）全部渲染**；左轨当前项显示 `stage_final / 决赛赛段 / 决赛 · 已计算`；权重表面板正确显示 6 维度 + 合计 100% + 席构成约束；「观察席无投票权」**无字面星号**（E159 仍然成立）；窄窗口下**正确折叠为单列**（左轨在上、画布在下）；**console 错误 0、警告 0**。`#/audit/log` 页同样成立（过滤条为轨、审计流水为画布）。**本地同构建交互实测**（Playwright）：赛段配置页根 class = `stagecfg-view`、workbench/rail/canvas 三件套齐、轨 1 面板 + 画布 5 面板；**走「新建赛段」表单建第二个赛段 ⇒ 新赛段立刻出现在左轨** ⇒ 点左轨条目**切换成功**（改配置面板回填该赛段名称，`is-active` 与 `aria-current` 各恰好 1 个）；**console 0 错 0 警**。 |
| E164 | 🪟 **macOS 反复弹「访达要管理员授权才能删除」⇒ 真因：测试沙箱里的 `rm` 落到了「可恢复删除」shim 上（已知的坑，只补了一半）** | **现象**：用户报 macOS 反复弹密码框（SecurityAgent 授权），删文件也没用。系统日志 + 进程快照双向验证出的链条：<br>① `test/deploy-demo-site.test.js` 的「nginx -t 失败 ⇒ 必须回滚」用例传 `HKS_NGINX_T_FAIL=1`；<br>② `deploy/deploy-demo-site.sh:125` 的回滚路径执行 `rm -f "$NGINX_LINK"`；<br>③ **agent 的 bash 里 `rm` 解析到 `~/.minimax/shims/rm`**（实测 `which -a rm` 第一条就是它，排在 `/bin/rm` 前面）⇒ 转发 `mavis-trash --rm-compatible`；<br>④ `~/.minimax/bin/mavis-trash` 走 `osascript -e 'tell application "Finder" to delete POSIX file "…"'`；<br>⑤ 目标落在**系统临时区**（`/private/var/folders/…`）⇒ 访达在此删除需管理员授权 ⇒ 弹窗。<br>**为什么一直跳、删了也没用**：每轮测试都**新造**一个同名文件（`isolateTempDir()` 每次新建临时根目录，测试再建 `heikesong-demo-XXXXXX`）⇒ 弹窗里那个文件每轮都是新的；而且 `osascript` 被模态框**阻塞不返回** ⇒ `mavis-trash` 的 `mv` 兜底永远走不到 ⇒ 命令挂死 ⇒ 循环重试 ⇒ 又弹一个。系统日志把这点写死了（`SecTranslocate: can not access … No such file or directory`）—— 文件在访达真去删之前就已经不存在了，但**授权请求已经发出去了**。<br>**根因是「已知的坑，只补了一半」**：`test/deploy-assets.test.js` 早就踩过并写了注释与桩（它 source 的是 `install.sh`：「某些开发环境把 `rm` shim 成『可恢复删除』（走 osascript + Finder，每次要好几秒，有时还会卡住）」），但另外三个**同型**测试（`deploy-demo-site` / `deploy-tls-port` / `deploy-plain-http`）同样 `source` 真脚本（回滚路径里同样有 `rm -f "$NGINX_SITE"` / `rm -f "$NGINX_LINK"`），却**没跟着补桩**。<br>**⇒ 修法（补桩 + 机器闸）**：三个测试的 `binDir`（PATH 最前）里各加一个 `rm` 桩，内容 `exec /bin/rm "$@"`，与 `deploy-assets.test.js` 的先例**逐字同款** —— 被测的仍是**逻辑**（回滚删没删对东西），不是「删除是否可恢复」。<br>**⇒ 新建机器闸** `platform/test/sandbox-rm-stub.test.js`（3 例）：① 凡是**会跑 shell** 的测试**必须**给 `rm` 打桩（含桩要指向真正的 `/bin/rm`、要 `chmod 0o755`）—— 判据是「spawn 了 `bash`/`sh`」**或**「建了 PATH 影子沙箱」，**或**关系：只判后者不够，将来若有测试不建 binDir 却照样 spawn shell，它的 `rm` 依然会走 shim；（实测全仓会跑 shell 的测试共 **5** 个：deploy-assets / deploy-demo-site / deploy-plain-http / deploy-tls-port / 本闸自己，**现已全部有桩**）；② **行为断言** —— 同款沙箱里 `command -v rm` 必须落在 `binDir`（不是宿主机的 shim）；③ **反向自检** —— `deploy/*.sh` 里若已无任何 `rm` ⇒ 前提消失，该改闸而不是留着当摆设。⇒ 免得第 5 个同类测试再踩一次。<br>**变异检验**：把 `join(binDir, 'rm')` 改成 `'rm2'` ⇒ 闸变红（抓住了）；还原 ⇒ 变绿 ⇒ 闸有判别力、不是恒绿。<br>**决定性对照（只查不删，不触发任何删除）**：宿主 bash 的 `rm` ⇒ `/Users/mac/.minimax/shims/rm`；沙箱**有桩** ⇒ `…/bin/rm`（桩）；沙箱**无桩**（改前的样子）⇒ 又回到 shim ⇒ 补桩确实把 shim 挡在了外面。<br>⚠️ **顺带证明了仓里的闸在岗**：新写的闸文件第一次提交时，`scripts/temp-leak-scan.js` **当场把新文件抓了出来**（R1：用了系统临时目录却没 import `test-helpers/tmp.js` ⇒ 临时目录没有回收机制；补上后又报 R2：隔离调用必须**早于**第一次求值系统临时目录 —— 而闸是按**原始行**扫的，**注释里出现同样的字样也算行**，⇒ 我自己那句解释性注释把调用推到了后面，当场改掉）⇒ 这条链没白修。<br>⛔ **没有**采用 `MAVIS_TRASH_FORCE_MV=1` 那个止血开关（实测有效，`mavis-trash` 里确有此分支）：它是**环境变量**，不在仓库里 ⇒ 换台机器 / 换个 shell 就复发；仓库里的修法才是根治。 |
| E165 | 👆 **触控目标的「有效可点区」只有 24px 高 —— 外部复核报的 low 是准确的（复选框本身 24px 过 AA 硬线，但可点的是它那一行）** | **外部复核结论**：用 `ui-design` 的 `design-audit` 复核本仓（P12 之后的 UI 状态）⇒ 静态 0 high / 0 medium / 7 low、运行时 0 high / 0 medium / 7 low，**被验证项目本身无改动建议**；7 条 low 全部指向项目在注释里写明的有意设计。其中一条是「5 个触控目标过 WCAG AA（24px）但低于 44px 平台舒适线」—— 指的是名册与同分队伍的勾选框。<br>**本仓核实后判定：这条是准确的**（不是工具误报）。外部工具量的是 `<input>` 元素本身（24×24，**过 AA 硬线**），而**人手指点的是它所在的那一行**（`<label>` 包着「勾选框 + 队名」，点队名会勾上 —— 实测 `before=false → after=true`）。<br>⚠️ **实测推翻了我自己的一个假设**：我原以为「`label` 有上下 12px margin ⇒ 那一行 ≥48px」—— **错**：`getBoundingClientRect()` 量的是 border box，**margin 不算进去** ⇒ label 的盒子只有 **24px 高** ⇒ **整条可点区只有 24px 高**（实测 75×24 / 88×24），确实低于 44px 舒适线。<br>⇒ **修法是「垫行」，不是把方块撑大**：<br>　❌ 把复选框撑到 44×44 —— 44px 的方块在密集列表里非常难看，且违背「桌面密度不变」的纪律；<br>　✅ **触屏口径下**给「包着勾选框的 label」加 `min-height: 44px` ⇒ 勾选框由 `align-items: center` 居中、**视觉尺寸不变（仍 24×24）**，可点的那一行变成 44px；用 `:has()` 挑选（`label:has(> input[type="checkbox"])`）—— 本仓已在用 `:has()`（`.radio-group .radio:has(input:checked)`）⇒ 口径一致；**全站级** ⇒ 报名页的同意勾选、复核台的独立信源、任务卡的否决票…一并受益；**只在 `@media (pointer: coarse)` 下生效**（⑯ 段既有纪律：桌面鼠标能精确指着，不该被放大）。<br>⇒ **实测**：触屏口径下 label 由 75×24 / 88×24 ⇒ **75×44 / 88×44**，勾选框仍 24×24，点队名仍能勾上；**桌面口径完全不变**（仍 75×24）。<br>⇒ **新建机器闸** `platform/test/touch-target-effective.test.js`（**5 例**）：① 两个页面**真的渲染出了勾选框**（否则断言空跑）+ 每个勾选框**都被 `<label>` 包着**（否则「点文字也能勾」不成立 ⇒ 可点区真的只有那个小方块）；② styles.css 必须有「触屏口径把 label 垫到 44px」的规则且数值 ≥44；③ 那条规则**只在 `pointer: coarse` 下生效**；④ 勾选框**本身**仍须 ≥24×24（**不能靠垫行替代 AA 硬线**）。<br>⇒ **变异检验 2/2 KILLED**：44px 改成 30px ⇒ 闸②红；规则搬出 `@media` ⇒ 闸③红；还原 ⇒ 全绿。<br>⇒ **对「要不要把 ci-gate 基线接进本仓 CI」的判断：⛔ 不接** —— `ci-gate.mjs` 依赖 `ui-design` skill 的脚本，而 skill 在**仓库之外**（`~/.minimax/skills/ui-design/`）⇒ 服务器上的 CI 拿不到，基线文件写进仓库也只是死数据；⇒ 本仓的对应做法是**把值得守的判据翻译成仓内的原生闸**（`node --test`、零依赖、可移植、服务器上能跑），本轮已落三个：`ui-committee-contract` / `sandbox-rm-stub` / `touch-target-effective`。 |
| E166 | 🔇 **计划块漂移闸在 Node 22.16.0（= 本仓声明的最低版本）上「静默不跑」—— 退出码 0 却零输出，正是这个工具自己要防的那种假绿** | **发现路径**：发布 0.1.0 时把脱敏镜像 force-push 到公开仓 ⇒ GitHub Actions 的 **Node 22.16.0 档**红（22.x / 24.x / 漂移闸三档全绿）⇒ 拉 Node 22.16.0 到本地复现 ⇒ **本仓未脱敏的原始 HEAD 同样红 3 例** ⇒ 证实是**既有缺陷，与脱敏无关**（不是这次发布改坏的）。<br>**根因**：`docs/tools/plan-block-audit.mjs` 的主流程被 `if (import.meta.main)` 守卫包着，而 **`import.meta.main` 新增于 v24.2.0 / v22.18.0**（实测：Node 22.16.0 上它是 `undefined`）⇒ 本仓 `engines` 写的是 `node >= 22.16.0` ⇒ 在 22.16 / 22.17 上守卫**恒假** ⇒ 整个审计**不执行**、**退出码仍是 0**、**stdout 为空** ⇒ CI 的漂移闸 grep 不到 `C-RW` 计数就按 0 处理 ⇒ **假绿通过**。<br>（两处注释里的版本号也都是错的：`plan-block-audit.mjs` 写「Node ≥ 20.11 提供」、`dead-service-scan.mjs` 写「Node ≥ 22.16」—— 20.11 没有这个特性，22.16 也没有。）<br>**⇒ 修法**：抄**同目录 `dead-service-scan.mjs` 早就有的兜底写法**（那个工具一直就有 `argv[1]` 比对，所以它在 22.16.0 上始终正常、17/17 通过）—— `const IS_MAIN = import.meta.main === true \|\| (typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url))` ⇒ 任何版本都真跑；顺带把两处写错的版本注释订正为「新增于 v24.2.0 / v22.18.0」。<br>**⇒ 实测**：22.16.0 上工具恢复输出，且两档 Node 的汇总**逐字一致** —— A 225 \| B 8 \| C-EXT 59 \| **C-RW 0** \| **D 0** ⇒ **没有被静默掩盖的漂移**；回归用例 7/7 通过；全量 1963 例在 **22.16.0 与 22.23.2 上均 1962 通过 / 0 失败 / 1 跳过**。<br>⇒ **回归闸在哪**：抓它的用例**一直都在**（`platform/test/plan-block-audit.test.js`：读不到汇总行 ⇒ `match(...)` 返回 null ⇒ `TypeError: Cannot read properties of null`）—— 真正让它暴露的是 **CI 矩阵里的 22.16.0 档**（本地默认 Node 22.23.2 ⇒ 本地永远跑不到那条路径）⇒ 这就是「矩阵必须覆盖声明的最低版本」的价值。<br>⇒ **文件归属**：本条改 `docs/tools/plan-block-audit.mjs` 与 `docs/tools/dead-service-scan.mjs` —— 两者**都不在任何计划块内**（`plan-block-audit.mjs` 审计范围只含 `platform/` 的实现文件）⇒ **无需 plan-block-sync**，按 P6 约定记在本台账。 |
| E167 | 🔒 **P13 开局：2026-10-23 全量审计的 47 条缺陷 —— 本轮修掉 9 条（2 Critical + 5 越权 + 2 闸），修法与「为什么不能改 can()」** | **背景**：发布 0.1.0 前，2026-10-23 的一次全量审计查出 **47 条缺陷**（Critical 2 / High 18 / Medium 21 / Low 6），其中 **24 条写成了红灯回归用例**（`platform/test/audit-findings.test.js`，28 例 ⇒ 27 红 1 对照组绿）。审计**未改一行生产源码**，全部产出是「报告 + 红灯」，本轮才开始修。<br>**⚛️ 本轮最重要的结论（决定了后面所有越权类修法）**：INTERFACES.md:22 与 :99-100 明文规定「**超管 / role_capability 授权一律不做行级过滤**」⇒ **「角色授权是全局的」是项目自己的设计决定，不是缺陷**。⇒ 所以**不能**改 `can()` 的角色分支（那会破坏「can() 与 scopeClause() 给出相同结论」的契约），真正的病灶是**调用方用全局能力点表达了作用域受限的意图**。<br>⇒ 因此新增两个显式入口（`src/auth/permissions.js`）：<br>　**`isCommitteeActor(db, user)`** —— 「组委会」判**身份**（admin 角色 / 超管）。因为 `role_capabilities` **没有 scope 列**，`captain` 角色**也**持有 `team:manage` ⇒ 带 scope 的 `can()` 表达不了「我对这一支队伍有权限」。<br>　**`canScoped(user, capability, ctx, db)`** —— `can()` 的**作用域化那一半**（只看 `assignments`，不看角色）；两者共用 `assignmentGrants()` ⇒ 结论一致。<br>⇒ **本轮修掉的 9 条**：<br>　① **F16（Critical）签级表单自锁** —— 两个规格解析器**优先级相反**（`resolveSolvabilitySpec` 规则优先 / 视图里的 `load()` 包投影优先）⇒ 一旦有卡被评估过，**残缺**的包投影（只有档位键、无 minScore）盖掉完整规则 ⇒ `gradeTiers()` 判「档位未就绪」⇒ **签级控件整片消失**（只有改代码才能恢复）。修法**双端**：服务端把完整档位定义投影进 `meta.solvability`（生产**不挂** `/rules/`，只有 DEMO_MODE=1 ⇒ 规则投影那条路在生产是断的）、前端读它并**投影不出完整档位就降级**、视图统一走 `resolveSolvabilitySpec`（规则优先）。⚠️ 用例的夹具同步更新为新的服务端契约（`meta.solvability.grades`）——**改后仍判别**（修前前端忽略该字段 ⇒ 仍红），并另加一条源码钉（视图不得再出现「包投影 ?? 规则投影」）。<br>　② **F18（Critical）畸形百分号编码 ⇒ 整页白屏** —— `web/router.js` 的 `decodeURIComponent` 无 try/catch，而 `web/app.js` 的 `match()` 调用**在 try 块之外** ⇒ 异常冒到 hashchange 回调 ⇒ 连错误卡片都渲染不出来。修法与服务端 `src/http/router.js` **同一口径**：畸形编码视为「该路由不匹配」⇒ 渲染「页面不存在」卡片；并把 `match()` 挪进 `try` 块做纵深防御。<br>　③ **F14（High）A 队队长可汰换 B 队成员**、④ **F29（High）A 队队长可改名并改挂 B 队任务包**、⑤ **F41（Low）任意登录用户可读任意队名单** —— `team.js` 三处都用了带 scope 的 `can(..., 'team:manage'/'team:read')` ⇒ 队长/组员/观察员**三个角色全局持有**这两个能力点 ⇒ scope 形同虚设。⇒ 改为「本队队长（`teams.captain_id` 领域事实）/ 本队在册成员 / 组委会（身份）/ 该队作用域的资源级授权（`canScoped`）」。<br>　⑥ **F15（High）任意队可抢走他队任务** —— `claimTask` 只校验「你是不是某队成员」，**从不校验任务归属** ⇒ 现在按 `workflow_tasks.owner_team_id` 判（无归属队时按该工作流任务包的承接队判）。<br>　⑦ **F31（Medium）提交任务卡可冒用他人企业主体** —— `enterprise_id` 原来**照抄请求体** ⇒ 改为**由提交人自己决定**（企业席挂自己；企业管理员要求目标企业 `users.org` 与自己相同；组委会受信任；其余不挂），且 id 被改写时 name 一并改（避免「id 指 A、名字写 B」）。<br>　⑧ **F32（Medium）不传 `ownerTeamId` 就能往任意队的工作流注入任务** —— 原来 `if (ownerTeamId)` 才校验 ⇒ 不传就**完全跳过**；现在不传时也要求是该工作流（任务包）的承接队之一。<br>　⑨ **F34（Medium）`team_result` 申诉无归属校验** —— 现在要求申诉人是该队**队长或成员**（或组委会）；⛔ 归属校验**排在状态校验之前**，否则「对不存在的条目」会先撞 409，把**越权掩盖成状态错误**。<br>**⇒ 用例纪律**：修复过程中**既有测试被我的改法弄红过 2 次**（`admin-task-packages.test.js` 两条规格来源用例、`review-state.test.js` 九条申诉用例）⇒ 两次都**不是改测试去迁就实现**，而是回头发现**规则写错了**：前者是「投影不出完整档位就该降级」与「包投影必须可用」两个契约互斥 ⇒ 解法是服务端补投影（契约本身合理）；后者是我漏了「队长身份来自 `teams.captain_id`、与 `team_members` 有无行无关」。⇒ **两处既有测试最终都保持原样通过**。<br>**⇒ 计划块**：本轮改动的 3 个在计划块内的文件已**逐字回写归属阶段**（`src/services/team.js` + `src/services/taskPackage.js` → P1；`src/services/review-state.js` → P4）⇒ **C-RW 归零**（A 222 / B 8 / C-EXT 62 / C-RW 0 / D 0）。其余改动文件（`src/auth/permissions.js` / `src/services/workflow.js` / `src/services/taskPackage.js` 的服务层 / `src/services/review-state.js` 之外的那些 / `web/*`）**不在任何计划块内** ⇒ 按 P6 约定「记在本台账」。<br>**⇒ 进度**：47 条中已修 **9 条**（2 Critical + 5 越权 + 2 闸），剩 38 条。 |
| E168 | 🔒 **P13 第 2 批：5 条「假绿/说谎」类缺陷（F3 / F3b / F3c 闸静默不跑、F6 CI 只跑 1 道闸、F4 限频 profile 生产零引用）+ 一个必须记下来的设计冲突（提交锁的两种语义）** | **本批修掉的 5 条**：<br>　① **F3（High）`build-demo.js` 经软链调用静默不跑、退出 0**、② **F3b（High）`bash-var-scan.js` 同款**、③ **F3c（High）`temp-leak-scan.js` 在含空格路径下同款** —— 三个脚本都用**裸字符串**比主程序路径（`fileURLToPath(import.meta.url) === process.argv[1]` / `import.meta.url === \`file://${process.argv[1]}\``）⇒ 经**软链**调用时前者指向真实文件、后者是软链本身 ⇒ 恒不等；**含空格**路径时 `import.meta.url` 的空格被编码成 `%20` ⇒ 也恒不等 ⇒ 三个脚本**什么都不做、退出码 0** ⇒ CI 绿灯而闸门根本没跑。⚠️ `temp-leak-scan.js` 尤其危险：`deploy-demo-site.sh` 只查产物**存在** ⇒ **上周的旧演示站会被原样发布**。⇒ **修法**：三处统一换成 `realpathSync` 比较，**照抄同目录 `scripts/audit-scan.js` 早就修好的正范**（`realPathOrSelf` 兜底）⇒ 一次修好三个。<br>　④ **F6（Medium）CI 只跑了 1 道机器闸** —— `.github/workflows/ci.yml` 只调 `plan-block-audit.mjs`，另外 4 道（`audit-scan.js` / `temp-leak-scan.js` / `bash-var-scan.js` / `dead-service-scan.mjs`）**在仓库里存在且能跑、CI 里根本没引用**；而 README 明写 5 道 ⇒ **文档与 CI 不一致**。且 `RW` 提取写的是 `${RW:-0}` ⇒ grep 没匹配上时 `RW` 是空串、被当成 0 ⇒ **静默放行**。⇒ **修法**：① 新增 `release-gates` job 跑齐 4 道闸，**并跑在 `['22.16.0','22.x','24.x']` 三档**（理由与 E166 同源：闸脚本一旦在旧 Node 上「静默不跑、退出 0」，单档 CI 根本发现不了）；② 每道闸加两道护栏 —— 「退出码非 0 ⇒ 报错」+「**输出为空 ⇒ 报错**」（静默通过在 CI 眼里与通过完全一样）；③ `RW` 提取为空改为**报错**而不是按 0 放行。⚠️ **踩过的坑**：GitHub Actions 的默认 shell 是 `bash -eo pipefail` ⇒ 命令替换里 grep 没匹配上会**当场掐断整个步骤**，我最初写的 `if [ -z "$RW" ]` 友好分支**根本走不到** ⇒ 改成 `|| true` 吞掉 grep 的失败退出码后再判空；四道闸同理改成 `set +e` 先取退出码再判空。⇒ **实测**：用 `bash -eo pipefail` 逐条实跑 CI 的每个 `run:` 块 ⇒ 8/8 PASS；三条护栏分支的**负向**测试也逐条验证过（提取失败 ⇒ 退出码 1；输出为空 ⇒ 退出码 1；闸非 0 ⇒ 退出码 1）。<br>　⑤ **F4（High）`rules/audit.json` 里的 `reviewSubmit` / `judgeHourly` 两个限频 profile 生产代码零引用**（配置在说谎）⇒ **评审提交端点完全无限频**（审计实测：评委连打 40 次评分，状态直方图 `{ '200': 40 }`，**零 429**）；附带发现 **`POST /api/auth/login` 也完全无限频**（30 次错误口令全 401、零 429 ⇒ 可无限爆破口令）。⇒ **修法**：评审写入口按**评委 id 分 subject** 接上 `reviewSubmit` + `judgeHourly`；登录端点新增 `loginAttempt` profile（滑动窗口 10/60s + 每分钟 20），**只统计失败的尝试**（成功登录不消耗配额 —— 否则正常用户多设备/多标签页反复登录会被自己的配额误伤）。⚠️ 登录的 subject 用**手机号的 SHA-256 哈希**（限频表会进备份，明文手机号等于复制到第二张表）；⚠️ **已知缺口**：按 IP 限频挡不住「同一 IP 换账号喷」，那需要**可信的客户端 IP**，而 `ctx` 上没有（服务可能在 nginx 后，`x-forwarded-for` 由客户端伪造）⇒ 属部署形态问题，不在本批范围，台账在此备案。<br>**⇒ 本批最值得记下来的设计冲突（改法不是「挑一个对」，而是把两种语义都保留、由配置决定）**：直接按报告把 `reviewSubmit` 接上去 ⇒ **既有测试当场变红** —— `review-api.test.js` 的「⛔ 改分必须把旧分写进审计（事后能还原当时榜单）」失败，因为 `reviewSubmit` 的 `lock: { seconds: 5 }` 是**冷却锁**（拿到后 5 秒内谁都拿不到），而评委「改分」是**先后两次**提交（第一次 80 分、第二次改 85 分）⇒ 第二次被挡成 429 ⇒ **平台最核心的「改分必须留痕」契约直接失效**。⇒ 结论：**冷却锁对「申诉」是对的**（5 秒内重复申诉 = 刷申诉），**对「评分」是错的**（改分是正常业务动作）。⇒ **解法**：把锁的语义做成**配置项** `lock.mode`（`cooldown` 冷却 / `mutex` 互斥）：`reviewSubmit` 配 `mutex`（锁只在请求处理期间存在，请求结束即释放 ⇒ 挡「同时在跑」的两笔提交、挡不住「先后两次」；失败也释放 ⇒ 一次格式错误不会把评委锁死 5 秒；`lock.seconds` 退化为**进程崩溃时的 TTL 兜底**），`appealSubmit` 保持 `cooldown`（行为不变）。⇒ 实现上新增 `releaseLock`（`src/db/repo/rate-limit.js`）与 `checkRateLimit` 返回的 `release` 句柄（`src/services/rate-limit.js`），评分路由在 `finally` 里释放。⚠️ **`lock.mode` 是**配置**（`rules/audit.json`），不是代码里的硬编码** —— 并在 `validateRules` 里加了机器校验（`mode` 必须是 `cooldown` / `mutex`，否则**拒绝启动**）⇒ 「配置在说谎」的老毛病从根上堵住。<br>**⇒ 为什么必须整份规则升版（升版动作本身有代价，必须有理由）**：`rules/*.json` 的 `version` **16 份必须一致**（`validateRules` 强制），而 `version` **不是装饰** —— 它会写进 `computation_snapshots.rule_version`，并被 `recomputeAndDiff` 用来判定「**规则版本已变更**」⇒ **规则改了不升版 ⇒ 规则漂移永远检测不到**（旧榜单不会被打上「该重算了」的标记）。⇒ 所以 `rules/audit.json` 一改（新增 `loginAttempt` + `lock.mode`）⇒ **16 份统一从 `2026-10-20` 升到 `2026-10-23`**（本次审计成果的日期）。⇒ **代价**：14 个规则文件的计划块随之变「真重写」⇒ 全部用 `docs/tools/plan-block-sync.mjs` **逐字回写归属阶段**（P0×6 / P1×4 / P3×2 / P4×2 / P5×1），另加 `src/http/routes/review.js`（→P2）与 `src/services/rate-limit.js`（→P4）⇒ **16 个块全部同步** ⇒ **C-RW 归零**（A 219 \| B 9 \| C-EXT 64 \| **C-RW 0** \| D 0）。`src/server.js` / `src/config.js` 落在**良性扩展**（结构性追加，不断言）；`src/db/repo/rate-limit.js` / `src/http/routes/review.js` 之外的改动文件不在任何计划块内 ⇒ 按 P6 约定记在本台账。<br>**⇒ 用例纪律（本批新增 2 条运行时用例 + 变异检验 3/3 杀死）**：静态引用检查（`audit.json` 的每个 profile 都必须有生产调用方）**只能证明「配置不再说谎」，证明不了「限频真的生效」** ⇒ 补两条**真实请求**的判别性用例：① 评委连打 `sliding.max + 5` 次评分 ⇒ 必须出现 429、第 `max+1` 次必须是 429、错误码 `RATE_LIMITED`、**必须带 `Retry-After` 头**；② 连续错误口令 ⇒ 必须出现 429，且**先跑正对照**（连续 `max+3` 次**正确**登录必须全 200 —— 成功不消耗配额）。⇒ **变异检验**：临时撤掉评分端点的接线 ⇒ 用例红（输出 `200,200,…` 25 连）；临时撤掉登录端点的接线 ⇒ 用例红（输出 `401,401,…` 15 连）—— 与审计原始观测逐字吻合；把 `lock.mode` 从 `mutex` 改成 `cooldown` ⇒ **既有**的改分留痕用例红 ⇒ 三处修复**全部有判别力，不是恒绿**。⚠️ 另有一处**我自己的正对照写错了**：初版写成「换个赛段必须照常提交」⇒ 红 ⇒ 查因是滑动窗口**按评委**计（审计的修法原文就是「按评委 id 分 subject」）⇒ 正对照改成「**另一个评委**必须照常提交」（这才真正检验 subject 维度接对了没）。<br>**⇒ 进度**：47 条中已修 **14 条**（2 Critical + 5 越权 + 2 闸 + **5 条本批**：F3 / F3b / F3c / F4 / F6），剩 **33 条**；全量 **1991 例 / 1974 通过 / 16 失败 / 1 跳过**（16 条失败 = 下一批及以后批次的靶子）。 |
| E169 | 🔒 **P13 第 3 批：3 条「单写者约束形同虚设」类缺陷（F5 起第二个实例不被拒 / F5b 恢复闸 fail-open / F13 启动失败留下陈旧 pid）+ 一个必须想清楚才能修对的设计问题（怎么分辨「服务停了」与「pid 文件没了」）** | **本批修掉的 3 条（全是 High）**：<br>　① **F5 单写者约束无任何强制** —— `src/server.js` 在 listen **之前**无条件 `writePidFile(dataDir)`、而且**从不检查**是否已有实例 ⇒ 同一个 `DATA_DIR` 可以**同时起两个服务、两个都启动成功**（实测两个进程都活着）⇒ 而 F8 已证明这种双写会直接撞出 `SQLITE_BUSY` / 517。⇒ **修法**：启动最前面（**开库之前** —— 库一打开就可能与对方抢写锁）加单写者闸：读 pid 文件 → `isProcessAlive(pid)` 为真 ⇒ **拒绝启动 + 人话报错 + 退出码 1**。⚠️ pid 指向**已死**进程 ⇒ 判为上次崩溃的残留 ⇒ **允许接管**（不允许接管 ⇒ 崩一次就再也起不来，运维得手工删 pid 才能重启）。<br>　② **F13 启动失败留下陈旧 pid 文件** —— 写 pid 在 listen 之前 ⇒ 实例 B 因端口被占而启动失败时，**已经把 pid 文件覆盖成自己的 pid** ⇒ 指向一个**已死进程** ⇒ 恢复闸误判「服务没在跑」。⇒ **修法**：`writePidFile`（与新增的 `writePortFile`）**挪到 listen 成功之后**；并给 server 加 `'error'` 处理器（端口被占等启动期错误要**人话报错 + 退出码 1**，而不是一坨未捕获异常栈）。<br>　③ **F5b 恢复闸在服务活着时误判「没在跑」** —— `scripts/restore.js` 的 `checkServiceState()` 在「pid 文件不存在」时 **fail-open**（当成「没在跑」）⇒ 允许**在活跃写入时**执行恢复（恢复会替换掉正在被写的库文件 ⇒ 丢数据 / 库损坏）。<br>　**⇒ 本批最值得记下来的设计问题（不是「改一行就绿」）**：光看 pid 文件**分不清**这两种情况 ——<br>　· 「服务确实停了」：**正常退出时 server.js 会删掉 pid 文件** ⇒ 停服后就是「没有 pid 文件」；<br>　· 「服务还在跑、只是 pid 文件没了」（被误删 / 被第二个实例覆盖）⇒ **也是「没有 pid 文件」**。<br>　⇒ 两种情况下恢复的后果完全相反（前者该做，后者会毁库），而 pid 文件这个证据**在两种情况下都拿不到** ⇒ 所以**不能**简单地「pid 文件缺失 ⇒ fail closed」（那会让「停服 → 恢复」这个**最正常**的流程永远需要 `--force`）。⇒ **解法：必须主动探测服务本身**。<br>　⇒ 落地：① 服务器在 listen 成功后**额外登记实际监听端口**到新文件 `app.port`（`PORT=0` 时记的是内核分配的端口，不是 0）；② 新增 `src/runtime/service-probe.js`：**同步**探测 `http://127.0.0.1:<端口>/api/health` 是否返回 `{ok:true}`（同步是必须的：`restore.js` 及其调用方、既有回归用例全是同步的；Node 没有同步 HTTP 客户端 ⇒ 用「起一个子进程跑一次 fetch」实现，零第三方依赖、跨平台、~40ms）；③ `checkServiceState` 在「pid 文件缺失」或「pid 指向已死进程」时**都**先探测 ⇒ 服务有应答 ⇒ **fail closed**（判为还在跑）；无应答 ⇒ 才可能安全恢复。⚠️ 探测的是 `/api/health` 而不是「端口能不能连上」—— 连得上只能证明「那儿有个东西」，不能证明「那是本平台的服务」。<br>　**⇒ 我自己踩的两个坑（都被既有测试当场抓住）**：<br>　· **判据写错**：我把「pid 文件存在但内容无法解析 ⇒ fail closed」这条的判据写成 `existsSync(pidFile)`，而正确判据是「**读不出合法 pid**」（`!pid`）—— 文件存在但内容合法、只是进程已退出 ⇒ 那是**陈旧残留**，被我这条误伤成「还在跑」⇒ `test/restore.test.js` 的既有用例「pid 文件指向已退出的进程时视为「服务未在跑」」当场变红 ⇒ 改回 `!pid && existsSync(...)`。⇒ **既有测试确实在替生产代码兜底**。<br>　· **变异存活**：把「写 pid 挪回 listen 之前」这个变异注入进去，F13 用例**居然全绿** —— 因为同 `DATA_DIR` 的实例 B 现在被**单写者闸**提前拦掉 ⇒ 根本走不到「写 pid → 绑定失败」那段 ⇒ 该用例已**不再判别**。⇒ 按纪律补场景：另起一个**不同 DATA_DIR、同一端口**的实例 C（能通过单写者闸 ⇒ 真的走到 listen ⇒ 绑定失败）⇒ 断言它**没留下 pid 文件**、且报错是人话 ⇒ 变异随即被杀死（**没有改任何生产代码来迁就测试**）。<br>　**⇒ 变异检验 3/3 全部被杀**：① 去掉单写者闸 ⇒ F5 红；② 探测恒判「没在跑」（fail-open）⇒ F5b 红；③ 写 pid 挪回 listen 之前 ⇒ F13 红。<br>　**⇒ 计划块**：3 个漂移块已**逐字回写归属阶段**（`src/server.js` → P0；`scripts/restore.js` + `src/runtime/pidfile.js` → P6）⇒ **C-RW 归零**（A 220 | B 9 | C-EXT 63 | **C-RW 0** | D 0）。新增文件 `src/runtime/service-probe.js` **不在任何计划块内** ⇒ 按 P6 约定记在本台账。<br>　**⇒ 进度**：47 条中已修 **17 条**（2 Critical + 5 越权 + 2 闸 + 5 条假绿/说谎 + **3 条本批**），剩 **30 条**；全量 **1993 例 / 1979 通过 / 13 失败 / 1 跳过**。 |
---

*配套：[`superpowers/specs/2026-10-20-heikesong-platform-design.md`](superpowers/specs/2026-10-20-heikesong-platform-design.md)｜[`requirements-traceability.md`](requirements-traceability.md)｜[`rule-decisions.md`](rule-decisions.md)｜[``]()*

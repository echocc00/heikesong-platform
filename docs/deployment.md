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

---

*配套：[`superpowers/specs/2026-10-20-heikesong-platform-design.md`](superpowers/specs/2026-10-20-heikesong-platform-design.md)｜[`requirements-traceability.md`](requirements-traceability.md)｜[`rule-decisions.md`](rule-decisions.md)｜[``]()*

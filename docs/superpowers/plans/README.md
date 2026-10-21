# 实施计划索引 · AI 商业黑客松赛事平台

> **执行前置**：阅读 [`../specs/2026-10-20-heikesong-platform-design.md`](../specs/2026-10-20-heikesong-platform-design.md)（设计文档）、
> [`../requirements-traceability.md`](../requirements-traceability.md)（96 条需求溯源）、
> [`../rule-decisions.md`](../rule-decisions.md)（6 条规则冲突裁决）、
> [`../`](../)（待组委会确认 17 条）。
>
> **⛔ 跨阶段接口以 [`INTERFACES.md`](INTERFACES.md) 为唯一事实来源**。各计划里出现的签名、表结构、API 路径、规则文件名与它冲突时以它为准。
> 其中 **§9 文件归属裁决表** 规定了每个文件与每张表的**唯一写入权**——七份计划并行写完后，这里出了 5 处文件归属冲突、1 处建表撞车、1 处错误模块参数顺序相反，全部按该表裁决。

## 计划清单

| 计划 | 阶段 | 交付物 | 依赖 | 计划文件 | 规模 |
|---|---|---|---|---|---|
| 1 | **P0 地基** | 能登录的空系统；配置改错则启动失败；权限骨架 | — | `2026-10-20-platform-P0-foundation.md` | 7 Task / 8765 行 |
| 2 | **P1 报名与组队** | 报名→自动分级→组队→任务包认领 全链路 | P0 | `2026-10-20-platform-P1-registration-team.md` | 7 Task / 7464 行 |
| 3 | **P2 评审引擎** | 能真实算分（z-score + 去极值 + 双签 + 回避 + 自评检测） | P1 | `2026-10-20-platform-P2-review-engine.md` | 10 Task / 10744 行 |
| 4 | **P3 榜单与积分** | 能真实发榜（A/B/个人榜 + 段位 + 行为分隔离 + 战绩卡） | P2 | `2026-10-20-platform-P3-leaderboard-points.md` | 8 Task / 6478 行 |
| 5 | **P4 审计与防作弊** | 榜单可复算（trace 抽屉 + 复算 diff）+ 限频 + 复核状态机 | P3 | `2026-10-20-platform-P4-audit-anticheat.md` | 8 Task / 8815 行 |
| 6 | **P5 工作流与三池** | 任务清单与领取；三池底座接口；公开榜单 API + iCal + 任务清单页 | P4 | `2026-10-20-platform-P5-workflow-pools.md` | 6 Task / 8707 行 |
| 7 | **P6 部署与演示版** | 云主机部署资产 + 公网演示 URL + 端到端/跨平台验收 | P5 | `2026-10-20-platform-P6-deploy-demo.md` | 8 Task / 10485 行 |

合计 **54 个 Task**、**61458 行**计划文档。

> 规模数字是**实施后**的实况（每份计划末尾都追加了父代理预审 / 修复轮 / 实施台账章节，所以比撰写期大）。
> 复算：`wc -l docs/superpowers/plans/2026-10-20-platform-P*.md`。
>
> **实施状态**：P0–P6 的 **54 个 Task 全部落地并合回 main**（计划块漂移已归零，见
> [`../../docs/tools/plan-block-audit.mjs`](../../docs/tools/plan-block-audit.mjs) 可复算）；
> **只差公网发布**这一步（需云主机 + 用户明确确认）。

**需求覆盖：96 条里 95 条已落地且能从代码反查** —— 逐条的「落在哪 / 怎么验」见
[`../requirement-implementation-map.md`](../requirement-implementation-map.md)（**机器生成**，
生成器 [`../tools/requirement-map.py`](../tools/requirement-map.py) 可复算；另有
[`../requirements-traceability.md`](../requirements-traceability.md) 记「它从哪来」）。
剩下 1 条：

| 需求 | 状态 | 说明 |
|---|---|---|
| R-PTS-13 押金是负债不入营收 | ⚪ **平台不实现** | **财务科目口径**而非平台功能，且「中途不退部分去向」本身是规则空白。已在 `docs/requirements-traceability.md` 里显式声明**平台不实现**，并禁止任何人往平台里加「报名费 / 押金」字段或退费流程。**对空白规则写代码 = 凭空造规则**，所以这里留的是边界声明，不是待办 |

> ⚠️ **R-OPS-06（公网可访问）现在标的是「已落地」**：代码与部署资产都已就位
> （演示站构建、nginx + systemd 部署资产、备份恢复、运维手册），
> 但**发布到公网这一步还没做** —— 它需要云主机 + 用户明确确认。
> 「代码就位」与「已上线」是两件事，这里只如实记前者。

另有两个需求**只占位不启用**（代码路径存在但恒不生效，等组委会拍板口径）：

| 需求 | 占位位置 | 为什么先不启用 |
|---|---|---|
| R-OPS-11 Demo Day 观众投票权重 | `rules/points.json` 的 `demoDayAudienceVote` | S7 §3.1 的总分公式**没有**观众票这一项。权重取多少、观众票是否进 A 榜，目前**无规则依据**——凭空加一条影响奖金的规则比不做更危险 |
| R-OPS-12 奖项结构 资源≈现金 1:1.55 | `rules/points.json` 的 `prizeStructure` | 配比口径有依据，但**具体金额**未定（首届奖金总额待组委会拍板）。只存配比，金额由调用方传入 |

## 执行顺序与并行度

```
P0 ──→ P1 ──→ P2 ──→ P3 ──→ P4 ──→ P5 ──→ P6
                              ↑
                     （演示版可在 P3 完成后提前发布）
```

**严格串行**，因为每阶段都消费上一阶段的接口（`INTERFACES.md` 写明了具体签名）。

## 全局约束（所有计划共享，逐字复制）

```
运行时      Node ≥ 22.16.0（生产建议 24；不使用任何 Node-24-only API）
            ⚠️ 下限是「node:sqlite 免 --experimental-sqlite 的 22.13.0」与
               「sqlite.backup() 的 22.16.0」的并集 —— 声明一个跑不起来的
               版本比声明一个略严的版本更糟。出处见设计文档 §4.2。
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite（内置，无原生编译）。单文件 data/app.db，WAL 模式
测试        node:test（内置）。命令：node --test
            ⚠️ node:sqlite 在 Node 22 仍会打 ExperimentalWarning（实验特性提示）。
               npm scripts 里已统一加 --disable-warning=ExperimentalWarning，输出保持干净。
               直接 `node xxx.js` 仍会打印这一行——只影响观感，不影响功能。
            ⚠️ 不要写成 `node --test test/`：Node 22 的位置参数按 glob/模块路径处理，
               目录【不会】被展开 → MODULE_NOT_FOUND，pass 0 / fail 1。
               实测（Node v22.23.2）：`node --test` ✅ ｜ `node --test test/` ❌ ｜
               `node --test test/xxx.test.js` ✅（单文件形式合法）
               依据：设计文档 §4.3 的 package.json 片段本身就是 `"test":"node --test"`。
密码        node:crypto scrypt，格式 scrypt$N$r$p$salt$hash
会话        服务端 session 表，token 只存 SHA-256 哈希；Cookie HttpOnly+SameSite=Lax
实时        SSE（text/event-stream），不用 WebSocket
代码目录    platform/
规则配置    platform/rules/*.json —— 一切可变规则只改 JSON，不改代码
配置校验    加载时 fail-fast：权重合计≠100% / 阈值不单调 / 段位门槛不递增 → 拒绝启动
分轨强制    总分函数签名中不存在行为分参数；单元测试断言"行为分变化不影响总分"
签字分表    enterprise_confirmations（主观评分，进总分）≠ milestone_signoffs（客观事实，不进总分）
可见性      在 API 层过滤，前端不得隐藏（隐藏即泄露）
SQL 边界    所有 SQL 收进 src/db/repo/；handler 内禁止裸 SQL
权限模型    capability + assignment；判定只有一个入口 can(user, capability, ctx)
三态状态码  列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403
单写者      ⛔ 禁止多 Node worker 进程同时写同一 SQLite 文件
规则溯源    每条规则在代码注释里写明来源文档与章节（如 // S7 §3.1）
禁用清单    platform/scripts/forbidden.txt 不得为空；发布前跑 scripts/audit-scan.js
领域层      src/domain/* 是纯函数：无 IO、无 Date.now()、无 Math.random()
            ⛔ 不得 import 任何 Node 内置模块（P6 的演示版要在浏览器里跑同一套引擎）
```

## 目录结构（各计划共同遵守，P0 建立，后续只增不改）

```
platform/
├── package.json            scripts: start / test / migrate / seed / backup / restore
│                           / build:demo / serve:demo / audit / audit:temp（十个都带
│                           --disable-warning=ExperimentalWarning）
├── rules/                  16 份声明式规则配置（各阶段追加自己的）
├── src/
│   ├── server.js           进程入口
│   ├── config.js           配置加载 + fail-fast 校验
│   ├── errors.js           AppError（status-first，全项目唯一错误类型）
│   ├── http/               router respond body static sse
│   ├── auth/               password session permissions
│   ├── db/                 sqlite migrate tx + repo/
│   ├── domain/             23 个纯函数模块（scoring ranking points visibility registration
│   │                       solvability tier behavior normalization trim enterprise-seat
│   │                       icalendar …）
│   ├── services/           19 个服务层模块（registration team review leaderboard milestone
│   │                       workflow pools compute audit …）
│   ├── audit/              log snapshot
│   └── runtime/            pidfile
├── web/                    index.html app router store api api.demo styles.css views/
│                           views/ 含 tasks.js（任务清单页，P5 Task 6）
├── db/migrations/          001_init.sql 002_registration.sql 003_review.sql
│                           004_leaderboard.sql 005_audit.sql 006_pools.sql
├── test/                   76 个 *.test.js
├── test-helpers/           共享测试工具：http-call（进程内 HTTP 调用器）
│                           strip-comments（剥注释）db-worker（子进程 DB）
│                           tmp（**本进程临时目录隔离 + 退出回收**，防临时目录泄漏）
├── scripts/                migrate seed backup restore audit-scan forbidden.txt
│                           build-demo.js serve-demo.js node-globals.txt
│                           temp-leak-scan.js（**临时目录泄漏闸**）
└── deploy/                 heikesong.service nginx.conf nginx-http2-compat.sh
                            docker-compose.yml install.sh
```

> 目录结构是**实施后**的实况。
> `web/dist/` 是 **P6 Task 6 的构建产物目录**（**不入库**，已 gitignore），
> 由 `scripts/build-demo.js` 生成、`scripts/serve-demo.js` 本地预览；
> `scripts/node-globals.txt` 是**领域层「Node 专属全局」禁用清单**（数据文件，理由见 P6 计划「演示版守卫修复轮」A-1）。

## 迁移版本号是全局唯一序位

```
001 P0  002 P1  003 P2  004 P3  005 P4  006 P5
```

⚠️ 两个迁移抢同一个版本号时，`applyMigrations` 按 version 去重，**后执行的那张表永远建不出来**。
P0 曾建 `002_user_roles.sql` 与 P1 的 `002_registration.sql` 撞号，已改为把 `user_roles` 并入 P0 的 `001_init.sql`。

**每个阶段开工前自检**：

```bash
cd platform/db/migrations && ls -1 *.sql | cut -d_ -f1 | sort | uniq -d   # 期望：空
```

## 提交规范

每个 Task 结束时提交一次，消息格式：

```
feat(P<n>): <动词短语>

<说明这个 Task 交付了什么、对应哪条需求 ID>
```

**不要**在一个 Task 里混做两个阶段的事。Task 是最小可独立评审单元。

## 实施期的机器闸（全部可复算）

实施期不靠「自觉」，靠这几个可重跑的脚本：

```bash
# ① 全量测试（唯一命令形态：无参、cwd 发现）
cd platform && node --disable-warning=ExperimentalWarning --test

# ② 禁用表述扫描闸（发布前必过；发布产物 web/dist 本身也过）
cd platform && node scripts/audit-scan.js ; echo "退出码=$?"

# ③ 计划块漂移审计：代码块 = 该文件「当前实现」的逐字副本
#    A=逐字一致 / C-EXT=良性扩展(记一句) / C-RW=真重写(必须同步) / D=无实现
node docs/tools/plan-block-audit.mjs platform

# ④ 计划块同步（定位与 --verify 同源，比外部脚本可靠）
node docs/tools/plan-block-sync.mjs <plan> platform <文件...>
node docs/tools/plan-block-sync.mjs --verify <plan> platform <文件...>

# ⑤ 需求落地表重生成（96 条逐条「落在哪 / 怎么验」）
python3 docs/tools/requirement-map.py --trees . --out docs/requirement-implementation-map.md

# ⑥ 临时目录泄漏闸（防测试把服务器磁盘吃满）
#    R1 用到 tmpdir() 的测试文件必须 import test-helpers/tmp.js 并调用 isolateTempDir()
#    R2 isolateTempDir() 必须早于第一处 tmpdir()
#    --run 追加动态差分：跑完全量后临时目录里有新残留 ⇒ 判违规
cd platform && node scripts/temp-leak-scan.js ; echo "退出码=$?"
```

> **计划块漂移的口径**（本轮统一确立）：后续阶段按「最早建立者 owns、后续 Modify 追加不得重建」
> 改了实现，owning 阶段的计划块就会漂移。
> **真重写（C-RW）⇒ 必须逐字同步回 owning 阶段计划**；**良性扩展（C-EXT）⇒ 计划块保持原样，只在台账记一句**。
> 当前状态：**C-RW 0 条**。

## 计划撰写期的验证记录

七份计划不是"写完就交"，各自做了可执行性验证（下面是**撰写期**的记录）：

| 计划 | 验证动作 | 结果 |
|---|---|---|
| P1 | code fence 配平、需求 ID 逐个 grep 计数、7 个 Task 步骤编号连续 | 21 条需求全覆盖；自查修掉 3 处执行期会炸的问题 |
| P2 | 把 P0 基座 + P2 全部文件在 `/tmp` 重建成可运行工程并实跑 | **72/72 测试通过**；跑出 4 个真 bug（批量 `request_id` 与唯一索引冲突 / trace 的 `raw` 误填成 z 均值 / 自评检测被条件误挡 / 席位权重串位），已全部修掉 |
| P3 | 6 个领域模块抽出实跑断言套件；`004_leaderboard.sql` 在 SQLite 实跑建表 | 全部通过；跑出并修正 1 个真错误（1224 用例原用不同互评分，会在破同分链第 3 级被提前分开，名次成了 1,2 而不是 1,1） |
| P4 | 33 个 JS 代码块 `node --check`；扫描闸用故意写错的文本试跑 | 0 语法错误；自查修掉 4 处算术/契约问题（限频提交锁与滑动窗口互相干扰 / 限频桶 key 硬编码 epoch / 留档窗口天数算错 / 测试配额 profile 多带锁层） |
| P5 | 迁移 + 种子逐字抽出在内存 SQLite 建库，6 个种子块全插成功；34 条 SQL 全部 `EXPLAIN` 通过 | 通过；按上游真实 DDL 修正 3 处会违反外键/唯一索引的种子 |
| P6 | 23 个 JS 块 `node --check` + 全部 JSON 可解析 + 18 个 bash 块 `bash -n`；**实跑**备份/恢复脚本 | 22/23 通过（唯一失败是有意的就地替换片段）；备份恢复 **8/8 测试通过**，跑出并修掉 2 个真 bug |

**跨计划一致性校验**（七份齐备后统一执行）：

- ✅ 迁移编号 001–006 一一对应，无抢号
- ✅ 同一文件被两个阶段声明 `Create`：**已从 5 处降到 0**
- ✅ 同一张表被两个迁移 `CREATE TABLE`：**已从 1 处降到 0**（`tiebreak_round` / `tiebreak_votes` 归 P2）
- ✅ 错误模块两套参数顺序相反：**已统一为 status-first**（`src/errors.js`，P1 拥有）
- ✅ API 路径逐条对齐契约；各计划新增的端点（`GET /api/registration-criteria`、`GET /api/teams`、`GET /api/leaderboard/tier`、`POST /api/tasks/:id/complete`、`POST /api/stages/:stageId/enterprise-confirmations` 等）**全部登记在各自计划的「与接口契约的偏差」章节**

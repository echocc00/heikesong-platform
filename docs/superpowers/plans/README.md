# 实施计划索引 · AI 商业黑客松赛事平台

> **执行前置**：阅读 [`../specs/2026-10-20-heikesong-platform-design.md`](../specs/2026-10-20-heikesong-platform-design.md)（设计文档）、
> [`../requirements-traceability.md`](../requirements-traceability.md)（96 条需求溯源）、
> [`../rule-decisions.md`](../rule-decisions.md)（6 条规则冲突裁决）、
> [`../`](../)（待组委会确认 17 条）。
>
> **⛔ 跨阶段接口以 [`INTERFACES.md`](INTERFACES.md) 为唯一事实来源**。各计划里出现的签名、表结构、API 路径、规则文件名与它冲突时以它为准。
> 其中 **§9 文件归属裁决表** 规定了每个文件与每张表的**唯一写入权**——六份计划并行写完后，这里出了 5 处文件归属冲突、1 处建表撞车、1 处错误模块参数顺序相反，全部按该表裁决。

## 计划清单

| 计划 | 阶段 | 交付物 | 依赖 | 计划文件 | 规模 |
|---|---|---|---|---|---|
| 1 | **P0 地基** | 能登录的空系统；配置改错则启动失败；权限骨架 | — | `2026-10-20-platform-P0-foundation.md` | 7 Task / 2388 行 |
| 2 | **P1 报名与组队** | 报名→自动分级→组队→任务包认领 全链路 | P0 | `2026-10-20-platform-P1-registration-team.md` | 7 Task / 4456 行 |
| 3 | **P2 评审引擎** | 能真实算分（z-score + 去极值 + 双签 + 回避 + 自评检测） | P1 | `2026-10-20-platform-P2-review-engine.md` | 8 Task / 4214 行 |
| 4 | **P3 榜单与积分** | 能真实发榜（A/B/个人榜 + 段位 + 行为分隔离 + 战绩卡） | P2 | `2026-10-20-platform-P3-leaderboard-points.md` | 8 Task / 3171 行 |
| 5 | **P4 审计与防作弊** | 榜单可复算（trace 抽屉 + 复算 diff）+ 限频 + 复核状态机 | P3 | `2026-10-20-platform-P4-audit-anticheat.md` | 8 Task / 4807 行 |
| 6 | **P5 工作流与三池** | 任务清单与领取；三池底座接口；公开榜单 API + iCal | P4 | `2026-10-20-platform-P5-workflow-pools.md` | 6 Task / 3812 行 |
| 7 | **P6 部署与演示版** | 云主机部署资产 + 公网演示 URL | P5 | `2026-10-20-platform-P6-deploy-demo.md` | 8 Task / 3948 行 |

合计 **52 个 Task**、**26 796 行**计划文档。

**需求覆盖：96 条中 95 条有明确落地位置**（每条在对应计划的代码注释、规则文件或偏差表里标注了来源章节）。
唯一未落地的是 **R-PTS-13（押金是负债不入营收）**——这是**财务科目口径**而非平台功能，且"中途不退部分去向"本身是规则空白。已在 `docs/requirements-traceability.md` 里显式声明**平台不实现**，并禁止任何人往平台里加"报名费/押金"字段或退费流程。**对空白规则写代码 = 凭空造规则**，所以这里留的是边界声明，不是待办。

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
运行时      Node ≥ 22.5（生产建议 24；不使用任何 Node-24-only API）
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite（内置，无原生编译）。单文件 data/app.db，WAL 模式
测试        node:test（内置）。命令：node --test test/
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
├── package.json            scripts: start / test / migrate / seed / backup / audit
├── rules/                  9 份声明式规则配置（P1–P5 各追加自己的）
├── src/
│   ├── server.js           进程入口
│   ├── config.js           配置加载 + fail-fast 校验
│   ├── http/               router respond body static sse
│   ├── auth/               password session permissions
│   ├── db/                 sqlite migrate + repo/
│   ├── domain/             scoring ranking points visibility registration solvability（纯函数）
│   ├── services/           registration team review leaderboard enterprise workflow
│   └── audit/              log snapshot
├── web/                    index.html app router store api api.demo styles.css views/
├── db/migrations/          001_init.sql 002_registration.sql 003_review.sql
│                           004_leaderboard.sql 005_audit.sql 006_pools.sql
├── test/                   *.test.js
├── scripts/                migrate seed backup audit-scan forbidden.txt
└── deploy/                 heikesong.service nginx.conf docker-compose.yml install.sh
```

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

## 计划撰写期的验证记录

六份计划不是"写完就交"，各自做了可执行性验证：

| 计划 | 验证动作 | 结果 |
|---|---|---|
| P1 | code fence 配平、需求 ID 逐个 grep 计数、7 个 Task 步骤编号连续 | 21 条需求全覆盖；自查修掉 3 处执行期会炸的问题 |
| P2 | 把 P0 基座 + P2 全部文件在 `/tmp` 重建成可运行工程并实跑 | **72/72 测试通过**；跑出 4 个真 bug（批量 `request_id` 与唯一索引冲突 / trace 的 `raw` 误填成 z 均值 / 自评检测被条件误挡 / 席位权重串位），已全部修掉 |
| P3 | 6 个领域模块抽出实跑断言套件；`004_leaderboard.sql` 在 SQLite 实跑建表 | 全部通过；跑出并修正 1 个真错误（1224 用例原用不同互评分，会在破同分链第 3 级被提前分开，名次成了 1,2 而不是 1,1） |
| P4 | 33 个 JS 代码块 `node --check`；扫描闸用故意写错的文本试跑 | 0 语法错误；自查修掉 4 处算术/契约问题（限频提交锁与滑动窗口互相干扰 / 限频桶 key 硬编码 epoch / 留档窗口天数算错 / 测试配额 profile 多带锁层） |
| P5 | 迁移 + 种子逐字抽出在内存 SQLite 建库，6 个种子块全插成功；34 条 SQL 全部 `EXPLAIN` 通过 | 通过；按上游真实 DDL 修正 3 处会违反外键/唯一索引的种子 |
| P6 | 23 个 JS 块 `node --check` + 全部 JSON 可解析 + 18 个 bash 块 `bash -n`；**实跑**备份/恢复脚本 | 22/23 通过（唯一失败是有意的就地替换片段）；备份恢复 **8/8 测试通过**，跑出并修掉 2 个真 bug |

**跨计划一致性校验**（六份齐备后统一执行）：

- ✅ 迁移编号 001–006 一一对应，无抢号
- ✅ 同一文件被两个阶段声明 `Create`：**已从 5 处降到 0**
- ✅ 同一张表被两个迁移 `CREATE TABLE`：**已从 1 处降到 0**（`tiebreak_round` / `tiebreak_votes` 归 P2）
- ✅ 错误模块两套参数顺序相反：**已统一为 status-first**（`src/errors.js`，P1 拥有）
- ✅ API 路径逐条对齐契约；各计划新增的端点（`GET /api/registration-criteria`、`GET /api/teams`、`GET /api/leaderboard/tier`、`POST /api/tasks/:id/complete`、`POST /api/stages/:stageId/enterprise-confirmations` 等）**全部登记在各自计划的「与接口契约的偏差」章节**

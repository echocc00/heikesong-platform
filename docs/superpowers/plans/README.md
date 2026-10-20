# 实施计划索引 · AI 商业黑客松赛事平台

> **执行前置**：阅读 [`../specs/2026-10-20-heikesong-platform-design.md`](../specs/2026-10-20-heikesong-platform-design.md)（设计文档）、
> [`../requirements-traceability.md`](../requirements-traceability.md)（96 条需求溯源）、
> [`../rule-decisions.md`](../rule-decisions.md)（6 条规则冲突裁决）、
> [`../`](../)（待组委会确认 17 条）。

## 计划清单

| 计划 | 阶段 | 交付物 | 依赖 | 计划文件 |
|---|---|---|---|---|
| 1 | **P0 地基** | 能登录的空系统；配置改错则启动失败；权限骨架 | — | `2026-10-20-platform-P0-foundation.md` |
| 2 | **P1 报名与组队** | 报名→自动分级→组队→任务包认领 全链路 | P0 | `2026-10-20-platform-P1-registration-team.md` |
| 3 | **P2 评审引擎** | 能真实算分（z-score + 去极值 + 双签 + 回避 + 自评检测） | P1 | `2026-10-20-platform-P2-review-engine.md` |
| 4 | **P3 榜单与积分** | 能真实发榜（A/B/个人榜 + 段位 + 行为分隔离 + 战绩卡） | P2 | `2026-10-20-platform-P3-leaderboard-points.md` |
| 5 | **P4 审计与防作弊** | 榜单可复算（trace 抽屉 + 复算 diff）+ 限频 + 复核状态机 | P3 | `2026-10-20-platform-P4-audit-anticheat.md` |
| 6 | **P5 工作流与三池** | 任务清单与领取；三池底座接口；公开榜单 API + iCal | P4 | `2026-10-20-platform-P5-workflow-pools.md` |
| 7 | **P6 部署与演示版** | 云主机部署资产 + 公网演示 URL | P5 | `2026-10-20-platform-P6-deploy-demo.md` |

## 执行顺序与并行度

```
P0 ──→ P1 ──→ P2 ──→ P3 ──→ P4 ──→ P5 ──→ P6
                              ↑
                     （演示版可在 P3 完成后提前发布）
```

**严格串行**，因为每阶段都消费上一阶段的接口（`Interfaces` 块写明了具体签名）。

## 全局约束（所有计划共享，逐字复制）

```
运行时      Node ≥ 22.5（生产建议 Node 24；不使用任何 Node-24-only API）
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
可见性      在 API 层过滤，前端拿不到无权数据；前端隐藏 = 数据已泄露
SQL 边界    所有 SQL 收进 src/db/repo/；handler 内禁止裸 SQL
权限模型    capability + assignment；判定只有一个入口 can(user, capability, ctx)
三态状态码  列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403
单写者      ⛔ 禁止多 Node worker 进程同时写同一 SQLite 文件
规则溯源    每条规则在代码注释里写明来源文档与章节（如 // S7 §3.1）
禁用清单    platform/scripts/forbidden.txt 不得为空；发布前跑 scripts/audit-scan.js
```

## 目录结构（各计划共同遵守，P0 建立，后续只增不改）

```
platform/
├── package.json            scripts: start / test / migrate / seed / backup / audit
├── rules/                  9 份声明式规则配置
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
├── db/migrations/          001_init.sql ...
├── test/                   *.test.js
├── scripts/                migrate seed backup audit-scan forbidden.txt
└── deploy/                 heikesong.service nginx.conf docker-compose.yml install.sh
```

## 提交规范

每个 Task 结束时提交一次，消息格式：

```
feat(P<n>): <动词短语>

<说明这个 Task 交付了什么、对应哪条需求 ID>
```

**不要**在一个 Task 里混做两个阶段的事。Task 是最小可独立评审单元。

# 需求落地对照表 · 96 条需求「落在哪、怎么验」

> **本表回答的是三个问题里的第三个：最后怎么落地。**
> - 「它从哪来」→ [`docs/requirements-traceability.md`](requirements-traceability.md)（源文档 + 定位 + 原文要点 + 状态）
> - 「它凭什么这么定」→ 各阶段计划文档的**缺陷台账**（每条实现的偏离、实证与取舍都有记录）
> - 「它最后落在哪、怎么验」→ **本表**

## 分母声明

需求全集 = **96 条**（逐行解析 `requirements-traceability.md` 的表格，**不是估算**）。
独立源数 = 6 份一手文档（任务书 2.0 + S7 + S10 + SABC + 顶层文档 + 项目自身复盘），
**同属一个作者体系，不构成多方独立互证** —— 详见溯源表的同段声明。

## 证据口径（本表的每一格都不是手写的）

| 列 | 怎么来的 | 可复核 |
|---|---|---|
| **落地** | 扫实现文件里的**溯源注释**（`R-XXX-NN` 字样）⇒ 该文件承载这条需求；再用 7 份计划的 `**Files:**` 段把文件归到阶段与 Task。⚠️ 溯源引用有**紧凑式**（`R-PTS-01/02/03/04/05/06`、`R-RNK-01/02/03/04`），匹配时必须**展开**，否则紧凑式后面的编号会被整段丢掉、需求被误判成「无溯源注释」 | `grep -rn "R-XXX-NN" platform/` |
| **怎么验** | 实现文件 → 引用它的**测试文件** → owning 阶段 `## P{n} 验收标准` 表里提到该测试文件的行（`P{n}-{m}`） | `grep -n "P{n}-{m}" docs/superpowers/plans/*P{n}*.md` |
| **状态** | 「已落地」= 代码里有溯源注释；「计划中」= 只有计划里有；「平台不实现」= 两边都没有 | 三个来源全部可重跑 |

> ⚠️ 扫描面 = `.` 的**并集**（本次用 `--trees .` 生成）。
> ⚠️ 「怎么验」一列有时会写「验收行未点名该测试文件」—— 这是**如实记录**：该需求的验证确实发生了，
> 但那条验收标准是用「同文件」或散文描述指向它的，没有逐字点名测试文件名。这种情况不掩盖。

---

## 一览

| 模块 | 需求数 | ✅ 已落地 | 🟡 已落地·无溯源注释 | ⬜ 计划中 | ⚪ 平台不实现 |
|---|---|---|---|---|---|
| 模块一 报名与组队长（Registration） | 11 | 11 | 0 | 0 | 0 |
| 模块二 赛段与交付物（Stage） | 5 | 5 | 0 | 0 | 0 |
| 模块三 评审打分（Judging）—— 全部来自 S7 | 21 | 21 | 0 | 0 | 0 |
| 模块四 积分与段位（Points & Rank）—— 全部来自 S10 | 23 | 22 | 0 | 0 | 1 |
| 模块五 企业侧（Enterprise） | 12 | 12 | 0 | 0 | 0 |
| 模块六 三池底座（Pools） | 4 | 4 | 0 | 0 | 0 |
| 模块七 审计与证据链（Audit）—— 来自项目自身复盘 | 6 | 6 | 0 | 0 | 0 |
| 模块八 赛事运营（Operation） | 6 | 6 | 0 | 0 | 0 |
| 模块九 非功能需求（NFR） | 8 | 7 | 0 | 1 | 0 |
| **合计** | **96** | **94** | **0** | **1** | **1** |

---

## 逐条对照

### 模块一 · 报名与组队长（Registration）

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-REG-01** | 报名即认领任务包 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 3 报名服务与 API<br>P1·Task 5 战队与成员管理<br>P1·Task 6 前端三页 | `platform/db/migrations/002_registration.sql`<br>`platform/src/config.js`<br>`platform/src/db/repo/teams.js`<br>`platform/src/services/registration.js`<br>…共 6 个文件 | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>…共 23 条 |
| **R-REG-02** | 组队下限 2 人，不接受 1 人 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 5 战队与成员管理 | `platform/db/migrations/002_registration.sql`<br>`platform/src/config.js`<br>`platform/src/services/team.js` | `P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>…共 20 条 |
| **R-REG-03** | 赛程中成员可持续招募汰换 | ✅ 已落地 | P1·Task 1 报名数据模型与迁移<br>P1·Task 5 战队与成员管理<br>P1·Task 6 前端三页 | `platform/db/migrations/002_registration.sql`<br>`platform/src/db/repo/teamMembers.js`<br>`platform/src/services/team.js`<br>`platform/web/views/team.js` | `P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>`P0-12` 终审 8 条 Minor 逐条处置<br>…共 6 条 |
| **R-REG-04** | 仅剩 1 人时触发并队 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 5 战队与成员管理<br>P1·Task 6 前端三页 | `platform/db/migrations/002_registration.sql`<br>`platform/src/config.js`<br>`platform/src/db/repo/teamMembers.js`<br>`platform/src/services/team.js`<br>…共 5 个文件 | `P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>…共 22 条 |
| **R-REG-05** | 组长资格硬门槛 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 5 战队与成员管理 | `platform/db/migrations/002_registration.sql`<br>`platform/src/config.js`<br>`platform/src/services/team.js` | `P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>…共 20 条 |
| **R-REG-06** | 报名筛选 3 维 100 分 | ✅ 已落地 | P1·Task 2 报名算分分级纯函数<br>P1·Task 3 报名服务与 API | `platform/src/domain/registration.js`<br>`platform/src/services/registration.js` | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-10` 全链路 + 零依赖 |
| **R-REG-07** | 总分→等级阈值 80/60/40 | ✅ 已落地 | P1·Task 2 报名算分分级纯函数<br>P1·Task 3 报名服务与 API | `platform/src/domain/registration.js`<br>`platform/src/services/registration.js` | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-10` 全链路 + 零依赖 |
| **R-REG-08** | C 级不接收 | ✅ 已落地 | P1·Task 2 报名算分分级纯函数<br>P1·Task 3 报名服务与 API<br>P1·Task 5 战队与成员管理 | `platform/src/domain/registration.js`<br>`platform/src/services/registration.js`<br>`platform/src/services/team.js` | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>…共 4 条 |
| **R-REG-09** | 筛选标准对外透明 | ✅ 已落地 | P1·Task 2 报名算分分级纯函数<br>P1·Task 3 报名服务与 API<br>P1·Task 6 前端三页 | `platform/src/domain/registration.js`<br>`platform/src/http/routes/registration.js`<br>`platform/src/services/registration.js`<br>`platform/web/views/admin-registration.js`<br>…共 5 个文件 | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-10` 全链路 + 零依赖 |
| **R-REG-10** | 5 阶段筛选漏斗 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 2 报名算分分级纯函数<br>P1·Task 3 报名服务与 API<br>P1·Task 6 前端三页 | `platform/rules/registration-scoring.json`<br>`platform/src/config.js`<br>`platform/src/http/routes/registration.js`<br>`platform/web/views/admin-registration.js` | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>…共 20 条 |
| **R-REG-11** | 问卷字段设计 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 2 报名算分分级纯函数 | `platform/src/config.js`<br>`platform/src/domain/registration.js` | `P0-6` 登录闭环<br>`P0-10` 修复轮 3 的安全边界<br>`P0-11` 终审 Important 三项（I-A / I-B / I-C）<br>…共 20 条 |

### 模块二 · 赛段与交付物（Stage）

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-STG-01** | 5 赛段时间轴与交付物 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 3 报名服务与 API | `platform/db/migrations/002_registration.sql`<br>`platform/rules/schedule.json`<br>`platform/src/config.js`<br>`platform/src/http/routes/registration.js` | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>…共 21 条 |
| **R-STG-02** | 赛段排名积分 10/8/5 | ✅ 已落地 | P3·Task 3 名次积分 + MVP + 个人积分 | `platform/src/domain/points.js` | `P3-2` 名次积分写死 10/8/5<br>`P5-2` **同一任务不能被两人同时领取**<br>`P5-5` 三池同步幂等<br>…共 5 条 |
| **R-STG-03** | 里程碑清单报名时固定 | ✅ 已落地 | P1·Task 1 报名数据模型与迁移<br>P1·Task 5 战队与成员管理<br>P3·Task 7 榜单服务 + 战绩卡 + API<br>P5·Task 2 任务清单与自主领取 | `platform/db/migrations/002_registration.sql`<br>`platform/src/db/repo/tiers.js`<br>`platform/src/services/team.js`<br>`platform/src/services/workflow.js` | `P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>`P5-2` **同一任务不能被两人同时领取**<br>…共 7 条 |
| **R-STG-04** | 交付物须为可运行状态 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P3·Task 1 榜单数据模型与迁移 `004_leaderboa…<br>P3·Task 5 行为分<br>P3·终审修复轮<br>P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 2 任务清单与自主领取 | `platform/db/migrations/006_pools.sql`<br>`platform/rules/criteria.json`<br>`platform/src/config.js`<br>`platform/src/domain/behavior.js`<br>…共 7 个文件 | `P3-2` 名次积分写死 10/8/5<br>`P3-3` 1224 并列名次<br>`P3-5` ★ 行为分与总分隔离<br>…共 20 条 |
| **R-STG-05** | 商业验证赛段不做硬要求 | ✅ 已落地 | P1·Task 3 报名服务与 API | `platform/rules/schedule.json` | — |

### 模块三 · 评审打分（Judging）—— 全部来自 S7

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-JDG-01** | 初赛/决赛两套权重表 | ✅ 已落地 | P2·Task 2 归一化引擎<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/src/domain/normalization.js`<br>`platform/src/domain/scoring.js` | `P2-1` z-score 口径正确<br>`P2-2` 降级显式<br>`P2-3` 4 策略可切换<br>…共 8 条 |
| **R-JDG-02** | 评委宽严 z-score 归一化 | ✅ 已落地 | P2·Task 2 归一化引擎 | `platform/src/domain/normalization.js` | `P2-1` z-score 口径正确<br>`P2-2` 降级显式<br>`P2-3` 4 策略可切换 |
| **R-JDG-03** | 去极值 | ✅ 已落地 | P2·Task 3 去极值 + 评委席得分 P | `platform/src/domain/trim.js` | （验收行未点名该测试文件）<br>被测：`trim.test.js` |
| **R-JDG-04** | 双席加权总分 | ✅ 已落地 | P2·Task 3 去极值 + 评委席得分 P<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/src/domain/scoring.js`<br>`platform/src/domain/trim.js` | `P2-4` 初赛 w_E = 10%<br>`P2-5` ⭐ 行为分进不了总分<br>`P1-1` 报名分级三个边界<br>…共 5 条 |
| **R-JDG-05** | R1 分赛道打分 | ✅ 已落地 | P2·Task 4 企业席 E 与 R1 / R2 / R3 / R4 | `platform/src/domain/enterprise-seat.js` | `P2-6` 企业席 R1–R4 |
| **R-JDG-06** | R2 双签生效 | ✅ 已落地 | P2·Task 4 企业席 E 与 R1 / R2 / R3 / R4 | `platform/src/domain/enterprise-seat.js` | `P2-6` 企业席 R1–R4 |
| **R-JDG-07** | R3 权重封顶 | ✅ 已落地 | P2·Task 4 企业席 E 与 R1 / R2 / R3 / R4 | `platform/src/domain/enterprise-seat.js` | `P2-6` 企业席 R1–R4 |
| **R-JDG-08** | R4 自由命题组处理 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P2·Task 4 企业席 E 与 R1 / R2 / R3 / R4 | `platform/src/config.js`<br>`platform/src/domain/enterprise-seat.js` | `P0-6` 登录闭环<br>`P0-10` 修复轮 3 的安全边界<br>`P0-11` 终审 Important 三项（I-A / I-B / I-C）<br>…共 20 条 |
| **R-JDG-09** | R5 回避制度 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移<br>P2·Task 5 自评测差异检测 + 回避制度 + 互评资格 + …<br>P2·Task 6 评分提交服务 + 幂等 + 增量 score_s…<br>P2·Task 7 加时陈述与一票破同分<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/db/migrations/003_review.sql`<br>`platform/src/db/repo/recusals.js`<br>`platform/src/db/repo/stages.js`<br>`platform/src/domain/review-eligibility.js`<br>…共 7 个文件 | `P2-8` 幂等 + 一票一人<br>`P2-9` 关键唯一约束<br>`P2-10` 可复算<br>…共 9 条 |
| **R-JDG-10** | 评委池规模下限 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P2·Task 5 自评测差异检测 + 回避制度 + 互评资格 + …<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/src/config.js`<br>`platform/src/domain/judge-pool.js`<br>`platform/src/services/compute.js` | `P2-10` 可复算<br>`P2-13` ⭐ SSE 评审进度推送<br>`P0-6` 登录闭环<br>…共 20 条 |
| **R-JDG-11** | 评委席构成 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P2·Task 1 评审数据模型与迁移<br>P2·Task 5 自评测差异检测 + 回避制度 + 互评资格 + …<br>P2·Task 6 评分提交服务 + 幂等 + 增量 score_s…<br>P2·Task 7 加时陈述与一票破同分<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/db/migrations/003_review.sql`<br>`platform/src/config.js`<br>`platform/src/domain/judge-pool.js`<br>`platform/src/domain/scoring.js`<br>…共 7 个文件 | `P2-4` 初赛 w_E = 10%<br>`P2-5` ⭐ 行为分进不了总分<br>`P2-8` 幂等 + 一票一人<br>…共 26 条 |
| **R-JDG-12** | 开赛前校准打分 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移<br>P2·Task 6 评分提交服务 + 幂等 + 增量 score_s… | `platform/db/migrations/003_review.sql`<br>`platform/src/services/review.js` | `P2-8` 幂等 + 一票一人<br>`P2-9` 关键唯一约束<br>`P2-10` 可复算 |
| **R-JDG-13** | 自评测差异检测 ±10 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移<br>P2·Task 5 自评测差异检测 + 回避制度 + 互评资格 + …<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/db/migrations/003_review.sql`<br>`platform/src/domain/scoring.js`<br>`platform/src/domain/self-eval.js`<br>`platform/src/http/routes/review.js` | `P2-4` 初赛 w_E = 10%<br>`P2-5` ⭐ 行为分进不了总分<br>`P2-7` 自评三区间<br>…共 9 条 |
| **R-JDG-14** | 企业签字必须有内容 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移<br>P2·Task 4 企业席 E 与 R1 / R2 / R3 / R4<br>P2·Task 6 评分提交服务 + 幂等 + 增量 score_s…<br>P3·Task 1 榜单数据模型与迁移 `004_leaderboa…<br>P3·终审修复轮 | `platform/db/migrations/003_review.sql`<br>`platform/db/migrations/004_leaderboard.sql`<br>`platform/src/db/repo/enterprise-confirmations.js`<br>`platform/src/domain/enterprise-seat.js`<br>…共 6 个文件 | `P2-6` 企业席 R1–R4<br>`P2-8` 幂等 + 一票一人<br>`P2-9` 关键唯一约束<br>…共 4 条 |
| **R-JDG-15** | 签字有成本 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa… | `platform/rules/criteria.json` | （验收行未点名该测试文件）<br>被测：`leaderboard-migration.test.js` |
| **R-JDG-16** | TOP10 反向抽查 | ✅ 已落地 | P4·Task 3 限频三层 + 幂等键<br>P4·Task 4 防作弊检测器 + 证据三列 + 字段字典 | `platform/rules/audit.json`<br>`platform/src/services/anticheat.js` | `P4-7` **检测 ≠ 处罚** |
| **R-JDG-17** | 全程留档 6 个月 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P2·Task 1 评审数据模型与迁移<br>P4·Task 2 计算快照与复算 diff | `platform/db/migrations/003_review.sql`<br>`platform/src/config.js`<br>`platform/src/services/audit.js` | `P0-6` 登录闭环<br>`P0-10` 修复轮 3 的安全边界<br>`P0-11` 终审 Important 三项（I-A / I-B / I-C）<br>…共 22 条 |
| **R-JDG-18** | 利益冲突声明 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移<br>P2·Task 6 评分提交服务 + 幂等 + 增量 score_s… | `platform/db/migrations/003_review.sql`<br>`platform/src/db/repo/stages.js` | `P2-8` 幂等 + 一票一人<br>`P2-9` 关键唯一约束<br>`P2-10` 可复算<br>…共 5 条 |
| **R-JDG-19** | 同分加时陈述 | ✅ 已落地 | P2·Task 7 加时陈述与一票破同分<br>P2·Task 8 `scoreStage` 总装 + `compu… | `platform/src/db/repo/tiebreak.js`<br>`platform/src/domain/scoring.js`<br>`platform/src/services/tiebreak.js` | `P2-4` 初赛 w_E = 10%<br>`P2-5` ⭐ 行为分进不了总分<br>`P2-8` 幂等 + 一票一人<br>…共 7 条 |
| **R-JDG-20** | 并列共享奖金 | ✅ 已落地 | P3·Task 3 名次积分 + MVP + 个人积分 | `platform/src/domain/points.js` | `P3-2` 名次积分写死 10/8/5<br>`P5-2` **同一任务不能被两人同时领取**<br>`P5-5` 三池同步幂等<br>…共 5 条 |
| **R-JDG-21** | 权重回退方案 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa… | `platform/rules/points.json` | `P5-5` 三池同步幂等<br>`P6-6` 扫描闸能识别「闸未生效」<br>`P6-9` 种子数据触发每条 trace 分支 |

### 模块四 · 积分与段位（Points & Rank）—— 全部来自 S10

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-RNK-01** | 双榜并列，不合成一个总分 | ✅ 已落地 | P3·Task 7 榜单服务 + 战绩卡 + API | `platform/src/services/leaderboard.js` | （验收行未点名该测试文件）<br>被测：`behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js` |
| **R-RNK-02** | B 榜不碰奖金与名次 | ✅ 已落地 | P3·Task 7 榜单服务 + 战绩卡 + API | `platform/src/services/leaderboard.js` | （验收行未点名该测试文件）<br>被测：`behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js` |
| **R-RNK-03** | A 榜不碰资源解锁 | ✅ 已落地 | P3·Task 7 榜单服务 + 战绩卡 + API | `platform/src/services/leaderboard.js` | （验收行未点名该测试文件）<br>被测：`behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js` |
| **R-RNK-04** | 滚动榜单全程公开 | ✅ 已落地 | P3·Task 7 榜单服务 + 战绩卡 + API | `platform/src/services/leaderboard.js` | （验收行未点名该测试文件）<br>被测：`behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js` |
| **R-RNK-05** | 互评权重 ≤20% | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验 | `platform/rules/tiebreak.json` | `P3-3` 1224 并列名次 |
| **R-RNK-06** | 互评只用于破同分 | ✅ 已落地 | P3·Task 2 破同分链执行器 + 1224 并列名次 | `platform/src/domain/ranking.js` | `P3-3` 1224 并列名次<br>`P3-5` ★ 行为分与总分隔离 |
| **R-RNK-07** | 互评资格门槛 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移<br>P2·Task 5 自评测差异检测 + 回避制度 + 互评资格 + …<br>P2·Task 6 评分提交服务 + 幂等 + 增量 score_s…<br>P3·Task 7 榜单服务 + 战绩卡 + API | `platform/db/migrations/003_review.sql`<br>`platform/src/domain/review-eligibility.js`<br>`platform/src/services/leaderboard.js`<br>`platform/src/services/review.js` | `P2-8` 幂等 + 一票一人<br>`P2-9` 关键唯一约束<br>`P2-10` 可复算 |
| **R-RNK-08** | 异常互评检测 | ✅ 已落地 | P4·Task 4 防作弊检测器 + 证据三列 + 字段字典 | `platform/src/domain/anticheat.js`<br>`platform/src/services/anticheat.js` | `P4-7` **检测 ≠ 处罚** |
| **R-RNK-09** | MVP 评定 | ✅ 已落地 | P3·Task 3 名次积分 + MVP + 个人积分 | `platform/src/domain/points.js` | `P3-2` 名次积分写死 10/8/5<br>`P5-2` **同一任务不能被两人同时领取**<br>`P5-5` 三池同步幂等<br>…共 5 条 |
| **R-RNK-10** | 个人积分终生上榜 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P3·Task 3 名次积分 + MVP + 个人积分<br>P3·Task 7 榜单服务 + 战绩卡 + API<br>P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 3 三池派生同步 | `platform/rules/pools.json`<br>`platform/src/config.js`<br>`platform/src/db/repo/pool-sources.js`<br>`platform/src/domain/personal-points.js`<br>…共 8 个文件 | `P3-2` 名次积分写死 10/8/5<br>`P3-3` 1224 并列名次<br>`P3-5` ★ 行为分与总分隔离<br>…共 22 条 |
| **R-PTS-01** | L0 段位锚定企业签字里程碑 | ✅ 已落地 | P3·Task 4 段位计算与降级<br>P3·Task 7 榜单服务 + 战绩卡 + API | `platform/src/domain/tier.js`<br>`platform/src/services/tier.js` | `P3-6` ★ 段位边界<br>`P6-9` 种子数据触发每条 trace 分支 |
| **R-PTS-02** | 段位表 D/C/B/A/S | ✅ 已落地 | P3·Task 4 段位计算与降级 | `platform/src/domain/tier.js` | `P3-6` ★ 段位边界<br>`P6-9` 种子数据触发每条 trace 分支 |
| **R-PTS-03** | S 段要业务部门签字 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa…<br>P3·Task 4 段位计算与降级<br>P3·终审修复轮 | `platform/db/migrations/004_leaderboard.sql`<br>`platform/rules/criteria.json`<br>`platform/src/domain/tier.js`<br>`platform/src/services/milestone.js` | `P3-6` ★ 段位边界<br>`P6-9` 种子数据触发每条 trace 分支 |
| **R-PTS-04** | 段位可降级且规则公开 | ✅ 已落地 | P3·Task 4 段位计算与降级<br>P3·Task 7 榜单服务 + 战绩卡 + API | `platform/src/db/repo/tiers.js`<br>`platform/src/domain/tier.js` | `P3-6` ★ 段位边界<br>`P4-5` 状态机非法迁移被拒 + 幂等守卫不产生二次迁移<br>`P5-5` 三池同步幂等<br>…共 4 条 |
| **R-PTS-05** | 段位换资源不换钱 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa…<br>P3·Task 4 段位计算与降级 | `platform/rules/points.json`<br>`platform/src/domain/tier.js` | `P3-6` ★ 段位边界<br>`P5-5` 三池同步幂等<br>`P6-6` 扫描闸能识别「闸未生效」<br>…共 4 条 |
| **R-PTS-06** | 辅导期名额只影响同分排序 | ✅ 已落地 | P3·Task 4 段位计算与降级 | `platform/src/domain/tier.js` | `P3-6` ★ 段位边界<br>`P6-9` 种子数据触发每条 trace 分支 |
| **R-PTS-07** | L1 行为分明细 | ✅ 已落地 | P3·Task 5 行为分 | `platform/src/domain/behavior.js` | `P3-5` ★ 行为分与总分隔离 |
| **R-PTS-08** | 行为分 ≤10% 且只做"垫底排序" | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P3·Task 2 破同分链执行器 + 1224 并列名次<br>P3·Task 5 行为分 | `platform/src/config.js`<br>`platform/src/domain/behavior.js`<br>`platform/src/domain/ranking.js` | `P3-2` 名次积分写死 10/8/5<br>`P3-3` 1224 并列名次<br>`P3-5` ★ 行为分与总分隔离<br>…共 19 条 |
| **R-PTS-09** | 行为分达标线 60 = 完赛 | ✅ 已落地 | P3·Task 5 行为分 | `platform/src/domain/behavior.js` | `P3-5` ★ 行为分与总分隔离 |
| **R-PTS-10** | 反作弊 5 条 | ✅ 已落地 | P1·Task 5 战队与成员管理<br>P3·Task 1 榜单数据模型与迁移 `004_leaderboa…<br>P3·Task 5 行为分<br>P3·终审修复轮 | `platform/db/migrations/004_leaderboard.sql`<br>`platform/rules/criteria.json`<br>`platform/src/domain/behavior.js`<br>`platform/src/http/routes/behavior.js`<br>…共 6 个文件 | `P3-5` ★ 行为分与总分隔离<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖 |
| **R-PTS-11** | L2 商业里程碑分 | ✅ 已落地 | P3·终审修复轮 | `platform/rules/milestones.default.json`<br>`platform/src/services/milestone.js` | — |
| **R-PTS-12** | L2 与段位同源但规则不共享 | ✅ 已落地 | P3·终审修复轮 | `platform/rules/milestones.default.json`<br>`platform/src/services/milestone.js` | — |
| **R-PTS-13** | 押金是负债不入营收 | ⚪ 平台不实现 | — | — | — |

### 模块五 · 企业侧（Enterprise）

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-ENT-01** | 企业出题（任务卡） | ✅ 已落地 | P0·Task 7 静态文件服务、前端骨架与服务器入口<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 4 任务卡与六维可解性 | `platform/db/migrations/002_registration.sql`<br>`platform/scripts/seed.js`<br>`platform/src/db/repo/taskPackages.js`<br>`platform/src/http/routes/taskPackage.js`<br>…共 5 个文件 | `P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>`P0-9` 安全边界钉住<br>…共 9 条 |
| **R-ENT-02** | 企业签字里程碑 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa…<br>P3·终审修复轮 | `platform/db/migrations/004_leaderboard.sql`<br>`platform/src/services/milestone.js` | — |
| **R-ENT-03** | 企业席评委 | ✅ 已落地 | P2·Task 1 评审数据模型与迁移 | `platform/db/migrations/003_review.sql` | `P2-9` 关键唯一约束 |
| **R-ENT-04** | B 榜签字不公开 | ✅ 已落地 | P3·Task 7 榜单服务 + 战绩卡 + API<br>P3·Task 8 前端榜单页 + 段位榜 + 战绩卡 + 回归验收 | `platform/src/services/leaderboard.js`<br>`platform/src/services/performance-card.js`<br>`platform/web/views/card.js` | （验收行未点名该测试文件）<br>被测：`behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js` |
| **R-ENT-05** | 派单/战绩榜（长期） | ✅ 已落地 | P5·Task 1 工作流与三池数据模型与迁移 | `platform/db/migrations/006_pools.sql` | — |
| **R-ENT-06** | 六维可解性评估准入 | ✅ 已落地 | P1·Task 1 报名数据模型与迁移<br>P1·Task 4 任务卡与六维可解性<br>P1·Task 5 战队与成员管理 | `platform/db/migrations/002_registration.sql`<br>`platform/src/domain/solvability.js`<br>`platform/src/http/routes/taskPackage.js`<br>`platform/src/services/taskPackage.js`<br>…共 5 个文件 | `P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>`P0-12` 终审 8 条 Minor 逐条处置<br>…共 4 条 |
| **R-ENT-07** | 三条一票否决 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 4 任务卡与六维可解性 | `platform/db/migrations/002_registration.sql`<br>`platform/src/config.js`<br>`platform/src/domain/solvability.js`<br>`platform/src/http/routes/taskPackage.js`<br>…共 5 个文件 | `P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>…共 20 条 |
| **R-ENT-08** | 分级签约与对应协议 | ✅ 已落地 | P1·Task 1 报名数据模型与迁移<br>P1·Task 4 任务卡与六维可解性 | `platform/db/migrations/002_registration.sql`<br>`platform/src/domain/solvability.js`<br>`platform/src/http/routes/taskPackage.js`<br>`platform/src/services/taskPackage.js` | `P1-10` 全链路 + 零依赖<br>`P0-12` 终审 8 条 Minor 逐条处置<br>`P2-9` 关键唯一约束 |
| **R-ENT-09** | 任务卡配比 70% B 端 + 30% 自由 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P0·Task 7 静态文件服务、前端骨架与服务器入口<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 4 任务卡与六维可解性<br>P1·Task 5 战队与成员管理<br>P1·Task 6 前端三页 | `platform/db/migrations/002_registration.sql`<br>`platform/rules/solvability.json`<br>`platform/scripts/seed.js`<br>`platform/src/config.js`<br>…共 9 个文件 | `P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>…共 21 条 |
| **R-ENT-10** | 自由题无企业签字 | ✅ 已落地 | P0·Task 7 静态文件服务、前端骨架与服务器入口<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 4 任务卡与六维可解性 | `platform/db/migrations/002_registration.sql`<br>`platform/scripts/seed.js`<br>`platform/src/http/routes/taskPackage.js`<br>`platform/src/services/taskPackage.js` | `P1-10` 全链路 + 零依赖<br>`P0-9` 安全边界钉住<br>`P0-10` 修复轮 3 的安全边界<br>…共 6 条 |
| **R-ENT-11** | IP 与成果归属 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 3 报名服务与 API<br>P1·Task 4 任务卡与六维可解性 | `platform/db/migrations/002_registration.sql`<br>`platform/rules/compliance.json`<br>`platform/src/config.js`<br>`platform/src/http/routes/registration.js`<br>…共 5 个文件 | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>…共 21 条 |
| **R-ENT-12** | 合规红线与同意记录 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P0·Task 7 静态文件服务、前端骨架与服务器入口<br>P1·Task 1 报名数据模型与迁移<br>P1·Task 3 报名服务与 API<br>P1·Task 4 任务卡与六维可解性 | `platform/db/migrations/002_registration.sql`<br>`platform/rules/compliance.json`<br>`platform/scripts/seed.js`<br>`platform/src/config.js`<br>…共 8 个文件 | `P1-1` 报名分级三个边界<br>`P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>…共 22 条 |

### 模块六 · 三池底座（Pools）

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-POOL-01** | 项目池 | ✅ 已落地 | P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 3 三池派生同步 | `platform/db/migrations/006_pools.sql`<br>`platform/src/db/repo/pools.js`<br>`platform/src/domain/pool-derive.js`<br>`platform/src/services/pools.js` | `P5-1` 迁移 006 建出七张表<br>`P5-5` 三池同步幂等 |
| **R-POOL-02** | 人才池 | ✅ 已落地 | P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 3 三池派生同步 | `platform/src/db/repo/pools.js`<br>`platform/src/domain/pool-derive.js`<br>`platform/src/services/pools.js` | `P5-1` 迁移 006 建出七张表<br>`P5-5` 三池同步幂等 |
| **R-POOL-03** | 资源池 | ✅ 已落地 | P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 3 三池派生同步 | `platform/src/db/repo/pools.js`<br>`platform/src/domain/pool-derive.js`<br>`platform/src/services/pools.js` | `P5-1` 迁移 006 建出七张表<br>`P5-5` 三池同步幂等 |
| **R-POOL-04** | 增长飞轮闭环 | ✅ 已落地 | P5·Task 3 三池派生同步 | `platform/src/services/pools.js` | `P5-1` 迁移 006 建出七张表<br>`P5-5` 三池同步幂等<br>`P5-11` **增长飞轮的沉淀物可计量**（R-POOL-04） |

### 模块七 · 审计与证据链（Audit）—— 来自项目自身复盘

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-AUD-01** | 每次发榜/计分可复算 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P2·Task 8 `scoreStage` 总装 + `compu…<br>P3·Task 2 破同分链执行器 + 1224 并列名次<br>P4·Task 2 计算快照与复算 diff | `platform/rules/tiebreak.json`<br>`platform/src/domain/diff.js`<br>`platform/src/domain/ranking.js`<br>`platform/src/services/audit.js`<br>…共 5 个文件 | `P2-10` 可复算<br>`P3-3` 1224 并列名次<br>`P3-5` ★ 行为分与总分隔离<br>…共 7 条 |
| **R-AUD-02** | 计算留输入快照 | ✅ 已落地 | P4·Task 2 计算快照与复算 diff | `platform/src/services/audit.js` | `P4-2` 复算 diff 能被看见 + 规则版本变更不静默<br>`P4-7` **检测 ≠ 处罚**<br>`P4-10` 端到端复算 |
| **R-AUD-03** | 禁用词/证伪清单扫描 | ✅ 已落地 | P4·Task 7 发布前扫描闸 | `platform/scripts/audit-scan.js`<br>`platform/scripts/forbidden.txt` | `P4-9` 扫描闸真生效<br>`P6-6` 扫描闸能识别「闸未生效」 |
| **R-AUD-04** | 证据三列（URL/发行方/独立性） | ✅ 已落地 | P4·Task 4 防作弊检测器 + 证据三列 + 字段字典<br>P5·Task 2 任务清单与自主领取 | `platform/src/domain/evidence.js`<br>`platform/src/domain/task-evidence.js`<br>`platform/src/services/anticheat.js` | `P4-7` **检测 ≠ 处罚**<br>`P5-2` **同一任务不能被两人同时领取**<br>`P6-6` 扫描闸能识别「闸未生效」 |
| **R-AUD-05** | 空结果必须显式报错 | ✅ 已落地 | P3·Task 7 榜单服务 + 战绩卡 + API<br>P4·Task 3 限频三层 + 幂等键 | `platform/src/services/leaderboard.js`<br>`platform/src/services/rate-limit.js`<br>`platform/src/services/tier.js` | `P3-6` ★ 段位边界<br>`P4-1` 审计四表建出<br>`P4-3` 限频超限 429 + Retry-After，且计数落库<br>…共 4 条 |
| **R-AUD-06** | 并行前定字段字典 | ✅ 已落地 | P4·Task 4 防作弊检测器 + 证据三列 + 字段字典 | `platform/src/domain/field-dictionary.js`<br>`platform/src/services/anticheat.js` | `P4-7` **检测 ≠ 处罚** |

### 模块八 · 赛事运营（Operation）

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-OPS-09** | 多期 / 多城租户维度 | ✅ 已落地 | P1·Task 1 报名数据模型与迁移 | `platform/db/migrations/002_registration.sql`<br>`platform/src/db/repo/editions.js` | `P1-3` 重复报名 409 且不覆盖<br>`P1-5` 组队三条硬门槛<br>`P1-10` 全链路 + 零依赖<br>…共 9 条 |
| **R-OPS-10** | 晋级率 25%，决赛 TOP32 | ✅ 已落地 | P1·Task 3 报名服务与 API | `platform/rules/schedule.json` | — |
| **R-OPS-11** | Demo Day 观众投票权重 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa… | `platform/rules/points.json` | `P5-5` 三池同步幂等<br>`P6-6` 扫描闸能识别「闸未生效」<br>`P6-9` 种子数据触发每条 trace 分支 |
| **R-OPS-12** | 奖项结构：资源≈现金 1:1.55 | ✅ 已落地 | P3·Task 1 榜单数据模型与迁移 `004_leaderboa… | `platform/rules/points.json` | `P5-5` 三池同步幂等<br>`P6-6` 扫描闸能识别「闸未生效」<br>`P6-9` 种子数据触发每条 trace 分支 |
| **R-OPS-13** | 任务清单工作流拆解 | ✅ 已落地 | P1·Task 1 报名数据模型与迁移<br>P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 2 任务清单与自主领取 | `platform/db/migrations/006_pools.sql`<br>`platform/src/db/repo/task-claims.js`<br>`platform/src/db/repo/teamMembers.js`<br>`platform/src/db/repo/workflows.js`<br>…共 5 个文件 | `P5-1` 迁移 006 建出七张表<br>`P5-2` **同一任务不能被两人同时领取** |
| **R-OPS-14** | 禁止岗位制 | ✅ 已落地 | P0·Task 3 规则配置与 fail-fast 校验<br>P1·Task 1 报名数据模型与迁移<br>P5·Task 1 工作流与三池数据模型与迁移<br>P5·Task 2 任务清单与自主领取 | `platform/src/config.js`<br>`platform/src/db/repo/task-claims.js`<br>`platform/src/db/repo/teamMembers.js`<br>`platform/src/services/workflow.js` | `P5-1` 迁移 006 建出七张表<br>`P5-2` **同一任务不能被两人同时领取**<br>`P5-5` 三池同步幂等<br>…共 21 条 |

### 模块九 · 非功能需求（NFR）

| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |
|---|---|---|---|---|---|
| **R-OPS-01** | 可移植 | ✅ 已落地 | P0·Task 2 SQLite 封装与迁移机制<br>P6·Task 2 部署资产 | `platform/deploy/install.sh`<br>`platform/src/db/sqlite.js` | `P0-1` 零依赖<br>`P0-4` 权限判定唯一入口<br>`P0-5` 密码与会话<br>…共 31 条 |
| **R-OPS-02** | 跨平台稳定 | ✅ 已落地 | P0·Task 2 SQLite 封装与迁移机制 | `platform/src/db/migrate.js` | `P0-4` 权限判定唯一入口<br>`P0-5` 密码与会话<br>`P0-6` 登录闭环<br>…共 24 条 |
| **R-OPS-03** | 可扩容 | ✅ 已落地 | P6·Task 2 部署资产 | `platform/deploy/heikesong.service` | `P6-3` 部署资产齐全且守住单写者 |
| **R-OPS-04** | 性能 | ✅ 已落地 | P0·Task 2 SQLite 封装与迁移机制 | `platform/src/db/sqlite.js` | `P0-1` 零依赖<br>`P0-4` 权限判定唯一入口<br>`P0-5` 密码与会话<br>…共 30 条 |
| **R-OPS-05** | 云主机部署 | ✅ 已落地 | P6·Task 2 部署资产 | `platform/deploy/install.sh` | `P6-3` 部署资产齐全且守住单写者 |
| **R-OPS-06** | 公网可访问 | ⬜ 计划中 | P6·表 阶段需求覆盖表 | — | — |
| **R-OPS-07** | 零 npm 依赖 | ✅ 已落地 | P0·Task 2 SQLite 封装与迁移机制 | `platform/src/db/sqlite.js` | `P0-1` 零依赖<br>`P0-4` 权限判定唯一入口<br>`P0-5` 密码与会话<br>…共 30 条 |
| **R-OPS-08** | 单文件数据库 | ✅ 已落地 | P0·Task 2 SQLite 封装与迁移机制 | `platform/src/db/sqlite.js` | `P0-1` 零依赖<br>`P0-4` 权限判定唯一入口<br>`P0-5` 密码与会话<br>…共 30 条 |

---

## 承载需求最多的文件（改动前的影响面评估）

| 文件 | 承载需求数 | 需求 |
|---|---|---|
| `platform/src/config.js` | 19 | R-REG-01、R-REG-02、R-REG-04、R-REG-05、R-REG-10、R-REG-11、R-STG-01、R-STG-04、R-JDG-08、R-JDG-10、R-JDG-11、R-JDG-17、R-RNK-10、R-PTS-08、R-ENT-07、R-ENT-09、R-ENT-11、R-ENT-12、R-OPS-14 |
| `platform/db/migrations/002_registration.sql` | 16 | R-REG-01、R-REG-02、R-REG-03、R-REG-04、R-REG-05、R-STG-01、R-STG-03、R-ENT-01、R-ENT-06、R-ENT-07、R-ENT-08、R-ENT-09、R-ENT-10、R-ENT-11、R-ENT-12、R-OPS-09 |
| `platform/src/services/team.js` | 10 | R-REG-01、R-REG-02、R-REG-03、R-REG-04、R-REG-05、R-REG-08、R-STG-03、R-PTS-10、R-ENT-06、R-ENT-09 |
| `platform/db/migrations/003_review.sql` | 9 | R-JDG-09、R-JDG-11、R-JDG-12、R-JDG-13、R-JDG-14、R-JDG-17、R-JDG-18、R-RNK-07、R-ENT-03 |
| `platform/src/services/leaderboard.js` | 8 | R-RNK-01、R-RNK-02、R-RNK-03、R-RNK-04、R-RNK-07、R-RNK-10、R-ENT-04、R-AUD-05 |
| `platform/src/services/taskPackage.js` | 8 | R-ENT-01、R-ENT-06、R-ENT-07、R-ENT-08、R-ENT-09、R-ENT-10、R-ENT-11、R-ENT-12 |
| `platform/src/http/routes/taskPackage.js` | 7 | R-ENT-01、R-ENT-06、R-ENT-07、R-ENT-08、R-ENT-09、R-ENT-10、R-ENT-12 |
| `platform/src/domain/tier.js` | 6 | R-PTS-01、R-PTS-02、R-PTS-03、R-PTS-04、R-PTS-05、R-PTS-06 |
| `platform/src/services/registration.js` | 6 | R-REG-01、R-REG-06、R-REG-07、R-REG-08、R-REG-09、R-ENT-12 |
| `platform/src/domain/behavior.js` | 5 | R-STG-04、R-PTS-07、R-PTS-08、R-PTS-09、R-PTS-10 |
| `platform/src/domain/enterprise-seat.js` | 5 | R-JDG-05、R-JDG-06、R-JDG-07、R-JDG-08、R-JDG-14 |
| `platform/src/domain/registration.js` | 5 | R-REG-06、R-REG-07、R-REG-08、R-REG-09、R-REG-11 |
| `platform/src/domain/scoring.js` | 5 | R-JDG-01、R-JDG-04、R-JDG-11、R-JDG-13、R-JDG-19 |
| `platform/src/http/routes/registration.js` | 5 | R-REG-09、R-REG-10、R-STG-01、R-ENT-11、R-ENT-12 |
| `platform/src/services/milestone.js` | 5 | R-JDG-14、R-PTS-03、R-PTS-11、R-PTS-12、R-ENT-02 |

---

## 四类尾巴

### 一、已落地但**代码里没写溯源注释**（0 条）—— 应补注释

> **0 条** —— 所有已落地需求的实现文件里都有 `R-XXX-NN` 溯源注释，溯源链无缺口。

### 二、计划中（尚未实现）

| 需求 | 状态 | 说明 |
|---|---|---|
| **R-PTS-13** 押金是负债不入营收 | ⚪ 平台不实现 | **平台【不实现】**：这是**财务科目口径**（押金按负债科目入账）而非平台功能，且「中途不退部分去向」本身是规则空白。溯源表已显式声明不实现，并禁止任何人往平台里加「报名费 / 押金」字段或退费流程。 |
| **R-OPS-06** 公网可访问 | ⬜ 计划中 | 计划已写明落点（P6 表），代码尚未落地 —— **在本表生成时尚未实现**。 |

### 三、平台明确不实现

| **R-PTS-13** 押金是负债不入营收 | ⚪ 平台不实现 | **财务科目口径**而非平台功能；「中途不退部分去向」本身是规则空白。溯源表已声明平台不实现，并禁止任何人往平台里加「报名费 / 押金」字段或退费流程。 |

### 四、已落地但**验收标准未逐字点名该测试文件**（13 条）

> 这些需求的**验证确实发生了**（实现文件被测试文件引用，测试在跑），
> 但那条验收标准是用「同文件」或散文描述指向它的，**没有逐字点名测试文件名**
> ⇒ 本表的「怎么验」一列给不出 `P{n}-{m}` 编号，只能给出被测文件名。**如实记录，不掩盖。**

| 需求 | 状态 | 落地文件 | 被测文件（验收行未点名） |
|---|---|---|---|
| **R-STG-05** 商业验证赛段不做硬要求 | ✅ 已落地（P1 Task 3） | `schedule.json` | —（未被任何测试文件引用） |
| **R-JDG-03** 去极值 | ✅ 已落地（P2 Task 3） | `trim.js` | trim.test.js |
| **R-JDG-15** 签字有成本 | ✅ 已落地（P3 Task 1） | `criteria.json` | leaderboard-migration.test.js |
| **R-RNK-01** 双榜并列，不合成一个总分 | ✅ 已落地（P3 Task 7） | `leaderboard.js` | behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js |
| **R-RNK-02** B 榜不碰奖金与名次 | ✅ 已落地（P3 Task 7） | `leaderboard.js` | behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js |
| **R-RNK-03** A 榜不碰资源解锁 | ✅ 已落地（P3 Task 7） | `leaderboard.js` | behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js |
| **R-RNK-04** 滚动榜单全程公开 | ✅ 已落地（P3 Task 7） | `leaderboard.js` | behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js |
| **R-PTS-11** L2 商业里程碑分 | ✅ 已落地（P3 终审修复轮） | `milestones.default.json`、`milestone.js` | —（未被任何测试文件引用） |
| **R-PTS-12** L2 与段位同源但规则不共享 | ✅ 已落地（P3 终审修复轮） | `milestones.default.json`、`milestone.js` | —（未被任何测试文件引用） |
| **R-ENT-02** 企业签字里程碑 | ✅ 已落地（P3 Task 1、P3 终审修复轮） | `004_leaderboard.sql`、`milestone.js` | —（未被任何测试文件引用） |
| **R-ENT-04** B 榜签字不公开 | ✅ 已落地（P3 Task 7、P3 Task 8） | `leaderboard.js`、`performance-card.js` | behavior-service.test.js`、`leaderboard-service.test.js`、`leaderboard-web.test.js |
| **R-ENT-05** 派单/战绩榜（长期） | ✅ 已落地（P5 Task 1） | `006_pools.sql` | —（未被任何测试文件引用） |
| **R-OPS-10** 晋级率 25%，决赛 TOP32 | ✅ 已落地（P1 Task 3） | `schedule.json` | —（未被任何测试文件引用） |

---

*本表由 `docs/requirements-traceability.md` + 7 份阶段计划 + 代码树的溯源注释扫描**自动生成**；
生成器：`python3 docs/tools/requirement-map.py --trees . --out docs/requirement-implementation-map.md`（**在仓库里，可复算**）。*

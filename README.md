# AI 商业黑客松赛事平台

零依赖 Node 单体赛事平台：报名与组队 → 评审打分 → 积分段位与公开榜 → 审计反作弊 → 池化协同 → 部署与演示站。

> `git clone` 后**不需要 `npm install`**，直接跑。

```bash
cd platform
node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test               # 跑测试
```

**运行环境**：Node ≥ 22.16.0（`node:sqlite` 免实验标志 + `sqlite.backup()`，两者下限的并集）。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `platform/src/` | 服务端实现：领域层（`domain/`）、HTTP 路由（`http/routes/`）、数据访问（`db/`）、审计反作弊（`audit/`）、鉴权（`auth/`） |
| `platform/rules/` | 赛制规则配置（评分、积分、段位、行为分、合规、赛程、池化等 16 份 JSON），改配置即生效，**改完需重启服务**，不改代码 |
| `platform/db/migrations/` | 数据库迁移 |
| `platform/test/` | 测试套件（2044 例；实际数量以 CI 为准） |
| `platform/web/` | 前端：SPA + 演示站构建产物（`dist/`，构建产物不入库） |
| `platform/deploy/` | 部署资产：nginx、systemd、docker-compose、一键安装脚本 |
| `docs/` | 需求溯源、规则冲突登记、组委会确认清单、部署运维手册、设计与实施计划 |

## 常用命令

全部在 `platform/` 下执行。

| 命令 | 作用 |
| --- | --- |
| `node --test` | 跑测试套件 |
| `node scripts/migrate.js` | 建库 / 执行迁移 |
| `node scripts/seed.js` | 写入种子数据 |
| `node scripts/backup.js` | 备份数据库 |
| `node scripts/restore.js` | 从备份恢复 |
| `node scripts/build-demo.js` | 构建公开演示站（产物 → `platform/web/dist/`） |
| `node scripts/serve-demo.js` | 本地预览演示站 |
| `node scripts/audit-scan.js` | 禁用词 / 证据链扫描闸 |

### 机器闸（改动前先跑，有红就停下）

| 命令 | 作用 |
| --- | --- |
| `node scripts/audit-scan.js` | 禁用词 / 证据链扫描 |
| `node scripts/temp-leak-scan.js` | 临时目录泄漏（测试必须走 `test-helpers/tmp.js` 的回收机制） |
| `node scripts/bash-var-scan.js` | bash 变量名吞非 ASCII |
| `node docs/tools/dead-service-scan.mjs` | 服务层导出函数 ⇒ 生产必有调用方（有死函数退出码 1） |
| `node docs/tools/plan-block-audit.mjs platform` | 计划块漂移审计（`C-RW` 必须为 0） |

## 架构要点

- **零第三方依赖**：仅用 Node 标准库，克隆即可运行，不需要安装步骤。
- **规则配置化**：赛制口径集中在 `platform/rules/*.json`（16 份），改一份 JSON 即生效，**不用改代码**。
  ⚠️ 规则**只在进程启动时加载一次**（`src/server.js` 的 `loadRules(rulesDir)`，全仓无热重载机制）⇒ **改完 `platform/rules/*.json` 必须重启服务**才生效。
- **单写者约束**：SQLite 只允许单写进程，写入串行化；扩容只能加「读」（静态资源交给 nginx 直出）。
- **差异化机制（企业双签 / z-score 归一化 / 段位体系 / 滚动榜 / 匿名评审 / 冲突回避 / 协同刷分检测 / 可解释回执）**：对 **11 个**开源黑客松平台的**源码级全仓关键词检索**（`z_score / standardize / winsor / outlier / percentile`）**零命中** ⇒ 无现成实现，按无先例自建。
  ⚠️ 这是**缺失性结论**：只能证明「这 11 个仓没有」，**不能证明「全世界没有」**；且评委宽严的**贝叶斯**策略是移植自 MIT 版 `crowd_bt.py`（作为 z-score 的并行备选策略），并非自创。证据链见设计文档 §3 与 §17.1。

## 规则配置（`platform/rules/`）

16 份 JSON。**两类键要分清**：

- **可调参数** —— 在声明的取值域内可改，改完按表里的「生效范围」处理。
- **不变量声明** —— 取值被**写死**（声明的是「已定的规则」，不是「可调的口径」）。改这类键 ⇒ `validateRules` 报错 ⇒ **服务拒绝启动**。这是故意的：把「行为分只做破同分」「组长必须 MBA 在籍」这类已定规则做成可调参数，等于让配置悄悄改赛制。

另有两条全局约束：**16 份的 `version` 必须全等**（改任何一份 ⇒ 16 份统一升版，否则拒绝启动），以及**规则只在进程启动时加载一次 ⇒ 改完必须重启服务**。

> 下表的「校验位置」指 `platform/src/config.js` 的 `validateRules()` 行号（fail-fast 校验器，`loadRules()` 抛错拒绝启动）。

| 来源文件 | 键 | 类别 | 约束 | 校验位置 / 改了会怎样 |
| --- | --- | --- | --- | --- |
| `behavior-points.json` | `sortUse` | **不变量声明** | 必须 = `tiebreak_only`（R-PTS-08：行为分只做破同分，不进总分/奖金） | `config.js:448` ⇒ 拒绝启动 |
| `team-formation.json` | `captainMustBeMba` | **不变量声明** | 必须 = `true`（R-REG-05：组长必须一堂 MBA 在籍） | `config.js:535` ⇒ 拒绝启动 |
| `team-formation.json` | `singleMemberTriggersMerge` | **不变量声明** | 必须 = `true`（R-REG-04：仅剩 1 人触发并队） | `config.js:545` ⇒ 拒绝启动 |
| `pools.json` | `workflow.claimMode` | **不变量声明** | 必须 = `self_claim_only`（R-OPS-14 禁止岗位制） | `config.js:747` ⇒ 拒绝启动 |
| `pools.json` | `talentTotalScope` | **不变量声明** | 必须 = `lifetime`（R-RNK-10 个人积分终生上榜） | `config.js:785` ⇒ 拒绝启动 |
| `pools.json` | `taskEvidence.requireRunnableOrBlocker` | **不变量声明** | 必须为真（R-STG-04 交付物须可运行或给阻塞点） | `config.js:788` ⇒ 拒绝启动 |
| `points.json` | `tieRankStyle` | **不变量声明** | 必须 = `1224` | `config.js:639` ⇒ 拒绝启动 |
| `points.json` | `mvp.perPackage` | **不变量声明** | 必须 = `1`（每个任务包 1 个 MVP） | `config.js:640` ⇒ 拒绝启动 |
| `criteria.json` | `mvp.tiebreak`（末位） | **不变量声明** | 末位必须 = `team_id`（确定性兜底，否则同分 MVP 不可复算） | `config.js:692` ⇒ 拒绝启动 |
| `scoring-initial.json`、`scoring-final.json` | `trimPolicy` | **不变量声明** | 必须 = `threshold`（S7 §3.2：评委数不足门槛时**整档不去极值**，整数阶跃是刻意的） | `config.js:218` ⇒ 拒绝启动 |
| `scoring-initial.json`、`scoring-final.json` | `minSamplesScope` | **不变量声明** | 必须 = `judge_ratings_count`（样本数 = 该评委在本赛段评过的队伍数） | `config.js:232` ⇒ 拒绝启动 |
| `scoring-initial.json` | `wEnterprise` | **不变量声明** | 必须 = `0.10`（该文件 `conflictRef` = `C-01`；决赛 `scoring-final.json` 的 `conflictRef` = `C-04`，同键可调） | `config.js:255` ⇒ 拒绝启动 |
| `schedule.json` | `stages` | 结构不变量 | 必须是 **5** 个赛段；相邻段不得时间重叠（相接合法） | `config.js:555` ⇒ 拒绝启动 |
| `registration-scoring.json` | `funnel` | 结构不变量 | 必须是 **5** 个阶段，且逐级收窄 | `config.js:603` ⇒ 拒绝启动 |
| `registration-scoring.json` | `questions.dimensionItems.<维度>` | 结构不变量 | 每个维度必须 **5** 题（SABC v1 §六） | `config.js:597` ⇒ 拒绝启动 |
| 全部 16 份 | `version` | 结构不变量 | 必须存在，且 16 份**全等** | `config.js:132` / `config.js:142` ⇒ 拒绝启动 |
| `scoring-initial.json`、`scoring-final.json` | `dimensions[].weight`、`normalizationStrategy`、`fallback`、`minJudgesForTrim`、`minSamplesForJudgeNormalization`、`trimmedIterations`、`selfEvalThreshold`、`judgePool.*`、`freeBrief.judgeDimension`（`wEnterprise` 只有 `scoring-final.json` 可调，`scoring-initial.json` 见上） | 可调参数 | 权重合计 = 1；`normalizationStrategy` ∈ `zscore`/`median`/`trimmed`/`bayes`；`fallback` ∈ `global`/`raw`；`minJudgesForTrim`、`minSamplesForJudgeNormalization` ≥ 1 的整数；`judgePool.minJudgesPerDimension` > 0、`minEnterpriseSeatShare`/`maxExpertSeatShare` 0..1；`freeBrief.judgeDimension` 须是评委席维度 | 合法即可 ⇒ 需重算该赛段 |
| `tiebreak.json` | `chain[]` | 可调参数 | 有序链：须含 `total`、末项 `deterministic: true`、每项须带 `source`；`scope: tied_only` 的项须排在 `total` 之后 | 合法即可 ⇒ 需重算该赛段 |
| `ranks.json` | `tiers[].minMilestones`、`demotion.*`、`benefits` | 可调参数 | 段位门槛必须**严格递增** | 合法即可 ⇒ 需重算段位 |
| `behavior-points.json` | `completionThreshold`、`maxWeightShare`、`events[].points`、`events[].cadence` | 可调参数 | `completionThreshold` 0..100；`maxWeightShare` 0..1；每个事件 `points` > 0 且**必须有 `once` 次数约束**（否则可无限提交刷分） | 合法即可 ⇒ 需重算完赛认定 |
| `visibility.json` | `rank.*`、`business.*`、`peerReview.*` | 可调参数 | `publicFromTier` / `privateBelowTier` 必须引用**真实存在**的段位 | 合法即可 ⇒ **读时过滤，不需重算数据**（但改文件仍**需重启服务**） |
| `registration-scoring.json` | `dimensions[].weight`、`levels[].minScore`、`questions.*`、`scale`、`openQuestion` | 可调参数 | 权重合计 = 1；等级阈值必须**单调不增** | 合法即可 ⇒ 需重算报名分级 |
| `solvability.json` | `dimensions[].weight`、`grades[].minScore/maxScore`、`vetoes[]`、`taskMix.*` | 可调参数 | 权重合计 = 1；A/B/C/D 区间**互不重叠**；`vetoes` 非空且 `auto.dimension` 须指向真实维度 | 合法即可 ⇒ 需重算任务卡分级 |
| `milestones.default.json` | `items[]`、`signoffRequires` | 可调参数 | `confirmedBy` ∈ `enterprise`/`judge`；至少一个 `countsTowardTier: true` | 合法即可 ⇒ 只影响**新报名队**（清单报名时固定） |
| `team-formation.json` | `teamSize.min/max`、`teamsPerPackage.*`、`packageQuotaMix.*`、`singleMemberMergeDeadlineDays`、`memberChange` | 可调参数 | `teamSize.min` ≥ 2 且 `max` ≥ `min`；`packageQuotaMix` 合计 = 1 | 合法即可 ⇒ 需重算分组 |
| `schedule.json` | `stages[].start/end`、`advancement.rate`、`advancement.finalTopN` | 可调参数 | 相邻段不得重叠；`end` 不得早于 `start` | 合法即可 ⇒ 需重算赛段 |
| `compliance.json` | `ipOwnership.*`、`redLines[]`、`consent` | 可调参数 | `redLines` **不得为空**；`ipOwnership.team` 不得缺失 | 合法即可 ⇒ 展示层口径 |
| `points.json` | `stagePoints`、`stagePointsOnlyTopN`、`personal.*`、`prizeStructure.*`、`demoDayAudienceVote.*`、`fallbackPolicy` | 可调参数 | `stagePointsOnlyTopN` 须 = `stagePoints.length`；`personal.atomicKinds` / `rollupKind` 须取自合法积分 kind | 合法即可 ⇒ 需重算榜单与积分 |
| `criteria.json` | `tier.*`、`behaviorEvidence.*`、`enterpriseCompliance.*` | 可调参数 | `mvp.tiebreak` 末位固定（见上）；`businessDepartmentKeywords` 非空 | 合法即可 ⇒ 需重算 |
| `pools.json` | `packageStatusFilter`、`resourceKinds`、`publicScopes`、`publicTokenTtlDays`、`workflow.*` | 可调参数 | `publicScopes` 必须含 `all`；状态/资源类型须取自合法枚举；`publicTokenTtlDays` 正整数 | 合法即可 ⇒ 需重算池 |
| `audit.json` | `rateLimit.*`、`antiCheat.*`、`retention.archiveMonths`、`reviewState.appealAllowedTiers` | 可调参数 | `lock.mode` ∈ `cooldown`/`mutex`；各 `max` 为正整数；`lowVariance.min < max`；`identicalPeer.minOverlap` ≥ 2；`archiveMonths` 正整数 | 合法即可 ⇒ 需重算审计判定 |

> **改规则的正确姿势**：先看它在上表是**可调参数**还是**不变量声明**。是「不变量声明」就别改 —— 那是已定的赛制口径，不是可调参数；要改赛制，改的是上游文档（任务书 / S7 / S10）与 `docs/rule-decisions.md` 的裁决，不是这份 JSON。

## 文档

- 设计文档：`docs/superpowers/specs/2026-10-20-heikesong-platform-design.md`
- 需求落地表：`docs/requirement-implementation-map.md`
- 规则冲突登记：`docs/rule-decisions.md`
- 组委会确认清单：``
- 部署运维手册：`docs/deployment.md`

## 许可

见 [LICENSE](LICENSE)。

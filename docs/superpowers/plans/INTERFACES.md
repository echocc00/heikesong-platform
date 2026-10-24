# 跨阶段接口契约（P0–P6）

> **为什么有这份文件**：P0–P6 是**严格串行**执行的——每个阶段消费上一阶段的产物。
> 如果各计划各自定义接口，六份文档合并时会撞名、撞签名、撞表结构。
> **这份文件是跨阶段的唯一事实来源**：各计划里出现的签名，与本文件冲突时以本文件为准。
>
> **变更纪律**：改动本文件 = 改动接口 = 后面所有阶段都要改。改之前先想清楚。

---

## 0. 通用纪律（所有阶段逐字遵守）

| 项 | 约定 |
|---|---|
| 模块格式 | ESM（`package.json` 有 `"type":"module"`），导入用 `import ... from './x.js'`（**带扩展名**） |
| 导出形式 | 命名导出（named export）。不写 `export default` |
| 领域层 | `src/domain/*` 是**纯函数**：无 IO、无 `Date.now()`、无 `Math.random()`。时间与随机数一律由参数传入 |
| 数据层 | 所有 SQL 收在 `src/db/repo/*.js`。handler / service 里**不出现 SQL 字符串** |
| 时间 | 统一传 `now`（ISO 字符串或 `Date`），不直接调 `new Date()`（领域层）或 `Date.now()`（服务层用 `now ?? new Date().toISOString()`） |
| 随机数 | 领域层需要随机时传 `rng` 参数，默认 `Math.random` |
| 错误 | 抛 `AppError`（`status` + `code` + `message` + `detail`，**status-first**），由 HTTP 层转成 `error(res, status, code, message, detail)`。类型定义在 `src/errors.js`（**P0 建立**，P1–P6 全部复用，禁止再新建第二套） |
| 权限 | 判定只有 `can(user, capability, ctx, db)` 一个入口。SQL 层过滤用 `scopeClause(...)` —— 两者**必须给出相同结论**（超管 / role_capability 授权一律不做行级过滤） |
| 规则 | 可变规则一律进 `rules/*.json`。代码里出现魔法数字 = 违规（例外：算法常量如 `100` 分制上限） |
| 溯源 | 每条规则逻辑的注释写明来源文档与章节，例：`// S7 §3.1` |
| 状态码 | 列表不满足 → `200` + 空集；单条不满足 → `404`；规则被禁用 → `403` |
| 软删除 | 业务表带 `deleted_at`（可空）。删除 = 写时间戳，不删行 |
| 追加式 | 评分/签字类记录**只增不改**。更正走新记录 + `supersedes_id` |
| ID | 统一 `crypto.randomUUID()`，字符串主键 |

---

## 1. P0 产出（上游基线，不可改）

```js
// src/db/sqlite.js
openDatabase({ dataDir, filename, walRetryBudgetMs? })  // → { db, close() }，已开 WAL + foreign_keys + busy_timeout=5000
//   walRetryBudgetMs：切 WAL 时的**重试预算**（毫秒，默认 5000）。**可选参数**。
//   ⚠️ **不传 ≠ 原语义**（P4 终审 Minor M-1 实测纠正）：旧实现锁竞争时 **0ms 即失败**，
//      现在最多等 5s 再失败 —— 签名向后兼容成立，但**行为语义已变**（fail-fast → 有界等待）。
//   ⚠️ 切 journal_mode 需要**独占锁**；**别的连接持有写事务（RESERVED 锁）时**，
//      SQLite 的 busy handler **在这一种锁型上不生效**
//      （实测：该 PRAGMA 0ms 即抛 SQLITE_BUSY，busy_timeout 对它无效）
//      ⇒ 连接层必须自实现退避重试，否则「两条连接同时首开同一个新库」必有一方失败。
//      ⚠️ 限定条件（M-2）：并非无条件 —— 别的连接持 **EXCLUSIVE** 锁时 busy handler **仍会**等待
//      （实测 busy_timeout=5000 等 5485ms、=1000 等 1129ms，随 busy_timeout 线性缩放）。

// src/http/optional-module.js（P4 新建）
loadOptionalModule(specifier, targetPath)  // → Promise<模块命名空间 | null>
//   specifier 必须是**绝对 file:// URL**（动态 import 的解析基准是本文件，不是调用方）。
//   targetPath 是该模块在磁盘上的绝对路径。
//   → 模块在 → 返回命名空间；**目标模块本身不存在** → 返回 null（调用方据此 fail closed）。
//   → 目标在场却加载失败（加载期抛错 / 传递依赖缺失）→ **抛出去**，不装成「未落地」
//     （P4 终审 Important I-2：无差别 catch {} 会把「模块在场但自己炸了」
//      误报成「模块未落地」，fail closed 成立但诊断是假的）。

// src/db/migrate.js
applyMigrations(db, migrationsDir)       // → { applied: string[], version: number }
readMigrationFiles(dir)                  // → [{ version, name, sql }]

// src/config.js
loadRules(rulesDir)                      // → { rules, version }，校验不过抛错
validateRules(rules)                     // → string[]，空数组 = 通过
// rules 命名空间：
//   rules.scoring.initial / rules.scoring.final / rules.tiebreak / rules.ranks
//   rules.behavior / rules.visibility / rules.registration / rules.solvability / rules.milestones

// src/http/router.js
createRouter()                           // → { add(method, pattern, handler), match(method, path), list() }
//   pattern 形如 '/api/teams/:teamId/members'；:param 占位

// src/http/respond.js
json(res, status, body, extraHeaders)
text(res, status, body)
error(res, status, code, message, detail)

// src/http/body.js
readJsonBody(req, { limit })             // → 解析后的对象；超限抛错

// src/http/static.js
serveStatic(webDir, req, res)            // → boolean（已处理则 true）
isSameFile(statA, statB)                 // → boolean（dev + ino 对账；单独导出是为了能直接测边界）
pipeFd(res, fd)                          // → ReadStream（读流必须挂 error 监听）

// src/auth/password.js
hashPassword(plain)                      // → 'scrypt$N$r$p$saltB64$hashB64'
verifyPassword(plain, stored)            // → boolean

// src/auth/session.js
createSession(db, userId, { ttlDays, absoluteTtlDays, now })   // → { token, expiresAt }
resolveSession(db, token, { now, ttlDays, absoluteTtlDays })    // → { userId, expiresAt } | null
// ⚠️ 绝对过期（设计文档 §7.5）：从**签发时刻**算起的硬上限（默认 30 天，SESSION_ABSOLUTE_TTL_DAYS 可覆盖），
//    滑动续期不得突破它。缺了这条，令牌泄露即可无限续命。
revokeSession(db, token)
revokeAllSessions(db, userId)

// src/auth/permissions.js
can(user, capability, ctx, db)           // → boolean（唯一入口）
scopeClause(userId, capability, { scopeType, scopeId, alias })  // → { sql, params }
// ⚠️ scopeClause 与 can() 必须一致：超管与 role_capability 授权**不做行级过滤**（全部行可见），
//    停用用户一律不可见。两者若给出相反结论，P3/P4 的列表接口会出现「有权限却空列表」。
grantAssignment(db, { userId, capability, scopeType, scopeId, grantedBy })
// ⚠️ 授权前校验：capability 未注册 → 400 CAPABILITY_UNKNOWN；user 不存在 → 404 USER_NOT_FOUND。
//    不校验就会把 SQLite 原始外键错误漏到 HTTP 层（只能回 500，且泄露表结构）。
revokeAssignment(db, assignmentId)
listAssignments(db, { userId, capability })

// src/server.js
createApp({ db, rules, webDir })         // → { router, handle(req, res) }
//   handler 返回约定（2026-10-20 补）：handler 返回 undefined → 视为 200；
//   返回 { status, body }（可选 headers 附加响应头）→ 按返回的状态码/响应体/响应头应答。
```

> **【订正 2026-10-21】** `serveStatic` 原先被列在 `// src/server.js` 段下 ——
> 它实际住在 `platform/src/http/static.js`（终审复核 Minor F-6）。
> P1–P6 若按旧表述去 `src/server.js` 里找它，会找不到。


**P0 已建表**（`001_init.sql`，**只有这一个迁移文件**）：`users` / `sessions` / `capabilities` / `roles` / `role_capabilities` / `assignments` / `user_roles` / `audit_log`

> **⚠️ 迁移版本号是全局唯一序位，002 起依次是 P1→P5**。
> 曾出现过 P0 建 `002_user_roles.sql` 与 P1 建 `002_registration.sql` 抢同一个版本号的问题——`applyMigrations` 按 version 去重，**后执行的那张表永远建不出来**。已修法：`user_roles` 并入 P0 的 `001_init.sql`，P0 不再单独开迁移。
> **执行任何阶段前先确认 `platform/db/migrations/` 里的版本号无重复。**

**P0 已有规则文件**（9 份，内容见 P0 计划 Task 3）：`scoring-initial` / `scoring-final` / `tiebreak` / `ranks` / `behavior-points` / `visibility` / `registration-scoring` / `solvability` / `milestones.default`

---

## 2. P1 产出（报名与组队）

### 迁移 `db/migrations/002_registration.sql`

```sql
editions(id, name, city, starts_at, ends_at, created_at)
cities(id, name, edition_id)
task_packages(id, edition_id, enterprise_id, enterprise_name, title, pain_point,
              expected_delivery, acceptance_criteria, grade, status,
              solvability_score, solvability_grade, commitment, agreement,
              is_free_brief INTEGER, submitted_by, submitted_at, approved_by, approved_at,
              deleted_at)
registrations(id, edition_id, user_id, answers_json, dimension_scores_json,
              raw_score REAL, level, level_final, decided_by, decided_at, decision_note,
              status, created_at, deleted_at)
registration_events(id, registration_id, from_status, to_status, actor_id, reason, created_at)
teams(id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
team_members(team_id, user_id, role, joined_at, left_at)
```

### 新增规则文件 `rules/team-formation.json`

```json
{
  "id": "team-formation",
  "version": "2026-10-20",
  "source": "任务书 §六 组队规则 + 顶层文档 §3.1",
  "teamSize": { "min": 2, "max": 5 },
  "captainMustBeMba": true,
  "teamsPerPackage": { "min": 2, "max": 3 },
  "packageQuotaMix": { "enterprise": 0.70, "free": 0.30 },
  "memberChange": { "allowedDuringStage": true, "requireCaptainOrAdmin": true },
  "singleMemberTriggersMerge": true,
  "singleMemberMergeDeadlineDays": 3
}
```

### 领域层（纯函数）

```js
// src/domain/registration.js
scoreRegistration({ answers, config })
  // answers: { direction: number[5], capability: number[5], collaboration: number[5], open: string }
  // → { score, dimensionScores: {direction, capability, collaboration},
  //     level, accepted, explain: [{dimension, raw, weight, weighted, note}] }
classifyLevel(score, config)          // → 'S' | 'A' | 'B' | 'C'
validateRegistrationAnswers(answers, config)  // → string[]（错误信息，空 = 通过）

// src/domain/solvability.js
scoreSolvability({ answers, config })
  // answers: { problem_clarity: 0..3, data_access: 0..3, validation: 0..2,
  //            decision_chain: 0..1, accountability: 0..1, precedent: 0..1 }
  // → { score, grade, vetoes: string[], commitment, agreement, explain: [...] }
  //   grade=D 或任一 veto 命中 → commitment='无'，但仍必须出诊断报告（不静默丢弃）
```

### 服务层

```js
// src/services/registration.js
submitRegistration({ db, userId, editionId, answers, now })  // → registration
getRegistration({ db, id, viewer })                          // → registration | null
listRegistrations({ db, filter, viewer })                   // → registration[]
decideRegistration({ db, id, level, decidedBy, note, now })  // → registration（写 registration_events）
// 幂等：同一 userId + editionId 重复提交 → 409，不静默覆盖

// src/services/team.js
createTeam({ db, userId, editionId, taskPackageId, name, now })  // → team
getTeam({ db, id, viewer })
addMember({ db, teamId, userId, actorId, now })
leaveTeam({ db, teamId, userId, now })
replaceMember({ db, teamId, outUserId, inUserId, actorId, now })   // 汰换
updateTeam({ db, teamId, patch, actorId, now })
checkTeamFormation({ team, captain, members, taskPackage, config })  // → { ok, errors: string[] }

// src/services/taskPackage.js
submitTaskPackage({ db, userId, payload, now })
assessSolvability({ db, taskPackageId, answers, actorId, now })
approveTaskPackage({ db, taskPackageId, grade, actorId, now })
listTaskPackages({ db, filter, viewer })
```

### API（P1）

```
POST   /api/registrations
GET    /api/registrations              （列表，需 admin 能力）
GET    /api/registrations/:id
POST   /api/registrations/:id/level
POST   /api/teams
GET    /api/teams/:id
POST   /api/teams/:id/members
PATCH  /api/teams/:id
POST   /api/task-packages
GET    /api/task-packages
POST   /api/task-packages/:id/solvability
POST   /api/task-packages/:id/approve
```

---

## 3. P2 产出（评审引擎）★ 核心

### 迁移 `db/migrations/003_review.sql`

```sql
stages(id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
stage_judges(stage_id, user_id, seat, scope_type, scope_id, assigned_at)
stage_reviews(id, stage_id, judge_id, team_id, dimension, raw_score REAL,
              submitted_at, request_id, calibrated INTEGER DEFAULT 0, deleted_at)
   -- UNIQUE(stage_id, judge_id, team_id, dimension)  防重复灌分
calibrations(id, stage_id, judge_id, dimension, raw_score, created_at)
enterprise_confirmations(id, stage_id, team_id, enterprise_id, dimension, raw_score REAL,
                          cross_judge_id, signatory_user_id, created_at, deleted_at)
peer_reviews(id, stage_id, from_team_id, to_team_id, score REAL, request_id, created_at)
   -- UNIQUE(stage_id, from_team_id, to_team_id)  一队对另一队只投一次
self_reviews(id, stage_id, team_id, dimension, raw_score REAL, submitted_at, request_id)
score_stats(judge_id, dimension, n INTEGER, mean REAL, sum_sq REAL, updated_at,
            PRIMARY KEY(judge_id, dimension))
recusal_records(id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
computation_snapshots(id, kind, edition_id, stage_id, team_id, rule_version,
                      input_json, output_json, trace_json, revision INTEGER, created_at)
stage_results(id, stage_id, team_id, rank INTEGER, total REAL, seat_p REAL, seat_e REAL,
              tied_with INTEGER, points REAL, computation_id, created_at)
```

### 领域层（纯函数）★ 本阶段是全项目最重要的部分

```js
// src/domain/normalization.js
normalizeScores({ samples, strategy, config })
  // samples: [{ judgeId, value }]，同一 (评委, 维度) 内的一组原始分
  // strategy: 'zscore' | 'median' | 'trimmed' | 'bayes'
  // → { normalized: boolean, values: { [judgeId]: number },
  //     fallbackReason: string|null, stats: { n, mean, stdev } }
  // 样本 < config.minSamplesForJudgeNormalization → 退回全局口径，normalized=false 且必须带 fallbackReason
  // stdev === 0 → 该评委该维度值记 0，fallbackReason='zero_stdev'

// src/domain/scoring.js
scoreStage({ config, judges, submissions, enterpriseConfirmations, peerReviews })
  // ⚠️ 入参对象中【不存在】行为分字段。传入也被丢弃。
  // config: rules.scoring.initial 或 rules.scoring.final
  // submissions: [{ judgeId, teamId, dimension, rawScore }]
  // → { teams: [{ teamId, seatP, seatE, total, perDimension: {key: {weight, raw, z, mean}} }],
  //     warnings: [{ code, message, teamId?, dimension? }],
  //     trace: { normalization: {...}, steps: [...], weights: {...}, perTeam: {...} } }
  // 降级一律进 warnings，绝不静默

// src/domain/enterprise-seat.js
applyEnterpriseRules({ confirmations, teams, judges, config })
  // R1 非本赛道 → 该队企业项权重置 0
  // R2 缺双签（出题企业签字 or 跨领域评委签字）→ 按 0 分计 + warning
  // R3 企业席合计权重 ≤ config.wEnterprise
  // R4 自由命题组无企业签字 → 企业项改由评委按"需求真实性"证据打分
  // → { seatE: { [teamId]: number }, weights: {...}, warnings: [...] }

// src/domain/self-eval.js
detectSelfEvalDiff({ selfReviews, judgeScores, threshold })
  // d = 自评分 − 评委分（同一尺度）；|d| ≤ threshold → 无影响
  // d > threshold → action 'written_explanation'（要书面说明）
  // d < −threshold → action 'judge_question'（只提问不改分）
  // → { flags: [{ teamId, dimension, d, action }] }

// src/domain/trim.js
trimOutliers({ values, minJudges })
  // values: [{ judgeId, z }]；去一个最高一个最低后取均值
  // 有效评委数 < minJudges → 不去极值
  // → { mean, trimmed: boolean, removed: { max: judgeId|null, min: judgeId|null } }

// src/domain/review-eligibility.js
checkPeerEligibility({ teams, deliverables })   // → { eligible: string[], ineligible: [...] }
checkRecusal({ judge, team, recusalRecords })   // → { recused: boolean, record? }
```

### 服务层

```js
// src/services/review.js
submitReviews({ db, stageId, judgeId, items, requestId, now })
  // items: [{ teamId, dimension, rawScore }]
  // 幂等：同一 requestId 重复提交只生效一次
  // 写 stage_reviews + 增量更新 score_stats
  // 写 audit_log(action='review.submit')
getReviewState({ db, stageId, viewer })     // → { submitted, total, missing: [...], dimensionProgress }
submitCalibration({ db, stageId, judgeId, items, now })   // calibrated=1，不计入评分
submitPeerReviews({ db, stageId, items, requestId, now })
submitSelfReviews({ db, stageId, teamId, items, requestId, now })
declareRecusal({ db, stageId, judgeId, teamId, reason, actorId, now })

// src/services/compute.js
computeStage({ db, stageId, actorId, now })
  // → { computationId, teams, warnings, trace }
  // 纯函数计算 → 写 computation_snapshots（含 input/output/trace）→ 写 stage_results
  // 显式动作，不自动触发
```

### API（P2）

```
POST /api/stages/:stageId/reviews
GET  /api/stages/:stageId/review-state
POST /api/stages/:stageId/calibration
POST /api/stages/:stageId/peer-reviews
POST /api/stages/:stageId/self-review
POST /api/stages/:stageId/compute
GET  /api/stages/:stageId/computations/:computationId   （trace 三件套）
POST /api/stages/:stageId/recusals
GET  /api/stages/:stageId/events                       （SSE：评审进度推送）
```

> **【订正 2026-10-21 漂移审计 I-6】** 上面这一条 SSE 端点是**新增**的 —— P0 的
> `platform/web/api.js:28-30` 的 `subscribe()` 明写「⚠️ SSE 端点在 **P2** 才实现
> （`src/http/sse.js`）」，而 P2–P6 五份计划**全都没有承接**这个承诺
> （`grep -c 'sse\.js'` 五份全为 0）→ 一条**指向不存在实现的活引用**。
> 现由 **P2 的 Task 9** 落地，模块与端点如下：
> ```js
> // src/http/sse.js  （P2 Task 9 新建）
> parseSsePath(url)                // → { stageId } | null
> openSseStream(res)               // 写 200 + text/event-stream 响应头
> sendSseEvent(res, event, data)   // 写一帧：event: <name>\ndata: <单行 JSON>\n\n
> closeSseStream(res)              // 结束响应
> createSseHub()                   // → { add, remove, publish, size, closeAll }
> reviewEvents                     // 评审进度事件中心（createSseHub() 的单例）
> ```
> ⚠️ SSE **不挂 router**（P0 的 router handler 约定是「返回值 → server.js 统一 json()
> 序列化并结束响应」，而 SSE 要长期持有连接）→ 走 `src/server.js` 里**独立于 router** 的分支，
> 放在 `router.match` **之前**（SSE 路径不在 router 里，先 match 会直接走 404）。
> 端点需登录；事件：`connected`（订阅确认首帧）/ `review.progress`。

---

## 4. P3 产出（榜单与积分）★ 核心

### 迁移 `db/migrations/004_leaderboard.sql`

```sql
points_ledger(id, edition_id, stage_id, team_id, user_id, kind, points REAL, created_at)
   -- kind: stage_rank | mvp | roadshow | personal_rollup
tier_records(id, team_id, tier, milestone_count, business_signoff_count, reasons_json,
             computed_at, deleted_at)
behavior_events(id, team_id, user_id, type, points REAL, evidence, created_at, subject_id)
   -- subject_id: 按主体计次的事件（M0-1：交付里程碑）挂的里程碑 id；其余事件为 NULL
leaderboard_snapshots(id, edition_id, stage_id, scope, payload_json, created_at)
```

### 新增规则文件 `rules/points.json`

```json
{
  "id": "points",
  "version": "2026-10-20",
  "source": "任务书 §七 + S10 §3.3",
  "stagePoints": [10, 8, 5],
  "stagePointsOnlyTopN": 3,
  "mvp": { "stagesCounted": 4, "roadshowWeight": 1.0, "perPackage": 1 },
  "personal": {
    "lifetime": true,
    "includeMvpVote": true,
    "atomicKinds": ["stage_rank", "mvp", "roadshow"],
    "rollupKind": "personal_rollup"
  },
  "tieRankStyle": "1224"
}
```

> ⚠️ **P5 修复轮（2026-10-21）追加**：`personal` 组多了 `atomicKinds` / `rollupKind`。
> 原因：R-RNK-10「个人积分终生上榜」曾有**两套独立实现**（`src/domain/points.js` 的
> `computePersonalPoints` 与 `src/domain/pool-derive.js` 的 `aggregatePersonalPoints`），
> 读**不同的规则文件**、按**不同的口径**算 —— 同一份流水能算出两个不同的名次。
> 现在口径收敛到**唯一**计算点 `src/domain/personal-points.js`，
> 规则来源也收敛到**本文件这一处**（`personal.atomicKinds` = 计入的原子 kind 白名单，
> `personal.rollupKind` = 汇总快照的 kind；有 rollup 行则以 rollup 为准）。

### 领域层（纯函数）

```js
// src/domain/ranking.js
rankTeams({ teams, tiebreakChain, tiebreakData, pointsConfig })
  // teams: [{ teamId, total, seatP, seatE, peerScore, enterpriseRaw, behaviorScore }]
  // tiebreakChain: rules.tiebreak.chain
  // → { ordered: [{ teamId, rank, total, tiedWith: string[] }],
  //     tieGroups: [[teamId,...]], rankStyle }
  // 1224 式并列名次：1,1,3（不是 1,1,2）
applyTiebreakChain({ candidates, chain, data })
  // 按链顺序逐项比较；scope: always / tied_only / final_only
  // 最后必须落到确定性兜底项（team_id）
  // → { ordered, applied: [{key, usedBy}] }

// src/domain/points.js
stagePointsFor(rank, pointsConfig)          // → 10 / 8 / 5 / 0
computeStagePoints({ ordered, pointsConfig })// → [{ teamId, points }]
computeMvp({ stagePoints, roadshowScores, packageId, pointsConfig })
  // 每个任务包 1 个 MVP = 4 赛段总积分 + S4 路演评审综合
computePersonalPoints({ ledger, pointsConfig })

// src/domain/tier.js
computeTier({ milestones, signoffs, ranksConfig })
  // milestones: [{ key, countsTowardTier, achieved }]
  // signoffs: [{ milestoneKey, department, revokedAt }]
  // → { tier, milestoneCount, businessSignoffCount, reasons: [], benefits: [] }
  // S 档只认【企业业务部门】签字；技术部门签字不计入
applyTierDemotion({ tier, daysSinceLastActivity, revokedSignoffs, ranksConfig })
  // → { tier, demoted, reason }（连续 14 天零提交 → 降 1 档；撤回签字 → 降回对应档）

// src/domain/behavior.js
behaviorScore({ events, behaviorConfig })
  // → { total, items: [{type, points, label}], completed: boolean }
  // completed = total >= completionThreshold（60）

// src/domain/visibility.js
applyVisibility({ payload, viewer, visibilityConfig, context })
  // 在 API 层过滤。前端拿不到无权数据。
  // 段位榜：C 段及以上显示队名名次；D 段不公示排名（只给本人进度卡）
  // B 榜：里程碑公开；评分与签字人【不公开】；企业名不公示；互评来源不公示
  // → 过滤后的 payload
```

### 服务层

```js
// src/services/leaderboard.js
getLeaderboard({ db, stageId, scope, viewer })    // scope: 'rank'|'business'|'personal'
getRollingLeaderboard({ db, editionId, viewer })
publishLeaderboard({ db, editionId, stageId, actorId, now })  // 写 leaderboard_snapshots

// src/services/performance-card.js
getPerformanceCard({ db, teamId, viewer })
// src/services/tier.js
getTeamTier({ db, teamId, viewer })
```

### API（P3）

```
GET  /api/leaderboard/:stageId?scope=rank|business|personal
GET  /api/leaderboard/rolling?editionId=
GET  /api/teams/:id/performance-card
GET  /api/teams/:id/tier
```

---

## 5. P4 产出（审计与防作弊）

### 迁移 `db/migrations/005_audit.sql`

```sql
flagged_reviews(id, stage_id, submission_id, team_id, judge_id, kind, detail_json,
                status, reviewed_by, reviewed_at, created_at)
   -- kind: self_vs_judge | burst_submit | identical_peer_pattern | low_variance | multi_account
idempotency_keys(key, scope, request_id, response_json, created_at, PRIMARY KEY(key, scope))
rate_limit_events(id, subject_key, rule, bucket, count, window_start, updated_at)
appeals(id, subject_type, subject_id, filed_by, reason, status, decided_by, decided_at,
        decision_note, created_at)
   -- status: submitted | reviewing | accepted | rejected | withdrawn
```

### 服务层与领域层

```js
// src/services/audit.js
recordComputation({ db, kind, editionId, stageId, teamId, ruleVersion, input, output, trace })
  // → { id, revision }
getComputation({ db, id, viewer })      // → { id, kind, ruleVersion, input, output, trace, createdAt }
recomputeAndDiff({ db, id, actorId, now })
  // 用快照里的 input 重新跑一次纯函数引擎 → 与 output 比对
  // → { identical: boolean, diff: [{path, before, after}], warnings }
listAuditLog({ db, filter, viewer })

// src/services/rate-limit.js
checkRateLimit({ db, subjectKey, rule, now })
  // 三层：滑动窗口计数 + 提交锁 + 每分钟配额 + 评委级每小时配额
  // → { allowed: boolean, remaining: number, retryAfterSeconds: number }
assertRateLimit(...)   // 不通过抛 AppError(429)

// src/services/review-state.js
transition({ db, subjectType, subjectId, from, to, actorId, reason, idempotencyKey, now })
  // SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED
  //             ↘ REJECTED ←（选手申诉）──┘
  //             ↘ FLAGGED → REJECTED | CONFIRMED
  // 幂等守卫：同一 idempotencyKey 重复触发不产生二次迁移
  // 每次迁移写 audit_log(from_state, to_state, reason)

// src/domain/anticheat.js
detectIdenticalPeerPattern({ peerReviews })   // 两位评委对重叠项目给出完全相同相对顺序
detectBurstSubmission({ events, windowSeconds })
detectLowVariance({ scoreStats, threshold })
detectMultiAccount({ users, keyFields })      // 同一手机号/企业注册多账号
```

### API（P4）

```
GET  /api/audit/computations/:id
POST /api/audit/computations/:id/diff
GET  /api/audit/log
GET  /api/audit/flags
POST /api/audit/flags/:id/resolve
POST /api/appeals
POST /api/appeals/:id/decide
```

### 脚本

```
scripts/audit-scan.js   发布前证据链扫描闸（读 scripts/forbidden.txt）
```

---

## 6. P5 产出（工作流与三池）

### 迁移 `db/migrations/006_pools.sql`

```sql
workflows(id, edition_id, task_package_id, name, created_at)
workflow_tasks(id, workflow_id, title, detail, owner_team_id, status, due_at, created_at)
   -- status: todo | in_progress | done | blocked
task_claims(id, task_id, team_id, user_id, claimed_at, released_at)
pool_projects(id, edition_id, team_id, title, industry, stage_reached, tier,
              business_value, summary, created_at)
pool_talents(id, user_id, edition_id, name, org, total_points, mba_status,
             stages_joined, skills_json, created_at)
pool_resources(id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at)
public_tokens(token, scope, edition_id, expires_at, created_at)
```

### 服务层

```js
// src/services/workflow.js
listWorkflowTasks({ db, workflowId, viewer })
claimTask({ db, taskId, userId, teamId, now })    // 唯一约束防重复领取
releaseTask({ db, taskId, userId, now })
completeTask({ db, taskId, userId, now, evidence })

// src/services/pools.js
syncPoolProjects({ db, editionId, now })     // 从 teams + stage_results + tier_records 派生
syncPoolTalents({ db, editionId, now })      // 从 points_ledger 聚合
syncPoolResources({ db, editionId, now })    // 从 task_packages 派生
listPoolProjects({ db, filter, viewer })
listPoolTalents({ db, filter, viewer })
listPoolResources({ db, filter, viewer })

// src/services/public-api.js
getPublicLeaderboard({ db, token, editionId })   // 无登录，token 鉴权
buildICalendar({ db, editionId })               // → ics 文本
```

### API（P5）

```
GET  /api/workflows/:id/tasks
POST /api/tasks/:id/claim
POST /api/tasks/:id/release
GET  /api/pools/projects
GET  /api/pools/talents
GET  /api/pools/resources
POST /api/pools/sync
GET  /api/public/leaderboard?editionId=&token=
GET  /api/public/calendar.ics?editionId=&token=
```

---

## 7. P6 产出（部署与演示版）

```
deploy/heikesong.service     systemd 守护
deploy/nginx.conf            反代 + TLS + 静态缓存 + SSE 关缓冲
deploy/docker-compose.yml    单容器编排
deploy/install.sh            一键：装 Node → 写 service → 配 nginx → 建库 → 初始化管理员
scripts/backup.js            sqlite.backup() API 一致性备份 + 保留策略
scripts/restore.js           从备份恢复（需先停服务）
scripts/audit-scan.js        发布前扫描闸
web/seed/demo-data.json      演示种子数据
web/api.demo.js              扩展：浏览器内真实跑规则引擎
docs/deployment.md           部署与运维手册
```

> **【订正 2026-10-21 漂移审计 C-5】** P6 的 Task 1 会**追加**一个导出到 P0 已建的
> `platform/src/db/migrate.js`：
> ```js
> // src/db/migrate.js —— P6 Task 1 追加（P0 已建，本阶段只追加，不改 applyMigrations 的签名与行为）
> currentVersion(db)            // → number | null（schema_migrations 里的 MAX(version)；没迁移过时 null）
> ```
> `scripts/restore.js` 用它读「备份对应哪个 schema 版本」——
> ⚛️ **不能在 `scripts/` 里自己写 SQL**：全局约束「所有 SQL 收进 `src/db/repo/`」，
> 而 `src/db/migrate.js` 是 `platform/test/sql-boundary.test.js` 守卫的**唯一豁免文件**
> （守卫扫描 `src/` **与 `scripts/`**）。
>
> **【订正 2026-10-21 漂移审计 I-5】** P6 的 `deploy/heikesong.service` 与
> `deploy/docker-compose.yml` **绝对不得**设置 `DEMO_MODE=1` ——
> 该变量会让 `/src/domain/*`（领域层算法源码）与 `/rules/*`（全部规则配置）
> 挂到 HTTP 上。它只给本地预览（`scripts/serve-demo.js`）与开发服务器用；
> 生产部署下这两个路径一律 404。

### 7.1 P6 追加：账号凭据服务与两个认证端点（2026-10-22）

> **为什么追加**：口令是 `scripts/seed.js` **一次定死**的（幂等、不覆盖已有管理员），
> 而平台**没有改口令端点** ⇒ 部署方只能一直用 seed 出来的初始口令（哪怕它已出现在日志/截图/聊天里）。
> 这是**每次部署都会撞上**的产品缺口。
> 同时兑现设计文档 §7.5 早就写好、却一直没实现的「强制下线」。

```js
// src/services/auth.js —— P6 新建（跨阶段签名以本节为准）
PASSWORD_MIN_LENGTH                              // → 8
PASSWORD_MAX_LENGTH                              // → 128（防超长口令把 scrypt 拖成 DoS）
checkPasswordPolicy(newPassword)                 // → { ok, code?, message? }
changePassword({ db, userId, oldPassword, newPassword, keepSessionToken })
//   → { ok: true, revokedSessions }
//   错误：原口令错 → 401 INVALID_CREDENTIALS；策略不通过 → 400 PASSWORD_*；
//         与原口令相同 → 400 PASSWORD_REUSED；用户不存在/停用 → 401 UNAUTHENTICATED
logoutAllSessions({ db, userId })                // → { ok: true, revokedSessions }

// src/auth/session.js —— P0 已建，本阶段**追加**（不改既有签名与行为）
revokeAllSessionsExcept(db, userId, exceptToken) // → number（保留 exceptToken 那一个，其余全删）

// src/db/repo/users.js —— P0 已建，本阶段**追加**
getCredentialsById(db, id)                       // → { id, password_hash, active } | null
updatePasswordHash(db, userId, passwordHash)     // → number（受影响行数；**只改口令**）

// src/db/repo/sessions.js —— P0 已建，本阶段**追加**
deleteSessionsByUserExcept(db, userId, exceptHash)  // → number
```

```
API（P6 追加）
  POST   /api/auth/password     { oldPassword, newPassword }
         → 200 { ok: true, revokedSessions }
         → 401 INVALID_CREDENTIALS（原口令错）/ 401 UNAUTHENTICATED（未登录）
         → 400 PASSWORD_REQUIRED / PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG / PASSWORD_REUSED
         ⚠️ 改完后**其它设备**的会话全部作废，当前这次**保留**（不把自己踢下线）。
  POST   /api/auth/logout-all
         → 200 { ok: true, revokedSessions }，并下发清空会话的 Set-Cookie
         ⚠️ 语义是「把他踢下线」⇒ **含当前会话**一起吊销（与改口令的差别就在这里）。
```

> ⚠️ **口令策略只约束「通过本端点新设」的口令**：存量账号（seed 出来的、历史导入的）
> 仍可照常登录 —— 不能因为新增一条策略就把老账号**锁死**在外。

---

### 7.2 E181/E182 追加：S-7~S-10 业务就绪度端点 + 申诉主体白名单（2026-10-27 / 2026-10-28）

> **为什么要有这一节**：本节追加的是 **P6 之后**（E181 / E182 两轮）新增的对外接口与契约。
> ⛔ **E181 的 `GET /api/readiness` 此前没有登记在本文件的任何一节** ⇒
>    「跨阶段接口契约」里查不到它 ⇒ 下一个按契约写代码的人根本不知道这个端点存在
>    ⇒ E182 · F7 修的就是这个洞（**端点存在 ≠ 契约存在**）。

```
迁移（E182 追加）
  db/migrations/011_behavior_event_subject_unique.sql
    CREATE UNIQUE INDEX ux_behavior_events_subject
      ON behavior_events(team_id, type, subject_id)
     WHERE subject_id IS NOT NULL;
    ⚠️ 「同一里程碑只记一次」的**数据库层**约束（服务层已对、DB 层此前缺）。
       ⚠️ 部分唯一索引（WHERE subject_id IS NOT NULL）：`subject_id` 只对
          countBy='milestone' 的事件有值 ⇒ 其余 once 类事件共用「终身一次」桶不受约束。
       ⚠️ 不删行不改行（behavior_events 是只增不改的审计型表）⇒ 若已有重复行，
          建索引**响亮失败** ⇒ 迁移回滚 ⇒ 部署被挡住 ⇒ 人来看。

API（E181 追加）
  GET    /api/readiness?editionId=<id>
         → 200 { now, editionId,
                 s7:  { teamCount, thresholdTeams, met, note },
                 s8:  { stageCount, measurableCount, worstStageId, worstCoveragePercent,
                        met, stages: [{ stageId, stageKey, stageName, status, statusNote,
                                        expected, submitted, coveragePercent, thresholdPercent,
                                        complete, overSubmitted, missingCount, missing[],
                                        byDimension{}, warnings[] }] },
                 s9:  { stageCount, overdueCount, overdueStageIds, met, deadlineHours,
                        stages: [{ stageId, stageKey, stageName, endsAt, publishedAt,
                                  rosterSize, deadlineHours, delayHours, overdue, state, note }] },
                 s10: { met: null, note } }
         → 401 UNAUTHENTICATED（未登录）
         → 403 FORBIDDEN（已登录但**无 `audit:read` 能力点** ⇒ **不是 200 + 空集** ——
             空集会被读成「各项都达标」，那是本端点最危险的误读方向）
         → 404 NOT_FOUND（**显式**指定了不存在的 `editionId` ⇒ 不静默退回「当届」）

服务层（E181 新建 / E182 修订）
  src/services/readiness.js
    readinessSummary({ db, editionId?, rules?, now? })   // → 上面的聚合结构（**唯一**对外出口）
```

⚠️ **`state` 的取值**（S-9，口径单一来源）：

| state | 含义 | overdue |
|---|---|---|
| `not_due` | 赛段尚未结束 | false |
| `no_roster` | 名册未登记 ⇒ 这段还没开打 ⇒ 不计入超期 | false |
| `never_published` | 一次都没发榜 | **按 72h 尺判**（见下） |
| `late` | 发过榜，但晚于时限 | true |
| `published` | 按时发榜 | false |
| `unknown_end` | 结束时间不可解析 ⇒ 不可判定 | false |

> ⛔ **`never_published` 与 `late` 同一把尺**（E182 · F3，2026-10-28）：
> 两者的 `overdue` 都按 `delayHours > publishDeadlineHours` 判
> （时限读 `rules/compliance.json` 的 `readiness.publishDeadlineHours`，默认 72 小时）
> ⇒ 修复前 `never_published` 是**无条件** `overdue: true` ⇒ 赛段结束 **1 小时**没发榜就报红，
> 而已发榜的同一时刻要 >72h 才算 late ⇒ **同一条 SLA 两种不对称判定**（试赛第一天就误报一片红）。
> ⚠️ 两个 state 仍是**两件事**：「一次都没发过」vs「发过但晚」⇒ 报告里要能分开看。

> ⚠️ **只导出一个函数**（E182 记的纪律）：`reviewCoverage` / `publishDeadlines` 保持**模块私有**
> —— 死服务扫描闸把「导出了但只有同文件调用」也算死函数 ⇒ 它们只能被 `readinessSummary` 调
> ⇒ **测试也必须走公开 API**（`readinessSummary`），不得直接调内部函数。

```
服务层契约修订（E182 · 2026-10-28）
  src/services/review-state.js
    APPEAL_SUBJECT_TYPES        // → ['team_result', 'registration']（**申诉主体类型的白名单**）
    fileAppeal({ db, subjectType?, subjectId, filedBy?, reason, reasonKind?, now?, rules })
      ⛔ subjectType 缺省仍是 'team_result'（既有契约，不改）
      ⛔ 传了**未知**的 subjectType ⇒ **400**（fail-closed）——
         修复前全链路没有白名单（表无 CHECK / 路由不校验 / 服务层只分两支）
         ⇒ 传 'foo' 会落进赛段结果分支、绕过程序性理由类型白名单、落库后无人按它分流
      ⛔ 程序性理由类型白名单的豁免**只限报名类**（`subjectType === 'registration'`）——
         修复前写的是 `subjectType !== 'team_result' && !kind` ⇒ 豁免的是「一切非 team_result」
```

> ⚠️ **演示适配器必须同码同判**：`web/api.demo.js` 的 `POST /api/appeals` 与上同口径
> （主体类型白名单 + 豁免只限报名类）⇒ 演示站放过的东西正式站 400 ⇒ 公网演示站不会
> 让人以为「这条路能走通」。

---

## 8. 阶段间依赖一览

| 阶段 | 消费上游 | 产出下游依赖的东西 |
|---|---|---|
| P0 | — | 全部基础设施 |
| P1 | P0 | `teams` / `registrations` / `task_packages` 表与数据 |
| P2 | P0 + P1 | `stage_reviews` 等评审表、`scoreStage` 纯函数、`computation_snapshots` |
| P3 | P0 + P1 + P2 | `stage_results`、`rankTeams`、`computeTier`、`applyVisibility` |
| P4 | P0 + P2 + P3 | 复算 diff、限频、复核状态机 |
| P5 | P0 + P1 + P3 | 三池派生数据、公开 API、iCal |
| P6 | 全部 | 部署资产、演示版 |

---

## 9. 文件归属裁决表（**跨计划唯一写入权**）

> **为什么需要这张表**：六份计划并行写完后，检测出 **5 个文件被两个阶段同时声明 "Create"**，
> 另有 **1 张表被两个迁移同时 CREATE**、**1 个模块两套参数顺序相反**。
> 这三类冲突的共同后果都是同一个：**同一件事有两个实现，两处算出不同结果**——正是本项目复盘里反复出现的那类失败。
> 裁决原则：**最早建立它的阶段拥有它；后续阶段一律 Modify（追加），不得重建。**

| 文件 | 拥有者 | 后续阶段怎么用 | 为什么这么定 |
|---|---|---|---|
| `src/errors.js` | **P0**（最早建立者拥有） | P1 / P3 **直接复用**；P4 **追加**快捷函数 | ⚠️ 原裁决是「P1 建」，但 P0 的 Task 4/5/6 已需要抛领域错误（body 413/400、重复手机号 409、授权参数校验）。**P0 建立后即为最早建立者**，按本表原则归 P0，后续阶段一律 Modify（追加），不得重建。P3 原打算新建 `src/errors/app-error.js` 且签名是 `appError(code, message, status)`，与全项目的 `appError(status, code, message, detail)` **参数顺序相反**。两套并存 → `err.status` 与 `err.code` 互换 → HTTP 层返回错误状态码。**统一为 status-first** |
| `src/audit/log.js` | **P2** | P4 **改造**（把内联 SQL 下沉到仓储层）+ **追加**查询 | P2 先写审计日志。P4 改造时**函数签名一个字不改**，P2 已有的调用点不必跟着改 |
| `src/db/repo/computations.js` | **P2** | P4 **追加** `nextRevision` / `listComputationRows` | 计算快照表由 P2 的 `003_review.sql` 建，写入方是 P2 的 `computeStage`。P4 只做读与复算 |
| `src/db/repo/tiers.js` | **P3** | P4 **追加**只读的 `getTeamTierRow(db, teamId)` | P3 已建 `insertTierRecord(db, { …, reasonsJson, … })`。P4 原打算重复定义且参数名写作 `reasons`——参数名不同会让 `reasons` 静默变 `undefined` → 段位降级原因丢失 → R-PTS-04「降级须公示」破 |
| `src/domain/evidence.js` | **P4** | P5 **另建** `src/domain/task-evidence.js` | 同名不同义：P4 的是 R-AUD-04「证据三列 + 按发行方去重」（审计概念），P5 的是 R-STG-04「任务完成证据」。**不改名则后写的阶段覆盖先写的模块** |
| `tiebreak_round` / `tiebreak_votes` 表 | **P2**（`003_review.sql`） | P3 **只消费**，不建表 | ⚠️ **最高危的一处**：P2 与 P3 的迁移原本都 `CREATE TABLE`，第二个迁移报 `table tiebreak_round already exists` → **整条迁移链（004/005/006）全部不执行**。归属理由：投票入口在 P2（"互评、加时陈述与一票破同分"是 P2 的 Task 7） |
| `scripts/audit-scan.js` | **P4** | P6 **不重建**，只在 P4 版本上追加参数 | P4 已建并写进验收标准。P6 重建会得到两个扫描器，其中一个可能没人跑 |

### 9.1 执行前自检（每个阶段开工前跑一遍）

```bash
cd platform/db/migrations && ls -1 *.sql | cut -d_ -f1 | sort | uniq -d
# 期望输出为空。非空 = 有两个迁移抢同一个版本号 → 后执行的那张表永远建不出来。
```

```bash
cd /Users/mac/soft/AI/orca/heikesong/docs/superpowers/plans
for f in 2026-10-20-platform-P*.md; do
  grep -oE '^- Create: `platform/[^`]+`' "$f" | sed -E 's/^- Create: `platform\///; s/`$//'
done | sort | uniq -c | awk '$1>1'
# 期望输出为空。⛔ 非空 = 同一文件被两个阶段声明 Create → 后面那个会覆盖前面那个。
```

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
| 错误 | 抛 `AppError`（`code` + `message` + `status`），由 HTTP 层转成 `error(res, status, code, message, detail)` |
| 权限 | 判定只有 `can(user, capability, ctx, db)` 一个入口。SQL 层过滤用 `scopeClause(...)` |
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
openDatabase({ dataDir, filename })      // → { db, close() }，已开 WAL + foreign_keys + busy_timeout=5000

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

// src/auth/password.js
hashPassword(plain)                      // → 'scrypt$N$r$p$saltB64$hashB64'
verifyPassword(plain, stored)            // → boolean

// src/auth/session.js
createSession(db, userId, { ttlDays, now })   // → { token, expiresAt }
resolveSession(db, token, { now })            // → { userId, expiresAt } | null
revokeSession(db, token)
revokeAllSessions(db, userId)

// src/auth/permissions.js
can(user, capability, ctx, db)           // → boolean（唯一入口）
scopeClause(userId, capability, { scopeType, scopeId, alias })  // → { sql, params }
grantAssignment(db, { userId, capability, scopeType, scopeId, grantedBy })
revokeAssignment(db, assignmentId)
listAssignments(db, { userId, capability })

// src/server.js
createApp({ db, rules, webDir })         // → { router, handle(req, res) }
serveStatic(webDir, req, res)            // → boolean（已处理则 true）
//   handler 返回约定（2026-10-20 补）：handler 返回 undefined → 视为 200；
//   返回 { status, body }（可选 headers 附加响应头）→ 按返回的状态码/响应体/响应头应答。
```

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
```

---

## 4. P3 产出（榜单与积分）★ 核心

### 迁移 `db/migrations/004_leaderboard.sql`

```sql
points_ledger(id, edition_id, stage_id, team_id, user_id, kind, points REAL, created_at)
   -- kind: stage_rank | mvp | roadshow | personal_rollup
tier_records(id, team_id, tier, milestone_count, business_signoff_count, reasons_json,
             computed_at, deleted_at)
behavior_events(id, team_id, user_id, type, points REAL, evidence, created_at)
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
  "personal": { "lifetime": true, "includeMvpVote": true },
  "tieRankStyle": "1224"
}
```

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
GET  /api/audit/computations/:id/diff
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
| `src/errors.js` | **P1** | P4 **追加**快捷函数；P3 **直接复用** | P3 原打算新建 `src/errors/app-error.js` 且签名是 `appError(code, message, status)`，与 P1/P4 的 `appError(status, code, message, detail)` **参数顺序相反**。两套并存 → `err.status` 与 `err.code` 互换 → HTTP 层返回错误状态码。**统一为 status-first** |
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

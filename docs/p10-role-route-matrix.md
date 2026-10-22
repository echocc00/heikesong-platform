# P10 · 角色 × 路由 × 端点 × 可触发性 矩阵

> 回答用户本轮的两个问题：
> ① **「我用用户账号登录后和管理员登录后的页面是否一致？」**
> ② **「是否有哪些接口只做了功能上的展示，直接没办法点击触发？」**
>
> ⚠️ 本表**从源码生成/逐条核对**，不是凭印象写的。每一行的判据都能复算：
> - 导航分区与角色 ⇒ `platform/web/nav.js` 的 `NAV_SECTIONS`
> - 分区级能力点闸门 ⇒ `platform/web/nav.js` 的 `ROUTE_CAPABILITIES`
> - 页面调用的端点 ⇒ `platform/web/views/*.js` 里扫出来的 `api.get` / `api.post`
> - 演示站端点是否实现 ⇒ `platform/test/demo-api-parity.test.js` 的**端点覆盖闸**（红 = 缺端点）
> - 正式站端点是否实现 ⇒ `platform/src/server.js` 路由表 + 各 `src/http/routes/*.js`
> - 写流程真的能跑 ⇒ `platform/test/demo-admin-write-flows.test.js`（9 例）+ 浏览器实跑取证
>
> 📅 实跑时间：2026-10-23｜对应台账 `docs/deployment.md` §19 的 E143 / E145 / E146。

---

## 一、结论先说

| 用户的问题 | 结论 |
|---|---|
| 用户账号和管理员的页面**是否一致**？ | **不应该一致，而且现在确实不一致**（这是对的）。<br>· 导航按**角色**分区：访客 3 项 ｜ 选手 4 项 ｜ 评审席 2 项 ｜ 企业席 1 项 ｜ 组委会 5 项。<br>· 5 个**分区级**页面再叠一层**能力点**闸门（`ROUTE_CAPABILITIES`）⇒ 组委会页面连「有 admin 角色但没该能力点」的人也会被拦。<br>· 其余**赛段级**页面（`/review/:stageId` 等）**一律不拦** —— 评委的能力点可能是赛段级授权，前端拿不到 ⇒ 拦了就是误伤（DP-105）。<br>· 拦下来之后显示的是**说人话的「无权访问」态**（`renderNoPermission`），不是白屏或崩溃。 |
| 有没有**只做展示、点不动**的接口？ | **P10 之前有 7 个，现已全部补齐并加了回归闸。**<br>· 企业签字台：5 个端点（2 读 + 3 写）演示站**一个都没实现** ⇒ 那一页当时是**两块错误卡片**。<br>· 任务卡审批：2 个写端点没实现，且适配器里那个**不带 id** 的通用口**没有任何调用方**（前端调的是带 id 的那个）⇒ 按钮点了就 404。<br>· 种子状态：三张演示卡都没有 `status` ⇒ 控件全是**锁着的**。<br>⇒ 补齐后浏览器实跑：六维评估 → 签级 → 已发布、里程碑签字 → 待签 33→32，全部点得动。 |

---

## 二、导航分区 × 角色（谁能看见哪些入口）

来源：`platform/web/nav.js` → `NAV_SECTIONS`

| 分区 | 角色条件 | 入口 |
|---|---|---|
| **赛事**（公开） | 任何人（含未登录） | `/` 首页 ｜ `/leaderboard` 榜单 ｜ `/tier` 段位榜 |
| **我的赛事** | 已登录 | `/dashboard` 工作台 ｜ `/apply` 报名 ｜ `/team` 我的战队 ｜ `/tasks` 任务清单 |
| **评审席** | 已登录（**不按角色限定**） | `/review` 评审打分 ｜ `/review/prep` 评委前置 |
| **企业席** | `enterprise` / `enterprise_admin` | `/signoff` 企业签字台 |
| **组委会** | `admin` | `/admin/registration` 报名筛选台 ｜ `/admin/task-packages` 任务卡审批 ｜ `/admin/appeals` 申诉裁决 ｜ `/flags` 复核队列 ｜ `/publish` 赛段发榜 |

> ⚠️ **评审席与企业席为什么不按能力点过滤？**
> - 评审席：评委席位是**赛段级**指派的（`stage_judges`），`/api/me` 的 capabilities 里**没有**这一层 ⇒ 按能力点过滤会**误伤**真评委。
> - 企业席：`signoff:create` 可以是**届期级**授权，而 capabilities 只回「全局授权 + 角色能力」⇒ 同理会误伤。
> - ⇒ 这两处的准入一律**由 API 裁决**（403 → 错误态说清缺什么权限），沿用 DP-77。
> - ⛔ 而 `ROUTE_CAPABILITIES` 里列的 5 个页面，其 API **同样要求全局能力点** ⇒ 前后端口径一致，不会「前端放行、API 403」。

---

## 三、分区级页面的能力点闸门

来源：`platform/web/nav.js` → `ROUTE_CAPABILITIES`

| 路由 | 要求的能力点 | 前端表现 |
|---|---|---|
| `/admin/registration` | `registration:review` | `renderNoPermission`（无权访问态） |
| `/admin/task-packages` | `task_package:approve` | 同上 |
| `/admin/appeals` | `audit:read` | 同上 |
| `/flags` | `audit:read` | 同上 |
| `/publish` | `stage:compute` | 同上 |

> ⛔ **赛段级页面一律不拦**（`/review/:stageId`、`/review/prep/:stageId`、`/leaderboard/:stageId`、`/publish/:stageId`、`/tasks/:workflowId`、`/audit/:computationId`、`/card/:teamId`）—— 前端无从判断赛段级授权，拦了就是误伤（DP-105 明写）。
>
> 📎 DP-77 的修订：**前端不按角色「硬编码」拦路**；这里拦的是**能力点**，且只拦分区级页面。

---

## 四、页面 → 端点 → 正式站 / 演示站 → 可触发性

> 「演示站」= 公网演示站 `https://8.133.200.235:8445/?demo=1`；演示站由浏览器内的适配器（`platform/web/api.demo.js`）服务。
> 「端点覆盖闸」= `platform/test/demo-api-parity.test.js`（把 P10 全部端点写进 `VIEW_ENDPOINTS`，缺一个就红）。

| 页面 | 调用的端点 | 正式站 | 演示站 | 可触发性 |
|---|---|---|---|---|
| 首页（落地页） | `GET /api/event-info`、`GET /api/leaderboard/rolling` | ✅ | ✅ | 免登录，数据来自**服务端投影**（演示站与正式站同一函数，不可能漂） |
| 榜单 | `GET /api/stages`、`GET /api/leaderboard/rolling`、`GET /api/leaderboard/tier` | ✅ | ✅ | 告警分层：匿名只看人话 + code；`detail` 只给 `audit:read` |
| 段位榜 | 同上 | ⚠️ **返回空集** | ✅ | ⛔ **正式站段位记录从不被写入**（`publishLeaderboard` 无生产调用方，台账 E149）⇒ 段位永远兜底 D 段、段位榜 `rows: []`、段位权益不解锁。**演示站是另一条实现**（浏览器内现算段位）⇒ 两边不一致。 |
| 工作台 | `GET /api/leaderboard/rolling`、`GET /api/teams` | ✅ | ✅ | 需登录 |
| 报名 | `POST /api/registrations`、`GET /api/registration-criteria`、`POST /api/appeals` | ✅ | ✅ | 可提交；报名结果可申诉（DP-106） |
| 我的战队 | `GET /api/teams` | ✅ | ✅ | 只见**我参与的**队伍（与正式站同口径，E139） |
| 任务清单 | `GET /api/workflows`、`GET /api/workflows/:id/tasks`、`POST /api/tasks/:id/claim|complete|release` | ✅ | ✅ | 领取 / 提交完成 / 释放三条写路径都可点 |
| 报名筛选台 | `GET /api/registrations`、`POST /api/registrations/:id/level`、`GET /api/task-packages` | ✅ | ✅ | 改级会留事件轨迹 |
| **任务卡审批** | `GET /api/event-info`、`GET /api/registration-criteria`、`GET /api/task-packages`、**`POST /api/task-packages/:id/solvability`**、**`POST /api/task-packages/:id/approve`** | ✅ | ✅ **（P10 补）** | 六维评估 → 签级 → 已发布；D 级退回**必须写理由**；提交后顶部计数会跟着变（E146） |
| **企业签字台** | `GET /api/signoffs/mine`、**`GET /api/stages/:id/enterprise-confirmations`**、`POST /api/milestones/:id/signoff`、**`POST /api/milestones/:id/signoff/withdraw`**、**`POST /api/stages/:id/enterprise-confirmations`** | ✅ | ✅ **（P10 补）** | 里程碑签字 / 撤回 / 企业双签（强制带齐 R2 双签） |
| **评委前置** | `GET /api/stages`、`GET /api/stages/:id/review-board`、`GET /api/teams`、**`GET /api/stages/:id/recusals`**、`POST /api/stages/:id/recusals`、`POST .../peer-reviews`、`POST .../self-review`、`POST .../calibration` | ✅ | ✅ **（P10 补）** | 回避申报 / 互评 / 自评 / 校准四件事；校准走**与打分同一个维度白名单** |
| 复核队列 | `GET /api/audit/flags`、`POST /api/audit/flags/:id/resolve` | ✅ | ✅ | 可裁决 |
| 计算留痕 | `GET /api/audit/computations/:id`、`GET /api/audit/computations/:id/diff` | ✅ | ✅ | diff 可复算 |
| 赛段发榜 | `GET /api/stages`、`GET /api/stages/:id/review-board`、`POST /api/stages/:id/compute` | ✅ | ✅ | 发榜是显式动作 |
| 评审打分 | `GET /api/stages/:id/review-board`、`POST /api/stages/:id/reviews` | ✅ | ✅ | 打分取**会话**里的评委（body 不带 judgeId） |
| 战队战绩卡 | `GET /api/teams/:id/performance-card` | ✅ | ✅ | B 榜口径 |
| **申诉裁决** | `GET /api/appeals`、`POST /api/appeals/:id/decide` | ✅ | ✅ **（P10 补）** | 裁决成立 ⇒ 撤销终稿、转入重新复核、**不触发重算**（DP-106） |

**粗体** = P10 新增/补齐的端点。

---

## 五、写流程清单（每个按钮点了会发生什么）

| 页面 | 动作 | 端点 | 成功后的状态变化 | 校验（与正式站同码） |
|---|---|---|---|---|
| 报名 | 提交报名 | `POST /api/registrations` | 记录状态 → 已提交/已接收，带 grading 与 explain | 三维度必须齐 |
| 报名 | 提交申诉 | `POST /api/appeals` | 申诉入队，等组委会裁决 | 报名类申诉：本人 / 无终态裁定 / 不重复 |
| 我的战队 | 退出战队 | `POST /api/teams/:id/members` | 人数不足 ⇒ 触发并队标记 | 组长不能直接退出（409） |
| 任务清单 | 领取 / 完成 / 释放 | `POST /api/tasks/:id/claim|complete|release` | 任务状态流转 + 行为事件留痕 | 不能重复领取 |
| 报名筛选台 | 改级 | `POST /api/registrations/:id/level` | 等级落库 + **事件轨迹追加** | — |
| 任务卡审批 | 提交六维评估 | `POST /api/task-packages/:id/solvability` | 已提交 → **已评估**，出得分与档位 | `INVALID_SOLVABILITY_ANSWERS` / `INVALID_VETO_KEY` |
| 任务卡审批 | 签级通过 | `POST /api/task-packages/:id/approve` | 已评估 → **已发布**（进池） | `SOLVABILITY_NOT_ASSESSED` / `INVALID_GRADE`；**D 级必须写理由** `RETURN_REASON_REQUIRED` |
| 任务卡审批 | 退回出题方 | 同上 | → **已退回**，出《问题可解性诊断报告》 | 同上 |
| 企业签字台 | 里程碑签字 | `POST /api/milestones/:id/signoff` | 待签 → **已签**（不进总分） | `MISSING_DEPARTMENT` / `MISSING_CONTENT` |
| 企业签字台 | 撤回签字 | `POST /api/milestones/:id/signoff/withdraw` | 已签 → **已撤回**（段位重算降档） | `SIGNOFF_NOT_FOUND` / `ALREADY_REVOKED` |
| 企业签字台 | 企业双签 | `POST /api/stages/:id/enterprise-confirmations` | 新增确认（**必须带跨领域评委签字**，否则 R2 按 0 分） | `CROSS_JUDGE_SAME_AS_SIGNATORY` / `JUDGE_NOT_ASSIGNED` / `SCORE_OUT_OF_RANGE` |
| 评委前置 | 回避申报 / 撤销 | `POST /api/stages/:id/recusals` | 台账追加；**撤销只能由组委会执行** | `RECUSAL_REASON_REQUIRED` / `INVALID_RECUSAL_ACTION` |
| 评委前置 | 互评 / 自评 / 校准 | `POST .../peer-reviews` `/self-review` `/calibration` | 分数入库 | 校准与打分**共用维度白名单**（`UNKNOWN_DIMENSION` / `DIMENSION_SEAT_FORBIDDEN`） |
| 复核队列 | 裁决 | `POST /api/audit/flags/:id/resolve` | 队列项关闭 | — |
| 申诉裁决 | 裁决成立 / 驳回 | `POST /api/appeals/:id/decide` | 成立 ⇒ 撤销终稿、回到待复核、**不重算** | DP-106 |

---

## 六、仍然存在的边界（如实记录，不是 bug 但要知道）

| 事项 | 说明 |
|---|---|
| ⛔ **正式站的「发榜」只做了计算，没做发榜** | 「赛段发榜」页只调 `POST /api/stages/:stageId/compute` ⇒ 只写 `stage_results` + `computation_snapshots`；**名次积分台账、段位记录、榜单快照、发榜审计日志**四样都不写（那四样在 `publishLeaderboard` 里，而它**全仓无生产调用方**）。实测（真实服务端 + 隔离库）：compute 后 `points_ledger` / `tier_records` / `leaderboard_snapshots` 均为 **0 行**，段位榜与个人榜 `rows: []`；手工调一次 `publishLeaderboard` 后四样齐全、个人榜才有数据。⇒ 与「看起来已接线」的单元测试并存（测试直接调服务层函数，不经产品路径）。台账 E149。 |
| 企业确认**无法撤回/改签** | 仓储层 `softDeleteEnterpriseConfirmation` 无调用方、无对外写端点 ⇒ 一条**缺双签**的确认落库后按 R2 计 0 分且产品内修不了。<br>⇒ 界面层**如实显示**「缺跨领域评委这一签」，并在提交前**强制一次带齐双签**（从源头不产生半条确认）。⚠️ 但**写端点不强制 `crossJudgeId`** ⇒ 直接调 API 仍能落一条 `cross_judge_id = NULL` 的半条（实测 HTTP 200）；同格重签还会撞唯一索引并冒成 **HTTP 500**。台账 E141 / E148。 |
| 公开页 `dimension_no_scores` 重复 | 真机上同维度多队缺分 ⇒ 会出现多条措辞相同的告警。**条数不许减**（S-5 / C-05：降级必须显式展示，不静默）。 |
| 告警正文不写队伍名 | `scoreStage` 是纯函数（无 db），队伍名要查库 ⇒ SQL 只能放仓储层，超出「只改文案分层」的范围。当前靠 `detail` 里的队伍 id 定位（有 `audit:read` 的人可见）。 |
| 演示站只有一个身份 | 演示站是**公开演示**，只有「演示组委会」一个账号 ⇒ 角色差异要在**真机**上验（真机有管理员 / 队长 / 评委 / 企业代表四种账号）。 |

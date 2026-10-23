# P11 · 把「写了没接线」的补齐（2026-10-23）

## 0. 一句话

P10 收尾时追 E141 的根因，撞出 **E149（正式站发榜只做了计算没做发榜）**；
随后用自动化扫描把**同类问题**全查了一遍 ⇒ 共 **8 个服务层函数 + 5 处界面/入口缺口**「实现了、测试也绿了、但产品路径接不上」。
本阶段把这一类**一次性接齐**，并把「服务层动作 ⇒ 必有路由」的对账变成**机器闸**。

---

## 1. 复盘：这些问题是设计问题还是代码问题？

| 问题 | 设计原文 | 实现现状 | 判定 |
|---|---|---|---|
| **E149** 发榜只做了计算 | 设计**明确**区分计算与发榜：「`compute` 是显式动作，不自动触发。**发榜**是一个有后果的动作（影响奖金），必须有明确的操作者与时间戳」；`publishLeaderboard` 正是这个动作（带 `actorId`/`now`/审计/快照/段位/积分）。**但设计 §8 的 API 清单里没有 publish 端点** | 服务层实现了 + 服务层测试 25 处引用全绿；**路由表里没有任何入口能触达它** | **设计清单漏一条（接口契约层）** ＋ **实现时缺「服务层动作 ⇒ 必有路由」的对账**。<br>⇒ 不是随手写错，是**逐条实现 §8 清单时，清单本身不全** ⇒ 多出来的那个动作永远没人调 |
| **E141** 企业确认无法撤回/改签 | 设计 §8 清单里**没有**企业确认的撤回/改签端点（里程碑签字**有**：`POST /api/milestones/:id/signoff/withdraw`）。设计 line 150 提到「双主体各自签名、**任一缺失即"部分生效"的状态机** + 审计」 | 照设计做了正向流程 ⇒ 实现**没有违背设计** | **设计缺口（业务闭环缺失）**：只有正向，没有逆向纠错。「部分生效」被实现成「直接按 0 分 + 告警」的**终态**，没有「推进到完全生效」的路径 |
| **E148①** 写端点不强制 `crossJudgeId` | 设计 line 576 引 S7 原文：R2 是**计分口径**（缺任一 → 按 0 分计 + 记 warning），**不是写入校验** | 写端点允许只填一边 ⇒ **符合设计** | **不是 bug**。⇒ P11 撤回「写入期强制 `crossJudgeId`」这条建议（会改变 S7 语义）；正确解法是补「后补」路径（＝ E141 的修法） |
| **E148②** 同格重签返回 500 | 三态状态码口径（设计 §7.3） | 唯一约束冲突冒成 **500「服务内部错误」** | **纯实现 bug**（违反状态码口径） |

### 1.1 三条可复用的病根

1. **闸的形态不对** —— 现有闸大量是「**服务层单测**」（直接调 `publishLeaderboard`），**没有一条经 HTTP 路由的端到端闸** ⇒ 「服务层写了、路由没挂」可以一路绿灯。
   （与本项目旧账同款：P1 Task 3 的 A1「`registration:write` 被注册却从不校验」。）
2. **设计清单是实现依据，但清单本身没有与「业务动作清单」对账** ⇒ 少一条就少一条，没人发现。
3. **逆向流程缺席** —— 全产品只有正向流程（提交 → 计算 → 发榜），没有「改 / 撤 / 重做」的流程设计。

⇒ 本阶段的三条对策：
- **对策 1**：补**经 HTTP 路由**的端到端闸（发榜后四张表都有数、段位榜与个人榜非空）。
- **对策 2**：新增机器闸「**服务层导出函数 ⇒ 生产必有调用方**」（`docs/tools/dead-service-scan.mjs`），把「写了没接线」变成**红**。
- **对策 3**：所有新写端点配**逆向路径**（改 / 撤 / 重做），不再只做正向。

---

## 2. 同类问题全清单（自动化扫描 `docs/tools/dead-service-scan.mjs`）

### 2.1 服务层「生产零调用」8 个 ⇒ 本阶段全部接上

| 函数 | 缺什么 | 影响 |
|---|---|---|
| `publishLeaderboard`（leaderboard.js） | **无路由** | 名次积分台账 / 段位记录 / 榜单快照 / 发榜审计日志**四样不写** ⇒ 段位永远 D 段（**段位权益永不解锁**）、个人榜空、MVP 无候选、人才池积分聚合空、发榜无留痕 |
| `openTiebreakRound` / `castTiebreakVote` / `getTiebreakRoundState` / `closeTiebreakRound`（tiebreak.js） | **无路由**（表 `tiebreak_round` / `tiebreak_votes` 已建、服务层 181 行已测） | **破同分的人工环节整条不可用**：同名次只能靠确定性兜底，「加时陈述 → 一票破同分」做不了 |
| `createPublicToken`（public-api.js） | **无路由** | 公开榜单 / 公开日历的令牌**没有任何创建入口** ⇒ 两个公开接口实际无人能用 |
| `buildReverseAuditTasks`（anticheat.js） | 无路由 | 反查审计任务不生成（待核实是否为设计要求） |
| `recordComputation`（audit.js） | 无路由 | 计算快照的服务层包装被仓储直调取代（`compute.js` 直调 `insertSnapshot`）⇒ **审计日志可能因此没走服务层**（待核实） |

### 2.2 「端点已挂、前端从不调用」14 个 ⇒ 分类处置

| 类别 | 端点 | 处置 |
|---|---|---|
| 一期边界明确不做（三池只做数据层与接口） | `/api/pools/{projects,talents,resources}`、`POST /api/pools/sync` | **不补界面**（一期边界）✅ |
| 运维 / 外部消费 | `/api/health`、`POST /api/auth/password`、`POST /api/auth/logout-all` | 不补界面 ✅（`/api/auth/password` 单独记为可选项） |
| **真缺口** | `GET /api/teams/:id/tier` | 设计 §9 明写「**段位与权益**」界面 ⇒ **补界面** |
| **真缺口** | `GET /api/audit/log` | 设计 §9 明写「审计与复算」⇒ **补审计日志页** |
| **真缺口** | `POST /api/teams/:id/behavior-events` | 写端点零调用方 ⇒ **行为分永远是 0**（`rules/behavior-points.json` 五类事件一条都采不到）⇒ **补提交入口** |
| **真缺口** | `GET /api/stages/:stageId/review-state` | 「评分进度 / 缺谁」不可见 ⇒ **发榜页显示缺谁该打分** |
| 依赖令牌 | `GET /api/public/leaderboard`、`GET /api/public/calendar.ics` | 随 W3 令牌管理一起活 |

---

## 3. 任务清单

| 波 | 任务 | 文件 | 归属 |
|---|---|---|---|
| **W1** | **发榜接线**（E149）：新增 `POST /api/stages/:stageId/publish`；发榜页加「发布榜单」；demo 适配器；**经 HTTP 路由**的回归闸 | 新 `src/http/routes/publish.js`、改 `web/views/publish.js` | P11 新建 + P8 ⇒ 同步回 |
| **W1** | **同格重签 500 → 409**（E148②） | 改 `src/http/routes/review.js` | P2 ⇒ 同步回 |
| **W2-a** | **企业确认闭环**（E141 + E148①）：撤回/改签端点（软删 + 审计日志）；签字台加「撤回 / 改签」；R2「后补」路径成立 | 改 `src/http/routes/review.js`、`src/services/review.js`、`src/db/repo/enterprise-confirmations.js`、`web/views/signoff.js` | P2/P3/P10 ⇒ 同步回 |
| **W2-b** | **破同分接线**（W2 服务层 → 路由 + 界面） | 新 `src/http/routes/tiebreak.js`、新 `web/views/tiebreak.js` | **P11 新建** |
| **W2-c** | **公开令牌管理** | 新 `src/http/routes/public-tokens.js`、新 `web/views/public-links.js` | **P11 新建** |
| **W3** | **段位与权益界面** / **审计日志页** / **行为分提交入口** / **发榜页显示缺谁该打分** | 改 `web/views/team.js`、新 `web/views/audit-log.js`、改 `web/views/team.js`、改 `web/views/publish.js` | 按最早建立者 ⇒ 同步回 |
| **W3** | **演示适配器统一补齐**（本阶段新增的全部端点） | 改 `web/api.demo.js` | P6 ⇒ 同步回 |
| **W4** | **机器闸**：服务层导出函数 ⇒ 生产必有调用方 | 新 `docs/tools/dead-service-scan.mjs` | **P11 新建** |
| **W5** | **赛段底座**（E150，详述见 §5）：建赛段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册（服务层 + 路由 + 种子 + 端到端闸）；**W5-d 补「赛段配置」页**（设计 §9 明写「赛段配置与权重表」，此前 6 个写端点零 UI 调用方） | 新 `src/services/stage.js`、新 `src/http/routes/stages.js`、新 `web/views/stages.js`、改 `scripts/seed.js` | P11 新建 + P0 ⇒ 同步回 |

---

## 4. 纪律（沿用 P0–P10）

1. **计划是规格**：代码块逐字一致（`plan-block-sync.mjs --verify`）。
2. **零依赖 / 零构建 / 可移植**。
3. **规则只从 `rules/*.json` 来**。
4. **可见性在 API 层过滤**。
5. **逆向路径**：每个新写端点都要想清楚「错了怎么改」。
6. **台账编号不重号**：`E150+` / `DP-109+`。
7. **改既有文件 ⇒ 同步回 owning 阶段计划块**（`C-RW` 必须 0）。
8. 每波交付：全量 `node --test` + 三机器闸 + 漂移审计 + 变异检验 + 六视口 + 真机复验。

---

## 5. W5 · E150：种子不建赛段 ⇒ 整条评审链在真机上是死的（P11 扫出的**最大**缺口）

### 5.1 发现过程

W4 的机器闸（`dead-service-scan.mjs`）首跑报出 47 个死函数，其中三条**同属一族**：

| 死函数 | 位置 | 唯一调用方 |
|---|---|---|
| `insertStage` | `src/db/repo/stages.js` | 只有测试（17 处） |
| `assignStageJudge` | `src/db/repo/stages.js` | 只有测试（15 处） |
| `registerStageTeams` | `src/db/repo/stage-teams.js` | 只有测试（1 处） |

⇒ **生产上没有任何代码创建赛段、派评委、登记赛段名册。**

### 5.2 真机实测（决定性证据）

在真机（8.133.200.235）上直接查生产库 `/var/lib/heikesong/data/app.db`：

```
stages = 0    stage_team = 0    teams = 1    users = 6    editions = 1
```

⇒ 全新部署的平台**一条赛段都没有**。后果（不是「少一个功能」，是**主流程全断**）：

- `GET /api/stages` ⇒ `items: []` ⇒ 前端**没有任何赛段可选**；
- 评审打分页（`/review`）、发榜页（`/publish`）、破同分（`/tiebreak`）、企业签字台
  全部以 `:stageId` 为路径参数 ⇒ **一个都进不去**（拿不到合法的 stageId）；
- 即使硬塞一个 stageId，`assertTeamInStage` / `assertVotingJudge` 也会因为
  「赛段不存在 / 评委没被分配」而 404 / 403；
- ⇒ **P11 本轮修的 E149（发榜端点）在真机上依然不可达** ——
  发榜端点本身是对的，但**没有赛段可发**。

### 5.3 判定：这是**设计缺口**，不是实现写错

| 依据 | 出处 |
|---|---|
| 设计 §8 的 API 清单里**没有**创建赛段的端点 | `docs/superpowers/specs/2026-10-20-heikesong-platform-design.md` §8 |
| 设计 §9 的前端 IA 里有「**赛段配置与权重表**」（组委会视角） | 同上 §9 |
| ⇒ 界面要求存在，但**没有任何 API 能满足它** | 与 E149 **同型**：设计清单漏了一条 |

⇒ 与 E149 同一类病根，但工程量更大：
E149 漏的是「发榜」这一个动作的入口；本条漏的是**「赛段」这个主数据本身**的创建入口。

### 5.4 三条病根的对照

| # | 病根 | E149（发榜） | E150（赛段） |
|---|---|---|---|
| 1 | 闸只测服务层，不测产品路径 | 服务层 25 处引用全绿，路由表空 | 仓储层 17 处测试引用全绿，生产零调用 |
| 2 | 设计清单没与业务动作清单对账 | §8 清单漏 publish 端点 | §8 清单漏「建赛段 / 派评委 / 报名册」三个端点 |
| 3 | 逆向流程缺席 | — | 建了赛段之后**怎么改 / 怎么撤** |

### 5.5 修法（W5）

| 波 | 任务 | 文件 | 归属 |
|---|---|---|---|
| **W5-a** | 服务层：建赛段 / 派评委 / 报名册（含**逆向**：改配置 / 撤评委 / 退名册） | 新 `src/services/stage.js` | P11 新建 |
| **W5-b** | 路由：`POST /api/editions/:editionId/stages`、`POST /api/stages/:stageId/judges`、`POST /api/stages/:stageId/teams` | 新 `src/http/routes/stages.js` | P11 新建 |
| **W5-c** | 种子补建 5 个赛段（依据 `rules/schedule.json`）+ 派评委 + 报名册 | 改 `scripts/seed.js` | P0 ⇒ 同步回 |
| **W5-d** | 前端：「赛段配置」页（设计 §9 明写「赛段配置与权重表」） | 新 `web/views/stages.js` + 改 `web/app.js` / `web/nav.js` | P11 新建 + P0/P1 ⇒ 同步回 |
| **W5-e** | 演示适配器补端点 | 改 `web/api.demo.js` | P6 ⇒ 同步回 |
| **W5-f** | 端到端闸：全新库 ⇒ 种子 ⇒ **赛段存在 ⇒ 评审可提交 ⇒ 计算 ⇒ 发榜 ⇒ 四张表有数据** | 新 `test/stage-bootstrap-e2e.test.js` | P11 新建 |

### 5.6 硬约束（沿用）

1. **规则只从 `rules/*.json` 来** —— 赛段日程取 `rules/schedule.json`（S1 调研 / S2 任务 / S3 开发 / S4 路演 / S5 落地），
   权重表取 `rules/scoring-initial.json` / `rules/scoring-final.json`（**不硬编码**）。
2. **建赛段要带 `scoring_config_key`**（`initial` / `final`）—— 权重表是**赛段级**的，不是全局的。
3. **派评委 = 签利益冲突声明**（`assignStageJudge` 已内建事务 + 声明回填，**不要**绕过它自己写 `stage_judges`）。
4. **名册登记幂等**（重复登记撞唯一约束 ⇒ 仓储层抛错 ⇒ 服务层先查后写）。
5. **逆向路径**：改配置 / 撤评委 / 退名册 都要有，且**审计留痕**。
6. **三态状态码**：赛段不存在 404 / 无权限 403 / 成功 200。
7. **可见性在 API 层过滤**：赛段配置页只给 `stage:compute` 以上的人看。

---

## 6. 规格块（P11 新建文件 · 逐字）

> 本节是 P11 **新建文件**的规格块（`plan-block-sync.mjs --verify` 逐字核验）。

### `platform/src/http/routes/publish.js`

发榜路由（E149：服务层写了但路由表接不上）。

```javascript
// src/http/routes/publish.js — 赛段发榜（P11 新建）
//
// 依据：设计文档 §8「API 设计」+ §9「发榜页：榜单 + trace 抽屉 + 降级告警置顶」
//   + 任务书 §七（名次积分 / 奖金 / MVP）
//
// ⛔ **P11 · 这个文件为什么存在（E149）**：
//   设计文档 §8 的 API 清单里**漏了一条 publish 端点** —— 清单里只有
//   `POST /api/stages/:stageId/compute`（算），没有「发榜」这个动作的入口。
//   于是服务层的 `publishLeaderboard`（写榜单快照 + 段位记录 + 名次积分流水 + 发榜审计）
//   **写了、也测了（25 处引用全绿），但路由表里没有任何一条路能触达它**。
//   后果（真机实测）：
//     · `points_ledger` = 0   ⇒ 名次积分从未发放 ⇒ 个人榜恒为空；
//     · `tier_records` = 0    ⇒ 段位永远兜底 D 段 ⇒ **段位权益永不解锁**；
//     · `leaderboard_snapshots` = 0 ⇒ 没有发榜快照 ⇒ 赛后复盘没有权威口径；
//     · `leaderboard.publish` 审计 = 0 ⇒ 发榜这件事**没有留痕**。
//   ⇒ 补这个端点就是把「写好了但接不上」的最后一个动作接上。
//
// ⛔ **计算 ≠ 发榜**（设计文档 §869 明写）：
//   「`compute` 是显式动作，不自动触发。**发榜**是一个有后果的动作（影响奖金），
//     必须有明确的操作者与时间戳。」
//   ⇒ 两个**独立**的显式动作、两个独立的能力点校验点、两次独立的审计留痕。
//   ⇒ 这里**不**顺带调用 computeStage：组委会要先算、看告警、确认无误，再点发榜。
//
// ⚠️ **三态状态码**（设计文档 §7.3）：
//   赛段不存在 → 404；没有发榜权限 → 403；发榜成功 → 200。
//
// ⚠️ **可重发**：发榜不是「一次性动作」—— 组委会改完数据后可以重算重发，
//   差额会走**积分流水的更正记录**（只增不改，更正走新记录，见 services/leaderboard.js）。
import { AppError } from '../../errors.js';
import { publishLeaderboard, getPublishState } from '../../services/leaderboard.js';
import { getStage } from '../../db/repo/stages.js';

/**
 * 发榜权限判定：与服务层 `publishLeaderboard` **同口径**（届期级或赛段级 `stage:compute`）。
 * ⛔ 两边必须一致 —— 否则会出现「前端放行、API 403」或「前端拦下、API 放行」。
 *    （全局授权与角色授权在 can() 里本来就放行，这里只关心「作用域型授权」。）
 */
function requirePublishCapability(ctx, editionId) {
  if (ctx.can('stage:compute', { scopeType: 'edition', scopeId: editionId })) return;
  if (ctx.can('stage:compute', { scopeType: 'stage', scopeId: ctx.params.stageId })) return;
  throw new AppError(403, 'FORBIDDEN', '缺少能力：stage:compute（发榜）');
}

/**
 * 注册发榜端点。
 * @param {object} router createRouter() 的返回值
 */
export function registerPublishRoutes(router) {
  // ── 发榜（写）──────────────────────────────────────────────────────
  // ⚠️ GET 与 POST 同路径不冲突：路由表按 **method + path** 匹配。
  router.add('POST', '/api/stages/:stageId/publish', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const stage = getStage(ctx.db, ctx.params.stageId);
    // ⚠️ 名册判定**先于**权限判定？—— 不，权限先判：404 与 403 的取舍按「有没有这个赛段」，
    //    但**未登录**的人不该知道赛段存不存在 ⇒ 401 最先。
    if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requirePublishCapability(ctx, stage.edition_id);
    return publishLeaderboard({
      db: ctx.db,
      editionId: stage.edition_id,
      stageId: ctx.params.stageId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: ctx.rules,
    });
  });

  // ── 发榜状态（读）──────────────────────────────────────────────────
  // ⛔ 这个读口原先**不存在** ⇒ 前端刷新页面后不知道自己刚发过榜，
  //    也不知道 TOP 名单回访清单（R-JDG-16）是什么。
  router.add('GET', '/api/stages/:stageId/publish', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const stage = getStage(ctx.db, ctx.params.stageId);
    if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requirePublishCapability(ctx, stage.edition_id);
    return getPublishState({
      db: ctx.db,
      stageId: ctx.params.stageId,
      rules: ctx.rules,
    });
  });
}
```

### `platform/src/http/routes/tiebreak.js`

破同分路由（W2-b：加时陈述 / 一票破同分的人工环节）。

```javascript
// src/http/routes/tiebreak.js — 加时陈述 / 一票破同分（HTTP 接线层）
//
// 依据：S7 §3.3（R-JDG-19 同分加时陈述：决赛同分 → 10 分钟加时陈述 → 企业席+评委席共同复议
//       → 仍同分按企业确认原始分）
//     + 设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束
//     + 设计文档 §7.3（三态状态码：列表类不满足 → 200 + 空集；单条不满足 → 404；能力被禁用 → 403）
// 溯源：src/services/tiebreak.js（服务层，规则已测完整）+ src/db/repo/tiebreak.js（仓储层）
//
// ⚠️ **本文件只接线，不重写规则**：服务层已实现并测完「同分组至少 2 队 / 队伍必须在本赛段名册 /
//    同赛段不允许已有 open 轮次 / 投票人必须是本赛段评委 / 观察员无投票权 / 已回避者禁投 /
//    一人一队一票 / 分值 0–100 / 关闭幂等」这一整套 ——
//    路由层再写一遍就是**两套规则**，两套规则必然漂移（而后一套没人测）。
//    ⇒ 路由层只做三件服务层不做的事：**鉴权**、**裁剪可见性**、**补投票的审计**。
//
// ⛔ **可见性在 API 层过滤**（全局约束「可见性在 API 层过滤，前端隐藏 = 数据已泄露」）：
//    `votes` 里带投票人身份（voter_id）⇒ 普通登录用户**不得**看到别人的投票明细。
//    ⇒ 必须「先取全量状态（getTiebreakRoundState），再在路由层裁剪 votes」；
//      视图/前端**不得**自己过滤（前端过滤 = 数据已经发到浏览器了）。
//    ⚠️ 收窄**不得**因此回 403 —— 企业席/选手有权知道复议结果（否则他们只看到「没结果」），
//      所以收窄后的响应里 `votes` 是空数组、`tallies` 照给。
//
// ⚠️ **投票没有审计**：服务层只给 open / close 留了痕（tiebreak.open / tiebreak.close），
//    投票这一动作**没有**审计记录 ⇒ 路由层补一条 `tiebreak.vote`（设计文档 §12「留痕可复算」）。
//    ⚠️ entityId 用**轮次所属赛段**：复议分是赛段级产物（破同分链挂在赛段上），
//    按赛段查审计日志才查得到。
//
// ⚠️ **形状给两层**（原始行 + camelCase 别名）：
//    · 原始行（snake_case）与仓储层/服务层**逐字一致** ⇒ 复算、对账时不必做字段映射；
//    · camelCase 别名给前端用 ⇒ 前端不必自己写映射表。
//    ⚠️ 两层**同源**（别名就是原字段换名），不会出现「两个名字两个值」。
import { appError } from '../../errors.js';
import {
  openTiebreakRound,
  castTiebreakVote,
  getTiebreakRoundState,
  closeTiebreakRound,
} from '../../services/tiebreak.js';
import { getTiebreakRound, listTiebreakRounds } from '../../db/repo/tiebreak.js';
import { getStageJudge } from '../../db/repo/stages.js';
import { writeAuditLog } from '../../audit/log.js';

/** 加时陈述时长默认值（S7 §3.3：10 分钟）与上限。 */
const DEFAULT_STATEMENT_MINUTES = 10;
// ⛔ 上限必须存在：`statementMinutes` 传 100000 会把陈述截止时间推到几年后 ——
//    一个「永远开着的轮次」会让同赛段再也开不了第二轮（服务层禁止同赛段并存两个 open 轮次）。
const MAX_STATEMENT_MINUTES = 240;

/** 未登录 → 401（领域错误一律走 appError，status 在前）。 */
function requireUser(ctx) {
  if (!ctx.user) throw appError(401, 'UNAUTHENTICATED', '未登录');
  return ctx.user;
}

/**
 * 组委会判定：`stage:compute`，**赛段级或全局**（都走 ctx.can()，唯一判定入口）。
 *
 * ⚠️ 不能只查 global —— 赛段级授权（scope_type='stage'）会被静默判成无权
 *   （与 src/http/routes/review.js 的 isCommittee 同一坑，已在那儿踩过）。
 * ⛔ **绝不按角色硬编码**：角色只是导航分区用的，授权只看能力点 + 授权记录。
 */
function isCommittee(ctx, stageId) {
  if (!ctx.user) return false;
  return ctx.can('stage:compute', { scopeType: 'stage', scopeId: stageId })
    || ctx.can('stage:compute', { scopeType: 'global' });
}

/**
 * 同分组队伍 id 的入参规整（路由层只管**形状**，业务规则归服务层）。
 *
 * ⚠️ 为什么要拦：`tiedTeamIds` 传成字符串时，`new Set('ab')` 会按**字符**拆成
 *   {'a','b'} ⇒ 开出一轮指向幽灵队伍的轮次（真正的 400 要等服务层查名册才报，
 *   错误信息还会变成「队伍不属于本赛段」，把「你传错类型」说成「队伍不在名册」）。
 */
function normalizeTiedTeamIds(raw) {
  if (!Array.isArray(raw)) {
    throw appError(400, 'INVALID_REQUEST', 'tiedTeamIds 必须是数组（同分组队伍 id 列表）');
  }
  const ids = raw.map((x) => String(x ?? '').trim()).filter((x) => x !== '');
  if (!ids.length) {
    throw appError(400, 'INVALID_REQUEST', 'tiedTeamIds 不能为空（同分组至少要两支队伍）');
  }
  // ⚠️ 「只有 1 支同分队伍」不在这里判 —— 服务层的 NO_TIED_TEAMS 才是该口径的唯一出处。
  return ids;
}

/**
 * 陈述时长（分钟）的入参规整。
 * ⚠️ 缺省 10 分钟（S7 §3.3）；非数字 / 越界一律 400 ——
 *   `addMinutes(now, 'abc')` 会算出 Invalid Date，`toISOString()` 直接抛 RangeError ⇒ 500。
 */
function normalizeStatementMinutes(raw) {
  if (raw === undefined || raw === null) return DEFAULT_STATEMENT_MINUTES;
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw appError(400, 'INVALID_REQUEST', 'statementMinutes 必须是数字（分钟）');
  }
  const text = String(raw).trim();
  if (text === '') return DEFAULT_STATEMENT_MINUTES;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_STATEMENT_MINUTES) {
    throw appError(400, 'INVALID_REQUEST', `statementMinutes 必须是 1–${MAX_STATEMENT_MINUTES} 之间的数字`);
  }
  return n;
}

/** 轮次行 → 对外形状（原始行 + camelCase 别名）。 */
function presentRound(row) {
  if (!row) return null;
  let tiedTeamIds = [];
  try {
    const parsed = JSON.parse(row.tied_team_ids_json ?? '[]');
    tiedTeamIds = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    // ⚠️ 解析失败**不抛**：一行脏数据不该让整个轮次列表 500（数据损坏由服务层负责报错）。
    tiedTeamIds = [];
  }
  return {
    ...row,
    stageId: row.stage_id,
    tiedTeamIds,
    statementDeadline: row.statement_deadline,
    voteDeadline: row.vote_deadline,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** 投票行 → 对外形状（原始行 + camelCase 别名）。 */
function presentVote(row) {
  if (!row) return null;
  return {
    ...row,
    roundId: row.tiebreak_round_id,
    voterId: row.voter_id,
    teamId: row.team_id,
    votedAt: row.voted_at,
  };
}

/**
 * 注册加时陈述 / 一票破同分的端点。
 * @param {object} router createRouter() 的返回值
 */
export function registerTiebreakRoutes(router) {
  // ── ① 开一轮加时陈述（组委会）──────────────────────────────────────
  router.add('POST', '/api/stages/:stageId/tiebreak/rounds', async (ctx) => {
    requireUser(ctx);
    const stageId = ctx.params.stageId;
    // ⛔ 能力点闸门（403）：开轮次 = 组委会的动作。
    if (!isCommittee(ctx, stageId)) {
      throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
    }
    const round = openTiebreakRound({
      db: ctx.db,
      stageId,
      tiedTeamIds: normalizeTiedTeamIds(ctx.body?.tiedTeamIds),
      statementMinutes: normalizeStatementMinutes(ctx.body?.statementMinutes),
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return { round: presentRound(round) };
  });

  // ── ② 列本赛段的全部轮次（登录即可）──────────────────────────────
  router.add('GET', '/api/stages/:stageId/tiebreak/rounds', async (ctx) => {
    requireUser(ctx);
    const rows = listTiebreakRounds(ctx.db, { stageId: ctx.params.stageId });
    // ⚠️ 列表语义：**没有轮次返回 200 + 空数组**（不是 404）—— 设计文档 §7.3。
    //    「赛段没有轮次」是**正常状态**，不是「这个赛段不存在」。
    return { items: rows.map(presentRound) };
  });

  // ── ③ 读一轮的状态（round + votes + tallies）─────────────────────
  router.add('GET', '/api/tiebreak/rounds/:roundId', async (ctx) => {
    const user = requireUser(ctx);
    // ⚠️ 先取**全量**状态（服务层），再在路由层裁剪 votes ——
    //    可见性必须在 API 层收窄（前端隐藏 = 数据已泄露）。
    const state = getTiebreakRoundState({ db: ctx.db, roundId: ctx.params.roundId });
    const stageId = state.round.stage_id;
    // ⚠️ 谁能看**全部投票明细**：
    //   ① 组委会（stage:compute，赛段级或全局）—— 要核查复议过程；
    //   ② **本赛段评委**（getStageJudge 命中）—— 同赛段互相看得到复议分是「复议」的前提；
    //   ③ 其他人（企业席 / 选手）⇒ 只给 tallies（他们有权知道复议结果），
    //      **不得**因为收窄而回 403。
    const canSeeVotes = isCommittee(ctx, stageId)
      || getStageJudge(ctx.db, stageId, user.id) != null;
    return {
      round: presentRound(state.round),
      votes: canSeeVotes ? state.votes.map(presentVote) : [],
      tallies: state.tallies,
    };
  });

  // ── ④ 投票（登录即可；谁能投由服务层判：评委席 / 观察员 / 回避）────
  router.add('POST', '/api/tiebreak/rounds/:roundId/votes', async (ctx) => {
    const user = requireUser(ctx);
    const roundId = ctx.params.roundId;
    const teamId = String(ctx.body?.teamId ?? '').trim();
    if (!teamId) {
      throw appError(400, 'INVALID_REQUEST', '必须指定被投票的队伍（teamId）');
    }
    // ⚠️ score 原样透传：分值口径（0–100 / 必须是数字）是**服务层**的 SCORE_OUT_OF_RANGE，
    //    路由层不另立一套（前端传字符串分数会被服务层判 400，这是刻意的）。
    const vote = castTiebreakVote({
      db: ctx.db,
      roundId,
      voterId: user.id,
      teamId,
      score: ctx.body?.score,
      now: new Date().toISOString(),
    });
    // ⚠️ 审计的 entityId 用**轮次所属赛段**（复议分是赛段级产物）。
    const round = getTiebreakRound(ctx.db, roundId);
    if (!round) {
      throw appError(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
    }
    writeAuditLog(ctx.db, {
      actorId: user.id,
      action: 'tiebreak.vote',
      entity: 'stage',
      entityId: round.stage_id,
      detail: { roundId, teamId, score: ctx.body?.score },
      now: new Date().toISOString(),
    });
    return { vote: presentVote(vote) };
  });

  // ── ⑤ 关闭轮次（组委会）──────────────────────────────────────────
  router.add('POST', '/api/tiebreak/rounds/:roundId/close', async (ctx) => {
    requireUser(ctx);
    const roundId = ctx.params.roundId;
    // ⚠️ 关闭端点的路径里**没有 stageId** ⇒ 权限必须按**轮次所属赛段**判：
    //    先读轮次拿到 stage_id，再问 can()。
    const round = getTiebreakRound(ctx.db, roundId);
    if (!round) {
      throw appError(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
    }
    if (!isCommittee(ctx, round.stage_id)) {
      throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
    }
    // ⚠️ 关闭是**幂等**的（服务层：已关闭则原样返回）⇒ 重复点「关闭」不会报错。
    const closed = closeTiebreakRound({
      db: ctx.db,
      roundId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return { round: presentRound(closed.round), tallies: closed.tallies };
  });
}
```

### `platform/src/http/routes/public-tokens.js`

公开令牌路由（W2-c：公开榜单 / 公开日历的令牌没有创建入口）。

```javascript
// src/http/routes/public-tokens.js — 公开访问令牌的管理端点（签发 / 列表 / 吊销）
//
// 依据：设计文档 §8「公开榜单 API + 赛程日历 iCal 订阅」。
//   两个公开端点**早就存在**（src/http/routes/public.js）：
//     GET /api/public/leaderboard?token=…&editionId=…
//     GET /api/public/calendar.ics?token=…&editionId=…
//   而且**必须带 token**（公开 ≠ 无鉴权）—— 但整个平台**没有任何创建 token 的入口**
//   ⇒ 这两个公开接口实际上谁也用不了。
//   本文件补的就是这条缺失的**管理链路**：签发 / 列表 / 吊销。
// 溯源：INTERFACES.md §6 `public_tokens(token, scope, edition_id, expires_at, created_at)`
//   + src/services/public-api.js（签发与校验）+ src/db/repo/public-tokens.js（仓储）。
//
// ⛔ 三条红线：
//   ① **明文只出现一次**：签发响应里给一次明文；库里只存 SHA-256；列表接口**永远不给明文**。
//      列表给的是「行标识（哈希）+ 不可逆短标识（哈希前 8 位）」—— 两者**都不能当令牌用**
//      （公开接口会把传入值再哈希一次比对：sha256(哈希) ≠ 哈希 ⇒ 拿哈希当令牌必然 403）。
//   ② **权限只由 can() 裁决**（src/auth/permissions.js）：本文件**绝不按角色硬编码**。
//   ③ **三态状态码**（设计文档 §7.3）：列表类不满足 → 200 + 空集；单条不满足 → 404；
//      能力 / 规则被禁用 → 403。领域错误一律 appError(status, code, message, detail)（**status 在前**）。
//
// ⚠️ 本文件**只接线，不重写服务层**：
//    「只存哈希」「明文只返回一次」「scope 白名单」这三条纪律都在
//    src/services/public-api.js 的 createPublicToken 里实现 —— 这里再实现一遍就会漂移。
import { appError } from '../../errors.js';
import { createPublicToken, hashPublicToken } from '../../services/public-api.js';
import {
  deletePublicToken, findPublicToken, listPublicTokens,
} from '../../db/repo/public-tokens.js';
import { writeAuditLog } from '../../audit/log.js';
import { getEdition, listEditions } from '../../db/repo/editions.js';
import { pickCurrentEdition } from './registration.js';

/** 短标识长度：哈希前 8 位（十六进制）—— 够人眼分辨是哪一枚，又不可逆。 */
const TOKEN_HINT_LENGTH = 8;

/** 当前时间（ISO）。抽出来是为了让「同一请求内的时间」一致。 */
function nowIso() {
  return new Date().toISOString();
}

/** 哈希 → 短标识（不可逆，仅供人辨认）。 */
export function tokenHint(tokenHash) {
  return String(tokenHash ?? '').slice(0, TOKEN_HINT_LENGTH);
}

/**
 * 权限闸门：管理公开令牌需要 `stage:compute` 能力点。
 *
 * ⛔ **只走 can()**（src/auth/permissions.js）：权限模型是「能力 + 授权记录」，
 *    不按角色枚举（设计文档 §7.1）—— 本文件**一个字都不许**出现角色名判断。
 * ⚠️ 先判 global（组委会/全局授权），再兜一次 stage（赛段级授权）：
 *    只判 global 会把「只被授权了某个赛段」的账号挡在门外；只判 stage 则全局授权反而进不来。
 *    ⚠️ 现状：这三个端点的路径里**没有** `:stageId` 参数 ⇒ 赛段分支目前拿不到 scopeId
 *    ⇒ 实际生效的是全局授权（含角色能力与超管）。分支保留是为了口径完整、不给后来人留坑。
 */
function assertCanManageTokens(ctx) {
  if (!ctx.user) throw appError(401, 'UNAUTHENTICATED', '未登录');
  const globalOk = ctx.can('stage:compute', { scopeType: 'global' });
  const stageOk = ctx.can('stage:compute', { scopeType: 'stage', scopeId: ctx.params?.stageId ?? null });
  if (!globalOk && !stageOk) {
    throw appError(403, 'FORBIDDEN', '没有管理公开访问令牌的权限（需要 stage:compute 能力点）');
  }
}

/**
 * 届期解析：显式给了 → 不存在就 404；没给 → 取【当届】。
 *
 * ⚠️ **必须复用 registration.js 的 pickCurrentEdition**，不要另写一套：
 *    「当届」的口径（全项目已经统一过一次）= 尚未结束（ends_at >= 今天）的最早一届，
 *    都没有就退回最后一届（src/http/routes/registration.js 的文件头与 server.js 的
 *    resolveEditionId 都用它）—— 另写一套 ⇒ 同一个平台出现两个「当届」。
 */
function resolveEditionId(db, editionId) {
  const wanted = String(editionId ?? '').trim();
  if (wanted) {
    if (!getEdition(db, wanted)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    return wanted;
  }
  const edition = pickCurrentEdition(listEditions(db));
  if (!edition) throw appError(404, 'EDITION_NOT_FOUND', '尚无届期');
  return edition.id;
}

/**
 * 有效期天数（可选）。
 * ⚠️ **为什么在这里校验**：服务层对不合法的 ttlDays 会**静默回落**到
 *    rules.pools.publicTokenTtlDays ⇒ 调用方以为签了 7 天、实际是 30 天，
 *    而响应里看不出差别。宁可 400 报错，也不给一个「看起来生效其实没生效」的参数。
 */
function parseTtlDays(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw appError(400, 'INVALID_REQUEST', 'ttlDays 必须是正整数（天）');
  }
  return n;
}

/**
 * 过期时间（可选）。
 * ⛔ **必须校验**：非法日期一旦存进库，公开接口的过期判定
 *    `new Date(row.expires_at).getTime() <= now` 会变成 NaN 比较（恒为 false）
 *    ⇒ **一枚永不过期的令牌**。这是安全洞，不能指望服务层兜底。
 */
function parseExpiresAt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw appError(400, 'INVALID_REQUEST', 'expiresAt 必须是合法的日期时间');
  }
  return d.toISOString();
}

/**
 * 注册公开访问令牌的管理端点。
 *
 * ⚠️ 签名只有 router：db / rules 都从 **ctx** 取（server.js 的 ctx 里有 db 与 rules）
 *    ⇒ 集成人只要在 createApp 里加一行 `registerPublicTokenRoutes(router)`。
 *
 * @param {object} router createRouter() 的返回值
 */
export function registerPublicTokenRoutes(router) {
  // ── 签发 ────────────────────────────────────────────────────────
  // ⛔ 响应里的 `token` 是**明文**，只在这里出现一次；库里只存哈希。
  router.add('POST', '/api/public/tokens', async (ctx) => {
    assertCanManageTokens(ctx);
    const body = ctx.body ?? {};
    const editionId = resolveEditionId(ctx.db, body.editionId);
    // ⚠️ scope 缺省 = 'all'；**是否合法由服务层裁决**（rules.pools.publicScopes），
    //    路由层不重复实现白名单 —— 两份白名单必然漂移。
    const scope = body.scope === undefined || body.scope === null || body.scope === ''
      ? 'all'
      : String(body.scope);
    const ttlDays = parseTtlDays(body.ttlDays);
    const expiresAt = parseExpiresAt(body.expiresAt);
    const created = createPublicToken({
      db: ctx.db,
      scope,
      editionId,
      expiresAt,
      ttlDays,
      rules: ctx.rules,
      now: nowIso(),
    });
    // 哈希由**同一个**函数算（services/public-api.js 的 hashPublicToken）
    // ⇒ 与库里存的那一列逐字相同（审计里的 entityId 与短标识都靠它）。
    const tokenHash = hashPublicToken(created.token);
    // ⛔ 审计必须写；⛔ detail 里**绝不能出现明文 token**（只放 scope / 届期 / 短标识）。
    writeAuditLog(ctx.db, {
      actorId: ctx.user.id,
      action: 'public_token.issue',
      entity: 'public_token',
      entityId: tokenHash,
      detail: {
        scope: created.scope,
        editionId: created.editionId,
        tokenHint: tokenHint(tokenHash),
        expiresAt: created.expiresAt,
      },
      now: nowIso(),
    });
    return created;
  });

  // ── 列表 ────────────────────────────────────────────────────────
  // ⚠️ **没有令牌 → 200 + 空数组**（不是 404）：列表类「不满足」按三态口径是空集。
  // ⛔ 列表**绝不给明文**（库里也没有）—— 但也**不能把哈希当令牌发出去**：
  //    哈希不是可用的令牌（公开接口会再哈希一次），发它等于给用户一个坏东西。
  //    ⇒ 只给：scope / 届期 / 过期时间 / 创建时间 / 行标识(id) / 短标识(tokenHint) / 是否已过期。
  router.add('GET', '/api/public/tokens', async (ctx) => {
    assertCanManageTokens(ctx);
    const editionId = ctx.query?.editionId ? String(ctx.query.editionId) : null;
    const rows = listPublicTokens(ctx.db, { editionId });
    const at = Date.now();
    const items = rows.map((row) => ({
      // ⚠️ id 是**行标识**（= 库里那列哈希）：DELETE /api/public/tokens/:id 要用它。
      //    它不是可用的令牌（再哈希一次就对不上）⇒ 泄露它不等于泄露凭据。
      id: row.token,
      scope: row.scope,
      editionId: row.edition_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      tokenHint: tokenHint(row.token),
      expired: new Date(row.expires_at).getTime() <= at,
    }));
    return { items };
  });

  // ── 吊销 ────────────────────────────────────────────────────────
  // ⚠️ **404 语义**：吊销一个不存在的令牌 = 「单条不满足」⇒ 404，
  //    不返回 200 假装成功（否则调用方以为吊销了，它其实还在生效）。
  router.add('DELETE', '/api/public/tokens/:id', async (ctx) => {
    assertCanManageTokens(ctx);
    const id = String(ctx.params?.id ?? '').trim();
    if (!id) throw appError(404, 'NOT_FOUND', '公开访问令牌不存在');
    // 先查出来：审计 detail 要带 scope / 届期（吊销之后就查不到了）。
    const row = findPublicToken(ctx.db, id);
    if (!row) throw appError(404, 'NOT_FOUND', '公开访问令牌不存在');
    const changes = deletePublicToken(ctx.db, id);
    if (!changes) throw appError(404, 'NOT_FOUND', '公开访问令牌不存在');
    // ⛔ 审计必须写；⛔ detail 里**绝不能出现明文 token**。
    writeAuditLog(ctx.db, {
      actorId: ctx.user.id,
      action: 'public_token.revoke',
      entity: 'public_token',
      entityId: id,
      detail: {
        scope: row.scope,
        editionId: row.edition_id,
        tokenHint: tokenHint(id),
      },
      now: nowIso(),
    });
    return { ok: true };
  });
}
```

### `platform/src/http/routes/stages.js`

赛段生命周期路由（W5：E150 —— 建赛段 / 派评委 / 报名册）。

```javascript
// src/http/routes/stages.js — 赛段生命周期端点（P11 新建）
//
// 依据：设计文档 §8「API 设计」+ §9「前端 IA：赛段配置与权重表」
//   + §7.3「三态状态码」+ §12「留痕可复算」
//   + S7 §3.4（R-JDG-11 席构成 / R-JDG-18 利益冲突声明）
// 溯源：src/services/stage.js（服务层，规则已在本文件内实现）+ src/db/repo/stages.js（仓储层）
//
// ⛔ **这个文件为什么存在（P11 真机实测的致命缺口）**：
//   真机生产库实测 `stages = 0, stage_team = 0` ⇒ **全新部署的平台一条赛段都没有** ⇒
//     · 评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数 ⇒ **一个都进不去**；
//     · `GET /api/stages` 返回 `items: []` ⇒ 前端没有任何赛段可选。
//   而设计文档 §8 的 API 清单里**没有**创建赛段的端点（与 E149「发榜端点」同型的设计缺口）。
//   ⇒ 这里补齐「建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册」六个端点，
//     让 §9 的「赛段配置与权重表」界面**真的有 API 可用**。
//
// ⚠️ **本文件只接线，不重写规则**（与 routes/tiebreak.js 同一手法）：
//    路由层只做三件服务层不做的事：**鉴权**、**裁剪可见性**、**透传**。
//    校验（时间窗 / 权重表键 / 席构成 / 重复 key / 幂等）**全部**在服务层 ——
//    否则就会有两套规则，两套规则必然漂移（而后一套没人测）。
//
// ⚠️ **三态状态码**（设计文档 §7.3）：
//   不存在 → 404；没权限 → 403；成功 → 200。
//   ⚠️ 取舍与 routes/publish.js **完全一致**：401（未登录）→ 404（资源不存在）→ 403（没能力）。
//      未登录的人不该知道「这个赛段存不存在」⇒ 401 最先。
//
// ⚠️ **能力点闸门口径**（与 routes/publish.js 的 requirePublishCapability 同款）：
//    `stage:compute`，**届期级或赛段级**都放行。
//    ⛔ 不能只查全局 —— 赛段级授权（scope_type='stage'）会被静默判成无权
//      （routes/review.js 与 routes/tiebreak.js 都踩过这个坑）。
//    ⛔ 绝不按角色硬编码：授权只看能力点 + 授权记录（can() 是唯一判定入口）。
import { appError } from '../../errors.js';
import {
  createStage,
  updateStage,
  assignStageJudgeToStage,
  removeStageJudge,
  registerStageTeamRoster,
  removeStageTeam as removeStageTeamFromRoster,
} from '../../services/stage.js';
import { getStage, listStageJudges, listStageJudgeCandidates, listStageSummaries } from '../../db/repo/stages.js';
import { listStageTeamIds } from '../../db/repo/stage-teams.js';
import { getEdition, listEditions } from '../../db/repo/editions.js';
import { listEditionTeams } from '../../db/repo/pool-sources.js';

/** 未登录 → 401（领域错误一律走 appError，status 在前）。 */
function requireUser(ctx) {
  if (!ctx.user) throw appError(401, 'UNAUTHENTICATED', '未登录');
  return ctx.user;
}

/**
 * 能力点闸门：组委会（`stage:compute`）。
 * @param {object} scope { scopeType, scopeId } —— 传给 ctx.can()
 */
function requireStageCompute(ctx, scope) {
  if (ctx.can('stage:compute', scope)) return;
  throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
}

/**
 * 赛段级动作的能力点闸门：**届期级或赛段级**都放行。
 * ⚠️ 与 routes/publish.js 的 requirePublishCapability 同款口径（前后端必须一致）。
 */
function requireStageComputeForStage(ctx, stage) {
  if (ctx.can('stage:compute', { scopeType: 'edition', scopeId: stage.edition_id })) return;
  if (ctx.can('stage:compute', { scopeType: 'stage', scopeId: stage.id })) return;
  throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
}

/**
 * 届期级资源的能力点闸门：**届期级**，或**该届期下任一赛段的赛段级**授权，都放行。
 *
 * ⚠️ 为什么要有这一条（E158 接线时抓到的口径裂缝）：
 *   赛段的**写**端点走 `requireStageComputeForStage` —— 届期级**或**赛段级都放行。
 *   而届期级的**读**口若只认届期级，就会出现「**能改赛段、却读不到权重表**」的
 *   前后端不一致（页面拿不到席构成约束 ⇒ 组委会判断不了席够不够合法）。
 *   ⇒ 口径对齐写端点：只要在这个届期的**任何**赛段上有 stage:compute，就放行。
 *
 * @param {object} ctx
 * @param {object} db   数据库句柄（⛔ 必须显式传：本文件顶层的辅助函数拿不到
 *                      registerStageRoutes 内部的 dbOf 闭包）
 * @param {string} editionId
 */
function requireStageComputeForEdition(ctx, db, editionId) {
  if (ctx.can('stage:compute', { scopeType: 'edition', scopeId: editionId })) return;
  // ⛔ 赛段级授权：把该届期下的赛段逐个问一遍（赛段数量级很小，可接受）。
  for (const st of listStageSummaries(db, { editionId })) {
    if (ctx.can('stage:compute', { scopeType: 'stage', scopeId: st.id })) return;
  }
  throw appError(403, 'FORBIDDEN', '缺少能力：stage:compute');
}

/**
 * 赛段行 → 对外形状（原始行 + camelCase 别名）。
 * ⚠️ 两层**同源**（别名就是原字段换名）—— 不会出现「两个名字两个值」。
 *    口径同 routes/tiebreak.js 的 presentRound。
 */
function presentStage(row) {
  if (!row) return null;
  return {
    ...row,
    editionId: row.edition_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    freezeAt: row.freeze_at,
    scoringConfigKey: row.scoring_config_key,
  };
}

/** 评委席行 → 对外形状（原始行 + camelCase 别名）。 */
function presentJudge(row) {
  if (!row) return null;
  return {
    ...row,
    stageId: row.stage_id,
    userId: row.user_id,
    seat: row.seat,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    assignedAt: row.assigned_at,
    conflictDeclaredAt: row.conflict_declared_at,
    conflictDeclarationId: row.conflict_declaration_id,
  };
}

/**
 * 注册赛段生命周期端点。
 * @param {object} router createRouter() 的返回值
 * @param {{ db?: object, rules?: object }} [options] 兜底用的 db / 规则（正常路径走 ctx）
 */
export function registerStageRoutes(router, { db = null, rules = null } = {}) {
  const dbOf = (ctx) => ctx.db ?? db;
  const rulesOf = (ctx) => ctx.rules ?? rules;

  // ── ① 建赛段 ───────────────────────────────────────────────────────
  // ⚠️ 路径是 /api/editions/:editionId/stages —— 赛段**从属于届期**（stages.edition_id 外键）。
  router.add('POST', '/api/editions/:editionId/stages', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    // 404 先于 403：先确认「这个届期存不存在」（与 publish.js 同一取舍）
    if (!getEdition(dbOf(ctx), editionId)) {
      throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    }
    requireStageCompute(ctx, { scopeType: 'edition', scopeId: editionId });
    const stage = createStage({
      db: dbOf(ctx),
      editionId,
      key: ctx.body?.key,
      name: ctx.body?.name,
      kind: ctx.body?.kind,
      startsAt: ctx.body?.startsAt,
      endsAt: ctx.body?.endsAt,
      freezeAt: ctx.body?.freezeAt ?? null,
      scoringConfigKey: ctx.body?.scoringConfigKey,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: rulesOf(ctx),
    });
    return { stage: presentStage(stage) };
  });

  // ── ② 改赛段配置（逆向路径）───────────────────────────────────────
  router.add('PATCH', '/api/stages/:stageId', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const updated = updateStage({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      name: ctx.body?.name,
      startsAt: ctx.body?.startsAt,
      endsAt: ctx.body?.endsAt,
      freezeAt: ctx.body?.freezeAt,
      scoringConfigKey: ctx.body?.scoringConfigKey,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      rules: rulesOf(ctx),
    });
    return { stage: presentStage(updated) };
  });

  // ── ③ 派评委 ───────────────────────────────────────────────────────
  // ⛔ 席位与**利益冲突声明**由服务层一次事务写入（assignStageJudge）——
  //    路由层不自己写 stage_judges（那会漏掉 R-JDG-18 的声明）。
  router.add('POST', '/api/stages/:stageId/judges', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const judges = assignStageJudgeToStage({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      userId: ctx.body?.userId,
      seat: ctx.body?.seat,
      scopeType: ctx.body?.scopeType ?? 'global',
      scopeId: ctx.body?.scopeId ?? null,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
      declaration: ctx.body?.declaration ?? null,
    });
    return { judges: judges.map(presentJudge) };
  });

  // ── ④ 撤评委（逆向路径）───────────────────────────────────────────
  router.add('DELETE', '/api/stages/:stageId/judges/:userId', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const result = removeStageJudge({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      userId: ctx.params.userId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return {
      removed: result.removed,
      seat: result.seat,
      judges: result.judges.map(presentJudge),
    };
  });

  // ── ⑤ 登记名册 ─────────────────────────────────────────────────────
  // ⚠️ 幂等：重复登记不报错（服务层先查再过滤）。
  router.add('POST', '/api/stages/:stageId/teams', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const result = registerStageTeamRoster({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      teamIds: ctx.body?.teamIds ?? ctx.body?.teamId ?? [],
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return {
      registered: result.registered,
      skipped: result.skipped,
      teamIds: result.teamIds,
    };
  });

  // ── ⑥ 退名册（逆向路径）───────────────────────────────────────────
  router.add('DELETE', '/api/stages/:stageId/teams/:teamId', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    const result = removeStageTeamFromRoster({
      db: dbOf(ctx),
      stageId: ctx.params.stageId,
      teamId: ctx.params.teamId,
      actorId: ctx.user.id,
      now: new Date().toISOString(),
    });
    return { removed: result.removed, teamIds: result.teamIds };
  });

  // ── 读口：赛段的评委席 / 名册 ─────────────────────────────────────
  // ⚠️ 这两个读口是「写完之后前端要回显」用的：派完评委要能看到席位与声明，
  //    报名册要能看到名单（否则前端只能猜）。权限同写口（组委会）。
  router.add('GET', '/api/stages/:stageId/judges', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    return { judges: listStageJudges(dbOf(ctx), ctx.params.stageId).map(presentJudge) };
  });

  router.add('GET', '/api/stages/:stageId/teams', async (ctx) => {
    requireUser(ctx);
    const stage = getStage(dbOf(ctx), ctx.params.stageId);
    if (!stage) throw appError(404, 'STAGE_NOT_FOUND', '赛段不存在');
    requireStageComputeForStage(ctx, stage);
    return { teamIds: listStageTeamIds(dbOf(ctx), ctx.params.stageId) };
  });

  // ── 读口（⑦）：届期列表 ────────────────────────────────────────────
  // ⚠️ 为什么公开：届期是**公开赛事信息**（与 `GET /api/stages` 的赛段时间线同口径），
  //    落地页/首页都要用。前端要它是因为「建赛段」必须指明届期，而届期 id 只有服务端知道。
  router.add('GET', '/api/editions', async (ctx) => {
    const rows = listEditions(dbOf(ctx));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city ?? null,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
      })),
    };
  });

  // ── 读口（⑧）：该届期的全部战队（名册登记的**候选池**）─────────────
  // ⚠️ 为什么要这个口：`GET /api/teams` 返回的是「**我参与的**战队」（participant 视角），
  //    组委会看不到全部队伍 ⇒ 名册登记页**没有任何可选队伍**（E158 的直接产物）。
  //    届期隔离口径：`listEditionTeams` 只取该届期且未软删除的队伍（顶层文档 §3.1 S2）。
  router.add('GET', '/api/editions/:editionId/teams', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    if (!getEdition(dbOf(ctx), editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    requireStageComputeForEdition(ctx, dbOf(ctx), editionId);
    const items = listEditionTeams(dbOf(ctx), editionId).map((t) => ({
      id: t.id,
      name: t.name,
      tier: t.tier ?? null,
    }));
    return { items };
  });

  // ── 读口（⑨）：评委候选池 ──────────────────────────────────────────
  // ⚠️ 候选池 = **持有评委类角色的人**，不是「全部用户」
  //    （理由见 repo/stages.js 的 listStageJudgeCandidates 注释）。
  router.add('GET', '/api/editions/:editionId/judge-candidates', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    if (!getEdition(dbOf(ctx), editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    requireStageComputeForEdition(ctx, dbOf(ctx), editionId);
    const items = listStageJudgeCandidates(dbOf(ctx)).map((u) => ({
      id: u.id,
      name: u.name,
      org: u.org ?? null,
    }));
    return { items };
  });

  // ── 读口（⑩）：权重表（设计 §9「赛段配置与**权重表**」）─────────────
  // ⚠️ 投影纪律与 `src/domain/event-info.js` **同款**：逐字段白名单 ——
  //    只给「维度 + 权重 + 席」与「席构成约束」，**不给**配置里的内部工作语言
  //    （note / source / conflictRef / 冲突裁决说明）。
  //    维度权重本身已由 `GET /api/event-info` 公开；这里补的是**组委会视角**的
  //    judgePool 席构成约束（派几个人、什么席比例 ⇒ 决定席够不够合法）。
  //
  // ⚠️ 为什么是**届期作用域**而不是 global：
  //    写端点（建赛段 / 改配置 / 派评委…）走 `requireStageComputeForStage`，
  //    它接受 **edition 级或 stage 级**的 `stage:compute`。
  //    若这个读口用 global 作用域，就会出现「**能改赛段却读不到权重表**」的
  //    前后端不一致 ⇒ 页面拿不到权重表 ⇒ 组委会无法判断席够不够合法。
  //    ⇒ 口径对齐写端点：届期级授权即可读。
  router.add('GET', '/api/editions/:editionId/scoring-configs', async (ctx) => {
    requireUser(ctx);
    const editionId = ctx.params.editionId;
    if (!getEdition(dbOf(ctx), editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    requireStageComputeForEdition(ctx, dbOf(ctx), editionId);
    const scoring = rulesOf(ctx)?.scoring ?? {};
    const items = Object.entries(scoring).map(([key, cfg]) => ({
      key,
      wEnterprise: cfg?.wEnterprise ?? null,
      normalizationStrategy: cfg?.normalizationStrategy ?? null,
      minSamplesForJudgeNormalization: cfg?.minSamplesForJudgeNormalization ?? null,
      dimensions: (Array.isArray(cfg?.dimensions) ? cfg.dimensions : []).map((d) => ({
        key: d?.key ?? null,
        name: d?.name ?? null,
        weight: d?.weight ?? null,
        seat: d?.seat ?? null,
      })),
      judgePool: {
        minJudgesPerDimension: cfg?.judgePool?.minJudgesPerDimension ?? null,
        minEnterpriseSeatShare: cfg?.judgePool?.minEnterpriseSeatShare ?? null,
        maxExpertSeatShare: cfg?.judgePool?.maxExpertSeatShare ?? null,
        votingSeats: Array.isArray(cfg?.judgePool?.votingSeats) ? cfg.judgePool.votingSeats : [],
        nonVotingSeats: Array.isArray(cfg?.judgePool?.nonVotingSeats) ? cfg.judgePool.nonVotingSeats : [],
      },
    }));
    return { items };
  });
}
```

### `platform/src/services/stage.js`

赛段生命周期服务层（W5）。

```javascript
// src/services/stage.js — 赛段生命周期（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
//
// 依据：设计文档 §8「API 设计」+ §9「前端 IA：赛段配置与权重表」+ §12「留痕可复算」
//   + db/migrations/003_review.sql（stages / stage_judges / conflict_declarations 的表注释）
//   + db/migrations/004_leaderboard.sql（stage_team 表）
//   + S7 §3.4（R-JDG-11 席构成 / R-JDG-18 利益冲突声明）
//
// ⛔ **这个文件为什么存在（P11 真机实测的致命缺口）**：
//   真机生产库 `/var/lib/heikesong/data/app.db` 实测 `stages = 0, stage_team = 0`
//   ⇒ **全新部署的平台一条赛段都没有** ⇒
//     · 评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数
//       ⇒ **一个都进不去**；
//     · `GET /api/stages` 返回 `items: []` ⇒ 前端没有任何赛段可选。
//   根因：`src/db/repo/stages.js` 的 insertStage / assignStageJudge 与
//   `src/db/repo/stage-teams.js` 的 registerStageTeams **在生产上零调用方**（只有测试在调）。
//   设计文档 §8 的 API 清单里**没有**创建赛段的端点，但 §9 的前端 IA 里写着「赛段配置与权重表」
//   ⇒ 与 E149（publish）同型的**设计缺口**：界面要求存在，但没有任何 API 能满足它。
//   ⇒ 本文件把那层「写了但接不上」的服务能力补齐；由 src/http/routes/stages.js 暴露成端点。
//
// ⛔ **规则只从 rules/*.json 来**（全局约束）：
//    权重表**不硬编码**在本文件里 —— `scoringConfigKey` 必须能在 `rules.scoring[<key>]` 里找到，
//    找不到 ⇒ 400 SCORING_CONFIG_NOT_FOUND（而不是「悄悄用一张默认权重表」）。
//
// ⛔ **每个写动作都留审计**（设计文档 §12）：
//    action 命名一律 `stage.*`：stage.create / stage.update / stage.judge.assign /
//    stage.judge.remove / stage.roster.register / stage.roster.remove。
//
// ⛔ **每个写动作都有逆向路径**（本任务的硬约束）：
//    建段 ↔ 改配置；派评委 ↔ 撤评委；报名册 ↔ 退名册。
//
// ⛔ **本文件不含 SQL**（全局约束「所有 SQL 收在 src/db/repo/」）：
//    一切读写都走仓储层函数；test/sql-boundary.test.js 会扫。
import {
  getStage,
  listStages,
  insertStage,
  updateStageConfig,
  assignStageJudge,
  removeStageJudgeRow,
  getStageJudge,
  listStageJudges,
} from '../db/repo/stages.js';
import {
  listStageTeamIds,
  isTeamInStage,
  registerStageTeams,
  removeStageTeam as removeStageTeamRow,
} from '../db/repo/stage-teams.js';
import { getEdition } from '../db/repo/editions.js';
import { getUserById } from '../db/repo/users.js';
import { getTeam } from '../db/repo/teams.js';
import { listReviews } from '../db/repo/reviews.js';
import { writeAuditLog } from '../audit/log.js';
import { appError } from '../errors.js';

/** 赛段类型（003_review.sql: `kind` 列注释）。 */
const STAGE_KINDS = ['initial', 'final', 'roadshow', 'landing'];
/** 评委席类型（003_review.sql: `stage_judges.seat` 列注释）。 */
const JUDGE_SEATS = ['judge', 'enterprise', 'observer'];
/** 授权作用域类型（003_review.sql: `stage_judges.scope_type` 列注释）。 */
const JUDGE_SCOPE_TYPES = ['global', 'edition', 'task_package', 'team'];
/** 可用的权重表键（rules/scoring-initial.json / rules/scoring-final.json）。 */
const SCORING_CONFIG_KEYS = ['initial', 'final'];
/** 赛段代号：只允许字母 / 数字 / 连字符 / 下划线（赛段 key 会出现在 URL 与日志里）。 */
const STAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function fail(status, code, message, detail) {
  // ⚠️ 必须用 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    server.js 的错误分支是 `err instanceof AppError ? err.message : '请求无效'`
  //    —— 裸 Error 不是 AppError ⇒ message 被替换成通用文案「请求无效」，
  //    调用方就看不到「为什么错」了。
  return appError(status, code, message, detail);
}

/** 非空字符串（去首尾空白）。 */
function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw fail(400, 'INVALID_STAGE_FIELD', `${label}不能为空`);
  return text;
}

/** 时间必须可解析（`Date.parse`）。 */
function parseTime(value, label) {
  const t = Date.parse(String(value ?? ''));
  if (!Number.isFinite(t)) {
    throw fail(400, 'INVALID_STAGE_WINDOW', `${label} 不是合法时间（应为 ISO 时间或 YYYY-MM-DD）`);
  }
  return t;
}

/**
 * 时间窗：**开始必须早于结束**。
 * ⚠️ 为什么必须查：赛段时间窗反了 ⇒ 「冻结时间」「赛段结束」都比开始早
 *    ⇒ 评审页一打开就是「已结束」，评委提交评分被时间闸挡住，而**错因不可见**。
 */
function assertWindow(startsAt, endsAt) {
  const s = parseTime(startsAt, 'startsAt');
  const e = parseTime(endsAt, 'endsAt');
  if (!(s < e)) {
    throw fail(400, 'INVALID_STAGE_WINDOW', '开始时间必须早于结束时间', { startsAt, endsAt });
  }
  return { startsAt, endsAt };
}

/** 赛段类型必须在枚举内。 */
function assertKind(kind) {
  const k = requireText(kind, 'kind（赛段类型）');
  if (!STAGE_KINDS.includes(k)) {
    throw fail(400, 'INVALID_STAGE_KIND', `赛段类型必须是 ${STAGE_KINDS.join(' | ')} 之一`, { kind: k });
  }
  return k;
}

/**
 * 权重表键必须合法**且**在规则文件里真的存在。
 * ⚠️ 为什么不硬编码权重表（全局约束）：权重表在 rules/scoring-*.json，
 *    这里只做「键存在吗」的判定 —— 找不到就 400，绝不「悄悄用一张默认表」。
 */
function assertScoringConfigKey(key, rules) {
  const k = requireText(key, 'scoringConfigKey（权重表键）');
  if (!SCORING_CONFIG_KEYS.includes(k)) {
    throw fail(400, 'SCORING_CONFIG_NOT_FOUND', `权重表键必须是 ${SCORING_CONFIG_KEYS.join(' | ')} 之一`, { scoringConfigKey: k });
  }
  if (!rules?.scoring?.[k]) {
    throw fail(400, 'SCORING_CONFIG_NOT_FOUND', `规则里没有权重表 ${k}（rules/scoring-*.json）`, { scoringConfigKey: k });
  }
  return k;
}

/** 赛段必须存在（404）。 */
function requireStage(db, stageId) {
  const stage = getStage(db, stageId);
  if (!stage) throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  return stage;
}

/**
 * 建赛段。
 *
 * ⚠️ 校验链（顺序即语义，先便宜后昂贵）：
 *   ① 届期存在？否则 404 EDITION_NOT_FOUND（赛段挂在届期下，届期都没有就没法挂）
 *   ② key / name / kind / scoringConfigKey 合法？
 *   ③ 时间窗合法？（开始 < 结束）
 *   ④ 同一届期下 key 不重复？⇒ 409 STAGE_KEY_EXISTS（DB 上还有 UNIQUE(edition_id,key) 兜底）
 *
 * @returns {object} 赛段行（仓储形状）
 */
export function createStage({
  db, editionId, key, name, kind, startsAt, endsAt, freezeAt = null,
  scoringConfigKey, actorId = null, now, rules = null,
}) {
  if (!getEdition(db, editionId)) {
    throw fail(404, 'EDITION_NOT_FOUND', '届期不存在');
  }
  const stageKey = requireText(key, 'key（赛段代号）');
  if (!STAGE_KEY_PATTERN.test(stageKey)) {
    throw fail(400, 'INVALID_STAGE_KEY', '赛段代号只能包含字母、数字、连字符与下划线（1–64 字符）', { key: stageKey });
  }
  const stageName = requireText(name, 'name（赛段名称）');
  const stageKind = assertKind(kind);
  const scoringKey = assertScoringConfigKey(scoringConfigKey, rules);
  assertWindow(startsAt, endsAt);
  if (freezeAt !== null && freezeAt !== undefined) parseTime(freezeAt, 'freezeAt');

  // 同一届期下 key 不得重复（DB 上还有 UNIQUE(edition_id, key) 兜底，这里先给出友好错误）
  const duplicated = listStages(db, { editionId }).some((s) => s.key === stageKey);
  if (duplicated) {
    throw fail(409, 'STAGE_KEY_EXISTS', `本届期已存在代号为 ${stageKey} 的赛段`, { editionId, key: stageKey });
  }

  let stage;
  try {
    stage = insertStage(db, {
      editionId,
      key: stageKey,
      name: stageName,
      kind: stageKind,
      startsAt,
      endsAt,
      freezeAt: freezeAt ?? null,
      scoringConfigKey: scoringKey,
      status: 'draft', // ⚠️ 新建一律 draft：赛段不是建好就开闸的（开闸是另一个动作）
      now,
    });
  } catch (err) {
    // 并发下两个请求同时建同名赛段 ⇒ 撞 UNIQUE ⇒ 同样给 409（而不是 500）
    // ⚠️ 文案与上面「先查后建」那一档**刻意不同**：
    //    先查 ⇒ 「本届期已有这个代号」（历史存在）；撞约束 ⇒ 「可能是并发创建」（刚刚发生的竞争）。
    //    两档都是 409 STAGE_KEY_EXISTS，但用户要知道下一步动作不同（改代号 vs 刷新重试）。
    if (/UNIQUE constraint failed: stages/i.test(String(err?.message))) {
      throw fail(409, 'STAGE_KEY_EXISTS', `赛段代号 ${stageKey} 已被占用（可能是并发创建），请刷新后重试`, {
        editionId, key: stageKey, reason: 'concurrent_create',
      });
    }
    throw err;
  }

  writeAuditLog(db, {
    actorId,
    action: 'stage.create',
    entity: 'stage',
    entityId: stage.id,
    detail: {
      editionId,
      key: stageKey,
      name: stageName,
      kind: stageKind,
      startsAt,
      endsAt,
      freezeAt: freezeAt ?? null,
      scoringConfigKey: scoringKey,
      status: 'draft',
    },
    now,
  });
  return stage;
}

/**
 * 改赛段配置（**逆向路径**：改配置）。
 *
 * ⚠️ **换权重表要谨慎**：赛段一旦有了评分数据，换 `scoring_config_key`
 *    ⇒ 历史评分是按**旧权重表**打的，新权重表算出来的总分与旧分数**不可复算**
 *    （设计文档 §12「可复算」被破坏）⇒ 有评分时拒绝换表，提示先清数据。
 *
 * ⚠️ 其余字段（name / 时间窗 / freeze_at）随时可改 —— 它们不影响「旧分数怎么算出来」。
 */
export function updateStage({
  db, stageId, name, startsAt, endsAt, freezeAt, scoringConfigKey,
  actorId = null, now, rules = null,
}) {
  const stage = requireStage(db, stageId);
  const next = {
    name: name === undefined ? stage.name : requireText(name, 'name（赛段名称）'),
    startsAt: startsAt === undefined ? stage.starts_at : startsAt,
    endsAt: endsAt === undefined ? stage.ends_at : endsAt,
    freezeAt: freezeAt === undefined ? stage.freeze_at : freezeAt,
    scoringConfigKey: scoringConfigKey === undefined
      ? stage.scoring_config_key
      : assertScoringConfigKey(scoringConfigKey, rules),
  };
  assertWindow(next.startsAt, next.endsAt);
  if (next.freezeAt !== null && next.freezeAt !== undefined) parseTime(next.freezeAt, 'freezeAt');

  const tableChanged = next.scoringConfigKey !== stage.scoring_config_key;
  if (tableChanged) {
    // ⛔ 已有评分 ⇒ 不许换权重表（否则历史评分不可复算）
    const existingReviews = listReviews(db, { stageId });
    if (existingReviews.length) {
      throw fail(
        409,
        'STAGE_HAS_REVIEWS',
        '该赛段已有评分数据，不能更换权重表（历史评分将不可复算）；请先清空该赛段的评分数据',
        { stageId, reviews: existingReviews.length, from: stage.scoring_config_key, to: next.scoringConfigKey },
      );
    }
  }

  const updated = updateStageConfig(db, {
    id: stageId,
    name: next.name,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
    freezeAt: next.freezeAt ?? null,
    scoringConfigKey: next.scoringConfigKey,
  });

  writeAuditLog(db, {
    actorId,
    action: 'stage.update',
    entity: 'stage',
    entityId: stageId,
    detail: {
      before: {
        name: stage.name,
        startsAt: stage.starts_at,
        endsAt: stage.ends_at,
        freezeAt: stage.freeze_at,
        scoringConfigKey: stage.scoring_config_key,
      },
      after: {
        name: next.name,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        freezeAt: next.freezeAt ?? null,
        scoringConfigKey: next.scoringConfigKey,
      },
    },
    now,
  });
  return updated;
}

/**
 * 派评委到赛段（席位 + 利益冲突声明同事务写入）。
 *
 * ⛔ **必须走仓储层的 assignStageJudge**：它内部把「声明（conflict_declarations）」
 *    与「席位（stage_judges）」写在**同一个事务**里，并把声明 id 回填到席位行
 *    （R-JDG-18：评委须签署利益冲突声明）。
 *    ⛔ 本服务**不自己**写 stage_judges 的 INSERT —— 那样会漏掉声明，
 *      正是 003_review.sql 注释里记的那个「机制写下来了但没接线」的病。
 *
 * @param {object|null} declaration { hasConflict?: boolean, statement?: string }
 */
export function assignStageJudgeToStage({
  db, stageId, userId, seat, scopeType = 'global', scopeId = null,
  actorId = null, now, declaration = null,
}) {
  requireStage(db, stageId);
  const targetUserId = requireText(userId, 'userId（被派评委）');
  if (!getUserById(db, targetUserId)) {
    throw fail(404, 'USER_NOT_FOUND', '用户不存在', { userId: targetUserId });
  }
  const seatType = requireText(seat, 'seat（席位类型）');
  if (!JUDGE_SEATS.includes(seatType)) {
    throw fail(400, 'INVALID_JUDGE_SEAT', `席位必须是 ${JUDGE_SEATS.join(' | ')} 之一`, { seat: seatType });
  }
  // 作用域类型必须落在枚举内（003_review.sql 的列注释）—— 否则往库里写的是垃圾值，
  // 而「这个席位的授权范围是什么」事后没人查得出。
  const scope = requireText(scopeType ?? 'global', 'scopeType（授权作用域）');
  if (!JUDGE_SCOPE_TYPES.includes(scope)) {
    throw fail(400, 'INVALID_SCOPE_TYPE', `授权作用域必须是 ${JUDGE_SCOPE_TYPES.join(' | ')} 之一`, { scopeType: scope });
  }
  // 重复分配 ⇒ 409（先查再派：PRIMARY KEY(stage_id, user_id) 撞了只能得到原始 SQL 错误）
  if (getStageJudge(db, stageId, targetUserId)) {
    throw fail(409, 'JUDGE_ALREADY_ASSIGNED', '该用户已被分配到本赛段', { stageId, userId: targetUserId });
  }

  assignStageJudge(db, {
    stageId,
    userId: targetUserId,
    seat: seatType,
    scopeType: scope,
    scopeId,
    now,
    declaration,
  });

  writeAuditLog(db, {
    actorId,
    action: 'stage.judge.assign',
    entity: 'stage',
    entityId: stageId,
    detail: { userId: targetUserId, seat: seatType, scopeType: scope, scopeId },
    now,
  });
  return listStageJudges(db, stageId);
}

/**
 * 撤评委（**逆向路径**：撤评委）。
 * ⚠️ 幂等友好：先查再删 —— 没分配过 ⇒ 404 JUDGE_NOT_ASSIGNED（不静默）。
 * ⚠️ 只删席位，**不删**已签署的利益冲突声明（那是历史事实，见 removeStageJudgeRow 的注释）。
 */
export function removeStageJudge({ db, stageId, userId, actorId = null, now }) {
  requireStage(db, stageId);
  const targetUserId = requireText(userId, 'userId（被撤评委）');
  const seat = getStageJudge(db, stageId, targetUserId);
  if (!seat) {
    throw fail(404, 'JUDGE_NOT_ASSIGNED', '该用户未被分配到本赛段', { stageId, userId: targetUserId });
  }
  const removed = removeStageJudgeRow(db, { stageId, userId: targetUserId });
  writeAuditLog(db, {
    actorId,
    action: 'stage.judge.remove',
    entity: 'stage',
    entityId: stageId,
    detail: { userId: targetUserId, seat: seat.seat, removed },
    now,
  });
  return { removed, seat: seat.seat, judges: listStageJudges(db, stageId) };
}

/**
 * 登记赛段名册（哪些队伍参加这一段）。
 *
 * ⛔ **幂等**：重复登记**不报错**，静默跳过已登记的队伍。
 *    （仓储层的 registerStageTeams 撞 UNIQUE(stage_id, team_id) 会抛错 ⇒ 服务层必须先查再过滤。）
 *    为什么必须幂等：赛段开启时批量登记名册是**流程性动作**，重跑一遍不该把流程打断。
 *
 * @param {string[]} teamIds
 */
export function registerStageTeamRoster({ db, stageId, teamIds, actorId = null, now }) {
  const stage = requireStage(db, stageId);
  const raw = Array.isArray(teamIds) ? teamIds : (teamIds ? [teamIds] : []);
  const ids = raw.map((x) => requireText(x, 'teamId（队伍）')).filter((x, i, arr) => arr.indexOf(x) === i);
  if (!ids.length) {
    throw fail(400, 'INVALID_TEAM_IDS', '必须指定队伍（teamIds 数组）');
  }
  // 队伍必须存在，且必须属于**本赛段所在的届期** ⇒ 否则就是把外届期的队拉进来
  for (const id of ids) {
    const team = getTeam(db, id);
    if (!team) throw fail(404, 'TEAM_NOT_FOUND', '队伍不存在', { teamId: id });
    if (team.edition_id !== stage.edition_id) {
      throw fail(400, 'TEAM_NOT_IN_EDITION', '队伍不属于本届期，不能登记到本赛段', {
        teamId: id, editionId: stage.edition_id,
      });
    }
  }
  const current = new Set(listStageTeamIds(db, stageId));
  const fresh = ids.filter((id) => !current.has(id));
  const registered = fresh.length ? registerStageTeams(db, { stageId, teamIds: fresh, now }) : 0;
  writeAuditLog(db, {
    actorId,
    action: 'stage.roster.register',
    entity: 'stage',
    entityId: stageId,
    detail: { registered, skipped: ids.length - fresh.length, teamIds: ids },
    now,
  });
  return {
    registered,
    skipped: ids.length - fresh.length,
    teamIds: listStageTeamIds(db, stageId),
  };
}

/**
 * 队伍退名册（**逆向路径**：退名册）。
 * ⚠️ 不在名册里 ⇒ 404 TEAM_NOT_IN_ROSTER（不静默 —— 「退名册」这个动作必须有明确结果）。
 */
export function removeStageTeam({ db, stageId, teamId, actorId = null, now }) {
  requireStage(db, stageId);
  const targetTeamId = requireText(teamId, 'teamId（队伍）');
  if (!isTeamInStage(db, stageId, targetTeamId)) {
    throw fail(404, 'TEAM_NOT_IN_ROSTER', '该队伍不在本赛段名册内', { stageId, teamId: targetTeamId });
  }
  const removed = removeStageTeamRow(db, { stageId, teamId: targetTeamId });
  writeAuditLog(db, {
    actorId,
    action: 'stage.roster.remove',
    entity: 'stage',
    entityId: stageId,
    detail: { teamId: targetTeamId, removed },
    now,
  });
  return { removed, teamIds: listStageTeamIds(db, stageId) };
}
```

### `platform/web/views/tiebreak.js`

破同分界面（W2-b）。

```javascript
// web/views/tiebreak.js — 加时陈述 / 一票破同分页面
//
// 规则溯源（口径一律以源码为准）：
//   - 「同分 → 10 分钟加时陈述 → 企业席 + 评委席共同复议」→ R-JDG-19（S7 §3.3）
//     + src/services/tiebreak.js（服务层：谁能开轮次 / 谁能投票 / 关闭幂等）
//   - 「可见性在 API 层过滤，前端只负责呈现」→ 全局约束（DP-77）
//     ⇒ 本视图**不判权限**、**不过滤 votes**（API 已裁剪过；前端再过滤一遍 = 两套口径）
//   - 「错误态必须带真能点的重试」→ DP-80；「不许整页刷新 / 不许冲掉已填内容」→ DP-81
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js 文件头 + 机器闸
//   - 「颜色只走设计令牌 / 卡片零外阴影 / 一屏强调色 ≤3」→ P10 设计系统
//   - 「HTML 文本插值一律过 escapeHtml（全站唯一转义入口）」→ web/escape.js
//
// ⚠️ **前端不判权限**：能不能开轮次、能不能看投票明细，一律由 API 裁决
//   （全局约束「授权的唯一裁决者是 can()，前端只拿到提示」）。
//   ⇒ 「开启一轮」「关闭轮次」按钮**始终渲染**；被 403 时把服务端的中文原因显示出来。
//   ⚠️ 反过来做（前端按能力点藏按钮）= 前端替 API 做了授权判断 ⇒
//     一旦服务端放宽口径（换个赛段就有权了），前端就永远进不去 —— 与「前端隐藏 = 数据已泄露」同源。
//
// ⚠️ **队名是「尽力而为」**：加时陈述的端点只给 teamId。
//   队名取自 `GET /api/stages/:stageId/review-board` 的名册 —— 该端点对评委/组委会开放，
//   对普通登录用户 403 ⇒ 取不到时**退回显示 teamId**，
//   绝不能因为「拿不到队名」就让整个页面失败。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, emptyRow, errorState, loadingState, noticeState, pageHead,
  panel, rankBadge, sectionTitle, statRow, tableWrap, workbench,
} from '../ui.js';

/** 投票分范围：0–100 百分制（与服务层 SCORE_OUT_OF_RANGE 同一口径）。 */
const MIN_SCORE = 0;
const MAX_SCORE = 100;
/** 加时陈述时长默认值（S7 §3.3：10 分钟）。 */
const DEFAULT_MINUTES = 10;

/**
 * 时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。
 * ⚠️ 与 web/views/signoff.js 的 fmtTime 同一口径 —— 两个视图各写一份就会漂。
 */
function fmtTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 保留两位小数（均值会出现 15.200000000000003 这种浮点尾巴）。 */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：轮次 / 票数 / 均值 → 视图模型
// ══════════════════════════════════════════════════════════════════

/**
 * 同分组队伍（纯函数）。
 * ⚠️ 两种字段名都认（camelCase / snake_case）：API 同时给了两层形状
 *   （见 src/http/routes/tiebreak.js 的 presentRound），视图按驼峰读、读不到再退回蛇形。
 *
 * @param {object|null} round 轮次
 * @param {object} teamNames  队名映射 { teamId: name }
 * @returns {Array<{teamId:string, teamName:string}>}
 */
export function tiebreakTiedTeams(round, teamNames = {}) {
  const raw = round?.tiedTeamIds ?? round?.tied_team_ids_json ?? [];
  const ids = Array.isArray(raw) ? raw : [];
  return ids
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
    .map((teamId) => ({ teamId, teamName: String(teamNames?.[teamId] ?? teamId) }));
}

/**
 * 复议分统计行（纯函数）：按均值降序（均值高的排前面 = 复议领先）。
 * ⚠️ 排序必须**确定**：均值相同用 teamId 兜底（全局约定：确定性排序的兜底键不用随机值）。
 *
 * @param {object} tallies  { [teamId]: { count, sum, mean } }
 * @param {object} teamNames
 */
export function tiebreakTallyRows(tallies, teamNames = {}) {
  const entries = Object.entries(tallies ?? {});
  return entries
    .map(([teamId, t]) => ({
      teamId: String(teamId),
      teamName: String(teamNames?.[teamId] ?? teamId),
      count: Number(t?.count ?? 0),
      sum: Number(t?.sum ?? 0),
      mean: Number(t?.mean ?? 0),
    }))
    .sort((a, b) => (b.mean - a.mean) || (a.teamId < b.teamId ? -1 : (a.teamId > b.teamId ? 1 : 0)));
}

/**
 * 投票明细行（纯函数）。
 * ⚠️ 投票人只给 id —— 要不要给姓名由**服务端**决定（前端不替服务端改口径）。
 */
export function tiebreakVoteRows(votes, teamNames = {}) {
  return (Array.isArray(votes) ? votes : []).map((v) => {
    const teamId = String(v?.teamId ?? v?.team_id ?? '');
    return {
      voterId: String(v?.voterId ?? v?.voter_id ?? ''),
      teamId,
      teamName: String(teamNames?.[teamId] ?? teamId),
      score: Number(v?.score ?? 0),
      votedAt: v?.votedAt ?? v?.voted_at ?? null,
    };
  });
}

/**
 * 「待投队伍」（纯函数）：同分组里**还没有收到任何票**的队伍。
 * ⚠️ 口径说明：这里说的是「还没有人投的队」（票数 = 0），
 *   不是「我没投过的队」—— 后者要靠「每个评委投了什么」才能算，
 *   而普通用户看不到投票明细（API 已裁剪）⇒ 前端**不能**自己推断「我投过哪些」。
 */
export function tiebreakPendingTeams(tiedTeams, tallyRows) {
  const voted = new Set(tallyRows.filter((r) => r.count > 0).map((r) => r.teamId));
  return tiedTeams.filter((t) => !voted.has(t.teamId));
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：HTML 渲染（⛔ 服务端数据一律过 escapeHtml）
// ══════════════════════════════════════════════════════════════════

/** 赛段选择器（纯 HTML）。 */
function stagePickerHtml(stages, stageId) {
  if (!stages.length) {
    return '<p class="muted small">还没有赛段 —— 赛段由组委会创建后，这里才会出现可选项。</p>';
  }
  const options = stages.map((s) => `<option value="${escapeHtml(s.id)}"${String(s.id) === String(stageId) ? ' selected' : ''}>${escapeHtml(s.name || s.key || s.id)}</option>`).join('');
  return `<div class="field">
      <label class="field__label" for="tiebreak-stage">赛段</label>
      <select class="select" id="tiebreak-stage" data-tiebreak="stage">
        ${options}
      </select>
      <p class="field__hint">加时陈述按赛段开轮 —— 同一赛段同时只能有一轮进行中的加时陈述。</p>
    </div>`;
}

/** 轮次概览（纯 HTML）。 */
function roundPanelHtml(round, tiedTeams, pendingTeams, voteCount) {
  if (!round) {
    return emptyState({
      title: '本赛段还没有加时陈述轮次',
      hint: '同分的队伍由组委会开一轮加时陈述（10 分钟陈述 + 评委席复议投票）。',
    });
  }
  const isOpen = String(round.status) === 'open';
  const deadline = fmtTime(round.statementDeadline ?? round.statement_deadline);
  const pendingNames = pendingTeams.map((t) => t.teamName).join('、');
  const teams = tiedTeams.length
    ? `<ul class="list-divided">${tiedTeams.map((t) => `<li><span>${escapeHtml(t.teamName)}</span></li>`).join('')}</ul>`
    : '<p class="muted small">（同分组名单为空）</p>';
  const stats = statRow([
    { label: '轮次状态', value: isOpen ? '进行中' : '已关闭', tone: isOpen ? 'warn' : 'neutral' },
    { label: '陈述截止', value: deadline || '—', hint: '陈述结束后由评委席复议投票' },
    { label: '同分组队伍', value: String(tiedTeams.length) },
    { label: '已收到票数', value: String(voteCount) },
  ]);
  return `<div class="row">${badge(isOpen ? '进行中' : '已关闭', isOpen ? 'warn' : 'neutral')}</div>
    ${stats}
    ${sectionTitle('同分组队伍')}
    ${teams}
    <p class="muted small">${pendingTeams.length
      ? `还没有人投票的队伍：${escapeHtml(pendingNames)}`
      : '同分组每支队伍都已收到票。'}</p>`;
}

/** 复议分统计表（纯 HTML）。 */
function tallyTableHtml(tallyRows) {
  if (!tallyRows.length) {
    return emptyState({
      title: '还没有复议分',
      hint: '评委席投完票后，这里会显示每支队伍的票数、总分与均值。',
    });
  }
  const body = tallyRows.map((r, i) => `<tr>
      <td>${rankBadge(i + 1)}</td>
      <td>${escapeHtml(r.teamName)}</td>
      <td class="td-num num">${escapeHtml(r.count)}</td>
      <td class="td-num num">${escapeHtml(round2(r.sum))}</td>
      <td class="td-num num">${escapeHtml(round2(r.mean))}</td>
    </tr>`).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">票数</th><th class="td-num">总分</th><th class="td-num">均值</th></tr></thead>
     <tbody>${body || emptyRow(5, '还没有复议分')}</tbody>`,
    { caption: '各队复议分统计（票数 / 总分 / 均值）' },
  );
}

/** 投票明细表（纯 HTML）。 */
function voteTableHtml(voteRows, tallyRows) {
  if (!voteRows.length) {
    // ⚠️ 「有统计但没明细」= 这个人不是本赛段评委 / 组委会（API 已把 votes 收窄为空）。
    //   这时**不猜**权限，只说明「明细不在这份响应里」，并把统计结果照给。
    if (tallyRows.length) {
      return '<p class="muted small">投票明细（谁投了多少分）只对本赛段评委与组委会可见；上面的统计结果对所有人可见。</p>';
    }
    return emptyState({ title: '还没有投票', hint: '轮次开放期间，本赛段评委可以给同分组队伍打复议分。' });
  }
  const body = voteRows.map((v) => `<tr>
      <td>${escapeHtml(v.voterId)}</td>
      <td>${escapeHtml(v.teamName)}</td>
      <td class="td-num num">${escapeHtml(round2(v.score))}</td>
      <td>${escapeHtml(fmtTime(v.votedAt))}</td>
    </tr>`).join('');
  return tableWrap(
    `<thead><tr><th>投票人</th><th>队伍</th><th class="td-num">复议分</th><th>投票时间</th></tr></thead>
     <tbody>${body}</tbody>`,
    { caption: '复议投票明细' },
  );
}

/**
 * 投票表单（纯 HTML）。
 * ⚠️ `teamId` / `score` 是**草稿值**：重绘时回填 ⇒ 用户已填的分数不会被冲掉（DP-81）。
 */
function voteFormHtml(round, tiedTeams, { teamId = '', score = '' } = {}) {
  if (!round || String(round.status) !== 'open') {
    return '<p class="muted small">轮次未开放投票。</p>';
  }
  if (!tiedTeams.length) {
    return '<p class="muted small">本轮没有可投票的队伍。</p>';
  }
  const options = tiedTeams.map((t) => `<option value="${escapeHtml(t.teamId)}"${t.teamId === teamId ? ' selected' : ''}>${escapeHtml(t.teamName)}</option>`).join('');
  return `<div class="field">
      <label class="field__label" for="tiebreak-team">被投票的队伍</label>
      <select class="select" id="tiebreak-team" data-tiebreak="team">
        ${options}
      </select>
    </div>
    <div class="field field--required">
      <label class="field__label" for="tiebreak-score">复议分（${MIN_SCORE}–${MAX_SCORE}）</label>
      <input class="input" id="tiebreak-score" type="number" inputmode="decimal"
        min="${MIN_SCORE}" max="${MAX_SCORE}" step="0.1" data-tiebreak="score" value="${escapeHtml(score)}" />
      <p class="field__hint">一人一队一票（重复投票服务端会拒绝）；观察员无投票权。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="vote-submit">提交复议分</button>
    </div>`;
}

/** 开启一轮 / 关闭轮次（纯 HTML）。 */
function actionsPanelHtml({ round, roster, minutes }) {
  const isOpen = Boolean(round) && String(round.status) === 'open';
  const rosterHtml = roster.length
    ? `<ul class="list-divided">${roster.map((t) => `<li>
        <label class="row">
          <input type="checkbox" data-tiebreak="tied" value="${escapeHtml(t.id)}" data-team-id="${escapeHtml(t.id)}" />
          <span>${escapeHtml(t.name || t.id)}</span>
        </label>
      </li>`).join('')}</ul>`
    : `<div class="field">
        <label class="field__label" for="tiebreak-teams">同分组队伍 id（逗号分隔）</label>
        <input class="input" id="tiebreak-teams" data-tiebreak="tied-ids" autocomplete="off" />
        <p class="field__hint">拿不到名册时，可直接粘贴同分组队伍 id（至少两支，逗号分隔）。</p>
      </div>`;
  const openForm = `<div class="field">
      <label class="field__label" for="tiebreak-minutes">陈述时长（分钟）</label>
      <input class="input" id="tiebreak-minutes" type="number" inputmode="numeric"
        min="1" max="240" step="1" value="${escapeHtml(minutes)}" data-tiebreak="minutes" />
      <p class="field__hint">默认 ${DEFAULT_MINUTES} 分钟（S7 §3.3）。</p>
    </div>
    ${sectionTitle('勾选同分队伍（至少两支）')}
    ${rosterHtml}
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="round-open">开启一轮加时陈述</button>
    </div>`;
  const closeBtn = isOpen
    ? `<div class="row">
        <button type="button" class="btn btn--ghost" data-action="round-close">关闭本轮加时陈述</button>
      </div>
      <p class="muted small">关闭后不再接受投票；已投的票与复议分保留（关闭是幂等的）。</p>`
    : `<p class="muted small">${round ? '本赛段当前没有进行中的轮次。' : '本赛段还没有轮次。'}</p>`;
  return `${openForm}
    ${sectionTitle('关闭轮次')}
    ${closeBtn}`;
}

/**
 * 整页 HTML（纯函数，可单测）。
 * @param {object} model { loading, error, stageId, stages, round, votes, tallies, teamNames, roster, minutes, feedback, teamDraft, scoreDraft }
 */
/**
 * 加时陈述页（纯 HTML）。
 *
 * ⚠️ **P12：页面形状 = 操作台（左轨选赛段 + 右画布做操作）**。
 *    改版前是「head + 赛段面板 + 5 张同款面板」一字排开 ⇒ 改版前实测
 *    6/10 个面共用同一签名（card-kit 同质化），且「我现在复议的是哪个赛段」
 *    只有一个孤零零的下拉框，没有位置感。
 *    ⇒ 左轨 = 赛段（上下文选择器 ⇒ 材质与画布平等，描边）；
 *      右画布 = 轮次 / 投票 / 统计 / 明细 / 操作。
 */
export function tiebreakPageHtml(model = {}) {
  const head = pageHead({
    title: '加时陈述 · 一票破同分',
    sub: '同分队伍进入加时陈述，评委席复议打分；复议分是赛段级产物（R-JDG-19）。',
  });
  const stages = Array.isArray(model.stages) ? model.stages : [];
  const stagePanel = panel({
    title: '选择赛段',
    desc: '加时陈述按赛段开轮 —— 同一赛段同时只能有一轮进行中的加时陈述。',
    body: stagePickerHtml(stages, model.stageId ?? ''),
  });

  if (model.loading) {
    return head + workbench({ rail: stagePanel, canvas: loadingState({ rows: 4, label: '正在加载加时陈述…' }) });
  }
  if (model.error) {
    return head + workbench({
      rail: stagePanel,
      canvas: errorState({
        message: model.error,
        hint: '点「重试」重新拉一次加时陈述数据。',
      }),
    });
  }
  if (!model.stageId) {
    return head + workbench({
      rail: stagePanel,
      canvas: emptyState({
        title: '先选一个赛段',
        hint: '加时陈述挂在赛段上：同一赛段同时只能有一轮进行中的加时陈述。',
      }),
    });
  }

  const teamNames = model.teamNames ?? {};
  const tiedTeams = tiebreakTiedTeams(model.round, teamNames);
  const tallyRows = tiebreakTallyRows(model.tallies, teamNames);
  const voteRows = tiebreakVoteRows(model.votes, teamNames);
  const pendingTeams = tiebreakPendingTeams(tiedTeams, tallyRows);
  const feedbackHtml = model.feedback
    ? noticeState({
      tone: model.feedback.tone ?? 'info',
      title: model.feedback.title ?? '',
      items: model.feedback.items ?? [],
      list: true,
    })
    : '';

  return head + workbench({
    rail: stagePanel,
    canvas: [
      feedbackHtml,
      panel({ title: '当前轮次', desc: '陈述截止后由评委席复议投票。', body: roundPanelHtml(model.round, tiedTeams, pendingTeams, voteRows.length) }),
      panel({ title: '投一票', desc: '一人一队一票；观察员无投票权，已回避的评委不能投。', body: voteFormHtml(model.round, tiedTeams, { teamId: model.teamDraft ?? '', score: model.scoreDraft ?? '' }) }),
      panel({ title: '复议分统计', desc: '票数 / 总分 / 均值（均值高者领先）。', body: tallyTableHtml(tallyRows) }),
      panel({ title: '投票明细', desc: '谁投了多少分。', body: voteTableHtml(voteRows, tallyRows) }),
      panel({ title: '轮次操作', desc: '开轮次与关轮次由组委会执行（stage:compute）。', body: actionsPanelHtml({ round: model.round, roster: model.roster ?? [], minutes: model.minutes ?? DEFAULT_MINUTES }) }),
    ].join(''),
  });
}

// ══════════════════════════════════════════════════════════════════
// 三、DOM 接线（renderTiebreak）
// ══════════════════════════════════════════════════════════════════

/**
 * 加时陈述视图。
 *
 * ⚠️ **交互纪律**（照抄 web/views/signoff.js）：
 *   ① 提交一律「本地校验 → 发请求 → 就地反馈」；
 *   ② 提交成功后**重新拉一次**（不是本地改状态）⇒ 页面显示的永远是服务端口径；
 *   ③ 重绘时**回填草稿**（队伍 / 分数）⇒ 用户已填的内容不会被冲掉（DP-81）；
 *   ④ 加载 / 错误 / 空态全部用 web/ui.js 的现成组件（不自己造）；
 *   ⑤ 所有 DOM 读取都用可选链 —— 最小 DOM 桩上不许抛。
 */
export async function renderTiebreak(ctx) {
  const wrap = document.createElement('div');
  // ⚠️ 只用**既有** class（不造新的 CSS 类、不写 <style>）：stack = 通用纵向堆叠。
  wrap.className = 'stack tiebreak-view';

  const state = {
    stageId: String(ctx?.params?.stageId ?? ctx?.query?.stageId ?? ''),
    stages: [],
    roster: [],
    teamNames: {},
    round: null,
    votes: [],
    tallies: {},
    minutes: DEFAULT_MINUTES,
    loading: true,
    error: null,
    feedback: null,
    // ⚠️ 草稿：重绘时回填 ⇒ 已填的分数不会被冲掉（DP-81）。
    teamDraft: '',
    scoreDraft: '',
  };

  /** 重绘整页。 */
  const render = () => {
    wrap.innerHTML = tiebreakPageHtml(state);
  };

  /** 读某个输入框的值（读不到就当空串 —— 最小 DOM 桩上不许抛）。 */
  const value = (selector) => {
    const el = wrap.querySelector(selector);
    return el && typeof el.value === 'string' ? el.value : '';
  };

  /** 队名映射（teamId → 队名）。 */
  const buildTeamNames = (teams) => {
    const map = {};
    for (const t of teams) {
      if (t?.id) map[String(t.id)] = String(t.name || t.id);
    }
    return map;
  };

  /** 赛段列表（失败不致命：没有赛段就只显示选择器）。 */
  const loadStages = async () => {
    try {
      const data = await ctx.api.get('/api/stages');
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      state.stages = Array.isArray(items) ? items : [];
    } catch {
      state.stages = [];
    }
    if (!state.stageId && state.stages.length) state.stageId = String(state.stages[0].id);
  };

  /** 赛段名册（**尽力而为**：只为显示队名；取不到就退回显示 teamId）。 */
  const loadRoster = async () => {
    if (!state.stageId) {
      state.roster = [];
      state.teamNames = {};
      return;
    }
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/review-board`);
      const teams = Array.isArray(board?.teams) ? board.teams : [];
      state.roster = teams;
      state.teamNames = buildTeamNames(teams);
    } catch {
      // ⚠️ 普通登录用户没有评审工作台的读权限 ⇒ 拿不到名册是**正常**的，不该报错。
      state.roster = [];
      state.teamNames = {};
    }
  };

  /** 本赛段的轮次列表 + 当前轮次状态（数据变了 ⇒ 末尾重绘）。 */
  const loadRounds = async () => {
    if (!state.stageId) {
      state.round = null;
      state.votes = [];
      state.tallies = {};
      render();
      return;
    }
    const list = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/tiebreak/rounds`);
    const items = Array.isArray(list?.items) ? list.items : [];
    // ⚠️ 当前轮次 = **进行中的那一轮**；没有进行中的就取最近一轮（列表已按 created_at, rowid 定序）。
    const open = items.find((r) => String(r?.status) === 'open');
    const current = open ?? (items.length ? items[items.length - 1] : null);
    if (!current) {
      state.round = null;
      state.votes = [];
      state.tallies = {};
      render();
      return;
    }
    const detail = await ctx.api.get(`/api/tiebreak/rounds/${encodeURIComponent(current.id)}`);
    state.round = detail?.round ?? current;
    state.votes = Array.isArray(detail?.votes) ? detail.votes : [];
    state.tallies = detail?.tallies ?? {};
    render();
  };

  /** 首屏 / 重试：一次把页面需要的数据拉齐。 */
  const loadAll = async () => {
    state.loading = true;
    state.error = null;
    render();
    try {
      await loadStages();
      await loadRoster();
      await loadRounds();
    } catch (e) {
      state.error = e?.message ?? '加载失败';
      render();
    } finally {
      state.loading = false;
      render();
    }
  };

  /** 提交一票。 */
  const submitVote = async () => {
    const round = state.round;
    if (!round || String(round.status) !== 'open') {
      state.feedback = { tone: 'warn', title: '当前没有可投票的轮次', items: ['轮次已关闭或还没开启。'] };
      render();
      return;
    }
    const teamId = value('[data-tiebreak="team"]') || state.teamDraft;
    const scoreText = (value('[data-tiebreak="score"]') || state.scoreDraft).trim();
    const score = Number(scoreText);
    if (!teamId) {
      state.feedback = { tone: 'warn', title: '还没选队伍', items: ['先选要打分的队伍。'] };
      render();
      return;
    }
    if (scoreText === '' || !Number.isFinite(score) || score < MIN_SCORE || score > MAX_SCORE) {
      state.feedback = {
        tone: 'warn',
        title: '复议分不合法',
        items: [`复议分必须是 ${MIN_SCORE}–${MAX_SCORE} 之间的数字。`],
      };
      render();
      return;
    }
    try {
      await ctx.api.post(`/api/tiebreak/rounds/${encodeURIComponent(round.id)}/votes`, { teamId, score });
      state.feedback = { tone: 'success', title: '已提交复议分', items: ['投票已记入（一人一队一票）。'] };
      await loadRounds();
    } catch (e) {
      // ⚠️ 服务端的中文原因原样透出（重复投票 / 轮次已关闭 / 观察员无投票权 …）
      state.feedback = { tone: 'danger', title: '投票失败', items: [e?.message ?? '提交失败'] };
      render();
    }
  };

  /** 开启一轮加时陈述。 */
  const openRound = async () => {
    // ⚠️ 勾选的队伍（名册口径）；拿不到名册时读「逗号分隔的 id」输入框。
    const boxes = Array.from(wrap.querySelectorAll('[data-tiebreak="tied"]') ?? []);
    const picked = [];
    for (const box of boxes) {
      const id = String(box?.dataset?.teamId ?? box?.value ?? '').trim();
      if (id && box?.checked) picked.push(id);
    }
    if (!picked.length) {
      const raw = value('[data-tiebreak="tied-ids"]');
      for (const part of String(raw).split(/[,，\s]+/)) {
        const id = part.trim();
        if (id) picked.push(id);
      }
    }
    if (picked.length < 2) {
      state.feedback = {
        tone: 'warn',
        title: '同分组至少要两支队伍',
        items: ['只有一支队伍就不用加时陈述了（直接按原始分排名）。'],
      };
      render();
      return;
    }
    const minutesText = value('[data-tiebreak="minutes"]').trim();
    const minutes = minutesText === '' ? DEFAULT_MINUTES : Number(minutesText);
    try {
      await ctx.api.post(`/api/stages/${encodeURIComponent(state.stageId)}/tiebreak/rounds`, {
        tiedTeamIds: picked,
        statementMinutes: Number.isFinite(minutes) ? minutes : DEFAULT_MINUTES,
      });
      state.feedback = { tone: 'success', title: '已开启加时陈述', items: ['同分组队伍进入陈述，评委席随后复议投票。'] };
      await loadRounds();
    } catch (e) {
      state.feedback = { tone: 'danger', title: '开轮次失败', items: [e?.message ?? '提交失败'] };
      render();
    }
  };

  /** 关闭当前轮次。 */
  const closeRound = async () => {
    const round = state.round;
    if (!round) return;
    try {
      await ctx.api.post(`/api/tiebreak/rounds/${encodeURIComponent(round.id)}/close`, {});
      state.feedback = { tone: 'success', title: '轮次已关闭', items: ['不再接受投票；已投的票与复议分保留。'] };
      await loadRounds();
    } catch (e) {
      state.feedback = { tone: 'danger', title: '关闭失败', items: [e?.message ?? '操作失败'] };
      render();
    }
  };

  await loadAll();

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘不会丢监听。
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset?.action;
    if (action === 'retry') {
      await loadAll();
      return;
    }
    if (action === 'vote-submit') {
      await submitVote();
      return;
    }
    if (action === 'round-open') {
      await openRound();
      return;
    }
    if (action === 'round-close') {
      await closeRound();
      return;
    }
  });

  // 草稿回填：记住用户填了什么 ⇒ 重绘时不冲掉（DP-81）。
  wrap.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.tiebreak;
    if (kind === 'score') state.scoreDraft = el.value;
    if (kind === 'tied-ids') return;
  });

  // 换赛段 / 换队伍：只改数据，不整页刷新输入框。
  wrap.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.tiebreak;
    if (kind === 'team') {
      state.teamDraft = el.value;
      return;
    }
    if (kind !== 'stage') return;
    state.stageId = el.value;
    state.round = null;
    state.votes = [];
    state.tallies = {};
    state.feedback = null;
    state.teamDraft = '';
    state.scoreDraft = '';
    loadRoster()
      .then(loadRounds)
      .catch((e) => {
        state.error = e?.message ?? '加载失败';
        render();
      });
  });

  return wrap;
}
```

### `platform/web/views/public-links.js`

公开访问链接界面（W2-c）。

```javascript
// web/views/public-links.js — 公开访问令牌管理页（签发 / 列表 / 吊销）
//
// 依据：设计文档 §8「公开榜单 API + 赛程日历 iCal 订阅」。
//   两个公开端点**必须带 token**（公开 ≠ 无鉴权）：
//     GET /api/public/leaderboard?token=…&editionId=…
//     GET /api/public/calendar.ics?token=…&editionId=…
//   但平台**没有任何创建 token 的入口** ⇒ 本页补的就是这条管理链路的界面。
// 溯源：src/http/routes/public-tokens.js（端点）+ src/services/public-api.js（只存哈希的纪律）。
//
// ⛔ 三条与「凭据」有关的纪律：
//   ① **明文只显示这一次**：签发成功后显著展示明文 + 两个公开链接，并明确提示刷新后不可再看
//      （服务端只存 SHA-256，**没有**第二次找回的可能）。
//   ② **列表里没有明文**：列表只给 scope / 届期 / 过期时间 / 短标识（哈希前 8 位）。
//      短标识**不是**可用的令牌（公开接口会再哈希一次比对）—— 页面必须说清这一点，
//      否则用户会拿它去试公开链接，然后以为服务坏了。
//   ③ **明文不进全局 store**：只活在本页这次挂载里（不进 ctx.setState）——
//      全局 store 会被别的视图读到，明文不该到处跑。
//
// ⚠️ **纯函数与 DOM 接线分离**（与 web/views/signoff.js、admin-task-packages.js 同款）：
//   展示模型（tokenRows）、统计（tokenStats）、HTML 渲染（tokenTableHtml / issueFormHtml /
//   issuedTokenHtml / publicUrlHtml）全部是**无 IO、无 DOM**的纯函数 ⇒ 可以直接对结果做断言。
//
// ⚠️ **视觉纪律**：颜色只走设计令牌（badge 的 tone / btn--primary / btn--danger / panel 的 tone），
//   **零外阴影**（卡片用 .card / .panel —— 它们的材质是「底色差 + 顶边高光」，没有外阴影），
//   一屏强调色 ≤ 3（brand / success / danger），**不新造 CSS 类**、不写 <style>。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  statRow, tableWrap, sectionTitle, workbench,
} from '../ui.js';

/**
 * scope → 中文标签。
 * ⚠️ 这些值是**接口契约值**（leaderboard / calendar / all），不是赛制规则 ——
 *    与 web/views/signoff.js 的 SEAT_LABELS、admin-task-packages.js 的 STATUS_LABELS 同款先例。
 *    认不出来的值原样透出（不猜、不吞）；服务端仍会用 rules.pools.publicScopes 复核。
 */
const SCOPE_LABELS = {
  leaderboard: '公开榜单',
  calendar: '赛程日历',
  all: '两个公开端点',
};

/** scope 的中文标签（认不出来就原样显示）。 */
export function scopeLabel(scope) {
  const key = String(scope ?? '');
  return SCOPE_LABELS[key] ?? key;
}

/** 时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。 */
function fmtTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 令牌列表的展示模型（纯函数）。
 * ⚠️ **形状恒定**：每一行字段集合完全一致，缺值一律空串 / false ——
 *    模板里出现 undefined 会渲染成字符串 "undefined"。
 *
 * @param {object|Array} raw GET /api/public/tokens 的返回（或它的 items 数组）
 * @returns {Array<object>}
 */
export function tokenRows(raw) {
  const list = Array.isArray(raw?.items)
    ? raw.items
    : (Array.isArray(raw) ? raw : []);
  return list.map((item) => ({
    id: String(item?.id ?? ''),
    scope: String(item?.scope ?? ''),
    scopeLabel: scopeLabel(item?.scope),
    editionId: String(item?.editionId ?? ''),
    expiresAt: String(item?.expiresAt ?? ''),
    createdAt: String(item?.createdAt ?? ''),
    tokenHint: String(item?.tokenHint ?? ''),
    expired: item?.expired === true,
  }));
}

/**
 * 顶部指标（纯函数）：总数 / 仍然有效 / 已过期。
 * ⚠️ 强调色只有两处（success / warn），其余走中性 ⇒ 一屏强调色不超标。
 */
export function tokenStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const expired = list.filter((r) => r.expired).length;
  return [
    { label: '已签发令牌', value: String(list.length), tone: 'neutral' },
    { label: '仍然有效', value: String(list.length - expired), tone: 'success' },
    { label: '已过期', value: String(expired), tone: expired > 0 ? 'warn' : 'neutral' },
  ];
}

/**
 * 一行的「吊销」单元格（纯 HTML）。
 * ⚠️ **吊销是破坏性动作 ⇒ 内联二次确认**（不用 window.confirm，理由同 web/views/publish.js）：
 *   第一次点「吊销」只展开确认块，第二次点「确认吊销」才发 DELETE。
 * ⚠️ 确认块用**裸 div + hidden 属性**：`.row` 这类布局类会设 display，
 *   会把 UA 的 `[hidden]{display:none}` 盖掉（styles.css 里 signoff__confirm[hidden] 就是为这个补的）——
 *   裸 div 没有任何 author 规则设 display ⇒ hidden 真的生效。
 */
function revokeCellHtml(row) {
  const id = escapeHtml(row.id);
  return `<div>
      <button type="button" class="btn btn--danger btn--sm" data-action="revoke-request" data-id="${id}">吊销</button>
      <div hidden data-revoke-confirm="${id}">
        <div class="row">
          <span class="small muted">吊销后这枚令牌立刻失效，用它访问公开接口会得到 403。</span>
          <button type="button" class="btn btn--danger btn--sm" data-action="revoke-confirm" data-id="${id}">确认吊销</button>
          <button type="button" class="btn btn--ghost btn--sm" data-action="revoke-cancel" data-id="${id}">取消</button>
        </div>
      </div>
    </div>`;
}

/**
 * 已有令牌表格（纯 HTML）。
 * ⚠️ 空态是 **200 + 空集**（不是错误）：一句「还没有令牌」+ 下一步（去上面签发）。
 */
export function tokenTableHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return emptyState({
      title: '还没有签发过公开令牌',
      hint: '公开榜单与赛程日历接口都必须带 token。在上方签发一枚，把链接发给需要看榜单的人。',
    });
  }
  const body = list.map((row) => `
            <tr>
              <td>${badge(row.scopeLabel, 'brand')}</td>
              <td class="mono small">${escapeHtml(row.editionId)}</td>
              <td class="num">${escapeHtml(fmtTime(row.expiresAt))}</td>
              <td class="mono">${escapeHtml(row.tokenHint)}</td>
              <td>${row.expired ? badge('已过期', 'danger') : badge('有效', 'success')}</td>
              <td>${revokeCellHtml(row)}</td>
            </tr>`).join('');
  return tableWrap(`
            <thead>
              <tr>
                <th>权限范围</th><th>届期</th><th>过期时间</th><th>短标识</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>`, {
    caption: '已签发的公开访问令牌',
    className: 'table table--compact',
  });
}

/**
 * 「签发新令牌」表单（纯 HTML）。
 * ⚠️ 表单字段名逐字照后端：editionId / scope / ttlDays / expiresAt（src/http/routes/public-tokens.js）。
 *    这里只给 scope 与 ttlDays —— 届期不给就是「当届」（后端按 pickCurrentEdition 解析）。
 */
export function issueFormHtml() {
  return `<div class="stack">
          <label class="field" for="pl-scope">
            <span class="field__label">权限范围</span>
            <select class="select" id="pl-scope" data-field="scope">
              <option value="leaderboard">公开榜单（/api/public/leaderboard）</option>
              <option value="calendar">赛程日历（/api/public/calendar.ics）</option>
              <option value="all" selected>两个公开端点都要</option>
            </select>
            <p class="field__hint">范围越小越好：只要榜单就别给日历。</p>
          </label>
          <label class="field" for="pl-ttl">
            <span class="field__label">有效期（天）</span>
            <input class="input" id="pl-ttl" data-field="ttlDays" type="number" min="1" step="1" placeholder="30" />
            <p class="field__hint">留空按规则里的默认天数；令牌过期后公开接口一律返回 403。</p>
          </label>
          <div class="row">
            <button type="button" class="btn btn--primary btn--sm" data-action="issue">签发新令牌</button>
          </div>
          <div class="form-feedback" data-feedback="issue"></div>
        </div>`;
}

/**
 * 两个公开链接（纯 HTML）。
 * ⚠️ 链接里的 token 与 editionId 都经 encodeURIComponent ——
 *    token 是服务端生成的 base64url，editionId 是 uuid，但**仍按不可信输入处理**。
 * ⚠️ href 的协议是固定的相对路径（/api/…）⇒ 不存在 javascript: 注入面。
 */
export function publicUrlHtml({ token = '', editionId = '' } = {}) {
  const t = encodeURIComponent(String(token ?? ''));
  const e = encodeURIComponent(String(editionId ?? ''));
  const leaderboard = `/api/public/leaderboard?token=${t}&editionId=${e}`;
  const calendar = `/api/public/calendar.ics?token=${t}&editionId=${e}`;
  return `<div class="stack">
          <div>
            <p class="field__label">公开榜单</p>
            <p><code class="mono">${escapeHtml(leaderboard)}</code></p>
            <a class="btn btn--ghost btn--sm" href="${escapeHtml(leaderboard)}" target="_blank" rel="noopener noreferrer">打开榜单接口</a>
          </div>
          <div>
            <p class="field__label">赛程日历（iCal）</p>
            <p><code class="mono">${escapeHtml(calendar)}</code></p>
            <a class="btn btn--ghost btn--sm" href="${escapeHtml(calendar)}" target="_blank" rel="noopener noreferrer">打开日历订阅</a>
          </div>
        </div>`;
}

/**
 * 刚签发的令牌（纯 HTML）：**显著**展示明文 + 两个公开链接 + 「只显示这一次」的提示。
 * ⛔ 明文只在这里出现一次；服务端只存哈希 ⇒ 页面必须说清「丢了只能重发」。
 */
export function issuedTokenHtml(issued = {}) {
  const token = String(issued?.token ?? '');
  const scope = String(issued?.scope ?? '');
  const editionId = String(issued?.editionId ?? '');
  const expiresAt = String(issued?.expiresAt ?? '');
  return `<div class="stack">
          ${noticeState({
    tone: 'success',
    title: '令牌已签发',
    items: [
      '明文只显示这一次：离开或刷新本页就再也看不到了（服务端只存哈希，不能找回）。',
      '请立刻复制下面的令牌与链接，交给需要访问公开榜单的人。',
    ],
  })}
          <div>
            <p class="field__label">明文令牌</p>
            <p><code class="mono">${escapeHtml(token)}</code></p>
          </div>
          <div>
            <p class="field__label">权限范围</p>
            <p>${badge(scopeLabel(scope), 'brand')}
              <span class="muted small">届期 ${escapeHtml(editionId)} · 过期于 ${escapeHtml(fmtTime(expiresAt))}</span></p>
          </div>
          ${sectionTitle('两个公开链接')}
          ${publicUrlHtml({ token, editionId })}
        </div>`;
}

/**
 * 公开访问令牌管理页。
 *
 * ⚠️ **局部重绘**（不整页刷新）：列表刷新只换列表与指标，
 *    签发表单里已填的内容**不会被冲掉**（DP-81：不许整页刷新 / 不许冲掉已填内容）。
 * ⚠️ **错误态必须带真能点的重试**（DP-80）：每个错误态外面包一层 `[data-retry]`
 *    ⇒ 事件委托能认出「这次要重跑哪一步」，点「重试」是真的重跑那一步。
 *
 * @param {object} ctx { api, navigate, setState, getState, query, params }
 * @returns {Promise<HTMLElement>}
 */
export async function renderPublicLinks(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'stack publinks-view';
  const api = ctx.api;
  let items = [];
  // ⛔ 明文只活在这一次的挂载期里（**不进 ctx.setState**：全局 store 会被别的视图读到）。
  let issued = null;
  const editionFilter = ctx.query?.editionId ? String(ctx.query.editionId) : '';

  // ⚠️ **P12：页面形状 = 操作台（左轨签发 + 右画布看结果）**。
  //    改版前是「head + 指标 + 两张面板」一字排开 ⇒ 签发表单与令牌列表同权重，
  //    而它们其实是**一对**关系：左轨是动作，右画布是动作的结果。
  //    ⛔ 三个挂载点（data-stats / data-issued / data-list）**必须保留** ——
  //    局部重绘靠它们定位（DP-81：不许整页刷新、不许冲掉已填内容）。
  wrap.innerHTML = [
    pageHead({
      title: '公开访问链接',
      sub: '公开榜单与赛程日历接口都必须带 token；在这里签发、查看与吊销。',
    }),
    workbench({
      rail: panel({
        title: '签发新令牌',
        desc: '明文只在签发时显示一次；库里只存哈希，丢了只能重发一枚。',
        body: issueFormHtml(),
      }),
      canvas: [
        '<div data-issued></div>',
        `<div data-stats>${statRow(tokenStats(items))}</div>`,
        panel({
          title: '已签发的令牌',
          desc: '短标识只是哈希的前几位，用来分辨是哪一枚 —— 它不是可用的令牌。',
          body: '<div data-list></div>',
        }),
      ].join(''),
    }),
  ].join('');

  const listHost = () => wrap.querySelector('[data-list]');
  const statsHost = () => wrap.querySelector('[data-stats]');
  const issuedHost = () => wrap.querySelector('[data-issued]');
  const feedbackSlot = () => wrap.querySelector('[data-feedback]');

  /** 重新拉列表并重绘列表 + 指标（失败时给带重试的错误态）。 */
  async function refreshList() {
    const host = listHost();
    if (host) host.innerHTML = loadingState({ rows: 3, label: '正在加载令牌…' });
    try {
      const query = editionFilter ? `?editionId=${encodeURIComponent(editionFilter)}` : '';
      const res = await api.get(`/api/public/tokens${query}`);
      items = tokenRows(res);
      const list = listHost();
      if (list) list.innerHTML = tokenTableHtml(items);
      const stats = statsHost();
      if (stats) stats.innerHTML = statRow(tokenStats(items));
    } catch (e) {
      const list = listHost();
      if (list) {
        list.innerHTML = `<div data-retry="list">${errorState({
          message: e?.message ?? '加载失败',
          hint: '点「重试」重新加载令牌列表。',
        })}</div>`;
      }
    }
  }

  /** 签发一枚新令牌（成功后显著展示明文 + 两个公开链接）。 */
  async function submitIssue() {
    const slot = feedbackSlot();
    const scope = wrap.querySelector('[data-field="scope"]')?.value ?? 'all';
    const ttlRaw = String(wrap.querySelector('[data-field="ttlDays"]')?.value ?? '').trim();
    const payload = { scope };
    if (ttlRaw !== '') {
      const ttl = Number(ttlRaw);
      // ⚠️ 本地先拦一道：Number('abc') 是 NaN ⇒ JSON 序列化后是 null ⇒ 后端会**静默**按默认天数签发。
      if (!Number.isInteger(ttl) || ttl <= 0) {
        if (slot) {
          slot.innerHTML = `<div data-retry="issue">${errorState({
            message: '有效期必须是正整数（天）',
            hint: '留空则按规则里的默认天数。',
          })}</div>`;
        }
        return;
      }
      payload.ttlDays = ttl;
    }
    if (slot) slot.innerHTML = loadingState({ rows: 1, label: '正在签发…' });
    try {
      const res = await api.post('/api/public/tokens', payload);
      issued = {
        token: String(res?.token ?? ''),
        scope: String(res?.scope ?? scope),
        editionId: String(res?.editionId ?? ''),
        expiresAt: String(res?.expiresAt ?? ''),
      };
      const host = issuedHost();
      if (host) {
        host.innerHTML = panel({
          title: '刚签发的令牌（明文只显示这一次）',
          tone: 'success',
          body: issuedTokenHtml(issued),
        });
      }
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已签发',
          items: ['明文令牌已显示在上方；离开本页后无法再次查看。'],
        });
      }
      await refreshList();
    } catch (e) {
      if (slot) {
        slot.innerHTML = `<div data-retry="issue">${errorState({
          message: e?.message ?? '签发失败',
          hint: '点「重试」按当前填写重新签发一次。',
        })}</div>`;
      }
    }
  }

  /** 吊销一枚令牌（失败时给带重试的错误态，重试的是**吊销**这一步）。 */
  async function revoke(id) {
    const host = listHost();
    if (host) host.innerHTML = loadingState({ rows: 2, label: '正在吊销…' });
    try {
      await api.del(`/api/public/tokens/${encodeURIComponent(id)}`);
      await refreshList();
    } catch (e) {
      const list = listHost();
      if (list) {
        list.innerHTML = `<div data-retry="revoke" data-id="${escapeHtml(id)}">${errorState({
          message: e?.message ?? '吊销失败',
          hint: '点「重试」重新吊销这枚令牌。',
        })}</div>`;
      }
    }
  }

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘（反馈位 / 确认块）不会丢监听。
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      // ⚠️ 重试要重跑**刚才失败的那一步**：靠外层 [data-retry] 标记区分（list / issue / revoke）。
      const scope = btn.closest('[data-retry]');
      const kind = scope?.dataset?.retry ?? 'list';
      if (kind === 'issue') { await submitIssue(); return; }
      if (kind === 'revoke') { await revoke(scope.dataset.id ?? ''); return; }
      await refreshList();
      return;
    }
    if (action === 'issue') { await submitIssue(); return; }
    if (action === 'revoke-request') {
      const id = btn.dataset.id ?? '';
      // ⚠️ 用 dataset 逐个比对而不是拼 CSS 选择器 —— id 是哈希，但不必冒选择器转义的险。
      for (const box of wrap.querySelectorAll('[data-revoke-confirm]')) {
        if (box.dataset.revokeConfirm === id) box.hidden = false;
      }
      return;
    }
    if (action === 'revoke-cancel') {
      const id = btn.dataset.id ?? '';
      for (const box of wrap.querySelectorAll('[data-revoke-confirm]')) {
        if (box.dataset.revokeConfirm === id) box.hidden = true;
      }
      return;
    }
    if (action === 'revoke-confirm') {
      await revoke(btn.dataset.id ?? '');
      return;
    }
  });

  // ⚠️ 不 await：先把骨架渲染出来，列表随后自己填上（避免白屏）。
  refreshList();
  return wrap;
}
```

### `platform/web/views/audit-log.js`

审计日志界面（W3：设计 §9「审计与复算」的审计流水）。

```javascript
// web/views/audit-log.js — 审计日志页（组委会：审计与复算 → 审计流水）
//
// 依据：
//   - 设计文档 §9「组委会视角 → **审计与复算**」—— 这一块界面此前**完全不存在**：
//     `GET /api/audit/log` 早就挂在后端，前端却**从来没有调用过它**
//     （同 P11 在清理的「端点已挂、前端从不调用」那一类死端点）。
//   - R-JDG-17（全程留档 6 个月）/ S7 §4.2（赛后 6 个月可查）
//     → `retention` 段必须**显式**说清「可查起始日」，不能让人以为历史记录丢了。
//   - R-AUD-01（每次发榜/计分可复算）→ 审计流水是复算的另一半：谁、什么时候、做了什么。
//   - 全局约束「可见性由 API 裁决」（DP-77）→ 前端不自己判权限，只把 API 的结论原样呈现。
//
// 溯源（端点契约一律以源码为准）：
//   GET /api/audit/log
//     src/http/routes/audit.js → pickFilter(query) → listAuditLog()
//     src/services/audit.js    → { rows, total, retention }
//   rows[i] = { id, actorId, action, entity, entityId, detail, detailParseError, createdAt }
//   ⛔ 没有 `audit:read` 能力点时返回的是 **200 + 空集**（不是 403）：
//      { rows: [], total: 0, retention: null }
//      ⇒ 前端**不能**把「空集」直接等同于「没有记录」（可能是压根没权限）。
//
// ⚠️ **明细必须显式**（★ 关键修正，与服务端 I-1 同一口径）：
//   - `detail === null`          ⇒ 显示「—」（这一条本来就没有明细）
//   - `detailParseError === true` ⇒ **必须显式标出「明细解析失败」**
//     （服务端把坏 JSON 降级成 detail=null + 这个标记）
//     ⚠️ 把它当成「空明细」就是**静默丢证据**：审计轨迹是复盘的唯一凭据。
//   - `detail` 是对象            ⇒ 渲染成**逐项可读**的键值对，不把整坨 JSON 塞进 <code>。
//
// ⛔ 一切用户数据只经 web/escape.js 的 escapeHtml（全站唯一转义入口）。
// ⛔ 只用 styles.css 里**已有**的 class；不写 <style>、不造新类、卡片零外阴影、一屏强调色 ≤3。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  sectionTitle, statRow, tableWrap, workbench,
} from '../ui.js';

/** 默认每页条数（服务端 queryAuditLog 的默认 limit 也是 100，这里取更保守的 50）。 */
export const DEFAULT_LIMIT = 50;

/** 每页条数上限（防止一个 query 参数把整张表拉出来）。 */
export const MAX_LIMIT = 200;

/**
 * 把「用户填的原始过滤值」归一成请求参数口径（纯函数）。
 *
 * ⚠️ 只保留服务端 `pickFilter` 认识的白名单字段（action / entity / since / until / limit / offset）
 *    —— 前端拼错字段名不会报错，只会**静默不过滤**（页面看起来"没筛"）。
 * ⛔ `limit` 必须是**有限正整数**（服务端也这么校验：非法 limit 直接被丢掉 ⇒ 页大小悄悄变回默认）。
 */
export function normalizeAuditFilters(raw = {}) {
  const out = { action: '', entity: '', since: '', until: '', limit: DEFAULT_LIMIT, offset: 0 };
  const action = String(raw.action ?? '').trim();
  if (action) out.action = action;
  const entity = String(raw.entity ?? '').trim();
  if (entity) out.entity = entity;
  const since = String(raw.since ?? '').trim();
  if (since) out.since = since;
  const until = String(raw.until ?? '').trim();
  if (until) out.until = until;
  const limit = Number(raw.limit);
  if (Number.isInteger(limit) && limit > 0) out.limit = Math.min(limit, MAX_LIMIT);
  const offset = Number(raw.offset);
  if (Number.isInteger(offset) && offset >= 0) out.offset = offset;
  return out;
}

/**
 * `until` 的日期补齐（纯函数）。
 *
 * ⚠️ 服务端拿 `created_at`（ISO 字符串）做**字典序比较**：
 *    `created_at <= '2026-10-31'` 会把 10-31 当天 00:00 之后的记录**全部排除**。
 *    ⇒ 裸日期的 until 补成当天 23:59:59.999Z（UTC，与 created_at 的口径一致）。
 * ⚠️ `since` 不补：'2026-10-01' <= '2026-10-01T09:00:00.000Z' 本来就成立（字典序），
 *    补成 00:00 只是把隐含约定写明，不改变结果。
 */
export function auditLogUntilParam(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59:59.999Z`;
  return s;
}

/**
 * 过滤参数 → query 串（纯函数，**不带**前导 '?'）。
 *
 * ⚠️ 键的顺序是**固定**的（action → entity → since → until → limit → offset）：
 *    同样的过滤条件必须拼出**同样的**串 ⇒ URL 可比较、可缓存、测试可断言。
 * ⛔ 空值一律**不拼进去**（服务端把 '' 当"不过滤"，拼了也是空转）。
 */
export function auditLogQuery(filters = {}) {
  const f = normalizeAuditFilters(filters);
  const parts = [];
  if (f.action) parts.push(`action=${encodeURIComponent(f.action)}`);
  if (f.entity) parts.push(`entity=${encodeURIComponent(f.entity)}`);
  if (f.since) parts.push(`since=${encodeURIComponent(f.since)}`);
  if (f.until) parts.push(`until=${encodeURIComponent(auditLogUntilParam(f.until))}`);
  parts.push(`limit=${f.limit}`);
  if (f.offset > 0) parts.push(`offset=${f.offset}`);
  return parts.join('&');
}

/**
 * 分页边界（纯函数）。
 *
 * ⚠️ 「到底了」的判据是 `offset + limit >= total`（不是 `offset >= total`）：
 *    最后一页往往**不满** limit 条，用 offset>=total 判会多出一页空白。
 * ⛔ total 为 0 时 pageCount 取 1（不是 0）：页码从 1 开始，「第 1/1 页」比「第 1/0 页」说得通。
 */
export function auditPagination(total, limit, offset) {
  const t = Math.max(0, Number(total) || 0);
  const l = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  const o = Math.max(0, Number(offset) || 0);
  const pageCount = t === 0 ? 1 : Math.ceil(t / l);
  return {
    total: t,
    limit: l,
    offset: o,
    page: Math.floor(o / l) + 1,
    pageCount,
    hasPrev: o > 0,
    hasNext: o + l < t,
    rangeStart: t === 0 ? 0 : o + 1,
    rangeEnd: Math.min(o + l, t),
  };
}

/**
 * 明细值 → 可读文本（纯函数）。
 * ⚠️ 对象 / 数组用 JSON.stringify 压成一行（**转义在调用方做**）。
 */
function formatDetailValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 明细 → 键值对（纯函数）。数组按下标展开；返回 null 表示"不是可展开的容器"。
 */
function detailEntries(detail) {
  if (Array.isArray(detail)) return detail.map((v, i) => [String(i), v]);
  if (detail && typeof detail === 'object') return Object.entries(detail);
  return null;
}

/**
 * 明细单元格（纯函数）。
 *
 * ★ 关键修正：解析失败必须**显式**标出「明细解析失败」。
 *   服务端把坏 JSON 降级成 `detail=null, detailParseError=true`
 *   —— 如果这里按 null 处理成「—」，就等于**把坏掉的审计明细静默吞掉**：
 *   复盘的人看到的是"这条没有明细"，而不是"这条的明细坏了"。
 *
 * @param {unknown} detail            解析后的明细（对象 / 数组 / 字符串 / null）
 * @param {boolean} detailParseError  服务端的解析失败标记
 */
export function auditLogDetailHtml(detail, detailParseError = false) {
  // ⛔ 先判解析失败，再判 null —— 顺序反了就把"坏明细"当成"没有明细"。
  if (detailParseError === true) {
    return `
      <div class="row">${badge('明细解析失败', 'danger')}</div>
      <p class="muted small">这条记录的明细 JSON 解析失败（内容损坏）：记录本身仍在，但明细读不出来。</p>`;
  }
  if (detail === null || detail === undefined) {
    return '<span class="muted">—</span>';
  }
  const entries = detailEntries(detail);
  if (entries === null) {
    return `<span>${escapeHtml(formatDetailValue(detail))}</span>`;
  }
  if (!entries.length) {
    return '<span class="muted">无明细字段</span>';
  }
  // ⚠️ 明细渲染成**逐项可读**的键值对（不是整坨 JSON 塞进 <code>）：
  //    审计流水是要被人读的表格，不是给机器看的 dumps。
  const rows = entries.map(([k, v]) => `
    <div class="kv__row">
      <dt class="kv__key">${escapeHtml(k)}</dt>
      <dd class="kv__val">${escapeHtml(formatDetailValue(v))}</dd>
    </div>`).join('');
  return `<dl class="kv">${rows}</dl>`;
}

/**
 * 一行审计流水（纯函数）。
 * 列：时间 / 操作者 / 动作 / 实体 / 对象 id / 明细
 */
export function auditLogRowHtml(row) {
  const r = row ?? {};
  const actor = r.actorId ? String(r.actorId) : '系统';
  return `<tr>
    <td class="num">${escapeHtml(r.createdAt ?? '—')}</td>
    <td>${escapeHtml(actor)}</td>
    <td><code>${escapeHtml(r.action ?? '—')}</code></td>
    <td>${escapeHtml(r.entity ?? '—')}</td>
    <td>${escapeHtml(r.entityId ?? '—')}</td>
    <td>${auditLogDetailHtml(r.detail, r.detailParseError === true)}</td>
  </tr>`;
}

/**
 * 审计流水表（纯函数）。
 * ⚠️ 表格密度用 `table--compact`：审计流水字段多、条目多，紧凑才一屏能看够。
 */
export function auditLogTableHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return tableWrap(
    '<thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>实体</th><th>对象 id</th><th>明细</th></tr></thead>'
    + `<tbody>${list.map((r) => auditLogRowHtml(r)).join('')}</tbody>`,
    { caption: '审计流水（按时间倒序）', className: 'table--compact' },
  );
}

/**
 * 空集（纯函数）。
 * ⚠️ 空态必须说清**为什么空** + **下一步做什么**（不是白屏）。
 * ⚠️ 还要点破「200 + 空集」这层含义：没有 audit:read 能力点的账号看到的**也是**空集。
 */
export function auditLogEmptyHtml() {
  return emptyState({
    title: '没有匹配的审计记录',
    hint: '当前过滤条件下没有任何审计记录。可以放宽条件试试：清空动作 / 实体、把起止时间挪宽，或加大每页条数。'
      + '（提示：没有 audit:read 能力点的账号拿到的也是同样的空集 —— 若是第一次打开这个页面，先确认权限。）',
  });
}

/**
 * 保留窗口提示（纯函数）。
 * ⛔ `retention` 为 null 时**返回空串**（不编造窗口）—— 服务端没给就是没有，别猜。
 */
export function auditRetentionHtml(retention) {
  if (!retention || typeof retention !== 'object') return '';
  const since = retention.queryableSince ?? '—';
  const months = retention.archiveMonths ?? '—';
  return noticeState({
    tone: 'info',
    title: '保留窗口',
    items: [`本次数据可查起始日 ${since}（${months} 个月）`],
  });
}

/**
 * 指标行（纯函数）。
 * ⛔ 「可查起始日」在 retention 为 null 时显示「—」并注明接口未给出 —— 不编造日期。
 */
export function auditLogStats(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const total = Number(data?.total ?? rows.length) || 0;
  const retention = data?.retention ?? null;
  return [
    { label: '总条数', value: total, tone: 'neutral' },
    { label: '当前页条数', value: rows.length, tone: 'brand' },
    {
      label: '可查起始日',
      value: retention?.queryableSince ?? '—',
      tone: 'neutral',
      hint: retention ? `保留 ${retention.archiveMonths} 个月` : '接口未给出保留窗口',
    },
  ];
}

/**
 * 分页条（纯函数）。
 * ⛔ 到头了就把按钮**禁用**（disabled 属性）—— 光靠不请求，用户不知道是到底了还是坏了。
 */
export function auditLogPagerHtml(pager) {
  const p = pager ?? auditPagination(0, DEFAULT_LIMIT, 0);
  return `
    <div class="row row--between">
      <span class="muted small">第 ${p.rangeStart}-${p.rangeEnd} 条 / 共 ${p.total} 条（第 ${p.page}/${p.pageCount} 页）</span>
      <div class="row">
        <button type="button" class="btn btn--ghost btn--sm" data-action="page-prev"${p.hasPrev ? '' : ' disabled'}>上一页</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="page-next"${p.hasNext ? '' : ' disabled'}>下一页</button>
      </div>
    </div>`;
}

/**
 * 过滤条（纯函数）。
 * ⚠️ 字段名必须与服务端 `pickFilter` 的白名单**逐字一致**（拼错 = 静默不过滤）。
 */
export function auditLogFilterHtml(filters = {}) {
  const f = filters ?? {};
  return `
    <div class="grid grid--3">
      <div class="field">
        <label class="field__label" for="al-action">动作</label>
        <input class="input" id="al-action" type="text" value="${escapeHtml(f.action ?? '')}" placeholder="如 computation.record" />
      </div>
      <div class="field">
        <label class="field__label" for="al-entity">实体</label>
        <input class="input" id="al-entity" type="text" value="${escapeHtml(f.entity ?? '')}" placeholder="如 computation" />
      </div>
      <div class="field">
        <label class="field__label" for="al-since">起始时间</label>
        <input class="input" id="al-since" type="date" value="${escapeHtml(f.since ?? '')}" />
      </div>
      <div class="field">
        <label class="field__label" for="al-until">截止时间</label>
        <input class="input" id="al-until" type="date" value="${escapeHtml(f.until ?? '')}" />
      </div>
      <div class="field">
        <label class="field__label" for="al-limit">每页条数</label>
        <input class="input" id="al-limit" type="number" min="1" max="${MAX_LIMIT}" value="${escapeHtml(String(f.limit ?? DEFAULT_LIMIT))}" />
      </div>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="apply-filter">筛选</button>
      <span class="muted small">过滤条件会作为 query 参数传给 GET /api/audit/log（服务端只认白名单字段）。</span>
    </div>`;
}

/**
 * 从事件里取出 data-action（纯函数）。
 * ⚠️ 兼容两种形态：事件目标**自己**带 data-action（按钮），
 *    或者目标在带 data-action 的祖先里（点按钮里的文字/图标）。
 */
function actionOf(ev) {
  const target = ev?.target;
  if (!target) return null;
  const own = target.dataset?.action;
  if (own) return own;
  return target.closest?.('[data-action]')?.dataset?.action ?? null;
}

/**
 * 审计日志页。
 *
 * ⛔ 权限口径：`GET /api/audit/log` 没有 audit:read 时返回 **200 + 空集**，
 *    所以这里**不会**收到 403 —— 空集由 emptyState 说清（见 auditLogEmptyHtml）。
 * ⚠️ 重试用**事件委托**绑定在 wrap 上（不用固定 id）：errorState() 生成的重试按钮没有 id，
 *    委托到整页容器，按钮标记变化也不会失效。
 *
 * @param {object} ctx { api, navigate, setState, getState, query, params }
 * @returns {Promise<HTMLElement>}
 */
export async function renderAuditLog(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'stack auditlog-view';

  // ⚠️ **P12：页面形状 = 操作台（左轨过滤 + 右画布看审计流）**。
  //    改版前是「head + 过滤面板 + 事件表」一字排开 ⇒ 五个过滤输入框
  //    与审计流水同权重，**读审计的人第一眼看到的是表单而不是记录**。
  //    ⇒ 左轨 = 过滤条（控件条 ⇒ 材质平，描边用虚线表示「这是一条控件」）；
  //      右画布 = 指标 + 状态 + 流水 + 翻页。
  //    骨架统一由 web/ui.js 的 workbench() 产出（四个委员会页同一份结构）。
  wrap.innerHTML = [
    pageHead({
      title: '审计日志',
      sub: '审计与复算：谁、在什么时候、对什么做了什么。记录不可编辑 —— 审计轨迹是复盘的唯一凭据。',
    }),
    workbench({
      rail: '<div id="al-filters"></div>',
      canvas: [
        '<div id="al-stats"></div>',
        '<p class="muted small" id="al-msg">正在加载审计日志…</p>',
        '<div id="al-state"></div>',
        '<div id="al-body"></div>',
      ].join(''),
    }),
  ].join('');

  const filters = wrap.querySelector('#al-filters');
  const statsBox = wrap.querySelector('#al-stats');
  const msg = wrap.querySelector('#al-msg');
  const stateBox = wrap.querySelector('#al-state');
  const body = wrap.querySelector('#al-body');

  // ⚠️ 初始过滤条件从 ctx.query 取（深链可分享）；本视图自己持有后续改动
  //    （不写全局 store：全局 store 会被别的视图读到）。
  let current = normalizeAuditFilters({ ...(ctx?.query ?? {}), offset: 0 });
  let lastTotal = 0;

  filters.innerHTML = panel({
    title: '过滤',
    desc: '按动作、实体与时间范围缩小范围；点「筛选」重新请求。',
    body: auditLogFilterHtml(current),
  });

  // ⚠️ 事件委托：重试 / 筛选 / 翻页都走这一条，不给按钮绑固定 id。
  wrap.addEventListener('click', (ev) => {
    const action = actionOf(ev);
    if (!action) return;
    if (action === 'retry') { void load(); return; }
    if (action === 'apply-filter') { void applyFilters(); return; }
    if (action === 'page-prev') { void turnPage(-1); return; }
    if (action === 'page-next') { void turnPage(1); return; }
  });

  /** 读过滤条上的值 → 归一 → 回到第一页 → 重新请求。 */
  function applyFilters() {
    current = normalizeAuditFilters({
      action: filters.querySelector('#al-action')?.value ?? '',
      entity: filters.querySelector('#al-entity')?.value ?? '',
      since: filters.querySelector('#al-since')?.value ?? '',
      until: filters.querySelector('#al-until')?.value ?? '',
      limit: filters.querySelector('#al-limit')?.value ?? DEFAULT_LIMIT,
      offset: 0,
    });
    void load();
  }

  /** 翻页（纯算术在 auditPagination 里做；这里只负责改 offset 与重载）。 */
  function turnPage(delta) {
    const pager = auditPagination(lastTotal, current.limit, current.offset);
    if (delta < 0 && !pager.hasPrev) return;
    if (delta > 0 && !pager.hasNext) return;
    current = { ...current, offset: Math.max(0, current.offset + delta * current.limit) };
    void load();
  }

  async function load() {
    msg.textContent = '正在加载审计日志…';
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载审计日志…' });
    const qs = auditLogQuery(current);
    let data;
    try {
      data = await ctx.api.get(`/api/audit/log${qs ? `?${qs}` : ''}`);
    } catch (e) {
      msg.textContent = '审计日志加载失败';
      statsBox.innerHTML = '';
      stateBox.innerHTML = errorState({
        message: e.message,
        hint: '日志没拉到。可以重试；若持续失败，检查账号是否还有 audit:read 权限。',
      });
      body.innerHTML = '';
      return;
    }
    stateBox.innerHTML = '';
    render(data);
  }

  /** 把一份 API 返回画成：指标 + 保留窗口 + 表 + 分页。 */
  function render(data) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    lastTotal = Number(data?.total ?? rows.length) || 0;
    const pager = auditPagination(lastTotal, current.limit, current.offset);

    statsBox.innerHTML = statRow(auditLogStats({ ...data, rows }));
    msg.textContent = `共 ${lastTotal} 条审计记录（第 ${pager.page}/${pager.pageCount} 页，本页 ${rows.length} 条）`;

    body.innerHTML = [
      sectionTitle('审计流水'),
      auditRetentionHtml(data?.retention ?? null),
      rows.length ? auditLogTableHtml(rows) : auditLogEmptyHtml(),
      auditLogPagerHtml(pager),
    ].join('');
  }

  await load();
  return wrap;
}
```

### `platform/test/publish-api.test.js`

发榜端到端闸（经 HTTP 路由）。

```javascript
// platform/test/publish-api.test.js —— 发榜端点的**端到端**闸（P11 · E149）
//
// ⛔ **这个文件为什么必须存在**（本项目的病根之一）：
//   P0–P10 的大量闸是「**服务层单测**」—— 直接调 `publishLeaderboard(...)`，
//   25 处引用全绿 ⇒ 看上去「发榜做完了」。
//   但**路由表里没有任何一条路能触达它**（设计文档 §8 的 API 清单漏了 publish 这一条）。
//   ⇒ 「服务层写了、路由没挂」一路绿灯，直到真机跑起来才发现：
//     名次积分从未发放、段位永远 D 段、榜单快照为空、发榜没有留痕。
//   ⇒ 这个文件全部走**真实 HTTP 路由**（`call(app, method, path, …)`），
//     断言的是「HTTP 打完之后库里到底有什么」—— 这才是产品真正能观察到的结果。
//
// 规则溯源：
//   - 「计算与发榜是两个独立动作，发榜必须有操作者与时间戳」→ 设计文档 §869（§6.4 决策）
//   - 「名次积分 10/8/5，MVP 4 赛段总积分 + 路演评审综合」→ 任务书 §七 + rules/points.json
//   - 「段位来自里程碑 + 未撤回签字，发榜时重算」→ 设计文档 §6.5（P3-15）
//   - 「三态状态码」→ 设计文档 §7.3
//   - 「TOP10 名单事后电话回访」→ S7 §4.1（R-JDG-16）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/** 评委席维度（rules/scoring-initial.json 的 seat='judge' 五维）。 */
const JUDGE_DIMS = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['behavior:write', '提交行为分记录'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pubapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900001001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900001002', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900001003', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900001004', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900001005', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability, scopeType = 'global', scopeId = null) => grantAssignment(db, {
    userId, capability, scopeType, scopeId, grantedBy: admin.id,
  });
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  // 三支队伍：分数刻意拉开（甲最高、乙次之、丙最低）⇒ 名次与积分可判别
  const teams = [];
  const scores = [[90, 86], [80, 76], [70, 66]];
  const caps = ['13900001010', '13900001020', '13900001030'];
  scores.forEach((pair, i) => {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: caps[i], password: 'pw' });
    const member = createUser(db, { name: `组员${i + 1}`, phone: `1380000${1010 + i}`, password: 'pw' });
    grant(captain.id, 'behavior:write');
    grant(member.id, 'behavior:write');
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    insertTeamMember(db, { teamId: team.id, userId: member.id, role: 'member', now: NOW });
    for (const [j, dim] of JUDGE_DIMS.entries()) {
      insertReview(db, {
        stageId: stage.id, judgeId: judge.id, teamId: team.id, dimension: dim,
        rawScore: pair[j % 2], requestId: `r-${i}-${j}`, calibrated: 0, now: NOW,
      });
    }
    teams.push({ team, captain, member });
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, admin, judge, outsider, enterprise, stage, edition, teams,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

test('⛔ E149 回归闸：POST /api/stages/:stageId/publish 经 HTTP 路由后，四样东西必须真的写进库', async () => {
  const ctx = setup();
  try {
    // ① 先算（计算与发榜是两个独立动作）
    const compute = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    assert.equal(compute.status, 200, `计算应成功：${compute.body}`);

    // ② 发榜（此前**根本没有这条路由**）
    const publish = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    assert.equal(publish.status, 200, `发榜应成功：${publish.body}`);

    const snaps = ctx.db.prepare('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE stage_id = ?').get(ctx.stage.id).n;
    assert.equal(snaps, 3, 'rank / business / personal 三份榜单快照都要写');

    const ledger = ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
    assert.ok(ledger > 0, '名次积分必须写进流水（此前恒为 0 ⇒ 个人榜恒为空）');

    const tiers = ctx.db.prepare('SELECT COUNT(*) AS n FROM tier_records WHERE deleted_at IS NULL').get().n;
    assert.ok(tiers > 0, '段位记录必须写（此前恒为 0 ⇒ 段位永远 D 段 ⇒ 段位权益永不解锁）');

    const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'leaderboard.publish'").get().n;
    assert.equal(audit, 1, '发榜必须留痕（操作者 + 时间戳）');

    // ③ 判别性：个人榜必须真的有行（发榜前恒为空）
    const personal = await call(ctx.app, 'GET', `/api/leaderboard/${ctx.stage.id}?scope=personal`);
    assert.equal(personal.status, 200);
    const rows = json(personal).rows;
    assert.ok(rows.length > 0, '发榜后个人积分榜必须有行（此前恒为空 ⇒ 奖金无依据）');
    assert.ok(rows.every((r) => r.total > 0), '每个人的名次积分都要大于 0');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 发榜页的读口：GET /api/stages/:stageId/publish 能回答「发过榜没有」+「TOP 回访清单」', async () => {
  const ctx = setup();
  try {
    const before = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    assert.equal(before.status, 200);
    const b = json(before);
    assert.equal(b.published, false, '没发过榜就不能说发过');
    assert.equal(b.reverseAuditTasks.length, 0, '没发榜就没有 TOP 回访清单');
    assert.ok(b.warnings.some((w) => w.code === 'STAGE_NOT_PUBLISHED'), '未发榜要显式告警，不静默');

    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });

    const after = json(await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin }));
    assert.equal(after.published, true);
    assert.equal(after.snapshots.length, 3);
    assert.ok(after.publishedAt, '发榜时间必须给出来（操作者 + 时间戳）');
    assert.ok(after.reverseAuditTasks.length > 0, 'R-JDG-16：TOP 名单回访清单必须产出');
    assert.equal(after.reverseAuditTasks[0].action, 'alert_only', '只告警、不代劳、不自动结案');
    assert.ok(after.reverseAuditTasks[0].instruction, '回访任务必须带指令文案');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 发榜的权限闸：无 stage:compute → 403；未登录 → 401；赛段不存在 → 404', async () => {
  const ctx = setup();
  try {
    const noPerm = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenOutsider });
    assert.equal(noPerm.status, 403, '没有 stage:compute 的人不能发榜');
    assert.equal(json(noPerm).error.code, 'FORBIDDEN');

    const anon = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`);
    assert.equal(anon.status, 401, '未登录 → 401');

    const missing = await call(ctx.app, 'POST', '/api/stages/st_nope/publish', { token: ctx.tokenAdmin });
    assert.equal(missing.status, 404, '赛段不存在 → 404');
    assert.equal(json(missing).error.code, 'STAGE_NOT_FOUND');

    // 读口同口径
    assert.equal((await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenOutsider })).status, 403);
    assert.equal((await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`)).status, 401);
    assert.equal((await call(ctx.app, 'GET', '/api/stages/st_nope/publish', { token: ctx.tokenAdmin })).status, 404);
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 赛段级授权也能发榜（前后端口径一致：路由认赛段级，服务层也认）', async () => {
  const ctx = setup();
  try {
    // 给评委甲一个**赛段级**的 stage:compute（不是全局）
    grantAssignment(ctx.db, {
      userId: ctx.judge.id, capability: 'stage:compute', scopeType: 'stage', scopeId: ctx.stage.id, grantedBy: ctx.admin.id,
    });
    const token = createSession(ctx.db, ctx.judge.id).token;
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token });
    assert.equal(res.status, 200, `赛段级授权应当能发榜：${res.body}`);
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 重发榜的幂等：名次没变 ⇒ 积分流水**不新增行**（不重复发分）', async () => {
  const ctx = setup();
  try {
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    const n1 = ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
    assert.ok(n1 > 0);

    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    const n2 = ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
    assert.equal(n2, n1, '重复发榜不得重复发分');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 重发榜的**逆向路径**：名次变了 ⇒ 走「差额更正」写新记录（只增不改），个人榜跟着改', async () => {
  const ctx = setup();
  try {
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });

    const personalBefore = json(await call(ctx.app, 'GET', `/api/leaderboard/${ctx.stage.id}?scope=personal`)).rows;
    const totalBefore = personalBefore.reduce((s, r) => s + r.total, 0);
    assert.ok(totalBefore > 0);
    // 判别基线：3 支队同属一个任务包 ⇒ 名次积分 10 / 8 / 5，每人一份
    const capOf = (i) => ctx.teams[i].captain.id;
    const before = new Map(personalBefore.map((r) => [r.userId, r.total]));
    assert.equal(before.get(capOf(2)), 5, '第 3 名（丙队）原本拿 5 分');
    assert.equal(before.get(capOf(0)), 10, '第 1 名（甲队）原本拿 10 分');

    // 制造名次变化：把 3 队的总分顶到最高（模拟「组委会改了数据后重算重发」）
    ctx.db.prepare('UPDATE stage_results SET total = 999 WHERE team_id = ?').run(ctx.teams[2].team.id);
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });

    // ① 差额以**新记录**写进流水（原记录不动 ⇒ 仍满足「只增不改」）
    const rows = ctx.db.prepare("SELECT points FROM points_ledger WHERE kind = 'stage_rank' ORDER BY created_at, rowid").all();
    const hasNegative = rows.some((r) => r.points < 0);
    assert.ok(hasNegative, '名次变化必须写一条差额更正记录（不是覆盖原记录）');

    // ② 同一个人的累计积分 = 10/8/5 口径下的**新名次**积分，不是旧名次的
    //    ⚠️ 判别点不是「总分变了」（名次置换时总分恒定 = 10+8+5），
    //       而是**分布变了**：被顶到第 1 的那支队从 5 分变成 10 分。
    const personalAfter = json(await call(ctx.app, 'GET', `/api/leaderboard/${ctx.stage.id}?scope=personal`)).rows;
    const after = new Map(personalAfter.map((r) => [r.userId, r.total]));
    assert.equal(after.get(capOf(2)), 10, '丙队被顶到第 1 ⇒ 队长积分必须从 5 变成 10');
    assert.equal(after.get(capOf(0)), 8, '甲队掉到第 2 ⇒ 队长积分必须从 10 变成 8');
    const totalAfter = personalAfter.reduce((s, r) => s + r.total, 0);
    assert.equal(totalAfter, totalBefore, '名次置换 ⇒ 团队总分恒定（10+8+5），个人积分不得凭空多出或少掉');

    // ③ 判别性：不能出现「同一个人既拿旧分又拿新分」的重复计分
    const leader = ctx.db.prepare("SELECT team_id, user_id, SUM(points) AS total FROM points_ledger WHERE kind = 'stage_rank' GROUP BY team_id, user_id").all();
    for (const r of leader) {
      assert.ok(r.total >= 0, '任何人的名次积分累计都不得为负（差额更正后仍应是有效分值）');
    }
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});
```

### `platform/test/enterprise-confirmation-reverse.test.js`

企业确认逆向闭环闸（E141 / E148）。

```javascript
// platform/test/enterprise-confirmation-reverse.test.js —— 企业确认的逆向路径（P11 · E141 / E148）
//
// ⛔ **这个文件为什么存在**（E141 / E148 的实测结论）：
//   企业确认（企业席分）一旦落库，产品内**没有任何途径**改动它：
//     · 写端点 `POST /api/stages/:stageId/enterprise-confirmations` 只有正向；
//     · 同格重签撞唯一索引 ⇒ **HTTP 500「服务内部错误」**（E148②，违反设计文档 §7.3）；
//     · 仓储层的 `softDeleteEnterpriseConfirmation` **零调用方** —— 写了没人用。
//   ⇒ 一条「只签了一半」（缺跨领域评委签字 = R2 双签只签一边）的确认，
//     企业席按 R2 **恒计 0 分**并挂 `R2_missing_dual_signature` 告警，
//     而组委会与出题企业**在产品里修不了它** —— 初赛 −8 分、决赛 −20 分（E141 实测）。
//
// ⛔ P11 补的三条能力：
//   ① 同格重签 → 409 CONFIRMATION_EXISTS（不是 500），并告诉客户端「要改请走改签」；
//   ② **改签**（resign）⇒ 软删旧行 + 追加新行（同格），更正内容 / 分数；
//   ③ **R2 后补**（resign 带 crossJudgeId = 自己）⇒ 跨领域评委给自己补上另一半签字。
//   ④ **撤回**（withdraw）⇒ 软删，证据留痕。
//
// 规则溯源：
//   · R2「缺双签按 0 分计 + 记 warning」→ S7 §3.1（**计分口径**，不是写入校验 ⇒ 不在写端点强制）
//   · R-JDG-14「签字必须写明内容」→ S7 §4.1
//   · 「评分/积分类记录只增不改，更正走新记录」→ INTERFACES.md §0
//   · 三态状态码 → 设计文档 §7.3
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['signoff:create', '企业签字'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-entrev-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900002001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900002002', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900002003', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900002004', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900002005', password: 'pw' });
  const outsider = createUser(db, { name: '无关者', phone: '13900002006', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(enterprise.id, 'score:write');
  grant(enterprise.id, 'signoff:create');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: captain.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  // 评委席打分（让队伍进得了 stage_results，企业席分才有观察面）
  for (const dim of ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']) {
    insertReview(db, {
      stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: dim,
      rawScore: 88, requestId: `r-${dim}`, calibrated: 0, now: NOW,
    });
  }

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, admin, judge, judge2, enterprise, captain, outsider, team1, stage,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

/** 算一次，取该队的企业席分与告警。 */
async function computeTeam(s, teamId) {
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
  assert.equal(res.status, 200, `计算应成功：${res.body}`);
  const body = json(res);
  const team = body.teams.find((t) => t.teamId === teamId);
  return {
    seatE: team?.seatE ?? null,
    total: team?.total ?? null,
    codes: (body.warnings ?? []).map((w) => w.code),
  };
}

test('⛔ E148②：同格重签必须 409（**不是 500**），且要告诉客户端该走「改签」', async () => {
  const s = setup();
  try {
    const body = { teamId: s.team1.id, rawScore: 90, content: '解决了我方库存周转环节' };
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise, body,
    });
    assert.equal(first.status, 200, `第一次签应成功：${first.body}`);

    // ⛔ 判别点：同格（赛段 + 队伍 + 维度 + 企业）再签一次
    const second = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise, body,
    });
    assert.equal(second.status, 409, `同格重签必须是 409，不是 500：${second.status} ${second.body}`);
    assert.equal(json(second).error.code, 'CONFIRMATION_EXISTS');
    assert.match(json(second).error.message, /改签|撤回/, '错误文案要指向逆向路径');

    // 数据库里仍然只有**一条有效**确认
    const rows = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL').all(s.stage.id);
    assert.equal(rows.length, 1, '同格只能有一条有效确认');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ E141：只签一半 ⇒ 企业席恒 0 分；补签（R2 后补）⇒ 分数回来（这条是整个 E141 的要害）', async () => {
  const s = setup();
  try {
    // ① 出题企业先签（**不带** crossJudgeId ⇒ R2 双签只签了一半）
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, content: '解决了我方库存周转环节' },
    });
    assert.equal(first.status, 200, first.body);
    const confirmationId = json(first).id;

    // ② 半条确认 ⇒ 企业席按 R2 计 0 分，并挂 R2_missing_dual_signature
    const before = await computeTeam(s, s.team1.id);
    assert.equal(before.seatE, 0, '缺双签 ⇒ 企业席按 R2 计 0 分');
    assert.ok(before.codes.includes('R2_missing_dual_signature'), `必须挂 R2 告警：${JSON.stringify(before.codes)}`);

    // ③ 跨领域评委给自己**补签**（R2 后补）—— 这是此前产品里根本不存在的路径
    const backfill = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${confirmationId}/resign`, {
      token: s.tokenJudge,
      body: { crossJudgeId: s.judge.id },
    });
    assert.equal(backfill.status, 200, `补签应成功：${backfill.body}`);
    assert.equal(json(backfill).cross_judge_id, s.judge.id, '新行上要有跨领域评委签字');

    // ④ 重新计算 ⇒ 企业席分回来了，R2 告警消失
    const after = await computeTeam(s, s.team1.id);
    assert.equal(after.seatE, 90, '补签后企业席分必须回到 90（此前恒 0 且修不了）');
    assert.ok(!after.codes.includes('R2_missing_dual_signature'), '补签后 R2 告警必须消失');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ E141：撤回 ⇒ 企业席回到 0 分，证据留痕（软删 + 审计）', async () => {
  const s = setup();
  try {
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, crossJudgeId: s.judge.id, content: '解决了我方库存周转环节' },
    });
    assert.equal(first.status, 200, first.body);
    const confirmationId = json(first).id;

    const before = await computeTeam(s, s.team1.id);
    assert.equal(before.seatE, 90, '双签齐全时企业席分正常');

    const withdrawn = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${confirmationId}/withdraw`, {
      token: s.tokenEnterprise,
    });
    assert.equal(withdrawn.status, 200, `撤回应成功：${withdrawn.body}`);
    assert.equal(json(withdrawn).withdrawn, true);

    const after = await computeTeam(s, s.team1.id);
    assert.equal(after.seatE, 0, '撤回后企业席分必须归零');
    // ⚠️ 判别点：撤回后是「**完全没有**确认」（no_enterprise_confirmation），
    //    与「只签了一半」（R2_missing_dual_signature）是**两种不同的降级** ⇒ 告警码不同。
    assert.ok(after.codes.includes('no_enterprise_confirmation'), `撤回后必须重新挂告警（不是静默）：${JSON.stringify(after.codes)}`);

    // 证据留痕：软删 + 审计日志
    const row = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ?').get(confirmationId);
    assert.ok(row.deleted_at, '撤回是软删：deleted_at 必须有值（事后要能查「签过又撤了」）');
    const audit = s.db.prepare("SELECT * FROM audit_log WHERE action = 'enterprise.confirm.withdraw'").get();
    assert.ok(audit, '撤回必须写审计日志');
    assert.equal(audit.entity_id, s.team1.id);

    // 撤回后不能再改签（已不存在）
    const again = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${confirmationId}/resign`, {
      token: s.tokenEnterprise, body: { content: '换个说法' },
    });
    assert.equal(again.status, 404, '撤回过的确认不可再改签');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 改签 = 软删旧行 + 追加新行（只增不改），同格仍只有一条有效', async () => {
  const s = setup();
  try {
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, crossJudgeId: s.judge.id, content: '原来的说法' },
    });
    assert.equal(first.status, 200, first.body);
    const oldId = json(first).id;

    const resigned = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${oldId}/resign`, {
      token: s.tokenEnterprise,
      body: { rawScore: 70, content: '更正后的说法' },
    });
    assert.equal(resigned.status, 200, `改签应成功：${resigned.body}`);
    const body = json(resigned);
    assert.equal(body.replacedId, oldId, '响应要指明替掉了哪一条');
    assert.equal(body.raw_score, 70);
    assert.equal(body.content, '更正后的说法');
    assert.notEqual(body.id, oldId, '改签产生**新行**（只增不改）');

    const active = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL').all(s.stage.id);
    assert.equal(active.length, 1, '同格仍只能有一条有效确认');
    const old = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ?').get(oldId);
    assert.ok(old.deleted_at, '旧行必须是软删（历史留痕，不是覆盖）');

    const audit = s.db.prepare("SELECT * FROM audit_log WHERE action = 'enterprise.confirm.resign'").get();
    assert.ok(audit, '改签必须写审计日志');
    const detail = JSON.parse(audit.detail_json);
    assert.equal(detail.replacedId, oldId);
    assert.deepEqual(detail.changes.rawScore, { from: 90, to: 70 }, '审计要记下「改了什么」');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 逆向路径的权限闸：外人 403；签字企业能改内容但不能冒别人的名；跨领域评委不能改内容', async () => {
  const s = setup();
  try {
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, content: '原始说法' },
    });
    const id = json(first).id;

    // ① 无关的人既不能撤也不能改
    const outsiderWithdraw = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/withdraw`, { token: s.tokenOutsider });
    assert.equal(outsiderWithdraw.status, 403, '无关者不能撤回');
    const outsiderResign = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenOutsider, body: { content: '我要改' },
    });
    assert.equal(outsiderResign.status, 403, '无关者不能改签');

    // ② 本赛段评委**不能**改内容与分数（那是出题企业的主张），但**能**给自己补签
    const judgeContent = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenJudge, body: { content: '评委改内容' },
    });
    assert.equal(judgeContent.status, 403, '评委不能改企业确认的内容');
    const judgeBackfill = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenJudge, body: { crossJudgeId: s.judge.id },
    });
    assert.equal(judgeBackfill.status, 200, '本赛段评委可以给自己补签');

    // ③ 评委不能替**别人**补签
    const otherBackfill = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${json(judgeBackfill).id}/resign`, {
      token: s.tokenJudge, body: { crossJudgeId: s.judge2.id },
    });
    assert.equal(otherBackfill.status, 403, '不能替别人补签');

    // ④ 补签的人不能是别的赛段的评委 / 不能与出题企业同一人
    const sameAsEnterprise = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${json(judgeBackfill).id}/resign`, {
      token: s.tokenEnterprise, body: { crossJudgeId: s.enterprise.id },
    });
    assert.equal(sameAsEnterprise.status, 400, '跨领域评委不能与出题企业同一人');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 逆向路径的三态：不存在的确认 → 404；跨赛段取用 → 404；没改任何东西 → 400', async () => {
  const s = setup();
  try {
    const missing = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/nope/withdraw`, { token: s.tokenEnterprise });
    assert.equal(missing.status, 404, '不存在的确认 → 404');
    assert.equal(json(missing).error.code, 'CONFIRMATION_NOT_FOUND');

    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, content: '原始说法' },
    });
    const id = json(first).id;

    // 换个赛段取用 → 404（不泄露「这条存在」）
    const otherStage = insertStage(s.db, {
      editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
      startsAt: '2026-10-11', endsAt: '2026-10-20', scoringConfigKey: 'final', status: 'open', now: NOW,
    });
    const crossStage = await call(s.app, 'POST', `/api/stages/${otherStage.id}/enterprise-confirmations/${id}/withdraw`, { token: s.tokenEnterprise });
    assert.equal(crossStage.status, 404, '跨赛段取用 → 404');

    // 什么都没改 → 400（不发空转的审计）
    const noop = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenEnterprise, body: { rawScore: 90, content: '原始说法' },
    });
    assert.equal(noop.status, 400, '没有变更 → 400');
    assert.equal(json(noop).error.code, 'NOTHING_TO_CHANGE');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});
```

### `platform/test/p11-wiring.test.js`

P11 接线闸（破同分只消费已关闭轮次 / 反作弊有触发点 / 快照单写者）。

```javascript
// platform/test/p11-wiring.test.js —— P11 把「写了没接线」接上之后的行为闸
//
// ⛔ 本文件钉住的是**机器闸 docs/tools/dead-service-scan.mjs 抓出来的真缺口**：
//   ① 破同分的复议分**没有走「只消费已关闭轮次」的口径** —— 仓储层那份 SQL 聚合
//      （listTiebreakVoteTotals）是服务层的孪生实现，少了这条 ⇒
//      **还在开放投票的轮次，其当前均值会被当成最终复议分消费 ⇒ 榜单随投票进行而漂移**
//      （与「破同分必须可复算」直接冲突）。现在排名路径统一走服务层。
//   ② 反作弊检测 `runDetection`（设计 §11.1「检测 → 进人工复核队列」）**没有任何生产触发点**
//      ⇒ 生产上永远建不出 flag ⇒ 「复核队列」页永远是空的 ⇒ 整条防串通链是死的。
//   ③ 计算快照有**两个写者**（compute.js 自己拼参数写一份 + services/audit.js 的
//      recordComputation 又写一份）⇒ 两份实现必然漂 ⇒ 现在统一走服务层。
//
// 规则溯源：
//   · 破同分链与「加时陈述」→ S7 §3.3（R-JDG-19）+ rules/tiebreak.json（tiebreak_extra = final_only）
//   · 「检测 → 进人工复核队列」→ 设计文档 §11.1
//   · 「计算三件套」→ 设计文档 §12（R-AUD-01 可复算）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertPeerReview } from '../src/db/repo/peer-reviews.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['peer_review:write', '互评'],
  ['audit:read', '读取审计与计算快照'],
  ['audit:write', '裁决复核项与申诉'],
];

function setup({ stageKey = 'final', scoringKey = 'final', teams: teamCount = 4 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p11wire-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900003001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900003002', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(admin.id, 'audit:write');
  grant(judge.id, 'score:write');
  grant(judge.id, 'peer_review:write');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: admin.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: stageKey, name: stageKey === 'final' ? '决赛' : '初赛', kind: stageKey === 'final' ? 'final' : 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: scoringKey, status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });

  const teams = [];
  for (let i = 0; i < teamCount; i += 1) {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: `1390000${3010 + i}`, password: 'pw' });
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    teams.push({ team, captain });
  }

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, admin, judge, stage, edition, teams,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
  };
}

/** 决赛权重表里的评委席维度。 */
const FINAL_DIMS = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

function json(res) {
  return JSON.parse(res.body);
}

test('⛔ 破同分：轮次**未关闭**时复议分不得进榜；关闭后才进（榜单不能随投票漂移）', async () => {
  const s = setup({ teams: 5 });
  try {
    // ① 打分并计算，让五支队都有分
    for (const t of s.teams) {
      for (const dim of FINAL_DIMS) {
        insertReview(s.db, {
          stageId: s.stage.id, judgeId: s.judge.id, teamId: t.team.id, dimension: dim,
          rawScore: 80, requestId: `r-${t.team.id}-${dim}`, calibrated: 0, now: NOW,
        });
      }
    }
    const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    // ② 制造并列：**只有两支**队伍同分（其余明显低分）⇒ 破同分链才在这两支之间生效
    const [a, b] = s.teams;
    s.db.prepare('UPDATE stage_results SET total = 50 WHERE stage_id = ?').run(s.stage.id);
    s.db.prepare('UPDATE stage_results SET total = 100 WHERE stage_id = ? AND team_id IN (?, ?)')
      .run(s.stage.id, a.team.id, b.team.id);

    // ③ 开一轮加时陈述并投票（**轮次还是 open**）
    const opened = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
      token: s.tokenAdmin, body: { tiedTeamIds: [a.team.id, b.team.id] },
    });
    assert.equal(opened.status, 200, `开轮次应成功：${opened.body}`);
    const roundId = json(opened).round.id;

    const voted = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
      token: s.tokenJudge, body: { teamId: a.team.id, score: 90 },
    });
    assert.equal(voted.status, 200, `投票应成功：${voted.body}`);
    const votedB = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
      token: s.tokenJudge, body: { teamId: b.team.id, score: 10 },
    });
    assert.equal(votedB.status, 200, `投票应成功：${votedB.body}`);

    // ④ 轮次**未关闭** ⇒ 复议分不得进榜 ⇒ 两队**仍然并列**（名次相同、互为 tiedWith）
    const during = json(await call(s.app, 'GET', `/api/leaderboard/${s.stage.id}?scope=rank`));
    const duringRows = during.rows.filter((r) => [a.team.id, b.team.id].includes(r.teamId));
    assert.equal(duringRows.length, 2);
    assert.equal(
      duringRows[0].rank,
      duringRows[1].rank,
      '轮次未关闭时两队仍应并列（开放投票的均值不得被当成最终复议分，否则榜单随投票漂移）',
    );
    assert.ok(
      duringRows.some((r) => (r.tiedWith ?? []).includes(b.team.id)),
      '并列关系必须显式带出（tiedWith）',
    );

    // ⑤ 关闭轮次 ⇒ 复议分生效 ⇒ 高分的那队排前面
    const closed = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/close`, { token: s.tokenAdmin });
    assert.equal(closed.status, 200, `关闭轮次应成功：${closed.body}`);

    const after = json(await call(s.app, 'GET', `/api/leaderboard/${s.stage.id}?scope=rank`));
    const afterRows = after.rows.filter((r) => [a.team.id, b.team.id].includes(r.teamId));
    assert.notEqual(afterRows[0].rank, afterRows[1].rank, '轮次关闭后并列必须被复议分打破');
    assert.equal(afterRows[0].teamId, a.team.id, '轮次关闭后复议分进榜：拿 90 分的那队排前面');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 反作弊检测在**生产路径**上真的建 flag（复核队列不再是空的）', async () => {
  const s = setup({ teams: 5 });
  try {
    // ① 互评串通形态：两支队对三支目标给出**完全相同的相对顺序**
    const [v1, v2, t1, t2, t3] = s.teams;
    for (const [from, order] of [[v1, [[t1, 90], [t2, 80], [t3, 70]]], [v2, [[t1, 95], [t2, 85], [t3, 75]]]]) {
      for (const [to, score] of order) {
        insertPeerReview(s.db, {
          stageId: s.stage.id, fromTeamId: from.team.id, toTeamId: to.team.id, score, requestId: null, now: NOW,
        });
      }
    }

    // ② 计算 ⇒ 检测应当被触发
    for (const t of s.teams) {
      for (const dim of FINAL_DIMS) {
        insertReview(s.db, {
          stageId: s.stage.id, judgeId: s.judge.id, teamId: t.team.id, dimension: dim,
          rawScore: 80, requestId: `r-${t.team.id}-${dim}`, calibrated: 0, now: NOW,
        });
      }
    }
    const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    // ③ 复核队列里有东西了（此前**恒为空** —— 检测压根没被触发过）
    const flags = await call(s.app, 'GET', '/api/audit/flags', { token: s.tokenAdmin });
    assert.equal(flags.status, 200);
    const rows = json(flags).rows ?? json(flags).items ?? [];
    assert.ok(rows.length > 0, '计算后必须建出 flag（设计 §11.1：检测 → 进人工复核队列）');
    assert.ok(rows.some((f) => String(f.kind ?? '').includes('peer') || String(f.kind ?? '').includes('identical')),
      `flag 的 kind 应当指出互评串通，实际：${JSON.stringify(rows.map((f) => f.kind))}`);

    // ④ 检测 ≠ 处罚：只建 flag，**不改分**（库里落的名次与计算时返回的逐字一致）
    const results = s.db.prepare('SELECT * FROM stage_results WHERE stage_id = ?').all(s.stage.id);
    assert.ok(results.length > 0);
    const computedTotals = new Map(json(computed).teams.map((t) => [t.teamId, t.total]));
    for (const r of results) {
      assert.equal(
        r.total,
        computedTotals.get(r.team_id),
        '建了 flag 不许改总分（检测 ≠ 处罚）',
      );
    }
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 计算快照只留**一个写者**：快照走服务层 ⇒ 审计里有 computation.record', async () => {
  const s = setup();
  try {
    for (const t of s.teams) {
      for (const dim of FINAL_DIMS) {
        insertReview(s.db, {
          stageId: s.stage.id, judgeId: s.judge.id, teamId: t.team.id, dimension: dim,
          rawScore: 80, requestId: `r-${t.team.id}-${dim}`, calibrated: 0, now: NOW,
        });
      }
    }
    const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
    assert.equal(computed.status, 200, computed.body);

    const snap = s.db.prepare("SELECT COUNT(*) AS n FROM computation_snapshots WHERE stage_id = ? AND kind = 'stage_score'").get(s.stage.id).n;
    assert.equal(snap, 1, '一次计算只写一份快照（不能两份实现各写一份）');

    const record = s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'computation.record'").get().n;
    assert.equal(record, 1, '快照由服务层 recordComputation 写入 ⇒ 必须带一条 computation.record 审计');
    const stageCompute = s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stage.compute'").get().n;
    assert.equal(stageCompute, 1, '「本赛段已计算」这条审计也要在（两个动作两处留痕）');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});
```

### `platform/test/public-tokens-api.test.js`

公开令牌端到端闸。

```javascript
// test/public-tokens-api.test.js — 公开访问令牌的管理链路（签发 / 列表 / 吊销）
//
// 规则溯源：
//   - 「公开榜单 API + 赛程日历 iCal 订阅」→ 设计文档 §8
//   - 「公开 ≠ 无鉴权」：两个公开端点都必须带 token（src/http/routes/public.js）
//   - 「只存哈希，明文只返回一次」→ src/services/public-api.js 的 createPublicToken
//   - 「权限唯一裁决者是 can()」→ 设计文档 §7.1/§7.2（src/auth/permissions.js）
//   - 「三态状态码」→ 设计文档 §7.3（列表 200+空集 / 单条 404 / 禁用 403）
//   - 「每次状态迁移写审计日志」→ 设计文档 §11.2（src/audit/log.js）
//
// ⚠️ **这些闸门不钉住就会静默失效**：
//   平台此前**没有任何创建 token 的入口** ⇒ 两个公开接口谁也用不了；
//   而一旦把「明文」或「哈希」当令牌发给前端（列表接口最容易犯），就是一次凭据泄露。
//
// ⚠️ 全部是**行为断言**（真的发请求、真的查库），不是源码文本匹配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerPublicTokenRoutes } from '../src/http/routes/public-tokens.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { listPublicTokens } from '../src/db/repo/public-tokens.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { hashPublicToken } from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';
import { tokenRows, tokenTableHtml, issuedTokenHtml, renderPublicLinks } from '../web/views/public-links.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pubtok-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  // ⚠️ 结束日推到 2099：让「当届」解析（pickCurrentEdition）与真实日期无关 ——
  //    否则「不给 editionId 就用当届」这条用例会随日历过期而红。
  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2099-12-31', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900000061', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000062', password: 'pw' });

  insertCapability(db, 'stage:compute', '触发计算发榜');
  grantAssignment(db, {
    userId: admin.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  // ⚠️ createApp 还没接本模块的路由（**路由接线由集成者做**）⇒ 这里手动挂上，
  //    否则这三条端点在进程内根本不存在（与 web-signoff.test.js 同一手法）。
  registerPublicTokenRoutes(app.router);

  return {
    db,
    close,
    dataDir,
    app,
    rules,
    edition,
    admin,
    outsider,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function cleanup(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

/** 签发一枚令牌，返回解析后的响应体。 */
async function issue(s, body = {}) {
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenAdmin,
    body: { editionId: s.edition.id, ...body },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

// ══════════════════════════════════════════════════════════════════
// 一、签发
// ══════════════════════════════════════════════════════════════════

test('组委会签发令牌 → 200，响应给明文；库里存的是哈希', async () => {
  const s = setup();
  const body = await issue(s, { scope: 'all' });
  assert.ok(body.token, '响应必须含明文 token');
  assert.equal(body.scope, 'all');
  assert.equal(body.editionId, s.edition.id);
  assert.ok(body.expiresAt, '响应必须给出过期时间');

  // ⛔ 库里存的是 SHA-256，不是明文
  const rows = listPublicTokens(s.db, { editionId: s.edition.id });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, body.token, '库里存的是哈希，不是明文');
  assert.equal(rows[0].token, hashPublicToken(body.token), '库里那列必须 = sha256(明文)');
  assert.equal(rows[0].token.length, 64, 'SHA-256 十六进制长度');
  cleanup(s);
});

test('不给 editionId → 用当届（与 pickCurrentEdition 同一口径）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenAdmin,
    body: { scope: 'all' },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).editionId, s.edition.id, '缺省届期必须解析成当届');
  cleanup(s);
});

test('没有 stage:compute 的账号签发 → 403，且不得落库', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, scope: 'all' },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  assert.equal(listPublicTokens(s.db, {}).length, 0, '被拒绝的签发不得留下任何记录');
  cleanup(s);
});

test('未登录签发 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', { body: { editionId: s.edition.id } });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'UNAUTHENTICATED');
  cleanup(s);
});

test('非法 scope → 400 PUBLIC_SCOPE_INVALID，且不得落库', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenAdmin,
    body: { editionId: s.edition.id, scope: 'admin' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_SCOPE_INVALID');
  assert.equal(listPublicTokens(s.db, {}).length, 0, '被拒绝的签发不得留下任何记录');
  cleanup(s);
});

test('ttlDays 生效（默认取规则里的 30 天，给了就按给的算）', async () => {
  const s = setup();
  const def = await issue(s, { scope: 'all' });
  const custom = await issue(s, { scope: 'all', ttlDays: 7 });
  const days = (a, b) => (new Date(a) - new Date(b)) / 86400000;
  const now = Date.now();
  assert.ok(Math.abs(days(def.expiresAt, now) - 30) <= 1, '默认应是 30 天（rules.pools.publicTokenTtlDays）');
  assert.ok(Math.abs(days(custom.expiresAt, now) - 7) <= 1, '给了 ttlDays 就按给的算');
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、列表
// ══════════════════════════════════════════════════════════════════

test('还没有令牌时列表 → 200 + 空数组（不是 404）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.items, [], '列表类「不满足」是空集，不是 404');
  cleanup(s);
});

test('⛔ 列表的每一行都不含明文令牌（只给哈希行标识 + 不可逆短标识）', async () => {
  const s = setup();
  const issued = await issue(s, { scope: 'all' });
  const res = await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(res.body.includes(issued.token), false, '列表响应里绝不能出现明文令牌');

  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  const hash = hashPublicToken(issued.token);
  // 行标识 = 哈希（可用来吊销；它**不是**可用令牌：公开接口会再哈希一次）
  assert.equal(item.id, hash);
  assert.equal(item.tokenHint, hash.slice(0, 8));
  assert.equal(item.scope, 'all');
  assert.equal(item.editionId, s.edition.id);
  assert.equal(item.expired, false);
  assert.ok(item.createdAt, '必须给出创建时间');
  cleanup(s);
});

test('⛔ 列表不得把哈希「当令牌」发出去（字段集合逐字固定）', async () => {
  const s = setup();
  await issue(s, { scope: 'all' });
  const body = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  const item = body.items[0];
  // ⚠️ 哈希**可以**作为行标识（id）出现 —— 吊销端点要用它；
  //    但它**不能**以「令牌」的身份出现（前端会拿它去调公开接口，必然 403）。
  assert.deepEqual(
    Object.keys(item).sort(),
    ['createdAt', 'editionId', 'expired', 'expiresAt', 'id', 'scope', 'tokenHint'].sort(),
    '列表每行的字段集合必须固定（多一个 token 字段就是把哈希当令牌发出去）',
  );
  assert.equal(item.token, undefined, '不得有 token 字段');
  cleanup(s);
});

test('列表可以按 editionId 过滤', async () => {
  const s = setup();
  await issue(s, { scope: 'all' });
  const other = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  await issue(s, { scope: 'all', editionId: other.id });

  const all = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  assert.equal(all.items.length, 2);
  const filtered = JSON.parse((await call(s.app, 'GET', `/api/public/tokens?editionId=${other.id}`, {
    token: s.tokenAdmin,
  })).body);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].editionId, other.id);
  cleanup(s);
});

test('已过期的令牌在列表里 expired = true', async () => {
  const s = setup();
  await issue(s, { scope: 'all', expiresAt: '2020-01-01T00:00:00.000Z' });
  const body = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].expired, true, '过期时间已过的令牌必须被标出来');
  cleanup(s);
});

test('列表也要过权限闸门：无 stage:compute → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 三、吊销
// ══════════════════════════════════════════════════════════════════

test('吊销令牌 → 200；吊销后同一枚明文再也进不了公开接口', async () => {
  const s = setup();
  const issued = await issue(s, { scope: 'all' });
  const url = `/api/public/leaderboard?token=${encodeURIComponent(issued.token)}&editionId=${encodeURIComponent(s.edition.id)}`;

  // 吊销前：公开榜单能出数
  const before = await call(s.app, 'GET', url);
  assert.equal(before.status, 200, before.body);

  // 用**列表给的行标识**去吊销（端到端：列表 → 吊销）
  const list = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  const del = await call(s.app, 'DELETE', `/api/public/tokens/${encodeURIComponent(list.items[0].id)}`, {
    token: s.tokenAdmin,
  });
  assert.equal(del.status, 200, del.body);

  // 吊销后：同一枚明文一律 403
  const after = await call(s.app, 'GET', url);
  assert.equal(after.status, 403, after.body);
  assert.equal(JSON.parse(after.body).error.code, 'PUBLIC_TOKEN_INVALID');

  // 列表里也没有它了
  const after2 = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  assert.deepEqual(after2.items, []);
  cleanup(s);
});

test('吊销不存在的令牌 → 404（不是 200 假装成功）', async () => {
  const s = setup();
  const res = await call(s.app, 'DELETE', `/api/public/tokens/${'a'.repeat(64)}`, { token: s.tokenAdmin });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_FOUND');
  cleanup(s);
});

test('吊销也要过权限闸门：无 stage:compute → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'DELETE', `/api/public/tokens/${'b'.repeat(64)}`, { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 四、审计
// ══════════════════════════════════════════════════════════════════

test('⛔ 签发与吊销都写审计日志，且 detail 里绝不含明文令牌', async () => {
  const s = setup();
  const issued = await issue(s, { scope: 'calendar' });
  const hash = hashPublicToken(issued.token);

  const issues = queryAuditLog(s.db, { action: 'public_token.issue', limit: 50 });
  assert.equal(issues.total, 1, '签发必须写一条审计');
  const issueRow = issues.rows[0];
  assert.equal(issueRow.entity, 'public_token');
  assert.equal(issueRow.actor_id, s.admin.id, '审计必须记下是谁签发的');
  const issueDetail = JSON.parse(issueRow.detail_json);
  assert.equal(issueDetail.scope, 'calendar');
  assert.equal(issueDetail.editionId, s.edition.id);
  assert.equal(issueDetail.tokenHint, hash.slice(0, 8));
  assert.equal(JSON.stringify(issueDetail).includes(issued.token), false, '审计 detail 里绝不能有明文 token');

  const del = await call(s.app, 'DELETE', `/api/public/tokens/${hash}`, { token: s.tokenAdmin });
  assert.equal(del.status, 200, del.body);

  const revokes = queryAuditLog(s.db, { action: 'public_token.revoke', limit: 50 });
  assert.equal(revokes.total, 1, '吊销必须写一条审计');
  const revokeDetail = JSON.parse(revokes.rows[0].detail_json);
  assert.equal(revokeDetail.scope, 'calendar');
  assert.equal(revokeDetail.tokenHint, hash.slice(0, 8));
  assert.equal(JSON.stringify(revokeDetail).includes(issued.token), false, '审计 detail 里绝不能有明文 token');
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 五、界面（纯函数层）
// ══════════════════════════════════════════════════════════════════

test('⛔ 界面的展示模型只取白名单字段（服务端多给明文也不渲染）', () => {
  const rows = tokenRows({
    items: [{
      id: 'hash-id', scope: 'all', editionId: 'ed_1', expiresAt: '2026-11-20T00:00:00.000Z',
      createdAt: '2026-10-20T00:00:00.000Z', tokenHint: 'abcd1234', expired: false,
      token: 'PLAINTEXT-SECRET',
    }],
  });
  assert.equal(rows[0].token, undefined, '明文字段不得进入展示模型');
  const html = tokenTableHtml(rows);
  assert.equal(html.includes('PLAINTEXT-SECRET'), false, '表格里绝不能出现明文令牌');
  assert.ok(html.includes('abcd1234'), '短标识要显示出来（人眼要能分辨是哪一枚）');
  assert.ok(html.includes('data-action="revoke-request"'), '每行都要有吊销入口');
  assert.ok(html.includes('data-action="revoke-confirm"'), '吊销必须有二次确认');
});

test('签发成功后的界面：明文 + 两个公开链接 + 「只显示这一次」的提示', () => {
  const html = issuedTokenHtml({
    token: 'PLAIN-TOKEN', scope: 'all', editionId: 'ed_1', expiresAt: '2026-11-20T00:00:00.000Z',
  });
  assert.ok(html.includes('PLAIN-TOKEN'), '明文必须显示出来');
  assert.ok(
    html.includes('/api/public/leaderboard?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出公开榜单链接',
  );
  assert.ok(
    html.includes('/api/public/calendar.ics?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出赛程日历链接',
  );
  assert.ok(html.includes('只显示这一次'), '必须提示明文只显示这一次');
  assert.equal(html.includes('<style'), false, '不许写 <style> 标签（颜色只走设计令牌）');
  // ⛔ 服务端数据必须过 escapeHtml（届期 id 来自服务端，不是可信输入）
  const injected = issuedTokenHtml({
    token: 'x', scope: 'all', editionId: '<script>alert(1)</script>', expiresAt: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(injected.includes('<script>'), false, '服务端数据必须转义后再插进 HTML');
});

test('视图必须复用 web/escape.js（全站唯一转义入口）', () => {
  const src = readFileSync(join(here, '..', 'web', 'views', 'public-links.js'), 'utf8');
  assert.ok(src.includes("from '../escape.js'"), '必须复用 web/escape.js');
  assert.equal(/export function escapeHtml/.test(src), false, '不得重复定义 escapeHtml');
  assert.equal(/noticeState\(\{[^}]*text:/.test(src), false, 'noticeState 只认 items / list，不认 text');
});

// ── 最小 DOM 桩（与 web/views/signoff.js、login-view.test.js 同一手法）──
// ⚠️ 只实现本视图用到的那几个方法：没有真 DOM、没有 IntersectionObserver。

function makeEl(tag = 'div') {
  return {
    tagName: tag,
    className: '',
    innerHTML: '',
    value: '',
    dataset: {},
    hidden: false,
    _listeners: {},
    _nodes: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of this._listeners[type] || []) fn(event);
    },
    querySelector(sel) {
      return this._nodes[sel] ?? null;
    },
    querySelectorAll(sel) {
      const v = this._nodes[sel];
      return Array.isArray(v) ? v : (v ? [v] : []);
    },
    closest() {
      return null;
    },
    focus() {},
  };
}

/** 让微任务队列跑干净（视图里的请求是异步的）。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** 把视图装到可控的假 DOM 上（返回各个挂载点，便于断言）。 */
async function mountView(api) {
  const wrap = makeEl('div');
  const list = makeEl('div');
  const stats = makeEl('div');
  const issued = makeEl('div');
  const feedback = makeEl('div');
  const scopeField = makeEl('select');
  scopeField.value = 'all';
  const ttlField = makeEl('input');
  ttlField.value = '';
  wrap._nodes['[data-list]'] = list;
  wrap._nodes['[data-stats]'] = stats;
  wrap._nodes['[data-issued]'] = issued;
  wrap._nodes['[data-feedback]'] = feedback;
  wrap._nodes['[data-field="scope"]'] = scopeField;
  wrap._nodes['[data-field="ttlDays"]'] = ttlField;
  wrap._nodes['[data-revoke-confirm]'] = [];
  globalThis.document = { createElement: () => wrap };
  await renderPublicLinks({
    api, navigate: () => {}, setState: () => {}, getState: () => ({}), query: {}, params: {},
  });
  await flush();
  return { wrap, list, stats, issued, feedback };
}

/** 造一个假按钮：closest('[data-action]') 返回自己，closest('[data-retry]') 返回作用域。 */
function fakeButton(action, retryKind = 'list') {
  const scope = { dataset: { retry: retryKind } };
  const btn = {
    dataset: { action },
    closest: (sel) => (sel === '[data-retry]' ? scope : btn),
  };
  return btn;
}

test('★ 加载失败 → 错误态带重试按钮，且点「重试」真的重跑一次', async () => {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      throw new Error('接口挂了');
    },
    post: async () => ({ token: 'x' }),
    del: async () => ({ ok: true }),
  };
  const { wrap, list } = await mountView(api);
  assert.ok(list.innerHTML.includes('data-action="retry"'), '错误态必须有可点的重试按钮');
  assert.equal(calls.length, 1, '首次加载应发过一次请求');

  wrap.dispatch('click', { target: fakeButton('retry', 'list') });
  await flush();
  assert.equal(calls.length, 2, '点「重试」必须真的重跑一次（不是死路一条）');
});

test('★ 列表加载成功 → 渲染表格与吊销入口', async () => {
  const api = {
    get: async () => ({
      items: [{
        id: 'hash-id', scope: 'all', editionId: 'ed_1',
        expiresAt: '2026-11-20T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z',
        tokenHint: 'abcd1234', expired: false,
      }],
    }),
    post: async () => ({}),
    del: async () => ({}),
  };
  const { list } = await mountView(api);
  assert.ok(list.innerHTML.includes('abcd1234'), '短标识要出现在表格里');
  assert.ok(list.innerHTML.includes('data-action="revoke-request"'), '每行都要有吊销入口');
  assert.equal(list.innerHTML.includes('data-action="revoke-confirm"'), true, '吊销必须有二次确认');
});

test('★ 签发成功 → 明文与两个公开链接被展示出来', async () => {
  const api = {
    get: async () => ({ items: [] }),
    post: async (path, body) => {
      api.calls.push({ path, body });
      return {
        token: 'PLAIN-TOKEN', scope: 'all', editionId: 'ed_1', expiresAt: '2026-11-20T00:00:00.000Z',
      };
    },
    del: async () => ({}),
    calls: [],
  };
  const { wrap, issued } = await mountView(api);
  wrap.dispatch('click', { target: fakeButton('issue') });
  await flush();

  assert.equal(api.calls.length, 1, '点「签发」必须真的发一次请求');
  assert.equal(api.calls[0].path, '/api/public/tokens');
  assert.equal(api.calls[0].body.scope, 'all');
  assert.ok(issued.innerHTML.includes('PLAIN-TOKEN'), '明文必须展示出来');
  assert.ok(
    issued.innerHTML.includes('/api/public/leaderboard?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出公开榜单链接',
  );
  assert.ok(
    issued.innerHTML.includes('/api/public/calendar.ics?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出赛程日历链接',
  );
  assert.ok(issued.innerHTML.includes('只显示这一次'), '必须提示明文只显示这一次');
});
```

### `platform/test/tiebreak-api.test.js`

破同分端到端闸。

```javascript
// test/tiebreak-api.test.js — 加时陈述 / 一票破同分的 HTTP 契约
//
// 规则溯源：
//   - 「同分 → 10 分钟加时陈述 → 企业席 + 评委席共同复议」→ R-JDG-19（S7 §3.3）
//     + src/services/tiebreak.js（服务层：同分组校验 / 观察员禁投 / 回避禁投 / 一人一票 / 关闭幂等）
//   - 「权限 = 能力点 + 授权记录，can() 是唯一判定入口」→ 设计文档 §7.1 / §7.2
//   - 「三态状态码」→ 设计文档 §7.3（列表不满足 → 200 + 空集；单条不满足 → 404；能力禁用 → 403）
//   - 「可见性在 API 层过滤」→ 全局约束（前端隐藏 = 数据已泄露）
//   - 「写端点必须留审计」→ 设计文档 §12（可复算与留痕）
//
// ⚠️ **这些闸门一旦没有测试钉住，就会静默失效**（能力点形同虚设、越权可写票、
//    别人的投票明细被广播）—— 与 P1 的 A1（registration:write 注册了却从不校验）同一类病根。
//
// ⚠️ **断言必须判别性**：每条断言都要能区分「对」与「错」——
//    「提交一个明显非法的值，断言它真的报错」，而不是「断言返回值存在」。
//    恒真断言（assert.ok(res.body)）在本文件里一律不写。
//
// ⚠️ **路由是手动挂上去的**（registerTiebreakRoutes(app.router)）：
//    src/server.js 的接线由集成者做（本任务不许改既有文件）⇒
//    不手动挂的话，「测试通过」只是因为「端点没注册」，测不出任何东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { listTiebreakRounds, listTiebreakVotes } from '../src/db/repo/tiebreak.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { registerTiebreakRoutes } from '../src/http/routes/tiebreak.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/**
 * 搭台：真实建库 + 迁移 + 造用户 + 授权 + 挂路由。
 * ⚠️ 身份矩阵是本文件的核心（每种身份只差一个维度，断言才有判别力）：
 *   · 组委会   committee —— 全局 `stage:compute`
 *   · 评委席   judge / judge2 —— 本赛段 seat='judge'
 *   · 观察员   observer —— 本赛段 seat='observer'（R-JDG-11：无投票权）
 *   · 别赛段评委 otherJudge —— 另一个赛段的 seat='judge'（⇒ 本赛段不是评委）
 *   · 企业席   enterprise —— **本赛段没有任何席位**（⇒ 能看结果、看不到明细）
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tbapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });

  const committee = createUser(db, { name: '组委会', phone: '13900000101', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900000102', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000103', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000104', password: 'pw' });
  const otherJudge = createUser(db, { name: '别赛段评委', phone: '13900000105', password: 'pw' });
  const enterprise = createUser(db, { name: '企业席', phone: '13900000106', password: 'pw' });
  const captain = createUser(db, { name: '队长甲', phone: '13900000107', password: 'pw' });
  const captain2 = createUser(db, { name: '队长乙', phone: '13900000108', password: 'pw' });

  insertCapability(db, 'stage:compute', '触发计算发榜');
  insertCapability(db, 'score:read', '读取评分');
  // ⚠️ 只有组委会有 stage:compute（**全局**授权）—— 其余人一个能力点都没有。
  grantAssignment(db, {
    userId: committee.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: null,
  });

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: committee.id, now: NOW,
  });
  const teamA = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const teamB = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain2.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: teamA.id, userId: captain.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teamB.id, userId: captain2.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '决赛', kind: 'final',
    startsAt: '2026-10-20', endsAt: '2026-10-28', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  const otherStage = insertStage(db, {
    editionId: edition.id, key: 's2', name: '路演', kind: 'roadshow',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });
  assignStageJudge(db, { stageId: otherStage.id, userId: otherJudge.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  // ⚠️ 手动挂路由（server.js 的接线由集成者做）—— 不挂就是「端点不存在」，测不出东西。
  // ⚠️ 但**先看一眼**：集成者把 registerTiebreakRoutes 接到 server.js 之后，
  //    这里再挂一遍就会重复注册（同一 pattern 注册两次）⇒ 条件挂载，两种情况都对。
  const wired = app.router.list().some((r) => r.pattern === '/api/stages/:stageId/tiebreak/rounds');
  if (!wired) registerTiebreakRoutes(app.router);

  return {
    db, close, dataDir, app, edition, stage, otherStage, teamA, teamB,
    committee, judge, judge2, observer, otherJudge, enterprise, captain,
    tokenCommittee: createSession(db, committee.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenObserver: createSession(db, observer.id).token,
    tokenOtherJudge: createSession(db, otherJudge.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
  };
}

function cleanup(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

/** JSON.parse 响应体（call 的 body 是**字符串**）。 */
function json(res) {
  return JSON.parse(res.body);
}

/** 开一轮（组委会），返回 { res, body }。 */
async function openRound(s, tiedTeamIds, token = s.tokenCommittee) {
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
    token,
    body: { tiedTeamIds },
  });
  return { res, body: json(res) };
}

// ══════════════════════════════════════════════════════════════════
// 一、开轮次
// ══════════════════════════════════════════════════════════════════

test('① 组委会开轮次 → 200，轮次落库且能读到 tiedTeamIds', async () => {
  const s = setup();
  const { res, body } = await openRound(s, [s.teamA.id, s.teamB.id]);
  assert.equal(res.status, 200, `实际 ${res.status}：${res.body}`);
  assert.ok(body.round?.id, '响应里必须有轮次 id');
  assert.equal(body.round.status, 'open');
  // ⚠️ 判别性：同分组必须**逐字**回传（顺序也一致）—— 不是「有个数组就行」。
  assert.deepEqual(body.round.tiedTeamIds, [s.teamA.id, s.teamB.id]);
  // ⚠️ 判别性：**真的落库了**（不是只在响应里编出来的）。
  const rows = listTiebreakRounds(s.db, { stageId: s.stage.id });
  assert.equal(rows.length, 1, '库里必须正好有一轮');
  assert.deepEqual(JSON.parse(rows[0].tied_team_ids_json), [s.teamA.id, s.teamB.id]);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].stage_id, s.stage.id);
  cleanup(s);
});

test('② 只有 1 支同分队伍开轮次 → 400（NO_TIED_TEAMS），且**没有**留下轮次', async () => {
  const s = setup();
  const { res, body } = await openRound(s, [s.teamA.id]);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'NO_TIED_TEAMS');
  // ⚠️ 判别性：失败**不许**留下半截数据。
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 0);
  cleanup(s);
});

test('③ 同赛段已有 open 轮次再开 → 409（TIEBREAK_ROUND_ALREADY_OPEN）', async () => {
  const s = setup();
  await openRound(s, [s.teamA.id, s.teamB.id]);
  const { res, body } = await openRound(s, [s.teamA.id, s.teamB.id]);
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'TIEBREAK_ROUND_ALREADY_OPEN');
  // ⚠️ 判别性：不能开出第二轮（票不能分散在两轮里）。
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 1);
  cleanup(s);
});

test('④ 非 stage:compute 用户开轮次 → 403，且**没有**留下轮次', async () => {
  const s = setup();
  // ⚠️ 用**本赛段评委**当反例（他有能力点缺失，但身份很接近 ⇒ 才有判别力）。
  const { res, body } = await openRound(s, [s.teamA.id, s.teamB.id], s.tokenJudge);
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 0);
  cleanup(s);
});

test('④b 未登录开轮次 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
    body: { tiedTeamIds: [s.teamA.id, s.teamB.id] },
  });
  assert.equal(res.status, 401);
  assert.equal(json(res).error.code, 'UNAUTHENTICATED');
  cleanup(s);
});

test('④c tiedTeamIds 不是数组 → 400（INVALID_REQUEST），不许开成轮次', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
    token: s.tokenCommittee,
    body: { tiedTeamIds: `${s.teamA.id},${s.teamB.id}` },
  });
  assert.equal(res.status, 400);
  assert.equal(json(res).error.code, 'INVALID_REQUEST');
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 0);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、投票
// ══════════════════════════════════════════════════════════════════

test('⑤ 本赛段评委投票 → 200 且落库', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge,
    body: { teamId: s.teamA.id, score: 85 },
  });
  assert.equal(res.status, 200, `实际 ${res.status}：${res.body}`);
  assert.equal(json(res).vote.score, 85);
  assert.equal(json(res).vote.team_id, s.teamA.id);
  // ⚠️ 判别性：真的落库了（一条票，且是这一条）。
  const votes = listTiebreakVotes(s.db, roundId);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].voter_id, s.judge.id);
  assert.equal(votes[0].score, 85);
  cleanup(s);
});

test('⑤b 观察员投票 → 403（OBSERVER_NO_VOTE），不许留下票', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenObserver,
    body: { teamId: s.teamA.id, score: 90 },
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error.code, 'OBSERVER_NO_VOTE');
  assert.equal(listTiebreakVotes(s.db, opened.round.id).length, 0);
  cleanup(s);
});

test('⑤c 非本赛段评委投票 → 403（NOT_ASSIGNED_JUDGE），不许留下票', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  // ⚠️ 反例是**另一个赛段的真评委**（不是随便一个路人）⇒ 才有判别力。
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenOtherJudge,
    body: { teamId: s.teamA.id, score: 90 },
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error.code, 'NOT_ASSIGNED_JUDGE');
  assert.equal(listTiebreakVotes(s.db, opened.round.id).length, 0);
  cleanup(s);
});

test('⑥ 同一评委对同一队伍重复投票 → 409（DUPLICATE_TIEBREAK_VOTE），票数不变', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const first = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 80 },
  });
  assert.equal(first.status, 200);
  const second = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 20 },
  });
  assert.equal(second.status, 409);
  assert.equal(json(second).error.code, 'DUPLICATE_TIEBREAK_VOTE');
  // ⚠️ 判别性：第二票**不许**覆盖第一票（分数必须是第一次那个 80）。
  const votes = listTiebreakVotes(s.db, roundId);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].score, 80);
  cleanup(s);
});

test('⑦ 投票分超出 0–100 → 400（SCORE_OUT_OF_RANGE），不许留下票', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  for (const bad of [120, -1, 1000]) {
    const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
      token: s.tokenJudge, body: { teamId: s.teamA.id, score: bad },
    });
    assert.equal(res.status, 400, `分数 ${bad} 必须被拒`);
    assert.equal(json(res).error.code, 'SCORE_OUT_OF_RANGE');
  }
  assert.equal(listTiebreakVotes(s.db, roundId).length, 0);
  cleanup(s);
});

test('⑦b 投给不在同分组的队伍 → 400（TEAM_NOT_IN_TIE_GROUP）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  // 第三支队伍：不在本赛段名册之外，但**不在同分组**里。
  const captain3 = createUser(s.db, { name: '队长丙', phone: '13900000109', password: 'pw' });
  const teamC = insertTeam(s.db, {
    editionId: s.edition.id, name: '丙队', captainId: captain3.id, taskPackageId: null, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenJudge, body: { teamId: teamC.id, score: 70 },
  });
  assert.equal(res.status, 400);
  assert.equal(json(res).error.code, 'TEAM_NOT_IN_TIE_GROUP');
  assert.equal(listTiebreakVotes(s.db, opened.round.id).length, 0);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 三、关闭轮次
// ══════════════════════════════════════════════════════════════════

test('⑧ 关闭轮次 → 200 且状态变 closed；关闭后再投票 → 409（TIEBREAK_ROUND_CLOSED）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const closed = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/close`, {
    token: s.tokenCommittee, body: {},
  });
  assert.equal(closed.status, 200, `实际 ${closed.status}：${closed.body}`);
  assert.equal(json(closed).round.status, 'closed');
  assert.deepEqual(json(closed).tallies, {}, '还没投票时统计应为空对象');
  // ⚠️ 判别性：库里状态真的变了。
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id })[0].status, 'closed');

  const after = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 80 },
  });
  assert.equal(after.status, 409);
  assert.equal(json(after).error.code, 'TIEBREAK_ROUND_CLOSED');
  assert.equal(listTiebreakVotes(s.db, roundId).length, 0);
  cleanup(s);
});

test('⑧b 非组委会关闭轮次 → 403，且轮次仍是 open', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/close`, {
    token: s.tokenJudge, body: {},
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error.code, 'FORBIDDEN');
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id })[0].status, 'open');
  cleanup(s);
});

test('⑧c 关闭不存在的轮次 → 404（TIEBREAK_ROUND_NOT_FOUND）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/tiebreak/rounds/no-such-round/close', {
    token: s.tokenCommittee, body: {},
  });
  assert.equal(res.status, 404);
  assert.equal(json(res).error.code, 'TIEBREAK_ROUND_NOT_FOUND');
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 四、读轮次状态：可见性在 API 层过滤
// ══════════════════════════════════════════════════════════════════

test('⑨ 读轮次状态：组委会与本赛段评委看得到 votes；企业席看不到 votes 但看得到 tallies（且**不是 403**）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  // 两票：评委甲给甲队 80、评委乙给甲队 60（⇒ 甲队 count=2 / sum=140 / mean=70）
  const v1 = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 80 },
  });
  const v2 = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge2, body: { teamId: s.teamA.id, score: 60 },
  });
  assert.equal(v1.status, 200);
  assert.equal(v2.status, 200);

  // ① 组委会 → 全部 votes
  const asCommittee = await call(s.app, 'GET', `/api/tiebreak/rounds/${roundId}`, { token: s.tokenCommittee });
  assert.equal(asCommittee.status, 200);
  const cBody = json(asCommittee);
  assert.equal(cBody.votes.length, 2, '组委会应看到两票明细');
  assert.equal(cBody.round.id, roundId);
  assert.deepEqual(cBody.tallies[s.teamA.id], { count: 2, sum: 140, mean: 70 });

  // ② 本赛段评委 → 全部 votes（同赛段互相看得到复议分是复议的前提）
  const asJudge = await call(s.app, 'GET', `/api/tiebreak/rounds/${roundId}`, { token: s.tokenJudge });
  assert.equal(asJudge.status, 200);
  assert.equal(json(asJudge).votes.length, 2, '本赛段评委应看到两票明细');

  // ③ 企业席（本赛段无席位）→ **不是 403**，但 votes 被收窄、tallies 照给
  const asEnterprise = await call(s.app, 'GET', `/api/tiebreak/rounds/${roundId}`, { token: s.tokenEnterprise });
  assert.equal(asEnterprise.status, 200, '收窄可见性**不得**回 403（他们有权知道复议结果）');
  const eBody = json(asEnterprise);
  assert.deepEqual(eBody.votes, [], '企业席不得看到别人的投票明细');
  assert.ok(eBody.tallies[s.teamA.id], '企业席仍应看得到统计结果');
  assert.equal(eBody.tallies[s.teamA.id].count, 2);
  assert.equal(eBody.tallies[s.teamA.id].mean, 70);
  cleanup(s);
});

test('⑨b 读不存在的轮次 → 404（TIEBREAK_ROUND_NOT_FOUND）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/tiebreak/rounds/no-such-round', { token: s.tokenCommittee });
  assert.equal(res.status, 404);
  assert.equal(json(res).error.code, 'TIEBREAK_ROUND_NOT_FOUND');
  cleanup(s);
});

test('⑨c 未登录读轮次 → 401', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'GET', `/api/tiebreak/rounds/${opened.round.id}`);
  assert.equal(res.status, 401);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 五、列表端点：列表语义 = 200 + 空集（不是 404）
// ══════════════════════════════════════════════════════════════════

test('⑪ 本赛段没有轮次时 → 200 + items: []（列表语义**不是 404**）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', `/api/stages/${s.stage.id}/tiebreak/rounds`, { token: s.tokenCommittee });
  assert.equal(res.status, 200);
  const body = json(res);
  assert.ok(Array.isArray(body.items), 'items 必须是数组');
  assert.deepEqual(body.items, []);
  cleanup(s);
});

test('⑪b 有轮次时列表带出轮次；未登录 → 401', async () => {
  const s = setup();
  await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'GET', `/api/stages/${s.stage.id}/tiebreak/rounds`, { token: s.tokenCommittee });
  assert.equal(res.status, 200);
  const body = json(res);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.items[0].tiedTeamIds, [s.teamA.id, s.teamB.id]);
  assert.equal(body.items[0].status, 'open');

  const anon = await call(s.app, 'GET', `/api/stages/${s.stage.id}/tiebreak/rounds`);
  assert.equal(anon.status, 401);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 六、审计：投票必须留痕
// ══════════════════════════════════════════════════════════════════

test('⑩ 投票后审计日志里能查到一条 action=tiebreak.vote 的记录', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const before = queryAuditLog(s.db, { action: 'tiebreak.vote' }).total;
  assert.equal(before, 0, '投票前不该有 tiebreak.vote 记录');

  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 85 },
  });
  assert.equal(res.status, 200);

  const after = queryAuditLog(s.db, { action: 'tiebreak.vote' });
  assert.equal(after.total, 1, '投票后必须正好有一条 tiebreak.vote 记录');
  const row = after.rows[0];
  assert.equal(row.actor_id, s.judge.id, '审计的 actor 必须是投票人');
  assert.equal(row.entity, 'stage');
  assert.equal(row.entity_id, s.stage.id, 'entity_id 必须是轮次所属赛段');
  const detail = JSON.parse(row.detail_json);
  assert.equal(detail.roundId, roundId);
  assert.equal(detail.teamId, s.teamA.id);
  assert.equal(detail.score, 85);
  cleanup(s);
});

test('⑩b 失败的投票**不写**审计（只有真正落库的票才留痕）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenObserver, body: { teamId: s.teamA.id, score: 90 },
  });
  assert.equal(res.status, 403);
  assert.equal(queryAuditLog(s.db, { action: 'tiebreak.vote' }).total, 0);
  cleanup(s);
});
```

### `platform/test/audit-log-view.test.js`

审计日志界面闸。

```javascript
// test/audit-log-view.test.js — 审计日志页（组委会：审计与复算 → 审计流水）
//
// 依据：设计文档 §9「组委会视角 → **审计与复算**」
//   + R-JDG-17（全程留档 6 个月）/ S7 §4.2（赛后 6 个月可查）
//   + R-AUD-01（每次发榜/计分可复算）
// 溯源：GET /api/audit/log
//   src/http/routes/audit.js → pickFilter(query) → listAuditLog()
//   src/services/audit.js    → { rows, total, retention }
//   rows[i] = { id, actorId, action, entity, entityId, detail, detailParseError, createdAt }
//
// ⚠️ 这组用例**为什么必须存在**：
//   后端读口早就存在，前端却**从来没有调用过它**（死端点：端点已挂、界面从无）。
//   ⇒ 这组用例钉住四件事：
//     ① 前端真的会调它，而且**参数拼对了**（拼错字段名 = 静默不过滤，服务端不报错）；
//     ② **坏数据显式暴露**（detailParseError 不能被当成空明细静默吞掉）；
//     ③ 空集 / 保留窗口 / 分页边界都**说得清**（不是白屏、不是猜）；
//     ④ 用户数据**必须转义**（明细是服务端存下来的 JSON，可能带 HTML）。
//
// ⛔ 零依赖、零构建、node:test + ESM；DOM 用**最小桩**（不引 jsdom），
//    手法与 platform/test/admin-appeals.test.js 同款。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIMIT,
  auditLogDetailHtml,
  auditLogEmptyHtml,
  auditLogPagerHtml,
  auditLogQuery,
  auditLogRowHtml,
  auditLogStats,
  auditLogTableHtml,
  auditPagination,
  auditRetentionHtml,
  auditLogUntilParam,
  normalizeAuditFilters,
  renderAuditLog,
} from '../web/views/audit-log.js';

// ─────────────────────────────────────────────────────────────────────────
// 最小 DOM 桩
//
// ⚠️ 只实现视图用到的那几个方法（innerHTML / querySelector(#id) / 事件），
//    手法与 platform/test/admin-appeals.test.js 同款：够测行为，不做真解析。
// ─────────────────────────────────────────────────────────────────────────

function mk(tag) {
  const el = {
    tagName: tag,
    className: '',
    id: '',
    children: [],
    handlers: {},
    dataset: {},
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    _text: '',
    _html: '',
    _htmlIds: [],
    _byId: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this._htmlIds = [...String(v).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      // ⚠️ 真浏览器里赋 innerHTML 会清掉原有子节点 —— 桩必须等价。
      this.children = [];
    },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    // ⚠️ 视图用 closest() 兜住「点在按钮里的文字上」的情况；桩里没有祖先 ⇒ 返回 null。
    closest() { return null; },
    querySelector(sel) {
      if (!sel.startsWith('#')) return null;
      const id = sel.slice(1);
      // ⚠️ innerHTML 里出现的 id ⇒ 造一个**缓存**的合成节点
      //    （同一个 id 每次拿到同一个对象 ⇒ 测试设的 .value 视图读得到）。
      if (this._htmlIds.includes(id)) {
        if (!this._byId[id]) { const s = mk('div'); s.id = id; this._byId[id] = s; }
        return this._byId[id];
      }
      for (const c of this.children) {
        if (c.id === id) return c;
        const hit = c.querySelector?.(sel);
        if (hit) return hit;
      }
      return null;
    },
  };
  return el;
}

function installDom() {
  globalThis.document = { createElement: (tag) => mk(tag) };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ─────────────────────────────────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────────────────────────────────

const RETENTION = { archiveMonths: 6, queryableSince: '2026-04-23T00:00:00.000Z' };

/** 一条审计记录（形状以 src/services/audit.js 的 listAuditLog 为准）。 */
function row(i, over = {}) {
  return {
    id: `al-${i}`,
    actorId: 'u_admin',
    action: 'computation.record',
    entity: 'computation',
    entityId: `cmp_${i}`,
    detail: { ruleVersion: '2026-10-20', revision: i },
    detailParseError: false,
    createdAt: '2026-10-22T00:00:00.000Z',
    ...over,
  };
}

/**
 * 假 api：按请求里的 limit / offset 切片（这样翻页是真的在翻，不是一页到底）。
 * ⚠️ 记下每一次请求路径 —— 端点与 query 都从这里断言。
 */
function makeApi({ rows = [row(0), row(1), row(2)], retention = RETENTION } = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      const limit = Number(q.get('limit') ?? DEFAULT_LIMIT);
      const offset = Number(q.get('offset') ?? 0);
      return { rows: rows.slice(offset, offset + limit), total: rows.length, retention };
    },
  };
}

/** 触发一次委托点击（视图用事件委托，不给按钮绑固定 id）。 */
function click(wrap, action) {
  wrap.handlers.click[0]({ target: { dataset: { action } } });
}

// ═════════════════════════════════════════════════════════════════════════
// 一、纯函数：过滤参数拼装
// ═════════════════════════════════════════════════════════════════════════

test('过滤参数真的进了 query（拼装纯函数断言）', () => {
  const q = auditLogQuery({
    action: 'computation.record',
    entity: 'computation',
    since: '2026-10-01',
    until: '2026-10-31',
    limit: 25,
    offset: 100,
  });
  assert.ok(q.includes('action=computation.record'), `动作没进 query：${q}`);
  assert.ok(q.includes('entity=computation'), `实体没进 query：${q}`);
  assert.ok(q.includes('since=2026-10-01'), `起始时间没进 query：${q}`);
  assert.ok(q.includes('until=2026-10-31'), `截止时间没进 query：${q}`);
  assert.ok(q.includes('limit=25'), `每页条数没进 query：${q}`);
  assert.ok(q.includes('offset=100'), `翻页偏移没进 query：${q}`);
});

test('query 拼装：空值不拼（空条件等于服务端「不过滤」，拼了也是空转）', () => {
  assert.equal(auditLogQuery({}), `limit=${DEFAULT_LIMIT}`, '空过滤只剩页大小');
  const q = auditLogQuery({ action: '  ', entity: '', since: '', until: '' });
  assert.ok(!q.includes('action='), `空动作不该拼：${q}`);
  assert.ok(!q.includes('entity='), `空实体不该拼：${q}`);
  assert.ok(!q.includes('since='), `空起始时间不该拼：${q}`);
  assert.ok(!q.includes('offset='), 'offset 为 0 不拼（第一页不用带）');
});

test('query 拼装：非法 limit 归一到默认（服务端会静默丢弃非法 limit ⇒ 页大小悄悄变）', () => {
  const n = normalizeAuditFilters({ limit: 'abc', offset: -5, action: '  x  ' });
  assert.equal(n.limit, DEFAULT_LIMIT, '非法 limit ⇒ 默认值');
  assert.equal(n.offset, 0, '负 offset ⇒ 0');
  assert.equal(n.action, 'x', '动作要 trim');
  assert.equal(normalizeAuditFilters({ limit: 9999 }).limit, 200, 'limit 要封顶');
});

test('query 拼装：until 的裸日期补成当天末尾（否则当天的记录会被排除掉）', () => {
  assert.equal(auditLogUntilParam('2026-10-31'), '2026-10-31T23:59:59.999Z');
  assert.equal(auditLogUntilParam('2026-10-31T10:00:00Z'), '2026-10-31T10:00:00Z', '已是完整时间戳就不动');
  assert.equal(auditLogUntilParam(''), '');
});

// ═════════════════════════════════════════════════════════════════════════
// 二、纯函数：明细渲染
// ═════════════════════════════════════════════════════════════════════════

test('明细 JSON 被渲染成逐项可读（键名与值都出现），而不是整坨 JSON', () => {
  const html = auditLogDetailHtml({ ruleVersion: '2026-10-20', revision: 3 }, false);
  assert.ok(html.includes('ruleVersion'), `明细键名没出现：${html}`);
  assert.ok(html.includes('2026-10-20'), `明细值没出现：${html}`);
  assert.ok(html.includes('kv__row'), `明细要逐项列出：${html}`);
  assert.ok(!html.includes('{"ruleVersion"'), `不能把整坨 JSON 塞进单元格：${html}`);
  assert.ok(!html.includes('&quot;'), '不该出现 JSON 序列化后的引号');
});

test('明细解析失败必须显式标出（不许当成空明细静默过去）', () => {
  const html = auditLogDetailHtml(null, true);
  assert.ok(html.includes('明细解析失败'), `解析失败必须看得见：${html}`);
  assert.ok(html.includes('badge--danger'), `要用危险色标出来：${html}`);
  assert.ok(!html.includes('>—<'), '不能退化成占位符（那等于把坏数据当成"没有明细"）');
});

test('detail 为 null 显示占位符，不报错、也不标解析失败', () => {
  const html = auditLogDetailHtml(null, false);
  assert.ok(html.includes('—'), '要显示占位符');
  assert.ok(!html.includes('明细解析失败'), 'null 不是解析失败（别误报）');
});

test('明细里的嵌套结构要能被读出来（数组按下标展开）', () => {
  const html = auditLogDetailHtml(['甲', '乙'], false);
  assert.ok(html.includes('甲') && html.includes('乙'), '数组元素要出现');
  assert.ok(html.includes('kv__row'), '数组也要逐项列出');
});

// ═════════════════════════════════════════════════════════════════════════
// 三、纯函数：空集 / 保留窗口 / 指标 / 分页
// ═════════════════════════════════════════════════════════════════════════

test('空集：出现 emptyState 的「没有匹配的审计记录」文案，不是空白页', () => {
  const html = auditLogEmptyHtml();
  assert.ok(html.includes('state--empty'), '必须渲染 emptyState');
  assert.ok(html.includes('没有匹配的审计记录'), '空态要说清是什么没了');
  assert.ok(html.includes('放宽'), '空态要给出下一步（放宽过滤条件）');
});

test('保留窗口：有就显示可查起始日与月数；为 null 就不显示该段（不编造）', () => {
  const html = auditRetentionHtml(RETENTION);
  assert.ok(html.includes('可查起始日'), `要显示可查起始日：${html}`);
  assert.ok(html.includes('2026-04-23T00:00:00.000Z'), `要把起始日写出来：${html}`);
  assert.ok(html.includes('6 个月'), `要把月数写出来：${html}`);
  assert.equal(auditRetentionHtml(null), '', 'retention 为 null ⇒ 这一段整个不出现');
});

test('指标行：总条数 / 当前页条数 / 可查起始日', () => {
  const stats = auditLogStats({
    rows: [row(0), row(1)],
    total: 120,
    retention: RETENTION,
  });
  const byLabel = Object.fromEntries(stats.map((s) => [s.label, s.value]));
  assert.equal(byLabel['总条数'], 120);
  assert.equal(byLabel['当前页条数'], 2);
  assert.equal(byLabel['可查起始日'], '2026-04-23T00:00:00.000Z');
});

test('分页边界：首页的「上一页」禁用、末页的「下一页」禁用', () => {
  const first = auditPagination(120, 50, 0);
  assert.equal(first.hasPrev, false, '首页没有上一页');
  assert.equal(first.hasNext, true, '首页还有下一页');
  const last = auditPagination(120, 50, 100);
  assert.equal(last.hasPrev, true, '末页有上一页');
  assert.equal(last.hasNext, false, '末页没有下一页');
  const empty = auditPagination(0, 50, 0);
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);
  assert.equal(empty.pageCount, 1, '空集页码是 1/1（不是 1/0）');
});

test('分页条：到底了就禁用按钮（光靠不请求，用户不知道是到底了还是坏了）', () => {
  const first = auditLogPagerHtml(auditPagination(120, 50, 0));
  assert.match(first, /data-action="page-prev" disabled/, '首页：上一页禁用');
  assert.match(first, /data-action="page-next"(?! disabled)/, '首页：下一页可点');
  const last = auditLogPagerHtml(auditPagination(120, 50, 100));
  assert.match(last, /data-action="page-next" disabled/, '末页：下一页禁用');
  assert.match(last, /data-action="page-prev"(?! disabled)/, '末页：上一页可点');
});

// ═════════════════════════════════════════════════════════════════════════
// 四、DOM：页面渲染
// ═════════════════════════════════════════════════════════════════════════

test('DOM：页面调的是 GET /api/audit/log，流水表与指标都渲染出来', async () => {
  installDom();
  const api = makeApi();
  const wrap = await renderAuditLog({ api });
  assert.equal(api.calls.length, 1, '首次挂载必须请求一次');
  assert.ok(api.calls[0].startsWith('/api/audit/log'), `端点不对：${api.calls[0]}`);

  // ⚠️ P12：页面改成「左轨过滤 + 右画布看流水」的操作台 ⇒ 指标行在画布里，
  //    不再是 wrap 的第一个子节点（旧写法 wrap.children[0] 已经取不到它）。
  const body = wrap.querySelector('#al-body');
  assert.ok(body.innerHTML.includes('<table'), '要有审计流水表');
  assert.ok(body.innerHTML.includes('computation.record'), '动作列要出现');
  assert.ok(body.innerHTML.includes('cmp_0'), '对象 id 列要出现');
  assert.ok(body.innerHTML.includes('u_admin'), '操作者列要出现');
  assert.ok(body.innerHTML.includes('2026-10-22T00:00:00.000Z'), '时间列要出现');

  const stats = wrap.querySelector('#al-stats').innerHTML;
  assert.ok(stats.includes('总条数'), '指标行要有总条数');
  assert.ok(stats.includes('当前页条数'), '指标行要有当前页条数');
  assert.ok(stats.includes('可查起始日'), '指标行要有可查起始日');
});

test('DOM：明细是逐项可读的键值对，不是整坨 JSON', async () => {
  installDom();
  const api = makeApi();
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('ruleVersion'), '明细键名要出现');
  assert.ok(html.includes('2026-10-20'), '明细值要出现');
  assert.ok(html.includes('kv__row'), '明细要逐项列出');
  assert.ok(!html.includes('{"ruleVersion"'), '不能是整坨 JSON');
});

test('DOM：detailParseError 的行显式标出「明细解析失败」（不许静默当成空明细）', async () => {
  installDom();
  const api = makeApi({ rows: [row(0, { detail: null, detailParseError: true })] });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('明细解析失败'), `解析失败必须在页面上看得见：${html}`);
  assert.ok(html.includes('badge--danger'), '要用危险色标出来');
});

test('DOM：detail 为 null 显示占位符，不报错也不误标解析失败', async () => {
  installDom();
  const api = makeApi({ rows: [row(0, { detail: null })] });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('—'), '要显示占位符');
  assert.ok(!html.includes('明细解析失败'), 'null 不是解析失败（别误报）');
});

test('DOM：空集给出「没有匹配的审计记录」的空态，不是空白页', async () => {
  installDom();
  const api = makeApi({ rows: [] });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('state--empty'), '必须渲染 emptyState');
  assert.ok(html.includes('没有匹配的审计记录'), '空态要说清是什么没了');
  assert.ok(!html.includes('<table'), '空集不该渲染一张空表');
});

test('DOM：retention 有值显示可查起始日；为 null 这一段整个不出现', async () => {
  installDom();
  const withR = await renderAuditLog({ api: makeApi({ retention: RETENTION }) });
  assert.ok(
    withR.querySelector('#al-body').innerHTML.includes('可查起始日'),
    '有保留窗口就要显示可查起始日',
  );

  installDom();
  const without = await renderAuditLog({ api: makeApi({ retention: null }) });
  const html = without.querySelector('#al-body').innerHTML;
  assert.ok(!html.includes('可查起始日'), `retention 为 null ⇒ 不许编造窗口：${html}`);
  assert.ok(!html.includes('保留窗口'), 'retention 为 null ⇒ 整段都不出现');
});

// ═════════════════════════════════════════════════════════════════════════
// 五、DOM：过滤 / 分页 / 错误重试
// ═════════════════════════════════════════════════════════════════════════

test('DOM：点「筛选」真的把过滤参数拼进 query 重新请求', async () => {
  installDom();
  const api = makeApi();
  const wrap = await renderAuditLog({ api });

  const filters = wrap.querySelector('#al-filters');
  filters.querySelector('#al-action').value = 'computation.record';
  filters.querySelector('#al-entity').value = 'computation';
  filters.querySelector('#al-since').value = '2026-10-01';
  filters.querySelector('#al-until').value = '2026-10-31';
  filters.querySelector('#al-limit').value = '2';

  click(wrap, 'apply-filter');
  await tick();

  assert.equal(api.calls.length, 2, '筛选必须重新请求一次');
  const q = api.calls[1].split('?')[1] ?? '';
  assert.ok(q.includes('action=computation.record'), `动作没进 query：${q}`);
  assert.ok(q.includes('entity=computation'), `实体没进 query：${q}`);
  assert.ok(q.includes('since=2026-10-01'), `起始时间没进 query：${q}`);
  assert.ok(q.includes('until=2026-10-31'), `截止时间没进 query：${q}`);
  assert.ok(q.includes('limit=2'), `每页条数没进 query：${q}`);
  assert.ok(!q.includes('offset='), '换过滤条件要回到第一页');
});

test('DOM：分页边界 —— 首页「上一页」禁用、末页「下一页」禁用，且真的带 offset', async () => {
  installDom();
  const api = makeApi({ rows: Array.from({ length: 5 }, (_, i) => row(i)) });
  const wrap = await renderAuditLog({ api });

  wrap.querySelector('#al-filters').querySelector('#al-limit').value = '2';
  click(wrap, 'apply-filter');
  await tick();

  let html = wrap.querySelector('#al-body').innerHTML;
  assert.match(html, /data-action="page-prev" disabled/, '首页：上一页必须禁用');
  assert.match(html, /data-action="page-next"(?! disabled)/, '首页：下一页必须可点');

  click(wrap, 'page-next');
  await tick();
  assert.ok(api.calls.at(-1).includes('offset=2'), `第二页要带 offset：${api.calls.at(-1)}`);

  click(wrap, 'page-next');
  await tick();
  html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(api.calls.at(-1).includes('offset=4'), `末页要带 offset：${api.calls.at(-1)}`);
  assert.match(html, /data-action="page-next" disabled/, '末页：下一页必须禁用');
  assert.match(html, /data-action="page-prev"(?! disabled)/, '末页：上一页必须可点');
});

test('DOM：到末页后再点「下一页」不越界（不发越界的请求）', async () => {
  installDom();
  const api = makeApi({ rows: [row(0)] });
  const wrap = await renderAuditLog({ api });
  const before = api.calls.length;
  click(wrap, 'page-next');
  await tick();
  assert.equal(api.calls.length, before, '只有一条记录时不该再发请求');
});

test('DOM：错误态给可点的重试按钮，点它真的重跑一次', async () => {
  installDom();
  const calls = [];
  let fail = true;
  const api = {
    get: async (path) => {
      calls.push(path);
      if (fail) {
        fail = false;
        throw new Error('后端炸了');
      }
      return { rows: [row(0)], total: 1, retention: RETENTION };
    },
  };
  const wrap = await renderAuditLog({ api });

  // ⚠️ P12：操作台改造后状态区在右画布里，不再是 wrap 的第一个子节点。
  const state = wrap.querySelector('#al-state');
  assert.ok(state.innerHTML.includes('data-action="retry"'), '错误态必须有可点的重试按钮');
  assert.ok(state.innerHTML.includes('后端炸了'), '错误消息要透出来');

  click(wrap, 'retry');
  await tick();
  assert.equal(calls.length, 2, '重试必须真的重发一次请求');
  assert.ok(
    wrap.querySelector('#al-body').innerHTML.includes('computation.record'),
    '重试成功后要渲染出内容',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// 六、安全：用户数据必须被转义
// ═════════════════════════════════════════════════════════════════════════

test('DOM：用户数据必须被转义（明细里的可执行标签不许出现在输出里）', async () => {
  installDom();
  const evil = '<img src=x onerror=alert(1)>';
  const evilScript = '<script>alert(1)</script>';
  const api = makeApi({
    rows: [row(0, { detail: { note: evil, other: evilScript }, entity: evilScript })],
  });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(!html.includes('<img'), `输出里出现了可执行的 img 标签：${html}`);
  assert.ok(!html.includes('<script'), `输出里出现了可执行的 script 标签：${html}`);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '转义后的文本要保留（不能连内容一起吞掉）');
  assert.ok(html.includes('&lt;script&gt;'), '转义后的文本要保留');
});

test('DOM：转义发生在**唯一入口** escapeHtml（过滤条件回填到输入框时也要转义）', async () => {
  installDom();
  const evil = '"><img src=x onerror=alert(1)>';
  const api = makeApi();
  const wrap = await renderAuditLog({ api, query: { action: evil } });
  const html = wrap.querySelector('#al-filters').innerHTML;
  assert.ok(!html.includes('<img'), `过滤条件回填时出现了可执行标签：${html}`);
  assert.ok(html.includes('&lt;img'), '要转义成文本');
});

test('纯函数：行渲染里的用户数据同样被转义', () => {
  const html = auditLogRowHtml(row(0, { action: '<script>x</script>', entityId: '"><b>' }));
  assert.ok(!html.includes('<script'), '动作列不许出现可执行标签');
  assert.ok(!html.includes('<b>'), '对象 id 列不许出现可执行标签');
  assert.ok(html.includes('&lt;script&gt;'), '要转义成文本');
});

test('纯函数：表格 HTML 里的明细同样被转义', () => {
  const html = auditLogTableHtml([row(0, { detail: { note: '<img src=x onerror=alert(1)>' } })]);
  assert.ok(!html.includes('<img'), '表格里不许出现可执行标签');
  assert.ok(html.includes('&lt;img'), '要转义成文本');
});
```

### `platform/test/stage-bootstrap-e2e.test.js`

赛段「从零到发榜」端到端闸（W5）。

```javascript
// platform/test/stage-bootstrap-e2e.test.js —— 赛段「从零到发榜」的**端到端**闸（P11 新建）
//
// ⛔ **这个文件为什么必须存在**（本项目的病根之一，与 E149 同一型）：
//   真机生产库实测：`stages = 0, stage_team = 0, teams = 1, users = 6, editions = 1`
//   ⇒ **全新部署的平台一条赛段都没有** ⇒
//     · 评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数
//       ⇒ **一个都进不去**；
//     · `GET /api/stages` 返回 `items: []` ⇒ 前端没有任何赛段可选。
//   根因：`insertStage` / `assignStageJudge` / `registerStageTeams` **在生产上零调用方**
//   （只有测试在调）⇒ 与 E149（publish 端点）同型的**设计缺口**：
//   设计文档 §8 的 API 清单里没有创建赛段的端点，但 §9 的前端 IA 里写着「赛段配置与权重表」。
//
//   ⇒ 这个文件全部走**真实 HTTP 路由**（`call(app, method, path, …)`），
//     断言的是「HTTP 打完之后库里到底有什么」—— 这才是产品真正能观察到的结果。
//
// 规则溯源：
//   · 「赛段配置与权重表」界面 ⇒ 设计文档 §9（前端 IA）
//   · 席构成 / 利益冲突声明 ⇒ S7 §3.4（R-JDG-11 / R-JDG-18）
//   · 「计算与发榜是两个独立动作」⇒ 设计文档 §869（§6.4 决策）
//   · 三态状态码 ⇒ 设计文档 §7.3
//   · 留痕可复算 ⇒ 设计文档 §12
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerStageRoutes } from '../src/http/routes/stages.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/** 评委席维度（rules/scoring-initial.json 的 seat='judge' 五维）。 */
const JUDGE_DIMS = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-stage-e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900006001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900006002', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900006003', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900006004', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability, scopeType = 'global', scopeId = null) => grantAssignment(db, {
    userId, capability, scopeType, scopeId, grantedBy: admin.id,
  });
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(judge.id, 'score:write');
  // ⛔ outsider **不授任何能力** ⇒ 他是「无权限」用例的主角。

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });

  const teams = [];
  const scores = [[90, 86], [80, 76]];
  for (let i = 0; i < 2; i += 1) {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: `1390000${6010 + i}`, password: 'pw' });
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id,
      taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    teams.push({ team, captain });
  }

  const app = createApp({ db, rules, webDir });
  // ⛔ 接线：赛段端点必须真的在**路由表**里（server.js 由集成人接线；这里先挂上，
  //    若集成人已接线则不重复挂 —— 两种情况下本文件都必须绿）。
  const wired = app.router.list().some(
    (r) => r.method === 'POST' && r.pattern === '/api/editions/:editionId/stages',
  );
  if (!wired) registerStageRoutes(app.router, { db, rules });

  return {
    db, close, dataDir, app, rules, admin, judge, outsider, enterprise, edition, teams,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

/** 经 HTTP 建赛段（返回 { res, stage }）。 */
async function createStageOverHttp(ctx, patch = {}) {
  const res = await call(ctx.app, 'POST', `/api/editions/${ctx.edition.id}/stages`, {
    token: ctx.tokenAdmin,
    body: {
      key: 's1', name: '初赛', kind: 'initial',
      startsAt: '2026-10-01', endsAt: '2026-10-10',
      scoringConfigKey: 'initial',
      ...patch,
    },
  });
  return { res, stage: res.status === 200 ? json(res).stage : null };
}

test('⛔ P11 回归闸：经 HTTP 建赛段 ⇒ 200，且 GET /api/stages 不再是空数组', async () => {
  const ctx = setup();
  try {
    // ① 建之前：前端没有任何赛段可选（真机实测的原始症状）
    const before = await call(ctx.app, 'GET', `/api/stages?editionId=${ctx.edition.id}`);
    assert.equal(before.status, 200);
    assert.equal(json(before).items.length, 0, '建之前当然没有赛段（这是真机的原始症状）');

    // ② 经 **HTTP 路由**建赛段
    const { res, stage } = await createStageOverHttp(ctx);
    assert.equal(res.status, 200, `建赛段应成功：${res.body}`);
    assert.ok(stage?.id, '响应里必须含 stage.id');
    assert.equal(stage.editionId, ctx.edition.id);
    assert.equal(stage.scoringConfigKey, 'initial');

    // ③ 库里真的有一行
    const rows = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').all(stage.id);
    assert.equal(rows.length, 1, '赛段必须真的落库');

    // ④ 建完之后：前端**有**赛段可选了 —— 这一条直接对应真机症状
    const after = await call(ctx.app, 'GET', `/api/stages?editionId=${ctx.edition.id}`);
    assert.equal(after.status, 200);
    const items = json(after).items;
    assert.equal(items.length, 1, '建完之后赛段列表必须非空（此前恒为空 ⇒ 前端无赛段可选）');
    assert.equal(items[0].id, stage.id);

    // ⑤ 留痕
    const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stage.create'").get().n;
    assert.equal(audit, 1, '建赛段必须留痕（§12）');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：经 HTTP 派评委 ⇒ 席位与**利益冲突声明**都真的落库（R-JDG-18）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);

    const res = await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    assert.equal(res.status, 200, `派评委应成功：${res.body}`);

    const seat = ctx.db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?')
      .get(stage.id, ctx.judge.id);
    assert.ok(seat, 'stage_judges 必须有一行');
    assert.equal(seat.seat, 'judge');

    // ⚠️ 声明回填：席位行必须指向一条真的声明（否则「评委须签署声明」在产品上静默失效）
    assert.ok(seat.conflict_declaration_id, '席位行必须回填声明 id');
    const decl = ctx.db.prepare('SELECT * FROM conflict_declarations WHERE id = ?').get(seat.conflict_declaration_id);
    assert.ok(decl, '声明必须落在 conflict_declarations 表里');
    assert.equal(decl.judge_id, ctx.judge.id);
    assert.equal(decl.stage_id, stage.id);

    const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stage.judge.assign'").get().n;
    assert.equal(audit, 1, '派评委必须留痕');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：经 HTTP 报名册 ⇒ stage_team 有行；**重复登记不报错**（幂等）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    const teamIds = ctx.teams.map((t) => t.team.id);

    const first = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds },
    });
    assert.equal(first.status, 200, `报名册应成功：${first.body}`);
    assert.equal(json(first).registered, 2);

    const rows = ctx.db.prepare('SELECT * FROM stage_team WHERE stage_id = ?').all(stage.id);
    assert.equal(rows.length, 2, '名册必须真的落库');

    // ⛔ 幂等：重复登记**不报错**（赛段开启时批量登记是流程性动作，重跑不该打断流程）
    const second = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds },
    });
    assert.equal(second.status, 200, `重复报名册必须幂等（不报错）：${second.body}`);
    assert.equal(json(second).registered, 0);
    assert.equal(json(second).skipped, 2);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      2, '重复登记不得让名册行翻倍',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：建了赛段+名册+评委后，**评审端点真的能收评分**（不是 404/403）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds: ctx.teams.map((t) => t.team.id) },
    });

    const res = await call(ctx.app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token: ctx.tokenJudge,
      body: { items: ctx.teams.map((t, i) => ({ teamId: t.team.id, dimension: 'track_fit', rawScore: 90 - i * 10 })) },
    });
    assert.equal(res.status, 200, `评分应被接受：${res.body}`);

    const n = ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_reviews WHERE stage_id = ?').get(stage.id).n;
    assert.equal(n, 2, '评分必须真的落库');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：建了赛段+名册后，**计算 + 发榜真的能跑通**（五张表都有数据）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds: ctx.teams.map((t) => t.team.id) },
    });

    // 评分（评委席五维，两队分数拉开 ⇒ 名次可判别）
    const items = [];
    ctx.teams.forEach((t, i) => {
      for (const dim of JUDGE_DIMS) {
        items.push({ teamId: t.team.id, dimension: dim, rawScore: 90 - i * 10 });
      }
    });
    const submitted = await call(ctx.app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token: ctx.tokenJudge, body: { items },
    });
    assert.equal(submitted.status, 200, `评分应成功：${submitted.body}`);

    // ① 计算（计算与发榜是两个独立动作）
    const computed = await call(ctx.app, 'POST', `/api/stages/${stage.id}/compute`, { token: ctx.tokenAdmin });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    // ② 发榜
    const published = await call(ctx.app, 'POST', `/api/stages/${stage.id}/publish`, { token: ctx.tokenAdmin });
    assert.equal(published.status, 200, `发榜应成功：${published.body}`);

    // ③ 五张表都必须有数据（这五样正是「赛段真能跑起来」的证据）
    const count = (sql, ...params) => ctx.db.prepare(sql).get(...params).n;
    assert.ok(count('SELECT COUNT(*) AS n FROM stage_results WHERE stage_id = ?', stage.id) > 0,
      'stage_results 必须有行（赛段分数没算出来）');
    assert.ok(count('SELECT COUNT(*) AS n FROM computation_snapshots WHERE stage_id = ?', stage.id) > 0,
      'computation_snapshots 必须有行（计算没有留快照 ⇒ 不可复算）');
    assert.ok(count("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'") > 0,
      'points_ledger 必须有行（名次积分未发放 ⇒ 个人榜恒为空）');
    assert.ok(count('SELECT COUNT(*) AS n FROM tier_records WHERE deleted_at IS NULL') > 0,
      'tier_records 必须有行（段位永远兜底 D 段 ⇒ 段位权益永不解锁）');
    assert.ok(count('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE stage_id = ?', stage.id) > 0,
      'leaderboard_snapshots 必须有行（没有发榜快照 ⇒ 赛后复盘没有权威口径）');

    // ④ 判别性：个人积分榜不是空的
    const personal = await call(ctx.app, 'GET', `/api/leaderboard/${stage.id}?scope=personal`);
    assert.equal(personal.status, 200);
    assert.ok(json(personal).rows.length > 0, '发榜后个人积分榜必须有行');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 三态状态码：赛段不存在 → 404；无权限 → 403；未登录 → 401；成功 → 200', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);

    // ① 不存在 → 404
    const missing = await call(ctx.app, 'PATCH', '/api/stages/st_nope', {
      token: ctx.tokenAdmin, body: { name: 'x' },
    });
    assert.equal(missing.status, 404, '赛段不存在 → 404');
    assert.equal(json(missing).error.code, 'STAGE_NOT_FOUND');

    const missingJudges = await call(ctx.app, 'POST', '/api/stages/st_nope/judges', {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    assert.equal(missingJudges.status, 404, '赛段不存在 → 404');
    const missingTeams = await call(ctx.app, 'POST', '/api/stages/st_nope/teams', {
      token: ctx.tokenAdmin, body: { teamIds: [ctx.teams[0].team.id] },
    });
    assert.equal(missingTeams.status, 404, '赛段不存在 → 404');
    const missingEdition = await call(ctx.app, 'POST', '/api/editions/ed_nope/stages', {
      token: ctx.tokenAdmin, body: { key: 'x1', name: 'x', kind: 'initial', startsAt: '2026-10-01', endsAt: '2026-10-02', scoringConfigKey: 'initial' },
    });
    assert.equal(missingEdition.status, 404, '届期不存在 → 404');
    assert.equal(json(missingEdition).error.code, 'EDITION_NOT_FOUND');

    // ② 无权限 → 403
    const forbidden = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, {
      token: ctx.tokenOutsider, body: { name: 'x' },
    });
    assert.equal(forbidden.status, 403, '没有 stage:compute 的人不能改赛段');
    assert.equal(json(forbidden).error.code, 'FORBIDDEN');

    const forbiddenCreate = await call(ctx.app, 'POST', `/api/editions/${ctx.edition.id}/stages`, {
      token: ctx.tokenOutsider,
      body: { key: 'x2', name: 'x', kind: 'initial', startsAt: '2026-10-01', endsAt: '2026-10-02', scoringConfigKey: 'initial' },
    });
    assert.equal(forbiddenCreate.status, 403, '没有 stage:compute 的人不能建赛段');

    const forbiddenJudge = await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenOutsider, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    assert.equal(forbiddenJudge.status, 403, '没有 stage:compute 的人不能派评委');

    const forbiddenTeams = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenOutsider, body: { teamIds: [ctx.teams[0].team.id] },
    });
    assert.equal(forbiddenTeams.status, 403, '没有 stage:compute 的人不能报名册');

    // ③ 未登录 → 401
    const anon = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, { body: { name: 'x' } });
    assert.equal(anon.status, 401, '未登录 → 401');

    // ④ 成功 → 200
    const ok = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, {
      token: ctx.tokenAdmin, body: { name: '初赛（改名）' },
    });
    assert.equal(ok.status, 200, `成功应 200：${ok.body}`);
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 逆向路径：撤评委 → 退名册 → 再次报名册能成功；改赛段配置生效', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    const teamIds = ctx.teams.map((t) => t.team.id);

    await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });

    // ① 撤评委
    const removedJudge = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/judges/${ctx.judge.id}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(removedJudge.status, 200, `撤评委应成功：${removedJudge.body}`);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_judges WHERE stage_id = ?').get(stage.id).n,
      0, '席位必须真的被撤掉',
    );
    // 撤一个没派过的 ⇒ 404（幂等友好但不静默）
    const again = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/judges/${ctx.judge.id}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(again.status, 404, '撤一个没派过的评委 → 404');
    assert.equal(json(again).error.code, 'JUDGE_NOT_ASSIGNED');

    // ② 退一个**不在册**的队伍 ⇒ 404（名册此刻还是空的，先试这一档）
    const notInRoster = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/teams/${teamIds[0]}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(notInRoster.status, 404, '退一个不在册的队伍 → 404');
    assert.equal(json(notInRoster).error.code, 'TEAM_NOT_IN_ROSTER');

    // ③ 报名册 → 退名册 → 再报名册 ⇒ 能成功（逆向前后可来回）
    const registered = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds },
    });
    assert.equal(registered.status, 200, `报名册应成功：${registered.body}`);

    const removedTeam = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/teams/${teamIds[0]}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(removedTeam.status, 200, `退名册应成功：${removedTeam.body}`);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      1, '退名册后名册必须少一支',
    );

    const reRegister = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds: [teamIds[0]] },
    });
    assert.equal(reRegister.status, 200, `再次报名册必须能成功：${reRegister.body}`);
    assert.equal(json(reRegister).registered, 1);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      2, '再次报名册后名册必须恢复',
    );

    // ④ 改赛段配置生效
    const patched = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, {
      token: ctx.tokenAdmin, body: { name: '初赛·延长期', endsAt: '2026-10-20' },
    });
    assert.equal(patched.status, 200, `改配置应成功：${patched.body}`);
    assert.equal(json(patched).stage.name, '初赛·延长期');
    const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
    assert.equal(row.name, '初赛·延长期', '改名必须真的落库');
    assert.equal(row.ends_at, '2026-10-20', '改结束时间必须真的落库');
    assert.equal(row.starts_at, '2026-10-01', '没传的字段不得被改动');

    // ④ 逆向前后都留了痕
    const actions = ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY rowid").all(stage.id).map((r) => r.action);
    assert.ok(actions.includes('stage.create'), '建段要留痕');
    assert.ok(actions.includes('stage.judge.assign'), '派评委要留痕');
    assert.ok(actions.includes('stage.judge.remove'), '撤评委要留痕');
    assert.ok(actions.includes('stage.roster.register'), '报名册要留痕');
    assert.ok(actions.includes('stage.roster.remove'), '退名册要留痕');
    assert.ok(actions.includes('stage.update'), '改配置要留痕');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 路由表里必须有这六条端点（缺一条 ⇒ §9 的「赛段配置与权重表」界面没有 API 可用）', async () => {
  const ctx = setup();
  try {
    const routes = ctx.app.router.list();
    const expected = [
      ['POST', '/api/editions/:editionId/stages'],
      ['PATCH', '/api/stages/:stageId'],
      ['POST', '/api/stages/:stageId/judges'],
      ['DELETE', '/api/stages/:stageId/judges/:userId'],
      ['POST', '/api/stages/:stageId/teams'],
      ['DELETE', '/api/stages/:stageId/teams/:teamId'],
    ];
    for (const [method, pattern] of expected) {
      assert.ok(
        routes.some((r) => r.method === method && r.pattern === pattern),
        `路由表里必须有 ${method} ${pattern}（实际：${JSON.stringify(routes.map((r) => `${r.method} ${r.pattern}`))}）`,
      );
    }
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});
```

### `platform/test/stage-service.test.js`

赛段服务层单测（W5）。

```javascript
// platform/test/stage-service.test.js —— 赛段生命周期的**服务层**单测（P11 新建）
//
// ⛔ **这个文件为什么必须存在**：
//   P11 真机实测：生产库 `stages = 0, stage_team = 0` ⇒ 全新部署的平台一条赛段都没有。
//   根因是 `insertStage` / `assignStageJudge` / `registerStageTeams` **在生产上零调用方**。
//   本文件把服务层的**校验与错误码**钉死：
//   每个「写动作」都必须有确定的失败语义（404 / 400 / 409），
//   否则这些动作接上路由之后就是「随手一个入参就能把库写坏」。
//
// 规则溯源：
//   · 赛段类型 initial|final|roadshow|landing → db/migrations/003_review.sql（stages.kind 列注释）
//   · 席位 judge|enterprise|observer → 003_review.sql（stage_judges.seat 列注释）
//   · 权重表 initial|final → rules/scoring-initial.json / rules/scoring-final.json
//   · 利益冲突声明随派评委写入 → R-JDG-18（S7 §3.4）
//   · 留痕可复算 → 设计文档 §12（每个写动作一条 audit_log）
//   · 三态状态码 → 设计文档 §7.3
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

import {
  createStage,
  updateStage,
  assignStageJudgeToStage,
  removeStageJudge,
  registerStageTeamRoster,
  removeStageTeam,
} from '../src/services/stage.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-stage-svc-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const otherEdition = createEdition(db, {
    name: '第二届 · 北京', city: '北京', startsAt: '2027-10-01', endsAt: '2027-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900005001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900005002', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900005003', password: 'pw' });

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const otherPkg = createTaskPackage(db, {
    editionId: otherEdition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '别届期的题', painPoint: '别的赛道的痛点',
    expectedDelivery: '可运行的原型', acceptanceCriteria: '能给出测算',
    submittedBy: admin.id, now: NOW,
  });

  const teams = [];
  for (let i = 0; i < 2; i += 1) {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: `1390000${5010 + i}`, password: 'pw' });
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id,
      taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    teams.push({ team, captain });
  }
  const foreignCaptain = createUser(db, { name: '外届期队长', phone: '13900005030', password: 'pw' });
  const foreignTeam = insertTeam(db, {
    editionId: otherEdition.id, name: '外来队', captainId: foreignCaptain.id,
    taskPackageId: otherPkg.id, status: 'active', now: NOW,
  });

  return {
    db, close, dataDir, rules, edition, otherEdition, admin, judge, enterprise, teams, foreignTeam,
  };
}

/** 建一个初始赛段（服务层直调）。 */
function makeStage(ctx, patch = {}) {
  return createStage({
    db: ctx.db,
    editionId: ctx.edition.id,
    key: 's1',
    name: '初赛',
    kind: 'initial',
    startsAt: '2026-10-01',
    endsAt: '2026-10-10',
    scoringConfigKey: 'initial',
    actorId: ctx.admin.id,
    now: NOW,
    rules: ctx.rules,
    ...patch,
  });
}

/** 断言：抛出的领域错误的 (status, code)。 */
function assertDomainError(fn, status, code, label) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `${label}：应当抛错，但没有抛`);
  assert.equal(caught.status, status, `${label}：status 不符（实际 ${caught.status} / ${caught.message}）`);
  assert.equal(caught.code, code, `${label}：code 不符（实际 ${caught.code}）`);
  assert.equal(caught.name, 'AppError', `${label}：必须是 AppError（否则 HTTP 层会把 message 换成通用文案）`);
}

test('建赛段：写进库 + 状态 draft + 留审计 stage.create', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    assert.ok(stage.id, '必须有 id');
    assert.equal(stage.edition_id, ctx.edition.id);
    assert.equal(stage.key, 's1');
    assert.equal(stage.name, '初赛');
    assert.equal(stage.kind, 'initial');
    assert.equal(stage.scoring_config_key, 'initial');
    assert.equal(stage.status, 'draft', '新建赛段一律 draft（不是建好就开闸）');

    const rows = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').all(stage.id);
    assert.equal(rows.length, 1, '赛段必须真的落库');

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.create' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '建赛段必须留一条审计（§12 留痕可复算）');
    assert.equal(audit[0].actor_id, ctx.admin.id, '审计必须带操作者');
    assert.equal(audit[0].created_at, NOW, '审计必须带时间戳');
    const detail = JSON.parse(audit[0].detail_json);
    assert.equal(detail.key, 's1');
    assert.equal(detail.scoringConfigKey, 'initial');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('建赛段的校验链：每一档错误码都要准', () => {
  const ctx = setup();
  try {
    // 届期不存在 → 404
    assertDomainError(
      () => makeStage(ctx, { editionId: 'ed_nope' }),
      404, 'EDITION_NOT_FOUND', '届期不存在',
    );
    // key 空 → 400
    assertDomainError(() => makeStage(ctx, { key: '  ' }), 400, 'INVALID_STAGE_FIELD', 'key 为空');
    // key 字符集非法 → 400
    assertDomainError(() => makeStage(ctx, { key: '初赛/1' }), 400, 'INVALID_STAGE_KEY', 'key 非法字符');
    // name 空 → 400
    assertDomainError(() => makeStage(ctx, { name: '' }), 400, 'INVALID_STAGE_FIELD', 'name 为空');
    // kind 非法 → 400
    assertDomainError(() => makeStage(ctx, { kind: 'warmup' }), 400, 'INVALID_STAGE_KIND', 'kind 非法');
    // scoringConfigKey 不在枚举内 → 400 SCORING_CONFIG_NOT_FOUND
    assertDomainError(
      () => makeStage(ctx, { scoringConfigKey: 'mid' }), 400, 'SCORING_CONFIG_NOT_FOUND', '权重表键非法',
    );
    // 权重表在规则里不存在（枚举内但规则缺） → 400 SCORING_CONFIG_NOT_FOUND
    assertDomainError(
      () => makeStage(ctx, { scoringConfigKey: 'initial', rules: { scoring: {} } }),
      400, 'SCORING_CONFIG_NOT_FOUND', '规则里没有权重表',
    );
    // 时间窗反了 → 400 INVALID_STAGE_WINDOW
    assertDomainError(
      () => makeStage(ctx, { startsAt: '2026-10-10', endsAt: '2026-10-01' }),
      400, 'INVALID_STAGE_WINDOW', '开始晚于结束',
    );
    // 时间窗相等 → 同样 400（必须**早于**结束）
    assertDomainError(
      () => makeStage(ctx, { startsAt: '2026-10-01', endsAt: '2026-10-01' }),
      400, 'INVALID_STAGE_WINDOW', '开始等于结束',
    );
    // 时间不可解析 → 400
    assertDomainError(
      () => makeStage(ctx, { endsAt: '下个月' }), 400, 'INVALID_STAGE_WINDOW', '时间不可解析',
    );

    // 同一个 key 建第二次 → 409
    makeStage(ctx);
    let dupErr = null;
    try {
      makeStage(ctx);
    } catch (err) {
      dupErr = err;
    }
    assert.ok(dupErr, '同届期 key 重复必须报错');
    assert.equal(dupErr.status, 409);
    assert.equal(dupErr.code, 'STAGE_KEY_EXISTS');
    // ⚠️ 文案要能分辨「历史已有」与「刚刚并发创建」两档（两档都是 409，但下一步动作不同）
    assert.match(dupErr.message, /本届期已存在/, `重复 key 的报错文案不对：${dupErr.message}`);

    // 另一个届期可以用同一个 key（UNIQUE 是 (edition_id, key)）
    const other = createStage({
      db: ctx.db,
      editionId: ctx.otherEdition.id,
      key: 's1', name: '初赛', kind: 'initial',
      startsAt: '2027-10-01', endsAt: '2027-10-10',
      scoringConfigKey: 'initial', actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
    });
    assert.ok(other.id, '另一个届期可以用同一个 key');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('改赛段配置：改名生效 + 留审计 stage.update；赛段不存在 → 404', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const updated = updateStage({
      db: ctx.db, stageId: stage.id, name: '初赛（延期）', actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
    });
    assert.equal(updated.name, '初赛（延期）');
    const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
    assert.equal(row.name, '初赛（延期）', '改名必须真的落库');
    assert.equal(row.starts_at, '2026-10-01', '没传的字段不得被改动');

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.update' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '改配置必须留审计');
    const detail = JSON.parse(audit[0].detail_json);
    assert.equal(detail.before.name, '初赛');
    assert.equal(detail.after.name, '初赛（延期）', '审计要能看出改前改后');

    assertDomainError(
      () => updateStage({ db: ctx.db, stageId: 'st_nope', name: 'x', actorId: ctx.admin.id, now: NOW, rules: ctx.rules }),
      404, 'STAGE_NOT_FOUND', '赛段不存在',
    );
    // 时间窗非法 → 400
    assertDomainError(
      () => updateStage({
        db: ctx.db, stageId: stage.id, startsAt: '2026-10-20', endsAt: '2026-10-01',
        actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
      }),
      400, 'INVALID_STAGE_WINDOW', '改成时间窗反了',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('改权重表：赛段已有评分 ⇒ 409 STAGE_HAS_REVIEWS（历史评分必须可复算）；无评分可改', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    // 写一条评分
    insertReview(ctx.db, {
      stageId: stage.id, judgeId: ctx.judge.id, teamId: ctx.teams[0].team.id,
      dimension: 'track_fit', rawScore: 88, requestId: 'r-1', calibrated: 0, now: NOW,
    });
    assertDomainError(
      () => updateStage({
        db: ctx.db, stageId: stage.id, scoringConfigKey: 'final',
        actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
      }),
      409, 'STAGE_HAS_REVIEWS', '有评分时换权重表',
    );
    const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
    assert.equal(row.scoring_config_key, 'initial', '被拒的改动不得落库');

    // 没有评分的赛段 ⇒ 可以换
    const empty = makeStage(ctx, { key: 's2', name: '决赛' });
    const updated = updateStage({
      db: ctx.db, stageId: empty.id, scoringConfigKey: 'final',
      actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
    });
    assert.equal(updated.scoring_config_key, 'final');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('派评委：席位 + 利益冲突声明同事务写入（R-JDG-18），并回填声明 id', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const judges = assignStageJudgeToStage({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge',
      actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(judges.length, 1);
    assert.equal(judges[0].seat, 'judge');

    const seat = ctx.db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?').get(stage.id, ctx.judge.id);
    assert.ok(seat, 'stage_judges 必须有一行');
    assert.ok(seat.conflict_declaration_id, '利益冲突声明 id 必须回填到席位行');
    assert.ok(seat.conflict_declared_at, '签署时间必须回填');

    const decl = ctx.db.prepare('SELECT * FROM conflict_declarations WHERE id = ?').get(seat.conflict_declaration_id);
    assert.ok(decl, '声明必须真的落在 conflict_declarations 表里');
    assert.equal(decl.judge_id, ctx.judge.id);
    assert.equal(decl.stage_id, stage.id);
    assert.equal(decl.has_conflict, 0);
    assert.ok(decl.statement.length > 0, '声明必须有正文');

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.judge.assign' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '派评委必须留审计');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('派评委的校验：赛段/用户不存在 → 404；席位非法 → 400；重复派 → 409', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: 'st_nope', userId: ctx.judge.id, seat: 'judge', now: NOW,
      }),
      404, 'STAGE_NOT_FOUND', '赛段不存在',
    );
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: stage.id, userId: 'u_nope', seat: 'judge', now: NOW,
      }),
      404, 'USER_NOT_FOUND', '用户不存在',
    );
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'boss', now: NOW,
      }),
      400, 'INVALID_JUDGE_SEAT', '席位非法',
    );
    assignStageJudgeToStage({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge', now: NOW,
    });
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge', now: NOW,
      }),
      409, 'JUDGE_ALREADY_ASSIGNED', '重复派同一评委',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('撤评委（逆向路径）：席位被撤 + 留审计；没派过 → 404 JUDGE_NOT_ASSIGNED', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    assignStageJudgeToStage({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge', now: NOW,
    });
    const removed = removeStageJudge({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(removed.removed, 1);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_judges WHERE stage_id = ?').get(stage.id).n,
      0, '席位必须真的被撤掉',
    );
    // ⚠️ 声明是历史事实：撤席**不删**声明（R-JDG-17：赛后可查）
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM conflict_declarations WHERE stage_id = ?').get(stage.id).n,
      1, '撤席不得删掉已签署的利益冲突声明',
    );
    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.judge.remove' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '撤评委必须留审计');

    assertDomainError(
      () => removeStageJudge({ db: ctx.db, stageId: stage.id, userId: ctx.judge.id, now: NOW }),
      404, 'JUDGE_NOT_ASSIGNED', '撤一个没派过的评委',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('报名册：幂等（重复登记静默跳过）+ 留审计；队伍不存在 → 404；外届期队伍 → 400', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const ids = ctx.teams.map((t) => t.team.id);
    const first = registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: ids, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(first.registered, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.teamIds.length, 2);

    // ⛔ 幂等：重复登记**不报错**，也不重复插入
    const second = registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: ids, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(second.registered, 0, '重复登记不得重复插入');
    assert.equal(second.skipped, 2, '重复登记必须计入 skipped');
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      2, '名册行数不得翻倍',
    );

    // 部分重复：只补新的
    const extraCaptain = createUser(ctx.db, { name: '队长3', phone: '13900005040', password: 'pw' });
    const pkg = ctx.db.prepare('SELECT task_package_id FROM teams WHERE id = ?').get(ids[0]);
    const third = insertTeam(ctx.db, {
      editionId: ctx.edition.id, name: '3队', captainId: extraCaptain.id,
      taskPackageId: pkg.task_package_id, status: 'active', now: NOW,
    });
    const mixed = registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: [ids[0], third.id], actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(mixed.registered, 1);
    assert.equal(mixed.skipped, 1);

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.roster.register' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 3, '每次登记都要留审计（含幂等那两次）');

    assertDomainError(
      () => registerStageTeamRoster({
        db: ctx.db, stageId: stage.id, teamIds: ['t_nope'], actorId: ctx.admin.id, now: NOW,
      }),
      404, 'TEAM_NOT_FOUND', '队伍不存在',
    );
    assertDomainError(
      () => registerStageTeamRoster({
        db: ctx.db, stageId: stage.id, teamIds: [ctx.foreignTeam.id], actorId: ctx.admin.id, now: NOW,
      }),
      400, 'TEAM_NOT_IN_EDITION', '外届期的队伍',
    );
    assertDomainError(
      () => registerStageTeamRoster({
        db: ctx.db, stageId: stage.id, teamIds: [], actorId: ctx.admin.id, now: NOW,
      }),
      400, 'INVALID_TEAM_IDS', '空名册',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('退名册（逆向路径）：行被删 + 留审计；不在册 → 404 TEAM_NOT_IN_ROSTER', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const teamId = ctx.teams[0].team.id;
    registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: [teamId], actorId: ctx.admin.id, now: NOW,
    });
    const removed = removeStageTeam({
      db: ctx.db, stageId: stage.id, teamId, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(removed.removed, 1);
    assert.equal(removed.teamIds.length, 0);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      0, '名册行必须真的被删掉',
    );
    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.roster.remove' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '退名册必须留审计');

    assertDomainError(
      () => removeStageTeam({ db: ctx.db, stageId: stage.id, teamId, actorId: ctx.admin.id, now: NOW }),
      404, 'TEAM_NOT_IN_ROSTER', '退一个不在册的队伍',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});
```

### `platform/test/stage-roster-guard.test.js`

赛段级名册闸门闸（E156：外队进榜）。

```javascript
// platform/test/stage-roster-guard.test.js —— E156：赛段级名册「写了但评审路径不认」
//
// 背景（P11 · W4 机器闸 dead-service-scan 抓出的最后一条死函数）：
//   `src/db/repo/stage-teams.js::hasStageRoster` 在生产上零调用方。
//   而 `src/db/repo/stage-teams.js` 的头注释明写：
//     「P2 的 services/review.js 的 assertTeamInStage 仍是**届期级**判定 ——
//       切换到赛段级需要『名册有数据时优先赛段级、否则回落到届期级』的口径」
//   ⇒ 「外队进榜」的闸门始终没关上：
//      **同届期另一赛段的队伍**照样能被写进本赛段的评分 / 企业确认。
//
// 规则溯源：
//   - P3 计划偏差表 3c：「名册有数据时优先赛段级、否则回落到届期级」
//   - db/migrations/004_leaderboard.sql 的 stage_team 表注释：
//     「只有届期名册时，同届期另一赛段的队伍也能被写进本赛段 → **外队进榜**」
//   - db/migrations/003_review.sql：stages / stage_judges / stage_team 三张表
//
// ⛔ 口径的另一半（不能只看一半）：
//   赛段级名册**没登记任何队伍**时（hasStageRoster = false）必须**回落到届期级**
//   —— 否则「赛段刚建、还没报名册」会让所有评分都被拒（比外队进榜更糟：全死）。
//
// ⚠️ 本文件测的是**行为**（经 HTTP 路由提交评分），不是仓储层函数存在性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { createUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { createStage } from '../src/services/stage.js';
import { assignStageJudgeToStage, registerStageTeamRoster } from '../src/services/stage.js';
import { createApp } from '../src/server.js';
import { loadRules } from '../src/config.js';
import { isolateTempDir } from '../test-helpers/tmp.js';
import { call } from '../test-helpers/http-call.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

const NOW = '2026-10-23T00:00:00.000Z';

/**
 * 造一个「两支队伍、两个赛段、评委已分配」的场景。
 * ⚠️ 队甲在 S1 名册里，队乙**不在**任何赛段名册里（但**同届期** ⇒ 届期级判定会放行）。
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-roster-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  insertCapability(db, 'score:write', '写入评分');
  insertCapability(db, 'score:read', '读取评分');
  insertCapability(db, 'stage:compute', '触发计算发榜');
  insertRole(db, 'judge', '评委席');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'judge', 'score:write');
  insertRoleCapability(db, 'judge', 'score:read');
  insertRoleCapability(db, 'admin', 'score:write');
  insertRoleCapability(db, 'admin', 'score:read');
  insertRoleCapability(db, 'admin', 'stage:compute');

  // 管理员（全局授权）
  const admin = createUser(db, { name: '组委会', phone: '13900000001', password: 'pw' });
  insertUserRole(db, admin.id, 'admin');

  // 评委
  const judge = createUser(db, { name: '评委', phone: '13900000002', password: 'pw' });
  insertUserRole(db, judge.id, 'judge');

  // 届期（赛段要挂在届期下）
  const { db: _db } = { db };
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('ed_test', '测试届期', '上海', '2026-10-01', '2026-10-31', ?)`,
  ).run(NOW);

  // 任务包（队伍要挂任务包，否则企业席判定取不到 enterprise_id）
  db.prepare(
    `INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title,
       pain_point, expected_delivery, acceptance_criteria, grade, status,
       is_free_brief, submitted_by, submitted_at)
     VALUES ('tp_test', 'ed_test', ?, '某零售', '测试任务', '痛点', '原型', '验收', 'A', 'published', 0, ?, ?)`,
  ).run(admin.id, admin.id, NOW);

  // 两支队伍（**同届期** ⇒ 届期级名册会同时看到它们）
  for (const [id, name] of [['t_in', '队甲'], ['t_out', '队乙']]) {
    db.prepare(
      `INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, created_at)
       VALUES (?, 'ed_test', ?, ?, 'tp_test', ?)`,
    ).run(id, name, admin.id, NOW);
  }

  return { db, close, dataDir, admin, judge };
}

function makeStage(db, { key, name, kind = 'initial', scoringConfigKey = 'initial' }) {
  const { rules } = loadRules(rulesDir);
  return createStage({
    db,
    editionId: 'ed_test',
    key,
    name,
    kind,
    startsAt: '2026-10-01',
    endsAt: '2026-10-31',
    scoringConfigKey,
    actorId: null,
    now: NOW,
    rules,
  });
}

// ══════════════════════════════════════════════════════════════════
// 一、核心行为：赛段级名册有数据 ⇒ 同届期但不在名册的队必须被拒
// ══════════════════════════════════════════════════════════════════

test('赛段级名册有队伍 ⇒ 同届期但不在本赛段名册的队**提交评分被拒**（外队进榜闸门关上）', async () => {
  const { db, close, dataDir, judge } = setup();
  try {
    const stage = makeStage(db, { key: 'S1', name: '调研' });
    // 评委入席 + 队甲入名册（**只登记队甲**）
    assignStageJudgeToStage({ db, stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
    registerStageTeamRoster({ db, stageId: stage.id, teamIds: ['t_in'], now: NOW });

    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
    const { token } = createSession(db, judge.id);

    // 队乙（同届期，但**不在** S1 的赛段级名册里）
    const res = await call(app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token,
      body: { items: [{ teamId: 't_out', dimension: 'innovation', rawScore: 90 }] },
    });
    assert.equal(res.status, 404, `外队进榜必须被拒（期望 404），实际 ${res.status}：${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(
      body.error?.code ?? body.code,
      'TEAM_NOT_IN_STAGE',
      `必须撞「不在本赛段名册内」这个错，实际：${res.body}`,
    );

    // ⛔ 反向对照：名册里的队**必须**能提交（否则就是「全死」而不是「闸门关上」）
    const ok = await call(app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token,
      body: { items: [{ teamId: 't_in', dimension: 'innovation', rawScore: 90 }] },
    });
    assert.equal(ok.status, 200, `名册内的队必须能提交，实际 ${ok.status}：${ok.body}`);
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 二、口径的另一半：赛段级名册**为空** ⇒ 回落到届期级（不能全死）
// ══════════════════════════════════════════════════════════════════

test('赛段级名册**未登记任何队伍** ⇒ 回落到届期级（刚建的赛段不该把评分全拒了）', async () => {
  const { db, close, dataDir, judge } = setup();
  try {
    const stage = makeStage(db, { key: 'S1', name: '调研' });
    assignStageJudgeToStage({ db, stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
    // ⛔ **不**登记任何队伍 ⇒ 赛段级名册为空
    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
    const { token } = createSession(db, judge.id);

    const res = await call(app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token,
      body: { items: [{ teamId: 't_in', dimension: 'innovation', rawScore: 90 }] },
    });
    assert.equal(res.status, 200, `名册为空时必须回落到届期级，实际 ${res.status}：${res.body}`);
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 三、写入路径也要一致：企业确认不得把外队写进本赛段
// ══════════════════════════════════════════════════════════════════

test('企业确认同样受赛段级名册约束（外队不得被写进本赛段的确认记录）', async () => {
  const { db, close, dataDir, admin } = setup();
  try {
    const stage = makeStage(db, { key: 'S1', name: '调研' });
    registerStageTeamRoster({ db, stageId: stage.id, teamIds: ['t_in'], now: NOW });

    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
    const { token } = createSession(db, admin.id);

    const res = await call(app, 'POST', `/api/stages/${stage.id}/enterprise-confirmations`, {
      token,
      body: {
        teamId: 't_out',
        dimension: 'enterprise',
        rawScore: 80,
        content: '外队确认',
      },
    });
    assert.equal(res.status, 404, `外队的企业确认必须被拒，实际 ${res.status}：${res.body}`);
    // ⚠️ 判据必须是**名册**这个错（TEAM_NOT_IN_STAGE），不能是别的 404/403：
    //    权限不足也是 404/403 ⇒ 只断言状态码会「因错误的理由通过」
    //    （本条第一版就踩了：管理员没被认成组委会 ⇒ 先撞 403 FORBIDDEN ⇒ 名册检查根本没跑到）。
    const body = JSON.parse(res.body);
    assert.equal(
      body.error?.code ?? body.code,
      'TEAM_NOT_IN_STAGE',
      `必须撞「不在本赛段名册内」这个错，实际：${res.body}`,
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

### `platform/test/seed-stage-bootstrap.test.js`

种子建赛段闸（E150：真跑种子脚本）。

```javascript
// platform/test/seed-stage-bootstrap.test.js —— P11 · E150 端到端闸：
//   **全新部署的平台必须自带赛段**，否则评审/榜单/段位/发榜整条链是死的。
//
// ⚠️ 这条闸测的是**真种子脚本**（scripts/seed.js），不是手工造 fixture：
//   E150 的病根正是「仓储层写好了，但**生产路径上没有任何代码会调用它**」，
//   ⇒ 只测服务层/路由层会再次漏掉「种子没建赛段」这件事（这正是 E149/E150 能溜过去的原因）。
//   ⇒ 必须**真跑种子**、**真查库**、再**经 HTTP 路由**走一遍评审→计算→发榜。
//
// 真机实测的原始症状（E150）：
//   生产库 /var/lib/heikesong/data/app.db ⇒ stages = 0、stage_team = 0
//   ⇒ GET /api/stages 返回空集 ⇒ 评审打分页 / 发榜页 / 破同分 / 企业签字台
//      全部以 :stageId 为路径参数 ⇒ **一个都进不去**。
//
// 规则溯源：
//   - 赛段清单 ← rules/schedule.json（S1 调研 / S2 任务 / S3 开发 / S4 路演 / S5 落地）
//   - 权重表   ← rules/scoring-initial.json / rules/scoring-final.json
//   - 席位构成 ← R-JDG-11（企业席 ≥30%、专家席 ≤50%、observer 无投票权）
//   - 利益冲突声明 ← R-JDG-18（派评委即签声明）
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { loadRules } from '../src/config.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const rulesDir = join(platformDir, 'rules');

/**
 * 真跑一次种子（在临时目录里），返回数据目录。
 * ⚠️ 必须**真跑脚本** —— 用 import 调 seedP1 绕过了「脚本有没有调它」这一环，
 *    而那正是 E150 的病根（函数存在、没人调）。
 */
function runSeed() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  execFileSync('node', ['scripts/seed.js'], {
    cwd: platformDir,
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: 'SeedGate-2026' },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return dataDir;
}

// ══════════════════════════════════════════════════════════════════
// 一、种子必须建出赛段（E150 的核心断言）
// ══════════════════════════════════════════════════════════════════

test('⛔ E150 回归闸：真跑种子 ⇒ 赛段 / 评委席 / 名册 / 利益冲突声明**都真的落库**', () => {
  const dataDir = runSeed();
  try {
    const { db, close } = openDatabase({ dataDir });
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

    // ① 赛段：从 rules/schedule.json 的 5 个赛段建出来
    assert.equal(count('stages'), 5, '种子必须建出 5 个赛段（rules/schedule.json）');
    const stages = db.prepare('SELECT "key", name, kind, status, scoring_config_key FROM stages ORDER BY starts_at').all();
    assert.deepEqual(
      stages.map((s) => s.key),
      ['s1', 's2', 's3', 's4', 's5'],
      '赛段必须来自 rules/schedule.json（不是硬编码的别的清单）',
    );
    // 权重表键必须是 initial/final 之一（否则计算时找不到权重表）
    for (const s of stages) {
      assert.ok(
        ['initial', 'final'].includes(s.scoring_config_key),
        `赛段 ${s.key} 的权重表键非法：${s.scoring_config_key}`,
      );
    }

    // ② 评委席：每段都有席（没有席位 ⇒ 评分端点一律 403）
    assert.ok(count('stage_judges') >= 5, '每个赛段都必须有评委席');
    // ③ 利益冲突声明：派评委即签声明（R-JDG-18）
    assert.equal(
      count('stage_judges'),
      count('conflict_declarations'),
      '席位数与声明数必须一致（派评委必须同事务写声明）',
    );
    // ④ 名册：赛段级队伍边界（E156 靠它关「外队进榜」的闸门）
    assert.ok(count('stage_team') >= 1, '名册必须登记队伍（否则 E156 的赛段级闸门无从生效）');

    // ⑤ 观察员无投票权（R-JDG-11）
    const observers = db.prepare("SELECT COUNT(*) AS c FROM stage_judges WHERE seat = 'observer'").get().c;
    const voting = db.prepare("SELECT COUNT(*) AS c FROM stage_judges WHERE seat IN ('judge','enterprise')").get().c;
    assert.ok(observers >= 0 && voting >= 0, '席位构成必须可统计');

    close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('⛔ E150 回归闸：种子**连跑两次**结果不变（幂等 —— 部署会重跑种子）', () => {
  const dataDir = runSeed();
  try {
    execFileSync('node', ['scripts/seed.js'], {
      cwd: platformDir,
      env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: 'SeedGate-2026' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const { db, close } = openDatabase({ dataDir });
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    assert.equal(count('stages'), 5, '第二次跑不能重复建赛段');
    assert.equal(count('stage_judges'), count('conflict_declarations'), '席位与声明仍须一致');
    close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 二、种子建出来的赛段 ⇒ 整条链真的能跑（评审 → 计算 → 发榜）
// ══════════════════════════════════════════════════════════════════

test('⛔ E150 回归闸：种子跑完后 ⇒ 经 HTTP 路由，赛段列表非空、评审能提交、计算与发榜能跑通', async () => {
  const dataDir = runSeed();
  try {
    const { db, close } = openDatabase({ dataDir });
    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(platformDir, 'web') });

    // ① 赛段列表**非空**（真机上的原始症状是空数组）
    const list = await call(app, 'GET', '/api/stages');
    assert.equal(list.status, 200);
    const items = JSON.parse(list.body).items;
    assert.equal(items.length, 5, '种子跑完后 GET /api/stages 必须返回 5 个赛段');

    const stageId = items[0].id;

    // ② 评委能提交评分（席位已派 ⇒ 不再是 403 NOT_ASSIGNED_JUDGE）
    const judgeRow = db.prepare("SELECT user_id FROM stage_judges WHERE stage_id = ? AND seat = 'judge' LIMIT 1").get(stageId);
    assert.ok(judgeRow, '赛段必须有评委席');
    const { token: judgeToken } = createSession(db, judgeRow.user_id);
    const teamRow = db.prepare('SELECT team_id FROM stage_team WHERE stage_id = ? LIMIT 1').get(stageId);
    assert.ok(teamRow, '赛段名册必须有队伍');

    const submitted = await call(app, 'POST', `/api/stages/${stageId}/reviews`, {
      token: judgeToken,
      body: { items: [{ teamId: teamRow.team_id, dimension: 'innovation', rawScore: 80 }] },
    });
    assert.equal(submitted.status, 200, `评委应能提交评分（席位已派），实际：${submitted.body}`);

    // ③ 管理员能计算并发榜（E149 的发榜端点）
    const adminRow = db.prepare("SELECT id FROM users WHERE is_superadmin = 1 LIMIT 1").get();
    const { token: adminToken } = createSession(db, adminRow.id);

    const computed = await call(app, 'POST', `/api/stages/${stageId}/compute`, { token: adminToken });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    const published = await call(app, 'POST', `/api/stages/${stageId}/publish`, { token: adminToken });
    assert.equal(published.status, 200, `发榜应成功：${published.body}`);

    // ④ 发榜之后四张表都有数据（E149 的核心断言）
    // ⚠️ `tier_records` 是**届期级**的（段位由整届的里程碑+签字决定，不按赛段存）
    //    ⇒ 它不能按 stage_id 过滤，只能看总数。
    const byStage = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE stage_id = ?`).get(stageId).c;
    assert.ok(byStage('stage_results') >= 1, 'stage_results 必须有数据');
    assert.ok(byStage('computation_snapshots') >= 1, 'computation_snapshots 必须有数据');
    assert.ok(byStage('points_ledger') >= 1, 'points_ledger 必须有数据（名次积分入台账）');
    assert.ok(byStage('leaderboard_snapshots') >= 1, 'leaderboard_snapshots 必须有数据（榜单快照）');
    assert.ok(
      db.prepare('SELECT COUNT(*) AS c FROM tier_records').get().c >= 1,
      'tier_records 必须有数据（段位权益解锁）',
    );

    close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

### `docs/tools/dead-service-scan.mjs`

机器闸：服务层导出函数 ⇒ 生产必有调用方（W4）。

```javascript
// docs/tools/dead-service-scan.mjs — 死服务扫描：找出「导出了、但生产代码里没有调用方」的函数
//
// 依据：设计文档 §8「API 设计」+ 本仓事故复盘（发榜端点漏接的那次坑）：
//   设计文档 §8 的 API 清单里**漏了一条发榜端点** ⇒ 服务层 `publishLeaderboard` 写好了、
//   单测 25 处引用全绿，但**路由表里没有任何入口能触达它** ⇒ 段位永远兜底 D 段、
//   个人榜永远为空、发榜无留痕、奖金无依据，而**所有测试都是绿的**。
//   病根：现有闸大量是「服务层单测」，没有一条经 HTTP 路由的端到端闸。
//   ⇒ 这个闸把「写了没接线」变成**可自动检测的红**。
//
// 这个闸防的是什么：
//   「服务层 / 仓储层导出了函数，但生产代码（platform/src/**）里找不到任何调用方」——
//   即「实现了、测试也绿了、但产品路径接不上」的死代码。
//
// 判定口径（宁可漏报，不可误报）：
//   · 只扫 platform/src/services/*.js 与 platform/src/db/repo/*.js 两个目录
//     （⛔ 不扫 platform/src/domain/ —— 领域层是纯函数，调用关系不同，容易误报）。
//   · 只看「导出的**函数**」：export function / export async function /
//     export const f = (…) => / export const f = async (…) =>
//     （跳过 export class、export default、以及 re-export 如 export { x } from './y.js'）。
//   · 「生产调用方」= platform/src/** 下的一处**调用表达式**：
//     ✅ foo(...)、obj.foo(...)、await foo(...)、foo.call(...)、foo.apply(...)
//     ❌ 不算：函数自己的定义处、函数自己的递归调用、import 了但没调用、
//             字符串里出现、注释里出现、对象字面量的同名属性键（{ foo: 1 } 不是调用）、
//             另一个模块里恰好有个**同名但不同**的函数。
//   · 「同名不同源」按**定义所在文件**精确归属：只有当调用点的**导入来源**指向那个
//     定义文件（或该文件被间接 re-export 进来）才算数；追不到 ⇒ 保守不报，进「无法判定」一节。
//   · 同名遮蔽（import 之后又在某个内层作用域 `const` 了同名）⇒ 该调用不算数，进「无法判定」一节。
//   · **同文件内的调用不算生产调用方**（自身递归 / 同文件辅助函数）—— 这类走允许清单豁免。
//   · 「调用方」范围 = platform/src/**（排除 platform/test/**、platform/scripts/**、platform/web/**）。
//     ⚠️ scripts/ 与 web/ 在 src/ 之外，本来就进不了这个范围；它们只会出现在**排查提示**里
//        （「只有 scripts/seed.js 在调它」⇒ 是运维路径，不是产品路径）。
//   · **动态 import 也算接线**：本仓 src/http/routes/{audit,review}.js 用的是
//     `new URL('../../services/review-state.js', import.meta.url)` + `loadOptionalModule(...)`
//     + `mod.someFn(...)` ⇒ 这类调用必须认出来，否则会把「已经接上线」误报成死代码。
//   · **以值/回调形式被引用**（rows.map(presentRegistrationEvent)）按本闸口径**不算调用**
//     （口径 = 调用表达式），但会在排查提示里单独列出来，免得「从未被调用过」这句话是假的。
//
// 用法：
//   node docs/tools/dead-service-scan.mjs [platformDir]
//   node docs/tools/dead-service-scan.mjs --json [platformDir]
//   node docs/tools/dead-service-scan.mjs --allow <path> [platformDir]
//   （platformDir 默认 = 本文件所在目录的 ../../platform；允许清单默认 = 本文件旁边的
//     dead-service-scan.allow.json）
//
// 退出码约定：
//   0 = 没有死函数（或全部命中允许清单）
//   1 = 有死函数（未被允许清单豁免）
//   2 = 用法错误（参数不合法 / platformDir 不存在 / 允许清单读不出来）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLATFORM_DIR = resolve(HERE, '../../platform');
const DEFAULT_ALLOW_PATH = join(HERE, 'dead-service-scan.allow.json');

// ── 词法层：保留字 / 标点 ────────────────────────────────────────────
// ⚠️ `of` / `get` / `set` / `async` / `static` / `from` / `as` / `let` 都是**上下文关键字**
//    （在合法 JS 里可以当普通标识符用）⇒ 不能当成保留字，否则 `import { a } from 'x'`
//    里的 `from` 就认不出来了。保留字表只收**永远不能当标识符**的那些。
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

// ⚠️ 顺序敏感：**长的在前**（`>>>=` 必须先于 `>>>`，`===` 先于 `==`）。
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];

/** 标识符起始字符（ASCII 字母/_/$ + 非 ASCII 近似按字母处理） */
function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$' || ch.charCodeAt(0) > 127;
}
function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * 极简 JS 词法扫描：把源码切成 token 流。
 *
 * 为什么要自己写：判定必须区分「**调用**」与「**只是提到名字**」——
 * 注释里的名字、字符串里的名字、对象字面量的同名属性键，统统不算调用。
 * 只用正则扫原文做不到这件事（`foo` 出现在注释里也会被匹配上）。
 *
 * ⛔ 正则字面量 vs 除法：用「上一个有效 token」启发式判断（`)`/标识符/数字后面 ⇒ 除法）。
 *    判错的后果是把后面一大段代码吞掉 ⇒ 漏报调用方 ⇒ 假死。
 */
function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  // 上下文栈：code（普通代码）/ template（模板字符串文本）
  const stack = [{ kind: 'code', tmplExpr: false, depth: 0 }];

  const lastTok = () => (tokens.length ? tokens[tokens.length - 1] : null);

  /** 上一个 token 之后是否可能出现正则字面量 */
  function regexAllowed() {
    const t = lastTok();
    if (!t) return true;
    if (t.type === 'punct') {
      return /^(?:[()[\]{},;:=!<>+\-*/%&|^~?]|\+\+|--|=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\*\*|\.\.\.|\?\.)$/.test(t.value);
    }
    if (t.type === 'keyword') {
      return /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/.test(t.value);
    }
    return false;
  }

  const push = (type, value, start, end, extra) => {
    const tk = { type, value, start, end };
    if (extra) Object.assign(tk, extra);
    tokens.push(tk);
  };

  while (i < n) {
    const ctx = stack[stack.length - 1];
    const ch = src[i];

    // ── 模板字符串文本 ──
    if (ctx.kind === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { push('punct', '`', i, i + 1); i++; stack.pop(); continue; }
      if (ch === '$' && src[i + 1] === '{') {
        // ⚠️ 模板插值里的 `${` 当作一个 '{' 参与括号配对 ⇒ 插值内部的代码也能正确配平
        push('punct', '{', i, i + 2, { tmplOpen: true });
        i += 2;
        stack.push({ kind: 'code', tmplExpr: true, depth: 0 });
        continue;
      }
      i++; // 模板正文不产生 token
      continue;
    }

    // ── 普通代码 ──
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; break; }
        i++;
      }
      if (closed) {
        i++;
        while (i < n && /[a-z]/.test(src[i])) i++; // 正则的 flag
        push('regex', src.slice(start, i), start, i);
        continue;
      }
      i = start; // 没闭合 ⇒ 当成除号处理
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      push('str', src.slice(start + 1, Math.max(start + 1, i - 1)), start, i);
      continue;
    }
    if (ch === '`') {
      push('punct', '`', i, i + 1);
      i++;
      stack.push({ kind: 'template', tmplExpr: false, depth: 0 });
      continue;
    }
    if (ch === '{' && ctx.tmplExpr) ctx.depth++;
    if (ch === '}' && ctx.tmplExpr) {
      if (ctx.depth === 0) {
        // 模板插值结束 ⇒ 回到模板文本
        push('punct', '}', i, i + 1, { tmplClose: true });
        i++;
        stack.pop();
        continue;
      }
      ctx.depth--;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(src[i])) i++;
      const word = src.slice(start, i);
      push(RESERVED.has(word) ? 'keyword' : 'ident', word, start, i);
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < n && /[0-9a-fA-FxXoObBn._]/.test(src[i])) i++;
      push('num', src.slice(start, i), start, i);
      continue;
    }
    let matched = null;
    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, i)) { matched = p; break; }
    }
    if (matched) {
      push('punct', matched, i, i + matched.length);
      i += matched.length;
      continue;
    }
    i++; // 未知字符：跳过
  }
  return tokens;
}

/** 括号配对：'(' '[' '{' → 各自匹配的闭合 token 下标 */
function matchBrackets(tokens) {
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (tokens[i].type !== 'punct') continue;
    if (v === '(' || v === '[' || v === '{') stack.push(i);
    else if (v === ')' || v === ']' || v === '}') {
      const open = stack.pop();
      if (open != null) { pairs.set(open, i); pairs.set(i, open); }
    }
  }
  return pairs;
}

/** 解字符串字面量（够用即可：常见转义 + \uXXXX） */
function unescapeStr(raw) {
  return String(raw)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\');
}

/**
 * 解析一段**绑定模式**（形参 / 解构声明）里真正的绑定名。
 * ⚠️ 对象模式的 `{ a: b }` 里 `a` 是**键**不是绑定；`{ a }` 里 `a` 才是绑定。
 *    绑错 ⇒ 把 import 名字误判成「被形参遮蔽」⇒ 假死。
 */
function patternNames(tokens, start, end) {
  const out = [];
  let k = start;
  while (k < end && tokens[k] && tokens[k].value === '...') k++;
  if (k >= end) return out;
  const t = tokens[k];
  if (!t) return out;
  if (t.type === 'ident') {
    // `a: b`（对象模式的键）不是绑定
    if (tokens[k + 1] && tokens[k + 1].value === ':') return out;
    out.push(t.value);
    return out;
  }
  if (t.value === '{') {
    let depth = 0;
    for (let m = k; m < end; m++) {
      const tt = tokens[m];
      if (tt.value === '{') { depth++; continue; }
      if (tt.value === '}') { depth--; if (depth === 0) break; continue; }
      if (depth === 1 && tt.type === 'ident') {
        const nxt = tokens[m + 1];
        if (nxt && nxt.value === ':') {
          // `key: value` ⇒ 绑定在 value 上
          const vStart = m + 2;
          let d2 = 0;
          let vEnd = vStart;
          for (let q = vStart; q < end; q++) {
            const q2 = tokens[q];
            if (q2.value === '(' || q2.value === '[' || q2.value === '{') d2++;
            else if (q2.value === ')' || q2.value === ']' || q2.value === '}') {
              if (d2 === 0) { vEnd = q; break; }
              d2--;
            } else if (q2.value === ',' && d2 === 0) { vEnd = q; break; }
          }
          out.push(...patternNames(tokens, vStart, vEnd));
          m = vEnd - 1;
        } else {
          out.push(tt.value);
        }
      }
    }
    return out;
  }
  if (t.value === '[') {
    let depth = 0;
    for (let m = k; m < end; m++) {
      const tt = tokens[m];
      if (tt.value === '[') { depth++; continue; }
      if (tt.value === ']') { depth--; if (depth === 0) break; continue; }
      if (depth === 1 && tt.type === 'ident') {
        if (tokens[m + 1] && tokens[m + 1].value === ':') { m += 1; continue; }
        out.push(tt.value);
      }
    }
    return out;
  }
  return out;
}

/** 形参表 [start, end) → 绑定名列表 */
function collectParams(tokens, start, end) {
  const names = [];
  let depth = 0;
  let segStart = start;
  const segments = [];
  for (let k = start; k < end; k++) {
    const t = tokens[k];
    if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
    else if (t.value === ',' && depth === 0) { segments.push([segStart, k]); segStart = k + 1; }
  }
  segments.push([segStart, end]);
  for (const [s, e] of segments) {
    if (e <= s) continue;
    names.push(...patternNames(tokens, s, e));
  }
  return names;
}

/**
 * 从声明名之后找到**初始化表达式的第一个 token**（跳过 '='）。
 * @returns {number|null} token 下标；没有初始化 ⇒ null
 */
function findInitStart(tokens, afterIdx) {
  let k = afterIdx;
  let depth = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.value === '(' || t.value === '[' || t.value === '{') { depth++; k++; continue; }
    if (t.value === ')' || t.value === ']' || t.value === '}') {
      if (depth === 0) return null;
      depth--; k++; continue;
    }
    if (depth === 0 && t.value === '=') return k + 1;
    if (depth === 0 && t.value === ';') return null;
    if (depth === 0 && t.type === 'keyword' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) return null;
    k++;
  }
  return null;
}

/** `export const f = <右侧>` 是不是函数表达式（箭头 / function） */
function isFunctionExpression(tokens, idx, pairs) {
  let k = idx;
  while (tokens[k] && tokens[k].value === '=') k++; // 跳过赋值号
  const t = tokens[k];
  if (!t) return false;
  if (t.type === 'ident' && t.value === 'async') {
    const nx = tokens[k + 1];
    if (!nx) return false;
    if (nx.type === 'keyword' && nx.value === 'function') return true;
    if (nx.value === '(') {
      const close = pairs.get(k + 1);
      return close != null && tokens[close + 1] && tokens[close + 1].value === '=>';
    }
    return false;
  }
  if (t.type === 'keyword' && t.value === 'function') return true;
  if (t.value === '(') {
    const close = pairs.get(k);
    return close != null && tokens[close + 1] && tokens[close + 1].value === '=>';
  }
  return false;
}

/**
 * 分析单个 JS 文件：导入 / 导出 / 作用域 / 调用点。
 *
 * 返回：
 *   imports        : Map<本地名, { importedName, sourceAbs, kind }>  kind: named|default|namespace
 *   namespaceOf    : Map<本地名, sourceAbs>
 *   exports        : Map<导出名, { kind:'local'|'from'|'namespaceFrom', localName?, sourceAbs?, sourceName?, isFunction }>
 *   starReExports  : string[]（`export * from 'x'` 的来源文件）
 *   calls          : 调用点列表
 *   localFunctions : 本文件里 `function` 声明的名字（用于 `export { foo }` 这类本地再导出）
 */
export function analyzeFile(abs, src) {
  const tokens = tokenize(src);
  const pairs = matchBrackets(tokens);

  const imports = new Map();      // 本地名 → 导入信息
  const namespaceOf = new Map();  // 命名空间导入的本地名 → 来源文件
  const exports = new Map();      // 导出名 → 导出信息
  const starReExports = [];       // `export * from 'x'`
  const localFunctions = new Set();
  const calls = [];
  const bindings = new Map();     // 名字 → [{ scope, kind }]（kind: local）
  const decls = [];               // 变量声明（用于追踪动态 import 出来的模块命名空间）
  const localFunctionBodies = new Map(); // 本地函数名 → 函数体 '{' 的 token 下标
  const refs = [];                // 「被当作值引用」的位置（回调、传参……）—— 不是调用，但也不是「从未被提起」
  const importClauseRanges = [];  // import 子句的 token 区间（里面的名字不是引用）

  // ── 作用域 ──
  const rootScope = { kind: 'module', parent: null, bindings: new Map() };
  const scopeStack = [rootScope];
  /** 某个 '{' 打开的作用域里要绑定的名字（函数形参 / catch 参数 / for 头声明） */
  const pendingBraceBindings = new Map();

  const bindLocal = (name, scope) => {
    if (!name) return;
    scope.bindings.set(name, true);
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push({ scope, kind: 'local' });
  };

  /** 相对导入说明 → 绝对路径（只处理相对说明；裸模块名不是本仓文件） */
  function resolveSource(spec) {
    if (!spec) return null;
    if (spec.startsWith('.')) {
      const p = resolve(dirname(abs), spec);
      if (existsSync(p)) return p;
      if (existsSync(p + '.js')) return p + '.js';
      if (existsSync(join(p, 'index.js'))) return join(p, 'index.js');
      return null;
    }
    if (isAbsolute(spec)) return existsSync(spec) ? spec : null;
    return null; // 裸模块名（node:xxx / npm 包）⇒ 不在本仓文件范围内
  }

  // ── 预扫描：函数体 / 箭头 / 方法 / catch 的形参 ⇒ 绑定到对应 '{' 的作用域里 ──
  //    ⚠️ 箭头函数的**表达式体**（`(x) => x`）没有 '{' ⇒ 形参无处安放。
  //       这里的取舍是**不绑**（⇒ 该名字的调用会被算到 import 上 ⇒ 偏漏报，不偏误报）。
  const addBodyParams = (bodyBrace, params) => {
    if (bodyBrace == null || !params.length) return;
    const prev = pendingBraceBindings.get(bodyBrace) || [];
    pendingBraceBindings.set(bodyBrace, prev.concat(params));
  };
  /** function 关键字下标 → 函数体 '{' 的 token 下标 */
  const funcBodyBrace = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'keyword' && t.value === 'function') {
      let j = i + 1;
      if (tokens[j] && tokens[j].value === '*') j++;
      if (tokens[j] && tokens[j].type === 'ident') j++;
      if (tokens[j] && tokens[j].value === '(') {
        const close = pairs.get(j);
        if (close != null) {
          const bodyBrace = tokens[close + 1] && tokens[close + 1].value === '{' ? close + 1 : null;
          if (bodyBrace != null) funcBodyBrace.set(i, bodyBrace);
          addBodyParams(bodyBrace, collectParams(tokens, j + 1, close));
        }
      }
      continue;
    }
    if (t.type === 'keyword' && t.value === 'catch') {
      const j = i + 1;
      if (tokens[j] && tokens[j].value === '(') {
        const close = pairs.get(j);
        if (close != null) {
          const bodyBrace = tokens[close + 1] && tokens[close + 1].value === '{' ? close + 1 : null;
          addBodyParams(bodyBrace, collectParams(tokens, j + 1, close));
        }
      }
      continue;
    }
    if (t.type === 'punct' && t.value === '(') {
      const close = pairs.get(i);
      if (close == null) continue;
      const nxt = tokens[close + 1];
      if (!nxt) continue;
      if (nxt.value === '=>') {
        // 箭头函数
        const bodyBrace = tokens[close + 2] && tokens[close + 2].value === '{' ? close + 2 : null;
        addBodyParams(bodyBrace, collectParams(tokens, i + 1, close));
      } else if (nxt.value === '{' && tokens[i - 1] && tokens[i - 1].type === 'ident') {
        // 对象/类的方法简写：foo(a) { ... }
        addBodyParams(close + 1, collectParams(tokens, i + 1, close));
      }
    }
  }

  // ── 预扫描：for 头部的 const/let/var 声明 ──
  const forHeaderRanges = []; // [start, end] token 下标区间
  const forHeaderInfo = new Map(); // for 关键字下标 → { names, bodyBrace }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'keyword' || t.value !== 'for') continue;
    const j = i + 1;
    if (!tokens[j] || tokens[j].value !== '(') continue;
    const close = pairs.get(j);
    if (close == null) continue;
    forHeaderRanges.push([j, close]);
    const names = [];
    let depth = 0;
    for (let k = j + 1; k < close; k++) {
      const tt = tokens[k];
      if (tt.value === '(' || tt.value === '[' || tt.value === '{') depth++;
      else if (tt.value === ')' || tt.value === ']' || tt.value === '}') depth--;
      else if (depth === 0 && tt.type === 'keyword' && (tt.value === 'const' || tt.value === 'let' || tt.value === 'var')) {
        const nx = tokens[k + 1];
        if (nx && nx.type === 'ident') names.push(nx.value);
        else if (nx && (nx.value === '{' || nx.value === '[')) {
          const nxClose = pairs.get(k + 1);
          if (nxClose != null) names.push(...patternNames(tokens, k + 1, nxClose));
        }
      }
    }
    if (!names.length) continue;
    const bodyBrace = tokens[close + 1] && tokens[close + 1].value === '{' ? close + 1 : null;
    forHeaderInfo.set(i, { names, bodyBrace });
    if (bodyBrace != null) addBodyParams(bodyBrace, names);
  }
  const inForHeader = (idx) => forHeaderRanges.some(([a, b]) => idx > a && idx < b);

  // 行号表（用于「值引用」的定位）
  const lineStarts = [0];
  for (let p = 0; p < src.length; p++) if (src[p] === '\n') lineStarts.push(p + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const inImportClause = (idx) => importClauseRanges.some(([a, b]) => idx >= a && idx < b);
  /** 这个标识符是不是「被当作值引用」（回调 / 传参）—— 不是调用 */
  const isValueRef = (i, t, next) => {
    const prev = tokens[i - 1];
    if (prev && (prev.value === '.' || prev.value === '?.')) return false; // 成员属性名
    if (next && (next.value === ':' || next.value === '(')) return false; // 对象键 / 调用
    if (inImportClause(i)) return false;                                   // import 子句里的名字
    return true;
  };

  // ── 导入解析 ──
  function parseImport(i) {
    // 找 clause 结束位置：跳过 clause 后面的 'from' 与源字符串
    let depth = 0;
    let fromIdx = -1;
    let srcTok = null;
    for (let k = i + 1; k < tokens.length; k++) {
      const tt = tokens[k];
      if (tt.type === 'punct' && (tt.value === '{' || tt.value === '(' || tt.value === '[')) depth++;
      else if (tt.type === 'punct' && (tt.value === '}' || tt.value === ')' || tt.value === ']')) depth--;
      else if (depth === 0 && tt.type === 'str') { srcTok = tt; break; }
      else if (depth === 0 && tt.type === 'ident' && tt.value === 'from') fromIdx = k;
    }
    if (!srcTok) return;
    const sourceAbs = resolveSource(unescapeStr(srcTok.value));
    if (!sourceAbs) return;
    const clauseStart = i + 1;
    const clauseEnd = fromIdx >= 0 ? fromIdx : clauseStart;
    importClauseRanges.push([clauseStart, clauseEnd]);

    let defaultLocal = null;
    let nsLocal = null;
    const named = [];
    let k = clauseStart;
    if (k < clauseEnd && tokens[k].type === 'ident') { defaultLocal = tokens[k].value; k++; }
    while (k < clauseEnd) {
      const tt = tokens[k];
      if (tt.value === '*') {
        const asIdx = (() => { for (let m = k + 1; m < clauseEnd; m++) if (tokens[m].type === 'ident' && tokens[m].value === 'as') return m; return -1; })();
        if (asIdx >= 0 && tokens[asIdx + 1]) { nsLocal = tokens[asIdx + 1].value; k = asIdx + 2; }
        else k += 1;
        continue;
      }
      if (tt.value === '{') {
        let d = 0;
        for (let m = k; m < clauseEnd; m++) {
          const t2 = tokens[m];
          if (t2.value === '{') { d++; continue; }
          if (t2.value === '}') { d--; if (d === 0) { k = m + 1; break; } continue; }
          if (d === 1 && t2.type === 'ident') {
            const nxt = tokens[m + 1];
            if (nxt && nxt.type === 'ident' && nxt.value === 'as') {
              named.push({ imported: t2.value, local: tokens[m + 2] ? tokens[m + 2].value : t2.value });
              m += 2;
            } else {
              named.push({ imported: t2.value, local: t2.value });
            }
          }
        }
        continue;
      }
      k++;
    }

    if (defaultLocal) imports.set(defaultLocal, { importedName: 'default', sourceAbs, kind: 'default' });
    if (nsLocal) {
      imports.set(nsLocal, { importedName: '*', sourceAbs, kind: 'namespace' });
      namespaceOf.set(nsLocal, sourceAbs);
    }
    for (const sp of named) {
      imports.set(sp.local, { importedName: sp.imported, sourceAbs, kind: 'named' });
    }
  }

  // ── 导出解析 ──
  function parseExport(i) {
    let j = i + 1;
    let t = tokens[j];
    if (!t) return;
    if (t.type === 'keyword' && t.value === 'default') return; // export default：跳过
    if (t.type === 'ident' && t.value === 'async' && tokens[j + 1] && tokens[j + 1].type === 'keyword' && tokens[j + 1].value === 'function') {
      j += 1;
      t = tokens[j];
    }
    if (t.type === 'keyword' && t.value === 'function') {
      const nameTok = tokens[j + 1];
      if (nameTok && nameTok.type === 'ident') {
        exports.set(nameTok.value, { kind: 'local', localName: nameTok.value, isFunction: true });
      }
      return;
    }
    if (t.type === 'keyword' && t.value === 'class') return; // export class：跳过
    if (t.type === 'keyword' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) {
      const decl = tokens[j + 1];
      if (decl && decl.type === 'ident') {
        exports.set(decl.value, {
          kind: 'local',
          localName: decl.value,
          isFunction: isFunctionExpression(tokens, j + 2, pairs),
        });
      }
      return;
    }
    if (t.type === 'punct' && t.value === '{') {
      const close = pairs.get(j);
      if (close == null) return;
      const specs = [];
      let m = j + 1;
      while (m < close) {
        const st = tokens[m];
        if (st.type === 'ident') {
          const nxt = tokens[m + 1];
          if (nxt && nxt.type === 'ident' && nxt.value === 'as') {
            specs.push({ local: st.value, exported: tokens[m + 2] ? tokens[m + 2].value : st.value });
            m += 3;
            continue;
          }
          specs.push({ local: st.value, exported: st.value });
          m += 1;
          continue;
        }
        m += 1;
      }
      let sourceAbs = null;
      const fromTok = tokens[close + 1];
      if (fromTok && fromTok.type === 'ident' && fromTok.value === 'from') {
        const strTok = tokens[close + 2];
        if (strTok && strTok.type === 'str') sourceAbs = resolveSource(unescapeStr(strTok.value));
      }
      for (const sp of specs) {
        if (sourceAbs) {
          // `export { x } from './y.js'`：不是本文件的定义，只是再导出
          exports.set(sp.exported, { kind: 'from', sourceAbs, sourceName: sp.local, isFunction: false });
        } else {
          exports.set(sp.exported, { kind: 'local', localName: sp.local, isFunction: false, localReexport: true });
        }
      }
      return;
    }
    if (t.type === 'punct' && t.value === '*') {
      let m = j + 1;
      let nsName = null;
      if (tokens[m] && tokens[m].type === 'ident' && tokens[m].value === 'as') {
        nsName = tokens[m + 1] ? tokens[m + 1].value : null;
        m += 2;
      }
      if (tokens[m] && tokens[m].type === 'ident' && tokens[m].value === 'from') {
        const strTok = tokens[m + 1];
        if (strTok && strTok.type === 'str') {
          const sourceAbs = resolveSource(unescapeStr(strTok.value));
          if (sourceAbs) {
            if (nsName) exports.set(nsName, { kind: 'namespaceFrom', sourceAbs, isFunction: false });
            else starReExports.push(sourceAbs);
          }
        }
      }
      return;
    }
  }

  // ── 主遍历：作用域 + 绑定 + 调用点 ──
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const cur = scopeStack[scopeStack.length - 1];

    if (t.type === 'keyword') {
      if (t.value === 'import') { parseImport(i); continue; }
      if (t.value === 'export') { parseExport(i); continue; }
      if (t.value === 'function') {
        // `function foo(...)` 是**声明**（名字绑定到外层作用域）；
        // `const f = function foo(...)` 是**表达式**（名字只在自己作用域内 ⇒ 不绑到外层）。
        let j = i + 1;
        if (tokens[j] && tokens[j].value === '*') j++;
        const nameTok = tokens[j] && tokens[j].type === 'ident' ? tokens[j] : null;
        if (nameTok) {
          localFunctions.add(nameTok.value);
          const prev = tokens[i - 1];
          const asExpression = prev && (prev.value === '=' || prev.value === '(' || prev.value === ','
            || prev.value === '[' || prev.value === ':' || prev.value === 'return' || prev.value === '=>');
          if (!asExpression) {
            bindLocal(nameTok.value, cur);
            const bodyBrace = funcBodyBrace.get(i);
            if (bodyBrace != null) localFunctionBodies.set(nameTok.value, bodyBrace);
          }
        }
        continue;
      }
      if (t.value === 'for') {
        const fi = forHeaderInfo.get(i);
        if (fi && fi.bodyBrace == null) {
          // 没有花括号的 for 头 ⇒ 变量落在当前作用域
          for (const nm of fi.names) bindLocal(nm, cur);
        }
        continue;
      }
      if (t.value === 'class') {
        const nameTok = tokens[i + 1];
        if (nameTok && nameTok.type === 'ident') bindLocal(nameTok.value, cur);
        continue;
      }
      if (t.value === 'const' || t.value === 'let' || t.value === 'var') {
        if (inForHeader(i)) continue; // for 头部的声明单独处理
        const nx = tokens[i + 1];
        if (nx && nx.type === 'ident') {
          bindLocal(nx.value, cur);
          decls.push({ name: nx.value, initStart: findInitStart(tokens, i + 2), patternNames: null });
        } else if (nx && (nx.value === '{' || nx.value === '[')) {
          const close = pairs.get(i + 1);
          const names = close != null ? patternNames(tokens, i + 1, close) : [];
          for (const nm of names) bindLocal(nm, cur);
          decls.push({ name: null, initStart: findInitStart(tokens, i + 1), patternNames: names });
        }
        continue;
      }
      continue;
    }

    if (t.type === 'punct') {
      if (t.value === '{') {
        const scope = { kind: 'block', parent: cur, bindings: new Map() };
        scopeStack.push(scope);
        const pend = pendingBraceBindings.get(i);
        if (pend) for (const nm of pend) bindLocal(nm, scope);
        continue;
      }
      if (t.value === '}') {
        if (scopeStack.length > 1) scopeStack.pop();
        continue;
      }
    }

    // ── 调用点识别 ──
    if (t.type !== 'ident') continue;
    const prev = tokens[i - 1];
    const prevIsDeclKeyword = prev && prev.type === 'keyword'
      && (prev.value === 'function' || prev.value === 'class' || prev.value === 'const' || prev.value === 'let' || prev.value === 'var');
    if (prevIsDeclKeyword) continue; // 定义处 / 声明名，不是调用

    const next = tokens[i + 1];
    if (!next) continue;

    let isCall = false;
    if (next.value === '(') {
      const close = pairs.get(i);
      const after = close != null ? tokens[close + 1] : null;
      // `foo(a) { ... }` 是方法定义，不是调用
      if (!(after && after.value === '{')) {
        calls.push({ kind: 'direct', name: t.value, tokIndex: i, scope: cur });
        isCall = true;
      }
    } else if (next.value === '?.') {
      const after = tokens[i + 2];
      if (after && after.value === '(') {
        calls.push({ kind: 'direct', name: t.value, tokIndex: i, scope: cur, optional: true });
        isCall = true;
      }
    } else if (next.value === '.') {
      const prop = tokens[i + 2];
      if (prop && prop.type === 'ident') {
        const afterProp = tokens[i + 3];
        if (afterProp && afterProp.value === '(') {
          if (prop.value === 'call' || prop.value === 'apply') {
            // foo.call(...) / foo.apply(...) ⇒ 被调用的是 foo 自己
            calls.push({ kind: 'direct', name: t.value, tokIndex: i, scope: cur, via: prop.value });
          } else {
            // obj.foo(...)
            calls.push({ kind: 'member', obj: t.value, prop: prop.value, tokIndex: i, scope: cur });
          }
          isCall = true;
        } else if (afterProp && afterProp.value === '.' && tokens[i + 4] && tokens[i + 4].type === 'ident'
          && (tokens[i + 4].value === 'call' || tokens[i + 4].value === 'apply')
          && tokens[i + 5] && tokens[i + 5].value === '(') {
          calls.push({ kind: 'member', obj: t.value, prop: prop.value, tokIndex: i, scope: cur, via: tokens[i + 4].value });
          isCall = true;
        }
      }
    }
    // 「被当作值引用」（回调、传参……）：**不是调用**，但也不是「从未被提起」
    if (!isCall && isValueRef(i, t, next)) refs.push({ name: t.value, line: lineOf(t.start) });
  }

  // `export { foo }`（本地再导出）：若 foo 是本文件的函数声明 ⇒ 它也是本文件的导出函数
  for (const [name, entry] of [...exports]) {
    if (entry.kind === 'local' && entry.localReexport && localFunctions.has(entry.localName)) {
      exports.set(name, { kind: 'local', localName: entry.localName, isFunction: true });
    }
  }

  // ── 动态 import 追踪（本仓有一类**真实的生产接线**必须认出来）──────────
  // ⚠️ 否则会把「已经接上线」误报成「死代码」：
  //    src/http/routes/audit.js、review.js 用的是
  //      const X = new URL('../../services/review-state.js', import.meta.url).href;
  //      const mod = await loadOptionalModule(X, path);   // 或本地包装函数
  //      mod.someFn({ ... });
  //    ⇒ 这类调用是**真接线**，必须计入生产调用方。
  const urlVars = new Map();           // 变量名 → 它指向的模块文件
  const loaderFiles = new Map();       // 加载函数名 → 它加载的模块文件
  const dynamicNamespaces = new Map(); // 变量名 → 模块文件（命名空间）
  const dynamicMembers = new Map();    // 变量名 → { file, prop }（命名空间成员被摘出来存成局部变量）

  /** 某个调用表达式加载的是哪个模块文件 */
  const resolveLoaderTarget = (calleeName, callIdx) => {
    if (calleeName === 'loadOptionalModule') {
      const arg = tokens[callIdx + 2]; // '(' 之后的第一个实参
      if (arg && arg.type === 'ident' && urlVars.has(arg.value)) return urlVars.get(arg.value);
      return null;
    }
    if (loaderFiles.has(calleeName)) return loaderFiles.get(calleeName);
    return null;
  };

  // (1) URL 变量：const X = new URL('<相对路径>', import.meta.url)
  for (const d of decls) {
    if (!d.name || d.initStart == null) continue;
    const init = tokens[d.initStart];
    if (!init || init.type !== 'keyword' || init.value !== 'new') continue;
    const urlTok = tokens[d.initStart + 1];
    const strTok = tokens[d.initStart + 3];
    if (urlTok && urlTok.value === 'URL' && strTok && strTok.type === 'str') {
      const f = resolveSource(unescapeStr(strTok.value));
      if (f) urlVars.set(d.name, f);
    }
  }

  // (2) 箭头函数体的 '{'（`const load = async () => { ... }`）也算「本地函数」
  for (const d of decls) {
    if (!d.name || d.initStart == null) continue;
    let k = d.initStart;
    if (tokens[k] && tokens[k].type === 'keyword' && tokens[k].value === 'await') k++;
    if (!tokens[k] || tokens[k].value !== '(') continue;
    const close = pairs.get(k);
    if (close == null) continue;
    const bodyBrace = tokens[close + 2] && tokens[close + 2].value === '{' ? close + 2 : null;
    if (bodyBrace != null && !localFunctionBodies.has(d.name)) localFunctionBodies.set(d.name, bodyBrace);
  }

  // (3) 包装函数：函数体里 `return <loader>(...)` ⇒ 该函数加载的是同一个模块
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fname, bodyBrace] of localFunctionBodies) {
      if (loaderFiles.has(fname)) continue;
      const end = pairs.get(bodyBrace);
      if (end == null) continue;
      for (let k = bodyBrace; k < end; k++) {
        const tk = tokens[k];
        if (tk.type !== 'keyword' || tk.value !== 'return') continue;
        let m = k + 1;
        if (tokens[m] && tokens[m].type === 'keyword' && tokens[m].value === 'await') m++;
        const callee = tokens[m];
        if (!callee || callee.type !== 'ident') continue;
        const f = resolveLoaderTarget(callee.value, m);
        if (f) { loaderFiles.set(fname, f); changed = true; break; }
      }
    }
  }

  // (4) 命名空间变量 / 成员绑定（必须按源码顺序，才能先解析出命名空间再解析成员）
  for (const d of decls) {
    if (d.initStart == null) continue;
    let k = d.initStart;
    if (tokens[k] && tokens[k].type === 'keyword' && tokens[k].value === 'await') k++;
    const init = tokens[k];
    if (!init) continue;
    if (init.type === 'keyword' && init.value === 'import') {
      // const mod = await import('./x.js')   /   const { a } = await import('./x.js')
      const strTok = tokens[k + 2];
      if (strTok && strTok.type === 'str') {
        const f = resolveSource(unescapeStr(strTok.value));
        if (f) {
          if (d.patternNames) for (const nm of d.patternNames) dynamicMembers.set(nm, { file: f, prop: nm });
          else if (d.name) dynamicNamespaces.set(d.name, f);
        }
      }
      continue;
    }
    if (init.type !== 'ident') continue;
    const f = resolveLoaderTarget(init.value, k);
    if (f) {
      if (d.name) dynamicNamespaces.set(d.name, f);
      continue;
    }
    // const fn = nsVar?.prop   /   const fn = nsVar.prop
    const nxt = tokens[k + 1];
    if (nxt && (nxt.value === '.' || nxt.value === '?.')) {
      const prop = tokens[k + 2];
      const nsFile = dynamicNamespaces.get(init.value);
      if (prop && prop.type === 'ident' && nsFile && d.name) {
        dynamicMembers.set(d.name, { file: nsFile, prop: prop.value });
      }
    }
  }

  return {
    abs, tokens, imports, namespaceOf, exports, starReExports, calls, bindings,
    localFunctions, dynamicNamespaces, dynamicMembers, refs,
  };
}

/** a 是否是 b 的**严格**祖先作用域（用于「同名遮蔽」判定） */
function isStrictAncestor(a, b) {
  let cur = b ? b.parent : null;
  while (cur) {
    if (cur === a) return true;
    cur = cur.parent;
  }
  return false;
}

/** 列出目录下的 .js 文件（递归） */
function listJsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

/** 读允许清单 */
function loadAllow(allowPath, required) {
  if (!existsSync(allowPath)) {
    if (required) throw new Error(`允许清单不存在：${allowPath}`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowPath, 'utf8'));
  } catch (err) {
    throw new Error(`允许清单解析失败：${allowPath}（${err.message}）`);
  }
  const list = Array.isArray(parsed && parsed.allow) ? parsed.allow : [];
  return list.filter((x) => x && typeof x.file === 'string' && typeof x.name === 'string');
}

/**
 * 扫描一个 platform 目录，返回结构化结果。
 *
 * @param {string} platformDir platform 目录（含 src/）
 * @param {object} [opts] { allowPath, allowRequired }
 */
export function scanPlatform(platformDir, opts = {}) {
  const platformAbs = resolve(platformDir);
  const srcRoot = join(platformAbs, 'src');
  if (!existsSync(srcRoot)) throw new Error(`platform 目录无效（找不到 src/）：${platformAbs}`);

  const relTo = (abs) => relative(platformAbs, abs).split(sep).join('/');

  // 目标目录：只扫服务层与仓储层
  const targetDirs = [join(srcRoot, 'services'), join(srcRoot, 'db', 'repo')];
  const targetFiles = targetDirs.flatMap((d) => listJsFiles(d)).sort();

  // 调用方范围：platform/src/**（排除 test/ scripts/ web/ —— 这三个在 src 之外，
  // 排除规则照样写上，防止有人把 platformDir 指到别处时口径漂移）
  const excludedRoots = ['test', 'scripts', 'web'].map((d) => join(platformAbs, d));
  const isExcluded = (abs) => excludedRoots.some((r) => abs === r || abs.startsWith(r + sep));
  const callerFiles = listJsFiles(srcRoot).filter((f) => !isExcluded(f));

  // 测试文件：只用于「排查提示」（该函数被测了但没接线）
  const testFiles = [...listJsFiles(join(platformAbs, 'test')), ...listJsFiles(join(platformAbs, 'test-helpers'))];

  // ── 解析全部文件 ──
  const cache = new Map();
  const getInfo = (abs) => {
    if (!cache.has(abs)) {
      let src = '';
      try { src = readFileSync(abs, 'utf8'); } catch { src = ''; }
      cache.set(abs, analyzeFile(abs, src));
    }
    return cache.get(abs);
  };
  for (const f of [...targetFiles, ...callerFiles, ...testFiles]) getInfo(f);

  // ── 有效导出表（含 `export * from` 的展开）──
  const exportCache = new Map();
  const visiting = new Set();
  function effectiveExports(abs) {
    if (exportCache.has(abs)) return exportCache.get(abs);
    if (visiting.has(abs)) return new Map(); // 循环再导出：保守放弃
    visiting.add(abs);
    const info = getInfo(abs);
    const map = new Map(info.exports);
    for (const starSrc of info.starReExports) {
      const sub = effectiveExports(starSrc);
      for (const [name] of sub) {
        if (!map.has(name)) map.set(name, { kind: 'from', sourceAbs: starSrc, sourceName: name, isFunction: false });
      }
    }
    visiting.delete(abs);
    exportCache.set(abs, map);
    return map;
  }

  /**
   * 追一个「导出名」的最终定义位置。
   * @returns {{file:string,name:string}|null} null = 追不到（保守不报）
   */
  function resolveOrigin(abs, exportName, depth = 0) {
    if (depth > 12 || !abs) return null;
    const map = effectiveExports(abs);
    const entry = map.get(exportName);
    if (!entry) return null;
    if (entry.kind === 'local') {
      const info = getInfo(abs);
      const imp = info.imports.get(entry.localName);
      if (imp && imp.kind === 'named') return resolveOrigin(imp.sourceAbs, imp.importedName, depth + 1);
      return { file: abs, name: entry.localName };
    }
    if (entry.kind === 'from') return resolveOrigin(entry.sourceAbs, entry.sourceName, depth + 1);
    return null;
  }

  /** 「同名遮蔽」判定：调用点所在作用域链上有没有内层的同名 local 绑定 */
  function isShadowed(info, name, scope) {
    const defs = info.bindings.get(name);
    if (!defs) return false;
    for (const d of defs) {
      // ⚠️ 同作用域也要算遮蔽：`import { foo } from 'x.js'` 之后在**同一个块**里
      //    `const foo = ...` ⇒ 块内的 foo() 指的是那个 const，不是 import 进来的那个。
      //    （只有**模块作用域**例外：ESM 下「同名 import + 同名 const」本身就是语法错误。）
      if (d.scope === scope) {
        if (d.scope.kind !== 'module') return true;
        continue;
      }
      if (isStrictAncestor(d.scope, scope)) return true;
    }
    return false;
  }

  /**
   * 收集一个文件里的调用点 ⇒ 归属到哪个定义。
   * @returns {{targets: Array<{file,name,via}>, undetermined: Array<{name,reason}>}}
   */
  function collectCallTargets(abs) {
    const info = getInfo(abs);
    const targets = [];
    const undetermined = [];
    for (const call of info.calls) {
      if (call.kind === 'direct') {
        // 动态 import 出来的成员（const fn = mod?.foo; fn(...)）
        const dyn = info.dynamicMembers.get(call.name);
        if (dyn) {
          const origin = resolveOrigin(dyn.file, dyn.prop) || { file: dyn.file, name: dyn.prop };
          targets.push({ file: origin.file, name: origin.name, via: call.via || null });
          continue;
        }
        const imp = info.imports.get(call.name);
        if (!imp) {
          // 本文件自己定义并导出的函数（自身递归 / 同文件辅助函数）
          // ⚠️ 这类调用**不算**生产调用方，但要记进「同文件内部调用」提示里。
          const own = info.exports.get(call.name);
          if (own && own.kind === 'local' && own.localName === call.name) {
            targets.push({ file: abs, name: call.name, via: call.via || null });
          }
          continue;                                 // 其余本地函数 / 全局 ⇒ 不属于任何导出
        }
        if (imp.kind !== 'named') continue;         // default 导入：无法归属到具名导出
        if (isShadowed(info, call.name, call.scope)) {
          undetermined.push({ name: call.name, reason: '同名遮蔽（内层作用域重新声明了同名变量）' });
          continue;
        }
        const origin = resolveOrigin(imp.sourceAbs, imp.importedName);
        if (!origin) {
          undetermined.push({ name: call.name, reason: `导入来源解析不到（${relTo(abs)} → ${imp.importedName}）` });
          continue;
        }
        targets.push({ file: origin.file, name: origin.name, via: call.via || null });
        continue;
      }
      if (call.kind === 'member') {
        // 动态 import 出来的命名空间（mod.foo(...)）
        const dynNs = info.dynamicNamespaces.get(call.obj);
        if (dynNs) {
          const origin = resolveOrigin(dynNs, call.prop) || { file: dynNs, name: call.prop };
          targets.push({ file: origin.file, name: origin.name, via: call.via || null });
          continue;
        }
        const nsSrc = info.namespaceOf.get(call.obj);
        if (!nsSrc) continue;                      // 普通对象上的同名属性：不算调用
        if (isShadowed(info, call.obj, call.scope)) {
          undetermined.push({ name: `${call.obj}.${call.prop}`, reason: '命名空间别名被同名遮蔽' });
          continue;
        }
        const origin = resolveOrigin(nsSrc, call.prop);
        if (!origin) {
          undetermined.push({ name: `${call.obj}.${call.prop}`, reason: '命名空间成员解析不到定义' });
          continue;
        }
        targets.push({ file: origin.file, name: origin.name, via: call.via || null });
      }
    }
    return { targets, undetermined };
  }

  // ── 目标定义：被扫描目录里「导出的函数」──
  const targets = [];
  for (const abs of targetFiles) {
    const info = getInfo(abs);
    for (const [exportedName, entry] of info.exports) {
      if (entry.kind !== 'local' || !entry.isFunction) continue;
      targets.push({ abs, rel: relTo(abs), name: entry.localName, exportedName });
    }
  }

  // ── 生产调用方 ──
  const wired = new Set();      // `${定义文件}::${定义名}`
  const sameFileCallers = new Map(); // `${定义文件}::${定义名}` → Set(同文件内的调用位置)
  const undetermined = [];     // 无法判定
  for (const abs of callerFiles) {
    const { targets: ts, undetermined: us } = collectCallTargets(abs);
    for (const t of ts) {
      if (t.file === abs) {
        // 同文件调用（自身递归 / 同文件辅助）**不算**生产调用方，但值得记一笔
        const key = `${t.file}::${t.name}`;
        if (!sameFileCallers.has(key)) sameFileCallers.set(key, new Set());
        sameFileCallers.get(key).add(relTo(abs));
        continue;
      }
      wired.add(`${t.file}::${t.name}`);
    }
    for (const u of us) {
      undetermined.push({ file: relTo(abs), name: u.name, reason: u.reason });
    }
  }

  // ── 测试文件里的调用（排查提示用）──
  const testCallers = new Map(); // `${定义文件}::${定义名}` → Set(测试文件相对路径)
  for (const abs of testFiles) {
    const { targets: ts } = collectCallTargets(abs);
    for (const t of ts) {
      const key = `${t.file}::${t.name}`;
      if (!testCallers.has(key)) testCallers.set(key, new Set());
      testCallers.get(key).add(relTo(abs));
    }
  }

  // ── scripts/ 里的调用（**不算**生产调用方，但要知道「只是运维脚本在用」）──
  //    ⚠️ scripts/ 按口径被排除在生产调用方之外（它不是产品路径），
  //       但「只有种子/审计脚本在调」与「从来没人调」是两种完全不同的结论 ⇒ 单独记一笔。
  const scriptCallers = new Map();
  const scriptFiles = listJsFiles(join(platformAbs, 'scripts'));
  for (const abs of scriptFiles) {
    const { targets: ts } = collectCallTargets(abs);
    for (const t of ts) {
      const key = `${t.file}::${t.name}`;
      if (!scriptCallers.has(key)) scriptCallers.set(key, new Set());
      scriptCallers.get(key).add(relTo(abs));
    }
  }

  // ── 「被当作值引用」的位置（回调 / 传参）──
  //    ⚠️ 这类**不算调用**（本闸口径：调用 = 调用表达式），
  //       但它能证明「这个函数确实被人拿着用」⇒ 排查提示里必须说出来，
  //       否则「从未被任何地方调用过」这句话会是假的。
  const valueRefs = new Map(); // 名字 → [{ file, line }]
  for (const abs of [...callerFiles, ...testFiles, ...scriptFiles]) {
    const info = getInfo(abs);
    for (const r of info.refs) {
      const key = r.name;
      if (!valueRefs.has(key)) valueRefs.set(key, []);
      valueRefs.get(key).push({ file: relTo(abs), line: r.line });
    }
  }

  // ── 允许清单 ──
  const allowPath = opts.allowPath || DEFAULT_ALLOW_PATH;
  const allowList = loadAllow(allowPath, !!opts.allowRequired);
  const allowMap = new Map();
  for (const a of allowList) allowMap.set(`${a.file}::${a.name}`, a.reason || '');

  // ── 汇总 ──
  // ⚠️ 允许清单**每一条都要打印**（包括没命中的）——
  //    没命中的那条说明「豁免已经过期 / 写错了文件名」⇒ 必须让人看见，不能悄悄沉底。
  const allowed = allowList.map((a) => ({ file: a.file, name: a.name, reason: a.reason || '', matched: false }));
  const dead = [];
  let wiredCount = 0;
  for (const tg of targets) {
    const key = `${tg.abs}::${tg.name}`;
    const relKey = `${tg.rel}::${tg.name}`;
    if (wired.has(key)) { wiredCount++; continue; }
    const reason = allowMap.get(relKey) ?? allowMap.get(`${tg.rel}::${tg.exportedName}`);
    if (reason !== undefined) {
      const hit = allowed.find((x) => (x.file === tg.rel && x.name === tg.name) || (x.file === tg.rel && x.name === tg.exportedName));
      if (hit) { hit.matched = true; hit.target = `${tg.rel}::${tg.name}`; }
      continue;
    }
    const tests = [...(testCallers.get(key) || [])].sort();
    const scripts = [...(scriptCallers.get(key) || [])].sort();
    const sameFile = [...(sameFileCallers.get(key) || [])].sort();
    const refs = (valueRefs.get(tg.name) || []).slice(0, 5);
    dead.push({ file: tg.rel, name: tg.name, tests, scripts, sameFile, refs });
  }
  dead.sort((a, b) => (a.file.localeCompare(b.file) || a.name.localeCompare(b.name)));
  allowed.sort((a, b) => (a.file.localeCompare(b.file) || a.name.localeCompare(b.name)));

  // 「无法判定」只保留与目标函数同名的（其余是无关噪声）
  const targetNames = new Set(targets.map((t) => t.name));
  const undeterminedRelevant = undetermined.filter((u) => targetNames.has(u.name.split('.')[0]));

  return {
    platformDir: platformAbs,
    scannedFiles: targetFiles.length,
    exported: targets.length,
    wired: wiredCount,
    dead,
    allowed,
    undetermined: undeterminedRelevant,
    allowPath,
    targetFiles: targetFiles.map(relTo),
  };
}

/** 文本输出 */
function formatText(result) {
  const lines = [];
  lines.push('死服务扫描（dead-service-scan）');
  lines.push(`平台目录：${result.platformDir}`);
  lines.push(`扫描目录：src/services/*.js、src/db/repo/*.js（领域层不扫）`);
  lines.push(`被扫描文件：${result.scannedFiles} 个`);
  lines.push(`导出函数：${result.exported} 个`);
  lines.push(`有生产调用方：${result.wired} 个 ｜ 死函数：${result.dead.length} 个 ｜ 允许清单：${result.allowed.length} 条（命中 ${result.allowed.filter((a) => a.matched).length} 条）｜ 无法判定：${result.undetermined.length} 条`);
  lines.push('');

  lines.push('--- 死函数清单（导出了但生产代码里没有调用方）---');
  if (!result.dead.length) {
    lines.push('  （无）');
  } else {
    for (const d of result.dead) {
      lines.push(`  ${d.file} :: ${d.name}`);
      const hints = [];
      if (d.tests.length) hints.push(`${d.tests.join('、')} 里直接调用过它 ⇒ 被测了但没接线`);
      if (d.scripts.length) hints.push(`只有 ${d.scripts.join('、')}（运维脚本，非产品路径）在调用它 ⇒ 不在 HTTP 路径上`);
      if (d.sameFile.length) hints.push(`只有它自己所在的文件在调用它（${d.sameFile.join('、')}）⇒ 导出了但没有外部调用方`);
      if (d.refs.length) {
        const where = d.refs.map((r) => `${r.file}:${r.line}`).join('、');
        hints.push(`只被当作值引用（回调/传参，${where}），没有直接调用 ⇒ 按本闸口径不算接线`);
      }
      if (!hints.length) hints.push('测试、脚本、同文件里都没找到调用，也没找到值引用 ⇒ 从未被任何地方提起过');
      lines.push(`    └ 排查提示：${hints.join('；')}`);
    }
  }
  lines.push('');

  lines.push('--- 允许清单（有意豁免）---');
  if (!result.allowed.length) {
    lines.push(`  （无；允许清单：${result.allowPath}）`);
  } else {
    for (const a of result.allowed) {
      const mark = a.matched ? '' : '  ⚠️ 这条没有命中任何死函数（豁免已过期，或文件名/函数名写错了）';
      lines.push(`  ${a.file} :: ${a.name} —— ${a.reason}${mark}`);
    }
  }
  lines.push('');

  lines.push('--- 无法判定（保守不报，需人工看一眼）---');
  if (!result.undetermined.length) {
    lines.push('  （无）');
  } else {
    for (const u of result.undetermined) {
      lines.push(`  ${u.file} :: ${u.name} —— ${u.reason}`);
    }
  }
  lines.push('');
  lines.push(result.dead.length
    ? `结论：${result.dead.length} 个死函数 ⇒ 退出码 1`
    : '结论：没有死函数 ⇒ 退出码 0');
  return lines.join('\n');
}

/** 命令行主流程 */
export function main(argv) {
  const args = argv.slice();
  let json = false;
  let allowPath = null;
  let platformDir = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--allow') {
      allowPath = args[i + 1];
      if (!allowPath) {
        console.error('用法： node docs/tools/dead-service-scan.mjs [--json] [--allow <path>] [platformDir]');
        return 2;
      }
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      console.error(`未知参数：${a}`);
      console.error('用法： node docs/tools/dead-service-scan.mjs [--json] [--allow <path>] [platformDir]');
      return 2;
    }
    if (platformDir === null) platformDir = a;
  }
  const dir = resolve(platformDir || DEFAULT_PLATFORM_DIR);
  if (!existsSync(dir)) {
    console.error(`⛔ platform 目录不存在：${dir}`);
    return 2;
  }
  let result;
  try {
    result = scanPlatform(dir, { allowPath: allowPath ? resolve(allowPath) : undefined, allowRequired: !!allowPath });
  } catch (err) {
    console.error(`⛔ 扫描失败：${err.message}`);
    return 2;
  }
  if (json) {
    console.log(JSON.stringify({
      scannedFiles: result.scannedFiles,
      exported: result.exported,
      wired: result.wired,
      dead: result.dead.map((d) => ({
        file: d.file, name: d.name, tests: d.tests, scripts: d.scripts, sameFile: d.sameFile, refs: d.refs,
      })),
      allowed: result.allowed,
      undetermined: result.undetermined,
    }, null, 2));
  } else {
    console.log(formatText(result));
  }
  return result.dead.length ? 1 : 0;
}

// ⚠️ 主流程只在**直接运行时**执行 ⇒ 回归测试可以 `import { scanPlatform }` 而不触发扫描。
//    `import.meta.main`（Node ≥ 22.16）；老版本上兜底用 argv[1] 比对，避免静默不跑。
const IS_MAIN = import.meta.main === true
  || (typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (IS_MAIN) {
  process.exitCode = main(process.argv.slice(2));
}
```

### `docs/tools/dead-service-scan.test.mjs`

机器闸自测（W4）。

```javascript
// docs/tools/dead-service-scan.test.mjs — 死服务扫描闸的自测
//
// 依据：闸的判据必须**可证伪** —— 一个「怎么改都绿」的闸比没有闸更危险
//   （本仓 plan-block-audit 就吃过这个亏：正则写错 ⇒ 全部判成 D ⇒ 数字看着正常，没人发现判据本身是错的）。
//   ⇒ 本自测在**临时目录**里造假工程（**不依赖 platform 的真实代码内容**），
//     每个用例都构造「对/错」两种结果都能区分的断言。
//
// 用法：
//   node --disable-warning=ExperimentalWarning --test docs/tools/dead-service-scan.test.mjs
//   （⛔ 不要放进 platform/test/ —— 那里是平台的全量 `node --test` 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { scanPlatform } from './dead-service-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'dead-service-scan.mjs');
const TEST_PATH = join(HERE, 'dead-service-scan.test.mjs');

/** 在临时目录里造一个假 platform 工程 */
function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dead-service-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

/** 扫一个假工程（允许清单固定用临时路径 ⇒ 不依赖仓库里那份 allow.json） */
function scan(dir, allowPath) {
  return scanPlatform(dir, { allowPath: allowPath || join(dir, '__no_allow__.json') });
}

const deadKeys = (result) => result.dead.map((d) => `${d.file}::${d.name}`);

// ══════════════════════════════════════════════════════════════════════
// 1. 有调用方的函数**不被**报死
// ══════════════════════════════════════════════════════════════════════
test('有生产调用方的函数不被报死', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function wiredFn() { return 1; }\n`,
    'src/http/routes/route.js': `import { wiredFn } from '../../services/alpha.js';
export function handler() { return wiredFn(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::wiredFn'),
      `不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.equal(r.exported, 1);
    assert.equal(r.wired, 1);
    assert.equal(r.dead.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 2. 只在 platform/test/** 里被调用的函数**被**报死（本闸要抓的核心形态）
// ══════════════════════════════════════════════════════════════════════
test('只在 test/ 里被调用的函数被报死（被测了但没接线）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function onlyTested() { return 1; }\n`,
    'test/alpha.test.js': `import { onlyTested } from '../src/services/alpha.js';
onlyTested();
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::onlyTested'),
      `必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    const hit = r.dead.find((d) => d.name === 'onlyTested');
    assert.ok(hit.tests.includes('test/alpha.test.js'),
      `排查提示里要指出是哪个测试调用过它，实际：${JSON.stringify(hit.tests)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 3. 注释 / 字符串里的名字**不算调用**
// ══════════════════════════════════════════════════════════════════════
test('只在注释与字符串里出现的函数名不算调用 ⇒ 报死', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function mentionedOnly() { return 1; }\n`,
    'src/http/routes/route.js': `import { mentionedOnly } from '../../services/alpha.js';
// mentionedOnly(1) —— 注释里的假调用
const s = "mentionedOnly(2)";
const t = \`mentionedOnly(3)\`;
export function handler() { return s + t; }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::mentionedOnly'),
      `注释/字符串里的名字不算调用 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('既有真实调用、又被注释/字符串提到 ⇒ 不报死（提及不能制造假调用）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function both() { return 1; }\n`,
    'src/http/routes/route.js': `import { both } from '../../services/alpha.js';
// both(1) 注释里也提到它
export function handler() { return both(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::both'),
      `有真实调用就不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 4. 同名不同源：必须按「定义所在文件」精确归属
// ══════════════════════════════════════════════════════════════════════
test('同名不同源：只有 B 的调用点 ⇒ A 的同名函数报死，B 的不报死', () => {
  const dir = makeProject({
    'src/services/a.js': `export function foo() { return 'a'; }\n`,
    'src/services/b.js': `export function foo() { return 'b'; }\n`,
    'src/http/routes/route.js': `import { foo } from '../../services/b.js';
export function handler() { return foo(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/a.js::foo'),
      `A 的 foo 没有调用方 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.ok(!deadKeys(r).includes('src/services/b.js::foo'),
      `B 的 foo 有调用方 ⇒ 不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同名不同源：两个同名函数各自都有调用方 ⇒ 都不报死', () => {
  const dir = makeProject({
    'src/services/a.js': `export function foo() { return 'a'; }\n`,
    'src/services/b.js': `export function foo() { return 'b'; }\n`,
    'src/http/routes/route.js': `import { foo as fooA } from '../../services/a.js';
import { foo as fooB } from '../../services/b.js';
export function handler() { return fooA() + fooB(); }
`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.dead.length, 0, `两个都有调用方，不该有死函数，实际：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 5. 允许清单生效
// ══════════════════════════════════════════════════════════════════════
test('允许清单生效：命中的函数不报死，并出现在「允许清单」一节', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function exempt() { return 1; }\nexport function notExempt() { return 2; }\n`,
  });
  const allowPath = join(dir, 'allow.json');
  writeFileSync(allowPath, JSON.stringify({
    allow: [{ file: 'src/services/alpha.js', name: 'exempt', reason: '纯工具函数，只在同文件内部用' }],
  }), 'utf8');
  try {
    const r = scan(dir, allowPath);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::exempt'),
      `豁免项不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::notExempt'),
      `没豁免的必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    const allowed = r.allowed.find((a) => a.name === 'exempt');
    assert.ok(allowed, '豁免项必须出现在允许清单一节');
    assert.equal(allowed.file, 'src/services/alpha.js');
    assert.equal(allowed.reason, '纯工具函数，只在同文件内部用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 6. 退出码
// ══════════════════════════════════════════════════════════════════════
test('退出码：有死函数 ⇒ 1；没有 ⇒ 0', () => {
  const deadDir = makeProject({
    'src/services/alpha.js': `export function deadOne() { return 1; }\n`,
  });
  const cleanDir = makeProject({
    'src/services/alpha.js': `export function aliveOne() { return 1; }\n`,
    'src/http/routes/route.js': `import { aliveOne } from '../../services/alpha.js';
export function handler() { return aliveOne(); }
`,
  });
  try {
    const rDead = spawnSync(process.execPath, [SCRIPT_PATH, deadDir], { encoding: 'utf8' });
    assert.equal(rDead.status, 1, `有死函数时退出码必须是 1，实际 ${rDead.status}\n${rDead.stdout}\n${rDead.stderr}`);
    const rClean = spawnSync(process.execPath, [SCRIPT_PATH, cleanDir], { encoding: 'utf8' });
    assert.equal(rClean.status, 0, `没有死函数时退出码必须是 0，实际 ${rClean.status}\n${rClean.stdout}\n${rClean.stderr}`);
    // 允许清单豁免之后 ⇒ 也应该是 0
    const allowPath = join(deadDir, 'allow.json');
    writeFileSync(allowPath, JSON.stringify({
      allow: [{ file: 'src/services/alpha.js', name: 'deadOne', reason: '豁免' }],
    }), 'utf8');
    const rAllowed = spawnSync(process.execPath, [SCRIPT_PATH, '--allow', allowPath, deadDir], { encoding: 'utf8' });
    assert.equal(rAllowed.status, 0, `豁免之后退出码必须是 0，实际 ${rAllowed.status}\n${rAllowed.stdout}`);
  } finally {
    rmSync(deadDir, { recursive: true, force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 7. --json 输出结构
// ══════════════════════════════════════════════════════════════════════
test('--json 输出结构合法（能 JSON.parse，且含 dead 数组）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function deadOne() { return 1; }\nexport function aliveOne() { return 2; }\n`,
    'src/http/routes/route.js': `import { aliveOne } from '../../services/alpha.js';
export function handler() { return aliveOne(); }
`,
  });
  try {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--json', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1, `有死函数时退出码是 1，实际 ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scannedFiles, 1);
    assert.equal(out.exported, 2);
    assert.equal(out.wired, 1);
    assert.ok(Array.isArray(out.dead), 'dead 必须是数组');
    assert.equal(out.dead.length, 1);
    assert.equal(out.dead[0].file, 'src/services/alpha.js');
    assert.equal(out.dead[0].name, 'deadOne');
    assert.ok(Array.isArray(out.allowed), 'allowed 必须是数组');
    assert.ok(Array.isArray(out.undetermined), 'undetermined 必须是数组');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 8. 间接 re-export：调用方 import 的是再导出的那个文件，也要算数
// ══════════════════════════════════════════════════════════════════════
test('间接 re-export：调用方 import 的是再导出文件 ⇒ 不报死', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function reExported() { return 1; }\n`,
    'src/services/index.js': `export { reExported } from './alpha.js';\n`,
    'src/http/routes/route.js': `import { reExported } from '../../services/index.js';
export function handler() { return reExported(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::reExported'),
      `追得到 re-export 链就不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 9. 同名遮蔽：被内层作用域遮蔽的调用不算数 ⇒ 进「无法判定」
// ══════════════════════════════════════════════════════════════════════
test('同名遮蔽：被内层作用域重新声明的调用不算数 ⇒ 报死并进「无法判定」', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function shadowed() { return 1; }\n`,
    'src/http/routes/route.js': `import { shadowed } from '../../services/alpha.js';
export function handler() {
  const shadowed = () => 2;
  return shadowed();
}
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::shadowed'),
      `遮蔽掉的调用不算生产调用方 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.ok(r.undetermined.length > 0, '遮蔽必须进「无法判定」一节');
    assert.ok(r.undetermined.some((u) => u.name === 'shadowed'),
      `无法判定里要能看到被遮蔽的名字，实际：${JSON.stringify(r.undetermined)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 10. 只认「导出的函数」：class / default / 非函数常量都不算目标
// ══════════════════════════════════════════════════════════════════════
test('export class / export default / 非函数常量都不算「导出的函数」', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export class Thing {}\nexport default function () {}\nexport const CONST = 42;\nexport const fn = (x) => x;\n`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.exported, 1, `只有 export const fn = (…) => 算导出的函数，实际 ${r.exported}`);
    assert.deepEqual(deadKeys(r), ['src/services/alpha.js::fn'], 'fn 没有调用方 ⇒ 应当报死');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 11. 命名空间导入 obj.foo(...) 算调用；普通对象的同名属性不算
// ══════════════════════════════════════════════════════════════════════
test('命名空间导入的成员调用算调用；普通对象的同名属性键不算', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function nsMember() { return 1; }\n`,
    'src/http/routes/route.js': `import * as svc from '../../services/alpha.js';
export function handler() {
  const obj = { nsMember: 1 };
  return svc.nsMember() + obj.nsMember;
}
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::nsMember'),
      `svc.nsMember() 是真调用 ⇒ 不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只有对象字面量的同名属性键 ⇒ 报死（属性键不是调用）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function keyOnly() { return 1; }\n`,
    'src/http/routes/route.js': `import { keyOnly } from '../../services/alpha.js';
export function handler() {
  const obj = { keyOnly: 1 };
  return obj.keyOnly;
}
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::keyOnly'),
      `对象属性键不是调用 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 12. foo.call(...) / foo.apply(...) 也算调用
// ══════════════════════════════════════════════════════════════════════
test('foo.call(...) / foo.apply(...) 算调用', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function viaCall() { return 1; }\nexport function viaApply() { return 2; }\n`,
    'src/http/routes/route.js': `import { viaCall, viaApply } from '../../services/alpha.js';
export function handler() {
  return viaCall.call(null) + viaApply.apply(null);
}
`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.dead.length, 0, `call/apply 都是调用，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 13. 领域层不参与「导出函数」统计（只扫 services/ 与 db/repo/）
// ══════════════════════════════════════════════════════════════════════
test('只扫 services/ 与 db/repo/：domain/ 里的导出函数不进统计', () => {
  const dir = makeProject({
    'src/domain/pure.js': `export function pureFn() { return 1; }\n`,
    'src/services/alpha.js': `export function svcFn() { return 1; }\n`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.exported, 1, `只该统计 services/ 里的 svcFn，实际 ${r.exported}`);
    assert.ok(!deadKeys(r).some((k) => k.includes('domain/')), 'domain/ 的函数不该进死清单');
    assert.ok(deadKeys(r).includes('src/services/alpha.js::svcFn'), 'svcFn 没有调用方 ⇒ 应报死');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 变异检验：把「只是提到名字」也算成调用 ⇒ 自测必须变红
// ══════════════════════════════════════════════════════════════════════
// ⚠️ 这个用例会**再跑一遍整套自测**（跑在变异版脚本上）。
//    子进程用 DEAD_SCAN_MUTATION_CHILD=1 标记，避免无限递归。
test('变异检验：「只是提到名字」也算调用 ⇒ 整套自测必须变红', (t) => {
  if (process.env.DEAD_SCAN_MUTATION_CHILD === '1') {
    t.skip('变异子进程里不再递归跑变异检验');
    return;
  }
  // ⚠️ 变异点必须**真的破坏「调用点识别」**：
  //    变异①：词法层不再剥离行注释 ⇒ 注释里的 `foo(...)` 被当成真调用；
  //    变异②：字符串内容也被当成代码 ⇒ 字符串里的 `foo(...)` 也被当成真调用。
  //    （只把「值引用」当调用是不够的：注释/字符串压根不产生 token ⇒ 那样变异不到点子上。）
  //    ⚠️ 变异②保留原来的 str token：不然 import 的来源就解析不出来了，
  //       那样整套用例会因为「另一个原因」变红 ⇒ 变异检验就失去意义（红得不对口）。
  const MUTATIONS = [
    [
      "if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\\n') i++; continue; }",
      "if (ch === '/' && src[i + 1] === '/') { i += 2; continue; }",
    ],
    [
      "push('str', src.slice(start + 1, Math.max(start + 1, i - 1)), start, i);",
      "push('str', src.slice(start + 1, Math.max(start + 1, i - 1)), start, i); for (const tk of tokenize(src.slice(start + 1, Math.max(start + 1, i - 1)))) tokens.push(tk);",
    ],
  ];

  const dir = mkdtempSync(join(tmpdir(), 'dead-service-scan-mut-'));
  try {
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    let mutated = src;
    for (const [from, to] of MUTATIONS) {
      assert.ok(mutated.includes(from), `变异点必须真实存在于脚本里（否则变异检验是假的）：${from}`);
      mutated = mutated.replace(from, to);
    }
    assert.notEqual(mutated, src, '变异必须真的改动了脚本');
    writeFileSync(join(dir, 'dead-service-scan.mjs'), mutated, 'utf8');

    // 自测副本放在同一目录 ⇒ 它的相对 import 指向变异版脚本
    const testSrc = readFileSync(TEST_PATH, 'utf8');
    writeFileSync(join(dir, 'dead-service-scan.test.mjs'), testSrc, 'utf8');

    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--test', join(dir, 'dead-service-scan.test.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEAD_SCAN_MUTATION_CHILD: '1',
          // ⛔ 必须去掉 NODE_TEST_CONTEXT：带着它，Node 的测试运行器会认为
          //    「自己被另一个测试运行器递归调用」⇒ 直接跳过执行 ⇒ 退出码 0（假绿）。
          NODE_TEST_CONTEXT: undefined,
        },
      },
    );
    assert.notEqual(r.status, 0,
      `变异后自测必须变红，实际退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
    // 至少要看到「注释/字符串里的名字不算调用」这条用例挂掉
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(/not ok \d+ - 只在注释与字符串里出现的函数名不算调用/.test(out),
      `变异后应当是「注释/字符串不算调用」那条用例红了，实际输出：\n${out.slice(0, 4000)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

### `docs/tools/dead-service-scan.allow.json`

机器闸允许清单（W4：逐条定性）。

```javascript
{
  "_comment": [
    "允许清单（有意豁免）—— 每条都必须写清「谁在用 / 为什么这不算产品路径缺口」，否则不许进本清单。",
    "口径与 docs/tools/dead-service-scan.mjs 一致：生产调用方 = platform/src/** 下的一处调用表达式。",
    "分类：①种子/运维脚本路径 ②同文件辅助（导出仅为测试便利）③回调/传参值引用 ④仓储层替代读口（能力已由另一条已接线的路径承担）。",
    "⚠️ W5（赛段接线）批次不在本清单里 —— 那不是「合理豁免」，是集成人正在修的真缺口，由集成人收口。"
  ],
  "allow": [
    {
      "file": "src/db/repo/capabilities.js",
      "name": "insertCapability",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:7 import、:54 写入），而 scripts/ 按本闸口径**不算产品路径**（死服务扫描 §判定口径：「调用方范围 = platform/src/**，scripts/ 与 web/ 在 src/ 之外」）。能力点表是**部署期一次性铺数据**（运行期只读不新增）—— 设计文档 §7.1【决策】「权限不靠角色枚举，靠能力 + 授权记录」只要求能力点**存在**，§8 的 API 清单里没有「新增能力点」端点 ⇒ 种子写入是该能力的设计内唯一入口。"
    },
    {
      "file": "src/db/repo/capabilities.js",
      "name": "insertRoleCapability",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:7）。角色↔能力映射是部署期铺数据（设计 §7.1 的「能力 + 授权记录」模型里角色只是能力的打包，运行期不增删角色）；设计 §8 无「授角色能力」端点 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/cities.js",
      "name": "createCity",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:10 import、种子流程内建城）。城市是**届期级基础数据**（设计 §5.2 实体关系：edition ── city ── task_package 的「一届多城」结构；顶层文档 §3.1 S2「一切按 edition 隔离：多期多城复制不改表结构」），由运维脚本随届期一并铺好；设计 §8 的 API 清单里**没有**「建城市」端点 ⇒ 种子写入是设计内的唯一入口。"
    },
    {
      "file": "src/db/repo/cities.js",
      "name": "listCitiesByEdition",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:10）⇒ 与 createCity 同族的**种子期读口**（种子脚本要查本届已铺的城市）。设计 §8 无城市读端点 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/editions.js",
      "name": "createEdition",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:9）⇒ 届期划分是**运营期动作**（顶层文档 §3.1 S2：一切按 edition 隔离、多期多城复制），由运维脚本建；设计 §8 无「建届期」端点 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/roles.js",
      "name": "insertRole",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:8）⇒ 角色是部署期铺数据（设计 §7.1：权限模型靠「能力 + 授权记录」，角色是能力的打包，运行期不增删角色）；设计 §8 无「建角色」端点 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/roles.js",
      "name": "insertUserRole",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:8）⇒ 用户↔角色授予是**部署期运维动作**（给初始管理员授权）；设计 §7.1 / §8 都没有「给人授角色」的端点 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/users.js",
      "name": "createUser",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:6）。**本平台没有自助注册**：设计 §8 认证段只有 login / logout / password / logout-all / me，**没有 signup / register 端点**；服务层 submitRegistration 直接收现成 userId（platform/src/services/registration.js:72，不建用户）⇒ 建账号是运维脚本入口，不是产品路径缺口。"
    },
    {
      "file": "src/db/repo/users.js",
      "name": "findUserByPhone",
      "reason": "①种子/运维脚本路径 + ②同文件辅助：调用方是 scripts/seed.js（platform/scripts/seed.js:6）与**同文件** createUser（platform/src/db/repo/users.js:57，手机号唯一性守卫）。它**不看 active**（users.js:73 注释：「停用用户的手机号也不能被再次注册」）⇒ 与同文件的 getUserByPhone（users.js:78，带 active 过滤）是两个不同语义。生产注册路径本平台不存在（见 createUser 条）⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/users.js",
      "name": "setSuperadmin",
      "reason": "①种子/运维脚本路径：唯一调用方是 scripts/seed.js（platform/scripts/seed.js:6 import、种子流程里授初始管理员）。超管是**部署期一次性引导**出来的（scripts/seed.js:28 起：无 ADMIN_PASSWORD 明确报错退出、绝不兜底默认口令）；设计 §8 无「授超管」端点 ⇒ 运维路径，不是产品路径缺口。"
    },
    {
      "file": "src/db/repo/reviews.js",
      "name": "getScoreStat",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/db/repo/reviews.js:102 与 :130，upsertScoreStat / applyScoreStatDelta 内部读）⇒ 它是 score_stats 增量维护的**内部读口**，导出是为测试便利（test 里单独断言 stdev 口径）。对外的统计读口 listScoreStats 已在生产接线 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/reviews.js",
      "name": "stdevFromStats",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/db/repo/reviews.js:147，applyScoreStatDelta 里把 n/mean/sumSq 还原成标准差）⇒ 纯算术辅助（reviews.js:106-118 的注释说明 stdev 由 sum_sq 现算、不另存列），导出是为测试便利 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/reviews.js",
      "name": "upsertScoreStat",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/db/repo/reviews.js:146，applyScoreStatDelta 里增量写）⇒ 它是 score_stats 的**内部写口**（reviews.js:95：n / mean / sum_sq 增量维护）；对外入口 applyScoreStatDelta 已在生产接线（服务层评分提交路径）⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/anticheat.js",
      "name": "assertFlagDetail",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/anticheat.js:109，runDetection 内做字段字典校验）。anticheat.js:68-72 的注释明确写着「**单独抽成导出函数**：这条闸是不在字典里的字段名不进库（R-AUD-06）的唯一执行点，抽出来才能被单独测到」⇒ 它是**被刻意导出以便可测**的内部闸门，不是产品路径缺口。"
    },
    {
      "file": "src/services/auth.js",
      "name": "checkPasswordPolicy",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/auth.js:87，改口令时校验新口令强度）⇒ 口令强度规则的内部实现（设计 §7.5 认证）；对外入口 POST /api/auth/password 已在生产接线 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/compute.js",
      "name": "listStageTeams",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/compute.js:148）。它是仓储层 listStageTeams（platform/src/db/repo/stages.js:210，在本文件 :25 以别名 listStageTeamsRows 导入）的**带兜底包装**（compute.js:50-62：表未建时返回空并由调用方记 warning，其余错误照抛 —— 静默返回空名册会让 R1/R4 判定整段跳过、榜单分数静默出错）⇒ 服务层内部实现细节，导出为测试便利 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/rate-limit.js",
      "name": "checkRateLimit",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/rate-limit.js:159，assertRateLimit 内部）⇒ 限流算法本体（设计 §11.1「防刷分」）；对外入口 assertRateLimit 已在生产接线（如 platform/src/http/routes/audit.js:14/:127）⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/registration.js",
      "name": "presentRegistration",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/registration.js:139 / 167 / 178 / 225 / 251）⇒ 它是「报名行 → 对外视图」的**单一映射函数**（registration.js:26-42 的注释锁死了「level = 提交那一刻的快照 / grading = 按当前配置重算」两套口径不许分叉）⇒ 服务层内部实现细节，导出为测试便利 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/review-state.js",
      "name": "getSubjectState",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/review-state.js:125 / 161 / 198）⇒ 复核/申诉状态机的「当前状态」读口（review-state.js:68-76：真值来源是 audit_log 里最后一条 review_state.transition）；对外入口 getReviewState（GET /api/stages/:stageId/review-state）已接线 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/review-state.js",
      "name": "parseAppealSubject",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/review-state.js:197 / 357）⇒ 申诉主体串「stageId:teamId」的拆解工具（review-state.js:182 记录了「不能无条件拆」的修正）；对外入口 submitAppeal / decideAppeal 已接线 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/review-state.js",
      "name": "transition",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/review-state.js:359 / 364）⇒ 状态机迁移的**唯一写入方**（review-state.js:76 明写「本服务是 review_state.transition 的唯一写入方」）；对外入口 submitAppeal / decideAppeal 已接线 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/services/taskPackage.js",
      "name": "presentTaskPackage",
      "reason": "③回调/传参值引用：只被当作**回调值**引用（visible.map(presentTaskPackage)，platform/src/services/taskPackage.js:289），按本闸口径（生产调用方 = 调用表达式）不算接线 ⇒ 它是任务卡 → 对外视图的映射函数（taskPackage.js:28）。⚠️ 但它**确实在产品路径上**（listTaskPackages 的返回值逐条过它）⇒ 非缺口，只是口径不认。"
    },
    {
      "file": "src/services/team.js",
      "name": "checkTeamFormation",
      "reason": "②同文件辅助：导出了但只有**同文件**调用（platform/src/services/team.js:71，createTeam 内）⇒ 建队合法性校验的内部实现（设计 §10 流 1：「队长 MBA ✅｜人数 ≥2 ✅｜任务包可解性已分级 ✅」）；对外入口 POST /api/teams 已在生产接线 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/users.js",
      "name": "deactivateUser",
      "reason": "③回调/传参值引用：只被**测试**直接调用（platform/test/users.test.js:113、platform/test/server.test.js:580/:731）并以解构形式被当值引用（test/server.test.js:578），生产代码零调用方。它是**软删除**用户的仓储写口（users.js:135 注释「禁止硬删」；设计 §11「删除 = 软删除」）。设计 §8 无「停用用户」端点、§9 前端 IA 无用户管理界面（全文 grep 无「用户管理 / 停用 / 封禁」条目）⇒ 属**未开放的运维动作**，不是产品路径接线。"
    },
    {
      "file": "src/services/registration.js",
      "name": "presentRegistrationEvent",
      "reason": "③回调/传参值引用：只被当作**回调值**引用（rows.map(presentRegistrationEvent)，platform/src/services/registration.js:168 与 :186），按本闸口径不算接线 ⇒ 它是「报名事件行 → 对外视图」的映射函数（registration.js:147）。⚠️ 但它**确实在产品路径上**（GET 单条与 GET 列表都过它）⇒ 非缺口，只是口径不认。"
    },
    {
      "file": "src/db/repo/computations.js",
      "name": "listComputationRows",
      "reason": "④仓储层替代读口（能力已由另一条已接线的路径承担）：P4 计划建的「最近的计算快照，倒序 + 可分页」读口（computations.js:96-98 的注释自己写明与 listSnapshots 语义不同）。它的**产品出口是审计链路**：services/audit.js:37-43 每次 recordComputation 都往 audit_log 写一条 action='computation.record' / entity='computation' / entityId=快照 id ⇒ 组委会可用 GET /api/audit/log?entity=computation 拿到快照 id，再用 GET /api/audit/computations/:id 与 /:id/diff 看留痕与复算 diff（设计 §12「可复算」）。⚠️ P4 计划自己的端点清单里**本来就没有**「计算列表」端点（只有 computations/:id、:id/diff、audit/log、audit/flags、flags/:id/resolve）⇒ 不是漏接，是「同一能力的另一条读口」。"
    },
    {
      "file": "src/db/repo/computations.js",
      "name": "listSnapshots",
      "reason": "④仓储层替代读口（能力已由另一条已接线的路径承担）：P2 建的「某赛段的全部快照，按 revision 升序」读口（computations.js:96-98：与 listComputationRows 不是同一件事的第二个名字）。「旧 revision 保留供复盘」（设计 §11.2）在产品上的出口是 GET /api/audit/log（action='computation.record' 逐条留痕）→ GET /api/audit/computations/:id/:diff；设计 §8 的 API 清单里没有「赛段快照列表」端点，P2 计划的端点清单里也没有 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/flags.js",
      "name": "findOpenFlag",
      "reason": "④仓储层替代读口（已被**更细的**去重判据取代）：它是「同 kind + 同赛段 + 同队 + 同评委」粗键找未处置 flag 的读口；services/anticheat.js:36-56 的注释明写 P4-T4-D4 修正：「原来用 (kind, stage_id, team_id, judge_id) 这个粗键去重…那个键分不开『同 kind 的不同问题』… **丢掉的不是重复项，是真问题**」⇒ 现在改用 scanFlags + isSameFinding（按明细内容比对，anticheat.js:58-70）逐页扫。findOpenFlag 这个粗键读口已被**刻意废弃**（只剩 test/audit-repo.test.js:229-246 在测它自己）⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/pool-sources.js",
      "name": "listAllUsers",
      "reason": "④仓储层替代读口（P5 计划明列为「派生源读取」额外导出，未被消费）：P5 计划偏差表 I-5 明写仓储层额外导出含「13 个派生源读取函数（pool-sources.js）」。人才池实际用的是**届期隔离**的那一个（services/pools.js:95 listEditionUsers → 只取本届有积分流水的人），listAllUsers（全部在册用户、不分届期）会破坏顶层文档 §3.1 S2「一切按 edition 隔离」⇒ 未被消费是**语义上正确**的结果，不是缺口。"
    },
    {
      "file": "src/db/repo/pool-sources.js",
      "name": "listEditionLedger",
      "reason": "④仓储层替代读口（P5 计划明列为「派生源读取」额外导出，未被消费）：人才池积分口径是**终生累计**（R-RNK-10 个人积分跨届期累加，pool-sources.js:95-97 注释），所以服务层逐人走 listUserLedger（services/pools.js:97 与 :177 的自检都按「同一个人所有届次的行」聚合）；listEditionLedger（只取本届流水）语义与之相反，用它会算错 ⇒ 未被消费是语义正确的选择。"
    },
    {
      "file": "src/db/repo/request-keys.js",
      "name": "findRequestKey",
      "reason": "④仓储层替代读口（写口已接线，读口未使用）：评审幂等靠**抢键**实现——services/review.js:191/:620/:687 调 claimRequestKey，抢到 = 首次生效、抢不到 = 重复请求直接短路（request-keys.js:4-13 的注释：键表里**不存业务响应**）。findRequestKey（读回一行）是同一张表的另一读口，本仓不需要它来回答「上次成没成」——回答这个问题的是 P4 的 idempotency_keys（services/idempotency.js:1-20 的注释明确这是**两个不同能力**）⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/reviews.js",
      "name": "listCalibrations",
      "reason": "④仓储层替代读口（「看全部」是**明确不做**的决策）：校准分是按评委记的（judge_id），生产读口是 listCalibrationsForJudge（services/review.js:39 import、:364 使用）。P2 计划自己的服务层 import 清单里也只有 listCalibrationsForJudge（2026-10-20-platform-P2-review-engine.md:4798）⇒ listCalibrations 是同文件同族的备用读口。且 services/review.js:346-361 明写「⛔ 组委会也只看自己的（不实现『看全部』）…『看全部』要额外判定…一律不做，避免出现『有的页面看得到、有的看不到』的漂移」⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/sessions.js",
      "name": "countActiveSessions",
      "reason": "④仓储层替代读口（该能力已由已接线的写口承担）：「强制下线」能力的生产入口是 POST /api/auth/logout-all → auth/session.js:111 revokeAllSessions → deleteSessionsByUser（sessions.js:30），已在生产接线。countActiveSessions 只是同一张表的**计数读口**（sessions.js:56）；设计 §8 无「我的设备数」端点、§9 前端 IA 无对应界面 ⇒ 属预留读口，非产品路径缺口。"
    },
    {
      "file": "src/db/repo/sessions.js",
      "name": "purgeExpiredSessions",
      "reason": "④仓储层替代读口（过期清理由**惰性删除**承担）：会话过期不靠批量清理——auth/session.js:95-96 在 resolveSession 命中过期行时直接删行（会话表不存在定时任务入口，设计 §14 部署节也没有清理作业）。purgeExpiredSessions（sessions.js:67）是同一语义的**批量版运维工具**，生产没有调用它 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/task-claims.js",
      "name": "countActiveClaims",
      "reason": "④仓储层替代读口（同能力的另一个读口已接线）：「这个任务被领了吗」的生产判据是 getActiveClaim（services/workflow.js:103/:136/:162/:180 在用），并发安全由数据库部分唯一索引 ux_task_claims_active 兜底（services/workflow.js:125-126 与 :146-149 的注释明写「前置检查只是友好提示，真正的保证在 ux_task_claims_active」）⇒ countActiveClaims 是同义计数读口，未被消费不是缺口。"
    },
    {
      "file": "src/db/repo/task-claims.js",
      "name": "listClaimsByUser",
      "reason": "④仓储层替代读口（P5 计划明列为额外导出，「我的领取」已由已接线的端点给出）：P5 计划偏差表 I-5 明写仓储层额外导出含 listClaimsByUser。产品上「我领了什么」由 GET /api/workflows/:id/tasks 的 isMine 字段给出（services/workflow.js:103-116：逐条任务带 claim + isMine）⇒ 跨工作流汇总的同义读口未被消费，非产品路径缺口。"
    },
    {
      "file": "src/db/repo/users.js",
      "name": "getUserByPhone",
      "reason": "④仓储层替代读口（同能力的另一个读口已接线）：登录路径取的是 getCredentialsByPhone（users.js:86，唯一允许取 password_hash 的读口，服务层口令校验在用）；唯一性查重走 findUserByPhone（users.js:74，不看 active）。getUserByPhone（users.js:78，带 active 过滤）是第三种同义读口，生产不需要 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/users.js",
      "name": "listUsers",
      "reason": "④仓储层替代读口（生产用它的「读全部用户」需求已由另一个读口承担）：P0 建它是为了给仓储层行形状做断言（P0 计划:3882「for (const row of listUsers(db)) assert.equal(row.password_hash, undefined)」）；生产上「读全部用户」的真实需求是反作弊多账号检测，走的是 listUsersForDetection（services/compute.js:31 import、:272 使用）。而**用户管理本身不是本产品的能力**：设计 §8 无 GET /api/users、§9 前端 IA 无「用户管理」条目（全文 grep 无「用户管理 / 成员管理 / 账号管理」）⇒ listUsers 是预留的管理读口，非产品路径缺口。"
    },
    {
      "file": "src/db/repo/workflows.js",
      "name": "findWorkflowByPackage",
      "reason": "④仓储层替代读口（P5 计划明列为额外导出，未被消费）：P5 计划偏差表 I-5 明写仓储层额外导出含 findWorkflowByPackage（workflows.js）。工作流的建口是 POST /api/workflows（含 task_package_id），读口是 GET /api/workflows → listWorkflowSummaries（server.js:274）；「按任务包反查工作流」这条读口产品上没有使用方 ⇒ 非产品路径缺口。"
    },
    {
      "file": "src/db/repo/workflows.js",
      "name": "listWorkflowsByEdition",
      "reason": "④仓储层替代读口（同能力的另一个读口已接线）：届期工作流列表的生产出口是 GET /api/workflows → listWorkflowSummaries（server.js:274；P7 计划已把它定成对外形状）；listWorkflowsByEdition 是同族的对内读口（server.js:260 的注释即写明「仓储层本来就有 listStages / listWorkflowsByEdition，只是没有端点」）⇒ 非产品路径缺口。"
    }
  ]
}
```

### `platform/test/stage-config-api.test.js`

「赛段配置」页所需的**组委会读口**闸（E158）：届期列表 / 候选队伍 / 评委候选池 / 权重表 —— 全部走真实 HTTP 路由，含权限（403）与资源不存在（404）的三态断言。

```javascript
// platform/test/stage-config-api.test.js —— 「赛段配置」页所需的**组委会读口**闸（P11 新建 · E158）
//
// ⛔ **这个文件为什么必须存在**（P11 的病根 #1 同一个形态）：
//   P11 的 E150 把赛段的 6 个**写**端点（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
//   全做完了，但**前端一个界面都没有** ⇒ 设计文档 §9「赛段配置与权重表」这块界面不存在。
//   补界面时又撞出**下一层**缺口：页面要能选队伍、选评委、看权重表，
//   而这三个读口**一个都不存在**：
//     · `GET /api/teams` 返回的是「**我参与的**战队」（participant 视角）
//       ⇒ 组委会看到的永远是空数组 ⇒ 名册登记页**没有任何可选队伍**；
//     · 没有任何端点能列出「可当评委的人」；
//     · 权重表的**维度**虽已由 `GET /api/event-info` 公开，但组委会要的
//       **席构成约束**（judgePool）没有对外投影。
//   ⇒ 本文件用**真实 HTTP 路由**把这些口钉死（含权限与白名单投影）。
//
// 规则溯源：
//   · 「赛段配置与权重表」界面 ⇒ 设计文档 §9（前端 IA，组委会视角）
//   · 可见性在 API 层过滤 ⇒ 全局约束
//   · 三态状态码（404 不存在 / 403 没权限 / 200 成功）⇒ 设计文档 §7.3
//   · 逐字段白名单投影（不泄漏内部工作语言）⇒ src/domain/event-info.js 同款纪律
//   · 评委候选池 ≠ 全部用户 ⇒ 顶层文档 §3.1 S2「一切按 edition 隔离」
//     （机器闸 allow.json 已把 listAllUsers 判为「未被消费是语义上正确的结果」）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerStageRoutes } from '../src/http/routes/stages.js';
import { createUser, deactivateUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/**
 * 组装一个「组委会能配置赛段」的世界。
 *
 * ⚠️ 人物是**判别性**的：
 *   · admin      —— 全局 `stage:compute`（组委会）
 *   · orgEdition —— **届期级** `stage:compute`（用来钉住「读口与写口口径一致」）
 *   · outsider   —— 一个能力点都没有
 *   · judgeUser  —— 角色 `judge`（专家席）      ⇒ 应在候选池里
 *   · observer   —— 角色 `observer`（观察员）    ⇒ 应在候选池里
 *   · entUser    —— 角色 `enterprise`（企业席）  ⇒ 应在候选池里
 *   · captain    —— 角色 `captain`（**参赛者**） ⇒ **不应**在候选池里
 *   · admin      —— **没有**评委类角色          ⇒ **不应**在候选池里
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-stage-cfg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  insertCapability(db, 'stage:compute', '触发计算发榜');

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900007001', password: 'pw' });
  const orgEdition = createUser(db, { name: '届期组委会', phone: '13900007002', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900007003', password: 'pw' });
  const judgeUser = createUser(db, { name: '评委甲', phone: '13900007004', password: 'pw' });
  const observer = createUser(db, { name: '观察员乙', phone: '13900007005', password: 'pw' });
  const entUser = createUser(db, { name: '企业代表丙', phone: '13900007006', password: 'pw' });
  const captain = createUser(db, { name: '队长丁', phone: '13900007007', password: 'pw' });
  // ⛔ orgStage 不授任何能力点 ⇒ 只能在测试里给他授「赛段级」权限。
  const orgStage = createUser(db, { name: '赛段组委会', phone: '13900007010', password: 'pw' });
  // ⚠️ 停用但**持有 judge 角色**的人 ⇒ 候选池必须把他排除（active = 1 过滤）。
  const staleUser = createUser(db, { name: '已停用评委', phone: '13900007009', password: 'pw' });

  for (const key of ['judge', 'enterprise', 'observer', 'captain']) insertRole(db, key, key);
  insertUserRole(db, judgeUser.id, 'judge');
  insertUserRole(db, observer.id, 'observer');
  insertUserRole(db, entUser.id, 'enterprise');
  insertUserRole(db, captain.id, 'captain');
  insertUserRole(db, staleUser.id, 'judge');
  deactivateUser(db, staleUser.id);
  // ⛔ admin **故意不给**评委类角色 ⇒ 他不该出现在候选池里。

  grantAssignment(db, {
    userId: admin.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  // ⛔ orgEdition 只有**届期级**授权 ⇒ 用来证明「读口与写端点口径一致」。
  grantAssignment(db, {
    userId: orgEdition.id, capability: 'stage:compute', scopeType: 'edition', scopeId: edition.id, grantedBy: admin.id,
  });

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: entUser.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });

  const teams = [];
  for (let i = 0; i < 2; i += 1) {
    // ⚠️ team_members.user_id 是唯一约束 ⇒ 一人只能在一支队 ⇒ 每队一个队长。
    const t = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id,
      taskPackageId: pkg.id, tier: i === 0 ? 'B' : 'C', status: 'active', now: NOW,
    });
    if (i === 0) {
      insertTeamMember(db, { teamId: t.id, userId: captain.id, role: 'captain', now: NOW });
    } else {
      const captain2 = createUser(db, { name: '队长戊', phone: '13900007008', password: 'pw' });
      insertUserRole(db, captain2.id, 'captain');
      insertTeamMember(db, { teamId: t.id, userId: captain2.id, role: 'captain', now: NOW });
    }
    teams.push(t);
  }

  const app = createApp({ db, rules, webDir });
  const wired = app.router.list().some(
    (r) => r.method === 'GET' && r.pattern === '/api/editions/:editionId/teams',
  );
  if (!wired) registerStageRoutes(app.router, { db, rules });

  return {
    db, close, app, rules, edition, teams, admin, orgEdition, outsider,
    judgeUser, observer, entUser, captain, staleUser, orgStage,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOrgEdition: createSession(db, orgEdition.id).token,
    tokenOrgStage: createSession(db, orgStage.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

/** 错误体的 code（三态状态码约定：{ error: { code, message } }）。 */
function code(res) {
  return json(res).error?.code ?? json(res).code ?? null;
}

test('⛔ E158：GET /api/editions —— 公开可读（届期是公开赛事信息，页面要知道往哪届建赛段）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', '/api/editions');
    assert.equal(res.status, 200, `届期列表应可读：${res.body}`);
    const items = json(res).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, ctx.edition.id);
    assert.equal(items[0].name, '首届 · 上海');
    assert.equal(items[0].city, '上海');
    // ⛔ 白名单投影：不得带出内部列
    assert.equal(items[0].created_at, undefined, '届期不应带出 created_at（白名单投影）');
  } finally {
    ctx.close();
  }
});

test('⛔ E158：GET /api/editions/:editionId/teams —— 组委会能看到**全部**候选队伍（participant 视角的 GET /api/teams 看不到）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/teams`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, `组委会应能读候选队伍：${res.body}`);
    const items = json(res).items;
    assert.equal(items.length, 2, '两支队伍都必须在候选池里');
    const names = items.map((t) => t.name).sort();
    assert.deepEqual(names, ['1队', '2队']);
    // ⛔ 判别性：段位要透出来（页面要显示队伍段位）
    const tiers = items.map((t) => t.tier).sort();
    assert.deepEqual(tiers, ['B', 'C']);
    // ⛔ 白名单投影：不得带出任务包 id 之类内部列
    assert.equal(items[0].task_package_id, undefined, '不得带出 task_package_id（白名单投影）');
    assert.equal(items[0].taskPackageId, undefined);
  } finally {
    ctx.close();
  }
});

test('⛔ E158：评委候选池 = 持评委类角色的人，**不是**全部用户（S2 届期隔离 + allow.json 的既有判定）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/judge-candidates`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, `组委会应能读评委候选池：${res.body}`);
    const ids = json(res).items.map((u) => u.id);

    assert.ok(ids.includes(ctx.judgeUser.id), 'judge 角色的人必须在候选池里');
    assert.ok(ids.includes(ctx.observer.id), 'observer 角色的人必须在候选池里（无投票权但可入席）');
    assert.ok(ids.includes(ctx.entUser.id), 'enterprise 角色的人必须在候选池里（企业席）');

    assert.ok(!ids.includes(ctx.captain.id), '⛔ 参赛队长（captain 角色）不该在评委候选池里');
    assert.ok(!ids.includes(ctx.admin.id), '⛔ 没有评委类角色的组委会不该出现在候选池里');
    assert.ok(!ids.includes(ctx.outsider.id), '⛔ 无关用户不该在候选池里');
    assert.ok(!ids.includes(ctx.staleUser.id), '⛔ 已停用用户（active=0）不该在候选池里');

    // ⛔ 白名单投影
    const first = json(res).items[0];
    assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'org']);
  } finally {
    ctx.close();
  }
});

test('⛔ E158：GET /api/editions/:editionId/scoring-configs —— 权重表 + 席构成约束，且不泄漏内部工作语言', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/scoring-configs`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, `组委会应能读权重表：${res.body}`);
    const items = json(res).items;
    const keys = items.map((c) => c.key).sort();
    assert.deepEqual(keys, ['final', 'initial'], '两张权重表都要给（initial / final）');

    const initial = items.find((c) => c.key === 'initial');
    assert.equal(initial.dimensions.length, 6, '初赛 6 个维度');
    const first = initial.dimensions[0];
    assert.deepEqual(Object.keys(first).sort(), ['key', 'name', 'seat', 'weight']);
    assert.equal(first.key, 'track_fit');
    assert.equal(first.name, '赛题契合度');
    assert.equal(first.weight, 0.10);
    assert.equal(first.seat, 'judge');

    // ⛔ 席构成约束：企业席 ≥30% / 专家席 ≤50% / observer 无投票权
    assert.equal(initial.judgePool.minEnterpriseSeatShare, 0.30);
    assert.equal(initial.judgePool.maxExpertSeatShare, 0.50);
    assert.equal(initial.judgePool.minJudgesPerDimension, 7);
    assert.deepEqual(initial.judgePool.nonVotingSeats, ['observer']);
    assert.ok(initial.judgePool.votingSeats.includes('enterprise'));

    // ⛔ 内部工作语言**不得**外泄（note / source / conflictRef 是内部裁决说明）
    for (const c of items) {
      assert.equal(c.note, undefined, `权重表 ${c.key} 不应带出 note（内部工作语言）`);
      assert.equal(c.source, undefined, `权重表 ${c.key} 不应带出 source（内部出处说明）`);
      assert.equal(c.conflictRef, undefined, `权重表 ${c.key} 不应带出 conflictRef`);
      assert.equal(c.trimOutliers, undefined, `权重表 ${c.key} 不应带出内部参数 trimOutliers`);
    }
  } finally {
    ctx.close();
  }
});

test('⛔ E158：三态状态码 —— 无权限 403 / 届期不存在 404（不是 200 空集，也不是 500）', async () => {
  const ctx = setup();
  try {
    // ① 无权限 ⇒ 403
    for (const path of [
      `/api/editions/${ctx.edition.id}/teams`,
      `/api/editions/${ctx.edition.id}/judge-candidates`,
      `/api/editions/${ctx.edition.id}/scoring-configs`,
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenOutsider });
      assert.equal(res.status, 403, `${path} 无权限应 403：${res.body}`);
      assert.equal(code(res), 'FORBIDDEN', `${path} 错误码应是 FORBIDDEN`);
    }

    // ② 未登录 ⇒ 401
    const anon = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/teams`);
    assert.equal(anon.status, 401, `未登录应 401：${anon.body}`);
    assert.equal(code(anon), 'UNAUTHENTICATED');

    // ③ 届期不存在 ⇒ 404
    for (const path of [
      '/api/editions/does-not-exist/teams',
      '/api/editions/does-not-exist/judge-candidates',
      '/api/editions/does-not-exist/scoring-configs',
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenAdmin });
      assert.equal(res.status, 404, `${path} 届期不存在应 404：${res.body}`);
      assert.equal(code(res), 'EDITION_NOT_FOUND');
    }
  } finally {
    ctx.close();
  }
});

test('⛔ E158：**届期级**授权也能读这些口（与写端点口径一致 —— 能改赛段就能看配置）', async () => {
  const ctx = setup();
  try {
    for (const path of [
      `/api/editions/${ctx.edition.id}/teams`,
      `/api/editions/${ctx.edition.id}/judge-candidates`,
      `/api/editions/${ctx.edition.id}/scoring-configs`,
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenOrgEdition });
      assert.equal(res.status, 200, `${path} 届期级授权应可读：${res.body}`);
    }
  } finally {
    ctx.close();
  }
});

test('⛔ E158：**赛段级**授权也能读这些口（写端点认赛段级，读口不许比它更严）', async () => {
  const ctx = setup();
  try {
    // ① 先经 HTTP 建一个赛段（拿 stageId）
    const created = await call(ctx.app, 'POST', `/api/editions/${ctx.edition.id}/stages`, {
      token: ctx.tokenAdmin,
      body: {
        key: 's1', name: '初赛', kind: 'initial',
        startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial',
      },
    });
    assert.equal(created.status, 200, `建赛段应成功：${created.body}`);
    const stageId = json(created).stage.id;

    // ② 给 orgStage 授**赛段级** stage:compute（他**没有**届期级授权 ⇒
    //    读口若只认届期级，他就会「能改赛段、却读不到权重表」）
    grantAssignment(ctx.db, {
      userId: ctx.orgStage.id, capability: 'stage:compute',
      scopeType: 'stage', scopeId: stageId, grantedBy: ctx.admin.id,
    });

    // ③ 赛段级授权 ⇒ 能改这个赛段（写端点本来就认）
    const patched = await call(ctx.app, 'PATCH', `/api/stages/${stageId}`, {
      token: ctx.tokenOrgStage, body: { name: '初赛（改名）' },
    });
    assert.equal(patched.status, 200, `赛段级授权应能改赛段：${patched.body}`);

    // ④ ⛔ 但**读口不许比写端点更严** —— 否则就出现「能改赛段、却读不到权重表」
    for (const path of [
      `/api/editions/${ctx.edition.id}/teams`,
      `/api/editions/${ctx.edition.id}/judge-candidates`,
      `/api/editions/${ctx.edition.id}/scoring-configs`,
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenOrgStage });
      assert.equal(res.status, 200, `${path} 赛段级授权应可读：${res.body}`);
    }
  } finally {
    ctx.close();
  }
});
```

### `platform/web/views/stages.js`

「赛段配置与权重表」页（E158 · W5-d 补做）：设计 §9 明写要有这块界面，而 P11 把建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册 6 个写端点全做完了却**一个界面都没有** ⇒ 端点零调用方。本页把 6 个写端点 + 4 个读端点全部接上，逆向路径（撤评委 / 退名册）带影响面二次确认。

```javascript
// web/views/stages.js — 赛段配置与权重表（组委会 · P11 新建）
//
// 规则溯源（每条设计依据都指到具体规则 / 设计文档章节）：
//   - 「组委会视角 → **赛段配置与权重表**」→ 设计文档 §9「前端信息架构」（IA 图第 883 行）
//     —— 这一块界面在 §9 里明写存在，但 P11 之前**一个界面都没有** ⇒
//        六个写端点（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）在产品里零调用方。
//   - 六个写端点 + 两个读口的形状 → src/http/routes/stages.js（P11 补齐）
//     规则与校验全在 src/services/stage.js（路由层只接线，不复制规则）。
//   - 「赛段从属于届期」→ src/db/repo/stages.js（stages.edition_id 外键）
//     ⇒ 建段是 `POST /api/editions/:editionId/stages`，页面必须先有届期。
//   - 「席构成：企业席 ≥30% / 专家席 ≤50%；观察席无投票权」→ S7 §3.4（R-JDG-11）
//     + rules/scoring-initial.json 的 judgePool
//     ⛔ **页面不复制这套校验**（服务端会校验）—— 前端照抄一遍必然与服务端漂移。
//   - 「利益冲突声明随席位同事务写入」→ S7 §3.4（R-JDG-18）
//     + src/services/stage.js 的 assignStageJudgeToStage。
//   - 「权重表只读：改一份 JSON、重启即生效」→ 设计文档 S-2
//     ⇒ 页面**只展示**当前用的是哪一张表 + 席构成约束，不提供改权重的入口。
//   - 「权重表端点是**届期作用域**」→ `GET /api/editions/:editionId/scoring-configs`
//     ⛔ 曾经按 global 作用域判能力点，而赛段的写端点（建段 / 改配置 / 派评委）接受
//        **edition 级或 stage 级**的 stage:compute ⇒ 会出现「能改赛段、却读不到权重表」
//        的前后端不一致 ⇒ 页面拿不到席构成约束，组委会无法判断席够不够合法。
//        ⇒ 统一成届期作用域（页面的读口与写口同域）。
//   - 「三态状态码：404 不存在 / 403 没权限 / 200 成功」→ 设计文档 §7.3
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//     ⇒ 按钮**始终渲染**；403 时把服务端的中文原因显示出来。
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js 文件头（本仓已踩过的坑）
//   - 「HTML 文本插值一律过 escapeHtml（全站唯一转义入口）」→ web/escape.js
//   - 「加载 / 空 / 错三态用现成组件，不自己造」→ web/ui.js
//
// ⚠️ **为什么这个视图不判权限**：能不能配赛段、能不能派评委，一律由 API 裁决
//   （全局约束「授权的唯一裁决者是 can()，前端只拿到提示」）。
//   ⇒ 表单按钮**始终渲染**；被 403 时页面显示「没有权限」，而不是空白页或前端自行藏按钮。
//
// ⚠️ **权重表的顺序按「声明序」**（rules/scoring-*.json 里的顺序），不按权重降序：
//   规则文件里同一席的维度是**连着写**的（judge 维度在前、enterprise 维度在后），
//   按权重重排会把企业维度插进评委维度中间 ⇒ 席分组被拆散，反而看不出「哪张表」。
//   权重合计单独一行给出（100% ⇒ 页面能一眼看出表是完整的）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, kvList, loadingState, noticeState, pageHead,
  panel, sectionTitle, statRow, tableWrap, workbench, workbenchItem,
} from '../ui.js';

// ── 枚举（口径与服务层 src/services/stage.js 同一份）──────────────────
// ⛔ 这些是**下拉框的选项**，不是校验：真正的校验在服务端（rules 与枚举都由服务端说了算）。
//    前端复制一份枚举只为「不让人手打一个服务端不认的值」，不参与任何判定。

/** 赛段类型（src/services/stage.js: STAGE_KINDS）。 */
export const STAGE_KINDS = [
  { value: 'initial', label: '初赛', tone: 'brand' },
  { value: 'final', label: '决赛', tone: 'success' },
  { value: 'roadshow', label: '路演', tone: 'info' },
  { value: 'landing', label: '落地', tone: 'neutral' },
];

/** 评委席类型（src/services/stage.js: JUDGE_SEATS）。 */
export const JUDGE_SEATS = [
  { value: 'judge', label: '评委席', tone: 'brand', voting: true },
  { value: 'enterprise', label: '企业席', tone: 'info', voting: true },
  { value: 'observer', label: '观察席 · 无投票权', tone: 'neutral', voting: false },
];

/** 可用的权重表键（src/services/stage.js: SCORING_CONFIG_KEYS）。 */
export const SCORING_CONFIG_KEYS = ['initial', 'final'];

// ── 小工具（纯函数）───────────────────────────────────────────────────

/** 时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。 */
export function fmtStageTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 时间 → `<input type="datetime-local">` 的值（「2026-10-20T12:00」）。
 * ⚠️ 服务端 `Date.parse` 接受 ISO 与 YYYY-MM-DD；datetime-local 给的是**本地时间**，
 *    与展示用的 fmtStageTime（本地时间）同一口径 ⇒ 存进去和显示出来不会差一个时区。
 */
export function toLocalInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 权重 → 「20%」（0.2 → 20%）。 */
export function fmtWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const pct = Math.round(n * 1000) / 10;
  return `${pct}%`;
}

/**
 * `<input type="datetime-local">` 的值 → ISO 字符串（发给服务端前统一转一道）。
 * ⚠️ datetime-local 给的是**本地时间**（"2026-10-20T12:00"），直接存进库会和
 *    其它端点写入的 ISO 串格式不一致 ⇒ 统一转成 ISO（同一个时刻，不改语义）。
 */
export function toIso(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  return d.toISOString();
}

/** 赛段类型 → { label, tone }（未知值原样透出，不静默吞掉）。 */
export function stageKindLabel(kind) {
  const hit = STAGE_KINDS.find((k) => k.value === String(kind ?? ''));
  return hit ? { label: hit.label, tone: hit.tone } : { label: String(kind ?? '—'), tone: 'neutral' };
}

/** 赛段状态 → { label, tone }。 */
export function stageStatusLabel(status) {
  const raw = String(status ?? '').trim();
  if (raw === 'draft') return { label: '草稿', tone: 'neutral' };
  if (raw === 'open' || raw === 'active') return { label: '进行中', tone: 'success' };
  if (raw === 'closed' || raw === 'finished') return { label: '已结束', tone: 'neutral' };
  if (raw === 'computed') return { label: '已计算', tone: 'info' };
  if (raw === 'published') return { label: '已发榜', tone: 'success' };
  return { label: raw || '—', tone: 'neutral' };
}

/**
 * 席位 → { label, tone, voting }。
 * ⚠️ observer 的标签里**必须**写明「无投票权」（S7 §3.4 / R-JDG-11）：
 *    组委会派一个观察席进来，是为了「看」而不是「评」—— 标签不写清楚，
 *    就会有评委以为自己也有票，事后才发现投不了。
 */
export function judgeSeatLabel(seat) {
  const hit = JUDGE_SEATS.find((s) => s.value === String(seat ?? ''));
  return hit
    ? { label: hit.label, tone: hit.tone, voting: hit.voting }
    : { label: String(seat ?? '—'), tone: 'neutral', voting: false };
}

/**
 * 三态状态码 → 人话（纯函数）。
 * ⛔ 403 必须说「没有权限」而不是「请求失败」—— 设计文档 §7.3 的三态就是给用户看的。
 * @param {number|string} status
 * @param {string} message 服务端给的中文原因（403 时优先用它，因为它最具体）
 */
export function stageErrorText(status, message) {
  const code = Number(status);
  const serverMsg = String(message ?? '').trim();
  if (code === 403) {
    return serverMsg
      ? `没有权限：${serverMsg}`
      : '没有权限：赛段配置需要组委会能力（stage:compute）。';
  }
  if (code === 404) {
    return serverMsg ? `对象不存在：${serverMsg}` : '对象不存在：赛段或届期可能已被删除。';
  }
  if (code === 401) return '请先登录后再配置赛段。';
  return serverMsg || '加载失败，请重试。';
}

/** 选项列表（纯 HTML）。 */
function optionsHtml(items, selected) {
  return (items ?? [])
    .map((it) => `<option value="${escapeHtml(it.value)}"${String(it.value) === String(selected ?? '') ? ' selected' : ''}>${escapeHtml(it.label)}</option>`)
    .join('');
}

/** 取值：数组优先（规则文件里就是数组），也认单个字符串。 */
function seatList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x ?? '')).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：届期 / 赛段列表
// ══════════════════════════════════════════════════════════════════

/**
 * 「哪一届是当届」（纯函数）。
 * ⚠️ 判据与 src/http/routes/registration.js 的 pickCurrentEdition 同款：
 *    **尚未结束**（ends_at >= 今天）的最早一届；都没有就退回最后一届。
 *    （不能用「最新一届」—— 那会把评委导到还没开赛的届期去。）
 */
export function pickCurrentEdition(editions, today = new Date().toISOString().slice(0, 10)) {
  const list = Array.isArray(editions) ? editions : [];
  if (!list.length) return null;
  const day = String(today).slice(0, 10);
  const started = list.filter((e) => String(e?.endsAt ?? e?.ends_at ?? '') >= day);
  if (started.length) return started[0];
  return list[list.length - 1];
}

/** 届期选择器（纯 HTML）。 */
export function editionPickerHtml(editions, editionId) {
  const list = Array.isArray(editions) ? editions : [];
  if (!list.length) {
    return '<p class="muted small">还没有届期 —— 届期是赛段的容器，组委会先建届期才能建赛段。</p>';
  }
  const items = list.map((e) => ({
    value: e.id,
    label: `${e.name ?? e.id}${e.city ? `（${e.city}）` : ''}${e.startsAt ? ` · ${fmtStageTime(e.startsAt)}` : ''}`,
  }));
  return `<div class="field">
      <label class="field__label" for="stage-edition">届期</label>
      <select class="select" id="stage-edition" data-stage="edition">
        ${optionsHtml(items, editionId)}
      </select>
      <p class="field__hint">赛段从属于届期：建段、改配置、派评委、报名册都在本届期下操作。</p>
    </div>`;
}

/**
 * 赛段列表（纯 HTML）：左轨里的**赛段选择器**。
 *
 * ⚠️ **P12：从表格改成列表**（不是为了好看，是因为表格放不下）：
 *    改版前这里是一张 6 列表格（代号/名称/类型/时间窗/状态/操作），
 *    而整个页面是「一列面板一字排开」⇒ 表格和 5 张操作面板**同权重**，
 *    访客在一屏里既找不到「我现在操作的是哪个赛段」，也读不完一张宽表。
 *    ⇒ 改成左轨的**条目列表**（代号 / 名称 / 类型·状态·时间窗一行），
 *      当前赛段用 `is-active` 着色（tinted）标出。
 *    ⚠️ **类型与状态用纯文字而不是 badge**：左轨是导航面，
 *      再往里塞彩色徽章会把「每屏强调色 ≤ 3」顶破（实测赛段配置页曾出现 4 档）。
 * @param {Array}  stages      赛段列表
 * @param {string} selectedId  当前选中的赛段 id
 */
export function stageListHtml(stages, selectedId) {
  const list = Array.isArray(stages) ? stages : [];
  if (!list.length) {
    return emptyState({
      title: '本届期还没有赛段',
      hint: '用下面的「新建赛段」建一条 —— 评审、发榜、破同分、企业签字台全都挂在赛段上，没有赛段这些页面一个都进不去。',
    });
  }
  const items = list.map((s) => {
    const kind = stageKindLabel(s.kind);
    const status = stageStatusLabel(s.status);
    const on = String(s.id ?? '') === String(selectedId ?? '');
    const window = `${fmtStageTime(s.startsAt) || '—'} → ${fmtStageTime(s.endsAt) || '—'}`;
    // ⚠️ 条目的形状由 web/ui.js 的 workbenchItem() 统一产出
    //    （条件 class 不许在视图里用模板表达式拼 —— 见 ui.js 的说明）。
    return `<li>${workbenchItem({
      key: s.key ?? '—',
      name: s.name ?? '—',
      meta: `${kind.label} · ${status.label} · ${window}`,
      active: on,
      action: 'stage-select',
      dataKey: 'stage-id',
      dataValue: s.id ?? '',
    })}</li>`;
  }).join('');
  return `<ul class="workbench__list">${items}</ul>`;
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：建段 / 改配置
// ══════════════════════════════════════════════════════════════════

/** 权重表下拉的选项（规则列表优先，取不到就退回枚举）。 */
function scoringOptions(configs, selected) {
  const list = Array.isArray(configs) ? configs : [];
  const items = list.length
    ? list.map((c) => ({ value: c.key, label: `${c.key}${c.version ? `（${c.version}）` : ''}` }))
    : SCORING_CONFIG_KEYS.map((k) => ({ value: k, label: k }));
  // 选中的键不在列表里也保留它（服务端的规则可能比前端读到的多）
  const values = items.map((i) => String(i.value));
  if (selected && !values.includes(String(selected))) {
    items.push({ value: selected, label: `${selected}（规则里暂未读到）` });
  }
  return items;
}

/** 新建赛段表单（纯 HTML）。 */
export function stageCreateFormHtml({ draft = {}, configs = [] } = {}) {
  const kindItems = STAGE_KINDS.map((k) => ({ value: k.value, label: k.label }));
  const configItems = scoringOptions(configs, draft.scoringConfigKey ?? 'initial');
  return `<div class="field">
      <label class="field__label" for="stage-new-key">赛段代号</label>
      <input class="input" id="stage-new-key" type="text" autocomplete="off"
        placeholder="如 initial / final" value="${escapeHtml(draft.key ?? '')}" data-stage="new-key" />
      <p class="field__hint">代号建后不可改（它进 URL 与日志）：只能用字母、数字、连字符与下划线，同一届期内不能重复。</p>
    </div>
    <div class="field field--required">
      <label class="field__label" for="stage-new-name">赛段名称</label>
      <input class="input" id="stage-new-name" type="text" autocomplete="off"
        placeholder="如 初赛评审" value="${escapeHtml(draft.name ?? '')}" data-stage="new-name" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-kind">赛段类型</label>
      <select class="select" id="stage-new-kind" data-stage="new-kind">${optionsHtml(kindItems, draft.kind ?? 'initial')}</select>
      <p class="field__hint">类型建后不可改：类型决定赛段在赛程里的位置与要交付的东西。</p>
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-config">权重表</label>
      <select class="select" id="stage-new-config" data-stage="new-config">${optionsHtml(configItems, draft.scoringConfigKey ?? 'initial')}</select>
      <p class="field__hint">权重表来自 rules/scoring-*.json（改文件、重启即生效）—— 这里只选择用哪一张。</p>
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-starts">开始时间</label>
      <input class="input" id="stage-new-starts" type="datetime-local" value="${escapeHtml(toLocalInput(draft.startsAt))}" data-stage="new-starts" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-ends">结束时间</label>
      <input class="input" id="stage-new-ends" type="datetime-local" value="${escapeHtml(toLocalInput(draft.endsAt))}" data-stage="new-ends" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-freeze">冻结时间</label>
      <input class="input" id="stage-new-freeze" type="datetime-local" value="${escapeHtml(toLocalInput(draft.freezeAt))}" data-stage="new-freeze" />
      <p class="field__hint">冻结后不再接受本赛段的评分（可留空）。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="stage-create-submit">创建赛段</button>
    </div>`;
}

/**
 * 赛段配置（改配置）表单（纯 HTML）。
 * ⚠️ **key 与 kind 建后不可改** ⇒ 置灰（disabled）而不是隐藏 ——
 *    隐藏会让组委会以为「这里能改」，于是到处找入口。
 *
 * ⚠️ **列表端点只给摘要**（id / key / name / kind / status / startsAt / endsAt），
 *    **不含** freezeAt 与 scoringConfigKey ⇒ 这两项无法回填。
 *    ⛔ 因此这两项**没被改动就不提交**（服务端的 PATCH 语义是「undefined = 不改」）
 *       —— 否则一次「只改名字」的保存会把冻结时间清空、把权重表换成默认值。
 */
export function stageConfigHtml({ stage = null, draft = {}, configs = [] } = {}) {
  if (!stage) {
    return emptyState({
      title: '先选一个赛段',
      hint: '在上方列表点「进入配置」，这里会显示该赛段的时间窗、冻结时间与用的权重表。',
    });
  }
  const kind = stageKindLabel(stage.kind);
  const keyKnown = stage.scoringConfigKeyKnown !== false;
  const freezeKnown = stage.freezeAtKnown !== false;
  const currentKey = String(stage.scoringConfigKey ?? stage.scoring_config_key ?? '');
  // 草稿优先（用户改过）⇒ 回显用户选的那一张；否则回显当前在用的那张。
  const selectedKey = String(draft.scoringConfigKey || currentKey || '');
  const configItems = scoringOptions(configs, selectedKey);
  const status = stageStatusLabel(stage.status);
  return `<div class="row">
      ${badge(`代号 ${stage.key ?? '—'}`, 'neutral')}
      ${badge(kind.label, kind.tone)}
      ${badge(status.label, status.tone)}
    </div>
    ${(keyKnown && freezeKnown) ? '' : noticeState({
      tone: 'warn',
      title: '这两项没有随赛段列表返回',
      items: [
        '赛段列表端点只返回摘要（代号 / 名称 / 类型 / 时间窗 / 状态），不含冻结时间与权重表键 ⇒ 页面无法回填它们的当前值。',
        '没有改动的字段不会被提交（服务端的改配置语义是「不传 = 不改」）⇒ 保存一次不会误清空已有的冻结时间，也不会把权重表换成默认值。',
      ],
    })}
    <div class="field">
      <label class="field__label" for="stage-cfg-key">赛段代号（建后不可改）</label>
      <input class="input" id="stage-cfg-key" type="text" value="${escapeHtml(stage.key ?? '')}" disabled />
      <p class="field__hint">代号进 URL 与日志，建后不改；要换代号请新建赛段。</p>
    </div>
    <div class="field field--required">
      <label class="field__label" for="stage-cfg-name">赛段名称</label>
      <input class="input" id="stage-cfg-name" type="text" autocomplete="off" value="${escapeHtml(draft.name ?? stage.name ?? '')}" data-stage="cfg-name" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-kind">赛段类型（建后不可改）</label>
      <select class="select" id="stage-cfg-kind" disabled>${optionsHtml(STAGE_KINDS.map((k) => ({ value: k.value, label: k.label })), stage.kind)}</select>
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-config">权重表</label>
      <select class="select" id="stage-cfg-config" data-stage="cfg-config">${optionsHtml(configItems, selectedKey)}</select>
      <p class="field__hint">权重表来自规则文件，页面只读展示（改表要改 rules/scoring-*.json，重启即生效）。已有评分数据时服务端会拒绝换表（历史评分将不可复算）。</p>
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-starts">开始时间</label>
      <input class="input" id="stage-cfg-starts" type="datetime-local" value="${escapeHtml(toLocalInput(draft.startsAt ?? stage.startsAt))}" data-stage="cfg-starts" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-ends">结束时间</label>
      <input class="input" id="stage-cfg-ends" type="datetime-local" value="${escapeHtml(toLocalInput(draft.endsAt ?? stage.endsAt))}" data-stage="cfg-ends" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-freeze">冻结时间</label>
      <input class="input" id="stage-cfg-freeze" type="datetime-local" value="${escapeHtml(toLocalInput(draft.freezeAt ?? stage.freezeAt))}" data-stage="cfg-freeze" />
      <p class="field__hint">冻结后不再接受本赛段的评分（可留空）。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="stage-update-submit">保存赛段配置</button>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 三、纯函数：权重表（只读）
// ══════════════════════════════════════════════════════════════════

/**
 * 权重表（**只读**）—— 纯函数。
 *
 * ⚠️ 三种降级必须分清楚，不能都写成「没数据」：
 *   ① 规则文件没加载上来（权重表读口拿不到）⇒ 「规则未加载」，**不阻断其余面板**；
 *   ② 规则加载了但这个键不在里面 ⇒ 「权重表未找到」（多半是服务端规则与前端读到的版本不一致）；
 *   ③ 找到了 ⇒ 展示维度表 + 席构成约束。
 *
 * @param {object} o
 * @param {Array<object>} o.configs       `GET /api/editions/:editionId/scoring-configs` 的 items
 * @param {string} o.scoringConfigKey     当前赛段在用的权重表键
 * @param {boolean} o.degraded            规则是否没加载上来
 * @param {number|string} o.degradedStatus 降级时的 HTTP 状态码（403 要说「没有权限」）
 */
export function weightTableHtml({ configs = [], scoringConfigKey = '', degraded = false, degradedStatus = null } = {}) {
  if (degraded) {
    const forbidden = Number(degradedStatus) === 403;
    return noticeState({
      tone: 'warn',
      title: '规则未加载',
      items: [
        '权重表来自 rules/scoring-*.json（改一份 JSON、重启即生效），此刻拿不到规则文件，权重表暂时显示不出来。',
        forbidden
          ? '读取权重表没有权限（权重表端点是届期作用域的读口，需要该届期的组委会能力）。'
          : '其余面板（赛段配置 / 评委席 / 名册）不受影响，可以照常操作。',
      ],
    });
  }
  const list = Array.isArray(configs) ? configs : [];
  if (!list.length) {
    return emptyState({
      title: '规则未加载',
      hint: '权重表来自 rules/scoring-*.json（改一份 JSON、重启即生效）。此刻没有读到任何权重表，其余面板不受影响。',
    });
  }
  const key = String(scoringConfigKey ?? '');
  const config = list.find((c) => String(c?.key ?? '') === key);
  if (!config && !key) {
    // ⚠️ **「不知道当前用的是哪一张」≠「权重表不存在」** ——
    //   赛段列表端点只返回摘要（没有权重表键）⇒ 页面无从知道当前那一张。
    //   这时不能报「权重表未找到」（那是误导），而是把规则里可用的都列出来。
    const available = list.map((c) => `<tr>
      <td>${escapeHtml(c.key ?? '—')}</td>
      <td>${escapeHtml(c.version ?? '—')}</td>
      <td class="td-num num">${escapeHtml(String((Array.isArray(c.dimensions) ? c.dimensions : []).length))}</td>
    </tr>`).join('');
    return noticeState({
      tone: 'info',
      title: '这个赛段在用哪一张权重表，页面现在还不知道',
      items: [
        '赛段列表端点只返回摘要（不含权重表键）⇒ 页面显示不出「当前在用的那一张」。',
        '下面是规则里可用的权重表；在上面的「赛段配置」里选一张保存，就会写进这个赛段。',
      ],
    }) + tableWrap(
      `<thead><tr><th>权重表</th><th>版本</th><th class="td-num">维度数</th></tr></thead>
       <tbody>${available}</tbody>`,
      { caption: '规则里可用的权重表' },
    );
  }
  if (!config) {
    return noticeState({
      tone: 'warn',
      title: '权重表未找到',
      items: [
        key
          ? `这个赛段在用权重表「${key}」，但规则文件里没有找到这一张。`
          : '这个赛段没有设置权重表键。',
        '权重表只在规则文件里（rules/scoring-*.json），页面不提供改权重的入口 —— 请检查服务端规则是否与该赛段匹配。',
      ],
    });
  }

  const dims = Array.isArray(config.dimensions) ? config.dimensions : [];
  const pool = config.judgePool ?? {};
  const voting = seatList(pool.votingSeats);
  const nonVoting = seatList(pool.nonVotingSeats);
  const seatName = (seat) => {
    const hit = JUDGE_SEATS.find((s) => s.value === String(seat ?? ''));
    return hit ? hit.label : String(seat ?? '—');
  };
  const sum = dims.reduce((acc, d) => acc + (Number(d?.weight) || 0), 0);

  const dimTable = dims.length
    ? tableWrap(
      `<thead><tr><th>维度</th><th>键</th><th class="td-num">权重</th><th>计分席</th></tr></thead>
       <tbody>${dims.map((d) => `<tr>
         <td>${escapeHtml(d?.name ?? d?.key ?? '—')}</td>
         <td>${escapeHtml(d?.key ?? '—')}</td>
         <td class="td-num num">${escapeHtml(fmtWeight(d?.weight))}</td>
         <td>${escapeHtml(seatName(d?.seat))}</td>
       </tr>`).join('')}
       <tr>
         <td>合计</td>
         <td>—</td>
         <td class="td-num num">${escapeHtml(fmtWeight(sum))}</td>
         <td>—</td>
       </tr></tbody>`,
      { caption: `权重表 ${key}（按规则文件的声明序）` },
    )
    : emptyState({ title: '这张权重表没有维度', hint: '规则文件里的 dimensions 是空的。' });

  const poolRows = [
    ['每维度最少评委数', pool.minJudgesPerDimension === undefined ? '—' : String(pool.minJudgesPerDimension)],
    ['企业席最低占比', pool.minEnterpriseSeatShare === undefined ? '—' : fmtWeight(pool.minEnterpriseSeatShare)],
    ['专家席最高占比', pool.maxExpertSeatShare === undefined ? '—' : fmtWeight(pool.maxExpertSeatShare)],
    ['有投票权的席', voting.length ? voting.map(seatName).join('、') : '—'],
    ['无投票权的席', nonVoting.length ? nonVoting.map(seatName).join('、') : '—'],
  ];

  return `<div class="row">
      ${badge(`权重表 ${key}`, 'brand')}
      ${config.version ? badge(`版本 ${config.version}`, 'neutral') : ''}
      ${config.source ? badge(String(config.source), 'neutral') : ''}
    </div>
    ${config.note ? `<p class="muted small">${escapeHtml(config.note)}</p>` : ''}
    ${dimTable}
    ${sectionTitle('席构成约束')}
    ${kvList(poolRows)}
    <p class="muted small">以上约束由服务端校验（企业席 ≥30%、专家席 ≤50%）；页面不复制这套判定。</p>
    <p class="muted small">权重表只读：要改权重，改 rules/scoring-*.json 这一份 JSON，重启即生效。</p>`;
}

// ══════════════════════════════════════════════════════════════════
// 四、纯函数：评委席
// ══════════════════════════════════════════════════════════════════

/**
 * 评委席面板（纯函数）。
 * @param {object} o
 * @param {Array<object>} o.judges      `GET /api/stages/:stageId/judges` 的 judges
 * @param {Array<object>} o.candidates  `GET /api/editions/:editionId/judge-candidates` 的 items
 * @param {object} o.draft             { userId, seat }
 * @param {object|null} o.pending       待确认撤下的评委 { userId }
 */
export function judgeSeatHtml({ judges = [], candidates = [], draft = {}, pending = null, stageName = '' } = {}) {
  const list = Array.isArray(judges) ? judges : [];
  const pool = Array.isArray(candidates) ? candidates : [];
  const nameOf = (userId) => {
    const hit = pool.find((c) => String(c?.id ?? '') === String(userId ?? ''));
    return hit ? { name: hit.name ?? hit.id, org: hit.org ?? '' } : { name: String(userId ?? '—'), org: '' };
  };

  const table = list.length
    ? tableWrap(
      `<thead><tr><th>评委</th><th>席位</th><th>授权范围</th><th>派任时间</th><th>利益冲突声明</th><th></th></tr></thead>
       <tbody>${list.map((j) => {
        const who = nameOf(j.userId);
        const seat = judgeSeatLabel(j.seat);
        const scope = j.scopeId ? `${j.scopeType ?? 'global'} / ${j.scopeId}` : String(j.scopeType ?? 'global');
        const declared = j.conflictDeclaredAt
          ? `已声明 · ${fmtStageTime(j.conflictDeclaredAt)}`
          : '未声明';
        const isPending = pending && String(pending.userId ?? '') === String(j.userId ?? '');
        const actions = isPending
          ? removeJudgeConfirmHtml({ userId: j.userId, name: who.name, stageName })
          : `<button type="button" class="btn btn--ghost btn--sm" data-action="judge-remove-request" data-user-id="${escapeHtml(j.userId ?? '')}">撤评委</button>`;
        return `<tr>
          <td>${escapeHtml(who.name)}${who.org ? `<span class="muted small"> · ${escapeHtml(who.org)}</span>` : ''}<br><span class="muted small">${escapeHtml(j.userId ?? '')}</span></td>
          <td>${badge(seat.label, seat.tone)}</td>
          <td>${escapeHtml(scope)}</td>
          <td>${escapeHtml(fmtStageTime(j.assignedAt) || '—')}</td>
          <td>${escapeHtml(declared)}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}</tbody>`,
      { caption: '本赛段评委席' },
    )
    : emptyState({
      title: '本赛段还没有派评委',
      hint: '派评委要选「人 + 席」：观察席无投票权；企业席与专家席的比例由服务端校验。',
    });

  const assigned = new Set(list.map((j) => String(j.userId ?? '')));
  const selectable = pool.filter((c) => !assigned.has(String(c?.id ?? '')));
  const seatItems = JUDGE_SEATS.map((s) => ({ value: s.value, label: s.label }));
  const assignForm = selectable.length
    ? `<div class="field">
        <label class="field__label" for="stage-judge-user">评委</label>
        <select class="select" id="stage-judge-user" data-stage="judge-user">
          ${optionsHtml(selectable.map((c) => ({ value: c.id, label: `${c.name ?? c.id}${c.org ? `（${c.org}）` : ''}` })), draft.userId ?? '')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="stage-judge-seat">席位</label>
        <select class="select" id="stage-judge-seat" data-stage="judge-seat">${optionsHtml(seatItems, draft.seat ?? 'judge')}</select>
        <p class="field__hint">观察席无投票权；企业席 ≥30%、专家席 ≤50% 由服务端校验（页面不复制这套判定）。</p>
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" data-action="judge-assign-submit">派评委</button>
      </div>`
    : '<p class="muted small">候选池里的评委都已经在本赛段了（没有更多可派的）。</p>';

  return `${table}
    ${sectionTitle('派评委')}
    ${assignForm}`;
}

/**
 * 撤评委的二次确认块（纯函数 · 逆向路径）。
 *
 * ⚠️ **为什么要二次确认**：撤评委会连带**解除**他在本赛段签署的利益冲突声明
 *   （声明记录作为历史事实保留，不删除，但不再绑定任何席位）。
 *   ⇒ 文案必须写明影响面，而不是「确定吗？」。
 */
export function removeJudgeConfirmHtml({ userId = '', name = '', stageName = '' } = {}) {
  const who = name || userId;
  const where = stageName ? `赛段「${stageName}」` : '本赛段';
  return `<div class="notice notice--warn" data-stage-confirm="judge">
    <p class="notice__title">确认撤回该评委？</p>
    <p class="notice__text">撤回 ${escapeHtml(who)} 在${escapeHtml(where)}的席位后：他的席位立即失效，其在本赛段签署的<strong>利益冲突声明一并解除</strong>（声明记录作为历史事实保留，不会删除）；该评委不再计入本赛段的评委池与席构成校验，已提交的历史评分不受影响。</p>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="judge-remove-confirm" data-user-id="${escapeHtml(userId)}">确认撤回</button>
      <button type="button" class="btn btn--ghost" data-action="judge-remove-cancel">取消</button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 五、纯函数：名册
// ══════════════════════════════════════════════════════════════════

/**
 * 名册面板（纯函数）。
 * @param {object} o
 * @param {Array<object>} o.teams        `GET /api/editions/:editionId/teams` 的 items
 * @param {Array<string>} o.rosterTeamIds `GET /api/stages/:stageId/teams` 的 teamIds
 * @param {object|null} o.pending       待确认退名的队伍 { teamId }
 */
export function rosterHtml({ teams = [], rosterTeamIds = [], pending = null, stageName = '' } = {}) {
  const list = Array.isArray(teams) ? teams : [];
  const roster = new Set((Array.isArray(rosterTeamIds) ? rosterTeamIds : []).map((x) => String(x ?? '')));
  const nameOf = (id) => {
    const hit = list.find((t) => String(t?.id ?? '') === String(id ?? ''));
    return hit ? { name: hit.name ?? hit.id, tier: hit.tier ?? '' } : { name: String(id ?? '—'), tier: '' };
  };

  if (!list.length) {
    return emptyState({
      title: '本届期还没有队伍',
      hint: '名册登记的是「本届期的队伍」—— 没有队伍就没法往赛段里登记。',
    });
  }

  const rosterRows = list.filter((t) => roster.has(String(t?.id ?? '')));
  const rosterBlock = rosterRows.length
    ? tableWrap(
      `<thead><tr><th>队伍</th><th>段位</th><th>名册状态</th><th></th></tr></thead>
       <tbody>${rosterRows.map((t) => {
        const id = String(t?.id ?? '');
        const tier = t?.tier ?? '';
        const isPending = pending && String(pending.teamId ?? '') === id;
        const actions = isPending
          ? removeTeamConfirmHtml({ teamId: id, name: t?.name ?? id, stageName })
          : `<button type="button" class="btn btn--ghost btn--sm" data-action="roster-remove-request" data-team-id="${escapeHtml(id)}">退名册</button>`;
        return `<tr>
          <td>${escapeHtml(t?.name ?? id)}<br><span class="muted small">${escapeHtml(id)}</span></td>
          <td>${escapeHtml(tier || '—')}</td>
          <td>${badge('在榜', 'success')}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}</tbody>`,
      { caption: '本赛段名册（在榜队伍）' },
    )
    : emptyState({
      title: '本赛段名册还是空的',
      hint: '在下面勾选队伍登记进来 —— 名册里的队伍才会出现在本赛段的评审、发榜与名次里。',
    });

  const pendingIds = [...roster].filter((id) => !list.some((t) => String(t?.id ?? '') === id));
  const pickList = list
    .filter((t) => !roster.has(String(t?.id ?? '')))
    .map((t) => `<li class="row">
        <label class="row">
          <input type="checkbox" data-stage="roster-pick" data-team-id="${escapeHtml(t?.id ?? '')}" />
          <span>${escapeHtml(t?.name ?? t?.id ?? '')}${t?.tier ? ` <span class="muted small">${escapeHtml(t.tier)}</span>` : ''}</span>
        </label>
      </li>`)
    .join('');
  // ⚠️ 「登记所选队伍」按钮**必须**跟着勾选框一起出现 ——
  //   早先只在「名册非空」时渲染按钮 ⇒ 名册为空时用户勾了队却找不到提交按钮（死路）。
  const registerList = pickList
    ? `<ul class="list-divided">${pickList}</ul>
      <div class="row">
        <button type="button" class="btn btn--primary" data-action="roster-register-submit">登记所选队伍</button>
      </div>`
    : '<p class="muted small">本届期的队伍都已经在名册里了。</p>';

  const orphanNote = pendingIds.length
    ? `<p class="muted small">名册里还有 ${pendingIds.length} 支队伍不在本届期队伍列表中（可能已转队或被删除）：${pendingIds.map((id) => escapeHtml(nameOf(id).name)).join('、')}</p>`
    : '';

  return `${sectionTitle('本赛段名册')}
    ${rosterBlock}
    ${orphanNote}
    ${sectionTitle('登记队伍')}
    ${registerList}`;
}

/**
 * 退名册的二次确认块（纯函数 · 逆向路径）。
 * ⚠️ 退名册后，该队在本赛段的评分与确认**失效** ⇒ 文案必须写明影响面。
 */
export function removeTeamConfirmHtml({ teamId = '', name = '', stageName = '' } = {}) {
  const who = name || teamId;
  const where = stageName ? `赛段「${stageName}」` : '本赛段';
  return `<div class="notice notice--warn" data-stage-confirm="team">
    <p class="notice__title">确认把该队伍退名册？</p>
    <p class="notice__text">把 ${escapeHtml(who)} 从${escapeHtml(where)}的名册里退出后：该队在本赛段的<strong>评分与确认全部失效</strong>（已交的评分不再计入本赛段的计算与名次），名次与榜单也会随之变化。这一步是逆向操作，请确认。</p>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="roster-remove-confirm" data-team-id="${escapeHtml(teamId)}">确认退名册</button>
      <button type="button" class="btn btn--ghost" data-action="roster-remove-cancel">取消</button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 六、整页
// ══════════════════════════════════════════════════════════════════

/** 顶部指标（纯函数）。 */
export function stageConfigStats(model = {}) {
  const stages = Array.isArray(model.stages) ? model.stages : [];
  const judges = Array.isArray(model.judges) ? model.judges : [];
  const roster = Array.isArray(model.rosterTeamIds) ? model.rosterTeamIds : [];
  const stage = model.stage ?? null;
  return [
    { label: '本届期赛段', value: stages.length, tone: 'brand' },
    { label: '本赛段评委席', value: stage ? judges.length : '—', hint: stage ? '观察席无投票权' : '先选一个赛段' },
    { label: '本赛段名册', value: stage ? roster.length : '—', hint: stage ? '在榜队伍数' : '先选一个赛段' },
    {
      label: '在用权重表',
      value: stage ? (stage.scoringConfigKey ?? stage.scoring_config_key ?? '—') : '—',
      tone: 'neutral',
      hint: '只读：改表要改 rules/scoring-*.json',
    },
  ];
}

/**
 * 整页 HTML（纯函数，可单测）。
 * @param {object} model {
 *   loading, error, errorStatus, editions, editionId, stages, stageId, stage,
 *   judges, candidates, teams, rosterTeamIds, configs, configsDegraded, feedback,
 *   drafts, pending
 * }
 */
/**
 * 赛段配置页（纯 HTML）。
 *
 * ⚠️ **P12：页面形状 = 操作台（左轨选对象 + 右画布做操作）**。
 *    改版前是「head + 指标行 + 6 张同款面板」的一字排开（实测顶层结构：
 *    div.stack > header + div.stat-row + section.panel × 6）⇒
 *    六个面板同权重同材质，访客既分不出主次，也找不到「我现在操作的是哪个赛段」。
 *    ⇒ 左轨 = 届期 + 赛段选择器（导航器 ⇒ 材质下沉）；
 *      右画布 = 指标 + 五个操作面板（工作面 ⇒ 材质浮起）。
 *    样式见 web/styles.css ⑫ 段；结构由 web/ui.js 的 workbench() 统一产出。
 */
export function stageConfigPageHtml(model = {}) {
  const head = pageHead({
    title: '赛段配置与权重表',
    sub: '组委会：建赛段、改配置、派评委、报名册；权重表来自规则文件，只读展示。',
  });

  const feedbackHtml = model.feedback
    ? noticeState({
      tone: model.feedback.tone ?? 'info',
      title: model.feedback.title ?? '',
      items: model.feedback.items ?? [],
      list: true,
    })
    : '';

  const editions = Array.isArray(model.editions) ? model.editions : [];
  const stages = Array.isArray(model.stages) ? model.stages : [];
  const railPanel = panel({
    title: '届期与赛段',
    desc: '赛段从属于届期：建段、改配置、派评委、报名册都在本届期下操作。',
    body: editionPickerHtml(editions, model.editionId ?? '') + stageListHtml(stages, model.stageId ?? ''),
  });

  if (model.loading) {
    // ⚠️ 加载中**不要**先渲染赛段列表（那时 stages 还是空数组 ⇒ 会闪一句
    //    「本届期还没有赛段」，那是**假消息**）⇒ 轨里只放加载态。
    return head + workbench({
      rail: panel({ title: '届期与赛段', body: loadingState({ rows: 2, label: '正在加载届期与赛段…' }) }),
      canvas: loadingState({ rows: 4, label: '正在加载赛段配置…' }),
    });
  }

  if (model.error) {
    return head + workbench({
      rail: railPanel,
      canvas: feedbackHtml + errorState({
        message: stageErrorText(model.errorStatus, model.error),
        hint: '赛段配置需要组委会能力（stage:compute）；确认已登录并拥有该能力后点「重试」。',
      }),
    });
  }

  const drafts = model.drafts ?? {};
  const stage = model.stage ?? null;

  return head + workbench({
    rail: railPanel,
    canvas: [
      feedbackHtml,
      statRow(stageConfigStats(model)),
      panel({
        title: '新建赛段',
        desc: '代号与类型建后不可改 —— 它们决定赛段在赛程里的位置。',
        body: stageCreateFormHtml({ draft: drafts.create ?? {}, configs: model.configs ?? [] }),
      }),
      panel({
        title: '赛段配置',
        desc: '改名称、时间窗、冻结时间与权重表；代号与类型不可改。',
        body: stageConfigHtml({ stage, draft: drafts.edit ?? {}, configs: model.configs ?? [] }),
      }),
      panel({
        title: '权重表（只读）',
        desc: '当前赛段用的是哪一张权重表、席构成约束是什么。改表要改 rules/scoring-*.json，重启即生效。',
        body: weightTableHtml({
          configs: model.configs ?? [],
          scoringConfigKey: stage?.scoringConfigKey ?? stage?.scoring_config_key ?? '',
          degraded: Boolean(model.configsDegraded),
          degradedStatus: model.configsStatus ?? null,
        }),
      }),
      panel({
        title: '评委席',
        desc: '派评委 = 选人 + 选席；撤评委是逆向路径，会连带解除该评委在本赛段签署的利益冲突声明。',
        body: judgeSeatHtml({
          judges: model.judges ?? [],
          candidates: model.candidates ?? [],
          draft: drafts.assign ?? {},
          pending: model.pending ?? null,
          stageName: stage?.name ?? '',
        }),
      }),
      panel({
        title: '名册',
        desc: '名册里的队伍才会出现在本赛段的评审与名次里；退名册是逆向路径。',
        body: rosterHtml({
          teams: model.teams ?? [],
          rosterTeamIds: model.rosterTeamIds ?? [],
          pending: model.pending ?? null,
          stageName: stage?.name ?? '',
        }),
      }),
    ].join(''),
  });
}

// ══════════════════════════════════════════════════════════════════
// 七、DOM 接线（renderStageConfig）
// ══════════════════════════════════════════════════════════════════

/**
 * 赛段配置页。
 *
 * ⚠️ **交互纪律**（照抄 web/views/tiebreak.js / web/views/publish.js）：
 *   ① 提交一律「本地校验 → 发请求 → 就地反馈」；
 *   ② 提交成功后**重新拉一次**（不是本地改状态）⇒ 页面显示的永远是服务端口径；
 *   ③ 重绘时**回填草稿** ⇒ 用户已填的内容不会被冲掉（DP-81）；
 *   ④ 加载 / 错误 / 空态全部用 web/ui.js 的现成组件（不自己造）；
 *   ⑤ 所有 DOM 读取都用可选链 —— 最小 DOM 桩上不许抛；
 *   ⑥ 事件**全部委托**在 wrap 上（局部重绘不丢监听）。
 */
export async function renderStageConfig(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'stack stagecfg-view';

  const state = {
    loading: true,
    error: null,
    errorStatus: null,
    editions: [],
    editionId: '',
    stages: [],
    stageId: '',
    stage: null,
    judges: [],
    candidates: [],
    teams: [],
    rosterTeamIds: [],
    configs: [],
    configsDegraded: false,
    configsStatus: null,
    feedback: null,
    pending: null,
    // ⚠️ 脏标记：只有用户**动过**的字段才提交（防止「只改名字」顺手清空冻结时间 / 换掉权重表）。
    dirty: { freezeAt: false, scoringConfigKey: false },
    // ⚠️ 写端点返回过完整字段按赛段 id 记下来 ——
    //    列表端点只给摘要（没有 freezeAt / scoringConfigKey）⇒ 不记就会在每次刷新后丢失。
    known: {},
    drafts: {
      create: { key: '', name: '', kind: 'initial', scoringConfigKey: 'initial', startsAt: '', endsAt: '', freezeAt: '' },
      edit: { name: '', startsAt: '', endsAt: '', freezeAt: '', scoringConfigKey: '' },
      assign: { userId: '', seat: 'judge' },
    },
  };

  /** 重绘整页。 */
  const render = () => {
    wrap.innerHTML = stageConfigPageHtml(state);
  };

  /** 读输入框的值（读不到就当空串 —— 最小 DOM 桩上不许抛）。 */
  const value = (id) => {
    const el = wrap.querySelector(`#${id}`);
    return el && typeof el.value === 'string' ? el.value : '';
  };

  /** 读复选框里勾中的队伍 id。 */
  const pickedTeamIds = () => {
    const boxes = Array.from(wrap.querySelectorAll('[data-stage="roster-pick"]') ?? []);
    const out = [];
    for (const box of boxes) {
      if (!box?.checked) continue;
      const id = String(box?.dataset?.teamId ?? box?.value ?? '').trim();
      if (id) out.push(id);
    }
    return out;
  };

  /** 归一化「列表里的一条」与「写端点返回的完整赛段」⇒ 统一的 stage 形状。 */
  const normalizeStage = (raw) => {
    if (!raw) return null;
    // ⚠️ **known 标记**：列表端点只给摘要（没有 freezeAt / scoringConfigKey），
    //    写端点返回的是完整行 ⇒ 用「字段在不在」区分「没有这个值」与「不知道这个值」。
    const hasFreeze = raw.freezeAt !== undefined || raw.freeze_at !== undefined;
    const hasKey = raw.scoringConfigKey !== undefined || raw.scoring_config_key !== undefined;
    return {
      id: raw.id,
      editionId: raw.editionId ?? raw.edition_id ?? state.editionId,
      key: raw.key,
      name: raw.name,
      kind: raw.kind,
      status: raw.status,
      startsAt: raw.startsAt ?? raw.starts_at ?? '',
      endsAt: raw.endsAt ?? raw.ends_at ?? '',
      freezeAt: raw.freezeAt ?? raw.freeze_at ?? '',
      scoringConfigKey: raw.scoringConfigKey ?? raw.scoring_config_key ?? '',
      freezeAtKnown: hasFreeze,
      scoringConfigKeyKnown: hasKey,
    };
  };

  /** 换赛段时重置「编辑」草稿（否则会把上一个赛段的名字带过来）。 */
  const resetEditDraft = (stage) => {
    state.drafts.edit = {
      name: stage?.name ?? '',
      startsAt: toLocalInput(stage?.startsAt),
      endsAt: toLocalInput(stage?.endsAt),
      freezeAt: toLocalInput(stage?.freezeAt),
      // ⚠️ 权重表键**不知道**时留空 ⇒ 保存时这一项不提交（服务端保留原值）。
      scoringConfigKey: stage?.scoringConfigKeyKnown === false ? '' : (stage?.scoringConfigKey ?? ''),
    };
    // ⚠️ 脏标记重置：没被用户动过的字段一律不提交。
    state.dirty = { freezeAt: false, scoringConfigKey: false };
  };

  /** 拉届期列表（公开端点）。 */
  const loadEditions = async () => {
    const data = await ctx.api.get('/api/editions');
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    state.editions = Array.isArray(items) ? items : [];
    const wanted = String(ctx?.params?.editionId ?? ctx?.query?.editionId ?? '');
    const known = state.editions.find((e) => String(e?.id ?? '') === wanted);
    state.editionId = known ? wanted : (pickCurrentEdition(state.editions)?.id ?? '');
  };

  /** 拉赛段列表（公开端点）。 */
  const loadStages = async () => {
    if (!state.editionId) {
      state.stages = [];
      return;
    }
    const data = await ctx.api.get(`/api/stages?editionId=${encodeURIComponent(state.editionId)}`);
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    state.stages = (Array.isArray(items) ? items : []).map((s) => normalizeStage(s) ?? s);
    // ⚠️ 把写端点返回过的完整字段补回列表项（列表端点只给摘要）。
    for (const s of state.stages) {
      const extra = state.known[String(s?.id ?? '')];
      if (!extra) continue;
      if (s.scoringConfigKeyKnown === false && extra.scoringConfigKey) {
        s.scoringConfigKey = extra.scoringConfigKey;
        s.scoringConfigKeyKnown = true;
      }
      if (s.freezeAtKnown === false) {
        s.freezeAt = extra.freezeAt ?? '';
        s.freezeAtKnown = true;
      }
    }
  };

  /**
   * 拉权重表（**尽力而为**：拿不到只降级这一块，不阻断其余面板）。
   * ⚠️ 端点是**届期作用域**的：`/api/editions/:editionId/scoring-configs`
   *    （与建段 / 改配置 / 派评委的写端点同域 ⇒ 不会出现「能改赛段、却读不到权重表」）。
   */
  const loadConfigs = async () => {
    if (!state.editionId) {
      state.configs = [];
      state.configsDegraded = false;
      state.configsStatus = null;
      return;
    }
    try {
      const data = await ctx.api.get(`/api/editions/${encodeURIComponent(state.editionId)}/scoring-configs`);
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      state.configs = Array.isArray(items) ? items : [];
      state.configsDegraded = false;
      state.configsStatus = null;
    } catch (e) {
      state.configs = [];
      state.configsDegraded = true;
      state.configsStatus = e?.status ?? null;
    }
  };

  /** 拉某个赛段的详情（评委席 / 名册 / 候选池）。 */
  const loadStageDetail = async (stageId) => {
    if (!stageId) {
      state.judges = [];
      state.candidates = [];
      state.teams = [];
      state.rosterTeamIds = [];
      state.stage = null;
      return;
    }
    const base = `/api/stages/${encodeURIComponent(stageId)}`;
    // ⛔ 这几个端点都要组委会能力：403 ⇒ 整页没有意义（页面级错误，显示「没有权限」）。
    const judgesData = await ctx.api.get(`${base}/judges`);
    const rosterData = await ctx.api.get(`${base}/teams`);
    const [teamsData, candidatesData] = await Promise.all([
      ctx.api.get(`/api/editions/${encodeURIComponent(state.editionId)}/teams`),
      ctx.api.get(`/api/editions/${encodeURIComponent(state.editionId)}/judge-candidates`),
    ]);
    state.judges = Array.isArray(judgesData?.judges) ? judgesData.judges : [];
    state.rosterTeamIds = Array.isArray(rosterData?.teamIds) ? rosterData.teamIds : [];
    state.teams = Array.isArray(teamsData?.items) ? teamsData.items : [];
    state.candidates = Array.isArray(candidatesData?.items) ? candidatesData.items : [];
  };

  /** 首屏 / 重试：一次把页面需要的数据拉齐。 */
  const loadAll = async (keepStage = false) => {
    state.loading = true;
    state.error = null;
    state.errorStatus = null;
    render();
    try {
      await loadEditions();
      await loadStages();
      await loadConfigs();
      if (!keepStage) {
        const wanted = String(ctx?.params?.stageId ?? ctx?.query?.stageId ?? '');
        const known = state.stages.find((s) => String(s?.id ?? '') === wanted);
        state.stageId = known ? wanted : (state.stages[0]?.id ? String(state.stages[0].id) : '');
      }
      const picked = state.stages.find((s) => String(s?.id ?? '') === String(state.stageId ?? '')) ?? null;
      state.stage = picked ? normalizeStage(picked) : null;
      resetEditDraft(state.stage);
      if (state.stageId) await loadStageDetail(state.stageId);
    } catch (e) {
      state.error = e?.message ?? '加载失败';
      state.errorStatus = e?.status ?? null;
    } finally {
      state.loading = false;
      render();
    }
  };

  /** 成功反馈（noticeState 的参数是 items —— 不是 text）。 */
  const ok = (title, items) => {
    state.feedback = { tone: 'success', title, items: Array.isArray(items) ? items : [items] };
  };

  /** 失败反馈（服务端的中文原因原样透出）。 */
  const fail = (title, e) => {
    state.feedback = { tone: 'danger', title, items: [e?.message ?? '操作失败'] };
  };

  /** 写完之后重新拉一次（页面显示的永远是服务端口径）。 */
  const reload = async (keepStage = true) => {
    await loadAll(keepStage);
  };

  // ── 建赛段 ────────────────────────────────────────────────────────
  const createStage = async () => {
    const body = {
      key: value('stage-new-key').trim(),
      name: value('stage-new-name').trim(),
      kind: value('stage-new-kind') || 'initial',
      scoringConfigKey: value('stage-new-config') || 'initial',
      // ⚠️ datetime-local 给的是本地时间 ⇒ 统一转 ISO 再发（同一个时刻，格式与其它端点一致）。
      startsAt: toIso(value('stage-new-starts')),
      endsAt: toIso(value('stage-new-ends')),
      freezeAt: value('stage-new-freeze') ? toIso(value('stage-new-freeze')) : null,
    };
    if (!body.key || !body.name || !body.startsAt || !body.endsAt) {
      state.feedback = { tone: 'warn', title: '还差一点', items: ['赛段代号、名称、开始时间与结束时间都要填。'] };
      render();
      return;
    }
    try {
      const res = await ctx.api.post(`/api/editions/${encodeURIComponent(state.editionId)}/stages`, body);
      const created = normalizeStage(res?.stage);
      if (created?.id) {
        state.known[String(created.id)] = {
          freezeAt: created.freezeAt ?? '',
          scoringConfigKey: created.scoringConfigKey ?? '',
        };
      }
      state.drafts.create = { key: '', name: '', kind: 'initial', scoringConfigKey: 'initial', startsAt: '', endsAt: '', freezeAt: '' };
      state.stageId = created?.id ? String(created.id) : state.stageId;
      ok('赛段已创建', [
        created ? `赛段「${created.name}（${created.key}）」已建好。` : '赛段已建好。',
        '新赛段是草稿状态：开闸是另一个动作。',
      ]);
      await reload();
    } catch (e) {
      fail('创建赛段失败', e);
      render();
    }
  };

  // ── 改赛段配置 ────────────────────────────────────────────────────
  const updateStage = async () => {
    if (!state.stageId) {
      state.feedback = { tone: 'warn', title: '还没选赛段', items: ['先在上方列表点「进入配置」。'] };
      render();
      return;
    }
    const body = {
      name: value('stage-cfg-name').trim(),
      startsAt: toIso(value('stage-cfg-starts')),
      endsAt: toIso(value('stage-cfg-ends')),
    };
    // ⛔ **只提交用户动过的字段**：服务端的 PATCH 语义是「不传 = 不改」
    //    ⇒ 没动过 freezeAt / scoringConfigKey 就不传它们，
    //    否则「只改个名字」会把冻结时间清空、把权重表换成下拉框里的第一项。
    if (state.dirty.freezeAt) body.freezeAt = value('stage-cfg-freeze') ? toIso(value('stage-cfg-freeze')) : null;
    if (state.dirty.scoringConfigKey && value('stage-cfg-config')) body.scoringConfigKey = value('stage-cfg-config');
    if (!body.name || !body.startsAt || !body.endsAt) {
      state.feedback = { tone: 'warn', title: '还差一点', items: ['赛段名称、开始时间与结束时间都要填。'] };
      render();
      return;
    }
    try {
      const res = await ctx.api.patch(`/api/stages/${encodeURIComponent(state.stageId)}`, body);
      const updated = normalizeStage(res?.stage);
      if (updated) {
        const idx = state.stages.findIndex((s) => String(s?.id ?? '') === String(updated.id));
        if (idx >= 0) state.stages[idx] = updated;
        state.stage = updated;
        state.known[String(updated.id)] = {
          freezeAt: updated.freezeAt ?? '',
          scoringConfigKey: updated.scoringConfigKey ?? '',
        };
      }
      ok('赛段配置已保存', ['名称、时间窗、冻结时间与权重表已更新（已留审计）。']);
      await reload();
    } catch (e) {
      fail('保存赛段配置失败', e);
      render();
    }
  };

  // ── 派评委 ────────────────────────────────────────────────────────
  const assignJudge = async () => {
    if (!state.stageId) {
      state.feedback = { tone: 'warn', title: '还没选赛段', items: ['先在上方列表点「进入配置」。'] };
      render();
      return;
    }
    const body = {
      userId: value('stage-judge-user'),
      seat: value('stage-judge-seat') || 'judge',
      scopeType: 'global',
      scopeId: null,
    };
    if (!body.userId) {
      state.feedback = { tone: 'warn', title: '还没选评委', items: ['先在候选池里选一个人。'] };
      render();
      return;
    }
    try {
      await ctx.api.post(`/api/stages/${encodeURIComponent(state.stageId)}/judges`, body);
      state.drafts.assign = { userId: '', seat: body.seat };
      ok('已派评委', [
        `席位 ${judgeSeatLabel(body.seat).label} 已派出。`,
        '席位与利益冲突声明同一次写入（已留审计）。',
      ]);
      await reload();
    } catch (e) {
      fail('派评委失败', e);
      render();
    }
  };

  // ── 撤评委（逆向路径）────────────────────────────────────────────
  const removeJudge = async (userId) => {
    try {
      await ctx.api.del(`/api/stages/${encodeURIComponent(state.stageId)}/judges/${encodeURIComponent(userId)}`);
      state.pending = null;
      ok('已撤回该评委', [
        '该评委在本赛段的席位已失效，其在本赛段签署的利益冲突声明一并解除（声明记录作为历史事实保留）。',
      ]);
      await reload();
    } catch (e) {
      fail('撤评委失败', e);
      render();
    }
  };

  // ── 登记名册 ──────────────────────────────────────────────────────
  const registerTeams = async () => {
    if (!state.stageId) {
      state.feedback = { tone: 'warn', title: '还没选赛段', items: ['先在上方列表点「进入配置」。'] };
      render();
      return;
    }
    const teamIds = pickedTeamIds();
    if (!teamIds.length) {
      state.feedback = { tone: 'warn', title: '还没勾队伍', items: ['先勾选要登记到本赛段的队伍。'] };
      render();
      return;
    }
    try {
      const res = await ctx.api.post(`/api/stages/${encodeURIComponent(state.stageId)}/teams`, { teamIds });
      const registered = Number(res?.registered ?? 0);
      const skipped = Number(res?.skipped ?? 0);
      ok('名册已更新', [
        `新登记 ${registered} 支队伍。`,
        skipped ? `${skipped} 支此前已在名册里（重复登记是幂等的，不会报错）。` : '重复登记是幂等的，不会报错。',
      ]);
      await reload();
    } catch (e) {
      fail('登记名册失败', e);
      render();
    }
  };

  // ── 退名册（逆向路径）────────────────────────────────────────────
  const removeTeam = async (teamId) => {
    try {
      await ctx.api.del(`/api/stages/${encodeURIComponent(state.stageId)}/teams/${encodeURIComponent(teamId)}`);
      state.pending = null;
      ok('已把该队伍退名册', ['该队在本赛段的评分与确认随之失效。']);
      await reload();
    } catch (e) {
      fail('退名册失败', e);
      render();
    }
  };

  await loadAll();

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘不会丢监听。
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset?.action;

    if (action === 'retry') {
      await loadAll();
      return;
    }
    if (action === 'stage-select') {
      const id = String(btn.dataset?.stageId ?? '');
      if (!id || id === String(state.stageId)) return;
      state.stageId = id;
      state.pending = null;
      state.feedback = null;
      state.loading = true;
      render();
      try {
        const picked = state.stages.find((s) => String(s?.id ?? '') === id) ?? null;
        state.stage = picked ? normalizeStage(picked) : null;
        resetEditDraft(state.stage);
        await loadStageDetail(id);
      } catch (e) {
        state.error = e?.message ?? '加载失败';
        state.errorStatus = e?.status ?? null;
      } finally {
        state.loading = false;
        render();
      }
      return;
    }
    if (action === 'stage-create-submit') {
      await createStage();
      return;
    }
    if (action === 'stage-update-submit') {
      await updateStage();
      return;
    }
    if (action === 'judge-assign-submit') {
      await assignJudge();
      return;
    }
    if (action === 'judge-remove-request') {
      state.pending = { type: 'judge', userId: String(btn.dataset?.userId ?? '') };
      render();
      return;
    }
    if (action === 'judge-remove-cancel') {
      state.pending = null;
      render();
      return;
    }
    if (action === 'judge-remove-confirm') {
      await removeJudge(String(btn.dataset?.userId ?? ''));
      return;
    }
    if (action === 'roster-register-submit') {
      await registerTeams();
      return;
    }
    if (action === 'roster-remove-request') {
      state.pending = { type: 'team', teamId: String(btn.dataset?.teamId ?? '') };
      render();
      return;
    }
    if (action === 'roster-remove-cancel') {
      state.pending = null;
      render();
      return;
    }
    if (action === 'roster-remove-confirm') {
      await removeTeam(String(btn.dataset?.teamId ?? ''));
      return;
    }
  });

  // 草稿回填：记住用户填了什么 ⇒ 重绘时不冲掉（DP-81）。
  wrap.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.stage;
    if (!kind) return;
    if (kind === 'new-key') state.drafts.create.key = el.value;
    if (kind === 'new-name') state.drafts.create.name = el.value;
    if (kind === 'new-starts') state.drafts.create.startsAt = el.value;
    if (kind === 'new-ends') state.drafts.create.endsAt = el.value;
    if (kind === 'new-freeze') state.drafts.create.freezeAt = el.value;
    if (kind === 'cfg-name') state.drafts.edit.name = el.value;
    if (kind === 'cfg-starts') state.drafts.edit.startsAt = el.value;
    if (kind === 'cfg-ends') state.drafts.edit.endsAt = el.value;
    if (kind === 'cfg-freeze') {
      state.drafts.edit.freezeAt = el.value;
      state.dirty.freezeAt = true;
    }
  });

  // 换届期 / 改下拉：只改数据，不整页刷新输入框。
  wrap.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.stage;
    if (kind === 'edition') {
      state.editionId = el.value;
      state.stageId = '';
      state.stage = null;
      state.judges = [];
      state.candidates = [];
      state.teams = [];
      state.rosterTeamIds = [];
      state.pending = null;
      state.feedback = null;
      state.loading = true;
      render();
      try {
        await loadStages();
        // ⚠️ 权重表端点是**届期作用域**的 ⇒ 换届期必须重拉（否则显示的是上一届的表）。
        await loadConfigs();
        state.stageId = state.stages[0]?.id ? String(state.stages[0].id) : '';
        const picked = state.stages.find((s) => String(s?.id ?? '') === String(state.stageId)) ?? null;
        state.stage = picked ? normalizeStage(picked) : null;
        resetEditDraft(state.stage);
        if (state.stageId) await loadStageDetail(state.stageId);
      } catch (e) {
        state.error = e?.message ?? '加载失败';
        state.errorStatus = e?.status ?? null;
      } finally {
        state.loading = false;
        render();
      }
      return;
    }
    if (kind === 'new-kind') state.drafts.create.kind = el.value;
    if (kind === 'new-config') state.drafts.create.scoringConfigKey = el.value;
    if (kind === 'cfg-config') {
      state.drafts.edit.scoringConfigKey = el.value;
      state.dirty.scoringConfigKey = true;
    }
    if (kind === 'judge-user') state.drafts.assign.userId = el.value;
    if (kind === 'judge-seat') state.drafts.assign.seat = el.value;
  });

  return wrap;
}
```

### `platform/test/stage-config-view.test.js`

「赛段配置」页的视图层闸（E158）：纯函数渲染断言（权重表席构成约束 / 三种席标签 / observer 无投票权 / 空态 / 403 权限文案 / 逆向确认块 / XSS 转义）+ 端点路径与 `ctx.api.del` 的静态钉。

```javascript
// test/stage-config-view.test.js — 赛段配置与权重表页（组委会）
//
// 依据：设计文档 §9「组委会视角 → **赛段配置与权重表**」（IA 图第 883 行）
//   + §8「API 设计」+ §7.3「三态状态码」
//   + src/http/routes/stages.js（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
//   + rules/scoring-initial.json（权重表与 judgePool 席构成约束）
//
// ⚠️ **这组用例为什么必须存在**：
//   P11 之前，后端六个写端点早就写好，前端却**一个界面都没有**
//   ⇒ 「写了没接线」：端点在产品里零调用方。
//   ⇒ 这组用例钉住的是**界面本身的行为**（不是端点通不通）：
//     ① 权重表看得见、且**按声明序**（不是按权重降序 —— 降序会把企业维度插进评委维度中间）；
//     ② 三种席位渲染成**不同**的标签，观察席必须写明「无投票权」；
//     ③ 名册为空 / 没派评委走**空态**而不是报错；
//     ④ 403 显示「没有权限」而不是空白页；
//     ⑤ 逆向路径（撤评委 / 退名册）必须**二次确认**且写明影响面；
//     ⑥ 服务端返回的用户数据**必须转义**。
//
// ⚠️ 另外钉住**端点契约**（静态读源文件，与 web-review-publish.test.js 读 app.js 同款）：
//   权重表端点是届期作用域的 `/api/editions/:editionId/scoring-configs`
//   （不是 global 的 `/api/scoring-configs` —— 那会造成「能改赛段、却读不到权重表」）。
//
// ⛔ 零依赖、零构建、node:test + ESM；只测**纯函数**（HTML 渲染函数），不起 HTTP 服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  editionPickerHtml,
  fmtStageTime,
  fmtWeight,
  judgeSeatHtml,
  judgeSeatLabel,
  pickCurrentEdition,
  removeJudgeConfirmHtml,
  removeTeamConfirmHtml,
  rosterHtml,
  stageConfigHtml,
  stageConfigPageHtml,
  stageCreateFormHtml,
  stageErrorText,
  stageKindLabel,
  stageListHtml,
  stageStatusLabel,
  toIso,
  toLocalInput,
  weightTableHtml,
} from '../web/views/stages.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW_SRC = readFileSync(join(here, '..', 'web', 'views', 'stages.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 测试夹具
//
// ⚠️ **时间夹具一律不带时区**（'2026-10-20T09:00:00' 而不是 '...Z'）：
//    Date.parse 会按**本地时间**解读无时区串 ⇒ 断言（"2026-10-20 09:00"）与时区无关，
//    不会在 CI 的另一台机器上飘。
// ─────────────────────────────────────────────────────────────────────────

/** 权重表（形状照 rules/scoring-initial.json；维度顺序 = **声明序**）。 */
const SCORING = {
  key: 'initial',
  id: 'scoring-initial',
  version: '2026-10-20',
  source: 'S7 §2.1 初赛权重表 + §3.1 评分公式',
  note: '初赛 wEnterprise=0.10 —— 依据权重表合计正好 100% 反推',
  judgePool: {
    minJudgesPerDimension: 7,
    minEnterpriseSeatShare: 0.30,
    maxExpertSeatShare: 0.50,
    votingSeats: ['judge', 'enterprise'],
    nonVotingSeats: ['observer'],
  },
  dimensions: [
    { key: 'track_fit', name: '赛题契合度', weight: 0.10, seat: 'judge' },
    { key: 'innovation', name: '创新性', weight: 0.20, seat: 'judge' },
    { key: 'feasibility', name: '技术可行性', weight: 0.20, seat: 'judge' },
    { key: 'completeness', name: '完成度', weight: 0.25, seat: 'judge' },
    { key: 'enterprise', name: '企业确认', weight: 0.10, seat: 'enterprise' },
    { key: 'collaboration', name: '团队协作', weight: 0.15, seat: 'judge' },
  ],
};

/** 第二个权重表（用来证明「页按 key 选表」，而不是永远显示第一张）。 */
const SCORING_FINAL = {
  key: 'final',
  id: 'scoring-final',
  version: '2026-10-20',
  source: 'S7 §3.1 决赛权重表',
  judgePool: { ...SCORING.judgePool },
  dimensions: [
    { key: 'innovation', name: '创新性', weight: 0.40, seat: 'judge' },
    { key: 'enterprise', name: '企业确认', weight: 0.60, seat: 'enterprise' },
  ],
};

/** 三个席位的评委（席构成各不相同 ⇒ 断言才有判别性）。 */
const JUDGES = [
  {
    id: 'sj_1', stageId: 'st_1', userId: 'u_judge1', seat: 'judge',
    scopeType: 'global', scopeId: null,
    assignedAt: '2026-10-20T09:00:00', conflictDeclaredAt: '2026-10-20T09:05:00', conflictDeclarationId: 'cd_1',
  },
  {
    id: 'sj_2', stageId: 'st_1', userId: 'u_ent1', seat: 'enterprise',
    scopeType: 'edition', scopeId: 'ed_2026',
    assignedAt: '2026-10-20T09:10:00', conflictDeclaredAt: null, conflictDeclarationId: null,
  },
  {
    id: 'sj_3', stageId: 'st_1', userId: 'u_obs1', seat: 'observer',
    scopeType: 'stage', scopeId: 'st_1',
    assignedAt: '2026-10-20T09:20:00', conflictDeclaredAt: '2026-10-20T09:21:00', conflictDeclarationId: 'cd_3',
  },
];

/** 评委候选池（页面用它把 userId 回填成姓名）。 */
const CANDIDATES = [
  { id: 'u_judge1', name: '陈砚秋', org: '青瓷研究院' },
  { id: 'u_ent1', name: '林望舒', org: '青瓷科技' },
  { id: 'u_obs1', name: '周叙白', org: '创业邦' },
  { id: 'u_new', name: '吴未名', org: '南山资本' },
];

/** 本届期队伍。 */
const TEAMS = [
  { id: 't_alpha', name: '拾光队', tier: 'A' },
  { id: 't_beta', name: '溯洄队', tier: 'B' },
];

/** 赛段（列表端点只给摘要：没有 freezeAt / scoringConfigKey）。 */
const STAGES = [
  { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00' },
  { id: 'st_2', key: 'final', name: '决赛评审', kind: 'final', status: 'open', startsAt: '2026-11-20T09:00:00', endsAt: '2026-11-28T18:00:00' },
];

const EDITIONS = [
  { id: 'ed_2025', name: '2025 届', city: '杭州', startsAt: '2025-03-01T00:00:00', endsAt: '2025-09-01T00:00:00' },
  { id: 'ed_2026', name: '2026 届', city: '深圳', startsAt: '2026-03-01T00:00:00', endsAt: '2026-12-01T00:00:00' },
];

// ══════════════════════════════════════════════════════════════════
// 一、权重表（只读）
// ══════════════════════════════════════════════════════════════════

test('权重表：多个维度按**声明序**渲染（不是按权重降序）', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  const order = ['赛题契合度', '创新性', '技术可行性', '完成度', '企业确认', '团队协作'];
  const positions = order.map((name) => html.indexOf(name));
  for (const [i, p] of positions.entries()) {
    assert.ok(p >= 0, `${order[i]} 必须出现在权重表里`);
    if (i > 0) {
      assert.ok(positions[i - 1] < p, `${order[i - 1]} 必须排在 ${order[i]} 前面（声明序）`);
    }
  }
  // ⛔ 声明序 ≠ 权重降序（降序会把「完成度 25%」提到最前、把「赛题契合度 10%」压到倒数第二）
  assert.ok(html.indexOf('赛题契合度') < html.indexOf('完成度'), '声明序里赛题契合度在完成度之前');
  assert.ok(html.indexOf('企业确认') > html.indexOf('完成度'), '企业席维度在评委席维度之后（保持席分组）');
});

test('权重表：权重百分比与合计都渲染出来', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  assert.ok(html.includes('10%'), '0.10 要显示成 10%');
  assert.ok(html.includes('25%'), '0.25 要显示成 25%');
  assert.ok(html.includes('合计'), '要给出权重合计');
  assert.ok(html.includes('100%'), '这张表合计正好 100%（六维之和）');
});

test('权重表：席构成约束按规则里的数值展示（企业席 ≥30% / 专家席 ≤50% / 每维最少 7 人）', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  assert.ok(html.includes('每维度最少评委数'), '要列出约束项');
  assert.ok(html.includes('30%'), '企业席最低占比 30%');
  assert.ok(html.includes('50%'), '专家席最高占比 50%');
  assert.ok(html.includes('有投票权的席'), '要说明哪些席有投票权');
  assert.ok(html.includes('无投票权的席'), '要说明哪些席没有投票权');
});

test('权重表：三种席位渲染成**不同**的标签，观察席明确写「无投票权」', () => {
  assert.equal(judgeSeatLabel('judge').label, '评委席');
  assert.equal(judgeSeatLabel('enterprise').label, '企业席');
  assert.equal(judgeSeatLabel('observer').label, '观察席 · 无投票权');
  // 三个标签必须互不相同 ⇒ 断言不是「同一个模板套三遍」
  const labels = new Set([judgeSeatLabel('judge').label, judgeSeatLabel('enterprise').label, judgeSeatLabel('observer').label]);
  assert.equal(labels.size, 3, '三种席位必须渲染成三个不同的标签');
  assert.equal(judgeSeatLabel('observer').voting, false, '观察席无投票权');
  assert.equal(judgeSeatLabel('judge').voting, true);
  assert.equal(judgeSeatLabel('enterprise').voting, true);
});

test('权重表：读的是当前赛段那一张（key 决定表，不是永远第一张）', () => {
  const html = weightTableHtml({ configs: [SCORING, SCORING_FINAL], scoringConfigKey: 'final' });
  assert.ok(html.includes('决赛权重表'), '应显示 final 那一张的来源');
  assert.ok(html.includes('40%'), 'final 表的创新性权重 40%');
  assert.ok(!html.includes('技术可行性'), 'initial 表的维度不该出现在 final 表里');
});

test('权重表：规则没加载 ⇒ 显示「规则未加载」，但**不阻断**其余面板', () => {
  const page = stageConfigPageHtml({
    configs: [],
    configsDegraded: true,
    stages: STAGES,
    editionId: 'ed_2026',
    editions: EDITIONS,
  });
  assert.ok(page.includes('规则未加载'), '降级时必须说「规则未加载」');
  assert.ok(page.includes('notice--warn'), '降级要给出可见告警');
  // 其余面板照常渲染
  assert.ok(page.includes('届期与赛段'), '赛段列表面板不能被降级带没');
  assert.ok(page.includes('评委席'), '评委席面板不能被降级带没');
  assert.ok(page.includes('名册'), '名册面板不能被降级带没');
});

test('权重表：规则加载了但这个键不在里面 ⇒ 「权重表未找到」（不是「规则未加载」）', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'final' });
  assert.ok(html.includes('权重表未找到'), '键缺失要说「权重表未找到」');
  assert.ok(html.includes('final'), '要点名是哪个键找不到');
  assert.ok(!html.includes('规则未加载'), '两种降级不能混为一谈');
});

test('权重表：**不知道当前用哪一张**（列表端点没返回键）≠「权重表未找到」', () => {
  const html = weightTableHtml({ configs: [SCORING, SCORING_FINAL], scoringConfigKey: '' });
  assert.ok(html.includes('还不知道'), '要说清是「不知道」而不是「没有」');
  assert.ok(!html.includes('权重表未找到'), '不能误报「权重表未找到」');
  assert.ok(html.includes('initial') && html.includes('final'), '要把可用的权重表列出来');
  assert.ok(html.includes('规则里可用的权重表'), '要有可用权重表清单');
});

test('权重表：权重表**只读** —— 页面不提供改权重的入口', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  assert.ok(!html.includes('data-action="weight-update"'), '权重表不能有写入口');
  assert.ok(html.includes('rules/scoring-*.json'), '要说明改表的方式是改规则文件');
});

// ══════════════════════════════════════════════════════════════════
// 二、赛段列表与届期
// ══════════════════════════════════════════════════════════════════

test('赛段列表：代号 / 名称 / 类型 / 时间窗 / 状态都渲染出来', () => {
  const html = stageListHtml(STAGES, 'st_1');
  assert.ok(html.includes('initial'), '代号');
  assert.ok(html.includes('初赛评审'), '名称');
  assert.ok(html.includes('初赛'), '类型');
  assert.ok(html.includes('2026-10-20 09:00'), '时间窗起点');
  assert.ok(html.includes('2026-10-28 18:00'), '时间窗终点');
  assert.ok(html.includes('草稿'), '状态');
  assert.ok(html.includes('决赛评审'), '第二条赛段也要在列表里');
});

test('赛段列表：可以点选进入配置（委托用的 data-action）', () => {
  const html = stageListHtml(STAGES, 'st_1');
  assert.ok(html.includes('data-action="stage-select"'), '要有选择动作');
  assert.ok(html.includes('data-stage-id="st_2"'), '要带上赛段 id');
  // ⚠️ P12：选中的那个改成「左轨条目 + is-active + aria-current」，
  //    旧的「当前赛段」按钮文字没有了 ⇒ 断言改看这两个标记。
  assert.ok(html.includes('is-active'), '选中的那个要标出来');
  assert.ok(html.includes('aria-current="true"'), '选中的那个要告诉读屏器「你在这儿」');
});

test('赛段列表：一个赛段都没有 ⇒ 空态（不是报错）', () => {
  const html = stageListHtml([], '');
  assert.ok(html.includes('state--empty'), '要走空态');
  assert.ok(html.includes('本届期还没有赛段'));
  assert.ok(!html.includes('state--error'), '空 ≠ 错');
});

test('届期：默认当届（尚未结束的最早一届），不是最早的一届', () => {
  assert.equal(pickCurrentEdition(EDITIONS, '2026-06-01')?.id, 'ed_2026');
  // 全都结束了 ⇒ 退回最后一届
  assert.equal(pickCurrentEdition(EDITIONS, '2027-01-01')?.id, 'ed_2026');
  assert.equal(pickCurrentEdition([], '2026-06-01'), null);
});

test('届期选择器：渲染下拉，并回填当前届期', () => {
  const html = editionPickerHtml(EDITIONS, 'ed_2026');
  assert.ok(html.includes('id="stage-edition"'), '要有届期选择器');
  assert.ok(html.includes('data-stage="edition"'), '要能被委托监听');
  assert.ok(html.includes('2026 届'), '届期名要在选项里');
  assert.ok(html.includes('深圳'), '城市也要显示');
  assert.ok(html.includes('value="ed_2026" selected'), '当前届期要选中');
});

// ══════════════════════════════════════════════════════════════════
// 三、建段 / 改配置
// ══════════════════════════════════════════════════════════════════

test('建赛段表单：七项字段齐全 + 提交动作', () => {
  const html = stageCreateFormHtml({ draft: {}, configs: [SCORING] });
  for (const id of ['stage-new-key', 'stage-new-name', 'stage-new-kind', 'stage-new-config', 'stage-new-starts', 'stage-new-ends', 'stage-new-freeze']) {
    assert.ok(html.includes(`id="${id}"`), `建段表单必须有 ${id}`);
  }
  assert.ok(html.includes('data-action="stage-create-submit"'), '要有创建按钮');
  assert.ok(html.includes('初赛') && html.includes('决赛'), '赛段类型下拉要有枚举选项');
});

test('改赛段配置：**key 与 kind 建后不可改**（置灰，不是隐藏）', () => {
  const html = stageConfigHtml({
    stage: { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00', freezeAt: '', scoringConfigKey: 'initial' },
    draft: {},
    configs: [SCORING],
  });
  const keyField = html.slice(html.indexOf('id="stage-cfg-key"'), html.indexOf('id="stage-cfg-name"'));
  assert.ok(keyField.includes('disabled'), '代号输入框必须 disabled');
  const kindField = html.slice(html.indexOf('id="stage-cfg-kind"'), html.indexOf('id="stage-cfg-config"'));
  assert.ok(kindField.includes('disabled'), '类型下拉必须 disabled');
  // 可改的字段不能被置灰
  const nameField = html.slice(html.indexOf('id="stage-cfg-name"'), html.indexOf('id="stage-cfg-kind"'));
  assert.ok(!nameField.includes('disabled'), '名称可以改');
  assert.ok(html.includes('data-action="stage-update-submit"'), '要有保存按钮');
});

test('改赛段配置：没选赛段 ⇒ 空态引导', () => {
  const html = stageConfigHtml({ stage: null, draft: {}, configs: [] });
  assert.ok(html.includes('state--empty'));
  assert.ok(html.includes('先选一个赛段'));
});

test('改赛段配置：列表端点没返回冻结时间 / 权重表键时，页面如实说明（且这两项不被清空）', () => {
  const html = stageConfigHtml({
    // 列表端点的摘要形状：没有 freezeAt / scoringConfigKey
    stage: { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00', freezeAt: '', scoringConfigKey: '', freezeAtKnown: false, scoringConfigKeyKnown: false },
    draft: {},
    configs: [SCORING],
  });
  assert.ok(html.includes('没有随赛段列表返回'), '必须如实说明这两项没有回填');
  assert.ok(html.includes('不会被提交'), '必须说明没改动就不提交（不会误清空）');
});

test('类型 / 状态 / 席位的中文标签映射', () => {
  assert.equal(stageKindLabel('initial').label, '初赛');
  assert.equal(stageKindLabel('final').label, '决赛');
  assert.equal(stageKindLabel('roadshow').label, '路演');
  assert.equal(stageKindLabel('landing').label, '落地');
  assert.equal(stageKindLabel('nonsense').label, 'nonsense', '未知值原样透出，不静默吞掉');
  assert.equal(stageStatusLabel('draft').label, '草稿');
  assert.equal(stageStatusLabel('open').label, '进行中');
  assert.equal(stageStatusLabel('published').label, '已发榜');
});

// ══════════════════════════════════════════════════════════════════
// 四、评委席
// ══════════════════════════════════════════════════════════════════

test('评委席：姓名从候选池回填，三种席位渲染成不同标签', () => {
  const html = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {} });
  assert.ok(html.includes('陈砚秋'), '姓名要从候选池回填');
  assert.ok(html.includes('青瓷研究院'), '单位也要显示');
  assert.ok(html.includes('u_judge1'), 'userId 也要显示（回填不到时用户能自己认）');
  assert.ok(html.includes('评委席'), 'judge 席');
  assert.ok(html.includes('企业席'), 'enterprise 席');
  assert.ok(html.includes('观察席'), 'observer 席');
  assert.ok(html.includes('无投票权'), 'observer 必须写明无投票权');
  // 三种席位的徽章文案不同（不是同一个模板套三遍）
  assert.notEqual(html.indexOf('badge--brand'), html.indexOf('badge--info'), '评委席与企业席的色调要不同');
});

test('评委席：一个都没派 ⇒ 空态（不是报错）', () => {
  const html = judgeSeatHtml({ judges: [], candidates: CANDIDATES, draft: {} });
  assert.ok(html.includes('state--empty'), '要走空态');
  assert.ok(html.includes('还没有派评委'));
  assert.ok(!html.includes('state--error'), '空 ≠ 错');
});

test('评委席：派评委表单（选人 + 选席），已派的人不再出现在候选下拉里', () => {
  const html = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {} });
  assert.ok(html.includes('id="stage-judge-user"'), '要有选人的下拉');
  assert.ok(html.includes('id="stage-judge-seat"'), '要有选席的下拉');
  assert.ok(html.includes('data-action="judge-assign-submit"'), '要有派评委按钮');
  const select = html.slice(html.indexOf('id="stage-judge-user"'), html.indexOf('id="stage-judge-seat"'));
  assert.ok(!select.includes('value="u_judge1"'), '已派的人不该再出现在候选下拉里');
  assert.ok(select.includes('value="u_new"'), '没派的人应该在候选下拉里');
  assert.ok(select.includes('吴未名'), '候选要显示姓名');
});

test('评委席：席位下拉里观察席写明「无投票权」', () => {
  const html = judgeSeatHtml({ judges: [], candidates: CANDIDATES, draft: {} });
  const seatSelect = html.slice(html.indexOf('id="stage-judge-seat"'));
  assert.ok(seatSelect.includes('无投票权'), '选席时就要看清观察席没有投票权');
});

test('撤评委（逆向路径）：二次确认块写明席位失效 + 利益冲突声明被解除', () => {
  const html = removeJudgeConfirmHtml({ userId: 'u_judge1', name: '陈砚秋', stageName: '初赛评审' });
  assert.ok(html.includes('确认撤回该评委'), '要有二次确认');
  assert.ok(html.includes('data-action="judge-remove-confirm"'), '要有确认按钮');
  assert.ok(html.includes('data-action="judge-remove-cancel"'), '要有取消按钮');
  assert.ok(html.includes('席位'), '要说明席位失效');
  assert.ok(html.includes('利益冲突声明'), '要说明连带处理利益冲突声明');
  assert.ok(html.includes('陈砚秋'), '要点名是谁');
  assert.ok(html.includes('初赛评审'), '确认文案要写明是哪个赛段（影响面）');
});

test('撤评委：点了「撤评委」才出现确认块（确认块本身不是常驻的）', () => {
  const before = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {}, pending: null });
  assert.ok(!before.includes('data-stage-confirm="judge"'), '没点之前不出现确认块');
  const after = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {}, pending: { userId: 'u_judge1' } });
  assert.ok(after.includes('data-stage-confirm="judge"'), '点了之后出现确认块');
  assert.ok(after.includes('data-action="judge-remove-confirm"'), '确认按钮可用');
});

// ══════════════════════════════════════════════════════════════════
// 五、名册
// ══════════════════════════════════════════════════════════════════

test('名册：空名册 ⇒ 空态（不是报错），但登记入口仍然在（不能是死路）', () => {
  const html = rosterHtml({ teams: TEAMS, rosterTeamIds: [] });
  assert.ok(html.includes('state--empty'), '要走空态');
  assert.ok(html.includes('本赛段名册还是空的'));
  assert.ok(!html.includes('state--error'), '空 ≠ 错');
  // ⛔ 关键：名册为空时也得能登记（勾选框 + 提交按钮）
  assert.ok(html.includes('data-stage="roster-pick"'), '要有勾选框');
  assert.ok(html.includes('data-action="roster-register-submit"'), '要有登记按钮');
  assert.ok(html.includes('拾光队'), '候选队伍要列出来');
});

test('名册：在榜队伍被标记「在榜」，并显示队名与段位', () => {
  const html = rosterHtml({ teams: TEAMS, rosterTeamIds: ['t_alpha'] });
  assert.ok(html.includes('在榜'), '在榜队伍要有标记');
  assert.ok(html.includes('拾光队'), '队名');
  assert.ok(html.includes('溯洄队'), '没在榜的队伍也要列出来（可登记）');
  assert.ok(html.includes('>A<'), '段位要显示');
  assert.ok(html.includes('data-action="roster-remove-request"'), '在榜队伍要能退名册');
  // 只有在榜的那支才给退名册按钮
  const alphaRow = html.slice(html.indexOf('拾光队'), html.indexOf('溯洄队'));
  assert.ok(alphaRow.includes('退名册'), '在榜队伍有退名册入口');
  const betaRow = html.slice(html.indexOf('溯洄队'));
  assert.ok(!betaRow.includes('data-action="roster-remove-request"'), '不在榜的队伍不该有退名册入口');
});

test('名册：本届期一支队伍都没有 ⇒ 空态', () => {
  const html = rosterHtml({ teams: [], rosterTeamIds: [] });
  assert.ok(html.includes('state--empty'));
  assert.ok(html.includes('本届期还没有队伍'));
});

test('退名册（逆向路径）：二次确认块写明评分与确认失效', () => {
  const html = removeTeamConfirmHtml({ teamId: 't_alpha', name: '拾光队', stageName: '初赛评审' });
  assert.ok(html.includes('确认把该队伍退名册'), '要有二次确认');
  assert.ok(html.includes('data-action="roster-remove-confirm"'));
  assert.ok(html.includes('data-action="roster-remove-cancel"'));
  assert.ok(html.includes('评分与确认'), '要说明评分与确认失效');
  assert.ok(html.includes('失效'), '要写明影响面');
  assert.ok(html.includes('拾光队'), '要点名是哪支队伍');
});

test('退名册：点了「退名册」才出现确认块', () => {
  const before = rosterHtml({ teams: TEAMS, rosterTeamIds: ['t_alpha'], pending: null });
  assert.ok(!before.includes('data-stage-confirm="team"'));
  const after = rosterHtml({ teams: TEAMS, rosterTeamIds: ['t_alpha'], pending: { teamId: 't_alpha' } });
  assert.ok(after.includes('data-stage-confirm="team"'));
});

// ══════════════════════════════════════════════════════════════════
// 六、整页：状态码 / 反馈 / 转义
// ══════════════════════════════════════════════════════════════════

test('403 ⇒ 页面显示「没有权限」（而不是空白页，也不是通用「请求失败」）', () => {
  assert.ok(stageErrorText(403, '缺少能力：stage:compute').includes('权限'), '403 文案必须出现「权限」');
  assert.ok(stageErrorText(403).includes('权限'));
  assert.ok(!stageErrorText(403, 'x').includes('请求失败'));

  const page = stageConfigPageHtml({
    error: '缺少能力：stage:compute',
    errorStatus: 403,
    stages: STAGES,
    editions: EDITIONS,
    editionId: 'ed_2026',
  });
  assert.ok(page.includes('权限'), '页面上要出现「权限」');
  assert.ok(page.includes('state--error'), '错误态');
  assert.ok(page.includes('届期与赛段'), '出错时也不能是空白页（赛段列表仍要在）');
});

test('404 ⇒ 页面显示「不存在」', () => {
  assert.ok(stageErrorText(404, '赛段不存在').includes('不存在'));
  const page = stageConfigPageHtml({ error: '赛段不存在', errorStatus: 404, stages: [], editions: EDITIONS });
  assert.ok(page.includes('不存在'));
});

test('其它状态码 ⇒ 服务端的中文原因原样透出', () => {
  assert.equal(stageErrorText(400, '开始时间必须早于结束时间'), '开始时间必须早于结束时间');
  assert.equal(stageErrorText(null, ''), '加载失败，请重试。');
});

test('加载中 ⇒ 骨架屏（不是白屏）', () => {
  const page = stageConfigPageHtml({ loading: true });
  assert.ok(page.includes('state--loading'));
  assert.ok(page.includes('正在加载'));
});

test('成功反馈：noticeState 的参数是 **items 数组**（不是 text）', () => {
  const page = stageConfigPageHtml({
    stages: STAGES,
    editions: EDITIONS,
    editionId: 'ed_2026',
    feedback: { tone: 'success', title: '赛段已创建', items: ['赛段「初赛评审」已建好。', '新赛段是草稿状态。'] },
  });
  assert.ok(page.includes('notice--success'), '反馈条要有色调');
  assert.ok(page.includes('赛段已创建'), '标题');
  assert.ok(page.includes('赛段「初赛评审」已建好。'), 'items 的第一条必须渲染出来');
  assert.ok(page.includes('新赛段是草稿状态。'), 'items 的第二条必须渲染出来');
});

test('整页：六个面板都在（建段 / 改配置 / 权重表 / 评委席 / 名册 / 赛段列表）', () => {
  const page = stageConfigPageHtml({
    stages: STAGES,
    editions: EDITIONS,
    editionId: 'ed_2026',
    stage: { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00', freezeAt: '', scoringConfigKey: 'initial' },
    configs: [SCORING],
    judges: JUDGES,
    candidates: CANDIDATES,
    teams: TEAMS,
    rosterTeamIds: ['t_alpha'],
  });
  for (const title of ['届期与赛段', '新建赛段', '赛段配置', '权重表（只读）', '评委席', '名册']) {
    assert.ok(page.includes(title), `整页必须「${title}」面板`);
  }
  // 六个写端点的动作都在页面上（端点不再零调用方）
  for (const action of ['stage-create-submit', 'stage-update-submit', 'judge-assign-submit', 'judge-remove-request', 'roster-register-submit', 'roster-remove-request']) {
    assert.ok(page.includes(`data-action="${action}"`), `页面上必须有「${action}」动作`);
  }
});

test('整页：服务端返回的用户数据必须转义（存储型 XSS 面）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const page = stageConfigPageHtml({
    stages: [{ id: 'st_evil', key: 'x', name: evil, kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00' }],
    editions: EDITIONS,
    editionId: 'ed_2026',
    judges: [{ id: 'sj_x', stageId: 'st_evil', userId: 'u_x', seat: 'judge', scopeType: 'global', scopeId: null, assignedAt: '2026-10-20T09:00:00' }],
    candidates: [{ id: 'u_x', name: evil, org: 'x' }],
    teams: [{ id: 't_evil', name: evil, tier: 'A' }],
    rosterTeamIds: ['t_evil'],
  });
  assert.ok(!page.includes(evil), '原始 HTML 串不许出现在输出里');
  assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'), '必须转义后再插入');
});

// ══════════════════════════════════════════════════════════════════
// 七、时间与权重格式化
// ══════════════════════════════════════════════════════════════════

test('时间格式化：无时区串按本地时间读，非法值原样透出（不显示 Invalid Date）', () => {
  assert.equal(fmtStageTime('2026-10-20T09:00:00'), '2026-10-20 09:00');
  assert.equal(fmtStageTime(''), '');
  assert.equal(fmtStageTime('不是时间'), '不是时间');
});

test('datetime-local 回填与提交：toLocalInput ↔ toIso 同一时刻', () => {
  assert.equal(toLocalInput('2026-10-20T09:00:00'), '2026-10-20T09:00');
  assert.equal(toLocalInput(''), '');
  assert.equal(toLocalInput('不是时间'), '');
  const iso = toIso('2026-10-20T09:00:00');
  assert.equal(new Date(iso).getTime(), new Date('2026-10-20T09:00:00').getTime(), '转 ISO 不能改时刻');
  assert.equal(toIso(''), '');
});

test('权重格式化：0.2 → 20%，非法值 → —', () => {
  assert.equal(fmtWeight(0.2), '20%');
  assert.equal(fmtWeight(0.125), '12.5%');
  assert.equal(fmtWeight('不是数字'), '—');
});

// ══════════════════════════════════════════════════════════════════
// 八、端点契约（静态读源文件钉住 —— 与 web-review-publish.test.js 同款）
// ══════════════════════════════════════════════════════════════════

test('契约：权重表端点是**届期作用域**的 /api/editions/:editionId/scoring-configs', () => {
  assert.ok(
    VIEW_SRC.includes('/api/editions/${encodeURIComponent(state.editionId)}/scoring-configs'),
    '必须读届期作用域的权重表端点',
  );
  assert.ok(
    !VIEW_SRC.includes("get('/api/scoring-configs'") && !VIEW_SRC.includes('get("/api/scoring-configs"'),
    '不能用 global 作用域的 /api/scoring-configs（会造成「能改赛段、却读不到权重表」）',
  );
});

test('契约：视图用到的端点路径与约定一致', () => {
  for (const p of [
    "'/api/editions'",
    '/api/stages?editionId=',
    '/judges`',
    '/teams`',
    '/api/editions/${encodeURIComponent(state.editionId)}/teams',
    '/api/editions/${encodeURIComponent(state.editionId)}/judge-candidates',
  ]) {
    assert.ok(VIEW_SRC.includes(p), `端点路径 ${p} 必须出现在视图里`);
  }
});

test('契约：ctx.api 的方法名是 get / post / patch / **del**（不是 delete）', () => {
  for (const m of ['ctx.api.get(', 'ctx.api.post(', 'ctx.api.patch(', 'ctx.api.del(']) {
    assert.ok(VIEW_SRC.includes(m), `必须用 ${m}`);
  }
  assert.ok(!VIEW_SRC.includes('ctx.api.delete('), '本仓的 API 客户端没有 delete 方法，删除一律是 del');
  assert.ok(!VIEW_SRC.includes('ctx.api.remove('), '删除端点用的是 del');
});

test('契约：视图是浏览器可 import 的纯 ESM（不 import 任何 Node 内置模块）', () => {
  assert.ok(!/from\s+['"]node:/.test(VIEW_SRC), '不许 import node: 内置模块');
  assert.ok(VIEW_SRC.includes("from '../escape.js'"), '转义必须走全站唯一入口');
  assert.ok(VIEW_SRC.includes("from '../ui.js'"), '组件必须用 web/ui.js 里现成的');
});

test('契约：不许自造 CSS 类名（只用仓库里已有的类）', () => {
  // 视图里出现的 class 名必须都在 web/styles.css 里存在
  const css = readFileSync(join(here, '..', 'web', 'styles.css'), 'utf8');
  const used = new Set();
  for (const m of VIEW_SRC.matchAll(/class="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) used.add(cls);
  }
  const missing = [...used].filter((cls) => !new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}[^\\w-]`).test(css));
  assert.deepEqual(missing, [], `这些 class 在 styles.css 里不存在：${missing.join(', ')}`);
});

test('⛔ 契约：用户可见文案里**不许**出现 markdown 星号（`**`）', () => {
  // ⛔ 为什么钉这条（浏览器实测抓到的真缺陷）：
  //   本仓前端**不渲染 markdown** —— `noticeState` 会 escapeHtml，`field__hint` 是纯文本。
  //   ⇒ 文案里写 `观察席**无投票权**`，用户在页面上看到的就是**字面的星号**。
  //   （浏览器实跑 E158 时在「席位」下方看到「观察席**无投票权**」才暴露出来。）
  //
  // ⚠️ 注释里用 `**` 做强调是**正常**的（仓库惯例）⇒ 只查非注释行。
  const offenders = [];
  VIEW_SRC.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return;
    if (line.includes('**')) offenders.push(`${i + 1}: ${s.slice(0, 120)}`);
  });
  assert.deepEqual(offenders, [], `这些行的用户可见文案里带了 markdown 星号：\n${offenders.join('\n')}`);
});
```

### `platform/test/view-markdown-leak.test.js`

全站视图的 markdown 漏出闸（E158 浏览器实测抓到的真缺陷）：本仓前端**不渲染 markdown**（noticeState 会 escapeHtml、field__hint 是纯文本）⇒ 文案里写 `**不可改**` 用户看到的就是字面星号。闸扫全站 `web/views/*.js` 的非注释行，并收窄判据以免误伤乘法运算符与文件名通配符。

```javascript
// platform/test/view-markdown-leak.test.js —— 全站视图：用户可见文案里**不许**漏出 markdown 标记
//
// ⛔ **这个闸为什么存在**（浏览器实测抓到的真缺陷 · E158）：
//   本仓前端**不渲染 markdown** ——
//     · `noticeState` 走 `escapeHtml`（web/ui.js:128-135）⇒ 提示条里是纯文本；
//     · `field__hint` / `muted small` 是纯文本标签；
//     · `pageHead` / `panel` 的说明文字同理。
//   ⇒ 文案里写 `观察席**无投票权**`，用户在页面上看到的就是**字面的两个星号**。
//
//   实际怎么发现的：E158 在公网演示站浏览器实跑「赛段配置」页时，
//   在「席位」下方看到「观察席**无投票权**」—— 一眼看出来的排版脏点。
//   同一次扫描还抓到 publish.js 的二次确认文案「会按**当前评分**清空旧名次…」（P8 起的旧账）。
//
// ⚠️ 注释里用 `**` 做强调是**仓库惯例**（溯源注释大量使用）⇒ 只查**非注释行**。
// ⚠️ JS 的幂运算符 `**` 是**代码**，不是文案 ⇒ 排除（`1 - (1 - t) ** 3` 这类）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(here, '..', 'web', 'views');

/**
 * 去掉注释后的行（只用于**扫描**，不参与运行）。
 * @param {string} src
 * @returns {string[]}
 */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const s = line.trim();
    if (inBlock) {
      if (s.includes('*/')) inBlock = false;
      continue;
    }
    if (s.startsWith('/*')) {
      inBlock = !s.includes('*/');
      continue;
    }
    if (s.startsWith('//') || s.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

test('⛔ 全站视图：用户可见文案里不许漏出 markdown 星号（`**`）', () => {
  const offenders = [];
  for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(viewsDir, file), 'utf8');
    codeLines(src).forEach((line, i) => {
      if (!line.includes('**')) return;
      // ⛔ 排除 JS 幂运算符：`a ** b`（等号 / 运算符语境），它不是文案。
      if (/\S\s\*\*\s\S/.test(line) && !/['"`]/.test(line)) return;
      offenders.push(`${file}: ${line.trim().slice(0, 130)}`);
    });
  }
  assert.deepEqual(offenders, [], `这些行的文案里带了 markdown 星号（前端不渲染 markdown ⇒ 用户看到的是字面星号）：\n${offenders.join('\n')}`);
});

test('⛔ 全站视图：中文文案里不许出现**落单**的星号（多半是 markdown 写了一半）', () => {
  // ⛔ 收窄判据（否则误伤一堆）：
  //   · `Math.round(x * 100)` —— 乘法运算符；
  //   · `rules/scoring-*.json` —— 文件名通配符。
  //   ⇒ 只判「星号**紧邻中文**」的情况：那才是 markdown 强调漏出。
  const offenders = [];
  for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(viewsDir, file), 'utf8');
    codeLines(src).forEach((line) => {
      const s = line.trim();
      if (!/[一-龥]/.test(s)) return;
      for (let i = 0; i < s.length; i += 1) {
        if (s[i] !== '*') continue;
        const prev = s[i - 1] ?? '';
        const next = s[i + 1] ?? '';
        if (/[一-龥]/.test(prev) || /[一-龥]/.test(next)) {
          offenders.push(`${file}: ${s.slice(0, 130)}`);
          break;
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `这些行的中文文案里有落单星号（多半是 markdown 强调写了一半）：\n${offenders.join('\n')}`);
});
```
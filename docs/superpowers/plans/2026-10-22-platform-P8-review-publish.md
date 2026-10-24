# P8 —— 评审打分页 + 赛段计算发榜页（赛事能跑起来的最小闭环）

> 阶段：P8（承接 P7「把现有页面打磨到生产级」）
> 日期：2026-10-22
> 上一阶段结论见 [`docs/three-port-alignment.md`](../../three-port-alignment.md) §8

---

## 0. 本阶段要解决什么

**问题一句话**：赛事现在**跑不起来** —— 46 个端点里，评审打分与赛段发榜这两条链路**没有界面入口**，
所以「没人能打分、没人能发榜」，一整届赛事停在报名结束那一刻。

**但后端其实早就齐了**（P2 评审引擎 + P3 榜单 + P4 审计）：

| 端点 | 状态 | 用途 |
|---|---|---|
| `POST /api/stages/:stageId/reviews` | ✅ 已实现（P2） | 评委提交打分（带 `requestId` 幂等） |
| `GET /api/stages/:stageId/review-state` | ✅ 已实现（P2） | 评分进度（已交/应交/缺谁/维度进度） |
| `POST /api/stages/:stageId/compute` | ✅ 已实现（P2） | **计算并发榜**（显式动作，有操作者与时间戳） |
| `GET /api/stages/:stageId/computations/:computationId` | ✅ 已实现（P2） | 计算快照（三件套：input/output/trace） |
| `GET /api/audit/computations/:id` · `/diff` | ✅ 已实现（P4） | 计算留痕与复算 diff |
| `GET /api/leaderboard/:stageId` | ✅ 已实现（P3） | 赛段榜（名次/队名/积分/告警） |

⇒ **P8 的主体是前端**；后端只需要补**一个读口**（见 §3）。

**本阶段不做**（避免范围失控）：
- 企业确认双签页、自评提交页、互评页、回避申报页、校准打分页（P2 后端都有，前端下一轮补）
- 申诉受理页（P4 后端有）
- 赛程日历（ical 已在后端）、三池可视化

---

## 1. 两个页面的职责边界

| | 评审打分页 | 赛段计算发榜页 |
|---|---|---|
| 路由 | `#/review/:stageId` | `#/publish/:stageId` |
| 谁用 | **评委**（本赛段评委席）/ 企业席 / 观察员（只读） | **组委会**（`stage:compute`） |
| 核心动作 | 给本赛段的队伍**逐维度打分**并提交 | **显式**触发一次赛段计算并落榜 |
| 不可逆性 | 打分**可改**（改分留审计痕） | 发榜**影响奖金** ⇒ 必须二次确认 |
| 产出 | `stage_reviews` 行 | `stage_results` 行 + `computations` 快照 + 审计日志 |

⛔ **两条铁律**：
1. **前端不按角色拦路**（沿用 P7 DP-77）：路由守卫**只判登录态**；能不能打分/发榜由 **API 裁决**（403 → 错误态说清缺什么能力）。
2. **发榜是不可逆的**：`POST .../compute` 会清场重算并写 `stage_results` ⇒ 必须有**二次确认**（确认框写明赛段 + 影响面）。

---

## 2. 页面结构（沿用 P7 的设计系统）

### 2.1 评审打分页 `#/review/:stageId`

```
页头：赛段名 + 副标题（赛段口径）+ 右侧「返回榜单」
指标行（statRow）：我的已交 / 应交 / 缺交 / 我的身份
面板 ①：评审进度（维度 × 队伍 的完成度）
面板 ②：队伍评分表（每队一块）
    队名 + 任务包
    每个评委席维度一行：
        维度名（权重 %）
        数字输入（0–100，min=0 max=100 step=1）
        「未打分」占位 / 已给的分
    底部：「提交本队评分」按钮 + 提交结果反馈
面板 ③：降级/提示说明（口径来自 API，不自己编）
```

**为什么用数字输入而不是 1–5 单选**：
- 后端的分值范围是 **0–100**（`assertScoreInRange`），1–5 单选会**丢分辨率**（评委只能给 5 档）；
- 报名页的 1–5 是**问卷量表**（P1 的报名评分规则就是 1–5），评审是**百分制打分** ⇒ 两者口径不同，不能共用控件；
- 数字输入更密（每维度 1 个输入框，而不是 5 个按钮）⇒ 符合 P7「信息密度」目标；
- ⛔ 仍然**不用 `<select>`**（沿用 DP-82）。

### 2.2 赛段计算发榜页 `#/publish/:stageId`

```
页头：赛段名 + 副标题 + 「返回榜单」
指标行（statRow）：评分完成度 / 名册队伍 / 已计算次数 / 告警条数
面板 ①：发榜前检查
    评分进度（已交/应交）
    评委池合规提示（来自 API 告警，不自己判）
    名册里「没人评过」的队（来自 API）
面板 ②：发榜操作
    「计算并发榜」按钮 → 二次确认 → POST /api/stages/:id/compute
    结果表：名次 / 队伍 / P 席分 / E 席分 / 总分 / 段位
    告警（置顶，分「硬降级 / 提示」两级）
    「查看计算留痕」→ #/audit/:computationId
    「查看赛段榜」→ #/leaderboard/:stageId
```

---

## 3. 后端最小扩展（**只读，一个端点**）

### 3.1 `GET /api/stages/:stageId/review-board`

**为什么需要**：前端要拼出「本赛段有哪些队伍 + 有哪些可打分维度 + 我已经给了多少分」，
这三样东西现在**分散在三个地方且没有一个端点**：
- 名册：`listStageTeams`（仓储层，**只有 teamId，没有队名**）
- 维度：`rules.scoring[stage.scoring_config_key].dimensions`（规则文件，**没有端点**）
- 我的分：`stage_reviews`（**没有任何读端点**）

⇒ 补一个**一次拿齐**的读口，避免前端拼三个请求还拼错口径。

**权限**（与 `GET /api/stages/:stageId/review-state` **完全同口径**）：
组委会（`stage:compute`）/ 有 `score:read`（赛段级或全局）/ **本赛段评委** ⇒ 否则 403。

**返回形状**：

```js
{
  stage: { id, key, name, kind, status, scoringConfigKey },
  dimensions:      [{ key, name, weight, seat }],   // 该赛段权重表的全部维度
  judgeDimensions: [{ key, name, weight }],         // seat === 'judge'（评委可打分的）
  teams:           [{ id, name, taskPackageTitle, isFreeBrief }],
  myScores:        [{ teamId, dimension, rawScore }], // **只返回本人的**（改分要回填）
  progress:        { submitted, total, missing, dimensionProgress },
}
```

⛔ **`myScores` 只返回本人的**：改分要回填本人已给的分，而**别人的分**不该出现在评审页上
（赛段结果处于 `PENDING_REVIEW` 时，可见性由 `filterVisibleScores` 管；本页不需要那份全局数组）。

### 3.2 仓储层新增（**纯只读**）

`src/db/repo/stages.js`：

```js
export function listStageTeamRows(db, stageId) { … }   // 名册 + 队名 + 任务包标题
```

⚠️ **排序兜底键用 SQLite 隐式 `rowid`**（全局约束）⇒ `ORDER BY t.created_at, t.rowid`。
⚠️ **队名是外部输入** ⇒ 前端渲染必须走 `escapeHtml`（全站唯一入口 `web/escape.js`）。

### 3.3 服务层新增

`src/services/review.js`：

```js
export function getReviewBoard({ db, stageId, viewer, rules }) { … }
```

### 3.4 演示适配器

`web/api.demo.js` 补 `GET /api/stages/:stageId/review-board`，形状**逐字段对齐**真实后端
（沿用 P7 建的 `platform/test/demo-api-parity.test.js` 端点覆盖闸）。

---

## 4. 前端改动清单

| 文件 | 归属 | 动作 |
|---|---|---|
| `web/views/review.js` | **P8 新建** | 评审打分页 |
| `web/views/publish.js` | **P8 新建** | 赛段计算发榜页 |
| `web/nav.js` | P7 owns | Modify：加「评审席」分区 + 组委会分区加「赛段发榜」 |
| `web/app.js` | P0 owns | Modify：加两条路由 |
| `web/api.demo.js` | P6 owns | Modify：补 review-board 端点 |
| `src/http/routes/review.js` | P2 owns | Modify：加一条 GET 路由 |
| `src/services/review.js` | P2 owns | Modify：加 `getReviewBoard` |
| `src/db/repo/stages.js` | P2 owns | Modify：加 `listStageTeamRows` |

⛔ **不新建 `web/views/` 之外的前端文件**；⛔ 两个新视图都走 `web/ui.js` 的现成原语
（`pageHead` / `statRow` / `panel` / `tableWrap` / `badge` / `emptyState` / `errorState` / `loadingState`）。

---

## 5. 导航分区（`web/nav.js`）

新增分区「**评审席**」（需登录）：

| 路径 | 标签 |
|---|---|
| `/review` | 评审打分 |

⚠️ `/review`（不带赛段）需要**赛段选择器** ⇒ 新增 `web/views/review-index.js`？

⚠️ **范围决策**：`GET /api/stages` 已存在（P7 加的）⇒ 评审打分页**自带赛段选择器**，
所以路由直接是 `#/review/:stageId`，导航入口指向 `/review` 时由页面**自己**选赛段（query `?stageId=`）。

⇒ **决策**：导航入口 = `#/review`（页面内选赛段），路由 = `#/review` 与 `#/review/:stageId` **两条**。
同理发榜页 = `#/publish` 与 `#/publish/:stageId`。

---

## 6. 验收标准

| 项 | 判据 |
|---|---|
| 全量测试 | `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **0 失败** |
| 机器闸 | `audit-scan` / `temp-leak-scan` / `bash-var-scan` 退出码均 **0** |
| 漂移审计 | `node docs/tools/plan-block-audit.mjs platform --selftest` ⇒ **C-RW = 0、D = 0** |
| 计划块核验 | 本阶段触及的每个文件在 owning 阶段的计划里 **逐字一致** |
| 新增用例 | 后端 `review-board` 端点用例（权限三档 + 形状逐字段）；前端两页的**行为断言**（不是文本匹配） |
| 变异检验 | 对本阶段新判据做变异，**存活变异必须修或显式标注等价** |
| 演示站 | 演示适配器形状与真实后端**逐字段一致**（`demo-api-parity` 闸） |
| 真机 | 8444 平台上两个页面**可打开、可打分、可发榜**，无错误态、无英文技术错误 |

---

## 7. 新建文件（逐字块）

> ⛔ 计划块必须与最终实现**逐字一致**（`plan-block-sync.mjs --verify` 核验）。

### `platform/web/views/review.js`

`platform/web/views/review.js`：

```javascript
// web/views/review.js — 评审打分页（P8 新建）
//
// 规则溯源：
//   - 「评委按维度打分，分值 0–100」→ INTERFACES.md §3「API（P2）」+ 评审引擎 `assertScoreInRange`
//   - 「评分只增不改，改分留痕」→ 评审引擎（同 teamId+dimension 覆盖写 + 审计）
//   - 「可见性在 API 层过滤」→ 设计文档 §6.6（本页只显示**本人**给的分）
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//
// ⚠️ **为什么用 0–100 数字输入，不用 1–5 单选**（P8 DP-95）：
//   报名页的 1–5 是**问卷量表**（P1 的报名评分规则就是 1–5）；
//   评审是**百分制打分**（后端 `assertScoreInRange` 卡的是 0–100）。
//   两者口径不同，**不能共用控件** —— 1–5 单选会让评委只能给 5 档，直接丢分辨率。
//   ⇒ 用数字输入（更密，也更诚实）。⛔ 仍然**不用 `<select>`**（沿用 DP-82）。
//
// ⚠️ **纯函数与 DOM 接线分离**：
//   「分值解析 / 组装 items」抽成纯函数（parseScore / buildReviewItems）⇒ 可直接断言；
//   DOM 只负责把输入框的值收上来。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  sectionTitle, statRow,
} from '../ui.js';

const MIN_SCORE = 0;
const MAX_SCORE = 100;

/**
 * 分值解析（纯函数）。
 * @param {unknown} raw 输入框原始值
 * @returns {{value: number|null}|{error: string}}  空值 = 未打分
 */
export function parseScore(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: '必须是数字' };
  if (n < MIN_SCORE || n > MAX_SCORE) return { error: `必须在 ${MIN_SCORE}–${MAX_SCORE} 之间` };
  return { value: n };
}

/**
 * 汇总一支队伍的打分 → items + 错误清单（纯函数）。
 *
 * ⚠️ **本地校验前置**（P7 的通用纪律）：不发无谓请求 ——
 *    有一题没填就发请求，服务端会整批拒（`assertScoreInRange`），评委白等一次往返。
 *
 * @param {Record<string,string>} values key = `${teamId}::${dimension}`
 * @param {Array<{teamId:string,key:string,name?:string}>} cells 要打的格子
 * @returns {{items: Array<object>, errors: Array<object>}}
 */
export function buildReviewItems(values, cells) {
  const items = [];
  const errors = [];
  for (const cell of cells ?? []) {
    const raw = (values ?? {})[`${cell.teamId}::${cell.key}`];
    const parsed = parseScore(raw);
    if (parsed.error) {
      errors.push({ teamId: cell.teamId, dimension: cell.key, dimensionName: cell.name ?? null, message: parsed.error });
      continue;
    }
    if (parsed.value === null) {
      errors.push({ teamId: cell.teamId, dimension: cell.key, dimensionName: cell.name ?? null, message: '还没打分' });
      continue;
    }
    items.push({ teamId: cell.teamId, dimension: cell.key, rawScore: parsed.value });
  }
  return { items, errors };
}

/**
 * 维度键 → 中文维度名（展示层专用，E184）。
 * ⚠️ 找不到名字时**退到「未知维度」**，不把英文键打给人看
 *    （内部标识不许出现在界面上 —— 与告警 `code` 同一类纪律）。
 */
function dimNameOf(dims, key) {
  const hit = (dims ?? []).find((d) => d?.key === key);
  return hit?.name || '未知维度';
}

/**
 * 评审页的**错误提示正文**（纯函数，E184）。
 * ⚠️ 必须是**纯函数且被生产路径调用** —— 否则「不许显示英文维度键」这条闸
 *    就会在测试里**重写一遍拼接逻辑** ⇒ 改生产代码闸不会红 ⇒ 假绿
 *    （变异检验 M5 实测抓到过这个洞）。
 * @param {Array<{dimension?:string, dimensionName?:string|null, message?:string}>} errors
 * @param {Array<{key:string,name?:string}>} dims 维度表（judgeDimensions）
 */
export function reviewErrorHint(errors, dims) {
  return (errors ?? [])
    .map((x) => `${x?.dimensionName || dimNameOf(dims, x?.dimension)}：${x?.message ?? ''}`)
    .join('；');
}

/** 幂等键：每次提交生成一个（见 §「为什么每次点击都换 requestId」）。 */
function newRequestId() {
  const g = globalThis.crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 指标行（纯函数）。
 * ⚠️ 「已交/缺交」有两套口径（API 的 `progress.scope` 标明）：
 *    - scope='mine'  ⇒ 评委视角：只看**自己**交了几格；
 *    - scope='stage' ⇒ 组委会视角：看**全赛段**（评委 × 队伍 × 维度）交了几格。
 *   ⇒ 标签必须跟着口径走，否则又是「数字与标签对不上」（P7 B1 的同款事故）。
 */
export function reviewStats(board) {
  const progress = board?.progress ?? {};
  const stageScope = progress.scope === 'stage';
  const submitted = Number(progress.submitted ?? 0);
  const total = Number(progress.total ?? 0);
  const teams = Array.isArray(board?.teams) ? board.teams.length : 0;
  const dims = Array.isArray(board?.judgeDimensions) ? board.judgeDimensions.length : 0;
  return [
    {
      label: stageScope ? '本赛段已交' : '我的已交',
      value: submitted,
      tone: 'brand',
      hint: `应交 ${total} 格`,
    },
    { label: '待评队伍', value: teams, tone: 'neutral', hint: `${dims} 个评委席维度` },
    {
      label: '完成度',
      value: total > 0 ? `${Math.round((submitted / total) * 100)}%` : '—',
      tone: total > 0 && submitted >= total ? 'success' : 'warn',
    },
    {
      label: '我的身份',
      value: stageScope ? '组委会' : '评委',
      tone: 'info',
      hint: '打分可改，改分留审计痕',
    },
  ];
}

/** 一支队伍的评分表单（纯函数）。 */
export function reviewTeamFormHtml(team, dimensions, myScores) {
  const scoreOf = (dimKey) => {
    const hit = (myScores ?? []).find((s) => s.teamId === team.id && s.dimension === dimKey);
    return hit ? String(hit.rawScore) : '';
  };
  const fields = (dimensions ?? []).map((d) => `
      <div class="field">
        <label class="field__label" for="score-${escapeHtml(team.id)}-${escapeHtml(d.key)}">
          ${escapeHtml(d.name)} <span class="muted small">权重 ${Math.round((d.weight ?? 0) * 100)}%</span>
        </label>
        <input class="input" type="number" id="score-${escapeHtml(team.id)}-${escapeHtml(d.key)}"
               data-team="${escapeHtml(team.id)}" data-dimension="${escapeHtml(d.key)}"
               min="${MIN_SCORE}" max="${MAX_SCORE}" step="1"
               value="${escapeHtml(scoreOf(d.key))}" placeholder="0–100" />
      </div>`).join('');

  const given = (dimensions ?? []).map((d) => scoreOf(d.key) !== '');
  const hasAny = given.some(Boolean);
  const allDone = given.length > 0 && given.every(Boolean);
  return `
    <section class="panel" data-team="${escapeHtml(team.id)}">
      <div class="panel__head">
        <h2 class="panel__title">${escapeHtml(team.name)}</h2>
        <p class="panel__desc">${escapeHtml(team.taskPackageTitle || '未认领任务包')}</p>
      </div>
      <div class="panel__body">
        ${fields || '<p class="muted">该赛段没有评委席维度。</p>'}
        <div class="btn-group">
          <button type="button" class="btn btn--primary" data-action="submit-team" data-team="${escapeHtml(team.id)}">
            ${hasAny ? '更新本队评分' : '提交本队评分'}
          </button>
          ${allDone ? badge('已交齐', 'success') : (hasAny ? badge('部分已交', 'warn') : badge('待提交', 'warn'))}
        </div>
        <div class="form-feedback" data-feedback="${escapeHtml(team.id)}"></div>
      </div>
    </section>`;
}

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, board, stages, stageId }
 */
export function reviewHtml(model) {
  if (model?.loading) {
    return pageHead({ title: '评审打分' }) + loadingState({ rows: 4, label: '正在加载评审工作台…' });
  }
  if (model?.error) {
    return pageHead({ title: '评审打分' }) + errorState({ message: model.error, hint: '需要本赛段评委身份或 score:read 能力。' });
  }
  // ⚠️ 没选赛段 ⇒ 给赛段选择器（导航入口 `#/review` 落到这里）
  if (!model?.board) {
    const stages = Array.isArray(model?.stages) ? model.stages : [];
    const list = stages.length
      ? `<ul class="list-divided">${stages.map((s) => `<li class="row row--between">
          <span>${escapeHtml(s.name)} <span class="muted small">${escapeHtml(s.key)}</span></span>
          <a class="btn btn--ghost btn--sm" href="#/review/${escapeHtml(s.id)}">进入评审</a>
        </li>`).join('')}</ul>`
      : emptyState({ title: '还没有赛段', hint: '组委会创建赛段后，这里会出现可评审的赛段。' });
    return pageHead({ title: '评审打分', sub: '选择一个赛段开始评审。' })
      + panel({ title: '赛段', desc: '只有被分配为本赛段评委的账号能进来打分。', body: list });
  }

  const board = model.board;
  const teams = Array.isArray(board.teams) ? board.teams : [];
  const dims = Array.isArray(board.judgeDimensions) ? board.judgeDimensions : [];
  const head = pageHead({
    title: `评审打分 · ${board.stage?.name ?? ''}`,
    sub: '按维度给每支队伍打分（0–100）。打分可以改，改分会留下审计记录。',
    actions: [
      { label: '看榜单', href: '#/leaderboard' },
      { label: '换个赛段', href: '#/review' },
    ],
  });
  const stats = statRow(reviewStats(board));
  if (!teams.length) {
    return head + stats + panel({
      title: '赛段名册',
      body: emptyState({ title: '这个赛段还没有队伍', hint: '队伍组建完成后，赛段名册会自动出现在这里。' }),
    });
  }
  const forms = teams.map((t) => reviewTeamFormHtml(t, dims, board.myScores)).join('');
  const stageScope = board.progress?.scope === 'stage';
  const missingCount = (board.progress?.missing ?? []).length;
  // ⛔ P9.1 修正（真机复验抓出）：状态行**必须由数字判定**，不能拿「missing 为空」当「都交了」。
  //    原来 `missingCount === 0 ⇒ 「本赛段的评分都交了」`，而「没有本赛段席位」的账号
  //    后端给的 missing 是空的（他本来就没有格子可打）⇒ 同一屏上出现
  //    「0 我的已交 / 应交 20 格 / 完成度 0%」+「本赛段的评分都交了」——自相矛盾。
  //    现在四个分支各自由 `total` / `submitted` 决定，任何一屏都不会出现互相打架的话。
  const total = Number(board.progress?.total ?? 0);
  const submitted = Number(board.progress?.submitted ?? 0);
  const notice = total === 0
    ? noticeState({
      tone: 'info',
      title: stageScope ? '这个赛段还没有需要打分的格子' : '你不是本赛段的评委',
      items: [stageScope
        ? '还没给这个赛段安排评委，所以现在没有任何需要打分的格子。'
        : '你没有被分配到这个赛段 —— 评审打分只对本赛段的评委开放。'],
    })
    : missingCount > 0
      ? noticeState({
        tone: 'warn',
        title: stageScope ? '还有未交的打分' : '还有未打的格子',
        items: [stageScope
          ? `本赛段还差 ${missingCount} 格（按评委 × 队伍 × 维度计）。`
          : `你还差 ${missingCount} 格没打分。缺格的队伍会在计算时被记为「没有该维度得分」。`],
      })
      : submitted >= total
        ? noticeState({ tone: 'success', title: '本赛段的评分都交了', items: ['组委会计算发榜后会采用最新的一次打分。'] })
        : noticeState({
          tone: 'warn',
          title: '还有格子没交齐',
          items: [`已交 ${submitted} 格，应交 ${total} 格 —— 还差 ${total - submitted} 格。`],
        });

  return head + stats + notice
    + sectionTitle('赛段名册')
    + forms;
}

// ══════════════════════════════════════════════════════════════════
// 挂载
// ══════════════════════════════════════════════════════════════════

/** 收集页面上所有输入框的值 → `{ 'teamId::dimension': '值' }`。 */
function collectValues(root) {
  const values = {};
  for (const el of root.querySelectorAll('input[data-dimension]')) {
    values[`${el.dataset.team}::${el.dataset.dimension}`] = el.value;
  }
  return values;
}

/**
 * 评审打分页。
 *
 * ⚠️ **为什么每次点击都换 requestId**：
 *   幂等的**真正**保护是「同一 (teamId, dimension) 只能有一条分」——
 *   重发同一份内容在服务端是**覆盖写**（改分同值）⇒ 不会双计。
 *   而 requestId 保护的是**同一次点击的并发重复** ⇒ 每次点击一个即可。
 *   （若复用同一个 requestId 而内容变了，服务端会 409「同一 requestId 内容不同」——
 *     那反而会让「改完分再点一次」失败。）
 */
export async function renderReview(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'review-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';

  /** 拉工作台并渲染。 */
  const load = async () => {
    if (!stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = reviewHtml({ stages: Array.isArray(stages) ? stages : (stages?.items ?? []) });
      return;
    }
    wrap.innerHTML = reviewHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
      wrap.innerHTML = reviewHtml({ board });
    } catch (e) {
      wrap.innerHTML = reviewHtml({ error: e.message });
    }
  };

  await load();

  // ⚠️ 提交：本地校验 → 发请求 → 就地反馈（不整页刷新，DP-81）
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action="submit-team"]');
    if (!btn) return;
    const teamId = btn.dataset.team;
    const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
    const dims = (board.judgeDimensions ?? []).map((d) => ({ teamId, key: d.key, name: d.name }));
    const values = collectValues(wrap);
    const { items, errors } = buildReviewItems(values, dims);
    const feedback = wrap.querySelector(`[data-feedback="${teamId}"]`);
    if (errors.length) {
      if (feedback) {
        feedback.innerHTML = errorState({
          message: `还有 ${errors.length} 格没填好`,
          // ⚠️ **E184（2026-10-28）：显示中文维度名，不显示英文维度键** ——
          //    `feasibility` 是**内部标识**（与告警的 `code` 同一类：内部工作语言），
          //    评委看到的是「技术可行性」而不是键名。
          //    ⚠️ 数据层仍然保留键（`errors[].dimension` 是机器判据，提交时要用）
          //    ⇒ **只改展示层**，不改数据形状。
          //    找不到名字时退到「未知维度」而不是键名（宁可少说，不许把内部键打给人看）。
          hint: reviewErrorHint(errors, dims),
        });
      }
      return;
    }
    try {
      await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/reviews`, {
        requestId: newRequestId(),
        items,
      });
      // ⚠️ **先刷新工作台，再写反馈**：刷新会整体重建 wrap.innerHTML，
      //    先写反馈会被刷掉（顺序反了 = 提交成功却什么都没显示）。
      await load();
      const done = wrap.querySelector(`[data-feedback="${teamId}"]`);
      if (done) {
        done.innerHTML = noticeState({
          tone: 'success',
          title: '已提交',
          items: [`本队 ${items.length} 个维度已记入（改分同样走这里，会留审计痕）。`],
        });
      }
    } catch (e) {
      const fb = wrap.querySelector(`[data-feedback="${teamId}"]`);
      if (fb) fb.innerHTML = errorState({ message: e.message });
    }
  });

  return wrap;
}
```

### `platform/web/views/publish.js`

`platform/web/views/publish.js`：

```javascript
// web/views/publish.js — 赛段计算发榜页（P8 新建 · P11 补「发榜」这半个动作）
//
// 规则溯源：
//   - 「compute 是**显式动作**，发榜影响奖金，必须有明确的操作者与时间戳」→ src/services/compute.js 文件头
//   - 「不阻断发榜，但必须显式暴露」（评委池不合规 / 降级告警）→ compute.js 的终审修正 I-2
//   - 「三件套快照可复算」→ R-AUD-01（input / output / trace）
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//   - 「TOP10 名单事后电话回访」→ S7 §4.1（R-JDG-16）
//
// ⛔ **P11 · E149：计算与发榜是两个动作，页面必须给两个按钮**
//   设计文档 §869：「`compute` 是显式动作，不自动触发。**发榜**是一个有后果的动作
//   （影响奖金），必须有明确的操作者与时间戳。」
//   ⇒ 页面此前只有**一个**「计算并发榜」按钮，点了只算不发 ⇒
//     名次积分从未发放、段位永远 D 段、榜单快照为空、发榜没有留痕（真机实测）。
//   ⇒ 现在两个动作各有各的按钮、各有的二次确认文案：
//     · 「重新计算」= 清场重算（覆盖名次/总分/积分，可逆：再算一次即可）
//     · 「发布榜单」= 写快照 / 段位记录 / 名次积分 / 发榜审计（影响奖金）
//
// ⛔ **发榜是不可逆的**（P8 DP-96）：
//   `POST /api/stages/:stageId/compute` 会**清场重算**并写 `stage_results`
//   （compute.js 的 `resetStageResults`）⇒ 名次、总分、积分全被覆盖。
//   ⇒ 必须**二次确认**，且确认文案要写明**赛段 + 影响面**（不是「确定吗？」）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  statRow, tableWrap,
} from '../ui.js';

/**
 * 会被当成「硬降级」的告警码。
 * ⚠️ 口径来自 compute.js 的告警语义：**影响得分口径**的才是硬降级，其余只是提示。
 *    - judge_pool_invalid：评委池不合规（规则里的席构成/下限没达标）
 *    - normalization_fallback：评委宽严归一化降级 ⇒ 分数口径变了
 *    - dimension_no_scores：某个维度**没有任何评分** ⇒ 该维度权重记 0
 *    - team_no_reviews：某支队伍**完全没人评过** ⇒ 不参与排名
 *    - R2_missing_dual_signature：企业确认缺双签 ⇒ 企业项按 0 分计
 *    - recusal_excluded：因回避剔除打分
 */
const HARD_WARNING_CODES = new Set([
  'judge_pool_invalid',
  'normalization_fallback',
  'dimension_no_scores',
  'team_no_reviews',
  'R2_missing_dual_signature',
  'recusal_excluded',
]);

/**
 * 告警分级（纯函数）。
 * ⚠️ **E184（2026-10-28）：分级标签改成人话（`【硬降级】` / `【提示】`）** ——
 *    原来把内部规则键当正文前缀打出来（`【normalization_fallback】……`）
 *    ⇒ 界面上出现了内部工作语言。分级判定本身**仍然按 code 判**
 *    （`HARD_WARNING_CODES` 是判据，不是展示物）⇒ 只是不把 code 显示出来。
 *    ⚠️ 这条纪律与 `web/views/audit.js` 的审计页口径一致（那里用的是
 *    `【硬降级】` / `【提示】`）⇒ 两处不再各说一套。
 * @param {Array<object>} warnings
 * @returns {{hard: string[], soft: string[]}}
 */
export function publishWarnings(warnings) {
  const hard = [];
  const soft = [];
  for (const w of Array.isArray(warnings) ? warnings : []) {
    const code = w?.code ?? '';
    const text = w?.message ?? String(w);
    if (HARD_WARNING_CODES.has(code)) hard.push(`【硬降级】${text}`);
    else soft.push(`【提示】${text}`);
  }
  return { hard, soft };
}

/** 指标行（纯函数）。 */
export function publishStats(board, result) {
  const progress = board?.progress ?? {};
  const total = Number(progress.total ?? 0);
  const submitted = Number(progress.submitted ?? 0);
  const teams = Array.isArray(board?.teams) ? board.teams.length : 0;
  const warns = publishWarnings(result?.warnings ?? []);
  const scored = Array.isArray(result?.teams) ? result.teams.length : null;
  return [
    {
      label: '评分完成度',
      value: total > 0 ? `${Math.round((submitted / total) * 100)}%` : '—',
      tone: total > 0 && submitted >= total ? 'success' : 'warn',
      hint: `已交 ${submitted} / 应交 ${total} 格`,
    },
    { label: '名册队伍', value: teams, tone: 'brand' },
    {
      label: '本次落榜',
      value: scored === null ? '未发榜' : scored,
      tone: scored === null ? 'neutral' : 'success',
      hint: scored === null ? '还没有执行过计算' : '参与本轮排名的队伍（没打分的队伍按「没有该维度得分」计入）',
    },
    {
      label: '告警',
      value: warns.hard.length + warns.soft.length,
      tone: warns.hard.length ? 'danger' : (warns.soft.length ? 'warn' : 'success'),
      hint: `硬降级 ${warns.hard.length} · 提示 ${warns.soft.length}`,
    },
  ];
}

/**
 * 发榜结果表（纯函数）。
 * ⚠️ `compute` 返回的 `teams` **只有 teamId**（没有队名）⇒ 用名册映射队名。
 */
export function publishResultHtml(result, boardTeams) {
  const rows = Array.isArray(result?.teams) ? result.teams : [];
  if (!rows.length) {
    return emptyState({
      title: '还没有发榜结果',
      hint: '点「重新计算」执行一次计算：引擎会按当前评分算出名次与总分，并把输入/输出/计算过程三件套存成快照。',
    });
  }
  const nameOf = (id) => {
    const hit = (boardTeams ?? []).find((t) => t.id === id);
    return hit ? hit.name : id;
  };
  const ordered = [...rows].sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">P 席分</th><th class="td-num">E 席分</th><th class="td-num">总分</th></tr></thead>`
    + `<tbody>${ordered.map((r, i) => `<tr>`
      + `<td>${i + 1}</td>`
      + `<td>${escapeHtml(nameOf(r.teamId))}</td>`
      + `<td class="td-num num">${escapeHtml(round2(r.seatP))}</td>`
      + `<td class="td-num num">${escapeHtml(round2(r.seatE))}</td>`
      + `<td class="td-num num">${escapeHtml(round2(r.total))}</td>`
      + `</tr>`).join('')}</tbody>`,
    { caption: '本轮计算结果（按总分降序）' },
  );
}

/**
 * 「缺谁该打分」（纯函数）—— 数据来自 `GET /api/stages/:stageId/review-state`。
 *
 * ⛔ P11：这条读口原先**前端从不调用** ⇒ 组委会发榜时看不到「哪支队伍、哪个维度还没人打分」，
 *    只能靠猜。P9.1 的真机复验已经踩过同一个坑（`total=0` 却显示「都有打分」）。
 *
 * ⚠️ 组委会视角的 `missing` 带 `judgeId` ⇒ 按评委分组展示；普通评委视角只有自己的缺格。
 *
 * ⛔ **E184（2026-10-28）：显示中文维度名，不显示英文维度键** ——
 *    `feasibility` 是**内部标识**（与告警 `code` 同一类：内部工作语言）。
 *    ⚠️ 名字来自**同一份 review-board**（`judgeDimensions`）⇒ 与打分表里显示的名字同源，
 *    不会出现「打分表写中文、催评清单写英文」的两套口径。
 *    找不到名字时退到「未知维度」而不是键名（宁可少说，不许把内部键打给人看）。
 */
export function publishMissingHtml(reviewState, boardTeams, judgeDimensions = []) {
  const missing = Array.isArray(reviewState?.missing) ? reviewState.missing : [];
  if (!missing.length) {
    return noticeState({
      tone: 'success',
      title: '没有缺格：该打分的人都交了',
      items: ['名册里的队伍、该赛段的评委席维度都已覆盖。'],
    });
  }
  const nameOf = (id) => {
    const hit = (boardTeams ?? []).find((t) => t.id === id);
    return hit ? hit.name : id;
  };
  const dimNameOf = (key) => {
    const hit = (judgeDimensions ?? []).find((d) => d?.key === key);
    return hit?.name || '未知维度';
  };
  // 按评委分组（组委会视角才有 judgeId）
  const byJudge = new Map();
  for (const m of missing) {
    const key = m.judgeId ?? 'me';
    if (!byJudge.has(key)) byJudge.set(key, []);
    byJudge.get(key).push(m);
  }
  const items = [...byJudge.entries()].map(([judgeId, list]) => {
    const who = judgeId === 'me' ? '我' : `评委 ${judgeId}`;
    const cells = list.map((m) => `${nameOf(m.teamId)} · ${dimNameOf(m.dimension)}`);
    return `${who}：还差 ${list.length} 格 —— ${cells.join('；')}`;
  });
  return noticeState({
    tone: 'warn',
    title: `缺谁该打分（${missing.length} 格）`,
    items,
    list: true,
  });
}

/**
 * 发榜状态 + TOP 名单回访清单（纯函数）—— 数据来自 `GET /api/stages/:stageId/publish`。
 *
 * ⛔ P11：这两块此前**完全没有读口** ⇒ 页面刷新后不知道自己发过榜，
 *    也不知道 R-JDG-16 的「TOP10 事后电话回访」清单长什么样。
 */
export function publishStateHtml(publishState, boardTeams) {
  if (!publishState) return '';
  const nameOf = (id) => {
    const hit = (boardTeams ?? []).find((t) => t.id === id);
    return hit ? hit.name : id;
  };
  if (!publishState.published) {
    return noticeState({
      tone: 'warn',
      title: '这个赛段还没发榜',
      items: ['榜单快照、段位记录与名次积分都还没写 —— 奖金与段位权益因此没有依据。'],
    });
  }
  const snaps = Array.isArray(publishState.snapshots) ? publishState.snapshots : [];
  const tasks = Array.isArray(publishState.reverseAuditTasks) ? publishState.reverseAuditTasks : [];
  const head = `
    <div class="row">
      ${badge(`已发榜`, 'success')}
      ${badge(`快照 ${snaps.length} 份`, 'neutral')}
      ${badge(publishState.publishedAt ? `发榜于 ${publishState.publishedAt}` : '发榜时间未知', 'info')}
    </div>`;
  const taskBody = tasks.length
    ? tableWrap(
      `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">总分</th><th>回访指令</th></tr></thead>`
      + `<tbody>${tasks.map((t) => `<tr>`
        + `<td>${escapeHtml(t.rank ?? '—')}</td>`
        + `<td>${escapeHtml(nameOf(t.teamId))}</td>`
        + `<td class="td-num num">${escapeHtml(t.total ?? '—')}</td>`
        + `<td>${escapeHtml(t.instruction ?? '')}</td>`
        + `</tr>`).join('')}</tbody>`,
      { caption: 'TOP 名单回访任务（R-JDG-16：只生成任务，不代劳、不自动结案）' },
    )
    : emptyState({ title: '暂无回访清单', hint: '发榜后这里会出现 TOP 名单（默认 10 支）供组委会电话回访。' });
  return head
    + (tasks.length
      ? `<h3 class="panel__title" style="margin-top:var(--sp-3)">TOP 名单回访</h3>${taskBody}`
      : taskBody);
}

/** 保留两位小数（分数会出现 15.200000000000003 这种浮点尾巴）。 */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

/**
 * 二次确认块（纯函数）。
 * @param {string} stageName 赛段名
 * @param {number|string} teamCount 影响几支队伍
 * @param {'compute'|'publish'} [kind] 确认的是哪个动作
 *   ⚠️ P11：两个动作的**影响面完全不同**，确认文案必须分开写 ——
 *     「重新计算」覆盖的是名次/总分/积分（再算一次即可）；
 *     「发布榜单」写的是榜单快照 / 段位记录 / 名次积分 / 发榜审计（**影响奖金**）。
 */
export function publishConfirmHtml(stageName, teamCount, kind = 'compute') {
  const isPublish = kind === 'publish';
  const title = isPublish ? '确认发布榜单？' : '确认执行发榜？';
  const text = isPublish
    ? `赛段「${escapeHtml(stageName)}」将正式发布：写榜单快照、重算段位记录、发放名次积分（影响奖金），并留下带操作者与时间戳的发榜审计。${escapeHtml(teamCount)} 支队伍进入公示。`
    : `赛段「${escapeHtml(stageName)}」会按<strong>当前评分</strong>清空旧名次并重算落榜（${escapeHtml(teamCount)} 支队伍参与排名）。这一步影响奖金与公示，且会覆盖上一次的名次、总分与积分。`;
  const confirmAction = isPublish ? 'publish-leaderboard-confirm' : 'publish-confirm';
  const requestAction = isPublish ? 'publish-leaderboard-request' : 'publish-request';
  return `
    <div class="notice notice--warn" data-publish-confirm="${escapeHtml(kind)}">
      <p class="notice__title">${title}</p>
      <p class="notice__text">${text}</p>
      <div class="btn-group">
        <button type="button" class="btn btn--primary" data-action="${confirmAction}">${isPublish ? '确认发榜' : '确认发榜'}</button>
        <button type="button" class="btn btn--ghost" data-action="publish-cancel">取消</button>
      </div>
      <p class="muted small" data-confirm-hint="${escapeHtml(kind)}">${isPublish ? '发榜后可再次发榜以更正（差额走积分更正记录）。' : '这一步只重算，不发布。'}</p>
      <span class="muted small" data-confirm-origin="${escapeHtml(requestAction)}"></span>
    </div>`;
}

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, board, result, stages, stageId, reviewState, publishState }
 */
export function publishHtml(model) {
  if (model?.loading) {
    return pageHead({ title: '赛段计算发榜' }) + loadingState({ rows: 4, label: '正在加载发榜工作台…' });
  }
  if (model?.error) {
    return pageHead({ title: '赛段计算发榜' })
      + errorState({ message: model.error, hint: '发榜需要组委会权限（stage:compute 能力点）。' });
  }
  if (!model?.board) {
    const stages = Array.isArray(model?.stages) ? model.stages : [];
    const list = stages.length
      ? `<ul class="list-divided">${stages.map((s) => `<li class="row row--between">
          <span>${escapeHtml(s.name)} <span class="muted small">${escapeHtml(s.key)}</span></span>
          <a class="btn btn--ghost btn--sm" href="#/publish/${escapeHtml(s.id)}">进入发榜</a>
        </li>`).join('')}</ul>`
      : emptyState({ title: '还没有赛段', hint: '组委会创建赛段后，这里会出现可发榜的赛段。' });
    return pageHead({ title: '赛段计算发榜', sub: '选择一个赛段执行计算与发榜。' })
      + panel({ title: '赛段', body: list });
  }

  const board = model.board;
  const result = model.result ?? null;
  const warns = publishWarnings(result?.warnings ?? []);
  const head = pageHead({
    title: `计算发榜 · ${board.stage?.name ?? ''}`,
    sub: '计算与发榜是两个独立动作：先算清、再发布。发榜影响奖金，必须有操作者与时间戳。',
    actions: [{ label: '看榜单', href: '#/leaderboard' }],
  });

  const progress = board.progress ?? {};
  const missingTeams = [...new Set((progress.missing ?? []).map((m) => m.teamId))];
  // ⛔ P9.1 修正（真机复验抓出）：「名册里的队伍都有打分」**不能**只看 `missingTeams` 是否为空。
  //    该赛段**一个评委都没派**时，`progress.total` 与 `submitted` 都是 0、missing 也是空
  //    ⇒ 旧判据会报「名册里的队伍都有打分 / 可以执行计算发榜」，
  //    而真发榜后引擎对每支队伍每个维度都产出 `dimension_no_scores` 告警（实测 30 条）。
  //    现在三个分支各自由数字决定：没有格子 ⇒ 直说「一格都没打」；有格子且有缺格 ⇒ 催评；
  //    有格子且不缺 ⇒ 才算「都有打分」。
  const submitted = Number(progress.submitted ?? 0);
  const total = Number(progress.total ?? 0);
  const checkBody = `
    <div class="row">
      ${badge(`已交 ${submitted} 格`, total > 0 && submitted >= total ? 'success' : 'warn')}
      ${badge(`应交 ${total} 格`, 'neutral')}
      ${badge(`名册 ${(board.teams ?? []).length} 支`, 'brand')}
    </div>
    ${total === 0
      ? noticeState({
        tone: 'warn',
        title: '这个赛段一格都还没打',
        items: ['还没有给赛段派评委，或一格都没交 —— 现在发榜，每支队伍的每个维度都会按「没有该维度得分」处理（引擎会逐条告警）。'],
      })
      : missingTeams.length
        ? noticeState({
          tone: 'warn',
          title: `有 ${missingTeams.length} 支队伍还缺打分`,
          items: [
            '没被评到的队伍不参与排名（引擎按「没有任何评分」处理），发榜前最好先催评。',
            ...missingTeams.map((id) => {
              const t = (board.teams ?? []).find((x) => x.id === id);
              return t ? t.name : id;
            }),
          ],
          list: true,
        })
        : noticeState({ tone: 'success', title: '名册里的队伍都有打分', items: ['可以执行计算发榜。'] })}`;

  // ⛔ P11：两个动作，各有各的按钮与各自的二次确认。
  const actionBody = `
    <div class="btn-group" data-publish-actions>
      <button type="button" class="btn btn--ghost" data-action="publish-request">重新计算</button>
      <button type="button" class="btn btn--primary" data-action="publish-leaderboard-request">发布榜单</button>
    </div>
    <p class="muted small" style="margin-top:var(--sp-3)">
      「重新计算」按当前评分清场重算并覆盖名次与总分；「发布榜单」才会写榜单快照、段位记录与名次积分（影响奖金）。
    </p>
    ${result?.computationId
      ? `<p class="muted small" style="margin-top:var(--sp-3)">
          快照 <code>${escapeHtml(result.computationId)}</code>（第 ${escapeHtml(result.revision ?? '—')} 版）
          · <a href="#/audit/${escapeHtml(result.computationId)}">查看计算留痕</a>
          · <a href="#/leaderboard/${escapeHtml(board.stage?.id ?? '')}">查看赛段榜</a>
        </p>`
      : ''}`;

  const warnBody = result
    ? (warns.hard.length || warns.soft.length
      ? noticeState({
        tone: warns.hard.length ? 'danger' : 'warn',
        title: `本轮告警（${warns.hard.length + warns.soft.length}）`,
        items: [...warns.hard, ...warns.soft],
        list: true,
      })
      : noticeState({ tone: 'success', title: '本轮没有告警', items: ['归一化生效、评委池合规、无回避剔除。'] }))
    : '';

  const missingBody = model.reviewState
    ? publishMissingHtml(model.reviewState, board.teams, board.judgeDimensions)
    : '';
  const stateBody = publishStateHtml(model.publishState, board.teams);

  return head
    + statRow(publishStats(board, result))
    + panel({ title: '发榜前检查', desc: '这些结论都来自 API，前端不自己判定。', body: checkBody })
    + (missingBody ? panel({ title: '缺谁该打分', desc: '按评委分组列出还没交的格子（来自评审进度读口）。', body: missingBody }) : '')
    + panel({ title: '发榜操作', desc: '影响奖金的操作需要二次确认。', body: actionBody })
    + (stateBody ? panel({ title: '发榜状态', desc: '发过榜没有、发了什么、TOP 名单回访清单。', body: stateBody }) : '')
    + (warnBody ? panel({ title: '告警', body: warnBody }) : '')
    + panel({ title: '本轮结果', desc: '按总分降序；名次在发榜后同时进入赛段榜与滚动总榜。', body: publishResultHtml(result, board.teams) });
}

// ══════════════════════════════════════════════════════════════════
// 挂载
// ══════════════════════════════════════════════════════════════════

/**
 * 赛段计算发榜页。
 *
 * ⚠️ **二次确认是内联的**（不是 `window.confirm`）：
 *   原生弹窗在生产环境不可控（样式不可控、无法承载「影响面」说明、自动化测试也测不了）。
 *   ⇒ 点按钮先把按钮换成一个**说明影响面的确认块**，再点确认才发请求。
 */
export async function renderPublish(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'publish-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';
  let result = null;
  let reviewState = null;
  let publishState = null;

  const load = async () => {
    if (!stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = publishHtml({ stages: Array.isArray(stages) ? stages : (stages?.items ?? []) });
      return;
    }
    wrap.innerHTML = publishHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
      // ⚠️ 这两个读口是**辅助信息**：拉不到不能连累整页（权限不足 / 端点不可用时仍要能看主面板）。
      reviewState = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-state`).catch(() => null);
      publishState = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/publish`).catch(() => null);
      wrap.innerHTML = publishHtml({ board, result, reviewState, publishState });
    } catch (e) {
      wrap.innerHTML = publishHtml({ error: e.message });
    }
  };

  await load();

  wrap.addEventListener('click', async (ev) => {
    const action = ev.target?.closest?.('[data-action]')?.dataset?.action;
    if (!action) return;
    const actionsBox = wrap.querySelector('[data-publish-actions]');

    if (action === 'publish-request' || action === 'publish-leaderboard-request') {
      // 先拉一次名册，把「影响面」写进确认文案
      let teamCount = 0;
      let stageName = '';
      try {
        const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
        teamCount = (board.teams ?? []).length;
        stageName = board.stage?.name ?? '';
      } catch {
        // 拉不到就照常给确认框（真正提交时还会再失败一次）
      }
      const kind = action === 'publish-leaderboard-request' ? 'publish' : 'compute';
      if (actionsBox) actionsBox.outerHTML = publishConfirmHtml(stageName, teamCount, kind);
      return;
    }
    if (action === 'publish-cancel') {
      await load();
      return;
    }
    if (action === 'publish-confirm' || action === 'publish-leaderboard-confirm') {
      const box = wrap.querySelector('[data-publish-confirm]');
      const isPublish = action === 'publish-leaderboard-confirm';
      if (box) box.innerHTML = loadingState({ rows: 1, label: isPublish ? '正在发布榜单…' : '正在计算…' });
      try {
        if (isPublish) {
          // ⛔ 发榜是**独立**的动作：写快照 / 段位记录 / 名次积分 / 发榜审计
          await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/publish`, {});
        } else {
          result = await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/compute`, {});
        }
        await load();
      } catch (e) {
        const box2 = wrap.querySelector('[data-publish-confirm]');
        if (box2) box2.innerHTML = errorState({ message: e.message });
      }
    }
  });

  return wrap;
}
```

### `platform/test/web-review-publish.test.js`

`platform/test/web-review-publish.test.js`：

```javascript
// platform/test/web-review-publish.test.js —— P8 两个新页面的行为闸
//
// 规则溯源：
//   - 「评审按维度打分，0–100」→ 评审引擎 `assertScoreInRange`
//   - 「发榜是显式动作，影响奖金 ⇒ 二次确认」→ src/services/compute.js 文件头
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//   - 「本地校验前置，不发无谓请求」→ P7 的通用纪律
//
// ⚠️ 本文件全部是**行为断言**，不是文本匹配：
//    「缺一格就不能提交」「发榜必须二次确认」「进度标签必须跟着口径走」
//    这些判据只能从**纯函数的输出**里看出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseScore, buildReviewItems, reviewStats, reviewHtml, reviewTeamFormHtml,
} from '../web/views/review.js';
import {
  publishWarnings, publishStats, publishResultHtml, publishConfirmHtml, publishHtml,
} from '../web/views/publish.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const APP_JS = readFileSync(join(webDir, 'app.js'), 'utf8');
const NAV_JS = readFileSync(join(webDir, 'nav.js'), 'utf8');

const DIMS = [
  { key: 'innovation', name: '创新性', weight: 0.2 },
  { key: 'feasibility', name: '技术可行性', weight: 0.2 },
];
const TEAMS = [{ id: 't_alpha', name: '拾光队', taskPackageTitle: '库存周转' }];

/** 造一份工作台数据。 */
function board(over = {}) {
  return {
    stage: { id: 'stage_final', key: 'final', name: '决赛赛段', kind: 'final', status: 'computed', scoringConfigKey: 'final' },
    dimensions: [...DIMS.map((d) => ({ ...d, seat: 'judge' })), { key: 'enterprise', name: '企业确认', weight: 0.1, seat: 'enterprise' }],
    judgeDimensions: DIMS.map((d) => ({ ...d, seat: 'judge' })),
    teams: TEAMS,
    myScores: [],
    progress: { scope: 'mine', submitted: 0, total: 2, missing: [{ teamId: 't_alpha', dimension: 'innovation' }], dimensionProgress: {} },
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════
// 一、分值解析与本地校验
// ══════════════════════════════════════════════════════════════════

test('分值解析：空 = 未打分（不是 0 分）', () => {
  assert.deepEqual(parseScore(''), { value: null });
  assert.deepEqual(parseScore('  '), { value: null });
  assert.deepEqual(parseScore(undefined), { value: null });
});

test('分值解析：0 和 100 都是合法分（边界内）', () => {
  assert.deepEqual(parseScore('0'), { value: 0 });
  assert.deepEqual(parseScore('100'), { value: 100 });
});

test('分值解析：越界与非数字 ⇒ 报错（后端也会拒，但前端不该把无谓请求发出去）', () => {
  assert.ok(parseScore('101').error, '101 必须被拦');
  assert.ok(parseScore('-1').error, '-1 必须被拦');
  assert.ok(parseScore('abc').error, '非数字必须被拦');
  assert.ok(parseScore('88.5').value === 88.5, '小数是合法分');
});

test('本地校验：缺一格 ⇒ 既有 items 也有 errors（且该格不进 items）', () => {
  const cells = [{ teamId: 't_alpha', key: 'innovation' }, { teamId: 't_alpha', key: 'feasibility' }];
  const { items, errors } = buildReviewItems({ 't_alpha::innovation': '88' }, cells);
  assert.equal(items.length, 1, '只填一格只能产出一个 item');
  assert.equal(items[0].rawScore, 88);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].dimension, 'feasibility');
  assert.match(errors[0].message, /还没打分/);
});

test('本地校验：全填齐 ⇒ 没有错误、items 数量 = 维度数', () => {
  const cells = [{ teamId: 't_alpha', key: 'innovation' }, { teamId: 't_alpha', key: 'feasibility' }];
  const { items, errors } = buildReviewItems({ 't_alpha::innovation': '88', 't_alpha::feasibility': '70' }, cells);
  assert.equal(errors.length, 0);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.dimension), ['innovation', 'feasibility']);
  assert.ok(items.every((i) => typeof i.teamId === 'string' && typeof i.rawScore === 'number'));
});

test('本地校验：越界的格子进 errors 而不是 items（不能把非法分发出去）', () => {
  const cells = [{ teamId: 't_alpha', key: 'innovation' }];
  const { items, errors } = buildReviewItems({ 't_alpha::innovation': '150' }, cells);
  assert.equal(items.length, 0);
  assert.equal(errors.length, 1);
});

// ══════════════════════════════════════════════════════════════════
// 二、进度口径（标签必须跟着口径走）
// ══════════════════════════════════════════════════════════════════

test('指标行：scope=mine（评委）⇒ 标签是「我的已交」「评委」', () => {
  const cards = reviewStats(board());
  assert.equal(cards[0].label, '我的已交');
  assert.equal(cards.at(-1).value, '评委');
});

test('指标行：scope=stage（组委会）⇒ 标签是「本赛段已交」「组委会」', () => {
  const cards = reviewStats(board({ progress: { scope: 'stage', submitted: 12, total: 20, missing: [] } }));
  assert.equal(cards[0].label, '本赛段已交');
  assert.equal(cards[0].value, 12);
  assert.equal(cards.at(-1).value, '组委会');
});

test('指标行：完成度按 total 算（total=0 ⇒ 不许出现 NaN）', () => {
  const cards = reviewStats(board({ progress: { scope: 'mine', submitted: 0, total: 0, missing: [] } }));
  assert.equal(cards[2].value, '—');
});

// ══════════════════════════════════════════════════════════════════
// 三、评审打分页渲染
// ══════════════════════════════════════════════════════════════════

test('评审页：每支队伍一块表单，含队名、维度、权重与 0–100 输入框', () => {
  const html = reviewTeamFormHtml(TEAMS[0], board().judgeDimensions, []);
  assert.ok(html.includes('拾光队'), '必须显示队名');
  assert.ok(html.includes('库存周转'), '必须显示任务包');
  assert.ok(html.includes('创新性'), '必须显示维度名');
  assert.ok(html.includes('权重 20%'), '必须显示权重');
  assert.ok(html.includes('type="number"'), '打分控件必须是数字输入');
  assert.ok(html.includes('min="0"') && html.includes('max="100"'), '必须声明 0–100 范围');
  assert.ok(!html.includes('<select'), '评审页不许用 <select>（DP-82）');
});

test('评审页：已给的分要回填到输入框（改分场景）', () => {
  const html = reviewTeamFormHtml(TEAMS[0], board().judgeDimensions, [
    { teamId: 't_alpha', dimension: 'innovation', rawScore: 88 },
  ]);
  assert.ok(html.includes('value="88"'), '已给的分必须回填');
  assert.ok(html.includes('更新本队评分'), '已提交过的要显示「更新」');
});

test('评审页：队名里的 HTML 必须转义（服务端数据是外部输入）', () => {
  const evil = { id: 't_x', name: '<img src=x onerror=alert(1)>', taskPackageTitle: 'x' };
  const html = reviewTeamFormHtml(evil, board().judgeDimensions, []);
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
  assert.ok(html.includes('&lt;img'));
});

test('评审页：没选赛段 ⇒ 给赛段选择器（不是空白页）', () => {
  const html = reviewHtml({ stages: [{ id: 'stage_final', key: 'final', name: '决赛赛段' }] });
  assert.ok(html.includes('决赛赛段'));
  assert.ok(html.includes('#/review/stage_final'), '必须能点进赛段');
});

test('评审页：加载态与错误态都要有（外壳三件套）', () => {
  assert.ok(reviewHtml({ loading: true }).includes('正在加载'));
  assert.ok(reviewHtml({ error: '没有查看评审工作台的权限' }).includes('没有查看评审工作台的权限'));
  assert.ok(reviewHtml({ error: 'x' }).includes('data-action="retry"'), '错误态必须有重试按钮');
});

// ══════════════════════════════════════════════════════════════════
// 四、发榜页：告警分级 / 结果 / 二次确认
// ══════════════════════════════════════════════════════════════════

test('发榜告警：影响得分口径的码 ⇒ 硬降级；其余 ⇒ 提示', () => {
  const { hard, soft } = publishWarnings([
    { code: 'judge_pool_invalid', message: '评委池不合规' },
    { code: 'normalization_fallback', message: '归一化降级' },
    { code: 'dimension_no_scores', message: '某维度无评分' },
    { code: 'team_no_reviews', message: '某队没人评过' },
    { code: 'R2_missing_dual_signature', message: '企业确认缺双签' },
    { code: 'recusal_excluded', message: '因回避剔除' },
    { code: 'some_hint', message: '只是一条提示' },
  ]);
  assert.equal(hard.length, 6, '六类硬降级必须都被认出来');
  assert.equal(soft.length, 1);
  assert.ok(hard[0].includes('评委池不合规'));
});

test('发榜告警：空数组 ⇒ 两边都空（不是 undefined）', () => {
  const { hard, soft } = publishWarnings([]);
  assert.deepEqual(hard, []);
  assert.deepEqual(soft, []);
  assert.deepEqual(publishWarnings(undefined).hard, []);
});

test('发榜结果：队名用名册映射（compute 返回的 teams 只有 teamId）', () => {
  const html = publishResultHtml({ teams: [{ teamId: 't_alpha', seatP: 80, seatE: 90, total: 81 }] }, TEAMS);
  assert.ok(html.includes('拾光队'), '必须显示队名而不是 teamId');
  assert.ok(html.includes('81'), '必须显示总分');
});

test('发榜结果：按总分降序排列', () => {
  const html = publishResultHtml({
    teams: [
      { teamId: 't_a', seatP: 10, seatE: 10, total: 10 },
      { teamId: 't_b', seatP: 90, seatE: 90, total: 90 },
    ],
  }, [{ id: 't_a', name: '甲队' }, { id: 't_b', name: '乙队' }]);
  assert.ok(html.indexOf('乙队') < html.indexOf('甲队'), '高分队必须在前');
});

test('发榜结果：浮点尾巴要修掉（15.200000000000003 不能直接上屏）', () => {
  const html = publishResultHtml({ teams: [{ teamId: 't_a', seatP: 15.200000000000003, seatE: 0, total: 15.2 }] }, [{ id: 't_a', name: '甲队' }]);
  assert.ok(!html.includes('15.200000000000003'), '不能把浮点尾巴显示给用户');
  assert.ok(html.includes('15.2'));
});

test('发榜结果：没有结果 ⇒ 空态（说清下一步）', () => {
  const html = publishResultHtml(null, []);
  assert.ok(html.includes('还没有发榜结果'));
  // ⚠️ P11：按钮名从「计算并发榜」改成「重新计算」——
  //    因为**计算与发榜是两个动作**（设计文档 §869），发榜另有「发布榜单」按钮。
  assert.ok(html.includes('重新计算'), '空态必须告诉用户下一步做什么');
});

test('二次确认：必须写明**赛段 + 影响面**（不能只写「确定吗？」）', () => {
  const html = publishConfirmHtml('决赛赛段', 5);
  assert.ok(html.includes('决赛赛段'), '必须写明是哪个赛段');
  assert.ok(html.includes('5'), '必须写明影响几支队伍');
  assert.ok(html.includes('清空旧名次') || html.includes('覆盖'), '必须写明会覆盖上一次');
  assert.ok(html.includes('data-action="publish-confirm"'), '必须有确认按钮');
  assert.ok(html.includes('data-action="publish-cancel"'), '必须有取消按钮');
});

test('发榜页：默认状态显示「计算并发榜」按钮（不是直接就发请求）', () => {
  const html = publishHtml({ board: board() });
  assert.ok(html.includes('data-action="publish-request"'));
  assert.ok(!html.includes('data-action="publish-confirm"'), '没点之前不该出现确认按钮');
});

test('发榜页：有结果 ⇒ 显示结果表 + 告警 + 留痕链接', () => {
  const html = publishHtml({
    board: board(),
    result: {
      computationId: 'cmp_1',
      revision: 3,
      teams: [{ teamId: 't_alpha', seatP: 80, seatE: 90, total: 81 }],
      warnings: [{ code: 'judge_pool_invalid', message: '评委池不合规' }],
    },
  });
  assert.ok(html.includes('拾光队'));
  assert.ok(html.includes('81'));
  assert.ok(html.includes('cmp_1'), '必须给出快照 id');
  assert.ok(html.includes('#/audit/cmp_1'), '必须能进计算留痕');
  assert.ok(html.includes('评委池不合规'), '硬降级必须显式露出');
});

test('发榜页：指标行的「本次落榜」在没发榜时写「未发榜」（不许显示 0 冒充已发榜）', () => {
  const cards = publishStats(board(), null);
  const card = cards.find((c) => c.label === '本次落榜');
  assert.equal(card.value, '未发榜');
});

// ══════════════════════════════════════════════════════════════════
// 五、路由与导航（死链闸 + 分区）
// ══════════════════════════════════════════════════════════════════

const ROUTES = [...APP_JS.matchAll(/route\(\s*'([^']+)'/g)].map((m) => m[1]);

function routeMatches(pattern, path) {
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return false;
  return pp.every((seg, i) => seg.startsWith(':') || seg === xp[i]);
}
function hasRoute(hashPath) {
  const clean = hashPath.replace(/^#/, '').replace(/\?.*$/, '');
  return ROUTES.some((r) => routeMatches(r, clean));
}

test('死链闸：新增的两个导航入口都有对应路由', () => {
  assert.ok(hasRoute('#/review'), '导航里有「评审打分」⇒ 必须有 /review 路由');
  assert.ok(hasRoute('#/publish'), '导航里有「赛段发榜」⇒ 必须有 /publish 路由');
  assert.ok(hasRoute('#/review/stage_final'), '赛段级评审路由必须存在');
  assert.ok(hasRoute('#/publish/stage_final'), '赛段级发榜路由必须存在');
});

test('死链闸：主导航的全部 path 都有对应路由（含 P8 新增的两条）', () => {
  const paths = [...NAV_JS.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 8, `导航路径扫到 ${paths.length} 条，正则可能失效`);
  for (const p of paths) assert.ok(hasRoute(p), `死链：导航项 ${p} 没有对应路由`);
});

test('导航分区：新增「评审席」分区且**不按角色限定**（评委是赛段级指派的）', () => {
  assert.ok(/id:\s*'reviewer'/.test(NAV_JS), '必须有「评审席」分区');
  // ⚠️ 只切到**下一个分区**为止（切长了会吃到组委会分区的 roles ⇒ 误判）
  const start = NAV_JS.indexOf("id: 'reviewer'");
  const end = NAV_JS.indexOf("id: '", start + 10);
  const block = NAV_JS.slice(start, end === -1 ? undefined : end);
  assert.ok(!/roles:\s*\[/.test(block), '评审席分区不许按角色限定（会误伤赛段级指派的评委）');
});

test('路由守卫：评审与发榜都需要登录（但不按角色拦）', () => {
  assert.ok(/pattern:\s*\/\^\\\/review/.test(NAV_JS), '评审页必须进受保护路由');
  assert.ok(/pattern:\s*\/\^\\\/publish/.test(NAV_JS), '发榜页必须进受保护路由');
});
```

### `platform/test/review-board-api.test.js`

`platform/test/review-board-api.test.js`：

```javascript
// platform/test/review-board-api.test.js —— P8 评审工作台读口（GET /api/stages/:stageId/review-board）
//
// 规则溯源：
//   - 「权限模型 = capability + assignment，can() 是唯一判定入口」→ 设计文档 §7.1/§7.2
//   - 「三态状态码」→ 设计文档 §7.3（未登录 → 401；禁用 → 403；单条不存在 → 404）
//   - 「可见性在 API 层过滤」→ 设计文档 §6.6（前端隐藏 = 数据已泄露）
//   - 「评分只增不改，改分留痕」→ R-JDG / 评审引擎
//
// ⚠️ 这个端点是 P8 **唯一新增的后端接口**，它一次性解决「前端拼评分表单要三样东西、
//    但三样东西都没有对外读口」的问题 ⇒ 一旦形状漂移，评审页会**静默地**显示错的东西
//    （比如漏一个维度 ⇒ 评委以为那维度不用打分）。
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
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-revboard-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000051', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000052', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000053', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000054', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: null, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: judge.id, role: 'member', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, judge, judge2, admin, outsider, team1, team2, stage,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function teardown(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════
// 一、权限闸门（与 review-state 同口径）
// ══════════════════════════════════════════════════════════════════

test('未登录读评审工作台 → 401', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`);
  assert.equal(res.status, 401);
  teardown(s);
});

test('无权限者读评审工作台 → 403（既不是评委、也没有 score:read / stage:compute）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'FORBIDDEN');
  teardown(s);
});

test('本赛段评委可读（不需要 score:read）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(res.status, 200);
  teardown(s);
});

test('组委会可读（有 stage:compute 即��）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  teardown(s);
});

test('赛段不存在 → 404（不是 403 也不是 200 空集）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', '/api/stages/stage_nonexistent/review-board', { token: s.tokenAdmin });
  assert.equal(res.status, 404);
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、返回形状（前端拼评分表单要的四样东西必须都在）
// ══════════════════════════════════════════════════════════════════

test('评审工作台：名册带**队名**与任务包标题（listStageTeams 只有 teamId ⇒ 前端显示不出队名）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(res.status, 200);
  const { teams } = res.json;
  assert.equal(teams.length, 2);
  assert.deepEqual(teams.map((t) => t.name).sort(), ['一队', '二队']);
  assert.ok(teams.every((t) => typeof t.id === 'string' && t.id));
  assert.ok(teams.every((t) => typeof t.taskPackageTitle === 'string'), '任务包标题必须带出来');
  teardown(s);
});

test('评审工作台：judgeDimensions 只含 seat=judge 的维度（评委不能给企业席/自评席打分）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  const { dimensions, judgeDimensions } = res.json;
  assert.ok(dimensions.length > judgeDimensions.length, '总维度必须多于评委席维度（否则白名单失效）');
  assert.ok(judgeDimensions.every((d) => d.seat === 'judge'));
  assert.ok(!judgeDimensions.some((d) => d.seat === 'enterprise'), '企业席维度不能进评委可打分清单');
  for (const d of judgeDimensions) {
    assert.ok(typeof d.key === 'string' && typeof d.name === 'string', '维度必须有 key 与名称');
    assert.equal(typeof d.weight, 'number', '维度必须有权重（前端要显示权重占比）');
  }
  teardown(s);
});

test('评审工作台：进度分母 = 队伍数 × 评委席维度数（不是「已出现过的维度」）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  const { progress, teams, judgeDimensions } = res.json;
  assert.equal(progress.total, teams.length * judgeDimensions.length);
  assert.equal(progress.submitted, 0);
  assert.ok(progress.missing.length > 0, '没打分就该在 missing 里');
  teardown(s);
});

test('评审工作台：myScores **只含本人的分**（别人的分不进评审页）', async () => {
  const s = setup();
  // 评委乙先给一队打分
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge2,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 77 }] },
  });
  const judgeRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(judgeRes.json.myScores.length, 0, '评委甲看不到评委乙的分');

  // 评委乙自己看得到自己给的分（改分要回填）
  const selfRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge2 });
  assert.equal(selfRes.json.myScores.length, 1);
  assert.equal(selfRes.json.myScores[0].rawScore, 77);
  assert.equal(selfRes.json.myScores[0].teamId, s.team1.id);
  teardown(s);
});

test('评审工作台：进度必须标明**口径**（mine / stage）', async () => {
  const s = setup();
  // ⚠️ 组委会与评委拿到的 progress 是**两套口径**（全赛段 vs 只看自己）——
  //    同一组 {submitted,total,missing} 不带口径 ⇒ 前端标签必然有一半是错的。
  const judgeRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(judgeRes.json.progress.scope, 'mine', '评委看到的进度是「我自己」的口径');

  const adminRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenAdmin });
  assert.equal(adminRes.json.progress.scope, 'stage', '组委会看到的进度是「全赛段」的口径');
  teardown(s);
});

test('评审工作台：stage 摘要带赛段名与权重表键（前端要显示赛段名）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(res.json.stage.id, s.stage.id);
  assert.equal(res.json.stage.name, '初赛');
  assert.equal(res.json.stage.scoringConfigKey, 'initial');
  teardown(s);
});
```

## 8. 本轮决策记录（DP）

| # | 决策 | 内容 |
|---|---|---|
| DP-94 | ⛔ **只补一个读口，不拆成三个** | 「名册 / 维度 / 我的分」分散在三处 ⇒ 前端要么拼三个请求、要么猜口径。⇒ 一个 `review-board` 端点一次拿齐，**形状逐字段对齐**并进 parity 闸。 |
| DP-95 | 🎚 **评审用 0–100 数字输入，不用 1–5 单选** | 后端口径是百分制（`assertScoreInRange`）；1–5 会丢分辨率。报名页的 1–5 是**问卷量表**，两者口径不同，**不共用控件**。仍然不用 `<select>`（DP-82）。 |
| DP-96 | ⛔ **发榜必须二次确认** | `POST /compute` 会**清场重算并写 stage_results** ⇒ 影响奖金、不可静默。⇒ 确认文案要写明**赛段 + 影响面**。 |
| DP-97 | 🛡 **前端不按角色拦这两页** | 沿用 DP-77：守卫只判登录态。评委能不能打分、组委会能不能发榜 ⇒ **API 裁决**（403 → 错误态说清缺哪个能力点）。 |
| DP-98 | 🧪 **「我的分」只返回本人的** | 改分要回填本人已给的分；别人的分不进评审页（避免绕过可见性层）。 |
| DP-99 | ⛔ **同一组数字可能有两套口径，必须让 API 标明** | `getReviewState` 对**组委会**返回全赛段口径（已交 N 格 / 缺了谁的哪一格），对**评委**返回「我自己」口径（我还差几格）—— 两者字段名完全一样（`{submitted,total,missing}`）⇒ 前端拿到同一组数字却不知道是哪套口径 ⇒ **标签必然有一半是错的**（P7 的 B1「数字与标签对不上」的同款事故）。⇒ 进度必须带 `scope: 'mine' \| 'stage'`，前端标签跟着它走；并用后端断言钉死（评委 = `mine`、组委会 = `stage`）。<br>⚠️ 变异检验实测：这一条最初**没被钉住** ⇒ 变异体「去掉 scope」存活 ⇒ 补了后端断言才杀掉。 |

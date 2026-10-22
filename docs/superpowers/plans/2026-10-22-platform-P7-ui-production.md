# P7 —— 现有页面打磨到生产级（视觉 / 交互 / 信息密度）

> **阶段**：P7（前端生产级打磨）
> **前置**：P0–P6 已完成（54 个 Task 全部落地，需求落地表 108/108）
> **依据**：`docs/three-port-alignment.md`（三端拆分 · 目标对齐与差距分析）
> **代码基线**：`cd platform && node --disable-warning=ExperimentalWarning --test`（cwd 发现，无参）

---

## 0. 本阶段要解决什么

上一阶段的结论是「**目标没偏、开发也没走偏 —— 是前端从未按角色分区做过界面**」：

| 事实 | 数字 | 来源 |
|---|---|---|
| 后端端点 | **57** | 9 个路由文件 + `server.js` 直接注册 |
| 前端路由 / 视图 | **13 / 11** | `web/app.js` / `web/views/*.js` |
| 前端实际消费的端点 | **11** | ⇒ **46 个端点（81%）没有任何界面入口** |
| 首页导航 | **6 个平铺链接** | ⇒ **所有人看到的一模一样** |
| `web/styles.css` | **36 行 / 8 个颜色变量** | ⇒ 无 token 体系、无响应式、无表格样式、无状态样式 |

根因：P0–P6 六阶段的验收标准**全部锁在后端行为**（108 条验收全是后端测试）⇒ 后端被严验收、前端从没被验收过 ⇒ 前端停在「能跑通 Demo」的规模。

本阶段的分工（用户已选）：

- **P7（本阶段）**：把**现有 11 个页面**打磨到生产级 —— 视觉 / 交互 / 信息密度。
- **P8（下一阶段）**：补「评审打分页」+「赛段计算发榜页」⇒ 赛事能跑起来的最小闭环。

---

## 1. 设计系统（`web/styles.css`）

三层结构，**换主题只换变量，不改任何组件规则**：

### ① 设计 token

| 组 | 内容 |
|---|---|
| 颜色 | `--bg` `--bg-subtle` `--surface` `--surface-raised` `--surface-sunken` `--overlay` / `--fg` `--fg-strong` `--fg-muted` `--fg-subtle` / `--border` `--border-strong` / `--brand` `--brand-strong` `--brand-soft` `--on-brand` / `--success` `--warn` `--danger` `--info`（各带 `-soft` 变体） |
| 间距 | `--sp-1`(4) … `--sp-12`(48)，**4px 基数** |
| 圆角 | `--r-sm`(6) `--r-md`(10) `--r-lg`(14) `--r-xl`(20) `--r-full` |
| 字号 | `--fs-xs`(12) … `--fs-3xl`(32)，行高 1.65 |
| 阴影 | `--sh-1` `--sh-2` `--sh-3` |
| 层级 | `--z-sticky`(100) `--z-topbar`(200) `--z-toast`(1000) |
| 布局 | `--maxw`(1240) `--topbar-h`(60) |
| 字体 | `--font`（中文栈）`--mono` |

**主题**：暗色为默认（品牌基调）；`[data-theme="light"]` 与 `prefers-color-scheme: light`（且未显式指定 `dark`）切到亮色 ⇒ 同一套组件规则两套皮肤。

### ② 组件层

`.topbar` `.nav-group` `.nav-link` `.user-chip` ｜ `.card` `.panel` ｜ `.page__head` `.page__title` ｜ `.grid--2/3/4` `.stat-row` `.stat` ｜ `.table` `.table-wrap` `.td-num` ｜ `.rank-badge` ｜ `.badge--*` ｜ `.btn--primary/ghost/danger/sm/block` ｜ `.field` `.input` `.select` `.textarea` `.radio-group` ｜ `.notice--*` ｜ `.tabs` `.tab` ｜ `.bar` `.kv` ｜ `.milestones` `.list-divided` ｜ `.toast` ｜ `.skeleton` `.spinner`

### ③ 状态层

`.state--loading` / `.state--empty` / `.state--error`（三件套）＋ `.skeleton` 骨架屏 ＋ `.spinner` ＋ `.empty` 提示 ＋ 响应式断点（900px / 560px）＋ `:focus-visible` 焦点环 ＋ `.sr-only` ＋ `@media print`。

---

## 2. 外壳三件套（`web/ui.js`，新建）

**为什么必须是纯函数**：写成 innerHTML 模板字符串就没法断言「错误态必须带重试按钮」「空态必须有引导动作」——只能靠肉眼。抽成纯函数后，`platform/test/web-ui.test.js` 能对**渲染结果本身**做行为断言。

| 原语 | 契约 |
|---|---|
| `loadingState({rows,label})` | `role="status" aria-live="polite"` + 骨架屏；行数收敛到 1–8 |
| `emptyState({title,hint,action})` | 标题 + 解释 + 可选动作按钮（**空 ≠ 没话说**：必须说清下一步） |
| `errorState({message,retry,hint})` | `role="alert"` + **`data-action="retry"` 重试按钮（必须有）** |
| `noticeState({tone,title,items,list})` | tone ∈ info/warn/danger/success/brand/neutral |
| `badge(text,tone)` `statCard` `statRow` `kvList` `rankBadge` `barRow` | 小组件；外部值一律 `escapeHtml` |
| `pageHead` `panel` `tabs` `tableWrap` `emptyRow` `sectionTitle` | 结构片段 |
| `tone(value)` | **不在白名单 ⇒ 降级 neutral**（fail-closed，不拼 class） |

---

## 3. 导航分区（`web/nav.js`，新建）

### 分区模型

| 分区 | 可见条件 | 入口 |
|---|---|---|
| 赛事 | 所有人 | 总览 `/`、榜单 `/leaderboard`、段位榜 `/tier` |
| 我的赛事 | 需登录 | 报名 `/apply`、我的战队 `/team`、任务清单 `/tasks` |
| 组委会 | 角色含 `admin`（超管直通） | 报名筛选台 `/admin/registration`、复核队列 `/flags` |

「评审台」分区**故意留空**：评审打分页属于 P8，现在放空分区等于放死入口 ⇒ 等页面真的存在时再加这一条**数据**（分区是声明式数据，加页面不改渲染逻辑）。

### ⛔⛔ 设计红线：前端**不按角色拦路由**

- 能力点可以**直接授权给个人**（`assignments` 表 / resource-level 授权），根本不经角色。
- ⇒ 前端手里只有角色、没有能力 ⇒ **按角色拦路由 = 误伤有权限的人**。
- ⇒ 路由守卫**只判登录态**；授权的唯一裁决者是 API（`can()` + `scopeClause`）。
- 角色分区只用于**导航入口的呈现**（谁看到哪些菜单），它不阻断任何页面的可达性。

守卫的收益：未登录点「报名」不再渲染出一个必然 401 的表单，而是「需要登录」引导页。

---

## 4. 应用外壳（`web/app.js`，P0 owns，本轮 Modify）

- 顶栏（`#topbar`）与内容容器（`#app`）**拆成两个独立元素** ⇒ 切页不必重建页面骨架。
- **顶栏先渲染**，内容后渲染 ⇒ 视图渲染失败时页面不至于白屏，且 catch 分支写入的内容不会被顶栏覆盖（写入顺序 = 视觉顺序）。
- `#app` 的**首个子节点必须仍是视图本身**（`test/workflow-e2e.test.js` 按 `children[0].innerHTML` 断言）。
- 总览页 `/` 重做：页头 + 指标行 + 分区入口卡 + 滚动总榜前五；**问候语同步渲染**（不依赖任何请求），数据异步补。
- 主题切换：`localStorage` 持久化（存取全部包 try —— 隐私模式下会抛）。
- 新增路由 `/tasks`（工作流索引页）⇒ 任务清单页**第一次有了可达路径**（此前 `/tasks/:workflowId` 无处可点）。

---

## 5. 后端最小扩展（**只读 / 纯追加**）

| 端点 | 理由 |
|---|---|
| `GET /api/me` 与登录响应**带 `roles`** | 前端要按角色分区导航，必须知道「你是谁」。⚠️ `roles` 是**角色键列表**，**不构成任何授权依据**（可见性始终在 API 层过滤）⇒ 不属于泄露 |
| `GET /api/stages` | 仓储层早有 `listStages`，只是**没有端点** ⇒ 榜单页没有赛段可选（生产上走不通） |
| `GET /api/workflows` | 同上：任务清单页没有入口 |

仓储层新增三个**纯只读**函数：`listUserRoles` / `listStageSummaries` / `listWorkflowSummaries`（后者 LEFT JOIN 出任务计数，让入口页在点进去**之前**就能判断要不要点）。

---

## 6. 演示适配器（`web/api.demo.js`，P6 owns，本轮 Modify）

⚠️ 演示适配器此前**完全没有**工作流/任务端点 ⇒ 任务清单页在公网演示站是 **404**，导航里放这个入口就是放死链。

⇒ 补：`GET /api/stages` / `GET /api/workflows` / `GET /api/workflows/:id/tasks` / `POST /api/tasks/:id/{claim,complete,release}`；演示用户补 `roles: ['admin']`（老 localStorage 里的 `me` 缺角色时自动补）。

---

## 7. 视图改造（11 个现有页面）

| 组 | 文件 | owning 阶段 |
|---|---|---|
| A | `web/views/registration.js` `team.js` `admin-registration.js` | P1 |
| B | `web/views/leaderboard.js` `tier.js` `card.js` | P3 |
| C | `web/views/audit.js` `flags.js` `tasks.js` | P4 / P5 |

改造口径（三组一致）：

1. **外壳三件套**齐全（加载 / 空 / 错误），错误必须带重试且真的绑定重试。
2. 页头统一 `pageHead`；层次 = 页头 → 指标 → 内容。
3. 关键数字提成 `statCard` / `statRow`；表格化（`tableWrap` + `<th>` + 数字右对齐）；元信息用 `kvList` / `.small`。
4. 表单统一 `.field` 体系 + **本地校验前置**（不发无谓请求）+ 明确反馈。
5. **前端不做可见性过滤**：API 返回什么渲染什么，一个都不丢（全局约束）。
6. 转义只走 `../escape.js`（全站唯一入口）。
7. 保持既有纯函数导出的**签名与返回形状**不变（既有测试直接断言它们）。

---

## 8. 验收标准

| 项 | 判据 |
|---|---|
| 全量测试 | `cd platform && node --disable-warning=ExperimentalWarning --test` ⇒ **0 失败** |
| 机器闸 | `audit-scan` / `temp-leak-scan` / `bash-var-scan` 退出码均 **0** |
| 漂移审计 | `node docs/tools/plan-block-audit.mjs platform --selftest` ⇒ **C-RW = 0、D = 0** |
| 计划块核验 | `plan-block-sync.mjs --verify` 对本阶段触及的每个计划 ⇒ **逐字一致** |
| 新增用例 | `platform/test/web-ui.test.js`（外壳三件套 + 导航分区 + 守卫红线 + 端到端反向对照） |
| 变异检验 | 对本阶段新判据做变异，**存活变异必须修或显式标注等价** |
| 公网 | 平台 8444 与演示站 8445 均 200；演示站任务清单页**不再 404** |

---

## 9. 新建文件

> ⛔ 计划块必须与最终实现**逐字一致**（`plan-block-sync.mjs --verify` 核验）。

### `platform/web/ui.js`

```javascript
// web/ui.js — 共享 UI 原语（外壳三件套 + 组件片段）
// 依据：本轮（P7）「现有页面打磨到生产级」——11 个视图此前各自手写
//   「正在加载…」「暂无数据」「<div class="card err">」三种壳，
//   结果同一个平台的 11 个页面长得不一样（三个视图各写一份空态文案、
//   两个视图的错误态一个带重试一个不带）。
//
// ⚠️ **为什么必须是纯函数**：
//   这些片段一旦写成 innerHTML 模板字符串，就没法直接断言「错误态必须带重试按钮」
//   「空态必须有引导动作」——只能靠肉眼。抽成纯函数后，
//   platform/test/web-ui.test.js 能对**渲染结果本身**做行为断言，
//   而不只是在测某个辅助函数。
//
// ⛔ 纯函数、零依赖、零 IO：只 import web/escape.js（P0 建立的全站唯一转义入口）。
import { escapeHtml } from './escape.js';

/** 语义色调白名单 —— 徽章/提示条只允许这些值，避免拼出无法识别的 class。 */
export const TONES = ['neutral', 'brand', 'success', 'warn', 'danger', 'info'];

/**
 * 色调归一：不在白名单里的值一律降级成 neutral。
 * ⛔ 不能直接把外部值拼进 class —— 那既是 CSS 注入面，也会让样式静默失效。
 */
export function tone(value) {
  return TONES.includes(value) ? value : 'neutral';
}

// ── 外壳三件套（加载 / 空 / 错）────────────────────────────────────────

/**
 * 加载态：骨架屏 + 状态文字。
 * ⚠️ 用 `role="status" aria-live="polite"` 而不是纯视觉占位 ——
 *    屏幕阅读器用户切到该页时必须知道「正在加载」，否则得到的是一片空白。
 */
export function loadingState({ rows = 3, label = '正在加载…' } = {}) {
  const n = Math.max(1, Math.min(8, Number(rows) || 3));
  const bars = '<div class="skeleton__line"></div>'.repeat(n);
  return `<div class="state state--loading" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <p class="state__title">${escapeHtml(label)}</p>
    <div class="skeleton" aria-hidden="true">${bars}</div>
  </div>`;
}

/**
 * 空态：标题 + 解释 + 可选的下一步动作。
 * ⚠️ 「空」不等于「没有话说」——生产级空态必须告诉访客**下一步做什么**，
 *    否则用户只看到一个灰盒子（这是打磨前 11 个页面的真实状态）。
 */
export function emptyState({ title = '暂无数据', hint = '', action = null } = {}) {
  const actionHtml = action && action.label
    ? `<a class="btn btn--primary btn--sm" href="${escapeHtml(action.href ?? '#')}">${escapeHtml(action.label)}</a>`
    : '';
  return `<div class="state state--empty">
    <div class="state__icon" aria-hidden="true">◍</div>
    <p class="state__title">${escapeHtml(title)}</p>
    ${hint ? `<p class="state__hint">${escapeHtml(hint)}</p>` : ''}
    ${actionHtml}
  </div>`;
}

/**
 * 错误态：消息 + 重试按钮。
 * ⚠️ 重试按钮是**必须有**的：生产级错误态不能是死路一条。
 *   按钮挂 `data-action="retry"`，由视图侧绑定具体重跑逻辑。
 */
export function errorState({ message = '加载失败', retry = true, hint = '' } = {}) {
  const retryHtml = retry
    ? '<button type="button" class="btn btn--ghost btn--sm" data-action="retry">重试</button>'
    : '';
  return `<div class="state state--error" role="alert">
    <div class="state__icon" aria-hidden="true">⚠</div>
    <p class="state__title">${escapeHtml(message)}</p>
    ${hint ? `<p class="state__hint">${escapeHtml(hint)}</p>` : ''}
    ${retryHtml}
  </div>`;
}

// ── 提示条 ─────────────────────────────────────────────────────────────

/**
 * 提示条（降级告警 / 成功 / 危险）。
 * ⚠️ 降级告警**必须置顶且不可折叠**（S-5 / C-05）：
 *    「本轮该维度未做评委宽严归一化」如果藏在页面底部，等于没提示。
 */
export function noticeState({ tone: t = 'info', title = '', items = [], list = false } = {}) {
  const toneName = tone(t);
  const body = list
    ? `<ul class="notice__list">${(items ?? []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : (items ?? []).map((x) => `<p class="notice__text">${escapeHtml(x)}</p>`).join('');
  const titleHtml = title ? `<p class="notice__title">${escapeHtml(title)}</p>` : '';
  return `<div class="notice notice--${toneName}" role="alert">${titleHtml}${body}</div>`;
}

// ── 小组件 ─────────────────────────────────────────────────────────────

/**
 * 徽章：状态 / 段位 / 角色标签。
 * ⚠️ `extraClass` 是**受控扩展位**（父代理实测反馈：卡片页的「已签」需要右推，
 *    但徽章本身不该被塞进布局类）⇒ 只允许追加额外 class，色调仍走白名单。
 */
export function badge(text, toneName = 'neutral', extraClass = '') {
  const extra = extraClass ? ` ${String(extraClass).replace(/[^\w-]/g, '')}` : '';
  return `<span class="badge badge--${tone(toneName)}${extra}">${escapeHtml(text)}</span>`;
}

/**
 * 指标卡：一个数字 + 一个标签（+ 可选说明）。
 * 信息密度的基本单位：把「报名 128 人 / 队伍 32 支」从正文里提出来放到指标行。
 */
export function statCard({ label = '', value = '—', hint = '', tone: t = 'neutral' } = {}) {
  const hintHtml = hint ? `<p class="stat__hint">${escapeHtml(hint)}</p>` : '';
  return `<div class="stat stat--${tone(t)}">
    <p class="stat__value">${escapeHtml(value)}</p>
    <p class="stat__label">${escapeHtml(label)}</p>
    ${hintHtml}
  </div>`;
}

/** 指标行：把若干指标卡排成一行（窄屏自动换行）。 */
export function statRow(items = []) {
  return `<div class="stat-row">${items.map((x) => statCard(x)).join('')}</div>`;
}

/** 键值表：把「字段: 值」排成两列，信息密度高又不挤。 */
export function kvList(pairs = []) {
  const rows = (pairs ?? [])
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div class="kv__row"><dt class="kv__key">${escapeHtml(k)}</dt><dd class="kv__val">${escapeHtml(v)}</dd></div>`)
    .join('');
  return rows ? `<dl class="kv">${rows}</dl>` : '';
}

/**
 * 名次徽章：前三名给金银铜色，其余用中性色。
 * ⚠️ 名次是**数字**，但仍走 escapeHtml —— 入口是字符串拼接，统一入口比逐处判断可靠。
 */
export function rankBadge(rank) {
  const n = Number(rank);
  const kind = n === 1 ? 'gold' : n === 2 ? 'silver' : n === 3 ? 'bronze' : 'plain';
  return `<span class="rank-badge rank-badge--${kind}">${escapeHtml(rank ?? '—')}</span>`;
}

/** 条形：漏斗 / 分布 / 达成率。max 缺省按本组最大值算。 */
export function barRow({ label = '', value = 0, max = null, note = '', tone: t = 'brand' } = {}) {
  const v = Number(value) || 0;
  const m = max === null || max === undefined || Number(max) <= 0 ? Math.max(v, 1) : Number(max);
  const pct = Math.max(0, Math.min(100, Math.round((v / m) * 100)));
  const noteHtml = note ? `<span class="bar__note">${escapeHtml(note)}</span>` : '';
  return `<div class="bar">
    <span class="bar__label">${escapeHtml(label)}</span>
    <span class="bar__track"><span class="bar__fill bar__fill--${tone(t)}" style="width:${pct}%"></span></span>
    <span class="bar__value">${escapeHtml(value)}${noteHtml}</span>
  </div>`;
}

/** 页头：标题 + 副标题 + 右侧动作区。 */
export function pageHead({ title = '', sub = '', actions = [] } = {}) {
  const actionHtml = (actions ?? []).length
    ? `<div class="page__actions">${actions.map((a) => (a.href
      ? `<a class="btn btn--ghost btn--sm" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`
      : `<span class="btn btn--ghost btn--sm is-static">${escapeHtml(a.label)}</span>`)).join('')}</div>`
    : '';
  const subHtml = sub ? `<p class="page__sub">${escapeHtml(sub)}</p>` : '';
  return `<header class="page__head">
    <div class="page__titles"><h1 class="page__title">${escapeHtml(title)}</h1>${subHtml}</div>
    ${actionHtml}
  </header>`;
}

/** 面板：一块带标题的内容区（替代裸 .card）。 */
export function panel({ title = '', desc = '', body = '', tone: t = 'neutral' } = {}) {
  const head = title
    ? `<div class="panel__head"><h2 class="panel__title">${escapeHtml(title)}</h2>${desc ? `<p class="panel__desc">${escapeHtml(desc)}</p>` : ''}</div>`
    : '';
  return `<section class="panel panel--${tone(t)}">${head}<div class="panel__body">${body}</div></section>`;
}

/**
 * 标签页（纯展示，靠 URL 切换，不做前端状态机）。
 * ⚠️ 刻意**不用** JS 切页：标签页切换会把 URL 与视图状态拆开 ⇒ 刷新即丢失。
 */
export function tabs({ items = [], active = '' } = {}) {
  const links = items.map((it) => {
    const on = it.id === active;
    return `<a class="tab${on ? ' is-active' : ''}" href="${escapeHtml(it.href ?? '#')}"${on ? ' aria-current="page"' : ''}>${escapeHtml(it.label)}</a>`;
  }).join('');
  return `<nav class="tabs" aria-label="视图切换">${links}</nav>`;
}

/**
 * 表格外层：窄屏横向滚动 + 滚动阴影。
 * ⚠️ `className` 是**受控扩展位**（父代理实测反馈）：紧凑密度 `.table--compact`
 *    走 tableWrap 时拿不到 —— 密度是**表格**的属性，不该由每个视图各写一遍外层。
 */
export function tableWrap(html, { caption = '', className = 'table' } = {}) {
  const cap = caption ? `<caption class="sr-only">${escapeHtml(caption)}</caption>` : '';
  const cls = `table ${String(className).replace(/[^\w -]/g, '')}`.trim();
  return `<div class="table-wrap"><table class="${cls}">${cap}${html}</table></div>`;
}

/** 表格空行：跨列的空态（比空表格更清楚）。 */
export function emptyRow(colspan = 1, text = '暂无数据') {
  return `<tr class="table__empty"><td colspan="${Math.max(1, Number(colspan) || 1)}"><p class="muted">${escapeHtml(text)}</p></td></tr>`;
}

/**
 * 轻提示（Toast）：操作结果的即时反馈。
 * ⚠️ 生产级不能「点了没反应」—— 提交成功/失败都要有可见反馈。
 */
export function toast(message, toneName = 'success') {
  return `<div class="toast toast--${tone(toneName)}" role="status">${escapeHtml(message)}</div>`;
}

/** 定义列表式的分节标题（小标题）。 */
export function sectionTitle(text, extra = '') {
  return `<div class="section-title"><h2>${escapeHtml(text)}</h2>${extra}</div>`;
}
```

### `platform/web/nav.js`

```javascript
// web/nav.js — 导航分区模型（按角色分区 · 前端侧）
// 依据：docs/three-port-alignment.md（三端拆分：用户端 / 管理员端 / 组委会端）
//
// ⚠️ **本文件是「导航分区」的唯一来源**：
//   打磨前的首页是 6 个平铺链接（首页/登录/榜单/复核队列/报名/我的战队/筛选台），
//   **所有人看到的一模一样** —— 组委会看到「报名」，选手也看到「报名」。
//   这不是审美问题，是三端拆分在界面上**完全没落地**。
//   ⇒ 现在导航按角色分区，且分区规则是**声明式数据**（加页面 = 加一条数据，不改渲染逻辑）。
//
// ⛔ **可见性仍然在 API 层过滤**（全局约束）：
//   这里的「按角色分区」只是**导航入口**的分区，不是数据可见性的裁决。
//   任何页面拿到的数据仍然由 API 层按 capability + assignment 过滤 ——
//   前端隐藏一个入口 ≠ 用户就看不到数据（后端仍然拦得住）。
import { escapeHtml } from './escape.js';

/**
 * 角色元数据。
 * ⚠️ 键取自 roles 表的 role_key（与 user_roles.role_key 同键值域），
 *    实测口径见「角色→能力实测（真机）」：admin / captain / member / judge /
 *    enterprise / observer / enterprise_admin 共 7 个角色。
 */
export const ROLE_META = {
  admin: { label: '组委会', group: 'committee' },
  judge: { label: '评委席', group: 'review' },
  enterprise: { label: '企业席', group: 'review' },
  enterprise_admin: { label: '企业命题', group: 'review' },
  captain: { label: '队长', group: 'player' },
  member: { label: '组员', group: 'player' },
  observer: { label: '观察员', group: 'observer' },
};

/** 游客（未登录）。 */
export const GUEST = { label: '访客', group: 'guest' };

/**
 * 导航分区。
 *
 * ⚠️ 字段说明：
 *   - `auth: true` ⇒ 需要登录才出现；
 *   - `roles: [...]` ⇒ 需要命中其中任一角色；
 *   - `exact: true` ⇒ 只有路径完全相等才算「当前页」（否则 '/tasks' 会把 '/tasks/x' 也点亮）。
 *
 * ⛔ 「评审台」分区**故意留空**：评审打分页属于下一轮（补端点），
 *   现在放一个空分区等于放一个死入口 —— 等页面真的存在时再加这一条数据。
 */
export const NAV_SECTIONS = [
  {
    id: 'public',
    label: '赛事',
    items: [
      { path: '/', label: '总览', exact: true },
      { path: '/leaderboard', label: '榜单' },
      { path: '/tier', label: '段位榜' },
    ],
  },
  {
    id: 'player',
    label: '我的赛事',
    auth: true,
    items: [
      { path: '/apply', label: '报名' },
      { path: '/team', label: '我的战队' },
      { path: '/tasks', label: '任务清单' },
    ],
  },
  {
    id: 'committee',
    label: '组委会',
    auth: true,
    roles: ['admin'],
    items: [
      { path: '/admin/registration', label: '报名筛选台' },
      { path: '/flags', label: '复核队列' },
    ],
  },
];

/**
 * 受保护路由（路由守卫）。
 * ⚠️ 守卫的作用是**别把访客丢进一个必然 401 的页面**：
 *   打磨前，未登录点「报名」→ 页面骨架渲染出来 → 异步请求 401 →
 *   错误文案「未登录」出现在表单下方，像表单坏了。
 *   现在未登录直接看到「需要登录」引导页。
 *
 * ⛔⛔ **守卫只判「是否登录」，绝不按角色拦路**（这条是设计红线）：
 *   前端手里的角色**不等于**服务端的授权结果 —— 能力点可以**直接授权给个人**
 *   （assignments 表 / resource-level 授权），根本不经角色。
 *   ⇒ 如果前端按角色拦路由，一个「有 audit:read 但没有 admin 角色」的人
 *      会被前端挡在门外，而 API 其实放行 —— **误伤有权限的人**。
 *   ⇒ 授权的唯一裁决者是 API（can() + scopeClause）。
 *   角色分区只用于**导航入口的呈现**（谁看到哪些菜单），
 *   它不阻断任何页面的可达性 —— 真正的拦截交给服务端。
 */
export const PROTECTED_ROUTES = [
  { pattern: /^\/apply\/?$/, auth: true },
  { pattern: /^\/team\/?$/, auth: true },
  { pattern: /^\/tasks(\/|$)/, auth: true },
  { pattern: /^\/admin(\/|$)/, auth: true },
  { pattern: /^\/flags\/?$/, auth: true },
  { pattern: /^\/audit(\/|$)/, auth: true },
];

/** 取用户身上的角色键数组（宽容处理各种形状）。 */
export function userRoles(user) {
  if (!user) return [];
  const raw = user.roles ?? user.roleKeys ?? [];
  if (Array.isArray(raw)) return raw.filter((r) => typeof r === 'string' && r);
  if (typeof raw === 'string') return raw ? [raw] : [];
  return [];
}

/** 主身份标签：取第一个已知角色；超管直通组委会。 */
export function roleLabel(user) {
  if (!user) return GUEST.label;
  if (user.isSuperadmin === true || user.is_superadmin === 1) return '组委会 · 超管';
  const roles = userRoles(user);
  for (const r of roles) {
    if (ROLE_META[r]) return ROLE_META[r].label;
  }
  return GUEST.label;
}

/** 当前路径是否落在某条受保护规则上。 */
export function guardFor(path) {
  const clean = String(path || '/').split('?')[0];
  return PROTECTED_ROUTES.find((r) => r.pattern.test(clean)) ?? null;
}

/**
 * 当前用户能否访问某条路径。
 * ⚠️ **只判登录态**（理由见 PROTECTED_ROUTES 上方的设计红线）：
 *   角色/能力一律由 API 裁决 —— 前端按角色拦路会误伤「被直接授权」的人。
 *   fail-closed：没登录 ⇒ 不放行。
 */
export function canAccess(path, user) {
  const guard = guardFor(path);
  if (!guard) return true;
  if (guard.auth && !user) return false;
  return true;
}

/** 导航项是否是「当前页」。 */
export function isActive(path, item) {
  const clean = String(path || '/').split('?')[0];
  if (item.exact) return clean === item.path;
  return clean === item.path || clean.startsWith(`${item.path}/`);
}

/**
 * 按当前用户裁剪导航分区（纯函数）。
 * - 未登录 ⇒ 只留公开分区；
 * - 有角色 ⇒ 保留 roles 命中的分区。
 */
export function visibleSections(user) {
  const roles = userRoles(user);
  const isSuper = user?.isSuperadmin === true || user?.is_superadmin === 1;
  return NAV_SECTIONS
    .filter((sec) => {
      if (sec.auth && !user) return false;
      if (sec.roles?.length && !isSuper && !roles.some((r) => sec.roles.includes(r))) return false;
      return true;
    })
    .map((sec) => ({ ...sec, items: sec.items.filter((it) => canAccess(it.path, user)) }));
}

/**
 * 顶栏 HTML。
 * @param {object|null} user 当前用户
 * @param {string} path 当前路径（用于点亮当前项）
 */
export function navHtml(user, path = '/') {
  const sections = visibleSections(user);
  const groups = sections.map((sec) => {
    const links = sec.items.map((it) => {
      const on = isActive(path, it);
      return `<a class="nav-link${on ? ' is-active' : ''}" href="#${escapeHtml(it.path)}"${on ? ' aria-current="page"' : ''}>${escapeHtml(it.label)}</a>`;
    }).join('');
    if (!links) return '';
    return `<div class="nav-group"><span class="nav-group__label">${escapeHtml(sec.label)}</span><div class="nav-group__links">${links}</div></div>`;
  }).join('');

  const userBox = `<div class="topbar__user">
    ${user ? `<span class="user-chip">
          <span class="user-chip__avatar" aria-hidden="true">${escapeHtml((user.name || '?').slice(0, 1))}</span>
          <span class="user-chip__meta">
            <span class="user-chip__name">${escapeHtml(user.name || '')}</span>
            <span class="user-chip__role">${escapeHtml(roleLabel(user))}</span>
          </span>
        </span>` : ''}
    <button type="button" class="btn btn--ghost btn--sm" data-action="theme" aria-label="切换亮色 / 暗色主题">◐</button>
    ${user
      ? '<a class="btn btn--ghost btn--sm" href="#/logout">退出</a>'
      : '<a class="btn btn--primary btn--sm" href="#/login">登录</a>'}
  </div>`;

  return `<div class="topbar__inner">
    <a class="topbar__brand" href="#/">
      <span class="topbar__logo" aria-hidden="true">⬢</span>
      <span class="topbar__names">
        <strong class="topbar__title">华东区 AI 商业黑客松</strong>
        <span class="topbar__sub">赛事平台</span>
      </span>
    </a>
    <nav class="topbar__nav" aria-label="主导航">${groups}</nav>
    ${userBox}
  </div>`;
}
```

### `platform/web/views/task-index.js`

```javascript
// web/views/task-index.js — 任务清单入口页（工作流索引）
// 依据：本轮（P7）「现有页面打磨到生产级」
//
// ⚠️ **为什么需要这个页面**：
//   任务清单页的路由是 `/tasks/:workflowId` —— 带参数。
//   打磨前**没有任何页面能给出这个 workflowId**：
//   前端 13 条路由里没有工作流列表，导航里也只有一条死链 ⇒
//   「任务清单」在真实产品上**根本点不进去**（不是难用，是不可达）。
//   ⇒ 这里补一个索引页：列出本届的工作流 + 每个工作流的任务进度，
//      点进去才是真正的任务清单（/tasks/:workflowId）。
//
// ⛔ **前端不做可见性过滤**（全局约束）：
//   工作流列表由 API 层按 capability 过滤后返回，这里**原样呈现**。
import { escapeHtml } from '../escape.js';
import { emptyState, errorState, loadingState, pageHead } from '../ui.js';

/**
 * 工作流 → 卡片模型（纯函数，可单测）。
 * @param {Array} workflows API 返回的工作流
 */
export function buildWorkflowCards(workflows) {
  return (workflows ?? []).map((w) => {
    const total = Number(w.taskCount ?? 0);
    const done = Number(w.doneCount ?? 0);
    const open = Math.max(0, total - done);
    return {
      id: w.id ?? '',
      name: w.name ?? '',
      taskPackageId: w.taskPackageId ?? '',
      total,
      done,
      open,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  });
}

/**
 * 卡片 HTML（纯函数，不碰 document）。
 * ⚠️ 工作流名称来自服务端（可能来自用户输入）⇒ 必须转义。
 */
export function workflowCardsHtml(cards) {
  return cards.map((c) => `
    <article class="card home__entry">
      <h3>${escapeHtml(c.name)}</h3>
      <p class="muted small">共 ${c.total} 个任务 · 已完成 ${c.done} · 待办 ${c.open}</p>
      <div class="bar" role="img" aria-label="完成进度 ${c.percent}%">
        <span class="bar__track"><span class="bar__fill bar__fill--success" style="width:${c.percent}%"></span></span>
        <span class="bar__value">${c.percent}%</span>
      </div>
      <div class="btn-group">
        <a class="btn btn--primary btn--sm" href="#/tasks/${escapeHtml(c.id)}">进入任务清单</a>
      </div>
    </article>`).join('');
}

export function renderTaskIndex(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'task-index';
  wrap.innerHTML = `
    ${pageHead({
      title: '任务清单',
      sub: '任务只能自主领取 —— 严禁按岗位和身份分工（R-OPS-14）',
    })}
    <div id="ti-body">${loadingState({ rows: 2, label: '正在加载任务清单…' })}</div>`;

  const body = wrap.querySelector('#ti-body');

  (async () => {
    let data;
    try {
      data = await ctx.api.get('/api/workflows');
    } catch (e) {
      body.innerHTML = errorState({ message: e.message });
      return;
    }
    const cards = buildWorkflowCards(data?.items ?? []);
    body.innerHTML = cards.length
      ? `<div class="grid grid--3">${workflowCardsHtml(cards)}</div>`
      : emptyState({
        title: '还没有任务清单',
        hint: '任务清单由组委会在任务包发布后生成，届时会出现在这里。',
      });
  })().catch((e) => {
    body.innerHTML = errorState({ message: e.message });
  });

  return wrap;
}
```

### `platform/test/web-ui.test.js`

`platform/test/web-ui.test.js`：

```javascript
// platform/test/web-ui.test.js —— P7「现有页面打磨到生产级」的契约测试
//
// 规则溯源：
//   - 「导航按角色分区（三端拆分）」→ docs/three-port-alignment.md
//   - 「外壳三件套（加载/空/错）统一」→ 本轮设计系统落地
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束「可见性在 API 层过滤」
//
// ⚠️ 本文件的用例全部是**行为断言**，不是文本匹配：
//    「错误态必须带重试按钮」「未登录访问受保护页不得发请求」这类判据，
//    只能从**渲染结果**或**实际请求**里看出来。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadingState, emptyState, errorState, noticeState, badge,
  statCard, statRow, kvList, rankBadge, barRow,
  pageHead, panel, tabs, tableWrap, emptyRow, tone,
} from '../web/ui.js';

import {
  userRoles, roleLabel, canAccess, isActive, visibleSections, navHtml, guardFor,
  PROTECTED_ROUTES,
} from '../web/nav.js';

// ══════════════════════════════════════════════════════════════════
// 一、外壳三件套
// ══════════════════════════════════════════════════════════════════

test('加载态：带 aria-live（屏幕阅读器要知道在加载）+ 骨架屏', () => {
  const html = loadingState({ rows: 3, label: '正在加载报名问卷…' });
  assert.ok(html.includes('aria-live'), '加载态必须对辅助技术可见');
  assert.ok(html.includes('正在加载报名问卷…'), '要显示加载文案');
  assert.ok(html.includes('skeleton'), '要有骨架屏');
  assert.equal((html.match(/skeleton__line/g) || []).length, 3, '骨架行数要对');
});

test('加载态：行数非法时收敛到安全区间（不渲染 0 行也不渲染 999 行）', () => {
  assert.ok(loadingState({ rows: 0 }).includes('skeleton__line'), '0 行也要有骨架');
  const many = loadingState({ rows: 999 });
  assert.ok((many.match(/skeleton__line/g) || []).length <= 8, '骨架行数必须有上限');
});

test('空态：必须带「下一步做什么」（标题 + 提示 + 可选动作）', () => {
  const html = emptyState({ title: '还没有任务清单', hint: '组委会发布任务包后会出现。' });
  assert.ok(html.includes('还没有任务清单'));
  assert.ok(html.includes('组委会发布任务包后会出现'), '空态必须说清什么时候会有');
  const withAction = emptyState({ title: '暂无', action: { href: '#/apply', label: '去报名' } });
  assert.ok(withAction.includes('去报名') && withAction.includes('#/apply'), '动作要能点');
});

test('错误态：必须带重试按钮（错误不能是死路）', () => {
  const html = errorState({ message: '加载失败' });
  assert.ok(html.includes('加载失败'));
  assert.ok(html.includes('data-action="retry"'), '错误态必须有重试按钮');
  assert.ok(html.includes('role="alert"'), '错误态必须能被辅助技术播报');
});

test('错误态与空态：错误消息必须转义（服务端消息是外部输入）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = errorState({ message: evil });
  assert.ok(html.includes('&lt;img'), '错误消息必须转义');
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
});

test('提示条：色调不在白名单时降级成 neutral（不许拼出无法识别的 class）', () => {
  assert.equal(tone('brand'), 'brand');
  assert.equal(tone('evil" onclick="x'), 'neutral', '非法色调必须 fail-closed');
  assert.equal(tone(undefined), 'neutral');
  const html = noticeState({ tone: 'evil" onclick="x', title: 't' });
  assert.ok(html.includes('notice--neutral'), '必须降级');
  assert.ok(!html.includes('onclick'), '不得把外部值拼进 class');
});

test('提示条：降级告警可以一次给多条（items + list）', () => {
  const html = noticeState({ tone: 'warn', title: '本轮降级提示（2）', items: ['a', 'b'], list: true });
  assert.ok(html.includes('notice--warn'));
  assert.ok(html.includes('<li>a</li>') && html.includes('<li>b</li>'));
});

test('徽章 / 指标卡 / 键值表：外部值一律转义', () => {
  const evil = '<script>bad()</script>';
  const b = badge(evil, 'brand');
  assert.ok(b.includes('&lt;script&gt;') && !b.includes('<script'));
  const s = statCard({ label: evil, value: evil, hint: evil });
  assert.ok(!s.includes('<script'));
  const k = kvList([[evil, evil]]);
  assert.ok(!k.includes('<script'));
});

test('键值表：空值不渲染（不给「未填写:」这种噪音行）', () => {
  assert.equal(kvList([['a', ''], ['b', null], ['c', undefined]]), '');
  assert.ok(kvList([['a', 'x']]).includes('a'));
});

test('名次徽章：前三名金银铜，其余中性', () => {
  assert.ok(rankBadge(1).includes('rank-badge--gold'));
  assert.ok(rankBadge(2).includes('rank-badge--silver'));
  assert.ok(rankBadge(3).includes('rank-badge--bronze'));
  assert.ok(rankBadge(9).includes('rank-badge--plain'));
});

test('条形：百分比必须收敛到 0–100（max 为 0 或缺省时不炸）', () => {
  assert.ok(barRow({ label: 'a', value: 5, max: 10 }).includes('width:50%'));
  assert.ok(barRow({ label: 'a', value: 5, max: 0 }).includes('width:100%'));
  const over = barRow({ label: 'a', value: 50, max: 10 });
  assert.ok(over.includes('width:100%'), '超过 max 必须截到 100');
});

test('表格辅助：空行跨列正确；表格外层包了横向滚动', () => {
  const row = emptyRow(6, '暂无数据');
  assert.ok(row.includes('colspan="6"'));
  assert.ok(row.includes('暂无数据'));
  const wrapped = tableWrap('<tbody><tr><td>x</td></tr></tbody>');
  assert.ok(wrapped.includes('table-wrap'), '表格外层要给窄屏横向滚动');
});

test('徽章 / 表格外层的扩展位：可追加 class，但属性值必须被清洗到「不可能逃逸出属性」', () => {
  const b = badge('已签', 'success', 'signed');
  assert.ok(b.includes('badge--success') && b.includes('signed'), '扩展 class 要生效');
  // ⛔ 判据不是「字符串里没有 onclick」（剥掉引号后 onclick 只是无害的字面残留），
  //    而是「**class 属性不可能被逃逸**」—— 注入的扩展 class 必须仍是**单个合法 token**：
  //    不许带空白（否则能塞出第二个属性）、不许带引号/等号。
  const classAttr = (html) => /class="([^"]*)"/.exec(html)?.[1] ?? '';
  const tokens = (html) => classAttr(html).split(/\s+/).filter(Boolean);
  for (const evil of ['a" onclick="evil', "a' onclick='evil", 'a onclick=evil', 'a"onmouseover="x']) {
    const attr = classAttr(badge('x', 'neutral', evil));
    assert.ok(!attr.includes('"'), `class 属性里不许有双引号：${attr}`);
    assert.ok(!attr.includes("'"), `class 属性里不许有单引号：${attr}`);
    assert.ok(!attr.includes('='), `class 属性里不许有等号：${attr}`);
    for (const tk of tokens(badge('x', 'neutral', evil))) {
      assert.match(tk, /^[\w-]+$/, `class token 必须是合法类名（不许有空白/引号）：${tk}`);
    }
  }
  const t = tableWrap('<tbody></tbody>', { className: 'table--compact' });
  assert.ok(t.includes('table--compact'), '紧凑密度要能通过扩展位传进来');
  for (const evil of ['x" onmouseover="evil', 'x onmouseover=evil', 'x"onclick="y']) {
    for (const tk of tokens(tableWrap('<tbody></tbody>', { className: evil }))) {
      assert.match(tk, /^[\w-]+$/, `表格 class token 也要清洗：${tk}`);
    }
    // ⛔ **光看 class 属性值不够**：属性值被正则截到第一个引号为止，
    //    属性**逃逸**（`class="a" onclick="b"`）在那个视角下完全不可见。
    //    ⇒ 判据必须是「**整个标签里只有一个属性**」。
    const tag = /<table[^>]*>/.exec(tableWrap('<tbody></tbody>', { className: evil }))?.[0] ?? '';
    assert.equal((tag.match(/="/g) || []).length, 1, `table 标签里只允许一个属性（class），实际：${tag}`);
  }
  const spanTag = /<span[^>]*>/.exec(badge('x', 'neutral', 'a" onclick="evil'))?.[0] ?? '';
  assert.equal((spanTag.match(/="/g) || []).length, 1, `span 标签里只允许一个属性（class），实际：${spanTag}`);
});

test('页头与面板：标题/副标题转义；面板头体结构完整', () => {
  const evil = '<img src=x onerror=1>';
  const head = pageHead({ title: evil, sub: evil });
  assert.ok(!head.includes('<img'), '页头必须转义');
  const p = panel({ title: 'T', desc: 'D', body: '<p>B</p>' });
  assert.ok(p.includes('panel__head') && p.includes('panel__body') && p.includes('<p>B</p>'));
});

test('标签页：当前项高亮且带 aria-current（可访问性）', () => {
  const html = tabs({ items: [{ id: 'rank', label: 'A 榜', href: '#/leaderboard?scope=rank' }], active: 'rank' });
  assert.ok(html.includes('is-active'));
  assert.ok(html.includes('aria-current="page"'));
});

// ══════════════════════════════════════════════════════════════════
// 二、导航分区（三端拆分的前端落地）
// ══════════════════════════════════════════════════════════════════

const ADMIN = { id: 'u_a', name: '组委会', roles: ['admin'] };
const MEMBER = { id: 'u_m', name: '甲', roles: ['member'] };
const CAPTAIN = { id: 'u_c', name: '乙', roles: ['captain'] };
const JUDGE = { id: 'u_j', name: '丙', roles: ['judge'] };

test('角色提取：各种形状都要兜住（数组 / 单串 / 缺失 / 脏值）', () => {
  assert.deepEqual(userRoles({ roles: ['admin', 'judge'] }), ['admin', 'judge']);
  assert.deepEqual(userRoles({ roles: 'admin' }), ['admin']);
  assert.deepEqual(userRoles({}), []);
  assert.deepEqual(userRoles(null), []);
  assert.deepEqual(userRoles({ roles: ['', null, 3, 'x'] }), ['x'], '脏值要滤掉');
});

test('身份标签：已知角色 / 超管 / 未知角色 / 访客', () => {
  assert.equal(roleLabel(ADMIN), '组委会');
  assert.equal(roleLabel(CAPTAIN), '队长');
  assert.equal(roleLabel(JUDGE), '评委席');
  assert.equal(roleLabel({ id: 'x', isSuperadmin: true }), '组委会 · 超管');
  assert.equal(roleLabel({ id: 'x', roles: ['nobody'] }), '访客', '认不出的角色当访客');
  assert.equal(roleLabel(null), '访客');
});

test('导航分区：未登录只看得见公开分区', () => {
  const secs = visibleSections(null);
  assert.equal(secs.length, 1, '未登录只应有「赛事」一个分区');
  assert.equal(secs[0].id, 'public');
  const html = navHtml(null, '/');
  assert.ok(html.includes('榜单'), '公开分区要有榜单入口');
  assert.ok(!html.includes('报名筛选台'), '未登录不该看到组委会分区');
  assert.ok(!html.includes('我的战队'), '未登录不该看到「我的赛事」分区');
});

test('导航分区：选手看不到组委会分区，但看得到「我的赛事」', () => {
  const html = navHtml(MEMBER, '/');
  assert.ok(html.includes('我的战队'), '选手要有「我的赛事」分区');
  assert.ok(html.includes('报名'), '选手要有报名入口');
  assert.ok(!html.includes('报名筛选台'), '选手不该看到组委会分区');
  assert.ok(!html.includes('复核队列'), '选手不该看到复核队列');
});

test('导航分区：组委会看得到组委会分区（这是三端拆分的落地点）', () => {
  const html = navHtml(ADMIN, '/');
  assert.ok(html.includes('报名筛选台'), '组委会必须看得到筛选台');
  assert.ok(html.includes('复核队列'), '组委会必须看得到复核队列');
  assert.ok(html.includes('组委会'), '分区标签要写明是组委会');
});

test('导航分区：超管直通组委会分区（即使角色表里没写 admin）', () => {
  const html = navHtml({ id: 'u_s', name: '超管', isSuperadmin: true, roles: [] }, '/');
  assert.ok(html.includes('报名筛选台'), '超管必须直通');
});

test('导航分区：不同角色看到不同的分区集合（这是分区真的在起作用）', () => {
  const memberIds = visibleSections(MEMBER).map((s) => s.id);
  const adminIds = visibleSections(ADMIN).map((s) => s.id);
  assert.ok(!memberIds.includes('committee'), '选手分区集合里不该有 committee');
  assert.ok(adminIds.includes('committee'), '组委会分区集合里必须有 committee');
  assert.ok(memberIds.includes('player'), '选手要有 player 分区');
});

test('当前项高亮：根路径精确匹配，前缀路径匹配子路径', () => {
  assert.equal(isActive('/', { path: '/', exact: true }), true);
  assert.equal(isActive('/leaderboard', { path: '/', exact: true }), false);
  assert.equal(isActive('/leaderboard/st_1', { path: '/leaderboard' }), true);
  assert.equal(isActive('/tasks/wf_1', { path: '/tasks' }), true);
  assert.equal(isActive('/team', { path: '/tasks' }), false);
});

test('导航 HTML：用户区块显示姓名与身份；访客显示登录入口', () => {
  const html = navHtml(ADMIN, '/');
  assert.ok(html.includes('组委会'));
  assert.ok(html.includes('退出'));
  assert.ok(navHtml(null, '/').includes('登录'));
});

test('导航 HTML：服务端返回的用户名必须转义（innerHTML 插值 = 存储型 XSS）', () => {
  // ⛔ 变异检验实测：把 navHtml 里的 escapeHtml(user.name) 去掉，**全量测试照样全绿**
  //    ⇒ 这里补上判别性断言。
  const evil = '<img src=x onerror=alert(1)>';
  const html = navHtml({ id: 'u', name: evil, roles: ['admin'] }, '/');
  assert.ok(!html.includes('<img'), `用户名必须转义，实际：${html}`);
  assert.ok(html.includes('&lt;img'), `用户名必须被转义成 &lt;img，实际：${html}`);
});

// ══════════════════════════════════════════════════════════════════
// 三、路由守卫 —— 授权必须归 API，前端只判登录态
// ══════════════════════════════════════════════════════════════════

test('守卫：未登录访问受保护页 ⇒ 拒绝；已登录 ⇒ 放行', () => {
  assert.equal(canAccess('/apply', null), false, '未登录不得访问报名');
  assert.equal(canAccess('/team', null), false);
  assert.equal(canAccess('/tasks/wf_1', null), false);
  assert.equal(canAccess('/admin/registration', null), false);
  assert.equal(canAccess('/flags', null), false);
  assert.equal(canAccess('/apply', MEMBER), true);
});

test('守卫：公开页任何人都能进', () => {
  for (const p of ['/', '/leaderboard', '/leaderboard/st_1', '/tier', '/card/t_1']) {
    assert.equal(canAccess(p, null), true, `${p} 应当公开`);
  }
});

test('守卫：**不按角色拦路** —— 授权是 API 的事，前端按角色拦会误伤被直接授权的人', () => {
  // ⚠️ 这是本轮设计红线：能力点可以**直接授权给个人**（assignments 表），
  //    根本不经角色 ⇒ 前端手里没有能力信息 ⇒ 按角色拦 = 误伤有权限的人。
  assert.equal(canAccess('/flags', MEMBER), true, '前端不得按角色阻断（服务端才是裁决者）');
  assert.equal(canAccess('/audit/cmp_1', MEMBER), true);
  assert.equal(canAccess('/admin/registration', { id: 'x', roles: [] }), true);
});

test('守卫规则表：受保护路径必须真的被规则命中', () => {
  assert.ok(guardFor('/apply'));
  assert.ok(guardFor('/admin/registration'));
  assert.ok(guardFor('/audit/cmp_1'));
  assert.equal(guardFor('/leaderboard'), null);
});

test('守卫：受保护路由表里**不许出现 roles 字段**（防「有人把角色闸加回来」）', () => {
  // ⛔ 变异检验实测：只改 canAccess（加角色闸）在当前代码下是**等价变异体**
  //    （PROTECTED_ROUTES 里没有 roles ⇒ 那段代码是死代码）⇒ 测不出问题。
  //    ⇒ 真正要防的是「有人给路由表加 roles 字段」⇒ 这里直接钉住这张表。
  for (const r of PROTECTED_ROUTES) {
    assert.equal(
      r.roles,
      undefined,
      `受保护路由 ${r.pattern} 不许有 roles —— 授权归 API，前端按角色拦会误伤被直接授权的人`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════
// 四、端到端：守卫真的拦住了请求（反向对照）
// ══════════════════════════════════════════════════════════════════

/** 最小 DOM 桩：够 web/app.js 跑起来 */
function installDom(hash = '') {
  const calls = [];
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
  });
  const app = mk('div');
  const topbar = mk('div');
  globalThis.window = { location: { search: '', hash }, addEventListener() {} };
  globalThis.document = {
    createElement: (tag) => mk(tag),
    getElementById: (id) => (id === 'topbar' ? topbar : app),
  };
  return { app, topbar, calls };
}

async function bootApp(hash, meBody, tag) {
  const dom = installDom(hash);
  globalThis.fetch = async (url) => {
    dom.calls.push(String(url));
    const body = String(url) === '/api/me' ? meBody : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  await import(`../web/app.js?v=${tag}`);
  await new Promise((r) => setTimeout(r, 30));
  return dom;
}

test('守卫：未登录点「报名」⇒ 不发业务请求，且渲染「需要登录」引导页', async () => {
  const dom = await bootApp('#/apply', { user: null }, 'guard-anon');
  assert.ok(
    !dom.calls.some((c) => c.includes('/api/registration-criteria')),
    `未登录不得触发报名接口，实际请求：${JSON.stringify(dom.calls)}`,
  );
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('需要登录'), `应渲染登录引导页，实际：${html}`);
  assert.ok(html.includes('#/login'), '引导页要给出登录入口');
});

test('守卫（反向对照）：已登录点「报名」⇒ 请求发出、页面渲染（上一条不是恒绿）', async () => {
  const dom = await bootApp('#/apply', { user: { id: 'u_m', name: '甲', roles: ['member'] } }, 'guard-auth');
  assert.ok(
    dom.calls.some((c) => c.includes('/api/registration-criteria')),
    `已登录必须真的请求报名接口，实际请求：${JSON.stringify(dom.calls)}`,
  );
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('报名'), `应渲染报名页，实际：${html}`);
});

test('顶栏：已登录时显示姓名与身份；未登录时显示登录入口', async () => {
  const dom = await bootApp('#/', { user: { id: 'u_a', name: '组委会', roles: ['admin'] } }, 'topbar-auth');
  const nav = dom.topbar.innerHTML;
  assert.ok(nav.includes('组委会'), `顶栏要显示身份，实际：${nav}`);
  assert.ok(nav.includes('报名筛选台'), '组委会要看到组委会分区入口');

  const anon = await bootApp('#/', { user: null }, 'topbar-anon');
  assert.ok(anon.topbar.innerHTML.includes('登录'), '未登录要看到登录入口');
  assert.ok(!anon.topbar.innerHTML.includes('报名筛选台'), '未登录不该看到组委会入口');
});

test('总览页：未登录也要有内容（首屏不能白屏）', async () => {
  const dom = await bootApp('#/', { user: null }, 'home-anon');
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('未登录'), `首屏必须显示未登录状态，实际：${html}`);
  assert.ok(html.includes('赛事'), '首屏要有内容');
});
```

### `platform/test/demo-api-parity.test.js`

`platform/test/demo-api-parity.test.js`：

```javascript
// platform/test/demo-api-parity.test.js —— 演示适配器与真实后端的**端点覆盖**一致性
//
// 规则溯源：
//   - 「演示站与正式站同码同行为」→ R-OPS-06（?demo=1 走演示版适配器）
//   - 「前端视图消费的端点，演示适配器必须都实现」→ P7 打磨中发现：
//     演示适配器**缺 8 个端点** ⇒ 公网演示站的「报名 / 我的战队 / 报名筛选台 /
//     复核队列 / 计算留痕 / 任务清单」**六页全是 404**，
//     而打磨前那些页面的错误态是个裸 `.card err` ⇒ 看不出来是「端点缺失」。
//
// ⚠️ 为什么要单独一条闸：
//   前端用到的端点清单是**可枚举**的（11 个视图的 api.get/api.post 调用点），
//   ⇒ 「演示适配器必须实现清单里的每一条」是一条**机器可复算**的约束。
//   以前没有这条闸 ⇒ 端点缺失只能靠人点页面才发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

async function bootDemo() {
  const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeStorage(), seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  // 跑一次真实引擎的计算 ⇒ 产出 results / computations（与构建期预计算同一条路径）
  await api.post('/api/stages/stage_final/compute', {});
  return { api, rules };
}

/**
 * 前端 11 个视图 + 应用外壳**实际调用**的端点清单。
 * ⚠️ 这张表是**从视图源码里扫出来的**（web/views/*.js + web/app.js 的 api.get/api.post 调用点），
 *    不是手写印象 —— 手写清单会漏。
 */
const VIEW_ENDPOINTS = [
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/registration-criteria' },
  { method: 'GET', path: '/api/teams' },
  { method: 'GET', path: '/api/task-packages' },
  { method: 'GET', path: '/api/registrations' },
  { method: 'GET', path: '/api/registrations/reg_demo_1' },
  { method: 'POST', path: '/api/registrations/reg_demo_1/level', body: { level: 'A', note: '复核通过' } },
  { method: 'POST', path: '/api/teams/t_alpha/members', body: { action: 'leave' } },
  { method: 'GET', path: '/api/stages' },
  { method: 'GET', path: '/api/workflows' },
  { method: 'GET', path: '/api/workflows/wf_demo_1/tasks' },
  { method: 'POST', path: '/api/tasks/wt_demo_1/claim', body: {} },
  { method: 'POST', path: '/api/tasks/wt_demo_1/complete', body: { evidence: { kind: 'runnable', summary: 'x' } } },
  { method: 'POST', path: '/api/tasks/wt_demo_1/release', body: {} },
  { method: 'GET', path: '/api/leaderboard/rolling' },
  { method: 'GET', path: '/api/leaderboard/tier' },
  { method: 'GET', path: '/api/teams/t_alpha/performance-card' },
  { method: 'GET', path: '/api/audit/flags' },
  { method: 'GET', path: '/api/audit/computations/cmp_demo_1' },
  { method: 'GET', path: '/api/audit/computations/cmp_demo_1/diff' },
];

test('演示适配器必须实现前端用到的**每一个**端点（缺一个 ⇒ 演示站那页就是 404）', async () => {
  const { api } = await bootDemo();
  const missing = [];
  for (const ep of VIEW_ENDPOINTS) {
    try {
      await api[ep.method.toLowerCase()](ep.path, ep.body);
    } catch (e) {
      // ⚠️ 判据必须是「**端点没实现**」这个专属信号，不能是「404」——
      //    业务上的「单条记录不存在 / 你不在该队」也是 404（设计文档 §7.3 的三态口径），
      //    那是**正确的**行为，不是缺口。
      //    演示适配器给「端点未实现」单独标了 DEMO_ENDPOINT_MISSING。
      if (e.code === 'DEMO_ENDPOINT_MISSING') missing.push(`${ep.method} ${ep.path} → ${e.message}`);
    }
  }
  assert.deepEqual(missing, [], `演示适配器缺少这些端点：\n${missing.join('\n')}`);
});

test('演示适配器的「端点未实现」必须用**专属错误码**（不能与业务上的 404 撞码）', async () => {
  // ⚠️ 为什么要单独钉：业务上的「单条记录不存在」也是 404（设计文档 §7.3 的三态口径）。
  //    两者撞码 ⇒ 「这一页是不是 404」与「这条记录在不在」分不开
  //    ⇒ 上面的端点覆盖闸就**永远看不到**端点缺失。
  //    ⇒ 「端点未实现」用 DEMO_ENDPOINT_MISSING 单独标记。
  const { api } = await bootDemo();
  await assert.rejects(
    () => api.get('/api/no-such-endpoint-at-all'),
    (e) => {
      assert.equal(e.code, 'DEMO_ENDPOINT_MISSING', `端点未实现必须有专属错误码，实际：${e.code}`);
      assert.ok(String(e.message).includes('未实现'), '错误消息要说清是「未实现」');
      return true;
    },
  );
});

test('演示适配器的报名筛选标准：形状与真实后端 buildCriteria 一致', async () => {
  const { api } = await bootDemo();
  const c = await api.get('/api/registration-criteria');
  assert.ok(c.editionId, '必须有届期 id（前端提交报名要带）');
  assert.ok(c.scale?.min && c.scale?.max, '必须带量表');
  assert.equal(c.dimensions.length, 3, '三维');
  for (const d of c.dimensions) {
    assert.ok(d.items.length > 0, `维度 ${d.key} 必须带题目（否则前端渲染不出评分控件）`);
  }
  assert.ok(c.levels.length > 0, '必须带等级阈值');
  assert.ok(c.openQuestion?.prompt, '必须带开放题题干');
  assert.ok(c.ipOwnership?.team, '必须带 IP 归属（团队保留 IP）—— R-ENT-11');
  assert.ok((c.redLines ?? []).length > 0, '必须带合规红线 —— R-ENT-12');
  assert.ok(c.consent?.prompt, '必须带同意条款');
});

test('演示适配器的我的战队：成员是**对象数组**（不是 userId 数组）', async () => {
  const { api } = await bootDemo();
  const { items } = await api.get('/api/teams');
  assert.ok(items.length > 0, '演示站要有队伍');
  const t = items[0];
  assert.ok(Array.isArray(t.members), 'members 必须是数组');
  assert.ok(t.members.length > 0, '成员不能为空');
  assert.ok(t.members[0].userId, '成员要有 userId');
  assert.ok(['captain', 'member'].includes(t.members[0].role), '成员要有 role');
  assert.ok(t.captainId, '要有队长 id');
  assert.ok(t.formation, '要有 formation（前端据此显示组建校验结果）');
});

test('演示适配器的任务包：形状与真实后端 presentTaskPackage 一致', async () => {
  const { api } = await bootDemo();
  const { items, mix } = await api.get('/api/task-packages');
  assert.ok(items.length > 0, '演示站要有任务包（否则「认领任务包」下拉是空的）');
  assert.ok(items[0].title, '要有标题');
  assert.equal(typeof items[0].isFreeBrief, 'boolean', 'isFreeBrief 必须是布尔');
  assert.ok(mix, '必须带配比体检（筛选台要显示）');
  assert.equal(typeof mix.total, 'number');
});

test('演示适配器的报名记录：带 grading 与 events（筛选台那两列的数据源）', async () => {
  const { api } = await bootDemo();
  await api.post('/api/registrations', {
    editionId: 'ed_demo',
    answers: {
      direction: [4, 4, 4, 4, 4],
      capability: [4, 4, 4, 4, 4],
      collaboration: [4, 4, 4, 4, 4],
      open: '演示报名',
      consent: { accepted: true },
    },
  });
  const { items } = await api.get('/api/registrations');
  assert.ok(items.length > 0, '报名后要能看到记录');
  const r = items[items.length - 1];
  assert.ok(r.grading, '必须有 grading（分数 / 是否接收 / 可解释明细）');
  assert.equal(typeof r.grading.score, 'number');
  assert.ok(Array.isArray(r.grading.explain), 'explain 必须是数组');
  assert.ok(Array.isArray(r.events), 'events 必须是数组（事件轨迹列）');
  // 改级要留下事件轨迹（追加式，历史不覆盖）
  await api.post(`/api/registrations/${r.id}/level`, { level: 'A', note: '复核通过' });
  const after = (await api.get('/api/registrations')).items.find((x) => x.id === r.id);
  assert.equal(after.levelFinal, 'A', '改级要写 levelFinal');
  assert.equal(after.events.length, 1, '改级要追加一条事件轨迹');
  assert.ok(after.events[0].reason, '事件轨迹要带理由');
});

test('演示适配器的审计三端点：留痕含降级告警与每队 trace；diff 必然一致', async () => {
  const { api } = await bootDemo();
  const trace = await api.get('/api/audit/computations/cmp_demo_1');
  assert.ok(trace.ruleVersion, '要有规则版本');
  assert.ok(trace.output?.teams?.length, '要有输出队伍');
  assert.ok(trace.trace?.normalization, '要有归一化明细（降级告警的来源）');
  assert.ok(trace.trace?.perTeam, '要有每队 trace（原始分 / z 分 / 去极值 / 加权）');
  assert.ok(Array.isArray(trace.trace?.warnings), '要有告警数组（降级状态必须显式展示）');

  const diff = await api.get('/api/audit/computations/cmp_demo_1/diff');
  assert.equal(diff.identical, true, '同一输入复算必然一致（演示站跑的是同一套引擎）');
  assert.deepEqual(diff.diff, [], '无差异时 diff 必须是空数组');

  const flags = await api.get('/api/audit/flags');
  assert.ok(Array.isArray(flags.rows), '复核队列必须返回数组');
  assert.equal(typeof flags.total, 'number');
});

test('演示适配器的任务清单：可领取 / 可提交完成 / 可释放（三条写路径）', async () => {
  const { api } = await bootDemo();
  const { items: workflows } = await api.get('/api/workflows');
  assert.ok(workflows.length > 0, '要有工作流');
  assert.equal(typeof workflows[0].taskCount, 'number', '入口页要知道任务数');

  const { tasks } = await api.get(`/api/workflows/${workflows[0].id}/tasks`);
  assert.ok(tasks.length > 0, '工作流里要有任务');
  const t = tasks[0];
  await api.post(`/api/tasks/${t.id}/claim`, {});
  const after = (await api.get(`/api/workflows/${workflows[0].id}/tasks`)).tasks
    .find((x) => x.id === t.id);
  assert.ok(after.claim, '领取后要有 claim');
  assert.equal(after.claim.userId, 'demo_admin', 'claim 要记录领取人');
  await api.post(`/api/tasks/${t.id}/complete`, { evidence: { kind: 'runnable', summary: 'x' } });
  const done = (await api.get(`/api/workflows/${workflows[0].id}/tasks`)).tasks
    .find((x) => x.id === t.id);
  assert.equal(done.status, 'done', '提交完成要落状态');
  assert.ok(done.completedAt, '要记完成时间');
});
```

---

## 10. 本轮决策记录（DP）

| # | 决策 | 内容 |
|---|---|---|
| DP-77 | ⛔ **前端不按角色拦路由（设计红线）** | 能力点可以**直接授权给个人**（`assignments` 表），根本不经角色 ⇒ 前端手里只有角色、按角色拦 = **误伤有权限的人**。⇒ 路由守卫**只判登录态**；授权的唯一裁决者是 API。角色只用于**导航入口的呈现**。<br>⚠️ 变异检验实测：只改 `canAccess`（加角色闸）在当前代码下是**等价变异体**（路由表里没有 `roles` ⇒ 死代码）⇒ 真正的回归场景是「有人给路由表加回 roles」⇒ 已补「路由表**不许**有 `roles` 字段」的断言。 |
| DP-78 | ⛔ **「端点未实现」要与业务 404 区分** | 演示适配器的兜底错误原来用 `NOT_FOUND`，与「单条记录不存在」（设计文档 §7.3 的三态口径）**撞码** ⇒ 「这页是不是 404」与「这条记录在不在」分不开 ⇒ 回归闸永远看不到端点缺失。⇒ 改用专属码 **`DEMO_ENDPOINT_MISSING`**。 |
| DP-79 | ⛔ **空态必须说清「为什么空 + 什么时候会有」** | 打磨前 11 个页面的空态清一色 `<p class="muted">暂无数据</p>` ⇒ 用户只看到一个灰盒子。⇒ `emptyState({title, hint, action})` 的 `hint` 是**必填语义**。 |
| DP-80 | ⛔ **错误态必须带真的能点的重试** | 打磨前的错误态是裸 `<div class="card err">` ⇒ 死路一条。⇒ `errorState` 的重试按钮是**必须有**的，且视图要真的把重跑逻辑绑上去（`data-action="retry"`）。 |
| DP-81 | ⛔ **去掉 `location.reload()`** | 筛选台「改级」与「我的战队」的建队/退出原本用整页刷新 ⇒ **冲掉用户已填内容**（改级意见、队名）= 生产级事故。⇒ 全部改成**就地刷新 + 可见反馈**。 |
| DP-82 | ⛔ **评分控件不用 `<select>`** | 报名问卷每题一个 1–5 分下拉框 ⇒ 要展开才能看清量表。⇒ 改成横排 `.radio-group` 按钮组（1–5 一眼可见）。<br>⚠️ 同时这也是 R-OPS-14 的残留入口清理（任务清单页**不许**出现 `<select`）。 |
| DP-83 | 🎨 **设计 token 优先于组件** | 换主题只换变量、不改组件规则 ⇒ 亮/暗两套皮肤共用一套组件。 |
| DP-84 | 📐 **顶栏与内容容器拆成两个元素** | 切页不必重建页面骨架；且 `#app` 的**首个子节点必须仍是视图本身**（`test/workflow-e2e.test.js` 按 `children[0].innerHTML` 断言）。 |
| DP-85 | 📐 **顶栏先渲染、内容后渲染** | 视图渲染失败时页面不至于白屏；且 catch 分支写入的内容不会被顶栏覆盖（**写入顺序 = 视觉顺序**）。 |
| DP-86 | 🧪 **审计器必须打印失配明细** | C-RW 的判据是贪心子序列匹配 ⇒ 改掉靠前的一行会让后面全部失配 ⇒ 看起来像整文件被重写。⇒ 工具直接打印**第一处失配行**（沿用「D 类必须打印明细」的纪律）⇒ 判据不变，诊断信息自足。 |
| DP-87 | 🧪 **class 清单要做差集核对** | 视图里写出来的 class 必须在样式表里**有对应规则**，否则「拼错 / 没定义」只表现为「样式没生效」，**完全看不出来**。⇒ 把视图用到的 class 全量抽出求差集（本轮查出 **15 个缺失**）。 |
| DP-88 | 🔗 **新增端点必须能补上「可发现性」** | 赛段选择器与任务清单入口需要「列表端点」；仓储层本来就有 `listStages` / `listWorkflowsByEdition`，只是**没端点** ⇒ 页面在生产上走不通。⇒ 补两个**只读**端点。 |

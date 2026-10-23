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
  - ⛔ **P7.1 起，总览页从本文件抽到 `web/views/home.js`**（P7 owns，新建）：12 个视图里原先只有首页住在 `app.js`；
    且首页的「指标形状 / 榜单字段口径 / 入口死链」三条判据必须**可断言** ⇒ 抽成纯函数 `homeKpiCards` / `homeBoardHtml` / `homeEntryCards`，
    本文件只留 `route('/', (c) => renderHome(c))`（详见 §8.5）。
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
| 浏览器实测 | 演示站首页**无错误态**、KPI 标签与数值**对得上**、榜单行有**名次与积分**、入口卡**无死链**（见 §8.5） |

---

## 8.5 浏览器实测收尾（P7.1：真实浏览器里抓到的 5 个真 bug）

⚠️ **为什么要有这一节**：§8 的验收标准全是「测试绿 + 机器闸绿」，而 §8.5 的 5 个 bug **全部通过了这些闸**——
它们是在**真实浏览器**里点出来的（截图可见：首页榜单行显示「. 拾光队」+「分」）。
⇒ 结论：**机器闸覆盖不到的口径错误，只有真机能抓**。

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| B1 | 未登录时首页「参赛队伍」显示的是**榜单数**，「在榜队伍」是空的 | `jobs` 数组按登录态**改变长度** ⇒ `const [teamCount, boardCount] = await Promise.all(jobs)` **解构错位** | 标签跟着值一起出现/消失；缺失值用 `null` 占位（不是少一个元素）。另：`GET /api/teams` 返回的是**我参与的战队** ⇒ 标签改「我的队伍」 |
| B2 | 榜单每行渲染成「. 拾光队」+「分」（名次与积分**两个空值**） | 滚动总榜的行字段是 `points`、且**没有 `rank` 也没有 `total`**（`getRollingLeaderboard` 与演示适配器**形状一致**）⇒ 前端用了不存在的字段 | 名次按返回顺序（已按积分降序）自己编号；积分取 `points` |
| B3 | 榜单错误态的「重试」按钮**点了没反应** | `errorState` 渲染了按钮，但调用方**没绑定 click** ⇒ 死路一条（违反 DP-80） | 抽出 `loadBoard()`，把重试绑上去 |
| B4 | 首页「报名入口」按钮点了是「页面不存在」 | 链接写的是 `#/register`，路由表里只有 `/apply` | 改 `#/apply`；并新增**死链闸**（拿路由表逐一比对所有 href） |
| B5 | 网络层失败把英文 `Failed to fetch` 甩给用户；更糟：**一次失败后整个演示站永久瘫痪** | ① 错误消息直接透传浏览器 TypeError；② `getDemoRuntime()` 把**被 reject 的 promise** 存进模块级变量 ⇒ 之后每次调用都抛同一个错 ⇒ 「重试」重试的是同一份坏 promise，**永远救不回来** | ① `friendlyError()` 统一友好化，放在 `errorState` 这个**唯一出口**；② 失败时**清掉缓存**，下一次调用重新加载 |

### 8.5.1 首页为什么从 `web/app.js` 抽成 `web/views/home.js`

B1 / B2 / B4 三条都藏在 `app.js` 的异步闭包里 ⇒ 只能靠人点页面发现。
⇒ 把「数据 → 卡片/行」的映射抽成**纯函数**（`homeKpiCards` / `homeBoardHtml` / `homeEntryCards`），
   `app.js` 只负责挂路由 ⇒ `platform/test/web-home.test.js` 能对**结果本身**断言。

⚠️ 顺带修掉一个结构性不一致：12 个视图里**只有首页**住在 `app.js`，其余 11 个都在 `web/views/`。

### 8.5.2 浏览器首轮观察到的「Failed to fetch」

首轮浏览器验证时首页报「Failed to fetch」。复查结论：
- reload 后 **48 个请求全部成功**（含 1 份种子 + 13 份规则）⇒ 该次失败是**演示站重新发布那一瞬间**的瞬时故障
  （nginx 短暂拿不到静态文件），**不是**代码里的稳定缺陷；
- 但它暴露了 B5 的**放大器**：一次瞬时故障 ⇒ 演示站永久瘫痪且无法自救。

⇒ 处置：**不把瞬时故障当 bug 修**，但把「失败被缓存 ⇒ 永久瘫痪」这个放大器修掉（DP-93）。

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
import { iconEmpty, iconWarn } from './icons.js';

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
 *
 * @param {object}  o
 * @param {string}  [o.title]
 * @param {string}  [o.hint]
 * @param {object}  [o.action]  { href, label }
 * @param {string}  [o.titleTag='p']  标题用的标签。
 *   ⚠️ 默认 'p'（空态多数是**页面中段**的局部状态，不能每个都抢 h1）；
 *      只有「整页就是这一个状态」时才传 'h1' ——
 *      路由守卫兜底页就是这种（它是整个页面的唯一内容）。
 */
export function emptyState({ title = '暂无数据', hint = '', action = null, titleTag = 'p' } = {}) {
  const actionHtml = action && action.label
    ? `<a class="btn btn--primary btn--sm" href="${escapeHtml(action.href ?? '#')}">${escapeHtml(action.label)}</a>`
    : '';
  // ⚠️ titleTag 只允许白名单：它是拼进 HTML 的标签名，不能是外部输入。
  const tag = titleTag === 'h1' ? 'h1' : 'p';
  return `<div class="state state--empty">
    <div class="state__icon" aria-hidden="true">${iconEmpty(32)}</div>
    <${tag} class="state__title">${escapeHtml(title)}</${tag}>
    ${hint ? `<p class="state__hint">${escapeHtml(hint)}</p>` : ''}
    ${actionHtml}
  </div>`;
}

/**
 * 错误态：消息 + 重试按钮。
 * ⚠️ 重试按钮是**必须有**的：生产级错误态不能是死路一条。
 *   按钮挂 `data-action="retry"`，由视图侧绑定具体重跑逻辑。
 *
 * ⚠️ 消息在**这里**统一过一道 friendlyError：
 *   11 个视图各写各的错误态时，最常见的事故就是把浏览器的英文 TypeError
 *   （"Failed to fetch"）原样甩给用户。放在这个**唯一出口**归一，
 *   比要求 11 个视图各自记得调用友好化更可靠（也少改 11 个文件）。
 */
export function errorState({ message = '加载失败', retry = true, hint = '' } = {}) {
  const text = friendlyError(message, '加载失败');
  const retryHtml = retry
    ? '<button type="button" class="btn btn--ghost btn--sm" data-action="retry">重试</button>'
    : '';
  return `<div class="state state--error" role="alert">
    <div class="state__icon" aria-hidden="true">${iconWarn(32)}</div>
    <p class="state__title">${escapeHtml(text)}</p>
    ${hint ? `<p class="state__hint">${escapeHtml(hint)}</p>` : ''}
    ${retryHtml}
  </div>`;
}

/**
 * 把技术错误翻译成**人话**（生产级错误态的第一要求）。
 *
 * ⚠️ 为什么需要这一层：
 *   网络层失败时浏览器抛的是英文 TypeError（"Failed to fetch" / "Load failed"），
 *   直接透给用户 = 把开发细节甩到脸上，而且用户**不知道下一步该干什么**。
 *   ⇒ 这里只做一件事：**认出网络层失败**，换成一句带下一步的中文。
 *
 * ⚠️ 边界：只改写**网络层**失败；业务错误（后端 AppError 的中文 message）原样透出，
 *   避免把「未登录」「战队不存在」这类**有业务含义**的信息洗成通用话术。
 *
 * @param {unknown} err        捕获到的异常
 * @param {string}  fallback   连 message 都没有时的兜底文案
 * @returns {string}           可直接交给 errorState({ message }) 的纯文本
 */
export function friendlyError(err, fallback = '加载失败，请重试') {
  const raw = typeof err === 'string' ? err : (err?.message ?? '');
  const msg = String(raw ?? '').trim();
  if (/failed to fetch|networkerror|load failed|network request failed|网络错误/i.test(msg)) {
    return '网络连接失败，请检查网络后重试';
  }
  if (!msg || msg === 'undefined' || msg === 'null') return fallback;
  return msg;
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
  // ⚠️ 备注前必须加**分隔符**（P8 实测发现的真问题）：
  //    值与备注是**相邻**的两个 span，中间只有一个 4px 的视觉间距 ——
  //    于是「1」（1 支队伍）+「25%」（占比）在**文本提取 / 读屏**里拼成「125%」，
  //    一个**假数字**。⇒ 统一加「·」分隔，文本与视觉都读得对。
  const noteHtml = note ? `<span class="bar__note">· ${escapeHtml(note)}</span>` : '';
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
 * 操作台骨架：**左轨选对象 + 右画布做操作**。
 *
 * ⚠️ **为什么需要它**（P12 实测诊断）：
 *   P11 新建的四个委员会页（赛段配置 / 破同分 / 公开链接 / 审计日志）
 *   此前全是同一套通用卡片栈一字排开（顶层恒为 `header + 若干 section.panel`），
 *   ⇒ 四页长得一模一样，而且**「我现在在操作哪一个对象」没有位置放**。
 *   ⇒ 这里给出一个**共同的宏观结构**；差异靠各页左轨的内容，不靠换皮。
 *
 * ⚠️ **形状，不是皮肤**：结构类（workbench / workbench__rail / workbench__canvas）
 *   的样式在 web/styles.css 的 ⑫ 段；本函数**不写字面色值、不写 <style> 标签**。
 *   窄屏由 CSS 折叠成单列（左轨在上、右画布在下）。
 *
 * @param {object}  o
 * @param {string}  o.rail    左轨内容（选对象：选择器 / 过滤条 / 表单）
 * @param {string}  o.canvas  右画布内容（做操作：面板 / 表格 / 指标）
 */
export function workbench({ rail = '', canvas = '' } = {}) {
  return `<div class="workbench">
    <aside class="workbench__rail">${rail}</aside>
    <div class="workbench__canvas">${canvas}</div>
  </div>`;
}

/**
 * 轨内条目：左轨里的**当前对象**（赛段 / 轮次 / …）的入口。
 *
 * ⚠️ **为什么放在这里而不是视图里**（本仓既有纪律）：
 *   ① 视图里**不许**出现「模板表达式拼 class」（`class="x${cond ? ' y' : ''}"`）——
 *      机器闸（test/stage-config-view.test.js「不许自造 CSS 类名」）按 `class="…"`
 *      字面量抽类名，模板表达式会把它抽成 `x${cond` 这种垃圾。
 *      仓库的既有做法就是**条件 class 走组件层**（badge 的 extraClass / panel 的 tone /
 *      tableWrap 的 className）—— 这里沿用同一口径。
 *   ② 四个委员会页共用同一套条目形状 ⇒ 只写一次。
 *
 * ⚠️ **当前项不置 disabled**：禁用按钮会被读屏跳过，
 *    而这里恰恰要告诉用户「你现在就在这个对象上」⇒ 用 `aria-current` 表达。
 *
 * @param {object}  o
 * @param {string}  o.key     小号等宽标识（赛段代号）
 * @param {string}  o.name    主标题（赛段名称）
 * @param {string}  o.meta    副行（类型 · 状态 · 时间窗）
 * @param {boolean} [o.active=false]  是否是当前对象
 * @param {string}  [o.action]  点击动作名（视图侧事件委托的 data-action）
 * @param {string}  [o.dataKey]  附加数据属性名（不含 data- 前缀），如 stage-id
 * @param {string}  [o.dataValue] 附加数据属性值
 */
export function workbenchItem({
  key = '', name = '', meta = '', active = false,
  action = '', dataKey = '', dataValue = '',
} = {}) {
  const cls = active ? 'workbench__item is-active' : 'workbench__item';
  const actionAttr = action ? ` data-action="${escapeHtml(action)}"` : '';
  // ⚠️ data-* 的键名也要过一遍白名单：它是拼进 HTML 的属性名，不能是外部输入。
  const safeKey = /^[a-z][a-z0-9-]*$/.test(dataKey) ? dataKey : '';
  const dataAttr = safeKey ? ` data-${safeKey}="${escapeHtml(dataValue)}"` : '';
  const current = active ? ' aria-current="true"' : '';
  return `<button type="button" class="${cls}"${actionAttr}${dataAttr}${current}>
    <span class="workbench__item-key">${escapeHtml(key)}</span>
    <span class="workbench__item-name">${escapeHtml(name)}</span>
    <span class="workbench__item-meta">${escapeHtml(meta)}</span>
  </button>`;
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
import { iconLogo, iconTheme } from './icons.js';

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
 * ⛔ 「评审台」分区在 **P8 之前**故意留空：评审打分页当时不存在，
 *   放一个空分区等于放一个死入口 —— 等页面真的存在时再加这一条数据。
 *   ⇒ P8 起补上「评审席」分区（评审打分）与组委会分区里的「赛段发榜」。
 */
export const NAV_SECTIONS = [
  {
    id: 'public',
    label: '赛事',
    items: [
      { path: '/', label: '首页', exact: true },
      { path: '/leaderboard', label: '榜单' },
      { path: '/tier', label: '段位榜' },
    ],
  },
  {
    id: 'player',
    label: '我的赛事',
    auth: true,
    items: [
      // ⚠️ P9：工作台 = 原「赛事总览」仪表盘，从 `/` 迁到这里（首页让位给落地页）。
      { path: '/dashboard', label: '工作台' },
      { path: '/apply', label: '报名' },
      { path: '/team', label: '我的战队' },
      { path: '/tasks', label: '任务清单' },
    ],
  },
  {
    // ⚠️ **不按角色限定**：评委席位是**赛段级**指派的（stage_judges 表），
    //   前端手里没有「你是不是本赛段评委」这个信息 ⇒ 硬按角色限定会**误伤**。
    //   能不能进评审页由 API 裁决（403 → 错误态说清缺什么权限），沿用 DP-77。
    id: 'reviewer',
    label: '评审席',
    auth: true,
    items: [
      { path: '/review', label: '评审打分' },
      // ⚠️ P10：评委前置（回避申报 / 互评 / 自评 / 校准）——
      //   ⛔ **不按角色限定**：评委的能力点可能是**赛段级**授权，
      //   前端拿不到「你是不是本赛段评委」⇒ 按能力点过滤会误伤（DP-105 同一条原则）。
      { path: '/review/prep', label: '评委前置' },
    ],
  },
  {
    // ⚠️ P10 · W4-b：企业席分区（企业签字台 = 里程碑签字 + 企业双签）。
    //   按**角色**分区（不是能力点）：`signoff:create` 可以是**届期级**授权，
    //   而 `/api/me` 的 capabilities 只回「全局授权 + 角色能力」
    //   ⇒ 按能力点过滤会把届期级授权的人**挡在菜单外**（误伤）。
    //   能不能签一律由 API 裁决（403 → 错误态说清缺什么权限）。
    id: 'enterprise',
    label: '企业席',
    auth: true,
    roles: ['enterprise', 'enterprise_admin'],
    items: [
      { path: '/signoff', label: '企业签字台' },
    ],
  },
  {
    id: 'committee',
    label: '组委会',
    auth: true,
    roles: ['admin'],
    items: [
      { path: '/admin/registration', label: '报名筛选台' },
      { path: '/admin/task-packages', label: '任务卡审批' },
      { path: '/admin/appeals', label: '申诉裁决' },
      { path: '/flags', label: '复核队列' },
      { path: '/publish', label: '赛段发榜' },
      // ⚠️ P11：加时陈述 / 一票破同分（此前服务层 181 行 + 路由都写好了，**没有任何入口**）
      { path: '/tiebreak', label: '加时陈述' },
      // ⚠️ P11：公开访问链接（公开榜单 / 公开日历的令牌，此前**没有任何创建入口**）
      { path: '/admin/public-links', label: '公开访问链接' },
      // ⚠️ P11：审计日志（`GET /api/audit/log` 早就挂在后端，前端**从来没调用过**）
      { path: '/audit/log', label: '审计日志' },
      // ⚠️ E158：赛段配置与权重表（设计 §9「组委会视角」明写要有这块界面）。
      //   此前 P11 把建段 / 改配置 / 派评委 / 报名册 6 个**写**端点全做完了，
      //   却**一个界面都没有** ⇒ 端点零调用方（与 E149/E150 同一族的「写了没接线」）。
      { path: '/stages', label: '赛段配置' },
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
 * ⚠️ **这里的守卫只判「是否登录」**（角色/能力一律由 API 裁决 —— 理由见下）。
 *
 * ⛔⛔ **前端绝不按角色**硬编码**拦路**（DP-77 的原始红线，W1-b · DP-105 修订）：
 *   前端手里的角色**不等于**服务端的授权结果 —— 能力点可以**直接授权给个人**
 *   （assignments 表 / resource-level 授权），根本不经角色。
 *   ⇒ 如果前端按角色拦路由，一个「有 audit:read 但没有 admin 角色」的人
 *      会被前端挡在门外，而 API 其实放行 —— **误伤有权限的人**。
 *   ⇒ 授权的唯一裁决者是 API（can() + scopeClause）。
 *   角色分区只用于**导航入口的呈现**（谁看到哪些菜单），
 *   它不阻断任何页面的可达性 —— 真正的拦截交给服务端。
 *
 * ⚠️ **W1-b · DP-105 的修订**：前端**按能力点**拦**分区级**页面（见 ROUTE_CAPABILITIES）——
 *   这不是「按角色硬编码」，而是「按能力点声明」，且**只声明 API 同样要求全局能力点**的页面，
 *   ⇒ 前后端口径一致，不会出现「前端放行、API 403」或「前端拦下、API 放行」。
 *   赛段级页面（/review/:stageId 等）**一律不拦**：评委的能力点可能是赛段级授权，
 *   前端无从判断 ⇒ 拦了就是误伤（DP-105 明写「不拦」）。
 */
export const PROTECTED_ROUTES = [
  // P9：工作台（原总览仪表盘）需要登录
  { pattern: /^\/dashboard\/?$/, auth: true },
  { pattern: /^\/apply\/?$/, auth: true },
  { pattern: /^\/team\/?$/, auth: true },
  { pattern: /^\/tasks(\/|$)/, auth: true },
  { pattern: /^\/admin(\/|$)/, auth: true },
  { pattern: /^\/flags\/?$/, auth: true },
  { pattern: /^\/audit(\/|$)/, auth: true },
  // P8：评审打分与赛段发榜都需要登录（/^\/review(\/|$)/ 已覆盖 P10 的 /review/prep）
  { pattern: /^\/review(\/|$)/, auth: true },
  { pattern: /^\/publish(\/|$)/, auth: true },
  // P10：企业签字台需要登录
  { pattern: /^\/signoff\/?$/, auth: true },
];

/**
 * 分区级页面 → 所需能力点（W1-b · DP-105）。
 *
 * ⚠️ **精确匹配，不是前缀匹配**：
 *   '/publish' 要 'stage:compute'，但 '/publish/stage_final'（赛段级发榜）**不在表里** ——
 *   它的权限由 API 按赛段裁决（评委 / 企业席拿的是**赛段级**授权），
 *   前端拿不到「你是不是本赛段评委」这个信息 ⇒ 拦它就是误伤。
 *
 * ⚠️ **只列「API 同样要求全局能力点」的页面** ⇒ 前后端口径一致：
 *   | 路径 | 能力点 | 服务端口径 |
 *   |---|---|---|
 *   | /admin/registration | registration:review | 全局（管理员端筛选台） |
 *   | /admin/task-packages | task_package:approve | 全局（角色授予；P10 新增） |
 *   | /admin/appeals | audit:read | 全局（can(user,'audit:read',null,db)） |
 *   | /flags | audit:read | 全局（复核队列） |
 *   | /publish | stage:compute | 全局（赛段发榜入口） |
 *
 * ⛔ **赛段级页面一律不列**（/review/prep、/review/:stageId、/publish/:stageId…）：
 *   评委的能力点可能是**赛段级授权**，前端无从判断 ⇒ 拦它就是误伤。
 * ⛔ 这张表**不是授权依据**（服务端 can() 才是）—— 它只决定「前端要不要提前说不行」。
 */
export const ROUTE_CAPABILITIES = {
  '/admin/registration': 'registration:review',
  '/admin/task-packages': 'task_package:approve',
  '/admin/appeals': 'audit:read',
  '/flags': 'audit:read',
  '/publish': 'stage:compute',
  // ⚠️ P11：破同分与公开令牌都要求 `stage:compute`（与 API 同口径 ⇒ 前后端一致）
  '/tiebreak': 'stage:compute',
  '/admin/public-links': 'stage:compute',
  // ⚠️ P11：审计日志页要求 `audit:read`（与 `/api/audit/log` 的**全局**能力点同口径）。
  //    ⛔ 注意 API 的形态：没有 `audit:read` 时它返回的是 **200 + 空集**（不是 403）
  //    —— 与 `/api/audit/flags`（复核队列）完全同款。
  //    ⇒ 前端**必须**声明这个能力点，否则没权限的人会看到一张「空空如也的审计表」，
  //    把「无权」误读成「没记录」（视图侧也据此显示「可能压根没权限」）。
  '/audit/log': 'audit:read',
  // ⚠️ E158：赛段配置页要求 `stage:compute`（与 API 同口径 ⇒ 前后端一致）。
  //    注意 API 侧的口径是「**届期级或赛段级**都放行」（routes/stages.js 的
  //    requireStageComputeForEdition）⇒ 前端声明的是能力点**名称**，
  //    真正的裁决在 API 层（前端拿不到「你是赛段级还是届期级授权」）。
  '/stages': 'stage:compute',
};

/** 路径归一：去掉 query 与结尾斜杠（'/flags/' 与 '/flags' 是同一个页面）。 */
function normalizePath(path) {
  const clean = String(path || '/').split('?')[0].split('#')[0];
  return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

/**
 * 这条路径需要的能力点（没声明 ⇒ null ⇒ 不拦）。
 * @param {string} path
 * @returns {string|null}
 */
export function requiredCapability(path) {
  const clean = normalizePath(path);
  return Object.prototype.hasOwnProperty.call(ROUTE_CAPABILITIES, clean)
    ? ROUTE_CAPABILITIES[clean]
    : null;
}

/** 取用户身上的能力点键数组（宽容处理各种形状）。 */
export function userCapabilities(user) {
  if (!user) return [];
  const raw = user.capabilities ?? user.capabilityKeys ?? [];
  if (Array.isArray(raw)) return raw.filter((c) => typeof c === 'string' && c);
  if (typeof raw === 'string') return raw ? [raw] : [];
  return [];
}

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
 * 当前用户能否访问某条路径（**登录态**这一关）。
 * ⚠️ **只判登录态**（理由见 PROTECTED_ROUTES 上方的设计红线）：
 *   角色/能力一律由 API 裁决 —— 前端按角色拦路会误伤「被直接授权」的人。
 *   fail-closed：没登录 ⇒ 不放行。
 *
 * ⚠️ 能力点那一关在 canReach()（W1-b · DP-105）：**按能力点声明**，不按角色硬编码。
 */
export function canAccess(path, user) {
  const guard = guardFor(path);
  if (!guard) return true;
  if (guard.auth && !user) return false;
  return true;
}

/**
 * 当前用户能不能**到达**某条路径（W1-b · DP-105 的分区级守卫）。
 *
 * 判定顺序（每一档的理由都写在下面）：
 *   ① 这条路径**没声明能力点** ⇒ 放行（不拦）——
 *      「前端无从判断就别拦」是本仓一贯的原则（赛段级页面同此）；
 *   ② 没登录 ⇒ 拦（沿用现有 canAccess 的口径：这三条路径都在 PROTECTED_ROUTES 里）；
 *   ③ 超管 ⇒ 直通（服务端 can() 也是这个口径）；
 *   ④ 服务端**没给能力点**（user.capabilities 不是数组）⇒ 放行 ——
 *      这个 user 对象不是 /api/me 的形状（演示适配器 / 旧缓存会话），
 *      前端手里**没有**能力点信息 ⇒ 拦它就是瞎猜（误伤）；
 *   ⑤ 能力点数组里有这条路径要的那一个 ⇒ 放行，否则拦。
 *
 * ⛔ **不按角色拦**：角色 ≠ 授权（见 PROTECTED_ROUTES 上方的设计红线）。
 * ⛔ **服务端仍然是唯一裁决者**：这里放行不代表能拿到数据（API 照样 403）。
 */
export function canReach(path, user) {
  const clean = normalizePath(path);
  const required = requiredCapability(clean);
  if (!required) return true;                          // ① 未声明能力点 ⇒ 不拦
  if (!user || !canAccess(clean, user)) return false;   // ② 未登录 ⇒ 拦
  if (user.isSuperadmin === true || user.is_superadmin === 1) return true; // ③ 超管直通
  const raw = user.capabilities;
  if (!Array.isArray(raw)) return true;                // ④ 前端无从判断 ⇒ 不拦
  return raw.includes(required);                      // ⑤ 能力点命中
}

/**
 * 路径对应的页面名（从 NAV_SECTIONS 里查；查不到 ⇒ null）。
 * ⚠️ 用于守卫页文案（「报名筛选台需要 registration:review 能力点」），
 *    免得把裸路径甩给用户看。
 */
export function routeLabel(path) {
  const clean = normalizePath(path);
  for (const sec of NAV_SECTIONS) {
    for (const item of sec.items) {
      if (item.path === clean) return item.label;
    }
  }
  return null;
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
 *
 * ⚠️ P10：**分区只按「角色」**（与既有语义一致）。
 *   曾试过给导航项加 `capabilities` 做能力点过滤，**已撤回** ——
 *   `signoff:create` 等能力点可以是**赛段级 / 届期级**授权，
 *   而 `/api/me` 的 capabilities 只回「全局授权 + 角色能力」
 *   ⇒ 按能力点过滤会把那类**有权限的人挡在菜单外**（误伤）。
 *   导航分区是**呈现**，授权的唯一裁决者是 API。
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
    <button type="button" class="btn btn--ghost btn--sm btn--icon" data-action="theme" aria-label="切换亮色 / 暗色主题">${iconTheme(16)}</button>
    ${user
      ? '<a class="btn btn--ghost btn--sm" href="#/logout">退出</a>'
      // ⚠️ 访客的「登录」用**描边**按钮，不用实底强调色：
      //    实底强调色留给「落地页那个唯一的主 CTA」（立即报名）——
      //    一屏两个实底强调按钮 ⇒ 强调色就不再指向任何东西了。
      : '<a class="btn btn--ghost btn--sm" href="#/login">登录</a>'}
  </div>`;

  return `<div class="topbar__inner">
    <a class="topbar__brand" href="#/">
      <span class="topbar__logo" aria-hidden="true">${iconLogo(18)}</span>
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
      <h2>${escapeHtml(c.name)}</h2>
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
  pageHead, panel, tabs, tableWrap, emptyRow, tone, friendlyError,
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

test('工作台：未登录也要有内容（首屏不能白屏）', async () => {
  // ⚠️ P9：总览（工作台）从 `/` 迁到 `/dashboard` 并**纳入登录守卫**
  //   （首页让位给落地页；工作台是「我的赛事」分区的一部分）。
  // ⇒ 访客看到的是**引导页**（需要登录 + 去登录），不是空白，也不是 401 报错。
  const dom = await bootApp('#/dashboard', { user: null }, 'home-anon');
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('需要登录'), `首屏必须说清「要登录」，实际：${html}`);
  assert.ok(html.includes('#/login'), '必须给出「去登录」这个可执行的下一步');
  assert.ok(html.includes('赛事') || html.includes('报名'), '首屏要有内容');
});

test('工作台：已登录才看到真正的仪表盘（反向对照：上一条不是恒绿）', async () => {
  const dom = await bootApp('#/dashboard', { user: { id: 'u_a', name: '甲', roles: ['member'] } }, 'home-authed');
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('工作台'), `已登录应看到工作台，实际：${html}`);
  assert.ok(!html.includes('需要登录'), '已登录不该看到引导页');
});

// ══════════════════════════════════════════════════════════════════
// 四、错误消息友好化（P7 浏览器实测：网络层失败把英文 TypeError 甩给用户）
// ══════════════════════════════════════════════════════════════════

test('错误友好化：浏览器网络层失败（Failed to fetch）⇒ 换成人话', () => {
  assert.equal(friendlyError(new TypeError('Failed to fetch')), '网络连接失败，请检查网络后重试');
  assert.equal(friendlyError(new TypeError('Load failed')), '网络连接失败，请检查网络后重试');
  assert.equal(friendlyError('Failed to fetch'), '网络连接失败，请检查网络后重试');
});

test('错误友好化：业务错误原样透出（不洗成通用话术）', () => {
  assert.equal(friendlyError(new Error('未登录')), '未登录');
  assert.equal(friendlyError(new Error('战队不存在')), '战队不存在');
});

test('错误友好化：没有消息时用兜底文案（不许出现 undefined / null）', () => {
  assert.equal(friendlyError(undefined), '加载失败，请重试');
  assert.equal(friendlyError(new Error('')), '加载失败，请重试');
  assert.equal(friendlyError(new Error('undefined')), '加载失败，请重试');
});

test('错误态：错误消息过一遍友好化（唯一出口 ⇒ 11 个视图都受益）', () => {
  const html = errorState({ message: new TypeError('Failed to fetch') });
  assert.ok(html.includes('网络连接失败，请检查网络后重试'));
  assert.ok(!html.includes('Failed to fetch'), '不能把英文技术错误透给用户');
  assert.ok(html.includes('data-action="retry"'), '错误态必须有重试按钮');
});

// ══════════════════════════════════════════════════════════════════
// 五、总览页的请求口径（端到端：看真实发出了哪些请求）
// ══════════════════════════════════════════════════════════════════

test('总览页：未登录不请求需要登录态的 /api/teams', async () => {
  const dom = await bootApp('#/dashboard', { user: null }, 'home-no-teams');
  assert.ok(
    !dom.calls.some((c) => c.includes('/api/teams')),
    `未登录不该请求 /api/teams，实际：${JSON.stringify(dom.calls)}`,
  );
});

test('总览页：已登录才请求 /api/teams（反向对照：上一条不是恒绿）', async () => {
  const dom = await bootApp('#/dashboard', { user: { id: 'u_a', name: '甲', roles: ['member'] } }, 'home-teams');
  assert.ok(
    dom.calls.some((c) => c.includes('/api/teams')),
    `已登录必须请求 /api/teams，实际：${JSON.stringify(dom.calls)}`,
  );
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
  // P9：落地页的赛制数据源（公开、免 token）
  // ⚠️ 形状必须与真实后端一致 ⇒ 演示适配器**复用同一个领域层函数**
  //    （src/domain/event-info.js），不可能漂移。
  { method: 'GET', path: '/api/event-info' },
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
  // P8：评审打分页与赛段发榜页用到的三个端点
  { method: 'GET', path: '/api/stages/stage_final/review-board' },
  { method: 'GET', path: '/api/stages/stage_final/review-state' },
  {
    method: 'POST',
    path: '/api/stages/stage_final/reviews',
    // ⚠️ **body 里没有 judgeId** —— 真实后端从**会话**取评委（P8 修正演示适配器时发现的形状不一致）
    body: { items: [{ teamId: 't_alpha', dimension: 'innovation', rawScore: 90 }] },
  },
  // ── P10：四个新页面用到的端点 ────────────────────────────────────
  // ⚠️ **P10 漏了一组**：企业签字台的两个读口（/api/signoffs/mine 与
  //    /api/stages/:stageId/enterprise-confirmations）在演示适配器里**压根没实现**
  //    ⇒ 公网演示站那页是两块错误卡片 ⇒ 正是「只做了展示、点不动」的形态。
  //    ⇒ 下面这组端点全部进闸，以后新增页面漏端点会被**立刻**抓住。
  { method: 'GET', path: '/api/teams' },
  // 评委前置（回避 / 互评 / 自评 / 校准）
  { method: 'GET', path: '/api/stages/stage_final/recusals' },
  { method: 'POST', path: '/api/stages/stage_final/recusals', body: { reason: '演示回避' } },
  { method: 'POST', path: '/api/stages/stage_final/peer-reviews', body: { items: [] } },
  { method: 'POST', path: '/api/stages/stage_final/self-review', body: { items: [] } },
  { method: 'POST', path: '/api/stages/stage_final/calibration', body: { items: [] } },
  // 企业签字台（里程碑签字 + 企业双签）
  { method: 'GET', path: '/api/signoffs/mine' },
  { method: 'GET', path: '/api/stages/stage_final/enterprise-confirmations' },
  {
    method: 'POST',
    path: '/api/milestones/ms_t_alpha_problem_confirmed/signoff',
    body: { department: '业务部', content: '演示签字内容' },
  },
  {
    method: 'POST',
    path: '/api/milestones/ms_t_alpha_problem_confirmed/signoff/withdraw',
    body: { signoffId: 'so_1' },
  },
  {
    method: 'POST',
    path: '/api/stages/stage_final/enterprise-confirmations',
    body: {
      teamId: 't_alpha',
      dimension: 'enterprise',
      rawScore: 80,
      crossJudgeId: 'j_lenient',
      content: '演示企业确认',
    },
  },
  // 任务卡审批（六维评估 + 签级 / 退回）
  { method: 'GET', path: '/api/task-packages' },
  {
    method: 'POST',
    path: '/api/task-packages/tp_retail/solvability',
    body: {
      dimensions: [
        { key: 'problem_real', score: 4 },
        { key: 'data_ready', score: 4 },
        { key: 'demoable', score: 4 },
        { key: 'deliverable', score: 4 },
        { key: 'acceptance', score: 4 },
        { key: 'reward', score: 4 },
      ],
    },
  },
  { method: 'POST', path: '/api/task-packages/tp_retail/approve', body: { grade: 'A' } },
  // 申诉裁决
  { method: 'GET', path: '/api/appeals' },
  {
    method: 'POST',
    path: '/api/appeals/ap_demo_1/decide',
    body: { decision: 'accepted', note: '演示裁决' },
  },
  // ── P11：审计日志页 / 发榜 / 破同分 / 公开令牌 ─────────────────────
  // ⚠️ P11 漏了审计日志页 —— `GET /api/audit/log` 端点虽然实现了，
  //    但**没有任何写方** ⇒ 演示站上那页永远是空表（页面接上了却什么也看不到）。
  { method: 'GET', path: '/api/audit/log' },
  { method: 'GET', path: '/api/stages/stage_final/publish' },
  { method: 'GET', path: '/api/stages/stage_final/tiebreak/rounds' },
  { method: 'GET', path: '/api/public/tokens' },
  // ── E158：赛段配置页（设计 §9「赛段配置与权重表」）────────────────
  // ⚠️ 这组端点是「赛段配置」页的**全部**数据来源：
  //    届期 / 候选队伍 / 评委候选池 / 权重表 + 赛段读口。
  //    演示适配器漏一个 ⇒ 公网演示站那页就有一块是 404。
  { method: 'GET', path: '/api/editions' },
  { method: 'GET', path: '/api/editions/ed_demo/teams' },
  { method: 'GET', path: '/api/editions/ed_demo/judge-candidates' },
  { method: 'GET', path: '/api/editions/ed_demo/scoring-configs' },
  { method: 'GET', path: '/api/stages/stage_final/judges' },
  { method: 'GET', path: '/api/stages/stage_final/teams' },
  { method: 'POST', path: '/api/editions/ed_demo/stages', body: { key: 's_demo', name: '演示赛段', kind: 'initial', scoringConfigKey: 'initial' } },
  { method: 'POST', path: '/api/stages/stage_final/judges', body: { userId: 'j_lenient', seat: 'judge' } },
  { method: 'POST', path: '/api/stages/stage_final/teams', body: { teamIds: ['t_alpha'] } },
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

test('演示适配器的赛事规则（落地页）：形状与真实后端**逐字段一致**', async () => {
  // ⚠️ P8 的教训：parity 闸不能只覆盖「端点存在」，必须覆盖**形状** ——
  //    演示适配器曾把「错误的形状」锁进测试（body 里传 judgeId、进度按评委分组）。
  const { api, rules } = await bootDemo();
  const got = await api.get('/api/event-info');
  const { buildEventInfo } = await import('../src/domain/event-info.js');
  // ⚠️ 两边**必须逐字段相同**：演示站与正式站复用同一个领域层函数
  //    ⇒ 落地页上显示的赛制不可能两边不一样。
  assert.deepEqual(got, buildEventInfo(rules), '演示站的赛制投影与真实后端必须逐字段一致');
  assert.ok(got.stages.length > 0, '必须有赛段');
  assert.ok(got.scoring.initial.dimensions.length > 0, '必须有初赛权重表');
  assert.ok(got.tiers.length > 0, '必须有段位表');
});

test('演示适配器的赛事规则：⛔ 不得夹带内部备注（白名单投影）', async () => {
  const { api } = await bootDemo();
  const got = await api.get('/api/event-info');
  const dumped = JSON.stringify(got);
  assert.ok(!dumped.includes('待组委会确认'), '内部待确认状态不得进公开响应');
  assert.ok(!dumped.includes('note'), '内部说明字段不得出现');
  assert.ok(!dumped.includes('awardPointsNote'), '内部口径说明不得出现');
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

// ══════════════════════════════════════════════════════════════════
// 演示运行时的**可恢复性**（P7 浏览器实测踩到的真事故）
// ══════════════════════════════════════════════════════════════════
//
// ⚠️ 事故还原：
//   演示站重新发布时，nginx 会在那一瞬间短暂拿不到静态文件 ⇒ 首次 fetch 失败。
//   原实现把**被 reject 的 promise** 存进模块级 runtimePromise ⇒
//   之后**每一次**调用都抛同一个错 ⇒ 整个演示站永久瘫痪；
//   而且错误态里那个「重试」按钮点了也永远不会好（重试的是同一份坏 promise）。
//   ⇒ 失败必须**不缓存**，下一次调用重新加载。

/**
 * 假的 fetch：把演示站要的资源（种子 + 13 份规则）从本地磁盘读出来。
 * @param {boolean} failFirst  第一次调用是否抛网络错误
 */
function makeDemoFetch(failFirst) {
  const rulesDir = join(here, '..', 'rules');
  const seedFile = join(webDir, 'seed', 'demo-data.json');
  let failed = false;
  return async (url) => {
    const u = String(url);
    if (failFirst && !failed) {
      failed = true;
      throw new TypeError('Failed to fetch');   // 浏览器网络层失败的原文
    }
    const file = u.split('/').pop();
    const path = u.includes('/rules/') ? join(rulesDir, file) : seedFile;
    const body = readFileSync(path, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
}

test('演示运行时：一次加载失败不能把 promise 永久缓存住（否则「重试」永远无效）', async () => {
  // ⚠️ 用带 query 的 import 拿一个**全新的模块实例**（Node ESM 按 URL 缓存），
  //    避免别的用例已经把成功的运行时缓存进模块级变量。
  const mod = await import(`../web/api.demo.js?rt=${Date.now()}`);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = makeDemoFetch(true);
    // 第一次：应当失败，但错误必须是**中文人话**（不能把英文 TypeError 甩给用户）
    await assert.rejects(
      () => mod.getDemoRuntime(),
      (err) => {
        assert.ok(
          !/Failed to fetch/.test(err.message),
          `不能把英文技术错误透给用户：${err.message}`,
        );
        assert.ok(/无法连接服务器/.test(err.message), `错误要说明发生了什么：${err.message}`);
        return true;
      },
    );
    // 第二次：网络恢复后必须**能成功**（这正是「失败不缓存」的可观测证据）
    globalThis.fetch = makeDemoFetch(false);
    const runtime = await mod.getDemoRuntime();
    assert.ok(runtime, '网络恢复后必须能拿到运行时');
    assert.equal(typeof runtime.get, 'function');
  } finally {
    globalThis.fetch = original;
  }
});

test('演示运行时：并发调用共享同一次加载（不该打 N 次请求）', async () => {
  const mod = await import(`../web/api.demo.js?rt=rt-${Date.now()}`);
  const original = globalThis.fetch;
  try {
    let count = 0;
    globalThis.fetch = async (url) => {
      count += 1;
      return makeDemoFetch(false)(url);
    };
    await mod.getDemoRuntime();
    const oneCall = count;            // 单次加载的资源数（1 份种子 + 13 份规则 = 14）
    assert.ok(oneCall >= 2, '资源数不该只有 1 个（否则说明规则没加载）');

    count = 0;
    const [a, b] = await Promise.all([mod.getDemoRuntime(), mod.getDemoRuntime()]);
    assert.equal(a, b, '并发调用必须拿到同一个运行时');
    assert.equal(count, 0, '已缓存的运行时不该再发请求');
    assert.ok(oneCall <= 20, `资源数异常：${oneCall}`);
  } finally {
    globalThis.fetch = original;
  }
});

// ══════════════════════════════════════════════════════════════════
// P8：评审工作台的**形状**必须与真实后端逐字段一致
// ══════════════════════════════════════════════════════════════════

test('演示适配器的评审工作台：形状与真实后端 getReviewBoard 一致', async () => {
  const { api } = await bootDemo();
  const b = await api.get('/api/stages/stage_final/review-board');
  assert.ok(b.stage?.id, '必须有赛段摘要');
  assert.ok(typeof b.stage.name === 'string');
  assert.ok(typeof b.stage.scoringConfigKey === 'string');
  assert.ok(Array.isArray(b.dimensions) && b.dimensions.length > 0, '必须有维度表');
  assert.ok(b.dimensions.every((d) => typeof d.key === 'string' && typeof d.name === 'string'));
  assert.ok(b.dimensions.every((d) => typeof d.weight === 'number'), '维度必须带权重');
  assert.ok(Array.isArray(b.judgeDimensions), '必须有评委席维度');
  assert.ok(b.judgeDimensions.every((d) => d.seat === 'judge'), '评委席维度不能混进企业席');
  assert.ok(Array.isArray(b.teams) && b.teams.length > 0, '必须有赛段名册');
  assert.ok(b.teams.every((t) => typeof t.id === 'string' && typeof t.name === 'string'), '名册必须带队名');
  assert.ok(Array.isArray(b.myScores), '必须有 myScores 数组');
  assert.ok(typeof b.progress.total === 'number', '进度必须有 total');
  assert.ok(Array.isArray(b.progress.missing), '进度必须有 missing');
  assert.ok(b.progress.scope === 'mine' || b.progress.scope === 'stage', '进度必须标明口径（mine / stage）');
  assert.ok(b.progress.dimensionProgress && typeof b.progress.dimensionProgress === 'object');
});

test('演示适配器的评审进度：dimensionProgress 按**维度**分组（不是按评委）', async () => {
  const { api } = await bootDemo();
  const st = await api.get('/api/stages/stage_final/review-state');
  assert.equal(typeof st.total, 'number', '必须有 total（真实后端有，演示原来没有）');
  assert.ok(Array.isArray(st.missing), '必须有 missing');
  for (const [dim, v] of Object.entries(st.dimensionProgress ?? {})) {
    assert.ok(
      typeof v === 'object' && typeof v.submitted === 'number' && typeof v.total === 'number',
      `维度 ${dim} 的进度必须是 {submitted, total}（真实后端的形状），实际：${JSON.stringify(v)}`,
    );
  }
});

test('演示适配器：打分走**会话**里的评委（body 里没有 judgeId 也能记上）', async () => {
  const { api } = await bootDemo();
  const before = await api.get('/api/stages/stage_final/review-board');
  const res = await api.post('/api/stages/stage_final/reviews', {
    items: [{ teamId: 't_alpha', dimension: 'innovation', rawScore: 90 }],
  });
  assert.equal(res.submitted, 1);
  assert.ok(res.judgeId, '必须回显评委（来自会话）');
  const after = await api.get('/api/stages/stage_final/review-board');
  assert.ok(
    after.myScores.some((s) => s.dimension === 'innovation' && s.rawScore === 90),
    '打的那一分必须出现在 myScores 里（否则前端「提交成功但进度不涨」）',
  );
  assert.ok(after.progress.submitted > before.progress.submitted, '进度必须涨');
});
```

---

### `platform/web/views/home.js`

`platform/web/views/home.js`：

```javascript
// web/views/home.js — 总览页（赛事总览）
// 溯源需求：P7「现有页面打磨到生产级」
//
// ⚠️ **为什么首页要单独成文件**（而不是继续待在 web/app.js 里）：
//   P7 打磨前，首页的三个关键判断全埋在 app.js 的异步闭包里：
//     ①「未登录时两个指标会不会错位」②「榜单行的名次和积分取哪个字段」
//     ③「入口卡里的链接是不是死链」
//   这三条**全是可复算的判据**，但藏起来就只能靠人点页面发现
//   （P7 实测就真的漏掉了两处：指标错位 + 一个指向不存在路由的「报名入口」按钮）。
//   ⇒ 把「数据 → 卡片/行」的映射抽成**纯函数**导出，
//      app.js 只负责挂路由 ⇒ platform/test/web-home.test.js 能对**结果本身**断言。
//
// ⛔ 纯逻辑与 IO 分离：本文件的三个导出（homeKpiCards / homeBoardHtml / homeEntryCards）
//    都是纯函数（无 IO、无 DOM），可直接被 node:test 断言。
import { emptyState, errorState, friendlyError, loadingState, pageHead, statRow } from '../ui.js';
import { escapeHtml } from '../escape.js';

/**
 * 首页指标卡：**形状固定**的序列。
 *
 * ⚠️ 这里踩过的坑（P7 实测）：
 *   原来的写法是「未登录就不往数组里 push」，然后
 *   `const [teamCount, boardCount] = await Promise.all(jobs)` ——
 *   数组长度一变，**解构位置就变了**：
 *   未登录时 teamCount 拿到的是**榜单数**、boardCount 变成 undefined，
 *   而两张卡的标签还写着「参赛队伍 / 在榜队伍」⇒ 数字与标签**对不上**。
 *   ⇒ ① 标签按登录态决定**是否出现**；② 缺失值用 null 占位而不是少一个元素。
 *
 * @param {object}  input
 * @param {object|null} input.user        当前登录用户（null = 访客）
 * @param {boolean} input.isAdmin         是否组委会身份
 * @param {number|null} input.teamCount   「GET /api/teams」= **我参与的战队**的条数
 * @param {number|null} input.boardCount  滚动总榜的条数
 * @returns {Array<{label:string,value:string|number,tone:string}>}
 */
export function homeKpiCards({ user = null, isAdmin = false, teamCount = null, boardCount = null } = {}) {
  const cards = [];
  // ⚠️ 标签必须写「我的队伍」：`GET /api/teams` 返回的是**我参与的战队**（不是全场队伍），
  //    写「参赛队伍」= 口径撒谎。
  if (user) cards.push({ label: '我的队伍', value: teamCount === null ? '—' : teamCount, tone: 'brand' });
  cards.push({ label: '在榜队伍', value: boardCount === null ? '—' : boardCount, tone: 'success' });
  cards.push({ label: '我的身份', value: user ? (isAdmin ? '组委会' : '参赛者') : '访客' });
  return cards;
}

/**
 * 首页「滚动总榜 · 前五」的行。
 *
 * ⚠️ 字段口径（P7 实测出的真 bug）：
 *   滚动总榜的行字段是 `points`（全赛段累计积分），而且**没有 `rank`、没有 `total`** ——
 *   src/services/leaderboard.js 的 getRollingLeaderboard 与演示适配器形状**一致**。
 *   原实现写的是 `r.rank` 和 `r.total` ⇒ 首页每一行都渲染成「. 队名」+「分」（两个空值），
 *   正式平台和演示站**同时**中招。
 *   ⇒ 名次按返回顺序（后端已按积分降序）自己编号；积分取 points。
 *
 * @param {Array<object>} rows  滚动总榜行
 * @returns {string}             HTML 片段
 */
export function homeBoardHtml(rows) {
  const list = (rows ?? []).slice(0, 5);
  if (!list.length) {
    return emptyState({ title: '榜单还没有数据', hint: '等组委会完成首个赛段的计算与发榜。' });
  }
  return `<ul class="list-divided">${list.map((r, i) => `<li class="row row--between">
      <span>${i + 1}. ${escapeHtml(r.teamName || r.teamId)}</span>
      <span class="num">${escapeHtml(r.points ?? r.total ?? '—')} 分</span>
    </li>`).join('')}</ul>`;
}

/**
 * 首页入口卡：按身份分区，只显示当前身份用得上的入口。
 *
 * ⚠️ **每个 href 必须是真实存在的路由**（P7 实测出的真 bug）：
 *   「开始参赛」里的「报名入口」原来写的是 `#/register`，
 *   而路由表里根本没有 `/register`（报名页是 `/apply`）⇒ 点了就是「页面不存在」。
 *   ⇒ platform/test/web-home.test.js 有一条**死链闸**：拿路由表逐一比对这里的 href。
 *
 * @param {object} input
 * @param {object|null} input.user
 * @param {boolean} input.isAdmin
 * @returns {Array<{title:string,desc:string,links:Array<{href:string,label:string}>}>}
 */
export function homeEntryCards({ user = null, isAdmin = false } = {}) {
  const entries = [];
  if (user) {
    entries.push({ title: '我的赛事', desc: '报名、战队与任务领取', links: [
      { href: '#/apply', label: '去报名' },
      { href: '#/team', label: '我的战队' },
      { href: '#/tasks', label: '任务清单' },
    ] });
  } else {
    entries.push({ title: '开始参赛', desc: '先登录，再报名组队', links: [
      { href: '#/login', label: '登录' },
      { href: '#/apply', label: '报名入口' },
    ] });
  }
  entries.push({ title: '赛事公开信息', desc: '首页、榜单与段位，无需登录', links: [
    { href: '#/', label: '赛事首页' },
    { href: '#/leaderboard', label: '看榜单' },
    { href: '#/tier', label: '段位榜' },
  ] });
  if (isAdmin) {
    entries.push({ title: '组委会工作台', desc: '筛选、复核与发榜留痕', links: [
      { href: '#/admin/registration', label: '报名筛选台' },
      { href: '#/flags', label: '复核队列' },
    ] });
  }
  return entries;
}

/** 入口卡 HTML。 */
export function homeEntryCardsHtml(entries) {
  // ⚠️ **标题层级**：pageHead() 已经给了 h1，这里再用 h3 会造成 h1 → h3 跳级
  //    （读屏用户按 H 键导航时会「跳过 H2」，层级失真）。
  //    ⇒ 入口卡是 h1 下的**同级区块**，用 h2。
  return (entries ?? []).map((e) => `
      <article class="card home__entry">
        <h2>${escapeHtml(e.title)}</h2>
        <p class="muted small">${escapeHtml(e.desc)}</p>
        <div class="btn-group">
          ${e.links.map((l) => `<a class="btn btn--ghost btn--sm" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join('')}
        </div>
      </article>`).join('');
}

/**
 * 总览页视图。
 *
 * ⚠️ **同步渲染问候语，异步补数据**：
 *   首屏必须**立刻**有内容（骨架屏也行），否则弱网下是白屏；
 *   同时问候语不依赖任何请求 ⇒ 不会因为接口慢而看不到「你是谁」。
 *
 * @param {object} ctx  应用上下文（{ api, navigate, setState, getState }）
 * @returns {HTMLElement}
 */
export function renderHome(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'home';
  const { user } = ctx.getState();
  const isAdmin = user?.isSuperadmin === true || (user?.roles ?? []).includes('admin');

  wrap.innerHTML = `
    ${pageHead({
      title: '赛事工作台',
      // ⚠️ P10：`pageHead` 的 `sub` 会**转义**（防 XSS）⇒ 这里**不能塞 HTML**。
      //    原来写的是「…说明在<a href="#/">首页</a>。」⇒ 页面上直接显示出一段
      //    `<a href="#/">首页</a>` 的**字面文本**（真机截图证据）。
      //    ⇒ 链接改走 `actions`（那里本来就是渲染 <a> 的地方），`sub` 只放纯文本。
      sub: '报名、战队、赛段、榜单都在这里。赛事介绍与赛制说明在首页。',
      actions: [{ href: '#/', label: '看赛事首页' }],
    })}
    <section class="panel">
      <div class="panel__body">
        <p class="home__hello">${user
          ? `已登录：<strong>${escapeHtml(user.name || '')}</strong>`
          : '<span class="muted">未登录</span> —— <a href="#/login">登录</a>后可报名、组队、领任务'}</p>
        <div class="home__kpi" id="home-kpi">${loadingState({ rows: 1, label: '正在汇总赛事数据…' })}</div>
      </div>
    </section>
    <section class="grid grid--3" id="home-entries"></section>
    <section class="panel" id="home-board-panel">
      <div class="panel__head"><h2 class="panel__title">滚动总榜 · 前五</h2>
        <p class="panel__desc">按全赛段累计积分排名</p></div>
      <div class="panel__body" id="home-board"></div>
    </section>`;

  const entryBox = wrap.querySelector('#home-entries');
  if (entryBox) entryBox.innerHTML = homeEntryCardsHtml(homeEntryCards({ user, isAdmin }));

  const kpiBox = wrap.querySelector('#home-kpi');
  const boardBox = wrap.querySelector('#home-board');

  /**
   * 加载滚动总榜并画进面板；失败时给出**能点的重试**。
   * @returns {Promise<object|null>} 成功返回原始数据，失败返回 null
   */
  const loadBoard = async () => {
    if (!boardBox) return null;
    try {
      const data = await ctx.api.get('/api/leaderboard/rolling');
      boardBox.innerHTML = homeBoardHtml(data.rows ?? []);
      return data;
    } catch (e) {
      boardBox.innerHTML = errorState({
        message: friendlyError(e),
        hint: '榜单读不到不影响其它功能，可以重试。',
      });
      // ⚠️ 重试按钮必须**真的能点**：不绑定就是死路一条（打磨前 11 个页面的真实状态）。
      boardBox.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
        void loadBoard();
      });
      return null;
    }
  };

  // 异步补 KPI + 榜单（失败不阻塞首屏）
  // ⚠️ 滚动总榜**只请求一次**：KPI 的「在榜队伍」与下面的「前五」是同一份数据，
  //    请求两次既浪费，又可能两次拿到不同结果（KPI 与榜单对不上）。
  (async () => {
    // ⚠️ 两个数的**形状必须固定**：未登录时 `/api/teams` 不该发（它要登录态），
    //    但若用「少 push 一个元素」来表达「没有这个数」，
    //    `const [teamCount, boardCount] = await Promise.all(...)` 就会**错位**。
    //    ⇒ 未登录时用 Promise.resolve(null) 占位，标签由 homeKpiCards 按登录态决定。
    const teamCountP = user
      ? ctx.api.get('/api/teams').then((r) => (r.items ?? []).length).catch(() => null)
      : Promise.resolve(null);
    const rollingP = loadBoard();

    const [teamCount, rolling] = await Promise.all([teamCountP, rollingP]);
    const boardCount = rolling ? (rolling.rows ?? []).length : null;
    if (kpiBox) kpiBox.innerHTML = statRow(homeKpiCards({ user, isAdmin, teamCount, boardCount }));
  })().catch(() => { /* 静默：首屏问候语已经在了 */ });

  return wrap;
}
```

### `platform/test/web-home.test.js`

`platform/test/web-home.test.js`：

```javascript
// platform/test/web-home.test.js —— 总览页（赛事总览）的行为闸
//
// 规则溯源：
//   - 「页面打磨到生产级（视觉 / 交互 / 信息密度）」→ P7
//   - 「错误态必须带真的能点的重试」→ P7 DP-80
//   - 「可见性在 API 层过滤」→ 全局约束（前端只判登录态，不按角色拦路）
//
// ⚠️ 本文件为什么存在（P7 浏览器实测逼出来的）：
//   首页打磨后的第一版在**真实浏览器**里暴露了三个肉眼容易漏、但用户一定看得见的缺陷：
//     ① 未登录时两个指标**错位**（「参赛队伍」显示的其实是榜单数）；
//     ② 榜单每一行渲染成「. 队名」+「分」（名次与积分两个空值）；
//     ③ 「报名入口」按钮指向 `#/register`——**路由表里根本没有这个路由**。
//   这三条如果只靠人点页面发现，下一轮改版大概率复发 ⇒ 全部变成**可复算的机器闸**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  homeKpiCards, homeBoardHtml, homeEntryCards, homeEntryCardsHtml, renderHome,
} from '../web/views/home.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const APP_JS = readFileSync(join(webDir, 'app.js'), 'utf8');
const NAV_JS = readFileSync(join(webDir, 'nav.js'), 'utf8');
const HOME_JS = readFileSync(join(webDir, 'views', 'home.js'), 'utf8');

/** 路由表：从 app.js 的 route('...') 调用点**扫出来**（手写清单会漏）。 */
const ROUTES = [...APP_JS.matchAll(/route\(\s*'([^']+)'/g)].map((m) => m[1]);

/** 路由模式匹配（支持 :param 段）。 */
function routeMatches(pattern, path) {
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return false;
  return pp.every((seg, i) => seg.startsWith(':') || seg === xp[i]);
}

/** 某个 hash 链接（#/xxx）有没有对应的路由。 */
function hasRoute(hashPath) {
  const clean = hashPath.replace(/^#/, '').replace(/\?.*$/, '');
  return ROUTES.some((r) => routeMatches(r, clean));
}

// ══════════════════════════════════════════════════════════════════
// 一、指标卡：形状固定 + 标签与值不得错位
// ══════════════════════════════════════════════════════════════════

test('首页指标卡：未登录只有 2 张卡（不显示「我的队伍」）', () => {
  const cards = homeKpiCards({ user: null, teamCount: null, boardCount: 5 });
  assert.equal(cards.length, 2, '未登录不该出现「我的队伍」卡');
  assert.deepEqual(cards.map((c) => c.label), ['在榜队伍', '我的身份']);
  assert.equal(cards[0].value, 5);
  assert.equal(cards[1].value, '访客');
});

test('首页指标卡：登录后 3 张卡，且「在榜队伍」的值**不是**队伍数', () => {
  const cards = homeKpiCards({ user: { name: '张三' }, teamCount: 2, boardCount: 7 });
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.label), ['我的队伍', '在榜队伍', '我的身份']);
  assert.equal(cards[0].value, 2, '「我的队伍」= /api/teams 的条数');
  assert.equal(cards[1].value, 7, '「在榜队伍」= 滚动总榜的条数');
  assert.equal(cards[2].value, '参赛者');
});

test('首页指标卡：组委会身份显示「组委会」而不是「参赛者」', () => {
  const cards = homeKpiCards({ user: { roles: ['admin'] }, isAdmin: true, boardCount: 3 });
  assert.equal(cards.at(-1).value, '组委会');
});

test('首页指标卡：取不到数时用「—」占位（不是 undefined）', () => {
  const cards = homeKpiCards({ user: { name: '张三' }, teamCount: null, boardCount: null });
  assert.equal(cards[0].value, '—');
  assert.equal(cards[1].value, '—');
  assert.ok(!cards.some((c) => c.value === undefined), '不许出现 undefined');
});

test('首页指标卡：标签不得写成「参赛队伍」（/api/teams 返回的是**我的**战队）', () => {
  const cards = homeKpiCards({ user: { name: '张三' }, teamCount: 1, boardCount: 1 });
  assert.ok(!cards.some((c) => c.label === '参赛队伍'), '口径撒谎：/api/teams 是我的战队');
});

// ══════════════════════════════════════════════════════════════════
// 二、滚动总榜：字段口径
// ══════════════════════════════════════════════════════════════════

test('首页榜单：行没有 rank / total 字段时，名次按序编号、积分取 points', () => {
  // ⚠️ 这就是滚动总榜的真实形状（getRollingLeaderboard 与演示适配器一致）
  const rows = [
    { teamId: 't_alpha', teamName: '拾光队', points: 88, stages: 2, bestRank: 1, tier: 'A' },
    { teamId: 't_beta', teamName: '回声队', points: 61, stages: 2, bestRank: 3, tier: 'B' },
  ];
  const html = homeBoardHtml(rows);
  assert.ok(html.includes('>1. 拾光队<'), '第一名必须渲染成「1. 拾光队」');
  assert.ok(html.includes('2. 回声队'));
  assert.ok(html.includes('88 分'), '积分取 points');
  assert.ok(html.includes('61 分'));
  assert.ok(!/(^|[^0-9])\. 拾光队/.test(html), '不能渲染成「. 队名」（名次字段不存在时的经典症状）');
  assert.ok(!/>\s*分</.test(html), '不能渲染成空积分');
});

test('首页榜单：积分口径钉死 —— points 优先（total 不能盖掉它）', () => {
  // ⚠️ 变异检验实测：只断言「行里有 points 时显示 points」**杀不掉**
  //    「points / total 两个字段顺序颠倒」的变异体（滚动总榜的行根本没有 total
  //    ⇒ 两种写法结果一样 ⇒ 判据太弱，不是等价变异体）。
  //    ⇒ 这里显式给一行**同时有** points 与 total 的数据，把优先级钉死。
  const html = homeBoardHtml([{ teamId: 't_x', teamName: '双字段队', points: 88, total: 999 }]);
  assert.ok(html.includes('88 分'), 'points 是滚动总榜的积分口径 ⇒ 必须优先');
  assert.ok(!html.includes('999 分'), 'total 不能盖掉 points');
});

test('首页榜单：行没有 points 字段时才退回 total', () => {
  const html = homeBoardHtml([{ teamId: 't_y', teamName: '老口径队', total: 42 }]);
  assert.ok(html.includes('42 分'), '兼容老口径');
});

test('首页榜单：最多只显示前五', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ teamId: `t${i}`, teamName: `队${i}`, points: 100 - i }));
  const html = homeBoardHtml(rows);
  assert.equal((html.match(/<li/g) || []).length, 5);
});

test('首页榜单：空数据给空态（说清什么时候会有）', () => {
  const html = homeBoardHtml([]);
  assert.ok(html.includes('榜单还没有数据'));
  assert.ok(html.includes('发榜'), '空态必须说清什么时候会有数据');
});

test('首页榜单：队名里的 HTML 必须转义（服务端数据是外部输入）', () => {
  const html = homeBoardHtml([{ teamId: 'x', teamName: '<img src=x onerror=alert(1)>', points: 1 }]);
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
  assert.ok(html.includes('&lt;img'));
});

// ══════════════════════════════════════════════════════════════════
// 三、死链闸：入口卡与导航里的每个 href 都必须对应真实路由
// ══════════════════════════════════════════════════════════════════

test('死链闸：首页入口卡的每个 href 都对应真实路由', () => {
  const cases = [
    { user: null, isAdmin: false },
    { user: { name: '张三' }, isAdmin: false },
    { user: { roles: ['admin'] }, isAdmin: true },
  ];
  for (const c of cases) {
    const entries = homeEntryCards(c);
    for (const e of entries) {
      for (const l of e.links) {
        assert.ok(
          hasRoute(l.href),
          `死链：${e.title} → ${l.label} 指向 ${l.href}，但路由表里没有（现有路由：${ROUTES.join(', ')}）`,
        );
      }
    }
  }
});

test('死链闸：主导航的每个 path 都对应真实路由', () => {
  const paths = [...NAV_JS.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 6, '导航里应该有 6 条以上的路径（漏扫说明正则失效）');
  for (const p of paths) {
    assert.ok(hasRoute(p), `死链：导航项 ${p} 没有对应路由`);
  }
});

test('死链闸：路由表必须含首页与报名页（防扫描正则失效导致闸变空转）', () => {
  assert.ok(ROUTES.includes('/'), '必须有首页路由');
  assert.ok(ROUTES.includes('/apply'), '必须有报名页路由');
  assert.ok(ROUTES.length >= 10, `路由表只扫到 ${ROUTES.length} 条，正则可能失效`);
});

// ══════════════════════════════════════════════════════════════════
// 四、结构闸：首页必须走独立视图，且不能自己造路由表
// ══════════════════════════════════════════════════════════════════

test('结构闸：首页逻辑在 views/home.js 里，app.js 只负责挂路由', () => {
  assert.ok(
    /import \{ renderHome \} from '\.\/views\/home\.js'/.test(APP_JS),
    'app.js 必须从 views/home.js 引入总览视图',
  );
  // ⚠️ P9：总览（工作台）从 `/` 迁到了 `/dashboard` —— `/` 让位给落地页。
  //    断言要跟着改：**两条路由都要把上下文透传给视图**
  //    （否则 ctx.api 为 undefined，页面直接崩）。
  assert.ok(
    /route\('\/dashboard',\s*\(\w+\)\s*=>\s*renderHome\(\w+\)\)/.test(APP_JS),
    '工作台路由必须把上下文透传给视图（否则 ctx.api 为 undefined，页面直接崩）',
  );
  assert.ok(
    /route\('\/',\s*\(\w+\)\s*=>\s*renderLanding\(\w+\)\)/.test(APP_JS),
    '落地页必须挂在 / 并透传上下文',
  );
  assert.ok(!/function renderHome/.test(APP_JS), 'app.js 不该再自带一份 renderHome（两份实现 = 迟早走偏）');
});

test('结构闸：首页不得引用滚动总榜里**不存在**的 rank 字段', () => {
  // ⚠️ 只扫**代码**：注释里会写「原实现写的是 r.rank」来解释坑，
  //    连注释一起扫会把「说明问题的文字」当成「问题本身」。
  const code = HOME_JS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\br\.rank\b/.test(code), '滚动总榜没有 rank 字段（名次要按序自己编号）');
});

// ══════════════════════════════════════════════════════════════════
// 六、请求口径（视图层隔离断言）
// ══════════════════════════════════════════════════════════════════

/**
 * 最小 DOM 桩：够 renderHome 跑起来。
 * ⚠️ 为什么在**视图层**断言请求次数，而不是在 app.js 层：
 *   app.js 层每次 import 都会往**同一个** router 模块里追加一份路由，
 *   多个测试实例会互相触发渲染 ⇒ 请求次数被放大，断言必然 flaky。
 *   视图层直接喂 ctx ⇒ 一次 boot、一次请求序列，完全确定。
 */
function stubDom() {
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
  });
  globalThis.window = { location: { search: '', hash: '#/' }, addEventListener() {} };
  globalThis.document = { createElement: (t) => mk(t), getElementById: () => mk('div') };
}

async function bootHome(user, apiImpl) {
  stubDom();
  const calls = [];
  const ctx = {
    api: {
      get: async (p) => { calls.push(p); return apiImpl ? apiImpl(p) : { rows: [] }; },
    },
    getState: () => ({ user }),
  };
  renderHome(ctx);
  await new Promise((r) => setTimeout(r, 10));
  return calls;
}

test('总览页：滚动总榜只请求一次（KPI 与前五榜共用同一份数据）', async () => {
  const calls = await bootHome(null);
  const rolling = calls.filter((c) => c.includes('/api/leaderboard/rolling'));
  assert.equal(rolling.length, 1, `滚动总榜应只请求 1 次，实际 ${rolling.length} 次：${JSON.stringify(calls)}`);
});

test('总览页：未登录不请求需要登录态的 /api/teams', async () => {
  const calls = await bootHome(null);
  assert.ok(!calls.some((c) => c.includes('/api/teams')), `未登录不该请求 /api/teams：${JSON.stringify(calls)}`);
});

test('总览页：已登录才请求 /api/teams（反向对照：上一条不是恒绿）', async () => {
  const calls = await bootHome({ id: 'u_a', name: '甲', roles: ['member'] });
  assert.ok(calls.some((c) => c.includes('/api/teams')), `已登录必须请求 /api/teams：${JSON.stringify(calls)}`);
});

test('总览页：榜单接口失败时给出**带重试**的错误态（不许是死路）', async () => {
  stubDom();
  const calls = [];
  const ctx = {
    api: {
      get: async (p) => {
        calls.push(p);
        if (p.includes('/api/leaderboard/rolling')) throw new TypeError('Failed to fetch');
        return { items: [] };
      },
    },
    getState: () => ({ user: null }),
  };
  renderHome(ctx);
  await new Promise((r) => setTimeout(r, 10));
  // ⚠️ DOM 桩的 querySelector 返回游离元素 ⇒ 只能断言「错误态片段被生成过」，
  //    这里用源码闸补上「重试按钮真的被绑定」这一半（见下一条）。
  assert.ok(calls.some((c) => c.includes('/api/leaderboard/rolling')), '榜单接口必须被请求');
});

test('结构闸：榜单错误态必须绑定重试按钮（点了要能重跑）', () => {
  const code = HOME_JS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/data-action="retry"/.test(code), '首页必须给错误态挂重试按钮');
  assert.ok(
    /addEventListener\('click'/.test(code),
    '重试按钮必须真的绑定 click（只渲染按钮不绑定 = 死路一条）',
  );
});

// ══════════════════════════════════════════════════════════════════
// 五、入口卡 HTML
// ══════════════════════════════════════════════════════════════════

test('入口卡 HTML：标题与链接都要渲染出来', () => {
  const html = homeEntryCardsHtml(homeEntryCards({ user: null }));
  assert.ok(html.includes('开始参赛'));
  assert.ok(html.includes('赛事公开信息'));
  assert.ok(html.includes('href="#/apply"'));
  assert.ok(!html.includes('href="#/register"'), '报名入口必须指向 /apply');
});
```

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
| DP-89 | ⛔ **可选数量的标签必须跟着值一起出现/消失** | 首页 KPI 原来用「未登录就不往数组里 push」来表达「没有这个数」，于是 `Promise.all` 的**解构位置随登录态漂移** ⇒ 未登录时「参赛队伍」显示的是榜单数。⇒ ① 标签按登录态决定**是否出现**；② 缺失值用 `null` **占位**而不是少一个元素；③ 解构前先固定形状。 |
| DP-90 | ⛔ **前端只用后端真实存在的字段** | 首页用了 `r.rank` / `r.total`，而滚动总榜的真实形状是 `points` + **没有 rank**（`getRollingLeaderboard` 与演示适配器**一致**）⇒ 每行渲染成「. 队名」+「分」。⇒ 改字段前先**对齐口径**；名次按返回顺序自己编号（后端已按积分降序）。 |
| DP-91 | ⛔ **「重试」按钮必须真的绑定 click** | DP-80 只保证了**渲染**出按钮，调用方漏绑 ⇒ 点了没反应，**比没有按钮更糟**（用户以为是自己没点到）。⇒ 抽出可重入的 `loadBoard()`，把 click 绑上去；并加**结构闸**断言 `addEventListener('click'` 存在。 |
| DP-92 | 🔗 **每个链接都要有死链闸** | `#/register` 在路由表里**根本不存在**（报名页是 `/apply`）⇒ 点了就是「页面不存在」，而这**没有任何测试会报**。⇒ 新增**死链闸**：从 `app.js` 扫出路由表，与首页入口卡 + 主导航的每个 href **逐一比对**（不匹配即红）。 |
| DP-93 | 🛡 **失败不能被缓存；错误消息必须友好化** | ① `getDemoRuntime()` 缓存了**被 reject 的 promise** ⇒ 一次瞬时网络故障就让演示站**永久瘫痪**，且「重试」重试的是同一份坏 promise。⇒ 失败时**清掉缓存**，让下一次调用重新加载。② 浏览器网络层失败抛的是英文 `TypeError` ⇒ 统一用 `friendlyError()` 翻译成中文，且放在 `errorState()` 这个**唯一出口**（11 个视图一次受益）。 |

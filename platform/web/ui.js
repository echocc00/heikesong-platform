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
    <div class="state__icon" aria-hidden="true">⚠</div>
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

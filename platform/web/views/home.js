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

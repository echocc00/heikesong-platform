// web/app.js — 前端入口（应用外壳 + 路由 + 导航分区）
// 溯源需求：R-OPS-06（?demo=1 走演示版适配器；正式版走真实 API）
//
// ⚠️ 本轮（P7）改动要点：
//   ① **导航按角色分区**（web/nav.js）：打磨前首页是 6 个平铺链接，**所有人看到的一模一样**
//      —— 组委会和选手看到同一个菜单。现在分区由 nav.js 的声明式数据驱动。
//   ② **路由守卫**：未登录点「报名」不再渲染出一个必然 401 的表单，
//      而是直接给「需要登录」的引导页。
//   ③ **总览页重做**：从「一行链接」升级为「赛事总览」（指标行 + 分区入口 + 最新榜单）。
//   ④ **W1-b（DP-105）能力点守卫**：登录了但**缺这个页面要的能力点** ⇒ 给「无权限页」
//      （说明这页属于组委会 + 缺哪个能力点 + 可点的下一步），不再渲染「全是 0」的组委会界面。
import { route, match, navigate, currentPath } from './router.js';
import { getState, setState, subscribe } from './store.js';
import { navHtml, canAccess, canReach, requiredCapability, routeLabel } from './nav.js';
import { emptyState } from './ui.js';
import { renderLogin } from './views/login.js';
import { renderRegistration } from './views/registration.js';
import { renderTeam } from './views/team.js';
import { renderAdminRegistration } from './views/admin-registration.js';
import { renderLeaderboard } from './views/leaderboard.js';
import { renderTier } from './views/tier.js';
import { renderCard } from './views/card.js';
import { renderAudit } from './views/audit.js';
import { renderFlags } from './views/flags.js';
import { renderTasks } from './views/tasks.js';
import { renderTaskIndex } from './views/task-index.js';
import { renderHome } from './views/home.js';
import { renderLanding } from './views/landing.js';
import { renderReview } from './views/review.js';
import { renderPublish } from './views/publish.js';
// P10：四个新页面（接口早就有了，只是没有界面）
import { renderReviewPrep } from './views/review-prep.js';
import { renderAdminTaskPackages } from './views/admin-task-packages.js';
import { renderAdminAppeals } from './views/admin-appeals.js';
import { renderSignoff } from './views/signoff.js';
import { escapeHtml } from './escape.js';

// 演示版：?demo=1 时用 localStorage 适配器；正式版走真实 API。
// ⚠️ 演示版的规则引擎在浏览器里真实运行（web/api.demo.js 直接 import ../src/domain/*.js），
//    所以「演示好看、正式不一样」这件事不会发生。
const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
const { api } = isDemo ? await import('./api.demo.js') : await import('./api.js');
// ⚠️ 把「当前是不是演示模式」挂到 api 上 ⇒ 视图能据此调整**输入校验**。
//    真实理由（P6 第 12 轮）：登录视图新增了「手机号格式」本地校验
//    （真实平台的手机号必须 11 位、以 1 开头），但**演示站的适配器不校验凭据**
//    （填什么都直接给一个演示管理员）⇒ 演示站访客若被要求填 11 位手机号，
//    就把「随便看看」的演示变成了填表 ⇒ **演示体验被破坏**。
// ⇒ 视图里的校验按 `ctx.api.isDemo` 分档：演示站只要求「非空」，真实平台才校验格式。
api.isDemo = isDemo;

// ⚠️ **P9：首页是落地页，原「赛事总览」仪表盘迁到 /dashboard**。
//   理由：首页是访客的第一印象 —— 一个还没注册的人看到 KPI 卡只会困惑，
//   看不到「这是什么赛、赛制怎么算、我能不能参加」。
//   ⇒ `/` = 落地页（公开，讲赛事与赛制、吸引报名）；
//     `/dashboard` = 原仪表盘（登录后可达，一行内容没删，可逆）。
route('/', (c) => renderLanding(c));
route('/dashboard', (c) => renderHome(c));
route('/login', () => renderLogin(ctx));
route('/logout', () => renderLogout());
// P1 三页：报名 / 我的战队 / 组委会筛选台
route('/apply', () => renderRegistration(ctx));
route('/team', () => renderTeam(ctx));
route('/admin/registration', () => renderAdminRegistration(ctx));
// P3 三页：榜单（A 榜 / B 榜 / 个人榜 + 滚动总榜）/ 段位榜 / 战绩卡
// ⚠️ 前端路由是**注册顺序**先匹配（不像服务端 router 那样排序），
//    但 '/leaderboard' 与 '/leaderboard/:stageId' 的正则互斥，顺序不影响结果。
route('/leaderboard', (c) => renderLeaderboard(c));
route('/leaderboard/:stageId', (c) => renderLeaderboard(c));
route('/tier', (c) => renderTier(c));
route('/card/:teamId', (c) => renderCard(c));
// P4 两页：计算留痕 trace 抽屉（从发榜页点队伍进入）/ 复核队列
// ⚠️ 必须透传路由参数（c = {...ctx, params, query}）：trace 抽屉靠 params.computationId
//    决定拉哪份快照 —— 只传模块级 ctx 会把 params 丢掉，抽屉永远拿不到 computationId。
route('/audit/:computationId', (c) => renderAudit(c));
route('/flags', (c) => renderFlags(c));
// P5 Task 6：任务清单页（只有「自主领取」一个入口，R-OPS-14 禁止岗位制）
route('/tasks/:workflowId', (c) => renderTasks(c));
// P7：工作流索引页（任务清单的入口 —— 此前 /tasks/:workflowId 没有可达路径）
route('/tasks', (c) => renderTaskIndex(c));
// P8：评审打分页 + 赛段计算发榜页（赛事能跑起来的最小闭环）
// ⚠️ 两条都注册「带赛段」与「不带赛段」两个入口：
//    不带赛段 ⇒ 页面内给赛段选择器（导航入口 `#/review` / `#/publish` 落到那里）。
// ⛔ **P10：`/review/prep` 必须注册在 `/review/:stageId` 之前** ——
//    前端路由是**注册顺序**先匹配（`web/router.js`），
//    晚注册 ⇒ `/review/prep` 会被 `/review/:stageId` 吃掉（stageId='prep'），
//    页面就永远打不开。
route('/review/prep', (c) => renderReviewPrep(c));
route('/review/prep/:stageId', (c) => renderReviewPrep(c));
route('/review', (c) => renderReview(c));
route('/review/:stageId', (c) => renderReview(c));
route('/publish', (c) => renderPublish(c));
route('/publish/:stageId', (c) => renderPublish(c));
// P10：任务卡分级审批（上游总闸）+ 申诉裁决 + 企业签字台
route('/admin/task-packages', (c) => renderAdminTaskPackages(c));
route('/admin/appeals', (c) => renderAdminAppeals(c));
route('/signoff', (c) => renderSignoff(c));

const ctx = { api, navigate, setState, getState };

/**
 * ⛔ 评审修正（Important）：启动时**先恢复会话**。
 * 原来前端从不调 `/api/me` → 登录之后刷新页面（F5）显示「未登录」，
 * 而 Cookie 其实还有效、接口也还能用 —— 用户被无端踢回登录页。
 * 会话在服务端，状态在前端：两边必须有一次对齐。
 */
async function restoreSession() {
  try {
    const { user } = await api.get('/api/me');
    setState({ user });
  } catch {
    // 401（未登录 / 会话过期）是正常情况，不是错误
    setState({ user: null });
  }
}

/** 当前 hash 上的 query（router.match 会把 '?xxx' 剥掉再匹配，所以要自己解析） */
function currentQuery() {
  const q = currentPath().split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

// ── 主题（亮 / 暗）──────────────────────────────────────────────────────
// ⚠️ 存在 localStorage 的访问在受限环境（隐私模式 / 沙箱）会抛 ⇒ 全部包 try。
const THEME_KEY = 'heikesong:theme';

function readTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function writeTheme(value) {
  try { localStorage.setItem(THEME_KEY, value); } catch { /* 存不下就算了，不影响功能 */ }
}

/** 应用主题到 <html data-theme>。传 null 表示跟随系统。 */
function applyTheme(value) {
  const el = document.documentElement;
  if (!el || typeof el.setAttribute !== 'function') return;
  if (value === 'light' || value === 'dark') el.setAttribute('data-theme', value);
  else el.removeAttribute?.('data-theme');
}

function toggleTheme() {
  const current = readTheme();
  const next = current === 'light' ? 'dark' : 'light';
  writeTheme(next);
  applyTheme(next);
}

/** 启动时恢复主题（必须在首屏渲染前，否则会闪一下默认主题）。 */
function restoreTheme() {
  const saved = readTheme();
  if (saved === 'light' || saved === 'dark') applyTheme(saved);
}

function renderLogout() {
  api.post('/api/auth/logout').finally(() => {
    setState({ user: null });
    navigate('/login');
  });
  return document.createElement('div');
}

/** 路由守卫兜底页：未登录 / 无权限时给出**可执行的下一步**，不是一句报错。 */
function renderGuard(user) {
  const el = document.createElement('div');
  el.className = 'guard';
  const needLogin = !user;
  el.innerHTML = emptyState({
    title: needLogin ? '需要登录后才能访问' : '没有访问这个页面的权限',
    hint: needLogin
      ? '登录后就能报名、组队、领任务。登录使用报名时填写的手机号。'
      : '这个页面属于组委会工作台。如果你确实需要这个权限，请联系组委会开通。',
    action: needLogin ? { href: '#/login', label: '去登录' } : { href: '#/', label: '回到总览' },
    // ⚠️ 这一页的**全部内容**就是这个守卫状态 ⇒ 它就是整页的标题 ⇒ 用 h1。
    //    否则 /team /tasks /apply /flags /review 五个路由（未登录时都落到这里）
    //    会**一个标题都没有** —— 读屏用户无法按标题导航，也拿不到页面名。
    titleTag: 'h1',
  });
  return el;
}

/**
 * 无权限页（W1-b · DP-105）：**登录了，但没有这个页面要的能力点**。
 *
 * ⚠️ 为什么必须单独一页（而不是让页面自己渲染）：
 *   打磨前，任何登录用户用 URL 就能打开组委会专属页面（报名筛选台 / 复核队列 / 赛段发榜），
 *   页面渲染出**完整界面但全是 0**（API 层返回空集，可见性过滤是对的）——
 *   用户看不懂「这是组委会的东西」，只以为页面坏了。
 *   ⇒ 现在前端按**能力点**提前说不行，并说清**缺哪个能力点**。
 *
 * ⛔ 服务端仍然是唯一裁决者：这一页**不放行**任何数据请求（视图根本没被调用）。
 * ⚠️ 复用 web/ui.js 的 emptyState（不新造 UI 组件）。
 */
function renderNoPermission(path) {
  const need = requiredCapability(path);
  const label = routeLabel(path) || path;
  const el = document.createElement('div');
  el.className = 'guard';
  el.innerHTML = emptyState({
    title: '这个页面属于组委会工作台',
    hint: need
      ? `「${label}」需要「${need}」能力点，当前账号没有这个权限。`
        + '如果你确实需要这个权限，请联系组委会开通。'
      : `「${label}」需要组委会权限，当前账号没有这个权限。`
        + '如果你确实需要这个权限，请联系组委会开通。',
    action: { href: '#/', label: '回到首页' },
    // ⚠️ 整页只有这一个状态 ⇒ 它就是页面标题 ⇒ 用 h1（与 renderGuard 同理）。
    titleTag: 'h1',
  });
  return el;
}

function demoBanner() {
  if (!isDemo) return null;
  const el = document.createElement('div');
  el.className = 'card demo-banner';
  el.innerHTML = `
    <strong>演示版</strong>：当前是公网演示站——所有数据只存在你的浏览器里（不跨人共享），
    但<b>规则引擎是在你的浏览器里真实运行的</b>（z-score 归一化 / 去极值 / 双签 / 破同分链 / 段位判定），
    算法行为与正式系统一致。
  `;
  return el;
}

async function render() {
  const app = document.getElementById('app');
  const topbar = document.getElementById('topbar');
  const user = getState().user ?? null;
  const path = currentPath();

  // ⚠️ **顶栏先渲染**：渲染失败时页面不至于只剩一块白，
  //    且 catch 分支写入的 app.innerHTML 不会被顶栏覆盖（写入顺序 = 视觉顺序）。
  if (topbar) {
    topbar.innerHTML = navHtml(user, path);
    const themeBtn = topbar.querySelector?.('[data-action="theme"]');
    themeBtn?.addEventListener?.('click', toggleTheme);
  }
  const banner = demoBanner();

  const found = match(path);
  if (!found) {
    app.innerHTML = '<div class="card">页面不存在</div>';
    if (banner) app.prepend?.(banner);
    return;
  }
  try {
    // ⚠️ 路由参数与 query 必须透传给视图：P3 的视图要靠 params.stageId / params.teamId
    //    决定请求哪个赛段 / 哪支队伍，靠 query.scope / query.editionId 决定口径与届期。
    //    P0 原来只传 ctx —— 视图拿不到参数（前端 router.match 会把 '?query' 剥掉再匹配）。
    if (!canAccess(path, user)) {
      app.replaceChildren(renderGuard(user));
      if (banner) app.prepend?.(banner);
      return;
    }
    // ⚠️ W1-b（DP-105）：登录了，但**没有这个页面要的能力点** ⇒ 给「无权限页」，
    //    而不是渲染出一个「完整界面但全是 0」的组委会界面。
    //    ⛔ 只拦 web/nav.js 里**声明了能力点**的分区级页面；赛段级页面一律不拦
    //    （评委的能力点可能是赛段级授权，前端无从判断）。
    if (!canReach(path, user)) {
      app.replaceChildren(renderNoPermission(path));
      if (banner) app.prepend?.(banner);
      return;
    }
    const el = await found.view({ ...ctx, params: found.params, query: currentQuery() });
    app.replaceChildren(el);
    if (banner) app.prepend?.(banner);
  } catch (e) {
    app.innerHTML = `<div class="card err">${escapeHtml(e.message)}</div>`;
    if (banner) app.prepend?.(banner);
  }
}

window.addEventListener('hashchange', render);
subscribe(() => render());
// ⛔ 先恢复会话再首屏渲染 —— 否则首屏永远显示「未登录」
restoreTheme();
await restoreSession();
render();

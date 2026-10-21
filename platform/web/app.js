// web/app.js — 前端入口
import { route, match, navigate, currentPath } from './router.js';
import { getState, setState, subscribe } from './store.js';
import { renderLogin } from './views/login.js';
import { renderRegistration } from './views/registration.js';
import { renderTeam } from './views/team.js';
import { renderAdminRegistration } from './views/admin-registration.js';
import { renderLeaderboard } from './views/leaderboard.js';
import { renderTier } from './views/tier.js';
import { renderCard } from './views/card.js';
import { escapeHtml } from './escape.js';

// 演示版：?demo=1 时用 localStorage 适配器；正式版走真实 API。
const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
const { api } = isDemo ? await import('./api.demo.js') : await import('./api.js');

route('/', () => renderHome());
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

function renderHome() {
  const el = document.createElement('div');
  el.className = 'card';
  const { user } = getState();
  el.innerHTML = `
    <h1>赛事平台</h1>
    ${user ? `<p>已登录：${escapeHtml(user.name)}</p>` : '<p class="muted">未登录</p>'}
    <nav>
      <a href="#/login">登录</a>
      <a href="#/leaderboard">榜单</a>
      <a href="#/apply">报名</a>
      <a href="#/team">我的战队</a>
      <a href="#/admin/registration">筛选台</a>
    </nav>
  `;
  return el;
}

function renderLogout() {
  api.post('/api/auth/logout').finally(() => {
    setState({ user: null });
    navigate('/login');
  });
  return document.createElement('div');
}

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

async function render() {
  const app = document.getElementById('app');
  const found = match(currentPath());
  if (!found) {
    app.innerHTML = '<div class="card">页面不存在</div>';
    return;
  }
  try {
    // ⚠️ 路由参数与 query 必须透传给视图：P3 的视图要靠 params.stageId / params.teamId
    //    决定请求哪个赛段 / 哪支队伍，靠 query.scope / query.editionId 决定口径与届期。
    //    P0 原来只传 ctx —— 视图拿不到参数（前端 router.match 会把 '?query' 剥掉再匹配）。
    const el = await found.view({ ...ctx, params: found.params, query: currentQuery() });
    app.replaceChildren(el);
  } catch (e) {
    app.innerHTML = `<div class="card err">${escapeHtml(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', render);
subscribe(() => render());
// ⛔ 先恢复会话再首屏渲染 —— 否则首屏永远显示「未登录」
await restoreSession();
render();

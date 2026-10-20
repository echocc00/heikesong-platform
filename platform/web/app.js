// web/app.js — 前端入口
import { route, match, navigate, currentPath } from './router.js';
import { getState, setState, subscribe } from './store.js';
import { renderLogin } from './views/login.js';

// 演示版：?demo=1 时用 localStorage 适配器；正式版走真实 API。
const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
const { api } = isDemo ? await import('./api.demo.js') : await import('./api.js');

route('/', () => renderHome());
route('/login', () => renderLogin(ctx));
route('/logout', () => renderLogout());

function renderHome() {
  const el = document.createElement('div');
  el.className = 'card';
  const { user } = getState();
  el.innerHTML = `
    <h1>赛事平台</h1>
    ${user ? `<p>已登录：${user.name}</p>` : '<p class="muted">未登录</p>'}
    <nav>
      <a href="#/login">登录</a>
      <a href="#/leaderboard">榜单</a>
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

async function render() {
  const app = document.getElementById('app');
  const found = match(currentPath());
  if (!found) {
    app.innerHTML = '<div class="card">页面不存在</div>';
    return;
  }
  try {
    const el = await found.view(ctx);
    app.replaceChildren(el);
  } catch (e) {
    app.innerHTML = `<div class="card err">${e.message}</div>`;
  }
}

window.addEventListener('hashchange', render);
subscribe(() => render());
// ⛔ 先恢复会话再首屏渲染 —— 否则首屏永远显示「未登录」
await restoreSession();
render();

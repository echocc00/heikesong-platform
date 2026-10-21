// web/api.demo.js — 演示版适配器（浏览器内 localStorage）
// ⛔ 数据不跨人共享。这是当前无云主机条件下的客观边界。
// ✅ 但规则引擎在浏览器里真实运行，演示出来的算法行为与正式系统一致。
const KEY = 'hks_demo_db';

function load() {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify({}));
  return JSON.parse(localStorage.getItem(KEY));
}
function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

export const api = {
  async get(path) {
    const db = load();
    if (path === '/api/health') return { ok: true, demo: true };
    if (path === '/api/me') {
      return db.me ? { user: db.me } : (() => { throw Object.assign(new Error('未登录'), { status: 401 }); })();
    }
    // ⚠️ 顺序要紧：'tier' 必须排在 '/api/leaderboard/' 之前，
    //    否则段位榜会拿到赛段榜的形状（前端渲染成空段位列）。
    if (path.startsWith('/api/leaderboard/rolling')) {
      return { scope: 'rolling', rows: db.leaderboard || [], demo: true };
    }
    if (path.startsWith('/api/leaderboard/tier')) {
      return { scope: 'tier', rows: db.tiers || [], demo: true };
    }
    if (path.startsWith('/api/leaderboard/')) {
      const scope = new URL(path, 'http://x').searchParams.get('scope') || 'rank';
      return { scope, rows: db.leaderboard || [], warnings: db.warnings || [], demo: true };
    }
    if (path.endsWith('/performance-card')) {
      return {
        teamName: '演示战队', tier: 'A', items: db.milestones || [],
        benefits: [], neverUnlocks: ['奖金', '决赛名次'], demo: true,
      };
    }
    if (path.endsWith('/tier')) {
      return { rows: db.tiers || [], demo: true };
    }
    throw Object.assign(new Error(`演示版未实现该接口：${path}`), { status: 404 });
  },
  async post(path, body) {
    const db = load();
    if (path === '/api/auth/login') {
      db.me = { id: 'demo_admin', name: body?.name || '演示管理员', mbaStatus: 'mba', org: '演示' };
      save(db);
      return { user: db.me };
    }
    if (path === '/api/auth/logout') { db.me = null; save(db); return { ok: true }; }
    throw Object.assign(new Error(`演示版未实现该接口：${path}`), { status: 404 });
  },
  async patch() { throw Object.assign(new Error('演示版不支持写操作'), { status: 404 }); },
  async del() { throw Object.assign(new Error('演示版不支持写操作'), { status: 404 }); },
  subscribe() { return () => {}; },
};

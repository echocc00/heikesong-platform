// platform/test/route-capability-guard.test.js —— W1-b（DP-105）权限模型的行为闸
//
// 规则溯源：
//   - 「权限不靠角色枚举，靠『能力 + 授权记录』」→ 设计文档 §7.1 / §7.2
//   - 「前端按**能力点**声明式拦分区级页面；只声明 API 同样要求**全局**能力点的页面；
//     赛段级页面一律不拦」→ docs/superpowers/plans/2026-10-22-platform-P10-design-system.md
//     §3（DP-105）
//   - 「can() 是唯一判定入口；前端拿到的能力点只是**提示**」→ 全局约束「可见性在 API 层过滤」
//
// ⚠️ 本文件测的是**一条完整链路**：仓储（能力点并集）→ 对外形状（/api/me 的 capabilities）
//    → 前端守卫（canReach）。中间任何一环断了，守卫就会「误伤有权限的人」或「放行没权限的人」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { listUserCapabilities, insertAssignment } from '../src/db/repo/assignments.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { createUser, toPublicUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { loadRules } from '../src/config.js';
import { canReach, requiredCapability, userCapabilities, ROUTE_CAPABILITIES } from '../web/nav.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-cap-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  insertCapability(db, 'registration:review', '审核报名分级');
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertCapability(db, 'stage:compute', '触发计算发榜');
  insertCapability(db, 'score:write', '评分写入');
  insertRole(db, 'admin', '组委会');
  const user = createUser(db, { name: '甲', phone: '13900000077', password: 'pw' });
  return { db, close, dataDir, user };
}

// ══════════════════════════════════════════════════════════════════
// 一、仓储层：能力点 = 角色能力 ∪ 全局资源授权
// ══════════════════════════════════════════════════════════════════

test('能力点并集：角色能力 ∪ 全局资源授权（两条来源都要算进去）', () => {
  const { db, close, dataDir, user } = setup();
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, user.id, 'admin');
  insertAssignment(db, {
    id: 'as_1', userId: user.id, capability: 'stage:compute',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  assert.deepEqual(
    listUserCapabilities(db, user.id),
    ['audit:read', 'stage:compute'],
    '角色给的与直接授权的都要在里面',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('赛段级授权**不算数**（前端只声明「API 同样要求全局能力点」的页面）', () => {
  // ⛔ 这条是「前端拦路会不会误伤」的边界：评委 / 企业席拿的是**赛段级**授权，
  //    把它算进前端的能力点 ⇒ 前端会以为「这个页面我能进」而 API 其实 403。
  const { db, close, dataDir, user } = setup();
  insertAssignment(db, {
    id: 'as_stage', userId: user.id, capability: 'stage:compute',
    scopeType: 'stage', scopeId: 'stage_final', grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  insertAssignment(db, {
    id: 'as_edition', userId: user.id, capability: 'audit:read',
    scopeType: 'edition', scopeId: 'ed_1', grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  assert.deepEqual(
    listUserCapabilities(db, user.id),
    [],
    '赛段级 / 届次级授权不得进入全局能力点集合',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('能力点：去重 + 排序确定（同一能力点从两条来源来也只出现一次）', () => {
  const { db, close, dataDir, user } = setup();
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, user.id, 'admin');
  insertAssignment(db, {
    id: 'as_dup', userId: user.id, capability: 'audit:read',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  insertAssignment(db, {
    id: 'as_b', userId: user.id, capability: 'stage:compute',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  const first = listUserCapabilities(db, user.id);
  assert.deepEqual(first, ['audit:read', 'stage:compute'], '去重 + 按能力点键升序');
  // ⚠️ 顺序必须**确定**（同一份数据跑两次给同一个顺序）—— 前端会拿它做集合判断。
  assert.deepEqual(listUserCapabilities(db, user.id), first, '两次调用顺序必须一致');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('能力点：没有任何授权 ⇒ 空数组（不是 null、不是 undefined）', () => {
  const { db, close, dataDir, user } = setup();
  assert.deepEqual(listUserCapabilities(db, user.id), []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 二、对外形状：/api/me 的 capabilities
// ══════════════════════════════════════════════════════════════════

test('toPublicUser 缺省第三参数 ⇒ capabilities 是**空数组**（不是 undefined、不是全部）', () => {
  // ⛔ 缺省即「没有」：漏传不能让前端以为「这个人什么都能干」。
  const pub = toPublicUser({ id: 'u1', name: '甲', is_superadmin: 0, active: 1, created_at: 'now' });
  assert.ok(Array.isArray(pub.capabilities), 'capabilities 必须是数组（前端按数组读）');
  assert.deepEqual(pub.capabilities, [], '缺省就是空数组');
  assert.notEqual(pub.capabilities, undefined, '不得是 undefined');
});

test('toPublicUser 带能力点 ⇒ 原样带出（脏值滤掉、重复去重）', () => {
  const pub = toPublicUser(
    { id: 'u1', name: '甲', is_superadmin: 0, active: 1, created_at: 'now' },
    ['admin'],
    ['audit:read', 'audit:read', '', null, 7],
  );
  assert.deepEqual(pub.capabilities, ['audit:read']);
  assert.deepEqual(pub.roles, ['admin'], 'roles 不受影响');
});

// ══════════════════════════════════════════════════════════════════
// 三、前端守卫：canReach
// ══════════════════════════════════════════════════════════════════

const COMMITTEE_USER = { id: 'u_a', name: '组委会', roles: ['admin'], capabilities: ['audit:read'] };
const PLAYER_USER = { id: 'u_p', name: '选手', roles: ['member'], capabilities: [] };

test('守卫：未登录 ⇒ 拦（分区级页面一律要登录）', () => {
  assert.equal(canReach('/flags', null), false);
  assert.equal(canReach('/admin/registration', null), false);
  assert.equal(canReach('/publish', null), false);
});

test('守卫：超管直通（两种形状都认）', () => {
  assert.equal(canReach('/flags', { id: 'u_s', isSuperadmin: true, capabilities: [] }), true);
  assert.equal(canReach('/flags', { id: 'u_s', is_superadmin: 1, capabilities: [] }), true);
});

test('守卫：缺能力点 ⇒ 拦（登录了但不是组委会的人）', () => {
  assert.equal(canReach('/flags', PLAYER_USER), false, '没有 audit:read 进不了复核队列');
  assert.equal(canReach('/admin/registration', PLAYER_USER), false, '没有 registration:review 进不了筛选台');
  assert.equal(canReach('/publish', PLAYER_USER), false, '没有 stage:compute 进不了发榜');
});

test('守卫：有能力点 ⇒ 放行', () => {
  assert.equal(canReach('/flags', COMMITTEE_USER), true);
  assert.equal(canReach('/admin/registration', { id: 'u_x', capabilities: ['registration:review'] }), true);
  assert.equal(canReach('/publish', { id: 'u_x', capabilities: ['stage:compute'] }), true);
});

test('守卫：**未声明能力点的路径一律放行**（防误伤 —— 赛段级 / 公共页）', () => {
  // ⛔ 这条最容易写错：一旦把赛段级页面也拦了，评委 / 企业席会被挡在门外
  //    （他们的能力点是赛段级授权，前端无从判断）。
  for (const p of [
    '/', '/dashboard', '/apply', '/team', '/tasks', '/leaderboard', '/leaderboard/stage_final',
    '/tier', '/card/t_1', '/review', '/review/stage_final', '/publish/stage_final',
    '/audit/cmp_1', '/login',
  ]) {
    assert.equal(canReach(p, PLAYER_USER), true, `${p} 不得被能力点守卫拦下`);
  }
});

test('守卫：赛段级路径**不在**能力点声明表里（精确匹配，不是前缀匹配）', () => {
  assert.equal(ROUTE_CAPABILITIES['/publish'], 'stage:compute');
  assert.equal(ROUTE_CAPABILITIES['/publish/stage_final'], undefined, '赛段级发榜不得声明能力点');
  assert.equal(ROUTE_CAPABILITIES['/review/stage_final'], undefined, '赛段级评审不得声明能力点');
  assert.equal(ROUTE_CAPABILITIES['/leaderboard/stage_final'], undefined);
  assert.equal(requiredCapability('/flags'), 'audit:read');
  assert.equal(requiredCapability('/flags/'), 'audit:read', '结尾斜杠是同一个页面');
  assert.equal(requiredCapability('/flags?x=1'), 'audit:read', 'query 不影响判定');
  assert.equal(requiredCapability('/apply'), null, '没声明就没有');
});

test('守卫：服务端**没给**能力点 ⇒ 不拦（前端无从判断就别瞎猜）', () => {
  // ⚠️ 这个 user 对象不是 /api/me 的形状（演示适配器 / 旧缓存会话）⇒ 前端手里没有能力点。
  //    拦它 = 误伤一个服务端其实放行的人。
  assert.equal(canReach('/flags', { id: 'u_demo', roles: ['admin'] }), true);
  assert.equal(canReach('/flags', { id: 'u_demo', capabilities: null }), true);
});

test('能力点提取：各种脏形状都要兜住', () => {
  assert.deepEqual(userCapabilities({ capabilities: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(userCapabilities({ capabilities: 'a' }), ['a']);
  assert.deepEqual(userCapabilities({ capabilities: ['', null, 3, 'x'] }), ['x'], '脏值要滤掉');
  assert.deepEqual(userCapabilities(null), []);
  assert.deepEqual(userCapabilities({}), []);
});

// ══════════════════════════════════════════════════════════════════
// 四、端到端：/api/me 真的带上能力点（否则前端守卫永远「缺能力点」）
// ══════════════════════════════════════════════════════════════════

/** 极简请求桩（不需要真起 HTTP 服务）。 */
function call(app, method, path, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, url: path, headers, on() {}, async *[Symbol.asyncIterator]() {} };
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
      end(payload) {
        if (payload) this.body = payload.toString();
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };
    app.handle(req, res);
  });
}

test('/api/me 必须带上能力点（角色给的 + 直接授权的）', async () => {
  const { db, close, dataDir, user } = setup();
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, user.id, 'admin');
  insertAssignment(db, {
    id: 'as_me', userId: user.id, capability: 'stage:compute',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const { token } = createSession(db, user.id);
  const res = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(
    body.user.capabilities,
    ['audit:read', 'stage:compute'],
    '/api/me 必须带上能力点（前端守卫靠它判断）',
  );
  // ⚠️ 端到端闭环：这个 user 直接喂给前端守卫 ⇒ 有能力点的人能进组委会页面。
  assert.equal(canReach('/flags', body.user), true);
  assert.equal(canReach('/publish', body.user), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('/api/me 的能力点缺省即空数组（没有任何授权的人拿不到「全部权限」）', async () => {
  const { db, close, dataDir, user } = setup();
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const { token } = createSession(db, user.id);
  const res = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.user.capabilities, [], '没有授权 ⇒ 空数组（不是 undefined、不是全部）');
  assert.equal(canReach('/flags', body.user), false, '没有能力点 ⇒ 前端拦下组委会页面');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 五、前端外壳端到端：缺能力点 ⇒ 渲染「无权限页」，且**不发业务请求**
// ══════════════════════════════════════════════════════════════════

/** 最小 DOM 桩：够 web/app.js 跑起来。 */
function installDom(hash = '') {
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
  return { app, topbar };
}

async function bootApp(hash, meBody, tag) {
  const dom = installDom(hash);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url) === '/api/me' ? meBody : { rows: [], total: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  await import(`../web/app.js?v=${tag}`);
  await new Promise((r) => setTimeout(r, 30));
  return { dom, calls };
}

test('前端外壳：缺能力点进组委会页面 ⇒ 渲染「无权限页」且**不发业务请求**', async () => {
  // ⚠️ 这条要防的正是「打磨前的真问题」：页面渲染出**完整界面但全是 0**
  //    （API 返回空集），用户看不懂「这是组委会的东西」，只以为页面坏了。
  const { dom, calls } = await bootApp(
    '#/flags',
    { user: { id: 'u_p', name: '选手', roles: ['member'], capabilities: [] } },
    'cap-guard-anon',
  );
  assert.ok(
    !calls.some((c) => c.includes('/api/audit/flags')),
    `被拦下的页面不得发业务请求，实际请求：${JSON.stringify(calls)}`,
  );
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('组委会'), `无权限页要说明这页属于谁，实际：${html}`);
  assert.ok(html.includes('audit:read'), `无权限页要说明缺哪个能力点，实际：${html}`);
  assert.ok(html.includes('#/'), '无权限页要给出可点的下一步');
});

test('前端外壳（反向对照）：有能力点 ⇒ 页面照常渲染并请求数据', async () => {
  const { calls } = await bootApp(
    '#/flags',
    { user: { id: 'u_a', name: '组委会', roles: ['admin'], capabilities: ['audit:read'] } },
    'cap-guard-ok',
  );
  assert.ok(
    calls.some((c) => c.includes('/api/audit/flags')),
    `有能力点必须真的请求数据（上一条不是恒绿），实际请求：${JSON.stringify(calls)}`,
  );
});

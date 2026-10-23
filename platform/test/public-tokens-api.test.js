// test/public-tokens-api.test.js — 公开访问令牌的管理链路（签发 / 列表 / 吊销）
//
// 规则溯源：
//   - 「公开榜单 API + 赛程日历 iCal 订阅」→ 设计文档 §8
//   - 「公开 ≠ 无鉴权」：两个公开端点都必须带 token（src/http/routes/public.js）
//   - 「只存哈希，明文只返回一次」→ src/services/public-api.js 的 createPublicToken
//   - 「权限唯一裁决者是 can()」→ 设计文档 §7.1/§7.2（src/auth/permissions.js）
//   - 「三态状态码」→ 设计文档 §7.3（列表 200+空集 / 单条 404 / 禁用 403）
//   - 「每次状态迁移写审计日志」→ 设计文档 §11.2（src/audit/log.js）
//
// ⚠️ **这些闸门不钉住就会静默失效**：
//   平台此前**没有任何创建 token 的入口** ⇒ 两个公开接口谁也用不了；
//   而一旦把「明文」或「哈希」当令牌发给前端（列表接口最容易犯），就是一次凭据泄露。
//
// ⚠️ 全部是**行为断言**（真的发请求、真的查库），不是源码文本匹配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerPublicTokenRoutes } from '../src/http/routes/public-tokens.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { listPublicTokens } from '../src/db/repo/public-tokens.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { hashPublicToken } from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';
import { tokenRows, tokenTableHtml, issuedTokenHtml, renderPublicLinks } from '../web/views/public-links.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pubtok-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  // ⚠️ 结束日推到 2099：让「当届」解析（pickCurrentEdition）与真实日期无关 ——
  //    否则「不给 editionId 就用当届」这条用例会随日历过期而红。
  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2099-12-31', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900000061', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000062', password: 'pw' });

  insertCapability(db, 'stage:compute', '触发计算发榜');
  grantAssignment(db, {
    userId: admin.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  // ⚠️ createApp 还没接本模块的路由（**路由接线由集成者做**）⇒ 这里手动挂上，
  //    否则这三条端点在进程内根本不存在（与 web-signoff.test.js 同一手法）。
  registerPublicTokenRoutes(app.router);

  return {
    db,
    close,
    dataDir,
    app,
    rules,
    edition,
    admin,
    outsider,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function cleanup(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

/** 签发一枚令牌，返回解析后的响应体。 */
async function issue(s, body = {}) {
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenAdmin,
    body: { editionId: s.edition.id, ...body },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

// ══════════════════════════════════════════════════════════════════
// 一、签发
// ══════════════════════════════════════════════════════════════════

test('组委会签发令牌 → 200，响应给明文；库里存的是哈希', async () => {
  const s = setup();
  const body = await issue(s, { scope: 'all' });
  assert.ok(body.token, '响应必须含明文 token');
  assert.equal(body.scope, 'all');
  assert.equal(body.editionId, s.edition.id);
  assert.ok(body.expiresAt, '响应必须给出过期时间');

  // ⛔ 库里存的是 SHA-256，不是明文
  const rows = listPublicTokens(s.db, { editionId: s.edition.id });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, body.token, '库里存的是哈希，不是明文');
  assert.equal(rows[0].token, hashPublicToken(body.token), '库里那列必须 = sha256(明文)');
  assert.equal(rows[0].token.length, 64, 'SHA-256 十六进制长度');
  cleanup(s);
});

test('不给 editionId → 用当届（与 pickCurrentEdition 同一口径）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenAdmin,
    body: { scope: 'all' },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).editionId, s.edition.id, '缺省届期必须解析成当届');
  cleanup(s);
});

test('没有 stage:compute 的账号签发 → 403，且不得落库', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, scope: 'all' },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  assert.equal(listPublicTokens(s.db, {}).length, 0, '被拒绝的签发不得留下任何记录');
  cleanup(s);
});

test('未登录签发 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', { body: { editionId: s.edition.id } });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'UNAUTHENTICATED');
  cleanup(s);
});

test('非法 scope → 400 PUBLIC_SCOPE_INVALID，且不得落库', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/public/tokens', {
    token: s.tokenAdmin,
    body: { editionId: s.edition.id, scope: 'admin' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_SCOPE_INVALID');
  assert.equal(listPublicTokens(s.db, {}).length, 0, '被拒绝的签发不得留下任何记录');
  cleanup(s);
});

test('ttlDays 生效（默认取规则里的 30 天，给了就按给的算）', async () => {
  const s = setup();
  const def = await issue(s, { scope: 'all' });
  const custom = await issue(s, { scope: 'all', ttlDays: 7 });
  const days = (a, b) => (new Date(a) - new Date(b)) / 86400000;
  const now = Date.now();
  assert.ok(Math.abs(days(def.expiresAt, now) - 30) <= 1, '默认应是 30 天（rules.pools.publicTokenTtlDays）');
  assert.ok(Math.abs(days(custom.expiresAt, now) - 7) <= 1, '给了 ttlDays 就按给的算');
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、列表
// ══════════════════════════════════════════════════════════════════

test('还没有令牌时列表 → 200 + 空数组（不是 404）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.items, [], '列表类「不满足」是空集，不是 404');
  cleanup(s);
});

test('⛔ 列表的每一行都不含明文令牌（只给哈希行标识 + 不可逆短标识）', async () => {
  const s = setup();
  const issued = await issue(s, { scope: 'all' });
  const res = await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(res.body.includes(issued.token), false, '列表响应里绝不能出现明文令牌');

  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  const hash = hashPublicToken(issued.token);
  // 行标识 = 哈希（可用来吊销；它**不是**可用令牌：公开接口会再哈希一次）
  assert.equal(item.id, hash);
  assert.equal(item.tokenHint, hash.slice(0, 8));
  assert.equal(item.scope, 'all');
  assert.equal(item.editionId, s.edition.id);
  assert.equal(item.expired, false);
  assert.ok(item.createdAt, '必须给出创建时间');
  cleanup(s);
});

test('⛔ 列表不得把哈希「当令牌」发出去（字段集合逐字固定）', async () => {
  const s = setup();
  await issue(s, { scope: 'all' });
  const body = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  const item = body.items[0];
  // ⚠️ 哈希**可以**作为行标识（id）出现 —— 吊销端点要用它；
  //    但它**不能**以「令牌」的身份出现（前端会拿它去调公开接口，必然 403）。
  assert.deepEqual(
    Object.keys(item).sort(),
    ['createdAt', 'editionId', 'expired', 'expiresAt', 'id', 'scope', 'tokenHint'].sort(),
    '列表每行的字段集合必须固定（多一个 token 字段就是把哈希当令牌发出去）',
  );
  assert.equal(item.token, undefined, '不得有 token 字段');
  cleanup(s);
});

test('列表可以按 editionId 过滤', async () => {
  const s = setup();
  await issue(s, { scope: 'all' });
  const other = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  await issue(s, { scope: 'all', editionId: other.id });

  const all = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  assert.equal(all.items.length, 2);
  const filtered = JSON.parse((await call(s.app, 'GET', `/api/public/tokens?editionId=${other.id}`, {
    token: s.tokenAdmin,
  })).body);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].editionId, other.id);
  cleanup(s);
});

test('已过期的令牌在列表里 expired = true', async () => {
  const s = setup();
  await issue(s, { scope: 'all', expiresAt: '2020-01-01T00:00:00.000Z' });
  const body = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].expired, true, '过期时间已过的令牌必须被标出来');
  cleanup(s);
});

test('列表也要过权限闸门：无 stage:compute → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 三、吊销
// ══════════════════════════════════════════════════════════════════

test('吊销令牌 → 200；吊销后同一枚明文再也进不了公开接口', async () => {
  const s = setup();
  const issued = await issue(s, { scope: 'all' });
  const url = `/api/public/leaderboard?token=${encodeURIComponent(issued.token)}&editionId=${encodeURIComponent(s.edition.id)}`;

  // 吊销前：公开榜单能出数
  const before = await call(s.app, 'GET', url);
  assert.equal(before.status, 200, before.body);

  // 用**列表给的行标识**去吊销（端到端：列表 → 吊销）
  const list = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  const del = await call(s.app, 'DELETE', `/api/public/tokens/${encodeURIComponent(list.items[0].id)}`, {
    token: s.tokenAdmin,
  });
  assert.equal(del.status, 200, del.body);

  // 吊销后：同一枚明文一律 403
  const after = await call(s.app, 'GET', url);
  assert.equal(after.status, 403, after.body);
  assert.equal(JSON.parse(after.body).error.code, 'PUBLIC_TOKEN_INVALID');

  // 列表里也没有它了
  const after2 = JSON.parse((await call(s.app, 'GET', '/api/public/tokens', { token: s.tokenAdmin })).body);
  assert.deepEqual(after2.items, []);
  cleanup(s);
});

test('吊销不存在的令牌 → 404（不是 200 假装成功）', async () => {
  const s = setup();
  const res = await call(s.app, 'DELETE', `/api/public/tokens/${'a'.repeat(64)}`, { token: s.tokenAdmin });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_FOUND');
  cleanup(s);
});

test('吊销也要过权限闸门：无 stage:compute → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'DELETE', `/api/public/tokens/${'b'.repeat(64)}`, { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 四、审计
// ══════════════════════════════════════════════════════════════════

test('⛔ 签发与吊销都写审计日志，且 detail 里绝不含明文令牌', async () => {
  const s = setup();
  const issued = await issue(s, { scope: 'calendar' });
  const hash = hashPublicToken(issued.token);

  const issues = queryAuditLog(s.db, { action: 'public_token.issue', limit: 50 });
  assert.equal(issues.total, 1, '签发必须写一条审计');
  const issueRow = issues.rows[0];
  assert.equal(issueRow.entity, 'public_token');
  assert.equal(issueRow.actor_id, s.admin.id, '审计必须记下是谁签发的');
  const issueDetail = JSON.parse(issueRow.detail_json);
  assert.equal(issueDetail.scope, 'calendar');
  assert.equal(issueDetail.editionId, s.edition.id);
  assert.equal(issueDetail.tokenHint, hash.slice(0, 8));
  assert.equal(JSON.stringify(issueDetail).includes(issued.token), false, '审计 detail 里绝不能有明文 token');

  const del = await call(s.app, 'DELETE', `/api/public/tokens/${hash}`, { token: s.tokenAdmin });
  assert.equal(del.status, 200, del.body);

  const revokes = queryAuditLog(s.db, { action: 'public_token.revoke', limit: 50 });
  assert.equal(revokes.total, 1, '吊销必须写一条审计');
  const revokeDetail = JSON.parse(revokes.rows[0].detail_json);
  assert.equal(revokeDetail.scope, 'calendar');
  assert.equal(revokeDetail.tokenHint, hash.slice(0, 8));
  assert.equal(JSON.stringify(revokeDetail).includes(issued.token), false, '审计 detail 里绝不能有明文 token');
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 五、界面（纯函数层）
// ══════════════════════════════════════════════════════════════════

test('⛔ 界面的展示模型只取白名单字段（服务端多给明文也不渲染）', () => {
  const rows = tokenRows({
    items: [{
      id: 'hash-id', scope: 'all', editionId: 'ed_1', expiresAt: '2026-11-20T00:00:00.000Z',
      createdAt: '2026-10-20T00:00:00.000Z', tokenHint: 'abcd1234', expired: false,
      token: 'PLAINTEXT-SECRET',
    }],
  });
  assert.equal(rows[0].token, undefined, '明文字段不得进入展示模型');
  const html = tokenTableHtml(rows);
  assert.equal(html.includes('PLAINTEXT-SECRET'), false, '表格里绝不能出现明文令牌');
  assert.ok(html.includes('abcd1234'), '短标识要显示出来（人眼要能分辨是哪一枚）');
  assert.ok(html.includes('data-action="revoke-request"'), '每行都要有吊销入口');
  assert.ok(html.includes('data-action="revoke-confirm"'), '吊销必须有二次确认');
});

test('签发成功后的界面：明文 + 两个公开链接 + 「只显示这一次」的提示', () => {
  const html = issuedTokenHtml({
    token: 'PLAIN-TOKEN', scope: 'all', editionId: 'ed_1', expiresAt: '2026-11-20T00:00:00.000Z',
  });
  assert.ok(html.includes('PLAIN-TOKEN'), '明文必须显示出来');
  assert.ok(
    html.includes('/api/public/leaderboard?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出公开榜单链接',
  );
  assert.ok(
    html.includes('/api/public/calendar.ics?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出赛程日历链接',
  );
  assert.ok(html.includes('只显示这一次'), '必须提示明文只显示这一次');
  assert.equal(html.includes('<style'), false, '不许写 <style> 标签（颜色只走设计令牌）');
  // ⛔ 服务端数据必须过 escapeHtml（届期 id 来自服务端，不是可信输入）
  const injected = issuedTokenHtml({
    token: 'x', scope: 'all', editionId: '<script>alert(1)</script>', expiresAt: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(injected.includes('<script>'), false, '服务端数据必须转义后再插进 HTML');
});

test('视图必须复用 web/escape.js（全站唯一转义入口）', () => {
  const src = readFileSync(join(here, '..', 'web', 'views', 'public-links.js'), 'utf8');
  assert.ok(src.includes("from '../escape.js'"), '必须复用 web/escape.js');
  assert.equal(/export function escapeHtml/.test(src), false, '不得重复定义 escapeHtml');
  assert.equal(/noticeState\(\{[^}]*text:/.test(src), false, 'noticeState 只认 items / list，不认 text');
});

// ── 最小 DOM 桩（与 web/views/signoff.js、login-view.test.js 同一手法）──
// ⚠️ 只实现本视图用到的那几个方法：没有真 DOM、没有 IntersectionObserver。

function makeEl(tag = 'div') {
  return {
    tagName: tag,
    className: '',
    innerHTML: '',
    value: '',
    dataset: {},
    hidden: false,
    _listeners: {},
    _nodes: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of this._listeners[type] || []) fn(event);
    },
    querySelector(sel) {
      return this._nodes[sel] ?? null;
    },
    querySelectorAll(sel) {
      const v = this._nodes[sel];
      return Array.isArray(v) ? v : (v ? [v] : []);
    },
    closest() {
      return null;
    },
    focus() {},
  };
}

/** 让微任务队列跑干净（视图里的请求是异步的）。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** 把视图装到可控的假 DOM 上（返回各个挂载点，便于断言）。 */
async function mountView(api) {
  const wrap = makeEl('div');
  const list = makeEl('div');
  const stats = makeEl('div');
  const issued = makeEl('div');
  const feedback = makeEl('div');
  const scopeField = makeEl('select');
  scopeField.value = 'all';
  const ttlField = makeEl('input');
  ttlField.value = '';
  wrap._nodes['[data-list]'] = list;
  wrap._nodes['[data-stats]'] = stats;
  wrap._nodes['[data-issued]'] = issued;
  wrap._nodes['[data-feedback]'] = feedback;
  wrap._nodes['[data-field="scope"]'] = scopeField;
  wrap._nodes['[data-field="ttlDays"]'] = ttlField;
  wrap._nodes['[data-revoke-confirm]'] = [];
  globalThis.document = { createElement: () => wrap };
  await renderPublicLinks({
    api, navigate: () => {}, setState: () => {}, getState: () => ({}), query: {}, params: {},
  });
  await flush();
  return { wrap, list, stats, issued, feedback };
}

/** 造一个假按钮：closest('[data-action]') 返回自己，closest('[data-retry]') 返回作用域。 */
function fakeButton(action, retryKind = 'list') {
  const scope = { dataset: { retry: retryKind } };
  const btn = {
    dataset: { action },
    closest: (sel) => (sel === '[data-retry]' ? scope : btn),
  };
  return btn;
}

test('★ 加载失败 → 错误态带重试按钮，且点「重试」真的重跑一次', async () => {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      throw new Error('接口挂了');
    },
    post: async () => ({ token: 'x' }),
    del: async () => ({ ok: true }),
  };
  const { wrap, list } = await mountView(api);
  assert.ok(list.innerHTML.includes('data-action="retry"'), '错误态必须有可点的重试按钮');
  assert.equal(calls.length, 1, '首次加载应发过一次请求');

  wrap.dispatch('click', { target: fakeButton('retry', 'list') });
  await flush();
  assert.equal(calls.length, 2, '点「重试」必须真的重跑一次（不是死路一条）');
});

test('★ 列表加载成功 → 渲染表格与吊销入口', async () => {
  const api = {
    get: async () => ({
      items: [{
        id: 'hash-id', scope: 'all', editionId: 'ed_1',
        expiresAt: '2026-11-20T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z',
        tokenHint: 'abcd1234', expired: false,
      }],
    }),
    post: async () => ({}),
    del: async () => ({}),
  };
  const { list } = await mountView(api);
  assert.ok(list.innerHTML.includes('abcd1234'), '短标识要出现在表格里');
  assert.ok(list.innerHTML.includes('data-action="revoke-request"'), '每行都要有吊销入口');
  assert.equal(list.innerHTML.includes('data-action="revoke-confirm"'), true, '吊销必须有二次确认');
});

test('★ 签发成功 → 明文与两个公开链接被展示出来', async () => {
  const api = {
    get: async () => ({ items: [] }),
    post: async (path, body) => {
      api.calls.push({ path, body });
      return {
        token: 'PLAIN-TOKEN', scope: 'all', editionId: 'ed_1', expiresAt: '2026-11-20T00:00:00.000Z',
      };
    },
    del: async () => ({}),
    calls: [],
  };
  const { wrap, issued } = await mountView(api);
  wrap.dispatch('click', { target: fakeButton('issue') });
  await flush();

  assert.equal(api.calls.length, 1, '点「签发」必须真的发一次请求');
  assert.equal(api.calls[0].path, '/api/public/tokens');
  assert.equal(api.calls[0].body.scope, 'all');
  assert.ok(issued.innerHTML.includes('PLAIN-TOKEN'), '明文必须展示出来');
  assert.ok(
    issued.innerHTML.includes('/api/public/leaderboard?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出公开榜单链接',
  );
  assert.ok(
    issued.innerHTML.includes('/api/public/calendar.ics?token=PLAIN-TOKEN&amp;editionId=ed_1'),
    '必须给出赛程日历链接',
  );
  assert.ok(issued.innerHTML.includes('只显示这一次'), '必须提示明文只显示这一次');
});

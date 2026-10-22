// platform/test/login-view.test.js — 登录视图的 DOM 级行为（P6 第 12 轮）
//
// 溯源需求：R-P0-06（登录闭环）｜R-OPS-06（公网可访问）
//
// ⚠️ 本文件守的是一条**真实报障**的修复：
//   真机实测抓到：浏览器发出的 `POST /api/auth/login` 里 **`phone` 是空字符串**
//   （口令却逐字正确）⇒ 后端回「手机号或密码不正确」⇒ **提示指错了方向**。
//   ⇒ 登录视图必须**先本地校验**：手机号为空 ⇒ **一个请求都不发**，并说清是手机号的问题。
//
// 为什么不用 jsdom：本仓**零 npm 依赖**（R-OPS-01/07）⇒ 用手搓的最小 DOM mock。
// ⚠️ 只 mock 登录视图用到的那几个 API（createElement / innerHTML / querySelector /
//    addEventListener / value）—— 够用即可，不做通用 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ── 最小 DOM mock ────────────────────────────────────────────────────
/**
 * 造一个够登录视图用的假元素。
 * @param {string} innerHTML 视图设置的 HTML
 * @param {object} inputs    { [id]: { value } } —— querySelector('#id') 命中这些
 */
function fakeEl(innerHTML = '', inputs = {}) {
  const listeners = {};
  const el = {
    _html: innerHTML,
    _listeners: listeners,
    _inputs: inputs,
    _err: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._err = v; },
    get textContent() { return this._err; },
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    async fire(ev) {
      for (const fn of listeners[ev] || []) await fn();
    },
    querySelector(sel) {
      const id = sel.replace(/^#/, '');
      if (id in inputs) {
        return { value: inputs[id].value, tagName: 'INPUT' };
      }
      if (id === 'err') return el;          // 错误文案落在元素自己身上
      if (id === 'submit') return el;        // 提交按钮也用元素自己
      return null;
    },
  };
  return el;
}

/** 把登录视图装到一个可控的假 DOM 上，返回 { el, calls } */
async function mountLogin({ phone = '', password = '' } = {}) {
  const inputs = { phone: { value: phone }, password: { value: password } };
  const el = fakeEl('', inputs);
  const calls = [];
  const api = {
    post: async (path, body) => {
      calls.push({ path, body });
      return { user: { id: 'u1', name: 'x' } };
    },
  };
  const ctx = { api, navigate: () => {}, setState: () => {} };
  globalThis.document = { createElement: () => el };
  const { renderLogin } = await import('../web/views/login.js');
  const view = renderLogin(ctx);
  return { view, calls, el };
}

test('登录：手机号为空 ⇒ 本地拦下，**一个请求都不发**，且提示指向手机号', async () => {
  const { calls, el, view } = await mountLogin({ phone: '', password: 'XpLEdKLuUV2iDLriXHZ7TbZJ' });
  await view.fire('click');
  assert.equal(calls.length, 0, `⛔ 手机号为空时不得发请求（实际发了 ${calls.length} 次）`);
  assert.match(el.textContent, /手机号/, `提示必须指向手机号：${el.textContent}`);
  assert.ok(!/密码/.test(el.textContent), `⛔ 不得提密码（会指错方向）：${el.textContent}`);
});

test('登录：手机号格式不对 ⇒ 不发请求，提示指向手机号', async () => {
  const { calls, el, view } = await mountLogin({ phone: '138000', password: 'x'.repeat(24) });
  await view.fire('click');
  assert.equal(calls.length, 0, '⛔ 格式不对时不得发请求');
  assert.match(el.textContent, /手机号/, `提示必须指向手机号：${el.textContent}`);
});

test('登录：口令为空 ⇒ 不发请求，提示指向密码', async () => {
  const { calls, el, view } = await mountLogin({ phone: '13800000000', password: '' });
  await view.fire('click');
  assert.equal(calls.length, 0, '⛔ 口令为空时不得发请求');
  assert.match(el.textContent, /密码/, `提示必须指向密码：${el.textContent}`);
});

test('登录：手机号 + 口令都填对 ⇒ 发出请求，且请求体与输入一致', async () => {
  const { calls, view } = await mountLogin({
    phone: '13800000000',
    password: 'XpLEdKLuUV2iDLriXHZ7TbZJ',
  });
  await view.fire('click');
  assert.equal(calls.length, 1, `⛔ 合法输入必须发出 1 个请求（实际 ${calls.length}）`);
  assert.equal(calls[0].path, '/api/auth/login');
  assert.equal(calls[0].body.phone, '13800000000');
  assert.equal(calls[0].body.password, 'XpLEdKLuUV2iDLriXHZ7TbZJ');
});

test('登录：手机号前后有空格 ⇒ 发出去的必须已 trim（但口令不许被 trim）', async () => {
  const { calls, view } = await mountLogin({
    phone: '  13800000000  ',
    password: ' pw with space ',
  });
  await view.fire('click');
  assert.equal(calls.length, 1, `⛔ 合法输入必须发出请求（实际 ${calls.length}）`);
  assert.equal(calls[0].body.phone, '13800000000', '手机号必须已 trim');
  assert.equal(calls[0].body.password, ' pw with space ', '⛔ 口令不得被 trim');
});

// ─────────────────────────────────────────────────────────────────────
// 演示站模式：适配器**不校验凭据**（填什么都给一个演示管理员）
// ⇒ 演示站不该强制「11 位手机号」格式，否则「随便看看」变成了填表。
// ⚠️ 这是本轮修复引入的**回归风险**，必须有专门用例钉住。
// ─────────────────────────────────────────────────────────────────────

test('登录：演示站模式 ⇒ 不强制手机号格式（仍要求非空）', async () => {
  const { validateLoginInput } = await import('../web/views/login.js');
  // 演示站：随便一个非手机号也能过（适配器不校验凭据）
  const r = validateLoginInput({ phone: 'demo', password: 'anything' }, { isDemo: true });
  assert.equal(r.ok, true, `⛔ 演示站不该强制手机号格式：${JSON.stringify(r)}`);

  // 但**非空**仍然要拦（演示站也不能连手机号都不填就点登录）
  const empty = validateLoginInput({ phone: '', password: 'x' }, { isDemo: true });
  assert.equal(empty.ok, false, '⛔ 演示站也必须要求手机号非空');
  assert.match(empty.message, /手机号/, '提示仍应指向手机号');
});

test('登录：真实平台模式 ⇒ 强制手机号格式（默认口径，不得被演示站分档带偏）', async () => {
  const { validateLoginInput } = await import('../web/views/login.js');
  const r = validateLoginInput({ phone: 'demo', password: 'x' });
  assert.equal(r.ok, false, '⛔ 真实平台必须拒绝非手机号');
  assert.match(r.message, /手机号/, '提示应指向手机号');
});

test('登录：演示站模式下，DOM 视图也按演示口径放行（ctx.api.isDemo 生效）', async () => {
  const inputs = { phone: { value: 'demo' }, password: { value: 'anything' } };
  const el = fakeEl('', inputs);
  const calls = [];
  const api = {
    isDemo: true,
    post: async (path, body) => { calls.push({ path, body }); return { user: { id: 'u1' } }; },
  };
  globalThis.document = { createElement: () => el };
  const { renderLogin } = await import('../web/views/login.js');
  const view = renderLogin({ api, navigate: () => {}, setState: () => {} });
  await view.fire('click');
  assert.equal(calls.length, 1, `⛔ 演示站填 'demo' 也应当能登录（实际 ${calls.length} 个请求）`);
  assert.equal(calls[0].body.phone, 'demo');
});

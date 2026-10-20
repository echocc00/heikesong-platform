// platform/test/web.test.js —— 前端骨架的行为
//
// 规则溯源：
//   - 「登录后刷新页面仍应是登录态」→ 设计文档 §8（会话在服务端，Cookie 承载）；
//     Task 7 评审修正 F-5b：前端从不调 /api/me → 登录后 F5 显示「未登录」，
//     而 Cookie 其实还有效、接口也还能用。
//   - 原生 ESM、无构建 → 前端模块可以被 Node 直接 import（配合最小 DOM 桩）。
//
// ⚠️ 用 `?v=N` 制造不同的模块实例 —— ESM 模块默认只求值一次，
//    而这里需要用不同的 fetch 行为各跑一次「启动」。
import test from 'node:test';
import assert from 'node:assert/strict';

function installDom() {
  const state = { rendered: null, calls: [] };
  const fakeEl = () => ({
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    querySelector: () => ({ addEventListener: () => {}, textContent: '', value: '' }),
    addEventListener: () => {},
    replaceChildren: (el) => { state.rendered = el; },
  });
  globalThis.window = {
    location: { search: '', hash: '' },
    addEventListener: () => {},
  };
  globalThis.document = {
    getElementById: () => fakeEl(),
    createElement: () => fakeEl(),
  };
  return state;
}

async function bootApp({ meStatus, meBody, tag }) {
  const state = installDom();
  state.calls = [];
  globalThis.fetch = async (url) => {
    state.calls.push(url);
    if (url === '/api/me') {
      return {
        ok: meStatus < 400,
        status: meStatus,
        text: async () => JSON.stringify(meBody),
      };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  // ?v=tag → 每个用例一个独立的模块实例（否则 ESM 只求值一次）
  await import(`../web/app.js?v=${tag}`);
  // 让顶层的 await 与首屏渲染落地
  await new Promise((r) => setTimeout(r, 20));
  return state;
}

test('启动时先恢复会话：/api/me 成功 → 首屏显示已登录', async () => {
  const state = await bootApp({
    meStatus: 200,
    meBody: { user: { id: 'u_1', name: '甲', phone: '13800000000' } },
    tag: 'ok',
  });
  assert.ok(
    state.calls.includes('/api/me'),
    `启动时必须调 /api/me 恢复会话，实际请求：${JSON.stringify(state.calls)}`,
  );
  assert.ok(state.rendered, '首屏应被渲染');
  assert.match(state.rendered.innerHTML, /已登录/, '首屏应显示已登录');
  assert.match(state.rendered.innerHTML, /甲/, '首屏应显示当前用户');
});

test('启动时 /api/me 返回 401 → 首屏显示未登录，且不抛异常', async () => {
  const state = await bootApp({
    meStatus: 401,
    meBody: { error: { code: 'UNAUTHENTICATED', message: '未登录' } },
    tag: '401',
  });
  assert.ok(state.calls.includes('/api/me'), '启动时必须尝试恢复会话');
  assert.ok(state.rendered, '首屏应被渲染');
  assert.match(state.rendered.innerHTML, /未登录/, '首屏应显示未登录');
});

test('恢复会话失败（网络异常）也不能让首屏崩掉', async () => {
  const state = installDom();
  globalThis.fetch = async (url) => {
    if (url === '/api/me') throw new Error('network down');
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await import('../web/app.js?v=neterr');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(state.rendered, '首屏应被渲染');
  assert.match(state.rendered.innerHTML, /未登录/, '恢复失败时应回落到未登录');
});

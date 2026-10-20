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

// ══════════════════════════════════════════════════════════════════
// 终审修复轮 3 的前端回归用例
// ══════════════════════════════════════════════════════════════════

test('服务端返回的用户名里的 HTML 必须被转义，不得成为可执行标记（终审 I-2）', async () => {
  // ⛔ 终审发现（Important）：web/app.js 把 user.name 原样插进 innerHTML。
  //    P0 的 name 只由 seed 写入（不可远程利用），但 P1 的「报名」端点让用户
  //    自选 name → 立刻变成**可远程利用的存储型 XSS**。
  //    同一项目的 web/views/login.js 用的是 err.textContent（安全）——
  //    说明作者知道要转义，只是 app.js 两处漏了。
  const payload = '<img src=x onerror="alert(document.domain)">';
  const state = await bootApp({
    meStatus: 200,
    meBody: { user: { id: 'u_1', name: payload, phone: '13800000000' } },
    tag: 'xss',
  });
  assert.ok(state.rendered, '首屏应被渲染');
  const html = state.rendered.innerHTML;
  assert.ok(
    !html.includes(payload),
    `原始 payload 不得出现在 innerHTML 里（可执行标记）：${html}`,
  );
  assert.ok(
    !/<img/i.test(html),
    `渲染结果不得出现真实的 <img> 标签：${html}`,
  );
  assert.ok(
    html.includes('&lt;img'),
    `payload 必须被转义成 &lt;img：${html}`,
  );
});

test('渲染错误信息时也不得把错误消息当标记插入（终审 I-2）', async () => {
  // app.js 的第二处 sink：catch 分支把 e.message 插进 innerHTML。
  // ⚠️ 必须**真的走到 catch 分支** —— 让视图渲染抛一个带 HTML 的错误，
  //    否则这条用例就只是测了 escapeHtml 工具本身，sink 没被覆盖。
  //    这里用的 DOM 桩让 getElementById 返回**同一个** app 元素，
  //    否则 app.innerHTML 写到的是一个一次性的临时对象上，断言拿不到内容。
  const payload = '<script>alert(1)</script>';
  const appEl = { innerHTML: '', replaceChildren: () => {} };
  globalThis.window = { location: { search: '', hash: '' }, addEventListener: () => {} };
  globalThis.document = {
    getElementById: () => appEl,
    // 让 renderHome 在创建元素时抛错 → render() 进 catch 分支
    createElement: () => { throw new Error(payload); },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  await import('../web/app.js?v=xsserr2');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(appEl.innerHTML.includes('card err'), `必须走过 catch 分支：${appEl.innerHTML}`);
  assert.ok(
    !appEl.innerHTML.includes(payload),
    `原始 payload 不得出现在错误渲染里（可执行标记）：${appEl.innerHTML}`,
  );
  assert.ok(
    appEl.innerHTML.includes('&lt;script&gt;'),
    `错误消息必须被转义：${appEl.innerHTML}`,
  );
});

test('登录按钮真的可点：点一下就发 /api/auth/login（终审 I-6-8）', async () => {
  // ⛔ 终审发现（Important）：「能登录的空系统」的**用户可见入口**（前端按钮）零覆盖。
  //    后端登录测了十几条，前端「点按钮 → 发请求 → 跳首页」一条没有。
  //    把 web/views/login.js 里的事件名改掉（click → dblclick）全量测试照样全绿。
  //
  // 这里需要能捕获 addEventListener 注册的处理函数 —— installDom 的桩做不到，
  // 所以单独装一个能按选择器返回元素、并记录监听器的 DOM 桩。
  const listeners = new Map();
  const makeEl = (id) => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    addEventListener: (evt, fn) => { listeners.set(`${id}:${evt}`, fn); },
  });
  const button = makeEl('submit');
  const phone = makeEl('phone');
  const password = makeEl('password');
  const err = makeEl('err');
  phone.value = ' 13800000000 ';
  password.value = 'pw123';
  globalThis.window = { location: { search: '', hash: '' }, addEventListener: () => {} };
  globalThis.document = {
    createElement: () => ({
      className: '',
      innerHTML: '',
      textContent: '',
      querySelector: (sel) => {
        if (sel === '#submit') return button;
        if (sel === '#phone') return phone;
        if (sel === '#password') return password;
        if (sel === '#err') return err;
        return makeEl('x');
      },
      addEventListener: () => {},
    }),
    getElementById: () => ({ innerHTML: '', replaceChildren: () => {} }),
  };

  const calls = [];
  const ctx = {
    api: {
      post: async (url, body) => { calls.push({ url, body }); return { user: { id: 'u_1', name: '甲' } }; },
      get: async () => ({ user: null }),
    },
    navigate: (p) => calls.push({ navigate: p }),
    setState: () => {},
    getState: () => ({ user: null }),
  };
  const { renderLogin } = await import('../web/views/login.js');
  renderLogin(ctx);

  const handler = listeners.get('submit:click');
  assert.ok(handler, '登录按钮必须注册 click 处理函数（事件名被改就会没有）');
  await handler();
  const posted = calls.find((c) => c.url === '/api/auth/login');
  assert.ok(posted, `点击登录必须发 /api/auth/login，实际调用：${JSON.stringify(calls)}`);
  assert.equal(posted.body.phone, '13800000000', '手机号必须去掉首尾空白');
  assert.equal(posted.body.password, 'pw123');
  assert.ok(calls.some((c) => c.navigate === '/'), '登录成功后必须跳回首页');
});

// web/views/login.js — 登录视图
//
// ⚠️ 本轮（P6 第 12 轮）新增 `readLoginForm` / `validateLoginInput` 两个**纯函数**：
//   真机实测抓到：浏览器发出的请求里 **`phone` 是空字符串**（口令却完全正确），
//   而后端对「手机号为空」和「口令错误」返回**同一个** 401 `INVALID_CREDENTIALS`
//   ⇒ 访客看到的是「手机号或密码不正确」，**完全指错方向** —— 真因是手机号没输入。
//   ⇒ 本地先校验、**不发无谓请求**、并把提示说清楚。
//
// 纪律：输入校验的判据必须**可测**（纯函数导出），不能只写在 DOM 事件里。
export function readLoginForm({ phone = '', password = '' } = {}) {
  return {
    phone: String(phone ?? '').trim(),
    password: String(password ?? ''),
  };
}

/**
 * 登录输入的本地校验。
 * @param {{ phone: string, password: string }} input
 * @param {{ isDemo?: boolean }} [opts] `isDemo` = 演示站（适配器不校验凭据）
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateLoginInput({ phone, password }, { isDemo = false } = {}) {
  if (!phone) {
    return { ok: false, message: '请输入手机号（上面的 13800000000 是示例占位，不是已填内容）' };
  }
  // ⚠️ **演示站不校验手机号格式**：它的适配器根本不校验凭据（填什么都给演示管理员）
  //    ⇒ 强制 11 位格式会把「随便看看」变成填表 ⇒ 破坏演示体验。
  //    真实平台才要求 11 位、以 1 开头的数字。
  if (!isDemo && !/^1\d{10}$/.test(phone)) {
    return { ok: false, message: '手机号格式不对：应为 11 位、以 1 开头的数字' };
  }
  if (!password) {
    return { ok: false, message: '请输入密码' };
  }
  return { ok: true };
}

export function renderLogin(ctx) {
  const { api, navigate } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'card login';
  wrap.innerHTML = `
    <h1>AI 商业黑客松 · 赛事平台</h1>
    <p class="muted">用报名手机号登录</p>
    <label>手机号<input id="phone" autocomplete="username" placeholder="13800000000" /></label>
    <label>密码<input id="password" type="password" autocomplete="current-password" /></label>
    <button id="submit">登录</button>
    <p id="err" class="err"></p>
  `;
  const err = wrap.querySelector('#err');
  wrap.querySelector('#submit').addEventListener('click', async () => {
    err.textContent = '';
    const form = readLoginForm({
      phone: wrap.querySelector('#phone').value,
      password: wrap.querySelector('#password').value,
    });
    // ⛔ 本地先校验：手机号为空时**不发请求** ——
    //    否则后端会回「手机号或密码不正确」，把「没填手机号」误报成「口令错」。
    const check = validateLoginInput(form, { isDemo: !!ctx.api?.isDemo });
    if (!check.ok) {
      err.textContent = check.message;
      return;
    }
    try {
      const res = await api.post('/api/auth/login', { phone: form.phone, password: form.password });
      ctx.setState({ user: res.user });
      navigate('/');
    } catch (e) {
      err.textContent = e.message;
    }
  });
  return wrap;
}

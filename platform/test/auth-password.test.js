import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTempDir } from '../test-helpers/tmp.js';
import { callJson } from '../test-helpers/http-call.js';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser, getUserById } from '../src/db/repo/users.js';
import { createApp } from '../src/server.js';
import {
  changePassword, logoutAllSessions, checkPasswordPolicy, PASSWORD_MIN_LENGTH,
} from '../src/services/auth.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));

/** 起一套完整的服务端环境（库 + 规则 + 应用）。 */
function setup({ phone = '13900000001', password = 'oldPassw0rd' } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'heikesong-authpwd-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const user = createUser(db, { name: '甲', phone, password, mbaStatus: 'mba' });
  const webDir = join(dataDir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app, user, phone, password };
}

/** 登录并取回会话 token。 */
async function login(app, phone, password) {
  const res = await callJson(app, 'POST', '/api/auth/login', { body: { phone, password } });
  const cookie = res.headers['Set-Cookie'] || '';
  const token = (cookie.split(';')[0] || '').replace(/^hk_session=/, '');
  return { res, token };
}

/** 改口令 */
function change(app, token, oldPassword, newPassword) {
  return callJson(app, 'POST', '/api/auth/password', {
    token,
    body: { oldPassword, newPassword },
  });
}

test('改口令：未登录 ⇒ 401（不许匿名改任何人的口令）', async () => {
  const s = setup();
  try {
    const res = await change(s.app, null, 'oldPassw0rd', 'newPassw0rd');
    assert.equal(res.status, 401, `应 401，实际 ${res.status} ${res.text}`);
    // 原口令仍然有效 ⇒ 匿名请求没造成任何副作用
    const { res: loginRes } = await login(s.app, s.phone, s.password);
    assert.equal(loginRes.status, 200, '匿名改口令不得影响原口令');
  } finally { s.close(); }
});

test('改口令：原口令错 ⇒ 401 INVALID_CREDENTIALS，且不改口令', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, 'wrongOldPw', 'newPassw0rd');
    assert.equal(res.status, 401, `应 401，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'INVALID_CREDENTIALS');
    // 判别性：口令必须**没被改掉** —— 旧口令还能登录，新口令不能
    const { res: old } = await login(s.app, s.phone, s.password);
    assert.equal(old.status, 200, '原口令必须仍然可用');
    const { res: neu } = await login(s.app, s.phone, 'newPassw0rd');
    assert.equal(neu.status, 401, '新口令不得生效');
  } finally { s.close(); }
});

test('改口令：新口令太短 ⇒ 400 PASSWORD_TOO_SHORT，且不改口令', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, s.password, 'a'.repeat(PASSWORD_MIN_LENGTH - 1));
    assert.equal(res.status, 400, `应 400，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'PASSWORD_TOO_SHORT');
    const { res: old } = await login(s.app, s.phone, s.password);
    assert.equal(old.status, 200, '策略不通过时不得改动口令');
  } finally { s.close(); }
});

test('改口令：新口令为空 ⇒ 400 PASSWORD_REQUIRED', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, s.password, '');
    assert.equal(res.status, 400, `应 400，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'PASSWORD_REQUIRED');
  } finally { s.close(); }
});

test('改口令：新口令与原口令相同 ⇒ 400 PASSWORD_REUSED（不算改成功）', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, s.password, s.password);
    assert.equal(res.status, 400, `应 400，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'PASSWORD_REUSED');
  } finally { s.close(); }
});

test('改口令：新口令超长 ⇒ 400 PASSWORD_TOO_LONG（防超长口令拖垮 scrypt）', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, s.password, 'x'.repeat(129));
    assert.equal(res.status, 400, `应 400，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'PASSWORD_TOO_LONG');
  } finally { s.close(); }
});

test('改口令：成功 ⇒ 200；旧口令失效、新口令可用', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, s.password, 'brandNewPassw0rd');
    assert.equal(res.status, 200, `应 200，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.ok, true);
    const { res: old } = await login(s.app, s.phone, s.password);
    assert.equal(old.status, 401, '旧口令必须失效');
    const { res: neu } = await login(s.app, s.phone, 'brandNewPassw0rd');
    assert.equal(neu.status, 200, '新口令必须可用');
  } finally { s.close(); }
});

test('改口令后：别的设备的会话全部作废，当前这次仍有效', async () => {
  const s = setup();
  try {
    const a = await login(s.app, s.phone, s.password);   // 设备 A
    const b = await login(s.app, s.phone, s.password);   // 设备 B
    assert.notEqual(a.token, b.token, '两次登录必须是不同会话');
    const res = await change(s.app, a.token, s.password, 'brandNewPassw0rd');
    assert.equal(res.status, 200, `应 200，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.revokedSessions, 1, '恰好作废 1 个别的会话');

    // 设备 A（当前）仍有效
    const meA = await callJson(s.app, 'GET', '/api/me', { token: a.token });
    assert.equal(meA.status, 200, '当前会话必须仍然有效（改完不该被自己踢下线）');
    // 设备 B 已作废
    const meB = await callJson(s.app, 'GET', '/api/me', { token: b.token });
    assert.equal(meB.status, 401, '别的设备的会话必须作废');
  } finally { s.close(); }
});

test('强制下线：logout-all ⇒ 该用户全部会话作废（含当前）', async () => {
  const s = setup();
  try {
    const a = await login(s.app, s.phone, s.password);
    const b = await login(s.app, s.phone, s.password);
    const res = await callJson(s.app, 'POST', '/api/auth/logout-all', { token: a.token });
    assert.equal(res.status, 200, `应 200，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.revokedSessions, 2, '两个会话都该被吊销');
    const meA = await callJson(s.app, 'GET', '/api/me', { token: a.token });
    assert.equal(meA.status, 401, '当前会话也必须被吊销（语义就是把他踢下线）');
    const meB = await callJson(s.app, 'GET', '/api/me', { token: b.token });
    assert.equal(meB.status, 401, '别的会话同样必须被吊销');
    // 与普通登出一样要下发清空 Cookie
    assert.match(res.headers['Set-Cookie'] || '', /hk_session=;/, '必须下发清空会话的 Cookie');
  } finally { s.close(); }
});

test('强制下线：未登录 ⇒ 401', async () => {
  const s = setup();
  try {
    const res = await callJson(s.app, 'POST', '/api/auth/logout-all', {});
    assert.equal(res.status, 401, `应 401，实际 ${res.status} ${res.text}`);
  } finally { s.close(); }
});

test('改口令只改口令：不动角色、能力点与停用状态', async () => {
  const s = setup();
  try {
    const { token } = await login(s.app, s.phone, s.password);
    const res = await change(s.app, token, s.password, 'brandNewPassw0rd');
    assert.equal(res.status, 200, `应 200，实际 ${res.status} ${res.text}`);
    const after = getUserById(s.db, s.user.id);
    assert.equal(after.id, s.user.id);
    assert.equal(after.active, 1, '不得因为改口令把账号停用');
    assert.equal(after.phone, s.phone, '不得改动手机号');
    assert.equal(after.name, s.user.name, '不得改动姓名');
  } finally { s.close(); }
});

test('存量弱口令账号不被新策略锁死：策略只管「新设」的口令', async () => {
  // 判别性：如果把策略套到**登录**上，这条会红（存量账号全部登不进去）
  const s = setup({ phone: '13900000009', password: 'pw' });
  try {
    const { res } = await login(s.app, s.phone, 'pw');
    assert.equal(res.status, 200, '存量账号必须照常登录');
    // 但「改成弱口令」必须被拒
    const { token } = await login(s.app, s.phone, 'pw');
    const res2 = await change(s.app, token, 'pw', 'short');
    assert.equal(res2.status, 400, '弱口令不得被写成新口令');
  } finally { s.close(); }
});

test('服务层：checkPasswordPolicy 的边界（空 / 太短 / 刚好够长 / 超长）', () => {
  assert.equal(checkPasswordPolicy('').ok, false);
  assert.equal(checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH - 1)).ok, false);
  assert.equal(checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH)).ok, true);
  assert.equal(checkPasswordPolicy('a'.repeat(128)).ok, true);
  assert.equal(checkPasswordPolicy('a'.repeat(129)).ok, false);
  assert.equal(checkPasswordPolicy(undefined).ok, false);
  assert.equal(checkPasswordPolicy(null).ok, false);
  assert.equal(checkPasswordPolicy(12345678).ok, false, '非字符串必须判不合规');
});

test('服务层：changePassword 对不存在的用户 ⇒ 401（不泄露存在性）', () => {
  const s = setup();
  try {
    assert.throws(
      () => changePassword({
        db: s.db, userId: 'no-such-user', oldPassword: 'x', newPassword: 'brandNewPassw0rd',
      }),
      (err) => err.status === 401 && err.code === 'UNAUTHENTICATED',
    );
  } finally { s.close(); }
});

test('服务层：logoutAllSessions 对不存在的用户不报错（幂等）', () => {
  const s = setup();
  try {
    const r = logoutAllSessions({ db: s.db, userId: 'no-such-user' });
    assert.equal(r.ok, true);
    assert.equal(r.revokedSessions, 0);
  } finally { s.close(); }
});

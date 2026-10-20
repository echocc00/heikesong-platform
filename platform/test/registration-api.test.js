import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

const GOOD = {
  direction: [4, 4, 4, 4, 5],
  capability: [4, 4, 4, 4, 5],
  collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题',
  consent: { accepted: true, items: [] },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-regapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31',
  });
  const user = createUser(db, { name: '选手甲', phone: '13900003001', password: 'pw', mbaStatus: 'mba' });
  const other = createUser(db, { name: '选手乙', phone: '13900003002', password: 'pw', mbaStatus: 'mba' });
  const admin = createUser(db, { name: '组委会', phone: '13900003003', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 用 P0 的仓储函数，不写裸 SQL（SQL 边界：SQL 只允许出现在 src/db/repo/）。
  //    验收修正：原来这里写的是 db.prepare('UPDATE users SET is_superadmin = 1 ...')，
  //    而本文件自己的注释又声称「不写裸 SQL」—— 自相矛盾。
  setSuperadmin(db, admin.id);
  // 「有账号但没有 registration:write 能力」的用户 —— 用来验证能力点真的被校验。
  const outsider = createUser(db, { name: '无权限者', phone: '13900003004', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 父代理预审修正（规格缺口）：**能力点必须先注册**。
  //    `grantAssignment` 会先校验 capability 是否在 `capabilities` 表里注册过
  //    （P0 的评审修正 I5 同类：入参要先校验，不把 SQLite 原文漏到 HTTP 层），
  //    不注册就抛 400 CAPABILITY_UNKNOWN —— 父代理预审实跑：9 条用例全红，
  //    报错「能力点未注册：registration:write」。
  //    这里用 P0 的仓储函数注册（**不写裸 SQL**，守住 SQL 边界）。
  insertCapability(db, 'registration:write', '提交报名');
  insertCapability(db, 'registration:review', '审核报名分级');
  grantAssignment(db, {
    userId: user.id, capability: 'registration:write', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: other.id, capability: 'registration:write', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, user, other, admin, outsider,
    tokenUser: createSession(db, user.id).token,
    tokenOther: createSession(db, other.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function call(app, method, path, { token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers: token ? { cookie: `hk_session=${token}` } : {},
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
      on() {},
    };
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

test('GET /api/registration-criteria 无需登录即可读（筛选标准对外透明）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/registration-criteria');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.dimensions.length, 3);
  assert.equal(body.levels.find((l) => l.key === 'S').minScore, 80);
  assert.equal(body.funnel.length, 5);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', { body: { editionId: s.edition.id, answers: GOOD } });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations 成功 → 返回等级与可解释明细', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.level, 'S');
  assert.equal(body.grading.explain.length, 3);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('重复提交 → 409 DUPLICATE_REGISTRATION', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  const res = await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).error.code, 'DUPLICATE_REGISTRATION');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registrations 无组委会权限 → 200 + 空集', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  const res = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenUser });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).items, []);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registrations 组委会 → 200 + 明细', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/registrations', { token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD } });
  const res = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).items.length, 1);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registrations/:id 本人可读、他人 → 404', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  const id = JSON.parse(created.body).id;
  const mine = await call(s.app, 'GET', `/api/registrations/${id}`, { token: s.tokenUser });
  assert.equal(mine.status, 200);
  const theirs = await call(s.app, 'GET', `/api/registrations/${id}`, { token: s.tokenOther });
  assert.equal(theirs.status, 404);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations/:id/level 组委会改级成功，选手改级 → 403', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  const id = JSON.parse(created.body).id;
  const byPlayer = await call(s.app, 'POST', `/api/registrations/${id}/level`, {
    token: s.tokenUser, body: { level: 'S' },
  });
  assert.equal(byPlayer.status, 403);
  const byAdmin = await call(s.app, 'POST', `/api/registrations/${id}/level`, {
    token: s.tokenAdmin, body: { level: 'B', note: '复核：能力维需补材料' },
  });
  assert.equal(byAdmin.status, 200);
  assert.equal(JSON.parse(byAdmin.body).levelFinal, 'B');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('问卷不完整 → 400 INVALID_ANSWERS，且响应体带 detail（前端要知道缺哪几题）', async () => {
  // ⚠️ 2026-10-21 验收修正（worker 报为 M7，是真实覆盖缺口）：
  //    HTTP 层的 `error.detail` 此前**零断言** —— 把 server.js 里的
  //    `error(res, status, code, message, err instanceof AppError ? err.detail : undefined)`
  //    改成不传 detail，18 条用例照样全绿。
  //    而「缺哪几题」正是前端报名页要显示的东西（detail 被吞 → 页面只能报「填写不完整」）。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser,
    body: { editionId: s.edition.id, answers: { ...GOOD, direction: [4, 4] } },
  });
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'INVALID_ANSWERS');
  assert.ok(Array.isArray(body.error.detail), `error.detail 必须是数组，实际 ${JSON.stringify(body.error.detail)}`);
  assert.ok(body.error.detail.length > 0, 'detail 必须指出缺哪几题');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('已登录但没有 registration:write 能力 → 403（能力点必须真的被校验）', async () => {
  // ⚠️ 2026-10-21 验收修正（规格缺陷）：`registration:write` 被注册、被授予，
  //    但路由从不校验 → 能力点形同虚设，违反「can() 是唯一判定入口」。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, answers: GOOD },
  });
  assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 拒绝之后不能留下任何报名记录
  const list = await call(s.app, 'GET', '/api/registrations?editionId=' + s.edition.id, { token: s.tokenAdmin });
  assert.equal(JSON.parse(list.body).items.length, 0, '被拒绝的提交不得留下记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

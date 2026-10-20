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
import { pickCurrentEdition } from '../src/http/routes/registration.js';
import { call } from '../test-helpers/http-call.js';

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

test('GET /api/registration-criteria 无需登录即可读（筛选标准对外透明）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/registration-criteria');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.dimensions.length, 3);
  assert.equal(body.levels.find((l) => l.key === 'S').minScore, 80);
  assert.equal(body.funnel.length, 5);
  // ⚠️ 2026-10-21 独立评审修正（Important I-1：合规 / IP / 赛程披露**零断言**）。
  //    这四项是 R-ENT-11 / R-ENT-12 / R-STG-01 的**唯一对外出口**
  //    （前端读不到 rules/*.json 目录，见计划 D-3）。
  //    原来把它们从 buildCriteria 里删掉，全量用例照样全绿 —— 需求在产品上静默失效。
  //    独立评审变异 V14 实测：删掉这 4 个字段 → 199 条仍全绿。
  assert.ok(body.ipOwnership && body.ipOwnership.team, 'R-ENT-11：IP 归属必须在报名页明示');
  assert.ok(Array.isArray(body.redLines) && body.redLines.length >= 5, 'R-ENT-12：合规红线必须公开');
  assert.equal(body.consent?.required, true, 'R-ENT-12：同意条款必须公开');
  assert.equal(body.schedule?.length, 5, 'R-STG-01：5 个赛段时间轴必须公开');
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
  // ⚠️ 2026-10-21 独立评审修正（Important I-2：状态机**留痕零断言**）。
  //    GET /api/registrations/:id 是 registration_events 唯一的对外出口，
  //    也是 Task 3「改级留痕」承诺的落点。
  //    原来把 events 拼装改成空数组，全量用例照样全绿（独立评审变异 V15 实测）。
  const mineBody = JSON.parse(mine.body);
  assert.equal(mineBody.events.length, 1, '刚提交完应当只有一条「提交」事件');
  assert.equal(mineBody.events[0].toStatus, 'submitted');
  assert.equal(mineBody.events[0].fromStatus, null);
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
  const adminBody = JSON.parse(byAdmin.body);
  assert.equal(adminBody.levelFinal, 'B');
  // ⚠️ 2026-10-21 独立评审修正（Important I-2：改级后**留痕零断言**）。
  //    改级必须追加一条事件，且 from_status 是改级前的状态 —— 审计链的落点。
  //    留痕的对外出口是 GET /api/registrations/:id（events 字段），
  //    所以这里改级后回读一次，把「留痕」钉在 API 层而不是只钉在仓储层。
  const after = await call(s.app, 'GET', `/api/registrations/${id}`, { token: s.tokenAdmin });
  assert.equal(after.status, 200);
  const afterBody = JSON.parse(after.body);
  assert.equal(afterBody.events.length, 2, '提交 + 改级 = 两条事件');
  assert.equal(afterBody.events[1].fromStatus, 'submitted');
  assert.equal(afterBody.events[1].toStatus, 'accepted');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/registrations/:id/level 未登录 → 401', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-5：401 路径零断言）。
  //    独立评审变异 V21：删掉路由里的 401 判断 → 全量用例照样全绿，
  //    行为会退化成 404 / 500。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenUser, body: { editionId: s.edition.id, answers: GOOD },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/registrations/${id}/level`, { body: { level: 'S' } });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'UNAUTHENTICATED');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/registration-criteria 返回当届，不是历史最早的一届', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-9：取「最早的一届」而不是「当届」）。
  //    原来 listEditions(db)[0] 永远是 starts_at 最早的那届 → 多届期场景下
  //    前端拿到的 editionId 不是当前届，报名页会引导用户报错届期。
  //    这里只断言「**历史届期不得被当成当届**」—— 不绑定具体是哪一届，
  //    避免把断言写成随日历漂移的 flaky 用例（当届是谁由真实日期决定）。
  const s = setup();
  createEdition(s.db, {
    name: '往届', city: '上海', startsAt: '2020-01-01', endsAt: '2020-12-31',
  });
  createEdition(s.db, {
    name: '在办', city: '上海', startsAt: '2099-01-01', endsAt: '2099-12-31',
  });
  const res = await call(s.app, 'GET', '/api/registration-criteria');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.notEqual(body.editionName, '往届', '历史届期不得被当成当届');
  assert.ok(body.editionId, '必须给出届期 id');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('pickCurrentEdition：按「尚未结束」挑当届，且 today 可注入（不随日历漂移）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-9）：today 必须可注入 ——
  //    否则「哪一届是当届」这条断言会随真实日历变成 flaky 用例。
  const editions = [
    { id: 'past', ends_at: '2020-12-31' },
    { id: 'now', ends_at: '2026-10-31' },
    { id: 'later', ends_at: '2099-12-31' },
  ];
  assert.equal(pickCurrentEdition(editions, '2026-10-21').id, 'now');
  assert.equal(pickCurrentEdition(editions, '2026-10-31').id, 'now', '结束当天仍算当届');
  assert.equal(pickCurrentEdition(editions, '2020-06-01').id, 'past');
  // 全部已结束 → 退回最后一届
  assert.equal(pickCurrentEdition([{ id: 'a', ends_at: '2019-01-01' }], '2026-10-21').id, 'a');
  // 空集 → null
  assert.equal(pickCurrentEdition([], '2026-10-21'), null);
  assert.equal(pickCurrentEdition(null, '2026-10-21'), null);
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

test('edition 作用域的 registration:write 授权也能报名（能力点校验要带作用域）', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-6：作用域授权被误拒）。
  //    原来路由传 `ctx = null` —— `can()` 在 ctx 为空时**跳过**资源级授权的 scope 匹配
  //    → 只有 scope_type='global' 的授权能通过，
  //    组委会若用 scope_type='edition' 授予 registration:write，该用户**无法报名**
  //    （独立评审探针实测：global 授权 can(null ctx)=true / edition 授权 can(null ctx)=false）。
  const s = setup();
  const scoped = createUser(s.db, { name: '届期授权者', phone: '13900003005', password: 'pw', mbaStatus: 'mba' });
  grantAssignment(s.db, {
    userId: scoped.id, capability: 'registration:write',
    scopeType: 'edition', scopeId: s.edition.id, grantedBy: s.admin.id,
  });
  const token = createSession(s.db, scoped.id).token;
  const res = await call(s.app, 'POST', '/api/registrations', {
    token, body: { editionId: s.edition.id, answers: GOOD },
  });
  assert.equal(res.status, 200, `edition 作用域授权必须放行，实际 ${res.status}`);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

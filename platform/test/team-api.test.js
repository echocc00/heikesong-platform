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
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const GOOD = {
  direction: [4, 4, 4, 4, 5], capability: [4, 4, 4, 4, 5], collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题', consent: { accepted: true },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-teamapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31',
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900006001', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const captain = createUser(db, { name: '队长甲', phone: '13900006002', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(db, { name: '成员乙', phone: '13900006003', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900006004', password: 'pw', mbaStatus: 'mba' });
  const admin = createUser(db, { name: '组委会', phone: '13900006005', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  for (const u of [captain, member, outsider]) {
    insertRegistration(db, {
      editionId: edition.id, userId: u.id, answers: GOOD, rawScore: 80,
      level: 'S', status: 'submitted', now: NOW,
    });
  }

  // 能力点必须先注册（grantAssignment 会校验 capabilities 表）
  insertCapability(db, 'team:create', '创建战队');
  insertCapability(db, 'team:read', '读取战队');
  insertCapability(db, 'team:manage', '管理战队成员');
  grantAssignment(db, {
    userId: captain.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: member.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, pkg, captain, member, outsider, admin,
    tokenCaptain: createSession(db, captain.id).token,
    tokenMember: createSession(db, member.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
    tokenAdmin: createSession(db, admin.id).token,
  };
}

async function createTeamViaApi(s, token, name = '甲队') {
  const res = await call(s.app, 'POST', '/api/teams', {
    token, body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

test('POST /api/teams 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/teams', {
    body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name: '甲队' },
  });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams 已登录但无 team:create 能力 → 403（能力点必须真的被校验）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical）：`team:create` 被注册、被 seed 授予，
  //    但路由从不校验 → 能力点形同虚设（与 Task 3 的 A1、Task 4 的 T4-5 同类）。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name: '甲队' },
  });
  assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 拒绝之后不得留下任何战队
  const list = await call(s.app, 'GET', '/api/teams', { token: s.tokenCaptain });
  assert.equal(JSON.parse(list.body).items.length, 0);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams 有权限 → 200 + 战队视图', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  assert.equal(team.status, 'forming');
  assert.equal(team.memberCount, 1);
  assert.equal(team.members[0].role, 'captain');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/teams 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/teams');
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/teams/:id 非成员读不到 → 404；成员可读 → 200', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const theirs = await call(s.app, 'GET', `/api/teams/${team.id}`, { token: s.tokenOutsider });
  assert.equal(theirs.status, 404);
  const mine = await call(s.app, 'GET', `/api/teams/${team.id}`, { token: s.tokenCaptain });
  assert.equal(mine.status, 200);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 add 只能自己加入（不能替别人加）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical）：原来把 `body.userId` 直接交给服务层
  //    → 任何登录用户都能替别人加入战队。
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'add', userId: s.captain.id },
  });
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.memberCount, 2);
  // 加进来的是**发起人自己**，不是 body 里指定的别人
  assert.ok(body.members.some((m) => m.userId === s.member.id));
  assert.equal(body.members.filter((m) => m.userId === s.captain.id).length, 1, '组长只能有一条成员记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 leave 不能踢别人（越权踢人防护）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical）：原来 `userId: body?.userId ?? user.id`
  //    → 客户端传别人的 id 就能把别人踢出战队（服务层不校验 actor）。
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'add' },
  });
  // 成员乙试图「退出」组长（body.userId 指向组长）
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'leave', userId: s.captain.id },
  });
  assert.ok(res.status === 200 || res.status === 404, `实际 ${res.status}`);
  // 关键断言：退出的是**发起人自己**，body.userId 指向的组长不得被踢
  const after = await call(s.app, 'GET', `/api/teams/${team.id}`, { token: s.tokenCaptain });
  const body = JSON.parse(after.body);
  assert.ok(body.members.some((m) => m.userId === s.captain.id), '组长不得被踢出');
  assert.ok(!body.members.some((m) => m.userId === s.member.id), '退出的必须是发起人自己');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 replace 非队长发起 → 403', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember, body: { action: 'add' },
  });
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenMember,
    body: { action: 'replace', outUserId: s.member.id, inUserId: s.outsider.id },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/teams/:id/members 的 action 非法 → 400 INVALID_ACTION', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const res = await call(s.app, 'POST', `/api/teams/${team.id}/members`, {
    token: s.tokenCaptain, body: { action: 'destroy' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_ACTION');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('PATCH /api/teams/:id 非队长 → 403；队长 → 200', async () => {
  const s = setup();
  const team = await createTeamViaApi(s, s.tokenCaptain);
  const byOther = await call(s.app, 'PATCH', `/api/teams/${team.id}`, {
    token: s.tokenMember, body: { name: '被改的名字' },
  });
  assert.equal(byOther.status, 403);
  const byCaptain = await call(s.app, 'PATCH', `/api/teams/${team.id}`, {
    token: s.tokenCaptain, body: { name: '甲队新名字' },
  });
  assert.equal(byCaptain.status, 200);
  assert.equal(JSON.parse(byCaptain.body).name, '甲队新名字');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/teams 只返回自己参与的战队', async () => {
  const s = setup();
  await createTeamViaApi(s, s.tokenCaptain);
  const mine = await call(s.app, 'GET', '/api/teams', { token: s.tokenCaptain });
  assert.equal(JSON.parse(mine.body).items.length, 1);
  const others = await call(s.app, 'GET', '/api/teams', { token: s.tokenMember });
  assert.equal(JSON.parse(others.body).items.length, 0);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

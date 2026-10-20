// platform/test/e2e-p1.test.js —— P1 端到端串联
//
// 依据：P1 计划 Task 7「端到端串联 + 种子扩充 + 验收」
// 溯源需求：R-REG-01 / R-REG-02 / R-REG-05 / R-REG-08 / R-STG-03 / R-ENT-08 / R-ENT-09
//
// ⚠️ 本文件刻意分两层：
//   ① **服务层**全链路（计划原规格的两条）：验证业务规则串起来是对的；
//   ② **HTTP 层**全链路（Task 7 预审新增）：验证**路由层**也串得起来。
//      为什么必须补这一层：Task 3 / Task 4 / Task 5 的真实缺陷**全部出在路由层**
//      （能力点校验没接线、列表端点缺字段、越权踢人），服务层测不出来。
//   ③ **种子产物**的三条：种子是演示版唯一的数据来源，它的正确性不能靠肉眼看控制台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { submitRegistration } from '../src/services/registration.js';
import { assessSolvability, approveTaskPackage, listTaskPackages } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';
import { checkTaskMix } from '../src/domain/solvability.js';
import { can, grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');
const webDir = join(platformDir, 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const ANSWERS = {
  direction: [5, 5, 5, 5, 5],
  capability: [5, 5, 5, 5, 5],
  collaboration: [5, 5, 5, 5, 5],
  open: '我想解决连锁门店的排班与库存协同问题',
  consent: { accepted: true },
};
const FULL_SOLVABILITY = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  return { db, close, dataDir, rules, edition };
}

// ── ① 服务层全链路 ────────────────────────────────────────────────────────

test('全链路：报名 → 分级 → 建队（认领任务包）→ 加人 → 战队成立', () => {
  const s = setup();
  const captain = createUser(s.db, { name: '队长', phone: '13900006001', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(s.db, { name: '组员', phone: '13900006002', password: 'pw', mbaStatus: 'mba' });

  // 1) 企业出题 → 2) 六维评估 → 3) 分级签约
  const pkg = createTaskPackage(s.db, {
    editionId: s.edition.id, enterpriseName: '某零售', title: '门店排班优化',
    painPoint: 'p', expectedDelivery: 'd', acceptanceCriteria: 'a',
    submittedBy: captain.id, now: NOW,
  });
  assessSolvability({
    db: s.db, taskPackageId: pkg.id, answers: FULL_SOLVABILITY, actorId: captain.id, now: NOW, rules: s.rules,
  });
  const approved = approveTaskPackage({
    db: s.db, taskPackageId: pkg.id, grade: 'A', actorId: captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(approved.grade, 'A');
  assert.equal(approved.status, 'published');

  // 4) 报名 → 自动分级
  const reg1 = submitRegistration({
    db: s.db, userId: captain.id, editionId: s.edition.id, answers: ANSWERS, now: NOW, rules: s.rules,
  });
  const reg2 = submitRegistration({
    db: s.db, userId: member.id, editionId: s.edition.id, answers: ANSWERS, now: NOW, rules: s.rules,
  });
  assert.equal(reg1.level, 'S');
  assert.equal(reg1.grading.accepted, true);
  assert.equal(reg2.level, 'S');

  // 5) 建队即认领任务包
  const team = createTeam({
    db: s.db, userId: captain.id, editionId: s.edition.id,
    taskPackageId: pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.equal(team.taskPackageId, pkg.id);
  assert.equal(team.status, 'forming');
  assert.equal(team.memberCount, 1);
  assert.equal(team.milestones.items.length, 7, 'R-STG-03：里程碑清单在组队时固定');

  // 6) 加人 → 满 2 人即成立
  const after = addMember({
    db: s.db, teamId: team.id, userId: member.id, actorId: captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(after.memberCount, 2);
  assert.equal(after.status, 'active');
  assert.equal(after.formation.ok, true);

  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('全链路：C 级报名被拒 → 不能入队（R-REG-08）', () => {
  const s = setup();
  const captain = createUser(s.db, { name: '队长', phone: '13900006101', password: 'pw', mbaStatus: 'mba' });
  const weak = createUser(s.db, { name: '弱', phone: '13900006102', password: 'pw', mbaStatus: 'mba' });
  const pkg = createTaskPackage(s.db, {
    editionId: s.edition.id, title: '题', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: captain.id, now: NOW,
  });
  assessSolvability({
    db: s.db, taskPackageId: pkg.id, answers: FULL_SOLVABILITY, actorId: captain.id, now: NOW, rules: s.rules,
  });
  approveTaskPackage({ db: s.db, taskPackageId: pkg.id, grade: 'A', actorId: captain.id, now: NOW, rules: s.rules });

  submitRegistration({
    db: s.db, userId: captain.id, editionId: s.edition.id, answers: ANSWERS, now: NOW, rules: s.rules,
  });
  const weakReg = submitRegistration({
    db: s.db, userId: weak.id, editionId: s.edition.id,
    answers: {
      direction: [1, 1, 1, 1, 1], capability: [1, 1, 1, 1, 1], collaboration: [1, 1, 1, 1, 1],
      open: '还在想', consent: { accepted: true },
    },
    now: NOW, rules: s.rules,
  });
  assert.equal(weakReg.level, 'C');
  assert.equal(weakReg.grading.accepted, false);

  const team = createTeam({
    db: s.db, userId: captain.id, editionId: s.edition.id,
    taskPackageId: pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.throws(
    () => addMember({
      db: s.db, teamId: team.id, userId: weak.id, actorId: captain.id, now: NOW, rules: s.rules,
    }),
    (err) => err.code === 'REGISTRATION_NOT_ACCEPTED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

// ── ② HTTP 层全链路（Task 7 预审新增）────────────────────────────────────

function setupHttp() {
  const s = setup();
  const { db, rules, edition } = s;
  const captain = createUser(db, { name: '队长', phone: '13900006201', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(db, { name: '组员', phone: '13900006202', password: 'pw', mbaStatus: 'mba' });
  const enterprise = createUser(db, { name: '企业', phone: '13900006203', password: 'pw', mbaStatus: 'other' });
  const admin = createUser(db, { name: '组委会', phone: '13900006204', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '路人', phone: '13900006205', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  // 能力点必须先注册（grantAssignment 会校验）—— 不注册会抛 CAPABILITY_UNKNOWN
  for (const [key, desc] of [
    ['registration:write', '提交报名'], ['registration:review', '审核报名分级'],
    ['team:create', '创建战队'], ['team:read', '读取战队'], ['team:manage', '管理战队成员'],
    ['task_package:read', '读取任务卡'], ['task_package:write', '提交/编辑任务卡'],
    ['task_package:approve', '任务卡分级签约'],
  ]) insertCapability(db, key, desc);

  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  for (const cap of ['registration:write', 'team:create', 'team:read', 'task_package:read']) grant(captain.id, cap);
  for (const cap of ['registration:write', 'team:read', 'task_package:read']) grant(member.id, cap);
  for (const cap of ['task_package:write', 'task_package:read']) grant(enterprise.id, cap);

  const app = createApp({ db, rules, webDir });
  return {
    ...s,
    app,
    captain, member, enterprise, admin, outsider,
    tokenCaptain: createSession(db, captain.id).token,
    tokenMember: createSession(db, member.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

test('HTTP 全链路：出题 → 评估 → 签级 → 报名 → 建队 → 加人 → 成立', async () => {
  const s = setupHttp();
  const json = (res) => JSON.parse(res.body);

  // 1) 企业提交任务卡（HTTP 层走能力点校验）
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise,
    body: {
      editionId: s.edition.id, title: '门店排班优化', painPoint: 'p',
      expectedDelivery: 'd', acceptanceCriteria: 'a', consent: { accepted: true },
    },
  });
  assert.equal(created.status, 200, `企业出题应成功：${created.body}`);
  const pkgId = json(created).id;

  // 2) 六维评估 → 3) 组委会签级（超管）
  const assessed = await call(s.app, 'POST', `/api/task-packages/${pkgId}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL_SOLVABILITY },
  });
  assert.equal(assessed.status, 200, `六维评估应成功：${assessed.body}`);
  const approved = await call(s.app, 'POST', `/api/task-packages/${pkgId}/approve`, {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(approved.status, 200, `签级应成功：${approved.body}`);
  assert.equal(json(approved).grade, 'A');

  // 4) 队长报名 → 5) 建队（认领任务包）
  const reg = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, answers: ANSWERS },
  });
  assert.equal(reg.status, 200, `报名应成功：${reg.body}`);
  assert.equal(json(reg).level, 'S');
  const regId = json(reg).id;

  const team = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenCaptain,
    body: { editionId: s.edition.id, taskPackageId: pkgId, name: '甲队' },
  });
  assert.equal(team.status, 200, `建队应成功：${team.body}`);
  const teamId = json(team).id;
  assert.equal(json(team).status, 'forming');
  assert.equal(json(team).taskPackageId, pkgId, '建队即认领任务包（R-REG-01）');

  // 6) 组员自助加入 → 满 2 人即成立
  const memberReg = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenMember, body: { editionId: s.edition.id, answers: ANSWERS },
  });
  assert.equal(memberReg.status, 200);
  const joined = await call(s.app, 'POST', `/api/teams/${teamId}/members`, {
    token: s.tokenMember, body: { action: 'add' },
  });
  assert.equal(joined.status, 200, `组员加入应成功：${joined.body}`);
  assert.equal(json(joined).memberCount, 2);
  assert.equal(json(joined).status, 'active');

  // 7) 「我的战队」可见
  const mine = await call(s.app, 'GET', '/api/teams', { token: s.tokenCaptain });
  assert.equal(mine.status, 200);
  assert.equal(json(mine).items.length, 1);
  assert.equal(json(mine).items[0].id, teamId);

  // 8) 组委会看得到报名 + 事件轨迹（Task 6 的列表端点修复在 HTTP 层生效）
  const all = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(all.status, 200);
  assert.equal(json(all).items.length, 2);
  assert.ok(Array.isArray(json(all).items[0].events), '列表必须带事件轨迹');
  assert.ok(json(all).items[0].events.length >= 1, '提交报名本身就是一条轨迹');

  // 9) 委员会改级 → 选手读到的终态
  const decided = await call(s.app, 'POST', `/api/registrations/${regId}/level`, {
    token: s.tokenAdmin, body: { level: 'B', note: '复核降级' },
  });
  assert.equal(decided.status, 200, `改级应成功：${decided.body}`);
  assert.equal(json(decided).levelFinal, 'B');

  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('HTTP 层：能力点拦截 + 可见性过滤（三态状态码）', async () => {
  const s = setupHttp();
  const json = (res) => JSON.parse(res.body);

  // 无 team:create 的路人 → 403（禁用），不是 404
  const denied = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenOutsider,
    body: { editionId: s.edition.id, taskPackageId: 'nope', name: '野队' },
  });
  assert.equal(denied.status, 403, `无建队权限应 403：${denied.body}`);

  // 未登录 → 401
  const anon = await call(s.app, 'POST', '/api/teams', {
    body: { editionId: s.edition.id, taskPackageId: 'nope', name: '野队' },
  });
  assert.equal(anon.status, 401);

  // 选手读报名列表 → 200 + 空集（可见性在 API 层过滤）
  const list = await call(s.app, 'GET', `/api/registrations?editionId=${s.edition.id}`, { token: s.tokenCaptain });
  assert.equal(list.status, 200);
  assert.deepEqual(json(list).items, [], '无 registration:review 的选手看不到任何报名');

  // 读他人报名 → 404
  const reg = await call(s.app, 'POST', '/api/registrations', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, answers: ANSWERS },
  });
  const other = await call(s.app, 'GET', `/api/registrations/${json(reg).id}`, { token: s.tokenMember });
  assert.equal(other.status, 404, `读他人报名应 404：${other.body}`);

  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

// ── ③ 种子产物（Task 7 预审新增）──────────────────────────────────────────

/**
 * 跑真实种子脚本（子进程）。
 * ⛔ 用**子进程**而不是 import：种子脚本有顶层副作用（建管理员、退出码 1 等），
 *    部署手册里执行的就是这个脚本 —— 测它就该测它本身。
 */
function runSeed(dataDir) {
  return execFileSync(process.execPath, [join(platformDir, 'scripts', 'seed.js')], {
    cwd: platformDir,
    env: { ...process.env, ADMIN_PASSWORD: 'e2e-test-admin-pw', DATA_DIR: dataDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function openSeeded(dataDir) {
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  return { db, close, rules };
}

test('种子产物：每个用户都被授予角色，能力点真的生效（演示版不能是死的）', () => {
  // ⚠️ Task 7 预审修正（Critical）：原规格建了 4 个选手 + 1 个企业代表却**没授角色**
  //    → 演示版里他们登录后报名 403、建队 403、看不到任务包，整个演示是死的。
  //    这里断言的是**能力点的实际效果**（can() 是唯一判定入口），不是数据表内容。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  runSeed(dataDir);
  const { db, close, rules } = openSeeded(dataDir);

  const byName = (name) => db.prepare(
    "SELECT id, name FROM users WHERE name = ? AND active = 1",
  ).get(name);

  const captain = byName('队长甲');
  const member = byName('组员乙');
  const enterprise = byName('某零售·企业代表');
  assert.ok(captain && member && enterprise, '种子必须建出这三个用户');

  assert.equal(can(captain, 'registration:write', null, db), true, '队长必须能报名');
  assert.equal(can(captain, 'team:create', null, db), true, '队长必须能建队');
  assert.equal(can(captain, 'task_package:read', null, db), true, '队长必须能看见已发布的任务包');
  assert.equal(can(member, 'registration:write', null, db), true, '组员必须能报名');
  assert.equal(can(member, 'task_package:read', null, db), true, '组员必须能看见已发布的任务包');
  assert.equal(can(member, 'team:create', null, db), false, '组员不该有建队权限');
  assert.equal(can(enterprise, 'task_package:write', null, db), true, '企业必须能出题');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('种子产物：进池 10 张卡，配比精确命中 R-ENT-09（40/20/10/30），D 级已出诊断报告', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  runSeed(dataDir);
  const { db, close, rules } = openSeeded(dataDir);

  // ⚠️ 只能用**服务层呈现的驼峰形状**喂 checkTaskMix ——
  //    它读 `p.isFreeBrief`，喂数据库行（`is_free_brief`）会把自由题算成 0
  //    （Task 4 的 T4-2 形状错配，预审时本任务自己又踩了一次）。
  const items = listTaskPackages({ db, filter: {}, viewer: { id: 'seed', is_superadmin: 1 }, rules });
  const published = items.filter((p) => p.status === 'published');
  const mix = checkTaskMix(published, rules.solvability);
  assert.equal(mix.ok, true, `配比必须达标：${JSON.stringify(mix.errors)}`);
  assert.equal(mix.total, 10);
  assert.equal(mix.free, 3);
  assert.equal(mix.byGrade.A, 4);
  assert.equal(mix.byGrade.B, 2);
  assert.equal(mix.byGrade.C, 1);

  // 自由题必须**已签级并进池**（原规格 grade: null → 永远不进池 → 自由占比恒 0）
  const free = published.filter((p) => p.isFreeBrief);
  assert.equal(free.length, 3, '三张自由题必须进池');
  assert.ok(free.every((p) => p.grade), '自由题也必须签级');
  assert.ok(free.every((p) => p.commitment === '无'), 'R-ENT-10：自由命题无企业签字');

  // D 级卡：退回 + 出《问题可解性诊断报告》（R-ENT-08）
  const d = items.find((p) => p.grade === 'D');
  assert.ok(d, '必须有一张 D 级卡用于演示');
  assert.equal(d.status, 'returned');
  assert.equal(d.meta?.solvability?.diagnosticReport?.title, '问题可解性诊断报告');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('种子产物：跑第二遍不崩、数据不翻倍（部署时会重跑种子）', () => {
  // ⚠️ Task 7 预审修正（Important）：原规格直接 createUser → 第二次跑
  //    PHONE_TAKEN（409）直接崩 —— 部署手册里的「跑一次种子」会变成地雷。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  runSeed(dataDir);
  const out = runSeed(dataDir);
  assert.ok(out.includes('P1 种子'), `第二遍种子仍应跑通：${out}`);

  const { db, close, rules } = openSeeded(dataDir);
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count('SELECT COUNT(*) n FROM task_packages'), 11, '任务卡不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM registrations'), 4, '报名不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM teams'), 1, '战队不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM editions'), 1, '届期不得翻倍');
  assert.equal(count('SELECT COUNT(*) n FROM cities'), 1, '城市不得翻倍');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

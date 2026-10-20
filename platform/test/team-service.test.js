import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
import {
  createTeam, getTeam, addMember, leaveTeam, replaceMember, updateTeam, checkTeamFormation,
} from '../src/services/team.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

const GOOD = {
  direction: [4, 4, 4, 4, 5], capability: [4, 4, 4, 4, 5], collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题', consent: { accepted: true },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-team-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900005901', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const pkg2 = createTaskPackage(db, {
    editionId: edition.id, title: '供应链预测', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg2.id, { solvability_grade: 'B', solvability_score: 8, status: 'published' });

  const ungraded = createTaskPackage(db, {
    editionId: edition.id, title: '未评估的题', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });

  const captain = createUser(db, { name: '队长甲', phone: '13900005001', password: 'pw', mbaStatus: 'mba' });
  const member = createUser(db, { name: '成员乙', phone: '13900005002', password: 'pw', mbaStatus: 'mba' });
  const nonMba = createUser(db, { name: '非 MBA 丙', phone: '13900005003', password: 'pw', mbaStatus: 'other' });
  const cLevel = createUser(db, { name: 'C 级丁', phone: '13900005004', password: 'pw', mbaStatus: 'mba' });

  for (const u of [captain, member, nonMba, cLevel]) {
    insertRegistration(db, {
      editionId: edition.id, userId: u.id, answers: GOOD, rawScore: 80,
      level: u.id === cLevel.id ? 'C' : 'S', status: 'submitted', now: NOW,
    });
  }

  return { db, close, dataDir, rules, edition, pkg, pkg2, ungraded, captain, member, nonMba, cLevel };
}

test('checkTeamFormation：人数不足 / 组长非 MBA / 任务包未分级 各自报错', () => {
  const { rules } = setup();
  const captain = { mba_status: 'other' };
  const members = [{ user_id: 'u1' }];
  const r = checkTeamFormation({
    team: { id: 't1' }, captain, members, taskPackage: { solvability_grade: null },
    config: rules.teamFormation,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('[CAPTAIN_MBA_REQUIRED]')));
  assert.ok(r.errors.some((e) => e.includes('[TEAM_BELOW_MIN_SIZE]')));
  assert.ok(r.errors.some((e) => e.includes('[TASK_PACKAGE_NOT_GRADED]')));
});

test('队长非 MBA → 建队被拒（R-REG-05 硬门槛）', () => {
  const s = setup();
  assert.throws(
    () => createTeam({
      db: s.db, userId: s.nonMba.id, editionId: s.edition.id,
      taskPackageId: s.pkg.id, name: '丙队', now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'CAPTAIN_MBA_REQUIRED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('任务包未分级 → 建队被拒', () => {
  const s = setup();
  assert.throws(
    () => createTeam({
      db: s.db, userId: s.captain.id, editionId: s.edition.id,
      taskPackageId: s.ungraded.id, name: '甲队', now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'TASK_PACKAGE_NOT_GRADED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('建队即认领任务包；单人时状态为 forming 且人数校验不通过（R-REG-01 / R-REG-02）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.equal(team.taskPackageId, s.pkg.id);
  assert.equal(team.status, 'forming');
  assert.equal(team.memberCount, 1);
  assert.equal(team.formation.ok, false);
  assert.ok(team.formation.errors.some((e) => e.includes('[TEAM_BELOW_MIN_SIZE]')));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('加入第 2 人 → 战队转 active，人数校验通过', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  const after = addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  assert.equal(after.memberCount, 2);
  assert.equal(after.status, 'active');
  assert.equal(after.formation.ok, true);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('C 级报名者不能入队（R-REG-08）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.throws(
    () => addMember({ db: s.db, teamId: team.id, userId: s.cLevel.id, actorId: s.captain.id, now: NOW, rules: s.rules }),
    (err) => err.status === 409 && err.code === 'REGISTRATION_NOT_ACCEPTED',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('同一个人不能同时在两支战队', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  const secondCaptain = createUser(s.db, { name: '另一队队长', phone: '13900005301', password: 'pw', mbaStatus: 'mba' });
  insertRegistration(s.db, {
    editionId: s.edition.id, userId: secondCaptain.id, answers: GOOD, rawScore: 80, level: 'S', status: 'submitted', now: NOW,
  });
  const second = createTeam({
    db: s.db, userId: secondCaptain.id, editionId: s.edition.id,
    taskPackageId: s.pkg2.id, name: '另一队', now: NOW, rules: s.rules,
  }).id;
  assert.throws(
    () => addMember({ db: s.db, teamId: second, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules }),
    (err) => err.status === 409 && err.code === 'ALREADY_IN_TEAM',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('每个任务包最多 3 支战队（R-REG-01 + 顶层文档）', () => {
  const s = setup();
  const captains = [
    createUser(s.db, { name: '队一', phone: '13900005101', password: 'pw', mbaStatus: 'mba' }),
    createUser(s.db, { name: '队二', phone: '13900005102', password: 'pw', mbaStatus: 'mba' }),
    createUser(s.db, { name: '队三', phone: '13900005103', password: 'pw', mbaStatus: 'mba' }),
    createUser(s.db, { name: '队四', phone: '13900005104', password: 'pw', mbaStatus: 'mba' }),
  ];
  for (const c of captains) {
    insertRegistration(s.db, {
      editionId: s.edition.id, userId: c.id, answers: GOOD, rawScore: 80, level: 'S', status: 'submitted', now: NOW,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    createTeam({
      db: s.db, userId: captains[i].id, editionId: s.edition.id,
      taskPackageId: s.pkg.id, name: `队${i + 1}`, now: NOW, rules: s.rules,
    });
  }
  assert.throws(
    () => createTeam({
      db: s.db, userId: captains[3].id, editionId: s.edition.id,
      taskPackageId: s.pkg.id, name: '队4', now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'PACKAGE_TEAM_LIMIT',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('赛程中成员退出 → 仅剩 1 人触发并队标记（R-REG-03 / R-REG-04）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  const after = leaveTeam({ db: s.db, teamId: team.id, userId: s.member.id, now: NOW, rules: s.rules });
  assert.equal(after.memberCount, 1);
  assert.equal(after.status, 'needs_merge');
  assert.equal(after.needsMerge, true);
  assert.ok(after.mergeDeadline, '并队期限必须给出');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('组长不能直接退出，必须先汰换移交', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.throws(
    () => leaveTeam({ db: s.db, teamId: team.id, userId: s.captain.id, now: NOW, rules: s.rules }),
    (err) => err.status === 409 && err.code === 'CAPTAIN_MUST_REPLACE',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('汰换：非队长发起 → 403；队长发起 → 成功且历史留痕', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: s.rules });
  const outsider = createUser(s.db, { name: '路人', phone: '13900005201', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 汰换进来的新人必须**已完成本届报名且被接收**（R-REG-08）——
  // 原用例漏了这一步，服务层的 assertAcceptedRegistration 直接把用例挡在门外。
  insertRegistration(s.db, {
    editionId: s.edition.id, userId: outsider.id, answers: GOOD, rawScore: 80,
    level: 'S', status: 'submitted', now: NOW,
  });
  assert.throws(
    () => replaceMember({
      db: s.db, teamId: team.id, outUserId: s.member.id, inUserId: outsider.id,
      actorId: outsider.id, now: NOW, rules: s.rules,
    }),
    (err) => err.status === 403,
  );
  const after = replaceMember({
    db: s.db, teamId: team.id, outUserId: s.member.id, inUserId: outsider.id,
    actorId: s.captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(after.memberCount, 2);
  assert.ok(after.members.some((m) => m.userId === outsider.id));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('换任务包：新的包必须已分级，且不改变已固定的里程碑清单（R-STG-03）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.ok(team.milestones.items.length > 0, '建队时必须固定里程碑清单');
  assert.throws(
    () => updateTeam({
      db: s.db, teamId: team.id, patch: { taskPackageId: s.ungraded.id },
      actorId: s.captain.id, now: NOW, rules: s.rules,
    }),
    (err) => err.status === 409 && err.code === 'TASK_PACKAGE_NOT_GRADED',
  );
  const after = updateTeam({
    db: s.db, teamId: team.id, patch: { taskPackageId: s.pkg2.id, name: '甲队改' },
    actorId: s.captain.id, now: NOW, rules: s.rules,
  });
  assert.equal(after.taskPackageId, s.pkg2.id);
  assert.equal(after.name, '甲队改');
  assert.deepEqual(after.milestones.items, team.milestones.items);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('可见性：非成员读不到战队（返回 null）', () => {
  const s = setup();
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: s.rules,
  });
  assert.ok(getTeam({ db: s.db, id: team.id, viewer: s.captain, rules: s.rules }));
  assert.equal(getTeam({ db: s.db, id: team.id, viewer: s.nonMba, rules: s.rules }), null);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('singleMemberTriggersMerge=false → 退出后不触发并队标记（配置真的被读了）', () => {
  // ⚠️ 2026-10-21 父代理预审修正（Important，配置没接线）：原来「仅剩 1 人触发并队」
  //    是**硬编码**在实现里的，配置项 `singleMemberTriggersMerge` 一次都没被读过 ——
  //    配置改成 false，行为照旧触发并队。这条用例把配置关掉，断言行为**跟着变**。
  const s = setup();
  const offRules = {
    ...s.rules,
    teamFormation: { ...s.rules.teamFormation, singleMemberTriggersMerge: false },
  };
  const team = createTeam({
    db: s.db, userId: s.captain.id, editionId: s.edition.id,
    taskPackageId: s.pkg.id, name: '甲队', now: NOW, rules: offRules,
  });
  addMember({ db: s.db, teamId: team.id, userId: s.member.id, actorId: s.captain.id, now: NOW, rules: offRules });
  const after = leaveTeam({ db: s.db, teamId: team.id, userId: s.member.id, now: NOW, rules: offRules });
  assert.equal(after.status, 'active', '配置关掉时不得触发并队标记');
  assert.equal(after.needsMerge, false);
});

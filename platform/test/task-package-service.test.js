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
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import {
  submitTaskPackage, assessSolvability, approveTaskPackage, listTaskPackages,
} from '../src/services/taskPackage.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

const FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tp-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900004001', password: 'pw', mbaStatus: 'other' });
  return { db, close, dataDir, rules, edition, enterprise };
}

const PAYLOAD = {
  title: '门店排班优化',
  painPoint: '排班靠店长经验，旺季人不够、淡季人浪费',
  expectedDelivery: '可运行的排班推荐原型',
  acceptanceCriteria: '用真实门店历史数据跑出一版排班表，店长认可',
  enterpriseName: '某零售',
  consent: { accepted: true, items: ['no_data_export'] },
};

test('提交任务卡：字段齐全则入库，状态为 submitted', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assert.equal(pkg.status, 'submitted');
  assert.equal(pkg.title, '门店排班优化');
  assert.equal(pkg.isFreeBrief, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('任务卡缺痛点/期望交付/验收标准 → 400（R-ENT-01）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: edition.id, painPoint: '' }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'INCOMPLETE_TASK_PACKAGE',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未同意合规红线 → 400（R-ENT-12）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: edition.id, consent: { accepted: false } }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'CONSENT_REQUIRED',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自由命题不得挂企业主体（R-ENT-10）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: edition.id, isFreeBrief: true }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'FREE_BRIEF_NO_ENTERPRISE',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('六维评估满分 → A 级 + 试点承诺书与数据授权说明（R-ENT-08）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  const assessed = assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  assert.equal(assessed.solvabilityScore, 12);
  assert.equal(assessed.solvabilityGrade, 'A');
  assert.equal(assessed.commitment, '试点承诺');
  assert.equal(assessed.agreement, '试点承诺书 + 数据授权说明');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('D 级必须出《问题可解性诊断报告》，不得静默丢弃（R-ENT-08）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 0, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.grade, 'D');
  assert.equal(approved.status, 'returned');
  assert.equal(approved.commitment, '无');
  assert.ok(approved.meta.solvability.diagnosticReport, 'D 级必须有诊断报告');
  assert.equal(approved.meta.solvability.diagnosticReport.title, '问题可解性诊断报告');
  assert.ok(approved.meta.solvability.diagnosticReport.vetoes.length > 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('存在一票否决时不得签成 A 级（强制降到 D）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id, answers: { ...FULL, vetoes: ['production_undisclosed'] },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.grade, 'D');
  assert.equal(approved.status, 'returned');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自由题不签企业协议（R-ENT-10）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id,
    payload: { ...PAYLOAD, editionId: edition.id, isFreeBrief: true, enterpriseName: null }, now: NOW, rules,
  });
  const assessed = assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.equal(approved.commitment, '无');
  assert.equal(approved.agreement, '自由命题不签约，无企业协议');
  assert.ok(assessed.solvabilityGrade);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('列表：无 task_package:read 权限 → 空数组', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  submitTaskPackage({ db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules });
  assert.deepEqual(listTaskPackages({ db, filter: { editionId: edition.id }, viewer: enterprise, rules }), []);
  const admin = { id: enterprise.id, is_superadmin: 1, active: 1 };
  assert.equal(listTaskPackages({ db, filter: { editionId: edition.id }, viewer: admin, rules }).length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未做六维评估就签级 → 400 SOLVABILITY_NOT_ASSESSED（评估闸门必须真的生效）', () => {
  // ⚠️ 父代理预审修正（Important，规格缺陷）：原来 approveTaskPackage 只读
  //    meta.solvability.vetoes —— 没评估过 → vetoes 为空 → 跳过否决降级 →
  //    直接签 A 并发布（父代理预审实跑：grade=A / status=published /
  //    solvabilityScore=null）。六维可解性评估闸门形同虚设。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assert.throws(
    () => approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules }),
    (err) => err.status === 400 && err.code === 'SOLVABILITY_NOT_ASSESSED',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('届期不存在 → 404 EDITION_NOT_FOUND（不得漏出 SQLite 外键原文）', () => {
  // ⚠️ 父代理预审修正（Important）：原来只判 `!editionId` 就 INSERT →
  //    edition_id 外键约束失败 → SQLite 原文漏到 HTTP 层（只能回 500）。
  const { db, close, dataDir, rules, enterprise } = setup();
  assert.throws(
    () => submitTaskPackage({
      db, userId: enterprise.id,
      payload: { ...PAYLOAD, editionId: 'not-a-real-edition' }, now: NOW, rules,
    }),
    (err) => err.status === 404 && err.code === 'EDITION_NOT_FOUND',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('D 级诊断报告必须带上分数（不能恒为 null）', () => {
  // ⚠️ 父代理预审修正（Important）：原来 meta.solvability 不存 score →
  //    诊断报告里 `solvability.score ?? null` 恒为 null —— 报告是给企业看的
  //    退回理由，分数却是空的（父代理预审实跑：diagnosticReport.score = null）。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({
    db, taskPackageId: pkg.id,
    answers: {
      problem_clarity: 1, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    actorId: enterprise.id, now: NOW, rules,
  });
  const approved = approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'D', actorId: enterprise.id, now: NOW, rules });
  const report = approved.meta.solvability.diagnosticReport;
  assert.equal(typeof report.score, 'number', '诊断报告必须带分数');
  assert.equal(report.grade, 'D');
  assert.ok(report.suggestions.length > 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('已发布的卡不能重新评估 → 409（任务卡状态机）', () => {
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  const pkg = submitTaskPackage({
    db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules,
  });
  assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules });
  approveTaskPackage({ db, taskPackageId: pkg.id, grade: 'A', actorId: enterprise.id, now: NOW, rules });
  assert.throws(
    () => assessSolvability({ db, taskPackageId: pkg.id, answers: FULL, actorId: enterprise.id, now: NOW, rules }),
    (err) => err.status === 409 && err.code === 'TASK_PACKAGE_STATE_INVALID',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交方在列表里能看到自己提交的卡', () => {
  // ⚠️ 父代理预审修正（Minor）：原来非组委会视图只返回 status === 'published'
  //    → 企业提交完任务卡，列表里一条都看不到。
  const { db, close, dataDir, rules, edition, enterprise } = setup();
  submitTaskPackage({ db, userId: enterprise.id, payload: { ...PAYLOAD, editionId: edition.id }, now: NOW, rules });
  // 给该用户授予 task_package:read（走 P0 的授权函数，不写裸 SQL）
  insertCapability(db, 'task_package:read', '读取任务卡');
  grantAssignment(db, {
    userId: enterprise.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: enterprise.id,
  });
  const viewer = { id: enterprise.id, active: 1, is_superadmin: 0 };
  const items = listTaskPackages({ db, filter: { editionId: edition.id }, viewer, rules });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'submitted');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

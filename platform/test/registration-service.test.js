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
import { listRegistrationEvents } from '../src/db/repo/registrationEvents.js';
import {
  submitRegistration, getRegistration, listRegistrations, decideRegistration,
} from '../src/services/registration.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

const NOW = '2026-10-20T12:00:00.000Z';
const GOOD = {
  direction: [4, 4, 4, 4, 5],
  capability: [4, 4, 4, 4, 5],
  collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题',
  consent: { accepted: true, items: ['no_data_export', 'privacy_protection'] },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-reg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const user = createUser(db, { name: '甲', phone: '13900002001', password: 'pw', mbaStatus: 'mba' });
  return { db, close, dataDir, rules, edition, user };
}

test('提交报名：自动算分分级并写入可解释明细', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({
    db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules,
  });
  assert.equal(reg.level, 'S');
  assert.equal(reg.rawScore, 80);
  assert.equal(reg.status, 'submitted');
  assert.equal(reg.grading.explain.length, 3);
  assert.equal(reg.grading.accepted, true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复提交同一 userId + editionId → 409，且原记录不被覆盖', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  assert.throws(
    () => submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules }),
    (err) => err.status === 409 && err.code === 'DUPLICATE_REGISTRATION',
  );
  const list = listRegistrations({ db, filter: { editionId: edition.id }, viewer: { id: user.id, is_superadmin: 1 }, rules });
  assert.equal(list.length, 1, '重复提交不得产生第二条记录');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('问卷不合法 → 400 并给出错误明细', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  assert.throws(
    () => submitRegistration({
      db, userId: user.id, editionId: edition.id,
      answers: { ...GOOD, direction: [4, 4] }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'INVALID_ANSWERS' && err.detail.length > 0,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未同意合规红线 → 400（R-ENT-12 同意记录）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  assert.throws(
    () => submitRegistration({
      db, userId: user.id, editionId: edition.id,
      answers: { ...GOOD, consent: { accepted: false } }, now: NOW, rules,
    }),
    (err) => err.status === 400 && err.code === 'CONSENT_REQUIRED',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交后写入一条 registration_events（状态机留痕）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].to_status, 'submitted');
  assert.equal(events[0].from_status, null);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('可见性：本人可读，别人的记录读不到（返回 null）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const other = createUser(db, { name: '乙', phone: '13900002002', password: 'pw', mbaStatus: 'mba' });
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  assert.ok(getRegistration({ db, id: reg.id, viewer: user, rules }));
  assert.equal(getRegistration({ db, id: reg.id, viewer: other, rules }), null);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('列表：无组委会权限 → 空数组（对应 API 200 + 空集）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  assert.deepEqual(listRegistrations({ db, filter: { editionId: edition.id }, viewer: user, rules }), []);
  const admin = { id: user.id, is_superadmin: 1, active: 1 };
  assert.equal(listRegistrations({ db, filter: { editionId: edition.id }, viewer: admin, rules }).length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('改级：写 level_final 并追加一条事件（不覆盖历史）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const updated = decideRegistration({
    db, id: reg.id, level: 'B', decidedBy: user.id, note: '委员会复核：能力维证据不足', now: NOW, rules,
  });
  assert.equal(updated.levelFinal, 'B');
  assert.equal(updated.status, 'accepted');
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].from_status, 'submitted');
  assert.equal(events[1].to_status, 'accepted');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('改级为 C 级 → status=rejected（R-REG-08 不接收）', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const updated = decideRegistration({ db, id: reg.id, level: 'C', decidedBy: user.id, note: '复核不通过', now: NOW, rules });
  assert.equal(updated.status, 'rejected');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：level 省略时只留痕不改级', () => {
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  const updated = decideRegistration({ db, id: reg.id, level: null, decidedBy: user.id, note: '我对能力维的打分有补充说明', now: NOW, rules });
  assert.equal(updated.levelFinal, null);
  assert.equal(updated.status, 'appealed');
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events[events.length - 1].to_status, 'appealed');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

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
import { getRegistration as findRegistrationRow } from '../src/db/repo/registrations.js';
import {
  submitRegistration, getRegistration, listRegistrations, decideRegistration, presentRegistration,
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

test('申诉不得抹掉委员会的终态裁定（status 保持终态，裁定留在 level_final）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4）：原来申诉**无条件**把 status 改成
  //    'appealed' —— 委员会已裁定 'rejected' 的行被选手申诉一次，终态就从
  //    status 列上消失了（裁定只留在 level_final 与事件流里，按 status 统计的下游会漏人）。
  //    独立评审探针实测：改 C 后 status=rejected → 申诉后 status=appealed。
  const { db, close, dataDir, rules, edition, user } = setup();
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: GOOD, now: NOW, rules });
  decideRegistration({ db, id: reg.id, level: 'C', decidedBy: user.id, note: '复核不通过', now: NOW, rules });
  const afterDecision = getRegistration({ db, id: reg.id, viewer: user, rules });
  assert.equal(afterDecision.status, 'rejected', '前置：委员会裁定后应是终态');

  const appealed = decideRegistration({
    db, id: reg.id, level: null, decidedBy: user.id, note: '我补充了材料', now: NOW, rules,
  });
  assert.equal(appealed.status, 'rejected', '申诉不得把委员会的终态翻走');
  assert.equal(appealed.levelFinal, 'C', '裁定必须仍在 level_final 上');
  // 申诉本身仍然要留痕（追加式，不覆盖历史）
  const events = listRegistrationEvents(db, reg.id);
  assert.equal(events.length, 3);
  assert.equal(events[2].to_status, 'appealed');
  assert.equal(events[2].from_status, 'rejected');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('低分问卷 → C 级且 accepted=false（R-REG-08 C 级不接收）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-1：近似恒绿断言）。
  //    原来唯一的 accepted 断言针对的是一份 **S 级** 报名（accepted 本就为 true），
  //    把实现改成恒 true 照样通过（独立评审变异 V16 实测：199 条仍全绿）。
  //    这条用例断言的是 C 级 —— 真值与硬编码在这里分得开。
  const { db, close, dataDir, rules, edition, user } = setup();
  const low = {
    direction: [1, 1, 1, 1, 1],
    capability: [1, 1, 1, 1, 1],
    collaboration: [1, 1, 1, 1, 1],
    open: '我的方向还在探索中',
    consent: { accepted: true, items: [] },
  };
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: low, now: NOW, rules });
  assert.equal(reg.rawScore, 0);
  assert.equal(reg.level, 'C');
  assert.equal(reg.grading.accepted, false, 'C 级必须不接收');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('grading 是按当前配置重算的；库内快照 level 不随后续改配置而变', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**口径无登记、断言缺失**）。
  //    `level` / `rawScore` 是提交那一刻的快照（存库），`grading` 是按当前配置重算的结果。
  //    改配置后两者不一致是**有意为之**（快照留痕 + 重算可追），但必须写明并钉住。
  const { db, close, dataDir, rules, edition, user } = setup();
  const skewed = {
    ...GOOD,
    direction: [5, 5, 5, 5, 5],
    capability: [1, 1, 1, 1, 1],
    collaboration: [1, 1, 1, 1, 1],
  };
  const reg = submitRegistration({ db, userId: user.id, editionId: edition.id, answers: skewed, now: NOW, rules });
  assert.equal(reg.level, 'C', '提交时的快照等级');
  assert.equal(reg.rawScore, 25);

  // 换一份权重明显不同的配置重算
  const shifted = {
    ...rules.registration,
    dimensions: rules.registration.dimensions.map((d) => (
      d.key === 'direction' ? { ...d, weight: 0.9 } : { ...d, weight: 0.05 }
    )),
  };
  const row = findRegistrationRow(db, reg.id);
  const recomputed = presentRegistration(row, shifted);
  assert.equal(recomputed.grading.level, 'S', '换配置后重算结果应当变化');
  assert.equal(recomputed.grading.score, 90);
  assert.equal(recomputed.level, 'C', '库内快照不随后配置变');
  assert.equal(recomputed.rawScore, 25);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('非唯一约束的插入失败不得被报成 DUPLICATE_REGISTRATION', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-3：**错误码用错**）。
  //    原来的兜底正则 `/UNIQUE|constraint/i` 连外键失败也一起吞掉
  //    （"FOREIGN KEY constraint failed" 里含 "constraint"）
  //    → 客户端被告知「你已提交过本届报名」，而真实原因是外键失败。
  const { db, close, dataDir, rules, edition } = setup();
  let caught = null;
  try {
    submitRegistration({
      db, userId: 'no-such-user', editionId: edition.id, answers: GOOD, now: NOW, rules,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, '必须抛错');
  assert.notEqual(caught.code, 'DUPLICATE_REGISTRATION', '外键失败不得报成重复报名');
  assert.ok(!/DUPLICATE/.test(String(caught.message)), '错误信息不得提到重复报名');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// platform/test/appeals-registration.test.js —— 报名类申诉（DP-106）
//
// 规则溯源：
//   - 「R-REG-08：分级不接收时选手可向组委会提交申诉」→ 设计文档 §9「组委会视角 → 复核/申诉/改级」
//     与 web/views/registration.js 的选手侧申诉面板（POST /api/appeals，body = { subjectType, subjectId, reason }）。
//   - 「终态裁定不可被选手改写」→ src/services/registration.js 的 decideRegistration 注释
//     （2026-10-21 独立评审 Minor M-4 的修正）：委员会已裁定（accepted / rejected）的报名，选手不能申诉。
//   - 「三态状态码：列表 200 + 空集 / 单条 404 / 禁用 403」→ 设计文档 §8。
//   - 「可见性与授权在 API 层裁决」→ 全局约束：listAppeals 对无 audit:read 的人返空集，**不得放宽**。
//
// ⚠️ 本文件测的是**服务层**（src/services/review-state.js）的行为，
//    断言一律打在**数据库真实状态 / 返回值**上 ——
//    不写「文件里有某个字符串」那种会被无关代码顶替的形式。
//
// ⚠️ 夹具用**真实的用户 / 届期 / 报名行**（本仓有外键约束：audit_log.actor_id、appeals.filed_by、
//    registration_events.actor_id 都 REFERENCES users(id)；tier_records.team_id REFERENCES teams(id)）
//    ⇒ 用假 id 会被 DB 直接拒绝（外键失败），不是断言失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import {
  getRegistration as findRegistrationRow, updateRegistrationRow,
} from '../src/db/repo/registrations.js';
import { listRegistrationEvents } from '../src/db/repo/registrationEvents.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { submitRegistration, decideRegistration } from '../src/services/registration.js';
import {
  fileAppeal, decideAppeal, listAppeals, transition,
} from '../src/services/review-state.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

const NOW = '2026-10-23T02:00:00.000Z';
const APPEAL_NOW = '2026-10-23T03:00:00.000Z';
const DECIDE_NOW = '2026-10-23T04:00:00.000Z';

/** 低分问卷 ⇒ C 级 ⇒ **不接收**（grading.accepted === false）—— 选手侧申诉入口的出现条件。 */
const LOW = {
  direction: [1, 1, 1, 1, 1],
  capability: [1, 1, 1, 1, 1],
  collaboration: [1, 1, 1, 1, 1],
  open: '我的方向还在探索中',
  consent: { accepted: true, items: [] },
};

/** 高分问卷 ⇒ S 级 ⇒ 接收（对照组：接收的人没有申诉理由）。 */
const HIGH = {
  direction: [4, 4, 4, 4, 4],
  capability: [4, 4, 4, 4, 4],
  collaboration: [4, 4, 4, 4, 4],
  open: '我想解决门店排班问题',
  consent: { accepted: true, items: ['no_data_export'] },
};

const RULES = {
  audit: {
    reviewState: { appealSubjectType: 'team_result', appealAllowedTiers: ['D'] },
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-appeal-reg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  // 能力点 / 角色 / 角色能力（走仓储层，不写裸 SQL —— 全局约束「SQL 只在 src/db/repo/」）
  const CAPS = [
    ['registration:review', '复核报名分级'],
    ['audit:read', '读取审计与申诉队列'],
    ['audit:write', '裁决申诉与复核项'],
    ['appeal:write', '提交申诉'],
  ];
  for (const [k, d] of CAPS) insertCapability(db, k, d);
  insertRole(db, 'admin', '组委会');
  for (const [k] of CAPS) insertRoleCapability(db, 'admin', k);

  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const player = createUser(db, { name: '甲', phone: '13900003001', password: 'pw', mbaStatus: 'mba' });
  const other = createUser(db, { name: '乙', phone: '13900003002', password: 'pw', mbaStatus: 'mba' });
  const committee = createUser(db, { name: '组委会', phone: '13900003003', password: 'pw', mbaStatus: 'mba' });
  insertUserRole(db, committee.id, 'admin');

  return { db, close, dataDir, rules, edition, player, other, committee };
}

/** 造一条**不接收**的报名（C 级，status 仍是 submitted —— 尚未进终态裁定）。 */
function fileLowRegistration({ db, rules, edition, user, now = NOW }) {
  return submitRegistration({
    db, userId: user.id, editionId: edition.id, answers: LOW, now, rules,
  });
}

// ══════════════════════════════════════════════════════════════════
// 一、提交：本人可申诉自己的报名
// ══════════════════════════════════════════════════════════════════

test('报名类申诉：选手能对自己的**未接收**报名提交申诉（落一条 subject_type=registration 的记录）', () => {
  const { db, close, dataDir, rules, edition, player } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  assert.equal(reg.grading.accepted, false, '前置：这条报名是不接收的');

  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '能力维有未提交的佐证材料，请复核', now: APPEAL_NOW, rules: RULES,
  });
  assert.equal(appeal.subject_type, 'registration', '必须是报名类申诉');
  assert.equal(appeal.subject_id, reg.id, 'subject_id 存**报名 id 原样**（不加前缀）');
  assert.equal(appeal.filed_by, player.id);
  assert.equal(appeal.reason, '能力维有未提交的佐证材料，请复核');
  assert.equal(appeal.status, 'submitted', '新提的申诉是待裁决');
  assert.equal(appeal.decided_by, null);

  // 审计留痕：申诉进了队列就要能复盘
  const { rows } = queryAuditLog(db, { action: 'appeal.filed' });
  assert.equal(rows.length, 1, '提交一次写一条审计日志');
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.subjectType, 'registration');
  assert.equal(detail.subjectId, reg.id);
  assert.equal(detail.onBehalf, false, '本人提交 ⇒ 不是代提交');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 二、提交：三类拒绝（403 / 404 / 409）
// ══════════════════════════════════════════════════════════════════

test('报名类申诉：不能申诉**别人的**报名 ⇒ 403（且不得留下任何记录）', () => {
  const { db, close, dataDir, rules, edition, player, other } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: other.id,
      reason: '这不是我的报名', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 403,
  );
  const list = listAppeals({
    db, filter: {}, viewer: { id: player.id, is_superadmin: 1, active: 1 },
  });
  assert.equal(list.total, 0, '被拒的申诉不得落库');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：报名不存在 ⇒ 404', () => {
  const { db, close, dataDir, rules, player } = setup();
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: 'reg_not_exist_at_all', filedBy: player.id,
      reason: '不存在的报名', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 404 && /报名记录不存在/.test(e.message),
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：已终态裁定（accepted / rejected）的报名 ⇒ 409（不可申诉）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  // 委员会改级 ⇒ status 落到终态（accepted / rejected）
  decideRegistration({
    db, id: reg.id, level: 'C', decidedBy: committee.id, note: '复核不通过', now: NOW, rules,
  });
  const row = findRegistrationRow(db, reg.id);
  assert.equal(row.status, 'rejected', '前置：委员会已裁定为终态');
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
      reason: '终态之后不服', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 409 && /裁定/.test(e.message),
  );

  // 另一条：accepted 也是终态 ⇒ 同样 409
  // ⚠️ 同一 userId + editionId 只能有一条有效报名（部分唯一索引）⇒ 换一届期造第二条。
  const edition2 = createEdition(db, {
    name: '第二届', city: '上海', startsAt: '2026-11-01', endsAt: '2026-11-30', now: NOW,
  });
  const reg2 = submitRegistration({
    db, userId: player.id, editionId: edition2.id, answers: LOW, now: NOW, rules,
  });
  decideRegistration({
    db, id: reg2.id, level: 'B', decidedBy: committee.id, note: '复核通过', now: NOW, rules,
  });
  assert.equal(findRegistrationRow(db, reg2.id).status, 'accepted', '前置：这条落在 accepted 终态');
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg2.id, filedBy: player.id,
      reason: '终态之后不服', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：同一报名重复提交未裁决的申诉 ⇒ 409（防重复）', () => {
  const { db, close, dataDir, rules, edition, player } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '第一次申诉', now: APPEAL_NOW, rules: RULES,
  });
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
      reason: '再提一次', now: '2026-10-23T03:30:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  const list = listAppeals({
    db, filter: {}, viewer: { id: player.id, is_superadmin: 1, active: 1 },
  });
  assert.equal(list.total, 1, '重复提交不得产生第二条申诉');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：空理由 ⇒ 400（服务层也必须挡，不能只靠前端）', () => {
  const { db, close, dataDir, rules, edition, player } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
      reason: '   ', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 400,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：组委会代提交允许，且**必须留痕**（detail.onBehalf = true）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: committee.id,
    reason: '组委会代为提交', now: APPEAL_NOW, rules: RULES,
  });
  assert.equal(appeal.filed_by, committee.id);
  const { rows } = queryAuditLog(db, { action: 'appeal.filed' });
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.onBehalf, true, '代提交必须留痕（否则复盘分不清是谁提的）');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 三、裁决：成立 / 驳回
// ══════════════════════════════════════════════════════════════════

test('报名类申诉**裁决成立** ⇒ 撤销分级裁定（level_final 清空 / status 回到 submitted）且**不触发赛段重算**', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  // ⚠️ 夹具：把 level_final 置上、status 留在**非终态**（模拟「已改级但还没落终态」的报名行）
  //    ⇒ 这样「裁决成立 ⇒ 清空 level_final」才是**可观测的**（不是空操作）。
  updateRegistrationRow(db, reg.id, { level_final: 'C', status: 'submitted' });

  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'accepted', decidedBy: committee.id,
    note: '成立，退回待复核重新分级', now: DECIDE_NOW, rules: RULES,
  });

  // ① 报名行真的被改了（数据库真实状态，不是返回值）
  const after = findRegistrationRow(db, reg.id);
  assert.equal(after.level_final, null, '分级裁定必须被撤销（level_final 置 NULL）');
  assert.equal(after.status, 'submitted', '必须回到待委员会重新分级');
  // ② 没有触发赛段重算
  assert.equal(out.recomputeRequired, false, '报名类申诉不涉及赛段分数 ⇒ 不得要求重算');
  assert.deepEqual(out.transitions, [], '报名类申诉不得产生赛段状态迁移');
  // ③ 事件轨迹留痕（追加式）
  const events = listRegistrationEvents(db, reg.id);
  const last = events[events.length - 1];
  assert.equal(last.to_status, 'submitted');
  assert.equal(last.reason, '成立，退回待复核重新分级', '裁决说明必须落进事件轨迹');
  assert.equal(last.actor_id, committee.id, '裁决人必须落库（谁裁决的要能追责）');
  // ④ 申诉行本身被裁决
  assert.equal(out.appeal.status, 'accepted');
  assert.equal(out.appeal.decided_by, committee.id);
  assert.equal(out.appeal.decision_note, '成立，退回待复核重新分级');
  assert.equal(out.appeal.decided_at, DECIDE_NOW);
  // ⑤ 审计日志：recomputeRequired 也要是 false
  const { rows } = queryAuditLog(db, { action: 'appeal.decided' });
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.recomputeRequired, false, '审计日志里的重算标志必须与返回值一致');
  assert.equal(detail.subjectType, 'registration');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉**裁决驳回** ⇒ 报名**不动**（只留痕）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  updateRegistrationRow(db, reg.id, { level_final: 'C', status: 'submitted' });
  const before = findRegistrationRow(db, reg.id);

  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'rejected', decidedBy: committee.id,
    note: '证据不足，维持原判', now: DECIDE_NOW, rules: RULES,
  });

  const after = findRegistrationRow(db, reg.id);
  assert.equal(after.level_final, before.level_final, '驳回不得改分级裁定');
  assert.equal(after.status, before.status, '驳回不得改报名状态');
  assert.equal(out.recomputeRequired, false);
  assert.deepEqual(out.transitions, []);
  // 只留痕：申诉行 + 审计日志
  assert.equal(out.appeal.status, 'rejected');
  assert.equal(out.appeal.decided_by, committee.id);
  assert.equal(out.appeal.decision_note, '证据不足，维持原判');
  const { rows } = queryAuditLog(db, { action: 'appeal.decided' });
  assert.equal(rows.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：已裁决的申诉不得二次裁决 ⇒ 409', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  decideAppeal({
    db, appealId: appeal.id, decision: 'rejected', decidedBy: committee.id,
    note: '维持原判', now: DECIDE_NOW, rules: RULES,
  });
  assert.throws(
    () => decideAppeal({
      db, appealId: appeal.id, decision: 'accepted', decidedBy: committee.id,
      note: '再改一次', now: '2026-10-23T05:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 四、原路径没被改坏（赛段结果类申诉）
// ══════════════════════════════════════════════════════════════════

/** 造一条赛段结果类申诉要用的夹具：队伍 + D 段位 + 已 FINALIZED 的赛段。 */
function seedTeamResult(db) {
  db.prepare(
    `INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
     VALUES ('u_captain','甲队队长','13900000988','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
     VALUES ('t1','ed_team','甲队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES ('tr_t1','t1','D',0,0,'[]','2026-10-20T00:00:00.000Z',NULL)`,
  ).run();
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_captain', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
}

test('原路径没被改坏：赛段结果类申诉（team_result）仍按原口径走 —— 成立 = 撤销终稿 + 要求重算', () => {
  const { db, close, dataDir } = setup();
  // teams.edition_id / tier_records 的外键要有着落 ⇒ 补一条届期
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('ed_team','届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z')`,
  ).run();
  seedTeamResult(db);

  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: APPEAL_NOW, rules: RULES,
  });
  assert.equal(appeal.subject_type, 'team_result');
  assert.equal(appeal.subject_id, 'st1:t1');

  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'accepted', decidedBy: 'u_captain',
    note: '成立，重算', now: DECIDE_NOW, rules: RULES,
  });
  assert.equal(out.recomputeRequired, true, '赛段结果类成立仍必须要求重算');
  assert.deepEqual(
    out.transitions.map((t) => t.to), ['REJECTED', 'PENDING_REVIEW'],
    '赛段结果类成立仍走「撤销终稿 → 重新复核」',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('原路径没被改坏：赛段结果类申诉的原有前置校验仍在（未 FINALIZED / 档位不在可申诉档 ⇒ 409 / 403）', () => {
  const { db, close, dataDir } = setup();
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('ed_team','届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z')`,
  ).run();
  seedTeamResult(db);
  // 未 FINALIZED 的条目 ⇒ 409
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st2:t1', filedBy: 'u_captain',
      reason: '还没定稿', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 409,
  );
  // 档位不在 appealAllowedTiers（D）⇒ 403
  // ⚠️ 顺序要紧：tier_records.team_id REFERENCES teams(id) ⇒ 先有队伍再有段位记录。
  db.prepare(
    `INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
     VALUES ('t2','ed_team','乙队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES ('tr_t2','t2','B',0,0,'[]','2026-10-20T00:00:00.000Z',NULL)`,
  ).run();
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t2', filedBy: 'u_captain',
      reason: 'B 档也要申诉', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 五、可见性（没被放宽）
// ══════════════════════════════════════════════════════════════════

test('申诉列表：无 audit:read 的人仍拿到**空集**（可见性没被放宽）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  // 选手本人没有 audit:read ⇒ 空集（选手在报名结果页看不到别人的申诉，这是对的）
  const denied = listAppeals({ db, filter: {}, viewer: player });
  assert.deepEqual(denied.rows, []);
  assert.equal(denied.total, 0);
  // 组委会（有 audit:read）看得到，且字段名与正式站口径一致
  const allowed = listAppeals({ db, filter: {}, viewer: committee });
  assert.equal(allowed.total, 1);
  assert.deepEqual(
    Object.keys(allowed.rows[0]).sort(),
    ['createdAt', 'decidedAt', 'decidedBy', 'decisionNote', 'filedBy', 'id', 'reason', 'status', 'subjectId', 'subjectType'],
    '列表行的字段名必须与正式站口径逐字一致',
  );
  assert.equal(allowed.rows[0].subjectType, 'registration');
  assert.equal(allowed.rows[0].subjectId, reg.id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 六、演示适配器（公网演示站）补齐 /api/appeals
// ══════════════════════════════════════════════════════════════════
//
// ⚠️ P9 教训：演示站与正式站的**形状**必须逐字一致 —— 演示适配器此前**完全没有**
//    /api/appeals ⇒ 公网演示站的「申诉裁决」页是错误态（端点未实现）。

function makeMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('演示适配器：申诉三端点齐全（列表 / 提交 / 裁决），形状与正式站逐字一致', async () => {
  const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(rulesDir);
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeMemoryStorage(), seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });

  // 演示站先造一条报名（演示适配器的报名存在本地状态里）
  const reg = await api.post('/api/registrations', {
    editionId: 'ed_demo',
    answers: {
      direction: [1, 1, 1, 1, 1],
      capability: [1, 1, 1, 1, 1],
      collaboration: [1, 1, 1, 1, 1],
      open: '演示报名',
      consent: { accepted: true },
    },
  });
  assert.ok(reg?.id, '演示站要有报名');

  // ① 提交
  const appeal = await api.post('/api/appeals', {
    subjectType: 'registration', subjectId: reg.id, reason: '演示：复核我的能力维',
  });
  assert.equal(appeal.subjectType, 'registration');
  assert.equal(appeal.subjectId, reg.id);
  assert.equal(appeal.status, 'submitted');

  // ② 列表：字段名与正式站口径逐字一致
  const list = await api.get('/api/appeals');
  assert.equal(list.total, 1);
  assert.deepEqual(
    Object.keys(list.rows[0]).sort(),
    ['createdAt', 'decidedAt', 'decidedBy', 'decisionNote', 'filedBy', 'id', 'reason', 'status', 'subjectId', 'subjectType'],
    '演示站的申诉行字段名必须与正式站一致（P9 教训：不能另写一份形状）',
  );

  // ③ 裁决：更新本地状态并返回（报名类成立 ⇒ 撤销分级裁定、回到待复核、不重算）
  const out = await api.post(`/api/appeals/${appeal.id}/decide`, {
    decision: 'accepted', note: '成立，退回待复核',
  });
  assert.equal(out.appeal.status, 'accepted');
  assert.equal(out.appeal.decidedBy, 'demo_admin');
  assert.ok(out.appeal.decidedAt, '必须记裁决时间');
  assert.equal(out.appeal.decisionNote, '成立，退回待复核');
  assert.equal(out.recomputeRequired, false, '报名类申诉不触发赛段重算');
  assert.deepEqual(out.transitions, []);
  const after = (await api.get('/api/registrations')).items.find((r) => r.id === reg.id);
  assert.equal(after.status, 'submitted', '裁决成立 ⇒ 报名回到待复核');
  assert.equal(after.levelFinal, null, '裁决成立 ⇒ 分级裁定被撤销');

  // ④ 空理由 ⇒ 400（与正式站同一口径）
  await assert.rejects(
    () => api.post('/api/appeals', { subjectType: 'registration', subjectId: reg.id, reason: '  ' }),
    (e) => e.status === 400,
  );
});

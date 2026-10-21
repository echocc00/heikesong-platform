import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  transition, getSubjectState, filterVisibleScores,
  fileAppeal, decideAppeal, listAppeals, parseAppealSubject, REVIEW_STATES,
} from '../src/services/review-state.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { getTeamTierRow } from '../src/db/repo/tiers.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const RULES = {
  audit: {
    reviewState: { appealSubjectType: 'team_result', appealAllowedTiers: ['D'] },
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4rs-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  seedRefs(db);
  return { db, close, dataDir };
}

/**
 * 造出被外键引用的行。
 * ⚠️ 规格原写法直接用 'u_admin' / 'u_captain' 写审计日志、用 't1'/'t2' 写段位记录，
 *    但 audit_log.actor_id REFERENCES users(id)、tier_records.team_id REFERENCES teams(id)
 *    —— **不建被引用的行就会 FOREIGN KEY constraint failed**。
 *    这不是测试写得随意，是规格自带缺陷：照抄必然红（实测 8/13 用例红在
 *    `Error: FOREIGN KEY constraint failed`，errcode 787）。
 *    与 P4 Task 1 的 test/audit-repo.test.js 的 seedRefs() 同一处置口径。
 */
function seedRefs(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000999','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z'),
           ('u_captain','甲队队长','13900000888','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z'),
           ('u_judge','评委','13900000777','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z'),
           ('j1','评委一','13900000701','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z'),
           ('j2','评委二','13900000702','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z');
    INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
    VALUES ('t1','ed_1','甲队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z'),
           ('t2','ed_1','乙队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z'),
           ('t3','ed_1','丙队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z'),
           ('t4','ed_1','丁队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z'),
           ('t5','ed_1','戊队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z'),
           ('t6','ed_1','己队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z');
  `);
}

function seedTier(db, teamId, tier) {
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(`tr_${teamId}`, teamId, tier, 0, 0, '[]', '2026-10-20T00:00:00.000Z');
}

/** 把 st1 推到 FINALIZED（连续三次迁移，规格里共用同一时间戳） */
function finalizeStage1(db, now = '2026-10-20T00:00:00.000Z') {
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now,
    });
  }
}

test('状态机：合法迁移成功并写审计日志', () => {
  const { db, close, dataDir } = setup();
  const r = transition({
    db, subjectType: 'stage_result', subjectId: 'st1',
    from: 'SUBMITTED', to: 'PENDING_REVIEW', actorId: 'u_admin', reason: '待复核',
    idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(r.applied, true);
  assert.equal(r.to, 'PENDING_REVIEW');
  assert.equal(r.state, 'PENDING_REVIEW', 'state 必须与 to 一致');
  assert.equal(r.replayed, false, '首次迁移不是重放');
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'PENDING_REVIEW');
  const { rows } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.from, 'SUBMITTED');
  assert.equal(detail.to, 'PENDING_REVIEW');
  assert.equal(detail.reason, '待复核');
  assert.equal(detail.at, '2026-10-20T00:00:00.000Z', '迁移时刻必须落在明细里（申诉要复盘）');
  assert.equal(detail.idempotencyKey, 'k1');
  assert.equal(rows[0].actor_id, 'u_admin', '操作者必须落库（申诉要复盘谁改的）');
  assert.equal(rows[0].entity, 'stage_result');
  assert.equal(rows[0].entity_id, 'st1');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：非法迁移被拒（SUBMITTED 不能直接跳 FINALIZED）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1',
      from: 'SUBMITTED', to: 'FINALIZED', actorId: 'u_admin', reason: 'x',
      idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 409 && /非法迁移/.test(e.message),
  );
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), null, '被拒的迁移不得落库');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：from 与当前状态不一致时拒绝（防并发覆盖）', () => {
  const { db, close, dataDir } = setup();
  transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: 'x', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'CONFIRMED',
      actorId: 'u_admin', reason: 'y', idempotencyKey: 'k2', now: '2026-10-20T00:00:01.000Z',
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等守卫：同一 idempotencyKey 重复触发不产生二次迁移', () => {
  const { db, close, dataDir } = setup();
  const args = {
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: '待复核', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  };
  const first = transition(args);
  const second = transition(args);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false, '重复触发不得产生二次迁移');
  assert.equal(second.replayed, true, '重复触发必须被标记为重放');
  assert.equal(second.to, 'PENDING_REVIEW', '重放必须返回首次的结果');
  const { rows } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(rows.length, 1, '审计日志里只能有一条迁移记录');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('PENDING_REVIEW 的分数对其他评委不可见（API 层过滤，不是前端隐藏）', () => {
  const { db, close, dataDir } = setup();
  transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: '待复核', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  const scores = [
    { judgeId: 'j1', teamId: 't1', rawScore: 80 },
    { judgeId: 'j2', teamId: 't1', rawScore: 90 },
  ];
  const asJudge = filterVisibleScores({
    db, stageId: 'st1', viewer: { id: 'j1', is_superadmin: 0, active: 1 }, scores,
  });
  assert.equal(asJudge[0].rawScore, 80, '自己的分看得到');
  assert.equal(asJudge[1].rawScore, null, '别人的分看不到');
  assert.equal(asJudge[1].hidden, true);
  assert.equal(asJudge[1].hiddenReason, 'pending_review', '必须说明为什么被隐藏（降级要显式）');
  assert.equal(asJudge[0].hidden, undefined, '自己的分不应被标记为 hidden');

  const asAdmin = filterVisibleScores({
    db, stageId: 'st1', viewer: { id: 'u_admin', is_superadmin: 1, active: 1 }, scores,
  });
  assert.equal(asAdmin[1].rawScore, 90, '组委会看得到全部');
  assert.equal(asAdmin[1].hidden, undefined, '组委会看到的分不应被标记为 hidden');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('FINALIZED 之后分数对其他评委恢复可见', () => {
  const { db, close, dataDir } = setup();
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  const scores = [{ judgeId: 'j2', teamId: 't1', rawScore: 90 }];
  const asJudge = filterVisibleScores({
    db, stageId: 'st1', viewer: { id: 'j1', is_superadmin: 0, active: 1 }, scores,
  });
  assert.equal(asJudge[0].rawScore, 90);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：理由为空直接报错（空结果必须显式报错）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
      reason: '   ', now: '2026-10-20T00:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 400,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：只能对"已 FINALIZED 且处于低可见档"的条目提出', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  seedTier(db, 't2', 'B');
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  // D 段（低可见档）→ 允许
  const ok = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  assert.equal(ok.status, 'submitted');
  assert.equal(ok.subject_type, 'team_result');
  assert.equal(ok.subject_id, 'st1:t1');
  assert.equal(ok.filed_by, 'u_captain');
  // B 段（已公示档）→ 拒绝
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t2', filedBy: 'u_captain',
      reason: '我不服', now: '2026-10-20T01:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：未 FINALIZED 的条目不能申诉', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
      reason: '还没定稿就申诉', now: '2026-10-20T01:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉成立 → 撤销终稿并要求 revision + 1 重算（旧 revision 保留）', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'accepted', decidedBy: 'u_admin',
    note: '成立，重算', now: '2026-10-20T02:00:00.000Z', rules: RULES,
  });
  assert.equal(out.appeal.status, 'accepted');
  assert.equal(out.recomputeRequired, true);
  assert.equal(out.appeal.decided_by, 'u_admin');
  assert.equal(out.appeal.decision_note, '成立，重算');
  assert.equal(out.appeal.decided_at, '2026-10-20T02:00:00.000Z');
  assert.deepEqual(out.transitions.map((t) => t.to), ['REJECTED', 'PENDING_REVIEW'], '成立 → 撤销终稿 → 重新复核');
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'PENDING_REVIEW');
  const { rows } = queryAuditLog(db, { action: 'appeal.decided' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, 'u_admin', '裁决人必须落库（谁裁决的要能追责）');
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.decision, 'accepted');
  assert.equal(detail.recomputeRequired, true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('parseAppealSubject 能拆出 stageId 与 teamId', () => {
  const p = parseAppealSubject('st9:t7');
  assert.equal(p.stageId, 'st9');
  assert.equal(p.teamId, 't7');
});

test('REVIEW_STATES 覆盖设计文档 §11.2 的全部状态', () => {
  for (const s of ['SUBMITTED', 'PENDING_REVIEW', 'CONFIRMED', 'FINALIZED', 'REJECTED', 'FLAGGED']) {
    assert.ok(REVIEW_STATES.includes(s), `缺状态 ${s}`);
  }
});

test('申诉列表：无权访问返回空集', () => {
  const { db, close, dataDir } = setup();
  const r = listAppeals({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(r.rows, []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 以下是 Task 5 实施时补的用例（2026-10-21）────────────────────────────────
// 目的：① 覆盖规格里**没被任何断言区分**的分支（否则变异测试分不出对错）；
//      ② 把本次实跑发现的两个规格缺陷（外键未播种 / 同毫秒迁移乱序）钉死成回归用例。

test('状态机：from 合法但与当前状态不符 → 409「状态冲突」（与「非法迁移」区分开）', () => {
  const { db, close, dataDir } = setup();
  // PENDING_REVIEW → CONFIRMED 本身合法，但当前状态是 SUBMITTED（还没迁移过）
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1',
      from: 'PENDING_REVIEW', to: 'CONFIRMED', actorId: 'u_admin', reason: 'x',
      idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 409 && /状态冲突/.test(e.message),
  );
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), null, '被拒的迁移不得落库');
  const { rows } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(rows.length, 0, '被拒的迁移不得写审计日志');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：同一毫秒内的连续迁移，时间戳严格递增（最新态可确定读出）', () => {
  // ⚠️ 这是本次实跑发现的 Critical 缺陷的回归用例：仓储层 findLatestTransition 用
  //    `created_at DESC, id DESC` 排序，而 id 是 randomUUID() → 同一毫秒内多条迁移
  //    的先后是**随机的**（实测 200 次里 135 次读到过期状态）→ 状态机假报 409。
  const { db, close, dataDir } = setup();
  finalizeStage1(db);
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'FINALIZED');
  const { rows } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(rows.length, 3);
  const times = rows.map((r) => r.created_at);
  assert.equal(new Set(times).size, 3, '同一毫秒内的迁移必须被单调化，不能并列');
  assert.deepEqual([...times].sort().reverse(), times, '审计日志必须能按时间倒序读出');
  assert.equal(rows[0].created_at, '2026-10-20T00:00:00.002Z');
  assert.equal(rows[1].created_at, '2026-10-20T00:00:00.001Z');
  assert.equal(rows[2].created_at, '2026-10-20T00:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：未知状态 / 缺参数 → 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from: 'NOPE', to: 'PENDING_REVIEW',
      actorId: 'u_admin', reason: 'x', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'NOPE',
      actorId: 'u_admin', reason: 'x', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => transition({
      db, subjectType: '', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
      actorId: 'u_admin', reason: 'x', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: '', from: 'SUBMITTED', to: 'PENDING_REVIEW',
      actorId: 'u_admin', reason: 'x', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 400,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：幂等键按 subject 分域，同一个 key 不影响别的对象', () => {
  const { db, close, dataDir } = setup();
  const args = {
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: 'x', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  };
  transition(args);
  const row = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get('k1');
  assert.equal(row.scope, 'review_state:stage_result:st1');
  assert.equal(row.request_id, 'k1');
  const other = transition({ ...args, subjectId: 'st2' });
  assert.equal(other.applied, true, '同一个 key 不该影响另一个对象');
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st2' }), 'PENDING_REVIEW');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：档位未知 → 409（档位未知时不得受理申诉）', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  finalizeStage1(db);
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t3', filedBy: 'u_captain',
      reason: '没有段位记录', now: '2026-10-20T01:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409 && /档位/.test(e.message),
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：提交后写 appeal.filed 审计日志', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  finalizeStage1(db);
  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  const { rows } = queryAuditLog(db, { action: 'appeal.filed' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, 'appeal');
  assert.equal(rows[0].entity_id, appeal.id);
  assert.equal(rows[0].actor_id, 'u_captain');
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.stageId, 'st1');
  assert.equal(detail.teamId, 't1');
  assert.equal(detail.tier, 'D');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉裁决：非法裁决值 / 空说明 / 申诉不存在 → 400 / 400 / 404', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => decideAppeal({
      db, appealId: 'ap_x', decision: 'maybe', decidedBy: 'u_admin',
      note: 'x', now: '2026-10-20T02:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => decideAppeal({
      db, appealId: 'ap_x', decision: 'accepted', decidedBy: 'u_admin',
      note: '   ', now: '2026-10-20T02:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => decideAppeal({
      db, appealId: 'ap_not_exist', decision: 'accepted', decidedBy: 'u_admin',
      note: 'x', now: '2026-10-20T02:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 404,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉裁决：重复裁决 → 409（已裁决的申诉不能再改）', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  finalizeStage1(db);
  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  decideAppeal({
    db, appealId: appeal.id, decision: 'rejected', decidedBy: 'u_admin',
    note: '不成立', now: '2026-10-20T02:00:00.000Z', rules: RULES,
  });
  assert.throws(
    () => decideAppeal({
      db, appealId: appeal.id, decision: 'accepted', decidedBy: 'u_admin',
      note: '再改一次', now: '2026-10-20T03:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉裁决：不成立 → 终稿不动、不要求重算', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  finalizeStage1(db);
  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'rejected', decidedBy: 'u_admin',
    note: '证据不足，维持原判', now: '2026-10-20T02:00:00.000Z', rules: RULES,
  });
  assert.equal(out.appeal.status, 'rejected');
  assert.equal(out.recomputeRequired, false, '不成立不得要求重算');
  assert.deepEqual(out.transitions, [], '不成立不得改状态');
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'FINALIZED', '终稿必须保持');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉列表：有权者可查到，无权者即使有数据也只拿到空集', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  finalizeStage1(db);
  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  const denied = listAppeals({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(denied.rows, [], '无权者必须拿到空集（可见性在服务层过滤）');
  assert.equal(denied.total, 0);
  const allowed = listAppeals({ db, filter: {}, viewer: { id: 'u_admin', is_superadmin: 1, active: 1 } });
  assert.equal(allowed.total, 1);
  assert.equal(allowed.rows.length, 1);
  assert.equal(allowed.rows[0].id, appeal.id);
  assert.equal(allowed.rows[0].subjectType, 'team_result');
  assert.equal(allowed.rows[0].subjectId, 'st1:t1');
  assert.equal(allowed.rows[0].filedBy, 'u_captain');
  assert.equal(allowed.rows[0].status, 'submitted');
  assert.equal(allowed.rows[0].reason, '企业确认分与事实不符');
  assert.equal(allowed.rows[0].createdAt, '2026-10-20T01:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('parseAppealSubject：没有冒号 → stageId 为 null，teamId 是整串', () => {
  const p = parseAppealSubject('t7');
  assert.equal(p.stageId, null);
  assert.equal(p.teamId, 't7');
});

test('状态机：FLAGGED 分支可用（PENDING_REVIEW → FLAGGED → CONFIRMED）', () => {
  const { db, close, dataDir } = setup();
  const r1 = transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: '待复核', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(r1.applied, true);
  const r2 = transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'PENDING_REVIEW', to: 'FLAGGED',
    actorId: 'u_admin', reason: '疑似串通', idempotencyKey: 'k2', now: '2026-10-20T00:00:01.000Z',
  });
  assert.equal(r2.applied, true);
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'FLAGGED');
  const r3 = transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'FLAGGED', to: 'CONFIRMED',
    actorId: 'u_admin', reason: '复核后确认', idempotencyKey: 'k3', now: '2026-10-20T00:00:02.000Z',
  });
  assert.equal(r3.applied, true);
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'CONFIRMED');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('段位读取：取最新一条、跳过已软删除的记录、查不到返回 null', () => {
  const { db, close, dataDir } = setup();
  const insertTier = (id, teamId, tier, computedAt, deletedAt) => {
    db.prepare(
      `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, teamId, tier, 0, 0, '[]', computedAt, deletedAt);
  };
  insertTier('tr_t5_old', 't5', 'C', '2026-10-01T00:00:00.000Z', null);
  insertTier('tr_t5_new', 't5', 'D', '2026-10-10T00:00:00.000Z', null);
  insertTier('tr_t6_del', 't6', 'D', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
  assert.equal(getTeamTierRow(db, 't5'), 'D', '同一队伍取最新一条');
  assert.equal(getTeamTierRow(db, 't6'), null, '已软删除的段位记录不算数');
  assert.equal(getTeamTierRow(db, 't_not_exist'), null, '查不到返回 null（不是 undefined）');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉列表：按 status 过滤', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  finalizeStage1(db);
  fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  const admin = { id: 'u_admin', is_superadmin: 1, active: 1 };
  const submitted = listAppeals({ db, filter: { status: 'submitted' }, viewer: admin });
  assert.equal(submitted.total, 1);
  assert.equal(submitted.rows.length, 1);
  const accepted = listAppeals({ db, filter: { status: 'accepted' }, viewer: admin });
  assert.equal(accepted.total, 0);
  assert.deepEqual(accepted.rows, []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('【终审修正 M-6】迁移日志损坏必须 fail loud，不得静默把主体当成 SUBMITTED', () => {
  // ⚠️ 终审修正（Minor，M-6）：`findLatestTransition` 此前把解析失败静默降级成 `{}`
  //    ⇒ detail 里没有 `to` ⇒ getSubjectState 返回 null ⇒ 状态机 `?? 'SUBMITTED'`
  //    ⇒ **把主体当成 SUBMITTED**：既可能放行一次本应被拒的迁移，
  //    也可能报出一个「当前是 SUBMITTED」的**假**状态冲突。
  //    「有迁移记录、但读不出来」= 数据损坏 = 必须显式报错。
  const { db, close, dataDir } = setup();
  transition({
    db, subjectType: 'team_result', subjectId: 'st1:t1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: '待复核', idempotencyKey: 'k-m6', now: '2026-10-20T00:00:00.000Z',
  });
  // 把这条迁移日志的 detail 写坏（模拟历史脏数据）
  db.prepare("UPDATE audit_log SET detail_json = '{BROKEN' WHERE action = 'review_state.transition'").run();

  assert.throws(
    () => transition({
      db, subjectType: 'team_result', subjectId: 'st1:t1', from: 'PENDING_REVIEW', to: 'CONFIRMED',
      actorId: 'u_admin', reason: '确认', idempotencyKey: 'k-m6b', now: '2026-10-20T01:00:00.000Z',
    }),
    (err) => {
      assert.equal(err.code, 'AUDIT_LOG_CORRUPT', `必须是数据损坏错误（实际 ${err.code}：${err.message}）`);
      assert.equal(err.status, 500);
      return true;
    },
    '日志损坏必须 fail loud —— 不得当成 SUBMITTED，也不得报假的 409 状态冲突',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

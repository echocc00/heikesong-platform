// platform/test/audit-repo.test.js —— P4 审计数据模型与仓储层
//
// 规则溯源：
//   - 限频计数必须落库（只在内存计数 = 进程重启即失效 = 等于没有限频）→ 全局约束「限频落库」
//   - 幂等键唯一约束必须在数据库层，不能靠「先查再插」→ 设计文档 §11.1
//   - 只增不改：重算走 revision + 1，旧 revision 保留供复盘 → 设计文档 §11.1
//   - 检测 ≠ 处罚：flagged_reviews 只记录「有疑问」→ 设计文档 §11.1
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { queryAuditLog, findLatestTransition } from '../src/db/repo/audit-log.js';
import { writeAuditLog } from '../src/audit/log.js';
import { createFlag, findOpenFlag, listFlagRows, resolveFlagRow } from '../src/db/repo/flags.js';
import { findIdempotency, insertIdempotency } from '../src/db/repo/idempotency.js';
import {
  countBucket, incrementBucket, slidingWindowCount, slidingWindowEvents, acquireLock,
} from '../src/db/repo/rate-limit.js';
import { insertAppeal, getAppeal, listAppealRows, updateAppeal } from '../src/db/repo/appeals.js';
import { insertSnapshot, getSnapshot, nextRevision, listComputationRows } from '../src/db/repo/computations.js';
import { withTransaction } from '../src/db/tx.js';
import { appError, AppError, badRequest, unauthenticated, forbidden, notFound, conflict, rateLimited } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4repo-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  seedRefs(db);
  return { db, close, dataDir };
}

/**
 * 造出被外键引用的行。
 * ⚠️ 规格原写法直接用 'u_admin' / 'st1' 写审计日志与计算快照，
 *    但 audit_log.actor_id REFERENCES users(id)、computation_snapshots.stage_id
 *    REFERENCES stages(id) —— **不建被引用的行就会 FOREIGN KEY constraint failed**。
 *    这不是测试写得随意，是规格自带缺陷：照抄必然红。
 */
function seedRefs(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000999','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed');
    INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
    VALUES ('t1','ed_1','甲队','u_admin','D','active','2026-10-20T00:00:00.000Z'),
           ('t2','ed_1','乙队','u_admin','D','active','2026-10-20T00:00:00.000Z');
  `);
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
}

test('迁移 005 建出 P4 的四张表，且 P0 的 audit_log 仍在', () => {
  const { db, close, dataDir } = setup();
  const tables = tableNames(db);
  for (const t of ['flagged_reviews', 'idempotency_keys', 'rate_limit_events', 'appeals', 'audit_log']) {
    assert.ok(tables.includes(t), `缺表 ${t}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('writeAuditLog 把 action / entity / entity_id / detail_json 写进去', () => {
  const { db, close, dataDir } = setup();
  writeAuditLog(db, {
    actorId: 'u_admin',
    action: 'review_state.transition',
    entity: 'stage_result',
    entityId: 'st1',
    detail: { from: 'SUBMITTED', to: 'PENDING_REVIEW', reason: '待复核', at: '2026-10-20T00:00:00.000Z' },
    now: '2026-10-20T00:00:00.000Z',
  });
  const { rows, total } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(total, 1);
  assert.equal(rows[0].entity, 'stage_result');
  assert.equal(rows[0].entity_id, 'st1');
  assert.equal(rows[0].actor_id, 'u_admin');
  assert.equal(JSON.parse(rows[0].detail_json).to, 'PENDING_REVIEW');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('queryAuditLog 能按 entity + entityId 过滤，总数与行数一致', () => {
  const { db, close, dataDir } = setup();
  writeAuditLog(db, { action: 'a', entity: 'stage_result', entityId: 'st1', now: '2026-10-20T00:00:00.000Z' });
  writeAuditLog(db, { action: 'b', entity: 'stage_result', entityId: 'st1', now: '2026-10-20T00:00:01.000Z' });
  writeAuditLog(db, { action: 'a', entity: 'stage_result', entityId: 'st2', now: '2026-10-20T00:00:02.000Z' });
  const { rows, total } = queryAuditLog(db, { entity: 'stage_result', entityId: 'st1' });
  assert.equal(total, 2);
  assert.equal(rows.length, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('findLatestTransition 返回最后一次迁移的 to_state', () => {
  const { db, close, dataDir } = setup();
  writeAuditLog(db, {
    action: 'review_state.transition', entity: 'stage_result', entityId: 'st1',
    detail: { from: 'SUBMITTED', to: 'PENDING_REVIEW' }, now: '2026-10-20T00:00:00.000Z',
  });
  writeAuditLog(db, {
    action: 'review_state.transition', entity: 'stage_result', entityId: 'st1',
    detail: { from: 'PENDING_REVIEW', to: 'CONFIRMED' }, now: '2026-10-20T00:00:01.000Z',
  });
  const latest = findLatestTransition(db, 'stage_result', 'st1');
  assert.equal(latest.to, 'CONFIRMED');
  assert.equal(latest.from, 'PENDING_REVIEW');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('同毫秒并列的迁移日志必须按【插入次序】取最后一条（不能靠随机 UUID 破并列）', () => {
  const { db, close, dataDir } = setup();
  const at = '2026-10-20T00:00:00.000Z';
  // ⚠️ 故意让 id 的字典序与插入次序**相反**：
  //    `ORDER BY id DESC` 会取到 'z1'（最先插入的那条），
  //    `ORDER BY rowid DESC` 才取到 'x1'（最后插入的那条）⇒ 判别性数据集，两种实现结果**不同**。
  //    （`audit_log.id` 是 randomUUID() ⇒ 同毫秒并列时次序随机 ⇒ 状态机随机报 409。
  //      Task 5 实跑：200 次里 135 次读到过期态。）
  for (const id of ['z1', 'y1', 'x1']) {
    db.prepare(
      'INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(id, 'u_admin', 'review_state.transition', 'stage_result', 'st1', JSON.stringify({ to: id }), at);
  }
  const latest = findLatestTransition(db, 'stage_result', 'st1');
  assert.equal(latest.to, 'x1', '同毫秒并列时必须取最后插入的那条（rowid 序），不能靠 id 的字典序');
  const { rows } = queryAuditLog(db, { entity: 'stage_result', entityId: 'st1' });
  assert.equal(rows[0].id, 'x1', '列表也必须按插入次序倒序');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等键：同一 (key, scope) 只能插入一次，第二次返回 false', () => {
  const { db, close, dataDir } = setup();
  const first = insertIdempotency(db, {
    key: 'req_abc', scope: 'review.submit', requestId: 'req_abc', response: { ok: 1 }, now: '2026-10-20T00:00:00.000Z',
  });
  const second = insertIdempotency(db, {
    key: 'req_abc', scope: 'review.submit', requestId: 'req_abc', response: { ok: 2 }, now: '2026-10-20T00:00:01.000Z',
  });
  assert.equal(first, true);
  assert.equal(second, false, '重复插入必须被拒绝（否则重复提交会生效两次）');
  const found = findIdempotency(db, { key: 'req_abc', scope: 'review.submit' });
  assert.equal(JSON.parse(found.response_json).ok, 1, '必须保留首次的响应');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ 幂等键的兜底只认「唯一约束」：其它约束错必须继续往上抛（不得被当成「重复请求」）', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 若用 `INSERT OR IGNORE`，NOT NULL 违规会被静默吞掉 → 返回 false（=「重复请求」）
  //    → 调用方以为写成功了，实际一条都没落库（P1 的 T-7 踩过同款坑）。
  assert.throws(
    () => insertIdempotency(db, { key: null, scope: 'review.submit', now: '2026-10-20T00:00:00.000Z' }),
    /NOT NULL/i,
    'NOT NULL 违规不得被当成「重复请求」',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('限频计数落库：同一 bucket 递增，滑动窗口只数窗口内的', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 判别性数据集：**两个 bucket 必须落在窗口内外两侧**。
  //    规格原写法给两个 bucket 传了同一个 now（都在窗口外），
  //    那样「滑动窗口计数」与「全量计数」结果相同 → 测不出窗口过滤有没有生效。
  //    这里：s:100 在窗口内（count 2）、s:050 在窗口外（count 1）。
  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100', now: '2026-10-20T00:01:00.000Z' });
  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100', now: '2026-10-20T00:01:00.000Z' });
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100' }), 2);

  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:050', now: '2026-10-20T00:00:00.000Z' });
  // 窗口 60 秒：now=00:01:20 → 窗口 = [00:00:20, 00:01:20]
  //   → s:100（00:01:00 起，2 次）在窗口内；s:050（00:00:00 起，1 次）在窗口外
  const n = slidingWindowCount(db, {
    subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', now: '2026-10-20T00:01:20.000Z', windowSeconds: 60,
  });
  assert.equal(n, 2, '只有窗口内的 2 次算数（窗口外的 1 次必须被排除）');
  const events = slidingWindowEvents(db, {
    subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', now: '2026-10-20T00:01:20.000Z', windowSeconds: 60,
  });
  assert.equal(events.length, 1, '窗口外的事件不出现在事件列表里');
  assert.equal(events[0].bucket, 's:100');
  // 全量口径（不做窗口过滤）应当是 3 —— 与窗口口径 2 不同 ⇒ 数据集有判别力
  assert.equal(
    countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100' })
    + countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:050' }),
    3,
    '窗口内 2 + 窗口外 1 = 3（若实现不按窗口过滤，这里与上面的 2 无法区分）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交锁：同一 subject 连续取锁第二次失败，锁过期后可再取', () => {
  const { db, close, dataDir } = setup();
  const a = acquireLock(db, { subjectKey: 'judge:u1', rule: 'lock:reviewSubmit', now: '2026-10-20T00:00:00.000Z', lockSeconds: 5 });
  assert.equal(a.acquired, true);
  const b = acquireLock(db, { subjectKey: 'judge:u1', rule: 'lock:reviewSubmit', now: '2026-10-20T00:00:01.000Z', lockSeconds: 5 });
  assert.equal(b.acquired, false);
  assert.ok(b.retryAfterSeconds >= 1);
  const c = acquireLock(db, { subjectKey: 'judge:u1', rule: 'lock:reviewSubmit', now: '2026-10-20T00:00:06.000Z', lockSeconds: 5 });
  assert.equal(c.acquired, true, '锁过期后必须能重新获取');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('flagged_reviews：可建、可按 kind+维度查未决、可裁决', () => {
  const { db, close, dataDir } = setup();
  const id = createFlag(db, {
    stageId: 'st1', teamId: 't1', judgeId: 'j1', kind: 'low_variance',
    detail: { judgeId: 'j1', dimension: 'innovation', stdev: 1.2 }, now: '2026-10-20T00:00:00.000Z',
  });
  const open = findOpenFlag(db, { kind: 'low_variance', stageId: 'st1', teamId: 't1', judgeId: 'j1' });
  assert.equal(open.id, id);
  assert.equal(open.status, 'open');
  assert.equal(resolveFlagRow(db, { id, status: 'confirmed', reviewedBy: 'u_admin', reviewedAt: '2026-10-20T01:00:00.000Z' }), 1);
  // ⚠️ 判别性数据集：库里同时存在**一条未决**与**一条已裁决**的 flag。
  //    只放一条的话，「按 status 过滤」与「不过滤」结果相同 ⇒ 测不出过滤有没有生效。
  const otherId = createFlag(db, {
    stageId: 'st1', teamId: 't2', judgeId: 'j2', kind: 'low_variance',
    detail: { judgeId: 'j2', dimension: 'innovation', stdev: 0.4 }, now: '2026-10-20T02:00:00.000Z',
  });
  const { rows } = listFlagRows(db, { status: 'confirmed' });
  assert.equal(rows.length, 1, '按 status 过滤后只剩已裁决的那一条');
  assert.equal(rows[0].reviewed_by, 'u_admin');
  assert.equal(rows[0].id, id);
  // 已裁决的 flag 不得再被「未决查询」找到（否则同一个问题会被重复送审）
  const stillOpen = findOpenFlag(db, { kind: 'low_variance', stageId: 'st1', teamId: 't1', judgeId: 'j1' });
  assert.equal(stillOpen, null, '已裁决的 flag 不再是 open');
  const otherOpen = findOpenFlag(db, { kind: 'low_variance', stageId: 'st1', teamId: 't2', judgeId: 'j2' });
  assert.equal(otherOpen?.id, otherId, '未裁决的那一条仍应能被查到');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('appeals：建档 → 查 → 裁决', () => {
  const { db, close, dataDir } = setup();
  const id = insertAppeal(db, {
    subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T00:00:00.000Z',
  });
  const row = getAppeal(db, id);
  assert.equal(row.status, 'submitted');
  assert.equal(row.subject_id, 'st1:t1');
  updateAppeal(db, { id, status: 'accepted', decidedBy: 'u_admin', decidedAt: '2026-10-20T02:00:00.000Z', decisionNote: '成立，重算' });
  const after = getAppeal(db, id);
  assert.equal(after.status, 'accepted');
  assert.equal(after.decision_note, '成立，重算');
  assert.equal(listAppealRows(db, { status: 'accepted' }).rows.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computation_snapshots：revision 递增，旧 revision 保留（不覆盖历史）', () => {
  const { db, close, dataDir } = setup();
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 1);
  insertSnapshot(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 1 }, output: { total: 80 }, trace: {}, revision: 1, now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 2);
  insertSnapshot(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 2 }, output: { total: 81 }, trace: {}, revision: 2, now: '2026-10-20T01:00:00.000Z',
  });
  assert.equal(getSnapshot(db, 'c1').revision, 1, '旧 revision 必须保留供复盘');
  assert.equal(getSnapshot(db, 'c2').revision, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ nextRevision 传 teamId 时按队伍收窄，不传时行为与 P2 一致（不得重定义 P2 的函数）', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 判别性数据集：两支队的 revision **必须不对称**。
  //    若两队都是 1，则「按队伍收窄」与「赛段级」算出的下一轮都是 2 ⇒ 测不出差异。
  insertSnapshot(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', teamId: 't1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 3, now: '2026-10-20T00:00:00.000Z',
  });
  insertSnapshot(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', teamId: 't2', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 1, now: '2026-10-20T00:00:01.000Z',
  });
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1', teamId: 't1' }), 4, 't1 自己的下一轮是 4');
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1', teamId: 't2' }), 2, 't2 自己的下一轮是 2（不受 t1 影响）');
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 4, '不传 teamId → 赛段级口径（P2 原样）');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ listComputationRows：按 kind/stageId 过滤 + 最近优先 + 带总数', () => {
  const { db, close, dataDir } = setup();
  insertSnapshot(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 1, now: '2026-10-20T00:00:00.000Z',
  });
  insertSnapshot(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 2, now: '2026-10-20T01:00:00.000Z',
  });
  insertSnapshot(db, {
    id: 'c3', kind: 'recompute', stageId: 'st1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 1, now: '2026-10-20T02:00:00.000Z',
  });
  const all = listComputationRows(db, {});
  assert.equal(all.total, 3);
  assert.equal(all.rows.length, 3);
  assert.deepEqual(all.rows.map((r) => r.id), ['c3', 'c2', 'c1'], '必须最近优先（倒序）');
  const byKind = listComputationRows(db, { kind: 'stage_score' });
  assert.equal(byKind.total, 2, '按 kind 过滤');
  const byStage = listComputationRows(db, { stageId: 'st1' });
  assert.equal(byStage.total, 3);
  const paged = listComputationRows(db, { limit: 1 });
  assert.equal(paged.total, 3, '总数不受 limit 影响');
  assert.equal(paged.rows.length, 1, '但行数受 limit 限制');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ 错误快捷函数的状态码必须逐个正确（notFound=404 / badRequest=400 / conflict=409 / rateLimited=429 …）', () => {
  assert.equal(notFound('没有').status, 404);
  assert.equal(notFound('没有').code, 'NOT_FOUND');
  assert.equal(badRequest('不合法').status, 400);
  assert.equal(forbidden('不许').status, 403);
  assert.equal(conflict('冲突').status, 409);
  assert.equal(rateLimited('太快').status, 429);
  assert.equal(unauthenticated().status, 401);
  assert.equal(unauthenticated().message, '未登录');
  // 快捷函数必须返回 AppError 实例（下游 e instanceof AppError 分支才有效）
  assert.ok(notFound('没有') instanceof AppError, '必须是 AppError 实例');
  assert.equal(notFound('没有', { id: 'x' }).detail.id, 'x', 'detail 必须透传');
});

test('★ 005 迁移的 NOT NULL / DEFAULT 符合契约（kind 与 status 必填，status 有默认值）', () => {
  const { db, close, dataDir } = setup();
  const cols = (table) => Object.fromEntries(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name, c]),
  );
  const flags = cols('flagged_reviews');
  assert.equal(flags.kind.notnull, 1, 'flagged_reviews.kind 必须 NOT NULL');
  assert.equal(flags.status.notnull, 1, 'flagged_reviews.status 必须 NOT NULL');
  assert.equal(flags.status.dflt_value, "'open'", "flagged_reviews.status 默认 'open'");
  assert.equal(flags.detail_json.notnull, 0, 'detail_json 可空');

  const appeals = cols('appeals');
  assert.equal(appeals.status.notnull, 1, 'appeals.status 必须 NOT NULL');
  assert.equal(appeals.status.dflt_value, "'submitted'", "appeals.status 默认 'submitted'");
  assert.equal(appeals.reason.notnull, 1, 'appeals.reason 必须 NOT NULL');

  const idem = cols('idempotency_keys');
  assert.equal(idem.key.notnull, 1, 'idempotency_keys.key 必须 NOT NULL');
  assert.equal(idem.scope.notnull, 1, 'idempotency_keys.scope 必须 NOT NULL');

  const rl = cols('rate_limit_events');
  assert.equal(rl.count.notnull, 1, 'rate_limit_events.count 必须 NOT NULL');
  assert.equal(rl.count.dflt_value, '0', 'rate_limit_events.count 默认 0');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('withTransaction 抛错时整体回滚，不留半写', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => withTransaction(db, () => {
      writeAuditLog(db, { action: 'x', entity: 'e', entityId: '1', now: '2026-10-20T00:00:00.000Z' });
      throw appError(500, 'BOOM', '中途失败');
    }),
    // ⚠️ 规格原写法断言 /BOOM/（匹配 message），但 AppError 的 message 是「中途失败」、
    //    code 才是 'BOOM' ⇒ 照抄必然红。改为按 **code** 断言。
    (err) => err.code === 'BOOM' && err.status === 500,
  );
  const { total } = queryAuditLog(db, { action: 'x' });
  assert.equal(total, 0, '失败事务里的写入必须全部回滚');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('appError 带上 status / code / detail', () => {
  const err = appError(429, 'RATE_LIMITED', '太频繁', { retryAfterSeconds: 7 });
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.detail.retryAfterSeconds, 7);
});

// ── 终审修正（M-3）：同毫秒并列时的破并列键必须是 `rowid`，不是 `id` ──
//
// ⚠️ 为什么这条容易写成「恒绿」：全局约束说「确定性排序的兜底键一律用 SQLite 隐式
//    `rowid`（不用随机 UUID）」，但**同一个库内 UUID 是固定的** ⇒ 顺序其实稳定、
//    分页不会漂移（终审实测：4×5 分页 20 行 distinct=20 / duplicates=0）。
//    ⇒ 光断言「顺序稳定」区分不出 `rowid DESC` 与 `id DESC`。
//    **判别性做法**：让 `id` 的**字典序与插入次序相反**（先插的用 'z…'，后插的用 'a…'），
//    同一毫秒下 —— `rowid DESC` ⇒ 后插的在前；`id DESC` ⇒ 'z…' 在前 ⇒ 两条实现结论相反。
const SAME_MS = '2026-10-20T03:00:00.000Z';

test('flagged_reviews：同毫秒并列时，后插入的必须在前（rowid 破并列，不是 id）', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ id 的字典序与插入次序**故意相反**
  createFlag(db, { id: 'z-first-inserted', kind: 'low_variance', detail: { n: 1 }, now: SAME_MS });
  createFlag(db, { id: 'a-second-inserted', kind: 'low_variance', detail: { n: 2 }, now: SAME_MS });
  const { rows } = listFlagRows(db, { kind: 'low_variance' });
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].id,
    'a-second-inserted',
    '同毫秒并列时必须按 rowid 破并列（后插入的在前）；用 id 破并列会得到相反的顺序',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('appeals：同毫秒并列时，后插入的必须在前（rowid 破并列，不是 id）', () => {
  const { db, close, dataDir } = setup();
  insertAppeal(db, { id: 'z-first-inserted', subjectType: 'team_result', subjectId: 'st1:t1', reason: '先插的', now: SAME_MS });
  insertAppeal(db, { id: 'a-second-inserted', subjectType: 'team_result', subjectId: 'st1:t1', reason: '后插的', now: SAME_MS });
  const { rows } = listAppealRows(db, {});
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].id,
    'a-second-inserted',
    '同毫秒并列时必须按 rowid 破并列（后插入的在前）；用 id 破并列会得到相反的顺序',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computation_snapshots：同毫秒并列时，后插入的必须在前（rowid 破并列，不是 id）', () => {
  const { db, close, dataDir } = setup();
  insertSnapshot(db, {
    id: 'z-first-inserted', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 1 }, output: { total: 80 }, trace: {}, revision: 1, now: SAME_MS,
  });
  insertSnapshot(db, {
    id: 'a-second-inserted', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 2 }, output: { total: 81 }, trace: {}, revision: 2, now: SAME_MS,
  });
  const { rows } = listComputationRows(db, { kind: 'stage_score', stageId: 'st1' });
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].id,
    'a-second-inserted',
    '同毫秒并列时必须按 rowid 破并列（后插入的在前）；用 id 破并列会得到相反的顺序',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

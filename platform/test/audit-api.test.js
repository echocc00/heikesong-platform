// platform/test/audit-api.test.js —— P4 审计 API（7 个接口）+ trace 抽屉 + 复核队列接线
//
// 规则溯源：
//   - 「审计 API 的路径与语义」→ INTERFACES.md §5「API（P4）」
//   - 「三态状态码」→ 设计文档 §7.3（列表不满足 → 200+空集；单条不满足 → 404；禁用 → 403）
//   - 「限频触发 → 429 + retryAfterSeconds + Retry-After 响应头」→ 设计文档 §11.1（R-AUD-05）
//   - 「可见性在 API 层过滤」→ 设计文档 §6.6（前端隐藏 = 数据已泄露）
//   - 「证据三列 + 按发行方去重」→ R-AUD-04
//   - 「幂等只生效一次」→ 设计文档 §11.1（重复提交返回首次的响应）
//
// ⚠️ **Task 5（复核与申诉状态机）由并行 Task 落地**：本文件用**动态 import** 探测
//    `src/services/review-state.js` 是否已落地。
//    没落地时，依赖它的用例**跳过**（跳过原因写明「Task 5 未落地」），
//    其余用例照常跑 —— ⛔ 绝不伪造 Task 5 的实现，也不用桩把绿灯骗出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { createUser, getUserById, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { recordComputation } from '../src/services/audit.js';
import { createFlag } from '../src/db/repo/flags.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyScoreVisibility } from '../src/http/routes/review.js';
import { rateLimited } from '../src/errors.js';
import { callJson } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

// Task 5 的复核与申诉状态机：并行 Task 落地，未落地时相关用例跳过（不伪造实现）。
const reviewState = await import('../src/services/review-state.js').catch(() => null);
const skipNoReviewState = reviewState
  ? false
  : 'Task 5 的 src/services/review-state.js 尚未落地（并行 Task），依赖它的用例跳过';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4api-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app, rules };
}

/**
 * 外键夹具。
 * ⚠️ PRAGMA foreign_keys = ON（src/db/sqlite.js）—— 凡是被引用的行必须先建，
 *    否则一律 FOREIGN KEY constraint failed（Task 2 的同款修正）。
 *    规格自带用例直接写 'st1' / 'u_admin' / 't1'（这三个 id 在库里都不存在）→ 必炸。
 *    所以这里建真实的 users / editions / stages / teams / tier_records，
 *    断言里的 id 一律用真实行 id 拼出来。
 */
function seedRefs(db) {
  const admin = createUser(db, { name: '管理员', phone: '13800000001', password: 'pw' });
  setSuperadmin(db, admin.id);
  // ⚠️ 必须**重新读一次**：setSuperadmin 改的是库里的行，createUser 返回的是改之前的快照 ——
  //    直接拿旧对象调 can() 会把超管判成普通用户（这正是「静默降级」最难查的一类）。
  const adminUser = getUserById(db, admin.id);
  const judge = createUser(db, { name: '评委', phone: '13800000002', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13800000003', password: 'pw' });

  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertCapability(db, 'audit:write', '裁决复核项与申诉');
  insertCapability(db, 'appeal:write', '提交申诉');
  insertRole(db, 'admin', '组委会');
  insertRole(db, 'captain', '队长');
  insertRoleCapability(db, 'admin', 'audit:read');
  insertRoleCapability(db, 'admin', 'audit:write');
  insertRoleCapability(db, 'admin', 'appeal:write');
  insertRoleCapability(db, 'captain', 'appeal:write');
  insertUserRole(db, captain.id, 'captain');

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  // 评委必须在本赛段评委名单里，否则 review-state 的权限闸门直接 403
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, status: 'active', now: NOW,
  });
  // tier_records.team_id REFERENCES teams(id) → 队伍必须先建
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES (?, ?, 'D', 0, 0, '[]', ?, NULL)`,
  ).run('tr_t1', team.id, NOW);
  return { admin: adminUser, judge, captain, edition, stage, team };
}

// 输入快照按 INTERFACES.md §3 的契约构造（真实权重表 + 合法 submissions）。
// ⚠️ judges 的形状必须是 P2 的 scoreStage **实际认**的 { judgeId, seat }：
//    规格写的 { id: 'j1' } 会让评委池为空 → 所有打分被静默丢弃 → 复算结果恒为空，
//    diff 测试就会因为「两边都没数据」而假绿。
//    （规格原文已授权调整：「若 P2 的 scoreStage 对入参结构有更严格要求，按 P2 的实际结构调整本函数，其余断言不变」。）
function makeInput(rules) {
  return {
    configKey: 'scoring.final',
    ruleVersion: `scoring.final@${rules.scoring.final.version}`,
    config: rules.scoring.final,
    judges: [{ judgeId: 'j1', seat: 'judge' }],
    submissions: [{ judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 }],
    enterpriseConfirmations: [],
    peerReviews: [],
  };
}

/** 用真实引擎算一遍输出（复算与快照必须是同一套算法，比对才有意义）。 */
function engineOutput(input) {
  return scoreStage({
    config: input.config,
    judges: input.judges,
    submissions: input.submissions,
    enterpriseConfirmations: input.enterpriseConfirmations,
    peerReviews: input.peerReviews,
  });
}

test('GET /api/audit/computations/:id 返回三件套', async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const input = makeInput(rules);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: refs.stage.id, ruleVersion: input.ruleVersion,
    input, output: { teams: [{ teamId: 't1', total: 80 }] }, trace: { normalization: {} },
  });
  const res = await callJson(app, 'GET', `/api/audit/computations/${id}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.ruleVersion, input.ruleVersion);
  assert.equal(res.json.output.teams[0].total, 80);
  assert.ok(res.json.input.submissions.length > 0, '输入快照必须能重放');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/computations/:id 未登录返回 401，单条不存在返回 404', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const anon = await callJson(app, 'GET', '/api/audit/computations/nope');
  assert.equal(anon.status, 401);
  const missing = await callJson(app, 'GET', '/api/audit/computations/nope', { token });
  assert.equal(missing.status, 404);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/computations/:id/diff 返回 diff 与 warnings（能被看见）', async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const input = makeInput(rules);
  // 快照存的是「真实引擎算出来的结果，只把总分改了」——
  // ⛔ 不能拿手写的假输出当快照：那样 diff 里的差异会来自「快照压根不是这套算法算的」，
  //    区分不出「引擎变了」与「快照被改」两种情形（判别性要求）。
  const output = engineOutput(input);
  output.teams[0].total = 999;
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: refs.stage.id, ruleVersion: input.ruleVersion,
    input, output, trace: {},
  });
  const res = await callJson(app, 'GET', `/api/audit/computations/${id}/diff`, { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.diff));
  assert.ok(Array.isArray(res.json.warnings));
  assert.ok('identical' in res.json);
  assert.equal(res.json.identical, false, '快照被改后必须报不一致');
  assert.ok(res.json.diff.length > 0, 'diff 不能为空');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/computations/:id/diff 精确定位到被改的那一处（path 可定位）', async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const input = makeInput(rules);
  const output = engineOutput(input);
  output.teams[0].total = output.teams[0].total + 1;   // 只改一个数
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: refs.stage.id, ruleVersion: input.ruleVersion,
    input, output, trace: {},
  });
  const res = await callJson(app, 'GET', `/api/audit/computations/${id}/diff`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.diff.length, 1, `只改一个数就只该有一条差异（实际 ${JSON.stringify(res.json.diff)}）`);
  assert.equal(res.json.diff[0].path, 'teams[t1].total');
  assert.equal(res.json.identical, false);
  // 规则版本没变 → 不能谎报「无法严格复算」
  assert.equal(
    res.json.warnings.some((w) => w.code === 'rule_version_changed'),
    false,
    '规则版本未变时不得出现 rule_version_changed 告警',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/log 无权访问返回 200 + 空集，有权返回行', async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  const adminToken = createSession(db, refs.admin.id).token;
  const judgeToken = createSession(db, refs.judge.id).token;
  const input = makeInput(rules);
  recordComputation({
    db, kind: 'stage_score', stageId: refs.stage.id, ruleVersion: input.ruleVersion,
    input, output: engineOutput(input), trace: {},
  });
  const anon = await callJson(app, 'GET', '/api/audit/log');
  assert.equal(anon.status, 401);
  const denied = await callJson(app, 'GET', '/api/audit/log', { token: judgeToken });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.json.rows, []);
  const allowed = await callJson(app, 'GET', '/api/audit/log', { token: adminToken });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.json.rows));
  assert.ok(allowed.json.rows.length > 0, '有权时应能看到审计行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/flags 返回复核队列；POST resolve 裁决并留痕', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const flagId = createFlag(db, {
    stageId: refs.stage.id, teamId: refs.team.id, judgeId: refs.judge.id, kind: 'low_variance',
    detail: { judgeId: refs.judge.id, dimension: 'innovation', stdev: 1, n: 5, mean: 80, direction: 'too_low', action: 'alert_only' },
  });
  const list = await callJson(app, 'GET', '/api/audit/flags', { token });
  assert.equal(list.status, 200);
  assert.equal(list.json.rows.length, 1);

  const resolve = await callJson(app, 'POST', `/api/audit/flags/${flagId}/resolve`, {
    token,
    body: {
      status: 'confirmed',
      reason: '确认为异常宽严，列入观察名单',
      evidence: [{ url: 'https://a.example/1', publisher: '某媒体', independent: true }],
    },
  });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.json.status, 'confirmed');
  assert.equal(resolve.json.detail.evidence.uniquePublishers, 1);
  // 裁决必须留痕（审计日志）
  const log = await callJson(app, 'GET', '/api/audit/log?action=flag.resolve', { token });
  assert.equal(log.json.rows.length, 1, '裁决必须写一条审计日志');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/audit/flags/:id/resolve 缺理由返回 400（不静默通过）', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const flagId = createFlag(db, {
    stageId: refs.stage.id, kind: 'burst_submit',
    detail: { subjectId: refs.judge.id, count: 9, windowStart: 'x', windowEnd: 'y' },
  });
  const res = await callJson(app, 'POST', `/api/audit/flags/${flagId}/resolve`, {
    token, body: { status: 'confirmed', reason: '  ' },
  });
  assert.equal(res.status, 400);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/flags 无权访问返回 200 + 空集（列表三态）', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const judgeToken = createSession(db, refs.judge.id).token;
  createFlag(db, {
    stageId: refs.stage.id, kind: 'burst_submit',
    detail: { subjectId: refs.judge.id, count: 9, windowStart: 'x', windowEnd: 'y' },
  });
  const res = await callJson(app, 'GET', '/api/audit/flags', { token: judgeToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.rows, []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 无权提交返回 403，未登录返回 401（能力点闸门先于业务）', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const judgeToken = createSession(db, refs.judge.id).token;
  const body = { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '理由' };
  const denied = await callJson(app, 'POST', '/api/appeals', { token: judgeToken, body });
  assert.equal(denied.status, 403);
  const anon = await callJson(app, 'POST', '/api/appeals', { body });
  assert.equal(anon.status, 401);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 超限返回 429 + Retry-After（不静默丢包）', { skip: skipNoReviewState }, async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  rules.audit.rateLimit.appealSubmit = {
    sliding: { seconds: 60, max: 2 },
    perMinute: { max: 2 },
  };
  const token = createSession(db, refs.captain.id).token;
  for (const [from, to, key] of [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']]) {
    reviewState.transition({
      db, subjectType: 'stage_result', subjectId: refs.stage.id, from, to,
      actorId: refs.admin.id, reason: 'x', idempotencyKey: key, now: NOW,
    });
  }
  const body = { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '企业确认分与事实不符' };
  const first = await callJson(app, 'POST', '/api/appeals', { token, body });
  assert.equal(first.status, 200);
  const second = await callJson(app, 'POST', '/api/appeals', { token, body });
  assert.equal(second.status, 200);
  const third = await callJson(app, 'POST', '/api/appeals', { token, body });
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers['Retry-After']) >= 1, '必须带 Retry-After 响应头');
  assert.ok(third.json.error.detail.retryAfterSeconds >= 1);
  // P4-3：限频计数必须落库（只在内存计数 = 进程重启即失效 = 等于没有限频）
  const events = db.prepare('SELECT COUNT(*) AS n FROM rate_limit_events').get().n;
  assert.ok(events > 0, '限频计数必须落 rate_limit_events 表');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 超限后换连接（模拟重启）仍然超限（限频落库）', { skip: skipNoReviewState }, async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  rules.audit.rateLimit.appealSubmit = {
    sliding: { seconds: 60, max: 1 },
    perMinute: { max: 1 },
  };
  const token = createSession(db, refs.captain.id).token;
  for (const [from, to, key] of [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']]) {
    reviewState.transition({
      db, subjectType: 'stage_result', subjectId: refs.stage.id, from, to,
      actorId: refs.admin.id, reason: 'x', idempotencyKey: key, now: NOW,
    });
  }
  const body = { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '企业确认分与事实不符' };
  const first = await callJson(app, 'POST', '/api/appeals', { token, body });
  assert.equal(first.status, 200);
  close();

  // 重新打开同一个库文件（模拟进程重启）→ 限频仍应生效
  const { db: db2, close: close2 } = openDatabase({ dataDir });
  const app2 = createApp({ db: db2, rules, webDir });
  const again = await callJson(app2, 'POST', '/api/appeals', { token, body });
  assert.equal(again.status, 429, '重启后仍必须超限（限频计数只在内存 = 没有限频）');
  assert.ok(Number(again.headers['Retry-After']) >= 1);
  close2();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 理由为空返回 400', { skip: skipNoReviewState }, async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.captain.id).token;
  const res = await callJson(app, 'POST', '/api/appeals', {
    token, body: { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '' },
  });
  assert.equal(res.status, 400);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals/:id/decide 成立返回 recomputeRequired=true', { skip: skipNoReviewState }, async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const adminToken = createSession(db, refs.admin.id).token;
  const captainToken = createSession(db, refs.captain.id).token;
  for (const [from, to, key] of [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']]) {
    reviewState.transition({
      db, subjectType: 'stage_result', subjectId: refs.stage.id, from, to,
      actorId: refs.admin.id, reason: 'x', idempotencyKey: key, now: NOW,
    });
  }
  const filed = await callJson(app, 'POST', '/api/appeals', {
    token: captainToken,
    body: { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '企业确认分与事实不符' },
  });
  assert.equal(filed.status, 200);
  const decided = await callJson(app, 'POST', `/api/appeals/${filed.json.id}/decide`, {
    token: adminToken, body: { decision: 'accepted', note: '成立，重算' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.recomputeRequired, true);
  assert.equal(decided.json.appeal.status, 'accepted');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 同一 requestId 重复提交只生效一次，返回首次的响应', { skip: skipNoReviewState }, async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.captain.id).token;
  for (const [from, to, key] of [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']]) {
    reviewState.transition({
      db, subjectType: 'stage_result', subjectId: refs.stage.id, from, to,
      actorId: refs.admin.id, reason: 'x', idempotencyKey: key, now: NOW,
    });
  }
  const body = {
    subjectType: 'team_result',
    subjectId: `${refs.stage.id}:${refs.team.id}`,
    reason: '企业确认分与事实不符',
    requestId: 'req-001',
  };
  const first = await callJson(app, 'POST', '/api/appeals', { token, body });
  assert.equal(first.status, 200);
  const second = await callJson(app, 'POST', '/api/appeals', { token, body });
  assert.equal(second.status, 200);
  assert.equal(second.json.id, first.json.id, '重复提交必须返回首次的响应');
  const rows = db.prepare('SELECT COUNT(*) AS n FROM appeals').get().n;
  assert.equal(rows, 1, '同一 requestId 只能落一条申诉');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/appeals 申诉列表：无权返回 200 + 空集，有权返回行', { skip: skipNoReviewState }, async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const adminToken = createSession(db, refs.admin.id).token;
  const judgeToken = createSession(db, refs.judge.id).token;
  for (const [from, to, key] of [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']]) {
    reviewState.transition({
      db, subjectType: 'stage_result', subjectId: refs.stage.id, from, to,
      actorId: refs.admin.id, reason: 'x', idempotencyKey: key, now: NOW,
    });
  }
  const captainToken = createSession(db, refs.captain.id).token;
  const filed = await callJson(app, 'POST', '/api/appeals', {
    token: captainToken,
    body: { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '理由' },
  });
  assert.equal(filed.status, 200);
  const denied = await callJson(app, 'GET', '/api/appeals', { token: judgeToken });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.json.rows, []);
  const allowed = await callJson(app, 'GET', '/api/appeals', { token: adminToken });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.rows.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/stages/:stageId/review-state 的分数过一遍可见性过滤（API 层，不是前端隐藏）', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const judgeToken = createSession(db, refs.judge.id).token;
  const res = await callJson(app, 'GET', `/api/stages/${refs.stage.id}/review-state`, { token: judgeToken });
  // 当前 P2 的 getReviewState 不返回分数数组 → 过滤是恒等的，接口照常工作。
  // ⛔ 一旦 P2 开始返回分数，这条接口必须把分数过一遍 filterVisibleScores
  //    （设计文档 §6.6：前端隐藏 = 数据已泄露）。
  assert.equal(res.status, 200);
  assert.ok(res.json && typeof res.json === 'object');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('applyScoreVisibility：有分数时必须过一遍过滤（模块缺失 → 503 fail closed）', async () => {
  const { db, close, dataDir } = setup();
  const refs = seedRefs(db);
  const scores = [{ judgeId: 'someone-else', teamId: refs.team.id, dimension: 'innovation', rawScore: 90 }];
  if (reviewState) {
    // 赛段进入 PENDING_REVIEW → 除本人与组委会外，分数不可见
    reviewState.transition({
      db, subjectType: 'stage_result', subjectId: refs.stage.id, from: 'SUBMITTED', to: 'PENDING_REVIEW',
      actorId: refs.admin.id, reason: '待复核', idempotencyKey: 'k-vis', now: NOW,
    });
    const judgeView = await applyScoreVisibility({
      db, stageId: refs.stage.id, viewer: refs.judge, state: { scores },
    });
    assert.equal(judgeView.scores[0].rawScore, null, '无权限者的分数必须被置空');
    assert.equal(judgeView.scores[0].hidden, true);
    const adminView = await applyScoreVisibility({
      db, stageId: refs.stage.id, viewer: refs.admin, state: { scores },
    });
    assert.equal(adminView.scores[0].rawScore, 90, '组委会看得到全量分数');
  } else {
    // Task 5 未落地 → 503（fail closed：宁可报错，也不放行未过滤的分数）
    const out = await applyScoreVisibility({
      db, stageId: refs.stage.id, viewer: refs.judge, state: { scores },
    });
    assert.equal(out.status, 503);
    assert.equal(out.body.error.code, 'SCORE_VISIBILITY_UNAVAILABLE');
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('单条无权访问返回 404（不泄露记录是否存在）：无 audit:read 的人读快照', async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  const judgeToken = createSession(db, refs.judge.id).token;
  const input = makeInput(rules);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: refs.stage.id, ruleVersion: input.ruleVersion,
    input, output: engineOutput(input), trace: {},
  });
  const res = await callJson(app, 'GET', `/api/audit/computations/${id}`, { token: judgeToken });
  assert.equal(res.status, 404, '单条不满足 → 404（不是 403，也不给数据）');
  assert.equal(res.json.error.code, 'NOT_FOUND');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/computations/:id/diff 无权复算返回 403', async () => {
  const { db, close, dataDir, app, rules } = setup();
  const refs = seedRefs(db);
  const judgeToken = createSession(db, refs.judge.id).token;
  const input = makeInput(rules);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: refs.stage.id, ruleVersion: input.ruleVersion,
    input, output: engineOutput(input), trace: {},
  });
  const res = await callJson(app, 'GET', `/api/audit/computations/${id}/diff`, { token: judgeToken });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'FORBIDDEN');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/audit/flags/:id/resolve 无权裁决返回 403', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const judgeToken = createSession(db, refs.judge.id).token;
  const flagId = createFlag(db, {
    stageId: refs.stage.id, kind: 'burst_submit',
    detail: { subjectId: refs.judge.id, count: 9, windowStart: 'x', windowEnd: 'y' },
  });
  const res = await callJson(app, 'POST', `/api/audit/flags/${flagId}/resolve`, {
    token: judgeToken, body: { status: 'confirmed', reason: '我说了算' },
  });
  assert.equal(res.status, 403);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('分页参数非法（limit=abc）不得把接口打成 500', async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.admin.id).token;
  const res = await callJson(app, 'GET', '/api/audit/log?limit=abc&offset=xyz', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.rows));
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('Task 5 未落地时申诉接口必须 503（fail closed，不静默放行也不 500）', { skip: reviewState ? 'Task 5 已落地，本分支不适用' : false }, async () => {
  const { db, close, dataDir, app } = setup();
  const refs = seedRefs(db);
  const token = createSession(db, refs.captain.id).token;
  const res = await callJson(app, 'POST', '/api/appeals', {
    token, body: { subjectType: 'team_result', subjectId: `${refs.stage.id}:${refs.team.id}`, reason: '理由' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'REVIEW_STATE_UNAVAILABLE');
  const list = await callJson(app, 'GET', '/api/appeals', { token });
  assert.equal(list.status, 503, '申诉列表同样必须 fail closed');
  assert.equal(list.json.error.code, 'REVIEW_STATE_UNAVAILABLE');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('错误响应必须带 Retry-After（限频语义在 HTTP 层，不靠业务代码自己塞头）', async () => {
  const { db, close, dataDir, app } = setup();
  seedRefs(db);
  // 在 app 的 router 上临时挂一个只会抛 429 的**探针路由**：
  // 这里验的是 **server.js 的错误分支**（4xx → 领域错误 + Retry-After 头），
  // 不是业务代码 —— 限频那层（申诉接口）要等 Task 5 落地才能端到端跑。
  app.router.add('GET', '/api/_probe-rate-limited', async () => {
    throw rateLimited('触发限频', { retryAfterSeconds: 7 });
  });
  const res = await callJson(app, 'GET', '/api/_probe-rate-limited');
  assert.equal(res.status, 429);
  assert.equal(res.headers['Retry-After'], '7', '429 必须带 Retry-After 响应头');
  assert.equal(res.json.error.code, 'RATE_LIMITED');
  assert.equal(res.json.error.detail.retryAfterSeconds, 7);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('respond.error() 的第 6 参 extraHeaders 真的写进响应头（向后兼容）', async () => {
  const { error } = await import('../src/http/respond.js');
  const captured = {};
  const res = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end() {},
  };
  error(res, 429, 'RATE_LIMITED', '触发限频', { retryAfterSeconds: 42 }, { 'Retry-After': '42' });
  assert.equal(captured.status, 429);
  assert.equal(captured.headers['Retry-After'], '42');
  assert.equal(captured.headers['Content-Type'], 'application/json; charset=utf-8');
});

test('种子必须注册 audit:write / appeal:write 并授权（能力点没注册 = 权限不存在）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4seed-'));
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(here, '..', 'scripts', 'seed.js')],
    {
      cwd: join(here, '..'), encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: 'Str0ng-Pass!2026' },
      timeout: 60000,
    },
  );
  assert.equal(res.status, 0, `种子应成功：${(res.stdout ?? '').slice(0, 300)}`);
  const { db, close } = openDatabase({ dataDir });
  try {
    const caps = db.prepare('SELECT key FROM capabilities').all().map((r) => r.key);
    assert.ok(caps.includes('audit:write'), '必须注册能力点 audit:write');
    assert.ok(caps.includes('appeal:write'), '必须注册能力点 appeal:write');
    const grants = db.prepare('SELECT role_id, capability FROM role_capabilities').all();
    const has = (role, cap) => grants.some((g) => g.role_id === role && g.capability === cap);
    assert.ok(has('admin', 'audit:write'), 'admin 必须能裁决复核项与申诉');
    assert.ok(has('admin', 'appeal:write'), 'admin 必须能提交申诉');
    assert.ok(has('captain', 'appeal:write'), '队长必须能提交申诉');
  } finally {
    close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 前端视图（trace 抽屉 / 复核队列）────────────────────────────────
// 原生 ESM、无构建 → 视图模块可以被 Node 直接 import（配合最小 DOM 桩）。
// 桩只实现视图真正用到的那几个动作：createElement / innerHTML / appendChild /
// querySelector('#id') / addEventListener / textContent / value / checked。
// ⚠️ innerHTML 里的 id 也要能被 querySelector 找到 —— 视图是这么写的
//    （`head.innerHTML = '...<p id="au-msg">'` 然后 `wrap.querySelector('#au-msg')`），
//    真实浏览器里 innerHTML 会解析成真节点，桩必须等价地暴露这些 id。
function installDom() {
  const listeners = {};
  const mk = (tag) => {
    const el = {
      tagName: tag, className: '', id: '', _text: '', _html: '', _htmlIds: [], _byId: {},
      children: [], handlers: {}, value: '', checked: false,
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        this._htmlIds = [...String(v).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      querySelector(sel) { return queryById(this, sel); },
      replaceChildren() { /* 首屏渲染用不到内容 */ },
    };
    return el;
  };
  const queryById = (root, sel) => {
    if (!sel.startsWith('#')) return null;
    const id = sel.slice(1);
    // 元素自己的 innerHTML 里的 id（真实浏览器里 innerHTML 会解析成子节点）
    if (root._htmlIds.includes(id)) {
      if (!root._byId[id]) { const s = mk('div'); s.id = id; root._byId[id] = s; }
      return root._byId[id];
    }
    const walk = (el) => {
      for (const c of el.children) {
        if (c.id === id) return c;
        if (c._htmlIds.includes(id)) {
          if (!c._byId[id]) { const s = mk('div'); s.id = id; c._byId[id] = s; }
          return c._byId[id];
        }
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  };
  const app = mk('div');
  const win = {
    location: { search: '', hash: '' },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  globalThis.window = win;
  globalThis.document = { createElement: (tag) => mk(tag), getElementById: () => app };
  return { mk, win, listeners, app };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('前端 trace 抽屉：三件套 + 降级告警置顶 + 复算 diff 必须被看见', async () => {
  installDom();
  const { renderAudit } = await import('../web/views/audit.js');
  const calls = [];
  const ctx = {
    params: { computationId: 'cmp-1' },
    api: {
      get: async (p) => {
        calls.push(p);
        if (p.endsWith('/diff')) {
          return {
            identical: false,
            diff: [{ path: 'teams[t1].total', before: 61, after: 60 }],
            warnings: [{ code: 'strict_replay_failed', message: '快照被改过' }],
          };
        }
        return {
          ruleVersion: 'scoring.final@2026-10-20', revision: 2, createdAt: '2026-10-20T00:00:00.000Z',
          input: { submissions: [{ judgeId: 'j1' }] },
          output: { teams: [{ teamId: 't1', total: 60 }] },
          trace: { normalization: { innovation: { normalized: false, fallbackReason: 'judge_sample_too_small' } } },
        };
      },
    },
  };
  const wrap = renderAudit(ctx);
  await tick();
  assert.ok(calls.includes('/api/audit/computations/cmp-1'), '必须按路由参数拉快照');
  const body = wrap.children[1];
  const warnBox = body.children[0];
  assert.ok(warnBox.innerHTML.includes('降级告警'), '降级告警必须置顶');
  assert.ok(warnBox.innerHTML.includes('未做评委宽严归一化'), '告警必须说清降级原因');
  const teamItem = body.children[1].children[0];
  for (const step of ['原始分', 'z 分', '去极值', '加权', '总分', '破同分']) {
    assert.ok(teamItem.innerHTML.includes(step), `trace 步骤缺 ${step}`);
  }
  const actions = body.children[2];
  const btn = actions.children[0];
  assert.equal(btn.textContent, '用同一输入复算并比对');
  await btn.handlers.click[0]();
  assert.ok(calls.includes('/api/audit/computations/cmp-1/diff'), '复算 diff 必须真的去拉');
  const diffBox = actions.children[1];
  assert.ok(diffBox.innerHTML.includes('identical = false'), 'diff 必须被看见（不能只写一条日志）');
  assert.ok(diffBox.innerHTML.includes('teams[t1].total'), 'diff 必须给出可定位的 path');
});

test('前端复核队列：渲染 + 缺理由不提交 + 裁决后显示独立发行方数', async () => {
  installDom();
  const { renderFlags } = await import('../web/views/flags.js');
  const posts = [];
  const ctx = {
    api: {
      get: async () => ({
        rows: [{ id: 'f1', kind: 'low_variance', status: 'open', stageId: 'st1', teamId: 't1', judgeId: 'j1', detail: { stdev: 1 } }],
        total: 1,
      }),
      post: async (p, body) => {
        posts.push([p, body]);
        return { status: 'confirmed', detail: { evidence: { uniquePublishers: 2 } } };
      },
    },
  };
  const wrap = renderFlags(ctx);
  await tick();
  const row = wrap.children[1].children[0];
  assert.ok(row.innerHTML.includes('low_variance'));
  const form = row.children[0];
  form.querySelector('#fl-reason').value = '   ';
  await form.querySelector('#fl-submit').handlers.click[0]();
  assert.equal(posts.length, 0, '没写理由不得提交');
  assert.equal(form.querySelector('#fl-note').textContent, '必须写理由');
  form.querySelector('#fl-reason').value = ' 确认为异常宽严 ';
  form.querySelector('#fl-url').value = 'https://a.example/1';
  form.querySelector('#fl-publisher').value = '某媒体';
  await form.querySelector('#fl-submit').handlers.click[0]();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/audit/flags/f1/resolve');
  assert.equal(posts[0][1].reason, '确认为异常宽严', '理由要 trim 后提交');
  assert.equal(posts[0][1].evidence.length, 1);
  assert.equal(posts[0][1].evidence[0].publisher, '某媒体');
  assert.ok(form.querySelector('#fl-note').textContent.includes('独立发行方 2 个'), '裁决后要显示按发行方去重的计数');
});

test('前端：服务端数据必须转义（不能变成可执行标记）', async () => {
  installDom();
  const { renderFlags } = await import('../web/views/flags.js');
  const ctx = {
    api: {
      get: async () => ({
        rows: [{ id: 'f1', kind: '<img src=x onerror=alert(1)>', status: 'open', detail: { note: '</pre><script>alert(1)</script>' } }],
        total: 1,
      }),
      post: async () => ({}),
    },
  };
  const wrap = renderFlags(ctx);
  await tick();
  const row = wrap.children[1].children[0];
  assert.ok(row.innerHTML.includes('&lt;img'), '必须转义 <');
  assert.ok(!row.innerHTML.includes('<img'), '不得出现可执行标记');
  assert.ok(!row.innerHTML.includes('<script'), '不得出现可执行标记');
});

test('前端：/audit/:computationId 与 /flags 路由都把参数透传给视图', async () => {
  const dom = installDom();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        user: null, rows: [], total: 0,
        ruleVersion: 'v1', revision: 1, createdAt: 'c', output: { teams: [] }, trace: {},
      }),
    };
  };
  await import('../web/app.js?v=t6-app');
  await tick();
  dom.win.location.hash = '#/audit/cmp-9';
  await dom.listeners.hashchange[0]();
  await tick();
  assert.ok(
    calls.some((u) => u.includes('/api/audit/computations/cmp-9')),
    `trace 抽屉必须拿到路由参数（实际请求：${JSON.stringify(calls)}）`,
  );
  dom.win.location.hash = '#/flags';
  await dom.listeners.hashchange[0]();
  await tick();
  assert.ok(calls.some((u) => u.includes('/api/audit/flags')), '复核队列必须拉 /api/audit/flags');
});

test('前端 trace 抽屉：缺 computationId 时不得发请求（并说清从发榜页进入）', async () => {
  installDom();
  const { renderAudit } = await import('../web/views/audit.js');
  const calls = [];
  const ctx = { params: {}, api: { get: async (p) => { calls.push(p); return {}; } } };
  const wrap = renderAudit(ctx);
  await tick();
  assert.equal(calls.length, 0, '缺 id 时不得发请求');
  assert.ok(wrap.querySelector('#au-msg').textContent.includes('缺少 computationId'));
});

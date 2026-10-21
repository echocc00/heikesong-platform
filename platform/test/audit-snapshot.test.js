import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { recordComputation, getComputation, recomputeAndDiff, listAuditLog } from '../src/services/audit.js';
import { diffValues } from '../src/domain/diff.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4snap-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  seedRefs(db);
  return { db, close, dataDir };
}

/**
 * 造出被外键引用的行。
 * ⚠️ 规格原写法直接用 'u_admin' 写审计日志，但 audit_log.actor_id REFERENCES users(id)
 *    —— 不建被引用的行就会 FOREIGN KEY constraint failed。这是规格自带缺陷。
 *
 * ⚠️ 规格还用了 stageId: 'st1'，而 computation_snapshots.stage_id REFERENCES stages(id)，
 *    stages.edition_id 又 REFERENCES editions(id) —— 外键链三级，全建。
 *    PRAGMA foreign_keys = ON（src/db/sqlite.js），这条链缺一环就必然炸。
 */
function seedRefs(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000998','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z'),
           ('u_judge','评委','13900000997','x','mba',NULL,0,1,'2026-10-20T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('e1','2026 华东区','上海','2026-01-01T00:00:00.000Z','2026-12-31T00:00:00.000Z','2026-10-20T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
    VALUES ('st1','e1','s1','初赛','initial','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z','scoring.final','open');
    INSERT INTO teams (id, edition_id, name, captain_id, created_at)
    VALUES ('tm1','e1','一队','u_admin','2026-10-20T00:00:00.000Z'),
           ('tm2','e1','二队','u_admin','2026-10-20T00:00:00.000Z');
  `);
}

// 注入用的确定性引擎：让 diff 机制的断言不依赖 P2 的内部实现细节。
function stubEngine(input) {
  return {
    teams: input.submissions.map((s) => ({ teamId: s.teamId, total: s.rawScore, seatP: s.rawScore, seatE: 0 })),
    warnings: [],
    trace: { steps: [] },
  };
}

// 判别性引擎：**真的用 config 参与计算**。
// ⛔ stubEngine 完全不看 config —— 于是「用当前规则复算」与「用快照规则复算」算出来的
//    结果一模一样，测不出当前规则到底有没有真的参与复算。期望值恰好相同 ⇒ 测不出差别。
function configSensitiveEngine(input) {
  const weight = input.config?.dimensions?.[0]?.weight ?? 0;
  return {
    teams: input.submissions.map((s) => ({
      teamId: s.teamId, total: s.rawScore * weight, seatP: s.rawScore * weight, seatE: 0,
    })),
    warnings: [],
    trace: { steps: [] },
  };
}

const BASE_INPUT = {
  configKey: 'scoring.final',
  ruleVersion: 'scoring.final@2026-10-20',
  config: { version: '2026-10-20', dimensions: [{ key: 'innovation', weight: 0.2 }] },
  judges: [{ id: 'j1' }],
  submissions: [
    { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 90 },
  ],
  enterpriseConfirmations: [],
  peerReviews: [],
};

const VIEWER = { id: 'u_admin', is_superadmin: 1, active: 1 };

test('recordComputation 写入三件套并返回 id + revision', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id, revision } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace, now: '2026-10-20T00:00:00.000Z',
  });
  assert.ok(id);
  assert.equal(revision, 1);
  const got = getComputation({ db, id, viewer: VIEWER });
  assert.equal(got.ruleVersion, 'scoring.final@2026-10-20');
  assert.deepEqual(got.input.submissions, BASE_INPUT.submissions);
  assert.equal(got.output.teams[0].total, 80);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('缺少规则版本时 recordComputation 直接报错（缺版本 = 不可复算）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => recordComputation({ db, kind: 'stage_score', input: BASE_INPUT, output: {}, trace: {} }),
    /ruleVersion/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('getComputation 对无权访问者抛 404（单条不满足 → 404，不泄露存在性）', () => {
  const { db, close, dataDir } = setup();
  const { id } = recordComputation({
    db, kind: 'stage_score', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {},
  });
  const viewer = { id: 'u_judge', is_superadmin: 0, active: 1 };
  assert.throws(() => getComputation({ db, id, viewer }), (e) => e.status === 404);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('diffValues 能定位到具体 path（数组用 teamId 而不是下标）', () => {
  const before = { teams: [{ teamId: 't1', total: 80 }, { teamId: 't2', total: 90 }] };
  const after = { teams: [{ teamId: 't1', total: 81 }, { teamId: 't2', total: 90 }] };
  const diff = diffValues(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'teams[t1].total');
  assert.equal(diff[0].before, 80);
  assert.equal(diff[0].after, 81);
});

test('diffValues 对浮点噪声用 epsilon 忽略，对真实差异不放过', () => {
  assert.equal(diffValues({ x: 0.1 + 0.2 }, { x: 0.3 }).length, 0);
  assert.equal(diffValues({ x: 1 }, { x: 1.0001 }).length, 1);
});

test('复算一致时 identical=true 且 diff 为空', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  const r = recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', engine: stubEngine });
  assert.equal(r.identical, true);
  assert.deepEqual(r.diff, []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('快照被改动后复算必须报错出具体 diff，而不是静默通过', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  // 模拟"事后篡改"：把快照里的总分改掉
  db.prepare('UPDATE computation_snapshots SET output_json = ? WHERE id = ?')
    .run(JSON.stringify({ teams: [{ teamId: 't1', total: 999 }, { teamId: 't2', total: 90 }] }), id);

  const r = recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', engine: stubEngine });
  assert.equal(r.identical, false);
  const paths = r.diff.map((d) => d.path);
  assert.ok(paths.includes('teams[t1].total'), `diff 必须能定位到具体 path，实际：${JSON.stringify(paths)}`);
  assert.ok(r.warnings.some((w) => w.code === 'strict_replay_failed'), '必须显式说明"当时的计算已不可复算"');
  assert.ok(r.warnings.some((w) => w.code === 'output_mismatch'), '同一规则版本下不一致也必须显式告警');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('规则版本变更时不得静默当作 identical，必须在 warnings 里说明', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: BASE_INPUT, output, trace: output.trace,
  });
  // 当前规则版本已变（权重也变了）
  const rules = { scoring: { final: { version: '2026-10-21', dimensions: [{ key: 'innovation', weight: 0.3 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: stubEngine,
  });
  assert.equal(r.identical, false, '规则版本已变更时不能报 identical=true');
  const w = r.warnings.find((x) => x.code === 'rule_version_changed');
  assert.ok(w, 'warnings 必须显式说明规则版本已变更');
  assert.equal(w.snapshotRuleVersion, 'scoring.final@2026-10-20');
  assert.equal(w.currentRuleVersion, 'scoring.final@2026-10-21');
  assert.ok(r.diff.some((d) => d.path === 'ruleVersion'), '规则版本差异本身也必须出现在 diff 里');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('复算本身会写审计日志（复算不是一次性的查询，是一次留痕的动作）', () => {
  const { db, close, dataDir } = setup();
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {},
  });
  recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', engine: stubEngine });
  const { rows } = queryAuditLog(db, { action: 'computation.recompute' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAuditLog 无权访问时返回空集（列表不满足 → 200 + 空集）', () => {
  const { db, close, dataDir } = setup();
  writeAuditLogForTest(db);
  const r = listAuditLog({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAuditLog 有权时返回行，并带上 6 个月留档窗口', () => {
  const { db, close, dataDir } = setup();
  writeAuditLogForTest(db);
  const rules = { audit: { retention: { archiveMonths: 6 } } };
  const r = listAuditLog({ db, filter: {}, viewer: VIEWER, rules, now: '2026-10-20T00:00:00.000Z' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].action, 'x');
  assert.equal(r.retention.archiveMonths, 6);
  assert.equal(r.retention.queryableSince, '2026-04-20T00:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 父代理预审补测（变异检验暴露的三处「有效缺口」）────────────────────────
// ① 对象分支只取 before 的键 → after 新增的键会被静默吞掉
test('diffValues 能报出 after 里新增的键（否则新增的一条会被静默吞掉）', () => {
  const before = { teams: [{ teamId: 't1', total: 80 }] };
  const after = { teams: [{ teamId: 't1', total: 80 }], extra: 'added' };
  const diff = diffValues(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'extra');
  assert.equal(diff[0].before, null);
  assert.equal(diff[0].after, 'added');
});

// ② recordComputation 的 kind / input 校验没有任何用例 → 校验可被无声删掉
test('recordComputation 缺 kind / 缺 input 都必须报错（缺任何一件套 = 不可复算）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => recordComputation({ db, kind: '', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: {}, trace: {} }),
    /kind/,
  );
  assert.throws(
    () => recordComputation({ db, kind: 'stage_score', ruleVersion: BASE_INPUT.ruleVersion, output: {}, trace: {} }),
    /input/,
  );
  assert.throws(
    () => recordComputation({ db, kind: 'stage_score', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, trace: {} }),
    /output/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ③ 服务层没把 teamId 透传给 nextRevision → 同赛段不同队伍的 revision 互相污染
test('recordComputation 传 teamId 时 revision 按队伍各自编号（不同队伍互不干扰）', () => {
  const { db, close, dataDir } = setup();
  const a1 = recordComputation({ db, kind: 'stage_score', stageId: 'st1', teamId: 'tm1', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {} });
  const a2 = recordComputation({ db, kind: 'stage_score', stageId: 'st1', teamId: 'tm1', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {} });
  const b1 = recordComputation({ db, kind: 'stage_score', stageId: 'st1', teamId: 'tm2', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {} });
  assert.equal(a1.revision, 1);
  assert.equal(a2.revision, 2);
  assert.equal(b1.revision, 1, '不同队伍的 revision 必须各编各的');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑥ 两侧同为 null = 没有变化，不得产生假差异（否则会把"没变"误报成"被改过"）
test('diffValues 对两侧同为 null 的字段不产生假差异（null = 没有值，不是变化）', () => {
  assert.equal(diffValues({ x: null }, { x: null }).length, 0);
});

// ⑦ live 模式：用当前库里的数据重建输入（不传 liveInput 就只重放快照，两条路都得通）
test('复算可走 live 模式：用当前数据重建输入，差异必须显式报出', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  const liveInput = {
    ...BASE_INPUT,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 70 },
      { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 90 },
    ],
  };
  const r = recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', liveInput, engine: stubEngine });
  assert.equal(r.identical, false);
  assert.ok(
    r.diff.some((d) => d.path === 'teams[t1].total'),
    `live 模式必须报出当前数据算出的差异，实际：${JSON.stringify(r.diff.map((d) => d.path))}`,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑧ 当前规则必须真的参与复算（规则改了权重，复算出来的总分必须跟着变）
test('当前规则必须真的参与复算（权重变了总分必须跟着变，不能仍用快照里的旧规则）', () => {
  const { db, close, dataDir } = setup();
  const output = configSensitiveEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  const rules = { scoring: { final: { version: '2026-10-21', dimensions: [{ key: 'innovation', weight: 0.5 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: configSensitiveEngine,
  });
  assert.equal(r.identical, false, '权重变了却报 identical=true = 当前规则没参与复算');
  assert.ok(
    r.diff.some((d) => d.path === 'teams[t1].total'),
    `权重变了，总分必须跟着变，实际 diff：${JSON.stringify(r.diff.map((d) => d.path))}`,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑨ 没有留档规则时 retention 必须是 null（不凭空猜一个窗口出来）
test('没有留档规则时 retention 为 null（不凭空猜一个留档窗口出来）', () => {
  const { db, close, dataDir } = setup();
  const r = listAuditLog({ db, filter: {}, viewer: VIEWER, now: '2026-10-20T00:00:00.000Z' });
  assert.equal(r.retention, null);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑩ 记录计算时的审计日志必须带上规则版本（事后查得到当时用的是哪一版规则）
test('记录计算时审计日志必须带上规则版本（事后查得到当时用的是哪一版规则）', () => {
  const { db, close, dataDir } = setup();
  recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {},
  });
  const { rows } = queryAuditLog(db, { action: 'computation.record' });
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.ruleVersion, BASE_INPUT.ruleVersion, '审计日志里必须能查到当时的规则版本');
  assert.equal(detail.revision, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── ⑪ P2 实际写入的快照形状（父代理预审补测）────────────────────────────
// ⛔ 上面的 BASE_INPUT 是**手造的**形状：带 `configKey`、`ruleVersion` 带前缀、output 里带 trace。
//    与 P2 的 `compute.js` **实际写入的形状不一致** —— 用它测出来的「一致」是**假象**：
//    真实快照复算会恒判「不一致 + 规则版本已变更」，把正常快照全报成「被篡改」。
//    P2 实际写的 input（`src/services/compute.js`）：
//      { config, judges, submissions, excludedReviews, enterpriseConfirmations,
//        peerReviews, selfReviews, teams, judgePool, ruleVersion: config.version }
//    且 `output_json` **只存 { teams, warnings }**（trace 单独存 trace_json）。
const P2_INPUT = {
  config: { id: 'scoring-final', version: '2026-10-20', dimensions: [{ key: 'innovation', weight: 0.2 }] },
  judges: [{ judgeId: 'j1', seat: 'judge' }],
  submissions: [
    { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 90 },
  ],
  excludedReviews: [],
  enterpriseConfirmations: [],
  peerReviews: [],
  selfReviews: [{ teamId: 't1', dimension: 'self_eval', rawScore: 70 }],
  teams: [
    { teamId: 't1', packageEnterpriseId: null, isFreeBrief: false },
    { teamId: 't2', packageEnterpriseId: null, isFreeBrief: false },
  ],
  judgePool: { ok: true, errors: [], stats: {} },
  ruleVersion: '2026-10-20',
};

// P2 形状的引擎：**名册缺失会给出 team_roster_missing**（复刻 P2 `scoreStage` 的行为）——
// ⛔ 引擎不转发 teams ⇒ 复算与原计算结果不同 ⇒ 严格重放恒判失败。
// ⛔ 有自评输入才做自评差异检测（复刻 P2 的 R-JDG-13）—— 引擎不转发 selfReviews 同理。
function p2ShapeEngine(input) {
  const roster = input.teams?.length ? input.teams : null;
  const warnings = roster ? [] : [{ code: 'team_roster_missing', message: '没有队伍名册（R1 / R4 需要任务包归属与自由命题标记），相关判定按「不适用」处理' }];
  if ((input.selfReviews ?? []).length > 0) {
    warnings.push({ code: 'self_eval_divergence', message: '自评测与评委分存在差异，已留痕' });
  }
  const teams = (input.submissions ?? []).map((s) => ({ teamId: s.teamId, total: s.rawScore }));
  return { teams, warnings, trace: { steps: [] } };
}

test('P2 真实写入的快照形状必须能复算出「一致」（否则正常快照被误报成被篡改）', () => {
  const { db, close, dataDir } = setup();
  const output = p2ShapeEngine(P2_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: P2_INPUT.ruleVersion,
    input: P2_INPUT, output: { teams: output.teams, warnings: output.warnings }, trace: output.trace,
  });
  const rules = { scoring: { final: { id: 'scoring-final', version: '2026-10-20', dimensions: [{ key: 'innovation', weight: 0.2 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: p2ShapeEngine,
  });
  assert.equal(r.identical, true, `P2 形状的快照复算必须一致，实际 diff=${JSON.stringify(r.diff)}`);
  assert.deepEqual(r.diff, []);
  assert.ok(
    !r.warnings.some((w) => w.code === 'rule_version_changed'),
    '规则版本没变却报「规则版本已变更」= 误报',
  );
  assert.ok(
    !r.warnings.some((w) => w.code === 'strict_replay_failed'),
    '严格重放失败 = 误报（teams 没被转发就会这样）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('P2 形状的快照：当前规则版本真的变了时必须报出来（修复不能把版本比对一起吞掉）', () => {
  const { db, close, dataDir } = setup();
  const output = p2ShapeEngine(P2_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: P2_INPUT.ruleVersion,
    input: P2_INPUT, output: { teams: output.teams, warnings: output.warnings }, trace: output.trace,
  });
  const rules = { scoring: { final: { id: 'scoring-final', version: '2026-10-21', dimensions: [{ key: 'innovation', weight: 0.2 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: p2ShapeEngine,
  });
  assert.equal(r.identical, false, '规则版本变了却报 identical=true = 漏报');
  const w = r.warnings.find((x) => x.code === 'rule_version_changed');
  assert.ok(w, '规则版本变了必须在 warnings 里显式说明');
  assert.equal(w.snapshotRuleVersion, '2026-10-20');
  assert.equal(w.currentRuleVersion, '2026-10-21');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('diff 的数组 path 在业务主键重复时必须唯一（否则差异定位不到具体那一条）', () => {
  const before = { warnings: [{ teamId: 't1', code: 'a' }, { teamId: 't1', code: 'b' }] };
  const after = { warnings: [{ teamId: 't1', code: 'a' }, { teamId: 't1', code: 'c' }] };
  const diff = diffValues(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'warnings[1].code', '主键重复时必须回退到下标，否则两条共用一个 path');
  assert.equal(diff[0].before, 'b');
  assert.equal(diff[0].after, 'c');
});

test('同一个版本的两种写法（裸 version 与 key@version）必须判为「同一版」', () => {
  // 快照写的是带前缀的 ruleVersion、但没有 configKey —— 这是「按契约写的新快照」的形状。
  // 库里同时存在两种写法（P2 实际写的是裸 version）⇒ 比较必须两边都认。
  const { db, close, dataDir } = setup();
  const input = { ...P2_INPUT, ruleVersion: 'scoring.final@2026-10-20' };
  const output = p2ShapeEngine(input);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input, output: { teams: output.teams, warnings: output.warnings }, trace: output.trace,
  });
  const rules = { scoring: { final: { id: 'scoring-final', version: '2026-10-20', dimensions: [{ key: 'innovation', weight: 0.2 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: p2ShapeEngine,
  });
  assert.ok(
    !r.warnings.some((w) => w.code === 'rule_version_changed'),
    '同一个版本的两种写法不该报「规则版本已变更」',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

function writeAuditLogForTest(db) {
  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run('a1', 'u_admin', 'x', 'stage_result', 'st1', null, '2026-10-01T00:00:00.000Z');
}

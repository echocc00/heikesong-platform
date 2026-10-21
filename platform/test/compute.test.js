// platform/test/compute.test.js —— computeStage 计算快照 + 评审路由
//
// 规则溯源：
//   - 「compute 是显式动作，产出 input+output+trace 三件套」→ 设计文档 §8【决策】+ §12
//   - 「rank / points 留给 P3」→ 设计文档 §6.2 + INTERFACES.md §3
//   - 「回避的评委不打分不计入」→ S7 §2.4 R5（R-JDG-09）
//   - 「企业确认进总分」→ S7 §4.1（R-JDG-05/06）
//
// ⚠️ 夹具纪律：迁移 003 补齐了 38 条引用型外键，**所有 id 必须是真实行**
//    （不能再用 'ed1' / 't1' 这类假 id —— 那样夹具会掩盖孤儿行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertEnterpriseConfirmation } from '../src/db/repo/enterprise-confirmations.js';
import { insertPeerReview } from '../src/db/repo/peer-reviews.js';
import { insertRecusal } from '../src/db/repo/recusals.js';
import { loadRules } from '../src/config.js';
import { computeStage, getComputation } from '../src/services/compute.js';
import { createRouter } from '../src/http/router.js';
import { registerReviewRoutes } from '../src/http/routes/review.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-cmp-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000031', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000035', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000032', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900000033', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000034', password: 'pw' });

  const pkg = createTaskPackage(db, {
    editionId: edition.id,
    enterpriseId: enterprise.id,
    enterpriseName: '某某企业',
    title: '库存周转',
    painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型',
    acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id,
    now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  // ⚠️ 必须走 assignStageJudge：它会**同时**写利益冲突声明并回填 stage_judges
  //    （R-JDG-18；直插 stage_judges 会绕过这条接线，测试就再也拦不住它坏掉）。
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  return { db, close, dataDir, rules, judge, judge2, admin, enterprise, captain, team1, team2, stage };
}

test('computeStage 写快照三件套 + stage_results', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  assert.ok(res.computationId);
  assert.ok(Array.isArray(res.teams));

  const snap = db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(res.computationId);
  assert.ok(snap.input_json, '必须有 input');
  assert.ok(snap.output_json, '必须有 output');
  assert.ok(snap.trace_json, '必须有 trace');
  assert.equal(snap.revision, 1);
  const trace = JSON.parse(snap.trace_json);
  assert.ok(trace.normalization);
  assert.ok(trace.weights);

  const row = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id);
  assert.equal(row.computation_id, res.computationId);
  assert.equal(row.rank, null, '名次由 P3 填');
  assert.equal(row.points, null, '积分由 P3 填');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重算后 stage_results 必须指向最新一次计算', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  const a = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const b = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const row = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id);
  assert.equal(row.computation_id, b.computationId, '结果行必须跟着最新一次计算走');
  assert.notEqual(row.computation_id, a.computationId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复 compute → revision 递增（可复算的历史留档）', () => {
  const { db, close, dataDir, rules, admin, stage } = setup();
  const a = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const b = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const revs = db.prepare('SELECT revision FROM computation_snapshots ORDER BY revision').all().map((r) => r.revision);
  assert.deepEqual(revs, [1, 2]);
  assert.notEqual(a.computationId, b.computationId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('compute 必须写审计日志（action=stage.compute）', () => {
  const { db, close, dataDir, rules, admin, stage } = setup();
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const row = db.prepare('SELECT * FROM audit_log WHERE action = ? AND entity_id = ?').get('stage.compute', stage.id);
  assert.ok(row, '计算是显式动作，必须留下操作者与时间戳');
  assert.equal(row.actor_id, admin.id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('compute 路由已注册且计算快照可读', () => {
  const { db, close, dataDir } = setup();
  const router = createRouter();
  registerReviewRoutes(router);
  const paths = router.list().map((r) => `${r.method} ${r.pattern}`);
  for (const p of [
    'POST /api/stages/:stageId/reviews',
    'GET /api/stages/:stageId/review-state',
    'POST /api/stages/:stageId/calibration',
    'POST /api/stages/:stageId/peer-reviews',
    'POST /api/stages/:stageId/self-review',
    'POST /api/stages/:stageId/compute',
    'GET /api/stages/:stageId/computations/:computationId',
    'POST /api/stages/:stageId/recusals',
    'POST /api/stages/:stageId/enterprise-confirmations',
  ]) {
    assert.ok(paths.includes(p), `缺路由 ${p}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 企业确认必须真的进总分（仓储 snake_case → 领域 camelCase 映射）', () => {
  const { db, close, dataDir, rules, admin, judge, judge2, enterprise, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertEnterpriseConfirmation(db, {
    stageId: stage.id, teamId: team1.id, enterpriseId: enterprise.id, dimension: 'enterprise',
    rawScore: 90, crossJudgeId: judge2.id, signatoryUserId: enterprise.id, content: '解决库存周转环节', now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const t1 = res.teams.find((t) => t.teamId === team1.id);
  assert.equal(t1.seatE, 90, '企业确认分必须进入企业席');
  assert.ok(!res.warnings.some((w) => w.code === 'no_enterprise_confirmation' && w.teamId === team1.id),
    '有有效企业确认却报「没有企业确认」说明映射断了');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 没有任何评分的队伍不写 stage_results（不参与排名）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, team2, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  assert.ok(db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id));
  assert.equal(
    db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team2.id),
    undefined,
    '没被任何评委打分的队不该有结果行（否则会以 0 分被排进榜单）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 回避的评委其打分不计入本次计算', () => {
  const { db, close, dataDir, rules, admin, judge, judge2, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertReview(db, {
    stageId: stage.id, judgeId: judge2.id, teamId: team1.id, dimension: 'innovation', rawScore: 20, now: NOW,
  });
  insertRecusal(db, {
    stageId: stage.id, judgeId: judge2.id, teamId: team1.id, reason: '投资方', source: 'declared', action: 'recused', now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const t1 = res.teams.find((t) => t.teamId === team1.id);
  assert.ok(Math.abs(t1.seatP - 80) < 1e-6, `seatP=${t1.seatP}（回避后只剩评委甲的 80 分）`);
  assert.ok(res.warnings.some((w) => w.code === 'recusal_excluded'));
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 计算快照不得跨赛段读取（D-26）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  // 本赛段读得到
  const ok = getComputation({ db, id: res.computationId, stageId: stage.id });
  assert.equal(ok.id, res.computationId);

  // 换一个赛段读 → 404（不是「找到但不给看」）
  assert.throws(
    () => getComputation({ db, id: res.computationId, stageId: 'other-stage' }),
    (err) => err.status === 404 && err.code === 'COMPUTATION_NOT_FOUND',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 互评分必须进 trace.perTeam.peerScore（破同分链的输入）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, team2, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertPeerReview(db, {
    stageId: stage.id, fromTeamId: team2.id, toTeamId: team1.id, score: 70, now: NOW,
  });

  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  assert.equal(res.trace.perTeam[team1.id].peerScore, 70, '互评分必须落在被评队的 trace 上');
  assert.equal(res.trace.perTeam[team2.id].peerScore, null, '发起方不因此拿到互评分');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 快照的 input 必须含原始打分（可复算的载体）', () => {
  const { db, close, dataDir, rules, admin, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  const res = computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });
  const snap = db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(res.computationId);
  const input = JSON.parse(snap.input_json);
  assert.equal(input.submissions.length, 1, 'input 必须带原始打分，否则无法从快照重放');
  assert.equal(input.submissions[0].rawScore, 80);
  assert.ok(input.config, 'input 必须带生效的权重表');
  assert.ok(input.ruleVersion);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ compute 中途失败 → 整体回滚（不留半成品快照与结果行）', () => {
  const { db, close, dataDir, rules, judge, team1, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  // actor_id 有外键 → 用一个不存在的用户当操作者，让审计写入失败
  assert.throws(
    () => computeStage({ db, stageId: stage.id, actorId: '不存在的用户', now: NOW, rules }),
    (err) => /FOREIGN KEY/i.test(String(err.message)),
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM computation_snapshots WHERE stage_id = ?').get(stage.id).n,
    0,
    '失败的事务不能留下快照',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM stage_results WHERE stage_id = ?').get(stage.id).n,
    0,
    '失败的事务不能留下结果行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computeStage 对不存在的赛段 → 404', () => {
  const { db, close, dataDir, rules, admin } = setup();
  assert.throws(
    () => computeStage({ db, stageId: 'nope', actorId: admin.id, now: NOW, rules }),
    (err) => err.status === 404 && err.code === 'STAGE_NOT_FOUND',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computeStage 缺规则 → 500（绝不用默认值凑一个榜单）', () => {
  const { db, close, dataDir, admin, stage } = setup();
  assert.throws(
    () => computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules: {} }),
    (err) => err.status === 500 && err.code === 'RULES_MISSING',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('⛔ 重算必须清空旧名次/积分，并删掉本轮已无评分的旧结果行', () => {
  const { db, close, dataDir, rules, admin, judge, team1, team2, stage } = setup();
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: 'innovation', rawScore: 80, now: NOW,
  });
  insertReview(db, {
    stageId: stage.id, judgeId: judge.id, teamId: team2.id, dimension: 'innovation', rawScore: 60, now: NOW,
  });
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  // 模拟 P3 已经发过榜（名次 / 积分已填）
  db.prepare('UPDATE stage_results SET rank = 1, tied_with = 2, points = 99 WHERE stage_id = ?').run(stage.id);

  // 把二队的打分撤掉 → 重算
  // 软删除（评分只增不改，删除用软删除）—— 软删掉的分不得再计入计算
  db.prepare('UPDATE stage_reviews SET deleted_at = ? WHERE stage_id = ? AND team_id = ?').run(NOW, stage.id, team2.id);
  computeStage({ db, stageId: stage.id, actorId: admin.id, now: NOW, rules });

  const row1 = db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team1.id);
  assert.equal(row1.rank, null, '重算后名次必须回到 NULL（由 P3 重新填）');
  assert.equal(row1.points, null, '重算后积分必须回到 NULL');
  assert.equal(row1.tied_with, null);
  assert.equal(
    db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stage.id, team2.id),
    undefined,
    '本轮已无评分的队伍必须从结果表里消失（否则会以旧总分留在榜单上）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

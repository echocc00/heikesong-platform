// platform/test/recompute-e2e.test.js —— P4 Task 8：端到端复算验收
//
// 覆盖全链路：打分 → 计算 → 快照 → 改一个原始分 → 复算 → diff 非空。
//
// ⛔ **关键**：本测试用 **P2 真实的 computeStage** 产出快照，**不是手造 input**。
//    父代理预审修正轮（P4-9）的教训：手造的 input 形状与 P2 实际写入的形状不一致
//    ⇒ 测出来的「一致」是假象 —— 修前用 P2 真实快照复算，`identical` 恒为 `false`，
//    一切正常快照都被误报成「被篡改」。
//
// 跨阶段契约（与 INTERFACES.md §3 一致）：
//   computeStage({ db, stageId, actorId, now, rules }) → { computationId, revision, teams, warnings, trace }
//   scoreStage({ config, judges, submissions, enterpriseConfirmations, peerReviews, teams, selfReviews })
//     → { teams: [{ teamId, seatP, seatE, total, perDimension }], warnings, trace }
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { computeStage } from '../src/services/compute.js';
import { recordComputation, recomputeAndDiff } from '../src/services/audit.js';
import { getSnapshot } from '../src/db/repo/computations.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  return { db, close, dataDir, rules };
}

// 10 席 = 5 企业 + 5 专家：满足 rules/scoring-final.json 的 judgePool 段
// （voting ≥ 9、企业席 ≥ 30%、专家席 ≤ 50%）⇒ 评委池**合规** ⇒ computeStage 不会追加
// `judge_pool_invalid`（那是**计算期**告警，引擎重放时复现不了 —— 见「已知限制」那条用例）。
const JUDGES = [
  { id: 'j1', seat: 'judge' }, { id: 'j2', seat: 'judge' }, { id: 'j3', seat: 'judge' },
  { id: 'j4', seat: 'judge' }, { id: 'j5', seat: 'judge' },
  { id: 'e1', seat: 'enterprise' }, { id: 'e2', seat: 'enterprise' }, { id: 'e3', seat: 'enterprise' },
  { id: 'e4', seat: 'enterprise' }, { id: 'e5', seat: 'enterprise' },
];
const TEAMS = ['t1', 't2', 't3'];
const DIMENSION = 'innovation';

function seedStage(db) {
  db.exec(`
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('e1','2026 华东区','上海','2026-01-01T00:00:00.000Z','2026-12-31T00:00:00.000Z','2026-10-20T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
    VALUES ('st1','e1','s1','决赛','final','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z','final','open');
  `);
  const user = db.prepare(
    'INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  user.run('u_admin', '组委会', '13900000998', 'x', 'mba', null, 1, 1, '2026-10-20T00:00:00.000Z');
  // ⚠️ 手机号必须**唯一**（users.phone UNIQUE）：用序号生成，别用 id 的字符（'j1' 与 'e1' 会撞）。
  let phoneSeq = 0;
  for (const j of JUDGES) {
    phoneSeq += 1;
    user.run(
      j.id, `评委${j.id}`, `1390000${String(phoneSeq).padStart(4, '0')}`,
      'x', 'mba', null, 0, 1, '2026-10-20T00:00:00.000Z',
    );
  }
  const seat = db.prepare(
    'INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at) VALUES (?,?,?,?,?,?)',
  );
  for (const j of JUDGES) {
    seat.run('st1', j.id, j.seat, 'global', null, '2026-10-20T00:00:00.000Z');
  }
  const team = db.prepare(
    'INSERT INTO teams (id, edition_id, name, captain_id, created_at) VALUES (?,?,?,?,?)',
  );
  for (const t of TEAMS) {
    team.run(t, 'e1', `${t} 队`, 'u_admin', '2026-10-20T00:00:00.000Z');
  }
  const review = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at, request_id, calibrated, deleted_at)
     VALUES (?, 'st1', ?, ?, ?, ?, '2026-10-20T00:00:00.000Z', ?, 0, NULL)`,
  );
  let n = 0;
  for (const j of JUDGES) {
    for (const t of TEAMS) {
      n += 1;
      review.run(`sr_${n}`, j.id, t, DIMENSION, 60 + (n % 30), `req_${n}`);
    }
  }
}

// 「live 模式」的输入：用**当前库里的数据**重建快照自带的 input（只换 submissions）。
// ⛔ 保留快照自带的 teams / judges / config —— 它们不是「当前数据」，是「当次发榜的上下文」。
function buildLiveInput(db, snapshotInput) {
  const rows = db.prepare(
    "SELECT judge_id, team_id, dimension, raw_score FROM stage_reviews WHERE stage_id = 'st1' AND deleted_at IS NULL AND calibrated = 0",
  ).all();
  return {
    ...snapshotInput,
    submissions: rows.map((r) => ({
      judgeId: r.judge_id, teamId: r.team_id, dimension: r.dimension, rawScore: r.raw_score,
    })),
  };
}

test('端到端：打分 → 计算 → 快照 → 复算一致 → 改一个原始分 → 复算 diff 非空', () => {
  const { db, close, dataDir, rules } = setup();
  seedStage(db);

  // ① 真实计算 → 写快照（**P2 的 computeStage 是唯一写快照的路径**）
  const computed = computeStage({
    db, stageId: 'st1', actorId: 'u_admin', now: '2026-10-20T00:00:00.000Z', rules,
  });
  assert.ok(Array.isArray(computed.teams), 'computeStage 必须返回 teams 数组');
  assert.ok(computed.teams.length > 0, 'computeStage 必须给出队伍分数');
  assert.ok(computed.teams.every((t) => t.teamId !== undefined), '每队必须有 teamId（diff 的 path 靠它定位）');
  assert.equal(computed.revision, 1, '第一次计算的 revision 必须是 1');
  assert.ok(computed.computationId, '必须返回快照 id');

  // ② 改数据之前：复算必须一致
  //    ⛔ 这一条在父代理预审修正轮（P4-9）之前是**红的**：用 P2 真实快照复算恒判不一致。
  const before = recomputeAndDiff({
    db, id: computed.computationId, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules,
  });
  assert.equal(
    before.identical, true,
    `改数据之前复算必须一致，warnings=${JSON.stringify(before.warnings)}`,
  );
  assert.deepEqual(before.diff, [], '一致时 diff 必须是空集');
  assert.ok(
    !before.warnings.some((w) => w.code === 'rule_version_changed'),
    '规则版本没变却报「规则版本已变更」= 误报',
  );
  assert.ok(
    !before.warnings.some((w) => w.code === 'strict_replay_failed'),
    '严格重放失败 = 误报（说明 runEngine 没把 teams/selfReviews 转发给引擎）',
  );

  // ③ 改一个原始分（模拟原始数据被改动）
  db.prepare(
    "UPDATE stage_reviews SET raw_score = raw_score + 10 WHERE stage_id = 'st1' AND team_id = 't1' AND judge_id = 'j1' AND dimension = ?",
  ).run(DIMENSION);

  // ④ 用当前库里的数据重建输入（live 模式）再复算
  const snapshotInput = JSON.parse(getSnapshot(db, computed.computationId).input_json);
  const liveInput = buildLiveInput(db, snapshotInput);
  const after = recomputeAndDiff({
    db, id: computed.computationId, actorId: 'u_admin', now: '2026-10-20T02:00:00.000Z', rules, liveInput,
  });
  assert.equal(after.identical, false, '原始分被改后复算必须不一致');
  assert.ok(after.diff.length > 0, 'diff 不能为空');
  const paths = after.diff.map((d) => d.path);
  assert.ok(
    paths.some((p) => p.includes('t1')),
    `diff 必须定位到被改的队伍，实际：${JSON.stringify(paths)}`,
  );
  assert.ok(
    after.warnings.some((w) => w.code === 'output_mismatch'),
    '同一规则版本下复算不一致必须显式告警 output_mismatch',
  );

  // ⑤ 旧 revision 保留（重算走 revision + 1，不覆盖历史）
  const { id: id2, revision: revision2 } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: '2026-10-20',
    input: liveInput, output: { teams: computed.teams, warnings: computed.warnings }, trace: computed.trace,
    now: '2026-10-20T03:00:00.000Z',
  });
  assert.equal(revision2, 2, '第二次计算的 revision 必须是 2');
  assert.notEqual(id2, computed.computationId, '新快照必须有新 id');
  assert.equal(
    getSnapshot(db, computed.computationId).revision, 1,
    '旧 revision 必须保留供复盘（重算不覆盖历史）',
  );

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('【已知限制】评委池不合规时：分数本身仍可复算，但计算期告警复现不了 → 差异必须显式可见', () => {
  // ⛔ 已知限制（P2 侧）：`computeStage` 把 `judge_pool_invalid` 这类**计算期**告警
  //    追加进 `output.warnings`，而**引擎重放**（scoreStage）复现不了它
  //    ⇒ 复算会报出一条 warnings 差异（**假告警**）。
  //    治本要改 P2 的 `src/services/compute.js`（把这些告警放进 trace / input 而不是 output）——
  //    **该文件归 P2**，P4 不越界改，只在此**显式登记**并断言「它至少是可见的，不是静默通过」。
  const { db, close, dataDir, rules } = setup();
  seedStage(db);
  // 抽掉 4 个评委 ⇒ 评委池不合规（voting 6 < 9）
  db.prepare("DELETE FROM stage_judges WHERE stage_id = 'st1' AND user_id IN ('e4','e5','j4','j5')").run();
  db.prepare("DELETE FROM stage_reviews WHERE stage_id = 'st1' AND judge_id IN ('e4','e5','j4','j5')").run();

  const computed = computeStage({
    db, stageId: 'st1', actorId: 'u_admin', now: '2026-10-20T00:00:00.000Z', rules,
  });
  const r = recomputeAndDiff({
    db, id: computed.computationId, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules,
  });
  // 分数本身必须仍然一致（teams 没被改动）
  const teamPaths = r.diff.filter((d) => d.path.startsWith('teams[')).map((d) => d.path);
  assert.deepEqual(teamPaths, [], `分数本身不该有差异，实际：${JSON.stringify(teamPaths)}`);
  // 差异必须**显式可见**（不能静默当作一致）
  assert.equal(r.identical, false, '计算期告警复现不了 ⇒ 必须报出差异，不能静默通过');
  assert.ok(r.diff.length > 0, '差异必须出现在 diff 里');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

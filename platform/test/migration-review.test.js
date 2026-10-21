// platform/test/migration-review.test.js —— 评审数据模型（003_review.sql）
//
// 依据：P2 计划 Task 1「评审数据模型与迁移 003_review.sql」
// 溯源需求：R-JDG-09 / R-JDG-11 / R-JDG-13 / R-JDG-14 / R-JDG-18 / R-JDG-19 / R-RNK-07
//
// ⚠️ **夹具必须建真实的用户 / 届期 / 战队**（父代理预审修正，Important）：
//    003_review.sql 补齐了引用型外键（edition_id → editions、judge_id → users、
//    team_id → teams）。原规格的夹具用假 id（'j1' / 't1' / 'ed1'）——
//    那**只**在「没有外键」时成立，而且正好**掩盖**了「评审数据可以指向不存在的
//    评委/队伍」这个问题。P1 的迁移测试（migration-002.test.js）就是建真实数据的，
//    这里与它对齐。
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
import { insertTeam } from '../src/db/repo/teams.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const NOW = '2026-10-20T00:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  // 真实届期 / 用户 / 战队 —— 外键要指向真实存在的行
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900002001', password: 'pw' });
  const captain = createUser(db, {
    name: '队长甲', phone: '13900002002', password: 'pw', mbaStatus: 'mba',
  });
  const team = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, status: 'forming', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain.id, status: 'forming', now: NOW,
  });
  // 赛段（stage_id 有外键，先建一个赛段）
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES ('s1', ?, 's1', '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  ).run(edition.id);
  return { db, close, dataDir, edition, judge, captain, team, team2 };
}

const TABLES = [
  'stages', 'stage_judges', 'conflict_declarations', 'stage_reviews', 'review_request_keys',
  'calibrations', 'enterprise_confirmations', 'peer_reviews', 'self_reviews', 'score_stats',
  'recusal_records', 'computation_snapshots', 'stage_results', 'tiebreak_round', 'tiebreak_votes',
];

test('003 迁移建出全部评审表', () => {
  const { db, close, dataDir } = setup();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), `缺表 ${t}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('stage_reviews 唯一约束防重复灌分', () => {
  const { db, close, dataDir, judge, team } = setup();
  const ins = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', ?, ?, 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1', judge.id, team.id);
  assert.throws(() => ins.run('r2', judge.id, team.id), /UNIQUE|constraint/i, '同一 (赛段,评委,队伍,维度) 只能有一条');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('peer_reviews 唯一约束：一队对另一队只投一次', () => {
  const { db, close, dataDir, team, team2 } = setup();
  const ins = db.prepare(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
     VALUES (?, 's1', ?, ?, 70, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('p1', team.id, team2.id);
  assert.throws(() => ins.run('p2', team.id, team2.id), /UNIQUE|constraint/i);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('score_stats 主键是 (judge_id, dimension)', () => {
  const { db, close, dataDir, judge } = setup();
  const ins = db.prepare(
    `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
     VALUES (?, ?, 1, 80, 6400, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run(judge.id, 'innovation');
  assert.throws(() => ins.run(judge.id, 'innovation'), /UNIQUE|constraint/i);
  ins.run(judge.id, 'feasibility'); // 不同维度可以并存
  // 统计行必须挂在真实评委上
  assert.throws(
    () => db.prepare(
      `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
       VALUES ('no-such-judge', 'innovation', 1, 80, 6400, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'score_stats.judge_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('tiebreak_votes 主键保证一人一队一票（并发下插不出两票）', () => {
  const { db, close, dataDir, judge, team, team2 } = setup();
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '["t1","t2"]', '2026-10-20T00:10:00.000Z', ?, '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  const ins = db.prepare(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', ?, ?, 80, '2026-10-20T00:05:00.000Z')`,
  );
  ins.run(judge.id, team.id);
  // ⚠️ 准确语义是「一人**一队**一票」：同一人对**不同**队伍各投一次是允许的
  //    （破同分时每位评委都要给每支并列队打分）。
  //    若主键退化成 (轮次,投票人)，这条会被数据库拒掉 —— 所以它必须能插进去。
  ins.run(judge.id, team2.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tiebreak_votes').get().n,
    2,
    '同一人对两支队伍各投一票，共两行',
  );
  // 同一 (轮次,投票人,队伍) 第二次投票 → 被数据库拒绝（并发下插不出两票）
  assert.throws(() => ins.run(judge.id, team.id), /UNIQUE|constraint/i, '同一 (轮次,投票人,队伍) 只能投一次');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等键表：同一 (scope,赛段,主体,request_id) 只能领一次', () => {
  const { db, close, dataDir, judge } = setup();
  const ins = db.prepare(
    `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
     VALUES ('review', 's1', ?, ?, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run(judge.id, 'req-1');
  assert.throws(() => ins.run(judge.id, 'req-1'), /UNIQUE|constraint/i);
  // ⚠️ **不同的** request_id 必须能并存 —— 否则第二次请求会被误判成重复请求而丢数据。
  //    幂等键的语义是「同一个 request_id 只能生效一次」，不是「这个主体只能来一次」。
  ins.run(judge.id, 'req-2');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM review_request_keys').get().n,
    2,
    '同一主体的两个不同 request_id 应各占一行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('同一届期下赛段代号唯一（不能有两个初赛）', () => {
  const { db, close, dataDir, edition } = setup();
  const ins = db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
     VALUES (?, ?, ?, '初赛', 'initial', '2026-10-01', '2026-10-10', 'initial', 'open')`,
  );
  // setup 里已有一个 key='s1' 的赛段 → 再插一个同代号必须被拒
  assert.throws(() => ins.run('s2', edition.id, 's1'), /UNIQUE|constraint/i, '同一届期下赛段代号不能重复');
  // 不同代号可以并存
  ins.run('s3', edition.id, 's2');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('stage_results 的 rank / points 在 P2 阶段可空（名次由 P3 填）', () => {
  const { db, close, dataDir } = setup();
  const info = db.prepare('PRAGMA table_info(stage_results)').all();
  const rank = info.find((c) => c.name === 'rank');
  const points = info.find((c) => c.name === 'points');
  assert.equal(rank.notnull, 0);
  assert.equal(points.notnull, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 外键（父代理预审修正，Important）──────────────────────────────────────
// ⚠️ 原规格只给一部分列加了外键（stage_judges.user_id 有、stage_reviews.judge_id 没有），
//    同一类引用一处有一处没有 —— 评审数据可以指向**不存在的评委/队伍**，
//    聚合时不会被发现；而假 id 夹具正好掩盖了这一点。
//    P1 的 002_registration.sql 里 editions/teams/cities/task_packages/registrations
//    的 edition_id **全都有**外键 —— 这里与它对齐。
test('外键：赛段必须挂在真实届期上（不存在的届期插不进去）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => db.prepare(
      `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
       VALUES ('s2', 'no-such-edition', 's2', '决赛', 'final', '2026-10-26', '2026-10-28', 'final', 'open')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stages.edition_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：评分必须挂在真实的评委与队伍上（孤儿评分插不进去）', () => {
  const { db, close, dataDir, team } = setup();
  // 评委不存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('r9', 's1', 'no-such-judge', ?, 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'stage_reviews.judge_id 必须有外键',
  );
  // 队伍不存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('r10', 's1', (SELECT id FROM users WHERE name = '评委甲'), 'no-such-team', 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stage_reviews.team_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：互评 / 自评 / 结果表也不能指向不存在的队伍', () => {
  const { db, close, dataDir, judge, team } = setup();
  assert.throws(
    () => db.prepare(
      `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
       VALUES ('p9', 's1', ?, 'no-such-team', 70, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'peer_reviews.to_team_id 必须有外键',
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('sr9', 's1', 'no-such-team', 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'self_reviews.team_id 必须有外键',
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, created_at)
       VALUES ('sr9', 's1', 'no-such-team', 80, 60, 20, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stage_results.team_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：评委席必须挂在真实评委上，声明必须指向真实声明', () => {
  const { db, close, dataDir, judge } = setup();
  const judge2 = createUser(db, { name: '评委乙', phone: '13900002003', password: 'pw' });
  // 正常插入：评委席挂在真实评委上
  db.prepare(
    `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at)
     VALUES ('s1', ?, 'judge', 'global', NULL, '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  // 评委不存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at)
       VALUES ('s1', 'no-such-judge', 'judge', 'global', NULL, '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
    'stage_judges.user_id 必须有外键',
  );
  // 声明不存在（用另一个评委 —— 否则会先撞上主键 (stage_id, user_id)）
  assert.throws(
    () => db.prepare(
      `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at, conflict_declaration_id)
       VALUES ('s1', ?, 'judge', 'global', NULL, '2026-10-20T00:00:00.000Z', 'no-such-declaration')`,
    ).run(judge2.id),
    /FOREIGN KEY constraint failed/i,
    'stage_judges.conflict_declaration_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('利益冲突声明表存在（R-JDG-18：评委须签署声明）', () => {
  // ⚠️ 这张表在原规格的**测试表清单里是漏的** —— 建表漏了测试也不报。
  const { db, close, dataDir, edition, judge } = setup();
  const info = db.prepare('PRAGMA table_info(conflict_declarations)').all().map((c) => c.name);
  for (const col of ['id', 'stage_id', 'judge_id', 'declared_at', 'has_conflict', 'statement', 'signed_at']) {
    assert.ok(info.includes(col), `conflict_declarations 缺列 ${col}`);
  }
  // 声明可落库，且指向真实赛段与真实评委
  db.prepare(
    `INSERT INTO conflict_declarations (id, stage_id, judge_id, declared_at, has_conflict, statement, signed_at)
     VALUES ('cd1', 's1', ?, '2026-10-20T00:00:00.000Z', 0, '本人与参赛企业无利益关系', '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conflict_declarations').get().n, 1);
  // 评委必须存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO conflict_declarations (id, stage_id, judge_id, declared_at, has_conflict, statement, signed_at)
       VALUES ('cd2', 's1', 'no-such-judge', '2026-10-20T00:00:00.000Z', 0, 'x', '2026-10-20T00:00:00.000Z')`,
    ).run(),
    /FOREIGN KEY constraint failed/i,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('企业确认：同格只能有一条有效记录，软删后可重签（R2 双签 / R-JDG-14）', () => {
  const { db, close, dataDir, judge, team } = setup();
  const ins = db.prepare(
    `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, content, created_at)
     VALUES (?, 's1', ?, ?, 'delivery', 85, '由我方提供落地资源', '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('e1', team.id, judge.id);
  // 同 (赛段,队伍,维度,企业) 只能有一条有效记录
  assert.throws(
    () => ins.run('e2', team.id, judge.id),
    /UNIQUE|constraint/i,
    '同格重复确认必须被数据库拒绝',
  );
  // 软删之后同格可重签 —— 这是**偏序**唯一索引（WHERE deleted_at IS NULL）的语义
  db.prepare(`UPDATE enterprise_confirmations SET deleted_at = '2026-10-21T00:00:00.000Z' WHERE id = 'e1'`).run();
  ins.run('e3', team.id, judge.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE deleted_at IS NULL').get().n,
    1,
    '软删后同格只有一条有效记录',
  );
  // 引用型外键：队伍 / 企业必须真实存在
  assert.throws(
    () => db.prepare(
      `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, created_at)
       VALUES ('e4', 's1', 'no-such-team', ?, 'delivery', 85, '2026-10-20T00:00:00.000Z')`,
    ).run(judge.id),
    /FOREIGN KEY constraint failed/i,
    'enterprise_confirmations.team_id 必须有外键',
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, created_at)
       VALUES ('e5', 's1', ?, 'no-such-enterprise', 'delivery', 85, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'enterprise_confirmations.enterprise_id 必须有外键',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('自评 / 结果：同格唯一，且都挂在真实赛段与队伍上', () => {
  const { db, close, dataDir, team } = setup();
  // 自评：同一 (赛段,队伍,维度) 只能一条
  const selfIns = db.prepare(
    `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', ?, 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
  );
  selfIns.run('sr1', team.id);
  assert.throws(() => selfIns.run('sr2', team.id), /UNIQUE|constraint/i, '同一 (赛段,队伍,维度) 自评只能一条');
  // 自评的赛段也必须真实
  assert.throws(
    () => db.prepare(
      `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at)
       VALUES ('sr3', 'no-such-stage', ?, 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
    ).run(team.id),
    /FOREIGN KEY constraint failed/i,
    'self_reviews.stage_id 必须有外键',
  );
  // 赛段结果：同一 (赛段,队伍) 只能一条
  const resIns = db.prepare(
    `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, created_at)
     VALUES (?, 's1', ?, 80, 60, 20, '2026-10-20T00:00:00.000Z')`,
  );
  resIns.run('st1', team.id);
  assert.throws(() => resIns.run('st2', team.id), /UNIQUE|constraint/i, '同一 (赛段,队伍) 结果只能一条');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：计算快照的赛段 / 队伍，以及加时投票的投票人 / 队伍', () => {
  const { db, close, dataDir, judge, team } = setup();
  const fkFail = (sql, ...params) => assert.throws(
    () => db.prepare(sql).run(...params),
    /FOREIGN KEY constraint failed/i,
  );
  // 计算快照（可复算的载体）：赛段与队伍都要真实
  fkFail(
    `INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, created_at)
     VALUES ('cs1', 'stage_score', (SELECT id FROM editions LIMIT 1), 'no-such-stage', ?, 'v1', '{}', '{}', '{}', '2026-10-20T00:00:00.000Z')`,
    team.id,
  );
  fkFail(
    `INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, created_at)
     VALUES ('cs2', 'stage_score', (SELECT id FROM editions LIMIT 1), 's1', 'no-such-team', 'v1', '{}', '{}', '{}', '2026-10-20T00:00:00.000Z')`,
  );
  // 加时投票：投票人与队伍都要真实
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '[]', '2026-10-20T00:10:00.000Z', ?, '2026-10-20T00:00:00.000Z')`,
  ).run(judge.id);
  fkFail(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', 'no-such-voter', ?, 80, '2026-10-20T00:05:00.000Z')`,
    team.id,
  );
  fkFail(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES ('tr1', ?, 'no-such-team', 80, '2026-10-20T00:05:00.000Z')`,
    judge.id,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('登记口径：stage_reviews 的 UNIQUE 是【非偏序】—— 软删不会腾出格子', () => {
  // ⚠️ 这是**已登记的陷阱**，不是笔误：契约原文的 UNIQUE(stage_id, judge_id, team_id, dimension)
  //    **没有** WHERE deleted_at IS NULL，而改分走的是覆盖写 UPDATE（不软删）。
  //    所以今天的语义是「一个格子终身只有一条」，软删后也插不进第二条。
  //    将来若要实现「撤回评审」，必须同步把索引改成偏序 —— 那时这条断言会先失败，
  //    提醒改动者同步改索引。
  const { db, close, dataDir, judge, team } = setup();
  const ins = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at)
     VALUES (?, 's1', ?, ?, 'innovation', 80, '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1', judge.id, team.id);
  db.prepare(`UPDATE stage_reviews SET deleted_at = '2026-10-21T00:00:00.000Z' WHERE id = 'r1'`).run();
  assert.throws(
    () => ins.run('r2', judge.id, team.id),
    /UNIQUE|constraint/i,
    '非偏序唯一索引：软删不腾格子',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键：校准 / 回避 / 加时轮次 / 快照 / 互评 也都指向真实主体', () => {
  const { db, close, dataDir, judge, team } = setup();
  const fkFail = (sql, ...params) => assert.throws(
    () => db.prepare(sql).run(...params),
    /FOREIGN KEY constraint failed/i,
  );
  // 校准（R-JDG-12）：校准分不计入评分，但赛段/评委必须真实
  fkFail(
    `INSERT INTO calibrations (id, stage_id, judge_id, dimension, raw_score, created_at)
     VALUES ('c1', 'no-such-stage', ?, 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
    judge.id,
  );
  fkFail(
    `INSERT INTO calibrations (id, stage_id, judge_id, dimension, raw_score, created_at)
     VALUES ('c2', 's1', 'no-such-judge', 'innovation', 70, '2026-10-20T00:00:00.000Z')`,
  );
  // 回避记录（R-JDG-09）：回避必须留档
  fkFail(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, action)
     VALUES ('r1', 's1', ?, 'no-such-team', '有利益关系', 'conflict', '2026-10-20T00:00:00.000Z', 'recused')`,
    judge.id,
  );
  fkFail(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, action)
     VALUES ('r2', 's1', 'no-such-judge', ?, '有利益关系', 'conflict', '2026-10-20T00:00:00.000Z', 'recused')`,
    team.id,
  );
  // 加时陈述轮次（S7 §3.3）
  fkFail(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, created_by, created_at)
     VALUES ('tr1', 's1', 'statement', '[]', '2026-10-20T00:10:00.000Z', 'no-such-user', '2026-10-20T00:00:00.000Z')`,
  );
  // 计算快照与赛段结果（可复算的载体）
  fkFail(
    `INSERT INTO computation_snapshots (id, kind, edition_id, rule_version, input_json, output_json, trace_json, created_at)
     VALUES ('cs1', 'stage_score', 'no-such-edition', 'v1', '{}', '{}', '{}', '2026-10-20T00:00:00.000Z')`,
  );
  fkFail(
    `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, computation_id, created_at)
     VALUES ('sr1', 's1', ?, 80, 60, 20, 'no-such-snapshot', '2026-10-20T00:00:00.000Z')`,
    team.id,
  );
  // 互评的起点队伍也要真实
  fkFail(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, created_at)
     VALUES ('p1', 's1', 'no-such-team', ?, 70, '2026-10-20T00:00:00.000Z')`,
    team.id,
  );
  // 回避记录的审计人（audit_by）也是用户引用
  fkFail(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES ('r3', 's1', ?, ?, '有利益关系', 'audit', '2026-10-20T00:00:00.000Z', 'no-such-auditor', 'recused')`,
    judge.id,
    team.id,
  );
  // 幂等键表的赛段也要真实
  fkFail(
    `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
     VALUES ('review', 'no-such-stage', ?, 'req-9', '2026-10-20T00:00:00.000Z')`,
    judge.id,
  );
  // 企业双签的两个签字人也要真实
  fkFail(
    `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, cross_judge_id, created_at)
     VALUES ('e9', 's1', ?, ?, 'delivery', 85, 'no-such-cross-judge', '2026-10-20T00:00:00.000Z')`,
    team.id,
    judge.id,
  );
  fkFail(
    `INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score, signatory_user_id, created_at)
     VALUES ('e10', 's1', ?, ?, 'delivery', 85, 'no-such-signatory', '2026-10-20T00:00:00.000Z')`,
    team.id,
    judge.id,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

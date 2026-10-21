// platform/test/tiebreak.test.js —— 加时陈述与一票破同分
//
// 依据：P2 计划 Task 7「加时陈述与一票破同分（tiebreak_round / tiebreak_votes）」
// 溯源需求：R-JDG-19（同分 → 加时陈述 → 共同复议）
//
// ⚠️ **夹具必须建真实数据**（父代理预审修正，Important）：
//    Task 1 补齐了引用型外键（`stage_id → stages`、`team_id → teams`、`voter_id → users`），
//    原规格用的假 id（'ed1' / 't1' / 't2'）**必然触发外键失败**。
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
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTiebreakVote } from '../src/db/repo/tiebreak.js';
import {
  openTiebreakRound,
  castTiebreakVote,
  closeTiebreakRound,
  getTiebreakRoundState,
  getTiebreakExtraScores,
} from '../src/services/tiebreak.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const NOW = '2026-10-20T10:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tb-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const admin = createUser(db, { name: '组委会', phone: '13900000021', password: 'pw' });
  const voter = createUser(db, { name: '评委甲', phone: '13900000022', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000023', password: 'pw' });
  const captain = createUser(db, { name: '队长甲', phone: '13900000024', password: 'pw' });
  const captain2 = createUser(db, { name: '队长乙', phone: '13900000025', password: 'pw' });

  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const teamA = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, status: 'forming', now: NOW,
  });
  const teamB = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain2.id, status: 'forming', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '决赛', kind: 'final',
    startsAt: '2026-10-26', endsAt: '2026-10-28', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: voter.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });

  return { db, close, dataDir, admin, voter, observer, teamA, teamB, stage };
}

function cleanup({ db, close, dataDir }) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

test('开启加时陈述轮次：同分组 + 10 分钟陈述截止', () => {
  const ctx = setup();
  const { db, admin, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.equal(round.kind, 'statement');
  assert.equal(round.status, 'open');
  assert.deepEqual(JSON.parse(round.tied_team_ids_json), [teamA.id, teamB.id]);
  assert.equal(round.statement_deadline, '2026-10-20T10:10:00.000Z');
  cleanup(ctx);
});

test('一人一队一票：同一 (轮次, 投票人, 队伍) 第二次投票被数据库拒绝', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 90, now: NOW }),
    (err) => err.status === 409,
    '重复投票必须被拒绝（唯一约束保证）',
  );
  // 同一人对另一支队伍投票是允许的
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamB.id, score: 70, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tiebreak_votes').get().n, 2);
  cleanup(ctx);
});

test('轮次状态与票数统计', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  const state = getTiebreakRoundState({ db, roundId: round.id });
  assert.equal(state.votes.length, 1);
  assert.equal(state.tallies[teamA.id].count, 1);
  assert.ok(Math.abs(state.tallies[teamA.id].mean - 80) < 1e-12);
  cleanup(ctx);
});

test('关闭轮次后不能继续投票', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 409,
  );
  cleanup(ctx);
});

test('加时陈述复议分可供破同分链消费', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamB.id, score: 60, now: NOW });
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  const extra = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: [teamA.id, teamB.id] });
  assert.ok(Math.abs(extra[teamA.id] - 80) < 1e-12);
  assert.ok(Math.abs(extra[teamB.id] - 60) < 1e-12);
  cleanup(ctx);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('关闭一个不存在的轮次 → 404（不把裸 TypeError 漏给调用方）', () => {
  // ⚠️ 原实现：UPDATE 0 行 → 返回 null → `round.stage_id` 抛
  //    「Cannot read properties of null」—— 它**不是 AppError**，
  //    HTTP 层只能回通用文案「请求无效」，调用方既拿不到状态码也拿不到原因。
  const ctx = setup();
  const { db, admin } = ctx;
  assert.throws(
    () => closeTiebreakRound({ db, roundId: 'no-such-round', actorId: admin.id, now: NOW }),
    (err) => err.status === 404,
  );
  cleanup(ctx);
});

test('投票人必须是有投票权的评委：观察员 → 403，未分配 → 403', () => {
  const ctx = setup();
  const { db, admin, observer, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: observer.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 403,
    '观察员无投票权（R-JDG-11）',
  );
  const outsider = createUser(db, { name: '路人', phone: '13900000026', password: 'pw' });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: outsider.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 403,
    '未被分配到赛段的人不能投票',
  );
  cleanup(ctx);
});

test('投票分越界 → 400（不让破 100 分的复议分进榜）', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  for (const bad of [1000, -1, NaN]) {
    assert.throws(
      () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: bad, now: NOW }),
      (err) => err.status === 400,
      `score=${String(bad)} 必须被拒`,
    );
  }
  cleanup(ctx);
});

test('未关闭的轮次不得被算进复议分（榜单不能随投票进行而漂移）', () => {
  // ⚠️ 原实现：取全部轮次 → 还在开放投票的轮次，其**当前均值**被当成最终复议分。
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  const before = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: [teamA.id, teamB.id] });
  assert.deepEqual(before, {}, '开放中的轮次不产生复议分');
  closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  const after = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: [teamA.id, teamB.id] });
  assert.ok(Math.abs(after[teamA.id] - 80) < 1e-12);
  cleanup(ctx);
});

test('同分组至少两支队伍；同一赛段不允许两个进行中的轮次', () => {
  const ctx = setup();
  const { db, admin, teamA, teamB, stage } = ctx;
  assert.throws(
    () => openTiebreakRound({
      db, stageId: stage.id, tiedTeamIds: [teamA.id], statementMinutes: 10, actorId: admin.id, now: NOW,
    }),
    (err) => err.status === 400,
  );
  openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.throws(
    () => openTiebreakRound({
      db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
    }),
    (err) => err.status === 409,
    '同一赛段不能同时开两个轮次 —— 否则票会分散在两轮里',
  );
  cleanup(ctx);
});

test('投票给不在同分组里的队伍 → 400', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: 'no-such-team', score: 80, now: NOW }),
    (err) => err.status === 400,
  );
  cleanup(ctx);
});

test('关闭轮次是幂等的（重复关闭原样返回）', () => {
  const ctx = setup();
  const { db, admin, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  const first = closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.equal(first.round.status, 'closed');
  const second = closeTiebreakRound({ db, roundId: round.id, actorId: admin.id, now: NOW });
  assert.equal(second.round.status, 'closed');
  cleanup(ctx);
});

test('回避中的评委不能投票（R-JDG-09）', () => {
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  db.prepare(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES ('r1', ?, ?, ?, '前雇主', 'declared', ?, ?, 'recused')`,
  ).run(stage.id, voter.id, teamA.id, NOW, admin.id);
  assert.throws(
    () => castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

test('均分：两票时 mean ≠ sum（一条票时两者恰好相同，测不出来）', () => {
  // ⚠️ 规格自带那条用例只有**一票** → mean 与 sum **恰好都是 80**，根本区分不了。
  const ctx = setup();
  const { db, admin, voter, teamA, teamB, stage } = ctx;
  const round = openTiebreakRound({
    db, stageId: stage.id, tiedTeamIds: [teamA.id, teamB.id], statementMinutes: 10, actorId: admin.id, now: NOW,
  });
  const voter2 = createUser(db, { name: '评委乙', phone: '13900000027', password: 'pw' });
  assignStageJudge(db, { stageId: stage.id, userId: voter2.id, seat: 'enterprise', now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter.id, teamId: teamA.id, score: 80, now: NOW });
  castTiebreakVote({ db, roundId: round.id, voterId: voter2.id, teamId: teamA.id, score: 60, now: NOW });
  const state = getTiebreakRoundState({ db, roundId: round.id });
  assert.equal(state.tallies[teamA.id].count, 2);
  assert.equal(state.tallies[teamA.id].sum, 140);
  assert.ok(Math.abs(state.tallies[teamA.id].mean - 70) < 1e-12, 'mean 必须是 (80+60)/2 = 70，不是 sum');
  cleanup(ctx);
});

test('投票给不存在的轮次 → 404（不把裸 TypeError 漏给调用方）', () => {
  const ctx = setup();
  const { db, voter, teamA } = ctx;
  assert.throws(
    () => castTiebreakVote({ db, roundId: 'no-such-round', voterId: voter.id, teamId: teamA.id, score: 80, now: NOW }),
    (err) => err.status === 404,
  );
  cleanup(ctx);
});

test('投票的 UNIQUE 兜底只认「唯一约束」，其它约束错必须继续往上抛', () => {
  // ⚠️ 兜底正则若放宽成 /UNIQUE|constraint/i，「外键失败」会被误判成「重复投票」
  //    → 409 → 真实错误被伪装成幂等冲突。Task 6 已踩过一次同样的坑。
  //    这里**绕过开轮次的校验**直接插一个「同分组含幽灵队伍」的轮次，从服务层打通。
  const ctx = setup();
  const { db, voter, teamB, stage } = ctx;
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, vote_deadline, status, created_by, created_at)
     VALUES ('tr-x', ?, 'statement', ?, '2026-10-20T10:10:00.000Z', NULL, 'open', ?, ?)`,
  ).run(stage.id, JSON.stringify(['no-such-team', teamB.id]), voter.id, NOW);
  assert.throws(
    () => castTiebreakVote({ db, roundId: 'tr-x', voterId: voter.id, teamId: 'no-such-team', score: 80, now: NOW }),
    /FOREIGN KEY/i,
    '外键失败不得被当成「重复投票」',
  );
  cleanup(ctx);
});

test('开轮次时同分组里的队伍必须真实存在且属于本赛段', () => {
  const ctx = setup();
  const { db, admin, teamB, stage } = ctx;
  assert.throws(
    () => openTiebreakRound({
      db, stageId: stage.id, tiedTeamIds: ['no-such-team', teamB.id],
      statementMinutes: 10, actorId: admin.id, now: NOW,
    }),
    (err) => err.status === 400,
    '幽灵队伍不得进入同分组',
  );
  cleanup(ctx);
});

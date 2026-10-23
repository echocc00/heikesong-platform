// test/tiebreak-api.test.js — 加时陈述 / 一票破同分的 HTTP 契约
//
// 规则溯源：
//   - 「同分 → 10 分钟加时陈述 → 企业席 + 评委席共同复议」→ R-JDG-19（S7 §3.3）
//     + src/services/tiebreak.js（服务层：同分组校验 / 观察员禁投 / 回避禁投 / 一人一票 / 关闭幂等）
//   - 「权限 = 能力点 + 授权记录，can() 是唯一判定入口」→ 设计文档 §7.1 / §7.2
//   - 「三态状态码」→ 设计文档 §7.3（列表不满足 → 200 + 空集；单条不满足 → 404；能力禁用 → 403）
//   - 「可见性在 API 层过滤」→ 全局约束（前端隐藏 = 数据已泄露）
//   - 「写端点必须留审计」→ 设计文档 §12（可复算与留痕）
//
// ⚠️ **这些闸门一旦没有测试钉住，就会静默失效**（能力点形同虚设、越权可写票、
//    别人的投票明细被广播）—— 与 P1 的 A1（registration:write 注册了却从不校验）同一类病根。
//
// ⚠️ **断言必须判别性**：每条断言都要能区分「对」与「错」——
//    「提交一个明显非法的值，断言它真的报错」，而不是「断言返回值存在」。
//    恒真断言（assert.ok(res.body)）在本文件里一律不写。
//
// ⚠️ **路由是手动挂上去的**（registerTiebreakRoutes(app.router)）：
//    src/server.js 的接线由集成者做（本任务不许改既有文件）⇒
//    不手动挂的话，「测试通过」只是因为「端点没注册」，测不出任何东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { listTiebreakRounds, listTiebreakVotes } from '../src/db/repo/tiebreak.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { registerTiebreakRoutes } from '../src/http/routes/tiebreak.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/**
 * 搭台：真实建库 + 迁移 + 造用户 + 授权 + 挂路由。
 * ⚠️ 身份矩阵是本文件的核心（每种身份只差一个维度，断言才有判别力）：
 *   · 组委会   committee —— 全局 `stage:compute`
 *   · 评委席   judge / judge2 —— 本赛段 seat='judge'
 *   · 观察员   observer —— 本赛段 seat='observer'（R-JDG-11：无投票权）
 *   · 别赛段评委 otherJudge —— 另一个赛段的 seat='judge'（⇒ 本赛段不是评委）
 *   · 企业席   enterprise —— **本赛段没有任何席位**（⇒ 能看结果、看不到明细）
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tbapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });

  const committee = createUser(db, { name: '组委会', phone: '13900000101', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900000102', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000103', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000104', password: 'pw' });
  const otherJudge = createUser(db, { name: '别赛段评委', phone: '13900000105', password: 'pw' });
  const enterprise = createUser(db, { name: '企业席', phone: '13900000106', password: 'pw' });
  const captain = createUser(db, { name: '队长甲', phone: '13900000107', password: 'pw' });
  const captain2 = createUser(db, { name: '队长乙', phone: '13900000108', password: 'pw' });

  insertCapability(db, 'stage:compute', '触发计算发榜');
  insertCapability(db, 'score:read', '读取评分');
  // ⚠️ 只有组委会有 stage:compute（**全局**授权）—— 其余人一个能力点都没有。
  grantAssignment(db, {
    userId: committee.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: null,
  });

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: committee.id, now: NOW,
  });
  const teamA = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const teamB = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain2.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: teamA.id, userId: captain.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teamB.id, userId: captain2.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '决赛', kind: 'final',
    startsAt: '2026-10-20', endsAt: '2026-10-28', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  const otherStage = insertStage(db, {
    editionId: edition.id, key: 's2', name: '路演', kind: 'roadshow',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });
  assignStageJudge(db, { stageId: otherStage.id, userId: otherJudge.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  // ⚠️ 手动挂路由（server.js 的接线由集成者做）—— 不挂就是「端点不存在」，测不出东西。
  // ⚠️ 但**先看一眼**：集成者把 registerTiebreakRoutes 接到 server.js 之后，
  //    这里再挂一遍就会重复注册（同一 pattern 注册两次）⇒ 条件挂载，两种情况都对。
  const wired = app.router.list().some((r) => r.pattern === '/api/stages/:stageId/tiebreak/rounds');
  if (!wired) registerTiebreakRoutes(app.router);

  return {
    db, close, dataDir, app, edition, stage, otherStage, teamA, teamB,
    committee, judge, judge2, observer, otherJudge, enterprise, captain,
    tokenCommittee: createSession(db, committee.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenObserver: createSession(db, observer.id).token,
    tokenOtherJudge: createSession(db, otherJudge.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
  };
}

function cleanup(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

/** JSON.parse 响应体（call 的 body 是**字符串**）。 */
function json(res) {
  return JSON.parse(res.body);
}

/** 开一轮（组委会），返回 { res, body }。 */
async function openRound(s, tiedTeamIds, token = s.tokenCommittee) {
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
    token,
    body: { tiedTeamIds },
  });
  return { res, body: json(res) };
}

// ══════════════════════════════════════════════════════════════════
// 一、开轮次
// ══════════════════════════════════════════════════════════════════

test('① 组委会开轮次 → 200，轮次落库且能读到 tiedTeamIds', async () => {
  const s = setup();
  const { res, body } = await openRound(s, [s.teamA.id, s.teamB.id]);
  assert.equal(res.status, 200, `实际 ${res.status}：${res.body}`);
  assert.ok(body.round?.id, '响应里必须有轮次 id');
  assert.equal(body.round.status, 'open');
  // ⚠️ 判别性：同分组必须**逐字**回传（顺序也一致）—— 不是「有个数组就行」。
  assert.deepEqual(body.round.tiedTeamIds, [s.teamA.id, s.teamB.id]);
  // ⚠️ 判别性：**真的落库了**（不是只在响应里编出来的）。
  const rows = listTiebreakRounds(s.db, { stageId: s.stage.id });
  assert.equal(rows.length, 1, '库里必须正好有一轮');
  assert.deepEqual(JSON.parse(rows[0].tied_team_ids_json), [s.teamA.id, s.teamB.id]);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].stage_id, s.stage.id);
  cleanup(s);
});

test('② 只有 1 支同分队伍开轮次 → 400（NO_TIED_TEAMS），且**没有**留下轮次', async () => {
  const s = setup();
  const { res, body } = await openRound(s, [s.teamA.id]);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'NO_TIED_TEAMS');
  // ⚠️ 判别性：失败**不许**留下半截数据。
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 0);
  cleanup(s);
});

test('③ 同赛段已有 open 轮次再开 → 409（TIEBREAK_ROUND_ALREADY_OPEN）', async () => {
  const s = setup();
  await openRound(s, [s.teamA.id, s.teamB.id]);
  const { res, body } = await openRound(s, [s.teamA.id, s.teamB.id]);
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'TIEBREAK_ROUND_ALREADY_OPEN');
  // ⚠️ 判别性：不能开出第二轮（票不能分散在两轮里）。
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 1);
  cleanup(s);
});

test('④ 非 stage:compute 用户开轮次 → 403，且**没有**留下轮次', async () => {
  const s = setup();
  // ⚠️ 用**本赛段评委**当反例（他有能力点缺失，但身份很接近 ⇒ 才有判别力）。
  const { res, body } = await openRound(s, [s.teamA.id, s.teamB.id], s.tokenJudge);
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 0);
  cleanup(s);
});

test('④b 未登录开轮次 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
    body: { tiedTeamIds: [s.teamA.id, s.teamB.id] },
  });
  assert.equal(res.status, 401);
  assert.equal(json(res).error.code, 'UNAUTHENTICATED');
  cleanup(s);
});

test('④c tiedTeamIds 不是数组 → 400（INVALID_REQUEST），不许开成轮次', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
    token: s.tokenCommittee,
    body: { tiedTeamIds: `${s.teamA.id},${s.teamB.id}` },
  });
  assert.equal(res.status, 400);
  assert.equal(json(res).error.code, 'INVALID_REQUEST');
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id }).length, 0);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、投票
// ══════════════════════════════════════════════════════════════════

test('⑤ 本赛段评委投票 → 200 且落库', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge,
    body: { teamId: s.teamA.id, score: 85 },
  });
  assert.equal(res.status, 200, `实际 ${res.status}：${res.body}`);
  assert.equal(json(res).vote.score, 85);
  assert.equal(json(res).vote.team_id, s.teamA.id);
  // ⚠️ 判别性：真的落库了（一条票，且是这一条）。
  const votes = listTiebreakVotes(s.db, roundId);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].voter_id, s.judge.id);
  assert.equal(votes[0].score, 85);
  cleanup(s);
});

test('⑤b 观察员投票 → 403（OBSERVER_NO_VOTE），不许留下票', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenObserver,
    body: { teamId: s.teamA.id, score: 90 },
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error.code, 'OBSERVER_NO_VOTE');
  assert.equal(listTiebreakVotes(s.db, opened.round.id).length, 0);
  cleanup(s);
});

test('⑤c 非本赛段评委投票 → 403（NOT_ASSIGNED_JUDGE），不许留下票', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  // ⚠️ 反例是**另一个赛段的真评委**（不是随便一个路人）⇒ 才有判别力。
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenOtherJudge,
    body: { teamId: s.teamA.id, score: 90 },
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error.code, 'NOT_ASSIGNED_JUDGE');
  assert.equal(listTiebreakVotes(s.db, opened.round.id).length, 0);
  cleanup(s);
});

test('⑥ 同一评委对同一队伍重复投票 → 409（DUPLICATE_TIEBREAK_VOTE），票数不变', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const first = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 80 },
  });
  assert.equal(first.status, 200);
  const second = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 20 },
  });
  assert.equal(second.status, 409);
  assert.equal(json(second).error.code, 'DUPLICATE_TIEBREAK_VOTE');
  // ⚠️ 判别性：第二票**不许**覆盖第一票（分数必须是第一次那个 80）。
  const votes = listTiebreakVotes(s.db, roundId);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].score, 80);
  cleanup(s);
});

test('⑦ 投票分超出 0–100 → 400（SCORE_OUT_OF_RANGE），不许留下票', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  for (const bad of [120, -1, 1000]) {
    const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
      token: s.tokenJudge, body: { teamId: s.teamA.id, score: bad },
    });
    assert.equal(res.status, 400, `分数 ${bad} 必须被拒`);
    assert.equal(json(res).error.code, 'SCORE_OUT_OF_RANGE');
  }
  assert.equal(listTiebreakVotes(s.db, roundId).length, 0);
  cleanup(s);
});

test('⑦b 投给不在同分组的队伍 → 400（TEAM_NOT_IN_TIE_GROUP）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  // 第三支队伍：不在本赛段名册之外，但**不在同分组**里。
  const captain3 = createUser(s.db, { name: '队长丙', phone: '13900000109', password: 'pw' });
  const teamC = insertTeam(s.db, {
    editionId: s.edition.id, name: '丙队', captainId: captain3.id, taskPackageId: null, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenJudge, body: { teamId: teamC.id, score: 70 },
  });
  assert.equal(res.status, 400);
  assert.equal(json(res).error.code, 'TEAM_NOT_IN_TIE_GROUP');
  assert.equal(listTiebreakVotes(s.db, opened.round.id).length, 0);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 三、关闭轮次
// ══════════════════════════════════════════════════════════════════

test('⑧ 关闭轮次 → 200 且状态变 closed；关闭后再投票 → 409（TIEBREAK_ROUND_CLOSED）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const closed = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/close`, {
    token: s.tokenCommittee, body: {},
  });
  assert.equal(closed.status, 200, `实际 ${closed.status}：${closed.body}`);
  assert.equal(json(closed).round.status, 'closed');
  assert.deepEqual(json(closed).tallies, {}, '还没投票时统计应为空对象');
  // ⚠️ 判别性：库里状态真的变了。
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id })[0].status, 'closed');

  const after = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 80 },
  });
  assert.equal(after.status, 409);
  assert.equal(json(after).error.code, 'TIEBREAK_ROUND_CLOSED');
  assert.equal(listTiebreakVotes(s.db, roundId).length, 0);
  cleanup(s);
});

test('⑧b 非组委会关闭轮次 → 403，且轮次仍是 open', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/close`, {
    token: s.tokenJudge, body: {},
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error.code, 'FORBIDDEN');
  assert.equal(listTiebreakRounds(s.db, { stageId: s.stage.id })[0].status, 'open');
  cleanup(s);
});

test('⑧c 关闭不存在的轮次 → 404（TIEBREAK_ROUND_NOT_FOUND）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/tiebreak/rounds/no-such-round/close', {
    token: s.tokenCommittee, body: {},
  });
  assert.equal(res.status, 404);
  assert.equal(json(res).error.code, 'TIEBREAK_ROUND_NOT_FOUND');
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 四、读轮次状态：可见性在 API 层过滤
// ══════════════════════════════════════════════════════════════════

test('⑨ 读轮次状态：组委会与本赛段评委看得到 votes；企业席看不到 votes 但看得到 tallies（且**不是 403**）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  // 两票：评委甲给甲队 80、评委乙给甲队 60（⇒ 甲队 count=2 / sum=140 / mean=70）
  const v1 = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 80 },
  });
  const v2 = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge2, body: { teamId: s.teamA.id, score: 60 },
  });
  assert.equal(v1.status, 200);
  assert.equal(v2.status, 200);

  // ① 组委会 → 全部 votes
  const asCommittee = await call(s.app, 'GET', `/api/tiebreak/rounds/${roundId}`, { token: s.tokenCommittee });
  assert.equal(asCommittee.status, 200);
  const cBody = json(asCommittee);
  assert.equal(cBody.votes.length, 2, '组委会应看到两票明细');
  assert.equal(cBody.round.id, roundId);
  assert.deepEqual(cBody.tallies[s.teamA.id], { count: 2, sum: 140, mean: 70 });

  // ② 本赛段评委 → 全部 votes（同赛段互相看得到复议分是复议的前提）
  const asJudge = await call(s.app, 'GET', `/api/tiebreak/rounds/${roundId}`, { token: s.tokenJudge });
  assert.equal(asJudge.status, 200);
  assert.equal(json(asJudge).votes.length, 2, '本赛段评委应看到两票明细');

  // ③ 企业席（本赛段无席位）→ **不是 403**，但 votes 被收窄、tallies 照给
  const asEnterprise = await call(s.app, 'GET', `/api/tiebreak/rounds/${roundId}`, { token: s.tokenEnterprise });
  assert.equal(asEnterprise.status, 200, '收窄可见性**不得**回 403（他们有权知道复议结果）');
  const eBody = json(asEnterprise);
  assert.deepEqual(eBody.votes, [], '企业席不得看到别人的投票明细');
  assert.ok(eBody.tallies[s.teamA.id], '企业席仍应看得到统计结果');
  assert.equal(eBody.tallies[s.teamA.id].count, 2);
  assert.equal(eBody.tallies[s.teamA.id].mean, 70);
  cleanup(s);
});

test('⑨b 读不存在的轮次 → 404（TIEBREAK_ROUND_NOT_FOUND）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/tiebreak/rounds/no-such-round', { token: s.tokenCommittee });
  assert.equal(res.status, 404);
  assert.equal(json(res).error.code, 'TIEBREAK_ROUND_NOT_FOUND');
  cleanup(s);
});

test('⑨c 未登录读轮次 → 401', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'GET', `/api/tiebreak/rounds/${opened.round.id}`);
  assert.equal(res.status, 401);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 五、列表端点：列表语义 = 200 + 空集（不是 404）
// ══════════════════════════════════════════════════════════════════

test('⑪ 本赛段没有轮次时 → 200 + items: []（列表语义**不是 404**）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', `/api/stages/${s.stage.id}/tiebreak/rounds`, { token: s.tokenCommittee });
  assert.equal(res.status, 200);
  const body = json(res);
  assert.ok(Array.isArray(body.items), 'items 必须是数组');
  assert.deepEqual(body.items, []);
  cleanup(s);
});

test('⑪b 有轮次时列表带出轮次；未登录 → 401', async () => {
  const s = setup();
  await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'GET', `/api/stages/${s.stage.id}/tiebreak/rounds`, { token: s.tokenCommittee });
  assert.equal(res.status, 200);
  const body = json(res);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.items[0].tiedTeamIds, [s.teamA.id, s.teamB.id]);
  assert.equal(body.items[0].status, 'open');

  const anon = await call(s.app, 'GET', `/api/stages/${s.stage.id}/tiebreak/rounds`);
  assert.equal(anon.status, 401);
  cleanup(s);
});

// ══════════════════════════════════════════════════════════════════
// 六、审计：投票必须留痕
// ══════════════════════════════════════════════════════════════════

test('⑩ 投票后审计日志里能查到一条 action=tiebreak.vote 的记录', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const roundId = opened.round.id;
  const before = queryAuditLog(s.db, { action: 'tiebreak.vote' }).total;
  assert.equal(before, 0, '投票前不该有 tiebreak.vote 记录');

  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
    token: s.tokenJudge, body: { teamId: s.teamA.id, score: 85 },
  });
  assert.equal(res.status, 200);

  const after = queryAuditLog(s.db, { action: 'tiebreak.vote' });
  assert.equal(after.total, 1, '投票后必须正好有一条 tiebreak.vote 记录');
  const row = after.rows[0];
  assert.equal(row.actor_id, s.judge.id, '审计的 actor 必须是投票人');
  assert.equal(row.entity, 'stage');
  assert.equal(row.entity_id, s.stage.id, 'entity_id 必须是轮次所属赛段');
  const detail = JSON.parse(row.detail_json);
  assert.equal(detail.roundId, roundId);
  assert.equal(detail.teamId, s.teamA.id);
  assert.equal(detail.score, 85);
  cleanup(s);
});

test('⑩b 失败的投票**不写**审计（只有真正落库的票才留痕）', async () => {
  const s = setup();
  const { body: opened } = await openRound(s, [s.teamA.id, s.teamB.id]);
  const res = await call(s.app, 'POST', `/api/tiebreak/rounds/${opened.round.id}/votes`, {
    token: s.tokenObserver, body: { teamId: s.teamA.id, score: 90 },
  });
  assert.equal(res.status, 403);
  assert.equal(queryAuditLog(s.db, { action: 'tiebreak.vote' }).total, 0);
  cleanup(s);
});

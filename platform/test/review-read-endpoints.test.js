// platform/test/review-read-endpoints.test.js —— P10 评委前置的**读端点**与**校准维度白名单**
//
// 规则溯源：
//   - 「评委为供应方 / 投资方 / 前雇主必须回避，回避记录留档」→ R-JDG-09
//   - 「评委须签署声明」→ R-JDG-18
//   - 「用同一组样例作品校准宽严尺度，校准结果不计入评分」→ R-JDG-12
//   - 「自评测只触发解释与提问，不加分」→ R-JDG-13
//   - 「互评：队 → 队，提交者必须是发起队的在册成员」→ src/services/review.js submitPeerReviews
//   - 「权限模型 = capability + assignment，can() 是唯一判定入口」→ 设计文档 §7.1 / §7.2
//   - 「三态状态码」→ 设计文档 §7.3（未登录 → 401；禁用 → 403；单条不存在 → 404）
//   - 「可见性在 API 层过滤，前端隐藏 = 数据已泄露」→ 设计文档 §6.6
//   - 「确定性排序：兜底键用 rowid，不用随机 UUID」→ 全局约定 #43
//
// ⚠️ 本文件全部是**行为断言**（断言真实返回值 / 数据库状态），不是「源码里有某个字符串」。
// ⚠️ 夹具用**真实外键**（真实 user / edition / team / stage）—— 本仓有外键约束，假 id 会被 DB 拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-23T08:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['stage:compute', '触发计算发榜'],
  ['peer_review:write', '互评'],
  ['self_review:write', '提交本队自评'],
];

/**
 * 夹具：
 *   三支队（team1 / team2 / team3），队长是**独立的 captain 用户**（不是 admin）——
 *   ⛔ 这样 admin 自己**不属于任何队** ⇒ 「只有我参与的那部分」的断言才不会被
 *   「队长也算参与」这条口径污染（队长当然算参与，但那样就分不清是谁的记录了）。
 *   评委甲在 team1、评委乙在 team2。
 *   两个赛段：初赛（initial，没有 self 席维度）与决赛（final，有 self_eval 自评测维度）。
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-revread-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judgeA = createUser(db, { name: '评委甲', phone: '13900000061', password: 'pw' });
  const judgeB = createUser(db, { name: '评委乙', phone: '13900000062', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000063', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000064', password: 'pw' });
  const outsider = createUser(db, { name: '路人', phone: '13900000065', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judgeA.id, 'score:write');
  grant(judgeB.id, 'score:write');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(judgeA.id, 'peer_review:write');
  grant(judgeA.id, 'self_review:write');
  grant(judgeB.id, 'peer_review:write');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: null, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team3 = insertTeam(db, {
    editionId: edition.id, name: '三队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: judgeA.id, role: 'member', now: NOW });
  insertTeamMember(db, { teamId: team2.id, userId: judgeB.id, role: 'member', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  // 决赛赛段：权重表里有 seat='self' 的「自评测」维度（初赛没有）
  const finalStage = insertStage(db, {
    editionId: edition.id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-10-11', endsAt: '2026-10-20', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judgeA.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judgeB.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: finalStage.id, userId: judgeA.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: finalStage.id, userId: judgeB.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, edition, judgeA, judgeB, admin, captain, outsider,
    team1, team2, team3, stage, finalStage,
    tokenA: createSession(db, judgeA.id).token,
    tokenB: createSession(db, judgeB.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function teardown(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════
// 一、回避台账读口：GET /api/stages/:stageId/recusals
// ══════════════════════════════════════════════════════════════════

test('回避台账：评委只看得到**自己**的记录，看不到别人的', async () => {
  const s = setup();
  // 评委甲为一队申报回避
  const a = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA,
    body: { teamId: s.team1.id, reason: '我是该队的供应方' },
  });
  assert.equal(a.status, 200, '本人申报回避应当成功');
  // 评委乙为二队申报回避
  const b = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenB,
    body: { teamId: s.team2.id, reason: '我是该队的投资方' },
  });
  assert.equal(b.status, 200);

  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 1, '评委甲只能看到自己那一条（评委乙的不许出现）');
  const item = res.json.items[0];
  assert.equal(item.judgeId, s.judgeA.id);
  assert.equal(item.teamId, s.team1.id);
  assert.equal(item.teamName, '一队', '必须带队伍名（人读要用；队名本来就在榜单上公开）');
  assert.equal(item.reason, '我是该队的供应方');
  assert.equal(item.status, 'recused');
  assert.ok(typeof item.createdAt === 'string' && item.createdAt, '必须带 createdAt');
  assert.ok(
    !res.json.items.some((x) => x.judgeId === s.judgeB.id),
    '⛔ 别人的回避记录绝不能出现在我的清单里',
  );
  teardown(s);
});

test('回避台账：组委会（stage:compute）看得到**全部**记录', async () => {
  const s = setup();
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA, body: { teamId: s.team1.id, reason: '供应方' },
  });
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenB, body: { teamId: s.team2.id, reason: '投资方' },
  });
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 2, '组委会应当看到全部两条');
  assert.deepEqual(
    res.json.items.map((x) => x.judgeId).sort(),
    [s.judgeA.id, s.judgeB.id].sort(),
  );
  teardown(s);
});

test('回避台账：没有记录时返回 200 + `{ items: [] }`（⛔ 不是 404）', async () => {
  const s = setup();
  const judge = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenA });
  assert.equal(judge.status, 200);
  assert.deepEqual(judge.json, { items: [] }, '列表端点没有记录是常态 ⇒ 200 + 空集');

  const admin = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenAdmin });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.json, { items: [] });
  teardown(s);
});

test('回避台账：普通登录用户（无任何能力点）只能看到自己的（空）清单，不是 403', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenOutsider });
  assert.equal(res.status, 200, '「登录即可读自己的」—— 不是「有权限才许读」');
  assert.deepEqual(res.json, { items: [] });
  teardown(s);
});

test('回避台账：未登录 → 401；赛段不存在 → 404', async () => {
  const s = setup();
  const anon = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`);
  assert.equal(anon.status, 401);

  const missing = await callJson(s.app, 'GET', '/api/stages/stage_nonexistent/recusals', { token: s.tokenA });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'STAGE_NOT_FOUND');
  teardown(s);
});

test('回避台账：撤销（reinstated）也进台账，status 标得出', async () => {
  const s = setup();
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA, body: { teamId: s.team1.id, reason: '前雇主' },
  });
  // ⛔ 撤销只能由组委会做（路由里的硬闸）
  const byJudge = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA, body: { teamId: s.team1.id, reason: '误报', action: 'reinstated' },
  });
  assert.equal(byJudge.status, 403, '评委不得自己撤销自己申报的回避');

  const byAdmin = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenAdmin, body: { judgeId: s.judgeA.id, teamId: s.team1.id, reason: '误报', action: 'reinstated' },
  });
  assert.equal(byAdmin.status, 200);

  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((x) => x.status).sort(), ['recused', 'reinstated']);
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、review-board 的三个「我已经交过哪些」
// ══════════════════════════════════════════════════════════════════

/** 让两支队都有「真实交付物」（互评资格的前置条件：已有人给它打过分）。 */
async function seedDeliverables(s, stageId) {
  for (const teamId of [s.team1.id, s.team2.id]) {
    const r = await callJson(s.app, 'POST', `/api/stages/${stageId}/reviews`, {
      token: s.tokenA,
      body: { items: [{ teamId, dimension: 'innovation', rawScore: 70 }] },
    });
    assert.equal(r.status, 200, `评委打分应当成功：${JSON.stringify(r.json)}`);
  }
}

test('review-board：myPeerReviews / mySelfReviews / myCalibrations **只含当前 viewer 自己的**', async () => {
  const s = setup();
  // ⚠️ 这一整组用例都在**决赛赛段**上做：决赛权重表同时有
  //    seat='judge'（innovation…）与 seat='self'（self_eval 自评测）两类维度。
  const stageId = s.finalStage.id;
  await seedDeliverables(s, stageId);

  // 评委甲（team1 成员）交互评（从 team1 → team2）
  const peer = await callJson(s.app, 'POST', `/api/stages/${stageId}/peer-reviews`, {
    token: s.tokenA,
    body: { items: [{ fromTeamId: s.team1.id, toTeamId: s.team2.id, score: 66 }] },
  });
  assert.equal(peer.status, 200, JSON.stringify(peer.json));

  // 评委甲为本队交自评
  const self = await callJson(s.app, 'POST', `/api/stages/${stageId}/self-review`, {
    token: s.tokenA,
    body: { teamId: s.team1.id, items: [{ dimension: 'self_eval', rawScore: 80 }] },
  });
  assert.equal(self.status, 200, JSON.stringify(self.json));

  // 评委甲交校准分（评委席维度）
  const cal = await callJson(s.app, 'POST', `/api/stages/${stageId}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'innovation', rawScore: 55 }] },
  });
  assert.equal(cal.status, 200, JSON.stringify(cal.json));

  const mine = await callJson(s.app, 'GET', `/api/stages/${stageId}/review-board`, { token: s.tokenA });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.myPeerReviews.length, 1);
  assert.equal(mine.json.myPeerReviews[0].fromTeamId, s.team1.id);
  assert.equal(mine.json.myPeerReviews[0].toTeamId, s.team2.id);
  assert.equal(mine.json.myPeerReviews[0].score, 66);
  assert.equal(mine.json.mySelfReviews.length, 1);
  assert.equal(mine.json.mySelfReviews[0].teamId, s.team1.id);
  assert.equal(mine.json.mySelfReviews[0].dimension, 'self_eval');
  assert.equal(mine.json.mySelfReviews[0].rawScore, 80);
  assert.equal(mine.json.myCalibrations.length, 1);
  assert.equal(mine.json.myCalibrations[0].dimension, 'innovation');
  assert.equal(mine.json.myCalibrations[0].rawScore, 55);

  // ⛔ 别人（评委乙，什么都没交）必须什么都看不到
  const other = await callJson(s.app, 'GET', `/api/stages/${stageId}/review-board`, { token: s.tokenB });
  assert.equal(other.status, 200);
  assert.deepEqual(other.json.myPeerReviews, [], '⛔ 别人的互评不许进我的清单');
  assert.deepEqual(other.json.mySelfReviews, []);
  assert.deepEqual(other.json.myCalibrations, []);

  // ⛔ 组委会也**只看自己的**（本轮不实现「看全部」）
  const admin = await callJson(s.app, 'GET', `/api/stages/${stageId}/review-board`, { token: s.tokenAdmin });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.json.myPeerReviews, [], '组委会看到的也是「自己的」，不是全赛段的');
  assert.deepEqual(admin.json.mySelfReviews, []);
  assert.deepEqual(admin.json.myCalibrations, []);
  teardown(s);
});

test('review-board：没交过时三个数组都是空数组（200，不是 404）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.myPeerReviews, []);
  assert.deepEqual(res.json.mySelfReviews, []);
  assert.deepEqual(res.json.myCalibrations, []);
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 三、校准分的维度白名单（与 POST /reviews 同口径）
// ══════════════════════════════════════════════════════════════════

test('⛔ 校准打分提交**非评委席维度** → 403（与 POST /reviews 同一错误码）', async () => {
  const s = setup();
  // ⚠️ 两个非评委席维度分别住在**两张权重表**里：
  //   'enterprise'（企业确认，seat='enterprise'）在初赛表；
  //   'self_eval'（自评测，seat='self'）**只在决赛表**（初赛表没有这个维度）。
  //   ⇒ 分两个赛段试，否则 'self_eval' 在初赛会被判「未知维度」（400）而不是「席位不对」（403）。
  const cases = [
    { stageId: s.stage.id, dimension: 'enterprise' },
    { stageId: s.finalStage.id, dimension: 'self_eval' },
  ];
  for (const { stageId, dimension } of cases) {
    const res = await callJson(s.app, 'POST', `/api/stages/${stageId}/calibration`, {
      token: s.tokenA, body: { items: [{ dimension, rawScore: 90 }] },
    });
    assert.equal(res.status, 403, `维度 ${dimension} 不该被校准入口接受`);
    assert.equal(res.json.error.code, 'DIMENSION_SEAT_FORBIDDEN');
  }
  // ⛔ 被拒的校准**不得落库**
  const rows = s.db.prepare('SELECT * FROM calibrations').all();
  assert.equal(rows.length, 0, '被拒绝的校准分不得写进 calibrations 表');
  teardown(s);
});

test('⛔ 校准与打分的维度闸门**同一口径**（同样 403 / 同样错误码）', async () => {
  const s = setup();
  const cal = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'enterprise', rawScore: 90 }] },
  });
  const review = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenA, body: { items: [{ teamId: s.team1.id, dimension: 'enterprise', rawScore: 90 }] },
  });
  assert.equal(cal.status, review.status, '两个入口的状态码必须一致');
  assert.equal(cal.json.error.code, review.json.error.code, '两个入口的错误码必须一致');
  teardown(s);
});

test('校准打分提交**评委席维度** → 成功（且只落一条）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'innovation', rawScore: 60 }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.submitted, 1);
  const rows = s.db.prepare('SELECT * FROM calibrations WHERE stage_id = ? AND judge_id = ?')
    .all(s.stage.id, s.judgeA.id);
  assert.equal(rows.length, 1, '校准分必须真的落库');
  assert.equal(rows[0].dimension, 'innovation');
  assert.equal(rows[0].raw_score, 60);
  teardown(s);
});

test('⛔ 校准打分提交**未知维度** → 400 UNKNOWN_DIMENSION（与打分入口同口径）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'not_a_dimension', rawScore: 60 }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'UNKNOWN_DIMENSION');
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 四、演示适配器：GET /api/teams 与正式站**同口径**
// ══════════════════════════════════════════════════════════════════

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const demoSeed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));

test('正式站：GET /api/teams 只返回「我参与的」队伍', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', '/api/teams', { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((t) => t.id), [s.team1.id], '评委甲只在 team1 里');
  const others = await callJson(s.app, 'GET', '/api/teams', { token: s.tokenB });
  assert.deepEqual(others.json.items.map((t) => t.id), [s.team2.id], '评委乙只在 team2 里');
  teardown(s);
});

test('演示适配器：GET /api/teams **不得返回全部队伍**（与正式站同口径：只返回我参与的）', async () => {
  const { createDemoApi, demoMyTeams } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });

  const { items } = await api.get('/api/teams');
  assert.ok(Array.isArray(items), '形状必须是 { items: [...] }（与正式站一致）');
  assert.ok(
    items.length < demoSeed.teams.length,
    `⛔ 演示站不得返回全部 ${demoSeed.teams.length} 支队（正式站只返回我参与的），实际 ${items.length}`,
  );
  assert.deepEqual(items.map((t) => t.id), ['t_alpha'], '演示管理员的「我的战队」只有种子里的那一支');

  // ⚠️ **逐字段同口径**：以「演示队长（MBA）」的身份看 ⇒ 他的队伍 = 他当队长/当成员的那几支
  const state = { ...demoSeed, me: { id: 'mba_captain', teamId: null } };
  const mine = demoMyTeams(state).map((t) => t.id);
  assert.deepEqual(mine.sort(), ['t_alpha', 't_epsilon', 't_gamma']);
  assert.ok(!mine.includes('t_beta'), '不是他队的队伍不得出现');
  assert.ok(!mine.includes('t_delta'), '不是他队的队伍不得出现');
});

test('演示适配器与正式站：GET /api/teams 的**队伍视图形状**逐字段一致', async () => {
  const s = setup();
  const formal = await callJson(s.app, 'GET', '/api/teams', { token: s.tokenA });
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  const demo = await api.get('/api/teams');

  const keys = (t) => Object.keys(t).sort();
  assert.deepEqual(keys(demo.items[0]), keys(formal.json.items[0]), '两边的字段集合必须一致');
  assert.ok(Array.isArray(demo.items[0].members));
  assert.ok(demo.items[0].members[0].userId, '成员必须带 userId');
  assert.ok(['captain', 'member'].includes(demo.items[0].members[0].role));
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 五、演示适配器：评委前置的**五个端点**都得在（缺一个 ⇒ 演示站是错误态）
// ══════════════════════════════════════════════════════════════════

test('演示适配器：评委前置的五个端点都已实现（⛔ 不是 DEMO_ENDPOINT_MISSING）', async () => {
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  const stage = 'stage_final';

  const calls = [
    ['get', `/api/stages/${stage}/recusals`, null],
    ['post', `/api/stages/${stage}/recusals`, { teamId: 't_alpha', reason: '演示：我是该队的供应方' }],
    ['post', `/api/stages/${stage}/peer-reviews`, {
      items: [{ fromTeamId: 't_alpha', toTeamId: 't_beta', score: 70 }],
    }],
    ['post', `/api/stages/${stage}/self-review`, {
      teamId: 't_alpha', items: [{ dimension: 'self_eval', rawScore: 80 }],
    }],
    ['post', `/api/stages/${stage}/calibration`, { items: [{ dimension: 'innovation', rawScore: 60 }] }],
  ];
  for (const [verb, path, body] of calls) {
    await assert.doesNotReject(
      () => api[verb](path, body ?? undefined),
      (e) => {
        assert.notEqual(e.code, 'DEMO_ENDPOINT_MISSING', `演示站未实现 ${verb.toUpperCase()} ${path}`);
        return true;
      },
    );
  }
});

test('演示适配器：评委前置的端点**形状**与正式站一致', async () => {
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  const stage = 'stage_final';

  // ① 回避台账读口：{ items: [...] }，字段与正式站 getRecusalLedger 一致
  const empty = await api.get(`/api/stages/${stage}/recusals`);
  assert.deepEqual(Object.keys(empty).sort(), ['items'], '必须是 { items } 一个键');
  assert.deepEqual(empty.items, [], '没有记录时是空集');

  const created = await api.post(`/api/stages/${stage}/recusals`, {
    teamId: 't_alpha', reason: '演示：供应方',
  });
  assert.ok(created.id, 'POST 返回数据库原始行（带 id）');
  assert.equal(created.stage_id, stage);
  assert.equal(created.team_id, 't_alpha');
  assert.equal(created.reason, '演示：供应方');
  assert.equal(created.action, 'recused');

  const ledger = await api.get(`/api/stages/${stage}/recusals`);
  assert.equal(ledger.items.length, 1);
  assert.deepEqual(
    Object.keys(ledger.items[0]).sort(),
    ['auditBy', 'createdAt', 'id', 'judgeId', 'judgeName', 'reason', 'source', 'stageId', 'status', 'teamId', 'teamName'],
  );
  assert.equal(ledger.items[0].teamName, '拾光队', '必须带队伍名（人读要用）');
  assert.equal(ledger.items[0].status, 'recused');

  // ② 互评：{ stageId, submitted, items }
  const peer = await api.post(`/api/stages/${stage}/peer-reviews`, {
    items: [{ fromTeamId: 't_alpha', toTeamId: 't_beta', score: 70 }],
  });
  assert.deepEqual(Object.keys(peer).sort(), ['items', 'stageId', 'submitted']);
  assert.equal(peer.submitted, 1);
  assert.equal(peer.items[0].from_team_id, 't_alpha');
  assert.equal(peer.items[0].to_team_id, 't_beta');
  assert.equal(peer.items[0].score, 70);

  // ③ 自评：{ stageId, teamId, submitted, items }
  const self = await api.post(`/api/stages/${stage}/self-review`, {
    teamId: 't_alpha', items: [{ dimension: 'self_eval', rawScore: 80 }],
  });
  assert.deepEqual(Object.keys(self).sort(), ['items', 'stageId', 'submitted', 'teamId']);
  assert.equal(self.items[0].dimension, 'self_eval');
  assert.equal(self.items[0].raw_score, 80);

  // ④ 校准：{ stageId, judgeId, submitted }
  const cal = await api.post(`/api/stages/${stage}/calibration`, {
    items: [{ dimension: 'innovation', rawScore: 60 }],
  });
  assert.deepEqual(Object.keys(cal).sort(), ['judgeId', 'stageId', 'submitted']);
  assert.equal(cal.submitted, 1);

  // ⑤ review-board 带上三个「我已经交过哪些」（与正式站同名字段）
  const board = await api.get(`/api/stages/${stage}/review-board`);
  assert.ok(Array.isArray(board.myPeerReviews));
  assert.ok(Array.isArray(board.mySelfReviews));
  assert.ok(Array.isArray(board.myCalibrations));
  assert.deepEqual(Object.keys(board.myPeerReviews[0]).sort(), ['fromTeamId', 'score', 'toTeamId']);
  assert.deepEqual(Object.keys(board.mySelfReviews[0]).sort(), ['dimension', 'rawScore', 'teamId']);
  assert.deepEqual(Object.keys(board.myCalibrations[0]).sort(), ['dimension', 'rawScore']);
});

test('演示适配器：校准的**维度白名单**与正式站同码（非评委席 → 403 DIMENSION_SEAT_FORBIDDEN）', async () => {
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  await assert.rejects(
    () => api.post('/api/stages/stage_final/calibration', { items: [{ dimension: 'enterprise', rawScore: 90 }] }),
    (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, 'DIMENSION_SEAT_FORBIDDEN');
      return true;
    },
  );
  await assert.rejects(
    () => api.post('/api/stages/stage_final/calibration', { items: [{ dimension: 'self_eval', rawScore: 90 }] }),
    (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, 'DIMENSION_SEAT_FORBIDDEN');
      return true;
    },
  );
});

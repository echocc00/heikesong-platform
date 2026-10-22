// platform/test/review-board-api.test.js —— P8 评审工作台读口（GET /api/stages/:stageId/review-board）
//
// 规则溯源：
//   - 「权限模型 = capability + assignment，can() 是唯一判定入口」→ 设计文档 §7.1/§7.2
//   - 「三态状态码」→ 设计文档 §7.3（未登录 → 401；禁用 → 403；单条不存在 → 404）
//   - 「可见性在 API 层过滤」→ 设计文档 §6.6（前端隐藏 = 数据已泄露）
//   - 「评分只增不改，改分留痕」→ R-JDG / 评审引擎
//
// ⚠️ 这个端点是 P8 **唯一新增的后端接口**，它一次性解决「前端拼评分表单要三样东西、
//    但三样东西都没有对外读口」的问题 ⇒ 一旦形状漂移，评审页会**静默地**显示错的东西
//    （比如漏一个维度 ⇒ 评委以为那维度不用打分）。
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
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-revboard-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000051', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000052', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000053', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000054', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: null, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: judge.id, role: 'member', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, judge, judge2, admin, outsider, team1, team2, stage,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function teardown(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════
// 一、权限闸门（与 review-state 同口径）
// ══════════════════════════════════════════════════════════════════

test('未登录读评审工作台 → 401', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`);
  assert.equal(res.status, 401);
  teardown(s);
});

test('无权限者读评审工作台 → 403（既不是评委、也没有 score:read / stage:compute）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'FORBIDDEN');
  teardown(s);
});

test('本赛段评委可读（不需要 score:read）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(res.status, 200);
  teardown(s);
});

test('组委会可读（有 stage:compute 即��）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  teardown(s);
});

test('赛段不存在 → 404（不是 403 也不是 200 空集）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', '/api/stages/stage_nonexistent/review-board', { token: s.tokenAdmin });
  assert.equal(res.status, 404);
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、返回形状（前端拼评分表单要的四样东西必须都在）
// ══════════════════════════════════════════════════════════════════

test('评审工作台：名册带**队名**与任务包标题（listStageTeams 只有 teamId ⇒ 前端显示不出队名）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(res.status, 200);
  const { teams } = res.json;
  assert.equal(teams.length, 2);
  assert.deepEqual(teams.map((t) => t.name).sort(), ['一队', '二队']);
  assert.ok(teams.every((t) => typeof t.id === 'string' && t.id));
  assert.ok(teams.every((t) => typeof t.taskPackageTitle === 'string'), '任务包标题必须带出来');
  teardown(s);
});

test('评审工作台：judgeDimensions 只含 seat=judge 的维度（评委不能给企业席/自评席打分）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  const { dimensions, judgeDimensions } = res.json;
  assert.ok(dimensions.length > judgeDimensions.length, '总维度必须多于评委席维度（否则白名单失效）');
  assert.ok(judgeDimensions.every((d) => d.seat === 'judge'));
  assert.ok(!judgeDimensions.some((d) => d.seat === 'enterprise'), '企业席维度不能进评委可打分清单');
  for (const d of judgeDimensions) {
    assert.ok(typeof d.key === 'string' && typeof d.name === 'string', '维度必须有 key 与名称');
    assert.equal(typeof d.weight, 'number', '维度必须有权重（前端要显示权重占比）');
  }
  teardown(s);
});

test('评审工作台：进度分母 = 队伍数 × 评委席维度数（不是「已出现过的维度」）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  const { progress, teams, judgeDimensions } = res.json;
  assert.equal(progress.total, teams.length * judgeDimensions.length);
  assert.equal(progress.submitted, 0);
  assert.ok(progress.missing.length > 0, '没打分就该在 missing 里');
  teardown(s);
});

test('评审工作台：myScores **只含本人的分**（别人的分不进评审页）', async () => {
  const s = setup();
  // 评委乙先给一队打分
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge2,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 77 }] },
  });
  const judgeRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(judgeRes.json.myScores.length, 0, '评委甲看不到评委乙的分');

  // 评委乙自己看得到自己给的分（改分要回填）
  const selfRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge2 });
  assert.equal(selfRes.json.myScores.length, 1);
  assert.equal(selfRes.json.myScores[0].rawScore, 77);
  assert.equal(selfRes.json.myScores[0].teamId, s.team1.id);
  teardown(s);
});

test('评审工作台：进度必须标明**口径**（mine / stage）', async () => {
  const s = setup();
  // ⚠️ 组委会与评委拿到的 progress 是**两套口径**（全赛段 vs 只看自己）——
  //    同一组 {submitted,total,missing} 不带口径 ⇒ 前端标签必然有一半是错的。
  const judgeRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(judgeRes.json.progress.scope, 'mine', '评委看到的进度是「我自己」的口径');

  const adminRes = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenAdmin });
  assert.equal(adminRes.json.progress.scope, 'stage', '组委会看到的进度是「全赛段」的口径');
  teardown(s);
});

test('评审工作台：stage 摘要带赛段名与权重表键（前端要显示赛段名）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenJudge });
  assert.equal(res.json.stage.id, s.stage.id);
  assert.equal(res.json.stage.name, '初赛');
  assert.equal(res.json.stage.scoringConfigKey, 'initial');
  teardown(s);
});

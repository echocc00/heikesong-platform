// platform/test/stage-config-api.test.js —— 「赛段配置」页所需的**组委会读口**闸（P11 新建 · E158）
//
// ⛔ **这个文件为什么必须存在**（P11 的病根 #1 同一个形态）：
//   P11 的 E150 把赛段的 6 个**写**端点（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
//   全做完了，但**前端一个界面都没有** ⇒ 设计文档 §9「赛段配置与权重表」这块界面不存在。
//   补界面时又撞出**下一层**缺口：页面要能选队伍、选评委、看权重表，
//   而这三个读口**一个都不存在**：
//     · `GET /api/teams` 返回的是「**我参与的**战队」（participant 视角）
//       ⇒ 组委会看到的永远是空数组 ⇒ 名册登记页**没有任何可选队伍**；
//     · 没有任何端点能列出「可当评委的人」；
//     · 权重表的**维度**虽已由 `GET /api/event-info` 公开，但组委会要的
//       **席构成约束**（judgePool）没有对外投影。
//   ⇒ 本文件用**真实 HTTP 路由**把这些口钉死（含权限与白名单投影）。
//
// 规则溯源：
//   · 「赛段配置与权重表」界面 ⇒ 设计文档 §9（前端 IA，组委会视角）
//   · 可见性在 API 层过滤 ⇒ 全局约束
//   · 三态状态码（404 不存在 / 403 没权限 / 200 成功）⇒ 设计文档 §7.3
//   · 逐字段白名单投影（不泄漏内部工作语言）⇒ src/domain/event-info.js 同款纪律
//   · 评委候选池 ≠ 全部用户 ⇒ 顶层文档 §3.1 S2「一切按 edition 隔离」
//     （机器闸 allow.json 已把 listAllUsers 判为「未被消费是语义上正确的结果」）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerStageRoutes } from '../src/http/routes/stages.js';
import { createUser, deactivateUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/**
 * 组装一个「组委会能配置赛段」的世界。
 *
 * ⚠️ 人物是**判别性**的：
 *   · admin      —— 全局 `stage:compute`（组委会）
 *   · orgEdition —— **届期级** `stage:compute`（用来钉住「读口与写口口径一致」）
 *   · outsider   —— 一个能力点都没有
 *   · judgeUser  —— 角色 `judge`（专家席）      ⇒ 应在候选池里
 *   · observer   —— 角色 `observer`（观察员）    ⇒ 应在候选池里
 *   · entUser    —— 角色 `enterprise`（企业席）  ⇒ 应在候选池里
 *   · captain    —— 角色 `captain`（**参赛者**） ⇒ **不应**在候选池里
 *   · admin      —— **没有**评委类角色          ⇒ **不应**在候选池里
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-stage-cfg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  insertCapability(db, 'stage:compute', '触发计算发榜');

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900007001', password: 'pw' });
  const orgEdition = createUser(db, { name: '届期组委会', phone: '13900007002', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900007003', password: 'pw' });
  const judgeUser = createUser(db, { name: '评委甲', phone: '13900007004', password: 'pw' });
  const observer = createUser(db, { name: '观察员乙', phone: '13900007005', password: 'pw' });
  const entUser = createUser(db, { name: '企业代表丙', phone: '13900007006', password: 'pw' });
  const captain = createUser(db, { name: '队长丁', phone: '13900007007', password: 'pw' });
  // ⛔ orgStage 不授任何能力点 ⇒ 只能在测试里给他授「赛段级」权限。
  const orgStage = createUser(db, { name: '赛段组委会', phone: '13900007010', password: 'pw' });
  // ⚠️ 停用但**持有 judge 角色**的人 ⇒ 候选池必须把他排除（active = 1 过滤）。
  const staleUser = createUser(db, { name: '已停用评委', phone: '13900007009', password: 'pw' });

  for (const key of ['judge', 'enterprise', 'observer', 'captain']) insertRole(db, key, key);
  insertUserRole(db, judgeUser.id, 'judge');
  insertUserRole(db, observer.id, 'observer');
  insertUserRole(db, entUser.id, 'enterprise');
  insertUserRole(db, captain.id, 'captain');
  insertUserRole(db, staleUser.id, 'judge');
  deactivateUser(db, staleUser.id);
  // ⛔ admin **故意不给**评委类角色 ⇒ 他不该出现在候选池里。

  grantAssignment(db, {
    userId: admin.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  // ⛔ orgEdition 只有**届期级**授权 ⇒ 用来证明「读口与写端点口径一致」。
  grantAssignment(db, {
    userId: orgEdition.id, capability: 'stage:compute', scopeType: 'edition', scopeId: edition.id, grantedBy: admin.id,
  });

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: entUser.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });

  const teams = [];
  for (let i = 0; i < 2; i += 1) {
    // ⚠️ team_members.user_id 是唯一约束 ⇒ 一人只能在一支队 ⇒ 每队一个队长。
    const t = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id,
      taskPackageId: pkg.id, tier: i === 0 ? 'B' : 'C', status: 'active', now: NOW,
    });
    if (i === 0) {
      insertTeamMember(db, { teamId: t.id, userId: captain.id, role: 'captain', now: NOW });
    } else {
      const captain2 = createUser(db, { name: '队长戊', phone: '13900007008', password: 'pw' });
      insertUserRole(db, captain2.id, 'captain');
      insertTeamMember(db, { teamId: t.id, userId: captain2.id, role: 'captain', now: NOW });
    }
    teams.push(t);
  }

  const app = createApp({ db, rules, webDir });
  const wired = app.router.list().some(
    (r) => r.method === 'GET' && r.pattern === '/api/editions/:editionId/teams',
  );
  if (!wired) registerStageRoutes(app.router, { db, rules });

  return {
    db, close, app, rules, edition, teams, admin, orgEdition, outsider,
    judgeUser, observer, entUser, captain, staleUser, orgStage,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOrgEdition: createSession(db, orgEdition.id).token,
    tokenOrgStage: createSession(db, orgStage.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

/** 错误体的 code（三态状态码约定：{ error: { code, message } }）。 */
function code(res) {
  return json(res).error?.code ?? json(res).code ?? null;
}

test('⛔ E158：GET /api/editions —— 公开可读（届期是公开赛事信息，页面要知道往哪届建赛段）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', '/api/editions');
    assert.equal(res.status, 200, `届期列表应可读：${res.body}`);
    const items = json(res).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, ctx.edition.id);
    assert.equal(items[0].name, '首届 · 上海');
    assert.equal(items[0].city, '上海');
    // ⛔ 白名单投影：不得带出内部列
    assert.equal(items[0].created_at, undefined, '届期不应带出 created_at（白名单投影）');
  } finally {
    ctx.close();
  }
});

test('⛔ E158：GET /api/editions/:editionId/teams —— 组委会能看到**全部**候选队伍（participant 视角的 GET /api/teams 看不到）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/teams`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, `组委会应能读候选队伍：${res.body}`);
    const items = json(res).items;
    assert.equal(items.length, 2, '两支队伍都必须在候选池里');
    const names = items.map((t) => t.name).sort();
    assert.deepEqual(names, ['1队', '2队']);
    // ⛔ 判别性：段位要透出来（页面要显示队伍段位）
    const tiers = items.map((t) => t.tier).sort();
    assert.deepEqual(tiers, ['B', 'C']);
    // ⛔ 白名单投影：不得带出任务包 id 之类内部列
    assert.equal(items[0].task_package_id, undefined, '不得带出 task_package_id（白名单投影）');
    assert.equal(items[0].taskPackageId, undefined);
  } finally {
    ctx.close();
  }
});

test('⛔ E158：评委候选池 = 持评委类角色的人，**不是**全部用户（S2 届期隔离 + allow.json 的既有判定）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/judge-candidates`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, `组委会应能读评委候选池：${res.body}`);
    const ids = json(res).items.map((u) => u.id);

    assert.ok(ids.includes(ctx.judgeUser.id), 'judge 角色的人必须在候选池里');
    assert.ok(ids.includes(ctx.observer.id), 'observer 角色的人必须在候选池里（无投票权但可入席）');
    assert.ok(ids.includes(ctx.entUser.id), 'enterprise 角色的人必须在候选池里（企业席）');

    assert.ok(!ids.includes(ctx.captain.id), '⛔ 参赛队长（captain 角色）不该在评委候选池里');
    assert.ok(!ids.includes(ctx.admin.id), '⛔ 没有评委类角色的组委会不该出现在候选池里');
    assert.ok(!ids.includes(ctx.outsider.id), '⛔ 无关用户不该在候选池里');
    assert.ok(!ids.includes(ctx.staleUser.id), '⛔ 已停用用户（active=0）不该在候选池里');

    // ⛔ 白名单投影
    const first = json(res).items[0];
    assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'org']);
  } finally {
    ctx.close();
  }
});

test('⛔ E158：GET /api/editions/:editionId/scoring-configs —— 权重表 + 席构成约束，且不泄漏内部工作语言', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/scoring-configs`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, `组委会应能读权重表：${res.body}`);
    const items = json(res).items;
    const keys = items.map((c) => c.key).sort();
    assert.deepEqual(keys, ['final', 'initial'], '两张权重表都要给（initial / final）');

    const initial = items.find((c) => c.key === 'initial');
    assert.equal(initial.dimensions.length, 6, '初赛 6 个维度');
    const first = initial.dimensions[0];
    assert.deepEqual(Object.keys(first).sort(), ['key', 'name', 'seat', 'weight']);
    assert.equal(first.key, 'track_fit');
    assert.equal(first.name, '赛题契合度');
    assert.equal(first.weight, 0.10);
    assert.equal(first.seat, 'judge');

    // ⛔ 席构成约束：企业席 ≥30% / 专家席 ≤50% / observer 无投票权
    assert.equal(initial.judgePool.minEnterpriseSeatShare, 0.30);
    assert.equal(initial.judgePool.maxExpertSeatShare, 0.50);
    assert.equal(initial.judgePool.minJudgesPerDimension, 7);
    assert.deepEqual(initial.judgePool.nonVotingSeats, ['observer']);
    assert.ok(initial.judgePool.votingSeats.includes('enterprise'));

    // ⛔ 内部工作语言**不得**外泄（note / source / conflictRef 是内部裁决说明）
    for (const c of items) {
      assert.equal(c.note, undefined, `权重表 ${c.key} 不应带出 note（内部工作语言）`);
      assert.equal(c.source, undefined, `权重表 ${c.key} 不应带出 source（内部出处说明）`);
      assert.equal(c.conflictRef, undefined, `权重表 ${c.key} 不应带出 conflictRef`);
      assert.equal(c.trimOutliers, undefined, `权重表 ${c.key} 不应带出内部参数 trimOutliers`);
    }
  } finally {
    ctx.close();
  }
});

test('⛔ E158：三态状态码 —— 无权限 403 / 届期不存在 404（不是 200 空集，也不是 500）', async () => {
  const ctx = setup();
  try {
    // ① 无权限 ⇒ 403
    for (const path of [
      `/api/editions/${ctx.edition.id}/teams`,
      `/api/editions/${ctx.edition.id}/judge-candidates`,
      `/api/editions/${ctx.edition.id}/scoring-configs`,
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenOutsider });
      assert.equal(res.status, 403, `${path} 无权限应 403：${res.body}`);
      assert.equal(code(res), 'FORBIDDEN', `${path} 错误码应是 FORBIDDEN`);
    }

    // ② 未登录 ⇒ 401
    const anon = await call(ctx.app, 'GET', `/api/editions/${ctx.edition.id}/teams`);
    assert.equal(anon.status, 401, `未登录应 401：${anon.body}`);
    assert.equal(code(anon), 'UNAUTHENTICATED');

    // ③ 届期不存在 ⇒ 404
    for (const path of [
      '/api/editions/does-not-exist/teams',
      '/api/editions/does-not-exist/judge-candidates',
      '/api/editions/does-not-exist/scoring-configs',
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenAdmin });
      assert.equal(res.status, 404, `${path} 届期不存在应 404：${res.body}`);
      assert.equal(code(res), 'EDITION_NOT_FOUND');
    }
  } finally {
    ctx.close();
  }
});

test('⛔ E158：**届期级**授权也能读这些口（与写端点口径一致 —— 能改赛段就能看配置）', async () => {
  const ctx = setup();
  try {
    for (const path of [
      `/api/editions/${ctx.edition.id}/teams`,
      `/api/editions/${ctx.edition.id}/judge-candidates`,
      `/api/editions/${ctx.edition.id}/scoring-configs`,
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenOrgEdition });
      assert.equal(res.status, 200, `${path} 届期级授权应可读：${res.body}`);
    }
  } finally {
    ctx.close();
  }
});

test('⛔ E158：**赛段级**授权也能读这些口（写端点认赛段级，读口不许比它更严）', async () => {
  const ctx = setup();
  try {
    // ① 先经 HTTP 建一个赛段（拿 stageId）
    const created = await call(ctx.app, 'POST', `/api/editions/${ctx.edition.id}/stages`, {
      token: ctx.tokenAdmin,
      body: {
        key: 's1', name: '初赛', kind: 'initial',
        startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial',
      },
    });
    assert.equal(created.status, 200, `建赛段应成功：${created.body}`);
    const stageId = json(created).stage.id;

    // ② 给 orgStage 授**赛段级** stage:compute（他**没有**届期级授权 ⇒
    //    读口若只认届期级，他就会「能改赛段、却读不到权重表」）
    grantAssignment(ctx.db, {
      userId: ctx.orgStage.id, capability: 'stage:compute',
      scopeType: 'stage', scopeId: stageId, grantedBy: ctx.admin.id,
    });

    // ③ 赛段级授权 ⇒ 能改这个赛段（写端点本来就认）
    const patched = await call(ctx.app, 'PATCH', `/api/stages/${stageId}`, {
      token: ctx.tokenOrgStage, body: { name: '初赛（改名）' },
    });
    assert.equal(patched.status, 200, `赛段级授权应能改赛段：${patched.body}`);

    // ④ ⛔ 但**读口不许比写端点更严** —— 否则就出现「能改赛段、却读不到权重表」
    for (const path of [
      `/api/editions/${ctx.edition.id}/teams`,
      `/api/editions/${ctx.edition.id}/judge-candidates`,
      `/api/editions/${ctx.edition.id}/scoring-configs`,
    ]) {
      const res = await call(ctx.app, 'GET', path, { token: ctx.tokenOrgStage });
      assert.equal(res.status, 200, `${path} 赛段级授权应可读：${res.body}`);
    }
  } finally {
    ctx.close();
  }
});

// platform/test/stage-bootstrap-e2e.test.js —— 赛段「从零到发榜」的**端到端**闸（P11 新建）
//
// ⛔ **这个文件为什么必须存在**（本项目的病根之一，与 E149 同一型）：
//   真机生产库实测：`stages = 0, stage_team = 0, teams = 1, users = 6, editions = 1`
//   ⇒ **全新部署的平台一条赛段都没有** ⇒
//     · 评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数
//       ⇒ **一个都进不去**；
//     · `GET /api/stages` 返回 `items: []` ⇒ 前端没有任何赛段可选。
//   根因：`insertStage` / `assignStageJudge` / `registerStageTeams` **在生产上零调用方**
//   （只有测试在调）⇒ 与 E149（publish 端点）同型的**设计缺口**：
//   设计文档 §8 的 API 清单里没有创建赛段的端点，但 §9 的前端 IA 里写着「赛段配置与权重表」。
//
//   ⇒ 这个文件全部走**真实 HTTP 路由**（`call(app, method, path, …)`），
//     断言的是「HTTP 打完之后库里到底有什么」—— 这才是产品真正能观察到的结果。
//
// 规则溯源：
//   · 「赛段配置与权重表」界面 ⇒ 设计文档 §9（前端 IA）
//   · 席构成 / 利益冲突声明 ⇒ S7 §3.4（R-JDG-11 / R-JDG-18）
//   · 「计算与发榜是两个独立动作」⇒ 设计文档 §869（§6.4 决策）
//   · 三态状态码 ⇒ 设计文档 §7.3
//   · 留痕可复算 ⇒ 设计文档 §12
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
import { registerStageRoutes } from '../src/http/routes/stages.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
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

/** 评委席维度（rules/scoring-initial.json 的 seat='judge' 五维）。 */
const JUDGE_DIMS = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-stage-e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900006001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900006002', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900006003', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900006004', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability, scopeType = 'global', scopeId = null) => grantAssignment(db, {
    userId, capability, scopeType, scopeId, grantedBy: admin.id,
  });
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(judge.id, 'score:write');
  // ⛔ outsider **不授任何能力** ⇒ 他是「无权限」用例的主角。

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });

  const teams = [];
  const scores = [[90, 86], [80, 76]];
  for (let i = 0; i < 2; i += 1) {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: `1390000${6010 + i}`, password: 'pw' });
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id,
      taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    teams.push({ team, captain });
  }

  const app = createApp({ db, rules, webDir });
  // ⛔ 接线：赛段端点必须真的在**路由表**里（server.js 由集成人接线；这里先挂上，
  //    若集成人已接线则不重复挂 —— 两种情况下本文件都必须绿）。
  const wired = app.router.list().some(
    (r) => r.method === 'POST' && r.pattern === '/api/editions/:editionId/stages',
  );
  if (!wired) registerStageRoutes(app.router, { db, rules });

  return {
    db, close, dataDir, app, rules, admin, judge, outsider, enterprise, edition, teams,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

/** 经 HTTP 建赛段（返回 { res, stage }）。 */
async function createStageOverHttp(ctx, patch = {}) {
  const res = await call(ctx.app, 'POST', `/api/editions/${ctx.edition.id}/stages`, {
    token: ctx.tokenAdmin,
    body: {
      key: 's1', name: '初赛', kind: 'initial',
      startsAt: '2026-10-01', endsAt: '2026-10-10',
      scoringConfigKey: 'initial',
      ...patch,
    },
  });
  return { res, stage: res.status === 200 ? json(res).stage : null };
}

test('⛔ P11 回归闸：经 HTTP 建赛段 ⇒ 200，且 GET /api/stages 不再是空数组', async () => {
  const ctx = setup();
  try {
    // ① 建之前：前端没有任何赛段可选（真机实测的原始症状）
    const before = await call(ctx.app, 'GET', `/api/stages?editionId=${ctx.edition.id}`);
    assert.equal(before.status, 200);
    assert.equal(json(before).items.length, 0, '建之前当然没有赛段（这是真机的原始症状）');

    // ② 经 **HTTP 路由**建赛段
    const { res, stage } = await createStageOverHttp(ctx);
    assert.equal(res.status, 200, `建赛段应成功：${res.body}`);
    assert.ok(stage?.id, '响应里必须含 stage.id');
    assert.equal(stage.editionId, ctx.edition.id);
    assert.equal(stage.scoringConfigKey, 'initial');

    // ③ 库里真的有一行
    const rows = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').all(stage.id);
    assert.equal(rows.length, 1, '赛段必须真的落库');

    // ④ 建完之后：前端**有**赛段可选了 —— 这一条直接对应真机症状
    const after = await call(ctx.app, 'GET', `/api/stages?editionId=${ctx.edition.id}`);
    assert.equal(after.status, 200);
    const items = json(after).items;
    assert.equal(items.length, 1, '建完之后赛段列表必须非空（此前恒为空 ⇒ 前端无赛段可选）');
    assert.equal(items[0].id, stage.id);

    // ⑤ 留痕
    const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stage.create'").get().n;
    assert.equal(audit, 1, '建赛段必须留痕（§12）');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：经 HTTP 派评委 ⇒ 席位与**利益冲突声明**都真的落库（R-JDG-18）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);

    const res = await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    assert.equal(res.status, 200, `派评委应成功：${res.body}`);

    const seat = ctx.db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?')
      .get(stage.id, ctx.judge.id);
    assert.ok(seat, 'stage_judges 必须有一行');
    assert.equal(seat.seat, 'judge');

    // ⚠️ 声明回填：席位行必须指向一条真的声明（否则「评委须签署声明」在产品上静默失效）
    assert.ok(seat.conflict_declaration_id, '席位行必须回填声明 id');
    const decl = ctx.db.prepare('SELECT * FROM conflict_declarations WHERE id = ?').get(seat.conflict_declaration_id);
    assert.ok(decl, '声明必须落在 conflict_declarations 表里');
    assert.equal(decl.judge_id, ctx.judge.id);
    assert.equal(decl.stage_id, stage.id);

    const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stage.judge.assign'").get().n;
    assert.equal(audit, 1, '派评委必须留痕');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：经 HTTP 报名册 ⇒ stage_team 有行；**重复登记不报错**（幂等）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    const teamIds = ctx.teams.map((t) => t.team.id);

    const first = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds },
    });
    assert.equal(first.status, 200, `报名册应成功：${first.body}`);
    assert.equal(json(first).registered, 2);

    const rows = ctx.db.prepare('SELECT * FROM stage_team WHERE stage_id = ?').all(stage.id);
    assert.equal(rows.length, 2, '名册必须真的落库');

    // ⛔ 幂等：重复登记**不报错**（赛段开启时批量登记是流程性动作，重跑不该打断流程）
    const second = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds },
    });
    assert.equal(second.status, 200, `重复报名册必须幂等（不报错）：${second.body}`);
    assert.equal(json(second).registered, 0);
    assert.equal(json(second).skipped, 2);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      2, '重复登记不得让名册行翻倍',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：建了赛段+名册+评委后，**评审端点真的能收评分**（不是 404/403）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds: ctx.teams.map((t) => t.team.id) },
    });

    const res = await call(ctx.app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token: ctx.tokenJudge,
      body: { items: ctx.teams.map((t, i) => ({ teamId: t.team.id, dimension: 'track_fit', rawScore: 90 - i * 10 })) },
    });
    assert.equal(res.status, 200, `评分应被接受：${res.body}`);

    const n = ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_reviews WHERE stage_id = ?').get(stage.id).n;
    assert.equal(n, 2, '评分必须真的落库');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ P11 回归闸：建了赛段+名册后，**计算 + 发榜真的能跑通**（五张表都有数据）', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds: ctx.teams.map((t) => t.team.id) },
    });

    // 评分（评委席五维，两队分数拉开 ⇒ 名次可判别）
    const items = [];
    ctx.teams.forEach((t, i) => {
      for (const dim of JUDGE_DIMS) {
        items.push({ teamId: t.team.id, dimension: dim, rawScore: 90 - i * 10 });
      }
    });
    const submitted = await call(ctx.app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token: ctx.tokenJudge, body: { items },
    });
    assert.equal(submitted.status, 200, `评分应成功：${submitted.body}`);

    // ① 计算（计算与发榜是两个独立动作）
    const computed = await call(ctx.app, 'POST', `/api/stages/${stage.id}/compute`, { token: ctx.tokenAdmin });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    // ② 发榜
    const published = await call(ctx.app, 'POST', `/api/stages/${stage.id}/publish`, { token: ctx.tokenAdmin });
    assert.equal(published.status, 200, `发榜应成功：${published.body}`);

    // ③ 五张表都必须有数据（这五样正是「赛段真能跑起来」的证据）
    const count = (sql, ...params) => ctx.db.prepare(sql).get(...params).n;
    assert.ok(count('SELECT COUNT(*) AS n FROM stage_results WHERE stage_id = ?', stage.id) > 0,
      'stage_results 必须有行（赛段分数没算出来）');
    assert.ok(count('SELECT COUNT(*) AS n FROM computation_snapshots WHERE stage_id = ?', stage.id) > 0,
      'computation_snapshots 必须有行（计算没有留快照 ⇒ 不可复算）');
    assert.ok(count("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'") > 0,
      'points_ledger 必须有行（名次积分未发放 ⇒ 个人榜恒为空）');
    assert.ok(count('SELECT COUNT(*) AS n FROM tier_records WHERE deleted_at IS NULL') > 0,
      'tier_records 必须有行（段位永远兜底 D 段 ⇒ 段位权益永不解锁）');
    assert.ok(count('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE stage_id = ?', stage.id) > 0,
      'leaderboard_snapshots 必须有行（没有发榜快照 ⇒ 赛后复盘没有权威口径）');

    // ④ 判别性：个人积分榜不是空的
    const personal = await call(ctx.app, 'GET', `/api/leaderboard/${stage.id}?scope=personal`);
    assert.equal(personal.status, 200);
    assert.ok(json(personal).rows.length > 0, '发榜后个人积分榜必须有行');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 三态状态码：赛段不存在 → 404；无权限 → 403；未登录 → 401；成功 → 200', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);

    // ① 不存在 → 404
    const missing = await call(ctx.app, 'PATCH', '/api/stages/st_nope', {
      token: ctx.tokenAdmin, body: { name: 'x' },
    });
    assert.equal(missing.status, 404, '赛段不存在 → 404');
    assert.equal(json(missing).error.code, 'STAGE_NOT_FOUND');

    const missingJudges = await call(ctx.app, 'POST', '/api/stages/st_nope/judges', {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    assert.equal(missingJudges.status, 404, '赛段不存在 → 404');
    const missingTeams = await call(ctx.app, 'POST', '/api/stages/st_nope/teams', {
      token: ctx.tokenAdmin, body: { teamIds: [ctx.teams[0].team.id] },
    });
    assert.equal(missingTeams.status, 404, '赛段不存在 → 404');
    const missingEdition = await call(ctx.app, 'POST', '/api/editions/ed_nope/stages', {
      token: ctx.tokenAdmin, body: { key: 'x1', name: 'x', kind: 'initial', startsAt: '2026-10-01', endsAt: '2026-10-02', scoringConfigKey: 'initial' },
    });
    assert.equal(missingEdition.status, 404, '届期不存在 → 404');
    assert.equal(json(missingEdition).error.code, 'EDITION_NOT_FOUND');

    // ② 无权限 → 403
    const forbidden = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, {
      token: ctx.tokenOutsider, body: { name: 'x' },
    });
    assert.equal(forbidden.status, 403, '没有 stage:compute 的人不能改赛段');
    assert.equal(json(forbidden).error.code, 'FORBIDDEN');

    const forbiddenCreate = await call(ctx.app, 'POST', `/api/editions/${ctx.edition.id}/stages`, {
      token: ctx.tokenOutsider,
      body: { key: 'x2', name: 'x', kind: 'initial', startsAt: '2026-10-01', endsAt: '2026-10-02', scoringConfigKey: 'initial' },
    });
    assert.equal(forbiddenCreate.status, 403, '没有 stage:compute 的人不能建赛段');

    const forbiddenJudge = await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenOutsider, body: { userId: ctx.judge.id, seat: 'judge' },
    });
    assert.equal(forbiddenJudge.status, 403, '没有 stage:compute 的人不能派评委');

    const forbiddenTeams = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenOutsider, body: { teamIds: [ctx.teams[0].team.id] },
    });
    assert.equal(forbiddenTeams.status, 403, '没有 stage:compute 的人不能报名册');

    // ③ 未登录 → 401
    const anon = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, { body: { name: 'x' } });
    assert.equal(anon.status, 401, '未登录 → 401');

    // ④ 成功 → 200
    const ok = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, {
      token: ctx.tokenAdmin, body: { name: '初赛（改名）' },
    });
    assert.equal(ok.status, 200, `成功应 200：${ok.body}`);
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 逆向路径：撤评委 → 退名册 → 再次报名册能成功；改赛段配置生效', async () => {
  const ctx = setup();
  try {
    const { stage } = await createStageOverHttp(ctx);
    const teamIds = ctx.teams.map((t) => t.team.id);

    await call(ctx.app, 'POST', `/api/stages/${stage.id}/judges`, {
      token: ctx.tokenAdmin, body: { userId: ctx.judge.id, seat: 'judge' },
    });

    // ① 撤评委
    const removedJudge = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/judges/${ctx.judge.id}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(removedJudge.status, 200, `撤评委应成功：${removedJudge.body}`);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_judges WHERE stage_id = ?').get(stage.id).n,
      0, '席位必须真的被撤掉',
    );
    // 撤一个没派过的 ⇒ 404（幂等友好但不静默）
    const again = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/judges/${ctx.judge.id}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(again.status, 404, '撤一个没派过的评委 → 404');
    assert.equal(json(again).error.code, 'JUDGE_NOT_ASSIGNED');

    // ② 退一个**不在册**的队伍 ⇒ 404（名册此刻还是空的，先试这一档）
    const notInRoster = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/teams/${teamIds[0]}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(notInRoster.status, 404, '退一个不在册的队伍 → 404');
    assert.equal(json(notInRoster).error.code, 'TEAM_NOT_IN_ROSTER');

    // ③ 报名册 → 退名册 → 再报名册 ⇒ 能成功（逆向前后可来回）
    const registered = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds },
    });
    assert.equal(registered.status, 200, `报名册应成功：${registered.body}`);

    const removedTeam = await call(ctx.app, 'DELETE', `/api/stages/${stage.id}/teams/${teamIds[0]}`, {
      token: ctx.tokenAdmin,
    });
    assert.equal(removedTeam.status, 200, `退名册应成功：${removedTeam.body}`);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      1, '退名册后名册必须少一支',
    );

    const reRegister = await call(ctx.app, 'POST', `/api/stages/${stage.id}/teams`, {
      token: ctx.tokenAdmin, body: { teamIds: [teamIds[0]] },
    });
    assert.equal(reRegister.status, 200, `再次报名册必须能成功：${reRegister.body}`);
    assert.equal(json(reRegister).registered, 1);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      2, '再次报名册后名册必须恢复',
    );

    // ④ 改赛段配置生效
    const patched = await call(ctx.app, 'PATCH', `/api/stages/${stage.id}`, {
      token: ctx.tokenAdmin, body: { name: '初赛·延长期', endsAt: '2026-10-20' },
    });
    assert.equal(patched.status, 200, `改配置应成功：${patched.body}`);
    assert.equal(json(patched).stage.name, '初赛·延长期');
    const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
    assert.equal(row.name, '初赛·延长期', '改名必须真的落库');
    assert.equal(row.ends_at, '2026-10-20', '改结束时间必须真的落库');
    assert.equal(row.starts_at, '2026-10-01', '没传的字段不得被改动');

    // ④ 逆向前后都留了痕
    const actions = ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY rowid").all(stage.id).map((r) => r.action);
    assert.ok(actions.includes('stage.create'), '建段要留痕');
    assert.ok(actions.includes('stage.judge.assign'), '派评委要留痕');
    assert.ok(actions.includes('stage.judge.remove'), '撤评委要留痕');
    assert.ok(actions.includes('stage.roster.register'), '报名册要留痕');
    assert.ok(actions.includes('stage.roster.remove'), '退名册要留痕');
    assert.ok(actions.includes('stage.update'), '改配置要留痕');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 路由表里必须有这六条端点（缺一条 ⇒ §9 的「赛段配置与权重表」界面没有 API 可用）', async () => {
  const ctx = setup();
  try {
    const routes = ctx.app.router.list();
    const expected = [
      ['POST', '/api/editions/:editionId/stages'],
      ['PATCH', '/api/stages/:stageId'],
      ['POST', '/api/stages/:stageId/judges'],
      ['DELETE', '/api/stages/:stageId/judges/:userId'],
      ['POST', '/api/stages/:stageId/teams'],
      ['DELETE', '/api/stages/:stageId/teams/:teamId'],
    ];
    for (const [method, pattern] of expected) {
      assert.ok(
        routes.some((r) => r.method === method && r.pattern === pattern),
        `路由表里必须有 ${method} ${pattern}（实际：${JSON.stringify(routes.map((r) => `${r.method} ${r.pattern}`))}）`,
      );
    }
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

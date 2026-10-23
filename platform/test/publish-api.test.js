// platform/test/publish-api.test.js —— 发榜端点的**端到端**闸（P11 · E149）
//
// ⛔ **这个文件为什么必须存在**（本项目的病根之一）：
//   P0–P10 的大量闸是「**服务层单测**」—— 直接调 `publishLeaderboard(...)`，
//   25 处引用全绿 ⇒ 看上去「发榜做完了」。
//   但**路由表里没有任何一条路能触达它**（设计文档 §8 的 API 清单漏了 publish 这一条）。
//   ⇒ 「服务层写了、路由没挂」一路绿灯，直到真机跑起来才发现：
//     名次积分从未发放、段位永远 D 段、榜单快照为空、发榜没有留痕。
//   ⇒ 这个文件全部走**真实 HTTP 路由**（`call(app, method, path, …)`），
//     断言的是「HTTP 打完之后库里到底有什么」—— 这才是产品真正能观察到的结果。
//
// 规则溯源：
//   - 「计算与发榜是两个独立动作，发榜必须有操作者与时间戳」→ 设计文档 §869（§6.4 决策）
//   - 「名次积分 10/8/5，MVP 4 赛段总积分 + 路演评审综合」→ 任务书 §七 + rules/points.json
//   - 「段位来自里程碑 + 未撤回签字，发榜时重算」→ 设计文档 §6.5（P3-15）
//   - 「三态状态码」→ 设计文档 §7.3
//   - 「TOP10 名单事后电话回访」→ S7 §4.1（R-JDG-16）
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
import { insertReview } from '../src/db/repo/reviews.js';
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
  ['behavior:write', '提交行为分记录'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pubapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900001001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900001002', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900001003', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900001004', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900001005', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability, scopeType = 'global', scopeId = null) => grantAssignment(db, {
    userId, capability, scopeType, scopeId, grantedBy: admin.id,
  });
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  // 三支队伍：分数刻意拉开（甲最高、乙次之、丙最低）⇒ 名次与积分可判别
  const teams = [];
  const scores = [[90, 86], [80, 76], [70, 66]];
  const caps = ['13900001010', '13900001020', '13900001030'];
  scores.forEach((pair, i) => {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: caps[i], password: 'pw' });
    const member = createUser(db, { name: `组员${i + 1}`, phone: `1380000${1010 + i}`, password: 'pw' });
    grant(captain.id, 'behavior:write');
    grant(member.id, 'behavior:write');
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    insertTeamMember(db, { teamId: team.id, userId: member.id, role: 'member', now: NOW });
    for (const [j, dim] of JUDGE_DIMS.entries()) {
      insertReview(db, {
        stageId: stage.id, judgeId: judge.id, teamId: team.id, dimension: dim,
        rawScore: pair[j % 2], requestId: `r-${i}-${j}`, calibrated: 0, now: NOW,
      });
    }
    teams.push({ team, captain, member });
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, admin, judge, outsider, enterprise, stage, edition, teams,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

test('⛔ E149 回归闸：POST /api/stages/:stageId/publish 经 HTTP 路由后，四样东西必须真的写进库', async () => {
  const ctx = setup();
  try {
    // ① 先算（计算与发榜是两个独立动作）
    const compute = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    assert.equal(compute.status, 200, `计算应成功：${compute.body}`);

    // ② 发榜（此前**根本没有这条路由**）
    const publish = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    assert.equal(publish.status, 200, `发榜应成功：${publish.body}`);

    const snaps = ctx.db.prepare('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE stage_id = ?').get(ctx.stage.id).n;
    assert.equal(snaps, 3, 'rank / business / personal 三份榜单快照都要写');

    const ledger = ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
    assert.ok(ledger > 0, '名次积分必须写进流水（此前恒为 0 ⇒ 个人榜恒为空）');

    const tiers = ctx.db.prepare('SELECT COUNT(*) AS n FROM tier_records WHERE deleted_at IS NULL').get().n;
    assert.ok(tiers > 0, '段位记录必须写（此前恒为 0 ⇒ 段位永远 D 段 ⇒ 段位权益永不解锁）');

    const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'leaderboard.publish'").get().n;
    assert.equal(audit, 1, '发榜必须留痕（操作者 + 时间戳）');

    // ③ 判别性：个人榜必须真的有行（发榜前恒为空）
    const personal = await call(ctx.app, 'GET', `/api/leaderboard/${ctx.stage.id}?scope=personal`);
    assert.equal(personal.status, 200);
    const rows = json(personal).rows;
    assert.ok(rows.length > 0, '发榜后个人积分榜必须有行（此前恒为空 ⇒ 奖金无依据）');
    assert.ok(rows.every((r) => r.total > 0), '每个人的名次积分都要大于 0');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 发榜页的读口：GET /api/stages/:stageId/publish 能回答「发过榜没有」+「TOP 回访清单」', async () => {
  const ctx = setup();
  try {
    const before = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    assert.equal(before.status, 200);
    const b = json(before);
    assert.equal(b.published, false, '没发过榜就不能说发过');
    assert.equal(b.reverseAuditTasks.length, 0, '没发榜就没有 TOP 回访清单');
    assert.ok(b.warnings.some((w) => w.code === 'STAGE_NOT_PUBLISHED'), '未发榜要显式告警，不静默');

    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });

    const after = json(await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin }));
    assert.equal(after.published, true);
    assert.equal(after.snapshots.length, 3);
    assert.ok(after.publishedAt, '发榜时间必须给出来（操作者 + 时间戳）');
    assert.ok(after.reverseAuditTasks.length > 0, 'R-JDG-16：TOP 名单回访清单必须产出');
    assert.equal(after.reverseAuditTasks[0].action, 'alert_only', '只告警、不代劳、不自动结案');
    assert.ok(after.reverseAuditTasks[0].instruction, '回访任务必须带指令文案');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 发榜的权限闸：无 stage:compute → 403；未登录 → 401；赛段不存在 → 404', async () => {
  const ctx = setup();
  try {
    const noPerm = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenOutsider });
    assert.equal(noPerm.status, 403, '没有 stage:compute 的人不能发榜');
    assert.equal(json(noPerm).error.code, 'FORBIDDEN');

    const anon = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`);
    assert.equal(anon.status, 401, '未登录 → 401');

    const missing = await call(ctx.app, 'POST', '/api/stages/st_nope/publish', { token: ctx.tokenAdmin });
    assert.equal(missing.status, 404, '赛段不存在 → 404');
    assert.equal(json(missing).error.code, 'STAGE_NOT_FOUND');

    // 读口同口径
    assert.equal((await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenOutsider })).status, 403);
    assert.equal((await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/publish`)).status, 401);
    assert.equal((await call(ctx.app, 'GET', '/api/stages/st_nope/publish', { token: ctx.tokenAdmin })).status, 404);
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 赛段级授权也能发榜（前后端口径一致：路由认赛段级，服务层也认）', async () => {
  const ctx = setup();
  try {
    // 给评委甲一个**赛段级**的 stage:compute（不是全局）
    grantAssignment(ctx.db, {
      userId: ctx.judge.id, capability: 'stage:compute', scopeType: 'stage', scopeId: ctx.stage.id, grantedBy: ctx.admin.id,
    });
    const token = createSession(ctx.db, ctx.judge.id).token;
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token });
    assert.equal(res.status, 200, `赛段级授权应当能发榜：${res.body}`);
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 重发榜的幂等：名次没变 ⇒ 积分流水**不新增行**（不重复发分）', async () => {
  const ctx = setup();
  try {
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    const n1 = ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
    assert.ok(n1 > 0);

    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });
    const n2 = ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
    assert.equal(n2, n1, '重复发榜不得重复发分');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 重发榜的**逆向路径**：名次变了 ⇒ 走「差额更正」写新记录（只增不改），个人榜跟着改', async () => {
  const ctx = setup();
  try {
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });

    const personalBefore = json(await call(ctx.app, 'GET', `/api/leaderboard/${ctx.stage.id}?scope=personal`)).rows;
    const totalBefore = personalBefore.reduce((s, r) => s + r.total, 0);
    assert.ok(totalBefore > 0);
    // 判别基线：3 支队同属一个任务包 ⇒ 名次积分 10 / 8 / 5，每人一份
    const capOf = (i) => ctx.teams[i].captain.id;
    const before = new Map(personalBefore.map((r) => [r.userId, r.total]));
    assert.equal(before.get(capOf(2)), 5, '第 3 名（丙队）原本拿 5 分');
    assert.equal(before.get(capOf(0)), 10, '第 1 名（甲队）原本拿 10 分');

    // 制造名次变化：把 3 队的总分顶到最高（模拟「组委会改了数据后重算重发」）
    ctx.db.prepare('UPDATE stage_results SET total = 999 WHERE team_id = ?').run(ctx.teams[2].team.id);
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/publish`, { token: ctx.tokenAdmin });

    // ① 差额以**新记录**写进流水（原记录不动 ⇒ 仍满足「只增不改」）
    const rows = ctx.db.prepare("SELECT points FROM points_ledger WHERE kind = 'stage_rank' ORDER BY created_at, rowid").all();
    const hasNegative = rows.some((r) => r.points < 0);
    assert.ok(hasNegative, '名次变化必须写一条差额更正记录（不是覆盖原记录）');

    // ② 同一个人的累计积分 = 10/8/5 口径下的**新名次**积分，不是旧名次的
    //    ⚠️ 判别点不是「总分变了」（名次置换时总分恒定 = 10+8+5），
    //       而是**分布变了**：被顶到第 1 的那支队从 5 分变成 10 分。
    const personalAfter = json(await call(ctx.app, 'GET', `/api/leaderboard/${ctx.stage.id}?scope=personal`)).rows;
    const after = new Map(personalAfter.map((r) => [r.userId, r.total]));
    assert.equal(after.get(capOf(2)), 10, '丙队被顶到第 1 ⇒ 队长积分必须从 5 变成 10');
    assert.equal(after.get(capOf(0)), 8, '甲队掉到第 2 ⇒ 队长积分必须从 10 变成 8');
    const totalAfter = personalAfter.reduce((s, r) => s + r.total, 0);
    assert.equal(totalAfter, totalBefore, '名次置换 ⇒ 团队总分恒定（10+8+5），个人积分不得凭空多出或少掉');

    // ③ 判别性：不能出现「同一个人既拿旧分又拿新分」的重复计分
    const leader = ctx.db.prepare("SELECT team_id, user_id, SUM(points) AS total FROM points_ledger WHERE kind = 'stage_rank' GROUP BY team_id, user_id").all();
    for (const r of leader) {
      assert.ok(r.total >= 0, '任何人的名次积分累计都不得为负（差额更正后仍应是有效分值）');
    }
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

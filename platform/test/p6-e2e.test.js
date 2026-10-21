// platform/test/p6-e2e.test.js —— P6 Task 8：端到端验收（收官用例）
//
// ⚠️ 本文件**不产出功能，它证明功能**。
//    P0–P6 每个 Task 都有自己的一组用例；这一组回答的是两个收官问题：
//      ① 「前面这些拼在一起能不能跑通」
//         —— 报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API
//      ② 「每一段是不是真的在干活」
//         —— 每一步都有**判别性断言**（不是「跑完不报错」）
//
// 两条轨道（都走**真实实现**，一步都不 mock）：
//   A. 演示线：web/api.demo.js 的 createDemoApi({ storage, seed, rules })
//      —— 浏览器里跑的那条线。⛔ Node 侧**必须**用 createDemoApi：
//      默认导出的 api 包装走 fetch('./seed/…')，Node 里不认相对 URL。
//   B. 正式线：createApp + 真实 SQLite + 真实路由 + 真实规则引擎（src/domain/** 原样调用）
//      —— 部署到云主机后跑的那条线。
//
// 溯源需求（逐条标在用例上）：
//   R-OPS-13/14：任务清单工作流拆解 / 禁止岗位制
//              —— 「任务完成 ≠ 赛段交付物得分」这条不变量
//   R-OPS-06  ：公网可访问 —— 本文件能验的是**演示线的引擎真的在跑**；
//              「公网 URL 能不能打开」要等真机发布（P6-12），**本轮未覆盖**
//   R-OPS-01/02/07：零依赖 / 可移植 / 跨平台稳定 —— 见 test/portability.test.js
//
// ⚠️ 诚实性声明（不要在别处引用本文件时夸大它）：
//   本文件**没有**在 Linux / Windows 上跑过（本机是 macOS darwin arm64）；
//   也**没有**真机发布过公网演示站。两件事都不是本文件能自动验收的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createPublicToken } from '../src/services/public-api.js';
import { publishLeaderboard } from '../src/services/leaderboard.js';
import { createDemoApi } from '../web/api.demo.js';
import { call, callJson } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');
const webDir = join(platformDir, 'web');
const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(rulesDir);

// ── 工具 ────────────────────────────────────────────────────────

/** 内存版 localStorage（浏览器里那份的真等价物：跨调用持久，重启进程即丢）。 */
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/**
 * 报名问卷：三维各 5 题（1–5）+ 一道开放式题 + 合规同意记录。
 * ⚠️ `consent` 不是可选项：正式服务按 R-ENT-12「未明确同意不收」硬拦
 *    （少它就是 400 CONSENT_REQUIRED）—— 演示适配器目前不查这一条（差异见台账 D8-4）。
 */
function answers(direction, capability, collaboration, open = '演示报名：把门店缺货预测做成可落地的试点。') {
  return { direction, capability, collaboration, open, consent: { accepted: true } };
}

const STRONG = answers([5, 4, 5, 5, 4], [4, 4, 5, 5, 5], [5, 5, 4, 5, 5]);
const WEAK = answers([1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], '弱画像报名：还没想清楚要解决什么商业问题。');

// ═══════════════════════════════════════════════════════════════════════
// 轨道 A：演示线（createDemoApi + 真实规则引擎 + 真实种子）
// ═══════════════════════════════════════════════════════════════════════

test('演示线全链路：报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API', async () => {
  const api = createDemoApi({ storage: makeStorage(), seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });

  // ── 1. 报名 ────────────────────────────────────────────────────
  const reg = await api.post('/api/registrations', { answers: STRONG });
  assert.ok(['S', 'A', 'B'].includes(reg.level), `报名等级应为 S/A/B，实际 ${reg.level}`);
  assert.ok(reg.explain.length > 0, '报名必须给出可解释明细');
  assert.equal(reg.explain.length, 3, '三维各给一条可解释明细');
  assert.equal(reg.status, 'accepted', 'S/A/B 级必须被接收');
  assert.ok(reg.rawScore > 0, '报名必须算出总分');

  // 判别性A1：同一套规则换成低分作答 ⇒ 降到 C 段且**不接收**（不是恒真的「都接受」）
  const weak = await api.post('/api/registrations', { answers: WEAK });
  assert.equal(weak.level, 'C', '低分作答必须降到 C 段');
  assert.equal(weak.status, 'rejected', 'C 段不接收（R-REG-08）');
  assert.ok(weak.rawScore < reg.rawScore, '低分作答的总分必须低于高分作答');

  // 判别性A2：报名真的进了列表（写路径通到读路径）
  const regList = await api.get('/api/registrations');
  assert.equal(regList.rows.length, 2, '两条报名都应进列表');
  assert.ok(regList.rows.some((r) => r.id === reg.id));
  assert.ok(regList.rows.some((r) => r.id === weak.id));

  // ── 2. 组队 ────────────────────────────────────────────────────
  const team = await api.post('/api/teams', {
    name: '验收队', taskPackageId: 'tp_manu', captainId: 'mba_captain',
    memberIds: ['mba_captain', 'demo_member_1'],
  });
  assert.ok(team.id);
  assert.equal(team.formation.ok, true, `组队必须成立：${JSON.stringify(team.formation.errors)}`);
  assert.deepEqual(team.memberIds, ['mba_captain', 'demo_member_1']);
  assert.equal(team.packageId ?? team.taskPackageId, 'tp_manu');

  // 判别性A3：1 人组队必须被拒（人数下限是真在跑的）
  await assert.rejects(
    () => api.post('/api/teams', {
      name: '单人队', taskPackageId: 'tp_manu', captainId: 'mba_captain', memberIds: ['mba_captain'],
    }),
    (err) => err.status === 400 && err.code === 'TEAM_FORMATION_INVALID',
    '1 人组队必须被拒（team-formation.json 的 teamSize.min = 2）',
  );
  // 判别性A4：组长必须是一堂 MBA 在籍（硬门槛）
  await assert.rejects(
    () => api.post('/api/teams', {
      name: '非 MBA 队', taskPackageId: 'tp_manu', captainId: 'demo_member_1',
      memberIds: ['demo_member_1', 'demo_member_2'],
    }),
    (err) => err.status === 400 && err.code === 'TEAM_FORMATION_INVALID',
    '组长不是 MBA 在籍必须被拒（captainMustBeMba）',
  );
  // 判别性A5：被拒的组队**没有**混进名册
  const teamsAfter = api._state().teams;
  assert.equal(teamsAfter.length, seed.teams.length + 1, '只有成立的验收队进了名册（失败的两次没进）');

  // ── 3. 打分 ────────────────────────────────────────────────────
  const rsBefore = await api.get('/api/stages/stage_final/review-state');

  // 3a. 给**新建的验收队**打一条（全新的一格：评委 × 队 × 维度）
  const reviewNew = await api.post('/api/stages/stage_final/reviews', {
    items: [{ judgeId: 'j_mid1', teamId: team.id, dimension: 'completeness', rawScore: 80 }],
  });
  assert.equal(reviewNew.submitted, 1);
  assert.equal(reviewNew.stageId, 'stage_final');

  // 判别性A6：这一条真的进了「已提交」统计
  const rsAfter = await api.get('/api/stages/stage_final/review-state');
  assert.equal(rsAfter.submitted, rsBefore.submitted + 1, '提交的分数必须计入 review-state');
  assert.equal(
    rsAfter.dimensionProgress.j_mid1, rsBefore.dimensionProgress.j_mid1 + 1,
    '该评委的已提交数必须 +1',
  );

  // 3b. 给**已有的格子**改分（覆盖，不是累加）
  const reviewOverwrite = await api.post('/api/stages/stage_final/reviews', {
    items: [{ judgeId: 'j_mid1', teamId: 't_gamma', dimension: 'completeness', rawScore: 88 }],
  });
  assert.equal(reviewOverwrite.submitted, 1);
  const rsAgain = await api.get('/api/stages/stage_final/review-state');
  assert.equal(rsAgain.submitted, rsAfter.submitted, '同一评委同一队同一维度重复打分必须覆盖，不能累加');
  assert.equal(rsAgain.dimensionProgress.j_mid1, rsAfter.dimensionProgress.j_mid1, '覆盖不增加已提交数');

  // ── 4. 计算 ────────────────────────────────────────────────────
  const computed = await api.post('/api/stages/stage_final/compute', {});
  assert.ok(computed.computationId);
  assert.equal(computed.teams.length, seed.teams.length + 1, '名册里的每支队都要进计算（含刚建的验收队）');
  assert.ok(computed.trace && computed.trace.normalization, '计算必须留下归一化 trace');

  // 判别性A7：原始分真的进了引擎 —— 同一份种子，只改 t_gamma 的一个原始分，总分必须变
  const baseline = await (async () => {
    const fresh = createDemoApi({ storage: makeStorage(), seed, rules });
    await fresh.post('/api/auth/login', { name: '演示管理员' });
    await fresh.post('/api/teams', {
      name: '验收队', taskPackageId: 'tp_manu', captainId: 'mba_captain',
      memberIds: ['mba_captain', 'demo_member_1'],
    });
    await fresh.post('/api/stages/stage_final/reviews', {
      items: [{ judgeId: 'j_mid1', teamId: 'team_demo_1', dimension: 'completeness', rawScore: 80 }],
    });
    return fresh.post('/api/stages/stage_final/compute', {});
  })();
  const gammaNow = computed.teams.find((t) => t.teamId === 't_gamma');
  const gammaBase = baseline.teams.find((t) => t.teamId === 't_gamma');
  assert.notEqual(gammaNow.total, gammaBase.total, '改了原始分，引擎算出的总分必须跟着变（否则打分没接进引擎）');

  // 判别性A8：同分两队仍然严格相等（破同分链之前的原始分口径没被改坏）
  const [tieA, tieB] = seed.expectations.tiedTeams;
  assert.equal(
    computed.teams.find((t) => t.teamId === tieA).total,
    computed.teams.find((t) => t.teamId === tieB).total,
    '种子声明的同分两队必须仍然严格相等',
  );

  // ── 5. 发榜 ────────────────────────────────────────────────────
  const lb = await api.get('/api/leaderboard/stage_final?scope=rank');
  assert.equal(lb.rows.length, seed.teams.length + 1, '榜单覆盖名册里的每支队');
  assert.equal(lb.rows[0].rank, 1, '第一名是 rank 1');
  const totals = lb.rows.map((r) => r.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), '榜单按总分从高到低排');

  // 判别性A9：企业名不公示（rank 榜全员公开，但企业名不在公开字段里）
  assert.ok(lb.rows.every((r) => !('enterpriseName' in r)), '榜单行里不得出现 enterpriseName 字段');
  const lbText = JSON.stringify(lb);
  for (const pkg of seed.taskPackages) {
    if (!pkg.enterpriseName) continue;
    assert.equal(lbText.includes(pkg.enterpriseName), false, `企业名「${pkg.enterpriseName}」不得出现在榜单里`);
  }

  // ── 6. 段位 ────────────────────────────────────────────────────
  const tier = await api.get('/api/teams/t_delta/tier');
  assert.equal(tier.tier, 'S', 't_delta 有 5 项里程碑 + 业务部门签字 → S 段');
  assert.equal(tier.businessSignoffCount, 1, '业务部门签字数必须是 1');
  assert.equal(tier.milestoneCount, 5, 't_delta 达成 5 项里程碑');

  // 判别性A10：段位榜里 D 段队伍不公示（C-02：C 段及以上公示名次，D 段只给本人进度卡）
  const tierBoard = await api.get('/api/leaderboard/tier');
  const tierIds = tierBoard.rows.map((r) => r.teamId);
  assert.ok(tierIds.includes('t_alpha'), 'B 段队伍必须出现在段位榜');
  assert.equal(tierIds.includes('t_epsilon'), false, 'D 段队伍不公示');
  assert.equal(tierBoard.rows.some((r) => r.teamName === '自由花队'), false, 'D 段队名不得出现在段位榜');

  // ── 7. 战绩卡 ──────────────────────────────────────────────────
  const card = await api.get('/api/teams/t_delta/performance-card');
  assert.equal(card.items.length, rules.milestones.items.length, '战绩卡覆盖全部 7 类里程碑');
  assert.equal(card.achievedCount, 5, 't_delta 达成 5 项里程碑');
  assert.equal(card.tier, 'S', '战绩卡上的段位与段位接口一致');

  // 判别性A11：卡里只有部门，**没有签字人**（S10 §0.3「B 榜签字人不公开」）
  assert.deepEqual(
    Object.keys(card.items[0]).sort(),
    ['achieved', 'confirmedBy', 'countsTowardTier', 'key', 'label', 'revoked', 'signed', 'signedByDepartment'],
    '战绩卡条目的字段是白名单：加一个签字人字段即视为泄露',
  );
  assert.equal(
    card.items.some((i) => Object.keys(i).some((k) => /signator|signer|person|name/i.test(k))),
    false,
    '战绩卡条目里不得有「签字人」字段',
  );
  const businessSigned = card.items.find((i) => i.signedByDepartment);
  assert.ok(businessSigned, '已签字的里程碑必须给出签字部门');
  assert.equal(businessSigned.signedByDepartment, '业务部', '签字部门来自签字记录本身');

  // ── 8. 三池 ────────────────────────────────────────────────────
  const projects = await api.get('/api/pools/projects');
  const talents = await api.get('/api/pools/talents');
  const resources = await api.get('/api/pools/resources');
  assert.ok(projects.rows.length > 0, '项目池不能是空的');
  assert.ok(talents.rows.length > 0, '人才池不能是空的');
  assert.ok(resources.rows.length > 0, '资源池不能是空的');

  // 判别性A12：三池的行数与名册/种子对得上（不是随便塞几行）
  assert.equal(projects.rows.length, seed.teams.length + 1, '项目池每支队一行');
  assert.equal(talents.rows.length, seed.users.length, '人才池覆盖每一个队员');
  assert.equal(resources.rows.length, seed.taskPackages.length, '资源池覆盖每一张任务包');

  // 判别性A13：人才池的积分来自**本轮计算的名次积分**（不是常量 0）
  assert.ok(
    talents.rows.some((r) => r.total_points > 0),
    '人才池必须有人拿到名次积分（算分没接进三池就会全 0）',
  );
  // 判别性A14：项目池的段位与段位接口同源
  const projectTiers = new Map(projects.rows.map((r) => [r.teamId, r.tier]));
  assert.equal(projectTiers.get('t_delta'), 'S', '项目池里 t_delta 的段位是 S');
  assert.equal(projectTiers.get('t_epsilon'), 'D', '项目池里 t_epsilon 的段位是 D');

  // ── 9. 公开 API ────────────────────────────────────────────────
  const pub = await api.get('/api/public/leaderboard?editionId=ed_demo&token=demo');
  assert.ok(pub.rows.length > 0, '公开榜不能是空的');
  assert.deepEqual(
    pub.rows.map((r) => r.teamId), lb.rows.map((r) => r.teamId),
    '公开榜与内部榜是同一份数据（口径不能分叉）',
  );
  assert.ok(pub.rows.every((r) => !('enterpriseName' in r)), '公开榜行里不得出现 enterpriseName 字段');

  // 判别性A15：公开榜**必须**要 token（没有 token 一律拒绝）
  // ⚠️ 只断言「拒绝」这条不变式，不断言具体状态码：演示适配器目前回 401，
  //    而正式服务按契约回 403 PUBLIC_TOKEN_MISSING（差异登记在 P6 Task 8 台账 D8-3）。
  await assert.rejects(
    () => api.get('/api/public/leaderboard?editionId=ed_demo'),
    (err) => err.status === 401 || err.status === 403,
    '公开榜没有 token 必须被拒',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 轨道 B：正式服务（createApp + 真实 SQLite + 真实路由 + 真实规则引擎）
// ═══════════════════════════════════════════════════════════════════════

const CAPABILITIES = [
  ['registration:write', '提交报名'],
  ['team:create', '创建战队'],
  ['team:read', '读取战队'],
  ['task_package:read', '读取任务卡'],
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['self_review:write', '提交本队自评'],
  ['signoff:create', '企业里程碑签字'],
  ['behavior:write', '提交行为分记录'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['pool:read', '读取三池'],
  ['pool:write', '维护三池'],
];

/** 评委席 5 人 + 企业席 5 人 = 10 席（judgePool 段：≥9 席 / 企业席 ≥30% / 专家席 ≤50%）。 */
const JUDGE_SEATS = [
  ...Array.from({ length: 5 }, (_, i) => ({ id: `j${i + 1}`, name: `评委${i + 1}`, seat: 'judge' })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `e${i + 1}`, name: `企业席${i + 1}`, seat: 'enterprise' })),
];
const JUDGE_DIMS = ['innovation', 'feasibility', 'completeness', 'collaboration'];

function setupServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p6e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules: R } = loadRules(rulesDir);

  for (const [key, desc] of CAPABILITIES) insertCapability(db, key, desc);

  // ── 用户（走真实写入方 createUser）──
  const admin = createUser(db, { name: '组委会', phone: '13900000001', password: 'pw-admin', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);
  const captain = createUser(db, { name: '队长甲', phone: '13900000002', password: 'pw-cap', mbaStatus: 'mba' });
  const member = createUser(db, { name: '组员乙', phone: '13900000003', password: 'pw-mem', mbaStatus: 'mba' });
  const weakUser = createUser(db, { name: '落选丙', phone: '13900000005', password: 'pw-weak', mbaStatus: 'mba' });
  const enterprise = createUser(db, {
    name: '签字人丁', phone: '13900000004', password: 'pw-ent', mbaStatus: 'other', org: '某银行',
  });
  // 评委席 5 人 + 企业席 5 人（judgePool 段：≥9 席 / 企业席 ≥30% / 专家席 ≤50%）
  const judges = JUDGE_SEATS.map((spec, i) => {
    const u = createUser(db, {
      name: spec.name, phone: `139000001${String(i).padStart(2, '0')}`, password: 'pw-judge', mbaStatus: 'mba',
    });
    return { id: u.id, name: spec.name, seat: spec.seat };
  });

  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global',
  });
  for (const cap of ['registration:write', 'team:create', 'team:read', 'task_package:read', 'self_review:write', 'behavior:write', 'pool:read']) {
    grant(captain.id, cap);
    grant(member.id, cap);
  }
  grant(weakUser.id, 'registration:write');
  grant(weakUser.id, 'team:create');
  for (const cap of ['score:write', 'score:read']) {
    grant(enterprise.id, cap);
    for (const j of judges) grant(j.id, cap);
  }
  grant(enterprise.id, 'signoff:create');

  // ── 届期 / 任务包 / 赛段 / 评委名单 ──
  db.exec(`
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届 · 杭州', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', '${enterprise.id}', '某银行', '零售风控助手', '人工审批慢', '可演示原型',
      '能跑', 'A', 'approved', 11, 'A', '试点承诺', '试点承诺书', 0, '${enterprise.id}',
      '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '决赛', 'final', '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z',
      'final', 'open');
  `);
  const seat = db.prepare(
    'INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at) VALUES (?,?,?,?,?,?)',
  );
  for (const j of judges) {
    seat.run('st_1', j.id, j.seat, 'global', null, '2026-10-01T00:00:00.000Z');
  }

  const app = createApp({ db, rules: R, webDir });
  return {
    db,
    close,
    dataDir,
    app,
    rules: R,
    users: { admin, captain, member, weakUser, enterprise, judges },
    tokens: {
      admin: createSession(db, admin.id).token,
      captain: createSession(db, captain.id).token,
      member: createSession(db, member.id).token,
      weak: createSession(db, weakUser.id).token,
      enterprise: createSession(db, enterprise.id).token,
    },
  };
}

function teardown(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

test('正式服务全链路：报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API', async () => {
  const s = setupServer();
  const { db, app, tokens, users } = s;
  try {
    // ── 1. 报名（HTTP）──
    const regRes = await callJson(app, 'POST', '/api/registrations', {
      token: tokens.captain, body: { editionId: 'ed_1', answers: STRONG },
    });
    assert.equal(regRes.status, 200, regRes.text);
    assert.ok(['S', 'A', 'B'].includes(regRes.json.level), `报名等级应为 S/A/B，实际 ${regRes.json.level}`);
    // ⚠️ 形状：正式服务把可解释明细放在 `grading.explain`（presentRegistration 的口径），
    //    演示适配器放在顶层 `explain` —— 两者不一致（差异登记在 P6 Task 8 台账 D8-5）。
    assert.ok(regRes.json.grading.explain.length > 0, '报名必须给出可解释明细');
    // ⚠️ 正式服务的报名状态是 'submitted'（待组委会分级），「是否接收」由 grading.accepted 表达；
    //    演示适配器把 status 直接写成 'accepted' / 'rejected' —— 语义不一致（台账 D8-5）。
    assert.equal(regRes.json.status, 'submitted');
    assert.equal(regRes.json.grading.accepted, true, 'S/A/B 级必须被接收');

    // 组员也报一份（他后面要加入队伍）
    const memReg = await callJson(app, 'POST', '/api/registrations', {
      token: tokens.member, body: { editionId: 'ed_1', answers: STRONG },
    });
    assert.equal(memReg.status, 200, memReg.text);
    assert.equal(memReg.json.grading.accepted, true, '组员也要被接收');

    // 判别性B1：低分作答 ⇒ C 段 ⇒ 报名**不被接收**（不是恒真的「都接受」）
    const weakRes = await callJson(app, 'POST', '/api/registrations', {
      token: tokens.weak, body: { editionId: 'ed_1', answers: WEAK },
    });
    assert.equal(weakRes.status, 200, weakRes.text);
    assert.equal(weakRes.json.level, 'C', '低分作答必须降到 C 段');
    assert.equal(weakRes.json.grading.accepted, false, 'C 段不接收（R-REG-08）');

    // 判别性B2：组队必须被「报名未接收」拦住（写路径真的在看报名状态）
    const blocked = await callJson(app, 'POST', '/api/teams', {
      token: tokens.weak,
      body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: 'C 级队' },
    });
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(blocked.json.error.code, 'REGISTRATION_NOT_ACCEPTED');

    // ── 2. 组队（HTTP）──
    const teamRes = await callJson(app, 'POST', '/api/teams', {
      token: tokens.captain, body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '验收一队' },
    });
    assert.equal(teamRes.status, 200, teamRes.text);
    const teamId = teamRes.json.id;
    assert.ok(teamId);
    assert.equal(teamRes.json.memberCount, 1);
    assert.equal(teamRes.json.formation.ok, false, '只有队长一人时组队校验必须不通过（人数下限 2）');

    // 组员自己加入（⛔ 加入只能是自己加入 —— 路由层已锁死）
    const joinRes = await callJson(app, 'POST', `/api/teams/${teamId}/members`, {
      token: tokens.member, body: { action: 'add' },
    });
    assert.equal(joinRes.status, 200, joinRes.text);
    assert.equal(joinRes.json.memberCount, 2);
    assert.equal(joinRes.json.formation.ok, true, `两人队必须成立：${JSON.stringify(joinRes.json.formation.errors)}`);
    assert.equal(joinRes.json.status, 'active', '人数达标后战队成立');

    // 判别性B3：替别人加入必须无效（⛔ 加入只能是自己加入；body.userId 不作数）
    const hijack = await callJson(app, 'POST', `/api/teams/${teamId}/members`, {
      token: tokens.captain, body: { action: 'add', userId: users.enterprise.id },
    });
    assert.equal(hijack.status, 409, hijack.text);
    assert.equal(hijack.json.error.code, 'ALREADY_IN_TEAM', '队长自己已在队里，不能借 body.userId 拉别人进队');
    const teamView = await callJson(app, 'GET', `/api/teams/${teamId}`, { token: tokens.admin });
    assert.equal(teamView.status, 200, teamView.text);
    assert.equal(teamView.json.memberCount, 2, '成员数仍是 2（替别人加入没生效）');
    assert.equal(
      teamView.json.members.some((m) => m.userId === users.enterprise.id), false,
      '被「拉」的人不在队里（加入只能是自己加入）',
    );

    // ── 3. 打分（HTTP）──
    // 专家席 5 人 × 4 个评委席维度（真实写入 stage_reviews）
    // ⚠️ 为什么是 5 人：scoring-final.json 的 minSamplesForJudgeNormalization = 5、
    //    minJudgesForTrim = 5 —— 少于 5 个样本就会走归一化降级，测的就不是主路径了。
    const judge = users.judges[0];
    for (let k = 0; k < 5; k += 1) {
      const j = users.judges[k];
      const judgeRes = await callJson(app, 'POST', '/api/stages/st_1/reviews', {
        token: createSession(db, j.id).token,
        body: {
          items: JUDGE_DIMS.map((dimension, i) => ({
            teamId, dimension, rawScore: 70 + i * 3 + k,
          })),
        },
      });
      assert.equal(judgeRes.status, 200, judgeRes.text);
      assert.equal(judgeRes.json.submitted, 4, '四条打分必须全部入库');
    }
    // 判别性：评审进度里能看到 5 位评委各交了 4 条（写路径真的落到 stage_reviews）
    const stateRes = await callJson(app, 'GET', '/api/stages/st_1/review-state', { token: tokens.admin });
    assert.equal(stateRes.status, 200, stateRes.text);
    assert.equal(stateRes.json.submitted, 20, '5 位评委 × 4 个维度 = 20 条打分');

    // 判别性B4：评委不能给「自评测」维度打分（自评席专属）
    const selfDim = await callJson(app, 'POST', '/api/stages/st_1/reviews', {
      token: createSession(db, judge.id).token,
      body: { items: [{ teamId, dimension: 'self_eval', rawScore: 100 }] },
    });
    assert.equal(selfDim.status, 403, selfDim.text);
    assert.equal(selfDim.json.error.code, 'DIMENSION_SEAT_FORBIDDEN');

    // 企业席双签确认（企业项 25% 权重；缺双签按 R2 记 0 分）
    const confRes = await callJson(app, 'POST', '/api/stages/st_1/enterprise-confirmations', {
      token: tokens.enterprise,
      body: {
        enterpriseId: users.enterprise.id, teamId, dimension: 'enterprise', rawScore: 80,
        crossJudgeId: users.judges[5].id, content: '解决审批排队环节，两周内试点，我方出接口',
      },
    });
    assert.equal(confRes.status, 200, confRes.text);

    // ── 4. 计算（HTTP）──
    const computeRes = await callJson(app, 'POST', '/api/stages/st_1/compute', {
      token: tokens.admin, body: {},
    });
    assert.equal(computeRes.status, 200, computeRes.text);
    assert.ok(computeRes.json.computationId, '计算必须产出快照 id');
    assert.equal(computeRes.json.teams.length, 1, '只有打了 P 席分的队伍进结果');
    assert.ok(computeRes.json.trace && computeRes.json.trace.normalization, '计算必须留下归一化 trace');
    assert.ok(computeRes.json.trace.judgePool, '计算快照必须带上评委池合规信息');
    // 判别性：企业席的双签确认真的进了引擎（E 席有分；缺双签会按 R2 记 0）
    assert.ok(computeRes.json.teams[0].seatE > 0, '企业席必须有分（双签确认没进引擎就会是 0）');
    // 判别性B5：评委池合规（10 席 / 企业席 50% / 专家席 50%）—— 不合规会告警
    assert.equal(computeRes.json.trace.judgePool.ok, true, '评委池必须合规');
    assert.equal(
      computeRes.json.warnings.some((w) => w.code === 'judge_pool_invalid'), false,
      '评委池合规时不得出现 judge_pool_invalid 告警',
    );
    // 判别性B6：企业席双签成立 ⇒ 不得出现 R2 告警
    assert.equal(
      computeRes.json.warnings.some((w) => w.code === 'R2_missing_dual_signature'), false,
      '双签齐全时不得出现 R2_missing_dual_signature 告警',
    );

    // ── 5. 发榜 ──
    // ⚠️ publishLeaderboard **没有 HTTP 路由**（src/server.js 里只挂了读接口），
    //    「发榜」= 写快照 + 发名次积分 + 重算段位，只有服务层这一条路。
    //    这里直接调**真实服务层**（不是 mock）—— 路由缺口登记在 P6 Task 8 台账 G-1。
    const publish = publishLeaderboard({
      db, editionId: 'ed_1', stageId: 'st_1', actorId: users.admin.id,
      now: '2026-10-20T00:00:00.000Z', rules: s.rules,
    });
    assert.ok(publish.snapshots.rank, '发榜必须写 A 榜快照');
    assert.ok(publish.awarded.stage.length > 0, '发榜必须发放名次积分');

    // 判别性B7：发榜幂等 —— 再发一次不重复发积分（points_ledger 行数不变）
    const ledgerCount = () => db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n;
    const beforeRepublish = ledgerCount();
    publishLeaderboard({
      db, editionId: 'ed_1', stageId: 'st_1', actorId: users.admin.id,
      now: '2026-10-20T00:00:01.000Z', rules: s.rules,
    });
    assert.equal(ledgerCount(), beforeRepublish, '重复发榜不得重复写积分流水（幂等）');

    // ── 6. 榜单（HTTP）──
    const lbRes = await callJson(app, 'GET', '/api/leaderboard/st_1?scope=rank');
    assert.equal(lbRes.status, 200, lbRes.text);
    assert.equal(lbRes.json.rows.length, 1);
    assert.equal(lbRes.json.rows[0].teamId, teamId);
    assert.equal(lbRes.json.rows[0].rank, 1);
    assert.ok(lbRes.json.rows[0].total > 0, '总分必须大于 0');
    // 判别性B8：榜单里没有企业名
    assert.equal(lbRes.text.includes('某银行'), false, '企业名不公示');
    assert.equal('enterpriseName' in lbRes.json.rows[0], false, '榜单行里不得出现 enterpriseName 字段');

    // ── 7. 段位（HTTP）──
    // 5 项里程碑签字（S 段要 5 项 + 业务部门签字）—— 企业通过真实签字接口签
    const milestoneRows = db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY key').all(teamId);
    assert.equal(milestoneRows.length, 7, '组队时固定的里程碑清单是 7 类');
    for (const m of milestoneRows.slice(0, 5)) {
      const signRes = await callJson(app, 'POST', `/api/milestones/${m.id}/signoff`, {
        token: tokens.enterprise,
        body: { department: '业务部', content: `已确认「${m.label}」落地，我方业务部门签字` },
      });
      assert.equal(signRes.status, 200, signRes.text);
    }
    // 段位记录是**发榜时**重算的 ⇒ 再发一次榜让段位落库
    publishLeaderboard({
      db, editionId: 'ed_1', stageId: 'st_1', actorId: users.admin.id,
      now: '2026-10-20T00:00:02.000Z', rules: s.rules,
    });
    const tierRes = await callJson(app, 'GET', `/api/teams/${teamId}/tier`);
    assert.equal(tierRes.status, 200, tierRes.text);
    assert.equal(tierRes.json.tier, 'S', `5 项里程碑 + 业务部门签字 ⇒ S 段（实际 ${tierRes.json.tier}）`);
    assert.equal(tierRes.json.progress.milestoneCount, 5);

    // 判别性B9：段位接口对 D 段队伍「单条不满足 ⇒ 404」（不泄露别人的 D 段进度）
    const dTier = db.prepare("SELECT * FROM tier_records WHERE team_id = ? ORDER BY computed_at DESC").all(teamId)[0];
    assert.ok(dTier, '必须落一条段位记录');
    db.prepare("UPDATE tier_records SET tier = 'D', milestone_count = 0, business_signoff_count = 0 WHERE id = ?")
      .run(dTier.id);
    const dRes = await callJson(app, 'GET', `/api/teams/${teamId}/tier`);
    assert.equal(dRes.status, 404, 'D 段队伍对非成员必须 404（不公示）');
    const dSelf = await callJson(app, 'GET', `/api/teams/${teamId}/tier`, { token: tokens.captain });
    assert.equal(dSelf.status, 200, '本人看自己的 D 段进度卡必须 200');
    assert.equal(dSelf.json.self, true, '本人拿到的必须是「本人进度卡」而不是公示口径');
    // 复原：再发一次榜，段位按「5 项里程碑 + 业务部门签字」重算回 S 段
    publishLeaderboard({
      db, editionId: 'ed_1', stageId: 'st_1', actorId: users.admin.id,
      now: '2026-10-20T00:00:04.000Z', rules: s.rules,
    });

    // ── 8. 战绩卡（HTTP）──
    const cardRes = await callJson(app, 'GET', `/api/teams/${teamId}/performance-card`, { token: tokens.admin });
    assert.equal(cardRes.status, 200, cardRes.text);
    assert.equal(cardRes.json.items.length, 7, '战绩卡覆盖全部 7 类里程碑');
    assert.equal(cardRes.json.achievedCount, 5, '已签字的 5 项里程碑必须算达成');
    // 判别性B10：战绩卡只有「达成/已签」，**没有签字人**
    assert.deepEqual(
      Object.keys(cardRes.json.items[0]).sort(),
      ['achieved', 'key', 'label', 'signed'],
      '战绩卡条目的字段是白名单：不得出现签字人',
    );
    assert.equal(cardRes.text.includes('签字人丁'), false, '签字人不得出现在战绩卡里');

    // ── 9. 三池（HTTP）──
    const syncRes = await callJson(app, 'POST', '/api/pools/sync', {
      token: tokens.admin, body: { editionId: 'ed_1' },
    });
    assert.equal(syncRes.status, 200, syncRes.text);
    // ⚠️ 同步接口返回的是**同步摘要**（{inserted, updated, removed, total}），不是行数组
    assert.ok(syncRes.json.projects.total > 0, '同步后项目池必须有派生的行');
    assert.ok(syncRes.json.talents.total > 0, '同步后人才池必须有派生的行');
    assert.ok(syncRes.json.resources.total > 0, '同步后资源池必须有派生的行');

    const projRes = await callJson(app, 'GET', '/api/pools/projects?editionId=ed_1', { token: tokens.admin });
    const talRes = await callJson(app, 'GET', '/api/pools/talents?editionId=ed_1', { token: tokens.admin });
    const resRes = await callJson(app, 'GET', '/api/pools/resources?editionId=ed_1', { token: tokens.admin });
    assert.equal(projRes.status, 200, projRes.text);
    assert.ok(projRes.json.projects.length > 0, '项目池不能是空的');
    assert.ok(talRes.json.talents.length > 0, '人才池不能是空的');
    assert.ok(resRes.json.resources.length > 0, '资源池不能是空的');
    // 判别性B11：三池同步是幂等的（再同步一次行数不变）
    const projectsBefore = projRes.json.projects.length;
    await callJson(app, 'POST', '/api/pools/sync', { token: tokens.admin, body: { editionId: 'ed_1' } });
    const projAgain = await callJson(app, 'GET', '/api/pools/projects?editionId=ed_1', { token: tokens.admin });
    assert.equal(projAgain.json.projects.length, projectsBefore, '三池同步必须幂等');
    // 判别性B12：人才池的积分来自名次积分流水（不是常量 0）
    assert.ok(talRes.json.talents.some((t) => t.totalPoints > 0), '人才池必须有人拿到名次积分');

    // ── 10. 公开 API（HTTP）──
    const publicToken = createPublicToken({
      db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z',
      now: '2026-10-20T00:00:00.000Z',
    }).token;
    const pubRes = await callJson(app, 'GET', `/api/public/leaderboard?token=${publicToken}&editionId=ed_1`);
    assert.equal(pubRes.status, 200, pubRes.text);
    assert.equal(pubRes.json.stages.length, 1);
    assert.equal(pubRes.json.stages[0].rows.length, 1, 'S 段队伍必须进公开榜');
    assert.equal(pubRes.json.stages[0].rows[0].teamName, '验收一队');
    // 判别性B13：公开响应里没有企业名、没有签字人、没有 D 段队伍
    assert.equal(pubRes.text.includes('某银行'), false, '企业名不公示');
    assert.equal(pubRes.text.includes('签字人丁'), false, '签字人不公开');
    assert.deepEqual(
      Object.keys(pubRes.json.stages[0].rows[0]).sort(),
      ['points', 'rank', 'teamName', 'tier', 'tiedWith', 'total'].sort(),
      '公开行是字段白名单',
    );

    // 判别性B14：无 token ⇒ 403 PUBLIC_TOKEN_MISSING（公开接口不是登录接口）
    const noToken = await callJson(app, 'GET', '/api/public/leaderboard?editionId=ed_1');
    assert.equal(noToken.status, 403, noToken.text);
    assert.equal(noToken.json.error.code, 'PUBLIC_TOKEN_MISSING');
    // 判别性B15：无效 token ⇒ 403 PUBLIC_TOKEN_INVALID
    const badToken = await callJson(app, 'GET', '/api/public/leaderboard?token=not-a-token&editionId=ed_1');
    assert.equal(badToken.status, 403, badToken.text);
    assert.equal(badToken.json.error.code, 'PUBLIC_TOKEN_INVALID');
  } finally {
    teardown(s);
  }
});

test('R-OPS-13/14：任务完成 ≠ 赛段交付物得分（完成一个任务不写积分流水）', async () => {
  const s = setupServer();
  const { db, app, tokens, users } = s;
  try {
    // 报名 → 组队（真实写路径）：任务清单要有归属，队长才在「认领了该任务包的队」里
    const reg = await callJson(app, 'POST', '/api/registrations', {
      token: tokens.captain, body: { editionId: 'ed_1', answers: STRONG },
    });
    assert.equal(reg.status, 200, reg.text);
    const teamRes = await callJson(app, 'POST', '/api/teams', {
      token: tokens.captain, body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '任务验收队' },
    });
    assert.equal(teamRes.status, 200, teamRes.text);
    const teamId = teamRes.json.id;

    // 工作流 → 任务清单（真实写路径：R-OPS-13「任务包 → 工作流 → 任务清单」）
    const wfRes = await callJson(app, 'POST', '/api/workflows', {
      token: tokens.captain, body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '验收工作流' },
    });
    assert.equal(wfRes.status, 200, wfRes.text);
    const wfId = wfRes.json.workflow.id;
    const taskRes = await callJson(app, 'POST', `/api/workflows/${wfId}/tasks`, {
      token: tokens.captain, body: { title: '把风控原型跑通', detail: '端到端跑一遍' },
    });
    assert.equal(taskRes.status, 200, taskRes.text);
    const taskId = taskRes.json.task.id;

    // 任务清单可见
    const listRes = await callJson(app, 'GET', `/api/workflows/${wfId}/tasks`, { token: tokens.captain });
    assert.equal(listRes.status, 200, listRes.text);
    assert.equal(listRes.json.tasks.length, 1);
    assert.equal(listRes.json.tasks[0].status, 'todo');
    assert.equal(listRes.json.tasks[0].claim, null, '还没人领取');

    // 自主领取（R-OPS-13/14 的核心动作）
    const claim = await callJson(app, 'POST', `/api/tasks/${taskId}/claim`, { token: tokens.captain, body: {} });
    assert.equal(claim.status, 200, claim.text);
    assert.equal(claim.json.task.status, 'in_progress');

    // 判别性B16：完成必须带「可运行产物 + 版本」证据（纯文字进度说明不给分，R-STG-04）
    const noEvidence = await callJson(app, 'POST', `/api/tasks/${taskId}/complete`, {
      token: tokens.captain, body: { evidence: { kind: 'runnable', summary: '做完了' } },
    });
    assert.equal(noEvidence.status, 400, noEvidence.text);
    assert.equal(noEvidence.json.error.code, 'EVIDENCE_REQUIRED');

    const ledgerCount = () => db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n;
    const before = ledgerCount();
    const done = await callJson(app, 'POST', `/api/tasks/${taskId}/complete`, {
      token: tokens.captain,
      body: {
        evidence: {
          kind: 'runnable', summary: '原型已跑通', artifactUrl: 'https://example.com/hks', version: 'v0.1.0',
        },
      },
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.task.status, 'done');

    // 判别性B17：任务完成**不写**积分流水（赛段交付物得分只由计算/发榜产生）
    assert.equal(ledgerCount(), before, '完成一个任务不得写 points_ledger（任务完成 ≠ 赛段交付物得分）');

    // 判别性B18：禁止岗位制 —— 不得存在任何「按岗位/身份派活」的接口
    const assignLike = s.app.router.list().filter((r) => /assign|dispatch|allocate|appoint/i.test(r.pattern));
    assert.deepEqual(assignLike, [], '不得存在按岗位/身份分配任务的接口（R-OPS-14 禁止岗位制）');

    // 对照：真发一次榜，积分流水才会增加 —— 证明上面那条不是「流水表根本没长」
    db.prepare(
      `INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('sr_x', 'st_1', teamId, 1, 90, 88, 95, 0, 10, null, '2026-10-20T00:00:00.000Z');
    publishLeaderboard({
      db, editionId: 'ed_1', stageId: 'st_1', actorId: users.admin.id,
      now: '2026-10-20T00:00:03.000Z', rules: s.rules,
    });
    assert.ok(ledgerCount() > before, '发榜后积分流水必须增加（对照：流水表不是死的）');
  } finally {
    teardown(s);
  }
});

test('正式服务的路由清单覆盖 INTERFACES.md §2–§6 里约定的全部 API', () => {
  const s = setupServer();
  try {
    const routes = s.app.router.list();
    // INTERFACES.md §2–§6 里约定的 API（路径里的 :param 统一成 :*）
    const expected = [
      'POST /api/registrations',
      'GET /api/registrations',
      'POST /api/teams',
      'GET /api/teams/*',
      'POST /api/task-packages',
      'GET /api/task-packages',
      'POST /api/stages/*/reviews',
      'GET /api/stages/*/review-state',
      'POST /api/stages/*/compute',
      'GET /api/stages/*/computations/*',
      'GET /api/leaderboard/*',
      'GET /api/leaderboard/rolling',
      'GET /api/teams/*/performance-card',
      'GET /api/teams/*/tier',
      'GET /api/audit/computations/*',
      'GET /api/audit/log',
      'GET /api/workflows/*/tasks',
      'POST /api/tasks/*/claim',
      'GET /api/pools/projects',
      'GET /api/pools/talents',
      'GET /api/pools/resources',
      'GET /api/public/leaderboard',
    ];
    const norm = (s2) => s2.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '*');
    const actual = new Set(routes.map((r) => `${r.method} ${norm(r.pattern)}`));
    const missing = expected.filter((e) => !actual.has(e));
    assert.deepEqual(missing, [], `正式服务缺少这些路由：${missing.join('、')}`);
  } finally {
    teardown(s);
  }
});

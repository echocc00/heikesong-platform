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
import { createSession } from '../src/auth/session.js';
import { getLeaderboard, publishLeaderboard } from '../src/services/leaderboard.js';
import { computeTeamTier, getTeamTier } from '../src/services/tier.js';
import { getLatestTierRecord } from '../src/db/repo/tiers.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-20T00:00:00.000Z';

function seed(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会管理员','13800000000','x','mba',NULL,1,1,'${NOW}'),
           ('u_cap','A队队长','13800000001','x','mba',NULL,0,1,'${NOW}'),
           ('u_b','B队队长','13800000002','x','mba',NULL,0,1,'${NOW}'),
           ('u_obs','观察员','13800000003','x','other',NULL,0,1,'${NOW}'),
           ('u_d','D队队员','13800000004','x','other',NULL,0,1,'${NOW}'),
           ('u_c','C队队长','13800000005','x','mba',NULL,0,1,'${NOW}'),
           ('u_j1','跨领域评委','13800000006','x','mba',NULL,0,1,'${NOW}');
    -- ⚠️ 结束日推到 2099：让「当届」解析（pickCurrentEdition 取尚未结束的最早一届）
    --    与真实日期无关 —— 否则这条用例会随日历过期而红。
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','${NOW}');
    INSERT INTO cities (id, name, edition_id) VALUES ('c_1','上海','ed_1');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at)
    VALUES ('tp_1','ed_1','e_1','某某公司','任务一','痛点一','交付物一','验收一','A','approved',10,'A','试点承诺','承诺书',0,'u_cap','${NOW}'),
           ('tp_2','ed_1','e_2','乙公司','任务二','痛点二','交付物二','验收二','A','approved',10,'A','试点承诺','承诺书',0,'u_cap','${NOW}');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
    VALUES ('t_a','ed_1','A队','u_cap','tp_1','A','active','${NOW}'),
           ('t_b','ed_1','B队','u_b','tp_1','A','active','${NOW}'),
           ('t_c','ed_1','C队','u_c','tp_2','C','active','${NOW}'),
           ('t_d','ed_1','D队','u_cap','tp_2','D','active','${NOW}');
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES ('tm_1','t_a','u_cap','captain','${NOW}'), ('tm_2','t_d','u_d','captain','${NOW}'),
           ('tm_3','t_b','u_b','captain','${NOW}'), ('tm_4','t_c','u_c','captain','${NOW}');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed'),
           ('st_2','ed_1','S2','空赛段','initial','2026-10-10','2026-10-13','2026-10-14','initial','closed'),
           ('st_r','ed_1','S4','路演','roadshow','2026-10-26','2026-10-28','2026-10-29','initial','closed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1','st_1','t_a',1,90,88,95,0,10,NULL,'${NOW}'),
           ('sr_2','st_1','t_b',2,90,90,85,1,8,NULL,'${NOW}'),
           ('sr_3','st_1','t_c',3,70,70,0,0,5,NULL,'${NOW}'),
           ('sr_4','st_1','t_d',4,60,60,0,0,0,NULL,'${NOW}');
    INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
    VALUES ('pr_1','st_1','t_b','t_a',9,'rq_1','${NOW}'),
           ('pr_2','st_1','t_a','t_b',3,'rq_2','${NOW}');
    INSERT INTO enterprise_confirmations (id, stage_id, team_id, enterprise_id, dimension, raw_score,
      cross_judge_id, signatory_user_id, created_at, deleted_at)
    VALUES ('ec_1','st_1','t_a','u_cap','enterprise',80,'u_j1','u_cap','${NOW}',NULL),
           ('ec_2','st_1','t_b','u_cap','enterprise',60,'u_j1','u_cap','${NOW}',NULL);
    INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version,
      input_json, output_json, trace_json, revision, created_at)
    VALUES ('cs_1','stage_score','ed_1','st_1',NULL,'scoring-initial@2026-10-20','{}',
      '{"warnings":[{"code":"judge_sample_too_small","message":"本轮该维度未做评委宽严归一化（样本不足 5）"}]}','{}',1,'${NOW}');
    INSERT INTO milestones (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at)
    VALUES ('ms_1','t_a',NULL,'problem_confirmed','企业问题确认',1,'${NOW}',1,'${NOW}'),
           ('ms_2','t_a',NULL,'data_connected','真实数据接入',1,'${NOW}',1,'${NOW}'),
           ('ms_3','t_a',NULL,'demo_ready','可演示原型',1,'${NOW}',1,'${NOW}'),
           ('ms_4','t_c',NULL,'problem_confirmed','企业问题确认',1,'${NOW}',1,'${NOW}');
    INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
    VALUES ('sg_1','ms_1','e_1','u_cap','业务部门','解决库存周转环节','${NOW}',NULL),
           ('sg_2','ms_2','e_1','u_cap','技术部门','接口已打通','${NOW}',NULL);
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1','t_a','A',3,1,'["milestones=3"]','${NOW}',NULL),
           ('tr_2','t_c','C',1,1,'["milestones=1"]','${NOW}',NULL),
           ('tr_3','t_d','D',0,0,'["milestones=0"]','${NOW}',NULL);
  `);
  // 行为分事件（★ 独立通路的数据源）
  db.prepare('INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('be_1', 't_b', 'u_cap', 'weekly_progress', 2, JSON.stringify({ repo: 'git@x', version: 'v1', artifact: 'demo.zip' }), NOW);
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p3-svc-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  seed(db);
  const { rules } = loadRules(join(here, '..', 'rules'));
  const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
  return { db, close, dataDir, rules, app };
}

function call(app, method, path, { cookie = null } = {}) {
  return new Promise((resolve) => {
    const req = {
      method, url: path, headers: cookie ? { cookie } : {},
      async *[Symbol.asyncIterator]() {},
      on() {},
    };
    const res = {
      statusCode: 200, headers: {}, body: '',
      writeHead(s, h) { this.statusCode = s; this.headers = h || {}; },
      end(p) { if (p) this.body = p.toString(); resolve({ status: this.statusCode, body: this.body }); },
    };
    app.handle(req, res);
  });
}
const sessionCookie = (db, userId) => `hk_session=${createSession(db, userId, { ttlDays: 7, now: new Date(NOW) }).token}`;

test('★ GET /api/leaderboard/:stageId?scope=rank 返回 A 榜并把 P2 的降级告警带上来', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/st_1?scope=rank');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.scope, 'rank');
  assert.deepEqual(data.rows.map((r) => r.teamId), ['t_a', 't_b', 't_c', 't_d']);
  assert.equal(data.rows[0].rank, 1);
  assert.ok(data.warnings.length > 0);
  // ⚠️ E184：公开响应里**不再下发内部规则键** ⇒ 按人话正文认这条告警
  assert.ok(
    data.warnings.some((w) => w.message === '本轮该维度未做评委宽严归一化（样本不足 5）'),
    '降级告警必须显式带上来',
  );
  assert.ok(!res.body.includes('judge_sample_too_small'), '公开响应里不得出现内部规则键');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ B 榜响应体不含评分与签字人；名次积分按任务包内排名发放', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/st_1?scope=business');
  assert.equal(res.status, 200);
  const row = JSON.parse(res.body).rows.find((r) => r.teamId === 't_a');
  assert.equal(row.milestones.length, 3);
  assert.equal(row.milestones[0].achieved, true);
  for (const k of ['signatory', 'signatoryUserId', 'score', 'seatE', 'enterpriseName']) {
    assert.equal(row[k], undefined, `${k} 不应出现在 B 榜`);
  }
  assert.ok(!res.body.includes('A队队长'), '响应体不得出现签字人姓名');

  const rank = JSON.parse((await call(app, 'GET', '/api/leaderboard/st_1?scope=rank')).body);
  const byId = Object.fromEntries(rank.rows.map((r) => [r.teamId, r]));
  assert.equal(byId.t_a.points, 10);   // tp_1 内第 1 席
  assert.equal(byId.t_b.points, 8);    // tp_1 内第 2 席
  assert.equal(byId.t_c.points, 10);   // tp_2 内第 1 席
  assert.equal(byId.t_d.points, 8);    // tp_2 内第 2 席
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 三态：列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403；非法 scope → 400', async () => {
  const { db, close, dataDir, rules, app } = setup();
  const empty = await call(app, 'GET', '/api/leaderboard/st_2?scope=rank');
  assert.equal(empty.status, 200);
  assert.deepEqual(JSON.parse(empty.body).rows, []);
  assert.equal((await call(app, 'GET', '/api/leaderboard/st_nope?scope=rank')).status, 404);
  assert.equal((await call(app, 'GET', '/api/leaderboard/st_1?scope=whatever')).status, 400);

  const broken = structuredClone(rules);
  broken.visibility.rank.public = false;
  const app2 = createApp({ db, rules: broken, webDir: join(here, '..', 'web') });
  assert.equal((await call(app2, 'GET', '/api/leaderboard/st_1?scope=rank')).status, 403);

  // B 榜被关闭同样 403（不是 404 —— 是「规则禁用」不是「不存在」）
  const brokenBiz = structuredClone(rules);
  brokenBiz.visibility.business.milestoneProgressPublic = false;
  const app3 = createApp({ db, rules: brokenBiz, webDir: join(here, '..', 'web') });
  assert.equal((await call(app3, 'GET', '/api/leaderboard/st_1?scope=business')).status, 403,
    'B 榜关闭 → 403');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/leaderboard/rolling 走滚动总榜（不被 :stageId 抢走）', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.scope, 'rolling');
  assert.equal(data.rows.length, 4);
  assert.ok(data.rows[0].points >= data.rows[3].points);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ C-02：非成员看不到 D 段队伍的段位（404），C 段及以上公开；本人看得到无名次进度卡', async () => {
  const { db, close, dataDir, app } = setup();
  const cookie = sessionCookie(db, 'u_obs');
  assert.equal((await call(app, 'GET', '/api/teams/t_d/tier', { cookie })).status, 404, 'D 段不公示 → 外部读者 404');
  const shown = await call(app, 'GET', '/api/teams/t_a/tier', { cookie });
  assert.equal(shown.status, 200);
  const data = JSON.parse(shown.body);
  assert.equal(data.tier, 'A');
  assert.deepEqual(data.neverUnlocks, ['奖金', '决赛名次']);

  const self = JSON.parse((await call(app, 'GET', '/api/teams/t_d/tier', { cookie: sessionCookie(db, 'u_d') })).body);
  assert.equal(self.tier, 'D');
  assert.equal(self.tierRank, undefined, '本人进度卡不含名次');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 战绩卡：里程碑勾选式 + 企业签字标识，不显示签字人', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/teams/t_a/performance-card', { cookie: sessionCookie(db, 'u_cap') });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 3);
  assert.equal(data.items[0].signed, true, '有企业签字 → 标识为已签');
  assert.equal(data.items[0].signatory, undefined);
  assert.ok(!res.body.includes('A队队长'));
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 段位榜 API：C 段及以上公示队名与名次，D 段不公示（非成员看不到）', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_1');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.scope, 'tier');
  // 种子：t_a = A 段、t_c = C 段；t_b（无段位记录）与 t_d = D 段 → 不公示
  assert.deepEqual(data.rows.map((r) => r.teamId), ['t_a', 't_c']);
  assert.deepEqual(data.rows.map((r) => r.tierRank), [1, 2]);
  assert.deepEqual(data.rows.map((r) => r.tier), ['A', 'C']);
  assert.ok(!res.body.includes('D队'), 'D 段队名不得公示');
  assert.ok(data.selfProgress === undefined, '非成员不该拿到任何人的进度卡');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 段位榜 API：本人看得到自己的 D 段进度卡（无名次、无队名）', async () => {
  const { db, close, dataDir, app } = setup();
  // 给 t_d 加一个「未签字的里程碑」→ 它仍是 D 段（不算达成），但进度卡要列出这条里程碑
  db.prepare("INSERT INTO milestones (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at) VALUES ('ms_9','t_d',NULL,'problem_confirmed','企业问题确认',1,'${NOW}',1,'${NOW}')").run();
  const res = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_1', { cookie: sessionCookie(db, 'u_d') });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.selfProgress, '本人应有进度卡');
  assert.equal(data.selfProgress.teamId, 't_d');
  assert.equal(data.selfProgress.tier, 'D');
  assert.equal(data.selfProgress.teamName, undefined, '进度卡不公示队名');
  assert.equal(data.selfProgress.tierRank, undefined, '进度卡不含名次（C-02）');
  assert.ok(data.selfProgress.progress, '进度卡要带里程碑进度');
  assert.equal(data.selfProgress.progress.milestones.length, 1, '进度卡要列出该队的里程碑清单');
  assert.equal(data.selfProgress.progress.milestones[0].label, '企业问题确认');
  assert.ok(!data.rows.some((r) => r.teamId === 't_d'), 'D 段队伍不进入榜单');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 段位榜排序：同段位时里程碑多的在前；兜底键是 team_id 码位序', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    // 三支 A 段队伍，两条不同的次级口径分别被钉住：
    //   t_0a（1 个里程碑）→ 同段位时【里程碑多的在前】占优（t_a 3 > t_0a 1）
    //   t_x （3 个里程碑）→ 与 t_a 完全同分 → 【team_id 码位序】占优（'t_a' < 't_x'）
    // ⚠️ 三支的 created_at 都【早于】种子里的队伍 —— 这样「按入库顺序」的错误实现
    //    会给出不同的名次，数据集才判别得出来。
    db.prepare("INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at) VALUES ('t_0a','ed_1','零A队','u_cap','tp_1','A','active','2026-10-15T00:00:00.000Z'), ('t_x','ed_1','X队','u_cap','tp_1','A','active','2026-10-16T00:00:00.000Z')").run();
    db.prepare("INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at) VALUES ('tr_0a','t_0a','A',1,0,'[]','${NOW}',NULL), ('tr_x','t_x','A',3,0,'[]','${NOW}',NULL)").run();

    const res = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_1');
    assert.equal(res.status, 200);
    const rows = JSON.parse(res.body).rows;
    // 正确序：t_a（3 个里程碑，码位序也最前）→ t_x（3 个，同分靠码位序）→ t_0a（1 个）
    assert.deepEqual(rows.map((r) => r.teamId).slice(0, 3), ['t_a', 't_x', 't_0a'], '同段位先比里程碑数，再按 team_id 码位序');
    assert.deepEqual(rows.map((r) => r.tierRank).slice(0, 3), [1, 2, 3]);
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 届期缺省取当届（不带 editionId 也能拿到榜单 / 段位榜；显式传错 → 404）', async () => {
  const { db, close, dataDir, app } = setup();
  const rolling = await call(app, 'GET', '/api/leaderboard/rolling');
  assert.equal(rolling.status, 200, '滚动总榜：缺省取当届');
  const tier = await call(app, 'GET', '/api/leaderboard/tier');
  assert.equal(tier.status, 200, '段位榜：缺省取当届');
  const bad = await call(app, 'GET', '/api/leaderboard/tier?editionId=ed_nope');
  assert.equal(bad.status, 404, '显式传了不存在的届期 → 404（资源不存在）');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 观察员不能发榜（403）；发榜写快照+审计+积分流水且幂等', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_obs', now: NOW }),
    (err) => err.status === 403,
  );
  const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
  assert.equal(Object.keys(out.snapshots).length, 3, 'rank / business / personal 各一份快照');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leaderboard_snapshots').get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'leaderboard.publish'").get().n, 1);
  const ledger1 = db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n;
  assert.ok(ledger1 > 0, '名次积分要写进流水');
  const mvp1 = db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n;
  publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'stage_rank'").get().n, ledger1,
    '重复发榜不得重复发分');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, mvp1,
    '重复发榜不得重复发 MVP 积分');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 发榜可复算：快照里的名次能重放出同样的结果（P3-12 验收标准）', () => {
  const { db, close, dataDir } = setup();
  try {
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    const snap = db.prepare("SELECT payload_json FROM leaderboard_snapshots WHERE scope = 'rank'").get();
    assert.ok(snap, '要写 rank 快照');
    const payload = JSON.parse(snap.payload_json);
    assert.ok(payload.rows.length > 0, '快照里要有榜单行');
    // 重放：快照的名次与积分必须与「重新算一遍」完全一致（可复算 = 跨机器重算同结果）
    const fresh = getLeaderboard({ db, stageId: 'st_1', scope: 'rank', viewer: null });
    assert.deepEqual(
      payload.rows.map((r) => [r.teamId, r.rank, r.points]),
      fresh.rows.map((r) => [r.teamId, r.rank, r.points]),
      '快照必须能重放出同样的名次与积分',
    );
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 服务层返回体不含互评来源与行为分明细', () => {
  const { db, close, dataDir } = setup();
  const out = getLeaderboard({ db, stageId: 'st_1', scope: 'rank', viewer: null });
  const row = out.rows.find((r) => r.teamId === 't_b');
  assert.equal(row.peerScore, undefined);
  assert.equal(row.behaviorScore, undefined);
  assert.equal(row.fromTeamId, undefined);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ P3-15：发榜时【重算】段位 —— 段位来自「里程碑 + 未撤回签字」，不是历史记录', () => {
  const { db, close, dataDir } = setup();
  try {
    const before = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(before.tier, 'A', '种子里的历史记录是 A');

    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-10-21T00:00:00.000Z' });

    const after = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(after.tier, 'B', '3 个里程碑里只有 2 个有未撤回签字 → 2 个达成 → B 段');
    assert.equal(after.milestone_count, 2, '没有签字的里程碑不算达成（R-PTS-01）');
    assert.equal(after.business_signoff_count, 1, '技术部门的签字不算业务部门（R-PTS-03）');

    const noMs = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_b' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(noMs.tier, 'D', '没有任何里程碑的队伍 → D 段');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ P3-15：连续 14 天零提交 → 降 1 档并公示（相对重算出的段位降，不叠加）', () => {
  const { db, close, dataDir } = setup();
  try {
    // 20 天后再发榜 → 队伍「零提交」20 天 → 触发闲置降档
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-11-09T00:00:00.000Z' });
    const after = db.prepare("SELECT * FROM tier_records WHERE team_id = 't_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(after.tier, 'C', '重算出 B → 闲置降 1 档 → C');
    const reasons = JSON.parse(after.reasons_json);
    assert.ok(reasons.some((r) => String(r).includes('inactive_14days')), '降级原因要写进 reasons');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 段位口径的边界（W01~W05 / W07 / W10~W13）
// ═══════════════════════════════════════════════════════════════════

test('★ 段位口径：未知部门不算业务签字、撤回的签字不计入、不计段位的里程碑不计数', () => {
  const { db, close, dataDir } = setup();
  try {
    // ① 未知部门（法务部）的签字：不是业务部门 → 不算 S 段的那 1 个业务签字
    // ⚠️ **夹具更新**（2026-10-23 审计 F23 之后）：同一个 (milestone, enterprise) 只允许一条
    //    **未撤回**的签字（数据库部分唯一索引 + 服务端检查）⇒ 这条签字改成**另一个企业**
    //    （e_2）⇒ 断言意图（未知部门不算业务签字）**完全不变**，
    //    且不再依赖「同企业可重复签字」这个已被认定为缺陷的行为。
    db.prepare(`INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
      VALUES ('sg_3','ms_1','e_2','u_cap','法务部','内容','${NOW}',NULL)`).run();
    // ② 撤回的签字：对应里程碑不再算「已达成」
    db.prepare(`INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
      VALUES ('sg_4','ms_3','e_1','u_cap','业务部门','内容','${NOW}','${NOW}')`).run();
    // ③ 不计段位的里程碑（counts_toward_tier = 0）
    db.prepare(`INSERT INTO milestones (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at)
      VALUES ('ms_5','t_a',NULL,'iterations','迭代','0','${NOW}',0,'${NOW}')`).run();

    const out = computeTeamTier({ db, teamId: 't_a', now: '2026-10-21T00:00:00.000Z', record: false });
    assert.equal(out.milestoneCount, 2, '撤回的签字与不计段位的里程碑都不算达成');
    assert.equal(out.businessSignoffCount, 1, '只有业务部门的签字算业务签字（法务部 = unknown，不算）');
    assert.equal(out.tier, 'B', '2 个达成 → B 段（撤回归档已由重算体现，不再叠加降档）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 降级后的段位名要跟着最终档位走（不能用降级前的名字）', () => {
  const { db, close, dataDir } = setup();
  try {
    const out = computeTeamTier({ db, teamId: 't_a', now: '2026-11-09T00:00:00.000Z', record: false });
    assert.equal(out.tier, 'C', '闲置 20 天 → B 降 C');
    assert.equal(out.tierName, '立项', '段位名要跟着【最终】档位走（C 段 = 立项）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 「取最新一条段位记录」在 computed_at 并列时按 rowid（登记顺序），不用随机 id', () => {
  const { db, close, dataDir } = setup();
  try {
    // 两条 computed_at 完全相同；id 的字典序与登记顺序【故意相反】
    db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
      VALUES ('tr_z','t_b','C',1,0,'[]','${NOW}',NULL)`).run();
    db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
      VALUES ('tr_a','t_b','B',2,0,'[]','${NOW}',NULL)`).run();
    const latest = getLatestTierRecord(db, 't_b');
    assert.equal(latest.id, 'tr_a', '后登记的那条才是最新的（id 是随机 UUID，不能用它兜底排序）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 「零提交」口径不含积分流水 —— 发榜不能给自己豁免降级', () => {
  const { db, close, dataDir } = setup();
  try {
    // 第一次发榜会写 points_ledger
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-10-25T00:00:00.000Z' });
    // 第二次发榜：距【队伍真实提交】(2026-10-20) 16 天 → 仍应降级；
    // 若把积分流水当成「提交」，末次活动是 10-25 → 只隔 11 天 → 不会降级
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: '2026-11-05T00:00:00.000Z' });
    const after = db.prepare("SELECT * FROM tier_records WHERE team_id='t_a' AND deleted_at IS NULL ORDER BY computed_at DESC, rowid DESC LIMIT 1").get();
    assert.equal(after.tier, 'C', '积分流水不算「提交」→ 第二次发榜仍然降级');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 行为分与 MVP 的数据通路（W27 / W28）
// ═══════════════════════════════════════════════════════════════════

test('★ 破同分时行为分只从独立表 behavior_events 来（分轨强制）', () => {
  const { db, close, dataDir } = setup();
  try {
    // 新赛段：t_c 与 t_d 同分，peer / enterprise 都没有可比较的值
    //   → 破同分链只能落到 behavior；若行为分不从 behavior_events 读，两人仍是并列
    db.prepare("INSERT INTO stages (id, edition_id, \"key\", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status) VALUES ('st_3','ed_1','S3','行为分赛段','initial','2026-10-11','2026-10-12','2026-10-13','initial','closed')").run();
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_5','st_3','t_c',1,70,70,0,0,NULL,NULL,'${NOW}'), ('sr_6','st_3','t_d',1,70,70,0,0,NULL,NULL,'${NOW}')").run();
    db.prepare('INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('be_2', 't_c', 'u_cap', 'first_demo', 10, JSON.stringify({ artifact: 'demo.zip' }), NOW);
    db.prepare('INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('be_3', 't_d', 'u_cap', 'weekly_progress', 2, JSON.stringify({ repo: 'git@x', version: 'v1', artifact: 'demo.zip' }), NOW);

    const out = getLeaderboard({ db, stageId: 'st_3', scope: 'rank', viewer: null });
    const rows = out.rows.filter((r) => r.teamId === 't_c' || r.teamId === 't_d');
    assert.deepEqual(rows.map((r) => r.teamId), ['t_c', 't_d'], '行为分高者在前');
    assert.deepEqual(rows.map((r) => r.rank), [1, 2], '行为分把并列拆开（不是仍然并列）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 的路演分要折算成路演名次积分再计入（判别性：折算 / 不折算 / 不计路演 给出三个不同赢家）', () => {
  const { db, close, dataDir } = setup();
  try {
    // tp_1 扩到 3 队（t_a / t_b / t_e）：两队时路演名次积分（10/8）与赛段名次积分（10/8）
    // 恰好等量，合计永远并列，测不出「路演有没有真的计入」。
    db.prepare("INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at) VALUES ('u_e','E队队长','13800000007','x','mba',NULL,0,1,'${NOW}')").run();
    db.prepare("INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at) VALUES ('t_e','ed_1','E队','u_e','tp_1','D','active','${NOW}')").run();
    db.prepare("INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ('tm_5','t_e','u_e','captain','${NOW}')").run();
    // 赛段 st_1：t_a / t_b 同分 90（破同分链后 t_a 在前）、t_e 垫底 50
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_9','st_1','t_e',5,50,50,0,0,NULL,NULL,'${NOW}')").run();
    // 路演 st_r：名次与赛段【完全相反】t_e 90 > t_b 70 > t_a 50
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_e',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_b',2,70,70,0,0,NULL,NULL,'${NOW}'), ('sr_10','st_r','t_a',3,50,50,0,0,NULL,NULL,'${NOW}')").run();

    // ★ MVP 只在【路演赛段】发榜时发放（终审 I-1）：路演评审综合分是 MVP 公式的最后一个输入，
    //    在它之前发榜拿不到路演分 → MVP 金额偏小，而积分只增不改 ⇒ 补不回来。
    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    const tp1 = out.awarded.mvp.find((m) => m.packageId === 'tp_1');
    // 赛段名次积分 t_a 10 / t_b 8 / t_e 5；路演名次积分 t_e 10 / t_b 8 / t_a 5
    //   → 综合分 t_a 15 / t_b 16 / t_e 15 → t_b 拿 MVP
    // ⚠️ 三种错实现会给出三个不同赢家，数据集能区分：
    //    ① 折算成路演名次积分（正确）→ t_b
    //    ② 把路演原始 0–100 分直接相加 → t_e（95）
    //    ③ 完全不计路演 → t_a（10）
    assert.ok(tp1, 'tp_1 要选出 MVP');
    assert.equal(tp1.teamId, 't_b', '路演名次积分要计入，并能反超赛段领先者');
    assert.equal(tp1.points, 8, 'MVP 积分 = 该队计入的赛段名次积分之和（stage_points_sum）');

    const ledger = db.prepare("SELECT * FROM points_ledger WHERE kind = 'mvp' AND team_id = 't_b'").all();
    assert.equal(ledger.length, 1, 'MVP 积分要写进流水');
    assert.equal(ledger[0].points, 8);
    assert.equal(ledger[0].user_id, 'u_b', '写给队内成员');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 决胜口径是配置项（rules.criteria.mvp.tiebreak 说了算，不写死在代码里）', () => {
  const { db, close, dataDir, rules } = setup();
  try {
    // tp_1 两队：赛段名次积分 t_a 10 / t_b 8；路演名次积分 t_b 10 / t_a 8 → 综合分 18 : 18 真并列
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    // 注入一份把决胜链改成「只按 team_id」的规则 → 并列时选 t_a（码位序）
    const custom = {
      ...rules,
      criteria: { ...rules.criteria, mvp: { ...rules.criteria.mvp, tiebreak: ['team_id'] } },
    };
    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW, rules: custom });
    const tp1 = out.awarded.mvp.find((m) => m.packageId === 'tp_1');
    assert.equal(tp1.teamId, 't_a', '决胜口径由配置决定 → 改成 team_id 后并列时选 t_a');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 跨任务包队伍不得挤掉本任务包的 MVP（路演名次积分按包内排名）', () => {
  const { db, close, dataDir } = setup();
  try {
    // tp_1 的 t_b 路演分最高（90）；tp_2 的 t_c / t_d 没有路演结果
    //   若不按包过滤路演分：t_b 会带着「路演 10 分、赛段 0 分」进入 tp_2 的候选，
    //   与 t_c 的「赛段 10 分」并列 10 : 10 → 旧的 team_id 兜底会让 t_b 赢（t_b < t_c）
    //   → 外队挤掉本包真冠军，且拿到的 MVP 积分是 0
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    const tp2 = out.awarded.mvp.find((m) => m.packageId === 'tp_2');
    assert.ok(tp2, 'tp_2 要选出 MVP');
    assert.equal(tp2.teamId, 't_c', '本包真冠军是 t_c，不能被外队 t_b 挤掉');
    assert.equal(tp2.points, 10, 'MVP 积分按本包赛段名次积分计');
    assert.ok(!out.awarded.mvp.some((m) => m.teamId === 't_b' && m.packageId === 'tp_2'), '外队不得出现在本包 MVP');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 综合分并列时按路演名次积分决胜（不许按队名字母序）', () => {
  const { db, close, dataDir } = setup();
  try {
    // tp_1 两队：赛段名次积分 t_a 10 / t_b 8；路演名次积分 t_b 10 / t_a 8
    //   → 综合分 18 : 18 真并列 → 决胜链 roadshow_points → t_b
    // ⚠️ 若按 team_id 码位序兜底会选 t_a（'t_a' < 't_b'）→ 数据集能区分两种兜底
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    const out = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    const tp1 = out.awarded.mvp.find((m) => m.packageId === 'tp_1');
    assert.equal(tp1.teamId, 't_b', '综合分并列由路演名次积分决出');
    const ledger = db.prepare("SELECT * FROM points_ledger WHERE kind = 'mvp'").all();
    const teams = new Set(ledger.map((r) => r.team_id));
    assert.ok(teams.has('t_b'), 'MVP 流水写给 t_b');
    assert.ok(!teams.has('t_a'), 't_a 只是并列，不能拿到 MVP');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 个人积分榜端到端：仓储真实行 → 域函数 → API 必须有行（终审 C-1：曾恒为空）', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    const ledger = db.prepare("SELECT * FROM points_ledger WHERE kind = 'stage_rank'").all();
    assert.ok(ledger.length > 0, '名次积分要写进流水');
    assert.ok(ledger.every((r) => r.user_id), '每条流水都要有归属人');

    const res = await call(app, 'GET', '/api/leaderboard/st_1?scope=personal');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.scope, 'personal');
    // ⚠️ 这条断言是本次修复的判别点：修复前仓储给的是 snake_case 行，域函数读 entry.userId
    //    读不到 → 每一行都被当成「没有归属人」丢弃 → rows 恒为空（且不报任何错）。
    assert.equal(data.rows.length, ledger.length, '个人积分榜的行数必须与流水条数一致');
    const row = data.rows.find((r) => r.userId === 'u_cap');
    assert.ok(row, 'u_cap 必须在榜上');
    assert.equal(row.name, 'A队队长', '要有姓名，不是只有 id');
    assert.equal(row.total, 10, 'u_cap 是 A 队队长，拿的是 A 队的名次积分 10');
    assert.equal(row.rank, 1, '要有名次');
    assert.deepEqual(row.byKind, { stage_rank: 10 }, '要能看出分项来源');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ MVP 只在路演赛段发榜时发放，且整届只发一次（终审 I-1：曾每赛段重复发）', () => {
  const { db, close, dataDir } = setup();
  try {
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_7','st_r','t_b',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_8','st_r','t_a',2,50,50,0,0,NULL,NULL,'${NOW}')").run();

    // ① 非路演赛段发榜 → 不发 MVP（路演评审综合分是公式的最后一个输入，还没到）
    const s1 = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    assert.deepEqual(s1.awarded.mvp, [], '非路演赛段发榜不得发 MVP');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, 0, '一条都不能写');

    // ② 路演赛段发榜 → 发一次（两个任务包各选出一个 MVP）
    const sr = publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    assert.equal(sr.awarded.mvp.length, 2, '两个任务包各选出一个 MVP');
    const after1 = db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n;
    assert.ok(after1 > 0, '路演赛段发榜要写 MVP 流水');

    // ③ 再发别的赛段 → 不得重复发（幂等键是届期级，不是赛段级）
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, after1,
      '跨赛段重复发榜不得重复发 MVP 积分');

    // ④ 再发一次路演赛段 → 同样不得重复发
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_r', actorId: 'u_admin', now: NOW });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE kind = 'mvp'").get().n, after1,
      '同一路演赛段重复发榜也不得重复发');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 滚动总榜必须汇总各赛段的降级告警（终审 I-2：曾静默丢弃全部告警）', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    const res = await call(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.scope, 'rolling');
    // ⚠️ 判别点：st_1 的计算快照带「本轮该维度未做评委宽严归一化」——
    //    修复前滚动榜 warnings 恒为 []
    //    ⚠️ E184：公开响应里**不再下发内部规则键** ⇒ 按人话正文认这条告警
    assert.ok(data.warnings.length > 0, '滚动总榜不得把降级告警静默丢掉');
    const w = data.warnings.find((x) => x.message === '本轮该维度未做评委宽严归一化（样本不足 5）');
    assert.ok(w, 'st_1 的降级告警必须出现在滚动总榜上');
    assert.equal(w.stageId, 'st_1', '告警要标注来源赛段');
    assert.equal(w.stageKey, 'S1', '告警要标注赛段键');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 段位记录的原因说明是脏数据时降级为空列表并显式告警，不得 500（终审 M-3）', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    db.prepare("UPDATE tier_records SET reasons_json = '{not json' WHERE team_id = 't_a'").run();
    const out = getTeamTier({ db, teamId: 't_a', viewer: { id: 'u_cap' } });
    assert.deepEqual(out.reasons, [], '脏 reasons_json 降级为空数组');
    assert.ok(out.warnings.some((w) => w.code === 'REASONS_PARSE_FAILED'), '必须显式告警，不静默');
    assert.equal(out.tier, 'A', '其它字段照常返回');
    // 走一遍真实 HTTP：修复前这里会 500（INTERNAL）
    const res = await call(app, 'GET', '/api/teams/t_a/tier', { cookie: sessionCookie(db, 'u_cap') });
    assert.equal(res.status, 200, '脏数据不得让接口 500');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 第 11 批（2026-10-24 独立评审轮）：发榜链路的三个瑕疵
//   ① B1：`awarded.corrections` 挂在**数组**上 ⇒ JSON.stringify 后恒为 undefined
//      ⇒ 发榜审计里看不到「为什么多/扣一笔」（奖金场景要能追溯）。
//   ② B2：滚动总榜累计了**未发榜赛段**的内存积分，与 points_ledger 流水
//      **两个口径并存**且响应里没有任何标注。
//   ③ C6：一次发榜把 buildStageRanking 跑了 4+ 遍（纯浪费）。
// ══════════════════════════════════════════════════════════════════

test('★ B1 发榜审计里必须能看到「差额更正」（corrections 不能被 JSON.stringify 丢掉）', () => {
  const { db, close, dataDir } = setup();
  try {
    // 第一次发榜
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    // ⚠️ 必须改到**名次**变掉才测得到：名次积分是**按任务包内名次**发的
    //    （名次 1 → 10 分、名次 2 → 8 分）⇒ 只改分值不改名次 ⇒ 积分不变 ⇒ 没有差额。
    //    t_c（70 分）与 t_d（60 分）同属任务包 tp_2 ⇒ 把 t_c 压到 t_d 之下
    //    ⇒ 两者名次对调 ⇒ t_c 10→8（-2）、t_d 8→10（+2）⇒ 产生差额更正。
    db.prepare("UPDATE stage_results SET total = 10 WHERE id = 'sr_3'").run();
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });

    const rows = db.prepare(
      "SELECT detail_json FROM audit_log WHERE action = 'leaderboard.publish' ORDER BY created_at ASC, rowid ASC",
    ).all();
    assert.equal(rows.length, 2, '两次发榜 ⇒ 两条审计');
    // ⚠️ 关键断言：**审计落库的那份 JSON** 里必须能看到 corrections
    //    （不是看内存里的对象 —— 内存对象是有的，丢在 JSON.stringify 上）
    const detail = JSON.parse(rows[1].detail_json);
    assert.ok(detail.awarded, '审计里必须有 awarded');
    assert.ok(detail.awarded.corrections, `审计里必须有 awarded.corrections：${rows[1].detail_json}`);
    assert.ok(Array.isArray(detail.awarded.corrections.stage), 'corrections.stage 必须是数组');
    assert.ok(
      detail.awarded.corrections.stage.length > 0,
      '改了分数后重发榜必然产生差额更正 ⇒ corrections 不得为空'
      + `：${rows[1].detail_json}`,
    );
    const first = detail.awarded.corrections.stage[0];
    assert.ok(
      Object.prototype.hasOwnProperty.call(first, 'points') && typeof first.points === 'number',
      `每条更正必须带 points（多/扣了多少）：${JSON.stringify(first)}`,
    );
    assert.ok(first.teamId && first.userId, `每条更正必须指明谁：${JSON.stringify(first)}`);
    // ⚠️ 对照组：`awarded.stage` / `awarded.mvp` **仍是数组**（既有契约不动）
    assert.ok(Array.isArray(detail.awarded.stage), 'awarded.stage 仍必须是数组（既有契约）');
    assert.ok(Array.isArray(detail.awarded.mvp), 'awarded.mvp 仍必须是数组（既有契约）');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ B2 滚动总榜必须标注「含未发榜赛段的预估分」（两个口径并存不许静默）', async () => {
  const { getRollingLeaderboard } = await import('../src/services/leaderboard.js');
  const { db, close, dataDir, rules } = setup();
  try {
    // ⚠️ 给路演赛段 st_r 补结果行（种子里它是空的 ⇒ 不进滚动榜 ⇒ 测不到「未发榜赛段」）
    db.prepare("INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at) VALUES ('sr_lb1','st_r','t_a',1,90,90,0,0,NULL,NULL,'${NOW}'), ('sr_lb2','st_r','t_b',2,70,70,0,0,NULL,NULL,'${NOW}')").run();
    // ① 未发榜时：st_1 / st_r 都只是「算过」，没有发榜快照
    const before = getRollingLeaderboard({ db, editionId: 'ed_1', viewer: null, rules });
    assert.equal(
      before.pointsIncludeUnpublishedStages, true,
      '存在未发榜赛段时必须标注 true（否则读者会把总榜当最终积分）',
    );
    const unpublishedKeys = before.unpublishedStages.map((s) => s.key).sort();
    assert.deepEqual(
      unpublishedKeys, ['S1', 'S4'],
      `未发榜赛段必须逐个列出（让读者知道哪些赛段的预估分混在里面）：${JSON.stringify(before.unpublishedStages)}`,
    );

    // ② 发榜后：该赛段不再算「未发榜」
    publishLeaderboard({ db, editionId: 'ed_1', stageId: 'st_1', actorId: 'u_admin', now: NOW });
    const after = getRollingLeaderboard({ db, editionId: 'ed_1', viewer: null, rules });
    const afterKeys = after.unpublishedStages.map((s) => s.key).sort();
    assert.deepEqual(
      afterKeys, ['S4'],
      `发榜后该赛段必须从未发榜清单里消失：${JSON.stringify(after.unpublishedStages)}`,
    );
    assert.equal(after.pointsIncludeUnpublishedStages, true, '还有未发榜赛段 ⇒ 标注仍为 true');
  } finally {
    close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

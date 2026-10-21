import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { insertWorkflow, insertWorkflowTask } from '../src/db/repo/workflows.js';
import {
  createPublicToken, resolvePublicToken, getPublicLeaderboard, PUBLIC_NOTICE,
} from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
// 统一注入时间：所有时间断言都基于它，口径可复算
const NOW = '2026-10-20T00:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5pub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000031', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_sign', '签字人丁', '13900000032', 'x', 'other', '某银行', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_super', '组委会', '13900000033', 'x', 'mba', '组委会', 1, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_a', 'tp_1', 'D', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_ghost', 'ed_1', '幽灵队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_3', 'ed_1', '三队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_3', 'st_1', 'tm_3', 3, 70.0, 72.0, 68.0, 1, 6, NULL, '2026-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_0', 'tm_1', 'D', 0, 0, '[]', '2026-10-11T00:00:00.000Z', NULL),
           ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_3', 'tm_1', 'B', 3, 1, '[]', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');
    INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
    VALUES ('pr_1', 'st_1', 'tm_ghost', 'tm_1', 7.5, 'req_1', '2026-10-10T00:00:00.000Z');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z');
    INSERT INTO capabilities (key, description) VALUES ('pool:read', '读取三池'), ('pool:write', '维护三池');
  `);
  const app = createApp({ db, rules, webDir });
  return {
    db,
    close,
    dataDir,
    rules,
    app,
    tokenMember: createSession(db, 'u_a').token,
    tokenOutsider: createSession(db, 'u_sign').token,
    tokenSuper: createSession(db, 'u_super').token,
  };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

// 工作流夹具：用**仓储层的真实写入方**建（数据形状与生产写入一致）
function seedWorkflow(db) {
  const wf = insertWorkflow(db, {
    id: 'wf_1', editionId: 'ed_1', taskPackageId: 'tp_1', name: '工作流一',
    now: '2026-10-01T00:00:00.000Z',
  });
  const task = insertWorkflowTask(db, {
    id: 'wt_1', workflowId: wf.id, title: '做风控原型',
    now: '2026-10-01T00:00:00.000Z',
  });
  return { wf, task };
}

function leaderboardToken(db, { scope = 'leaderboard', editionId = 'ed_1', expiresAt = '2027-01-01T00:00:00.000Z' } = {}) {
  return createPublicToken({
    db, scope, editionId, expiresAt, now: '2026-10-01T00:00:00.000Z',
  }).token;
}

test('无 token → 403', () => {
  const { db, close, dataDir, rules } = setup();
  assert.throws(
    () => getPublicLeaderboard({ db, token: '', editionId: 'ed_1', rules }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_MISSING',
  );
  cleanup(db, close, dataDir);
});

test('token 过期 → 403', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2026-10-01T00:00:00.000Z', now: '2026-09-01T00:00:00.000Z',
  });
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_EXPIRED',
  );
  cleanup(db, close, dataDir);
});

test('token 属于别的届期 → 403', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_other', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_EDITION_MISMATCH',
  );
  cleanup(db, close, dataDir);
});

test('scope 不匹配（calendar token 去拉榜单）→ 403', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'calendar', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_SCOPE_MISMATCH',
  );
  cleanup(db, close, dataDir);
});

test('有效 token → 拿到榜单，但 D 段队伍不公示', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' });
  assert.equal(payload.stages.length, 1);
  const rows = payload.stages[0].rows;
  assert.equal(rows.length, 1, 'D 段队伍（二队）不进公开榜单');
  assert.equal(rows[0].teamName, '一队');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].tier, 'C');
  cleanup(db, close, dataDir);
});

test('公开响应体里没有签字人、没有企业名、没有互评来源、没有 D 段队伍', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' });
  const text = JSON.stringify(payload);

  assert.equal(text.includes('签字人丁'), false, 'B 榜签字人不公开');
  assert.equal(text.includes('某银行'), false, '企业名不公示');
  assert.equal(text.includes('tm_ghost'), false, '互评来源不公示');
  assert.equal(text.includes('二队'), false, 'D 段队伍不公示排名');
  assert.equal(text.includes('enterpriseName'), false);
  assert.equal(text.includes('signatory'), false);
  assert.equal(text.includes('peer'), false);
  cleanup(db, close, dataDir);
});

test('公开行的字段是白名单（结构上杜绝泄露）', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' });
  const row = payload.stages[0].rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['points', 'rank', 'teamName', 'tier', 'tiedWith', 'total'].sort());
  cleanup(db, close, dataDir);
});

test('公开接口必须显式调用可见性过滤（源码里有 applyVisibility）', () => {
  const src = readFileSync(join(here, '..', 'src', 'services', 'public-api.js'), 'utf8');
  assert.ok(src.includes('applyVisibility'), '公开接口必须显式过 applyVisibility（P3 产出）');
  assert.ok(src.includes("from '../domain/visibility.js'"), '必须从 P3 的 visibility 模块导入');
  // ⚠️ 补（P5 Task 4 实跑后追加）：context 必须是 scope='rank'。
  //    P3 的 rank 分支只剔互评来源与企业名，**不做段位过滤**（段位下限由 P5 自己执行）；
  //    写成 'tier' 会让 P3 先按它自己的段位表过滤 —— 两层口径一旦漂移，
  //    公开榜就会随 P3 的改动而变（D 段是否公示不再由 P5 单独决定）。
  assert.ok(src.includes("context: { scope: 'rank'"), 'applyVisibility 的 context 必须是 scope=rank');
});

test('token 只存哈希：库里看不到明文', () => {
  const { db, close, dataDir } = setup();
  const { token } = createPublicToken({
    db, scope: 'all', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const rows = db.prepare('SELECT token FROM public_tokens').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, token, '库里存的是哈希，不是明文 token');
  assert.equal(rows[0].token.length, 64, 'SHA-256 十六进制长度');
  cleanup(db, close, dataDir);
});

test('resolvePublicToken 对有效 token 返回 scope 与届期', () => {
  const { db, close, dataDir } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const resolved = resolvePublicToken({
    db, token, now: '2026-10-20T00:00:00.000Z', requiredScope: 'leaderboard', editionId: 'ed_1',
  });
  assert.equal(resolved.scope, 'leaderboard');
  assert.equal(resolved.editionId, 'ed_1');
  cleanup(db, close, dataDir);
});

// ── 以下为 P5 Task 4 实跑后补齐的用例（计划原块只覆盖服务层，
//    新建的 3 个路由文件 + server.js 的原文响应分支**零覆盖**）──

test('resolvePublicToken 同时返回 expiresAt（调用方据此判断剩余有效期）', () => {
  const { db, close, dataDir } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const resolved = resolvePublicToken({
    db, token, now: '2026-10-20T00:00:00.000Z', requiredScope: 'leaderboard', editionId: 'ed_1',
  });
  assert.equal(resolved.expiresAt, '2027-01-01T00:00:00.000Z');
  cleanup(db, close, dataDir);
});

test('token 库里查不到 → 403 PUBLIC_TOKEN_INVALID', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => resolvePublicToken({ db, token: '根本没签发过', now: NOW, requiredScope: 'leaderboard' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_INVALID',
  );
  cleanup(db, close, dataDir);
});

test('createPublicToken 不给 expiresAt → 按 rules.pools.publicTokenTtlDays 推算（默认 30 天）', () => {
  const { db, close, dataDir } = setup();
  const created = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', now: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(created.expiresAt, '2026-10-31T00:00:00.000Z');
  cleanup(db, close, dataDir);
});

test('createPublicToken 的 scope 必须在 publicScopes 内 → 否则 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => createPublicToken({ db, scope: 'admin', editionId: 'ed_1', now: '2026-10-01T00:00:00.000Z' }),
    (err) => err.status === 400 && err.code === 'PUBLIC_SCOPE_INVALID',
  );
  cleanup(db, close, dataDir);
});

test('createPublicToken 缺 editionId → 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => createPublicToken({ db, scope: 'leaderboard', now: '2026-10-01T00:00:00.000Z' }),
    (err) => err.status === 400 && err.code === 'EDITION_REQUIRED',
  );
  cleanup(db, close, dataDir);
});

test('getPublicLeaderboard 缺规则 → 500 RULES_MISSING（拒绝出数，不用默认口径凑数）', () => {
  const { db, close, dataDir } = setup();
  const token = leaderboardToken(db);
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1' }),
    (err) => err.status === 500 && err.code === 'RULES_MISSING',
  );
  cleanup(db, close, dataDir);
});

test('getPublicLeaderboard 缺 editionId → 400', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  assert.throws(
    () => getPublicLeaderboard({ db, token, rules, now: NOW }),
    (err) => err.status === 400 && err.code === 'EDITION_REQUIRED',
  );
  cleanup(db, close, dataDir);
});

test('公开 payload 的元信息：editionId / generatedAt / scope / notice / 赛段信息', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  assert.equal(payload.editionId, 'ed_1');
  assert.equal(payload.generatedAt, NOW, 'generatedAt 必须落在注入的时间上');
  assert.equal(payload.scope, 'rank');
  assert.equal(payload.notice, PUBLIC_NOTICE);
  assert.equal(payload.stages[0].stageId, 'st_1');
  assert.equal(payload.stages[0].stageKey, 's1');
  assert.equal(payload.stages[0].stageName, '调研');
  cleanup(db, close, dataDir);
});

test('段位取最新的一条【有效】记录（软删除的不算）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  // 种子里有 tm_1 的三条段位记录：tr_0（D, 更早）/ tr_1（C）/ tr_3（B, 更晚但已软删除）
  assert.equal(payload.stages[0].rows[0].tier, 'C', '取最新的一条有效记录；软删除的不生效');
  cleanup(db, close, dataDir);
});

test('公开行的分值字段逐个透传（total / points / tiedWith）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  const row = payload.stages[0].rows[0];
  assert.equal(row.total, 90);
  assert.equal(row.points, 10);
  assert.equal(row.tiedWith, 0);
  cleanup(db, close, dataDir);
});

test('被段位门槛挡下的队伍要留下 warning（不是静默丢弃）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  const hidden = payload.warnings.find((w) => w.code === 'tier_below_public_threshold_hidden');
  assert.ok(hidden, '低于公示门槛的队伍必须留 warning');
  assert.equal(hidden.stageId, 'st_1');
  // 二队（D 段）+ 三队（无段位记录 = 段位未知 = 视为未达 C 段）
  assert.equal(hidden.count, 2);
  cleanup(db, close, dataDir);
});

test('段位未知（无 tier_record）= 视为未达 C 段 → 不公示（fail-closed）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  const names = payload.stages[0].rows.map((r) => r.teamName);
  assert.deepEqual(names, ['一队'], '三队段位未知 ⇒ 与 D 段同待遇，不公示');
  cleanup(db, close, dataDir);
});

test('公示门槛可配置：publicFromTier 提到 B → C 段队伍也不公示', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const strict = {
    ...rules,
    visibility: { ...rules.visibility, rank: { ...rules.visibility.rank, publicFromTier: 'B' } },
  };
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules: strict, now: NOW });
  assert.equal(payload.stages[0].rows.length, 0, '门槛提到 B 段后 C 段队伍也不公示');
  cleanup(db, close, dataDir);
});

test('HTTP GET /api/public/leaderboard 带有效 token → 200，且只给白名单字段', async () => {
  const s = setup();
  const token = leaderboardToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/leaderboard?token=${token}&editionId=ed_1`);
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.stages.length, 1);
  assert.deepEqual(
    Object.keys(payload.stages[0].rows[0]).sort(),
    ['points', 'rank', 'teamName', 'tier', 'tiedWith', 'total'].sort(),
  );
  assert.equal(res.body.includes('二队'), false, 'D 段队伍不公示');
  assert.equal(res.body.includes('某银行'), false, '企业名不公示');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/leaderboard 无 token → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/leaderboard?editionId=ed_1');
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_MISSING');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/leaderboard token 无效 → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/leaderboard?token=not-a-real-token&editionId=ed_1');
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_INVALID');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/leaderboard 缺 editionId → 400', async () => {
  const s = setup();
  const token = leaderboardToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/leaderboard?token=${token}`);
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/:id/tasks 未登录 → 401', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'GET', `/api/workflows/${wf.id}/tasks`);
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/:id/tasks 队成员 → 200 + 任务清单', async () => {
  const s = setup();
  const { wf, task } = seedWorkflow(s.db);
  const res = await call(s.app, 'GET', `/api/workflows/${wf.id}/tasks`, { token: s.tokenMember });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].id, task.id);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/:id/tasks 非队成员 → 200 + 空集（列表三态）', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'GET', `/api/workflows/${wf.id}/tasks`, { token: s.tokenOutsider });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).tasks, []);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/<不存在> → 404（单条不存在）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/workflows/wf_none/tasks', { token: s.tokenMember });
  assert.equal(res.status, 404, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/claim 未登录 → 401', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { body: {} });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/claim → 200；重复领取 → 409（唯一领取由数据库兜底）', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const first = await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  assert.equal(first.status, 200, first.body);
  assert.equal(JSON.parse(first.body).task.status, 'in_progress');
  const second = await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  assert.equal(second.status, 409, second.body);
  assert.equal(JSON.parse(second.body).error.code, 'TASK_ALREADY_CLAIMED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/release 未登录 → 401', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/release`, { body: {} });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/release 非领取人 → 403（谁领的谁放，不存在上级指派）', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/release`, { token: s.tokenOutsider, body: {} });
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_CLAIM_HOLDER');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/complete 未登录 → 401', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/complete`, { body: {} });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/complete 证据不合格 → 400；合格 → 200 done', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  const bad = await call(s.app, 'POST', `/api/tasks/${task.id}/complete`, {
    token: s.tokenMember, body: { evidence: { kind: 'runnable', summary: '做完了' } },
  });
  assert.equal(bad.status, 400, bad.body);
  assert.equal(JSON.parse(bad.body).error.code, 'EVIDENCE_REQUIRED');
  const good = await call(s.app, 'POST', `/api/tasks/${task.id}/complete`, {
    token: s.tokenMember,
    body: { evidence: { kind: 'runnable', summary: '原型跑通了', artifactUrl: 'https://example.com/repo', version: 'v1' } },
  });
  assert.equal(good.status, 200, good.body);
  assert.equal(JSON.parse(good.body).task.status, 'done');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/{projects,talents,resources} 未登录 → 200 + 空集（列表三态）', async () => {
  const s = setup();
  for (const [path, key] of [
    ['/api/pools/projects', 'projects'],
    ['/api/pools/talents', 'talents'],
    ['/api/pools/resources', 'resources'],
  ]) {
    const res = await call(s.app, 'GET', `${path}?editionId=ed_1`);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(JSON.parse(res.body)[key], [], `${path} 应返回空集`);
  }
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { body: { editionId: 'ed_1' } });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 缺 editionId → 400', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: {} });
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 无 pool:write 权限 → 403（can() 是唯一判定入口）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenMember, body: { editionId: 'ed_1' } });
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  cleanup(s.db, s.close, s.dataDir);
});

test('原文响应（__rawText）走 text() 而不是 json()', async () => {
  const s = setup();
  s.app.router.add('GET', '/api/test-raw', async () => ({
    __rawText: true, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', contentType: 'text/calendar; charset=utf-8',
  }));
  const raw = await call(s.app, 'GET', '/api/test-raw');
  assert.equal(raw.status, 200);
  assert.equal(raw.body, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', '原文响应必须原样输出');
  assert.equal(raw.headers['Content-Type'], 'text/calendar; charset=utf-8');
  // 对照：普通 handler 仍走 JSON
  const jsonRes = await call(s.app, 'GET', '/api/health');
  assert.equal(jsonRes.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(jsonRes.body).ok, true);
  cleanup(s.db, s.close, s.dataDir);
});

test('可见性过滤抛错 → 记 warning 并用严格投影兜底（fail-safe：宁可少给不可多给）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  // 只让 peerReview 这个键抛错：applyVisibility 读它时炸，
  // 而 projectPublicRows 读的是 rank.publicFromTier（不炸）⇒ 兜底路径可被观测。
  const boom = new Proxy({ rank: rules.visibility.rank }, {
    get(target, prop) {
      if (prop === 'peerReview') throw new Error('可见性配置炸了');
      return target[prop];
    },
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules: { ...rules, visibility: boom }, now: NOW });
  const w = payload.warnings.find((x) => x.code === 'visibility_filter_failed');
  assert.ok(w, '过滤失败必须留 warning，不能静默');
  assert.equal(payload.stages[0].rows.length, 1, '兜底后仍只给 C 段队伍（D 段照旧不公示）');
  cleanup(db, close, dataDir);
});

test('HTTP GET /api/workflows/<不存在> 未登录 → 401（先判登录，不泄露工作流是否存在）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/workflows/wf_none/tasks');
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/workflows', {
    body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '工作流一' },
  });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows 认领该任务包的队员 → 200（任务包 → 工作流）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/workflows', {
    token: s.tokenMember, body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '工作流一' },
  });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.workflow.task_package_id, 'tp_1');
  assert.equal(payload.workflow.name, '工作流一');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows/:id/tasks 未登录 → 401', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/workflows/${wf.id}/tasks`, { body: { title: '任务一' } });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows/:id/tasks 指定 ownerTeamId → 落库（队伍归属明确）', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/workflows/${wf.id}/tasks`, {
    token: s.tokenMember, body: { title: '任务二', ownerTeamId: 'tm_1' },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).task.owner_team_id, 'tm_1');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows/:id/tasks 队成员 → 200（工作流 → 任务清单）', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/workflows/${wf.id}/tasks`, {
    token: s.tokenMember, body: { title: '任务一', detail: '细节' },
  });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.task.title, '任务一');
  assert.equal(payload.task.workflow_id, wf.id);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/projects 组委会 → 200 + 4 支队伍（限流与过滤参数生效）', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  const res = await call(s.app, 'GET', '/api/pools/projects?editionId=ed_1', { token: s.tokenSuper });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).projects.length, 4);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/talents 组委会 → 200 + 个人积分（minPoints / userId 过滤生效）', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  const all = await call(s.app, 'GET', '/api/pools/talents?editionId=ed_1', { token: s.tokenSuper });
  assert.equal(all.status, 200, all.body);
  const talents = JSON.parse(all.body).talents;
  assert.equal(talents.length, 1);
  assert.equal(talents[0].userId, 'u_a');
  assert.equal(talents[0].totalPoints, 10);
  const none = await call(s.app, 'GET', '/api/pools/talents?editionId=ed_1&minPoints=100', { token: s.tokenSuper });
  assert.deepEqual(JSON.parse(none.body).talents, []);
  const other = await call(s.app, 'GET', '/api/pools/talents?editionId=ed_1&userId=nobody', { token: s.tokenSuper });
  assert.deepEqual(JSON.parse(other.body).talents, []);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/resources 组委会 → 200 + 企业侧资源（kind 过滤生效）', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  const res = await call(s.app, 'GET', '/api/pools/resources?editionId=ed_1', { token: s.tokenSuper });
  assert.equal(res.status, 200, res.body);
  const resources = JSON.parse(res.body).resources;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].kind, 'enterprise_brief');
  const none = await call(s.app, 'GET', '/api/pools/resources?editionId=ed_1&kind=free_brief', { token: s.tokenSuper });
  assert.deepEqual(JSON.parse(none.body).resources, []);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 缺 editionId（且无 pool:write）→ 400（先判参数，再判权限）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenMember, body: {} });
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 的 editionId 也可以走 query 参数', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync?editionId=ed_1', { token: s.tokenSuper, body: {} });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).projects.editionId, 'ed_1');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 三池都同步（项目 / 人才 / 资源）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.projects.total, 4, '4 支队（幽灵队也在内）进项目池');
  assert.equal(payload.talents.total, 1, '有积分流水的人进人才池');
  assert.equal(payload.resources.total, 1);
  cleanup(s.db, s.close, s.dataDir);
});


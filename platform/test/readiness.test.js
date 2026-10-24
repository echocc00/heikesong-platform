// platform/test/readiness.test.js —— S-8 评审覆盖率闸 + S-9 按时发榜闸（E181，2026-10-27）
//
// 规则溯源：
//   - 设计文档 §1.3.1「S-7~S-10：怎么量、今天有没有机器检查」
//     （spec 原文：S-8「⚠️ **部分** …但**没有**「漏评覆盖率」的汇总闸 ⇒ 待补」；
//      S-9「⚠️ **部分**：发榜时刻已入库，但**没有**「超 72 小时」的告警 ⇒ 待补」）
//   - 阈值来源：rules/compliance.json 的 `readiness` 段（**代码不硬编码数字**）
//   - 三态状态码 → 设计文档 §7.3；可见性在 API 层过滤 → 设计文档 §6.6
//
// ⚠️ **判别性要求**（本仓纪律：用例必须能抓住「把修复去掉」）：
//   每条用例都钉住**具体数字**（应交格子数 = 席位数 × 队数 × 维度数、覆盖率百分比、
//   超期小时数），而不是钉「不是 undefined」那种糊弄断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules, validateRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { createUser, getUserById, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { registerStageTeams } from '../src/db/repo/stage-teams.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { readinessSummary } from '../src/services/readiness.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

// 初赛评委席维度（rules/scoring-initial.json）—— ⛔ 不含 enterprise / self 维度
// （那两个维度走企业确认与自评，**不落在 stage_reviews**）。
const JUDGE_DIMS_INITIAL = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-ready-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app, rules };
}

/**
 * 建一个「1 届 · 2 队 · 2 个评委席 + 1 个观察员」的骨架。
 * ⚠️ 观察员**无投票权**（R-JDG-11）⇒ 不进应交格子。
 */
function seedStage(db, {
  key = 's1', kind = 'initial', scoringConfigKey = 'initial',
  endsAt = '2026-10-10', teamCount = 2, withRoster = true, withSeats = true,
} = {}) {
  const captain = createUser(db, { name: `队长${key}`, phone: `1390000${key.length}${key.charCodeAt(1)}`, password: 'pw' });
  const judgeA = createUser(db, { name: `评委A${key}`, phone: `1391000${key.length}${key.charCodeAt(1)}`, password: 'pw' });
  const judgeB = createUser(db, { name: `评委B${key}`, phone: `1392000${key.length}${key.charCodeAt(1)}`, password: 'pw' });
  const observer = createUser(db, { name: `观察员${key}`, phone: `1393000${key.length}${key.charCodeAt(1)}`, password: 'pw' });

  const edition = createEdition(db, {
    name: `届${key}`, city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key, name: `赛段${key}`, kind,
    startsAt: '2026-10-01', endsAt, scoringConfigKey, status: 'open', now: NOW,
  });
  const teams = [];
  for (let i = 0; i < teamCount; i += 1) {
    teams.push(insertTeam(db, {
      editionId: edition.id, name: `${key}队${i + 1}`, captainId: captain.id, status: 'active', now: NOW,
    }));
  }
  if (withRoster) registerStageTeams(db, { stageId: stage.id, teamIds: teams.map((t) => t.id), now: NOW });
  if (withSeats) {
    assignStageJudge(db, { stageId: stage.id, userId: judgeA.id, seat: 'judge', now: NOW });
    assignStageJudge(db, { stageId: stage.id, userId: judgeB.id, seat: 'judge', now: NOW });
    assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });
  }
  return { edition, stage, teams, judgeA, judgeB, observer, captain };
}

/** 给某赛段铺满评分（返回已插行数）。 */
function fillReviews(db, stage, teams, judges, dims = JUDGE_DIMS_INITIAL, now = NOW) {
  let n = 0;
  for (const j of judges) {
    for (const t of teams) {
      for (const d of dims) {
        insertReview(db, { stageId: stage.id, judgeId: j.id, teamId: t.id, dimension: d, rawScore: 80, now });
        n += 1;
      }
    }
  }
  return n;
}


/** 走**公开 API**取某个赛段的覆盖率（⛔ 不直接调内部函数 —— 内部函数是模块私有的）。 */
function coverageOf(db, stageId, rules, now = NOW) {
  const sum = readinessSummary({ db, rules, now });
  return sum.s8.stages.find((s) => s.stageId === stageId);
}

/** 走**公开 API**取某个赛段的发榜时限行。 */
function deadlineOf(db, stageId, rules, now = NOW) {
  const sum = readinessSummary({ db, rules, now });
  return sum.s9.stages.find((s) => s.stageId === stageId);
}

// ── S-8 ──────────────────────────────────────────────────────────────

test('S-8：评分铺满 ⇒ 覆盖率 100%，且**观察员不进应交格子**', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', teamCount: 2 });
    // 2 个评委席 × 2 队 × 5 个评委席维度 = 20 格
    // ⚠️ 观察员**不算**（R-JDG-11：无投票权）⇒ 若误把它算进去，应交会变成 30
    fillReviews(s.db, f.stage, f.teams, [f.judgeA, f.judgeB]);

    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.status, 'measurable');
    assert.equal(cov.expected, 20, '应交格子必须是 席位数(2) × 队数(2) × 评委席维度数(5)');
    assert.equal(cov.submitted, 20);
    assert.equal(cov.coveragePercent, 100);
    assert.equal(cov.complete, true);
    assert.equal(cov.missingCount, 0);
  } finally {
    s.close();
  }
});

test('S-8：漏评 ⇒ 覆盖率按缺口算，低于门槛即**不达标**，且 missing 清单可用', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', teamCount: 2 });
    // 只铺 1 个评委 ⇒ 10 / 20 = 50% < 90%
    fillReviews(s.db, f.stage, f.teams, [f.judgeA]);

    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.expected, 20);
    assert.equal(cov.submitted, 10);
    assert.equal(cov.coveragePercent, 50);
    assert.equal(cov.complete, false, '50% < 门槛 90% ⇒ 必须判不达标');
    assert.equal(cov.missingCount, 10, '漏评 10 格');
    assert.ok(cov.missing.length > 0, '必须给出漏评清单（评审要知道谁没交）');
    assert.ok(cov.missing.every((m) => m.judgeId && m.teamId && m.dimension));
  } finally {
    s.close();
  }
});

test('S-8：**名册未登记** ⇒ not_applicable（这段还没开打，不是「全部漏评」）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's4', teamCount: 2, withRoster: false });
    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.status, 'not_applicable');
    assert.equal(cov.coveragePercent, null, '⛔ 不可判定时绝不能返回 100%（那会把「没开打」说成「都交了」）');
    assert.equal(cov.complete, false);
    assert.ok(cov.statusNote && cov.statusNote.includes('名册'), '必须写明为什么不可判定');
  } finally {
    s.close();
  }
});

test('S-8：**没有投票权席位** ⇒ 应交 0 格 ⇒ 不可判定（不得返回 100%）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's5', teamCount: 2, withSeats: false });
    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.status, 'not_applicable');
    assert.equal(cov.coveragePercent, null);
    assert.equal(cov.expected, 0);
  } finally {
    s.close();
  }
});

test('S-8：阈值来自 rules（改阈值 ⇒ 结论跟着变；代码里不硬编码）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', teamCount: 2 });
    fillReviews(s.db, f.stage, f.teams, [f.judgeA]); // 10 / 20 = 50%

    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.complete, false, '门槛 90% ⇒ 50% 不达标');
    assert.equal(cov.thresholdPercent, 90);

    // 把门槛降到 40% ⇒ 同样的数据应当判达标（证明阈值是配置驱动的）
    const lax = structuredClone(s.rules);
    lax.compliance.readiness.minReviewCoveragePercent = 40;
    const cov2 = coverageOf(s.db, f.stage.id, lax);
    assert.equal(cov2.complete, true, '门槛改成 40% ⇒ 50% 必须判达标');
  } finally {
    s.close();
  }
});

// ── S-9 ──────────────────────────────────────────────────────────────

function seedSnapshot(db, editionId, stageId, createdAt) {
  for (const scope of ['rank', 'business', 'personal']) {
    db.prepare(
      'INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)',
    ).run(`snap-${stageId}-${scope}`, editionId, stageId, scope, '{}', createdAt);
  }
}

test('S-9：结束 +24h 发榜 ⇒ 按时（不超期）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', endsAt: '2026-10-10' });
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-11T00:00:00.000Z'); // 结束 +24h
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'published');
    assert.equal(row.overdue, false);
    assert.equal(row.delayHours, 24);
    assert.equal(out.overdueCount, 0);
  } finally {
    s.close();
  }
});

test('S-9：结束 +90h 发榜 ⇒ **超期**（时限 72h），且延迟小时数报得出来', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's2', endsAt: '2026-10-10' });
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-13T18:00:00.000Z'); // 结束 +90h
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'late');
    assert.equal(row.overdue, true);
    assert.equal(row.delayHours, 90);
    assert.equal(out.overdueCount, 1);
    assert.ok(out.overdueStageIds.includes(f.stage.id));
  } finally {
    s.close();
  }
});

test('S-9：结束 72h 仍**从未发榜** ⇒ 判 never_published 并计入超期', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's3', endsAt: '2026-10-10' });
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-13T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'never_published');
    assert.equal(row.overdue, true);
    assert.equal(row.publishedAt, null);
    assert.equal(row.delayHours, 84, '结束 10-10 00:00 → now 10-13 12:00 = 84 小时');
  } finally {
    s.close();
  }
});

test('S-9：赛段**尚未结束** ⇒ not_due，不算超期', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's5', endsAt: '2026-12-01' });
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'not_due');
    assert.equal(row.overdue, false);
  } finally {
    s.close();
  }
});

test('S-9：**名册未登记**（这段没开打）⇒ 不计入超期', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's4', endsAt: '2026-10-10', withRoster: false });
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'no_roster');
    assert.equal(row.overdue, false, '没开打的赛段不该被判「超期没发榜」');
    assert.equal(out.overdueCount, 0);
  } finally {
    s.close();
  }
});

test('S-9：同一赛段**发榜两次** ⇒ 判**首次**发榜时刻（重发不掩盖首发的按时性）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', endsAt: '2026-10-10' });
    // 首发 +24h（按时）；重发 +100h（超期）
    // ⚠️ 若闸取「最后一条快照」⇒ 会得出 100h ⇒ 误判超期 ⇒ 这条用例必须能抓住它。
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-11T00:00:00.000Z');
    for (const scope of ['rank', 'business', 'personal']) {
      s.db.prepare(
        'INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)',
      ).run(`snap2-${f.stage.id}-${scope}`, f.edition.id, f.stage.id, scope, '{}', '2026-10-14T04:00:00.000Z');
    }
    const row = deadlineOf(s.db, f.stage.id, s.rules, '2026-10-20T12:00:00.000Z');
    assert.equal(row.publishedAt, '2026-10-11T00:00:00.000Z', '必须取**首次**发榜时刻');
    assert.equal(row.delayHours, 24);
    assert.equal(row.overdue, false, '首发按时 ⇒ 不得被后来的重发拖成超期');
  } finally {
    s.close();
  }
});

test('S-9：时限来自 rules（改时限 ⇒ 超期判定跟着变）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's2', endsAt: '2026-10-10' });
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-12T00:00:00.000Z'); // 结束 +48h
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    assert.equal(out.stages.find((x) => x.stageId === f.stage.id).overdue, false, '48h < 72h ⇒ 不超期');

    const lax = structuredClone(s.rules);
    lax.compliance.readiness.publishDeadlineHours = 24;
    const out2 = readinessSummary({ db: s.db, rules: lax, now: '2026-10-20T12:00:00.000Z' }).s9;
    assert.equal(out2.stages.find((x) => x.stageId === f.stage.id).overdue, true, '时限改成 24h ⇒ 48h 必须超期');
  } finally {
    s.close();
  }
});

// ── 配置层机器闸 ──────────────────────────────────────────────────────

test('配置闸：readiness 三个阈值非法 ⇒ validateRules 报错（拒绝启动）', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.compliance.readiness.minReviewCoveragePercent = 0;
  bad.compliance.readiness.publishDeadlineHours = -1;
  bad.compliance.readiness.minTeamsForScale = 0;
  const errs = validateRules(bad);
  assert.ok(errs.some((e) => e.includes('minReviewCoveragePercent')), '覆盖率下限 0 必须报错');
  assert.ok(errs.some((e) => e.includes('publishDeadlineHours')), '时限负数必须报错');
  assert.ok(errs.some((e) => e.includes('minTeamsForScale')), '规模门槛 0 必须报错');
});

test('配置闸：覆盖率下限 > 100 也必须报错（否则闸永远红）', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.compliance.readiness.minReviewCoveragePercent = 101;
  assert.ok(validateRules(bad).some((e) => e.includes('minReviewCoveragePercent')));
});

// ── HTTP 端点 ────────────────────────────────────────────────────────

function seedCommittee(db) {
  const admin = createUser(db, { name: '组委会', phone: '13700000001', password: 'pw' });
  setSuperadmin(db, admin.id);
  const adminUser = getUserById(db, admin.id);
  const plain = createUser(db, { name: '普通用户', phone: '13700000002', password: 'pw' });
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, plain.id, 'admin');
  return { admin: adminUser, plain };
}

test('HTTP：GET /api/readiness 未登录 ⇒ 401', async () => {
  const s = setup();
  try {
    const res = await callJson(s.app, 'GET', '/api/readiness');
    assert.equal(res.status, 401);
  } finally {
    s.close();
  }
});

test('HTTP：GET /api/readiness 登录但无 audit:read ⇒ 403（**不是** 200+空集）', async () => {
  const s = setup();
  try {
    const outsider = createUser(s.db, { name: '路人', phone: '13700000003', password: 'pw' });
    const token = createSession(s.db, outsider.id).token;
    const res = await callJson(s.app, 'GET', '/api/readiness', { token });
    // ⛔ 空集会被读成「各项都达标」⇒ 必须 403
    assert.equal(res.status, 403);
  } finally {
    s.close();
  }
});

test('HTTP：GET /api/readiness 组委会 ⇒ 200 且给出 S-7~S-10 四段结构', async () => {
  const s = setup();
  try {
    const { admin } = seedCommittee(s.db);
    const token = createSession(s.db, admin.id).token;
    const res = await callJson(s.app, 'GET', '/api/readiness', { token });
    assert.equal(res.status, 200);
    const body = res.json;
    for (const k of ['s7', 's8', 's9', 's10']) {
      assert.ok(body[k], `返回体必须含 ${k} 段`);
    }
    assert.equal(typeof body.s7.teamCount, 'number');
    assert.equal(typeof body.s9.overdueCount, 'number');
    assert.equal(body.s10.met, null, 'S-10 需要真实赛事数据 ⇒ 不得假装判达标');
  } finally {
    s.close();
  }
});

test('HTTP：GET /api/readiness?editionId=不存在 ⇒ 404（不静默退回「当届」）', async () => {
  const s = setup();
  try {
    const { admin } = seedCommittee(s.db);
    const token = createSession(s.db, admin.id).token;
    const res = await callJson(s.app, 'GET', '/api/readiness?editionId=ed-not-exist', { token });
    assert.equal(res.status, 404);
  } finally {
    s.close();
  }
});

// ── 汇总 ─────────────────────────────────────────────────────────────

test('汇总：S-8 有任何一个赛段不达标 ⇒ 整体不达标；S-9 超期数 > 0 ⇒ 不达标', () => {
  const s = setup();
  try {
    const f1 = seedStage(s.db, { key: 's1', teamCount: 2 });
    fillReviews(s.db, f1.stage, f1.teams, [f1.judgeA, f1.judgeB]); // 满覆盖
    const f2 = seedStage(s.db, { key: 's2', teamCount: 2 });
    fillReviews(s.db, f2.stage, f2.teams, [f2.judgeA]); // 半覆盖 ⇒ 50%

    const sum = readinessSummary({ db: s.db, rules: s.rules, now: NOW });
    assert.equal(sum.s8.met, false, '有一个赛段不达标 ⇒ 整体不达标');
    assert.equal(sum.s8.worstCoveragePercent, 50, '最差赛段就是那个 50% 的');
    assert.equal(sum.s8.worstStageId, f2.stage.id);
    assert.equal(sum.s7.teamCount, 4, '两届各 2 队 ⇒ 共 4 支（seedStage 每建一个赛段建一届）');
  } finally {
    s.close();
  }
});

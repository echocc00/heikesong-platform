// platform/test/review-progress-scope.test.js —— P9.1 修复轮：评审/发榜的「进度口径」自洽闸
//
// ⛔ 起因（真机复验抓出，2026-10-22 —— 真浏览器 + 真机代码 + 真机 Node + 独立数据目录）：
//   ① **评委视角**同一屏出现「0 我的已交 / 应交 20 格 / 完成度 0%」**和**「本赛段的评分都交了」
//      —— 两个说法互相打架（DP-89「标签必须跟着值走」的同款事故）。
//   ② **发榜页**在「一格都没打」时显示「名册里的队伍都有打分 / 可以执行计算发榜」，
//      真发榜后引擎对每队每维度产出 `dimension_no_scores` 告警（实测 30 条）。
//   ③ 演示适配器的「应交 N 格」**漏乘评委数** ⇒ 演示站与正式站**数值**差 6 倍
//      （形状一致，所以 P8 的 parity 闸抓不到 —— 它只比形状）。
//
//   根因（后端）：`getReviewState` 给「**没有本赛段席位**」的账号算出 total = 队伍数 × 维度数，
//   却又把 missing 留空（missing 只在有席位时才算）⇒ {submitted:0, total:20, missing:[]} 自相矛盾；
//   前端再把「missing 为空」当「都交了」⇒ 矛盾被放大成一句**假话**。
//
// ── 三条硬判据 ────────────────────────────────────────────────────────────
//   ① 没有席位 ⇒ total 必须是 0（他在这个赛段没有任何属于自己的格子）；
//   ② 前端状态行必须由**数字**判定，不得由「missing 为空」推断「都交了」；
//   ③ 演示适配器的进度**数值**必须与真实后端同口径（形状对 ≠ 数值对）。
//
// 规则溯源：
//   - 「可见性与授权在 API 层裁决」→ 全局约束
//   - 「写路径由评委席把门」→ src/services/review.js 的 assertVotingJudge
//   - 「DP-89 可选数量的标签必须跟着值一起出现/消失」「DP-87 数字与标签不许错位」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { getReviewState } from '../src/services/review.js';
import { reviewHtml } from '../web/views/review.js';
import { publishHtml } from '../web/views/publish.js';
import { buildDemoState, demoReviewBoard } from '../web/api.demo.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-22T10:00:00.000Z';
const { rules } = loadRules(rulesDir);

/** final 权重表里的评委席维度（企业席与自评席不算评委的格子）。 */
const FINAL_JUDGE_DIMS = rules.scoring.final.dimensions.filter((d) => d.seat === 'judge').map((d) => d.key);

// ══════════════════════════════════════════════════════════════════
// 一、后端口径：submitted / total / missing 必须自洽
// ══════════════════════════════════════════════════════════════════

/** 造一个「2 队 × 2 评委 + 1 个无席位账号」的赛段。 */
function setupStage() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-scope-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900000061', password: 'pw' });
  const judge1 = createUser(db, { name: '评委甲', phone: '13900000062', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000063', password: 'pw' });
  const outsider = createUser(db, { name: '无席位账号', phone: '13900000064', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000065', password: 'pw' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: null, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, { editionId: edition.id, name: '一队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW });
  const team2 = insertTeam(db, { editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's5', name: '落地', kind: 'final',
    startsAt: '2026-10-29', endsAt: '2026-10-31', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge1.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  // 观察员席**无投票权**（R-JDG-11）⇒ 不得计入应交格数（这一条要有测试盯着，
  // 否则「把观察员也算进去」这种改动会静默改变全赛段的完成度分母）。
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });
  return { db, close, dataDir, stage, admin, judge1, judge2, outsider, observer, team1, team2 };
}

test('后端口径：组委会视角 total = 席位数 × 队伍数 × 维度数', () => {
  const s = setupStage();
  try {
    const st = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(st.total, 2 * 2 * FINAL_JUDGE_DIMS.length, `实际 ${st.total}`);
    assert.equal(st.missing.length, st.total, '一格没交 ⇒ missing 数量 = total');
    assert.equal(st.submitted, 0);
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：有席位的评委 total = 队伍数 × 维度数（只看自己那一份）', () => {
  const s = setupStage();
  try {
    const st = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.judge1.id, isAdmin: false },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(st.total, 2 * FINAL_JUDGE_DIMS.length, `实际 ${st.total}`);
    assert.equal(st.missing.length, st.total);
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：**没有席位**的账号 total 必须是 0（不能算出不属于他的格子）', () => {
  const s = setupStage();
  try {
    const st = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.outsider.id, isAdmin: false },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(st.total, 0, `无席位账号的 total 应为 0，实际 ${st.total}`);
    assert.equal(st.missing.length, 0);
    assert.equal(st.submitted, 0);
    // ⛔ 三个数必须自洽：submitted <= total，且 missing 为空时不可能 total > submitted
    assert.ok(st.submitted <= st.total, 'submitted 不能大于 total');
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：dimensionProgress 的 total 与总 total 同源（席位因子一致）', () => {
  const s = setupStage();
  try {
    const admin = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    for (const dim of FINAL_JUDGE_DIMS) {
      assert.equal(admin.dimensionProgress[dim].total, 2 * 2, `维度 ${dim} 的 total 不对`);
    }
    const outsider = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.outsider.id, isAdmin: false },
      dimensions: FINAL_JUDGE_DIMS,
    });
    for (const dim of FINAL_JUDGE_DIMS) {
      assert.equal(outsider.dimensionProgress[dim].total, 0, `维度 ${dim} 对无席位账号必须是 0`);
    }
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：观察员席无投票权 ⇒ 不得计入应交格数（R-JDG-11）', () => {
  const s = setupStage();
  try {
    const admin = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    // 名册上坐着 3 个人（2 评委 + 1 观察员），但只有 2 个人有投票权
    assert.equal(admin.total, 2 * 2 * FINAL_JUDGE_DIMS.length,
      `观察员被算进应交格数了（实际 ${admin.total}）`);
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

// ══════════════════════════════════════════════════════════════════
// 二、前端文案：状态行必须由数字判定
// ══════════════════════════════════════════════════════════════════

function board(over = {}) {
  return {
    stage: { id: 'stage_final', key: 'S5', name: '落地', kind: 'final', status: 'open', scoringConfigKey: 'final' },
    dimensions: FINAL_JUDGE_DIMS.map((k) => ({ key: k, name: k, weight: 0.25, seat: 'judge' })),
    judgeDimensions: FINAL_JUDGE_DIMS.map((k) => ({ key: k, name: k, weight: 0.25, seat: 'judge' })),
    teams: [{ id: 't_alpha', name: '拾光队', taskPackageTitle: '库存周转' }],
    myScores: [],
    progress: { scope: 'stage', submitted: 0, total: 4, missing: [], dimensionProgress: {} },
    ...over,
  };
}

test('前端：total=0 且缺格为空 ⇒ 不许说「都交了」（那是把「没有格子」当成「交齐了」）', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'stage', submitted: 0, total: 0, missing: [], dimensionProgress: {} } }) });
  assert.ok(!html.includes('都交了'), 'total=0 时绝不能出现「都交了」');
  assert.ok(html.includes('还没有需要打分的格子'), '应当说明「这个赛段没有需要打分的格子」');
});

test('前端：无席位的评委（submitted=0 / total>0 / missing 空）⇒ 仍不许说「都交了」', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'mine', submitted: 0, total: 20, missing: [], dimensionProgress: {} } }) });
  assert.ok(!html.includes('都交了'), 'submitted < total 时绝不能出现「都交了」');
  assert.ok(html.includes('还差 20 格'), '应当说清还差几格');
});

test('前端：真的交齐了（submitted >= total > 0）才可以说「都交了」', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'stage', submitted: 4, total: 4, missing: [], dimensionProgress: {} } }) });
  assert.ok(html.includes('都交了'), '交齐了就该说都交了');
});

test('前端：还有缺格 ⇒ 显示缺格数（不许出现「都交了」）', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'stage', submitted: 2, total: 4, missing: [{ teamId: 't_alpha', dimension: 'innovation' }, { teamId: 't_alpha', dimension: 'feasibility' }], dimensionProgress: {} } }) });
  assert.ok(!html.includes('都交了'));
  assert.ok(html.includes('还差 2 格'), '应当给出缺格数');
});

test('前端·发榜页：一格都没打（total=0）⇒ 不许说「名册里的队伍都有打分」', () => {
  const html = publishHtml({ board: board({ progress: { scope: 'stage', submitted: 0, total: 0, missing: [], dimensionProgress: {} } }), result: null });
  assert.ok(!html.includes('都有打分'), 'total=0 时绝不能出现「都有打分」');
  assert.ok(html.includes('一格都还没打'), '应当直说一格都没打');
});

test('前端·发榜页：有缺格 ⇒ 不许说「都有打分」', () => {
  const html = publishHtml({ board: board({ progress: { scope: 'stage', submitted: 1, total: 4, missing: [{ teamId: 't_alpha' }], dimensionProgress: {} } }), result: null });
  assert.ok(!html.includes('都有打分'));
  assert.ok(html.includes('还缺打分'), '应当提示还有队伍缺打分');
});

test('前端·发榜页：交齐了才可以说「都有打分」', () => {
  const html = publishHtml({ board: board({ progress: { scope: 'stage', submitted: 4, total: 4, missing: [], dimensionProgress: {} } }), result: null });
  assert.ok(html.includes('都有打分'));
});

// ══════════════════════════════════════════════════════════════════
// 三、演示适配器：**数值**必须与真实后端同口径
// ══════════════════════════════════════════════════════════════════

test('演示适配器：应交格数 = 席位数 × 队伍数 × 维度数（与真实后端同口径）', () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const state = buildDemoState({
    ...seed,
    judges: [
      { id: 'j1', name: '评委一', seat: 'judge' },
      { id: 'j2', name: '评委二', seat: 'judge' },
      // 观察员**无投票权**（R-JDG-11）：演示侧也必须不把它算进应交格数
      { id: 'j_obs', name: '观察员', seat: 'observer' },
    ],
    teams: [
      { id: 't1', name: '一队', packageId: 'tp_retail', captainId: 'mba_captain', memberIds: [] },
      { id: 't2', name: '二队', packageId: 'tp_retail', captainId: 'mba_captain2', memberIds: [] },
    ],
    reviews: {},
  });
  const b = demoReviewBoard({ state, rules, stageId: 'stage_final' });
  assert.equal(b.teams.length, 2);
  assert.equal(b.progress.total, 2 * 2 * b.judgeDimensions.length, `演示的应交格数不对：${b.progress.total}`);
  assert.equal(b.progress.missing.length, b.progress.total, '演示的缺格数必须 = 应交格数');
  for (const d of b.judgeDimensions) {
    assert.equal(b.progress.dimensionProgress[d.key].total, 2 * 2, `维度 ${d.key} 的 total 不对`);
  }
});

test('演示适配器：与真实后端同数据 ⇒ 进度数值逐项相等（形状对不等于数值对）', () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const state = buildDemoState({
    ...seed,
    judges: [
      { id: 'j1', name: '评委一', seat: 'judge' },
      { id: 'j2', name: '评委二', seat: 'judge' },
      // 观察员**无投票权**（R-JDG-11）：演示侧也必须不把它算进应交格数
      { id: 'j_obs', name: '观察员', seat: 'observer' },
    ],
    teams: [
      { id: 't1', name: '一队', packageId: 'tp_retail', captainId: 'mba_captain', memberIds: [] },
      { id: 't2', name: '二队', packageId: 'tp_retail', captainId: 'mba_captain2', memberIds: [] },
    ],
    reviews: {},
  });
  const demo = demoReviewBoard({ state, rules, stageId: 'stage_final' });

  const s = setupStage();
  try {
    const real = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(demo.progress.total, real.total, '演示与真实后端的应交格数必须一致');
    assert.equal(demo.progress.submitted, real.submitted, '演示与真实后端的已交格数必须一致');
    assert.equal(demo.progress.missing.length, real.missing.length, '演示与真实后端的缺格数必须一致');
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('演示种子：席型词表必须与真实后端一致（judge | enterprise | observer）', () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const KNOWN = new Set(['judge', 'enterprise', 'observer']);
  for (const j of seed.judges ?? []) {
    assert.ok(KNOWN.has(j.seat), `评委 ${j.id} 的席型「${j.seat}」不在真实后端词表内`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 四、机器闸：noticeState 的参数名写错 ⇒ 说明文字被**静默丢弃**
// ══════════════════════════════════════════════════════════════════

/**
 * 扫一个源码里的 `noticeState(...)` 调用，返回「传了 text」的调用所在行号。
 * ⛔ 这个函数自身必须有判别力 —— 所以下面有**阳性对照**：
 *    把判据改坏（例如让它永远返回空），阳性对照会立刻失败。
 */
function scanNoticeTextArgs(src) {
  const hits = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('noticeState(', from);
    if (at === -1) break;
    let depth = 0;
    let end = at;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    const call = src.slice(at, end + 1);
    if (/(^|[^.\w])text\s*:/.test(call)) {
      hits.push(src.slice(0, at).split('\n').length);
    }
    from = end + 1;
  }
  return hits;
}

test('机器闸：任何视图都不得给 noticeState 传 text（它只认 items / list）', () => {
  // 阳性对照：扫描器必须真的抓得到（否则这条闸是「一条都不判违规」的假绿）
  assert.equal(scanNoticeTextArgs('noticeState({ tone: "info", title: "x", text: "y" });').length, 1,
    '阳性对照失败：扫描器抓不到传了 text 的调用');
  assert.equal(scanNoticeTextArgs('noticeState({ tone: "info", title: "x", items: ["y"] });').length, 0,
    '阳性对照失败：扫描器把正常的 items 误判成 text');

  const viewsDir = join(here, '..', 'web', 'views');
  const offenders = [];
  for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(viewsDir, file), 'utf8');
    for (const line of scanNoticeTextArgs(src)) offenders.push(`${file}:${line}`);
  }
  assert.equal(offenders.length, 0,
    `下列位置给 noticeState 传了 text ⇒ 说明文字**不会渲染**（它只认 items）：\n  ${offenders.join('\n  ')}`);
});

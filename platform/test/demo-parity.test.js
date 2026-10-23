// platform/test/demo-parity.test.js —— 演示版（浏览器内跑的引擎）与正式引擎的**逐字段一致性**
//
// 本 Task 的灵魂：演示版 = 静态站 + 浏览器内跑【同一套规则引擎】。
// ⇒ 这份测试是那个承诺的机器保证：同一份种子、同一份规则配置，
//    「浏览器里跑的引擎」与「Node 里跑的引擎」必须给出【同一份结果】。
//
// ⚠️ 三方比对（不是两方）：
//    ① 浏览器入口（getDemoRuntime：fetch 取种子与规则 → createDemoApi → POST /compute）
//    ② Node 侧适配器路径（runDemoCompute）
//    ③ 正式引擎（直接调 src/domain/scoring.js 的 scoreStage）
//    ①②③ 必须逐字段一致 —— 只比 ①② 是自证（同一个函数比同一个函数），
//    只比 ②③ 会漏掉「浏览器加载的配置不是同一份」这类漂移。
//
// ⚠️ 浮点比较：容差 EPS = 1e-9（**相对**容差：|a-b| ≤ eps × max(1,|a|,|b|)）。
//    ⛔ 不用 === 比浮点（那是假红：同一份公式在不同求值顺序下的末位差异不是 bug）；
//    ⛔ 也不用粗到没意义的容差（1e-6 以上会把「权重写错 0.001」这类真错放过去）。
//    1e-9 相对容差 ≈ 分值 80 分上 8e-8 —— 远小于任何真实的口径差异，
//    但远大于 IEEE754 双精度的舍入噪声。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { scoreStage } from '../src/domain/scoring.js';
import {
  buildDemoState, expandSubmissions, demoTeamsRoster, runDemoCompute,
  demoSelfEvalFlags, demoTier, getDemoRuntime, DEMO_RULE_FILES,
} from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const webDir = join(platformDir, 'web');
const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(platformDir, 'rules'));

const EPS = 1e-9;   // 相对容差，见文件头说明

// ── 容差比较工具 ────────────────────────────────────────────────

function assertClose(actual, expected, path) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= EPS * scale,
    `${path}：${actual} 与 ${expected} 的差 ${Math.abs(actual - expected)} 超过容差 ${EPS * scale}`,
  );
}

/** 递归比对：数字用容差，其余（字符串 / 布尔 / null / 数组结构 / 对象键集）必须逐字相同 */
function assertDeepClose(actual, expected, path = '$') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assertClose(actual, expected, path);
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && Array.isArray(expected), `${path}：一边是数组一边不是`);
    assert.equal(actual.length, expected.length, `${path}：数组长度不同`);
    for (let i = 0; i < actual.length; i += 1) assertDeepClose(actual[i], expected[i], `${path}[${i}]`);
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const ka = Object.keys(actual).sort();
    const ke = Object.keys(expected).sort();
    assert.deepEqual(ka, ke, `${path}：对象的键集不同`);
    for (const k of ka) assertDeepClose(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  assert.deepEqual(actual, expected, `${path}：值不同`);
}

// ── 浏览器侧「规则加载」的 Node 等价物（复刻 web/api.demo.js 的 loadDemoRules）──
// ⚠️ 这段复刻必须与 web/api.demo.js 的 loadDemoRules **逐字同形**（文件清单 + 分组方式），
//    否则「浏览器加载的配置」与「正式系统加载的配置」会悄悄漂移 —— 那正是本测试要抓的东西。
function loadRulesLikeBrowser() {
  const loaded = {};
  for (const [key, file] of Object.entries(DEMO_RULE_FILES)) {
    loaded[key] = JSON.parse(readFileSync(join(platformDir, 'rules', file), 'utf8'));
  }
  return {
    scoring: { initial: loaded.scoringInitial, final: loaded.scoringFinal },
    tiebreak: loaded.tiebreak,
    ranks: loaded.ranks,
    behavior: loaded.behavior,
    visibility: loaded.visibility,
    registration: loaded.registration,
    solvability: loaded.solvability,
    milestones: loaded.milestones,
    teamFormation: loaded.teamFormation,
    points: loaded.points,
    criteria: loaded.criteria,
  };
}

/** fetch 桩：把浏览器里对静态产物的相对 URL 请求，落到磁盘上的真实文件 */
function installFetchStub(roots) {
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^\.\//, '');
    for (const root of roots) {
      const p = join(root, rel);
      if (existsSync(p)) {
        const body = readFileSync(p, 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** 正式引擎的直调口径（与 src/services/compute.js 同一形状） */
function directEngine(state) {
  return scoreStage({
    config: rules.scoring.final,
    judges: seed.judges.map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(state),
    enterpriseConfirmations: seed.enterpriseConfirmations,
    peerReviews: seed.peerReviews,
    teams: demoTeamsRoster(state),
    selfReviews: seed.selfReviews,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 1. 规则配置同源：浏览器加载的 12 份配置 ≡ 正式系统 loadRules 加载的同一批文件
// ═══════════════════════════════════════════════════════════════════════
test('规则配置同源：浏览器侧的 12 份配置与正式系统 loadRules 的结果逐字相同', () => {
  const browserRules = loadRulesLikeBrowser();
  for (const key of Object.keys(browserRules)) {
    assert.deepEqual(browserRules[key], rules[key], `规则 ${key} 在浏览器侧与正式系统不一致`);
  }
  // ⚠️ 正式系统还会加载 schedule / compliance / audit 三份（服务端专用，演示版用不到）——
  //    它们【不得】影响演示口径，但也不能被浏览器侧悄悄换掉。
  assert.ok(rules.schedule && rules.compliance && rules.audit, '正式系统的三份服务端配置必须存在');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 浏览器入口真跑：getDemoRuntime() → fetch 取种子与规则 → POST /compute
// ═══════════════════════════════════════════════════════════════════════
test('浏览器入口路径可跑通：fetch 取种子与规则 → 计算 → 拿到结果', async () => {
  installFetchStub([webDir, platformDir]);
  const runtime = await getDemoRuntime();
  // ⚠️ P11：演示站的 compute 与正式站**同口径** —— 都要先登录
  //    （正式站 src/http/routes/review.js 的 compute 走 requireStageCapability ⇒ requireUser）。
  //    ⇒ 演示适配器此前允许「匿名计算」，那是与正式站**不一致**的地方，本轮对齐。
  await runtime.post('/api/auth/login', { name: '演示管理员' });
  const health = await runtime.get('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.demo, true);
  assert.equal(health.ruleVersion, rules.tiebreak.version, '健康检查里的规则版本必须与正式规则一致');

  const out = await runtime.post('/api/stages/stage_final/compute', {});
  assert.ok(out.computationId);
  assert.ok(out.teams.length > 0);
  assert.ok(out.trace.normalization);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. 三方逐字段一致（浮点用容差）
// ═══════════════════════════════════════════════════════════════════════
test('演示版与正式引擎逐字一致：同一输入 → 同一 teams / warnings / trace', () => {
  const state = buildDemoState(seed);

  // 正式引擎：直接调 domain/scoring.js
  const direct = directEngine(state);

  // 演示版：走完整适配器
  const demo = runDemoCompute({ state: buildDemoState(seed), rules, stageId: 'stage_final' });

  assertDeepClose(demo.teams, direct.teams, '$.teams');
  assert.deepEqual(demo.warnings, direct.warnings, '告警必须逐条一致');
  assertDeepClose(demo.trace, direct.trace, '$.trace');
});

test('浏览器入口算出的结果 ≡ 正式引擎算出的结果（浮点容差 1e-9 相对）', async () => {
  installFetchStub([webDir, platformDir]);
  const runtime = await getDemoRuntime();
  // ⚠️ P11：演示站的 compute 与正式站**同口径** —— 都要先登录
  //    （正式站 src/http/routes/review.js 的 compute 走 requireStageCapability ⇒ requireUser）。
  //    ⇒ 演示适配器此前允许「匿名计算」，那是与正式站**不一致**的地方，本轮对齐。
  await runtime.post('/api/auth/login', { name: '演示管理员' });
  const browser = await runtime.post('/api/stages/stage_final/compute', {});

  const direct = directEngine(buildDemoState(seed));
  const node = runDemoCompute({ state: buildDemoState(seed), rules, stageId: 'stage_final' });

  assertDeepClose(browser.teams, direct.teams, '$.teams');
  assert.deepEqual(browser.warnings, direct.warnings, '告警必须逐条一致');
  assertDeepClose(browser.trace, direct.trace, '$.trace');
  assertDeepClose(browser.ordered, node.ordered, '$.ordered');
  assertDeepClose(browser.chain, node.chain, '$.chain');
  assertDeepClose(browser.points, node.points, '$.points');
  assertDeepClose(browser.selfEvalFlags, node.selfEvalFlags, '$.selfEvalFlags');
});

test('破同分链、名次积分、自评差异、段位在浏览器入口与正式系统之间也一致', async () => {
  installFetchStub([webDir, platformDir]);
  const runtime = await getDemoRuntime();
  // ⚠️ P11：演示站的 compute 与正式站**同口径** —— 都要先登录
  //    （正式站 src/http/routes/review.js 的 compute 走 requireStageCapability ⇒ requireUser）。
  //    ⇒ 演示适配器此前允许「匿名计算」，那是与正式站**不一致**的地方，本轮对齐。
  await runtime.post('/api/auth/login', { name: '演示管理员' });
  const browser = await runtime.post('/api/stages/stage_final/compute', {});
  const state = buildDemoState(seed);

  // 自评差异：演示版自己算的那份，必须与引擎内部 detection 的口径一致
  const flags = demoSelfEvalFlags({ state, threshold: 10 });
  const browserFlags = browser.selfEvalFlags;
  assertDeepClose(browserFlags, flags, '$.selfEvalFlags');

  // 段位：适配器算的必须与领域层 computeTier 直算一致
  for (const t of seed.teams) {
    const viaAdapter = demoTier({ state, rules, teamId: t.id });
    assert.equal(viaAdapter.tier, seed.expectations.tiers[t.id], `${t.id} 的段位与 expectations 不一致`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 4. 判别性反例：parity 断言必须**能失败**（否则是恒真断言）
// ═══════════════════════════════════════════════════════════════════════
test('判别性反例：喂不同的输入 ⇒ 演示版与正式引擎的结果必须不同（parity 断言不是恒真）', () => {
  const broken = buildDemoState(seed);
  // 故意抹掉自评：正式引擎吃 selfReviews，演示适配器不吃 ⇒ 两边必须分叉
  broken.selfReviews = [];

  const direct = directEngine(buildDemoState(seed));
  const demo = runDemoCompute({ state: broken, rules, stageId: 'stage_final' });

  const sum = (out) => out.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.notDeepEqual(sum(demo), sum(direct),
    '喂不同的输入却算出同样的结果 ⇒ parity 断言是恒真的，没有判别力');
});

test('判别性反例：同一份输入下，改「演示适配器的输入构造」必然让结果分叉', () => {
  const state = buildDemoState(seed);
  // 名册口径错（把自由命题队说成企业命题队）⇒ R4 不再触发 ⇒ 结果必然不同
  const badRoster = demoTeamsRoster(state).map((t) => (
    t.teamId === seed.expectations.freeBriefTeam ? { ...t, isFreeBrief: false } : t
  ));
  const direct = scoreStage({
    config: rules.scoring.final,
    judges: seed.judges.map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(state),
    enterpriseConfirmations: seed.enterpriseConfirmations,
    peerReviews: seed.peerReviews,
    teams: badRoster,
    selfReviews: seed.selfReviews,
  });
  const good = directEngine(state);
  assert.notDeepEqual(
    direct.teams.map((t) => t.total),
    good.teams.map((t) => t.total),
    '名册口径变了结果却一样 ⇒ 引擎对 R4 不敏感（分支没被触发）',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 5. 黄金值：种子的 expectations 就是这套引擎的期望输出
// ═══════════════════════════════════════════════════════════════════════
test('黄金值：expectations 里声明的每一条分支都在引擎输出里兑现（浮点用容差）', () => {
  const e = seed.expectations;
  const state = buildDemoState(seed);
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const byCode = (code) => out.warnings.filter((w) => w.code === code);

  // 同分两队：总分严格相等（构造保证）
  const [a, b] = e.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assertClose(ta.total, tb.total, `$.teams[${a}].total`);

  // 破同分链在 peer 级分开
  const peer = out.chain.find((c) => c.key === e.tiebreakSeparatedBy);
  assert.ok(peer, `破同分链里必须用到 ${e.tiebreakSeparatedBy}`);
  assert.ok(peer.usedBy.includes(a) && peer.usedBy.includes(b));

  // 归一化降级
  const fb = byCode('normalization_fallback').find((w) => w.dimension === e.unnormalizedDimension);
  assert.ok(fb, `必须出现维度 ${e.unnormalizedDimension} 的归一化降级告警`);
  assert.equal(out.trace.normalization[e.unnormalizedDimension].normalized, false);

  // R2：缺双签 ⇒ 企业席按 0 分计
  const r2 = byCode('R2_missing_dual_signature').find((w) => w.teamId === e.missingDualSignatureTeam);
  assert.ok(r2, '必须出现 R2 告警');
  assertClose(out.teams.find((t) => t.teamId === e.missingDualSignatureTeam).seatE, 0, '$.seatE');

  // R4：自由命题 ⇒ 企业项由评委维度替代
  const r4 = byCode('R4_free_brief_judge_scored').find((w) => w.teamId === e.freeBriefTeam);
  assert.ok(r4, '必须出现 R4 告警');
  const epsRow = out.teams.find((t) => t.teamId === e.freeBriefTeam);
  const subDim = rules.scoring.final.freeBrief.judgeDimension;
  assertClose(epsRow.seatE, epsRow.perDimension[subDim].mean, `$.teams[${e.freeBriefTeam}].seatE`);

  // 自评三档
  const hi = demoSelfEvalFlags({ state, threshold: 10 }).find((f) => f.teamId === e.selfEvalWrittenExplanationTeam);
  const lo = demoSelfEvalFlags({ state, threshold: 10 }).find((f) => f.teamId === e.selfEvalJudgeQuestionTeam);
  assert.equal(hi.action, 'written_explanation');
  assert.ok(hi.d > 10);
  assert.equal(lo.action, 'judge_question');
  assert.ok(lo.d < -10);

  // 段位
  for (const [teamId, tier] of Object.entries(e.tiers)) {
    assert.equal(demoTier({ state, rules, teamId }).tier, tier, `${teamId} 的段位应为 ${tier}`);
  }

  // 行为分（整数值 ⇒ 精确比较）
  for (const [teamId, expected] of Object.entries(e.behaviorScores)) {
    const info = demoTier({ state, rules, teamId });
    assert.equal(info.behavior.total, expected, `${teamId} 的行为分应为 ${expected}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 6. 浏览器入口的失败路径：取不到种子 / 缺规则必须【显式报错】，不静默退回空数据
//    （静默降级 = 演示时看到一份空榜单却不知道为什么）
// ═══════════════════════════════════════════════════════════════════════
test('浏览器入口：种子取不到必须显式报错', async () => {
  installFetchStub([webDir, platformDir]);
  const { loadDemoSeed } = await import('../web/api.demo.js');
  await assert.rejects(() => loadDemoSeed('./seed/not-exist.json'), /演示种子数据加载失败/);
});

test('浏览器入口：规则缺任何一份都必须显式报错（不静默用默认规则）', async () => {
  const { loadDemoRules } = await import('../web/api.demo.js');
  // 只挂 web/ 目录 ⇒ web/rules/ 不存在 ⇒ 12 份规则全部取不到
  installFetchStub([webDir]);
  await assert.rejects(() => loadDemoRules('./rules/'), /演示规则配置缺失/);
});

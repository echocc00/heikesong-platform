// platform/test/demo-engine.test.js —— 演示版适配器（浏览器内真实运行规则引擎）
//
// 规则溯源：
//   - 「演示版 = 静态站 + 浏览器内跑同一套规则引擎」→ P6 计划 Task 5【本 Task 的灵魂】+ 设计文档 §14.3
//   - 「同分 → 互评破同分」→ S7 §3.3 + 冲突裁决 C-03
//   - 「归一化降级告警不静默」→ S7 §3.1 + C-05
//   - 「R2 缺双签 → 企业项按 0 分计」→ S7 §2.4 R2
//   - 「自评差异三档」→ S7 §4.3 + R-JDG-13
//   - 「段位 = 里程碑 + 数据/原型 + 业务部门签字」→ S10 §2.2 + R-PTS-01~04
//   - 「行为分只做垫底排序、不进总分」→ S10 §3.3 + R-PTS-08
//   - 「可见性在 API 层过滤（C 段及以上公示，D 段只给本人进度卡）」→ S10 §0.3 + 冲突裁决 C-02
//
// ⚠️ 本文件的断言全部落在**引擎的输出**上，不是种子里的自述 ——
//    种子（web/seed/demo-data.json）只是「每条分支的触发器」，分支有没有真的发生由这里判定。
//
// ⚠️ 判别性纪律：凡是「两种算法会给出同样结果」的期望值都不算数 ——
//    本文件用**构造出来的反例数据**（互评改同分 / 抹掉自评 / 段位标志与 criteria 矛盾）
//    保证每条断言都能区分「真按规则算」与「凑答案」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import {
  buildDemoState, expandSubmissions, runDemoCompute, demoSelfEvalFlags,
  demoTier, demoPerformanceCard, demoLeaderboard, demoPools, createDemoApi,
} from '../web/api.demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(here, '..', 'rules'));

function fresh() {
  return buildDemoState(seed);
}

test('打分矩阵能展开成 submissions', () => {
  const state = fresh();
  const subs = expandSubmissions(state);
  assert.ok(subs.length > 0);
  const first = subs[0];
  for (const k of ['judgeId', 'teamId', 'dimension', 'rawScore']) {
    assert.ok(k in first, `submissions 缺字段 ${k}`);
  }
  assert.equal(typeof first.rawScore, 'number');
});

test('两支设计为同分的队伍总分完全相等（构造保证，不靠手算）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assert.ok(ta && tb, '两支队伍都必须参与计算');
  assert.equal(ta.total, tb.total, '同分队伍的总分必须完全相等');
});

test('破同分链把同分队伍分开，且分开的那一级是 peer', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const ra = out.ordered.find((r) => r.teamId === a);
  const rb = out.ordered.find((r) => r.teamId === b);
  assert.notEqual(ra.rank, rb.rank, '同分队伍必须被破同分链分开');
  assert.ok(ra.rank < rb.rank, '互评分高的一方名次在前');
  const used = out.chain.find((c) => c.key === seed.expectations.tiebreakSeparatedBy);
  assert.ok(used, `破同分链里必须用到 ${seed.expectations.tiebreakSeparatedBy} 这一级`);
});

test('评委样本不足的维度会产生归一化降级告警（不静默）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const dim = seed.expectations.unnormalizedDimension;
  const label = rules.scoring.final.dimensions.find((d) => d.key === dim).name;
  const hit = out.warnings.find(
    (w) => w.code === 'normalization_fallback' && (String(w.message).includes(dim) || String(w.message).includes(label)),
  );
  assert.ok(hit, `必须出现维度 ${dim} 的归一化降级告警，实际告警：${JSON.stringify(out.warnings.map((w) => w.code))}`);
  assert.ok(out.trace && out.trace.normalization, 'trace 必须带 normalization 段');
  assert.ok(Object.keys(out.trace.normalization).length > 0, 'trace.normalization 不能是空的');
});

test('缺双签的企业确认会产生 R2 告警并按 0 分计', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const teamId = seed.expectations.missingDualSignatureTeam;
  const hit = out.warnings.find((w) => w.code === 'R2_missing_dual_signature');
  assert.ok(hit, '必须出现 R2_missing_dual_signature 告警');
  assert.ok(!hit.teamId || hit.teamId === teamId, `告警应指向 ${teamId}`);
});

test('行为分变化不影响总分（分轨在算法层，不靠人的自觉）', () => {
  const stateA = fresh();
  const stateB = fresh();
  stateB.behaviorEvents = stateB.behaviorEvents.map((e) => ({ ...e, points: 999, type: 'first_demo' }));
  const a = runDemoCompute({ state: stateA, rules, stageId: 'stage_final' });
  const b = runDemoCompute({ state: stateB, rules, stageId: 'stage_final' });
  const totalsA = a.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  const totalsB = b.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.deepEqual(totalsB, totalsA, '行为分变化不得影响总分');
});

test('自评差异检测：高的要书面说明，低的要评委提问', () => {
  const state = fresh();
  const flags = demoSelfEvalFlags({ state, threshold: 10 });
  const hi = seed.expectations.selfEvalWrittenExplanationTeam;
  const lo = seed.expectations.selfEvalJudgeQuestionTeam;
  const fHi = flags.find((f) => f.teamId === hi);
  const fLo = flags.find((f) => f.teamId === lo);
  assert.ok(fHi, `${hi} 必须触发自评差异告警`);
  assert.equal(fHi.action, 'written_explanation');
  assert.ok(fHi.d > 10);
  assert.ok(fLo, `${lo} 必须触发自评差异告警`);
  assert.equal(fLo.action, 'judge_question');
  assert.ok(fLo.d < -10);
});

test('段位按里程碑与业务部门签字判定', () => {
  const state = fresh();
  for (const [teamId, tier] of Object.entries(seed.expectations.tiers)) {
    const info = demoTier({ state, rules, teamId });
    assert.equal(info.tier, tier, `${teamId} 的段位应为 ${tier}，实际 ${info.tier}`);
  }
});

test('战绩卡：7 类里程碑勾选式，且不出现签字人', () => {
  const state = fresh();
  const card = demoPerformanceCard({ state, rules, teamId: 't_delta' });
  assert.equal(card.items.length, rules.milestones.items.length, '里程碑必须 7 类齐全');
  assert.ok(card.items.some((i) => i.achieved), 't_delta 必须有已达成项');
  const json = JSON.stringify(card);
  assert.ok(!json.includes('u_ent_mfg'), '⛔ 战绩卡不得出现签字人 id（S10 §0.3）');
});

test('榜单过可见性过滤后仍可读', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  const lb = demoLeaderboard({ state, rules, scope: 'rank', viewer: { id: 'demo_admin', teamId: 't_alpha' } });
  assert.ok(Array.isArray(lb.rows));
  assert.ok(lb.rows.length > 0, '榜单不能是空的');
  assert.ok(lb.rows[0].rank >= 1);
});

test('三池：项目池/人才池/资源池都有内容', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  assert.ok(demoPools({ state, rules, kind: 'projects' }).rows.length > 0);
  assert.ok(demoPools({ state, rules, kind: 'talents' }).rows.length > 0);
  assert.ok(demoPools({ state, rules, kind: 'resources' }).rows.length > 0);
});

test('演示适配器：完整流程走通（登录 → 报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡）', async () => {
  const api = createDemoApi({ storage: makeStorage(), seed, rules });

  const health = await api.get('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.demo, true);

  // ⚠️ 未登录必须【抛错】而不是返回 { status: 401 } ——
  //    真实后端 web/api.js 在 !res.ok 时抛错，web/app.js 的 restoreSession() 也靠 catch 兜 401。
  await assert.rejects(
    () => api.get('/api/me'),
    (err) => err.status === 401 && err.code === 'UNAUTHENTICATED',
    '未登录时 /api/me 必须以 401 拒绝',
  );

  const login = await api.post('/api/auth/login', { name: '演示管理员' });
  assert.equal(login.user.name, '演示管理员');

  const reg = await api.post('/api/registrations', {
    answers: {
      direction: [5, 5, 4, 5, 5], capability: [4, 5, 5, 4, 5], collaboration: [5, 4, 5, 5, 4],
      open: '希望把门店补货预测做成可落地的试点。',
    },
  });
  assert.ok(['S', 'A', 'B', 'C'].includes(reg.level), '报名必须算出等级');
  assert.ok(typeof reg.rawScore === 'number');

  const team = await api.post('/api/teams', { name: '演示新队', taskPackageId: 'tp_retail', memberIds: ['mba_captain', 'demo_member_1'] });
  assert.ok(team.id);

  const reviews = await api.post('/api/stages/stage_final/reviews', {
    items: [{ judgeId: 'j_lenient', teamId: 't_alpha', dimension: 'innovation', rawScore: 91 }],
  });
  assert.ok(reviews.submitted >= 1);

  const computed = await api.post('/api/stages/stage_final/compute', {});
  assert.ok(computed.computationId);
  assert.ok(computed.teams.length > 0);
  assert.ok(computed.trace);

  const lb = await api.get('/api/leaderboard/stage_final?scope=rank');
  assert.ok(lb.rows.length > 0);

  const tier = await api.get('/api/teams/t_gamma/tier');
  assert.equal(tier.tier, seed.expectations.tiers.t_gamma);

  const card = await api.get('/api/teams/t_gamma/performance-card');
  assert.ok(card.items.length > 0);

  const pub = await api.get('/api/public/leaderboard?editionId=ed_demo&token=demo');
  assert.ok(pub.rows.length > 0);
});

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 【实施补记 2026-10-21】规格的 12 个用例【逐字保留】（只改了 /api/me 的 401 断言形式，
// 见 D5-02）+ 追加 12 个**判别性**用例。
//
// 为什么必须追加：规格的 12 个用例里有一半是「存在性」断言（有条目、非空、7 类齐全）——
// 它们证明「适配器把数据搬过去了」，证明不了「算出来的是不是规则该给的结果」。
// 而本 Task 的灵魂恰恰是后者：演示版必须与正式系统**逐字段一致**。
// ⇒ 追加用例全部用**构造出来的反例数据**（互评改成同分 / 抹掉自评 / 段位标志与 criteria 矛盾），
//    保证「按规则算」与「凑答案」两种实现会被区分开。
// ═══════════════════════════════════════════════════════════════════════

test('追加·破同分告警不被丢弃（tiebreak_extra 不可用必须显式告警）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  assert.ok(Array.isArray(out.tiebreakWarnings), '必须单独给出破同分链的告警');
  const hit = out.tiebreakWarnings.find((w) => w.code === 'tiebreak_key_unusable');
  assert.ok(hit, '种子里没有 tiebreakExtra ⇒ 这一级不可用，必须告警（不静默当 0 分）');
});

test('追加·榜单告警按正式口径合并（计算告警 + 破同分告警，各带 source 标签）', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  const lb = demoLeaderboard({ state, rules, scope: 'rank', viewer: null });
  assert.ok(lb.warnings.length > 0, '榜单必须带告警');
  assert.ok(lb.warnings.some((w) => w.source === 'computation'), '必须有计算告警');
  assert.ok(lb.warnings.some((w) => w.source === 'tiebreak'), '必须有破同分告警');
  for (const w of lb.warnings) {
    assert.ok(w.message, '每条告警都要有人话正文');
    // ⛔ E184：**匿名访客**拿不到内部规则键（演示站与正式站同一把尺）
    assert.equal(w.code, undefined, '匿名访客不得拿到内部规则键');
  }
});

test('追加·段位榜：C 段及以上公示，D 段只给本人进度卡（可见性在 API 层过滤）', () => {
  const state = fresh();
  runDemoCompute({ state, rules, stageId: 'stage_final' });
  const board = demoLeaderboard({ state, rules, scope: 'tier', viewer: null });
  assert.equal(board.scope, 'tier');
  const ids = board.rows.map((r) => r.teamId);
  assert.ok(!ids.includes(seed.expectations.freeBriefTeam), 'D 段队伍不得出现在公示榜里');
  assert.ok(ids.length > 0, 'C 段及以上必须有队伍');
  for (const r of board.rows) assert.ok(r.tierRank >= 1, '公示行必须有段位名次');
  // ⚠️ 排序口径：段位高的在前（S → A → B → C）—— 判别性：顺序错了这条会红
  assert.equal(board.rows[0].tier, 'S', '段位最高的队伍必须排第一');
  assert.deepEqual(board.rows.map((r) => r.tier), ['S', 'A', 'B', 'C'], '段位榜必须按段位从高到低');
  // 本人视角：D 段队伍只出现在 selfProgress 里
  const mine = demoLeaderboard({ state, rules, scope: 'tier', viewer: { id: 'u', teamId: seed.expectations.freeBriefTeam } });
  assert.ok(mine.selfProgress, 'D 段本人必须拿到进度卡');
  assert.equal(mine.selfProgress.teamId, seed.expectations.freeBriefTeam);
  assert.ok(!mine.rows.some((r) => r.teamId === seed.expectations.freeBriefTeam), 'D 段不得进公示行');
});

test('追加·滚动总榜：scope=rolling，按积分排序', async () => {
  const api = createDemoApi({ storage: makeStorage(), seed, rules });
  // ⚠️ P11：演示站的 compute 与正式站**同口径** —— 都要先登录
  //    （正式站 src/http/routes/review.js 的 compute 走 requireStageCapability ⇒ requireUser）。
  await api.post('/api/auth/login', { name: '演示管理员' });
  await api.post('/api/stages/stage_final/compute', {});
  const rolling = await api.get('/api/leaderboard/rolling');
  assert.equal(rolling.scope, 'rolling', '滚动总榜的 scope 必须是 rolling');
  assert.ok(rolling.rows.length > 0);
  for (const r of rolling.rows) assert.equal(r.stages, 1);
});

test('追加·战绩卡形状与正式系统一致（achievedCount / total / benefits / neverUnlocks / signed）', () => {
  const state = fresh();
  const card = demoPerformanceCard({ state, rules, teamId: 't_delta' });
  assert.equal(card.total, rules.milestones.items.length);
  assert.equal(card.achievedCount, card.items.filter((i) => i.achieved).length);
  assert.ok(Array.isArray(card.benefits), '必须有权益列表');
  assert.ok(Array.isArray(card.neverUnlocks), '必须有「永不解锁」列表');
  assert.ok(card.neverUnlocks.includes('奖金'), '永不解锁项必须与 rules.ranks 一致');
  const signed = card.items.find((i) => i.key === 'pilot_contract');
  assert.ok(signed, 'pilot_contract 必须在 7 类里程碑里');
  assert.equal(signed.signed, true, '有业务部签字的里程碑必须显示已签');
  // 撤销的签字不算已签
  const revoked = fresh();
  revoked.signoffs = revoked.signoffs.map((sg) => (sg.teamId === 't_delta' ? { ...sg, revokedAt: '2026-10-20T00:00:00Z' } : sg));
  const card2 = demoPerformanceCard({ state: revoked, rules, teamId: 't_delta' });
  assert.equal(card2.items.find((i) => i.key === 'pilot_contract').signed, false, '撤销的签字不算已签');
});

test('追加·打分矩阵搬运不得改动任何一格原始分（逐格相等）', () => {
  const expected = [];
  for (const [judgeId, byTeam] of Object.entries(seed.reviews)) {
    for (const [teamId, byDim] of Object.entries(byTeam)) {
      for (const [dimension, rawScore] of Object.entries(byDim)) {
        expected.push(`${judgeId}|${teamId}|${dimension}|${rawScore}`);
      }
    }
  }
  const got = expandSubmissions(fresh()).map(
    (s) => `${s.judgeId}|${s.teamId}|${s.dimension}|${s.rawScore}`,
  );
  assert.deepEqual(got.sort(), expected.sort(),
    'submissions 必须与种子里的原始分【逐格相同】（整体平移 / 改一格都会被抓出来）');
});

test('追加·段位标志按 rules.criteria 推导，不采信数据里预置的标志（判别性）', () => {
  // 反例数据：签字部门是「市场部」（rules.criteria 的业务关键词命中），
  // 但数据里预置的 isBusinessDepartment 是 false。
  //   按 criteria 推导 ⇒ 业务部门签字成立 ⇒ t_delta 是 S 段；
  //   采信数据里的标志 ⇒ 没有业务签字 ⇒ t_delta 掉到 A 段。
  const state = fresh();
  state.signoffs = state.signoffs.map((s) => (
    s.teamId === 't_delta' ? { ...s, department: '市场部', isBusinessDepartment: false } : s
  ));
  assert.equal(demoTier({ state, rules, teamId: 't_delta' }).tier, 'S',
    '部门归类必须按 rules.criteria 判定（与正式系统 src/services/tier.js 同源）');

  // 同理：isDataOrPrototype 也必须按 criteria 推导 ——
  // ⚠️ 这里必须把该队**所有**数据/原型类里程碑的标志都改掉（只改一个不够：
  //    t_gamma 还有 demo_ready 带标志 ⇒ 只翻一个时两种实现结果相同 ⇒ 抓不住）。
  const state2 = fresh();
  state2.milestones = state2.milestones.map((m) => (
    m.teamId === 't_gamma' ? { ...m, isDataOrPrototype: false } : m
  ));
  assert.equal(demoTier({ state: state2, rules, teamId: 't_gamma' }).tier, 'A',
    '「数据/原型」里程碑必须按 rules.criteria 判定');
});

test('追加·判别性反例：互评改成同分 ⇒ 破同分链不再在 peer 级分开（证明分离真的由互评驱动）', () => {
  const state = fresh();
  // 让 t_alpha 与 t_beta 收到的互评分相同 ⇒ peer 这一级区分不出来
  state.peerReviews = state.peerReviews.map((p) => (
    p.toTeamId === 't_alpha' || p.toTeamId === 't_beta' ? { ...p, score: 65 } : p
  ));
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const peer = out.chain.find((c) => c.key === 'peer');
  assert.ok(!peer || !peer.usedBy.includes(a) || !peer.usedBy.includes(b),
    '互评同分时，peer 级不得把两支队分开');
  const behavior = out.chain.find((c) => c.key === 'behavior');
  assert.ok(behavior && behavior.usedBy.includes(a) && behavior.usedBy.includes(b),
    '互评同分时应当由行为分这一级兜底分开（链的下一级）');
});

test('追加·判别性反例：抹掉自评 ⇒ 总分必须变（证明自评席确实参与计分）', () => {
  const withSelf = runDemoCompute({ state: fresh(), rules, stageId: 'stage_final' });
  const state = fresh();
  state.selfReviews = [];
  const withoutSelf = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const sum = (out) => out.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.notDeepEqual(sum(withoutSelf), sum(withSelf), '抹掉自评后总分必须变化（自评席是一席）');
});

test('追加·判别性反例：企业确认分不同 ⇒ 两支「同分」队伍的总分必须分开', () => {
  const state = fresh();
  state.enterpriseConfirmations = state.enterpriseConfirmations.map((c) => (
    c.teamId === 't_beta' ? { ...c, rawScore: 60 } : c
  ));
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const [a, b] = seed.expectations.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assert.notEqual(ta.total, tb.total, '企业确认分不同 ⇒ 总分必须不同（不能只看评委席）');
});

test('追加·浏览器可加载性：适配器与领域层不得依赖 Node 内置模块（否则浏览器跑不起来）', () => {
  const platformDir = join(here, '..');
  const files = [
    join(platformDir, 'web', 'api.demo.js'),
    ...['registration', 'solvability', 'scoring', 'enterprise-seat', 'self-eval', 'ranking',
      'points', 'tier', 'behavior', 'visibility', 'util']
      .map((f) => join(platformDir, 'src', 'domain', `${f}.js`)),
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((x) => x[1]);
    for (const spec of specs) {
      assert.ok(!spec.startsWith('node:'), `${f} 不得 import Node 内置模块：${spec}`);
      assert.ok(spec.startsWith('.'), `${f} 的 import 必须是相对路径（浏览器要能直接加载）：${spec}`);
    }
  }
});

test('追加·演示适配器与真实适配器接口形状一致（同名单方法）', async () => {
  const demo = await import('../web/api.demo.js');
  const real = await import('../web/api.js');
  for (const k of ['get', 'post', 'patch', 'del', 'subscribe']) {
    assert.equal(typeof demo.api[k], 'function', `演示适配器缺 ${k}`);
    assert.equal(typeof real.api[k], 'function', `真实适配器缺 ${k}`);
  }
  assert.equal(typeof demo.createDemoApi, 'function', '必须能显式注入 seed / rules（测试与离线用）');
});

test('追加·演示数据落在 localStorage 里，重新打开浏览器能读回（不跨人共享但要能续上）', async () => {
  const storage = makeStorage();
  const api1 = createDemoApi({ storage, seed, rules });
  await api1.post('/api/auth/login', { name: '演示管理员' });
  assert.ok(storage.getItem('hks_demo_store_v1'), '登录后必须落盘');

  const api2 = createDemoApi({ storage, seed, rules });
  const me = await api2.get('/api/me');
  assert.equal(me.user.name, '演示管理员', '重新打开后仍应是已登录状态');
});

test('追加·名次积分按 rules/points.json 发放（第一/二/三名 = 10/8/5）', () => {
  const state = fresh();
  const out = runDemoCompute({ state, rules, stageId: 'stage_final' });
  const pts = new Map(out.points.map((p) => [p.teamId, p.points]));
  assert.equal(pts.get('t_alpha'), rules.points.stagePoints[0], '第 1 名拿第一档积分');
  assert.equal(pts.get('t_beta'), rules.points.stagePoints[1], '第 2 名拿第二档积分');
  assert.equal(pts.get('t_gamma'), 0, '第 5 名没有名次积分');
});

test('追加·buildDemoState 必须是深拷贝：适配器的写路径不得改到调用方的种子对象', async () => {
  const src = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const before = JSON.stringify(src);
  const state = buildDemoState(src);
  // 写路径：打分 / 组队 / 报名
  state.reviews.j_lenient.t_alpha.innovation = 1;
  state.teams.push({ id: 't_new', name: '新队', packageId: 'tp_retail', memberIds: [] });
  state.registrations.push({ id: 'reg_x' });
  assert.equal(JSON.stringify(src), before, '适配器的写路径把调用方的种子对象改了 ⇒ 同一份种子会算出不同结果');
  // 再建一次状态，必须与原始种子逐字相同
  const again = buildDemoState(src);
  assert.equal(again.reviews.j_lenient.t_alpha.innovation, 88, '新状态必须来自未被污染的种子');
});

// platform/test/demo-seed.test.js —— 演示版种子数据（web/seed/demo-data.json）
//
// 规则溯源：
//   - 「种子 = 每条 trace 分支的触发器」→ P6 计划 Task 4【本 Task 的灵魂】+ 设计文档 §12（trace 三件套）
//   - 「z-score 宽严归一化 / 样本不足降级」→ S7 §3.1 + 设计文档 §6.2 Step 2 + 冲突裁决 C-05
//   - 「去极值（该维度评委数 ≥5）」→ S7 §3.2 + 设计文档 §6.2 Step 3
//   - 「R1 分赛道 / R2 双签 / R3 权重封顶 / R4 自由命题」→ S7 §2.4 + 设计文档 §6.2 Step 5
//   - 「自评差异（高 → 书面说明 / 低 → 评委提问，阈值 10）」→ S7 §4.3 + R-JDG-13
//   - 「破同分链（total → 加时陈述 → 互评 → 企业原始分 → 行为分 → 队伍编号）」→ S7 §3.3 + 冲突裁决 C-03
//   - 「段位（里程碑计数 + 数据/原型 + 业务部门签字）」→ S10 §2.2 + S10 §2.1 + R-PTS-01~04
//   - 「行为分只做垫底排序、不进总分」→ S10 §3.3 + R-PTS-08 + 设计文档 §11.1
//
// ⚠️ 本文件的核心用例是「同分队伍在引擎里总分【严格相等】」：
//    规格原种子把两支队伍设计为同分，但**自评席**把它们拉开了（自评 95 触发「书面说明」
//    → 对齐到评委分 81.28，另一支自评 81 不触发 → 保持 81）⇒ 总分差 0.0139 ⇒ 根本不同分。
//    本文件断言的是**引擎算出来的总分**，不是种子里的自述 —— 种子说同分不算数，引擎算出来同分才算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
// ── 实施补记 2026-10-21：追加的判别性用例要把种子喂给【真实领域层引擎】才断言得了分支 ──
import { scoreStage } from '../src/domain/scoring.js';
import { rankTeams } from '../src/domain/ranking.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { computeTier } from '../src/domain/tier.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(here, '..', 'rules'));

test('种子数据结构完整', () => {
  for (const key of [
    'meta', 'edition', 'users', 'taskPackages', 'judges', 'teams',
    'reviews', 'enterpriseConfirmations', 'peerReviews', 'selfReviews',
    'milestones', 'signoffs', 'behaviorEvents', 'expectations',
  ]) {
    assert.ok(seed[key] !== undefined, `种子缺少 ${key}`);
  }
  assert.ok(seed.teams.length >= 4, '至少 4 支队伍');
  assert.ok(seed.judges.length >= 5, '至少 5 位评委');
});

test('打分矩阵的维度都必须是规则里存在的维度', () => {
  const valid = new Set(rules.scoring.final.dimensions.map((d) => d.key));
  for (const [judgeId, byTeam] of Object.entries(seed.reviews)) {
    for (const [teamId, byDim] of Object.entries(byTeam)) {
      for (const dim of Object.keys(byDim)) {
        assert.ok(valid.has(dim), `维度 ${dim} 不在 rules.scoring.final 里（评委 ${judgeId} 队 ${teamId}）`);
        assert.equal(typeof byDim[dim], 'number', '分数必须是数字');
      }
    }
  }
});

test('每个期望的同分队伍在所有评委的所有维度上原始分完全相同（保证真的同分）', () => {
  const [a, b] = seed.expectations.tiedTeams;
  for (const [judgeId, byTeam] of Object.entries(seed.reviews)) {
    if (!byTeam[a] || !byTeam[b]) continue;
    assert.deepEqual(byTeam[a], byTeam[b], `评委 ${judgeId} 给 ${a}/${b} 的分必须完全相同`);
  }
  // 企业确认也要相同，否则总分不可能相等
  const ca = seed.enterpriseConfirmations.filter((c) => c.teamId === a);
  const cb = seed.enterpriseConfirmations.filter((c) => c.teamId === b);
  assert.equal(ca.length, cb.length);
  for (let i = 0; i < ca.length; i += 1) {
    assert.equal(ca[i].rawScore, cb[i].rawScore, '企业确认原始分也必须相同');
  }
});

test('存在一个评委样本不足的维度（用于演示归一化降级告警）', () => {
  const dim = seed.expectations.unnormalizedDimension;
  const judge = seed.expectations.unnormalizedJudge;
  const samples = Object.keys(seed.reviews[judge] ?? {}).filter(
    (teamId) => seed.reviews[judge][teamId][dim] !== undefined,
  );
  assert.ok(samples.length < rules.scoring.final.minSamplesForJudgeNormalization,
    `评委 ${judge} 在维度 ${dim} 上的样本数必须小于 ${rules.scoring.final.minSamplesForJudgeNormalization}`);
});

test('存在一个缺双签的企业确认（用于演示 R2 告警）', () => {
  const teamId = seed.expectations.missingDualSignatureTeam;
  const mine = seed.enterpriseConfirmations.filter((c) => c.teamId === teamId);
  assert.ok(mine.length > 0, `${teamId} 必须有企业确认记录`);
  assert.ok(mine.some((c) => !c.crossJudgeId || !c.signatoryUserId),
    `${teamId} 必须有一条缺双签的企业确认`);
});

test('存在一个自由命题队伍（用于演示 R4）', () => {
  const teamId = seed.expectations.freeBriefTeam;
  const team = seed.teams.find((t) => t.id === teamId);
  assert.ok(team, '自由命题队必须在队伍列表里');
  const pkg = seed.taskPackages.find((p) => p.id === team.packageId);
  assert.ok(pkg, '自由命题队必须挂在某个任务包上');
  assert.equal(pkg.isFreeBrief, true, '任务包必须标记为自由命题');
});

test('每支队伍都有互评（否则破同分链的 peer 键不可用）', () => {
  for (const t of seed.teams) {
    const incoming = seed.peerReviews.filter((p) => p.toTeamId === t.id);
    assert.ok(incoming.length > 0, `${t.id} 没有任何互评`);
  }
});

test('expectations 覆盖了全部要演示的 trace 分支', () => {
  const e = seed.expectations;
  for (const key of [
    'tiedTeams', 'tiebreakSeparatedBy', 'unnormalizedDimension', 'unnormalizedJudge',
    'missingDualSignatureTeam', 'freeBriefTeam', 'selfEvalWrittenExplanationTeam',
    'selfEvalJudgeQuestionTeam', 'tiers',
  ]) {
    assert.ok(e[key] !== undefined, `expectations 缺少 ${key}`);
  }
  assert.equal(e.tiedTeams.length, 2, '必须正好是两支同分队伍');
  assert.deepEqual(Object.keys(e.tiers).sort(), seed.teams.map((t) => t.id).sort());
});

// ─────────────────────────────────────────────────────────────────────────────
// 【实施补记 2026-10-21】规格的 9 个用例【逐字保留】+ 追加 11 个判别性用例。
//
// 为什么必须追加：规格的 9 个用例全是**静态**检查（结构、维度名、原始分相等、
// 样本数、缺双签、自由命题、互评、expectations 齐不齐）—— 它们证明的是
// 「数据摆对了形状」，**证明不了**「点一下计算，这条数据真的触发了那条分支」。
// 而本 Task 的灵魂恰恰是后者：种子 = 每条 trace 分支的**触发器**。
//
// 追加的用例把种子喂给【真实的领域层引擎】（src/domain/*，纯函数、无 IO、无 Node 内置模块），
// 断言分支真的发生了 —— 这样 Task 5 的 demo-engine.test.js 逐条断言 expectations 时，
// 断言的是**引擎的输出**，不是种子里的一句自述。
//
// ⚠️ 输入构造（expandSubmissions / roster）与 Task 5 的 web/api.demo.js 同形；
//    两边若漂移，Task 5 的 demo-parity.test.js 会当场判出来（那里比的是
//    「演示适配器 vs 直接调 scoreStage」的一致性）。
// ─────────────────────────────────────────────────────────────────────────────

function expandSubmissions(s) {
  const out = [];
  for (const [judgeId, byTeam] of Object.entries(s.reviews ?? {})) {
    for (const [teamId, byDim] of Object.entries(byTeam ?? {})) {
      for (const [dimension, rawScore] of Object.entries(byDim ?? {})) {
        out.push({ judgeId, teamId, dimension, rawScore: Number(rawScore) });
      }
    }
  }
  return out;
}

function roster(s) {
  const pkgById = new Map((s.taskPackages ?? []).map((p) => [p.id, p]));
  return (s.teams ?? []).map((t) => {
    const pkg = pkgById.get(t.packageId) ?? {};
    return {
      teamId: t.id,
      packageEnterpriseId: pkg.enterpriseId ?? null,
      isFreeBrief: pkg.isFreeBrief === true,
    };
  });
}

function compute(s = seed) {
  return scoreStage({
    config: rules.scoring.final,
    judges: (s.judges ?? []).map((j) => ({ judgeId: j.id, seat: j.seat })),
    submissions: expandSubmissions(s),
    enterpriseConfirmations: s.enterpriseConfirmations ?? [],
    peerReviews: s.peerReviews ?? [],
    teams: roster(s),
    selfReviews: s.selfReviews ?? [],
  });
}

function behaviorOf(s, teamId) {
  return behaviorScore({
    events: (s.behaviorEvents ?? []).filter((e) => e.teamId === teamId),
    behaviorConfig: rules.behavior,
  });
}

test('追加·同分队伍在引擎里总分严格相等（构造保证，不靠手算）', () => {
  const out = compute();
  const [a, b] = seed.expectations.tiedTeams;
  const ta = out.teams.find((t) => t.teamId === a);
  const tb = out.teams.find((t) => t.teamId === b);
  assert.ok(ta && tb, '两支队伍都必须参与计算');
  assert.equal(ta.total, tb.total, '同分队伍的总分必须完全相等');
  assert.equal(ta.seatP, tb.seatP, '同分队伍的评委席分必须完全相等');
  assert.equal(ta.seatE, tb.seatE, '同分队伍的企业席分必须完全相等');
  // ⛔ 反例守卫：同分不能只看评委席 —— 自评席也算一席，
  //    自评不一样就会把「同分」拉开（规格原种子就踩了这个坑）。
  for (const d of Object.keys(ta.perDimension)) {
    assert.equal(ta.perDimension[d].mean, tb.perDimension[d].mean, `维度 ${d} 的分必须相等`);
  }
});

test('追加·破同分链真的在 peer 级把同分队伍分开（互评高者在前）', () => {
  const out = compute();
  const [a, b] = seed.expectations.tiedTeams;
  const byTeam = {};
  for (const row of out.teams) {
    const peer = (seed.peerReviews ?? []).filter((p) => p.toTeamId === row.teamId);
    const conf = (seed.enterpriseConfirmations ?? []).filter((c) => c.teamId === row.teamId);
    byTeam[row.teamId] = {
      peerScore: peer.length ? peer.reduce((s, p) => s + Number(p.score || 0), 0) / peer.length : undefined,
      enterpriseRaw: conf.length ? conf.reduce((s, c) => s + Number(c.rawScore || 0), 0) / conf.length : undefined,
      behaviorScore: behaviorOf(seed, row.teamId).total,
    };
  }
  const ranked = rankTeams({
    teams: out.teams.map((row) => ({
      teamId: row.teamId, total: row.total, seatP: row.seatP, seatE: row.seatE,
      peerScore: byTeam[row.teamId].peerScore,
      enterpriseRaw: byTeam[row.teamId].enterpriseRaw,
      behaviorScore: byTeam[row.teamId].behaviorScore,
    })),
    tiebreakChain: rules.tiebreak.chain,
    tiebreakData: { isFinal: true, byTeam },
    pointsConfig: rules.points,
  });
  const ra = ranked.ordered.find((r) => r.teamId === a);
  const rb = ranked.ordered.find((r) => r.teamId === b);
  assert.notEqual(ra.rank, rb.rank, '同分队伍必须被破同分链分开');
  assert.ok(ra.rank < rb.rank, '互评分高的一方名次在前');
  const used = ranked.applied.find((c) => c.key === seed.expectations.tiebreakSeparatedBy);
  assert.ok(used, `破同分链里必须用到 ${seed.expectations.tiebreakSeparatedBy} 这一级`);
  assert.ok(used.usedBy.includes(a) && used.usedBy.includes(b), '分开它们的那一级必须同时用到两支队伍');
});

test('追加·归一化降级真的发生（告警指向期望的维度与评委）', () => {
  const out = compute();
  const dim = seed.expectations.unnormalizedDimension;
  const judge = seed.expectations.unnormalizedJudge;
  const hit = out.warnings.find((w) => w.code === 'normalization_fallback' && w.dimension === dim);
  assert.ok(hit, `必须出现维度 ${dim} 的归一化降级告警，实际告警：${JSON.stringify(out.warnings.map((w) => w.code))}`);
  assert.ok(String(hit.message).includes(judge), `告警必须点名评委 ${judge}：${hit.message}`);
  const agg = out.trace.normalization[dim];
  assert.equal(agg.normalized, false, '该维度的归一化状态必须是「已降级」');
  assert.ok(agg.judgeSampleSizes[judge] < rules.scoring.final.minSamplesForJudgeNormalization,
    `评委 ${judge} 的样本数必须小于阈值`);
  assert.equal(agg.judgeReasons[judge], 'judge_sample_too_small', '降级原因必须是样本不足');
});

test('追加·去极值真的发生（期望的维度上每个单元都 trimmed）', () => {
  const out = compute();
  const dims = new Set(seed.expectations.trimmedDimensions);
  const steps = out.trace.steps.filter((s) => dims.has(s.dimension));
  assert.ok(steps.length > 0, 'trace 里必须有去极值步骤');
  for (const s of steps) {
    assert.equal(s.trimmed, true, `${s.teamId} 的 ${s.dimension} 必须真的去极值`);
    assert.ok(s.removed.max && s.removed.min, '必须记录被去掉的最高分与最低分评委');
  }
});

test('追加·缺双签真的触发 R2 告警且该项按 0 分计', () => {
  const out = compute();
  const teamId = seed.expectations.missingDualSignatureTeam;
  const hit = out.warnings.find((w) => w.code === 'R2_missing_dual_signature');
  assert.ok(hit, '必须出现 R2_missing_dual_signature 告警');
  assert.equal(hit.teamId, teamId, `告警必须指向 ${teamId}`);
  const row = out.teams.find((t) => t.teamId === teamId);
  assert.equal(row.seatE, 0, '缺双签的企业席分必须按 0 分计（权重保留）');
});

test('追加·自由命题真的触发 R4（企业项由评委「需求真实性」维度替代）', () => {
  const out = compute();
  const teamId = seed.expectations.freeBriefTeam;
  const hit = out.warnings.find((w) => w.code === 'R4_free_brief_judge_scored');
  assert.ok(hit, '必须出现 R4_free_brief_judge_scored 告警');
  assert.equal(hit.teamId, teamId, `告警必须指向 ${teamId}`);
  const row = out.teams.find((t) => t.teamId === teamId);
  const substituteDim = rules.scoring.final.freeBrief.judgeDimension;
  assert.ok(Number.isFinite(row.seatE) && row.seatE > 0, 'R4 生效时企业席分由评委维度替代，不能是 0');
  assert.ok(
    Math.abs(row.seatE - row.perDimension[substituteDim].mean) < 1e-9,
    '企业席分必须等于替代维度的评委分',
  );
  assert.ok(
    !out.warnings.some((w) => w.code === 'R4_substitute_no_scores'),
    '替代维度有评委分，不应出现「替代维度无分」的告警',
  );
});

test('追加·自评差异三条分流真的发生（书面说明 / 评委提问 / 阈值内不告警）', () => {
  const out = compute();
  const byCode = (code) => out.warnings.filter((w) => w.code === code);
  const hi = byCode('self_eval_written_explanation');
  const lo = byCode('self_eval_judge_question');
  assert.equal(hi.length, 1, `「书面说明」分支必须恰好一支队（实际 ${hi.length}）`);
  assert.equal(lo.length, 1, `「评委提问」分支必须恰好一支队（实际 ${lo.length}）`);
  assert.equal(hi[0].teamId, seed.expectations.selfEvalWrittenExplanationTeam);
  assert.equal(lo[0].teamId, seed.expectations.selfEvalJudgeQuestionTeam);
  for (const t of seed.expectations.selfEvalWithinThresholdTeams) {
    assert.ok(
      !hi.some((w) => w.teamId === t) && !lo.some((w) => w.teamId === t),
      `${t} 的自评与评委分差异在阈值内，不该告警`,
    );
  }
});

test('追加·自评对齐不加分：书面说明那支队的自评席分 = 评委席分（不是自评原分）', () => {
  const out = compute();
  const teamId = seed.expectations.selfEvalWrittenExplanationTeam;
  const row = out.teams.find((t) => t.teamId === teamId);
  const self = seed.selfReviews.find((r) => r.teamId === teamId);
  assert.ok(self, `${teamId} 必须有自评记录`);
  const selfSeat = row.perDimension.self_eval;
  const judgeSide = row.perDimension[self.dimension];
  assert.notEqual(selfSeat.mean, self.rawScore, '自评席分不能是自评原分（那样就变成加分项了）');
  assert.equal(selfSeat.mean, judgeSide.mean, '自评席分必须对齐到评委席该维度的分');
  assert.ok(selfSeat.mean < self.rawScore, '对齐只会把自评拉低，绝不会拉高（自评不得变成加分项）');
});

test('追加·缺自评的队伍：self_eval 维度没有分并告警（不静默当 0）', () => {
  const out = compute();
  const teamId = seed.expectations.missingSelfEvalTeam;
  const hit = out.warnings.find((w) => w.code === 'dimension_no_scores' && w.teamId === teamId);
  assert.ok(hit, `必须出现 ${teamId} 的缺分告警`);
  assert.equal(hit.dimension, 'self_eval');
  const row = out.teams.find((t) => t.teamId === teamId);
  assert.equal(row.perDimension.self_eval.mean, null, '该维度没有分');
  // 缺分维度必须被【剔除出分母】，而不是【静默当 0 分】（设计文档 §13 降级表）
  let num = 0; let denAll = 0; let denPresent = 0;
  for (const [key, v] of Object.entries(row.perDimension)) {
    if (key === 'enterprise') continue;
    denAll += v.weight;
    if (v.mean != null) { num += v.weight * v.mean; denPresent += v.weight; }
  }
  assert.ok(Math.abs(row.seatP - num / denPresent) < 1e-9, '缺分维度必须被剔除出分母');
  assert.ok(Math.abs(row.seatP - num / denAll) > 1e-9, '缺分维度不能被静默当 0 分');
});

test('追加·段位与 expectations.tiers 逐条一致（用 computeTier 复算）', () => {
  for (const [teamId, tier] of Object.entries(seed.expectations.tiers)) {
    const milestones = (seed.milestones ?? []).filter((m) => m.teamId === teamId);
    const signoffs = (seed.signoffs ?? []).filter((s) => s.teamId === teamId);
    const info = computeTier({ milestones, signoffs, ranksConfig: rules.ranks });
    assert.equal(info.tier, tier, `${teamId} 的段位应为 ${tier}，实际 ${info.tier}`);
  }
});

test('追加·行为分：证据合规才算分，且分值与 expectations 一致', () => {
  for (const [teamId, expected] of Object.entries(seed.expectations.behaviorScores)) {
    const b = behaviorOf(seed, teamId);
    assert.equal(b.total, expected, `${teamId} 的行为分应为 ${expected}，实际 ${b.total}`);
  }
  const counted = seed.behaviorEvents.some((e) => behaviorOf(seed, e.teamId).items
    .some((i) => i.type === e.type && i.counted));
  assert.ok(counted, '至少要有一条行为事件真的拿到分（否则行为分支不可观测）');
});

test('追加·行为分不进入总分（分轨在算法层，不靠人的自觉）', () => {
  const before = compute();
  const bumped = {
    ...seed,
    behaviorEvents: seed.behaviorEvents.map((e) => ({ ...e, evidence: '{"repo":"r","version":"v","artifact":"a"}' })),
  };
  const after = compute(bumped);
  const sum = (out) => out.teams.map((t) => `${t.teamId}:${t.total}`).sort();
  assert.deepEqual(sum(after), sum(before), '行为分变化不得影响任何队伍的总分');
});

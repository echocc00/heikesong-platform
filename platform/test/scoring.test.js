// platform/test/scoring.test.js —— scoreStage 总装
//
// 规则溯源：
//   - 「总分 = (1−w_E)×P + w_E×E，初赛 w_E=10%」→ S7 §2.1 权重表 + §3.1 评分公式
//     + 冲突裁决 C-01（rule-decisions.md）
//   - 「行为分不得影响总分」→ S10 §8 第三条风险（分轨必须在算法层，不靠纪律）
//   - 「降级必须显式」→ 设计文档 §6.2【决策】+ §12 trace 结构
//   - 「R1/R2/R3/R4」→ S7 §2.4（R-JDG-05~08）
//   - 「自评测不加分」→ S7 §4.3（R-JDG-13）
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreStage } from '../src/domain/scoring.js';

// 初赛权重表（S7 §2.1；w_E = 10%，依据冲突裁决 C-01）
const CONFIG = {
  id: 'scoring-initial',
  wEnterprise: 0.10,
  normalizationStrategy: 'zscore',
  minSamplesForJudgeNormalization: 5,
  trimOutliers: true,
  minJudgesForTrim: 5,
  selfEvalThreshold: 10,
  freeBrief: { judgeDimension: 'track_fit' },
  dimensions: [
    { key: 'track_fit', weight: 0.10, seat: 'judge' },
    { key: 'innovation', weight: 0.20, seat: 'judge' },
    { key: 'feasibility', weight: 0.20, seat: 'judge' },
    { key: 'completeness', weight: 0.25, seat: 'judge' },
    { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    { key: 'collaboration', weight: 0.15, seat: 'judge' },
  ],
};

const JUDGES = [{ judgeId: 'j1', seat: 'judge' }, { judgeId: 'j2', seat: 'judge' }];

const SUBMISSIONS = [
  { judgeId: 'j1', teamId: 't1', dimension: 'track_fit', rawScore: 80 },
  { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 90 },
  { judgeId: 'j1', teamId: 't1', dimension: 'feasibility', rawScore: 70 },
  { judgeId: 'j1', teamId: 't1', dimension: 'completeness', rawScore: 100 },
  { judgeId: 'j1', teamId: 't1', dimension: 'collaboration', rawScore: 60 },
  { judgeId: 'j1', teamId: 't2', dimension: 'track_fit', rawScore: 70 },
  { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 80 },
  { judgeId: 'j1', teamId: 't2', dimension: 'feasibility', rawScore: 80 },
  { judgeId: 'j1', teamId: 't2', dimension: 'completeness', rawScore: 90 },
  { judgeId: 'j1', teamId: 't2', dimension: 'collaboration', rawScore: 70 },
  { judgeId: 'j2', teamId: 't1', dimension: 'track_fit', rawScore: 60 },
  { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 70 },
  { judgeId: 'j2', teamId: 't1', dimension: 'feasibility', rawScore: 60 },
  { judgeId: 'j2', teamId: 't1', dimension: 'completeness', rawScore: 80 },
  { judgeId: 'j2', teamId: 't1', dimension: 'collaboration', rawScore: 50 },
  { judgeId: 'j2', teamId: 't2', dimension: 'track_fit', rawScore: 50 },
  { judgeId: 'j2', teamId: 't2', dimension: 'innovation', rawScore: 60 },
  { judgeId: 'j2', teamId: 't2', dimension: 'feasibility', rawScore: 50 },
  { judgeId: 'j2', teamId: 't2', dimension: 'completeness', rawScore: 70 },
  { judgeId: 'j2', teamId: 't2', dimension: 'collaboration', rawScore: 40 },
];

const TEAMS = [
  { teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false },
  { teamId: 't2', packageEnterpriseId: 'E1', isFreeBrief: false },
];

const CONFIRMATIONS = [
  { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: '解决了库存周转' },
];

/** 生效权重合计（每队各自一份） */
function weightSum(perDimension) {
  return Object.values(perDimension).reduce((acc, d) => acc + d.weight, 0);
}

test('总分 = (1−w_E)×P + w_E×E，初赛 w_E = 0.10（冲突裁决 C-01）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  // 样本不足 → 退回全局口径 → 维度分退化为原始分均值
  // P = (0.10*70 + 0.20*80 + 0.20*65 + 0.25*90 + 0.15*55) / 0.90 = 66.75/0.9
  assert.ok(Math.abs(t1.seatP - 74.166666667) < 1e-6, `seatP=${t1.seatP}`);
  assert.equal(t1.seatE, 80);
  assert.ok(Math.abs(t1.total - 74.75) < 1e-6, `total=${t1.total}`);
  assert.ok(Math.abs(t1.total - (1 - 0.10) * t1.seatP - 0.10 * t1.seatE) < 1e-9);
  // 生效权重合计必须是 1（席位权重按 (1−w_E) 归一后与 w_E 拼回 100%）
  assert.ok(Math.abs(weightSum(t1.perDimension) - 1) < 1e-9, `生效权重合计=${weightSum(t1.perDimension)}`);
});

test('⭐ 行为分变化不影响总分（S10 §8：分轨必须是算法层面的，不是纪律层面的）', () => {
  const a = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const b = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS,
    behaviorScore: 999, behaviorPoints: 999, behavior: { total: 999 },
  });
  assert.deepEqual(b.teams, a.teams, '传入行为分不得改变任何队伍的总分');
  assert.deepEqual(b.warnings, a.warnings);
});

test('trace 具备 normalization / steps / weights / perTeam 四段', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.trace.normalization.track_fit);
  assert.equal(r.trace.normalization.track_fit.normalized, false);
  assert.equal(r.trace.normalization.track_fit.fallbackReason, 'judge_sample_too_small');
  assert.equal(r.trace.normalization.track_fit.judgeSampleSizes.j1, 2);
  assert.ok(Array.isArray(r.trace.steps));
  assert.ok(r.trace.steps.some((s) => s.step === 'trim' && s.dimension === 'track_fit'));
  assert.equal(r.trace.weights.enterprise, 0.10);
  assert.ok(r.trace.perTeam.t1);
  assert.ok(Math.abs(r.trace.perTeam.t1.seatP - 74.166666667) < 1e-6);
});

test('降级必须显式：样本不足进 warnings，不静默', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.warnings.some((w) => w.code === 'normalization_fallback' && w.dimension === 'track_fit'));
});

test('R2 缺双签 → 企业席 0 分 + warning，权重保留', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [{ ...CONFIRMATIONS[0], crossJudgeId: null }],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 0);
  assert.ok(r.warnings.some((w) => w.code === 'R2_missing_dual_signature'));
});

test('R1 非本赛道 → 企业项权重降为 0，总分不再含企业席', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [{ ...CONFIRMATIONS[0], enterpriseId: 'E9' }],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 0);
  assert.ok(Math.abs(t1.total - t1.seatP) < 1e-9, 'R1 后总分 = 评委席分');
  assert.ok(r.warnings.some((w) => w.code === 'R1_out_of_track'));
});

test('没有企业确认 → 0 分 + warning（不静默当 0）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: [], teams: TEAMS });
  const t2 = r.teams.find((t) => t.teamId === 't2');
  assert.equal(t2.seatE, 0);
  assert.ok(r.warnings.some((w) => w.code === 'no_enterprise_confirmation' && w.teamId === 't2'));
});

test('样本足够时走真归一化：已知评委矩阵 → 期望维度分', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.8, seat: 'judge' },
      { key: 'enterprise', weight: 0.2, seat: 'enterprise' },
    ],
  };
  const ser = {
    j1: [60, 65, 70, 75, 80],
    j2: [55, 60, 65, 70, 75],
    j3: [70, 70, 70, 70, 70],
    j4: [50, 60, 70, 80, 90],
    j5: [58, 63, 68, 73, 78],
  };
  const teams5 = ['t1', 't2', 't3', 't4', 't5'];
  const subs = [];
  for (const [j, arr] of Object.entries(ser)) {
    teams5.forEach((teamId, i) => subs.push({ judgeId: j, teamId, dimension: 'innovation', rawScore: arr[i] }));
  }
  const r = scoreStage({
    config: cfg,
    judges: Object.keys(ser).map((judgeId) => ({ judgeId, seat: 'judge' })),
    submissions: subs,
    enterpriseConfirmations: [],
    teams: teams5.map((teamId) => ({ teamId, packageEnterpriseId: 'E1', isFreeBrief: false })),
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  // 全局均值 68.6、全局标准差 8.770214745；t1 截尾后 z 均值 -1.264911064
  // → 维度分 = 68.6 + (-1.264911064) * 8.770214745 = 57.506458335
  assert.ok(Math.abs(t1.perDimension.innovation.mean - 57.506458335) < 1e-6, `实际 ${t1.perDimension.innovation.mean}`);
  assert.ok(Math.abs(t1.seatP - 57.506458335) < 1e-6);
  // j3 恒定 70 → stdev=0 → z=0 且必须显式标记
  assert.equal(r.trace.normalization.innovation.judgeReasons.j3, 'zero_stdev');
  assert.ok(r.warnings.some((w) => w.code === 'normalization_fallback'));
  // R3 把企业项从 0.2 封顶到 w_E=0.1 后，评委席权重必须补足到 0.9（合计仍是 1）
  assert.ok(Math.abs(weightSum(t1.perDimension) - 1) < 1e-9, `生效权重合计=${weightSum(t1.perDimension)}`);
  assert.ok(Math.abs(t1.perDimension.innovation.weight - 0.9) < 1e-9, `创新性生效权重=${t1.perDimension.innovation.weight}`);
});

test('自评测 d > 10 → 对齐评委分（不加分）+ warning；d < -10 → 只提问', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.9, seat: 'judge' },
      { key: 'enterprise', weight: 0.1, seat: 'enterprise' },
    ],
  };
  const subs = [
    { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
  ];
  const r = scoreStage({
    config: cfg, judges: JUDGES, submissions: subs, enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
  });
  assert.ok(r.warnings.some((w) => w.code === 'self_eval_written_explanation' && w.teamId === 't1'));
  // ⛔ 关键断言：**用评委分 80，不是自评的 95** —— 自评不得加分（S7 §4.3 / S10 §8）
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.mean, 80, '自评 95 分不得进入评委席维度');
  assert.equal(t1.seatP, 80);
});

test('评委池缺失 → 记 warning，绝不静默', () => {
  const r = scoreStage({ config: CONFIG, judges: [], submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  assert.ok(r.warnings.some((w) => w.code === 'judge_roster_missing'));
});

test('⛔ 自评不得填补评委席维度（自评加分路径封堵）', () => {
  // 评委没给「创新性」打分，但队伍自己给了 95 分 —— 该维度必须**缺分**（权重记 0），
  // 而不是拿自评分顶上（S7 §4.3「不加分」+ S10 §8「自评不得成为博弈项」）。
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'track_fit', weight: 0.50, seat: 'judge' },
      { key: 'innovation', weight: 0.40, seat: 'judge' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg,
    judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'track_fit', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'track_fit', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.mean, null, '评委席维度不得由自评填补');
  assert.equal(t1.seatP, 80, '只有「赛题契合度」有分 → 席位分 = 80');
  assert.ok(r.warnings.some((w) => w.code === 'dimension_no_scores' && w.dimension === 'innovation'));
});

test('自评席维度（seat=self）取自自评记录并进 trace', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg,
    judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'self_eval', rawScore: 88 }],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, 88);
  assert.equal(t1.perDimension.self_eval.raw, 88);
  assert.equal(t1.perDimension.self_eval.z, null);
  // P = (0.80*80 + 0.10*88) / 0.90 = 72.8/0.9
  assert.ok(Math.abs(t1.seatP - 80.888888888) < 1e-6, `seatP=${t1.seatP}`);
});

test('自评席维度缺自评记录 → 该维度缺分（权重记 0）+ warning', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg,
    judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, null);
  assert.ok(r.warnings.some((w) => w.code === 'dimension_no_scores' && w.dimension === 'self_eval'));
});

test('⛔ 观察员无投票权（R-JDG-11）：观察员的打分不计入', () => {
  // 观察员给 100 分、评委给 80 分 —— 维度分必须是 80（不是 90）
  const r = scoreStage({
    config: CONFIG,
    judges: [{ judgeId: 'j1', seat: 'judge' }, { judgeId: 'obs', seat: 'observer' }],
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'obs', teamId: 't1', dimension: 'innovation', rawScore: 100 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.mean, 80, '观察员的分不得计入');
});

test('⛔ R4：自由命题组无企业签字 → 企业项改由评委的「需求真实性」维度替代', () => {
  const dims = ['innovation', 'feasibility', 'completeness', 'collaboration'];
  const subs = [];
  for (const dim of dims) {
    subs.push({ judgeId: 'j1', teamId: 'tFree', dimension: dim, rawScore: 70 });
    subs.push({ judgeId: 'j2', teamId: 'tFree', dimension: dim, rawScore: 70 });
  }
  subs.push({ judgeId: 'j1', teamId: 'tFree', dimension: 'track_fit', rawScore: 70 });
  subs.push({ judgeId: 'j2', teamId: 'tFree', dimension: 'track_fit', rawScore: 80 });

  const r = scoreStage({
    config: CONFIG,
    judges: JUDGES,
    submissions: subs,
    enterpriseConfirmations: [],
    teams: [{ teamId: 'tFree', packageEnterpriseId: null, isFreeBrief: true }],
  });
  const t = r.teams.find((x) => x.teamId === 'tFree');
  assert.ok(r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored'), '必须显式记 R4');
  // 企业项由评委的 track_fit 分替代（(70+80)/2 = 75）
  assert.equal(t.perDimension.enterprise.mean, 75, '企业项须由评委的替代维度分填充');
  assert.equal(t.perDimension.track_fit.weight, 0, '替代维度要从评委席移出，避免双重计分');
  assert.ok(Math.abs(weightSum(t.perDimension) - 1) < 1e-9);
  // 总分 = 0.9×70 + 0.1×75 = 70.5
  assert.ok(Math.abs(t.total - 70.5) < 1e-6, `total=${t.total}`);
});

test('perDimension.raw 必须是原始分（不是 z 值）', () => {
  const r = scoreStage({ config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS, enterpriseConfirmations: CONFIRMATIONS, teams: TEAMS });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.innovation.raw, 80, '创新性原始分 = (90+70)/2');
  assert.equal(t1.perDimension.completeness.raw, 90, '完成度原始分 = (100+80)/2');
  assert.equal(t1.perDimension.enterprise.raw, 80, '企业项的 raw 就是企业确认分');
});

test('没有任何 P 席评分的队伍 → 记 team_no_reviews（不参与排名）', () => {
  const r = scoreStage({
    config: CONFIG,
    judges: JUDGES,
    submissions: [],
    enterpriseConfirmations: [],
    teams: [
      { teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false },
      { teamId: 't2', packageEnterpriseId: 'E1', isFreeBrief: false },
    ],
  });
  const warned = r.warnings.filter((w) => w.code === 'team_no_reviews').map((w) => w.teamId).sort();
  assert.deepEqual(warned, ['t1', 't2'], '两支队都没有评委分 → 都应标记不参与排名');
});

test('⛔ 冒名的非本赛道确认不得连坐掉本赛道企业的合法签字（D-30）', () => {
  // 一条「非本赛道企业」的**有效**双签 + 本赛道企业的合法双签同时存在：
  // 本赛道企业对自己出的题签字是天经地义的，不能被别人的一条记录废掉。
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [
      CONFIRMATIONS[0],
      { teamId: 't1', enterpriseId: 'E9', dimension: 'enterprise', rawScore: 100, crossJudgeId: 'j2', signatoryUserId: 'u_e9', content: '冒名' },
    ],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 80, '本赛道企业的合法签字必须保留');
  assert.ok(r.warnings.some((w) => w.code === 'R1_out_of_track'), '仍然要留下 R1 告警（不能静默）');
  assert.ok(Math.abs(weightSum(t1.perDimension) - 1) < 1e-9, '企业项权重不得被归零');
});

test('⛔ 自评席维度高于评委席分 10 分以上 → 对齐到评委席分（不加分）', () => {
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg, judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [{ teamId: 't1', dimension: 'self_eval', rawScore: 95 }], // 95 − 80 = 15 > 10
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, 80, '自评 95 必须对齐到评委席分 80（不加分）');
  assert.ok(r.warnings.some((w) => w.code === 'self_eval_written_explanation'));
});

test('⛔ 评委打分不得填自评席维度（领域层第二道防线）', () => {
  // 即使写入口被绕过（服务层直调），领域层也绝不能让评委的打分填进自评席维度。
  const cfg = {
    ...CONFIG,
    dimensions: [
      { key: 'innovation', weight: 0.80, seat: 'judge' },
      { key: 'self_eval', weight: 0.10, seat: 'self' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = scoreStage({
    config: cfg, judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j2', teamId: 't1', dimension: 'innovation', rawScore: 80 },
      { judgeId: 'j1', teamId: 't1', dimension: 'self_eval', rawScore: 100 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    selfReviews: [],
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.perDimension.self_eval.mean, null, '评委的打分不得填自评席维度');
  assert.ok(r.warnings.some((w) => w.code === 'dimension_no_scores' && w.dimension === 'self_eval'));
});

test('⛔ R4 替代维度没有评委分 → 必须显式告警（不能静默丢 20%）', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES,
    submissions: [
      { judgeId: 'j1', teamId: 'tFree', dimension: 'innovation', rawScore: 70 },
      { judgeId: 'j2', teamId: 'tFree', dimension: 'innovation', rawScore: 70 },
    ],
    enterpriseConfirmations: [],
    teams: [{ teamId: 'tFree', packageEnterpriseId: null, isFreeBrief: true }],
  });
  const t = r.teams.find((x) => x.teamId === 'tFree');
  assert.equal(t.perDimension.enterprise.mean, 0, '替代维度无分 → 企业项按 0 分计');
  assert.ok(
    r.warnings.some((w) => w.code === 'R4_substitute_no_scores' && w.teamId === 'tFree'),
    '必须显式说明替代维度没有评委分',
  );
});

test('⛔ 无效的非本赛道记录不得触发 R1 把企业权重归零（D-30）', () => {
  const r = scoreStage({
    config: CONFIG, judges: JUDGES, submissions: SUBMISSIONS,
    enterpriseConfirmations: [
      // 非本赛道企业 + 缺双签（**无效**）→ 不得把企业项权重归零
      { teamId: 't1', enterpriseId: 'E9', dimension: 'enterprise', rawScore: 100, crossJudgeId: null, signatoryUserId: 'u_e9', content: '冒名' },
    ],
    teams: TEAMS,
  });
  const t1 = r.teams.find((t) => t.teamId === 't1');
  assert.equal(t1.seatE, 0, '没有有效的企业确认 → 企业席 0 分');
  assert.ok(!r.warnings.some((w) => w.code === 'R1_out_of_track'), '无效记录不得触发 R1');
  assert.ok(
    Math.abs(t1.total - 0.9 * t1.seatP) < 1e-9,
    '无效记录不得把企业项权重归零（归零后总分会从 0.9×P 变成 P）',
  );
});

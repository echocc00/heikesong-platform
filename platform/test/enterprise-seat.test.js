// platform/test/enterprise-seat.test.js —— 企业席 E 与 R1 / R2 / R3 / R4
//
// 依据：P2 计划 Task 4「企业席 E 与 R1 / R2 / R3 / R4」
// 溯源需求：R-JDG-05（R1 分赛道）｜R-JDG-06（R2 双签）｜R-JDG-07（R3 权重封顶）
//          ｜R-JDG-08（R4 自由命题组）｜R-JDG-14（签字必须有内容）
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';

// 初赛权重表（S7 §2.1，w_E = 10%，依据冲突裁决 C-01）
const CONFIG = {
  wEnterprise: 0.10,
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

const TEAMS = [
  { teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false },
  { teamId: 't2', packageEnterpriseId: 'E1', isFreeBrief: false },
  { teamId: 't3', packageEnterpriseId: null, isFreeBrief: true },
  { teamId: 't4', packageEnterpriseId: 'E1', isFreeBrief: false },
];

const CONFIRMATIONS = [
  // t1：双签齐全且是本赛道企业 → 有效
  { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: '解决了库存周转' },
  // t2：缺跨领域评委签字 → R2 按 0 分计
  { teamId: 't2', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 70, crossJudgeId: null, signatoryUserId: 'u_e1', content: '解决了排产' },
  // t4：非本赛道企业签字 → R1 权重降为 0
  { teamId: 't4', enterpriseId: 'E9', dimension: 'enterprise', rawScore: 60, crossJudgeId: 'j2', signatoryUserId: 'u_e9', content: '别家的题' },
];

const oneTeam = (teamId, extra = {}) => ({
  teamId,
  packageEnterpriseId: 'E1',
  isFreeBrief: false,
  ...extra,
});

test('R1：非本赛道 → 该队企业项权重置 0，并记 warning', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.weights.t4.enterprise, 0);
  assert.ok(r.warnings.some((w) => w.code === 'R1_out_of_track' && w.teamId === 't4'));
});

test('R2：缺双签 → 按 0 分计 + warning（权重保留，绝不静默）', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t2, 0);
  assert.equal(r.weights.t2.enterprise, 0.10, 'R2 是「分数按 0 计」，不是「权重降为 0」');
  assert.ok(r.warnings.some((w) => w.code === 'R2_missing_dual_signature' && w.teamId === 't2'));
});

test('R2 双签齐全 → 企业席分 = 确认分', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t1, 80);
});

test('R3：企业席合计权重不得超过 wEnterprise（超出即封顶 + warning）', () => {
  const over = {
    ...CONFIG,
    wEnterprise: 0.25,
    dimensions: [
      { key: 'innovation', weight: 0.60, seat: 'judge' },
      { key: 'enterprise', weight: 0.40, seat: 'enterprise' },
    ],
  };
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [{ teamId: 't1', packageEnterpriseId: 'E1', isFreeBrief: false }],
    judges: [],
    config: over,
  });
  assert.ok(Math.abs(r.weights.t1.enterprise - 0.25) < 1e-12, `实际 ${r.weights.t1.enterprise}`);
  assert.ok(r.warnings.some((w) => w.code === 'R3_enterprise_weight_capped'));
});

test('R4：自由命题组无企业签字 → 企业项改由评委按需求真实性的公开证据打分', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t3, null, 'R4 生效时企业分交由评委维度替代');
  assert.deepEqual(r.r4Substitute.t3, { dimension: 'track_fit' });
  assert.equal(r.weights.t3.track_fit, 0, '替代维度从评委席移出，避免双重计分');
  assert.equal(r.weights.t3.enterprise, 0.10, '替代维度的权重搬到企业席');
  assert.ok(r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored' && w.teamId === 't3'));
});

test('没有企业确认记录 → 0 分 + warning（不静默当 0）', () => {
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [{ teamId: 't9', packageEnterpriseId: 'E1', isFreeBrief: false }],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t9, 0);
  assert.ok(r.warnings.some((w) => w.code === 'no_enterprise_confirmation' && w.teamId === 't9'));
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// ⚠️ 规格自带的 6 条用例全绿，但下面的缺陷在它们**全都看不见**。

test('R-JDG-14：签字内容为空或纯空白 → 该确认无效，按 0 分计 + warning', () => {
  // ⚠️ 原实现**零校验** content —— 空白的签字照样计入分数。
  //    领域层会被 computeStage 从库里读数据时调用，服务层的写入口校验挡不住
  //    历史数据与旁路写入。
  for (const content of ['', '   ', '\t\n']) {
    const r = applyEnterpriseRules({
      confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content }],
      teams: [oneTeam('t1')],
      judges: [],
      config: CONFIG,
    });
    assert.equal(r.seatE.t1, 0, `content=${JSON.stringify(content)} 必须判为无效`);
    assert.ok(
      r.warnings.some((w) => w.code === 'R_JDG14_missing_content' && w.teamId === 't1'),
      `content=${JSON.stringify(content)} 必须告警`,
    );
  }
});

test('企业确认分越界 → 该确认无效（绝不让破 100 分的分进榜）', () => {
  // ⚠️ 原实现零校验：rawScore = 1000 直接进企业席 →
  //    总分公式 (1−w_E)×P + w_E×E 会让**榜单总分破 100**。
  for (const rawScore of [1000, -1, NaN, Infinity]) {
    const r = applyEnterpriseRules({
      confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'x' }],
      teams: [oneTeam('t1')],
      judges: [],
      config: CONFIG,
    });
    assert.equal(r.seatE.t1, 0, `rawScore=${String(rawScore)} 必须判为无效`);
    assert.ok(r.warnings.some((w) => w.code === 'enterprise_score_out_of_range'));
  }
});

test('自由命题组有【有效】企业确认 → 用确认分，R4 不接管', () => {
  // ⚠️ 原实现把自由组的有效性绑在 `packageEnterpriseId` 上 ——
  //    自由命题组本来就**没有**「本赛道企业」（packageEnterpriseId 为 null），
  //    于是它的企业确认**永远**无法被认定有效 → 永远触发 R4。
  const r = applyEnterpriseRules({
    confirmations: [{ teamId: 't3', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 75, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: '由我方提供场景' }],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t3, 75, '自由组的有效确认必须被采信');
  assert.deepEqual(r.r4Substitute.t3, undefined, 'R4 不该接管');
  assert.equal(
    r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored'),
    false,
  );
});

test('自由命题组【有确认但缺双签】→ 走 R2（不是 R4）', () => {
  const r = applyEnterpriseRules({
    confirmations: [{ teamId: 't3', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 75, crossJudgeId: null, signatoryUserId: 'u_e1', content: 'x' }],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t3, 0);
  assert.ok(r.warnings.some((w) => w.code === 'R2_missing_dual_signature'));
  assert.equal(r.warnings.some((w) => w.code === 'R4_free_brief_judge_scored'), false);
});

test('R4 生效时不发「没有企业确认」告警（自由组没有确认是预期状态）', () => {
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: CONFIG,
  });
  assert.equal(
    r.warnings.some((w) => w.code === 'no_enterprise_confirmation'),
    false,
    'R4 已经接管，再发「没有企业确认」是误导性告警',
  );
});

test('R4 触发但替代维度不可用 → 响亮报错（规则静默失效最危险）', () => {
  // ⚠️ 原实现：警告说「改由评委打分」，但 r4Substitute 为空、企业项按 0 分计
  //    —— **队伍被无故扣掉企业席权重，且没人知道为什么**。
  for (const cfg of [
    { ...CONFIG, freeBrief: { judgeDimension: 'no_such_dim' } },
    { ...CONFIG, freeBrief: undefined },
  ]) {
    assert.throws(
      () => applyEnterpriseRules({
        confirmations: [],
        teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
        judges: [],
        config: cfg,
      }),
      /R4|替代维度/,
    );
  }
});

test('配置里没有 enterprise 维度 → 响亮报错（不是静默丢分）', () => {
  const cfg = { ...CONFIG, dimensions: CONFIG.dimensions.filter((d) => d.seat !== 'enterprise') };
  assert.throws(
    () => applyEnterpriseRules({
      confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'x' }],
      teams: [oneTeam('t1')],
      judges: [],
      config: cfg,
    }),
    /enterprise/,
  );
  assert.throws(
    () => applyEnterpriseRules({ confirmations: [], teams: [oneTeam('t1')], judges: [], config: { ...CONFIG, dimensions: [] } }),
    /dimensions/,
  );
});

test('R1 命中时 seatE 记 0 而不是 null（null 的唯一含义留给 R4）', () => {
  const r = applyEnterpriseRules({ confirmations: CONFIRMATIONS, teams: TEAMS, judges: [], config: CONFIG });
  assert.equal(r.seatE.t4, 0, 'R1 时权重已归 0，分数记 0；null 只能表示「R4 待替代」');
  assert.equal(r.seatE.t3, null, 'R4 才是 null');
});

test('wEnterprise 非法 → 响亮报错', () => {
  for (const bad of ['x', NaN, -1, Infinity]) {
    assert.throws(
      () => applyEnterpriseRules({
        confirmations: [],
        teams: [oneTeam('t1')],
        judges: [],
        config: { ...CONFIG, wEnterprise: bad },
      }),
      /wEnterprise/,
      `wEnterprise=${String(bad)} 必须报错`,
    );
  }
});

test('登记口径：R3 封顶后权重总和会小于 1（评委席权重不动）', () => {
  // R3 只压企业席的权重，评委席不动 → 被封掉的那部分权重**凭空消失**。
  // 因为 seatScore 按 Σw 归一化，P 的绝对值不受影响；但**评委席的相对份额**变大了。
  const over = {
    ...CONFIG,
    wEnterprise: 0.25,
    dimensions: [
      { key: 'innovation', weight: 0.60, seat: 'judge' },
      { key: 'enterprise', weight: 0.40, seat: 'enterprise' },
    ],
  };
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [oneTeam('t1')],
    judges: [],
    config: over,
  });
  const sum = Object.values(r.weights.t1).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 0.85) < 1e-12, `权重和应是 0.85，实际 ${sum}`);
});

test('登记口径：同一企业多条有效确认 → 取平均', () => {
  const r = applyEnterpriseRules({
    confirmations: [
      { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'a' },
      { teamId: 't1', enterpriseId: 'E1', dimension: 'enterprise', rawScore: 60, crossJudgeId: 'j3', signatoryUserId: 'u_e1', content: 'b' },
    ],
    teams: [oneTeam('t1')],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t1, 70, '(80+60)/2');
});

test('R4 的权重搬运：替代维度的权重真的搬到企业席了（两者不同时才验得出来）', () => {
  // ⚠️ 默认配置里 `track_fit` 与 `enterprise` 的权重**恰好都是 0.10** ——
  //    所以「搬了」与「没搬」的结果**完全一样**，这条规则从来没被真正验证过。
  //    这里把两个权重拉开、并把 wEnterprise 提到不会被 R3 压回去，才能验出差别。
  const cfg = {
    ...CONFIG,
    wEnterprise: 0.40,
    dimensions: [
      { key: 'track_fit', weight: 0.30, seat: 'judge' },
      { key: 'enterprise', weight: 0.10, seat: 'enterprise' },
    ],
  };
  const r = applyEnterpriseRules({
    confirmations: [],
    teams: [oneTeam('t3', { packageEnterpriseId: null, isFreeBrief: true })],
    judges: [],
    config: cfg,
  });
  assert.equal(r.weights.t3.track_fit, 0, '替代维度从评委席移出');
  assert.equal(r.weights.t3.enterprise, 0.30, '替代维度的权重搬到企业席（不是原来的 0.10）');
});

test('只有企业维度的确认才算企业确认（其他维度的确认不参与）', () => {
  const r = applyEnterpriseRules({
    confirmations: [{ teamId: 't1', enterpriseId: 'E1', dimension: 'track_fit', rawScore: 80, crossJudgeId: 'j2', signatoryUserId: 'u_e1', content: 'x' }],
    teams: [oneTeam('t1')],
    judges: [],
    config: CONFIG,
  });
  assert.equal(r.seatE.t1, 0, 'track_fit 维度的确认不是企业确认');
  assert.ok(r.warnings.some((w) => w.code === 'no_enterprise_confirmation'));
});

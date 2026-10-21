import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { computeTier, applyTierDemotion, classifyDepartment, isDataOrPrototypeMilestone } from '../src/domain/tier.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const R = rules.ranks;
const C = rules.criteria;

const MS = {
  problem_confirmed: { key: 'problem_confirmed', countsTowardTier: true, achieved: true },
  data_connected: { key: 'data_connected', countsTowardTier: true, achieved: true, isDataOrPrototype: true },
  demo_ready: { key: 'demo_ready', countsTowardTier: true, achieved: true, isDataOrPrototype: true },
  pilot_contract: { key: 'pilot_contract', countsTowardTier: true, achieved: true },
  iterations: { key: 'iterations', countsTowardTier: true, achieved: true },
};
const ms = (keys) => keys.map((k) => ({ ...MS[k] }));
const FIVE = ['problem_confirmed', 'data_connected', 'demo_ready', 'pilot_contract', 'iterations'];
const biz = { milestoneKey: 'pilot_contract', department: '业务部门', revokedAt: null, isBusinessDepartment: true };
const tech = { milestoneKey: 'pilot_contract', department: '技术部门', revokedAt: null, isBusinessDepartment: false };

test('D 段：报名即入档（0 里程碑）；C 段 1 个；B 段 2 个', () => {
  assert.equal(computeTier({ milestones: [], signoffs: [], ranksConfig: R }).tier, 'D');
  assert.equal(computeTier({ milestones: [], signoffs: [], ranksConfig: R }).milestoneCount, 0);
  assert.equal(computeTier({ milestones: ms(['problem_confirmed']), signoffs: [], ranksConfig: R }).tier, 'C');
  assert.equal(computeTier({ milestones: ms(['problem_confirmed', 'data_connected']), signoffs: [], ranksConfig: R }).tier, 'B');
});

test('★ 边界：3 项含接入 → A；3 项不含数据接入/原型交付 → 退回 B', () => {
  assert.equal(computeTier({ milestones: ms(['problem_confirmed', 'data_connected', 'demo_ready']), signoffs: [], ranksConfig: R }).tier, 'A');
  const out = computeTier({ milestones: ms(['problem_confirmed', 'pilot_contract', 'iterations']), signoffs: [], ranksConfig: R });
  assert.equal(out.tier, 'B');
  assert.equal(out.milestoneCount, 3);
});

test('★ 边界：5 项含企业业务部门签字 → S；技术部门签字不计入 S（R-PTS-03）', () => {
  const s = computeTier({ milestones: ms(FIVE), signoffs: [biz], ranksConfig: R });
  assert.equal(s.tier, 'S');
  assert.equal(s.businessSignoffCount, 1);
  const t = computeTier({ milestones: ms(FIVE), signoffs: [tech], ranksConfig: R });
  assert.equal(t.tier, 'A', '技术部门签字不算 S');
  assert.equal(t.businessSignoffCount, 0);
});

test('撤回的签字不计入段位；未达成 / 不计段的里程碑不计数', () => {
  const revoked = computeTier({
    milestones: ms(FIVE),
    signoffs: [{ ...biz, revokedAt: '2026-10-20T00:00:00Z' }], ranksConfig: R,
  });
  assert.equal(revoked.tier, 'A');
  const out = computeTier({
    milestones: [
      { key: 'problem_confirmed', countsTowardTier: true, achieved: true },
      { key: 'data_connected', countsTowardTier: true, achieved: false },
      { key: 'x', countsTowardTier: false, achieved: true },
    ],
    signoffs: [], ranksConfig: R,
  });
  assert.equal(out.milestoneCount, 1);
  assert.equal(out.tier, 'C');
});

test('★ 段位只换资源不换钱（R-PTS-05）：权益来自配置，永不出现奖金', () => {
  const out = computeTier({ milestones: ms(['problem_confirmed', 'data_connected', 'demo_ready']), signoffs: [], ranksConfig: R });
  assert.deepEqual(out.benefits, R.benefits.A);
  assert.deepEqual(out.neverUnlocks, ['奖金', '决赛名次']);
  assert.ok(!JSON.stringify(out.benefits).includes('奖金'));
});

test('★ 降级：撤回签字 → 降回对应档；连续 14 天零提交 → 降 1 档并公示；不低于 D 段', () => {
  const revoked = applyTierDemotion({
    tier: 'S', daysSinceLastActivity: 0,
    revokedSignoffs: [{ milestoneKey: 'pilot_contract', revokedAt: '2026-10-20T00:00:00Z' }],
    ranksConfig: R,
  });
  assert.equal(revoked.demoted, true);
  assert.equal(revoked.tier, 'A');
  assert.equal(revoked.from, 'S');
  assert.equal(revoked.publish, true, '降级必须公示');
  assert.ok(revoked.reason.includes('signoff_revoked'));

  const idle = applyTierDemotion({ tier: 'B', daysSinceLastActivity: 14, revokedSignoffs: [], ranksConfig: R });
  assert.equal(idle.demoted, true);
  assert.equal(idle.tier, 'C');
  assert.equal(idle.publish, true);
  assert.ok(idle.reason.includes('inactive_14days'));
  const notYet = applyTierDemotion({ tier: 'B', daysSinceLastActivity: 13, revokedSignoffs: [], ranksConfig: R });
  assert.equal(notYet.demoted, false);
  assert.equal(notYet.tier, 'B');

  const floor = applyTierDemotion({ tier: 'D', daysSinceLastActivity: 99, revokedSignoffs: [{ revokedAt: 'x' }], ranksConfig: R });
  assert.equal(floor.tier, 'D');
});

test('部门归类与数据接入/原型交付识别', () => {
  assert.equal(classifyDepartment('业务部门', C), 'business');
  assert.equal(classifyDepartment('技术部门', C), 'technical');
  assert.equal(classifyDepartment('市场部', C), 'business');
  assert.equal(classifyDepartment('研发中心', C), 'technical');
  assert.equal(classifyDepartment('法务部', C), 'unknown');
  assert.equal(classifyDepartment('', C), 'unknown');
  assert.equal(isDataOrPrototypeMilestone('data_connected', C), true);
  assert.equal(isDataOrPrototypeMilestone('demo_ready', C), true);
  assert.equal(isDataOrPrototypeMilestone('revenue', C), false);
});

test('段位的展示字段：tierName / reasons / benefits / neverUnlocks 都来自配置', () => {
  const out = computeTier({ milestones: ms(['problem_confirmed', 'data_connected', 'demo_ready']), signoffs: [], ranksConfig: R });
  assert.equal(out.tier, 'A');
  assert.equal(out.tierName, '接入', 'tierName 来自配置的中文名');
  assert.deepEqual(out.benefits, R.benefits.A);
  assert.deepEqual(out.neverUnlocks, ['奖金', '决赛名次']);
  assert.deepEqual(out.reasons, ['milestones=3', 'data_or_prototype=2', 'tier=A']);

  const d = computeTier({ milestones: [], signoffs: [], ranksConfig: R });
  assert.equal(d.tierName, '出题');
  assert.deepEqual(d.benefits, [], 'D 段配置里没有权益 → 空数组（不是 undefined）');
  assert.deepEqual(d.reasons, ['milestones=0', 'tier=D'], '没有数据接入时不得凭空出现该理由');
});

test('配置缺字段时的容错：段位名 / 权益 / neverUnlocks 都不许是 undefined', () => {
  const custom = { tiers: [{ key: 'D', name: 'D 档', minMilestones: 0 }] };
  const out = computeTier({ milestones: [], signoffs: [], ranksConfig: custom });
  assert.equal(out.tier, 'D');
  assert.equal(out.tierName, 'D 档', '段位名来自配置，不许退回硬编码');
  assert.deepEqual(out.benefits, []);
  assert.deepEqual(out.neverUnlocks, [], '配置缺 neverUnlocks → 空数组');
});

test('★ 里程碑的取值口径：achieved 必须是 true、countsTowardTier 缺省计入', () => {
  const out = computeTier({
    milestones: [
      { key: 'problem_confirmed', achieved: true },                  // 缺 countsTowardTier → 计入
      { key: 'data_connected', achieved: 1, isDataOrPrototype: true }, // achieved=1 不是 true → 不计入
      { key: 'demo_ready', achieved: true, isDataOrPrototype: true },
    ],
    signoffs: [], ranksConfig: R,
  });
  assert.equal(out.milestoneCount, 2, 'achieved=1 不是布尔 true → 不计入；缺 countsTowardTier → 计入');
  assert.equal(out.tier, 'B', '2 个里程碑 → B 段（D0 / C1 / B2 / A3 / S5）');
});

test('缺 milestones / signoffs 参数时按空集处理（不崩）', () => {
  const out = computeTier({ signoffs: [], ranksConfig: R });
  assert.equal(out.tier, 'D');
  assert.equal(out.milestoneCount, 0);
  const out2 = computeTier({ milestones: ms(FIVE), ranksConfig: R });
  assert.equal(out2.tier, 'A', '没有 signoffs → 最高只到 A');
  assert.equal(out2.businessSignoffCount, 0);
});

test('部门归类的容错：大小写、配置里的大写关键词、缺 tier 段', () => {
  assert.equal(classifyDepartment('BUSINESS', C), 'business', '关键词大小写不敏感');
  assert.equal(classifyDepartment('biz', { tier: { businessDepartmentKeywords: ['BIZ'] } }), 'business',
    '配置里的大写业务关键词也要能匹配');
  assert.equal(classifyDepartment('tech', { tier: { technicalDepartmentKeywords: ['TECH'] } }), 'technical',
    '配置里的大写技术关键词也要能匹配');
  assert.equal(classifyDepartment('业务部门', {}), 'unknown', '配置缺 tier 段 → 一律 unknown');
  assert.equal(classifyDepartment(undefined, C), 'unknown');
  assert.equal(isDataOrPrototypeMilestone('data_connected', {}), false, '配置缺 tier 段 → 不认任何里程碑');
});

test('★ 没标 isBusinessDepartment 的签字不得算业务签字（S 段不得凭空达标）', () => {
  const out = computeTier({
    milestones: ms(FIVE),
    signoffs: [{ milestoneKey: 'pilot_contract', department: '某部门', revokedAt: null }],   // 没有 isBusinessDepartment
    ranksConfig: R,
  });
  assert.equal(out.businessSignoffCount, 0, '标志位缺失 ≠ 业务部门');
  assert.equal(out.tier, 'A', 'S 段不得凭空达标');
});

test('★ 降级：两条规则同时命中时只降 1 档，原因两条都记', () => {
  const both = applyTierDemotion({
    tier: 'S', daysSinceLastActivity: 14,
    revokedSignoffs: [{ milestoneKey: 'pilot_contract', revokedAt: '2026-10-20T00:00:00Z' }],
    ranksConfig: R,
  });
  assert.equal(both.demoted, true);
  assert.equal(both.tier, 'A', '只降 1 档（不叠加）');
  assert.equal(both.reason, 'signoff_revoked+inactive_14days', '两条原因都要记');
});

test('降级的配置口径：onSignoffRevoked / inactiveDays / inactiveDropLevels / publishDemotion 都要生效', () => {
  const base = { tiers: R.tiers, demotion: { ...R.demotion } };

  const noRevoke = applyTierDemotion({
    tier: 'S', daysSinceLastActivity: 0,
    revokedSignoffs: [{ revokedAt: 'x' }],
    ranksConfig: { ...base, demotion: { ...base.demotion, onSignoffRevoked: false } },
  });
  assert.equal(noRevoke.demoted, false, '配置关掉撤回降级 → 不降');

  const noPublish = applyTierDemotion({
    tier: 'B', daysSinceLastActivity: 14, revokedSignoffs: [],
    ranksConfig: { ...base, demotion: { ...base.demotion, publishDemotion: false } },
  });
  assert.equal(noPublish.demoted, true);
  assert.equal(noPublish.publish, false, '配置关掉公示 → 不公示');

  const missing = applyTierDemotion({
    tier: 'B', daysSinceLastActivity: 14, revokedSignoffs: [],
    ranksConfig: { tiers: R.tiers, demotion: {} },
  });
  assert.equal(missing.demoted, true, '配置缺 inactiveDays → 兜底 14 天');
  assert.equal(missing.tier, 'C', '配置缺 inactiveDropLevels → 兜底降 1 档');
  assert.ok(missing.reason.includes('inactive_14days'));

  const twoLevels = applyTierDemotion({
    tier: 'C', daysSinceLastActivity: 14, revokedSignoffs: [],
    ranksConfig: { ...base, demotion: { ...base.demotion, inactiveDropLevels: 2 } },
  });
  assert.equal(twoLevels.tier, 'D', '配置降 2 档 → 从 C 降到 D（不越界到 D 以下）');
});

test('降级：未命中的段位名回落到最低档，且不下探到 D 以下', () => {
  const unknown = applyTierDemotion({ tier: 'X', daysSinceLastActivity: 0, revokedSignoffs: [], ranksConfig: R });
  assert.equal(unknown.from, 'D', '未知段位按最低档处理');
  assert.equal(unknown.demoted, false);

  const floor = applyTierDemotion({ tier: 'D', daysSinceLastActivity: 99, revokedSignoffs: [{ revokedAt: 'x' }], ranksConfig: R });
  assert.equal(floor.tier, 'D', 'D 段是地板');
  assert.equal(floor.from, 'D');

  const notYet = applyTierDemotion({ tier: 'B', daysSinceLastActivity: 13, revokedSignoffs: [], ranksConfig: R });
  assert.equal(notYet.demoted, false);
  assert.equal(notYet.reason, null, '没降级时原因必须是 null');
  assert.equal(notYet.publish, false);
  assert.equal(notYet.from, 'B');
});

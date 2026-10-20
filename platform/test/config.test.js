import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, validateRules } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

test('仓库自带的 9 份规则配置能通过校验', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(validateRules(rules), []);
});

test('权重合计不等于 100% 会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.dimensions[0].weight = 0.30; // 合计变 105%
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('scoring.final') && e.includes('权重合计')));
});

test('初赛企业确认权重必须是 10%（裁决 C-01）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.scoring.initial.wEnterprise, 0.10);
  const broken = structuredClone(rules);
  broken.scoring.initial.wEnterprise = 0.20;
  assert.ok(validateRules(broken).some((e) => e.includes('wEnterprise')));
});

test('wEnterprise 必须等于企业确认维度的权重', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.wEnterprise = 0.30;
  assert.ok(validateRules(broken).some((e) => e.includes('wEnterprise')));
});

test('段位门槛必须严格递增', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.ranks.tiers[2].minMilestones = 0;
  assert.ok(validateRules(broken).some((e) => e.includes('ranks')));
});

test('报名等级阈值必须单调不增', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.registration.levels[1].minScore = 90; // A 级阈值高于 S 级
  assert.ok(validateRules(broken).some((e) => e.includes('registration')));
});

test('破同分链必须以确定性兜底项结尾', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.tiebreak.chain.pop();
  assert.ok(validateRules(broken).some((e) => e.includes('tiebreak')));
});

// ── 以下 6 条覆盖「9 份配置全部有内容校验」这条要求 ──────────────
// 行为分 / 可见性 / 里程碑这三份配置如果只被读出来、不被校验，
// 写错了也要等到 P2/P3 算分算榜时才发现 —— 那时榜单可能已经发出去了。

test('behavior 的行为分占比上限必须在 0..1', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.maxWeightShare = 1.5;
  assert.ok(validateRules(broken).some((e) => e.includes('behavior')));
});

test('behavior 事件的 points 必须为正数', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events[0].points = 0;
  assert.ok(validateRules(broken).some((e) => e.includes('behavior')));
});

test('visibility 引用的段位必须真实存在', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.visibility.rank.publicFromTier = 'Z';
  assert.ok(validateRules(broken).some((e) => e.includes('visibility')));
});

test('milestones 的确认方枚举必须合法', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.milestones.items[0].confirmedBy = 'nobody';
  assert.ok(validateRules(broken).some((e) => e.includes('milestones')));
});

test('缺失 dimensions 时报友好错误，而不是抛 TypeError', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.final.dimensions;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('scoring.final') && e.includes('dimensions')),
    '缺失 dimensions 应被当作校验错误报告，而不是抛 TypeError',
  );
});

test('维度 key 重复会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.dimensions[1].key = broken.scoring.final.dimensions[0].key;
  assert.ok(validateRules(broken).some((e) => e.includes('重复 key')));
});

// ── 以下 3 条来自实现者实测反馈的 3 条漏检（父代理裁决后采纳）──────────

test('9 份配置的 version 必须一致（漂移会让计算 trace 说谎）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.tiebreak.version = '2099-01-01';
  assert.ok(validateRules(broken).some((e) => e.includes('version')));
});

test('数组里混入 null 元素时报友好错误，而不是抛 TypeError', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events[0] = null;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('behavior.events')),
    'null 元素应被当作校验错误报告，而不是抛 TypeError',
  );
});

test('solvability.grades 的评分区间不得重叠', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.solvability.grades[1].minScore = broken.solvability.grades[0].minScore; // B 覆盖到 A
  assert.ok(validateRules(broken).some((e) => e.includes('区间重叠')));
});

// ── 以下 6 条来自 Task 3 评审（rule-decisions 裁决的落地方式未落实）──────────

test('归一化的兜底策略 fallback 必须是 global 或 raw（C-05 裁决）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.scoring.initial.fallback, 'global');
  assert.equal(rules.scoring.final.fallback, 'global');
  const broken = structuredClone(rules);
  delete broken.scoring.final.fallback;
  assert.ok(validateRules(broken).some((e) => e.includes('fallback')));
});

test('C-01 裁决由运行时校验器锁住（不只靠测试）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  // 同时改 wEnterprise 与企业维度权重，并把完成度调低 —— 合计仍是 100%。
  // 这正是「只靠测试锁不住」的绕过路径。
  broken.scoring.initial.wEnterprise = 0.20;
  const ent = broken.scoring.initial.dimensions.find((d) => d.seat === 'enterprise');
  ent.weight = 0.20;
  broken.scoring.initial.dimensions.find((d) => d.key === 'completeness').weight = 0.15;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('C-01')),
    'C-01 裁决的初赛企业确认权重 10% 必须由校验器锁住',
  );
});

test('solvability.grades 的反向区间（min > max）会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.solvability.grades[0].maxScore = 6; // A 变成 10-6，永远匹配不到
  assert.ok(validateRules(broken).some((e) => e.includes('区间非法')));
});

test('维度缺少 key 会被拒绝（否则算分无法映射回维度）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.final.dimensions[0].key;
  assert.ok(validateRules(broken).some((e) => e.includes('缺少 key')));
});

test('某份配置缺少 version 会被拒绝（不能只校验存在的那几份）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.tiebreak.version;
  assert.ok(validateRules(broken).some((e) => e.includes('缺少 version')));
});

test('破同分链每一项都必须标注来源文档（C-03 落地要求）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.tiebreak.chain[1].source;
  assert.ok(validateRules(broken).some((e) => e.includes('source')));
});

test('权重合计的容差必须严格：合计 101% 也要被拒绝（终审 I-6-6）', () => {
  // ⛔ 终审发现（Important）：权重合计的容差是 1e-9。把容差放宽到 0.02 后，
  //    **权重合计 101% 的配置能启动** —— 榜单整体错位 1% 而系统不报错。
  //    rule-decisions.md:158 明写「C-01 如果被硬编码，初赛榜单**整体错位**且不报错」
  //    —— 这正是这类 bug 的形状。
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  // 把初赛第一个维度的权重 +0.01 → 合计 101%
  broken.scoring.initial.dimensions[0].weight += 0.01;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('scoring.initial') && e.includes('权重合计')),
    `合计 101% 必须被拒绝，实际校验结果：${JSON.stringify(errors)}`,
  );
});

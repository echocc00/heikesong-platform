import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, validateRules } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

test('仓库自带的全部规则配置能通过校验', () => {
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

// ── 以下 6 条覆盖「每份配置都有内容校验」这条要求 ──────────────
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

test('全部配置的 version 必须一致（漂移会让计算 trace 说谎）', () => {
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

// ── 以下 4 条来自 P2 Task 8（新增字段的 fail-fast 校验）────────────────────

test('P2：缺 judgePool 段会被拒绝（R-JDG-10 / R-JDG-11 的评委池构成必须配置化）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.initial.judgePool;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('scoring.initial') && e.includes('judgePool')));
});

test('P2：judgePool 的占比必须在 0..1', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.judgePool.minEnterpriseSeatShare = 1.5;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('minEnterpriseSeatShare')));
});

test('P2：freeBrief.judgeDimension 必须指向一个评委席维度（R4 的替代维度）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.initial.freeBrief.judgeDimension = 'enterprise'; // 企业席维度不能当替代
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('freeBrief.judgeDimension')));
});

test('P2：归一化策略参数（trimmedIterations / bayesPriorStrength）非法会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.initial.trimmedIterations = 0;
  broken.scoring.final.bayesPriorStrength = -1;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('trimmedIterations')));
  assert.ok(errors.some((e) => e.includes('bayesPriorStrength')));
});

// ═══════════════════════════════════════════════════════════════════
// M0-1「完赛线可达性机器闸」
// ═══════════════════════════════════════════════════════════════════
// ⚠️ 为什么这道闸必须存在：行为分的次数约束里有**按时间**封顶的事件
//    （weekly_progress = 每周 1 次）⇒ 赛程只有 31 天时最多兑现 5 次。
//    ⇒ 只看「事件理论上限」会算出假绿的「完赛线可达」。
//    M0-1 之前正是这个病：理论上限 60+，赛程内实际只有 33 分 ⇒ 完赛线不可达。

test('★ M0-1：仓库自带的规则在真实赛程内够得着完赛线（正对照）', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(validateRules(rules), [], '仓库自带规则必须通过全部校验（含可达性闸）');
  // 夹具判别性：把口径钉死 —— 上限 63 = 10（每周 5 次）+ 3 + 5×7（7 个里程碑）+ 5 + 10
  const ms = rules.behavior.events.find((e) => e.key === 'milestone_on_time');
  assert.equal(ms.countBy, 'milestone', '交付里程碑必须按里程碑计次');
  assert.equal(rules.behavior.completionThreshold, 60);
  assert.equal(rules.milestones.items.length, 7, '7 个里程碑（上限 5×7 = 35 分）');
});

test('★ M0-1：把交付里程碑改回终身一次 ⇒ 上限掉回 33 < 60 ⇒ 拒绝启动', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events = broken.behavior.events.map((e) => (
    e.key === 'milestone_on_time' ? { ...e, countBy: undefined } : e
  ));
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('完赛线不可达')),
    `完赛线不可达必须被拒绝，实际校验结果：${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some((e) => e.includes('33') && e.includes('60')),
    `报错必须带**人话数字**（当前上限 vs 完赛线），实际：${JSON.stringify(errors)}`,
  );
});

test('★ M0-1：完赛线抬到 100 ⇒ 63 < 100 ⇒ 拒绝启动（闸对改坏配置真的拦得住）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.completionThreshold = 100;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('完赛线不可达')), JSON.stringify(errors));
});

test('★ M0-1：赛程被压短（每周进度兑现次数变少）⇒ 上限不够 ⇒ 拒绝启动', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  // 把 5 个赛段压进 3 天 ⇒ 每周进度只能兑现 1 次 ⇒ 上限 = 2 + 3 + 35 + 5 + 10 = 55 < 60
  broken.schedule.stages = broken.schedule.stages.map((st, i) => ({
    ...st, start: '10-01', end: '10-03',
  }));
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('完赛线不可达')), JSON.stringify(errors));
});

test('★ M0-1：countBy 写错拼写必须当场拒绝（不许静默退回终身一次）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events = broken.behavior.events.map((e) => (
    e.key === 'milestone_on_time' ? { ...e, countBy: 'milestones' } : e
  ));
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('countBy')), JSON.stringify(errors));
});

// ═══════════════════════════════════════════════════════════════════
// M0-5「IP 阈值开机校验」
// ═══════════════════════════════════════════════════════════════════
// ⚠️ 为什么必须机器闸：登录路由的顺序是「来源预检（scrypt 前）→ 口令校验 → 账号配额」，
//    两条计数同时增长 ⇒ 来源阈值不更紧 ⇒ 永远是账号配额先触顶 ⇒ 来源预检不触发
//    ⇒ 限频挡不住 CPU 打爆。这条约束写在规则注释里，但**机器必须自己守着**。

test('★ M0-5：来源阈值必须比账号阈值更紧（正对照：仓库自带配置 8 < 10）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.audit.rateLimit.loginAttemptByIp.sliding.max, 8);
  assert.equal(rules.audit.rateLimit.loginAttempt.sliding.max, 10);
  assert.deepEqual(validateRules(rules), []);
});

test('★ M0-5：把来源阈值改成 11 ⇒ 拒绝启动并报人话', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.audit.rateLimit.loginAttemptByIp.sliding.max = 11;
  const errors = validateRules(broken);
  const hit = errors.find((e) => e.includes('loginAttemptByIp.sliding.max'));
  assert.ok(hit, `必须报错，实际校验结果：${JSON.stringify(errors)}`);
  assert.ok(hit.includes('11') && hit.includes('10'), `报错必须带两个阈值数字，实际：${hit}`);
  assert.ok(hit.includes('CPU'), `报错必须说清后果（CPU 保护落空），实际：${hit}`);
});

test('★ M0-5：来源阈值与账号阈值相等 ⇒ 也必须拒绝（不是「不小于」而是「严格小于」）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.audit.rateLimit.loginAttemptByIp.sliding.max = 10;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('loginAttemptByIp.sliding.max')), JSON.stringify(errors));
});

// ═══════════════════════════════════════════════════════════════════
// M0-3「首届口径调整」（归一化策略 + 评委池下限 + 样本数门槛）
// ═══════════════════════════════════════════════════════════════════
// ⚠️ 为什么这三项必须一起改：只改策略不改门槛 ⇒ 样本数仍 < 门槛 ⇒ 归一化照样
//    **永远走全局回退** ⇒ 「降级」仍是常态路径（C-05 结构性张力在首届的具体表现）。

test('★ M0-3：首届默认用 trimmed 归一化 + 评委池下限 3 + 样本数门槛 3', () => {
  const { rules } = loadRules(rulesDir);
  for (const key of ['initial', 'final']) {
    const cfg = rules.scoring[key];
    assert.equal(cfg.normalizationStrategy, 'trimmed', `${key} 归一化策略必须是 trimmed`);
    assert.equal(cfg.judgePool.minJudgesPerDimension, 3, `${key} 评委池下限必须是 3`);
    assert.equal(cfg.minSamplesForJudgeNormalization, 3, `${key} 样本数门槛必须是 3`);
  }
  // ⚠️ **可恢复性**：三个值都只是配置 ⇒ 恢复全文赛制口径（zscore / 7 / 9 / 5）
  //    只需改 rules/scoring-*.json，代码不硬编码任何阈值 ⇒ 这里断言「配置层可改」。
  const broken = structuredClone(rules);
  broken.scoring.initial.normalizationStrategy = 'zscore';
  broken.scoring.initial.judgePool.minJudgesPerDimension = 7;
  broken.scoring.initial.minSamplesForJudgeNormalization = 5;
  assert.deepEqual(validateRules(broken), [], '改回全文赛制口径必须仍然能启动（不是硬编码）');
});

test('★ M0-3：归一化策略写错必须拒绝启动（VALID_NORMALIZATIONS 闸）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.initial.normalizationStrategy = 'robust_zscore';
  assert.ok(validateRules(broken).some((e) => e.includes('normalizationStrategy')));
});

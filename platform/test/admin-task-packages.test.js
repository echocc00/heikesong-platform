// platform/test/admin-task-packages.test.js — 任务卡分级 / 审批界面的行为闸
//
// 依据：P10 计划 §4 W4-a（docs/superpowers/plans/2026-10-22-platform-P10-design-system.md）
// 视觉契约：docs/design-system-p10.md §4「外壳三件套 / 现有组件」§7「数据纪律」
// 溯源需求：R-ENT-06（六维可解性）/ R-ENT-07（一票否决）/ R-ENT-08（分级签约与协议）
//
// ⚠️ 本文件守的是三件**肉眼很难发现、但用户一定看得见**的事：
//   ① 六维评估表必须**六维都在**，且权重 / 量表上限 **来自 rules/solvability.json**
//      —— 前端写死任何一维 = 委员会改了配置、页面还在按旧口径打分；
//   ② 退回必须写理由 —— 没有理由的退回对出题方等于什么都没说；
//   ③ 失败必须留下**真能点的「重试」** —— 错误态是死路 = 生产级事故（DP-80）。
//
// ⚠️ 本文件还带一条**机器闸**：视图源码里不许出现 rules 里的字面量
//    （维度名 / 维度键 / 否决项 / 档位文案 / 权重）。
//    这条闸守的是全局约束「赛制只从 rules/*.json 来」——
//    写在测试里而不是靠自觉：改视图的人跑一次全量就知道自己踩了红线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTempDir } from '../test-helpers/tmp.js';

import {
  solvabilitySpecFromRules, solvabilitySpecFromPackages, resolveSolvabilitySpec,
  gradeTiers, selfReportedVetoes, packageView,
  solvabilityFormHtml, signoffFormHtml, taskPackageCardHtml, taskPackagesHtml, feedbackHtml,
  planSolvabilitySubmit, planSignoffSubmit, statCards, mixPanelHtml,
} from '../web/views/admin-task-packages.js';

// ⚠️ 隔离本进程临时目录（与其它测试同一口径）：进程退出时整体回收。
//    本文件本身不建临时目录，但统一口径 ⇒ 任何一行将来加的临时文件都自动被回收。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const RULES = JSON.parse(readFileSync(join(here, '..', 'rules', 'solvability.json'), 'utf8'));
const VIEW_JS = readFileSync(join(webDir, 'views', 'admin-task-packages.js'), 'utf8');

/** 一张「还没评估过」的任务卡（形状对齐后端 presentTaskPackage）。 */
function samplePkg(overrides = {}) {  return {
    id: 'tp_1',
    editionId: 'ed_1',
    enterpriseId: 'ent_1',
    enterpriseName: '演示企业',
    title: '门店缺货预测',
    painPoint: '缺货导致丢单',
    expectedDelivery: '每周补货建议',
    acceptanceCriteria: '建议采纳率可统计',
    grade: null,
    status: 'submitted',
    solvabilityScore: null,
    solvabilityGrade: null,
    commitment: '',
    agreement: '',
    isFreeBrief: false,
    meta: {},
    ...overrides,
  };
}

/** 取渲染结果里某个动作的按钮标签（用来断言「按钮在，但被锁住」）。 */
function buttonTag(html, action) {
  const m = String(html).match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`));
  return m ? m[0] : '';
}

// ══════════════════════════════════════════════════════════════════
// 一、六维评估表：维度 / 权重 / 量表全部来自规则
// ══════════════════════════════════════════════════════════════════

test('六维评估表：六维全在，权重与量表上限都来自规则', () => {
  const spec = solvabilitySpecFromRules(RULES);
  assert.equal(spec.dimensions.length, RULES.dimensions.length, '维度数必须与规则一致');

  const html = solvabilityFormHtml({ pkg: samplePkg(), spec });
  for (const d of RULES.dimensions) {
    assert.ok(html.includes(d.label), `维度「${d.label}」必须出现在评估表里`);
    assert.ok(
      html.includes(`${Math.round(d.weight * 100)}%`),
      `维度「${d.label}」的权重必须来自规则（${d.weight}）`,
    );
    assert.ok(
      html.includes(`>${d.max} / ${d.max}<`),
      `维度「${d.label}」的量表上限必须是 ${d.max}`,
    );
    assert.ok(
      html.includes(`data-dimension="${d.key}"`),
      `维度「${d.label}」必须带上规则里的键（提交时按键传 answers）`,
    );
  }
});

test('机器闸：视图源码里不许出现 rules 里的字面量（维度 / 否决项 / 档位文案 / 权重）', () => {
  const forbidden = [
    ...RULES.dimensions.map((d) => d.label),
    ...RULES.dimensions.map((d) => d.key),
    ...RULES.vetoes.map((v) => v.label),
    ...RULES.vetoes.map((v) => v.key),
    ...RULES.grades.map((g) => g.commitment),
    ...RULES.grades.map((g) => g.agreement),
    ...RULES.dimensions.map((d) => Number(d.weight).toFixed(2)),
  ]
    .filter((s) => typeof s === 'string' && s.trim().length >= 2)
    .map((s) => s.trim());

  assert.ok(forbidden.length >= 10, `禁用词条不该是空集（实际 ${forbidden.length} 条）`);
  for (const s of forbidden) {
    assert.ok(
      !VIEW_JS.includes(s),
      `视图源码里出现了规则字面量「${s}」—— 六维与档位只能来自 rules/solvability.json`,
    );
  }
});

test('规格来源：已评估过的卡能从服务端投影里拿到六维；没评估过就拿不到', () => {
  const explain = RULES.dimensions.map((d) => ({
    dimension: d.key, label: d.label, value: 1, max: d.max, weight: d.weight,
  }));
  const assessed = samplePkg({ status: 'assessed', meta: { solvability: { explain } } });

  const spec = solvabilitySpecFromPackages([assessed]);
  assert.equal(spec.source, 'api');
  assert.equal(spec.dimensions.length, RULES.dimensions.length);
  assert.equal(spec.dimensions[0].key, RULES.dimensions[0].key);
  assert.equal(spec.dimensions[0].label, RULES.dimensions[0].label);
  assert.equal(spec.dimensions[0].max, RULES.dimensions[0].max);

  assert.equal(solvabilitySpecFromPackages([samplePkg()]), null, '没评估过的卡没有规格');
  assert.equal(solvabilitySpecFromPackages(null), null, '入参为 null 不得抛错');
});

test('规格取舍：规则投影更完整 ⇒ 有它就用它；没有才退回服务端投影', () => {
  const explain = RULES.dimensions.map((d) => ({
    dimension: d.key, label: d.label, value: 1, max: d.max, weight: d.weight,
  }));
  const assessed = samplePkg({ status: 'assessed', meta: { solvability: { explain } } });

  const withRules = resolveSolvabilitySpec({ packages: [assessed], rules: RULES });
  assert.equal(withRules.source, 'rules');
  assert.equal(withRules.grades.length, RULES.grades.length, '档位必须来自规则（含分数区间）');

  const withoutRules = resolveSolvabilitySpec({ packages: [assessed], rules: null });
  assert.equal(withoutRules.source, 'api');
});

test('规格缺失：评估表不编造维度，只给一条能照做的提示', () => {
  const html = solvabilityFormHtml({ pkg: samplePkg(), spec: null });
  assert.ok(html.includes('六维评估表尚未就绪'), '必须说清为什么没有评估表');
  assert.ok(!html.includes('data-role="dimension"'), '没有规格就不许渲染评分控件');
});

// ══════════════════════════════════════════════════════════════════
// 二、签级 / 退回
// ══════════════════════════════════════════════════════════════════

test('签级：档位、承诺与协议都来自规则；最低一档是退回档', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const tiers = gradeTiers(spec);

  const lowest = [...RULES.grades].sort((a, b) => a.minScore - b.minScore)[0];
  assert.equal(tiers.return.key, lowest.key, '退回档必须是分数区间最低的那一档');
  assert.equal(tiers.approve.length, RULES.grades.length - 1, '其余档位是「通过」档');
  assert.ok(tiers.complete);

  const html = signoffFormHtml({ pkg: samplePkg(), spec });
  for (const g of tiers.approve) {
    assert.ok(html.includes(g.commitment), `档位「${g.key}」的企业承诺必须显示`);
    assert.ok(html.includes(`value="${g.key}"`), `档位「${g.key}」必须在可选项里`);
  }
  assert.ok(html.includes(tiers.return.agreement), '退回档的协议文案必须显示');
  assert.ok(!html.includes(`value="${tiers.return.key}"`), '退回档不该混进「通过」的可选项');
});

test('退回：理由为空时**不提交**（本地拦下），有理由才发请求', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const pkg = samplePkg({ status: 'assessed' });

  const empty = planSignoffSubmit({ pkg, action: 'return', reason: '   ', spec });
  assert.equal(empty.ok, false, '没有理由的退回不得发出去');
  assert.match(empty.message, /理由/, '必须说清缺的是理由');
  assert.equal(empty.url, undefined, '被拦下时不得产生请求地址');

  const ok = planSignoffSubmit({ pkg, action: 'return', reason: '缺数据授权说明', spec });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.grade, gradeTiers(spec).return.key, '退回必须落到退回档');
  assert.equal(ok.body.reason, '缺数据授权说明');
  assert.equal(ok.url, `/api/task-packages/${pkg.id}/approve`);
});

test('签级通过：必须选一个有效档位；body 只带 grade', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const pkg = samplePkg({ status: 'assessed' });
  const tiers = gradeTiers(spec);

  const bad = planSignoffSubmit({ pkg, action: 'approve', grade: '', spec });
  assert.equal(bad.ok, false, '没选档位不得发出去');

  const ok = planSignoffSubmit({ pkg, action: 'approve', grade: tiers.approve[0].key, spec });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.grade, tiers.approve[0].key);
  assert.equal(ok.url, `/api/task-packages/${pkg.id}/approve`);
});

test('退回理由的输入框在表单里（且标了必填）', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const html = signoffFormHtml({ pkg: samplePkg({ status: 'assessed' }), spec });
  assert.ok(html.includes('data-role="reason"'), '必须有理由输入框');
  assert.ok(html.includes('field--required'), '理由字段必须标必填');
  assert.ok(html.includes('data-action="return"'), '必须有退回按钮');
  assert.ok(html.includes('data-action="approve"'), '必须有签级通过按钮');
});

// ══════════════════════════════════════════════════════════════════
// 三、六维评估的提交计划
// ══════════════════════════════════════════════════════════════════

test('六维评估：漏打分的维度不许发出去；全打分才提交', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const pkg = samplePkg();
  const values = {};
  for (const d of RULES.dimensions) values[d.key] = d.max;

  const plan = planSolvabilitySubmit({ pkg, values, spec });
  assert.equal(plan.ok, true);
  assert.equal(plan.url, `/api/task-packages/${pkg.id}/solvability`);
  assert.equal(
    Object.keys(plan.body.answers).length,
    RULES.dimensions.length,
    'answers 必须六维齐全',
  );

  const partial = { ...values };
  delete partial[RULES.dimensions[0].key];
  const bad = planSolvabilitySubmit({ pkg, values: partial, spec });
  assert.equal(bad.ok, false, '漏一维就得拦下');
  assert.match(bad.message, new RegExp(RULES.dimensions[0].label), '要说清漏的是哪一维');
});

test('六维评估：分数越界（超出量表上限）不许发出去', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const values = {};
  for (const d of RULES.dimensions) values[d.key] = d.max;
  values[RULES.dimensions[0].key] = RULES.dimensions[0].max + 1;

  const bad = planSolvabilitySubmit({ pkg: samplePkg(), values, spec });
  assert.equal(bad.ok, false, '越界的分数服务端会 400，前端先拦一道');
});

// ══════════════════════════════════════════════════════════════════
// 四、否决项
// ══════════════════════════════════════════════════════════════════

test('否决项：只有规则里没有 auto 的那些才让委员会自报', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const expected = RULES.vetoes.filter((v) => !v.auto);
  const self = selfReportedVetoes(spec);
  assert.equal(self.length, expected.length);

  const html = solvabilityFormHtml({ pkg: samplePkg(), spec });
  for (const v of expected) {
    assert.ok(html.includes(v.label), `自报项「${v.label}」必须出现在表单里`);
  }
  for (const v of RULES.vetoes.filter((x) => x.auto)) {
    assert.ok(
      !html.includes(v.label),
      `「${v.label}」是由维度取值自动推导的，不该让委员会自报`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════
// 五、状态机
// ══════════════════════════════════════════════════════════════════

test('状态机：已发布的卡的评估与签级控件**锁住**（按钮在，但点不动）', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const published = samplePkg({ status: 'published' });

  const form = solvabilityFormHtml({ pkg: published, spec });
  const assess = buttonTag(form, 'assess');
  assert.ok(assess, '评估提交按钮要留着（委员会看得见这张卡怎么评的）');
  assert.ok(assess.includes('disabled'), '已发布的卡不得还能提交评估');
  assert.ok(form.includes('已发布'), '必须说清为什么锁着');

  const sign = signoffFormHtml({ pkg: published, spec });
  assert.ok(buttonTag(sign, 'approve').includes('disabled'), '已发布的卡不得还能签级');
  assert.ok(buttonTag(sign, 'return').includes('disabled'), '已发布的卡不得还能退回');

  const open = solvabilityFormHtml({ pkg: samplePkg({ status: 'submitted' }), spec });
  assert.ok(!buttonTag(open, 'assess').includes('disabled'), '已提交的卡必须能提交评估');
});

test('展示模型：状态、档位与得分都从服务端返回值来', () => {
  const view = packageView(samplePkg({
    status: 'assessed',
    solvabilityScore: 9,
    solvabilityGrade: 'B',
  }));
  assert.equal(view.statusLabel, '已评估');
  assert.equal(view.solvabilityScore, 9);
  assert.equal(view.solvabilityGrade, 'B');
  assert.equal(view.canAssess, true, '已评估的卡可以重新评估');
  assert.equal(view.canSign, true, '已评估的卡可以签级');
});

// ══════════════════════════════════════════════════════════════════
// 六、反馈与外壳
// ══════════════════════════════════════════════════════════════════

test('失败反馈：错误态里必须有**真能点的**「重试」', () => {
  const html = feedbackHtml({ tone: 'danger', message: '提交失败：服务不可用' });
  assert.ok(html.includes('data-action="retry"'), '错误态必须有重试按钮');
  assert.ok(html.includes('<button'), '重试必须是个真按钮（能点）');
  assert.ok(html.includes('提交失败：服务不可用'), '必须把失败原因说出来');
  assert.ok(html.includes('role="alert"'), '错误态要对辅助技术可见');
});

test('成功反馈：走提示条，不带重试', () => {
  const html = feedbackHtml({ tone: 'success', title: '已签级', message: '当前档位 A' });
  assert.ok(html.includes('notice'), '成功反馈用提示条');
  assert.ok(html.includes('已签级'));
  assert.ok(!html.includes('data-action="retry"'), '成功反馈不需要重试');
});

test('列表：空态给得出下一步，不是一片空白', () => {
  const html = taskPackagesHtml({ packages: [], spec: null });
  assert.ok(html.includes('还没有任务卡'));
  assert.ok(html.includes('state--empty'));
});

test('列表：每张卡都渲染出标题与两个操作区', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const html = taskPackagesHtml({ packages: [samplePkg()], spec });
  assert.ok(html.includes('门店缺货预测'));
  assert.ok(html.includes('data-role="dimension"'), '必须有六维评分控件');
  assert.ok(html.includes('data-action="approve"'));
  assert.ok(html.includes('data-action="return"'));
  assert.ok(html.includes('data-feedback="tp_1"'), '每张卡都要有就地反馈区');
});

test('存储型 XSS：任务卡标题必须转义后再进 innerHTML', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const html = taskPackageCardHtml({
    pkg: samplePkg({ title: '<img src=x onerror=alert(1)>' }),
    spec,
  });
  assert.ok(!html.includes('<img src=x'), '标题里的标签不得原样进 HTML');
  assert.ok(html.includes('&lt;img'), '标题必须被转义');
});

// ══════════════════════════════════════════════════════════════════
// 七、指标行与配比体检
// ══════════════════════════════════════════════════════════════════

test('指标行：五个数都按状态数出来（前端不自己推口径）', () => {
  const cards = statCards([
    { status: 'submitted' }, { status: 'submitted' }, { status: 'assessed' },
    { status: 'returned' }, { status: 'published' },
  ]);
  assert.deepEqual(cards.map((c) => c.label), ['任务卡总数', '待评估', '待签级', '已退回', '已发布']);
  assert.deepEqual(cards.map((c) => c.value), [5, 2, 1, 1, 1]);
  assert.deepEqual(statCards([]).map((c) => c.value), [0, 0, 0, 0, 0]);
});

test('配比体检：结论与问题都来自 API 的 mix（前端不自己算比例）', () => {
  const bad = mixPanelHtml({
    total: 10, free: 3, enterprise: 7, actualFree: 0.3, actualEnterprise: 0.7,
    ok: false, errors: ['[TASK_MIX_FREE] 自由命题占比 30.0%，目标占比 30.0%'],
  });
  assert.ok(bad.includes('配比未达标'));
  assert.ok(bad.includes('[TASK_MIX_FREE]'), '配比问题要显示 API 的原文（口径不重述）');

  const good = mixPanelHtml({
    total: 3, free: 1, enterprise: 2, actualFree: 0.33, actualEnterprise: 0.67,
    ok: true, errors: [],
  });
  assert.ok(good.includes('配比达标'));
  assert.ok(!good.includes('配比未达标'));

  const none = mixPanelHtml(null);
  assert.ok(none.includes('暂无配比体检数据'), '没有体检数据时要说清，而不是空白');
});

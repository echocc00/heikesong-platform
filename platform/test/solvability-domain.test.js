import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreSolvability, checkTaskMix } from '../src/domain/solvability.js';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const config = JSON.parse(readFileSync(join(rulesDir, 'solvability.json'), 'utf8'));

// 六维满分 = 12 分 → A 级（顶层文档 §3.2：A 10-12）
const FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

test('六维满分 → 12 分 A 级，承诺试点', () => {
  const r = scoreSolvability({ answers: FULL, config });
  assert.equal(r.score, 12);
  assert.equal(r.grade, 'A');
  assert.equal(r.commitment, '试点承诺');
  assert.equal(r.agreement, '试点承诺书 + 数据授权说明');
  assert.deepEqual(r.vetoes, []);
});

test('中档 8.6 分 → B 级（对标试点协议）', () => {
  const r = scoreSolvability({
    answers: {
      problem_clarity: 2, data_access: 2, validation: 2,
      decision_chain: 0, accountability: 1, precedent: 1,
    },
    config,
  });
  assert.equal(r.score, 8.6);
  assert.equal(r.grade, 'B');
  assert.equal(r.agreement, '对标试点协议');
});

test('低档 4.6 分 → C 级（场景提供协议，不承诺试点）', () => {
  const r = scoreSolvability({
    answers: {
      problem_clarity: 1, data_access: 1, validation: 0,
      decision_chain: 1, accountability: 1, precedent: 0,
    },
    config,
  });
  assert.equal(r.score, 4.6);
  assert.equal(r.grade, 'C');
  assert.equal(r.commitment, '不承诺试点');
});

test('全 0 → D 级 + 自动命中两条一票否决，commitment = 无', () => {
  const r = scoreSolvability({
    answers: {
      problem_clarity: 0, data_access: 0, validation: 0,
      decision_chain: 0, accountability: 0, precedent: 0,
    },
    config,
  });
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'D');
  assert.equal(r.commitment, '无');
  assert.ok(r.vetoes.includes('no_data_authorization'));
  assert.ok(r.vetoes.includes('no_responsible_owner'));
  assert.equal(r.agreement, '退回，但必出问题可解性诊断报告');
});

test('自报「涉及生产系统且未谈责任归属」→ 一票否决，承诺为无', () => {
  const r = scoreSolvability({
    answers: { ...FULL, vetoes: ['production_undisclosed'] },
    config,
  });
  assert.equal(r.computedGrade, 'A');
  assert.equal(r.grade, 'D');
  assert.equal(r.commitment, '无');
  assert.ok(r.vetoes.includes('production_undisclosed'));
});

test('explain 给出每维取值 / 权重 / 折算分', () => {
  const r = scoreSolvability({ answers: FULL, config });
  assert.equal(r.explain.length, 6);
  const pc = r.explain.find((e) => e.dimension === 'problem_clarity');
  assert.equal(pc.value, 3);
  assert.equal(pc.max, 3);
  assert.equal(pc.weight, 0.3);
  assert.equal(pc.contribution, 3.6);
});

test('配比：自由题 30% / B 端 70%，A 40% B 20% C 10%（R-ENT-09）', () => {
  // ⚠️ 父代理预审修正（Critical，规格缺陷）：夹具字段名从 `is_free_brief` 改成
  //    `isFreeBrief`（驼峰 = 服务层 presentTaskPackage 的输出形状）。
  //    checkTaskMix 消费的是**已呈现的任务卡**，不是数据库行。
  //    原来夹具用下划线、实现也读下划线 → 形状错配在夹具与实现之间互相抵消，
  //    测试全绿；但路由层喂的是**驼峰的 presented 对象** → 实现读不到 →
  //    自由题恒算 0 → 配比体检恒报「自由命题占比 0%」。
  //    父代理预审实跑复现（3 张自由卡被算成 0 张）。现在夹具与路由同形，回归可见。
  const packages = [
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'B' }, { isFreeBrief: false, grade: 'B' },
    { isFreeBrief: false, grade: 'C' },
    { isFreeBrief: true, grade: null }, { isFreeBrief: true, grade: null },
    { isFreeBrief: true, grade: null },
  ];
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.total, 10);
  assert.equal(r.free, 3);
  assert.equal(r.enterprise, 7);
  // R-ENT-09 原文：「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」——
  // 四档瓜分**整个任务池**（合计 100%），不是 B 端子集。
  assert.equal(r.byGrade.A, 4);
  assert.equal(r.byGrade.B, 2);
  assert.equal(r.byGrade.C, 1);
});

test('配比偏离 → 报错而不是静默通过', () => {
  const packages = Array.from({ length: 9 }, () => ({ isFreeBrief: false, grade: 'A' }));
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('TASK_MIX_FREE')), r.errors.join('；'));
});

test('配比分母是全体任务卡：7 张 B 端 + 3 张自由，误差在校准内才算达标', () => {
  // ⚠️ 父代理预审修正（Critical）：分母必须是 **total**，不是 B 端子集。
  //    需求原文（R-ENT-09）：「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」。
  //    原来实现用 enterprise * ratio → 10 张池子里 4 张 A 级被判成
  //    「4/7 超出目标 40%」→ 明明合规却报错（父代理预审实跑复现）。
  const packages = [
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'A' }, { isFreeBrief: false, grade: 'A' },
    { isFreeBrief: false, grade: 'B' }, { isFreeBrief: false, grade: 'B' },
    { isFreeBrief: false, grade: 'C' },
    { isFreeBrief: true, grade: null }, { isFreeBrief: true, grade: null },
    { isFreeBrief: true, grade: null },
  ];
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.actualFree, 0.3);
});

test('配比偏离 → 分母用 total 时仍能识别超标（防「改成永远通过」）', () => {
  const packages = Array.from({ length: 10 }, () => ({ isFreeBrief: false, grade: 'A' }));
  const r = checkTaskMix(packages, config);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('TASK_MIX_GRADE_A')), r.errors.join('；'));
});

test('分档边界值：10→A、9→B、7→B、6→C、4→C、3→D（边界不可判错）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-1：**分档边界值零覆盖**）。
  //    原来只测了 12 / 8.6 / 4.6 / 0 四个点 —— 把 `gradeOf` 里的 `>=` 改成 `>`，
  //    全量用例照样全绿（独立评审变异 M14 SURVIVED）。
  //    而这些边界分**业务上完全可达**（独立评审枚举 288 组组合：10 分 1 组、
  //    9 分 9 组、7 分 8 组、6 分 16 组、4 分 8 组、3 分 9 组），
  //    档位直接决定 R-ENT-08 的承诺与协议 → 判错一档 = 承诺错一级。
  //    这里用 computedGrade（不含一票否决）单独钉住「分数 → 档位」这条映射。
  const cases = [
    { score: 10, grade: 'A', answers: { problem_clarity: 3, data_access: 1, validation: 2, decision_chain: 1, accountability: 1, precedent: 1 } },
    { score: 9, grade: 'B', answers: { problem_clarity: 1, data_access: 3, validation: 2, decision_chain: 1, accountability: 1, precedent: 0 } },
    { score: 7, grade: 'B', answers: { problem_clarity: 1, data_access: 1, validation: 2, decision_chain: 1, accountability: 1, precedent: 0 } },
    { score: 6, grade: 'C', answers: { problem_clarity: 0, data_access: 3, validation: 0, decision_chain: 1, accountability: 1, precedent: 1 } },
    { score: 4, grade: 'C', answers: { problem_clarity: 0, data_access: 1, validation: 0, decision_chain: 1, accountability: 1, precedent: 1 } },
    { score: 3, grade: 'D', answers: { problem_clarity: 0, data_access: 0, validation: 0, decision_chain: 1, accountability: 1, precedent: 1 } },
  ];
  for (const c of cases) {
    const r = scoreSolvability({ answers: c.answers, config });
    assert.equal(r.score, c.score, `${c.score} 分的算分必须精确`);
    assert.equal(r.computedGrade, c.grade, `${c.score} 分必须判为 ${c.grade} 级`);
  }
});

test('explain.note 必须写清取值与折算（可解释明细是给企业看的）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-5：`explain.note` 零断言）。
  const r = scoreSolvability({ answers: FULL, config });
  const pc = r.explain.find((e) => e.dimension === 'problem_clarity');
  assert.ok(pc.note.includes('问题确定性'), `note 必须含维度标签，实际 ${pc.note}`);
  assert.ok(pc.note.includes('3/3'), `note 必须含取值/上限，实际 ${pc.note}`);
  assert.ok(pc.note.includes('3.6'), `note 必须含折算分，实际 ${pc.note}`);
});

test('否决项的自动触发条件来自配置（改 key 不得让维度推导静默失效）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-1：**key 硬编码在领域层**）：
  //    原来领域层写死 'no_data_authorization' / 'no_responsible_owner' 两个 key ——
  //    把配置里的 key 改名 → 维度推导出的否决项**整个消失**，
  //    实跑表现为「grade=B, vetoes=[]」，即「数据可得性 = 0 → 一票否决」
  //    这条规则可以被一次配置改名**静默关掉**。
  //    现在触发条件写在配置的 `auto` 里，key 只是标识 —— 改名不影响判定。
  const renamed = {
    ...config,
    vetoes: config.vetoes.map((v) => (v.auto ? { ...v, key: `${v.key}_renamed` } : v)),
  };
  const r = scoreSolvability({
    answers: {
      problem_clarity: 3, data_access: 0, validation: 2,
      decision_chain: 1, accountability: 1, precedent: 1,
    },
    config: renamed,
  });
  assert.equal(r.vetoes.length, 1, '数据可得性 = 0 仍必须命中一条否决项');
  assert.equal(r.vetoes[0], 'no_data_authorization_renamed');
  assert.equal(r.grade, 'D', '命中否决项必须强制降到 D');
});

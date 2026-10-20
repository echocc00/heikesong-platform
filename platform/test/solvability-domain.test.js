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

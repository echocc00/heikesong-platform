import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreRegistration, classifyLevel, validateRegistrationAnswers,
} from '../src/domain/registration.js';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const config = JSON.parse(readFileSync(join(rulesDir, 'registration-scoring.json'), 'utf8'));

// ── 边界样例：每维 5 题，取值 1..5 ──────────────────────────────
// 79 分：方向 [4,4,4,4,3]=19→3.8 ｜能力 [5,5,5,4,4]=23→4.6 ｜协作 [4,4,4,4,4]=20→4.0
//        0.25×3.8 + 0.35×4.6 + 0.40×4.0 = 4.16 → (4.16−1)/4×100 = 79
// 80 分：三维均值皆 4.2（[4,4,4,4,5]=21）→ 4.2 → 80
// 60 分：三维均值皆 3.4（[3,3,3,4,4]=17）→ 3.4 → 60
// 59 分：3.4 / 2.6 / 4.0 → 3.36 → 59
// 40 分：三维均值皆 2.6（[3,2,2,3,3]=13）→ 2.6 → 40
// 39 分：1.6 / 1.6 / 4.0 → 2.56 → 39
const D79 = [4, 4, 4, 4, 3];
const D80 = [4, 4, 4, 4, 5];
const M34 = [3, 3, 3, 4, 4];
const M26 = [3, 2, 2, 3, 3];
const M40 = [4, 4, 4, 4, 4];
const M46 = [5, 5, 5, 4, 4];
const M16 = [2, 2, 2, 1, 1];

function answers(direction, capability, collaboration, open = '占位说明') {
  return { direction, capability, collaboration, open };
}

test('边界 79 分判 A 级（R-REG-07：60–79 → A）', () => {
  const r = scoreRegistration({ answers: answers(D79, M46, M40), config });
  assert.equal(r.score, 79);
  assert.equal(r.level, 'A');
  assert.equal(r.accepted, true);
});

test('边界 80 分判 S 级（R-REG-07：80–100 → S）', () => {
  const r = scoreRegistration({ answers: answers(D80, D80, D80), config });
  assert.equal(r.score, 80);
  assert.equal(r.level, 'S');
});

test('边界 59 分判 B 级（R-REG-07：40–59 → B）', () => {
  const r = scoreRegistration({ answers: answers(M34, M26, M40), config });
  assert.equal(r.score, 59);
  assert.equal(r.level, 'B');
});

test('边界 60 分判 A 级', () => {
  const r = scoreRegistration({ answers: answers(M34, M34, M34), config });
  assert.equal(r.score, 60);
  assert.equal(r.level, 'A');
});

test('边界 39 分判 C 级', () => {
  const r = scoreRegistration({ answers: answers(M16, M16, M40), config });
  assert.equal(r.score, 39);
  assert.equal(r.level, 'C');
});

test('边界 40 分判 B 级', () => {
  const r = scoreRegistration({ answers: answers(M26, M26, M26), config });
  assert.equal(r.score, 40);
  assert.equal(r.level, 'B');
});

test('C 级不接收（R-REG-08）', () => {
  const r = scoreRegistration({ answers: answers(M16, M16, M16), config });
  assert.equal(r.level, 'C');
  assert.equal(r.accepted, false);
  const s = scoreRegistration({ answers: answers(M34, M34, M34), config });
  assert.equal(s.accepted, true);
});

test('维度得分是 5 题均值，并进入 dimensionScores', () => {
  const r = scoreRegistration({ answers: answers(D79, M46, M40), config });
  assert.equal(r.dimensionScores.direction, 3.8);
  assert.equal(r.dimensionScores.capability, 4.6);
  assert.equal(r.dimensionScores.collaboration, 4);
});

test('explain 给出每维 raw / weight / weighted（可解释明细）', () => {
  const r = scoreRegistration({ answers: answers(D79, M46, M40), config });
  assert.equal(r.explain.length, 3);
  const dir = r.explain.find((e) => e.dimension === 'direction');
  assert.equal(dir.raw, 3.8);
  assert.equal(dir.weight, 0.25);
  assert.equal(dir.weighted, 0.95);
  assert.ok(dir.note.includes('方向维度'), 'note 必须说明这一维怎么算的');
  // ⚠️ 父代理预审补充（弱断言 → 强断言）：原来只断言 note 含维度名，
  //    把 note 里的「权重 25%」「加权 0.95」删掉照样全绿 —— 而 note 是
  //    「可解释明细」界面给用户看的**唯一**说明（设计文档 §9 / R-REG-09）。
  //    少了权重，用户看到的「这一维凭什么拿 0.95 分」就无从核对。
  assert.ok(dir.note.includes('权重 25%'), `note 必须写出这一维的权重：${dir.note}`);
  assert.ok(dir.note.includes('加权 0.95'), `note 必须写出这一维的加权分：${dir.note}`);
  assert.ok(dir.note.includes('5 题'), `note 必须写出题数：${dir.note}`);
});

test('classifyLevel 阈值边界与 scoreRegistration 判定一致', () => {
  assert.equal(classifyLevel(79, config), 'A');
  assert.equal(classifyLevel(80, config), 'S');
  assert.equal(classifyLevel(59, config), 'B');
  assert.equal(classifyLevel(60, config), 'A');
  assert.equal(classifyLevel(39, config), 'C');
  assert.equal(classifyLevel(40, config), 'B');
  assert.equal(classifyLevel(0, config), 'C');
  assert.equal(classifyLevel(100, config), 'S');
});

test('validate：三个维度每维必须 5 题', () => {
  const errs = validateRegistrationAnswers(answers([4, 4], M46, M40), config);
  assert.ok(errs.some((e) => e.includes('方向维度') && e.includes('5 道题')), errs.join('；'));
});

test('validate：每题取值必须在 1–5 之间且为整数', () => {
  const errs = validateRegistrationAnswers(answers([4, 4, 4, 4, 9], M46, M40), config);
  assert.ok(errs.some((e) => e.includes('1–5')), errs.join('；'));
  const errs2 = validateRegistrationAnswers(answers([4, 4, 4, 4, 2.5], M46, M40), config);
  assert.ok(errs2.some((e) => e.includes('整数')), errs2.join('；'));
});

test('validate：开放式题必填且有长度上限（R-REG-11）', () => {
  const errs = validateRegistrationAnswers(answers(D80, D80, D80, '   '), config);
  assert.ok(errs.some((e) => e.includes('开放式题')), errs.join('；'));
  const long = 'x'.repeat(config.openQuestion.maxLength + 1);
  const errs2 = validateRegistrationAnswers(answers(D80, D80, D80, long), config);
  assert.ok(errs2.some((e) => e.includes('开放式题')), errs2.join('；'));
});

test('validate：全部合法时返回空数组', () => {
  const errs = validateRegistrationAnswers(answers(D80, D80, D80, '我想解决门店排班问题'), config);
  assert.deepEqual(errs, []);
});

test('权重合计必须为 1（配置自检，防 C-01 类错位）', () => {
  const sum = config.dimensions.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重合计 = ${sum}`);
});

test('问卷题目数与维度数一致（R-REG-11：3 维各 5 题 + 1 开放题）', () => {
  for (const d of config.dimensions) {
    assert.equal(config.questions.dimensionItems[d.key].length, 5, `${d.key} 必须是 5 题`);
  }
  assert.equal(config.questions.status, 'open_question');
  assert.ok(config.questions.openQuestionItem);
});

// platform/test/self-eval.test.js —— 自评测差异检测
//
// 依据：P2 计划 Task 5「自评测差异检测」
// 溯源需求：R-JDG-13（d>10 要书面说明 / d<−10 只提问）
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSelfEvalDiff } from '../src/domain/self-eval.js';

const SELF = [
  { teamId: 't1', dimension: 'innovation', rawScore: 95 }, // d = 95-80 = +15 → 书面说明
  { teamId: 't2', dimension: 'innovation', rawScore: 80 }, // d = 0     → 无影响
  { teamId: 't3', dimension: 'innovation', rawScore: 50 }, // d = 50-80 = -30 → 评委提问
  { teamId: 't4', dimension: 'innovation', rawScore: 90 }, // d = +10   → 边界，无影响
  { teamId: 't5', dimension: 'innovation', rawScore: 70 }, // d = -10   → 边界，无影响
];
const JUDGE = [
  { teamId: 't1', dimension: 'innovation', score: 80 },
  { teamId: 't2', dimension: 'innovation', score: 80 },
  { teamId: 't3', dimension: 'innovation', score: 80 },
  { teamId: 't4', dimension: 'innovation', score: 80 },
  { teamId: 't5', dimension: 'innovation', score: 80 },
];

test('d > 10 → 触发书面说明（written_explanation）', () => {
  const r = detectSelfEvalDiff({ selfReviews: SELF, judgeScores: JUDGE, threshold: 10 });
  const flag = r.flags.find((f) => f.teamId === 't1');
  assert.equal(flag.d, 15);
  assert.equal(flag.action, 'written_explanation');
});

test('d < -10 → 触发评委提问（judge_question，只提问不改分）', () => {
  const r = detectSelfEvalDiff({ selfReviews: SELF, judgeScores: JUDGE, threshold: 10 });
  const flag = r.flags.find((f) => f.teamId === 't3');
  assert.equal(flag.d, -30);
  assert.equal(flag.action, 'judge_question');
});

test('|d| <= 10 → 无影响（含 ±10 边界）', () => {
  const r = detectSelfEvalDiff({ selfReviews: SELF, judgeScores: JUDGE, threshold: 10 });
  assert.equal(r.flags.filter((f) => f.teamId === 't2').length, 0);
  assert.equal(r.flags.filter((f) => f.teamId === 't4').length, 0);
  assert.equal(r.flags.filter((f) => f.teamId === 't5').length, 0);
  assert.equal(r.flags.length, 2);
});

test('缺少对应评委分 → 不产生 flag（缺数据不当成异常）', () => {
  const r = detectSelfEvalDiff({
    selfReviews: [{ teamId: 'tx', dimension: 'innovation', rawScore: 99 }],
    judgeScores: [],
    threshold: 10,
  });
  assert.deepEqual(r.flags, []);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('threshold 非法 → 响亮报错（绝不静默产出零 flag）', () => {
  // ⚠️ 原实现：threshold='x' → NaN → `d > NaN` 恒 false → **静默零 flag**，
  //    看上去像「所有自评都正常」。
  for (const bad of ['x', NaN, Infinity, null]) {
    if (bad === null) continue; // null = 缺省，走默认值 10，合法
    assert.throws(
      () => detectSelfEvalDiff({
        selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
        judgeScores: JUDGE,
        threshold: bad,
      }),
      /threshold/,
      `threshold=${String(bad)} 必须报错`,
    );
  }
});

test('同一 (队伍,维度) 的评委分出现多条 → 响亮报错（不静默取最后一条）', () => {
  // ⚠️ 原实现：Map.set 静默覆盖 → 结果取决于数组顺序 → 不可复算。
  assert.throws(
    () => detectSelfEvalDiff({
      selfReviews: [{ teamId: 't1', dimension: 'innovation', rawScore: 95 }],
      judgeScores: [
        { teamId: 't1', dimension: 'innovation', score: 90 },
        { teamId: 't1', dimension: 'innovation', score: 80 },
      ],
      threshold: 10,
    }),
    /队伍|维度/,
  );
});

test('flags 排序用【普通字典序】而非 localeCompare（跨机器可复算）', () => {
  // ⚠️ 原实现用 `localeCompare` → 依赖运行环境的 locale 与 ICU 版本，
  //    同一份数据在不同机器上可能排出**不同顺序** → 破坏「可复算」。
  //    ASCII 序：'1'(49) < '2'(50) < 'B'(66) < 'a'(97)，且 'T'(84) < 't'(116)。
  const teams = ['tB', 'ta', 'T1', 't2', 't10'];
  const r = detectSelfEvalDiff({
    selfReviews: teams.map((teamId) => ({ teamId, dimension: 'innovation', rawScore: 95 })),
    judgeScores: teams.map((teamId) => ({ teamId, dimension: 'innovation', score: 80 })),
    threshold: 10,
  });
  assert.deepEqual(
    r.flags.map((f) => f.teamId),
    ['T1', 't10', 't2', 'tB', 'ta'],
    '必须按普通字典序（ASCII）排序，不受 locale 影响',
  );
});

// platform/test/trim.test.js —— 去极值 + 席位加权分
//
// 依据：P2 计划 Task 3「去极值 + 评委席得分 P」
// 溯源需求：R-JDG-03（去极值）｜R-JDG-04（双席加权总分 P 的公共原语）
// 依据来源：S7 §3.2（去极值：同维度去掉一个最高一个最低再取均值，评委数 ≥5 才做）
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimOutliers, seatScore } from '../src/domain/trim.js';

test('去极值：去掉一个最高一个最低后取均值', () => {
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 3 },
      { judgeId: 'j4', z: 4 },
      { judgeId: 'j5', z: 5 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, true);
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.removed.min, 'j1');
  assert.equal(r.mean, 3); // (2+3+4)/3
});

test('有效评委数 < minJudges → 不去极值', () => {
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 100 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, false);
  assert.deepEqual(r.removed, { max: null, min: null });
  assert.ok(Math.abs(r.mean - 103 / 3) < 1e-12);
});

test('并列时按 judgeId 确定性打破（可复算）', () => {
  const r = trimOutliers({
    values: [
      { judgeId: 'j3', z: 0 },
      { judgeId: 'j1', z: 0 },
      { judgeId: 'j2', z: 0 },
      { judgeId: 'j5', z: 0 },
      { judgeId: 'j4', z: 0 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, true);
  assert.equal(r.removed.min, 'j1');
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.mean, 0);
});

test('空值与非法 z 被忽略，不静默当 0', () => {
  const r = trimOutliers({ values: [], minJudges: 5 });
  assert.equal(r.mean, 0);
  assert.equal(r.trimmed, false);
  assert.deepEqual(r.removed, { max: null, min: null });
});

test('评委席得分 P：维度加权的 0–100 分', () => {
  const r = seatScore({
    dimensionScores: { track_fit: 70, innovation: 80, feasibility: 65 },
    weights: { track_fit: 0.1, innovation: 0.2, feasibility: 0.2 },
  });
  // (0.1*70 + 0.2*80 + 0.2*65) / 0.5 = (7+16+13)/0.5 = 72
  assert.ok(Math.abs(r.score - 72) < 1e-12);
  assert.ok(Math.abs(r.weightSum - 0.5) < 1e-12);
  assert.deepEqual(r.missing, []);
});

test('某维度无人打分 → 权重不计入该维度分母，且必须被列进 missing', () => {
  const r = seatScore({
    dimensionScores: { innovation: 80 },
    weights: { innovation: 0.2, completeness: 0.25 },
  });
  assert.ok(Math.abs(r.score - 80) < 1e-12);
  assert.deepEqual(r.missing, ['completeness']);
});

test('权重合计为 0 → 该席位无权重，分数记 0（调用方必须记 warning）', () => {
  const r = seatScore({
    dimensionScores: { innovation: 80 },
    weights: { innovation: 0 },
  });
  assert.equal(r.score, 0);
  assert.equal(r.weightSum, 0);
  // 该维度有分（只是权重为 0），因此不算「缺分」
  assert.deepEqual(r.missing, []);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// ⚠️ 规格自带的 7 条用例全绿，但下面的缺陷在它们**全都看不见**。

test('minJudges 缺省或非法 → 响亮报错（绝不让去极值闸门失效）', () => {
  // ⚠️ 原实现：`list.length < minJudges` 在 minJudges 为 undefined/'x'/0 时**恒为 false**
  //    → 3 个评委也去极值 → 去掉一高一低后只剩 1 个 →
  //    **该队的分数完全由单个评委决定**，评委宽严偏差直接变成队伍分差。
  for (const bad of [undefined, null, 'x', 0, -1, 2.5, NaN]) {
    assert.throws(
      () => trimOutliers({
        values: [
          { judgeId: 'j1', z: 1 },
          { judgeId: 'j2', z: 2 },
          { judgeId: 'j3', z: 100 },
        ],
        minJudges: bad,
      }),
      /minJudges/,
      `minJudges=${String(bad)} 必须报错`,
    );
  }
  // 闸门真的有效：3 个评委 + minJudges=5 → 不去极值
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 100 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, false);
});

test('席位权重非法 → 响亮报错（绝不让 NaN 或字符串混进榜单）', () => {
  // ⚠️ 原实现：权重 NaN → score 变 NaN；
  //    权重 'x' → `weightSum += weight` 让 weightSum **变成字符串 "0x"**（`0 + 'x'`），
  //    再拿它做除数 → NaN。类型污染 + 数值污染同时发生。
  for (const bad of [NaN, Infinity, 'x', undefined, null]) {
    assert.throws(
      () => seatScore({ dimensionScores: { a: 80 }, weights: { a: bad } }),
      /席位权重/,
      `权重=${String(bad)} 必须报错`,
    );
  }
  // 负权重会让分数倒挂
  assert.throws(
    () => seatScore({ dimensionScores: { a: 80 }, weights: { a: -0.5 } }),
    /席位权重/,
  );
});

test('零权重的维度不启用：没有分也【不算缺分】（不要虚假告警）', () => {
  // ⚠️ 原实现：权重 0 的维度没有分时被塞进 `missing` →
  //    trace 里出现「某维度缺分」的虚假告警，而它本来就是「不启用」的维度。
  const r = seatScore({
    dimensionScores: { b: 60 },
    weights: { a: 0, b: 1 },
  });
  assert.equal(r.missing.length, 0, '权重为 0 的维度不该报缺分');
  assert.ok(Math.abs(r.score - 60) < 1e-12);
  assert.ok(Math.abs(r.weightSum - 1) < 1e-12);
});

test('同一 judgeId 出现多次 → 响亮报错，不当成两个评委', () => {
  // ⚠️ 原实现：重复的 judgeId 被当成两个评委，
  //    `removed` 甚至会出现 max === min === 'j1'（同一个人既最高又最低）。
  assert.throws(
    () => trimOutliers({
      values: [
        { judgeId: 'j1', z: 1 },
        { judgeId: 'j1', z: 50 },
        { judgeId: 'j2', z: 2 },
        { judgeId: 'j3', z: 3 },
        { judgeId: 'j4', z: 4 },
        { judgeId: 'j5', z: 5 },
      ],
      minJudges: 5,
    }),
    /judgeId/,
  );
});

test('登记口径：缺分维度的权重被剔除 → 结果是【已有维度上的相对加权平均】', () => {
  // ⚠️ Task 8 总装必须知道这条：分母是**实际参与计算的权重和**，不是权重表全量。
  const r = seatScore({
    dimensionScores: { a: 80 },
    weights: { a: 0.5, b: 0.5 },
  });
  assert.ok(Math.abs(r.score - 80) < 1e-12, '不是 40（那是把缺失维度当 0 分）');
  assert.ok(Math.abs(r.weightSum - 0.5) < 1e-12, '分母只算参与计算的权重');
  assert.deepEqual(r.missing, ['b']);
});

test('登记口径：权重表之外的维度分被忽略（权重表定义席位构成）', () => {
  const r = seatScore({
    dimensionScores: { a: 80, zzz: 999 },
    weights: { a: 1 },
  });
  assert.ok(Math.abs(r.score - 80) < 1e-12);
  assert.deepEqual(r.missing, []);
});

test('去极值的均值必须真的是【去极值后】的均值（不能等于全体均值）', () => {
  // ⚠️ 规格自带那条用例的期望值 **3 恰好**等于「去极值后均值」与「全体均值」两种算法的
  //    结果（1+2+3+4+5 的均值也是 3）—— 所以它**区分不了**「有没有真的去掉极值」。
  //    这里用一个两者结果不同的数据集把这条缝补上。
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 0 },
      { judgeId: 'j2', z: 0 },
      { judgeId: 'j3', z: 0 },
      { judgeId: 'j4', z: 0 },
      { judgeId: 'j5', z: 10 },
    ],
    minJudges: 5,
  });
  assert.equal(r.trimmed, true);
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.removed.min, 'j1'); // 并列的 0 里字典序最小
  assert.equal(r.mean, 0, '去极值后的均值是 0；全体均值是 2 —— 两者必须不同');
});

test('非法 z 的样本被忽略，不参与去极值（不静默当 0）', () => {
  // ⚠️ 规格自带那条用例名叫「空值与非法 z 被忽略」，但它**只传了空数组** ——
  //    「非法 z」这半句从来没被验证过。
  const r = trimOutliers({
    values: [
      { judgeId: 'j1', z: 1 },
      { judgeId: 'j2', z: 2 },
      { judgeId: 'j3', z: 3 },
      { judgeId: 'j4', z: 4 },
      { judgeId: 'j5', z: 5 },
      { judgeId: 'j6', z: null },
      { judgeId: 'j7', z: NaN },
      { judgeId: 'j8', z: undefined },
      { judgeId: 'j9', z: '80' },
    ],
    minJudges: 5,
  });
  // 只有 5 个有效评委 → 去极值后 (2+3+4)/3 = 3
  assert.equal(r.trimmed, true);
  assert.equal(r.mean, 3);
  assert.equal(r.removed.max, 'j5');
  assert.equal(r.removed.min, 'j1');
});

test('minJudges 配成 2 → 去极值会退化成空集，此时不去极值（不许算出 NaN）', () => {
  // ⚠️ 防御分支原来**零覆盖** —— minJudges=1 或 2 时 kept 为空，
  //    `kept.reduce(...) / kept.length` 就是 0/0 = NaN。
  const r = trimOutliers({
    values: [{ judgeId: 'j1', z: 10 }, { judgeId: 'j2', z: 20 }],
    minJudges: 2,
  });
  assert.equal(r.trimmed, false);
  assert.equal(r.mean, 15);
  assert.deepEqual(r.removed, { max: null, min: null });
});

test('missing 按维度名字典序输出（与权重表的写入顺序无关）', () => {
  const r = seatScore({
    dimensionScores: { innovation: 80 },
    weights: { zzz_missing: 0.1, aaa_missing: 0.2, innovation: 0.3 },
  });
  assert.deepEqual(r.missing, ['aaa_missing', 'zzz_missing']);
});

// platform/test/normalization.test.js —— 评委宽严归一化引擎（4 策略可切换）
//
// 依据：P2 计划 Task 2「归一化引擎（4 策略可切换）」
// 溯源需求：R-JDG-02（评委宽严 z-score 归一化）｜R-JDG-01（初赛/决赛两套权重表里的归一化参数）
// 冲突裁决：C-05（归一化口径与降级策略）
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScores, NORMALIZATION_STRATEGIES } from '../src/domain/normalization.js';

const CFG = {
  minSamplesForJudgeNormalization: 5,
  fallback: 'global',
  trimmedIterations: 20,
  bayesPriorStrength: 5,
};

// 数据集 A：经典 5 队 2 评委，样本数恰好 = 5（阈值边界，≥5 即走归一化）
const A1 = [80, 90, 70, 100, 60];
const A2 = [60, 60, 60, 80, 40];
const cfgA = { ...CFG };

// 数据集 S：6 队 2 评委，用来同时验证 4 种策略的【我们的预期值】
const S1 = [10, 20, 30, 31, 32, 200];
const S2 = [60, 65, 70, 70, 70, 70];

function callS(strategy) {
  return normalizeScores({
    samples: [
      { judgeId: 'j1', value: 10, series: S1 },
      { judgeId: 'j2', value: 60, series: S2 },
    ],
    strategy,
    config: CFG,
  });
}

test('策略清单就是约定的 4 个', () => {
  assert.deepEqual([...NORMALIZATION_STRATEGIES], ['zscore', 'median', 'trimmed', 'bayes']);
});

test('zscore：已知评委矩阵 → 期望 z 值（样本数 = 5 恰好达标）', () => {
  const r = normalizeScores({
    samples: [
      { judgeId: 'j1', value: 100, series: A1 },
      { judgeId: 'j2', value: 80, series: A2 },
    ],
    strategy: 'zscore',
    config: cfgA,
  });
  // j1: mean=80, stdev=sqrt(250)=15.811388 → z=(100-80)/15.811388
  // j2: mean=60, stdev=sqrt(200)=14.142136 → z=(80-60)/14.142136
  assert.ok(Math.abs(r.values.j1 - 1.264911064) < 1e-9, `j1 z=${r.values.j1}`);
  assert.ok(Math.abs(r.values.j2 - 1.414213562) < 1e-9, `j2 z=${r.values.j2}`);
  assert.equal(r.normalized, true);
  assert.equal(r.fallbackReason, null);
  assert.equal(r.stats.n, 10);
  assert.ok(Math.abs(r.stats.mean - 70) < 1e-9);
  assert.ok(Math.abs(r.stats.stdev - 17.638342074) < 1e-9);
  assert.equal(r.judgeStats.j1.n, 5);
  assert.ok(Math.abs(r.judgeStats.j1.mean - 80) < 1e-9);
  assert.ok(Math.abs(r.judgeStats.j1.stdev - 15.811388301) < 1e-9);
});

test('zscore：样本数 < 5 → 退回全局口径，normalized=false 且必须带 fallbackReason', () => {
  const r = normalizeScores({
    samples: [
      { judgeId: 'j1', value: 80, series: A1 },
      { judgeId: 'j2', value: 60, series: A2 },
      { judgeId: 'j3', value: 50, series: [50, 60, 55] }, // n=3 < 5
    ],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'judge_sample_too_small');
  assert.equal(r.judgeStats.j3.fallbackReason, 'judge_sample_too_small');
  // 退回全局口径：z = (s − 全局均值) / 全局标准差
  assert.ok(Math.abs(r.stats.mean - 66.538461538) < 1e-9);
  assert.ok(Math.abs(r.stats.stdev - 16.756169931) < 1e-9);
  assert.ok(Math.abs(r.values.j3 - (50 - r.stats.mean) / r.stats.stdev) < 1e-12);
  // 样本足够的评委不受影响
  assert.ok(Math.abs(r.values.j1 - 0) < 1e-12);
});

test('stdev = 0 → z 记 0 且 fallbackReason = zero_stdev', () => {
  const r = normalizeScores({
    samples: [
      { judgeId: 'j1', value: 80, series: A1 },
      { judgeId: 'j2', value: 60, series: A2 },
      { judgeId: 'j4', value: 50, series: [50, 50, 50, 50, 50] },
    ],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.equal(r.values.j4, 0);
  assert.equal(r.judgeStats.j4.fallbackReason, 'zero_stdev');
  assert.equal(r.fallbackReason, 'zero_stdev');
  assert.equal(r.normalized, false);
});

test('median 策略（ORA 思路，独立实现）→ 我们的预期值', () => {
  const r = callS('median');
  // j1: median=30.5, MAD=6 → scale=1.4826*6=8.8956 → z=(10-30.5)/8.8956
  assert.ok(Math.abs(r.values.j1 - -2.304510095) < 1e-9, `j1=${r.values.j1}`);
  // j2: median=70, MAD=0 → scale 退回 stdev=4.183300133 → z=(60-70)/4.183300133
  assert.ok(Math.abs(r.values.j2 - -2.390457219) < 1e-9, `j2=${r.values.j2}`);
  assert.equal(r.normalized, true);
});

test('trimmed 策略（Hangar 截尾思路，确定性实现）→ 我们的预期值', () => {
  const r = callS('trimmed');
  // j1: 截尾中心 = 中间 3 个 (20,30,31) 的均值 = 28.25（20 轮截尾平均）→ z=(10-28.25)/72.106634
  assert.ok(Math.abs(r.values.j1 - -0.253097378) < 1e-9, `j1=${r.values.j1}`);
  // j2: 截尾中心 = 68.75 → z=(60-68.75)/4.183300133
  assert.ok(Math.abs(r.values.j2 - -2.091650066) < 1e-9, `j2=${r.values.j2}`);
  assert.equal(r.normalized, true);
});

test('bayes 策略（crowd_bt.py 的评委偏差层次估计思路）→ 我们的预期值', () => {
  const r = callS('bayes');
  // j1: w=6/11 → center=56.939393939, scale=62.745816319 → z=(10-56.939393939)/62.745816319
  assert.ok(Math.abs(r.values.j1 - -0.748088027) < 1e-9, `j1=${r.values.j1}`);
  // j2: center=64.393939394, scale=33.325136733 → z=(60-64.393939394)/33.325136733
  assert.ok(Math.abs(r.values.j2 - -0.131850604) < 1e-9, `j2=${r.values.j2}`);
  assert.equal(r.normalized, true);
});

test('4 种策略产出【不同】的结果（证明确实可切换，不是同一个函数换名字）', () => {
  const zs = ['zscore', 'median', 'trimmed', 'bayes'].map((s) => callS(s).values.j1);
  assert.equal(new Set(zs.map((z) => z.toFixed(9))).size, 4);
});

test('未知策略不抛错但显式降级（绝不静默）', () => {
  const r = normalizeScores({ samples: [{ judgeId: 'j1', value: 1, series: A1 }], strategy: 'nope', config: cfgA });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'unknown_strategy');
  assert.deepEqual(r.values, {});
});

test('空样本显式返回降级，不返回空成功', () => {
  const r = normalizeScores({ samples: [], strategy: 'zscore', config: cfgA });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'empty_samples');
  assert.equal(r.stats.n, 0);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// ⚠️ 这 8 条都是**先复现缺陷、再补的回归用例**：
//    规格自带的 10 条用例全绿，但下面的缺陷在它们**全都看不见**。

test('D-1 回退：不传 series 时用同 judgeId 在本单元的 value 当 series（不再是空结果）', () => {
  // ⚠️ 原实现**根本没实现** D-1 承诺的这条回退：直接 `continue` 跳过没有 series 的样本，
  //    于是契约形状（INTERFACES.md 的 `samples: [{ judgeId, value }]`）产出
  //    **空 values + fallbackReason = null** —— 一个「静默空成功」。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80 }],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.notDeepEqual(r.values, {}, 'values 不能是空集（否则调用方拿到 0 个 z 值）');
  assert.equal(Object.keys(r.values).length, 1);
  // 回退后的 series 长度为 1 → 样本不足 → 显式降级（不能是 null）
  assert.equal(r.fallbackReason, 'judge_sample_too_small');
  assert.equal(r.stats.n, 1);
  assert.equal(r.values.j1, 0);
});

test('未知策略时全局统计仍然给出（策略名写错不该把原始分统计一起丢掉）', () => {
  // ⚠️ 原实现把策略校验放在最前面直接 return，stats 全部返回 0 ——
  //    而全局口径**与策略无关**，trace 里记的全局统计是假的。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: A1 }],
    strategy: 'nope',
    config: cfgA,
  });
  assert.equal(r.fallbackReason, 'unknown_strategy');
  assert.equal(r.stats.n, 5, '全局样本数不该因为策略名写错就变成 0');
  assert.ok(Math.abs(r.stats.mean - 80) < 1e-9);
  assert.ok(Math.abs(r.stats.stdev - 15.811388301) < 1e-9);
});

test('配置非法直接抛错（绝不让 NaN 静默污染榜单）', () => {
  // ⚠️ 原实现：trimmedIterations=0 → 0/0 = NaN；trimmedIterations='x' → NaN；
  //    而 normalized 仍报 true、fallbackReason 仍是 null —— **NaN 静默进榜**。
  for (const bad of [0, 'x', NaN, -1, 1.5]) {
    assert.throws(
      () => normalizeScores({
        samples: [{ judgeId: 'j1', value: 80, series: A1 }],
        strategy: 'trimmed',
        config: { ...cfgA, trimmedIterations: bad },
      }),
      /trimmedIterations/,
      `trimmedIterations=${String(bad)} 必须报错`,
    );
  }
  assert.throws(
    () => normalizeScores({
      samples: [{ judgeId: 'j1', value: 80, series: A1 }],
      strategy: 'zscore',
      config: { ...cfgA, minSamplesForJudgeNormalization: 'x' },
    }),
    /minSamplesForJudgeNormalization/,
  );
  assert.throws(
    () => normalizeScores({
      samples: [{ judgeId: 'j1', value: 80, series: A1 }],
      strategy: 'bayes',
      config: { ...cfgA, bayesPriorStrength: -1 },
    }),
    /bayesPriorStrength/,
  );
  // ⚠️ bayesPriorStrength **不是整数**约束项 —— 「整数」与「最小值」两道守卫都拦不住
  //    非数值：'x' 与 0 比较是 false、NaN 的整数检查也是 false。
  //    所以「必须是有限数」那道守卫是**唯一**的拦截点，必须有自己的用例。
  for (const bad of ['x', NaN, Infinity, null]) {
    if (bad === null) continue; // null = 缺省，走默认值，合法
    assert.throws(
      () => normalizeScores({
        samples: [{ judgeId: 'j1', value: 80, series: A1 }],
        strategy: 'bayes',
        config: { ...cfgA, bayesPriorStrength: bad },
      }),
      /bayesPriorStrength/,
      `bayesPriorStrength=${String(bad)} 必须报错`,
    );
  }
  assert.throws(
    () => normalizeScores({
      samples: [{ judgeId: 'j1', value: 80, series: A1 }],
      strategy: 'zscore',
      config: { ...cfgA, fallback: 'nope' },
    }),
    /fallback/,
  );
});

test('fallback=raw 真的给原始分（名实相符，不是全局 z 值）', () => {
  // ⚠️ 原实现：reason 写着 raw_fallback，center/scale 却还是全局的 ——
  //    trace 说「用了原始分」，实际算的是全局归一化值。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: [70, 80, 90] }],
    strategy: 'zscore',
    config: { ...cfgA, fallback: 'raw' },
  });
  assert.equal(r.fallbackReason, 'raw_fallback');
  assert.equal(r.values.j1, 80, 'raw 模式下 z 必须等于原始分');
  assert.equal(r.judgeStats.j1.center, 0);
  assert.equal(r.judgeStats.j1.scale, 1);
});

test('同一 judgeId 在一个单元内出现两次 → 响亮报错，不静默覆盖', () => {
  // ⚠️ 原实现：后者直接覆盖前者，调用方看不出发生过覆盖。
  assert.throws(
    () => normalizeScores({
      samples: [
        { judgeId: 'j1', value: 80, series: A1 },
        { judgeId: 'j1', value: 95, series: A1 },
      ],
      strategy: 'zscore',
      config: cfgA,
    }),
    /judgeId/,
  );
});

test('配置缺省时用默认值（阈值默认 5）—— 不许因为没传就换口径', () => {
  // ⚠️ 原规格**所有**用例都显式传了 `minSamplesForJudgeNormalization: 5`，
  //    于是「规则文件漏写这个键时怎么办」从来没被验证过 ——
  //    把默认值改成 6，全部用例照样绿。
  const r5 = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: A1 }], // A1 长度 5
    strategy: 'zscore',
    config: {},
  });
  assert.equal(r5.normalized, true, 'n=5 恰好达到默认阈值，应当走归一化');
  assert.equal(r5.judgeStats.j1.n, 5);
  assert.equal(r5.fallbackReason, null);

  const r4 = normalizeScores({
    samples: [{ judgeId: 'j1', value: 80, series: [70, 80, 90, 60] }], // 长度 4
    strategy: 'zscore',
    config: {},
  });
  assert.equal(r4.normalized, false, 'n=4 低于默认阈值，应当降级');
  assert.equal(r4.fallbackReason, 'judge_sample_too_small');
});

test('样本的 value 全是非有限数 → 显式降级，不谎称「归一化成功」', () => {
  // ⚠️ 原来的行为：`normalized = true`（评委本身没降级）但 `values` 是空集 ——
  //    「声称成功却一个分数都没产出」，调用方会以为一切正常。
  const r = normalizeScores({
    samples: [{ judgeId: 'j1', value: null, series: A1 }],
    strategy: 'zscore',
    config: cfgA,
  });
  assert.equal(r.normalized, false);
  assert.equal(r.fallbackReason, 'no_finite_values');
  assert.deepEqual(r.values, {});
});

test('产出值与统计量必须全是有限数（防御性：NaN 不许逃逸到榜单）', () => {
  for (const strategy of NORMALIZATION_STRATEGIES) {
    const r = normalizeScores({
      samples: [
        { judgeId: 'j1', value: 80, series: A1 },
        { judgeId: 'j2', value: 60, series: A2 },
      ],
      strategy,
      config: cfgA,
    });
    for (const [id, v] of Object.entries(r.values)) {
      assert.ok(Number.isFinite(v), `${strategy}/${id} 产出非有限数：${v}`);
    }
    for (const [id, st] of Object.entries(r.judgeStats)) {
      for (const k of ['n', 'mean', 'stdev', 'center', 'scale']) {
        assert.ok(Number.isFinite(st[k]), `${strategy}/${id}.${k} 非有限数：${st[k]}`);
      }
    }
    assert.ok(Number.isFinite(r.stats.mean) && Number.isFinite(r.stats.stdev));
  }
});

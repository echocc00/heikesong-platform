// src/domain/normalization.js — 评委宽严归一化引擎（4 策略可切换）
//
// 依据：S7 §3.1（z-score 口径）+ 设计文档 §6.2 Step 2 + 冲突裁决 C-05。
//   需求：R-JDG-02（评委宽严 z-score 归一化）｜R-JDG-01（初赛/决赛两套权重表里的归一化参数）
//
// ⚠️⚠️ 口径警告（本文件最容易做错的一处，务必读完再改）：
//   归一化的是【评委的宽严】，不是【队伍的分数】。
//     mean(i,d)  = 评委 i 在维度 d 上、对【全部参赛队】给出的原始分的均值
//     stdev(i,d) = 同上标准差
//     z[i][d]    = (s[i][d] − mean(i,d)) / stdev(i,d)
//   例：评委 A 一贯给 85、评委 B 一贯给 70，差异不代表项目更差，只代表 B 更严格。
//   直接加权相加，榜单实际是「谁遇到了宽松的评委」（S7 §2.1 机制归因）。
//
// ⛔ 绝对不要用 scipy.stats.zscore 的语义：那是「对给定轴做标准化」（把一组数标准化到
//    均值 0、标准差 1），我们的是「对每个评委的宽严做标准化」。两者数学形式相似、口径不同。
//    设计文档 §3.5「不借鉴 scipy / numpy」与 §6.2 Step 2 的警告框都写了这一点。
//
// 【为什么是 4 策略而不是写死 z-score】
//   S7 §7 自陈「归一化算法……在本赛事场景下的效果未验证」。写死则首届后发现不合适
//   就要重写聚合层。做成配置项后，换策略 = 改一份 JSON（设计文档 §3.7【决策】）。
//
// 【纯函数】无 IO、无 Date.now()、无 Math.random()：
//   trimmed 策略的「多轮截尾」用确定性散列做并列打散，保证同输入同输出（可复算要求）。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 5 处修正，读代码前先看这段】
//   ① D-1 的 series 缺省回退**原实现根本没做**：直接 `continue` 跳过没有 series 的样本，
//      于是契约形状（INTERFACES.md 的 `samples: [{ judgeId, value }]`）产出
//      **空 values + fallbackReason = null** —— 一个「静默空成功」。现在按 D-1 兑现。
//   ② 未知策略时**全局统计被一起丢掉**（stats.n 返回 0）。全局口径与策略无关，
//      现在无论策略是否认识都照常给出。
//   ③ 配置项坏值会让 **NaN 静默逃逸**到榜单（trimmedIterations=0 → 0/0 = NaN，
//      而 normalized 仍报 true）。现在配置**fail-fast 抛错**（同构于 P0 的 validateRules）。
//   ④ `fallback: 'raw'` **名实不符**：原来仍然算全局 z 值，只是把 reason 写成 raw_fallback。
//      现在 raw 模式真的给原始分（center = 0、scale = 1 ⇒ z ≡ 原始分）。
//   ⑤ 同一 judgeId 在一个单元内出现两次会被**静默覆盖**。这是契约前提被破坏，
//      现在响亮报错。

// MAD → 标准差的一致估计系数（正态分布下 MAD 的 1/0.6745 ≈ 1.4826）
const MAD_TO_SIGMA = 1.4826;

export const NORMALIZATION_STRATEGIES = Object.freeze(['zscore', 'median', 'trimmed', 'bayes']);

// 降级原因取值（trace.normalization.fallbackReason）
export const FALLBACK_REASONS = Object.freeze({
  SAMPLE_TOO_SMALL: 'judge_sample_too_small', // 样本数不足 → 退回全局口径
  ZERO_STDEV: 'zero_stdev',                   // 标准差为 0 → z 记 0
  RAW_FALLBACK: 'raw_fallback',               // 配置要求直接用原始分
  UNKNOWN_STRATEGY: 'unknown_strategy',
  EMPTY_SAMPLES: 'empty_samples',
  NO_FINITE_VALUES: 'no_finite_values',
});

export const FALLBACK_MODES = Object.freeze(['global', 'raw']);

/**
 * 读一个数值型配置项并做 fail-fast 校验。
 * ⛔ 为什么是「抛错」而不是「退回默认值」：配置写错若被静默改成默认值，
 *    就会重演 P1 Task 5 的 T5-8（「配置项从未被读取，行为硬编码」——
 *    配置与实现各说各话）。而且坏阈值会产出 NaN，NaN 进榜单比崩掉更可怕。
 * @param {object} config
 * @param {string} key
 * @param {number} fallback 缺省值（key 缺失时用）
 * @param {{min?:number, integer?:boolean}} opts
 */
function readConfigNumber(config, key, fallback, opts = {}) {
  const raw = config[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new TypeError(
      `归一化配置项 ${key} 非法：${JSON.stringify(raw)}（必须是有限数）`,
    );
  }
  if (opts.integer && !Number.isInteger(raw)) {
    throw new TypeError(
      `归一化配置项 ${key} 非法：${JSON.stringify(raw)}（必须是整数）`,
    );
  }
  if (opts.min !== undefined && raw < opts.min) {
    throw new TypeError(
      `归一化配置项 ${key} 非法：${JSON.stringify(raw)}（必须 ≥ ${opts.min}）`,
    );
  }
  return raw;
}

function arithmeticMean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** 样本标准差（分母 n−1）。n < 2 时返回 0。 */
function sampleStdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = arithmeticMean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (n - 1));
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function medianAbsoluteDeviation(values, center) {
  return medianOf(values.map((v) => Math.abs(v - center)));
}

/** FNV-1a 32 位散列：用于「截尾」时的确定性并列打散。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 截尾均值中心估计（Hangar 思路：多轮「去一个最高 + 去一个最低」再取均值）。
 * ⛔ 不用 Math.random：每一轮用「值 + 轮次 + 下标」的确定性散列做并列打散，
 *    保证同输入同输出——否则「可复算」（设计文档 S-1）就不成立。
 */
function trimmedCenter(values, iterations) {
  if (values.length <= 2) return arithmeticMean(values);
  let acc = 0;
  for (let k = 0; k < iterations; k += 1) {
    const ordered = values
      .map((value, index) => ({ value, index, tie: fnv1a(`${k}:${index}:${value}`) }))
      .sort((a, b) => a.value - b.value || a.tie - b.tie);
    const kept = ordered.slice(1, ordered.length - 1).map((x) => x.value);
    acc += arithmeticMean(kept);
  }
  return acc / iterations;
}

/**
 * 评委宽严归一化。
 *
 * @param {object} input
 * @param {Array<{judgeId:string, value:number|null, series?:number[]}>} input.samples
 *   同一个 (队伍, 维度) 单元内的样本。**一个单元内 judgeId 必须唯一**（违反 → 抛错）。
 *   `value` 是该评委对当前单元的原始分；
 *   `series` 是该评委在本维度上对**全部参赛队**的原始分序列（样本数 n_i 的来源）。
 *   **不传 series 时按 D-1 退回「同 judgeId 在本单元内的全部 value」**。
 * @param {'zscore'|'median'|'trimmed'|'bayes'} input.strategy
 * @param {object} input.config 规则配置（minSamplesForJudgeNormalization 等）
 * @returns {{normalized:boolean, values:Object<string,number>, fallbackReason:string|null,
 *            stats:{n:number,mean:number,stdev:number}, judgeStats:Object}}
 */
export function normalizeScores({ samples, strategy = 'zscore', config = {} } = {}) {
  // ── 0) 配置 fail-fast（坏配置绝不让 NaN 逃逸） ────────────────────────
  const minSamples = readConfigNumber(config, 'minSamplesForJudgeNormalization', 5, {
    min: 0,
    integer: true,
  });
  const iterations = readConfigNumber(config, 'trimmedIterations', 20, {
    min: 1,
    integer: true,
  });
  const priorStrength = readConfigNumber(config, 'bayesPriorStrength', 5, { min: 0 });
  const fallbackMode = config.fallback ?? 'global';
  if (!FALLBACK_MODES.includes(fallbackMode)) {
    throw new TypeError(
      `归一化配置项 fallback 非法：${JSON.stringify(fallbackMode)}（必须是 ${FALLBACK_MODES.join(' / ')} 之一）`,
    );
  }

  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.EMPTY_SAMPLES,
      stats: { n: 0, mean: 0, stdev: 0 },
      judgeStats: {},
    };
  }

  // ── 1) 一个单元内 judgeId 必须唯一（契约前提，违反 → 响亮报错） ───────
  const occurrence = new Map();
  for (const sample of list) {
    occurrence.set(sample.judgeId, (occurrence.get(sample.judgeId) ?? 0) + 1);
  }
  for (const [judgeId, times] of occurrence) {
    if (times > 1) {
      throw new TypeError(
        `归一化样本中评委 ${judgeId} 出现 ${times} 次 —— 一个 (队伍,维度) 单元内 judgeId 必须唯一`,
      );
    }
  }

  // ── 2) 每个评委在本单元内的原始分（D-1 的 series 缺省回退来源） ──────
  const valuesByJudge = new Map();
  for (const sample of list) {
    if (!Number.isFinite(sample.value)) continue;
    if (!valuesByJudge.has(sample.judgeId)) valuesByJudge.set(sample.judgeId, []);
    valuesByJudge.get(sample.judgeId).push(sample.value);
  }

  // ── 3) 每个评委的 series（本维度上对全部参赛队的原始分） ──────────────
  const seriesByJudge = new Map();
  for (const sample of list) {
    const judgeId = sample.judgeId;
    if (seriesByJudge.has(judgeId)) continue; // 同一评委只取一份
    const provided = Array.isArray(sample.series)
      ? sample.series.filter((v) => Number.isFinite(v))
      : [];
    // D-1：不传（或传了无效的）series → 退回「同 judgeId 在 samples 中的全部 value」
    const series = provided.length ? provided : (valuesByJudge.get(judgeId) ?? []);
    if (series.length) seriesByJudge.set(judgeId, series);
  }

  // ── 4) 全局口径统计（该维度全部 (评委, 队伍) 原始分） ────────────────
  //    ⚠️ 与策略**无关**：策略名写错也不该把全局统计一起丢掉（父代理预审修正 ②）
  const globalPool = [];
  for (const series of seriesByJudge.values()) globalPool.push(...series);
  const globalMean = arithmeticMean(globalPool);
  const globalStdev = sampleStdev(globalPool);
  const globalStats = { n: globalPool.length, mean: globalMean, stdev: globalStdev };

  if (!NORMALIZATION_STRATEGIES.includes(strategy)) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.UNKNOWN_STRATEGY,
      stats: globalStats,
      judgeStats: {},
    };
  }

  // ── 5) 逐评委统计与策略口径 ───────────────────────────────────────────
  const judgeStats = {};
  for (const [judgeId, series] of seriesByJudge) {
    judgeStats[judgeId] = {
      n: series.length,
      mean: arithmeticMean(series),
      stdev: sampleStdev(series),
      center: arithmeticMean(series),
      scale: sampleStdev(series),
      normalized: true,
      fallbackReason: null,
    };
  }

  for (const [judgeId, stat] of Object.entries(judgeStats)) {
    const series = seriesByJudge.get(judgeId);
    if (strategy === 'median') {
      // ORA 思路（只读，独立实现）：中心取中位数，尺度取 1.4826×MAD
      const center = medianOf(series);
      let scale = MAD_TO_SIGMA * medianAbsoluteDeviation(series, center);
      if (scale === 0) scale = stat.stdev; // MAD 为 0（如过半同分）→ 退回标准差
      stat.center = center;
      stat.scale = scale;
    } else if (strategy === 'trimmed') {
      // Hangar 思路：多轮截尾均值做中心估计，尺度仍用标准差（便于与 zscore 横向比较）
      stat.center = trimmedCenter(series, iterations);
      stat.scale = stat.stdev;
    } else if (strategy === 'bayes') {
      // 借鉴 hack-the-back app/services/crowd_bt.py（MIT）的「评委偏差层次估计」思路：
      // 用经验贝叶斯收缩替代完整 BT 层次模型（零依赖、无 MCMC）。
      // w = n/(n+k)：样本越少，越向全局均值收缩。
      const w = stat.n / (stat.n + priorStrength);
      stat.center = w * stat.mean + (1 - w) * globalMean;
      stat.scale = Math.sqrt(w * stat.stdev ** 2 + (1 - w) * globalStdev ** 2);
    }
    // zscore（默认，S7 原文）：center = mean，scale = stdev
  }

  // ── 6) 降级判定（必须显式，绝不静默） ─────────────────────────────────
  for (const stat of Object.values(judgeStats)) {
    if (stat.n < minSamples) {
      // 样本不足 → 退回（S7 §3.1 + C-05 第 1 条）
      stat.normalized = false;
      if (fallbackMode === 'raw') {
        // raw 模式**真的**给原始分：center = 0、scale = 1 ⇒ z ≡ 原始分（父代理预审修正 ④）
        stat.fallbackReason = FALLBACK_REASONS.RAW_FALLBACK;
        stat.center = 0;
        stat.scale = 1;
      } else {
        // 全局口径：center = 全局均值、scale = 全局标准差
        // ⇒ 映射回原始单位后等价于「不做宽严校正」（D-14）
        stat.fallbackReason = FALLBACK_REASONS.SAMPLE_TOO_SMALL;
        stat.center = globalMean;
        stat.scale = globalStdev;
      }
    }
    if (stat.scale === 0) {
      // 该评委该维度无区分度 → z 记 0（S7 §3.1 + 设计文档 §6.2 Step 2）
      stat.normalized = false;
      stat.fallbackReason = stat.fallbackReason ?? FALLBACK_REASONS.ZERO_STDEV;
    }
  }

  // ── 7) 逐评委产出 z 值 ───────────────────────────────────────────────
  const values = {};
  for (const sample of list) {
    if (!Number.isFinite(sample.value)) continue;
    const stat = judgeStats[sample.judgeId];
    if (!stat) continue;
    const z = stat.scale > 0 ? (sample.value - stat.center) / stat.scale : 0;
    // 防御性：任何非有限数都不许逃逸到榜单（父代理预审修正 ③）
    values[sample.judgeId] = Number.isFinite(z) ? z : 0;
  }

  const judgeIds = Object.keys(judgeStats).sort();
  // ⚠️ 「声称归一化成功，却一个分数都没产出」是误导 —— 必须显式降级。
  //    触发场景：样本全在，但 value 全是 null / NaN（该单元没人真正打了分）。
  if (!Object.keys(values).length) {
    return {
      normalized: false,
      values: {},
      fallbackReason: FALLBACK_REASONS.NO_FINITE_VALUES,
      stats: globalStats,
      judgeStats,
    };
  }
  return {
    normalized: judgeIds.length > 0 && judgeIds.every((id) => judgeStats[id].normalized),
    values,
    fallbackReason: judgeIds.map((id) => judgeStats[id].fallbackReason).find(Boolean) ?? null,
    stats: globalStats,
    judgeStats,
  };
}

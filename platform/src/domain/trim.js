// src/domain/trim.js — 去极值 + 席位加权分
//
// 依据：S7 §3.2（去极值：同维度去掉一个最高一个最低再取均值；要求该维度评委数 ≥5）
//       + 设计文档 §6.2 Step 3 / Step 4。
//   需求：R-JDG-03（去极值）｜R-JDG-04（双席加权总分 P 的公共原语）
//
// ⚠️ 关于「评委席得分 P」的尺度（重要，别照抄 S7 字面）：
//   S7 §3.1 字面写的是 P = Σ_d (weight_d × mean_over_j(z[j][d]))，单位是 z。
//   但企业席分 E 是 0–100 原始分，z 单位与 0–100 不可通约，公式 (1−w_E)×P + w_E×E
//   在 z 单位下没有意义。本计划的口径：
//     ① 先按 S7 §3.1 对【评委的宽严】做 z 归一化；
//     ② 去极值得到该 (队伍, 维度) 的 z 均值；
//     ③ 用「全局均值 + z均值 × 全局标准差」把 z 还原回 0–100 尺度；
//        （等价于「先做宽严校正，再按维度加权」；当评委完全同质时该式退化为原始分均值）
//     ④ 再按维度权重加权得 P。
//   该口径在 scoring.js 中实现，本模块只提供两个纯函数原语。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 4 处修正，读代码前先看这段】
//   ① `minJudges` 缺省 / 非法 → 去极值闸门**完全失效**：
//      `list.length < undefined` 恒为 false，于是**3 个评委也去极值** ——
//      去掉一个最低一个最高后只剩 1 个，该队的分数**完全由单个评委决定**，
//      评委宽严偏差直接变成队伍分差（S7 §3.2 要求评委数达标才去极值）。
//      现在 minJudges 必填且必须是 ≥1 的整数，否则抛 TypeError。
//   ② `seatScore` 的权重**没有校验** → NaN 静默进榜单；
//      更糟的是权重为字符串时 `weightSum += weight` 会把 weightSum **变成字符串**
//      （`0 + 'x' === '0x'`）—— 类型污染，下游比较全乱。
//      现在权重必须是**有限非负数**，否则抛 TypeError。
//   ③ **零权重的维度被误报进 `missing`** → 虚假告警污染 trace 与 warning。
//      权重表里写 0 的维度是「不启用」，既不参与计算，也**不算缺分**。
//   ④ 同一 judgeId 出现两次被当成两个评委（removed 甚至会出现 max === min === 'j1'）。
//      现在响亮报错。

/**
 * 去极值。
 * @param {object} input
 * @param {Array<{judgeId:string, z:number}>} input.values 同一 (队伍, 维度) 单元内全部评委的 z
 * @param {number} input.minJudges 有效评委数下限（**必填**，≥1 的整数）；不足则不去极值
 * @returns {{mean:number, trimmed:boolean, removed:{max:string|null, min:string|null}}}
 */
export function trimOutliers({ values, minJudges } = {}) {
  if (!Number.isInteger(minJudges) || minJudges < 1) {
    throw new TypeError(
      `去极值的 minJudges 非法：${JSON.stringify(minJudges)}（必须是 ≥1 的整数 —— S7 §3.2 要求该维度评委数达标才去极值）`,
    );
  }

  const list = (Array.isArray(values) ? values : []).filter(
    (v) => v && Number.isFinite(v.z),
  );

  // 一个 (队伍, 维度) 单元内 judgeId 必须唯一 —— 否则「去掉最高最低」会把同一个人算两次
  const seen = new Set();
  for (const v of list) {
    if (seen.has(v.judgeId)) {
      throw new TypeError(
        `去极值样本中评委 ${v.judgeId} 出现多次 —— 一个 (队伍,维度) 单元内 judgeId 必须唯一`,
      );
    }
    seen.add(v.judgeId);
  }

  if (!list.length) {
    return { mean: 0, trimmed: false, removed: { max: null, min: null } };
  }

  const total = list.reduce((acc, v) => acc + v.z, 0) / list.length;
  if (list.length < minJudges) {
    // 有效评委数不足 → 不去极值（S7 §3.2）
    return { mean: total, trimmed: false, removed: { max: null, min: null } };
  }

  // 并列时按 judgeId 字典序确定性打破 —— 否则同分场景的 trace 不可复算
  const sorted = [...list].sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z;
    if (a.judgeId === b.judgeId) return 0;
    return a.judgeId < b.judgeId ? -1 : 1;
  });

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const kept = sorted.slice(1, sorted.length - 1);

  if (!kept.length) {
    // 防御：minJudges 被配成 1 或 2 时会退化为空集，此时不去极值
    return { mean: total, trimmed: false, removed: { max: null, min: null } };
  }

  const mean = kept.reduce((acc, v) => acc + v.z, 0) / kept.length;
  return { mean, trimmed: true, removed: { max: max.judgeId, min: min.judgeId } };
}

/**
 * 席位加权分（0–100）。
 * @param {object} input
 * @param {Object<string, number>} input.dimensionScores 该队各维度的最终分（0–100，由上游保证区间）
 * @param {Object<string, number>} input.weights 各维度的生效权重（**必须有限非负数**）
 * @returns {{score:number, weightSum:number, missing:string[]}}
 *   missing = 有**正权重**但没有分数的维度（调用方必须把它变成 warning，⛔ 不静默当 0）
 *
 * ⚠️ 口径提醒（Task 8 总装时必须知道）：
 *   ① `score = Σ(w·s) / Σw` 的分母是**实际参与计算的权重和**，不是权重表的全量。
 *      某维度缺分时它的权重被**剔除**（并进 `missing`），
 *      于是结果是「**已有维度上的相对加权平均**」，不是绝对分数。
 *      例：weights {a:0.5, b:0.5}、只有 a 有分 → score = a 的分、weightSum = 0.5。
 *   ② 权重为 0 的维度**不启用**：不参与分子分母、没有分也**不算缺分**。
 *   ③ `dimensionScores` 里权重表**没有**的维度被忽略（权重表定义席位的构成）。
 *   ④ `weightSum === 0`（整个席位没启用任何维度）→ `score = 0`，
 *      调用方**必须**自行记 warning —— `missing` 此时是空的，看不出来。
 */
export function seatScore({ dimensionScores, weights } = {}) {
  const scores = dimensionScores ?? {};
  const w = weights ?? {};
  let weighted = 0;
  let weightSum = 0;
  const missing = [];

  for (const key of Object.keys(w).sort()) {
    const weight = w[key];
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      throw new TypeError(`席位权重 ${key} 非法：${JSON.stringify(weight)}（必须是有限数）`);
    }
    if (weight < 0) {
      throw new TypeError(`席位权重 ${key} 非法：${weight}（不能为负）`);
    }
    if (weight === 0) {
      // 权重为 0 → 该维度在席位里**不启用**：不参与分子分母，
      // 没有分也**不算缺分**（报了就是虚假告警 —— 权重表里写 0 本身就是「不启用」的意思）。
      continue;
    }
    const score = scores[key];
    if (!Number.isFinite(score)) {
      missing.push(key);
      continue;
    }
    weighted += weight * score;
    weightSum += weight;
  }

  if (weightSum === 0) {
    return { score: 0, weightSum: 0, missing };
  }
  return { score: weighted / weightSum, weightSum, missing };
}

// src/domain/self-eval.js — 自评测差异检测
//
// 依据：S7 §4.3（R-JDG-13）｜设计文档 §6.2 Step 7。
//   d = 自评分 − 评委分（同一尺度）
//   |d| ≤ 10 → 无影响
//   d >  10 → 触发复核：要求团队书面说明自评理由；不成立则自评分对齐评委分（不加分）
//   d < -10 → 触发复核：评委向团队提问（只提问，不改分）
//
// 机制归因（S7 §4.3）：「一旦自评可以加分，它就变成了纯粹的博弈项。
//   让它只触发『解释』和『提问』，它才真正对治黑箱。」
// → 所以本模块【只产出 flag】，不产出分数；分数的处理在 scoring.js 里按 action 显式执行。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 3 处修正，读代码前先看这段】
//   ① `threshold` 非法（NaN / 字符串）→ 比较恒为 false → **静默产出零 flag**，
//      看上去像「所有自评都正常」。现在 fail-fast 抛错。
//   ② `judgeScores` 同一 (teamId, dimension) 出现多条 → **后者静默覆盖前者**，
//      而结果取决于数组顺序 → 不可复算。现在响亮报错（契约前提：每格一条聚合分）。
//   ③ `flags` 排序用 `localeCompare` → **依赖运行环境的 locale 与 ICU 版本**，
//      同一份数据在不同机器上可能排出不同顺序 → 破坏「可复算」。
//      现在改用与 `trim.js` 一致的普通字典序比较（ASCII 序）。

export const SELF_EVAL_ACTIONS = Object.freeze({
  WRITTEN_EXPLANATION: 'written_explanation',
  JUDGE_QUESTION: 'judge_question',
});

/**
 * @param {object} input
 * @param {Array<{teamId:string, dimension:string, rawScore:number}>} input.selfReviews
 * @param {Array<{teamId:string, dimension:string, score:number}>} input.judgeScores 评委席同尺度分
 *   ⚠️ **每个 (teamId, dimension) 只能一条**（重复 → 抛错）
 * @param {number} input.threshold 阈值（默认 10，配置在 rules/*.json）
 * @returns {{flags:Array<{teamId:string, dimension:string, d:number, action:string}>}}
 */
export function detectSelfEvalDiff({ selfReviews = [], judgeScores = [], threshold = 10 } = {}) {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new TypeError(
      `自评差异检测的 threshold 非法：${JSON.stringify(threshold)}（必须是有限数）`,
    );
  }

  const judgeMap = new Map();
  for (const j of judgeScores) {
    const key = `${j.teamId}::${j.dimension}`;
    if (judgeMap.has(key)) {
      throw new TypeError(
        `评委分里 (队伍 ${j.teamId}, 维度 ${j.dimension}) 出现多条 —— 每格只能有一条聚合分`,
      );
    }
    judgeMap.set(key, j.score);
  }

  const flags = [];
  for (const s of selfReviews) {
    const judgeScore = judgeMap.get(`${s.teamId}::${s.dimension}`);
    if (!Number.isFinite(judgeScore) || !Number.isFinite(s.rawScore)) continue; // 缺数据不当异常
    const d = s.rawScore - judgeScore;
    if (d > threshold) {
      flags.push({ teamId: s.teamId, dimension: s.dimension, d, action: SELF_EVAL_ACTIONS.WRITTEN_EXPLANATION });
    } else if (d < -threshold) {
      flags.push({ teamId: s.teamId, dimension: s.dimension, d, action: SELF_EVAL_ACTIONS.JUDGE_QUESTION });
    }
  }
  // ⚠️ 用普通字典序而非 localeCompare —— 后者依赖 locale 与 ICU 版本，跨机器结果可能不同
  flags.sort((a, b) => {
    if (a.teamId !== b.teamId) return a.teamId < b.teamId ? -1 : 1;
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    return 0;
  });
  return { flags };
}

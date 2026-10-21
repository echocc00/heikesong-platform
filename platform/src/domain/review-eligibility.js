// src/domain/review-eligibility.js — 互评资格 + 回避判定
//
// 依据：S10 §0.4（R-RNK-07 互评资格门槛：只对该赛段有真实交付物的队伍开放）
//       + S7 §2.4 R5（R-JDG-09 回避制度：评委为供应方/投资方/前雇主必须回避，回避记录留档）
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 3 处修正，读代码前先看这段】
//   ① **回避的「撤销」永远失效**（本文件最严重的一处）：原实现 `for` 循环遇到**第一条**
//      匹配记录就 return，而 `recusal_records` 是 **append-only** 的 ——
//      「回避 → 组委会复核 → 撤销回避」会留下**两条**记录，
//      于是取到的是第一条 `recused`，`action='reinstated'` 的那条**从未被读到**。
//      规格自带的用例只给了**单条** reinstated 记录，正好掩盖了这一点。
//      现在取**最后一条**匹配记录（按 `declared_at`，缺省按数组顺序）再判它的 action。
//   ② `team_id` 为 `undefined` 时不当作赛段级回避（只有 `null` 才算）——
//      数据来源变化就会漏判。现在 `null` / `undefined` 都算赛段级。
//   ③ `teams` 有重复 → `eligible` 里出现重复队号；`deliverables` 有重复 → 后者静默覆盖前者。
//      现在 teams 去重、deliverables 重复报错。

/**
 * 互评资格：只对该赛段有真实交付物的队伍开放互评（R-RNK-07）。
 * @param {object} input
 * @param {Array<{teamId:string}>} input.teams
 * @param {Array<{teamId:string, hasRealDeliverable:boolean}>} input.deliverables
 *   ⚠️ 同一队只能一条（重复 → 抛错）
 * @returns {{eligible:string[], ineligible:string[]}}
 */
export function checkPeerEligibility({ teams = [], deliverables = [] } = {}) {
  const deliverableMap = new Map();
  for (const d of deliverables) {
    if (deliverableMap.has(d.teamId)) {
      throw new TypeError(`互评资格：队伍 ${d.teamId} 有多条交付物记录 —— 数据异常`);
    }
    deliverableMap.set(d.teamId, !!d.hasRealDeliverable);
  }

  const eligible = [];
  const ineligible = [];
  const seen = new Set();
  for (const t of teams) {
    if (seen.has(t.teamId)) continue; // 同一队只判一次
    seen.add(t.teamId);
    if (deliverableMap.get(t.teamId)) eligible.push(t.teamId);
    else ineligible.push(t.teamId);
  }
  eligible.sort();
  ineligible.sort();
  return { eligible, ineligible };
}

/**
 * 回避判定：命中**最新一条**回避记录即不可评该队。
 * @param {object} input
 * @param {{userId:string}} input.judge
 * @param {{teamId:string}} input.team
 * @param {Array<{judge_id:string, team_id:string|null, action:string, reason:string, declared_at?:string}>} input.recusalRecords
 *   ⚠️ 记录是 append-only 的：「回避 → 复核 → 撤销」会留下两条，**最后一条**才作数。
 * @returns {{recused:boolean, record?:object}}
 */
export function checkRecusal({ judge, team, recusalRecords = [] } = {}) {
  if (!judge?.userId) return { recused: false };
  const teamId = team?.teamId;

  // 收集该评委对该队（或对该赛段整体）的全部记录
  const matching = recusalRecords.filter((record) => {
    if (record.judge_id !== judge.userId) return false;
    const scope = record.team_id;
    // team_id 为 null / undefined = 赛段级回避，对该赛段所有队生效
    return scope === null || scope === undefined || scope === teamId;
  });
  if (!matching.length) return { recused: false };

  // ⛔ 取**最后**一条：`action='reinstated'`（已撤销）必须能覆盖前面的 `recused`。
  //    有 declared_at 就按时间取最新的；都没有就按数组顺序取靠后的。
  const latest = matching.reduce((acc, r) => {
    if (!acc) return r;
    const a = acc.declared_at ?? '';
    const b = r.declared_at ?? '';
    if (a === b) return r;        // 时间相同 → 数组里靠后的更新
    return b > a ? r : acc;       // 时间新的作数
  }, null);

  if (latest.action !== 'recused') return { recused: false };
  return { recused: true, record: latest };
}

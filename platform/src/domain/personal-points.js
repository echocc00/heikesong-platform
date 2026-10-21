// src/domain/personal-points.js — 个人积分的【唯一计算点】（R-RNK-10 终生上榜）
// 依据：任务书 §七 + 设计文档 §6.3 + INTERFACES.md §4
//   「points_ledger.kind: stage_rank | mvp | roadshow | personal_rollup」
//
// ⭐ 本文件是【个人积分口径的唯一实现】。
//    同一个需求 R-RNK-10「个人积分终生上榜」曾经有**两套独立实现**：
//      · src/domain/points.js 的 computePersonalPoints（读 rules/points.json 的 personal）
//        —— **排除** personal_rollup、**任何 kind 都计入**（含未知 kind）
//      · src/domain/pool-derive.js 的 aggregatePersonalPoints（读 rules/pools.json 的 talentPointKinds）
//        —— **以 rollup 为准**、**只计白名单 kind**
//    同一份流水能算出两个不同的名次（实测：stage_rank=10 + personal_rollup=12
//    ⇒ 榜单算 10、人才池算 12；kind=weird=99 ⇒ 榜单算 99、人才池算 0）。
//    现在两处都**委托本模块** ⇒ 口径只有一份、规则只有一个来源
//    （rules/points.json 的 personal 组：atomicKinds + rollupKind + includeMvpVote）。
//
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。时间与规则全部由参数传入。
//
// ── 唯一口径（唯一真源；别处不许另立一套）────────────────────────────
//   ① 有 personal_rollup 行 → total = rollup 之和。
//      rollup 是【别人算好的汇总快照】——它存在，它就是权威值；
//      再把 atomic 加上去就是**重复计分**。它不存在，才只能自己从 atomic 累加。
//      两者都在且不一致 → 产出**显式 warning**（points_ledger_kind_conflict），不静默。
//   ② 否则 → total = atomic 白名单之和（白名单 = rules.points.personal.atomicKinds）。
//   ③ 非白名单 kind → **不计入**，产出 warning（points_kind_ignored）。
//   ④ includeMvpVote === false → mvp kind 不计入。
//   ⑤ 无 userId 的行 → 跳过（⛔ 不产出 "null" 键）。
//
// ⚠️ 为什么「有 rollup 就以 rollup 为准」而不是「排除 rollup」：
//    这两条规则**互斥**，本项目选了后者（rollup 优先）——因为 R-RNK-10 要的是
//    「一个人一生累计到多少分」，而 rollup 行就是为此存在的快照。
//    选「排除 rollup」的话，rollup 存在时总额永远是 atomic 之和，
//    快照就白存了；而 rollup 与 atomic 不一致时又没有任何告警 —— 那才是真正算错。

/** 原子积分 kind 的默认白名单（rules.points.personal.atomicKinds 缺省时的兜底）。 */
export const ATOMIC_POINT_KINDS = ['stage_rank', 'mvp', 'roadshow'];
/** 汇总快照 kind 的默认名（rules.points.personal.rollupKind 缺省时的兜底）。 */
export const ROLLUP_POINT_KIND = 'personal_rollup';

function pick(row, camel, snake) {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

/**
 * 个人积分聚合（**唯一口径**，见文件头注释的五条）。
 *
 * @param {object} p
 * @param {Array} p.ledger 积分流水行（camelCase 或 snake_case 字段名都认）
 * @param {object} p.pointsConfig 规则组（通常是 rules.points；取它的 personal 组）
 * @returns {{ byUser: object, warnings: Array, excludedEntries: number }}
 *   byUser[userId] = {
 *     total,                        // 该人的积分总额（口径①②）
 *     stagesJoined,                 // 参与过的赛段数（去重）
 *     breakdown: { atomic, rollup },// 两种口径各自的和（冲突时一眼看得出）
 *     byKind,                       // 分 kind 的明细（leaderboard 的 byKind 字段）
 *   }
 *   warnings：口径外 kind / rollup 与 atomic 冲突（⛔ 不静默）
 *   excludedEntries：**完全没有被计入**的流水行数（无 userId / 口径外 kind / mvp 被关闭）。
 *     rollup 行与 atomic 行都已被计入（rollup 决定 total、atomic 进 breakdown）⇒ 不计在内。
 */
export function computePersonalTotals({ ledger = [], pointsConfig = {} } = {}) {
  const personal = pointsConfig?.personal ?? {};
  const atomicKinds = Array.isArray(personal.atomicKinds) && personal.atomicKinds.length
    ? personal.atomicKinds
    : ATOMIC_POINT_KINDS;
  const rollupKind = typeof personal.rollupKind === 'string' && personal.rollupKind
    ? personal.rollupKind
    : ROLLUP_POINT_KIND;
  const includeMvpVote = personal.includeMvpVote !== false;
  const eps = 1e-9;

  const byUser = new Map();
  const warnings = [];
  let excluded = 0;

  for (const row of Array.isArray(ledger) ? ledger : []) {
    if (!row) continue;
    // ⑤ 无 userId → 跳过（⛔ 不产出 "null" 键：那会把一个幽灵用户写进人才池/榜单）
    const userId = pick(row, 'userId', 'user_id');
    if (!userId) {
      excluded += 1;
      continue;
    }
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId, atomic: 0, rollup: 0, atomicRows: 0, rollupRows: 0, stages: new Set(), byKind: {},
      });
    }
    const acc = byUser.get(userId);
    const kind = row.kind || 'unknown';
    const points = Number(row.points) || 0;

    if (kind === rollupKind) {
      // ① rollup 行：它就是权威值
      acc.rollup += points;
      acc.rollupRows += 1;
      acc.byKind[kind] = (acc.byKind[kind] || 0) + points;
    } else if (atomicKinds.includes(kind)) {
      if (kind === 'mvp' && !includeMvpVote) {
        // ④ MVP 投决积分被关闭 → 不计入
        excluded += 1;
      } else {
        // ② atomic 白名单内的 kind
        acc.atomic += points;
        acc.atomicRows += 1;
        acc.byKind[kind] = (acc.byKind[kind] || 0) + points;
      }
    } else {
      // ③ 口径外的 kind → 不计入，但**显式告警**（不静默）
      excluded += 1;
      warnings.push({ code: 'points_kind_ignored', userId, kind });
    }

    const stageId = pick(row, 'stageId', 'stage_id');
    if (stageId) acc.stages.add(stageId);
  }

  const out = {};
  for (const acc of byUser.values()) {
    let total;
    if (acc.rollupRows > 0) {
      total = acc.rollup;
      if (acc.atomicRows > 0 && Math.abs(acc.rollup - acc.atomic) > eps) {
        warnings.push({
          code: 'points_ledger_kind_conflict',
          userId: acc.userId,
          rollup: acc.rollup,
          atomic: acc.atomic,
        });
      }
    } else {
      total = acc.atomic;
    }
    out[acc.userId] = {
      total,
      stagesJoined: acc.stages.size,
      breakdown: { atomic: acc.atomic, rollup: acc.rollup },
      byKind: { ...acc.byKind },
    };
  }
  return { byUser: out, warnings, excludedEntries: excluded };
}

// src/domain/points.js — 名次积分 / MVP / 个人积分（纯函数）
// 依据：任务书 §七 + 设计文档 §6.3 + R-STG-02（10/8/5）+ R-RNK-09（MVP）+ R-RNK-10（终生上榜）
//
// ⚠️ 上游借鉴记录：HackSC/hibiscus `calculatePoints.ts`（MIT）的 switch【无 break 穿透】，
//    实际发的是 18/8/3/1（上游自己写的目标值是 10/5/2/1）——相对顺序不变但数值全错。
//    本实现不复用其代码，口径以 任务书 §七（第一/二/三名 = 10/8/5）为准，
//    并由 test/points.test.js 写死断言，防止把上游 bug 一起搬进来。
//
// ⛔ 本模块【不】产生任何影响段位或行为分的数值；行为分不在这里出现。
import { cmpStr } from './util.js';

/** 赛段名次积分：第 1/2/3 名 = 10/8/5，其余 0（任务书 §七 + R-STG-02，已定）。 */
export function stagePointsFor(rank, pointsConfig) {
  const table = Array.isArray(pointsConfig?.stagePoints) ? pointsConfig.stagePoints : [];
  const topN = Number.isFinite(pointsConfig?.stagePointsOnlyTopN) ? pointsConfig.stagePointsOnlyTopN : table.length;
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1) return 0;
  if (r > topN) return 0;
  return typeof table[r - 1] === 'number' ? table[r - 1] : 0;
}

/**
 * 按【位置】发放名次积分。
 * 依据：设计文档 §6.3「任务包内全量战队排名，第一/二/三名 = 10/8/5」。
 * ⚠️ 并列（1224 名次）时按位置发放：并列第一的两队占第 1、2 席 → 10 与 8。
 *    这样任一赛段的积分总额恒为 10+8+5=23，MVP 跨赛段比较才是同一把尺子。
 *    位置由破同分链末级的队伍编号兜底稳定排序 → 可复算。
 */
export function computeStagePoints({ ordered, pointsConfig }) {
  const rows = Array.isArray(ordered) ? ordered : [];
  return rows.map((row, i) => ({
    teamId: row.teamId,
    rank: row.rank ?? null,
    position: i + 1,
    points: stagePointsFor(i + 1, pointsConfig),
  }));
}

/**
 * MVP：4 赛段总积分 + S4 路演评审综合，每个任务包 1 个（任务书 §七 + 设计文档 §6.3 + R-RNK-09）。
 * - stagePoints: [{ teamId, stageId?, points }]，带 stageId 时只取前 stagesCounted 个赛段
 * - roadshowScores: [{ teamId, score }]，S4 路演评审综合分（0–100）
 * 路演综合分先折算成【路演名次积分】（与赛段名次同一 10/8/5 口径），再乘 roadshowWeight
 * 计入总分 —— 两部分量纲一致，不需要另造一套权重。
 */
export function computeMvp({ stagePoints, roadshowScores, packageId, pointsConfig }) {
  const mvpCfg = pointsConfig?.mvp || {};
  const stagesCounted = Number.isFinite(mvpCfg.stagesCounted) ? mvpCfg.stagesCounted : 4;
  const roadshowWeight = Number.isFinite(mvpCfg.roadshowWeight) ? mvpCfg.roadshowWeight : 1;
  const perPackage = Number.isFinite(mvpCfg.perPackage) ? mvpCfg.perPackage : 1;

  // ① 赛段积分聚合（只取前 stagesCounted 个赛段；赛段键按字典序，S1..S4 顺序稳定）
  const stageTotals = new Map();
  const entries = Array.isArray(stagePoints) ? stagePoints : [];
  const withStage = entries.filter((e) => e && e.stageId !== undefined && e.stageId !== null);
  if (withStage.length) {
    const stageIds = [...new Set(withStage.map((e) => String(e.stageId)))].sort();
    const counted = new Set(stageIds.slice(0, stagesCounted));
    for (const e of withStage) {
      if (!counted.has(String(e.stageId))) continue;
      stageTotals.set(e.teamId, (stageTotals.get(e.teamId) || 0) + (Number(e.points) || 0));
    }
  } else {
    for (const e of entries) {
      if (!e) continue;
      stageTotals.set(e.teamId, (stageTotals.get(e.teamId) || 0) + (Number(e.points) || 0));
    }
  }

  // ② S4 路演评审综合 → 路演名次 → 路演积分（同 10/8/5 口径）
  const roadRanked = (Array.isArray(roadshowScores) ? roadshowScores : [])
    .filter((r) => r && r.teamId)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || cmpStr(a.teamId, b.teamId));
  const roadPoints = new Map();
  roadRanked.forEach((r, i) => { roadPoints.set(r.teamId, stagePointsFor(i + 1, pointsConfig)); });

  // ③ 综合分 = 4 赛段总积分 + roadshowWeight × 路演积分
  const teamIds = new Set([...stageTotals.keys(), ...roadPoints.keys()]);
  const ranked = [...teamIds].map((teamId) => {
    const stageTotal = stageTotals.get(teamId) || 0;
    const road = roadPoints.get(teamId) || 0;
    return {
      teamId,
      stageTotal,
      roadshowPoints: road,
      roadshowContribution: roadshowWeight * road,
      score: stageTotal + roadshowWeight * road,
    };
  }).sort((a, b) => b.score - a.score || cmpStr(a.teamId, b.teamId));

  const winners = ranked.slice(0, Math.max(1, perPackage));
  return {
    packageId: packageId ?? null,
    stagesCounted,
    roadshowWeight,
    mvp: winners[0] ?? null,
    mvpList: winners,
    ranked,
  };
}

/**
 * 个人积分：赛段积分 + MVP 投决积分，终生上榜（任务书 §七 + R-RNK-10 + rules.points.personal）。
 * ⛔ kind='personal_rollup' 是派生快照，不参与累加（否则重复计分）。
 */
export function computePersonalPoints({ ledger, pointsConfig }) {
  const personalCfg = pointsConfig?.personal || {};
  const lifetime = personalCfg.lifetime !== false;
  const includeMvpVote = personalCfg.includeMvpVote !== false;

  const totals = new Map();
  const kinds = new Map();
  let excluded = 0;
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry || !entry.userId) continue;
    const kind = entry.kind || 'unknown';
    if (kind === 'personal_rollup') { excluded += 1; continue; }
    if (kind === 'mvp' && !includeMvpVote) { excluded += 1; continue; }
    const pts = Number(entry.points) || 0;
    totals.set(entry.userId, (totals.get(entry.userId) || 0) + pts);
    if (!kinds.has(entry.userId)) kinds.set(entry.userId, {});
    const km = kinds.get(entry.userId);
    km[kind] = (km[kind] || 0) + pts;
  }

  const rows = [...totals.entries()]
    .map(([userId, total]) => ({ userId, total, byKind: kinds.get(userId) || {} }))
    .sort((a, b) => b.total - a.total || cmpStr(a.userId, b.userId));

  let before = 0;
  let prev = null;
  let curRank = 0;
  for (const r of rows) {
    if (prev === null || r.total !== prev) {
      prev = r.total;
      curRank = before + 1;     // 1224 式：名次 = 本组之前的行数 + 1（并列占位，名次跳号）
    }
    r.rank = curRank;           // ⛔ 并列的行**也必须**拿到名次
    before += 1;
  }
  return { lifetime, includeMvpVote, rows, excludedEntries: excluded };
}

/**
 * 奖金分配（并列共享总额不变）。
 * 依据：R-JDG-20「同分即并列，共享该名次奖金（总额不变）」+ C-03 的 1224 名次。
 * ⚠️ 本函数是本阶段【新增】的（INTERFACES.md 未列）："总额不变"需要一条可执行算法，
 *    否则并列时奖金会被重复发放或漏发。
 *    语义：并列组占据名次区间 [k, k+n-1]，该区间的奖金总额由组内平分；名次 k+n 及之后
 *    的队伍按自己的名次领奖 —— 于是发放总额与无并列时一致。
 */
export function computePrizeShares({ ordered, prizeTable }) {
  const table = prizeTable || {};
  const groups = [];
  let cur = null;
  for (const row of Array.isArray(ordered) ? ordered : []) {
    if (!cur || cur.rank !== row.rank) {
      cur = { rank: row.rank, teamIds: [] };
      groups.push(cur);
    }
    cur.teamIds.push(row.teamId);
  }

  const shares = [];
  let consumed = 0;
  let totalPool = 0;
  for (const g of groups) {
    const slots = g.teamIds.map((_, i) => consumed + i + 1);
    const pool = slots.reduce((s, r) => s + (Number(table[r]) || 0), 0);
    totalPool += pool;
    const share = g.teamIds.length ? pool / g.teamIds.length : 0;
    for (const t of g.teamIds) shares.push({ teamId: t, rank: g.rank, share, pool, slots: slots.slice() });
    consumed += g.teamIds.length;
  }
  return {
    shares,
    totalPool,
    groups: groups.map((g) => ({ rank: g.rank, teamIds: g.teamIds })),
  };
}

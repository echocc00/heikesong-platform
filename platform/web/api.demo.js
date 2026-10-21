// web/api.demo.js — 演示版适配器（浏览器内 localStorage + 【真实运行的规则引擎】）
//
// 依据：设计文档 §14.3「公网演示版（现在就能拿到的 URL）」
//   前端代码 100% 复用，只换数据层：
//     web/api.js      → 真实 HTTP 客户端
//     web/api.demo.js → localStorage 适配器 + web/seed/demo-data.json
//
// ✅ 演示版能做什么：完整走一遍 报名 → 组队 → 打分 → 计算 → 发榜 → 段位 → 战绩卡 → 三池 → 公开 API，
//    所有规则引擎【在浏览器里真实运行】（不是假数据硬编码的结果）。
//    实现方式：直接 import ../src/domain/*.js —— 领域层本来就是无 IO 的纯函数 ESM，
//    相对路径 import 即可，【不需要打包器】。
// ⛔ 演示版不能做什么：数据不跨人共享（各自浏览器独立）。这是无云主机条件下的客观边界。
//
// ⚠️ 由此给领域层的硬约束：src/domain/** 不得 import 任何 Node 内置模块
//    （node:fs / node:path / node:crypto …），否则浏览器跑不起来。
//    scripts/build-demo.js 在构建时强制校验这一条，违反即构建失败。
//
// ⚠️ 服务层（src/services/*）做 SQL 编排，【不能】进浏览器。
//    演示版对纯判定逻辑（组队校验）在本地做等价实现，并在注释里写明对应关系。
//
// ⚠️【领域层源码会不会泄到正式站？】—— 这是【两条不同的路】，互不影响：
//    ① 后端那条 Demo 门（src/server.js）：DEMO_MODE=1 才把 /src/domain/* 与 /rules/* 挂上 HTTP。
//       正式部署（systemd + nginx）必须保持 DEMO_MODE 关 ⇒ 领域层源码在正式站一律 404。
//    ② 静态站这条：演示站把领域层【原样拷进产物目录】（浏览器要 import 它才能跑引擎）。
//       演示站是【独立产物】，不与正式部署共用 nginx / systemd ⇒ 领域层源码只出现在演示站。
//    ⇒ 演示站公开领域层源码是【有意的】（观众能看到算法原文，这正是演示的价值），
//       但它【不会】出现在正式站上。两条路的开关互不干涉。
//
// ⚠️ 接口形状必须与 web/api.js（真实后端）一致 —— 否则前端要写两套。
//    本文件每个端点的返回形状都对齐 src/services/* 的对应服务：
//      /api/leaderboard/:stageId  → src/services/leaderboard.js（rank / business / personal 三种口径）
//      /api/leaderboard/rolling   → src/services/leaderboard.js getRollingLeaderboard
//      /api/leaderboard/tier      → src/services/tier.js getTierBoard
//      /api/teams/:id/tier        → src/services/tier.js getTeamTier
//      /api/teams/:id/performance-card → src/services/performance-card.js getPerformanceCard
import { scoreRegistration, classifyLevel, validateRegistrationAnswers } from '../src/domain/registration.js';
import { scoreSolvability } from '../src/domain/solvability.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';
import { detectSelfEvalDiff } from '../src/domain/self-eval.js';
import { rankTeams } from '../src/domain/ranking.js';
import { computeStagePoints, computePersonalPoints } from '../src/domain/points.js';
import { computeTier, classifyDepartment, isDataOrPrototypeMilestone } from '../src/domain/tier.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { applyVisibility } from '../src/domain/visibility.js';

export const STORAGE_KEY = 'hks_demo_store_v1';
export const SEED_URL = './seed/demo-data.json';
export const RULES_BASE = './rules/';

/** 演示版需要的规则文件（构建脚本会校验这些文件都在 rules/ 下） */
export const DEMO_RULE_FILES = {
  scoringInitial: 'scoring-initial.json',
  scoringFinal: 'scoring-final.json',
  tiebreak: 'tiebreak.json',
  ranks: 'ranks.json',
  behavior: 'behavior-points.json',
  visibility: 'visibility.json',
  registration: 'registration-scoring.json',
  solvability: 'solvability.json',
  milestones: 'milestones.default.json',
  teamFormation: 'team-formation.json',
  points: 'points.json',
  criteria: 'criteria.json',
};

export function createMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function defaultStorage() {
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // 隐私模式下访问 localStorage 会抛错 → 退化成内存存储，不报错
  }
  return createMemoryStorage();
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** 确定性比较：普通字典序（⛔ 不用 localeCompare —— 它依赖 locale 与 ICU 版本，跨机器可能不同） */
function cmpStr(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

// ── 状态 ────────────────────────────────────────────────────────

/**
 * 深拷贝种子。
 * ⚠️ 为什么要拷贝：适配器有写路径（报名 / 组队 / 打分 / 计算），
 *    如果 state 直接持有调用方传进来的种子对象的引用，写一次就把种子本身改了 ——
 *    调用方（测试、浏览器端的 getDemoRuntime）手里的种子会跟着漂移，
 *    「同一份种子算出同一份结果」这条前提当场失效。
 *    种子是 JSON ⇒ 用 JSON 往返做深拷贝（零依赖、浏览器与 Node 行为一致）。
 */
function deepCopy(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function buildDemoState(seed) {
  return {
    meta: deepCopy(seed?.meta) ?? {},
    edition: deepCopy(seed?.edition) ?? {},
    users: deepCopy(seed?.users) ?? [],
    taskPackages: deepCopy(seed?.taskPackages) ?? [],
    judges: deepCopy(seed?.judges) ?? [],
    teams: deepCopy(seed?.teams) ?? [],
    reviews: deepCopy(seed?.reviews) ?? {},
    enterpriseConfirmations: deepCopy(seed?.enterpriseConfirmations) ?? [],
    peerReviews: deepCopy(seed?.peerReviews) ?? [],
    selfReviews: deepCopy(seed?.selfReviews) ?? [],
    milestones: deepCopy(seed?.milestones) ?? [],
    signoffs: deepCopy(seed?.signoffs) ?? [],
    behaviorEvents: deepCopy(seed?.behaviorEvents) ?? [],
    registrations: [],
    computations: {},
    results: {},
    me: null,
  };
}

/**
 * 把「评委 → 队伍 → 维度 → 原始分」的嵌套打分矩阵摊平成 submissions。
 * ⚠️ 形状必须与真实写入方（src/services/review.js 落 stage_reviews 的形状）一致：
 *    { judgeId, teamId, dimension, rawScore } —— 少一个字段，正式引擎会当成缺分。
 */
export function expandSubmissions(state) {
  const out = [];
  for (const [judgeId, byTeam] of Object.entries(state.reviews ?? {})) {
    for (const [teamId, byDim] of Object.entries(byTeam ?? {})) {
      for (const [dimension, rawScore] of Object.entries(byDim ?? {})) {
        out.push({ judgeId, teamId, dimension, rawScore: Number(rawScore) });
      }
    }
  }
  return out;
}

/** 队伍名册：R1（分赛道）与 R4（自由命题）需要知道任务包归属 */
export function demoTeamsRoster(state) {
  const pkgById = new Map((state.taskPackages ?? []).map((p) => [p.id, p]));
  return (state.teams ?? []).map((t) => {
    const pkg = pkgById.get(t.packageId) ?? {};
    return {
      teamId: t.id,
      packageEnterpriseId: pkg.enterpriseId ?? null,
      isFreeBrief: pkg.isFreeBrief === true,
    };
  });
}

// ── 计算（核心：真实规则引擎）────────────────────────────────────

export function runDemoCompute({ state, rules, stageId = 'stage_final', now = null }) {
  const config = rules.scoring.final;
  const submissions = expandSubmissions(state);
  const judges = (state.judges ?? []).map((j) => ({ judgeId: j.id, seat: j.seat ?? 'expert' }));
  const teams = demoTeamsRoster(state);

  const scored = scoreStage({
    config,
    judges,
    submissions,
    enterpriseConfirmations: state.enterpriseConfirmations ?? [],
    peerReviews: state.peerReviews ?? [],
    teams,
    selfReviews: state.selfReviews ?? [],
  });

  // 企业席单独跑一遍（拿 seatE 明细，供破同分链的 enterprise_raw 用）。
  // ⚠️ 这是**纯函数**的重复调用，只为拿到明细供展示；计分与告警一律以 scoreStage 的返回为准
  //    （scoreStage 内部已经调过一次 applyEnterpriseRules 并把 ent.warnings 并进 warnings ——
  //    这里【不得】再把 enterprise.warnings 加一遍，否则同一条告警会出现两次）。
  const enterprise = applyEnterpriseRules({
    confirmations: state.enterpriseConfirmations ?? [],
    teams,
    judges,
    config,
  });

  // 破同分链的输入
  const byTeam = {};
  for (const row of scored.teams) {
    const team = (state.teams ?? []).find((t) => t.id === row.teamId) ?? {};
    const peer = (state.peerReviews ?? []).filter((p) => p.toTeamId === row.teamId);
    const conf = (state.enterpriseConfirmations ?? []).filter((c) => c.teamId === row.teamId);
    byTeam[row.teamId] = {
      peerScore: peer.length
        ? peer.reduce((a, p) => a + Number(p.score || 0), 0) / peer.length
        : undefined,
      enterpriseRaw: conf.length
        ? conf.reduce((a, c) => a + Number(c.rawScore || 0), 0) / conf.length
        : undefined,
      behaviorScore: behaviorScore({
        events: (state.behaviorEvents ?? []).filter((e) => e.teamId === row.teamId),
        behaviorConfig: rules.behavior,
      }).total,
      tiebreakExtra: team.tiebreakExtra ?? undefined,
    };
  }

  const candidates = scored.teams.map((row) => ({
    teamId: row.teamId,
    total: row.total,
    seatP: row.seatP,
    seatE: row.seatE,
    peerScore: byTeam[row.teamId].peerScore,
    enterpriseRaw: byTeam[row.teamId].enterpriseRaw,
    behaviorScore: byTeam[row.teamId].behaviorScore,
  }));

  const ranked = rankTeams({
    teams: candidates,
    tiebreakChain: rules.tiebreak.chain,
    tiebreakData: { isFinal: true, byTeam },
    pointsConfig: rules.points,
  });

  const points = computeStagePoints({ ordered: ranked.ordered, pointsConfig: rules.points });
  const selfEvalFlags = demoSelfEvalFlags({ state, threshold: 10 });

  const computationId = `cmp_demo_${(state.computations ? Object.keys(state.computations).length : 0) + 1}`;
  const result = {
    computationId,
    stageId,
    computedAt: now ?? null,
    teams: scored.teams,
    // ⚠️ warnings = 【计算告警】（scoreStage 的返回），与正式引擎逐条一致 ⇒ parity 断言的对象。
    //    破同分链自己的告警（tiebreak_key_unusable 等）单列 tiebreakWarnings ——
    //    榜单层再按正式口径（src/services/leaderboard.js collectWarnings）合并并打 source 标签。
    warnings: scored.warnings,
    tiebreakWarnings: ranked.warnings ?? [],
    trace: scored.trace,
    enterprise: { seatE: enterprise.seatE, weights: enterprise.weights },
    ordered: ranked.ordered,
    chain: ranked.applied,
    candidates,
    points,
    selfEvalFlags,
  };

  state.computations[computationId] = result;
  state.results[stageId] = result;
  state.lastStageId = stageId;
  return result;
}

export function demoSelfEvalFlags({ state, threshold = 10 }) {
  const submissions = expandSubmissions(state);
  const buckets = new Map();
  for (const s of submissions) {
    const key = `${s.teamId}::${s.dimension}`;
    const cur = buckets.get(key) ?? { sum: 0, n: 0 };
    cur.sum += s.rawScore;
    cur.n += 1;
    buckets.set(key, cur);
  }
  // 评委席同尺度分 = 该队该维度上评委分的均值
  const judgeScores = [];
  for (const [key, cur] of buckets) {
    const [teamId, dimension] = key.split('::');
    judgeScores.push({ teamId, dimension, score: cur.sum / cur.n });
  }
  const { flags } = detectSelfEvalDiff({
    selfReviews: state.selfReviews ?? [],
    judgeScores,
    threshold,
  });
  return flags;
}

// ── 段位 / 战绩卡 / 榜单 / 三池 ────────────────────────────────

export function demoTier({ state, rules, teamId }) {
  const milestones = (state.milestones ?? [])
    .filter((m) => m.teamId === teamId)
    .map((m) => ({
      key: m.key,
      countsTowardTier: m.countsTowardTier !== false,
      achieved: m.achieved === true,
      // ⚠️ isDataOrPrototype 由【规则】判定，不采信数据里预置的标志：
      //    真实系统在 src/services/tier.js 里按 rules.criteria.tier 推导 ——
      //    演示版必须同源，否则「数据里的标志写错」时演示段位与正式段位会漂移。
      isDataOrPrototype: isDataOrPrototypeMilestone(m.key, rules.criteria),
    }));
  const signoffs = (state.signoffs ?? [])
    .filter((s) => s.teamId === teamId)
    .map((s) => ({
      milestoneKey: s.milestoneKey,
      department: s.department,
      revokedAt: s.revokedAt ?? null,
      // ⚠️ 同上：部门归类按 rules.criteria.tier 的关键词判定（与正式系统同源）。
      isBusinessDepartment: classifyDepartment(s.department, rules.criteria) === 'business',
    }));
  const tier = computeTier({ milestones, signoffs, ranksConfig: rules.ranks });
  const behavior = behaviorScore({
    events: (state.behaviorEvents ?? []).filter((e) => e.teamId === teamId),
    behaviorConfig: rules.behavior,
  });
  const team = (state.teams ?? []).find((t) => t.id === teamId) ?? {};
  return {
    ...tier,
    teamId,
    teamName: team.name ?? teamId,
    behavior,
    progress: {
      milestones: (rules.milestones?.items ?? []).map((def) => ({ key: def.key, label: def.label })),
      milestoneCount: tier.milestoneCount,
    },
  };
}

export function demoPerformanceCard({ state, rules, teamId }) {
  const tierInfo = demoTier({ state, rules, teamId });
  const team = (state.teams ?? []).find((t) => t.id === teamId) ?? {};
  const items = (rules.milestones?.items ?? []).map((def) => {
    const m = (state.milestones ?? []).find((x) => x.teamId === teamId && x.key === def.key);
    // ⚠️ 撤销的签字不算「已签」（与正式系统 src/services/performance-card.js 同一口径）
    const signoff = (state.signoffs ?? []).find(
      (s) => s.teamId === teamId && s.milestoneKey === def.key && !s.revokedAt,
    );
    return {
      key: def.key,
      label: def.label,
      confirmedBy: def.confirmedBy,
      achieved: m?.achieved === true,
      signed: Boolean(signoff),
      countsTowardTier: def.countsTowardTier !== false,
      // ⛔ 只给部门，不给签字人：S10 §0.3「B 榜签字人不公开」
      signedByDepartment: signoff ? signoff.department : null,
      revoked: Boolean(signoff?.revokedAt),
    };
  });
  return {
    teamId,
    teamName: team.name ?? teamId,
    taskPackageId: team.packageId ?? null,
    tier: tierInfo.tier,
    milestoneCount: tierInfo.milestoneCount,
    businessSignoffCount: tierInfo.businessSignoffCount,
    items,
    achievedCount: items.filter((i) => i.achieved).length,
    total: items.length,
    benefits: tierInfo.benefits ?? [],
    neverUnlocks: tierInfo.neverUnlocks ?? [],
    behavior: tierInfo.behavior,
  };
}

/** 榜单告警：计算告警 + 破同分告警，按正式口径打 source 标签 */
function collectDemoWarnings(result) {
  const out = [];
  for (const w of result?.warnings ?? []) out.push({ source: 'computation', ...w });
  for (const w of result?.tiebreakWarnings ?? []) out.push({ source: 'tiebreak', ...w });
  return out;
}

export function demoLeaderboard({ state, rules, scope = 'rank', viewer = null }) {
  if (scope === 'tier') return demoTierBoard({ state, rules, viewer });
  if (scope === 'rolling') return demoRollingLeaderboard({ state, rules, viewer });

  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (!result) return { scope, rows: [], warnings: [], demo: true, empty: true };
  const warnings = collectDemoWarnings(result);

  // B 榜（商业战绩）：里程碑进度公开，评分与签字人不公开
  if (scope === 'business') {
    const rows = (state.teams ?? []).map((t) => {
      const items = (rules.milestones?.items ?? []).map((def) => {
        const m = (state.milestones ?? []).find((x) => x.teamId === t.id && x.key === def.key);
        const signed = (state.signoffs ?? []).some(
          (s) => s.teamId === t.id && s.milestoneKey === def.key && !s.revokedAt,
        );
        return { key: def.key, label: def.label, achieved: signed, signed };
      });
      return {
        teamId: t.id,
        teamName: t.name ?? t.id,
        taskPackageId: t.packageId ?? null,
        milestones: items,
        achievedCount: items.filter((i) => i.signed).length,
        milestoneCount: items.length,
      };
    });
    return applyVisibility({
      payload: { scope, rows, warnings, demo: true },
      viewer,
      visibilityConfig: rules.visibility,
      context: { scope, viewerTeamId: viewer?.teamId ?? null },
    });
  }

  // 个人榜：终生上榜
  if (scope === 'personal') {
    const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
    const ledger = [];
    for (const t of state.teams ?? []) {
      const pts = pointsByTeam.get(t.id) ?? 0;
      for (const uid of t.memberIds ?? []) {
        ledger.push({ userId: uid, kind: 'stage_rank', points: pts });
      }
    }
    const personal = computePersonalPoints({ ledger, pointsConfig: rules.points });
    const nameOf = (uid) => (state.users ?? []).find((u) => u.id === uid)?.name ?? null;
    const rows = personal.rows.map((r) => ({ ...r, name: nameOf(r.userId) }));
    return applyVisibility({
      payload: { scope, rows, warnings, demo: true },
      viewer,
      visibilityConfig: rules.visibility,
      context: { scope, viewerTeamId: viewer?.teamId ?? null },
    });
  }

  // A 榜（赛段名次）
  const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
  const packageRank = demoPackageRanks({ state, result, rules });
  const rows = result.ordered.map((row) => {
    const team = (state.teams ?? []).find((t) => t.id === row.teamId) ?? {};
    const tier = demoTier({ state, rules, teamId: row.teamId });
    return {
      teamId: row.teamId,
      teamName: team.name ?? row.teamId,
      taskPackageId: team.packageId ?? null,
      rank: row.rank,
      tiedWith: row.tiedWith ?? [],
      packageRank: packageRank.get(row.teamId) ?? null,
      points: pointsByTeam.get(row.teamId) ?? 0,
      total: row.total,
      tier: tier.tier,
      enterpriseName: null,   // ⛔ 企业名不公示（S10 §8）
    };
  });
  // 可见性在【这一层】过滤（与服务端同一套规则）：
  //   rank 榜全员公开但不含企业名与互评来源；business 榜不含评分与签字人。
  // ⚠️ 段位榜（scope='tier'）另走 applyVisibility 的 tier 分支：C 段及以上公示，D 段只给本人进度卡。
  return applyVisibility({
    payload: { scope, rows, warnings, demo: true },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope, viewerTeamId: viewer?.teamId ?? null },
  });
}

/** 包内名次（正式系统 src/services/leaderboard.js buildStageRanking 里同一口径：任务包内全量战队排名） */
function demoPackageRanks({ state, result, rules }) {
  const out = new Map();
  const pkgOf = new Map((state.teams ?? []).map((t) => [t.id, t.packageId ?? null]));
  const groups = new Map();
  for (const c of result.candidates ?? []) {
    const key = pkgOf.get(c.teamId) ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [, list] of groups) {
    const ranked = rankTeams({
      teams: list,
      tiebreakChain: rules.tiebreak.chain,
      tiebreakData: { isFinal: true, byTeam: {} },
      pointsConfig: rules.points,
    });
    for (const o of ranked.ordered) out.set(o.teamId, o.rank);
  }
  return out;
}

/**
 * 段位榜（C-02）：C 段及以上公示队名与名次；D 段只给本人进度卡。
 * ⚠️ 排序口径与 src/services/tier.js getTierBoard 一致：段位高 → 里程碑多 → 队伍编号（确定性兜底）。
 */
export function demoTierBoard({ state, rules, viewer = null }) {
  const order = (rules.ranks?.tiers ?? []).map((t) => t.key);
  const rows = (state.teams ?? []).map((t) => {
    const info = demoTier({ state, rules, teamId: t.id });
    return {
      teamId: t.id,
      teamName: t.name ?? t.id,
      tier: info.tier,
      tierRank: null,
      milestoneCount: info.milestoneCount,
      progress: {
        milestones: (rules.milestones?.items ?? []).map((def) => ({ key: def.key, label: def.label })),
        milestoneCount: info.milestoneCount,
      },
    };
  }).sort((a, b) => {
    const ia = order.indexOf(a.tier);
    const ib = order.indexOf(b.tier);
    if (ia !== ib) return ib - ia;                    // 段位高的在前
    if (a.milestoneCount !== b.milestoneCount) return b.milestoneCount - a.milestoneCount;
    return cmpStr(a.teamId, b.teamId);                // 确定性兜底（不用随机 id）
  });
  rows.forEach((r, i) => { r.tierRank = i + 1; });
  return applyVisibility({
    payload: { scope: 'tier', rows, warnings: [], demo: true },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope: 'tier', viewerTeamId: viewer?.teamId ?? null, tierOrder: order },
  });
}

/** 滚动总榜（全程公开） */
export function demoRollingLeaderboard({ state, rules, viewer = null }) {
  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (!result) return { scope: 'rolling', rows: [], warnings: [], demo: true, empty: true };
  const pointsByTeam = new Map((result.points ?? []).map((p) => [p.teamId, p.points]));
  const rankByTeam = new Map((result.ordered ?? []).map((r) => [r.teamId, r.rank]));
  const rows = (state.teams ?? []).map((t) => ({
    teamId: t.id,
    teamName: t.name ?? t.id,
    taskPackageId: t.packageId ?? null,
    points: pointsByTeam.get(t.id) ?? 0,
    stages: 1,
    bestRank: rankByTeam.get(t.id) ?? null,
    tier: demoTier({ state, rules, teamId: t.id }).tier,
  })).sort((a, b) => b.points - a.points
    || (a.bestRank ?? 99) - (b.bestRank ?? 99)
    || cmpStr(a.teamId, b.teamId));
  return applyVisibility({
    payload: { scope: 'rolling', rows, warnings: collectDemoWarnings(result), demo: true },
    viewer,
    visibilityConfig: rules.visibility,
    context: { scope: 'rolling', viewerTeamId: viewer?.teamId ?? null },
  });
}

export function demoPools({ state, rules, kind }) {
  const stageId = state.lastStageId ?? 'stage_final';
  const result = state.results?.[stageId];
  if (kind === 'projects') {
    const rows = (state.teams ?? []).map((t) => {
      const tier = demoTier({ state, rules, teamId: t.id });
      const rank = result?.ordered?.find((r) => r.teamId === t.id)?.rank ?? null;
      return {
        id: t.id,
        title: t.name,
        teamId: t.id,
        industry: (state.taskPackages ?? []).find((p) => p.id === t.packageId)?.title ?? null,
        stageReached: stageId,
        tier: tier.tier,
        businessValue: tier.businessSignoffCount > 0 ? '已获企业业务部门签字' : '推进中',
        summary: `段位 ${tier.tier}｜里程碑 ${tier.milestoneCount} 项`,
        rank,
      };
    });
    return { kind, rows, demo: true };
  }
  if (kind === 'talents') {
    // 个人积分 = 该队在本赛段拿到的名次积分之和（赛段积分本身由 computeStagePoints 算）
    const pointsByTeam = new Map((result?.points ?? []).map((p) => [p.teamId, p.points]));
    const totalByUser = new Map();
    for (const t of state.teams ?? []) {
      const pts = pointsByTeam.get(t.id) ?? 0;
      for (const uid of t.memberIds ?? []) {
        totalByUser.set(uid, (totalByUser.get(uid) ?? 0) + pts);
      }
    }
    const rows = (state.users ?? []).map((u) => {
      const teamIds = (state.teams ?? []).filter((t) => (t.memberIds ?? []).includes(u.id)).map((t) => t.id);
      return {
        id: u.id,
        name: u.name,
        org: '演示组委会',
        total_points: totalByUser.get(u.id) ?? 0,
        mba_status: u.mbaStatus,
        stages_joined: teamIds.length,
        skills: [],
      };
    });
    return { kind, rows, demo: true };
  }
  if (kind === 'resources') {
    const rows = (state.taskPackages ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      enterprise_id: p.enterpriseId,
      enterprise_name: p.enterpriseName,
      kind: p.isFreeBrief ? '自由命题' : '企业命题',
      detail: p.commitment ?? '无',
    }));
    return { kind, rows, demo: true };
  }
  return { kind, rows: [], demo: true };
}

// ── 组队（浏览器内的等价实现）──────────────────────────────────
// ⚠️ 服务层 src/services/team.js 的 checkTeamFormation 做 SQL 编排，不能进浏览器；
//    这里按 rules/team-formation.json 做等价的纯判定（口径一致，来源同一份配置）。
export function demoTeamFormation({ team, state, rules }) {
  const errors = [];
  const cfg = rules.teamFormation ?? {};
  const size = (team.memberIds ?? []).length;
  const min = cfg.teamSize?.min ?? 2;
  const max = cfg.teamSize?.max ?? 5;
  if (size < min) errors.push(`组队人数 ${size} 少于下限 ${min}`);
  if (size > max) errors.push(`组队人数 ${size} 超过上限 ${max}`);
  if (cfg.captainMustBeMba) {
    const captain = (state.users ?? []).find((u) => u.id === team.captainId);
    if (!captain) errors.push('组长不存在');
    else if (captain.mbaStatus !== 'mba') errors.push('组长必须是一堂 MBA 在籍（硬性门槛）');
  }
  const pkg = (state.taskPackages ?? []).find((p) => p.id === team.packageId);
  if (!pkg) errors.push('必须认领一个任务包（报名即认领）');
  return { ok: errors.length === 0, errors };
}

/** 默认组长：成员里第一位 MBA 在籍者（⛔ 不用登录用户 —— 演示登录用户不在 users 表里） */
function defaultCaptainId({ state, memberIds, me }) {
  const mba = (state.users ?? []).find(
    (u) => u.mbaStatus === 'mba' && (memberIds ?? []).includes(u.id),
  );
  return mba?.id ?? me?.id ?? null;
}

// ── API 层 ─────────────────────────────────────────────────────

function parseQuery(path) {
  const i = path.indexOf('?');
  if (i < 0) return { path, query: {} };
  const q = {};
  for (const [k, v] of new URLSearchParams(path.slice(i + 1))) q[k] = v;
  return { path: path.slice(0, i), query: q };
}

export function createDemoApi({ storage = defaultStorage(), seed = null, rules = null } = {}) {
  let state = null;

  const ensure = () => {
    if (state) return state;
    const raw = storage.getItem(STORAGE_KEY);
    state = raw ? JSON.parse(raw) : buildDemoState(seed);
    // ⛔ 旧结构/半截结构（浏览器里手工改过、或旧版本留下的）不能直接把适配器打挂 ——
    //    缺哪个容器补哪个容器。
    if (!state.computations || typeof state.computations !== 'object') state.computations = {};
    if (!state.results || typeof state.results !== 'object') state.results = {};
    if (!Array.isArray(state.registrations)) state.registrations = [];
    if (!state.reviews || typeof state.reviews !== 'object') state.reviews = {};
    return state;
  };
  const persist = () => storage.setItem(STORAGE_KEY, JSON.stringify(state));

  const dispatch = (method, path, body) => {
    const { path: clean, query } = parseQuery(path);
    const s = ensure();
    const r = rules;
    if (!r) throw httpError(500, 'RULES_MISSING', '演示版规则配置未加载');

    // 健康检查
    if (method === 'GET' && clean === '/api/health') {
      return { ok: true, demo: true, ruleVersion: r.tiebreak?.version ?? null };
    }
    // 当前用户
    if (method === 'GET' && clean === '/api/me') {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      return { user: s.me };
    }
    if (method === 'POST' && clean === '/api/auth/login') {
      s.me = {
        id: 'demo_admin',
        name: body?.name || '演示管理员',
        mbaStatus: 'mba',
        org: '演示组委会',
        teamId: (s.teams ?? [])[0]?.id ?? null,
      };
      persist();
      return { user: s.me };
    }
    if (method === 'POST' && clean === '/api/auth/logout') {
      s.me = null;
      persist();
      return { ok: true };
    }
    // 报名
    if (method === 'POST' && clean === '/api/registrations') {
      const answers = body?.answers ?? {};
      const errors = validateRegistrationAnswers(answers, r.registration);
      if (errors.length) throw httpError(400, 'INVALID_ANSWERS', errors.join('；'));
      const scored = scoreRegistration({ answers, config: r.registration });
      const level = classifyLevel(scored.score, r.registration);
      const reg = {
        id: `reg_demo_${s.registrations.length + 1}`,
        userId: s.me?.id ?? 'demo_user',
        editionId: s.edition?.id ?? 'ed_demo',
        answers,
        rawScore: scored.score,
        level,
        levelFinal: level,
        dimensionScores: scored.dimensionScores,
        explain: scored.explain,
        status: level === 'C' ? 'rejected' : 'accepted',
        createdAt: new Date().toISOString(),
      };
      s.registrations.push(reg);
      persist();
      return reg;
    }
    if (method === 'GET' && clean === '/api/registrations') {
      return { rows: s.registrations };
    }
    // 任务卡可解性评估（演示"六维准入 + 一票否决"）
    if (method === 'POST' && clean === '/api/task-packages/solvability') {
      const out = scoreSolvability({ answers: body?.answers ?? {}, config: r.solvability });
      return out;
    }
    // 组队
    if (method === 'POST' && clean === '/api/teams') {
      const memberIds = body?.memberIds ?? [];
      const team = {
        id: `team_demo_${(s.teams ?? []).length + 1}`,
        name: body?.name ?? '演示战队',
        packageId: body?.taskPackageId ?? null,
        captainId: body?.captainId ?? defaultCaptainId({ state: s, memberIds, me: s.me }),
        memberIds,
        tier: 'D',
        status: 'forming',
      };
      const formation = demoTeamFormation({ team, state: s, rules: r });
      if (!formation.ok) throw httpError(400, 'TEAM_FORMATION_INVALID', formation.errors.join('；'));
      s.teams.push(team);
      persist();
      return { ...team, formation };
    }
    let m = clean.match(/^\/api\/teams\/([^/]+)$/);
    if (method === 'GET' && m) {
      const team = (s.teams ?? []).find((t) => t.id === m[1]);
      if (!team) throw httpError(404, 'NOT_FOUND', '队伍不存在');
      return team;
    }
    m = clean.match(/^\/api\/teams\/([^/]+)\/performance-card$/);
    if (method === 'GET' && m) return demoPerformanceCard({ state: s, rules: r, teamId: m[1] });
    m = clean.match(/^\/api\/teams\/([^/]+)\/tier$/);
    if (method === 'GET' && m) return demoTier({ state: s, rules: r, teamId: m[1] });
    // 打分
    m = clean.match(/^\/api\/stages\/([^/]+)\/reviews$/);
    if (method === 'POST' && m) {
      const items = Array.isArray(body?.items) ? body.items : [];
      for (const it of items) {
        const judgeId = it.judgeId;
        if (!s.reviews[judgeId]) s.reviews[judgeId] = {};
        if (!s.reviews[judgeId][it.teamId]) s.reviews[judgeId][it.teamId] = {};
        s.reviews[judgeId][it.teamId][it.dimension] = Number(it.rawScore);
      }
      persist();
      return { submitted: items.length, stageId: m[1] };
    }
    m = clean.match(/^\/api\/stages\/([^/]+)\/review-state$/);
    if (method === 'GET' && m) {
      const subs = expandSubmissions(s);
      const byJudge = new Map();
      for (const sub of subs) byJudge.set(sub.judgeId, (byJudge.get(sub.judgeId) ?? 0) + 1);
      return {
        stageId: m[1],
        submitted: subs.length,
        dimensionProgress: Object.fromEntries(byJudge),
        judges: (s.judges ?? []).map((j) => ({ judgeId: j.id, submitted: byJudge.get(j.id) ?? 0 })),
      };
    }
    // 计算
    m = clean.match(/^\/api\/stages\/([^/]+)\/compute$/);
    if (method === 'POST' && m) {
      const out = runDemoCompute({ state: s, rules: r, stageId: m[1], now: new Date().toISOString() });
      s.lastStageId = m[1];
      persist();
      return out;
    }
    m = clean.match(/^\/api\/stages\/([^/]+)\/computations\/([^/]+)$/);
    if (method === 'GET' && m) {
      const c = s.computations?.[m[2]];
      if (!c) throw httpError(404, 'NOT_FOUND', '计算快照不存在');
      return c;
    }
    // 榜单
    // ⚠️ 顺序要紧：静态段 'tier' / 'rolling' 必须排在 '/api/leaderboard/:stageId' 之前，
    //    否则段位榜会拿到赛段榜的形状（前端渲染成空段位列）。
    //    这与后端 src/server.js 的路由口径一致（静态段优先于参数段），也与 P0 桩一致。
    if (method === 'GET' && clean === '/api/leaderboard/rolling') {
      return demoLeaderboard({ state: s, rules: r, scope: 'rolling', viewer: s.me });
    }
    if (method === 'GET' && clean === '/api/leaderboard/tier') {
      return demoLeaderboard({ state: s, rules: r, scope: 'tier', viewer: s.me });
    }
    m = clean.match(/^\/api\/leaderboard\/([^/]+)$/);
    if (method === 'GET' && m) {
      const scope = query.scope || 'rank';
      return demoLeaderboard({ state: s, rules: r, scope, viewer: s.me });
    }
    // 三池
    m = clean.match(/^\/api\/pools\/(projects|talents|resources)$/);
    if (method === 'GET' && m) return demoPools({ state: s, rules: r, kind: m[1] });
    // 公开 API（无需登录）
    if (method === 'GET' && clean === '/api/public/leaderboard') {
      if (!query.token) throw httpError(401, 'UNAUTHENTICATED', '缺少公开访问令牌');
      return demoLeaderboard({ state: s, rules: r, scope: 'rank', viewer: null });
    }
    throw httpError(404, 'NOT_FOUND', `演示版未实现该接口：${method} ${clean}`);
  };

  return {
    async get(path) { return dispatch('GET', path, null); },
    async post(path, body) { return dispatch('POST', path, body ?? {}); },
    async patch(path, body) { return dispatch('PATCH', path, body ?? {}); },
    async del(path) { return dispatch('DELETE', path, null); },
    subscribe() { return () => {}; },
    _state: ensure,
    _persist: persist,
  };
}

// ── 浏览器入口 ─────────────────────────────────────────────────

export async function loadDemoSeed(url = SEED_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`演示种子数据加载失败：${url}（HTTP ${res.status}）`);
  return res.json();
}

export async function loadDemoRules(base = RULES_BASE) {
  const loaded = {};
  const missing = [];
  for (const [key, file] of Object.entries(DEMO_RULE_FILES)) {
    const res = await fetch(base + file);
    if (!res.ok) {
      missing.push(`${file}（HTTP ${res.status}）`);
      continue;
    }
    loaded[key] = await res.json();
  }
  if (missing.length) {
    throw new Error(
      `演示规则配置缺失：${missing.join('、')}。请先执行 node scripts/build-demo.js 生成静态站。`,
    );
  }
  return {
    scoring: { initial: loaded.scoringInitial, final: loaded.scoringFinal },
    tiebreak: loaded.tiebreak,
    ranks: loaded.ranks,
    behavior: loaded.behavior,
    visibility: loaded.visibility,
    registration: loaded.registration,
    solvability: loaded.solvability,
    milestones: loaded.milestones,
    teamFormation: loaded.teamFormation,
    points: loaded.points,
    criteria: loaded.criteria,
  };
}

let runtimePromise = null;

export function getDemoRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [seed, rules] = await Promise.all([loadDemoSeed(), loadDemoRules()]);
      return createDemoApi({ seed, rules });
    })();
  }
  return runtimePromise;
}

/** 与 web/api.js 同名的默认导出：视图代码完全复用 */
export const api = {
  async get(path) { return (await getDemoRuntime()).get(path); },
  async post(path, body) { return (await getDemoRuntime()).post(path, body); },
  async patch(path, body) { return (await getDemoRuntime()).patch(path, body); },
  async del(path) { return (await getDemoRuntime()).del(path); },
  subscribe() { return () => {}; },
};

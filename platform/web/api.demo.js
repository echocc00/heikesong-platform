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
import { scoreSolvability, checkTaskMix } from '../src/domain/solvability.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';
import { detectSelfEvalDiff } from '../src/domain/self-eval.js';
import { rankTeams } from '../src/domain/ranking.js';
import { computeStagePoints, computePersonalPoints } from '../src/domain/points.js';
import { computeTier, classifyDepartment, isDataOrPrototypeMilestone } from '../src/domain/tier.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { applyVisibility } from '../src/domain/visibility.js';
import { buildEventInfo } from '../src/domain/event-info.js';

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
  // ⚠️ P7 新增：报名页要显示 IP 归属 / 合规红线 / 同意条款
  //    （src/http/routes/registration.js 的 buildCriteria 从 rules.compliance 取）。
  //    缺它 ⇒ 演示站的报名页缺三块**明示内容**（R-ENT-11 / R-ENT-12 / 同意条款）。
  compliance: 'compliance.json',
  // ⚠️ P9 新增：**赛段表**（赛程、交付物、晋级率）—— 落地页的赛程脊就靠它。
  //    缺它 ⇒ 演示站的落地页**赛程是空的**（spine 没有任何节点），
  //    而正式平台读的是服务端 loadRules（那份加载全部 17 份规则）⇒ 两边不一致。
  schedule: 'schedule.json',
};

export function createMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// ⚠️ 任务卡状态机（与正式站 src/services/taskPackage.js 的 ASSESSABLE / APPROVABLE 同值）。
//    「可评估」= 已提交 / 已评估 / 已退回；「可签级」= 已评估 / 已退回。
const DEMO_ASSESSABLE = new Set(['submitted', 'assessed', 'returned']);
const DEMO_APPROVABLE = new Set(['assessed', 'returned']);

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
    // ⚠️ P10 评委前置：回避台账与校准分（演示站原先**没有**这两个容器）。
    //    正式站对应：recusal_records / calibrations 两张表。
    recusals: deepCopy(seed?.recusals) ?? [],
    calibrations: deepCopy(seed?.calibrations) ?? [],
    milestones: deepCopy(seed?.milestones) ?? [],
    signoffs: deepCopy(seed?.signoffs) ?? [],
    behaviorEvents: deepCopy(seed?.behaviorEvents) ?? [],
    registrations: [],
    // ⚠️ P7：工作流与任务清单（此前演示适配器**完全没有**工作流/任务端点
    //    ⇒ 任务清单页在公网演示站是 404，导航里放这个入口就是放一个死链）。
    workflows: deepCopy(seed?.workflows) ?? [],
    workflowTasks: deepCopy(seed?.workflowTasks) ?? [],
    // ⚠️ P7：复核队列（此前演示适配器没有 /api/audit/* ⇒ 两页 404）
    flags: deepCopy(seed?.flags) ?? [],
    // ⚠️ DP-106：申诉队列（选手提交 + 组委会裁决）。
    //    此前演示适配器**完全没有** /api/appeals ⇒ 公网演示站的「申诉裁决」页是错误态，
    //    而选手侧的报名结果页也提交不了申诉（404）。
    appeals: deepCopy(seed?.appeals) ?? [],
    // ⚠️ results / computations / lastStageId **透传种子里的预计算结果**：
    //    演示站的种子由**构建期**跑一次真实引擎生成（build-demo.js），
    //    目的就是让访客打开就能看到榜单（否则 results 永远空 ⇒ 榜单页「暂无数据」）。
    //    ⛔ 之前这里硬编码 `{}` / `null` ⇒ 把种子里的预计算结果**全丢了**（预计算白做）。
    //    ⚠️ 字段名保持与 runDemoCompute 写入的一致（stageId → result 的映射）。
    computations: deepCopy(seed?.computations) ?? {},
    results: deepCopy(seed?.results) ?? {},
    lastStageId: deepCopy(seed?.lastStageId) ?? null,
    me: null,
  };
}

/**
 * 演示站的复核队列（纯函数）。
 * ⚠️ 数据来源：计算快照里的**自评差异标记**（selfEvalFlags）——
 *    与演示站降级告警用的是同一批判定 ⇒ 队列与告警**说的是同一件事**。
 *    形状与真实后端 `GET /api/audit/flags` 一致：{ id, kind, status, stageId, teamId, judgeId, detail }。
 */
export function demoFlags(state) {
  if (!Array.isArray(state?.flags)) state.flags = [];
  if (state.flags.length) return state.flags;
  const comps = Object.values(state?.computations ?? {});
  for (const c of comps) {
    for (const f of c.selfEvalFlags ?? []) {
      state.flags.push({
        id: `flag_demo_${state.flags.length + 1}`,
        kind: 'self_eval_difference',
        status: 'open',
        stageId: c.stageId,
        teamId: f.teamId,
        judgeId: null,
        detail: { dimension: f.dimension, difference: f.d, action: f.action },
        reason: null,
        evidence: [],
        createdAt: c.computedAt,
      });
    }
  }
  return state.flags;
}

/**
 * 演示站的申诉行投影（**唯一的一份形状**）。
 *
 * ⚠️ P9 教训：演示站与正式站的形状必须**逐字一致**，不能各写一份 ——
 *    这里对齐的是正式后端 `src/services/review-state.js` 的 `listAppeals`
 *    （GET /api/appeals 的 { rows, total } 里的每一行）。
 *    列表 / 单条（POST 提交后返回）/ 裁决结果三处**共用这一个函数**，
 *    ⇒ 演示站内部不可能出现「列表一种形状、单条另一种形状」。
 *
 * ⚠️ 与正式站的**唯一**差别（有意为之，写在这里备查）：
 *    正式站的 `decideAppeal` 返回的 `appeal` 是**数据库原始行**（snake_case：
 *    subject_type / decided_by / decision_note），
 *    而演示站返回的是这个 camelCase 投影。
 *    ⇒ 前端两种拼写都读（web/views/admin-appeals.js：`out?.appeal?.decision_note ?? out?.appeal?.decisionNote`），
 *    页面表现完全一致；演示站内部状态统一用 camelCase（与 registrations / flags 一致）。
 */
export function demoAppealView(a) {
  return {
    id: a?.id ?? null,
    subjectType: a?.subjectType ?? null,
    subjectId: a?.subjectId ?? null,
    filedBy: a?.filedBy ?? null,
    reason: a?.reason ?? null,
    status: a?.status ?? null,
    decidedBy: a?.decidedBy ?? null,
    decidedAt: a?.decidedAt ?? null,
    decisionNote: a?.decisionNote ?? null,
    createdAt: a?.createdAt ?? null,
  };
}

/**
 * 演示站的战队视图（纯函数）。
 * ⚠️ 形状必须与真实后端 `src/services/team.js` 的 teamView() **一致** ——
 *    演示站的种子用 `memberIds`（用户 id 数组），
 *    而后端返回 `members: [{id, userId, role, joinedAt}]` ⇒ 不转换的话
 *    前端的「成员列表」「谁是组长」「能不能退出」三处全拿不到数据。
 */
export function demoTeamView(team, state) {
  const memberIds = team?.memberIds ?? [];
  const captainId = team?.captainId ?? memberIds[0] ?? null;
  const members = memberIds.map((uid, i) => ({
    id: `${team.id}_m${i + 1}`,
    userId: uid,
    role: uid === captainId ? 'captain' : 'member',
    joinedAt: null,
  }));
  return {
    id: team?.id ?? '',
    editionId: state?.edition?.id ?? 'ed_demo',
    name: team?.name ?? '',
    captainId,
    taskPackageId: team?.packageId ?? null,
    tier: team?.tier ?? 'D',
    status: team?.status ?? 'forming',
    members,
    memberCount: members.length,
    history: [],
    needsMerge: team?.status === 'needs_merge',
    mergeDeadline: team?.mergeDeadline ?? null,
    milestones: team?.milestones ?? { items: [] },
    formation: team?.formation ?? { ok: true, errors: [] },
  };
}

/**
 * 演示站的「我参与的队伍」（**纯函数**）。
 *
 * ⚠️ **必须与正式站同口径**（src/services/team.js 的 `listMyTeams`）：
 *    正式站 = 「我是队长」**或**「我在册成员」的队伍。
 *    ⛔ 演示站原先 `GET /api/teams` 返回**全部**队伍 ⇒
 *       ① 「我的战队」页列出别支队的内部信息；
 *       ② **互评页的目标列表会把别支队也列出来**（前端用 `GET /api/teams`
 *          算「我参与哪些队」，返回全部 ⇒ 发起队 = 全部 ⇒ 被评队 = 空）。
 *    ⇒ P9 教训：**形状与数值都要对齐**，不能只对齐形状。
 *
 * ⚠️ **队长也算参与**（与正式站同口径）：建队只写 `captainId`，
 *    不一定有 `memberIds` 条目 ⇒ 只查 memberIds 会把队长漏掉。
 *
 * ⚠️ 演示站只有**一个**账号（`demo_admin`，委员会身份），
 *    它在种子的 `memberIds` 里**没有位置** ⇒ 额外认 `me.teamId`
 *    （登录时写入的「我的那一支队」）—— 这是演示站对「我在队里」的等价表达。
 */
export function demoMyTeams(state) {
  const me = state?.me ?? null;
  if (!me) return [];
  const meId = me.id ?? null;
  const myTeamId = me.teamId ?? null;
  return (state?.teams ?? []).filter((t) => (
    (meId && t.captainId === meId)
    || (meId && (t.memberIds ?? []).includes(meId))
    || (myTeamId && t.id === myTeamId)
  ));
}

/**
 * 演示站的**评委席维度白名单**（与正式站 `assertJudgeDimensions` 同口径）。
 *
 * ⚠️ 正式站（src/http/routes/review.js）的口径必须**逐字同码**：
 *   未知维度 → **400 UNKNOWN_DIMENSION**；非评委席维度 → **403 DIMENSION_SEAT_FORBIDDEN**。
 *   校准入口与打分入口用**同一个**函数（正式站已这样接线，P10 补齐）⇒ 演示站同理。
 * @param {string} dimension 维度键
 * @param {object} rules    演示规则（rules.scoring.final / .initial）
 * @returns {object} 该维度
 */
export function demoAssertJudgeDimension(dimension, rules) {
  const config = rules?.scoring?.final ?? rules?.scoring?.initial ?? {};
  const dims = config.dimensions ?? [];
  const dim = dims.find((d) => d.key === dimension);
  if (!dim) throw httpError(400, 'UNKNOWN_DIMENSION', `未知评分维度：${dimension}`);
  if (dim.seat !== 'judge') {
    throw httpError(403, 'DIMENSION_SEAT_FORBIDDEN', `维度 ${dimension} 不属于评委席，不能由评委打分`);
  }
  return dim;
}

/** 演示站的分值校验（与正式站 `assertScoreInRange` 同码：400 SCORE_OUT_OF_RANGE）。 */
export function demoAssertScore(rawScore, label) {
  const n = Number(rawScore);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw httpError(400, 'SCORE_OUT_OF_RANGE', `${label}必须是 0–100 之间的数字`);
  }
  return n;
}

/**
 * 演示站的回避记录投影（**唯一的一份形状**）。
 *
 * ⚠️ 形状必须与正式后端 `getRecusalLedger`（src/services/review.js）**逐字一致**：
 *    正式站内部存的是**数据库原始行**（snake_case），对外投影成 camelCase。
 *    演示站照抄这个「原始行 → 投影」两步 ⇒ 演示站不可能出现第二种拼写。
 */
export function demoRecusalView(r, state) {
  const team = (state?.teams ?? []).find((t) => t.id === r?.team_id) ?? null;
  const user = (state?.users ?? []).find((u) => u.id === r?.judge_id) ?? null;
  const isMe = state?.me?.id && r?.judge_id === state.me.id;
  return {
    id: r?.id ?? null,
    stageId: r?.stage_id ?? null,
    judgeId: r?.judge_id ?? null,
    judgeName: user?.name ?? (isMe ? (state?.me?.name ?? null) : null),
    teamId: r?.team_id ?? null,
    teamName: team?.name ?? null,
    reason: r?.reason ?? null,
    source: r?.source ?? null,
    auditBy: r?.audit_by ?? null,
    createdAt: r?.declared_at ?? null,
    status: r?.action ?? null,
  };
}

/**
 * 演示站的任务包视图（纯函数）。
 * ⚠️ 形状与 `src/services/taskPackage.js` 的 presentTaskPackage() 一致。
 */
export function demoTaskPackageView(p, state) {
  return {
    id: p?.id ?? '',
    editionId: state?.edition?.id ?? 'ed_demo',
    enterpriseId: p?.enterpriseId ?? null,
    enterpriseName: p?.enterpriseName ?? '',
    title: p?.title ?? '',
    painPoint: p?.painPoint ?? '',
    expectedDelivery: p?.expectedDelivery ?? '',
    acceptanceCriteria: p?.acceptanceCriteria ?? '',
    grade: p?.grade ?? null,
    status: p?.status ?? 'published',
    solvabilityScore: p?.solvabilityScore ?? null,
    solvabilityGrade: p?.solvabilityGrade ?? p?.grade ?? null,
    commitment: p?.commitment ?? '',
    agreement: p?.agreement ?? '',
    isFreeBrief: p?.isFreeBrief === true,
    submittedBy: p?.submittedBy ?? null,
    submittedAt: p?.submittedAt ?? null,
    approvedBy: p?.approvedBy ?? null,
    approvedAt: p?.approvedAt ?? null,
  };
}

/**
 * 演示站的工作流 / 任务清单。
 *
 * ⚠️ 为什么需要「合成」而不是原样拷贝种子：
 *    种子（web/seed/demo-data.json）里**没有**工作流与任务 ——
 *    演示数据聚焦在「赛段评审 → 榜单 → 段位」这条主链上。
 *    但前端的任务清单页需要一条可达路径（导航里就有入口），
 *    ⇒ 这里按种子里的**任务包**合成一条演示工作流：
 *      每张任务包 = 一个可自主领取的任务（题目取任务包标题，细节取企业承诺）。
 *    ⛔ 合成只在**内存里**做（不写回种子文件），且只在 seed 没有工作流时兜底。
 * ⚠️ **只合成已发布的卡**：未发布的卡（待评估 / 待签级）还没进任务池，
 *    不该是可领取的任务（真实站是发布后才进池）⇒ 演示任务清单的条数 =
 *    已发布卡数。
 */
export function ensureDemoWorkflows(state) {
  if (!state) return state;
  if (!Array.isArray(state.workflows)) state.workflows = [];
  if (!Array.isArray(state.workflowTasks)) state.workflowTasks = [];
  if (state.workflows.length) return state;
  const packages = (state.taskPackages ?? []).filter((p) => p && p.status === 'published');
  const workflowId = 'wf_demo_1';
  state.workflows.push({
    id: workflowId,
    editionId: state.edition?.id ?? 'ed_demo',
    taskPackageId: packages[0]?.id ?? null,
    name: '演示任务清单',
    createdAt: state.meta?.id ?? 'demo',
  });
  packages.forEach((p, i) => {
    state.workflowTasks.push({
      id: `wt_demo_${i + 1}`,
      workflowId,
      title: p.title ?? `演示任务 ${i + 1}`,
      detail: p.commitment ?? p.enterpriseName ?? '完成该任务包的可运行版本',
      status: 'todo',
      claim: null,
    });
  });
  return state;
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

/**
 * 评审工作台（演示版）。
 *
 * ⚠️ **形状必须与真实后端 `GET /api/stages/:stageId/review-board` 逐字段一致**
 *    （src/services/review.js 的 getReviewBoard）——
 *    同一份前端在演示站与正式站必须表现一致，否则「演示」就失去意义。
 *
 * ⚠️ 演示站只有一个赛段（stage_final）⇒ 维度取 `rules.scoring.final`。
 *    ⚠️ 演示管理员是**组委会**身份 ⇒ progress.scope = 'stage'（全赛段口径）。
 */
export function demoReviewBoard({ state, rules, stageId = 'stage_final' }) {
  const stageName = stageId === state.lastStageId ? '决赛赛段' : `赛段 ${stageId}`;
  const config = rules?.scoring?.final ?? rules?.scoring?.initial ?? {};
  const dimensions = (config.dimensions ?? []).map((d) => ({
    key: d.key, name: d.name, weight: d.weight, seat: d.seat,
  }));
  const judgeDimensions = dimensions.filter((d) => d.seat === 'judge');
  const pkgById = new Map((state.taskPackages ?? []).map((p) => [p.id, p]));
  const teams = (state.teams ?? []).map((t) => {
    const pkg = pkgById.get(t.packageId) ?? {};
    return {
      id: t.id,
      name: t.name,
      taskPackageId: t.packageId ?? null,
      taskPackageTitle: pkg.title ?? null,
      isFreeBrief: pkg.isFreeBrief === true,
    };
  });
  const meId = state.me?.id ?? null;
  const mine = (meId && state.reviews?.[meId]) || {};
  const myScores = [];
  for (const [teamId, byDim] of Object.entries(mine)) {
    for (const [dimension, rawScore] of Object.entries(byDim ?? {})) {
      myScores.push({ teamId, dimension, rawScore: Number(rawScore) });
    }
  }
  // ⚠️ **P10 评委前置**：三个「我已经交过哪些」——
  //    形状与正式站 `getReviewBoard`（src/services/review.js）**逐字一致**：
  //      myPeerReviews  [{ fromTeamId, toTeamId, score }]
  //      mySelfReviews  [{ teamId, dimension, rawScore }]
  //      myCalibrations [{ dimension, rawScore }]
  //    ⛔ **只含当前 viewer 自己的**（同 myScores 口径；组委会也只看自己的）。
  //    ⚠️ 三个「我的」含义各不相同（与各自的写入口对齐）：
  //      互评是「队 → 队」⇒ 我的 = **我参与的那些队**发起的互评；
  //      自评是**队伍**行为（R-JDG-13 不加分）⇒ 我的 = **我参与的队**的自评；
  //      校准是**评委个人**行为（R-JDG-12）⇒ 我的 = judgeId = 自己。
  const myTeamIds = new Set(demoMyTeams(state).map((t) => t.id));
  const myPeerReviews = (state.peerReviews ?? [])
    .filter((p) => myTeamIds.has(p.fromTeamId))
    .map((p) => ({ fromTeamId: p.fromTeamId, toTeamId: p.toTeamId, score: Number(p.score) }));
  const mySelfReviews = (state.selfReviews ?? [])
    .filter((r) => myTeamIds.has(r.teamId))
    .map((r) => ({ teamId: r.teamId, dimension: r.dimension, rawScore: Number(r.rawScore) }));
  const myCalibrations = (state.calibrations ?? [])
    .filter((c) => meId && c.judgeId === meId)
    .map((c) => ({ dimension: c.dimension, rawScore: Number(c.rawScore) }));
  const subs = expandSubmissions(state);
  const dimKeys = judgeDimensions.map((d) => d.key);
  // ⛔ P9.1 修正：与真实后端 `getReviewState`（组委会口径）**同口径** ——
  //    应交格数 = **有投票权的席位数** × 队伍数 × 维度数。
  //    原来漏乘评委数 ⇒ 演示站显示的「应交 N 格 / 完成度 %」只有正式站的 1/N
  //    （演示种子有 6 名评委，正式站是按**本赛段实际派出的席位**算）。
  //    ⛔ 这一条 P8 的 parity 闸抓不到：它只比**形状**，不比数值（形状对、数值漂移，
  //    正是 P8 复盘写下的「演示适配器把错误形状锁进测试」同款陷阱的数值版）。
  //    ⛔ 席型词表也必须与真实后端一致（judge | enterprise | observer）——
  //    种子原来写的是 'expert' ⇒ 真实引擎的 `checkJudgePool` 认不出来
  //    （knownSeats = votingSeats + nonVotingSeats = {judge, enterprise, observer}）
  //    ⇒ 演示站每次计算都会多出一条 `judge_pool_invalid` 告警，正式站不会有。
  const votingJudges = (state.judges ?? []).filter((j) => (j.seat ?? 'judge') !== 'observer');
  const seatCount = votingJudges.length;
  const total = seatCount * teams.length * dimKeys.length;
  const submitted = subs.filter((x) => dimKeys.includes(x.dimension)).length;
  const dimensionProgress = {};
  for (const d of dimKeys) {
    dimensionProgress[d] = {
      submitted: subs.filter((x) => x.dimension === d).length,
      total: seatCount * teams.length,
    };
  }
  const missing = [];
  for (const j of votingJudges) {
    for (const t of teams) {
      for (const d of dimKeys) {
        const hit = subs.some((x) => x.judgeId === j.id && x.teamId === t.id && x.dimension === d);
        if (!hit) missing.push({ judgeId: j.id, teamId: t.id, dimension: d });
      }
    }
  }
  return {
    stage: {
      id: stageId,
      key: stageId,
      name: stageName,
      kind: 'final',
      status: 'computed',
      scoringConfigKey: 'final',
    },
    dimensions,
    judgeDimensions,
    teams,
    myScores,
    // ⚠️ P10 评委前置：三个「我已经交过哪些」——只含当前 viewer 自己的。
    myPeerReviews,
    mySelfReviews,
    myCalibrations,
    progress: { scope: 'stage', submitted, total, missing, dimensionProgress },
  };
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
  const judges = (state.judges ?? []).map((j) => ({ judgeId: j.id, seat: j.seat ?? 'judge' }));
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

/**
 * 演示站的「审计权限」判定（DP-107 同口径）。
 *
 * ⛔ 告警的内部明细（`detail` / 队伍 id / 英文维度键）只给有 `audit:read` 的人看。
 *    真实后端的能力点判定走 `can(viewer, 'audit:read', null, db)`（读 role_capabilities 表）；
 *    演示站没有数据库 ⇒ 用角色键判定。
 *
 * ⚠️ 角色 → 能力点的矩阵在真实系统里是**数据**（role_capabilities 表，种子见
 *    scripts/seed.js 的 ROLE_CAPABILITIES），那里 `audit:read` **只有 admin 持有**。
 *    演示站也只有一个身份（demo_admin / roles=['admin']）⇒ 口径与真实系统一致。
 *    ⚠️ 若日后演示站新增角色，必须同步核对 scripts/seed.js 的 ROLE_CAPABILITIES，
 *       否则这里会与真实系统漂（fail-closed：认不准就当没有审计权限）。
 */
function demoCanAudit(viewer) {
  const roles = Array.isArray(viewer?.roles) ? viewer.roles : [];
  return roles.includes('admin');
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
      context: { scope, viewerTeamId: viewer?.teamId ?? null, canAudit: demoCanAudit(viewer) },
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
      context: { scope, viewerTeamId: viewer?.teamId ?? null, canAudit: demoCanAudit(viewer) },
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
    context: { scope, viewerTeamId: viewer?.teamId ?? null, canAudit: demoCanAudit(viewer) },
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
    context: { scope: 'tier', viewerTeamId: viewer?.teamId ?? null, tierOrder: order, canAudit: demoCanAudit(viewer) },
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
    context: { scope: 'rolling', viewerTeamId: viewer?.teamId ?? null, canAudit: demoCanAudit(viewer) },
  });
}

// ── P10 · W4-b：企业签字台（里程碑签字 + 企业双签）─────────────────────────
//
// ⚠️ **形状必须与真实后端逐字段一致**（同一份前端在演示站与正式站必须表现一致）：
//    GET  /api/signoffs/mine                            ← src/services/signoff-board.js getSignoffWorklist
//    GET  /api/stages/:stageId/enterprise-confirmations ← getEnterpriseConfirmationBoard
//    POST /api/milestones/:id/signoff                   ← src/services/milestone.js createSignoff
//    POST /api/milestones/:id/signoff/withdraw          ← src/services/milestone.js withdrawSignoff
//    POST /api/stages/:stageId/enterprise-confirmations  ← src/http/routes/review.js
//
// ⛔ 此前演示适配器**一个都没有实现** ⇒ 公网演示站的「企业签字台」页是两块错误卡片
//    （两个读口都落到 DEMO_ENDPOINT_MISSING）⇒ 导航里放这个入口就是放一个死链。
//
// ⚠️ 里程碑槽位口径：**每支队的每个 rules.milestones.items 都算一个槽位**
//    （真实站建队时就是全量插入，见 src/services/team.js 的 insertMilestones）⇒
//    清单条数与真实站同口径。
// ⚠️ 演示站只有一个身份（演示组委会）⇒ 种子里的签字没有记录签字人时，
//    视为「本账号所签」（否则页面上的「撤回」永远不可点 = 只做展示）。

/** 里程碑 id（确定性：队伍 id + 里程碑 key ⇒ 刷新后不变，可当 URL 段用） */
function demoMilestoneId(teamId, key) {
  return `ms_${teamId}_${key}`;
}

/** 由里程碑 id 反查 (teamId, key) —— 遍历而不是拆字符串（队伍 id 本身带下划线）。 */
function demoFindMilestone(state, rules, milestoneId) {
  const items = rules?.milestones?.items ?? [];
  for (const t of state?.teams ?? []) {
    for (const def of items) {
      if (demoMilestoneId(t.id, def.key) === milestoneId) {
        return { teamId: t.id, key: def.key, label: def.label ?? def.key };
      }
    }
  }
  return null;
}

/** 签字数组（补上稳定的 id —— 种子里的签字没有 id，写入的签字有） */
function demoSignoffRows(state) {
  return (state.signoffs ?? []).map((s, i) => ({
    ...s,
    id: s.id ?? `so_${i + 1}`,
    content: s.content ?? '',
    signedAt: s.signedAt ?? null,
    enterpriseId: s.enterpriseId ?? null,
  }));
}

/**
 * 某里程碑上的**有效签字**（最新一条未被撤回的）。
 * ⚠️ 与真实站同口径（src/db/repo/signoff-board.js 的 ROW_NUMBER()）：
 *    先按「未撤回优先」，再按时间取最新 ⇒ 全部被撤回时返回那条被撤回的。
 */
function demoEffectiveSignoff(state, teamId, key) {
  const list = demoSignoffRows(state).filter((s) => s.teamId === teamId && s.milestoneKey === key);
  if (!list.length) return null;
  const alive = list.filter((s) => !s.revokedAt);
  return alive.length ? alive[alive.length - 1] : list[list.length - 1];
}

/** 里程碑签字台（"我要签的东西"）—— 与 getSignoffWorklist 同形状。 */
export function demoSignoffWorklist({ state, rules, viewer = null }) {
  const items = rules?.milestones?.items ?? [];
  const out = [];
  for (const t of state.teams ?? []) {
    for (const def of items) {
      const milestoneId = demoMilestoneId(t.id, def.key);
      const so = demoEffectiveSignoff(state, t.id, def.key);
      const signed = Boolean(so) && !so.revokedAt;
      // ⛔ **不返回签字人姓名**（R-ENT-04「签字不公开」）：只回签字内容 + 「是不是我签的」。
      const signedByMe = Boolean(so) && (so.enterpriseId == null || so.enterpriseId === viewer?.id);
      out.push({
        milestoneId,
        teamId: t.id,
        teamName: t.name ?? t.id,
        key: def.key,
        label: def.label ?? def.key,
        countsTowardTier: def.countsTowardTier === true,
        signed,
        signoffId: so?.id ?? null,
        signedAt: so?.signedAt ?? null,
        department: so?.department ?? null,
        content: so?.content ?? null,
        revokedAt: so?.revokedAt ?? null,
        signedByMe,
        canWithdraw: signed && signedByMe,
      });
    }
  }
  // ⚠️ 确定性排序：队伍顺序（种子顺序）→ 里程碑在 rules 里的固定顺序。
  return { scope: 'committee', items: out };
}

/** 企业双签待签清单（某赛段）—— 与 getEnterpriseConfirmationBoard 同形状。 */
export function demoEnterpriseConfirmationBoard({ state, rules, stageId = 'stage_final', viewer = null }) {
  const config = rules?.scoring?.final ?? rules?.scoring?.initial ?? {};
  const dims = (config.dimensions ?? [])
    .filter((d) => d.seat === 'enterprise')
    .map((d) => ({ key: d.key, name: d.name, weight: d.weight, seat: d.seat }));
  const pkgById = new Map((state.taskPackages ?? []).map((p) => [p.id, p]));
  const teams = (state.teams ?? []).map((t) => {
    const pkg = pkgById.get(t.packageId) ?? {};
    return {
      teamId: t.id,
      teamName: t.name ?? t.id,
      taskPackageTitle: pkg.title ?? null,
      enterpriseId: pkg.enterpriseId ?? null,
      isFreeBrief: pkg.isFreeBrief === true,
      canSign: true,
    };
  });
  const confirmations = (state.enterpriseConfirmations ?? []).map((c) => ({
    id: c.id,
    teamId: c.teamId,
    enterpriseId: c.enterpriseId,
    dimension: c.dimension,
    rawScore: c.rawScore,
    hasCrossJudge: Boolean(c.crossJudgeId),
    signedAt: c.signedAt ?? null,
    content: c.content ?? '',
  }));
  // 跨领域评委候选（⛔ 排除「我」—— 后端会拒绝 crossJudgeId === 出题企业签字人）。
  const crossJudgeCandidates = (state.judges ?? [])
    .filter((j) => (j.seat ?? 'judge') === 'judge')
    .filter((j) => !viewer || j.id !== viewer.id)
    .map((j) => ({ userId: j.id, name: j.name ?? j.id, seat: j.seat ?? 'judge' }));
  return {
    stage: {
      id: stageId,
      key: stageId,
      name: stageId === state.lastStageId ? '决赛赛段' : `赛段 ${stageId}`,
      kind: 'final',
      status: 'computed',
    },
    scope: 'committee',
    myEnterpriseId: viewer?.id ?? null,
    dimensions: dims,
    teams,
    confirmations,
    crossJudgeCandidates,
  };
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
    // ⚠️ 工作流/任务清单兜底（老版 localStorage 里没有这两个容器）
    ensureDemoWorkflows(state);
    // ⚠️ 复核队列容器兜底（老版 localStorage 里没有）
    if (!Array.isArray(state.flags)) state.flags = [];
    // ⚠️ 申诉队列容器兜底（老版 localStorage 里没有）
    if (!Array.isArray(state.appeals)) state.appeals = [];
    // ⚠️ **localStorage 里的旧 state 不带 results**（旧版演示站访问时留下的）⇒
    //    榜单会是空的（访客明明是第一次看到新版演示站，却看到「暂无数据」）。
    // ⇒ 补齐：**只补缺失的计算结果**，不覆盖访客自己的操作数据（报名/评审等）。
    //    判据：localStorage 的 results 里**没有任何赛段** ⇒ 视为「旧版遗留」⇒ 从种子补。
    if (Object.keys(state.results).length === 0 && seed?.results) {
      state.results = deepCopy(seed.results) ?? {};
      state.computations = { ...(deepCopy(seed?.computations) ?? {}), ...state.computations };
      if (!state.lastStageId) state.lastStageId = deepCopy(seed?.lastStageId) ?? null;
    }
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
    // ── P9：赛事规则说明（落地页）────────────────────────────────
    // ⚠️ **与正式后端共用同一个领域层函数**（src/domain/event-info.js）——
    //    演示站与正式站的落地页内容因此**不可能漂移**。
    //    P8 的教训：演示适配器曾把「错误的形状」（body 传 judgeId、进度按评委分组）
    //    锁进测试 ⇒ 形状必须**同源**，不能各写一份。
    if (method === 'GET' && clean === '/api/event-info') {
      return buildEventInfo(r);
    }
    // 当前用户
    if (method === 'GET' && clean === '/api/me') {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      // ⚠️ P7：老版 localStorage 里的 me 没有 roles ⇒ 导航分区会退回「访客」。
      //    演示站只有一个身份（演示组委会），缺角色就补上。
      if (!Array.isArray(s.me.roles)) s.me.roles = ['admin'];
      return { user: s.me };
    }
    if (method === 'POST' && clean === '/api/auth/login') {
      s.me = {
        id: 'demo_admin',
        name: body?.name || '演示管理员',
        mbaStatus: 'mba',
        org: '演示组委会',
        teamId: (s.teams ?? [])[0]?.id ?? null,
        // ⚠️ P7：角色键 —— 前端据此分区导航（与真实后端 /api/me 的形状一致）
        roles: ['admin'],
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
        // ⚠️ P7：形状与真实后端的 presentRegistration() 对齐 ——
        //    `grading`（分数 / 是否接收 / 可解释明细）与 `events`（事件轨迹）
        //    是「报名筛选台」两列数据的来源，缺了这两列演示站上那两列恒空。
        grading: {
          score: scored.score,
          level,
          accepted: scored.accepted,
          explain: scored.explain,
        },
        events: [],
        status: level === 'C' ? 'rejected' : 'accepted',
        createdAt: new Date().toISOString(),
      };
      s.registrations.push(reg);
      persist();
      return reg;
    }
    if (method === 'GET' && clean === '/api/registrations') {
      // ⚠️ 形状与真实后端一致：后端返 `{ items }`（src/services/registration.js
      //    listRegistrations），演示站此前返 `{ rows }` ⇒ 前端要么写两套、要么读不到。
      //    ⇒ 返 `{ items }`，同时保留 `rows` 别名（老访客的 localStorage 不受影响，
      //    但已有页面若还在读 rows 也不会突然空掉）。
      return { items: s.registrations, rows: s.registrations };
    }
    // ── P7：报名筛选标准 ────────────────────────────────────────
    // ⚠️ 此前演示适配器**没有**这个端点 ⇒ 公网演示站点「报名」页直接 404。
    //    形状必须与 src/http/routes/registration.js 的 buildCriteria 一致。
    if (method === 'GET' && clean === '/api/registration-criteria') {
      const reg = r.registration;
      const comp = r.compliance ?? {};
      return {
        editionId: s.edition?.id ?? 'ed_demo',
        editionName: s.edition?.name ?? null,
        scale: reg.scale,
        dimensions: (reg.dimensions ?? []).map((d) => ({
          key: d.key,
          label: d.label,
          weight: d.weight,
          min: d.min,
          max: d.max,
          items: (reg.questions?.dimensionItems?.[d.key] ?? []).map((it) => ({ id: it.id, text: it.text })),
        })),
        openQuestion: { ...reg.openQuestion, prompt: reg.questions?.openQuestionItem?.text ?? '' },
        levels: (reg.levels ?? []).map((l) => ({
          key: l.key, label: l.label, minScore: l.minScore, accept: l.accept,
        })),
        funnel: reg.funnel ?? [],
        funnelNote: reg.funnelNote ?? '',
        ipOwnership: comp.ipOwnership ?? {},
        redLines: comp.redLines ?? [],
        consent: comp.consent ?? {},
        schedule: [],
      };
    }
    // ── P7：我的战队（列表）────────────────────────────────────
    // ⚠️ 此前演示适配器**没有** GET /api/teams ⇒ 「我的战队」页 404。
    // ⚠️ **P10 修正：口径必须与正式站一致** —— 正式站 `GET /api/teams`
    //    只返回「我参与的」队伍（src/services/team.js listMyTeams），
    //    而演示站原先返回**全部**队伍 ⇒ 互评页的目标列表口径与正式站分叉
    //    （发起队 = 全部 ⇒ 被评队 = 空）。详见 demoMyTeams 的注释。
    if (method === 'GET' && clean === '/api/teams') {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      return { items: demoMyTeams(s).map((t) => demoTeamView(t, s)) };
    }
    // ── P7：任务包列表 ────────────────────────────────────────
    // ⚠️ 此前演示适配器**没有** GET /api/task-packages ⇒ 「我的战队」的认领下拉空、
    //    「报名筛选台」的配比体检与任务包清单也拿不到数据。
    if (method === 'GET' && clean === '/api/task-packages') {
      const items = (s.taskPackages ?? []).map((p) => demoTaskPackageView(p, s));
      // ⚠️ 与正式站同口径（src/http/routes/taskPackage.js）：
      //    配比体检的对象是**已发布（进池）的卡** —— 未分级的卡（待评估 / 待签级）
      //    还没进池，算进去会让体检失真。
      const mix = checkTaskMix(items.filter((p) => p.status === 'published'), r.solvability);
      return { items, mix };
    }
    // ── P7：退出战队（加入 / 退出 / 汰换共用一个端点）────────────
    let tm2 = clean.match(/^\/api\/teams\/([^/]+)\/members$/);
    if (method === 'POST' && tm2) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const team = (s.teams ?? []).find((t) => t.id === tm2[1]);
      if (!team) throw httpError(404, 'NOT_FOUND', '战队不存在');
      const action = body?.action ?? 'add';
      if (action !== 'leave') {
        throw httpError(400, 'BAD_REQUEST', '演示站暂不支持该操作（只支持退出）');
      }
      const captainId = team.captainId ?? team.memberIds?.[0] ?? null;
      if (captainId === s.me.id) {
        // ⛔ 与服务端同一口径：组长不能直接退出（服务端 409 CAPTAIN_MUST_REPLACE）
        throw httpError(409, 'CAPTAIN_MUST_REPLACE', '组长不能直接退出，请先移交组长职责');
      }
      if (!(team.memberIds ?? []).includes(s.me.id)) {
        throw httpError(404, 'NOT_FOUND', '你不在该战队中');
      }
      team.memberIds = (team.memberIds ?? []).filter((uid) => uid !== s.me.id);
      // R-REG-04：仅剩 1 人 ⇒ 触发并队标记与期限
      if (team.memberIds.length <= 1) {
        team.status = 'needs_merge';
        team.mergeDeadline = new Date(Date.now() + 7 * 86400000).toISOString();
      }
      persist();
      return { ok: true, teamId: team.id, memberCount: team.memberIds.length };
    }
    // ── P7：单条报名 + 改级 ────────────────────────────────────
    let regm = clean.match(/^\/api\/registrations\/([^/]+)$/);
    if (method === 'GET' && regm) {
      const reg = (s.registrations ?? []).find((x) => x.id === regm[1]);
      if (!reg) throw httpError(404, 'NOT_FOUND', '报名记录不存在');
      return reg;
    }
    let lvlm = clean.match(/^\/api\/registrations\/([^/]+)\/level$/);
    if (method === 'POST' && lvlm) {
      const reg = (s.registrations ?? []).find((x) => x.id === lvlm[1]);
      if (!reg) throw httpError(404, 'NOT_FOUND', '报名记录不存在');
      const from = reg.status;
      const level = body?.level ?? null;
      if (level) {
        reg.levelFinal = level;
        reg.status = level === 'C' ? 'rejected' : 'accepted';
      }
      // R-REG-10：改级要留**事件轨迹**（追加式，历史不覆盖）
      reg.events = [...(reg.events ?? []), {
        fromStatus: from, toStatus: reg.status, reason: body?.note ?? null,
      }];
      persist();
      return { ok: true, registration: reg };
    }
    // ── P10 · W4-a：任务卡六维评估 + 分级签级（写）──────────────────
    // ⚠️ 此前演示适配器**只有**一个**不带 id**的通用端点
    //    （POST /api/task-packages/solvability），而前端调的是**带 id**的
    //    /api/task-packages/:id/solvability ⇒ 演示站「任务卡审批」页的
    //    「提交评估 / 签级」按钮**点不动**（= 只做展示）。
    //    ⇒ 通用端点已删（没有任何调用方），换成与真实后端同形的两个。
    // ⚠️ 形状与正式后端一致（src/services/taskPackage.js）：两个写端点都返回
    //    **任务卡视图**（presentTaskPackage），前端拿它换掉那张卡。
    // ⚠️ 与真实站同码同判：INVALID_SOLVABILITY_ANSWERS / INVALID_VETO_KEY /
    //    INVALID_GRADE / RETURN_REASON_REQUIRED / SOLVABILITY_NOT_ASSESSED /
    //    TASK_PACKAGE_STATE_INVALID。
    const pkgm = clean.match(/^\/api\/task-packages\/([^\/]+)\/solvability$/);
    if (method === 'POST' && pkgm) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const pkg = (s.taskPackages ?? []).find((p) => p.id === pkgm[1]);
      if (!pkg) throw httpError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
      if (!DEMO_ASSESSABLE.has(pkg.status)) {
        throw httpError(409, 'TASK_PACKAGE_STATE_INVALID', `当前状态（${pkg.status}）不允许重新评估`);
      }
      const answers = body?.answers ?? body ?? {};
      for (const dim of r.solvability.dimensions ?? []) {
        const v = Number(answers?.[dim.key]);
        if (!Number.isInteger(v) || v < 0 || v > dim.max) {
          throw httpError(400, 'INVALID_SOLVABILITY_ANSWERS', `${dim.label} 必须为 0–${dim.max} 的整数`);
        }
      }
      const declared = Array.isArray(answers?.vetoes) ? answers.vetoes : [];
      for (const key of declared) {
        if (!(r.solvability.vetoes ?? []).some((v) => v.key === key)) {
          throw httpError(400, 'INVALID_VETO_KEY', `未知的否决项：${key}`);
        }
      }
      const result = scoreSolvability({ answers, config: r.solvability });
      pkg.solvabilityScore = result.score;
      pkg.solvabilityGrade = result.grade;
      pkg.commitment = result.commitment ?? '';
      pkg.agreement = result.agreement ?? '';
      pkg.status = 'assessed';
      pkg.solvability = {
        score: result.score,
        grade: result.grade,
        vetoes: result.vetoes,
        explain: result.explain,
        computedGrade: result.computedGrade,
        assessedBy: s.me.id,
        assessedAt: new Date().toISOString(),
      };
      persist();
      return demoTaskPackageView(pkg, s);
    }
    const pkgm2 = clean.match(/^\/api\/task-packages\/([^\/]+)\/approve$/);
    if (method === 'POST' && pkgm2) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const pkg = (s.taskPackages ?? []).find((p) => p.id === pkgm2[1]);
      if (!pkg) throw httpError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
      const grades = r.solvability.grades ?? [];
      const grade = body?.grade;
      const reason = body?.reason ?? null;
      const gradeCfg = grades.find((g) => g.key === grade);
      if (!gradeCfg) {
        throw httpError(400, 'INVALID_GRADE', `等级必须是 ${grades.map((g) => g.key).join(' / ')}`);
      }
      // ⛔ P10（W4-a）：主动签 D 级（退回）必须写理由 —— 与正式站同码同判。
      if (grade === 'D' && !String(reason ?? '').trim()) {
        throw httpError(400, 'RETURN_REASON_REQUIRED', '退回任务卡必须写明退回理由（企业要照着改）');
      }
      // ⛔ 必须先做六维评估才能签级（正式站的 SOLVABILITY_NOT_ASSESSED 闸门）。
      if (typeof pkg.solvability?.score !== 'number') {
        throw httpError(400, 'SOLVABILITY_NOT_ASSESSED', '任务卡必须先完成六维可解性评估，才能分级签约');
      }
      if (!DEMO_APPROVABLE.has(pkg.status)) {
        throw httpError(409, 'TASK_PACKAGE_STATE_INVALID', `当前状态（${pkg.status}）不允许分级签约`);
      }
      // ⛔ 命中一票否决 ⇒ 不得签成 A/B/C，强制退回（正式站同口径）。
      const vetoes = pkg.solvability.vetoes ?? [];
      const finalGrade = vetoes.length && grade !== 'D' ? 'D' : grade;
      const finalCfg = grades.find((g) => g.key === finalGrade) ?? gradeCfg;
      const now = new Date().toISOString();
      pkg.grade = finalGrade;
      pkg.status = finalGrade === 'D' ? 'returned' : 'published';
      pkg.commitment = pkg.isFreeBrief ? '无' : (finalCfg.commitment ?? '');
      pkg.agreement = pkg.isFreeBrief ? '自由命题不签约，无企业协议' : (finalCfg.agreement ?? '');
      pkg.approvedBy = s.me.id;
      pkg.approvedAt = now;
      pkg.solvability = {
        ...(pkg.solvability ?? {}),
        decision: {
          grade: finalGrade,
          requestedGrade: grade,
          reason: reason ? String(reason).trim() : null,
          decidedBy: s.me.id,
          decidedAt: now,
        },
      };
      persist();
      return demoTaskPackageView(pkg, s);
    }
    // ── P7：审计三端点（复核队列 / 计算留痕 / 复算 diff）───────────
    // ⚠️ 此前演示适配器**完全没有** /api/audit/* ⇒ 公网演示站的
    //    「复核队列」与「计算留痕」两页直接 404。
    // ⚠️ 顺序要紧：diff 的路径多一段（`/diff`），必须排在普通路径**之前**。
    let difm = clean.match(/^\/api\/audit\/computations\/([^/]+)\/diff$/);
    if (method === 'GET' && difm) {
      const comp = (s.computations ?? {})[difm[1]];
      if (!comp) throw httpError(404, 'NOT_FOUND', '计算快照不存在');
      // ⚠️ 演示站的 diff 口径：**同输入复算 ⇒ 必然一致**（浏览器里跑的是同一套引擎、同一份输入）
      //    ⇒ identical = true、diff 为空 —— 这正是「可复算」在演示站要展示的结论。
      return { identical: true, diff: [], warnings: [] };
    }
    let cmpm = clean.match(/^\/api\/audit\/computations\/([^/]+)$/);
    if (method === 'GET' && cmpm) {
      const comp = (s.computations ?? {})[cmpm[1]];
      if (!comp) throw httpError(404, 'NOT_FOUND', '计算快照不存在');
      return {
        computationId: comp.computationId,
        stageId: comp.stageId,
        ruleVersion: r.tiebreak?.version ?? 'demo',
        revision: 1,
        createdAt: comp.computedAt,
        input: { submissions: [] },
        output: { teams: comp.ordered ?? [] },
        trace: {
          normalization: comp.trace?.normalization ?? {},
          steps: comp.trace?.steps ?? [],
          weights: comp.trace?.weights ?? {},
          perTeam: comp.trace?.perTeam ?? {},
          // 降级告警 = 计算告警 + 破同分告警（两者都必须在页面上显式展示，不静默）
          warnings: [...(comp.warnings ?? []), ...(comp.tiebreakWarnings ?? [])],
        },
      };
    }
    if (method === 'GET' && clean === '/api/audit/flags') {
      const flags = demoFlags(s);
      return { rows: flags, total: flags.length };
    }
    let flm = clean.match(/^\/api\/audit\/flags\/([^/]+)\/resolve$/);
    if (method === 'POST' && flm) {
      const flag = demoFlags(s).find((f) => f.id === flm[1]);
      if (!flag) throw httpError(404, 'NOT_FOUND', '复核项不存在');
      const evidence = Array.isArray(body?.evidence) ? body.evidence : [];
      flag.status = body?.status ?? 'confirmed';
      flag.reason = body?.reason ?? null;
      flag.evidence = evidence;
      // 独立发行方去重计数（与后端同一口径：按 publisher 去重）
      const publishers = new Set(evidence.map((e) => e?.publisher).filter(Boolean));
      persist();
      return { status: flag.status, detail: { evidence: { uniquePublishers: publishers.size } } };
    }
    // ── P10/DP-106：申诉（选手提交 + 组委会裁决）─────────────────────
    // ⚠️ **形状与正式后端逐字一致**（P9 教训：演示站与正式站不能各写一份形状）：
    //    GET  /api/appeals            → { rows: [...], total }
    //    POST /api/appeals            → 新建的申诉
    //    POST /api/appeals/:id/decide → { appeal, transitions, recomputeRequired }
    //    （正式站口径：src/services/review-state.js 的 listAppeals / fileAppeal / decideAppeal）
    if (method === 'GET' && clean === '/api/appeals') {
      const rows = (s.appeals ?? []).map(demoAppealView);
      return { rows, total: rows.length };
    }
    let apm = clean.match(/^\/api\/appeals\/([^/]+)\/decide$/);
    if (method === 'POST' && apm) {
      const appeal = (s.appeals ?? []).find((a) => a.id === apm[1]);
      if (!appeal) throw httpError(404, 'NOT_FOUND', `申诉不存在: ${apm[1]}`);
      const decision = body?.decision ?? '';
      if (!['accepted', 'rejected'].includes(decision)) {
        throw httpError(400, 'BAD_REQUEST', '裁决只能是 accepted 或 rejected');
      }
      const note = String(body?.note ?? '').trim();
      if (!note) throw httpError(400, 'BAD_REQUEST', '裁决必须写说明（无说明的裁决无法复盘）');
      appeal.status = decision;
      appeal.decidedBy = s.me?.id ?? 'demo_admin';
      appeal.decidedAt = new Date().toISOString();
      appeal.decisionNote = note;
      // ⚠️ 报名类申诉成立 ⇒ **撤销分级裁定、回到待复核**（正式站同一口径：
      //    src/services/review-state.js 的 decideAppeal —— 清 level_final、status 置回 submitted、
      //    并追加一条 registration_events）。演示站没有赛段重算引擎 ⇒ 不假装重算。
      const isRegistration = appeal.subjectType === 'registration';
      if (decision === 'accepted' && isRegistration) {
        const reg = (s.registrations ?? []).find((r) => r.id === appeal.subjectId);
        if (reg) {
          const fromStatus = reg.status;
          reg.levelFinal = null;
          reg.status = 'submitted';
          reg.events = [...(reg.events ?? []), {
            fromStatus, toStatus: 'submitted', reason: note,
          }];
        }
      }
      persist();
      return {
        appeal: demoAppealView(appeal),
        // 报名类不触发赛段状态迁移（正式站同口径：transitions 为空数组）
        transitions: [],
        recomputeRequired: decision === 'accepted' && !isRegistration,
      };
    }
    if (method === 'POST' && clean === '/api/appeals') {
      const subjectType = body?.subjectType ?? 'team_result';
      const subjectId = String(body?.subjectId ?? '').trim();
      if (!subjectId) throw httpError(400, 'BAD_REQUEST', '申诉必须给 subjectId');
      const reason = String(body?.reason ?? '').trim();
      if (!reason) throw httpError(400, 'BAD_REQUEST', '申诉必须写理由（空理由 = 无法复核）');
      if (subjectType === 'registration') {
        const reg = (s.registrations ?? []).find((r) => r.id === subjectId);
        if (!reg) throw httpError(404, 'NOT_FOUND', `报名记录不存在: ${subjectId}`);
      }
      // 防重复提交（正式站同一口径：同一报名同时只允许一条待裁决的申诉）
      const dup = (s.appeals ?? []).some((a) => a.subjectType === subjectType
        && a.subjectId === subjectId
        && ['submitted', 'reviewing'].includes(a.status));
      if (dup) throw httpError(409, 'CONFLICT', '该报名已有未裁决的申诉，请等待组委会裁决');
      const appeal = {
        id: `appeal_demo_${(s.appeals ?? []).length + 1}`,
        subjectType,
        subjectId,
        filedBy: s.me?.id ?? 'demo_user',
        reason,
        status: 'submitted',
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: new Date().toISOString(),
      };
      s.appeals.push(appeal);
      persist();
      return demoAppealView(appeal);
    }
    // ── P7：赛段时间线（前端赛段选择器用）─────────────────────
    if (method === 'GET' && clean === '/api/stages') {
      // ⚠️ 演示站只有一个赛段（stage_final）—— 从**已有计算结果**推导，
      //    不要写死：真实系统里赛段数由赛事配置决定。
      const stageIds = Object.keys(s.results ?? {});
      const items = stageIds.map((id) => ({
        id,
        key: id,
        name: id === s.lastStageId ? '决赛赛段' : `赛段 ${id}`,
        kind: 'final',
        status: 'computed',
        startsAt: null,
        endsAt: null,
      }));
      return { items };
    }
    // ── P7：工作流与任务清单（任务清单页的入口 + 领取/完成/释放）──
    if (method === 'GET' && clean === '/api/workflows') {
      ensureDemoWorkflows(s);
      const items = s.workflows.map((w) => {
        const tasks = s.workflowTasks.filter((t) => t.workflowId === w.id);
        return {
          id: w.id,
          name: w.name,
          taskPackageId: w.taskPackageId,
          createdAt: w.createdAt,
          taskCount: tasks.length,
          doneCount: tasks.filter((t) => t.status === 'done').length,
        };
      });
      return { items };
    }
    let wm = clean.match(/^\/api\/workflows\/([^/]+)\/tasks$/);
    if (method === 'GET' && wm) {
      ensureDemoWorkflows(s);
      if (!s.workflows.some((w) => w.id === wm[1])) throw httpError(404, 'NOT_FOUND', '工作流不存在');
      const tasks = s.workflowTasks.filter((t) => t.workflowId === wm[1]);
      return { workflowId: wm[1], tasks };
    }
    let tm = clean.match(/^\/api\/tasks\/([^/]+)\/claim$/);
    if (method === 'POST' && tm) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      ensureDemoWorkflows(s);
      const t = s.workflowTasks.find((x) => x.id === tm[1]);
      if (!t) throw httpError(404, 'NOT_FOUND', '任务不存在');
      if (t.claim) throw httpError(409, 'ALREADY_CLAIMED', '任务已被领取');
      t.claim = { userId: s.me.id, at: new Date().toISOString() };
      t.status = 'in_progress';
      persist();
      return { ok: true, taskId: t.id, status: t.status };
    }
    let cm = clean.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (method === 'POST' && cm) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      ensureDemoWorkflows(s);
      const t = s.workflowTasks.find((x) => x.id === cm[1]);
      if (!t) throw httpError(404, 'NOT_FOUND', '任务不存在');
      t.status = 'done';
      t.completedAt = new Date().toISOString();
      t.completedBy = s.me.id;
      t.evidence = body?.evidence ?? null;
      persist();
      return { ok: true, taskId: t.id, status: t.status };
    }
    let rm = clean.match(/^\/api\/tasks\/([^/]+)\/release$/);
    if (method === 'POST' && rm) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      ensureDemoWorkflows(s);
      const t = s.workflowTasks.find((x) => x.id === rm[1]);
      if (!t) throw httpError(404, 'NOT_FOUND', '任务不存在');
      t.claim = null;
      t.status = 'todo';
      persist();
      return { ok: true, taskId: t.id, status: t.status };
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
    // ⚠️ **形状必须与真实后端一致**（P8 修正）：真实后端从**会话**取评委
    //    （src/http/routes/review.js：`judgeId: ctx.user.id`），**不看 body 里的 judgeId**。
    //    原来演示适配器从 `it.judgeId` 取 ⇒ 前端按真实契约发（body 里没有 judgeId）时，
    //    演示站会把分记到一个**空 judgeId** 下 ⇒ 「提交成功但进度不涨」。
    m = clean.match(/^\/api\/stages\/([^/]+)\/reviews$/);
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const judgeId = s.me.id;
      // ⚠️ **打分的人必须在这个赛段的评委池里**，否则引擎不认他的分
      //    （src/domain/scoring.js：votingIds = 池内评委 ⇒ 池外的分被丢弃）。
      //    真实系统里评委由 stage_judges 指派；演示站只有一个账号 ⇒ **打分时自动入池**，
      //    否则演示站会出现「提交成功但榜单纹丝不动」的假象。
      if (!(s.judges ?? []).some((j) => j.id === judgeId)) {
        s.judges = [...(s.judges ?? []), { id: judgeId, name: s.me.name ?? '演示评审', seat: 'judge' }];
      }
      const items = Array.isArray(body?.items) ? body.items : [];
      if (!s.reviews[judgeId]) s.reviews[judgeId] = {};
      for (const it of items) {
        if (!s.reviews[judgeId][it.teamId]) s.reviews[judgeId][it.teamId] = {};
        s.reviews[judgeId][it.teamId][it.dimension] = Number(it.rawScore);
      }
      persist();
      return { stageId: m[1], judgeId, submitted: items.length, items: [] };
    }
    // ── P10 评委前置：回避台账（读 + 写）─────────────────────────
    // ⚠️ **形状与正式后端逐字一致**（P9 教训：演示站与正式站不能各写一份形状）：
    //    GET  /api/stages/:stageId/recusals → { items: [...] }（camelCase 投影）
    //    POST /api/stages/:stageId/recusals → **数据库原始行**（snake_case）
    //      （正式站 declareRecusal / reinstateRecusal 返回的就是 insertRecusal 的原始行）
    //    ⛔ 可见性口径与正式站一致：**本人只看自己的**；委员会看全部。
    //      演示站只有一个委员会账号 ⇒ 它看得到全部（与正式站组委会同口径）。
    m = clean.match(/^\/api\/stages\/([^/]+)\/recusals$/);
    if (method === 'GET' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const rows = (s.recusals ?? [])
        .filter((r) => r.stage_id === m[1])
        .map((r) => demoRecusalView(r, s));
      return { items: rows };
    }
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const action = body?.action ?? 'recused';
      if (!['recused', 'reinstated'].includes(action)) {
        throw httpError(400, 'INVALID_RECUSAL_ACTION', `未知的回避动作：${action}`);
      }
      const reason = String(body?.reason ?? '').trim();
      if (!reason) {
        throw httpError(400, 'RECUSAL_REASON_REQUIRED', '回避必须填写原因（供应方 / 投资方 / 前雇主）');
      }
      const teamId = body?.teamId ?? null;
      if (teamId != null && !(s.teams ?? []).some((t) => t.id === teamId)) {
        throw httpError(404, 'TEAM_NOT_IN_STAGE', `队伍 ${teamId} 不在本赛段名册内`);
      }
      // ⚠️ 评委必须**在本赛段评委名单里**（正式站 getStageJudge → 404 JUDGE_NOT_ASSIGNED）。
      //    演示站只有一个账号 ⇒ 与 POST /reviews 一样**自动入池**（否则演示站是死路）。
      const judgeId = body?.judgeId ?? s.me.id;
      const knownJudge = judgeId === s.me.id || (s.users ?? []).some((u) => u.id === judgeId);
      if (!knownJudge) throw httpError(404, 'JUDGE_NOT_ASSIGNED', '该评委未被分配到本赛段');
      if (!(s.judges ?? []).some((j) => j.id === judgeId)) {
        s.judges = [...(s.judges ?? []), { id: judgeId, name: s.me.name ?? '演示评审', seat: 'judge' }];
      }
      const row = {
        id: `rec_demo_${(s.recusals ?? []).length + 1}`,
        stage_id: m[1],
        judge_id: judgeId,
        team_id: teamId,
        reason,
        source: action === 'reinstated' ? 'reinstated' : 'declared',
        declared_at: new Date().toISOString(),
        audit_by: s.me.id,
        action,
      };
      s.recusals = [...(s.recusals ?? []), row];
      persist();
      return row;
    }
    // ── P10 · W4-b：企业签字台（读 + 写）────────────────────────────
    // ⚠️ 形状与正式后端逐字一致（src/services/signoff-board.js / src/services/milestone.js /
    //    src/http/routes/review.js）。
    // ⛔ 此前演示适配器**完全没有**这组端点 ⇒ 公网演示站的「企业签字台」页是两块错误卡片
    //    （两个读口都落到 DEMO_ENDPOINT_MISSING）⇒ 导航里放这个入口就是放一个死链。
    if (method === 'GET' && clean === '/api/signoffs/mine') {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      return demoSignoffWorklist({ state: s, rules: r, viewer: s.me });
    }
    m = clean.match(/^\/api\/stages\/([^/]+)\/enterprise-confirmations$/);
    if (method === 'GET' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      return demoEnterpriseConfirmationBoard({ state: s, rules: r, stageId: m[1], viewer: s.me });
    }
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const teamId = body?.teamId;
      const team = (s.teams ?? []).find((t) => t.id === teamId);
      if (!team) throw httpError(404, 'TEAM_NOT_FOUND', '队伍不存在');
      const pkg = (s.taskPackages ?? []).find((p) => p.id === team.packageId);
      const enterpriseId = body?.enterpriseId ?? s.me.id;
      const dimension = body?.dimension ?? 'enterprise';
      const content = String(body?.content ?? '').trim();
      if (!content) throw httpError(400, 'MISSING_CONTENT', '必须写清企业确认内容');
      const rawScore = Number(body?.rawScore);
      // ⛔ 与正式站同码同判（src/services/review.js 的 assertScoreInRange）
      if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100) {
        throw httpError(400, 'SCORE_OUT_OF_RANGE', '企业确认分必须是 0–100 之间的数字');
      }
      const crossJudgeId = body?.crossJudgeId ?? null;
      if (crossJudgeId && crossJudgeId === enterpriseId) {
        throw httpError(400, 'CROSS_JUDGE_SAME_AS_SIGNATORY', '跨领域评委签字人不能与出题企业签字人相同');
      }
      if (crossJudgeId && !(s.judges ?? []).some((j) => j.id === crossJudgeId)) {
        throw httpError(404, 'JUDGE_NOT_ASSIGNED', '跨领域评委不在本赛段名单内');
      }
      const now = new Date().toISOString();
      const row = {
        id: `ec_demo_${(s.enterpriseConfirmations ?? []).length + 1}`,
        teamId,
        enterpriseId,
        dimension,
        rawScore,
        crossJudgeId,
        signatoryUserId: enterpriseId,
        content,
        signedAt: now,
        stageId: m[1],
        packageEnterpriseId: pkg?.enterpriseId ?? null,
      };
      s.enterpriseConfirmations = [...(s.enterpriseConfirmations ?? []), row];
      persist();
      return row;
    }
    // ── P10 · W4-b：里程碑签字 + 撤回（写）──────────────────────────
    // ⚠️ 与正式站同码同判（src/services/milestone.js）：
    //    缺部门 → 400 MISSING_DEPARTMENT；缺内容 → 400 MISSING_CONTENT；
    //    里程碑不存在 → 404 MILESTONE_NOT_FOUND；签字不存在 → 404 SIGNOFF_NOT_FOUND；
    //    已撤回 → 409 ALREADY_REVOKED。
    m = clean.match(/^\/api\/milestones\/([^/]+)\/signoff$/);
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const ms = demoFindMilestone(s, r, m[1]);
      if (!ms) throw httpError(404, 'MILESTONE_NOT_FOUND', '里程碑不存在');
      const requires = r.milestones?.signoffRequires ?? {};
      const department = String(body?.department ?? '').trim();
      const content = String(body?.content ?? '').trim();
      if (requires.department !== false && !department) {
        throw httpError(400, 'MISSING_DEPARTMENT', '必须填写签字部门');
      }
      if (requires.content !== false && !content) {
        throw httpError(400, 'MISSING_CONTENT', '必须写清签字内容（解决哪个环节 / 落地时间 / 我方角色）');
      }
      const now = new Date().toISOString();
      const id = `so_demo_${demoSignoffRows(s).length + 1}`;
      s.signoffs = [...(s.signoffs ?? []), {
        id,
        teamId: ms.teamId,
        milestoneKey: ms.key,
        department,
        content,
        enterpriseId: s.me.id,
        signedAt: now,
        revokedAt: null,
        isBusinessDepartment: true,
      }];
      persist();
      return { id, milestoneId: m[1], teamId: ms.teamId, department, content, signedAt: now, revokedAt: null };
    }
    m = clean.match(/^\/api\/milestones\/([^/]+)\/signoff\/withdraw$/);
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const ms = demoFindMilestone(s, r, m[1]);
      if (!ms) throw httpError(404, 'MILESTONE_NOT_FOUND', '里程碑不存在');
      const signoffId = body?.signoffId;
      const rows = demoSignoffRows(s);
      const idx = rows.findIndex((x) => x.id === signoffId
        && x.teamId === ms.teamId && x.milestoneKey === ms.key);
      if (idx < 0) throw httpError(404, 'SIGNOFF_NOT_FOUND', '签字不存在');
      if (rows[idx].revokedAt) throw httpError(409, 'ALREADY_REVOKED', '该签字已被撤回');
      const now = new Date().toISOString();
      const next = [...(s.signoffs ?? [])];
      next[idx] = { ...next[idx], revokedAt: now };
      s.signoffs = next;
      persist();
      return { id: signoffId, milestoneId: m[1], revokedAt: now };
    }
    // ── P10 评委前置：互评（写）──────────────────────────────────
    // ⚠️ **形状与正式后端一致**：POST /peer-reviews → { stageId, submitted, items }
    //    其中 items 是**数据库原始行**（snake_case）。
    // ⚠️ 但**内部状态保持 camelCase**（种子与 scoreStage 的入参都是 camelCase：
    //    src/domain/scoring.js 的 peerReviews = [{fromTeamId, toTeamId, score}]）
    //    ⇒ 状态用 camelCase、**返回**用 snake_case，两件事分开。
    // ⛔ 写入口的闸门与正式站同码：不是本队成员 → 403 NOT_TEAM_MEMBER；
    //    给自己互评 → 400 SELF_PEER_REVIEW；分值越界 → 400 SCORE_OUT_OF_RANGE。
    m = clean.match(/^\/api\/stages\/([^/]+)\/peer-reviews$/);
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const myTeamIds = new Set(demoMyTeams(s).map((t) => t.id));
      const items = Array.isArray(body?.items) ? body.items : [];
      const written = [];
      for (const item of items) {
        if (!myTeamIds.has(item.fromTeamId)) {
          throw httpError(403, 'NOT_TEAM_MEMBER', '只能代表本队提交互评');
        }
        if (item.fromTeamId === item.toTeamId) {
          throw httpError(400, 'SELF_PEER_REVIEW', '不能给自己互评');
        }
        if (!(s.teams ?? []).some((t) => t.id === item.toTeamId)) {
          throw httpError(404, 'TEAM_NOT_IN_STAGE', `队伍 ${item.toTeamId} 不在本赛段名册内`);
        }
        const score = demoAssertScore(item.score, '互评分');
        const existing = (s.peerReviews ?? []).find(
          (p) => p.fromTeamId === item.fromTeamId && p.toTeamId === item.toTeamId,
        );
        const now = new Date().toISOString();
        if (existing) {
          existing.score = score;
          written.push(existing);
        } else {
          const row = {
            id: `pr_demo_${(s.peerReviews ?? []).length + 1}`,
            fromTeamId: item.fromTeamId,
            toTeamId: item.toTeamId,
            score,
            requestId: body?.requestId ?? null,
            createdAt: now,
          };
          s.peerReviews = [...(s.peerReviews ?? []), row];
          written.push(row);
        }
      }
      persist();
      return {
        stageId: m[1],
        submitted: written.length,
        // ⚠️ 返回**原始行**（snake_case）—— 与正式站 submitPeerReviews 的返回一致
        items: written.map((p) => ({
          id: p.id,
          stage_id: m[1],
          from_team_id: p.fromTeamId,
          to_team_id: p.toTeamId,
          score: p.score,
          request_id: p.requestId ?? null,
          created_at: p.createdAt,
        })),
      };
    }
    // ── P10 评委前置：自评（写）──────────────────────────────────
    // ⚠️ **形状与正式后端一致**：POST /self-review → { stageId, teamId, submitted, items }
    //    items 是**数据库原始行**（snake_case）；内部状态保持 camelCase（scoreStage 的入参）。
    m = clean.match(/^\/api\/stages\/([^/]+)\/self-review$/);
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const teamId = body?.teamId;
      if (!teamId) throw httpError(400, 'MISSING_TEAM_ID', '缺少队伍');
      const myTeamIds = new Set(demoMyTeams(s).map((t) => t.id));
      if (!myTeamIds.has(teamId)) {
        throw httpError(403, 'NOT_TEAM_MEMBER', '只能为本队提交自评');
      }
      const items = Array.isArray(body?.items) ? body.items : [];
      const written = [];
      for (const item of items) {
        const rawScore = demoAssertScore(item.rawScore, '自评分');
        const existing = (s.selfReviews ?? []).find(
          (r) => r.teamId === teamId && r.dimension === item.dimension,
        );
        const now = new Date().toISOString();
        if (existing) {
          existing.rawScore = rawScore;
          written.push(existing);
        } else {
          const row = {
            id: `sr_demo_${(s.selfReviews ?? []).length + 1}`,
            teamId,
            dimension: item.dimension,
            rawScore,
            requestId: body?.requestId ?? null,
            submittedAt: now,
          };
          s.selfReviews = [...(s.selfReviews ?? []), row];
          written.push(row);
        }
      }
      persist();
      return {
        stageId: m[1],
        teamId,
        submitted: written.length,
        // ⚠️ 返回**原始行**（snake_case）—— 与正式站 submitSelfReviews 的返回一致
        items: written.map((r) => ({
          id: r.id,
          stage_id: m[1],
          team_id: r.teamId,
          dimension: r.dimension,
          raw_score: r.rawScore,
          submitted_at: r.submittedAt,
          request_id: r.requestId ?? null,
        })),
      };
    }
    // ── P10 评委前置：校准（写）──────────────────────────────────
    // ⚠️ **形状与正式后端一致**：POST /calibration → { stageId, judgeId, submitted }
    // ⛔ **维度白名单与打分入口同口径**（正式站 P10 已给校准入口补上 assertJudgeDimensions）：
    //    未知维度 → 400 UNKNOWN_DIMENSION；非评委席维度 → 403 DIMENSION_SEAT_FORBIDDEN。
    m = clean.match(/^\/api\/stages\/([^/]+)\/calibration$/);
    if (method === 'POST' && m) {
      if (!s.me) throw httpError(401, 'UNAUTHENTICATED', '未登录');
      const items = Array.isArray(body?.items) ? body.items : [];
      for (const item of items) {
        demoAssertJudgeDimension(item.dimension, r);
        demoAssertScore(item.rawScore, '校准打分');
      }
      const judgeId = s.me.id;
      const now = new Date().toISOString();
      const rows = items.map((item) => ({
        id: `cal_demo_${(s.calibrations ?? []).length + 1}`,
        judgeId,
        dimension: item.dimension,
        rawScore: Number(item.rawScore),
        createdAt: now,
      }));
      s.calibrations = [...(s.calibrations ?? []), ...rows];
      persist();
      return { stageId: m[1], judgeId, submitted: items.length };
    }
    // ⚠️ **评审工作台（P8）**：形状必须与真实后端 `GET /api/stages/:stageId/review-board`
    //    **逐字段一致**（否则同一份前端在演示站与正式站表现不同 ⇒ 演示就失去意义）。
    m = clean.match(/^\/api\/stages\/([^/]+)\/review-board$/);
    if (method === 'GET' && m) return demoReviewBoard({ state: s, rules: r, stageId: m[1] });
    m = clean.match(/^\/api\/stages\/([^/]+)\/review-state$/);
    if (method === 'GET' && m) {
      // ⚠️ **P8 修正**：原来返回的 `dimensionProgress` 是「按评委分组」的**数字**，
      //    而真实后端是「按维度分组」的 `{submitted, total}`，并且还有 `total` / `missing`。
      //    ⇒ 演示站的进度条与真实站**根本不是一回事**（P7 的 parity 闸没覆盖到这条端点）。
      const board = demoReviewBoard({ state: s, rules: r, stageId: m[1] });
      const { submitted, total, missing, dimensionProgress } = board.progress;
      return { stageId: m[1], submitted, total, missing, dimensionProgress };
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
    // ⚠️ **专属错误码**：业务上的「单条记录不存在」也是 404（设计文档 §7.3 的三态口径），
    //    两者共用 NOT_FOUND ⇒ 「端点没实现」与「这条记录不在」**分不开** ⇒
    //    回归闸 platform/test/demo-api-parity.test.js 没法判定「演示站这一页是不是 404」。
    //    ⇒ 这里用 DEMO_ENDPOINT_MISSING 单独标记「**这个端点没实现**」。
    throw httpError(404, 'DEMO_ENDPOINT_MISSING', `演示版未实现该接口：${method} ${clean}`);
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

/**
 * 抓一个 JSON 资源，失败时给出**中文 + 可操作**的报错。
 * ⚠️ 为什么要包一层：浏览器在网络层失败时抛的是英文 TypeError（"Failed to fetch"），
 *    原样透出去既看不懂也不知道该干什么（这是 P7 浏览器实测抓到的真实报错）。
 * @param {string} url      资源地址
 * @param {string} what     资源的人类名（用于报错文案）
 */
async function fetchJson(url, what) {
  let res;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new Error(`${what}加载失败：无法连接服务器（${url}），请检查网络后刷新重试`);
  }
  if (!res.ok) throw new Error(`${what}加载失败：${url}（HTTP ${res.status}）`);
  return res.json();
}

export async function loadDemoSeed(url = SEED_URL) {
  return fetchJson(url, '演示种子数据');
}

export async function loadDemoRules(base = RULES_BASE) {
  const loaded = {};
  const missing = [];
  for (const [key, file] of Object.entries(DEMO_RULE_FILES)) {
    const url = base + file;
    let res;
    try {
      res = await fetch(url);
    } catch (cause) {
      throw new Error(`演示规则配置加载失败：无法连接服务器（${url}），请检查网络后刷新重试`);
    }
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
    compliance: loaded.compliance,
    // ⚠️ P9：赛程表（落地页的赛程脊）
    schedule: loaded.schedule,
  };
}

let runtimePromise = null;

/**
 * 取演示运行时（种子 + 规则）。
 *
 * ⚠️⚠️ **失败绝不能被缓存**（P7 浏览器实测踩到的真事故）：
 *   演示站重新发布时，nginx 会在那一瞬间短暂拿不到静态文件 ⇒ 首次 fetch 失败。
 *   如果这里把**被 reject 的 promise** 存进 runtimePromise，
 *   之后**每一次**调用都抛同一个错 ⇒ 整个演示站永久瘫痪，
 *   而且错误态里那个「重试」按钮点了也永远不会好（重试的是同一份坏 promise）。
 *   ⇒ 失败时**清掉缓存**，让下一次调用重新加载。
 */
export function getDemoRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [seed, rules] = await Promise.all([loadDemoSeed(), loadDemoRules()]);
      return createDemoApi({ seed, rules });
    })().catch((err) => {
      runtimePromise = null;   // ⚠️ 失败不缓存 ⇒ 下次调用重新加载（可恢复）
      throw err;
    });
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

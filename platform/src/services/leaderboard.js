// src/services/leaderboard.js — 榜单用例编排
// 依据：设计文档 §6.3 / §6.6 + 任务书 §七 + R-RNK-01/02/03/04
//   ⛔ 双榜并列不合成一个总分：A 榜（名次/奖金/MVP）与 B 榜（商业战绩/完赛/资源解锁）
//      走两条不同的表、两条不同的计算路径，任何一条都不读另一条的分数字段。
//   ⛔ 可见性在 API 层过滤：本模块【读】原始 payload，【写】快照；对外一律走 applyVisibility。
//   ⛔ 告警的内部明细同理在 API 层裁剪（applyWarningVisibility，在 applyVisibility 内执行）：
//      公开端点（滚动总榜 / 赛段榜）只有拿到 `audit:read` 的人才能看到 `detail` 与
//      队伍 id / 英文维度键 —— 前端不判断权限。
//      ⚠️ 裁剪口径放在**领域层唯一入口**（src/domain/visibility.js），演示站与正式站
//         复用同一份 ⇒ 不可能再漂（以前两处各写一份，演示站把内部明细泄给了匿名访客）。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getDefaultRules } from '../config.js';
import { rankTeams } from '../domain/ranking.js';
import { computeStagePoints, computeMvp, computePersonalPoints } from '../domain/points.js';
import { behaviorScore } from '../domain/behavior.js';
import { applyVisibility } from '../domain/visibility.js';
import { computeTeamTier } from './tier.js';
import { cmpStr } from '../domain/util.js';
import * as repo from '../db/repo/leaderboard.js';
import * as pointsRepo from '../db/repo/points.js';
import * as tierRepo from '../db/repo/tiers.js';

const SCOPES = ['rank', 'business', 'personal'];
const indexBy = (rows, k, v) => Object.fromEntries(rows.map((r) => [r[k], r[v]]));

/**
 * 仓储行（snake_case）→ 域函数契约（camelCase）。
 * ⚠️ 终审 C-1 的根因就在这条缝上：`points_ledger` 的行是 snake_case（`user_id`），
 *    而域函数 `computePersonalPoints` 的契约是 camelCase（`entry.userId`）。
 *    两者对不上时，域函数里的 `if (!entry.userId) continue;` 会把**每一行**都当成
 *    「这条流水没有归属人」**静默丢弃** ⇒ 个人积分榜恒为空（R-RNK-10 整条线生产上不可观测），
 *    而且**不报任何错** —— 流水明明写进去了，只是永远读不出来。
 *    仓储层统一返回原始行（与 leaderboard / teams / tiers 仓储同风格），
 *    所以**翻译只在这一处发生一次**；`test/leaderboard-service.test.js` 有一条端到端用例
 *    把「仓储真实行 → 域函数 → 榜单响应」三者绑住，防止再漂。
 */
function toLedgerEntry(row) {
  return {
    id: row.id,
    editionId: row.edition_id,
    stageId: row.stage_id,
    teamId: row.team_id,
    userId: row.user_id,
    kind: row.kind,
    points: row.points,
    createdAt: row.created_at,
  };
}

/** ★ 行为分独立通路：behavior_events → behaviorScore。绝不从 stage_results 派生。 */
function behaviorScoresByTeam(db, teamIds, R) {
  // ⚠️ 终审 I-3 的配套修正：「一条没提交」= 0 分，**不是**「没有可比较的值」。
  //    行为分对每支队都有定义：提交了就按 rules/behavior-points.json 计分，没提交就是 0。
  //    原实现只给「有事件」的队伍返回值，其余留 null → 破同分链读到 null 会判定
  //    「本组缺少可比较的值」⇒ **整组都不用行为分**（warning: tiebreak_key_unusable）
  //    ⇒ 提交过的队伍与没提交的队伍永远并列，行为分这一级形同虚设（正是 I-3 要修的东西）。
  //    ⛔ 与 R-RNK-07 的口径区别：互评分「空交付队无记录」= 该维度**没被应用**（不可用）；
  //    行为分「没提交」= 这一维度的值**就是 0**（可用）。两者不能混为一谈。
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  const out = Object.fromEntries(ids.map((id) => [id, 0]));
  const events = pointsRepo.listBehaviorEventsByTeams(db, ids);
  if (!events.length) return out;
  const byTeam = new Map();
  for (const e of events) {
    if (!byTeam.has(e.team_id)) byTeam.set(e.team_id, []);
    byTeam.get(e.team_id).push(e);
  }
  const behaviorConfig = { ...(R.behavior || {}), evidenceRequirements: R.criteria?.behaviorEvidence || undefined };
  for (const [teamId, list] of byTeam) out[teamId] = behaviorScore({ events: list, behaviorConfig }).total;
  return out;
}

/** 单赛段的完整排名计算（名次 + 包内积分 + 告警），A 榜与滚动总榜共用 */
function buildStageRanking({ db, stage, R }) {
  const results = repo.listStageResults(db, stage.id);
  const peerTotals = indexBy(repo.listPeerScoreTotals(db, stage.id), 'team_id', 'peer_score');
  const entTotals = indexBy(repo.listEnterpriseRawTotals(db, stage.id), 'team_id', 'enterprise_raw');
  const extraTotals = indexBy(repo.listTiebreakVoteTotals(db, stage.id), 'team_id', 'tiebreak_extra');
  const behaviorTotals = behaviorScoresByTeam(db, results.map((r) => r.team_id), R);

  const candidates = results.map((r) => ({
    teamId: r.team_id,
    total: r.total,
    seatP: r.seat_p,
    seatE: r.seat_e,
    peerScore: peerTotals[r.team_id] ?? null,
    enterpriseRaw: entTotals[r.team_id] ?? null,
    behaviorScore: behaviorTotals[r.team_id] ?? null,
    tiebreakExtra: extraTotals[r.team_id] ?? null,
  }));
  const byTeam = Object.fromEntries(candidates.map((c) => [c.teamId, {
    peerScore: c.peerScore, enterpriseRaw: c.enterpriseRaw,
    behaviorScore: c.behaviorScore, tiebreakExtra: c.tiebreakExtra,
  }]));

  const isFinal = stage.scoring_config_key === 'final';
  const tiebreakData = { isFinal, byTeam };
  const ranking = rankTeams({
    teams: candidates, tiebreakChain: R.tiebreak?.chain || [], tiebreakData, pointsConfig: R.points,
  });

  // ★ 名次积分按【任务包内】排名发放（设计文档 §6.3「任务包内全量战队排名」）
  const packageOf = new Map(results.map((r) => [r.team_id, r.task_package_id]));
  const groups = new Map();
  for (const c of candidates) {
    const key = packageOf.get(c.teamId) ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const points = {};
  const packageRank = {};
  for (const [, group] of groups) {
    const ranked = rankTeams({
      teams: group, tiebreakChain: R.tiebreak?.chain || [], tiebreakData, pointsConfig: R.points,
    });
    for (const p of computeStagePoints({ ordered: ranked.ordered, pointsConfig: R.points })) points[p.teamId] = p.points;
    for (const o of ranked.ordered) packageRank[o.teamId] = o.rank;
  }
  return { results, ranking, points, packageRank, warnings: collectWarnings({ db, stage, ranking }) };
}

/** 降级告警：来自 P2 的计算快照 + 破同分链自身的告警（绝不静默） */
function collectWarnings({ db, stage, ranking }) {
  const out = [];
  const snap = repo.getLatestComputation(db, stage.id);
  if (!snap) {
    out.push({ source: 'computation', code: 'NO_COMPUTATION_SNAPSHOT',
      message: '本赛段尚无计算快照，当前榜单可能不是最终结果' });
  } else {
    try {
      for (const w of JSON.parse(snap.output_json || '{}').warnings || []) out.push({ source: 'computation', ...w });
    } catch {
      out.push({ source: 'computation', code: 'SNAPSHOT_PARSE_FAILED',
        message: '计算快照无法解析，榜单已降级展示，请人工核对' });
    }
  }
  for (const w of ranking.warnings) out.push({ source: 'tiebreak', ...w });
  return out;
}

function buildRankPayload({ db, stage, R }) {
  const built = buildStageRanking({ db, stage, R });
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, stage.edition_id), 'team_id', 'tier');
  const rows = built.ranking.ordered.map((row) => {
    const res = built.results.find((r) => r.team_id === row.teamId);
    return {
      teamId: row.teamId,
      teamName: res?.team_name ?? null,
      taskPackageId: res?.task_package_id ?? null,
      rank: row.rank,
      tiedWith: row.tiedWith,
      packageRank: built.packageRank[row.teamId] ?? null,
      points: built.points[row.teamId] ?? 0,
      total: row.total,
      tier: tiers[row.teamId] ?? 'D',
      enterpriseName: null,   // ⛔ 企业名不公示（S10 §8）
      // ⛔ 评分构成（seatP / seatE / peerScore / behaviorScore）不进公开榜，
      //    需要的人看 P4 的 trace 抽屉（按权限）。
    };
  });
  return {
    scope: 'rank', stageId: stage.id, editionId: stage.edition_id, rows,
    warnings: built.warnings, rankStyle: built.ranking.rankStyle, tiebreakApplied: built.ranking.applied,
  };
}

function buildBusinessPayload({ db, stage }) {
  const results = repo.listStageResults(db, stage.id);
  const milestones = tierRepo.listMilestonesByTeams(db, results.map((r) => r.team_id));
  const signoffs = tierRepo.listSignoffsByTeams(db, results.map((r) => r.team_id));
  const rows = results.map((r) => {
    const ms = milestones.filter((m) => m.team_id === r.team_id);
    const ids = new Set(ms.map((m) => m.id));
    const signed = new Set(signoffs.filter((s) => ids.has(s.milestone_id) && !s.revoked_at).map((s) => s.milestone_id));
    return {
      teamId: r.team_id,
      teamName: r.team_name,
      taskPackageId: r.task_package_id,
      milestones: ms.map((m) => ({ key: m.key, label: m.label, achieved: signed.has(m.id), signed: signed.has(m.id) })),
      achievedCount: signed.size,
      milestoneCount: ms.length,
      // ⛔ 这里【不】放任何评分与签字人：评分与签字人不公开（S10 §0.3 / R-ENT-04）
    };
  });
  return { scope: 'business', stageId: stage.id, editionId: stage.edition_id, rows, warnings: [] };
}

function buildPersonalPayload({ db, stage, R }) {
  // ★ 必须过 toLedgerEntry：仓储给的是 snake_case 行，域函数认的是 camelCase（终审 C-1）
  const ledger = pointsRepo.listLedgerByEdition(db, stage.edition_id).map(toLedgerEntry);
  const personal = computePersonalPoints({ ledger, pointsConfig: R.points });
  const names = repo.listUserNames(db, personal.rows.map((r) => r.userId));
  const rows = personal.rows.map((r) => ({
    userId: r.userId, name: names[r.userId] ?? null, total: r.total, rank: r.rank, byKind: r.byKind,
  }));
  return { scope: 'personal', stageId: stage.id, editionId: stage.edition_id, rows, warnings: [] };
}

const buildPayload = ({ db, stage, scope, rules: R }) => (scope === 'rank'
  ? buildRankPayload({ db, stage, R })
  : scope === 'business' ? buildBusinessPayload({ db, stage }) : buildPersonalPayload({ db, stage, R }));

/**
 * 告警可见性裁剪的**能力判定**：有 `audit:read` 才能看内部明细。
 * ⛔ 真正的裁剪在领域层唯一入口（src/domain/visibility.js 的 applyWarningVisibility，
 *    由 applyVisibility 内部调用）—— 本函数只回答「这个人有没有审计权限」。
 * ⚠️ `can(null, ...)` 安全返回 false（见 src/auth/permissions.js）⇒ 匿名访客自动落到「无权限」。
 */
function canAuditWarnings({ db, viewer }) {
  return viewer ? can(viewer, 'audit:read', null, db) : false;
}

/** 对外读接口：先算原始 payload，再在 API 层过滤 */
export function getLeaderboard({ db, stageId, scope = 'rank', viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  if (!SCOPES.includes(scope)) throw new AppError(400, 'INVALID_SCOPE', `榜单口径非法：${scope}`);
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  if (scope === 'rank' && R.visibility?.rank?.public === false) {
    throw new AppError(403, 'LEADERBOARD_DISABLED', '该赛段榜单已关闭');
  }
  if (scope === 'business' && R.visibility?.business?.milestoneProgressPublic === false) {
    throw new AppError(403, 'LEADERBOARD_DISABLED', '该赛段 B 榜已关闭');
  }
  const out = applyVisibility({
    payload: buildPayload({ db, stage, scope, rules: R }),
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope,
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: (R.ranks?.tiers || []).map((t) => t.key),
      // ⛔ 告警的内部明细也要在 API 层裁剪（公开端点任何人可看）
      canAudit: canAuditWarnings({ db, viewer }),
    },
  });
  return out;
}

/** 滚动总榜：全程公开（任务书 §七 明文） */
export function getRollingLeaderboard({ db, editionId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  if (R.visibility?.rank?.public === false) throw new AppError(403, 'LEADERBOARD_DISABLED', '总榜已关闭');
  const stages = repo.listEditionStages(db, editionId);
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, editionId), 'team_id', 'tier');
  const totals = new Map();
  // ★ 终审 I-2：滚动总榜原来把各赛段的降级告警**全部丢掉**（warnings 恒为 []），
  //    而 `#/leaderboard`（不带 stageId）默认就走滚动总榜 ⇒ 用户看到的是一份「干净」的榜单，
  //    底层计算其实已降级。违反 P3-9「降级告警置顶」与 R-AUD-05「静默的空产出比报错更危险」。
  //    口径：滚动总榜汇总**每一届赛段**的告警，并标注来源赛段（stageId / stageKey / stageName），
  //    让读者知道是哪一段降级了；前端按 stageName 渲染。
  const warnings = [];

  for (const stage of stages) {
    const built = buildStageRanking({ db, stage, R });
    for (const w of built.warnings) {
      warnings.push({ ...w, stageId: stage.id, stageKey: stage.key, stageName: stage.name });
    }
    if (!built.results.length) continue;
    for (const row of built.ranking.ordered) {
      const res = built.results.find((r) => r.team_id === row.teamId);
      const cur = totals.get(row.teamId) || {
        teamId: row.teamId, teamName: res?.team_name ?? null, taskPackageId: res?.task_package_id ?? null,
        points: 0, stages: 0, bestRank: null,
      };
      cur.points += built.points[row.teamId] ?? 0;
      cur.stages += 1;
      cur.bestRank = cur.bestRank === null ? row.rank : Math.min(cur.bestRank, row.rank);
      totals.set(row.teamId, cur);
    }
  }

  const rows = [...totals.values()]
    .map((r) => ({ ...r, tier: tiers[r.teamId] ?? 'D' }))
    .sort((a, b) => b.points - a.points || (a.bestRank ?? 99) - (b.bestRank ?? 99) || cmpStr(a.teamId, b.teamId));

  const out = applyVisibility({
    payload: {
      scope: 'rolling', editionId, rows, warnings,
      stages: stages.map((s) => ({ id: s.id, key: s.key, name: s.name })),
    },
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope: 'rank',   // 滚动总榜与 A 榜同口径：全员公开
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: (R.ranks?.tiers || []).map((t) => t.key),
      // ⛔ 滚动总榜是**公开端点**（任何人可看）⇒ 告警的内部明细必须在这里裁掉
      canAudit: canAuditWarnings({ db, viewer }),
    },
  });
  return out;
}

/** 发榜：显式动作。写快照 + 审计日志 + 积分流水（追加式 + 幂等）。 */
export function publishLeaderboard({ db, editionId, stageId, actorId, now, rules = null }) {
  const R = rules || getDefaultRules();
  const user = getUserById(db, actorId);
  if (!can(user, 'stage:compute', { scopeType: 'edition', scopeId: editionId }, db)) {
    throw new AppError(403, 'FORBIDDEN', '无发榜权限');
  }
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const createdAt = now ?? new Date().toISOString();

  const snapshots = {};
  for (const scope of SCOPES) {
    const payload = buildPayload({ db, stage, scope, rules: R });   // 原始快照（内部可见）
    const id = randomUUID();
    repo.insertSnapshot(db, { id, editionId, stageId, scope, payloadJson: JSON.stringify(payload), createdAt });
    snapshots[scope] = { id, scope, createdAt };
  }

  // ★ 发榜前重算段位：段位记录是榜单快照与段位公示的依据，
  //    不重算就永远是兜底的 D 段（P3-15）。
  const tierUpdates = [];
  for (const row of repo.listStageResults(db, stageId)) {
    if (tierUpdates.some((t) => t.teamId === row.team_id)) continue;
    tierUpdates.push(computeTeamTier({ db, teamId: row.team_id, now: createdAt, rules: R }));
  }

  const awarded = {
    stage: awardStagePoints({ db, editionId, stageId, rules: R, createdAt }),
    mvp: awardMvp({ db, editionId, stageId, rules: R, createdAt }),
  };
  repo.insertAuditLog(db, {
    id: randomUUID(), actorId, action: 'leaderboard.publish', entity: 'stage', entityId: stageId,
    detailJson: JSON.stringify({ editionId, stageId, snapshots, awarded }), createdAt,
  });
  return { editionId, stageId, snapshots, awarded, createdAt };
}

/** 名次积分写入流水：只增不改 + 幂等（同一赛段同一队伍不重复发） */
function awardStagePoints({ db, editionId, stageId, rules: R, createdAt }) {
  const built = buildStageRanking({ db, stage: repo.getStage(db, stageId), R });
  const existing = new Set(pointsRepo.listLedgerByStage(db, stageId).map((r) => `${r.team_id}|${r.kind}`));
  const awarded = [];
  for (const row of built.ranking.ordered) {
    const pts = built.points[row.teamId] ?? 0;
    if (!pts) continue;
    if (existing.has(`${row.teamId}|stage_rank`)) continue;    // 幂等
    for (const m of repo.listTeamMembers(db, row.teamId)) {
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId: row.teamId, userId: m.user_id,
        kind: 'stage_rank', points: pts, createdAt,
      });
    }
    awarded.push({ teamId: row.teamId, points: pts });
  }
  return awarded;
}

/**
 * MVP：4 赛段总积分 + S4 路演评审综合，每任务包 1 个（写入个人积分流水）
 *
 * ★ 终审 I-1 的修正：MVP 是【届期级】的最终奖项，而发榜是【赛段级】动作 ——
 *    让赛段级动作产生届期级奖项是**层级错配**。
 *    原实现每次发榜都算一遍 MVP，幂等键却按【当前发榜的赛段】查
 *    ⇒ 每发一个赛段就再写一条同额流水（发 st_1 写一条、发 st_2 又写一条，金额还一样），
 *    个人积分被重复累加；而且在路演赛段之前发榜时，MVP 金额缺了路演分而偏小，
 *    积分只增不改 ⇒ 后面补不回来。
 *    修正后的口径（两条，缺一不可）：
 *      ① 【发放时机】只在【路演赛段】发榜时发放 —— 路演评审综合分是 MVP 公式的
 *         最后一个输入（任务书 §七「4 赛段总积分 + S4 路演评审综合」）。
 *      ② 【幂等键】(届期, 队伍) —— 同一支队的 MVP 整届只发一次，跨赛段发榜不再重发。
 *    ⛔ 本届没有路演赛段、或路演赛段尚无评分结果 ⇒ **不发 MVP**
 *       （公式缺最后一个输入，不做半个公式的奖 —— 见 P3 计划「已知限制」）。
 */
function awardMvp({ db, editionId, stageId, rules: R, createdAt }) {
  const stages = repo.listEditionStages(db, editionId);
  const roadshowStage = stages.find((s) => s.kind === 'roadshow');
  // ① 发放时机：只有路演赛段发榜才发 MVP
  if (!roadshowStage || roadshowStage.id !== stageId) return [];
  const roadshowScores = repo.listStageResults(db, roadshowStage.id)
    .map((r) => ({ teamId: r.team_id, score: r.total }));
  if (!roadshowScores.length) return [];      // 路演还没评分 → 公式的最后一个输入缺失 → 不发

  const stagePoints = [];
  const packageOf = new Map();
  for (const stage of stages) {
    if (stage.kind === 'roadshow') continue;
    const built = buildStageRanking({ db, stage, R });
    for (const row of built.ranking.ordered) {
      const res = built.results.find((r) => r.team_id === row.teamId);
      stagePoints.push({ teamId: row.teamId, stageId: stage.key, points: built.points[row.teamId] ?? 0 });
      packageOf.set(row.teamId, res?.task_package_id ?? null);
    }
  }
  if (!stagePoints.length) return [];

  // MVP 决胜口径在 criteria.json（P3 自有），computeMvp 只认 pointsConfig.mvp → 服务层合并注入
  const mvpPointsConfig = {
    ...R.points,
    mvp: { ...R.points.mvp, tiebreak: R.criteria?.mvp?.tiebreak },
  };
  const byPackage = new Map();
  for (const p of stagePoints) {
    const key = packageOf.get(p.teamId) ?? '__none__';
    if (!byPackage.has(key)) byPackage.set(key, []);
    byPackage.get(key).push(p);
  }

  // ② 幂等键 = (届期, 队伍)：同一支队的 MVP 整届只发一次（跨赛段发榜不再重发）
  const existing = new Set(
    pointsRepo.listLedgerByEdition(db, editionId)
      .filter((r) => r.kind === 'mvp')
      .map((r) => r.team_id),
  );
  const awarded = [];
  for (const [pkgId, points] of byPackage) {
    // ★ 路演名次积分是【包内第几名】→ 必须先按包过滤，否则外队会挤掉本包真冠军（P3-27）
    const pkgTeamIds = new Set(points.map((p) => p.teamId));
    const pkgRoadshowScores = roadshowScores.filter((r) => pkgTeamIds.has(r.teamId));
    const out = computeMvp({
      stagePoints: points, roadshowScores: pkgRoadshowScores, packageId: pkgId, pointsConfig: mvpPointsConfig,
    });
    if (!out.mvp) continue;
    const teamId = out.mvp.teamId;
    if (!pkgTeamIds.has(teamId)) continue;      // 防御：获奖队必须属于本任务包
    if (existing.has(teamId)) continue;    // 幂等（届期级）
    // MVP 积分口径：rules/criteria.mvp.awardPointsSource = 'stage_points_sum'
    const awardPoints = points.filter((p) => p.teamId === teamId).reduce((s, p) => s + (Number(p.points) || 0), 0);
    for (const m of repo.listTeamMembers(db, teamId)) {
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId, userId: m.user_id,
        kind: 'mvp', points: awardPoints, createdAt,
      });
    }
    awarded.push({ teamId, packageId: pkgId, points: awardPoints });
  }
  return awarded;
}

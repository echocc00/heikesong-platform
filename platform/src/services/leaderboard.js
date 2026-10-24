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
import { buildReverseAuditTasks, runDetection, toDetectionPeerReviews } from './anticheat.js';
import { getTiebreakExtraScores } from './tiebreak.js';
import { cmpStr } from '../domain/util.js';
import { withTransaction } from '../db/tx.js';
// ⚠️ 从 **core** 模块 import（不是 review-state.js）：
//   review-state.js 是**可选模块**（路由层动态加载；模块不在 ⇒ 申诉端点 503，
//   但平台必须照常启动）⇒ 发榜这条**始终在场**的路径不能静态依赖它。
//   状态机内核（迁移表 / transition / 终稿推进）已抽到 core 模块 ⇒ 两边共用同一份实现。
import { finalizeStageResult } from './review-state-core.js';
import * as repo from '../db/repo/leaderboard.js';
import { listPeerReviews } from '../db/repo/peer-reviews.js';
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
  // ⛔ P11：**破同分复议分必须走服务层**（getTiebreakExtraScores），不能用仓储层那份 SQL 聚合。
  //    仓储层的 `listTiebreakVoteTotals` 是它的**孪生实现**，少了两条口径：
  //      ① 「只消费**已关闭**的轮次」—— 还在开放投票的轮次，其当前均值会被当成最终复议分消费
  //         ⇒ **榜单随投票进行而漂移**（services/tiebreak.js 文件头第 ⑥ 条修的就是这件事，SQL 那份没跟上）；
  //      ② 「同一队多轮取**最新一轮**」。
  //    ⇒ 一旦投了票但轮次还没关，榜单就会变 —— 这与「破同分必须可复算」直接冲突。
  const extraTotals = getTiebreakExtraScores({ db, stageId: stage.id, teamIds: results.map((r) => r.team_id) });
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

function buildRankPayload({ db, stage, R, built = null }) {
  // ⚠️ `built` 可由调用方传入（发榜路径已经算过一次 ⇒ 复用，别算两遍）；
  //    读路径不传 ⇒ 这里现算。
  const ranking = built ?? buildStageRanking({ db, stage, R });
  const tiers = indexBy(tierRepo.listLatestTiersByEdition(db, stage.edition_id), 'team_id', 'tier');
  const rows = ranking.ranking.ordered.map((row) => {
    const res = ranking.results.find((r) => r.team_id === row.teamId);
    return {
      teamId: row.teamId,
      teamName: res?.team_name ?? null,
      taskPackageId: res?.task_package_id ?? null,
      rank: row.rank,
      tiedWith: row.tiedWith,
      packageRank: ranking.packageRank[row.teamId] ?? null,
      points: ranking.points[row.teamId] ?? 0,
      total: row.total,
      tier: tiers[row.teamId] ?? 'D',
      enterpriseName: null,   // ⛔ 企业名不公示（S10 §8）
      // ⛔ 评分构成（seatP / seatE / peerScore / behaviorScore）不进公开榜，
      //    需要的人看 P4 的 trace 抽屉（按权限）。
    };
  });
  return {
    scope: 'rank', stageId: stage.id, editionId: stage.edition_id, rows,
    warnings: ranking.warnings, rankStyle: ranking.ranking.rankStyle, tiebreakApplied: ranking.ranking.applied,
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

const buildPayload = ({ db, stage, scope, rules: R, built = null }) => (scope === 'rank'
  ? buildRankPayload({ db, stage, R, built })
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
  // ⚠️ **口径标注（2026-10-24 评审轮）**：滚动总榜累计的是**各赛段的内存积分**
  //    （buildStageRanking 当场算出来的），而 `points_ledger` 流水里**只有已发榜**
  //    赛段的积分 ⇒ **未发榜赛段的预估分也被算进总榜** ⇒ 两个口径并存。
  //    ⇒ 响应里必须**明说**（否则读榜的人会把总榜当最终积分，而发榜后数字会变）。
  //    ⚠️ 「已发榜」的判据 = `stage_results.rank` 已回写（rank 只在发榜时写，见 F7）。
  const unpublishedStages = [];

  for (const stage of stages) {
    const built = buildStageRanking({ db, stage, R });
    for (const w of built.warnings) {
      warnings.push({ ...w, stageId: stage.id, stageKey: stage.key, stageName: stage.name });
    }
    if (!built.results.length) continue;
    // ⚠️ 判据 = **该赛段有没有发榜快照**（leaderboard_snapshots）。
    //    ⛔ 不用 `stage_results.rank IS NOT NULL` 判：那列是**发榜时**回写的，
    //    但种子数据会预置 rank ⇒ 会把没发过榜的赛段误判成「已发榜」。
    //    ⇒ 「已发榜」的权威记录是快照（有快照 = 发过榜 = 积分已进 points_ledger）。
    const published = repo.listSnapshotsByStage(db, stage.id).length > 0;
    if (!published) {
      unpublishedStages.push({ id: stage.id, key: stage.key, name: stage.name });
    }
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
      // ⚠️ 未发榜赛段（其预估分已计入总榜）—— 见上面的口径标注
      unpublishedStages,
      pointsIncludeUnpublishedStages: unpublishedStages.length > 0,
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
  // ⛔ P11 修正：原先只认**届期级**授权 ⇒「赛段级授权」的 `stage:compute` 明明能
  //    `POST /api/stages/:id/compute`（路由层认赛段级），却发不了榜 ⇒ 前后端口径不一致。
  //    现在两种都认（全局授权与角色授权在 can() 里本来就放行）。
  const allowed = can(user, 'stage:compute', { scopeType: 'edition', scopeId: editionId }, db)
    || can(user, 'stage:compute', { scopeType: 'stage', scopeId: stageId }, db);
  if (!allowed) {
    throw new AppError(403, 'FORBIDDEN', '无发榜权限');
  }
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const createdAt = now ?? new Date().toISOString();

  // ⛔ F12：**没有计算结果的赛段不得发榜**。
  //    修复前这条路径对「算过没有」零检查 ⇒ 对一个从未算过的赛段发榜会**成功**，
  //    产出一个**空榜**，而且 `leaderboard.publish` 审计照写不误
  //    （实测 getPublishState → published:true、snapshotCount:3、rows 为 0）。
  //    ⇒ 「发榜」的对象是**赛段结果**：没有结果就没有可发的东西（发出来是空榜），
  //      而且 F7 的名次回写也无处可写。
  //    ⚠️ 判据为什么用「**stage_results 非空**」而不是「有没有计算快照」：
  //      重算中途失败时 computeStage 已把旧结果清空、而旧快照还在
  //      ⇒ 只看快照会放行一个**空榜**。结果才是发榜的对象。
  //      （「没有计算快照」这件事由 collectWarnings 的 NO_COMPUTATION_SNAPSHOT 告警暴露，
  //        它是**告警**不是**闸门** —— 快照缺失不影响「结果是否存在」这个事实。）
  if (!repo.listStageResults(db, stage.id).length) {
    throw new AppError(409, 'STAGE_NOT_COMPUTED', '该赛段还没有计算结果，不能发榜（请先计算再发榜）');
  }

  // ⚠️ F37：**整体包进一个事务**。
  //    修复前的写入序列是「写 3 个快照 → 写档位 → 记积分 → 写 MVP 积分 → 写审计」，
  //    **没有事务** ⇒ 中途失败（例如 MVP 分写入时外键失败）会留下**半成品**：
  //    快照已写、赛段积分已写、档位已写，却**没有审计行、也没有 MVP 积分**，
  //    而 `getPublishState` 还报 `published: true` ⇒ R-AUD-01 依赖的审计轨迹缺失。
  //    （同一份纪律，compute 路径遵守了、publish 路径没有 —— 见 src/services/compute.js。）
  const published = withTransaction(db, () => {
    // 一次排名结果，发榜全程复用（buildStageRanking 不便宜：破同分/行为分/企业分都要算）
    const built = buildStageRanking({ db, stage, R });

    // ⚠️ F7：**名次 / 并列 / 积分必须回写 stage_results**。
    //    这三列 P2 建表时留了空位并约定「P3 来填」，P3 从来没填 ⇒
    //    公开榜单的 rank / points / tiedWith 恒为 null，而排序退化成 team_id 序
    //    （**低分队排在高分队前面**）⇒ 榜单的名次是错的。
    //    ⇒ 现在发榜时把 rankTeams 产出的名次与名次积分落库。
    //    ⚠️ 口径：`rankTeams` 给的 `tiedWith` 是「并列组里除自己外的队 id 数组」，
    //    而本列是 INTEGER ⇒ 落库的是**并列队伍数**（0 = 不并列）。
    for (const row of built.ranking.ordered) {
      repo.updateStageResultRanking(db, {
        stageId: stage.id,
        teamId: row.teamId,
        rank: row.rank,
        tiedWith: Array.isArray(row.tiedWith) ? row.tiedWith.length : 0,
        points: built.points[row.teamId] ?? 0,
      });
    }

    const snapshots = {};
    for (const scope of SCOPES) {
      const payload = buildPayload({ db, stage, scope, rules: R, built });   // 原始快照（内部可见）
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

    // ⚠️ 2026-10-24 评审轮：排名结果**算一次**（事务内数据不变）⇒ 往下传，
    //    不再让 awardStagePoints / awardMvp / 反向审计各自重算一遍。
    const stageAward = awardStagePoints({ db, editionId, stageId, rules: R, createdAt, built });
    const mvpAward = awardMvp({ db, editionId, stageId, rules: R, createdAt, built });
    // ⚠️ B1：corrections 提到 **awarded 对象**上（不是挂在数组上）
    //    ⇒ `JSON.stringify` 不会丢 ⇒ 发榜审计里能看到「为什么多/扣一笔」。
    //    ⚠️ `awarded.stage` / `awarded.mvp` **仍是数组**（既有契约不动 ⇒ 既有测试不动）。
    const awarded = {
      stage: stageAward.rows,
      mvp: mvpAward.rows,
      corrections: { stage: stageAward.corrections, mvp: mvpAward.corrections },
    };

    // ⚠️ F36：**终稿落库 ⇒ 复核状态推进到 FINALIZED**。
    //    修复前全仓**没有任何一处**生产 FINALIZED ⇒ `fileAppeal` 对 team_result 永远 409
    //    ⇒「提交申诉 → 裁决 → 撤销终稿 → 重算」整条链在生产上不可达。
    //    ⇒ 现在随终稿一起写这条迁移（与终稿同事务 ⇒ 要么都有、要么都没有）。
    const reviewState = finalizeStageResult({
      db, stageId: stage.id, actorId, reason: '发榜终稿', now: createdAt,
    });

    repo.insertAuditLog(db, {
      id: randomUUID(), actorId, action: 'leaderboard.publish', entity: 'stage', entityId: stageId,
      detailJson: JSON.stringify({ editionId, stageId, snapshots, awarded, reviewState: reviewState.state }),
      createdAt,
    });
    return {
      editionId, stageId, snapshots, awarded, reviewState: reviewState.state,
      createdAt, reverseAuditTasks: buildTopReverseAuditTasks({ db, stage, R, built }),
    };
  });

  // ⚠️ **F47：R-RNK-08「同分队伍互投率过高 ⇒ 组委会复核」原来永远拿不到数据。**
  //    detectTiedMutualPeerRate 需要两样东西：**最终名次**（同分组）与**互投的队伍对**。
  //    而全站唯一的生产调用点（src/services/compute.js）在**计算期**传的是 `results: []`
  //    （名次是发榜时破同分链跑完才有的）⇒ 这条检测**永远不可能触发**
  //    ⇒ 规则写在纸上，链路是死的。
  //    ⇒ 现在在**发榜之后**再跑一次：
  //      ① 名次：读**已落库**的 stage_results.rank（发榜回写，F7）
  //         —— 同一名次（同分组）才会被算作「同分队伍互投」；
  //      ② 互评：读 peer_reviews（队 → 队；互评在本仓**只**存在这张表）。
  //    ⚠️ 检测 ≠ 处罚：只建 flag（status='open'），不改分、不封号、不自动裁决。
  //    ⚠️ 检测失败**不许**让发榜失败（榜已经发出去了）⇒ 降级成一条显式告警，不静默。
  //    ⚠️ events / scoreStats / users 传空：这三个检测器的输入口径都在**计算阶段**
  //    跑过了（见 src/services/compute.js），这里不重复、不改口径；
  //    互评会重跑（互评可能是在破同分链里才产生的，比计算期更全）。
  const warnings = [];
  try {
    const detection = runDetection({
      db,
      stageId: stage.id,
      results: repo.listStageResults(db, stage.id)
        .filter((r) => r.rank !== null && r.rank !== undefined)
        .map((r) => ({ teamId: r.team_id, rank: r.rank })),
      peerReviews: toDetectionPeerReviews(listPeerReviews(db, stage.id)),
      events: [],
      scoreStats: [],
      users: [],
      rules: R,
      now: createdAt,
    });
    if (detection?.created?.length) {
      warnings.push({
        code: 'anticheat_flags_created',
        message: `发榜检测出 ${detection.created.length} 条疑似异常，已进人工复核队列（只告警，不改分）`,
        flags: detection.created.length,
      });
    }
  } catch (err) {
    warnings.push({
      code: 'anticheat_detection_failed',
      message: `发榜后的反作弊检测未能完成：${String(err?.message ?? err)}（检测失败不影响已发出的榜单）`,
    });
  }

  return { ...published, warnings };
}

/**
 * TOP 名单反向抽查任务（R-JDG-16 / S7 §4.1「组委会对 TOP10 作品电话回访」）。
 *
 * ⛔ P11：这份清单原先**只有服务层纯函数**（buildReverseAuditTasks），没有任何生产调用方
 *    ⇒ TOP 名单回访这件事在产品里**根本做不了**。现在发榜时一并产出。
 * ⚠️ 口径：只给**名次**与**未撤回的里程碑签字**，不代劳、不自动结案（检测 ≠ 处罚）。
 */
function buildTopReverseAuditTasks({ db, stage, R, topN = 10, built: builtArg = null }) {
  const built = builtArg ?? buildStageRanking({ db, stage, R });
  const results = built.ranking.ordered.map((row) => ({
    teamId: row.teamId,
    rank: row.rank,
    total: row.total,
  }));
  const signoffs = [];
  for (const row of results.slice(0, topN)) {
    for (const s of tierRepo.listSignoffsByTeam(db, row.teamId)) {
      // ⛔ 撤回的签字不算「已签字」—— 回访时要能看出「签了又撤」
      if (s.revoked_at) continue;
      signoffs.push({ ...s, teamId: row.teamId });
    }
  }
  return buildReverseAuditTasks({ results, signoffs, topN });
}

/**
 * 发榜状态（读口）：这个赛段发过榜没有？发了什么？TOP 回访清单是什么？
 *
 * ⛔ P11：原先**没有任何读口**能回答「这个赛段发了榜没有」——
 *    前端只能靠「有没有快照」猜，页面刷新后就不知道自己刚做过什么。
 */
export function getPublishState({ db, stageId, rules = null, topN = 10 }) {
  const R = rules || getDefaultRules();
  const stage = repo.getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const snaps = repo.listSnapshotsByStage(db, stageId);
  const published = snaps.length > 0;
  return {
    stageId,
    editionId: stage.edition_id,
    published,
    publishedAt: published ? snaps[snaps.length - 1].created_at : null,
    snapshots: snaps.map((s) => ({ id: s.id, scope: s.scope, createdAt: s.created_at })),
    reverseAuditTasks: published ? buildTopReverseAuditTasks({ db, stage, R, topN }) : [],
    warnings: published ? [] : [{ code: 'STAGE_NOT_PUBLISHED', message: '该赛段尚未发榜：榜单快照、段位记录与名次积分都还没写' }],
  };
}

/**
 * 名次积分写入流水：**只增不改 + 更正走新记录**（INTERFACES.md §0「追加式」）。
 *
 * ⛔ P11 修正：原实现拿「同一赛段同一队伍不重复发」当幂等 ⇒ **重发榜时名次变了也不改分**。
 *    榜单快照是新的、段位是重算的，唯独个人积分还停在上一轮 ⇒ 奖金依据与榜单对不上，
 *    而且**没有任何告警**（静默的不一致比报错更危险）。
 *    现在改成**差额更正**：把「本轮该发多少」与「已发多少」逐人相减，
 *    差多少就补/扣多少，差额本身作为**新记录**写进流水（原记录一个字都不动 ⇒ 仍满足「只增不改」）。
 *
 * ⚠️ 口径边界（写在这里，避免以后被人当成 bug 改掉）：
 *   · **只纠正当前在册成员**：已离队的成员保留他已挣到的分（与 R-RNK-10「终生上榜」一致）；
 *   · **中途入队的成员**在下次发榜时补齐他应得的那份（因为他此前没有流水行）；
 *   · 队内成员之间的份额是**同额**的（该队名次积分），不按贡献分配。
 */
function awardStagePoints({ db, editionId, stageId, rules: R, createdAt, built: builtArg = null }) {
  // ⚠️ 2026-10-24 评审轮：发榜链路里 buildStageRanking 被跑 **4 次**
  //    （主调用 / awardStagePoints / awardMvp / 反向审计）⇒ 同一份数据算四遍。
  //    事务内数据不变 ⇒ 算一次往下传即可（⚠️ 事务内**不能**看到自己写的结果，
  //    所以复用主调用那份才是对的；这里只是省掉三次重复计算）。
  const built = builtArg ?? buildStageRanking({ db, stage: repo.getStage(db, stageId), R });
  // 本轮该发多少：队 → 名次积分
  const desired = new Map();
  for (const row of built.ranking.ordered) {
    desired.set(row.teamId, built.points[row.teamId] ?? 0);
  }
  // 已发多少：逐人累加（同一队有多人 ⇒ 每人一份）
  const already = new Map();
  for (const r of pointsRepo.listLedgerByStage(db, stageId)) {
    if (r.kind !== 'stage_rank') continue;
    const key = `${r.team_id}|${r.user_id}`;
    already.set(key, (already.get(key) ?? 0) + (Number(r.points) || 0));
  }
  // 参与过本赛段名次积分的队伍（含「本轮掉出前三」的队 —— 它们要被扣回差额）
  const teams = new Set(desired.keys());
  for (const key of already.keys()) teams.add(String(key).split('|')[0]);

  const awarded = [];
  const corrections = [];
  for (const teamId of teams) {
    const pts = desired.get(teamId) ?? 0;
    for (const m of repo.listTeamMembers(db, teamId)) {
      const key = `${teamId}|${m.user_id}`;
      const delta = pts - (already.get(key) ?? 0);
      if (!delta) continue;
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId, userId: m.user_id,
        kind: 'stage_rank', points: delta, createdAt,
      });
      corrections.push({ teamId, userId: m.user_id, points: delta });
    }
    if (pts) awarded.push({ teamId, points: pts });
  }
  // ⚠️ **B1（2026-10-24 评审轮）：corrections 原来挂在数组上 ⇒ JSON.stringify 后恒为 undefined**
  //    ⇒ 发榜审计里看不到「为什么多/扣一笔」（奖金场景下这是要能追溯的）。
  //    ⇒ 改成**对象**返回：{ rows, corrections }（⛔ 不是给数组挂属性 ——
  //    JSON.stringify 只序列化数组的**索引**元素，挂在数组上的自定义属性会被丢掉）。
  return { rows: awarded, corrections };
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
function awardMvp({ db, editionId, stageId, rules: R, createdAt, built: builtArg = null }) {
  const stages = repo.listEditionStages(db, editionId);
  const roadshowStage = stages.find((s) => s.kind === 'roadshow');
  // ① 发放时机：只有路演赛段发榜才发 MVP
  if (!roadshowStage || roadshowStage.id !== stageId) return { rows: [], corrections: [] };
  const roadshowScores = repo.listStageResults(db, roadshowStage.id)
    .map((r) => ({ teamId: r.team_id, score: r.total }));
  if (!roadshowScores.length) return { rows: [], corrections: [] };   // 路演还没评分 → 公式的最后一个输入缺失 → 不发

  const stagePoints = [];
  const packageOf = new Map();
  for (const stage of stages) {
    if (stage.kind === 'roadshow') continue;
    // ⚠️ 2026-10-24 评审轮：**当前赛段**的排名结果由发榜主调用算好并传进来
    //    ⇒ 直接复用（省掉一次重复计算）；**其它赛段**的排名是 MVP 公式的输入
    //    ⇒ 必须各算各的（不是冗余）。
    const built = stage.id === stageId && builtArg
      ? builtArg
      : buildStageRanking({ db, stage, R });
    for (const row of built.ranking.ordered) {
      const res = built.results.find((r) => r.team_id === row.teamId);
      stagePoints.push({ teamId: row.teamId, stageId: stage.key, points: built.points[row.teamId] ?? 0 });
      packageOf.set(row.teamId, res?.task_package_id ?? null);
    }
  }
  if (!stagePoints.length) return { rows: [], corrections: [] };

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
  //    ⛔ P11 修正：原实现是「这一队发过就整队跳过」⇒ **重发路演赛段时 MVP 赢家变了也不改分**
  //    （榜单快照是新的，MVP 积分却还是上一轮的）。现在改成**差额更正**，与名次积分同款口径：
  //    「本轮该发多少」减「已发多少」，差额作为新记录写进流水（原记录不动）。
  const already = new Map();   // `${teamId}|${userId}` → 已发合计
  const alreadyTeams = new Set();
  for (const r of pointsRepo.listLedgerByEdition(db, editionId)) {
    if (r.kind !== 'mvp') continue;
    alreadyTeams.add(r.team_id);
    const key = `${r.team_id}|${r.user_id}`;
    already.set(key, (already.get(key) ?? 0) + (Number(r.points) || 0));
  }

  // 先把本轮每个包的 MVP 赢家与分值算出来
  const desired = new Map();   // teamId → { points, packageId }
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
    // MVP 积分口径：rules/criteria.mvp.awardPointsSource = 'stage_points_sum'
    const awardPoints = points.filter((p) => p.teamId === teamId).reduce((s, p) => s + (Number(p.points) || 0), 0);
    desired.set(teamId, { points: awardPoints, packageId: pkgId });
  }

  // 差额更正：本轮没人拿 MVP 的队（已发过的）要把差额扣回去
  const teams = new Set([...desired.keys(), ...alreadyTeams]);
  const awarded = [];
  const corrections = [];
  for (const teamId of teams) {
    const want = desired.get(teamId);
    const target = want ? want.points : 0;
    for (const m of repo.listTeamMembers(db, teamId)) {
      const key = `${teamId}|${m.user_id}`;
      const delta = target - (already.get(key) ?? 0);
      if (!delta) continue;
      pointsRepo.insertLedgerEntry(db, {
        id: randomUUID(), editionId, stageId, teamId, userId: m.user_id,
        kind: 'mvp', points: delta, createdAt,
      });
      corrections.push({ teamId, userId: m.user_id, points: delta });
    }
    if (want) awarded.push({ teamId, packageId: want.packageId, points: want.points });
  }
  // ⚠️ B1：corrections 必须**对象**返回（数组挂属性 ⇒ JSON.stringify 后丢失）
  return { rows: awarded, corrections };
}

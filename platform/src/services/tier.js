// src/services/tier.js — 队伍段位查询
// 依据：S10 §2.2 段位表 + §2.3 权益 + 冲突裁决 C-02（公示范围）
import { AppError } from '../errors.js';
import { getDefaultRules } from '../config.js';
import { cmpStr } from '../domain/util.js';
import { applyVisibility } from '../domain/visibility.js';
import { randomUUID } from 'node:crypto';
import { computeTier, applyTierDemotion, classifyDepartment, isDataOrPrototypeMilestone } from '../domain/tier.js';
import { listTeamRows } from '../db/repo/teams.js';
import * as repo from '../db/repo/leaderboard.js';
import * as tierRepo from '../db/repo/tiers.js';

export function getTeamTier({ db, teamId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  const team = repo.getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const tiers = R.ranks?.tiers || [];
  const order = tiers.map((t) => t.key);
  const record = tierRepo.getLatestTierRecord(db, teamId);
  const tier = record?.tier ?? 'D';
  const idx = Math.max(0, order.indexOf(tier));
  const publicFromIdx = Math.max(0, order.indexOf(R.visibility?.rank?.publicFromTier || 'C'));
  const isPublic = idx >= publicFromIdx;
  const isMember = viewer ? repo.isTeamMember(db, teamId, viewer.id) : false;
  const isAdmin = viewer ? viewer.is_superadmin === 1 : false;
  if (!isPublic && !isMember && !isAdmin) {
    // D 段不公示排名 → 外部读者拿不到（单条不满足 → 404）
    throw new AppError(404, 'NOT_FOUND', '战队不存在');
  }
  const milestones = tierRepo.listMilestonesByTeam(db, teamId);
  const out = {
    teamId, teamName: team.name, tier, tierName: tiers.find((t) => t.key === tier)?.name ?? tier,
    benefits: (R.ranks?.benefits || {})[tier] || [], neverUnlocks: R.ranks?.neverUnlocks || [],
    reasons: record?.reasons_json ? JSON.parse(record.reasons_json) : [],
    progress: {
      milestones: milestones.map((m) => ({ key: m.key, label: m.label })),
      milestoneCount: record?.milestone_count ?? 0,
    },
  };
  if (isPublic) out.tierRank = tierBoardRank(db, team, order);   // C 段及以上公示名次（C-02）
  else out.self = true;                                            // 本人进度卡：不含名次
  return out;
}

function tierBoardRank(db, team, order) {
  const board = [...tierRepo.listLatestTiersByEdition(db, team.edition_id)].sort((a, b) => {
    const ia = order.indexOf(a.tier);
    const ib = order.indexOf(b.tier);
    if (ia !== ib) return ib - ia;                    // 段位高的在前
    if (a.milestone_count !== b.milestone_count) return b.milestone_count - a.milestone_count;
    return cmpStr(a.team_id, b.team_id);              // 确定性兜底
  });
  const idx = board.findIndex((t) => t.team_id === team.id);
  return idx < 0 ? null : idx + 1;
}

/**
 * 段位榜：C 段及以上公示队名与名次；D 段只给本人进度卡（冲突裁决 C-02）。
 * ⛔ 可见性在 API 层过滤：本函数产出**原始 payload**，过滤交给 applyVisibility(scope='tier')。
 *    —— 这也是 applyVisibility 里 `scope==='tier'` 分支的**唯一生产调用方**
 *    （Task 7 台账 W26 发现：该分支当时零调用方，`viewerTeamIds` 在榜单服务里是死接线）。
 * @param editionId 届期 id（由调用方解析：缺省取当届）
 */
export function getTierBoard({ db, editionId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  const order = (R.ranks?.tiers || []).map((t) => t.key);
  const teams = listTeamRows(db, { editionId });
  const records = new Map(tierRepo.listLatestTiersByEdition(db, editionId).map((r) => [r.team_id, r]));
  const rows = teams.map((t) => {
    const rec = records.get(t.id);
    const milestones = tierRepo.listMilestonesByTeam(db, t.id);
    return {
      teamId: t.id,
      teamName: t.name,
      tier: rec?.tier ?? 'D',                 // 没有段位记录 = D 段（兜底口径）
      tierRank: null,
      milestoneCount: rec?.milestone_count ?? 0,
      progress: {
        milestones: milestones.map((m) => ({ key: m.key, label: m.label })),
        milestoneCount: rec?.milestone_count ?? 0,
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
    payload: { scope: 'tier', editionId, rows, warnings: [] },
    viewer,
    visibilityConfig: R.visibility,
    context: {
      scope: 'tier',
      viewerTeamIds: repo.listTeamIdsByUser(db, viewer?.id),
      tierOrder: order,
    },
  });
}

/**
 * ★ 段位计算（唯一的生产入口）：里程碑 + 企业签字 → 段位 → 写 tier_records。
 * ⚠️ 没有这个函数，Task 4 的整套段位引擎就只是死代码（队伍永远兜底 D 段）。
 * ⛔ 域函数签名定死（不能加参数），所以「配置 → 标志位」的解析必须在这一层做：
 *    isDataOrPrototype   ← rules.criteria.tier.dataOrPrototypeMilestones
 *    isBusinessDepartment ← 部门关键词 + unknownDepartmentCountsAsBusiness
 * @param record 是否写入 tier_records（发榜时写；只读查询用 false）
 */
export function computeTeamTier({ db, teamId, now, rules = null, record = true }) {
  const R = rules || getDefaultRules();
  const criteria = R.criteria || {};
  const tierCfg = criteria.tier || {};
  const milestones = tierRepo.listMilestonesByTeam(db, teamId);
  const signoffs = tierRepo.listSignoffsByTeam(db, teamId);
  const keyOf = new Map(milestones.map((m) => [m.id, m.key]));

  const active = signoffs.filter((s) => !s.revoked_at);
  const signedIds = new Set(active.map((s) => s.milestone_id));

  const domainMilestones = milestones.map((m) => ({
    key: m.key,
    countsTowardTier: m.counts_toward_tier !== 0,
    // R-PTS-01：默认 requires_signoff=1 → 必须有未撤回的企业签字才算达成
    achieved: m.requires_signoff === 0 || signedIds.has(m.id),
    isDataOrPrototype: isDataOrPrototypeMilestone(m.key, criteria),
  }));

  const domainSignoffs = active.map((s) => {
    const kind = classifyDepartment(s.department, criteria);
    const isBusinessDepartment = kind === 'business'
      || (kind === 'unknown' && tierCfg.unknownDepartmentCountsAsBusiness === true);
    return {
      milestoneKey: keyOf.get(s.milestone_id) ?? null,
      department: s.department,
      revokedAt: null,
      isBusinessDepartment,
    };
  });

  const computed = computeTier({ milestones: domainMilestones, signoffs: domainSignoffs, ranksConfig: R.ranks });

  // 闲置降档：相对**本次重算出的**段位降（不相对历史记录 → 不会每发一次榜再降一档）
  const lastAt = tierRepo.getTeamLastActivityAt(db, teamId);
  const at = now ?? new Date().toISOString();
  const daysSinceLastActivity = lastAt
    ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(lastAt)) / 86400000))
    : 0;
  const demotion = applyTierDemotion({
    tier: computed.tier,
    daysSinceLastActivity,
    revokedSignoffs: [],     // ⛔ 撤回归档已由「重算」体现，再喂一次会重复降级
    ranksConfig: R.ranks,
  });
  const tier = demotion.demoted ? demotion.tier : computed.tier;

  if (record) {
    tierRepo.insertTierRecord(db, {
      id: randomUUID(), teamId, tier,
      milestoneCount: computed.milestoneCount,
      businessSignoffCount: computed.businessSignoffCount,
      reasonsJson: JSON.stringify([...computed.reasons, ...(demotion.demoted ? [demotion.reason] : [])]),
      computedAt: at,
    });
  }
  const tierName = (R.ranks?.tiers || []).find((t) => t.key === tier)?.name ?? tier;
  return {
    ...computed, tier, tierName,
    demoted: demotion.demoted, demotionReason: demotion.reason, publish: demotion.publish,
  };
}

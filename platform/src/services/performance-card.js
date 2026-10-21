// src/services/performance-card.js — 项目商业战绩卡
// 依据：设计文档 §9 关键界面「7 类里程碑勾选式 + 企业签字标识 + 不显示签字人」
//   + S10 §4 商业里程碑 7 类 + R-ENT-04「B 榜签字不公开」
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getDefaultRules } from '../config.js';
import * as repo from '../db/repo/leaderboard.js';
import * as tierRepo from '../db/repo/tiers.js';

export function getPerformanceCard({ db, teamId, viewer = null, rules = null }) {
  const R = rules || getDefaultRules();
  const team = repo.getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const isMember = viewer ? repo.isTeamMember(db, teamId, viewer.id) : false;
  const isAdmin = viewer ? viewer.is_superadmin === 1 : false;
  if (!isMember && !isAdmin && !can(viewer, 'team:read', { scopeType: 'team', scopeId: teamId }, db)) {
    throw new AppError(404, 'NOT_FOUND', '战队不存在');   // 单条不满足 → 404
  }
  const milestones = tierRepo.listMilestonesByTeam(db, teamId);
  const signoffs = tierRepo.listSignoffsByTeam(db, teamId);
  const items = milestones.map((m) => {
    const sg = signoffs.find((s) => s.milestone_id === m.id && !s.revoked_at);
    return {
      key: m.key, label: m.label, achieved: Boolean(sg), signed: Boolean(sg),
      // ⛔ 不返回签字人：签字人不公开（S10 §0.3 / R-ENT-04）
    };
  });
  const record = tierRepo.getLatestTierRecord(db, teamId);
  const tier = record?.tier ?? 'D';
  return {
    teamId, teamName: team.name, taskPackageId: team.task_package_id ?? null,
    items, achievedCount: items.filter((i) => i.achieved).length, total: items.length,
    tier, benefits: (R.ranks?.benefits || {})[tier] || [], neverUnlocks: R.ranks?.neverUnlocks || [],
  };
}

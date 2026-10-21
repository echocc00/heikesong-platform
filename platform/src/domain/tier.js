// src/domain/tier.js — 段位计算与降级（纯函数）
// 依据：S10 §2.1 段位锚定企业签字里程碑 + §2.2 段位表 + §2.3 降级与权益
//   + R-PTS-01/02/03/04/05/06 + 冲突裁决 C-02（公示范围）
//   ⛔ 段位【只】影响同分排序，不制造额外名额（S10 §2.3 要点 3）——本模块不产出任何"名额"。
//   ⛔ 段位换资源不换钱：权益全部来自 ranks.benefits，ranks.neverUnlocks 常驻返回。
//   ✅ 段位锚定【企业签字的里程碑】：工作室能刷打卡，刷不到企业签字（R-PTS-01）。

/** 部门归类：命中业务关键词 → business；命中技术关键词 → technical；否则 unknown */
export function classifyDepartment(department, criteriaConfig) {
  const t = criteriaConfig?.tier || {};
  const biz = (t.businessDepartmentKeywords || []).map((k) => String(k).toLowerCase());
  const tech = (t.technicalDepartmentKeywords || []).map((k) => String(k).toLowerCase());
  const d = String(department ?? '').trim().toLowerCase();
  if (!d) return 'unknown';
  if (biz.some((k) => d.includes(k))) return 'business';
  if (tech.some((k) => d.includes(k))) return 'technical';
  return 'unknown';
}

/** 该里程碑是否计入 A 段的"含 ≥1 项数据接入或原型交付"附加条件 */
export function isDataOrPrototypeMilestone(key, criteriaConfig) {
  const list = criteriaConfig?.tier?.dataOrPrototypeMilestones || [];
  return list.includes(key);
}

/**
 * 计算段位。
 * milestones: [{ key, countsTowardTier, achieved, isDataOrPrototype? }]
 *   ⚠️ isDataOrPrototype 由服务层按 rules/criteria.tier 判定后写入（本函数只读不判）。
 * signoffs:   [{ milestoneKey, department, revokedAt, isBusinessDepartment? }]
 *   ⚠️ isBusinessDepartment 同理由服务层按 rules/criteria.tier 判定后写入。
 */
export function computeTier({ milestones, signoffs, ranksConfig }) {
  const tiers = ranksConfig?.tiers || [];
  const counted = (Array.isArray(milestones) ? milestones : [])
    .filter((m) => m && m.achieved === true && m.countsTowardTier !== false);
  const milestoneCount = counted.length;
  const dataOrPrototypeCount = counted.filter((m) => m.isDataOrPrototype === true).length;
  const active = (Array.isArray(signoffs) ? signoffs : []).filter((s) => s && !s.revokedAt);
  const businessSignoffCount = active.filter((s) => s.isBusinessDepartment === true).length;

  // 从最高档往下找第一个满足条件的（tiers 按门槛递增，P0 校验过严格递增）
  let chosen = null;
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    const t = tiers[i];
    if (milestoneCount < (t.minMilestones ?? 0)) continue;
    if (t.requiresDataOrPrototype && dataOrPrototypeCount < 1) continue;
    if (t.requiresBusinessSignoff && businessSignoffCount < 1) continue;
    chosen = t;
    break;
  }
  if (!chosen) chosen = tiers[0] || { key: 'D', name: '出题', minMilestones: 0 };

  const reasons = [`milestones=${milestoneCount}`];
  if (dataOrPrototypeCount) reasons.push(`data_or_prototype=${dataOrPrototypeCount}`);
  if (businessSignoffCount) reasons.push(`business_signoff=${businessSignoffCount}`);
  reasons.push(`tier=${chosen.key}`);

  return {
    tier: chosen.key,
    tierName: chosen.name ?? chosen.key,
    milestoneCount,
    businessSignoffCount,
    reasons,
    benefits: (ranksConfig?.benefits || {})[chosen.key] || [],
    neverUnlocks: ranksConfig?.neverUnlocks || [],
  };
}

/**
 * 段位降级。
 * 依据：S10 §2.3 要点 2「里程碑被撤回签字 → 降回对应档；连续 14 天零提交且无合理说明
 *   → 降 1 档并公示」+ R-PTS-04。
 * ⛔ 两条规则同时命中时【只降 1 档】（取较大值而不是叠加）：降级是"回到对应档"，不是惩罚。
 * ⛔ 永不低于 D 段。
 */
export function applyTierDemotion({ tier, daysSinceLastActivity, revokedSignoffs, ranksConfig }) {
  const demotion = ranksConfig?.demotion || {};
  const order = (ranksConfig?.tiers || []).map((t) => t.key);
  const current = order.includes(tier) ? tier : (order[0] ?? tier);
  const idx = Math.max(0, order.indexOf(current));

  const reasons = [];
  let levels = 0;
  if (demotion.onSignoffRevoked === true && (Array.isArray(revokedSignoffs) ? revokedSignoffs : []).length > 0) {
    reasons.push('signoff_revoked');
    levels = Math.max(levels, 1);
  }
  const inactiveDays = Number.isFinite(demotion.inactiveDays) ? demotion.inactiveDays : 14;
  const days = Number(daysSinceLastActivity) || 0;
  if (days >= inactiveDays) {
    reasons.push(`inactive_${inactiveDays}days`);
    levels = Math.max(levels, Number(demotion.inactiveDropLevels) || 1);
  }

  if (!levels) return { tier: current, demoted: false, reason: null, publish: false, from: current };
  const next = order[Math.max(0, idx - levels)] ?? current;
  return {
    tier: next,
    demoted: true,
    reason: reasons.join('+'),
    publish: demotion.publishDemotion === true,
    from: current,
  };
}

// src/db/repo/tiers.js — 段位记录、里程碑与企业签字 SQL
export function insertTierRecord(db, { id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt }) {
  db.prepare(`INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count,
    reasons_json, computed_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)`)
    .run(id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt);
}

export function getLatestTierRecord(db, teamId) {
  return db.prepare(`SELECT * FROM tier_records WHERE team_id = ? AND deleted_at IS NULL
    ORDER BY computed_at DESC, rowid DESC LIMIT 1`).get(teamId) ?? null;
}

/** 每支队伍最新的一条段位记录 */
export function listLatestTiersByEdition(db, editionId) {
  const rows = db.prepare(`SELECT tr.* FROM tier_records tr JOIN teams t ON t.id = tr.team_id
    WHERE t.edition_id = ? AND tr.deleted_at IS NULL ORDER BY tr.computed_at ASC, tr.rowid ASC`).all(editionId);
  const latest = new Map();
  for (const r of rows) latest.set(r.team_id, r);
  return [...latest.values()];
}

export function listMilestonesByTeam(db, teamId) {
  return db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY fixed_at ASC, key ASC').all(teamId);
}

export function listMilestonesByTeams(db, teamIds) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM milestones WHERE team_id IN (${ids.map(() => '?').join(',')})
    ORDER BY fixed_at ASC, key ASC`).all(...ids);
}

export function listSignoffsByTeam(db, teamId) {
  return db.prepare(`SELECT s.* FROM milestone_signoffs s JOIN milestones m ON m.id = s.milestone_id
    WHERE m.team_id = ? ORDER BY s.signed_at ASC`).all(teamId);
}

export function listSignoffsByTeams(db, teamIds) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare(`SELECT s.* FROM milestone_signoffs s JOIN milestones m ON m.id = s.milestone_id
    WHERE m.team_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.signed_at ASC`).all(...ids);
}

/**
 * 队伍最近一次「提交」的时间（R-PTS-04 降级规则里的「连续 N 天零提交」口径）。
 * ⛔ 只算队伍**自己**的产出：行为分事件 / 里程碑固定 / 企业签字。
 *    绝不算 points_ledger —— 发榜会写积分流水，算进去等于发榜把「零提交」刷新掉了，
 *    降级规则就永远不触发（发榜自我豁免）。
 */
export function getTeamLastActivityAt(db, teamId) {
  const row = db.prepare(`
    SELECT MAX(t) AS last_at FROM (
      SELECT MAX(created_at) AS t FROM behavior_events WHERE team_id = ?
      UNION ALL SELECT MAX(fixed_at) FROM milestones WHERE team_id = ?
      UNION ALL SELECT MAX(s.signed_at) FROM milestone_signoffs s JOIN milestones m ON s.milestone_id = m.id WHERE m.team_id = ?
    )`).get(teamId, teamId, teamId);
  return row?.last_at ?? null;
}

// src/db/repo/tiers.js — 段位记录、里程碑与企业签字 SQL
import { randomUUID } from 'node:crypto';
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

/**
 * 里程碑清单落表（R-STG-03：报名 / 组队时固定，赛程中不可自行新增）。
 * ⚠️ 清单来源是 teams.milestones_json（建队时按 rules/milestones.default.json 固定），
 *    这里把它落成**行** —— P3 的段位引擎与 B 榜只读这张表（两处同源，不共享规则字段）。
 * ⛔ requires_signoff 一律为 1：7 类里程碑都要有「确认」（企业签字或评委确认）才算达成。
 */
export function insertMilestones(db, { teamId, items, now }) {
  const stmt = db.prepare(`INSERT INTO milestones
    (id, team_id, stage_id, key, label, counts_toward_tier, fixed_at, requires_signoff, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?)`);
  for (const item of Array.isArray(items) ? items : []) {
    stmt.run(randomUUID(), teamId, item.key, item.label, item.countsTowardTier === false ? 0 : 1, now, now);
  }
}

export function getMilestone(db, milestoneId) {
  return db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId) ?? null;
}

/**
 * 企业签字：★ 只确认「这件事到底发生了没有」（客观事实，单签，不进总分）。
 *   与 P2 的 enterprise_confirmations（主观评分、双签、进总分）是**两张不同的表**。
 * 追加式：只增不改；撤回走 revoked_at 软删除（不物理删除、不改其它列）。
 */
export function insertSignoff(db, { id, milestoneId, enterpriseId, signatoryUserId, department, content, signedAt }) {
  db.prepare(`INSERT INTO milestone_signoffs
    (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
    VALUES (?,?,?,?,?,?,?,NULL)`).run(id, milestoneId, enterpriseId, signatoryUserId ?? null, department, content, signedAt);
}

export function getSignoff(db, signoffId) {
  return db.prepare('SELECT * FROM milestone_signoffs WHERE id = ?').get(signoffId) ?? null;
}

/** 撤回签字 = 软删除（置 revoked_at）；已撤回的返回 0（幂等） */
export function revokeSignoff(db, { id, revokedAt }) {
  const r = db.prepare('UPDATE milestone_signoffs SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(revokedAt, id);
  return Number(r.changes || 0);
}

// src/db/repo/points.js — 积分流水与行为分事件 SQL
// 依据：INTERFACES.md §0「追加式」条——评分/积分类记录只增不改，更正走新记录。
export function insertLedgerEntry(db, { id, editionId, stageId, teamId, userId, kind, points, createdAt }) {
  db.prepare(`INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, editionId, stageId ?? null, teamId ?? null, userId ?? null, kind, points, createdAt);
}

export function listLedgerByEdition(db, editionId) {
  return db.prepare('SELECT * FROM points_ledger WHERE edition_id = ? ORDER BY created_at ASC, id ASC').all(editionId);
}

export function listLedgerByStage(db, stageId) {
  return db.prepare('SELECT * FROM points_ledger WHERE stage_id = ? ORDER BY created_at ASC, id ASC').all(stageId);
}

export function insertBehaviorEvent(db, { id, teamId, userId, type, points, evidence, createdAt }) {
  db.prepare(`INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, teamId, userId ?? null, type, points, evidence ?? null, createdAt);
}

/** ★ 行为分的数据源：独立表，绝不从 stage_results 派生 */
export function listBehaviorEventsByTeams(db, teamIds) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM behavior_events WHERE team_id IN (${ids.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC`).all(...ids);
}

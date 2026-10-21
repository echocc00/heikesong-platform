// src/db/repo/leaderboard.js — 榜单相关 SQL
// 依据：INTERFACES.md §0「数据层」条——所有 SQL 收在 src/db/repo/，service/handler 内禁止裸 SQL。
import { randomUUID } from 'node:crypto';

export function getStage(db, stageId) {
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId) ?? null;
}

export function listEditionStages(db, editionId) {
  return db.prepare('SELECT * FROM stages WHERE edition_id = ? ORDER BY key ASC').all(editionId);
}

export function listStageResults(db, stageId) {
  return db.prepare(`
    SELECT sr.id, sr.stage_id, sr.team_id, sr.rank, sr.total, sr.seat_p, sr.seat_e,
           sr.tied_with, sr.points, sr.computation_id, sr.created_at,
           t.name AS team_name, t.task_package_id, t.edition_id
    FROM stage_results sr JOIN teams t ON t.id = sr.team_id
    WHERE sr.stage_id = ? ORDER BY sr.rank ASC, sr.team_id ASC`).all(stageId);
}

export function getTeam(db, teamId) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(teamId) ?? null;
}

export function listTeamMembers(db, teamId) {
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL').all(teamId);
}

export function listTeamIdsByUser(db, userId) {
  if (!userId) return [];
  return db.prepare('SELECT team_id FROM team_members WHERE user_id = ? AND left_at IS NULL')
    .all(userId).map((r) => r.team_id);
}

export function isTeamMember(db, teamId, userId) {
  if (!userId) return false;
  return Boolean(db.prepare(
    'SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL',
  ).get(teamId, userId));
}

export function listUserNames(db, userIds) {
  const ids = (Array.isArray(userIds) ? userIds : []).filter(Boolean);
  if (!ids.length) return {};
  const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const out = {};
  for (const r of rows) out[r.id] = r.name;
  return out;
}

/** 互评分：队伍收到的互评均分（破同分链第 3 项） */
export function listPeerScoreTotals(db, stageId) {
  return db.prepare(`SELECT to_team_id AS team_id, AVG(score) AS peer_score, COUNT(*) AS n
    FROM peer_reviews WHERE stage_id = ? GROUP BY to_team_id`).all(stageId);
}

/** 企业确认原始分：队伍的企业确认均分（破同分链第 4 项） */
export function listEnterpriseRawTotals(db, stageId) {
  return db.prepare(`SELECT team_id, AVG(raw_score) AS enterprise_raw, COUNT(*) AS n
    FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL GROUP BY team_id`).all(stageId);
}

/** 加时陈述复议分（破同分链第 2 项，仅决赛） */
export function listTiebreakVoteTotals(db, stageId) {
  return db.prepare(`SELECT v.team_id, AVG(v.score) AS tiebreak_extra, COUNT(*) AS n
    FROM tiebreak_votes v JOIN tiebreak_round r ON r.id = v.tiebreak_round_id
    WHERE r.stage_id = ? GROUP BY v.team_id`).all(stageId);
}

/** 最近一次计算快照：降级告警的来源（P2 写，P3 读） */
export function getLatestComputation(db, stageId) {
  return db.prepare(`SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = 'stage_score'
    ORDER BY revision DESC, created_at DESC LIMIT 1`).get(stageId) ?? null;
}

export function insertSnapshot(db, { id, editionId, stageId, scope, payloadJson, createdAt }) {
  db.prepare('INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, editionId, stageId ?? null, scope, payloadJson, createdAt);
}

export function insertAuditLog(db, { id = randomUUID(), actorId, action, entity, entityId, detailJson, createdAt }) {
  db.prepare('INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, actorId ?? null, action, entity ?? null, entityId ?? null, detailJson ?? null, createdAt);
}

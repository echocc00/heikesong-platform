// src/db/repo/peer-reviews.js — 互评
import { randomUUID } from 'node:crypto';

export function findPeerReviewsByRequestId(db, { stageId, fromTeamId = null, requestId }) {
  if (!requestId) return [];
  if (fromTeamId) {
    return db
      .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND request_id = ?')
      .all(stageId, fromTeamId, requestId);
  }
  // 赛段级查找：用于「同一个 requestId 是否被用于了不同内容」的判定
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND request_id = ?')
    .all(stageId, requestId);
}

export function findPeerReview(db, { stageId, fromTeamId, toTeamId }) {
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND to_team_id = ?')
    .get(stageId, fromTeamId, toTeamId) ?? null;
}

export function insertPeerReview(db, { stageId, fromTeamId, toTeamId, score, requestId = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, fromTeamId, toTeamId, score, requestId, now);
  return db.prepare('SELECT * FROM peer_reviews WHERE id = ?').get(id);
}

export function updatePeerReviewScore(db, { id, score, now }) {
  db.prepare('UPDATE peer_reviews SET score = ?, created_at = ? WHERE id = ?').run(score, now, id);
  return db.prepare('SELECT * FROM peer_reviews WHERE id = ?').get(id);
}

export function listPeerReviews(db, stageId) {
  return db.prepare('SELECT * FROM peer_reviews WHERE stage_id = ? ORDER BY from_team_id, to_team_id').all(stageId);
}

// src/db/repo/self-reviews.js — 自评测
import { randomUUID } from 'node:crypto';

export function findSelfReviewsByRequestId(db, { stageId, teamId = null, requestId }) {
  if (!requestId) return [];
  if (teamId) {
    return db
      .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND request_id = ?')
      .all(stageId, teamId, requestId);
  }
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND request_id = ?')
    .all(stageId, requestId);
}

export function findSelfReview(db, { stageId, teamId, dimension }) {
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND dimension = ?')
    .get(stageId, teamId, dimension) ?? null;
}

export function insertSelfReview(db, { stageId, teamId, dimension, rawScore, requestId = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, teamId, dimension, rawScore, now, requestId);
  return db.prepare('SELECT * FROM self_reviews WHERE id = ?').get(id);
}

export function updateSelfReviewScore(db, { id, rawScore, now }) {
  db.prepare('UPDATE self_reviews SET raw_score = ?, submitted_at = ? WHERE id = ?').run(rawScore, now, id);
  return db.prepare('SELECT * FROM self_reviews WHERE id = ?').get(id);
}

export function listSelfReviews(db, stageId) {
  return db.prepare('SELECT * FROM self_reviews WHERE stage_id = ? ORDER BY team_id, dimension').all(stageId);
}

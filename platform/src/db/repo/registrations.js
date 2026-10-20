// src/db/repo/registrations.js — 报名仓储
// 依据：INTERFACES.md §2（registrations 列清单）+ 设计文档 §5.2
import { randomUUID } from 'node:crypto';

const UPDATABLE = new Set([
  'level', 'level_final', 'decided_by', 'decided_at', 'decision_note', 'status',
]);

export function insertRegistration(db, {
  editionId,
  userId,
  answers,
  dimensionScores = null,
  rawScore = null,
  level = null,
  status = 'submitted',
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO registrations (
       id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
       level, level_final, decided_by, decided_at, decision_note,
       status, created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    id, editionId, userId,
    JSON.stringify(answers),
    dimensionScores ? JSON.stringify(dimensionScores) : null,
    rawScore, level, status, now,
  );
  return getRegistration(db, id);
}

export function getRegistration(db, id) {
  return db
    .prepare('SELECT * FROM registrations WHERE id = ? AND deleted_at IS NULL')
    .get(id) ?? null;
}

export function findActiveRegistration(db, userId, editionId) {
  return db
    .prepare(
      `SELECT * FROM registrations
       WHERE user_id = ? AND edition_id = ? AND deleted_at IS NULL`,
    )
    .get(userId, editionId) ?? null;
}

export function listRegistrationRows(db, {
  editionId = null, status = null, level = null, limit = 200, offset = 0,
} = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (level) { where.push('level = ?'); params.push(level); }
  params.push(limit, offset);
  return db
    .prepare(
      `SELECT * FROM registrations WHERE ${where.join(' AND ')}
       ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(...params);
}

export function updateRegistrationRow(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    db.prepare(`UPDATE registrations SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getRegistration(db, id);
}

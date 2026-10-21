// src/db/repo/appeals.js — 申诉仓储
// 依据：设计文档 §11.2（申诉状态机 + 申诉范围）
import { randomUUID } from 'node:crypto';

export function insertAppeal(db, {
  id = randomUUID(), subjectType, subjectId, filedBy = null, reason,
  status = 'submitted', now = new Date().toISOString(),
}) {
  db.prepare(
    `INSERT INTO appeals (id, subject_type, subject_id, filed_by, reason, status, decided_by, decided_at, decision_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(id, subjectType, subjectId, filedBy, reason, status, now);
  return id;
}

export function getAppeal(db, id) {
  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) ?? null;
}

export function listAppealRows(db, {
  status = null, subjectType = null, subjectId = null, limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (subjectType) { where.push('subject_type = ?'); params.push(subjectType); }
  if (subjectId) { where.push('subject_id = ?'); params.push(subjectId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM appeals ${clause}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM appeals ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

export function updateAppeal(db, { id, status, decidedBy = null, decidedAt = null, decisionNote = null }) {
  return db.prepare(
    'UPDATE appeals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?',
  ).run(status, decidedBy, decidedAt, decisionNote, id).changes;
}

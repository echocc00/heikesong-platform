// src/db/repo/editions.js — 届期仓储
// 依据：设计文档 §5.1 + R-OPS-09（模型必须带 edition × city 维度）
import { randomUUID } from 'node:crypto';

export function createEdition(db, {
  name, city, startsAt, endsAt, now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, city, startsAt, endsAt, now);
  return getEdition(db, id);
}

export function getEdition(db, id) {
  return db.prepare('SELECT * FROM editions WHERE id = ?').get(id) ?? null;
}

export function listEditions(db) {
  return db.prepare('SELECT * FROM editions ORDER BY starts_at').all();
}

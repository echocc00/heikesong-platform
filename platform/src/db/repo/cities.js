// src/db/repo/cities.js — 城市仓储
// 依据：INTERFACES.md §2（cities(id, name, edition_id)）
import { randomUUID } from 'node:crypto';

export function createCity(db, { name, editionId }) {
  const id = randomUUID();
  db.prepare('INSERT INTO cities (id, name, edition_id) VALUES (?, ?, ?)').run(
    id, name, editionId,
  );
  return db.prepare('SELECT * FROM cities WHERE id = ?').get(id);
}

export function listCitiesByEdition(db, editionId) {
  return db.prepare('SELECT * FROM cities WHERE edition_id = ? ORDER BY name').all(editionId);
}

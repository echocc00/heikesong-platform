// src/db/repo/teams.js — 战队仓储
// 依据：INTERFACES.md §2（teams 列清单）+ R-REG-01（建队即认领任务包）
import { randomUUID } from 'node:crypto';

const UPDATABLE = new Set([
  'name', 'captain_id', 'task_package_id', 'tier', 'status', 'milestones_json',
]);

export function insertTeam(db, {
  editionId,
  name,
  captainId,
  taskPackageId = null,
  tier = null,
  status = 'forming',
  milestones = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO teams (
       id, edition_id, name, captain_id, task_package_id, tier, status,
       milestones_json, created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id, editionId, name, captainId, taskPackageId, tier, status,
    milestones ? JSON.stringify(milestones) : null, now,
  );
  return getTeam(db, id);
}

export function getTeam(db, id) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

export function listTeamRows(db, {
  editionId = null, taskPackageId = null, captainId = null, status = null,
} = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  if (taskPackageId) { where.push('task_package_id = ?'); params.push(taskPackageId); }
  if (captainId) { where.push('captain_id = ?'); params.push(captainId); }
  if (status) { where.push('status = ?'); params.push(status); }
  return db
    .prepare(`SELECT * FROM teams WHERE ${where.join(' AND ')} ORDER BY created_at, id`)
    .all(...params);
}

export function updateTeamRow(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'milestones_json' && patch[k] && typeof patch[k] === 'object'
        ? JSON.stringify(patch[k])
        : patch[k],
    );
    db.prepare(`UPDATE teams SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getTeam(db, id);
}

// R-REG-01 + 顶层文档：每个任务包 2–3 支战队（上限在服务层校验）
export function countActiveTeamsByPackage(db, taskPackageId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM teams WHERE task_package_id = ? AND deleted_at IS NULL')
    .get(taskPackageId).n;
}

// src/db/repo/task-claims.js — 任务领取记录仓储
// 依据：R-OPS-13 / R-OPS-14（任务只能自主领取）
// ⛔ 「同一任务同时只能有一个有效领取」由 006_pools.sql 里的
//    部分唯一索引 ux_task_claims_active 保证，本文件不做"先查再插"的判断。
import { randomUUID } from 'node:crypto';

export function insertTaskClaim(db, { id = randomUUID(), taskId, teamId = null, userId, now }) {
  db.prepare(
    'INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(id, taskId, teamId, userId, now);
  return getActiveClaim(db, taskId);
}

export function getActiveClaim(db, taskId) {
  return db.prepare('SELECT * FROM task_claims WHERE task_id = ? AND released_at IS NULL').get(taskId) ?? null;
}

export function releaseTaskClaim(db, claimId, now) {
  return db
    .prepare('UPDATE task_claims SET released_at = ? WHERE id = ? AND released_at IS NULL')
    .run(now, claimId).changes;
}

export function listClaimsByUser(db, userId) {
  return db.prepare('SELECT * FROM task_claims WHERE user_id = ? ORDER BY claimed_at, id').all(userId);
}

export function countActiveClaims(db, taskId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get(taskId).n;
}

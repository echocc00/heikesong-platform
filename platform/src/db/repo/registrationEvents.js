// src/db/repo/registrationEvents.js — 报名状态事件仓储（只增不改）
// 依据：INTERFACES.md §0「追加式：评分/签字类记录只增不改」+ §2 registration_events
import { randomUUID } from 'node:crypto';

export function insertRegistrationEvent(db, {
  registrationId,
  fromStatus = null,
  toStatus,
  actorId = null,
  reason = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO registration_events
       (id, registration_id, from_status, to_status, actor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, registrationId, fromStatus, toStatus, actorId, reason, now);
  return id;
}

export function listRegistrationEvents(db, registrationId) {
  return db
    .prepare('SELECT * FROM registration_events WHERE registration_id = ? ORDER BY created_at, id')
    .all(registrationId);
}

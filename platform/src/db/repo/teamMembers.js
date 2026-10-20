// src/db/repo/teamMembers.js — 战队成员仓储
// 依据：R-REG-03（赛程中成员可持续招募汰换，退出报备）→ 保留进出历史，不硬删
import { randomUUID } from 'node:crypto';

export function insertTeamMember(db, {
  teamId, userId, role = 'member', now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO team_members (id, team_id, user_id, role, joined_at, left_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, teamId, userId, role, now);
  return id;
}

export function listActiveMembers(db, teamId) {
  return db
    .prepare('SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL ORDER BY joined_at, id')
    .all(teamId);
}

export function listMemberHistory(db, teamId) {
  return db
    .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at, id')
    .all(teamId);
}

export function findActiveMembershipByUser(db, userId) {
  return db
    .prepare('SELECT * FROM team_members WHERE user_id = ? AND left_at IS NULL LIMIT 1')
    .get(userId) ?? null;
}

export function markMemberLeft(db, id, leftAt = new Date().toISOString()) {
  return db
    .prepare('UPDATE team_members SET left_at = ? WHERE id = ? AND left_at IS NULL')
    .run(leftAt, id).changes;
}

export function countActiveMembers(db, teamId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL')
    .get(teamId).n;
}

// R-REG-04：并队期限 = 最后一次离队时间 + singleMemberMergeDeadlineDays（由服务层加天数）
export function lastLeaveAt(db, teamId) {
  return db
    .prepare('SELECT MAX(left_at) AS t FROM team_members WHERE team_id = ? AND left_at IS NOT NULL')
    .get(teamId).t ?? null;
}

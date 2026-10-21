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
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare('SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL ORDER BY joined_at, rowid')
    .all(teamId);
}

export function listMemberHistory(db, teamId) {
  return db
    .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at, rowid')
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

// src/db/repo/teamMembers.js —— 【追加】到 P1 已建的文件里
// 依据：R-OPS-13 / R-OPS-14（自主领取的人必须是某个队的成员）
// ⚠️ 本文件由 P1 建立。本阶段【追加】下面两个函数，P1 已有的函数保持不动
//    （签名一个字都不改）。
//
// hasActiveMembership：这个人**是不是这支队的**在队成员。
// ⛔ 不能用 P1 的 countActiveMembers(db, teamId) > 0 代替 ——
//    那问的是「这支队还有没有在队成员」，不是「这个人是不是在队成员」。
//    两者在「队里只剩别人」时结论完全相反（前者 true、后者 false）。
export function hasActiveMembership(db, teamId, userId) {
  const row = db
    .prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL')
    .get(teamId, userId);
  return row !== undefined;
}

// listMemberTeams：这个人在哪些队（可选按届期过滤）。
// 依据：R-REG-03「赛程中成员可持续招募汰换」→ 只要 left_at IS NULL 就算在队。
export function listMemberTeams(db, userId, { editionId = null } = {}) {
  const sql = editionId
    ? `SELECT t.* FROM teams t
        JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? AND m.left_at IS NULL AND t.edition_id = ?
       ORDER BY t.id`
    : `SELECT t.* FROM teams t
        JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? AND m.left_at IS NULL
       ORDER BY t.id`;
  const rows = editionId ? db.prepare(sql).all(userId, editionId) : db.prepare(sql).all(userId);
  return rows;
}

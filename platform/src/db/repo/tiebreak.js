// src/db/repo/tiebreak.js — 加时陈述轮次与投票
// 依据：S7 §3.3（R-JDG-19）+ 设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束
import { randomUUID } from 'node:crypto';

export function insertTiebreakRound(db, { stageId, kind = 'statement', tiedTeamIds, statementDeadline, voteDeadline = null, createdBy, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tiebreak_round (id, stage_id, kind, tied_team_ids_json, statement_deadline, vote_deadline, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(id, stageId, kind, JSON.stringify(tiedTeamIds), statementDeadline, voteDeadline, createdBy, now);
  return getTiebreakRound(db, id);
}

export function getTiebreakRound(db, id) {
  return db.prepare('SELECT * FROM tiebreak_round WHERE id = ?').get(id) ?? null;
}

/**
 * 轮次列表。
 * ⚠️ 排序必须**确定**：只按 `created_at` 排是不够的 —— 同一秒开启的两个轮次
 *    `created_at` 相同，而 SQLite 的 ORDER BY 对并列行**不保证稳定** →
 *    「同一队多轮取最新一轮」就取到了哪一轮随缘 → 破同分链的结果**不可复算**。
 *    `rowid` 是隐式的插入序，作为兜底排序键（全局约定：兜底排序键一律用 rowid）。
 */
export function listTiebreakRounds(db, { stageId, status = null } = {}) {
  if (status) {
    return db
      .prepare('SELECT * FROM tiebreak_round WHERE stage_id = ? AND status = ? ORDER BY created_at, rowid')
      .all(stageId, status);
  }
  return db.prepare('SELECT * FROM tiebreak_round WHERE stage_id = ? ORDER BY created_at, rowid').all(stageId);
}

export function closeTiebreakRoundRow(db, id, now) {
  db.prepare("UPDATE tiebreak_round SET status = 'closed' WHERE id = ?").run(id);
  return getTiebreakRound(db, id);
}

/**
 * 写入一票。
 * ⛔ 依赖主键 (tiebreak_round_id, voter_id, team_id) 保证「一人一队一票」——
 *    应用层「先查再插」在并发下会插出两票（设计文档 §6.4【决策】）。
 */
export function insertTiebreakVote(db, { roundId, voterId, teamId, score, now }) {
  db.prepare(
    `INSERT INTO tiebreak_votes (tiebreak_round_id, voter_id, team_id, score, voted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(roundId, voterId, teamId, score, now);
  return db.prepare('SELECT * FROM tiebreak_votes WHERE tiebreak_round_id = ? AND voter_id = ? AND team_id = ?')
    .get(roundId, voterId, teamId);
}

export function listTiebreakVotes(db, roundId) {
  return db.prepare('SELECT * FROM tiebreak_votes WHERE tiebreak_round_id = ? ORDER BY voter_id, team_id').all(roundId);
}

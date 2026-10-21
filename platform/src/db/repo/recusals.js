// src/db/repo/recusals.js — 回避记录（R-JDG-09 留档）
// 依据：S7 §4.2（回避必须留档，赛后 6 个月可查）
import { randomUUID } from 'node:crypto';

export function insertRecusal(db, { stageId, judgeId, teamId = null, reason, source = 'declared', auditBy = null, action = 'recused', now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, judgeId, teamId, reason, source, now, auditBy, action);
  return db.prepare('SELECT * FROM recusal_records WHERE id = ?').get(id);
}

export function listRecusals(db, { stageId, judgeId = null } = {}) {
  if (judgeId) {
    return db
      .prepare('SELECT * FROM recusal_records WHERE stage_id = ? AND judge_id = ? ORDER BY declared_at, rowid')
      .all(stageId, judgeId);
  }
  // ⚠️ `declared_at` 并列时必须有**确定性**兜底（全局约定 #43：用 rowid，不用随机 UUID）。
  //    「取最后一条记录」是回避撤销语义的基础（同秒申报两条时必须可复现）。
  return db.prepare('SELECT * FROM recusal_records WHERE stage_id = ? ORDER BY declared_at, rowid').all(stageId);
}

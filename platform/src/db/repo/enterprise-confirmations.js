// src/db/repo/enterprise-confirmations.js — 企业确认（R2 双签 / R-JDG-14 签字内容）
import { randomUUID } from 'node:crypto';

export function insertEnterpriseConfirmation(db, { stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId = null, signatoryUserId = null, content = '', now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO enterprise_confirmations
       (id, stage_id, team_id, enterprise_id, dimension, raw_score, cross_judge_id, signatory_user_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content, now);
  return db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ?').get(id);
}

export function listEnterpriseConfirmations(db, { stageId, teamId = null } = {}) {
  if (teamId) {
    return db
      .prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND team_id = ? AND deleted_at IS NULL ORDER BY created_at')
      .all(stageId, teamId);
  }
  return db
    .prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(stageId);
}

export function softDeleteEnterpriseConfirmation(db, id, now) {
  db.prepare('UPDATE enterprise_confirmations SET deleted_at = ? WHERE id = ?').run(now, id);
}

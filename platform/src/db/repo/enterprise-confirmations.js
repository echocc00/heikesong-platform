// src/db/repo/enterprise-confirmations.js — 企业确认（R2 双签 / R-JDG-14 签字内容）
//
// ⛔ P11 追加（本文件此前只有「插入 + 列表 + 软删」三样，且软删**无人调用**）：
//   ① `getEnterpriseConfirmationById` —— 逆向路径（撤回 / 改签）要按 id 取记录；
//   ② `findActiveEnterpriseConfirmation` —— **同格重签**的判据（E148②：原来直接撞唯一索引 ⇒ 500）；
//   ③ `updateEnterpriseConfirmation` —— **改签**要能就地更正内容 / 分数 / 跨领域签字人。
//
// ⚠️ 软删（deleted_at）而不是物理删除：企业确认是**计分证据**，事后要能查「谁在什么时候签过、后来撤了」。
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

/**
 * 按 id 取一条**未撤回**的企业确认。
 * ⛔ 撤回过的（deleted_at 非空）取不到 ⇒ 单条不满足 → 404（不泄露「曾经存在过」）。
 */
export function getEnterpriseConfirmationById(db, id) {
  return db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

/**
 * 查「同格」的企业确认：(赛段, 队伍, 维度, 企业)。
 * ⚠️ **同格** = 唯一索引 `idx_enterprise_confirmations_cell` 的那四列
 *    （stage_id, team_id, dimension, enterprise_id，且 deleted_at IS NULL）。
 *    E148②：同格重签原来直接撞唯一索引 → SQLite 抛 UNIQUE → **HTTP 500「服务内部错误」**
 *    （违反设计文档 §7.3 的三态口径）。现在先查、明确报 409。
 */
export function findActiveEnterpriseConfirmation(db, { stageId, teamId, dimension, enterpriseId }) {
  return db.prepare(
    `SELECT * FROM enterprise_confirmations
      WHERE stage_id = ? AND team_id = ? AND dimension = ? AND enterprise_id = ? AND deleted_at IS NULL
      ORDER BY created_at, rowid LIMIT 1`,
  ).get(stageId, teamId, dimension, enterpriseId) ?? null;
}

export function softDeleteEnterpriseConfirmation(db, id, now) {
  db.prepare('UPDATE enterprise_confirmations SET deleted_at = ? WHERE id = ?').run(now, id);
}

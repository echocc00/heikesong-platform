// src/db/repo/flags.js — 人工复核项仓储
// 依据：设计文档 §11.1（串通识别 → 进人工复核队列）
//   ⛔ 检测 ≠ 处罚：这张表只记录"有疑问"，裁决由人工在复核队列里做。
import { randomUUID } from 'node:crypto';

export function createFlag(db, {
  id = randomUUID(), stageId = null, submissionId = null, teamId = null, judgeId = null,
  kind, detail = null, status = 'open', now = new Date().toISOString(),
}) {
  db.prepare(
    `INSERT INTO flagged_reviews
       (id, stage_id, submission_id, team_id, judge_id, kind, detail_json, status, reviewed_by, reviewed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    id, stageId, submissionId, teamId, judgeId, kind,
    detail === null ? null : JSON.stringify(detail), status, now,
  );
  return id;
}

export function findOpenFlag(db, { kind, stageId = null, teamId = null, judgeId = null }) {
  return db.prepare(
    `SELECT * FROM flagged_reviews
      WHERE kind = ? AND status = 'open'
        AND IFNULL(stage_id, '') = ? AND IFNULL(team_id, '') = ? AND IFNULL(judge_id, '') = ?`,
  ).get(kind, stageId ?? '', teamId ?? '', judgeId ?? '') ?? null;
}

export function listFlagRows(db, {
  status = null, kind = null, stageId = null, limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (stageId) { where.push('stage_id = ?'); params.push(stageId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM flagged_reviews ${clause}`).get(...params).n;
  // ⛔ 确定性排序：破并列键用 SQLite 隐式 `rowid`，**不用 `id`** ——
  //    `id` 是 randomUUID() ⇒ 同 `created_at` 的两条记录**次序随机**。
  //    全局约束同 `src/db/repo/audit-log.js`（P4-13 根因修复）。
  const rows = db.prepare(
    `SELECT * FROM flagged_reviews ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

export function resolveFlagRow(db, {
  id, status, reviewedBy = null, reviewedAt = null, detail = null,
}) {
  return db.prepare(
    `UPDATE flagged_reviews
        SET status = ?, reviewed_by = ?, reviewed_at = ?, detail_json = COALESCE(?, detail_json)
      WHERE id = ?`,
  ).run(status, reviewedBy, reviewedAt, detail === null ? null : JSON.stringify(detail), id).changes;
}

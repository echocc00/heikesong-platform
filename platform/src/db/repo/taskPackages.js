// src/db/repo/taskPackages.js — 任务卡仓储
// 依据：INTERFACES.md §2 + R-ENT-01（痛点/期望交付/验收标准）
import { randomUUID } from 'node:crypto';

// 可更新列白名单：列名只能从这里出，杜绝把用户输入拼进 SET 子句
const UPDATABLE = new Set([
  'title', 'pain_point', 'expected_delivery', 'acceptance_criteria',
  'grade', 'status', 'solvability_score', 'solvability_grade',
  'commitment', 'agreement', 'approved_by', 'approved_at', 'meta_json',
]);

export function createTaskPackage(db, {
  editionId,
  enterpriseId = null,
  enterpriseName = null,
  title,
  painPoint,
  expectedDelivery,
  acceptanceCriteria,
  isFreeBrief = false,
  submittedBy,
  meta = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_packages (
       id, edition_id, enterprise_id, enterprise_name, title, pain_point,
       expected_delivery, acceptance_criteria, grade, status,
       solvability_score, solvability_grade, commitment, agreement,
       is_free_brief, submitted_by, submitted_at, approved_by, approved_at,
       meta_json, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'submitted', NULL, NULL, NULL, NULL,
               ?, ?, ?, NULL, NULL, ?, NULL)`,
  ).run(
    id, editionId, enterpriseId, enterpriseName, title, painPoint,
    expectedDelivery, acceptanceCriteria,
    isFreeBrief ? 1 : 0, submittedBy, now,
    meta ? JSON.stringify(meta) : null,
  );
  return getTaskPackage(db, id);
}

export function getTaskPackage(db, id) {
  return db.prepare('SELECT * FROM task_packages WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

export function listTaskPackagesByEdition(db, editionId) {
  return db
    .prepare('SELECT * FROM task_packages WHERE edition_id = ? AND deleted_at IS NULL ORDER BY submitted_at, id')
    .all(editionId);
}

export function updateTaskPackage(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'meta_json' && patch[k] && typeof patch[k] === 'object'
        ? JSON.stringify(patch[k])
        : patch[k],
    );
    db.prepare(`UPDATE task_packages SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getTaskPackage(db, id);
}

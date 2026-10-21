// src/db/repo/workflows.js — 工作流与任务清单仓储
// 依据：INTERFACES.md §6（P5 产出）；R-OPS-13 任务清单工作流拆解
// ⛔ 所有 SQL 收在本文件（全局约束「SQL 边界」）
import { randomUUID } from 'node:crypto';

export function insertWorkflow(db, { id = randomUUID(), editionId, taskPackageId, name, now }) {
  db.prepare(
    'INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, editionId, taskPackageId, name, now);
  return getWorkflow(db, id);
}

export function getWorkflow(db, id) {
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) ?? null;
}

export function listWorkflowsByEdition(db, editionId) {
  return db
    .prepare('SELECT * FROM workflows WHERE edition_id = ? ORDER BY created_at, id')
    .all(editionId);
}

export function findWorkflowByPackage(db, editionId, taskPackageId) {
  return db
    .prepare('SELECT * FROM workflows WHERE edition_id = ? AND task_package_id = ? ORDER BY created_at, id')
    .get(editionId, taskPackageId) ?? null;
}

export function insertWorkflowTask(
  db,
  { id = randomUUID(), workflowId, title, detail = null, ownerTeamId = null, status = 'todo', dueAt = null, now },
) {
  db.prepare(
    `INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at,
       evidence_json, completed_at, completed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, workflowId, title, detail, ownerTeamId, status, dueAt, now);
  return getWorkflowTask(db, id);
}

export function getWorkflowTask(db, id) {
  return db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(id) ?? null;
}

export function listWorkflowTasksByWorkflow(db, workflowId) {
  return db
    .prepare('SELECT * FROM workflow_tasks WHERE workflow_id = ? ORDER BY created_at, id')
    .all(workflowId);
}

export function updateWorkflowTaskStatus(db, id, status) {
  return db.prepare('UPDATE workflow_tasks SET status = ? WHERE id = ?').run(status, id).changes;
}

export function completeWorkflowTask(db, id, { status, evidenceJson, completedAt, completedBy }) {
  return db
    .prepare(
      `UPDATE workflow_tasks SET status = ?, evidence_json = ?, completed_at = ?, completed_by = ?
        WHERE id = ?`,
    )
    .run(status, evidenceJson, completedAt, completedBy, id).changes;
}

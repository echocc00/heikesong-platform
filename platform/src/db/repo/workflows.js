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

/**
 * 工作流**摘要**列表（P7 新增，给前端做任务清单入口页）。
 *
 * ⚠️ 为什么要带任务计数：
 *    「任务清单」的入口页如果只有一列名字，选手点进去才知道有几件事 ——
 *    入口页存在的意义就是让人**在点进去之前**就判断要不要点。
 *    ⇒ LEFT JOIN 出 taskCount / doneCount（未完成 = 总数 - 已完成）。
 * ⛔ 这是**新函数**，不改 listWorkflowsByEdition —— 那个函数有别的调用方，
 *    改它的返回形状会波及既有链路。
 */
export function listWorkflowSummaries(db, editionId) {
  return db
    .prepare(
      `SELECT w.id, w.name, w.task_package_id AS taskPackageId, w.created_at AS createdAt,
              COUNT(t.id) AS taskCount,
              SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS doneCount
         FROM workflows w
         LEFT JOIN workflow_tasks t ON t.workflow_id = w.id
        WHERE w.edition_id = ?
        GROUP BY w.id, w.name, w.task_package_id, w.created_at
        ORDER BY w.created_at, w.id`,
    )
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

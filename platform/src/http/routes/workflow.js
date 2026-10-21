// src/http/routes/workflow.js — 任务清单 API
// 依据：INTERFACES.md §6 的 P5 API 清单；R-OPS-13 / R-OPS-14
// ⛔ R-OPS-14：禁止岗位制，任务只能自主领取 —— 这里【没有】任何"按岗位分配任务"的端点。
import { appError } from '../../errors.js';
import {
  createWorkflow, createWorkflowTask, listWorkflowTasks,
  claimTask, releaseTask, completeTask,
} from '../../services/workflow.js';

export function registerWorkflowRoutes(router, { db, rules }) {
  router.add('GET', '/api/workflows/:id/tasks', async ({ user, params }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return { tasks: listWorkflowTasks({ db, workflowId: params.id, viewer: user }) };
  });

  // 追加：建工作流（任务包 → 工作流）。契约的 API 清单里没有这条，
  // 但没有它就无法产生工作流 —— 见偏差章节 D-5。
  router.add('POST', '/api/workflows', async ({ user, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const wf = createWorkflow({
      db,
      editionId: body?.editionId,
      taskPackageId: body?.taskPackageId,
      name: body?.name,
      actorId: user.id,
    });
    return { workflow: wf };
  });

  // 追加：建任务（工作流 → 任务清单）。
  router.add('POST', '/api/workflows/:id/tasks', async ({ user, params, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const task = createWorkflowTask({
      db,
      workflowId: params.id,
      title: body?.title,
      detail: body?.detail,
      ownerTeamId: body?.ownerTeamId,
      dueAt: body?.dueAt,
      actorId: user.id,
    });
    return { task };
  });

  router.add('POST', '/api/tasks/:id/claim', async ({ user, params, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return claimTask({
      db, taskId: params.id, userId: user.id, teamId: body?.teamId,
    });
  });

  router.add('POST', '/api/tasks/:id/release', async ({ user, params }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return releaseTask({ db, taskId: params.id, userId: user.id });
  });

  // 追加：完成任务。契约的 API 清单漏了这条，工作流闭环断在这里 —— 见偏差章节 D-5。
  router.add('POST', '/api/tasks/:id/complete', async ({ user, params, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return completeTask({
      db, taskId: params.id, userId: user.id, evidence: body?.evidence,
    });
  });
}

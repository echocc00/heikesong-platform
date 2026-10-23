// src/services/workflow.js — 工作流与任务清单服务
// 依据：INTERFACES.md §6（P5 产出）
//   R-OPS-13 任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成
//   R-OPS-14 禁止岗位制
//   R-STG-03 里程碑清单报名时固定 —— 里程碑与工作流任务【不共享表、不共享规则】
//   R-STG-04 提交须为可运行状态或明确阻塞点（边界：任务完成 ≠ 赛段交付物得分）
//
// R-OPS-14：禁止岗位制，任务只能自主领取。
// ⛔ 本模块刻意不提供任何「按岗位 / 身份分配任务」的函数或接口——那是【功能缺失】，不是遗漏。
//    依据：任务书 §六 AI 原生组织红线「严禁按岗位和身份分工」；
//          探月黑客松因岗位制失败：忙的忙死、闲的闲死、最后一个人说了算。
//    唯一能拿到任务的路径：claimTask（自主领取）。
import { randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { validateTaskEvidence } from '../domain/task-evidence.js';
import { getUserById } from '../db/repo/users.js';
import * as wfRepo from '../db/repo/workflows.js';
import * as claimRepo from '../db/repo/task-claims.js';
import { hasActiveMembership, listMemberTeams } from '../db/repo/teamMembers.js';
import { getTeam, listTeamRows } from '../db/repo/teams.js';

function nowIso(now) {
  return now ?? new Date().toISOString();
}

function requireUser(db, userId) {
  const user = getUserById(db, userId);
  if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录或账号已停用');
  return user;
}

/** 工作流可见性：认领了该任务包的队（及其成员）可见；管理员全可见。 */
function canViewWorkflow(db, viewer, workflow) {
  if (!viewer) return false;
  if (viewer.is_superadmin === 1) return true;
  const teams = listTeamRows(db, { editionId: workflow.edition_id, taskPackageId: workflow.task_package_id });
  return teams.some((t) => hasActiveMembership(db, t.id, viewer.id));
}

/**
 * 建工作流：把任务包拆成工作流。
 * 权限：认领了该任务包的队员（或组委会）才能拆解。
 */
export function createWorkflow({ db, editionId, taskPackageId, name, actorId, now }) {
  const at = nowIso(now);
  const actor = requireUser(db, actorId);
  if (!editionId || !taskPackageId) {
    throw appError(400, 'EDITION_AND_PACKAGE_REQUIRED', 'editionId 与 taskPackageId 必填');
  }
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title) throw appError(400, 'NAME_REQUIRED', '工作流名称必填');
  const teams = listTeamRows(db, { editionId, taskPackageId });
  const allowed = actor.is_superadmin === 1 || teams.some((t) => hasActiveMembership(db, t.id, actorId));
  if (!allowed) {
    throw appError(403, 'FORBIDDEN', '只有认领该任务包的队员（或组委会）才能拆解工作流');
  }
  return wfRepo.insertWorkflow(db, {
    id: randomUUID(), editionId, taskPackageId, name: title, now: at,
  });
}

/**
 * 建任务：工作流 → 任务清单。
 * 权限：只能给自己所在队建任务（避免"给别人派活"——那正是岗位制的入口）。
 */
export function createWorkflowTask({ db, workflowId, title, detail, ownerTeamId, dueAt, actorId, now }) {
  const at = nowIso(now);
  const actor = requireUser(db, actorId);
  const workflow = wfRepo.getWorkflow(db, workflowId);
  if (!workflow) throw appError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在');
  const taskTitle = typeof title === 'string' ? title.trim() : '';
  if (!taskTitle) throw appError(400, 'TITLE_REQUIRED', '任务标题必填');
  if (ownerTeamId) {
    const team = getTeam(db, ownerTeamId);
    if (!team) throw appError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    if (actor.is_superadmin !== 1 && !hasActiveMembership(db, ownerTeamId, actorId)) {
      throw appError(403, 'FORBIDDEN', '只能给自己所在的队建任务');
    }
  } else {
    // ⚛️ F32（Medium，2026-10-23 审计）：原来「不传 ownerTeamId」就**完全跳过归属校验**
    //   ⇒ 任何队的成员都能往**别队**的工作流里注入任务（任务归属被凭空改写）。
    //   ⇒ 不传时也要校验：必须是该工作流（任务包）的承接队之一（或超管）。
    const ownerTeams = listTeamRows(db, {
      editionId: workflow.edition_id,
      taskPackageId: workflow.task_package_id,
    });
    const allowed = actor.is_superadmin === 1
      || ownerTeams.some((t) => hasActiveMembership(db, t.id, actorId));
    if (!allowed) {
      throw appError(403, 'FORBIDDEN', '只能给自己所在的队建任务');
    }
  }
  return wfRepo.insertWorkflowTask(db, {
    id: randomUUID(),
    workflowId,
    title: taskTitle,
    detail: typeof detail === 'string' && detail.trim() ? detail.trim() : null,
    ownerTeamId: ownerTeamId ?? null,
    status: 'todo',
    dueAt: dueAt ?? null,
    now: at,
  });
}

/**
 * 列任务清单。
 * ⛔ 列表不满足 → 返回空数组（200 + 空集），不暴露"有但不给看"（三态状态码）。
 */
export function listWorkflowTasks({ db, workflowId, viewer }) {
  const workflow = wfRepo.getWorkflow(db, workflowId);
  if (!workflow) throw appError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在');
  if (!viewer) throw appError(401, 'UNAUTHENTICATED', '未登录');
  if (!canViewWorkflow(db, viewer, workflow)) return [];

  return wfRepo.listWorkflowTasksByWorkflow(db, workflowId).map((t) => {
    const claim = claimRepo.getActiveClaim(db, t.id);
    return {
      id: t.id,
      workflowId: t.workflow_id,
      title: t.title,
      detail: t.detail,
      ownerTeamId: t.owner_team_id,
      status: t.status,
      dueAt: t.due_at,
      createdAt: t.created_at,
      claim: claim
        ? { userId: claim.user_id, teamId: claim.team_id, claimedAt: claim.claimed_at }
        : null,
      isMine: Boolean(claim && claim.user_id === viewer.id),
      completedAt: t.completed_at,
      completedBy: t.completed_by,
    };
  });
}

/**
 * 自主领取任务（R-OPS-13 / R-OPS-14 的核心动作）。
 * ⛔ 并发安全靠数据库的部分唯一索引兜底：这里的前置检查只是"友好提示"，
 *    真正的保证在 ux_task_claims_active。
 */
export function claimTask({ db, taskId, userId, teamId, now }) {
  const at = nowIso(now);
  const user = requireUser(db, userId);
  const task = wfRepo.getWorkflowTask(db, taskId);
  if (!task) throw appError(404, 'TASK_NOT_FOUND', '任务不存在');
  if (task.status === 'done') throw appError(409, 'TASK_ALREADY_DONE', '任务已完成，不能再领取');

  const team = resolveTeam(db, userId, teamId);
  // ⛔ F15（High，2026-10-23 审计）：**任务归属校验**。
  //    原来只校验「你是不是某支队的成员」（resolveTeam），**从不校验这个任务是谁的**
  //    ⇒ 任何队的队长都能 `claimTask` 抢走**别队**的任务并完成它
  //    （R-OPS-14「禁止岗位制」被绕过：任务池的归属语义没了）。
  //    判据：
  //      ① 任务有 owner_team_id ⇒ 只能由**那一支**队领取；
  //      ② 任务没有 owner_team_id ⇒ 它属于该工作流（任务包）的承接队，
  //         只有那些队能领。
  const ownerTeamId = task.owner_team_id ?? null;
  if (ownerTeamId) {
    if (ownerTeamId !== team.id) {
      throw appError(403, 'NOT_TASK_OWNER', '不能领取别队的任务');
    }
  } else {
    const wf = wfRepo.getWorkflow(db, task.workflow_id);
    const ownerTeams = wf
      ? listTeamRows(db, { editionId: wf.edition_id, taskPackageId: wf.task_package_id })
      : [];
    if (ownerTeams.length && !ownerTeams.some((t) => t.id === team.id)) {
      throw appError(403, 'NOT_TASK_OWNER', '不能领取别队的任务');
    }
  }
  if (claimRepo.getActiveClaim(db, taskId)) {
    throw appError(409, 'TASK_ALREADY_CLAIMED', '任务已被他人领取');
  }

  let claim;
  try {
    claim = claimRepo.insertTaskClaim(db, {
      id: randomUUID(), taskId, teamId: team.id, userId, now: at,
    });
  } catch (err) {
    // ⛔ 最后一道防线：并发下两个请求都通过了上面的检查时，数据库会拒绝第二条
    if (String(err?.message ?? '').includes('UNIQUE constraint failed')) {
      throw appError(409, 'TASK_ALREADY_CLAIMED', '任务已被他人领取');
    }
    throw err;
  }
  wfRepo.updateWorkflowTaskStatus(db, taskId, 'in_progress');
  return { task: wfRepo.getWorkflowTask(db, taskId), claim };
}

/** 释放任务：把任务放回可领取池（R-OPS-14：谁领的谁放，不存在"上级指派"）。 */
export function releaseTask({ db, taskId, userId, now }) {
  const at = nowIso(now);
  requireUser(db, userId);
  const task = wfRepo.getWorkflowTask(db, taskId);
  if (!task) throw appError(404, 'TASK_NOT_FOUND', '任务不存在');
  const claim = claimRepo.getActiveClaim(db, taskId);
  if (!claim) throw appError(409, 'TASK_NOT_CLAIMED', '任务当前无人领取');
  if (claim.user_id !== userId) throw appError(403, 'NOT_CLAIM_HOLDER', '只能释放自己领取的任务');
  claimRepo.releaseTaskClaim(db, claim.id, at);
  wfRepo.updateWorkflowTaskStatus(db, taskId, 'todo');
  return { task: wfRepo.getWorkflowTask(db, taskId) };
}

/**
 * 提交完成状态（R-STG-04）。
 * ⚠️ 边界：只写任务清单的完成状态与证据，⛔ 不写 points_ledger / behavior_events，不产生任何分数。
 *    kind='runnable' → 任务 done；kind='blocked' → 任务 blocked（挂起等解除，不是完成）。
 */
export function completeTask({ db, taskId, userId, now, evidence }) {
  const at = nowIso(now);
  requireUser(db, userId);
  const task = wfRepo.getWorkflowTask(db, taskId);
  if (!task) throw appError(404, 'TASK_NOT_FOUND', '任务不存在');
  const claim = claimRepo.getActiveClaim(db, taskId);
  if (!claim) throw appError(409, 'TASK_NOT_CLAIMED', '任务当前无人领取，无法提交完成状态');
  if (claim.user_id !== userId) throw appError(403, 'NOT_CLAIM_HOLDER', '只能提交自己领取的任务');

  const check = validateTaskEvidence(evidence);
  if (!check.ok) {
    throw appError(
      400,
      'EVIDENCE_REQUIRED',
      '完成必须提交可运行状态或明确阻塞点（纯文字进度说明不给分）',
      { errors: check.errors },
    );
  }

  const status = evidence.kind === 'runnable' ? 'done' : 'blocked';
  wfRepo.completeWorkflowTask(db, taskId, {
    status,
    evidenceJson: JSON.stringify(evidence),
    completedAt: at,
    completedBy: userId,
  });
  return { task: wfRepo.getWorkflowTask(db, taskId) };
}

/** 领取人所在队：显式指定则校验成员身份；未指定则在本人所在队中选唯一的一支。 */
function resolveTeam(db, userId, teamId) {
  if (teamId) {
    const team = getTeam(db, teamId);
    if (!team) throw appError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    if (!hasActiveMembership(db, teamId, userId)) {
      throw appError(403, 'NOT_TEAM_MEMBER', '你不是该队成员，不能替该队领取任务');
    }
    return team;
  }
  const teams = listMemberTeams(db, userId);
  if (teams.length === 0) throw appError(400, 'NO_TEAM', '你还没有加入任何队伍');
  // ⚠️ P1 的部分唯一索引保证「同一人只能同时在一个战队」（idx_team_members_active），
  //    所以这里正常只会命中 1 支；>1 是防御性分支（上游若放开该约束，这里不会悄悄选错队）。
  if (teams.length > 1) throw appError(400, 'TEAM_AMBIGUOUS', '你在多支队伍里，请显式指定 teamId');
  return teams[0];
}

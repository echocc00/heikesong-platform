// src/services/team.js — 战队与成员服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）
// 依据：任务书 §六 组队规则（2–3 人+ / MBA 组长 / 持续招募汰换 / 仅剩一人须并队）
// 溯源需求：R-REG-01 / R-REG-02 / R-REG-03 / R-REG-04 / R-REG-05 / R-STG-03
import { AppError } from '../errors.js';
import { getUserById } from '../db/repo/users.js';
import { getEdition } from '../db/repo/editions.js';
import { getTaskPackage } from '../db/repo/taskPackages.js';
import { findActiveRegistration } from '../db/repo/registrations.js';
import {
  // ⚠️ 父代理预审修正（Critical，规格缺陷）：仓储的 getTeam 必须**改别名**导入。
  //    原来直接 `import { getTeam }`，而本文件下面又 `export function getTeam(...)`
  //    → **同名重复声明** → `SyntaxError: Identifier 'getTeam' has already been declared`
  //    → 整个模块根本无法导入 → 计划自带的 13 条用例**一条都跑不起来**。
  //    父代理预审实跑复现。服务层对外仍是 `getTeam({db,id,viewer,rules})`（契约不变）。
  insertTeam, getTeam as findTeamRow, listTeamRows, updateTeamRow, countActiveTeamsByPackage,
} from '../db/repo/teams.js';
import {
  insertTeamMember, listActiveMembers, listMemberHistory, markMemberLeft,
  countActiveMembers, findActiveMembershipByUser, lastLeaveAt,
} from '../db/repo/teamMembers.js';
import { insertMilestones } from '../db/repo/tiers.js';
import { can } from '../auth/permissions.js';

/**
 * 组队硬校验。错误串格式：[错误码] 说明，服务层按码分流。
 * 依据：R-REG-02（人数 ≥2）、R-REG-05（队长 MBA）、R-REG-01（任务包已分级才可认领）
 */
export function checkTeamFormation({ team, captain, members, taskPackage, config }) {
  const errors = [];
  if (config.captainMustBeMba && captain?.mba_status !== 'mba') {
    errors.push('[CAPTAIN_MBA_REQUIRED] 组长必须是一堂 MBA 在籍（任务书 §六 硬性门槛）');
  }
  const count = Array.isArray(members) ? members.length : 0;
  if (count < config.teamSize.min) {
    errors.push(`[TEAM_BELOW_MIN_SIZE] 组队人数 ${count} 人，低于下限 ${config.teamSize.min} 人（不接受 1 人组队）`);
  }
  if (count > config.teamSize.max) {
    errors.push(`[TEAM_ABOVE_MAX_SIZE] 组队人数 ${count} 人，超过上限 ${config.teamSize.max} 人`);
  }
  if (!taskPackage || !taskPackage.solvability_grade) {
    errors.push('[TASK_PACKAGE_NOT_GRADED] 认领的任务包尚未完成六维可解性分级');
  }
  return { ok: errors.length === 0, errors };
}

// 报名等级是否被接收（R-REG-08：C 级不接收）
function assertAcceptedRegistration(db, userId, editionId, rules) {
  const reg = findActiveRegistration(db, userId, editionId);
  if (!reg) {
    throw new AppError(409, 'REGISTRATION_REQUIRED', '请先完成本届报名');
  }
  const effective = reg.level_final ?? reg.level;
  const cfg = rules.registration.levels.find((l) => l.key === effective);
  if (!cfg || cfg.accept !== true) {
    throw new AppError(
      409, 'REGISTRATION_NOT_ACCEPTED',
      `你的报名尚未被接收（当前 ${effective ?? '未分级'} 级，C 级不接收）`,
    );
  }
  return reg;
}

// 战队视图：成员、组队校验、并队信息、固定里程碑
function teamView(db, teamId, rules) {
  const team = findTeamRow(db, teamId);
  if (!team) return null;
  const members = listActiveMembers(db, teamId);
  const captain = getUserById(db, team.captain_id);
  const pkg = team.task_package_id ? getTaskPackage(db, team.task_package_id) : null;
  const formation = checkTeamFormation({
    team, captain, members, taskPackage: pkg, config: rules.teamFormation,
  });
  const left = lastLeaveAt(db, teamId);
  const mergeDeadline = left
    ? new Date(new Date(left).getTime() + rules.teamFormation.singleMemberMergeDeadlineDays * 86400000).toISOString()
    : null;
  let milestones = null;
  try {
    milestones = team.milestones_json ? JSON.parse(team.milestones_json) : null;
  } catch {
    milestones = null;
  }
  return {
    id: team.id,
    editionId: team.edition_id,
    name: team.name,
    captainId: team.captain_id,
    taskPackageId: team.task_package_id,
    tier: team.tier,
    status: team.status,
    members: members.map((m) => ({ id: m.id, userId: m.user_id, role: m.role, joinedAt: m.joined_at })),
    memberCount: members.length,
    // R-REG-03：退出报备 —— 进出历史留档，不硬删
    history: listMemberHistory(db, teamId).map((m) => ({
      id: m.id, userId: m.user_id, role: m.role, joinedAt: m.joined_at, leftAt: m.left_at,
    })),
    // R-REG-04：仅剩 1 人 → 触发并队标记与期限
    needsMerge: team.status === 'needs_merge',
    mergeDeadline,
    // R-STG-03：报名时固定的里程碑清单，赛程中不可自行新增
    milestones,
    formation,
  };
}

export function createTeam({
  db, userId, editionId, taskPackageId, name, now = new Date().toISOString(), rules,
}) {
  const config = rules.teamFormation;
  if (!getEdition(db, editionId)) throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
  const captain = getUserById(db, userId);
  if (!captain) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');

  const pkg = taskPackageId ? getTaskPackage(db, taskPackageId) : null;
  if (taskPackageId && !pkg) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
  if (pkg && pkg.edition_id !== editionId) {
    throw new AppError(409, 'EDITION_MISMATCH', '任务包不属于本届');
  }
  // 硬门槛 1：组长必须一堂 MBA 在籍（R-REG-05，已定）
  if (config.captainMustBeMba && captain.mba_status !== 'mba') {
    throw new AppError(409, 'CAPTAIN_MBA_REQUIRED', '组长必须是一堂 MBA 在籍（硬性门槛）');
  }
  // 硬门槛 2：任务包可解性已分级（R-ENT-06 准入）
  if (!pkg || !pkg.solvability_grade) {
    throw new AppError(409, 'TASK_PACKAGE_NOT_GRADED', '认领的任务包尚未完成六维可解性分级');
  }
  // R-REG-01 + 顶层文档 §3.1：每个任务包 2–3 支战队
  //
  // ⚠️ 父代理预审修正（Important，两处口径登记）：
  //  ① `teamsPerPackage.min`（每包**至少** 2 支）**不在建队时强制**：
  //     建队是选手行为，某个包的第一支队在建队那一刻还不存在 ——
  //     强制 min 会让这个包**永远建不出第一支队**（死锁）。min 是组委会的运营目标，不是创建闸门。
  //  ② `packageQuotaMix`（企业包 70% / 自由包 30% 的战队配额）**本期不强制**：
  //     需求溯源表里没有对应条目（只有 R-ENT-09 的**任务卡池**配比，
  //     那条由 Task 4 的 checkTaskMix 体检）；且建队时无法预知最终配比，
  //     强制会让某个类型的包建不出队。该键保留在配置里（INTERFACES.md §2 的契约形状），
  //     由组委会在配比体检里人工看。
  const teamCount = countActiveTeamsByPackage(db, taskPackageId);
  if (teamCount >= config.teamsPerPackage.max) {
    throw new AppError(
      409, 'PACKAGE_TEAM_LIMIT',
      `该任务包已有 ${teamCount} 支战队，上限 ${config.teamsPerPackage.max} 支`,
    );
  }
  if (findActiveMembershipByUser(db, userId)) {
    throw new AppError(409, 'ALREADY_IN_TEAM', '你已在一支战队中');
  }
  assertAcceptedRegistration(db, userId, editionId, rules);

  // R-STG-03：里程碑清单在报名（组队）时固定，之后不可自行新增
  const milestones = {
    version: rules.milestones.version,
    source: rules.milestones.source,
    items: rules.milestones.items.map((i) => ({
      key: i.key, label: i.label, countsTowardTier: i.countsTowardTier,
    })),
  };

  const team = insertTeam(db, {
    editionId,
    name: name?.trim() || `第 ${teamCount + 1} 队`,
    captainId: userId,
    taskPackageId,
    status: 'forming',
    milestones,
    now,
  });
  insertTeamMember(db, { teamId: team.id, userId, role: 'captain', now });
  // R-STG-03 / R-PTS-10：里程碑清单在【组队时】固定 —— 同时落成 P3 的 milestones 表行。
  //   （P3 的段位引擎与 B 榜只读这张表；清单本身仍来自 teams.milestones_json，两处同源。）
  insertMilestones(db, { teamId: team.id, items: milestones.items, now });
  return teamView(db, team.id, rules);
}

export function getTeam({ db, id, viewer, rules }) {
  const row = findTeamRow(db, id);
  if (!row) return null;
  // 可见性：战队成员 / 组长 / 有 team:read 授权的人
  const isMember = listActiveMembers(db, id).some((m) => m.user_id === viewer?.id);
  const isCaptain = row.captain_id === viewer?.id;
  const hasRight = viewer && can(viewer, 'team:read', { scopeType: 'team', scopeId: id }, db);
  if (!isMember && !isCaptain && !hasRight) return null;
  return teamView(db, id, rules);
}

export function addMember({ db, teamId, userId, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  if (team.status === 'dissolved') throw new AppError(409, 'TEAM_DISSOLVED', '战队已解散');
  if (findActiveMembershipByUser(db, userId)) {
    throw new AppError(409, 'ALREADY_IN_TEAM', '该同学已在一支战队中');
  }
  const count = countActiveMembers(db, teamId);
  if (count >= config.teamSize.max) {
    throw new AppError(409, 'TEAM_FULL', `战队已满（上限 ${config.teamSize.max} 人）`);
  }
  assertAcceptedRegistration(db, userId, team.edition_id, rules);

  insertTeamMember(db, { teamId, userId, role: 'member', now });
  // 人数达标 → 战队成立（R-REG-02）
  if (countActiveMembers(db, teamId) >= config.teamSize.min) {
    updateTeamRow(db, teamId, { status: 'active' });
  }
  return teamView(db, teamId, rules);
}

export function leaveTeam({ db, teamId, userId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  const member = listActiveMembers(db, teamId).find((m) => m.user_id === userId);
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', '该同学不在此战队');
  if (member.role === 'captain') {
    throw new AppError(409, 'CAPTAIN_MUST_REPLACE', '组长不能直接退出，请先汰换成员并移交组长职责');
  }
  markMemberLeft(db, member.id, now);
  // R-REG-04：仅剩 1 人 → 触发并队
  // ⚠️ 父代理预审修正（Important，配置没接线）：原来把「仅剩 1 人」硬编码在实现里，
  //    配置项 `singleMemberTriggersMerge` 一次都没被读过 ——
  //    配置与实现可以各说各话（把配置改成 false，行为照旧触发并队）。
  //    现在**从配置读**：`singleMemberTriggersMerge === false` 时不触发并队标记。
  if (config.singleMemberTriggersMerge !== false && countActiveMembers(db, teamId) <= 1) {
    updateTeamRow(db, teamId, { status: 'needs_merge' });
  }
  return teamView(db, teamId, rules);
}

export function replaceMember({
  db, teamId, outUserId, inUserId, actorId, now = new Date().toISOString(), rules,
}) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');

  // R-REG-03：换人要队长或组委会同意（memberChange.requireCaptainOrAdmin）
  if (config.memberChange.requireCaptainOrAdmin) {
    const actor = getUserById(db, actorId);
    const isCaptain = team.captain_id === actorId;
    const isAdmin = actor && can(actor, 'team:manage', { scopeType: 'team', scopeId: teamId }, db);
    if (!isCaptain && !isAdmin) {
      throw new AppError(403, 'FORBIDDEN', '只有队长或组委会可以汰换成员');
    }
  }

  const members = listActiveMembers(db, teamId);
  const out = members.find((m) => m.user_id === outUserId);
  if (!out) throw new AppError(404, 'MEMBER_NOT_FOUND', '被汰换的同学不在此战队');
  if (findActiveMembershipByUser(db, inUserId)) {
    throw new AppError(409, 'ALREADY_IN_TEAM', '新成员已在一支战队中');
  }
  assertAcceptedRegistration(db, inUserId, team.edition_id, rules);

  // 组长汰换：新人接任组长，必须仍是 MBA 在籍（R-REG-05）
  const replacingCaptain = out.role === 'captain';
  if (replacingCaptain) {
    const inUser = getUserById(db, inUserId);
    if (config.captainMustBeMba && inUser?.mba_status !== 'mba') {
      throw new AppError(409, 'CAPTAIN_MBA_REQUIRED', '接任组长必须是一堂 MBA 在籍（硬性门槛）');
    }
  }

  markMemberLeft(db, out.id, now);
  insertTeamMember(db, { teamId, userId: inUserId, role: replacingCaptain ? 'captain' : 'member', now });
  if (replacingCaptain) updateTeamRow(db, teamId, { captain_id: inUserId });

  const remaining = countActiveMembers(db, teamId);
  // ⚠️ 父代理预审修正（Important，配置没接线）：同上，改读 `singleMemberTriggersMerge`
  if (config.singleMemberTriggersMerge !== false && remaining <= 1) {
    updateTeamRow(db, teamId, { status: 'needs_merge' });
  } else if (team.status === 'forming') {
    updateTeamRow(db, teamId, { status: 'active' });
  }
  return teamView(db, teamId, rules);
}

export function updateTeam({ db, teamId, patch, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.teamFormation;
  const team = findTeamRow(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');

  const actor = getUserById(db, actorId);
  const isCaptain = team.captain_id === actorId;
  const isAdmin = actor && can(actor, 'team:manage', { scopeType: 'team', scopeId: teamId }, db);
  if (!isCaptain && !isAdmin) {
    throw new AppError(403, 'FORBIDDEN', '只有队长或组委会可以修改战队');
  }

  const update = {};
  if (typeof patch?.name === 'string' && patch.name.trim()) {
    update.name = patch.name.trim();
  }
  if (patch?.taskPackageId && patch.taskPackageId !== team.task_package_id) {
    const pkg = getTaskPackage(db, patch.taskPackageId);
    if (!pkg) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
    if (pkg.edition_id !== team.edition_id) {
      throw new AppError(409, 'EDITION_MISMATCH', '任务包不属于本届');
    }
    if (!pkg.solvability_grade) {
      throw new AppError(409, 'TASK_PACKAGE_NOT_GRADED', '新任务包尚未完成六维可解性分级');
    }
    const count = countActiveTeamsByPackage(db, pkg.id);
    if (count >= config.teamsPerPackage.max) {
      throw new AppError(
        409, 'PACKAGE_TEAM_LIMIT',
        `该任务包已有 ${count} 支战队，上限 ${config.teamsPerPackage.max} 支`,
      );
    }
    update.task_package_id = pkg.id;
    // ⛔ 换任务包【不】改动已固定的里程碑清单（R-STG-03 防拆单刷里程碑）
  }
  if (Object.keys(update).length) updateTeamRow(db, teamId, update);
  return teamView(db, teamId, rules);
}

// 我参与的所有战队（供「我的战队」页使用）
export function listMyTeams({ db, userId, rules }) {
  const rows = listTeamRows(db, {});
  return rows
    .filter((t) => t.captain_id === userId || listActiveMembers(db, t.id).some((m) => m.user_id === userId))
    .map((t) => teamView(db, t.id, rules));
}

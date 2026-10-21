// src/services/milestone.js — 企业里程碑签字（★ 只确认客观事实，不进总分）
// 依据：S10 §4 商业里程碑 7 类 + R-ENT-02「企业签字里程碑」
//   + R-JDG-14（签字必须写清解决哪个环节 / 落地时间 / 我方角色）
//   + R-PTS-03（S 段只认业务部门签字）+ 规则表 rules/milestones.default.json 的 signoffRequires。
//   + R-PTS-11（里程碑 7 类即 L2 商业里程碑分的完整类目 —— 规则表在 milestones.default.json）
//   + R-PTS-12（L2 里程碑与段位**共享「企业签字」这一个数据源**，但**不共享任何一条规则**：
//        里程碑的类目/签字要求读 milestones.default.json，段位的门槛与权益读 ranks.json，
//        两边各自独立配置 —— 改段位表**不会**动到里程碑口径，反之亦然）。
//
// ⛔ 本模块与 P2 的 enterprise_confirmations 是**两张不同的表**：
//    这里签的是「这件事到底发生了没有」（客观事实，单签，不进总分）；
//    那里记的是「企业觉得这个做得好不好」（主观评分，双签，进总分）。
// ⛔ 签字**只增不改**；撤回走 revoked_at 软删除（不物理删除）。
// ⛔ 权限模型 = capability + assignment，can() 是唯一判定入口。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getTeam } from '../db/repo/leaderboard.js';
import * as tierRepo from '../db/repo/tiers.js';

/**
 * 企业签字：确认某支队伍的某个里程碑「确实发生了」。
 * @param body { department, content } —— 部门与内容都必填（rules/milestones.default.json.signoffRequires）
 */
export function createSignoff({ db, milestoneId, actorId, body, now = new Date().toISOString(), rules }) {
  const actor = getUserById(db, actorId);
  if (!actor) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
  const milestone = tierRepo.getMilestone(db, milestoneId);
  if (!milestone) throw new AppError(404, 'MILESTONE_NOT_FOUND', '里程碑不存在');
  const team = getTeam(db, milestone.team_id);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  // 能力点闸门：只有企业席 / 企业管理员能签（seed 里 signoff:create 授予这两个角色）
  if (!can(actor, 'signoff:create', { scopeType: 'edition', scopeId: team.edition_id }, db)) {
    throw new AppError(403, 'FORBIDDEN', '你没有企业签字的权限');
  }
  const req = rules.milestones?.signoffRequires ?? {};
  const department = String(body?.department ?? '').trim();
  const content = String(body?.content ?? '').trim();
  if (req.department !== false && !department) {
    throw new AppError(400, 'MISSING_DEPARTMENT', '必须填写签字部门');
  }
  if (req.content !== false && !content) {
    throw new AppError(400, 'MISSING_CONTENT', '必须写清签字内容（解决哪个环节 / 落地时间 / 我方角色）');
  }
  const id = randomUUID();
  // enterprise_id = 签字的企业席账号（P2 的 enterprise_confirmations 同样用 users.id 当企业 id）
  tierRepo.insertSignoff(db, {
    id, milestoneId, enterpriseId: actor.id, signatoryUserId: actor.id, department, content, signedAt: now,
  });
  return { id, milestoneId, teamId: team.id, department, content, signedAt: now, revokedAt: null };
}

/**
 * 撤回签字：软删除（置 revoked_at）—— 撤回后该里程碑回到「未达成」，段位由**重算**体现降档。
 * ⛔ 只能撤回**自己**（本企业席）的签字；组委会可代撤（留审计）。
 */
export function withdrawSignoff({ db, milestoneId, signoffId, actorId, now = new Date().toISOString(), rules }) {
  const actor = getUserById(db, actorId);
  if (!actor) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
  const milestone = tierRepo.getMilestone(db, milestoneId);
  if (!milestone) throw new AppError(404, 'MILESTONE_NOT_FOUND', '里程碑不存在');
  const team = getTeam(db, milestone.team_id);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  if (!can(actor, 'signoff:create', { scopeType: 'edition', scopeId: team.edition_id }, db)) {
    throw new AppError(403, 'FORBIDDEN', '你没有撤回企业签字的权限');
  }
  const signoff = tierRepo.getSignoff(db, signoffId);
  if (!signoff || signoff.milestone_id !== milestoneId) {
    throw new AppError(404, 'SIGNOFF_NOT_FOUND', '签字不存在');
  }
  if (signoff.revoked_at) {
    throw new AppError(409, 'ALREADY_REVOKED', '该签字已被撤回');
  }
  // ⛔ 非超管只能撤回自己签的（不能替别的企业撤）
  if (actor.is_superadmin !== 1 && signoff.enterprise_id !== actor.id) {
    throw new AppError(403, 'NOT_YOUR_SIGNOFF', '只能撤回本企业自己的签字');
  }
  const changed = tierRepo.revokeSignoff(db, { id: signoffId, revokedAt: now });
  if (!changed) throw new AppError(409, 'ALREADY_REVOKED', '该签字已被撤回');
  return { id: signoffId, milestoneId, revokedAt: now };
}

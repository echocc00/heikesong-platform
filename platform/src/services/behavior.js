// src/services/behavior.js — 行为分事件的写入入口（★ 独立通路，与总分隔离）
// 依据：S10 §3.1 计分明细 + §3.2 达标线 + R-STG-04（提交须为可运行状态或明确阻塞点，
//   纯文字进度说明不给分）+ R-PTS-10 反作弊 5 条（分值不由提交方给定）。
//
// ⛔ 分值【不】由提交方给定：一律取 rules/behavior-points.json 里该类型的分值（防篡改）。
//    域函数 behaviorScore 在**读取**时也会重算一遍 —— 存进去的 points 只是留痕，不是权威。
// ⛔ 证据不合规 → 直接拒收（400），**不给分、不落库**（S10「纯文字进度说明不给分」）。
//    证据口径由域函数统一裁决（rules.criteria.behaviorEvidence 覆盖默认要求），
//    服务层**不重复实现**一套证据规则 —— 两套规则必然漂移。
// ⛔ 权限模型 = capability + assignment，can() 是唯一判定入口（behavior:write）。
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getUserById } from '../db/repo/users.js';
import { getTeam } from '../db/repo/leaderboard.js';
import { insertBehaviorEvent } from '../db/repo/points.js';
import { behaviorScore } from '../domain/behavior.js';

/**
 * 提交一条行为分事件。
 * @param body { type, evidence } —— type 取 rules.behavior.events 的 key；evidence 为对象或 JSON 串
 */
export function submitBehaviorEvent({ db, teamId, actorId, body, now = new Date().toISOString(), rules }) {
  const actor = getUserById(db, actorId);
  if (!actor) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
  const team = getTeam(db, teamId);
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', '战队不存在');
  if (!can(actor, 'behavior:write', { scopeType: 'edition', scopeId: team.edition_id }, db)) {
    throw new AppError(403, 'FORBIDDEN', '你没有提交行为分记录的权限');
  }
  const type = String(body?.type ?? '').trim();
  const def = (rules.behavior?.events ?? []).find((d) => d.key === type);
  if (!def) throw new AppError(400, 'UNKNOWN_EVENT_TYPE', `未知的行为事件类型：${type}`);

  // 证据校验：借用域函数同一套口径（不另写一份）
  const behaviorConfig = {
    ...(rules.behavior || {}),
    evidenceRequirements: rules.criteria?.behaviorEvidence || undefined,
  };
  const probe = behaviorScore({
    events: [{ id: 'probe', type, evidence: body?.evidence, created_at: now }],
    behaviorConfig,
  });
  const item = probe.items[0];
  if (!item || !item.counted) {
    throw new AppError(400, 'EVIDENCE_REJECTED', `证据不合规，不予计分：${item?.reason ?? 'unknown'}`);
  }

  const id = randomUUID();
  const evidence = typeof body?.evidence === 'string' ? body.evidence : JSON.stringify(body?.evidence ?? {});
  insertBehaviorEvent(db, {
    id, teamId, userId: actor.id, type, points: Number(item.points) || 0, evidence, createdAt: now,
  });
  return { id, teamId, userId: actor.id, type, points: item.points, counted: true, createdAt: now };
}

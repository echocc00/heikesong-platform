// src/services/registration.js — 报名服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）+ 设计文档 §10 流 1
// 溯源需求：R-REG-01 / R-REG-06 / R-REG-07 / R-REG-08 / R-REG-09 / R-ENT-12
import { AppError } from '../errors.js';
import {
  scoreRegistration, validateRegistrationAnswers,
} from '../domain/registration.js';
import {
  insertRegistration, getRegistration as findRegistrationRow,
  findActiveRegistration, listRegistrationRows, updateRegistrationRow,
} from '../db/repo/registrations.js';
import {
  insertRegistrationEvent, listRegistrationEvents,
} from '../db/repo/registrationEvents.js';
import { getEdition } from '../db/repo/editions.js';
import { can } from '../auth/permissions.js';

function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * DB 行 → 前端视图。grading 由配置重算（纯函数，可复算），
 * 不额外存一份 explain —— 换配置后重算即得新口径，不留陈旧快照。
 */
export function presentRegistration(row, config) {
  if (!row) return null;
  const answers = parseJson(row.answers_json, {});
  const graded = scoreRegistration({ answers, config });
  return {
    id: row.id,
    editionId: row.edition_id,
    userId: row.user_id,
    level: row.level,
    levelFinal: row.level_final,
    status: row.status,
    rawScore: row.raw_score,
    dimensionScores: parseJson(row.dimension_scores_json, {}),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    // 可解释明细（R-REG-09 筛选标准透明 + 设计文档 §9 报名问卷）
    grading: {
      score: graded.score,
      level: graded.level,
      accepted: graded.accepted,
      explain: graded.explain,
    },
    // 开放式题与同意记录：只对本人与组委会可见
    answers: { open: answers.open ?? null, consent: answers.consent ?? null },
  };
}

export function submitRegistration({
  db, userId, editionId, answers, now = new Date().toISOString(), rules,
}) {
  const config = rules.registration;
  if (!getEdition(db, editionId)) {
    throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
  }

  // R-ENT-12：合规红线与同意记录 —— 未明确同意不收
  const consentCfg = rules.compliance?.consent ?? {};
  if (consentCfg.required && answers?.consent?.accepted !== true) {
    throw new AppError(400, 'CONSENT_REQUIRED', '必须同意参赛协议、IP 归属说明与数据合规红线');
  }

  const errors = validateRegistrationAnswers(answers, config);
  if (errors.length) {
    throw new AppError(400, 'INVALID_ANSWERS', '报名问卷填写不完整', errors);
  }

  // 幂等：同一 userId + editionId 重复提交 → 409，不静默覆盖（INTERFACES.md §2）
  if (findActiveRegistration(db, userId, editionId)) {
    throw new AppError(409, 'DUPLICATE_REGISTRATION', '你已提交过本届报名，不能重复提交');
  }

  const grading = scoreRegistration({ answers, config });
  const payload = {
    ...answers,
    consent: { ...(answers.consent ?? {}), acceptedAt: now },
  };

  let row;
  try {
    row = insertRegistration(db, {
      editionId,
      userId,
      answers: payload,
      dimensionScores: grading.dimensionScores,
      rawScore: grading.score,
      level: grading.level,
      status: 'submitted',
      now,
    });
  } catch (err) {
    // 并发下由数据库唯一索引兜底 → 同样 409，绝不静默覆盖
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      throw new AppError(409, 'DUPLICATE_REGISTRATION', '你已提交过本届报名，不能重复提交');
    }
    throw err;
  }

  insertRegistrationEvent(db, {
    registrationId: row.id,
    fromStatus: null,
    toStatus: 'submitted',
    actorId: userId,
    reason: `报名提交，系统自动算分 ${grading.score} 分，判为 ${grading.level} 级`,
    now,
  });

  return presentRegistration(row, config);
}

export function getRegistration({ db, id, viewer, rules }) {
  const row = findRegistrationRow(db, id);
  if (!row) return null;
  // 可见性在 API 层过滤（设计文档 §6.6 / §7.3）：本人或组委会（registration:review）
  const isOwner = viewer && viewer.id === row.user_id;
  const isCommittee = viewer
    && can(viewer, 'registration:review', { scopeType: 'edition', scopeId: row.edition_id }, db);
  if (!isOwner && !isCommittee) return null;

  const out = presentRegistration(row, rules.registration);
  out.events = listRegistrationEvents(db, id).map((e) => ({
    id: e.id,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    actorId: e.actor_id,
    reason: e.reason,
    createdAt: e.created_at,
  }));
  return out;
}

export function listRegistrations({ db, filter = {}, viewer, rules }) {
  // 列表权限不满足 → 空数组（API 层返回 200 + 空集，不暴露"有但不给看"）
  const ok = viewer
    && can(viewer, 'registration:review', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  if (!ok) return [];
  return listRegistrationRows(db, filter).map((row) => presentRegistration(row, rules.registration));
}

/**
 * 复核 / 申诉 / 改级。
 * level 非空 → 改级（level_final），status 落到 accepted / rejected；
 * level 为空 → 视为选手申诉，只写事件不改级。
 * 每次都追加 registration_events（追加式，历史不覆盖）。
 */
export function decideRegistration({
  db, id, level, decidedBy, note = null, now = new Date().toISOString(), rules,
}) {
  const row = findRegistrationRow(db, id);
  if (!row) throw new AppError(404, 'REGISTRATION_NOT_FOUND', '报名记录不存在');
  const config = rules.registration;

  if (level === undefined || level === null || level === '') {
    insertRegistrationEvent(db, {
      registrationId: id,
      fromStatus: row.status,
      toStatus: 'appealed',
      actorId: decidedBy,
      reason: note ?? '选手申诉',
      now,
    });
    const updated = updateRegistrationRow(db, id, { status: 'appealed' });
    return presentRegistration(updated, config);
  }

  const levelCfg = config.levels.find((l) => l.key === level);
  if (!levelCfg) {
    throw new AppError(
      400, 'INVALID_LEVEL',
      `等级必须是 ${config.levels.map((l) => l.key).join(' / ')}`,
    );
  }
  const toStatus = levelCfg.accept ? 'accepted' : 'rejected';
  const updated = updateRegistrationRow(db, id, {
    level_final: level,
    decided_by: decidedBy,
    decided_at: now,
    decision_note: note,
    status: toStatus,
  });
  insertRegistrationEvent(db, {
    registrationId: id,
    fromStatus: row.status,
    toStatus,
    actorId: decidedBy,
    reason: note ?? `复核改级为 ${level}`,
    now,
  });
  return presentRegistration(updated, config);
}

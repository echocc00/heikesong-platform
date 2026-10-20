// src/http/routes/registration.js — 报名端点
// 依据：INTERFACES.md §2「API（P1）」+ 设计文档 §8
// 三态状态码（设计文档 §7.3）：列表不满足 → 200+空集；单条不满足 → 404；禁用 → 403
import { AppError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import { getRegistration as findRegistrationRow } from '../../db/repo/registrations.js';
import { listEditions } from '../../db/repo/editions.js';
import {
  submitRegistration, getRegistration, listRegistrations, decideRegistration,
} from '../../services/registration.js';

export function registerRegistrationRoutes({ router, db, rules }) {
  // 报名筛选标准对外透明（R-REG-09）：公开可读，不需要登录
  router.add('GET', '/api/registration-criteria', async () => buildCriteria(rules, db));

  router.add('POST', '/api/registrations', async ({ user, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const { editionId, answers } = body ?? {};
    if (!editionId) throw new AppError(400, 'MISSING_EDITION_ID', '缺少届期');
    return submitRegistration({ db, userId: user.id, editionId, answers, rules });
  });

  router.add('GET', '/api/registrations', async ({ user, query }) => {
    // 无组委会权限 → 200 + 空集
    const items = listRegistrations({
      db,
      filter: { editionId: query.editionId, status: query.status, level: query.level },
      viewer: user,
      rules,
    });
    return { items };
  });

  router.add('GET', '/api/registrations/:id', async ({ user, params }) => {
    const reg = getRegistration({ db, id: params.id, viewer: user, rules });
    if (!reg) throw new AppError(404, 'NOT_FOUND', '报名记录不存在');
    return reg;
  });

  router.add('POST', '/api/registrations/:id/level', async ({ user, params, body }) => {
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    const row = findRegistrationRow(db, params.id);
    if (!row) throw new AppError(404, 'NOT_FOUND', '报名记录不存在');

    const isOwner = row.user_id === user.id;
    const isCommittee = can(
      user, 'registration:review', { scopeType: 'edition', scopeId: row.edition_id }, db,
    );
    if (!isOwner && !isCommittee) throw new AppError(404, 'NOT_FOUND', '报名记录不存在');

    const level = body?.level ?? null;
    // 选手只能申诉（不改级）；改级是组委会的能力
    if (isOwner && !isCommittee && level) {
      throw new AppError(403, 'FORBIDDEN', '改级由组委会执行，你只能提交申诉');
    }
    return decideRegistration({
      db, id: params.id, level, decidedBy: user.id, note: body?.note ?? null, rules,
    });
  });
}

// 对外的筛选标准：权重、量表、阈值、题目、漏斗、合规与赛程，全部公开
function buildCriteria(rules, db) {
  const reg = rules.registration;
  const comp = rules.compliance ?? {};
  // 当届届期一并返回：前端据此提交报名 / 建队，省掉一个契约外的端点
  const edition = db ? (listEditions(db)[0] ?? null) : null;
  return {
    editionId: edition?.id ?? null,
    editionName: edition?.name ?? null,
    scale: reg.scale,
    dimensions: reg.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      weight: d.weight,
      min: d.min,
      max: d.max,
      items: (reg.questions?.dimensionItems?.[d.key] ?? []).map((it) => ({ id: it.id, text: it.text })),
    })),
    openQuestion: {
      ...reg.openQuestion,
      prompt: reg.questions?.openQuestionItem?.text ?? '',
    },
    levels: reg.levels.map((l) => ({
      key: l.key, label: l.label, minScore: l.minScore, accept: l.accept,
    })),
    // R-REG-10：5 阶段筛选漏斗
    funnel: reg.funnel ?? [],
    funnelNote: reg.funnelNote ?? '',
    // R-ENT-11 / R-ENT-12：IP 归属与合规红线在报名页明示
    ipOwnership: comp.ipOwnership ?? {},
    redLines: comp.redLines ?? [],
    consent: comp.consent ?? {},
    // R-STG-01：赛段时间轴
    schedule: rules.schedule?.stages ?? [],
  };
}

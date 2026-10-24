// src/services/review-state.js — 复核与申诉状态机
// 依据：设计文档 §11.2（人工复核与申诉状态机）
//   SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED
//               ↘ REJECTED ←（选手申诉）──┘
//               ↘ FLAGGED（疑似刷分/串通）→ REJECTED | CONFIRMED
//   借鉴 OpenReview 的状态机思路（MIT）：分阶段 + 幂等守卫（只处理首次 edit）。
// 三条硬规则：
//   ① PENDING_REVIEW 的分数对其他评委/企业不可见 → 必须在【API 层】过滤，前端隐藏 = 已泄露
//   ② 每次状态迁移写 audit_log(from_state, to_state, reason, at) → 否则申诉无法复盘
//   ③ 幂等守卫：重复触发不产生二次迁移
//   ④ 申诉触发 revision + 1 重算，不覆盖历史（旧 revision 保留）
//     ⚠️ DP-106：**只对赛段结果类申诉（team_result）成立** ——
//        报名类申诉（registration）撤销的是**分级裁定**，不涉及赛段分数 ⇒ 不触发重算。
//
// ⚠️ **状态机内核已抽出到 `src/services/review-state-core.js`**（E170 / F36）：
//    本模块是**可选模块**（路由层用 loadOptionalModule 动态加载；模块不在 ⇒ 申诉端点
//    回 503，但**平台必须照常启动**）⇒ 任何**始终在场**的代码路径都不能静态 import 本文件。
//    而「发榜时生产 FINALIZED」（F36 的修复）必须始终可用 ⇒ 内核（迁移表 + transition +
//    终稿推进）搬进 core 模块，本文件只留申诉队列 / 报名类申诉 / 档位判定。
import {
  REVIEW_STATES, REVIEW_TRANSITIONS, getSubjectState, transition,
} from './review-state-core.js';
import { insertAppeal, getAppeal, listAppealRows, updateAppeal } from '../db/repo/appeals.js';
import { getTeamTierRow } from '../db/repo/tiers.js';
// ⚠️ DP-106（报名类申诉）：报名的行与状态事件也要落库 ——
//    SQL 一律走仓储层（全局约束「SQL 只在 src/db/repo/」），服务层**不写 SQL**。
import { getRegistration as findRegistrationRow, updateRegistrationRow } from '../db/repo/registrations.js';
import { insertRegistrationEvent } from '../db/repo/registrationEvents.js';
import { getUserById } from '../db/repo/users.js';
import { hasActiveMembership } from '../db/repo/teamMembers.js';
import { getTeam } from '../db/repo/teams.js';
import { writeAuditLog } from '../audit/log.js';
import { withTransaction } from '../db/tx.js';
import { can, isCommitteeActor } from '../auth/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

// ⛔ 对外 API 不变：内核虽然搬走了，但历史调用方仍可从本模块 import（转出即可）。
export {
  REVIEW_STATES, REVIEW_TRANSITIONS, getSubjectState, transition,
} from './review-state-core.js';

/**
 * ⚠️ DP-106：**申诉是两件事，同一条队列**。
 *
 *   subjectType = 'team_result'  → 赛段结果类申诉（已 FINALIZED 的条目），**原有逻辑一字未改**。
 *   subjectType = 'registration' → 报名类申诉（选手对**自己的报名分级结果**不服），DP-106 新增。
 *
 * 两条申诉共用 appeals 表与同一个裁决队列（`listAppeals`），
 * 但**裁决口径完全不同**：赛段结果类要撤销终稿 + 重算；报名类只撤销**分级裁定**、回到待复核。
 * ⇒ 裁决分支必须先看 `appeal.subject_type`，不能一律按赛段结果处理。
 */
export const APPEAL_SUBJECT_TYPES = ['team_result', 'registration'];

/** 报名的**终态裁定**（委员会已拍板）—— 终态不可被选手改写（口径见 src/services/registration.js 的 decideRegistration）。 */
const REGISTRATION_TERMINAL_STATUSES = ['accepted', 'rejected'];

/** 申诉的**未裁决**状态（还有一条在队列里等人处理）⇒ 不许重复提交。 */
const APPEAL_PENDING_STATUSES = ['submitted', 'reviewing'];

/**
 * 申诉 SLA（M0-2）：组委会应在 `rules/compliance.json` 规定的时限内裁决。
 *
 * ⚠ 口径：SLA 是**对组委会的承诺**（不是对选手的）⇒ 超期**不自动改变裁决结果**，
 *    只在审计里留痕（是否逾期 + 逾期多久）并在裁决队列里显式标注。
 * ⚠ 时限来自配置（默认没有 = 不启用）⇒ 改时限只改 rules/compliance.json，代码只读它。
 */
function appealSlaHours(rules) {
  const hours = Number(rules?.compliance?.appeal?.slaHours);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

/**
 * 申诉的截止时刻与逾期状态（M0-2）。
 * 截止 = 提交时刻 + SLA 时长；逾期 = 现在晚于截止。
 * @param appeal 申诉行（created_at 或 createdAt 皆可）
 * @param rules 规则（读 rules.compliance.appeal.slaHours）
 * @param now 当前时刻（可注入 ⇒ 可测）
 */
function appealSlaOf(appeal, rules, now) {
  const hours = appealSlaHours(rules);
  const createdAt = appeal?.created_at ?? appeal?.createdAt ?? null;
  if (!hours || !createdAt) return { slaHours: hours, slaDueAt: null, slaOverdue: false };
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return { slaHours: hours, slaDueAt: null, slaOverdue: false };
  const dueMs = createdMs + hours * 3_600_000;
  const atMs = Date.parse(now ?? '') || Date.now();
  return {
    slaHours: hours,
    slaDueAt: new Date(dueMs).toISOString(),
    slaOverdue: atMs > dueMs,
  };
}

/**
 * 程序性错误白名单（M0-2「限程序性错误」）。
 *
 * ⚠ 规则驱动：白名单为空 ⇒ 不做限制（老配置 / 自定义规则集仍可用）。
 *    白名单非空 ⇒ **赛段结果类申诉必须声明理由类型且命中白名单**（fail-closed）。
 * ⚠ 为什么报名类不强制：选手侧前端契约已固定（web/views/registration.js 只发 reason），
 *    强改会让选手点「提交申诉」直接失败 ⇒ 报名类只在「传了」时校验。
 */
function appealReasonKindGate({ subjectType, reasonKind, rules }) {
  const allowed = Array.isArray(rules?.audit?.reviewState?.appealReasonKinds)
    ? rules.audit.reviewState.appealReasonKinds : [];
  if (!allowed.length) return null;
  const kind = String(reasonKind ?? '').trim();
  if (subjectType !== 'team_result' && !kind) return null;   // 报名类：可以不传
  if (!kind) {
    throw badRequest(
      `申诉必须声明理由类型（reasonKind），只能是：${allowed.join(' / ')}`
      + ' —— 申诉只受理**程序性错误**（算分错误 / 流程违规 / 数据错误）；'
      + '「我不服这个名次」这类主观不服不在受理范围（否则裁决队列会被淹没、SLA 必然失守）',
    );
  }
  if (!allowed.includes(kind)) {
    throw badRequest(`申诉理由类型非法：${kind}（只能是 ${allowed.join(' / ')}）`);
  }
  return kind;
}

export function parseAppealSubject(subjectId) {
  const idx = String(subjectId ?? '').indexOf(':');
  if (idx < 0) return { stageId: null, teamId: String(subjectId ?? '') };
  return { stageId: subjectId.slice(0, idx), teamId: subjectId.slice(idx + 1) };
}

/**
 * 分数可见性过滤（必须在 API 层调用，不是前端隐藏）。
 * PENDING_REVIEW 期间，分数对其他评委/企业不可见。
 */
export function filterVisibleScores({ db, stageId, viewer = null, scores = [] }) {
  const state = getSubjectState({ db, subjectType: 'stage_result', subjectId: stageId });
  if (state !== 'PENDING_REVIEW') return scores;

  const privileged = viewer ? can(viewer, 'audit:read', null, db) : false;
  return scores.map((s) => {
    if (privileged) return s;
    if (viewer && s.judgeId && s.judgeId === viewer.id) return s;
    return { ...s, rawScore: null, hidden: true, hiddenReason: 'pending_review' };
  });
}

/**
 * 提交申诉。范围：已 FINALIZED 且处于低可见档的条目（设计文档 §11.2）。
 *
 * ⚠️ DP-106：**按 subjectType 分支**。
 *   'team_result'（缺省）→ 下面的**原逻辑一字未改**（赛段结果类申诉，已上线有测试）。
 *   'registration'        → 报名类申诉（选手对**自己的报名分级结果**不服）。
 *
 * 为什么必须分支（这是 DP-106 的根因）：
 *   选手侧前端（web/views/registration.js）提交的是
 *   `{ subjectType: 'registration', subjectId: <报名 id> }`，
 *   而原实现无条件 `parseAppealSubject(subjectId)` 把它拆成 `stageId:teamId`
 *   ⇒ 报名 id 被当成赛段 id ⇒ 要求该 stage_result 已 FINALIZED ⇒ **必然 409**
 *   ⇒ 选手点「提交申诉」永远失败。
 */
export function fileAppeal({
  db, subjectType = 'team_result', subjectId, filedBy = null, reason, reasonKind = null,
  now = new Date().toISOString(), rules,
}) {
  // ⚠️ **F26（Medium，2026-10-23 审计）：本函数的写路径原先**全程无事务**** ——
  //   `withTransaction` / `SAVEPOINT` / `BEGIN` 一个都没有，却有十几处写调用 ⇒
  //   `UPDATE appeals` 抛错时，**状态迁移已经提交**、而申诉行还写着旧状态
  //   ⇒ 主体实际已是「已复核」（分数被隐藏）却**没有任何裁决记录**。
  //   ⚠️ 关键：**审计日志就是状态源**（`findLatestTransition` 从 audit_log 读当前状态） ⇒
  //   状态迁移与申诉行更新**必须同生共死**。
  //   （配合 F8：外层无事务时 `withTransaction` 走 `BEGIN IMMEDIATE`，嵌套时走 SAVEPOINT ⇒ 可安全嵌套。）
  return withTransaction(db, () => {
    if (!subjectId) throw badRequest('申诉必须给 subjectId');
    if (!reason || !String(reason).trim()) throw badRequest('申诉必须写理由（空理由 = 无法复核）');
    // ⚠️ M0-2「限程序性错误」：理由类型白名单（fail-closed）。
    //    白名单为空（老配置 / 自定义规则集）⇒ 不限制，保持兼容。
    const kind = appealReasonKindGate({ subjectType, reasonKind, rules });

    // ── 报名类申诉（DP-106）：独立的校验口径，见 fileRegistrationAppeal ──────
    if (subjectType === 'registration') {
      return fileRegistrationAppeal({ db, subjectId, filedBy, reason, reasonKind: kind, now, rules });
    }

    const { stageId, teamId } = parseAppealSubject(subjectId);
    // ⚛️ F34（Medium，2026-10-23 审计）：原来**没有归属校验** ——
    //   ⇒ 任何持有 appeal:write 的人都能对**别人队伍**的赛段结果提申诉。
    //   ⇒ 申诉人必须是该队成员（或组委会 / 超管）。
    //   ⛔ **归属校验必须排在状态校验之前**：否则对一条「不存在的条目」提申诉会先撞上
    //      409（状态不对），把「越权」掩盖成「状态错误」⇒ 排障时看错方向。
    if (teamId) {
      const actor = getUserById(db, filedBy);
      const team = getTeam(db, teamId);
      // 归属 = 该队**队长**或**在册成员**（队长身份来自 teams.captain_id，
      // 与 team_members 是否有行无关 —— 报名刚通过、还没落成员行时队长就该能申诉）
      const isCaptain = Boolean(team) && team.captain_id === filedBy;
      const isMember = Boolean(filedBy) && hasActiveMembership(db, teamId, filedBy);
      const isCommittee = actor && isCommitteeActor(db, actor);
      if (!isCaptain && !isMember && !isCommittee) {
        throw forbidden('只能对自己队伍的赛段结果提申诉');
      }
    }
    const state = stageId ? getSubjectState({ db, subjectType: 'stage_result', subjectId: stageId }) : null;
    if (state !== 'FINALIZED') {
      throw conflict(`只有已 FINALIZED 的条目可以申诉（当前状态：${state ?? '未进入复核'}）`);
    }

    const allowedTiers = rules?.audit?.reviewState?.appealAllowedTiers ?? [];
    const tier = teamId ? getTeamTierRow(db, teamId) : null;
    if (!tier) {
      throw conflict(`无法判定档位（队伍 ${teamId}）——档位未知时不得受理申诉`);
    }
    if (!allowedTiers.includes(tier)) {
      throw forbidden(`档位 ${tier} 不在可申诉的低可见档（${allowedTiers.join(' / ')}）范围内`);
    }

    const id = insertAppeal(db, {
      subjectType, subjectId, filedBy, reason, reasonKind: kind, status: 'submitted', now,
    });
    // ⚠️ M0-2：SLA 截止时刻写进审计（提交时刻 + rules.compliance.appeal.slaHours）。
    const sla = appealSlaOf({ created_at: now }, rules, now);
    writeAuditLog(db, {
      actorId: filedBy,
      action: 'appeal.filed',
      entity: 'appeal',
      entityId: id,
      detail: {
        subjectType, subjectId, reason, stageId, teamId, tier,
        reasonKind: kind, slaDueAt: sla.slaDueAt, slaHours: sla.slaHours,
      },
      now,
    });
    return { ...getAppeal(db, id), ...sla };
  });}

/**
 * 报名类申诉（DP-106）：选手对**自己的报名分级结果**不服，交给组委会复核。
 *
 * ⚠️ **校验顺序是有意设计的**（先查存在 → 再查权限 → 最后才查状态）：
 *   ① 报名记录必须存在 ⇒ 404
 *   ② 本人（或组委会代提交）⇒ 否则 403
 *   ③ 该报名**不得是终态裁定** ⇒ 否则 409
 *   ④ 该报名**不得已有未裁决的申诉** ⇒ 否则 409
 *   （⑤ 理由非空 —— 通用校验，已在 fileAppeal 入口挡住）
 *
 * 为什么是这个顺序：
 *   - 先存在后权限：不存在时不该泄露「这条报名存在但你无权」；
 *     先权限后状态同理 —— 别人家的报名不该被探出「委员会已经裁定过了」。
 *   - 状态排在最后：前两道是**身份**问题（404/403），状态是**业务**问题（409）；
 *     身份不成立时一律不谈业务状态，避免用 409 泄露他人报名的裁定进度。
 *
 * 口径依据：
 *   - ③ 的依据是 `src/services/registration.js` 的 decideRegistration 注释：
 *     「终态裁定不可被选手改写」—— 委员会已拍板（accepted / rejected）的报名，
 *     选手不能再申诉（要改只能走组委会直接复核那条路径）。
 *   - ④ 是防重复提交：同一报名同时只允许一条**待裁决**的申诉在队列里。
 */
function fileRegistrationAppeal({ db, subjectId, filedBy, reason, reasonKind = null, now, rules }) {
  // ① 存在性 → 404
  const reg = findRegistrationRow(db, subjectId);
  if (!reg) throw notFound(`报名记录不存在: ${subjectId}`);

  // ② 权限 → 403（本人，或组委会代提交）
  //    ⚠️ 组委会的判定走 can()（唯一的权限判定入口）：
  //    'registration:review' 是**分级复核**权限（按届期作用域），
  //    'audit:write' 是**审计写**权限（申诉裁决用的那一支）—— 两者都认。
  const isOwner = !!filedBy && reg.user_id === filedBy;
  const actor = filedBy ? getUserById(db, filedBy) : null;
  const isCommittee = !!actor && (
    can(actor, 'registration:review', { scopeType: 'edition', scopeId: reg.edition_id }, db)
    || can(actor, 'audit:write', null, db)
  );
  if (!isOwner && !isCommittee) throw forbidden('无权对该报名提交申诉');
  // ⚠️ 组委会代提交必须**留痕**（detail.onBehalf = true）：
  //    否则复盘时分不清「选手自己提交的」与「组委会替某个人提交的」。
  const onBehalf = isCommittee && !isOwner;

  // ③ 终态裁定 → 409（委员会已拍板，选手不能再申诉）
  if (REGISTRATION_TERMINAL_STATUSES.includes(reg.status)) {
    throw conflict(`该报名已由委员会裁定（${reg.status}），不可再申诉`);
  }

  // ④ 重复提交 → 409（同一报名同时只允许一条待裁决的申诉）
  //    ⚠️ 按状态分别查（而不是一次查全量再在 JS 里过滤）：
  //    listAppealRows 自带 limit ⇒ 全量查可能因分页**漏掉**那条待裁决的申诉
  //    （查「有没有」不需要看全量，只需要知道「有没有」）。
  const hasPending = APPEAL_PENDING_STATUSES.some(
    (st) => listAppealRows(db, { status: st, subjectType: 'registration', subjectId }).rows.length > 0,
  );
  if (hasPending) {
    throw conflict('该报名已有未裁决的申诉，请等待组委会裁决');
  }

  const id = insertAppeal(db, {
    subjectType: 'registration', subjectId, filedBy, reason, reasonKind, status: 'submitted', now,
  });
  const sla = appealSlaOf({ created_at: now }, rules, now);
  writeAuditLog(db, {
    actorId: filedBy,
    action: 'appeal.filed',
    entity: 'appeal',
    entityId: id,
    detail: {
      subjectType: 'registration',
      subjectId,
      reason,
      reasonKind: reasonKind ?? null,
      registrationStatus: reg.status,
      onBehalf,
      slaDueAt: sla.slaDueAt,
      slaHours: sla.slaHours,
    },
    now,
  });
  return { ...getAppeal(db, id), ...sla };
}

/**
 * 裁决申诉。成立 → 撤销终稿（FINALIZED → REJECTED → PENDING_REVIEW）并要求 revision + 1 重算。
 * 旧 revision 保留（重算走新记录，不覆盖历史）。
 */
export function decideAppeal({
  db, appealId, decision, decidedBy = null, note, now = new Date().toISOString(), rules,
}) {
  // ⚠️ **F26（Medium，2026-10-23 审计）：本函数的写路径原先**全程无事务**** ——
  //   `withTransaction` / `SAVEPOINT` / `BEGIN` 一个都没有，却有十几处写调用 ⇒
  //   `UPDATE appeals` 抛错时，**状态迁移已经提交**、而申诉行还写着旧状态
  //   ⇒ 主体实际已是「已复核」（分数被隐藏）却**没有任何裁决记录**。
  //   ⚠️ 关键：**审计日志就是状态源**（`findLatestTransition` 从 audit_log 读当前状态） ⇒
  //   状态迁移与申诉行更新**必须同生共死**。
  //   （配合 F8：外层无事务时 `withTransaction` 走 `BEGIN IMMEDIATE`，嵌套时走 SAVEPOINT ⇒ 可安全嵌套。）
  return withTransaction(db, () => {
    if (!['accepted', 'rejected'].includes(decision)) {
      throw badRequest(`裁决只能是 accepted 或 rejected，收到：${decision}`);
    }
    if (!note || !String(note).trim()) throw badRequest('裁决必须写说明（无说明的裁决无法复盘）');

    const appeal = getAppeal(db, appealId);
    if (!appeal) throw notFound(`申诉不存在: ${appealId}`);
    if (appeal.status !== 'submitted' && appeal.status !== 'reviewing') {
      throw conflict(`申诉 ${appealId} 已裁决（当前状态 ${appeal.status}）`);
    }

    const transitions = [];
    // ⚠️ DP-106：**先看 subject_type** —— 报名类与赛段结果类的裁决口径完全不同。
    //   'registration'（报名类）：成立 ⇒ 撤销**分级裁定**，让它回到待复核（不重算赛段）。
    //   其它（赛段结果类）：成立 ⇒ 撤销终稿（FINALIZED → REJECTED → PENDING_REVIEW）+ 重算。**原逻辑一字未改**。
    const isRegistrationAppeal = appeal.subject_type === 'registration';
    // 只有赛段结果类成立才要求重算（重算走 revision + 1，旧 revision 保留）。
    const recomputeRequired = decision === 'accepted' && !isRegistrationAppeal;
    if (decision === 'accepted') {
      if (isRegistrationAppeal) {
        // ── 报名类：撤销分级裁定 → 回到待复核 ──────────────────────────────
        // ⚠️ 为什么**不**触发赛段重算：报名分级与赛段分数是两套独立的量
        //    （设计文档 §9「报名分级」 vs §11.2「赛段复核」）。
        //    撤销一条分级裁定要重算的是**这条报名的分级**，由委员会重新复核落 level_final；
        //    赛段分数一个字都不受影响 ⇒ recomputeRequired 必须为 false、transitions 为空。
        const reg = findRegistrationRow(db, appeal.subject_id);
        if (!reg) throw notFound(`报名记录不存在: ${appeal.subject_id}`);
        const fromStatus = reg.status;
        // ⚠️ 改报名行**必须走仓储层**（全局约束：SQL 只在 src/db/repo/）。
        //    updateRegistrationRow 的可更新列白名单里含 level_final ⇒ 传 null 即清空裁定等级。
        //    （decided_by / decided_at / decision_note **保留**：那是上一次裁定的来源，
        //      撤销与否决都留在 registration_events 与审计日志里，不靠覆盖字段抹历史。）
        updateRegistrationRow(db, appeal.subject_id, {
          level_final: null,
          status: 'submitted',
        });
        // 事件轨迹（追加式，历史不覆盖）：from_status = 申诉前的状态，to_status = 回到待复核。
        insertRegistrationEvent(db, {
          registrationId: appeal.subject_id,
          fromStatus,
          toStatus: 'submitted',
          actorId: decidedBy,
          reason: note,
          now,
        });
      } else {
        const { stageId } = parseAppealSubject(appeal.subject_id);
        if (stageId) {
          transitions.push(transition({
            db, subjectType: 'stage_result', subjectId: stageId,
            from: 'FINALIZED', to: 'REJECTED', actorId: decidedBy,
            reason: `申诉成立：${note}`, idempotencyKey: `appeal:${appealId}:revoke`, now,
          }));
          transitions.push(transition({
            db, subjectType: 'stage_result', subjectId: stageId,
            from: 'REJECTED', to: 'PENDING_REVIEW', actorId: decidedBy,
            reason: `申诉重新复核：${note}`, idempotencyKey: `appeal:${appealId}:reopen`, now,
          }));
        }
      }
    }

    updateAppeal(db, { id: appealId, status: decision, decidedBy, decidedAt: now, decisionNote: note });
    // ⚠️ M0-2：裁决时把 SLA 状态一并留痕（是否超期、超期多久）⇒ 事后能复盘「委员会响应时效」。
    const sla = appealSlaOf(appeal, rules, now);
    writeAuditLog(db, {
      actorId: decidedBy,
      action: 'appeal.decided',
      entity: 'appeal',
      entityId: appealId,
      detail: {
        decision,
        note,
        subjectType: appeal.subject_type,
        subjectId: appeal.subject_id,
        recomputeRequired,
        slaHours: sla.slaHours,
        slaDueAt: sla.slaDueAt,
        slaOverdue: sla.slaOverdue,
      },
      now,
    });

    return {
      appeal: getAppeal(db, appealId),
      transitions,
      // 申诉成立必须重算；重算走 revision + 1，旧 revision 保留（不覆盖历史）
      recomputeRequired,
      ...sla,
    };

  });}

/**
 * 申诉列表。列表不满足 → 200 + 空集。
 *
 * ⚠️ M0-2：每行带 **reasonKind**（程序性错误类型）+ **SLA**（slaDueAt / slaOverdue）
 *    ⇒ 组委会的裁决队列里能直接看到「这条是哪类错」与「还剩多久必须裁决」。
 */
export function listAppeals({ db, filter = {}, viewer = null, rules = null, now = new Date().toISOString() }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0 };
  const { rows, total } = listAppealRows(db, filter);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      filedBy: r.filed_by,
      reason: r.reason,
      // ⚠️ M0-2：老申诉（迁移前）没有理由类型 ⇒ null（不许假装成某一类）。
      reasonKind: r.reason_kind ?? null,
      status: r.status,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
      ...appealSlaOf(r, rules, now),
    })),
    total,
  };
}

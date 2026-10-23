// src/services/taskPackage.js — 任务卡服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）+ 顶层文档 §3.1/§3.2
// 溯源需求：R-ENT-01 / R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09 / R-ENT-10 / R-ENT-11 / R-ENT-12
import { AppError } from '../errors.js';
import { scoreSolvability } from '../domain/solvability.js';
import {
  createTaskPackage, getTaskPackage, listTaskPackagesByEdition, updateTaskPackage,
} from '../db/repo/taskPackages.js';
import { getEdition } from '../db/repo/editions.js';
import { getUserById } from '../db/repo/users.js';
import { listUserRoles } from '../db/repo/roles.js';
import { writeAuditLog } from '../audit/log.js';
import { can, isCommitteeActor, isEnterpriseOwner } from '../auth/permissions.js';

// ⚠️ 父代理预审修正（Important，状态机）：任务卡的生命周期是
//    submitted → assessed → published | returned →（补短板后）assessed → …
//    没有状态机 = 任何状态都能被评估/签级，审计轨迹失真。
const ASSESSABLE = new Set(['submitted', 'assessed', 'returned']);
const APPROVABLE = new Set(['assessed', 'returned']);

function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function presentTaskPackage(row) {
  if (!row) return null;
  const meta = parseJson(row.meta_json, {}) ?? {};
  return {
    id: row.id,
    editionId: row.edition_id,
    enterpriseId: row.enterprise_id,
    enterpriseName: row.enterprise_name,
    title: row.title,
    painPoint: row.pain_point,
    expectedDelivery: row.expected_delivery,
    acceptanceCriteria: row.acceptance_criteria,
    grade: row.grade,
    status: row.status,
    solvabilityScore: row.solvability_score,
    solvabilityGrade: row.solvability_grade,
    commitment: row.commitment,
    agreement: row.agreement,
    isFreeBrief: Number(row.is_free_brief) === 1,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    meta,
  };
}

export function submitTaskPackage({ db, userId, payload, now = new Date().toISOString(), rules }) {
  const {
    editionId, title, painPoint, expectedDelivery, acceptanceCriteria,
    enterpriseId = null, enterpriseName = null, isFreeBrief = false, consent = null,
  } = payload ?? {};

  if (!editionId) throw new AppError(400, 'MISSING_EDITION_ID', '缺少届期');
  // ⚠️ 父代理预审修正（Important）：届期必须真实存在。
  //    原来只判 `!editionId` 就直接 INSERT → edition_id 外键约束失败，
  //    SQLite 原文「FOREIGN KEY constraint failed」漏到 HTTP 层（只能回 500，
  //    还把表结构暴露给客户端）。报名服务 submitRegistration 早就查过 getEdition，
  //    任务卡这边漏了 —— 与 P0 评审修正 I5（重复手机号先查后写）同一类问题。
  if (!getEdition(db, editionId)) {
    throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
  }
  // R-ENT-01：痛点、期望交付、验收标准三者缺一不可
  if (!title || !painPoint || !expectedDelivery || !acceptanceCriteria) {
    throw new AppError(400, 'INCOMPLETE_TASK_PACKAGE', '任务卡必须填写痛点、期望交付与验收标准');
  }
  // R-ENT-12：合规红线与同意记录
  const consentCfg = rules.compliance?.consent ?? {};
  if (consentCfg.required && consent?.accepted !== true) {
    throw new AppError(400, 'CONSENT_REQUIRED', '必须确认合规红线与唯一责任人');
  }
  // R-ENT-10：自由命题没有企业签字，不得挂企业主体
  if (isFreeBrief && (enterpriseId || enterpriseName)) {
    throw new AppError(400, 'FREE_BRIEF_NO_ENTERPRISE', '自由命题任务卡不得挂企业主体');
  }

  // ⚛️ F31（Medium，2026-10-23 审计）：任务卡的 enterprise_id 原来**照抄请求体** ——
  //   ⇒ 任何人都能把任务卡挂到**别人**的企业名下（冒用企业主体；该字段会进公开榜与签级链路）。
  //   ⇒ 企业主体**由提交人自己决定**，请求体里的 enterpriseId 只在**与提交人身份一致**时采纳：
  //     ① 企业席本人提交      ⇒ 挂自己（enterprise_id = 自己的 user id）；
  //     ② 企业管理员提交      ⇒ 目标企业的 org 必须与自己的 org 相同，否则不挂；
  //     ③ 组委会提交          ⇒ 受信任，按请求体挂（赛制需要代挂）；
  //     ④ 其它角色            ⇒ 不挂企业主体。
  //   ⇒ id 与 name 必须一致：id 被改写时，name 一并改成该企业自己的名字
  //     （否则会出现「id 指向 A、名字写着 B」的错挂）。
  const actor = getUserById(db, userId);
  const actorRoles = listUserRoles(db, userId);
  const requestedEnterpriseId = enterpriseId ?? null;
  let effectiveEnterpriseId = null;
  if (actorRoles.includes('enterprise')) {
    effectiveEnterpriseId = userId;
  } else if (actorRoles.includes('enterprise_admin')) {
    const target = requestedEnterpriseId ? getUserById(db, requestedEnterpriseId) : null;
    if (target && target.org && actor && target.org === actor.org) {
      effectiveEnterpriseId = requestedEnterpriseId;
    }
  } else if (actorRoles.includes('admin')) {
    effectiveEnterpriseId = requestedEnterpriseId;
  }
  let effectiveEnterpriseName = enterpriseName ?? null;
  if (effectiveEnterpriseId !== requestedEnterpriseId) {
    const eff = effectiveEnterpriseId ? getUserById(db, effectiveEnterpriseId) : null;
    effectiveEnterpriseName = eff ? (eff.name ?? null) : null;
  }

  // R-ENT-11：IP 与成果归属 —— 同意记录随任务卡一起留存
  const meta = {
    consent: { ...(consent ?? {}), acceptedAt: now },
    ipOwnership: rules.compliance?.ipOwnership ?? {},
  };

  const row = createTaskPackage(db, {
    editionId, enterpriseId: effectiveEnterpriseId, enterpriseName: effectiveEnterpriseName,
    title, painPoint,
    expectedDelivery, acceptanceCriteria, isFreeBrief, submittedBy: userId, meta, now,
  });
  return presentTaskPackage(row);
}

export function assessSolvability({ db, taskPackageId, answers, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
  // ⚠️ **企业归属闸**（F42）：`task_package:write` 能力点被 `enterprise` 角色持有，
  //    而角色授权是**全局**的（INTERFACES.md:22）⇒ 原来企业 A 可以对**企业 B 的**任务卡
  //    重评六维可解性与分数 —— 而这两项正是 `grade`（进池的等级）与承诺的**输入**。
  //    ⇒ 归属口径与「企业确认」端点（routes/review.js 的 N03 闸）**逐字同源**：
  //    提交人本人 / 出题企业本人 / 同一企业（org 相同）三者之一；组委会可代评。
  const actor = getUserById(db, actorId);
  if (!isCommitteeActor(db, actor) && !isEnterpriseOwner(db, actorId, {
    enterpriseId: row.enterprise_id, submittedBy: row.submitted_by,
  })) {
    throw new AppError(403, 'FORBIDDEN', '只能重新评估自己企业的任务卡');
  }
  // ⚠️ 父代理预审修正（Important，状态机）：已发布的卡不能再评估。
  if (!ASSESSABLE.has(row.status)) {
    throw new AppError(409, 'TASK_PACKAGE_STATE_INVALID', `当前状态（${row.status}）不允许重新评估`);
  }
  // 六维取值范围校验（服务层做输入校验，领域层保持纯）
  for (const dim of config.dimensions) {
    const v = Number(answers?.[dim.key]);
    if (!Number.isInteger(v) || v < 0 || v > dim.max) {
      throw new AppError(
        400, 'INVALID_SOLVABILITY_ANSWERS',
        `${dim.label} 必须为 0–${dim.max} 的整数`,
      );
    }
  }
  const declared = Array.isArray(answers?.vetoes) ? answers.vetoes : [];
  for (const key of declared) {
    if (!config.vetoes.some((v) => v.key === key)) {
      throw new AppError(400, 'INVALID_VETO_KEY', `未知的否决项：${key}`);
    }
  }

  const result = scoreSolvability({ answers, config });
  const meta = parseJson(row.meta_json, {}) ?? {};
  meta.solvability = {
    // ⚠️ 父代理预审修正（Important）：score / grade 必须一起存。
    //    原来只存 vetoes/explain/computedGrade → buildDiagnosticReport 里
    //    `solvability.score ?? null` 恒为 null —— 《问题可解性诊断报告》
    //    （D 级退回时给企业的唯一凭据）里分数永远是空的。
    //    父代理预审实跑复现：诊断报告 score = null。
    score: result.score,
    grade: result.grade,
    vetoes: result.vetoes,
    explain: result.explain,
    computedGrade: result.computedGrade,
    // ⚛️ F16（Critical）：**档位定义必须一并投影出来**。
    //    原来这里只投影维度 explain（不含 minScore/maxScore）⇒ 前端的「服务端投影」
    //    只能反推出**档位键**、没有分数区间 ⇒ `gradeTiers()` 判「档位未就绪」
    //    ⇒ **一旦有任意一张卡被评估过，签级控件就整片消失**（自锁：评估更多卡也修不好）。
    //    为什么必须服务端带：生产部署**不挂** /rules/（只有 DEMO_MODE=1 才挂）
    //    ⇒ 规则投影那条路在生产是断的 ⇒ 服务端不带完整档位定义，前端就没有可用规格。
    //    （前端侧还有一道兜底：投影不出完整档位就返回 null，降级到规则投影 —— 见
    //      web/views/admin-task-packages.js 的 solvabilitySpecFromPackages。）
    grades: config.grades.map((g) => ({
      key: g.key,
      minScore: Number(g.minScore),
      maxScore: Number(g.maxScore),
      commitment: String(g.commitment ?? ''),
      agreement: String(g.agreement ?? ''),
    })),
    // 否决项的**完整定义**（key/label/auto）—— 与 `vetoes`（本次命中的那几项）不是一回事：
    // 前端要靠 `auto` 区分「由维度取值自动命中」与「委员会自报」。
    vetoesSpec: config.vetoes.map((v) => ({
      key: v.key,
      label: String(v.label ?? v.key),
      auto: Boolean(v.auto),
    })),
    assessedBy: actorId,
    assessedAt: now,
  };

  const updated = updateTaskPackage(db, taskPackageId, {
    solvability_score: result.score,
    solvability_grade: result.grade,
    commitment: result.commitment,
    agreement: result.agreement,
    status: 'assessed',
    meta_json: meta,
  });
  return presentTaskPackage(updated);
}

export function approveTaskPackage({
  db, taskPackageId, grade, reason = null, actorId, now = new Date().toISOString(), rules,
}) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');

  let gradeCfg = config.grades.find((g) => g.key === grade);
  if (!gradeCfg) {
    throw new AppError(400, 'INVALID_GRADE', `等级必须是 ${config.grades.map((g) => g.key).join(' / ')}`);
  }
  // ⚠️ P10（W4-a）：**主动退回（D 级）必须写理由** ——
  //    「退回了但没说为什么」= 企业拿到一张退回通知，却不知道该改什么
  //    （R-ENT-08 的《问题可解性诊断报告》是产物，但退回理由是**给人看的话**，不是数据）。
  //    ⛔ 只在**委员会自己选 D** 时强制：因一票否决被系统强制降到 D 的情形
  //    已有诊断报告说明原因（命中了哪条否决项）⇒ 不在这里卡人。
  if (grade === 'D' && (!reason || !String(reason).trim())) {
    throw new AppError(400, 'RETURN_REASON_REQUIRED', '退回任务卡必须写明退回理由（企业要照着改）');
  }

  const meta = parseJson(row.meta_json, {}) ?? {};
  const solvability = meta.solvability ?? {};
  const vetoes = solvability.vetoes ?? [];

  // ⚠️ 父代理预审修正（Important，规格缺陷）：**必须先做六维评估才能签级**。
  //    原来只读 meta.solvability.vetoes —— 没评估过的卡，meta.solvability 是空的，
  //    vetoes 为空 → 跳过「一票否决强制降级」→ 直接签 A 并发布。
  //    父代理预审实跑复现：grade = A、status = published、solvabilityScore = null。
  //    这等于**六维可解性评估闸门形同虚设**，与 P1 Task 3 验收发现的 A1
  //    （registration:write 能力点被注册但从不校验）同一类：
  //    「机制被写下来了，但没接线」。
  if (typeof solvability.score !== 'number') {
    throw new AppError(
      400, 'SOLVABILITY_NOT_ASSESSED',
      '任务卡必须先完成六维可解性评估，才能分级签约',
    );
  }
  // ⚠️ 父代理预审修正（Important，状态机）：只有已评估/已退回的卡才可签级。
  if (!APPROVABLE.has(row.status)) {
    throw new AppError(409, 'TASK_PACKAGE_STATE_INVALID', `当前状态（${row.status}）不允许分级签约`);
  }

  // 存在未解除的一票否决 → 不得签成 A/B/C，强制退回
  if (vetoes.length && grade !== 'D') {
    gradeCfg = config.grades.find((g) => g.key === 'D');
  }
  const finalGrade = gradeCfg.key;
  const isFree = Number(row.is_free_brief) === 1;

  const patch = {
    grade: finalGrade,
    approved_by: actorId,
    approved_at: now,
    status: finalGrade === 'D' ? 'returned' : 'published',
    // R-ENT-10：自由命题无企业签字 → 不签任何企业协议
    commitment: isFree ? '无' : gradeCfg.commitment,
    agreement: isFree ? '自由命题不签约，无企业协议' : gradeCfg.agreement,
  };

  if (finalGrade === 'D') {
    // R-ENT-08：D 级不是静默丢弃 —— 必须出《问题可解性诊断报告》
    solvability.diagnosticReport = buildDiagnosticReport({ row, solvability, config, now });
  } else if (solvability.diagnosticReport) {
    // ⚠️ 2026-10-21 独立评审修正（Minor M-6：**旧 D 级报告残留**）：
    //    原来只在 finalGrade === 'D' 时写 meta_json。一张被退回过（D 级、带诊断报告）
    //    的卡，重新评估后被签成 A 级时，**旧的诊断报告还挂在 meta 上** ——
    //    已发布的卡上挂着一份「grade: D, score: 12」的过期报告，
    //    前端会把退回结论和当前结论一起显示出来（独立评审实跑复现）。
    //    现在签非 D 级时**清掉**旧报告：诊断报告只对 D 级成立。
    delete solvability.diagnosticReport;
  }
  // ⚠️ P10：签级结论写进 meta（前端可见、可复盘）
  solvability.decision = {
    grade: finalGrade,
    requestedGrade: grade,
    reason: reason ? String(reason).trim() : null,
    decidedBy: actorId,
    decidedAt: now,
  };
  meta.solvability = solvability;
  patch.meta_json = meta;
  const updated = updateTaskPackage(db, taskPackageId, patch);
  // ⚠️ P10：签级结论**必须留痕**（可复盘）。
  //    · meta.solvability.decision ⇒ 前端能看到「谁在什么时候签的、理由是什么」；
  //    · 审计日志 ⇒ 与其它「改级会留痕」的动作同规格（可被复核队列检索）。
  writeAuditLog(db, {
    actorId,
    action: 'task_package.approve',
    entity: 'task_package',
    entityId: taskPackageId,
    detail: { grade: finalGrade, requestedGrade: grade, reason: reason ? String(reason).trim() : null },
    now,
  });
  return presentTaskPackage(updated);
}

// 《问题可解性诊断报告》：D 级任务卡的强制产物
function buildDiagnosticReport({ row, solvability, config, now }) {
  const explain = solvability.explain ?? [];
  const weakest = [...explain].sort((a, b) => a.contribution - b.contribution).slice(0, 2);
  const suggestions = weakest.map(
    (d) => `「${d.label}」当前 ${d.value}/${d.max}（折算 ${d.contribution} 分），是拉低可解性的主要短板，建议先补齐这一维。`,
  );
  const vetoLabels = (solvability.vetoes ?? []).map(
    (k) => config.vetoes.find((v) => v.key === k)?.label ?? k,
  );
  if (vetoLabels.length) {
    suggestions.push(`命中一票否决项：${vetoLabels.join('、')}。未解除前不进入任务包池。`);
  }
  return {
    title: '问题可解性诊断报告',
    generatedAt: now,
    packageTitle: row.title,
    score: solvability.score ?? null,
    grade: 'D',
    vetoes: solvability.vetoes ?? [],
    vetoLabels,
    dimensions: explain,
    suggestions,
    disposition: '退回出题方并附本诊断报告；补齐短板后可重新提交六维评估。',
  };
}

export function listTaskPackages({ db, filter = {}, viewer, rules }) {
  // 列表权限不满足 → 空数组（API 层 200 + 空集）
  const ok = viewer
    && can(viewer, 'task_package:read', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  if (!ok) return [];
  const all = listTaskPackagesByEdition(db, filter.editionId);
  // 组委会看全部；选手与普通企业侧只看已分级发布的（未分级的不进任务包池）
  const isCommittee = viewer
    && can(viewer, 'task_package:approve', { scopeType: 'edition', scopeId: filter.editionId ?? null }, db);
  // ⚠️ 父代理预审修正（Minor）：**提交方能看到自己提交的卡**。
  //    原来非组委会一律只返回 status === 'published' —— 企业提交完任务卡，
  //    在列表里却一条都看不到（提交方视角形同虚设）。
  //    「未分级的不进任务池」针对的是**选题池**，不等于提交方看不到自己的卡。
  const visible = isCommittee
    ? all
    : all.filter((p) => p.status === 'published' || p.submitted_by === viewer.id);
  return visible.map(presentTaskPackage);
}

// src/services/taskPackage.js — 任务卡服务
// 依据：INTERFACES.md §2「服务层」签名（逐字对齐）+ 顶层文档 §3.1/§3.2
// 溯源需求：R-ENT-01 / R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09 / R-ENT-10 / R-ENT-11 / R-ENT-12
import { AppError } from '../errors.js';
import { scoreSolvability } from '../domain/solvability.js';
import {
  createTaskPackage, getTaskPackage, listTaskPackagesByEdition, updateTaskPackage,
} from '../db/repo/taskPackages.js';
import { getEdition } from '../db/repo/editions.js';
import { can } from '../auth/permissions.js';

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

  // R-ENT-11：IP 与成果归属 —— 同意记录随任务卡一起留存
  const meta = {
    consent: { ...(consent ?? {}), acceptedAt: now },
    ipOwnership: rules.compliance?.ipOwnership ?? {},
  };

  const row = createTaskPackage(db, {
    editionId, enterpriseId, enterpriseName, title, painPoint,
    expectedDelivery, acceptanceCriteria, isFreeBrief, submittedBy: userId, meta, now,
  });
  return presentTaskPackage(row);
}

export function assessSolvability({ db, taskPackageId, answers, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');
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

export function approveTaskPackage({ db, taskPackageId, grade, actorId, now = new Date().toISOString(), rules }) {
  const config = rules.solvability;
  const row = getTaskPackage(db, taskPackageId);
  if (!row) throw new AppError(404, 'TASK_PACKAGE_NOT_FOUND', '任务包不存在');

  let gradeCfg = config.grades.find((g) => g.key === grade);
  if (!gradeCfg) {
    throw new AppError(400, 'INVALID_GRADE', `等级必须是 ${config.grades.map((g) => g.key).join(' / ')}`);
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
  meta.solvability = solvability;
  patch.meta_json = meta;

  const updated = updateTaskPackage(db, taskPackageId, patch);
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

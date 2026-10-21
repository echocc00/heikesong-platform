// src/domain/behavior.js — 行为分计算（纯函数，★ 与总分完全隔离的独立通路）
// 依据：S10 §3.1 计分明细 + §3.2 达标线 60 + §3.3 只做"垫底排序" + R-PTS-07/08/09/10
//
// ⛔ 本模块的产出【只】允许流向破同分链的 'behavior' 键（scope=tied_only）。
//    ⛔ 绝不进入 scoreStage() 入参、绝不进入 total / seatP / seatE、绝不进入名次积分。
//    ⛔ 数据来源是独立表 behavior_events，不从 stage_results 派生。
//    依据：S10 §8 第三条风险原文「分轨必须是算法层面的，不是纪律层面的」。
//
// ✅ 借鉴 HackSC/hibiscus 的行为分发放日志表结构（MIT），但排序时【不】与赛事分相加
//    （上游 getRank 把 bonus_points + event_points 相加，与本规则直接冲突——只抄表结构）。

// 证据要求（默认口径）。服务层会用 rules/criteria.behaviorEvidence 注入的版本覆盖它。
// 依据：R-STG-04「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」
//     + R-PTS-10 反作弊第 3/5 条「提交须带版本记录 + 代码仓」「纯文字进度不给分」
const DEFAULT_EVIDENCE_REQUIREMENTS = {
  weekly_progress: { required: ['repo', 'version'], oneOf: ['artifact', 'blocker'] },
  workshop_output: { required: ['output'], oneOf: [] },
  enterprise_meeting: { required: ['enterpriseConfirmationId'], oneOf: [] },
};

function parseEvidence(ev) {
  const raw = ev?.evidence;
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'missing_evidence' };
  if (typeof raw === 'object') return { ok: true, data: raw };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'evidence_not_object' };
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'evidence_not_json' };   // ⛔ 纯文字进度：不给分（R-STG-04 / R-PTS-10）
  }
}

function checkEvidence(def, ev, requirements) {
  const rule = requirements[def.key];
  if (!rule) return { ok: true };
  const parsed = parseEvidence(ev);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  for (const field of rule.required || []) {
    const v = parsed.data[field];
    if (v === undefined || v === null || String(v).trim() === '') {
      return { ok: false, reason: `evidence_missing_${field}` };
    }
  }
  const oneOf = rule.oneOf || [];
  if (oneOf.length) {
    const hit = oneOf.some((f) => {
      const v = parsed.data[f];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
    if (!hit) return { ok: false, reason: `evidence_missing_any_of_${oneOf.join('_or_')}` };
  }
  return { ok: true };
}

/**
 * 计算行为分。
 * events: [{ id, type, evidence, created_at }]
 *   ⚠️ 分值【不】取自事件本身，一律以 rules/behavior-points.json 为准（防篡改）。
 * behaviorConfig: rules.behavior（可额外带 evidenceRequirements 覆盖默认证据要求）
 */
export function behaviorScore({ events, behaviorConfig }) {
  const cfg = behaviorConfig || {};
  const defs = Array.isArray(cfg.events) ? cfg.events : [];
  const threshold = Number.isFinite(cfg.completionThreshold) ? cfg.completionThreshold : 60;
  const requirements = { ...DEFAULT_EVIDENCE_REQUIREMENTS, ...(cfg.evidenceRequirements || {}) };
  const byKey = new Map(defs.map((d) => [d.key, d]));

  // 按创建时间升序（域内排序，无 IO、无 Date.now）
  const sorted = [...(Array.isArray(events) ? events : [])].sort((a, b) => {
    const ca = String(a?.created_at ?? '');
    const cb = String(b?.created_at ?? '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a?.id ?? '') < String(b?.id ?? '') ? -1 : (String(a?.id ?? '') > String(b?.id ?? '') ? 1 : 0);
  });

  const seenOnce = new Set();
  const items = [];
  let total = 0;
  for (const ev of sorted) {
    const type = ev?.type;
    const def = byKey.get(type);
    if (!def) {
      // 未知类型（如"签到"）→ 0 分并明确记录，不静默（R-PTS-10 反作弊第 1 条）
      items.push({ type, points: 0, label: String(type), counted: false, reason: 'unknown_event_type' });
      continue;
    }
    if (def.once && seenOnce.has(def.key)) {
      items.push({ type: def.key, points: 0, label: def.label, counted: false, reason: 'once_limit' });
      continue;
    }
    const check = checkEvidence(def, ev, requirements);
    if (!check.ok) {
      items.push({ type: def.key, points: 0, label: def.label, counted: false, reason: check.reason });
      continue;
    }
    seenOnce.add(def.key);
    const pts = Number(def.points) || 0;
    total += pts;
    items.push({ type: def.key, points: pts, label: def.label, counted: true, reason: null });
  }
  return {
    total,
    items,
    completed: total >= threshold,          // R-PTS-09：达标线 60 → 完赛认定
    completionThreshold: threshold,
    maxWeightShare: cfg.maxWeightShare ?? null,
    sortUse: cfg.sortUse ?? null,           // 取自配置；配置层 fail-fast 校验它必须是 'tiebreak_only'（R-PTS-08）
  };
}

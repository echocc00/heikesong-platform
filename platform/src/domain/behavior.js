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
 * 次数约束（F38）：一个行为事件**最多能计几次分**。
 *
 * ⚠️ **修复前的病根**：5 个事件里只有 `first_demo` 有 `once` ⇒ 其余 4 个**无上限**
 *    ⇒ 提交 40 次 `weekly_progress` = 80 分 ⇒ **超过完赛线 60**
 *    ⇒ 「完赛认定」可在一分钟 API 调用内达成 ⇒ 而行为分是破同分链的**倒数第二个键**
 *    ⇒ 刷行为分 ⇒ 决定同分队伍的排名 ⇒ 决定 10/8/5 的赛段积分 ⇒ **决定钱**。
 *
 * ⛔ **口径**（写在规则文件里，代码只执行它）：
 *   · `once: true` **且无 cadence** ⇒ **终身一次**（reason: `once_limit`）
 *   · `once: true` **且有 cadence** ⇒ 每个滚动窗口内最多 `maxCount` 次
 *     （reason: `cadence_limit`）—— 「每周提交一次进度」真的按**周**算，
 *     而不是「一次性事件」也不是「无限次」。
 *
 * ⚠️ 为什么用**滚动窗口**而不是「自然周」：自然周要定时区（跨时区队伍会差一天），
 *    而滚动窗口只依赖事件自身的时间戳 ⇒ **可复算**（R-AUD-01）。
 *
 * @returns {{max:number, windowMs:number|null}|null} null = 无次数约束
 */
function countLimitOf(def) {
  if (!def?.once) return null;
  const cadence = def.cadence ?? null;
  if (!cadence) return { max: 1, windowMs: null };
  const maxCount = Number.isInteger(cadence.maxCount) && cadence.maxCount > 0 ? cadence.maxCount : 1;
  const windowDays = Number.isFinite(cadence.windowDays) && cadence.windowDays > 0 ? cadence.windowDays : null;
  return { max: maxCount, windowMs: windowDays === null ? null : windowDays * 86_400_000 };
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

  /** 已计分事件的时间戳（按 key）—— 用于次数约束（F38） */
  const countedAt = new Map();
  const items = [];
  let total = 0;
  for (const ev of sorted) {
    const type = ev?.type;
    const def = byKey.get(type);
    if (!def) {
      // 未知类型（如"签到"）→ 0 分并明确记录，不静默（R-PTS-10 反作弊第 1 条）
      items.push({ id: ev?.id ?? null, type, points: 0, label: String(type), counted: false, reason: 'unknown_event_type' });
      continue;
    }
    const limit = countLimitOf(def);
    if (limit) {
      const atMs = Date.parse(ev?.created_at ?? '');
      const times = countedAt.get(def.key) ?? [];
      // ⛔ 时间戳坏掉 ⇒ **不猜**：按「无法归入任何窗口」处理 ⇒ 不计分（宁可漏一分也不可无限刷）
      if (!Number.isFinite(atMs)) {
        items.push({ id: ev?.id ?? null, type: def.key, points: 0, label: def.label, counted: false, reason: 'cadence_unknown_time' });
        continue;
      }
      const inWindow = limit.windowMs === null
        ? times.length
        : times.filter((t) => atMs - t < limit.windowMs).length;
      if (inWindow >= limit.max) {
        items.push({
          id: ev?.id ?? null, type: def.key, points: 0, label: def.label, counted: false,
          reason: limit.windowMs === null ? 'once_limit' : 'cadence_limit',
        });
        continue;
      }
    }
    const check = checkEvidence(def, ev, requirements);
    if (!check.ok) {
      items.push({ id: ev?.id ?? null, type: def.key, points: 0, label: def.label, counted: false, reason: check.reason });
      continue;
    }
    if (limit) {
      const times = countedAt.get(def.key) ?? [];
      times.push(Date.parse(ev.created_at));
      countedAt.set(def.key, times);
    }
    const pts = Number(def.points) || 0;
    total += pts;
    items.push({ id: ev?.id ?? null, type: def.key, points: pts, label: def.label, counted: true, reason: null });
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

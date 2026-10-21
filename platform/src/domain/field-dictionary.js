// src/domain/field-dictionary.js — 审计字段字典（唯一字段名来源）
// 依据：R-AUD-06「并行前定字段字典」
//   溯源：周报 2026-10-12~18 §4.2 教训 5 —— 字段互斥替换（"借鉴维度" vs "同样点/差异点"）、
//   置信度三套标签并行。同样的失败模式会在"多个检测器并行产出 flag"时重演。
//   → 字段名只有这一个来源；不在字典里的字段名在【写入前】就被拒绝，不进库。
// 纯函数常量与断言，无 IO。
//
// ⚠️ 字典的适用范围：**检测器产出的 flag 明细**（runDetection 写进 detail_json 的那份）。
//    「裁决」阶段由人追加的 resolution / evidence 不在检测明细范围内 —— 那是裁决记录，不是检测结论。
// ⛔ 每个 kind 的字段表必须**覆盖检测器实际写进 detail_json 的每一个键**：
//    少写一个键，runDetection 就会把**所有**检测产出判成「字段不合规」并抛 400，
//    检测器等于完全不能用（kind / action 是每个 flag 都带的两个固定键）。
export const FLAG_DETAIL_FIELDS = {
  self_vs_judge: ['kind', 'teamId', 'dimension', 'judgeScore', 'selfScore', 'delta', 'action'],
  burst_submit: ['kind', 'subjectId', 'count', 'windowStart', 'windowEnd', 'action'],
  identical_peer_pattern: ['kind', 'voterA', 'voterB', 'overlap', 'targets', 'matchRatio', 'action'],
  low_variance: ['kind', 'judgeId', 'dimension', 'stdev', 'n', 'mean', 'direction', 'action'],
  multi_account: ['kind', 'keyField', 'keyValue', 'userIds', 'count', 'action'],
  tied_mutual_peer_rate: ['kind', 'rank', 'tiedPairs', 'rate', 'threshold', 'action'],
  reverse_audit: ['kind', 'teamId', 'rank', 'total', 'signoffs', 'instruction', 'action'],
};

// 置信度标签只有这一套。（周报教训 5：并行任务曾各自造了三套置信度标签，最后无法合并）
export const CONFIDENCE_LABELS = ['high', 'medium', 'low'];

// 互斥字段组：同一份记录里只能出现其中一套。
export const MUTUALLY_EXCLUSIVE = [
  {
    group: 'inspiration',
    fields: ['借鉴维度', '同样点', '差异点'],
    message: '「借鉴维度」与「同样点/差异点」互斥，同一份记录只能用一个字段组',
  },
];

export function assertKnownFields(kind, detail) {
  const allowed = FLAG_DETAIL_FIELDS[kind];
  if (!allowed) return [`未知的 flag kind: ${kind}（字段字典里没有定义）`];
  const errors = [];
  for (const key of Object.keys(detail ?? {})) {
    if (!allowed.includes(key)) {
      errors.push(`字段名 "${key}" 不在 ${kind} 的字段字典里（允许：${allowed.join(', ')}）`);
    }
  }
  return errors;
}

export function assertMutuallyExclusive(detail) {
  const errors = [];
  for (const rule of MUTUALLY_EXCLUSIVE) {
    const hit = rule.fields.filter((f) => detail && detail[f] !== undefined && detail[f] !== null);
    if (hit.length > 1) {
      errors.push(`${rule.message}（本次出现：${hit.join(' / ')}）`);
    }
  }
  return errors;
}

export function assertConfidenceLabel(value) {
  return CONFIDENCE_LABELS.includes(value);
}

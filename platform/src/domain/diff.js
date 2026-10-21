// src/domain/diff.js — 结构化差异比对（纯函数）
// 依据：R-AUD-01（每次发榜/计分可复算）
//   溯源：周报 2026-10-12~18 §4.2 教训 5「静默的空产出比报错更危险」
//   ⛔ 复算结果与快照不一致时，差异必须能被【看见】：每条差异带一个可定位的 path，
//      不能只写一条日志了事。
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

const EPSILON = 1e-9;

export function summarizeValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(v);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 数组元素优先用业务主键做 path（teams[t1].total 比 teams[0].total 可定位得多）
function arrayKey(item, index) {
  if (isPlainObject(item)) {
    const key = item.teamId ?? item.id ?? item.judgeId ?? item.key;
    if (key !== undefined && key !== null) return String(key);
  }
  return String(index);
}

/**
 * 给数组的每个元素算一个**唯一**的 path 键。
 *
 * ⛔ 父代理预审修正（Important，P4-11）：同一个数组里**可以出现重复的业务主键**
 *    （例如 `scoreStage` 的 `warnings` 里多条告警的 `teamId` 相同）。
 *    直接用主键当 path ⇒ 多条告警共用同一个 path ⇒
 *    差异被记到同一条上（「这一条变了」其实是「那一条变了」）⇒ 差异**无法定位**。
 *    ⇒ 键重复时**回退到下标**，保证 path 唯一。
 */
function arrayKeys(items) {
  const keys = items.map((it, i) => arrayKey(it, i));
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return keys.map((k, i) => (counts.get(k) > 1 ? String(i) : k));
}

export function diffValues(before, after, { path = '', depth = 0, maxDepth = 12 } = {}) {
  const out = [];
  walk(before, after, path, depth, maxDepth, out);
  return out;
}

function walk(before, after, path, depth, maxDepth, out) {
  if (depth > maxDepth) {
    out.push({
      path: path || '<root>',
      before: summarizeValue(before),
      after: summarizeValue(after),
      note: '超出最大比对深度，已截断',
    });
    return;
  }
  // 浮点用 epsilon 判等：避免 0.1+0.2 与 0.3 被报成差异
  if (typeof before === 'number' && typeof after === 'number') {
    if (Math.abs(before - after) <= EPSILON) return;
    out.push({ path, before, after });
    return;
  }
  if (Object.is(before, after)) return;

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      walk(before[k], after[k], path ? `${path}.${k}` : k, depth + 1, maxDepth, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    const beforeKeys = arrayKeys(before);
    const afterKeys = arrayKeys(after);
    for (let i = 0; i < len; i += 1) {
      const key = beforeKeys[i] ?? afterKeys[i] ?? String(i);
      walk(before[i], after[i], `${path}[${key}]`, depth + 1, maxDepth, out);
    }
    return;
  }

  out.push({ path, before: summarizeValue(before), after: summarizeValue(after) });
}

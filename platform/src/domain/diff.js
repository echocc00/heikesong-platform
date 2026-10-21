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
    for (let i = 0; i < len; i += 1) {
      const key = arrayKey(before[i] ?? after[i], i);
      walk(before[i], after[i], `${path}[${key}]`, depth + 1, maxDepth, out);
    }
    return;
  }

  out.push({ path, before: summarizeValue(before), after: summarizeValue(after) });
}

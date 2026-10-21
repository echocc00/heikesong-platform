// src/domain/util.js — 领域层通用纯函数（依据 INTERFACES.md §0「领域层是纯函数」）

/** 字符串比较：不用 localeCompare，保证不同机器/语言环境下结果一致（可复算要求） */
export function cmpStr(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** 安全取数：非有限数按 null（缺值）处理，不静默当 0 */
export function toNumber(v) {
  // ⚠️ null / undefined / '' 必须先判掉：`Number(null)` 是 **0**、`Number('')` 也是 **0** ——
  //    直接 Number() 会把「缺值」静默变成「0 分」，与本函数的承诺（不静默当 0）**直接矛盾**。
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 剔除对象里指定的一批键，返回**新**对象（不改原对象）。
 * ⚠️ 名字从 `pick` 改成 `omit`：原实现是「剔除」，但名字叫 pick（挑出）——
 *    名实相反的函数一定会在某次调用里被用错方向（Task 6 的可见性过滤就是靠它
 *    剔除 peer / enterprise / password_hash 等敏感字段，用错方向 = 泄露）。
 */
export function omit(obj, keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (keys.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

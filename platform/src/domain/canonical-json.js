// src/domain/canonical-json.js — 稳定序列化（键名排序）
//
// 依据：2026-10-23 审计 F25（幂等键不绑定操作）—— 重放时要比对「请求体是不是同一份」，
//   而 JSON.stringify 的键顺序取决于**构造顺序** ⇒ 等价内容、不同键序会被判成不同
//   ⇒ 必须用**键名排序**的稳定序列化。
//
// ⛔ **纯函数**：无 IO、无 Date.now()、无 Math.random()、**不 import 任何 Node 内置模块**
//    （领域层的硬约束）。
//
// ⚠️ **为什么抽成独立文件**：这段口径原先在 `src/services/anticheat.js` 里是**内部函数**
//    （用来判断两份 flag 明细是不是「同一个问题」）。幂等摘要要的是**同一口径**
//    ⇒ 复制一份就是「同一口径写两份 ⇒ 必然漂移」（本仓反复踩的坑）。
//    ⇒ 抽到这里，两边共用同一个实现。
//
// 语义与 `src/services/anticheat.js` 原实现**逐字一致**（迁移时未改行为）：
//   数组保序；对象的键**排序**后递归；其余走 JSON.stringify（undefined → 'null'）。

/**
 * 稳定序列化（键名排序）。
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

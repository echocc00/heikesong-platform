// src/domain/evidence.js — 证据三列规范化
// 依据：R-AUD-04「证据三列（URL/发行方/独立性），按发行方去重，不按 URL 计数」
//   溯源：evidence-chain Skill 闸 1。同一发行方的 10 条报道不是 10 个独立信源，是 1 个。
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

export const EVIDENCE_COLUMNS = ['url', 'publisher', 'independent'];

export function normalizeEvidence({ items = [], requiredColumns = EVIDENCE_COLUMNS }) {
  const kept = [];
  const dropped = [];
  const violations = [];
  const seen = new Map(); // publisher → 已保留的记录

  for (const raw of items) {
    const item = raw ?? {};
    const missing = requiredColumns.filter((c) => {
      const v = item[c];
      return v === undefined || v === null || String(v).trim() === '';
    });
    if (missing.length) {
      // ⛔ 缺列必须显式报出来，不能悄悄扔掉（静默的空产出比报错更危险）
      violations.push({ item, missing });
      continue;
    }
    const publisher = String(item.publisher).trim();
    const key = publisher.toLowerCase();
    if (seen.has(key)) {
      dropped.push({ publisher, url: String(item.url).trim(), keptUrl: seen.get(key).url });
      continue;
    }
    const record = {
      url: String(item.url).trim(),
      publisher,
      independent: item.independent === true || item.independent === 'true',
    };
    seen.set(key, record);
    kept.push(record);
  }

  return {
    columns: requiredColumns,
    items: kept,
    uniquePublishers: kept.length,   // 按发行方计数，不按 URL
    dropped,
    violations,
  };
}

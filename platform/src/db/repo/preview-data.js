// src/db/repo/preview-data.js — 预演数据集的**写入口**（E181，2026-10-27）
//
// ⚠️ **为什么这个文件存在**：仓内纪律「**所有 SQL 字符串必须收在 platform/src/db/repo/ 下；
//    handler / 脚本里禁止裸 SQL**」（设计文档 §7.2 + 评审编号 I-7，
//    见 test/sql-boundary.test.js 的守卫）。
//    ⇒ 预演数据要写库，就得从仓储层出去 ⇒ 由本文件承担。
//
// ⚠️ **它做的是「按表插行」，不是「业务写入」**：
//    预演数据的目的是**把每个功能用到的数据摆出来**，让功能可被评审；
//    它刻意**绕过业务服务的全部校验与副作用**（不建冲突声明、不算分、不写审计…）。
//    ⇒ ⛔ 因此它**只能被预演脚本调用**，不许被业务代码当通用写入口用
//      （已登记进 docs/tools/dead-service-scan.allow.json 的「种子/运维脚本路径」一类）。
//
// ⚠️ **列名必须与生产表逐字一致**：本文件按 `PRAGMA table_info` 读真实列名，
//    数据集里写错列名 ⇒ **立刻抛错**（插不进去）⇒ 「预演数据与生产表不同格式」当场暴露。
/**
 * 把一批行插进指定表（内部函数，不导出 —— 唯一的对外入口是 insertDataset）。
 */
function insertRows(db, table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.length) throw new Error(`预演数据：表 ${table} 不存在（迁移没跑？）`);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!cols.includes(key)) {
        throw new Error(
          `预演数据：${table} 有列「${key}」，但生产表没有这一列 ⇒ 数据集与生产表不同格式`,
        );
      }
    }
  }
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
  }
  return rows.length;
}

/**
 * 按「表名 → 行数组」的映射批量插入（**顺序由调用方决定**：外键依赖在前）。
 *
 * @param {object} db
 * @param {Record<string, object[]>} dataset
 * @param {string[]} order 插入顺序（表名数组）
 * @returns {Record<string, number>} 每张表插了多少行
 */
export function insertDataset(db, dataset, order) {
  const counts = {};
  for (const table of order) {
    counts[table] = insertRows(db, table, dataset[table] ?? []);
  }
  return counts;
}

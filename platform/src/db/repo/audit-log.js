// src/db/repo/audit-log.js — 审计日志仓储
// 依据：设计文档 §11.2 / §12（可复算与留痕）；表由 P0 的 001_init.sql 建好。
// ⛔ 全局约束「所有 SQL 收在 src/db/repo/」—— 本文件是 audit_log 的 SQL 唯一归宿，
//    P0 的 test/sql-boundary.test.js 会扫描 src/ 与 scripts/ 下**除 src/db/repo/ 外**的一切 .js。
import { randomUUID } from 'node:crypto';

export function insertAuditLogRow(db, {
  id = randomUUID(),
  actorId = null,
  action,
  entity = null,
  entityId = null,
  detailJson = null,
  createdAt,
}) {
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actorId, action, entity, entityId, detailJson, createdAt);
  return id;
}

export function queryAuditLogRows(db, { entity = null, entityId = null, limit = 100 } = {}) {
  if (entity) {
    return db
      .prepare('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(entity, entityId, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ── P4 追加：带过滤条件的分页查询 + 取最后一次状态迁移 ────────────────
// 依据：设计文档 §12（可复算）+ §11.2（迁移日志）；表由 P0 的 001_init.sql 建好。
// ⚠️ P2 已建 insertAuditLogRow / queryAuditLogRows（写入 + 按 entity 列表）。
//    本阶段只补两个**只读查询**：带过滤条件的分页查询 + 取最后一次状态迁移。
export function queryAuditLog(db, {
  action = null, entity = null, entityId = null, since = null, until = null,
  limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (until) { where.push('created_at <= ?'); params.push(until); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params).n;
  // ⛔ 父代理预审修正（Critical，P4-13）：同毫秒并列时用 `rowid` 破并列，**不用 `id`**。
  //    `audit_log.id` 是 randomUUID() ⇒ 同 `created_at` 的两条日志**次序随机**
  //    ⇒ 「取最后一条状态迁移」的结果随机 ⇒ 状态机随机报 409（Task 5 实跑：200 次里 135 次读到过期态）。
  //    `rowid` 是 SQLite 的隐式插入序号 ⇒ 确定性，且「后插入的在前」正是「最后一次」想要的语义。
  //    全局约束：确定性排序的兜底键一律用 SQLite 隐式 `rowid`（`localeCompare` / 随机 UUID 都不许）。
  const rows = db.prepare(
    `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

// 复核状态机的当前态：从最后一条迁移日志里取 to_state。
// 依据：设计文档 §11.2「每次状态迁移写 audit_log(...)」——状态机的真值来源就是迁移日志。
// ⚠️ 排序的破并列键同样是 `rowid`（不是 `id`）—— 见 queryAuditLog 的注释。
export function findLatestTransition(db, entity, entityId) {
  const rows = db.prepare(
    `SELECT detail_json, created_at FROM audit_log
      WHERE entity = ? AND entity_id = ? AND action = 'review_state.transition'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).all(entity, entityId);
  if (!rows.length) return null;
  let detail = {};
  try {
    detail = rows[0].detail_json ? JSON.parse(rows[0].detail_json) : {};
  } catch {
    detail = {};
  }
  return { ...detail, at: rows[0].created_at };
}

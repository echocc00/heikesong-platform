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
  const rows = db.prepare(
    `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

// 复核状态机的当前态：从最后一条迁移日志里取 to_state。
// 依据：设计文档 §11.2「每次状态迁移写 audit_log(...)」——状态机的真值来源就是迁移日志。
export function findLatestTransition(db, entity, entityId) {
  const rows = db.prepare(
    `SELECT detail_json, created_at FROM audit_log
      WHERE entity = ? AND entity_id = ? AND action = 'review_state.transition'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
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

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

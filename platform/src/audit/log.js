// src/audit/log.js — 审计日志（服务门面）
// 依据：设计文档 §11 / §12（可复算与留痕）。设计文档 §4.3 已预留 src/audit/ 目录。
// ⚠️ 本文件【不含 SQL】—— SQL 全在 src/db/repo/audit-log.js（全局约束：SQL 边界；
//    P0 的 test/sql-boundary.test.js 会把 src/ 下任何裸 SQL 判为违规）。
// ⛔ action 必须给：没有 action 的日志无法检索，缺了它这条记录等于没写。
import { insertAuditLogRow, queryAuditLogRows } from '../db/repo/audit-log.js';

export function writeAuditLog(db, { actorId = null, action, entity = null, entityId = null, detail = null, now }) {
  if (!action) throw new Error('写审计日志必须给 action（没有 action 的日志无法检索）');
  const id = insertAuditLogRow(db, {
    actorId,
    action,
    entity,
    entityId,
    detailJson: detail ? JSON.stringify(detail) : null,
    createdAt: now,
  });
  return id;
}

export function listAuditLog(db, { entity = null, entityId = null, limit = 100 } = {}) {
  return queryAuditLogRows(db, { entity, entityId, limit });
}

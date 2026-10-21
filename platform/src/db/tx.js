// src/db/tx.js — 事务助手
// 依据：设计文档 §11「数据库写入失败 → 事务回滚，无部分写入」
// 用 SAVEPOINT 而不是 BEGIN/COMMIT：SAVEPOINT 可嵌套，调用方自己开了事务时不会炸。
import { randomUUID } from 'node:crypto';

export function withTransaction(db, fn) {
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // 回滚本身失败：保留原始错误，不掩盖真正的失败原因
    }
    throw err;
  }
}

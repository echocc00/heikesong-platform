// src/db/tx.js — 事务助手
// 依据：设计文档 §11「数据库写入失败 → 事务回滚，无部分写入」
//
// ⚠️ **外层用 BEGIN IMMEDIATE，不是 deferred SAVEPOINT**（F8）：
//    deferred 事务是「先读快照、后升级为写」⇒ 期间别的连接一提交，
//    升级写锁就撞 `SQLITE_BUSY_SNAPSHOT`（errcode **517**），
//    而 **busy_timeout 不覆盖这个错误码** ⇒ 0ms 硬失败 ⇒ 用户只看到 500。
//    （本仓 `src/services/review.js` 与 `src/services/compute.js` 早就用 BEGIN IMMEDIATE
//      并写明了理由：「立即取写锁，避免「抢键」与「写数据」之间被另一个连接插进来」——
//      而 `withTransaction` 一直没跟上，**它才是 `withIdempotency` 与 `src/services/pools.js`
//      的事务入口**。）
//    ⇒ 规则：**连接上没有事务** ⇒ BEGIN IMMEDIATE（立即取写锁）；
//      **已经有事务** ⇒ SAVEPOINT（可嵌套，不与外层打架）。
//
// ⚠️ **回滚日志：有些写入不能被业务失败带走**（F19）
//    限频计数写在业务事务里 ⇒ 业务一抛错，`ROLLBACK TO` 把它**一起回滚**了
//    ⇒ 「只要在 body 里加一个 requestId，限频就完全失效」
//      （加 requestId 走幂等事务 ⇒ 计数在事务内 ⇒ 回滚 ⇒ 计数归零）
//    ⇒ 全站唯一有限频的端点（申诉）形同虚设。
//    ⇒ `durableWrite(db, fn)`：写入**立即执行**（并发可见、判定原子），
//      同时登记进**回滚日志**；事务回滚后**重放**一次 ⇒ 计数存活。
//      事务提交 ⇒ 日志作废（**不重复计数**）。
import { randomUUID } from 'node:crypto';

/**
 * 每个连接一份事务状态（深度 + 回滚日志）。
 * ⚠️ 用 WeakMap 挂连接，不往 db 对象上挂自定义属性（那是别人的对象）。
 */
const STATES = new WeakMap();

function stateOf(db) {
  let s = STATES.get(db);
  if (!s) { s = { depth: 0, journal: [] }; STATES.set(db, s); }
  return s;
}

/** 连接上当前是否真的在事务里（含 SAVEPOINT 与 BEGIN IMMEDIATE 两种）。 */
export function inTransaction(db) {
  return db.isTransaction === true;
}

/**
 * 登记一个「**事务回滚后必须仍然生效**」的写入。
 *
 * ⚠️ 为什么写入要**立即执行**而不是「回滚后再写」：
 *    立即执行 ⇒ 并发请求能**立刻**看到这条计数/这把锁（判定原子）；
 *    回滚后再写 ⇒ 在事务期间这把锁**对别人不可见** ⇒ 两个并发请求能同时拿到锁。
 *
 * @param {object} db
 * @param {Function} fn 幂等的写入动作（重放时必须得到同样的效果）
 */
export function durableWrite(db, fn) {
  fn();                                   // 立即执行（在当前事务里 ⇒ 并发可见）
  const s = stateOf(db);
  if (s.depth > 0) s.journal.push(fn);   // 在事务里 ⇒ 回滚后要重放
  // 不在事务里 ⇒ 无需重放（写完即提交）
}

/** 回滚后重放登记过的写入（失败不掩盖原始错误）。 */
function replayJournal(db, s, mark) {
  const entries = s.journal.slice(mark);
  s.journal.length = mark;
  for (const entry of entries) {
    try { entry(); } catch { /* 重放失败不掩盖原始错误 */ }
  }
}

/**
 * SQLite 的 **517（SQLITE_BUSY_SNAPSHOT）** = 快照冲突 ⇒ **可重试**，
 * ⛔ 不是 500 级的「服务内部错误」（用户重试一次就好了）。
 * 其它 SQLite 错误码（5 = BUSY、6 = LOCKED）同样可重试。
 */
export function isRetryableDbError(err) {
  const code = err?.errcode;
  if (code === 517 || code === 5 || code === 6) return true;
  return /SQLITE_BUSY|database is locked/i.test(String(err?.message ?? ''));
}

export function withTransaction(db, fn) {
  const s = stateOf(db);
  const outermost = !inTransaction(db);
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  const mark = s.journal.length;

  if (outermost) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${name}`);
  s.depth += 1;

  try {
    const result = fn();
    if (outermost) db.exec('COMMIT');
    else db.exec(`RELEASE ${name}`);
    s.depth -= 1;
    if (s.depth === 0) s.journal.length = mark;   // 提交 ⇒ 回滚日志作废（不重复计数）
    return result;
  } catch (err) {
    try {
      if (outermost) db.exec('ROLLBACK');
      else { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); }
    } catch {
      // 回滚本身失败：保留原始错误，不掩盖真正的失败原因
    }
    s.depth -= 1;
    if (s.depth === 0) replayJournal(db, s, mark);   // 回滚 ⇒ 把「必须存活」的写入重放一次
    throw err;
  }
}

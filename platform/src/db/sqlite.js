// src/db/sqlite.js — SQLite 连接封装
// 依据：设计文档 §4.2。node:sqlite 是同步 API，慢查询会阻塞 event loop，
//       因此所有 SQL 必须在仓储层预编译 + 参数化。
//
// ⚠️ Node 版本下限 = 22.16.0（package.json engines）。这是两个下限的**并集**：
//    - 22.13.0：node:sqlite 不再需要 --experimental-sqlite 标志。
//      v22.5.0–v22.12.x 上 import 本文件会直接抛错（而本项目四个 scripts 都不带该 flag）。
//    - 22.16.0：sqlite.backup() —— §14 备份方案依赖的一致性备份 API（P6 的备份/恢复脚本）。
//    依据：Node v22 官方文档 SQLite 页 History 表
//    （https://nodejs.org/docs/latest-v22.x/api/sqlite.html）原文：
//      v22.5.0   Added in: v22.5.0
//      v22.13.0  SQLite is no longer behind --experimental-sqlite but still experimental.
//    以及 `sqlite.backup(sourceDb, destination[, options])` 条目：Added in: v22.16.0。
//    详见设计文档 §4.2「运行时与依赖」。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SQLite 的「忙类」错误码（可重试）。
 * 依据：sqlite.org/rescode.html
 *   5   SQLITE_BUSY           别的连接在用这个库
 *   6   SQLITE_LOCKED         同一连接内的表被锁
 *   261 SQLITE_BUSY_RECOVERY  别的连接正在做热日志回滚
 *   517 SQLITE_BUSY_SNAPSHOT  WAL 快照冲突
 */
const BUSY_CODES = new Set([5, 6, 261, 517]);

/** 切 WAL 的退避步长（毫秒）。 */
const WAL_RETRY_STEP_MS = 25;

/** 切 WAL 的默认重试预算（毫秒）——与 busy_timeout 同口径（5 秒）。 */
const WAL_RETRY_BUDGET_MS = 5000;

/**
 * 同步退避。node:sqlite 是同步 API，这里不能用 setTimeout
 * （那会把事件循环占住不放，setTimeout 回调排在当前同步代码之后 ⇒ 永远等不到）。
 * Atomics.wait 在 SharedArrayBuffer 上阻塞当前线程，Node 各平台均可用。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 把数据库切到 WAL 模式（读不阻塞写、写不阻塞读，见 sqlite.org/wal.html）。
 *
 * ⚠️ 为什么不能直接 `db.exec('PRAGMA journal_mode = WAL')`：
 *   1. 切 journal_mode 需要**独占锁**；此时库里有别的连接在写就拿不到。
 *   2. **别的连接持有写事务（RESERVED 锁）时，SQLite 的 busy handler 不覆盖这一步**
 *      —— 实测（探针 `probe-wal-lock-2.mjs` 实验 B）：持锁时执行该 PRAGMA 在 **0ms** 内就抛
 *      SQLITE_BUSY(errcode=5)；把 busy_timeout 设成 5000 也一样**立刻**失败，不等。
 *      ⇒ 「先设 busy_timeout 再切 WAL」**不够**，必须自己实现退避重试。
 *      ⚠️ **限定条件**（P4 终审 Minor M-2 实测纠正，别再无条件地转述这句话）：
 *      并非对所有锁型都如此 —— 别的连接持 **EXCLUSIVE** 锁时 busy handler **仍会**等待
 *      （实测 busy_timeout=5000 时等 5485ms 才抛、=1000 时等 1129ms，随 busy_timeout 线性缩放）。
 *      现实故障场景（并发写事务）落在 RESERVED 那一侧 ⇒ 本修法覆盖真实故障；
 *      但「busy handler 一概不覆盖切 WAL」是**过度泛化**的说法。
 *   3. 危险窗口只有**数据库文件首次创建**的那一瞬间：WAL 模式持久化在文件头里，
 *      此后再次执行该 PRAGMA 是 no-op（不取锁，实测 0ms 成功）。
 *      所以「两条连接同时开同一个新库」必有一方撞上第 1 条 → "database is locked"。
 *      这正是 P5 并发建库实测到的失败。
 *
 * ⚠️ WAL 要求所有进程在同一台主机；数据库文件不能放 NFS（sqlite.org/faq.html）。
 *
 * @param {DatabaseSync} db
 * @param {{ budgetMs?: number }} [options] 重试预算（毫秒），默认 5000
 */
function ensureWalMode(db, { budgetMs = WAL_RETRY_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      // 已经是 WAL → 下面的 exec 是 no-op（不取锁），绝大多数连接走这条路径。
      if (db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') return;
      db.exec('PRAGMA journal_mode = WAL');
      const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      if (mode !== 'wal') {
        // SQLite 在文件系统不支持共享内存时会**静默**留在旧模式（sqlite.org/wal.html）。
        // 静默降级会让并发写退化成整库锁 —— 显式报错，不假装成功。
        throw new Error(
          `无法启用 WAL 模式（当前 ${mode}）：数据库文件所在文件系统可能不支持共享内存`
          + '（WAL 要求同主机本地文件系统，见 sqlite.org/wal.html）',
        );
      }
      return;
    } catch (err) {
      if (!BUSY_CODES.has(err.errcode) || Date.now() >= deadline) throw err;
      sleepSync(WAL_RETRY_STEP_MS);
    }
  }
}

export function openDatabase({
  dataDir = './data',
  filename = 'app.db',
  walRetryBudgetMs = WAL_RETRY_BUDGET_MS,
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, filename));

  // ⚠️ 顺序有讲究：busy_timeout 必须**最先**设 —— 它是后续所有取锁操作的等待上限。
  //    遇到锁等待 5 秒再报错，避免瞬时并发直接失败
  db.exec('PRAGMA busy_timeout = 5000');
  // 外键约束默认关闭，必须显式打开
  db.exec('PRAGMA foreign_keys = ON');
  // WAL：读不阻塞写、写不阻塞读（sqlite.org/wal.html）
  ensureWalMode(db, { budgetMs: walRetryBudgetMs });

  return {
    db,
    close() {
      db.close();
    },
  };
}

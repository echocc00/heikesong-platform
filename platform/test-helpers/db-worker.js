// platform/test-helpers/db-worker.js —— 连接层并发测试用的 worker（两种角色）
//
// 角色 'lock-holder'：占住数据库的写锁 holdMs 毫秒后释放 —— 用来逼出
//   「切 WAL 需要独占锁」这一失败路径。
//   刻意让库停在 **delete 模式**：切到 WAL 需要独占锁，这样别的连接切 WAL 时
//   会真的撞上（库里已是 WAL 时该 PRAGMA 是 no-op，根本不取锁，撞不上）。
//
// 角色 'opener'：等主线程放行后调用 openDatabase —— 用来复现
//   「多条连接同时首开同一个新库」的竞争。
//
// ⛔ 它是**测试辅助工具**，不是被测代码：
//    - 放在 test-helpers/ 而非 test/ 下（Node 会把名为 test 的目录下所有 JS 当测试文件跑）；
//    - 零依赖：只用 Node 标准库 + 本项目的 src（零依赖守卫会扫这个目录）。
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';

const { role, dataDir, filename = 'app.db', holdMs = 400 } = workerData;

if (role === 'lock-holder') {
  const db = new DatabaseSync(join(dataDir, filename));
  db.exec('PRAGMA journal_mode = delete');
  db.exec('BEGIN IMMEDIATE');
  parentPort.postMessage({ locked: true });
  setTimeout(() => {
    try { db.exec('ROLLBACK'); } catch { /* 连接可能已被关闭 */ }
    db.close();
    parentPort.postMessage({ released: true });
  }, holdMs);
} else if (role === 'opener') {
  parentPort.postMessage({ ready: true });
  parentPort.on('message', () => {
    try {
      const { db, close } = openDatabase({ dataDir, filename });
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
      db.exec('ROLLBACK');
      close();
      parentPort.postMessage({ ok: true });
    } catch (e) {
      parentPort.postMessage({ ok: false, errcode: e.errcode, message: e.message });
    }
  });
} else {
  throw new Error(`未知的 worker 角色：${role}`);
}

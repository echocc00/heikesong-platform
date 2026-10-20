// src/db/sqlite.js — SQLite 连接封装
// 依据：设计文档 §4.2。node:sqlite 是同步 API，慢查询会阻塞 event loop，
//       因此所有 SQL 必须在仓储层预编译 + 参数化。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase({ dataDir = './data', filename = 'app.db' } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, filename));

  // WAL：读不阻塞写、写不阻塞读（sqlite.org/wal.html）
  // ⚠️ WAL 要求所有进程在同一台主机；数据库文件不能放 NFS（sqlite.org/faq.html）
  db.exec('PRAGMA journal_mode = WAL');
  // 外键约束默认关闭，必须显式打开
  db.exec('PRAGMA foreign_keys = ON');
  // 遇到锁等待 5 秒再报错，避免瞬时并发直接失败
  db.exec('PRAGMA busy_timeout = 5000');

  return {
    db,
    close() {
      db.close();
    },
  };
}

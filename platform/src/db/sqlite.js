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

// scripts/migrate.js — 命令行迁移入口
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { assertServiceStopped } from '../src/runtime/service-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

// ⛔ 单写者闸（P1-4a，2026-10-25 评审轮）：服务还在跑时**拒绝**执行迁移。
//    依据：设计文档 §14.2 单写者约束 + README「SQLite 只允许单写进程」。
//    ⚠️ 迁移尤其危险：它改的是 **schema** —— 运行中的服务连接的还是旧 schema
//    ⇒ 迁移一落地，服务的下一条 SQL 就可能撞「no such column」。
//    ⚠️ 判定放在**开库之前**：库一打开就可能与对方抢写锁了。
//    （deploy/install.sh 的既有流程正好满足这条：init_database 在 start_service **之前**。）
try {
  assertServiceStopped({ dataDir, action: '数据库迁移' });
} catch (err) {
  console.error(`[migrate] ${err.message}`);
  process.exit(1);
}

const { db, close } = openDatabase({ dataDir });
try {
  const result = applyMigrations(db, join(here, '..', 'db', 'migrations'));
  console.log(`迁移完成，当前版本 ${result.version}`);
  if (result.applied.length) {
    console.log(`本次应用：\n  ${result.applied.join('\n  ')}`);
  } else {
    console.log('本次无新迁移');
  }
} finally {
  close();
}

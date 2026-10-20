// scripts/migrate.js — 命令行迁移入口
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

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

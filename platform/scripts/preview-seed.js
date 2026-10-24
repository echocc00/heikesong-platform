#!/usr/bin/env node
// scripts/preview-seed.js — 建**临时库**并灌入预演数据集（E181，2026-10-27）
//
// ⚠️ **这是什么**：一个**临时的库**，schema 由**生产同款迁移**建出来，
//    数据来自 `db/preview/preview-dataset.js`。
//    ⇒ 表结构与生产**逐字一致** ⇒ 真实赛事数据到位后**直接灌进同一套表**，
//      services/readiness.js 的代码**一行都不用改**。
//    ⇒ 评审时用它看「功能行为是否符合预期」，**不是**用它冒充真实数据。
//
// ⛔ **安全闸**：本脚本**只**写 `<platform>/data/preview/preview.db`，
//    **绝不**碰生产库（`platform/data/app.db`）——
//    ① 目录名写死成 `preview` 子目录；
//    ② 若目标目录里已经有 `app.db`（生产库同名）⇒ 拒绝执行；
//    ③ 每次执行前**重建**（先删旧的 preview.db）⇒ 预演数据永远是最新的那一份。
//
// 用法：
//   node scripts/preview-seed.js              # 用当前时间做锚点
//   node scripts/preview-seed.js --anchor 2026-10-20T00:00:00Z
//   node scripts/preview-seed.js --keep       # 不删旧库，直接灌（增量）
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { insertDataset } from '../src/db/repo/preview-data.js';
import { buildPreviewDataset, PREVIEW_SCENARIO } from '../db/preview/preview-dataset.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const previewDir = join(platformDir, 'data', 'preview');
const dbFile = join(previewDir, 'preview.db');

function parseArgs(argv) {
  const out = { anchor: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--anchor') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('[preview-seed] --anchor 后面必须是 ISO 时间');
        process.exit(2);
      }
      out.anchor = v;
      i += 1;
    } else if (argv[i] === '--keep') {
      out.keep = true;
    } else {
      console.error(`[preview-seed] 未知参数：${argv[i]}`);
      console.error('[preview-seed] 用法：node scripts/preview-seed.js [--anchor <ISO>] [--keep]');
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ⛔ 安全闸 ②：目标目录里若有名为 app.db 的东西 ⇒ 那是**生产库** ⇒ 拒绝。
mkdirSync(previewDir, { recursive: true });
if (existsSync(join(previewDir, 'app.db'))) {
  console.error(`[preview-seed] 拒绝执行：${join(previewDir, 'app.db')} 存在（生产库同名）`);
  process.exit(1);
}
// ⛔ 安全闸 ③：默认重建。
if (!args.keep && existsSync(dbFile)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) rmSync(dbFile + suffix);
  }
}

const anchor = args.anchor ? new Date(args.anchor) : new Date();
if (Number.isNaN(anchor.getTime())) {
  console.error(`[preview-seed] 锚点时间不可解析：${args.anchor}`);
  process.exit(2);
}

const { db, close } = openDatabase({ dataDir: previewDir, filename: 'preview.db' });
try {
  const migrated = applyMigrations(db, join(platformDir, 'db', 'migrations'));
  const data = buildPreviewDataset(anchor);

  // ⚠️ 插入顺序按**外键依赖**：父表先插。
  //    ⛔ 真正的 INSERT 语句在**仓储层**（src/db/repo/preview-data.js）——
  //    仓内纪律「SQL 字符串只许住在 src/db/repo/ 下」（test/sql-boundary.test.js 的守卫）。
  const ORDER = [
    'editions', 'cities', 'users', 'task_packages', 'teams',
    'stages', 'stage_judges', 'stage_team', 'stage_reviews', 'leaderboard_snapshots',
  ];
  let counts = {};
  db.exec('BEGIN');
  try {
    counts = insertDataset(db, data, ORDER);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`[preview-seed] 临时库：${dbFile}`);
  console.log(`[preview-seed] 迁移版本：${migrated.version}（生产同款迁移 ⇒ 表结构与生产一致）`);
  console.log(`[preview-seed] 锚点时刻：${data._meta.anchor}`);
  console.log('[preview-seed] 灌入行数：');
  for (const t of ORDER) console.log(`    ${t.padEnd(24)} ${counts[t]}`);
  console.log('[preview-seed] 场景矩阵（评审时对照这个看）：');
  for (const [k, v] of Object.entries(PREVIEW_SCENARIO)) console.log(`    ${k}: ${v}`);
  console.log('');
  console.log('[preview-seed] 下一步：node scripts/preview-report.js');
} finally {
  close();
}

// scripts/backup.js — 一致性备份（SQLite 官方 backup API）
//
// 依据：设计文档 §14.2【决策】备份用 sqlite.backup() API，不用 cp。
//   sqlite.org/backup.html 列出 cp 方式的三个缺点：
//     ① 备份期间其他写者须等锁释放
//     ② 不能用于内存库
//     ③ 复制过程中掉电可能导致备份损坏
//   backup() 是增量拷贝、源库只在真正读取的瞬间短暂加锁，结果是源库的 bit-wise identical snapshot。
// ⚠️ WAL 模式下只 cp .db 不 cp -wal 会丢数据：已提交但未 checkpoint 的事务还在 WAL 文件里。
//   backup() 拷贝的是【逻辑库】的页，所以这些事务会被包含进去。
// ✅ 可以在服务运行中执行（只加读锁，不阻塞写入）。
import { backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';

export const BACKUP_PREFIX = 'app-';
export const BACKUP_SUFFIX = '.db';

/** 备份文件名：app-<UTC 时间戳>.db（字典序 = 时间序，跨时区也单调） */
export function backupFileName(now = new Date()) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return `${BACKUP_PREFIX}${iso}${BACKUP_SUFFIX}`;
}

/** 列出备份（新 → 旧） */
export function listBackups(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .map((f) => {
      const st = statSync(join(backupDir, f));
      return { file: f, path: join(backupDir, f), bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : -1));
}

/**
 * 保留策略：最近 keepCount 份无条件保留；keepDays 天内的也保留；其余删除。
 * 返回被删除的文件名。
 */
export function pruneBackups(backupDir, { keepDays = 7, keepCount = 10, now = new Date() } = {}) {
  const all = listBackups(backupDir);
  const cutoff = new Date(now).getTime() - keepDays * 86400_000;
  const keep = new Set();

  for (const b of all.slice(0, keepCount)) keep.add(b.file);
  for (const b of all) {
    if (b.mtimeMs >= cutoff) keep.add(b.file);
  }

  const removed = [];
  for (const b of all) {
    if (keep.has(b.file)) continue;
    unlinkSync(b.path);
    removed.push(b.file);
  }
  return removed;
}

/**
 * 做一次一致性备份。
 * @returns {Promise<{file:string,path:string,bytes:number,pages:number,removed:string[]}>}
 */
export async function backupDatabase({
  dataDir = './data',
  filename = 'app.db',
  backupDir = null,
  now = new Date(),
  keepDays = 7,
  keepCount = 10,
} = {}) {
  const outDir = backupDir || join(dataDir, 'backups');
  mkdirSync(outDir, { recursive: true });

  const sourcePath = join(dataDir, filename);
  if (!existsSync(sourcePath)) throw new Error(`源库不存在：${sourcePath}`);

  const target = join(outDir, backupFileName(now));
  // ⚠️ 走 openDatabase 而不是裸 new DatabaseSync：
  //   ① 本 Task 的接口契约写明「Consumes: openDatabase({ dataDir, filename })」；
  //   ② openDatabase 带 busy_timeout=5000 —— 服务运行中备份时对 SQLITE_BUSY 有退避
  //      （WAL 下读者不阻塞写者，但取锁仍可能撞上 SQLITE_BUSY）。
  const { db, close } = openDatabase({ dataDir, filename });
  let pages = 0;
  try {
    // ⚠️ progress 回调的真实签名是**一个对象** { totalPages, remainingPages }
    //   （Node v22 的 node:sqlite 实测），不是 (db, copied)；
    //   而且它只在【多轮迭代】时触发 —— 库小到一次迭代就拷完时根本不触发。
    //   ⇒ 取 totalPages 当页数；一次都没触发时回落到源库 PRAGMA page_count。
    await backup(db, target, {
      rate: 100,
      progress: (info) => { pages = info.totalPages; },
    });
    if (!pages) {
      pages = db.prepare('PRAGMA page_count').get().page_count;
    }
  } finally {
    close();
  }

  const st = statSync(target);
  const removed = pruneBackups(outDir, { keepDays, keepCount, now });
  return { file: basename(target), path: target, bytes: st.size, pages, removed };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));

// ⚠️ 符号链接入口：Node 会把主入口 realpath 化，import.meta.url 是**真实路径**，
//    而 process.argv[1] 是**链接路径** → 字符串全等为假 → 脚本静默不执行、退出码 0。
//    与 src/server.js 的同一处判定保持一致（两边都 realpath 再比）。
//    ⚠️ realpathSync 吃的是**路径**，不是 file:// URL —— 必须先 fileURLToPath
//    （实测：直接 realpathSync(import.meta.url) 抛 ENOENT ⇒ isMain 恒假 ⇒
//      命令行跑起来什么都不干、退出码 0）。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args['data-dir'] || process.env.DATA_DIR || join(here, '..', 'data');
  const result = await backupDatabase({
    dataDir,
    backupDir: args.out ? String(args.out) : null,
    keepDays: Number(args['keep-days'] ?? 7),
    keepCount: Number(args['keep-count'] ?? 10),
  });
  console.log(`[backup] 完成：${result.file}（${result.bytes} 字节，${result.pages} 页）`);
  if (result.removed.length) console.log(`[backup] 按保留策略清理：${result.removed.join(', ')}`);
}

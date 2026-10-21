// platform/test/backup.test.js —— 备份脚本（sqlite.backup() API，不用 cp）
//
// 规则溯源：
//   - 「备份用 sqlite.backup() API，不用 cp」→ 设计文档 §14.2【决策】+ SQLite 官方 backup.html
//   - 「保留最近 keepCount 份 且 保留 keepDays 天内的」→ P6 计划 Global Constraints「保留策略」
//   - 「备份文件名 = app-<UTC 时间戳>.db」→ 同上
//
// ⚠️ 本文件的核心用例是「WAL 模式下备份包含已提交但未 checkpoint 的事务」：
//    它**同时**断言正反两面 —— backup() 拷到了那笔事务，而只 cp .db 的副本没拷到。
//    只断言正面会退化成「跑通即算」；只断言反面则证明不了 backup() 做对了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, copyFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/sqlite.js';
import { backupDatabase, listBackups, pruneBackups, backupFileName } from '../scripts/backup.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('备份产出的文件能独立打开且数据一致', async () => {
  const dataDir = tempDir('hks-bk-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('第一行');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('第二行');
  close();

  const result = await backupDatabase({
    dataDir,
    backupDir: join(dataDir, 'backups'),
    now: new Date('2026-10-20T12:00:00Z'),
  });
  assert.ok(existsSync(result.path), '备份文件必须落盘');
  assert.equal(result.file, 'app-20261020T120000Z.db');

  // 独立打开：完全脱离原库
  const backupDb = new DatabaseSync(result.path);
  const rows = backupDb.prepare('SELECT v FROM t ORDER BY id').all();
  backupDb.close();
  assert.equal(rows.length, 2, '备份必须含全部行');
  assert.deepEqual(rows.map((r) => r.v), ['第一行', '第二行']);

  rmSync(dataDir, { recursive: true, force: true });
});

test('WAL 模式下备份包含已提交但未 checkpoint 的事务（而只 cp .db 会丢）', async () => {
  const dataDir = tempDir('hks-bkwal-');
  const { db, close } = openDatabase({ dataDir });
  // 关掉自动 checkpoint：这笔事务确定留在 WAL 文件里
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('只有 WAL 里有');

  const walPath = join(dataDir, 'app.db-wal');
  assert.ok(existsSync(walPath) && statSync(walPath).size > 0, '前置条件：这笔事务必须还在 WAL 文件里');

  // 反例：只 cp .db（不 cp -wal）→ 数据丢失（这就是 sqlite.org/backup.html 说的风险）
  const cpOnly = join(dataDir, 'cp-only.db');
  copyFileSync(join(dataDir, 'app.db'), cpOnly);
  const cpDb = new DatabaseSync(cpOnly);
  const hasTable = cpDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").get();
  const cpCount = hasTable ? cpDb.prepare('SELECT COUNT(*) AS n FROM t').get().n : 0;
  cpDb.close();
  assert.equal(cpCount, 0, '只复制 .db 会丢掉 WAL 里已提交的事务（本断言证明该风险真实存在）');

  // 正例：backup() 拷的是逻辑库 → 包含 WAL 里的事务
  const result = await backupDatabase({
    dataDir,
    backupDir: join(dataDir, 'backups'),
    now: new Date('2026-10-20T12:00:00Z'),
  });
  const bkDb = new DatabaseSync(result.path);
  const bkCount = bkDb.prepare('SELECT COUNT(*) AS n FROM t').get().n;
  bkDb.close();
  assert.equal(bkCount, 1, 'backup() 必须包含已提交但未 checkpoint 的事务');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('保留策略：保留最近 keepCount 份，超份数且超天数的被清理', () => {
  const dir = tempDir('hks-prune-');
  const now = new Date('2026-10-20T12:00:00Z');
  const names = [];
  for (let i = 0; i < 12; i += 1) {
    const name = backupFileName(new Date(now.getTime() - i * 3600_000));
    const p = join(dir, name);
    writeFileSync(p, 'x');
    // 前 3 份在 1 小时内（keepDays=7 内），其余 13~21 天前（超期）
    const ageSec = i < 3 ? 3600 : (10 + i) * 86400;
    const t = (now.getTime() - ageSec * 1000) / 1000;
    utimesSync(p, t, t);
    names.push(name);
  }

  const removed = pruneBackups(dir, { keepDays: 7, keepCount: 10, now });
  assert.equal(removed.length, 2, '只有超出份数且超过保留天数的才清理');
  assert.deepEqual(removed.sort(), [names[10], names[11]].sort());

  const left = listBackups(dir).map((b) => b.file);
  assert.equal(left.length, 10, '保留最近 10 份');
  assert.ok(left.includes(names[0]), '最新一份必须保留');

  rmSync(dir, { recursive: true, force: true });
});

test('备份文件名按 UTC 时间戳命名，可按字典序排序（跨时区也单调）', () => {
  const a = backupFileName(new Date('2026-10-20T08:00:00Z'));
  const b = backupFileName(new Date('2026-10-20T09:00:00Z'));
  assert.equal(a, 'app-20261020T080000Z.db');
  assert.ok(a < b, '文件名必须可字典序排序');
  assert.equal(backupFileName(new Date('2026-10-20T09:00:00Z')), 'app-20261020T090000Z.db');
});

// ── 判别性补充用例 ────────────────────────────────────────────
// ⚠️ 上一条保留策略用例**区分不出两种算法**：
//    「只按 keepCount 保留」与「keepCount ∪ keepDays 保留」在它那份数据上给出**完全相同**的结果
//    （超期的 2 份同时也超份数；未超期的 3 份本来就在前 10 份里）。
//    ⇒ 下面这条用「两种算法结果不同」的数据集，把语义钉死。
test('保留策略是「份数 ∪ 天数」：没超天数的旧备份即使超出份数也必须保留', () => {
  const dir = tempDir('hks-prune2-');
  const now = new Date('2026-10-20T12:00:00Z');
  const names = [];
  // 3 份全部在 keepDays=7 之内，但 keepCount=1 ⇒ 只有「份数 ∪ 天数」才会全保留
  for (let i = 0; i < 3; i += 1) {
    const name = backupFileName(new Date(now.getTime() - i * 3600_000));
    const p = join(dir, name);
    writeFileSync(p, 'x');
    const t = (now.getTime() - (i + 1) * 3600_000) / 1000;
    utimesSync(p, t, t);
    names.push(name);
  }

  const removed = pruneBackups(dir, { keepDays: 7, keepCount: 1, now });
  assert.deepEqual(removed, [], '未超保留天数的备份一律保留（keepCount 只是下限，不是上限）');
  assert.equal(listBackups(dir).length, 3, '三份都必须还在');

  rmSync(dir, { recursive: true, force: true });
});

test('backupDatabase 自己套用保留策略，并报告页数与被清理的文件', async () => {
  const dataDir = tempDir('hks-bkprune-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  // ⚠️ 造一个**多轮迭代**的库（> 100 页 = backup() 的默认 rate），
  //    否则 progress 回调一次都不触发，测不出「页数报的是总量还是剩余量」。
  db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000)
          INSERT INTO t (v) SELECT hex(randomblob(500)) FROM c`);
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  assert.ok(pageCount > 100, `前置条件：库必须大于 100 页（实际 ${pageCount}）`);
  close();

  const backupDir = join(dataDir, 'backups');
  const now = new Date();
  // 第一份：20 天前（超 keepDays=7）→ 应被清掉
  const old = await backupDatabase({
    dataDir,
    backupDir,
    now: new Date(now.getTime() - 20 * 86400_000),
  });
  const t = (now.getTime() - 20 * 86400_000) / 1000;
  utimesSync(old.path, t, t);
  // 第二份：1 天前（未超天数，但会超出 keepCount=1）→ 必须保留
  const recent = await backupDatabase({
    dataDir,
    backupDir,
    now: new Date(now.getTime() - 86400_000),
  });
  const t2 = (now.getTime() - 86400_000) / 1000;
  utimesSync(recent.path, t2, t2);

  // 第三份触发清理
  const third = await backupDatabase({
    dataDir,
    backupDir,
    now,
    keepCount: 1,
    keepDays: 7,
  });
  assert.deepEqual(third.removed, [old.file], '超天数且超份数的旧备份必须被清掉');
  assert.equal(existsSync(old.path), false, '旧备份文件必须已删除');
  assert.equal(existsSync(recent.path), true, '未超天数的备份必须保留（哪怕超出份数）');
  assert.equal(third.pages, pageCount, '备份必须报告源库的总页数（不是剩余页数）');
  assert.ok(third.bytes > 0, '备份文件必须有内容');

  rmSync(dataDir, { recursive: true, force: true });
});

test('命令行入口可执行：node scripts/backup.js 真的备份并打出完成信息', () => {
  const dataDir = tempDir('hks-bk-cli-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  close();

  // ⚠️ 这条守住「脚本被当库 import 时不跑、但当命令跑时要真跑」这条边界：
  //    isMain 判定一旦写错（例如 realpathSync 吃了 file:// URL 而抛 ENOENT），
  //    命令行会**静默什么都不干、退出码 0** —— 没有这条用例就查不出来。
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(here, '..', 'scripts', 'backup.js')],
    { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } },
  );
  assert.equal(res.status, 0, `备份脚本必须以 0 退出，实际输出：${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /\[backup\] 完成：app-\d{8}T\d{6}Z\.db/, `备份脚本必须打出完成信息，实际：${res.stdout}`);
  const made = listBackups(join(dataDir, 'backups'));
  assert.equal(made.length, 1, '命令行必须真的产出备份文件');

  rmSync(dataDir, { recursive: true, force: true });
});

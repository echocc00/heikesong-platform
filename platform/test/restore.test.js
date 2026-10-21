// platform/test/restore.test.js —— 恢复脚本（先停服务 → 验完整性 → 换库 → 清 -wal/-shm）
//
// 规则溯源：
//   - 「恢复前必须先停服务：脚本用 pid 文件 + systemd 探测，服务在跑 → 拒绝执行」
//     → P6 计划 Global Constraints「恢复前置」+ 设计文档 §14.2
//   - 「恢复后必须删掉旧的 -wal / -shm（它们属于旧库，留着会污染新库）」→ 同上
//   - 「备份文件名 = app-<UTC 时间戳>.db」→ P6 计划 Global Constraints「保留策略」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations, currentVersion } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { backupDatabase } from '../scripts/backup.js';
import { checkServiceState, verifyBackupFile, restoreDatabase } from '../scripts/restore.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 轮询直到条件成立或超时；返回条件的结果（超时返回 null）。 */
async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function makeBackup(dataDir) {
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('备份里的数据');
  close();
  return backupDatabase({ dataDir, backupDir: join(dataDir, 'backups'), now: new Date('2026-10-20T12:00:00Z') });
}

test('服务在跑时拒绝恢复（不碰数据）', async () => {
  const dataDir = tempDir('hks-rs-busy-');
  const backup = await makeBackup(dataDir);

  // 当前测试进程还活着 → 模拟"服务在跑"
  writeFileSync(join(dataDir, 'app.pid'), String(process.pid), 'utf8');
  const state = checkServiceState({ dataDir });
  assert.equal(state.running, true);
  assert.ok(state.reason.includes('pid'), '必须说明为什么判定服务在跑');

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false, '服务在跑必须拒绝恢复');
  assert.ok(result.error.includes('服务'), `错误信息必须点明原因，实际：${result.error}`);

  rmSync(dataDir, { recursive: true, force: true });
});

test('恢复后数据与备份一致，且旧的 -wal / -shm 被清掉', async () => {
  const dataDir = tempDir('hks-rs-ok-');
  const backup = await makeBackup(dataDir);

  // 恢复前：当前库是另一份数据
  const { db, close } = openDatabase({ dataDir });
  db.exec('DELETE FROM t');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('恢复前的数据');
  close();

  // 制造一个残留的 -wal（模拟没干净关库的现场）
  writeFileSync(join(dataDir, 'app.db-wal'), 'stale-wal', 'utf8');
  writeFileSync(join(dataDir, 'app.db-shm'), 'stale-shm', 'utf8');

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, result.error ?? '');

  // ⚠️ 判别性断言必须**紧接恢复之后**做：
  //    规格里那条断言放在「新库打开并关闭之后」——可 SQLite 自己会在
  //    打开时重建 -wal、关闭时删掉 -wal/-shm ⇒ 就算恢复**没删**旧 sidecar，
  //    这条断言照样绿（实测：变异体 M18 存活）。放在恢复返回后立刻断言才判别。
  assert.equal(existsSync(join(dataDir, 'app.db-wal')), false, '恢复后必须立刻删掉旧 -wal（它属于旧库）');
  assert.equal(existsSync(join(dataDir, 'app.db-shm')), false, '恢复后必须立刻删掉旧 -shm（它属于旧库）');
  assert.equal(existsSync(join(dataDir, 'app.db.restore.tmp')), false, '恢复成功后不得留下临时文件');

  const after = new DatabaseSync(join(dataDir, 'app.db'));
  const rows = after.prepare('SELECT v FROM t').all();
  after.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].v, '备份里的数据', '恢复后必须是备份里的数据');
  assert.equal(existsSync(join(dataDir, 'app.db-wal')), false, '旧 -wal 必须被删除（它属于旧库）');
  assert.equal(existsSync(join(dataDir, 'app.db-shm')), false, '旧 -shm 必须被删除');

  rmSync(dataDir, { recursive: true, force: true });
});

test('备份文件损坏时拒绝恢复（integrity_check 不通过就不换库）', async () => {
  const dataDir = tempDir('hks-rs-bad-');
  const { db, close } = openDatabase({ dataDir });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  close();

  const bad = join(dataDir, 'bad.db');
  writeFileSync(bad, 'this is not a sqlite database at all', 'utf8');
  const check = verifyBackupFile(bad);
  assert.equal(check.ok, false);
  assert.ok(check.error, '必须给出错误原因');

  const result = restoreDatabase({ dataDir, backupFile: bad, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('完整性') || result.error.includes('损坏') || result.error.includes('integrity'));

  rmSync(dataDir, { recursive: true, force: true });
});

test('恢复前会留一份 .before-restore-<时间戳> 的旧库', async () => {
  const dataDir = tempDir('hks-rs-keep-');
  const backup = await makeBackup(dataDir);
  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, result.error ?? '');
  assert.ok(
    result.steps.some((s) => s.includes('.before-restore-')),
    `恢复步骤里必须记录旧库留存，实际：${result.steps.join(' | ')}`,
  );
  // ⚠️ 只看 steps 不够：步骤文本与磁盘上的文件是**两件事**。
  //    变异体 M19（把 rename 换成 unlink）保留了步骤文本 ⇒ 只断言 steps 会漏。
  const kept = readdirSync(dataDir).filter((f) => f.startsWith('app.db.before-restore-'));
  assert.equal(kept.length, 1, `旧库必须以 .before-restore-<时间戳> 留在磁盘上，实际：${readdirSync(dataDir).join(', ')}`);
  assert.ok(existsSync(join(dataDir, kept[0])), '留存的旧库必须真的有内容');
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 判别性补充：能打开 ≠ 完好 ────────────────────────────────
// ⚠️ 规格里那条「备份文件损坏时拒绝恢复」用的是**根本不是 sqlite 的文件**——
//    它在**打开**阶段就被拒 ⇒ 跳不跳过 integrity_check 都一样拒 ⇒ 不判别。
//    这条用「能打开但页已损坏」的库，逼出 integrity_check 真的在干活。
test('备份文件能打开但完整性检查不通过时也拒绝恢复（不能只看「打得开」）', async () => {
  const dataDir = tempDir('hks-rs-corrupt-');
  const p = join(dataDir, 'corrupt.db');
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 800)
          INSERT INTO t (v) SELECT hex(randomblob(300)) FROM c`);
  db.close();

  // 把第 3 页整页清零：页头完好 ⇒ 文件**仍能打开**，但 integrity_check 报出坏页
  const fd = openSync(p, 'r+');
  writeSync(fd, Buffer.alloc(4096), 0, 4096, 4096 * 2);
  closeSync(fd);

  const opens = new DatabaseSync(p, { readOnly: true });
  opens.close();

  const check = verifyBackupFile(p);
  assert.equal(check.ok, false, '完整性检查不通过必须判为不可用');
  assert.notEqual(check.integrity, 'ok', 'integrity 字段必须如实报告检查结果');
  assert.ok(check.error, '必须给出错误原因');

  const result = restoreDatabase({ dataDir, backupFile: p, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false, '有损坏的备份必须拒绝恢复');
  assert.ok(result.error.includes('完整性') || result.error.includes('损坏') || result.error.includes('integrity'));

  rmSync(dataDir, { recursive: true, force: true });
});

// ── 判别性 / 稳健性补充用例 ──────────────────────────────────
test('校验备份文件后不在旁边留下 -wal / -shm 残留', async () => {
  const dataDir = tempDir('hks-rs-side-');
  const backup = await makeBackup(dataDir);
  const check = verifyBackupFile(backup.path);
  assert.equal(check.ok, true, check.error ?? '');
  // ⚠️ 只读打开一个 WAL 标志的库，SQLite 会在文件旁建出 -wal / -shm 且关库后不删
  //    （sqlite.org/wal.html）。保留策略只认 *.db ⇒ 这些残留永不被清理 ⇒ 备份目录无限膨胀。
  assert.equal(existsSync(`${backup.path}-wal`), false, '校验不得在备份目录留下 -wal 残留');
  assert.equal(existsSync(`${backup.path}-shm`), false, '校验不得在备份目录留下 -shm 残留');
  rmSync(dataDir, { recursive: true, force: true });
});

test('pid 文件内容损坏时也拒绝恢复（拿不到「服务已停」的证据就保守拒绝）', async () => {
  const dataDir = tempDir('hks-rs-badpid-');
  const backup = await makeBackup(dataDir);
  writeFileSync(join(dataDir, 'app.pid'), 'not-a-pid', 'utf8');
  const state = checkServiceState({ dataDir });
  assert.equal(state.running, true, 'pid 文件存在但内容不可解析 → 无法确认服务已停 → 必须判为在跑');
  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, false, '拿不到停服证据时必须拒绝恢复');
  assert.ok(result.error.includes('服务'), `错误信息必须点明原因，实际：${result.error}`);
  rmSync(dataDir, { recursive: true, force: true });
});

test('pid 文件指向已退出的进程时视为「服务未在跑」（陈旧残留不阻塞恢复）', async () => {
  const dataDir = tempDir('hks-rs-stale-');
  const backup = await makeBackup(dataDir);
  // 起一个立刻退出的子进程，拿到一个**确定已死**的 pid
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(dead.pid, '拿不到已退出子进程的 pid');
  writeFileSync(join(dataDir, 'app.pid'), String(dead.pid), 'utf8');

  const state = checkServiceState({ dataDir });
  assert.equal(state.running, false, '进程已退出 → 不得判为在跑');
  assert.equal(state.stale, true, '必须标记为陈旧残留');
  assert.ok(state.reason.includes('pid'), '必须说明为什么判定服务没在跑');

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, `陈旧 pid 不该阻塞恢复：${result.error ?? ''}`);
  rmSync(dataDir, { recursive: true, force: true });
});

test('服务启动时写 pid 文件、收到 SIGTERM 后删除（restore 的停服探测靠它）', async () => {
  const dataDir = tempDir('hks-rs-pid-');
  const serverPath = join(here, '..', 'src', 'server.js');
  let out = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    // ⚠️ 必须等到**真正开始监听**再往下走：
    //    pid 文件是在 openDatabase 之后立刻写的（早于迁移与 listen），
    //    若此时就发 SIGTERM，server.close() 可能落在 listen 之前 → 子进程以
    //    ERR_SERVER_NOT_RUNNING 崩掉 → pid 文件不删 → 本用例变成随机失败。
    const ready = await waitFor(() => out.includes('启动于'), 20000);
    assert.ok(ready, `服务必须能启动（子进程输出：${out}）`);

    const pidPath = join(dataDir, 'app.pid');
    assert.ok(existsSync(pidPath), `服务启动后必须写 pid 文件（子进程输出：${out}）`);
    const content = readFileSync(pidPath, 'utf8');
    assert.equal(Number(content.trim()), child.pid, 'pid 文件必须写当前进程 pid');

    const state = checkServiceState({ dataDir });
    assert.equal(state.running, true, '服务在跑时必须判为在跑');

    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 20000);
    const gone = await waitFor(() => !existsSync(pidPath), 5000);
    assert.ok(gone, `退出后必须删掉 pid 文件（子进程输出：${out}）`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test('真实生产 schema 的备份能往返：恢复后数据与 schema 版本都不变', async () => {
  const dataDir = tempDir('hks-rs-real-');
  // 用真实的迁移脚本建库（形状 = 真实写入方写出来的库）
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const version = currentVersion(db);
  assert.ok(version > 0, '真实 schema 必须有版本号');
  const created = createUser(db, { name: '备份测试', phone: '13800000001', password: 'pw-for-backup-test' });
  close();

  const backup = await backupDatabase({
    dataDir,
    backupDir: join(dataDir, 'backups'),
    now: new Date('2026-10-20T12:00:00Z'),
  });
  const check = verifyBackupFile(backup.path);
  assert.equal(check.ok, true, check.error ?? '');
  assert.equal(check.schemaVersion, version, '备份必须带出真实 schema 版本（走 migrate.js 的 currentVersion）');

  // 改库 → 再恢复
  const again = openDatabase({ dataDir });
  again.db.exec('DELETE FROM users');
  again.close();

  const result = restoreDatabase({ dataDir, backupFile: backup.path, now: new Date('2026-10-20T13:00:00Z') });
  assert.equal(result.ok, true, result.error ?? '');

  const after = openDatabase({ dataDir });
  const user = after.db.prepare('SELECT name, phone FROM users WHERE id = ?').get(created.id);
  const afterVersion = currentVersion(after.db);
  after.close();
  assert.ok(user, '恢复后真实用户必须还在');
  assert.equal(user.phone, '13800000001');
  assert.equal(afterVersion, version, '恢复后 schema 版本必须不变');

  rmSync(dataDir, { recursive: true, force: true });
});

test('命令行入口可执行：node scripts/restore.js 真的恢复并打出成功信息', async () => {
  const dataDir = tempDir('hks-rs-cli-');
  const backup = await makeBackup(dataDir);

  // ⚠️ 守住 isMain 判定这条边界：判定写错时命令会**静默什么都不干、退出码 0**。
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(here, '..', 'scripts', 'restore.js')],
    { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } },
  );
  assert.equal(res.status, 0, `恢复脚本必须以 0 退出，实际输出：${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /\[restore\] 成功/, `恢复脚本必须打出成功信息，实际：${res.stdout}`);
  assert.ok(
    readdirSync(dataDir).some((f) => f.startsWith('app.db.before-restore-')),
    '命令行恢复也必须留存旧库',
  );

  rmSync(dataDir, { recursive: true, force: true });
});

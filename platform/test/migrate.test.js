import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations, readMigrationFiles } from '../src/db/migrate.js';

// 真实迁移目录（platform/db/migrations）—— 本文件在 platform/test/ 下，故取上一级。
// 真实 DDL 必须被真正 apply 过：否则 001_init.sql 可以带着语法/外键/类型错误
// 而 CI 全绿（迁移文件本身从不进任何测试夹具）。
const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-mig-'));
}

test('迁移按版本升序读取', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '002_second.sql'), 'CREATE TABLE b (x INTEGER);');
  writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
  const files = readMigrationFiles(dir);
  assert.deepEqual(files.map((f) => f.version), [1, 2]);
  rmSync(dir, { recursive: true, force: true });
});

test('迁移是幂等的：重复执行不重复应用', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  const first = applyMigrations(db, dir);
  assert.equal(first.applied.length, 1);

  const second = applyMigrations(db, dir);
  assert.equal(second.applied.length, 0, '第二次不应再应用');
  assert.equal(second.version, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('WAL 与 foreign_keys 已开启，busy_timeout 为 5000ms', () => {
  // ⚠️ 终审修正（Minor，M-6）：busy_timeout 此前**零断言** ——
  //    把 `PRAGMA busy_timeout = 5000` 删掉，全量照样全绿（实测 D2 SURVIVED）。
  //    它是 SQLite 的**写锁等待**上限：写并发时拿不到锁就等 5 秒再报 SQLITE_BUSY。
  //    去掉它 → busy_timeout 变 0 → 并发写直接抛 BUSY，报名/评审的并发提交会随机失败。
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000, 'busy_timeout 必须是 5000ms');
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复版本号：响亮报错，而不是静默跳过', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE b (x INTEGER);');

  // 错误信息必须同时含版本号与冲突的两个文件名
  assert.throws(
    () => readMigrationFiles(dir),
    /迁移版本号重复: 001 \(001_a\.sql, 001_b\.sql\)/,
  );

  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  assert.throws(() => applyMigrations(db, dir), /迁移版本号重复/);

  // 报错发生在应用任何 SQL 之前：连 schema_migrations 都不该被建出来
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [], '重复版本号时不应执行任何迁移 SQL');

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('已应用的迁移文件被改名：响亮报错，而不是静默跳过', () => {
  const dir = tempDir();
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  const first = applyMigrations(db, dir);
  assert.deepEqual(first.applied, ['001_a.sql']);

  // 模拟迁移文件被改名/挪位：版本号不变，文件名变了
  rmSync(join(dir, '001_a.sql'));
  writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE a (x INTEGER);');

  assert.throws(
    () => applyMigrations(db, dir),
    /迁移 001 已以 001_a\.sql 应用，当前文件名为 001_b\.sql；迁移文件名不可变更/,
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('退化迁移文件名会被拒绝（不静默开版本缺口）', () => {
  // "_init.sql" —— Number('') === 0，会被当成版本 0
  const dirA = tempDir();
  writeFileSync(join(dirA, '_init.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirA), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirA, { recursive: true, force: true });

  // "1e3_x.sql" —— Number('1e3') === 1000，会静默跳到版本 1000，
  // 在「全局唯一序位」（001=P0 … 006=P5）上开出一个静默缺口
  const dirB = tempDir();
  writeFileSync(join(dirB, '1e3_x.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirB), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirB, { recursive: true, force: true });

  // "001.sql" —— 缺下划线
  const dirC = tempDir();
  writeFileSync(join(dirC, '001.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirC), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirC, { recursive: true, force: true });
});

test('macOS 的 AppleDouble 伴生文件（._xxx）被忽略 —— 它不是迁移', () => {
  // 真机实测（2026-10-21，8.133.200.235 / Debian 12 / ext4）：
  //   按 P6 计划 Step 4 的「跨平台复现」配方把 platform/ 从 macOS 拷到 Linux 时，
  //   `tar` 会给每个文件配一个 `._xxx` 资源叉载体 ⇒ 迁移直接失败。
  //   ⚠️ 这条**不是**放宽「退化迁移文件名会被拒绝」那条守卫：
  //   `init.sql` / `1e3_x.sql` / `01_.sql` 仍然照旧抛错（见上一条用例）。
  const dir = tempDir();
  writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE a (x INTEGER);');
  // 伴生文件的内容是 AppleDouble 二进制，不是 SQL —— 真读进去必然炸
  writeFileSync(join(dir, '._001_init.sql'), Buffer.from([0x00, 0x05, 0x16, 0x07, 0xff, 0xfe]));
  writeFileSync(join(dir, '._999_ghost.sql'), Buffer.from([0x00, 0x05, 0x16, 0x07]));

  const files = readMigrationFiles(dir);
  assert.equal(files.length, 1, `伴生文件必须被忽略，实际读到 ${files.length} 个：${files.map((f) => f.name).join('、')}`);
  assert.equal(files[0].name, '001_init.sql');
  assert.equal(files[0].version, 1);

  // ⛔ 反向：伴生文件**不得**让真正的迁移被吞掉（也不能凭空造出版本号）
  assert.ok(!files.some((f) => f.name.startsWith('._')), '伴生文件不得出现在迁移列表里');
  assert.ok(!files.some((f) => f.version === 999), '伴生文件的版本号不得被当成真实迁移');

  rmSync(dir, { recursive: true, force: true });
});

test('同版本号冲突时错误信息里的文件名顺序是确定的（跨平台稳定）', () => {
  // readdirSync 的返回顺序在 POSIX 里未定义：APFS 按名序、ext4/xfs 按 hash 序。
  // 错误信息里的两个文件名由实现**显式**按字节序排好 —— 跨平台保证由构造成立，
  // 不依赖 readdir 恰好有序（这条保证在 macOS 上无法用变异检出，靠的是构造本身）。
  for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
    const dir = tempDir();
    writeFileSync(join(dir, `001_${first}.sql`), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, `001_${second}.sql`), 'CREATE TABLE b (x INTEGER);');
    assert.throws(
      () => readMigrationFiles(dir),
      /迁移版本号重复: 001 \(001_a\.sql, 001_b\.sql\)/,
      '同版本号冲突的错误信息必须始终按文件名排序',
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本号必须从 001 起，且描述符不能为空', () => {
  // 0 不是合法序位（001=P0 … 006=P5）
  const dirA = tempDir();
  writeFileSync(join(dirA, '0_x.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirA), /迁移版本号必须从 001 起/);
  rmSync(dirA, { recursive: true, force: true });

  // "01_.sql" —— 描述符为空
  const dirB = tempDir();
  writeFileSync(join(dirB, '01_.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirB), /迁移文件名必须形如/);
  rmSync(dirB, { recursive: true, force: true });
});

// ⚠️ 下面两条断言的是「当前迁移集」的快照：P1 加入 002_registration.sql 之后，
//    「恰好 9 张表 / schema_migrations 恰好 1 行 / version 仍为 1」需要放宽为
//    「包含 001_init.sql 的那几项」。到 P1 时按此提示修改。
//
// ✅ P1 已按此提示放宽（不再对「张数 / 行数 / 版本号」取快照）：
//    取快照的断言每加一个迁移就必红一次，而它真正要抓的缺陷
//    （漏建表 / 迁移没被应用 / 迁移历史对不上账）由下面这三条照样抓住：
//      ① 每个迁移文件都被应用（applied 逐字等于目录里的文件清单）；
//      ② 期望的表逐个点名，漏建任一张表即红；
//      ③ schema_migrations 的版本号与文件名逐行对账。
//    期望值**从迁移目录本身推导**，因此 P2 加 003 时本用例不需要再改。
test('真实迁移目录：建出全部表并记录版本', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  // 期望的迁移文件名与版本号：从真实迁移目录推导（readMigrationFiles 已按版本升序排）
  const expectedFiles = readMigrationFiles(REAL_MIGRATIONS).map((f) => f.name);
  const expectedVersions = readMigrationFiles(REAL_MIGRATIONS).map((f) => f.version);

  const first = applyMigrations(db, REAL_MIGRATIONS);
  assert.deepEqual(first.applied, expectedFiles, '迁移目录里的每个文件都应被应用');
  assert.equal(first.version, Math.max(...expectedVersions), '版本号应为已应用迁移的最大版本');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of [
    'users',
    'sessions',
    'capabilities',
    'roles',
    'role_capabilities',
    'assignments',
    'user_roles',
    'audit_log',
    'schema_migrations',
    // P1（002_registration.sql）的 7 张表
    'editions',
    'cities',
    'task_packages',
    'registrations',
    'registration_events',
    'teams',
    'team_members',
  ]) {
    assert.ok(tables.includes(t), `真实迁移应建出表 ${t}`);
  }

  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  assert.equal(rows.length, expectedFiles.length, 'schema_migrations 行数应等于迁移文件数');
  assert.deepEqual(
    rows.map((r) => r.version),
    expectedVersions,
    'schema_migrations 的版本号应与迁移文件一致',
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    expectedFiles,
    'schema_migrations 的文件名应与迁移文件一致',
  );

  // 幂等：再跑一次不应再应用
  const second = applyMigrations(db, REAL_MIGRATIONS);
  assert.deepEqual(second.applied, [], '真实迁移重复执行不应再应用');
  assert.equal(second.version, first.version, '重复执行后版本号不应变化');

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('真实 schema 下外键约束确实生效', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  applyMigrations(db, REAL_MIGRATIONS);

  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('u1', '张三', '13800000000', 'hash', now);

  // 指向存在的用户 → 外键放行
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run('token-hash-1', 'u1', now, now);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    1,
    '指向真实用户的 session 应插入成功',
  );

  // 指向不存在的用户 → 外键拦下
  assert.throws(
    () => {
      db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run('token-hash-2', 'no-such-user', now, now);
    },
    /FOREIGN KEY constraint failed/,
    '指向不存在用户的 session 应被外键拦下',
  );

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

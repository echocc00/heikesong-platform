// platform/test/seed.test.js —— 种子脚本的安全行为
//
// 规则溯源：
//   - 「不兜底默认口令，校验不过就拒绝启动」→ 设计文档 §2「校验不过就拒绝启动」
//     与 Task 7 预审修正 I7-2（种子脚本用硬编码默认口令创建超管 → 公网机器上
//     等于把组委会超管口令写在代码里）。
//   - 凭据类信息不入库 → 全局约束「证据链 / 凭据」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/db/sqlite.js';
import { verifyPassword } from '../src/auth/password.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const seedPath = join(platformDir, 'scripts', 'seed.js');

function runSeed(env) {
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', seedPath],
    { cwd: platformDir, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 },
  );
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

test('没有 ADMIN_PASSWORD 时种子脚本拒绝运行：不建库、不建账号、不回显任何口令', () => {
  // ⚠️ 评审修正（Important）：原来**根本没有 seed 的测试文件** ——
  //    变异「恢复 `|| 'change-me-now'` 默认口令兜底」时全量 79/79 仍绿。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  const res = runSeed({ DATA_DIR: dataDir, ADMIN_PASSWORD: '' });
  assert.notEqual(res.status, 0, '必须以非 0 退出码退出');
  assert.match(res.out, /ADMIN_PASSWORD/, '报错必须点名缺少的环境变量');
  assert.equal(existsSync(join(dataDir, 'app.db')), false, '连数据库文件都不该创建');
  assert.equal(/change-me-now/.test(res.out), false, '输出里不能出现任何默认口令');
  rmSync(dataDir, { recursive: true, force: true });
});

test('给了 ADMIN_PASSWORD 时种子能建成超管，且口令哈希只能由这个口令验开', () => {
  // 这条同时钉住两件事：① 种子确实建成账号；② 账号口令**就是**环境变量里给的那个，
  //    不是代码里写死的另一个（默认口令兜底的回归会在这里露出来）。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-ok-'));
  const password = 'Str0ng-Pass!2026';
  const res = runSeed({ DATA_DIR: dataDir, ADMIN_PASSWORD: password });
  assert.equal(res.status, 0, `种子应成功，输出：${res.out.slice(0, 200)}`);
  assert.equal(existsSync(join(dataDir, 'app.db')), true, '数据库应被创建');
  assert.equal(res.out.includes(password), false, '输出里不能回显口令本身');

  const { db, close } = openDatabase({ dataDir });
  try {
    const row = db.prepare('SELECT password_hash, is_superadmin FROM users LIMIT 1').get();
    assert.ok(row, '应建出超管账号');
    assert.equal(row.is_superadmin, 1, '建出来的应是超管');
    assert.equal(verifyPassword(password, row.password_hash), true, '口令必须来自 ADMIN_PASSWORD');
    assert.equal(verifyPassword('change-me-now', row.password_hash), false, '不能是写死的默认口令');
  } finally {
    close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

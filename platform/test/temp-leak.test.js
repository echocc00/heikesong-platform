import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateTempDir, tempRoot } from '../test-helpers/tmp.js';
import { scanTempLeakUsage, main } from '../scripts/temp-leak-scan.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const HELPER_URL = pathToFileURL(join(here, '..', 'test-helpers', 'tmp.js')).href;

/** 在子进程里造一个临时目录，打印它的路径。useHelper=false ⇒ 不做隔离（对照组）。 */
function spawnTempDirProbe(useHelper) {
  const head = useHelper
    ? `import { isolateTempDir } from ${JSON.stringify(HELPER_URL)};\nisolateTempDir();\n`
    : '';
  const code = `${head}
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.stdout.write(mkdtempSync(join(tmpdir(), 'hks-probe-')));
`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  return { dir: (r.stdout || '').trim(), status: r.status, stderr: r.stderr || '' };
}

test('隔离生效：isolateTempDir() 之后 tmpdir() 指向本进程专属根目录', () => {
  const root = tempRoot();
  assert.ok(root, 'isolateTempDir() 之后 tempRoot() 必须有值');
  assert.equal(tmpdir(), root, 'os.tmpdir() 必须与专属根目录一致');
  assert.ok(basename(root).startsWith('hks-proc-'), `专属根目录名应以 hks-proc- 开头，实际 ${root}`);
  assert.equal(isolateTempDir(), root, '重复调用必须幂等（不得套娃建目录）');
});

test('退出即回收：子进程用 helper 建的临时目录，在子进程退出后已经没了', () => {
  const { dir, status, stderr } = spawnTempDirProbe(true);
  assert.equal(status, 0, `子进程应正常退出，stderr=${stderr}`);
  assert.ok(dir, '子进程应打印出临时目录路径');
  assert.equal(existsSync(dir), false, '进程退出后临时目录必须被整体回收');
});

test('判别性对照：同样的代码**不隔离**就会留下目录（证明上一条不是假绿）', () => {
  const { dir, status, stderr } = spawnTempDirProbe(false);
  assert.equal(status, 0, `子进程应正常退出，stderr=${stderr}`);
  assert.ok(dir, '子进程应打印出临时目录路径');
  assert.equal(existsSync(dir), true, '不隔离时目录**必须还在** —— 否则上面那条用例判别不了');
  rmSync(dir, { recursive: true, force: true });
});

test('闸 R1：用到了 tmpdir() 却没有 import helper ⇒ 判违规', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  writeFileSync(join(root, 'bad-r1.test.js'), [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "export const d = mkdtempSync(join(tmpdir(), 'x-'));",
    '',
  ].join('\n'), 'utf8');
  const violations = scanTempLeakUsage(root);
  assert.equal(violations.length, 1, `应恰好报 1 项，实际 ${JSON.stringify(violations)}`);
  assert.equal(violations[0].rule, 'R1');
  assert.match(violations[0].message, /没有 import test-helpers\/tmp\.js/);
});

test('闸 R1：import 了 helper 却没调用 ⇒ 判违规', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  writeFileSync(join(root, 'bad-nocall.test.js'), [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { isolateTempDir } from '../test-helpers/tmp.js';",
    "export const d = mkdtempSync(join(tmpdir(), 'x-'));",
    '',
  ].join('\n'), 'utf8');
  const violations = scanTempLeakUsage(root);
  assert.equal(violations.length, 1, `应恰好报 1 项，实际 ${JSON.stringify(violations)}`);
  assert.equal(violations[0].rule, 'R1');
  assert.match(violations[0].message, /没有调用/);
});

test('闸 R2：isolateTempDir() 晚于第一处 tmpdir() ⇒ 判违规', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  writeFileSync(join(root, 'bad-r2.test.js'), [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { isolateTempDir } from '../test-helpers/tmp.js';",
    "export const d = mkdtempSync(join(tmpdir(), 'x-'));",
    'isolateTempDir();',
    '',
  ].join('\n'), 'utf8');
  const violations = scanTempLeakUsage(root);
  assert.equal(violations.length, 1, `应恰好报 1 项，实际 ${JSON.stringify(violations)}`);
  assert.equal(violations[0].rule, 'R2');
  assert.match(violations[0].message, /太晚了/);
});

test('闸：合规写法不报违规', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  writeFileSync(join(root, 'good.test.js'), [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { isolateTempDir } from '../test-helpers/tmp.js';",
    'isolateTempDir();',
    "export const d = mkdtempSync(join(tmpdir(), 'x-'));",
    '',
  ].join('\n'), 'utf8');
  assert.deepEqual(scanTempLeakUsage(root), [], '合规写法不该被报违规');
});

test('闸：不用临时目录的文件不归它管', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  writeFileSync(join(root, 'plain.test.js'), "export const x = 1;\n", 'utf8');
  assert.deepEqual(scanTempLeakUsage(root), []);
});

test('闸的 CLI 入口：违规目录返回 1，合规目录返回 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  writeFileSync(join(root, 'bad.test.js'), [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "export const d = mkdtempSync(join(tmpdir(), 'x-'));",
    '',
  ].join('\n'), 'utf8');
  assert.equal(main([root]), 1, '有违规必须返回 1（不许假绿）');
  rmSync(join(root, 'bad.test.js'), { force: true });
  assert.equal(main([root]), 0, '清掉违规后必须返回 0');
});

test('闸的 CLI 入口：未知参数返回 2（不许静默吞掉）', () => {
  assert.equal(main(['--nope']), 2);
});

test('闸对整个测试目录生效：本仓库自己的测试文件全部合规', () => {
  const violations = scanTempLeakUsage(here);
  assert.deepEqual(violations, [], `测试目录里不该有泄漏隐患：${JSON.stringify(violations, null, 2)}`);
});

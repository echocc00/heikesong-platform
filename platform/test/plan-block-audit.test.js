import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractPath } from '../../docs/tools/plan-block-audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const repoDir = join(platformDir, '..');
const script = join(repoDir, 'docs', 'tools', 'plan-block-audit.mjs');

// ─────────────────────────────────────────────────────────────────────
// 回归用例：审计工具的「扩展名截断」bug
//
// 背景：`(?:js|html|css|sql|json)` 里 `js` 排在 `json` 前面，且路径部分是贪婪的
//      ⇒ `rules/tiebreak.json` 被匹配成 `rules/tiebreak.js`
//      ⇒ 该文件在实现里明明存在，却被判成 **D(无实现)**。
//      真实后果：18 个 rules/*.json 全部假阳性地被判 D，把真正的
//      C-RW（points.json / tiebreak.json / milestones.default.json）淹没在噪声里，
//      而工具「有输出」⇒ 没人发现判据本身是错的。
//
// 纪律：工具的 bug 必须有**机器可复算**的回归用例，不能靠人记。
// ─────────────────────────────────────────────────────────────────────

test('extractPath 对 .json 整体匹配，不截断成 .js', () => {
  assert.equal(extractPath('rules/tiebreak.json'), 'rules/tiebreak.json');
  assert.equal(extractPath('rules/points.json'), 'rules/points.json');
  assert.equal(extractPath('web/seed/demo-data.json'), 'web/seed/demo-data.json');
  assert.equal(extractPath('package.json'), 'package.json');
});

test('extractPath 对其它扩展名也整体匹配', () => {
  assert.equal(extractPath('src/db/repo/users.js'), 'src/db/repo/users.js');
  assert.equal(extractPath('deploy/install.sh'), 'deploy/install.sh');
  assert.equal(extractPath('deploy/nginx-demo-static.conf'), 'deploy/nginx-demo-static.conf');
  assert.equal(extractPath('db/migrations/001_init.sql'), 'db/migrations/001_init.sql');
  assert.equal(extractPath('web/index.html'), 'web/index.html');
});

test('extractPath 对无扩展名 / 未知扩展名返回 null', () => {
  assert.equal(extractPath('README'), null);
  assert.equal(extractPath('没有扩展名'), null);
  assert.equal(extractPath('foo.xyz'), null);
});

test('审计工具自检通过（内置防假绿闸）', () => {
  const res = spawnSync(process.execPath, [script, 'platform', '--selftest'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(res.status, 0, `自检应通过，实际退出码 ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /自检通过/);
});

test('审计工具在本仓跑出的判定：无 D（假阳性已清零）、无 C-RW', () => {
  const res = spawnSync(process.execPath, [script, 'platform'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(res.status, 0, `审计应正常退出，实际 ${res.status}\n${res.stderr}`);
  const summary = res.stdout.match(/A\(整文件一致\) (\d+)[\s\S]*?D\(无实现\) (\d+)/);
  assert.ok(summary, `应能从输出里读出汇总行，实际输出：\n${res.stdout}`);
  const dCount = Number(summary[2]);
  assert.equal(dCount, 0, `D 类应为 0（曾因扩展名截断有 18 条假阳性）\n${res.stdout}`);
  const crw = res.stdout.match(/C-RW\(真重写·需同步\) (\d+)/);
  assert.equal(Number(crw[1]), 0, `C-RW 应为 0（真漂移必须同步回计划）\n${res.stdout}`);
});

test('审计工具的 D 类必须打印明细（只计数不列清单 ⇒ 假阳性会静默潜伏）', () => {
  const res = spawnSync(process.execPath, [script, 'platform'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  // D 为 0 时不该有 D 清单段；有 D 时必须有明细行。
  const hasSection = res.stdout.includes('--- D 清单');
  const dCount = Number(res.stdout.match(/D\(无实现\) (\d+)/)[1]);
  if (dCount === 0) {
    assert.equal(hasSection, false, 'D 为 0 时不应打印空的 D 清单段');
  } else {
    assert.equal(hasSection, true, 'D > 0 时必须打印 D 清单明细');
  }
});

test('审计工具不得把散文里的路径提及当成文件声明（001_init.sql 假归因）', () => {
  // 计划 P0 里有一行散文：`user_roles` 表**已在 Task 2 的 `001_init.sql` 里建好**
  // ⇒ 它不是「文件声明行」，不许被归因成规格块（否则 001_init.sql 被误判 D）。
  const plan = readFileSync(
    join(repoDir, 'docs', 'superpowers', 'plans', '2026-10-20-platform-P0-foundation.md'),
    'utf8',
  );
  assert.ok(
    plan.includes('`user_roles` 表**已在 Task 2 的 `001_init.sql` 里建好**'),
    '本仓的散文样本行应仍在（若计划改写，此用例需同步更新）',
  );
  const res = spawnSync(process.execPath, [script, 'platform'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.ok(
    !/D 清单[\s\S]*001_init\.sql/.test(res.stdout),
    `001_init.sql 不该出现在 D 清单里（散文提及被误归因）\n${res.stdout}`,
  );
});

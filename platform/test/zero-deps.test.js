// platform/test/zero-deps.test.js —— 「零依赖」守卫
//
// 规则溯源（本文件每条断言对应的来源文档与章节）：
//   - 「npm 依赖 0 个 / 不依赖联网 npm install」→ 设计文档 §4.2「运行时与依赖」
//     （决策依据 R-OPS-01/02）；同表规定测试用 Node 内置 `node:test`，同为零依赖。
//   - 「全新机器 git clone 后直接 node src/server.js 跑起来」→ 设计文档 §1.3
//     成功标准 S-4「零依赖可移植」。
//   - `platform/src/` 目录布局（http/ auth/ domain/ services/ db/ audit/）
//     → 设计文档 §4.3「目录结构」。
//   - 任务拆分与验收口径 → docs/superpowers/plans/2026-10-20-platform-P0-foundation.md
//     Task 1「零依赖骨架与『零依赖』守卫」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json 没有任何 dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '禁止新增 dependencies');
  assert.equal(pkg.devDependencies, undefined, '禁止新增 devDependencies');
});

test('仓库里没有 node_modules（证明未联网安装过）', () => {
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('platform/ 下不存在 package-lock.json 或 node_modules', () => {
  assert.equal(existsSync(join(root, 'package-lock.json')), false);
});

test('每个 src 子目录都有 .js 文件且无空文件', () => {
  const srcDir = join(root, 'src');
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readdirSync(join(srcDir, entry.name)).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, `src/${entry.name} 没有 .js 文件`);
  }
});

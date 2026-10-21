import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseManifest, scanText, scanRoots } from '../scripts/audit-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = join(here, '..');
const SCRIPT = join(PLATFORM_DIR, 'scripts', 'audit-scan.js');
const MANIFEST = join(PLATFORM_DIR, 'scripts', 'forbidden.txt');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-scan-'));
}

/**
 * 造一个「能跑 CLI」的临时工程：<root>/platform/scripts/audit-scan.js（脚本副本）+
 * <root>/platform/scripts/forbidden.txt（清单）+ <root>/docs/（被扫的文件）。
 * CLI 里的 REPO_ROOT = <root>，所以相对路径可预期（docs/bad.md）。
 */
function cliSandbox({ manifest = '', files = {}, manifestMissing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hks-scan-cli-'));
  const scriptsDir = join(root, 'platform', 'scripts');
  const docsDir = join(root, 'docs');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  copyFileSync(SCRIPT, join(scriptsDir, 'audit-scan.js'));
  if (!manifestMissing) writeFileSync(join(scriptsDir, 'forbidden.txt'), manifest);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(docsDir, name), content);
  }
  return { root, scriptsDir, docsDir };
}

function runCli(sandbox, args = []) {
  return spawnSync(process.execPath, [join(sandbox.scriptsDir, 'audit-scan.js'), ...args], {
    encoding: 'utf8',
  });
}

test('清单为空时扫描闸报错（空清单 ≠ 已保护）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'forbidden.txt'), '# 只有注释，没有词条\n\n');
  const parsed = parseManifest('# 只有注释，没有词条\n\n');
  assert.equal(parsed.terms.length, 0);
  assert.ok(parsed.errors.length > 0, '必须报"闸未生效"');
  assert.ok(parsed.errors[0].includes('闸未生效'));
  rmSync(dir, { recursive: true, force: true });
});

test('能拦下故意写错的文档，并报出文件与行号', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'bad.md'), '第一行正常\n第二行写了四维各25%\n第三行正常\n');
  const parsed = parseManifest('四维各25%\n');
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
  assert.equal(report.violations.length, 1);
  assert.ok(report.violations[0].file.endsWith('bad.md'));
  assert.equal(report.violations[0].line, 2);
  assert.ok(report.violations[0].text.includes('四维各25%'));
  rmSync(dir, { recursive: true, force: true });
});

test('禁用词出现在"更正语境"里允许出现（引用规则不是违规）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'good.md'), '说明：四维各25%（原表述有误，已按 C-01 裁决更正）\n');
  const parsed = parseManifest('四维各25%|原表述有误|已更正\n');
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
  assert.equal(report.violations.length, 0, '更正语境不应算违规');
  assert.equal(report.exempted.length, 1, '豁免命中必须被记录（不静默）');
  rmSync(dir, { recursive: true, force: true });
});

test('清单文件本身与测试夹具被排除（排除项必须在报告里列出，不静默）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'forbidden.txt'), '禁用词\n');
  writeFileSync(join(dir, 'a.test.js'), '禁用词\n');
  const parsed = parseManifest('禁用词\n');
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: ['forbidden.txt', '*.test.js'] });
  assert.equal(report.violations.length, 0);
  assert.ok(report.excludedPaths.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('scanText 能逐行定位违规', () => {
  const parsed = parseManifest('禁用词\n');
  const r = scanText('第一行\n含禁用词的行\n', parsed.terms, { file: 'x.md' });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].line, 2);
});

test('仓库自带的 forbidden.txt 非空、每条词条合法、且能被解析', () => {
  const text = readFileSync(MANIFEST, 'utf8');
  const parsed = parseManifest(text);
  assert.ok(parsed.terms.length > 0, '禁用清单不得为空');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  for (const t of parsed.terms) {
    assert.ok(t.term.trim().length > 0);
  }
});

test('仓库自带的 forbidden.txt 里没有重复词条', () => {
  const text = readFileSync(MANIFEST, 'utf8');
  const parsed = parseManifest(text);
  const seen = new Set();
  for (const t of parsed.terms) {
    assert.equal(seen.has(t.term), false, `重复词条：${t.term}`);
    seen.add(t.term);
  }
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// 规格自带的 7 条用例盖不住「闸根本没生效」这一类失败：词条写成正则占位
// （`四维各 ?25%`）时，字面匹配下永远命中不了，闸看着在跑、实际一条不拦。
// 下面这批用例把「闸真的生效」钉死。

test('仓库自带清单能拦住「真实写错」的表述（字面串，不是 ? 占位写法）', () => {
  const parsed = parseManifest(readFileSync(MANIFEST, 'utf8'));
  const cases = [
    { wrong: 'CICC 四维各 25%', term: '四维各 25%' },
    { wrong: '初赛企业确认权重 20%', term: '初赛企业确认权重 20%' },
  ];
  for (const c of cases) {
    const dir = tempDir();
    writeFileSync(join(dir, 'wrong.md'), `行业参考：${c.wrong}\n`);
    const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
    assert.ok(
      report.violations.some((v) => v.term === c.term),
      `仓库清单必须能拦住「${c.wrong}」—— 词条写成 ? 占位就拦不住（闸被架空）`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('仓库自带清单里没有「正则占位」写法（字面匹配下 ? / * / .* 永不命中）', () => {
  const parsed = parseManifest(readFileSync(MANIFEST, 'utf8'));
  for (const { term } of parsed.terms) {
    assert.ok(!term.includes('?'), `词条含正则占位「?」，字面匹配下永不命中：${term}`);
    assert.ok(!term.includes('*'), `词条含正则占位「*」，字面匹配下永不命中：${term}`);
    assert.ok(!term.includes('.*'), `词条含正则片段「.*」，字面匹配下永不命中：${term}`);
  }
});

test('清单里有一行只有分隔符没有词条 → 报错（不是当成合法词条放行）', () => {
  const parsed = parseManifest('|原表述有误\n');
  assert.equal(parsed.terms.length, 0);
  assert.ok(
    parsed.errors.some((e) => e.includes('只有分隔符没有词条')),
    parsed.errors.join('；'),
  );
});

test('@skip-path 命中的路径整条跳过，并在排除报告里留痕（不静默）', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'skipped-dir'), { recursive: true });
  writeFileSync(join(dir, 'skipped-dir', 'x.md'), '禁用词\n');
  writeFileSync(join(dir, 'keep.md'), '禁用词\n');
  const parsed = parseManifest('@skip-path skipped-dir\n禁用词\n');
  assert.equal(parsed.skipPaths.length, 1);
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
  assert.equal(report.violations.length, 1, '被跳过的目录不该产生违规');
  assert.ok(
    report.excludedPaths.some((e) => e.path.endsWith('skipped-dir') && e.reason === '@skip-path'),
    '被跳过的路径必须在排除报告里留痕',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('CLI：清单为空（只有注释）→ 退出码 2，并报「禁用清单为空 —— 闸未生效」', () => {
  const sb = cliSandbox({ manifest: '# 只有注释，没有词条\n' });
  const r = runCli(sb);
  assert.equal(r.status, 2, `期望退出码 2，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /禁用清单为空 —— 闸未生效/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：清单文件缺失 → 退出码 2，并报「禁用清单缺失」（闸未生效）', () => {
  const sb = cliSandbox({ manifestMissing: true });
  const r = runCli(sb);
  assert.equal(r.status, 2, `期望退出码 2，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /禁用清单缺失/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：扫到禁用表述 → 退出码 1，并报出文件与行号', () => {
  const sb = cliSandbox({
    manifest: '禁用词\n',
    files: { 'bad.md': '第一行正常\n第二行写了禁用词\n' },
  });
  const r = runCli(sb, [sb.docsDir]);
  assert.equal(r.status, 1, `期望退出码 1，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /bad\.md:2/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：干净清单 + 无违规 → 退出码 0，排除项照样打印（不静默）', () => {
  const sb = cliSandbox({ manifest: '禁用词\n', files: { 'ok.md': '正常内容\n' } });
  const r = runCli(sb, [sb.docsDir]);
  assert.equal(r.status, 0, `期望退出码 0，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /未发现禁用表述/);
  assert.match(r.stdout, /排除 \d+ 项/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：更正语境豁免会记进报告（不静默）', () => {
  const sb = cliSandbox({
    manifest: '禁用词|已更正\n',
    files: { 'good.md': '说明：禁用词（已更正）\n' },
  });
  const r = runCli(sb, [sb.docsDir]);
  assert.equal(r.status, 0, `期望退出码 0，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /豁免命中 1 处/);
  assert.match(r.stdout, /good\.md:1/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('清单里的非法正则 → 报错（不能静默吞掉）', () => {
  const badSkip = parseManifest('@skip-path (\n禁用词\n');
  assert.ok(
    badSkip.errors.some((e) => e.includes('@skip-path 正则非法')),
    badSkip.errors.join('；'),
  );
  const badExempt = parseManifest('禁用词|(\n');
  assert.ok(
    badExempt.errors.some((e) => e.includes('豁免正则非法')),
    badExempt.errors.join('；'),
  );
});

test('清单里有重复词条 → 报错（不许当成两条不同的词条放行）', () => {
  const parsed = parseManifest('禁用词\n禁用词\n');
  assert.equal(parsed.terms.length, 1);
  assert.ok(
    parsed.errors.some((e) => e.includes('重复词条')),
    parsed.errors.join('；'),
  );
});

test('仓库自带清单必须保住 P0 已证伪的词条（不许被悄悄删掉）', () => {
  const parsed = parseManifest(readFileSync(MANIFEST, 'utf8'));
  const terms = parsed.terms.map((t) => t.term);
  for (const t of ['积分占决赛30%', '积分占决赛 30%', '积分占比决赛30%', '积分占比决赛 30%', '占决赛30%', '占决赛 30%']) {
    assert.ok(terms.includes(t), `P0 已证伪词条不许被删：${t}`);
  }
});

test('CLI：真实仓库跑一遍扫描闸 → 退出码 0（排除项与豁免都打印出来，不静默）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: PLATFORM_DIR });
  assert.equal(r.status, 0, `真实仓库扫描必须通过（退出码 0）\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /未发现禁用表述/);
  assert.match(r.stdout, /排除 \d+ 项/);
  assert.match(r.stdout, /platform\/scripts\/forbidden\.txt（默认排除）/);
});

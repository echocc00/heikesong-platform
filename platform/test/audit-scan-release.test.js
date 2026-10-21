import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseManifest, scanText, main } from '../scripts/audit-scan.js';

const here = dirname(fileURLToPath(import.meta.url));

test('清单为空时扫描闸报错（空清单 ≠ 已保护）', () => {
  const parsed = parseManifest('# 只有注释，没有词条\n\n');
  assert.equal(parsed.terms.length, 0);
  assert.ok(parsed.errors.length > 0, '必须报"闸未生效"');
  assert.ok(parsed.errors[0].includes('闸未生效'), `实际错误：${parsed.errors[0]}`);
});

test('故意写错的文本能被拦下', () => {
  const parsed = parseManifest('积分占决赛 30%\n');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  const bad = '依据 AdventureX 经验，积分占决赛 30%，可以进 A 榜。\n';
  const r = scanText(bad, parsed.terms, { file: 'docs/x.md' });
  assert.equal(r.violations.length, 1, '必须拦下');
  assert.equal(r.violations[0].term, '积分占决赛 30%');
  assert.equal(r.violations[0].line, 1);
  assert.equal(r.exempted.length, 0);
});

test('更正语境不被误拦（词条|豁免正则 语法）', () => {
  // ⚠️ 词条是【字面串】匹配（scanText 用 line.includes），不是正则。
  //    所以空格变体必须各写一条（这也是平台自带 forbidden.txt 的既有约定）。
  const parsed = parseManifest('CICC 四维各 25%|已更正|S7 §1.1|不是|六维\n');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  assert.equal(parsed.terms[0].term, 'CICC 四维各 25%');
  assert.ok(parsed.terms[0].exemptRegex instanceof RegExp);

  // 更正语境：同一行里出现豁免标记 → 不计违规
  const correction = 'S7 §1.1 已更正：CICC 四维各 25% 的说法有误，本平台改为六维权重表。\n';
  const ok = scanText(correction, parsed.terms, { file: 'docs/spec.md' });
  assert.equal(ok.violations.length, 0, '更正语境不得被拦下');
  assert.equal(ok.exempted.length, 1, '更正语境必须被记录（豁免不静默）');

  // 没有豁免标记的裸引用 → 必须拦下
  const bare = 'CICC 四维各 25% 是行业通行做法。\n';
  const bad = scanText(bare, parsed.terms, { file: 'docs/spec.md' });
  assert.equal(bad.violations.length, 1, '裸引用必须被拦下');
});

test('仓库自带清单里必须有「CICC 四维各 25%」的更正语境豁免条目', () => {
  const text = readFileSync(join(here, '..', 'scripts', 'forbidden.txt'), 'utf8');
  const parsed = parseManifest(text);
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  const cicc = parsed.terms.find((t) => t.term.includes('CICC'));
  assert.ok(cicc, '清单里必须有 CICC 相关词条');
  assert.ok(cicc.exemptRegex instanceof RegExp, 'CICC 词条必须带豁免正则（更正语境要能出现）');
  assert.ok(!cicc.term.includes('?'), '词条是字面串，不能用 ? 占位（否则永远命中不了）');
  assert.ok(!cicc.term.includes('.*'), '词条是字面串，不能写正则片段');
});

test('平台自身不依赖用户机器上的 evidence-chain skill（增强不可用也不影响结论）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-ev-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '禁用词Y\n', 'utf8');
  const clean = join(dir, 'clean.md');
  writeFileSync(clean, '这里没有任何禁用词\n', 'utf8');
  const code = main([
    '--forbidden', manifest,
    '--evidence-chain', '/绝对不存在的路径/audit-evidence.js',
    clean,
  ]);
  assert.equal(code, 0, '增强不可用时不得把闸判成失败（平台必须能独立跑）');
  rmSync(dir, { recursive: true, force: true });
});

test('发布产物目录也必须过闸（--forbidden 可指定别的清单）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '禁用词X\n', 'utf8');
  const target = join(dir, 'a.md');
  writeFileSync(target, '这里有禁用词X\n', 'utf8');
  const code = main(['--forbidden', manifest, target]);
  assert.equal(code, 1, '命中禁用词必须返回非 0（发布中止）');
  rmSync(dir, { recursive: true, force: true });
});

// ── 父代理预审追加用例（2026-10-21）────────────────────────────────────
// 规格自带的 6 个用例盖不住「闸根本没生效」这一类失败：
//   ① 规格用例 6 名字叫「发布产物目录也必须过闸」，实际测的是 --forbidden + 普通文件，
//      并没有真的测「platform/web/dist/ 这一趟」；
//   ② 规格用例 5 在参数还没实现时也会「通过」（未识别的参数被当成扫描路径 → 扫 0 个文件 →
//      退出码 0），属于假绿。
// 下面这批用例的期望值在「实现正确」与「实现被改坏」两种情况下必须不同（判别性）。

const PLATFORM_DIR = join(here, '..');
const SCRIPT = join(PLATFORM_DIR, 'scripts', 'audit-scan.js');

/**
 * 造一个「能跑 CLI」的临时工程：<root>/platform/scripts/audit-scan.js（脚本副本）+
 * <root>/platform/scripts/forbidden.txt（清单）+ <root>/docs/（被扫的文件）+
 * 可选的 <root>/platform/web/dist/（发布产物）。
 * CLI 里的仓库根 = <root>，所以相对路径可预期（platform/web/dist/index.html）。
 */
function cliSandbox({ manifest = '禁用词\n', files = {}, distFiles = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hks-scan-rel-'));
  const scriptsDir = join(root, 'platform', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  copyFileSync(SCRIPT, join(scriptsDir, 'audit-scan.js'));
  writeFileSync(join(scriptsDir, 'forbidden.txt'), manifest, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, 'docs', name), content, 'utf8');
  }
  if (distFiles) {
    for (const [name, content] of Object.entries(distFiles)) {
      const abs = join(root, 'platform', 'web', 'dist', name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  }
  return { root, scriptsDir };
}

function runCli(sandbox, args = [], env = undefined) {
  return spawnSync(process.execPath, [join(sandbox.scriptsDir, 'audit-scan.js'), ...args], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

test('仓库自带清单真的能拦住裸引用、放过更正语境（CICC 四维各 25% / 行为分进入总分）', () => {
  const parsed = parseManifest(readFileSync(join(here, '..', 'scripts', 'forbidden.txt'), 'utf8'));

  // 裸引用（当作现行规则写）→ 必须拦下
  const bare = scanText('CICC 四维各 25% 是行业通行做法。\n', parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    bare.violations.some((v) => v.term.includes('CICC')),
    '裸引用「CICC 四维各 25%」必须被仓库自带清单拦下',
  );
  const bareScore = scanText('行为分进入总分，按 10% 计入。\n', parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    bareScore.violations.some((v) => v.term === '行为分进入总分'),
    '裸引用「行为分进入总分」必须被仓库自带清单拦下',
  );

  // 更正语境（引用并纠正原始错误表述）→ 不计违规，但要进报告
  const correction = 'S7 §1.1 已更正：CICC 四维各 25% 的说法有误，本平台改为六维权重表。\n';
  const ok = scanText(correction, parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    !ok.violations.some((v) => v.term.includes('CICC')),
    '更正语境不得被拦下',
  );
  assert.ok(
    ok.exempted.some((e) => e.term.includes('CICC')),
    '更正语境必须进报告（豁免不静默）',
  );
  const correctionScore = 'S10 §3.3 已更正：行为分进入总分的说法有误，行为分只做垫底排序。\n';
  const okScore = scanText(correctionScore, parsed.terms, { file: 'docs/x.md' });
  assert.ok(
    !okScore.violations.some((v) => v.term === '行为分进入总分'),
    '更正语境不得被拦下',
  );
});

test('发布产物目录（platform/web/dist/）本身必须过闸（发布产物也扫）', () => {
  const sb = cliSandbox({
    manifest: '禁用词Z\n',
    distFiles: { 'index.html': '<html><body>这里有禁用词Z</body></html>\n' },
  });
  const r = runCli(sb);
  assert.equal(
    r.status,
    1,
    `发布产物里的禁用表述必须拦下（期望退出码 1）\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stderr, /platform\/web\/dist\/index\.html/, '报告里必须指出是发布产物里的哪一行');
  rmSync(sb.root, { recursive: true, force: true });
});

test('发布产物里的每一个文本文件都要过闸（含 src/domain、rules、seed 这类子目录）', () => {
  // ⚠️ 目录形状对齐 Task 6 的 build-demo.js 产物：web/dist/ 根目录有 index.html，
  //    另有 src/domain/（领域层拷贝）、rules/（规则拷贝）、seed/（种子数据）。
  //    末位的 data/ 是「防回归」用的：源码目录的默认排除项里有 'data'，
  //    发布产物那一趟若误用默认排除，data/ 下的文件就会被静默跳过 ——
  //    那正是「发布闸有洞但报告全绿」的形状。
  const sb = cliSandbox({
    manifest: '禁用词Z\n',
    distFiles: {
      'index.html': '<html><body>这里有禁用词Z</body></html>\n',
      'src/domain/scoring.js': '// 领域层\n// 禁用词Z\n',
      'rules/points.json': '{ "note": "禁用词Z" }\n',
      'seed/demo-data.json': '{ "note": "禁用词Z" }\n',
      'data/notes.md': '禁用词Z\n',
    },
  });
  const r = runCli(sb);
  assert.equal(r.status, 1, `发布产物里的禁用表述必须拦下\n${r.stdout}\n${r.stderr}`);
  for (const p of Object.keys({
    'index.html': 1, 'src/domain/scoring.js': 1, 'rules/points.json': 1,
    'seed/demo-data.json': 1, 'data/notes.md': 1,
  })) {
    assert.ok(
      r.stderr.includes(`platform/web/dist/${p}`),
      `发布产物里的 ${p} 必须过闸（报告里却没有它）\n${r.stderr}`,
    );
  }
  rmSync(sb.root, { recursive: true, force: true });
});

test('清单里的 @skip-path 不能把发布产物那道闸关掉（清单自己不能关闸）', () => {
  const sb = cliSandbox({
    manifest: '@skip-path ^platform/web/dist/\n禁用词Z\n',
    distFiles: { 'index.html': '禁用词Z\n' },
  });
  const r = runCli(sb);
  assert.equal(
    r.status,
    1,
    `清单不许把发布产物那道闸关掉（期望退出码 1）\n${r.stdout}\n${r.stderr}`,
  );
  rmSync(sb.root, { recursive: true, force: true });
});

test('发布产物不存在时按「存在才扫」处理，不报错（退出码 0）', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'ok.md': '正常内容\n' } });
  const r = runCli(sb);
  assert.equal(r.status, 0, `发布产物不存在不该报错\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /发布产物 platform\/web\/dist：不存在/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('发布产物里的更正语境 → 不计违规，但必须进报告（豁免不静默）', () => {
  const sb = cliSandbox({
    manifest: 'CICC 四维各 25%|已更正|S7 §1.1|不是|六维\n',
    distFiles: { 'spec.md': 'S7 §1.1 已更正：CICC 四维各 25% 的说法有误。\n' },
    files: { 'ok.md': '正常内容\n' },
  });
  const r = runCli(sb);
  assert.equal(r.status, 0, `更正语境不得被拦下\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /豁免命中 1 处/, '发布产物里的豁免也必须进报告（豁免不静默）');
  rmSync(sb.root, { recursive: true, force: true });
});

test('--json 输出机器可读（含违规与发布产物信息）', () => {
  const sb = cliSandbox({
    manifest: '禁用词Z\n',
    distFiles: { 'index.html': '禁用词Z\n' },
    files: { 'ok.md': '正常内容\n' },
  });
  const r = runCli(sb, ['--json']);
  assert.equal(r.status, 1, `JSON 模式下退出码语义不变\n${r.stdout}\n${r.stderr}`);
  const data = JSON.parse(r.stdout);
  assert.equal(data.terms, 1);
  assert.equal(data.violations.length, 1);
  assert.equal(data.violations[0].term, '禁用词Z');
  assert.equal(data.releaseArtifacts.present, true);
  assert.equal(data.releaseArtifacts.scannedFiles, 1);
  rmSync(sb.root, { recursive: true, force: true });
});

test('未知参数 → 退出码 2（不许把参数当路径吞掉后「扫 0 个文件还报通过」）', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'ok.md': '正常内容\n' } });
  const r = runCli(sb, ['--jsonn']);
  assert.equal(r.status, 2, `参数写错必须报错退出\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /未知参数/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('--forbidden 缺路径 → 退出码 2（不许静默回落默认清单）', () => {
  const code = main(['--forbidden']);
  assert.equal(code, 2, '--forbidden 少了路径不许回落默认清单（那等于用错清单）');
});

test('--forbidden 指定的清单为空 → 退出码 2（空清单 ≠ 已保护，与默认清单同规则）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-empty-man-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '# 只有注释，没有词条\n', 'utf8');
  const target = join(dir, 'a.md');
  writeFileSync(target, '随便写点什么\n', 'utf8');
  const code = main(['--forbidden', manifest, target]);
  assert.equal(code, 2, '空清单必须报错退出，不许「扫了 0 个词就通过」');
  rmSync(dir, { recursive: true, force: true });
});

test('一个文件都没扫到 → 退出码 2（静默的空产出比报错更危险）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-scan-empty-'));
  const manifest = join(dir, 'forbidden.txt');
  writeFileSync(manifest, '禁用词Z\n', 'utf8');
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const code = main(['--forbidden', manifest, empty]);
  assert.equal(code, 2, '扫了 0 个文件不许报通过');
  rmSync(dir, { recursive: true, force: true });
});

test('evidence-chain 增强不可用（HOME 下没有该 skill）→ 闸结论不变，退出码 0 并打印一行说明', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'ok.md': '正常内容\n' } });
  const fakeHome = mkdtempSync(join(tmpdir(), 'hks-scan-home-'));
  const r = runCli(sb, [], { HOME: fakeHome });
  assert.equal(
    r.status,
    0,
    `增强不可用不许把闸判成失败（平台必须能独立跑）\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /evidence-chain 增强不可用/);
  rmSync(sb.root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

test('--evidence-chain 指向真实脚本 → 增强真的被调用（且闸结论不受它影响）', () => {
  const sb = cliSandbox({ manifest: '禁用词Z\n', files: { 'bad.md': '这里有禁用词Z\n' } });
  const marker = join(sb.root, 'marker.txt');
  const fake = join(sb.root, 'fake-evidence.js');
  writeFileSync(
    fake,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'called\\n');\n`,
    'utf8',
  );
  const r = runCli(sb, ['--evidence-chain', fake]);
  assert.ok(existsSync(marker), '增强脚本必须真的被执行（参数没被吞掉）');
  assert.equal(r.status, 1, '闸结论只看禁用表述，不看增强脚本的输出');
  rmSync(sb.root, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findViolations, collectShellFiles } from '../scripts/bash-var-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const repoDir = join(platformDir, '..');
const script = join(platformDir, 'scripts', 'bash-var-scan.js');

test('机器闸存在：platform/scripts/bash-var-scan.js', () => {
  assert.ok(existsSync(script), 'bash 变量名扫描器必须存在');
});

test('规则能判别：$变量紧跟非 ASCII ⇒ 违规；加花括号 ⇒ 不违规', () => {
  const bad = findViolations('log "站点 $NGINX_SITE（模板）"\n');
  assert.equal(bad.length, 1, `已知坏输入必须判 1 条违规，实际 ${bad.length}`);
  assert.equal(bad[0].varName, 'NGINX_SITE', `变量名应识别为 NGINX_SITE，实际 ${bad[0].varName}`);
  assert.equal(bad[0].line, 1, '行号应识别为第 1 行');

  assert.equal(findViolations('log "站点 ${NGINX_SITE}（模板）"\n').length, 0, '加了花括号就不该判违规');
  assert.equal(findViolations('log "$A $B / $C"\n').length, 0, '后面是 ASCII 空格/斜杠不该判违规');
  assert.equal(findViolations('log "${A}（${B}）"\n').length, 0, '两个都带花括号不该判违规');
  // ⚠️ 判定必须**逐个**看：${A}（$B）里 $B 后面紧跟全角括号 ⇒ $B 仍然是违规
  assert.equal(findViolations('log "${A}（$B）"\n').length, 1, '$B 紧跟全角括号 ⇒ 仍然违规（不能因为前面有 ${A} 就放过）');
});

test('⛔ 仓库里所有 shell 脚本必须零违规（这正是本闸存在的意义）', () => {
  const files = collectShellFiles(repoDir);
  assert.ok(files.length > 0, '应当至少扫到几个 shell 脚本');
  const offenders = [];
  for (const f of files) {
    const v = findViolations(readFileSync(f, 'utf8'));
    if (v.length) offenders.push({ file: f, v });
  }
  assert.equal(
    offenders.length,
    0,
    '以下 shell 文件存在「$变量紧跟非 ASCII」⇒ bash 会把后续字符并进变量名 ⇒ 运行时 unbound variable：\n'
    + offenders.map((o) => `${o.file}\n${o.v.map((x) => `  第 ${x.line} 行：${x.snippet}`).join('\n')}`).join('\n'),
  );
});

test('机器闸自检通过（防「一条都不判违规」的假绿）', () => {
  const res = spawnSync(process.execPath, [script, '--self-test'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `自检应通过，实际输出：\n${res.stdout || ''}${res.stderr || ''}`);
  assert.match(res.stdout, /自检通过/, '自检应明确报告通过');
});

test('机器闸跑全仓：退出码 0（当前仓库无违规）', () => {
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(res.status, 0, `全仓扫描应退出 0，实际输出：\n${res.stdout || ''}${res.stderr || ''}`);
  assert.match(res.stdout, /扫描 \d+ 个 shell 文件/, '应报告扫描了哪些文件');
});

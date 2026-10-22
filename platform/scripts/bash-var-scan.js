#!/usr/bin/env node
// scripts/bash-var-scan.js — 机器闸：shell 脚本里的「$变量紧跟非 ASCII 字符」
//
// 背景（真实事故，两次）：
//   bash 把**多字节字符**当作标识符的一部分 ⇒ `"$NGINX_SITE（模板…"` 里的
//   变量名会被解析成 `NGINX_SITE（` ⇒ **unbound variable** ⇒ 脚本当场死。
//   而这行日志看起来人畜无害（中文括号而已）⇒ 极难自查、极难排障。
//
//   正解：变量后面紧跟任何非 ASCII 字符时，一律写 `${VAR}`。
//
// 为什么要有这个闸：
//   ① 它是**纯语法**问题，`bash -n` **查不出来**（那行语法是合法的，
//      只是运行时才炸）；
//   ② 它只在**运行时**、且只在**恰好走到那行**时才炸 ⇒ 沙箱测试容易漏；
//   ③ 本项目的中文注释密度很高 ⇒ 这个坑几乎必然复发。
//
// 用法：node scripts/bash-var-scan.js            （扫描整个 platform/）
//       node scripts/bash-var-scan.js --self-test （只跑自检）
// 退出码：0 = 干净；1 = 有违规；2 = 用法错。
//
// ⚠️ 闸的自我要求：扫描器必须能判**已知坏输入**为违规（防「一条都不判违规」的假绿）。
//   ⇒ 自检里内置一组正反样本，判定不符就退出码 2。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const repoDir = join(platformDir, '..');

/** 扫描规则：$变量名 后面紧跟一个非 ASCII 字符（>= 0x80）⇒ 违规。 */
export function findViolations(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    // 变量名：[A-Za-z_][A-Za-z0-9_]*；后面必须紧跟非 ASCII（不是 }、不是引号、不是空格）
    const re = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push({
        line: i + 1,
        varName: m[1],
        snippet: line.slice(Math.max(0, m.index - 24), m.index + 24).trim(),
      });
    }
  });
  return out;
}

/** 递归收集要扫的 shell 文件（跳过 node_modules / .git / 数据目录）。 */
export function collectShellFiles(root) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'data', 'dist', 'coverage']);
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && (extname(e.name) === '.sh' || extname(e.name) === '.bash')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// ── 自检：判定必须能判别（正反样本）────────────────────────────────────
function selfTest() {
  const bad = findViolations('log "站点 $NGINX_SITE（模板）"\n');
  const good = findViolations('log "站点 ${NGINX_SITE}（模板）"\n');
  const good2 = findViolations('log "站点 $NGINX_SITE / $OTHER"\n');
  const problems = [];
  if (bad.length !== 1) problems.push(`已知坏输入应判 1 条违规，实际 ${bad.length}`);
  if (good.length !== 0) problems.push(`加了花括号应判 0 条违规，实际 ${good.length}`);
  if (good2.length !== 0) problems.push(`后面是 ASCII 应判 0 条违规，实际 ${good2.length}`);
  return problems;
}

// ⚠️ 顶层 CLI 必须在「作为主程序运行时」才执行 —— 否则测试 import 这个模块时
//    整个闸会跟着跑一遍并 process.exit，测试就 import 不到函数了。
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

function runCli(argv) {
const args = argv.slice(0);
if (args.includes('--self-test')) {
  const problems = selfTest();
  if (problems.length) {
    console.error('[bash-var-scan] ❌ 自检不通过：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  console.log('[bash-var-scan] ✅ 自检通过（正反样本判定正确）');
  process.exit(0);
}
if (args.length > 0) {
  console.error(`用法：node scripts/bash-var-scan.js [--self-test]`);
  process.exit(2);
}

const problems = selfTest();
if (problems.length) {
  console.error('[bash-var-scan] ❌ 自检不通过（扫描器本身不可信，拒绝出报告）：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

const files = collectShellFiles(repoDir);
let total = 0;
const report = [];
for (const f of files) {
  let text = '';
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const v = findViolations(text);
  if (v.length) {
    total += v.length;
    report.push({ file: relative(repoDir, f), violations: v });
  }
}

console.log(`[bash-var-scan] 扫描 ${files.length} 个 shell 文件，违规 ${total} 处`);
if (total === 0) {
  console.log('[bash-var-scan] ✅ 通过');
  process.exit(0);
}
for (const r of report) {
  console.error(`\n⚠️  ${r.file}`);
  for (const v of r.violations) {
    console.error(`   第 ${v.line} 行：$` + `${v.varName}` + ` 紧跟非 ASCII 字符`);
    console.error(`     ${v.snippet}`);
    console.error(`     ⛔ 会被 bash 解析成变量名「` + `${v.varName}` + `+后续字符」⇒ unbound variable`);
    console.error(`     ✅ 改成 ${'${'}${v.varName}${'}'}`);
  }
}
console.error(`\n[bash-var-scan] ❌ 有 ${total} 处违规（bash 允许非 ASCII 出现在标识符里 ⇒ $VAR 紧跟中文/全角符号会被并进变量名）`);
process.exit(1);
}

if (isMain) runCli(process.argv.slice(2));

// 计划块同步：把计划里**指定文件**的代码块逐字替换成当前实现的内容。
//
// 为什么不用 /tmp/p3fix/sync-plan-blocks.py：它的选块靠「hint 里出现该路径」+ 打分，
//   在本仓会**选错块**（真实踩坑：`src/config.js` 选到了计划开头的**目录树**那一块，
//   `src/server.js` 直接「找不到」）。
//   ⇒ 本工具用**无歧义**的定位信号：**代码块的首行是本文件的头注释**
//   （本仓约定 `// src/config.js — 说明` / `# deploy/install.sh — 说明` / `<!-- ... -->`）。
//   多个候选时取**最长**的（整文件块 > 片段块）。
//
// 用法：
//   node docs/tools/plan-block-sync.mjs <plan> <platformDir> <relpath...>
//   （relpath 相对 platform/，如 src/config.js）
//   node docs/tools/plan-block-sync.mjs --verify <plan> <platformDir> <relpath...>
//   （--verify：只核验不修改；用**同一套定位逻辑** ⇒ 与同步结果自洽）
//
// ⚠️ 替换是**就地**的：先备份再跑（脚本会自己写一份 .bak）。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const VERIFY = argv[0] === '--verify';
if (VERIFY) argv.shift();
const [planPath, platformDir, ...targets] = argv;
if (!planPath || !platformDir || targets.length === 0) {
  console.error('用法： node docs/tools/plan-block-sync.mjs [--verify] <plan> <platformDir> <relpath...>');
  process.exit(2);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lines = readFileSync(planPath, 'utf8').split('\n');

// ── 收集所有围栏块 ────────────────────────────────────────────────────────
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^```(\w*)\s*$/);
  if (!m) continue;
  const lang = m[1];
  const body = [];
  let j = i + 1;
  if (lang === 'markdown') {
    let nested = 0;
    while (j < lines.length) {
      if (/^```\w+$/.test(lines[j])) { nested++; j++; continue; }
      if (lines[j] === '```') { if (nested > 0) { nested--; j++; continue; } break; }
      body.push(lines[j]); j++;
    }
  } else {
    while (j < lines.length && lines[j] !== '```') { body.push(lines[j]); j++; }
  }
  blocks.push({ start: i, end: j, lang, body });
  i = j;
}

/** 块的首行是不是「本文件的头注释」 */
function headerMatches(body, rel) {
  const first = body.find((x) => x.trim());
  if (!first) return false;
  const base = rel.replace(/^platform\//, '');
  const re = new RegExp(
    '^\\s*(?://|#|<!--)\\s*' + esc(base) + '\\s*(?:[—\\-:：]|-->)\\s*\\S',
  );
  return re.test(first);
}

/**
 * 测试文件的块首行不是文件头注释（是 `import test from 'node:test'`），
 * ⇒ 退一步用「围栏前紧邻的路径行」来定位（本仓写法：`` `platform/test/xxx.test.js`： ``）。
 */
function hintLineMatches(body, rel, startLine) {
  const base = rel.replace(/^platform\//, '').split('/').pop();
  for (let k = startLine - 1; k >= Math.max(-1, startLine - 4); k--) {
    const l = lines[k];
    if (l === undefined) continue;
    if (/^\s*```/.test(l)) break;
    if (l.includes('`platform/' + rel.replace(/^platform\//, '')) || l.includes('`' + rel + '`')) return true;
    if (l.includes('`' + base + '`')) return true;
  }
  return false;
}

const edits = [];
for (const rel of targets) {
  let cands = blocks.filter((b) => headerMatches(b.body, rel));
  let how = '首行文件头注释';
  if (cands.length === 0) {
    cands = blocks.filter((b) => hintLineMatches(b.body, rel, b.start));
    how = '围栏前的路径行';
  }
  if (cands.length === 0) {
    console.error(`⛔ ${rel}：计划里找不到该文件的代码块（两种定位信号都没命中）`);
    process.exitCode = 1;
    continue;
  }
  cands.sort((a, b) => b.body.length - a.body.length);
  const pick = cands[0];
  const realPath = join(platformDir, rel);
  if (!existsSync(realPath)) {
    console.error(`⛔ ${rel}：真实文件不存在`);
    process.exitCode = 1;
    continue;
  }
  const content = readFileSync(realPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const LANG = {
    '.js': 'javascript', '.json': 'javascript', '.sh': 'bash', '.sql': 'sql',
    '.html': 'html', '.css': 'css', '.md': 'markdown', '.conf': 'nginx',
    '.service': 'systemd', '.yml': 'yaml', '.txt': 'text',
  };
  const ext = rel.slice(rel.lastIndexOf('.'));
  const lang = LANG[ext] || '';
  const newBlock = ['```' + lang, ...content.split('\n'), '```'];
  if (VERIFY) {
    const inPlan = pick.body.join('\n');
    const ok = inPlan === content;
    console.log(`  ${ok ? '✅' : '❌'} ${rel.padEnd(34)} 计划第 ${pick.start + 1} 行（块 ${pick.body.length} 行 / 真实 ${content.split('\n').length} 行）${ok ? '逐字一致' : '不一致'}`);
    if (!ok) process.exitCode = 1;
    continue;
  }
  edits.push({ start: pick.start, end: pick.end + 1, newBlock, rel, candidates: cands.length });
  console.log(`  ${rel.padEnd(34)} 计划第 ${pick.start + 1} 行 → ${newBlock.length} 行（候选 ${cands.length} 个，取最长；定位：${how}）`);
}

if (VERIFY) {
  console.log(process.exitCode ? '\n核验结果：有不一致' : '\n核验结果：全部逐字一致');
  process.exit(process.exitCode || 0);
}
if (edits.length === 0) process.exit(1);

// ⚠️ 必须按位置**升序**处理（游标拼接会把计划写乱 —— 踩过一次）
edits.sort((a, b) => a.start - b.start);
if (!existsSync(planPath + '.bak')) copyFileSync(planPath, planPath + '.bak');
const out = [];
let cur = 0;
for (const e of edits) {
  if (e.start < cur) { console.error('⛔ 编辑区间重叠'); process.exit(1); }
  out.push(...lines.slice(cur, e.start), ...e.newBlock);
  cur = e.end;
}
out.push(...lines.slice(cur));
writeFileSync(planPath, out.join('\n'));
console.log(`计划已同步：${lines.length} → ${out.length} 行（备份：${planPath}.bak）`);

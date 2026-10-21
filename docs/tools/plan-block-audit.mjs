// 计划块漂移审计：每个文件取**最新阶段**（计划序号最大）的那块，核验它与当前实现的关系。
//
// 口径说明（为什么不能直接用 plan-blocks.mjs 的「整文件块❌」）：
//   本仓的文件归属原则是「最早建立者 owns，后续阶段 Modify（追加），不得重建」。
//   ⇒ 早期计划里的块对**被后续阶段追加过**的文件天然不再「整文件一致」，
//      这是**结构性现象**，不是缺陷。真正要抓的是**内容被重写**导致的漂移。
//   所以本脚本的口径是：同一文件取**最新阶段**的那块来比 —— 那块才是当前实现的规格。
//
// 判定：
//   A = 整文件逐字一致          ✅ 规格与实现同形
//   B = 当前文件**含**该片段     ✅ 后续阶段只做了追加，原规格仍是实现的连续子串
//   C = 真漂移                   ❌ 内容被重写 ⇒ 计划块必须同步到当前实现（或登记豁免）
//   D = 无实现                   ⏳ 该文件尚未落地（计划中的后续 Task）
//
// 用法： node docs/tools/plan-block-audit.mjs platform
// 口径：每个文件取**最新阶段**（计划序号最大）的那块来核验。
//   A=整文件一致  B=当前文件含该片段  C=真漂移（需修）  D=无实现
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLANS = [
  ['P0', 'docs/superpowers/plans/2026-10-20-platform-P0-foundation.md'],
  ['P1', 'docs/superpowers/plans/2026-10-20-platform-P1-registration-team.md'],
  ['P2', 'docs/superpowers/plans/2026-10-20-platform-P2-review-engine.md'],
  ['P3', 'docs/superpowers/plans/2026-10-20-platform-P3-leaderboard-points.md'],
  ['P4', 'docs/superpowers/plans/2026-10-20-platform-P4-audit-anticheat.md'],
  ['P5', 'docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md'],
  ['P6', 'docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md'],
];
const platformDir = process.argv[2] || 'platform';
const best = new Map();  // rel → {phase, open, body, lang}
for (const [pn, p] of PLANS) {
  const lines = readFileSync(p, 'utf8').split('\n');
  const OPEN = /^```(\w*)$/;
  function hintOf(i) {
    for (let k = i - 1; k > Math.max(-1, i - 6); k--) {
      let m = lines[k].match(/\*\*Step \d+: (?:创建|修改|新建|补|改写)[^*]*?([\w./-]+\.(?:js|html|css|sql|json))/);
      if (m) return m[1];
      m = lines[k].match(/^\s*`(?:platform\/)?([\w./-]+\.(?:js|html|css|sql|json))/);
      if (m) return m[1];
    }
    return null;
  }
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(OPEN);
    if (!m) { i++; continue; }
    const lang = m[1];
    let j = i + 1; const body = [];
    if (lang === 'markdown') {
      let nested = 0;
      while (j < lines.length) {
        if (/^```\w+$/.test(lines[j])) { nested++; j++; continue; }
        if (lines[j] === '```') { if (nested > 0) { nested--; j++; continue; } break; }
        body.push(lines[j]); j++;
      }
    } else { while (j < lines.length && lines[j] !== '```') { body.push(lines[j]); j++; } }
    const h = hintOf(i);
    if (h) {
      const rel = h.replace(/^platform\//, '');
      // 同阶段多块时，取**行号靠后**的（通常是更晚的修改）
      const prev = best.get(rel);
      if (!prev || pn > prev.phase || (pn === prev.phase && i > prev.open)) {
        best.set(rel, { phase: pn, open: i, body: body.join('\n'), plan: p });
      }
    }
    i = j + 1;
  }
}
const counts = { A: 0, B: 0, C: 0, D: 0 };
const bad = [];
for (const [rel, b] of [...best].sort()) {
  let impl = null;
  try { impl = readFileSync(join(platformDir, rel), 'utf8').replace(/\n$/, ''); } catch { }
  let kind;
  if (impl === null) kind = 'D';
  else if (impl === b.body) kind = 'A';
  else if (impl.includes(b.body)) kind = 'B';
  else kind = 'C';
  counts[kind]++;
  if (kind === 'C') bad.push(`${rel}  ← ${b.phase} 计划第 ${b.open + 1} 行（块 ${b.body.split('\n').length} 行）`);
}
console.log('每个文件取最新阶段那块 ⇒ A(整文件一致)', counts.A, '| B(含片段)', counts.B, '| C(真漂移)', counts.C, '| D(无实现)', counts.D);
console.log('\n--- C 真漂移清单 ---');
bad.forEach(x => console.log('  ' + x));

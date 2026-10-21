// 计划块漂移审计：每个文件取**最新阶段**（计划序号最大）的那块，核验它与当前实现的关系。
//
// 口径说明（为什么不能直接用 plan-blocks.mjs 的「整文件块❌」）：
//   本仓的文件归属原则是「最早建立者 owns，后续阶段 Modify（追加），不得重建」。
//   ⇒ 早期计划里的块对**被后续阶段追加过**的文件天然不再「整文件一致」，
//      这是**结构性现象**，不是缺陷。真正要抓的是**内容被重写**导致的漂移。
//   所以本脚本的口径是：同一文件取**最新阶段**的那块来比 —— 那块才是当前实现的规格。
//
// 判定：
//   A      = 整文件逐字一致              ✅ 规格与实现同形
//   B      = 当前文件**含**该片段         ✅ 后续阶段只做了追加，原规格仍是实现的连续子串
//   C-EXT  = 内容还在，但**中间被插入**了   ⚠️ 良性扩展（结构性现象）—— 只需在台账记一句
//   C-RW   = 内容被**改写/替换**了          ❌ 真漂移 ⇒ 计划块必须同步到当前实现（或登记豁免）
//   D      = 无实现                      ⏳ 该文件尚未落地（计划中的后续 Task）
//
// ⚠️ **C-EXT / C-RW 的分界是「分诊辅助」，不是判决**：
//   分母是**行序保持率**（块的行按原顺序还能在文件里找到多少）。
//   0.6 是经验阈值，遇到「同一行在文件里出现多次」的情况会误判
//   （真实实例：`src/server.js` 里的多行 `router.add(...)` 让贪心匹配错位），
//   ⇒ **C-EXT / C-RW 都要人工看一眼再定**。本工具的权威判据仍是
//   「每个 Task 收尾时对自己那几个块做逐字核验」（plan-blocks / block-by-path / fragment-check）。
//
// 用法： node docs/tools/plan-block-audit.mjs platform
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
    // 归因信号①：hint（Step 标题 / 反引号路径）
    // 归因信号②：**块首行**的文件头注释（本仓约定 `// src/xxx.js — 说明` / `# 路径`）
    //   —— 少了它，P6 Task 5 的 `web/api.demo.js` 块会被算到 P3 的旧块头上（假漂移）。
    let rel = null;
    const h = hintOf(i);
    if (h) rel = h.replace(/^platform\//, '');
    const first = body.find((x) => x.trim());
    if (first) {
      const m2 = first.match(/^\s*(?:\/\/|#)\s+(?:platform\/)?([\w./-]+\.(?:js|html|css|sql|json|sh|conf|service|yml))\s*[—\-:：]/);
      if (m2) {
        const cand = m2[1];
        if (!rel) rel = cand;
        else if (cand !== rel) {
          // 两者不一致时，以**首行注释**为准（内容信号比 hint 信号更可靠）
          rel = cand;
        }
      }
    }
    if (rel) {
      // 同一个文件可能有多个候选块（hint 归因 / 首行注释归因 / 片段块）。
      // 选取规则（两条，缺一不可）：
      //   ① **先滤掉碎片** —— 某些阶段只写了一个 4 行「提及」块（不是这个文件的规格）；
      //   ② 剩下的取**最新**的（阶段更晚 ⇒ 同一行号更大）—— 那块才是当前实现的规格。
      // ⛔ 不能用「块长最接近真实文件」来选：文件被后续阶段**扩展**后，
      //    原始整文件块反而「长度不匹配」但它才是有规格意义的那一块。
      let realLines = -1;
      try {
        realLines = readFileSync(join(platformDir, rel), 'utf8').replace(/\n$/, '').split('\n').length;
      } catch { }
      const blines = body.length;
      const isFragment = realLines > 0 && blines / realLines < 0.25;
      const cands = best.get(rel) || [];
      cands.push({ phase: pn, open: i, body: body.join('\n'), plan: p, blines, realLines, isFragment });
      best.set(rel, cands);
    }
    i = j + 1;
  }
}
// 每个文件：先滤掉碎片候选，剩下取**最新**的（阶段 → 行号）；全被滤掉则退回最新候选
const picked = new Map();
for (const [rel, cands] of best) {
  const solid = cands.filter((c) => !c.isFragment);
  const pool = solid.length ? solid : cands;
  pool.sort((a, b) => (b.phase.localeCompare(a.phase)) || (b.open - a.open));
  picked.set(rel, pool[0]);
}
best.clear();
for (const [rel, c] of picked) best.set(rel, c);
const counts = { A: 0, B: 0, CEXT: 0, CRW: 0, D: 0 };
const bad = [];
/**
 * 行序保持率：块的行**按原顺序**能在这个文件里找到多少（贪心子序列匹配）。
 * ≈1 ⇒ 内容还在，只是**中间被插入了**别的阶段的东西（良性扩展）
 * ≪1 ⇒ 内容被**改写/替换**了（真漂移，计划块必须同步）
 */
function orderKeepRate(blockLines, implLines) {
  if (blockLines.length === 0) return 0;
  let i = 0, kept = 0;
  for (const bl of blockLines) {
    while (i < implLines.length && implLines[i] !== bl) i++;
    if (i < implLines.length) { kept++; i++; }
  }
  return kept / blockLines.length;
}
for (const [rel, b] of [...best].sort()) {
  let impl = null;
  try { impl = readFileSync(join(platformDir, rel), 'utf8').replace(/\n$/, ''); } catch { }
  let kind;
  if (impl === null) kind = 'D';
  else if (impl === b.body) kind = 'A';
  else if (impl.includes(b.body)) kind = 'B';
  else {
    const rate = orderKeepRate(b.body.split('\n'), impl.split('\n'));
    kind = rate >= 0.6 ? 'CEXT' : 'CRW';
  }
  counts[kind]++;
  if (kind === 'CEXT' || kind === 'CRW') {
    bad.push(`${kind === 'CEXT' ? '良性扩展' : '真重写'}  ${rel}  ← ${b.phase} 计划第 ${b.open + 1} 行（块 ${b.body.split('\n').length} 行）`);
  }
}
console.log('每个文件取最新阶段那块 ⇒ A(整文件一致)', counts.A,
  '| B(含片段)', counts.B,
  '| C-EXT(良性扩展·后续阶段插入)', counts.CEXT,
  '| C-RW(真重写·需同步)', counts.CRW,
  '| D(无实现)', counts.D);
console.log('\n--- C 清单（良性扩展 = 结构性现象，只需在台账记一句；真重写 = 必须同步计划块）---');
bad.forEach(x => console.log('  ' + x));

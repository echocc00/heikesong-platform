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
//   node docs/tools/plan-block-audit.mjs --selftest   （自检：正则与归因是否正确）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── 扩展名白名单 ──────────────────────────────────────────────────────
// ⛔ **顺序敏感**：`(?:js|html|css|sql|json)` 里 `js` 排在 `json` 前面，
//    而 `[\w./-]+` 是贪婪的 ⇒ `rules/tiebreak.json` 会被匹配成 `rules/tiebreak.js`
//    ⇒ 该文件在实现里明明存在，却因「文件名对不上」被判成 **D(无实现)**。
//    真实后果：本仓 18 个 rules/*.json 全部被误判成 D（假阳性），
//    而真 C-RW（points.json / tiebreak.json / milestones.default.json）被淹没在噪声里。
// ⇒ **扩展名必须按「长的在前」排列**，且必须**整体匹配**（下面用 `(?![A-Za-z0-9])` 兜住）。
const EXTS = ['json', 'js', 'mjs', 'html', 'css', 'sql', 'sh', 'conf', 'service', 'yml', 'yaml'];
const EXT_RE = new RegExp(`\\.(?:${EXTS.join('|')})(?![A-Za-z0-9])`);
/**
 * 从一行文本里提取**第一个**文件路径（带已知扩展名）。
 * ⛔ 扩展名必须整体匹配：`foo.json` 不能被截成 `foo.js`。
 */
export function extractPath(text) {
  const m = String(text).match(new RegExp(`[\\w./-]+\\.(?:${EXTS.join('|')})(?![A-Za-z0-9])`));
  return m ? m[0] : null;
}

const PLANS = [
  ['P0', 'docs/superpowers/plans/2026-10-20-platform-P0-foundation.md'],
  ['P1', 'docs/superpowers/plans/2026-10-20-platform-P1-registration-team.md'],
  ['P2', 'docs/superpowers/plans/2026-10-20-platform-P2-review-engine.md'],
  ['P3', 'docs/superpowers/plans/2026-10-20-platform-P3-leaderboard-points.md'],
  ['P4', 'docs/superpowers/plans/2026-10-20-platform-P4-audit-anticheat.md'],
  ['P5', 'docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md'],
  ['P6', 'docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md'],
  // ⚠️ P7（前端生产级打磨）：新建文件（web/ui.js、web/nav.js、web/views/task-index.js）
  //    的规格块在这里。**P7 不接管既有文件的块** —— 既有的前端文件仍归最早的阶段
  //    （app.js/styles.css → P0，registration/team/admin-registration → P1，
  //      leaderboard/tier/card → P3，audit/flags → P4，tasks → P5，api.demo → P6），
  //    后续阶段只 Modify（追加）⇒ 改动后必须**逐字同步回 owning 阶段的计划块**。
  ['P7', 'docs/superpowers/plans/2026-10-22-platform-P7-ui-production.md'],
  // ⚠️ P9（UI 重构：落地页 + 科技感设计系统）：新建文件的规格块在这里 ——
  //    src/domain/event-info.js（赛制投影）、web/views/landing.js（落地页）、
  //    test/web-landing.test.js、test/event-info-api.test.js。
  //    **P9 不接管既有文件的块** —— 被改写的既有文件（styles.css / app.js → P0、
  //    index.html / api.demo.js → P6、nav.js / ui.js / home.js → P7、
  //    public-api.js / routes/public.js → P5）仍归最早阶段，
  //    改写后必须**逐字同步回 owning 阶段的计划块**（C-RW 必须清零）。
  ['P9', 'docs/superpowers/plans/2026-10-22-platform-P9-ui-redesign.md'],
  // ⚠️ P8（评审打分页 + 赛段计算发榜页）：新建文件的规格块在这里 ——
  //    web/views/review.js、web/views/publish.js 等。
  //    **P8 之前从未进过 PLANS** ⇒ P8 拥有的文件**从来没被审计过**：
  //    那些文件的计划块漂移**永远查不出来**（审计漏掉阶段 = 漏掉整批漂移）。
  ['P8', 'docs/superpowers/plans/2026-10-22-platform-P8-review-publish.md'],
  // ⚠️ P10（设计系统 2.0 + 功能缺口补界面）：新建文件的规格块在这里。
  //    同样**从未进过 PLANS** ⇒ 同 P8，漂移查不出来。
  ['P10', 'docs/superpowers/plans/2026-10-22-platform-P10-design-system.md'],
  // ⚠️ P11（把「写了没接线」的补齐）：新建文件的规格块在这里
  //    （services/stage.js、http/routes/stages.js、http/routes/publish.js、
  //      http/routes/tiebreak.js、http/routes/public-tokens.js 等）。
  //    ⛔ **P11 尤其不能漏**：它就是专门修「实现了、测试也绿了、但产品路径接不上」的阶段
  //      （P11 计划 §1.1 病根 1：「闸只测服务层，不测产品路径」），
  //      而审计漏掉它 ⇒ 这个阶段新写的文件**连漂移都没人查**。
  ['P11', 'docs/superpowers/plans/2026-10-23-platform-P11-wire-up.md'],
];

/**
 * 规格块的实现文件**实际在哪**。
 *
 * ⚠️ **P11：不能一律按 `platform/` 解析**（真实教训）：
 *   仓内有两类被计划块引用的文件 ——
 *     · `platform/**`（平台实现）⇒ 相对 `platform/`；
 *     · `docs/tools/**`（**仓级工具**：机器闸脚本本身）⇒ 相对**仓库根**。
 *   原来一律 `join(platformDir, rel)` ⇒ `docs/tools/x.mjs` 被解析成
 *   `platform/docs/tools/x.mjs`（不存在）⇒ 误判 **D(无实现)**。
 *   ⇒ D 分类是「计划里有、实现里没有」，判错就等于**把闸的视野弄瞎**。
 *   ⇒ 现在：`docs/` 开头的路径按**仓库根**（platformDir 的上一级）解析。
 *
 * @param {string} platformDir 平台目录（如 'platform'）
 * @param {string} rel         计划里引用的路径（相对 platform/ 或仓库根）
 */
export function resolveImplPath(platformDir, rel) {
  const clean = String(rel).replace(/^platform\//, '');
  if (clean.startsWith('docs/')) {
    // platformDir 的上一级 = 仓库根（platformDir 通常是 'platform' 或 '<abs>/platform'）
    return join(dirname(platformDir), clean);
  }
  return join(platformDir, clean);
}

// ⚠️ 主流程（读计划、比对实现、打印清单）**只在直接运行时执行**。
//    否则 `import { extractPath } from '...plan-block-audit.mjs'`（回归测试要用）
//    会在 import 时就去读相对路径下的计划文件 ⇒ cwd 不对就直接抛错。
//    `import.meta.main`：Node ≥ 20.11 提供的「本文件是否为主入口」标志。
if (import.meta.main) {
const platformDir = process.argv[2] || 'platform';
const best = new Map();  // rel → {phase, open, body, lang}
for (const [pn, p] of PLANS) {
  const lines = readFileSync(p, 'utf8').split('\n');
  const OPEN = /^```(\w*)$/;
  function hintOf(i) {
    for (let k = i - 1; k > Math.max(-1, i - 6); k--) {
      // 归因信号①-a：Step 标题里的路径（`**Step 3: 创建 src/xxx.js`）
      if (/\*\*Step \d+: (?:创建|修改|新建|补|改写)/.test(lines[k])) {
        const p = extractPath(lines[k]);
        if (p) return p;
      }
      // 归因信号①-b：反引号包裹的路径行（`` `platform/src/xxx.js`： ``）
      // ⛔ **只认行首第一个反引号 token**，不许从整行里「随便挑一个路径」——
      //    否则散文里的提及会被当成文件声明（真实教训：`` `user_roles` 表已在
      //    Task 2 的 `001_init.sql` 里建好 `` ⇒ 001_init.sql 被误归因成规格块）。
      const bm = lines[k].match(/^\s*`([^`]+)`/);
      if (bm) {
        const p = extractPath(bm[1]);
        if (p) return p;
      }
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
      // 归因信号②：块首行的文件头注释（`// src/xxx.js — 说明` / `# 路径 — 说明`）
      const m2 = first.match(/^\s*(?:\/\/|#)\s+(?:platform\/)?([\w./-]+\.[A-Za-z0-9]+)\s*[—\-:：]/);
      if (m2) {
        // ⛔ 头注释里的扩展名同样不许被截断：`rules/tiebreak.json — 说明`
        //    必须整段匹配成 `.json`，不能只吃 `.js`。
        const cand = extractPath(m2[1]);
        if (cand) {
          if (!rel) rel = cand;
          else if (cand !== rel) {
            // 两者不一致时，以**首行注释**为准（内容信号比 hint 信号更可靠）
            rel = cand;
          }
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
        realLines = readFileSync(resolveImplPath(platformDir, rel), 'utf8').replace(/\n$/, '').split('\n').length;
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
  // ⚠️ **排序键必须认得出两位数阶段号**（实测，Node 22 / ICU 默认 collation）：
  //    `localeCompare` 默认是**字典序**，不是数值序：
  //      'P10'.localeCompare('P9')  === -1   ← P10 排在 P9 **前面**
  //      'P11'.localeCompare('P2')  === -1   ← P11 排在 P2 **前面**
  //    ⇒ 降序排列会变成 `P9 > P8 > … > P2 > P11 > P10 > P1 > P0`
  //      —— P10 / P11 被当成**比 P2 还老**的阶段。
  //    ⇒「取最新阶段那块」会挑到 P2 的旧块，P10 / P11 拥有的文件的漂移
  //      **永远查不出来**（P11 正是专门修「写了没接线」的阶段，审计漏掉它等于白做）。
  //    ⇒ 改用 `{ numeric: true }`（数字段按数值比较）：
  //      P11 > P10 > P9 > P8 > P7 > … > P1 > P0。
  //      ⚠️ P0–P9 都是一位数 ⇒ 它们之间的相对次序**完全不变** ⇒ 旧结果不受影响。
  pool.sort((a, b) => (b.phase.localeCompare(a.phase, undefined, { numeric: true })) || (b.open - a.open));
  picked.set(rel, pool[0]);
}
best.clear();
for (const [rel, c] of picked) best.set(rel, c);
const counts = { A: 0, B: 0, CEXT: 0, CRW: 0, D: 0 };
const bad = [];
const missing = [];
/**
 * 行序保持率：块的行**按原顺序**能在这个文件里找到多少（贪心子序列匹配）。
 * ≈1 ⇒ 内容还在，只是**中间被插入了**别的阶段的东西（良性扩展）
 * ≪1 ⇒ 内容被**改写/替换**了（真漂移，计划块必须同步）
 *
 * ⚠️⚠️ **这个判据有个已知的致命特性（父代理踩过）**：
 *    它是**贪心**子序列匹配 —— 一旦块里**靠前**的某一行在实现里不存在了
 *    （哪怕只改了一行），匹配器会一路扫到文件末尾去找它，
 *    后面所有行**全部失配** ⇒ 保持率从 ~1 直接掉到 ~0.02。
 *    ⇒ **「C-RW 变多」的第一嫌疑永远是「你改了一行」，不是「内容被重写了」。**
 *    真实样本（2026-10-22 P7）：只改了 `src/server.js` 的**一行 import** +
 *    `src/db/repo/users.js` 的**一个函数签名** ⇒ 两个文件双双被判 C-RW
 *    （保持率 0.043 / 0.176），而其余 ~505 / ~85 行**原封不动**。
 *
 * ⇒ 所以本函数**同时返回失配行**，好让工具直接告诉人「第一处失配是什么」，
 *    而不是让人自己猜。判据仍然是「是否需要同步计划块」，但诊断信息必须自足。
 */
function orderKeepRate(blockLines, implLines) {
  if (blockLines.length === 0) return { rate: 0, kept: 0, total: 0, lost: [] };
  let i = 0, kept = 0;
  const lost = [];
  for (const bl of blockLines) {
    while (i < implLines.length && implLines[i] !== bl) i++;
    if (i < implLines.length) { kept++; i++; }
    else lost.push(bl);
  }
  return { rate: kept / blockLines.length, kept, total: blockLines.length, lost };
}
for (const [rel, b] of [...best].sort()) {
  let impl = null;
  try { impl = readFileSync(resolveImplPath(platformDir, rel), 'utf8').replace(/\n$/, ''); } catch { }
  let kind;
  let diag = null;
  if (impl === null) kind = 'D';
  else if (impl === b.body) kind = 'A';
  else if (impl.includes(b.body)) kind = 'B';
  else {
    diag = orderKeepRate(b.body.split('\n'), impl.split('\n'));
    kind = diag.rate >= 0.6 ? 'CEXT' : 'CRW';
  }
  counts[kind]++;
  if (kind === 'CEXT' || kind === 'CRW') {
    bad.push(`${kind === 'CEXT' ? '良性扩展' : '真重写'}  ${rel}  ← ${b.phase} 计划第 ${b.open + 1} 行（块 ${b.body.split('\n').length} 行）`);
  }
  // ⛔ C-RW **必须打印失配明细**：只计数不列清单 ⇒ 「只改了一行却被判真重写」
  //    这种假阳性会静默潜伏（真实教训：P7 改一行 import ⇒ 保持率 0.043 ⇒ 看起来像整文件被重写）。
  if (kind === 'CRW' && diag) {
    bad.push(`  └ 保持率 ${diag.rate.toFixed(3)}（${diag.kept}/${diag.total} 行）｜第一处失配：`);
    for (const l of diag.lost.slice(0, 3)) bad.push(`     ✗ ${l.trim().slice(0, 120)}`);
    if (diag.lost.length > 3) bad.push(`     …（另有 ${diag.lost.length - 3} 行失配）`);
  }
  // ⛔ D 类**必须打印明细**：只计数不列清单 ⇒ 「路径被扩展名截断」这类假阳性会静默潜伏
  //    （真实教训：`rules/tiebreak.json` 被截成 `rules/tiebreak.js` ⇒ 18 个存在的文件被判 D）。
  if (kind === 'D') {
    missing.push(`${rel}  ← ${b.phase} 计划第 ${b.open + 1} 行（块 ${b.body.split('\n').length} 行）`);
  }
}
console.log('每个文件取最新阶段那块 ⇒ A(整文件一致)', counts.A,
  '| B(含片段)', counts.B,
  '| C-EXT(良性扩展·后续阶段插入)', counts.CEXT,
  '| C-RW(真重写·需同步)', counts.CRW,
  '| D(无实现)', counts.D);
console.log('\n--- C 清单（良性扩展 = 结构性现象，只需在台账记一句；真重写 = 必须同步计划块）---');
bad.forEach(x => console.log('  ' + x));
if (missing.length) {
  console.log('\n--- D 清单（计划里有、实现里没有）---');
  missing.forEach(x => console.log('  ' + x));
}

// ── 自检（防假绿）───────────────────────────────────────────────────
// ⛔ 这个工具的 bug 潜伏了很久，正是因为它**没有自检**：正则写错 ⇒ 全部判成 D ⇒
//    数字看着「有输出」，没人发现判据本身是错的。
// ⇒ 自检覆盖「扩展名不得被截断」这个真实教训。
if (process.argv.includes('--selftest')) {
  const cases = [
    // [输入, 期望输出]
    ['rules/tiebreak.json', 'rules/tiebreak.json'],
    ['rules/points.json', 'rules/points.json'],
    ['src/db/repo/users.js', 'src/db/repo/users.js'],
    ['platform/rules/audit.json', 'platform/rules/audit.json'],
    ['deploy/nginx-demo-static.conf', 'deploy/nginx-demo-static.conf'],
    ['web/seed/demo-data.json', 'web/seed/demo-data.json'],
    ['没有扩展名', null],
    ['README', null],
  ];
  const problems = [];
  for (const [input, want] of cases) {
    const got = extractPath(input);
    if (got !== want) problems.push(`extractPath(${JSON.stringify(input)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
  // 反例：`foo.json` 绝不能被截成 `foo.js`
  for (const trap of ['rules/tiebreak.json', 'web/seed/demo-data.json']) {
    const got = extractPath(trap);
    if (got && got.endsWith('.js')) problems.push(`扩展名被截断：${trap} → ${got}`);
  }
  if (problems.length) {
    console.error('\n⛔ 自检失败：');
    problems.forEach(p => console.error('  ' + p));
    process.exit(2);
  }
  console.log('\n✅ 自检通过（扩展名提取无截断）');
}
} // ← import.meta.main 守卫闭合

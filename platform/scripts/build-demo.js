// scripts/build-demo.js — 构建公网演示版静态站
//
// 溯源需求：R-OPS-06（公网可访问：先出公网演示版）｜R-OPS-01/07（零 npm 依赖 / 可移植）
//
// 依据：设计文档 §14.3「公网演示版（现在就能拿到的 URL）」
//   静态站发布工具只能发布静态文件（要求目录里有 index.html），不能跑 Node 后端。
//   → 演示版 = 同源静态前端 + web/api.demo.js（localStorage 适配器）+ 浏览器内真实运行的规则引擎。
//
// ⚠️ 领域层进浏览器的硬约束：src/domain/** 不得 import 任何 Node 内置模块
//    （node:fs / node:path / node:crypto …），否则浏览器跑不起来。
//    本脚本在构建时强制校验，违反即构建失败 —— 这条约束由机器守住，不靠自觉。
//
// ⚠️ 产物目录布局 = **platform/ 树的镜像**（D5-13 的解法，见 buildDemoSite 的注释）：
//      <out>/index.html          入口页（静态托管的硬要求：根目录必须有 index.html）
//      <out>/web/…               适配器与前端（适配器在 <out>/web/api.demo.js）
//      <out>/web/seed/…          种子（SEED_URL 的来源基准 = 相对 web/）
//      <out>/seed/…              种子的第二份（浏览器 fetch() 相对**文档基准**取的那份）
//      <out>/rules/…             规则（RULES_BASE 的来源基准 = 相对 platform/ = 适配器的父目录）
//      <out>/src/domain/…        领域层（适配器 '../src/domain/' 的落点，在产物内）
//    ⇒ 「相对 web/」与「相对 platform/」两个基准**同时**指得到文件，
//      且适配器里 '../src/domain/' 的相对导入不会跑出站点（挂在任意 base path 下都不 404）。
//
// 用法：node scripts/build-demo.js [--out web/dist]
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync, statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, relative, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_RULE_FILES } from '../web/api.demo.js';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * 拷贝一个目录。
 * @param {string[]} exclude     跳过的顶层名字
 * @param {Set<string>} excludePaths 跳过的**绝对路径**（用来挡住「产物目录自己」）
 *   ⚠️ 为什么要按绝对路径挡：产物目录默认在 `web/dist/`，靠名字 'dist' 排除就够；
 *      但 `--out` 可以指向 `web/` 里的**任何**目录（如 `web/dist2/`）——
 *      那时按名字排除挡不住 ⇒ 产物会**把自己拷进自己** ⇒ 无限递归 ⇒ ENAMETOOLONG。
 *      （变异检验 M13 实测炸出来：默认产物目录改成 dist2 后构建直接报 ENAMETOOLONG。）
 */
function copyDir(from, to, { exclude = [], excludePaths = new Set() } = {}) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    // ⛔ 不把 macOS 的 AppleDouble 伴生文件（`._xxx`）拷进产物：
    //    它是资源叉载体（二进制），不是真内容；混进静态站等于把垃圾发给访客。
    //    真机实测：2026-10-21 在 8.133.200.235 上按「跨平台复现」配方拷贝时带到过。
    if (entry.name.startsWith('._')) continue;
    const src = join(from, entry.name);
    if (excludePaths.has(resolve(src))) continue;   // 产物目录自身（无论叫什么名字）
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, { excludePaths });
    else copyFileSync(src, dst);
  }
}

/**
 * 去掉注释（块注释 / 行注释），保留字符串字面量。
 * ⚠️ 为什么要去注释：import 说明符的抽取靠正则，若注释里写着
 *    「// import { x } from 'node:fs'」也会被抽出来 ⇒ 守卫误报 ⇒ 构建被冤杀。
 */
export function stripComments(code) {
  const out = [];
  const src = String(code ?? '');
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; out.push(c); i += 1; continue; }
      if (c === '"') { state = 'dq'; out.push(c); i += 1; continue; }
      if (c === '`') { state = 'tpl'; out.push(c); i += 1; continue; }
      out.push(c); i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out.push('\n'); }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out.push('\n');
      i += 1;
      continue;
    }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
      out.push(c); i += 1;
      continue;
    }
    // 模板字符串：${ } 里的代码暂不深挖（领域层不用模板字面量里的 import）
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { state = 'code'; out.push(c); i += 1; continue; }
    out.push(c); i += 1;
  }
  return out.join('');
}

/**
 * 抽出模块里的 import 说明符（静态 import / export from / 动态 import）。
 * ⚠️ 允许**跨行**：花括号列表常被格式化器拆成多行
 *    （import {\n  a,\n  b,\n} from 'node:fs'）——
 *    只认单行的抽取器会漏掉它 ⇒ 守卫形同虚设 ⇒ 浏览器里才炸。
 */
export function extractImportSpecifiers(code) {
  const specs = [];
  const text = stripComments(code);
  const re1 = /(?:^|[\n;])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const re2 = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  const re3 = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [re1, re2, re3]) {
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  return specs;
}

/**
 * 收集领域层【连同它相对引用到的其它文件】。
 * 返回 { domainFiles, extraFiles }：
 *   domainFiles = src/domain/ 内的文件
 *   extraFiles  = 领域层之外、但被相对 import 引到的文件（例如 src/domain/../shared/x.js）
 * ⚠️ extraFiles 也要拷进产物：相对 import 的结构必须原样保留，否则浏览器里会 404。
 */
export function collectBrowserModules(domainDir) {
  const domainFiles = [];
  const extraFiles = [];
  const seen = new Set();
  const queue = readdirSync(domainDir)
    // ⛔ 跳过 macOS 的 AppleDouble 伴生文件（`._xxx`，资源叉载体，不是真模块）
    .filter((n) => n.endsWith('.js') && !n.startsWith('._'))
    .map((n) => join(domainDir, n));

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    // ⚠️ 必须按**目录边界**判（在目录后面补一个分隔符再比）——
    //    纯前缀比较会把兄弟目录 domain-utils/ 也当成领域层（拷错位置）。
    if (file === domainDir || file.startsWith(domainDir + sep)) domainFiles.push(file);
    else extraFiles.push(file);

    const code = readFileSync(file, 'utf8');
    for (const spec of extractImportSpecifiers(code)) {
      if (!spec.startsWith('.')) continue;          // node: 与裸模块名交给守卫报错
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) continue;            // 指不到的文件由守卫单独报
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { domainFiles, extraFiles };
}

/**
 * Node 专属全局：浏览器里**不存在**，用了就是 ReferenceError。
 *
 * ⚠️⚠️ 为什么必须**单独**查它们：
 *   这几个符号**不需要 import** 就能用 ⇒ 只查 import 说明符的守卫**一个都抓不到**。
 *   实测踩坑（P6 Task 8 台账 G-3）：P5 的 `src/domain/icalendar.js` 用了 `Buffer.from(...)`
 *   —— import 零违规，构建闸放行，产物照发 ⇒ 浏览器里 `Buffer is not defined` ⇒ **演示站白屏**。
 *   ⇒ 构建闸必须在**发布前**就把它拦下来，而不是等到测试或用户看白屏。
 *
 * ⚠️ 清单在**数据文件** `scripts/node-globals.txt` 里，不在代码里 ——
 *    因为平台自己有一条规则「代码里不得出现 __dirname / __filename」
 *    （`test/portability.test.js` 扫 src/ scripts/ web/），
 *    而守卫**必须能点名它要禁的东西** ⇒ 清单写进 .js 就会自指假红。
 *    （与 `scripts/forbidden.txt` 同一个套路：清单用数据、规则用代码。）
 */
const NODE_GLOBALS_FILE = join(here, 'node-globals.txt');

/**
 * 读禁用清单。**空清单 = 闸未生效**（与 forbidden.txt 同一口径）⇒ 直接报错，不静默放行。
 * @returns {string[]} 符号名数组
 */
export function loadNodeOnlyGlobals(file = NODE_GLOBALS_FILE) {
  if (!existsSync(file)) {
    throw new Error(`Node 专属全局禁用清单不存在：${file} —— 守卫无法工作，拒绝构建。`);
  }
  const tokens = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (tokens.length === 0) {
    throw new Error(`Node 专属全局禁用清单是空的：${file} —— 空清单 ≠ 已保护，拒绝构建。`);
  }
  return tokens;
}

/**
 * 在一段代码里找 Node 专属全局。返回命中的 token 数组（空数组 = 没有）。
 * ⚠️ **先剥注释**：注释里写「// 不要用 Buffer」不是违规，否则守卫会误报、构建被冤杀。
 *   （与 `portability.test.js` 里的那条断言是**两套独立实现** ⇒ 互为交叉校验。）
 */
export function findNodeOnlyGlobals(code, tokens = loadNodeOnlyGlobals()) {
  const text = stripComments(code);
  const hits = [];
  for (const token of tokens) {
    // 用**词边界**而不是 `token(`：`require` 要连 `= require(...)` 一起抓，
    // 而 `Buffer` / `process` 也可能以属性名出现（`obj.Buffer` 不算违规，但本仓不用这种写法）。
    if (new RegExp(`\\b${token}\\b`).test(text)) hits.push(token);
  }
  return hits;
}

/**
 * 领域层浏览器安全守卫。
 * 返回违规说明数组（空数组 = 通过）。违反的四种情况：
 *   ① import 了 Node 内置模块（node:fs / node:path / …）
 *   ② import 了裸模块名（不是 './' 或 '../' 开头）—— 浏览器没有 node_modules
 *   ③ 相对导入指不到文件（拷进 dist 后会 404）
 *   ④ 用了 Node 专属全局（Buffer / process / __dirname / __filename / require）
 */
export function assertDomainIsBrowserSafe(domainDir) {
  const violations = [];
  if (!existsSync(domainDir)) return [`领域层目录不存在：${domainDir}`];

  // 清单**只读一次**（每文件读一次会把构建拖慢，也让「清单中途变了」成为可能）
  const nodeGlobals = loadNodeOnlyGlobals();
  const { domainFiles, extraFiles } = collectBrowserModules(domainDir);
  for (const file of [...domainFiles, ...extraFiles]) {
    const rel = relative(dirname(domainDir), file);
    const code = readFileSync(file, 'utf8');
    for (const token of findNodeOnlyGlobals(code, nodeGlobals)) {
      violations.push(`${rel} 用了 Node 专属全局 ${token}（浏览器里不存在 ⇒ 演示站白屏）`);
    }
    for (const spec of extractImportSpecifiers(code)) {
      if (spec.startsWith('node:')) {
        violations.push(`${rel} 导入了 Node 内置模块 ${spec}（浏览器跑不了）`);
        continue;
      }
      if (!spec.startsWith('.')) {
        violations.push(`${rel} 导入了裸模块名 ${spec}（浏览器没有 node_modules）`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) {
        violations.push(`${rel} 的相对导入 ${spec} 指不到文件（拷贝进 dist 后会 404）`);
      }
    }
  }
  return violations;
}

/**
 * 构建静态站。
 * 产物结构（自包含，**镜像 platform/ 的树**）：
 *   <out>/index.html            ← 入口页（静态托管的硬要求：根目录必须有 index.html）
 *   <out>/web/app.js            ← 前端入口（与适配器同级）
 *   <out>/web/api.js  api.demo.js  router.js  store.js  escape.js  styles.css  views/…
 *   <out>/web/seed/demo-data.json ← 从 platform/web/seed 拷贝（SEED_URL 的来源基准）
 *   <out>/seed/demo-data.json     ← 同一份种子（浏览器按【文档基准】取的是这一份）
 *   <out>/rules/*.json            ← 从 platform/rules 拷贝（RULES_BASE 的来源基准）
 *   <out>/src/domain/*.js         ← 从 platform/src/domain 整目录原样拷贝
 *
 * ⚠️ D5-13（两个相对基准不一致）在这里被【布局】解决：
 *   源码树里 SEED_URL 相对 **web/**（= 适配器所在目录）、
 *   RULES_BASE 相对 **platform/**（= 适配器的父目录）—— 两者基准不同。
 *   ⇒ 产物目录按同样的关系摆放：适配器在 <out>/web/、种子在 <out>/web/seed/、
 *     规则在 <out>/rules/（= 适配器的父目录）⇒ **两个基准同时指得到文件**；
 *     同时把种子再放一份在站点根 <out>/seed/（浏览器 fetch() 相对文档基准取的是那份）。
 *   ⇒ 附带好处：适配器里 '../src/domain/*.js' 的相对导入落在 <out>/src/domain/，
 *     **在产物内** ⇒ 站点挂在任意 base path 下都不会 404 白屏。
 */
/**
 * 按 `DEMO_RULE_FILES` 加载**演示适配器实际会用的**那批规则，重组成适配器要的形状。
 *
 * ⚠️ 为什么不用 `src/config.js` 的 `loadRules`：
 *    那份加载的是**平台全量**规则（含 schedule / compliance / pools / audit），
 *    而演示适配器只认 `DEMO_RULE_FILES` 这 12 份 ⇒ 用错清单会算出「浏览器里算不出来的结果」。
 *    ⇒ 这里**必须与浏览器侧同一批配置**（同一个 `DEMO_RULE_FILES`），
 *      否则「构建时算的」与「浏览器里跑的」就不是同一件事 ⇒ 演示价值归零。
 */
export function loadDemoRulesFrom(rulesDir) {
  const loaded = {};
  for (const [key, file] of Object.entries(DEMO_RULE_FILES)) {
    const p = join(rulesDir, file);
    if (!existsSync(p)) throw new Error(`演示规则配置缺失：${p}`);
    loaded[key] = JSON.parse(readFileSync(p, 'utf8'));
  }
  return {
    scoring: { initial: loaded.scoringInitial, final: loaded.scoringFinal },
    tiebreak: loaded.tiebreak,
    ranks: loaded.ranks,
    behavior: loaded.behavior,
    visibility: loaded.visibility,
    registration: loaded.registration,
    solvability: loaded.solvability,
    milestones: loaded.milestones,
    teamFormation: loaded.teamFormation,
    points: loaded.points,
    criteria: loaded.criteria,
  };
}

/**
 * **构建期预计算**：用真实引擎跑一次，把结果写进种子。
 *
 * 背景（真机浏览器实测）：榜单数据来自 `state.results[stageId]`，
 *   而 results 只在 `POST /api/stages/:stageId/compute` 时被写入 ——
 *   正式平台由管理员在后台发榜时触发，**演示站没有后台** ⇒ 访客打开永远是「暂无数据」。
 * ⇒ 这里在构建时把计算跑完，结果落到**产物里的种子** ⇒ 访客打开即见榜单。
 *
 * ⚠️ 只改**产物**的种子，**源种子不动**（`web/seed/demo-data.json` 保持人可读、可评审）。
 * ⚠️ 规则引擎仍在**浏览器里真实可复算** —— 访客自己触发 compute 会重算（可看到同样结果）。
 * ⛔ 计算失败 ⇒ 抛错让构建失败（fail-fast）：宁可构建不出来，也不发一个空榜包。
 */
export async function precomputeDemoSeed({ platformDir, seed }) {
  // ⚠️ 用**绝对路径 + file URL** 动态 import：`platformDir` 可配置（测试会换一份拷贝），
  //    相对导入会解析到脚本自身所在目录 ⇒ 算的是「脚本旁边的平台」而不是「要构建的那个平台」。
  const { pathToFileURL } = await import('node:url');
  const demo = await import(pathToFileURL(join(platformDir, 'web', 'api.demo.js')).href);
  const rules = loadDemoRulesFrom(join(platformDir, 'rules'));

  const state = demo.buildDemoState(seed);
  const stageId = 'stage_final';
  let result;
  try {
    result = demo.runDemoCompute({
      state,
      rules,
      stageId,
      // ⛔ 时间戳用**固定值**：构建产物必须可复现（同一个输入 ⇒ 同一个产物 ⇒ 便于比对与缓存）
      now: '1970-01-01T00:00:00.000Z',
    });
  } catch (err) {
    throw new Error(`演示种子预计算失败，拒绝构建（否则会发出一个「打开就是空榜单」的包）：${err.message}`);
  }
  if (!result || !Array.isArray(result.ordered) || result.ordered.length === 0) {
    throw new Error('演示种子预计算没有产出任何排名，拒绝构建（否则会发出一个「打开就是空榜单」的包）');
  }

  return {
    ...seed,
    computations: { [result.computationId]: result },
    results: { [stageId]: result },
    lastStageId: stageId,
  };
}

export async function buildDemoSite({
  // ⚠️ platformDir 必须排第一个：后面的默认值要引用它（JS 的解构默认值按顺序求值）
  platformDir = join(here, '..'),
  outDir = join(platformDir, 'web', 'dist'),
  webDir = join(platformDir, 'web'),
  rulesDir = join(platformDir, 'rules'),
} = {}) {
  const domainDir = join(platformDir, 'src', 'domain');
  // 1. 先守卫：领域层有 Node 依赖 → 构建失败（不产出半成品）
  const violations = assertDomainIsBrowserSafe(domainDir);
  if (violations.length) {
    throw new Error(
      `领域层不满足浏览器约束，构建中止：\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  // 2. 规则文件必须齐全（缺一个就报错，绝不静默少一个）
  const missing = Object.values(DEMO_RULE_FILES).filter((f) => !existsSync(join(rulesDir, f)));
  if (missing.length) {
    throw new Error(`规则配置缺失，演示站无法启动引擎：${missing.join('、')}`);
  }

  // 3. 清空并重建产物目录
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 4. web/ 整目录拷到 <out>/web/（排除 dist/ 自身）
  //    ⚠️ 为什么不是直接拷到产物根：D5-13 的两个基准（见文件头）要求产物目录
  //    【镜像 platform/ 的结构】——适配器在 <out>/web/、规则在 <out>/rules/、
  //    领域层在 <out>/src/domain/。这样适配器里 '../src/domain/*.js' 的相对导入
  //    在产物里仍然落在产物内（挂在任意 base path 下都不会跑出站点）。
  //    ⚠️ 排除两样：① 名字叫 'dist' 的（上一版的产物目录，不能混进新产物）
  //       ② **绝对路径等于产物目录**的（--out 指向 web/ 里时，产物不能把自己拷进自己）
  copyDir(webDir, join(outDir, 'web'), {
    exclude: ['dist', 'index.html'],
    excludePaths: new Set([resolve(outDir)]),
  });

  // 5. 领域层 + 它相对引用到的其它文件（按 platform/ 下的相对路径镜像拷贝，结构不变）
  const { domainFiles, extraFiles } = collectBrowserModules(domainDir);
  for (const file of [...domainFiles, ...extraFiles]) {
    const rel = relative(platformDir, file);          // 例：src/domain/scoring.js
    const dst = join(outDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(file, dst);
  }

  // 6. 规则配置拷到产物根（= 适配器的父目录 = RULES_BASE 的来源基准）
  copyDir(rulesDir, join(outDir, 'rules'));

  // 7. 种子数据：预计算后拷两份（同一份内容，同源）
  //    ① <out>/web/seed/demo-data.json —— 随 web/ 整目录拷过来的（SEED_URL 的来源基准）
  //    ② <out>/seed/demo-data.json     —— 浏览器里 fetch() 相对【文档基准】解析，
  //       文档在站点根 ⇒ 真正被取到的是这一份
  //    ⚠️ **两份必须都是预计算后的版本** ⇒ 浏览器无论按哪个基准取到种子，榜单都有数据。
  //       （web/ 那份是第 4 步整目录拷过来的 ⇒ 这里必须**覆盖**它，否则它还是未预计算的源种子。）
  const seedSrc = join(webDir, 'seed', 'demo-data.json');
  if (!existsSync(seedSrc)) throw new Error(`缺少演示种子数据：${seedSrc}`);
  const seedRaw = JSON.parse(readFileSync(seedSrc, 'utf8'));
  // 7.1 ⛔ 构建期预计算：用**真实引擎**跑一次，结果写进种子
  //     （否则访客打开榜单页永远是「暂无数据」—— results 只在 compute 时才被写入）
  const precomputed = await precomputeDemoSeed({ platformDir, seed: seedRaw });
  const seedJson = `${JSON.stringify(precomputed, null, 2)}\n`;
  mkdirSync(join(outDir, 'seed'), { recursive: true });
  writeFileSync(join(outDir, 'seed', 'demo-data.json'), seedJson, 'utf8');
  writeFileSync(join(outDir, 'web', 'seed', 'demo-data.json'), seedJson, 'utf8');

  // 8. 入口页放【站点根】（静态托管的硬要求：根目录必须有 index.html）
  //    ⚠️ app 在 <out>/web/ 下 ⇒ 资源路径要指到 ./web/…；
  //       一律保持相对（静态托管可能挂在任意 base path 下，绝对路径会全挂）。
  const srcHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
  const rootHtml = srcHtml.replace(/(src|href)="\.\/([^"]+)"/g, '$1="./web/$2"');
  writeFileSync(join(outDir, 'index.html'), rootHtml, 'utf8');

  // 8.5 ⛔ 强制「演示模式」：改写**产物里**的 isDemo 判定
  //    背景：源前端用查询参数判定 —— `?demo=1` 时用 localStorage 适配器
  //    （web/api.demo.js），否则用真实 API 适配器（web/api.js）。
  //    同一份前端要同时当「正式版」和「演示版」，所以判定放在运行时。
  //    ⚠️ 但**对外发布的静态包**没人会记得加这个参数：
  //    不带 ?demo=1 打开 ⇒ 走真实 API ⇒ 浏览器去请求 /api/* ⇒ 静态站上 404
  //    ⇒ 页面白屏报「Unexpected non-whitespace character after JSON」。
  //    ⇒ 构建时直接把产物里的判定钉死成 true（产物永远是演示站）。
  //    ⛔ 找不到那一行就**构建失败**（fail-fast）：宁可构建不出来，
  //       也不发一个「打开就是坏页面」的包。
  const appJsPath = join(outDir, 'web', 'app.js');
  const appJs = readFileSync(appJsPath, 'utf8');
  const isDemoLine = /^\s*const isDemo\s*=.*$/m;
  if (!isDemoLine.test(appJs)) {
    throw new Error(
      '产物 web/app.js 里找不到 `const isDemo = ...` 判定行 ⇒ 无法强制演示模式。'
      + '（源前端结构变了 ⇒ 请同步更新 build-demo.js 的这一步，否则会发出一个「打开即坏」的包）',
    );
  }
  writeFileSync(
    appJsPath,
    appJs.replace(
      isDemoLine,
      'const isDemo = true;   // build-demo.js 改写：静态演示包永远是演示模式（不需要 ?demo=1）',
    ),
    'utf8',
  );

  // 9. 构建清单（可追溯：规则版本 + 构建时间 + 文件数）
  const manifest = {
    builtAt: new Date().toISOString(),
    ruleFiles: Object.values(DEMO_RULE_FILES),
    note: '演示站：规则引擎在浏览器里真实运行；数据不跨人共享（各自浏览器独立）。',
    precomputed: {
      stageId: precomputed.lastStageId,
      teams: precomputed.results[precomputed.lastStageId]?.ordered?.length ?? 0,
      note: '构建期用真实引擎预计算的结果（访客打开即见榜单）',
    },
  };
  writeFileSync(join(outDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    outDir,
    files: readdirSync(outDir),
    domainFiles: readdirSync(join(outDir, 'src', 'domain')),
    ruleFiles: Object.values(DEMO_RULE_FILES),
    precomputedStageId: precomputed.lastStageId,
    precomputedRows: precomputed.results[precomputed.lastStageId]?.ordered?.length ?? 0,
  };
}

// ⚠️ 必须按 realpath 比较（照抄 scripts/audit-scan.js 的同款修法，E166 同款病根）：
//    ① 经**软链**调用时，import.meta.url 是**软链指向的真实文件**，而 process.argv[1]
//       是**软链本身** ⇒ 裸字符串比较恒不等 ⇒ 脚本什么都不做、退出码 0
//       ⇒ CI 看到绿灯，实际构建根本没跑；deploy-demo-site.sh 只查产物**存在**，
//          于是**上周的旧演示站会被原样发布**。
//    ② macOS 的 /tmp → /private/tmp、/var → /private/var 都是符号链接，同一个道理。
//    对一道发布闸来说，「静默通过」是最坏的失败模式。
function realPathOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}
const isMain = process.argv[1]
  && realPathOrSelf(process.argv[1]) === realPathOrSelf(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? resolve(process.cwd(), args[outIdx + 1]) : join(here, '..', 'web', 'dist');
  try {
    const result = await buildDemoSite({ outDir });
    console.log(`[build-demo] 产物目录：${result.outDir}`);
    console.log(`[build-demo] 顶层条目：${result.files.join(', ')}`);
    console.log(`[build-demo] 领域层文件 ${result.domainFiles.length} 个，规则文件 ${result.ruleFiles.length} 个`);
    console.log(`[build-demo] ✅ 领域层浏览器安全检查通过`);
    console.log(`[build-demo] ✅ 构建期预计算完成：赛段 ${result.precomputedStageId}，排名 ${result.precomputedRows} 支队伍`);
  } catch (err) {
    console.error(`[build-demo] ✗ ${err.message}`);
    process.exit(1);
  }
}

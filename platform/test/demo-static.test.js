// platform/test/demo-static.test.js —— 演示版静态站（构建产物 / 相对路径 / 两个相对基准）
//
// 溯源需求：R-OPS-06（公网可访问：演示站静态产物 + 相对基准）｜R-OPS-01/07（零 npm 依赖 / 可移植）
//
// 依据：P6 计划 Task 6；计划开头的 Global Constraints「领域层约束」
//
// ⚠️ 本文件守三件事：
//   ① 产物目录是**自包含静态站**：根目录有 index.html，资源路径是相对路径
//      （静态托管可能挂在任意 base path 下，绝对路径会全挂）。
//   ② 领域层**浏览器安全**：不得 import Node 内置模块 / 裸模块名 ——
//      这条是 Global Constraints 的硬约束，由构建脚本在构建时强制校验（机器守住，不靠自觉）。
//   ③ **D5-13：两个相对基准必须同时满足** ——
//      种子 `SEED_URL = './seed/demo-data.json'` 相对 **web/**，
//      规则 `RULES_BASE = './rules/'` 相对 **platform/**（= 适配器的父目录），
//      两个基准不同 ⇒ 产物目录布局必须让两种解析方式都指得到文件。
//      ⇒ 解法：产物目录**镜像 platform/ 的结构**：
//        <out>/web/api.demo.js   ← 适配器（模块目录基准 = 源码里的 web/）
//        <out>/web/seed/…        ← 种子（SEED_URL 的来源基准）
//        <out>/rules/…           ← 规则（RULES_BASE 的来源基准 = 适配器的父目录）
//        <out>/src/domain/…      ← 领域层（适配器 '../src/domain/' 的落点，在产物内）
//        <out>/seed/…            ← 种子的第二份（浏览器 fetch() 相对**文档基准**取的那份）
//      下面的用例把这条**钉死**：改了布局（挪适配器 / 少拷一份）就会红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { buildDemoSite, assertDomainIsBrowserSafe, collectBrowserModules, loadNodeOnlyGlobals } from '../scripts/build-demo.js';
import { DEMO_RULE_FILES, SEED_URL, RULES_BASE } from '../web/api.demo.js';
import { loadRules } from '../src/config.js';
import { serveStatic } from '../src/http/static.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('构建产物是自包含静态站：根目录有 index.html，且没有绝对路径资源引用', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });
  assert.ok(existsSync(join(out, 'index.html')), '根目录必须有 index.html（静态托管的硬要求）');

  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)="\//, '⛔ 资源路径不能以 / 开头（换 base path 会全挂）');
  assert.match(html, /\.\/web\/app\.js/);
  assert.match(html, /\.\/web\/styles\.css/);

  rmSync(out, { recursive: true, force: true });
});

test('构建产物带上领域层与规则配置（浏览器里才跑得起来）', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });

  assert.ok(existsSync(join(out, 'src', 'domain', 'scoring.js')), '领域层必须拷进产物');
  assert.ok(existsSync(join(out, 'rules', 'scoring-final.json')), '规则配置必须拷进产物');
  assert.ok(existsSync(join(out, 'seed', 'demo-data.json')), '种子数据必须拷进产物');
  assert.ok(existsSync(join(out, 'web', 'api.demo.js')), '演示适配器必须在产物里');

  for (const file of Object.values(DEMO_RULE_FILES)) {
    assert.ok(existsSync(join(out, 'rules', file)), `规则文件 ${file} 必须拷进产物`);
  }

  rmSync(out, { recursive: true, force: true });
});

test('领域层不得 import 任何 Node 内置模块（否则浏览器跑不了）', () => {
  const domainDir = join(platformDir, 'src', 'domain');
  const violations = assertDomainIsBrowserSafe(domainDir);
  assert.deepEqual(violations, [], `领域层有 Node 依赖：${violations.join('；')}`);
});

test('守卫真的会拦下 Node 内置模块的导入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-dom-'));
  writeFileSync(join(dir, 'bad.js'), "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n", 'utf8');
  const violations = assertDomainIsBrowserSafe(dir);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes('node:fs'));
  assert.ok(violations[0].includes('Node 内置模块'), '必须说清是 Node 内置模块（换个说法也算违规，但排查的人会看不懂）');
  rmSync(dir, { recursive: true, force: true });
});

test('守卫也会拦下跨行的 Node 内置模块导入与裸模块名（格式化器会把 import 拆成多行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-dom-'));
  // ⚠️ 跨行 import：prettier 之类会把长的 import 列表拆成多行 ——
  //    只认单行的抽取器会漏掉它 ⇒ 守卫形同虚设 ⇒ 浏览器里才炸。
  writeFileSync(
    join(dir, 'multi.js'),
    "import {\n  readFileSync,\n  writeFileSync,\n} from 'node:fs';\nexport const x = readFileSync;\n",
    'utf8',
  );
  const multi = assertDomainIsBrowserSafe(dir);
  assert.equal(multi.length, 1, `跨行的 node:fs 必须被拦下：${JSON.stringify(multi)}`);
  assert.ok(multi[0].includes('node:fs'));
  assert.ok(multi[0].includes('Node 内置模块'), '必须说清是 Node 内置模块');

  const dir2 = mkdtempSync(join(tmpdir(), 'hks-dom-'));
  writeFileSync(join(dir2, 'bare.js'), "import { lodash } from 'lodash';\nexport const x = lodash;\n", 'utf8');
  const bare = assertDomainIsBrowserSafe(dir2);
  assert.equal(bare.length, 1, `裸模块名必须被拦下（浏览器没有 node_modules）：${JSON.stringify(bare)}`);
  assert.ok(bare[0].includes('lodash'));
  assert.ok(bare[0].includes('裸模块名'), '必须说清是裸模块名（浏览器没有 node_modules）');

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test('守卫也会拦下 Node 专属全局（Buffer / process / __dirname / __filename / require）', () => {
  // ⚠️ 这些符号**不需要 import**就能用 ⇒ 只查 import 说明符的守卫**一个都抓不到**。
  //    实测踩坑（P6 Task 8 台账 G-3）：P5 的 src/domain/icalendar.js 用了 Buffer.from(...)
  //    ⇒ import 零违规、构建闸放行、产物照发 ⇒ 浏览器里 ReferenceError ⇒ 演示站白屏。
  const cases = [
    { file: 'buf.js', code: 'export const b = Buffer.from("x", "utf8");\n', token: 'Buffer' },
    { file: 'proc.js', code: 'export const e = process.env.HOME;\n', token: 'process' },
    { file: 'dir.js', code: 'export const d = __dirname;\n', token: '__dirname' },
    { file: 'fname.js', code: 'export const f = __filename;\n', token: '__filename' },
    { file: 'req.js', code: 'const fs = require("node:fs");\nexport const x = fs;\n', token: 'require' },
  ];
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'hks-dom-'));
    writeFileSync(join(dir, c.file), c.code, 'utf8');
    const violations = assertDomainIsBrowserSafe(dir);
    assert.equal(violations.length, 1, `${c.token} 必须被拦下：${JSON.stringify(violations)}`);
    assert.ok(violations[0].includes(c.token), `违规说明里必须点名 ${c.token}：${violations[0]}`);
    assert.ok(violations[0].includes('Node 专属全局'), '必须说清是 Node 专属全局');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注释里提到 Node 专属全局不算违规（守卫不许冤杀构建）', () => {
  // ⚠️ 领域层的注释里经常写着「⛔ 不要用 Buffer」这类提醒 ——
  //    若守卫不剥注释，就会把**正确的注释**判成违规 ⇒ 构建被冤杀。
  const dir = mkdtempSync(join(tmpdir(), 'hks-dom-'));
  writeFileSync(
    join(dir, 'commented.js'),
    '// ⛔ 不得用 Buffer / process / __dirname / __filename / require\n' +
      '/* 这里提到 require 只是提醒 */\n' +
      'export const ok = 1;\n',
    'utf8',
  );
  const violations = assertDomainIsBrowserSafe(dir);
  assert.deepEqual(violations, [], `注释里的提醒不该被判违规：${violations.join('；')}`);
  rmSync(dir, { recursive: true, force: true });
});

test('Node 专属全局禁用清单缺失或为空 ⇒ 守卫必须报错，不许静默放行', () => {
  // ⚠️ 与 scripts/forbidden.txt 同一口径：**空清单 ≠ 已保护**。
  //    清单读不到就读不到，不许「读不到就当没有违规」⇒ 那等于把闸架空。
  const missing = join(tmpdir(), 'hks-node-globals-not-exist-xyz.txt');
  assert.throws(() => loadNodeOnlyGlobals(missing), /禁用清单不存在/, '清单缺失必须报错');
  assert.throws(() => loadNodeOnlyGlobals(missing), /拒绝构建/, '报错要说清是拒绝构建');

  const emptyFile = join(mkdtempSync(join(tmpdir(), 'hks-globals-')), 'empty.txt');
  writeFileSync(emptyFile, '# 只有注释，没有词条\n\n', 'utf8');
  assert.throws(() => loadNodeOnlyGlobals(emptyFile), /是空的/, '空清单必须报错');
  assert.throws(() => loadNodeOnlyGlobals(emptyFile), /空清单 ≠ 已保护/, '报错要说清空清单等于没保护');
  // ⚠️ 这个临时目录也要回收 —— macOS 上 $TMPDIR 会自动清，Linux 的 /tmp 不会
  //    （真机实测：2026-10-21 一次全量跑就在 /tmp 堆出 80+ 个 hks-* 目录）
  rmSync(dirname(emptyFile), { recursive: true, force: true });

  // 正常清单读得到 5 条，且包含两个 __ 前缀的
  const tokens = loadNodeOnlyGlobals();
  assert.ok(tokens.length >= 5, `清单至少 5 条，实际 ${tokens.length}`);
  assert.ok(tokens.includes('Buffer'), '清单必须含 Buffer');
  assert.ok(tokens.some((t) => t.endsWith('dirname')), '清单必须含 __dirname');
  assert.ok(tokens.every((t) => !t.startsWith('#') && t.trim() === t), '清单里不能有注释行或多余空白');
});

test('领域层之外的兄弟目录不得被当成领域层（目录边界按分隔符判，不按前缀判）', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-dom-'));
  const domainDir = join(root, 'domain');
  const siblingDir = join(root, 'domain-utils');
  mkdirSync(domainDir, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(domainDir, 'a.js'), "import { b } from './b.js';\nimport { c } from '../domain-utils/c.js';\nexport const a = b + c;\n", 'utf8');
  writeFileSync(join(domainDir, 'b.js'), 'export const b = 1;\n', 'utf8');
  writeFileSync(join(siblingDir, 'c.js'), 'export const c = 1;\n', 'utf8');

  const { domainFiles, extraFiles } = collectBrowserModules(domainDir);
  // ⚠️ 判别性要点：兄弟目录必须**被引用到**才测得出来 ——
  //    没被引用的兄弟目录压根不会进遍历，纯前缀比较与按分隔符比较结果一样（测不出差别）。
  assert.equal(domainFiles.length, 2, 'domain/ 下的两个文件都算领域层');
  assert.equal(extraFiles.length, 1, 'domain-utils/ 是兄弟目录，只能算「领域层之外」');
  assert.ok(extraFiles[0].endsWith(join('domain-utils', 'c.js')), '兄弟目录必须落在 extraFiles 里');

  rmSync(root, { recursive: true, force: true });
});

test('构建产物里不出现 data/ 与 node_modules/（不泄漏本机数据）', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });
  const rel = walk(out).map((f) => relative(out, f).split(sep).join('/'));
  assert.ok(!rel.some((f) => f.startsWith('data/')), '产物里不能有 data/');
  assert.ok(!rel.some((f) => f.includes('node_modules')), '产物里不能有 node_modules/');
  rmSync(out, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════
// D5-13：两个相对基准（相对 web/ 与相对 platform/）必须同时满足
// ══════════════════════════════════════════════════════════════════════

test('D5-13：产物布局让「模块目录基准」与「模块父目录基准」都指得到文件', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });

  // 产物里适配器的位置 ⇒ 三个基准
  const adapterDir = join(out, 'web');   // 模块目录基准（源码里 = web/）
  const siteRoot = out;                  // 模块父目录基准（源码里 = platform/）+ 文档基准（站点根）

  // ── 源码树里这两个基准本来就指得到文件（这里是「保持一致」的对照）──
  const seedRel = SEED_URL.replace(/^\.\//, '');                 // seed/demo-data.json
  assert.ok(existsSync(join(platformDir, 'web', seedRel)), '源码树里种子相对 web/');
  assert.ok(existsSync(join(platformDir, 'rules', 'scoring-final.json')), '源码树里规则相对 platform/');

  // ① 种子：SEED_URL 相对【模块目录】⇒ 产物里必须在 <out>/web/seed/
  assert.ok(
    existsSync(join(adapterDir, seedRel)),
    '种子必须在适配器目录下（SEED_URL 的来源基准 = 相对 web/）',
  );
  //    浏览器里 fetch() 相对【文档基准】（文档在站点根）⇒ 还必须在 <out>/seed/
  assert.ok(
    existsSync(join(siteRoot, seedRel)),
    '种子必须在站点根（浏览器按文档基准取到的就是这一份）',
  );

  // ② 规则：RULES_BASE 相对【模块父目录】（= 源码里的 platform/）⇒ 产物里必须在 <out>/rules/
  for (const file of Object.values(DEMO_RULE_FILES)) {
    const rel = (RULES_BASE + file).replace(/^\.\//, '');       // rules/xxx.json
    assert.ok(
      existsSync(join(siteRoot, rel)),
      `规则 ${file} 必须在站点根（= 适配器父目录，RULES_BASE 的来源基准）`,
    );
    assert.ok(
      !existsSync(join(adapterDir, rel)),
      `规则不在适配器目录下（源码树里 platform/web/rules/ 同样不存在 —— 基准集合必须保持一致）`,
    );
  }

  // ③ 领域层：适配器 import '../src/domain/*.js' ⇒ 相对适配器的**父目录**
  const domainTarget = resolve(adapterDir, '../src/domain/scoring.js');
  assert.ok(existsSync(domainTarget), '适配器的 ../src/domain/ 必须落在产物里');
  assert.ok(
    domainTarget.startsWith(out + sep),
    '领域层必须落在产物目录内（不能跑到站点外 —— 站点挂在子路径下就会 404 白屏）',
  );

  rmSync(out, { recursive: true, force: true });
});

test('D5-13：演示站在浏览器语义下真能起来（文档基准取种子与 12 份规则）', async () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  buildDemoSite({ outDir: out, platformDir });

  const originalFetch = globalThis.fetch;
  // ⚠️ 浏览器语义：相对 URL 相对**文档基准**解析（不是相对模块、也不是相对 cwd）
  const docBase = 'http://demo.local/index.html';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), docBase);
    const p = join(out, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    const body = readFileSync(p, 'utf8');
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };

  try {
    // 直接跑**产物里**的适配器（它 import 的是产物里的 dist/src/domain/*.js —— 真跑引擎）
    const mod = await import(pathToFileURL(join(out, 'web', 'api.demo.js')).href);
    const seed = await mod.loadDemoSeed(SEED_URL);
    const loaded = await mod.loadDemoRules(RULES_BASE);

    const platformSeed = JSON.parse(readFileSync(join(platformDir, 'web', 'seed', 'demo-data.json'), 'utf8'));
    assert.deepEqual(seed, platformSeed, '浏览器加载的种子必须与仓库里的是同一份');

    // 规则同源：浏览器加载的 12 份配置 ≡ 正式系统 loadRules() 的结果
    const { rules } = loadRules(join(platformDir, 'rules'));
    assert.deepEqual(loaded.scoring.initial, rules.scoring.initial);
    assert.deepEqual(loaded.scoring.final, rules.scoring.final);
    assert.deepEqual(loaded.tiebreak, rules.tiebreak);
    assert.deepEqual(loaded.ranks, rules.ranks);
    assert.deepEqual(loaded.behavior, rules.behavior);
    assert.deepEqual(loaded.visibility, rules.visibility);
    assert.deepEqual(loaded.registration, rules.registration);
    assert.deepEqual(loaded.solvability, rules.solvability);
    assert.deepEqual(loaded.milestones, rules.milestones);
    assert.deepEqual(loaded.teamFormation, rules.teamFormation);
    assert.deepEqual(loaded.points, rules.points);
    assert.deepEqual(loaded.criteria, rules.criteria);

    // 引擎真的跑起来（不是只把文件读出来）
    const runtime = await mod.getDemoRuntime();
    const health = await runtime.get('/api/health');
    assert.equal(health.ok, true, '演示运行时必须能起（引擎在浏览器里真跑）');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(out, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 可移植性：换一份拷贝也得能构建（不许偷偷用脚本所在目录的资源）
// ══════════════════════════════════════════════════════════════════════

test('构建必须以 platformDir 为准（换一份拷贝也能构建，不许用脚本所在目录的资源）', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-port-'));
  const copyRoot = join(root, 'platform');
  mkdirSync(copyRoot, { recursive: true });
  cpSync(join(platformDir, 'rules'), join(copyRoot, 'rules'), { recursive: true });
  cpSync(join(platformDir, 'src', 'domain'), join(copyRoot, 'src', 'domain'), { recursive: true });
  cpSync(join(platformDir, 'web'), join(copyRoot, 'web'), {
    recursive: true,
    filter: (src) => !src.includes(`${sep}dist${sep}`) && !src.endsWith(`${sep}dist`),
  });
  // 副本的入口页带一个标记：构建出来的入口页必须带它 ⇒ 证明用的是副本的资源
  const copyHtml = join(copyRoot, 'web', 'index.html');
  writeFileSync(copyHtml, readFileSync(copyHtml, 'utf8').replace('<title>', '<title>【副本】'), 'utf8');

  const out = join(root, 'dist');
  buildDemoSite({ outDir: out, platformDir: copyRoot });

  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('【副本】'), '必须用 platformDir 指定的资源构建（不许回落到脚本所在目录）');
  assert.ok(existsSync(join(out, 'src', 'domain', 'scoring.js')), '领域层必须来自 platformDir');
  assert.ok(existsSync(join(out, 'rules', 'scoring-final.json')), '规则必须来自 platformDir');

  rmSync(root, { recursive: true, force: true });
});

test('产物里不得夹带 macOS 的 AppleDouble 伴生文件（._xxx）', () => {
  // 真机实测（2026-10-21，8.133.200.235 / Debian 12 / ext4）：
  //   按 P6 计划 Step 4 的「跨平台复现」配方从 macOS 拷到 Linux 时，
  //   `tar` 会给每个文件配一个 `._xxx` 资源叉载体 —— 内容是二进制，不是真资源。
  //   ⇒ 混进静态站 = 把垃圾发给访客；混进领域层 = 浏览器里加载一个坏模块。
  const root = mkdtempSync(join(tmpdir(), 'hks-ad-'));
  const copyRoot = join(root, 'platform');
  mkdirSync(copyRoot, { recursive: true });
  cpSync(join(platformDir, 'rules'), join(copyRoot, 'rules'), { recursive: true });
  cpSync(join(platformDir, 'src', 'domain'), join(copyRoot, 'src', 'domain'), { recursive: true });
  cpSync(join(platformDir, 'web'), join(copyRoot, 'web'), {
    recursive: true,
    filter: (src) => !src.includes(`${sep}dist${sep}`) && !src.endsWith(`${sep}dist`),
  });

  // 造三个伴生文件：领域层、规则、web 下各一个
  const ad = Buffer.from([0x00, 0x05, 0x16, 0x07, 0xff, 0xfe]);
  writeFileSync(join(copyRoot, 'src', 'domain', '._scoring.js'), ad);
  writeFileSync(join(copyRoot, 'rules', '._scoring-final.json'), ad);
  writeFileSync(join(copyRoot, 'web', '._app.js'), ad);

  const out = join(root, 'dist');
  buildDemoSite({ outDir: out, platformDir: copyRoot });

  const leaked = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('._')) leaked.push(p);
    }
  };
  walk(out);
  assert.deepEqual(leaked, [], `产物里混进了伴生文件：${leaked.map((p) => relative(out, p)).join('、')}`);

  // 真正的资源必须在（别把「跳过」做成「漏拷」）
  assert.ok(existsSync(join(out, 'src', 'domain', 'scoring.js')), '真正的领域层文件必须在');
  assert.ok(existsSync(join(out, 'rules', 'scoring-final.json')), '真正的规则文件必须在');

  rmSync(root, { recursive: true, force: true });
});

test('构建前必须清空产物目录（陈旧文件不得混进产物）', () => {
  const out = mkdtempSync(join(tmpdir(), 'hks-dist-'));
  writeFileSync(join(out, 'stale.txt'), '上一版的残留\n', 'utf8');
  mkdirSync(join(out, 'old-dir'), { recursive: true });
  writeFileSync(join(out, 'old-dir', 'x.js'), 'export const x = 1;\n', 'utf8');

  buildDemoSite({ outDir: out, platformDir });

  assert.ok(!existsSync(join(out, 'stale.txt')), '陈旧文件必须被清掉（产物目录每次重建）');
  assert.ok(!existsSync(join(out, 'old-dir')), '陈旧目录必须被清掉（产物目录每次重建）');
  assert.ok(existsSync(join(out, 'index.html')), '入口页必须在');

  rmSync(out, { recursive: true, force: true });
});

test('产物目录落在 web/ 里面时也不能把自己拷进自己（--out 指向 web/ 内部）', () => {
  // ⚠️ 这是变异检验 M13 实跑炸出来的真缺陷：
  //    产物目录默认在 web/dist/，靠名字 'dist' 排除就够；
  //    但 --out 可以指向 web/ 里的**任何**目录 ⇒ 产物会把自己拷进自己 ⇒ 无限递归 ⇒ ENAMETOOLONG。
  const root = mkdtempSync(join(tmpdir(), 'hks-selfcopy-'));
  const webCopy = join(root, 'web');
  cpSync(join(platformDir, 'web'), webCopy, {
    recursive: true,
    filter: (src) => !src.endsWith(`${sep}dist`),
  });
  const inner = join(webCopy, 'inner-dist');
  try {
    buildDemoSite({ outDir: inner, platformDir, webDir: webCopy });
    assert.ok(existsSync(join(inner, 'index.html')), '构建必须成功');
    assert.ok(
      !existsSync(join(inner, 'web', 'inner-dist')),
      '产物不得把自己拷进自己（否则无限递归）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 站点挂在子路径下（静态托管不一定给根路径）
// ══════════════════════════════════════════════════════════════════════
test('产物挂在子路径下也不跑出站点（领域层 / 种子 / 规则都还在站点内）', async () => {
  const site = mkdtempSync(join(tmpdir(), 'hks-site-'));
  const dist = join(site, 'dist');
  buildDemoSite({ outDir: dist, platformDir });

  // 用仓库自己的静态服务器把 site/ 当根 ⇒ 站点实际挂在 /dist/ 下
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && serveStatic(site, req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    // 文档在 /dist/index.html ⇒ 文档基准 = /dist/
    const docUrl = `${origin}/dist/index.html`;
    const html = await (await fetch(docUrl)).text();
    assert.match(html, /\.\/web\/app\.js/, '入口页必须用相对路径引用 app.js');

    // 适配器在 /dist/web/api.demo.js ⇒ '../src/domain/' ⇒ /dist/src/domain/（仍在站点内）
    const domainUrl = new URL('../src/domain/scoring.js', `${origin}/dist/web/api.demo.js`);
    const domain = await fetch(domainUrl);
    assert.equal(domain.status, 200, '领域层必须留在站点内（子路径下不能 404 白屏）');

    // 文档基准取种子与规则：/dist/seed/… 与 /dist/rules/…
    for (const p of ['/dist/seed/demo-data.json', '/dist/rules/scoring-final.json']) {
      const res = await fetch(`${origin}${p}`);
      assert.equal(res.status, 200, `${p} 必须能在子路径下取到`);
    }
  } finally {
    server.close();
    rmSync(site, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 领域层与规则配置挂不挂出去 —— 生产部署口径（默认一律 404）
// ══════════════════════════════════════════════════════════════════════
async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * 起一个真实的 src/server.js 子进程（端口随机、数据目录在临时区）。
 * ⚠️ 轮询用的定时器必须**清干净**：残留的 setTimeout 会吊住事件循环
 *    ⇒ 测试文件跑完还要多等 20 秒才退出（变异检验会被拖慢一个数量级）。
 */
async function startServer(env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-demo-srv-'));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(platformDir, 'src', 'server.js')],
    {
      cwd: platformDir,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const ready = await waitForOutput(child, () => out, (text) => text.includes('启动于'));
  if (!ready) {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`服务没能启动：${out}`);
  }
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 等子进程输出里出现某段文字（定时器一律清干净，不留残余） */
function waitForOutput(child, read, match, timeoutMs = 20000) {
  return new Promise((resolvePromise) => {
    const timer = setInterval(() => {
      if (match(read())) { clearInterval(timer); clearTimeout(bail); resolvePromise(true); }
      if (child.exitCode !== null) { clearInterval(timer); clearTimeout(bail); resolvePromise(false); }
    }, 50);
    const bail = setTimeout(() => { clearInterval(timer); resolvePromise(false); }, timeoutMs);
    bail.unref?.();
  });
}

test('默认不挂载：/src/domain/* 与 /rules/* 一律 404（生产部署口径）', async () => {
  const srv = await startServer({ DEMO_MODE: '' });
  try {
    for (const p of ['/rules/scoring-final.json', '/src/domain/scoring.js']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 404, `${p} 默认必须 404（不设 DEMO_MODE=1 ⇒ 领域层源码与规则配置不外泄）`);
    }
  } finally {
    await srv.stop();
  }
});

test('DEMO_MODE=1 才挂载这两个白名单目录（开发服务器的演示模式）', async () => {
  const srv = await startServer({ DEMO_MODE: '1' });
  try {
    const rules = await fetch(`${srv.base}/rules/scoring-final.json`);
    assert.equal(rules.status, 200, 'DEMO_MODE=1 时规则配置必须挂出来（演示站要能起引擎）');
    const domain = await fetch(`${srv.base}/src/domain/scoring.js`);
    assert.equal(domain.status, 200, 'DEMO_MODE=1 时领域层必须挂出来（演示站要能起引擎）');
    // 白名单之外的一律不放行
    const other = await fetch(`${srv.base}/src/config.js`);
    assert.equal(other.status, 404, '只挂这两个白名单目录，不开放整个 platform/');
  } finally {
    await srv.stop();
  }
});

// ══════════════════════════════════════════════════════════════════════
// 演示版横幅（?demo=1）
// ══════════════════════════════════════════════════════════════════════

/** 最小 DOM 桩：支持 app.prepend（横幅要插到最前面）与 replaceChildren */
function installDom(search) {
  const app = {
    children: [],
    innerHTML: '',
    replaceChildren(el) { this.children = [el]; },
    prepend(el) { this.children.unshift(el); },
  };
  const fakeEl = () => ({
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    querySelector: () => ({ addEventListener: () => {}, textContent: '', value: '' }),
    addEventListener: () => {},
    replaceChildren: () => {},
  });
  globalThis.window = { location: { search, hash: '' }, addEventListener: () => {} };
  globalThis.document = { getElementById: () => app, createElement: () => fakeEl() };
  return app;
}

test('演示版横幅：?demo=1 才渲染，正式版不渲染', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  // 浏览器语义 + 开发服务器布局：web/ 在 /，规则配置挂在 /rules/
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    const url = new URL(String(input), 'http://127.0.0.1:8080/');
    const p = url.pathname.startsWith('/rules/')
      ? join(platformDir, 'rules', url.pathname.slice('/rules/'.length))
      : join(platformDir, 'web', url.pathname.replace(/^\/+/, ''));
    if (!existsSync(p)) return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
    const body = readFileSync(p, 'utf8');
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
  try {
    const app = installDom('?demo=1');
    await import('../web/app.js?v=demo-banner');
    await new Promise((r) => setTimeout(r, 50));
    const banner = app.children[0];
    assert.ok(banner, '演示版必须渲染出横幅');
    assert.match(String(banner.className), /demo-banner/, '横幅必须带 demo-banner 样式类');
    assert.match(String(banner.innerHTML), /演示版/, '横幅必须说明这是演示版');
    assert.match(String(banner.innerHTML), /规则引擎/, '横幅必须说明规则引擎在浏览器里真实运行');
    // ⚠️ 演示模式必须真的走**演示适配器**（去取种子与规则），不是真实 API
    assert.ok(
      requested.some((u) => u.includes('seed/demo-data.json')),
      `演示模式必须取演示种子（实际请求：${JSON.stringify(requested)}）`,
    );
    assert.ok(
      requested.some((u) => u.includes('rules/')),
      `演示模式必须取演示规则（实际请求：${JSON.stringify(requested)}）`,
    );

    // 正式版：同样的 DOM 桩，不带 ?demo=1 ⇒ 没有横幅
    const app2 = installDom('');
    await import('../web/app.js?v=no-demo-banner');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      !app2.children.some((el) => String(el.className).includes('demo-banner')),
      '正式版不得出现演示版横幅',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('默认产物目录必须是 platform/web/dist（唯一口径 —— F-1 裁决）', () => {
  const result = buildDemoSite({ platformDir });
  assert.equal(
    resolve(result.outDir),
    resolve(join(platformDir, 'web', 'dist')),
    '默认产物目录必须是 platform/web/dist（唯一口径）',
  );
  assert.ok(existsSync(join(platformDir, 'web', 'dist', 'index.html')), '产物根必须有 index.html');
});

test('本地预览服务器（scripts/serve-demo.js）真的在 serve 产物目录', async () => {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(platformDir, 'scripts', 'serve-demo.js')],
    { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    const ready = await waitForOutput(child, () => out, (text) => text.includes('演示站本地预览'));
    assert.ok(ready, `预览服务器必须能启动（子进程输出：${out}）`);

    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /\.\/web\/app\.js/, '预览的必须是产物目录里的入口页');
    assert.equal((await fetch(`${base}/src/domain/scoring.js`)).status, 200, '领域层必须能直接被浏览器 import');
    assert.equal((await fetch(`${base}/rules/scoring-final.json`)).status, 200, '规则配置必须能取到');
    assert.equal((await fetch(`${base}/seed/demo-data.json`)).status, 200, '演示种子必须能取到');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// ══════════════════════════════════════════════════════════════════════
// 登记：脚本与忽略规则（机器守住，不靠自觉）
// ══════════════════════════════════════════════════════════════════════

test('规则配置缺失时构建必须失败（绝不静默少一个 —— 演示站会起不了引擎）', () => {
  const root = mkdtempSync(join(tmpdir(), 'hks-rules-'));
  const partial = join(root, 'rules');
  mkdirSync(partial, { recursive: true });
  // 只拷一部分规则 ⇒ 必须报错
  for (const file of Object.values(DEMO_RULE_FILES).slice(0, 3)) {
    copyFileSync(join(platformDir, 'rules', file), join(partial, file));
  }
  const out = join(root, 'dist');
  assert.throws(
    () => buildDemoSite({ outDir: out, platformDir, rulesDir: partial }),
    (err) => {
      assert.match(err.message, /规则配置缺失/, `必须说清是规则配置缺失：${err.message}`);
      return true;
    },
    '规则缺一个就必须构建失败（不能产出一个起不了引擎的演示站）',
  );
  rmSync(root, { recursive: true, force: true });
});

test('package.json 必须登记 P6 的脚本，.gitignore 必须忽略产物目录', () => {
  const pkg = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'));
  for (const s of ['backup', 'restore', 'build:demo', 'serve:demo', 'audit']) {
    assert.ok(pkg.scripts?.[s], `package.json 缺脚本：${s}`);
  }
  const ignore = readFileSync(join(platformDir, '..', '.gitignore'), 'utf8');
  assert.ok(
    /^platform\/web\/dist\/$/m.test(ignore),
    '.gitignore 必须有独立成行的 platform/web/dist/（产物不入库）',
  );
});

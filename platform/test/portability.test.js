// platform/test/portability.test.js —— P6 Task 8：跨平台可移植性验收（静态可判定部分）
//
// ⚠️ **诚实性声明（先读这段再引用本文件）**：
//   本机是 **macOS（darwin arm64）**。**Linux / ext4 与 Windows 本轮没有跑过**。
//   ⇒ 本文件断言的全部是**「代码里能静态判定的可移植性事实」**，
//      **不是**「在 Windows 上验证过」这种没做过的断言。
//   真正把 platform/ 拷到另一台机器上跑 migrate / test / build-demo 三条命令
//   （P6 验收标准 P6-13 的**实机部分**）**本轮未覆盖**，理由见 P6 Task 8 台账「未覆盖清单」。
//   同理，真机（Linux + systemd + nginx + root）完整执行 deploy/install.sh 也**未实跑**
//   （见 docs/deployment.md §13 U-3）。
//
// 溯源需求（逐条标在用例上）：
//   R-OPS-01 可移植：不能依赖联网 npm install 或原生编译；换台机器就能跑
//   R-OPS-02 跨平台稳定：组员 Mac/Windows、云主机 Linux 上跑同一份代码
//   R-OPS-07 零 npm 依赖：后端只用 Node 标准库；前端无构建步骤
//
// P6 验收标准的对应关系（**只认静态可判定的那部分**）：
//   P6-13「全链路 + 跨平台」→ 本文件覆盖的是它的**静态可移植性部分**
//        （零依赖 / 无构建 / 路径与行尾一致 / 无平台分支 / 迁移编号唯一 / 版本下限自洽）。
//        它的**实机部分**（拷到另一台机器跑三条命令）本轮未覆盖。
//   P6-12「公网演示 URL 可访问」→ 本文件不涉及（P6-12 要等真机发布后人工验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDomainIsBrowserSafe } from '../scripts/build-demo.js';
import { stripComments } from '../test-helpers/strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const repoRoot = join(platformDir, '..');

/** 会被扫到的文本文件后缀（源码 / 配置 / 规则 / 脚本 / 文档）。 */
const TEXT_EXT = new Set([
  '.js', '.json', '.sh', '.sql', '.md', '.yml', '.yaml', '.conf', '.service', '.txt', '.html', '.css',
]);

/** 源码目录（只扫这三个：运行时代码 + 脚本 + 前端）。 */
const CODE_DIRS = ['src', 'scripts', 'web'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 相对仓库根的文件路径（报错信息里用，跨平台统一用 '/' 分隔）。 */
function relOf(file) {
  return relative(repoRoot, file).split(sep).join('/');
}

/** 抽出源码里的 import 说明符（静态 import / export from / 动态 import / require）。 */
function importSpecifiers(code) {
  const text = stripComments(code, { blankRegex: true });
  const specs = [];
  const re1 = /(?:^|[\n;])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const re2 = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  const re3 = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const re4 = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [re1, re2, re3, re4]) {
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** 一行号 → 文本行（1 基）。 */
function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. 零 npm 依赖（零构建 / 零原生编译）
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-01/07：零 npm 依赖 —— 没有 node_modules / 锁文件 / dependencies', () => {
  assert.equal(existsSync(join(platformDir, 'node_modules')), false, 'platform/ 下不允许有 node_modules');
  assert.equal(existsSync(join(platformDir, 'package-lock.json')), false);
  assert.equal(existsSync(join(platformDir, 'npm-shrinkwrap.json')), false);
  assert.equal(existsSync(join(platformDir, 'yarn.lock')), false);
  assert.equal(existsSync(join(platformDir, 'pnpm-lock.yaml')), false);
  assert.equal(existsSync(join(repoRoot, 'node_modules')), false, '仓库根下也不允许有 node_modules');

  const pkg = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '禁止新增 dependencies');
  assert.equal(pkg.devDependencies, undefined, '禁止新增 devDependencies');
  assert.equal(pkg.peerDependencies, undefined, '禁止新增 peerDependencies');
  assert.equal(pkg.optionalDependencies, undefined, '禁止新增 optionalDependencies');
  assert.equal(pkg.type, 'module', '必须是 ESM（"type": "module"）');
});

test('R-OPS-01/07：零构建、零原生编译（无 gyp / .node / 安装期脚本）', () => {
  const offenders = [];
  for (const f of walk(platformDir)) {
    const base = f.split(sep).pop();
    if (base === 'binding.gyp' || base.endsWith('.node')) offenders.push(relOf(f));
  }
  assert.deepEqual(offenders, [], `不允许出现原生编译产物/描述：${offenders.join('、')}`);

  const pkg = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'));
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    assert.equal(pkg.scripts?.[hook], undefined, `package.json 不得有安装期脚本 ${hook}（会触发联网/本地构建）`);
  }
  // 「无构建步骤」：前端产物由 node scripts/build-demo.js 直接产出（纯拷贝 + 拼字符串），
  // 没有任何打包器配置（webpack / vite / rollup / esbuild …）。
  for (const name of ['webpack.config.js', 'vite.config.js', 'rollup.config.js', 'esbuild.config.js', 'tsconfig.json']) {
    assert.equal(existsSync(join(platformDir, name)), false, `不允许出现构建配置 ${name}（本项目零构建）`);
  }
});

test('R-OPS-01：源码只 import Node 内置模块与相对路径（无第三方、无绝对路径 import）', () => {
  const violations = [];
  const absolutes = [];
  for (const dir of CODE_DIRS) {
    for (const f of walk(join(platformDir, dir))) {
      if (!f.endsWith('.js')) continue;
      const code = readFileSync(f, 'utf8');
      for (const spec of importSpecifiers(code)) {
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) continue;
        if (spec.startsWith('/')) {
          absolutes.push(`${relOf(f)} → ${spec}`);
          continue;
        }
        violations.push(`${relOf(f)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `发现第三方依赖：${violations.join('、')}`);
  assert.deepEqual(absolutes, [], `发现绝对路径 import：${absolutes.join('、')}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 领域层：浏览器同构前提（P6 Task 5 的硬约束）
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-01/02：领域层不 import 任何 Node 内置模块（浏览器里跑同一套引擎的前提）', () => {
  const violations = assertDomainIsBrowserSafe(join(platformDir, 'src', 'domain'));
  assert.deepEqual(violations, [], violations.join('；'));
});

test('R-OPS-01/02：领域层是纯函数 —— 不读时钟、不用随机数（剥掉注释后扫）', () => {
  const domainDir = join(platformDir, 'src', 'domain');
  const offenders = [];
  for (const name of readdirSync(domainDir).filter((n) => n.endsWith('.js'))) {
    const raw = readFileSync(join(domainDir, name), 'utf8');
    // ⚠️ 必须先剥注释：领域层每个文件的头注释都写着「无 Date.now() / Math.random()」，
    //    不剥就会把**声明**当成**使用**（仓库里的既有约定，见 test-helpers/strip-comments.js）。
    const code = stripComments(raw);
    if (/Date\.now\s*\(\s*\)/.test(code)) offenders.push(`${name}: Date.now()`);
    if (/Math\.random\s*\(\s*\)/.test(code)) offenders.push(`${name}: Math.random()`);
    if (/new\s+Date\s*\(\s*\)/.test(code)) offenders.push(`${name}: new Date()（不传参 = 读当前时钟）`);
    if (/\bprocess\./.test(code)) offenders.push(`${name}: process.*（领域层没有进程概念）`);
  }
  assert.deepEqual(offenders, [], `领域层必须是纯函数（时间与随机数一律由参数传入）：${offenders.join('、')}`);
});

/**
 * 领域层不得使用 **Node 专属全局**。
 *
 * ⚠️ 为什么这条必须单独有（`assertDomainIsBrowserSafe` 抓不到）：
 *   `scripts/build-demo.js` 的浏览器安全守卫**只看 import 说明符**
 *   （node: 前缀 ⇒ 违规；裸模块名 ⇒ 违规；相对导入指不到文件 ⇒ 违规）。
 *   而 `Buffer` / `process` / `__dirname` / `__filename` / `require` 是
 *   **不 import 就能用**的全局量 ⇒ 守卫一个都抓不到。
 *   而 build-demo.js 会把**整个** `src/domain/` 目录**原样拷进浏览器产物**
 *   （<out>/src/domain/*.js）⇒ 领域层里出现一个 `Buffer.from(...)`
 *   就等于演示站一跑就 `ReferenceError: Buffer is not defined`。
 *   （这个缺口已登记在 P6 Task 8 台账 G-2：**守卫本身**要不要补，由上游处置。）
 *
 * ⚠️ 为什么先剥注释：领域层每个文件的头注释都写着「无 Date.now() / Math.random()」，
 *   注释里提到某个 token ≠ 代码里用了它（否则合法注释会造成假红）。
 *   `stripComments` 保持行号不变 ⇒ 报错能定位到**行**。
 */
test('R-OPS-01/02：领域层不得使用 Node 专属全局（Buffer / process / __dirname / __filename / require）', () => {
  const domainDir = join(platformDir, 'src', 'domain');
  const offenders = [];
  for (const name of readdirSync(domainDir).filter((n) => n.endsWith('.js')).sort()) {
    const raw = readFileSync(join(domainDir, name), 'utf8');
    const code = stripComments(raw, { blankRegex: true });
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const hits = [];
      if (/\bBuffer\b/.test(line)) hits.push('Buffer');
      if (/\bprocess\s*\./.test(line)) hits.push('process.');
      if (/\b__dirname\b/.test(line)) hits.push('__dirname');
      if (/\b__filename\b/.test(line)) hits.push('__filename');
      if (/\brequire\s*\(/.test(line)) hits.push('require(');
      for (const token of hits) offenders.push(`src/domain/${name}:${i + 1} 用了 ${token}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `领域层不得使用 Node 专属全局（浏览器里不存在 ⇒ 演示站直接白屏）：${offenders.join('、')}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 3. 路径与平台假设
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-02：路径一律用 node:path 拼 —— 无字符串拼接路径、无 __dirname/__filename', () => {
  const offenders = [];
  for (const dir of CODE_DIRS) {
    for (const f of walk(join(platformDir, dir))) {
      if (!f.endsWith('.js')) continue;
      const raw = readFileSync(f, 'utf8');
      const code = stripComments(raw, { blankRegex: true });
      // ① 字符串字面量拼路径：'…' + '/' + x / x + '\\' + '…'
      if (/['"]\s*\+\s*[A-Za-z_$]/.test(code) && /['"]\s*\+\s*['"]\s*[\\/]/.test(code)) {
        offenders.push(`${relOf(f)}: 字符串字面量拼路径`);
      }
      if (/\+\s*['"][\\/]/.test(code) || /['"][\\/]['"]\s*\+/.test(code)) {
        offenders.push(`${relOf(f)}: 用 '/' 或 '\\\\' 拼路径（应改用 node:path）`);
      }
      // ② ESM 里没有 __dirname / __filename（用了就是 ReferenceError）
      if (/\b__dirname\b|\b__filename\b/.test(code)) {
        offenders.push(`${relOf(f)}: 用了 __dirname/__filename（ESM 没有这两个全局量）`);
      }
      // ③ 用了 node:path 的函数，就必须真的 import 自 node:path
      const usesPathHelper = /(^|[^.\w])(join|resolve|dirname|basename|relative|extname|isAbsolute)\s*\(/.test(code);
      if (usesPathHelper && !/from\s*['"]node:path['"]/.test(code)) {
        offenders.push(`${relOf(f)}: 用了路径函数但没 import node:path`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('；'));
});

test('R-OPS-02：没有平台分支（process.platform / os.platform 只允许出现在有注释的降级处）', () => {
  const PATTERN = /process\.(platform|arch)\b|\bos\.(platform|type|release)\s*\(/g;
  const PLATFORM_WORDS = ['linux', 'Linux', 'win32', 'Windows', 'darwin', 'macOS'];
  const runtimeOffenders = [];
  const uncommented = [];

  for (const dir of CODE_DIRS) {
    for (const f of walk(join(platformDir, dir))) {
      if (!f.endsWith('.js')) continue;
      const raw = readFileSync(f, 'utf8');
      const code = stripComments(raw, { blankRegex: true });
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        PATTERN.lastIndex = 0;
        if (!PATTERN.test(lines[i])) continue;
        const rel = relOf(f);
        // 运行时（src/ + web/）不许有平台分支；scripts/ 只允许「有注释的降级」
        if (dir !== 'scripts') {
          runtimeOffenders.push(`${rel}:${i + 1} ${lines[i].trim()}`);
          continue;
        }
        // 降级必须在附近有注释说明（允许：Linux 上再兜底 systemd / Windows 上跳过 …）
        const window = raw.split('\n').slice(Math.max(0, i - 20), i + 5).join('\n');
        if (!PLATFORM_WORDS.some((w) => window.includes(w))) {
          uncommented.push(`${rel}:${i + 1} ${lines[i].trim()}`);
        }
      }
    }
  }
  assert.deepEqual(runtimeOffenders, [], `运行时代码不得有平台分支：${runtimeOffenders.join('、')}`);
  assert.deepEqual(uncommented, [], `脚本里的平台分支必须有注释说明降级理由：${uncommented.join('、')}`);
});

test('R-OPS-01：仓库里没有写死的本机绝对路径（换台机器就能跑）', () => {
  // ⚠️ 扫描范围**不含 test/ 与 test-helpers/**：
  //    测试文件里合法地存在这些字符串（负例夹具、守卫自身的匹配模式），
  //    扫它们会自我误报。要发布的是运行时代码与部署资产 —— 那才是「换台机器要能跑」的东西。
  const files = walk(platformDir).filter((f) => {
    const rel = relOf(f);
    if (rel.startsWith('platform/test/') || rel.startsWith('platform/test-helpers/')) return false;
    return /\.(js|json|sh|md|yml|yaml|service|conf|txt|sql)$/.test(f);
  });
  const offenders = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    // Windows 盘符必须带词边界（'C:\\dir' 命中；'PORT:\\s*' 这种正则片段不命中）
    if (code.includes('/Users/') || code.includes('/Volumes/') || /\b[A-Za-z]:[\\/]/.test(code)) {
      offenders.push(relOf(f));
    }
  }
  assert.deepEqual(offenders, [], `这些文件里写死了本机路径：${offenders.join('、')}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. 换行符 / 编码（跨平台一致）
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-02：仓库里的文本资产统一 LF、无 BOM、合法 UTF-8', () => {
  const crlf = [];
  const bom = [];
  const badUtf8 = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (const f of walk(platformDir)) {
    const ext = f.slice(f.lastIndexOf('.'));
    if (!TEXT_EXT.has(ext)) continue;
    const buf = readFileSync(f);
    if (buf.includes(0x0d)) crlf.push(relOf(f));
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom.push(relOf(f));
    try {
      decoder.decode(buf);
    } catch {
      badUtf8.push(relOf(f));
    }
  }

  assert.deepEqual(crlf, [], `这些文件含 CR（CRLF）—— Windows 签出后 shell 脚本会挂：${crlf.join('、')}`);
  assert.deepEqual(bom, [], `这些文件带 UTF-8 BOM —— JSON.parse 会直接抛错：${bom.join('、')}`);
  assert.deepEqual(badUtf8, [], `这些文件不是合法 UTF-8：${badUtf8.join('、')}`);
});

test('R-OPS-02：iCal（若已实现）必须显式用 CRLF 行尾；本分支尚未实现 ⇒ 该要求归 P5 Task 5', () => {
  const sources = [];
  for (const dir of CODE_DIRS) {
    for (const f of walk(join(platformDir, dir))) {
      if (!f.endsWith('.js')) continue;
      const code = readFileSync(f, 'utf8');
      if (code.includes('VCALENDAR') || code.includes('BEGIN:VEVENT')) sources.push(f);
    }
  }
  if (sources.length === 0) {
    // 本分支（feat/p6-e2e，从 main 切出）**没有** iCal 导出实现 ——
    // 那是 P5 Task 5（feat/p5-pools 分支）的产物，还没进 main。
    // ⇒ 这一条在这里**不假装已验**；等 iCal 落地后，本用例会自动开始检查 CRLF。
    assert.ok(true, '本分支无 iCal 实现（CRLF 行尾要求归 P5 Task 5，未覆盖）');
    return;
  }
  const offenders = [];
  for (const f of sources) {
    const code = readFileSync(f, 'utf8');
    // iCal 规范要求 CRLF 行尾：生成器必须显式写 \r\n
    if (!/\\r\\n/.test(code)) offenders.push(relOf(f));
  }
  assert.deepEqual(offenders, [], `iCal 生成器必须显式用 CRLF（\\r\\n）：${offenders.join('、')}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. 迁移编号唯一（与 `ls db/migrations | cut -d_ -f1 | sort | uniq -d` 为空等价）
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-01：迁移编号唯一且连续（001–006 不得重号）', () => {
  const dir = join(platformDir, 'db', 'migrations');
  const names = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  assert.ok(names.length > 0, '迁移目录不能是空的');

  const versions = names.map((n) => {
    const m = n.match(/^(\d+)_/);
    assert.ok(m, `迁移文件名必须以「版本号_」开头：${n}`);
    return Number(m[1]);
  });
  const dup = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual([...new Set(dup)], [], `迁移版本号重号了：${[...new Set(dup)].join('、')}`);

  // 连续：从 1 开始、逐个 +1（跳号会让「按版本排序执行」的语义失真）
  const sorted = [...versions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    assert.equal(sorted[i], i + 1, `迁移版本号必须从 1 开始连续（实际：${sorted.join('、')}）`);
  }
  // 编号与文件名里的版本号必须一致（人读的编号 = 执行的序号）
  for (const n of names) {
    const num = Number(n.match(/^(\d+)_/)[1]);
    assert.equal(String(num).padStart(3, '0'), n.match(/^(\d+)_/)[1], `迁移文件名里的编号必须补零到三位：${n}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 6. 运行时下限自洽（engines.node 与实际用到的 API 一致）
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-01：engines.node 下限与实际用到的 API 一致（不用 Node-24-only API）', () => {
  const pkg = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, '>=22.16.0', '运行时下限必须是 >=22.16.0（node:sqlite 的 backup() API 就是 22.16.0 引入的）');

  const declared = pkg.engines.node.replace(/^[>=\s]*/, '').trim();
  const [major, minor, patch] = declared.split('.').map(Number);

  // 实际用到的、**有版本门槛**的 Node 能力（门槛来自 Node 官方版本历史）
  const REQUIRED = [
    { feature: 'node:sqlite', since: [22, 5, 0], why: 'node:sqlite 自 22.5.0 引入（22.13.0 起不再需要实验标志）' },
    { feature: 'sqlite.backup()', since: [22, 16, 0], why: '备份脚本依赖的一致性备份 API，22.16.0 引入' },
  ];
  for (const req of REQUIRED) {
    const ok = major > req.since[0]
      || (major === req.since[0] && (minor > req.since[1]
        || (minor === req.since[1] && patch >= req.since[2])));
    assert.ok(ok, `声明的下限 ${declared} 低于实际用到的 ${req.feature}（需要 ≥ ${req.since.join('.')}：${req.why}）`);
  }

  // ⛔ URLPattern 是 Node 24 才有的（router.js 的注释里写着这条纪律）——
  //    用它就会抬高运行时门槛 = 破坏「零依赖可移植」。
  const offenders = [];
  for (const dir of CODE_DIRS) {
    for (const f of walk(join(platformDir, dir))) {
      if (!f.endsWith('.js')) continue;
      const code = stripComments(readFileSync(f, 'utf8'), { blankRegex: true });
      if (/\bURLPattern\b/.test(code)) offenders.push(relOf(f));
    }
  }
  assert.deepEqual(offenders, [], `URLPattern 是 Node-24-only，Node 22 上不存在：${offenders.join('、')}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 7. 部署资产的跨平台纪律
// ═══════════════════════════════════════════════════════════════════════

test('R-OPS-05：shell 脚本都 set -euo pipefail，install.sh 用脚本自身位置定位', () => {
  const scripts = walk(platformDir).filter((f) => f.endsWith('.sh'));
  assert.ok(scripts.length > 0, '至少要有一个 shell 脚本');
  for (const f of scripts) {
    const code = readFileSync(f, 'utf8');
    assert.match(code, /^set -euo pipefail$/m, `${relOf(f)} 缺 set -euo pipefail`);
    // 解释器必须是 /usr/bin/env bash（不是 /bin/sh —— dash 的语法子集更窄）
    assert.match(code, /^#!\/usr\/bin\/env bash$/m, `${relOf(f)} 的解释器必须是 #!/usr/bin/env bash`);
  }
  const install = readFileSync(join(platformDir, 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /\$\(cd "\$\(dirname "\$0"\)" && pwd\)/, 'install.sh 必须用脚本自身位置定位');
});

test('R-OPS-05：部署资产里没有硬编码口令', () => {
  for (const name of ['install.sh', 'heikesong.service', 'nginx.conf', 'docker-compose.yml']) {
    const code = readFileSync(join(platformDir, 'deploy', name), 'utf8');
    assert.doesNotMatch(code, /PASSWORD\s*=\s*["'][^"'$]/, `${name} 里出现了硬编码口令`);
    assert.doesNotMatch(code, /password\s*[:=]\s*["'][^"'$]/i, `${name} 里出现了硬编码口令`);
  }
  // 管理员口令必须来自环境变量或交互输入，**不得有兜底默认值**：
  //   ① `ADMIN_PASSWORD:-<字面量>` = shell 兜底默认值（空默认值 ${ADMIN_PASSWORD:-} 是「交互读取」，允许）
  //   ② `ADMIN_PASSWORD="<字面量>"`  = 写死的口令（透传变量 `$password` 不算）
  const install = readFileSync(join(platformDir, 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /ADMIN_PASSWORD/, 'install.sh 必须从环境变量读 ADMIN_PASSWORD');
  assert.doesNotMatch(install, /ADMIN_PASSWORD:-[^}\s]/, 'install.sh 不得给 ADMIN_PASSWORD 兜底默认值');
  assert.doesNotMatch(
    install, /ADMIN_PASSWORD\s*=\s*["'](?!\$\{)[^"'$]+["']/,
    'install.sh 不得把管理员口令写成字面量',
  );
});

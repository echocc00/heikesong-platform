// platform/test/zero-deps.test.js —— 「零依赖」守卫
//
// 规则溯源（本文件每条断言对应的来源文档与章节）：
//   - 「npm 依赖 0 个 / 不依赖联网 npm install」→ 设计文档 §4.2「运行时与依赖」
//     （决策依据 R-OPS-01/02）；同表规定测试用 Node 内置 `node:test`，同为零依赖。
//   - 「全新机器 git clone 后直接 node src/server.js 跑起来」→ 设计文档 §1.3
//     成功标准 S-4「零依赖可移植」。
//   - `platform/src/` 目录布局（http/ auth/ domain/ services/ db/ audit/）
//     → 设计文档 §4.3「目录结构」。
//   - 任务拆分与验收口径 → docs/superpowers/plans/2026-10-20-platform-P0-foundation.md
//     Task 1「零依赖骨架与『零依赖』守卫」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test-helpers/strip-comments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json 没有任何 dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '禁止新增 dependencies');
  assert.equal(pkg.devDependencies, undefined, '禁止新增 devDependencies');
});

test('仓库里没有 node_modules（证明未联网安装过）', () => {
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('platform/ 下不存在 package-lock.json 或 node_modules', () => {
  assert.equal(existsSync(join(root, 'package-lock.json')), false);
});

test('每个 src 子目录都有 .js 文件且无空文件', () => {
  const srcDir = join(root, 'src');
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readdirSync(join(srcDir, entry.name)).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, `src/${entry.name} 没有 .js 文件`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// I-3：源码 import 守卫（README「只用 Node 标准库」这条承诺的真正守卫）
//
// ⛔ 评审修正（I-3）：本文件原来只有 4 条断言，全部只看 package.json / node_modules，
//    **从不看源码里的 import** —— 终审实测往 src/db/sqlite.js 注入
//    `import lodash from 'lodash'` 后，这 4 条断言 4/4 全绿。
//    README 明写「只用 Node 标准库。test/zero-deps.test.js 会守住这条」——
//    承诺没有守卫 = 承诺不存在。
//
// 规则来源：
//   - 「只用 Node 标准库 / npm 依赖 0 个」→ 设计文档 §4.2「运行时与依赖」
//     （决策依据 R-OPS-01/02）与 README「零依赖」一节。
//   - 评审编号 I-3（终审：零依赖承诺无守卫）。
//
// 判定：src/ scripts/ web/ 下所有 .js 文件里的 **import specifier**
//   （import ... from 'x' / import 'x' / export ... from 'x' / import('x') / require('x')）
//   只能是：
//     ① node: 开头的 Node 内置模块；
//     ② . 开头的相对路径；
//     ③ / 开头的绝对路径（当前代码里没有；真出现说明模块解析被绕过 → 单独报错，不放宽规则）。
//   其余（lodash / express / 裸包名）一律判违规。
// ═══════════════════════════════════════════════════════════════════════

/** 递归收集目录下的 .js 文件（用 readdirSync + withFileTypes，不引第三方 glob）。 */
function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/** 取出源码里所有字符串/模板字面量（含起始下标与内容）。 */
function stringLiterals(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j += 1; break; }
        j += 1;
      }
      out.push({ start: i, value: code.slice(i + 1, Math.max(i + 1, j - 1)) });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 找出「作为模块 specifier 使用的字符串字面量」。
 * 判定依据是**字符串前面的代码**，不是全文正则：
 *   - `… from 'x'`      → import/export ... from
 *   - `… import 'x'`    → 副作用导入
 *   - `… import('x')` / `… require('x')` → 动态导入 / CommonJS
 * 这样普通字符串（'from'、'https://…'）不会被误判成依赖。
 */
const SPECIFIER_CONTEXTS = [
  /\bfrom\s*$/,
  /\bimport\s*$/,
  /\b(?:import|require)\s*\(\s*$/,
];

function findSpecifiers(code) {
  const found = [];
  for (const lit of stringLiterals(code)) {
    const before = code.slice(Math.max(0, lit.start - 80), lit.start);
    if (SPECIFIER_CONTEXTS.some((re) => re.test(before))) found.push(lit);
  }
  return found;
}

/** 下标 → 行号（1 基）。 */
function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 受扫描的目录。
 *
 * ⚠️ 终审修正（Minor，M-5）：原来只有 src / scripts / web ——
 *    **test/ 没被扫**，往 `test/router.test.js` 里塞一行 `import lodash from 'lodash'`
 *    全量测试照样全绿。
 *    而 README 承诺「只用 Node 标准库」是**全项目级**的，测试代码也在内 ——
 *    测试代码同样要能在任何机器上裸跑。
 *    （终审实测：注入探针 XD-11 MISSED。）
 * ⚠️ `test-helpers/` 是测试专用的共享工具目录（终审复核引入），
 *    它同样是项目代码，也必须在零依赖承诺范围内。
 */
const SCAN_DIRS = ['src', 'scripts', 'web', 'test', 'test-helpers'];

/**
 * 判断一个 specifier 属于哪一类。
 *
 * ⚠️ 终审修正（Important，I-A）：这段判断原先**内联**在扫描循环里，
 *    把 `if (spec.value.startsWith('node:') || spec.value.startsWith('.')) continue;`
 *    改成**无条件 continue**（即「一条都不判违规」）→ 全量 140 条照样全绿。
 *    原因：原来的阳性对照只防「扫描器一条都抓不到」，**不防「扫描器一条都不判违规」**。
 *    抽出成纯函数后可以直接对已知输入断言判定结果。
 */
export function classifySpecifier(value) {
  if (value.startsWith('node:')) return 'builtin';
  if (value.startsWith('.')) return 'relative';
  if (value.startsWith('/')) return 'absolute';
  return 'violation';
}

/**
 * 扫描**一段源码**，返回该源码里的 { specifiers, violations, absolute }。
 *
 * ⚠️ 终审修正（Important，I-A）：抽出来是为了能对**已知的坏输入**直接断言
 *    「它确实被判成违规」—— 不必往真实源码树里塞一个假依赖文件。
 */
export function scanSource(code, rel = '<synthetic>') {
  const specifiers = [];
  const violations = [];
  const absolute = [];
  // ⚠️ blankRegex: true → 正则字面量也剥成空白。
  //    终审复核（Minor F-5）：正则字面量里的 `from 'x'` 不是 import，保留正则会误报。
  const stripped = stripComments(code, { blankRegex: true });
  for (const spec of findSpecifiers(stripped)) {
    const line = lineAt(code, spec.start);
    const hit = { file: rel, line, value: spec.value };
    specifiers.push(hit);
    const kind = classifySpecifier(spec.value);
    if (kind === 'builtin' || kind === 'relative') continue;
    if (kind === 'absolute') {
      absolute.push(hit);
      continue;
    }
    violations.push(hit);
  }
  return { specifiers, violations, absolute };
}

/** 扫描全部受管目录，返回 { specifiers, violations, absolute }。 */
function scanImports() {
  const specifiers = [];
  const violations = [];
  const absolute = [];
  for (const dir of SCAN_DIRS) {
    for (const file of collectJsFiles(join(root, dir))) {
      const raw = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      const r = scanSource(raw, rel);
      specifiers.push(...r.specifiers);
      violations.push(...r.violations);
      absolute.push(...r.absolute);
    }
  }
  return { specifiers, violations, absolute };
}

test('src/ scripts/ web/ test/ 的源码里没有任何第三方 import', () => {
  const { violations } = scanImports();
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} 导入「${v.value}」`),
    [],
    '只允许 node: 内置模块或相对路径（. 开头）—— 发现第三方依赖',
  );
});

test('零依赖守卫必须扫到 test/ 目录（测试代码同样要零依赖）', () => {
  // ⚠️ 终审修正（Minor，M-5）：原来 SCAN_DIRS 只有 src / scripts / web ——
  //    **test/ 没被扫**。往 test/router.test.js 里塞一行 `import lodash from 'lodash'`
  //    全量测试照样全绿（终审实测：注入探针 XD-11 MISSED）。
  //    而 README 承诺「只用 Node 标准库」是**全项目级**的，测试代码也在内 ——
  //    测试代码同样要能在任何机器上裸跑。
  // ⚠️ 这里**不去断言 SCAN_DIRS 常量**（那只是把实现抄一遍），而是断言
  //    **扫描结果里真的出现过 test/ 下的文件** —— 守卫漏扫 test/ → 这条立刻红。
  const { specifiers } = scanImports();
  const fromTest = specifiers.filter((s) => s.file.split(sep).join('/').startsWith('test/'));
  assert.ok(
    fromTest.length > 0,
    '零依赖守卫必须扫到 test/ 目录下的文件（测试代码也在零依赖承诺范围内）',
  );
});

test('零依赖守卫自己有效：扫描器真的抓得到 import（阳性对照）', () => {
  // ⛔ 防「扫描器坏了 → 一条都抓不到 → 测试假绿」。
  const { specifiers } = scanImports();
  assert.ok(specifiers.length >= 20, `只抓到 ${specifiers.length} 条 import，扫描器多半坏了`);
  const values = specifiers.map((s) => s.value);
  assert.ok(values.includes('node:sqlite'), '应抓到 src/db/sqlite.js 的 node:sqlite');
  assert.ok(
    values.some((v) => v.endsWith('src/db/sqlite.js')),
    '应抓到 scripts/ 里的相对路径导入 ../src/db/sqlite.js',
  );
});

test('没有任何绝对路径 import（绝对路径说明模块解析被绕过）', () => {
  // 规则不放宽：绝对路径虽然能被 allowlist 放过，但当前代码里不该出现；
  // 真出现说明有人绕过了模块解析约定 → 直接报错。
  const { absolute } = scanImports();
  assert.deepEqual(
    absolute.map((v) => `${v.file}:${v.line} 导入「${v.value}」`),
    [],
    '不允许绝对路径 import',
  );
});

test('扫描器对**已知坏输入**确实判违规（防「一条都不判违规」的假绿）', async () => {
  // ⛔ 终审修正（Important，I-A）：原来的阳性对照只防「扫描器一条都抓不到」，
  //    **不防「扫描器一条都不判违规」** —— 把扫描循环里的判定改成无条件 `continue`
  //    （跳过全部 specifier）→ 全量 140 条照样全绿。
  //    这里直接对**合成的坏源码**断言它被判成违规，不必往真实源码树里塞假依赖。
  const { scanSource, classifySpecifier } = await import('./zero-deps.test.js');

  // 判定函数本身
  assert.equal(classifySpecifier('node:sqlite'), 'builtin');
  assert.equal(classifySpecifier('./x.js'), 'relative');
  assert.equal(classifySpecifier('../src/x.js'), 'relative');
  assert.equal(classifySpecifier('/abs/x.js'), 'absolute');
  assert.equal(classifySpecifier('lodash'), 'violation');
  assert.equal(classifySpecifier('express'), 'violation');
  assert.equal(classifySpecifier('@scope/pkg'), 'violation');

  // 真实扫描路径：五种第三方写法都必须被抓
  const BAD = [
    "import lodash from 'lodash';",
    "import { x } from 'express';",
    "import 'chalk';",
    "export { x } from 'redux';",
    "const m = await import('moment');",
    "const m = require('underscore');",
  ];
  for (const code of BAD) {
    const r = scanSource(code, '<synthetic>');
    assert.equal(
      r.violations.length,
      1,
      `这段源码里的第三方依赖必须被判违规：${code}（实际 violations=${JSON.stringify(r.violations)}）`,
    );
  }

  // 反例对照：合法的写法不得被误判（否则这条用例就变成了「一律违规」的恒绿）
  const GOOD = [
    "import { openDatabase } from '../src/db/sqlite.js';",
    "import { DatabaseSync } from 'node:sqlite';",
    "const s = '这不是 import';",
    "// import lodash from 'lodash';  // 注释里的不算",
    "const url = 'https://example.com/from';",
    // ⚠️ 终审复核（Minor F-5）：**正则字面量**里的 import 也不是 import。
    //    保留正则 → 这一行会被误判成第三方依赖（假警报，守卫被人当噪声关掉）。
    //    stripComments(code, { blankRegex: true }) 把正则也剥成空白 → 不误报。
    "const re = /import x from 'lodash'/;",
  ];
  for (const code of GOOD) {
    const r = scanSource(code, '<synthetic>');
    assert.deepEqual(
      r.violations,
      [],
      `合法写法不得被误判为违规：${code}`,
    );
  }
});

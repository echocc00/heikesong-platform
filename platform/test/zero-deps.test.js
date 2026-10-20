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
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * 把源码里的**注释**替换成等长空白（保留换行 → 行号不变），
 * 字符串 / 模板字面量 / 正则字面量原样保留。
 *
 * 为什么必须先剥注释：注释里写的 `import x from 'lodash'` **不是依赖**，
 * 让它误报 = 守卫被人加白名单绕过（误伤比漏检更糟）。
 * 为什么不能粗暴地按行切：字符串字面量里的 `//` 不是注释（如 'https://…'）。
 * 实现：逐字符状态机（代码 / 单引号 / 双引号 / 模板），零依赖。
 */
function stripComments(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  // 帧栈：code（代码 / 模板表达式）/ sq / dq / tpl
  const frames = [{ kind: 'code', depth: 0 }];
  const top = () => frames[frames.length - 1];
  // 「/」是除号还是正则字面量的开头：用上一个有效字符 + 尾词判断
  const REGEX_PUNCT = new Set('(,=:[!&|?{}+-*%<>~^'.split(''));
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'new', 'do', 'else',
    'yield', 'await', 'void', 'instanceof', 'delete',
  ]);
  let i = 0;
  let lastCodeChar = '';

  const trailingWord = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(src[k])) k -= 1;
    const end = k + 1;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
    return src.slice(k + 1, end);
  };

  while (i < src.length) {
    const f = top();
    const c = src[i];
    const c2 = src[i + 1];

    if (f.kind === 'code') {
      if (c === '/' && c2 === '/') {
        let end = src.indexOf('\n', i);
        if (end === -1) end = src.length;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '/' && c2 === '*') {
        let end = src.indexOf('*/', i + 2);
        end = end === -1 ? src.length : end + 2;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '/' && (REGEX_PUNCT.has(lastCodeChar) || REGEX_KEYWORDS.has(trailingWord()))) {
        // 正则字面量：整体跳过（内容是代码，不能当注释，也不能当字符串）
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { j += 1; break; }
          else if (ch === '\n') break;
          j += 1;
        }
        lastCodeChar = '/';
        i = j;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        frames.push({ kind: c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl', depth: 0 });
        lastCodeChar = c;
        i += 1;
        continue;
      }
      if (c === '{') { f.depth += 1; lastCodeChar = '{'; i += 1; continue; }
      if (c === '}') {
        // depth === 0 且不是根帧 → 模板表达式的 ${ } 结束，回到模板态
        if (f.depth === 0 && frames.length > 1) { frames.pop(); lastCodeChar = '}'; i += 1; continue; }
        if (f.depth > 0) f.depth -= 1;
        lastCodeChar = '}';
        i += 1;
        continue;
      }
      if (!/\s/.test(c)) lastCodeChar = c;
      i += 1;
      continue;
    }

    if (f.kind === 'sq' || f.kind === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if ((f.kind === 'sq' && c === "'") || (f.kind === 'dq' && c === '"')) {
        frames.pop();
        lastCodeChar = c;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // 模板字符串
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { frames.pop(); lastCodeChar = '`'; i += 1; continue; }
    if (c === '$' && c2 === '{') { frames.push({ kind: 'code', depth: 0 }); i += 2; continue; }
    i += 1;
  }
  return out.join('');
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

const SCAN_DIRS = ['src', 'scripts', 'web'];

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
  const stripped = stripComments(code);
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

test('src/ scripts/ web/ 的源码里没有任何第三方 import', () => {
  const { violations } = scanImports();
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} 导入「${v.value}」`),
    [],
    '只允许 node: 内置模块或相对路径（. 开头）—— 发现第三方依赖',
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

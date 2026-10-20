// platform/test/helpers/strip-comments.js — 源码注释剥离器（测试专用共享工具）
//
// 依据：本文件是三个测试文件共同需要的**同一样东西**：
//   - test/zero-deps.test.js  → 扫 import specifier（注释里的 import 不算依赖）
//   - test/sql-boundary.test.js → 扫 SQL（注释里的 SQL 不算）
//   - test/server.test.js     → 扫接线断言（**注释里的调用点不算接线**）
//   此前前两个文件各抄了一份（逐字相同，只差注释）→ 改一处要改两处，必然漂移。
//   终审复核（Minor F-3）指出第三处也需要它，于是抽出成本文件。
//
// ⚠️ 它是**测试辅助工具**，不是被测代码；放在 test/ 下由零依赖守卫一起扫
//    （零依赖守卫扫描 src/ scripts/ web/ test/ 四个目录 —— 本文件不含任何 import，
//      连 node: 都不需要，符合「只用 Node 标准库」的承诺）。
//
// ⛔ 纯函数、零依赖、零 IO。

/**
 * 把源码里的**注释**替换成等长空白（保留换行 → 行号不变），
 * 字符串 / 模板字面量 / 正则字面量原样保留。
 *
 * 为什么必须先剥注释：注释里写的 `import x from 'lodash'` **不是依赖**，
 * 让它误报 = 守卫被人加白名单绕过（误伤比漏检更糟）。
 * 为什么不能粗暴地按行切：字符串字面量里的 `//` 不是注释（如 'https://…'）。
 * 实现：逐字符状态机（代码 / 单引号 / 双引号 / 模板），零依赖。
 *
 * @param {string} src 源码
 * @param {{ blankRegex?: boolean }} [options]
 *   `blankRegex: true` → 连**正则字面量**也一起替换成空白。
 *   用途：零依赖守卫的 specifier 扫描 —— 正则字面量里的 `from 'x'` 不是 import
 *   （终审复核 Minor F-5：保留正则会误报）。
 *   ⚠️ 默认**不**开：SQL 边界扫描器需要**字符串字面量**原样保留，
 *   而且正则识别的启发式偶尔会误判除号 → 宁可少扫也不误伤。
 * @returns {string} 与输入等长、行号一致的「剥掉注释」的源码
 */
export function stripComments(src, options = {}) {
  const blankRegex = options.blankRegex === true;
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
        if (blankRegex) blank(i, j);
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

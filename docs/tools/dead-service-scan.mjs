// docs/tools/dead-service-scan.mjs — 死服务扫描：找出「导出了、但生产代码里没有调用方」的函数
//
// 依据：设计文档 §8「API 设计」+ 本仓事故复盘（发榜端点漏接的那次坑）：
//   设计文档 §8 的 API 清单里**漏了一条发榜端点** ⇒ 服务层 `publishLeaderboard` 写好了、
//   单测 25 处引用全绿，但**路由表里没有任何入口能触达它** ⇒ 段位永远兜底 D 段、
//   个人榜永远为空、发榜无留痕、奖金无依据，而**所有测试都是绿的**。
//   病根：现有闸大量是「服务层单测」，没有一条经 HTTP 路由的端到端闸。
//   ⇒ 这个闸把「写了没接线」变成**可自动检测的红**。
//
// 这个闸防的是什么：
//   「服务层 / 仓储层导出了函数，但生产代码（platform/src/**）里找不到任何调用方」——
//   即「实现了、测试也绿了、但产品路径接不上」的死代码。
//
// 判定口径（宁可漏报，不可误报）：
//   · 只扫 platform/src/services/*.js 与 platform/src/db/repo/*.js 两个目录
//     （⛔ 不扫 platform/src/domain/ —— 领域层是纯函数，调用关系不同，容易误报）。
//   · 只看「导出的**函数**」：export function / export async function /
//     export const f = (…) => / export const f = async (…) =>
//     （跳过 export class、export default、以及 re-export 如 export { x } from './y.js'）。
//   · 「生产调用方」= platform/src/** 下的一处**调用表达式**：
//     ✅ foo(...)、obj.foo(...)、await foo(...)、foo.call(...)、foo.apply(...)
//     ❌ 不算：函数自己的定义处、函数自己的递归调用、import 了但没调用、
//             字符串里出现、注释里出现、对象字面量的同名属性键（{ foo: 1 } 不是调用）、
//             另一个模块里恰好有个**同名但不同**的函数。
//   · 「同名不同源」按**定义所在文件**精确归属：只有当调用点的**导入来源**指向那个
//     定义文件（或该文件被间接 re-export 进来）才算数；追不到 ⇒ 保守不报，进「无法判定」一节。
//   · 同名遮蔽（import 之后又在某个内层作用域 `const` 了同名）⇒ 该调用不算数，进「无法判定」一节。
//   · **同文件内的调用不算生产调用方**（自身递归 / 同文件辅助函数）—— 这类走允许清单豁免。
//   · 「调用方」范围 = platform/src/**（排除 platform/test/**、platform/scripts/**、platform/web/**）。
//     ⚠️ scripts/ 与 web/ 在 src/ 之外，本来就进不了这个范围；它们只会出现在**排查提示**里
//        （「只有 scripts/seed.js 在调它」⇒ 是运维路径，不是产品路径）。
//   · **动态 import 也算接线**：本仓 src/http/routes/{audit,review}.js 用的是
//     `new URL('../../services/review-state.js', import.meta.url)` + `loadOptionalModule(...)`
//     + `mod.someFn(...)` ⇒ 这类调用必须认出来，否则会把「已经接上线」误报成死代码。
//   · **以值/回调形式被引用**（rows.map(presentRegistrationEvent)）按本闸口径**不算调用**
//     （口径 = 调用表达式），但会在排查提示里单独列出来，免得「从未被调用过」这句话是假的。
//
// 用法：
//   node docs/tools/dead-service-scan.mjs [platformDir]
//   node docs/tools/dead-service-scan.mjs --json [platformDir]
//   node docs/tools/dead-service-scan.mjs --allow <path> [platformDir]
//   （platformDir 默认 = 本文件所在目录的 ../../platform；允许清单默认 = 本文件旁边的
//     dead-service-scan.allow.json）
//
// 退出码约定：
//   0 = 没有死函数（或全部命中允许清单）
//   1 = 有死函数（未被允许清单豁免）
//   2 = 用法错误（参数不合法 / platformDir 不存在 / 允许清单读不出来）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLATFORM_DIR = resolve(HERE, '../../platform');
const DEFAULT_ALLOW_PATH = join(HERE, 'dead-service-scan.allow.json');

// ── 词法层：保留字 / 标点 ────────────────────────────────────────────
// ⚠️ `of` / `get` / `set` / `async` / `static` / `from` / `as` / `let` 都是**上下文关键字**
//    （在合法 JS 里可以当普通标识符用）⇒ 不能当成保留字，否则 `import { a } from 'x'`
//    里的 `from` 就认不出来了。保留字表只收**永远不能当标识符**的那些。
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

// ⚠️ 顺序敏感：**长的在前**（`>>>=` 必须先于 `>>>`，`===` 先于 `==`）。
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];

/** 标识符起始字符（ASCII 字母/_/$ + 非 ASCII 近似按字母处理） */
function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$' || ch.charCodeAt(0) > 127;
}
function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * 极简 JS 词法扫描：把源码切成 token 流。
 *
 * 为什么要自己写：判定必须区分「**调用**」与「**只是提到名字**」——
 * 注释里的名字、字符串里的名字、对象字面量的同名属性键，统统不算调用。
 * 只用正则扫原文做不到这件事（`foo` 出现在注释里也会被匹配上）。
 *
 * ⛔ 正则字面量 vs 除法：用「上一个有效 token」启发式判断（`)`/标识符/数字后面 ⇒ 除法）。
 *    判错的后果是把后面一大段代码吞掉 ⇒ 漏报调用方 ⇒ 假死。
 */
function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  // 上下文栈：code（普通代码）/ template（模板字符串文本）
  const stack = [{ kind: 'code', tmplExpr: false, depth: 0 }];

  const lastTok = () => (tokens.length ? tokens[tokens.length - 1] : null);

  /** 上一个 token 之后是否可能出现正则字面量 */
  function regexAllowed() {
    const t = lastTok();
    if (!t) return true;
    if (t.type === 'punct') {
      return /^(?:[()[\]{},;:=!<>+\-*/%&|^~?]|\+\+|--|=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\*\*|\.\.\.|\?\.)$/.test(t.value);
    }
    if (t.type === 'keyword') {
      return /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/.test(t.value);
    }
    return false;
  }

  const push = (type, value, start, end, extra) => {
    const tk = { type, value, start, end };
    if (extra) Object.assign(tk, extra);
    tokens.push(tk);
  };

  while (i < n) {
    const ctx = stack[stack.length - 1];
    const ch = src[i];

    // ── 模板字符串文本 ──
    if (ctx.kind === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { push('punct', '`', i, i + 1); i++; stack.pop(); continue; }
      if (ch === '$' && src[i + 1] === '{') {
        // ⚠️ 模板插值里的 `${` 当作一个 '{' 参与括号配对 ⇒ 插值内部的代码也能正确配平
        push('punct', '{', i, i + 2, { tmplOpen: true });
        i += 2;
        stack.push({ kind: 'code', tmplExpr: true, depth: 0 });
        continue;
      }
      i++; // 模板正文不产生 token
      continue;
    }

    // ── 普通代码 ──
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; break; }
        i++;
      }
      if (closed) {
        i++;
        while (i < n && /[a-z]/.test(src[i])) i++; // 正则的 flag
        push('regex', src.slice(start, i), start, i);
        continue;
      }
      i = start; // 没闭合 ⇒ 当成除号处理
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      push('str', src.slice(start + 1, Math.max(start + 1, i - 1)), start, i);
      continue;
    }
    if (ch === '`') {
      push('punct', '`', i, i + 1);
      i++;
      stack.push({ kind: 'template', tmplExpr: false, depth: 0 });
      continue;
    }
    if (ch === '{' && ctx.tmplExpr) ctx.depth++;
    if (ch === '}' && ctx.tmplExpr) {
      if (ctx.depth === 0) {
        // 模板插值结束 ⇒ 回到模板文本
        push('punct', '}', i, i + 1, { tmplClose: true });
        i++;
        stack.pop();
        continue;
      }
      ctx.depth--;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(src[i])) i++;
      const word = src.slice(start, i);
      push(RESERVED.has(word) ? 'keyword' : 'ident', word, start, i);
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < n && /[0-9a-fA-FxXoObBn._]/.test(src[i])) i++;
      push('num', src.slice(start, i), start, i);
      continue;
    }
    let matched = null;
    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, i)) { matched = p; break; }
    }
    if (matched) {
      push('punct', matched, i, i + matched.length);
      i += matched.length;
      continue;
    }
    i++; // 未知字符：跳过
  }
  return tokens;
}

/** 括号配对：'(' '[' '{' → 各自匹配的闭合 token 下标 */
function matchBrackets(tokens) {
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (tokens[i].type !== 'punct') continue;
    if (v === '(' || v === '[' || v === '{') stack.push(i);
    else if (v === ')' || v === ']' || v === '}') {
      const open = stack.pop();
      if (open != null) { pairs.set(open, i); pairs.set(i, open); }
    }
  }
  return pairs;
}

/** 解字符串字面量（够用即可：常见转义 + \uXXXX） */
function unescapeStr(raw) {
  return String(raw)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\');
}

/**
 * 解析一段**绑定模式**（形参 / 解构声明）里真正的绑定名。
 * ⚠️ 对象模式的 `{ a: b }` 里 `a` 是**键**不是绑定；`{ a }` 里 `a` 才是绑定。
 *    绑错 ⇒ 把 import 名字误判成「被形参遮蔽」⇒ 假死。
 */
function patternNames(tokens, start, end) {
  const out = [];
  let k = start;
  while (k < end && tokens[k] && tokens[k].value === '...') k++;
  if (k >= end) return out;
  const t = tokens[k];
  if (!t) return out;
  if (t.type === 'ident') {
    // `a: b`（对象模式的键）不是绑定
    if (tokens[k + 1] && tokens[k + 1].value === ':') return out;
    out.push(t.value);
    return out;
  }
  if (t.value === '{') {
    let depth = 0;
    for (let m = k; m < end; m++) {
      const tt = tokens[m];
      if (tt.value === '{') { depth++; continue; }
      if (tt.value === '}') { depth--; if (depth === 0) break; continue; }
      if (depth === 1 && tt.type === 'ident') {
        const nxt = tokens[m + 1];
        if (nxt && nxt.value === ':') {
          // `key: value` ⇒ 绑定在 value 上
          const vStart = m + 2;
          let d2 = 0;
          let vEnd = vStart;
          for (let q = vStart; q < end; q++) {
            const q2 = tokens[q];
            if (q2.value === '(' || q2.value === '[' || q2.value === '{') d2++;
            else if (q2.value === ')' || q2.value === ']' || q2.value === '}') {
              if (d2 === 0) { vEnd = q; break; }
              d2--;
            } else if (q2.value === ',' && d2 === 0) { vEnd = q; break; }
          }
          out.push(...patternNames(tokens, vStart, vEnd));
          m = vEnd - 1;
        } else {
          out.push(tt.value);
        }
      }
    }
    return out;
  }
  if (t.value === '[') {
    let depth = 0;
    for (let m = k; m < end; m++) {
      const tt = tokens[m];
      if (tt.value === '[') { depth++; continue; }
      if (tt.value === ']') { depth--; if (depth === 0) break; continue; }
      if (depth === 1 && tt.type === 'ident') {
        if (tokens[m + 1] && tokens[m + 1].value === ':') { m += 1; continue; }
        out.push(tt.value);
      }
    }
    return out;
  }
  return out;
}

/** 形参表 [start, end) → 绑定名列表 */
function collectParams(tokens, start, end) {
  const names = [];
  let depth = 0;
  let segStart = start;
  const segments = [];
  for (let k = start; k < end; k++) {
    const t = tokens[k];
    if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
    else if (t.value === ',' && depth === 0) { segments.push([segStart, k]); segStart = k + 1; }
  }
  segments.push([segStart, end]);
  for (const [s, e] of segments) {
    if (e <= s) continue;
    names.push(...patternNames(tokens, s, e));
  }
  return names;
}

/**
 * 从声明名之后找到**初始化表达式的第一个 token**（跳过 '='）。
 * @returns {number|null} token 下标；没有初始化 ⇒ null
 */
function findInitStart(tokens, afterIdx) {
  let k = afterIdx;
  let depth = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.value === '(' || t.value === '[' || t.value === '{') { depth++; k++; continue; }
    if (t.value === ')' || t.value === ']' || t.value === '}') {
      if (depth === 0) return null;
      depth--; k++; continue;
    }
    if (depth === 0 && t.value === '=') return k + 1;
    if (depth === 0 && t.value === ';') return null;
    if (depth === 0 && t.type === 'keyword' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) return null;
    k++;
  }
  return null;
}

/** `export const f = <右侧>` 是不是函数表达式（箭头 / function） */
function isFunctionExpression(tokens, idx, pairs) {
  let k = idx;
  while (tokens[k] && tokens[k].value === '=') k++; // 跳过赋值号
  const t = tokens[k];
  if (!t) return false;
  if (t.type === 'ident' && t.value === 'async') {
    const nx = tokens[k + 1];
    if (!nx) return false;
    if (nx.type === 'keyword' && nx.value === 'function') return true;
    if (nx.value === '(') {
      const close = pairs.get(k + 1);
      return close != null && tokens[close + 1] && tokens[close + 1].value === '=>';
    }
    return false;
  }
  if (t.type === 'keyword' && t.value === 'function') return true;
  if (t.value === '(') {
    const close = pairs.get(k);
    return close != null && tokens[close + 1] && tokens[close + 1].value === '=>';
  }
  return false;
}

/**
 * 分析单个 JS 文件：导入 / 导出 / 作用域 / 调用点。
 *
 * 返回：
 *   imports        : Map<本地名, { importedName, sourceAbs, kind }>  kind: named|default|namespace
 *   namespaceOf    : Map<本地名, sourceAbs>
 *   exports        : Map<导出名, { kind:'local'|'from'|'namespaceFrom', localName?, sourceAbs?, sourceName?, isFunction }>
 *   starReExports  : string[]（`export * from 'x'` 的来源文件）
 *   calls          : 调用点列表
 *   localFunctions : 本文件里 `function` 声明的名字（用于 `export { foo }` 这类本地再导出）
 */
export function analyzeFile(abs, src) {
  const tokens = tokenize(src);
  const pairs = matchBrackets(tokens);

  const imports = new Map();      // 本地名 → 导入信息
  const namespaceOf = new Map();  // 命名空间导入的本地名 → 来源文件
  const exports = new Map();      // 导出名 → 导出信息
  const starReExports = [];       // `export * from 'x'`
  const localFunctions = new Set();
  const calls = [];
  const bindings = new Map();     // 名字 → [{ scope, kind }]（kind: local）
  const decls = [];               // 变量声明（用于追踪动态 import 出来的模块命名空间）
  const localFunctionBodies = new Map(); // 本地函数名 → 函数体 '{' 的 token 下标
  const refs = [];                // 「被当作值引用」的位置（回调、传参……）—— 不是调用，但也不是「从未被提起」
  const importClauseRanges = [];  // import 子句的 token 区间（里面的名字不是引用）

  // ── 作用域 ──
  const rootScope = { kind: 'module', parent: null, bindings: new Map() };
  const scopeStack = [rootScope];
  /** 某个 '{' 打开的作用域里要绑定的名字（函数形参 / catch 参数 / for 头声明） */
  const pendingBraceBindings = new Map();

  const bindLocal = (name, scope) => {
    if (!name) return;
    scope.bindings.set(name, true);
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push({ scope, kind: 'local' });
  };

  /** 相对导入说明 → 绝对路径（只处理相对说明；裸模块名不是本仓文件） */
  function resolveSource(spec) {
    if (!spec) return null;
    if (spec.startsWith('.')) {
      const p = resolve(dirname(abs), spec);
      if (existsSync(p)) return p;
      if (existsSync(p + '.js')) return p + '.js';
      if (existsSync(join(p, 'index.js'))) return join(p, 'index.js');
      return null;
    }
    if (isAbsolute(spec)) return existsSync(spec) ? spec : null;
    return null; // 裸模块名（node:xxx / npm 包）⇒ 不在本仓文件范围内
  }

  // ── 预扫描：函数体 / 箭头 / 方法 / catch 的形参 ⇒ 绑定到对应 '{' 的作用域里 ──
  //    ⚠️ 箭头函数的**表达式体**（`(x) => x`）没有 '{' ⇒ 形参无处安放。
  //       这里的取舍是**不绑**（⇒ 该名字的调用会被算到 import 上 ⇒ 偏漏报，不偏误报）。
  const addBodyParams = (bodyBrace, params) => {
    if (bodyBrace == null || !params.length) return;
    const prev = pendingBraceBindings.get(bodyBrace) || [];
    pendingBraceBindings.set(bodyBrace, prev.concat(params));
  };
  /** function 关键字下标 → 函数体 '{' 的 token 下标 */
  const funcBodyBrace = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'keyword' && t.value === 'function') {
      let j = i + 1;
      if (tokens[j] && tokens[j].value === '*') j++;
      if (tokens[j] && tokens[j].type === 'ident') j++;
      if (tokens[j] && tokens[j].value === '(') {
        const close = pairs.get(j);
        if (close != null) {
          const bodyBrace = tokens[close + 1] && tokens[close + 1].value === '{' ? close + 1 : null;
          if (bodyBrace != null) funcBodyBrace.set(i, bodyBrace);
          addBodyParams(bodyBrace, collectParams(tokens, j + 1, close));
        }
      }
      continue;
    }
    if (t.type === 'keyword' && t.value === 'catch') {
      const j = i + 1;
      if (tokens[j] && tokens[j].value === '(') {
        const close = pairs.get(j);
        if (close != null) {
          const bodyBrace = tokens[close + 1] && tokens[close + 1].value === '{' ? close + 1 : null;
          addBodyParams(bodyBrace, collectParams(tokens, j + 1, close));
        }
      }
      continue;
    }
    if (t.type === 'punct' && t.value === '(') {
      const close = pairs.get(i);
      if (close == null) continue;
      const nxt = tokens[close + 1];
      if (!nxt) continue;
      if (nxt.value === '=>') {
        // 箭头函数
        const bodyBrace = tokens[close + 2] && tokens[close + 2].value === '{' ? close + 2 : null;
        addBodyParams(bodyBrace, collectParams(tokens, i + 1, close));
      } else if (nxt.value === '{' && tokens[i - 1] && tokens[i - 1].type === 'ident') {
        // 对象/类的方法简写：foo(a) { ... }
        addBodyParams(close + 1, collectParams(tokens, i + 1, close));
      }
    }
  }

  // ── 预扫描：for 头部的 const/let/var 声明 ──
  const forHeaderRanges = []; // [start, end] token 下标区间
  const forHeaderInfo = new Map(); // for 关键字下标 → { names, bodyBrace }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'keyword' || t.value !== 'for') continue;
    const j = i + 1;
    if (!tokens[j] || tokens[j].value !== '(') continue;
    const close = pairs.get(j);
    if (close == null) continue;
    forHeaderRanges.push([j, close]);
    const names = [];
    let depth = 0;
    for (let k = j + 1; k < close; k++) {
      const tt = tokens[k];
      if (tt.value === '(' || tt.value === '[' || tt.value === '{') depth++;
      else if (tt.value === ')' || tt.value === ']' || tt.value === '}') depth--;
      else if (depth === 0 && tt.type === 'keyword' && (tt.value === 'const' || tt.value === 'let' || tt.value === 'var')) {
        const nx = tokens[k + 1];
        if (nx && nx.type === 'ident') names.push(nx.value);
        else if (nx && (nx.value === '{' || nx.value === '[')) {
          const nxClose = pairs.get(k + 1);
          if (nxClose != null) names.push(...patternNames(tokens, k + 1, nxClose));
        }
      }
    }
    if (!names.length) continue;
    const bodyBrace = tokens[close + 1] && tokens[close + 1].value === '{' ? close + 1 : null;
    forHeaderInfo.set(i, { names, bodyBrace });
    if (bodyBrace != null) addBodyParams(bodyBrace, names);
  }
  const inForHeader = (idx) => forHeaderRanges.some(([a, b]) => idx > a && idx < b);

  // 行号表（用于「值引用」的定位）
  const lineStarts = [0];
  for (let p = 0; p < src.length; p++) if (src[p] === '\n') lineStarts.push(p + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const inImportClause = (idx) => importClauseRanges.some(([a, b]) => idx >= a && idx < b);
  /** 这个标识符是不是「被当作值引用」（回调 / 传参）—— 不是调用 */
  const isValueRef = (i, t, next) => {
    const prev = tokens[i - 1];
    if (prev && (prev.value === '.' || prev.value === '?.')) return false; // 成员属性名
    if (next && (next.value === ':' || next.value === '(')) return false; // 对象键 / 调用
    if (inImportClause(i)) return false;                                   // import 子句里的名字
    return true;
  };

  // ── 导入解析 ──
  function parseImport(i) {
    // 找 clause 结束位置：跳过 clause 后面的 'from' 与源字符串
    let depth = 0;
    let fromIdx = -1;
    let srcTok = null;
    for (let k = i + 1; k < tokens.length; k++) {
      const tt = tokens[k];
      if (tt.type === 'punct' && (tt.value === '{' || tt.value === '(' || tt.value === '[')) depth++;
      else if (tt.type === 'punct' && (tt.value === '}' || tt.value === ')' || tt.value === ']')) depth--;
      else if (depth === 0 && tt.type === 'str') { srcTok = tt; break; }
      else if (depth === 0 && tt.type === 'ident' && tt.value === 'from') fromIdx = k;
    }
    if (!srcTok) return;
    const sourceAbs = resolveSource(unescapeStr(srcTok.value));
    if (!sourceAbs) return;
    const clauseStart = i + 1;
    const clauseEnd = fromIdx >= 0 ? fromIdx : clauseStart;
    importClauseRanges.push([clauseStart, clauseEnd]);

    let defaultLocal = null;
    let nsLocal = null;
    const named = [];
    let k = clauseStart;
    if (k < clauseEnd && tokens[k].type === 'ident') { defaultLocal = tokens[k].value; k++; }
    while (k < clauseEnd) {
      const tt = tokens[k];
      if (tt.value === '*') {
        const asIdx = (() => { for (let m = k + 1; m < clauseEnd; m++) if (tokens[m].type === 'ident' && tokens[m].value === 'as') return m; return -1; })();
        if (asIdx >= 0 && tokens[asIdx + 1]) { nsLocal = tokens[asIdx + 1].value; k = asIdx + 2; }
        else k += 1;
        continue;
      }
      if (tt.value === '{') {
        let d = 0;
        for (let m = k; m < clauseEnd; m++) {
          const t2 = tokens[m];
          if (t2.value === '{') { d++; continue; }
          if (t2.value === '}') { d--; if (d === 0) { k = m + 1; break; } continue; }
          if (d === 1 && t2.type === 'ident') {
            const nxt = tokens[m + 1];
            if (nxt && nxt.type === 'ident' && nxt.value === 'as') {
              named.push({ imported: t2.value, local: tokens[m + 2] ? tokens[m + 2].value : t2.value });
              m += 2;
            } else {
              named.push({ imported: t2.value, local: t2.value });
            }
          }
        }
        continue;
      }
      k++;
    }

    if (defaultLocal) imports.set(defaultLocal, { importedName: 'default', sourceAbs, kind: 'default' });
    if (nsLocal) {
      imports.set(nsLocal, { importedName: '*', sourceAbs, kind: 'namespace' });
      namespaceOf.set(nsLocal, sourceAbs);
    }
    for (const sp of named) {
      imports.set(sp.local, { importedName: sp.imported, sourceAbs, kind: 'named' });
    }
  }

  // ── 导出解析 ──
  function parseExport(i) {
    let j = i + 1;
    let t = tokens[j];
    if (!t) return;
    if (t.type === 'keyword' && t.value === 'default') return; // export default：跳过
    if (t.type === 'ident' && t.value === 'async' && tokens[j + 1] && tokens[j + 1].type === 'keyword' && tokens[j + 1].value === 'function') {
      j += 1;
      t = tokens[j];
    }
    if (t.type === 'keyword' && t.value === 'function') {
      const nameTok = tokens[j + 1];
      if (nameTok && nameTok.type === 'ident') {
        exports.set(nameTok.value, { kind: 'local', localName: nameTok.value, isFunction: true });
      }
      return;
    }
    if (t.type === 'keyword' && t.value === 'class') return; // export class：跳过
    if (t.type === 'keyword' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) {
      const decl = tokens[j + 1];
      if (decl && decl.type === 'ident') {
        exports.set(decl.value, {
          kind: 'local',
          localName: decl.value,
          isFunction: isFunctionExpression(tokens, j + 2, pairs),
        });
      }
      return;
    }
    if (t.type === 'punct' && t.value === '{') {
      const close = pairs.get(j);
      if (close == null) return;
      const specs = [];
      let m = j + 1;
      while (m < close) {
        const st = tokens[m];
        if (st.type === 'ident') {
          const nxt = tokens[m + 1];
          if (nxt && nxt.type === 'ident' && nxt.value === 'as') {
            specs.push({ local: st.value, exported: tokens[m + 2] ? tokens[m + 2].value : st.value });
            m += 3;
            continue;
          }
          specs.push({ local: st.value, exported: st.value });
          m += 1;
          continue;
        }
        m += 1;
      }
      let sourceAbs = null;
      const fromTok = tokens[close + 1];
      if (fromTok && fromTok.type === 'ident' && fromTok.value === 'from') {
        const strTok = tokens[close + 2];
        if (strTok && strTok.type === 'str') sourceAbs = resolveSource(unescapeStr(strTok.value));
      }
      for (const sp of specs) {
        if (sourceAbs) {
          // `export { x } from './y.js'`：不是本文件的定义，只是再导出
          exports.set(sp.exported, { kind: 'from', sourceAbs, sourceName: sp.local, isFunction: false });
        } else {
          exports.set(sp.exported, { kind: 'local', localName: sp.local, isFunction: false, localReexport: true });
        }
      }
      return;
    }
    if (t.type === 'punct' && t.value === '*') {
      let m = j + 1;
      let nsName = null;
      if (tokens[m] && tokens[m].type === 'ident' && tokens[m].value === 'as') {
        nsName = tokens[m + 1] ? tokens[m + 1].value : null;
        m += 2;
      }
      if (tokens[m] && tokens[m].type === 'ident' && tokens[m].value === 'from') {
        const strTok = tokens[m + 1];
        if (strTok && strTok.type === 'str') {
          const sourceAbs = resolveSource(unescapeStr(strTok.value));
          if (sourceAbs) {
            if (nsName) exports.set(nsName, { kind: 'namespaceFrom', sourceAbs, isFunction: false });
            else starReExports.push(sourceAbs);
          }
        }
      }
      return;
    }
  }

  // ── 主遍历：作用域 + 绑定 + 调用点 ──
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const cur = scopeStack[scopeStack.length - 1];

    if (t.type === 'keyword') {
      if (t.value === 'import') { parseImport(i); continue; }
      if (t.value === 'export') { parseExport(i); continue; }
      if (t.value === 'function') {
        // `function foo(...)` 是**声明**（名字绑定到外层作用域）；
        // `const f = function foo(...)` 是**表达式**（名字只在自己作用域内 ⇒ 不绑到外层）。
        let j = i + 1;
        if (tokens[j] && tokens[j].value === '*') j++;
        const nameTok = tokens[j] && tokens[j].type === 'ident' ? tokens[j] : null;
        if (nameTok) {
          localFunctions.add(nameTok.value);
          const prev = tokens[i - 1];
          const asExpression = prev && (prev.value === '=' || prev.value === '(' || prev.value === ','
            || prev.value === '[' || prev.value === ':' || prev.value === 'return' || prev.value === '=>');
          if (!asExpression) {
            bindLocal(nameTok.value, cur);
            const bodyBrace = funcBodyBrace.get(i);
            if (bodyBrace != null) localFunctionBodies.set(nameTok.value, bodyBrace);
          }
        }
        continue;
      }
      if (t.value === 'for') {
        const fi = forHeaderInfo.get(i);
        if (fi && fi.bodyBrace == null) {
          // 没有花括号的 for 头 ⇒ 变量落在当前作用域
          for (const nm of fi.names) bindLocal(nm, cur);
        }
        continue;
      }
      if (t.value === 'class') {
        const nameTok = tokens[i + 1];
        if (nameTok && nameTok.type === 'ident') bindLocal(nameTok.value, cur);
        continue;
      }
      if (t.value === 'const' || t.value === 'let' || t.value === 'var') {
        if (inForHeader(i)) continue; // for 头部的声明单独处理
        const nx = tokens[i + 1];
        if (nx && nx.type === 'ident') {
          bindLocal(nx.value, cur);
          decls.push({ name: nx.value, initStart: findInitStart(tokens, i + 2), patternNames: null });
        } else if (nx && (nx.value === '{' || nx.value === '[')) {
          const close = pairs.get(i + 1);
          const names = close != null ? patternNames(tokens, i + 1, close) : [];
          for (const nm of names) bindLocal(nm, cur);
          decls.push({ name: null, initStart: findInitStart(tokens, i + 1), patternNames: names });
        }
        continue;
      }
      continue;
    }

    if (t.type === 'punct') {
      if (t.value === '{') {
        const scope = { kind: 'block', parent: cur, bindings: new Map() };
        scopeStack.push(scope);
        const pend = pendingBraceBindings.get(i);
        if (pend) for (const nm of pend) bindLocal(nm, scope);
        continue;
      }
      if (t.value === '}') {
        if (scopeStack.length > 1) scopeStack.pop();
        continue;
      }
    }

    // ── 调用点识别 ──
    if (t.type !== 'ident') continue;
    const prev = tokens[i - 1];
    const prevIsDeclKeyword = prev && prev.type === 'keyword'
      && (prev.value === 'function' || prev.value === 'class' || prev.value === 'const' || prev.value === 'let' || prev.value === 'var');
    if (prevIsDeclKeyword) continue; // 定义处 / 声明名，不是调用

    const next = tokens[i + 1];
    if (!next) continue;

    let isCall = false;
    if (next.value === '(') {
      const close = pairs.get(i);
      const after = close != null ? tokens[close + 1] : null;
      // `foo(a) { ... }` 是方法定义，不是调用
      if (!(after && after.value === '{')) {
        calls.push({ kind: 'direct', name: t.value, tokIndex: i, scope: cur });
        isCall = true;
      }
    } else if (next.value === '?.') {
      const after = tokens[i + 2];
      if (after && after.value === '(') {
        calls.push({ kind: 'direct', name: t.value, tokIndex: i, scope: cur, optional: true });
        isCall = true;
      }
    } else if (next.value === '.') {
      const prop = tokens[i + 2];
      if (prop && prop.type === 'ident') {
        const afterProp = tokens[i + 3];
        if (afterProp && afterProp.value === '(') {
          if (prop.value === 'call' || prop.value === 'apply') {
            // foo.call(...) / foo.apply(...) ⇒ 被调用的是 foo 自己
            calls.push({ kind: 'direct', name: t.value, tokIndex: i, scope: cur, via: prop.value });
          } else {
            // obj.foo(...)
            calls.push({ kind: 'member', obj: t.value, prop: prop.value, tokIndex: i, scope: cur });
          }
          isCall = true;
        } else if (afterProp && afterProp.value === '.' && tokens[i + 4] && tokens[i + 4].type === 'ident'
          && (tokens[i + 4].value === 'call' || tokens[i + 4].value === 'apply')
          && tokens[i + 5] && tokens[i + 5].value === '(') {
          calls.push({ kind: 'member', obj: t.value, prop: prop.value, tokIndex: i, scope: cur, via: tokens[i + 4].value });
          isCall = true;
        }
      }
    }
    // 「被当作值引用」（回调、传参……）：**不是调用**，但也不是「从未被提起」
    if (!isCall && isValueRef(i, t, next)) refs.push({ name: t.value, line: lineOf(t.start) });
  }

  // `export { foo }`（本地再导出）：若 foo 是本文件的函数声明 ⇒ 它也是本文件的导出函数
  for (const [name, entry] of [...exports]) {
    if (entry.kind === 'local' && entry.localReexport && localFunctions.has(entry.localName)) {
      exports.set(name, { kind: 'local', localName: entry.localName, isFunction: true });
    }
  }

  // ── 动态 import 追踪（本仓有一类**真实的生产接线**必须认出来）──────────
  // ⚠️ 否则会把「已经接上线」误报成「死代码」：
  //    src/http/routes/audit.js、review.js 用的是
  //      const X = new URL('../../services/review-state.js', import.meta.url).href;
  //      const mod = await loadOptionalModule(X, path);   // 或本地包装函数
  //      mod.someFn({ ... });
  //    ⇒ 这类调用是**真接线**，必须计入生产调用方。
  const urlVars = new Map();           // 变量名 → 它指向的模块文件
  const loaderFiles = new Map();       // 加载函数名 → 它加载的模块文件
  const dynamicNamespaces = new Map(); // 变量名 → 模块文件（命名空间）
  const dynamicMembers = new Map();    // 变量名 → { file, prop }（命名空间成员被摘出来存成局部变量）

  /** 某个调用表达式加载的是哪个模块文件 */
  const resolveLoaderTarget = (calleeName, callIdx) => {
    if (calleeName === 'loadOptionalModule') {
      const arg = tokens[callIdx + 2]; // '(' 之后的第一个实参
      if (arg && arg.type === 'ident' && urlVars.has(arg.value)) return urlVars.get(arg.value);
      return null;
    }
    if (loaderFiles.has(calleeName)) return loaderFiles.get(calleeName);
    return null;
  };

  // (1) URL 变量：const X = new URL('<相对路径>', import.meta.url)
  for (const d of decls) {
    if (!d.name || d.initStart == null) continue;
    const init = tokens[d.initStart];
    if (!init || init.type !== 'keyword' || init.value !== 'new') continue;
    const urlTok = tokens[d.initStart + 1];
    const strTok = tokens[d.initStart + 3];
    if (urlTok && urlTok.value === 'URL' && strTok && strTok.type === 'str') {
      const f = resolveSource(unescapeStr(strTok.value));
      if (f) urlVars.set(d.name, f);
    }
  }

  // (2) 箭头函数体的 '{'（`const load = async () => { ... }`）也算「本地函数」
  for (const d of decls) {
    if (!d.name || d.initStart == null) continue;
    let k = d.initStart;
    if (tokens[k] && tokens[k].type === 'keyword' && tokens[k].value === 'await') k++;
    if (!tokens[k] || tokens[k].value !== '(') continue;
    const close = pairs.get(k);
    if (close == null) continue;
    const bodyBrace = tokens[close + 2] && tokens[close + 2].value === '{' ? close + 2 : null;
    if (bodyBrace != null && !localFunctionBodies.has(d.name)) localFunctionBodies.set(d.name, bodyBrace);
  }

  // (3) 包装函数：函数体里 `return <loader>(...)` ⇒ 该函数加载的是同一个模块
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fname, bodyBrace] of localFunctionBodies) {
      if (loaderFiles.has(fname)) continue;
      const end = pairs.get(bodyBrace);
      if (end == null) continue;
      for (let k = bodyBrace; k < end; k++) {
        const tk = tokens[k];
        if (tk.type !== 'keyword' || tk.value !== 'return') continue;
        let m = k + 1;
        if (tokens[m] && tokens[m].type === 'keyword' && tokens[m].value === 'await') m++;
        const callee = tokens[m];
        if (!callee || callee.type !== 'ident') continue;
        const f = resolveLoaderTarget(callee.value, m);
        if (f) { loaderFiles.set(fname, f); changed = true; break; }
      }
    }
  }

  // (4) 命名空间变量 / 成员绑定（必须按源码顺序，才能先解析出命名空间再解析成员）
  for (const d of decls) {
    if (d.initStart == null) continue;
    let k = d.initStart;
    if (tokens[k] && tokens[k].type === 'keyword' && tokens[k].value === 'await') k++;
    const init = tokens[k];
    if (!init) continue;
    if (init.type === 'keyword' && init.value === 'import') {
      // const mod = await import('./x.js')   /   const { a } = await import('./x.js')
      const strTok = tokens[k + 2];
      if (strTok && strTok.type === 'str') {
        const f = resolveSource(unescapeStr(strTok.value));
        if (f) {
          if (d.patternNames) for (const nm of d.patternNames) dynamicMembers.set(nm, { file: f, prop: nm });
          else if (d.name) dynamicNamespaces.set(d.name, f);
        }
      }
      continue;
    }
    if (init.type !== 'ident') continue;
    const f = resolveLoaderTarget(init.value, k);
    if (f) {
      if (d.name) dynamicNamespaces.set(d.name, f);
      continue;
    }
    // const fn = nsVar?.prop   /   const fn = nsVar.prop
    const nxt = tokens[k + 1];
    if (nxt && (nxt.value === '.' || nxt.value === '?.')) {
      const prop = tokens[k + 2];
      const nsFile = dynamicNamespaces.get(init.value);
      if (prop && prop.type === 'ident' && nsFile && d.name) {
        dynamicMembers.set(d.name, { file: nsFile, prop: prop.value });
      }
    }
  }

  return {
    abs, tokens, imports, namespaceOf, exports, starReExports, calls, bindings,
    localFunctions, dynamicNamespaces, dynamicMembers, refs,
  };
}

/** a 是否是 b 的**严格**祖先作用域（用于「同名遮蔽」判定） */
function isStrictAncestor(a, b) {
  let cur = b ? b.parent : null;
  while (cur) {
    if (cur === a) return true;
    cur = cur.parent;
  }
  return false;
}

/** 列出目录下的 .js 文件（递归） */
function listJsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

/** 读允许清单 */
function loadAllow(allowPath, required) {
  if (!existsSync(allowPath)) {
    if (required) throw new Error(`允许清单不存在：${allowPath}`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowPath, 'utf8'));
  } catch (err) {
    throw new Error(`允许清单解析失败：${allowPath}（${err.message}）`);
  }
  const list = Array.isArray(parsed && parsed.allow) ? parsed.allow : [];
  return list.filter((x) => x && typeof x.file === 'string' && typeof x.name === 'string');
}

/**
 * 扫描一个 platform 目录，返回结构化结果。
 *
 * @param {string} platformDir platform 目录（含 src/）
 * @param {object} [opts] { allowPath, allowRequired }
 */
export function scanPlatform(platformDir, opts = {}) {
  const platformAbs = resolve(platformDir);
  const srcRoot = join(platformAbs, 'src');
  if (!existsSync(srcRoot)) throw new Error(`platform 目录无效（找不到 src/）：${platformAbs}`);

  const relTo = (abs) => relative(platformAbs, abs).split(sep).join('/');

  // 目标目录：只扫服务层与仓储层
  const targetDirs = [join(srcRoot, 'services'), join(srcRoot, 'db', 'repo')];
  const targetFiles = targetDirs.flatMap((d) => listJsFiles(d)).sort();

  // 调用方范围：platform/src/**（排除 test/ scripts/ web/ —— 这三个在 src 之外，
  // 排除规则照样写上，防止有人把 platformDir 指到别处时口径漂移）
  const excludedRoots = ['test', 'scripts', 'web'].map((d) => join(platformAbs, d));
  const isExcluded = (abs) => excludedRoots.some((r) => abs === r || abs.startsWith(r + sep));
  const callerFiles = listJsFiles(srcRoot).filter((f) => !isExcluded(f));

  // 测试文件：只用于「排查提示」（该函数被测了但没接线）
  const testFiles = [...listJsFiles(join(platformAbs, 'test')), ...listJsFiles(join(platformAbs, 'test-helpers'))];

  // ── 解析全部文件 ──
  const cache = new Map();
  const getInfo = (abs) => {
    if (!cache.has(abs)) {
      let src = '';
      try { src = readFileSync(abs, 'utf8'); } catch { src = ''; }
      cache.set(abs, analyzeFile(abs, src));
    }
    return cache.get(abs);
  };
  for (const f of [...targetFiles, ...callerFiles, ...testFiles]) getInfo(f);

  // ── 有效导出表（含 `export * from` 的展开）──
  const exportCache = new Map();
  const visiting = new Set();
  function effectiveExports(abs) {
    if (exportCache.has(abs)) return exportCache.get(abs);
    if (visiting.has(abs)) return new Map(); // 循环再导出：保守放弃
    visiting.add(abs);
    const info = getInfo(abs);
    const map = new Map(info.exports);
    for (const starSrc of info.starReExports) {
      const sub = effectiveExports(starSrc);
      for (const [name] of sub) {
        if (!map.has(name)) map.set(name, { kind: 'from', sourceAbs: starSrc, sourceName: name, isFunction: false });
      }
    }
    visiting.delete(abs);
    exportCache.set(abs, map);
    return map;
  }

  /**
   * 追一个「导出名」的最终定义位置。
   * @returns {{file:string,name:string}|null} null = 追不到（保守不报）
   */
  function resolveOrigin(abs, exportName, depth = 0) {
    if (depth > 12 || !abs) return null;
    const map = effectiveExports(abs);
    const entry = map.get(exportName);
    if (!entry) return null;
    if (entry.kind === 'local') {
      const info = getInfo(abs);
      const imp = info.imports.get(entry.localName);
      if (imp && imp.kind === 'named') return resolveOrigin(imp.sourceAbs, imp.importedName, depth + 1);
      return { file: abs, name: entry.localName };
    }
    if (entry.kind === 'from') return resolveOrigin(entry.sourceAbs, entry.sourceName, depth + 1);
    return null;
  }

  /** 「同名遮蔽」判定：调用点所在作用域链上有没有内层的同名 local 绑定 */
  function isShadowed(info, name, scope) {
    const defs = info.bindings.get(name);
    if (!defs) return false;
    for (const d of defs) {
      // ⚠️ 同作用域也要算遮蔽：`import { foo } from 'x.js'` 之后在**同一个块**里
      //    `const foo = ...` ⇒ 块内的 foo() 指的是那个 const，不是 import 进来的那个。
      //    （只有**模块作用域**例外：ESM 下「同名 import + 同名 const」本身就是语法错误。）
      if (d.scope === scope) {
        if (d.scope.kind !== 'module') return true;
        continue;
      }
      if (isStrictAncestor(d.scope, scope)) return true;
    }
    return false;
  }

  /**
   * 收集一个文件里的调用点 ⇒ 归属到哪个定义。
   * @returns {{targets: Array<{file,name,via}>, undetermined: Array<{name,reason}>}}
   */
  function collectCallTargets(abs) {
    const info = getInfo(abs);
    const targets = [];
    const undetermined = [];
    for (const call of info.calls) {
      if (call.kind === 'direct') {
        // 动态 import 出来的成员（const fn = mod?.foo; fn(...)）
        const dyn = info.dynamicMembers.get(call.name);
        if (dyn) {
          const origin = resolveOrigin(dyn.file, dyn.prop) || { file: dyn.file, name: dyn.prop };
          targets.push({ file: origin.file, name: origin.name, via: call.via || null });
          continue;
        }
        const imp = info.imports.get(call.name);
        if (!imp) {
          // 本文件自己定义并导出的函数（自身递归 / 同文件辅助函数）
          // ⚠️ 这类调用**不算**生产调用方，但要记进「同文件内部调用」提示里。
          const own = info.exports.get(call.name);
          if (own && own.kind === 'local' && own.localName === call.name) {
            targets.push({ file: abs, name: call.name, via: call.via || null });
          }
          continue;                                 // 其余本地函数 / 全局 ⇒ 不属于任何导出
        }
        if (imp.kind !== 'named') continue;         // default 导入：无法归属到具名导出
        if (isShadowed(info, call.name, call.scope)) {
          undetermined.push({ name: call.name, reason: '同名遮蔽（内层作用域重新声明了同名变量）' });
          continue;
        }
        const origin = resolveOrigin(imp.sourceAbs, imp.importedName);
        if (!origin) {
          undetermined.push({ name: call.name, reason: `导入来源解析不到（${relTo(abs)} → ${imp.importedName}）` });
          continue;
        }
        targets.push({ file: origin.file, name: origin.name, via: call.via || null });
        continue;
      }
      if (call.kind === 'member') {
        // 动态 import 出来的命名空间（mod.foo(...)）
        const dynNs = info.dynamicNamespaces.get(call.obj);
        if (dynNs) {
          const origin = resolveOrigin(dynNs, call.prop) || { file: dynNs, name: call.prop };
          targets.push({ file: origin.file, name: origin.name, via: call.via || null });
          continue;
        }
        const nsSrc = info.namespaceOf.get(call.obj);
        if (!nsSrc) continue;                      // 普通对象上的同名属性：不算调用
        if (isShadowed(info, call.obj, call.scope)) {
          undetermined.push({ name: `${call.obj}.${call.prop}`, reason: '命名空间别名被同名遮蔽' });
          continue;
        }
        const origin = resolveOrigin(nsSrc, call.prop);
        if (!origin) {
          undetermined.push({ name: `${call.obj}.${call.prop}`, reason: '命名空间成员解析不到定义' });
          continue;
        }
        targets.push({ file: origin.file, name: origin.name, via: call.via || null });
      }
    }
    return { targets, undetermined };
  }

  // ── 目标定义：被扫描目录里「导出的函数」──
  const targets = [];
  for (const abs of targetFiles) {
    const info = getInfo(abs);
    for (const [exportedName, entry] of info.exports) {
      if (entry.kind !== 'local' || !entry.isFunction) continue;
      targets.push({ abs, rel: relTo(abs), name: entry.localName, exportedName });
    }
  }

  // ── 生产调用方 ──
  const wired = new Set();      // `${定义文件}::${定义名}`
  const sameFileCallers = new Map(); // `${定义文件}::${定义名}` → Set(同文件内的调用位置)
  const undetermined = [];     // 无法判定
  for (const abs of callerFiles) {
    const { targets: ts, undetermined: us } = collectCallTargets(abs);
    for (const t of ts) {
      if (t.file === abs) {
        // 同文件调用（自身递归 / 同文件辅助）**不算**生产调用方，但值得记一笔
        const key = `${t.file}::${t.name}`;
        if (!sameFileCallers.has(key)) sameFileCallers.set(key, new Set());
        sameFileCallers.get(key).add(relTo(abs));
        continue;
      }
      wired.add(`${t.file}::${t.name}`);
    }
    for (const u of us) {
      undetermined.push({ file: relTo(abs), name: u.name, reason: u.reason });
    }
  }

  // ── 测试文件里的调用（排查提示用）──
  const testCallers = new Map(); // `${定义文件}::${定义名}` → Set(测试文件相对路径)
  for (const abs of testFiles) {
    const { targets: ts } = collectCallTargets(abs);
    for (const t of ts) {
      const key = `${t.file}::${t.name}`;
      if (!testCallers.has(key)) testCallers.set(key, new Set());
      testCallers.get(key).add(relTo(abs));
    }
  }

  // ── scripts/ 里的调用（**不算**生产调用方，但要知道「只是运维脚本在用」）──
  //    ⚠️ scripts/ 按口径被排除在生产调用方之外（它不是产品路径），
  //       但「只有种子/审计脚本在调」与「从来没人调」是两种完全不同的结论 ⇒ 单独记一笔。
  const scriptCallers = new Map();
  const scriptFiles = listJsFiles(join(platformAbs, 'scripts'));
  for (const abs of scriptFiles) {
    const { targets: ts } = collectCallTargets(abs);
    for (const t of ts) {
      const key = `${t.file}::${t.name}`;
      if (!scriptCallers.has(key)) scriptCallers.set(key, new Set());
      scriptCallers.get(key).add(relTo(abs));
    }
  }

  // ── 「被当作值引用」的位置（回调 / 传参）──
  //    ⚠️ 这类**不算调用**（本闸口径：调用 = 调用表达式），
  //       但它能证明「这个函数确实被人拿着用」⇒ 排查提示里必须说出来，
  //       否则「从未被任何地方调用过」这句话会是假的。
  const valueRefs = new Map(); // 名字 → [{ file, line }]
  for (const abs of [...callerFiles, ...testFiles, ...scriptFiles]) {
    const info = getInfo(abs);
    for (const r of info.refs) {
      const key = r.name;
      if (!valueRefs.has(key)) valueRefs.set(key, []);
      valueRefs.get(key).push({ file: relTo(abs), line: r.line });
    }
  }

  // ── 允许清单 ──
  const allowPath = opts.allowPath || DEFAULT_ALLOW_PATH;
  const allowList = loadAllow(allowPath, !!opts.allowRequired);
  const allowMap = new Map();
  for (const a of allowList) allowMap.set(`${a.file}::${a.name}`, a.reason || '');

  // ── 汇总 ──
  // ⚠️ 允许清单**每一条都要打印**（包括没命中的）——
  //    没命中的那条说明「豁免已经过期 / 写错了文件名」⇒ 必须让人看见，不能悄悄沉底。
  const allowed = allowList.map((a) => ({ file: a.file, name: a.name, reason: a.reason || '', matched: false }));
  const dead = [];
  let wiredCount = 0;
  for (const tg of targets) {
    const key = `${tg.abs}::${tg.name}`;
    const relKey = `${tg.rel}::${tg.name}`;
    if (wired.has(key)) { wiredCount++; continue; }
    const reason = allowMap.get(relKey) ?? allowMap.get(`${tg.rel}::${tg.exportedName}`);
    if (reason !== undefined) {
      const hit = allowed.find((x) => (x.file === tg.rel && x.name === tg.name) || (x.file === tg.rel && x.name === tg.exportedName));
      if (hit) { hit.matched = true; hit.target = `${tg.rel}::${tg.name}`; }
      continue;
    }
    const tests = [...(testCallers.get(key) || [])].sort();
    const scripts = [...(scriptCallers.get(key) || [])].sort();
    const sameFile = [...(sameFileCallers.get(key) || [])].sort();
    const refs = (valueRefs.get(tg.name) || []).slice(0, 5);
    dead.push({ file: tg.rel, name: tg.name, tests, scripts, sameFile, refs });
  }
  dead.sort((a, b) => (a.file.localeCompare(b.file) || a.name.localeCompare(b.name)));
  allowed.sort((a, b) => (a.file.localeCompare(b.file) || a.name.localeCompare(b.name)));

  // 「无法判定」只保留与目标函数同名的（其余是无关噪声）
  const targetNames = new Set(targets.map((t) => t.name));
  const undeterminedRelevant = undetermined.filter((u) => targetNames.has(u.name.split('.')[0]));

  return {
    platformDir: platformAbs,
    scannedFiles: targetFiles.length,
    exported: targets.length,
    wired: wiredCount,
    dead,
    allowed,
    undetermined: undeterminedRelevant,
    allowPath,
    targetFiles: targetFiles.map(relTo),
  };
}

/** 文本输出 */
function formatText(result) {
  const lines = [];
  lines.push('死服务扫描（dead-service-scan）');
  lines.push(`平台目录：${result.platformDir}`);
  lines.push(`扫描目录：src/services/*.js、src/db/repo/*.js（领域层不扫）`);
  lines.push(`被扫描文件：${result.scannedFiles} 个`);
  lines.push(`导出函数：${result.exported} 个`);
  lines.push(`有生产调用方：${result.wired} 个 ｜ 死函数：${result.dead.length} 个 ｜ 允许清单：${result.allowed.length} 条（命中 ${result.allowed.filter((a) => a.matched).length} 条）｜ 无法判定：${result.undetermined.length} 条`);
  lines.push('');

  lines.push('--- 死函数清单（导出了但生产代码里没有调用方）---');
  if (!result.dead.length) {
    lines.push('  （无）');
  } else {
    for (const d of result.dead) {
      lines.push(`  ${d.file} :: ${d.name}`);
      const hints = [];
      if (d.tests.length) hints.push(`${d.tests.join('、')} 里直接调用过它 ⇒ 被测了但没接线`);
      if (d.scripts.length) hints.push(`只有 ${d.scripts.join('、')}（运维脚本，非产品路径）在调用它 ⇒ 不在 HTTP 路径上`);
      if (d.sameFile.length) hints.push(`只有它自己所在的文件在调用它（${d.sameFile.join('、')}）⇒ 导出了但没有外部调用方`);
      if (d.refs.length) {
        const where = d.refs.map((r) => `${r.file}:${r.line}`).join('、');
        hints.push(`只被当作值引用（回调/传参，${where}），没有直接调用 ⇒ 按本闸口径不算接线`);
      }
      if (!hints.length) hints.push('测试、脚本、同文件里都没找到调用，也没找到值引用 ⇒ 从未被任何地方提起过');
      lines.push(`    └ 排查提示：${hints.join('；')}`);
    }
  }
  lines.push('');

  lines.push('--- 允许清单（有意豁免）---');
  if (!result.allowed.length) {
    lines.push(`  （无；允许清单：${result.allowPath}）`);
  } else {
    for (const a of result.allowed) {
      const mark = a.matched ? '' : '  ⚠️ 这条没有命中任何死函数（豁免已过期，或文件名/函数名写错了）';
      lines.push(`  ${a.file} :: ${a.name} —— ${a.reason}${mark}`);
    }
  }
  lines.push('');

  lines.push('--- 无法判定（保守不报，需人工看一眼）---');
  if (!result.undetermined.length) {
    lines.push('  （无）');
  } else {
    for (const u of result.undetermined) {
      lines.push(`  ${u.file} :: ${u.name} —— ${u.reason}`);
    }
  }
  lines.push('');
  lines.push(result.dead.length
    ? `结论：${result.dead.length} 个死函数 ⇒ 退出码 1`
    : '结论：没有死函数 ⇒ 退出码 0');
  return lines.join('\n');
}

/** 命令行主流程 */
export function main(argv) {
  const args = argv.slice();
  let json = false;
  let allowPath = null;
  let platformDir = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--allow') {
      allowPath = args[i + 1];
      if (!allowPath) {
        console.error('用法： node docs/tools/dead-service-scan.mjs [--json] [--allow <path>] [platformDir]');
        return 2;
      }
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      console.error(`未知参数：${a}`);
      console.error('用法： node docs/tools/dead-service-scan.mjs [--json] [--allow <path>] [platformDir]');
      return 2;
    }
    if (platformDir === null) platformDir = a;
  }
  const dir = resolve(platformDir || DEFAULT_PLATFORM_DIR);
  if (!existsSync(dir)) {
    console.error(`⛔ platform 目录不存在：${dir}`);
    return 2;
  }
  let result;
  try {
    result = scanPlatform(dir, { allowPath: allowPath ? resolve(allowPath) : undefined, allowRequired: !!allowPath });
  } catch (err) {
    console.error(`⛔ 扫描失败：${err.message}`);
    return 2;
  }
  if (json) {
    console.log(JSON.stringify({
      scannedFiles: result.scannedFiles,
      exported: result.exported,
      wired: result.wired,
      dead: result.dead.map((d) => ({
        file: d.file, name: d.name, tests: d.tests, scripts: d.scripts, sameFile: d.sameFile, refs: d.refs,
      })),
      allowed: result.allowed,
      undetermined: result.undetermined,
    }, null, 2));
  } else {
    console.log(formatText(result));
  }
  return result.dead.length ? 1 : 0;
}

// ⚠️ 主流程只在**直接运行时**执行 ⇒ 回归测试可以 `import { scanPlatform }` 而不触发扫描。
//    `import.meta.main`（Node ≥ 22.16）；老版本上兜底用 argv[1] 比对，避免静默不跑。
const IS_MAIN = import.meta.main === true
  || (typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (IS_MAIN) {
  process.exitCode = main(process.argv.slice(2));
}

// platform/test/sql-boundary.test.js —— 「SQL 边界」守卫
//
// 规则溯源：
//   - 全局约束「所有 SQL 字符串必须收在 platform/src/db/repo/ 下；
//     handler / 脚本里禁止裸 SQL」→ 设计文档 §7.2 + 评审编号 I-7
//     （终审发现 scripts/seed.js 有 5 处裸 SQL 越过这条约束）。
//   - 「SQL 只存在于仓储层」是分层的前提：handler 里出现 SQL 字符串，
//     就意味着 SQL 又从业务代码里长出来了（seed.js 的 5 处裸 SQL 就是这么来的）。
//
// 判定规则（保守、可解释 —— **宁可漏报也不要误报**）：
//   扫描 src/ 与 scripts/ 下所有 .js 文件（**排除 src/db/repo/**），
//   若出现 `db.prepare(` / `db.exec(` 调用，且**它的参数里**含 SQL 关键字
//   （SELECT / INSERT / UPDATE / DELETE / CREATE TABLE / DROP / ALTER，大小写不敏感）
//   → 判违规。
//   注释里的提及不算数：先把注释剥成等长空白再判定，
//   但**字符串字面量内容原样保留**（SQL 本来就住在字符串里）。
//
// 豁免（各有理由，写在代码里）：
//   - src/db/repo/**  → 仓储层：SQL 的唯一归宿，本来就该有 SQL。
//   - src/db/migrate.js → 迁移执行器：按契约持有 SQL（建 schema_migrations 表、
//     读版本、插版本记录、执行 .sql 文件）。它既不是 handler 也不是业务仓储，
//     迁移 SQL 也不能塞进业务仓储层。
//   注意 src/db/sqlite.js **不豁免**：它只跑 PRAGMA（WAL / foreign_keys / busy_timeout），
//   PRAGMA 不在上面的关键字表里 → 天然不触发判定；一旦它长出业务 SQL 就会被抓住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集目录下的 .js 文件（readdirSync + withFileTypes，零依赖）。 */
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
 * （与 test/zero-deps.test.js 里的同名 helper 重复：本轮评审限定只能改那 6 个文件，
 *   不允许另建共享 helper 文件；两个文件各自独立可跑。）
 */
function stripComments(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  const frames = [{ kind: 'code', depth: 0 }];
  const top = () => frames[frames.length - 1];
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

    if (c === '\\') { i += 2; continue; }
    if (c === '`') { frames.pop(); lastCodeChar = '`'; i += 1; continue; }
    if (c === '$' && c2 === '{') { frames.push({ kind: 'code', depth: 0 }); i += 2; continue; }
    i += 1;
  }
  return out.join('');
}

/** 取出代码里所有字符串/模板字面量（含起始下标与内容）。 */
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

/** 从 openIdx（'(' 的下标）起找配对的 ')'，跳过字符串/模板内容。 */
function matchParen(code, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === c) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** SQL 关键字（大小写不敏感）。CREATE 单独出现不算（CREATE TABLE 才算）。 */
const SQL_KEYWORD = /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b|\bCREATE\s+TABLE\b/i;

/** 找出文件里的「db.prepare( / db.exec( 调用点」。 */
function findDbCalls(code) {
  const calls = [];
  const re = /\bdb\s*\.\s*(?:prepare|exec)\s*\(/g;
  let m = re.exec(code);
  while (m !== null) {
    const open = code.indexOf('(', m.index);
    const close = matchParen(code, open);
    calls.push({ start: m.index, args: code.slice(open + 1, close === -1 ? code.length : close) });
    m = re.exec(code);
  }
  return calls;
}

/**
 * 扫描一个目录，返回违规列表（相对路径 + 行号 + 命中的 SQL 文本）。
 * exempt(relPath) 返回 true 表示该文件豁免。
 */
function scanForSql(dir, exempt) {
  const violations = [];
  for (const file of collectJsFiles(dir)) {
    const rel = relative(root, file);
    if (exempt(rel)) continue;
    const raw = readFileSync(file, 'utf8');
    const code = stripComments(raw);
    for (const call of findDbCalls(code)) {
      for (const lit of stringLiterals(call.args)) {
        if (!SQL_KEYWORD.test(lit.value)) continue;
        let line = 1;
        for (let i = 0; i < call.start && i < raw.length; i += 1) {
          if (raw[i] === '\n') line += 1;
        }
        violations.push({
          file: rel,
          line,
          sql: lit.value.replace(/\s+/g, ' ').trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

/** 豁免清单（理由写在上面文件头注释里）。路径统一成正斜杠，跨平台一致。 */
function isExempt(rel) {
  const posix = rel.split(sep).join('/');
  // 仓储层：SQL 的唯一归宿
  if (posix.startsWith('src/db/repo/')) return true;
  // 迁移执行器：按契约持有 SQL（既不是 handler 也不是业务仓储）
  if (posix === 'src/db/migrate.js') return true;
  return false;
}

test('src/ 与 scripts/ 里除仓储层外没有裸 SQL', () => {
  const violations = [
    ...scanForSql(join(root, 'src'), isExempt),
    ...scanForSql(join(root, 'scripts'), isExempt),
  ];
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} 出现 SQL：${v.sql}`),
    [],
    'SQL 必须收在 src/db/repo/ 下（handler / 脚本里禁止裸 SQL）',
  );
});

test('SQL 边界守卫自己有效：仓储层里的 SQL 会被抓出来（阳性对照）', () => {
  // ⛔ 防「扫描器坏了 → 一条都抓不到 → 测试假绿」。
  const inRepo = scanForSql(join(root, 'src', 'db', 'repo'), () => false);
  assert.ok(inRepo.length > 0, '阳性对照失败：扫描器没抓到仓储层里的 SQL，说明扫描器坏了');
});

test('迁移执行器确实执行 SQL（豁免有据，不是漏判）', () => {
  // src/db/migrate.js 被豁免的理由是「它按契约持有 SQL」—— 这条断言把这个理由钉住。
  const raw = readFileSync(join(root, 'src', 'db', 'migrate.js'), 'utf8');
  const code = stripComments(raw);
  const calls = findDbCalls(code);
  const withSql = calls.filter((call) =>
    stringLiterals(call.args).some((lit) => SQL_KEYWORD.test(lit.value)),
  );
  assert.ok(withSql.length > 0, 'migrate.js 里应存在带 SQL 关键字的 db.prepare/db.exec 调用');
});

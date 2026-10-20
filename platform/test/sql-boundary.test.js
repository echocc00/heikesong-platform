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
//
// ⚠️ **已知绕过形态（终审 Minor M-4 显式登记 —— 宁可漏报也不要误报的代价）**：
//   本守卫是**基于正则的形态匹配**，下面三种现实写法**抓不到**（实测探针全 MISSED）：
//     ① SQL 存进变量再传进去：
//          const sql = 'SELECT * FROM users'; db.prepare(sql);
//        （参数是标识符不是字符串字面量 → 扫不到）
//     ② 下标式调用：
//          db['prepare']('SELECT * FROM users');
//        （正则只认 `db.prepare(` / `db.exec(` 点号形态）
//     ③ 连接变量不叫 `db`：
//          conn.prepare('SELECT * FROM users');
//        （正则锚定的是标识符 `db`）
//   这三条是**有意接受**的：把判定放宽到「任意 .prepare( 调用」会误报一大片
//   （仓储层之外的代码里 db.prepare 大量用于非 SQL 的语句）。
//   代码评审时人工盯这三种写法；本守卫负责的是「裸 SQL 回到 handler 里」这个
//   **主流回归**（终审实测：seed.js 的 5 处裸 SQL 被它抓到）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test-helpers/strip-comments.js';

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
 * 扫描**一段源码**，返回违规列表（相对路径 + 行号 + 命中的 SQL 文本）。
 *
 * ⚠️ 终审修正（Minor，M-3）：这段逻辑原先内联在 scanForSql 里，
 *    只能扫**目录** —— 想断言「扫描器自己能不能抓」就只能往真实源码树里
 *    塞一个带 SQL 的假文件（污染工作树）。抽成纯函数后可以对**合成源码**直接断言。
 */
function scanCode(raw, rel) {
  const violations = [];
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
  return violations;
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
    violations.push(...scanCode(readFileSync(file, 'utf8'), rel));
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

test('SQL 边界守卫自己有效：exec / DELETE / CREATE TABLE 每种形态都能被抓（终审 M-3）', () => {
  // ⛔ 终审修正（Minor，M-3）：原来的阳性对照只有一条「仓储层里能抓到 SQL」，
  //    它**不区分抓到的是哪种形态** —— 把 findDbCalls 的正则去掉 `exec`、
  //    或把 SQL_KEYWORD 表里的 `DELETE` 删掉，这条对照照样绿（实测 I7-b / I7-c 均 SURVIVED）。
  //    这里对**合成源码**逐个断言：每种形态都必须被抓到一次。
  const CASES = [
    { label: 'db.exec + SELECT', code: "db.exec('SELECT * FROM users');" },
    { label: 'db.prepare + SELECT', code: "db.prepare('SELECT * FROM users WHERE id = ?');" },
    { label: 'db.exec + DELETE', code: "db.exec('DELETE FROM users');" },
    { label: 'db.prepare + DELETE', code: "db.prepare('DELETE FROM users WHERE id = ?');" },
    { label: 'db.exec + CREATE TABLE', code: "db.exec('CREATE TABLE t (id INTEGER)');" },
    { label: 'db.prepare + CREATE TABLE', code: "db.prepare('CREATE TABLE t (id INTEGER)');" },
    { label: 'db.prepare + INSERT', code: "db.prepare('INSERT INTO t VALUES (?)');" },
    { label: 'db.prepare + UPDATE', code: "db.prepare('UPDATE t SET a = ?');" },
    { label: 'db.prepare + DROP', code: "db.prepare('DROP TABLE t');" },
    { label: 'db.prepare + ALTER', code: "db.prepare('ALTER TABLE t ADD COLUMN b INTEGER');" },
  ];
  for (const c of CASES) {
    const v = scanCode(c.code, '<synthetic>');
    assert.equal(
      v.length,
      1,
      `${c.label} 必须被判违规（实际 ${JSON.stringify(v)}）`,
    );
  }

  // 反例对照：不含 SQL 关键字的调用不得误报（否则这条用例会退化成「一律违规」的恒绿）
  const NEG = [
    "db.exec('PRAGMA journal_mode = WAL');",
    "db.prepare('?');",
    "const x = db.getUserById(1);",
  ];
  for (const code of NEG) {
    const v = scanCode(code, '<synthetic>');
    assert.deepEqual(v, [], `不得误报：${code}（实际 ${JSON.stringify(v)}）`);
  }
});

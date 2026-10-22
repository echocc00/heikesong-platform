# P0 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一个能登录的空系统：零依赖运行时、SQLite 数据层、fail-fast 规则配置、HTTP 路由、服务端会话、capability + assignment 权限骨架、静态前端。

**Architecture:** 单进程 Node（仅标准库）。`src/http/` 提供路由与响应；`src/db/` 提供 SQLite 封装、迁移与仓储层（所有 SQL 收在这里）；`src/domain/` 放纯函数规则引擎（无 IO，本阶段先建空壳接口）；`src/auth/` 管认证与权限判定；`src/config.js` 加载并校验 `rules/*.json`，校验不过直接拒绝启动。前端为原生 ESM，`web/` 静态托管，`web/api.js` 与 `web/api.demo.js` 双适配器共用同一套视图。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

## Global Constraints

```
运行时      Node ≥ 22.16.0（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite。data/app.db，WAL 模式。单写者：禁止多 worker 写同一文件
测试        node:test。命令：node --test
            ⚠️ 不要写成 `node --test test/`：Node 22 的位置参数按 glob/模块路径处理，
               目录【不会】被展开 → MODULE_NOT_FOUND，pass 0 / fail 1。
               实测（Node v22.23.2）：`node --test` ✅ ｜ `node --test test/` ❌ ｜
               `node --test test/xxx.test.js` ✅（单文件形式合法）
               依据：设计文档 §4.3 的 package.json 片段本身就是 `"test":"node --test"`。
密码        node:crypto scrypt，存储格式 scrypt$N$r$p$<salt_b64>$<hash_b64>，比对用 timingSafeEqual
会话        服务端 session 表，token 只存 SHA-256 哈希；Cookie HttpOnly + SameSite=Lax + Path=/
代码目录    platform/
规则配置    platform/rules/*.json，一切可变规则只改 JSON
配置校验    fail-fast：权重合计≠100% / 阈值不单调 / 段位门槛不递增 → 拒绝启动并报错
权限模型    capability + assignment；判定只有一个入口 can(user, capability, ctx)
作用域      上级作用域**不隐式下推**：edition 授权不自动覆盖其下的 task_package
三态状态码  列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403
SQL 边界    所有 SQL 收进 src/db/repo/；handler 内禁止裸 SQL
规则溯源    每条规则在代码注释里写明来源文档与章节
禁用清单    platform/scripts/forbidden.txt 不得为空
```

## File Structure

**本阶段创建**

```
platform/
├── package.json                  零依赖，仅 type:module + scripts
├── rules/                        9 份规则配置（配置驱动的基础）
│   ├── scoring-initial.json
│   ├── scoring-final.json
│   ├── tiebreak.json
│   ├── ranks.json
│   ├── behavior-points.json
│   ├── visibility.json
│   ├── registration-scoring.json
│   ├── solvability.json
│   └── milestones.default.json
├── src/
│   ├── errors.js                 领域错误 AppError（status-first，全项目唯一错误类型）
│   ├── server.js                 进程入口：建库 → 迁移 → 校验配置 → 装配路由 → 监听
│   ├── config.js                 配置加载 + fail-fast 校验
│   ├── http/
│   │   ├── router.js             方法+路径 → handler，支持 :param
│   │   ├── respond.js            JSON / 文本 / 错误响应
│   │   ├── body.js               JSON body 解析（带大小上限）
│   │   ├── static.js             静态文件服务（ETag）
│   │   └── sse.js                SSE 事件总线（**P2 才建**；P0/P1 没有这个端点）
│   ├── auth/
│   │   ├── password.js           scrypt 哈希与校验
│   │   ├── session.js            会话签发/校验/吊销（不含 SQL）
│   │   └── permissions.js        capability + assignment 判定（不含 SQL）
│   ├── db/
│   │   ├── sqlite.js             连接封装 + 迁移执行
│   │   ├── migrate.js            迁移文件读取与应用
│   │   └── repo/
│   │       ├── users.js           用户仓储 + toPublicUser（唯一对外形状）
│   │       ├── sessions.js        会话仓储（SQL 全在这）
│   │       ├── assignments.js     授权仓储（SQL 全在这）
│   │       ├── capabilities.js    能力点 + 角色能力映射仓储（SQL 全在这）
│   │       └── roles.js           角色 + 用户角色仓储（SQL 全在这）
│   └── audit/
│       └── log.js                审计日志写入（**P2 才建**；P0 不创建）
├── db/migrations/001_init.sql    初始表结构
├── web/
│   ├── index.html
│   ├── app.js
│   ├── router.js
│   ├── store.js
│   ├── api.js
│   ├── api.demo.js
│   ├── escape.js
│   ├── styles.css
│   └── views/login.js
├── scripts/
│   ├── migrate.js
│   ├── seed.js
│   └── forbidden.txt
├── test-helpers/
│   └── strip-comments.js        共享的「剥掉注释」工具（三个测试文件共用）
└── test/
    ├── zero-deps.test.js
    ├── migrate.test.js
    ├── config.test.js
    ├── router.test.js
    ├── body.test.js
    ├── password.test.js
    ├── session.test.js
    ├── users.test.js
    ├── permissions.test.js
    ├── server.test.js
    ├── seed.test.js
    └── web.test.js
```

---

### Task 1: 零依赖骨架与"零依赖"守卫

**Files:**
- Create: `platform/package.json`
- Create: `platform/test/zero-deps.test.js`
- Create: `platform/test-helpers/strip-comments.js`
- Create: `platform/README.md`

**Interfaces:**
- Consumes: 无
- Produces: `npm test` 可用（`node --test`）；`npm start` 指向 `src/server.js`（本阶段先占位，后续 Task 替换）

- [ ] **Step 1: 写失败的测试**

`platform/test/zero-deps.test.js`：

```javascript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/zero-deps.test.js`
Expected: FAIL —— `ENOENT: no such file or directory, open 'platform/package.json'`

- [ ] **Step 3: 创建 package.json**

`platform/package.json`：

```json
{
  "name": "heikesong-platform",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.16.0" },
  "scripts": {
    "start": "node --disable-warning=ExperimentalWarning src/server.js",
    "test": "node --disable-warning=ExperimentalWarning --test",
    "migrate": "node --disable-warning=ExperimentalWarning scripts/migrate.js",
    "seed": "node --disable-warning=ExperimentalWarning scripts/seed.js"
  }
}
```

- [ ] **Step 4: 创建 README.md**

`platform/README.md`：

```markdown
# AI 商业黑客松赛事平台

零依赖 Node 单体。`git clone` 后不需要 `npm install`，直接：

```bash
node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test               # 跑测试
```

## 运行环境

- **Node ≥ 22.16.0**。这个下限是**两个下限的并集** = max(22.13.0, 22.16.0)：

  | 下限 | 原因 | 出处 |
  |---|---|---|
  | 22.13.0 | `node:sqlite` 免 `--experimental-sqlite` 标志。22.5.0–22.12.x 上 import 直接抛错，而本项目四个 scripts 都不带该标志 | Node v22 文档 SQLite 页 History 表 |
  | 22.16.0 | `sqlite.backup()` —— §14 备份方案依赖它（P6 阶段的备份/恢复脚本就是它） | 同上，`sqlite.backup` 条目 `Added in: v22.16.0` |

  来源：<https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
  官方原文：`v22.5.0 Added in: v22.5.0` / `v22.13.0 SQLite is no longer behind --experimental-sqlite but still experimental.` / `sqlite.backup(sourceDb, destination[, options])` — `Added in: v22.16.0`。详见设计文档 §4.2「运行时与依赖」。

  `package.json` 的 `engines` 是**项目级单一声明**，表达的是整个系统的运行时下限，不是 P0 此刻用到的下限。因此 P0 实际只用得到 22.13.0，`>=22.16.0` 是**保守声明**：它不会拒掉任何能跑的 Node，只是提前挡掉 22.13–22.15（这三个小版本早已无人使用，22.16.0 发布于 2025-02）。**声明一个跑不起来的版本比声明一个略严的版本更糟** —— 前者让用户以为装完就能用、装了才炸。

- **`node:sqlite` 在 Node 22.x 仍是 experimental（Stability 1.1 - Active development）**。package.json 的四个 scripts 用 `--disable-warning=ExperimentalWarning` **按告警类型整体屏蔽**这条告警 —— 不是逐条压制，也不掩盖真实错误。直接用 `node` 手动跑而不走 npm scripts 时，该告警会重新出现，属预期。

- 生产仍推荐 **Node 24**；本项目**不使用任何 Node-24-only API**（Node 22 没有 `URLPattern` → 路由手写，不因此抬高运行时门槛）。

- **`engines` 在 npm 里默认只是建议性的** —— 版本不满足时只会打印 `EBADENGINE` 警告，除非 `.npmrc` 里设了 `engine-strict=true` 才会阻断安装。本项目零依赖、不走 `npm install`，因此这个下限是**自检性质**的：跑不动时会在 import `node:sqlite` 处直接报错，而不是装的时候被拦住。

## 硬约束

- **npm 依赖 0 个**。只用 Node 标准库。`test/zero-deps.test.js` 会守住这条。
- **规则不写死在代码里**。可变规则全在 `rules/*.json`，改 JSON 即改规则。
- **配置校验 fail-fast**。权重合计不等于 100% 就拒绝启动，不静默降级。
- **行为分不进总分**。总分函数的签名里就没有行为分参数。
- **两种"企业签字"是两张表**。`enterprise_confirmations`（主观评分，进总分）/ `milestone_signoffs`（客观事实，不进总分）。
- **可见性在 API 层过滤**。前端拿不到无权数据。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `DATA_DIR` | `./data` | 数据库与上传目录 |
| `SESSION_TTL_DAYS` | 7 | 会话滑动有效期（天） |
| `SESSION_ABSOLUTE_TTL_DAYS` | 30 | 会话**绝对过期上限**（天，从签发时刻算起）。滑动续期不得突破它 —— 否则令牌一旦泄露就能一直刷新自己 |
| `ADMIN_PASSWORD` | 无 | **`scripts/seed.js` 必填**。不设就报错退出（退出码非 0）、**不建库不建账号**。没有任何默认口令兜底 —— 写死的默认口令等于把超管口令公开 |
| `NODE_ENV` | — | 设为 `production` 时 Cookie 加 `Secure`（开发环境不加，`http://127.0.0.1` 会被浏览器拒收） |

> 种子脚本的用法：
> ```bash
> ADMIN_PASSWORD='你的强口令' node scripts/seed.js
> ```
> 口令本身不会被打印到 stdout。

## 设计文档

`../docs/superpowers/specs/2026-10-20-heikesong-platform-design.md`
```

> **为什么命令里没有 `--disable-warning=ExperimentalWarning`**：`npm run start` / `npm test` 等
> 脚本里已经带上了。直接 `node xxx.js` 时 Node 22 会对内置 `node:sqlite` 打印
> `ExperimentalWarning`（实验特性提示），不影响功能，只影响输出整洁度。

## 硬约束

- **npm 依赖 0 个**。只用 Node 标准库。`test/zero-deps.test.js` 会守住这条。
- **规则不写死在代码里**。可变规则全在 `rules/*.json`，改 JSON 即改规则。
- **配置校验 fail-fast**。权重合计不等于 100% 就拒绝启动，不静默降级。
- **行为分不进总分**。总分函数的签名里就没有行为分参数。
- **两种"企业签字"是两张表**。`enterprise_confirmations`（主观评分，进总分）/ `milestone_signoffs`（客观事实，不进总分）。
- **可见性在 API 层过滤**。前端拿不到无权数据。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `DATA_DIR` | `./data` | 数据库与上传目录 |
| `SESSION_TTL_DAYS` | 7 | 会话有效期 |

## 设计文档

`../docs/superpowers/specs/2026-10-20-heikesong-platform-design.md`
```

- [ ] **Step 5: 创建共享的注释剥离工具 `platform/test-helpers/strip-comments.js`**

> **【2026-10-21 终审复核引入】** 三个测试文件需要**同一个**「剥掉注释」的 helper：
> `zero-deps.test.js`（扫 import）、`sql-boundary.test.js`（扫 SQL）、`server.test.js`（扫接线断言）。
> 此前前两个文件**各抄了一份**（逐字相同，只差注释）→ 改一处要改两处，必然漂移；
> 终审复核（Minor F-3）指出第三处也需要它，于是抽出成本文件。
> ⚠️ **不能放在 `test/` 目录下**：Node 的测试运行器会把**任何名为 `test` 的目录**下的
> 所有 `.js` / `.cjs` / `.mjs` 文件**都当成测试文件**（Node 文档：目录名为 `test` 时递归搜全部 JS），
> 放在 `test/helpers/` 下会被算成一条「测试」→ 用例总数凭空 +1。
> `test-helpers/` 不匹配任何发现规则（发现规则只看**文件名**：`^test$` / `^test-.+` / `^.+[.\-_]test$`，
> 而 `strip-comments.js` 都不匹配）→ 不会被误认成测试文件。

`platform/test-helpers/strip-comments.js`：

```javascript
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
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/zero-deps.test.js`
Expected: PASS（9 个测试全过：zero-deps 9）

- [ ] **Step 7: 提交**

```bash
cd platform && git add package.json README.md test/zero-deps.test.js
git commit -m "feat(P0): 零依赖骨架与零依赖守卫测试"
```

---

### Task 2: SQLite 封装与迁移机制

> **【2026-10-20 评审后修正 · 第 2 轮】** 复评 Approved 后又发现 2 处**同源**缺陷，已一并修正：
> **④** 版本号解析过宽 —— `Number(name.split('_')[0])` 会把 `_init.sql` 当成版本 0、
>      把 `1e3_x.sql` 静默解析成版本 1000，在「全局唯一序位」（001=P0 … 006=P5）上
>      开出静默缺口。改为严格正则 `/^(\d+)_/`，错误文案也改准（"必须形如 NNN_name.sql"）。
> **⑤** 同版本号冲突时，错误信息里两个文件名的先后取决于 `readdirSync` 的返回顺序 ——
>      POSIX 未定义该顺序（ext4/xfs 是 hash 序），本机 APFS 实测稳定但换平台可能翻转，
>      会让测试正则偶发失配 → CI 偶发红，违反 R-OPS-02 跨平台稳定。
>      改为同版本号按文件名**字节序**二次排序。
>
> **【2026-10-20 评审后修正 · 第 1 轮】** 本 Task 的代码块已按实现回写（评审判定 Needs fixes，3 条 Important）。
> 修正三处：**①** `engines.node` 由 `>=22.5.0` 改为 `>=22.16.0`（22.5.0 只是 `node:sqlite` 的引入版本，
> 22.5.0–22.12.x 免不了 `--experimental-sqlite` 标志会直接抛错；`sqlite.backup()` 又需 ≥22.16.0，取并集）；
> **②** `readMigrationFiles` 增加**重复版本号 fail-fast**（原实现按 version 静默去重 → 第二次运行
> 打印"本次无新迁移"、退出码 0，而被遮蔽的那张表永远建不出来，schema 缺口被静默固化）；
> **③** 新增**真实 `001_init.sql` 冒烟测试**（原实现的测试全部用临时目录内联 SQL，
> 真实 DDL 从未被 apply 过，可带错而 CI 全绿）。详见 Step 1 的测试清单与下方代码块。
> 归因与官方出处见设计文档 §4.2「运行时与依赖」。

**Files:**
- Create: `platform/src/db/sqlite.js`
- Create: `platform/src/db/migrate.js`
- Create: `platform/db/migrations/001_init.sql`
- Create: `platform/scripts/migrate.js`
- Create: `platform/test/migrate.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `openDatabase({ dataDir })` → `{ db, close() }`，已开启 WAL 与 foreign_keys
  - `applyMigrations(db, migrationsDir)` → `{ applied: string[], version: number }`
  - `readMigrationFiles(dir)` → `[{ version, name, sql }]`（按 version 升序）

- [ ] **Step 1: 写失败的测试**

`platform/test/migrate.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations, readMigrationFiles } from '../src/db/migrate.js';

// 真实迁移目录（platform/db/migrations）—— 本文件在 platform/test/ 下，故取上一级。
// 真实 DDL 必须被真正 apply 过：否则 001_init.sql 可以带着语法/外键/类型错误
// 而 CI 全绿（迁移文件本身从不进任何测试夹具）。
const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-mig-'));
}

test('迁移按版本升序读取', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '002_second.sql'), 'CREATE TABLE b (x INTEGER);');
  writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
  const files = readMigrationFiles(dir);
  assert.deepEqual(files.map((f) => f.version), [1, 2]);
  rmSync(dir, { recursive: true, force: true });
});

test('迁移是幂等的：重复执行不重复应用', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  const first = applyMigrations(db, dir);
  assert.equal(first.applied.length, 1);

  const second = applyMigrations(db, dir);
  assert.equal(second.applied.length, 0, '第二次不应再应用');
  assert.equal(second.version, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('WAL 与 foreign_keys 已开启，busy_timeout 为 5000ms', () => {
  // ⚠️ 终审修正（Minor，M-6）：busy_timeout 此前**零断言** ——
  //    把 `PRAGMA busy_timeout = 5000` 删掉，全量照样全绿（实测 D2 SURVIVED）。
  //    它是 SQLite 的**写锁等待**上限：写并发时拿不到锁就等 5 秒再报 SQLITE_BUSY。
  //    去掉它 → busy_timeout 变 0 → 并发写直接抛 BUSY，报名/评审的并发提交会随机失败。
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000, 'busy_timeout 必须是 5000ms');
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('重复版本号：响亮报错，而不是静默跳过', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE b (x INTEGER);');

  // 错误信息必须同时含版本号与冲突的两个文件名
  assert.throws(
    () => readMigrationFiles(dir),
    /迁移版本号重复: 001 \(001_a\.sql, 001_b\.sql\)/,
  );

  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  assert.throws(() => applyMigrations(db, dir), /迁移版本号重复/);

  // 报错发生在应用任何 SQL 之前：连 schema_migrations 都不该被建出来
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [], '重复版本号时不应执行任何迁移 SQL');

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('已应用的迁移文件被改名：响亮报错，而不是静默跳过', () => {
  const dir = tempDir();
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  const first = applyMigrations(db, dir);
  assert.deepEqual(first.applied, ['001_a.sql']);

  // 模拟迁移文件被改名/挪位：版本号不变，文件名变了
  rmSync(join(dir, '001_a.sql'));
  writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE a (x INTEGER);');

  assert.throws(
    () => applyMigrations(db, dir),
    /迁移 001 已以 001_a\.sql 应用，当前文件名为 001_b\.sql；迁移文件名不可变更/,
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test('退化迁移文件名会被拒绝（不静默开版本缺口）', () => {
  // "_init.sql" —— Number('') === 0，会被当成版本 0
  const dirA = tempDir();
  writeFileSync(join(dirA, '_init.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirA), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirA, { recursive: true, force: true });

  // "1e3_x.sql" —— Number('1e3') === 1000，会静默跳到版本 1000，
  // 在「全局唯一序位」（001=P0 … 006=P5）上开出一个静默缺口
  const dirB = tempDir();
  writeFileSync(join(dirB, '1e3_x.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirB), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirB, { recursive: true, force: true });

  // "001.sql" —— 缺下划线
  const dirC = tempDir();
  writeFileSync(join(dirC, '001.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirC), /迁移文件名必须形如 <版本号>_<名称>\.sql/);
  rmSync(dirC, { recursive: true, force: true });
});

test('macOS 的 AppleDouble 伴生文件（._xxx）被忽略 —— 它不是迁移', () => {
  // 真机实测（2026-10-21，8.133.200.235 / Debian 12 / ext4）：
  //   按 P6 计划 Step 4 的「跨平台复现」配方把 platform/ 从 macOS 拷到 Linux 时，
  //   `tar` 会给每个文件配一个 `._xxx` 资源叉载体 ⇒ 迁移直接失败。
  //   ⚠️ 这条**不是**放宽「退化迁移文件名会被拒绝」那条守卫：
  //   `init.sql` / `1e3_x.sql` / `01_.sql` 仍然照旧抛错（见上一条用例）。
  const dir = tempDir();
  writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE a (x INTEGER);');
  // 伴生文件的内容是 AppleDouble 二进制，不是 SQL —— 真读进去必然炸
  writeFileSync(join(dir, '._001_init.sql'), Buffer.from([0x00, 0x05, 0x16, 0x07, 0xff, 0xfe]));
  writeFileSync(join(dir, '._999_ghost.sql'), Buffer.from([0x00, 0x05, 0x16, 0x07]));

  const files = readMigrationFiles(dir);
  assert.equal(files.length, 1, `伴生文件必须被忽略，实际读到 ${files.length} 个：${files.map((f) => f.name).join('、')}`);
  assert.equal(files[0].name, '001_init.sql');
  assert.equal(files[0].version, 1);

  // ⛔ 反向：伴生文件**不得**让真正的迁移被吞掉（也不能凭空造出版本号）
  assert.ok(!files.some((f) => f.name.startsWith('._')), '伴生文件不得出现在迁移列表里');
  assert.ok(!files.some((f) => f.version === 999), '伴生文件的版本号不得被当成真实迁移');

  rmSync(dir, { recursive: true, force: true });
});

test('同版本号冲突时错误信息里的文件名顺序是确定的（跨平台稳定）', () => {
  // readdirSync 的返回顺序在 POSIX 里未定义：APFS 按名序、ext4/xfs 按 hash 序。
  // 错误信息里的两个文件名由实现**显式**按字节序排好 —— 跨平台保证由构造成立，
  // 不依赖 readdir 恰好有序（这条保证在 macOS 上无法用变异检出，靠的是构造本身）。
  for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
    const dir = tempDir();
    writeFileSync(join(dir, `001_${first}.sql`), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, `001_${second}.sql`), 'CREATE TABLE b (x INTEGER);');
    assert.throws(
      () => readMigrationFiles(dir),
      /迁移版本号重复: 001 \(001_a\.sql, 001_b\.sql\)/,
      '同版本号冲突的错误信息必须始终按文件名排序',
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本号必须从 001 起，且描述符不能为空', () => {
  // 0 不是合法序位（001=P0 … 006=P5）
  const dirA = tempDir();
  writeFileSync(join(dirA, '0_x.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirA), /迁移版本号必须从 001 起/);
  rmSync(dirA, { recursive: true, force: true });

  // "01_.sql" —— 描述符为空
  const dirB = tempDir();
  writeFileSync(join(dirB, '01_.sql'), 'CREATE TABLE a (x INTEGER);');
  assert.throws(() => readMigrationFiles(dirB), /迁移文件名必须形如/);
  rmSync(dirB, { recursive: true, force: true });
});

// ⚠️ 下面两条断言的是「当前迁移集」的快照：P1 加入 002_registration.sql 之后，
//    「恰好 9 张表 / schema_migrations 恰好 1 行 / version 仍为 1」需要放宽为
//    「包含 001_init.sql 的那几项」。到 P1 时按此提示修改。
//
// ✅ P1 已按此提示放宽（不再对「张数 / 行数 / 版本号」取快照）：
//    取快照的断言每加一个迁移就必红一次，而它真正要抓的缺陷
//    （漏建表 / 迁移没被应用 / 迁移历史对不上账）由下面这三条照样抓住：
//      ① 每个迁移文件都被应用（applied 逐字等于目录里的文件清单）；
//      ② 期望的表逐个点名，漏建任一张表即红；
//      ③ schema_migrations 的版本号与文件名逐行对账。
//    期望值**从迁移目录本身推导**，因此 P2 加 003 时本用例不需要再改。
test('真实迁移目录：建出全部表并记录版本', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });

  // 期望的迁移文件名与版本号：从真实迁移目录推导（readMigrationFiles 已按版本升序排）
  const expectedFiles = readMigrationFiles(REAL_MIGRATIONS).map((f) => f.name);
  const expectedVersions = readMigrationFiles(REAL_MIGRATIONS).map((f) => f.version);

  const first = applyMigrations(db, REAL_MIGRATIONS);
  assert.deepEqual(first.applied, expectedFiles, '迁移目录里的每个文件都应被应用');
  assert.equal(first.version, Math.max(...expectedVersions), '版本号应为已应用迁移的最大版本');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of [
    'users',
    'sessions',
    'capabilities',
    'roles',
    'role_capabilities',
    'assignments',
    'user_roles',
    'audit_log',
    'schema_migrations',
    // P1（002_registration.sql）的 7 张表
    'editions',
    'cities',
    'task_packages',
    'registrations',
    'registration_events',
    'teams',
    'team_members',
  ]) {
    assert.ok(tables.includes(t), `真实迁移应建出表 ${t}`);
  }

  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  assert.equal(rows.length, expectedFiles.length, 'schema_migrations 行数应等于迁移文件数');
  assert.deepEqual(
    rows.map((r) => r.version),
    expectedVersions,
    'schema_migrations 的版本号应与迁移文件一致',
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    expectedFiles,
    'schema_migrations 的文件名应与迁移文件一致',
  );

  // 幂等：再跑一次不应再应用
  const second = applyMigrations(db, REAL_MIGRATIONS);
  assert.deepEqual(second.applied, [], '真实迁移重复执行不应再应用');
  assert.equal(second.version, first.version, '重复执行后版本号不应变化');

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('真实 schema 下外键约束确实生效', () => {
  const dataDir = tempDir();
  const { db } = openDatabase({ dataDir });
  applyMigrations(db, REAL_MIGRATIONS);

  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('u1', '张三', '13800000000', 'hash', now);

  // 指向存在的用户 → 外键放行
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run('token-hash-1', 'u1', now, now);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    1,
    '指向真实用户的 session 应插入成功',
  );

  // 指向不存在的用户 → 外键拦下
  assert.throws(
    () => {
      db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run('token-hash-2', 'no-such-user', now, now);
    },
    /FOREIGN KEY constraint failed/,
    '指向不存在用户的 session 应被外键拦下',
  );

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/migrate.test.js`
Expected: FAIL —— `Cannot find module '../src/db/sqlite.js'`

- [ ] **Step 3: 创建 src/db/sqlite.js**

```javascript
// src/db/sqlite.js — SQLite 连接封装
// 依据：设计文档 §4.2。node:sqlite 是同步 API，慢查询会阻塞 event loop，
//       因此所有 SQL 必须在仓储层预编译 + 参数化。
//
// ⚠️ Node 版本下限 = 22.16.0（package.json engines）。这是两个下限的**并集**：
//    - 22.13.0：node:sqlite 不再需要 --experimental-sqlite 标志。
//      v22.5.0–v22.12.x 上 import 本文件会直接抛错（而本项目四个 scripts 都不带该 flag）。
//    - 22.16.0：sqlite.backup() —— §14 备份方案依赖的一致性备份 API（P6 的备份/恢复脚本）。
//    依据：Node v22 官方文档 SQLite 页 History 表
//    （https://nodejs.org/docs/latest-v22.x/api/sqlite.html）原文：
//      v22.5.0   Added in: v22.5.0
//      v22.13.0  SQLite is no longer behind --experimental-sqlite but still experimental.
//    以及 `sqlite.backup(sourceDb, destination[, options])` 条目：Added in: v22.16.0。
//    详见设计文档 §4.2「运行时与依赖」。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SQLite 的「忙类」错误码（可重试）。
 * 依据：sqlite.org/rescode.html
 *   5   SQLITE_BUSY           别的连接在用这个库
 *   6   SQLITE_LOCKED         同一连接内的表被锁
 *   261 SQLITE_BUSY_RECOVERY  别的连接正在做热日志回滚
 *   517 SQLITE_BUSY_SNAPSHOT  WAL 快照冲突
 */
const BUSY_CODES = new Set([5, 6, 261, 517]);

/** 切 WAL 的退避步长（毫秒）。 */
const WAL_RETRY_STEP_MS = 25;

/** 切 WAL 的默认重试预算（毫秒）——与 busy_timeout 同口径（5 秒）。 */
const WAL_RETRY_BUDGET_MS = 5000;

/**
 * 同步退避。node:sqlite 是同步 API，这里不能用 setTimeout
 * （那会把事件循环占住不放，setTimeout 回调排在当前同步代码之后 ⇒ 永远等不到）。
 * Atomics.wait 在 SharedArrayBuffer 上阻塞当前线程，Node 各平台均可用。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 把数据库切到 WAL 模式（读不阻塞写、写不阻塞读，见 sqlite.org/wal.html）。
 *
 * ⚠️ 为什么不能直接 `db.exec('PRAGMA journal_mode = WAL')`：
 *   1. 切 journal_mode 需要**独占锁**；此时库里有别的连接在写就拿不到。
 *   2. **别的连接持有写事务（RESERVED 锁）时，SQLite 的 busy handler 不覆盖这一步**
 *      —— 实测（探针 `probe-wal-lock-2.mjs` 实验 B）：持锁时执行该 PRAGMA 在 **0ms** 内就抛
 *      SQLITE_BUSY(errcode=5)；把 busy_timeout 设成 5000 也一样**立刻**失败，不等。
 *      ⇒ 「先设 busy_timeout 再切 WAL」**不够**，必须自己实现退避重试。
 *      ⚠️ **限定条件**（P4 终审 Minor M-2 实测纠正，别再无条件地转述这句话）：
 *      并非对所有锁型都如此 —— 别的连接持 **EXCLUSIVE** 锁时 busy handler **仍会**等待
 *      （实测 busy_timeout=5000 时等 5485ms 才抛、=1000 时等 1129ms，随 busy_timeout 线性缩放）。
 *      现实故障场景（并发写事务）落在 RESERVED 那一侧 ⇒ 本修法覆盖真实故障；
 *      但「busy handler 一概不覆盖切 WAL」是**过度泛化**的说法。
 *   3. 危险窗口只有**数据库文件首次创建**的那一瞬间：WAL 模式持久化在文件头里，
 *      此后再次执行该 PRAGMA 是 no-op（不取锁，实测 0ms 成功）。
 *      所以「两条连接同时开同一个新库」必有一方撞上第 1 条 → "database is locked"。
 *      这正是 P5 并发建库实测到的失败。
 *
 * ⚠️ WAL 要求所有进程在同一台主机；数据库文件不能放 NFS（sqlite.org/faq.html）。
 *
 * @param {DatabaseSync} db
 * @param {{ budgetMs?: number }} [options] 重试预算（毫秒），默认 5000
 */
function ensureWalMode(db, { budgetMs = WAL_RETRY_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      // 已经是 WAL → 下面的 exec 是 no-op（不取锁），绝大多数连接走这条路径。
      if (db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') return;
      db.exec('PRAGMA journal_mode = WAL');
      const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      if (mode !== 'wal') {
        // SQLite 在文件系统不支持共享内存时会**静默**留在旧模式（sqlite.org/wal.html）。
        // 静默降级会让并发写退化成整库锁 —— 显式报错，不假装成功。
        throw new Error(
          `无法启用 WAL 模式（当前 ${mode}）：数据库文件所在文件系统可能不支持共享内存`
          + '（WAL 要求同主机本地文件系统，见 sqlite.org/wal.html）',
        );
      }
      return;
    } catch (err) {
      if (!BUSY_CODES.has(err.errcode) || Date.now() >= deadline) throw err;
      sleepSync(WAL_RETRY_STEP_MS);
    }
  }
}

export function openDatabase({
  dataDir = './data',
  filename = 'app.db',
  walRetryBudgetMs = WAL_RETRY_BUDGET_MS,
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, filename));

  // ⚠️ 顺序有讲究：busy_timeout 必须**最先**设 —— 它是后续所有取锁操作的等待上限。
  //    遇到锁等待 5 秒再报错，避免瞬时并发直接失败
  db.exec('PRAGMA busy_timeout = 5000');
  // 外键约束默认关闭，必须显式打开
  db.exec('PRAGMA foreign_keys = ON');
  // WAL：读不阻塞写、写不阻塞读（sqlite.org/wal.html）
  ensureWalMode(db, { budgetMs: walRetryBudgetMs });

  return {
    db,
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: 创建 src/db/migrate.js**

```javascript
// src/db/migrate.js — 迁移机制
// 依据：设计文档 §14.2。迁移只向前，不回滚；用 schema_migrations 表记录版本。
//   ⛔ 不赌原生 ALTER TABLE 的能力边界（node:sqlite 捆绑的 SQLite 版本未核实），
//      一律"新表 + 迁移"，expand-contract 三步走。
//   ⛔ 版本号重复 → **响亮抛错**，绝不静默跳过。
//      依据：全局约束「配置校验 fail-fast：权重合计≠100% / 阈值不单调 → 拒绝启动并报错」。
//      同一类缺陷在迁移层的表现是"两个文件抢同一个版本号"：若静默跳过，
//      先跑通的那个版本会把后一个永久遮蔽 —— schema 缺口被固化，
//      而运维看到的是"迁移完成 / 本次无新迁移"、退出码 0，看不出任何异常。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

// 版本号在文件名里的原始写法（保留前导零），仅用于错误信息展示
function versionLabel(name) {
  return name.split('_')[0];
}

export function readMigrationFiles(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    // ⛔ 跳过 macOS 的 **AppleDouble 伴生文件**（`._<原文件名>`）：
    //    从 macOS 往**非 HFS 文件系统**（exFAT/FAT U 盘、或 `tar` 打进 Linux 的流）
    //    拷时，每个文件旁边会多出一个 `._xxx` 资源叉载体 —— 它**不是迁移**，
    //    内容是原文件的资源叉（AppleDouble 格式的二进制），不是 SQL。
    //    真机实测：2026-10-21 在 8.133.200.235（Debian 12 / ext4 / Node 22.22.2）
    //    按 P6 计划 Step 4 的「跨平台复现」配方实跑时，这东西让 `node scripts/migrate.js`
    //    **直接失败**（`迁移文件名必须形如 <版本号>_<名称>.sql: ._001_init.sql`）。
    //
    //    ⚠️ 这**不是**放宽下面那条「迁移文件名必须形如 <版本号>_<名称>.sql」的守卫：
    //    `init.sql` / `1e3_x.sql` / `01_.sql` 这些**人手写错**的名字仍然照旧抛错
    //    （见 test/migrate.test.js 的「退化迁移文件名会被拒绝」用例）。
    //    这里只排除**操作系统产生的伴生文件**这一个类别。
    .filter((f) => !f.startsWith('._'))
    .map((name) => {
      // 严格解析：文件名必须形如 <版本号>_<名称>.sql。
      // ⛔ 不能用 Number(name.split('_')[0])：那样 '_init.sql'（Number('')===0）、
      //    '1e3_x.sql'（Number('1e3')===1000）会被静默当成合法版本号 ——
      //    在「全局唯一序位」（001=P0、002=P1 … 006=P5）上开出一个静默缺口。
      //    依据：docs/superpowers/plans/INTERFACES.md「迁移版本号是全局唯一序位，
      //    002 起依次是 P1→P5」；同文档的重复版本号检查也以 '_' 为分隔符
      //    （ls -1 *.sql | cut -d_ -f1 | sort | uniq -d）。
      const m = /^(\d+)_(.+)\.sql$/.exec(name);
      if (!m) {
        throw new Error(`迁移文件名必须形如 <版本号>_<名称>.sql: ${name}`);
      }
      const version = Number(m[1]);
      // 版本号从 001 起 —— 0 不是合法序位（001=P0 … 006=P5）。
      if (version < 1) {
        throw new Error(`迁移版本号必须从 001 起: ${name}`);
      }
      return { version, name, sql: readFileSync(join(dir, name), 'utf8') };
    })
    // 排序：版本号升序 + 同版本号按文件名字节序。
    // ⚠️ readdirSync 的返回顺序在 POSIX 里未定义：APFS 按名序、ext4/xfs 按 hash 序，
    //    只按 version 排序会让同版本号的两个文件谁在前**因平台而异** →
    //    跨平台不一致（R-OPS-02）。
    //    比较用字节序（< / >），**不用 localeCompare**：后者依赖 locale，跨平台不一致。
    //    依据：R-OPS-02「跨平台稳定」。
    .sort((a, b) => (a.version - b.version) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // 重复版本号 → 抛错。必须在任何迁移 SQL 落地**之前**发现，
  // 否则先落地的那张表会把后一个永久遮蔽（静默跳过 = schema 缺口被固化）。
  const seen = new Map();
  for (const f of files) {
    const prev = seen.get(f.version);
    if (prev) {
      // 两个文件名**显式**按字节序排好再拼进错误信息 ——
      // 这样即使上面的排序被改回去，错误信息本身仍然确定（不依赖 readdir 顺序）。
      // 跨平台保证由**构造**成立，而不是靠"恰好 readdir 有序"。
      const [x, y] = prev.name < f.name ? [prev.name, f.name] : [f.name, prev.name];
      throw new Error(
        `迁移版本号重复: ${versionLabel(x)} (${x}, ${y})`,
      );
    }
    seen.set(f.version, f);
  }

  return files;
}

export function applyMigrations(db, migrationsDir) {
  // 先读文件并校验：重复版本号 / 文件名格式错误必须在任何 SQL 执行前失败
  const files = readMigrationFiles(migrationsDir);

  db.exec(MIGRATION_TABLE);
  // 已应用版本 → 当初应用时的文件名（用于校验迁移文件有没有被改名/挪位）
  const appliedMap = new Map(
    db.prepare('SELECT version, name FROM schema_migrations').all().map((r) => [r.version, r.name]),
  );

  const applied = [];
  for (const m of files) {
    const recordedName = appliedMap.get(m.version);
    if (recordedName !== undefined) {
      // 已应用过：文件名必须与当初一致。
      // 被改名/挪位 → 抛错，而不是"跳过"（跳过会让迁移历史与文件对不上账）。
      if (recordedName !== m.name) {
        throw new Error(
          `迁移 ${versionLabel(m.name)} 已以 ${recordedName} 应用，当前文件名为 ${m.name}；迁移文件名不可变更`,
        );
      }
      continue;
    }
    // 单事务内串行执行：要么全成功，要么全不成功
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(m.name);
      // 防御性纵深：循环内登记已应用版本，
      // 不让"同一版本被应用两次"这类问题依赖循环外的快照。
      appliedMap.set(m.version, m.name);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.name} 失败: ${err.message}`);
    }
  }

  return { applied, version: currentVersion(db) ?? 0 };
}

// src/db/migrate.js —— 【追加】到 P0 已建的文件里
//
// 读当前已应用的 schema 版本（迁移表里的 MAX(version)）。
// 依据：运维脚本（backup / restore）需要知道「这个备份对应哪个 schema 版本」，
//   但**不能自己写 SQL** —— 全局约束「所有 SQL 收在 src/db/repo/」，
//   而 src/db/migrate.js 是该守卫**唯一豁免的文件**（见 platform/test/sql-boundary.test.js
//   的豁免清单与「迁移执行器确实执行 SQL」那条断言）。
// @returns {number|null} 一次迁移都没应用过时返回 null
export function currentVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row?.v ?? null;
}
```

- [ ] **Step 5: 创建 db/migrations/001_init.sql**

```sql
-- 001_init.sql — 初始表结构
-- 依据：设计文档 §5.2 + §7.1
-- ⛔ 不含评审/榜单相关表：那些在 P2/P3 阶段单独迁移，便于 expand-contract。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  mba_status    TEXT NOT NULL DEFAULT 'other',  -- mba | member | other
  org           TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,      -- 软删除：禁止硬删（§11 事后篡改）
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,        -- 只存 SHA-256，不存明文 token
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 能力点与角色映射
CREATE TABLE capabilities (
  key         TEXT PRIMARY KEY,       -- 如 score:write / team:manage
  description TEXT NOT NULL
);

CREATE TABLE roles (
  key         TEXT PRIMARY KEY,       -- admin / captain / member / judge / enterprise / observer
  description TEXT NOT NULL
);

CREATE TABLE role_capabilities (
  role_id      TEXT NOT NULL REFERENCES roles(key),
  capability   TEXT NOT NULL REFERENCES capabilities(key),
  PRIMARY KEY (role_id, capability)
);

-- 资源级授权（行级权限的载体）
CREATE TABLE assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  capability  TEXT NOT NULL REFERENCES capabilities(key),
  scope_type  TEXT NOT NULL,         -- global | edition | city | task_package | team | enterprise
  scope_id    TEXT,
  granted_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_assignments_lookup ON assignments(user_id, capability);

-- 用户与角色的多对多
-- 一人可以同时是选手 + 队长 + 评委（借 hackerspace3 assignment 模型的做法）
-- ⚠️ 本表并入 001_init.sql，不单独开 002 迁移：
--    迁移版本号是全局唯一序位，002 必须留给 P1 的 002_registration.sql。
--    两个迁移抢同一个版本号时，后执行的那张表永远建不出来。
--    ⚠️ 现在 applyMigrations 对重复版本号**直接抛错**（fail-fast），
--       不再是"按 version 静默去重"—— 静默跳过会把 schema 缺口固化，运维看不出来。
CREATE TABLE user_roles (
  user_id  TEXT NOT NULL REFERENCES users(id),
  role_key TEXT NOT NULL REFERENCES roles(key),
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_key);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
```

- [ ] **Step 6: 创建 scripts/migrate.js**

```javascript
// scripts/migrate.js — 命令行迁移入口
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

const { db, close } = openDatabase({ dataDir });
try {
  const result = applyMigrations(db, join(here, '..', 'db', 'migrations'));
  console.log(`迁移完成，当前版本 ${result.version}`);
  if (result.applied.length) {
    console.log(`本次应用：\n  ${result.applied.join('\n  ')}`);
  } else {
    console.log('本次无新迁移');
  }
} finally {
  close();
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/migrate.test.js`
Expected: PASS（10 个测试全过：migrate 10）

- [ ] **Step 8: 实跑迁移脚本**

Run: `cd platform && node scripts/migrate.js`
Expected: 输出 `迁移完成，当前版本 1`

- [ ] **Step 9: 提交**

```bash
cd platform && git add src/db db/migrations scripts/migrate.js test/migrate.test.js
git commit -m "feat(P0): SQLite 封装、迁移机制与初始表结构"
```

- [ ] **Step 10: 补连接层并发回归（父代理修正轮 2026-10-21）**

> **为什么补这一条**：P5 的 worker 在「真并发建库」实测时撞到 `database is locked`，
> 父代理定位到根因在 `src/db/sqlite.js`：**切 journal_mode 需要独占锁；而当别的连接持有写事务
> （RESERVED 锁）时，SQLite 的 busy handler 在这一步不生效** —— 实测该 PRAGMA 在 **0ms** 内就抛
> SQLITE_BUSY(errcode=5)，busy_timeout 设成 5000 也**不等**（探针 `/tmp/p4-proof/probe-wal-lock-2.mjs` 实验 A/B/C/D）。
> ⚠️ **限定条件**（P4 终审 Minor M-2 实测纠正，别再无条件地转述这句话）：并非对所有锁型都如此 ——
> 别的连接持 **EXCLUSIVE** 锁时 busy handler **仍会**等待（实测 busy_timeout=5000 等 5485ms、
> =1000 等 1129ms，随 busy_timeout 线性缩放）。现实故障场景（并发写事务）落在 RESERVED 那一侧。
> ⇒ 两条连接同时首开同一个**新库**必有一方失败。修法见上面 Step 3 的新实现：
> 「已是 wal 直接返回（no-op）→ 否则带**退避重试**地切」。
>
> 本 Step 的用例**对旧实现是红的**：把 `src/db/sqlite.js` 回退到旧版实跑，
> 下面第 ②④ 条变红、①③ 仍绿 ⇒ 有牙（① 是不回归、③ 守新实现的 fail-fast）。

`platform/test/db-concurrency.test.js`：

```javascript
// platform/test/db-concurrency.test.js —— 连接层并发开库回归
//
// 缺陷背景（P5 的 worker 在「真并发建库」时撞到，父代理实证定位）：
//   原实现把 `PRAGMA journal_mode = WAL` 排在 `PRAGMA busy_timeout = 5000` **之前**，
//   而且 —— 关键 —— **别的连接持有写事务（RESERVED 锁）时，切 journal_mode 需要的独占锁拿不到，
//   而 SQLite 的 busy handler 在这一种锁型上不生效**。
//   ⇒ 两条连接同时开同一个**新库**时，后者立刻 "database is locked"（errcode=5）。
//
// ⚠️ 限定条件（P4 终审 Minor M-2 实测纠正）：上面那句**不是无条件成立** ——
//   别的连接持 **EXCLUSIVE** 锁时，busy handler 仍会等待
//   （实测 busy_timeout=5000 等 5485ms、=1000 等 1129ms，随 busy_timeout 线性缩放）。
//   现实故障场景（并发写事务）落在 RESERVED 那一侧 ⇒ 下面第 ②④ 条正是复现这一侧。
//
// 探针证据（/tmp/p4-proof/probe-wal-lock-2.mjs）：
//   实验 A：库里**已是** WAL + 另一连接持写锁 → 设 WAL **成功（0ms）**（no-op，不取锁）
//   实验 B：库里**仍是** delete + 另一连接持写锁 → 设 WAL **0ms 即失败**（errcode=5）
//            且 busy_timeout 设成 5000 也**不等** ⇒ busy_timeout 对这一步无效
//   实验 C/D：顺序开 / 已是 WAL 时再开 → 成功（0ms）
//
// 修法：切 WAL 改成「读当前模式 → 已是 wal 直接返回（no-op）→ 否则带**退避重试**地切」。
//       busy_timeout 提到最前，让其余取锁操作有界等待。
//
// 四条用例：
//   ① 常规路径不回归（顺序开两个连接，三个 pragma 都对）
//   ② **持锁时开新连接必须等到锁释放**（确定性回归；旧实现直接抛 "database is locked"）
//   ③ **重试预算耗尽必须抛错**（不无限等待 —— 启动不能被一把锁吊死；这条守的是新实现）
//   ④ **并发首开**（4 个连接同时开同一个新库）全部成功
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openDatabase } from '../src/db/sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, '..', 'test-helpers', 'db-worker.js');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-dbcon-'));
}

test('常规路径不回归：顺序开两个连接都成功，三个 pragma 都对', () => {
  const dataDir = tempDir();
  const a = openDatabase({ dataDir });
  assert.equal(a.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(a.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(a.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);

  // 第二次开同一个库：此时库已是 WAL ⇒ 切模式是 no-op（不取锁）⇒ 必须立刻成功
  const b = openDatabase({ dataDir });
  assert.equal(b.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

  a.close();
  b.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('持锁时开新连接：必须等到锁释放（不能 0ms 失败）', async () => {
  const dataDir = tempDir();
  const worker = new Worker(WORKER, {
    workerData: { role: 'lock-holder', dataDir, holdMs: 400 },
  });
  const [msg] = await once(worker, 'message');
  assert.equal(msg.locked, true, 'worker 必须先拿到写锁');

  const t0 = Date.now();
  const conn = openDatabase({ dataDir });       // 旧实现在这里直接抛 "database is locked"
  const waited = Date.now() - t0;

  // 「等到了」和「恰好也成功了」是两回事 —— 只断言成功会放过「没等就抢到锁」的假象
  assert.ok(
    waited >= 300,
    `必须真的等到了锁释放（实际只等了 ${waited}ms —— 说明没等就过去了）`,
  );
  assert.equal(conn.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

  conn.close();
  await worker.terminate();
  rmSync(dataDir, { recursive: true, force: true });
});

test('锁一直不放：重试预算耗尽后必须抛错（启动不能被一把锁吊死）', async () => {
  const dataDir = tempDir();
  const worker = new Worker(WORKER, {
    workerData: { role: 'lock-holder', dataDir, holdMs: 10000 },
  });
  await once(worker, 'message');

  const t0 = Date.now();
  assert.throws(
    () => openDatabase({ dataDir, walRetryBudgetMs: 300 }),
    /database is locked/,
    '预算耗尽必须抛错，不能一直等下去',
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `必须在预算附近就放弃（实际 ${elapsed}ms）`);

  await worker.terminate();
  rmSync(dataDir, { recursive: true, force: true });
});

test('并发首开：4 个连接同时开同一个新库，全部成功', async () => {
  const dataDir = tempDir();
  const N = 4;
  const workers = [];
  const results = [];

  for (let i = 0; i < N; i += 1) {
    const w = new Worker(WORKER, { workerData: { role: 'opener', dataDir } });
    workers.push(w);
    w.on('message', (m) => { if (m.ok !== undefined) results.push(m); });
  }

  // 等所有 worker 就绪后同时放行 —— 制造「同时首开同一个新库」的竞争
  await new Promise((r) => setTimeout(r, 300));
  workers.forEach((w) => w.postMessage({ go: true }));

  const deadline = Date.now() + 15000;
  while (results.length < N && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await Promise.all(workers.map((w) => w.terminate()));

  assert.equal(
    results.length,
    N,
    `全部 ${N} 个连接都该成功（实际只回来 ${results.length} 个：${JSON.stringify(results)}）`,
  );
  assert.deepEqual(
    results.filter((r) => !r.ok),
    [],
    '不允许有连接失败（旧实现会在这里报 "database is locked"）',
  );

  rmSync(dataDir, { recursive: true, force: true });
});
```

Run: `cd platform && node --test test/db-concurrency.test.js`
Expected: PASS（4 个测试全过）

---

### Task 3: 规则配置与 fail-fast 校验

> **【2026-10-20 派单前补强】** 原计划的 `validateRules` 只校验了 9 份配置里的 5 份
> （scoring / tiebreak / ranks / registration / solvability），**behavior、visibility、milestones
> 这 3 份只被读出来、零内容校验** —— 与本 Task 自己的目标「9 份规则配置与 fail-fast 校验」矛盾，
> 也与全局约束「配置校验 fail-fast：权重合计≠100% / 阈值不单调 → 拒绝启动并报错」矛盾：
> 这三份一旦写错，症状要到 P2/P3 算分、算榜单时才爆出来，而那时榜单可能已经发出去了。
> 补强内容：① behavior 的 `maxWeightShare` / `completionThreshold` / 事件 `points` / key 唯一；
> ② visibility 的段位引用必须真实存在于 `ranks.tiers`（悬空引用会让公示门槛静默失效）；
> ③ milestones 的 `confirmedBy` 枚举 / key 唯一 / 至少一项 `countsTowardTier`；
> ④ 缺失 `dimensions` 等子结构时报**友好校验错误**而不是抛 `TypeError`；
> ⑤ 各处 key 唯一性检查。对应测试从 7 条增至 13 条。
>
> **【2026-10-20 派单后第 2 轮补强】** 实现者按简报**逐字**实现后，用探针实测出 3 条漏检并交回裁决，
> 父代理复核后**全部采纳**（实测证据见 `task-3-report.md`）：
> **⑥** **9 份配置的 `version` 必须全等** —— 实现者实测把 `tiebreak.json` 的 version 改成
> `2099-01-01` 后 `loadRules` **静默接受**并对外报 `version=2099-01-01`。version 会写进计算 trace
> （设计原则「每次计算留 trace」）—— 版本号漂移 = 审计链在说谎，事后复算无法自证。
> **⑦** **数组元素为 null 时报友好错误而非裸 `TypeError`** —— 第 ④ 条只护住了 `scoring.*.dimensions`，
> 同类的 `behavior.events` / `milestones.items` / `ranks.tiers` 等无防护，
> 实测 `TypeError: Cannot read properties of null (reading 'points')`。
> **⑧** **`solvability.grades` 的评分区间不得重叠** —— A/B/C/D 是**互斥**区间（A 10-12 / B 7-9 / C 4-6 / D 0-3），
> 实测改成重叠后**不报错**；重叠会让同一分数落进两个等级，评级结果取决于查表顺序 → 不可复算。
> 对应测试从 13 条增至 **16 条**。
>
> **【2026-10-20 评审后第 3 轮补强】** Task 3 首轮评审 Approved，但评审挖出一条**规格级 Important**：
> `docs/rule-decisions.md:119-121` 的 **C-05 裁决**要求 `rules/scoring-*.json` 里必须有
> `fallback: "global" | "raw"`（归一化在样本不足时的兜底策略，**可配**），实测 **9 份 JSON 一处都没有** ——
> 裁决没有写进规则配置文件，与该文件开篇「每条冲突必须有裁决，且裁决必须写进规则配置文件」直接冲突。
> 顺带补齐另两条裁决的落地方式：**C-03** 要求 tiebreak 有序链**逐项**标注来源文档（原来只有文件级 source）；
> **C-04** 要求 `scoring-final.json` 加说明字段说明「完成度以 §2.2 的 20% 为准」。
> 本轮新增/修正 6 条校验 + 6 条测试：
> **⑨** `fallback` 必须是 `global` / `raw`（C-05）；**⑩** `conflictRef: C-01` ⇒ `wEnterprise === 0.10`
> **由运行时校验器锁住**（原来只靠测试，同时改 wEnterprise 与企业维度权重可绕过）；
> **⑪** `solvability.grades` 反向区间 `min > max` 当场拒绝；**⑫** 维度缺 `key` 当场拒绝；
> **⑬** 9 份配置缺 `version` 当场拒绝（原来只校验「存在的那几份全等」）；
> **⑭** tiebreak 每项必须有 `source`（C-03）。对应测试从 16 条增至 **22 条**。
>
> ⚠️ 本轮父代理自己写的校验代码里也踩了一个坑（已修正）：`[...new Set(arr)]` 得到的是**数组**，
> 判重数要用 `.length`；写成 `.size` 会拿到 `undefined`，`undefined > 1` 恒为 false，
> **这条校验会静默失效**。派单前用"抽取代码块 → 临时目录实跑"校验规格，抓到了它。
> 补强后的规格实跑：**16/16 通过**。
> 另修正一处测试标题与实现不符（"覆盖 0-100" → "单调不增"，本就不校验 0-100 覆盖）。

**Files:**
- Create: `platform/src/config.js`
- Create: `platform/rules/scoring-initial.json`
- Create: `platform/rules/scoring-final.json`
- Create: `platform/rules/tiebreak.json`
- Create: `platform/rules/ranks.json`
- Create: `platform/rules/behavior-points.json`
- Create: `platform/rules/visibility.json`
- Create: `platform/rules/registration-scoring.json`
- Create: `platform/rules/solvability.json`
- Create: `platform/rules/milestones.default.json`
- Create: `platform/test/config.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `loadRules(rulesDir)` → `{ rules: object, version: string }`，校验不过**抛错**
  - `validateRules(rules)` → 抛错信息数组（空数组 = 通过）
  - `rules.scoring.initial` / `rules.scoring.final` / `rules.tiebreak` / `rules.ranks` / `rules.behavior` / `rules.visibility` / `rules.registration` / `rules.solvability` / `rules.milestones`

- [ ] **Step 1: 写失败的测试**

`platform/test/config.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, validateRules } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

test('仓库自带的全部规则配置能通过校验', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(validateRules(rules), []);
});

test('权重合计不等于 100% 会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.dimensions[0].weight = 0.30; // 合计变 105%
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('scoring.final') && e.includes('权重合计')));
});

test('初赛企业确认权重必须是 10%（裁决 C-01）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.scoring.initial.wEnterprise, 0.10);
  const broken = structuredClone(rules);
  broken.scoring.initial.wEnterprise = 0.20;
  assert.ok(validateRules(broken).some((e) => e.includes('wEnterprise')));
});

test('wEnterprise 必须等于企业确认维度的权重', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.wEnterprise = 0.30;
  assert.ok(validateRules(broken).some((e) => e.includes('wEnterprise')));
});

test('段位门槛必须严格递增', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.ranks.tiers[2].minMilestones = 0;
  assert.ok(validateRules(broken).some((e) => e.includes('ranks')));
});

test('报名等级阈值必须单调不增', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.registration.levels[1].minScore = 90; // A 级阈值高于 S 级
  assert.ok(validateRules(broken).some((e) => e.includes('registration')));
});

test('破同分链必须以确定性兜底项结尾', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.tiebreak.chain.pop();
  assert.ok(validateRules(broken).some((e) => e.includes('tiebreak')));
});

// ── 以下 6 条覆盖「每份配置都有内容校验」这条要求 ──────────────
// 行为分 / 可见性 / 里程碑这三份配置如果只被读出来、不被校验，
// 写错了也要等到 P2/P3 算分算榜时才发现 —— 那时榜单可能已经发出去了。

test('behavior 的行为分占比上限必须在 0..1', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.maxWeightShare = 1.5;
  assert.ok(validateRules(broken).some((e) => e.includes('behavior')));
});

test('behavior 事件的 points 必须为正数', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events[0].points = 0;
  assert.ok(validateRules(broken).some((e) => e.includes('behavior')));
});

test('visibility 引用的段位必须真实存在', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.visibility.rank.publicFromTier = 'Z';
  assert.ok(validateRules(broken).some((e) => e.includes('visibility')));
});

test('milestones 的确认方枚举必须合法', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.milestones.items[0].confirmedBy = 'nobody';
  assert.ok(validateRules(broken).some((e) => e.includes('milestones')));
});

test('缺失 dimensions 时报友好错误，而不是抛 TypeError', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.final.dimensions;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('scoring.final') && e.includes('dimensions')),
    '缺失 dimensions 应被当作校验错误报告，而不是抛 TypeError',
  );
});

test('维度 key 重复会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.dimensions[1].key = broken.scoring.final.dimensions[0].key;
  assert.ok(validateRules(broken).some((e) => e.includes('重复 key')));
});

// ── 以下 3 条来自实现者实测反馈的 3 条漏检（父代理裁决后采纳）──────────

test('全部配置的 version 必须一致（漂移会让计算 trace 说谎）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.tiebreak.version = '2099-01-01';
  assert.ok(validateRules(broken).some((e) => e.includes('version')));
});

test('数组里混入 null 元素时报友好错误，而不是抛 TypeError', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.behavior.events[0] = null;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('behavior.events')),
    'null 元素应被当作校验错误报告，而不是抛 TypeError',
  );
});

test('solvability.grades 的评分区间不得重叠', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.solvability.grades[1].minScore = broken.solvability.grades[0].minScore; // B 覆盖到 A
  assert.ok(validateRules(broken).some((e) => e.includes('区间重叠')));
});

// ── 以下 6 条来自 Task 3 评审（rule-decisions 裁决的落地方式未落实）──────────

test('归一化的兜底策略 fallback 必须是 global 或 raw（C-05 裁决）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.scoring.initial.fallback, 'global');
  assert.equal(rules.scoring.final.fallback, 'global');
  const broken = structuredClone(rules);
  delete broken.scoring.final.fallback;
  assert.ok(validateRules(broken).some((e) => e.includes('fallback')));
});

test('C-01 裁决由运行时校验器锁住（不只靠测试）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  // 同时改 wEnterprise 与企业维度权重，并把完成度调低 —— 合计仍是 100%。
  // 这正是「只靠测试锁不住」的绕过路径。
  broken.scoring.initial.wEnterprise = 0.20;
  const ent = broken.scoring.initial.dimensions.find((d) => d.seat === 'enterprise');
  ent.weight = 0.20;
  broken.scoring.initial.dimensions.find((d) => d.key === 'completeness').weight = 0.15;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('C-01')),
    'C-01 裁决的初赛企业确认权重 10% 必须由校验器锁住',
  );
});

test('solvability.grades 的反向区间（min > max）会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.solvability.grades[0].maxScore = 6; // A 变成 10-6，永远匹配不到
  assert.ok(validateRules(broken).some((e) => e.includes('区间非法')));
});

test('维度缺少 key 会被拒绝（否则算分无法映射回维度）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.final.dimensions[0].key;
  assert.ok(validateRules(broken).some((e) => e.includes('缺少 key')));
});

test('某份配置缺少 version 会被拒绝（不能只校验存在的那几份）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.tiebreak.version;
  assert.ok(validateRules(broken).some((e) => e.includes('缺少 version')));
});

test('破同分链每一项都必须标注来源文档（C-03 落地要求）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.tiebreak.chain[1].source;
  assert.ok(validateRules(broken).some((e) => e.includes('source')));
});

test('权重合计的容差必须严格：合计 101% 也要被拒绝（终审 I-6-6）', () => {
  // ⛔ 终审发现（Important）：权重合计的容差是 1e-9。把容差放宽到 0.02 后，
  //    **权重合计 101% 的配置能启动** —— 榜单整体错位 1% 而系统不报错。
  //    rule-decisions.md:158 明写「C-01 如果被硬编码，初赛榜单**整体错位**且不报错」
  //    —— 这正是这类 bug 的形状。
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  // 把初赛第一个维度的权重 +0.01 → 合计 101%
  broken.scoring.initial.dimensions[0].weight += 0.01;
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('scoring.initial') && e.includes('权重合计')),
    `合计 101% 必须被拒绝，实际校验结果：${JSON.stringify(errors)}`,
  );
});

// ── 以下 4 条来自 P2 Task 8（新增字段的 fail-fast 校验）────────────────────

test('P2：缺 judgePool 段会被拒绝（R-JDG-10 / R-JDG-11 的评委池构成必须配置化）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.scoring.initial.judgePool;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('scoring.initial') && e.includes('judgePool')));
});

test('P2：judgePool 的占比必须在 0..1', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.final.judgePool.minEnterpriseSeatShare = 1.5;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('minEnterpriseSeatShare')));
});

test('P2：freeBrief.judgeDimension 必须指向一个评委席维度（R4 的替代维度）', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.initial.freeBrief.judgeDimension = 'enterprise'; // 企业席维度不能当替代
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('freeBrief.judgeDimension')));
});

test('P2：归一化策略参数（trimmedIterations / bayesPriorStrength）非法会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.scoring.initial.trimmedIterations = 0;
  broken.scoring.final.bayesPriorStrength = -1;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('trimmedIterations')));
  assert.ok(errors.some((e) => e.includes('bayesPriorStrength')));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/config.test.js`
Expected: FAIL —— `Cannot find module '../src/config.js'`

- [ ] **Step 3: 创建 9 份规则配置**

`platform/rules/scoring-initial.json`：

```json
{
  "id": "scoring-initial",
  "version": "2026-10-20",
  "conflictRef": "C-01",
  "source": "S7 §2.1 初赛权重表 + §3.1 评分公式",
  "note": "初赛 wEnterprise=0.10 —— 依据权重表合计正好 100% 反推，见 rule-decisions.md C-01；fallback=global 依据 C-05 裁决（S7 §3.1 原文：样本数<5 退回全局均值方差）",
  "wEnterprise": 0.10,
  "normalizationStrategy": "zscore",
  "minSamplesForJudgeNormalization": 5,
  "fallback": "global",
  "trimOutliers": true,
  "minJudgesForTrim": 5,
  "dimensions": [
    { "key": "track_fit",     "name": "赛题契合度", "weight": 0.10, "seat": "judge" },
    { "key": "innovation",    "name": "创新性",     "weight": 0.20, "seat": "judge" },
    { "key": "feasibility",   "name": "技术可行性", "weight": 0.20, "seat": "judge" },
    { "key": "completeness",  "name": "完成度",     "weight": 0.25, "seat": "judge" },
    { "key": "enterprise",    "name": "企业确认",   "weight": 0.10, "seat": "enterprise" },
    { "key": "collaboration", "name": "团队协作",   "weight": 0.15, "seat": "judge" }
  ]
}
```

`platform/rules/scoring-final.json`：

```json
{
  "id": "scoring-final",
  "version": "2026-10-20",
  "conflictRef": "C-04",
  "source": "S7 §2.2 决赛权重表 + §3.1 评分公式",
  "note": "完成度以 §2.2 权重表的 20% 为准；S7 §6 的「25%→15%」是历史叙述章节、不具规则效力（rule-decisions.md C-04）。fallback=global 依据 C-05 裁决",
  "wEnterprise": 0.25,
  "normalizationStrategy": "zscore",
  "minSamplesForJudgeNormalization": 5,
  "fallback": "global",
  "trimOutliers": true,
  "minJudgesForTrim": 5,
  "dimensions": [
    { "key": "enterprise",    "name": "企业确认",   "weight": 0.25, "seat": "enterprise" },
    { "key": "innovation",    "name": "创新性",     "weight": 0.20, "seat": "judge" },
    { "key": "feasibility",   "name": "技术可行性", "weight": 0.20, "seat": "judge" },
    { "key": "completeness",  "name": "完成度",     "weight": 0.20, "seat": "judge" },
    { "key": "collaboration", "name": "团队协作",   "weight": 0.10, "seat": "judge" },
    { "key": "self_eval",     "name": "自评测",     "weight": 0.05, "seat": "self" }
  ]
}
```

`platform/rules/tiebreak.json`：

```javascript
{
  "id": "tiebreak",
  "version": "2026-10-20",
  "conflictRef": "C-03",
  "source": "S7 §3.3 + S10 §0.4 + S10 §3.3（原文互相冲突，此处为裁决后的有序链）",
  "chain": [
    { "key": "total",          "label": "总分",           "direction": "desc", "scope": "always",     "source": "S7 §3.1 总分" },
    { "key": "tiebreak_extra", "label": "加时陈述复议分", "direction": "desc", "scope": "final_only", "manual": true, "source": "S10 §0.4 加时陈述复议" },
    { "key": "peer",           "label": "互评分",         "direction": "desc", "scope": "tied_only",  "source": "S7 §3.3 互评（唯一破同分工具）｜R-RNK-05：互评**只**在破同分链里出现（scope=tied_only），**从不进入 A 榜的评审分** ⇒ 互评在评审分里的占比恒为 0% ≤ 20%（评审终评 ≥80% 由此满足）" },
    { "key": "enterprise_raw", "label": "企业确认原始分", "direction": "desc", "scope": "tied_only",  "source": "S7 §3.3 兜底（主观但独立于互评）" },
    { "key": "behavior",       "label": "行为分",         "direction": "desc", "scope": "tied_only",  "source": "S10 §3.3 过程参与度，≤10%，最弱" },
    { "key": "team_id",        "label": "队伍编号",       "direction": "asc",  "scope": "always", "deterministic": true, "source": "C-03 新增：三份文档都没写的最终确定性兜底，保证排序永远可复现（满足 R-AUD-01）" }
  ]
}
```

`platform/rules/ranks.json`：

```json
{
  "id": "ranks",
  "version": "2026-10-20",
  "source": "S10 §2.2 段位表 + §2.3 降级与权益",
  "tiers": [
    { "key": "D", "name": "出题", "minMilestones": 0, "requiresBusinessSignoff": false },
    { "key": "C", "name": "立项", "minMilestones": 1, "requiresBusinessSignoff": false },
    { "key": "B", "name": "原型", "minMilestones": 2, "requiresBusinessSignoff": false },
    { "key": "A", "name": "接入", "minMilestones": 3, "requiresBusinessSignoff": false, "requiresDataOrPrototype": true },
    { "key": "S", "name": "验证", "minMilestones": 5, "requiresBusinessSignoff": true }
  ],
  "demotion": {
    "onSignoffRevoked": true,
    "inactiveDays": 14,
    "inactiveDropLevels": 1,
    "publishDemotion": true
  },
  "benefits": {
    "C": ["企业对接会", "导师匹配资格"],
    "B": ["Demo Day 路演资格"],
    "A": ["辅导期名额候选"],
    "S": ["辅导期名额优先", "完赛证明"]
  },
  "neverUnlocks": ["奖金", "决赛名次"]
}
```

`platform/rules/behavior-points.json`：

```json
{
  "id": "behavior",
  "version": "2026-10-20",
  "source": "S10 §3.1 计分明细 + §3.2 达标线 + §3.3 占比上限",
  "completionThreshold": 60,
  "maxWeightShare": 0.10,
  "events": [
    { "key": "weekly_progress",   "label": "每周提交一次进度",   "points": 2,  "requiresRunnableOrBlocker": true },
    { "key": "workshop_output",   "label": "参加 workshop 并提交课后产出", "points": 3, "requiresOutput": true },
    { "key": "milestone_on_time", "label": "按时交付里程碑",     "points": 5 },
    { "key": "enterprise_meeting","label": "完成一次企业对接会", "points": 5,  "requiresEnterpriseConfirm": true },
    { "key": "first_demo",        "label": "首次提交 Demo",      "points": 10, "once": true }
  ],
  "sortUse": "tiebreak_only"
}
```

`platform/rules/visibility.json`：

```json
{
  "id": "visibility",
  "version": "2026-10-20",
  "conflictRef": "C-02",
  "source": "S10 §0.3 分层公开 + §8 风险表",
  "rank": {
    "public": true,
    "publicFromTier": "C",
    "privateBelowTier": "D",
    "showEnterpriseName": false
  },
  "business": {
    "milestoneProgressPublic": true,
    "scoresPublic": false,
    "signatoryPublic": false
  },
  "peerReview": {
    "showSource": false
  }
}
```

`platform/rules/registration-scoring.json`：

```json
{
  "id": "registration",
  "version": "2026-10-20",
  "source": "SABC v1 §二 3 维画像筛选",
  "dimensions": [
    { "key": "direction",    "label": "方向维度", "weight": 0.25, "min": 1, "max": 5 },
    { "key": "capability",   "label": "能力维度", "weight": 0.35, "min": 1, "max": 5 },
    { "key": "collaboration","label": "协作维度", "weight": 0.40, "min": 1, "max": 5 }
  ],
  "levels": [
    { "key": "S", "label": "顶级种子", "minScore": 80, "accept": true },
    { "key": "A", "label": "优秀候选", "minScore": 60, "accept": true },
    { "key": "B", "label": "潜力候选", "minScore": 40, "accept": true },
    { "key": "C", "label": "底线外",   "minScore": 0,  "accept": false }
  ],
  "openQuestion": { "required": true, "maxLength": 500 }
}
```

`platform/rules/solvability.json`：

```json
{
  "id": "solvability",
  "version": "2026-10-20",
  "source": "顶层文档 §3.2 六维可解性准入",
  "dimensions": [
    { "key": "problem_clarity", "label": "问题确定性", "weight": 0.30, "max": 3 },
    { "key": "data_access",     "label": "数据可得性", "weight": 0.25, "max": 3 },
    { "key": "validation",      "label": "验证周期",   "weight": 0.20, "max": 2 },
    { "key": "decision_chain",  "label": "决策链长度", "weight": 0.10, "max": 1 },
    { "key": "accountability",  "label": "责任可归属", "weight": 0.10, "max": 1 },
    { "key": "precedent",       "label": "先例存在性", "weight": 0.05, "max": 1 }
  ],
  "grades": [
    { "key": "A", "minScore": 10, "maxScore": 12, "commitment": "试点承诺",   "agreement": "试点承诺书 + 数据授权说明" },
    { "key": "B", "minScore": 7,  "maxScore": 9,  "commitment": "对标试点",   "agreement": "对标试点协议" },
    { "key": "C", "minScore": 4,  "maxScore": 6,  "commitment": "不承诺试点", "agreement": "场景提供协议" },
    { "key": "D", "minScore": 0,  "maxScore": 3,  "commitment": "无",         "agreement": "退回，但必出问题可解性诊断报告" }
  ],
  "vetoes": [
    { "key": "no_data_authorization", "label": "无法提供《数据授权说明》" },
    { "key": "no_responsible_owner",  "label": "无企业侧唯一责任人" },
    { "key": "production_undisclosed","label": "涉及生产系统且未谈责任归属" }
  ],
  "taskMix": { "enterprise": 0.70, "free": 0.30 }
}
```

`platform/rules/milestones.default.json`：

```javascript
{
  "id": "milestones-default",
  "version": "2026-10-20",
  "source": "S10 §4 商业里程碑 7 类 + §3.4 里程碑清单报名时固定｜R-PTS-11：下面这 7 类就是「L2 商业里程碑分」的完整类目（企业问题确认 / 真实数据接入 / 可演示原型 / 试点合同 / 业务迭代 N 轮 / 意向客户 M 家 / 确认收入 ¥X）｜R-PTS-12：里程碑与段位**共享「企业签字」这一个数据源**（countsTowardTier / signoffRequires），但**不共享任何一条规则** —— 里程碑表在这里，段位表在 rules/ranks.json，两边各自独立配置",
  "note": "报名时随战队固定，赛程中不可自行新增（S10 §3.4 防拆单刷里程碑）",
  "items": [
    { "key": "problem_confirmed", "label": "企业问题确认", "confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "data_connected",    "label": "真实数据接入", "confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "demo_ready",        "label": "可演示原型",   "confirmedBy": "judge",      "countsTowardTier": true },
    { "key": "pilot_contract",    "label": "试点合同",     "confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "iterations",        "label": "业务迭代 N 轮","confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "intents",           "label": "意向客户 M 家","confirmedBy": "enterprise", "countsTowardTier": true },
    { "key": "revenue",           "label": "确认收入 ¥X",  "confirmedBy": "enterprise", "countsTowardTier": true }
  ],
  "signoffRequires": { "content": true, "department": true, "signatory": true }
}
```

- [ ] **Step 4: 创建 src/config.js**

```javascript
// src/config.js — 规则配置加载与 fail-fast 校验
// 依据：设计文档 §6.7 + §2 第二条结论。
//   60 条机制件级需求全部来自尚未被组委会确认的设计 → 全部走配置。
//   校验不过就拒绝启动，绝不降级为默认值 —— 否则会安静地算出一个错位的榜单。
//   ⚠️ 9 份配置**全部**都要有内容校验（不只是能被 JSON.parse 出来）：
//      "能读出 JSON" 不等于 "配置是对的"。漏检的那几份一旦写错，症状要到
//      P2/P3 算分、算榜单时才爆出来 —— 而那时榜单可能已经发出去了。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 交叉引用校验用的常量（fail-fast 的「引用真实存在」那一类）：
//   · TASK_PACKAGE_STATUSES —— task_packages.status 的取值域（唯一写入方
//     src/services/taskPackage.js 的状态机：submitted → assessed → published | returned）。
//   · RESOURCE_KINDS —— 资源池的分组类型（唯一产生方 src/domain/pool-derive.js）。
//   · LEDGER_POINT_KINDS —— points_ledger.kind 的取值域（契约 INTERFACES.md §4 明列）。
// ⚠️ 这三个模块都是**叶子模块**（不 import 本文件）⇒ 不会形成循环依赖。
import { TASK_PACKAGE_STATUSES } from './db/repo/taskPackages.js';
import { RESOURCE_KINDS } from './domain/pool-derive.js';

const FILES = {
  scoringInitial: 'scoring-initial.json',
  scoringFinal: 'scoring-final.json',
  tiebreak: 'tiebreak.json',
  ranks: 'ranks.json',
  behavior: 'behavior-points.json',
  visibility: 'visibility.json',
  registration: 'registration-scoring.json',
  solvability: 'solvability.json',
  milestones: 'milestones.default.json',
  teamFormation: 'team-formation.json',
  schedule: 'schedule.json',
  compliance: 'compliance.json',
  points: 'points.json',
  criteria: 'criteria.json',
  pools: 'pools.json',
  audit: 'audit.json',                     // ← P4 新增
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`规则配置读取失败 ${path}: ${err.message}`);
  }
}

// 归一化策略四选一（设计文档 §6.2 裁决：可切换）
const VALID_NORMALIZATIONS = ['zscore', 'median', 'trimmed', 'bayes'];
// 归一化的兜底策略二选一（rule-decisions.md C-05 裁决）：
//   global —— 退回全局均值方差（S7 §3.1 原文）；raw —— 直接用原始分。
//   缺这个键 = 样本不足时的归一化行为无定义，必须当场拒绝。
const VALID_FALLBACKS = ['global', 'raw'];
// 里程碑确认方只有两种：企业侧确认 / 评委确认
const VALID_CONFIRMERS = ['enterprise', 'judge'];
// points_ledger.kind 的取值域。
// 依据：INTERFACES.md §4「points_ledger(id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
//        -- kind: stage_rank | mvp | roadshow | personal_rollup」。
// ⛔ 这不是「随便列几个」：kind 写错一个字母 → 该笔积分被静默丢弃（口径外 kind
//    只告警不计入）→ 榜单少一分且没人知道。配置里引用不存在的 kind 必须当场拒绝。
const LEDGER_POINT_KINDS = new Set(['stage_rank', 'mvp', 'roadshow', 'personal_rollup']);

function weightSum(dimensions) {
  return dimensions.reduce((a, d) => a + (typeof d.weight === 'number' ? d.weight : 0), 0);
}

function hasDuplicateKeys(items) {
  const keys = items.map((i) => i?.key).filter((k) => k !== undefined);
  return new Set(keys).size !== keys.length;
}

// 数组元素必须是非 null 对象 —— 否则下面访问 item.key / item.points 会抛 TypeError。
// 校验器的第一职责是**自己不崩**、给出可读错误，而不是把裸 TypeError 抛给调用方。
function hasBadItem(items) {
  return items.some((i) => i === null || typeof i !== 'object');
}

// 维度必须都有 key —— 否则算分时无法把分数映射回维度。
function hasMissingKey(items) {
  return items.some((i) => typeof i.key !== 'string' || !i.key);
}

/**
 * 把配置对象摊平收集到 out。
 * 「有 id 的是一份配置，没 id 的是命名空间」（scoring = { initial, final }）。
 */
function collectConfigObjects(value, out) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (typeof value.id === 'string') {
    out.push(value);
    return;
  }
  for (const inner of Object.values(value)) {
    collectConfigObjects(inner, out);
  }
}

/**
 * 校验全部规则配置。**任何一条不通过都必须 fail-fast**（loadRules 会抛错拒绝启动）。
 * @param {object} rules 分组后的配置（loadRules 传入）
 * @param {number|null} [expectedCount] 应当存在的配置份数（loadRules 传 FILES 的键数）。
 *   传了才能发现「整份配置没被识别到」；不传时只做 version 相关的检查。
 */
export function validateRules(rules, expectedCount = null) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  // ── 版本号一致性 ─────────────────────────────────────────
  // 所有配置的 version 必须全等。version 会写进计算 trace（设计原则
  // 「每次计算留 trace」）—— 版本号漂移 = 审计链在说谎：trace 上标注的版本
  // 与实际生效的规则对不上，事后复算无法自证。
  //
  // ⚠️ 2026-10-21 修正（P1 Task 3 验收发现，与 P2–P6 漂移审计的 I-2 同一条）：
  //    原来这里是**硬编码的 9 项**列表 —— P1 新增 3 份配置（teamFormation /
  //    schedule / compliance）之后，它们的 version 漂移**根本不会被发现**，
  //    这条校验对新增配置形同虚设（实跑：把新配置改成一个异版本号，零报错）。
  //    改成**自动派生**：按「有 id 的就是一份配置」把配置对象摊平，
  //    加多少份配置都自动覆盖 —— 不再需要改这里。
  //
  //    「有 id 的是配置，没 id 的是命名空间」（如 scoring = { initial, final }）。
  //    用 id 而不是 version 做识别：一份配置**缺了 version** 时仍能被认出来，
  //    否则它会被当成命名空间 → 「缺少 version」这条检查反而失效。
  const configObjects = [];
  for (const value of Object.values(rules ?? {})) {
    collectConfigObjects(value, configObjects);
  }
  const configCount = configObjects.length;
  // 每份都必须**有** version —— 只校验「存在的那几份全等」是不够的：
  // 缺一份时 loadRules 对外报的 version 会取到别人的值，等于说谎。
  const missingVersion = configObjects.filter(
    (c) => c.version === undefined || c.version === null || c.version === '',
  ).length;
  if (missingVersion > 0) {
    push(`规则配置有 ${missingVersion} 份缺少 version 字段`);
  }
  // 份数对不上 = 有配置**没被识别到**（如整份配置读成了空对象）→ 必须报错。
  if (expectedCount !== null && configCount !== expectedCount) {
    push(`规则配置应有 ${expectedCount} 份，实际只识别到 ${configCount} 份`);
  }
  const distinct = [...new Set(configObjects.map((c) => c.version).filter((v) => v !== undefined && v !== null && v !== ''))];
  // ⚠️ distinct 是**数组**（Set 被展开），判重数用 .length —— 用 .size 会拿到
  //    undefined，比较恒为 false，这条校验会静默失效。
  if (distinct.length > 1) {
    push(`规则配置 version 不一致：${distinct.join(' / ')} —— ${configCount} 份配置必须同版本`);
  }

  // ── 评分配置 ──────────────────────────────────────────────
  for (const key of ['initial', 'final']) {
    const cfg = rules?.scoring?.[key];
    if (!cfg) {
      push(`scoring.${key} 缺失`);
      continue;
    }
    if (!Array.isArray(cfg.dimensions) || cfg.dimensions.length === 0) {
      push(`scoring.${key}.dimensions 缺失或为空`);
      continue;
    }
    if (hasBadItem(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 含非对象元素`);
      continue;
    }
    const sum = weightSum(cfg.dimensions);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`scoring.${key} 权重合计 = ${sum.toFixed(4)}，必须等于 1（100%）`);
    }
    const ent = cfg.dimensions.find((d) => d.seat === 'enterprise');
    if (!ent) {
      push(`scoring.${key} 缺少 seat=enterprise 的维度`);
    } else if (Math.abs(ent.weight - cfg.wEnterprise) > 1e-9) {
      push(
        `scoring.${key} wEnterprise=${cfg.wEnterprise} 与企业确认维度权重 ${ent.weight} 不一致`,
      );
    }
    if (typeof cfg.wEnterprise !== 'number' || cfg.wEnterprise < 0 || cfg.wEnterprise > 1) {
      push(`scoring.${key} wEnterprise 必须在 0..1`);
    }
    // ── P2 追加：评委池 / 自由命题替代维度 / 归一化策略参数 ──
    // ⛔ 为什么要在这里 fail-fast（而不是等到运行时才报）：
    //    这些字段直接决定「谁有投票权」「自由命题组的企业项由谁顶」——
    //    写错时不会崩，会**静默算出一份错的榜单**（与「权重合计≠100% 拒绝启动」同一类病）。
    const pool = cfg.judgePool;
    if (!pool) {
      push(`scoring.${key} 缺少 judgePool 段（R-JDG-10 / R-JDG-11）`);
    } else {
      if (!(Number(pool.minJudgesPerDimension) > 0)) {
        push(`scoring.${key} judgePool.minJudgesPerDimension 必须 > 0`);
      }
      if (Number(pool.minEnterpriseSeatShare) < 0 || Number(pool.minEnterpriseSeatShare) > 1) {
        push(`scoring.${key} judgePool.minEnterpriseSeatShare 必须在 0..1`);
      }
      if (Number(pool.maxExpertSeatShare) < 0 || Number(pool.maxExpertSeatShare) > 1) {
        push(`scoring.${key} judgePool.maxExpertSeatShare 必须在 0..1`);
      }
      if (!Array.isArray(pool.votingSeats) || !pool.votingSeats.length) {
        push(`scoring.${key} judgePool.votingSeats 缺失`);
      }
      if (!Array.isArray(pool.nonVotingSeats) || !pool.nonVotingSeats.length) {
        push(`scoring.${key} judgePool.nonVotingSeats 缺失`);
      }
    }
    const demand = cfg.freeBrief?.judgeDimension;
    if (!demand) {
      push(`scoring.${key} 缺少 freeBrief.judgeDimension（R-JDG-08 R4）`);
    } else if (!cfg.dimensions.some((d) => d.key === demand && d.seat === 'judge')) {
      push(`scoring.${key} freeBrief.judgeDimension=${demand} 必须是一个评委席维度`);
    }
    if (cfg.selfEvalThreshold != null && Number(cfg.selfEvalThreshold) < 0) {
      push(`scoring.${key} selfEvalThreshold 必须 ≥ 0`);
    }
    if (cfg.trimmedIterations != null && !(Number.isInteger(cfg.trimmedIterations) && cfg.trimmedIterations >= 1)) {
      push(`scoring.${key} trimmedIterations 必须是 ≥1 的整数`);
    }
    if (cfg.bayesPriorStrength != null && !(Number.isFinite(cfg.bayesPriorStrength) && cfg.bayesPriorStrength >= 0)) {
      push(`scoring.${key} bayesPriorStrength 必须是 ≥0 的有限数`);
    }
    if (!VALID_NORMALIZATIONS.includes(cfg.normalizationStrategy)) {
      push(`scoring.${key} normalizationStrategy 非法`);
    }
    // C-05 裁决：兜底策略可配 —— "global" 退回全局均值方差（S7 §3.1 原文），
    // "raw" 直接用原始分。缺这个键 = 样本不足时归一化怎么走没有定义。
    if (!VALID_FALLBACKS.includes(cfg.fallback)) {
      push(`scoring.${key}.fallback 必须是 ${VALID_FALLBACKS.join(' / ')}（C-05 裁决）`);
    }
    // C-01 裁决：初赛企业确认权重锁定 10%（由 S7 §2.1 权重表合计正好 100% 反推）。
    // 只靠测试锁不住 —— 同时改 wEnterprise 与企业维度权重（保持合计 100%）能绕过测试，
    // 所以校验器也要锁。改动此项须同步改 rule-decisions.md 的 C-01。
    if (cfg.conflictRef === 'C-01' && Math.abs(cfg.wEnterprise - 0.10) > 1e-9) {
      push(`scoring.${key}.wEnterprise 必须为 0.10（C-01 裁决）`);
    }
    if (hasMissingKey(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 存在缺少 key 的维度`);
    }
    if (hasDuplicateKeys(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 存在重复 key`);
    }
  }

  // ── 破同分链 ──────────────────────────────────────────────
  const chain = rules?.tiebreak?.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    push('tiebreak.chain 缺失或为空');
  } else if (hasBadItem(chain)) {
    push('tiebreak.chain 含非对象元素');
  } else {
    const last = chain[chain.length - 1];
    if (!last.deterministic) {
      push('tiebreak.chain 必须以确定性兜底项结尾（deterministic: true），否则榜单不可复算');
    }
    if (!chain.some((c) => c.key === 'total')) {
      push('tiebreak.chain 缺少总分项');
    }
    if (hasDuplicateKeys(chain)) {
      push('tiebreak.chain 存在重复 key');
    }
    // C-03 落地要求：有序链的**每一项**都要标注来源文档与生效条件
    // （生效条件 = scope，已有；来源文档 = source，必须有）。
    if (chain.some((c) => typeof c.source !== 'string' || !c.source)) {
      push('tiebreak.chain 存在缺少 source 的项（C-03 要求逐项标注来源文档）');
    }
  }

  // ── 段位 ─────────────────────────────────────────────────
  const tiers = rules?.ranks?.tiers;
  const tierKeys = new Set();
  if (!Array.isArray(tiers) || tiers.length === 0) {
    push('ranks.tiers 缺失或为空');
  } else if (hasBadItem(tiers)) {
    push('ranks.tiers 含非对象元素');
  } else {
    for (const t of tiers) tierKeys.add(t.key);
    for (let i = 1; i < tiers.length; i += 1) {
      if (tiers[i].minMilestones <= tiers[i - 1].minMilestones) {
        push(`ranks.tiers 门槛必须严格递增（第 ${i + 1} 档）`);
      }
    }
    if (hasDuplicateKeys(tiers)) {
      push('ranks.tiers 存在重复 key');
    }
  }

  // ── 报名等级 ─────────────────────────────────────────────
  const levels = rules?.registration?.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    push('registration.levels 缺失或为空');
  } else if (hasBadItem(levels)) {
    push('registration.levels 含非对象元素');
  } else {
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i].minScore > levels[i - 1].minScore) {
        push(`registration.levels 阈值必须单调不增（第 ${i + 1} 级）`);
      }
    }
    if (hasDuplicateKeys(levels)) {
      push('registration.levels 存在重复 key');
    }
  }
  const regDims = rules?.registration?.dimensions;
  if (!Array.isArray(regDims) || regDims.length === 0) {
    push('registration.dimensions 缺失或为空');
  } else if (hasBadItem(regDims)) {
    push('registration.dimensions 含非对象元素');
  } else {
    if (hasMissingKey(regDims)) {
      push('registration.dimensions 存在缺少 key 的维度');
    }
    const sum = weightSum(regDims);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`registration.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }

  // ── 可解性 ───────────────────────────────────────────────
  const sol = rules?.solvability;
  if (!Array.isArray(sol?.dimensions) || sol.dimensions.length === 0) {
    push('solvability.dimensions 缺失或为空');
  } else if (hasBadItem(sol.dimensions)) {
    push('solvability.dimensions 含非对象元素');
  } else {
    if (hasMissingKey(sol.dimensions)) {
      push('solvability.dimensions 存在缺少 key 的维度');
    }
    const sum = weightSum(sol.dimensions);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`solvability.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }
  if (!Array.isArray(sol?.grades) || sol.grades.length === 0) {
    push('solvability.grades 缺失或为空');
  } else if (hasBadItem(sol.grades)) {
    push('solvability.grades 含非对象元素');
  } else if (hasDuplicateKeys(sol.grades)) {
    push('solvability.grades 存在重复 key');
  } else {
    // 反向区间（minScore > maxScore）永远匹配不到任何分数 —— 当场拒绝。
    for (const g of sol.grades) {
      if (typeof g.minScore !== 'number' || typeof g.maxScore !== 'number'
        || g.minScore > g.maxScore) {
        push(
          `solvability.grades 等级 ${g.key} 的区间非法`
          + `（minScore=${g.minScore}, maxScore=${g.maxScore}）`,
        );
      }
    }
    // A/B/C/D 是**互斥**的评分区间：重叠会让同一个分数落进两个等级，
    // 评级结果取决于查表顺序 —— 不可复算。
    const sorted = [...sol.grades].sort((a, b) => a.minScore - b.minScore);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].minScore <= sorted[i - 1].maxScore) {
        push(
          `solvability.grades 分值区间重叠：${sorted[i - 1].key}`
          + `(${sorted[i - 1].minScore}-${sorted[i - 1].maxScore}) 与 `
          + `${sorted[i].key}(${sorted[i].minScore}-${sorted[i].maxScore})`,
        );
      }
    }
  }
  // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**vetoes 完全没有校验**）：
  //    原来这里只校验 dimensions 与 grades，`solvability.vetoes` 一个字都没查 ——
  //    否决项写成空数组、或两条同名、或 `auto.dimension` 指向一个不存在的维度，
  //    全都能通过校验、直到算分时才出问题（或者干脆**静默失效**）。
  //    现在校验：非空、key 唯一、label 非空、`auto` 的形状与指向的维度存在。
  if (!Array.isArray(sol?.vetoes) || sol.vetoes.length === 0) {
    push('solvability.vetoes 缺失或为空（R-ENT-07 三条一票否决）');
  } else if (hasBadItem(sol.vetoes)) {
    push('solvability.vetoes 含非对象元素');
  } else if (hasDuplicateKeys(sol.vetoes)) {
    push('solvability.vetoes 存在重复 key');
  } else {
    const dimensionKeys = new Set((sol.dimensions ?? []).map((d) => d.key));
    for (const v of sol.vetoes) {
      if (typeof v.label !== 'string' || !v.label) {
        push(`solvability.vetoes ${v.key} 缺少 label`);
      }
      if (v.auto === undefined || v.auto === null) continue;
      if (typeof v.auto !== 'object' || typeof v.auto.dimension !== 'string'
        || typeof v.auto.equals !== 'number') {
        push(`solvability.vetoes ${v.key} 的 auto 必须是 { dimension: string, equals: number }`);
      } else if (dimensionKeys.size && !dimensionKeys.has(v.auto.dimension)) {
        push(`solvability.vetoes ${v.key} 的 auto.dimension 引用了不存在的维度 ${v.auto.dimension}`);
      }
    }
  }

  // ── 行为分 ───────────────────────────────────────────────
  // 行为分只用于破同分、不进总分（分轨强制）；但它仍有自己的阈值与上限，必须校验。
  const behavior = rules?.behavior;
  if (!behavior) {
    push('behavior 缺失');
  } else {
    if (typeof behavior.maxWeightShare !== 'number'
      || behavior.maxWeightShare < 0 || behavior.maxWeightShare > 1) {
      push('behavior.maxWeightShare 必须在 0..1');
    }
    if (typeof behavior.completionThreshold !== 'number'
      || behavior.completionThreshold < 0 || behavior.completionThreshold > 100) {
      push('behavior.completionThreshold 必须在 0..100');
    }
    // ⚠️ sortUse **不是可配置项**，它是 R-PTS-08 的硬保证：行为分只能做破同分，
    //    绝不能变成主评分（决赛名次 0% / 奖金 0%）。
    //    链不变量里的那处检查（assertChainInvariants）在生产链路上【拿不到 behaviorConfig】，
    //    属于「建好却从不校验」的同款病根 —— 所以必须在这里 fail-fast：
    //    配置被改成 'primary' 之类的值时**拒绝启动**，而不是带着违规口径上线。
    if (behavior.sortUse !== 'tiebreak_only') {
      push('behavior.sortUse 必须是 tiebreak_only（R-PTS-08：行为分只做破同分，不进总分/奖金）');
    }
    if (!Array.isArray(behavior.events) || behavior.events.length === 0) {
      push('behavior.events 缺失或为空');
    } else if (hasBadItem(behavior.events)) {
      push('behavior.events 含非对象元素');
    } else {
      if (hasDuplicateKeys(behavior.events)) {
        push('behavior.events 存在重复 key');
      }
      for (const e of behavior.events) {
        if (typeof e.points !== 'number' || e.points <= 0) {
          push(`behavior.events 事件 ${e.key} 的 points 必须为正数`);
        }
      }
    }
  }

  // ── 可见性 ───────────────────────────────────────────────
  // 段位引用必须真实存在 —— 悬空引用会让"公示门槛"静默失效，
  // 而症状要到 P3 算榜单、对可见性过滤时才出现。
  const vis = rules?.visibility;
  if (!vis) {
    push('visibility 缺失');
  } else {
    for (const field of ['publicFromTier', 'privateBelowTier']) {
      const ref = vis.rank?.[field];
      if (typeof ref !== 'string' || !ref) {
        push(`visibility.rank.${field} 缺失`);
      } else if (tierKeys.size > 0 && !tierKeys.has(ref)) {
        push(`visibility.rank.${field} 引用了不存在的段位 ${ref}`);
      }
    }
  }

  // ── 里程碑 ───────────────────────────────────────────────
  const ms = rules?.milestones;
  if (!ms) {
    push('milestones 缺失');
  } else {
    if (!Array.isArray(ms.items) || ms.items.length === 0) {
      push('milestones.items 缺失或为空');
    } else if (hasBadItem(ms.items)) {
      push('milestones.items 含非对象元素');
    } else {
      if (hasDuplicateKeys(ms.items)) {
        push('milestones.items 存在重复 key');
      }
      for (const it of ms.items) {
        if (!VALID_CONFIRMERS.includes(it.confirmedBy)) {
          push(`milestones.items 里程碑 ${it.key} 的 confirmedBy=${it.confirmedBy} 非法`);
        }
      }
      if (!ms.items.some((it) => it.countsTowardTier)) {
        push('milestones.items 没有任何 countsTowardTier=true 的里程碑，段位将永远无法晋升');
      }
    }
  }

  // ── 组队规则（R-REG-02 / R-REG-04 / R-REG-05 已定，不可被配置改掉）──
  const tf = rules.teamFormation;
  if (!tf) {
    errors.push('teamFormation 缺失');
  } else {
    if (!(tf.teamSize?.min >= 2)) {
      errors.push('teamFormation.teamSize.min 必须 ≥ 2（R-REG-02 已定：不接受 1 人组队）');
    }
    if (tf.teamSize?.max < tf.teamSize?.min) {
      errors.push('teamFormation.teamSize.max 必须 ≥ min');
    }
    if (tf.captainMustBeMba !== true) {
      errors.push('teamFormation.captainMustBeMba 必须为 true（R-REG-05 已定：组长必须一堂 MBA 在籍）');
    }
    if (!(tf.teamsPerPackage?.min >= 1) || tf.teamsPerPackage?.max < tf.teamsPerPackage?.min) {
      errors.push('teamFormation.teamsPerPackage 必须满足 1 ≤ min ≤ max（R-REG-01：每任务包 2–3 队）');
    }
    const mixSum = (tf.packageQuotaMix?.enterprise ?? 0) + (tf.packageQuotaMix?.free ?? 0);
    if (Math.abs(mixSum - 1) > 1e-9) {
      errors.push(`teamFormation.packageQuotaMix 合计 = ${mixSum.toFixed(4)}，必须等于 1`);
    }
    if (tf.singleMemberTriggersMerge !== true) {
      errors.push('teamFormation.singleMemberTriggersMerge 必须为 true（R-REG-04 已定）');
    }
    if (!(tf.singleMemberMergeDeadlineDays > 0)) {
      errors.push('teamFormation.singleMemberMergeDeadlineDays 必须为正整数');
    }
  }

  // ── 赛程时间轴（R-STG-01）──
  const stages = rules.schedule?.stages;
  if (!Array.isArray(stages) || stages.length !== 5) {
    errors.push('schedule.stages 必须是 5 个赛段（R-STG-01）');
  } else {
    // ⚠️ 父代理预审修正（规格自相矛盾，原实现会让服务器**拒绝启动**）：
    //    原来判 `stages[i].start <= stages[i - 1].end`（要求严格递增），
    //    但 R-STG-01 的赛段表本身就是**交接式相接**的：
    //      S1 调研 10/1-10/10 → S2 任务 10/10-13 → S3 开发 10/13-25
    //      → S4 路演 10/26-28 → S5 落地 10/29-31
    //    （见 docs/requirements-traceability.md 的 R-STG-01 一行）
    //    上一段的**结束当天就是下一段的开始日** → `start == 上一段 end` 恒成立
    //    → 原规则会让计划自带的 schedule.json 校验失败 → **fail-fast 拒绝启动**
    //    → P1 一上线就是死的。父代理预审实跑复现：18 条用例全红，
    //    报错「schedule.stages 必须按时间递增（第 3 段）」。
    //    正确的判据是**不许重叠**（`start < 上一段 end`），相接是合法的；
    //    同时补一条「本段 end 不得早于本段 start」。
    for (let i = 1; i < stages.length; i += 1) {
      if (stages[i].start < stages[i - 1].end) {
        errors.push(`schedule.stages 第 ${i + 1} 段与上一段时间重叠（R-STG-01）`);
      }
    }
    for (const st of stages) {
      if (st.end < st.start) {
        errors.push(`schedule.stages ${st.key} 的结束日早于开始日`);
      }
    }
  }

  // ── 合规与 IP（R-ENT-11 / R-ENT-12）──
  if (!rules.compliance?.redLines?.length) {
    errors.push('compliance.redLines 不得为空（R-ENT-12 合规红线）');
  }
  if (!rules.compliance?.ipOwnership?.team) {
    errors.push('compliance.ipOwnership.team 缺失（R-ENT-11 团队保留 IP）');
  }

  // ── 报名问卷（R-REG-11）──
  const q = rules.registration?.questions;
  if (!q?.dimensionItems) {
    errors.push('registration.questions.dimensionItems 缺失（R-REG-11）');
  } else {
    for (const d of rules.registration.dimensions) {
      const items = q.dimensionItems[d.key] ?? [];
      if (items.length !== 5) {
        errors.push(`registration.questions.dimensionItems.${d.key} 必须是 5 题（SABC v1 §六：3 维各 5 题）`);
      }
    }
  }
  const funnel = rules.registration?.funnel;
  if (!Array.isArray(funnel) || funnel.length !== 5) {
    errors.push('registration.funnel 必须是 5 阶段（R-REG-10）');
  } else {
    for (let i = 1; i < funnel.length; i += 1) {
      const prev = funnel[i - 1].rate;
      const cur = funnel[i].rate;
      if (prev !== null && cur !== null && cur > prev) {
        errors.push(`registration.funnel 必须逐级收窄（第 ${i + 1} 段）`);
      }
    }
  }

  // ── 任务卡配比（R-ENT-09）──
  const tm = rules.solvability?.taskMix;
  if (tm) {
    const sum = (tm.enterprise ?? 0) + (tm.free ?? 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errors.push(`solvability.taskMix 合计 = ${sum.toFixed(4)}，必须等于 1（R-ENT-09：70% B 端 + 30% 自由）`);
    }
    const splitSum = Object.values(tm.enterpriseGradeSplit ?? {}).reduce((a, b) => a + b, 0);
    if (Object.keys(tm.enterpriseGradeSplit ?? {}).length && Math.abs(splitSum - (tm.enterprise ?? 0)) > 1e-9) {
      errors.push(`solvability.taskMix.enterpriseGradeSplit 合计 = ${splitSum.toFixed(4)}，必须等于 enterprise = ${tm.enterprise}`);
    }
  }

  // ── 名次积分（P3）────────────────────────────────────────
  const pts = rules.points;
  if (!pts) {
    errors.push('points 缺失');
  } else {
    if (!Array.isArray(pts.stagePoints) || !pts.stagePoints.length) {
      errors.push('points.stagePoints 缺失或为空');
    } else if (Number.isFinite(pts.stagePointsOnlyTopN)
      && pts.stagePointsOnlyTopN !== pts.stagePoints.length) {
      errors.push(`points.stagePointsOnlyTopN=${pts.stagePointsOnlyTopN} 与 stagePoints 长度 ${pts.stagePoints.length} 不一致`);
    }
    if (pts.tieRankStyle !== '1224') errors.push(`points.tieRankStyle 必须是 "1224"（当前 ${pts.tieRankStyle}）`);
    if (!pts.mvp || pts.mvp.perPackage !== 1) errors.push('points.mvp.perPackage 必须是 1（每个任务包 1 个 MVP，任务书 §七）');
    if (!pts.personal || typeof pts.personal.lifetime !== 'boolean') errors.push('points.personal.lifetime 必须是布尔值');
    // ── 个人积分口径的**唯一规则来源**（R-RNK-10）─────────────────────
    // ⚠️ 这三项（atomicKinds / rollupKind / includeMvpVote）是个人积分口径的全部依据：
    //    缺任何一项，口径就是**未定义**的（两处实现各按各的理解算 ⇒ 两个名次）。
    //    原来 atomicKinds / rollupKind 散在 rules.pools.talentPointKinds 里，
    //    而 rules.points.personal 只有 lifetime / includeMvpVote ⇒ 规则有两份、且不一致。
    const personal = pts.personal;
    if (personal) {
      if (!Array.isArray(personal.atomicKinds) || personal.atomicKinds.length === 0) {
        errors.push('points.personal.atomicKinds 必须是非空数组（个人积分的原子 kind 白名单）');
      } else {
        for (const k of personal.atomicKinds) {
          if (!LEDGER_POINT_KINDS.has(k)) {
            errors.push(`points.personal.atomicKinds 含不存在的积分 kind：${k}（合法取值：${[...LEDGER_POINT_KINDS].join(' / ')}）`);
          }
        }
      }
      if (typeof personal.rollupKind !== 'string' || !personal.rollupKind) {
        errors.push('points.personal.rollupKind 必须是非空字符串（个人积分汇总快照的 kind）');
      } else if (!LEDGER_POINT_KINDS.has(personal.rollupKind)) {
        errors.push(`points.personal.rollupKind 引用了不存在的积分 kind：${personal.rollupKind}`);
      }
      if (personal.includeMvpVote !== undefined && typeof personal.includeMvpVote !== 'boolean') {
        errors.push('points.personal.includeMvpVote 必须是布尔值');
      }
    }
  }

  // ── 段位附加条件（P3）────────────────────────────────────
  const crit = rules.criteria;
  if (!crit?.tier) {
    errors.push('criteria.tier 缺失');
  } else {
    if (!Array.isArray(crit.tier.dataOrPrototypeMilestones) || !crit.tier.dataOrPrototypeMilestones.length) {
      errors.push('criteria.tier.dataOrPrototypeMilestones 缺失或为空');
    }
    if (!Array.isArray(crit.tier.businessDepartmentKeywords) || !crit.tier.businessDepartmentKeywords.length) {
      errors.push('criteria.tier.businessDepartmentKeywords 缺失或为空');
    }
  }

  // ── MVP 决胜链（P3）──────────────────────────────────────
  // ⛔ 综合分并列时必须有决胜链，且必须以确定性键收尾 —— 否则同分 MVP 由输入顺序决定，
  //    换台机器重算可能选出不同的 MVP。
  if (!crit?.mvp || !Array.isArray(crit.mvp.tiebreak) || !crit.mvp.tiebreak.length) {
    errors.push('criteria.mvp.tiebreak 缺失或为空');
  } else {
    const known = new Set(['roadshow_points', 'team_id']);
    for (const k of crit.mvp.tiebreak) {
      if (!known.has(k)) errors.push(`criteria.mvp.tiebreak 含未知决胜键：${k}`);
    }
    if (crit.mvp.tiebreak.at(-1) !== 'team_id') {
      errors.push('criteria.mvp.tiebreak 必须以 team_id 收尾（确定性兜底）');
    }
  }

  // ── 审计与防作弊（P4）────────────────────────────────────
  const audit = rules.audit;
  if (!audit) {
    errors.push('audit 缺失');
  } else {
    for (const [name, profile] of Object.entries(audit.rateLimit ?? {})) {
      for (const layer of ['lock', 'sliding', 'perMinute', 'perHour']) {
        const l = profile?.[layer];
        if (!l) continue;
        if (layer === 'lock' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.lock.seconds 必须是正整数`);
        }
        if (layer !== 'lock' && !(Number.isInteger(l.max) && l.max > 0)) {
          errors.push(`audit.rateLimit.${name}.${layer}.max 必须是正整数`);
        }
        // ⚠️ perMinute / perHour 的窗口长度是**结构决定的**（一分钟 / 一小时）——
        //    服务层写死 60_000 / 3_600_000 毫秒，配置里没有、也**不该有** seconds：
        //    配了也不会生效（配置说了不算 = 说谎）。
        //    只有滑动窗口（sliding）的窗口长度与提交锁（lock）的持有时长是可配的。
        if (layer === 'sliding' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.sliding.seconds 必须是正整数`);
        }
      }
    }
    const lv = audit.antiCheat?.lowVariance;
    if (!lv || !(Number.isFinite(lv.min) && Number.isFinite(lv.max)) || lv.min >= lv.max) {
      errors.push('audit.antiCheat.lowVariance 必须满足 min < max');
    }
    if (!(Number.isInteger(audit.antiCheat?.identicalPeer?.minOverlap) && audit.antiCheat.identicalPeer.minOverlap >= 2)) {
      errors.push('audit.antiCheat.identicalPeer.minOverlap 必须 ≥ 2（重叠项目太少没有判定力）');
    }
    if (!(Number.isInteger(audit.retention?.archiveMonths) && audit.retention.archiveMonths > 0)) {
      errors.push('audit.retention.archiveMonths 必须是正整数（R-JDG-17 赛后 6 个月可查）');
    }
    if (!Array.isArray(audit.reviewState?.appealAllowedTiers) || audit.reviewState.appealAllowedTiers.length === 0) {
      errors.push('audit.reviewState.appealAllowedTiers 不得为空');
    }
  }

  // ── 三池与工作流（P5）────────────────────────────────────────────
  const pools = rules.pools;
  if (!pools) {
    errors.push('pools 缺失');
  } else {
    // R-OPS-14：禁止岗位制——claimMode 只允许 self_claim_only，写别的值直接拒绝启动
    if (pools.workflow?.claimMode !== 'self_claim_only') {
      errors.push('pools.workflow.claimMode 必须是 self_claim_only（R-OPS-14 禁止岗位制，不允许其他取值）');
    }
    if (!Number.isInteger(pools.publicTokenTtlDays) || pools.publicTokenTtlDays <= 0) {
      errors.push('pools.publicTokenTtlDays 必须是正整数');
    }
    if (!Array.isArray(pools.publicScopes) || !pools.publicScopes.includes('all')) {
      errors.push('pools.publicScopes 必须包含 all');
    }
    // ⚠️ 交叉引用校验：配置里写的取值必须**真实存在**。
    //    原来这一段只校验「形状」，不校验「引用」：
    //    · packageStatusFilter 里写错一个 status 拼写 → 过滤掉**全部**任务包
    //      → 资源池空掉，而且**不报任何错**（空集是合法结果）；
    //    · resourceKinds 写错 → 与派生端（RESOURCE_KINDS）对不上，配置在骗人。
    if (!Array.isArray(pools.packageStatusFilter)) {
      errors.push('pools.packageStatusFilter 必须是数组（空数组 = 不按状态过滤）');
    } else {
      for (const st of pools.packageStatusFilter) {
        if (!TASK_PACKAGE_STATUSES.includes(st)) {
          errors.push(
            `pools.packageStatusFilter 含不存在的任务包状态：${st}`
            + `（合法取值：${TASK_PACKAGE_STATUSES.join(' / ')}）`,
          );
        }
      }
    }
    if (!Array.isArray(pools.resourceKinds) || pools.resourceKinds.length === 0) {
      errors.push('pools.resourceKinds 必须是非空数组');
    } else {
      for (const k of pools.resourceKinds) {
        if (!RESOURCE_KINDS.includes(k)) {
          errors.push(
            `pools.resourceKinds 含不存在的资源类型：${k}`
            + `（合法取值：${RESOURCE_KINDS.join(' / ')}）`,
          );
        }
      }
    }
    if (pools.talentTotalScope !== 'lifetime') {
      errors.push('pools.talentTotalScope 必须是 lifetime（R-RNK-10 个人积分终生上榜）');
    }
    if (!pools.taskEvidence?.requireRunnableOrBlocker) {
      errors.push('pools.taskEvidence.requireRunnableOrBlocker 必须为 true（R-STG-04）');
    }
  }
  return errors;
}

export function loadRules(rulesDir) {
  const rules = {};
  for (const [key, file] of Object.entries(FILES)) {
    rules[key] = readJson(join(rulesDir, file));
  }

  // 重组成嵌套结构，供调用方按语义取用
  const grouped = {
    scoring: { initial: rules.scoringInitial, final: rules.scoringFinal },
    tiebreak: rules.tiebreak,
    ranks: rules.ranks,
    behavior: rules.behavior,
    visibility: rules.visibility,
    registration: rules.registration,
    solvability: rules.solvability,
    milestones: rules.milestones,
    teamFormation: rules.teamFormation,
    schedule: rules.schedule,
    compliance: rules.compliance,
    points: rules.points,
    criteria: rules.criteria,
    pools: rules.pools,
    audit: rules.audit,                    // ← P4 新增
  };

  const errors = validateRules(grouped, Object.keys(FILES).length);
  if (errors.length) {
    const list = errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`规则配置校验失败，拒绝启动：\n${list}`);
  }

  const versions = Object.values(grouped)
    .map((r) => r.version)
    .filter(Boolean);
  const version = versions.length ? versions[0] : 'unknown';

  return { rules: grouped, version };
}

// ── P3 追加：默认规则加载器 ────────────────────────────────────
// 用途：服务层在调用方没有显式注入 rules 时用它，避免"静默用默认规则"的降级。
// ⚠️ 只在没有注入时兜底；注入的 rules 优先（配置文件里的值永远是权威）。
let defaultRulesCache = null;

export function getDefaultRules() {
  if (!defaultRulesCache) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
    defaultRulesCache = loadRules(dir).rules;
  }
  return defaultRulesCache;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/config.test.js`
Expected: PASS（23 个测试全过：config 23）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/config.js rules test/config.test.js
git commit -m "feat(P0): 9 份声明式规则配置与 fail-fast 校验"
```

---

### Task 4: HTTP 路由、响应与 body 解析

> **【2026-10-20 修复轮 1】** Task 4/5/6 的评审（verifier，含 57 处变异测试）判定：
> Task 4 **Approved**，Task 5 / Task 6 **Needs fixes**（6 Important + 12 Minor，均非"主功能不可用"，
> 而是"规格声称已修好、实际未被证明/未被实现"这一类）。修复轮 1 处理如下：
> **①（Important）`test/body.test.js` 的 `assert.equal(req.destroyed, true)` 是**恒真**的** ——
>      Node 的异步迭代器在提前 break 时自己就会销毁流，把 `readJsonBody` 里的 `req.destroy()`
>      换成 `req.resume()`，这条断言照样 PASS（评审实测：变异后全量仍绿）→ 「先销毁再抛 413」没被钉住。
>      改为**探针**：统计 `destroy()` 调用次数，并在**抛错那一刻**取值 → 「销毁发生在抛错之前」被真正钉住。
>      关键手法：`req.iterator({ destroyOnReturn: false })` 让迭代器提前退出时**不**销毁流，
>      于是计数只可能来自 `readJsonBody` 自己的调用。
> **②（Important）`src/errors.js` 提前到 P0 建立**（原归属表归 P1）：契约 §0 要求「抛 `AppError`」，
>      而 Task 4 的 `body.js`（413/400）、Task 5 的 `users.js`（409）、Task 6 的 `permissions.js`（授权校验）
>      都要抛领域错误。**最早建立者拥有** → P0 建，P1/P3 直接复用，P4 只追加。
>      `body.js` 的三处错误随之改用 `appError`，全项目错误风格统一。

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **2 Critical + 1 Important**（Task 4 自带的 6 条测试里 **5 条会红**，主功能不可用）。
> 修正三处：
> **①（C4-1 Critical）路由优先级比较器写反 → 静态路径被参数路由劫持。**
>      原比较器 `b.names.length - a.names.length` 的效果是**参数段多的排前面**，与注释相反；
>      第二排序键 `a.pattern.length - b.pattern.length` 是字符串长度，与静态优先无关。
>      后果：`GET /api/leaderboard/rolling` 命中 `GET /api/leaderboard/:stageId` → **发榜数据取错**
>      （P1–P6 有 20+ 条带参路由全落在这个匹配器上）。
>      改为**逐段比较**（不是比数量，也不是比字符串长度）：第一处不同的段上**静态段胜参数段**；
>      两段都是静态但字面量不同（不可能同时匹配同一路径）→ 按字节序，保证确定性；
>      两段都是参数 → 继续比下一段；一个 pattern 先结束（另一个是它的前缀）→ **短的在前**；
>      完全相同 → 保持注册顺序。**匹配结果与注册顺序无关**（同形状两条路由谁先注册都一样）。
>      测试从 6 条增至 8 条（新增「rolling 不被 :stageId 劫持」+「正序/反序注册结果一致」）。
> **②（C4-2 Critical）畸形 URL 打死整个服务器进程。**
>      `params[name] = decodeURIComponent(hit[i + 1])` 遇到 `'%E0%A4%A'` 抛 `URIError`，
>      而 `server.js` 里 `router.match(...)` 在 `try {` **之外** → 异常越过 handle 的 try/catch →
>      Node 默认未捕获异常退出（退出码 1），**整个服务器进程死亡**。
>      P0 只有无参路由所以打不到，**P1 起（`/api/teams/:id`）即刻可远程触发**。
>      两处都改：router 内对每个捕获段做 `try { decodeURIComponent(v) } catch { 该路由不匹配 }`
>      （畸形百分号编码**不允许抛出到路由匹配之外**），`server.js` 里把 `router.match(...)`
>      **移进 `try` 块内**，并把「URL 编码非法」与「没这个接口」区分开：前者 **400**、后者 404。
> **③（I4-1 Important）body 超限时请求流未消费 → 连接悬挂。**
>      `readJsonBody` 超限直接 `throw`，客户端还在发剩余 body → 连接占住不放（慢速上传可占连接）。
>      改为超限时先 `req.destroy()`（销毁请求流）再抛 413；上层 413 响应带 `Connection: close`。
> 另：`text(res, status, body, contentType?)` 的第 4 个可选参数与契约 `text(res, status, body)`
> 不一致，但**向后兼容**，保留不动（m4-1）。

**Files:**
- Create: `platform/src/http/router.js`
- Create: `platform/src/http/respond.js`
- Create: `platform/src/errors.js`
- Create: `platform/src/http/body.js`
- Create: `platform/test/router.test.js`
- Create: `platform/test/body.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createRouter()` → `{ add(method, pattern, handler), match(method, path) }`
  - `pattern` 形如 `/api/teams/:teamId/members`，`:name` 捕获一个路径段
  - `match()` 返回 `{ handler, params }` 或 `null`（**畸形百分号编码 → 视为不匹配，返回 null**，由上层回 400）
  - `json(res, status, body)`、`text(res, status, body)`、`error(res, status, code, message)`
  - `readJsonBody(req, { limit })` → 解析后的对象；超限抛错（`status=413`，且请求流已被销毁）

- [ ] **Step 1: 写失败的测试**

`platform/test/router.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/http/router.js';

test('精确路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/me', () => 'me');
  assert.equal(r.match('GET', '/api/me').handler(), 'me');
});

test(':param 捕获路径段', () => {
  const r = createRouter();
  r.add('GET', '/api/teams/:teamId/members', (ctx) => ctx.params.teamId);
  const m = r.match('GET', '/api/teams/t_42/members');
  assert.equal(m.params.teamId, 't_42');
});

test('方法不匹配返回 null', () => {
  const r = createRouter();
  r.add('POST', '/api/teams', () => 1);
  assert.equal(r.match('GET', '/api/teams'), null);
});

test('路径不匹配返回 null', () => {
  const r = createRouter();
  r.add('GET', '/api/teams', () => 1);
  assert.equal(r.match('GET', '/api/team'), null);
});

test('注册顺序不影响匹配（静态段优先于参数段）：正序与反序注册结果一致', () => {
  // ⛔ 预审修正（C4-1）：原用例只测了一种注册顺序，而用例名承诺的是"注册顺序不影响"。
  //    现在两种注册顺序都断言同样的结果。
  const forward = createRouter();
  forward.add('GET', '/api/teams/me', () => 'static');
  forward.add('GET', '/api/teams/:id', () => 'param');
  const backward = createRouter();
  backward.add('GET', '/api/teams/:id', () => 'param');
  backward.add('GET', '/api/teams/me', () => 'static');
  for (const r of [forward, backward]) {
    assert.equal(r.match('GET', '/api/teams/me').handler(), 'static');
    assert.equal(r.match('GET', '/api/teams/other').handler(), 'param');
  }
});

test('URL 里的 query 不影响路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/leaderboard', () => 'lb');
  assert.ok(r.match('GET', '/api/leaderboard?scope=rank'));
});

test('静态路由 /api/leaderboard/rolling 不会被参数路由 /api/leaderboard/:stageId 劫持', () => {
  // ⛔ 预审修正（C4-1）：原比较器把参数段多的排前面 → rolling 会被 :stageId 劫持 → 发榜取错数据。
  for (const build of [
    (r) => {
      r.add('GET', '/api/leaderboard/rolling', () => 'rolling');
      r.add('GET', '/api/leaderboard/:stageId', () => 'stage');
    },
    (r) => {
      r.add('GET', '/api/leaderboard/:stageId', () => 'stage');
      r.add('GET', '/api/leaderboard/rolling', () => 'rolling');
    },
  ]) {
    const r = createRouter();
    build(r);
    assert.equal(r.match('GET', '/api/leaderboard/rolling').handler(), 'rolling');
    assert.equal(r.match('GET', '/api/leaderboard/st1').handler(), 'stage');
  }
});

test('畸形百分号编码不抛异常，且不匹配该路由', () => {
  // ⛔ 预审修正（C4-2）：decodeURIComponent('%E0%A4%A') 抛 URIError，
  //    抛出到路由匹配之外会打死整个服务器进程（server.js 里 router.match 在 try 之外）。
  const r = createRouter();
  r.add('GET', '/api/teams/:teamId', () => 'team');
  assert.equal(r.match('GET', '/api/teams/%E0%A4%A'), null);
});
```

`platform/test/body.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../src/http/body.js';

test('正常 JSON body 解析成对象', async () => {
  const req = Readable.from([Buffer.from('{"a":1}')]);
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('body 超限抛 413', async () => {
  const req = Readable.from([Buffer.alloc(1024, 0x61)]);
  await assert.rejects(
    () => readJsonBody(req, { limit: 10 }),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
  );
});

test('body 超限时先销毁请求流再抛 413（用探针钉住调用与顺序）', async () => {
  // ⚠️ 评审修正（Important）：原来那条 `assert.equal(req.destroyed, true)` 是**恒真**的 ——
  //    Node 的异步迭代器在提前 break 时自己就会销毁流，
  //    把 readJsonBody 里的 req.destroy() 换成 req.resume()，这条断言照样 PASS
  //    （评审实测：变异后全量 79/79 仍绿）→ 「先销毁再抛 413」这个修复没被钉住。
  //    这里改成**探针**：统计 destroy() 被调用几次，并在**抛错那一刻**取值，
  //    于是「销毁发生在抛错之前」被真正钉住。
  //    关键手法：req.iterator({ destroyOnReturn: false }) 让迭代器提前退出时**不**销毁流，
  //    于是计数只可能来自 readJsonBody 自己的 req.destroy() 调用。
  let destroyCalls = 0;
  let resumeCalls = 0;
  const req = Readable.from([Buffer.alloc(1024, 0x61)]);
  const origDestroy = req.destroy.bind(req);
  const origResume = req.resume.bind(req);
  req.destroy = (...args) => { destroyCalls += 1; return origDestroy(...args); };
  req.resume = (...args) => { resumeCalls += 1; return origResume(...args); };
  req[Symbol.asyncIterator] = () => req.iterator({ destroyOnReturn: false });

  let destroyCallsAtThrow = -1;
  await assert.rejects(
    () => readJsonBody(req, { limit: 10 }),
    (err) => {
      destroyCallsAtThrow = destroyCalls;
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
  );
  assert.equal(destroyCallsAtThrow, 1, '抛 413 之前必须已经销毁请求流');
  assert.equal(resumeCalls, 0, '有 destroy() 就不该再走 resume 兜底');
});

test('请求体上限的**默认值**是 512KB（不传 limit 时也必须限）', async () => {
  // ⛔ 终审修正（Important，I-B）：上限的**默认值**此前零断言 ——
  //    现有用例都传了显式 `{ limit: 10 }`，把默认值改成 100MB 全量测试照样全绿。
  //    而默认值才是**生产实际生效**的那个（HTTP 层调用 readJsonBody 时不传 limit）。
  //    没有上限 = 任何人都能往内存里灌任意大的 body → OOM。
  const KB = 1024;
  const MB = 1024 * KB;

  // 刚好**等于**上限 → 通过（body 必须是**合法 JSON**，否则先被 JSON 解析拦下，
  // 测的就不是「大小上限」这条护栏了）
  // ⚠️ 终审复核修正（Minor，F-2）：这里原来用 `512 * KB - 1`（差一字节），
  //    于是把实现的 `size > limit` 改成 `size >= limit` 仍然全绿（实测 SURVIVED）。
  //    边界语义是「**超过**上限才拒绝」= 恰好等于上限必须放行 →
  //    用例必须正好取 512KB 才能钉住这条。
  const mkJson = (totalBytes) => {
    const head = '{"a":"';
    const tail = '"}';
    const pad = 'x'.repeat(totalBytes - head.length - tail.length);
    return Buffer.from(head + pad + tail);
  };
  const under = Readable.from([mkJson(512 * KB)]);
  await assert.doesNotReject(() => readJsonBody(under), '正好 512KB（等于上限）必须放行');

  // 超过上限 → 413（用默认 limit，不传参）
  const over = Readable.from([mkJson(512 * KB + 1)]);
  await assert.rejects(
    () => readJsonBody(over),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
    '超过默认上限必须回 413',
  );

  // 反例对照：显式传更大的 limit 时，同一个 body 必须放行
  //（证明上一条确实是「默认上限」在起作用，而不是 body 本身有问题）
  const same = Readable.from([mkJson(512 * KB + 1)]);
  await assert.doesNotReject(
    () => readJsonBody(same, { limit: 2 * MB }),
    '显式放宽 limit 后同一 body 必须放行',
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/router.test.js test/body.test.js`
Expected: FAIL —— `Cannot find module '../src/http/router.js'`

- [ ] **Step 3: 创建 src/http/router.js**

```javascript
// src/http/router.js — 极简路由
// 依据：设计文档 §8「API 设计」+ INTERFACES.md「src/http/router.js」契约
//   （createRouter() → { add(method, pattern, handler), match(method, path), list() }；
//     pattern 形如 '/api/teams/:teamId/members'，:param 占位）。
//   路由优先级 = **逐段比较**：第一处不同的段上，静态段胜参数段。
//   （例：'/api/teams/me' 优先于 '/api/teams/:teamId'。）
// ⛔ Node 22 没有 URLPattern（Node 24 才有），所以手写。
//   不抬高运行时门槛 = 22 与 24 都能跑 = 可移植。
export function createRouter() {
  const routes = [];

  function compile(pattern) {
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${source}/?$`), names };
  }

  /**
   * 路由优先级比较器：**逐段比较**（2026-10-20 预审修正 C4-1）。
   *
   * ⛔ 不能比"参数段个数"，也不能比"pattern 字符串长度"：
   *    前者把参数路由排到静态路由前面（与静态优先相反），
   *    后者与静态优先无关 —— 两者都会让 `/api/leaderboard/rolling` 被
   *    `/api/leaderboard/:stageId` 劫持（发榜数据取错）。
   *
   * 规则（从左往右逐段比，第一处不同的段决定胜负）：
   *   ① 静态段胜参数段
   *   ② 两段都是静态但字面量不同（不可能同时匹配同一路径）→ 按字节序，保证确定性
   *   ③ 两段都是参数 → 继续比下一段
   *   ④ 一个 pattern 先结束（另一个是它的前缀）→ 短的在前（更具体）
   *   ⑤ 完全相同 → 保持注册顺序（Array.sort 稳定）
   *
   * 效果：同形状（同参数段数、同静态段数）的两条路由，先注册哪条都不影响匹配结果。
   */
  function compareRoutes(a, b) {
    const as = a.segments;
    const bs = b.segments;
    const len = Math.min(as.length, bs.length);
    for (let i = 0; i < len; i++) {
      const x = as[i];
      const y = bs[i];
      if (x === y) continue;
      const xIsParam = x.startsWith(':');
      const yIsParam = y.startsWith(':');
      if (xIsParam !== yIsParam) return xIsParam ? 1 : -1; // ① 静态段优先
      if (xIsParam && yIsParam) continue; // ③ 都是参数 → 看下一段
      return x < y ? -1 : 1; // ② 都是静态 → 字节序
    }
    return as.length - bs.length; // ④ 前缀 → 短的在前
  }

  return {
    add(method, pattern, handler) {
      const { regex, names } = compile(pattern);
      routes.push({
        method: method.toUpperCase(),
        pattern,
        segments: pattern.split('/'),
        regex,
        names,
        handler,
      });
      return this;
    },
    match(method, path) {
      const clean = path.split('?')[0];
      const m = method.toUpperCase();
      // 静态优先于参数：逐段比较（见 compareRoutes）
      const ordered = [...routes].sort(compareRoutes);
      for (const route of ordered) {
        if (route.method !== m) continue;
        const hit = route.regex.exec(clean);
        if (!hit) continue;
        const params = {};
        let malformed = false;
        route.names.forEach((name, i) => {
          if (malformed) return;
          try {
            params[name] = decodeURIComponent(hit[i + 1]);
          } catch {
            // ⛔ 畸形百分号编码（如 '%E0%A4%A'）会让 decodeURIComponent 抛 URIError。
            //    绝不能让它抛出到路由匹配之外：server.js 里 router.match 一旦在 try 块外，
            //    一个畸形 URL 就能让 Node 以未捕获异常退出（退出码 1）→ 整个服务器进程死亡。
            //    视为非法 URL → 该路由不匹配（match 返回 null），由上层回 400。
            malformed = true;
          }
        });
        if (malformed) return null;
        return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
    list() {
      return routes.map((r) => ({ method: r.method, pattern: r.pattern }));
    },
  };
}
```

- [ ] **Step 4: 创建 src/http/respond.js**

```javascript
// src/http/respond.js — 统一响应
// 三态状态码约定（设计文档 §7.3）：
//   列表查询权限不满足 → 200 + 空集（不暴露"有但不给看"）
//   单条读取权限不满足 → 404（不泄露记录是否存在）
//   规则本身被禁用     → 403
export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function error(res, status, code, message, detail) {
  json(res, status, { error: { code, message, ...(detail ? { detail } : {}) } });
}
```

- [ ] **Step 5: 创建 src/errors.js**

```javascript
// src/errors.js — 领域错误
// 依据：跨阶段契约 INTERFACES.md「错误」纪律 + 设计文档 §8 三态状态码。
//
// ⚠️ 参数顺序是 **status-first**：`appError(status, code, message, detail)`。
//    全项目统一由这里产生领域错误，HTTP 层转成 error(res, status, code, message, detail)。
//    ⛔ 不用 Node 内置错误的 .code（如 ERR_SQLITE_ERROR）—— 那是内部实现细节，
//    漏到客户端会暴露表名、列名、参数位置。
export class AppError extends Error {
  constructor(status, code, message, detail = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function appError(status, code, message, detail) {
  return new AppError(status, code, message, detail);
}
```

- [ ] **Step 6: 创建 src/http/body.js**

```javascript
// src/http/body.js — 请求体解析
// 体积上限防止一个超大 body 打满内存（可移植性约束下的最基本防护）
// 依据：跨阶段契约 INTERFACES.md §0「错误：抛 AppError（code + message + status）」。
import { appError } from '../errors.js';
export async function readJsonBody(req, { limit = 1024 * 512 } = {}) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    // ⛔ 预审修正（I4-1）：必须先把请求流消费/销毁掉再抛错。
    //    客户端可能还在发剩余 body，不消费就抛 → 连接悬挂（慢速上传能占住连接不放）。
    //    销毁请求流后，上层回 413 并带 Connection: close（连接不再复用）。
    if (typeof req.destroy === 'function') req.destroy();
    else if (typeof req.resume === 'function') req.resume();
    throw appError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw appError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    throw appError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/router.test.js test/body.test.js`
Expected: PASS（12 个测试全过：router 8 + body 4）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/errors.js src/http test/router.test.js test/body.test.js
git commit -m "feat(P0): HTTP 路由、响应与 body 解析"
```

---

### Task 5: 认证（scrypt + 服务端会话）

> **【2026-10-20 修复轮 3】** 复核评审（verifier）指出两处**零断言**的护栏：
> **①（I-6-1 Important）`verifyPassword` 的 6 段格式守卫 + `Buffer.from` 的位置。**
>      终审变异 `parts.length !== 6` → `parts.length < 5` **全量测试照样全绿** ——
>      因为当时的用例只测了 `'garbage'` 与 `''` 两种形态，都不满足「段数介于 5 和 6 之间」。
>      两条修法**互相独立、缺一不可**：
>      ①**段数守卫必须是「恰好 6 段」** —— 用**多一段**的合法哈希来钉（它的 salt/hash 是真的，
>        守卫一旦被放宽就会走进正常校验并返回 **true**）；
>      ②**`Buffer.from` 必须在 `try` 之内** —— 5 段串会让 `hashB64` 变成 `undefined`，
>        `Buffer.from(undefined)` 抛 TypeError，在 `try` 之外就是**未捕获异常**
>        → 登录热路径上整个进程退出。
>      两者合起来的危险组合（守卫放宽 + Buffer 挪出 try）已被用例杀死。
> **②（复核 Important）会话绝对过期的默认值与环境变量覆盖此前零断言。**
>      把默认 30 天改成 9999 天、或改坏 `SESSION_ABSOLUTE_TTL_DAYS` 的覆盖逻辑，
>      全量测试照样全绿 —— 而这条是「令牌泄露后最坏能用到什么时候」的硬边界
>      （设计文档 §7.5）。补 2 条用例：默认值 + 覆盖 + 非法值回落；滑动续期不得突破绝对上限。

> **【2026-10-20 修复轮 1】** 评审判定 Task 5 **Needs fixes**：
> **③（Important）没有任何断言证明"库里存的是哈希而不是明文口令"** ——
>      把 `users.js` 里的 `hashPassword(password)` 换成 `String(password)`，
>      Task 5 自己的用例照样全绿（口令哈希入库这个核心命题没被钉住）。
>      补 1 条：直接读库里的 `password_hash`，断言 `startsWith('scrypt$')`、不等于明文、验签通过。
> **④（Important）`toPublicUser` 的「不漏 password_hash」断言是恒真的** ——
>      断言的输入是 `createUser(...)` 的返回值，而它**本来就没有** `password_hash` 键，
>      于是「输出里没有」对任何照抄缺失键的实现都成立（评审实测：往输出里加上
>      `password_hash` 字段，全量仍绿）。改用 `getCredentialsByPhone(...)` —— 那一行**确实带**哈希，
>      并把对外**键集合**也精确断言住（多泄一个字段同样会红）。
> **⑤（Important）绝对过期缺失**（见本 Task 的 ⑥ 号更正）：从签发时刻算起的硬上限，
>      默认 30 天；滑动续期不得突破它。补 4 条用例。
> **⑥（Minor）盐长度 / token 熵 / 过期口径此前无断言** → 补断言钉住。
> **⑦（Minor）`revokeAssignment` 零测试覆盖**（它是契约 API）→ 补 1 条。

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **1 Critical + 4 Important + 2 Minor**（简报自带的 5 条测试里 **3 条会红**，
> 且「正确密码校验通过」直接红 → **没有人能登录**）。
> 修正六处：
> **①（C5-1 Critical）密码格式字段数自相矛盾 → 没有任何人能登录。**
>      `hashPassword` 产出 **6 段**（`scrypt$N$r$p$salt$hash`），
>      `verifyPassword` 的守卫却要求 **5 段**（`parts.length !== 5`），
>      守卫之后的解构又按 **6 段**写，测试也断言 `parts.length === 5` ——
>      实测 `verifyPassword` 对**所有合法哈希一律返回 false**。
>      连带 `createUser` 把这个哈希写进 `users.password_hash` → 全库口令都无法验证。
>      **规范侧是对的（6 段）**：INTERFACES.md:62 写 `scrypt$N$r$p$saltB64$hashB64`，
>      README 全局约束与设计文档 §7.5 同款 → 改守卫为 `parts.length !== 6`，测试断言改 6。
> **②（I5-1 Important）违反「SQL 边界」全局约束。**
>      会话的 4 处 `db.prepare` 写在 `src/auth/session.js`，而同时建的
>      `src/db/repo/sessions.js` 只剩两个辅助函数。全部 SQL 移入仓储层；
>      `src/auth/session.js` 只保留**与 SQL 无关**的逻辑（token 生成 + SHA-256 哈希 + 过期计算）。
> **③（I5-2 Important）`SELECT *` 把 password_hash 交给调用方。**
>      `listUsers` 一次性返回全体用户 + 全部 scrypt 哈希；P0 的 `/api/me` 手工挑字段所以当下安全，
>      但任何后续 handler 只要 `json(res, 200, user)` 就会把口令哈希发给浏览器。
>      仓储层 SELECT 改成**显式列白名单（不含 password_hash）**，
>      并提供 `toPublicUser(row)` 作为**唯一的对外形状**；所有返回用户的地方强制走它。
>      带哈希的行只允许 `getCredentialsByPhone` 取，且只用于服务端口令校验、绝不进响应。
> **④（I5-3 Important）重复手机号抛原始 SQLite 错误。**
>      `users.phone` 是 UNIQUE，重复注册会抛 `UNIQUE constraint failed: users.phone`
>      → 上层只能回 500，且错误原文带表名列名。P1 契约要求「重复提交 → 409，不静默覆盖」。
>      改为**先查后写**：已存在则抛**领域错误**（`status=409` / `code='PHONE_TAKEN'`）。
> **⑤（I5-4 Important）会话代码零覆盖（「只存 token_hash」无任何断言）。**
>      `password.test.js` 全程不碰数据库，`createSession`/`resolveSession`/`revoke*` **零覆盖**，
>      而 P0 验收标准明确要求「库中只存 token_hash」—— 四份简报里找不到任何断言
>      （与 Task 2「真实 DDL 从未被 apply」是同一型问题）。
>      新增 `platform/test/session.test.js`（**用真实 SQLite 库**）断言 4 条：
>      ① 库里不存在明文 token，`token_hash` 是 64 位 sha256 十六进制；
>      ② 过期 token 解析为 null 且该行被顺手删掉；
>      ③ `revokeAllSessions` 之后该用户的全部会话都失效；
>      ④ 滑动续期（见 ⑥）。
>      另加 `platform/test/users.test.js` 覆盖 ③ 与 ④ 的对外形状：
>      重复手机号 → 409 领域错误；仓储层行与对外形状都**不含 password_hash**。
> **⑥（m5-2 Minor）设计文档 §7.5 要求「绝对过期 + 滑动续期」，简报只实现了绝对过期。**
>      P0 补上**滑动续期**：`resolveSession` 命中有效会话时把 `expires_at` 顺延 `ttlDays`
>      （默认 7 天，`SESSION_TTL_DAYS` 环境变量可覆盖）→ 设计文档与实现不再不符。
>
> **⛔ 修复轮 1 更正（评审发现）**：上面那句「设计文档与实现不再不符」**当时是错的** ——
>      实现里**只有滑动续期，没有绝对过期**。滑动续期意味着：只要一直有人在用，
>      这个会话就永不过期 —— 令牌一旦泄露，攻击者可以一直用它刷新自己。
>      （评审探针实测：ttl=1 天的会话每 12 小时碰一次，跨 5 天 **10/10 次全部存活**。）
>      修复轮 1 补上**绝对过期**：从**签发时刻**（`sessions.created_at`）算起的硬上限，
>      默认 30 天（`SESSION_ABSOLUTE_TTL_DAYS` 可覆盖）；滑动续期**不得突破**它
>      （`expires_at` 被夹在绝对上限上，库里记的过期时间才是真的）。
>      补 4 条用例（`test/session.test.js`）：持续使用到硬边界仍有效、到点一律作废并删行、
>      即使 `expires_at` 被改到绝对上限之后到点仍作废、滑动续期被夹住。
> 另（m5-1 Minor）过期判定**两种口径不一致**：`resolveSession` 用 `new Date(...)`，
>      `purgeExpiredSessions` 用字符串比较 —— 不带毫秒的 ISO 串会给出相反结论。
>      统一为「**解析时间戳再比较**」：JS 侧用 `new Date(...)`，
>      SQL 侧用 SQLite 的 `datetime()`（不是字符串比较），`now` 一律归一化成 `new Date(now).toISOString()`。

**Files:**
- Create: `platform/src/auth/password.js`
- Create: `platform/src/auth/session.js`
- Create: `platform/src/db/repo/users.js`
- Create: `platform/src/db/repo/sessions.js`
- Create: `platform/test/password.test.js`
- Create: `platform/test/session.test.js`
- Create: `platform/test/users.test.js`

**Interfaces:**
- Consumes: `openDatabase()`（Task 2）
- Produces:
  - `hashPassword(plain)` → `scrypt$N$r$p$<saltB64>$<hashB64>`（**6 段**）
  - `verifyPassword(plain, stored)` → `boolean`（用 `timingSafeEqual`）
  - `createSession(db, userId, { ttlDays, now })` → `{ token, expiresAt }`（明文 token 只返回一次，库中只存 SHA-256）
  - `resolveSession(db, token, { now, ttlDays })` → `{ userId, expiresAt }` 或 `null`（命中即**滑动续期**）
  - `revokeSession(db, token)` / `revokeAllSessions(db, userId)`
  - `sessionTtlDays()` → 天数（默认 7，`SESSION_TTL_DAYS` 覆盖）
  - `createUser(db, { name, phone, password, mbaStatus, org })` → user 行（**不含 password_hash**）
  - `toPublicUser(row)` → 对外用户形状（**唯一出口**）
  - `getCredentialsByPhone(db, phone)` → 含 `password_hash` 的行（**只用于服务端口令校验**）

- [ ] **Step 1: 写失败的测试**

`platform/test/password.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('相同密码两次哈希结果不同（盐随机）', () => {
  const a = hashPassword('pw123');
  const b = hashPassword('pw123');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
});

test('正确密码校验通过', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
});

test('错误密码校验失败', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('wrong horse', stored), false);
});

test('存储格式包含成本参数', () => {
  const parts = hashPassword('x').split('$');
  // ⛔ 预审修正（C5-1）：6 段 —— scrypt$N$r$p$salt$hash
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.ok(Number.isInteger(Number(parts[1])));
});

test('损坏的存储串不抛异常，返回 false', () => {
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', ''), false);
});

// ⛔ 终审修正（Important，I-6-1）：段数守卫必须钉住「**恰好 6 段**」。
//    终审变异 `parts.length !== 6` → `parts.length < 5` 全量测试照样全绿 ——
//    因为当时的用例只测了 'garbage' 与 '' 两种形态，都不满足「段数介于 5 和 6 之间」。
//    这里用**多一段**的合法哈希：它的 salt/hash 两段是**真的**，
//    所以只要段数守卫被放宽，verifyPassword 就会走进正常校验并返回 **true**。
test('多一段的存储串（7 段）必须判 false —— 段数守卫不能被放宽', () => {
  const valid = hashPassword('pw123');
  const seven = `${valid}$extra`;
  assert.equal(seven.split('$').length, 7, '本用例的前提是 7 段');
  assert.equal(verifyPassword('pw123', seven), false, '7 段串必须被段数守卫拒绝');
  // 对照：6 段原串必须仍然通过，否则本用例就变成了「一律 false」的恒绿断言
  assert.equal(verifyPassword('pw123', valid), true, '6 段合法串必须仍然通过');
});

test('少一段的存储串（5 段）返回 false 且**不抛异常**（登录热路径不能崩）', () => {
  // ⚠️ 5 段串会让 hashB64 变成 undefined → Buffer.from(undefined) 抛 TypeError。
  //    解构出来的 salt/hash 在 try 之外时，这个 TypeError 会一路冒泡 →
  //    登录接口 500、甚至拖死进程。所以 Buffer.from 必须在 try 之内。
  const five = 'scrypt$16384$8$1$c2FsdA==';
  assert.doesNotThrow(() => verifyPassword('x', five), '5 段串不得抛异常');
  assert.equal(verifyPassword('x', five), false);
});

test('盐是 16 字节、派生密钥是 64 字节（设计文档 §7.5）', () => {
  // ⚠️ 评审修正（Minor）：盐长度此前没有任何断言钉住 —— 把 16 改成 8 也能过 CI。
  const parts = hashPassword('x').split('$');
  assert.equal(parts.length, 6);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16, '每用户独立 16 字节随机盐');
  assert.equal(Buffer.from(parts[5], 'base64').length, 64, '派生密钥 64 字节');
});
```

`platform/test/session.test.js`（**预审修正 I5-4 新增**：会话代码此前零覆盖，
P0 验收标准要求的「库中只存 token_hash」没有任何断言）：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
} from '../src/auth/session.js';

// 真实迁移目录（platform/db/migrations）：会话表必须真的被建出来。
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sess-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const user = createUser(db, { name: '会话甲', phone: '13900000002', password: 'pw' });
  return { db, close, dataDir, user };
}

test('库里只存 token_hash（SHA-256 十六进制），不存在明文 token', () => {
  const { db, close, dataDir, user } = setup();
  const { token } = createSession(db, user.id);
  const rows = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(user.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.length, 64);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  // 整张表里任何一列都不含明文 token
  for (const row of db.prepare('SELECT * FROM sessions').all()) {
    assert.ok(!Object.values(row).includes(token));
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('过期 token 解析为 null，并顺手删掉该行', () => {
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 1, now });
  assert.ok(resolveSession(db, token, { now: new Date('2026-01-01T12:00:00.000Z'), ttlDays: 1 }));
  const later = new Date('2026-01-03T00:00:00.000Z');
  assert.equal(resolveSession(db, token, { now: later, ttlDays: 1 }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('revokeAllSessions 之后该用户的全部会话都失效', () => {
  const { db, close, dataDir, user } = setup();
  const a = createSession(db, user.id);
  const b = createSession(db, user.id);
  assert.ok(resolveSession(db, a.token));
  assert.ok(resolveSession(db, b.token));
  revokeAllSessions(db, user.id);
  assert.equal(resolveSession(db, a.token), null);
  assert.equal(resolveSession(db, b.token), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('有效会话被访问时滑动续期（expires_at 顺延 ttlDays）', () => {
  // 依据：设计文档 §7.5「绝对过期 + 滑动续期」
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token, expiresAt } = createSession(db, user.id, { ttlDays: 1, now });
  assert.equal(expiresAt, '2026-01-02T00:00:00.000Z');
  const later = new Date('2026-01-01T06:00:00.000Z');
  const got = resolveSession(db, token, { now: later, ttlDays: 1 });
  assert.ok(got);
  assert.equal(got.expiresAt, '2026-01-02T06:00:00.000Z');
  // 库里也确实续期了
  const row = db.prepare('SELECT expires_at FROM sessions').get();
  assert.equal(row.expires_at, '2026-01-02T06:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('会话有绝对过期上限：持续使用也不能无限续命', () => {
  // ⚠️ 评审修正（Important）：设计文档 §7.5 明写「绝对过期 + 滑动续期」，
  //    原来**只实现了滑动续期** —— 只要一直有人在用，这个会话就永不过期。
  //    （评审探针实测：ttl=1 天的会话每 12 小时碰一次，跨 5 天 10/10 次全部存活。）
  //    绝对上限从**签发时刻**算起，到点一律作废，不因使用频率而延后。
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  // 签发于 2026-01-01，绝对上限 10 天 → 硬边界是 2026-01-11T00:00:00.000Z
  const { token } = createSession(db, user.id, { ttlDays: 1, absoluteTtlDays: 10, now });
  // 每 12 小时碰一次 → 滑动续期一直把 expires_at 往后推（签发后 10 天内一直有效）
  for (let h = 12; h < 10 * 24; h += 12) {
    const at = new Date(now.getTime() + h * 3600_000);
    assert.ok(
      resolveSession(db, token, { now: at, ttlDays: 1, absoluteTtlDays: 10 }),
      `第 ${h} 小时应仍然有效（滑动续期生效中）`,
    );
  }
  // 越过绝对上限 → 一律作废并删行（哪怕上一分钟刚用过）
  assert.equal(resolveSession(db, token, {
    now: new Date('2026-01-11T00:00:00.000Z'), ttlDays: 1, absoluteTtlDays: 10,
  }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('即使 expires_at 被改到绝对上限之后，到点仍作废', () => {
  // 绝对上限**不依赖** expires_at：库里的行即使被改成很远的将来（历史数据 / 被篡改），
  // 到硬边界也必须作废 —— 否则"绝对过期"就只是一个装饰性字段。
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 1, absoluteTtlDays: 10, now });
  db.prepare("UPDATE sessions SET expires_at = '2026-12-31T00:00:00.000Z' WHERE user_id = ?").run(user.id);
  assert.equal(resolveSession(db, token, {
    now: new Date('2026-01-11T00:00:00.000Z'), ttlDays: 1, absoluteTtlDays: 10,
  }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动续期不得越过绝对上限', () => {
  // ttl(30 天) > absolute(10 天) 时，expires_at 必须被夹在绝对上限上，
  // 否则库里记的过期时间会比真实可用的时间更晚 —— 审计链在说谎。
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 30, absoluteTtlDays: 10, now });
  const row = db.prepare('SELECT expires_at FROM sessions').get();
  assert.equal(row.expires_at, '2026-01-11T00:00:00.000Z');
  const got = resolveSession(db, token, {
    now: new Date('2026-01-05T00:00:00.000Z'), ttlDays: 30, absoluteTtlDays: 10,
  });
  assert.equal(got.expiresAt, '2026-01-11T00:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('会话 token 是 32 字节随机（base64url 43 字符）', () => {
  // ⚠️ 评审修正（Minor）：token 熵此前没有任何断言钉住。
  const { db, close, dataDir, user } = setup();
  const a = createSession(db, user.id).token;
  const b = createSession(db, user.id).token;
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b, '两个会话的 token 必须不同');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⛔ 复核发现（Important）：绝对过期的**默认值**与**环境变量覆盖**此前零断言 ——
//    把默认值改成 9999 天、或把 SESSION_ABSOLUTE_TTL_DAYS 覆盖逻辑改坏，
//    全量测试照样全绿。而这条是「令牌泄露后最坏能用到什么时候」的硬边界。
test('绝对过期默认是 30 天，且可由 SESSION_ABSOLUTE_TTL_DAYS 覆盖', async () => {
  const { sessionAbsoluteTtlDays } = await import('../src/auth/session.js');
  const original = process.env.SESSION_ABSOLUTE_TTL_DAYS;
  try {
    delete process.env.SESSION_ABSOLUTE_TTL_DAYS;
    assert.equal(sessionAbsoluteTtlDays(), 30, '绝对过期默认必须是 30 天（设计文档 §7.5）');

    process.env.SESSION_ABSOLUTE_TTL_DAYS = '7';
    assert.equal(sessionAbsoluteTtlDays(), 7, '必须能被 SESSION_ABSOLUTE_TTL_DAYS 覆盖');

    // 非法值必须回落到默认值，而不是变成 NaN / 0 / 负数
    process.env.SESSION_ABSOLUTE_TTL_DAYS = 'abc';
    assert.equal(sessionAbsoluteTtlDays(), 30, '非法值必须回落到默认值');
    process.env.SESSION_ABSOLUTE_TTL_DAYS = '-1';
    assert.equal(sessionAbsoluteTtlDays(), 30, '负数必须回落到默认值');
    process.env.SESSION_ABSOLUTE_TTL_DAYS = '0';
    assert.equal(sessionAbsoluteTtlDays(), 30, '0 必须回落到默认值');
  } finally {
    if (original === undefined) delete process.env.SESSION_ABSOLUTE_TTL_DAYS;
    else process.env.SESSION_ABSOLUTE_TTL_DAYS = original;
  }
});

test('滑动续期不得突破绝对过期上限（设计文档 §7.5）', async () => {
  const { db, close, dataDir, user } = setup();
  const { createSession, resolveSession } = await import('../src/auth/session.js');
  const issuedAt = new Date('2026-10-01T00:00:00.000Z');
  // 签发时给了 100 天，但绝对上限只有 30 天 → 不得超过 30 天
  const { token, expiresAt } = createSession(db, user.id, {
    ttlDays: 100, absoluteTtlDays: 30, now: issuedAt,
  });
  const issuedPlus30 = new Date(issuedAt.getTime() + 30 * 86400_000).toISOString();
  assert.equal(expiresAt, issuedPlus30, '会话有效期不得越过绝对上限');

  // 第 20 天使用 → 滑动续期到「第 20 天 + 100 天」，但仍不得超过签发 + 30 天
  const day20 = new Date(issuedAt.getTime() + 20 * 86400_000);
  const renewed = resolveSession(db, token, {
    ttlDays: 100, absoluteTtlDays: 30, now: day20,
  });
  assert.ok(renewed, '第 20 天会话仍应有效');
  assert.equal(renewed.expiresAt, issuedPlus30, '滑动续期不得突破绝对上限');

  // 第 31 天 → 一律作废（即使刚用过）
  const day31 = new Date(issuedAt.getTime() + 31 * 86400_000);
  assert.equal(
    resolveSession(db, token, { ttlDays: 100, absoluteTtlDays: 30, now: day31 }),
    null,
    '超过绝对上限后必须作废',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

`platform/test/users.test.js`（**预审修正 I5-2 / I5-3 新增**）：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  createUser,
  getUserById,
  getCredentialsByPhone,
  listUsers,
  toPublicUser,
  deactivateUser,
} from '../src/db/repo/users.js';
import { verifyPassword } from '../src/auth/password.js';
import { AppError } from '../src/errors.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-users-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

test('重复手机号抛 409 领域错误，不漏原始 SQLite 错误', () => {
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000003', password: 'pw' });
  assert.throws(
    () => createUser(db, { name: '乙', phone: '13900000003', password: 'pw' }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PHONE_TAKEN');
      assert.ok(!/UNIQUE constraint/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('仓储层的行与对外形状都不含 password_hash', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900000004', password: 'pw' });
  assert.equal(user.password_hash, undefined);
  assert.equal(getUserById(db, user.id).password_hash, undefined);
  for (const row of listUsers(db)) {
    assert.equal(row.password_hash, undefined);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('库里存的是 scrypt 哈希，不是明文口令', () => {
  // ⚠️ 评审修正（Important）：Task 5 的核心命题就是"口令哈希入库"，
  //    但原来**没有任何断言**证明这一点 —— 把 hashPassword(password) 换成
  //    String(password)（明文入库），Task 5 自己的用例全绿。
  //    这里直接读库里的 password_hash 验三件事：格式是 scrypt$、不等于明文、验签通过。
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000009', password: 'pw-plain' });
  const cred = getCredentialsByPhone(db, '13900000009');
  assert.ok(cred.password_hash.startsWith('scrypt$'), '库里必须是 scrypt 哈希');
  assert.notEqual(cred.password_hash, 'pw-plain', '库里不能是明文口令');
  assert.equal(verifyPassword('pw-plain', cred.password_hash), true);
  assert.equal(verifyPassword('other', cred.password_hash), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('toPublicUser 对带哈希的行也不漏 password_hash（对外键集合精确）', () => {
  // ⚠️ 评审修正（Important）：原来断言的是 toPublicUser(createUser(...))，
  //    而 createUser 的返回值**本来就没有** password_hash 键 ——
  //    "输出里没有 password_hash"对任何"照抄缺失键"的实现都成立 = 恒真断言。
  //    （评审实测：往 toPublicUser 里加上 password_hash 字段，全量 79/79 仍绿。）
  //    这里改用 getCredentialsByPhone —— 那一行**确实带** password_hash，
  //    再把对外键集合也精确断言住（多泄一个字段同样会红）。
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000010', password: 'pw' });
  const cred = getCredentialsByPhone(db, '13900000010');
  assert.ok(cred.password_hash, '前提：这一行确实带 password_hash');
  const pub = toPublicUser(cred);
  assert.equal(pub.password_hash, undefined);
  assert.equal(pub.passwordHash, undefined);
  assert.deepEqual(
    Object.keys(pub).sort(),
    ['active', 'createdAt', 'id', 'isSuperadmin', 'mbaStatus', 'name', 'org', 'phone'],
    '对外形状的键集合必须精确等于约定的 8 个字段（多一个也算泄露）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('停用用户的手机号不能被再次注册（查重不看 active）（终审 I-6-7）', () => {
  // ⛔ 终审发现（Important）：查重函数刻意**不看 active**（源码注释明写）——
  //    否则停用用户可以被**冒名重新注册**（别人拿他的手机号注册新账号）。
  //    这条不变量此前没有任何断言钉住：给查重加上 `AND active = 1` 全量测试照样全绿。
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900000007', password: 'pw' });
  deactivateUser(db, user.id);
  assert.throws(
    () => createUser(db, { name: '乙冒名', phone: '13900000007', password: 'pw' }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PHONE_TAKEN');
      return true;
    },
    '停用用户的手机号不得被再次注册',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/password.test.js test/session.test.js test/users.test.js`
Expected: FAIL —— `Cannot find module '../src/auth/password.js'`

- [ ] **Step 3: 创建 src/auth/password.js**

```javascript
// src/auth/password.js — 密码哈希
// 依据：设计文档 §7.5。用 node:crypto 内置 scrypt，零 npm 依赖。
// 存储格式：scrypt$N$r$p$<saltB64>$<hashB64>
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  // ⛔ 预审修正（C5-1）：守卫原来写 5 段，但 hashPassword 产出的是 6 段
  //    （scrypt$N$r$p$salt$hash）→ 合法哈希一律被判为 false，没有人能登录。
  //    规范侧是 6 段（INTERFACES.md:62 / 设计文档 §7.5），守卫与解构必须一致。
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;

  // ⛔ 终审修正（Important，I-6-1）：Buffer.from 必须在 try **里面**。
  //    6 段守卫挡住的是「段数不对」，但段数对了不代表内容对：
  //    段数守卫一旦被改坏（终审变异 `!== 6` → `< 5`），5 段串会让
  //    hashB64 变成 undefined → Buffer.from(undefined) 抛 TypeError
  //    → 而它在 try 外面 → **未捕获异常** → 登录热路径上整个进程退出。
  //    现状（守卫正确）不抛，但这条不变量没有任何断言钉住 —— 放进 try 是
  //    第二道防线，与守卫互不依赖。
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = scryptSync(String(plain), salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
  } catch {
    return false;
  }
  // 常时比较，避免时序侧信道
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: 创建 src/auth/session.js**

```javascript
// src/auth/session.js — 服务端会话
// 依据：设计文档 §7.5。⛔ 不做无状态 JWT —— 难撤销、难审计、难强制下线。
//   token 只在签发时返回一次，数据库只存 SHA-256 哈希。
// ⛔ 本文件**不含任何 SQL**（全局约束「所有 SQL 收进 src/db/repo/」）：
//   这里只做与 SQL 无关的事 —— 生成 token、算 SHA-256 哈希、算过期时间。
//   （预审修正 I5-1：原来 4 处 db.prepare 写在这里，仓储层只剩两个辅助函数。）
import { randomBytes, createHash } from 'node:crypto';
import {
  insertSession,
  findSessionByHash,
  touchSessionExpiry,
  deleteSessionByHash,
  deleteSessionsByUser,
} from '../db/repo/sessions.js';

const DEFAULT_TTL_DAYS = 7;

// 绝对过期上限（天）。设计文档 §7.5 明写「绝对过期 + 滑动续期」——
// ⛔ 评审修正（Important）：原来**只实现了滑动续期**。滑动续期意味着：
//    只要一直有人在用，这个会话就永远不过期 —— 令牌一旦泄露，攻击者可以
//    一直用它刷新自己。绝对上限给"最坏情况下多久必须重新登录"一个硬边界。
//    绝对上限从**签发时刻**算起（sessions.created_at），滑动续期不得突破它。
const DEFAULT_ABSOLUTE_TTL_DAYS = 30;

// 会话有效期（天）。默认 7 天，用 SESSION_TTL_DAYS 覆盖。
// 每次调用时读 env（不在模块加载时固化）→ 改 env 立即生效，测试也好构造。
export function sessionTtlDays() {
  const raw = process.env.SESSION_TTL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

/** 绝对过期上限（天）。默认 30 天，用 SESSION_ABSOLUTE_TTL_DAYS 覆盖。 */
export function sessionAbsoluteTtlDays() {
  const raw = process.env.SESSION_ABSOLUTE_TTL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_ABSOLUTE_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ABSOLUTE_TTL_DAYS;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function expiryFrom(now, ttlDays) {
  return new Date(now.getTime() + ttlDays * 86400_000).toISOString();
}

/** 取两个 ISO 时间戳中**较早**的那个 —— 滑动续期不得越过绝对上限。 */
function earlierIso(a, b) {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

export function createSession(
  db,
  userId,
  { ttlDays = sessionTtlDays(), absoluteTtlDays = sessionAbsoluteTtlDays(), now = new Date() } = {},
) {
  const token = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = expiryFrom(now, absoluteTtlDays);
  const expiresAt = earlierIso(expiryFrom(now, ttlDays), absoluteExpiresAt);
  insertSession(db, {
    tokenHash: tokenHash(token),
    userId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

export function resolveSession(
  db,
  token,
  { now = new Date(), ttlDays = sessionTtlDays(), absoluteTtlDays = sessionAbsoluteTtlDays() } = {},
) {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = findSessionByHash(db, hash);
  if (!row) return null;
  const nowMs = now.getTime();
  // 过期判定：解析时间戳再比较，**不做字符串比较**
  // （'...T00:00:00Z' 与 '...T00:00:00.000Z' 字符串比较会给出相反结论）
  //
  // ⛔ 评审修正（Important）：绝对过期（设计文档 §7.5）。
  //    原来只查 expires_at，而 expires_at 每次滑动续期都被推后 →
  //    一个被持续使用的会话可以永不过期。绝对上限从**签发时刻**算起，
  //    到点一律作废（并删行），不因使用频率而延后。
  const absoluteExpiresAt = expiryFrom(new Date(row.created_at), absoluteTtlDays);
  if (new Date(absoluteExpiresAt).getTime() <= nowMs) {
    deleteSessionByHash(db, hash);
    return null;
  }
  if (new Date(row.expires_at).getTime() <= nowMs) {
    deleteSessionByHash(db, hash);
    return null;
  }
  // 滑动续期（设计文档 §7.5）：命中有效会话就顺延一个 ttl，但不得越过绝对上限。
  const expiresAt = earlierIso(expiryFrom(now, ttlDays), absoluteExpiresAt);
  touchSessionExpiry(db, hash, expiresAt);
  return { userId: row.user_id, expiresAt };
}

export function revokeSession(db, token) {
  if (!token) return 0;
  return deleteSessionByHash(db, tokenHash(token));
}

export function revokeAllSessions(db, userId) {
  return deleteSessionsByUser(db, userId);
}
```

- [ ] **Step 5: 创建 src/db/repo/users.js 与 src/db/repo/sessions.js**

`platform/src/db/repo/users.js`：

```javascript
// src/db/repo/users.js — 用户仓储
// 依据：设计文档 §7.2。所有 SQL 收进仓储层，handler 内禁止裸 SQL。
//
// ⛔ 预审修正（I5-2）：SELECT 一律**显式列白名单，不含 password_hash**。
//    原来用 SELECT *，listUsers 一次返回全体用户 + 全部 scrypt 哈希 ——
//    P0 的 /api/me 手工挑字段所以当下安全，但任何后续 handler 只要
//    `json(res, 200, user)` 就会把口令哈希发给浏览器。
//    带哈希的行只允许 getCredentialsByPhone 取，且只用于服务端口令校验。
const PUBLIC_COLUMNS = 'id, name, phone, mba_status, org, is_superadmin, active, created_at';

import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../auth/password.js';
import { appError } from '../../errors.js';

/**
 * 对外用户形状（**唯一出口**）：字段转驼峰，绝不带 password_hash。
 * 所有要把用户放进 HTTP 响应的地方都必须走它。
 */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    mbaStatus: row.mba_status,
    org: row.org ?? null,
    isSuperadmin: row.is_superadmin === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function createUser(db, { name, phone, password, mbaStatus = 'other', org = null }) {
  // ⛔ 预审修正（I5-3）：重复手机号**先查后写**，抛领域错误（409 / PHONE_TAKEN）。
  //    原来直接 INSERT，让原始 SQLite 错误 `UNIQUE constraint failed: users.phone`
  //    漏到 HTTP 层 —— 既只能回 500，又把表名列名暴露给客户端。
  //    查重不看 active：停用用户的手机号也不能被再次注册。
  if (findUserByPhone(db, phone)) {
    throw appError(409, 'PHONE_TAKEN', '该手机号已注册');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
  ).run(id, name, phone, hashPassword(password), mbaStatus, org, now);
  return getUserById(db, id);
}

export function getUserById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND active = 1`).get(id) ?? null;
}

/** 不看 active —— 唯一性查重用（停用用户的手机号也不能被再次注册）。 */
export function findUserByPhone(db, phone) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE phone = ?`).get(phone) ?? null;
}

export function getUserByPhone(db, phone) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE phone = ? AND active = 1`).get(phone) ?? null;
}

/**
 * ⛔ 唯一会取出 password_hash 的地方 —— 只用于服务端口令校验（登录），
 *    绝不进任何 HTTP 响应。对外一律用 toPublicUser(row)。
 */
export function getCredentialsByPhone(db, phone) {
  return db
    .prepare('SELECT id, password_hash, active FROM users WHERE phone = ?')
    .get(phone) ?? null;
}

export function listUsers(db, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE active = 1 ORDER BY created_at LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

/**
 * 用户是否存在（不看 active —— 停用是软删除，记录仍在）。
 * ⛔ 评审修正（Important）：授权前校验用 —— 不校验就是让 SQLite 的原始外键错误冒到 HTTP 层。
 */
export function userExists(db, id) {
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) !== undefined;
}

// ⛔ 软删除：禁止硬删（设计文档 §11「事后篡改」防护）
export function deactivateUser(db, id) {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
}

/**
 * 把用户标记为超管（is_superadmin = 1）。
 *
 * ⛔ 评审修正（I-7）：scripts/seed.js 原来在这里写裸 SQL
 *    db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?')
 *    —— 越过 SQL 边界（脚本里禁止裸 SQL）。这里下沉到仓储层。
 *    ⚠️ 只置位、不复位：调用方负责「授权」的语义（种子脚本只在建号时调用一次）。
 */
export function setSuperadmin(db, userId) {
  db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(userId);
}
```

`platform/src/db/repo/sessions.js`：

```javascript
// src/db/repo/sessions.js — 会话仓储
// 依据：设计文档 §7.5 + 全局约束「所有 SQL 收进 src/db/repo/」。
// ⛔ 预审修正（I5-1）：会话的全部 SQL 从 src/auth/session.js 搬到这里。
// ⛔ 库里只存 token_hash（SHA-256 十六进制），**不存明文 token**。
export function insertSession(db, { tokenHash, userId, createdAt, expiresAt }) {
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(tokenHash, userId, createdAt, expiresAt);
}

export function findSessionByHash(db, tokenHash) {
  // ⚠️ created_at 必须一起取：绝对过期上限是从**签发时刻**算起的（设计文档 §7.5），
  //    没有签发时刻就无从判断"这个会话最多能活多久"。
  return db
    .prepare('SELECT user_id, created_at, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) ?? null;
}

/** 滑动续期：把 expires_at 顺延（设计文档 §7.5） */
export function touchSessionExpiry(db, tokenHash, expiresAt) {
  return db
    .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(expiresAt, tokenHash).changes;
}

export function deleteSessionByHash(db, tokenHash) {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
}

export function deleteSessionsByUser(db, userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function countActiveSessions(db, userId, { now = new Date() } = {}) {
  // ⛔ 预审修正（m5-1）：过期判定**解析时间戳再比较**，不做字符串比较。
  //    字符串比较下 '...T00:00:00Z' 与 '...T00:00:00.000Z' 会给出相反结论。
  //    SQL 侧用 SQLite 的 datetime()（与 JS 侧 new Date(...) 同一口径）。
  return db
    .prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND datetime(expires_at) > datetime(?)',
    )
    .get(userId, new Date(now).toISOString()).n;
}

export function purgeExpiredSessions(db, { now = new Date() } = {}) {
  return db
    .prepare('DELETE FROM sessions WHERE datetime(expires_at) <= datetime(?)')
    .run(new Date(now).toISOString()).changes;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/password.test.js test/session.test.js test/users.test.js`
Expected: PASS（23 个测试全过：password 8 + session 10 + users 5）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/auth src/db/repo test/password.test.js test/session.test.js test/users.test.js
git commit -m "feat(P0): scrypt 密码哈希与服务端会话"
```

---

### Task 6: 权限模型（capability + assignment）

> **【2026-10-20 修复轮 3】** 终审发现（Important）：**`can()` 与 `scopeClause()` 在数字
> `scope_id` 下给出相反结论**，违反 `INTERFACES.md`「两者**必须给出相同结论**」。
> 根因是**两侧的类型不一致**，必须**同时**归一，**只改一侧会把矛盾换个方向**：
> ①`can()` 原来用 JS 严格相等 `row.scope_id === ctx.scopeId` ——
>    `assignments.scope_id` 是 TEXT 列，取回是字符串 `'42'`，而 `ctx.scopeId`
>    若来自 `parseInt()` 就是数字 `42` → `'42' !== 42` → false；
> ②`scopeClause` 单资源模式把 `scopeId` **原样绑定**成参数 ——
>    实测（node:sqlite）：**绑定参数没有类型亲和**，SQLite 不会把列的 TEXT 亲和
>    应用到它身上，所以 `WHERE scope_id = ?` 绑整数 `42` **匹配不上** TEXT `'42'`
>    （而 SQL 字面量 `42` 可以，因为字面量会吃列的亲和）。
> 修法：`can()` 用 `String()` 比较（`scopeIdEquals`），`scopeClause` 绑定 `String(scopeId)`。
> 补 1 条用例同时覆盖**两种 scopeClause 模式**（单资源 + 行级）与 **两种 scopeId 形态**
> （字符串 / 数字），并带「无关 scopeId 两边都必须拒绝」的反例对照。

> **【2026-10-20 修复轮 1】** 评审判定 Task 6 **Needs fixes**：
> **⑧（Important）`scopeClause()` 与 `can()` 对超管、角色授权给出**相反结论** ——
>      `can()` = true（超管什么都能干 / 角色命中能力），`scopeClause` 却过滤出 **0 行**。
>      这直接违反 `INTERFACES.md:22`「判定只有 `can()` 一个入口，SQL 层过滤用 `scopeClause(...)」**：
>      一个说"有权限"，另一个说"看不到任何行"。P0 没有调用方，但 P2 计划明写
>      「行级 scope 由 P3/P4 的 scopeClause 补齐」—— P3/P4 的列表接口一接，
>      超管和角色授权用户就会看到**空列表**。
>      修法：`scopeClause` 生成的 SQL **自包含**地纳入「启用门禁 + 超管 + role_capability」三条路径，
>      签名不变（`scopeClause(userId, capability, {...})`），调用方零改动。
>      设计文档 §7.1 的判定顺序（超管 → true；role_capability 命中 → true）本来就是这个语义。
> **⑨（Important）`grantAssignment` 把 SQLite 原始外键错误漏到 HTTP 层** ——
>      capability 未注册 / user 不存在时直接 INSERT → `FOREIGN KEY constraint failed`
>      （无 `.status` → 只能回 500，且暴露表结构）。这与 I5-3（`users.phone` 重复）同型，当时修了，这儿漏了。
>      改为抛领域错误：`400 CAPABILITY_UNKNOWN` / `404 USER_NOT_FOUND`。
> **⑩（Important）alias 注入白名单**零测试覆盖** —— 把整行删掉，13 条用例照样全绿。补注入载荷用例。
> **⑪（Minor）`can()` 对缺 `user.id` 的用户抛 TypeError**（node:sqlite 绑定 undefined）→ HTTP 500。
>      权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉" → 改为 fail-closed 返回 false。
> **⑫（Minor）`active` 的**布尔形状**（正是 `toPublicUser` 产出的形状）没被钉住** → 补断言。
> **⑬（Minor）`AppError` 全仓从未定义**（契约 §0 要求）→ 见 Task 4：`src/errors.js` 提前到 P0 建立。

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **2 Critical + 3 Important + 1 Minor**（简报自带的 6 条测试里 **4 条会红**，
> 且「没有授权时能力为 false」直接抛 `no such column: rc.role_key`
> → **普通用户的一切权限判定全变 500**）。
> 修正六处：
> **①（C6-1 Critical）SQL 用了 schema 里不存在的列 → 权限判定对任何普通用户都抛错。**
>      简报写 `JOIN role_capabilities rc ON rc.role_key = ur.role_key`，
>      而 `platform/db/migrations/001_init.sql:37-41` 的列名是 **`role_id`**
>      （`role_id TEXT NOT NULL REFERENCES roles(key)`）。
>      `can()` 是全项目**唯一**权限入口（P1–P6 全部依赖），它对非超管一律抛错 → HTTP 层全变 500。
>      同一份 Task 7 的 seed.js 写的是对的（`INSERT OR IGNORE INTO role_capabilities (role_id, capability)`）
>      → 这是 Task 6 的单点笔误。改为 `rc.role_id`。
> **②（C6-2 Critical）scopeClause 占位符数与 params 数不一致 + 语义自相矛盾。**
>      原实现 SQL 里 3 个占位符却推了 4 个值 → `column index out of range`；
>      去掉多出的 param 后能执行，但**恒返回空集** —— `a.scope_id = t.id` 拿的是**行主键**，
>      与传入的 `scopeId` 无关。语义被混成两件事：「按行过滤」vs「按资源过滤」。
>      **语义写死（本 Task 定稿）**：`scopeClause` 只做**行级过滤** ——
>      把用户的授权映射到资源表的每一行；「用户对某一个具体资源有没有权限」
>      是 `can()` 的职责（走 ctx），不是 `scopeClause` 的。
>      模式一（行级，推荐）：传 scopeType + alias → `params [userId, capability, scopeType]`；
>      模式二（单资源）：传 scopeType + scopeId（不传 alias）→ `params [userId, capability, scopeType, scopeId]`；
>      都不传 → 只认 global 授权 → `params [userId, capability]`。
>      **alias 与 scopeId 互斥**（同时给 → 抛错，fail-fast，不静默挑一个）；
>      **给了 scopeType 但 alias / scopeId 都没给 → 抛错**；
>      **params 个数必须永远等于 SQL 里的占位符个数**（这次出事的根因）。
>      配套用例改成**真执行 SQL**：造两张资源行（一张有权、一张无权），
>      用 `db.prepare('SELECT id FROM <表> t WHERE ' + sql).all(...params)` 断言结果集，
>      不再只断言 `sql.includes('?')`（那是恒真条件 —— 实现是坏的时候用例照样 PASS）。
> **③（I6-1 Important）listAssignments 签名与跨阶段契约冲突。**
>      契约（INTERFACES.md:76，唯一事实来源）是 `listAssignments(db, { userId, capability })`，
>      简报写的是 `listAssignments(db, userId, capability)` →
>      P1–P6 按契约调用会把对象当 userId 绑定（node:sqlite 抛错/查不到）。
>      统一为**契约形式**（**不改 INTERFACES.md** —— 改契约 = 后面所有阶段都要改）。
> **④（I6-2 Important）Files 声明要建 `src/db/repo/assignments.js`，但没有任何一步创建它。**
>      assignments 的 SQL 全写在 `src/auth/permissions.js` → 既违反「SQL 收进 src/db/repo/」，
>      又留下一份永久缺失的承诺文件（P0 计划的目录树也列了它）。
>      补一步：新建 `platform/src/db/repo/assignments.js`（grant / revoke / list 三条 SQL），
>      `src/auth/permissions.js` 改为 import 仓储层；**Files 段落与 P0 目录树两边同步**。
> **⑤（I6-3 Important）Step 1 的「角色能力命中即为 true」用例没有任何断言。**
>      插完数据就 `close()` → 恒真用例，中间任何一次"跑测试确认通过"都无法证明角色能力这条路径。
>      **Step 1 直接写带断言的版本**（断言 `can()` 对有该角色能力的用户返回 true）；
>      原来的 Step 5「修正测试」改为「**核对列名与 `001_init.sql` 一致**」的说明步骤。
> **⑥（m6-1 Minor）`user.active` 判断依赖调用方传的对象形状。**
>      `if (user.active === 0) return false;` —— 传入 `{ id, is_superadmin: 1 }`（无 `active` 字段）时，
>      被停用的用户会被判为有权。改为 `if (user.active !== undefined && !user.active) return false;`
> 另：**上级作用域不隐式下推**（edition 授权不自动覆盖其下的 task_package）
>      —— 写进代码注释与规则文档（本计划 Global Constraints 的「作用域」一行）。
> 测试从 6 条增至 **12 条**。

**Files:**
- Create: `platform/src/auth/permissions.js`
- Create: `platform/src/db/repo/assignments.js`
- Create: `platform/test/permissions.test.js`

**Interfaces:**
- Consumes: `openDatabase()`（Task 2）、迁移里的 `capabilities` / `roles` / `role_capabilities` / `assignments` / `user_roles` 表（Task 2）
- Produces:
  - `can(user, capability, ctx, db)` → `boolean`（**唯一判定入口**）
  - `ctx` 形如 `{ scopeType, scopeId }`
  - `grantAssignment(db, { userId, capability, scopeType, scopeId, grantedBy })`
  - `revokeAssignment(db, assignmentId)`
  - `listAssignments(db, { userId, capability })`（**契约形式**，INTERFACES.md:76）
  - `scopeClause(userId, capability, { scopeType, scopeId, alias })` → `{ sql, params }`
    ——生成 WHERE 片段（**必须在 SQL 层过滤，不能先查全量再在 JS 里 filter**）；
    `alias` 与 `scopeId` 互斥，给错组合直接抛错

- [ ] **Step 1: 写失败的测试**

`platform/test/permissions.test.js`：

```javascript
// platform/test/permissions.test.js —— capability + assignment 权限模型
//
// 规则溯源（本文件每条断言对应的来源文档与章节）：
//   - 「权限不靠角色枚举，靠『能力 + 授权记录』」→ 设计文档 §7.1 / §7.2
//   - 「can() 是唯一判定入口」→ 设计文档 §7.1；跨阶段契约见 INTERFACES.md:76
//   - 「权限过滤必须在 SQL 的 WHERE 里，不能先查全量再在 JS 里 filter」
//     → 设计文档 §7.2 约束 2
//   - 「上级作用域不隐式下推（edition 授权不自动覆盖其下的 task_package）」
//     → 设计文档 §7.2 作用域约定
//   - 「所有 SQL 收进 src/db/repo/」→ 全局约束「SQL 边界」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { can, grantAssignment, revokeAssignment, listAssignments, scopeClause } from '../src/auth/permissions.js';
import { createUser } from '../src/db/repo/users.js';
import { AppError } from '../src/errors.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations',
);

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-perm-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO capabilities (key, description) VALUES
      ('score:write', '评分写入'),
      ('team:read', '战队读取');
    INSERT INTO roles (key, description) VALUES ('judge', '评委');
  `);
  const user = createUser(db, { name: '评委甲', phone: '13900000001', password: 'pw' });
  return { db, close, dataDir, user };
}

/** 造两张资源行：r_ok 有权、r_no 无权（用来真跑 scopeClause 生成的 SQL） */
function seedResources(db) {
  db.exec('CREATE TABLE fake_resources (id TEXT PRIMARY KEY, title TEXT)');
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('r_ok', '有权'), ('r_no', '无权')");
}

test('超级管理员拥有一切能力', () => {
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('没有授权时能力为 false', () => {
  const { db, close, dataDir, user } = setup();
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('角色能力命中即为 true', () => {
  // ⛔ 预审修正（I6-3）：原用例插完数据就 close()，**一条断言都没有** ——
  //    实现坏掉时它照样 PASS，"跑测试确认通过"证明不了角色能力这条路径。
  const { db, close, dataDir, user } = setup();
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('assignment 精确匹配 scope 时为 true', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id,
    capability: 'score:write',
    scopeType: 'task_package',
    scopeId: 'tp_7',
    grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_7' }, db), true);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_8' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('global scope 匹配任何资源', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_x' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAssignments 按契约签名（对象参数）返回该用户该能力的授权', () => {
  // ⛔ 预审修正（I6-1）：契约是 listAssignments(db, { userId, capability })
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  const rows = listAssignments(db, { userId: user.id, capability: 'score:write' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].scope_type, 'global');
  assert.equal(listAssignments(db, { userId: user.id, capability: 'team:read' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 行级过滤真跑 SQL：有权那行在结果里、无权那行不在', () => {
  // ⛔ 预审修正（C6-2）：原用例只断言 sql.includes('?')（恒真）→ 实现坏掉也 PASS。
  //    现在真执行 SQL：造两张资源行，一张有权一张无权。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), ['r_ok']);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 单资源模式：scopeId 命中才放行', () => {
  // 模式二是**单资源守卫**：它回答「用户对 scopeId 这个资源有没有权限」，
  // 用法是配合 `WHERE t.id = ?` 一起用（P1 的单条读取接口就是这种用法），
  // 它本身不是行过滤器 —— 行过滤用模式一（alias）。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const allowed = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_ok' });
  const denied = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_no' });
  const ok = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + allowed.sql)
    .all('r_ok', ...allowed.params);
  const no = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + denied.sql)
    .all('r_no', ...denied.params);
  assert.deepEqual(ok.map((r) => r.id), ['r_ok']);
  assert.deepEqual(no.map((r) => r.id), []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeId 为**数字**时，can() 与 scopeClause() 必须给出相同结论', () => {
  // ⛔ 终审修正（Important，I-4）：assignments.scope_id 是 TEXT 列，取回是字符串；
  //    而 ctx.scopeId 若来自 parseInt() 就是数字。
  //    原来 can() 用严格相等 `row.scope_id === ctx.scopeId` → '42' ≠ 42 → false；
  //    但 scopeClause 走 SQL 的**类型亲和** → `a.scope_id = 42` 能匹配上 TEXT '42'。
  //    于是同一个用户：can() 说「没权限」、scopeClause 把行放出来 —— **相反结论**。
  //    这直接违反 INTERFACES.md:22「两者必须给出相同结论」。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  // 造一行 id 是**数字形态**的资源（存成 TEXT '42'），用来对照数字 scopeId
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('42', '数字 id 资源')");
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: '42', grantedBy: user.id,
  });

  // 数字形式：can() 必须判有权
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: 42 }, db),
    true,
    '数字 scopeId 时 can() 必须判有权（scope_id 存的是 TEXT "42"）',
  );

  // 字符串形式：结论必须相同（两条路径不能分裂）
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: '42' }, db),
    true,
    '字符串 scopeId 时 can() 必须判有权',
  );

  // 契约要求：can() 与 scopeClause() 的结论一致 —— 数字形式下 scopeClause 放行的行，
  // can() 也必须放行（否则「能看见行但没权限」/「有权却看不见行」）
  for (const scopeId of ['42', 42]) {
    // 模式二（单资源）：scopeId 直接进 SQL 的 WHERE
    const single = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId });
    const singleRows = db
      .prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + single.sql)
      .all('42', ...single.params)
      .map((r) => r.id);
    assert.deepEqual(
      singleRows,
      ['42'],
      `scopeId=${JSON.stringify(scopeId)} 时 scopeClause（单资源模式）应放行该行`,
    );
    assert.equal(
      can(user, 'score:write', { scopeType: 'task_package', scopeId }, db),
      true,
      `scopeId=${JSON.stringify(scopeId)} 时 can() 与 scopeClause 结论必须一致`,
    );

    // 模式一（行级）：scopeId 不进 SQL，改用 alias 比 resource.id
    const rowLevel = scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' });
    const rowRows = db
      .prepare('SELECT t.id FROM fake_resources t WHERE ' + rowLevel.sql)
      .all(...rowLevel.params)
      .map((r) => r.id);
    assert.deepEqual(
      rowRows,
      ['42'],
      `scopeId=${JSON.stringify(scopeId)} 时 scopeClause（行级模式）应放行该行`,
    );
    assert.equal(
      can(user, 'score:write', { scopeType: 'task_package', scopeId }, db),
      true,
      `scopeId=${JSON.stringify(scopeId)} 时 can() 与 scopeClause（行级模式）结论必须一致`,
    );
  }

  // 反例对照：无关的 scopeId 两边都必须拒绝（防止「一律放行」的恒绿断言）
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: 43 }, db),
    false,
    '数字 scopeId 不得放宽匹配：43 与 42 不是同一个资源',
  );

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 的占位符个数恒等于 params 个数', () => {  // ⛔ 预审修正（C6-2）：原实现 SQL 3 个占位符却推 4 个值 → column index out of range。
  const { db, close, dataDir, user } = setup();
  const modes = [
    scopeClause(user.id, 'score:write'),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' }),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }),
  ];
  for (const { sql, params } of modes) {
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(placeholders, params.length);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause：alias 与 scopeId 互斥，同时给直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias: 't', scopeId: 'tp_1' }),
    /互斥/,
  );
});

test('scopeClause：给了 scopeType 却没给 alias / scopeId 直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package' }),
    /alias|scopeId/,
  );
});

test('停用用户判 false；没有 active 字段的精简对象不当成停用', () => {
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 ——
  //    传入 { id, is_superadmin: 1 }（无 active 字段）时，被停用的用户会被判为有权。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0 }, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0, active: 0 }, 'score:write', null, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('超管标志两种形状都认（仓储行 / toPublicUser 的驼峰形状）', () => {
  // ⛔ 跨 Task 接口缝：can() 只认 snake_case 时，调用方传 toPublicUser() 的
  //    驼峰形状会让**超管静默失去全部权限**（症状：管理员登进去什么都点不动）。
  //    can() 是全项目唯一权限入口，必须两种形状都认。
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, isSuperadmin: true, active: true }, 'score:write', null, db), true);
  // 反向：非超管的驼峰形状不能被误判成超管
  assert.equal(
    can({ id: user.id, isSuperadmin: false, active: true }, 'score:write', null, db),
    false,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对超管不做行级过滤（与 can() 一致）', () => {
  // ⛔ 评审修正（Important）：can() 与 scopeClause 曾对超管给出**相反结论** ——
  //    can() = true（超管什么都能干），scopeClause 却过滤出 0 行。
  //    这直接违反 INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...)」：
  //    一个说"有权限"，另一个说"看不到任何行"。
  //    P0 没有调用方，但 P2 计划明写「行级 scope 由 P3/P4 的 scopeClause 补齐」——
  //    P3/P4 的列表接口一接，超管就会看到空列表。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), true);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['r_no', 'r_ok'], '超管应看到全部行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对角色授权用户不做行级过滤（与 can() 一致）', () => {
  // ⛔ 评审修正（Important）：同上，但走的是 role_capabilities 这条路。
  //    设计文档 §7.1 的判定顺序是「超管 → true；role_capability 命中 → true」，
  //    两者都是**无作用域**授权 → 行级过滤对它们一律不设限。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), true);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['r_no', 'r_ok'], '角色授权用户应看到全部行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对**停用**用户不放开行级过滤', () => {
  // 与 can() 保持一致：停用用户 can() = false，行级过滤也不能给他行。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare('UPDATE users SET is_superadmin = 1, active = 0 WHERE id = ?').run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), false);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), [], '停用用户不应看到任何行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('alias 必须是合法 SQL 标识符（SQL 注入防护）', () => {
  // ⚠️ 评审修正（Important）：这道护栏此前**零测试覆盖** ——
  //    把白名单整行删掉，13 条用例照样全绿（评审实测）。
  //    alias 会被拼进 SQL 字符串，注入面必须钉住。
  const payloads = [
    't; DROP TABLE users',
    't x',
    't/*c*/',
    '"t"',
    '`t`',
    't)',
    't,',
    '1t',
    't-1',
  ];
  for (const alias of payloads) {
    assert.throws(
      () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias }),
      /alias/,
      `alias=${JSON.stringify(alias)} 必须被拒绝`,
    );
  }
  for (const alias of ['t', 'tp', '_x', 'T1', 'task_package']) {
    assert.doesNotThrow(
      () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias }),
      `alias=${alias} 是合法标识符，不该被拒`,
    );
  }
});

test('grantAssignment 对未注册能力点/不存在用户抛领域错误，不漏原始 SQLite 错误', () => {
  // ⚠️ 评审修正（Important）：原来直接 INSERT → SQLite 原始外键错误
  //    「FOREIGN KEY constraint failed」冒到 HTTP 层（只能回 500，且泄露表结构）。
  //    这与 I5-3（users.phone 重复）是同一类问题 —— 当时修了，这儿漏了。
  const { db, close, dataDir, user } = setup();
  assert.throws(
    () => grantAssignment(db, {
      userId: user.id, capability: 'no:such:cap', scopeType: 'global', scopeId: null,
    }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 400);
      assert.equal(err.code, 'CAPABILITY_UNKNOWN');
      assert.ok(!/FOREIGN KEY/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  assert.throws(
    () => grantAssignment(db, {
      userId: 'no_such_user', capability: 'score:write', scopeType: 'global', scopeId: null,
    }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 404);
      assert.equal(err.code, 'USER_NOT_FOUND');
      assert.ok(!/FOREIGN KEY/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('revokeAssignment 撤销后该条授权失效', () => {
  // ⚠️ 评审修正（Minor）：revokeAssignment 是 INTERFACES.md 契约里的 API，
  //    但此前**零测试覆盖**（变异「撤销空转」全绿）。
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(revokeAssignment(db, id), 1);
  assert.equal(can(user, 'score:write', null, db), false);
  assert.equal(listAssignments(db, { userId: user.id, capability: 'score:write' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('can() 对缺 id 的用户 fail-closed 返回 false，而不是抛错', () => {
  // ⚠️ 评审修正：原来直接拿 undefined 去绑定 SQLite 参数 → TypeError → 整个请求 500。
  //    权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉"。
  const { db, close, dataDir } = setup();
  assert.equal(can({}, 'score:write', {}, db), false);
  assert.equal(can({ id: undefined }, 'score:write', {}, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('停用用户（布尔形状）判 false', () => {
  // ⚠️ 评审修正：active 的**布尔形状**（正是 toPublicUser 产出的形状）此前没被钉住 ——
  //    把判断改回 `user.active === 0` 时，`false === 0` 为 false → 停用用户被放行。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can({ id: user.id, active: false, isSuperadmin: false }, 'score:write', null, db), false);
  assert.equal(can({ id: user.id, active: true, isSuperadmin: false }, 'score:write', null, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/permissions.test.js`
Expected: FAIL —— `Cannot find module '../src/auth/permissions.js'`

- [ ] **Step 3: 创建 src/auth/permissions.js**

```javascript
// src/auth/permissions.js — 权限判定
// 依据：设计文档 §7.1 / §7.2。
//   权限不靠角色枚举，靠「能力 + 授权记录」。
//   can() 是唯一判定入口；scopeClause() 把行级过滤下推到 SQL。
// ⛔ 本文件**不含裸 SQL**：assignments 的 SQL 收在 src/db/repo/assignments.js
//    （预审修正 I6-2 —— Files 段落声明了这个文件，却没有任何一步创建它；
//     全局约束「SQL 边界」：所有 SQL 收进 src/db/repo/）。
//    唯一例外是 scopeClause() —— 它按契约**生成** WHERE 片段给调用方拼进 SQL，
//    自己不执行任何查询。
import { randomUUID } from 'node:crypto';
import {
  insertAssignment,
  deleteAssignmentById,
  listAssignmentsByUserAndCapability,
  hasRoleCapability,
  capabilityExists,
} from '../db/repo/assignments.js';
import { userExists } from '../db/repo/users.js';
import { appError } from '../errors.js';

export function grantAssignment(
  db,
  { userId, capability, scopeType, scopeId = null, grantedBy = null },
) {
  // ⛔ 评审修正（Important）：授权前先校验入参。
  //    原来直接 INSERT，让 SQLite 的原始外键错误「FOREIGN KEY constraint failed」
  //    抛到 HTTP 层 —— 既只能回 500（没有 .status），又把表结构暴露给客户端。
  //    这与 I5-3（users.phone 重复）是同一类问题，当时修了，这儿漏了。
  if (!capabilityExists(db, capability)) {
    throw appError(400, 'CAPABILITY_UNKNOWN', `能力点未注册：${capability}`);
  }
  if (!userExists(db, userId)) {
    throw appError(404, 'USER_NOT_FOUND', `用户不存在：${userId}`);
  }
  const id = randomUUID();
  insertAssignment(db, {
    id,
    userId,
    capability,
    scopeType,
    scopeId,
    grantedBy,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export function revokeAssignment(db, assignmentId) {
  return deleteAssignmentById(db, assignmentId);
}

// 契约（INTERFACES.md:76）：listAssignments(db, { userId, capability })
// ⛔ 预审修正（I6-1）：原来写成 (db, userId, capability) —— P1–P6 按契约调用
//    会把对象当 userId 绑定（node:sqlite 抛错/查不到）。统一为契约形式。
export function listAssignments(db, { userId, capability }) {
  return listAssignmentsByUserAndCapability(db, userId, capability);
}

function roleGrants(db, userId, capability) {
  // SQL 在 src/db/repo/assignments.js（hasRoleCapability）
  return hasRoleCapability(db, userId, capability);
}

/**
 * 比较 scope_id：统一按**字符串**比较。
 *
 * ⛔ 终审修正（Important，I-4）：assignments.scope_id 是 TEXT 列，取回是字符串；
 *    而 ctx.scopeId 若来自 parseInt() / 数字字面量就是 number。
 *    原来用严格相等 `row.scope_id === ctx.scopeId` → 字符串 '42' ≠ 数字 42 → false；
 *    但 scopeClause 走 SQL 的**类型亲和** → `a.scope_id = 42` 能匹配上 TEXT '42'。
 *    于是同一个用户：can() 说「没权限」、scopeClause 把行放出来 —— **相反结论**。
 *    这直接违反 INTERFACES.md:22「两者必须给出相同结论」。
 *    （P0 枚举的一致性场景没覆盖数字 id，所以 P0-4 当时判「达标」——
 *      但契约说的是**一般情形**。）
 */
function scopeIdEquals(stored, given) {
  if (stored === null || stored === undefined) return false;
  if (given === null || given === undefined) return false;
  return String(stored) === String(given);
}

export function can(user, capability, ctx = null, db = null) {
  if (!user) return false;
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 —— 传入没有 active 字段的
  //    精简对象 { id, is_superadmin: 1 } 时，被停用的用户会被判为有权。
  //    只有**明确带 active 且为假**才拒绝。
  if (user.active !== undefined && !user.active) return false;
  // ⚠️ 超管标志**同时认两种形状**：仓储层行是 `is_superadmin: 0|1`（snake_case），
  //    toPublicUser() 的对外形状是 `isSuperadmin: boolean`（camelCase）。
  //    can() 是全项目**唯一**权限入口（P1–P6 全部依赖）。若只认一种形状，
  //    调用方传错形状会让**超管静默失去全部权限** —— 症状是"管理员登进去
  //    什么都点不动"，极难定位。多认一种形状，把这类静默降级从根上消除。
  //    （失败方向是 fail-closed：认不出超管只会少给权限，不会多给。）
  if (user.is_superadmin === 1 || user.isSuperadmin === true) return true;
  if (!db) return false;
  // ⛔ 评审修正（Minor→Important）：缺 user.id 时**不能**拿去绑定 SQLite 参数 ——
  //    node:sqlite 抛 TypeError → 整个请求变 500。
  //    权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉"。
  if (!user.id) return false;

  // 角色能力
  if (roleGrants(db, user.id, capability)) return true;

  // 资源级授权
  const rows = listAssignments(db, { userId: user.id, capability });
  for (const row of rows) {
    if (row.scope_type === 'global') return true;
    if (!ctx) continue;
    if (row.scope_type === ctx.scopeType && scopeIdEquals(row.scope_id, ctx.scopeId)) return true;
  }
  return false;
}

/**
 * 生成行级过滤的 SQL 片段。
 * ⛔ 关键：权限过滤必须在 SQL 的 WHERE 里，不能"先查全量再在 JS 里 filter"，
 *    否则单条读取接口会绕过列表过滤导致越权（设计文档 §7.2 约束 2）。
 *
 * 语义（2026-10-20 预审修正 C6-2 定稿）：
 *   scopeClause 只做**行级过滤** —— 把用户的授权映射到资源表的每一行。
 *   「用户对某一个具体资源有没有权限」是 can() 的职责（走 ctx），不是 scopeClause 的。
 *
 *   模式一（行级，推荐）：传 scopeType + alias
 *     SQL  : ... AND (a.scope_type = 'global' OR (a.scope_type = ? AND a.scope_id = <alias>.id))
 *     params: [userId, capability, scopeType]
 *   模式二（单资源）：传 scopeType + scopeId（不传 alias）
 *     SQL  : ... AND (a.scope_type = 'global' OR (a.scope_type = ? AND a.scope_id = ?))
 *     params: [userId, capability, scopeType, scopeId]
 *     ⚠️ 模式二是**单资源守卫**（回答「用户对 scopeId 这个资源有没有权限」），
 *        用法是配合 `WHERE t.id = ?` 一起用；它本身不是行过滤器 —— 行过滤用模式一。
 *   都不传：只认 global 授权
 *     params: [userId, capability]
 *
 * ⚠️ alias 与 scopeId **互斥**：同时给 → 抛错（fail-fast，不静默挑一个）。
 * ⚠️ 给了 scopeType 但 alias 与 scopeId 都没给 → 抛错（fail-fast）。
 * ⚠️ **params 的个数必须永远等于 SQL 里的占位符个数** —— 2026-10-20 预审实测：
 *    原实现 SQL 3 个占位符却推了 4 个值 → `column index out of range`。
 * ⚠️ 上级作用域**不隐式下推**：edition 授权不自动覆盖其下的 task_package
 *    （要覆盖必须显式再授权一条 task_package 的记录）。
 *
 * ⚠️ 这三个校验抛的是**普通 Error**，不是 AppError —— 终审 Minor M-8 澄清：
 *    它们表达的是**程序员错误**（调用方把参数组合写错了），
 *    而 AppError 表达的是**客户端输入错误**（「客户端提交的东西不合法」这一类要回给用户的领域失败）。
 *    grantAssignment() 同样校验入参却用 AppError，因为它校验的是
 *    **客户端传来的** capability / userId（客户端能触发）；
 *    这里校验的是**调用方在代码里写死的组合**（客户端触发不了）。
 *    两种错误风格是**有意不同**的，不是漏改。
 */
export function scopeClause(userId, capability, { scopeType, scopeId, alias = null } = {}) {
  const hasScopeId = scopeId !== undefined && scopeId !== null;
  if (alias && hasScopeId) {
    throw new Error('scopeClause：alias 与 scopeId 互斥，只能给一个');
  }
  if (scopeType && !alias && !hasScopeId) {
    throw new Error('scopeClause：给了 scopeType 就必须给 alias（行级）或 scopeId（单资源）');
  }
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    // alias 是 SQL 标识符（会被拼进 SQL），必须限制成安全的标识符字符
    throw new Error(`scopeClause：alias 必须是合法 SQL 标识符：${alias}`);
  }

  const scopeCond = [];
  const scopeParams = [];

  if (scopeType) {
    if (alias) {
      scopeCond.push(`(a.scope_type = ? AND a.scope_id = ${alias}.id)`);
      scopeParams.push(scopeType);
    } else {
      scopeCond.push(`(a.scope_type = ? AND a.scope_id = ?)`);
      // ⛔ 终审修正（Important，I-4）：scopeId 统一按**字符串**绑定。
      //    assignments.scope_id 声明为 TEXT。实测（node:sqlite）：
      //    `WHERE scope_id = ?` 绑**整数** 42 匹配不上 TEXT '42'；
      //    绑**字符串** '42' 或写 SQL 字面量 42 才能匹配上。
      //    原因：绑定参数**没有类型亲和**，SQLite 不会把列的 TEXT 亲和
      //    应用到它身上（列↔列比较则会应用）。
      //    不归一的后果：scopeId 来自 parseInt() 时，
      //    scopeClause 说「这行不可见」、can() 说「有权」—— 契约要求的
      //    「两者必须给出相同结论」被打破（INTERFACES.md:22）。
      scopeParams.push(scopeType, String(scopeId));
    }
  }
  const scopeSql = scopeCond.length ? ` OR ${scopeCond.join(' OR ')}` : '';

  // ⛔ 评审修正（Important）：**超管与角色授权不做行级过滤**。
  //    原来这段 SQL 只认 assignments，于是：
  //      超管        → can() = true，但 scopeClause 过滤出 0 行
  //      角色授权用户 → can() = true，但 scopeClause 过滤出 0 行
  //    can() 与 scopeClause 对同一用户给出**相反结论** —— 这直接违反
  //    INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...)」：
  //    一个说"有权限"，另一个说"看不到任何行"。
  //    P0 没有调用方，但 P2 计划明写「行级 scope 由 P3/P4 的 scopeClause 补齐」——
  //    P3/P4 的列表接口一接，超管和角色授权用户就会看到空列表。
  //    设计文档 §7.1 的判定顺序是：超管 → true；role_capability 命中 → true。
  //    两者都是**无作用域**的授权，因此行级过滤对它们一律不设限。
  //
  // ⚠️ 占位符顺序必须与 params 顺序**逐字对应**：
  //    ①users.id(启用) ②assignments.user_id ③assignments.capability
  //    ④scopeType[⑤scopeId] ⑥超管.user_id ⑦角色.user_id ⑧角色.capability
  const sql = `(
    EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.active = 1)
    AND (
      EXISTS (SELECT 1 FROM assignments a
               WHERE a.user_id = ? AND a.capability = ?
                 AND (a.scope_type = 'global'${scopeSql}))
      OR EXISTS (SELECT 1 FROM users su WHERE su.id = ? AND su.is_superadmin = 1)
      OR EXISTS (SELECT 1 FROM user_roles ur
                  JOIN role_capabilities rc ON rc.role_id = ur.role_key
                  WHERE ur.user_id = ? AND rc.capability = ?)
    )
  )`;

  return {
    sql,
    params: [userId, userId, capability, ...scopeParams, userId, userId, capability],
  };
}
```

- [ ] **Step 4: 创建 src/db/repo/assignments.js**

> ⛔ 预审修正（I6-2）：这个文件原本**只出现在 Files 段落与目录树里，没有任何一步创建它**，
> 而 assignments 的 SQL 全写在 `src/auth/permissions.js` → 既违反「SQL 收进 src/db/repo/」，
> 又留下一份永久缺失的承诺文件。这里补上。

`platform/src/db/repo/assignments.js`：

```javascript
// src/db/repo/assignments.js — 授权仓储
// 依据：设计文档 §7.2 + 全局约束「所有 SQL 收进 src/db/repo/」。
//
// ⛔ 预审修正（I6-2）：这个文件原本**只出现在 Files 段落与目录树里，没有任何一步创建它**，
//    而 assignments 的 SQL 全写在 src/auth/permissions.js → 既违反「SQL 收进 src/db/repo/」，
//    又留下一份永久缺失的承诺文件。这里补上。
//
// ⛔ 全局约束「SQL 边界」：src/auth/permissions.js 里**不许出现 SQL 字符串** ——
//    角色能力查询（hasRoleCapability）的 SQL 同样收在这里，而不是留在判定入口里。
export function insertAssignment(
  db,
  { id, userId, capability, scopeType, scopeId = null, grantedBy = null, createdAt },
) {
  db.prepare(
    `INSERT INTO assignments (id, user_id, capability, scope_type, scope_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, capability, scopeType, scopeId, grantedBy, createdAt);
}

export function deleteAssignmentById(db, id) {
  return db.prepare('DELETE FROM assignments WHERE id = ?').run(id).changes;
}

export function listAssignmentsByUserAndCapability(db, userId, capability) {
  return db
    .prepare(
      `SELECT id, user_id, capability, scope_type, scope_id, granted_by, created_at
         FROM assignments WHERE user_id = ? AND capability = ?`,
    )
    .all(userId, capability);
}

/**
 * 用户是否通过**角色**获得该能力（角色能力表 → 用户角色表）。
 *
 * ⛔ 预审修正（C6-1）：JOIN 条件必须是 `rc.role_id = ur.role_key`。
 *    001_init.sql:37-41 里 role_capabilities 的列名是 **role_id**（不是 role_key），
 *    写错会得到 `no such column: rc.role_key` → can() 对任何非超管一律抛错
 *    → P1–P6 的权限判定全变 HTTP 500。
 *    （role_capabilities.role_id、user_roles.role_key、roles.key 指的都是同一个角色键。）
 */
export function hasRoleCapability(db, userId, capability) {
  return db
    .prepare(
      `SELECT 1 FROM user_roles ur
       JOIN role_capabilities rc ON rc.role_id = ur.role_key
       WHERE ur.user_id = ? AND rc.capability = ?
       LIMIT 1`,
    )
    .get(userId, capability) !== undefined;
}

/**
 * 能力点是否已注册。
 * ⛔ 评审修正（Important）：授权前校验用 —— 不校验就是让 SQLite 的原始外键错误
 *    「FOREIGN KEY constraint failed」冒到 HTTP 层（只能回 500，且泄露表结构）。
 */
export function capabilityExists(db, capability) {
  return db.prepare('SELECT 1 FROM capabilities WHERE key = ?').get(capability) !== undefined;
}
```

- [ ] **Step 5: 确认 user_roles 表已在 001_init.sql 中**

`user_roles` 表**已在 Task 2 的 `001_init.sql` 里建好**（迁移版本号是全局唯一序位，002 留给 P1 的 `002_registration.sql`）。
本步只需确认它存在：

```bash
cd platform && node scripts/migrate.js && node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('./data/app.db');
const r=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='user_roles'\").get();
console.log(r ? 'user_roles 存在' : '缺失');
db.close();
"
```
Expected: `user_roles 存在`

- [ ] **Step 6: 核对列名与 001_init.sql 一致**

⛔ 预审修正（I6-3）：原 Step 5 是「修正测试里的角色用例」—— 但带断言的版本现在**直接写在 Step 1**
（`test/permissions.test.js` 的「角色能力命中即为 true」），本步不再改测试代码。
本步改成**核对列名**（C6-1 的根因就是列名笔误，必须当场对着 DDL 核一遍）：

```bash
// platform/test/permissions.test.js —— capability + assignment 权限模型
//
// 规则溯源（本文件每条断言对应的来源文档与章节）：
//   - 「权限不靠角色枚举，靠『能力 + 授权记录』」→ 设计文档 §7.1 / §7.2
//   - 「can() 是唯一判定入口」→ 设计文档 §7.1；跨阶段契约见 INTERFACES.md:76
//   - 「权限过滤必须在 SQL 的 WHERE 里，不能先查全量再在 JS 里 filter」
//     → 设计文档 §7.2 约束 2
//   - 「上级作用域不隐式下推（edition 授权不自动覆盖其下的 task_package）」
//     → 设计文档 §7.2 作用域约定
//   - 「所有 SQL 收进 src/db/repo/」→ 全局约束「SQL 边界」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { can, grantAssignment, revokeAssignment, listAssignments, scopeClause } from '../src/auth/permissions.js';
import { createUser } from '../src/db/repo/users.js';
import { AppError } from '../src/errors.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations',
);

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-perm-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO capabilities (key, description) VALUES
      ('score:write', '评分写入'),
      ('team:read', '战队读取');
    INSERT INTO roles (key, description) VALUES ('judge', '评委');
  `);
  const user = createUser(db, { name: '评委甲', phone: '13900000001', password: 'pw' });
  return { db, close, dataDir, user };
}

/** 造两张资源行：r_ok 有权、r_no 无权（用来真跑 scopeClause 生成的 SQL） */
function seedResources(db) {
  db.exec('CREATE TABLE fake_resources (id TEXT PRIMARY KEY, title TEXT)');
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('r_ok', '有权'), ('r_no', '无权')");
}

test('超级管理员拥有一切能力', () => {
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('没有授权时能力为 false', () => {
  const { db, close, dataDir, user } = setup();
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('角色能力命中即为 true', () => {
  // ⛔ 预审修正（I6-3）：原用例插完数据就 close()，**一条断言都没有** ——
  //    实现坏掉时它照样 PASS，"跑测试确认通过"证明不了角色能力这条路径。
  const { db, close, dataDir, user } = setup();
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('assignment 精确匹配 scope 时为 true', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id,
    capability: 'score:write',
    scopeType: 'task_package',
    scopeId: 'tp_7',
    grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_7' }, db), true);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_8' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('global scope 匹配任何资源', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_x' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAssignments 按契约签名（对象参数）返回该用户该能力的授权', () => {
  // ⛔ 预审修正（I6-1）：契约是 listAssignments(db, { userId, capability })
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  const rows = listAssignments(db, { userId: user.id, capability: 'score:write' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].scope_type, 'global');
  assert.equal(listAssignments(db, { userId: user.id, capability: 'team:read' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 行级过滤真跑 SQL：有权那行在结果里、无权那行不在', () => {
  // ⛔ 预审修正（C6-2）：原用例只断言 sql.includes('?')（恒真）→ 实现坏掉也 PASS。
  //    现在真执行 SQL：造两张资源行，一张有权一张无权。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), ['r_ok']);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 单资源模式：scopeId 命中才放行', () => {
  // 模式二是**单资源守卫**：它回答「用户对 scopeId 这个资源有没有权限」，
  // 用法是配合 `WHERE t.id = ?` 一起用（P1 的单条读取接口就是这种用法），
  // 它本身不是行过滤器 —— 行过滤用模式一（alias）。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const allowed = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_ok' });
  const denied = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_no' });
  const ok = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + allowed.sql)
    .all('r_ok', ...allowed.params);
  const no = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + denied.sql)
    .all('r_no', ...denied.params);
  assert.deepEqual(ok.map((r) => r.id), ['r_ok']);
  assert.deepEqual(no.map((r) => r.id), []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeId 为**数字**时，can() 与 scopeClause() 必须给出相同结论', () => {
  // ⛔ 终审修正（Important，I-4）：assignments.scope_id 是 TEXT 列，取回是字符串；
  //    而 ctx.scopeId 若来自 parseInt() 就是数字。
  //    原来 can() 用严格相等 `row.scope_id === ctx.scopeId` → '42' ≠ 42 → false；
  //    但 scopeClause 走 SQL 的**类型亲和** → `a.scope_id = 42` 能匹配上 TEXT '42'。
  //    于是同一个用户：can() 说「没权限」、scopeClause 把行放出来 —— **相反结论**。
  //    这直接违反 INTERFACES.md:22「两者必须给出相同结论」。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  // 造一行 id 是**数字形态**的资源（存成 TEXT '42'），用来对照数字 scopeId
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('42', '数字 id 资源')");
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: '42', grantedBy: user.id,
  });

  // 数字形式：can() 必须判有权
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: 42 }, db),
    true,
    '数字 scopeId 时 can() 必须判有权（scope_id 存的是 TEXT "42"）',
  );

  // 字符串形式：结论必须相同（两条路径不能分裂）
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: '42' }, db),
    true,
    '字符串 scopeId 时 can() 必须判有权',
  );

  // 契约要求：can() 与 scopeClause() 的结论一致 —— 数字形式下 scopeClause 放行的行，
  // can() 也必须放行（否则「能看见行但没权限」/「有权却看不见行」）
  for (const scopeId of ['42', 42]) {
    // 模式二（单资源）：scopeId 直接进 SQL 的 WHERE
    const single = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId });
    const singleRows = db
      .prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + single.sql)
      .all('42', ...single.params)
      .map((r) => r.id);
    assert.deepEqual(
      singleRows,
      ['42'],
      `scopeId=${JSON.stringify(scopeId)} 时 scopeClause（单资源模式）应放行该行`,
    );
    assert.equal(
      can(user, 'score:write', { scopeType: 'task_package', scopeId }, db),
      true,
      `scopeId=${JSON.stringify(scopeId)} 时 can() 与 scopeClause 结论必须一致`,
    );

    // 模式一（行级）：scopeId 不进 SQL，改用 alias 比 resource.id
    const rowLevel = scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' });
    const rowRows = db
      .prepare('SELECT t.id FROM fake_resources t WHERE ' + rowLevel.sql)
      .all(...rowLevel.params)
      .map((r) => r.id);
    assert.deepEqual(
      rowRows,
      ['42'],
      `scopeId=${JSON.stringify(scopeId)} 时 scopeClause（行级模式）应放行该行`,
    );
    assert.equal(
      can(user, 'score:write', { scopeType: 'task_package', scopeId }, db),
      true,
      `scopeId=${JSON.stringify(scopeId)} 时 can() 与 scopeClause（行级模式）结论必须一致`,
    );
  }

  // 反例对照：无关的 scopeId 两边都必须拒绝（防止「一律放行」的恒绿断言）
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: 43 }, db),
    false,
    '数字 scopeId 不得放宽匹配：43 与 42 不是同一个资源',
  );

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 的占位符个数恒等于 params 个数', () => {  // ⛔ 预审修正（C6-2）：原实现 SQL 3 个占位符却推 4 个值 → column index out of range。
  const { db, close, dataDir, user } = setup();
  const modes = [
    scopeClause(user.id, 'score:write'),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' }),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }),
  ];
  for (const { sql, params } of modes) {
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(placeholders, params.length);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause：alias 与 scopeId 互斥，同时给直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias: 't', scopeId: 'tp_1' }),
    /互斥/,
  );
});

test('scopeClause：给了 scopeType 却没给 alias / scopeId 直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package' }),
    /alias|scopeId/,
  );
});

test('停用用户判 false；没有 active 字段的精简对象不当成停用', () => {
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 ——
  //    传入 { id, is_superadmin: 1 }（无 active 字段）时，被停用的用户会被判为有权。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0 }, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0, active: 0 }, 'score:write', null, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('超管标志两种形状都认（仓储行 / toPublicUser 的驼峰形状）', () => {
  // ⛔ 跨 Task 接口缝：can() 只认 snake_case 时，调用方传 toPublicUser() 的
  //    驼峰形状会让**超管静默失去全部权限**（症状：管理员登进去什么都点不动）。
  //    can() 是全项目唯一权限入口，必须两种形状都认。
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, isSuperadmin: true, active: true }, 'score:write', null, db), true);
  // 反向：非超管的驼峰形状不能被误判成超管
  assert.equal(
    can({ id: user.id, isSuperadmin: false, active: true }, 'score:write', null, db),
    false,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对超管不做行级过滤（与 can() 一致）', () => {
  // ⛔ 评审修正（Important）：can() 与 scopeClause 曾对超管给出**相反结论** ——
  //    can() = true（超管什么都能干），scopeClause 却过滤出 0 行。
  //    这直接违反 INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...)」：
  //    一个说"有权限"，另一个说"看不到任何行"。
  //    P0 没有调用方，但 P2 计划明写「行级 scope 由 P3/P4 的 scopeClause 补齐」——
  //    P3/P4 的列表接口一接，超管就会看到空列表。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), true);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['r_no', 'r_ok'], '超管应看到全部行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对角色授权用户不做行级过滤（与 can() 一致）', () => {
  // ⛔ 评审修正（Important）：同上，但走的是 role_capabilities 这条路。
  //    设计文档 §7.1 的判定顺序是「超管 → true；role_capability 命中 → true」，
  //    两者都是**无作用域**授权 → 行级过滤对它们一律不设限。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), true);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['r_no', 'r_ok'], '角色授权用户应看到全部行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对**停用**用户不放开行级过滤', () => {
  // 与 can() 保持一致：停用用户 can() = false，行级过滤也不能给他行。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare('UPDATE users SET is_superadmin = 1, active = 0 WHERE id = ?').run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), false);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), [], '停用用户不应看到任何行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('alias 必须是合法 SQL 标识符（SQL 注入防护）', () => {
  // ⚠️ 评审修正（Important）：这道护栏此前**零测试覆盖** ——
  //    把白名单整行删掉，13 条用例照样全绿（评审实测）。
  //    alias 会被拼进 SQL 字符串，注入面必须钉住。
  const payloads = [
    't; DROP TABLE users',
    't x',
    't/*c*/',
    '"t"',
    '`t`',
    't)',
    't,',
    '1t',
    't-1',
  ];
  for (const alias of payloads) {
    assert.throws(
      () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias }),
      /alias/,
      `alias=${JSON.stringify(alias)} 必须被拒绝`,
    );
  }
  for (const alias of ['t', 'tp', '_x', 'T1', 'task_package']) {
    assert.doesNotThrow(
      () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias }),
      `alias=${alias} 是合法标识符，不该被拒`,
    );
  }
});

test('grantAssignment 对未注册能力点/不存在用户抛领域错误，不漏原始 SQLite 错误', () => {
  // ⚠️ 评审修正（Important）：原来直接 INSERT → SQLite 原始外键错误
  //    「FOREIGN KEY constraint failed」冒到 HTTP 层（只能回 500，且泄露表结构）。
  //    这与 I5-3（users.phone 重复）是同一类问题 —— 当时修了，这儿漏了。
  const { db, close, dataDir, user } = setup();
  assert.throws(
    () => grantAssignment(db, {
      userId: user.id, capability: 'no:such:cap', scopeType: 'global', scopeId: null,
    }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 400);
      assert.equal(err.code, 'CAPABILITY_UNKNOWN');
      assert.ok(!/FOREIGN KEY/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  assert.throws(
    () => grantAssignment(db, {
      userId: 'no_such_user', capability: 'score:write', scopeType: 'global', scopeId: null,
    }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 404);
      assert.equal(err.code, 'USER_NOT_FOUND');
      assert.ok(!/FOREIGN KEY/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('revokeAssignment 撤销后该条授权失效', () => {
  // ⚠️ 评审修正（Minor）：revokeAssignment 是 INTERFACES.md 契约里的 API，
  //    但此前**零测试覆盖**（变异「撤销空转」全绿）。
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(revokeAssignment(db, id), 1);
  assert.equal(can(user, 'score:write', null, db), false);
  assert.equal(listAssignments(db, { userId: user.id, capability: 'score:write' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('can() 对缺 id 的用户 fail-closed 返回 false，而不是抛错', () => {
  // ⚠️ 评审修正：原来直接拿 undefined 去绑定 SQLite 参数 → TypeError → 整个请求 500。
  //    权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉"。
  const { db, close, dataDir } = setup();
  assert.equal(can({}, 'score:write', {}, db), false);
  assert.equal(can({ id: undefined }, 'score:write', {}, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('停用用户（布尔形状）判 false', () => {
  // ⚠️ 评审修正：active 的**布尔形状**（正是 toPublicUser 产出的形状）此前没被钉住 ——
  //    把判断改回 `user.active === 0` 时，`false === 0` 为 false → 停用用户被放行。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can({ id: user.id, active: false, isSuperadmin: false }, 'score:write', null, db), false);
  assert.equal(can({ id: user.id, active: true, isSuperadmin: false }, 'score:write', null, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```
Expected: `role_capabilities role_id,capability` ｜ `user_roles user_id,role_key`

> `permissions.js` 里角色能力查询的 JOIN 条件必须是 `rc.role_id = ur.role_key`
> （`role_capabilities.role_id` 与 `roles.key`、`user_roles.role_key` 与 `roles.key` 指的是同一个角色键）。
> 写成 `rc.role_key` 会得到 `no such column: rc.role_key` → `can()` 对非超管一律抛错。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/permissions.test.js`
Expected: PASS（22 个测试全过：permissions 22）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/auth/permissions.js src/db/repo/assignments.js test/permissions.test.js
git commit -m "feat(P0): capability + assignment 权限模型与 SQL 层行级过滤"
```

---

### Task 7: 静态文件服务、前端骨架与服务器入口

> **【2026-10-21 终审复核结论 + F-1 ~ F-6 处置】** 修复轮 3 的**终审复核**（verifier，
> 27 个独立变异）判定 **Needs fixes**：**0 Critical / 1 Important / 3 Minor**。
> 评审原话：「**实现本身正确，无安全漏洞、无功能缺陷**」，且 11 项修复中 8 项被完全钉住。
> 剩余问题的性质是「**断言没钉住 / 断言被注释劫持 / 边界差一格 / 文档归属写错**」，逐条处置如下：
>
> | # | 严重度 | 发现 | 处置 |
> |---|---|---|---|
> | **F-1** | **Important** | **I-C 修复只钉住了「裸 Error 的 message 一律回落」，没钉住「AppError 的 message 必须原样透传」这一半** —— 把 `const message = err instanceof AppError ? err.message : '请求无效';` 改成 `const message = '请求无效';` → 全量 150 条照样全绿。实测响应里的 message 从「手机号或密码不正确」退化成「请求无效」，而 `web/api.js:15` 正把它当界面文案直接显示 → **所有错误提示变成同一句废话** | 新增用例断言 401 登录失败的 `error.message` **逐字等于**「手机号或密码不正确」且 **不等于**「请求无效」 |
> | **F-2** | Minor | I-B 的断言边界**差一格**：用例用 `512KB - 1` 字节，于是把实现的 `size > limit` 改成 `size >= limit` 仍全绿（`524288B` 恰好等于上限时会被错误拒绝）。**当前实现正确，是断言弱一格** | 用例改为**正好取 512KB**（等于上限必须放行），并把断言文案改成「正好 512KB（等于上限）必须放行」 |
> | **F-3** | Minor | M-1 的接线断言**可被注释劫持**：代码改成 `isSameFile(stat, stat)` + 注释里写上正确形态 → 守卫永不触发却仍判绿。根因：该正则匹配的是**未剥注释**的源码 | ① 把「剥注释」抽成**共享工具** `platform/test-helpers/strip-comments.js`（此前 `zero-deps.test.js` 与 `sql-boundary.test.js` **各抄了一份逐字相同的实现**，改一处要改两处 → 必然漂移）；② 接线断言改为**先剥注释与正则字面量再匹配** |
> | **F-4** | Minor | 两条软链用例**没有 Windows skip**，与同文件其他用例的 skip 口径不一致 | 两条软链用例都补 `{ skip: process.platform === 'win32' ? … : false }`（Windows 创建符号链接需要开发者模式或管理员权限） |
> | **F-5** | Minor | 零依赖扫描器**保留正则字面量** → 正则里的 `from 'x'` 被误报成第三方依赖 | `stripComments(code, { blankRegex: true })` —— 正则字面量也剥成空白（默认**不开**：SQL 边界扫描器需要字符串字面量原样保留） |
> | **F-6** | Minor | `INTERFACES.md` 把 `serveStatic` 列在 `// src/server.js` 段下，**它实际住在 `src/http/static.js`**（main 既有问题，非本轮引入）。P1–P6 若按旧表述去 `src/server.js` 找它会找不到 | 订正归属，并补上 `isSameFile` / `pipeFd` 两个同模块导出 |
>
> ⚠️ **共享 helper 为什么放在 `test-helpers/` 而不是 `test/helpers/`**：
> Node 的测试运行器会把**任何名为 `test` 的目录**下的所有 `.js` / `.cjs` / `.mjs` 文件
> **都当成测试文件**（Node 文档：目录名为 `test` 时递归搜全部 JS）→ 放在 `test/helpers/` 下
> 会被算成一条「测试」，用例总数凭空 +1。
> `test-helpers/` 不匹配任何发现规则（发现规则只看**文件名**：`^test$` / `^test-.+` / `^.+[.\-_]test$`，
> 而 `strip-comments.js` 都不匹配）→ 不会被误认成测试文件。
>
> **验收**：用例 150 → **151**；本轮 4 个针对性变异全杀（F-1 / F-2 / F-3 / F-5）。

> **【2026-10-21 终审复核 + 8 条 Minor 收尾】** 修复轮 3 的终审复核（verifier）判定 **Needs fixes**：
> **0 Critical / 3 Important / 8 Minor**。3 条 Important 全部是**「断言缺失」型** ——
> 也就是说实现本身是对的，但**没有任何测试钉住它**，把实现改坏全量照样全绿：
> **①（I-A）零依赖守卫没有自保护**：`scanImports()` 的判定内联在扫描循环里，
>    改成「无条件 `continue`（一条都不判违规）」→ 全量 140 条照样全绿。
>    修法：抽出纯函数 `classifySpecifier()` / `scanSource()`（导出，可直接测），
>    并对**合成的坏源码**断言 6 种第三方写法必须判违规、5 种合法写法不得误判。
> **②（I-B）请求体默认上限零断言**：现有用例都传显式 `{ limit: 10 }`，
>    把默认值改成 100MB → 全量照样全绿。而默认值才是**生产实际生效**的那个
>    （HTTP 层调用 `readJsonBody(req)` 不传 limit）—— 没有上限 = 任何人可灌爆内存。
>    修法：补默认上限用例（512KB 内放行 / 超出 413），并带反例对照（显式放宽 limit 后同一 body 放行）。
> **③（I-C）`domainCode` 零断言，且 4xx 分支泄漏 SQLite 原文**：
>    `domainCode` 是私有函数、零断言（改成恒返回 'BAD_REQUEST' 全量照样全绿）；
>    而 4xx 分支把 `err.message` 原样回给客户端 —— 裸 Error 的 message 里含
>    「users.phone UNIQUE constraint failed」这类内部原文。
>    修法：`domainCode` 改为导出（可直接测边界）；4xx/413 分支**只透传 `AppError` 的 message**，
>    裸 Error 一律回落为通用文案「请求无效」。
>
> **8 条 Minor 逐条处置**（全部是「加断言 / 改注释」，**不涉及任何生产行为变更**）：
>
> | # | Minor | 处置 |
> |---|---|---|
> | M-1 | `isSameFile` 接线断言过松（`isSameFile(stat, stat)` 与 `&& false` 两种写法都能让防线彻底失效） | 断言收紧到 `if (!isSameFile(stat, linkStat))` **逐字匹配**（含「不能被 `&&` 短路」） |
> | M-2 | 304 分支那条用例的名字声称「不重复打开文件」，但**没有任何 fd 断言** | 新增 `/dev/fd` 计数探针（连打 50 次 304，fd 数不得增长；Windows 跳过）+ 原用例名改准 |
> | M-3 | SQL 边界扫描器**自身**的检测面无断言（去掉 `exec` 或去掉 `DELETE` 都全绿） | 抽出 `scanCode()` + 10 种形态的阳性对照 + 3 种反例对照 |
> | M-4 | 扫描器有 3 种现实绕过（SQL 存进变量 / `db['prepare']()` / 连接变量不叫 `db`） | **有意接受**（宁可漏报也不误报），在文件头把这三种写法**显式列出** |
> | M-5 | 零依赖扫描器**不扫 `test/`**（README 的「只用 Node 标准库」是全项目级承诺） | `SCAN_DIRS` 加 `test` + 断言「扫描结果里出现过 `test/` 下的文件」（不抄常量，钉行为） |
> | M-6 | 5 条次要护栏无断言（静态 Content-Type / Cache-Control / `PRAGMA busy_timeout` / 404 错误码字面量 / 413 的 `Connection: close`） | 逐条补断言（404 与 busy_timeout 并入既有用例，不新增条数） |
> | M-7 | `static.js` 注释把「静态资源目录指向共享卷」写成正常部署形态，与实际行为**相反** | 注释订正为 fail-closed 的真实判定（指向根外 → 404；指向根内 → 200）+ 新增软链行为矩阵用例 |
> | M-8 | ① `router.js` 无「依据/规则来源」溯源标记；② `scopeClause` 用普通 `Error`、`grantAssignment` 用 `AppError`，语义有别但未写明；③ `error()` 不转发 `AppError.detail` | ①② 补注释（路由契约溯源 + 两种错误风格有意不同的理由）；③ **留到 P4**（P4 计划已显式排期「错误响应带上 detail 与 Retry-After」，P0 当前无任何错误携带 detail → 无可观测差异） |
>
> **验收**：本轮 12 个针对性变异体**全杀**
> （M1-a / M1-b / M2-a / M3-a / M3-b / M3-c / M5-a / M6-a / M6-b / M6-c / M6-d / M6-e）。
> 用例总数 144 → **150**。

> **【2026-10-20 修复轮 3】** 整分支终审（verifier）判定 **Needs fixes**：
> **0 Critical / 7 Important / 11 Minor**。其中 4 项落在本 Task，且**都是可远程利用的**：
> **①（I-1 Important）静态服务跟随符号链接跳出 `web/` 根 → 任意文件读。**
>      穿越防护只作用于**路径字符串**，而 `resolve()` **不解析符号链接**。
>      终审实测：`ln -s /etc web/etclink` → `GET /etclink/passwd` → **200 + /etc/passwd 全文**。
>      真实风险是**部署期误配置**：把 `platform/data` 软链进 `web/` → 全部 `password_hash`
>      与 `token_hash` 暴露到公网，正好抵消「库里只存哈希」这条安全设计。
>      修法：①`realpathSync` 把**根**与**目标**都解析成真实路径再比边界；
>      ②`openSync` 后用 **dev/ino 对账**堵住 realpath→open 的 TOCTOU 窗口
>      （`isSameFile` 单独导出，可直接测）。
> **②（I-2 Important）前端 `innerHTML` 未转义 → 存储型 XSS。**
>      `web/app.js` 把服务端返回的 `user.name` 原样插进 `innerHTML`。
>      P0 的 `name` 只由 seed 写入（不可远程利用），但 **P1 的报名端点让用户自选 name**
>      → 立刻变成可远程利用。同一项目 `web/views/login.js` 用的是 `err.textContent`（安全）
>      —— 说明作者知道要转义，只是 `app.js` 两处漏了。
>      修法：新建 `web/escape.js` 提供 `escapeHtml()`，`app.js` 两处插值全部走它。
> **③（I-5 Important）服务器自己的领域错误不经 `AppError`。**
>      `src/server.js` 两处手搓 `new Error()` 再挂 `.status` / `.code` —— 运行时行为对，
>      但 `INTERFACES.md` 定义 AppError 是**唯一**错误类型、P1–P6 全部复用。
>      服务器自己示范另一套写法 → P1–P6 照抄 → 下游 `e instanceof AppError` 分支失效。
>      这也直接让 P0-8「全部领域错误都经它抛出」**不达标**。修法：改用 `appError(...)`。
> **④（I-7 Important）`scripts/seed.js` 5 处裸 SQL 越过 SQL 边界。**
>      全局约束第一条是「**所有** SQL 收进 `src/db/repo/`」（绝对表述，不是只禁 handler）。
>      而同一文件第 80 行的注释写着「查重用仓储层（**不写裸 SQL**）」—— **注释与代码自相矛盾**。
>      修法：新建 `src/db/repo/capabilities.js` 与 `src/db/repo/roles.js`，
>      `setSuperadmin` 纯新增进 `users.js`，`seed.js` 改调仓储层；
>      并补一条**扫描式**断言（`test/sql-boundary.test.js`）把这条约束钉死。
>      **另**：本 Task 新增 `web/escape.js`（见 Step 6）。
> **验收**：修复后 23 个变异体**杀 21**；2 个存活项均已定性并登记（见 SDD 台账
> `fix-round-3` 条目）——①`isSameFile` 调用点被删（竞态无法稳定复现，改用**接线断言**钉住）；
> ②`Buffer.from` 挪出 try（与段数守卫**互为冗余**，单独拆掉任一道都不改变可观察行为，
> 危险的**组合**变异已被杀死）。用例总数 109 → **140**。

> **【2026-10-20 修复轮 2】** Task 7 的评审（verifier，17 个变异体）判定 **Needs fixes**：
> **无 Critical**（19 个裸 socket 穿越变体 + 对照实验证明当前实现不可利用），
> 但有 **5 项 Important**，核心是「规格 + 测试没把安全边界钉住」：
> **①（F-1 Important）登录失败路径有 115 倍计时侧信道** ——
>      `!!cred &&` 短路 ⇒ 用户不存在时**根本不跑 scrypt**（评审实测
>      「存在 20.18ms / 不存在 0.18ms」）→ 可枚举手机号。
>      规格的「避免用户枚举」只做完了响应层那一半。修法：用户不存在时也拿一个
>      **同参数**的哑元哈希跑一次 scrypt，让两条路径耗时对齐。
> **②（F-2 Important）静态读流没有 `error` 监听 → 单个请求能杀死整个进程** ——
>      `createReadStream(...).pipe(res)` 没有 error 监听时，流出错（mode 000 的文件 /
>      TOCTOU：statSync 之后、异步 open 之前文件被删 / NFS 瞬时 I/O 错误）会变成
>      **未捕获异常** → 进程退出码 1、客户端零响应。
>      修法：①**先 open 再取元数据**（用已打开的 fd，彻底消除 stat→open 的 TOCTOU 窗口，
>      打不开就直接回 404）；②读流挂 `error` 监听，错误时断开响应，**绝不让它冒泡**。
> **③（F-3 Important）`serveStatic` 在 try/catch 之外 → 配置错误即进程死亡** ——
>      `webDir` 缺失是在第一个静态请求上才炸（`resolve(undefined)` 抛错），
>      而 `handle` 是 async、`http.createServer` **不接管 rejected promise**
>      → 未捕获异常 → 进程退出。
>      修法：①`createApp` **构造期**就 fail-fast 拒绝缺 `webDir`；
>      ②静态分支进自己的 try；③`handle` 最外层再兜一层，任何异常都变成 500。
> **④（F-4 Important）4 个安全行为 + 1 类穿越变体零覆盖** ——
>      变异测试证明「seed 恢复默认口令兜底 / 500 分支回显 err.message /
>      parseCookie 去掉 try-catch / 登出不调 revokeSession / `%2e%2e` 编码穿越」
>      这 5 个变异**全量 79/79 仍绿**。其中编码穿越那条最硬：
>      裸 socket 实测 `/%2e%2e/web-secret/passwd` → **200 OK 读出 TOP-SECRET**。
>      修法：补 5 类用例（seed 2 条 + server 5 条），穿越用例改用
>      **真实 http server + 裸 socket**（fake res 走不到流式响应，穿越用例会假绿）。
> **⑤（F-5b Important）前端无会话恢复** ——
>      `web/app.js` 从不调 `/api/me` → 登录后刷新页面（F5）显示「未登录」，
>      而 Cookie 其实还有效、接口也还能用。修法：启动时先 `await restoreSession()` 再首屏渲染。
> **另修 2 个 Minor**：`isMain` 用 realpath 比较（符号链接入口曾静默 exit 0 不启动）；
> `static.js` 的 `createHash` 是死导入（删）。
> **变异验收**：修复后 11 个变异体**全部变红**（含评审 M17 的组合变异），
> 而「只去掉一道防线」的两条**预期保持绿** —— 那是纵深防御的正常表现。

> **【2026-10-20 预审修正】** 只读预审代理把本 Task 的简报**逐字落到临时目录实跑**，
> 查出 **2 Critical + 4 Important + 4 Minor**。
> 注意：简报自带的 4 条测试**全绿** —— 因为**一条都没碰登录态与静态文件**，
> 下面两个 Critical 全都测不出来（"测试全过"≠"主功能可用"，这正是预审存在的意义）。
> **② 波及 P3**：P3 计划用 `hk_session=${createSession(...).token}` 写测试，
> P3 旗舰用例「GET /api/leaderboard/:stageId?scope=rank 返回 A 榜」会整片 500。
> 修正十处：
> **①（C7-1 Critical）目录穿越防护缺路径分隔符边界 → 可读出 web 目录的兄弟目录。**
>      原判断 `target.startsWith(normalize(webDir))` **没有分隔符边界** ——
>      `'/…/web-secret/passwd'.startsWith('/…/web')` 为真 → 预审实测 **200 + 兄弟目录文件内容**。
>      改为**三重防护**：① 用 `resolve` + **带分隔符的前缀比较**
>      （`target !== root && !target.startsWith(root + sep)` → 拒绝）；
>      ② `rel` 先 `decodeURIComponent`，并显式拒绝含 `..` 的路径段（`%2e%2e` 也挡住）；
>      ③ `rel` 以 `/` 开头时用 `resolve(root, '.' + rel)`（`.` 前缀）避免被当成绝对路径。
>      补 1 条测试：构造 `web/` 的兄弟目录 `web-secret/`，请求 `/../web-secret/passwd` 必须拿不到内容。
> **②（C7-2 Critical）已登录用户访问 `/api/me` 返回 500。**
>      Task 5 的 `resolveSession` 返回 `{ userId, expiresAt }`，
>      Task 7 却读 `session.user_id`（undefined）→ node:sqlite 绑定 undefined 直接抛错
>      （`TypeError: Provided value cannot be bound to SQLite parameter 1.`）。
>      契约 INTERFACES.md:67 就是 `{ userId, expiresAt }` → 改为 `session.userId`。
>      补 1 条测试：**带有效 session cookie → `/api/me` 返回 200 且 body 含当前用户**。
> **③（I7-1 Important）P0 没有登录接口，也从不下发 Session Cookie。**
>      P0 README 宣称的交付物是「**能登录的空系统**」，但 Task 7 只注册 `/api/health` 与 `/api/me`，
>      预审实测 `POST /api/auth/login` → 404、无 `Set-Cookie`；
>      前端登录视图 `api.post('/api/auth/login', {...})` 必然 404；
>      服务端从不调用 `createSession` → Task 5 产出的会话能力**没有任何调用方**；
>      设计文档 §7.5 要求的 `HttpOnly + SameSite=Lax + Secure(生产) + Path=/` 全项目无处落地。
>      补两条路由：`POST /api/auth/login`（按手机号取用户 → `verifyPassword` → `createSession` → 下发
>      `Set-Cookie: hk_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttlSeconds>`，生产加 `Secure`；
>      密码错 / 用户不存在**一律 401**，不区分二者，避免用户枚举）、
>      `POST /api/auth/logout`（`revokeSession` + 清 Cookie）。
>      补 2 条测试：① 正确手机号+密码登录 → 200 + 有 `Set-Cookie` + 响应里不含口令哈希等敏感信息；
>      ② 错误密码 → 401 + **不**下发 Cookie。
> **④（I7-2 Important）种子脚本用硬编码默认口令创建超管。**
>      `process.env.ADMIN_PASSWORD || 'change-me-now'` —— 典型的「缺省兜底掩盖缺失」：
>      没配环境变量就用一个写死在代码里的公开口令当组委会超管口令（预审实测已打印出来），
>      P6 之后这套脚本要在公网机器上跑。与项目原则「校验不过就拒绝启动，绝不降级为默认值」冲突。
>      改为**不兜底**：没有 `ADMIN_PASSWORD` → `console.error` 明确报错 + `process.exit(1)`，**不创建任何账号**；
>      创建成功后只打印账号与「请立即修改密码」的提示（口令本身绝不兜底，也不再打印到 stdout）。
> **⑤（I7-3 Important）500 响应把内部错误原文回给客户端。**
>      预审实测那条 500 直接带出了 `Provided value cannot be bound to SQLite parameter 1.`，
>      SQLite 错误还会带表名列名；另外 `err.code` 取的是 Node 错误码（`ERR_INVALID_ARG_TYPE`）而非领域码。
>      改为：`status >= 500` 时对外只回 `{ error: { code: 'INTERNAL', message: '服务内部错误' } }`，
>      详细信息只进 `console.error`；4xx 的领域错误统一用约定的 `code` 字段（Node 的 `ERR_*` 不外泄）。
> **⑥（I7-4 Important）handler 协议只能返回 200。**
>      成功状态码无法表达 201/204，P1 起大量「POST 创建资源 → 201 Created」实现不了。
>      约定 handler 可返回 `{ status, body }`（可选 `headers` 附加响应头）：
>      返回 `undefined` → 视为 200（保持现有行为）；返回 `{ status, body }` → 按返回的状态码与 body 响应。
>      同步写进 INTERFACES.md 的 handler 说明（**只加这一句，不改其他契约**）。
> **⑦（m7-1 Minor）`server.listen(port)` 默认绑 0.0.0.0，但启动日志写 `http://127.0.0.1:8080`。**
>      改为显式 `server.listen(port, '127.0.0.1')`（云主机部署时再改 `0.0.0.0`），日志与实际绑定一致。
> **⑧（m7-2 Minor）`parseCookie` 对 cookie 值直接 `decodeURIComponent`，畸形编码抛 URIError。**
>      改为 try/catch，失败时原样透传该 cookie 值。
> **⑨（m7-3 Minor）前端 `api.js` 的 `subscribe()`（SSE）指向的端点整个 P0–P6 都没实现。**
>      **不在本期实现**，但在 `web/api.js` 的 `subscribe()` 上加注释标明「端点在 P2 启用；P0/P1 调用会 404」，
>      并把 P0 计划目录树里的 `src/http/sse.js` 标注为 P2 建 —— 不留一个必然 404 却没有说明的接口。
> **⑩（m7-4 Minor）P0-2 验收文案与实际输出不符。**
>      验收标准写「启动报『权重合计 = 1.05』」，实现实际输出「权重合计 = 1.1000，必须等于 1（100%）」
>      （`toFixed(4)` + 后缀）。验收口径改为「报错里出现『权重合计』且进程以**非 0 退出码**退出」。
> 测试从 4 条增至 **9 条**。

**Files:**
- Create: `platform/src/http/static.js`
- Create: `platform/src/server.js`
- Create: `platform/scripts/seed.js`
- Create: `platform/src/db/repo/capabilities.js`
- Create: `platform/src/db/repo/roles.js`
- Create: `platform/test/server.test.js`
- Create: `platform/test/seed.test.js`
- Create: `platform/test/web.test.js`
- Create: `platform/test/sql-boundary.test.js`
- Create: `platform/web/index.html`
- Create: `platform/web/app.js`
- Create: `platform/web/router.js`
- Create: `platform/web/store.js`
- Create: `platform/web/api.js`
- Create: `platform/web/api.demo.js`
- Create: `platform/web/escape.js`
- Create: `platform/web/styles.css`
- Create: `platform/web/views/login.js`
- Modify: `platform/package.json`（`start` 脚本已在 Task 1 建好，本步不改）
- Test: `platform/test/server.test.js`
- Test: `platform/test/seed.test.js`
- Test: `platform/test/web.test.js`

**Interfaces:**
- Consumes: Task 2 `openDatabase`、Task 3 `loadRules`、Task 4 `createRouter/json/error`、Task 5 `createSession/resolveSession/revokeSession/verifyPassword`、Task 6 `can`、Task 5 `toPublicUser`
- Produces:
  - `serveStatic(webDir, req, res)` → `boolean`（命中返回 true）
  - `createApp({ db, rules, webDir })` → `{ router, handle(req, res) }`——可测的请求处理入口
  - 路由：`GET /api/health` ｜ `GET /api/me` ｜ `POST /api/auth/login` ｜ `POST /api/auth/logout`
  - **handler 返回约定**：返回 `undefined` → 200；返回 `{ status, body }`（可选 `headers`）→ 按返回值应答
  - `src/server.js` 进程入口：加载配置 → 校验 → 建库 → 迁移 → 装配 → 监听
  - 前端：`api.js` 导出 `{ get, post, patch, del, subscribe }`；`api.demo.js` 导出同名接口的 localStorage 实现

- [ ] **Step 1: 写失败的测试**

`platform/test/server.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { stripComments } from '../test-helpers/strip-comments.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-srv-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  // web/ 旁边造一个兄弟目录 web-secret/ —— 用来验证目录穿越防护（C7-1）
  //
  // ⚠️ 静态根**放进 dataDir 里**（而不是另开一个 mkdtemp 目录）：
  //    本文件 33 处用例末尾清的都是 `rmSync(dataDir, …)`；
  //    若 webRoot 是独立目录，只有 10/33 处显式删了它 ⇒ **每次全量跑漏 20+ 个目录**。
  //    （macOS 上 `$TMPDIR` 按用户隔离且系统会清 ⇒ 本机看不见；
  //      Linux 的 `/tmp` 是共享的 ⇒ 一次真机复现就堆出 80+ 个。实测 2026-10-21。）
  const webRoot = join(dataDir, 'web-root');
  const webDir = join(webRoot, 'web');
  mkdirSync(webDir, { recursive: true });
  mkdirSync(join(webRoot, 'web-secret'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(webRoot, 'web-secret', 'passwd'), 'TOP-SECRET');
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, webRoot, app };
}

function call(app, method, path, { headers = {}, body = null, bodyThrows = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
        if (bodyThrows) throw bodyThrows;
      },
      on() {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
      end(payload) {
        if (payload) this.body = payload.toString();
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };
    app.handle(req, res);
  });
}

/**
 * 用**裸 socket** 发原始请求行。
 * ⚠️ 为什么不能用 fetch / http.request：它们会按 WHATWG URL 规范把
 *    `%2e%2e` 规范化成 `..` 并消掉路径里的点段 —— 请求根本发不出原样，
 *    穿越测试就成了空转（评审已对照实验证明 Node 的 HTTP **解析器**不规范化，
 *    所以原样发出去，服务端收到的就是原样的路径）。
 */
function rawRequest(port, rawPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const done = (value) => resolve(value);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`请求超时：${rawPath}`));
    });
    socket.on('connect', () => {
      socket.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    socket.on('close', () => done(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

test('GET /api/health 返回 ok', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未登录访问 /api/me 返回 401', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/me');
  assert.equal(res.status, 401);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未知路径返回 404（错误码字面量必须是 NOT_FOUND）', async () => {
  // ⚠️ 终审修正（Minor，M-6）：原来只断言了状态码 404 ——
  //    把错误码字面量改成 NOT_FOUND_X，全量照样全绿（实测 V2 SURVIVED）。
  //    而错误码是**契约的一部分**：客户端 web/api.js 消费 data.error.code 来分流。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/nope');
  assert.equal(res.status, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'NOT_FOUND', `404 的错误码必须是 NOT_FOUND，实际 ${body.error.code}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('配置非法时 createApp 抛错（fail-fast）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-bad-'));
  const { db, close } = openDatabase({ dataDir });
  assert.throws(
    () => createApp({ db, rules: { scoring: { initial: { dimensions: [{ weight: 0.5 }] } } }, webDir: '/tmp' }),
    /规则|校验/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('正确手机号+密码登录返回 200 并下发 Session Cookie', async () => {
  // ⛔ 预审修正（I7-1）：P0 原本**没有登录接口**，README 宣称的「能登录的空系统」不成立。
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000001', password: 'pw123' });
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000001', password: 'pw123' },
  });
  assert.equal(res.status, 200);
  const cookie = res.headers['Set-Cookie'];
  assert.ok(cookie, '必须下发 Set-Cookie');
  assert.match(cookie, /^hk_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);
  // 响应体不得含口令哈希等敏感信息
  assert.equal(res.body.includes('scrypt$'), false);
  assert.equal(res.body.includes('password'), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('密码错误返回 401 且不下发 Cookie（用户不存在同码，不泄露用户是否存在）', async () => {
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000002', password: 'pw123' });
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000002', password: 'wrong' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers['Set-Cookie'], undefined);
  const missing = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13900000009', password: 'pw123' },
  });
  assert.equal(missing.status, 401);
  assert.equal(
    JSON.parse(missing.body).error.code,
    JSON.parse(res.body).error.code,
    '用户不存在与密码错必须同一个错误码（防用户枚举）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('带有效 session cookie 的 /api/me 返回 200 且 body 含当前用户', async () => {
  // ⛔ 预审修正（C7-2）：原来读 session.user_id（undefined）→ node:sqlite 绑定 undefined 抛错 → 500。
  const { db, close, dataDir, app } = setup();
  const user = createUser(db, { name: '甲', phone: '13800000003', password: 'pw123' });
  const { token } = createSession(db, user.id);
  const res = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.name, '甲');
  assert.equal(body.user.password_hash, undefined);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('畸形百分号编码的 URL 返回 400，不抛异常', async () => {
  // ⛔ 预审修正（C4-2）：畸形编码不能打死进程，也不能被当成 404。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/teams/%E0%A4%A');
  assert.equal(res.status, 400);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('目录穿越拿不到 web 兄弟目录的内容', async () => {
  // ⛔ 预审修正（C7-1）：'/…/web-secret/passwd'.startsWith('/…/web') 为真 → 兄弟目录可被读出。
  // ⚠️ 必须在**真实 http server + 裸 socket** 上验：
  //    用 fake res 时，静态内容一旦真的被读出就会因为 fake res 没有 on()
  //    （stream.pipe 需要）而抛错，被静态分支的 try/catch 吞成 404 ——
  //    穿越测试就成了一条**恒绿**用例（评审 M17 的组合变异在 fake res 下测不出来）。
  const { db, close, dataDir, webRoot, app } = setup();
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const raw = await rawRequest(port, '/../web-secret/passwd');
    assert.equal(raw.includes('TOP-SECRET'), false, '字面量穿越泄露了兄弟目录内容');
    assert.ok(!/^HTTP\/1\.1 200/.test(raw), `字面量穿越不得返回 200：${raw.slice(0, 80)}`);
    // 服务器必须存活
    const alive = await rawRequest(port, '/index.html');
    assert.ok(alive.includes('200 OK'), '服务器必须存活');
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('编码形式的目录穿越（%2e%2e）拿不到 web 兄弟目录的内容', async () => {
  // ⚠️ 评审修正（Important）：原来只测了**字面量** `/../`。
  //    变异测试证明：把 `..` 检查挪到 decode 之前 **且** 去掉分隔符边界，
  //    **79 条测试全绿**，而裸 socket 实测 `/%2e%2e/web-secret/passwd` → **200 OK 读出 TOP-SECRET**。
  //    这里用**裸 socket** 发原始请求行（客户端会规范化路径，必须绕过客户端）。
  const { db, close, dataDir, webRoot, app } = setup();
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const paths = [
      '/%2e%2e/web-secret/passwd',
      '/%2e%2e%2fweb-secret/passwd',
      '/..%2fweb-secret/passwd',
      '/%2e%2e/web-secret/passwd',
    ];
    for (const p of paths) {
      const raw = await rawRequest(port, p);
      assert.equal(raw.includes('TOP-SECRET'), false, `${p} 泄露了兄弟目录内容`);
      assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 不得返回 200：${raw.slice(0, 80)}`);
    }
    const alive = await rawRequest(port, '/index.html');
    assert.ok(alive.includes('200 OK'), '服务器必须存活');
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('500 响应只回通用文案，内部细节只进 console.error', async () => {
  // ⚠️ 评审修正（Important）：原来**没有任何 500 用例** ——
  //    变异「500 分支回显 err.message」时全量 79/79 仍绿。
  //    构造一个会抛普通 Error 的请求体读取 → 落到 500 分支。
  const { db, close, dataDir, app } = setup();
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const res = await call(app, 'POST', '/api/auth/login', {
      bodyThrows: new Error('INTERNAL-DETAIL-must-not-leak'),
    });
    assert.equal(res.status, 500);
    assert.equal(
      res.body,
      JSON.stringify({ error: { code: 'INTERNAL', message: '服务内部错误' } }),
      '500 响应体必须逐字节等于通用文案',
    );
    assert.equal(res.body.includes('INTERNAL-DETAIL-must-not-leak'), false);
    assert.ok(
      logged.some((l) => l.includes('INTERNAL-DETAIL-must-not-leak')),
      '内部细节必须进 console.error',
    );
  } finally {
    console.error = original;
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('畸形 cookie 不会抛异常（返回 401，服务器存活）', async () => {
  // ⚠️ 评审修正（Important）：原来**没有畸形 cookie 用例** ——
  //    变异「parseCookie 去掉 try/catch」时全量 79/79 仍绿。
  const { db, close, dataDir, app } = setup();
  for (const cookie of ['hk_session=%E0%A4%A', 'hk_session=%', 'hk_session=%zz', '=abc', 'hk_session']) {
    const res = await call(app, 'GET', '/api/me', { headers: { cookie } });
    assert.equal(res.status, 401, `cookie=${cookie} 应返回 401`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('登出后原会话立即失效', async () => {
  // ⚠️ 评审修正（Important）：原来**没有登出用例** ——
  //    变异「登出不调 revokeSession」时全量 79/79 仍绿。
  const { db, close, dataDir, app } = setup();
  const user = createUser(db, { name: '甲', phone: '13800000004', password: 'pw123' });
  const { token } = createSession(db, user.id);
  const before = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(before.status, 200);
  const out = await call(app, 'POST', '/api/auth/logout', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(out.status, 200);
  const after = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(after.status, 401, '登出后原 token 必须失效');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('createApp 缺少 webDir 时在构造期就抛错（fail-fast，不留到运行时）', async () => {
  // ⚠️ 评审修正（Important）：原来 webDir 缺失是在**第一个静态请求**上炸 ——
  //    serveStatic 在 try/catch 之外 → 未捕获异常 → **整个进程退出**（退出码 1）。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-noweb-'));
  const { db, close } = openDatabase({ dataDir });
  const { rules } = loadRules(rulesDir);
  assert.throws(
    () => createApp({ db, rules }),
    /webDir/,
    '构造期就必须拒绝，不能拖到请求期',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('登录失败路径的耗时要对齐（用户不存在时也必须跑 scrypt）', async () => {
  // ⚠️ 评审修正（Important）：原来 `!!cred &&` 短路 → 用户不存在时**根本不跑 scrypt**
  //    → 评审实测「存在 20.18ms / 不存在 0.18ms」，**115 倍**差距 → 可枚举手机号。
  //    这里断言「用户不存在」的登录耗时也有 scrypt 的量级下限（~20ms，取 5ms 保守阈值）。
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000005', password: 'pw123' });
  const t0 = process.hrtime.bigint();
  const missing = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13900000000', password: 'pw123' },
  });
  const t1 = process.hrtime.bigint();
  const wrong = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000005', password: 'wrong' },
  });
  const t2 = process.hrtime.bigint();
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  const missingMs = Number(t1 - t0) / 1e6;
  const wrongMs = Number(t2 - t1) / 1e6;
  assert.ok(
    missingMs >= 5,
    `用户不存在的登录耗时 ${missingMs.toFixed(2)}ms —— 必须跑完 scrypt（否则可枚举手机号）`,
  );
  assert.ok(wrongMs >= 5, `密码错误的登录耗时 ${wrongMs.toFixed(2)}ms —— 异常偏低`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('静态文件读不了时返回错误且服务器存活（不能被单个请求打死）', {
  // root 能读 mode 000 的文件 → 这条测试在 root 下没有意义
  skip: typeof process.getuid === 'function' && process.getuid() === 0
    ? 'root 可以读 mode 000 的文件，跳过'
    : false,
}, async () => {
  // ⚠️ 评审修正（Important）：原来读流**没有 error 监听** ——
  //    web/ 下 mode 000 的文件 → EACCES → 无人监听的 error 事件 → 未捕获异常
  //    → **整个服务器进程退出**（评审实测退出码 1、客户端完全无响应）。
  //    这条必须在**真实 http server** 上验：fake res 走不到流式响应。
  const { db, close, dataDir, webRoot, app } = setup();
  const locked = join(webRoot, 'web', 'locked.js');
  writeFileSync(locked, 'module.exports = 1;');
  chmodSync(locked, 0o000);
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/locked.js`);
    assert.ok(res.status >= 400, `应返回 4xx/5xx，实际 ${res.status}`);
    // 关键断言：服务器**还活着**
    const alive = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(alive.status, 200, '服务器必须存活（不能被单个请求打死）');
    assert.equal((await alive.text()).includes('home'), true);
  } finally {
    server.close();
    chmodSync(locked, 0o600);
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('读流出错时变成 500 响应，不会变成未捕获异常（外层兜底生效）', async () => {
  // ⛔ 评审修正（Important）：`handle` 是 async，而 http.createServer **不接管
  //    rejected promise** → 任何逸出 handle 的异常都会变成未捕获异常 → 进程死亡。
  //    用一个会抛异常的 req.url 把异常打到**内层 try 之外**（外层兜底那一层）。
  const { db, close, dataDir, app } = setup();
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const req = {
      method: 'GET',
      get url() { throw new Error('OUTER-DETAIL-must-not-leak'); },
      headers: {},
      async *[Symbol.asyncIterator]() {},
      on() {},
    };
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
      end(payload) { if (payload) this.body = payload.toString(); },
      destroy() {},
    };
    await app.handle(req, res);
    assert.equal(res.statusCode, 500, '逸出的异常必须变成 500');
    assert.equal(
      res.body,
      JSON.stringify({ error: { code: 'INTERNAL', message: '服务内部错误' } }),
      '500 响应体必须逐字节等于通用文案',
    );
    assert.equal(res.body.includes('OUTER-DETAIL'), false, '内部细节不能外泄');
    assert.ok(
      logged.some((l) => l.includes('OUTER-DETAIL')),
      '内部细节必须进 console.error',
    );
  } finally {
    console.error = original;
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('读流的 error 监听：流出错时断开响应，而不是变成未捕获异常', async () => {
  // ⛔ 评审修正（Important）：读流没有 error 监听时，任何读错误都会变成
  //    **未捕获异常** → 整个服务器进程退出（评审实测：mode 000 文件 → EACCES
  //    → 进程退出码 1、客户端零响应）。
  //    这里用**无效 fd** 触发 EBADF，把这条路径单独钉住。
  const { pipeFd } = await import('../src/http/static.js');
  let destroyed = 0;
  const res = {
    destroy() { destroyed += 1; },
    on() {}, once() {}, emit() {}, write() {}, end() {},
  };
  pipeFd(res, 999999); // 不存在的 fd → 流会发 EBADF error
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(destroyed, 1, '流出错时应断开响应（而不是让异常冒泡）');
});

// ══════════════════════════════════════════════════════════════════
// 终审修复轮 3 的回归用例（评审 whole-branch-review.md §7）
// 下面每一条都对应一条「改坏了但全量测试照样全绿」的生产护栏。
// ══════════════════════════════════════════════════════════════════

test('软链指向 web 根外的文件时返回 404，不得读出文件内容（终审 I-1）', { skip: process.platform === 'win32' ? 'Windows 创建符号链接需要开发者模式或管理员权限' : false }, async () => {
  // ⛔ 终审发现（Important）：静态服务只对**路径字符串**做边界比较，
  //    而 resolve() **不解析符号链接** → web/ 下指向根外的软链会被读出来。
  //    终审实测：ln -s /etc web/etclink → GET /etclink/passwd → 200 + /etc/passwd 全文。
  //    真实风险是**部署期误配置**：把 platform/data 软链进 web/ → 全部 password_hash
  //    与 token_hash 暴露到公网，正好抵消「库里只存哈希」这条安全设计。
  // ⚠️ 必须用**真实 http server + 裸 socket**：fake res 走不到流式响应，会假绿。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sym-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const webRoot = mkdtempSync(join(tmpdir(), 'hks-symweb-'));
  const webDir = join(webRoot, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  // 根外文件 + 两个软链：直接指向文件的、指向整个目录的
  writeFileSync(join(webRoot, 'leak.txt'), 'SECRET-OUTSIDE-WEB\n');
  symlinkSync(join(webRoot, 'leak.txt'), join(webDir, 'leak.txt'));
  symlinkSync(webRoot, join(webDir, 'rootlink'));
  const app = createApp({ db, rules, webDir });
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const p of ['/leak.txt', '/rootlink/leak.txt']) {
      const raw = await rawRequest(port, p);
      assert.equal(raw.includes('SECRET-OUTSIDE-WEB'), false, `${p} 泄露了 web 根外的内容`);
      assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 不得返回 200：${raw.slice(0, 80)}`);
    }
    // 正常静态资源必须仍然可用（防止把防线修过头）
    const alive = await rawRequest(port, '/index.html');
    assert.ok(alive.includes('200 OK'), '正常静态资源必须仍可访问');
    assert.ok(alive.includes('<h1>home</h1>'), '正常静态资源内容必须完整');
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('服务器抛出的领域错误必须是 AppError 实例（终审 I-5）', async () => {
  // ⛔ 终审发现（Important）：src/server.js 手搓 `new Error()` 再挂 .status/.code，
  //    而 INTERFACES.md:21 定义 AppError 是**唯一**的错误类型、P1–P6 全部复用。
  //    服务器自己示范另一套写法 → P1–P6 照抄 → 下游 `e instanceof AppError` 分支失效。
  const { db, close, dataDir, app } = setup();
  const { AppError } = await import('../src/errors.js');
  const hit = app.router.match('GET', '/api/me');
  assert.ok(hit, '必须能取到 /api/me 的 handler');
  await assert.rejects(
    () => hit.handler({ user: null }),
    (err) => {
      assert.ok(err instanceof AppError, `领域错误必须是 AppError，实际是 ${err?.constructor?.name}`);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'UNAUTHENTICATED');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('登录失败也必须抛 AppError（终审 I-5）', async () => {
  const { db, close, dataDir, app } = setup();
  const { AppError } = await import('../src/errors.js');
  createUser(db, { name: '甲', phone: '13800000009', password: 'pw123' });
  const hit = app.router.match('POST', '/api/auth/login');
  await assert.rejects(
    () => hit.handler({ body: { phone: '13800000009', password: 'wrong' } }),
    (err) => {
      assert.ok(err instanceof AppError, `领域错误必须是 AppError，实际是 ${err?.constructor?.name}`);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'INVALID_CREDENTIALS');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('请求体是数组时返回 400（不是 401）（终审 I-6-2）', async () => {
  // ⛔ 终审发现（Important）：去掉 readJsonBody 的 Array.isArray 守卫后，
  //    数组 body 会一路走到 `body?.phone` → undefined → 401。
  //    错误从「清晰的 400」退化成「静默的 undefined」，P1–P6 的 handler 会拿到数组当对象用。
  const { db, close, dataDir, app } = setup();
  for (const body of [[], ['a'], 'str', 42]) {
    const res = await call(app, 'POST', '/api/auth/login', { body });
    assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须回 400，实际 ${res.status}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('JSON 响应的 Content-Type 必须是 application/json（终审 I-6-3）', async () => {
  // ⛔ 终审发现（Important）：把 json() 的 Content-Type 改成 text/plain，
  //    全量测试照样全绿 —— 因为 web/api.js 用 res.text() + JSON.parse()，
  //    前端恰好不受影响，bug 会一路带到 P6 才在真浏览器里炸。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.match(
    res.headers['Content-Type'],
    /application\/json/,
    `JSON 响应必须是 application/json，实际 ${res.headers['Content-Type']}`,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('已停用的用户不能登录（终审 I-6-4）', async () => {
  // ⛔ 终审发现（Important）：`cred.active === 1` 是**登录路径上唯一**的停用检查。
  //    P1 接上「停用成员」之后，这个未钉住的检查就是**认证绕过**。
  const { db, close, dataDir, app } = setup();
  const { deactivateUser } = await import('../src/db/repo/users.js');
  const user = createUser(db, { name: '甲', phone: '13800000010', password: 'pw123' });
  deactivateUser(db, user.id);
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000010', password: 'pw123' },
  });
  assert.equal(res.status, 401, '停用用户不得登录成功');
  assert.equal(res.headers['Set-Cookie'], undefined, '停用用户登录不得下发 Cookie');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('4xx 响应不得外泄 err.stack（终审 I-6-5）', async () => {
  // ⛔ 终审发现（Important）：500 分支有逐字节断言，4xx 分支没有。
  //    一旦把 4xx 分支的 err.message 改成 err.stack → 文件路径 + 调用栈直接进 HTTP 响应。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/me');
  assert.equal(res.status, 401);
  assert.ok(!res.body.includes('at '), `响应体不得包含调用栈：${res.body}`);
  assert.ok(!res.body.includes('src/server.js'), `响应体不得包含源码路径：${res.body}`);
  assert.ok(!res.body.includes('node:internal'), `响应体不得包含 Node 内部路径：${res.body}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('带 if-none-match 的静态请求返回 304 且服务器存活（终审 M-2）', async () => {
  const { db, close, dataDir, webRoot, app } = setup();
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const first = await rawRequest(port, '/index.html');
    const m = first.match(/ETag:\s*(\S+)/i);
    assert.ok(m, '静态响应必须带 ETag');
    const etag = m[1];
    const second = await rawRequest(port, '/index.html', 5000);
    assert.ok(second.includes('200 OK'), '首次请求必须是 200');
    // 用裸 socket 发带 if-none-match 的请求
    const notModified = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const chunks = [];
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('超时')); });
      socket.on('connect', () => {
        socket.write(
          `GET /index.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nIf-None-Match: ${etag}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
    assert.ok(notModified.includes('304'), `命中 ETag 必须回 304：${notModified.slice(0, 120)}`);
    const alive = await rawRequest(port, '/index.html');
    assert.ok(alive.includes('200 OK'), '服务器必须存活（304 分支不得泄漏 fd 把进程拖死）');
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('登出响应必须下发清空 Cookie 的 Set-Cookie（终审 M-3）', async () => {
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000011', password: 'pw123' });
  const login = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000011', password: 'pw123' },
  });
  const cookie = login.headers['Set-Cookie'];
  assert.ok(cookie, '登录必须下发 Cookie');
  const res = await call(app, 'POST', '/api/auth/logout', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(res.status, 200);
  const cleared = res.headers['Set-Cookie'];
  assert.ok(cleared, '登出必须下发 Set-Cookie 以清掉浏览器端会话');
  assert.match(cleared, /^hk_session=;/, `登出必须清空 hk_session：${cleared}`);
  assert.match(cleared, /Max-Age=0/i, `登出的 Cookie 必须立即过期：${cleared}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('404 响应体不得包含 web 目录的绝对路径（终审 M-4）', async () => {
  const { db, close, dataDir, webRoot, app } = setup();
  const res = await call(app, 'GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes(webRoot), `404 不得回显内部路径：${res.body}`);
  assert.ok(!res.body.includes('hks-web-'), `404 不得回显临时目录名：${res.body}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

test('dev/ino 对账：两个不同的文件不得被判为同一个（终审 I-1 的 TOCTOU 防线）', async () => {
  // ⚠️ realpath 与 open 之间的竞态无法稳定复现，但「两个不同文件必须被判为不同」
  //    可以直接钉死 —— 否则这条防线就是纯注释。
  const { isSameFile } = await import('../src/http/static.js');
  const a = { dev: 16777224, ino: 12345 };
  assert.equal(isSameFile(a, { dev: a.dev, ino: a.ino }), true, '同一文件必须判为相同');
  assert.equal(isSameFile(a, { dev: a.dev, ino: 99999 }), false, 'ino 不同必须判为不同');
  assert.equal(isSameFile(a, { dev: 99999, ino: a.ino }), false, 'dev 不同必须判为不同');
  assert.equal(isSameFile(a, null), false, '缺 stat 不得判为相同');
  assert.equal(isSameFile(null, a), false, '缺 stat 不得判为相同');
  assert.equal(isSameFile(null, null), false, '两个缺 stat 不得判为相同');
});

test('登录响应体必须带回当前用户，且不得含 password_hash（复核 I1）', async () => {
  // ⛔ 复核发现（Important）：登录响应体此前**零断言** ——
  //    把它改成 `{"user":null}` 或 `toPublicUser(cred)`（把口令哈希带出去），
  //    全量测试照样全绿。主功能的输出没有任何保证。
  const { db, close, dataDir, app } = setup();
  createUser(db, { name: '甲', phone: '13800000012', password: 'pw123' });
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000012', password: 'pw123' },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.user, '登录响应必须带回 user');
  assert.equal(body.user.name, '甲', '必须带回用户姓名');
  assert.equal(body.user.phone, '13800000012', '必须带回手机号');
  assert.ok(body.user.id, '必须带回用户 id');
  assert.ok(!('password_hash' in body.user), '不得把 password_hash 带出去');
  assert.ok(!('passwordHash' in body.user), '不得把 passwordHash 带出去');
  assert.ok(!res.body.includes('scrypt$'), '响应体不得出现口令哈希');
  // ⚠️ 键集合必须**精确**：对外形状是 toPublicUser 的驼峰版
  //    （mbaStatus / isSuperadmin / createdAt，active 与 isSuperadmin 是**布尔**）。
  //    只断言 name/phone 时，把响应换成仓储原始行（snake_case）照样全绿 ——
  //    而那会让前端拿到 `active: 1`（数字）、`is_superadmin: 0`（数字），
  //    真假判断在 JS 里是**真的**（`1` 与 `0` 都是 truthy）→ 停用用户会被当成超管。
  assert.deepEqual(
    Object.keys(body.user).sort(),
    ['active', 'createdAt', 'id', 'isSuperadmin', 'mbaStatus', 'name', 'org', 'phone'],
    `登录响应的 user 键集合必须精确等于 toPublicUser 的对外形状，实际 ${JSON.stringify(Object.keys(body.user))}`,
  );
  assert.equal(typeof body.user.active, 'boolean', 'active 必须是布尔（数字 0/1 都是 truthy）');
  assert.equal(typeof body.user.isSuperadmin, 'boolean', 'isSuperadmin 必须是布尔');
  assert.equal(body.user.active, true);
  assert.equal(body.user.isSuperadmin, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('停用用户的登录失败耗时也必须跑 scrypt（复核 I2）', async () => {
  // ⛔ 复核发现（Important）：计时对齐此前只钉住「用户不存在」与「密码错误」两条路径，
  //    **停用用户**这条路径没钉。若实现改成「停用用户直接短路、不跑 scrypt」，
  //    攻击者就能用「停用账号的响应时间」区分「手机号存在但已停用」→ 依然可枚举。
  const { db, close, dataDir, app } = setup();
  const { deactivateUser } = await import('../src/db/repo/users.js');
  const user = createUser(db, { name: '甲', phone: '13800000013', password: 'pw123' });
  deactivateUser(db, user.id);
  const t0 = process.hrtime.bigint();
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000013', password: 'pw123' },
  });
  const t1 = process.hrtime.bigint();
  assert.equal(res.status, 401);
  const ms = Number(t1 - t0) / 1e6;
  assert.ok(
    ms >= 5,
    `停用用户的登录耗时 ${ms.toFixed(2)}ms —— 必须跑完 scrypt（否则仍可枚举手机号）`,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('静态请求命中目录时返回干净的 404，而不是掐断连接（复核 I5）', async () => {
  // ⛔ 复核发现（Important）：serveStatic 的 isFile() 守卫此前零覆盖 ——
  //    去掉它之后，目录请求不再走「干净 404」，而是**连接被掐断**（实测 fetch failed）。
  //    这会让前端把「404」与「服务器崩了」混为一谈。
  const { db, close, dataDir, webRoot, app } = setup();
  mkdirSync(join(webRoot, 'web', 'subdir'), { recursive: true });
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/subdir`);
    assert.ok(res.status >= 400 && res.status < 500, `目录请求必须回 4xx，实际 ${res.status}`);
    const alive = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(alive.status, 200, '服务器必须存活');
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('serveStatic 必须真的调用 isSameFile 做 dev/ino 对账（接线断言）', async () => {
  // ⚠️ 竞态本身无法稳定复现，但「serveStatic 真的调用了这条防线」可以钉死 ——
  //    否则把**调用点**删掉（isSameFile 函数还在、它自己的单元测试照样绿）
  //    就等于这条 TOCTOU 防线悄悄消失了。
  //    这与「零依赖守卫」用的是同一类手段：**扫描源码**。
  const src = readFileSync(join(here, '..', 'src', 'http', 'static.js'), 'utf8');
  const fnStart = src.indexOf('export function serveStatic');
  assert.ok(fnStart > 0, '必须能找到 serveStatic');
  const nextExport = src.indexOf('\nexport ', fnStart + 10);
  const rawFnBody = src.slice(fnStart, nextExport > 0 ? nextExport : src.length);
  // ⚠️ 终审修正（Minor，M-1）：原来只断言「源码里出现过 isSameFile(」，
  //    于是 `isSameFile(stat, stat)`（**对账对象写错**，更像手滑）
  //    与 `!isSameFile(stat, linkStat) && false`（把防线短路掉）
  //    两种写法都能让这条防线**彻底失效**而全量照样全绿（实测 I1-g / I1-c 均 SURVIVED）。
  //    现在把断言收紧到**调用点必须长这样**：
  //      ① 第一个实参是 stat（打开后 fstat 的结果）
  //      ② 第二个实参是 linkStat（realpath 解析出的目标的 stat）
  //      ③ 必须处在 `if (! ... )` 的否定守卫里，且紧跟 `)` —— 不能被 && 短路
  // ⚠️ 终审复核修正（Minor，F-3）：**必须先剥掉注释再匹配** ——
  //    否则「代码改成 isSameFile(stat, stat) + 注释里写上正确形态」就能骗过这条断言，
  //    守卫永不触发却仍判绿（原正则匹配的是**未剥注释**的源码）。
  //    剥注释用共享工具 test-helpers/strip-comments.js（零依赖守卫同款）。
  const fnBody = stripComments(rawFnBody, { blankRegex: true });
  assert.match(
    fnBody,
    /if\s*\(\s*!isSameFile\(\s*stat\s*,\s*linkStat\s*\)\s*\)/,
    'serveStatic 必须在 if (!isSameFile(stat, linkStat)) 里做 dev/ino 对账 —— '
      + '对账对象写错（stat, stat）或被 && 短路，都等于这条 TOCTOU 防线失效',
  );
});

test('domainCode：领域码透传，Node 的 ERR_* 与非领域码一律回落（终审 I-C）', async () => {
  // ⛔ 终审修正（Important，I-C）：domainCode 此前是私有函数且**零断言** ——
  //    改成恒返回 'BAD_REQUEST' 全量测试照样全绿。
  //    而客户端 web/api.js 确实消费 data.error.code（用来分流错误），
  //    契约 INTERFACES.md「错误」纪律也明写「不外泄 Node 的 ERR_* 与 SQLite 原文」。
  const { domainCode } = await import('../src/server.js');
  // ⚠️ 回落值必须用**可区分**的字符串：用 'BAD_REQUEST' 的话，
  //    把「回落分支恒返回 'BAD_REQUEST'」这个变异完全掩盖掉
  //    （终审复核时踩过：第一次就用了 BAD_REQUEST → 变异存活）。
  const FALLBACK = 'FALLBACK_SENTINEL';

  // 领域码：原样透传
  assert.equal(domainCode({ code: 'CAPABILITY_UNKNOWN' }, FALLBACK), 'CAPABILITY_UNKNOWN');
  assert.equal(domainCode({ code: 'PHONE_TAKEN' }, FALLBACK), 'PHONE_TAKEN');
  assert.equal(domainCode({ code: 'PAYLOAD_TOO_LARGE' }, FALLBACK), 'PAYLOAD_TOO_LARGE');

  // Node 内置错误码：不得外泄
  assert.equal(domainCode({ code: 'ERR_INVALID_ARG_TYPE' }, FALLBACK), FALLBACK);
  assert.equal(domainCode({ code: 'ERR_SQLITE_ERROR' }, FALLBACK), FALLBACK);
  assert.equal(domainCode({ code: 'ERR_OUT_OF_RANGE' }, FALLBACK), FALLBACK);

  // 非领域码：不得外泄
  assert.equal(domainCode({ code: 'sqlite_error' }, FALLBACK), FALLBACK, '小写码不得外泄');
  assert.equal(domainCode({ code: '_PRIVATE' }, FALLBACK), FALLBACK, '下划线开头不得外泄');
  assert.equal(domainCode({ code: '9LIVES' }, FALLBACK), FALLBACK, '数字开头不得外泄');
  assert.equal(domainCode({ code: 'HAS-DASH' }, FALLBACK), FALLBACK, '带连字符不得外泄');
  assert.equal(domainCode({ code: 42 }, FALLBACK), FALLBACK, '非字符串不得外泄');
  assert.equal(domainCode({}, FALLBACK), FALLBACK, '缺 code 不得外泄');
  assert.equal(domainCode(null, FALLBACK), FALLBACK, 'null 不得外泄');
  assert.equal(domainCode(undefined, FALLBACK), FALLBACK, 'undefined 不得外泄');
  // 回落值本身必须被原样返回（变异「回落分支恒返回某个固定值」会被这条抓住）
  assert.equal(domainCode({ code: 'ERR_X' }, 'ANY_FALLBACK'), 'ANY_FALLBACK');
});

test('HTTP 层不把 Node 的 ERR_* 错误码外泄给客户端（端到端）', async () => {
  // ⚠️ 评审修正（Important）：500 分支已有逐字节断言，但 **4xx 分支**的 code 没有。
  //    这里注册一个**测试专用路由**，让它抛出「带 ERR_ 前缀 code 的 4xx 错误」
  //    （Node 内置错误被某个 handler 挂了 .status 的典型形态），
  //    断言响应体的 code 是通用回落码而不是 ERR_*。
  const { db, close, dataDir, app } = setup();
  app.router.add('GET', '/api/__test_throw_node_error', async () => {
    const e = new Error('内部细节：users.phone UNIQUE constraint failed');
    e.status = 400;
    e.code = 'ERR_SQLITE_ERROR';
    throw e;
  });
  const res = await call(app, 'GET', '/api/__test_throw_node_error');
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'BAD_REQUEST', `不得外泄 ERR_* 码，实际 ${body.error.code}`);
  assert.ok(!res.body.includes('ERR_'), `响应体不得出现 ERR_：${res.body}`);
  assert.ok(!res.body.includes('UNIQUE constraint'), `响应体不得出现 SQLite 原文：${res.body}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('4xx 响应的 message 必须是 AppError 自己的文案，而不是通用回落（终审复核 F-1）', async () => {
  // ⛔ 终审复核发现（Important，F-1）：I-C 的修复只钉住了「裸 Error 的 message 一律回落」，
  //    **没钉住「AppError 的 message 必须原样透传」这一半** ——
  //    把 `const message = err instanceof AppError ? err.message : '请求无效';`
  //    改成 `const message = '请求无效';` → 全量 150 条照样全绿。
  //    实测响应里的 message 从「手机号或密码不正确」退化成「请求无效」，
  //    而 web/api.js:15 正把它当界面文案直接显示 → 所有错误提示变成同一句废话，
  //    用户既不知道是「没填手机号」还是「密码错了」。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000000', password: 'wrong-password' },
  });
  assert.equal(res.status, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(
    body.error.message,
    '手机号或密码不正确',
    'AppError 的 message 必须原样透传给客户端（它是我们自己写的中文文案）',
  );
  assert.notEqual(body.error.message, '请求无效', '不得退化成通用文案 —— 那等于把用户能懂的信息抹掉');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('静态响应的 Content-Type 与 Cache-Control 必须符合 MIME 表（终审 M-6）', async () => {
  // ⚠️ 终审修正（Minor，M-6）：MIME 表与 Cache-Control 策略此前**零断言** ——
  //    把 MIME 表里的 '.js' 删掉（回落到 application/octet-stream）、
  //    或把 Cache-Control 恒写成 no-cache，全量照样全绿（实测 T3 / T4 均 SURVIVED）。
  //    而浏览器靠 Content-Type 决定要不要当脚本执行 —— 错了既是功能问题也是安全问题。
  const { db, close, dataDir, webRoot, app } = setup();
  writeFileSync(join(webRoot, 'web', 'app.js'), 'export const x = 1;\n');
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const html = await rawRequest(port, '/index.html');
    assert.match(html, /Content-Type:\s*text\/html; charset=utf-8/i, '.html 的 Content-Type 必须是 text/html');
    assert.match(html, /Cache-Control:\s*no-cache/i, '.html 必须 no-cache（入口页不能被缓存）');

    const js = await rawRequest(port, '/app.js');
    assert.match(js, /Content-Type:\s*text\/javascript; charset=utf-8/i, '.js 的 Content-Type 必须是 text/javascript');
    assert.match(js, /Cache-Control:\s*public, max-age=300/i, '.js 必须是 public, max-age=300');
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('请求体超限返回 413 且必须带 Connection: close（终审 M-6）', async () => {
  // ⚠️ 终审修正（Minor，M-6）：413 的 Connection: close 此前零断言 ——
  //    把它去掉，全量照样全绿（实测 V6 SURVIVED）。
  //    这条头是**连接卫生**：body 没读完时连接必须断开、不许复用
  //    （否则下一个请求可能读到上一个请求的残 body）。
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone: '13800000000', password: 'x'.repeat(600 * 1024) },
  });
  assert.equal(res.status, 413);
  assert.equal(res.headers.Connection, 'close', '413 必须带 Connection: close（连接不复用）');
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE', `413 的错误码必须是 PAYLOAD_TOO_LARGE，实际 ${body.error.code}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('软链的判定看真实路径：指向根外的被拒，指向根内的放行（终审 M-7）', { skip: process.platform === 'win32' ? 'Windows 创建符号链接需要开发者模式或管理员权限' : false }, async () => {
  // ⚠️ 终审修正（Minor，M-7）：static.js 的注释原先把「静态资源目录指向共享卷」
  //    写成了**正常部署形态**，但那条形态指向 web/ 根外 → 会被 realpath 防线挡下（404）。
  //    注释与实际行为相反 → 照着注释部署会踩坑。
  //    这里把**实际行为**钉死，注释才有依据：
  //      · 指向根外的软链（文件 / 目录）→ 404（fail-closed）
  //      · 指向根内的软链（文件 / 目录）→ 200
  //    并明确：共享卷部署要改用挂载（bind mount）或复制。
  const { db, close, dataDir, webRoot, app } = setup();
  const webDir = join(webRoot, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'assets', 'asset.js'), 'export const a = 1;\n');
  writeFileSync(join(webRoot, 'leak.txt'), 'SECRET-OUTSIDE-WEB\n');
  // 指向根内的软链（文件 / 目录）
  symlinkSync(join(webDir, 'index.html'), join(webDir, 'innerlink.html'));
  symlinkSync(join(webDir, 'assets'), join(webDir, 'assetslink'));
  // 指向根外的软链（文件 / 目录）
  symlinkSync(join(webRoot, 'leak.txt'), join(webDir, 'filelink.txt'));
  symlinkSync(webRoot, join(webDir, 'rootlink'));
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // 指向根内 → 放行
    const inner = await rawRequest(port, '/innerlink.html');
    assert.ok(inner.includes('200 OK'), `指向根内的软链文件应放行：${inner.slice(0, 80)}`);
    const innerDir = await rawRequest(port, '/assetslink/asset.js');
    assert.ok(innerDir.includes('200 OK'), `指向根内的软链目录应放行：${innerDir.slice(0, 80)}`);
    // 指向根外 → 拒绝
    for (const p of ['/filelink.txt', '/rootlink/leak.txt']) {
      const raw = await rawRequest(port, p);
      assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 指向根外，必须被拒：${raw.slice(0, 80)}`);
      assert.ok(!raw.includes('SECRET-OUTSIDE-WEB'), `${p} 泄露了 web 根外的内容`);
    }
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('304 分支必须关闭 fd，不能泄漏文件描述符（终审 M-2）', { skip: process.platform === 'win32' ? 'Windows 没有 /dev/fd，无法枚举进程打开的 fd' : false }, async () => {
  // ⛔ 终审修正（Minor，M-2）：原来那条用例的名字声称「不重复打开文件」，
  //    但**没有任何打开次数 / fd 断言** —— 把 304 分支的 closeSync(fd) 删掉，
  //    全量 144 条照样全绿（实测 I1-f SURVIVED）。
  //    这里用 /dev/fd 的条目数做**真实计数**：连打 N 次 304，fd 数不得增长。
  // ⚠️ 断言用「增长即失败」而不是「必须相等」：socket 关闭是异步的，
  //    偶发地多算一两个 fd 属于时序噪声；泄漏则是**线性增长**，两者不会混淆。
  const { db, close, dataDir, webRoot, app } = setup();
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const fdCount = () => readdirSync('/dev/fd').length;
  try {
    const first = await rawRequest(port, '/index.html');
    const m = first.match(/ETag:\s*(\S+)/i);
    assert.ok(m, '静态响应必须带 ETag');
    const etag = m[1];
    // 等第一次请求的读流彻底结束（autoClose 关 fd）+ socket 关掉
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = fdCount();
    for (let i = 0; i < 50; i += 1) {
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks = [];
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('超时')); });
        socket.on('connect', () => {
          socket.write(
            `GET /index.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nIf-None-Match: ${etag}\r\nConnection: close\r\n\r\n`,
          );
        });
        socket.on('data', (d) => chunks.push(d));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
      });
      assert.ok(raw.includes('304'), `第 ${i + 1} 次必须回 304：${raw.slice(0, 80)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = fdCount();
    assert.ok(after <= before, `304 分支泄漏了 fd：${before} → ${after}`);
  } finally {
    server.close();
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/server.test.js`
Expected: FAIL —— `Cannot find module '../src/server.js'`

- [ ] **Step 3: 创建 src/http/static.js**

```javascript
// src/http/static.js — 静态文件服务
// 依据：设计文档 §14.2。生产环境静态资源由 nginx 直出，这里是内网/本地兜底。
import { createReadStream, openSync, fstatSync, closeSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serveStatic(webDir, req, res) {
  const url = (req.url || '/').split('?')[0];
  let rel;
  try {
    rel = decodeURIComponent(url === '/' ? '/index.html' : url);
  } catch {
    // 畸形百分号编码 → 不当静态资源处理
    return false;
  }
  // ⛔ 预审修正（C7-1）：路径段里显式拒绝 '..'。
  //    必须在 decode **之后**判，否则 %2e%2e 能绕过。
  if (rel.split('/').some((seg) => seg === '..')) return false;

  // 防目录穿越（三重）：
  // ① rel 以 '/' 开头时用 '.' 前缀，resolve 不会把它当成绝对路径
  // ② 前缀比较必须带分隔符边界：'/x/web-secret'.startsWith('/x/web') 为真，
  //    只比前缀会把 web 的**兄弟目录**也放进来（预审实测 200 + 兄弟目录文件内容）
  const root = resolve(webDir);
  const relPath = rel.startsWith('/') ? rel : `/${rel}`;
  const target = resolve(root, `.${relPath}`);
  if (target !== root && !target.startsWith(root + sep)) return false;

  // ⛔ 终审修正（Important，I-1）：**符号链接逃逸**。
  //    上面的边界比较只作用于**路径字符串** —— resolve() 规范化路径但
  //    **不解析符号链接**。web/ 下一个指向根外的软链会让 web 根之外的文件被 HTTP 读走。
  //    终审实测：ln -s /etc web/etclink → GET /etclink/passwd → 200 + /etc/passwd 全文。
  //    这里把**根**与**目标**都解析成真实路径再比一次边界。
  //
  // ⚠️ 部署形态说明（终审 Minor M-7 订正 —— 原文写反了）：
  //    本防线是 **fail-closed** 的，判定看的是**软链解析后的真实路径**：
  //      · 指向 web/ **根外**的软链（文件或目录）→ 一律 404；
  //      · 指向 web/ **根内**的软链（文件或目录）→ 照常 200。
  //    「把 web/ 下的子目录软链到共享卷 / 外部资产目录」这种部署形态**不再可用**
  //    （它指向根外 → 被这条防线挡下），必须改用**挂载（bind mount）或复制**。
  //    原文把「静态资源目录指向共享卷」写成了正常部署形态，与实际行为相反。
  //
  // ⚠️ 穿越防线共三层（'..' 段拒绝 / 分隔符边界 / realpath 边界）：
  //    **目前只有 realpath 这一层被断言钉住** —— 另两层单独拆掉不会被测出来
  //    （三层同拆才会红）。三层都要留着：realpath 之前的路径规范化仍需自保。
  let realRoot;
  let realTarget;
  let linkStat;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
    linkStat = statSync(realTarget);
  } catch {
    // 目标不存在（404）或根不存在 → 不当静态资源处理
    return false;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return false;

  // ⚠️ **先打开再取元数据**，而不是 statSync 之后再 open：
  //    stat 与 open 之间存在 TOCTOU 窗口 —— 「热部署时先删掉整个 web 目录、
  //    再拷入新版本」正好落在这个窗口里，open 失败 → 读流抛出一个**无人监听的
  //    error 事件** → Node 视为未捕获异常 → **整个服务器进程退出**（评审实测
  //    退出码 1、客户端零响应）。
  //    用已经打开的 fd 就没有这个窗口了；打不开（权限不足 / 已删除）直接交给上层回 404。
  let fd;
  let stat;
  try {
    fd = openSync(target, 'r');
    stat = fstatSync(fd);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    closeSync(fd);
    return false;
  }
  // ⚠️ realpath → open 之间仍有一个窗口：软链可能被换成别的文件。
  //    用 dev/ino 对账堵住 —— 打开后的 inode 必须与 realpath 看到的一致。
  if (!isSameFile(stat, linkStat)) {
    closeSync(fd);
    return false;
  }

  const ext = extname(target).toLowerCase();
  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers && req.headers['if-none-match'] === etag) {
    // ⚠️ fd 已经在上面打开了 → 这里必须关掉，否则每次 304 都漏一个 fd
    closeSync(fd);
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  pipeFd(res, fd);
  return true;
}

/**
 * 判断两个 stat 是否指向**同一个文件**（dev + ino 对账）。
 *
 * ⛔ 终审修正（Important，I-1）：realpath 与 open 之间存在 TOCTOU 窗口 ——
 *    软链可能在两步之间被换成别的文件。用 dev/ino 对账把窗口堵上。
 *
 * 单独导出是为了能**直接测这条防线**：竞态本身无法稳定复现，
 *    但「两个不同的文件不得被判为同一个」可以钉死。
 *    （dev+ino 是 POSIX 的文件身份；跨平台稳定 —— Windows 下同样有 ino，
 *      拿不到时 dev/ino 相同仍会走同一条拒绝路径，不影响正确性。）
 */
export function isSameFile(statA, statB) {
  if (!statA || !statB) return false;
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

/**
 * 用已打开的 fd 建流并写回响应。
 *
 * ⚠️ autoClose 让 Node 自己关 fd（手动再关会撞 EBADF，
 *    而 EBADF 恰好就是「未监听的 error 事件」→ 进程死亡的一种形态）。
 *
 * ⛔ 评审修正（Important）：读流**必须挂 error 监听**。
 *    没有监听时，任何读错误（权限、瞬时 I/O 错误、fd 被外部关闭）都会变成
 *    **未捕获异常** → 整个服务器进程退出。此时响应头已经发出去了，
 *    只能断开连接 —— 但**绝不能**让它冒泡成进程级异常。
 *
 * 导出是为了能单独测这条 error 路径（用无效 fd 触发 EBADF）。
 */
export function pipeFd(res, fd) {
  const stream = createReadStream(null, { fd, autoClose: true });
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
  return stream;
}
```

- [ ] **Step 4: 创建 src/server.js**

```javascript
// src/server.js — 进程入口 + 可测的应用装配
// 溯源需求：R-OPS-06（演示模式挂载 /src/domain/* 与 /rules/*；⛔ 默认不挂 ⇒ 生产部署一律 404）
// 依据：设计文档 §4.1 / §14.1
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { openDatabase } from './db/sqlite.js';
import { applyMigrations } from './db/migrate.js';
import { loadRules, validateRules } from './config.js';
import { createRouter } from './http/router.js';
import { json, error, text } from './http/respond.js';
import { registerWorkflowRoutes } from './http/routes/workflow.js';
import { registerPoolsRoutes } from './http/routes/pools.js';
import { registerPublicRoutes } from './http/routes/public.js';
import { readJsonBody } from './http/body.js';
import { serveStatic } from './http/static.js';
import { parseSsePath, openSseStream, sendSseEvent, sendSseComment, reviewEvents } from './http/sse.js';
import { createSession, resolveSession, revokeSession } from './auth/session.js';
import { can } from './auth/permissions.js';
import { verifyPassword, hashPassword } from './auth/password.js';
import { getUserById, getCredentialsByPhone, toPublicUser } from './db/repo/users.js';
import { getStage, getStageJudge } from './db/repo/stages.js';
import { appError, AppError } from './errors.js';
import { registerRegistrationRoutes, pickCurrentEdition } from './http/routes/registration.js';
import { registerTaskPackageRoutes } from './http/routes/taskPackage.js';
import { registerTeamRoutes } from './http/routes/team.js';
import { registerReviewRoutes } from './http/routes/review.js';
import { registerMilestoneRoutes } from './http/routes/milestone.js';
import { registerBehaviorRoutes } from './http/routes/behavior.js';
import { registerAuditRoutes } from './http/routes/audit.js';
import { getLeaderboard, getRollingLeaderboard } from './services/leaderboard.js';
import { getPerformanceCard } from './services/performance-card.js';
import { getTeamTier, getTierBoard } from './services/tier.js';
import { listEditions, getEdition } from './db/repo/editions.js';
import { writePidFile, removePidFile } from './runtime/pidfile.js';

const here = dirname(fileURLToPath(import.meta.url));

// 演示模式的静态挂载：/src/domain/* 与 /rules/* 在 platform/ 下，不在 web/ 下。
// ⛔ 只读、只挂这两个白名单目录，不开放整个 platform/。
//
// ⚠️⛔ **默认不挂**（2026-10-21 漂移审计修正 I-5）：
//    这两个目录里是**领域层算法源码**（打分 / 破同分 / 防作弊判定）与**全部规则配置**
//    （权重表、破同分链、行为分、段位表）。无条件挂载 = 公网可读全部源码与配置。
//    本阶段正是「部署到公网 + nginx + systemd」的阶段，所以这道门必须有。
//    只有显式设了 DEMO_MODE=1 才挂；deploy/ 里的 systemd 与 docker-compose
//    **不得**设 DEMO_MODE=1（生产部署下这两个路径一律 404）。
const DEMO_MOUNTS = process.env.DEMO_MODE === '1' ? [
  { prefix: '/src/domain/', dir: join(here, '..', 'src', 'domain') },
  { prefix: '/rules/', dir: join(here, '..', 'rules') },
] : [];

function serveMounted(req, res) {
  if (!DEMO_MOUNTS.length) return false;
  for (const m of DEMO_MOUNTS) {
    if (!req.url || !req.url.startsWith(m.prefix)) continue;
    const rel = req.url.split('?')[0].slice(m.prefix.length);
    if (!rel) continue;
    // 浅拷贝一个只带 url/headers 的请求代理（serveStatic 只读这两个字段）
    const proxy = { url: `/${rel}`, headers: req.headers || {} };
    if (serveStatic(m.dir, proxy, res)) return true;
  }
  return false;
}

/**
 * ⛔ 评审修正（Important）：登录失败路径的**计时侧信道**。
 *
 * 原来写成 `!!cred && verifyPassword(...)` —— `!!cred` 短路 ⇒ **用户不存在时
 * 根本不跑 scrypt**。scrypt（N=16384）约需 20ms，评审实测
 * 「用户存在 20.18ms / 用户不存在 0.18ms」，**115 倍**差距 ——
 * 攻击者据此枚举手机号是否注册。
 * 规格 I7-1 要求「密码错 / 用户不存在一律 401、不区分二者、避免用户枚举」，
 * 响应层做到了，**时间层没做到** —— 安全目标只完成了一半。
 *
 * 做法：用户不存在时也拿一个**同参数**的哑元哈希跑一次 scrypt，
 * 让两条路径的耗时对齐。哑元哈希延迟生成（不必在模块加载时付这 20ms）。
 */
let dummyPasswordHash = null;
function dummyHash() {
  if (!dummyPasswordHash) dummyPasswordHash = hashPassword('dummy-password-for-constant-time-login');
  return dummyPasswordHash;
}

// 会话 Cookie（设计文档 §7.5）：HttpOnly + SameSite=Lax + Path=/ + Secure(生产)
function sessionCookie(token, maxAge, secure) {
  const parts = [
    `hk_session=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 畸形百分号编码（如 '%E0%A4%A'）会让 decodeURIComponent 抛 URIError。
 * router 内部已把这类段视为「不匹配」，这里再判一次是为了把
 * 「请求本身非法（400）」与「没这个接口（404）」区分开。
 */
function hasMalformedEncoding(path) {
  try {
    decodeURIComponent(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * 领域错误码：Node 内置错误的 .code（如 ERR_INVALID_ARG_TYPE）不是领域码，
 * 不能原样回给客户端 —— 那会暴露内部实现细节。
 *
 * ⚠️ 终审修正（Important，I-C）：本函数此前**零断言** ——
 *    改成恒返回 'BAD_REQUEST' 全量测试照样全绿。而客户端 `web/api.js`
 *    确实消费 `data.error.code`（用来分流错误），契约 INTERFACES.md「错误」纪律
 *    也明写「HTTP 层只把 .status / .code 转出去，**不外泄** Node 的 ERR_* 与 SQLite 原文」。
 *    导出是为了能直接测这条边界（与 static.js 的 isSameFile 同一手法）。
 */
export function domainCode(err, fallback) {
  const code = err && err.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) && !code.startsWith('ERR_')) {
    return code;
  }
  return fallback;
}

/**
 * 届期解析：显式传了 → 不存在就 404；没传 → 取【当届】（与 /api/registration-criteria 同一口径）。
 * ⚠️ 「当届」= 尚未结束（ends_at >= 今天）的最早一届，都没有就退回最后一届（pickCurrentEdition）。
 *    理由：榜单 / 段位榜都是「本届」视图，前端不必先查一遍届期再传进来。
 */
function resolveEditionId(db, editionId) {
  if (editionId) {
    if (!getEdition(db, editionId)) throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
    return editionId;
  }
  const edition = pickCurrentEdition(listEditions(db));
  if (!edition) throw new AppError(404, 'EDITION_NOT_FOUND', '尚无届期');
  return edition.id;
}

export function createApp({ db, rules, webDir }) {
  // ⛔ 评审修正（Important）：webDir 缺失必须在**构造期**就拒绝。
  //    原来它在第一个静态请求上才炸（serveStatic 在 try/catch 之外）→
  //    未捕获异常 → **整个进程退出**（评审实测退出码 1、客户端零响应）。
  //    这与项目原则「校验不过就拒绝启动，绝不降级为默认值」冲突。
  if (typeof webDir !== 'string' || webDir === '') {
    throw new Error('createApp 缺少 webDir（静态资源目录）');
  }
  // fail-fast：规则不合法直接拒绝启动
  const errors = validateRules(rules);
  if (errors.length) {
    throw new Error(`规则配置校验失败，拒绝启动：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const router = createRouter();
  // 注册 P1 报名端点（提交 / 查询 / 列表 / 改级 / 公开筛选标准）
  registerRegistrationRoutes({ router, db, rules });
  // 注册 P1 任务卡端点（提交 / 列表 / 六维评估 / 分级签约）
  registerTaskPackageRoutes({ router, db, rules });
  // 注册 P1 战队端点（建队 / 我的战队 / 成员增删汰换 / 战队修改）
  registerTeamRoutes({ router, db, rules });
  // P2 评审 API（报名/组队等 P1 路由由 P1 追加，不要互相覆盖）
  registerReviewRoutes(router);
  // P3 写入路由（企业里程碑签字 / 行为分事件）
  registerMilestoneRoutes(router);
  registerBehaviorRoutes(router);
  // 生产环境 Cookie 加 Secure；开发环境不加（http://127.0.0.1 会被浏览器拒收）
  //
  // ⚠️ COOKIE_SECURE 是**显式覆盖**（不设 = 跟随 NODE_ENV）：
  //    「纯 HTTP + 非标准端口」的对外面（复用既有主机、443 被占时）需要
  //    **既保持 NODE_ENV=production 的其它行为**、又让 Cookie 不带 Secure
  //    （否则浏览器直接拒收 ⇒ 登录失效）。
  //    ⛔ 不设这个变量时行为与以前**完全一致**（跟随 NODE_ENV）。
  //
  // ⚠️ 只有**显式的 'false'** 才关掉 Secure；其它取值（含拼错的 'flase'）
  //    一律按「要 Secure」处理 —— 失败即安全：
  //    拼错 ⇒ 浏览器拒收 Cookie ⇒ 登录失败（症状明显），
  //    而不是「静默把会话 Cookie 明文发出去」（症状不可见）。
  const secureCookies = process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE !== 'false'
    : process.env.NODE_ENV === 'production';

  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));
  // P4 审计 API（7 个接口 + 申诉列表）：计算快照 / 复算 diff / 审计日志 / 复核队列 / 申诉
  registerAuditRoutes(router, { db, rules });

  // ── P3 榜单与积分 ───────────────────────────────────────────
  // ⚠️ 路由优先级由 P0 的 router **逐段比较**决定：静态段胜参数段
  //    （P0 终审 C4-1 修的就是「比参数段个数」那个错版）。
  //    ⇒ '/api/leaderboard/rolling' 与 '/api/leaderboard/tier' 都不会被
  //    '/api/leaderboard/:stageId' 劫持。
  router.add('GET', '/api/leaderboard/rolling', async (ctx) => {
    const editionId = resolveEditionId(ctx.db, ctx.query.editionId);
    return getRollingLeaderboard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
  });
  // ⚠️ 静态段 'tier' 优先于参数段 ':stageId'（router 逐段比较：静态胜参数）
  router.add('GET', '/api/leaderboard/tier', async (ctx) => {
    const editionId = resolveEditionId(ctx.db, ctx.query.editionId);
    return getTierBoard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/leaderboard/:stageId', async (ctx) => {
    const scope = ctx.query.scope || 'rank';
    return getLeaderboard({ db: ctx.db, stageId: ctx.params.stageId, scope, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/teams/:id/performance-card', async (ctx) => {
    return getPerformanceCard({ db: ctx.db, teamId: ctx.params.id, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/teams/:id/tier', async (ctx) => {
    return getTeamTier({ db: ctx.db, teamId: ctx.params.id, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/me', async ({ user }) => {
    if (!user) {
      // ⛔ 终审修正（Important，I-5）：领域错误必须走 AppError。
      //    原来手搓 `new Error()` 再挂 .status/.code —— 运行时行为对，
      //    但 INTERFACES.md:21 定义了 AppError 是**唯一**的错误类型，
      //    P1–P6 的 handler 会照抄本文件 → 树起第二套错误类型，
      //    下游 `e instanceof AppError` 分支就再也进不去了。
      throw appError(401, 'UNAUTHENTICATED', '未登录');
    }
    return { user: toPublicUser(user) };
  });

  // ── P5 路由 ────────────────────────────────────────────────
  registerWorkflowRoutes(router, { db, rules });
  registerPoolsRoutes(router, { db, rules });
  registerPublicRoutes(router, { db, rules });

  // ⛔ 预审修正（I7-1）：P0 原本**没有登录接口** → README 宣称的「能登录的空系统」不成立，
  //    Task 5 产出的 createSession 也没有任何调用方。补上登录/登出。
  router.add('POST', '/api/auth/login', async ({ body }) => {
    const phone = String(body?.phone ?? '').trim();
    const password = String(body?.password ?? '');
    const cred = getCredentialsByPhone(db, phone);
    // 用户不存在与密码错误返回**同一个**错误码 → 避免用户枚举（响应层）
    // ⛔ 而且**耗时也必须一致**（时间层）：用户不存在时照样跑一次 scrypt，
    //    否则两条路径差 100 倍 → 枚举手机号。见 dummyHash() 的注释。
    const passwordOk = verifyPassword(password, cred ? cred.password_hash : dummyHash());
    const ok = !!cred && cred.active === 1 && passwordOk;
    if (!ok) {
      // ⛔ 终审修正（Important，I-5）：同上，必须走 AppError。
      throw appError(401, 'INVALID_CREDENTIALS', '手机号或密码不正确');
    }
    const { token, expiresAt } = createSession(db, cred.id);
    const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return {
      status: 200,
      body: { user: toPublicUser(getUserById(db, cred.id)) },
      headers: { 'Set-Cookie': sessionCookie(token, maxAge, secureCookies) },
    };
  });

  router.add('POST', '/api/auth/logout', async ({ sessionToken }) => {
    if (sessionToken) revokeSession(db, sessionToken);
    return {
      status: 200,
      body: { ok: true },
      headers: { 'Set-Cookie': sessionCookie('', 0, secureCookies) },
    };
  });

  async function handle(req, res) {
    // ⛔ 评审修正（Important）：`handle` 是 async，而 `http.createServer(app.handle)`
    //    **不会接管 rejected promise** → handler 里任何逸出的异常都变成未捕获异常
    //    → 整个服务器进程退出（客户端零响应）。
    //    最外层兜一层：任何异常都变成 500，绝不把进程带走。
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[server]', err);
      try {
        if (!res.headersSent) {
          json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
        } else {
          res.destroy();
        }
      } catch {
        // 连 500 都写不出去（连接已断）—— 只能放弃，不能再抛
      }
    }
  }

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.startsWith('/api/')) {
      try {
        // ⛔ 预审修正（C4-2）：router.match 必须**在 try 块内**。
        //    原来它在 try 之外 → 畸形百分号编码抛出的 URIError 越过 catch
        //    → Node 默认未捕获异常退出 → 整个服务器进程死亡。
        // ── P2：SSE（评审进度推送）────────────────────────────────
        // ⚠️ 必须**独立于 router**，且**在 router.match 之前**：
        //    P0 的 router handler 约定是「返回一个值 → server.js 统一 json() 序列化
        //    并结束响应」；SSE 要**长期持有这条连接**（多次推帧）——
        //    挂到 router 上会被 json() 提前收尾，客户端只收到第一帧就断。
        //    放在 router.match 之前还有第二个原因：SSE 路径**不在 router 里**，
        //    若先 match 会直接走 404 分支。
        const ssePath = req.method === 'GET' ? parseSsePath(url) : null;
        if (ssePath) {
          const sseToken = parseCookie(req.headers?.cookie || '')['hk_session'];
          const sseSession = sseToken ? resolveSession(db, sseToken) : null;
          const sseUser = sseSession ? getUserById(db, sseSession.userId) : null;
          if (!sseUser) {
            error(res, 401, 'UNAUTHENTICATED', '未登录');
            return;
          }
          // ⛔ 权限闸门（父代理预审修正）：**登录还不够**。
          //    进度事件流会暴露「谁在什么时候提交了评分」——
          //    任何登录用户都能订阅任意赛段 = 评委行踪可被任意账号看到。
          //    与 review-state 同一套口径：组委会 / 有 score:read 的人 / 本赛段评委。
          const sseStage = getStage(db, ssePath.stageId);
          const sseIsJudge = sseStage
            ? getStageJudge(db, ssePath.stageId, sseUser.id) != null
            : false;
          const sseAllowed = can(sseUser, 'score:read', { scopeType: 'stage', scopeId: ssePath.stageId }, db)
            || can(sseUser, 'score:read', { scopeType: 'global' }, db)
            || can(sseUser, 'stage:compute', { scopeType: 'stage', scopeId: ssePath.stageId }, db)
            || can(sseUser, 'stage:compute', { scopeType: 'global' }, db)
            || sseIsJudge;
          if (!sseAllowed) {
            error(res, 403, 'FORBIDDEN', '没有订阅评审进度的权限');
            return;
          }
          openSseStream(res);
          const topic = `stage:${ssePath.stageId}`;
          reviewEvents.add(res, topic);
          // ⛔ 客户端断开时必须摘掉订阅者 —— 否则连接泄漏，进程内存单调增长。
          //    同一处把心跳定时器也清掉（否则定时器会一直跑）。
          const heartbeat = setInterval(() => sendSseComment(res, 'ping'), 25000);
          if (typeof heartbeat.unref === 'function') heartbeat.unref();
          res.on('close', () => {
            clearInterval(heartbeat);
            reviewEvents.remove(res);
          });
          // 首帧必须给：EventSource 的 onopen 拿不到业务数据，客户端靠它确认订阅成功。
          sendSseEvent(res, 'connected', { stageId: ssePath.stageId, at: new Date().toISOString() });
          return;
        }
        const match = router.match(req.method, url);
        if (!match) {
          // 畸形 URL 编码 → 400（请求本身非法）；真没这个接口 → 404
          if (hasMalformedEncoding(url)) {
            error(res, 400, 'BAD_REQUEST', 'URL 编码非法');
            return;
          }
          error(res, 404, 'NOT_FOUND', `无此接口: ${req.method} ${url}`);
          return;
        }
        const sessionToken = parseCookie(req.headers?.cookie || '')['hk_session'];
        const session = sessionToken ? resolveSession(db, sessionToken) : null;
        // ⛔ 预审修正（C7-2）：resolveSession 返回 { userId, expiresAt }（契约 INTERFACES.md:67），
        //    原来读 session.user_id（undefined）→ node:sqlite 绑定 undefined 抛错 → 500。
        const user = session ? getUserById(db, session.userId) : null;
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
          ? await readJsonBody(req)
          : null;
        const ctx = {
          user,
          session,
          sessionToken,
          db,
          rules,
          params: match.params,
          body,
          query: Object.fromEntries(new URL(url, 'http://x').searchParams),
          can: (capability, c) => can(user, capability, c, db),
        };
        const result = await match.handler(ctx);
        // 原文响应（.ics 等）：P0 的 handler 统一 json() 序列化，这里走 text()
        if (result && typeof result === 'object' && result.__rawText === true) {
          text(res, 200, String(result.body ?? ''), result.contentType || 'text/plain; charset=utf-8');
          return;
        }
        // ⛔ 预审修正（I7-4）：handler 返回约定 ——
        //   undefined → 200（保持原行为）；{ status, body }（可选 headers）→ 按返回值应答。
        if (result && typeof result === 'object' && typeof result.status === 'number') {
          const { status, body: payload } = result;
          if (status === 204) {
            res.writeHead(204);
            res.end();
            return;
          }
          json(res, status, payload ?? null, result.headers || {});
          return;
        }
        json(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) {
          // ⛔ 预审修正（I7-3）：内部错误原文不外泄 ——
          //    SQLite 错误带表名列名，Node 错误带内部实现细节。只进日志。
          console.error('[server]', err);
          json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
          return;
        }
        const code = domainCode(err, 'BAD_REQUEST');
        // ⛔ 终审修正（Important，I-C 延伸）：**只透传领域错误（AppError）的 message**。
        //    AppError 的 message 是我们自己写的中文文案（"该手机号已注册"…），可以给用户看；
        //    而裸 Error / Node 内置错误 / SQLite 错误的 message 里含**内部原文**
        //    （表名列名、SQL 参数位置、文件路径）——
        //    契约 INTERFACES.md「错误」纪律明写「不外泄 Node 的 ERR_* 与 SQLite 原文」。
        //    实测（修复前）：handler 抛 `e.status=400; e.code='ERR_SQLITE_ERROR'` 时，
        //    响应体是 {"code":"BAD_REQUEST","message":"users.phone UNIQUE constraint failed"}
        //    —— code 挡住了，message 没挡住。
        const message = err instanceof AppError ? err.message : '请求无效';
        // ── P4 追加：限频要带 Retry-After，调用方才知道多久能重试（不静默丢包）──
        const extraHeaders = {};
        if (code === 'RATE_LIMITED' && err.detail?.retryAfterSeconds) {
          extraHeaders['Retry-After'] = String(err.detail.retryAfterSeconds);
        }
        if (status === 413) {
          // 请求体超限：连接已不可用 → 关掉，不复用
          json(res, 413, { error: { code, message } }, { Connection: 'close' });
          return;
        }
        // detail 同理：**只透传 AppError 的 detail** —— detail 可能含表名 / 列名
        //（问卷缺项说明是我们自己写的文案，可给前端看；裸 Error 的 detail 不行）。
        error(res, status, code, message, err instanceof AppError ? err.detail : undefined, extraHeaders);
      }
      return;
    }
    // ⛔ 评审修正（Important）：静态分支原来在 try/catch **之外** ——
    //    serveStatic 抛出的任何异常都会逸出 handle → 进程死亡。
    //    现在它在自己的 try 里；异常一律回 404，不影响进程。
    if (req.method === 'GET') {
      try {
        if (serveStatic(webDir, req, res)) return;
        // 演示模式（DEMO_MODE=1）：领域层与规则配置不在 web/ 下，挂出去。
        // ⚠️ serveStatic 的签名不变（webDir, req, res）——这里只换 webDir，不改它。
        if (serveMounted(req, res)) return;
      } catch (err) {
        console.error('[server] 静态服务异常', err);
      }
    }
    error(res, 404, 'NOT_FOUND', '页面不存在');
  }

  return { router, handle };
}

function parseCookie(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // ⛔ 预审修正（m7-2）：畸形编码不能抛 URIError —— 原样透传该 cookie 值
      value = raw;
    }
    out[name] = value;
  }
  return out;
}

// ── 进程启动 ────────────────────────────────────────────────
// ⚠️ 符号链接入口：Node 会把主入口 **realpath 化**，import.meta.url 是**真实路径**，
//    而 process.argv[1] 是**链接路径** → 字符串全等为假 → 服务器静默不启动、退出码 0
//    （评审实测：stdout 为空、exit 0、从未监听）。两边都 realpath 再比。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const port = Number(process.env.PORT || 8080);
  const webDir = join(here, '..', 'web');
  const migrationsDir = join(here, '..', 'db', 'migrations');
  const rulesDir = join(here, '..', 'rules');

  const { rules, version } = loadRules(rulesDir);
  const { db, close } = openDatabase({ dataDir });
  // ── P6：写 pid 文件 ──────────────────────────────────────────
  // 用途：让「恢复前必须先停服务」这条约束**可被机器检查**（scripts/restore.js 读它）。
  // 依据：设计文档 §14.2【决策】恢复前置约束。
  writePidFile(dataDir);
  // ────────────────────────────────────────────────────────────
  applyMigrations(db, migrationsDir);
  const app = createApp({ db, rules, webDir });

  const server = http.createServer(app.handle);
  // ⛔ 预审修正（m7-1）：显式绑 127.0.0.1（默认是 0.0.0.0，会暴露到局域网/公网），
  //    日志与实际绑定保持一致；云主机部署时再显式改成 '0.0.0.0'。
  server.listen(port, '127.0.0.1', () => {
    console.log(`heikesong-platform 启动于 http://127.0.0.1:${port}（规则版本 ${version}）`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => {
        // ── P6：退出前删 pid 文件（否则留下陈旧 pid）─────────────
        removePidFile(dataDir);
        // ────────────────────────────────────────────────────────
        close();
        process.exit(0);
      });
    });
  }
}
```

- [ ] **Step 5: 创建 scripts/seed.js**

> ⛔ **【2026-10-20 修复轮 3 / I-7】** 本 Step 原本在 `scripts/seed.js` 里**直接写裸 SQL**
> （`INSERT INTO capabilities` / `roles` / `role_capabilities` / `user_roles` 四条
> + `UPDATE users SET is_superadmin`），违反全局约束「**所有 SQL 收进 `src/db/repo/`**」。
> 而同一文件第 80 行的注释却写着「查重用仓储层（**不写裸 SQL**）」—— **注释与代码自相矛盾**。
> 修法：新建 `src/db/repo/capabilities.js` 与 `src/db/repo/roles.js`，
> `seed.js` 改为调用仓储层；`setSuperadmin` 作为**纯新增**放进 `src/db/repo/users.js`。

`platform/src/db/repo/capabilities.js`：

```javascript
// src/db/repo/capabilities.js — 能力点仓储
// 依据：设计文档 §7.1（capabilities / role_capabilities 表）+ 全局约束「所有 SQL 收进 src/db/repo/」。
//
// ⛔ 评审修正（I-7）：scripts/seed.js 原来直接
//    db.prepare('INSERT OR IGNORE INTO capabilities (key, description) VALUES (?, ?)')
//    db.prepare('INSERT OR IGNORE INTO role_capabilities (role_id, capability) VALUES (?, ?)')
//    —— 越过 SQL 边界（handler / 脚本里禁止裸 SQL），与同文件第 80 行
//    「查重用仓储层（不写裸 SQL）」的注释自相矛盾。这里把两条 SQL 下沉到仓储层。
//
// ⚠️ role_capabilities.role_id 存的是**角色键**（schema: role_id TEXT REFERENCES roles(key)），
//    不是 roles.id —— 表里 roles 的主键就叫 key（001_init.sql）。
//    沿用 seed.js 原写法，不改语义。
export function insertCapability(db, key, description) {
  db.prepare('INSERT OR IGNORE INTO capabilities (key, description) VALUES (?, ?)').run(key, description);
}

/** 授予角色一个能力点（幂等：重复写入被 INSERT OR IGNORE 吞掉）。 */
export function insertRoleCapability(db, roleKey, capability) {
  db.prepare('INSERT OR IGNORE INTO role_capabilities (role_id, capability) VALUES (?, ?)').run(
    roleKey,
    capability,
  );
}
```

`platform/src/db/repo/roles.js`：

```javascript
// src/db/repo/roles.js — 角色仓储
// 依据：设计文档 §7.1（roles / user_roles 表）+ 全局约束「所有 SQL 收进 src/db/repo/」。
//
// ⛔ 评审修正（I-7）：scripts/seed.js 原来直接
//    db.prepare('INSERT OR IGNORE INTO roles (key, description) VALUES (?, ?)')
//    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, 'admin')")
//    —— 越过 SQL 边界（handler / 脚本里禁止裸 SQL）。这里把两条 SQL 下沉到仓储层。
//
// ⚠️ user_roles.role_key 存的是**角色键**（schema: role_key TEXT REFERENCES roles(key)），
//    与 roles.key 是同一个键值域（001_init.sql）。
export function insertRole(db, key, description) {
  db.prepare('INSERT OR IGNORE INTO roles (key, description) VALUES (?, ?)').run(key, description);
}

/** 给用户绑角色（幂等：重复绑定被 INSERT OR IGNORE 吞掉）。 */
export function insertUserRole(db, userId, roleKey) {
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, ?)').run(userId, roleKey);
}
```

`platform/scripts/seed.js`：

```javascript
// scripts/seed.js — 种子数据：能力点、角色、角色能力映射、初始管理员
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser, findUserByPhone, setSuperadmin } from '../src/db/repo/users.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

// ⛔ 预审修正（I7-2）：管理员口令**不兜底**。
//    原来写 `process.env.ADMIN_PASSWORD || 'change-me-now'` —— 一个写死在代码里的
//    公开口令当组委会超管口令（预审实测已打印出来）。P6 之后这套脚本要跑在公网机器上，
//    与项目原则「校验不过就拒绝启动，绝不降级为默认值」直接冲突。
//    没有 ADMIN_PASSWORD → 明确报错 + 退出码 1，**不创建任何账号**。
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  console.error('缺少环境变量 ADMIN_PASSWORD，拒绝创建管理员账号（不提供默认口令）。');
  console.error("用法：ADMIN_PASSWORD='你的密码' node scripts/seed.js");
  process.exit(1);
}

const CAPABILITIES = [
  ['registration:write', '提交报名'],
  ['registration:review', '审核报名分级'],
  ['team:create', '创建战队'],
  ['team:read', '读取战队'],
  ['team:manage', '管理战队成员'],
  ['task_package:read', '读取任务卡'],
  ['task_package:write', '提交/编辑任务卡'],
  ['task_package:approve', '任务卡分级签约'],
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['peer_review:write', '互评'],
  ['signoff:create', '企业里程碑签字'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['pool:read', '读取三池'],
  ['pool:write', '维护三池'],
];

const ROLES = [
  ['admin', '组委会'],
  ['captain', '队长'],
  ['member', '组员'],
  ['judge', '评委席'],
  ['enterprise', '企业席'],
  ['observer', '观察员（无投票权）'],
  ['enterprise_admin', '企业管理员'],
];

const ROLE_CAPABILITIES = [
  ['admin', 'registration:review'], ['admin', 'team:read'], ['admin', 'team:manage'],
  ['admin', 'task_package:read'], ['admin', 'task_package:approve'], ['admin', 'score:read'],
  ['admin', 'stage:compute'], ['admin', 'audit:read'], ['admin', 'pool:read'], ['admin', 'pool:write'],
  ['captain', 'registration:write'], ['captain', 'team:create'], ['captain', 'team:read'],
  ['captain', 'team:manage'], ['captain', 'pool:read'],
  ['member', 'registration:write'], ['member', 'team:read'], ['member', 'pool:read'],
  ['judge', 'score:write'], ['judge', 'score:read'], ['judge', 'peer_review:write'], ['judge', 'task_package:read'],
  ['enterprise', 'score:write'], ['enterprise', 'score:read'], ['enterprise', 'signoff:create'],
  ['enterprise', 'task_package:read'], ['enterprise', 'task_package:write'], ['enterprise', 'pool:read'],
  ['observer', 'score:read'], ['observer', 'team:read'], ['observer', 'task_package:read'],
  ['enterprise_admin', 'task_package:write'], ['enterprise_admin', 'signoff:create'], ['enterprise_admin', 'pool:read'],
];

const { db, close } = openDatabase({ dataDir });
try {
  applyMigrations(db, join(here, '..', 'db', 'migrations'));

  // ⛔ 评审修正（I-7）：种子数据写入一律走仓储层 ——
  //    本文件**不再出现任何 SQL 字符串**（全局约束「所有 SQL 收进 src/db/repo/」）。
  for (const [key, description] of CAPABILITIES) insertCapability(db, key, description);

  for (const [key, description] of ROLES) insertRole(db, key, description);

  for (const [role, cap] of ROLE_CAPABILITIES) insertRoleCapability(db, role, cap);

  const adminPhone = process.env.ADMIN_PHONE || '13800000000';
  // 查重走仓储层（findUserByPhone 取的行里不含 password_hash）
  // ⛔ 评审修正（I-7）：这条注释原来写「不写裸 SQL」，**却和同一文件里的裸 SQL 自相矛盾**
  //    —— 现在本文件确实一条 SQL 字符串都没有了：种子写入全部下沉到 src/db/repo/。
  let admin = findUserByPhone(db, adminPhone);
  if (!admin) {
    admin = createUser(db, {
      name: '组委会管理员', phone: adminPhone, password: adminPassword, mbaStatus: 'mba',
    });
    setSuperadmin(db, admin.id);
    insertUserRole(db, admin.id, 'admin');
    // 只打印账号，不回显口令
    console.log(`已创建管理员：${adminPhone}  ← 请立即修改密码`);
  } else {
    console.log(`管理员已存在：${adminPhone}`);
  }
  console.log(`种子完成：${CAPABILITIES.length} 个能力点，${ROLES.length} 个角色，${ROLE_CAPABILITIES.length} 条角色能力映射`);
} finally {
  close();
}
```

- [ ] **Step 6: 创建前端骨架**

> ⛔ **【2026-10-20 修复轮 3 / I-2】** 原本 `web/app.js` 把**服务端返回的数据**
> （`user.name`、错误消息）原样插进 `innerHTML` —— innerHTML 会把 `<img onerror=...>`
> 当**标记**解析，服务端数据里带 HTML 就是存储型 XSS。
> P0 的 `name` 只由 seed 写入（不可远程利用），但 **P1 的报名端点让用户自选 name**
> → 立刻变成可远程利用。同项目 `web/views/login.js` 用的是 `err.textContent`（安全），
> 说明作者知道要转义，只是 `app.js` 两处漏了。
> 修法：新建 `web/escape.js` 提供 `escapeHtml()`，`app.js` 的两处插值全部走它。

`platform/web/escape.js`：

```javascript
// web/escape.js — HTML 文本转义
// 依据：设计文档 §14.2（前端零构建、无框架）与安全要求。
//
// ⛔ 终审修正（Important，I-2）：前端把**服务端返回的数据**插进 innerHTML，
//    而 innerHTML 会把 `<img onerror=...>` 这类字符串当**标记**解析 ——
//    服务端数据里带 HTML 就等于存储型 XSS。
//    P0 的 user.name 只由 seed 写入（不可远程利用），但 P1 的「报名」端点
//    让用户自选 name → 立刻变成可远程利用。
//    同项目 web/views/login.js 用的是 err.textContent（安全）—— 说明作者知道
//    要转义，只是 app.js 两处漏了。这里把转义收成一个工具，所有插值统一走它。
//
// ⚠️ 只转义**文本节点**里的插值。属性值（href/src）不能只靠这个函数，
//    因为 `javascript:` 协议不靠 HTML 转义拦得住 —— 那种地方要用属性白名单。
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

`platform/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI 商业黑客松 · 赛事平台</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="app"><div class="boot">正在加载…</div></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

`platform/web/router.js`：

```javascript
// web/router.js — 哈希路由
const routes = [];

export function route(pattern, view) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ regex: new RegExp(`^${source}/?$`), names, view, pattern });
}

export function match(path) {
  const clean = (path || '').split('?')[0];
  for (const r of routes) {
    const hit = r.regex.exec(clean);
    if (!hit) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(hit[i + 1]); });
    return { view: r.view, params, pattern: r.pattern };
  }
  return null;
}

export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}
```

`platform/web/store.js`：

```javascript
// web/store.js — 极简响应式 store
const state = {};
const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(getState());
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
```

`platform/web/api.js`：

```javascript
// web/api.js — 真实 API 客户端
// ⛔ 演示版用 api.demo.js 替换本模块，视图代码完全复用。
const BASE = '';

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败 ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  subscribe(path, onMessage) {
    // SSE：单向推送，走普通 HTTP，穿透代理容易，EventSource 自带断线重连
    // ⚠️ SSE 端点在 **P2** 才实现（src/http/sse.js）—— P0/P1 调用会 404，不要在 P0/P1 用。
    const es = new EventSource(BASE + path);
    es.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { onMessage(e.data); }
    };
    return () => es.close();
  },
};
```

`platform/web/api.demo.js`：

```javascript
// web/api.demo.js — 演示版适配器（浏览器内 localStorage）
// ⛔ 数据不跨人共享。这是当前无云主机条件下的客观边界。
// ✅ 但规则引擎在浏览器里真实运行，演示出来的算法行为与正式系统一致。
const KEY = 'hks_demo_db';

function load() {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify({}));
  return JSON.parse(localStorage.getItem(KEY));
}
function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

export const api = {
  async get(path) {
    const db = load();
    if (path === '/api/health') return { ok: true, demo: true };
    if (path === '/api/me') {
      return db.me ? { user: db.me } : (() => { throw Object.assign(new Error('未登录'), { status: 401 }); })();
    }
    if (path.startsWith('/api/leaderboard')) {
      return { rows: db.leaderboard || [], demo: true };
    }
    throw Object.assign(new Error(`演示版未实现该接口：${path}`), { status: 404 });
  },
  async post(path, body) {
    const db = load();
    if (path === '/api/auth/login') {
      db.me = { id: 'demo_admin', name: body?.name || '演示管理员', mbaStatus: 'mba', org: '演示' };
      save(db);
      return { user: db.me };
    }
    if (path === '/api/auth/logout') { db.me = null; save(db); return { ok: true }; }
    throw Object.assign(new Error(`演示版未实现该接口：${path}`), { status: 404 });
  },
  async patch() { throw Object.assign(new Error('演示版不支持写操作'), { status: 404 }); },
  async del() { throw Object.assign(new Error('演示版不支持写操作'), { status: 404 }); },
  subscribe() { return () => {}; },
};
```

`platform/web/views/login.js`：

```javascript
// web/views/login.js — 登录视图
//
// ⚠️ 本轮（P6 第 12 轮）新增 `readLoginForm` / `validateLoginInput` 两个**纯函数**：
//   真机实测抓到：浏览器发出的请求里 **`phone` 是空字符串**（口令却完全正确），
//   而后端对「手机号为空」和「口令错误」返回**同一个** 401 `INVALID_CREDENTIALS`
//   ⇒ 访客看到的是「手机号或密码不正确」，**完全指错方向** —— 真因是手机号没输入。
//   ⇒ 本地先校验、**不发无谓请求**、并把提示说清楚。
//
// 纪律：输入校验的判据必须**可测**（纯函数导出），不能只写在 DOM 事件里。
export function readLoginForm({ phone = '', password = '' } = {}) {
  return {
    phone: String(phone ?? '').trim(),
    password: String(password ?? ''),
  };
}

/**
 * 登录输入的本地校验。
 * @param {{ phone: string, password: string }} input
 * @param {{ isDemo?: boolean }} [opts] `isDemo` = 演示站（适配器不校验凭据）
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateLoginInput({ phone, password }, { isDemo = false } = {}) {
  if (!phone) {
    return { ok: false, message: '请输入手机号（上面的 13800000000 是示例占位，不是已填内容）' };
  }
  // ⚠️ **演示站不校验手机号格式**：它的适配器根本不校验凭据（填什么都给演示管理员）
  //    ⇒ 强制 11 位格式会把「随便看看」变成填表 ⇒ 破坏演示体验。
  //    真实平台才要求 11 位、以 1 开头的数字。
  if (!isDemo && !/^1\d{10}$/.test(phone)) {
    return { ok: false, message: '手机号格式不对：应为 11 位、以 1 开头的数字' };
  }
  if (!password) {
    return { ok: false, message: '请输入密码' };
  }
  return { ok: true };
}

export function renderLogin(ctx) {
  const { api, navigate } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'card login';
  wrap.innerHTML = `
    <h1>AI 商业黑客松 · 赛事平台</h1>
    <p class="muted">用报名手机号登录</p>
    <label>手机号<input id="phone" autocomplete="username" placeholder="13800000000" /></label>
    <label>密码<input id="password" type="password" autocomplete="current-password" /></label>
    <button id="submit">登录</button>
    <p id="err" class="err"></p>
  `;
  const err = wrap.querySelector('#err');
  wrap.querySelector('#submit').addEventListener('click', async () => {
    err.textContent = '';
    const form = readLoginForm({
      phone: wrap.querySelector('#phone').value,
      password: wrap.querySelector('#password').value,
    });
    // ⛔ 本地先校验：手机号为空时**不发请求** ——
    //    否则后端会回「手机号或密码不正确」，把「没填手机号」误报成「口令错」。
    const check = validateLoginInput(form, { isDemo: !!ctx.api?.isDemo });
    if (!check.ok) {
      err.textContent = check.message;
      return;
    }
    try {
      const res = await api.post('/api/auth/login', { phone: form.phone, password: form.password });
      ctx.setState({ user: res.user });
      navigate('/');
    } catch (e) {
      err.textContent = e.message;
    }
  });
  return wrap;
}
```

`platform/web/app.js`：

```javascript
// web/app.js — 前端入口
// 溯源需求：R-OPS-06（?demo=1 走演示版适配器；正式版走真实 API）
import { route, match, navigate, currentPath } from './router.js';
import { getState, setState, subscribe } from './store.js';
import { renderLogin } from './views/login.js';
import { renderRegistration } from './views/registration.js';
import { renderTeam } from './views/team.js';
import { renderAdminRegistration } from './views/admin-registration.js';
import { renderLeaderboard } from './views/leaderboard.js';
import { renderTier } from './views/tier.js';
import { renderCard } from './views/card.js';
import { renderAudit } from './views/audit.js';
import { renderFlags } from './views/flags.js';
import { renderTasks } from './views/tasks.js';
import { escapeHtml } from './escape.js';

// 演示版：?demo=1 时用 localStorage 适配器；正式版走真实 API。
// ⚠️ 演示版的规则引擎在浏览器里真实运行（web/api.demo.js 直接 import ../src/domain/*.js），
//    所以「演示好看、正式不一样」这件事不会发生。
const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
const { api } = isDemo ? await import('./api.demo.js') : await import('./api.js');
// ⚠️ 把「当前是不是演示模式」挂到 api 上 ⇒ 视图能据此调整**输入校验**。
//    真实理由（P6 第 12 轮）：登录视图新增了「手机号格式」本地校验
//    （真实平台的手机号必须 11 位、以 1 开头），但**演示站的适配器不校验凭据**
//    （填什么都直接给一个演示管理员）⇒ 演示站访客若被要求填 11 位手机号，
//    就把「随便看看」的演示变成了填表 ⇒ **演示体验被破坏**。
// ⇒ 视图里的校验按 `ctx.api.isDemo` 分档：演示站只要求「非空」，真实平台才校验格式。
api.isDemo = isDemo;

route('/', () => renderHome());
route('/login', () => renderLogin(ctx));
route('/logout', () => renderLogout());
// P1 三页：报名 / 我的战队 / 组委会筛选台
route('/apply', () => renderRegistration(ctx));
route('/team', () => renderTeam(ctx));
route('/admin/registration', () => renderAdminRegistration(ctx));
// P3 三页：榜单（A 榜 / B 榜 / 个人榜 + 滚动总榜）/ 段位榜 / 战绩卡
// ⚠️ 前端路由是**注册顺序**先匹配（不像服务端 router 那样排序），
//    但 '/leaderboard' 与 '/leaderboard/:stageId' 的正则互斥，顺序不影响结果。
route('/leaderboard', (c) => renderLeaderboard(c));
route('/leaderboard/:stageId', (c) => renderLeaderboard(c));
route('/tier', (c) => renderTier(c));
route('/card/:teamId', (c) => renderCard(c));
// P4 两页：计算留痕 trace 抽屉（从发榜页点队伍进入）/ 复核队列
// ⚠️ 必须透传路由参数（c = {...ctx, params, query}）：trace 抽屉靠 params.computationId
//    决定拉哪份快照 —— 只传模块级 ctx 会把 params 丢掉，抽屉永远拿不到 computationId。
route('/audit/:computationId', (c) => renderAudit(c));
route('/flags', (c) => renderFlags(c));
// P5 Task 6：任务清单页（只有「自主领取」一个入口，R-OPS-14 禁止岗位制）
route('/tasks/:workflowId', (c) => renderTasks(c));

function renderHome() {
  const el = document.createElement('div');
  el.className = 'card';
  const { user } = getState();
  el.innerHTML = `
    <h1>赛事平台</h1>
    ${user ? `<p>已登录：${escapeHtml(user.name)}</p>` : '<p class="muted">未登录</p>'}
    <nav>
      <a href="#/login">登录</a>
      <a href="#/leaderboard">榜单</a>
      <a href="#/flags">复核队列</a>
      <a href="#/apply">报名</a>
      <a href="#/team">我的战队</a>
      <a href="#/admin/registration">筛选台</a>
    </nav>
  `;
  return el;
}

function renderLogout() {
  api.post('/api/auth/logout').finally(() => {
    setState({ user: null });
    navigate('/login');
  });
  return document.createElement('div');
}

const ctx = { api, navigate, setState, getState };

/**
 * ⛔ 评审修正（Important）：启动时**先恢复会话**。
 * 原来前端从不调 `/api/me` → 登录之后刷新页面（F5）显示「未登录」，
 * 而 Cookie 其实还有效、接口也还能用 —— 用户被无端踢回登录页。
 * 会话在服务端，状态在前端：两边必须有一次对齐。
 */
async function restoreSession() {
  try {
    const { user } = await api.get('/api/me');
    setState({ user });
  } catch {
    // 401（未登录 / 会话过期）是正常情况，不是错误
    setState({ user: null });
  }
}

/** 当前 hash 上的 query（router.match 会把 '?xxx' 剥掉再匹配，所以要自己解析） */
function currentQuery() {
  const q = currentPath().split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

function demoBanner() {
  if (!isDemo) return null;
  const el = document.createElement('div');
  el.className = 'card demo-banner';
  el.innerHTML = `
    <strong>演示版</strong>：当前是公网演示站——所有数据只存在你的浏览器里（不跨人共享），
    但<b>规则引擎是在你的浏览器里真实运行的</b>（z-score 归一化 / 去极值 / 双签 / 破同分链 / 段位判定），
    算法行为与正式系统一致。
  `;
  return el;
}

async function render() {
  const app = document.getElementById('app');
  const banner = demoBanner();
  const found = match(currentPath());
  if (!found) {
    app.innerHTML = '<div class="card">页面不存在</div>';
    if (banner) app.prepend(banner);
    return;
  }
  try {
    // ⚠️ 路由参数与 query 必须透传给视图：P3 的视图要靠 params.stageId / params.teamId
    //    决定请求哪个赛段 / 哪支队伍，靠 query.scope / query.editionId 决定口径与届期。
    //    P0 原来只传 ctx —— 视图拿不到参数（前端 router.match 会把 '?query' 剥掉再匹配）。
    const el = await found.view({ ...ctx, params: found.params, query: currentQuery() });
    app.replaceChildren(el);
    if (banner) app.prepend(banner);
  } catch (e) {
    app.innerHTML = `<div class="card err">${escapeHtml(e.message)}</div>`;
    if (banner) app.prepend(banner);
  }
}

window.addEventListener('hashchange', render);
subscribe(() => render());
// ⛔ 先恢复会话再首屏渲染 —— 否则首屏永远显示「未登录」
await restoreSession();
render();
```

`platform/web/styles.css`：

```css
/* web/styles.css — 基础样式 */
:root {
  --bg: #0f1115;
  --card: #171a21;
  --fg: #e8eaed;
  --muted: #9aa0a6;
  --accent: #4c8dff;
  --err: #ff6b6b;
  --line: #262a33;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
#app { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: 12px; padding: 24px; margin-bottom: 16px;
}
h1 { font-size: 22px; margin: 0 0 12px; }
.muted { color: var(--muted); }
.err { color: var(--err); }
label { display: block; margin: 12px 0; }
input {
  display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
  background: #0e1016; color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px; font-size: 15px;
}
button {
  margin-top: 16px; padding: 10px 18px; border: 0; border-radius: 8px;
  background: var(--accent); color: #fff; font-size: 15px; cursor: pointer;
}
button:hover { filter: brightness(1.08); }
nav a { color: var(--accent); margin-right: 16px; }
.boot { color: var(--muted); padding: 40px; text-align: center; }
```

- [ ] **Step 7: 补两个测试文件（种子脚本 + 前端骨架）**

> ⛔ **【2026-10-20 修复轮 3 / I-7】** 全局约束「**SQL 边界：所有 SQL 收进 `src/db/repo/`**」
> 此前**没有任何断言钉住** —— 往 `scripts/seed.js` 加一行 `db.prepare('SELECT 1 FROM users')`
> 全量测试照样全绿。本 Step 补一条**扫描式**断言把这条约束钉死。

`platform/test/sql-boundary.test.js`：

```javascript
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
```

`platform/test/seed.test.js`：

```javascript
// platform/test/seed.test.js —— 种子脚本的安全行为
//
// 规则溯源：
//   - 「不兜底默认口令，校验不过就拒绝启动」→ 设计文档 §2「校验不过就拒绝启动」
//     与 Task 7 预审修正 I7-2（种子脚本用硬编码默认口令创建超管 → 公网机器上
//     等于把组委会超管口令写在代码里）。
//   - 凭据类信息不入库 → 全局约束「证据链 / 凭据」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/db/sqlite.js';
import { verifyPassword } from '../src/auth/password.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const seedPath = join(platformDir, 'scripts', 'seed.js');

function runSeed(env) {
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', seedPath],
    { cwd: platformDir, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 },
  );
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

test('没有 ADMIN_PASSWORD 时种子脚本拒绝运行：不建库、不建账号、不回显任何口令', () => {
  // ⚠️ 评审修正（Important）：原来**根本没有 seed 的测试文件** ——
  //    变异「恢复 `|| 'change-me-now'` 默认口令兜底」时全量 79/79 仍绿。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  const res = runSeed({ DATA_DIR: dataDir, ADMIN_PASSWORD: '' });
  assert.notEqual(res.status, 0, '必须以非 0 退出码退出');
  assert.match(res.out, /ADMIN_PASSWORD/, '报错必须点名缺少的环境变量');
  assert.equal(existsSync(join(dataDir, 'app.db')), false, '连数据库文件都不该创建');
  assert.equal(/change-me-now/.test(res.out), false, '输出里不能出现任何默认口令');
  rmSync(dataDir, { recursive: true, force: true });
});

test('给了 ADMIN_PASSWORD 时种子能建成超管，且口令哈希只能由这个口令验开', () => {
  // 这条同时钉住两件事：① 种子确实建成账号；② 账号口令**就是**环境变量里给的那个，
  //    不是代码里写死的另一个（默认口令兜底的回归会在这里露出来）。
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-ok-'));
  const password = 'Str0ng-Pass!2026';
  const res = runSeed({ DATA_DIR: dataDir, ADMIN_PASSWORD: password });
  assert.equal(res.status, 0, `种子应成功，输出：${res.out.slice(0, 200)}`);
  assert.equal(existsSync(join(dataDir, 'app.db')), true, '数据库应被创建');
  assert.equal(res.out.includes(password), false, '输出里不能回显口令本身');

  const { db, close } = openDatabase({ dataDir });
  try {
    const row = db.prepare('SELECT password_hash, is_superadmin FROM users LIMIT 1').get();
    assert.ok(row, '应建出超管账号');
    assert.equal(row.is_superadmin, 1, '建出来的应是超管');
    assert.equal(verifyPassword(password, row.password_hash), true, '口令必须来自 ADMIN_PASSWORD');
    assert.equal(verifyPassword('change-me-now', row.password_hash), false, '不能是写死的默认口令');
  } finally {
    close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});
```

`platform/test/web.test.js`：

```javascript
// platform/test/web.test.js —— 前端骨架的行为
//
// 规则溯源：
//   - 「登录后刷新页面仍应是登录态」→ 设计文档 §8（会话在服务端，Cookie 承载）；
//     Task 7 评审修正 F-5b：前端从不调 /api/me → 登录后 F5 显示「未登录」，
//     而 Cookie 其实还有效、接口也还能用。
//   - 原生 ESM、无构建 → 前端模块可以被 Node 直接 import（配合最小 DOM 桩）。
//
// ⚠️ 用 `?v=N` 制造不同的模块实例 —— ESM 模块默认只求值一次，
//    而这里需要用不同的 fetch 行为各跑一次「启动」。
import test from 'node:test';
import assert from 'node:assert/strict';

function installDom() {
  const state = { rendered: null, calls: [] };
  const fakeEl = () => ({
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    querySelector: () => ({ addEventListener: () => {}, textContent: '', value: '' }),
    addEventListener: () => {},
    replaceChildren: (el) => { state.rendered = el; },
  });
  globalThis.window = {
    location: { search: '', hash: '' },
    addEventListener: () => {},
  };
  globalThis.document = {
    getElementById: () => fakeEl(),
    createElement: () => fakeEl(),
  };
  return state;
}

async function bootApp({ meStatus, meBody, tag }) {
  const state = installDom();
  state.calls = [];
  globalThis.fetch = async (url) => {
    state.calls.push(url);
    if (url === '/api/me') {
      return {
        ok: meStatus < 400,
        status: meStatus,
        text: async () => JSON.stringify(meBody),
      };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  // ?v=tag → 每个用例一个独立的模块实例（否则 ESM 只求值一次）
  await import(`../web/app.js?v=${tag}`);
  // 让顶层的 await 与首屏渲染落地
  await new Promise((r) => setTimeout(r, 20));
  return state;
}

test('启动时先恢复会话：/api/me 成功 → 首屏显示已登录', async () => {
  const state = await bootApp({
    meStatus: 200,
    meBody: { user: { id: 'u_1', name: '甲', phone: '13800000000' } },
    tag: 'ok',
  });
  assert.ok(
    state.calls.includes('/api/me'),
    `启动时必须调 /api/me 恢复会话，实际请求：${JSON.stringify(state.calls)}`,
  );
  assert.ok(state.rendered, '首屏应被渲染');
  assert.match(state.rendered.innerHTML, /已登录/, '首屏应显示已登录');
  assert.match(state.rendered.innerHTML, /甲/, '首屏应显示当前用户');
});

test('启动时 /api/me 返回 401 → 首屏显示未登录，且不抛异常', async () => {
  const state = await bootApp({
    meStatus: 401,
    meBody: { error: { code: 'UNAUTHENTICATED', message: '未登录' } },
    tag: '401',
  });
  assert.ok(state.calls.includes('/api/me'), '启动时必须尝试恢复会话');
  assert.ok(state.rendered, '首屏应被渲染');
  assert.match(state.rendered.innerHTML, /未登录/, '首屏应显示未登录');
});

test('恢复会话失败（网络异常）也不能让首屏崩掉', async () => {
  const state = installDom();
  globalThis.fetch = async (url) => {
    if (url === '/api/me') throw new Error('network down');
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await import('../web/app.js?v=neterr');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(state.rendered, '首屏应被渲染');
  assert.match(state.rendered.innerHTML, /未登录/, '恢复失败时应回落到未登录');
});

// ══════════════════════════════════════════════════════════════════
// 终审修复轮 3 的前端回归用例
// ══════════════════════════════════════════════════════════════════

test('服务端返回的用户名里的 HTML 必须被转义，不得成为可执行标记（终审 I-2）', async () => {
  // ⛔ 终审发现（Important）：web/app.js 把 user.name 原样插进 innerHTML。
  //    P0 的 name 只由 seed 写入（不可远程利用），但 P1 的「报名」端点让用户
  //    自选 name → 立刻变成**可远程利用的存储型 XSS**。
  //    同一项目的 web/views/login.js 用的是 err.textContent（安全）——
  //    说明作者知道要转义，只是 app.js 两处漏了。
  const payload = '<img src=x onerror="alert(document.domain)">';
  const state = await bootApp({
    meStatus: 200,
    meBody: { user: { id: 'u_1', name: payload, phone: '13800000000' } },
    tag: 'xss',
  });
  assert.ok(state.rendered, '首屏应被渲染');
  const html = state.rendered.innerHTML;
  assert.ok(
    !html.includes(payload),
    `原始 payload 不得出现在 innerHTML 里（可执行标记）：${html}`,
  );
  assert.ok(
    !/<img/i.test(html),
    `渲染结果不得出现真实的 <img> 标签：${html}`,
  );
  assert.ok(
    html.includes('&lt;img'),
    `payload 必须被转义成 &lt;img：${html}`,
  );
});

test('渲染错误信息时也不得把错误消息当标记插入（终审 I-2）', async () => {
  // app.js 的第二处 sink：catch 分支把 e.message 插进 innerHTML。
  // ⚠️ 必须**真的走到 catch 分支** —— 让视图渲染抛一个带 HTML 的错误，
  //    否则这条用例就只是测了 escapeHtml 工具本身，sink 没被覆盖。
  //    这里用的 DOM 桩让 getElementById 返回**同一个** app 元素，
  //    否则 app.innerHTML 写到的是一个一次性的临时对象上，断言拿不到内容。
  const payload = '<script>alert(1)</script>';
  const appEl = { innerHTML: '', replaceChildren: () => {} };
  globalThis.window = { location: { search: '', hash: '' }, addEventListener: () => {} };
  globalThis.document = {
    getElementById: () => appEl,
    // 让 renderHome 在创建元素时抛错 → render() 进 catch 分支
    createElement: () => { throw new Error(payload); },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  await import('../web/app.js?v=xsserr2');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(appEl.innerHTML.includes('card err'), `必须走过 catch 分支：${appEl.innerHTML}`);
  assert.ok(
    !appEl.innerHTML.includes(payload),
    `原始 payload 不得出现在错误渲染里（可执行标记）：${appEl.innerHTML}`,
  );
  assert.ok(
    appEl.innerHTML.includes('&lt;script&gt;'),
    `错误消息必须被转义：${appEl.innerHTML}`,
  );
});

test('登录按钮真的可点：点一下就发 /api/auth/login（终审 I-6-8）', async () => {
  // ⛔ 终审发现（Important）：「能登录的空系统」的**用户可见入口**（前端按钮）零覆盖。
  //    后端登录测了十几条，前端「点按钮 → 发请求 → 跳首页」一条没有。
  //    把 web/views/login.js 里的事件名改掉（click → dblclick）全量测试照样全绿。
  //
  // 这里需要能捕获 addEventListener 注册的处理函数 —— installDom 的桩做不到，
  // 所以单独装一个能按选择器返回元素、并记录监听器的 DOM 桩。
  const listeners = new Map();
  const makeEl = (id) => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    addEventListener: (evt, fn) => { listeners.set(`${id}:${evt}`, fn); },
  });
  const button = makeEl('submit');
  const phone = makeEl('phone');
  const password = makeEl('password');
  const err = makeEl('err');
  phone.value = ' 13800000000 ';
  password.value = 'pw123';
  globalThis.window = { location: { search: '', hash: '' }, addEventListener: () => {} };
  globalThis.document = {
    createElement: () => ({
      className: '',
      innerHTML: '',
      textContent: '',
      querySelector: (sel) => {
        if (sel === '#submit') return button;
        if (sel === '#phone') return phone;
        if (sel === '#password') return password;
        if (sel === '#err') return err;
        return makeEl('x');
      },
      addEventListener: () => {},
    }),
    getElementById: () => ({ innerHTML: '', replaceChildren: () => {} }),
  };

  const calls = [];
  const ctx = {
    api: {
      post: async (url, body) => { calls.push({ url, body }); return { user: { id: 'u_1', name: '甲' } }; },
      get: async () => ({ user: null }),
    },
    navigate: (p) => calls.push({ navigate: p }),
    setState: () => {},
    getState: () => ({ user: null }),
  };
  const { renderLogin } = await import('../web/views/login.js');
  renderLogin(ctx);

  const handler = listeners.get('submit:click');
  assert.ok(handler, '登录按钮必须注册 click 处理函数（事件名被改就会没有）');
  await handler();
  const posted = calls.find((c) => c.url === '/api/auth/login');
  assert.ok(posted, `点击登录必须发 /api/auth/login，实际调用：${JSON.stringify(calls)}`);
  assert.equal(posted.body.phone, '13800000000', '手机号必须去掉首尾空白');
  assert.equal(posted.body.password, 'pw123');
  assert.ok(calls.some((c) => c.navigate === '/'), '登录成功后必须跳回首页');
});
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd platform && node --test test/server.test.js test/seed.test.js test/web.test.js test/sql-boundary.test.js`
Expected: PASS（52 个测试全过：server 40 + seed 2 + web 6 + sql-boundary 4）

- [ ] **Step 9: 全量测试 + 实跑**

Run: `cd platform && node --test`
Expected: 全部通过

Run: `cd platform && node scripts/migrate.js && ADMIN_PASSWORD='change-me-now-temporary' node scripts/seed.js && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

> ⛔ 预审修正（I7-2）：`scripts/seed.js` **不再兜底默认口令** ——
> 没有 `ADMIN_PASSWORD` 会直接报错退出（退出码 1），所以实跑命令里必须显式带上。

Run: `curl -s http://127.0.0.1:8080/api/health`
Expected: `{"ok":true,"at":"..."}`

Run: `curl -s -i -X POST http://127.0.0.1:8080/api/auth/login -H 'Content-Type: application/json' -d '{"phone":"13800000000","password":"change-me-now-temporary"}'`
Expected: `HTTP/1.1 200 OK` + `Set-Cookie: hk_session=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=...`

- [ ] **Step 10: 提交**

```bash
cd platform && git add src web scripts/seed.js test/server.test.js test/seed.test.js test/web.test.js
git commit -m "feat(P0): 静态服务、前端骨架、种子数据与服务器入口"
```

---

## P0 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P0-1 | 零依赖 | `node --test test/zero-deps.test.js` 通过；无 `node_modules`、无 `package-lock.json` |
| P0-2 | 配置 fail-fast | 故意把 `scoring-final.json` 某权重改成 0.30 → 启动报错里出现「权重合计」，且进程以**非 0 退出码**退出（实际文案是「权重合计 = 1.1000，必须等于 1（100%）」，用 `toFixed(4)`） |
| P0-3 | 迁移幂等 | 连续跑两次 `scripts/migrate.js`，第二次输出「本次无新迁移」 |
| P0-4 | 权限判定唯一入口 | `permissions.test.js` **22** 个用例通过；`scopeClause` 生成的 SQL **能真跑**（有权那行在结果里、无权那行不在），且占位符个数 == `params.length`；超管标志的**两种形状**（仓储行 snake_case / `toPublicUser` 驼峰）都认；**`scopeClause` 与 `can()` 结论一致**（超管 / `role_capability` 授权 → 不做行级过滤、全部行可见；停用用户 → 一行都看不到）；`alias` 必须是合法 SQL 标识符（注入载荷全部拒绝）；`grantAssignment` 对未注册 capability / 不存在用户抛**领域错误**（不漏 SQLite 原文）；`can()` 对缺 id 的用户 **fail-closed 返回 false**（不抛错） |
| P0-5 | 密码与会话 | `password.test.js` 8 + `session.test.js` 10 + `users.test.js` 5 个用例通过；**库中只存 `token_hash`**（`session.test.js` 断言：库里无明文 token，`token_hash` 是 64 位 sha256 十六进制）；**库里存的是 scrypt 哈希而不是明文口令**（`users.test.js` 直接读库断言 `startsWith('scrypt$')` 且验签通过）；**会话有绝对过期上限**（设计文档 §7.5：滑动续期不得突破从签发时刻算起的硬边界） |
| P0-6 | 登录闭环 | `server.test.js` **40** 个用例通过：登录 200 + 下发 `hk_session` Cookie（HttpOnly/SameSite=Lax/Path=/）；带 Cookie 访问 `/api/me` 返回 200；密码错 401 且不下发 Cookie；**用户不存在时登录耗时也有 scrypt 量级**（防计时侧信道枚举） |
| P0-9 | 安全边界钉住 | `seed.test.js` **2** + `web.test.js` **6** 个用例通过；**目录穿越**（字面量 `/../` 与编码 `/%2e%2e`、`/%2e%2e%2f`、`/..%2f` 四种变体，**裸 socket 发原始请求行**）全部拿不到 `web/` 兄弟目录的内容；**500 响应逐字节等于通用文案**（内部细节只进 `console.error`）；**畸形 cookie** 返回 401 不抛异常；**登出后原 token 立即失效**；`createApp` 缺 `webDir` **构造期**就抛错；**静态文件读不了时返回错误且服务器存活**（不能被单个请求打死）；**前端启动时恢复会话**（`/api/me` 成功 → 首屏显示已登录） |
| P0-10 | 修复轮 3 的安全边界 | `server.test.js` **40** + `web.test.js` **6** + `permissions.test.js` **22** + `password.test.js` **8** + `session.test.js` **10** + `users.test.js` **5** + `config.test.js` **23** + `zero-deps.test.js` **9** + `sql-boundary.test.js` **4** 个用例通过；**软链逃逸被拒**（`web/` 下指向根外的软链 → 404，真实 http server + 裸 socket）；**服务端数据里的 HTML 被转义**（存储型 XSS 封堵）；**零依赖守卫真的扫描源码 import**（不再只看 package.json）；**SQL 边界扫描**（裸 SQL 只允许出现在 `src/db/repo/`）；**数字 `scopeId` 时 `can()` 与 `scopeClause()` 结论一致**（两侧同时按字符串归一）；**`server.js` 的领域错误全部经 `AppError`**（构造期 fail-fast 除外）；**会话绝对过期默认 30 天**且 `SESSION_ABSOLUTE_TTL_DAYS` 可覆盖、非法值回落；**登录响应体键集合精确**（对外形状是驼峰版，布尔不是 0/1）；**停用用户登录耗时也有 scrypt 量级**（计时对齐覆盖第三条路径） |
| P0-7 | 跨平台 | 在 Mac 上 `node src/server.js` 成功；把 `platform/` 拷到另一台机器重复同样命令 |
| P0-8 | 领域错误统一 | `src/errors.js` 导出 `AppError` / `appError(status, code, message, detail)`（**status-first**）；全部领域错误都经它抛出（`instanceof AppError` 有断言钉住）；HTTP 层只把 `.status` / `.code` 转出去，**不外泄** Node 的 `ERR_*` 与 SQLite 原文 |
| P0-11 | 终审 Important 三项（I-A / I-B / I-C） | **`zero-deps.test.js` 9 + `body.test.js` 4 + `server.test.js` 40** 个用例通过；**I-A 零依赖守卫有自保护**：判定逻辑抽成纯函数 `classifySpecifier()` / `scanSource()`（从 `zero-deps.test.js` 导出），对**合成的坏源码**断言 6 种第三方写法（`import x from 'pkg'` / `import {x} from 'pkg'` / 副作用 import / `export … from 'pkg'` / 动态 `import()` / `require()`）**必须被判违规**，5 种合法写法（相对路径 / `node:` 内置 / 普通字符串 / 注释里的 import / URL 字面量）**不得被误判**；**I-B 请求体默认上限被钉住**：`readJsonBody(req)` 不传 `limit` 时上限为 **512KB**，512KB 以内放行、超出回 413 `PAYLOAD_TOO_LARGE`，且有反例对照（显式放宽 `limit` 后同一 body 放行）；**I-C `domainCode` 有断言且被导出**：领域码透传、Node 的 `ERR_*` 与非领域码（小写 / 数字开头 / 下划线开头 / 带连字符 / 非字符串 / 缺失）一律回落为通用码（回落值用**可区分哨兵**，避免被固定值变异掩盖）；**4xx 分支只透传 `AppError` 的 message**，裸 `Error`（含 SQLite 原文）的 message 一律回落为「请求无效」 |
| P0-12 | 终审 8 条 Minor 逐条处置 | **`server.test.js` 40 + `sql-boundary.test.js` 4 + `zero-deps.test.js` 9 + `migrate.test.js` 10** 个用例通过；**M-1 dev/ino 接线断言收紧**：必须逐字匹配 `if (!isSameFile(stat, linkStat))`（对账对象写错或被 `&&` 短路都红）；**M-2 304 分支不泄漏 fd**：`/dev/fd` 计数探针（连打 50 次 304，fd 数不得增长；Windows 跳过该用例）；**M-3 SQL 边界扫描器有自检**：10 种形态（`exec`/`prepare` × `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE TABLE`）的阳性对照 + 3 种反例对照；**M-4 三种现实绕过（SQL 存进变量 / `db['prepare']()` / 连接变量不叫 `db`）已在文件头显式登记**（有意接受的取舍）；**M-5 零依赖守卫扫到 `test/`**：`SCAN_DIRS` 含 `test`，且断言「扫描结果里出现过 `test/` 下的文件」；**M-6 五条次要护栏有断言**：静态 `Content-Type`（MIME 表）/ `Cache-Control` / `PRAGMA busy_timeout = 5000` / 404 错误码字面量 `NOT_FOUND` / 413 的 `Connection: close`；**M-7 软链判定被钉死**：指向 web/ 根外的软链（文件与目录）→ 404，指向根内的 → 200；`static.js` 注释已订正为 fail-closed 的真实行为（共享卷部署须改用挂载或复制）；**M-8 溯源与错误风格已写明**：`router.js` 补设计文档 §8 + INTERFACES 契约溯源；`scopeClause`（程序员错误，普通 `Error`）与 `grantAssignment`（客户端输入错误，`AppError`）风格有意不同的理由写入注释；`AppError.detail` 的转发**按 P4 计划排期**（P0 无任何错误携带 detail → 无可观测差异） |

| P0-13 | 终审复核的 F-1 ~ F-6 | **`server.test.js` 40 + `body.test.js` 4 + `zero-deps.test.js` 9 + `sql-boundary.test.js` 4** 个用例通过；**F-1（Important）AppError 的 message 必须原样透传**：4xx 响应的 `error.message` 断言等于具体文案（「手机号或密码不正确」）且**不等于**通用回落「请求无效」（`web/api.js` 把它当界面文案直接显示，退化后所有错误提示变成同一句废话）；**F-2 请求体上限边界取「正好等于上限」**：512KB（524288 字节）必须放行、512KB+1 必须 413（`size > limit` 改成 `>=` 会被抓住）；**F-3 接线断言先剥注释再匹配**：`isSameFile` 接线断言改用共享工具 `test-helpers/strip-comments.js` 剥掉注释与正则字面量后再匹配，「代码写错 + 注释里写对形态」骗不过去；**共享 helper 消除 `zero-deps.test.js` 与 `sql-boundary.test.js` 的逐字重复**（且放在 `test-helpers/` 而非 `test/` 下 —— Node 会把名为 `test` 的目录下所有 JS 当测试文件）；**F-4 两条软链用例补 Windows skip**（与同文件其他 skip 口径一致）；**F-5 正则字面量不再误报**：`stripComments(code, { blankRegex: true })` 把正则字面量也剥成空白（正则里的 `from 'x'` 不是 import）；**F-6 `INTERFACES.md` 的 `serveStatic` 归属订正**：它住在 `src/http/static.js` 而非 `src/server.js` |
| P0-14 | 连接层并发开库回归（父代理修正轮） | `db-concurrency.test.js` **4** 个用例通过：**①** 常规路径不回归（顺序开两个连接，`journal_mode=wal` / `foreign_keys=1` / `busy_timeout=5000`）；**②** 另一线程持写锁时开新连接**必须等到锁释放**（断言等待 ≥300ms，旧实现 0ms 即抛 `database is locked`）；**③** 锁一直不放时**重试预算耗尽必须抛错**（`walRetryBudgetMs` 可配，默认 5000ms —— 启动不能被一把锁吊死）；**④** 4 个连接**同时首开同一个新库全部成功**（旧实现必有一方失败）。|

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*
## 计划块逐字同步台账（2026-10-21 · 漂移审计统一同步轮）

> **背景**：计划里的代码块是「该文件**当前实现**的逐字副本」。后续阶段按
> 「**最早建立者 owns、后续阶段 Modify（追加）不得重建**」改了实现，owning 阶段的计划块就会漂移。
> 本轮用 `docs/tools/plan-block-audit.mjs`（**可复算**）判定 C 类漂移，并分两档处置：
>
> - **真重写（C-RW）**：实现被后续阶段**重写**（改动落在既有行上）⇒ 计划块**必须逐字同步**回本计划；
> - **良性扩展（C-EXT）**：后续阶段只是**追加**（结构性现象）⇒ 计划块**保持原样**，只在此记明「谁追加了什么」。
>
> **同步工具**：`docs/tools/plan-block-sync.mjs`（定位信号与 `--verify` **同源**，避免外部脚本的定位歧义）。
> 本轮同步后漂移审计从 **C-RW 9 条 → 0 条**、A 类从 **184 → 192**。

### 真重写（已逐字同步）

| 编号 | 文件 | 漂移来源（哪个后续阶段改了什么） | 同步后行数 | 核验 |
|---|---|---|---|---|
| SYNC-1 | `src/config.js` | P1 规则加载与能力点校验 → P2 `scoreStage` 配置 → P3 004 迁移与名次积分规则 → P4 三层限频与评委级配额 → P5 三池派生同步与 Task 3 修复轮 I-3（个人积分口径唯一化） | 778 | `--verify` 逐字一致 |
| SYNC-2 | `src/server.js` | P1 任务卡与战队管理 → P2 评审 API 与 SSE → P3 榜单路由 → P4 审计 API → P5 Task 4 公开榜路由 → P6 Task 6 演示模式静态挂载（`DEMO_MODE=1` 才挂 `/src/domain/*` 与 `/rules/*`） | 497 | `--verify` 逐字一致 |
| SYNC-3 | `test/config.test.js` | P1 Task 3 父代理验收修正（能力点校验 / `detail` 透传 / `version` 自动派生 / 去裸 SQL）→ P2 `scoreStage` 配置 | 240 | `--verify` 逐字一致 |

### 良性扩展（仅记录，计划块保持原样）

| 编号 | 文件 | 后续阶段的追加内容 |
|---|---|---|
| SYNC-9 | `src/db/migrate.js` | P0 修复轮（迁移版本下界与描述符、文件名严格校验、同版本号排序确定性）；P6 Task 1 备份脚本读取迁移清单 |
| SYNC-10 | `src/db/sqlite.js` | P0 修复轮（切 WAL 需独占锁 ⇒ 连接层自实现退避重试）；P4 终审修复轮（事务基础设施） |
| SYNC-11 | `src/http/respond.js` | P4 审计 API 追加「原始文本响应」分支（`__rawText`） |
| SYNC-12 | `test/migrate.test.js` | P0 终审修复轮（断言补强 + 注释订正）；P1 追加 002 迁移的数据模型用例 |
| SYNC-13 | `web/app.js` | P0 修复轮（软链/存储型 XSS 边界与会话恢复）→ P1 前端三页 → P3 榜单页/段位榜/战绩卡 → P4 审计与 trace 抽屉 → P6 Task 6 演示站横幅 |

> ⚠️ **口径**：C-EXT 的「良性」指**结构上**是追加，不等于内容永远不变。
> 漂移审计可随时复算：`node docs/tools/plan-block-audit.mjs platform`。
> 若某个文件后续被**重写**（而非追加），它会自动从 C-EXT 升到 C-RW，届时必须再做一次同步。
## P0 迁移读取器加固（父代理，2026-10-21 · 真机跨平台复现带出的改动）

> **背景**：P6 Task 8 的「跨平台复现」在 **Linux 真机**（8.133.200.235 / Debian 12 / ext4 / Node 22.22.2）
> 实跑时，**第一条命令** `node scripts/migrate.js` 就失败了：
>
> ```
> Error: 迁移文件名必须形如 <版本号>_<名称>.sql: ._001_init.sql
> ```
>
> **根因**：`._001_init.sql` 是 **macOS 的 AppleDouble 伴生文件**（资源叉载体，内容是二进制）——
> 从 macOS 往**非 HFS 文件系统**（exFAT/FAT U 盘、或 `tar` 打进 Linux 的流）拷时，
> 每个文件旁边会多出这样一个 `._xxx`。
> 它**不是迁移**，是操作系统产生的伴生文件。
>
> **处置**：本文件（`src/db/migrate.js`，P0 owns）**只排除这一个类别** ——
> `.filter((f) => !f.startsWith('._'))`。
>
> ⚠️ **这不放松 P0 那条守卫**：文件名严格校验是 P0 修复轮**故意**加的
> （`_init.sql` / `1e3_x.sql` / `01_.sql` / `001.sql` 这些**人手写错**的名字必须**响亮报错**，
> 否则会在「全局唯一序位」上静默开一个版本缺口）。
> 那些名字**仍然照旧抛错** —— 见 `test/migrate.test.js` 的
> 「退化迁移文件名会被拒绝（不静默开版本缺口）」用例（**本轮未动**）。
>
> **配套**：P6 计划记了同一轮的完整复现记录与「安全拷贝配方」。

### 变更清单

| 文件 | 变更 |
|---|---|
| `platform/src/db/migrate.js` | `readMigrationFiles()` 增加 `.filter((f) => !f.startsWith('._'))`（含注释说明来源与「为什么不是放松守卫」） |
| `platform/test/migrate.test.js` | 新增用例「macOS 的 AppleDouble 伴生文件（._xxx）被忽略 —— 它不是迁移」：造 `._001_init.sql` + `._999_ghost.sql` ⇒ 只读到 1 个真迁移、版本号是 1、伴生文件既不出现也不贡献版本号 |

### 判别性实证

| 变异体 | 结果 |
|---|---|
| 回退 `.filter((f) => !f.startsWith('._'))` | **杀** —— 新用例红（伴生文件被当成迁移、报「迁移文件名必须形如…」） |

### 计划块逐字核验

| 核验项 | 结果 |
|---|---|
| `docs/tools/plan-block-sync.mjs --verify`（`src/db/migrate.js`） | ✅ 逐字一致（145 行） |
| `docs/tools/plan-block-sync.mjs --verify`（`test/migrate.test.js`） | ✅ 逐字一致（290 行） |



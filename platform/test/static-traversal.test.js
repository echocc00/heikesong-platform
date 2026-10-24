// platform/test/static-traversal.test.js — 静态穿越三层防线的**逐层**断言
//
// 背景：src/http/static.js 的注释自己写着：
//   「⚠️ 穿越防线共三层（'..' 段拒绝 / 分隔符边界 / realpath 边界）：
//      目前只有 realpath 这一层被断言钉住 —— 另两层单独拆掉不会被测出来
//      （三层同拆才会红）。三层都要留着：realpath 之前的路径规范化仍需自保。」
//
// 本文件把另外两层补上，并把「拆掉任一层就必须变红」变成**可验证**的命题：
//   第一层「'..' 段拒绝」  —— 路径里出现 '..' 段 ⇒ 直接拒（必须在 decode **之后**判）
//   第二层「分隔符边界」  —— resolve(root, '.'+rel) 之后必须仍在 root 之下
//   第三层「realpath 边界」—— **已存在**，本文件**不重复造**：
//        platform/test/server.test.js 的
//        「软链指向 web 根外的文件时返回 404，不得读出文件内容（终审 I-1）」
//        与「软链的判定看真实路径：指向根外的被拒，指向根内的放行（终审 M-7）」
//        （前者钉「根外软链不得读出内容」，后者同时钉「根外软链 → 404 / 根内软链 → 200」两个方向）
//        ⇒ 实测：单独拆掉 realpath 那一层 ⇒ 这两条变红（2026-10-24 变异验证）。
//
// ⚠️ **为什么第二层只能用「接线断言」钉住**（本文件最关键的一条推理，别删）：
//   · 行为上，第二层**单独**拆掉是**测不出来的**：对同一个越界目标，
//     第一层（'..' 段）与第三层（realpath）**都会拦** ⇒ 拆掉第二层，响应照样是 404
//     ⇒ 只写行为断言 ⇒ 第二层会被无声拆掉 ⇒ 这正是 static.js 注释里说的那个病。
//   · 而第二层**不能被第一层替代**：第一层只按 '/' 切段，
//     Windows 上 `..\..\x` 是**一个**段（第一层放行）⇒ 只有第二层能拦它。
//   ⇒ 所以第二层必须有一条**直接断言那道防线还在**的接线断言
//     （本仓既有手法：server.test.js 的「serveStatic 必须真的调用 isSameFile 做 dev/ino 对账（接线断言）」），
//     并且这条断言要带**变异对照**（把防线改坏 ⇒ 断言必须变红），否则它自己也可能恒绿。
//
// ⛔ **跨平台纪律**：本仓要求用例在 Windows 与 POSIX 上都成立。
//   · 第一层的探针（'/sub/../index.html'）在两个平台上的语义**完全一致**
//     （resolve 是纯词法运算，与分隔符无关）⇒ 断言逐字相同。
//   · 第二层的**行为**探针（拼出 root 的兄弟目录）在两个平台上都成立；
//     额外加一条**反斜杠**变体，它在 Windows 上**能单独打到第二层**，
//     在 POSIX 上则是无害的恒真（POSIX 里 '\' 是普通文件名字符，不是分隔符）——
//     所以该变体只断言「**不泄露**」（两平台都必须成立），
//     「能单独打到第二层」这个更强的事实由上面的**接线断言**在两平台上保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { stripComments } from '../test-helpers/strip-comments.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const STATIC_SRC = join(here, '..', 'src', 'http', 'static.js');

/**
 * 搭一个静态根：<dataDir>/web-root/web（静态根）、<dataDir>/web-root/web-secret（**兄弟目录**）。
 *
 * ⚠️ 兄弟目录 web-secret/ 是第二层防线要防的那个形状：
 *    '/x/web-secret'.startsWith('/x/web') 为真 ⇒ 只比前缀会把兄弟目录也放进来。
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-static-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const webRoot = join(dataDir, 'web-root');
  const webDir = join(webRoot, 'web');
  mkdirSync(join(webDir, 'sub'), { recursive: true });
  mkdirSync(join(webRoot, 'web-secret'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(webDir, 'sub', 'inner.txt'), 'INNER\n');
  writeFileSync(join(webRoot, 'web-secret', 'passwd'), 'TOP-SECRET');
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, webRoot, webDir, app };
}

/**
 * 用**裸 socket** 发原始请求行。
 * ⚠️ 为什么不能用 fetch / http.request：它们按 WHATWG URL 规范把点段消掉
 *    （'%2e%2e' 也会被规范化成 '..'）⇒ 请求根本发不出原样 ⇒ 穿越测试成了空转。
 *    Node 的 HTTP **解析器**不规范化 ⇒ 原样发出去，服务端收到的就是原样的路径。
 */
function rawRequest(port, rawPath, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const done = (value) => resolvePromise(value);
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

/** 起一个真实 HTTP server（真实 socket ⇒ 真实请求 ⇒ 真实响应） */
async function withServer(app, fn) {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

/**
 * 第二层防线的**接线断言**匹配器。
 *
 * 必须匹配到的形态：目标路径不在 root 之下时**直接拒**，
 * 且比较**带分隔符边界**（`root + sep`）—— 只比前缀（`root`）正是 C7-1 那个
 * 「兄弟目录被放进来」的原始 bug。
 */
const BOUNDARY_GUARD = /if\s*\(\s*target\s*!==\s*root\s*&&\s*!\s*target\s*\.\s*startsWith\(\s*root\s*\+\s*sep\s*\)\s*\)\s*\{?\s*return\s+false\s*;?\s*\}?/;

// ══════════════════════════════════════════════════════════════════════
// 第一层：「'..' 段拒绝」
// ══════════════════════════════════════════════════════════════════════

test('第一层：路径里带 ".." 段的请求必须被拒（只有第一层能拦住下面那条探针）', async () => {
  const { db, close, dataDir, webRoot, webDir, app } = setup();
  try {
    // ── 探针「只打到第一层」的机器可验证证明 ──
    // resolve() 是**纯词法**运算（不碰文件系统）⇒ '/sub/../index.html' 归一化后
    // 落在 root **之内** ⇒ 第二层（分隔符边界）与第三层（realpath 边界）**都会放行**
    // ⇒ 能拦住它的**只有第一层** ⇒ 把第一层拆掉 ⇒ 这条用例必然变红。
    const resolved = resolve(webDir, './sub/../index.html');
    assert.ok(
      resolved.startsWith(resolve(webDir) + sep),
      `探针必须落在 root 之内（否则它测的是第二/三层）：${resolved}`,
    );
    assert.equal(resolved, resolve(webDir, './index.html'), '探针必须归一化到 root 内的真实文件');

    await withServer(app, async (port) => {
      // ── 阳性对照：同一个服务器、同一个文件，去掉 ".." 段就必须是 200 ──
      //    没有这条对照，用例可能因为「服务器根本没起来 / 文件根本不存在」而恒绿。
      const ok = await rawRequest(port, '/index.html');
      assert.ok(ok.includes('200 OK'), `阳性对照：/index.html 必须 200，实际：${ok.slice(0, 120)}`);
      assert.ok(ok.includes('<h1>home</h1>'), '阳性对照：必须真的读到文件内容');

      // ── 真正的断言：带 ".." 段的路径必须被拒 ──
      const blocked = [
        '/sub/../index.html',       // ← 只打到第一层的那条
        '/../etc/passwd',
        '/a/../../etc/passwd',
        '/sub/../../etc/passwd',
        '/%2e%2e/etc/passwd',       // 编码形式：第一层在 decode 之后判 ⇒ 也必须被拒
      ];
      for (const p of blocked) {
        const raw = await rawRequest(port, p);
        assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 必须被拒（不得 200），实际：${raw.slice(0, 120)}`);
        assert.ok(!raw.includes('root:'), `${p} 泄露了 /etc/passwd 的内容`);
      }
    });
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 第二层：「分隔符边界」
// ══════════════════════════════════════════════════════════════════════

test('第二层：分隔符边界防线必须还在（接线断言 + 变异对照 ⇒ 单独拆掉它就会变红）', () => {
  // ⚠️ 必须先剥注释再匹配：否则「把防线改坏、然后在注释里写上正确形态」就能骗过这条断言
  //    （守卫永不触发却仍判绿 —— server.test.js 的终审复核 F-3 就是这个坑）。
  const src = stripComments(readFileSync(STATIC_SRC, 'utf8'));
  assert.ok(
    BOUNDARY_GUARD.test(src),
    'static.js 里必须保留「目标不在 root 之下 ⇒ 直接拒」的防线，且比较必须带分隔符边界（root + sep）',
  );

  // ── 变异对照（阳性对照）：把防线改坏 ⇒ 断言必须**拒绝**它 ──
  //    没有这一段，这条断言自己也可能恒绿（= 钉不住任何东西）。
  const mutants = [
    ['整条防线被删掉', '  const target = resolve(root, `.${relPath}`);\n'],
    ['只比前缀、丢了分隔符边界（C7-1 的原始 bug）',
      '  if (target !== root && !target.startsWith(root)) return false;\n'],
    ['边界条件被削弱成只挡 root 本身',
      '  if (target !== root) return false;\n'],
  ];
  for (const [why, replacement] of mutants) {
    const mutated = src.replace(BOUNDARY_GUARD, replacement);
    assert.notEqual(mutated, src, `变异必须真的改动了源码（否则变异对照是假的）：${why}`);
    assert.ok(
      !BOUNDARY_GUARD.test(mutated),
      `变异「${why}」必须让断言变红 —— 否则这条接线断言钉不住任何东西`,
    );
  }
});

test('第二层：拼出 root 兄弟目录的请求拿不到内容（跨平台稳定）', async () => {
  const { db, close, dataDir, webRoot, app } = setup();
  try {
    await withServer(app, async (port) => {
      // ── 阳性对照：兄弟目录里的文件**确实存在**（否则「拿不到内容」可能是文件不存在）──
      const { existsSync } = await import('node:fs');
      assert.ok(
        existsSync(join(webRoot, 'web-secret', 'passwd')),
        '阳性对照：兄弟目录里的文件必须真的存在',
      );

      // ── 正斜杠形态：'/' 分隔的 '..'（第一层与第二层都会拦）──
      for (const p of ['/../web-secret/passwd', '/sub/../../web-secret/passwd']) {
        const raw = await rawRequest(port, p);
        assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 必须被拒，实际：${raw.slice(0, 120)}`);
        assert.ok(!raw.includes('TOP-SECRET'), `${p} 泄露了兄弟目录的内容`);
      }

      // ── 反斜杠形态：Windows 上第一层放行（'..\..' 是一个段）⇒ 只有第二层能拦 ──
      //    ⚠️ POSIX 上 '\' 是普通文件名字符 ⇒ 这条路径根本解析不出兄弟目录 ⇒ 只会 404
      //    ⇒ 因此这里只断言「**不泄露**」（两平台都必须成立）；
      //    「第二层被拆掉就变红」这个更强的事实由上面的**接线断言**在两平台上保证。
      const winish = '/..\\..\\web-secret\\passwd';
      const rawWin = await rawRequest(port, winish);
      assert.ok(!/^HTTP\/1\.1 200/.test(rawWin), `${winish} 必须被拒，实际：${rawWin.slice(0, 120)}`);
      assert.ok(!rawWin.includes('TOP-SECRET'), `${winish} 泄露了兄弟目录的内容`);
    });
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

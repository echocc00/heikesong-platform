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
    ['active', 'createdAt', 'id', 'isSuperadmin', 'mbaStatus', 'name', 'org', 'phone', 'roles'],
    `登录响应的 user 键集合必须精确等于 toPublicUser 的对外形状，实际 ${JSON.stringify(Object.keys(body.user))}`
    + '｜⚠️ P7 新增 roles：前端按角色分区导航必须要它（角色键列表，非敏感字段）。',
  );
  assert.ok(Array.isArray(body.user.roles), 'roles 必须是数组（前端按数组读）');
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

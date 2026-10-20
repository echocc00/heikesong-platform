import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
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

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-srv-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  // web/ 旁边造一个兄弟目录 web-secret/ —— 用来验证目录穿越防护（C7-1）
  const webRoot = mkdtempSync(join(tmpdir(), 'hks-web-'));
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

test('未知路径返回 404', async () => {
  const { db, close, dataDir, app } = setup();
  const res = await call(app, 'GET', '/api/nope');
  assert.equal(res.status, 404);
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

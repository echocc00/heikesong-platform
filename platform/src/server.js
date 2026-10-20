// src/server.js — 进程入口 + 可测的应用装配
// 依据：设计文档 §4.1 / §14.1
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { openDatabase } from './db/sqlite.js';
import { applyMigrations } from './db/migrate.js';
import { loadRules, validateRules } from './config.js';
import { createRouter } from './http/router.js';
import { json, error } from './http/respond.js';
import { readJsonBody } from './http/body.js';
import { serveStatic } from './http/static.js';
import { createSession, resolveSession, revokeSession } from './auth/session.js';
import { can } from './auth/permissions.js';
import { verifyPassword, hashPassword } from './auth/password.js';
import { getUserById, getCredentialsByPhone, toPublicUser } from './db/repo/users.js';
import { appError, AppError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));

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
  // 生产环境 Cookie 加 Secure；开发环境不加（http://127.0.0.1 会被浏览器拒收）
  const secureCookies = process.env.NODE_ENV === 'production';

  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));

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
        if (status === 413) {
          // 请求体超限：连接已不可用 → 关掉，不复用
          json(res, 413, { error: { code, message } }, { Connection: 'close' });
          return;
        }
        error(res, status, code, message);
      }
      return;
    }
    // ⛔ 评审修正（Important）：静态分支原来在 try/catch **之外** ——
    //    serveStatic 抛出的任何异常都会逸出 handle → 进程死亡。
    //    现在它在自己的 try 里；异常一律回 404，不影响进程。
    if (req.method === 'GET') {
      try {
        if (serveStatic(webDir, req, res)) return;
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
        close();
        process.exit(0);
      });
    });
  }
}

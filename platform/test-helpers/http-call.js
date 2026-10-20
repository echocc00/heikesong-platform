// platform/test-helpers/http-call.js — 进程内 HTTP 调用器（测试专用共享工具）
//
// 依据：P1 Task 7 预审（重复代码清理）。
//   `call(app, method, path, {token, body})` 此前在**三个** API 测试文件里
//   各抄了一份（**逐字相同**，md5 一致）—— 改一处要改三处，必然漂移。
//   三个文件分别是：registration-api / task-package-api / team-api。
//
// ⛔ 它是**测试辅助工具**，不是被测代码：放在 test-helpers/ 下，
//    零依赖守卫（test/zero-deps.test.js 的 SCAN_DIRS 含 'test-helpers'）会一起扫，
//    本文件只用 Node 标准库（Buffer / Promise），符合「零 npm 依赖」承诺。
//
// ⚠️ 为什么是「进程内」而不是真起一个服务器：
//    它走的是 **app.handle → 路由 → 中间件 → 会话解析 → 错误映射** 的完整链路，
//    只是省掉了 socket 与 HTTP 报文编解码 —— 路由层的缺陷（能力点校验、
//    三态状态码、可见性过滤）一样能被测到。真正的 socket 级用例在
//    test/server.test.js（路径穿越 / 静态文件）。
//
// ⚠️ 返回值是 `{ status, headers, body }`（body 是**字符串**，要自己 JSON.parse）。
//
// ⛔ 纯函数、零依赖、零 IO。

/**
 * 在进程内发一次请求。
 *
 * @param {object} app `createApp({ db, rules, webDir })` 的返回值
 * @param {string} method HTTP 方法（GET / POST / PATCH / DELETE）
 * @param {string} path 请求路径（含 query）
 * @param {{ token?: string|null, body?: any }} [options]
 *   `token` → 带上 `Cookie: hk_session=<token>`（P0 的会话 cookie 名）
 *   `body`  → 会被 JSON 序列化并声明 `Content-Type: application/json`
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function call(app, method, path, { token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers: token ? { cookie: `hk_session=${token}` } : {},
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
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
 * `call` + JSON 解析的便捷封装。
 * 响应体不是合法 JSON 时把原文挂在 `res.text` 上（便于断言错误文本）。
 */
export async function callJson(app, method, path, options = {}) {
  const res = await call(app, method, path, options);
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { ...res, json, text: res.body };
}

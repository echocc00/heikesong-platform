// src/http/security-headers.js — 安全响应头 + CORS 策略（响应的**统一出口**）
//
// 规则溯源：
//   ① 缺陷报告 2026-10-23 §3.5「F28 · Low · 完全没有安全响应头」
//      （内部审计报告:1676-1704）——
//      验收口径原文：「所有响应都带 X-Content-Type-Options: nosniff 与 X-Frame-Options」。
//      修法原文：「在 respond.js / static.js 的统一出口加一组默认安全头」。
//   ② 缺陷报告 §3.5「F27 · Low · HEAD/OPTIONS 全部 404，无 CORS」（:1637-1671）——
//      修法 ③ 原文：「CORS 是否要**开**是产品决策（目前刻意不开）」⇒ 默认关闭 + 可配置开启。
//   ③ 「https 判定读 X-Forwarded-Proto」—— nginx 模板已透传该头
//      （deploy/nginx-tls-port.conf:113、deploy/nginx.conf:110、deploy/nginx-plain-http.conf:80），
//      且 test/deploy-tls-port.test.js:171 明写「必须透传 X-Forwarded-Proto（https 下应用要读它）」。
//
// ⚠️ **刻意不加 Content-Security-Policy**：
//    前端视图（web/views/*.js）里有**内联 style 属性**（例：web/views/landing.js:398
//    `style="--share:${…}"`）⇒ 严格 CSP（style-src 不带 'unsafe-inline'）会把整站样式拦掉。
//    ⇒ 点击劫持改用 X-Frame-Options 挡（不依赖 CSP）。
//    这条前提由 test/audit-findings.test.js 的「F28c」用例钉住：
//    将来谁想加 CSP，必须先处理内联样式（并改那条用例），不许悄悄加。
//
// ⚠️ 为什么**按请求**读环境变量、而不是模块加载时读一次：
//    一个进程里可能起多个 app 实例（测试里每个用例都起一个），
//    模块级缓存会让「上一个用例改过的配置」漏到下一个用例 ⇒ 假绿/假红。
//    每次请求读一次 env 的成本可以忽略，换来的是「配置与请求一一对应、结果确定」。

/** 基础安全头：与请求无关 ⇒ 任何响应都带（API / 静态页 / 404 / SSE 一视同仁）。 */
const BASE_SECURITY_HEADERS = {
  // 禁止浏览器猜内容类型（防 MIME 嗅探型 XSS）。
  'X-Content-Type-Options': 'nosniff',
  // 跨站跳转时不泄露完整 URL（只保留 origin）。
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // 防点击劫持：管理后台 SPA 不允许被任何页面内嵌（本仓全仓无 iframe 用法）。
  'X-Frame-Options': 'DENY',
};

/** HSTS 默认 max-age：180 天（1 年太激进 —— 将来要退回明文服务时会被浏览器锁死）。 */
const DEFAULT_HSTS_MAX_AGE = 15552000;

/** CORS 预检允许的请求头（默认只有 Content-Type —— 本仓前端只用 JSON + Cookie）。 */
const DEFAULT_CORS_ALLOW_HEADERS = 'Content-Type';

/** CORS 预检结果缓存秒数（默认 10 分钟）。 */
const DEFAULT_CORS_MAX_AGE = 600;

/** 读一个环境变量并去空白（未设 ⇒ 空串）。 */
function envValue(name) {
  const raw = process.env[name];
  return raw === undefined ? '' : String(raw).trim();
}

/**
 * 这条请求是不是 https。
 *
 * ① 直连 TLS（Node 自己终止 TLS）：socket.encrypted === true；
 * ② 反代终止 TLS：nginx 透传 `X-Forwarded-Proto $scheme` ⇒ 值为 https。
 *
 * ⚠️ X-Forwarded-Proto 是**客户端可伪造**的头（见 services/rate-limit.js:18 的同款提醒）。
 *    但这里被伪造的后果仅限于「明文响应上多一个 HSTS 头」——
 *    浏览器按 RFC 6797 §7.2 会**忽略**明文传输收到的 HSTS ⇒ 不构成风险。
 *    生产部署里 Node 只绑 127.0.0.1（src/server.js:636），外部根本够不到这个端口。
 */
function isSecureRequest(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted === true) return true;
  const raw = req.headers && req.headers['x-forwarded-proto'];
  // 代理链上可能是 "https,http" ⇒ 只看第一段（最靠近客户端的那一跳）。
  const first = String(raw || '').split(',')[0].trim().toLowerCase();
  return first === 'https';
}

/**
 * HSTS 的 max-age。
 * `HSTS_MAX_AGE=0` ⇒ 关闭；非法值 ⇒ 按默认（失败即安全：宁可开着）。
 */
function hstsMaxAge() {
  const raw = envValue('HSTS_MAX_AGE');
  if (raw === '') return DEFAULT_HSTS_MAX_AGE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HSTS_MAX_AGE;
  return Math.floor(n);
}

/**
 * CORS 允许的来源白名单。
 * 未设 / 空 ⇒ **关闭跨域**（一个 Access-Control-* 头都不给 ⇒ 与修复前完全一致）；
 * `*` ⇒ 允许任意来源；
 * 否则逗号分隔的**精确匹配**列表。
 *
 * ⚠️ `*` 与「带凭据的跨源请求」**互斥**（浏览器规定：带凭据时不允许 `*`，
 *    必须回具体来源 + `Access-Control-Allow-Credentials: true`）。
 *    本仓前端用 `credentials: 'same-origin'`（web/api.js）⇒ 同源请求不受影响；
 *    真要开带凭据的跨源，请填**具体来源**而不是 `*`。
 */
function allowedOrigins() {
  const raw = envValue('CORS_ALLOW_ORIGIN');
  if (!raw) return [];
  if (raw === '*') return ['*'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 简单请求（以及预检）的 CORS 头。
 * ⚠️ 白名单外的来源**一个头都不给**（由浏览器自己拦）—— 不做「先放行再说」。
 */
function corsHeaders(req) {
  const origins = allowedOrigins();
  if (!origins.length) return {}; // CORS 关闭
  const origin = String((req && req.headers && req.headers.origin) || '');
  if (!origin) return {}; // 同源请求不需要 CORS 头
  if (origins.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (!origins.includes(origin)) return {}; // 不在白名单
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/**
 * 常规响应头（安全头 + CORS 头）。
 * 调用方：src/http/respond.js（json/text）、src/http/static.js（200/304）、
 *        src/http/sse.js（SSE 流）、src/server.js（204 / OPTIONS）。
 */
export function responseHeaders(req) {
  const headers = { ...BASE_SECURITY_HEADERS };
  const maxAge = hstsMaxAge();
  // ⚠️ HSTS **只在 https 下**给：明文连接上发 HSTS 是误导（浏览器也会忽略它）。
  if (maxAge > 0 && isSecureRequest(req)) {
    headers['Strict-Transport-Security'] = `max-age=${maxAge}`;
  }
  return { ...headers, ...corsHeaders(req) };
}

/**
 * 预检（OPTIONS）专用的 CORS 头。
 * ⚠️ CORS 关闭时返回空对象 ⇒ 预检响应里一个 Access-Control-* 头都没有
 *    （与「刻意不开跨域」的产品决策一致）。
 */
export function corsPreflightHeaders(req, allowMethods) {
  const base = corsHeaders(req);
  if (!Object.keys(base).length) return {};
  const allowHeaders = envValue('CORS_ALLOW_HEADERS') || DEFAULT_CORS_ALLOW_HEADERS;
  const rawMaxAge = envValue('CORS_MAX_AGE');
  const parsed = rawMaxAge === '' ? DEFAULT_CORS_MAX_AGE : Number(rawMaxAge);
  const maxAge = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_CORS_MAX_AGE;
  return {
    ...base,
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': String(maxAge),
  };
}

/**
 * 这条请求的**客户端 IP**（用于「按来源」限频 —— 见 src/services/rate-limit.js）。
 *
 * ⚠️ **为什么不能直接用 `X-Forwarded-For`**：那个头是**客户端可伪造**的
 *    （客户端随便填）⇒ 直接拿它当限频主体 ⇒ 攻击者换一个头就能绕过限频。
 *    同款提醒见 services/rate-limit.js 的头部注释。
 *
 * ⚠️ **为什么「对端是回环」时可以信 X-Real-IP**：
 *    本仓的 nginx 模板（deploy/nginx-plain-http.conf:62、
 *    deploy/nginx-tls-port.conf:95）写的是
 *      `proxy_set_header X-Real-IP $remote_addr;`
 *    —— **覆盖写**（不是追加）⇒ 客户端伪造的同名头会被 nginx **整个替换**。
 *    而 Node 只绑 127.0.0.1（src/server.js 的 listen）⇒ 对端是回环 = 同机的 nginx。
 *
 * ⚠️ **X-Forwarded-For 取「最后一段」**：nginx 用 `$proxy_add_x_forwarded_for`
 *    （= 客户端自己填的 + nginx 追加的真实对端）⇒ **最后一段才是真实对端**，
 *    前面的段全是客户端塞的 ⇒ 取最后一段，不取第一段。
 *
 * ⛔ **对端不是回环 ⇒ 一律用 `socket.remoteAddress`**（TCP 对端，不可伪造）。
 *    这条是 fail-closed：宁可把所有人算成同一个来源（导致误伤），
 *    也不能让攻击者靠伪造头**拿到独立配额**。
 *
 * ⚠️ **部署形态变更的注意**：如果运维把 Node 改成绑 0.0.0.0（对外直连），
 *    对端就不再是回环 ⇒ 一律走 remoteAddress（= 真实客户端）⇒ 限频按真实 IP 生效，
 *    **但此时 X-Real-IP / X-Forwarded-For 完全不被信任** —— 这是刻意的。
 *
 * @param {object} req node 的 IncomingMessage
 * @returns {string} 客户端 IP；拿不到时返回 'unknown'（**不返回空串** —— 空串会
 *                    让所有「拿不到 IP」的请求共享同一个限频桶）
 */
export function clientIp(req) {
  const peer = String(req?.socket?.remoteAddress ?? '').trim();
  const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (isLoopback) {
    const real = req?.headers?.['x-real-ip'];
    if (real) {
      const first = String(real).split(',')[0].trim();
      if (first) return first;
    }
    const xff = req?.headers?.['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return peer || 'unknown';
}

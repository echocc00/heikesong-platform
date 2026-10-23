// src/http/sse.js — Server-Sent Events（单向推送）
// 依据：设计文档 §4.3 的目录清单（http/ 下含 sse.js）+ P0 终态 `platform/web/api.js:28-30`
//   的明确承诺：「⚠️ SSE 端点在 **P2** 才实现（src/http/sse.js）」—— 本文件就是那个承诺的兑现。
//
// ⚠️ 为什么 SSE **不挂 router**：P0 的 router handler 约定是「返回一个值 → server.js
//    统一 json() 序列化并结束响应」。SSE 要**长期持有这条连接**（多次推帧）——
//    走 router 会被 server.js 的 json() 提前收尾 → 客户端只收到第一帧就断。
//    所以 SSE 走 server.js 里**独立的分支**：自己写头、自己推帧、自己收尾。
//
// ⛔ 帧格式（SSE 规范）：`event: <name>\ndata: <单行 JSON>\n\n`
//    data 里不能有裸换行（会截断帧）→ 一律 JSON.stringify。
// ⛔ 不能用 json() / text() 写响应头 —— 那会把 Content-Type 定死成 application/json。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 2 处修正】
//   ① **畸形百分号编码会让 parseSsePath 抛 URIError** ——
//      P0 的教训（「畸形 URL 编码不能让进程退出」）在这里同样成立：
//      `/api/stages/%E0%A4%A/events` 会让 decodeURIComponent 抛错。
//      现在解析失败**返回 null** → 走正常的路由/400 分支，绝不逸出到 server.js 之外。
//   ② **没有心跳帧**：SSE 连接长时间空闲时，中间的 nginx（proxy_read_timeout 默认 60s）
//      会把连接掐掉 —— 现象是「前端每隔一分钟重连一次」。现在提供 `sendSseComment()`
//      注释帧（`: ping\n\n`），由 server.js 用 `unref()` 的定时器定期发。
//
// ⚠️ F28（缺陷报告 2026-10-23 §3.5，:1676-1704）：SSE 响应也走统一出口 ⇒ 同样带安全头
//    （口径见 src/http/security-headers.js）。⚠️ SSE_HEADERS 是常量，
//    与请求相关的部分（HSTS / CORS）在 openSseStream 里按 res.req 现算。
import { responseHeaders } from './security-headers.js';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx 默认缓冲响应 → 事件被攒着一起发，前端看起来像「不推送」。
  'X-Accel-Buffering': 'no',
};

/** 解析 SSE 路径：/api/stages/:stageId/events → { stageId }；不是 SSE 路径 → null。 */
export function parseSsePath(url) {
  const m = /^\/api\/stages\/([^/?#]+)\/events(?:\?|$)/.exec(String(url || ''));
  if (!m) return null;
  try {
    return { stageId: decodeURIComponent(m[1]) };
  } catch {
    // 畸形百分号编码：不是合法路径 → 交给上层按「非法 URL」处理（父代理预审修正 ①）
    return null;
  }
}

/** 写 SSE 响应头并保持连接。 */
export function openSseStream(res) {
  res.writeHead(200, { ...SSE_HEADERS, ...responseHeaders(res.req) });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return true;
}

/** 写一帧。响应已结束（客户端断开）时静默返回 false。 */
export function sendSseEvent(res, event, data) {
  if (!res || res.writableEnded) return false;
  const payload = JSON.stringify(data ?? null);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
  return true;
}

/**
 * 写一条 SSE **注释帧**（心跳）。
 * 注释帧以 `:` 开头，EventSource 会忽略它 —— 用途是让中间代理知道连接还活着。
 */
export function sendSseComment(res, text = 'ping') {
  if (!res || res.writableEnded) return false;
  res.write(`: ${text}\n\n`);
  return true;
}

/** 结束 SSE 响应。 */
export function closeSseStream(res) {
  if (res && !res.writableEnded) res.end();
}

/**
 * 事件中心：按 topic 分发的订阅者集合。
 * ⛔ 订阅者（res）在客户端断开时必须被移除 —— 否则连接泄漏，进程内存单调增长。
 *    调用方（server.js）在 res.on('close') 里调 remove()。
 */
export function createSseHub() {
  const clients = new Map(); // res → topic
  return {
    add(res, topic = null) {
      clients.set(res, topic);
      return () => clients.delete(res);
    },
    remove(res) {
      clients.delete(res);
    },
    /** 向同一 topic 的订阅者推一帧，返回送达数。 */
    publish(event, data, topic = null) {
      let sent = 0;
      for (const [res, t] of clients) {
        if (topic !== null && t !== topic) continue;
        if (sendSseEvent(res, event, data)) sent += 1;
      }
      return sent;
    },
    get size() {
      return clients.size;
    },
    /** 结束并清空所有订阅连接（测试收尾用）。 */
    closeAll() {
      for (const res of [...clients.keys()]) {
        closeSseStream(res);
        clients.delete(res);
      }
    },
  };
}

/** 评审进度事件中心（P2 唯一的事件源）。 */
export const reviewEvents = createSseHub();

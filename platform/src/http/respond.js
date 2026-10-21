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

// ⛔ P4 追加（第 6 参 extraHeaders，向后兼容）：限频要返回 429 + Retry-After 响应头，
//    调用方拿不到 res.writeHead 的二次机会，所以错误响应也必须能带自定义头。
export function error(res, status, code, message, detail, extraHeaders = {}) {
  json(res, status, { error: { code, message, ...(detail ? { detail } : {}) } }, extraHeaders);
}

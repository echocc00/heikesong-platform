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

// ── P4 追加：快捷构造函数 ─────────────────────────────────────────────
// 依据：跨阶段接口契约 §0「错误：抛 AppError（status + code + message + detail，status-first）」
//
// ⚠️ 本文件由 **P0 的 Task 4 建立**（`export class AppError extends Error`，
//    构造签名 `AppError(status, code, message, detail)`），P4 **只追加快捷函数**。
//    ⛔ 不要在这里重写 AppError 类，也不要**重新定义 appError**：
//       P3 的 12 处 `new AppError(...)` 调用按 **status-first** 顺序写死，
//       重写成别的签名会让 err.status / err.code 互换；
//       而 `appError` 若被重新定义成「返回普通 Error 而非 AppError 实例」，
//       就破坏了 P0-8「全部领域错误都经 AppError 抛出」这条验收标准
//       （下游 `e instanceof AppError` 分支会失效）。

export function badRequest(message, detail) {
  return appError(400, 'INVALID_REQUEST', message, detail);
}

export function unauthenticated(message = '未登录') {
  return appError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message, detail) {
  return appError(403, 'FORBIDDEN', message, detail);
}

export function notFound(message, detail) {
  return appError(404, 'NOT_FOUND', message, detail);
}

export function conflict(message, detail) {
  return appError(409, 'CONFLICT', message, detail);
}

export function rateLimited(message, detail) {
  return appError(429, 'RATE_LIMITED', message, detail);
}

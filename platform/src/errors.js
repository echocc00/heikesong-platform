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

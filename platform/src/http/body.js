// src/http/body.js — 请求体解析
// 体积上限防止一个超大 body 打满内存（可移植性约束下的最基本防护）
// 依据：跨阶段契约 INTERFACES.md §0「错误：抛 AppError（code + message + status）」。
import { appError } from '../errors.js';
export async function readJsonBody(req, { limit = 1024 * 512 } = {}) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    // ⛔ 预审修正（I4-1）：必须先把请求流消费/销毁掉再抛错。
    //    客户端可能还在发剩余 body，不消费就抛 → 连接悬挂（慢速上传能占住连接不放）。
    //    销毁请求流后，上层回 413 并带 Connection: close（连接不再复用）。
    if (typeof req.destroy === 'function') req.destroy();
    else if (typeof req.resume === 'function') req.resume();
    throw appError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw appError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    throw appError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}

// src/http/body.js — 请求体解析
// 体积上限防止一个超大 body 打满内存（可移植性约束下的最基本防护）
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
    const err = new Error('请求体过大');
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是 JSON 对象');
      err.status = 400;
      err.code = 'INVALID_BODY';
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    const e = new Error('请求体不是合法 JSON');
    e.status = 400;
    e.code = 'INVALID_JSON';
    throw e;
  }
}

// web/escape.js — HTML 文本转义
// 依据：设计文档 §14.2（前端零构建、无框架）与安全要求。
//
// ⛔ 终审修正（Important，I-2）：前端把**服务端返回的数据**插进 innerHTML，
//    而 innerHTML 会把 `<img onerror=...>` 这类字符串当**标记**解析 ——
//    服务端数据里带 HTML 就等于存储型 XSS。
//    P0 的 user.name 只由 seed 写入（不可远程利用），但 P1 的「报名」端点
//    让用户自选 name → 立刻变成可远程利用。
//    同项目 web/views/login.js 用的是 err.textContent（安全）—— 说明作者知道
//    要转义，只是 app.js 两处漏了。这里把转义收成一个工具，所有插值统一走它。
//
// ⚠️ 只转义**文本节点**里的插值。属性值（href/src）不能只靠这个函数，
//    因为 `javascript:` 协议不靠 HTML 转义拦得住 —— 那种地方要用属性白名单。
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

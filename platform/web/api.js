// web/api.js — 真实 API 客户端
// ⛔ 演示版用 api.demo.js 替换本模块，视图代码完全复用。
//
// ⚠️ **F24（内部审计报告 §3.5「会话中途 401 不清 UI」）**：
//   会话在**使用途中**过期（服务端 401）时，此前**全站零消费方**读 `err.status`
//   ⇒ 页面继续显示旧数据、顶栏仍显示「已登录」，用户以为还在操作，实际什么也没写进去，
//   而且**永远不会**被送回 `#/login`（只能手工敲 `#/logout`）。
//   ⇒ 这里做**统一收口**：401 ⇒ 清本地会话态 + 回登录页 + 明确告诉用户「会话已过期」。
import { getState, setState, SESSION_EXPIRED_MESSAGE } from './store.js';
import { navigate } from './router.js';

const BASE = '';

/**
 * 会话探测端点（启动时 web/app.js 的 restoreSession 唯一调用它）。
 * ⚠️ 它的 401 回答的是「**本来就没登录**」（访客的正常答案），
 *    不是「**用着用的会话死了**」⇒ 不能在这里跳登录页：
 *    否则访客一进站就被弹走，落地页就废了（P9 M6「落地页未登录 100% 可用」）。
 *    启动时的探测由 restoreSession 自己兜底（catch 里清 user）。
 */
const SESSION_PROBE_PATH = '/api/me';

/**
 * 401（会话失效）的**统一处置**（F24 修法）。
 *
 * 规则溯源：内部审计报告 §3.5 F24
 *   「会话过期后界面仍显示为已登录……用户永远不会被送回 #/login」
 *   ⇒ 修法 = api.js 收到 401 时统一清 store + 跳 #/login（带「会话已过期」提示）。
 *
 * ⚠️ 三条边界（每条都有用例覆盖，见 platform/test/audit-findings.test.js 的 F24 系列）：
 *   ① **403 = 权限不足** ⇒ 绝不清会话（清了会把「权限不够」误导成「请重新登录」）——
 *      本函数**只**被 401 分支调用；
 *   ② **401 + INVALID_CREDENTIALS = 口令不对**（登录 / 改密）⇒ 不是会话失效；
 *   ③ **本来就没有本地会话**（访客）⇒ 不清、不跳（否则把访客从公开落地页弹走）。
 *
 * @param {string} path 请求路径（用来识别会话探测端点）
 * @returns {boolean} true = 本次真的清掉了会话（⇒ 错误文案要换成「会话已过期」）
 */
function expireSession(path) {
  if (path === SESSION_PROBE_PATH) return false;   // 会话探测：访客的正常 401，不算失效
  if (!getState().user) return false;              // 本来就没会话 ⇒ 不动
  setState({ user: null, sessionExpired: true });
  navigate('/login');
  return true;
}

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  // ⚠️ 错误响应体**不保证**是 JSON（反向代理可能回一份 HTML 登录页）⇒ 解析失败按「无结构」处理；
  //    但**状态码**必须照样拿到 —— 401 的统一处置完全依赖它。
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败 ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    // ⛔ **401 = 会话失效** ⇒ 统一清本地会话态 + 回登录页（F24）
    //   ⚠️ 403 = 权限不足 ⇒ **不清会话**（否则把「权限不够」说成「请重新登录」）
    //   ⚠️ 401 + INVALID_CREDENTIALS = 口令不对（登录 / 改密）⇒ 不是会话失效
    const expired = res.status === 401
      && err.code !== 'INVALID_CREDENTIALS'
      && expireSession(path);
    if (expired) {
      // ⚠️ 不能静默吞掉：服务端的「未登录」用户看不懂、也不知道下一步做什么
      //    ⇒ 换成一句带下一步的话（登录页显示的是同一条，见 web/store.js）。
      err.message = SESSION_EXPIRED_MESSAGE;
    }
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  subscribe(path, onMessage) {
    // SSE：单向推送，走普通 HTTP，穿透代理容易，EventSource 自带断线重连
    // ⚠️ SSE 端点在 **P2** 才实现（src/http/sse.js）—— P0/P1 调用会 404，不要在 P0/P1 用。
    const es = new EventSource(BASE + path);
    es.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { onMessage(e.data); }
    };
    return () => es.close();
  },
};

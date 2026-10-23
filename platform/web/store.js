// web/store.js — 极简响应式 store
//
// ⚠️ **会话失效的文案只有这一处**（F24 · 内部审计报告 §3.5）：
//   web/api.js 收到 401 时把 user 清空、置 `sessionExpired=true`、跳 #/login；
//   登录页（web/views/login.js）显示的提示与错误卡片里的文案都取自这里
//   ⇒ 不会出现「一处说会话过期、另一处说未登录」的两种口径。
export const SESSION_EXPIRED_MESSAGE = '会话已过期，请重新登录';

const state = {};
const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(getState());
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

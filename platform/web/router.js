// web/router.js — 哈希路由
const routes = [];

export function route(pattern, view) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ regex: new RegExp(`^${source}/?$`), names, view, pattern });
}

export function match(path) {
  const clean = (path || '').split('?')[0];
  for (const r of routes) {
    const hit = r.regex.exec(clean);
    if (!hit) continue;
    const params = {};
    // ⛔ 畸形百分号编码（如 '%E0%A4%A' / '%' / '%zz'）会让 decodeURIComponent 抛 URIError。
    //    这里若把异常抛出去 ⇒ 路由匹配在 app.js 的 `try` 块**之外**（历史缺陷）
    //    ⇒ 异常一路冒到事件回调 ⇒ **整页白屏**（连错误卡片都渲染不出来）。
    //    与服务端 `src/http/router.js` 的同一处理对齐：视为非法 URL ⇒ 该路由**不匹配**，
    //    交给上层渲染「页面不存在」卡片，而不是让整个页面崩掉。
    let malformed = false;
    r.names.forEach((n, i) => {
      if (malformed) return;
      try {
        params[n] = decodeURIComponent(hit[i + 1]);
      } catch {
        malformed = true;
      }
    });
    if (malformed) continue;   // 继续试下一条路由；都不匹配则最终返回 null
    return { view: r.view, params, pattern: r.pattern };
  }
  return null;
}

export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}

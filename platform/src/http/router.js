// src/http/router.js — 极简路由
// 依据：设计文档 §8「API 设计」+ INTERFACES.md「src/http/router.js」契约
//   （createRouter() → { add(method, pattern, handler), match(method, path), list() }；
//     pattern 形如 '/api/teams/:teamId/members'，:param 占位）。
//   路由优先级 = **逐段比较**：第一处不同的段上，静态段胜参数段。
//   （例：'/api/teams/me' 优先于 '/api/teams/:teamId'。）
// ⛔ Node 22 没有 URLPattern（Node 24 才有），所以手写。
//   不抬高运行时门槛 = 22 与 24 都能跑 = 可移植。
export function createRouter() {
  const routes = [];

  function compile(pattern) {
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${source}/?$`), names };
  }

  /**
   * 路由优先级比较器：**逐段比较**（2026-10-20 预审修正 C4-1）。
   *
   * ⛔ 不能比"参数段个数"，也不能比"pattern 字符串长度"：
   *    前者把参数路由排到静态路由前面（与静态优先相反），
   *    后者与静态优先无关 —— 两者都会让 `/api/leaderboard/rolling` 被
   *    `/api/leaderboard/:stageId` 劫持（发榜数据取错）。
   *
   * 规则（从左往右逐段比，第一处不同的段决定胜负）：
   *   ① 静态段胜参数段
   *   ② 两段都是静态但字面量不同（不可能同时匹配同一路径）→ 按字节序，保证确定性
   *   ③ 两段都是参数 → 继续比下一段
   *   ④ 一个 pattern 先结束（另一个是它的前缀）→ 短的在前（更具体）
   *   ⑤ 完全相同 → 保持注册顺序（Array.sort 稳定）
   *
   * 效果：同形状（同参数段数、同静态段数）的两条路由，先注册哪条都不影响匹配结果。
   */
  function compareRoutes(a, b) {
    const as = a.segments;
    const bs = b.segments;
    const len = Math.min(as.length, bs.length);
    for (let i = 0; i < len; i++) {
      const x = as[i];
      const y = bs[i];
      if (x === y) continue;
      const xIsParam = x.startsWith(':');
      const yIsParam = y.startsWith(':');
      if (xIsParam !== yIsParam) return xIsParam ? 1 : -1; // ① 静态段优先
      if (xIsParam && yIsParam) continue; // ③ 都是参数 → 看下一段
      return x < y ? -1 : 1; // ② 都是静态 → 字节序
    }
    return as.length - bs.length; // ④ 前缀 → 短的在前
  }

  return {
    add(method, pattern, handler) {
      const { regex, names } = compile(pattern);
      routes.push({
        method: method.toUpperCase(),
        pattern,
        segments: pattern.split('/'),
        regex,
        names,
        handler,
      });
      return this;
    },
    match(method, path) {
      const clean = path.split('?')[0];
      const m = method.toUpperCase();
      // 静态优先于参数：逐段比较（见 compareRoutes）
      const ordered = [...routes].sort(compareRoutes);
      for (const route of ordered) {
        if (route.method !== m) continue;
        const hit = route.regex.exec(clean);
        if (!hit) continue;
        const params = {};
        let malformed = false;
        route.names.forEach((name, i) => {
          if (malformed) return;
          try {
            params[name] = decodeURIComponent(hit[i + 1]);
          } catch {
            // ⛔ 畸形百分号编码（如 '%E0%A4%A'）会让 decodeURIComponent 抛 URIError。
            //    绝不能让它抛出到路由匹配之外：server.js 里 router.match 一旦在 try 块外，
            //    一个畸形 URL 就能让 Node 以未捕获异常退出（退出码 1）→ 整个服务器进程死亡。
            //    视为非法 URL → 该路由不匹配（match 返回 null），由上层回 400。
            malformed = true;
          }
        });
        if (malformed) return null;
        return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
    list() {
      return routes.map((r) => ({ method: r.method, pattern: r.pattern }));
    },
  };
}

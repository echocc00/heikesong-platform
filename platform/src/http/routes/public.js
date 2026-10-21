// src/http/routes/public.js — 公开接口（无需登录，token 鉴权）
// 依据：INTERFACES.md §6 的 P5 API 清单
// ⚠️ token 走 query 参数（契约如此）：部署时应在 nginx 层关掉 query 串的访问日志（P6 负责）。
import { getPublicLeaderboard } from '../../services/public-api.js';

export function registerPublicRoutes(router, { db, rules }) {
  router.add('GET', '/api/public/leaderboard', async ({ query }) =>
    getPublicLeaderboard({
      db,
      token: query.token,
      editionId: query.editionId,
      rules,
    }));
}

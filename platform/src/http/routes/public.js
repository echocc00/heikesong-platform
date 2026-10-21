// src/http/routes/public.js — 公开接口（无需登录，token 鉴权）
// 依据：INTERFACES.md §6 的 P5 API 清单
// ⚠️ token 走 query 参数（契约如此）：部署时应在 nginx 层关掉 query 串的访问日志（P6 负责）。
import { getPublicLeaderboard, buildICalendar, resolvePublicToken } from '../../services/public-api.js';

export function registerPublicRoutes(router, { db, rules }) {
  router.add('GET', '/api/public/leaderboard', async ({ query }) =>
    getPublicLeaderboard({
      db,
      token: query.token,
      editionId: query.editionId,
      rules,
    }));
  // 赛程日历（iCal）。⛔ 同样要 token：公开 ≠ 无鉴权。
  // 溯源：R-STG-01（5 赛段时间轴与交付物）—— 依据 INTERFACES.md §6 / 设计文档 §8
  router.add('GET', '/api/public/calendar.ics', async ({ query }) => {
    resolvePublicToken({
      db, token: query.token, requiredScope: 'calendar', editionId: query.editionId,
    });
    const body = buildICalendar({ db, editionId: query.editionId });
    return { __rawText: true, body, contentType: 'text/calendar; charset=utf-8' };
  });
}

// src/http/routes/public.js — 公开接口
//   ① /api/public/* —— **token 鉴权**的公开数据（榜单 / 日历）：公开 ≠ 无鉴权。
//   ② /api/event-info —— **免 token**的赛事规则说明（落地页用）：规则本来就该公开。
//
// ⚠️ token 走 query 参数（契约如此）：部署时应在 nginx 层关掉 query 串的访问日志（P6 负责）。
import { getPublicLeaderboard, buildICalendar, resolvePublicToken, getEventInfo } from '../../services/public-api.js';

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

  // ── P9：赛事规则说明（落地页）──────────────────────────────────
  // ⚠️ **为什么它不要 token，而上面两条要**：
  //   上面两条吐的是**比赛数据**（榜单行、赛程实例）⇒ 公开访问要有门槛（token 可撤销、可限范围）。
  //   这一条吐的是**规则本身**（赛段、权重、段位、漏斗）⇒ 参赛者有权知道「我按什么被评」，
  //   规则里**不含任何参赛数据**（白名单投影，见 getEventInfo）⇒ 匿名可读是应该的，
  //   而且落地页要给「还没注册的人」看 ⇒ 不能要求先有 token。
  //
  // ⛔ 它返回的是**配置投影**，不是数据库查询 ⇒ 无 db 依赖、无可见性过滤需求
  //    （规则不是「谁可见」的数据，是「大家都知道」的约定）。
  router.add('GET', '/api/event-info', async () => getEventInfo(rules));
}

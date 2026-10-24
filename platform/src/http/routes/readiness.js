// src/http/routes/readiness.js — S-7~S-10 业务就绪度端点（E181，2026-10-27）
//
// 规则溯源：设计文档 §1.3.1「S-7~S-10：怎么量、今天有没有机器检查」
//   · S-7 规模达标       → teams / registrations 行数
//   · S-8 评审无漏评     → stage_reviews 空缺 + 计算 trace 的 normalization 段
//   · S-9 按时发榜       → leaderboard_snapshots.created_at vs 赛段 ends_at
//   · S-10 闭环时效与产出 → appeals（SLA 字段已入库）+ milestone_signoffs + 行为分完赛认定
//
// ⛔ **权限口径**：`audit:read`（**只有组委会持有**，见 scripts/seed.js 的 ROLE_CAPABILITIES）
//    —— 这份汇总里含「哪些赛段没发榜」「哪些格子没评分」这类**内部运营信息**。
//    ⇒ 未登录 → 401；有登录但无能力点 → 403（**不是** 200 + 空集 ——
//      空集会被误读成「都达标了」，那是本文件最危险的误读方向）。
//
// ⚠️ **为什么是独立端点而不是塞进 /api/audit/log**：
//    ① 口径完全不同（一个是审计行，一个是**按赛段聚合的业务指标**）；
//    ② 权限不同（审计日志是审计:read 起步，复核队列是 audit:write 才能裁决）；
//    ③ 形状不同（聚合结构 vs 分页行）⇒ 混在一起会让前端拿到两套没法对齐的数组。
//
// ⛔ **可见性在 API 层过滤（白名单，fail-closed）**：本端点只吐**聚合数与 id**，
//    **不吐**任何队伍的名称、手机号、分数明细（明细走各自的既有端点，那里才有可见性规则）。
import { listEditions } from '../../db/repo/editions.js';
import { can } from '../../auth/permissions.js';
import { unauthenticated, forbidden, notFound } from '../../errors.js';
import { readinessSummary } from '../../services/readiness.js';
import { pickCurrentEdition } from './registration.js';

function requireLogin(user) {
  if (!user) throw unauthenticated();
}

export function registerReadinessRoutes(router, { db, rules }) {
  router.add('GET', '/api/readiness', async ({ user, query }) => {
    requireLogin(user);
    // ⛔ 无 `audit:read` ⇒ 403（不是空集）：空集会被读成「各项都达标」。
    if (!can(user, 'audit:read', null, db)) throw forbidden('无权查看业务就绪度汇总');

    // 届期口径与注册端点一致：**当届** = 尚未结束的最早一届，都没有就退回最后一届。
    // ⚠️ 允许显式传 `?editionId=` 查历史届期（组委会要复盘上一届时用）。
    const editions = listEditions(db);
    const edition = query?.editionId
      ? editions.find((e) => e.id === query.editionId) ?? null
      : pickCurrentEdition(editions);
    if (query?.editionId && !edition) {
      // 显式指定了不存在的届期 ⇒ 404（不静默退回「当届」—— 那会查错届期而不报错）
      throw notFound(`届期不存在：${query.editionId}`);
    }
    return readinessSummary({
      db,
      editionId: edition?.id ?? null,
      rules,
      now: new Date().toISOString(),
    });
  });
}

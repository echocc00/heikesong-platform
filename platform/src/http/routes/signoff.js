// src/http/routes/signoff.js — 企业签字台（读端点）
//
// 依据：P10 · W4-b「企业双签界面 + 里程碑签字界面（含撤回）」
//   + db/migrations/003_review.sql 的 enterprise_confirmations 表注释
//   + src/services/milestone.js（里程碑签字 = 客观事实、单签、不进总分）
//   + src/http/routes/review.js（企业确认 = 主观评分、双签、进总分）
//
// ⚠️ **只新增读端点**：写端点（里程碑签字 / 撤回签字 / 企业确认）**早就存在**，
//   本文件**一个字都不改**它们 —— 缺的是「界面」与「读口」，不是「写口」。
//
// ⚠️ **为什么必须补读口**（P9 真机取证：31 个「只有接口没有界面」）：
//   前端要调 `POST /api/milestones/:id/signoff` 就必须先知道 **milestoneId**，
//   要调 `POST /api/milestones/:id/signoff/withdraw` 就必须先知道 **signoffId**，
//   要凑齐 R2 双签就必须知道**本赛段有哪些别的评委**（crossJudgeId）。
//   而现有的读端点一个都不给这三个值（详见 src/db/repo/signoff-board.js 的文件头）。
//
// ⚠️ **GET 与 POST 同路径不冲突**：路由表按 **method + path** 匹配
//   （src/http/router.js 的 match() 里 `route.method !== m` 直接跳过），
//   所以 `GET /api/stages/:stageId/enterprise-confirmations` 与
//   `POST /api/stages/:stageId/enterprise-confirmations` 可以并存。
//
// ⚠️ **三态状态码**（设计文档 §7.3）：
//   列表 200 + 空集 ｜ 单条 404（赛段不存在）｜ 禁用 403（没有能力点）。
import { AppError } from '../../errors.js';
import {
  getSignoffWorklist,
  getEnterpriseConfirmationBoard,
} from '../../services/signoff-board.js';

/**
 * 注册企业签字台的读端点。
 * @param {object} router createRouter() 的返回值
 */
export function registerSignoffRoutes(router) {
  // ── 我要签的里程碑（企业席签字台）────────────────────────────────
  router.add('GET', '/api/signoffs/mine', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return getSignoffWorklist({ db: ctx.db, viewer: ctx.user });
  });

  // ── 某赛段的企业双签待签清单 ────────────────────────────────────
  router.add('GET', '/api/stages/:stageId/enterprise-confirmations', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return getEnterpriseConfirmationBoard({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: ctx.user,
      rules: ctx.rules,
    });
  });
}

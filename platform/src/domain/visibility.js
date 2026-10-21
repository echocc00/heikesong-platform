// src/domain/visibility.js — 可见性过滤（纯函数，★ 唯一过滤入口）
// 依据：设计文档 §6.6 + S10 §0.3 分层公开 + §0.4 互评来源 + §8 风险表
//   + 冲突裁决 C-02（C 段及以上公示名次；D 段只给本人进度卡）
//   ⛔ 可见性必须在 API 层过滤：前端隐藏 = 数据已经发到浏览器 = 任何人都能看到。
//      前端只负责渲染，不承担过滤职责。
import { omit } from './util.js';

const DEFAULT_TIER_ORDER = ['D', 'C', 'B', 'A', 'S'];
// 互评来源字段：visibility.peerReview.showSource=false 时清空
const PEER_SOURCE_KEYS = ['peerSource', 'fromTeamId', 'fromUserId', 'peerFrom', 'peerScore'];
// 企业名字段：段位公示时不公示（S10 §8）
const ENTERPRISE_NAME_KEYS = ['enterpriseName', 'enterprise_name', 'enterpriseId', 'enterprise_id'];

/**
 * @param payload    { scope, rows: [...] }
 * @param viewer     当前查看者（可为 null = 未登录 / 旁观）
 * @param visibilityConfig rules.visibility
 * @param context    { scope, viewerTeamIds?, viewerTeamId?, tierOrder? }
 */
export function applyVisibility({ payload, viewer, visibilityConfig, context }) {
  const cfg = visibilityConfig || {};
  const ctx = context || {};
  const scope = ctx.scope || payload?.scope || 'rank';
  const tierOrder = (Array.isArray(ctx.tierOrder) && ctx.tierOrder.length) ? ctx.tierOrder : DEFAULT_TIER_ORDER;
  const viewerTeamIds = new Set([
    ...(Array.isArray(ctx.viewerTeamIds) ? ctx.viewerTeamIds : []),
    ...(ctx.viewerTeamId ? [ctx.viewerTeamId] : []),
    ...(viewer?.teamId ? [viewer.teamId] : []),
  ]);

  // ⚠️ 默认必须是【关】而不是【开】：可见性是「不公示」才安全。
  //    「前端隐藏 = 数据已泄露」—— 配置里没写这个字段时，按「关」处理（fail-closed），
  //    宁可少公示也不能因为漏配就把互评来源 / 企业名直接发出去。
  //    （business.scoresPublic / signatoryPublic 一直是 fail-closed，这里对齐口径。）
  const peerKeys = cfg.peerReview?.showSource !== true ? PEER_SOURCE_KEYS : [];
  const entKeys = cfg.rank?.showEnterpriseName !== true ? ENTERPRISE_NAME_KEYS : [];

  const src = Array.isArray(payload?.rows) ? payload.rows : [];
  const out = { ...(payload || {}), rows: [] };
  let rows = src;

  if (scope === 'rank') {
    // A 榜与滚动总榜：全员公开（任务书 §七 明文）
    rows = src.map((r) => omit(r, [...peerKeys, ...entKeys]));
  } else if (scope === 'business') {
    // B 榜：里程碑进度公开；评分与签字人不公开；企业名不公示
    const drop = [...peerKeys];
    if (cfg.business?.scoresPublic !== true) drop.push('score', 'rawScore', 'raw_score', 'seatE', 'seatP', 'total', 'enterpriseRaw');
    if (cfg.business?.signatoryPublic !== true) drop.push('signatory', 'signatoryUserId', 'signatoryName', 'signatory_user_id', 'signedBy');
    rows = src.map((r) => omit(r, [...drop, ...entKeys]));
  } else if (scope === 'tier') {
    // 段位榜：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡
    const fromIdx = Math.max(0, tierOrder.indexOf(cfg.rank?.publicFromTier || 'C'));
    const visible = [];
    let self = null;
    for (const r of src) {
      const idx = tierOrder.indexOf(r.tier);
      if (idx >= 0 && idx >= fromIdx) {
        visible.push(omit(r, [...peerKeys, ...entKeys]));
      } else if (viewerTeamIds.has(r.teamId)) {
        self = {
          ...omit(r, [...peerKeys, ...entKeys, 'rank', 'tierRank', 'teamName']),
          teamId: r.teamId,
          tier: r.tier,
          progress: r.progress ?? null,
          self: true,
        };
      }
    }
    rows = visible;
    if (self) out.selfProgress = self;
  } else if (scope === 'personal') {
    // 个人榜：终生上榜，但手机号与单位不外泄
    rows = src.map((r) => ({
      ...omit(r, [...peerKeys, 'phone', 'org', 'idCard', 'password_hash']),
      isSelf: Boolean(viewer && r.userId === viewer.id),
    }));
  } else {
    rows = src.map((r) => omit(r, peerKeys));
  }

  out.rows = rows;
  return out;
}

// web/views/tier.js — 段位榜
// 依据：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡。
// ⛔ 前端不隐藏 D 段，而是【不渲染】它：D 段根本不会出现在 API 返回的 rows 里。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）。
import { escapeHtml } from '../escape.js';

export function tierHtml(model) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const self = model?.selfProgress || null;
  const board = rows.length
    ? `<table class="board tier-board"><thead><tr><th>名次</th><th>队伍</th><th>段位</th></tr></thead><tbody>`
      + rows.map((r) => `<tr><td class="rank">${escapeHtml(r.tierRank)}</td><td class="name">${escapeHtml(r.teamName || r.teamId)}</td><td class="tier">${escapeHtml(r.tier)}</td></tr>`).join('')
      + `</tbody></table>`
    : '<p class="muted">暂无数据</p>';
  const selfCard = self
    ? `<div class="card self-progress"><h3>本人进度</h3><p>当前段位：<strong>${escapeHtml(self.tier)}</strong></p>`
      + `<ul>${(self.progress?.milestones || []).map((m) => `<li>${escapeHtml(m.label)}</li>`).join('')}</ul></div>`
    : '';
  return `<section class="tier-view"><h2>段位榜</h2>`
    + `<p class="muted">C 段及以上公示队名与名次；D 段只公示个人进度，不公示排名。</p>${board}${selfCard}</section>`;
}

export async function renderTier(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  // ⚠️ 届期缺省取「当届」由服务端解析（resolveEditionId）
  const edition = ctx.query?.editionId ? `?editionId=${encodeURIComponent(ctx.query.editionId)}` : '';
  try {
    wrap.innerHTML = tierHtml(await ctx.api.get(`/api/leaderboard/tier${edition}`));
  } catch (e) {
    wrap.innerHTML = `<section class="tier-view"><p class="err">${escapeHtml(e.message)}</p></section>`;
  }
  return wrap;
}

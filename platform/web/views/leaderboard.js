// web/views/leaderboard.js — 榜单页（A 榜 / B 榜 / 个人榜 + 滚动总榜）
// ⛔ 前端只渲染，不做过滤：可见性已在 API 层完成。
// ⛔ 降级告警置顶：P2 计算出的 warnings 显式展示在最上方，不静默（S-5 / C-05）。
//
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）——
//    这里**不重复定义** escapeHtml：三个视图各写一份会漂移，且漏改一处就是一处 XSS。
import { escapeHtml } from '../escape.js';

function warningsHtml(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return '';
  const items = list.map((w) => `<li class="warn-item"><span class="warn-code">${escapeHtml(w.code || 'WARN')}</span> <span class="warn-msg">${escapeHtml(w.message || '')}</span></li>`).join('');
  return `<div class="warnings" role="alert"><h3>⚠ 本轮降级提示（${list.length}）</h3><ul>${items}</ul></div>`;
}

function rankRowsHtml(rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  const body = rows.map((r) => {
    const tied = Array.isArray(r.tiedWith) && r.tiedWith.length ? '（并列）' : '';
    const pkg = r.packageRank ? `包内第 ${escapeHtml(r.packageRank)} 名` : '';
    return `<tr><td class="rank">${escapeHtml(r.rank)}</td><td class="name">${escapeHtml(r.teamName || r.teamId)}${tied}</td>`
      + `<td class="total">${escapeHtml(r.total)}</td><td class="points">${escapeHtml(r.points)}</td>`
      + `<td class="tier">${escapeHtml(r.tier || '')}</td><td class="pkg">${pkg}</td></tr>`;
  }).join('');
  return `<table class="board"><thead><tr><th>名次</th><th>队伍</th><th>总分</th><th>积分</th><th>段位</th><th>包内</th></tr></thead><tbody>${body}</tbody></table>`;
}

function businessRowsHtml(rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  return `<div class="biz-grid">${rows.map((r) => {
    const items = (r.milestones || []).map((m) => `<li class="${m.achieved ? 'done' : 'todo'}"><span class="mark">${m.achieved ? '☑' : '☐'}</span>${escapeHtml(m.label)}</li>`).join('');
    return `<div class="card biz-card"><h3>${escapeHtml(r.teamName || r.teamId)}</h3><ul class="milestones">${items}</ul>`
      + `<p class="muted">达成 ${escapeHtml(r.achievedCount)} / ${escapeHtml(r.milestoneCount)}</p></div>`;
  }).join('')}</div>`;
}

function personalRowsHtml(rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  const body = rows.map((r) => `<tr><td class="rank">${escapeHtml(r.rank)}</td><td class="name">${escapeHtml(r.name || r.userId)}${r.isSelf ? '（我）' : ''}</td><td class="total">${escapeHtml(r.total)}</td></tr>`).join('');
  return `<table class="board"><thead><tr><th>名次</th><th>选手</th><th>个人积分</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** 纯函数渲染（可单测） */
export function leaderboardHtml(model) {
  const scope = model?.scope || 'rank';
  const body = scope === 'business' ? businessRowsHtml(model?.rows || [])
    : scope === 'personal' ? personalRowsHtml(model?.rows || [])
      : rankRowsHtml(model?.rows || []);
  const title = scope === 'business' ? 'B 榜 · 商业战绩'
    : scope === 'personal' ? '个人积分榜'
      : scope === 'rolling' ? '滚动总榜 · 全赛段累计'
        : 'A 榜 · 赛段名次';
  return `<section class="board-view">${warningsHtml(model?.warnings)}<h2>${title}</h2>${body}</section>`;
}

/** 挂载（真实 API） */
export async function renderLeaderboard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  const stageId = ctx.params?.stageId || '';
  const scope = ctx.query?.scope || 'rank';
  // ⚠️ 届期缺省取「当届」由服务端解析（resolveEditionId），前端不必先查届期
  const edition = ctx.query?.editionId ? `?editionId=${encodeURIComponent(ctx.query.editionId)}` : '';
  const url = stageId
    ? `/api/leaderboard/${encodeURIComponent(stageId)}?scope=${encodeURIComponent(scope)}`
    : `/api/leaderboard/rolling${edition}`;
  try {
    const data = await ctx.api.get(url);
    wrap.innerHTML = leaderboardHtml({ ...data, scope: stageId ? scope : 'rolling' });
  } catch (e) {
    wrap.innerHTML = `<section class="board-view"><p class="err">${escapeHtml(e.message)}</p></section>`;
  }
  return wrap;
}

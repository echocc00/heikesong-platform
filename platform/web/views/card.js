// web/views/card.js — 项目商业战绩卡
// 依据：设计文档 §9「7 类里程碑勾选式 + 企业签字标识 + 不显示签字人」
// ⛔ 不渲染签字人字段（企业签字不公开，R-ENT-04 / S10 §0.3）。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）。
import { escapeHtml } from '../escape.js';

export function cardHtml(model) {
  const items = Array.isArray(model?.items) ? model.items : [];
  const list = items.map((m) => `<li class="${m.achieved ? 'done' : 'todo'}"><span class="mark">${m.achieved ? '☑' : '☐'}</span>`
    + `<span class="label">${escapeHtml(m.label)}</span>${m.signed ? '<span class="signed">已签</span>' : ''}</li>`).join('');
  const benefits = (model?.benefits || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  const never = (model?.neverUnlocks || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  return `<section class="card-view"><h2>${escapeHtml(model?.teamName || '')} · 商业战绩卡</h2>`
    + `<p class="muted">当前段位：<strong>${escapeHtml(model?.tier || '')}</strong></p>`
    + `<ul class="milestones">${list || '<li class="muted">暂无里程碑</li>'}</ul>`
    + `<p class="muted">达成 ${escapeHtml(model?.achievedCount)} / ${escapeHtml(model?.total)}</p>`
    + `<div class="benefits"><h3>已解锁权益</h3><ul>${benefits || '<li class="muted">暂无</li>'}</ul>`
    + `<h3>永不解锁</h3><ul>${never || '<li class="muted">暂无</li>'}</ul></div></section>`;
}

export async function renderCard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  try {
    const data = await ctx.api.get(`/api/teams/${encodeURIComponent(ctx.params?.teamId || '')}/performance-card`);
    wrap.innerHTML = cardHtml(data);
  } catch (e) {
    wrap.innerHTML = `<section class="card-view"><p class="err">${escapeHtml(e.message)}</p></section>`;
  }
  return wrap;
}

// web/views/tier.js — 段位榜
// 依据：冲突裁决 C-02 —— C 段及以上公示队名与名次；D 段不公示排名，只给本人进度卡。
//   + 本轮（P7）「现有页面打磨到生产级」：外壳三件套 + 页头 + 指标行 + 设计系统表格。
// ⛔ 前端不隐藏 D 段，而是【不渲染】它：D 段根本不会出现在 API 返回的 rows 里
//   （可见性在 API 层裁决，设计文档 §6.6 / C-02）⇒ 视图**不许自己 filter**。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, pageHead, panel,
  rankBadge, sectionTitle, statRow, tableWrap,
} from '../ui.js';

/**
 * 段位 → 徽章色调（**全站唯一一份**）。
 *
 * ⚠️ 为什么住在段位视图里：段位徽章是「段位语义」的映射，
 *    榜单页（./leaderboard.js）与战绩卡（./card.js）都要用同一套 ——
 *    否则同一个 A 段在三个页面颜色不同，读者会以为它们是不同段位。
 *    ⇒ 这里导出，那两个视图 import（视图之间**只共享这一份语义映射**，不共享渲染逻辑）。
 *
 * 映射口径（依据：设计文档 §9「段位 S / A / B / C / D」的强弱次序）：
 *    S / A → brand（顶尖）｜ B → info ｜ C → success（刚够公示名次）｜ D → neutral（未公开）
 */
const TIER_TONES = { S: 'brand', A: 'brand', B: 'info', C: 'success', D: 'neutral' };

/** 段位 → 色调；未知段位一律 neutral（颜色静默失效比样式错更糟）。 */
export function tierTone(tier) {
  return TIER_TONES[String(tier ?? '').trim().toUpperCase()] ?? 'neutral';
}

/** 段位徽章；空段位不渲染徽章（免得出现一个没有意义的空胶囊）。 */
export function tierBadge(tier) {
  const text = String(tier ?? '').trim();
  return text ? badge(text, tierTone(text)) : '';
}

/**
 * 段位榜渲染（纯函数，可单测）。
 *
 * ⚠️ `model.loading` / `model.error` 是**视图自有的状态位**（不属于 API 返回形状）——
 *    纯函数没法发请求，就靠这两个位表达外壳三件套；
 *    测试直接喂 API 形状时它们都是 undefined ⇒ 走正常渲染分支。
 */
export function tierHtml(model) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const self = model?.selfProgress || null;

  const head = pageHead({
    title: '段位榜',
    sub: 'C 段及以上公示队名与名次；D 段只公示本人进度，不公示排名（C-02）。',
    actions: [{ label: '看榜单', href: '#/leaderboard' }],
  });
  if (model?.loading) return `${head}${loadingState({ rows: 3, label: '正在加载段位榜…' })}`;
  if (model?.error) return `${head}${errorState({ message: model.error })}`;

  const board = rows.length
    ? tableWrap(
      `<thead><tr><th>名次</th><th>队伍</th><th>段位</th><th class="td-num">里程碑</th></tr></thead>`
      + `<tbody>${rows.map((r) => `<tr>`
        + `<td>${rankBadge(r.tierRank)}</td>`
        + `<td>${escapeHtml(r.teamName || r.teamId)}</td>`
        + `<td>${tierBadge(r.tier)}</td>`
        + `<td class="td-num num">${escapeHtml(r.milestoneCount ?? '—')}</td>`
        + `</tr>`).join('')}</tbody>`,
      { caption: '段位榜：C 段及以上公示队名与名次' },
    )
    : emptyState({
      title: '暂无数据',
      hint: '还没有可公示的段位记录 —— 队伍完成里程碑并经企业确认后，段位会在发榜时出现在这里。',
    });

  // ⚠️ selfProgress 是 D 段选手**唯一**能看到的自己的信息（视图不渲染别人），
  //    所以它必须自成一块、说清「这是你的」。
  const selfPanel = self
    ? panel({
      title: '本人进度',
      desc: '仅你可见：当前段位与里程碑清单（达成状态以发榜结果为准）。',
      body: selfBodyHtml(self),
    })
    : '';

  return `${head}${statRow(tierStats(rows))}`
    + `${panel({ title: '公示榜单', desc: '按段位从高到低排列，名次为段位榜名次。', body: board })}`
    + `${selfPanel}`;
}

/**
 * 指标行：公示队伍总数 + 各段位队伍数。
 * ⚠️ 只统计**确实出现在 rows 里**的段位：给没出现的段位写 0 是假数据
 *    （D 段队伍的数前端根本看不到 —— API 不返回它们）。
 */
function tierStats(rows) {
  const counts = new Map();
  for (const r of rows) {
    const t = String(r?.tier ?? '').trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const cards = [{ label: '公示队伍', value: rows.length, tone: 'brand', hint: 'C 段及以上' }];
  for (const t of ['S', 'A', 'B', 'C', 'D']) {
    if (!counts.has(t)) continue;
    cards.push({ label: `${t} 段`, value: counts.get(t), tone: tierTone(t) });
  }
  return cards;
}

/** 本人进度面板内容。 */
function selfBodyHtml(self) {
  const ms = Array.isArray(self?.progress?.milestones) ? self.progress.milestones : [];
  const counted = self?.milestoneCount ?? self?.progress?.milestoneCount;
  const items = ms.map((m) => `<li class="todo"><span class="mark" aria-hidden="true">·</span>`
    + `<span>${escapeHtml(m.label)}</span></li>`).join('');
  return `<div class="row row--between">
      <span class="muted small">当前段位</span>
      ${tierBadge(self?.tier) || '<span class="muted">—</span>'}
    </div>
    <p class="muted small">已计分里程碑 ${escapeHtml(counted ?? '—')} 项</p>
    <ul class="milestones">${items || '<li class="muted">暂无数据</li>'}</ul>`;
}

/** 挂载（真实 API / 演示适配器） */
export async function renderTier(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'tier-view';
  // ⚠️ 届期缺省取「当届」由服务端解析（resolveEditionId）
  const edition = ctx.query?.editionId ? `?editionId=${encodeURIComponent(ctx.query.editionId)}` : '';

  const load = async () => {
    wrap.innerHTML = tierHtml({ loading: true });
    try {
      wrap.innerHTML = tierHtml(await ctx.api.get(`/api/leaderboard/tier${edition}`));
    } catch (e) {
      wrap.innerHTML = tierHtml({ error: e.message });
    }
    // ⚠️ 错误态的重试按钮必须真的能重跑（生产级错误态不能是死路一条）
    wrap.querySelector('[data-action="retry"]')?.addEventListener('click', () => { load().catch(() => {}); });
  };
  await load();
  return wrap;
}

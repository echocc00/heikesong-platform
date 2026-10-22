// web/views/leaderboard.js — 榜单页（A 榜 / B 榜 / 个人榜 + 滚动总榜）
//
// 依据：本轮（P7）「现有页面打磨到生产级」
//   + 设计文档 §9「榜单页：口径切换 + 赛段选择 + 降级告警置顶」+ §12 三件套
//   + S-5 / C-05「降级状态必须显式展示，不静默」
//
// ⛔ 前端只渲染，不做过滤：可见性已在 API 层完成（设计文档 §6.6）。
// ⛔ 降级告警置顶：P2 计算出的 warnings 显式展示在最上方，不静默（S-5 / C-05）。
//    ⚠️ **位置是硬契约**：测试断言「告警的字符索引 < 队名的字符索引」，
//        所以告警块必须排在整页最前（页头之前），不能塞到表格下面。
// ⚠️ 口径切换靠 URL（?scope=）而不是前端状态机 —— 刷新 / 分享链接都停在同一屏。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）——
//    这里**不重复定义** escapeHtml：三个视图各写一份会漂移，且漏改一处就是一处 XSS。
import { escapeHtml } from '../escape.js';
import { milestoneMark } from '../icons.js';
import {
  barRow, emptyState, errorState, loadingState, noticeState, pageHead,
  rankBadge, sectionTitle, statRow, tableWrap, tabs,
} from '../ui.js';
// ⚠️ 段位徽章的映射住在 ./tier.js（段位语义的归属地），这里只取用不重复定义。
import { tierBadge } from './tier.js';

/**
 * 口径元数据（纯数据）：标题 / 副标题 / 空态口径。
 * ⚠️ 标题语义是既有契约：rank → A 榜、business → B 榜 · 商业战绩、
 *    personal → 个人积分榜、rolling → 滚动总榜 · 全赛段累计（沿用打磨前的措辞）。
 */
const SCOPES = {
  rank: {
    id: 'rank',
    label: 'A 榜',
    title: 'A 榜 · 赛段名次',
    sub: '本赛段名次：按总分排名，积分按赛段规则发放。',
    empty: '本赛段还没有发榜 —— 组委会完成该赛段的评审、计算与发榜后，榜单会出现在这里。',
  },
  business: {
    id: 'business',
    label: 'B 榜',
    title: 'B 榜 · 商业战绩',
    sub: '商业战绩：里程碑达成进度公示（评分与签署细节不公开）。',
    empty: '本赛段还没有商业里程碑记录 —— 企业确认后，这里会公示每支队伍的里程碑进度。',
  },
  personal: {
    id: 'personal',
    label: '个人榜',
    title: '个人积分榜',
    sub: '个人积分榜：按届期累计的个人积分排名，终生上榜。',
    empty: '本届还没有个人积分 —— 赛段发榜后积分会累计到个人名下。',
  },
  rolling: {
    id: 'rolling',
    label: '滚动总榜',
    title: '滚动总榜 · 全赛段累计',
    sub: '滚动总榜：跨全部赛段累计积分，任意赛段发榜后自动更新。',
    empty: '本届还没有已发榜的赛段 —— 任意一个赛段发榜后，总榜会自动出现。',
  },
};

/**
 * 降级告警（置顶）。
 * ⚠️ 滚动总榜的告警来自【多个赛段】，必须标出是哪一段降级了（否则读者不知道该查哪段）。
 *    赛段榜 / B 榜 / 个人榜的告警没有 stageName → 不渲染这一段。
 */
function warningsHtml(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return '';
  const items = list.map((w) => {
    const stage = w?.stageName ? `【${w.stageName}】` : '';
    const code = w?.code ? `[${w.code}] ` : '';
    return `${stage}${code}${w?.message ?? ''}`;
  });
  return noticeState({
    tone: 'warn',
    title: `本轮降级提示（${list.length}）—— 以下维度未按标准口径计算`,
    items,
    list: true,
  });
}

/** 页头（标题 + 副标题 + 跨页入口）。 */
function headHtml(meta) {
  return pageHead({
    title: meta.title,
    sub: meta.sub,
    actions: [{ label: '段位榜', href: '#/tier' }, { label: '总览', href: '#/' }],
  });
}

/**
 * 口径切换（tabs）。
 * ⚠️ 靠 URL 而不是前端状态机：刷新不丢状态、链接可分享。
 * ⚠️ 赛段口径（A/B/个人）必须带上赛段 id —— 滚动总榜是**届期级**的，没有赛段维度。
 */
function scopeTabsHtml(scope, stageId, stages) {
  const target = stageId || stages[0]?.id || '';
  const link = (id) => (target
    ? `#/leaderboard/${encodeURIComponent(String(target))}?scope=${id}`
    : `#/leaderboard?scope=${id}`);
  return tabs({
    items: [
      { id: 'rank', label: SCOPES.rank.label, href: link('rank') },
      { id: 'business', label: SCOPES.business.label, href: link('business') },
      { id: 'personal', label: SCOPES.personal.label, href: link('personal') },
      { id: 'rolling', label: SCOPES.rolling.label, href: '#/leaderboard?scope=rolling' },
    ],
    active: scope,
  });
}

/**
 * 赛段选择器。
 * ⚠️ 拉不到赛段列表时**静默降级**（返回空串）：赛段列表挂了不能让整个榜单页报错。
 * ⚠️ 滚动总榜是届期级的 ⇒ 此时点某个赛段 = 切到那个赛段的 A 榜。
 */
function stagePickerHtml(scope, stageId, stages) {
  if (!stages.length) return '';
  const stageScope = scope === 'rolling' ? 'rank' : scope;
  const current = scope === 'rolling' ? '' : String(stageId ?? '');
  const items = stages.map((s) => {
    const id = String(s?.id ?? '');
    const label = s?.name || s?.key || id;
    const href = `#/leaderboard/${encodeURIComponent(id)}?scope=${stageScope}`;
    return id === current
      ? `<span class="btn btn--primary btn--sm" aria-current="page">${escapeHtml(label)}</span>`
      : `<a class="btn btn--ghost btn--sm" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
  return `<div class="row"><span class="muted small">赛段</span><div class="btn-group">${items.join('')}</div></div>`;
}

/** 指标行：一眼可见的队伍数 / 分数 / 降级条数。 */
function statsHtml(scope, rows, warnings) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const totals = rows.map((r) => num(r?.total)).filter((v) => v !== null);
  const points = rows.map((r) => num(r?.points)).filter((v) => v !== null);
  const max = (arr) => (arr.length ? Math.max(...arr) : null);
  const warnCount = Array.isArray(warnings) ? warnings.length : 0;
  const cards = [];

  if (scope === 'personal') {
    const self = rows.find((r) => r?.isSelf);
    cards.push({ label: '上榜选手', value: rows.length, tone: 'brand' });
    cards.push({ label: '最高个人积分', value: max(totals) ?? '—', tone: 'success' });
    cards.push({ label: '我的名次', value: self?.rank ?? '—' });
  } else if (scope === 'business') {
    const done = rows.reduce((acc, r) => acc + (num(r?.achievedCount) ?? 0), 0);
    const all = rows.reduce((acc, r) => acc + (num(r?.milestoneCount) ?? 0), 0);
    cards.push({ label: '上榜队伍', value: rows.length, tone: 'brand' });
    cards.push({ label: '里程碑达成', value: done, tone: 'success', hint: `共 ${all} 项` });
    cards.push({ label: '有进展队伍', value: rows.filter((r) => (num(r?.achievedCount) ?? 0) > 0).length });
  } else if (scope === 'rolling') {
    const stages = rows.map((r) => num(r?.stages)).filter((v) => v !== null);
    cards.push({ label: '在榜队伍', value: rows.length, tone: 'brand' });
    cards.push({ label: '最高累计积分', value: max(points) ?? '—', tone: 'success' });
    cards.push({ label: '最多参赛赛段', value: max(stages) ?? '—' });
  } else {
    cards.push({ label: '在榜队伍', value: rows.length, tone: 'brand' });
    cards.push({ label: '榜首总分', value: max(totals) ?? '—', tone: 'success' });
    cards.push({ label: '最高积分', value: max(points) ?? '—' });
  }
  cards.push({
    label: '降级告警',
    value: warnCount,
    tone: warnCount ? 'warn' : 'neutral',
    hint: '降级必须显式处理，不静默',
  });
  return statRow(cards);
}

/** A 榜（赛段名次）表格。 */
function rankRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const body = rows.map((r, i) => {
    // ⚠️ 名次：优先用 API 给的 rank；滚动总榜没有 rank 字段 ⇒ 用行序兜底
    const rank = r?.rank ?? i + 1;
    const tied = Array.isArray(r?.tiedWith) && r.tiedWith.length;
    const pkg = r?.packageRank ? `包内第 ${escapeHtml(r.packageRank)} 名` : '—';
    return `<tr>`
      + `<td>${rankBadge(rank)}</td>`
      + `<td>${escapeHtml(r?.teamName || r?.teamId)}`
      + `${tied ? ' <span class="muted small">（并列）</span>' : ''}</td>`
      + `<td class="td-num num">${escapeHtml(r?.total ?? '—')}</td>`
      + `<td class="td-num num">${escapeHtml(r?.points ?? '—')}</td>`
      + `<td>${tierBadge(r?.tier)}</td>`
      + `<td class="td-num num">${pkg}</td>`
      + `</tr>`;
  }).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">总分</th>`
    + `<th class="td-num">积分</th><th>段位</th><th class="td-num">包内</th></tr></thead>`
    + `<tbody>${body}</tbody>`,
    { caption: 'A 榜：本赛段名次' },
  );
}

/** 滚动总榜表格（届期级：累计积分 + 参赛赛段数 + 最好名次）。 */
function rollingRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const body = rows.map((r, i) => {
    const rank = r?.rank ?? i + 1;
    const best = r?.bestRank ?? '—';
    return `<tr>`
      + `<td>${rankBadge(rank)}</td>`
      + `<td>${escapeHtml(r?.teamName || r?.teamId)}</td>`
      + `<td class="td-num num">${escapeHtml(r?.points ?? '—')}</td>`
      + `<td class="td-num num">${escapeHtml(r?.stages ?? '—')}</td>`
      + `<td class="td-num num">${escapeHtml(best)}</td>`
      + `<td>${tierBadge(r?.tier)}</td>`
      + `</tr>`;
  }).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">累计积分</th>`
    + `<th class="td-num">参赛赛段</th><th class="td-num">最好名次</th><th>段位</th></tr></thead>`
    + `<tbody>${body}</tbody>`,
    { caption: '滚动总榜：全赛段累计' },
  );
}

/** 个人榜表格。 */
function personalRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const body = rows.map((r, i) => `<tr>`
    + `<td>${rankBadge(r?.rank ?? i + 1)}</td>`
    + `<td>${escapeHtml(r?.name || r?.userId)}`
    + `${r?.isSelf ? ' <span class="muted small">（我）</span>' : ''}</td>`
    + `<td class="td-num num">${escapeHtml(r?.total ?? '—')}</td>`
    + `</tr>`).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>选手</th><th class="td-num">个人积分</th></tr></thead>`
    + `<tbody>${body}</tbody>`,
    { caption: '个人积分榜' },
  );
}

/** B 榜（商业战绩）：卡片网格 —— 每支队伍一张进度卡。 */
function businessRowsHtml(rows, meta) {
  if (!rows.length) return emptyState({ title: '暂无数据', hint: meta.empty });
  const cards = rows.map((r) => {
    const ms = Array.isArray(r?.milestones) ? r.milestones : [];
    const done = ms.filter((m) => m?.achieved);
    const items = ms.map((m) => `<li class="${m?.achieved ? 'done' : 'todo'}">`
      + `<span class="mark">${milestoneMark(Boolean(m?.achieved))}</span>`
      + `<span>${escapeHtml(m?.label)}</span></li>`).join('');
    const total = r?.milestoneCount ?? ms.length;
    return `<article class="card biz-card">
      <div class="row row--between">
        <h3>${escapeHtml(r?.teamName || r?.teamId)}</h3>
        ${tierBadge(r?.tier)}
      </div>
      ${barRow({
        label: '里程碑达成',
        value: r?.achievedCount ?? done.length,
        max: total,
        // ⚠️ 备注改成「共 N」（不是「/ N」）：条形图的值与备注是相邻的两段文本，
        //    「/ N」拼上去会变成「3/ 5」这种怪读法；「共 5」更清楚。
        note: `共 ${total}`,
        tone: 'success',
      })}
      <ul class="milestones">${items || '<li class="muted">暂无数据</li>'}</ul>
    </article>`;
  }).join('');
  return `<div class="grid grid--2">${cards}</div>`;
}

/**
 * 榜单页渲染（纯函数，可单测）。
 *
 * ⚠️ model.loading / model.error 是**视图自有的状态位**（不属于 API 返回形状）——
 *    纯函数没法发请求，就靠这两个位表达外壳三件套。
 * ⚠️ model.stages / model.stageId 是**赛段选择器**需要的额外字段（可选，缺了就不渲染选择器）。
 */
export function leaderboardHtml(model) {
  const scope = SCOPES[model?.scope] ? model.scope : 'rank';
  const meta = SCOPES[scope];
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const warnings = Array.isArray(model?.warnings) ? model.warnings : [];
  const stages = Array.isArray(model?.stages) ? model.stages : [];
  const stageId = String(model?.stageId ?? '');

  // ⚠️ 告警置顶（硬契约）：必须排在整页最前，不能排在表格后面。
  const warnHtml = warningsHtml(warnings);
  const head = headHtml(meta);
  const switcher = scopeTabsHtml(scope, stageId, stages);

  if (model?.loading) return `${warnHtml}${head}${switcher}${loadingState({ rows: 3, label: '正在加载榜单…' })}`;
  if (model?.error) return `${warnHtml}${head}${switcher}${errorState({ message: model.error })}`;

  const body = scope === 'business' ? businessRowsHtml(rows, meta)
    : scope === 'personal' ? personalRowsHtml(rows, meta)
      : scope === 'rolling' ? rollingRowsHtml(rows, meta)
        : rankRowsHtml(rows, meta);

  return `${warnHtml}${head}${switcher}`
    + `${statsHtml(scope, rows, warnings)}`
    + `${stagePickerHtml(scope, stageId, stages)}`
    + `${sectionTitle(scope === 'business' ? '商业战绩' : '榜单')}`
    + `${body}`;
}

/** 挂载（真实 API / 演示适配器） */
export async function renderLeaderboard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'leaderboard-view';
  const routeStageId = String(ctx.params?.stageId ?? '');
  const scopeParam = String(ctx.query?.scope ?? '');
  // ⚠️ 届期缺省取「当届」由服务端解析（resolveEditionId），前端不必先查届期
  const editionQuery = ctx.query?.editionId ? `?editionId=${encodeURIComponent(ctx.query.editionId)}` : '';

  const load = async () => {
    wrap.innerHTML = leaderboardHtml({
      scope: scopeParam || (routeStageId ? 'rank' : 'rolling'),
      loading: true,
    });

    // ⚠️ 赛段列表：拉失败**静默降级**（空列表 ⇒ 不渲染选择器），
    //    绝不能因为赛段列表挂了就让整个榜单页报错。
    const stages = await ctx.api.get(`/api/stages${editionQuery}`)
      .then((r) => (Array.isArray(r?.items) ? r.items : []))
      .catch(() => []);

    // 口径与赛段的解析（口径靠 URL，赛段没有就取赛段列表的第一个）
    let scope = scopeParam || (routeStageId ? 'rank' : 'rolling');
    let stageId = routeStageId;
    if (!stageId && scope !== 'rolling') {
      stageId = String(stages[0]?.id ?? '');
      if (!stageId) scope = 'rolling';   // 没有赛段可用 ⇒ 退回届期级的滚动总榜
    }
    if (scope === 'rolling') stageId = '';   // ⚠️ 滚动总榜是届期级的，没有赛段维度

    let data = null;
    let error = null;
    try {
      const url = scope === 'rolling'
        ? `/api/leaderboard/rolling${editionQuery}`
        : `/api/leaderboard/${encodeURIComponent(stageId)}?scope=${encodeURIComponent(scope)}`;
      data = await ctx.api.get(url);
    } catch (e) {
      error = e.message;
    }

    wrap.innerHTML = leaderboardHtml({
      scope,
      stageId,
      stages,
      rows: data?.rows ?? [],
      warnings: data?.warnings ?? [],
      error,
    });
    // ⚠️ 错误态的重试按钮必须真的能重跑（生产级错误态不能是死路一条）
    wrap.querySelector('[data-action="retry"]')?.addEventListener('click', () => { load().catch(() => {}); });
  };
  await load();
  return wrap;
}

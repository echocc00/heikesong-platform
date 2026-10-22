// web/views/card.js — 项目商业战绩卡
// 依据：设计文档 §9「7 类里程碑勾选式 + 企业签字标识 + 不显示签字人」
//   + 本轮（P7）「现有页面打磨到生产级」：外壳三件套 + 页头 + 指标行 + 分组面板。
// ⛔ 不渲染签字人字段（企业签字不公开，R-ENT-04 / S10 §0.3）。
// ⚠️ 渲染出去的 HTML 里**不许出现「签字人」三个字**（同一条约束的文案侧）——
//    代码注释里可以写，输出里不行（测试直接扫输出字符串）。
// ⚠️ 转义统一走 `web/escape.js`（P0 建立，全站唯一入口）。
import { escapeHtml } from '../escape.js';
import { milestoneMark } from '../icons.js';
import {
  badge, emptyState, errorState, loadingState, pageHead, panel,
  sectionTitle, statRow,
} from '../ui.js';
import { tierTone } from './tier.js';

/**
 * 战绩卡渲染（纯函数，可单测）。
 *
 * ⚠️ `model.loading` / `model.error` 是**视图自有的状态位**（不属于 API 返回形状）——
 *    纯函数没法发请求，就靠这两个位表达外壳三件套。
 */
export function cardHtml(model) {
  const items = Array.isArray(model?.items) ? model.items : [];
  const teamName = String(model?.teamName ?? '');
  const tier = String(model?.tier ?? '');
  // ⚠️ 达成数 / 总数优先用 API 给的值；缺了才按 items 现算（视图不编造口径）。
  const achieved = model?.achievedCount ?? items.filter((m) => m?.achieved).length;
  const total = model?.total ?? items.length;

  const head = pageHead({
    title: teamName ? `${teamName} · 商业战绩卡` : '商业战绩卡',
    sub: '里程碑按赛制清单逐项勾选；达成项自动打勾。',
  });
  if (model?.loading) return `${head}${loadingState({ rows: 3, label: '正在加载战绩卡…' })}`;
  if (model?.error) return `${head}${errorState({ message: model.error })}`;

  const done = items.filter((m) => m?.achieved);
  const todo = items.filter((m) => !m?.achieved);

  const milestoneBody = items.length
    ? `${milestoneGroup('已达成', done, 'success', doneItemHtml)}`
      + `${milestoneGroup('未达成', todo, 'neutral', todoItemHtml)}`
    : emptyState({
      title: '暂无数据',
      hint: '这支队伍还没有登记任何里程碑 —— 报名组队后系统会按赛制生成里程碑清单。',
    });

  const benefits = Array.isArray(model?.benefits) ? model.benefits : [];
  const never = Array.isArray(model?.neverUnlocks) ? model.neverUnlocks : [];

  return `${head}${statRow([
    { label: '当前段位', value: tier || '—', tone: tierTone(tier) },
    { label: '已达成里程碑', value: achieved, tone: 'success', hint: `共 ${total} 项` },
    { label: '里程碑总数', value: total },
  ])}`
    + `${panel({
      title: '里程碑',
      desc: '达成项自动打勾；企业确认后会补上「已签」标识。',
      body: milestoneBody,
    })}`
    + `${panel({
      title: '已解锁权益',
      desc: `按当前段位（${tier || '—'}）解锁`,
      body: benefits.length
        ? `<ul class="list-divided">${benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '<p class="muted small">当前段位还没有解锁额外权益 —— 段位提升后会自动出现在这里。</p>',
    })}`
    // ⚠️ 「永不解锁」用 warn 面板：它需要和「已解锁权益」在视觉上分开 ——
    //    否则读者会把它当成一份还没拿到的清单。
    + `${panel({
      title: '永不解锁',
      desc: '以下权益与本赛段赛制不符，任何段位都不会解锁。',
      body: never.length
        ? `<ul class="list-divided">${never.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '<p class="muted small">暂无数据</p>',
      tone: 'warn',
    })}`;
}

/** 里程碑分组（标题 + 计数徽章 + 勾选列表）。 */
function milestoneGroup(title, items, tone, itemHtml) {
  return `${sectionTitle(title, badge(`${items.length} 项`, tone))}`
    + `${items.length
      ? `<ul class="milestones">${items.map(itemHtml).join('')}</ul>`
      : '<p class="muted small">暂无数据</p>'}`;
}

/** 已达成项：✓ 图标 + 标签 + 「已签」标识。 */
function doneItemHtml(m) {
  return `<li class="done"><span class="mark">${milestoneMark(true)}</span>`
    + `<span>${escapeHtml(m?.label)}</span>`
    + `${m?.signed ? `<span class="signed">${badge('已签', 'success')}</span>` : ''}</li>`;
}

/** 未达成项：○ 图标 + 标签。 */
function todoItemHtml(m) {
  return `<li class="todo"><span class="mark">${milestoneMark(false)}</span>`
    + `<span>${escapeHtml(m?.label)}</span></li>`;
}

/** 挂载（真实 API / 演示适配器） */
export async function renderCard(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card-view';
  const teamId = String(ctx.params?.teamId ?? '');

  const load = async () => {
    wrap.innerHTML = cardHtml({ loading: true });
    try {
      const data = await ctx.api.get(`/api/teams/${encodeURIComponent(teamId)}/performance-card`);
      wrap.innerHTML = cardHtml(data);
    } catch (e) {
      wrap.innerHTML = cardHtml({ error: e.message });
    }
    // ⚠️ 错误态的重试按钮必须真的能重跑（生产级错误态不能是死路一条）
    wrap.querySelector('[data-action="retry"]')?.addEventListener('click', () => { load().catch(() => {}); });
  };
  await load();
  return wrap;
}

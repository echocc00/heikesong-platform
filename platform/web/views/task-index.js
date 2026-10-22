// web/views/task-index.js — 任务清单入口页（工作流索引）
// 依据：本轮（P7）「现有页面打磨到生产级」
//
// ⚠️ **为什么需要这个页面**：
//   任务清单页的路由是 `/tasks/:workflowId` —— 带参数。
//   打磨前**没有任何页面能给出这个 workflowId**：
//   前端 13 条路由里没有工作流列表，导航里也只有一条死链 ⇒
//   「任务清单」在真实产品上**根本点不进去**（不是难用，是不可达）。
//   ⇒ 这里补一个索引页：列出本届的工作流 + 每个工作流的任务进度，
//      点进去才是真正的任务清单（/tasks/:workflowId）。
//
// ⛔ **前端不做可见性过滤**（全局约束）：
//   工作流列表由 API 层按 capability 过滤后返回，这里**原样呈现**。
import { escapeHtml } from '../escape.js';
import { emptyState, errorState, loadingState, pageHead } from '../ui.js';

/**
 * 工作流 → 卡片模型（纯函数，可单测）。
 * @param {Array} workflows API 返回的工作流
 */
export function buildWorkflowCards(workflows) {
  return (workflows ?? []).map((w) => {
    const total = Number(w.taskCount ?? 0);
    const done = Number(w.doneCount ?? 0);
    const open = Math.max(0, total - done);
    return {
      id: w.id ?? '',
      name: w.name ?? '',
      taskPackageId: w.taskPackageId ?? '',
      total,
      done,
      open,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  });
}

/**
 * 卡片 HTML（纯函数，不碰 document）。
 * ⚠️ 工作流名称来自服务端（可能来自用户输入）⇒ 必须转义。
 */
export function workflowCardsHtml(cards) {
  return cards.map((c) => `
    <article class="card home__entry">
      <h2>${escapeHtml(c.name)}</h2>
      <p class="muted small">共 ${c.total} 个任务 · 已完成 ${c.done} · 待办 ${c.open}</p>
      <div class="bar" role="img" aria-label="完成进度 ${c.percent}%">
        <span class="bar__track"><span class="bar__fill bar__fill--success" style="width:${c.percent}%"></span></span>
        <span class="bar__value">${c.percent}%</span>
      </div>
      <div class="btn-group">
        <a class="btn btn--primary btn--sm" href="#/tasks/${escapeHtml(c.id)}">进入任务清单</a>
      </div>
    </article>`).join('');
}

export function renderTaskIndex(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'task-index';
  wrap.innerHTML = `
    ${pageHead({
      title: '任务清单',
      sub: '任务只能自主领取 —— 严禁按岗位和身份分工（R-OPS-14）',
    })}
    <div id="ti-body">${loadingState({ rows: 2, label: '正在加载任务清单…' })}</div>`;

  const body = wrap.querySelector('#ti-body');

  (async () => {
    let data;
    try {
      data = await ctx.api.get('/api/workflows');
    } catch (e) {
      body.innerHTML = errorState({ message: e.message });
      return;
    }
    const cards = buildWorkflowCards(data?.items ?? []);
    body.innerHTML = cards.length
      ? `<div class="grid grid--3">${workflowCardsHtml(cards)}</div>`
      : emptyState({
        title: '还没有任务清单',
        hint: '任务清单由组委会在任务包发布后生成，届时会出现在这里。',
      });
  })().catch((e) => {
    body.innerHTML = errorState({ message: e.message });
  });

  return wrap;
}

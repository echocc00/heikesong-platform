// web/views/tasks.js — 任务清单页
// 依据：设计文档 §9 前端信息架构「赛段与任务清单 + 自主领取任务」；INTERFACES.md §6 的 P5 API 清单
// 溯源：R-OPS-13（任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成）
// 溯源：R-OPS-14（禁止岗位制：严禁按岗位和身份分工，任务只能自主领取）
//
// ⛔ R-OPS-14：页面上任务**只有「自主领取」一个入口** —— 不出现「指派给某人」「按岗位分工」这类控件。
//    这是【刻意的功能缺失】，不是遗漏（探月黑客松因岗位制失败：忙的忙死、闲的闲死、最后一个人说了算）。
//    唯一的取任务路径：POST /api/tasks/:id/claim（自主领取）。
//
// ⚠️ 前端**不做任何可见性过滤**：过滤在 API 层完成 —— 前端隐藏 = 数据已泄露。
//    ⇒ 本视图把 API 返回的任务**原样分桶**呈现，一个都不丢（见 classifyTasks 的分桶恒等式）。
//
// ⚠️ 为什么把分类与操作抽成**纯函数**（与 web/views/team.js 的 buildTeamCards 同款做法）：
//    如果「三段怎么分」「这个任务能做什么」只写在 DOM 回调里，
//    就没有任何东西能断言「页面没有指派控件」—— 把分类逻辑改掉，全量测试照样全绿。
//    抽成纯函数后，这两条**渲染路径**能被直接断言（见 test/workflow-e2e.test.js）。
import { escapeHtml } from '../escape.js';

/**
 * 任务的展示模式（纯函数）。
 * - claimable：无人领取 → 可自主领取
 * - mine：本人领取 → 可提交完成 / 可释放
 * - taken：他人领取 → 不可动
 * - done：已完成
 */
export function taskMode(t, me) {
  if (!t) return 'claimable';
  if (t.status === 'done') return 'done';
  if (!t.claim) return 'claimable';
  return t.claim.userId === me ? 'mine' : 'taken';
}

/**
 * 三段分类（纯函数）：可领取的 / 我领取的 / 已完成的。
 *
 * ⚠️ **分桶恒等**：每个任务恰好落进一段，一个都不丢 ——
 *    这是「前端不做可见性过滤」的**可断言形式**：前端只重新分桶，不隐藏任何一条。
 */
export function classifyTasks(tasks, me) {
  const out = { claimable: [], mine: [], done: [] };
  for (const t of tasks ?? []) {
    const mode = taskMode(t, me);
    if (mode === 'done') out.done.push(t);
    else if (mode === 'claimable') out.claimable.push(t);
    else out.mine.push(t);
  }
  return out;
}

/**
 * 某个任务当前**允许的操作**（纯函数）。
 * ⛔ 只有三种：自主领取 / 提交完成 / 释放。**没有**指派、按岗位分配之类的操作。
 */
export function taskActions(t, me) {
  const mode = taskMode(t, me);
  if (mode === 'claimable') return ['claim'];
  if (mode === 'mine') return ['complete', 'release'];
  return [];
}

/**
 * 单行任务的静态内容 HTML（纯函数，不碰 document）。
 * ⚠️ 服务端返回的标题/详情必须转义 —— innerHTML 插值 = 存储型 XSS（设计文档 §14.2 / P0 终审 I-2）。
 */
export function buildTaskItem(t, me) {
  const mode = taskMode(t, me);
  const who = t?.claim ? `领取人：${t.claim.userId}` : '无人领取';
  const parts = [
    `<span class="task-title">${escapeHtml(t?.title)}</span>`,
    `<span class="task-meta">${escapeHtml(t?.detail || '')} · ${escapeHtml(who)} · 状态 ${escapeHtml(t?.status)}</span>`,
  ];
  if (mode === 'done') {
    parts.push(`<span class="task-meta">完成于 ${escapeHtml(t?.completedAt || '')}</span>`);
  }
  return parts.join('');
}

/**
 * 三段的行内容 HTML（纯函数）：{ claimable, mine, done }。
 * 段标题写死在 renderTasks 的骨架里（可领取的 / 我领取的 / 已完成的）。
 */
export function buildTaskSections(tasks, me) {
  const s = classifyTasks(tasks, me);
  const rows = (list) => list.map((t) => buildTaskItem(t, me)).join('');
  return { claimable: rows(s.claimable), mine: rows(s.mine), done: rows(s.done) };
}

export function renderTasks(ctx) {
  const { api } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'card tasks';
  const workflowId = ctx.params?.workflowId ?? '';

  wrap.innerHTML = `
    <h1>任务清单</h1>
    <p class="muted">任务只能自主领取 —— 严禁按岗位和身份分工（R-OPS-14）</p>
    <section>
      <h2>可领取的</h2>
      <ul class="task-list" id="task-claimable"></ul>
    </section>
    <section>
      <h2>我领取的</h2>
      <ul class="task-list" id="task-mine"></ul>
    </section>
    <section>
      <h2>已完成的</h2>
      <ul class="task-list" id="task-done"></ul>
    </section>
    <p class="err" id="task-err"></p>
  `;

  const errBox = wrap.querySelector('#task-err');
  const listClaimable = wrap.querySelector('#task-claimable');
  const listMine = wrap.querySelector('#task-mine');
  const listDone = wrap.querySelector('#task-done');

  function showError(message) {
    errBox.textContent = message || '';
  }

  async function load() {
    showError('');
    try {
      const res = await api.get(`/api/workflows/${encodeURIComponent(workflowId)}/tasks`);
      const tasks = res.tasks ?? [];
      const me = ctx.getState?.().user?.id ?? null;
      const sections = classifyTasks(tasks, me);
      listClaimable.replaceChildren();
      listMine.replaceChildren();
      listDone.replaceChildren();
      for (const t of sections.claimable) listClaimable.appendChild(renderTask(t, me));
      for (const t of sections.mine) listMine.appendChild(renderTask(t, me));
      for (const t of sections.done) listDone.appendChild(renderTask(t, me));
    } catch (e) {
      showError(e.message || '加载任务清单失败');
    }
  }

  function renderTask(t, me) {
    const li = document.createElement('li');
    li.className = `task task-${taskMode(t, me)}`;
    li.innerHTML = buildTaskItem(t, me);

    // ⛔ 只按 taskActions 给控件 —— 没有任何指派/岗位类操作可加
    for (const action of taskActions(t, me)) {
      if (action === 'claim') {
        const btn = document.createElement('button');
        btn.textContent = '自主领取';
        btn.addEventListener('click', async () => {
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/claim`, {});
            await load();
          } catch (e) {
            showError(e.message || '领取失败');
          }
        });
        li.appendChild(btn);
      }

      if (action === 'complete') {
        const url = document.createElement('input');
        url.placeholder = '可运行产物链接（如仓库地址）';
        const ver = document.createElement('input');
        ver.placeholder = '版本号（如 v0.1）';
        const done = document.createElement('button');
        done.textContent = '提交完成状态';
        done.addEventListener('click', async () => {
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/complete`, {
              evidence: {
                kind: 'runnable',
                summary: url.value.trim()
                  ? `已提交可运行版本 ${ver.value.trim() || '未标注版本'}`
                  : '已提交可运行版本',
                artifactUrl: url.value.trim(),
                version: ver.value.trim(),
              },
            });
            await load();
          } catch (e) {
            showError(e.message || '提交失败');
          }
        });
        const release = document.createElement('button');
        release.textContent = '释放任务';
        release.addEventListener('click', async () => {
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/release`, {});
            await load();
          } catch (e) {
            showError(e.message || '释放失败');
          }
        });
        li.appendChild(url);
        li.appendChild(ver);
        li.appendChild(done);
        li.appendChild(release);
      }
    }

    return li;
  }

  load();
  return wrap;
}

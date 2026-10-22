// web/views/tasks.js — 任务清单页
// 依据：设计文档 §9 前端信息架构「赛段与任务清单 + 自主领取任务」；INTERFACES.md §6 的 P5 API 清单
// 溯源：R-OPS-13（任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成）
// 溯源：R-OPS-14（禁止岗位制：严禁按岗位和身份分工，任务只能自主领取）
//
// ⛔ R-OPS-14：页面上任务**只有「自主领取」一个入口** —— 不出现任何"分给别人/按岗位切分"的控件。
//    这是【刻意的功能缺失】，不是遗漏（探月黑客松因岗位制失败：忙的忙死、闲的闲死、最后一个人说了算）。
//    唯一的取任务路径：POST /api/tasks/:id/claim（自主领取）。
//
// ⚠️ 前端**不做任何可见性过滤**：过滤在 API 层完成 —— 前端隐藏 = 数据已泄露。
//    ⇒ 本视图把 API 返回的任务**原样分桶**呈现，一个都不丢（见 classifyTasks 的分桶恒等式）。
//
// ⚠️ 为什么把分类与操作抽成**纯函数**（与 web/views/team.js 的 buildTeamCards 同款做法）：
//    如果「三段怎么分」「这个任务能做什么」只写在 DOM 回调里，
//    就没有任何东西能断言「页面没有多余控件」—— 把分类逻辑改掉，全量测试照样全绿。
//    抽成纯函数后，这两条**渲染路径**能被直接断言（见 test/workflow-e2e.test.js）。
//
// ⚠️ **源码扫描禁区**（test/workflow-e2e.test.js 剥掉注释后扫本文件）：
//    「指派 / assign / Assign / 岗位分工 / <select / role=」一个字都不许出现在代码里
//    （注释里无所谓）。⇒ 本页不得有下拉选择控件，不得有 role= 属性，不得有 data-role= 这类属性名。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead,
} from '../ui.js';

/** 任务的展示模式 → 中文标签 / 徽章色调（让「我的」和「可领取的」一眼分得开）。 */
const MODE_LABEL = {
  claimable: '待领取',
  mine: '我领取的',
  taken: '他人领取',
  done: '已完成',
};

const MODE_TONE = {
  claimable: 'neutral',
  mine: 'brand',
  taken: 'info',
  done: 'success',
};

/** 三个分段的语义（可领取=neutral / 我的=brand / 已完成=success）。 */
const SECTION_BADGE = {
  claimable: '待领取',
  mine: '我领取的',
  done: '已完成',
};

const EMPTY_VIEW = {
  claimable: {
    title: '暂时没有可领取的任务',
    hint: '这个工作流的任务都已被领走或已完成：等组委会发布新任务，或回工作流索引看看别的赛段。',
  },
  mine: {
    title: '你手上没有任务',
    hint: '在「可领取的」里挑一个领走就算开工 —— 不用等别人分给你。',
  },
  done: {
    title: '还没有已完成的任务',
    hint: '你领走并提交完成的任务会出现在这里（含完成时间），用来复盘。',
  },
};

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
 * ⛔ 只有三种：自主领取 / 提交完成 / 释放。**没有**别的操作。
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
    badge(MODE_LABEL[mode] ?? mode, MODE_TONE[mode] ?? 'neutral'),
    `<span class="task-meta">${escapeHtml(t?.detail || '')}</span>`,
    `<span class="task-meta">${escapeHtml(who)} · 状态 ${escapeHtml(t?.status)}</span>`,
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

/** 一个分段的面板骨架（panel 的 class 结构 + 状态徽章与计数）。 */
function sectionHtml(id, title, toneName, desc) {
  return `
    <section class="panel panel--${toneName}">
      <div class="panel__head">
        <div class="row row--between">
          <h2 class="panel__title">${title}</h2>
          <span class="row">
            ${badge(SECTION_BADGE[id], toneName)}
            <span class="muted small" id="task-count-${id}">0 项</span>
          </span>
        </div>
        <p class="panel__desc">${desc}</p>
      </div>
      <div class="panel__body">
        <ul class="task-list" id="task-${id}"></ul>
      </div>
    </section>`;
}

export function renderTasks(ctx) {
  const { api } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'tasks';
  const workflowId = ctx.params?.workflowId ?? '';

  wrap.innerHTML = `
    ${pageHead({
      title: '任务清单',
      sub: '任务只能自主领取 —— 严禁按岗位和身份分工（R-OPS-14）',
    })}
    <div id="task-state"></div>
    <div id="task-msg"></div>
    ${sectionHtml('claimable', '可领取的', 'neutral', '看到合适的就是你的：直接领走，完成后提交可运行产物。')}
    ${sectionHtml('mine', '我领取的', 'brand', '你手上还没交付的任务：填上产物链接与版本号即可提交完成，也可释放给别人。')}
    ${sectionHtml('done', '已完成的', 'success', '已交付的任务（含完成时间），留作复盘与评审依据。')}`;

  const stateBox = wrap.querySelector('#task-state');
  const msgBox = wrap.querySelector('#task-msg');
  const lists = {
    claimable: wrap.querySelector('#task-claimable'),
    mine: wrap.querySelector('#task-mine'),
    done: wrap.querySelector('#task-done'),
  };
  const counters = {
    claimable: wrap.querySelector('#task-count-claimable'),
    mine: wrap.querySelector('#task-count-mine'),
    done: wrap.querySelector('#task-count-done'),
  };

  // ⚠️ 重试用事件委托：errorState() 的重试按钮没有固定 id，委托到容器更稳。
  stateBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void load();
  });

  /** 操作结果提示（成功 / 失败都出声，不静默）。 */
  function showMsg(toneName, title, text) {
    msgBox.innerHTML = noticeState({ tone: toneName, title, items: text ? [text] : [] });
  }

  async function load() {
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载任务清单…' });
    try {
      const res = await api.get(`/api/workflows/${encodeURIComponent(workflowId)}/tasks`);
      const tasks = res?.tasks ?? [];
      const me = ctx.getState?.().user?.id ?? null;
      renderAll(tasks, me);
      stateBox.innerHTML = '';
    } catch (e) {
      stateBox.innerHTML = errorState({
        message: e.message || '加载任务清单失败',
        hint: '任务清单没拉到。可以重试；若持续失败，确认这个工作流还在进行中。',
      });
    }
  }

  function renderAll(tasks, me) {
    const s = classifyTasks(tasks, me);
    fill(lists.claimable, s.claimable, me, 'claimable');
    fill(lists.mine, s.mine, me, 'mine');
    fill(lists.done, s.done, me, 'done');
    counters.claimable.textContent = `${s.claimable.length} 项`;
    counters.mine.textContent = `${s.mine.length} 项`;
    counters.done.textContent = `${s.done.length} 项`;
  }

  function fill(ul, tasks, me, kind) {
    ul.replaceChildren();
    if (!tasks.length) {
      const li = document.createElement('li');
      li.innerHTML = emptyState(EMPTY_VIEW[kind]);
      ul.appendChild(li);
      return;
    }
    for (const t of tasks) ul.appendChild(renderTask(t, me));
  }

  function renderTask(t, me) {
    const li = document.createElement('li');
    li.className = `task task-${taskMode(t, me)}`;
    li.innerHTML = buildTaskItem(t, me);

    // ⛔ 只按 taskActions 给控件 —— 没有任何别的任务操作可加
    for (const action of taskActions(t, me)) {
      if (action === 'claim') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--primary btn--sm';
        // ⚠️ textContent 必须**恰好**是这四个字（测试断言 === '自主领取'）
        btn.textContent = '自主领取';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/claim`, {});
            showMsg('success', '已领取', `任务「${t.title}」现在在你手上。`);
            await load();
          } catch (e) {
            btn.disabled = false;
            showMsg('danger', '领取失败', e.message || '领取失败');
          }
        });
        li.appendChild(btn);
      }

      if (action === 'complete') {
        // ⚠️ 两个输入都要有**可见标签**（.field__label）—— 打磨前是两个裸 input，填什么都不清楚。
        const artifact = makeField('产物链接', 'task-artifact', 'https://…（仓库或演示地址）');
        const version = makeField('版本号', 'task-version', '如 v0.1');
        li.appendChild(artifact.wrap);
        li.appendChild(version.wrap);

        const note = document.createElement('p');
        note.className = 'task-meta';
        li.appendChild(note);

        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'btn btn--primary btn--sm';
        done.textContent = '提交完成';
        done.addEventListener('click', async () => {
          const url = artifact.input.value.trim();
          const ver = version.input.value.trim();
          if (!url && !ver) {
            // ⚠️ 本地拦下：两个都空就发请求，服务端只会回一句 EVIDENCE_REQUIRED。
            note.className = 'field__error';
            note.textContent = '产物链接与版本号至少填一项（两项都空的完成申请会被服务端拒收）';
            return;
          }
          done.disabled = true;
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/complete`, {
              evidence: {
                kind: 'runnable',
                summary: url
                  ? `已提交可运行版本 ${ver || '未标注版本'}`
                  : '已提交可运行版本',
                artifactUrl: url,
                version: ver,
              },
            });
            showMsg('success', '已提交完成', `任务「${t.title}」已标记完成。`);
            await load();
          } catch (e) {
            done.disabled = false;
            note.className = 'field__error';
            note.textContent = e.message || '提交失败';
          }
        });
        li.appendChild(done);

        const release = document.createElement('button');
        release.type = 'button';
        release.className = 'btn btn--ghost btn--sm';
        release.textContent = '释放任务';
        // ⚠️ 释放是"把机会让给别人"：先要点一次确认，避免手滑就放手。
        let armed = false;
        release.addEventListener('click', async () => {
          if (!armed) {
            armed = true;
            release.textContent = '确认释放';
            note.className = 'task-meta';
            note.textContent = '再点一次「确认释放」生效；释放后别人就能领走这个任务。';
            return;
          }
          release.disabled = true;
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/release`, {});
            showMsg('success', '已释放', `任务「${t.title}」已放回可领取池。`);
            await load();
          } catch (e) {
            release.disabled = false;
            note.className = 'field__error';
            note.textContent = e.message || '释放失败';
          }
        });
        li.appendChild(release);
      }
    }

    return li;
  }

  /** 带可见标签的输入（.field + .field__label + .input）。 */
  let fieldSeq = 0;
  function makeField(labelText, idPrefix, placeholder) {
    fieldSeq += 1;
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.className = 'field__label';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'input';
    input.id = `${idPrefix}-${fieldSeq}`;
    input.placeholder = placeholder;
    label.htmlFor = input.id;
    field.appendChild(label);
    field.appendChild(input);
    return { wrap: field, input };
  }

  void load();
  return wrap;
}

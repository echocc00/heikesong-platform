// web/views/review.js — 评审打分页（P8 新建）
//
// 规则溯源：
//   - 「评委按维度打分，分值 0–100」→ INTERFACES.md §3「API（P2）」+ 评审引擎 `assertScoreInRange`
//   - 「评分只增不改，改分留痕」→ 评审引擎（同 teamId+dimension 覆盖写 + 审计）
//   - 「可见性在 API 层过滤」→ 设计文档 §6.6（本页只显示**本人**给的分）
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//
// ⚠️ **为什么用 0–100 数字输入，不用 1–5 单选**（P8 DP-95）：
//   报名页的 1–5 是**问卷量表**（P1 的报名评分规则就是 1–5）；
//   评审是**百分制打分**（后端 `assertScoreInRange` 卡的是 0–100）。
//   两者口径不同，**不能共用控件** —— 1–5 单选会让评委只能给 5 档，直接丢分辨率。
//   ⇒ 用数字输入（更密，也更诚实）。⛔ 仍然**不用 `<select>`**（沿用 DP-82）。
//
// ⚠️ **纯函数与 DOM 接线分离**：
//   「分值解析 / 组装 items」抽成纯函数（parseScore / buildReviewItems）⇒ 可直接断言；
//   DOM 只负责把输入框的值收上来。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  sectionTitle, statRow,
} from '../ui.js';

const MIN_SCORE = 0;
const MAX_SCORE = 100;

/**
 * 分值解析（纯函数）。
 * @param {unknown} raw 输入框原始值
 * @returns {{value: number|null}|{error: string}}  空值 = 未打分
 */
export function parseScore(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: '必须是数字' };
  if (n < MIN_SCORE || n > MAX_SCORE) return { error: `必须在 ${MIN_SCORE}–${MAX_SCORE} 之间` };
  return { value: n };
}

/**
 * 汇总一支队伍的打分 → items + 错误清单（纯函数）。
 *
 * ⚠️ **本地校验前置**（P7 的通用纪律）：不发无谓请求 ——
 *    有一题没填就发请求，服务端会整批拒（`assertScoreInRange`），评委白等一次往返。
 *
 * @param {Record<string,string>} values key = `${teamId}::${dimension}`
 * @param {Array<{teamId:string,key:string,name:string}>} cells 要打的格子
 * @returns {{items: Array<object>, errors: Array<object>}}
 */
export function buildReviewItems(values, cells) {
  const items = [];
  const errors = [];
  for (const cell of cells ?? []) {
    const raw = (values ?? {})[`${cell.teamId}::${cell.key}`];
    const parsed = parseScore(raw);
    if (parsed.error) {
      errors.push({ teamId: cell.teamId, dimension: cell.key, message: parsed.error });
      continue;
    }
    if (parsed.value === null) {
      errors.push({ teamId: cell.teamId, dimension: cell.key, message: '还没打分' });
      continue;
    }
    items.push({ teamId: cell.teamId, dimension: cell.key, rawScore: parsed.value });
  }
  return { items, errors };
}

/** 幂等键：每次提交生成一个（见 §「为什么每次点击都换 requestId」）。 */
function newRequestId() {
  const g = globalThis.crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 指标行（纯函数）。
 * ⚠️ 「已交/缺交」有两套口径（API 的 `progress.scope` 标明）：
 *    - scope='mine'  ⇒ 评委视角：只看**自己**交了几格；
 *    - scope='stage' ⇒ 组委会视角：看**全赛段**（评委 × 队伍 × 维度）交了几格。
 *   ⇒ 标签必须跟着口径走，否则又是「数字与标签对不上」（P7 B1 的同款事故）。
 */
export function reviewStats(board) {
  const progress = board?.progress ?? {};
  const stageScope = progress.scope === 'stage';
  const submitted = Number(progress.submitted ?? 0);
  const total = Number(progress.total ?? 0);
  const teams = Array.isArray(board?.teams) ? board.teams.length : 0;
  const dims = Array.isArray(board?.judgeDimensions) ? board.judgeDimensions.length : 0;
  return [
    {
      label: stageScope ? '本赛段已交' : '我的已交',
      value: submitted,
      tone: 'brand',
      hint: `应交 ${total} 格`,
    },
    { label: '待评队伍', value: teams, tone: 'neutral', hint: `${dims} 个评委席维度` },
    {
      label: '完成度',
      value: total > 0 ? `${Math.round((submitted / total) * 100)}%` : '—',
      tone: total > 0 && submitted >= total ? 'success' : 'warn',
    },
    {
      label: '我的身份',
      value: stageScope ? '组委会' : '评委',
      tone: 'info',
      hint: '打分可改，改分留审计痕',
    },
  ];
}

/** 一支队伍的评分表单（纯函数）。 */
export function reviewTeamFormHtml(team, dimensions, myScores) {
  const scoreOf = (dimKey) => {
    const hit = (myScores ?? []).find((s) => s.teamId === team.id && s.dimension === dimKey);
    return hit ? String(hit.rawScore) : '';
  };
  const fields = (dimensions ?? []).map((d) => `
      <div class="field">
        <label class="field__label" for="score-${escapeHtml(team.id)}-${escapeHtml(d.key)}">
          ${escapeHtml(d.name)} <span class="muted small">权重 ${Math.round((d.weight ?? 0) * 100)}%</span>
        </label>
        <input class="input" type="number" id="score-${escapeHtml(team.id)}-${escapeHtml(d.key)}"
               data-team="${escapeHtml(team.id)}" data-dimension="${escapeHtml(d.key)}"
               min="${MIN_SCORE}" max="${MAX_SCORE}" step="1"
               value="${escapeHtml(scoreOf(d.key))}" placeholder="0–100" />
      </div>`).join('');

  const given = (dimensions ?? []).map((d) => scoreOf(d.key) !== '');
  const hasAny = given.some(Boolean);
  const allDone = given.length > 0 && given.every(Boolean);
  return `
    <section class="panel" data-team="${escapeHtml(team.id)}">
      <div class="panel__head">
        <h2 class="panel__title">${escapeHtml(team.name)}</h2>
        <p class="panel__desc">${escapeHtml(team.taskPackageTitle || '未认领任务包')}</p>
      </div>
      <div class="panel__body">
        ${fields || '<p class="muted">该赛段没有评委席维度。</p>'}
        <div class="btn-group">
          <button type="button" class="btn btn--primary" data-action="submit-team" data-team="${escapeHtml(team.id)}">
            ${hasAny ? '更新本队评分' : '提交本队评分'}
          </button>
          ${allDone ? badge('已交齐', 'success') : (hasAny ? badge('部分已交', 'warn') : badge('待提交', 'warn'))}
        </div>
        <div class="form-feedback" data-feedback="${escapeHtml(team.id)}"></div>
      </div>
    </section>`;
}

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, board, stages, stageId }
 */
export function reviewHtml(model) {
  if (model?.loading) {
    return pageHead({ title: '评审打分' }) + loadingState({ rows: 4, label: '正在加载评审工作台…' });
  }
  if (model?.error) {
    return pageHead({ title: '评审打分' }) + errorState({ message: model.error, hint: '需要本赛段评委身份或 score:read 能力。' });
  }
  // ⚠️ 没选赛段 ⇒ 给赛段选择器（导航入口 `#/review` 落到这里）
  if (!model?.board) {
    const stages = Array.isArray(model?.stages) ? model.stages : [];
    const list = stages.length
      ? `<ul class="list-divided">${stages.map((s) => `<li class="row row--between">
          <span>${escapeHtml(s.name)} <span class="muted small">${escapeHtml(s.key)}</span></span>
          <a class="btn btn--ghost btn--sm" href="#/review/${escapeHtml(s.id)}">进入评审</a>
        </li>`).join('')}</ul>`
      : emptyState({ title: '还没有赛段', hint: '组委会创建赛段后，这里会出现可评审的赛段。' });
    return pageHead({ title: '评审打分', sub: '选择一个赛段开始评审。' })
      + panel({ title: '赛段', desc: '只有被分配为本赛段评委的账号能进来打分。', body: list });
  }

  const board = model.board;
  const teams = Array.isArray(board.teams) ? board.teams : [];
  const dims = Array.isArray(board.judgeDimensions) ? board.judgeDimensions : [];
  const head = pageHead({
    title: `评审打分 · ${board.stage?.name ?? ''}`,
    sub: '按维度给每支队伍打分（0–100）。打分可以改，改分会留下审计记录。',
    actions: [
      { label: '看榜单', href: '#/leaderboard' },
      { label: '换个赛段', href: '#/review' },
    ],
  });
  const stats = statRow(reviewStats(board));
  if (!teams.length) {
    return head + stats + panel({
      title: '赛段名册',
      body: emptyState({ title: '这个赛段还没有队伍', hint: '队伍组建完成后，赛段名册会自动出现在这里。' }),
    });
  }
  const forms = teams.map((t) => reviewTeamFormHtml(t, dims, board.myScores)).join('');
  const stageScope = board.progress?.scope === 'stage';
  const missingCount = (board.progress?.missing ?? []).length;
  const notice = missingCount
    ? noticeState({
      tone: 'warn',
      title: stageScope ? '还有未交的打分' : '还有未打的格子',
      text: stageScope
        ? `本赛段还差 ${missingCount} 格（按评委 × 队伍 × 维度计）。`
        : `你还差 ${missingCount} 格没打分。缺格的队伍会在计算时被记为「没有该维度得分」。`,
    })
    : noticeState({ tone: 'success', title: '本赛段的评分都交了', text: '组委会计算发榜后会采用最新的一次打分。' });

  return head + stats + notice
    + sectionTitle('赛段名册')
    + forms;
}

// ══════════════════════════════════════════════════════════════════
// 挂载
// ══════════════════════════════════════════════════════════════════

/** 收集页面上所有输入框的值 → `{ 'teamId::dimension': '值' }`。 */
function collectValues(root) {
  const values = {};
  for (const el of root.querySelectorAll('input[data-dimension]')) {
    values[`${el.dataset.team}::${el.dataset.dimension}`] = el.value;
  }
  return values;
}

/**
 * 评审打分页。
 *
 * ⚠️ **为什么每次点击都换 requestId**：
 *   幂等的**真正**保护是「同一 (teamId, dimension) 只能有一条分」——
 *   重发同一份内容在服务端是**覆盖写**（改分同值）⇒ 不会双计。
 *   而 requestId 保护的是**同一次点击的并发重复** ⇒ 每次点击一个即可。
 *   （若复用同一个 requestId 而内容变了，服务端会 409「同一 requestId 内容不同」——
 *     那反而会让「改完分再点一次」失败。）
 */
export async function renderReview(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'review-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';

  /** 拉工作台并渲染。 */
  const load = async () => {
    if (!stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = reviewHtml({ stages: Array.isArray(stages) ? stages : (stages?.items ?? []) });
      return;
    }
    wrap.innerHTML = reviewHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
      wrap.innerHTML = reviewHtml({ board });
    } catch (e) {
      wrap.innerHTML = reviewHtml({ error: e.message });
    }
  };

  await load();

  // ⚠️ 提交：本地校验 → 发请求 → 就地反馈（不整页刷新，DP-81）
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action="submit-team"]');
    if (!btn) return;
    const teamId = btn.dataset.team;
    const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
    const dims = (board.judgeDimensions ?? []).map((d) => ({ teamId, key: d.key, name: d.name }));
    const values = collectValues(wrap);
    const { items, errors } = buildReviewItems(values, dims);
    const feedback = wrap.querySelector(`[data-feedback="${teamId}"]`);
    if (errors.length) {
      if (feedback) {
        feedback.innerHTML = errorState({
          message: `还有 ${errors.length} 格没填好`,
          hint: errors.map((x) => `${x.dimension}：${x.message}`).join('；'),
        });
      }
      return;
    }
    try {
      await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/reviews`, {
        requestId: newRequestId(),
        items,
      });
      // ⚠️ **先刷新工作台，再写反馈**：刷新会整体重建 wrap.innerHTML，
      //    先写反馈会被刷掉（顺序反了 = 提交成功却什么都没显示）。
      await load();
      const done = wrap.querySelector(`[data-feedback="${teamId}"]`);
      if (done) {
        done.innerHTML = noticeState({
          tone: 'success',
          title: '已提交',
          text: `本队 ${items.length} 个维度已记入（改分同样走这里，会留审计痕）。`,
        });
      }
    } catch (e) {
      const fb = wrap.querySelector(`[data-feedback="${teamId}"]`);
      if (fb) fb.innerHTML = errorState({ message: e.message });
    }
  });

  return wrap;
}

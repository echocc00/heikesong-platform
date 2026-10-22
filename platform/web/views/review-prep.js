// web/views/review-prep.js — 评委前置页：回避申报 / 互评 / 自评 / 校准（P10 · W4-d 新建）
//
// 规则溯源（口径与形状一律以源码为准）：
//   - 「评委为供应方 / 投资方 / 前雇主必须回避，回避记录留档」→ R-JDG-09
//   - 「评委须签署声明」→ R-JDG-18
//   - 「用同一组样例作品校准宽严尺度，校准结果不计入评分」→ R-JDG-12
//   - 「自评测只触发解释与提问，不加分」→ R-JDG-13 + src/domain/self-eval.js
//   - 「互评：队 → 队，提交者必须是发起队的在册成员」→ src/services/review.js submitPeerReviews
//   - 「分值 0–100」→ src/services/review.js assertScoreInRange
//
// ⚠️ **四个端点的请求体形状互不相同，抄错就是 400**（照 src/http/routes/review.js 摘出来的）：
//   ① 回避  POST /api/stages/:stageId/recusals
//      { teamId?: string|null, reason: string }
//      ⚠️ **不传 judgeId = 给自己申报**（路由明写：非组委会不能代他人申报回避）。
//   ② 互评  POST /api/stages/:stageId/peer-reviews
//      { items: [{ fromTeamId, toTeamId, score }], requestId?: string }
//      ⚠️ 字段叫 **`score`**（**不是** rawScore）—— 与自评 / 校准不同。
//   ③ 自评  POST /api/stages/:stageId/self-review
//      { teamId: string, items: [{ dimension, rawScore }], requestId?: string }
//   ④ 校准  POST /api/stages/:stageId/calibration
//      { items: [{ dimension, rawScore }] }   ← **无 requestId**
//
// ⚠️ **P10：回避台账已有读端点**：
//   `GET /api/stages/:stageId/recusals`（评委只见自己的，组委会看全部）⇒
//   「已回避清单」显示的是**台账**，不再是「本页面本次会话内申报成功」的记录。
//   台账是追加式的（申报 → 撤销 → 再申报）⇒ 前端用 `currentRecusals` 折叠成当前状态。
//
// ⚠️ **维度一律从 API 取**（⛔ 不许硬编码维度名与权重）：
//   评委席维度取 `GET /api/stages/:stageId/review-board` 的 `judgeDimensions`，
//   自评测维度取同一份返回的 `dimensions` 里 seat='self' 的那些 ——
//   初赛权重表本来就没有自评测维度（只有决赛有），所以那一步必须**按数据算**，不能写死。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel, statRow,
} from '../ui.js';

const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** 「整个赛段」回避的哨兵值（请求体里 teamId 传 null）。 */
const STAGE_SCOPE = '__stage__';

/** 四个区块的键 —— 与页面里反馈区的 data-feedback / data-retry-kind 一一对应。 */
export const PREP_SECTIONS = Object.freeze(['recusal', 'peer', 'self', 'calibration']);

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：解析与本地校验
// ══════════════════════════════════════════════════════════════════

/**
 * 分值解析（纯函数）。
 * @param {unknown} raw 输入框原始值
 * @returns {{value: number|null}|{error: string}} 空值 = 未打分（**不是** 0 分）
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
 * 回避申报：本地校验 + 组装请求体（纯函数）。
 * ⚠️ 后端会拒的理由只有两种（src/services/review.js declareRecusal）：
 *    ① 理由为空 → 400 RECUSAL_REASON_REQUIRED；
 *    ② 队伍不在本赛段名册 → 404 TEAM_NOT_IN_STAGE。
 *   前端先把这两种拦下来，不发无谓请求。
 *
 * @param {object} input { teamId, reason, teams }
 * @returns {{payload: object|null, errors: Array<{field:string,message:string}>}}
 */
export function buildRecusalRequest({ teamId = null, reason = '', teams = [] } = {}) {
  const errors = [];
  const text = String(reason ?? '').trim();
  if (!text) {
    errors.push({ field: 'reason', message: '回避必须填写原因（供应方 / 投资方 / 前雇主）' });
  }
  const scope = teamId === STAGE_SCOPE ? null : (teamId || null);
  if (scope && !(teams ?? []).some((t) => t.id === scope)) {
    errors.push({ field: 'teamId', message: '所选队伍不在本赛段名册内' });
  }
  if (errors.length) return { payload: null, errors };
  return { payload: { teamId: scope, reason: text }, errors };
}

/**
 * 互评：给别的队伍打分（纯函数）。
 * ⚠️ 请求体里的分数字段是 **`score`**（不是 rawScore）—— 抄错就是 400。
 * @param {Record<string,string>} values key = `${fromTeamId}::${toTeamId}`
 * @param {object} ctx { fromTeamId, toTeams }
 */
export function buildPeerReviewItems(values, { fromTeamId = null, toTeams = [] } = {}) {
  const items = [];
  const errors = [];
  if (!fromTeamId) {
    errors.push({ field: 'fromTeamId', message: '还没选发起互评的队伍' });
    return { items, errors };
  }
  for (const team of toTeams ?? []) {
    const raw = (values ?? {})[`${fromTeamId}::${team.id}`];
    const parsed = parseScore(raw);
    if (parsed.error) {
      errors.push({ teamId: team.id, message: parsed.error });
      continue;
    }
    if (parsed.value === null) {
      errors.push({ teamId: team.id, message: '还没打分' });
      continue;
    }
    items.push({ fromTeamId, toTeamId: team.id, score: parsed.value });
  }
  if (!items.length && !errors.length) {
    errors.push({ field: 'toTeams', message: '这个赛段没有可互评的队伍' });
  }
  return { items, errors };
}

/**
 * 按维度打分（自评 / 校准共用同一形状：{ dimension, rawScore }）（纯函数）。
 * @param {Record<string,string>} values key = 维度 key
 * @param {Array<{key:string}>} dimensions 维度（**从 API 来**，不许硬编码）
 */
export function buildDimensionItems(values, dimensions = []) {
  const items = [];
  const errors = [];
  for (const dim of dimensions ?? []) {
    const raw = (values ?? {})[dim.key];
    const parsed = parseScore(raw);
    if (parsed.error) {
      errors.push({ dimension: dim.key, message: parsed.error });
      continue;
    }
    if (parsed.value === null) {
      errors.push({ dimension: dim.key, message: '还没打分' });
      continue;
    }
    items.push({ dimension: dim.key, rawScore: parsed.value });
  }
  return { items, errors };
}

/** 自评 items（纯函数）。 */
export function buildSelfReviewItems(values, dimensions = []) {
  return buildDimensionItems(values, dimensions);
}

/** 校准 items（纯函数）。 */
export function buildCalibrationItems(values, dimensions = []) {
  return buildDimensionItems(values, dimensions);
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：维度与队伍（⛔ 全部从 API 返回里推导）
// ══════════════════════════════════════════════════════════════════

/** 按 seat 拆维度（⛔ 维度名与权重都来自 review-board）。 */
export function dimensionsBySeat(board) {
  const dims = Array.isArray(board?.dimensions) ? board.dimensions : [];
  return {
    judge: dims.filter((d) => d.seat === 'judge'),
    self: dims.filter((d) => d.seat === 'self'),
    enterprise: dims.filter((d) => d.seat === 'enterprise'),
  };
}

/** 评委席维度：优先用 review-board 自带的 judgeDimensions（与写入口同一口径）。 */
export function judgeDimensionsOf(board) {
  if (Array.isArray(board?.judgeDimensions) && board.judgeDimensions.length) {
    return board.judgeDimensions;
  }
  return dimensionsBySeat(board).judge;
}

/** 自评测维度：seat='self' 的那些（初赛权重表里没有 ⇒ 空数组，不是写死一个）。 */
export function selfDimensionsOf(board) {
  return dimensionsBySeat(board).self;
}

/**
 * 发起队 / 被评队（纯函数）。
 * ⚠️ 我参与哪些队伍来自 `GET /api/teams`（前端手里只有这个来源）；
 *    读不到时退回到赛段名册，并把 `uncertain` 置真 ⇒ 页面要说清「提交可能被服务端拒」。
 */
export function resolvePeerTeams({ board, myTeams = [], myTeamsKnown = true } = {}) {
  const roster = Array.isArray(board?.teams) ? board.teams : [];
  const mine = (myTeams ?? []).filter((t) => roster.some((r) => r.id === t.id));
  const fromTeams = mine.length ? mine : roster;
  const uncertain = !mine.length;
  const myIds = new Set(mine.map((t) => t.id));
  const toTeams = roster.filter((t) => !myIds.has(t.id));
  return { fromTeams, toTeams, uncertain, roster };
}

// ══════════════════════════════════════════════════════════════════
// 三、纯函数：指标
// ══════════════════════════════════════════════════════════════════

export function reviewPrepStats(board) {
  const progress = board?.progress ?? {};
  const teams = Array.isArray(board?.teams) ? board.teams.length : 0;
  const judgeDims = judgeDimensionsOf(board).length;
  const selfDims = selfDimensionsOf(board).length;
  const submitted = Number(progress.submitted ?? 0);
  const total = Number(progress.total ?? 0);
  return [
    { label: '赛段队伍', value: teams, tone: 'neutral', hint: `${judgeDims} 个评委席维度` },
    { label: '自评维度', value: selfDims, tone: 'neutral', hint: '自评测只在有该维度的赛段开放' },
    { label: '我的已交', value: submitted, tone: 'brand', hint: `应交 ${total} 格` },
    {
      label: '完成度',
      value: total > 0 ? `${Math.round((submitted / total) * 100)}%` : '—',
      tone: total > 0 && submitted >= total ? 'success' : 'warn',
    },
  ];
}

// ══════════════════════════════════════════════════════════════════
// 四、纯函数：区块渲染
// ══════════════════════════════════════════════════════════════════

/** 一行「维度 + 0–100 数字输入」。 */
function scoreField({ id, label, hint = '', value = '', attrs = '' }) {
  return `
      <div class="field">
        <label class="field__label" for="${escapeHtml(id)}">
          ${escapeHtml(label)}${hint ? ` <span class="muted small">${escapeHtml(hint)}</span>` : ''}
        </label>
        <input class="input" type="number" id="${escapeHtml(id)}" ${attrs}
               min="${MIN_SCORE}" max="${MAX_SCORE}" step="1"
               value="${escapeHtml(value)}" placeholder="${MIN_SCORE}–${MAX_SCORE}" />
      </div>`;
}

/** 队伍单选组（发起队 / 回避对象共用）。 */
function teamRadioGroup({ name, options, checkedId = null, attr = '' }) {
  if (!options.length) return '<p class="muted">没有可选项。</p>';
  return `<div class="radio-group">${options.map((o) => `
    <label class="radio">
      <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(o.id)}"${attr}
             ${o.id === checkedId ? 'checked' : ''} />
      <span>${escapeHtml(o.name)}</span>
    </label>`).join('')}</div>`;
}

/**
 * 已申报的回避清单（纯函数）。
 * ⚠️ **P10：读端点已补齐**（`GET /api/stages/:stageId/recusals`）⇒
 *    这里列的是**台账**（不再只是本次会话内刚提交的那一条）。
 *    台账是**追加式**的：同一 (评委, 队伍) 申报过又被撤销 ⇒ 两行都在
 *    ⇒ 用 `currentRecusals` 先折叠成「当前状态」。
 */
export function recusalListHtml({ recusals = [] } = {}) {
  if (!recusals.length) {
    return emptyState({
      title: '还没有申报过回避',
      hint: '没有利益冲突就什么都不用填 —— 回避只在「供应方 / 投资方 / 前雇主」这些情形下才需要申报。',
    });
  }
  return `<ul class="list-divided">${recusals.map((r) => {
    const revoked = r?.status === 'reinstated';
    return `<li class="row row--between">
      <span>${escapeHtml(r.teamName ?? '整个赛段')}<span class="muted small"> · ${escapeHtml(r.reason ?? '')}</span></span>
      ${badge(revoked ? '已撤销' : '已回避', revoked ? 'neutral' : 'warn')}
    </li>`;
  }).join('')}</ul>`;
}

/**
 * 把追加式台账折叠成「当前状态」（纯函数）。
 * ⚠️ 台账里同一 (评委, 队伍) 可能有多行（申报 → 又撤销 → 再申报），
 *    **最后一行**才是当前状态 ⇒ 按 (judgeId, teamId) 取最后一条。
 *    保持台账原序（按申报时间升序）⇒ 折叠后仍是时间序。
 *
 * @param {Array<object>} items GET /api/stages/:stageId/recusals 的 items
 * @returns {Array<object>}
 */
export function currentRecusals(items) {
  const list = Array.isArray(items) ? items : [];
  const last = new Map();
  for (const r of list) {
    const key = `${r?.judgeId ?? ''}::${r?.teamId ?? ''}`;
    last.set(key, r);
  }
  return [...last.values()];
}

/**
 * 回避申报区（纯函数）。
 * @param {object} o { teams, recusals }
 */
export function recusalSectionHtml({ teams = [], recusals = [] } = {}) {
  const options = [
    { id: STAGE_SCOPE, name: '整个赛段（不评任何队）' },
    ...teams.map((t) => ({ id: t.id, name: t.name })),
  ];
  const list = recusalListHtml({ recusals });
  const body = `
    <div class="field">
      <label class="field__label">回避对象</label>
      ${teamRadioGroup({ name: 'recusal-scope', options, checkedId: STAGE_SCOPE, attr: 'data-recusal-scope' })}
    </div>
    <div class="field field--required">
      <label class="field__label" for="recusal-reason">回避原因</label>
      <textarea class="textarea" id="recusal-reason" data-recusal="reason"
                placeholder="例：我是该队的供应方 / 投资方 / 前雇主"></textarea>
    </div>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-recusal">提交回避申报</button>
    </div>
    <div class="form-feedback" data-feedback="recusal" data-retry-kind="recusal"></div>
    <div data-recusal-list>${list}</div>`;
  return panel({
    title: '回避申报',
    desc: '有利益冲突就先申报回避：申报后你对该队的打分会被剔除，记录留档（赛后 6 个月可查）。',
    body,
  });
}

/**
 * 互评区（纯函数）。
 * @param {object} o { fromTeams, toTeams, uncertain }
 */
export function peerSectionHtml({ fromTeams = [], toTeams = [], uncertain = false } = {}) {
  if (!fromTeams.length) {
    return panel({
      title: '互评',
      desc: '以队对队的方式给其他队伍打分（0–100）。',
      body: emptyState({
        title: '这个赛段还没有可互评的队伍',
        hint: '队伍组建完成后，互评入口会自动出现；互评只对本赛段名册内的队伍开放。',
      }),
    });
  }
  const uncertainNotice = uncertain
    ? noticeState({
      tone: 'warn',
      title: '平台没有读到你参与的队伍',
      items: ['下面的发起队是赛段名册里的全部队伍 —— 只有你是其中某支队伍的成员时提交才会被接受。'],
    })
    : '';
  const targets = toTeams.length
    ? toTeams.map((t) => scoreField({
      id: `peer-${t.id}`,
      label: t.name,
      hint: t.taskPackageTitle ? `任务包：${t.taskPackageTitle}` : '',
      attrs: `data-peer-to="${escapeHtml(t.id)}"`,
    })).join('')
    : emptyState({
      title: '没有可互评的队伍',
      hint: '你参与的所有队伍都在这个赛段里 —— 没有别的队伍可以评。',
    });
  const body = `
    ${uncertainNotice}
    <div class="field">
      <label class="field__label">代表哪支队伍发起</label>
      ${teamRadioGroup({
    name: 'peer-from',
    options: fromTeams.map((t) => ({ id: t.id, name: t.name })),
    checkedId: fromTeams[0]?.id ?? null,
    attr: 'data-peer-from',
  })}
    </div>
    <div class="field">
      <label class="field__label">被评队伍与分值</label>
      ${targets}
    </div>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-peer">提交互评</button>
    </div>
    <div class="form-feedback" data-feedback="peer" data-retry-kind="peer"></div>`;
  return panel({
    title: '互评',
    desc: '以队对队的方式给其他队伍打分（0–100）。只有本队成员能代表本队提交；不能给自己互评。',
    body,
  });
}

/**
 * 自评区（纯函数）。
 * @param {object} o { fromTeams, dimensions, uncertain }
 */
export function selfSectionHtml({ fromTeams = [], dimensions = [], uncertain = false } = {}) {
  if (!dimensions.length) {
    return panel({
      title: '自评',
      desc: '为本队提交自评测（0–100）。',
      body: emptyState({
        title: '这个赛段没有自评维度',
        hint: '自评测只出现在决赛权重表里 —— 当前赛段的权重表没有这一项，所以这里不需要填写。',
      }),
    });
  }
  if (!fromTeams.length) {
    return panel({
      title: '自评',
      desc: '为本队提交自评测（0–100）。',
      body: emptyState({
        title: '没有找到你参与的队伍',
        hint: '自评只能由本队成员提交 —— 队伍组建完成后这里会出现可提交的队伍。',
      }),
    });
  }
  const uncertainNotice = uncertain
    ? noticeState({
      tone: 'warn',
      title: '平台没有读到你参与的队伍',
      items: ['下面的队伍是赛段名册里的全部队伍 —— 只有你是其中某支队伍的成员时提交才会被接受。'],
    })
    : '';
  const fields = dimensions.map((d) => scoreField({
    id: `self-${d.key}`,
    label: d.name ?? d.key,
    hint: `权重 ${Math.round((d.weight ?? 0) * 100)}%`,
    attrs: `data-self-dimension="${escapeHtml(d.key)}"`,
  })).join('');
  const body = `
    ${uncertainNotice}
    <div class="field">
      <label class="field__label">为哪支队伍自评</label>
      ${teamRadioGroup({
    name: 'self-team',
    options: fromTeams.map((t) => ({ id: t.id, name: t.name })),
    checkedId: fromTeams[0]?.id ?? null,
    attr: 'data-self-team',
  })}
    </div>
    ${fields}
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-self">提交自评</button>
    </div>
    <div class="form-feedback" data-feedback="self" data-retry-kind="self"></div>`;
  return panel({
    title: '自评',
    desc: '为本队提交自评测（0–100）。自评不加分：它只用来触发「书面说明」或「评委提问」。',
    body,
  });
}

/**
 * 校准区（纯函数）。
 * ⚠️ 这一区必须**明确写出「不计入评分」** —— 否则评委会把校准分当成打分，
 *    而校准分的唯一作用是把宽严尺度对齐（R-JDG-12）。
 * @param {object} o { dimensions }
 */
export function calibrationSectionHtml({ dimensions = [] } = {}) {
  if (!dimensions.length) {
    return panel({
      title: '校准',
      desc: '用同一组样例作品对齐宽严尺度。',
      body: emptyState({
        title: '这个赛段没有可校准的维度',
        hint: '校准按评委席维度逐个对齐 —— 当前赛段没有评委席维度，所以不需要校准。',
      }),
    });
  }
  const fields = dimensions.map((d) => scoreField({
    id: `calibration-${d.key}`,
    label: d.name ?? d.key,
    hint: `权重 ${Math.round((d.weight ?? 0) * 100)}%`,
    attrs: `data-calibration-dimension="${escapeHtml(d.key)}"`,
  })).join('');
  const body = `
    <div class="notice notice--info" role="alert">
      <p class="notice__title">校准分不计入评分</p>
      <p class="notice__text">校准分只用来对齐你的宽严尺度，不会进入任何队伍的得分，也不会出现在榜单里。</p>
    </div>
    ${fields}
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-calibration">提交校准分</button>
    </div>
    <div class="form-feedback" data-feedback="calibration" data-retry-kind="calibration"></div>`;
  return panel({
    title: '校准',
    desc: '用同一组样例作品对齐宽严尺度。',
    body,
  });
}

// ══════════════════════════════════════════════════════════════════
// 五、纯函数：整页渲染
// ══════════════════════════════════════════════════════════════════

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, stages, stageId, board, myTeams, myTeamsKnown, recusals }
 */
export function reviewPrepHtml(model) {
  const m = model ?? {};
  const head = pageHead({
    title: m.board?.stage?.name ? `评委前置 · ${m.board.stage.name}` : '评委前置',
    sub: '回避申报 · 互评 · 自评 · 校准 —— 正式打分之前要先走完的前置四件事。',
    actions: m.stageId
      ? [
        { label: '去评审打分', href: `#/review/${m.stageId}` },
        { label: '换个赛段', href: '#/review/prep' },
      ]
      : [],
  });
  if (m.loading) {
    return head + loadingState({ rows: 4, label: '正在加载评审工作台…' });
  }
  if (m.error) {
    return head + `<div data-retry-kind="page">${errorState({
      message: m.error,
      hint: '需要本赛段评委身份，或 score:read 能力。点「重试」重新拉一次。',
    })}</div>`;
  }
  // ⚠️ 没有赛段 ⇒ 给选择器（导航入口 `#/review/prep` 落到这里）
  if (!m.board) {
    const stages = Array.isArray(m.stages) ? m.stages : [];
    const list = stages.length
      ? `<ul class="list-divided">${stages.map((s) => `<li class="row row--between">
          <span>${escapeHtml(s.name)} <span class="muted small">${escapeHtml(s.key ?? '')}</span></span>
          <a class="btn btn--ghost btn--sm" href="#/review/prep/${escapeHtml(s.id)}">进入</a>
        </li>`).join('')}</ul>`
      : emptyState({
        title: '还没有赛段',
        hint: '组委会创建赛段后，这里会出现可以申报回避、互评、自评与校准的赛段。',
      });
    return head + panel({
      title: '赛段',
      desc: '评委前置的四个动作都发生在某一个赛段里 —— 先选一个赛段。',
      body: list,
    });
  }

  const board = m.board;
  const teams = Array.isArray(board.teams) ? board.teams : [];
  const judgeDims = judgeDimensionsOf(board);
  const selfDims = selfDimensionsOf(board);
  const { fromTeams, toTeams, uncertain } = resolvePeerTeams({
    board,
    myTeams: m.myTeams,
    myTeamsKnown: m.myTeamsKnown !== false,
  });

  return head
    + statRow(reviewPrepStats(board))
    + recusalSectionHtml({ teams, recusals: m.recusals ?? [] })
    + peerSectionHtml({ fromTeams, toTeams, uncertain })
    + selfSectionHtml({ fromTeams, dimensions: selfDims, uncertain })
    + calibrationSectionHtml({ dimensions: judgeDims });
}

/**
 * 提交反馈（纯函数）。
 * ⚠️ 成功走 noticeState，失败走 errorState —— 而 errorState **自带一个真能点的重试按钮**
 *    （`data-action="retry"`，DP-80）：不许出现「点了没反应」的死路。
 */
export function submitFeedbackHtml({ ok = false, title = '', items = [], message = '', hint = '' } = {}) {
  if (ok) return noticeState({ tone: 'success', title, items });
  return errorState({ message: message || '提交失败', hint });
}

// ══════════════════════════════════════════════════════════════════
// 六、挂载（DOM 接线）
// ══════════════════════════════════════════════════════════════════

/** 幂等键：每次提交生成一个（换内容再提交必须换键，否则服务端会 409）。 */
function newRequestId() {
  const g = globalThis.crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 评委前置页。
 *
 * ⚠️ **提交一律「本地校验 → 发请求 → 就地反馈」**（DP-80 / DP-81）：
 *    不整页刷新（冲掉已填内容 = 生产级事故），成功与失败都写在对应区块的反馈位上，
 *    失败时带一个**真能点的重试**（重试会重新读当前输入框的值）。
 */
export async function renderReviewPrep(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'review-prep-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';

  /** 页面状态（只放视图自己需要的；⛔ 不引入前端状态机）。 */
  const state = {
    stageId,
    board: null,
    myTeams: [],
    myTeamsKnown: false,
    recusals: [],
  };

  /** 读某个赛段的全部前置数据并整页重绘。 */
  const load = async () => {
    if (!state.stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = reviewPrepHtml({
        stages: Array.isArray(stages) ? stages : (stages?.items ?? []),
      });
      return;
    }
    wrap.innerHTML = reviewPrepHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/review-board`);
      state.board = board;
      // ⚠️ 我参与的队伍来自 `GET /api/teams`；读不到不是致命错误 ——
      //    页面退回「名册里的队伍」，并把「可能是别支队伍」说清楚（服务端会裁决）。
      const mine = await ctx.api.get('/api/teams').catch(() => null);
      const items = Array.isArray(mine) ? mine : (mine?.items ?? []);
      state.myTeams = Array.isArray(items) ? items : [];
      state.myTeamsKnown = Array.isArray(items);
      // ⚠️ P10：回避台账有读端点了 ⇒ 「已回避清单」显示的是**台账**，不是本次会话。
      //    读不到不是致命错误（清单为空即可，申报本身仍可用）。
      const ledger = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/recusals`)
        .catch(() => null);
      const rows = Array.isArray(ledger) ? ledger : (ledger?.items ?? []);
      state.recusals = currentRecusals(rows);
      wrap.innerHTML = reviewPrepHtml({
        stageId: state.stageId,
        board,
        myTeams: state.myTeams,
        myTeamsKnown: state.myTeamsKnown,
        recusals: state.recusals,
      });
    } catch (e) {
      wrap.innerHTML = reviewPrepHtml({ stageId: state.stageId, error: e.message });
    }
  };

  /** 反馈位（就地写，不整页刷新）。 */
  const feedback = (kind) => wrap.querySelector(`[data-feedback="${kind}"]`);

  /** 读某个单选组选中的值。 */
  const picked = (name) => {
    const el = wrap.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  };

  /** 收集一组输入框的值。 */
  const collect = (selector, keyOf) => {
    const values = {};
    for (const el of wrap.querySelectorAll(selector)) values[keyOf(el)] = el.value;
    return values;
  };

  /** 四个区块的提交：本地校验 → 发请求 → 就地反馈。 */
  const submit = async (kind) => {
    const slot = feedback(kind);
    if (!slot) return;
    const stage = encodeURIComponent(state.stageId);
    let url = '';
    let body = null;
    let errors = [];
    let payload = null;

    if (kind === 'recusal') {
      const teamId = picked('recusal-scope');
      const reason = wrap.querySelector('[data-recusal="reason"]')?.value ?? '';
      const teams = Array.isArray(state.board?.teams) ? state.board.teams : [];
      const built = buildRecusalRequest({ teamId, reason, teams });
      errors = built.errors;
      payload = built.payload;
      url = `/api/stages/${stage}/recusals`;
      body = payload;
    } else if (kind === 'peer') {
      const fromTeamId = picked('peer-from');
      const { toTeams } = resolvePeerTeams({
        board: state.board,
        myTeams: state.myTeams,
        myTeamsKnown: state.myTeamsKnown,
      });
      const values = collect('input[data-peer-to]', (el) => `${fromTeamId}::${el.dataset.peerTo}`);
      const built = buildPeerReviewItems(values, { fromTeamId, toTeams });
      errors = built.errors;
      payload = built;
      url = `/api/stages/${stage}/peer-reviews`;
      body = { items: built.items, requestId: newRequestId() };
    } else if (kind === 'self') {
      const teamId = picked('self-team');
      const dimensions = selfDimensionsOf(state.board);
      const values = collect('input[data-self-dimension]', (el) => el.dataset.selfDimension);
      const built = buildSelfReviewItems(values, dimensions);
      errors = built.errors;
      payload = built;
      if (!teamId) errors = [{ field: 'teamId', message: '还没选要自评的队伍' }, ...errors];
      url = `/api/stages/${stage}/self-review`;
      body = { teamId, items: built.items, requestId: newRequestId() };
    } else if (kind === 'calibration') {
      const dimensions = judgeDimensionsOf(state.board);
      const values = collect('input[data-calibration-dimension]', (el) => el.dataset.calibrationDimension);
      const built = buildCalibrationItems(values, dimensions);
      errors = built.errors;
      payload = built;
      url = `/api/stages/${stage}/calibration`;
      body = { items: built.items };
    }

    if (errors.length) {
      slot.innerHTML = submitFeedbackHtml({
        ok: false,
        message: `还有 ${errors.length} 处没填好`,
        hint: errors.map((x) => x.message).join('；'),
      });
      return;
    }

    try {
      const res = await ctx.api.post(url, body);
      if (kind === 'recusal') {
        // ⚠️ P10：回避台账**有读端点**了 ⇒ 提交成功后**重读台账**，
        //    而不是把服务端返回的那一行本地追加（本地追加会把「整段回避」与
        //    「某一队回避」记成两条，也让台账与页面长期不一致）。
        const ledger = await ctx.api.get(`/api/stages/${encodeURIComponent(stage)}/recusals`)
          .catch(() => null);
        const rows = Array.isArray(ledger) ? ledger : (ledger?.items ?? []);
        state.recusals = rows.length ? currentRecusals(rows) : state.recusals;
        const list = wrap.querySelector('[data-recusal-list]');
        if (list) list.innerHTML = recusalListHtml({ recusals: state.recusals });
      }
      slot.innerHTML = submitFeedbackHtml({
        ok: true,
        title: '已提交',
        items: [
          kind === 'recusal'
            ? '回避已留档 —— 你对该队的打分会被剔除。'
            : kind === 'peer'
              ? `互评 ${payload.items.length} 条已记入（同一支队伍再评一次会覆盖）。`
              : kind === 'self'
                ? `自评 ${payload.items.length} 项已记入（自评不加分，只触发解释与提问）。`
                : `校准分 ${payload.items.length} 项已记入（不计入评分）。`,
        ],
      });
    } catch (e) {
      slot.innerHTML = submitFeedbackHtml({
        ok: false,
        message: e.message,
        hint: '点「重试」会按当前填写的内容重新提交一次。',
      });
    }
  };

  await load();

  // ⚠️ **事件绑定在 wrap 上（委托）**：反馈位被整体重写也不会丢重试逻辑。
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      const host = btn.closest('[data-retry-kind]');
      const kind = host?.dataset?.retryKind;
      if (!kind) return;
      if (kind === 'page') { load(); return; }
      submit(kind);
      return;
    }
    if (action === 'submit-recusal') submit('recusal');
    else if (action === 'submit-peer') submit('peer');
    else if (action === 'submit-self') submit('self');
    else if (action === 'submit-calibration') submit('calibration');
  });

  return wrap;
}

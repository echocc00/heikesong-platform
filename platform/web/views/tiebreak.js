// web/views/tiebreak.js — 加时陈述 / 一票破同分页面
//
// 规则溯源（口径一律以源码为准）：
//   - 「同分 → 10 分钟加时陈述 → 企业席 + 评委席共同复议」→ R-JDG-19（S7 §3.3）
//     + src/services/tiebreak.js（服务层：谁能开轮次 / 谁能投票 / 关闭幂等）
//   - 「可见性在 API 层过滤，前端只负责呈现」→ 全局约束（DP-77）
//     ⇒ 本视图**不判权限**、**不过滤 votes**（API 已裁剪过；前端再过滤一遍 = 两套口径）
//   - 「错误态必须带真能点的重试」→ DP-80；「不许整页刷新 / 不许冲掉已填内容」→ DP-81
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js 文件头 + 机器闸
//   - 「颜色只走设计令牌 / 卡片零外阴影 / 一屏强调色 ≤3」→ P10 设计系统
//   - 「HTML 文本插值一律过 escapeHtml（全站唯一转义入口）」→ web/escape.js
//
// ⚠️ **前端不判权限**：能不能开轮次、能不能看投票明细，一律由 API 裁决
//   （全局约束「授权的唯一裁决者是 can()，前端只拿到提示」）。
//   ⇒ 「开启一轮」「关闭轮次」按钮**始终渲染**；被 403 时把服务端的中文原因显示出来。
//   ⚠️ 反过来做（前端按能力点藏按钮）= 前端替 API 做了授权判断 ⇒
//     一旦服务端放宽口径（换个赛段就有权了），前端就永远进不去 —— 与「前端隐藏 = 数据已泄露」同源。
//
// ⚠️ **队名是「尽力而为」**：加时陈述的端点只给 teamId。
//   队名取自 `GET /api/stages/:stageId/review-board` 的名册 —— 该端点对评委/组委会开放，
//   对普通登录用户 403 ⇒ 取不到时**退回显示 teamId**，
//   绝不能因为「拿不到队名」就让整个页面失败。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, emptyRow, errorState, loadingState, noticeState, pageHead,
  panel, rankBadge, sectionTitle, statRow, tableWrap,
} from '../ui.js';

/** 投票分范围：0–100 百分制（与服务层 SCORE_OUT_OF_RANGE 同一口径）。 */
const MIN_SCORE = 0;
const MAX_SCORE = 100;
/** 加时陈述时长默认值（S7 §3.3：10 分钟）。 */
const DEFAULT_MINUTES = 10;

/**
 * 时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。
 * ⚠️ 与 web/views/signoff.js 的 fmtTime 同一口径 —— 两个视图各写一份就会漂。
 */
function fmtTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 保留两位小数（均值会出现 15.200000000000003 这种浮点尾巴）。 */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：轮次 / 票数 / 均值 → 视图模型
// ══════════════════════════════════════════════════════════════════

/**
 * 同分组队伍（纯函数）。
 * ⚠️ 两种字段名都认（camelCase / snake_case）：API 同时给了两层形状
 *   （见 src/http/routes/tiebreak.js 的 presentRound），视图按驼峰读、读不到再退回蛇形。
 *
 * @param {object|null} round 轮次
 * @param {object} teamNames  队名映射 { teamId: name }
 * @returns {Array<{teamId:string, teamName:string}>}
 */
export function tiebreakTiedTeams(round, teamNames = {}) {
  const raw = round?.tiedTeamIds ?? round?.tied_team_ids_json ?? [];
  const ids = Array.isArray(raw) ? raw : [];
  return ids
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
    .map((teamId) => ({ teamId, teamName: String(teamNames?.[teamId] ?? teamId) }));
}

/**
 * 复议分统计行（纯函数）：按均值降序（均值高的排前面 = 复议领先）。
 * ⚠️ 排序必须**确定**：均值相同用 teamId 兜底（全局约定：确定性排序的兜底键不用随机值）。
 *
 * @param {object} tallies  { [teamId]: { count, sum, mean } }
 * @param {object} teamNames
 */
export function tiebreakTallyRows(tallies, teamNames = {}) {
  const entries = Object.entries(tallies ?? {});
  return entries
    .map(([teamId, t]) => ({
      teamId: String(teamId),
      teamName: String(teamNames?.[teamId] ?? teamId),
      count: Number(t?.count ?? 0),
      sum: Number(t?.sum ?? 0),
      mean: Number(t?.mean ?? 0),
    }))
    .sort((a, b) => (b.mean - a.mean) || (a.teamId < b.teamId ? -1 : (a.teamId > b.teamId ? 1 : 0)));
}

/**
 * 投票明细行（纯函数）。
 * ⚠️ 投票人只给 id —— 要不要给姓名由**服务端**决定（前端不替服务端改口径）。
 */
export function tiebreakVoteRows(votes, teamNames = {}) {
  return (Array.isArray(votes) ? votes : []).map((v) => {
    const teamId = String(v?.teamId ?? v?.team_id ?? '');
    return {
      voterId: String(v?.voterId ?? v?.voter_id ?? ''),
      teamId,
      teamName: String(teamNames?.[teamId] ?? teamId),
      score: Number(v?.score ?? 0),
      votedAt: v?.votedAt ?? v?.voted_at ?? null,
    };
  });
}

/**
 * 「待投队伍」（纯函数）：同分组里**还没有收到任何票**的队伍。
 * ⚠️ 口径说明：这里说的是「还没有人投的队」（票数 = 0），
 *   不是「我没投过的队」—— 后者要靠「每个评委投了什么」才能算，
 *   而普通用户看不到投票明细（API 已裁剪）⇒ 前端**不能**自己推断「我投过哪些」。
 */
export function tiebreakPendingTeams(tiedTeams, tallyRows) {
  const voted = new Set(tallyRows.filter((r) => r.count > 0).map((r) => r.teamId));
  return tiedTeams.filter((t) => !voted.has(t.teamId));
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：HTML 渲染（⛔ 服务端数据一律过 escapeHtml）
// ══════════════════════════════════════════════════════════════════

/** 赛段选择器（纯 HTML）。 */
function stagePickerHtml(stages, stageId) {
  if (!stages.length) {
    return '<p class="muted small">还没有赛段 —— 赛段由组委会创建后，这里才会出现可选项。</p>';
  }
  const options = stages.map((s) => `<option value="${escapeHtml(s.id)}"${String(s.id) === String(stageId) ? ' selected' : ''}>${escapeHtml(s.name || s.key || s.id)}</option>`).join('');
  return `<div class="field">
      <label class="field__label" for="tiebreak-stage">赛段</label>
      <select class="select" id="tiebreak-stage" data-tiebreak="stage">
        ${options}
      </select>
      <p class="field__hint">加时陈述按赛段开轮 —— 同一赛段同时只能有一轮进行中的加时陈述。</p>
    </div>`;
}

/** 轮次概览（纯 HTML）。 */
function roundPanelHtml(round, tiedTeams, pendingTeams, voteCount) {
  if (!round) {
    return emptyState({
      title: '本赛段还没有加时陈述轮次',
      hint: '同分的队伍由组委会开一轮加时陈述（10 分钟陈述 + 评委席复议投票）。',
    });
  }
  const isOpen = String(round.status) === 'open';
  const deadline = fmtTime(round.statementDeadline ?? round.statement_deadline);
  const pendingNames = pendingTeams.map((t) => t.teamName).join('、');
  const teams = tiedTeams.length
    ? `<ul class="list-divided">${tiedTeams.map((t) => `<li><span>${escapeHtml(t.teamName)}</span></li>`).join('')}</ul>`
    : '<p class="muted small">（同分组名单为空）</p>';
  const stats = statRow([
    { label: '轮次状态', value: isOpen ? '进行中' : '已关闭', tone: isOpen ? 'warn' : 'neutral' },
    { label: '陈述截止', value: deadline || '—', hint: '陈述结束后由评委席复议投票' },
    { label: '同分组队伍', value: String(tiedTeams.length) },
    { label: '已收到票数', value: String(voteCount) },
  ]);
  return `<div class="row">${badge(isOpen ? '进行中' : '已关闭', isOpen ? 'warn' : 'neutral')}</div>
    ${stats}
    ${sectionTitle('同分组队伍')}
    ${teams}
    <p class="muted small">${pendingTeams.length
      ? `还没有人投票的队伍：${escapeHtml(pendingNames)}`
      : '同分组每支队伍都已收到票。'}</p>`;
}

/** 复议分统计表（纯 HTML）。 */
function tallyTableHtml(tallyRows) {
  if (!tallyRows.length) {
    return emptyState({
      title: '还没有复议分',
      hint: '评委席投完票后，这里会显示每支队伍的票数、总分与均值。',
    });
  }
  const body = tallyRows.map((r, i) => `<tr>
      <td>${rankBadge(i + 1)}</td>
      <td>${escapeHtml(r.teamName)}</td>
      <td class="td-num num">${escapeHtml(r.count)}</td>
      <td class="td-num num">${escapeHtml(round2(r.sum))}</td>
      <td class="td-num num">${escapeHtml(round2(r.mean))}</td>
    </tr>`).join('');
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">票数</th><th class="td-num">总分</th><th class="td-num">均值</th></tr></thead>
     <tbody>${body || emptyRow(5, '还没有复议分')}</tbody>`,
    { caption: '各队复议分统计（票数 / 总分 / 均值）' },
  );
}

/** 投票明细表（纯 HTML）。 */
function voteTableHtml(voteRows, tallyRows) {
  if (!voteRows.length) {
    // ⚠️ 「有统计但没明细」= 这个人不是本赛段评委 / 组委会（API 已把 votes 收窄为空）。
    //   这时**不猜**权限，只说明「明细不在这份响应里」，并把统计结果照给。
    if (tallyRows.length) {
      return '<p class="muted small">投票明细（谁投了多少分）只对本赛段评委与组委会可见；上面的统计结果对所有人可见。</p>';
    }
    return emptyState({ title: '还没有投票', hint: '轮次开放期间，本赛段评委可以给同分组队伍打复议分。' });
  }
  const body = voteRows.map((v) => `<tr>
      <td>${escapeHtml(v.voterId)}</td>
      <td>${escapeHtml(v.teamName)}</td>
      <td class="td-num num">${escapeHtml(round2(v.score))}</td>
      <td>${escapeHtml(fmtTime(v.votedAt))}</td>
    </tr>`).join('');
  return tableWrap(
    `<thead><tr><th>投票人</th><th>队伍</th><th class="td-num">复议分</th><th>投票时间</th></tr></thead>
     <tbody>${body}</tbody>`,
    { caption: '复议投票明细' },
  );
}

/**
 * 投票表单（纯 HTML）。
 * ⚠️ `teamId` / `score` 是**草稿值**：重绘时回填 ⇒ 用户已填的分数不会被冲掉（DP-81）。
 */
function voteFormHtml(round, tiedTeams, { teamId = '', score = '' } = {}) {
  if (!round || String(round.status) !== 'open') {
    return '<p class="muted small">轮次未开放投票。</p>';
  }
  if (!tiedTeams.length) {
    return '<p class="muted small">本轮没有可投票的队伍。</p>';
  }
  const options = tiedTeams.map((t) => `<option value="${escapeHtml(t.teamId)}"${t.teamId === teamId ? ' selected' : ''}>${escapeHtml(t.teamName)}</option>`).join('');
  return `<div class="field">
      <label class="field__label" for="tiebreak-team">被投票的队伍</label>
      <select class="select" id="tiebreak-team" data-tiebreak="team">
        ${options}
      </select>
    </div>
    <div class="field field--required">
      <label class="field__label" for="tiebreak-score">复议分（${MIN_SCORE}–${MAX_SCORE}）</label>
      <input class="input" id="tiebreak-score" type="number" inputmode="decimal"
        min="${MIN_SCORE}" max="${MAX_SCORE}" step="0.1" data-tiebreak="score" value="${escapeHtml(score)}" />
      <p class="field__hint">一人一队一票（重复投票服务端会拒绝）；观察员无投票权。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="vote-submit">提交复议分</button>
    </div>`;
}

/** 开启一轮 / 关闭轮次（纯 HTML）。 */
function actionsPanelHtml({ round, roster, minutes }) {
  const isOpen = Boolean(round) && String(round.status) === 'open';
  const rosterHtml = roster.length
    ? `<ul class="list-divided">${roster.map((t) => `<li>
        <label class="row">
          <input type="checkbox" data-tiebreak="tied" value="${escapeHtml(t.id)}" data-team-id="${escapeHtml(t.id)}" />
          <span>${escapeHtml(t.name || t.id)}</span>
        </label>
      </li>`).join('')}</ul>`
    : `<div class="field">
        <label class="field__label" for="tiebreak-teams">同分组队伍 id（逗号分隔）</label>
        <input class="input" id="tiebreak-teams" data-tiebreak="tied-ids" autocomplete="off" />
        <p class="field__hint">拿不到名册时，可直接粘贴同分组队伍 id（至少两支，逗号分隔）。</p>
      </div>`;
  const openForm = `<div class="field">
      <label class="field__label" for="tiebreak-minutes">陈述时长（分钟）</label>
      <input class="input" id="tiebreak-minutes" type="number" inputmode="numeric"
        min="1" max="240" step="1" value="${escapeHtml(minutes)}" data-tiebreak="minutes" />
      <p class="field__hint">默认 ${DEFAULT_MINUTES} 分钟（S7 §3.3）。</p>
    </div>
    ${sectionTitle('勾选同分队伍（至少两支）')}
    ${rosterHtml}
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="round-open">开启一轮加时陈述</button>
    </div>`;
  const closeBtn = isOpen
    ? `<div class="row">
        <button type="button" class="btn btn--ghost" data-action="round-close">关闭本轮加时陈述</button>
      </div>
      <p class="muted small">关闭后不再接受投票；已投的票与复议分保留（关闭是幂等的）。</p>`
    : `<p class="muted small">${round ? '本赛段当前没有进行中的轮次。' : '本赛段还没有轮次。'}</p>`;
  return `${openForm}
    ${sectionTitle('关闭轮次')}
    ${closeBtn}`;
}

/**
 * 整页 HTML（纯函数，可单测）。
 * @param {object} model { loading, error, stageId, stages, round, votes, tallies, teamNames, roster, minutes, feedback, teamDraft, scoreDraft }
 */
export function tiebreakPageHtml(model = {}) {
  const head = pageHead({
    title: '加时陈述 · 一票破同分',
    sub: '同分队伍进入加时陈述，评委席复议打分；复议分是赛段级产物（R-JDG-19）。',
  });
  const stages = Array.isArray(model.stages) ? model.stages : [];
  const stagePanel = panel({
    title: '赛段',
    desc: '加时陈述按赛段开轮 —— 同一赛段同时只能有一轮进行中的加时陈述。',
    body: stagePickerHtml(stages, model.stageId ?? ''),
  });

  if (model.loading) {
    return `${head}${stagePanel}${loadingState({ rows: 4, label: '正在加载加时陈述…' })}`;
  }
  if (model.error) {
    return `${head}${stagePanel}${errorState({
      message: model.error,
      hint: '点「重试」重新拉一次加时陈述数据。',
    })}`;
  }
  if (!model.stageId) {
    return `${head}${stagePanel}${emptyState({
      title: '先选一个赛段',
      hint: '加时陈述挂在赛段上：同一赛段同时只能有一轮进行中的加时陈述。',
    })}`;
  }

  const teamNames = model.teamNames ?? {};
  const tiedTeams = tiebreakTiedTeams(model.round, teamNames);
  const tallyRows = tiebreakTallyRows(model.tallies, teamNames);
  const voteRows = tiebreakVoteRows(model.votes, teamNames);
  const pendingTeams = tiebreakPendingTeams(tiedTeams, tallyRows);
  const feedbackHtml = model.feedback
    ? noticeState({
      tone: model.feedback.tone ?? 'info',
      title: model.feedback.title ?? '',
      items: model.feedback.items ?? [],
      list: true,
    })
    : '';

  return `${head}
    ${stagePanel}
    ${feedbackHtml}
    ${panel({ title: '当前轮次', desc: '陈述截止后由评委席复议投票。', body: roundPanelHtml(model.round, tiedTeams, pendingTeams, voteRows.length) })}
    ${panel({ title: '投一票', desc: '一人一队一票；观察员无投票权，已回避的评委不能投。', body: voteFormHtml(model.round, tiedTeams, { teamId: model.teamDraft ?? '', score: model.scoreDraft ?? '' }) })}
    ${panel({ title: '复议分统计', desc: '票数 / 总分 / 均值（均值高者领先）。', body: tallyTableHtml(tallyRows) })}
    ${panel({ title: '投票明细', desc: '谁投了多少分。', body: voteTableHtml(voteRows, tallyRows) })}
    ${panel({ title: '轮次操作', desc: '开轮次与关轮次由组委会执行（stage:compute）。', body: actionsPanelHtml({ round: model.round, roster: model.roster ?? [], minutes: model.minutes ?? DEFAULT_MINUTES }) })}`;
}

// ══════════════════════════════════════════════════════════════════
// 三、DOM 接线（renderTiebreak）
// ══════════════════════════════════════════════════════════════════

/**
 * 加时陈述视图。
 *
 * ⚠️ **交互纪律**（照抄 web/views/signoff.js）：
 *   ① 提交一律「本地校验 → 发请求 → 就地反馈」；
 *   ② 提交成功后**重新拉一次**（不是本地改状态）⇒ 页面显示的永远是服务端口径；
 *   ③ 重绘时**回填草稿**（队伍 / 分数）⇒ 用户已填的内容不会被冲掉（DP-81）；
 *   ④ 加载 / 错误 / 空态全部用 web/ui.js 的现成组件（不自己造）；
 *   ⑤ 所有 DOM 读取都用可选链 —— 最小 DOM 桩上不许抛。
 */
export async function renderTiebreak(ctx) {
  const wrap = document.createElement('div');
  // ⚠️ 只用**既有** class（不造新的 CSS 类、不写 <style>）：stack = 通用纵向堆叠。
  wrap.className = 'stack';

  const state = {
    stageId: String(ctx?.params?.stageId ?? ctx?.query?.stageId ?? ''),
    stages: [],
    roster: [],
    teamNames: {},
    round: null,
    votes: [],
    tallies: {},
    minutes: DEFAULT_MINUTES,
    loading: true,
    error: null,
    feedback: null,
    // ⚠️ 草稿：重绘时回填 ⇒ 已填的分数不会被冲掉（DP-81）。
    teamDraft: '',
    scoreDraft: '',
  };

  /** 重绘整页。 */
  const render = () => {
    wrap.innerHTML = tiebreakPageHtml(state);
  };

  /** 读某个输入框的值（读不到就当空串 —— 最小 DOM 桩上不许抛）。 */
  const value = (selector) => {
    const el = wrap.querySelector(selector);
    return el && typeof el.value === 'string' ? el.value : '';
  };

  /** 队名映射（teamId → 队名）。 */
  const buildTeamNames = (teams) => {
    const map = {};
    for (const t of teams) {
      if (t?.id) map[String(t.id)] = String(t.name || t.id);
    }
    return map;
  };

  /** 赛段列表（失败不致命：没有赛段就只显示选择器）。 */
  const loadStages = async () => {
    try {
      const data = await ctx.api.get('/api/stages');
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      state.stages = Array.isArray(items) ? items : [];
    } catch {
      state.stages = [];
    }
    if (!state.stageId && state.stages.length) state.stageId = String(state.stages[0].id);
  };

  /** 赛段名册（**尽力而为**：只为显示队名；取不到就退回显示 teamId）。 */
  const loadRoster = async () => {
    if (!state.stageId) {
      state.roster = [];
      state.teamNames = {};
      return;
    }
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/review-board`);
      const teams = Array.isArray(board?.teams) ? board.teams : [];
      state.roster = teams;
      state.teamNames = buildTeamNames(teams);
    } catch {
      // ⚠️ 普通登录用户没有评审工作台的读权限 ⇒ 拿不到名册是**正常**的，不该报错。
      state.roster = [];
      state.teamNames = {};
    }
  };

  /** 本赛段的轮次列表 + 当前轮次状态（数据变了 ⇒ 末尾重绘）。 */
  const loadRounds = async () => {
    if (!state.stageId) {
      state.round = null;
      state.votes = [];
      state.tallies = {};
      render();
      return;
    }
    const list = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/tiebreak/rounds`);
    const items = Array.isArray(list?.items) ? list.items : [];
    // ⚠️ 当前轮次 = **进行中的那一轮**；没有进行中的就取最近一轮（列表已按 created_at, rowid 定序）。
    const open = items.find((r) => String(r?.status) === 'open');
    const current = open ?? (items.length ? items[items.length - 1] : null);
    if (!current) {
      state.round = null;
      state.votes = [];
      state.tallies = {};
      render();
      return;
    }
    const detail = await ctx.api.get(`/api/tiebreak/rounds/${encodeURIComponent(current.id)}`);
    state.round = detail?.round ?? current;
    state.votes = Array.isArray(detail?.votes) ? detail.votes : [];
    state.tallies = detail?.tallies ?? {};
    render();
  };

  /** 首屏 / 重试：一次把页面需要的数据拉齐。 */
  const loadAll = async () => {
    state.loading = true;
    state.error = null;
    render();
    try {
      await loadStages();
      await loadRoster();
      await loadRounds();
    } catch (e) {
      state.error = e?.message ?? '加载失败';
      render();
    } finally {
      state.loading = false;
      render();
    }
  };

  /** 提交一票。 */
  const submitVote = async () => {
    const round = state.round;
    if (!round || String(round.status) !== 'open') {
      state.feedback = { tone: 'warn', title: '当前没有可投票的轮次', items: ['轮次已关闭或还没开启。'] };
      render();
      return;
    }
    const teamId = value('[data-tiebreak="team"]') || state.teamDraft;
    const scoreText = (value('[data-tiebreak="score"]') || state.scoreDraft).trim();
    const score = Number(scoreText);
    if (!teamId) {
      state.feedback = { tone: 'warn', title: '还没选队伍', items: ['先选要打分的队伍。'] };
      render();
      return;
    }
    if (scoreText === '' || !Number.isFinite(score) || score < MIN_SCORE || score > MAX_SCORE) {
      state.feedback = {
        tone: 'warn',
        title: '复议分不合法',
        items: [`复议分必须是 ${MIN_SCORE}–${MAX_SCORE} 之间的数字。`],
      };
      render();
      return;
    }
    try {
      await ctx.api.post(`/api/tiebreak/rounds/${encodeURIComponent(round.id)}/votes`, { teamId, score });
      state.feedback = { tone: 'success', title: '已提交复议分', items: ['投票已记入（一人一队一票）。'] };
      await loadRounds();
    } catch (e) {
      // ⚠️ 服务端的中文原因原样透出（重复投票 / 轮次已关闭 / 观察员无投票权 …）
      state.feedback = { tone: 'danger', title: '投票失败', items: [e?.message ?? '提交失败'] };
      render();
    }
  };

  /** 开启一轮加时陈述。 */
  const openRound = async () => {
    // ⚠️ 勾选的队伍（名册口径）；拿不到名册时读「逗号分隔的 id」输入框。
    const boxes = Array.from(wrap.querySelectorAll('[data-tiebreak="tied"]') ?? []);
    const picked = [];
    for (const box of boxes) {
      const id = String(box?.dataset?.teamId ?? box?.value ?? '').trim();
      if (id && box?.checked) picked.push(id);
    }
    if (!picked.length) {
      const raw = value('[data-tiebreak="tied-ids"]');
      for (const part of String(raw).split(/[,，\s]+/)) {
        const id = part.trim();
        if (id) picked.push(id);
      }
    }
    if (picked.length < 2) {
      state.feedback = {
        tone: 'warn',
        title: '同分组至少要两支队伍',
        items: ['只有一支队伍就不用加时陈述了（直接按原始分排名）。'],
      };
      render();
      return;
    }
    const minutesText = value('[data-tiebreak="minutes"]').trim();
    const minutes = minutesText === '' ? DEFAULT_MINUTES : Number(minutesText);
    try {
      await ctx.api.post(`/api/stages/${encodeURIComponent(state.stageId)}/tiebreak/rounds`, {
        tiedTeamIds: picked,
        statementMinutes: Number.isFinite(minutes) ? minutes : DEFAULT_MINUTES,
      });
      state.feedback = { tone: 'success', title: '已开启加时陈述', items: ['同分组队伍进入陈述，评委席随后复议投票。'] };
      await loadRounds();
    } catch (e) {
      state.feedback = { tone: 'danger', title: '开轮次失败', items: [e?.message ?? '提交失败'] };
      render();
    }
  };

  /** 关闭当前轮次。 */
  const closeRound = async () => {
    const round = state.round;
    if (!round) return;
    try {
      await ctx.api.post(`/api/tiebreak/rounds/${encodeURIComponent(round.id)}/close`, {});
      state.feedback = { tone: 'success', title: '轮次已关闭', items: ['不再接受投票；已投的票与复议分保留。'] };
      await loadRounds();
    } catch (e) {
      state.feedback = { tone: 'danger', title: '关闭失败', items: [e?.message ?? '操作失败'] };
      render();
    }
  };

  await loadAll();

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘不会丢监听。
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset?.action;
    if (action === 'retry') {
      await loadAll();
      return;
    }
    if (action === 'vote-submit') {
      await submitVote();
      return;
    }
    if (action === 'round-open') {
      await openRound();
      return;
    }
    if (action === 'round-close') {
      await closeRound();
      return;
    }
  });

  // 草稿回填：记住用户填了什么 ⇒ 重绘时不冲掉（DP-81）。
  wrap.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.tiebreak;
    if (kind === 'score') state.scoreDraft = el.value;
    if (kind === 'tied-ids') return;
  });

  // 换赛段 / 换队伍：只改数据，不整页刷新输入框。
  wrap.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.tiebreak;
    if (kind === 'team') {
      state.teamDraft = el.value;
      return;
    }
    if (kind !== 'stage') return;
    state.stageId = el.value;
    state.round = null;
    state.votes = [];
    state.tallies = {};
    state.feedback = null;
    state.teamDraft = '';
    state.scoreDraft = '';
    loadRoster()
      .then(loadRounds)
      .catch((e) => {
        state.error = e?.message ?? '加载失败';
        render();
      });
  });

  return wrap;
}

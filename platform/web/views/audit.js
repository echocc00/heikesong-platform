// web/views/audit.js — 计算留痕 trace 抽屉
// 依据：设计文档 §9「发榜页：榜单 + trace 抽屉（点任一队伍 → 展开每一步：
//   原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分）；降级告警置顶」
//   + §12 三件套结构 + S-5「降级状态可见」
//   + R-AUD-01（每次发榜/计分可复算）、R-AUD-02（计算留输入快照）
//   + C-05（z-score 样本不足时必须显式暴露「本轮未做评委宽严归一化」）
// ⛔ 降级告警置顶且不可折叠：榜单页必须显式提示"本轮该维度未做评委宽严归一化（样本不足 5）"。
// ⛔ 复算 diff 必须**被看见**（不能只写一条日志）：抽屉里直接给出 identical + 逐条 path。
//
// ⚠️ **DOM 顺序是测试契约**（platform/test/audit-api.test.js）：
//    wrap.children = [页头, 主体]；主体的子元素**只能**是三个且顺序固定：
//    [0] 降级告警 / [1] 队伍 trace / [2] 复算操作区。
//    ⇒ 加载态与错误态只能放进页头（#au-msg / #au-state）；
//      往主体里插第 0 个子元素会把索引顶掉（测试按 children[i] 断言）。
//    ⇒ 三个主体子元素**一次性建好**，之后只填内容 —— 重载不会多出子元素。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, statRow,
} from '../ui.js';

/** 六步留痕（顺序 = 计算顺序，标签是测试契约，一个字都不能改）。 */
const STEPS = [
  ['raw', '原始分'],
  ['z', 'z 分'],
  ['trim', '去极值'],
  ['weights', '加权'],
  ['total', '总分'],
  ['tiebreak', '破同分'],
];

export function renderAudit(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'audit-trace';

  const head = document.createElement('div');
  head.innerHTML = `
    ${pageHead({
      title: '计算留痕',
      sub: '每一步都能复算：原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分',
    })}
    <p class="muted small" id="au-msg">正在加载计算快照…</p>
    <div id="au-stats"></div>
    <div id="au-state"></div>`;
  wrap.appendChild(head);

  // ── 主体：三个子元素，位置固定（见文件头 ⚠️）────────────────────
  const body = document.createElement('div');
  body.id = 'au-body';

  const warnBox = document.createElement('div');
  warnBox.className = 'stack';

  const teamsBox = document.createElement('div');
  teamsBox.id = 'au-teams';

  const actionsBox = document.createElement('div');
  actionsBox.className = 'trace-actions';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--primary';
  // ⚠️ textContent 必须**恰好**是这串（测试断言 === '用同一输入复算并比对'）
  btn.textContent = '用同一输入复算并比对';

  const diffBox = document.createElement('div');
  diffBox.id = 'au-diff';
  diffBox.innerHTML = '<p class="muted">尚未复算：点上面的按钮，用同一份输入重跑一遍引擎，逐字段与快照比对。</p>';

  actionsBox.appendChild(btn);
  actionsBox.appendChild(diffBox);

  body.appendChild(warnBox);
  body.appendChild(teamsBox);
  body.appendChild(actionsBox);
  wrap.appendChild(body);

  const msg = wrap.querySelector('#au-msg');
  const statsBox = wrap.querySelector('#au-stats');
  const stateBox = wrap.querySelector('#au-state');

  const computationId = ctx.params?.computationId || ctx.getState?.().computationId;

  if (!computationId) {
    msg.textContent = '缺少 computationId：请从发榜页点任一队伍进入。';
    statsBox.innerHTML = '';
    stateBox.innerHTML = emptyState({
      title: '没有指定计算快照',
      hint: '计算留痕是「从发榜页点某支队伍」进入的：回到榜单页，点任一队伍即可展开它的计算过程。',
    });
    return wrap;
  }

  // ⚠️ 重试用**事件委托**绑定：errorState() 生成的重试按钮没有固定 id，
  //    委托到容器上，按钮标记变化也不会失效。
  stateBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void reload();
  });
  diffBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void runDiff();
  });

  async function reload() {
    msg.textContent = '正在加载计算快照…';
    statsBox.innerHTML = '';
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载计算快照…' });
    let data;
    try {
      data = await ctx.api.get(`/api/audit/computations/${encodeURIComponent(computationId)}`);
    } catch (e) {
      msg.textContent = '计算快照加载失败';
      stateBox.innerHTML = errorState({
        message: e.message,
        hint: '快照没拉到。可以重试；若持续失败，回发榜页重新点开任一队伍。',
      });
      return;
    }
    stateBox.innerHTML = '';
    msg.textContent = `规则版本 ${data.ruleVersion} ｜ revision ${data.revision} ｜ 生成于 ${data.createdAt}`;
    renderSnapshot(data);
  }

  /** 把快照画成：降级告警 + 每队六步 + 指标。 */
  function renderSnapshot(data) {
    const norm = data.trace?.normalization ?? {};
    const teams = data.output?.teams ?? [];

    // ── 降级告警（body.children[0]）：硬降级 vs 提示，分级呈现 ──
    const hard = [];   // 硬降级：归一化没生效 ⇒ 直接影响得分口径
    const soft = [];   // 提示：引擎告警，不改分
    for (const [dim, v] of Object.entries(norm)) {
      if (v && v.normalized === false) {
        hard.push(`${dim}：未做评委宽严归一化（${v.fallbackReason ?? '未知原因'}）`);
      }
    }
    for (const w of (data.trace?.warnings ?? [])) {
      soft.push(w?.message ?? String(w));
    }
    const all = [...hard, ...soft];
    warnBox.innerHTML = `
      <div class="row">
        ${badge(`硬降级 ${hard.length}`, hard.length ? 'danger' : 'neutral')}
        ${badge(`提示 ${soft.length}`, soft.length ? 'warn' : 'neutral')}
      </div>
      ${noticeState({
        tone: 'warn',
        title: `降级告警（${all.length}）`,
        items: all.length
          ? all.map((w, i) => `${i < hard.length ? '【硬降级】' : '【提示】'}${w}`)
          : ['本轮计算没有触发任何降级：评委宽严归一化已生效。'],
        list: true,
      })}`;

    statsBox.innerHTML = statRow([
      { label: '参评队伍', value: teams.length, tone: 'brand' },
      { label: '降级项', value: all.length, tone: all.length ? 'warn' : 'success' },
      { label: '归一化维度', value: Object.keys(norm).length, tone: 'neutral' },
    ]);

    // ── 每队六步（body.children[1]）──────────────────────────────
    const perTeam = data.trace?.perTeam ?? {};
    teamsBox.replaceChildren();
    if (!teams.length) {
      teamsBox.innerHTML = emptyState({
        title: '这份快照没有队伍结果',
        hint: 'output.teams 为空：该赛段还没有有效评分。等组委会发榜后，这里会出现每支队伍的计算过程。',
      });
      return;
    }
    for (const t of teams) {
      teamsBox.appendChild(renderTeamTrace(t, perTeam[t.teamId] ?? {}, data));
    }
  }

  /** 单支队伍的时间线：六步各一行，数值右对齐。 */
  function renderTeamTrace(t, tr, data) {
    const item = document.createElement('details');
    item.className = 'team-trace';
    const rank = t.rank !== undefined && t.rank !== null ? `第 ${t.rank} 名` : '未排名';
    const tied = Array.isArray(t.tiedWith) && t.tiedWith.length ? `并列 ${t.tiedWith.join('、')}` : '';
    item.innerHTML = `
      <summary>
        <span class="row row--between">
          <span>队伍 ${escapeHtml(t.teamId)}</span>
          <span class="row">
            ${badge(rank, t.rank === 1 ? 'brand' : 'neutral')}
            ${badge(`总分 ${t.total ?? '—'}`, 'info')}
            ${tied ? badge(tied, 'warn') : ''}
          </span>
        </span>
      </summary>
      <dl class="kv">
        ${STEPS.map(([key, label]) => {
          // ⚠️ 数值型步骤（原始分 / z 分 / 权重 / 总分）右对齐 + 表格数字；
          //    文字型步骤（去极值 / 破同分）是句子，右对齐反而难读。
          const numeric = key === 'raw' || key === 'z' || key === 'weights' || key === 'total';
          return `
          <div class="kv__row">
            <dt class="kv__key">${label}</dt>
            <dd class="${numeric ? 'kv__val num' : 'kv__val'}"${numeric ? ' style="text-align:right"' : ''}>${escapeHtml(stepValue(t, tr, key, data))}</dd>
          </div>`;
        }).join('')}
      </dl>`;
    return item;
  }

  /** 复算并比对（body.children[2]）：结论用徽章，差异逐条列出。 */
  async function runDiff() {
    diffBox.innerHTML = loadingState({ rows: 1, label: '正在用同一输入复算…' });
    try {
      const d = await ctx.api.get(`/api/audit/computations/${encodeURIComponent(computationId)}/diff`);
      diffBox.innerHTML = renderDiff(d);
    } catch (e) {
      diffBox.innerHTML = errorState({
        message: e.message,
        hint: '复算没跑通：快照或规则版本可能已变动，可重试一次。',
      });
    }
  }

  btn.addEventListener('click', () => runDiff());

  void reload();
  return wrap;
}

/**
 * 复算 diff 的展示：结论（一致 / 不一致）+ 告警 + 逐条 path。
 * ⚠️ 文案里必须出现 `identical = false` 这样的原文字段（测试按它断言）。
 */
function renderDiff(d) {
  const diffs = d?.diff ?? [];
  const warnings = d?.warnings ?? [];
  const identical = d?.identical === true;
  const rows = diffs.map((x) => `
    <tr>
      <td><code>${escapeHtml(x.path)}</code></td>
      <td class="td-num num">${escapeHtml(String(x.before))}</td>
      <td class="td-num num">${escapeHtml(String(x.after))}</td>
    </tr>`).join('');
  return `
    <div class="row row--between">
      <h3>复算比对</h3>
      ${badge(identical ? '一致' : '不一致', identical ? 'success' : 'danger')}
    </div>
    <p class="muted small">identical = ${String(d?.identical)} · ${diffs.length} 处差异</p>
    ${warnings.length
      ? noticeState({
        tone: 'warn',
        title: '复算告警',
        items: warnings.map((w) => w?.message ?? w?.code ?? String(w)),
        list: true,
      })
      : ''}
    ${diffs.length
      ? `<div class="table-wrap">
          <table class="table table--compact">
            <thead><tr><th>path</th><th class="td-num">before</th><th class="td-num">after</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`
      : '<p class="muted">无差异：复算结果与快照逐字段一致。</p>'}`;
}

/** 六步各自的取值（服务端 trace 的真实形状见 src/domain/scoring.js）。 */
function stepValue(t, tr, key, data) {
  if (key === 'total') return String(t.total ?? '—');
  if (key === 'tiebreak') {
    return Array.isArray(t.tiedWith) && t.tiedWith.length ? t.tiedWith.join('、') : '未触发破同分';
  }
  if (key === 'raw' || key === 'z') return formatMap(tr?.[key]);
  if (key === 'trim') return formatTrim(t.teamId, data?.trace?.steps ?? []);
  if (key === 'weights') return formatMap(data?.trace?.weights ?? {});
  return '—';
}

/** 维度 → 数值（原始分 / z 分 / 权重表）。 */
function formatMap(obj) {
  const parts = Object.entries(obj ?? {}).map(
    ([k, v]) => `${k} ${typeof v === 'number' ? round2(v) : v}`,
  );
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * 去极值：只取**本队**的 trim 步骤。
 * ⚠️ 旧实现只按 step === 'trim' 过滤 ⇒ 把别的队伍的去极值也列进来了（每队都看到全赛段的记录）。
 */
function formatTrim(teamId, steps) {
  const mine = (steps ?? []).filter((s) => s?.step === 'trim' && s.teamId === teamId);
  if (!mine.length) return '未触发去极值';
  return mine.map((s) => {
    const dim = s.dimension ?? '—';
    if (!s.trimmed) return `${dim}：未触发去极值`;
    // ⚠️ removed 里存的是**被去掉的评委 id**（不是分值），文案别写成「去掉最高 95」。
    return `${dim}：去掉最高（评委 ${s.removed?.max ?? '—'}）／最低（评委 ${s.removed?.min ?? '—'}）`;
  }).join('；');
}

function round2(n) {
  return Number(n).toFixed(2);
}

// web/views/audit.js — 计算留痕 trace 抽屉
// 依据：设计文档 §9「发榜页：榜单 + trace 抽屉（点任一队伍 → 展开每一步：
//   原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分）；降级告警置顶」
//   + §12 三件套结构 + S-5「降级状态可见」。
// ⛔ 降级告警置顶且不可折叠：榜单页必须显式提示"本轮该维度未做评委宽严归一化（样本不足 5）"。
// ⛔ 复算 diff 必须**被看见**（不能只写一条日志）：抽屉里直接给出 identical + 逐条 path。
import { escapeHtml } from '../escape.js';

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
  wrap.className = 'card audit-trace';

  const head = document.createElement('div');
  head.innerHTML = '<h1>计算留痕</h1><p class="muted" id="au-msg">加载中…</p>';
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.id = 'au-body';
  wrap.appendChild(body);

  const computationId = ctx.params?.computationId || ctx.getState?.().computationId;
  const msg = wrap.querySelector('#au-msg');

  if (!computationId) {
    msg.textContent = '缺少 computationId：请从发榜页点任一队伍进入。';
    return wrap;
  }

  (async () => {
    let data;
    try {
      data = await ctx.api.get(`/api/audit/computations/${encodeURIComponent(computationId)}`);
    } catch (e) {
      msg.textContent = e.message;
      return;
    }
    msg.textContent = `规则版本 ${data.ruleVersion} ｜ revision ${data.revision} ｜ ${data.createdAt}`;

    // ── 降级告警置顶 ─────────────────────────────────────────
    const warnBox = document.createElement('div');
    warnBox.className = 'card warn-box';
    const norm = data.trace?.normalization ?? {};
    const normWarnings = Object.entries(norm)
      .filter(([, v]) => v && v.normalized === false)
      .map(([dim, v]) => `${dim}：未做评委宽严归一化（${v.fallbackReason ?? '未知原因'}）`);
    const engineWarnings = (data.trace?.warnings ?? []).map((w) => w.message ?? String(w));
    const allWarnings = [...normWarnings, ...engineWarnings];
    if (allWarnings.length) {
      warnBox.innerHTML = `<strong>降级告警（${allWarnings.length}）</strong><ul>${
        allWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')
      }</ul>`;
    } else {
      warnBox.innerHTML = '<strong>降级告警</strong><p class="muted">无</p>';
    }
    body.appendChild(warnBox);

    // ── 每队展开：原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分 ──
    const perTeam = data.trace?.perTeam ?? {};
    const teams = data.output?.teams ?? [];
    const list = document.createElement('div');
    for (const t of teams) {
      const teamId = t.teamId;
      const tr = perTeam[teamId] ?? {};
      const item = document.createElement('details');
      item.className = 'team-trace';
      const rank = t.rank !== undefined ? `第 ${t.rank} 名` : '未排名';
      const tied = Array.isArray(t.tiedWith) && t.tiedWith.length ? `（并列 ${t.tiedWith.join('、')}）` : '';
      item.innerHTML = `<summary>${escapeHtml(teamId)} ｜ ${rank}${tied} ｜ 总分 ${t.total ?? '—'}</summary>
        <ol>${STEPS.map(([key, label]) => {
    const value = key === 'total' ? (t.total ?? '—')
      : key === 'tiebreak' ? (t.tiedWith ? t.tiedWith.join('、') || '未触发破同分' : '未触发破同分')
        : formatStep(tr, key);
    return `<li><strong>${label}</strong>：${escapeHtml(String(value))}</li>`;
  }).join('')}</ol>`;
      list.appendChild(item);
    }
    body.appendChild(list);

    // ── 复算并比对（diff 必须被看见，不能只写一条日志）──────────
    const actions = document.createElement('div');
    actions.className = 'trace-actions';
    const btn = document.createElement('button');
    btn.textContent = '用同一输入复算并比对';
    const diffBox = document.createElement('div');
    diffBox.id = 'au-diff';
    btn.addEventListener('click', async () => {
      diffBox.textContent = '复算中…';
      try {
        const d = await ctx.api.get(`/api/audit/computations/${encodeURIComponent(computationId)}/diff`);
        const warnLines = (d.warnings ?? []).map((w) => `<li>${escapeHtml(w.message ?? w.code)}</li>`).join('');
        const diffLines = (d.diff ?? []).map((x) => `<li><code>${escapeHtml(x.path)}</code>：${escapeHtml(String(x.before))} → ${escapeHtml(String(x.after))}</li>`).join('');
        diffBox.innerHTML = `
          <p><strong>identical = ${String(d.identical)}</strong>（${(d.diff ?? []).length} 处差异）</p>
          ${warnLines ? `<ul>${warnLines}</ul>` : ''}
          ${diffLines ? `<ul>${diffLines}</ul>` : '<p class="muted">无差异</p>'}
        `;
      } catch (e) {
        diffBox.textContent = e.message;
      }
    });
    actions.appendChild(btn);
    actions.appendChild(diffBox);
    body.appendChild(actions);
  })();

  return wrap;
}

function formatStep(tr, key) {
  if (key === 'raw' || key === 'z') {
    const v = tr[key] ?? {};
    const parts = Object.entries(v).map(([k, val]) => `${k}:${typeof val === 'number' ? round2(val) : val}`);
    return parts.length ? parts.join('  ') : '—';
  }
  if (key === 'trim') {
    const steps = (tr.steps ?? []).filter((s) => s.step === 'trim');
    if (!steps.length) return '未触发去极值';
    return steps.map((s) => `${s.dimension ?? ''} 去掉最高 ${s.removed?.max ?? '—'}／最低 ${s.removed?.min ?? '—'}`).join('；');
  }
  if (key === 'weights') {
    const w = tr.weights ?? {};
    const parts = Object.entries(w).map(([k, val]) => `${k}:${val}`);
    return parts.length ? parts.join('  ') : '—';
  }
  return '—';
}

function round2(n) {
  return Number(n).toFixed(2);
}

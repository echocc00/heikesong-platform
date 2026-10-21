// web/views/flags.js — 复核队列
// 依据：设计文档 §9「组委会视角 → 复核/申诉/改级」、§11.1（检测 → 进人工复核队列）
// ⛔ 检测 ≠ 处罚：队列里只做"确认 / 驳回"的人工判断，系统不改分、不封号。
// ⛔ 裁决必须写理由与证据（证据三列：URL / 发行方 / 独立性，按发行方去重）。
import { escapeHtml } from '../escape.js';

export function renderFlags(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card flags-queue';

  const head = document.createElement('div');
  head.innerHTML = '<h1>复核队列</h1><p class="muted" id="fl-msg">加载中…</p>';
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.id = 'fl-list';
  wrap.appendChild(list);

  const msg = wrap.querySelector('#fl-msg');

  (async () => {
    let data;
    try {
      data = await ctx.api.get('/api/audit/flags');
    } catch (e) {
      msg.textContent = e.message;
      return;
    }
    const rows = data.rows ?? [];
    msg.textContent = `共 ${data.total ?? rows.length} 项待处理（只告警不处罚，改分与封禁由组委会线下决定）`;
    if (!rows.length) {
      list.innerHTML = '<p class="muted">队列为空</p>';
      return;
    }
    for (const flag of rows) {
      list.appendChild(renderFlagRow(ctx, flag));
    }
  })();

  return wrap;
}

function renderFlagRow(ctx, flag) {
  const box = document.createElement('div');
  box.className = 'flag-row card';
  const detail = flag.detail ?? {};
  box.innerHTML = `
    <p><strong>${escapeHtml(flag.kind)}</strong> ｜ 状态 ${escapeHtml(flag.status)} ｜ 赛段 ${escapeHtml(flag.stageId ?? '—')} ｜ 队伍 ${escapeHtml(flag.teamId ?? '—')} ｜ 评委 ${escapeHtml(flag.judgeId ?? '—')}</p>
    <pre class="muted">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
  `;

  if (flag.status === 'open') {
    const form = document.createElement('div');
    form.className = 'flag-form';
    form.innerHTML = `
      <label>裁决<select id="fl-status"><option value="confirmed">确认（确有异常）</option><option value="rejected">驳回（误报）</option></select></label>
      <label>理由<input id="fl-reason" placeholder="写明判断依据（必填）" /></label>
      <fieldset><legend>证据（三列必填：URL / 发行方 / 独立性）</legend>
        <input id="fl-url" placeholder="https://…" />
        <input id="fl-publisher" placeholder="发行方" />
        <label class="inline"><input type="checkbox" id="fl-independent" /> 独立信源</label>
      </fieldset>
      <button id="fl-submit">提交裁决</button>
      <p id="fl-note" class="err"></p>
    `;
    const note = form.querySelector('#fl-note');
    form.querySelector('#fl-submit').addEventListener('click', async () => {
      note.textContent = '';
      const reason = form.querySelector('#fl-reason').value.trim();
      if (!reason) {
        note.textContent = '必须写理由';
        return;
      }
      const evidence = [];
      const url = form.querySelector('#fl-url').value.trim();
      const publisher = form.querySelector('#fl-publisher').value.trim();
      if (url || publisher) {
        evidence.push({
          url,
          publisher,
          independent: form.querySelector('#fl-independent').checked,
        });
      }
      try {
        const out = await ctx.api.post(`/api/audit/flags/${encodeURIComponent(flag.id)}/resolve`, {
          status: form.querySelector('#fl-status').value,
          reason,
          evidence,
        });
        note.className = 'muted';
        note.textContent = `已裁决；独立发行方 ${out.detail?.evidence?.uniquePublishers ?? 0} 个（按发行方去重）`;
      } catch (e) {
        note.textContent = e.message;
      }
    });
    box.appendChild(form);
  }
  return box;
}

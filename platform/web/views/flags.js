// web/views/flags.js — 复核队列
// 依据：设计文档 §9「组委会视角 → 复核/申诉/改级」、§11.1（检测 → 进人工复核队列）
//   + R-AUD-04（证据三列：URL / 发行方 / 独立性，按发行方去重）
//   + R-AUD-05（空结果必须显式报错）
// ⛔ 检测 ≠ 处罚：队列里只做"确认 / 驳回"的人工判断，系统不改分、不封号。
// ⛔ 裁决必须写理由与证据（证据三列：URL / 发行方 / 独立性，按发行方去重）。
//
// ⚠️ **DOM 顺序是测试契约**（platform/test/audit-api.test.js）：
//    wrap.children = [页头, 队列容器]；队列容器的**第一个子元素必须是第一条复核项卡片**
//    ⇒ 指标条、筛选条都只能放在页头里，插进队列容器会把卡片的索引顶掉。
// ⚠️ 卡片的**正文写在 innerHTML 里**，裁决表单作为卡片第一个 appendChild 的子元素
//    （测试用 row.children[0] 取表单）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, statRow,
} from '../ui.js';

/** 状态 → 中文标签 / 徽章色调。 */
function statusLabel(status) {
  if (status === 'open') return '待处理';
  if (status === 'confirmed') return '已确认';
  if (status === 'rejected') return '已驳回';
  return String(status ?? '未知');
}

function statusTone(status) {
  if (status === 'open') return 'warn';
  if (status === 'confirmed') return 'success';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

/** 卡片正文（重建时复用，保证「裁决前 / 裁决后」是同一套结构）。 */
function cardHtml(flag, status, extra = '') {
  const detail = flag.detail ?? {};
  return `
    <div class="row row--between">
      <div class="row">
        <strong>${escapeHtml(flag.kind)}</strong>
        ${badge(statusLabel(status), statusTone(status))}
      </div>
      <span class="muted small">${escapeHtml(flag.id ?? '')}</span>
    </div>
    <p class="muted small">
      赛段 ${escapeHtml(flag.stageId ?? '—')} ｜ 队伍 ${escapeHtml(flag.teamId ?? '—')} ｜ 评委 ${escapeHtml(flag.judgeId ?? '—')} ｜ 状态 ${escapeHtml(status)}
    </p>
    <details>
      <summary class="muted small">原始检测详情</summary>
      <pre class="muted">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
    </details>
    ${extra}`;
}

export function renderFlags(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'flags-queue';

  const head = document.createElement('div');
  head.innerHTML = `
    ${pageHead({
      title: '复核队列',
      sub: '检测 ≠ 处罚：这里只做人工「确认 / 驳回」，不改分、不封号。',
    })}
    <div id="fl-stats">${loadingState({ rows: 1, label: '正在统计队列…' })}</div>
    <div class="row" id="fl-filters">
      <button type="button" class="btn btn--primary btn--sm" id="fl-filter-all">全部</button>
      <button type="button" class="btn btn--ghost btn--sm" id="fl-filter-open">待处理</button>
      <button type="button" class="btn btn--ghost btn--sm" id="fl-filter-done">已裁决</button>
    </div>
    <p class="muted small" id="fl-msg">正在加载复核队列…</p>
    <div id="fl-state"></div>`;
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.id = 'fl-list';
  wrap.appendChild(list);

  const msg = wrap.querySelector('#fl-msg');
  const statsBox = wrap.querySelector('#fl-stats');
  const stateBox = wrap.querySelector('#fl-state');

  /** 队列条目（含裁决后的状态），筛选与计数都从这里算。 */
  const items = [];
  let filter = 'all';

  // ⚠️ 重试用事件委托：errorState() 的重试按钮没有固定 id，委托到容器更稳。
  stateBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void load();
  });

  for (const [sel, value] of [['#fl-filter-all', 'all'], ['#fl-filter-open', 'open'], ['#fl-filter-done', 'done']]) {
    head.querySelector(sel)?.addEventListener('click', () => {
      filter = value;
      applyFilter();
      paintFilterButtons();
    });
  }

  async function load() {
    msg.textContent = '正在加载复核队列…';
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载复核队列…' });
    let data;
    try {
      data = await ctx.api.get('/api/audit/flags');
    } catch (e) {
      msg.textContent = '复核队列加载失败';
      statsBox.innerHTML = '';
      stateBox.innerHTML = errorState({
        message: e.message,
        hint: '队列没拉到。可以重试；若持续失败，检查账号是否还有 audit:read 权限。',
      });
      return;
    }
    stateBox.innerHTML = '';
    const rows = data?.rows ?? [];
    renderRows(rows);
    updateStats();
    msg.textContent = `共 ${data?.total ?? rows.length} 项（只告警不处罚，改分与封禁由组委会线下决定）`;
  }

  function renderRows(rows) {
    list.replaceChildren();
    items.length = 0;
    if (!rows.length) {
      list.innerHTML = emptyState({
        title: '复核队列是空的',
        hint: '没有待判定的检测项：要么这一轮还没跑反作弊扫描，要么上一轮的告警都已裁决。等赛段发榜后系统会自动再扫一轮。',
      });
      return;
    }
    for (const flag of rows) {
      const card = document.createElement('div');
      card.className = 'card flag-row';
      card.innerHTML = cardHtml(flag, flag.status);
      if (flag.status === 'open') card.appendChild(buildForm(ctx, flag, onResolved));
      items.push({ flag, card, status: flag.status });
      list.appendChild(card);
    }
    applyFilter();
  }

  /**
   * 裁决表单。
   * ⚠️ 表单里的 id 是测试契约（#fl-status / #fl-reason / #fl-url / #fl-publisher /
   *    #fl-independent / #fl-submit / #fl-note），一个都不能少、不能改名。
   */
  function buildForm(ctx, flag, onResolved) {
    const form = document.createElement('div');
    form.innerHTML = `
      <div class="panel">
        <div class="panel__head">
          <h3 class="panel__title">人工裁决</h3>
          <p class="panel__desc">裁决只留痕、不改分：确认 = 确有异常（记入观察），驳回 = 误报（不改结果）</p>
        </div>
        <div class="panel__body">
          <div class="field">
            <label class="field__label" for="fl-status">裁决结论</label>
            <select class="select" id="fl-status">
              <option value="confirmed">确认（确有异常）</option>
              <option value="rejected">驳回（误报）</option>
            </select>
          </div>
          <div class="field field--required">
            <label class="field__label" for="fl-reason">裁决理由</label>
            <input class="input" id="fl-reason" placeholder="写明判断依据（必填）" />
            <p class="field__hint">无理由的裁决无法复盘 —— 必填。</p>
          </div>
          <div class="panel">
            <div class="panel__head">
              <h3 class="panel__title">证据三列</h3>
              <p class="panel__desc">URL / 发行方 / 独立性 —— 要么三列都填，要么都不填（缺列的证据服务端会拒收）</p>
            </div>
            <div class="panel__body">
              <div class="field">
                <label class="field__label" for="fl-url">证据 URL</label>
                <input class="input" id="fl-url" placeholder="https://…" />
              </div>
              <div class="field">
                <label class="field__label" for="fl-publisher">发行方</label>
                <input class="input" id="fl-publisher" placeholder="如：某媒体" />
              </div>
              <div class="field">
                <label class="checkbox" for="fl-independent">
                  <input type="checkbox" id="fl-independent" /> 独立信源
                </label>
                <p class="field__hint">同一发行方的多条报道只算 1 个独立信源。</p>
              </div>
            </div>
          </div>
          <div class="row">
            <button type="button" class="btn btn--primary" id="fl-submit">提交裁决</button>
          </div>
          <p class="field__error" id="fl-note"></p>
        </div>
      </div>`;

    const note = form.querySelector('#fl-note');
    form.querySelector('#fl-submit').addEventListener('click', async () => {
      note.className = 'field__error';
      note.textContent = '';
      const reason = form.querySelector('#fl-reason').value.trim();
      if (!reason) {
        // ⚠️ 文案必须**恰好**是这六个字（测试断言 === '必须写理由'）
        note.textContent = '必须写理由';
        return;
      }
      const url = form.querySelector('#fl-url').value.trim();
      const publisher = form.querySelector('#fl-publisher').value.trim();
      if ((url || publisher) && !(url && publisher)) {
        note.textContent = '证据三列要么都填，要么都不填（还缺 URL 或发行方）';
        return;
      }
      const evidence = (url || publisher)
        ? [{ url, publisher, independent: form.querySelector('#fl-independent').checked }]
        : [];
      const status = form.querySelector('#fl-status').value;
      try {
        const out = await ctx.api.post(
          `/api/audit/flags/${encodeURIComponent(flag.id)}/resolve`,
          { status, reason, evidence },
        );
        const publishers = out?.detail?.evidence?.uniquePublishers ?? 0;
        note.className = 'field__hint';
        note.textContent = `已裁决；独立发行方 ${publishers} 个（按发行方去重）`;
        onResolved(flag, { status: out?.status ?? status, publishers, reason });
      } catch (e) {
        note.textContent = `裁决失败：${e.message}`;
      }
    });
    return form;
  }

  /**
   * 裁决成功：这一条**就地变成已裁决**（徽章换色 + 表单换成结果面板 + 计数与筛选同步），
   * 不是只改一行提示 —— 用户必须看得见「这条已经处理掉了」。
   */
  function onResolved(flag, result) {
    const rec = items.find((it) => it.flag.id === flag.id);
    if (!rec) return;
    rec.status = result.status;
    rec.card.innerHTML = cardHtml(rec.flag, result.status, noticeState({
      tone: 'success',
      title: '裁决已记录',
      items: [
        `裁决结论：${statusLabel(result.status)}`,
        `独立发行方 ${result.publishers} 个（按发行方去重）`,
        '裁决理由与证据已写入审计日志（不改分、不封号）。',
      ],
      list: true,
    }));
    updateStats();
    applyFilter();
  }

  function updateStats() {
    const open = items.filter((it) => it.status === 'open').length;
    const done = items.filter((it) => it.status !== 'open').length;
    statsBox.innerHTML = statRow([
      { label: '待处理', value: open, tone: 'warn' },
      { label: '已裁决', value: done, tone: 'success' },
      // ⚠️ 总数取**本页已加载的条数**：这样「待处理 + 已裁决 = 总数」自洽；
      //    接口返回的 total（含分页）在页头 #fl-msg 里单独说明。
      { label: '总数', value: items.length, tone: 'neutral' },
    ]);
  }

  function applyFilter() {
    for (const it of items) {
      const show = filter === 'all'
        || (filter === 'open' && it.status === 'open')
        || (filter === 'done' && it.status !== 'open');
      it.card.hidden = !show;
    }
  }

  /** 当前筛选用主色按钮，其余用幽灵按钮（用户一眼知道在看哪一段）。 */
  function paintFilterButtons() {
    for (const [sel, value] of [['#fl-filter-all', 'all'], ['#fl-filter-open', 'open'], ['#fl-filter-done', 'done']]) {
      const btn = head.querySelector(sel);
      if (btn) btn.className = `btn btn--sm ${value === filter ? 'btn--primary' : 'btn--ghost'}`;
    }
  }

  void load();
  return wrap;
}

// web/views/admin-appeals.js — 组委会：申诉裁决队列
// 依据：设计文档 §9「组委会视角 → 复核/申诉/改级」、§11.2（人工复核与申诉状态机）
//   + R-REG-08（C 级不接收 ⇒ 选手可向组委会提交申诉）
//
// ⚠️ **端点契约一律以源码为准**（src/http/routes/audit.js + src/services/review-state.js）：
//   GET  /api/appeals              → { rows: [{ id, subjectType, subjectId, filedBy, reason,
//                                              status, decidedBy, decidedAt, decisionNote, createdAt }],
//                                      total }
//   POST /api/appeals/:id/decide    body = { decision: 'accepted' | 'rejected', note }
//     · note **必填**：decideAppeal 对空说明抛 400「裁决必须写说明（无说明的裁决无法复盘）」；
//     · 状态机：只有 status ∈ { submitted, reviewing } 的申诉可裁决；
//       裁决后 status 落到 accepted / rejected（终态，再裁决会 409）；
//     · accepted = 申诉成立 ⇒ 撤销终稿（FINALIZED → REJECTED → PENDING_REVIEW）并要求重算。
//   列表需要 audit:read、裁决需要 audit:write（前端只按能力点拦**分区级页面**，API 才是最终裁决者）。
//
// ⛔ **视觉参考 web/views/flags.js（复核队列）**：同样的「列表 + 就地裁决」模式 ——
//    裁决成功后这一条**就地变成已裁决**（徽章换色 + 表单换成结果面板 + 计数与筛选同步），
//    不是只改一行提示（用户必须看得见「这条已经处理掉了」）。
//
// ⛔ 前端**不做可见性过滤**（全局约束）：API 返回什么就渲染什么，一个都不许丢。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, statRow,
} from '../ui.js';

/** 申诉状态 → 中文标签。 */
const STATUS_LABELS = {
  submitted: '待裁决',
  reviewing: '复核中',
  accepted: '申诉成立',
  rejected: '申诉驳回',
};

/** 申诉状态 → 徽章色调。 */
const STATUS_TONES = {
  submitted: 'warn',
  reviewing: 'info',
  accepted: 'success',
  rejected: 'danger',
};

/** 状态 → 中文标签（未知状态原样透出，不猜）。 */
export function appealStatusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? '未知');
}

/** 状态 → 徽章色调（未知状态走中性）。 */
export function appealStatusTone(status) {
  return STATUS_TONES[status] ?? 'neutral';
}

/**
 * 这条申诉现在能不能裁决。
 * ⚠️ 口径以服务端状态机为准（decideAppeal）：只有 submitted / reviewing 可裁决，
 *    已裁决的（accepted / rejected）再裁决会 409。
 */
export function canDecide(status) {
  return status === 'submitted' || status === 'reviewing';
}

/**
 * 裁决校验（纯函数）：结论只能是 accepted / rejected，说明**必填**。
 * @returns {{ok: boolean, decision?: string, note?: string, message?: string}}
 */
export function validateDecision({ decision, note } = {}) {
  if (!['accepted', 'rejected'].includes(decision)) {
    return { ok: false, message: '裁决结论只能是「申诉成立」或「申诉驳回」。' };
  }
  const text = String(note ?? '').trim();
  if (!text) return { ok: false, message: '裁决说明必填：无说明的裁决无法复盘。' };
  return { ok: true, decision, note: text };
}

/**
 * 申诉卡片正文（纯函数）：徽章 + 申诉对象 + 理由。
 * ⚠️ 裁决前后用**同一套结构**重建（重建时卡片不会跳版）。
 */
export function buildAppealCard(appeal, extra = '') {
  const status = appeal?.status ?? 'submitted';
  const decided = !canDecide(status);
  const meta = [
    `对象 ${appeal?.subjectId ?? '—'}`,
    `提交人 ${appeal?.filedBy ?? '—'}`,
    `提交于 ${appeal?.createdAt ?? '—'}`,
  ];
  // ⚠️ 已裁决的条目要把「谁裁的、什么时候裁的、说明是什么」留在卡片上 ——
  //    申诉是留痕件，复盘时只看得到「已裁决」三个字是不够的。
  if (decided) {
    meta.push(`裁决人 ${appeal?.decidedBy ?? '—'}`);
    meta.push(`裁决于 ${appeal?.decidedAt ?? '—'}`);
  }
  return `
    <div class="row row--between">
      <div class="row">
        <strong>${escapeHtml(appeal?.subjectType ?? '申诉')}</strong>
        ${badge(appealStatusLabel(status), appealStatusTone(status))}
      </div>
      <span class="muted small">${escapeHtml(appeal?.id ?? '')}</span>
    </div>
    <p class="muted small">${meta.map((m) => escapeHtml(m)).join(' ｜ ')}</p>
    <p>${escapeHtml(appeal?.reason ?? '')}</p>
    ${decided && appeal?.decisionNote ? `<p class="muted small">裁决说明：${escapeHtml(appeal.decisionNote)}</p>` : ''}
    ${extra}`;
}

/**
 * 裁决表单（纯函数）：结论 + 说明 + 提交按钮。
 * ⚠️ 表单里的 id 是**契约**（#ap-decision / #ap-note / #ap-submit / #ap-error）。
 */
export function buildDecisionForm() {
  return `
      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">人工裁决</h2>
          <p class="panel__desc">裁决只留痕：成立 = 撤销终稿并转入重新复核（需重算），驳回 = 维持原判</p>
        </div>
        <div class="panel__body">
          <div class="field">
            <label class="field__label" for="ap-decision">裁决结论</label>
            <select class="select" id="ap-decision">
              <option value="accepted">申诉成立（撤销终稿，重新复核）</option>
              <option value="rejected">申诉驳回（维持原判）</option>
            </select>
          </div>
          <div class="field field--required">
            <label class="field__label" for="ap-note">裁决说明</label>
            <textarea class="textarea" id="ap-note" placeholder="写明裁决依据（必填）"></textarea>
            <p class="field__hint">无说明的裁决无法复盘 —— 必填。</p>
          </div>
          <div class="row">
            <button type="button" class="btn btn--primary" id="ap-submit">提交裁决</button>
          </div>
          <p class="field__error" id="ap-error"></p>
        </div>
      </div>`;
}

/** 裁决完成后的结果面板（纯函数）：徽章之外再把结论与「是否需要重算」讲清。 */
export function buildDecisionResult(decision, note, recomputeRequired) {
  return noticeState({
    tone: decision === 'accepted' ? 'success' : 'info',
    title: decision === 'accepted' ? '申诉成立' : '申诉驳回',
    items: [
      `裁决说明：${note}`,
      recomputeRequired
        ? '终稿已撤销、条目转入重新复核 —— 需要按 revision + 1 重算（旧记录保留，不覆盖历史）。'
        : '维持原判；裁决说明与结论已写入审计日志。',
    ],
    list: true,
  });
}

export function renderAdminAppeals(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-appeals';

  const head = document.createElement('div');
  head.innerHTML = `
    ${pageHead({
      title: '申诉裁决',
      sub: '组委会工作台：逐条看选手的申诉理由，给结论并留下说明。成立 = 撤销终稿、转入重新复核。',
    })}
    <div id="ap-stats">${loadingState({ rows: 1, label: '正在统计申诉队列…' })}</div>
    <div class="row" id="ap-filters">
      <button type="button" class="btn btn--primary btn--sm" id="ap-filter-all">全部</button>
      <button type="button" class="btn btn--ghost btn--sm" id="ap-filter-pending">待裁决</button>
      <button type="button" class="btn btn--ghost btn--sm" id="ap-filter-done">已裁决</button>
    </div>
    <p class="muted small" id="ap-msg">正在加载申诉队列…</p>
    <div id="ap-state"></div>`;
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.id = 'ap-list';
  wrap.appendChild(list);

  const msg = wrap.querySelector('#ap-msg');
  const statsBox = head.querySelector('#ap-stats');
  const stateBox = head.querySelector('#ap-state');

  /** 队列条目（含裁决后的状态），筛选与计数都从这里算。 */
  const items = [];
  let filter = 'all';

  // ⚠️ 重试用事件委托：errorState() 的重试按钮没有固定 id，委托到容器更稳。
  stateBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void load();
  });

  for (const [sel, value] of [['#ap-filter-all', 'all'], ['#ap-filter-pending', 'pending'], ['#ap-filter-done', 'done']]) {
    head.querySelector(sel)?.addEventListener('click', () => {
      filter = value;
      applyFilter();
      paintFilterButtons();
    });
  }

  async function load() {
    msg.textContent = '正在加载申诉队列…';
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载申诉队列…' });
    let data;
    try {
      data = await ctx.api.get('/api/appeals');
    } catch (e) {
      msg.textContent = '申诉队列加载失败';
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
    msg.textContent = `共 ${data?.total ?? rows.length} 条申诉（裁决只留痕，不直接改分）`;
  }

  function renderRows(rows) {
    list.replaceChildren();
    items.length = 0;
    if (!rows.length) {
      // ⚠️ 空态必须给**下一步**（不能是白屏）：告诉组委会队列为什么空、什么时候会有内容。
      list.innerHTML = emptyState({
        title: '申诉队列是空的',
        hint: '目前没有选手提交申诉。选手在报名被拒（C 级不接收）后可以在报名页提交申诉，'
          + '理由一到，这里就会出现待裁决的条目。',
      });
      return;
    }
    for (const appeal of rows) {
      const card = document.createElement('div');
      card.className = 'card appeal-row';
      card.innerHTML = buildAppealCard(appeal);
      if (canDecide(appeal.status)) card.appendChild(buildForm(appeal, onDecided));
      items.push({ appeal, card, status: appeal.status });
      list.appendChild(card);
    }
    applyFilter();
  }

  /**
   * 裁决表单。
   * ⚠️ 说明为空**就地拒绝**（不发请求）：服务端也会拒收空说明，
   *    前端先拦一道，用户少一次往返。
   */
  function buildForm(appeal, onResolved) {
    const form = document.createElement('div');
    form.innerHTML = buildDecisionForm();

    const err = form.querySelector('#ap-error');
    form.querySelector('#ap-submit').addEventListener('click', async () => {
      const decision = form.querySelector('#ap-decision').value;
      const note = form.querySelector('#ap-note').value.trim();
      const check = validateDecision({ decision, note });
      if (!check.ok) {
        err.textContent = check.message;
        return;
      }
      err.textContent = '';
      try {
        const out = await ctx.api.post(
          `/api/appeals/${encodeURIComponent(appeal.id)}/decide`,
          { decision: check.decision, note: check.note },
        );
        onResolved(appeal, {
          status: out?.appeal?.status ?? out?.status ?? check.decision,
          note: out?.appeal?.decision_note ?? out?.appeal?.decisionNote ?? check.note,
          recomputeRequired: out?.recomputeRequired === true,
        });
      } catch (e) {
        err.textContent = `裁决失败：${e.message}`;
      }
    });
    return form;
  }

  /**
   * 裁决成功：这一条**就地变成已裁决**（徽章换色 + 表单换成结果面板 + 计数与筛选同步）。
   */
  function onDecided(appeal, result) {
    const rec = items.find((it) => it.appeal.id === appeal.id);
    if (!rec) return;
    rec.status = result.status;
    rec.appeal = { ...rec.appeal, status: result.status };
    rec.card.innerHTML = buildAppealCard(
      rec.appeal,
      buildDecisionResult(result.status, result.note, result.recomputeRequired),
    );
    updateStats();
    applyFilter();
  }

  function updateStats() {
    const pending = items.filter((it) => canDecide(it.status)).length;
    const done = items.filter((it) => !canDecide(it.status)).length;
    statsBox.innerHTML = statRow([
      { label: '待裁决', value: pending, tone: 'warn' },
      { label: '已裁决', value: done, tone: 'success' },
      // ⚠️ 总数取**本页已加载的条数**：这样「待裁决 + 已裁决 = 总数」自洽；
      //    接口返回的 total（含分页）在页头 #ap-msg 里单独说明。
      { label: '总数', value: items.length, tone: 'neutral' },
    ]);
  }

  function applyFilter() {
    for (const it of items) {
      const show = filter === 'all'
        || (filter === 'pending' && canDecide(it.status))
        || (filter === 'done' && !canDecide(it.status));
      it.card.hidden = !show;
    }
  }

  /** 当前筛选用主色按钮，其余用幽灵按钮（用户一眼知道在看哪一段）。 */
  function paintFilterButtons() {
    for (const [sel, value] of [['#ap-filter-all', 'all'], ['#ap-filter-pending', 'pending'], ['#ap-filter-done', 'done']]) {
      const btn = head.querySelector(sel);
      if (btn) btn.className = `btn btn--sm ${value === filter ? 'btn--primary' : 'btn--ghost'}`;
    }
  }

  void load();
  return wrap;
}

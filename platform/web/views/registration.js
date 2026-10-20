// web/views/registration.js — 报名问卷（选手视角）
// 依据：设计文档 §9「报名问卷：每题显示该题所属维度与分值；明示筛选标准（R-REG-09）；
//       提交后展示『你被判为 X 级』及可解释明细」
// ⛔ buildQuestionnaire / formatExplain 是纯函数，不得触碰 document（便于 node:test 直接测）
import { escapeHtml } from '../escape.js';
export function buildQuestionnaire(criteria) {
  const dims = (criteria?.dimensions ?? []).map((d) => ({
    key: d.key,
    label: d.label,
    weight: d.weight,
    weightLabel: `${Math.round(d.weight * 100)}%`,
    min: d.min,
    max: d.max,
    items: (d.items ?? []).map((it) => ({ id: it.id, text: it.text })),
  }));
  const levels = criteria?.levels ?? [];
  const scale = criteria?.scale ?? { min: 1, max: 5, scoreMax: 100 };
  const rejected = levels.find((l) => l.accept === false);
  const criteriaLines = [
    `三维权重：${dims.map((d) => `${d.label} ${d.weightLabel}`).join('｜')}`,
    `每题 ${scale.min}–${scale.max} 分，每维 ${dims[0]?.items.length ?? 5} 题取均值后加权，满分 ${scale.scoreMax} 分`,
    `等级阈值：${levels.map((l) => `${l.label} ≥${l.minScore}`).join('｜')}${rejected ? `（${rejected.label} 不接收）` : ''}`,
  ];
  return {
    scale,
    dims,
    levels,
    open: {
      text: criteria?.openQuestion?.prompt ?? '',
      required: criteria?.openQuestion?.required === true,
      maxLength: criteria?.openQuestion?.maxLength ?? 500,
    },
    criteriaLines,
    funnel: criteria?.funnel ?? [],
    ipOwnership: criteria?.ipOwnership ?? {},
    redLines: criteria?.redLines ?? [],
    consentPrompt: criteria?.consent?.prompt ?? '',
  };
}

// 可解释明细：每维「均值 / 权重 / 加权」一行
export function formatExplain(explain, scale = { max: 5 }) {
  return (explain ?? []).map((e) => ({
    dimension: e.dimension,
    label: e.label,
    text: `${e.label}：均值 ${e.raw}/${scale.max}，权重 ${Math.round(e.weight * 100)}%，加权 ${e.weighted}`,
  }));
}

export function renderRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card apply';
  wrap.innerHTML = '<p class="muted">正在加载报名问卷…</p>';
  const { api, navigate } = ctx;

  (async () => {
    const criteria = await api.get('/api/registration-criteria');
    const q = buildQuestionnaire(criteria);
    const form = document.createElement('form');
    form.innerHTML = `
      <h1>报名</h1>
      <section class="criteria">
        <h2>筛选标准（公开透明，报名之前就告诉你）</h2>
        <ul>${q.criteriaLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
        <p class="muted">${escapeHtml(q.open.text)}</p>
        <p class="muted">${escapeHtml(q.ipOwnership.team ?? '')} ${escapeHtml(q.ipOwnership.committee ?? '')} ${escapeHtml(q.ipOwnership.enterprise ?? '')}</p>
      </section>
      ${q.dims.map((d) => `
        <section class="dim" data-dim="${d.key}">
          <h2>${escapeHtml(d.label)}（权重 ${escapeHtml(d.weightLabel)}，每题 ${d.min}–${d.max} 分）</h2>
          ${d.items.map((it, i) => `
            <label>${escapeHtml(it.text)}
              <select name="${d.key}-${i}">
                ${Array.from({ length: d.max - d.min + 1 }, (_, k) => d.min + k)
                  .map((v) => `<option value="${v}">${v}</option>`).join('')}
              </select>
            </label>`).join('')}
        </section>`).join('')}
      <label>${escapeHtml(q.open.text)}<textarea name="open" maxlength="${q.maxLength}"></textarea></label>
      <label><input type="checkbox" name="consent" /> ${escapeHtml(q.consentPrompt)}</label>
      <button type="submit">提交报名</button>
      <p id="reg-err" class="err"></p>
      <div id="reg-result"></div>
    `;

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = form.querySelector('#reg-err');
      const result = form.querySelector('#reg-result');
      err.textContent = '';
      result.innerHTML = '';
      const answers = { open: form.querySelector('[name=open]').value.trim() };
      for (const d of q.dims) {
        answers[d.key] = d.items.map((_, i) => Number(form.querySelector(`[name="${d.key}-${i}"]`).value));
      }
      answers.consent = { accepted: form.querySelector('[name=consent]').checked };
      try {
        const reg = await api.post('/api/registrations', {
          editionId: criteria.editionId,
          answers,
        });
        const levelLabel = q.levels.find((l) => l.key === reg.level)?.label ?? reg.level;
        result.innerHTML = `
          <h2>你被判为 ${escapeHtml(reg.level)} 级（${escapeHtml(levelLabel)}）</h2>
          <p>总分 ${reg.grading.score} 分</p>
          <ul>${formatExplain(reg.grading.explain, criteria.scale).map((e) => `<li>${escapeHtml(e.text)}</li>`).join('')}</ul>
          <p>${reg.grading.accepted ? '你已被接收，可以去组队。' : '本级不接收，可向组委会提交申诉。'}</p>
          <button id="go-team" type="button">去组队</button>`;
        result.querySelector('#go-team').addEventListener('click', () => navigate('/team'));
      } catch (e) {
        err.textContent = e.message;
      }
    });

    wrap.replaceChildren(form);
  })().catch((e) => {
    wrap.innerHTML = `<div class="card err">${escapeHtml(e.message)}</div>`;
  });

  return wrap;
}

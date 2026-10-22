// web/views/registration.js — 报名问卷（选手视角）
// 依据：设计文档 §9「报名问卷：每题显示该题所属维度与分值；明示筛选标准（R-REG-09）；
//       提交后展示『你被判为 X 级』及可解释明细」
// 溯源需求：R-REG-06（3 维 100 分）/ R-REG-07（阈值）/ R-REG-08（C 级不接收）
//            R-REG-09（筛选标准对外透明）/ R-REG-11（3 维各 5 题 + 1 道开放题）
//
// 本轮（P7）「现有页面打磨到生产级」的改动要点：
//   ① 评分控件从 <select> 下拉换成**横排按钮组**（.radio-group / .radio）——
//      1–5 分用下拉框要展开才看得见量表，15 题就是 15 次展开；
//   ② 加载 / 空 / 错三件套统一走 ui.js 的 loadingState / emptyState / errorState，
//      错误态带**真的会重跑**的「重试」按钮；
//   ③ 表单走 .field / .field__label / .input / .textarea 体系，必填项标 .field--required；
//   ④ 顶部加「答题进度」指标卡，提交前就知道还差几题；
//   ⑤ 提交成功展示分级结果（等级 + 总分 + 逐维可解释明细），失败给**说清楚原因**的错误提示。
//
// 本轮（P10 · W4-c）「申诉提交（选手侧）」的改动要点：
//   ⑥ 报名**不接收**时，结果区多一个「提交申诉」入口（R-REG-08）——
//      此前这句话只写在提示条里，**全站没有任何可点的申诉按钮**，
//      选手被告知可以做一件做不到的事；
//   ⑦ 申诉理由**必填**（服务端 fileAppeal 会拒收空理由），提交后就地反馈（成功 / 失败 + 重试）；
//   ⑧ 已接收的选手**看不到**这个入口（没有可申诉的东西，给了就是死路）。
//
// ⛔ buildQuestionnaire / formatExplain / buildResultHtml 是纯函数，不得触碰 document（便于 node:test 直接测）
import { escapeHtml } from '../escape.js';
import {
  emptyState, errorState, kvList, loadingState, noticeState, pageHead, panel,
  statCard, statRow,
} from '../ui.js';

/**
 * 问卷模型（纯函数）。
 *
 * ⚠️ **criteriaLines 的内容不许改**（R-REG-09 的对外承诺）：
 *    「三维权重 25%/35%/40%、每题 1–5 分、阈值 80/60/40、C 级不接收」必须逐字留在页面上，
 *    打磨只改**呈现方式**（noticeState / panel），不改文案本身。
 */
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

/**
 * 单题的评分控件：1–5 分**横排按钮组**。
 *
 * ⚠️ 为什么不用 <select>：下拉框默认收起，量表（1–5 各代表什么强度）看不见，
 *    选手只能「展开 → 看一眼 → 再收起」，15 题的成本极高。
 *    按钮组把量表摊平成一眼可见的横排（依据：设计文档 §9「每题显示该题所属维度与分值」）。
 */
export function buildRatingField(dim, item, index) {
  const name = `${dim.key}-${index}`;
  const labelId = `lbl-${name}`;
  const values = Array.from({ length: dim.max - dim.min + 1 }, (_, k) => dim.min + k);
  const options = values.map((v) => `
          <label class="radio">
            <input type="radio" name="${escapeHtml(name)}" value="${v}" />
            <span>${v}</span>
          </label>`).join('');
  return `
        <div class="field">
          <span class="field__label" id="${escapeHtml(labelId)}">${escapeHtml(item.text)}</span>
          <div class="radio-group" role="radiogroup" aria-labelledby="${escapeHtml(labelId)}">${options}
          </div>
          <p class="field__hint">每题 ${dim.min}–${dim.max} 分，选一个即可。</p>
        </div>`;
}

/** 一个维度的面板：标题带权重，desc 带量表区间（R-REG-09 明示权重与分值）。 */
export function buildDimensionPanel(dim) {
  return panel({
    title: `${dim.label}（权重 ${dim.weightLabel}）`,
    desc: `共 ${dim.items.length} 题 · 每题 ${dim.min}–${dim.max} 分`,
    body: dim.items.map((it, i) => buildRatingField(dim, it, i)).join(''),
  });
}

/**
 * 合规红线 → 可读文本。
 * ⚠️ 规则文件里 redLines 是**对象数组**（{ key, label }），
 *    直接丢进 noticeState 会被 String() 成「[object Object]」—— 必须取 label。
 */
export function redLineTexts(redLines) {
  return (redLines ?? [])
    .map((r) => (typeof r === 'string' ? r : (r?.label ?? r?.key ?? '')))
    .filter(Boolean);
}

/** 答题进度指标卡（已填题数 / 总题数）。 */
export function buildProgressCard(answered, total) {
  const left = Math.max(0, total - answered);
  return statCard({
    label: '答题进度',
    value: `${answered} / ${total}`,
    hint: left === 0 ? '全部题目已评分，可以提交' : `还有 ${left} 题未评分`,
    tone: left === 0 ? 'success' : 'brand',
  });
}

/**
 * 可解释明细 → 键值表（键 = 维度，值 = 去掉重复维度前缀后的明细）。
 * ⚠️ formatExplain 的文案格式是**契约**（测试直接断言），
 *    所以这里不改文案，只在展示时去掉与键重复的那一段前缀。
 */
export function explainPairs(lines) {
  return (lines ?? []).map((e) => {
    const prefix = `${e.label}：`;
    const value = e.text.startsWith(prefix) ? e.text.slice(prefix.length) : e.text;
    return [e.label, value];
  });
}

// ── 申诉（R-REG-08 · 选手侧）───────────────────────────────────────────────
//
// ⚠️ **端点契约一律以源码为准**（src/http/routes/audit.js + src/services/review-state.js）：
//   POST /api/appeals  body = { subjectType, subjectId, reason }
//     · reason **必填**：服务端 fileAppeal 对空理由抛 400「申诉必须写理由（空理由 = 无法复核）」；
//     · 需要 appeal:write 能力点（seed 里给了 captain / admin）；
//     · 限频：5 秒提交锁 + 60 秒 3 次滑动窗（触发即 429 + Retry-After）。
//   ⇒ 前端**先本地校验空理由**，不发无谓请求；失败必须说清「下一步怎么办」。

/** 申诉理由长度上限（与输入框 maxlength 一致）。 */
export const APPEAL_REASON_MAX = 1000;

/**
 * 申诉入口的出现条件（R-REG-08）：报名**不接收**时才给。
 * ⚠️ 判定口径与结果区的 accepted **逐字一致**（grading.accepted === true 即接收），
 *    两处各判各的会出现「文案说不接收、却没有申诉入口」。
 * ⛔ 没有报名记录 ⇒ 不给入口（没有可申诉的对象）。
 */
export function isAppealable(reg) {
  if (!reg) return false;
  return reg.grading?.accepted !== true;
}

/**
 * 申诉理由校验（纯函数）：空理由**不得提交**（服务端也会拒收）。
 * @returns {{ok: boolean, reason?: string, message?: string}}
 */
export function validateAppealReason(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return { ok: false, message: '申诉理由必填：空理由的申诉无法复核。' };
  if (text.length > APPEAL_REASON_MAX) {
    return { ok: false, message: `申诉理由最多 ${APPEAL_REASON_MAX} 字。` };
  }
  return { ok: true, reason: text };
}

/**
 * 申诉表单（纯函数）：标题 + 理由输入 + 提交按钮 + 反馈区。
 * ⚠️ 表单里的 id 是**契约**（#reg-appeal-reason / #reg-appeal-error /
 *    #reg-appeal-submit / #reg-appeal-feedback）—— 视图与测试都按它取节点。
 */
export function buildAppealForm() {
  return panel({
    title: '提交申诉（R-REG-08）',
    desc: '本级不接收：把理由交给组委会复核。理由必填 —— 空理由的申诉无法复核。',
    body: `
        <div class="field field--required">
          <label class="field__label" for="reg-appeal-reason">申诉理由</label>
          <textarea class="textarea" id="reg-appeal-reason" maxlength="${APPEAL_REASON_MAX}"
            placeholder="说明你为什么认为自己应当被接收（必填）"></textarea>
          <p class="field__hint">最多 ${APPEAL_REASON_MAX} 字。组委会会逐条给结论并写明理由。</p>
          <p class="field__error" id="reg-appeal-error" hidden></p>
        </div>
        <div class="btn-group">
          <button type="button" class="btn btn--primary" id="reg-appeal-submit">提交申诉</button>
        </div>
        <div id="reg-appeal-feedback" class="stack"></div>`,
  });
}

/**
 * 挂载申诉表单并绑定提交（渲染与事件绑定分离）。
 *
 * ⚠️ 为什么**就地反馈**而不是刷新页面：刷新会冲掉选手已经写好的理由，
 *    而且「提交成功/失败」必须一眼可见（点了没反应 = 事故）。
 *
 * @param {object} o
 * @param {HTMLElement} o.container 挂载容器（结果区里的 #reg-appeal）
 * @param {object} o.reg            报名记录（取 id 当申诉对象）
 * @param {object} o.api            API 客户端
 */
export function mountAppealForm({ container, reg, api }) {
  if (!container) return null;
  container.innerHTML = buildAppealForm();
  const btn = container.querySelector('#reg-appeal-submit');
  const reasonBox = container.querySelector('#reg-appeal-reason');
  const errBox = container.querySelector('#reg-appeal-error');
  const out = container.querySelector('#reg-appeal-feedback');

  /** 提交申诉：空理由本地拦下；失败给**可点重试**；成功禁用表单（防重复提交）。 */
  async function submitAppeal() {
    const check = validateAppealReason(reasonBox?.value ?? '');
    if (!check.ok) {
      if (errBox) {
        errBox.textContent = check.message;
        errBox.hidden = false;
      }
      return;
    }
    if (errBox) {
      errBox.textContent = '';
      errBox.hidden = true;
    }
    if (out) out.innerHTML = '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '提交中…';
    }
    try {
      const res = await api.post('/api/appeals', {
        subjectType: 'registration',
        subjectId: reg?.id ?? '',
        reason: check.reason,
      });
      if (out) {
        out.innerHTML = noticeState({
          tone: 'success',
          title: '申诉已提交',
          items: [
            `申诉编号：${res?.id ?? '—'}。组委会会逐条给结论。`,
            '裁决结果会留在报名记录的事件轨迹里，你可以随时回来看。',
          ],
        });
      }
      if (reasonBox) reasonBox.disabled = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '已提交';
      }
    } catch (e) {
      if (out) {
        out.innerHTML = errorState({
          message: '申诉提交失败',
          hint: '服务端返回：' + e.message
            + '。可点「重试」再提交一次；若持续失败，请联系组委会在报名筛选台直接复核你的报名。',
        });
        out.querySelector('[data-action="retry"]')?.addEventListener('click', submitAppeal);
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = '提交申诉';
      }
    }
  }

  btn?.addEventListener('click', submitAppeal);
  return container;
}

/**
 * 结果区 HTML（纯函数）：分级结果 + 申诉入口。
 * ⚠️ **申诉入口只在「不接收」时出现**（R-REG-08）——
 *    已接收的选手没有可申诉的东西，给了入口就是给一条死路。
 */
export function buildResultHtml(reg, model, crit) {
  const levelLabel = model.levels.find((l) => l.key === reg.level)?.label ?? reg.level;
  const accepted = reg.grading?.accepted === true;
  const lines = formatExplain(reg.grading?.explain, crit.scale);
  return `
        ${noticeState({
          tone: accepted ? 'success' : 'warn',
          title: `报名已提交：你被判为 ${reg.level} 级（${levelLabel}）`,
          items: [accepted
            ? '你已被接收，现在可以去组队了。'
            : '本级不接收，可向组委会提交申诉（R-REG-08）。'],
        })}
        ${statRow([
          { label: '总分', value: `${reg.grading?.score ?? 0} 分`, tone: 'brand' },
          { label: '等级', value: `${reg.level}（${levelLabel}）` },
          { label: '是否接收', value: accepted ? '已接收' : '不接收', tone: accepted ? 'success' : 'danger' },
        ])}
        ${panel({
          title: '可解释明细',
          desc: '每一维的均值、权重与加权值 —— 判分口径完全公开（R-REG-09）。',
          body: kvList(explainPairs(lines)),
        })}
        ${accepted ? '' : '<div id="reg-appeal"></div>'}
        <div class="btn-group">
          <button type="button" class="btn btn--primary" id="go-team">去组队</button>
        </div>`;
}

export function renderRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'apply';
  const { api, navigate } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '报名问卷',
      sub: '三个维度的评分 + 1 道开放题；提交后立即给出等级、总分与逐维可解释明细。',
    })}
    <div id="reg-body">${loadingState({ rows: 4, label: '正在加载报名问卷…' })}</div>`;

  const body = wrap.querySelector('#reg-body');

  /** 已评分的题目数（.radio-group 里被勾选的题）。 */
  function countAnswered(form) {
    return form.querySelectorAll('.radio-group input[type="radio"]:checked').length;
  }

  /** 加载问卷；错误态的「重试」按钮复用它（真的重跑一次，不是摆设）。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 4, label: '正在加载报名问卷…' });
    let criteria;
    try {
      criteria = await api.get('/api/registration-criteria');
    } catch (e) {
      body.innerHTML = errorState({
        message: '报名问卷加载失败',
        hint: '接口返回：' + e.message + '。点「重试」重新加载；若持续失败，请确认服务端已启动。',
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
      return;
    }
    renderForm(criteria);
  }

  function renderForm(criteria) {
    const q = buildQuestionnaire(criteria);
    const total = q.dims.reduce((n, d) => n + d.items.length, 0);

    // 空态：配置里还没有维度（本届问卷尚未发布）——必须告诉访客下一步做什么。
    if (!q.dims.length) {
      body.innerHTML = emptyState({
        title: '本届还没有发布报名问卷',
        hint: '组委会发布问卷后，这里会出现三维评分题与开放题；在此之前可以先去看榜单了解赛况。',
      });
      return;
    }

    const form = document.createElement('form');
    form.className = 'stack';
    form.noValidate = true;
    form.innerHTML = `
      ${noticeState({
        tone: 'brand',
        title: '筛选标准（公开透明：报名之前就告诉你）',
        items: q.criteriaLines,
        list: true,
      })}
      ${panel({
        title: '合规与 IP 归属',
        desc: '报名即代表你已阅读并接受下列约定（R-ENT-12）。',
        body: `${kvList([
          ['战队', q.ipOwnership?.team],
          ['组委会', q.ipOwnership?.committee],
          ['企业', q.ipOwnership?.enterprise],
        ])}
        ${redLineTexts(q.redLines).length
          ? noticeState({ tone: 'warn', title: '合规红线', items: redLineTexts(q.redLines), list: true })
          : ''}`,
      })}
      <div id="reg-progress">${buildProgressCard(0, total)}</div>
      ${q.dims.map((d) => buildDimensionPanel(d)).join('')}
      <div class="card">
        <div class="field field--required">
          <label class="field__label" for="reg-open">${escapeHtml(q.open.text || '开放题')}</label>
          <textarea class="textarea" id="reg-open" name="open" maxlength="${q.open.maxLength}"
            placeholder="请说明你的商业问题、目标客户与打算怎么验证（最多 ${q.open.maxLength} 字）"></textarea>
          <p class="field__hint">${q.open.required ? '必填。' : '选填。'}最多 ${q.open.maxLength} 字。</p>
          <p class="field__error" data-role="open-error" hidden></p>
        </div>
        <div class="field field--required">
          <span class="field__label">参赛协议与数据合规</span>
          <label class="checkbox">
            <input type="checkbox" name="consent" />
            <span>${escapeHtml(q.consentPrompt || '我已阅读并同意参赛协议、IP 归属说明与数据合规红线')}</span>
          </label>
          <p class="field__error" data-role="consent-error" hidden></p>
        </div>
        <div class="btn-group">
          <button type="submit" class="btn btn--primary">提交报名</button>
        </div>
        <div id="reg-feedback" class="stack"></div>
      </div>`;

    // 进度随作答实时更新（「我答了几题」必须一眼可见）。
    form.addEventListener('change', () => {
      const box = form.querySelector('#reg-progress');
      if (box) box.innerHTML = buildProgressCard(countAnswered(form), total);
    });

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });

    /** 提交（表单提交与错误态的「重试」都走它）。 */
    async function submit() {
      const feedback = form.querySelector('#reg-feedback');
      const openErr = form.querySelector('[data-role="open-error"]');
      const consentErr = form.querySelector('[data-role="consent-error"]');
      const submitBtn = form.querySelector('button[type="submit"]');
      feedback.innerHTML = '';
      openErr.hidden = true;
      openErr.textContent = '';
      consentErr.hidden = true;
      consentErr.textContent = '';

      const answered = countAnswered(form);
      const missing = total - answered;
      const openValue = form.querySelector('[name="open"]').value.trim();
      const consented = form.querySelector('[name="consent"]').checked;
      // 同意项是否必填：以服务端配置为准（compliance.consent.required）。
      const consentRequired = criteria?.consent?.required === true || Boolean(q.consentPrompt);
      let invalid = false;

      if (missing > 0) {
        invalid = true;
        feedback.innerHTML = noticeState({
          tone: 'danger',
          title: '还有题目没评分',
          items: [`共 ${total} 题，已评分 ${answered} 题，还差 ${missing} 题 —— 每题都要选一个分数（${q.scale.min}–${q.scale.max}）才能提交。`],
        });
      }
      if (q.open.required && !openValue) {
        invalid = true;
        openErr.textContent = '开放题必填：请说明你的商业问题。';
        openErr.hidden = false;
      }
      if (consentRequired && !consented) {
        invalid = true;
        consentErr.textContent = '必须勾选同意参赛协议、IP 归属说明与数据合规红线。';
        consentErr.hidden = false;
      }
      if (invalid) return;

      const answers = { open: openValue };
      for (const d of q.dims) {
        answers[d.key] = d.items.map((_, i) => {
          const hit = form.querySelector(`input[name="${d.key}-${i}"]:checked`);
          return hit ? Number(hit.value) : null;
        });
      }
      answers.consent = { accepted: consented };

      submitBtn.disabled = true;
      submitBtn.textContent = '提交中…';
      try {
        const reg = await api.post('/api/registrations', {
          editionId: criteria.editionId,
          answers,
        });
        showResult(reg, q, criteria);
        // 提交成功后不再允许重复提交（服务端也会以 409 拒绝）。
        submitBtn.disabled = true;
        submitBtn.textContent = '已提交';
      } catch (e) {
        // ⚠️ 失败提示必须说清「下一步怎么办」，不能只回一句 e.message。
        feedback.innerHTML = errorState({
          message: '报名提交失败',
          hint: '服务端返回：' + e.message + '。若是「已提交过本届报名」，说明你此前已报名成功，可直接去「我的战队」；若提示问卷不完整，请确认每题都已评分。',
        });
        // 错误态的「重试」= **重发同一份答案**（不是重新加载页面 —— 那会冲掉已答内容）。
        feedback.querySelector('[data-action="retry"]')?.addEventListener('click', submit);
        submitBtn.disabled = false;
        submitBtn.textContent = '提交报名';
      }
    }

    /** 提交成功：分级结果（等级 + 总分 + 逐维可解释明细）+ 申诉入口（不接收时才给）。 */
    function showResult(reg, model, crit) {
      const feedback = form.querySelector('#reg-feedback');
      feedback.innerHTML = buildResultHtml(reg, model, crit);
      feedback.querySelector('#go-team')?.addEventListener('click', () => navigate('/team'));
      // ⚠️ 申诉入口**只在不接收时**出现（R-REG-08）：容器由 buildResultHtml 一并给出。
      const appealBox = feedback.querySelector('#reg-appeal');
      if (appealBox) mountAppealForm({ container: appealBox, reg, api });
    }

    body.replaceChildren(form);
  }

  load();
  return wrap;
}

// web/views/admin-registration.js — 组委会筛选台
// 依据：设计文档 §9「报名筛选台（含可解释明细）+ 复核/申诉/改级」「任务包与配比 70/30」
// 溯源：R-REG-09 / R-REG-10 / R-ENT-09
import { escapeHtml } from '../escape.js';
import { formatExplain } from './registration.js';

const STATUS_LABELS = {
  submitted: '已提交',
  screening: '筛选中',
  accepted: '已接收',
  rejected: '不接收',
  appealed: '申诉中',
};

export function buildScreeningRows(registrations, criteria) {
  const levels = criteria?.levels ?? [];
  const rows = (registrations ?? []).map((r) => {
    const effective = r.levelFinal ?? r.level;
    return {
      id: r.id,
      userId: r.userId,
      level: effective,
      autoLevel: r.level,
      levelLabel: levels.find((l) => l.key === effective)?.label ?? '',
      score: r.grading?.score ?? r.rawScore ?? null,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status] ?? r.status,
      accepted: r.grading?.accepted === true,
      explain: formatExplain(r.grading?.explain, criteria?.scale),
      events: r.events ?? [],
    };
  });
  const distribution = {};
  for (const l of levels) {
    distribution[l.key] = rows.filter((r) => r.level === l.key).length;
  }
  return { rows, distribution, total: rows.length };
}

/**
 * 事件轨迹 → 一行一条的纯文本（纯函数，不碰 document）。
 *
 * ⚠️ 为什么要抽出来：轨迹的**渲染路径**此前既没有单元测试，结构扫描也只查
 *    `source.includes('r.events')` —— 而 `buildScreeningRows` 里也有 `r.events`，
 *    于是「把渲染改成 `<td>${[].map(...)}</td>`」这个变异体**存活**
 *    （父代理变异检验实测）。抽成纯函数后可以直接断言它的输出。
 */
export function formatEventTrail(events) {
  return (events ?? []).map((ev) => (
    `${ev.fromStatus ?? '—'} → ${ev.toStatus ?? '—'}${ev.reason ? `（${ev.reason}）` : ''}`
  ));
}

export function buildFunnelView(registrations, funnel) {
  const total = (registrations ?? []).length;
  return (funnel ?? []).map((stage, i) => ({
    key: stage.key,
    label: stage.label,
    rate: stage.rate,
    current: i === 0 ? total : null,
    target: stage.rate === null ? null : Math.round(total * stage.rate),
    note: i === 0 ? '本届报名实数' : '待 P2/P3 的赛段结果填充',
  }));
}

export function renderAdminRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card admin-registration';
  wrap.innerHTML = '<p class="muted">正在加载报名筛选台…</p>';
  const { api } = ctx;

  (async () => {
    const criteria = await api.get('/api/registration-criteria');
    const editionId = criteria.editionId;
    const [{ items: registrations }, { items: packages, mix }] = await Promise.all([
      api.get(`/api/registrations?editionId=${editionId}`),
      api.get(`/api/task-packages?editionId=${editionId}`),
    ]);
    const { rows, distribution, total } = buildScreeningRows(registrations, criteria);
    const funnel = buildFunnelView(registrations, criteria.funnel);

    wrap.innerHTML = `
      <h1>报名筛选台</h1>
      <section class="funnel">
        <h2>筛选漏斗（R-REG-10）</h2>
        <ul>${funnel.map((f) => `<li>${escapeHtml(f.label)}：${f.rate === null ? '—' : `${Math.round(f.rate * 100)}%`}｜${f.current === null ? '待填充' : `当前 ${f.current} 人`}</li>`).join('')}</ul>
      </section>
      <section class="distribution">
        <h2>分级分布（共 ${total} 人）</h2>
        <ul>${Object.entries(distribution).map(([k, v]) => `<li>${escapeHtml(k)} 级 ${v} 人</li>`).join('')}</ul>
      </section>
      <section class="mix">
        <h2>任务包配比（R-ENT-09：70% B 端 + 30% 自由）</h2>
        <p>${mix ? `自由题 ${mix.free}/${mix.total}（${Math.round(mix.actualFree * 100)}%）｜B 端 ${mix.enterprise}｜${mix.ok ? '配比达标' : '配比未达标'}` : '无数据'}</p>
        ${mix && !mix.ok ? `<ul class="err">${mix.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
        <ul>${packages.map((p) => `<li>${escapeHtml(p.title)}｜${p.isFreeBrief ? '自由命题' : `B 端 ${escapeHtml(p.solvabilityGrade ?? '未分级')} 级`}｜${escapeHtml(p.agreement ?? '')}</li>`).join('')}</ul>
      </section>
      <table class="screening">
        <thead><tr><th>用户</th><th>系统分级</th><th>复核级别</th><th>分数</th><th>状态</th><th>可解释明细</th><th>事件轨迹</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-id="${escapeHtml(r.id)}">
              <td>${escapeHtml(r.userId)}</td>
              <td>${escapeHtml(r.autoLevel)}</td>
              <td>${escapeHtml(r.level)}</td>
              <td>${r.score}</td>
              <td>${escapeHtml(r.statusLabel)}</td>
              <td>${r.explain.map((e) => escapeHtml(e.text)).join('<br />')}</td>
              <td>${formatEventTrail(r.events).map((line) => escapeHtml(line)).join('<br />')}</td>
              <td>
                <select data-role="level">
                  ${criteria.levels.map((l) => `<option value="${escapeHtml(l.key)}" ${l.key === r.level ? 'selected' : ''}>${escapeHtml(l.key)}</option>`).join('')}
                </select>
                <input data-role="note" placeholder="复核意见" />
                <button data-role="save">改级</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p id="admin-err" class="err"></p>`;

    for (const btn of wrap.querySelectorAll('[data-role=save]')) {
      btn.addEventListener('click', async () => {
        const row = btn.closest('tr');
        const level = row.querySelector('[data-role=level]').value;
        const note = row.querySelector('[data-role=note]').value;
        try {
          await api.post(`/api/registrations/${row.dataset.id}/level`, { level, note });
          location.reload();
        } catch (e) {
          wrap.querySelector('#admin-err').textContent = e.message;
        }
      });
    }
  })().catch((e) => {
    wrap.innerHTML = `<div class="card err">${escapeHtml(e.message)}</div>`;
  });

  return wrap;
}

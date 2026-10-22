// web/views/admin-registration.js — 组委会筛选台
// 依据：设计文档 §9「报名筛选台（含可解释明细）+ 复核/申诉/改级」「任务包与配比 70/30」
// 溯源：R-REG-09 / R-REG-10（5 阶段筛选漏斗）/ R-ENT-09（任务包配比）
//
// 本轮（P7）「现有页面打磨到生产级」的改动要点：
//   ① 顶部 statRow：报名总数 + 各等级人数 + 任务包配比是否达标；
//   ② 漏斗与分级分布从纯文本 <ul> 改成 barRow 条形图（第一段是实数，后续段标「待填充」）；
//   ③ 主表用 tableWrap 包起来（窄屏横向滚动，表头 sticky），表头含「事件轨迹」一列；
//   ④ 改级操作放在每行的操作列：复核级别 .select + 复核意见 .input + .btn--primary 按钮；
//   ⑤ 改级成功**就地更新该行**并给成功提示，失败给错误提示 —— 不用 location.reload()
//      （整页刷新会冲掉其他行已填的复核意见，是生产级事故）。
//
// ⛔ 前端**不做可见性过滤**（全局约束）：API 返回什么就渲染什么，一个都不许丢。
import { escapeHtml } from '../escape.js';
import { formatExplain } from './registration.js';
import {
  badge, barRow, emptyRow, emptyState, errorState, kvList, loadingState, noticeState,
  pageHead, panel, statRow, tableWrap,
} from '../ui.js';

const STATUS_LABELS = {
  submitted: '已提交',
  screening: '筛选中',
  accepted: '已接收',
  rejected: '不接收',
  appealed: '申诉中',
};

/** 状态 → 徽章色调。 */
const STATUS_TONES = {
  submitted: 'info',
  screening: 'info',
  accepted: 'success',
  rejected: 'danger',
  appealed: 'warn',
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

/** 等级键 → 「S（顶级种子）」这样的可读文本。 */
export function levelText(key, levels) {
  if (!key) return '—';
  const label = (levels ?? []).find((l) => l.key === key)?.label ?? '';
  return label ? `${key}（${label}）` : key;
}

/**
 * 报名明细表（纯函数）：表头 + 每一行。
 * ⚠️ 「事件轨迹」这一列必须真的渲染（测试直接断言表头与调用点）。
 */
export function buildScreeningTable(rows, criteria) {
  const levels = criteria?.levels ?? [];
  const head = `
        <thead>
          <tr>
            <th>用户</th>
            <th>系统分级</th>
            <th>复核级别</th>
            <th>分数</th>
            <th>状态</th>
            <th>可解释明细</th>
            <th>事件轨迹</th>
            <th>操作</th>
          </tr>
        </thead>`;
  const body = (rows ?? []).map((r) => {
    const trail = formatEventTrail(r.events);
    return `
          <tr data-id="${escapeHtml(r.id)}">
            <td>${escapeHtml(r.userId)}</td>
            <td>${escapeHtml(r.autoLevel)}</td>
            <td data-cell="level">${escapeHtml(levelText(r.level, levels))}</td>
            <td class="td-num" data-cell="score">${escapeHtml(r.score ?? '—')}</td>
            <td data-cell="status">${badge(r.statusLabel, STATUS_TONES[r.status] ?? 'neutral')}</td>
            <td>${r.explain.map((e) => escapeHtml(e.text)).join('<br />')}</td>
            <td data-cell="events">${trail.length
              ? trail.map((line) => escapeHtml(line)).join('<br />')
              : '<span class="muted">—</span>'}</td>
            <td>
              <select class="select" data-role="level">
                ${levels.map((l) => `<option value="${escapeHtml(l.key)}"${l.key === r.level ? ' selected' : ''}>${escapeHtml(l.key)}（${escapeHtml(l.label)}）</option>`).join('')}
              </select>
              <input class="input" data-role="note" placeholder="复核意见" />
              <button type="button" class="btn btn--primary btn--sm" data-role="save">改级</button>
              <p class="small" data-role="feedback" hidden></p>
            </td>
          </tr>`;
  }).join('');
  return `${head}
        <tbody>${body || emptyRow(8, '本届还没有报名记录')}</tbody>`;
}

export function renderAdminRegistration(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-registration';
  const { api } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '报名筛选台',
      sub: '委员会工作台：查看分级分布与筛选漏斗，逐份复核并改级（每一行都能改，不需要刷新页面）。',
    })}
    <div id="admin-body">${loadingState({ rows: 4, label: '正在加载报名筛选台…' })}</div>`;

  const body = wrap.querySelector('#admin-body');
  let criteria = null;

  /** 加载筛选台；错误态的「重试」按钮复用它（真的重跑一次）。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 4, label: '正在加载报名筛选台…' });
    let registrations = [];
    let packages = [];
    let mix = null;
    try {
      criteria = await api.get('/api/registration-criteria');
      const edition = encodeURIComponent(criteria?.editionId ?? '');
      const [regRes, pkgRes] = await Promise.all([
        api.get(`/api/registrations?editionId=${edition}`),
        api.get(`/api/task-packages?editionId=${edition}`),
      ]);
      // ⚠️ 真实后端返回 { items }，演示适配器返回 { rows } —— 两种都收下，
      //    但**不按任何条件过滤**：API 返回什么就渲染什么。
      registrations = regRes?.items ?? regRes?.rows ?? [];
      packages = pkgRes?.items ?? pkgRes?.rows ?? [];
      mix = pkgRes?.mix ?? null;
    } catch (e) {
      body.innerHTML = errorState({
        message: '报名筛选台加载失败',
        hint: '接口返回：' + e.message + '。点「重试」重新加载；若持续失败，请确认服务端已启动且你的账号有组委会权限。',
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
      return;
    }
    render(registrations, packages, mix);
  }

  function render(registrations, packages, mix) {
    const { rows, distribution, total } = buildScreeningRows(registrations, criteria);
    const funnel = buildFunnelView(registrations, criteria?.funnel);
    const levels = criteria?.levels ?? [];

    const statCards = [
      { label: '报名总数', value: total, tone: 'brand' },
      ...levels.map((l) => ({
        label: `${l.key} 级 · ${l.label}`,
        value: distribution[l.key] ?? 0,
      })),
      {
        label: '任务包配比',
        value: mix ? (mix.ok ? '达标' : '未达标') : '无数据',
        hint: mix ? '自由命题 30% + B 端 70%' : '需要组委会权限且任务包已发布',
        tone: mix ? (mix.ok ? 'success' : 'danger') : 'neutral',
      },
    ];

    const funnelBars = funnel.map((f) => barRow({
      label: f.label,
      // 第一段是本届报名实数；后续段还没有赛段结果 ⇒ 明确标注「待填充」，不假装有数。
      value: f.current === null ? '待填充' : f.current,
      max: total || 1,
      note: f.target === null ? '无目标人数' : `目标 ${f.target} 人`,
      tone: f.current === null ? 'info' : 'brand',
    })).join('');

    const distributionBars = levels.map((l) => {
      const count = distribution[l.key] ?? 0;
      return barRow({
        label: `${l.key}（${l.label}）`,
        value: count,
        max: total || 1,
        note: `${Math.round((count / (total || 1)) * 100)}%`,
        tone: 'brand',
      });
    }).join('');

    const packageRows = packages.map((p) => `
            <tr>
              <td>${escapeHtml(p.title)}</td>
              <td>${p.isFreeBrief
                ? badge('自由命题', 'brand')
                : badge(`B 端 ${p.solvabilityGrade ?? '未分级'}`, p.solvabilityGrade ? 'info' : 'warn')}</td>
              <td>${escapeHtml(p.agreement ?? '')}</td>
            </tr>`).join('');

    body.innerHTML = `
      <div class="stack">
        ${statRow(statCards)}
        ${panel({
          title: '筛选漏斗（R-REG-10）',
          desc: '第一段是本届报名实数，后续阶段的结果要等赛段跑完才有。',
          body: `${funnelBars || '<p class="muted">本届还没有配置筛选漏斗。</p>'}
            ${criteria?.funnelNote ? noticeState({ tone: 'info', items: [criteria.funnelNote] }) : ''}`,
        })}
        ${panel({
          title: `分级分布（共 ${total} 人）`,
          desc: '按最终级别统计（含组委会改级后的结果）。',
          body: distributionBars || '<p class="muted">本届还没有配置等级档位。</p>',
        })}
        ${panel({
          title: '任务包配比（R-ENT-09：70% B 端 + 30% 自由）',
          desc: '体检对象是已发布（进池）的任务卡。',
          body: `${mix ? kvList([
            ['自由命题', `${mix.free} / ${mix.total}（${Math.round(mix.actualFree * 100)}%）`],
            ['B 端任务包', `${mix.enterprise} 张`],
            ['目标', '自由命题 30% + B 端 70%（A 40% / B 20% / C 10%，容差 ±10 个百分点）'],
            ['结论', mix.ok ? '配比达标' : '配比未达标'],
          ]) : '<p class="muted">暂无配比体检数据（需要组委会权限且任务包已发布）。</p>'}
            ${mix && !mix.ok ? noticeState({ tone: 'danger', title: '配比未达标', items: mix.errors ?? [], list: true }) : ''}
            ${packageRows
              ? tableWrap(`
            <thead><tr><th>任务包</th><th>类型</th><th>企业承诺</th></tr></thead>
            <tbody>${packageRows}</tbody>`)
              : emptyState({ title: '还没有任务包', hint: '组委会提交并分级任务卡后，这里会列出全部任务包与配比体检结果。' })}`,
        })}
        ${panel({
          title: '报名明细',
          desc: '每行都能复核改级：选级别 → 写意见 → 点「改级」，结果就地更新。',
          body: `${rows.length ? '' : emptyState({
            title: '本届还没有报名记录',
            hint: '有选手提交报名后，这里会逐条列出分级、分数、可解释明细与事件轨迹。',
          })}
            <div id="admin-feedback"></div>
            ${rows.length ? tableWrap(buildScreeningTable(rows, criteria), { caption: '报名明细' }) : ''}`,
        })}
      </div>`;

    bindSaveButtons();
  }

  /** 改级成功后就地刷新这一行（不整页刷新 —— 那会冲掉其他行已填的复核意见）。 */
  function paintRow(tr, data) {
    const levels = criteria?.levels ?? [];
    const level = data.levelFinal ?? data.level;
    const levelCell = tr.querySelector('[data-cell="level"]');
    const scoreCell = tr.querySelector('[data-cell="score"]');
    const statusCell = tr.querySelector('[data-cell="status"]');
    const eventsCell = tr.querySelector('[data-cell="events"]');
    if (levelCell) levelCell.textContent = levelText(level, levels);
    if (scoreCell) scoreCell.textContent = String(data.grading?.score ?? data.rawScore ?? '—');
    if (statusCell) {
      statusCell.innerHTML = badge(STATUS_LABELS[data.status] ?? data.status, STATUS_TONES[data.status] ?? 'neutral');
    }
    if (eventsCell && Array.isArray(data.events)) {
      const trail = formatEventTrail(data.events);
      eventsCell.innerHTML = trail.length
        ? trail.map((line) => escapeHtml(line)).join('<br />')
        : '<span class="muted">—</span>';
    }
  }

  /** 重新拉这一条报名（拿到权威的轨迹）；拉不到就用改级接口的返回值兜底。 */
  async function refreshOne(regId, fallback) {
    try {
      return await api.get(`/api/registrations/${encodeURIComponent(regId)}`);
    } catch {
      return fallback;
    }
  }

  function bindSaveButtons() {
    for (const btn of body.querySelectorAll('[data-role="save"]')) {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const regId = tr.dataset.id;
        const levelSelect = tr.querySelector('[data-role="level"]');
        const noteInput = tr.querySelector('[data-role="note"]');
        const feedbackCell = tr.querySelector('[data-role="feedback"]');
        const level = levelSelect.value;
        const note = noteInput.value.trim();
        btn.disabled = true;
        btn.textContent = '提交中…';
        if (feedbackCell) feedbackCell.hidden = true;
        try {
          const updated = await api.post(`/api/registrations/${encodeURIComponent(regId)}/level`, { level, note });
          const fresh = await refreshOne(regId, updated);
          paintRow(tr, fresh);
          if (levelSelect) levelSelect.value = fresh.levelFinal ?? fresh.level ?? level;
          const who = fresh.userId ?? '';
          showFeedback('success', `已改级：${who} → ${levelSelect.value} 级`);
          if (feedbackCell) {
            feedbackCell.textContent = `已改级为 ${levelSelect.value} 级`;
            feedbackCell.className = 'small muted';
            feedbackCell.hidden = false;
          }
        } catch (e) {
          const message = '改级失败：' + e.message;
          if (feedbackCell) {
            feedbackCell.textContent = message;
            feedbackCell.className = 'small err';
            feedbackCell.hidden = false;
          }
          showFeedback('danger', message);
        } finally {
          btn.disabled = false;
          btn.textContent = '改级';
        }
      });
    }
  }

  /** 全局提示区（表格正上方）：成功 / 失败都看得见。 */
  function showFeedback(tone, message) {
    const box = body.querySelector('#admin-feedback');
    if (!box) return;
    box.innerHTML = noticeState({
      tone,
      title: tone === 'success' ? '改级成功' : '改级未完成',
      items: [message],
    });
  }

  load();
  return wrap;
}

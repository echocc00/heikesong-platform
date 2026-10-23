// web/views/admin-task-packages.js — 任务卡分级 / 审批界面
//
// 依据：P10 计划 §4 W4-a（docs/superpowers/plans/2026-10-22-platform-P10-design-system.md）
// 视觉：docs/design-system-p10.md（token / 组件 / 材质三件套 —— 本文件只复用 web/ui.js 的组件，不写字面色值）
// 溯源需求：R-ENT-06（六维可解性准入）/ R-ENT-07（一票否决）/ R-ENT-08（分级签约与协议）
//           R-ENT-09（任务池配比）/ R-ENT-10（自由命题不签企业协议）
//
// ⚠️ **后端契约（以源码为准，不凭猜写前端）**：
//   platform/src/http/routes/taskPackage.js ＋ platform/src/services/taskPackage.js
//   · GET  /api/task-packages?editionId=…      → { items, mix }（无权限 ⇒ 200 + 空集）
//   · POST /api/task-packages/:id/solvability   → body { answers: { <维度键>: 0..max 整数, vetoes?: [否决项键] } }
//   · POST /api/task-packages/:id/approve       → body { grade: 档位键 }
//   权限：评估要 task_package:write；签级要 task_package:approve。
//   状态机（服务层 ASSESSABLE / APPROVABLE）：
//     submitted / assessed / returned 可评估；assessed / returned 可签级；published 两者都不行。
//
// ⚠️ **六维规格从哪来（前端一个字都不许硬编码）**：
//   服务端**没有**「返回评估表规格」的端点 ⇒ 规格有两个来源，按可靠性取：
//   ① 服务端投影：已评估过的卡，meta.solvability.explain 里带着每一维的
//      key / label / weight / max（领域层算分时写进去的）⇒ 列表接口顺带就给了；
//   ② 规则投影：同源的规则文件（rules/solvability.json）—— 演示站把它放在站点里
//      （web/api.demo.js 的 RULES_BASE 就是同一个约定），前端按同一相对路径取。
//   两个都取不到时，页面**不编造维度**，只给一条能照做的提示（见 solvabilityFormHtml）。
//   ⚠️ 生产部署默认**不挂** /rules/（只有 DEMO_MODE=1 才挂）⇒ 生产环境的冷启动
//      （一张卡都没评估过）拿不到规格 ⇒ 需要后端补一个规格投影端点（见交付说明）。
//
// ⛔ 前端**不做可见性过滤**（全局约束）：API 返回什么就渲染什么，一个都不许丢。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, kvList, loadingState, noticeState,
  pageHead, panel, statRow, tableWrap,
} from '../ui.js';

// ── 任务卡状态（**API 契约值**，不是规则值）────────────────────────────
// ⚠️ 与后端 platform/src/services/taskPackage.js 的状态机一一对应：
//    写错一个拼写 ⇒ 该卡永远进不了评估/签级流程，而且**不报任何错**。
const ASSESSABLE = new Set(['submitted', 'assessed', 'returned']);
const APPROVABLE = new Set(['assessed', 'returned']);

const STATUS_LABELS = {
  submitted: '已提交',
  assessed: '已评估',
  returned: '已退回',
  published: '已发布',
};

const STATUS_TONES = {
  submitted: 'info',
  assessed: 'brand',
  returned: 'warn',
  published: 'success',
};

/** 规则投影文件的地址（与 web/api.demo.js 的 RULES_BASE 同一约定：相对**文档**）。 */
const RULES_URL = './rules/solvability.json';

// ══════════════════════════════════════════════════════════════════
// 一、规格投影（纯函数）
// ══════════════════════════════════════════════════════════════════

/**
 * 从规则文件（rules/solvability.json 的形状）投影出评估表规格（纯函数）。
 *
 * ⚠️ 为什么要**投影**而不是直接把配置丢给前端：
 *    配置里有「内部工作备注」这类字段（见 src/domain/event-info.js 的同一纪律），
 *    前端只需要「维度 / 档位 / 否决项」三样 ⇒ 这里逐字段挑出来。
 *
 * @param {object|null} rules 规则配置（rules/solvability.json）
 * @returns {object|null} 规格；配置形状不对 ⇒ null（调用方据此降级）
 */
export function solvabilitySpecFromRules(rules) {
  if (!rules || typeof rules !== 'object') return null;
  const dims = Array.isArray(rules.dimensions) ? rules.dimensions : [];
  if (!dims.length) return null;
  return {
    source: 'rules',
    dimensions: dims
      .filter((d) => d && typeof d.key === 'string')
      .map((d) => ({
        key: d.key,
        label: String(d.label ?? d.key),
        weight: Number(d.weight) || 0,
        max: Number(d.max) || 0,
      })),
    grades: (Array.isArray(rules.grades) ? rules.grades : [])
      .filter((g) => g && typeof g.key === 'string')
      .map((g) => ({
        key: g.key,
        minScore: Number(g.minScore),
        maxScore: Number(g.maxScore),
        commitment: String(g.commitment ?? ''),
        agreement: String(g.agreement ?? ''),
      })),
    vetoes: (Array.isArray(rules.vetoes) ? rules.vetoes : [])
      .filter((v) => v && typeof v.key === 'string')
      .map((v) => ({
        key: v.key,
        label: String(v.label ?? v.key),
        // auto = 由某一维的取值自动命中（服务端推导）⇒ 前端不自报，只让委员会自报其余的
        auto: Boolean(v.auto),
      })),
  };
}

/**
 * 从服务端返回的任务卡列表里投影出评估表规格（纯函数）。
 *
 * ⚠️ 服务端把每一维的 key / label / weight / max 写进了 meta.solvability.explain
 *    （领域层算分时的产物）⇒ 已评估过的卡，列表接口就顺带把规格给全了。
 *    这是**服务端投影**（不是前端编的）⇒ 委员会改了 rules，页面跟着变。
 *
 * @param {object[]} packages 任务卡列表（presented 形状）
 * @returns {object|null} 规格；一张都没评估过 ⇒ null
 */
export function solvabilitySpecFromPackages(packages) {
  const list = Array.isArray(packages) ? packages : [];
  for (const pkg of list) {
    const solvability = pkg?.meta?.solvability;
    const explain = solvability?.explain;
    if (!Array.isArray(explain) || !explain.length) continue;
    // ⚛️ F16（Critical）：档位定义（minScore/maxScore）**不完整就不算规格**。
    //    原来这里只从卡片反推**档位键**（`grades: observedGrades(list).map(k => ({key:k}))`）
    //    ⇒ `gradeTiers()` 因「没有一条带 minScore」判「档位未就绪」
    //    ⇒ **只要有任意一张卡被评估过，签级控件就整片消失**（自锁：再评估也修不好）。
    //    投影不出完整档位 ⇒ **返回 null**，让调用方降级（`??` 走规则投影）
    //    —— 半份规格比没有规格更坏：它会让页面显示「档位未就绪」而看不出真因。
    //    服务端现在也会把完整档位定义带进 meta.solvability（见 services/taskPackage.js）。
    const grades = (Array.isArray(solvability.grades) ? solvability.grades : [])
      .filter((g) => g && typeof g.key === 'string')
      .map((g) => ({
        key: g.key,
        minScore: Number(g.minScore),
        maxScore: Number(g.maxScore),
        commitment: String(g.commitment ?? ''),
        agreement: String(g.agreement ?? ''),
      }));
    return {
      source: 'api',
      dimensions: explain
        .filter((d) => d && typeof d.dimension === 'string')
        .map((d) => ({
          key: d.dimension,
          label: String(d.label ?? d.dimension),
          weight: Number(d.weight) || 0,
          max: Number(d.max) || 0,
        })),
      // ⚛️ F16（Critical）：档位定义（minScore/maxScore）**必须完整**，否则这份规格是残的。
      //    残规格会让 `gradeTiers()` 判「档位未就绪」⇒ 签级控件整片消失（自锁）。
      //    服务端现在把完整档位定义投影进 meta.solvability（见 services/taskPackage.js）
      //    ⇒ 这里优先读它；读不到（**旧数据**：本项修复之前评估过的卡）才退回
      //    「从已观察到的取值反推」（只有键，没有分数区间）。
      grades: grades.length ? grades : observedGrades(list).map((key) => ({ key })),
      // 否决项：优先用服务端带来的**完整定义**（含 label / auto）；
      // 没有就退回「从已命中的反推」（只有键）。
      vetoes: (Array.isArray(solvability.vetoesSpec) && solvability.vetoesSpec.length
        ? solvability.vetoesSpec
        : observedVetoes(list)).map((v) => (typeof v === 'string' ? { key: v } : v)),
    };
  }
  return null;
}

/** 规格里出现过的档位键（从卡片的已签 / 已算档位反推）。 */
function observedGrades(packages) {
  const keys = new Set();
  for (const pkg of packages) {
    const solvability = pkg?.meta?.solvability ?? {};
    for (const key of [pkg?.grade, pkg?.solvabilityGrade, solvability.grade, solvability.computedGrade]) {
      if (typeof key === 'string' && key) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * 定规格（纯函数）：规则投影更完整（六维 + 档位区间 + 否决项说明）⇒ 有它就用它；
 * 没有就退回服务端投影（维度齐、档位只有键）。
 *
 * @param {{ packages?: object[], rules?: object|null }} input
 * @returns {object|null}
 */
export function resolveSolvabilitySpec({ packages = [], rules = null } = {}) {
  return solvabilitySpecFromRules(rules) ?? solvabilitySpecFromPackages(packages);
}

/** 规格里出现过的否决项键（从卡片已命中的否决项反推）。 */
function observedVetoes(packages) {
  const keys = new Set();
  for (const pkg of packages) {
    const list = pkg?.meta?.solvability?.vetoes;
    if (!Array.isArray(list)) continue;
    for (const key of list) if (typeof key === 'string' && key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * 档位划分（纯函数）：**最低一档是退回档**，其余是通过档。
 *
 * ⚠️ 为什么「最低一档 = 退回档」而不是写死某个键：
 *    档位键属于规则（rules/solvability.json 的 grades），前端不许硬编码；
 *    而服务端对「命中否决项」的处置也是「强制落到最低档并退回」——
 *    两者口径一致 ⇒ 用**分数区间最低**这个结构特征来认退回档，规则改了也跟着改。
 *
 * @param {object|null} spec
 * @returns {{ approve: object[], return: object|null, complete: boolean }}
 */
export function gradeTiers(spec) {
  const scored = (spec?.grades ?? [])
    .filter((g) => g && typeof g.key === 'string' && Number.isFinite(Number(g.minScore)));
  if (!scored.length) return { approve: [], return: null, complete: false };
  const sorted = [...scored].sort((a, b) => Number(b.minScore) - Number(a.minScore));
  return { approve: sorted.slice(0, -1), return: sorted.at(-1), complete: true };
}

/** 委员会**自报**的否决项（规则里没有 auto 的那些 ⇒ 不是由维度取值推导的）。 */
export function selfReportedVetoes(spec) {
  return (spec?.vetoes ?? []).filter((v) => v && typeof v.key === 'string' && !v.auto);
}

// ══════════════════════════════════════════════════════════════════
// 二、任务卡的展示模型（纯函数）
// ══════════════════════════════════════════════════════════════════

/**
 * 一张任务卡的展示模型（纯函数）。
 * ⚠️ 状态能不能评估 / 能不能签级，按**服务层的状态机**判定（见文件头）——
 *    前端提前说不行，服务端仍然最终裁决（DP-77）。
 */
export function packageView(pkg = null) {
  const solvability = pkg?.meta?.solvability ?? {};
  const explain = Array.isArray(solvability.explain) ? solvability.explain : [];
  const values = {};
  for (const d of explain) {
    if (!d || typeof d.dimension !== 'string') continue;
    values[d.dimension] = Number(d.value ?? 0);
  }
  const status = String(pkg?.status ?? '');
  return {
    id: String(pkg?.id ?? ''),
    title: String(pkg?.title ?? ''),
    enterpriseName: String(pkg?.enterpriseName ?? ''),
    isFreeBrief: pkg?.isFreeBrief === true,
    status,
    statusLabel: STATUS_LABELS[status] ?? (status || '—'),
    statusTone: STATUS_TONES[status] ?? 'neutral',
    grade: pkg?.grade ?? null,
    solvabilityGrade: pkg?.solvabilityGrade ?? solvability.grade ?? null,
    solvabilityScore: pkg?.solvabilityScore ?? solvability.score ?? null,
    commitment: String(pkg?.commitment ?? ''),
    agreement: String(pkg?.agreement ?? ''),
    painPoint: String(pkg?.painPoint ?? ''),
    expectedDelivery: String(pkg?.expectedDelivery ?? ''),
    acceptanceCriteria: String(pkg?.acceptanceCriteria ?? ''),
    values,
    vetoes: Array.isArray(solvability.vetoes)
      ? solvability.vetoes.filter((k) => typeof k === 'string')
      : [],
    canAssess: ASSESSABLE.has(status),
    canSign: APPROVABLE.has(status),
  };
}

// ══════════════════════════════════════════════════════════════════
// 三、渲染（纯函数）
// ══════════════════════════════════════════════════════════════════

/** 百分比文案（纯函数）：0.3 → 30%。 */
function pctText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

/**
 * 每张卡的六维评估表（纯函数）。
 *
 * ⚠️ 维度名、权重、量表上限**全部来自规格**，本文件不写一个字面量。
 * ⚠️ 规格取不到时**不编造维度**：只给一条能照做的提示（宁可少一个功能，
 *    也不能让委员会对着编出来的维度打分 —— 那是拿规则开玩笑）。
 */
export function solvabilityFormHtml({ pkg = null, spec = null } = {}) {
  const view = packageView(pkg);
  const dims = spec?.dimensions ?? [];
  if (!dims.length) {
    return noticeState({
      tone: 'warn',
      title: '六维评估表尚未就绪',
      items: [
        '服务端没有返回六维评估规格（维度 / 权重 / 量表），本页渲染不出评分表。',
        '规格缺位时不会用编出来的维度顶替 —— 请让后端补一个规格投影端点后再评估。',
      ],
    });
  }
  const id = escapeHtml(view.id);
  const rows = dims.map((d) => {
    const key = escapeHtml(d.key);
    const current = view.values[d.key];
    const options = [];
    for (let v = 0; v <= d.max; v += 1) {
      const selected = Number(current) === v ? ' selected' : '';
      options.push(`<option value="${v}"${selected}>${v} / ${d.max}</option>`);
    }
    const hasValue = current !== undefined;
    return `
            <tr>
              <td>${escapeHtml(d.label)}</td>
              <td class="td-num">${escapeHtml(pctText(d.weight))}</td>
              <td>
                <select class="select" id="dim-${id}-${key}" data-role="dimension" data-dimension="${key}"${view.canAssess ? '' : ' disabled'}>
                  <option value=""${hasValue ? '' : ' selected'}>— 未评 —</option>
                  ${options.join('')}
                </select>
              </td>
            </tr>`;
  }).join('');

  const vetoes = selfReportedVetoes(spec);
  const vetoRows = vetoes.map((v) => `
            <label class="checkbox">
              <input type="checkbox" data-role="veto" data-veto="${escapeHtml(v.key)}"${view.vetoes.includes(v.key) ? ' checked' : ''}${view.canAssess ? '' : ' disabled'} />
              <span>${escapeHtml(v.label || v.key)}</span>
            </label>`).join('');

  return `
        <div class="stack">
          ${tableWrap(`
            <thead><tr><th>可解性维度</th><th class="td-num">权重</th><th>评分</th></tr></thead>
            <tbody>${rows}</tbody>`, { caption: '六维可解性评估表', className: 'table table--compact' })}
          ${vetoRows ? `<div class="radio-group">${vetoRows}</div>` : ''}
          <div class="row">
            <button type="button" class="btn btn--primary btn--sm" data-action="assess" data-id="${id}"${view.canAssess ? '' : ' disabled'}>提交六维评估</button>
            ${view.canAssess ? '' : noticeState({ tone: 'info', items: [`该卡当前为「${view.statusLabel}」，不能重新评估（下方控件已锁）。`] })}
          </div>
        </div>`;
}

/**
 * 每张卡的签级区（纯函数）：通过（选档位）/ 退回（必填理由）。
 *
 * ⚠️ 退回档由档位区间最低的那一档决定（见 gradeTiers）⇒ 不写死键名。
 */
export function signoffFormHtml({ pkg = null, spec = null } = {}) {
  const view = packageView(pkg);
  const tiers = gradeTiers(spec);
  if (!tiers.complete) {
    return noticeState({
      tone: 'warn',
      title: '签级档位尚未就绪',
      items: ['服务端没有返回档位规格（分数区间 / 承诺 / 协议），本页无法签级。'],
    });
  }
  const id = escapeHtml(view.id);
  const options = tiers.approve.map((g) => `
            <option value="${escapeHtml(g.key)}">${escapeHtml(g.key)}（${g.minScore}–${g.maxScore} 分）· ${escapeHtml(g.commitment)}</option>`).join('');
  const ret = tiers.return;
  return `
        <div class="stack">
          <div class="row">
            <label class="field" for="grade-${id}">
              <span class="field__label">签级</span>
              <select class="select" id="grade-${id}" data-role="grade"${view.canSign ? '' : ' disabled'}>${options}</select>
            </label>
            <button type="button" class="btn btn--primary btn--sm" data-action="approve" data-id="${id}"${view.canSign ? '' : ' disabled'}>签级通过</button>
          </div>
          <label class="field field--required" for="reason-${id}">
            <span class="field__label">退回理由（退回时必填）</span>
            <textarea class="textarea" id="reason-${id}" data-role="reason" placeholder="写清缺什么、怎么补；补齐后可重新提交六维评估"${view.canSign ? '' : ' disabled'}></textarea>
          </label>
          <div class="row">
            <button type="button" class="btn btn--danger btn--sm" data-action="return" data-id="${id}"${view.canSign ? '' : ' disabled'}>退回出题方</button>
            <span class="small muted">退回档：${escapeHtml(ret.key)}（${ret.minScore}–${ret.maxScore} 分）· ${escapeHtml(ret.agreement)}</span>
          </div>
          ${view.canSign ? '' : noticeState({ tone: 'info', items: [`该卡当前为「${view.statusLabel}」，不能签级（下方控件已锁）。`] })}
        </div>`;
}

/** 一张任务卡的完整卡片（纯函数）。 */
export function taskPackageCardHtml({ pkg = null, spec = null } = {}) {
  const view = packageView(pkg);
  const id = escapeHtml(view.id);
  const badges = [
    badge(view.statusLabel, view.statusTone),
    view.isFreeBrief ? badge('自由命题', 'brand') : badge('企业命题', 'info'),
    view.grade
      ? badge(`已签 ${view.grade}`, 'success')
      : (view.solvabilityGrade ? badge(`评估 ${view.solvabilityGrade}`, 'warn') : badge('未分级', 'warn')),
  ].join('');
  const details = [
    ['出题方', view.enterpriseName || (view.isFreeBrief ? '自由命题' : '')],
    ['痛点', view.painPoint],
    ['期望交付', view.expectedDelivery],
    ['验收标准', view.acceptanceCriteria],
    ['可解性得分', view.solvabilityScore === null || view.solvabilityScore === undefined ? '' : String(view.solvabilityScore)],
    ['企业承诺', view.commitment],
    ['对应协议', view.agreement],
  ];
  return `
      <article class="card" data-card="${id}">
        <div class="row row--between">
          <h3>${escapeHtml(view.title)}</h3>
          <div class="row">${badges}</div>
        </div>
        ${kvList(details)}
        <div class="divider"></div>
        <h4>六维可解性评估</h4>
        ${solvabilityFormHtml({ pkg, spec })}
        <div class="divider"></div>
        <h4>分级签约</h4>
        ${signoffFormHtml({ pkg, spec })}
        <div class="form-feedback" data-feedback="${id}"></div>
      </article>`;
}

/**
 * 任务卡列表（纯函数）。
 * ⚠️ 空态必须给**可点的下一步**（设计系统 §4）。
 */
export function taskPackagesHtml({ packages = [], spec = null } = {}) {
  const list = Array.isArray(packages) ? packages : [];
  if (!list.length) {
    return emptyState({
      title: '还没有任务卡',
      hint: '企业或组委会提交任务卡后，这里会逐张列出：先做六维可解性评估，再分级签级。',
    });
  }
  return `<div class="stack">${list.map((pkg) => taskPackageCardHtml({ pkg, spec })).join('')}</div>`;
}

/**
 * 提交结果反馈（纯函数）：成功用提示条，失败用错误态（**必须带真能点的「重试」**）。
 *
 * ⚠️ 失败不给重试 = 死路一条（DP-80）⇒ 错误态一律 retry: true，
 *    「重试」按钮由视图侧绑到同一次提交（重跑，不是刷新页面）。
 */
export function feedbackHtml({ tone: t = 'info', title = '', message = '' } = {}) {
  if (t === 'danger' || t === 'error') {
    return errorState({
      message,
      retry: true,
      hint: '点「重试」重跑刚才那一次提交（不会刷新页面，也不会冲掉别的卡已填的内容）。',
    });
  }
  return noticeState({ tone: t, title, items: message ? [message] : [] });
}

// ══════════════════════════════════════════════════════════════════
// 四、提交计划（纯函数）：先把校验做完，再发请求
// ══════════════════════════════════════════════════════════════════

/**
 * 六维评估的提交计划（纯函数）。
 *
 * ⚠️ 服务端对每一维都做 0..max 的整数校验（INVALID_SOLVABILITY_ANSWERS）⇒
 *    前端先拦一道：没打分的维度**不许**发出去（发出去也是 400，白跑一趟）。
 *
 * @returns {{ ok: true, url: string, body: object } | { ok: false, message: string }}
 */
export function planSolvabilitySubmit({ pkg = null, values = {}, vetoes = [], spec = null } = {}) {
  const dims = spec?.dimensions ?? [];
  if (!dims.length) return { ok: false, message: '六维评估规格未就绪，无法提交评估。' };
  const answers = {};
  const missing = [];
  for (const d of dims) {
    const raw = values[d.key];
    const v = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isInteger(v) || v < 0 || v > d.max) {
      missing.push(d.label || d.key);
      continue;
    }
    answers[d.key] = v;
  }
  if (missing.length) return { ok: false, message: `还有维度没打分：${missing.join('、')}。` };
  const declared = (Array.isArray(vetoes) ? vetoes : []).filter((k) => typeof k === 'string' && k);
  const body = { answers: declared.length ? { ...answers, vetoes: declared } : { ...answers } };
  return {
    ok: true,
    url: `/api/task-packages/${encodeURIComponent(pkg?.id ?? '')}/solvability`,
    body,
  };
}

/**
 * 签级 / 退回的提交计划（纯函数）。
 *
 * ⚠️ **退回必须写理由**（本地强制）：理由是退回时唯一能传给企业的信息 ——
 *    服务端在 D 级退回时会出《问题可解性诊断报告》，但「为什么退、怎么补」得有人说。
 * ⚠️ 当前后端的 approve 端点**只读 grade**（不收也不校验理由）⇒ 理由先在前端强制，
 *    并随请求带上（后端补上 reason 字段后即可生效）。
 *
 * @returns {{ ok: true, url: string, body: object } | { ok: false, message: string }}
 */
export function planSignoffSubmit({ pkg = null, action = 'approve', grade = '', reason = '', spec = null } = {}) {
  const tiers = gradeTiers(spec);
  if (!tiers.complete) return { ok: false, message: '档位规格未就绪，无法签级。' };
  const url = `/api/task-packages/${encodeURIComponent(pkg?.id ?? '')}/approve`;
  if (action === 'return') {
    const why = String(reason ?? '').trim();
    if (!why) {
      return { ok: false, message: '退回必须写理由：写清缺什么、怎么补，补齐后可重新提交六维评估。' };
    }
    return { ok: true, url, body: { grade: tiers.return.key, reason: why } };
  }
  const key = String(grade ?? '').trim();
  const hit = tiers.approve.find((g) => g.key === key);
  if (!hit) return { ok: false, message: '请先选择要签的档位。' };
  return { ok: true, url, body: { grade: hit.key } };
}

// ══════════════════════════════════════════════════════════════════
// 五、视图
// ══════════════════════════════════════════════════════════════════

/**
 * 取规则投影（失败一律降级为 null，不抛）。
 * ⚠️ 生产部署默认不挂 /rules/ ⇒ 取不到是**正常**情况，不能让整页因此报错。
 *
 * ⚠️ **P10：优先走服务端投影**（`GET /api/event-info` 的 `solvability` 字段）——
 *    `/rules/` 只有 DEMO_MODE=1 才挂 ⇒ 生产环境这条路是**断的**，
 *    冷启动（一张卡都没评估过）时页面会画不出六维表。
 *    服务端投影由 `src/domain/event-info.js` 的 `buildEventInfo` 产出，
 *    **演示站与正式站同源**（演示适配器 import 的是同一个函数）⇒ 形状与数值天然对齐。
 *    静态规则文件只作为**兜底**（服务端还没上这个投影时的降级路径）。
 */
async function fetchSolvabilityRules(api) {
  try {
    const info = await api.get('/api/event-info');
    const spec = solvabilitySpecFromRules(info?.solvability);
    if (spec) return { rules: info.solvability, source: 'api' };
  } catch {
    // 取不到就退到静态规则文件（下面）
  }
  try {
    const res = await fetch(RULES_URL, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return { rules: await res.json(), source: 'rules' };
  } catch {
    return null;
  }
}

/** 当届届期（公开端点；取不到就不过滤届期）。 */
async function loadEditionId(api) {
  try {
    const criteria = await api.get('/api/registration-criteria');
    return criteria?.editionId ?? '';
  } catch {
    return '';
  }
}

/** 顶部指标（纯函数）。 */
export function statCards(packages) {
  const list = Array.isArray(packages) ? packages : [];
  const count = (status) => list.filter((p) => p?.status === status).length;
  return [
    { label: '任务卡总数', value: list.length, tone: 'brand' },
    { label: '待评估', value: count('submitted') },
    { label: '待签级', value: count('assessed') },
    { label: '已退回', value: count('returned'), tone: 'warn' },
    { label: '已发布', value: count('published'), tone: 'success' },
  ];
}

/** 任务池配比体检（纯函数；数据来自 API 的 mix 字段，不自己算比例）。 */
export function mixPanelHtml(mix) {
  if (!mix) {
    return panel({
      title: '任务池配比体检',
      desc: '体检对象是已发布（进池）的任务卡。',
      body: '<p class="muted">暂无配比体检数据（需要组委会权限且任务卡已发布）。</p>',
    });
  }
  return panel({
    title: '任务池配比体检',
    desc: '体检对象是已发布（进池）的任务卡。',
    body: `${kvList([
      ['任务池卡片', String(mix.total ?? 0)],
      ['自由命题', `${mix.free ?? 0}（${pctText(mix.actualFree)}）`],
      ['企业命题', `${mix.enterprise ?? 0}（${pctText(mix.actualEnterprise)}）`],
      ['结论', mix.ok ? '配比达标' : '配比未达标'],
    ])}
      ${mix.ok ? '' : noticeState({ tone: 'danger', title: '配比未达标', items: mix.errors ?? [], list: true })}`,
  });
}

/**
 * 任务卡分级 / 审批页。
 *
 * @param {object} ctx  { api, navigate, setState, getState }
 * @returns {HTMLElement}
 */
export function renderAdminTaskPackages(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-task-packages';
  const { api } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '任务卡审批',
      sub: '组委会工作台：先做六维可解性评估，再分级签级。评估与签级都即时反馈，失败可重试。',
    })}
    <div id="tp-body">${loadingState({ rows: 3, label: '正在加载任务卡…' })}</div>`;

  const body = wrap.querySelector('#tp-body');
  let packages = [];
  let mix = null;
  let spec = null;

  /** 加载任务卡；错误态的「重试」按钮复用它（真的重跑一次）。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 3, label: '正在加载任务卡…' });
    try {
      const editionId = await loadEditionId(api);
      const query = editionId ? `?editionId=${encodeURIComponent(editionId)}` : '';
      const res = await api.get(`/api/task-packages${query}`);
      packages = res?.items ?? res?.rows ?? [];
      mix = res?.mix ?? null;
      // ⚛️ F16（Critical）：规格**规则投影优先**。
      //    原来这里是「服务端投影优先」⇒ 一旦有任意一张卡被评估过，
      //    **残缺**的包投影（只有档位键、没有分数区间）就盖掉了完整规则
      //    ⇒ `gradeTiers()` 判「档位未就绪」⇒ **签级控件整片消失**
      //    （自锁：评估更多卡也修不好，只有改代码才能恢复）。
      //    两个投影的优先级由 `resolveSolvabilitySpec()` 统一定义（规则投影更完整 ⇒ 有它就用它），
      //    本文件另有一处同名解析器，两者曾**相反** ⇒ 现在只有这一个入口。
      //    生产环境不挂 /rules/（只有 DEMO_MODE=1）⇒ 那时靠服务端投影 ——
      //    服务端现在也把完整档位定义带进 meta.solvability（见 services/taskPackage.js）。
      const fetched = await fetchSolvabilityRules(api);
      spec = resolveSolvabilitySpec({ packages, rules: fetched?.rules ?? null });
    } catch (e) {
      body.innerHTML = errorState({
        message: '任务卡加载失败',
        hint: `接口返回：${e.message}。点「重试」重新加载；若持续失败，请确认服务端已启动且你的账号有组委会权限。`,
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
      return;
    }
    render();
  }

  function render() {
    const source = spec?.source === 'api' ? '服务端投影' : (spec?.source === 'rules' ? '规则文件投影' : '未取得');
    body.innerHTML = `
      <div class="stack">
        <div data-stat-row>${statRow(statCards(packages))}</div>
        <div data-mix>${mixPanelHtml(mix)}</div>
        ${panel({
          title: '任务卡',
          desc: `逐张评估与签级（六维评估表规格来源：${source}）。`,
          body: taskPackagesHtml({ packages, spec }),
        })}
      </div>`;
    for (const card of body.querySelectorAll('[data-card]')) {
      bindCard(card, packages.find((p) => p.id === card.dataset.card));
    }
  }

  /** 绑一张卡的交互。 */
  function bindCard(card, pkg) {
    card.querySelector('[data-action="assess"]')?.addEventListener('click', () => submitAssess(card, pkg));
    card.querySelector('[data-action="approve"]')?.addEventListener('click', () => submitSignoff(card, pkg, 'approve'));
    card.querySelector('[data-action="return"]')?.addEventListener('click', () => submitSignoff(card, pkg, 'return'));
  }

  /** 提交六维评估。 */
  async function submitAssess(card, pkg) {
    const values = {};
    for (const el of card.querySelectorAll('[data-role="dimension"]')) {
      values[el.dataset.dimension] = el.value;
    }
    const vetoes = [];
    for (const el of card.querySelectorAll('[data-role="veto"]')) {
      if (el.checked) vetoes.push(el.dataset.veto);
    }
    const plan = planSolvabilitySubmit({ pkg, values, vetoes, spec });
    if (!plan.ok) {
      setFeedback(card, { tone: 'danger', message: plan.message });
      return;
    }
    await runSubmit(card, pkg, plan, '已提交六维可解性评估');
  }

  /** 提交签级 / 退回。 */
  async function submitSignoff(card, pkg, action) {
    const grade = card.querySelector('[data-role="grade"]')?.value ?? '';
    const reason = card.querySelector('[data-role="reason"]')?.value ?? '';
    const plan = planSignoffSubmit({ pkg, action, grade, reason, spec });
    if (!plan.ok) {
      setFeedback(card, { tone: 'danger', message: plan.message });
      return;
    }
    await runSubmit(card, pkg, plan, action === 'return' ? '已退回出题方' : '已签级');
  }

  /**
   * 真的发一次请求。
   * ⚠️ 成功后**只换掉这一张卡**（不整页刷新）—— 整页刷新会冲掉别的卡已填的评分。
   * ⚠️ 失败必须留下**真能点的重试**：重试的是同一次提交（不是刷新页面）。
   */
  async function runSubmit(card, pkg, plan, successTitle) {
    const feedback = card.querySelector('[data-feedback]');
    const buttons = [...card.querySelectorAll('button[data-action]')];
    for (const b of buttons) b.disabled = true;
    if (feedback) feedback.innerHTML = loadingState({ rows: 1, label: '正在提交…' });
    try {
      const updated = await api.post(plan.url, plan.body);
      const fresh = replaceCard(updated ?? pkg);
      setFeedback(fresh ?? card, { tone: 'success', title: successTitle, message: successMessage(updated ?? pkg) });
      // ⚠️ **提交成功后必须刷新顶部统计与配比体检**：
      //    只换卡片 ⇒ 「待评估 / 待签级 / 已发布」三个计数还停在提交前 ⇒
      //    页面上写着「1 待评估」，而那张卡已经评完了 —— **页面在骗人**。
      //    ⛔ 只刷统计与体检，**不重画卡片列表**（重画会把别的卡已填的评分冲掉）。
      await refreshSummary();
    } catch (e) {
      setFeedback(card, { tone: 'danger', message: `提交失败：${e.message}` });
      card.querySelector('[data-action="retry"]')?.addEventListener('click', () => runSubmit(card, pkg, plan, successTitle));
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  /**
   * 刷新顶部统计与配比体检（提交成功后调用）。
   * ⚠️ 重新拉一次列表是**为了拿服务端口径**（配比体检的对象是已发布的卡，
   *    本地数组算不出它）⇒ 取不到就退回本地状态，**不让一次刷新失败把整页弄坏**。
   */
  async function refreshSummary() {
    try {
      const editionId = await loadEditionId(api);
      const query = editionId ? `?editionId=${encodeURIComponent(editionId)}` : '';
      const res = await api.get(`/api/task-packages${query}`);
      const fresh = res?.items ?? res?.rows ?? [];
      if (fresh.length) packages = fresh;
      mix = res?.mix ?? mix;
    } catch {
      // 保留本地状态，只刷新统计
    }
    const row = body.querySelector('[data-stat-row]');
    if (row) row.innerHTML = statRow(statCards(packages));
    const mixHost = body.querySelector('[data-mix]');
    if (mixHost) mixHost.innerHTML = mixPanelHtml(mix);
  }

  /** 成功提示的正文（数据来自服务端返回值，不自己编口径）。 */
  function successMessage(pkg) {
    const view = packageView(pkg);
    if (view.grade) {
      return `当前档位 ${view.grade}；企业承诺：${view.commitment || '—'}；对应协议：${view.agreement || '—'}。`;
    }
    if (view.solvabilityScore !== null && view.solvabilityScore !== undefined) {
      return `可解性得分 ${view.solvabilityScore}，评估档位 ${view.solvabilityGrade ?? '—'}。`;
    }
    return '已更新。';
  }

  /** 就地把一张卡换成服务端返回的最新状态（其它卡不动）。 */
  function replaceCard(pkg) {
    if (!pkg?.id) return null;
    const idx = packages.findIndex((p) => p.id === pkg.id);
    if (idx >= 0) packages[idx] = pkg;
    else packages = [...packages, pkg];
    let old = null;
    for (const card of body.querySelectorAll('[data-card]')) {
      if (card.dataset.card === pkg.id) { old = card; break; }
    }
    if (!old) return null;
    const holder = document.createElement('div');
    holder.innerHTML = taskPackageCardHtml({ pkg, spec });
    const fresh = holder.firstElementChild;
    if (!fresh) return null;
    old.replaceWith(fresh);
    bindCard(fresh, pkg);
    return fresh;
  }

  /** 就地反馈（成功 / 失败都看得见）。 */
  function setFeedback(card, { tone: t = 'info', title = '', message = '' } = {}) {
    const feedback = card?.querySelector('[data-feedback]');
    if (!feedback) return;
    feedback.innerHTML = feedbackHtml({ tone: t, title, message });
  }

  load();
  return wrap;
}

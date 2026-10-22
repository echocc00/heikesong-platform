// web/views/landing.js — 落地页（首页）：介绍赛事与赛制，吸引报名
// 溯源需求：P9「UI 重构：落地页 + 科技感设计系统」
//          → docs/superpowers/plans/2026-10-22-platform-P9-ui-redesign.md
//
// ⚠️⚠️ **为什么首页要变成落地页**：
//   P7.1 把首页做成了「KPI + 入口卡」的仪表盘 —— 那是**给已登录的人**看的操作面板。
//   但首页是**访客的第一印象**：一个还没注册的人看到 KPI 卡只会困惑
//   （「在榜队伍 12」跟我有什么关系？），看不到「这是什么赛、怎么比、我能不能参加」。
//   ⇒ 现在 `/` = 落地页（公开），原仪表盘迁到 `/dashboard`（登录后可达）。
//     两者**并存**，原总览页一行内容都没删（可逆）。
//
// ⛔ **赛制数字一个字都不许硬编码**：
//   赛段的起止与交付物、评审维度权重、段位表、漏斗、组队规则、名次积分、
//   破同分链、合规红线 —— **全部**来自 `GET /api/event-info`
//   （服务端对 platform/rules/*.json 的白名单投影，见 src/domain/event-info.js）。
//   ⇒ 委员会改 rules/*.json，落地页自动跟着变；前端改数字 = 口径撒谎。
//
// ⛔ **纯逻辑与 IO 分离**：本文件的导出（landingStats / landingSpine / landingWeightBars …）
//    都是纯函数（无 IO、无 DOM）⇒ platform/test/web-landing.test.js 能对**结果本身**断言。
//
// ⚠️ **交互清单**（契约 §1.9）—— 刻意**不做**「每段滚动淡入」与「每卡都浮起」
//    （skill 的 tell 目录把这两条列为俗套）。这里的每一处交互都与**规则**直接相关：
//    ① 赛程脊点选 → 详情切换　② 初赛/决赛同维度**权重联动高亮**
//    ③ 关键数字 count-up　④ Hero 指针辉光　⑤ 段位阶悬停 → 权益高亮
//    ⑥ 漏斗进入视口依次伸展
import { escapeHtml } from '../escape.js';
import { errorState, friendlyError, loadingState } from '../ui.js';

/**
 * 百分比显示：0.10 → 10%，小数一位（权重表里出现过 0.05 这种值）。
 * ⛔ 不许用 `Math.round(v * 100) + '%'`：0.05 → 5%，0.125 → 13%（应为 12.5%）。
 * @param {number} v 0–1 的比例
 * @returns {string} 形如 "12.5%" 的字符串
 */
export function pctText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const p = n * 100;
  const rounded = Math.round(p * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * 关键数字行。
 * ⚠️ **数字与标签必须成对出现**（P7 的 DP-89 教训）：数组长度可变会让解构错位。
 *   ⇒ 这里返回**固定形状**的对象数组，长度由入参决定但每项的字段都齐全。
 *
 * @param {object} input
 * @param {object} input.info        /api/event-info 的返回
 * @param {number|null} input.boardCount  在榜队伍数（滚动总榜行数）
 * @returns {Array<{label:string,value:string|number}>}
 */
export function landingStats({ info = {}, boardCount = null } = {}) {
  const stages = Array.isArray(info.stages) ? info.stages.length : 0;
  const dims = Array.isArray(info?.scoring?.initial?.dimensions) ? info.scoring.initial.dimensions.length : 0;
  const tiers = Array.isArray(info.tiers) ? info.tiers.length : 0;
  const out = [
    { label: '赛段', value: stages },
    { label: '评审维度', value: dims },
    { label: '段位', value: tiers },
    { label: '在榜队伍', value: boardCount === null ? '—' : boardCount },
  ];
  return out;
}

/**
 * 赛程脊的节点。
 * ⚠️ 日期是**相对日序**（rules/schedule.json 里是 "10-01"）⇒ 直接显示，
 *    不许在前端编日历日期（届期起始日服务端才知道，编出来就是假日期）。
 *
 * @param {Array<object>} stages
 * @returns {Array<{key:string,name:string,date:string}>}
 */
export function landingSpineNodes(stages) {
  return (Array.isArray(stages) ? stages : []).map((s) => ({
    key: String(s?.key ?? ''),
    name: String(s?.name ?? ''),
    date: s?.start && s?.end ? `${s.start} – ${s.end}` : String(s?.start ?? ''),
    raw: s,
  }));
}

/**
 * 赛程详情面板（节点被选中时显示的内容）。
 * ⚠️ **交付物必须来自 rules**（rules/schedule.json 的 deliverables）。
 * ⚠️ **不带 note**：rules 里的 note 是内部溯源说明（带文档编号与原文引用）⇒ 不进公开页。
 *    「本赛段不做硬性交付要求」这件事由 hardRequirement（布尔）表达。
 * @param {object} stage
 * @returns {{title:string,items:string[],hardRequirement:boolean}}
 */
export function landingSpineDetail(stage) {
  const s = stage ?? {};
  const items = Array.isArray(s.deliverables) ? s.deliverables.map((d) => String(d)) : [];
  return {
    title: `${s.key ? `${s.key} · ` : ''}${s.name ?? ''}`.trim() || '赛段',
    items,
    hardRequirement: s.hardRequirement !== false,
  };
}

/**
 * 权重条（评分维度）。
 * ⚠️ 权重是赛制里最该被「看见」的数字 ⇒ 给它一条**真实的比例条**，
 *    而不是只写一个百分数。
 * ⚠️ seat（评委席 / 企业席）要显示出来 —— 「谁打这一分」是参赛者最关心的问题之一。
 *
 * @param {Array<object>} dimensions
 * @returns {Array<{key:string,label:string,seat:string,value:number,text:string}>}
 */
export function landingWeightBars(dimensions) {
  return (Array.isArray(dimensions) ? dimensions : []).map((d) => ({
    key: String(d?.key ?? ''),
    label: String(d?.name ?? ''),
    seat: String(d?.seat ?? ''),
    value: Number(d?.weight) || 0,
    text: pctText(d?.weight),
  }));
}

/** 席位的中文名（配置里是英文键）。 */
export function seatLabel(seat) {
  const map = { judge: '评委席', enterprise: '企业席', self: '自评', observer: '观察员' };
  return map[String(seat ?? '')] ?? (seat ? String(seat) : '—');
}

/**
 * 段位阶（ladder）。
 * ⚠️ 权益取自 rules.ranks.benefits；某段位没有权益时**明说**「暂无额外权益」，
 *    不留空白（空白读起来像"没加载出来"）。
 *
 * @param {Array<object>} tiers
 * @returns {Array<{key:string,name:string,requirement:string,benefits:string[]}>}
 */
export function landingLadderSteps(tiers) {
  return (Array.isArray(tiers) ? tiers : []).map((t) => {
    const reqs = [];
    if (Number(t?.minMilestones) > 0) reqs.push(`里程碑 ≥ ${t.minMilestones}`);
    if (t?.requiresDataOrPrototype === true) reqs.push('需数据接入或原型里程碑');
    if (t?.requiresBusinessSignoff === true) reqs.push('需企业签字');
    return {
      key: String(t?.key ?? ''),
      name: String(t?.name ?? ''),
      requirement: reqs.join(' · '),
      benefits: Array.isArray(t?.benefits) ? t.benefits.map((b) => String(b)) : [],
    };
  });
}

/**
 * 漏斗（流）。
 * ⚠️ rate 为 null 表示「比例待定」（rules 里辅导期就是 null）⇒ 显示「—」，
 *    **不许显示 0%**（0% 会被读成「这一届一个人都进不去」）。
 * @param {Array<object>} funnel
 * @returns {Array<{key:string,label:string,rate:number|null,text:string}>}
 */
export function landingFunnelStages(funnel) {
  return (Array.isArray(funnel) ? funnel : []).map((f) => ({
    key: String(f?.key ?? ''),
    label: String(f?.label ?? ''),
    rate: f?.rate === null || f?.rate === undefined ? null : Number(f.rate),
    text: f?.rate === null || f?.rate === undefined ? '—' : pctText(f.rate),
  }));
}

/**
 * 破同分链（有序）。
 * @param {Array<object>} chain
 * @returns {Array<{order:number,label:string,scope:string,scopeText:string}>}
 */
export function landingChainItems(chain) {
  const scopeText = { always: '始终参与', tied_only: '仅同分时', final_only: '仅决赛' };
  return (Array.isArray(chain) ? chain : []).map((c, i) => ({
    order: Number(c?.order) || i + 1,
    label: String(c?.label ?? ''),
    scope: String(c?.scope ?? ''),
    scopeText: scopeText[String(c?.scope ?? '')] ?? '',
  }));
}

/**
 * CTA：访客看到「报名」，已登录看到「工作台」。
 * ⚠️ **每个 href 都必须命中真实路由**（死链闸见 test/web-landing.test.js）。
 * @param {object|null} user
 * @returns {{primary:{href:string,label:string}, secondary:Array<{href:string,label:string}>}}
 */
export function landingCta(user) {
  if (user) {
    return {
      primary: { href: '#/dashboard', label: '进入工作台' },
      secondary: [
        { href: '#/team', label: '我的战队' },
        { href: '#/leaderboard', label: '看榜单' },
      ],
    };
  }
  return {
    primary: { href: '#/apply', label: '立即报名' },
    secondary: [
      { href: '#/leaderboard', label: '看榜单' },
      { href: '#/login', label: '已有账号，登录' },
    ],
  };
}

/** CTA 下方那句说明（按登录态变化）。 */
export function landingCtaNote(user) {
  return user
    ? '登录后可以直接报名、组队、领任务，并实时看到自己队伍的积分与段位。'
    : '报名需填三维度画像问卷（方向 / 能力 / 协作），提交后由组委会分级。';
}

// ─────────────────────────────────────────────────────────────────────
// HTML 片段（纯函数）
// ─────────────────────────────────────────────────────────────────────

/** 关键数字行 HTML。 */
export function landingStatsHtml(stats) {
  return `<div class="landing__stats">${(stats ?? []).map((s) => `
    <div class="landing__stat">
      <p class="landing__stat-value" data-count-to="${escapeHtml(s.value)}">${escapeHtml(s.value)}</p>
      <p class="landing__stat-label">${escapeHtml(s.label)}</p>
    </div>`).join('')}</div>`;
}

/** 赛程脊 HTML。detail 为**初始**（第一个赛段）的详情 ⇒ 无 JS 时也有内容。 */
export function landingSpineHtml(nodes, detail) {
  return `<div class="spine" data-spine>
    ${(nodes ?? []).map((n, i) => `
      <button type="button" class="spine__node${i === 0 ? ' is-active' : ''}"
              data-stage-key="${escapeHtml(n.key)}" aria-pressed="${i === 0 ? 'true' : 'false'}">
        <span class="spine__node-head">
          <span class="spine__node-key">${escapeHtml(n.key)}</span>
          <span class="spine__node-name">${escapeHtml(n.name)}</span>
        </span>
        <span class="spine__node-date">${escapeHtml(n.date)}</span>
      </button>`).join('')}
    <div class="spine__detail" data-spine-detail>${landingSpineDetailHtml(detail)}</div>
  </div>`;
}

/** 权重条 HTML。 */
export function landingWeightBarsHtml(bars) {
  return `<div class="weightbars">${(bars ?? []).map((b) => `
    <div class="weightbar" data-dim-key="${escapeHtml(b.key)}">
      <span class="weightbar__label">${escapeHtml(b.label)}
        <span class="weightbar__seat">${escapeHtml(seatLabel(b.seat))}</span>
      </span>
      <span class="weightbar__track"><span class="weightbar__fill" style="--w:${escapeHtml(b.text)}"></span></span>
      <span class="weightbar__value">${escapeHtml(b.text)}</span>
    </div>`).join('')}</div>`;
}

/** 段位阶 HTML。 */
export function landingLadderHtml(steps) {
  return `<div class="ladder">${(steps ?? []).map((s) => `
    <div class="ladder__step" data-tier-key="${escapeHtml(s.key)}">
      <span class="ladder__key">${escapeHtml(s.key)}</span>
      <span class="ladder__name">${escapeHtml(s.name)}
        ${s.requirement ? `<span class="ladder__req">${escapeHtml(s.requirement)}</span>` : ''}
      </span>
      ${s.benefits.length
        ? `<ul class="ladder__benefits">${s.benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '<span class="ladder__none">暂无额外权益</span>'}
    </div>`).join('')}</div>`;
}

/** 漏斗 HTML。 */
export function landingFunnelHtml(stages) {
  return `<div class="funnel">${(stages ?? []).map((s) => `
    <div class="funnel__stage">
      <span class="funnel__label">${escapeHtml(s.label)}</span>
      <span class="funnel__track"><span class="funnel__bar" style="--w:${escapeHtml(s.rate === null ? '0' : s.text)}"></span></span>
      <span class="funnel__rate">${escapeHtml(s.text)}</span>
    </div>`).join('')}</div>`;
}

/** 破同分链 HTML。 */
export function landingChainHtml(items) {
  return `<div class="chain">${(items ?? []).map((c) => `
    <span class="chain__item">
      <span class="chain__order">${escapeHtml(c.order)}</span>
      <span>${escapeHtml(c.label)}</span>
      ${c.scopeText ? `<span class="chain__scope">${escapeHtml(c.scopeText)}</span>` : ''}
    </span>`).join('')}</div>`;
}

/** 合规红线 HTML。 */
export function landingRedlinesHtml(redlines) {
  return `<ul class="redlines">${(redlines ?? []).map((r) => `
    <li><span class="redlines__mark" aria-hidden="true">▸</span><span>${escapeHtml(r.label)}</span></li>`).join('')}</ul>`;
}

// ─────────────────────────────────────────────────────────────────────
// 交互层
// ─────────────────────────────────────────────────────────────────────

/** 动效是否允许（尊重系统的「减少动态效果」设置）。 */
function motionAllowed() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 数字 count-up。
 * ⚠️ 必须**先显示终值**再动画：从 0 数上去会在读屏与「复制文本」时暴露错误数字。
 *    这里保留终值在 DOM 里（data-count-to），动画只改 textContent。
 */
function countUp(el) {
  const target = Number(el.getAttribute('data-count-to'));
  if (!Number.isFinite(target)) return;
  if (!motionAllowed()) { el.textContent = String(target); return; }
  const duration = 700;
  const start = performance.now?.() ?? 0;
  const step = (now) => {
    const t = Math.min(1, ((now ?? start) - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = String(target);
  };
  requestAnimationFrame(step);
}

/**
 * 挂上落地页的全部交互。
 * ⛔ **每一个交互都必须在「没有对应 API」时安静降级**（测试里没有 DOM / IntersectionObserver）。
 * @param {HTMLElement} wrap 视图根
 * @param {object} ctx      应用上下文
 */
export function wireLanding(wrap, ctx) {
  if (!wrap || typeof wrap.querySelectorAll !== 'function') return;

  // ① 赛程脊点选 → 详情切换
  const spine = wrap.querySelector('[data-spine]');
  const detailBox = wrap.querySelector('[data-spine-detail]');
  const stageMap = new Map((ctx?.landingStages ?? []).map((s) => [String(s.key), s]));
  spine?.addEventListener?.('click', (e) => {
    const btn = e?.target?.closest?.('[data-stage-key]');
    if (!btn || !stageMap.size) return;
    const key = btn.getAttribute('data-stage-key');
    const stage = stageMap.get(key);
    if (!stage) return;
    for (const node of spine.querySelectorAll('[data-stage-key]')) {
      const on = node === btn;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (detailBox) detailBox.innerHTML = landingSpineDetailHtml(landingSpineDetail(stage));
  });

  // ② 初赛 / 决赛**同维度**联动高亮（企业确认 10% → 25% 这类对比，一眼看懂）
  const bars = wrap.querySelectorAll('[data-dim-key]');
  for (const bar of bars) {
    bar.addEventListener?.('mouseenter', () => {
      const key = bar.getAttribute('data-dim-key');
      for (const other of bars) {
        other.classList.toggle('is-active', other.getAttribute('data-dim-key') === key);
      }
    });
    bar.addEventListener?.('mouseleave', () => {
      for (const other of bars) other.classList.remove('is-active');
    });
  }

  // ③ Hero 指针辉光
  const hero = wrap.querySelector('.landing__hero');
  hero?.addEventListener?.('pointermove', (e) => {
    if (!motionAllowed()) return;
    const rect = hero.getBoundingClientRect?.();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    hero.style.setProperty('--glow-x', `${Math.max(0, Math.min(100, x))}%`);
    hero.style.setProperty('--glow-y', `${Math.max(0, Math.min(100, y))}%`);
  });

  // ④ 进入视口：揭示 + 数字 count-up + 漏斗伸展
  const revealables = wrap.querySelectorAll('.reveal, .landing__stat-value, .funnel__bar');
  if (typeof IntersectionObserver === 'undefined') {
    for (const el of revealables) {
      el.classList?.add('is-revealed');
      if (el.classList?.contains('landing__stat-value')) countUp(el);
    }
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      el.classList?.add('is-revealed');
      if (el.classList?.contains('landing__stat-value')) countUp(el);
      io.unobserve(el);
    }
  }, { threshold: 0.15 });
  for (const el of revealables) io.observe(el);
}

/** 赛程详情面板的 HTML（点选后重绘用）。 */
export function landingSpineDetailHtml(detail) {
  const items = (detail?.items ?? []).map((d) => `<li>${escapeHtml(d)}</li>`).join('');
  const hard = detail?.hardRequirement === false
    ? '<p class="spine__detail-note">本赛段不做硬性交付要求</p>'
    : '';
  return `<p class="spine__detail-title">${escapeHtml(detail?.title ?? '')}</p>
    ${items ? `<ul class="spine__detail-list">${items}</ul>` : '<p class="spine__detail-note">本赛段无固定交付物清单。</p>'}
    ${hard}`;
}

// ─────────────────────────────────────────────────────────────────────
// 视图
// ─────────────────────────────────────────────────────────────────────

/**
 * 落地页视图。
 *
 * ⚠️ **同步渲染骨架，异步补数据**：首屏立刻有内容（骨架屏），
 *    弱网下也不白屏；赛制数据到位后再替换。
 * ⚠️ **未登录 100% 可用**：不请求任何需要登录态的端点（契约 M6）。
 *
 * @param {object} ctx 应用上下文（{ api, navigate, setState, getState }）
 * @returns {HTMLElement}
 */
export function renderLanding(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'landing';
  const { user } = ctx.getState();
  const cta = landingCta(user);

  wrap.innerHTML = `
    <section class="landing__hero">
      <div class="landing__hero-grid">
        <div>
          <p class="landing__eyebrow">华东区 · AI 商业黑客松</p>
          <p class="landing__hello">${user
            ? `已登录：<strong>${escapeHtml(user.name || '')}</strong>`
            : '<span class="muted">未登录</span> —— 登录后可报名、组队、领任务'}</p>
          <h1 class="landing__title">把一个真实的商业问题，<br />做成能被企业接住的方案</h1>
          <p class="landing__lede">
            五段赛程、六个评审维度、公开的破同分链 —— 赛制全部写在明处。
            你和评委看的是同一张评分表。
          </p>
          <div class="landing__cta">
            <a class="btn btn--primary" href="${escapeHtml(cta.primary.href)}">${escapeHtml(cta.primary.label)}</a>
            ${cta.secondary.map((s) => `<a class="btn btn--ghost" href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a>`).join('')}
            <p class="landing__cta-note">${escapeHtml(landingCtaNote(user))}</p>
          </div>
          <div id="landing-stats">${loadingState({ rows: 1, label: '正在汇总赛事数据…' })}</div>
        </div>
        <div>
          <p class="landing__eyebrow">赛程</p>
          <div id="landing-spine">${loadingState({ rows: 2, label: '正在加载赛程…' })}</div>
        </div>
      </div>
    </section>

    <section class="landing__section" id="landing-rules">
      <div class="landing__section-head">
        <p class="landing__eyebrow">赛制 · 怎么算</p>
        <h2 class="landing__section-title">每一分从哪来，权重是多少</h2>
        <p class="landing__section-desc">
          初赛与决赛各有一张权重表。把鼠标移到任一维度上，两张表里的同名维度会一起亮起 ——
          权重怎么随赛段变化的，一眼就能看出来。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile">
          <div class="ruletile__head">
            <h3 class="ruletile__title">初赛权重表</h3>
            <span class="ruletile__meta" id="landing-initial-meta"></span>
          </div>
          <div id="landing-initial"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head">
            <h3 class="ruletile__title">决赛权重表</h3>
            <span class="ruletile__meta" id="landing-final-meta"></span>
          </div>
          <div id="landing-final"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">同分怎么决</h3></div>
          <p class="ruletile__desc">破同分链按顺序用，队伍编号是唯一的确定性兜底 —— 同样的输入，永远得出同样的名次。</p>
          <div id="landing-chain"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">过程参与度</h3></div>
          <p class="ruletile__desc">行为分只用于破同分，占评审分比重有上限 —— 认真过程有用，但不会盖过结果。</p>
          <div id="landing-behavior"></div>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">赛程与晋级</p>
        <h2 class="landing__section-title">五段赛程，各有交付物</h2>
        <p class="landing__section-desc">
          点左侧任意赛段看它的交付物。晋级按入围率与决赛名额两个数字定，不靠印象。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile ruletile--wide">
          <div class="ruletile__head">
            <h3 class="ruletile__title">赛段一览</h3>
            <span class="ruletile__meta" id="landing-advancement"></span>
          </div>
          <div id="landing-stage-table"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">名次与积分</h3></div>
          <div id="landing-points"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">晋级口径</h3></div>
          <div id="landing-advancement-detail"></div>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">段位与权益</p>
        <h2 class="landing__section-title">走过的每一步都算数</h2>
        <p class="landing__section-desc">
          段位由里程碑与企业签字决定，权益随段位解锁。
        </p>
      </div>
      <div class="rulegrid">
        <article class="ruletile ruletile--wide">
          <div class="ruletile__head"><h3 class="ruletile__title">段位表</h3></div>
          <div id="landing-ladder"></div>
          <p class="ruletile__desc" id="landing-never" style="margin-top:var(--sp-4)"></p>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">报名与筛选</p>
        <h2 class="landing__section-title">谁会进来看你</h2>
        <p class="landing__section-desc">
          报名先过三维度画像问卷，再进五段漏斗。每一段的比例都写在明处。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">筛选漏斗</h3></div>
          <div id="landing-funnel"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">报名画像</h3></div>
          <div id="landing-profile"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">分级门槛</h3></div>
          <div id="landing-levels"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">组队规则</h3></div>
          <div id="landing-formation"></div>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">合规</p>
        <h2 class="landing__section-title">红线写在报名之前</h2>
        <p class="landing__section-desc">知识产权、数据出境、AI 生成内容标注、身份真实 —— 四条红线，报名即确认。</p>
      </div>
      <div class="rulegrid">
        <article class="ruletile ruletile--wide">
          <div id="landing-redlines"></div>
        </article>
      </div>
    </section>

    <section class="ctaband">
      <div>
        <h2 class="ctaband__title">${user ? '回到你的赛事现场' : '先占一个位置'}</h2>
        <p class="ctaband__desc">${escapeHtml(landingCtaNote(user))}</p>
      </div>
      <div class="ctaband__actions">
        <a class="btn btn--primary" href="${escapeHtml(cta.primary.href)}">${escapeHtml(cta.primary.label)}</a>
        ${cta.secondary.map((s) => `<a class="btn btn--ghost" href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a>`).join('')}
      </div>
    </section>

    <footer class="landing__footer">
      <span>华东区 AI 商业黑客松 · 赛事平台</span>
      <span class="landing__footer-links">
        <a href="#/leaderboard">榜单</a>
        <a href="#/tier">段位榜</a>
        <a href="#/login">登录</a>
      </span>
    </footer>`;

  const statsBox = wrap.querySelector('#landing-stats');
  const spineBox = wrap.querySelector('#landing-spine');

  // ⚠️ 两个请求**并行**，且都不需要登录态（契约 M6）。
  const infoP = ctx.api.get('/api/event-info');
  const boardP = ctx.api.get('/api/leaderboard/rolling').catch(() => null);

  Promise.all([infoP, boardP]).then(([info, board]) => {
    if (!info) return;
    ctx.landingStages = info.stages ?? [];
    const boardCount = board ? (board.rows ?? []).length : null;

    if (statsBox) statsBox.innerHTML = landingStatsHtml(landingStats({ info, boardCount }));

    const nodes = landingSpineNodes(info.stages);
    if (spineBox) {
      spineBox.innerHTML = nodes.length
        ? landingSpineHtml(nodes, landingSpineDetail(nodes[0].raw))
        : '<p class="muted small">赛程尚未公布。</p>';
    }

    const initialBars = landingWeightBars(info.scoring?.initial?.dimensions);
    const finalBars = landingWeightBars(info.scoring?.final?.dimensions);
    const initialBox = wrap.querySelector('#landing-initial');
    const finalBox = wrap.querySelector('#landing-final');
    if (initialBox) initialBox.innerHTML = landingWeightBarsHtml(initialBars);
    if (finalBox) finalBox.innerHTML = landingWeightBarsHtml(finalBars);
    const initialMeta = wrap.querySelector('#landing-initial-meta');
    const finalMeta = wrap.querySelector('#landing-final-meta');
    if (initialMeta) initialMeta.textContent = `${initialBars.length} 个维度`;
    if (finalMeta) finalMeta.textContent = `${finalBars.length} 个维度`;

    const chainBox = wrap.querySelector('#landing-chain');
    if (chainBox) chainBox.innerHTML = landingChainHtml(landingChainItems(info.tiebreak));

    const behaviorBox = wrap.querySelector('#landing-behavior');
    if (behaviorBox) {
      const items = (info.behaviorEvents ?? []).map((e) => `
        <div class="chain__item">
          <span>${escapeHtml(e.label)}</span>
          <span class="chain__order">+${escapeHtml(e.points)}</span>
        </div>`).join('');
      behaviorBox.innerHTML = `<div class="chain">${items}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          行为分在总分里的占比上限 ${escapeHtml(pctText(info.behaviorMaxWeightShare))}，且只用于破同分。
        </p>`;
    }

    const advBox = wrap.querySelector('#landing-advancement');
    if (advBox) {
      advBox.textContent = `入围率 ${pctText(info.advancement?.rate)} · 决赛 TOP ${info.advancement?.finalTopN ?? '—'}`;
    }

    const tableBox = wrap.querySelector('#landing-stage-table');
    if (tableBox) {
      const rows = nodes.map((n) => `
        <tr>
          <td class="mono">${escapeHtml(n.key)}</td>
          <td>${escapeHtml(n.name)}</td>
          <td class="mono">${escapeHtml(n.date)}</td>
          <td>${escapeHtml((n.raw?.deliverables ?? []).join('、') || '—')}</td>
        </tr>`).join('');
      tableBox.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>赛段</th><th>名称</th><th>时间</th><th>交付物</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    }

    const pointsBox = wrap.querySelector('#landing-points');
    if (pointsBox) {
      const sp = info.scoringPoints ?? {};
      const pts = (sp.stagePoints ?? []).map((n) => `<span class="chain__item"><span class="chain__order">${escapeHtml(n)}</span><span>分</span></span>`).join('');
      pointsBox.innerHTML = `<div class="chain">${pts}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          每个赛段只给前 ${escapeHtml(sp.stagePointsOnlyTopN ?? '—')} 名记名次积分；
          MVP 取 ${escapeHtml(sp.mvpStagesCounted ?? '—')} 个赛段的名次积分之和。
        </p>`;
    }

    const advDetailBox = wrap.querySelector('#landing-advancement-detail');
    if (advDetailBox) {
      const a = info.advancement ?? {};
      const vis = info.visibility?.publicFromTier ?? '';
      advDetailBox.innerHTML = `<ul class="redlines">
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>赛段晋级按入围率 <strong>${escapeHtml(pctText(a.rate))}</strong></span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>决赛名额 <strong>TOP ${escapeHtml(a.finalTopN ?? '—')}</strong></span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>榜单分层公开：${vis ? `${escapeHtml(vis)} 段及以上` : '按组委口径'}</span></li>
      </ul>`;
    }

    const ladderBox = wrap.querySelector('#landing-ladder');
    if (ladderBox) ladderBox.innerHTML = landingLadderHtml(landingLadderSteps(info.tiers));
    const neverBox = wrap.querySelector('#landing-never');
    if (neverBox) {
      const never = info.tierNeverUnlocks ?? [];
      neverBox.textContent = never.length
        ? `段位权益不解锁：${never.join('、')} —— 名次与奖金只看评审分。`
        : '';
    }

    const funnelBox = wrap.querySelector('#landing-funnel');
    if (funnelBox) funnelBox.innerHTML = landingFunnelHtml(landingFunnelStages(info.funnel));

    const profileBox = wrap.querySelector('#landing-profile');
    if (profileBox) {
      const dims = (info.registration?.dimensions ?? []).map((d) => `
        <div class="weightbar">
          <span class="weightbar__label">${escapeHtml(d.label)}</span>
          <span class="weightbar__track"><span class="weightbar__fill" style="--w:${escapeHtml(pctText(d.weight))}"></span></span>
          <span class="weightbar__value">${escapeHtml(pctText(d.weight))}</span>
        </div>`).join('');
      profileBox.innerHTML = `<div class="weightbars">${dims}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          三个维度各 5 题、1–5 分制，加权后折算百分制。
        </p>`;
    }

    const levelsBox = wrap.querySelector('#landing-levels');
    if (levelsBox) {
      const levels = (info.registration?.levels ?? []).map((l) => `
        <span class="chain__item">
          <span class="chain__order">${escapeHtml(l.key)}</span>
          <span>${escapeHtml(l.label)}</span>
          <span class="chain__scope">≥ ${escapeHtml(l.minScore)} 分</span>
        </span>`).join('');
      levelsBox.innerHTML = `<div class="chain">${levels}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          分级由问卷分数决定，组委会可复核改级；改级会留痕。
        </p>`;
    }

    const formationBox = wrap.querySelector('#landing-formation');
    if (formationBox) {
      const f = info.formation ?? {};
      formationBox.innerHTML = `<ul class="redlines">
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>每队 ${escapeHtml(f.teamMin)}–${escapeHtml(f.teamMax)} 人</span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>${f.captainMustBeMba ? '队长须为 MBA' : '队长无学历限制'}</span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>每个任务包 ${escapeHtml(f.teamsPerPackageMin)}–${escapeHtml(f.teamsPerPackageMax)} 支队伍</span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>任务包配额：企业命题 ${escapeHtml(pctText(f.enterpriseQuota))} / 自由命题 ${escapeHtml(pctText(f.freeQuota))}</span></li>
      </ul>`;
    }

    const redlinesBox = wrap.querySelector('#landing-redlines');
    if (redlinesBox) redlinesBox.innerHTML = landingRedlinesHtml(info.redLines);

    wireLanding(wrap, ctx);
  }).catch((e) => {
    const message = friendlyError(e, '赛事信息加载失败');
    if (spineBox) {
      spineBox.innerHTML = errorState({ message, hint: '赛程与权重表暂时读不到，刷新页面可重试。' });
      // ⚠️ 全链路可选链：这个 catch 会在**任何** DOM 环境下跑（包括测试用的最小桩），
      //    直接写 `spineBox.querySelector(...)` 会在桩上抛 TypeError
      //    ⇒ 抛出的新异常没人接 ⇒ 变成 unhandledRejection ⇒ **把别的用例搞挂**。
      spineBox.querySelector?.('[data-action="retry"]')?.addEventListener?.('click', () => {
        globalThis.location?.reload?.();
      });
    }
    if (statsBox) statsBox.innerHTML = '';
  });

  return wrap;
}

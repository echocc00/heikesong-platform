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
  const list = Array.isArray(stages) ? stages : [];
  const nodes = list.map((s) => {
    const a = pseudoDay(s?.start);
    const b = pseudoDay(s?.end);
    const days = (a === null || b === null || b < a) ? null : (b - a + 1);
    return {
      key: String(s?.key ?? ''),
      name: String(s?.name ?? ''),
      date: s?.start && s?.end ? `${s.start} – ${s.end}` : String(s?.start ?? ''),
      days,
      daysText: days === null ? '' : `${days} 天`,
      raw: s,
    };
  });
  // ⚠️ **share = 该赛段占整条赛程的天数比例** ⇒ 赛程脊的长度**就是时间占比**，
  //    不是等距列表（P10 签名：条=权重 / 脊=赛程 / 阶=段位 / 流=漏斗，一个语法四种载体）。
  //    日期解析不出来的赛段 share 为 null ⇒ 渲染时退回等分，绝不假装是 0 天。
  const known = nodes.filter((n) => n.days !== null);
  const total = known.reduce((sum, n) => sum + n.days, 0);
  return nodes.map((n) => ({
    ...n,
    share: total > 0 && n.days !== null ? n.days / total : null,
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
  const a = pseudoDay(s.start);
  const b = pseudoDay(s.end);
  const days = (a === null || b === null || b < a) ? null : (b - a + 1);
  return {
    title: `${s.key ? `${s.key} · ` : ''}${s.name ?? ''}`.trim() || '赛段',
    date: s.start && s.end ? `${s.start} – ${s.end}` : '',
    daysText: days === null ? '' : `${days} 天`,
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

/**
 * 权重双轨对照（P10 · M10）。
 *
 * ⚠️ **为什么要双轨**：初赛与决赛各有一张权重表，**分开看两张表是看不出变化的** ——
 *    「企业确认在决赛里从 10% 涨到 25%」这件事，只有把两张表**对齐到同一条轴**上才读得出来。
 *    ⇒ 同一维度**上下两轨**（上=初赛、下=决赛），中间标 Δ（百分点）。
 *
 * ⚠️ **Δ 的算法**：Δ = (决赛 − 初赛) × 100，单位「百分点」（pp）。
 *    0.25 − 0.10 = 0.15000000000000002 ⇒ 必须先 ×100 再四舍五入到一位小数，
 *    否则会渲染成 `+15.000000000000002pp`。
 *    ⛔ **只有两轨都存在时才算 Δ**；只在一侧出现的维度标「仅初赛 / 仅决赛」
 *    （不许拿 0 冒充另一侧 —— 0 会被读成「这一轨权重是 0%」）。
 *
 * @param {Array<object>} initialDimensions 初赛维度（scoring.initial.dimensions）
 * @param {Array<object>} finalDimensions   决赛维度（scoring.final.dimensions）
 * @returns {Array<{key:string,label:string,seat:string,initial:object|null,final:object|null,
 *                  delta:number|null,deltaText:string,direction:string}>}
 */
export function landingWeightTracks(initialDimensions, finalDimensions) {
  const initial = landingWeightBars(initialDimensions);
  const final = landingWeightBars(finalDimensions);
  const order = [];
  const map = new Map();
  for (const b of initial) {
    if (map.has(b.key)) continue;
    order.push(b.key);
    map.set(b.key, { key: b.key, label: b.label, seat: b.seat, initial: b, final: null });
  }
  for (const b of final) {
    const cur = map.get(b.key);
    if (cur) {
      cur.final = b;
      continue;
    }
    order.push(b.key);
    map.set(b.key, { key: b.key, label: b.label, seat: b.seat, initial: null, final: b });
  }
  return order.map((key) => {
    const t = map.get(key);
    const both = Boolean(t.initial && t.final);
    const delta = both ? Math.round((t.final.value - t.initial.value) * 1000) / 10 : null;
    return {
      key: t.key,
      label: t.label,
      seat: t.seat,
      initial: t.initial ? { value: t.initial.value, text: t.initial.text } : null,
      final: t.final ? { value: t.final.value, text: t.final.text } : null,
      delta,
      deltaText: delta === null
        ? (t.initial ? '仅初赛' : '仅决赛')
        : `${delta > 0 ? '+' : ''}${delta}pp`,
      direction: delta === null ? 'none' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    };
  });
}

/** 席位的中文名（配置里是英文键）。 */
export function seatLabel(seat) {
  const map = { judge: '评委席', enterprise: '企业席', self: '自评', observer: '观察员' };
  return map[String(seat ?? '')] ?? (seat ? String(seat) : '—');
}

/**
 * 段位阶（ladder）· 真阶梯（P10 · M8）。
 * ⚠️ 权益取自 rules.ranks.benefits；某段位没有权益时**明说**「暂无额外权益」，
 *    不留空白（空白读起来像"没加载出来"）。
 *
 * ⚠️ **必须按等级升序排序**：rules 里的 `tiers` 数组顺序只是**配置顺序**，
 *    而「阶」的语义是从低到高（D → C → B → A → S）——
 *    不排序的话台阶高度就没法递增，签名元素当场塌掉。
 *    排序键用**规则字段** `minMilestones`（里程碑门槛越高＝等级越高），
 *    同值用 `key` 升序兜底（⛔ 不用 `localeCompare`：它受区域设置影响，不可复算）。
 *
 * ⚠️ `height` 是 **0–1 的比例**（不是像素）：CSS 用它算出台阶实高
 *    （`calc(var(--ladder-base) + var(--h) * var(--ladder-rise))`），
 *    这样「台阶高度」这件事留在样式层，JS 只负责**等级次序**。
 *
 * @param {Array<object>} tiers
 * @returns {Array<{key:string,name:string,requirement:string,benefits:string[],index:number,height:number}>}
 */
export function landingLadderSteps(tiers) {
  const list = Array.isArray(tiers) ? tiers : [];
  const sorted = [...list].sort((a, b) => {
    const am = Number(a?.minMilestones) || 0;
    const bm = Number(b?.minMilestones) || 0;
    if (am !== bm) return am - bm;
    const ak = String(a?.key ?? '');
    const bk = String(b?.key ?? '');
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return 0;
  });
  const n = sorted.length;
  return sorted.map((t, i) => {
    const reqs = [];
    if (Number(t?.minMilestones) > 0) reqs.push(`里程碑 ≥ ${t.minMilestones}`);
    if (t?.requiresDataOrPrototype === true) reqs.push('需数据接入或原型里程碑');
    if (t?.requiresBusinessSignoff === true) reqs.push('需企业签字');
    return {
      key: String(t?.key ?? ''),
      name: String(t?.name ?? ''),
      requirement: reqs.join(' · '),
      benefits: Array.isArray(t?.benefits) ? t.benefits.map((b) => String(b)) : [],
      index: i + 1,
      // 第 i 级占满高的 i/n ⇒ 严格递增，最后一级 = 1
      height: n > 0 ? Math.round(((i + 1) / n) * 1000) / 1000 : 0,
    };
  });
}

/**
 * 漏斗（流）· 真梯形（P10 · M9）。
 * ⚠️ rate 为 null 表示「比例待定」（rules 里辅导期就是 null）⇒ 显示「—」，
 *    **不许显示 0%**（0% 会被读成「这一届一个人都进不去」）。
 * ⚠️ 流失率只在**相邻两段都能算出比例**时才有意义（段间流失）；
 *    上一段比例未知 ⇒ 流失率未知（显示「—」），不许拿 0 顶替。
 * @param {Array<object>} funnel
 * @returns {Array<{key:string,label:string,rate:number|null,text:string,churn:number|null,churnText:string}>}
 */
export function landingFunnelStages(funnel) {
  const list = Array.isArray(funnel) ? funnel : [];
  const rates = list.map((f) => (
    f?.rate === null || f?.rate === undefined ? null : Number(f.rate)
  ));
  return list.map((f, i) => {
    const rate = rates[i];
    const prev = i > 0 ? rates[i - 1] : null;
    const churn = rate !== null && prev !== null && prev > 0 ? 1 - rate / prev : null;
    return {
      key: String(f?.key ?? ''),
      label: String(f?.label ?? ''),
      rate,
      text: rate === null ? '—' : pctText(rate),
      churn,
      churnText: churn === null ? '' : `流失 ${Math.round(churn * 100)}%`,
    };
  });
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

/**
 * 伪日序：把 rules 里的 "MM-DD" 换成可比较的天数。
 * ⚠️ **固定用 2000 年（闰年）**：只求**同一年内**的天数差，年份本身没有意义；
 *    固定闰年是为了让 02-29 也合法（否则 Date.UTC 会滚到 3-01，天数差多算一天）。
 * ⚠️ 解析失败一律返回 null —— 调用方必须能处理「日期不可解析」，
 *    不许拿 0 冒充（0 会被画成「这个赛段一天都没有」）。
 */
function pseudoDay(text) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const t = Date.UTC(2000, month - 1, day);
  const d = new Date(t);
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return Math.floor(t / 86400000);
}

/**
 * 首屏关键事实条（P10）：赛期 / 决赛名额 / 入围率。
 * ⚠️ **全部来自 rules**（schedule.json 的起止日与 advancement）——
 *    落地页一个字都不许硬编码赛事事实（契约 M12）。
 *
 * @param {object} info /api/event-info 的投影
 * @returns {Array<{label:string,value:string}>}
 */
export function landingFacts(info) {
  const stages = Array.isArray(info?.stages) ? info.stages : [];
  const first = stages[0];
  const last = stages[stages.length - 1];
  const adv = info?.advancement ?? {};
  const out = [];
  if (first?.start && last?.end) out.push({ label: '赛期', value: `${first.start} – ${last.end}` });
  if (Number(adv.finalTopN) > 0) out.push({ label: '决赛名额', value: `${adv.finalTopN} 支` });
  if (Number(adv.rate) > 0) out.push({ label: '入围率', value: `${Math.round(Number(adv.rate) * 100)}%` });
  return out;
}

/** 关键事实条 HTML。 */
export function landingFactsHtml(facts) {
  const items = (facts ?? []).filter((f) => f && f.label && f.value);
  if (!items.length) return '';
  return `<dl class="landing__facts">${items.map((f) => `
    <div class="landing__fact">
      <dt class="landing__fact-label">${escapeHtml(f.label)}</dt>
      <dd class="landing__fact-value">${escapeHtml(f.value)}</dd>
    </div>`).join('')}</dl>`;
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
    <div class="spine__track" data-spine-track>
    ${(nodes ?? []).map((n, i) => `
      <button type="button" class="spine__node${i === 0 ? ' is-active' : ''}"
              data-stage-key="${escapeHtml(n.key)}" aria-pressed="${i === 0 ? 'true' : 'false'}"
              ${n.share === null ? '' : `style="--share:${n.share.toFixed(4)}"`}
              title="${escapeHtml(`${n.key} ${n.name}｜${n.date}${n.daysText ? `｜${n.daysText}` : ''}`)}">
        <span class="spine__node-head">
          <span class="spine__node-key">${escapeHtml(n.key)}</span>
          <span class="spine__node-name">${escapeHtml(n.name)}</span>
        </span>
        ${n.daysText ? `<span class="spine__node-days">${escapeHtml(n.daysText)}</span>` : ''}
      </button>`).join('')}
    </div>
    <div class="spine__detail" data-spine-detail>${landingSpineDetailHtml(detail)}</div>
  </div>`;
}

/**
 * 权重双轨对照 HTML（P10 · M10）。
 * ⚠️ **同一个 data-dim-key 挂在三处**（行 + 上轨 + 下轨）：
 *    联动高亮的代码按 `data-dim-key` 相等来判定 ⇒ 悬停一行时，
 *    **上下两轨会同时亮**（契约 M10「联动高亮时两端同时带 is-active」）。
 *    事件只挂在**行**上（不挂轨道）—— 否则从上轨移到下轨时会先 mouseleave 熄灭再亮起，
 *    出现闪烁。
 */
export function landingWeightTracksHtml(tracks) {
  const rows = (tracks ?? []).map((t) => {
    const rail = (side, data) => `
      <div class="wtrack__rail" data-dim-key="${escapeHtml(t.key)}">
        <span class="wtrack__rail-label">${side === 'initial' ? '初赛' : '决赛'}</span>
        <span class="wtrack__track"><span class="wtrack__fill" style="--w:${escapeHtml(data ? data.text : '0%')}"></span></span>
        <span class="wtrack__value">${escapeHtml(data ? data.text : '—')}</span>
      </div>`;
    return `
    <div class="wtrack" data-dim-key="${escapeHtml(t.key)}">
      <div class="wtrack__head">
        <span class="wtrack__label">${escapeHtml(t.label)}</span>
        <span class="wtrack__seat">${escapeHtml(seatLabel(t.seat))}</span>
        <span class="wtrack__delta ${t.direction}">${escapeHtml(t.deltaText)}</span>
      </div>
      ${rail('initial', t.initial)}
      ${rail('final', t.final)}
    </div>`;
  });
  if (!rows.length) return '';
  return `<div class="wtracks">
    <div class="wtracks__legend">
      <span class="wtracks__legend-item"><i class="wtracks__swatch wtracks__swatch--initial"></i>初赛</span>
      <span class="wtracks__legend-item"><i class="wtracks__swatch wtracks__swatch--final"></i>决赛</span>
      <span class="wtracks__legend-item wtracks__legend-item--delta">Δ = 决赛 − 初赛</span>
    </div>
    ${rows.join('')}
  </div>`;
}

/**
 * 段位阶 HTML（真阶梯 · P10 · M8）。
 * @param {Array<object>} steps landingLadderSteps 的结果
 * @param {{currentKey?:string|null,currentLabel?:string}} opts
 *   currentKey 缺省 ⇒ 取**最高一级**（落地页是公开页，没有「我的段位」，
 *   这时高亮的是**目标段位**）。
 */
export function landingLadderHtml(steps, opts = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const keys = list.map((s) => s.key);
  const wanted = opts?.currentKey ?? null;
  const current = wanted && keys.includes(wanted)
    ? wanted
    : (keys.length ? keys[keys.length - 1] : null);
  const label = opts?.currentLabel ?? '目标段位';
  return `<div class="ladder">${list.map((s) => `
    <div class="ladder__step${s.key === current ? ' is-current' : ''}" data-tier-key="${escapeHtml(s.key)}" style="--h:${escapeHtml(String(s.height))}">
      <span class="ladder__block" aria-hidden="true"></span>
      <div class="ladder__body">
        <p class="ladder__title">
          <span class="ladder__key">${escapeHtml(s.key)}</span>
          <span class="ladder__name">${escapeHtml(s.name)}</span>
          ${s.key === current ? `<span class="ladder__badge">${escapeHtml(label)}</span>` : ''}
        </p>
        ${s.requirement ? `<p class="ladder__req">${escapeHtml(s.requirement)}</p>` : ''}
        ${s.benefits.length
          ? `<ul class="ladder__benefits">${s.benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
          : '<span class="ladder__none">暂无额外权益</span>'}
      </div>
    </div>`).join('')}</div>`;
}

/**
 * 漏斗 HTML（真梯形 · P10 · M9）。
 * ⚠️ 流失率**标在两段之间**（漏斗的「段间」）—— 它描述的是「上一段到这一段掉了多少」。
 */
export function landingFunnelHtml(stages) {
  const list = Array.isArray(stages) ? stages : [];
  const parts = [];
  list.forEach((s, i) => {
    if (i > 0 && s.churnText) {
      parts.push(`<p class="funnel__churn">${escapeHtml(s.churnText)}</p>`);
    }
    parts.push(`
    <div class="funnel__stage">
      <span class="funnel__label">${escapeHtml(s.label)}</span>
      <span class="funnel__track"><span class="funnel__bar" style="--w:${escapeHtml(s.rate === null ? '0%' : s.text)};--i:${i}"></span></span>
      <span class="funnel__rate">${escapeHtml(s.text)}</span>
    </div>`);
  });
  return `<div class="funnel">${parts.join('')}</div>`;
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

  // ② 初赛 / 决赛**同维度**联动高亮（P10 · M10：悬停一行 ⇒ **上下两轨同时**亮）
  //    ⚠️ 事件只挂在**行**（.wtrack）上，不挂轨道：
  //    轨道也带 data-dim-key（联动判定靠它），但若轨道上也挂事件，
  //    从上轨移到下轨时会先触发上轨的 mouseleave（熄灭）再触发下轨的 mouseenter（点亮）⇒ 闪烁。
  const bars = wrap.querySelectorAll('.wtrack[data-dim-key]');
  const rails = wrap.querySelectorAll('.wtrack__rail[data-dim-key]');
  for (const bar of bars) {
    bar.addEventListener?.('mouseenter', () => {
      const key = bar.getAttribute('data-dim-key');
      for (const other of bars) {
        other.classList.toggle('is-active', other.getAttribute('data-dim-key') === key);
      }
      for (const rail of rails) {
        rail.classList.toggle('is-active', rail.getAttribute('data-dim-key') === key);
      }
    });
    bar.addEventListener?.('mouseleave', () => {
      for (const other of bars) other.classList.remove('is-active');
      for (const rail of rails) rail.classList.remove('is-active');
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
  //    ⚠️ P10 修正：漏斗条**以前根本不会动** —— 观察器给 `.funnel__bar` 加了
  //    `is-revealed`，但没有任何 CSS 规则认这个组合 ⇒ 「漏斗依次伸展」是句空话。
  //    现在给漏斗条补上 `.reveal`，`is-revealed` 时播放伸展动画，并按 --i 逐段延迟。
  //    ⛔ `.reveal` **不把宽度收到 0**（内容必须永远可见）：
  //    动画用 `animation-fill-mode: both` 播放，播放前仍是满宽 ⇒
  //    未进视口时截图/静态导出是正确的，观察器没触发时也是正确的。
  const revealables = wrap.querySelectorAll('.reveal, .landing__stat-value, .funnel__bar');
  if (typeof IntersectionObserver === 'undefined') {
    for (const el of revealables) {
      el.classList?.add('is-revealed');
      if (el.classList?.contains('landing__stat-value')) countUp(el);
    }
    return;
  }
  for (const el of revealables) {
    if (el.classList?.contains('funnel__bar')) el.classList?.add('reveal');
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
  const when = [detail?.date, detail?.daysText].filter(Boolean).join(' · ');
  return `<p class="spine__detail-title">${escapeHtml(detail?.title ?? '')}</p>
    ${when ? `<p class="spine__detail-when">${escapeHtml(when)}</p>` : ''}
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
          <div id="landing-facts"></div>
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

    <section class="landing__section landing__section--alt" id="landing-rules">
      <div class="landing__section-head">
        <p class="landing__eyebrow">赛制 · 怎么算</p>
        <h2 class="landing__section-title">每一分从哪来，权重是多少</h2>
        <p class="landing__section-desc">
          初赛与决赛各有一张权重表，这里把它们对齐到同一条轴上：上轨是初赛、下轨是决赛，
          中间标出 Δ —— 权重怎么随赛段变化，一眼就能看出来。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile ruletile--wide">
          <div class="ruletile__head">
            <h3 class="ruletile__title">权重双轨对照</h3>
            <span class="ruletile__meta" id="landing-weight-meta"></span>
          </div>
          <div id="landing-weights"></div>
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

    <section class="landing__section" id="landing-track">
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

    <section class="landing__section landing__section--alt">
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

    <section class="landing__section landing__section--alt">
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
    const factsBox = wrap.querySelector('#landing-facts');
    if (factsBox) factsBox.innerHTML = landingFactsHtml(landingFacts(info));

    const nodes = landingSpineNodes(info.stages);
    if (spineBox) {
      spineBox.innerHTML = nodes.length
        ? landingSpineHtml(nodes, landingSpineDetail(nodes[0].raw))
        : '<p class="muted small">赛程尚未公布。</p>';
    }

    // ⚠️ P10：初赛 / 决赛**合成一条双轨**（不是两张独立的表）——
    //    分开两张表看不出「同一维度在赛段之间怎么变」。
    const tracks = landingWeightTracks(info.scoring?.initial?.dimensions, info.scoring?.final?.dimensions);
    const weightsBox = wrap.querySelector('#landing-weights');
    if (weightsBox) weightsBox.innerHTML = landingWeightTracksHtml(tracks);
    const weightMeta = wrap.querySelector('#landing-weight-meta');
    if (weightMeta) {
      weightMeta.textContent = tracks.length
        ? `${tracks.length} 个维度 · 决赛 ${tracks.filter((t) => t.final).length} 个`
        : '';
    }

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

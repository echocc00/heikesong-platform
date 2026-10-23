// web/views/audit-log.js — 审计日志页（组委会：审计与复算 → 审计流水）
//
// 依据：
//   - 设计文档 §9「组委会视角 → **审计与复算**」—— 这一块界面此前**完全不存在**：
//     `GET /api/audit/log` 早就挂在后端，前端却**从来没有调用过它**
//     （同 P11 在清理的「端点已挂、前端从不调用」那一类死端点）。
//   - R-JDG-17（全程留档 6 个月）/ S7 §4.2（赛后 6 个月可查）
//     → `retention` 段必须**显式**说清「可查起始日」，不能让人以为历史记录丢了。
//   - R-AUD-01（每次发榜/计分可复算）→ 审计流水是复算的另一半：谁、什么时候、做了什么。
//   - 全局约束「可见性由 API 裁决」（DP-77）→ 前端不自己判权限，只把 API 的结论原样呈现。
//
// 溯源（端点契约一律以源码为准）：
//   GET /api/audit/log
//     src/http/routes/audit.js → pickFilter(query) → listAuditLog()
//     src/services/audit.js    → { rows, total, retention }
//   rows[i] = { id, actorId, action, entity, entityId, detail, detailParseError, createdAt }
//   ⛔ 没有 `audit:read` 能力点时返回的是 **200 + 空集**（不是 403）：
//      { rows: [], total: 0, retention: null }
//      ⇒ 前端**不能**把「空集」直接等同于「没有记录」（可能是压根没权限）。
//
// ⚠️ **明细必须显式**（★ 关键修正，与服务端 I-1 同一口径）：
//   - `detail === null`          ⇒ 显示「—」（这一条本来就没有明细）
//   - `detailParseError === true` ⇒ **必须显式标出「明细解析失败」**
//     （服务端把坏 JSON 降级成 detail=null + 这个标记）
//     ⚠️ 把它当成「空明细」就是**静默丢证据**：审计轨迹是复盘的唯一凭据。
//   - `detail` 是对象            ⇒ 渲染成**逐项可读**的键值对，不把整坨 JSON 塞进 <code>。
//
// ⛔ 一切用户数据只经 web/escape.js 的 escapeHtml（全站唯一转义入口）。
// ⛔ 只用 styles.css 里**已有**的 class；不写 <style>、不造新类、卡片零外阴影、一屏强调色 ≤3。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  sectionTitle, statRow, tableWrap,
} from '../ui.js';

/** 默认每页条数（服务端 queryAuditLog 的默认 limit 也是 100，这里取更保守的 50）。 */
export const DEFAULT_LIMIT = 50;

/** 每页条数上限（防止一个 query 参数把整张表拉出来）。 */
export const MAX_LIMIT = 200;

/**
 * 把「用户填的原始过滤值」归一成请求参数口径（纯函数）。
 *
 * ⚠️ 只保留服务端 `pickFilter` 认识的白名单字段（action / entity / since / until / limit / offset）
 *    —— 前端拼错字段名不会报错，只会**静默不过滤**（页面看起来"没筛"）。
 * ⛔ `limit` 必须是**有限正整数**（服务端也这么校验：非法 limit 直接被丢掉 ⇒ 页大小悄悄变回默认）。
 */
export function normalizeAuditFilters(raw = {}) {
  const out = { action: '', entity: '', since: '', until: '', limit: DEFAULT_LIMIT, offset: 0 };
  const action = String(raw.action ?? '').trim();
  if (action) out.action = action;
  const entity = String(raw.entity ?? '').trim();
  if (entity) out.entity = entity;
  const since = String(raw.since ?? '').trim();
  if (since) out.since = since;
  const until = String(raw.until ?? '').trim();
  if (until) out.until = until;
  const limit = Number(raw.limit);
  if (Number.isInteger(limit) && limit > 0) out.limit = Math.min(limit, MAX_LIMIT);
  const offset = Number(raw.offset);
  if (Number.isInteger(offset) && offset >= 0) out.offset = offset;
  return out;
}

/**
 * `until` 的日期补齐（纯函数）。
 *
 * ⚠️ 服务端拿 `created_at`（ISO 字符串）做**字典序比较**：
 *    `created_at <= '2026-10-31'` 会把 10-31 当天 00:00 之后的记录**全部排除**。
 *    ⇒ 裸日期的 until 补成当天 23:59:59.999Z（UTC，与 created_at 的口径一致）。
 * ⚠️ `since` 不补：'2026-10-01' <= '2026-10-01T09:00:00.000Z' 本来就成立（字典序），
 *    补成 00:00 只是把隐含约定写明，不改变结果。
 */
export function auditLogUntilParam(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59:59.999Z`;
  return s;
}

/**
 * 过滤参数 → query 串（纯函数，**不带**前导 '?'）。
 *
 * ⚠️ 键的顺序是**固定**的（action → entity → since → until → limit → offset）：
 *    同样的过滤条件必须拼出**同样的**串 ⇒ URL 可比较、可缓存、测试可断言。
 * ⛔ 空值一律**不拼进去**（服务端把 '' 当"不过滤"，拼了也是空转）。
 */
export function auditLogQuery(filters = {}) {
  const f = normalizeAuditFilters(filters);
  const parts = [];
  if (f.action) parts.push(`action=${encodeURIComponent(f.action)}`);
  if (f.entity) parts.push(`entity=${encodeURIComponent(f.entity)}`);
  if (f.since) parts.push(`since=${encodeURIComponent(f.since)}`);
  if (f.until) parts.push(`until=${encodeURIComponent(auditLogUntilParam(f.until))}`);
  parts.push(`limit=${f.limit}`);
  if (f.offset > 0) parts.push(`offset=${f.offset}`);
  return parts.join('&');
}

/**
 * 分页边界（纯函数）。
 *
 * ⚠️ 「到底了」的判据是 `offset + limit >= total`（不是 `offset >= total`）：
 *    最后一页往往**不满** limit 条，用 offset>=total 判会多出一页空白。
 * ⛔ total 为 0 时 pageCount 取 1（不是 0）：页码从 1 开始，「第 1/1 页」比「第 1/0 页」说得通。
 */
export function auditPagination(total, limit, offset) {
  const t = Math.max(0, Number(total) || 0);
  const l = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  const o = Math.max(0, Number(offset) || 0);
  const pageCount = t === 0 ? 1 : Math.ceil(t / l);
  return {
    total: t,
    limit: l,
    offset: o,
    page: Math.floor(o / l) + 1,
    pageCount,
    hasPrev: o > 0,
    hasNext: o + l < t,
    rangeStart: t === 0 ? 0 : o + 1,
    rangeEnd: Math.min(o + l, t),
  };
}

/**
 * 明细值 → 可读文本（纯函数）。
 * ⚠️ 对象 / 数组用 JSON.stringify 压成一行（**转义在调用方做**）。
 */
function formatDetailValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 明细 → 键值对（纯函数）。数组按下标展开；返回 null 表示"不是可展开的容器"。
 */
function detailEntries(detail) {
  if (Array.isArray(detail)) return detail.map((v, i) => [String(i), v]);
  if (detail && typeof detail === 'object') return Object.entries(detail);
  return null;
}

/**
 * 明细单元格（纯函数）。
 *
 * ★ 关键修正：解析失败必须**显式**标出「明细解析失败」。
 *   服务端把坏 JSON 降级成 `detail=null, detailParseError=true`
 *   —— 如果这里按 null 处理成「—」，就等于**把坏掉的审计明细静默吞掉**：
 *   复盘的人看到的是"这条没有明细"，而不是"这条的明细坏了"。
 *
 * @param {unknown} detail            解析后的明细（对象 / 数组 / 字符串 / null）
 * @param {boolean} detailParseError  服务端的解析失败标记
 */
export function auditLogDetailHtml(detail, detailParseError = false) {
  // ⛔ 先判解析失败，再判 null —— 顺序反了就把"坏明细"当成"没有明细"。
  if (detailParseError === true) {
    return `
      <div class="row">${badge('明细解析失败', 'danger')}</div>
      <p class="muted small">这条记录的明细 JSON 解析失败（内容损坏）：记录本身仍在，但明细读不出来。</p>`;
  }
  if (detail === null || detail === undefined) {
    return '<span class="muted">—</span>';
  }
  const entries = detailEntries(detail);
  if (entries === null) {
    return `<span>${escapeHtml(formatDetailValue(detail))}</span>`;
  }
  if (!entries.length) {
    return '<span class="muted">无明细字段</span>';
  }
  // ⚠️ 明细渲染成**逐项可读**的键值对（不是整坨 JSON 塞进 <code>）：
  //    审计流水是要被人读的表格，不是给机器看的 dumps。
  const rows = entries.map(([k, v]) => `
    <div class="kv__row">
      <dt class="kv__key">${escapeHtml(k)}</dt>
      <dd class="kv__val">${escapeHtml(formatDetailValue(v))}</dd>
    </div>`).join('');
  return `<dl class="kv">${rows}</dl>`;
}

/**
 * 一行审计流水（纯函数）。
 * 列：时间 / 操作者 / 动作 / 实体 / 对象 id / 明细
 */
export function auditLogRowHtml(row) {
  const r = row ?? {};
  const actor = r.actorId ? String(r.actorId) : '系统';
  return `<tr>
    <td class="num">${escapeHtml(r.createdAt ?? '—')}</td>
    <td>${escapeHtml(actor)}</td>
    <td><code>${escapeHtml(r.action ?? '—')}</code></td>
    <td>${escapeHtml(r.entity ?? '—')}</td>
    <td>${escapeHtml(r.entityId ?? '—')}</td>
    <td>${auditLogDetailHtml(r.detail, r.detailParseError === true)}</td>
  </tr>`;
}

/**
 * 审计流水表（纯函数）。
 * ⚠️ 表格密度用 `table--compact`：审计流水字段多、条目多，紧凑才一屏能看够。
 */
export function auditLogTableHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return tableWrap(
    '<thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>实体</th><th>对象 id</th><th>明细</th></tr></thead>'
    + `<tbody>${list.map((r) => auditLogRowHtml(r)).join('')}</tbody>`,
    { caption: '审计流水（按时间倒序）', className: 'table--compact' },
  );
}

/**
 * 空集（纯函数）。
 * ⚠️ 空态必须说清**为什么空** + **下一步做什么**（不是白屏）。
 * ⚠️ 还要点破「200 + 空集」这层含义：没有 audit:read 能力点的账号看到的**也是**空集。
 */
export function auditLogEmptyHtml() {
  return emptyState({
    title: '没有匹配的审计记录',
    hint: '当前过滤条件下没有任何审计记录。可以放宽条件试试：清空动作 / 实体、把起止时间挪宽，或加大每页条数。'
      + '（提示：没有 audit:read 能力点的账号拿到的也是同样的空集 —— 若是第一次打开这个页面，先确认权限。）',
  });
}

/**
 * 保留窗口提示（纯函数）。
 * ⛔ `retention` 为 null 时**返回空串**（不编造窗口）—— 服务端没给就是没有，别猜。
 */
export function auditRetentionHtml(retention) {
  if (!retention || typeof retention !== 'object') return '';
  const since = retention.queryableSince ?? '—';
  const months = retention.archiveMonths ?? '—';
  return noticeState({
    tone: 'info',
    title: '保留窗口',
    items: [`本次数据可查起始日 ${since}（${months} 个月）`],
  });
}

/**
 * 指标行（纯函数）。
 * ⛔ 「可查起始日」在 retention 为 null 时显示「—」并注明接口未给出 —— 不编造日期。
 */
export function auditLogStats(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const total = Number(data?.total ?? rows.length) || 0;
  const retention = data?.retention ?? null;
  return [
    { label: '总条数', value: total, tone: 'neutral' },
    { label: '当前页条数', value: rows.length, tone: 'brand' },
    {
      label: '可查起始日',
      value: retention?.queryableSince ?? '—',
      tone: 'neutral',
      hint: retention ? `保留 ${retention.archiveMonths} 个月` : '接口未给出保留窗口',
    },
  ];
}

/**
 * 分页条（纯函数）。
 * ⛔ 到头了就把按钮**禁用**（disabled 属性）—— 光靠不请求，用户不知道是到底了还是坏了。
 */
export function auditLogPagerHtml(pager) {
  const p = pager ?? auditPagination(0, DEFAULT_LIMIT, 0);
  return `
    <div class="row row--between">
      <span class="muted small">第 ${p.rangeStart}-${p.rangeEnd} 条 / 共 ${p.total} 条（第 ${p.page}/${p.pageCount} 页）</span>
      <div class="row">
        <button type="button" class="btn btn--ghost btn--sm" data-action="page-prev"${p.hasPrev ? '' : ' disabled'}>上一页</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="page-next"${p.hasNext ? '' : ' disabled'}>下一页</button>
      </div>
    </div>`;
}

/**
 * 过滤条（纯函数）。
 * ⚠️ 字段名必须与服务端 `pickFilter` 的白名单**逐字一致**（拼错 = 静默不过滤）。
 */
export function auditLogFilterHtml(filters = {}) {
  const f = filters ?? {};
  return `
    <div class="grid grid--3">
      <div class="field">
        <label class="field__label" for="al-action">动作</label>
        <input class="input" id="al-action" type="text" value="${escapeHtml(f.action ?? '')}" placeholder="如 computation.record" />
      </div>
      <div class="field">
        <label class="field__label" for="al-entity">实体</label>
        <input class="input" id="al-entity" type="text" value="${escapeHtml(f.entity ?? '')}" placeholder="如 computation" />
      </div>
      <div class="field">
        <label class="field__label" for="al-since">起始时间</label>
        <input class="input" id="al-since" type="date" value="${escapeHtml(f.since ?? '')}" />
      </div>
      <div class="field">
        <label class="field__label" for="al-until">截止时间</label>
        <input class="input" id="al-until" type="date" value="${escapeHtml(f.until ?? '')}" />
      </div>
      <div class="field">
        <label class="field__label" for="al-limit">每页条数</label>
        <input class="input" id="al-limit" type="number" min="1" max="${MAX_LIMIT}" value="${escapeHtml(String(f.limit ?? DEFAULT_LIMIT))}" />
      </div>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="apply-filter">筛选</button>
      <span class="muted small">过滤条件会作为 query 参数传给 GET /api/audit/log（服务端只认白名单字段）。</span>
    </div>`;
}

/**
 * 从事件里取出 data-action（纯函数）。
 * ⚠️ 兼容两种形态：事件目标**自己**带 data-action（按钮），
 *    或者目标在带 data-action 的祖先里（点按钮里的文字/图标）。
 */
function actionOf(ev) {
  const target = ev?.target;
  if (!target) return null;
  const own = target.dataset?.action;
  if (own) return own;
  return target.closest?.('[data-action]')?.dataset?.action ?? null;
}

/**
 * 审计日志页。
 *
 * ⛔ 权限口径：`GET /api/audit/log` 没有 audit:read 时返回 **200 + 空集**，
 *    所以这里**不会**收到 403 —— 空集由 emptyState 说清（见 auditLogEmptyHtml）。
 * ⚠️ 重试用**事件委托**绑定在 wrap 上（不用固定 id）：errorState() 生成的重试按钮没有 id，
 *    委托到整页容器，按钮标记变化也不会失效。
 *
 * @param {object} ctx { api, navigate, setState, getState, query, params }
 * @returns {Promise<HTMLElement>}
 */
export async function renderAuditLog(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'stack';

  const head = document.createElement('div');
  head.innerHTML = `
    ${pageHead({
      title: '审计日志',
      sub: '审计与复算：谁、在什么时候、对什么做了什么。记录不可编辑 —— 审计轨迹是复盘的唯一凭据。',
    })}
    <div id="al-stats"></div>
    <p class="muted small" id="al-msg">正在加载审计日志…</p>
    <div id="al-state"></div>`;
  wrap.appendChild(head);

  const filters = document.createElement('div');
  filters.id = 'al-filters';
  wrap.appendChild(filters);

  const body = document.createElement('div');
  body.id = 'al-body';
  wrap.appendChild(body);

  const msg = head.querySelector('#al-msg');
  const statsBox = head.querySelector('#al-stats');
  const stateBox = head.querySelector('#al-state');

  // ⚠️ 初始过滤条件从 ctx.query 取（深链可分享）；本视图自己持有后续改动
  //    （不写全局 store：全局 store 会被别的视图读到）。
  let current = normalizeAuditFilters({ ...(ctx?.query ?? {}), offset: 0 });
  let lastTotal = 0;

  filters.innerHTML = panel({
    title: '过滤',
    desc: '按动作、实体与时间范围缩小范围；点「筛选」重新请求。',
    body: auditLogFilterHtml(current),
  });

  // ⚠️ 事件委托：重试 / 筛选 / 翻页都走这一条，不给按钮绑固定 id。
  wrap.addEventListener('click', (ev) => {
    const action = actionOf(ev);
    if (!action) return;
    if (action === 'retry') { void load(); return; }
    if (action === 'apply-filter') { void applyFilters(); return; }
    if (action === 'page-prev') { void turnPage(-1); return; }
    if (action === 'page-next') { void turnPage(1); return; }
  });

  /** 读过滤条上的值 → 归一 → 回到第一页 → 重新请求。 */
  function applyFilters() {
    current = normalizeAuditFilters({
      action: filters.querySelector('#al-action')?.value ?? '',
      entity: filters.querySelector('#al-entity')?.value ?? '',
      since: filters.querySelector('#al-since')?.value ?? '',
      until: filters.querySelector('#al-until')?.value ?? '',
      limit: filters.querySelector('#al-limit')?.value ?? DEFAULT_LIMIT,
      offset: 0,
    });
    void load();
  }

  /** 翻页（纯算术在 auditPagination 里做；这里只负责改 offset 与重载）。 */
  function turnPage(delta) {
    const pager = auditPagination(lastTotal, current.limit, current.offset);
    if (delta < 0 && !pager.hasPrev) return;
    if (delta > 0 && !pager.hasNext) return;
    current = { ...current, offset: Math.max(0, current.offset + delta * current.limit) };
    void load();
  }

  async function load() {
    msg.textContent = '正在加载审计日志…';
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载审计日志…' });
    const qs = auditLogQuery(current);
    let data;
    try {
      data = await ctx.api.get(`/api/audit/log${qs ? `?${qs}` : ''}`);
    } catch (e) {
      msg.textContent = '审计日志加载失败';
      statsBox.innerHTML = '';
      stateBox.innerHTML = errorState({
        message: e.message,
        hint: '日志没拉到。可以重试；若持续失败，检查账号是否还有 audit:read 权限。',
      });
      body.innerHTML = '';
      return;
    }
    stateBox.innerHTML = '';
    render(data);
  }

  /** 把一份 API 返回画成：指标 + 保留窗口 + 表 + 分页。 */
  function render(data) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    lastTotal = Number(data?.total ?? rows.length) || 0;
    const pager = auditPagination(lastTotal, current.limit, current.offset);

    statsBox.innerHTML = statRow(auditLogStats({ ...data, rows }));
    msg.textContent = `共 ${lastTotal} 条审计记录（第 ${pager.page}/${pager.pageCount} 页，本页 ${rows.length} 条）`;

    body.innerHTML = [
      sectionTitle('审计流水'),
      auditRetentionHtml(data?.retention ?? null),
      rows.length ? auditLogTableHtml(rows) : auditLogEmptyHtml(),
      auditLogPagerHtml(pager),
    ].join('');
  }

  await load();
  return wrap;
}

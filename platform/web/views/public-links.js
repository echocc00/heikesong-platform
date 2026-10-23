// web/views/public-links.js — 公开访问令牌管理页（签发 / 列表 / 吊销）
//
// 依据：设计文档 §8「公开榜单 API + 赛程日历 iCal 订阅」。
//   两个公开端点**必须带 token**（公开 ≠ 无鉴权）：
//     GET /api/public/leaderboard?token=…&editionId=…
//     GET /api/public/calendar.ics?token=…&editionId=…
//   但平台**没有任何创建 token 的入口** ⇒ 本页补的就是这条管理链路的界面。
// 溯源：src/http/routes/public-tokens.js（端点）+ src/services/public-api.js（只存哈希的纪律）。
//
// ⛔ 三条与「凭据」有关的纪律：
//   ① **明文只显示这一次**：签发成功后显著展示明文 + 两个公开链接，并明确提示刷新后不可再看
//      （服务端只存 SHA-256，**没有**第二次找回的可能）。
//   ② **列表里没有明文**：列表只给 scope / 届期 / 过期时间 / 短标识（哈希前 8 位）。
//      短标识**不是**可用的令牌（公开接口会再哈希一次比对）—— 页面必须说清这一点，
//      否则用户会拿它去试公开链接，然后以为服务坏了。
//   ③ **明文不进全局 store**：只活在本页这次挂载里（不进 ctx.setState）——
//      全局 store 会被别的视图读到，明文不该到处跑。
//
// ⚠️ **纯函数与 DOM 接线分离**（与 web/views/signoff.js、admin-task-packages.js 同款）：
//   展示模型（tokenRows）、统计（tokenStats）、HTML 渲染（tokenTableHtml / issueFormHtml /
//   issuedTokenHtml / publicUrlHtml）全部是**无 IO、无 DOM**的纯函数 ⇒ 可以直接对结果做断言。
//
// ⚠️ **视觉纪律**：颜色只走设计令牌（badge 的 tone / btn--primary / btn--danger / panel 的 tone），
//   **零外阴影**（卡片用 .card / .panel —— 它们的材质是「底色差 + 顶边高光」，没有外阴影），
//   一屏强调色 ≤ 3（brand / success / danger），**不新造 CSS 类**、不写 <style>。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  statRow, tableWrap, sectionTitle, workbench,
} from '../ui.js';

/**
 * scope → 中文标签。
 * ⚠️ 这些值是**接口契约值**（leaderboard / calendar / all），不是赛制规则 ——
 *    与 web/views/signoff.js 的 SEAT_LABELS、admin-task-packages.js 的 STATUS_LABELS 同款先例。
 *    认不出来的值原样透出（不猜、不吞）；服务端仍会用 rules.pools.publicScopes 复核。
 */
const SCOPE_LABELS = {
  leaderboard: '公开榜单',
  calendar: '赛程日历',
  all: '两个公开端点',
};

/** scope 的中文标签（认不出来就原样显示）。 */
export function scopeLabel(scope) {
  const key = String(scope ?? '');
  return SCOPE_LABELS[key] ?? key;
}

/** 时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。 */
function fmtTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 令牌列表的展示模型（纯函数）。
 * ⚠️ **形状恒定**：每一行字段集合完全一致，缺值一律空串 / false ——
 *    模板里出现 undefined 会渲染成字符串 "undefined"。
 *
 * @param {object|Array} raw GET /api/public/tokens 的返回（或它的 items 数组）
 * @returns {Array<object>}
 */
export function tokenRows(raw) {
  const list = Array.isArray(raw?.items)
    ? raw.items
    : (Array.isArray(raw) ? raw : []);
  return list.map((item) => ({
    id: String(item?.id ?? ''),
    scope: String(item?.scope ?? ''),
    scopeLabel: scopeLabel(item?.scope),
    editionId: String(item?.editionId ?? ''),
    expiresAt: String(item?.expiresAt ?? ''),
    createdAt: String(item?.createdAt ?? ''),
    tokenHint: String(item?.tokenHint ?? ''),
    expired: item?.expired === true,
  }));
}

/**
 * 顶部指标（纯函数）：总数 / 仍然有效 / 已过期。
 * ⚠️ 强调色只有两处（success / warn），其余走中性 ⇒ 一屏强调色不超标。
 */
export function tokenStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const expired = list.filter((r) => r.expired).length;
  return [
    { label: '已签发令牌', value: String(list.length), tone: 'neutral' },
    { label: '仍然有效', value: String(list.length - expired), tone: 'success' },
    { label: '已过期', value: String(expired), tone: expired > 0 ? 'warn' : 'neutral' },
  ];
}

/**
 * 一行的「吊销」单元格（纯 HTML）。
 * ⚠️ **吊销是破坏性动作 ⇒ 内联二次确认**（不用 window.confirm，理由同 web/views/publish.js）：
 *   第一次点「吊销」只展开确认块，第二次点「确认吊销」才发 DELETE。
 * ⚠️ 确认块用**裸 div + hidden 属性**：`.row` 这类布局类会设 display，
 *   会把 UA 的 `[hidden]{display:none}` 盖掉（styles.css 里 signoff__confirm[hidden] 就是为这个补的）——
 *   裸 div 没有任何 author 规则设 display ⇒ hidden 真的生效。
 */
function revokeCellHtml(row) {
  const id = escapeHtml(row.id);
  return `<div>
      <button type="button" class="btn btn--danger btn--sm" data-action="revoke-request" data-id="${id}">吊销</button>
      <div hidden data-revoke-confirm="${id}">
        <div class="row">
          <span class="small muted">吊销后这枚令牌立刻失效，用它访问公开接口会得到 403。</span>
          <button type="button" class="btn btn--danger btn--sm" data-action="revoke-confirm" data-id="${id}">确认吊销</button>
          <button type="button" class="btn btn--ghost btn--sm" data-action="revoke-cancel" data-id="${id}">取消</button>
        </div>
      </div>
    </div>`;
}

/**
 * 已有令牌表格（纯 HTML）。
 * ⚠️ 空态是 **200 + 空集**（不是错误）：一句「还没有令牌」+ 下一步（去上面签发）。
 */
export function tokenTableHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return emptyState({
      title: '还没有签发过公开令牌',
      hint: '公开榜单与赛程日历接口都必须带 token。在上方签发一枚，把链接发给需要看榜单的人。',
    });
  }
  const body = list.map((row) => `
            <tr>
              <td>${badge(row.scopeLabel, 'brand')}</td>
              <td class="mono small">${escapeHtml(row.editionId)}</td>
              <td class="num">${escapeHtml(fmtTime(row.expiresAt))}</td>
              <td class="mono">${escapeHtml(row.tokenHint)}</td>
              <td>${row.expired ? badge('已过期', 'danger') : badge('有效', 'success')}</td>
              <td>${revokeCellHtml(row)}</td>
            </tr>`).join('');
  return tableWrap(`
            <thead>
              <tr>
                <th>权限范围</th><th>届期</th><th>过期时间</th><th>短标识</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>`, {
    caption: '已签发的公开访问令牌',
    className: 'table table--compact',
  });
}

/**
 * 「签发新令牌」表单（纯 HTML）。
 * ⚠️ 表单字段名逐字照后端：editionId / scope / ttlDays / expiresAt（src/http/routes/public-tokens.js）。
 *    这里只给 scope 与 ttlDays —— 届期不给就是「当届」（后端按 pickCurrentEdition 解析）。
 */
export function issueFormHtml() {
  return `<div class="stack">
          <label class="field" for="pl-scope">
            <span class="field__label">权限范围</span>
            <select class="select" id="pl-scope" data-field="scope">
              <option value="leaderboard">公开榜单（/api/public/leaderboard）</option>
              <option value="calendar">赛程日历（/api/public/calendar.ics）</option>
              <option value="all" selected>两个公开端点都要</option>
            </select>
            <p class="field__hint">范围越小越好：只要榜单就别给日历。</p>
          </label>
          <label class="field" for="pl-ttl">
            <span class="field__label">有效期（天）</span>
            <input class="input" id="pl-ttl" data-field="ttlDays" type="number" min="1" step="1" placeholder="30" />
            <p class="field__hint">留空按规则里的默认天数；令牌过期后公开接口一律返回 403。</p>
          </label>
          <div class="row">
            <button type="button" class="btn btn--primary btn--sm" data-action="issue">签发新令牌</button>
          </div>
          <div class="form-feedback" data-feedback="issue"></div>
        </div>`;
}

/**
 * 两个公开链接（纯 HTML）。
 * ⚠️ 链接里的 token 与 editionId 都经 encodeURIComponent ——
 *    token 是服务端生成的 base64url，editionId 是 uuid，但**仍按不可信输入处理**。
 * ⚠️ href 的协议是固定的相对路径（/api/…）⇒ 不存在 javascript: 注入面。
 */
export function publicUrlHtml({ token = '', editionId = '' } = {}) {
  const t = encodeURIComponent(String(token ?? ''));
  const e = encodeURIComponent(String(editionId ?? ''));
  const leaderboard = `/api/public/leaderboard?token=${t}&editionId=${e}`;
  const calendar = `/api/public/calendar.ics?token=${t}&editionId=${e}`;
  return `<div class="stack">
          <div>
            <p class="field__label">公开榜单</p>
            <p><code class="mono">${escapeHtml(leaderboard)}</code></p>
            <a class="btn btn--ghost btn--sm" href="${escapeHtml(leaderboard)}" target="_blank" rel="noopener noreferrer">打开榜单接口</a>
          </div>
          <div>
            <p class="field__label">赛程日历（iCal）</p>
            <p><code class="mono">${escapeHtml(calendar)}</code></p>
            <a class="btn btn--ghost btn--sm" href="${escapeHtml(calendar)}" target="_blank" rel="noopener noreferrer">打开日历订阅</a>
          </div>
        </div>`;
}

/**
 * 刚签发的令牌（纯 HTML）：**显著**展示明文 + 两个公开链接 + 「只显示这一次」的提示。
 * ⛔ 明文只在这里出现一次；服务端只存哈希 ⇒ 页面必须说清「丢了只能重发」。
 */
export function issuedTokenHtml(issued = {}) {
  const token = String(issued?.token ?? '');
  const scope = String(issued?.scope ?? '');
  const editionId = String(issued?.editionId ?? '');
  const expiresAt = String(issued?.expiresAt ?? '');
  return `<div class="stack">
          ${noticeState({
    tone: 'success',
    title: '令牌已签发',
    items: [
      '明文只显示这一次：离开或刷新本页就再也看不到了（服务端只存哈希，不能找回）。',
      '请立刻复制下面的令牌与链接，交给需要访问公开榜单的人。',
    ],
  })}
          <div>
            <p class="field__label">明文令牌</p>
            <p><code class="mono">${escapeHtml(token)}</code></p>
          </div>
          <div>
            <p class="field__label">权限范围</p>
            <p>${badge(scopeLabel(scope), 'brand')}
              <span class="muted small">届期 ${escapeHtml(editionId)} · 过期于 ${escapeHtml(fmtTime(expiresAt))}</span></p>
          </div>
          ${sectionTitle('两个公开链接')}
          ${publicUrlHtml({ token, editionId })}
        </div>`;
}

/**
 * 公开访问令牌管理页。
 *
 * ⚠️ **局部重绘**（不整页刷新）：列表刷新只换列表与指标，
 *    签发表单里已填的内容**不会被冲掉**（DP-81：不许整页刷新 / 不许冲掉已填内容）。
 * ⚠️ **错误态必须带真能点的重试**（DP-80）：每个错误态外面包一层 `[data-retry]`
 *    ⇒ 事件委托能认出「这次要重跑哪一步」，点「重试」是真的重跑那一步。
 *
 * @param {object} ctx { api, navigate, setState, getState, query, params }
 * @returns {Promise<HTMLElement>}
 */
export async function renderPublicLinks(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'stack publinks-view';
  const api = ctx.api;
  let items = [];
  // ⛔ 明文只活在这一次的挂载期里（**不进 ctx.setState**：全局 store 会被别的视图读到）。
  let issued = null;
  const editionFilter = ctx.query?.editionId ? String(ctx.query.editionId) : '';

  // ⚠️ **P12：页面形状 = 操作台（左轨签发 + 右画布看结果）**。
  //    改版前是「head + 指标 + 两张面板」一字排开 ⇒ 签发表单与令牌列表同权重，
  //    而它们其实是**一对**关系：左轨是动作，右画布是动作的结果。
  //    ⛔ 三个挂载点（data-stats / data-issued / data-list）**必须保留** ——
  //    局部重绘靠它们定位（DP-81：不许整页刷新、不许冲掉已填内容）。
  wrap.innerHTML = [
    pageHead({
      title: '公开访问链接',
      sub: '公开榜单与赛程日历接口都必须带 token；在这里签发、查看与吊销。',
    }),
    workbench({
      rail: panel({
        title: '签发新令牌',
        desc: '明文只在签发时显示一次；库里只存哈希，丢了只能重发一枚。',
        body: issueFormHtml(),
      }),
      canvas: [
        '<div data-issued></div>',
        `<div data-stats>${statRow(tokenStats(items))}</div>`,
        panel({
          title: '已签发的令牌',
          desc: '短标识只是哈希的前几位，用来分辨是哪一枚 —— 它不是可用的令牌。',
          body: '<div data-list></div>',
        }),
      ].join(''),
    }),
  ].join('');

  const listHost = () => wrap.querySelector('[data-list]');
  const statsHost = () => wrap.querySelector('[data-stats]');
  const issuedHost = () => wrap.querySelector('[data-issued]');
  const feedbackSlot = () => wrap.querySelector('[data-feedback]');

  /** 重新拉列表并重绘列表 + 指标（失败时给带重试的错误态）。 */
  async function refreshList() {
    const host = listHost();
    if (host) host.innerHTML = loadingState({ rows: 3, label: '正在加载令牌…' });
    try {
      const query = editionFilter ? `?editionId=${encodeURIComponent(editionFilter)}` : '';
      const res = await api.get(`/api/public/tokens${query}`);
      items = tokenRows(res);
      const list = listHost();
      if (list) list.innerHTML = tokenTableHtml(items);
      const stats = statsHost();
      if (stats) stats.innerHTML = statRow(tokenStats(items));
    } catch (e) {
      const list = listHost();
      if (list) {
        list.innerHTML = `<div data-retry="list">${errorState({
          message: e?.message ?? '加载失败',
          hint: '点「重试」重新加载令牌列表。',
        })}</div>`;
      }
    }
  }

  /** 签发一枚新令牌（成功后显著展示明文 + 两个公开链接）。 */
  async function submitIssue() {
    const slot = feedbackSlot();
    const scope = wrap.querySelector('[data-field="scope"]')?.value ?? 'all';
    const ttlRaw = String(wrap.querySelector('[data-field="ttlDays"]')?.value ?? '').trim();
    const payload = { scope };
    if (ttlRaw !== '') {
      const ttl = Number(ttlRaw);
      // ⚠️ 本地先拦一道：Number('abc') 是 NaN ⇒ JSON 序列化后是 null ⇒ 后端会**静默**按默认天数签发。
      if (!Number.isInteger(ttl) || ttl <= 0) {
        if (slot) {
          slot.innerHTML = `<div data-retry="issue">${errorState({
            message: '有效期必须是正整数（天）',
            hint: '留空则按规则里的默认天数。',
          })}</div>`;
        }
        return;
      }
      payload.ttlDays = ttl;
    }
    if (slot) slot.innerHTML = loadingState({ rows: 1, label: '正在签发…' });
    try {
      const res = await api.post('/api/public/tokens', payload);
      issued = {
        token: String(res?.token ?? ''),
        scope: String(res?.scope ?? scope),
        editionId: String(res?.editionId ?? ''),
        expiresAt: String(res?.expiresAt ?? ''),
      };
      const host = issuedHost();
      if (host) {
        host.innerHTML = panel({
          title: '刚签发的令牌（明文只显示这一次）',
          tone: 'success',
          body: issuedTokenHtml(issued),
        });
      }
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已签发',
          items: ['明文令牌已显示在上方；离开本页后无法再次查看。'],
        });
      }
      await refreshList();
    } catch (e) {
      if (slot) {
        slot.innerHTML = `<div data-retry="issue">${errorState({
          message: e?.message ?? '签发失败',
          hint: '点「重试」按当前填写重新签发一次。',
        })}</div>`;
      }
    }
  }

  /** 吊销一枚令牌（失败时给带重试的错误态，重试的是**吊销**这一步）。 */
  async function revoke(id) {
    const host = listHost();
    if (host) host.innerHTML = loadingState({ rows: 2, label: '正在吊销…' });
    try {
      await api.del(`/api/public/tokens/${encodeURIComponent(id)}`);
      await refreshList();
    } catch (e) {
      const list = listHost();
      if (list) {
        list.innerHTML = `<div data-retry="revoke" data-id="${escapeHtml(id)}">${errorState({
          message: e?.message ?? '吊销失败',
          hint: '点「重试」重新吊销这枚令牌。',
        })}</div>`;
      }
    }
  }

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘（反馈位 / 确认块）不会丢监听。
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      // ⚠️ 重试要重跑**刚才失败的那一步**：靠外层 [data-retry] 标记区分（list / issue / revoke）。
      const scope = btn.closest('[data-retry]');
      const kind = scope?.dataset?.retry ?? 'list';
      if (kind === 'issue') { await submitIssue(); return; }
      if (kind === 'revoke') { await revoke(scope.dataset.id ?? ''); return; }
      await refreshList();
      return;
    }
    if (action === 'issue') { await submitIssue(); return; }
    if (action === 'revoke-request') {
      const id = btn.dataset.id ?? '';
      // ⚠️ 用 dataset 逐个比对而不是拼 CSS 选择器 —— id 是哈希，但不必冒选择器转义的险。
      for (const box of wrap.querySelectorAll('[data-revoke-confirm]')) {
        if (box.dataset.revokeConfirm === id) box.hidden = false;
      }
      return;
    }
    if (action === 'revoke-cancel') {
      const id = btn.dataset.id ?? '';
      for (const box of wrap.querySelectorAll('[data-revoke-confirm]')) {
        if (box.dataset.revokeConfirm === id) box.hidden = true;
      }
      return;
    }
    if (action === 'revoke-confirm') {
      await revoke(btn.dataset.id ?? '');
      return;
    }
  });

  // ⚠️ 不 await：先把骨架渲染出来，列表随后自己填上（避免白屏）。
  refreshList();
  return wrap;
}

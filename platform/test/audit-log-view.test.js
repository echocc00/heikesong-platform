// test/audit-log-view.test.js — 审计日志页（组委会：审计与复算 → 审计流水）
//
// 依据：设计文档 §9「组委会视角 → **审计与复算**」
//   + R-JDG-17（全程留档 6 个月）/ S7 §4.2（赛后 6 个月可查）
//   + R-AUD-01（每次发榜/计分可复算）
// 溯源：GET /api/audit/log
//   src/http/routes/audit.js → pickFilter(query) → listAuditLog()
//   src/services/audit.js    → { rows, total, retention }
//   rows[i] = { id, actorId, action, entity, entityId, detail, detailParseError, createdAt }
//
// ⚠️ 这组用例**为什么必须存在**：
//   后端读口早就存在，前端却**从来没有调用过它**（死端点：端点已挂、界面从无）。
//   ⇒ 这组用例钉住四件事：
//     ① 前端真的会调它，而且**参数拼对了**（拼错字段名 = 静默不过滤，服务端不报错）；
//     ② **坏数据显式暴露**（detailParseError 不能被当成空明细静默吞掉）；
//     ③ 空集 / 保留窗口 / 分页边界都**说得清**（不是白屏、不是猜）；
//     ④ 用户数据**必须转义**（明细是服务端存下来的 JSON，可能带 HTML）。
//
// ⛔ 零依赖、零构建、node:test + ESM；DOM 用**最小桩**（不引 jsdom），
//    手法与 platform/test/admin-appeals.test.js 同款。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIMIT,
  auditLogDetailHtml,
  auditLogEmptyHtml,
  auditLogPagerHtml,
  auditLogQuery,
  auditLogRowHtml,
  auditLogStats,
  auditLogTableHtml,
  auditPagination,
  auditRetentionHtml,
  auditLogUntilParam,
  normalizeAuditFilters,
  renderAuditLog,
} from '../web/views/audit-log.js';

// ─────────────────────────────────────────────────────────────────────────
// 最小 DOM 桩
//
// ⚠️ 只实现视图用到的那几个方法（innerHTML / querySelector(#id) / 事件），
//    手法与 platform/test/admin-appeals.test.js 同款：够测行为，不做真解析。
// ─────────────────────────────────────────────────────────────────────────

function mk(tag) {
  const el = {
    tagName: tag,
    className: '',
    id: '',
    children: [],
    handlers: {},
    dataset: {},
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    _text: '',
    _html: '',
    _htmlIds: [],
    _byId: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this._htmlIds = [...String(v).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      // ⚠️ 真浏览器里赋 innerHTML 会清掉原有子节点 —— 桩必须等价。
      this.children = [];
    },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    // ⚠️ 视图用 closest() 兜住「点在按钮里的文字上」的情况；桩里没有祖先 ⇒ 返回 null。
    closest() { return null; },
    querySelector(sel) {
      if (!sel.startsWith('#')) return null;
      const id = sel.slice(1);
      // ⚠️ innerHTML 里出现的 id ⇒ 造一个**缓存**的合成节点
      //    （同一个 id 每次拿到同一个对象 ⇒ 测试设的 .value 视图读得到）。
      if (this._htmlIds.includes(id)) {
        if (!this._byId[id]) { const s = mk('div'); s.id = id; this._byId[id] = s; }
        return this._byId[id];
      }
      for (const c of this.children) {
        if (c.id === id) return c;
        const hit = c.querySelector?.(sel);
        if (hit) return hit;
      }
      return null;
    },
  };
  return el;
}

function installDom() {
  globalThis.document = { createElement: (tag) => mk(tag) };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ─────────────────────────────────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────────────────────────────────

const RETENTION = { archiveMonths: 6, queryableSince: '2026-04-23T00:00:00.000Z' };

/** 一条审计记录（形状以 src/services/audit.js 的 listAuditLog 为准）。 */
function row(i, over = {}) {
  return {
    id: `al-${i}`,
    actorId: 'u_admin',
    action: 'computation.record',
    entity: 'computation',
    entityId: `cmp_${i}`,
    detail: { ruleVersion: '2026-10-20', revision: i },
    detailParseError: false,
    createdAt: '2026-10-22T00:00:00.000Z',
    ...over,
  };
}

/**
 * 假 api：按请求里的 limit / offset 切片（这样翻页是真的在翻，不是一页到底）。
 * ⚠️ 记下每一次请求路径 —— 端点与 query 都从这里断言。
 */
function makeApi({ rows = [row(0), row(1), row(2)], retention = RETENTION } = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      const limit = Number(q.get('limit') ?? DEFAULT_LIMIT);
      const offset = Number(q.get('offset') ?? 0);
      return { rows: rows.slice(offset, offset + limit), total: rows.length, retention };
    },
  };
}

/** 触发一次委托点击（视图用事件委托，不给按钮绑固定 id）。 */
function click(wrap, action) {
  wrap.handlers.click[0]({ target: { dataset: { action } } });
}

// ═════════════════════════════════════════════════════════════════════════
// 一、纯函数：过滤参数拼装
// ═════════════════════════════════════════════════════════════════════════

test('过滤参数真的进了 query（拼装纯函数断言）', () => {
  const q = auditLogQuery({
    action: 'computation.record',
    entity: 'computation',
    since: '2026-10-01',
    until: '2026-10-31',
    limit: 25,
    offset: 100,
  });
  assert.ok(q.includes('action=computation.record'), `动作没进 query：${q}`);
  assert.ok(q.includes('entity=computation'), `实体没进 query：${q}`);
  assert.ok(q.includes('since=2026-10-01'), `起始时间没进 query：${q}`);
  assert.ok(q.includes('until=2026-10-31'), `截止时间没进 query：${q}`);
  assert.ok(q.includes('limit=25'), `每页条数没进 query：${q}`);
  assert.ok(q.includes('offset=100'), `翻页偏移没进 query：${q}`);
});

test('query 拼装：空值不拼（空条件等于服务端「不过滤」，拼了也是空转）', () => {
  assert.equal(auditLogQuery({}), `limit=${DEFAULT_LIMIT}`, '空过滤只剩页大小');
  const q = auditLogQuery({ action: '  ', entity: '', since: '', until: '' });
  assert.ok(!q.includes('action='), `空动作不该拼：${q}`);
  assert.ok(!q.includes('entity='), `空实体不该拼：${q}`);
  assert.ok(!q.includes('since='), `空起始时间不该拼：${q}`);
  assert.ok(!q.includes('offset='), 'offset 为 0 不拼（第一页不用带）');
});

test('query 拼装：非法 limit 归一到默认（服务端会静默丢弃非法 limit ⇒ 页大小悄悄变）', () => {
  const n = normalizeAuditFilters({ limit: 'abc', offset: -5, action: '  x  ' });
  assert.equal(n.limit, DEFAULT_LIMIT, '非法 limit ⇒ 默认值');
  assert.equal(n.offset, 0, '负 offset ⇒ 0');
  assert.equal(n.action, 'x', '动作要 trim');
  assert.equal(normalizeAuditFilters({ limit: 9999 }).limit, 200, 'limit 要封顶');
});

test('query 拼装：until 的裸日期补成当天末尾（否则当天的记录会被排除掉）', () => {
  assert.equal(auditLogUntilParam('2026-10-31'), '2026-10-31T23:59:59.999Z');
  assert.equal(auditLogUntilParam('2026-10-31T10:00:00Z'), '2026-10-31T10:00:00Z', '已是完整时间戳就不动');
  assert.equal(auditLogUntilParam(''), '');
});

// ═════════════════════════════════════════════════════════════════════════
// 二、纯函数：明细渲染
// ═════════════════════════════════════════════════════════════════════════

test('明细 JSON 被渲染成逐项可读（键名与值都出现），而不是整坨 JSON', () => {
  const html = auditLogDetailHtml({ ruleVersion: '2026-10-20', revision: 3 }, false);
  assert.ok(html.includes('ruleVersion'), `明细键名没出现：${html}`);
  assert.ok(html.includes('2026-10-20'), `明细值没出现：${html}`);
  assert.ok(html.includes('kv__row'), `明细要逐项列出：${html}`);
  assert.ok(!html.includes('{"ruleVersion"'), `不能把整坨 JSON 塞进单元格：${html}`);
  assert.ok(!html.includes('&quot;'), '不该出现 JSON 序列化后的引号');
});

test('明细解析失败必须显式标出（不许当成空明细静默过去）', () => {
  const html = auditLogDetailHtml(null, true);
  assert.ok(html.includes('明细解析失败'), `解析失败必须看得见：${html}`);
  assert.ok(html.includes('badge--danger'), `要用危险色标出来：${html}`);
  assert.ok(!html.includes('>—<'), '不能退化成占位符（那等于把坏数据当成"没有明细"）');
});

test('detail 为 null 显示占位符，不报错、也不标解析失败', () => {
  const html = auditLogDetailHtml(null, false);
  assert.ok(html.includes('—'), '要显示占位符');
  assert.ok(!html.includes('明细解析失败'), 'null 不是解析失败（别误报）');
});

test('明细里的嵌套结构要能被读出来（数组按下标展开）', () => {
  const html = auditLogDetailHtml(['甲', '乙'], false);
  assert.ok(html.includes('甲') && html.includes('乙'), '数组元素要出现');
  assert.ok(html.includes('kv__row'), '数组也要逐项列出');
});

// ═════════════════════════════════════════════════════════════════════════
// 三、纯函数：空集 / 保留窗口 / 指标 / 分页
// ═════════════════════════════════════════════════════════════════════════

test('空集：出现 emptyState 的「没有匹配的审计记录」文案，不是空白页', () => {
  const html = auditLogEmptyHtml();
  assert.ok(html.includes('state--empty'), '必须渲染 emptyState');
  assert.ok(html.includes('没有匹配的审计记录'), '空态要说清是什么没了');
  assert.ok(html.includes('放宽'), '空态要给出下一步（放宽过滤条件）');
});

test('保留窗口：有就显示可查起始日与月数；为 null 就不显示该段（不编造）', () => {
  const html = auditRetentionHtml(RETENTION);
  assert.ok(html.includes('可查起始日'), `要显示可查起始日：${html}`);
  assert.ok(html.includes('2026-04-23T00:00:00.000Z'), `要把起始日写出来：${html}`);
  assert.ok(html.includes('6 个月'), `要把月数写出来：${html}`);
  assert.equal(auditRetentionHtml(null), '', 'retention 为 null ⇒ 这一段整个不出现');
});

test('指标行：总条数 / 当前页条数 / 可查起始日', () => {
  const stats = auditLogStats({
    rows: [row(0), row(1)],
    total: 120,
    retention: RETENTION,
  });
  const byLabel = Object.fromEntries(stats.map((s) => [s.label, s.value]));
  assert.equal(byLabel['总条数'], 120);
  assert.equal(byLabel['当前页条数'], 2);
  assert.equal(byLabel['可查起始日'], '2026-04-23T00:00:00.000Z');
});

test('分页边界：首页的「上一页」禁用、末页的「下一页」禁用', () => {
  const first = auditPagination(120, 50, 0);
  assert.equal(first.hasPrev, false, '首页没有上一页');
  assert.equal(first.hasNext, true, '首页还有下一页');
  const last = auditPagination(120, 50, 100);
  assert.equal(last.hasPrev, true, '末页有上一页');
  assert.equal(last.hasNext, false, '末页没有下一页');
  const empty = auditPagination(0, 50, 0);
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);
  assert.equal(empty.pageCount, 1, '空集页码是 1/1（不是 1/0）');
});

test('分页条：到底了就禁用按钮（光靠不请求，用户不知道是到底了还是坏了）', () => {
  const first = auditLogPagerHtml(auditPagination(120, 50, 0));
  assert.match(first, /data-action="page-prev" disabled/, '首页：上一页禁用');
  assert.match(first, /data-action="page-next"(?! disabled)/, '首页：下一页可点');
  const last = auditLogPagerHtml(auditPagination(120, 50, 100));
  assert.match(last, /data-action="page-next" disabled/, '末页：下一页禁用');
  assert.match(last, /data-action="page-prev"(?! disabled)/, '末页：上一页可点');
});

// ═════════════════════════════════════════════════════════════════════════
// 四、DOM：页面渲染
// ═════════════════════════════════════════════════════════════════════════

test('DOM：页面调的是 GET /api/audit/log，流水表与指标都渲染出来', async () => {
  installDom();
  const api = makeApi();
  const wrap = await renderAuditLog({ api });
  assert.equal(api.calls.length, 1, '首次挂载必须请求一次');
  assert.ok(api.calls[0].startsWith('/api/audit/log'), `端点不对：${api.calls[0]}`);

  // ⚠️ P12：页面改成「左轨过滤 + 右画布看流水」的操作台 ⇒ 指标行在画布里，
  //    不再是 wrap 的第一个子节点（旧写法 wrap.children[0] 已经取不到它）。
  const body = wrap.querySelector('#al-body');
  assert.ok(body.innerHTML.includes('<table'), '要有审计流水表');
  assert.ok(body.innerHTML.includes('computation.record'), '动作列要出现');
  assert.ok(body.innerHTML.includes('cmp_0'), '对象 id 列要出现');
  assert.ok(body.innerHTML.includes('u_admin'), '操作者列要出现');
  assert.ok(body.innerHTML.includes('2026-10-22T00:00:00.000Z'), '时间列要出现');

  const stats = wrap.querySelector('#al-stats').innerHTML;
  assert.ok(stats.includes('总条数'), '指标行要有总条数');
  assert.ok(stats.includes('当前页条数'), '指标行要有当前页条数');
  assert.ok(stats.includes('可查起始日'), '指标行要有可查起始日');
});

test('DOM：明细是逐项可读的键值对，不是整坨 JSON', async () => {
  installDom();
  const api = makeApi();
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('ruleVersion'), '明细键名要出现');
  assert.ok(html.includes('2026-10-20'), '明细值要出现');
  assert.ok(html.includes('kv__row'), '明细要逐项列出');
  assert.ok(!html.includes('{"ruleVersion"'), '不能是整坨 JSON');
});

test('DOM：detailParseError 的行显式标出「明细解析失败」（不许静默当成空明细）', async () => {
  installDom();
  const api = makeApi({ rows: [row(0, { detail: null, detailParseError: true })] });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('明细解析失败'), `解析失败必须在页面上看得见：${html}`);
  assert.ok(html.includes('badge--danger'), '要用危险色标出来');
});

test('DOM：detail 为 null 显示占位符，不报错也不误标解析失败', async () => {
  installDom();
  const api = makeApi({ rows: [row(0, { detail: null })] });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('—'), '要显示占位符');
  assert.ok(!html.includes('明细解析失败'), 'null 不是解析失败（别误报）');
});

test('DOM：空集给出「没有匹配的审计记录」的空态，不是空白页', async () => {
  installDom();
  const api = makeApi({ rows: [] });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(html.includes('state--empty'), '必须渲染 emptyState');
  assert.ok(html.includes('没有匹配的审计记录'), '空态要说清是什么没了');
  assert.ok(!html.includes('<table'), '空集不该渲染一张空表');
});

test('DOM：retention 有值显示可查起始日；为 null 这一段整个不出现', async () => {
  installDom();
  const withR = await renderAuditLog({ api: makeApi({ retention: RETENTION }) });
  assert.ok(
    withR.querySelector('#al-body').innerHTML.includes('可查起始日'),
    '有保留窗口就要显示可查起始日',
  );

  installDom();
  const without = await renderAuditLog({ api: makeApi({ retention: null }) });
  const html = without.querySelector('#al-body').innerHTML;
  assert.ok(!html.includes('可查起始日'), `retention 为 null ⇒ 不许编造窗口：${html}`);
  assert.ok(!html.includes('保留窗口'), 'retention 为 null ⇒ 整段都不出现');
});

// ═════════════════════════════════════════════════════════════════════════
// 五、DOM：过滤 / 分页 / 错误重试
// ═════════════════════════════════════════════════════════════════════════

test('DOM：点「筛选」真的把过滤参数拼进 query 重新请求', async () => {
  installDom();
  const api = makeApi();
  const wrap = await renderAuditLog({ api });

  const filters = wrap.querySelector('#al-filters');
  filters.querySelector('#al-action').value = 'computation.record';
  filters.querySelector('#al-entity').value = 'computation';
  filters.querySelector('#al-since').value = '2026-10-01';
  filters.querySelector('#al-until').value = '2026-10-31';
  filters.querySelector('#al-limit').value = '2';

  click(wrap, 'apply-filter');
  await tick();

  assert.equal(api.calls.length, 2, '筛选必须重新请求一次');
  const q = api.calls[1].split('?')[1] ?? '';
  assert.ok(q.includes('action=computation.record'), `动作没进 query：${q}`);
  assert.ok(q.includes('entity=computation'), `实体没进 query：${q}`);
  assert.ok(q.includes('since=2026-10-01'), `起始时间没进 query：${q}`);
  assert.ok(q.includes('until=2026-10-31'), `截止时间没进 query：${q}`);
  assert.ok(q.includes('limit=2'), `每页条数没进 query：${q}`);
  assert.ok(!q.includes('offset='), '换过滤条件要回到第一页');
});

test('DOM：分页边界 —— 首页「上一页」禁用、末页「下一页」禁用，且真的带 offset', async () => {
  installDom();
  const api = makeApi({ rows: Array.from({ length: 5 }, (_, i) => row(i)) });
  const wrap = await renderAuditLog({ api });

  wrap.querySelector('#al-filters').querySelector('#al-limit').value = '2';
  click(wrap, 'apply-filter');
  await tick();

  let html = wrap.querySelector('#al-body').innerHTML;
  assert.match(html, /data-action="page-prev" disabled/, '首页：上一页必须禁用');
  assert.match(html, /data-action="page-next"(?! disabled)/, '首页：下一页必须可点');

  click(wrap, 'page-next');
  await tick();
  assert.ok(api.calls.at(-1).includes('offset=2'), `第二页要带 offset：${api.calls.at(-1)}`);

  click(wrap, 'page-next');
  await tick();
  html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(api.calls.at(-1).includes('offset=4'), `末页要带 offset：${api.calls.at(-1)}`);
  assert.match(html, /data-action="page-next" disabled/, '末页：下一页必须禁用');
  assert.match(html, /data-action="page-prev"(?! disabled)/, '末页：上一页必须可点');
});

test('DOM：到末页后再点「下一页」不越界（不发越界的请求）', async () => {
  installDom();
  const api = makeApi({ rows: [row(0)] });
  const wrap = await renderAuditLog({ api });
  const before = api.calls.length;
  click(wrap, 'page-next');
  await tick();
  assert.equal(api.calls.length, before, '只有一条记录时不该再发请求');
});

test('DOM：错误态给可点的重试按钮，点它真的重跑一次', async () => {
  installDom();
  const calls = [];
  let fail = true;
  const api = {
    get: async (path) => {
      calls.push(path);
      if (fail) {
        fail = false;
        throw new Error('后端炸了');
      }
      return { rows: [row(0)], total: 1, retention: RETENTION };
    },
  };
  const wrap = await renderAuditLog({ api });

  // ⚠️ P12：操作台改造后状态区在右画布里，不再是 wrap 的第一个子节点。
  const state = wrap.querySelector('#al-state');
  assert.ok(state.innerHTML.includes('data-action="retry"'), '错误态必须有可点的重试按钮');
  assert.ok(state.innerHTML.includes('后端炸了'), '错误消息要透出来');

  click(wrap, 'retry');
  await tick();
  assert.equal(calls.length, 2, '重试必须真的重发一次请求');
  assert.ok(
    wrap.querySelector('#al-body').innerHTML.includes('computation.record'),
    '重试成功后要渲染出内容',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// 六、安全：用户数据必须被转义
// ═════════════════════════════════════════════════════════════════════════

test('DOM：用户数据必须被转义（明细里的可执行标签不许出现在输出里）', async () => {
  installDom();
  const evil = '<img src=x onerror=alert(1)>';
  const evilScript = '<script>alert(1)</script>';
  const api = makeApi({
    rows: [row(0, { detail: { note: evil, other: evilScript }, entity: evilScript })],
  });
  const wrap = await renderAuditLog({ api });
  const html = wrap.querySelector('#al-body').innerHTML;
  assert.ok(!html.includes('<img'), `输出里出现了可执行的 img 标签：${html}`);
  assert.ok(!html.includes('<script'), `输出里出现了可执行的 script 标签：${html}`);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '转义后的文本要保留（不能连内容一起吞掉）');
  assert.ok(html.includes('&lt;script&gt;'), '转义后的文本要保留');
});

test('DOM：转义发生在**唯一入口** escapeHtml（过滤条件回填到输入框时也要转义）', async () => {
  installDom();
  const evil = '"><img src=x onerror=alert(1)>';
  const api = makeApi();
  const wrap = await renderAuditLog({ api, query: { action: evil } });
  const html = wrap.querySelector('#al-filters').innerHTML;
  assert.ok(!html.includes('<img'), `过滤条件回填时出现了可执行标签：${html}`);
  assert.ok(html.includes('&lt;img'), '要转义成文本');
});

test('纯函数：行渲染里的用户数据同样被转义', () => {
  const html = auditLogRowHtml(row(0, { action: '<script>x</script>', entityId: '"><b>' }));
  assert.ok(!html.includes('<script'), '动作列不许出现可执行标签');
  assert.ok(!html.includes('<b>'), '对象 id 列不许出现可执行标签');
  assert.ok(html.includes('&lt;script&gt;'), '要转义成文本');
});

test('纯函数：表格 HTML 里的明细同样被转义', () => {
  const html = auditLogTableHtml([row(0, { detail: { note: '<img src=x onerror=alert(1)>' } })]);
  assert.ok(!html.includes('<img'), '表格里不许出现可执行标签');
  assert.ok(html.includes('&lt;img'), '要转义成文本');
});

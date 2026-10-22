// platform/test/web-ui.test.js —— P7「现有页面打磨到生产级」的契约测试
//
// 规则溯源：
//   - 「导航按角色分区（三端拆分）」→ docs/three-port-alignment.md
//   - 「外壳三件套（加载/空/错）统一」→ 本轮设计系统落地
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束「可见性在 API 层过滤」
//
// ⚠️ 本文件的用例全部是**行为断言**，不是文本匹配：
//    「错误态必须带重试按钮」「未登录访问受保护页不得发请求」这类判据，
//    只能从**渲染结果**或**实际请求**里看出来。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadingState, emptyState, errorState, noticeState, badge,
  statCard, statRow, kvList, rankBadge, barRow,
  pageHead, panel, tabs, tableWrap, emptyRow, tone, friendlyError,
} from '../web/ui.js';

import {
  userRoles, roleLabel, canAccess, isActive, visibleSections, navHtml, guardFor,
  PROTECTED_ROUTES,
} from '../web/nav.js';

// ══════════════════════════════════════════════════════════════════
// 一、外壳三件套
// ══════════════════════════════════════════════════════════════════

test('加载态：带 aria-live（屏幕阅读器要知道在加载）+ 骨架屏', () => {
  const html = loadingState({ rows: 3, label: '正在加载报名问卷…' });
  assert.ok(html.includes('aria-live'), '加载态必须对辅助技术可见');
  assert.ok(html.includes('正在加载报名问卷…'), '要显示加载文案');
  assert.ok(html.includes('skeleton'), '要有骨架屏');
  assert.equal((html.match(/skeleton__line/g) || []).length, 3, '骨架行数要对');
});

test('加载态：行数非法时收敛到安全区间（不渲染 0 行也不渲染 999 行）', () => {
  assert.ok(loadingState({ rows: 0 }).includes('skeleton__line'), '0 行也要有骨架');
  const many = loadingState({ rows: 999 });
  assert.ok((many.match(/skeleton__line/g) || []).length <= 8, '骨架行数必须有上限');
});

test('空态：必须带「下一步做什么」（标题 + 提示 + 可选动作）', () => {
  const html = emptyState({ title: '还没有任务清单', hint: '组委会发布任务包后会出现。' });
  assert.ok(html.includes('还没有任务清单'));
  assert.ok(html.includes('组委会发布任务包后会出现'), '空态必须说清什么时候会有');
  const withAction = emptyState({ title: '暂无', action: { href: '#/apply', label: '去报名' } });
  assert.ok(withAction.includes('去报名') && withAction.includes('#/apply'), '动作要能点');
});

test('错误态：必须带重试按钮（错误不能是死路）', () => {
  const html = errorState({ message: '加载失败' });
  assert.ok(html.includes('加载失败'));
  assert.ok(html.includes('data-action="retry"'), '错误态必须有重试按钮');
  assert.ok(html.includes('role="alert"'), '错误态必须能被辅助技术播报');
});

test('错误态与空态：错误消息必须转义（服务端消息是外部输入）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = errorState({ message: evil });
  assert.ok(html.includes('&lt;img'), '错误消息必须转义');
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
});

test('提示条：色调不在白名单时降级成 neutral（不许拼出无法识别的 class）', () => {
  assert.equal(tone('brand'), 'brand');
  assert.equal(tone('evil" onclick="x'), 'neutral', '非法色调必须 fail-closed');
  assert.equal(tone(undefined), 'neutral');
  const html = noticeState({ tone: 'evil" onclick="x', title: 't' });
  assert.ok(html.includes('notice--neutral'), '必须降级');
  assert.ok(!html.includes('onclick'), '不得把外部值拼进 class');
});

test('提示条：降级告警可以一次给多条（items + list）', () => {
  const html = noticeState({ tone: 'warn', title: '本轮降级提示（2）', items: ['a', 'b'], list: true });
  assert.ok(html.includes('notice--warn'));
  assert.ok(html.includes('<li>a</li>') && html.includes('<li>b</li>'));
});

test('徽章 / 指标卡 / 键值表：外部值一律转义', () => {
  const evil = '<script>bad()</script>';
  const b = badge(evil, 'brand');
  assert.ok(b.includes('&lt;script&gt;') && !b.includes('<script'));
  const s = statCard({ label: evil, value: evil, hint: evil });
  assert.ok(!s.includes('<script'));
  const k = kvList([[evil, evil]]);
  assert.ok(!k.includes('<script'));
});

test('键值表：空值不渲染（不给「未填写:」这种噪音行）', () => {
  assert.equal(kvList([['a', ''], ['b', null], ['c', undefined]]), '');
  assert.ok(kvList([['a', 'x']]).includes('a'));
});

test('名次徽章：前三名金银铜，其余中性', () => {
  assert.ok(rankBadge(1).includes('rank-badge--gold'));
  assert.ok(rankBadge(2).includes('rank-badge--silver'));
  assert.ok(rankBadge(3).includes('rank-badge--bronze'));
  assert.ok(rankBadge(9).includes('rank-badge--plain'));
});

test('条形：百分比必须收敛到 0–100（max 为 0 或缺省时不炸）', () => {
  assert.ok(barRow({ label: 'a', value: 5, max: 10 }).includes('width:50%'));
  assert.ok(barRow({ label: 'a', value: 5, max: 0 }).includes('width:100%'));
  const over = barRow({ label: 'a', value: 50, max: 10 });
  assert.ok(over.includes('width:100%'), '超过 max 必须截到 100');
});

test('表格辅助：空行跨列正确；表格外层包了横向滚动', () => {
  const row = emptyRow(6, '暂无数据');
  assert.ok(row.includes('colspan="6"'));
  assert.ok(row.includes('暂无数据'));
  const wrapped = tableWrap('<tbody><tr><td>x</td></tr></tbody>');
  assert.ok(wrapped.includes('table-wrap'), '表格外层要给窄屏横向滚动');
});

test('徽章 / 表格外层的扩展位：可追加 class，但属性值必须被清洗到「不可能逃逸出属性」', () => {
  const b = badge('已签', 'success', 'signed');
  assert.ok(b.includes('badge--success') && b.includes('signed'), '扩展 class 要生效');
  // ⛔ 判据不是「字符串里没有 onclick」（剥掉引号后 onclick 只是无害的字面残留），
  //    而是「**class 属性不可能被逃逸**」—— 注入的扩展 class 必须仍是**单个合法 token**：
  //    不许带空白（否则能塞出第二个属性）、不许带引号/等号。
  const classAttr = (html) => /class="([^"]*)"/.exec(html)?.[1] ?? '';
  const tokens = (html) => classAttr(html).split(/\s+/).filter(Boolean);
  for (const evil of ['a" onclick="evil', "a' onclick='evil", 'a onclick=evil', 'a"onmouseover="x']) {
    const attr = classAttr(badge('x', 'neutral', evil));
    assert.ok(!attr.includes('"'), `class 属性里不许有双引号：${attr}`);
    assert.ok(!attr.includes("'"), `class 属性里不许有单引号：${attr}`);
    assert.ok(!attr.includes('='), `class 属性里不许有等号：${attr}`);
    for (const tk of tokens(badge('x', 'neutral', evil))) {
      assert.match(tk, /^[\w-]+$/, `class token 必须是合法类名（不许有空白/引号）：${tk}`);
    }
  }
  const t = tableWrap('<tbody></tbody>', { className: 'table--compact' });
  assert.ok(t.includes('table--compact'), '紧凑密度要能通过扩展位传进来');
  for (const evil of ['x" onmouseover="evil', 'x onmouseover=evil', 'x"onclick="y']) {
    for (const tk of tokens(tableWrap('<tbody></tbody>', { className: evil }))) {
      assert.match(tk, /^[\w-]+$/, `表格 class token 也要清洗：${tk}`);
    }
    // ⛔ **光看 class 属性值不够**：属性值被正则截到第一个引号为止，
    //    属性**逃逸**（`class="a" onclick="b"`）在那个视角下完全不可见。
    //    ⇒ 判据必须是「**整个标签里只有一个属性**」。
    const tag = /<table[^>]*>/.exec(tableWrap('<tbody></tbody>', { className: evil }))?.[0] ?? '';
    assert.equal((tag.match(/="/g) || []).length, 1, `table 标签里只允许一个属性（class），实际：${tag}`);
  }
  const spanTag = /<span[^>]*>/.exec(badge('x', 'neutral', 'a" onclick="evil'))?.[0] ?? '';
  assert.equal((spanTag.match(/="/g) || []).length, 1, `span 标签里只允许一个属性（class），实际：${spanTag}`);
});

test('页头与面板：标题/副标题转义；面板头体结构完整', () => {
  const evil = '<img src=x onerror=1>';
  const head = pageHead({ title: evil, sub: evil });
  assert.ok(!head.includes('<img'), '页头必须转义');
  const p = panel({ title: 'T', desc: 'D', body: '<p>B</p>' });
  assert.ok(p.includes('panel__head') && p.includes('panel__body') && p.includes('<p>B</p>'));
});

test('标签页：当前项高亮且带 aria-current（可访问性）', () => {
  const html = tabs({ items: [{ id: 'rank', label: 'A 榜', href: '#/leaderboard?scope=rank' }], active: 'rank' });
  assert.ok(html.includes('is-active'));
  assert.ok(html.includes('aria-current="page"'));
});

// ══════════════════════════════════════════════════════════════════
// 二、导航分区（三端拆分的前端落地）
// ══════════════════════════════════════════════════════════════════

const ADMIN = { id: 'u_a', name: '组委会', roles: ['admin'] };
const MEMBER = { id: 'u_m', name: '甲', roles: ['member'] };
const CAPTAIN = { id: 'u_c', name: '乙', roles: ['captain'] };
const JUDGE = { id: 'u_j', name: '丙', roles: ['judge'] };

test('角色提取：各种形状都要兜住（数组 / 单串 / 缺失 / 脏值）', () => {
  assert.deepEqual(userRoles({ roles: ['admin', 'judge'] }), ['admin', 'judge']);
  assert.deepEqual(userRoles({ roles: 'admin' }), ['admin']);
  assert.deepEqual(userRoles({}), []);
  assert.deepEqual(userRoles(null), []);
  assert.deepEqual(userRoles({ roles: ['', null, 3, 'x'] }), ['x'], '脏值要滤掉');
});

test('身份标签：已知角色 / 超管 / 未知角色 / 访客', () => {
  assert.equal(roleLabel(ADMIN), '组委会');
  assert.equal(roleLabel(CAPTAIN), '队长');
  assert.equal(roleLabel(JUDGE), '评委席');
  assert.equal(roleLabel({ id: 'x', isSuperadmin: true }), '组委会 · 超管');
  assert.equal(roleLabel({ id: 'x', roles: ['nobody'] }), '访客', '认不出的角色当访客');
  assert.equal(roleLabel(null), '访客');
});

test('导航分区：未登录只看得见公开分区', () => {
  const secs = visibleSections(null);
  assert.equal(secs.length, 1, '未登录只应有「赛事」一个分区');
  assert.equal(secs[0].id, 'public');
  const html = navHtml(null, '/');
  assert.ok(html.includes('榜单'), '公开分区要有榜单入口');
  assert.ok(!html.includes('报名筛选台'), '未登录不该看到组委会分区');
  assert.ok(!html.includes('我的战队'), '未登录不该看到「我的赛事」分区');
});

test('导航分区：选手看不到组委会分区，但看得到「我的赛事」', () => {
  const html = navHtml(MEMBER, '/');
  assert.ok(html.includes('我的战队'), '选手要有「我的赛事」分区');
  assert.ok(html.includes('报名'), '选手要有报名入口');
  assert.ok(!html.includes('报名筛选台'), '选手不该看到组委会分区');
  assert.ok(!html.includes('复核队列'), '选手不该看到复核队列');
});

test('导航分区：组委会看得到组委会分区（这是三端拆分的落地点）', () => {
  const html = navHtml(ADMIN, '/');
  assert.ok(html.includes('报名筛选台'), '组委会必须看得到筛选台');
  assert.ok(html.includes('复核队列'), '组委会必须看得到复核队列');
  assert.ok(html.includes('组委会'), '分区标签要写明是组委会');
});

test('导航分区：超管直通组委会分区（即使角色表里没写 admin）', () => {
  const html = navHtml({ id: 'u_s', name: '超管', isSuperadmin: true, roles: [] }, '/');
  assert.ok(html.includes('报名筛选台'), '超管必须直通');
});

test('导航分区：不同角色看到不同的分区集合（这是分区真的在起作用）', () => {
  const memberIds = visibleSections(MEMBER).map((s) => s.id);
  const adminIds = visibleSections(ADMIN).map((s) => s.id);
  assert.ok(!memberIds.includes('committee'), '选手分区集合里不该有 committee');
  assert.ok(adminIds.includes('committee'), '组委会分区集合里必须有 committee');
  assert.ok(memberIds.includes('player'), '选手要有 player 分区');
});

test('当前项高亮：根路径精确匹配，前缀路径匹配子路径', () => {
  assert.equal(isActive('/', { path: '/', exact: true }), true);
  assert.equal(isActive('/leaderboard', { path: '/', exact: true }), false);
  assert.equal(isActive('/leaderboard/st_1', { path: '/leaderboard' }), true);
  assert.equal(isActive('/tasks/wf_1', { path: '/tasks' }), true);
  assert.equal(isActive('/team', { path: '/tasks' }), false);
});

test('导航 HTML：用户区块显示姓名与身份；访客显示登录入口', () => {
  const html = navHtml(ADMIN, '/');
  assert.ok(html.includes('组委会'));
  assert.ok(html.includes('退出'));
  assert.ok(navHtml(null, '/').includes('登录'));
});

test('导航 HTML：服务端返回的用户名必须转义（innerHTML 插值 = 存储型 XSS）', () => {
  // ⛔ 变异检验实测：把 navHtml 里的 escapeHtml(user.name) 去掉，**全量测试照样全绿**
  //    ⇒ 这里补上判别性断言。
  const evil = '<img src=x onerror=alert(1)>';
  const html = navHtml({ id: 'u', name: evil, roles: ['admin'] }, '/');
  assert.ok(!html.includes('<img'), `用户名必须转义，实际：${html}`);
  assert.ok(html.includes('&lt;img'), `用户名必须被转义成 &lt;img，实际：${html}`);
});

// ══════════════════════════════════════════════════════════════════
// 三、路由守卫 —— 授权必须归 API，前端只判登录态
// ══════════════════════════════════════════════════════════════════

test('守卫：未登录访问受保护页 ⇒ 拒绝；已登录 ⇒ 放行', () => {
  assert.equal(canAccess('/apply', null), false, '未登录不得访问报名');
  assert.equal(canAccess('/team', null), false);
  assert.equal(canAccess('/tasks/wf_1', null), false);
  assert.equal(canAccess('/admin/registration', null), false);
  assert.equal(canAccess('/flags', null), false);
  assert.equal(canAccess('/apply', MEMBER), true);
});

test('守卫：公开页任何人都能进', () => {
  for (const p of ['/', '/leaderboard', '/leaderboard/st_1', '/tier', '/card/t_1']) {
    assert.equal(canAccess(p, null), true, `${p} 应当公开`);
  }
});

test('守卫：**不按角色拦路** —— 授权是 API 的事，前端按角色拦会误伤被直接授权的人', () => {
  // ⚠️ 这是本轮设计红线：能力点可以**直接授权给个人**（assignments 表），
  //    根本不经角色 ⇒ 前端手里没有能力信息 ⇒ 按角色拦 = 误伤有权限的人。
  assert.equal(canAccess('/flags', MEMBER), true, '前端不得按角色阻断（服务端才是裁决者）');
  assert.equal(canAccess('/audit/cmp_1', MEMBER), true);
  assert.equal(canAccess('/admin/registration', { id: 'x', roles: [] }), true);
});

test('守卫规则表：受保护路径必须真的被规则命中', () => {
  assert.ok(guardFor('/apply'));
  assert.ok(guardFor('/admin/registration'));
  assert.ok(guardFor('/audit/cmp_1'));
  assert.equal(guardFor('/leaderboard'), null);
});

test('守卫：受保护路由表里**不许出现 roles 字段**（防「有人把角色闸加回来」）', () => {
  // ⛔ 变异检验实测：只改 canAccess（加角色闸）在当前代码下是**等价变异体**
  //    （PROTECTED_ROUTES 里没有 roles ⇒ 那段代码是死代码）⇒ 测不出问题。
  //    ⇒ 真正要防的是「有人给路由表加 roles 字段」⇒ 这里直接钉住这张表。
  for (const r of PROTECTED_ROUTES) {
    assert.equal(
      r.roles,
      undefined,
      `受保护路由 ${r.pattern} 不许有 roles —— 授权归 API，前端按角色拦会误伤被直接授权的人`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════
// 四、端到端：守卫真的拦住了请求（反向对照）
// ══════════════════════════════════════════════════════════════════

/** 最小 DOM 桩：够 web/app.js 跑起来 */
function installDom(hash = '') {
  const calls = [];
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
  });
  const app = mk('div');
  const topbar = mk('div');
  globalThis.window = { location: { search: '', hash }, addEventListener() {} };
  globalThis.document = {
    createElement: (tag) => mk(tag),
    getElementById: (id) => (id === 'topbar' ? topbar : app),
  };
  return { app, topbar, calls };
}

async function bootApp(hash, meBody, tag) {
  const dom = installDom(hash);
  globalThis.fetch = async (url) => {
    dom.calls.push(String(url));
    const body = String(url) === '/api/me' ? meBody : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  await import(`../web/app.js?v=${tag}`);
  await new Promise((r) => setTimeout(r, 30));
  return dom;
}

test('守卫：未登录点「报名」⇒ 不发业务请求，且渲染「需要登录」引导页', async () => {
  const dom = await bootApp('#/apply', { user: null }, 'guard-anon');
  assert.ok(
    !dom.calls.some((c) => c.includes('/api/registration-criteria')),
    `未登录不得触发报名接口，实际请求：${JSON.stringify(dom.calls)}`,
  );
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('需要登录'), `应渲染登录引导页，实际：${html}`);
  assert.ok(html.includes('#/login'), '引导页要给出登录入口');
});

test('守卫（反向对照）：已登录点「报名」⇒ 请求发出、页面渲染（上一条不是恒绿）', async () => {
  const dom = await bootApp('#/apply', { user: { id: 'u_m', name: '甲', roles: ['member'] } }, 'guard-auth');
  assert.ok(
    dom.calls.some((c) => c.includes('/api/registration-criteria')),
    `已登录必须真的请求报名接口，实际请求：${JSON.stringify(dom.calls)}`,
  );
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('报名'), `应渲染报名页，实际：${html}`);
});

test('顶栏：已登录时显示姓名与身份；未登录时显示登录入口', async () => {
  const dom = await bootApp('#/', { user: { id: 'u_a', name: '组委会', roles: ['admin'] } }, 'topbar-auth');
  const nav = dom.topbar.innerHTML;
  assert.ok(nav.includes('组委会'), `顶栏要显示身份，实际：${nav}`);
  assert.ok(nav.includes('报名筛选台'), '组委会要看到组委会分区入口');

  const anon = await bootApp('#/', { user: null }, 'topbar-anon');
  assert.ok(anon.topbar.innerHTML.includes('登录'), '未登录要看到登录入口');
  assert.ok(!anon.topbar.innerHTML.includes('报名筛选台'), '未登录不该看到组委会入口');
});

test('总览页：未登录也要有内容（首屏不能白屏）', async () => {
  const dom = await bootApp('#/', { user: null }, 'home-anon');
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('未登录'), `首屏必须显示未登录状态，实际：${html}`);
  assert.ok(html.includes('赛事'), '首屏要有内容');
});

// ══════════════════════════════════════════════════════════════════
// 四、错误消息友好化（P7 浏览器实测：网络层失败把英文 TypeError 甩给用户）
// ══════════════════════════════════════════════════════════════════

test('错误友好化：浏览器网络层失败（Failed to fetch）⇒ 换成人话', () => {
  assert.equal(friendlyError(new TypeError('Failed to fetch')), '网络连接失败，请检查网络后重试');
  assert.equal(friendlyError(new TypeError('Load failed')), '网络连接失败，请检查网络后重试');
  assert.equal(friendlyError('Failed to fetch'), '网络连接失败，请检查网络后重试');
});

test('错误友好化：业务错误原样透出（不洗成通用话术）', () => {
  assert.equal(friendlyError(new Error('未登录')), '未登录');
  assert.equal(friendlyError(new Error('战队不存在')), '战队不存在');
});

test('错误友好化：没有消息时用兜底文案（不许出现 undefined / null）', () => {
  assert.equal(friendlyError(undefined), '加载失败，请重试');
  assert.equal(friendlyError(new Error('')), '加载失败，请重试');
  assert.equal(friendlyError(new Error('undefined')), '加载失败，请重试');
});

test('错误态：错误消息过一遍友好化（唯一出口 ⇒ 11 个视图都受益）', () => {
  const html = errorState({ message: new TypeError('Failed to fetch') });
  assert.ok(html.includes('网络连接失败，请检查网络后重试'));
  assert.ok(!html.includes('Failed to fetch'), '不能把英文技术错误透给用户');
  assert.ok(html.includes('data-action="retry"'), '错误态必须有重试按钮');
});

// ══════════════════════════════════════════════════════════════════
// 五、总览页的请求口径（端到端：看真实发出了哪些请求）
// ══════════════════════════════════════════════════════════════════

test('总览页：未登录不请求需要登录态的 /api/teams', async () => {
  const dom = await bootApp('#/', { user: null }, 'home-no-teams');
  assert.ok(
    !dom.calls.some((c) => c.includes('/api/teams')),
    `未登录不该请求 /api/teams，实际：${JSON.stringify(dom.calls)}`,
  );
});

test('总览页：已登录才请求 /api/teams（反向对照：上一条不是恒绿）', async () => {
  const dom = await bootApp('#/', { user: { id: 'u_a', name: '甲', roles: ['member'] } }, 'home-teams');
  assert.ok(
    dom.calls.some((c) => c.includes('/api/teams')),
    `已登录必须请求 /api/teams，实际：${JSON.stringify(dom.calls)}`,
  );
});

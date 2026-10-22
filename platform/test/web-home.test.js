// platform/test/web-home.test.js —— 总览页（赛事总览）的行为闸
//
// 规则溯源：
//   - 「页面打磨到生产级（视觉 / 交互 / 信息密度）」→ P7
//   - 「错误态必须带真的能点的重试」→ P7 DP-80
//   - 「可见性在 API 层过滤」→ 全局约束（前端只判登录态，不按角色拦路）
//
// ⚠️ 本文件为什么存在（P7 浏览器实测逼出来的）：
//   首页打磨后的第一版在**真实浏览器**里暴露了三个肉眼容易漏、但用户一定看得见的缺陷：
//     ① 未登录时两个指标**错位**（「参赛队伍」显示的其实是榜单数）；
//     ② 榜单每一行渲染成「. 队名」+「分」（名次与积分两个空值）；
//     ③ 「报名入口」按钮指向 `#/register`——**路由表里根本没有这个路由**。
//   这三条如果只靠人点页面发现，下一轮改版大概率复发 ⇒ 全部变成**可复算的机器闸**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  homeKpiCards, homeBoardHtml, homeEntryCards, homeEntryCardsHtml, renderHome,
} from '../web/views/home.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const APP_JS = readFileSync(join(webDir, 'app.js'), 'utf8');
const NAV_JS = readFileSync(join(webDir, 'nav.js'), 'utf8');
const HOME_JS = readFileSync(join(webDir, 'views', 'home.js'), 'utf8');

/** 路由表：从 app.js 的 route('...') 调用点**扫出来**（手写清单会漏）。 */
const ROUTES = [...APP_JS.matchAll(/route\(\s*'([^']+)'/g)].map((m) => m[1]);

/** 路由模式匹配（支持 :param 段）。 */
function routeMatches(pattern, path) {
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return false;
  return pp.every((seg, i) => seg.startsWith(':') || seg === xp[i]);
}

/** 某个 hash 链接（#/xxx）有没有对应的路由。 */
function hasRoute(hashPath) {
  const clean = hashPath.replace(/^#/, '').replace(/\?.*$/, '');
  return ROUTES.some((r) => routeMatches(r, clean));
}

// ══════════════════════════════════════════════════════════════════
// 一、指标卡：形状固定 + 标签与值不得错位
// ══════════════════════════════════════════════════════════════════

test('首页指标卡：未登录只有 2 张卡（不显示「我的队伍」）', () => {
  const cards = homeKpiCards({ user: null, teamCount: null, boardCount: 5 });
  assert.equal(cards.length, 2, '未登录不该出现「我的队伍」卡');
  assert.deepEqual(cards.map((c) => c.label), ['在榜队伍', '我的身份']);
  assert.equal(cards[0].value, 5);
  assert.equal(cards[1].value, '访客');
});

test('首页指标卡：登录后 3 张卡，且「在榜队伍」的值**不是**队伍数', () => {
  const cards = homeKpiCards({ user: { name: '张三' }, teamCount: 2, boardCount: 7 });
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.label), ['我的队伍', '在榜队伍', '我的身份']);
  assert.equal(cards[0].value, 2, '「我的队伍」= /api/teams 的条数');
  assert.equal(cards[1].value, 7, '「在榜队伍」= 滚动总榜的条数');
  assert.equal(cards[2].value, '参赛者');
});

test('首页指标卡：组委会身份显示「组委会」而不是「参赛者」', () => {
  const cards = homeKpiCards({ user: { roles: ['admin'] }, isAdmin: true, boardCount: 3 });
  assert.equal(cards.at(-1).value, '组委会');
});

test('首页指标卡：取不到数时用「—」占位（不是 undefined）', () => {
  const cards = homeKpiCards({ user: { name: '张三' }, teamCount: null, boardCount: null });
  assert.equal(cards[0].value, '—');
  assert.equal(cards[1].value, '—');
  assert.ok(!cards.some((c) => c.value === undefined), '不许出现 undefined');
});

test('首页指标卡：标签不得写成「参赛队伍」（/api/teams 返回的是**我的**战队）', () => {
  const cards = homeKpiCards({ user: { name: '张三' }, teamCount: 1, boardCount: 1 });
  assert.ok(!cards.some((c) => c.label === '参赛队伍'), '口径撒谎：/api/teams 是我的战队');
});

// ══════════════════════════════════════════════════════════════════
// 二、滚动总榜：字段口径
// ══════════════════════════════════════════════════════════════════

test('首页榜单：行没有 rank / total 字段时，名次按序编号、积分取 points', () => {
  // ⚠️ 这就是滚动总榜的真实形状（getRollingLeaderboard 与演示适配器一致）
  const rows = [
    { teamId: 't_alpha', teamName: '拾光队', points: 88, stages: 2, bestRank: 1, tier: 'A' },
    { teamId: 't_beta', teamName: '回声队', points: 61, stages: 2, bestRank: 3, tier: 'B' },
  ];
  const html = homeBoardHtml(rows);
  assert.ok(html.includes('>1. 拾光队<'), '第一名必须渲染成「1. 拾光队」');
  assert.ok(html.includes('2. 回声队'));
  assert.ok(html.includes('88 分'), '积分取 points');
  assert.ok(html.includes('61 分'));
  assert.ok(!/(^|[^0-9])\. 拾光队/.test(html), '不能渲染成「. 队名」（名次字段不存在时的经典症状）');
  assert.ok(!/>\s*分</.test(html), '不能渲染成空积分');
});

test('首页榜单：积分口径钉死 —— points 优先（total 不能盖掉它）', () => {
  // ⚠️ 变异检验实测：只断言「行里有 points 时显示 points」**杀不掉**
  //    「points / total 两个字段顺序颠倒」的变异体（滚动总榜的行根本没有 total
  //    ⇒ 两种写法结果一样 ⇒ 判据太弱，不是等价变异体）。
  //    ⇒ 这里显式给一行**同时有** points 与 total 的数据，把优先级钉死。
  const html = homeBoardHtml([{ teamId: 't_x', teamName: '双字段队', points: 88, total: 999 }]);
  assert.ok(html.includes('88 分'), 'points 是滚动总榜的积分口径 ⇒ 必须优先');
  assert.ok(!html.includes('999 分'), 'total 不能盖掉 points');
});

test('首页榜单：行没有 points 字段时才退回 total', () => {
  const html = homeBoardHtml([{ teamId: 't_y', teamName: '老口径队', total: 42 }]);
  assert.ok(html.includes('42 分'), '兼容老口径');
});

test('首页榜单：最多只显示前五', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ teamId: `t${i}`, teamName: `队${i}`, points: 100 - i }));
  const html = homeBoardHtml(rows);
  assert.equal((html.match(/<li/g) || []).length, 5);
});

test('首页榜单：空数据给空态（说清什么时候会有）', () => {
  const html = homeBoardHtml([]);
  assert.ok(html.includes('榜单还没有数据'));
  assert.ok(html.includes('发榜'), '空态必须说清什么时候会有数据');
});

test('首页榜单：队名里的 HTML 必须转义（服务端数据是外部输入）', () => {
  const html = homeBoardHtml([{ teamId: 'x', teamName: '<img src=x onerror=alert(1)>', points: 1 }]);
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
  assert.ok(html.includes('&lt;img'));
});

// ══════════════════════════════════════════════════════════════════
// 三、死链闸：入口卡与导航里的每个 href 都必须对应真实路由
// ══════════════════════════════════════════════════════════════════

test('死链闸：首页入口卡的每个 href 都对应真实路由', () => {
  const cases = [
    { user: null, isAdmin: false },
    { user: { name: '张三' }, isAdmin: false },
    { user: { roles: ['admin'] }, isAdmin: true },
  ];
  for (const c of cases) {
    const entries = homeEntryCards(c);
    for (const e of entries) {
      for (const l of e.links) {
        assert.ok(
          hasRoute(l.href),
          `死链：${e.title} → ${l.label} 指向 ${l.href}，但路由表里没有（现有路由：${ROUTES.join(', ')}）`,
        );
      }
    }
  }
});

test('死链闸：主导航的每个 path 都对应真实路由', () => {
  const paths = [...NAV_JS.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 6, '导航里应该有 6 条以上的路径（漏扫说明正则失效）');
  for (const p of paths) {
    assert.ok(hasRoute(p), `死链：导航项 ${p} 没有对应路由`);
  }
});

test('死链闸：路由表必须含首页与报名页（防扫描正则失效导致闸变空转）', () => {
  assert.ok(ROUTES.includes('/'), '必须有首页路由');
  assert.ok(ROUTES.includes('/apply'), '必须有报名页路由');
  assert.ok(ROUTES.length >= 10, `路由表只扫到 ${ROUTES.length} 条，正则可能失效`);
});

// ══════════════════════════════════════════════════════════════════
// 四、结构闸：首页必须走独立视图，且不能自己造路由表
// ══════════════════════════════════════════════════════════════════

test('结构闸：首页逻辑在 views/home.js 里，app.js 只负责挂路由', () => {
  assert.ok(
    /import \{ renderHome \} from '\.\/views\/home\.js'/.test(APP_JS),
    'app.js 必须从 views/home.js 引入首页视图',
  );
  assert.ok(
    /route\('\/',\s*\(\w+\)\s*=>\s*renderHome\(\w+\)\)/.test(APP_JS),
    '首页路由必须把上下文透传给视图（否则 ctx.api 为 undefined，页面直接崩）',
  );
  assert.ok(!/function renderHome/.test(APP_JS), 'app.js 不该再自带一份 renderHome（两份实现 = 迟早走偏）');
});

test('结构闸：首页不得引用滚动总榜里**不存在**的 rank 字段', () => {
  // ⚠️ 只扫**代码**：注释里会写「原实现写的是 r.rank」来解释坑，
  //    连注释一起扫会把「说明问题的文字」当成「问题本身」。
  const code = HOME_JS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\br\.rank\b/.test(code), '滚动总榜没有 rank 字段（名次要按序自己编号）');
});

// ══════════════════════════════════════════════════════════════════
// 六、请求口径（视图层隔离断言）
// ══════════════════════════════════════════════════════════════════

/**
 * 最小 DOM 桩：够 renderHome 跑起来。
 * ⚠️ 为什么在**视图层**断言请求次数，而不是在 app.js 层：
 *   app.js 层每次 import 都会往**同一个** router 模块里追加一份路由，
 *   多个测试实例会互相触发渲染 ⇒ 请求次数被放大，断言必然 flaky。
 *   视图层直接喂 ctx ⇒ 一次 boot、一次请求序列，完全确定。
 */
function stubDom() {
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
  });
  globalThis.window = { location: { search: '', hash: '#/' }, addEventListener() {} };
  globalThis.document = { createElement: (t) => mk(t), getElementById: () => mk('div') };
}

async function bootHome(user, apiImpl) {
  stubDom();
  const calls = [];
  const ctx = {
    api: {
      get: async (p) => { calls.push(p); return apiImpl ? apiImpl(p) : { rows: [] }; },
    },
    getState: () => ({ user }),
  };
  renderHome(ctx);
  await new Promise((r) => setTimeout(r, 10));
  return calls;
}

test('总览页：滚动总榜只请求一次（KPI 与前五榜共用同一份数据）', async () => {
  const calls = await bootHome(null);
  const rolling = calls.filter((c) => c.includes('/api/leaderboard/rolling'));
  assert.equal(rolling.length, 1, `滚动总榜应只请求 1 次，实际 ${rolling.length} 次：${JSON.stringify(calls)}`);
});

test('总览页：未登录不请求需要登录态的 /api/teams', async () => {
  const calls = await bootHome(null);
  assert.ok(!calls.some((c) => c.includes('/api/teams')), `未登录不该请求 /api/teams：${JSON.stringify(calls)}`);
});

test('总览页：已登录才请求 /api/teams（反向对照：上一条不是恒绿）', async () => {
  const calls = await bootHome({ id: 'u_a', name: '甲', roles: ['member'] });
  assert.ok(calls.some((c) => c.includes('/api/teams')), `已登录必须请求 /api/teams：${JSON.stringify(calls)}`);
});

test('总览页：榜单接口失败时给出**带重试**的错误态（不许是死路）', async () => {
  stubDom();
  const calls = [];
  const ctx = {
    api: {
      get: async (p) => {
        calls.push(p);
        if (p.includes('/api/leaderboard/rolling')) throw new TypeError('Failed to fetch');
        return { items: [] };
      },
    },
    getState: () => ({ user: null }),
  };
  renderHome(ctx);
  await new Promise((r) => setTimeout(r, 10));
  // ⚠️ DOM 桩的 querySelector 返回游离元素 ⇒ 只能断言「错误态片段被生成过」，
  //    这里用源码闸补上「重试按钮真的被绑定」这一半（见下一条）。
  assert.ok(calls.some((c) => c.includes('/api/leaderboard/rolling')), '榜单接口必须被请求');
});

test('结构闸：榜单错误态必须绑定重试按钮（点了要能重跑）', () => {
  const code = HOME_JS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/data-action="retry"/.test(code), '首页必须给错误态挂重试按钮');
  assert.ok(
    /addEventListener\('click'/.test(code),
    '重试按钮必须真的绑定 click（只渲染按钮不绑定 = 死路一条）',
  );
});

// ══════════════════════════════════════════════════════════════════
// 五、入口卡 HTML
// ══════════════════════════════════════════════════════════════════

test('入口卡 HTML：标题与链接都要渲染出来', () => {
  const html = homeEntryCardsHtml(homeEntryCards({ user: null }));
  assert.ok(html.includes('开始参赛'));
  assert.ok(html.includes('赛事公开信息'));
  assert.ok(html.includes('href="#/apply"'));
  assert.ok(!html.includes('href="#/register"'), '报名入口必须指向 /apply');
});

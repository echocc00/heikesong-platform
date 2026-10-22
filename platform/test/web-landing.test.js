// platform/test/web-landing.test.js —— 落地页（首页）的行为闸
//
// 规则溯源：
//   - 「要有落地页，也就是首页，首页用来介绍赛事和赛制，吸引报名」→ P9 用户指令
//   - 「赛制全部配置化」→ 全局约束（规则只有 rules/*.json 一个出处）
//   - 「可见性在 API 层过滤」/「前端只判登录态」→ 全局约束（DP-77）
//
// ⚠️ 本文件为什么存在：
//   落地页是**访客的第一印象**，也是**赛制对外唯一的公开表述**。
//   两类事故肉眼极难发现、但用户一定看得见：
//     ① 赛制数字在前端被硬编码 ⇒ 委员会改了 rules/*.json，落地页还在说旧话（口径撒谎）；
//     ② 落地页里出现一个指向不存在路由的链接 ⇒ 访客点下去是「页面不存在」；
//     ③ 登录态相关的东西漏进未登录页 ⇒ 访客看到「需要登录」或 401 错误态。
//   ⇒ 全部变成**可复算的机器闸**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  landingStats, landingSpineNodes, landingSpineDetail, landingWeightBars, seatLabel,
  landingLadderSteps, landingFunnelStages, landingChainItems, landingCta, landingCtaNote,
  landingStatsHtml, landingSpineHtml, landingSpineDetailHtml, landingWeightBarsHtml, landingLadderHtml,
  landingFunnelHtml, landingChainHtml, landingRedlinesHtml, renderLanding, pctText,
} from '../web/views/landing.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const APP_JS = readFileSync(join(webDir, 'app.js'), 'utf8');
const NAV_JS = readFileSync(join(webDir, 'nav.js'), 'utf8');
const LANDING_JS = readFileSync(join(webDir, 'views', 'landing.js'), 'utf8');
const STYLES_CSS = readFileSync(join(webDir, 'styles.css'), 'utf8');

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
  const clean = String(hashPath).replace(/^#/, '').replace(/\?.*$/, '');
  return ROUTES.some((r) => routeMatches(r, clean));
}

/** 剥掉注释（只扫代码，不扫注释里的说明文字）。 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ══════════════════════════════════════════════════════════════════
// 一、路由与信息架构
// ══════════════════════════════════════════════════════════════════

test('落地页挂在 /，原总览仪表盘迁到 /dashboard（两者并存）', () => {
  assert.ok(ROUTES.includes('/'), '必须有落地页路由 /');
  assert.ok(ROUTES.includes('/dashboard'), '必须保留 /dashboard（工作台）');
  assert.ok(
    /route\('\/',\s*\(\w+\)\s*=>\s*renderLanding\(\w+\)\)/.test(APP_JS),
    '/ 必须挂 renderLanding',
  );
  assert.ok(
    /route\('\/dashboard',\s*\(\w+\)\s*=>\s*renderHome\(\w+\)\)/.test(APP_JS),
    '/dashboard 必须挂 renderHome（原总览仪表盘，一行内容没删）',
  );
});

test('导航里必须有「工作台」入口，且指向 /dashboard', () => {
  assert.ok(/path:\s*'\/dashboard'/.test(NAV_JS), '导航必须提供 /dashboard 入口');
  assert.ok(/label:\s*'工作台'/.test(NAV_JS));
  assert.ok(/label:\s*'首页'/.test(NAV_JS), '「赛事」分区的第一项必须是首页');
});

test('落地页不需要登录（公开页）—— /dashboard 才需要登录', () => {
  assert.ok(
    /PROTECTED_ROUTES[\s\S]*?pattern:\s*\/\^\\\/dashboard/.test(NAV_JS),
    '/dashboard 必须受登录守卫保护',
  );
  const guardSection = NAV_JS.slice(NAV_JS.indexOf('PROTECTED_ROUTES'));
  const patterns = [...guardSection.matchAll(/pattern:\s*(\/\^[^\n]+)/g)].map((m) => m[1]);
  assert.ok(
    !patterns.some((p) => /\\\/\$/.test(p) && !p.includes('dashboard')),
    `根路径不得进受保护清单（落地页对访客开放）：${patterns.join(' | ')}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// 二、死链闸：落地页里的每个 href 都必须命中真实路由
// ══════════════════════════════════════════════════════════════════

test('死链闸：落地页 CTA 的每个 href 都对应真实路由', () => {
  for (const user of [null, { name: '张三' }, { roles: ['admin'] }]) {
    const cta = landingCta(user);
    const all = [cta.primary, ...cta.secondary];
    for (const l of all) {
      assert.ok(hasRoute(l.href), `死链：CTA 指向 ${l.href}，但路由表里没有（现有：${ROUTES.join(', ')}）`);
    }
  }
});

test('死链闸：落地页渲染出的 HTML 里每个 href 都对应真实路由', async () => {
  const html = await renderLandingHtml();
  const hrefs = [...html.matchAll(/href="(#[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3, `落地页至少要有 3 个链接，实际 ${hrefs.length}`);
  for (const h of hrefs) {
    assert.ok(hasRoute(h), `死链：落地页出现 ${h}，但路由表里没有（现有：${ROUTES.join(', ')}）`);
  }
});

test('死链闸：主导航的每个 path 都对应真实路由（含新增的 /dashboard）', () => {
  const paths = [...NAV_JS.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 7, `导航里应该有 7 条以上的路径（漏扫说明正则失效），实际 ${paths.length}`);
  for (const p of paths) {
    assert.ok(hasRoute(p), `死链：导航项 ${p} 没有对应路由`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 三、赛制不得在前端硬编码
// ══════════════════════════════════════════════════════════════════

test('赛制口径闸：落地页源码里不得出现 rules 里的具体数字', () => {
  const code = codeOnly(LANDING_JS);
  // ⛔ 这些数字来自 rules/*.json（赛程日序、权重表、漏斗比例、晋级率…）
  //    前端写死任何个 = 口径撒谎（委员会改配置后落地页还在说旧话）。
  const forbidden = ['10-01', '10-26', '10-29', '0.10', '0.20', '0.25', '0.35', '0.40', '0.05', '0.30'];
  for (const n of forbidden) {
    assert.ok(!code.includes(n), `落地页不许硬编码赛制数字「${n}」（必须来自 /api/event-info）`);
  }
});

test('赛制口径闸：落地页必须从 /api/event-info 取赛制', () => {
  const code = codeOnly(LANDING_JS);
  assert.ok(code.includes('/api/event-info'), '必须请求 /api/event-info');
});

// ══════════════════════════════════════════════════════════════════
// 四、纯函数：形状与口径
// ══════════════════════════════════════════════════════════════════

test('百分比：0.10 → 10%，0.05 → 5%，0.125 → 12.5%', () => {
  assert.equal(pctText(0.1), '10%');
  assert.equal(pctText(0.05), '5%');
  assert.equal(pctText(0.125), '12.5%');
  assert.equal(pctText(0), '0%');
  assert.equal(pctText(undefined), '—');
});

test('关键数字：固定 4 张卡，且数字与标签成对（不许错位）', () => {
  const stats = landingStats({
    info: { stages: [1, 2, 3, 4, 5], scoring: { initial: { dimensions: [1, 2, 3, 4, 5, 6] } }, tiers: [1, 2, 3, 4, 5] },
    boardCount: 12,
  });
  assert.equal(stats.length, 4);
  assert.deepEqual(stats.map((s) => s.label), ['赛段', '评审维度', '段位', '在榜队伍']);
  assert.deepEqual(stats.map((s) => s.value), [5, 6, 5, 12]);
});

test('关键数字：取不到数时用「—」占位（不是 undefined）', () => {
  const stats = landingStats({ info: {}, boardCount: null });
  assert.equal(stats.length, 4, '卡片数量不许变（变了标签就会错位 —— DP-89）');
  assert.ok(!stats.some((s) => s.value === undefined), '不许出现 undefined');
  assert.equal(stats.at(-1).value, '—');
});

test('赛程脊：节点带 key / 名称 / 日期（日期直接用 rules 的相对日序）', () => {
  const nodes = landingSpineNodes([
    { key: 'S1', name: '调研', start: '10-01', end: '10-10', deliverables: ['企业问题确认书'] },
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].key, 'S1');
  assert.equal(nodes[0].name, '调研');
  assert.equal(nodes[0].date, '10-01 – 10-10');
});

test('赛程详情：交付物来自 rules，且非硬性赛段要说明', () => {
  const d = landingSpineDetail({
    key: 'S5', name: '落地', deliverables: ['试点或意向确认'], hardRequirement: false,
  });
  assert.equal(d.title, 'S5 · 落地');
  assert.deepEqual(d.items, ['试点或意向确认']);
  assert.equal(d.hardRequirement, false);
  // ⚠️ 详情里**不许有 note**：rules 的 note 是内部溯源说明（带文档编号）⇒ 不进公开页。
  assert.equal(d.note, undefined, '公开投影不得带 rules 的原始 note');
  const html = landingSpineDetailHtml(d);
  assert.ok(html.includes('不做硬性交付要求'), '非硬性赛段要说明');
});

test('权重条：权重取自维度，百分比正确，席位中文化', () => {
  const bars = landingWeightBars([
    { key: 'enterprise', name: '企业确认', weight: 0.1, seat: 'enterprise' },
    { key: 'self_eval', name: '自评测', weight: 0.05, seat: 'self' },
  ]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].text, '10%');
  assert.equal(bars[1].text, '5%');
  assert.equal(seatLabel('enterprise'), '企业席');
  assert.equal(seatLabel('judge'), '评委席');
  assert.equal(seatLabel('self'), '自评');
  assert.equal(seatLabel('unknown'), 'unknown');
});

test('段位阶：无权益的段位要明说「暂无额外权益」（不留空白）', () => {
  const steps = landingLadderSteps([
    { key: 'S', name: '验证', minMilestones: 5, requiresBusinessSignoff: true, benefits: ['完赛证明'] },
    { key: 'D', name: '出题', minMilestones: 0, benefits: [] },
  ]);
  assert.ok(steps[0].requirement.includes('里程碑 ≥ 5'));
  assert.ok(steps[0].requirement.includes('需企业签字'));
  assert.deepEqual(steps[0].benefits, ['完赛证明']);
  assert.deepEqual(steps[1].benefits, []);
  const html = landingLadderHtml(steps);
  assert.ok(html.includes('暂无额外权益'), '空白会被读成「没加载出来」');
});

test('漏斗：rate 为 null 时显示「—」（不许显示 0%）', () => {
  const stages = landingFunnelStages([
    { key: 'registration', label: '报名筛选', rate: 0.3 },
    { key: 'coaching', label: '辅导期', rate: null },
  ]);
  assert.equal(stages[0].text, '30%');
  assert.equal(stages[1].text, '—');
  assert.equal(stages[1].rate, null);
  const html = landingFunnelHtml(stages);
  // ⚠️ 判据要精确：`30%</span>` 里**含有** `0%</span>` ⇒ 直接子串匹配会误杀。
  //   所以这里断言「比例格里的内容**恰好**是 —」。
  assert.ok(html.includes('<span class="funnel__rate">—</span>'), 'null 比例的比例格必须显示 —');
  assert.ok(!html.includes('>0%</span>'), 'null 比例不得渲染成 0%');
});

test('破同分链：顺序号连续，作用域中文化', () => {
  const items = landingChainItems([
    { order: 1, key: 'total', label: '总分', scope: 'always' },
    { order: 2, key: 'peer', label: '互评分', scope: 'tied_only' },
  ]);
  assert.deepEqual(items.map((i) => i.order), [1, 2]);
  assert.equal(items[0].scopeText, '始终参与');
  assert.equal(items[1].scopeText, '仅同分时');
});

test('CTA：访客看到「立即报名」，登录后看到「进入工作台」', () => {
  assert.equal(landingCta(null).primary.href, '#/apply');
  assert.equal(landingCta(null).primary.label, '立即报名');
  assert.equal(landingCta({ name: '甲' }).primary.href, '#/dashboard');
  assert.equal(landingCta({ name: '甲' }).primary.label, '进入工作台');
  assert.ok(landingCtaNote(null).length > 0);
});

// ══════════════════════════════════════════════════════════════════
// 五、HTML 转义（服务端数据是外部输入）
// ══════════════════════════════════════════════════════════════════

test('转义闸：赛段名里的 HTML 必须被转义', () => {
  const nodes = landingSpineNodes([
    { key: 'S1', name: '<img src=x onerror=alert(1)>', start: '10-01', end: '10-10', deliverables: [] },
  ]);
  const html = landingSpineHtml(nodes, landingSpineDetail(nodes[0].raw));
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
  assert.ok(html.includes('&lt;img'));
});

test('转义闸：合规红线里的 HTML 必须被转义', () => {
  const html = landingRedlinesHtml([{ key: 'k', label: '<script>alert(1)</script>' }]);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script'));
});

// ══════════════════════════════════════════════════════════════════
// 六、视图行为（DOM 桩）
// ══════════════════════════════════════════════════════════════════

const INFO = {
  stages: [
    { key: 'S1', name: '调研', start: '10-01', end: '10-10', deliverables: ['企业问题确认书'], hardRequirement: true },
    { key: 'S2', name: '任务', start: '10-10', end: '10-13', deliverables: ['任务清单'], hardRequirement: true },
  ],
  advancement: { rate: 0.25, finalTopN: 32 },
  scoring: {
    initial: { dimensions: [{ key: 'a', name: '创新性', weight: 0.2, seat: 'judge' }] },
    final: { dimensions: [{ key: 'a', name: '创新性', weight: 0.2, seat: 'judge' }] },
  },
  tiers: [{ key: 'S', name: '验证', minMilestones: 5, requiresBusinessSignoff: true, benefits: ['完赛证明'] }],
  tierNeverUnlocks: ['奖金', '决赛名次'],
  funnel: [{ key: 'registration', label: '报名筛选', rate: 0.3 }],
  registration: { dimensions: [{ key: 'direction', label: '方向维度', weight: 0.25 }], levels: [{ key: 'S', label: '顶级种子', minScore: 80 }] },
  formation: { teamMin: 2, teamMax: 5, captainMustBeMba: true, teamsPerPackageMin: 2, teamsPerPackageMax: 3, enterpriseQuota: 0.7, freeQuota: 0.3 },
  scoringPoints: { stagePoints: [10, 8, 5], stagePointsOnlyTopN: 3, mvpStagesCounted: 4 },
  tiebreak: [{ order: 1, key: 'total', label: '总分', scope: 'always' }],
  behaviorEvents: [{ key: 'weekly_progress', label: '每周提交一次进度', points: 2 }],
  behaviorMaxWeightShare: 0.1,
  redLines: [{ key: 'ip', label: '知识产权' }],
  visibility: { publicFromTier: 'C' },
};

/** 最小 DOM 桩：够 renderLanding 跑起来。 */
function stubDom() {
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    style: { setProperty() {} },
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  });
  globalThis.window = { location: { search: '', hash: '#/' }, addEventListener() {}, matchMedia: () => ({ matches: true }) };
  globalThis.document = { createElement: (t) => mk(t), getElementById: () => mk('div') };
}

async function bootLanding(user, apiImpl) {
  stubDom();
  const calls = [];
  const ctx = {
    api: {
      get: async (p) => { calls.push(p); return apiImpl ? apiImpl(p) : INFO; },
    },
    getState: () => ({ user }),
  };
  renderLanding(ctx);
  await new Promise((r) => setTimeout(r, 10));
  return calls;
}

test('落地页：请求 /api/event-info 与滚动总榜', async () => {
  const calls = await bootLanding(null);
  assert.ok(calls.includes('/api/event-info'), `必须请求赛制数据，实际：${JSON.stringify(calls)}`);
  assert.ok(calls.some((c) => c.includes('/api/leaderboard/rolling')), '必须请求在榜队伍数');
});

test('落地页：未登录时**不请求**任何需要登录态的端点', async () => {
  const calls = await bootLanding(null);
  for (const c of calls) {
    assert.ok(
      !c.includes('/api/teams') && !c.includes('/api/registrations'),
      `访客不该请求需要登录的端点：${c}`,
    );
  }
});

test('落地页：赛制接口失败时给出**带重试**的错误态（不许是死路）', async () => {
  stubDom();
  const ctx = {
    api: {
      get: async (p) => {
        if (p === '/api/event-info') throw new TypeError('Failed to fetch');
        return { rows: [] };
      },
    },
    getState: () => ({ user: null }),
  };
  renderLanding(ctx);
  await new Promise((r) => setTimeout(r, 10));
  const code = codeOnly(LANDING_JS);
  assert.ok(/data-action="retry"/.test(code), '错误态必须挂重试按钮');
  // ⚠️ 判据必须**钉在重试按钮自己的那一次绑定上**：
  //    `addEventListener?.('click'` 在本文件里出现多次（赛程节点点选也用 click）
  //    ⇒ 只断言「文件里有 click 绑定」会被那些无关绑定顶替 ⇒ 变异存活。
  assert.ok(
    /querySelector\?\.\('\[data-action="retry"\]'\)\?\.addEventListener\?\.\('click'/.test(code),
    '重试按钮必须真的绑定 click（且是它自己的那一次绑定）',
  );
});

// ══════════════════════════════════════════════════════════════════
// 七、交互：结构闸（DOM 桩无法模拟完整交互，故对源码断言）
// ══════════════════════════════════════════════════════════════════

test('交互闸：赛程脊必须绑定点击并切换详情', () => {
  const code = codeOnly(LANDING_JS);
  // ⚠️ 判据要钉在**节点模板的那一行**上：
  //    `data-stage-key` 在接线代码里也出现（getAttribute / querySelectorAll）
  //    ⇒ 只断言「文件里有这个字符串」会被接线代码顶替 ⇒ 变异存活。
  assert.ok(
    /<button[^>]*data-stage-key="\$\{escapeHtml\(n\.key\)\}"/.test(code),
    '赛程节点按钮必须带 data-stage-key',
  );
  assert.ok(/data-spine-detail/.test(code), '必须有详情容器');
  assert.ok(/is-active/.test(code), '选中的节点必须有活动态');
  assert.ok(/aria-pressed/.test(code), '选中态必须同步 aria-pressed（读屏用户能知道当前选中哪个）');
});

test('交互闸：初赛/决赛同名维度必须联动高亮', () => {
  const code = codeOnly(LANDING_JS);
  assert.ok(/data-dim-key/.test(code), '权重条必须带 data-dim-key');
  assert.ok(/mouseenter/.test(code) && /mouseleave/.test(code), '必须绑定悬停联动');
  // ⚠️ 判据要钉在**比较条件**上：只断言「文件里有 is-active」会被别处顶替
  //    （把条件改成恒 false 时依然有 is-active 字样 ⇒ 变异存活）。
  assert.ok(
    /classList\.toggle\('is-active',\s*other\.getAttribute\('data-dim-key'\) === key\)/.test(code),
    '联动高亮必须按 data-dim-key 相等来判定',
  );
});

test('交互闸：数字 count-up 必须在没有 IntersectionObserver 时降级', () => {
  const code = codeOnly(LANDING_JS);
  assert.ok(/IntersectionObserver/.test(code), '必须用 IntersectionObserver 触发');
  assert.ok(/typeof IntersectionObserver === 'undefined'/.test(code), '没有 IntersectionObserver 时必须降级（测试环境就是没有）');
  assert.ok(/prefers-reduced-motion/.test(code), '必须尊重「减少动态效果」');
});

// ══════════════════════════════════════════════════════════════════
// 八、class 差集闸：视图写出的 class 必须都有样式规则
// ══════════════════════════════════════════════════════════════════

test('class 差集闸：落地页用到的 class 都在 styles.css 里有规则', () => {
  const used = new Set();
  for (const m of LANDING_JS.matchAll(/class="([^"$]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  for (const m of LANDING_JS.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) used.add(m[1]);
  for (const m of LANDING_JS.matchAll(/class="([^"]*)\$\{[^}]+\}[^"]*"/g)) {
    // 动态拼接的 class 由各处显式写出，这里只取字面量部分
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  assert.ok(used.size >= 20, `扫到的 class 太少（${used.size}），说明扫描正则失效`);
  const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}\\b`).test(STYLES_CSS));
  assert.equal(missing.length, 0, `这些 class 在 styles.css 里没有规则（样式不会生效）：${missing.join(', ')}`);
});

// ══════════════════════════════════════════════════════════════════
// 九、设计契约闸
// ══════════════════════════════════════════════════════════════════

test('契约闸：hero 标题是全页唯一的 oversized moment（其余标题 ≤ 24px）', () => {
  const titleRule = STYLES_CSS.match(/\.landing__title\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(/clamp\(30px,\s*4\.2vw,\s*40px\)/.test(titleRule), `hero 标题必须用 clamp(30px, …, 40px)，实际：${titleRule}`);
  // ⚠️ 判据要落到「**标题类**规则」上，不能只查字号变量 ——
  //    变量表里有 26px（--fs-2xl），但它是给**数字**用的（.stat__value），不是标题。
  //    ⇒ 扫描所有 .landing* 规则里出现 font-size 的地方，**除 hero 自己**（含它的
  //      窄屏降档写法）以外，都不许超过 24px。
  const landingRules = [...STYLES_CSS.matchAll(/\.([\w-]*landing[\w-]*)[^{]*\{([^}]*)\}/g)];
  const oversized = [];
  for (const [, selector, body] of landingRules) {
    if (selector.includes('landing__title')) continue;   // hero = 唯一的 oversized moment
    const m = body.match(/font-size:\s*(\d+)px/);
    if (!m) continue;
    const size = Number(m[1]);
    if (size <= 24) continue;
    oversized.push(`${selector}=${size}px`);
  }
  assert.deepEqual(oversized, [], `落地页里除 hero 外不得有超过 24px 的字号，实际：${oversized.join(', ')}`);
  assert.ok(/--fs-xl:\s*20px/.test(STYLES_CSS), '分节标题用 --fs-xl(20px)');
  // 窄屏降档：≤700px 用 26px（仍是全页最大）
  assert.ok(/\.landing__title\s*\{\s*font-size:\s*26px/.test(STYLES_CSS), '窄屏 hero 标题必须降一档到 26px');
});

test('契约闸：圆角已收紧到 midnight 的量级（sm 4 / md 6 / lg 10 / xl 14）', () => {
  assert.ok(/--r-sm:\s*4px/.test(STYLES_CSS));
  assert.ok(/--r-md:\s*6px/.test(STYLES_CSS));
  assert.ok(/--r-lg:\s*10px/.test(STYLES_CSS));
  assert.ok(/--r-xl:\s*14px/.test(STYLES_CSS));
});

test('契约闸：暗色是默认主题，且实底按钮用深色字（白字压强调色不合格）', () => {
  const root = STYLES_CSS.slice(0, STYLES_CSS.indexOf(':root[data-theme="light"]'));
  assert.ok(/--bg:\s*#0b0d12/.test(root), '暗色底必须是默认');
  assert.ok(/--brand:\s*#7c9cff/.test(root));
  assert.ok(/--on-brand:\s*#0b0d12/.test(root), '压 accent 实底的文字必须是深色（白字只有 2.6:1）');
});

test('契约闸：所有动效都尊重 prefers-reduced-motion', () => {
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(STYLES_CSS), '必须有 reduced-motion 分支');
  const reduceIdx = STYLES_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduceIdx > 0, 'reduced-motion 分支必须存在');
});

// ── 辅助：渲染一次落地页拿到完整 HTML（供死链闸用）──────────────────
async function renderLandingHtml() {
  stubDom();
  const captured = [];
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    style: { setProperty() {} },
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  });
  // 让 wrap.innerHTML 的内容能被读到：stub 里记录每次 innerHTML 赋值
  globalThis.document = {
    createElement: (t) => {
      const el = mk(t);
      let _html = '';
      Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) { _html = v; captured.push(v); },
      });
      return el;
    },
    getElementById: () => mk('div'),
  };
  const ctx = {
    api: { get: async () => INFO },
    getState: () => ({ user: null }),
  };
  renderLanding(ctx);
  await new Promise((r) => setTimeout(r, 10));
  return captured.join('\n');
}

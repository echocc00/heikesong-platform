// platform/test/ui-committee-contract.test.js — 委员会操作台的 UI 契约闸
//
// ⚠️ **为什么要有这个文件**（P12 的由来）：
//   P11 新建的四个委员会页（赛段配置 / 破同分 / 公开链接 / 审计日志）**页面专属 class 数为 0**
//   ⇒ 四页全是同一套通用卡片栈一字排开（实测顶层结构恒为
//      `header.page__head + 若干 section.panel`）⇒ 访客分不清自己在哪一页、
//      面板之间没有主次、「我现在操作的是哪一个对象」没有位置放。
//   本文件把「改造后的形状」与「改造时修掉的真缺陷」**固化成机器闸**，
//   免得下次改版又退回成「一串同款面板」。
//
// 覆盖的闸：
//   ① 四个委员会页都必须是**操作台**（左轨选对象 + 右画布做操作）
//   ② 四个页面各有自己的**根 class**（页面身份），且在 styles.css 里有规则
//   ③ **触控目标**：勾选框/单选框必须 ≥ 24px（WCAG 2.5.8 AA 硬线）
//   ④ **强调色**：勾选色必须经 token（浏览器默认的 #0075FF 是设计系统里没声明过的色相）
//   ⑤ 操作台区块**零外阴影**（P10 签名动作①）+ **颜色只经 token**
//   ⑥ 视图层**不许**写 <style> 标签、不许写字面色值
//
// 运行：node --test（cwd = platform/）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageConfigPageHtml, stageListHtml } from '../web/views/stages.js';
import { tiebreakPageHtml } from '../web/views/tiebreak.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const read = (rel) => readFileSync(join(webDir, rel), 'utf8');

const CSS = read('styles.css');
const UI = read('ui.js');

const VIEWS = {
  stages: read('views/stages.js'),
  tiebreak: read('views/tiebreak.js'),
  'public-links': read('views/public-links.js'),
  'audit-log': read('views/audit-log.js'),
};

/** 四个委员会页各自的页面根 class（页面身份）。 */
const PAGE_ROOTS = {
  stages: 'stagecfg-view',
  tiebreak: 'tiebreak-view',
  'public-links': 'publinks-view',
  'audit-log': 'auditlog-view',
};

/** 取出 styles.css 里 ⑫ 段（委员会操作台）的原文。 */
function workbenchSection() {
  const start = CSS.indexOf('⑫ P12');
  assert.ok(start > 0, 'styles.css 里必须有 ⑫ 段（委员会操作台）');
  const end = CSS.indexOf('/* 打印：', start);
  return CSS.slice(start, end > start ? end : CSS.length);
}

/**
 * 取一个导出函数的完整源码。
 * ⚠️ 不能用 `fn.indexOf('\n}')` 截断：解构参数里就有换行后的 `}`（`} = {}) {`），
 *    会把函数体切掉一大截 ⇒ 断言在错误的片段上跑。
 */
function fnSource(name) {
  const i = UI.indexOf(`export function ${name}(`);
  assert.ok(i > 0, `ui.js 里必须有 ${name}()`);
  const rest = UI.slice(i);
  const j = rest.indexOf('\nexport ');
  return j > 0 ? rest.slice(0, j) : rest;
}

/** 去掉注释（行注释 + 块注释）—— 扫源码查违禁词时，注释里的说明不算。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ═════════════════════════════════════════════════════════════════════
// ① 形状闸：四页都必须是操作台
// ═════════════════════════════════════════════════════════════════════

test('闸 ①：四个委员会页都必须走 ui.js 的操作台骨架（左轨 + 右画布）', () => {
  for (const [name, src] of Object.entries(VIEWS)) {
    assert.ok(
      /import\s*\{[^}]*\bworkbench\b[^}]*\}\s*from\s*'\.\.\/ui\.js'/.test(src),
      `${name} 必须从 web/ui.js 导入 workbench（骨架只有一份，不许各页各写一遍）`
    );
    assert.ok(
      /workbench\s*\(\s*\{/.test(src),
      `${name} 必须真的调用 workbench()，不是只导入`
    );
  }
});

test('闸 ①：ui.js 的 workbench() 产出左轨 + 右画布两个容器', () => {
  const body = fnSource('workbench');
  assert.ok(body.includes('class="workbench"'), '要有 workbench 根容器');
  assert.ok(body.includes('class="workbench__rail"'), '要有左轨（aside）');
  assert.ok(body.includes('class="workbench__canvas"'), '要有右画布');
  assert.ok(body.includes('<aside'), '左轨必须是 aside（语义：导航区）');
});

test('闸 ①：赛段配置页渲染出来是双栏（不是一串裸面板）', () => {
  const html = stageConfigPageHtml({ loading: false, stages: [], editions: [] });
  assert.ok(html.includes('class="workbench"'), '要有操作台根容器');
  assert.ok(html.includes('class="workbench__rail"'), '要有左轨');
  assert.ok(html.includes('class="workbench__canvas"'), '要有右画布');
  // ⚠️ 旧形状是「6 张同款面板一字排开」⇒ 现在左轨里才是选择器，面板在画布里。
  const railEnd = html.indexOf('workbench__canvas');
  assert.ok(railEnd > 0 && html.indexOf('class="workbench__rail"') < railEnd, '左轨在画布之前');
});

test('闸 ①：破同分页渲染出来也是双栏', () => {
  const html = tiebreakPageHtml({ loading: false, stages: [] });
  assert.ok(html.includes('class="workbench"'), '要有操作台根容器');
  assert.ok(html.includes('class="workbench__rail"'), '要有左轨');
  assert.ok(html.includes('class="workbench__canvas"'), '要有右画布');
});

test('闸 ①：加载中不许闪一句假空态（列表还没到就显示「还没有赛段」）', () => {
  const html = stageConfigPageHtml({ loading: true });
  assert.ok(html.includes('state--loading'), '加载态要有骨架');
  assert.ok(!html.includes('本届期还没有赛段'), '加载中不许出现「本届期还没有赛段」这句假消息');
});

// ═════════════════════════════════════════════════════════════════════
// ② 页面身份闸
// ═════════════════════════════════════════════════════════════════════

test('闸 ②：四个页面各有自己的根 class，且在 styles.css 里有规则', () => {
  for (const [name, root] of Object.entries(PAGE_ROOTS)) {
    assert.ok(
      VIEWS[name].includes(`'stack ${root}'`),
      `${name} 视图的根 class 必须是 'stack ${root}'`
    );
    assert.ok(
      new RegExp(`\\.${root.replace(/-/g, '\\-')}[^\\w-]`).test(CSS),
      `${root} 在 styles.css 里没有规则（⇒ 样式不会生效，页面还是长得一样）`
    );
  }
});

test('闸 ②：页面根 class 不得互相串用（四页必须是四个不同的身份）', () => {
  const roots = Object.values(PAGE_ROOTS);
  assert.equal(new Set(roots).size, roots.length, '四个页面根 class 必须互不相同');
});

// ═════════════════════════════════════════════════════════════════════
// ③ 触控目标闸（WCAG 2.5.8 AA）
// ═════════════════════════════════════════════════════════════════════

test('闸 ③：勾选框/单选框必须 ≥ 24×24（WCAG 2.5.8「目标尺寸（最小）」AA 硬线）', () => {
  const idx = CSS.indexOf('input[type="checkbox"]');
  assert.ok(idx > 0, 'styles.css 必须显式给勾选框/单选框定尺寸（浏览器默认只有 13×13）');
  const rule = CSS.slice(idx, CSS.indexOf('}', idx));
  const w = rule.match(/width:\s*(\d+)px/);
  const h = rule.match(/height:\s*(\d+)px/);
  assert.ok(w, '勾选框规则里必须有显式 width');
  assert.ok(h, '勾选框规则里必须有显式 height');
  assert.ok(Number(w[1]) >= 24, `勾选框宽度 ${w[1]}px < 24px ⇒ 违反 WCAG 2.5.8 AA`);
  assert.ok(Number(h[1]) >= 24, `勾选框高度 ${h[1]}px < 24px ⇒ 违反 WCAG 2.5.8 AA`);
});

test('闸 ④：勾选色必须经 token（浏览器默认的 #0075FF 是设计系统里没声明过的色相）', () => {
  const idx = CSS.indexOf('input[type="checkbox"]');
  const rule = CSS.slice(idx, CSS.indexOf('}', idx));
  assert.ok(
    /accent-color:\s*var\(--[a-z-]+\)/.test(rule),
    'accent-color 必须走 CSS 变量（token），不许写字面色值'
  );
  assert.ok(!/accent-color:\s*#[0-9a-f]{3,8}/i.test(rule), 'accent-color 不许写字面色值');
});

// ═════════════════════════════════════════════════════════════════════
// ⑤ 操作台区块的材质纪律
// ═════════════════════════════════════════════════════════════════════

test('闸 ⑤：操作台区块零外阴影（卡片深度靠底色差 + 顶边高光 + 顶面渐变）', () => {
  const section = workbenchSection();
  const shadows = [...section.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]);
  for (const s of shadows) {
    const v = s.trim();
    // ⚠️ `none` 是「显式关掉阴影」（轨内面板要平）⇒ 合法；其余必须带 inset。
    if (v === 'none') continue;
    assert.ok(
      /inset/.test(v),
      `box-shadow "${v}" 不是 inset ⇒ 是外阴影，违反 P10 签名动作①`
    );
  }
});

test('闸 ⑤：操作台区块颜色只经 token（不许字面色值）', () => {
  const section = workbenchSection();
  const hex = [...section.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
  assert.deepEqual(hex, [], `操作台区块里不许出现字面色值：${hex.join(', ')}`);
  const rgb = [...section.matchAll(/\b(?:rgba?|hsla?)\(/gi)].map((m) => m[0]);
  assert.deepEqual(rgb, [], `操作台区块里不许出现字面色值：${rgb.join(', ')}`);
});

test('闸 ⑤：材质三件套只用既有 token（底色差 / 顶边高光 / 顶面渐变）', () => {
  const section = workbenchSection();
  assert.ok(section.includes('var(--surface)'), '要用底色差（surface）');
  assert.ok(section.includes('var(--sheen)'), '要用顶面渐变（sheen）');
  assert.ok(section.includes('var(--hairline)'), '要用顶边 1px 高光（hairline）');
});

// ═════════════════════════════════════════════════════════════════════
// ⑥ 视图层纪律
// ═════════════════════════════════════════════════════════════════════

test('闸 ⑥：四个委员会视图都不许写 <style> 标签', () => {
  for (const [name, src] of Object.entries(VIEWS)) {
    // ⚠️ 注释里写着「不写 <style>」的说明不算 ⇒ 先去注释再扫。
    assert.ok(
      !/<style[\s>]/i.test(stripComments(src)),
      `${name} 不许写 <style> 标签（页面样式一律进 styles.css）`
    );
  }
});

test('闸 ⑥：四个委员会视图都不许写字面色值', () => {
  for (const [name, src] of Object.entries(VIEWS)) {
    // ⚠️ 只查 style="…" 属性里的颜色（行内样式）；注释里的说明不算。
    const inline = [...src.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
    for (const s of inline) {
      assert.ok(
        !/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(s),
        `${name} 的行内样式里有字面色值：${s}`
      );
    }
  }
});

test('闸 ⑥：视图里出现的 class 名都必须在 styles.css 里有规则', () => {
  for (const [name, src] of Object.entries(VIEWS)) {
    const used = new Set();
    for (const m of src.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls) used.add(cls);
    }
    const missing = [...used].filter(
      (cls) => !new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}[^\\w-]`).test(CSS)
    );
    assert.deepEqual(missing, [], `${name}：这些 class 在 styles.css 里不存在：${missing.join(', ')}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// ⑦ 左轨条目的形状
// ═════════════════════════════════════════════════════════════════════

test('闸 ⑦：左轨条目用 ui.js 的 workbenchItem（条件 class 不许在视图里拼）', () => {
  assert.ok(UI.includes('export function workbenchItem('), 'ui.js 必须提供 workbenchItem');
  assert.ok(
    /import\s*\{[^}]*\bworkbenchItem\b[^}]*\}\s*from\s*'\.\.\/ui\.js'/.test(VIEWS.stages),
    'stages 视图必须从 ui.js 导入 workbenchItem'
  );
});

test('闸 ⑦：当前赛段用 is-active + aria-current 标出（不用禁用按钮表达）', () => {
  const html = stageListHtml([
    { id: 'st_1', key: 'initial', name: '初赛', kind: 'initial', status: 'draft', startsAt: '', endsAt: '' },
  ], 'st_1');
  assert.ok(html.includes('is-active'), '当前项要有 is-active');
  assert.ok(html.includes('aria-current="true"'), '当前项要有 aria-current');
  assert.ok(!html.includes('disabled'), '当前项不置 disabled（禁用按钮会被读屏跳过）');
  assert.ok(html.includes('data-stage-id="st_1"'), '要带赛段 id');
});

test('闸 ⑦：workbenchItem 的 data-* 键名必须过白名单（不能拼任意属性名）', () => {
  const body = fnSource('workbenchItem');
  assert.ok(
    /\[a-z\]\[a-z0-9-\]\*/.test(body),
    'data-* 的键名必须用白名单正则过滤（它是拼进 HTML 的属性名）'
  );
});

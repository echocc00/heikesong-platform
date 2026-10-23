# P12 · UI 改造：把「四页长得一样」变成「四种工作台」（2026-10-23）

## 0. 一句话

P11 把赛段配置 / 破同分 / 公开链接 / 审计日志四个委员会页**接上了**，
但它们**页面专属 class 数为 0** ⇒ 四页全是同一套通用卡片栈一字排开（顶层结构恒为
`header.page__head + 若干 section.panel`）⇒ **访客分不清自己在哪一页、面板之间没有主次、
「我现在操作的是哪一个对象」在页面上没有位置放**。
本阶段做一次**改造式（retrofit）**：保留 P10「midnight」视觉语言与信息架构、**不换调色盘**，
把四个页面改成**操作台（workbench）双栏**（左轨选对象 + 右画布做操作），
并把改造过程中量到的**两个真缺陷**（勾选框小于 WCAG 硬线、勾选色是设计系统里没声明过的色相）修掉。

---

## 1. 诊断：改之前是什么样（实测，不是审美）

### 1.1 基线怎么量的

- **静态**：`ui-design` skill 的 `extract-design.mjs`（70 个 custom props / 797 处 `var()` / 18 色）
  与 `ui-source-audit.mjs`（13 findings；HIGH 项全在**测试文件**里，非出厂 UI）。
- **渲染**：本地演示站（`PORT=8092` + `platform/web/dist`），Playwright 量六视口
  （360 / 390 / 768 / 1024 / 1440 / 1920），测**页面高度 / 表面签名 / 触控目标 / 强调色档数 / console 错误**。
  - ⚠️ 移动视口必须 `isMobile + hasTouch` ⇒ Chromium 才报 `pointer: coarse`，
    否则 ⑯ 段的触控规则不生效，量到的是「桌面鼠标口径」的假数据。

### 1.2 六个发现（按严重度）

| # | 发现 | 实测 | 判定 |
|---|---|---|---|
| ① | **四个委员会页零专属 class** | `stages` 页用到的 **77 个 class 全是通用类**；顶层 `div.stack > header + div.stat-row + section.panel × 6` | **设计缺口**（页面没有自己的形状） |
| ② | **勾选框 13×13** | `stages` 5 个、`tiebreak` 5 个 —— 低于 **WCAG 2.5.8「目标尺寸（最小）」24×24 的 AA 硬线** | **真缺陷**（无障碍硬失败） |
| ③ | **勾选色是设计系统里没有的色相** | 浏览器默认勾选蓝 = Chrome `#0075FF` ⇒ `stages` 桌面端**强调色 4 档**（纪律是 ≤3） | **真缺陷**（违反「颜色只经 token」） |
| ④ | **卡面同质** | `tiebreak` 6/10 个面共用同一签名（`10px|inset hairline|0px`） | **设计缺口**（没有按角色分化） |
| ⑤ | **触屏目标偏小** | 落地页 3 个赛程脊节点 35px + 3 个页脚链接宽 24–36px（高 43.8px，**差 0.2px** 到不了 44） | **真缺陷**（Apple HIG 44×44） |
| ⑥ | **1 处字面色值越界** | 落地页 hero 的 `rgba(124,156,255,.13)` 写死在 CSS 里 ⇒ 亮色主题切不掉 | **真缺陷**（违反 token 纪律） |

> 另：4 处 1px/2px 的间距偏离 4pt 网格 —— 逐个看过，**全部是有意的**
> （1px = 发丝线分隔法；2px = 光学紧距；7px/14px = 赛程脊轴的对齐解算）⇒ **不改数值，补溯源注释**。

---

## 2. 设计契约（P12）

### 2.1 签名（signature）：**形状，不是皮肤**

⛔ 本阶段**不新增任何颜色、不换调色盘**（P10「midnight」语言保持）。
差异化只发生在**宏观结构**（macrostructure）：

> **委员会操作页 = 操作台双栏：左轨选对象 + 右画布做操作。**

四个页面各有自己的**根 class**（页面身份），左轨处理按**角色**分化：

| 页面 | 根 class | 左轨的**角色** | 左轨材质 |
|---|---|---|---|
| 赛段配置 | `stagecfg-view` | **导航器**（选届期 / 赛段） | 凹陷通道（`--surface-sunken`） |
| 破同分 | `tiebreak-view` | **上下文选择器**（选赛段） | 描边（`--surface` + 材质三件套） |
| 公开链接 | `publinks-view` | **操作表单**（签发） | 浮起（`--surface-raised` + 材质三件套） |
| 审计日志 | `auditlog-view` | **过滤条**（筛条件） | 平（只描边不填充） |

- 画布内的面板一律 **raised**（材质三件套：底色差 + 顶边 1px 高光 + 顶面渐变）。
- 轨内当前对象 = **tinted**（`--brand-soft` + `--brand-line`）。
- **卡片零外阴影**（P10 签名动作①）—— 深度只靠底色差 + 顶边高光 + 顶面渐变。

### 2.2 度量（measure）：数字与来源

| 指标 | 判据 | 来源 | 改前 | 改后 |
|---|---|---|---|---|
| 勾选框 / 单选框 | **≥ 24×24** | WCAG 2.5.8「目标尺寸（最小）」AA 硬线 | 13×13 ❌ | 24×24 ✅ |
| 勾选色 | 必须经 token | 「颜色只经 token」+「每屏强调色 ≤3」 | `#0075FF`（未声明色相） | `var(--brand)` |
| 每屏强调色档数 | **≤ 3** | P10 视觉纪律 | 4 ❌ | 2 ✅ |
| 触屏目标 | **≥ 44×44** | Apple HIG 44×44 | 6 个 < 44px ❌ | 0 ✅ |
| 渐变背景上的文字 | 正文 ≥ 4.5:1 / 大字 ≥ 3:1 | WCAG 1.4.3 AA | 工具测不了 | 实算最低 **5.66:1** ✅ |
| 卡面同签名占比 | 越低越好 | card-kit 检查 | 12/35 | 8/35 |
| 颜色越界（字面色值） | 0 | token 纪律 | 1 处 | 0 ✅ |

### 2.3 沿用 P10 的纪律（不变）

- 每屏强调色 ≤ 3；hero 标题是全页唯一 oversized moment。
- 卡片零外阴影；深度靠材质三件套。
- **视图层不许写 `<style>` 标签、不许写字面色值**；
  页面专属样式块一律写进 `platform/web/styles.css`（先例：⑪ `.signoff-*`、⑫ `.workbench-*`）。
- 条件 class 走**组件层**（`badge` 的 extraClass / `panel` 的 tone / `tableWrap` 的 className），
  **视图里不许用模板表达式拼 class**（机器闸按 `class="…"` 字面量抽类名）。

---

## 3. 改动清单

### 3.1 token 层（`platform/web/styles.css`，P0 owns ⇒ 同步回 P0）

| 改动 | 理由 |
|---|---|
| 新增 `--brand-glow`（暗 `rgba(124,156,255,.13)` / 亮 `rgba(47,95,224,.10)`） | 落地页 hero 的品牌辉光原先写死字面色 ⇒ 亮色主题切不掉 |
| 新增 `input[type="checkbox"] / [type="radio"]` 规则：**24×24 + `accent-color: var(--brand)`** | 一次修掉两个真缺陷（②③） |
| ⑯ 段补：页脚链接 `min-height: 44px` + 左右内边距 | 43.8px 差 0.2px 到不了 44（子像素）⇒ 用 `min-height` 兜住 |
| 赛程脊节点触屏 `min-height: 44px`（**写在赛程脊自己段落里**） | 上游 `.spine__node { min-height: 0 }` 源码更靠后，写进 ⑯ 段会被盖掉（实测踩过） |
| 4 处 1px/2px 补**溯源注释** | 有意的发丝线 / 光学紧距 / 对齐解算 ⇒ 数值不动，但必须写清为什么 |
| 新增 **⑫ 段：委员会操作台** | 骨架 + 四页材质分化 |
| `.ruletile` 补材质三件套；`.ruletile--wide` 抬高一档 | 规则磁贴原先只有底色 + 边框，与其它面不是一套语汇 |

### 3.2 组件层（`platform/web/ui.js`，P7 owns ⇒ 同步回 P7）

- 新增 `workbench({ rail, canvas })` —— 操作台骨架（**四页共用一份**）。
- 新增 `workbenchItem({ key, name, meta, active, action, dataKey, dataValue })` —— 轨内条目
  （条件 class 走组件层；`data-*` 键名过白名单正则）。

### 3.3 四个视图（P11 owns ⇒ 同步回 P11）

| 文件 | 改动 |
|---|---|
| `web/views/stages.js` | 根 class `stagecfg-view`；页结构改操作台；**赛段列表由 6 列表格改成左轨条目列表**（表格放不进 300px 轨）；当前赛段用 `is-active` + `aria-current`（**不用 disabled**，禁用按钮会被读屏跳过）；加载中不闪假空态 |
| `web/views/tiebreak.js` | 根 class `tiebreak-view`；页结构改操作台；轨标题「赛段」→「选择赛段」（原来与字段标签重复） |
| `web/views/public-links.js` | 根 class `publinks-view`；签发表单进轨、结果进画布；**三个挂载点 `data-stats` / `data-issued` / `data-list` 保留**（局部重绘靠它们定位） |
| `web/views/audit-log.js` | 根 class `auditlog-view`；过滤条进轨、审计流水进画布；`#al-stats` / `#al-msg` / `#al-state` / `#al-body` 四个挂载点保留 |

### 3.4 落地页

- 见 3.1（辉光 token + 规则磁贴材质 + 触屏底线）。
- ⛔ **8 个窄磁贴保持完全一致** —— 它们是同一个栅格里的**同级条目**，统一才是语义；
  `design-audit` 的 card-kit 检查分不清「同级栅格」与「一锅卡片汤」⇒ 记为**已知误报**。

---

## 4. 验收口径

1. **形状**：四个页面的顶层结构里都有 `.workbench > .workbench__rail + .workbench__canvas`；
   四个根 class 互不相同且在 `styles.css` 里有规则。
2. **无障碍**：勾选框 ≥ 24×24（WCAG 2.5.8 AA）；触屏目标 ≥ 44×44（Apple HIG）；
   渐变背景上的文字实测对比度 ≥ 4.5:1（正文）。
3. **色相**：每屏强调色 ≤ 3 档；勾选色经 token；**字面色值 0 处**。
4. **材质**：操作台区块零外阴影；只用既有材质 token。
5. **视图纪律**：四个视图无 `<style>` 标签、无线内字面色值、class 全在 `styles.css` 里有规则。
6. **闸**：新增 `platform/test/ui-committee-contract.test.js`（18 例）—— 把上面五条**固化成机器闸**。
7. **回归**：`node --test`（cwd = `platform/`）全绿；四机器闸退出码全 0；
   漂移审计 **C-RW = 0**；`ui-source-audit` **不新增 high**。

---

## 5. 纪律（沿用 P0–P11）

- 文件归属：最早建立者 owns，后续阶段 Modify；改既有文件 ⇒ **逐字同步回 owning 阶段计划块**。
- 硬纪律：计划是规格 ⇒ 代码块**逐字一致**；**先跑后派**；**变异检验**；**测试数据必须判别性**；
  台账编号不重号。
- 零依赖、零构建、可移植、跨平台稳定；不引网络字体 / 图片；原生 ESM。

---

## 6. 规格块（P12 新建文件 · 逐字）


### `platform/test/ui-committee-contract.test.js`

P12 新建：委员会操作台的 UI 契约闸（18 例）—— 把「四页必须走操作台骨架」「勾选框必须 ≥24px（WCAG 2.5.8 AA 硬线）」「勾选色必须经 token」「操作台区块零外阴影 + 颜色只经 token」「视图层不许写 style 标签 / 字面色值」固化成机器闸。

```javascript
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
```
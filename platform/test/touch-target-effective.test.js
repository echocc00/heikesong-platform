// platform/test/touch-target-effective.test.js — 触控目标的「有效可点区」闸
//
// ⚠️ **为什么要有这个闸**（2026-10-23 外部复核 + 本机实测）：
//   复选框**本身**是 24×24（WCAG 2.5.8「目标尺寸（最小）」AA 硬线达标），
//   但**真正可点的是它所在的那一行** —— `<label>` 包着「勾选框 + 队名」，
//   点队名会勾上（实测：before=false → after=true）。
//   而 label 的 **border box 只有 24px 高**（`label` 的上下 margin 不算进盒高）⇒
//   触屏上**整条可点区只有 24px 高**，低于 44px 的平台舒适线（Apple HIG）。
//
//   ⇒ 修法是**垫行**（触屏口径下 `label:has(> input[type=checkbox]) { min-height: 44px }`），
//     **不是**把方块撑到 44px —— 44px 的方块在密集列表里非常难看。
//   ⇒ 外部工具（ui-design 的 design-audit）会为这一条报 low：那是**准确的**，
//     它量的是 input 元素本身，而人手指点的是那一行。
//
// 本闸守住三条不变量：
//   ① 视图产出的每一个 checkbox/radio 都**必须被 label 包着**
//      —— 否则「点旁边的文字也能勾」不成立 ⇒ 可点区真的只有那个 24px 的小方块；
//   ② styles.css 必须有「触屏口径把 label 垫到 44px」的那条规则；
//   ③ 那条规则必须**只在 pointer: coarse 下生效**（桌面密度不变 —— 鼠标能精确指着）。
//
// 运行：node --test（cwd = platform/）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageConfigPageHtml } from '../web/views/stages.js';
import { tiebreakPageHtml } from '../web/views/tiebreak.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, '..', 'web', 'styles.css'), 'utf8');

// ── 两个会渲染出勾选框的页面（数据最小集，只要能走到勾选框那一段）────────

const STAGES_HTML = stageConfigPageHtml({
  loading: false,
  editions: [{ id: 'ed_1', name: '2026 届' }],
  stages: [{ id: 'st_1', key: 'initial', name: '初赛', kind: 'initial', status: 'draft' }],
  editionId: 'ed_1',
  stageId: 'st_1',
  stage: { id: 'st_1', key: 'initial', name: '初赛', kind: 'initial' },
  teams: [{ id: 't_1', name: '拾光队' }, { id: 't_2', name: '回声队' }],
  rosterTeamIds: [],
  configs: [],
});

const TIEBREAK_HTML = tiebreakPageHtml({
  loading: false,
  stages: [{ id: 'st_1', name: '初赛' }],
  stageId: 'st_1',
  round: { id: 'r_1', status: 'open' },
  roster: [{ id: 't_1', name: '拾光队' }, { id: 't_2', name: '回声队' }],
  minutes: 10,
});

test('闸 ①：两个页面都真的渲染出了勾选框（否则下面的断言是空跑）', () => {
  assert.ok(STAGES_HTML.includes('type="checkbox"'), '赛段配置页应渲染出名册勾选框');
  assert.ok(TIEBREAK_HTML.includes('type="checkbox"'), '破同分页应渲染出同分队伍勾选框');
});

test('闸 ①：每一个勾选框都必须被 <label> 包着（点旁边的文字也要能勾上）', () => {
  for (const [name, html] of [['赛段配置', STAGES_HTML], ['破同分', TIEBREAK_HTML]]) {
    // 逐个取出「input 之前最近的未闭合标签」，判定它是不是 label
    const inputs = [...html.matchAll(/<input\b[^>]*type="(?:checkbox|radio)"[^>]*>/g)];
    assert.ok(inputs.length > 0, `${name}：没找到勾选框`);
    for (const m of inputs) {
      const before = html.slice(Math.max(0, m.index - 400), m.index);
      // 最近的未闭合开标签 ⇒ 必须是 label
      const opens = [...before.matchAll(/<([a-z][a-z0-9-]*)\b(?![^>]*\/>)[^>]*>/gi)];
      const last = opens.length ? opens[opens.length - 1][1].toLowerCase() : '';
      assert.equal(
        last, 'label',
        `${name}：有一个勾选框没被 <label> 包住（它前面最近的标签是 <${last}>）`
      );
    }
  }
});

test('闸 ②：styles.css 必须有「触屏口径把 label 垫到 44px」的规则', () => {
  const idx = CSS.indexOf('label:has(> input[type="checkbox"])');
  assert.ok(idx > 0, 'styles.css 里必须有 label:has(> input[type="checkbox"]) 这条规则');
  const rule = CSS.slice(idx, CSS.indexOf('}', idx));
  const m = rule.match(/min-height:\s*(\d+)px/);
  assert.ok(m, '那条规则里必须有显式 min-height');
  assert.ok(
    Number(m[1]) >= 44,
    `label 的 min-height 是 ${m[1]}px < 44px ⇒ 触屏上的有效可点区仍然太矮`
  );
});

test('闸 ③：那条规则只在 pointer: coarse 下生效（桌面密度不变）', () => {
  // 取「该规则所在的那个 @media 块」—— 判据：块内出现 pointer: coarse，且规则**不在**块外。
  const idx = CSS.indexOf('label:has(> input[type="checkbox"])');
  const blockStart = CSS.lastIndexOf('@media', idx);
  const block = CSS.slice(blockStart, CSS.indexOf('}', CSS.indexOf('}', idx)) + 1);
  assert.ok(
    /pointer:\s*coarse/.test(block),
    'label:has(...) 那条规则必须落在 @media (pointer: coarse) 里'
  );
  assert.ok(
    !new RegExp(`^[^@]*label:has\\(> input\\[type="checkbox"\\]\\)`, 'm').test(
      CSS.slice(0, blockStart)
    ),
    'label:has(...) 不许在 pointer: coarse 之外再出现一份无条件规则'
  );
});

test('闸 ④：勾选框本身仍须 ≥24×24（WCAG 2.5.8 AA 硬线，不能靠垫行来替代）', () => {
  const idx = CSS.indexOf('input[type="checkbox"]');
  assert.ok(idx > 0, 'styles.css 必须显式给勾选框定尺寸');
  const rule = CSS.slice(idx, CSS.indexOf('}', idx));
  const w = rule.match(/width:\s*(\d+)px/);
  const h = rule.match(/height:\s*(\d+)px/);
  assert.ok(w && h, '勾选框规则里必须有显式 width / height');
  assert.ok(Number(w[1]) >= 24, `勾选框宽 ${w[1]}px < 24px`);
  assert.ok(Number(h[1]) >= 24, `勾选框高 ${h[1]}px < 24px`);
});

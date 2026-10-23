// platform/test/view-markdown-leak.test.js —— 全站视图：用户可见文案里**不许**漏出 markdown 标记
//
// ⛔ **这个闸为什么存在**（浏览器实测抓到的真缺陷 · E158）：
//   本仓前端**不渲染 markdown** ——
//     · `noticeState` 走 `escapeHtml`（web/ui.js:128-135）⇒ 提示条里是纯文本；
//     · `field__hint` / `muted small` 是纯文本标签；
//     · `pageHead` / `panel` 的说明文字同理。
//   ⇒ 文案里写 `观察席**无投票权**`，用户在页面上看到的就是**字面的两个星号**。
//
//   实际怎么发现的：E158 在公网演示站浏览器实跑「赛段配置」页时，
//   在「席位」下方看到「观察席**无投票权**」—— 一眼看出来的排版脏点。
//   同一次扫描还抓到 publish.js 的二次确认文案「会按**当前评分**清空旧名次…」（P8 起的旧账）。
//
// ⚠️ 注释里用 `**` 做强调是**仓库惯例**（溯源注释大量使用）⇒ 只查**非注释行**。
// ⚠️ JS 的幂运算符 `**` 是**代码**，不是文案 ⇒ 排除（`1 - (1 - t) ** 3` 这类）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(here, '..', 'web', 'views');

/**
 * 去掉注释后的行（只用于**扫描**，不参与运行）。
 * @param {string} src
 * @returns {string[]}
 */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const s = line.trim();
    if (inBlock) {
      if (s.includes('*/')) inBlock = false;
      continue;
    }
    if (s.startsWith('/*')) {
      inBlock = !s.includes('*/');
      continue;
    }
    if (s.startsWith('//') || s.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

test('⛔ 全站视图：用户可见文案里不许漏出 markdown 星号（`**`）', () => {
  const offenders = [];
  for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(viewsDir, file), 'utf8');
    codeLines(src).forEach((line, i) => {
      if (!line.includes('**')) return;
      // ⛔ 排除 JS 幂运算符：`a ** b`（等号 / 运算符语境），它不是文案。
      if (/\S\s\*\*\s\S/.test(line) && !/['"`]/.test(line)) return;
      offenders.push(`${file}: ${line.trim().slice(0, 130)}`);
    });
  }
  assert.deepEqual(offenders, [], `这些行的文案里带了 markdown 星号（前端不渲染 markdown ⇒ 用户看到的是字面星号）：\n${offenders.join('\n')}`);
});

test('⛔ 全站视图：中文文案里不许出现**落单**的星号（多半是 markdown 写了一半）', () => {
  // ⛔ 收窄判据（否则误伤一堆）：
  //   · `Math.round(x * 100)` —— 乘法运算符；
  //   · `rules/scoring-*.json` —— 文件名通配符。
  //   ⇒ 只判「星号**紧邻中文**」的情况：那才是 markdown 强调漏出。
  const offenders = [];
  for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(viewsDir, file), 'utf8');
    codeLines(src).forEach((line) => {
      const s = line.trim();
      if (!/[一-龥]/.test(s)) return;
      for (let i = 0; i < s.length; i += 1) {
        if (s[i] !== '*') continue;
        const prev = s[i - 1] ?? '';
        const next = s[i + 1] ?? '';
        if (/[一-龥]/.test(prev) || /[一-龥]/.test(next)) {
          offenders.push(`${file}: ${s.slice(0, 130)}`);
          break;
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `这些行的中文文案里有落单星号（多半是 markdown 强调写了一半）：\n${offenders.join('\n')}`);
});

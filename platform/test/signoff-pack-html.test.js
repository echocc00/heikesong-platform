// platform/test/signoff-pack-html.test.js —— 送签件 HTML 版的机器闸（2026-10-28）
//
// 规则溯源：
//   - 送签件是**要拿回签字**的文件 ⇒ 它的 HTML 打印件必须与 Markdown 源**逐字同源**
//     （否则「改了 Markdown 忘了重生成」⇒ 组委会签的是一份平台自己都不认的清单）
//   - 全局约束「零 npm 依赖、零构建」⇒ HTML 必须**自包含**（断网可印、可贴邮件）
//
// ⚠️ **为什么要有这条闸**：
//   分母已经三连跳（17 → 22 → 25 → 27）⇒ 每一次口径变更都要改清单。
//   若 HTML 与 Markdown 各写一份 ⇒ 这条「不许手改 HTML」的纪律只靠人记 ⇒ 迟早漂。
//   ⇒ 改法不是「加个提醒」，而是**让漂移不可能**：HTML 由生成器派生，
//     本条用例**重新生成一遍并逐字节比对** ⇒ 手改 HTML 立刻变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const toolPath = join(repoRoot, 'docs', 'tools', 'build-signoff-pack-html.mjs');
const srcPath = join(repoRoot, 'docs', '');
const outPath = join(repoRoot, 'docs', '');

/**
 * ⚠️ **本组用例在公开仓镜像里「不适用」**（不是失败）。
 *
 * 原因：送签件的 Markdown 与 HTML 产物都是**私有文档** ⇒ 公开仓镜像会把它们**排除**
 * ⇒ 本组用例守的「产物与源逐字节一致」在公开仓**没有对象可守**。
 *
 * ⚠️ **判定必须用「是不是文件」而不是「存不存在」**：
 *   脱敏替换表会把私有文档的**路径**替换成空串 ⇒ 在公开仓里这两个路径会指向
 *   `docs/` **目录**（不是文件）⇒ 只判「存在」会把它当成「存在但读不了」⇒ 变成**报错**。
 *   ⇒ 这里判 `isFile()` ⇒ 目录/缺失都归入「不适用」。
 */
const isFile = (p) => {
  try { return statSync(p).isFile(); } catch { return false; }
};
const AVAILABLE = isFile(srcPath) && isFile(outPath);
const SKIP_REASON = '送签件是私有文档，公开仓镜像已脱敏排除 ⇒ 本组用例不适用';

/** 重新生成到临时目录，返回生成结果 */
function regenerate() {
  const dir = mkdtempSync(join(tmpdir(), 'hks-signoff-'));
  const tmp = join(dir, 'out.html');
  execFileSync(process.execPath, [toolPath, srcPath, tmp], { cwd: repoRoot, stdio: 'pipe' });
  const text = readFileSync(tmp, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return text;
}

test('送签件 HTML：必须与生成器输出**逐字节一致**（手改 HTML ⇒ 本条变红）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const onDisk = readFileSync(outPath, 'utf8');
  const regenerated = regenerate();
  assert.equal(
    onDisk, regenerated,
    ' 与生成器输出不一致 '
    + '⇒ 它被手改过，或 Markdown 改完没重新生成 '
    + '⇒ 修法：node docs/tools/build-signoff-pack-html.mjs  ',
  );
});

test('送签件 HTML：必须**自包含**（零外部资源 ⇒ 断网可印、可贴邮件）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  assert.equal(
    (html.match(/https?:\/\//g) || []).length, 0,
    '不得引用任何外部 URL（CDN 字体 / 外部图片 / 远程脚本）⇒ 断网打印会缺样式',
  );
  assert.ok(!/<link\b/i.test(html), '不得有 <link>（外部样式表）');
  assert.ok(!/<script\b/i.test(html), '不得有 <script>（本文件是静态打印件，不需要脚本）');
  assert.ok(!/@import\b/i.test(html), '不得有 CSS @import');
});

test('送签件 HTML：正文**不得有未转义的裸尖括号**（否则内容可被浏览器当标签改写）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  const stripped = html.replace(/<[^>]*>/g, '');
  assert.equal(
    (stripped.match(/[<>]/g) || []).length, 0,
    '剥掉合法标签后仍出现裸尖括号 ⇒ 转义函数失效（清单里的内容可被结构解析）',
  );
});

test('送签件 HTML：27 条与勾选栏**一个不少**（分母是硬事实）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  const md = readFileSync(srcPath, 'utf8');
  // ⛔ 分母以 **Markdown 源**为准（那是唯一的真相来源），HTML 必须与它一致
  const mdTicks = (md.match(/☐/g) || []).length;
  const htmlTicks = (html.match(/☐/g) || []).length;
  assert.ok(mdTicks >= 27, `源文件的勾选框只有 ${mdTicks} 个 ⇒ 分母不对`);
  assert.equal(htmlTicks, mdTicks, '勾选框数量与源文件不一致');
  // 六组 + 备案组 ⇒ 七个组标题
  for (const g of ['第一组', '第二组', '第三组', '第四组', '第五组', '第六组', '第七组']) {
    assert.ok(html.includes(g), `HTML 里少了「${g}」`);
  }
  // 签收表必须存在（这是「拿回签字」的落点）
  assert.ok(html.includes('签收'), 'HTML 里必须有签收表');
  assert.ok(html.includes('确认人'), '签收表必须有「确认人」栏');
});

test('送签件 HTML：打印样式在位（A4 + 表头每页重复 + 不打印编辑提示）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  assert.ok(/@page\s*\{[^}]*size:\s*A4/.test(html), '必须声明 A4 页面尺寸');
  assert.ok(/table-header-group/.test(html), '表头必须每页重复（跨页表格不能失去列名）');
  assert.ok(/\.no-print\s*\{\s*display:\s*none/.test(html), '「本件由生成器产出」的提示行不得打印');
});

// platform/test/signoff-segments.test.js —— 「送签件分段拆分」的机器闸（2026-10-28）
//
// 依据：
//   - 送签件是**要拿回签字**的文件，而其中的条目**重量差得很远**：一部分技术上自洽
//     （签了就行）、一部分只差一个数、另一部分真要开会对拍板
//     ⇒ 拆成几份，**先签最容易的那份** ⇒ 把「不签就办不成一届」的风险压到最后。
//   - E183 的教训：**两份手写的内容一定会漂** ⇒ 分段件必须是**派生**的（从总件逐行取），
//     逐字节比对闸比「请记得同步」硬得多。
//
// ⚠️ **本闸为什么必须单独成一个文件**（而不是塞进 signoff-pack-html.test.js）：
//   它钉的是**跨五个来源的不变量**（总件 ↔ 映射表 ↔ 分段 Markdown ↔ 分段 HTML），
//   与 E183 那条（Markdown ↔ HTML）不是同一件事 ⇒ 混在一起看不出是哪条口径在守。
//
// ── 七条判据 ──────────────────────────────────────────────────────────────
//   ① **条目正文逐字一致**：每段里的条目行与总件**逐字节相同**（不许手抄漂移）。
//   ② **条目不重不漏**：各段合起来 == 总件的全部条目，每条恰出现一次。
//   ③ **分段归属来自映射表**：每条落在哪一段 == 映射表「段」列（改了映射表必须重生成）。
//   ④ **HTML ≡ 重新生成**：每份 HTML 与重新渲染一遍的结果**逐字节一致**（手改即红）。
//   ⑤ **可打印件在位**：自包含（零外部资源）+ 有结论表 + 有签收栏 + 有 A4 打印样式。
//   ⑥ **组标题不说谎**：分段件里的组标题必须写「本段 M 条 / 全组 N 条」。
//   ⑦ **生成器可复现**：重跑一遍，三份 Markdown 与磁盘上**逐字节一致**。
//
// ⚠️ **本文件不含任何项目数据**（段名 / 文件名 / 配比都从映射表读）
//   ⇒ 公开仓里的本闸是**通用的**：换项目 ⇒ 换一份映射表即可。
//
// ⚠️ **公开仓里本组文件全部不存在** ⇒ 这 7 条**跳过**（不适用，不假装通过）
//   （同 E183 的 `isFile()` 教训：脱敏替换表会把私有路径换成空串 ⇒ 路径会指向目录，
//    只判「存在」会变成报错 ⇒ 必须判 `isFile()`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const PACK_PATH = join(REPO_ROOT, '');
const MAP_PATH = join(REPO_ROOT, '');
const RENDER_TOOL = join(REPO_ROOT, 'docs/tools/build-signoff-pack-html.mjs');
const SEG_TOOL = join(REPO_ROOT, 'docs/tools/build-signoff-segments.mjs');

const isFile = (p) => {
  try { return statSync(p).isFile(); } catch { return false; }
};

/** 映射表里的分段定义（```json 代码块）⇒ [{seg,key,file,title,order}] */
function segmentDefs() {
  const text = readFileSync(MAP_PATH, 'utf8');
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
  assert.ok(m, '映射表里找不到分段定义（```json 代码块）');
  const data = JSON.parse(m[1]);
  assert.ok(Array.isArray(data.segments) && data.segments.length > 0, '分段定义里没有 segments');
  return data.segments.sort((a, b) => a.order - b.order);
}

/** 分段件的路径（从定义里的 file 名推）。 */
const mdPath = (def) => join(REPO_ROOT, 'docs', def.file);
const htmlPath = (def) => join(REPO_ROOT, 'docs', def.file.replace(/\.md$/, '.html'));

let DEFS = [];
let AVAILABLE = false;
if (isFile(PACK_PATH) && isFile(MAP_PATH)) {
  try {
    DEFS = segmentDefs();
    AVAILABLE = DEFS.length > 0 && DEFS.every((d) => isFile(mdPath(d)) && isFile(htmlPath(d)));
  } catch { AVAILABLE = false; }
}
const SKIP_REASON = '送签总件 / 映射表 / 分段件都是私有文档（公开仓已脱敏排除）⇒ 本组用例不适用';

/** 表格行里的条目编号（第一组的 `**C-01** ⭐严重` 也算）；备案类事实没有编号 ⇒ null。 */
function rowId(line) {
  const first = line.trim().replace(/^\|/, '').split('|')[0].trim();
  const m = first.match(/^\*\*(C-\d+|M0-\d+b?)\*\*/);
  if (m) return m[1];
  if (/^\d{1,2}$/.test(first)) return first;
  return null;
}

/** 总件条目一览里的条目行 ⇒ Map(编号 → 行原文)。 */
function packRows() {
  const lines = readFileSync(PACK_PATH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 三、'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 四、'));
  assert.ok(start >= 0 && end > start, '总件里找不到条目一览那一节');
  const out = new Map();
  for (const line of lines.slice(start, end)) {
    if (!/^\s*\|/.test(line)) continue;
    const id = rowId(line);
    if (!id) continue;
    if (!out.has(id)) out.set(id, line);
  }
  return out;
}

/** 某段 Markdown 的**条目行**（只看「一、条目」，不含结论表）⇒ Map(编号 → 行原文)。 */
function segRows(def) {
  const lines = readFileSync(mdPath(def), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 一、'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 二、'));
  assert.ok(start >= 0 && end > start, `${def.file} 里找不到「一、条目」/「二、本段结论」`);
  const out = new Map();
  for (const line of lines.slice(start, end)) {
    if (!/^\s*\|/.test(line)) continue;
    const id = rowId(line);
    if (!id) continue;
    out.set(id, line);
  }
  return out;
}

/** 映射表 §2 ⇒ Map(编号 → 段)。 */
function mappingSegments() {
  const lines = readFileSync(MAP_PATH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 2. '));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 3. '));
  assert.ok(start >= 0 && end > start, '映射表里找不到 §2 / §3');
  const out = new Map();
  for (const line of lines.slice(start, end)) {
    if (!/^\|\s*(C-\d+|M0-\d+b?|\d{1,2})\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    out.set(cells[0], cells[2]);
  }
  return out;
}

test('★ 分段件落地（它们是本闸的前提）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  for (const d of DEFS) {
    assert.ok(isFile(mdPath(d)), `缺少分段件：docs/${d.file}`);
    assert.ok(isFile(htmlPath(d)), `缺少可打印件：${d.file.replace(/\.md$/, '.html')}`);
  }
});

test('★ 条目正文逐字一致：每段的条目行与总件**逐字节相同**', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const pack = packRows();
  for (const d of DEFS) {
    const rows = segRows(d);
    assert.ok(rows.size > 0, `${d.seg} 段里一条条目都没有`);
    for (const [id, line] of rows) {
      assert.ok(pack.has(id), `${d.seg} 段里的条目 ${id} 在总件里不存在`);
      assert.equal(line, pack.get(id),
        `${d.seg} 段的条目 ${id} 与总件**逐字不一致**（分段件被手改过，或总件改完没重生成）`);
    }
  }
});

test('★ 条目不重不漏：各段合起来 == 总件的全部条目，每条恰一次', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const pack = packRows();
  const seen = new Map();
  for (const d of DEFS) {
    for (const id of segRows(d).keys()) {
      assert.ok(!seen.has(id), `条目 ${id} 同时出现在「${seen.get(id)}」与「${d.seg}」两段里`);
      seen.set(id, d.seg);
    }
  }
  assert.equal(seen.size, pack.size, `各段合起来只有 ${seen.size} 条（总件 ${pack.size} 条）`);
  assert.deepEqual([...seen.keys()].sort(), [...pack.keys()].sort(),
    '各段覆盖的条目集合与总件不一致（总件加/删了条目 ⇒ 分段件必须重新生成）');
});

test('★ 分段归属来自映射表：每条落在哪一段 == 映射表的「段」列', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const mapping = mappingSegments();
  for (const d of DEFS) {
    for (const id of segRows(d).keys()) {
      assert.equal(mapping.get(id), d.seg,
        `条目 ${id} 在映射表里属于「${mapping.get(id)}」段，但被放进了「${d.seg}」段 ⇒ 改了映射表就要重新生成分段件`);
    }
  }
});

test('★ 每份可打印件与「重新生成一遍」逐字节一致（手改 HTML ⇒ 变红）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-seg-'));
  try {
    for (const d of DEFS) {
      const tmp = join(dir, `${d.key}.html`);
      execFileSync(process.execPath, [RENDER_TOOL, mdPath(d), tmp], { cwd: REPO_ROOT, stdio: 'pipe' });
      const regenerated = readFileSync(tmp, 'utf8');
      const onDisk = readFileSync(htmlPath(d), 'utf8');
      assert.equal(onDisk, regenerated,
        `${d.file.replace(/\.md$/, '.html')} 与重新生成的结果不一致 `
        + '⇒ 它被手改过，或分段 Markdown 改完没重新渲染');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 可打印件在位：自包含（零外部资源）+ 有结论表 + 有签收栏 + A4 打印样式', { skip: !AVAILABLE && SKIP_REASON }, () => {
  for (const d of DEFS) {
    const html = readFileSync(htmlPath(d), 'utf8');
    assert.equal((html.match(/https?:\/\//g) || []).length, 0, `${d.key}.html 引用了外部 URL（断网打印会缺样式）`);
    assert.ok(!/<link\b/i.test(html), `${d.key}.html 不得有 <link>`);
    assert.ok(!/<script\b/i.test(html), `${d.key}.html 不得有 <script>`);
    assert.ok(html.includes('本段结论'), `${d.key}.html 缺少「本段结论」表`);
    assert.ok(html.includes('签收'), `${d.key}.html 缺少「签收」栏`);
    assert.ok(html.includes('确认人'), `${d.key}.html 的签收栏缺少「确认人」`);
    assert.ok(/@page\s*\{[^}]*size:\s*A4/.test(html), `${d.key}.html 缺少 A4 打印样式`);
  }
});

test('★ 组标题不说谎：分段件里必须写「本段 M 条 / 全组 N 条」', { skip: !AVAILABLE && SKIP_REASON }, () => {
  for (const d of DEFS) {
    const md = readFileSync(mdPath(d), 'utf8');
    const titles = md.split('\n').filter((l) => l.startsWith('### ') && !l.includes('怎么填'));
    for (const t of titles) {
      assert.match(t, /本段 \d+ 条 \/ 全组 \d+ 条/,
        `${d.file} 的组标题没有改写条数（照抄总件的「全组 N 条」＝说谎）：${t}`);
    }
  }
});

test('★ 生成器可复现：重跑一遍，各段 Markdown 与磁盘上**逐字节一致**', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-seg-gen-'));
  try {
    execFileSync(process.execPath, [SEG_TOOL, PACK_PATH, MAP_PATH, dir], { cwd: REPO_ROOT, stdio: 'pipe' });
    for (const d of DEFS) {
      const regenerated = readFileSync(join(dir, d.file), 'utf8');
      const onDisk = readFileSync(mdPath(d), 'utf8');
      assert.equal(onDisk, regenerated,
        `${d.file} 与重新生成的结果不一致（被手改过，或总件/映射表改完没重生成）`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

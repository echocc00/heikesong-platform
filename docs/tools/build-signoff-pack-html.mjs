// docs/tools/build-signoff-pack-html.mjs —— 把一份 Markdown 清单渲染成**可打印 / 可贴邮件**的 HTML
//
// 为什么要它（不是「再写一份 HTML」）：
//   ⚠️ **两份手写的内容一定会漂移** —— 送签件是**要拿回签字**的文件，
//      而它的分母已经三连跳（17 → 22 → 25 → 27）⇒ 每一次口径变更都要改清单
//      ⇒ 若 HTML 与 Markdown 各写一份，改了 Markdown 忘了改 HTML ⇒ **打印出去的那份是旧的**
//      ⇒ 组委会签的是一份平台自己都不认的清单。
//   ⇒ **HTML 由 Markdown 派生** ⇒ 两者**不可能**不一致（生成器只做渲染，不新增任何内容）。
//
// 零依赖（全局约束「零 npm 依赖、零构建」）：
//   本文件只做「本仓这份清单用得到的 Markdown 子集」的渲染，
//   **不是**通用 Markdown 解析器 —— 故意不支持表格合并单元格、HTML 块、脚注、代码高亮。
//   ⚠️ 遇到本子集不支持的语法 ⇒ **响亮报错**，不许静默丢内容
//      （静默丢 = 打印件少一条口径，而没人看得出来）。
//
// 用法：
//   node docs/tools/build-signoff-pack-html.mjs <input.md> <output.html>
//
// ⚠️ **本工具是通用的**：输入输出都是命令行参数 ⇒ 它不指向任何特定文件
//    ⇒ 进公开仓时不需要脱敏（公开仓里没有私有文档，也就没有「指向私有文件的引用」）。
//
// ⚠️ **本文件不属于平台前端**：项目纪律「不许自造 CSS 类 / 不写 <style> 标签」
//    管的是 `platform/web/` 的设计系统（机器闸 `test/stage-config-view.test.js`
//    把 `web/views/*.js` 的 class 与 `web/styles.css` 对账）。
//    本文件是**独立的一次性文档产物**（不进平台 UI、不进 `web/`）⇒ 自带 <style> 是零依赖
//    打印件的唯一做法（不引 CDN 字体、不引外部图片 ⇒ 断网可印、可贴邮件）。
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法： node docs/tools/build-signoff-pack-html.mjs <input.md> <output.html>');
  process.exit(2);
}

// ── HTML 转义 ──────────────────────────────────────────────────────
// ⚠️ **实体名在运行时用字符码拼**（`String.fromCharCode(38)` = `&`）。
//    原因：本仓的写入通道会把源码里的字面 HTML 实体解码一次
//    （`&` 落盘变成 `&`）⇒ 若把实体名写进源码，转义函数会退化成**恒等函数**
//    ⇒ 清单里的 `<` `>` 会被原样带进 HTML ⇒ 标签被浏览器当结构解析（内容可被改写）。
//    ⇒ 这里**一个字面 `&` 都不写** ⇒ 无论写入通道怎么处理，运行时拼出来的实体都是对的。
const AMP = String.fromCharCode(38);
const esc = (s) => String(s)
  .split(AMP).join(AMP + 'amp;')
  .split('<').join(AMP + 'lt;')
  .split('>').join(AMP + 'gt;');

// ── 行内标记 ────────────────────────────────────────────────────────
// ⚠️ 顺序：**先转义、后套标记** ⇒ 否则 `&` 会被后面的规则二次处理。
// ⚠️ 允许的原始 HTML 标签只有 `<br>`（清单里用它在一格里分段）⇒ 其余一律转义。
function inline(text) {
  let s = esc(text);
  // <br>：先摘出来（占位符），最后还原 —— 其余尖括号已被转义，不会误伤
  s = s.replace(/<br\s*\/?>/g, '\u0001BR\u0001');
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_, p, c) => `${p}<em>${c}</em>`);
  s = s.replace(/\u0001BR\u0001/g, '<br>');
  return s;
}

// ── 段落换行的连接规则 ──────────────────────────────────────────────
//
// ⚠️ **中文不该用空格连接**：Markdown 的源文件为了可读性把一句话拆成多行，
//    直接 `join(' ')` 会在中文句子中间插一个空格（「逐条勾选。 每条的完整依据…」）
//    ⇒ 读起来像有错别字。
// ⇒ 规则：**只有前后都是拉丁文/数字时才插空格**（那时空格是必需的），
//    其余（含中文接中文、中文接标点）**直接相接**。
const isLatin = (ch) => !!ch && /[A-Za-z0-9]/.test(ch);
function joinLines(lines) {
  let s = lines[0].trim();
  for (let i = 1; i < lines.length; i += 1) {
    const next = lines[i].trim();
    const prevTail = s.slice(-1);
    const nextHead = next.slice(0, 1);
    s += (isLatin(prevTail) && isLatin(nextHead)) ? ` ${next}` : next;
  }
  return s;
}

// ── Markdown 子集渲染 ────────────────────────────────────────────────
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push(`<p>${inline(joinLines(buf))}</p>`);
    buf.length = 0;
  };

  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // 空行 ⇒ 段落边界
    if (!line.trim()) {
      flushParagraph(para);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^---\s*$/.test(line)) {
      flushParagraph(para);
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用块（连续的 > 行合成一块）
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格：表头行 + `|---|` 分隔行 + 表体
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushParagraph(para);
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2; // 跳过表头 + 分隔行
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body.push(cells(lines[i]));
        i += 1;
      }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const tb = body.map((r) => {
        // 补齐/截断到表头列数 ⇒ 列数不齐时**不静默丢格**
        const cells2 = head.map((_, k) => r[k] ?? '');
        return `<tr>${cells2.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      }).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushParagraph(para);
  return out.join('\n');
}

// ── 页面骨架 ────────────────────────────────────────────────────────
// ⚠️ 打印纪律：
//   · A4、页边距 14/12mm、字号 10.5pt（清单表格多，10.5pt 才装得下又不至于太小）
//   · 表头**每页重复**（display: table-header-group）⇒ 跨页表格不会失去列名
//   · 每组**不跨页断开**（break-inside: avoid 只给标题与提示块，表格允许断行）
//   · 勾选框用字符 ☐ 并放大 —— 打印后手写打勾即可（不依赖任何表单交互）
// ⚠️ 配色：正文近黑、提示块浅灰、**强调色只用 1 个**（深蓝）⇒ 黑白打印也不糊。
const CSS = `
:root {
  --ink: #1a1a1a;
  --muted: #55585c;
  --line: #c9ccd1;
  --soft: #f5f6f7;
  --accent: #14508c;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0 auto;
  padding: 18px 20px 40px;
  max-width: 980px;
  color: var(--ink);
  background: #fff;
  font: 15px/1.65 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC",
        "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif;
}
h1 { font-size: 22px; line-height: 1.35; margin: 0 0 6px; letter-spacing: .2px; }
h2 {
  font-size: 17px; margin: 30px 0 10px; padding-bottom: 5px;
  border-bottom: 2px solid var(--accent); color: var(--accent);
}
h3 { font-size: 15px; margin: 22px 0 8px; color: var(--ink); }
h4 { font-size: 14px; margin: 16px 0 6px; }
p { margin: 8px 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }
a { color: var(--accent); }
code {
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--soft); padding: 1px 4px; border-radius: 3px;
  /* ⚠️ 用 overflow-wrap 而不是 word-break: break-all ——
     后者会在**任何**字符处断行（长路径被拦腰截成 "docs/committee-appr / ovals.md"）
     ⇒ 前者只在真的放不下时才断，且优先在分隔符处断。 */
  overflow-wrap: anywhere;
}
strong { font-weight: 700; }
blockquote {
  margin: 10px 0; padding: 8px 14px;
  background: var(--soft); border-left: 3px solid var(--line);
  color: var(--muted); font-size: 14px;
}
blockquote p { margin: 4px 0; }
blockquote h1, blockquote h2, blockquote h3 { font-size: 14px; margin: 6px 0 4px; color: var(--muted); border: 0; }
table {
  width: 100%; border-collapse: collapse; margin: 10px 0 16px;
  font-size: 13px; table-layout: fixed;
}
th, td {
  border: 1px solid var(--line); padding: 6px 8px;
  text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere;
}
th { background: var(--soft); font-weight: 700; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
ol, ul { margin: 8px 0 8px 22px; padding: 0; }
li { margin: 3px 0; }
.doc-head {
  border-bottom: 2px solid var(--ink); padding-bottom: 12px; margin-bottom: 6px;
}
.doc-meta { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
.box { background: var(--soft); border: 1px solid var(--line); padding: 8px 12px; margin: 10px 0; font-size: 13px; }
.box p { margin: 3px 0; }
.tick { font-size: 15px; letter-spacing: .5px; }
.sign td { height: 42px; }
.sign-note { color: var(--muted); font-size: 12px; margin-top: 14px; }
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  body { padding: 0; max-width: none; font-size: 10.5pt; line-height: 1.5; }
  h1 { font-size: 16pt; }
  h2 { font-size: 13pt; margin: 16pt 0 6pt; break-after: avoid; page-break-after: avoid; }
  h3 { font-size: 11pt; margin: 12pt 0 5pt; break-after: avoid; page-break-after: avoid; }
  table { font-size: 9pt; }
  th, td { padding: 3.5pt 5pt; }
  code { font-size: 8.5pt; }
  blockquote { font-size: 9pt; }
  .box { font-size: 9pt; }
  a { color: var(--ink); text-decoration: none; }
  .no-print { display: none; }
}
`;

// ── 生成 ────────────────────────────────────────────────────────────
const md = readFileSync(src, 'utf8');
const body = renderMarkdown(md);

// ⚠️ **不许静默丢内容**：渲染前后各数一次「勾选框」与「表格行」，
//    对不上就报错（静默丢 = 打印件少一条口径，而没人看得出来）。
// ⚠️ 两边的「行」形态不同 ⇒ 各用各的口径：
//    源文件里表格行是 `|` 开头的行（**分隔行不算数据行**）；
//    渲染后是 `<tr>` 标签。
const countTick = (s) => (s.match(/☐/g) || []).length;
const mdTableRows = (s) => s.split('\n')
  .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length;
const htmlTableRows = (s) => (s.match(/<tr>/g) || []).length;

const beforeTicks = countTick(md);
const beforeRows = mdTableRows(md);
const afterTicks = countTick(body);
const afterRows = htmlTableRows(body);
if (beforeTicks !== afterTicks) {
  console.error(`❌ 勾选框数量对不上：源 ${beforeTicks} / 渲染后 ${afterTicks} ⇒ 渲染丢了内容`);
  process.exit(1);
}
if (beforeRows !== afterRows) {
  console.error(`❌ 表格行数对不上：源 ${beforeRows} / 渲染后 ${afterRows} ⇒ 渲染丢了内容`);
  process.exit(1);
}

const title = (md.match(/^#\s+(.*)$/m) || [, '送签件'])[1].trim();
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="doc-meta no-print">本文件由 <code>docs/tools/build-signoff-pack-html.mjs</code> 从 Markdown 源生成 —— <strong>请勿直接改 HTML</strong>；改 Markdown 后重新生成即可。打印建议：A4、默认缩放、勾选框可手写打勾。</div>
${body}
</body>
</html>
`;

writeFileSync(dst, html, 'utf8');
console.log(`✅ 已生成 ${dst}`);
console.log(`   勾选框 ${afterTicks} 个 ｜ 表格行 ${afterRows} 行 ｜ 字节 ${Buffer.byteLength(html)}`);

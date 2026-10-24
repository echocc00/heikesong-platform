// docs/tools/build-signoff-segments.mjs —— 把送签总件拆成若干份**可独立处理**的段落件
//
// 为什么要它：
//   送签件往往是一份「N 条整体清单」⇒ 委员会要么全看全签，要么全不看。
//   ⇒ 但这些条目**重量差得很远**：一部分技术上自洽（签了就行）、一部分只差一个数、
//     另一部分真要开会对拍板。
//   ⇒ 拆成几份 ⇒ **先签最容易的那份**（当天就能闭环），再填数，最后才开会
//     ⇒ 把「不签就办不成一届」的风险压到最后。
//
// ⚠️ **为什么是「派生」而不是「手抄几份」**：
//   手抄 ⇒ 条目正文会漂（改了总件忘了改分段件）⇒ 委员会签的是一份平台自己都不认的清单。
//   ⇒ 本工具**从总件逐行取条目**（逐字拷贝）⇒ 条目正文与总件**不可能**不一致；
//     分段归属来自**映射表的「段」列**（单一真相来源）⇒ 配比也漂不了。
//
// 用法：
//   node docs/tools/build-signoff-segments.mjs <总件.md> <映射表.md> <输出目录>
//
// ⚠️ **本工具是通用的**：三个输入输出都是命令行参数 ⇒ 它不指向任何特定文件
//    ⇒ 进公开仓时不需要脱敏（公开仓里没有总件，也没有映射表）。
//    ⚠️ **工具里不含任何项目数据**（段数、段名、措辞、文件名都来自映射表）
//    ⇒ 换一个项目 ⇒ 换一份映射表即可，**工具不用改**。
//    ⇒ 否则就等于在仓里长出第二套「按项目分支」的配置（公开模板明确禁止）。
//
// ⚠️ **分段定义放在映射表里**（一个 ```json 代码块）：文件名、标题、说明、怎么填、
//    结论表列名、推进顺序 ⇒ 全部只有一份真相 ⇒ 机器读它、人也读它。
//
// ⚠️ **与 `build-signoff-pack-html.mjs` 的分工**：那个工具负责「Markdown → 可打印 HTML」；
//    本工具负责「总件 + 映射表 → 分段 Markdown」。HTML 由**前一个工具**再渲染（每份跑一次）
//    ⇒ 本工具**不碰 HTML** ⇒ 渲染逻辑只有一份。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── 解析总件 §三 ───────────────────────────────────────────────────────────
/**
 * 取表格行里的条目编号（第一组的 `**C-01** ⭐严重` 也算）。
 * @returns {string|null} 编号；备案类的事实没有编号 ⇒ 返回 null
 */
function rowId(line) {
  const first = line.trim().replace(/^\|/, '').split('|')[0].trim();
  const m = first.match(/^\*\*(C-\d+|M0-\d+b?)\*\*/);
  if (m) return m[1];
  if (/^\d{1,2}$/.test(first)) return first;
  return null;
}

/** 解析总件 §三 ⇒ 组（标题 + 表头 + 行）。 */
function parsePack(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => l.startsWith('## 三、'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 四、'));
  if (start < 0 || end < 0) throw new Error('总件里找不到 §三 / §四（条目一览的边界变了）');
  const groups = [];
  let cur = null;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    const h = line.match(/^###\s+(.*)$/);
    if (h) {
      cur = { title: h[1].trim(), header: null, rows: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) continue;
    const isSep = /^\|[\s:|-]+\|\s*$/.test(line);
    if (!isSep && /^\s*\|/.test(line) && i + 1 < end && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      cur.header = [line, lines[i + 1]];
      i += 1;
      continue;
    }
    if (cur.header && /^\s*\|/.test(line) && !isSep) {
      cur.rows.push(line);
      continue;
    }
  }
  return groups;
}

/** 解析映射表 §2 ⇒ 编号 → 段。 */
function parseMapping(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => l.startsWith('## 2. '));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 3. '));
  if (start < 0 || end < 0) throw new Error('映射表里找不到 §2 / §3（逐条映射表的边界变了）');
  const map = new Map();
  for (const line of lines.slice(start, end)) {
    if (!/^\|\s*(C-\d+|M0-\d+b?|\d{1,2})\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    map.set(cells[0], cells[2]);
  }
  return map;
}

/**
 * 解析映射表里的分段定义（一个 ```json 代码块）。
 * @returns {Array<{seg,key,file,title,order,lead,how[],cols[]}>}
 */
function parseSegmentDefs(text) {
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error('映射表里找不到分段定义（```json 代码块）');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`分段定义不是合法 JSON：${e.message}`);
  }
  const segs = Array.isArray(data.segments) ? data.segments : null;
  if (!segs || segs.length === 0) throw new Error('分段定义里没有 segments 数组');
  for (const s of segs) {
    for (const key of ['seg', 'key', 'file', 'title', 'order', 'lead', 'how', 'cols']) {
      if (s[key] === undefined) throw new Error(`分段定义缺字段「${key}」：${JSON.stringify(s.seg)}`);
    }
  }
  return segs;
}

// ── 生成一段 ───────────────────────────────────────────────────────────────
function buildSegment(def, groups, mapping) {
  const out = [];
  const picked = [];
  // 备案类的事实（没有编号 ⇒ 不属于要拍条的条目）⇒ 只在抬头给一句指引，不并入本段
  const appendixRows = groups.reduce(
    (n, g) => n + g.rows.filter((r) => rowId(r) === null).length, 0,
  );
  for (const g of groups) {
    const rows = g.rows.filter((r) => {
      const id = rowId(r);
      if (!id) return false;
      return mapping.get(id) === def.seg;
    });
    if (rows.length === 0) continue;
    picked.push(...rows.map(rowId));
    // ⚠️ **组标题里的条数必须改写**：总件的组标题写的是「全组 N 条」，
    //   而本段只包含其中一部分 ⇒ 照抄会变成**说谎**（读者以为本段有 N 条）
    //   ⇒ 改成「本段 M 条 / 全组 N 条」。
    const title = g.title.replace(/(\d+) 条/, `本段 ${rows.length} 条 / 全组 $1 条`);
    out.push(`### ${title}`);
    out.push('');
    out.push(...g.header);
    out.push(...rows);
    out.push('');
  }

  const ids = picked;
  const n = ids.length;

  const head = [
    `# 送签件 · ${def.seg} 段 · ${def.title}（${n} 条）`,
    '',
    `> **本段要做什么**：${def.lead}`,
    `> **本段分母**：**${n} 条**（总件 ${mapping.size} 条里的这 ${n} 条）`,
    `> **交回方式**：勾选 + 结论表 + 签收 ⇒ 三者齐了本段才算闭环`,
    ...(appendixRows > 0 ? [`> **另有 ${appendixRows} 条**已实现、待追认的技术事实（备案，**无需逐条拍板**）⇒ 见总件最后一组`] : []),
    '',
    '---',
    '',
    '## 一、条目（按总件的原分组，正文逐字相同）',
    '',
  ];

  const tail = [
    '---',
    '',
    '## 二、本段结论',
    '',
    `| ${def.cols.join(' | ')} |`,
    `|${def.cols.map(() => '---').join('|')}|`,
    ...ids.map((id) => `| ${id} | | |`),
    '',
    '---',
    '',
    '## 三、签收',
    '',
    '| 签收项 | 填写 |',
    '|---|---|',
    '| 确认人（姓名） | |',
    '| 职务 / 所属 | |',
    '| 日期 | |',
    '| 本段驳回项编号与新口径 | |',
    '| 备注 | |',
    '',
    '---',
    '',
    '### 怎么填（照此操作）',
    '',
    ...def.how.map((s, i) => `${i + 1}. ${s}`),
    '',
    '---',
    '',
    '> ⚠️ **本件由生成器从总件派生**（`docs/tools/build-signoff-segments.mjs`）⇒ 条目正文与总件**逐字一致**。',
    '> ⇒ **改口径请改总件**，不要直接改本件 ⇒ 改完总件重新生成本件，否则机器闸会变红。',
    '',
  ];

  return { text: [...head, ...out, ...tail].join('\n'), ids };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const [packPath, mappingPath, outDir] = process.argv.slice(2);
if (!packPath || !mappingPath || !outDir) {
  console.error('用法： node docs/tools/build-signoff-segments.mjs <总件.md> <映射表.md> <输出目录>');
  process.exit(2);
}
for (const p of [packPath, mappingPath]) {
  if (!existsSync(p)) {
    console.error(`❌ 输入文件不存在：${p}`);
    process.exit(2);
  }
}

const mappingText = readFileSync(mappingPath, 'utf8');
const groups = parsePack(readFileSync(packPath, 'utf8'));
const mapping = parseMapping(mappingText);
const defs = parseSegmentDefs(mappingText).sort((a, b) => a.order - b.order);

mkdirSync(outDir, { recursive: true });
const seen = new Set();
const written = [];

for (const def of defs) {
  const { text, ids } = buildSegment(def, groups, mapping);
  for (const id of ids) {
    if (seen.has(id)) {
      console.error(`❌ 条目 ${id} 被分到了多个段`);
      process.exit(1);
    }
    seen.add(id);
  }
  const file = join(outDir, def.file);
  writeFileSync(file, text, 'utf8');
  written.push({ def, file, n: ids.length });
  console.log(`✅ ${file}  ${ids.length} 条（${ids.join(' / ')}）`);
}

if (seen.size !== mapping.size) {
  console.error(`❌ 分段合起来只有 ${seen.size} 条（应 ${mapping.size} 条）⇒ 有条目没归段，或映射表有错`);
  process.exit(1);
}
const unknownSegs = [...mapping.values()].filter((s) => !defs.some((d) => d.seg === s));
if (unknownSegs.length > 0) {
  console.error(`❌ 映射表里有未定义的段：${[...new Set(unknownSegs)].join(' / ')}`);
  process.exit(1);
}
console.log(`\n${defs.length} 段合计 ${seen.size} 条 ✔（一条不多、一条不少）`);
console.log('下一步：把每份分段件渲染成可打印 HTML ——');
for (const w of written) {
  const html = w.file.replace(/\.md$/, '.html');
  console.log(`  node docs/tools/build-signoff-pack-html.mjs ${w.file} ${html}`);
}

// platform/test/signoff-mapping.test.js —— 「送签 27 条 ↔ 规则字段映射表」机器闸
//
// 依据：
//   - 送签件（）是**要拿回签字**的文件，分母已经四连跳
//     （17 → 22 → 25 → 27）⇒ 每一次口径变更都要同时改清单。
//   - 映射表（）把每条口径**落到 rules/ 的具体字段**上，
//     让「签完之后改哪里」变成机械操作。
//
// ⚠️ **为什么这条闸必须单独成一个文件**（而不是塞进 signoff-pack-html.test.js）：
//   它钉的是**跨三个来源的不变量**（送签件的分母 ↔ 映射表的编号集合 ↔ rules/ 的真实值）
//   ⇒ 塞进任何既有测试文件都会让它变成「某个既有文件的一条附带断言」。
//
// ── 五条判据 ──────────────────────────────────────────────────────────────
//   ① **分母不许再跳**：映射表的编号集合 == 送签件 §三 的编号集合（不重不漏）。
//   ② **落点不许空**：每条都有落层（白名单取值）；非「配置」的必须有备注。
//   ③ **配置路径真实存在**：每个 `rules/<file>:<path>` 都找得到。
//   ④ **当前值不许过期**：每个被引用的值与真实配置**逐字一致**（本闸最重要的一条）。
//   ⑤ **三段不重不漏**：甲 13 + 乙 4 + 丙 10 == 27，每条恰属一段。
//
// ⚠️ **④ 为什么最重要**：映射表的价值全在「签完照着它改」上
//   ⇒ 值一旦漂移，它就从「施工图」变成「误导」⇒ 照着改会把配置改错。
//
// ⚠️ **公开仓里本件与送签件都不存在** ⇒ 这 5 条**跳过**（不适用，不假装通过）
//   （与 E183 的「isFile() 判存在」同一教训：目录 / 缺失都归入「不适用」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PLATFORM_DIR, '..');
const RULES_DIR = join(PLATFORM_DIR, 'rules');

const PACK_PATH = join(REPO_ROOT, '');
const MAP_PATH = join(REPO_ROOT, '');

const PACK_EXISTS = existsSync(PACK_PATH) && statSync(PACK_PATH).isFile();
const MAP_EXISTS = existsSync(MAP_PATH) && statSync(MAP_PATH).isFile();
const SKIP_REASON = '送签件 / 映射表是私有文档（公开仓里不存在）⇒ 本闸不适用';

const packText = PACK_EXISTS ? readFileSync(PACK_PATH, 'utf8') : '';
const mapText = MAP_EXISTS ? readFileSync(MAP_PATH, 'utf8') : '';

/** 送签件 §三 的 27 条编号（第一组 C-xx / 第二·三组 1..11 / 第四~六组 M0-x）。 */
function packItemIds(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 三、'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 四、'));
  assert.ok(start >= 0 && end > start, '送签件里找不到 §三 / §四（27 条一览的边界变了）');
  const ids = [];
  for (const line of lines.slice(start, end)) {
    let m = line.match(/^\|\s*\*\*(C-\d+)\*\*/);
    if (m) { ids.push(m[1]); continue; }
    m = line.match(/^\|\s*\*\*(M0-\d+b?)\*\*/);
    if (m) { ids.push(m[1]); continue; }
    m = line.match(/^\|\s*(\d{1,2})\s*\|/);
    if (m) { ids.push(m[1]); continue; }
  }
  return ids;
}

/** 映射表 §2 的 27 行（编号 / 组 / 段 / 事项 / 落层 / 配置路径 / 当前值 / 备注）。 */
function mappingRows(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 2. '));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## 3. '));
  assert.ok(start >= 0 && end > start, '映射表里找不到 §2 / §3（逐条映射表的边界变了）');
  const rows = [];
  for (const line of lines.slice(start, end)) {
    if (!/^\|\s*(C-\d+|M0-\d+b?|\d{1,2})\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    assert.equal(cells.length, 8, `映射表的行不是 8 列（编号|组|段|事项|落层|路径|值|备注）：${line.slice(0, 80)}`);
    rows.push({
      id: cells[0],
      group: cells[1],
      segment: cells[2],
      title: cells[3],
      layer: cells[4],
      // ⚠️ 路径 / 值在文档里是**带反引号**的（可读性）⇒ 解析前剥掉
      paths: cells[5].replace(/`/g, ''),
      values: cells[6].replace(/`/g, ''),
      note: cells[7],
    });
  }
  return rows;
}

const LAYERS = ['配置', '配置+结构', '配置+新字段', '结构', '人工'];
const SEGMENT_COUNTS = { 甲: 13, 乙: 4, 丙: 10 };

/** 按点号路径取值（支持 `a.b[0].c`）。 */
function resolvePath(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function readRule(file) {
  const p = join(RULES_DIR, file);
  assert.ok(existsSync(p), `rules/${file} 不存在（映射表引用了不存在的配置）`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('★ 映射表落地（它是本闸的前提）', (t) => {
  if (!MAP_EXISTS || !PACK_EXISTS) return t.skip(SKIP_REASON);
  assert.ok(mapText.length > 0, '映射表是空的');
});

test('★ 分母不许再跳：映射表的编号集合 == 送签件 §三 的 27 条（不重不漏）', (t) => {
  if (!MAP_EXISTS || !PACK_EXISTS) return t.skip(SKIP_REASON);
  const packIds = packItemIds(packText);
  const mapIds = mappingRows(mapText).map((r) => r.id);
  assert.equal(packIds.length, 27, `送签件里数出 ${packIds.length} 条（分母又变了 ⇒ 本表必须同步）`);
  assert.deepEqual([...mapIds].sort(), [...packIds].sort(),
    '映射表的编号集合与送签件不一致（送签件加/删了条目 ⇒ 映射表必须同步；反之映射表写错了）');
  assert.equal(new Set(mapIds).size, mapIds.length, '映射表里有重复编号');
});

test('★ 落点不许空：每条都有落层，非「配置」类必须有备注', (t) => {
  if (!MAP_EXISTS || !PACK_EXISTS) return t.skip(SKIP_REASON);
  for (const r of mappingRows(mapText)) {
    assert.ok(LAYERS.includes(r.layer), `${r.id} 的落层「${r.layer}」不在白名单 ${LAYERS.join('/')} 里`);
    if (r.layer !== '配置') {
      assert.ok(r.note && r.note.length > 0, `${r.id} 落在「${r.layer}」但没写备注（不许静默留白）`);
    }
    if (r.paths === '-') {
      assert.ok(r.note && r.note.length > 0, `${r.id} 没有配置路径但没写备注`);
    }
  }
});

test('★ 配置路径真实存在 + 当前值与真实配置逐字一致（映射表不许过期）', (t) => {
  if (!MAP_EXISTS || !PACK_EXISTS) return t.skip(SKIP_REASON);
  let checked = 0;
  for (const r of mappingRows(mapText)) {
    if (r.paths === '-') continue;
    const paths = r.paths.split('；').map((s) => s.trim()).filter(Boolean);
    const values = r.values.split('；').map((s) => s.trim()).filter(Boolean);
    assert.equal(paths.length, values.length,
      `${r.id} 的配置路径（${paths.length}）与当前值（${values.length}）数量对不上`);
    for (let i = 0; i < paths.length; i += 1) {
      const m = paths[i].match(/^rules\/([^:]+):(.+)$/);
      assert.ok(m, `${r.id} 的配置路径写法不对：${paths[i]}（应是 rules/<file>:<path>）`);
      const [, file, path] = m;
      const rules = readRule(file);
      const actual = resolvePath(rules, path);
      assert.notEqual(actual, undefined, `${r.id} 指向的路径在 rules/${file} 里不存在：${path}`);
      const expected = values[i];
      if (expected.startsWith('length=')) {
        assert.ok(Array.isArray(actual), `${r.id} 期望 length= 却不是数组：${path}`);
        assert.equal(actual.length, Number(expected.slice('length='.length)),
          `${r.id} 的「${expected}」与真实配置不符（rules/${file}:${path} 实际长度 ${actual.length}）`);
      } else {
        assert.deepEqual(actual, JSON.parse(expected),
          `${r.id} 的当前值「${expected}」与真实配置不符（rules/${file}:${path} 实际是 ${JSON.stringify(actual)}）`);
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 40, `只核了 ${checked} 个值（映射表退化成空表 ⇒ 闸会假绿）`);
});

test('★ 三段不重不漏：甲 13 + 乙 4 + 丙 10 == 27，每条恰属一段', (t) => {
  if (!MAP_EXISTS || !PACK_EXISTS) return t.skip(SKIP_REASON);
  const rows = mappingRows(mapText);
  const counts = { 甲: 0, 乙: 0, 丙: 0 };
  for (const r of rows) {
    assert.ok(r.segment in counts, `${r.id} 的段「${r.segment}」不是 甲/乙/丙`);
    counts[r.segment] += 1;
  }
  assert.equal(rows.length, 27, `映射表有 ${rows.length} 行（不是 27）`);
  for (const [seg, n] of Object.entries(SEGMENT_COUNTS)) {
    assert.equal(counts[seg], n, `${seg} 段是 ${counts[seg]} 条（规格写的是 ${n}）`);
  }
});

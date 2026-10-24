// platform/test/template-spec.test.js —— 「通用赛事模板规格」机器闸
//
// 依据：
//   - `docs/platform-template-spec.md` 是本仓对「平台 = 引擎 / 项目 = 赛制实例」的规格。
//   - 该规格 §6 自称「契约的执行者是机器闸，不是文档的自觉」
//     ⇒ **这份规格自己也必须被机器质问**，否则它只是一篇会过期的散文。
//
// ⚠️ **为什么需要它**（真实动机）：
//   这份规格里有**可数的断言**（S1 的「24 处硬编码 / 12 个文件」），
//   而代码是会演进的 ⇒ 数字会**悄悄过期**。
//   ⇒ 一份过期却还在自称准确的规格，**比没有规格更坏**：
//     它会让人以为「结构层就这些，改完就好了」⇒ 照着错的边界做改造。
//
// ── 四条判据 ──────────────────────────────────────────────────────────────
//   ① **登记等价**：规格文档与 P13 §4.13 登记的代码块**逐字节相同**
//      ⇒ 改了文档必须同步登记（规格与计划不许漂移）。
//   ② **S1 数字可复算**：实时扫描 `platform/src/` 的席位字面量，
//      与文档 §3 S1 表**逐文件逐处**一致。
//   ③ **结构层锚点仍在位**：S2/S3/S4 引用的关键符号仍存在。
//   ④ **16 份配置仍同版本**：§2 / §6 的「版本全等」口径仍成立。
//
// ⚠️ **口径必须写在文档里，不能只活在脑子里**：
//   ② 的计数口径写在文档 §3 S1（可执行代码 / 一行算一处 / 排除注释 / 排除 config.js）
//   ⇒ 本闸按**文档写明的口径**扫描，而不是按本文件的私货口径
//   ⇒ 口径变了 ⇒ 文档先改 ⇒ 闸再照着改 ⇒ 不会出现「文档与闸各算各的」。
//
// ⚠️ **为什么 S1 要排除 `src/config.js`**：
//   那是**配置校验器** ⇒ 它的字面量是「允许值契约」本身
//   （新项目换席位词表时，那里的字面量恰恰是**要跟着改**的地方之一），
//   而不是「某处业务偷偷写死了席位」。把它算进去 ⇒ 24 变 29 ⇒ 数字失去意义。
//
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert + node:fs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from '../test-helpers/strip-comments.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PLATFORM_DIR, '..');

const SPEC_PATH = join(REPO_ROOT, 'docs/platform-template-spec.md');
const PLAN_PATH = join(REPO_ROOT, 'docs/superpowers/plans/2026-10-23-platform-P13-defect-fixes.md');
const RULES_DIR = join(PLATFORM_DIR, 'rules');
const SRC_DIR = join(PLATFORM_DIR, 'src');

// ⚠️ **不适用就跳过，不许假装通过**：公开仓在本文档发布前没有这个文件
//   （与 E183 的「isFile() 判存在」同一教训：目录 / 缺失都归入「不适用」）。
const SPEC_EXISTS = existsSync(SPEC_PATH) && statSync(SPEC_PATH).isFile();
const PLAN_EXISTS = existsSync(PLAN_PATH) && statSync(PLAN_PATH).isFile();
const SKIP_REASON = '通用模板规格文档尚未在本仓落地（公开仓发布前）⇒ 本闸不适用';

const specText = SPEC_EXISTS ? readFileSync(SPEC_PATH, 'utf8') : '';
const planText = PLAN_EXISTS ? readFileSync(PLAN_PATH, 'utf8') : '';

/** 递归列出目录下的 .js 文件（按路径排序 ⇒ 扫描结果稳定）。 */
function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 从计划文件里取出「规格文档」的登记代码块（```markdown 围栏）。
 * 定位信号：紧邻围栏的路径行 —— 本仓约定 `` `docs/xxx.md`： `` 写在围栏上一行。
 * @returns {string|null} 块内容（不含围栏）；找不到返回 null
 */
function extractPlanBlock(text, relPath) {
  const lines = text.split('\n');
  const marker = lines.findIndex((l) => l.trim() === '`' + relPath + '`：');
  if (marker < 0) return null;
  let i = marker + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !lines[i].startsWith('```')) return null;
  const body = [];
  for (i += 1; i < lines.length; i++) {
    if (lines[i] === '```') return body.join('\n');
    body.push(lines[i]);
  }
  return null;
}

/**
 * 取文档里某个二级/三级小节的正文（到下一个同级或更高级标题为止）。
 * @param {string} text 文档全文
 * @param {string} heading 标题前缀（如 '### S1'）
 */
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i])) return lines.slice(start + 1, i).join('\n');
  }
  return lines.slice(start + 1).join('\n');
}

/**
 * 实时扫描「席位词表硬编码」的处数（口径 = 文档 §3 S1 写明的那条）。
 * @returns {Record<string, number>} 相对 platform/ 的文件路径 → 处数
 */
function scanSeatLiterals() {
  const SEAT_LITERALS = ["'judge'", "'enterprise'", "'observer'"];
  const out = {};
  for (const file of listJsFiles(SRC_DIR)) {
    const rel = relative(PLATFORM_DIR, file);
    // ⛔ 排除配置校验器（口径写在文档 §3 S1，理由见文件头注释）
    if (rel === 'src/config.js') continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    let count = 0;
    for (const line of src.split('\n')) {
      // ⚠️ **按行计，不按字面量计**：一行里出现多个席位字面量仍只算一处
      //    （例：`const JUDGE_SEATS = ['judge','enterprise','observer'];` = 1 处）
      if (SEAT_LITERALS.some((s) => line.includes(s))) count += 1;
    }
    if (count > 0) out[rel] = count;
  }
  return out;
}

/**
 * 解析文档 §3 S1 表格（| `路径` | 处数 | 两列）。
 * @returns {Record<string, number>}
 */
function parseSeatTable(text) {
  const body = sectionBody(text, '### S1');
  assert.ok(body, '文档里找不到 §3 S1 小节（表格是 S1 的硬编码处数清单）');
  const out = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

test('★ 规格文档已落地（本文是它的存在前提）', (t) => {
  if (!SPEC_EXISTS) return t.skip(SKIP_REASON);
  assert.ok(specText.length > 0, '规格文档是空的');
});

test('★ 登记等价：规格文档与 P13 §4.13 登记的代码块逐字节一致', (t) => {
  if (!SPEC_EXISTS || !PLAN_EXISTS) return t.skip(SKIP_REASON);
  const block = extractPlanBlock(planText, 'docs/platform-template-spec.md');
  assert.ok(block, 'P13 计划里找不到规格文档的登记块（新增文件必须登记进计划块）');
  // ⚠️ 比较时**两端都去掉尾换行**：计划的围栏块天然不带尾换行，
  //    而文件带 ⇒ 直接比会永远差一个字节（假红）。
  const onDisk = specText.replace(/\r\n/g, '\n').replace(/\n$/, '');
  assert.equal(block, onDisk,
    '规格文档与计划块不一致（改了文档必须同步登记：node docs/tools/plan-block-sync.mjs <plan> . docs/platform-template-spec.md）');
});

test('★ S1 的硬编码处数可复算（文档写的与实时扫描逐文件逐处一致）', (t) => {
  if (!SPEC_EXISTS) return t.skip(SKIP_REASON);
  const documented = parseSeatTable(specText);
  const live = scanSeatLiterals();
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(live).sort(),
    '文档 §3 S1 表里的文件清单与实际扫描不一致（结构层残留变了 ⇒ 文档必须更新）');
  for (const [rel, count] of Object.entries(live)) {
    assert.equal(documented[rel], count,
      `文档 §3 S1 表写「${rel} = ${documented[rel]} 处」，实际扫描是 ${count} 处`);
  }
  const total = Object.values(live).reduce((a, b) => a + b, 0);
  const files = Object.keys(live).length;
  assert.ok(total > 0 && files > 0, '扫描不到任何席位字面量（口径写错了 ⇒ 闸会假绿）');
});

test('★ 结构层锚点仍在位（S2 / S3 / S4 引用的符号没被悄悄改掉）', (t) => {
  if (!SPEC_EXISTS) return t.skip(SKIP_REASON);
  const read = (rel) => readFileSync(join(PLATFORM_DIR, rel), 'utf8');

  // S2 · 赛段结构
  const stage = read('src/services/stage.js');
  assert.match(stage, /STAGE_KINDS\s*=\s*\[[^\]]*'initial'[^\]]*'final'/,
    'S2 锚点失配：services/stage.js 的 STAGE_KINDS 不再是文档写的那组赛段类型');
  assert.match(stage, /SCORING_CONFIG_KEYS\s*=\s*\[[^\]]*'initial'[^\]]*'final'/,
    'S2 锚点失配：services/stage.js 的 SCORING_CONFIG_KEYS 不再是文档写的那组评分配置键');
  assert.match(read('src/services/leaderboard.js'), /scoring_config_key\s*===\s*'final'/,
    'S2 锚点失配：终赛段判定不再依赖 scoring_config_key === "final"（破同分 final_only 作用域会漂）');

  // S3 · 段位兜底
  const visibility = read('src/domain/visibility.js');
  assert.match(visibility, /DEFAULT_TIER_ORDER\s*=\s*\[[^\]]*'D'[^\]]*'C'/,
    'S3 锚点失配：domain/visibility.js 的 DEFAULT_TIER_ORDER 不再是文档写的兜底顺序');
  assert.match(visibility, /publicFromTier\s*\|\|\s*'C'/,
    'S3 锚点失配：domain/visibility.js 的公示起始档兜底不再是 "C"');
  assert.match(read('src/domain/tier.js'), /key:\s*'D'/,
    'S3 锚点失配：domain/tier.js 的兜底段位不再是 "D"');

  // S1 · 席位词表（半外置的现状 + SQL 那处）
  assert.match(read('src/domain/judge-pool.js'), /config\.votingSeats/,
    'S1 锚点失配：domain/judge-pool.js 不再从 config.votingSeats 读席位');
  assert.match(read('src/domain/judge-pool.js'), /config\.nonVotingSeats/,
    'S1 锚点失配：domain/judge-pool.js 不再从 config.nonVotingSeats 读非投票席');
  assert.match(read('src/db/repo/stages.js'), /role_key\s+IN\s*\(\s*'judge'\s*,\s*'enterprise'\s*,\s*'observer'\s*\)/,
    'S1 锚点失配：db/repo/stages.js 的 SQL 席位词表不再是文档写的那一组');

  // S4 · 表结构耦合（团队制 / 企业确认 / MBA 资格）
  // ⚠️ **三处耦合分属不同迁移文件**（不是都在 001）⇒ 别把它们指到同一个文件上：
  //   · 001：users.mba_status（参赛资格类别）
  //   · 002：task_packages.enterprise_id / is_free_brief（报名与任务包）
  //   · 003：stage_reviews.team_id（评审以队为单位）+ enterprise_confirmations（企业确认）
  //   · 004：points_ledger.team_id / tier_records.team_id（积分与段位以队为单位）
  const init = readFileSync(join(PLATFORM_DIR, 'db/migrations/001_init.sql'), 'utf8');
  const reg = readFileSync(join(PLATFORM_DIR, 'db/migrations/002_registration.sql'), 'utf8');
  const review = readFileSync(join(PLATFORM_DIR, 'db/migrations/003_review.sql'), 'utf8');
  const lb = readFileSync(join(PLATFORM_DIR, 'db/migrations/004_leaderboard.sql'), 'utf8');
  assert.match(init, /mba_status/, 'S4 锚点失配：001_init.sql 里不再有 mba_status（参赛资格类别假设已变 ⇒ 文档 §3 S4 必须更新）');
  assert.match(reg, /enterprise_id/, 'S4 锚点失配：002_registration.sql 里不再有 enterprise_id');
  assert.match(reg, /is_free_brief/, 'S4 锚点失配：002_registration.sql 里不再有 is_free_brief（自由命题假设已变）');
  assert.match(review, /CREATE TABLE[\s\S]*?enterprise_confirmations/, 'S4 锚点失配：003_review.sql 里不再有 enterprise_confirmations 表');
  assert.match(lb, /CREATE TABLE points_ledger[\s\S]*?team_id\s+TEXT REFERENCES teams\(id\)/,
    'S4 锚点失配：points_ledger 不再以 team_id 为外键（个人赛改造已发生 ⇒ 文档 §3 S4 必须更新）');
  assert.match(lb, /CREATE TABLE tier_records[\s\S]*?team_id\s+TEXT NOT NULL REFERENCES teams\(id\)/,
    'S4 锚点失配：tier_records 不再以 team_id 为外键（个人赛改造已发生）');
  assert.match(review, /CREATE TABLE stage_reviews[\s\S]*?team_id\s+TEXT NOT NULL REFERENCES teams\(id\)/,
    'S4 锚点失配：stage_reviews 不再以 team_id 为外键（评审不再以队为单位）');
});

test('★ 16 份配置仍同版本（§2 / §6 的「版本全等」口径仍成立）', (t) => {
  if (!SPEC_EXISTS) return t.skip(SKIP_REASON);
  const files = readdirSync(RULES_DIR).filter((n) => n.endsWith('.json')).sort();
  assert.equal(files.length, 16, `rules/ 目录现在有 ${files.length} 份配置（文档写的是 16 份 ⇒ 文档或配置必须更新）`);
  const versions = new Set();
  for (const name of files) {
    const rules = JSON.parse(readFileSync(join(RULES_DIR, name), 'utf8'));
    // ⛔ 每份都必须**自带** version：校验器按 id 识别配置，不按 version
    //    ⇒ 少一份 version 会**静默失效**（不会报错，只会不算）。
    assert.ok(rules.version, `rules/${name} 没有 version 字段（会静默失效）`);
    versions.add(rules.version);
  }
  assert.equal(versions.size, 1, `16 份配置版本不一致：${[...versions].join(' / ')}`);
  assert.match(specText, new RegExp(files.length + ' 份配置'),
    '文档里没有写「' + files.length + ' 份配置」这个口径数（配置份数变了 ⇒ 文档必须更新）');
});

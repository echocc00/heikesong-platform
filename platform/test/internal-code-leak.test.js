// platform/test/internal-code-leak.test.js —— 「内部标识不许出现在用户可见界面上」机器闸
//
// 依据：
//   - S-5 / C-05「降级必须显式展示，不静默」⇒ 告警**一条都不许少**（本闸只管**怎么显示**）。
//   - 设计文档 §6.6 + src/domain/visibility.js 头注释「可见性必须在 API 层过滤：
//     **前端隐藏 = 数据已经发到浏览器 = 任何人都能看到**」⇒ 内部标识的处置在**数据层**，
//     界面只渲染人话。
//   - 「内部工作语言不进正文」（web/views/leaderboard.js 文件头的既有契约）。
//
// ⚠️ **本闸为什么必须单独成一个文件**（而不是塞进 warning-wording.test.js）：
//   它钉的是**跨文件**的不变量（领域层产的码清单 → 界面渲染 → API 响应），
//   塞进任何既有测试文件都会让「这条钉的是哪条口径」看不出来。
//
// ── E184（2026-10-28）：这条闸的由来 ─────────────────────────────────────
//   真机截图：公开榜单页顶部「本轮降级提示」里直接印着
//   `normalization_fallback` / `R2_missing_dual_signature` / `dimension_no_scores` …
//   ⇒ **内部规则键被渲染给了每一个访客**。
//   ⚠️ 根因是**三层各修了一半**：
//     E135（2026-10-23）修的是 `[code]` **方括号前缀**；
//     E144（2026-10-23）修的是演示站漏了 `detail` 裁剪；
//     E172（2026-10-24）修的是裁剪用黑名单 ⇒ 改成白名单，但把 `code` 当
//       「机器判据 / 审计靠它定位」而**故意留在白名单里**；
//     P10（2026-10-23）把 `[code]` 降级成「小号等宽标签」（`.warn__code`）——
//       **标签仍是可见文本** ⇒ 同一个洞只补了外层。
//   ⇒ 现在收口：**公开响应里连 `code` 都不下发**（领域层白名单），
//     **界面上一律不渲染**（本闸）。
//
// ⚠️ **本闸是行为闸，不是源码字符串闸**：
//   断言的是「渲染出来的 HTML 里有没有内部码」与「响应体里有没有内部码」，
//   不是「源码里有没有某个字符串」（那种断言会被无关代码顶替）。
//
// ⚠️ **清单必须实时抽**（test-helpers/internal-codes.js）：
//   手写清单 ⇒ 新加的码只要没顺手补进去就漏过去 ⇒ 闸是假绿的。
//   ⇒ 领域层/服务层每写一个 `code: '…'` 就自动进清单 ⇒ 漏一个就红。
//
// ⚠️ **审计页是显式例外**（见下方 DECLARED_EXCEPTIONS）：
//   `web/views/audit.js` 是**审计工作台**（能力点 `audit:read` 保护），
//   它按设计展示内部标识（英文维度键、降级原因码）—— 那是审计定位能力的落点，
//   不是泄漏。⇒ 例外必须**登记 + 写理由**，不许静默豁免。
//
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leaderboardHtml } from '../web/views/leaderboard.js';
import { publishHtml, publishMissingHtml } from '../web/views/publish.js';
import { buildReviewItems, reviewErrorHint } from '../web/views/review.js';
import { applyVisibility } from '../src/domain/visibility.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';
import { loadRules } from '../src/config.js';
import { internalWarningCodes, internalDimensionKeys } from '../test-helpers/internal-codes.js';
import { stripComments } from '../test-helpers/strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_VIEWS_DIR = join(here, '..', 'web', 'views');

/** 内部规则键清单（从源码实时抽）。 */
const CODES = internalWarningCodes();
/** 英文维度键清单（从规则集实时抽）。 */
const DIM_KEYS = internalDimensionKeys();

/**
 * 显式登记的例外：哪些界面**按设计**可以出现内部标识。
 * ⚠️ 例外必须写理由（不许静默豁免）—— 与 demo parity 的
 *    `DECLARED_DEMO_EXCLUSIONS` 同一取向：**没人知道的豁免 = 假的全覆盖**。
 * ⚠️ `scope` 决定这条例外覆盖哪一道闸（不许一刀切）。
 */
const DECLARED_EXCEPTIONS = [
  {
    view: 'audit.js',
    scope: 'internal-identifiers',
    reason: '审计工作台（能力点 audit:read 保护）：它按设计展示英文维度键与降级原因码 —— '
      + '那是审计定位能力的落点（把一条降级告警定位到具体规则），不是对外泄漏。',
  },
  {
    view: 'publish.js',
    scope: 'hardcoded-code-set',
    reason: '发榜页的「硬降级 / 提示」分级判据抄在视图里（`HARD_WARNING_CODES`）。'
      + '⚠️ **已知缺陷**：前端自己维护一份后端判据 ⇒ 新加的硬降级码会漏判'
      + '（分级漂移），且与发榜页自己写的「这些结论都来自 API，前端不自己判定」相矛盾。'
      + '本轮**只登记不修** —— 分级口径属**业务裁决**（哪些算硬降级）'
      + '⇒ 不得由代码单方面拍板 ⇒ 待办 **E185**（需送签口径 + 下沉到领域层）。'
      + '⚠️ 它**不渲染**这些码（E184 已把 `【code】` 前缀换成 `【硬降级】`）'
      + '⇒ 这条例外与「内部码泄漏」无关，只与「判据漂移」有关。',
  },
];

// ══════════════════════════════════════════════════════════════════
// 一、清单本身：空清单 = 假绿
// ══════════════════════════════════════════════════════════════════

test('★ 清单不是空的：内部码 ≥ 20 条、维度键 ≥ 3 条（空清单等于没保护）', () => {
  assert.ok(CODES.length >= 20,
    `内部码清单只有 ${CODES.length} 条 —— 抽取口径坏了（否则本文件所有闸都是假绿）`);
  assert.ok(DIM_KEYS.length >= 3,
    `维度键清单只有 ${DIM_KEYS.length} 条 —— 抽取口径坏了`);
  // ⚠️ 抽样核对：清单必须真的含「臭名昭著」的那几个码
  for (const must of ['normalization_fallback', 'dimension_no_scores', 'R2_missing_dual_signature']) {
    assert.ok(CODES.includes(must), `清单里必须有 ${must}`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 二、界面层：渲染结果里不许出现内部标识
// ══════════════════════════════════════════════════════════════════

/** 造一组「每个内部码一条」的告警（正文刻意不含码 ⇒ 只可能从 code 字段漏出去）。 */
function warningsOfEveryCode() {
  return CODES.map((code, i) => ({
    code,
    message: `第 ${i + 1} 条降级说明。`,
    stageName: '决赛赛段',
  }));
}

test('★ 榜单页（公开公示页）：每一个内部码都不许出现在渲染结果里', () => {
  const html = leaderboardHtml({
    scope: 'rolling',
    warnings: warningsOfEveryCode(),
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  const leaked = CODES.filter((c) => html.includes(c));
  assert.deepEqual(leaked, [], `榜单页渲染出了内部码：${leaked.join(', ')}`);
  // ⚠️ 判别性：夹具必须真的被渲染了（不然上面那条断言是假绿）
  assert.ok(html.includes('第 1 条降级说明。'), '告警正文必须真的渲染出来（否则这条闸是假绿）');
  assert.ok(html.includes('本轮降级提示'), '告警块必须真的渲染出来');
});

test('★ 发榜页：每一个内部码都不许出现在渲染结果里', () => {
  const html = publishHtml({
    board: {
      stage: { id: 'st_1', name: '决赛赛段' },
      teams: [{ id: 't_alpha', name: '拾光队' }],
      judgeDimensions: DIM_KEYS.map((key, i) => ({ key, name: `维度${i + 1}`, weight: 0.1, seat: 'judge' })),
      progress: { scope: 'stage', total: 0, submitted: 0, missing: [] },
    },
    result: { computationId: 'cmp_1', revision: 1, teams: [], warnings: warningsOfEveryCode() },
  });
  const leaked = CODES.filter((c) => html.includes(c));
  assert.deepEqual(leaked, [], `发榜页渲染出了内部码：${leaked.join(', ')}`);
  assert.ok(html.includes('第 1 条降级说明。'), '告警正文必须真的渲染出来（否则这条闸是假绿）');
});

test('★ 评审页的错误提示：英文维度键不许出现（只给人话维度名）', () => {
  const dims = DIM_KEYS.map((key, i) => ({ teamId: 't_alpha', key, name: `维度${i + 1}` }));
  const { errors } = buildReviewItems({}, dims);
  assert.ok(errors.length > 0, '夹具必须产出错误（否则这条闸是假绿）');
  // ⚠️ 必须调**生产路径**的纯函数（reviewErrorHint）——
  //    若在测试里重写一遍拼接逻辑，改生产代码闸不会红 ⇒ 假绿（变异检验 M5 实测抓到过）。
  const hint = reviewErrorHint(errors, dims);
  const leaked = DIM_KEYS.filter((k) => hint.includes(k));
  assert.deepEqual(leaked, [], `错误提示里出现了英文维度键：${leaked.join(', ')}`);
  assert.ok(hint.includes('维度1'), '中文维度名必须真的出现（否则这条闸是假绿）');
});

test('★ 发榜页的缺格面板：英文维度键不许出现', () => {
  const judgeDimensions = DIM_KEYS.map((key, i) => ({ key, name: `维度${i + 1}` }));
  const html = publishMissingHtml(
    { missing: DIM_KEYS.map((key) => ({ teamId: 't_alpha', dimension: key, judgeId: 'u_j1' })) },
    [{ id: 't_alpha', name: '拾光队' }],
    judgeDimensions,
  );
  const leaked = DIM_KEYS.filter((k) => html.includes(k));
  assert.deepEqual(leaked, [], `缺格面板里出现了英文维度键：${leaked.join(', ')}`);
  assert.ok(html.includes('拾光队'), '队名必须真的出现（否则这条闸是假绿）');
});

// ══════════════════════════════════════════════════════════════════
// 三、数据层：公开响应里连内部码都不下发（fail-closed）
// ══════════════════════════════════════════════════════════════════

test('★ 领域层唯一入口 applyVisibility：没有 audit:read ⇒ 内部码一个都不许下发', () => {
  const payload = {
    scope: 'rank',
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
    warnings: warningsOfEveryCode(),
  };
  const out = applyVisibility({
    payload,
    viewer: null,
    visibilityConfig: { rank: { showEnterpriseName: false } },
    context: { scope: 'rank' },
  });
  assert.equal(out.warnings.length, CODES.length, '告警一条都不许少（S-5 / C-05）');
  const leaked = CODES.filter((c) => JSON.stringify(out.warnings).includes(c));
  assert.deepEqual(leaked, [], `公开响应里下发了内部码：${leaked.join(', ')}`);
  for (const w of out.warnings) {
    assert.equal(w.code, undefined, '公开响应里的告警不许带 code');
    assert.ok(w.message, '人话正文必须保留');
  }
});

test('★ 领域层唯一入口 applyVisibility：有 audit:read ⇒ 完整告警（含 code）仍在', () => {
  const payload = {
    scope: 'rank',
    rows: [],
    warnings: warningsOfEveryCode(),
  };
  const out = applyVisibility({
    payload,
    viewer: { id: 'u_auditor' },
    visibilityConfig: { rank: { showEnterpriseName: false } },
    context: { scope: 'rank', canAudit: true },
  });
  assert.equal(out.warnings.length, CODES.length, '告警一条都不许少');
  const missing = CODES.filter((c) => !out.warnings.some((w) => w.code === c));
  assert.deepEqual(missing, [], `审计员必须拿得到全部 code（审计定位靠它）：${missing.join(', ')}`);
});

// ══════════════════════════════════════════════════════════════════
// 五、正文层：告警的 message 里不许出现内部规则号 / 内部原因码
//    （E184 的第二批发现：`code` 字段本身治好了，但**正文里还内嵌着码**）
// ══════════════════════════════════════════════════════════════════

/**
 * 真实的领域层告警（走真引擎，不是手搓夹具）。
 * ⚠️ 夹具必须**覆盖多条产生路径**（评分 / 企业席 / 名册缺失），
 *    否则「正文里没有码」只是因为那条路径没被跑到。
 */
function realDomainWarnings() {
  const { rules } = loadRules(join(here, '..', 'rules'));
  const config = rules.scoring.final;
  const out = [];

  // ① 评分路径：归一化降级 / 自评差异 / 缺分维度 / 没有评分
  out.push(...scoreStage({
    config,
    judges: [{ judgeId: 'j1', seat: 'judge' }],
    submissions: [
      { judgeId: 'j1', teamId: 't_a', dimension: 'feasibility', rawScore: 70 },
      { judgeId: 'j1', teamId: 't_b', dimension: 'feasibility', rawScore: 62 },
    ],
    enterpriseConfirmations: [],
    peerReviews: [],
    teams: [
      { teamId: 't_a', packageEnterpriseId: 'e_1', isFreeBrief: false },
      { teamId: 't_b', packageEnterpriseId: 'e_1', isFreeBrief: false },
    ],
    selfReviews: [{ teamId: 't_a', dimension: 'feasibility', rawScore: 54.8 }],
  }).warnings);

  // ② 名册缺失路径：team_roster_missing
  out.push(...scoreStage({
    config,
    judges: [{ judgeId: 'j1', seat: 'judge' }],
    submissions: [],
    enterpriseConfirmations: [],
    peerReviews: [],
    teams: [],
    selfReviews: [],
  }).warnings);

  // ③ 企业席路径：缺双签 / 缺签字内容
  const ent = applyEnterpriseRules({
    config,
    confirmations: [{ teamId: 't_a', enterpriseId: 'e_1', reasons: ['content'], score: 80 }],
    teams: [{ teamId: 't_a', packageEnterpriseId: 'e_1', isFreeBrief: false }],
    judges: [],
  });
  out.push(...(ent.warnings ?? []));

  return out;
}

test('★ 正文层：真实引擎产出的告警正文里不许出现内部规则号 / 内部原因码', () => {
  const warnings = realDomainWarnings();
  assert.ok(warnings.length >= 3, `夹具必须产出多条告警（实际 ${warnings.length} 条）`);
  const offenders = [];
  for (const w of warnings) {
    const msg = String(w?.message ?? '');
    // ① 内部规则号：R1 / R4 / R-JDG-14 …
    for (const m of msg.matchAll(/\bR-?[A-Z]*-?\d+\b/g)) offenders.push(`${w.code} 的正文里有规则号 ${m[0]}`);
    // ② 其他内部码（判据里内部原因码都在清单上）
    for (const code of CODES) {
      if (code === w.code) continue;   // 本条告警自己的码不算「内嵌别人的码」
      if (msg.includes(code)) offenders.push(`${w.code} 的正文里内嵌了 ${code}`);
    }
  }
  assert.deepEqual(offenders, [], `告警正文里出现了内部标识：\n${offenders.join('\n')}`);
});

test('★ 正文层：源码里的告警正文不许拼内部码 / 内部规则号（防回流）', () => {
  const offenders = [];
  for (const file of domainAndServiceFiles()) {
    const src = stripComments(readFileSync(file, 'utf8'));
    // 取每个 `message:` 之后、下一个 `message:` / `detail:` / `code:` 之前的窗口
    const marks = [...src.matchAll(/\b(message|detail|code):/g)];
    for (let i = 0; i < marks.length; i += 1) {
      if (marks[i][1] !== 'message') continue;
      const from = marks[i].index;
      const to = i + 1 < marks.length ? marks[i + 1].index : src.length;
      const win = src.slice(from, Math.min(to, from + 400));
      if (/\.code\b/.test(win)) {
        offenders.push(`${file.replace(/.*platform\//, '')}: 正文里拼了错误码`);
      }
      for (const m of win.matchAll(/\bR-?[A-Z]*-?\d+\b/g)) {
        offenders.push(`${file.replace(/.*platform\//, '')}: 正文里有规则号 ${m[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `告警正文里拼了内部标识：\n${offenders.join('\n')}`);
});

// ══════════════════════════════════════════════════════════════════
// 六、静态闸：视图的模板插值里不许引用 `code` 标识符（防回流）
// ══════════════════════════════════════════════════════════════════

function listViewFiles() {
  const out = [];
  for (const name of readdirSync(WEB_VIEWS_DIR).sort()) {
    const p = join(WEB_VIEWS_DIR, name);
    if (statSync(p).isFile() && name.endsWith('.js')) out.push({ name, path: p });
  }
  return out;
}

/** 领域层 + 服务层的源文件（告警正文的产地）。 */
function domainAndServiceFiles() {
  const out = [];
  for (const dir of ['domain', 'services']) {
    const root = join(here, '..', 'src', dir);
    const walk = (d) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js')) out.push(p);
      }
    };
    walk(root);
  }
  return out;
}

/**
 * 抽出源码里的**模板字面量**（反引号包起来的那些）。
 * ⚠️ 只关心「会被渲染进 HTML 的那段文本」⇒ 判据是「字面量里有没有内部码」。
 * ⚠️ 手工扫描（不是正则）：模板里可以嵌套 `${ … }`（里面还能有反引号），
 *    正则会在嵌套处切错。
 */
function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '`') { i += 1; continue; }
    const start = i;
    i += 1;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && src[i + 1] === '{') { depth += 1; i += 2; continue; }
      if (c === '}' && depth > 0) { depth -= 1; i += 1; continue; }
      if (c === '`' && depth === 0) { i += 1; break; }
      i += 1;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

test('★ 静态闸：视图的模板插值里不许出现 `code` 标识符（内部键不许被拼进 HTML）', () => {
  const offenders = [];
  for (const { name, path } of listViewFiles()) {
    // ⛔ 先剥注释：注释里举例子写 `normalization_fallback` 是**说明**，不是渲染
    const src = stripComments(readFileSync(path, 'utf8'));
    for (const m of src.matchAll(/\$\{([^{}]*)\}/g)) {
      if (/\bcode\b/.test(m[1])) {
        offenders.push(`${name}: ${m[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `视图把 code 标识符拼进了 HTML（内部规则键会泄到界面上）：\n${offenders.join('\n')}`);
});

test('★ 静态闸：视图的模板字面量里不许出现任何内部码字面量（渲染层不许硬编码内部码）', () => {
  const offenders = [];
  for (const { name, path } of listViewFiles()) {
    const src = stripComments(readFileSync(path, 'utf8'));
    for (const tpl of templateLiterals(src)) {
      for (const code of CODES) {
        // 只认「被引号包起来的完整字面量」：避免把长词里的子串误判
        if (new RegExp(`(['"\`])${code}\\1`).test(tpl)) offenders.push(`${name}: ${code}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `视图把内部码写进了 HTML 模板（渲染层不许硬编码内部码）：\n${offenders.join('\n')}`);
});

test('★ 静态闸：视图里硬编码的内部码集合必须显式登记（前端抄后端判据 ⇒ 会漂）', () => {
  const offenders = [];
  for (const { name, path } of listViewFiles()) {
    const src = stripComments(readFileSync(path, 'utf8'));
    const hardcoded = CODES.filter((code) => new RegExp(`(['"\`])${code}\\1`).test(src));
    if (hardcoded.length < 3) continue;   // 单个码不算「抄了一份判据」
    const registered = DECLARED_EXCEPTIONS.some(
      (e) => e.view === name && e.scope === 'hardcoded-code-set',
    );
    if (!registered) {
      offenders.push(`${name}: ${hardcoded.join(', ')}（未在 DECLARED_EXCEPTIONS 登记）`);
    }
  }
  assert.deepEqual(offenders, [],
    `视图硬编码了内部码集合却没有显式登记（前端自己抄了一份后端判据 ⇒ 会漂）：\n${offenders.join('\n')}`);
});

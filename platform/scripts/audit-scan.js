// scripts/audit-scan.js — 发布前证据链扫描闸
// 依据：R-AUD-03「禁用词/证伪清单扫描：禁用清单必须真有词条，空清单不等于已保护」
//   溯源：evidence-chain Skill 闸 3；项目自己的踩坑记录——
//   「跑扫描发现 forbidden.txt 存在但无词条 —— 该闸未生效」。
// ⛔ 清单为空 → 直接报错退出（不静默通过）。
// ⛔ 排除项（清单自身、扫描器、测试夹具、被跳过的目录）必须在报告里打印出来——不静默的排除。
// ✅ 语法已与共享 skill 对齐（2026-10-20）：
//    共享的 `~/.minimax/skills/evidence-chain/scripts/audit-evidence.js` 现已支持
//    `@skip-path <路径正则>` 与 `<禁用词>|<豁免正则1>,<豁免正则2>` 两种语法，
//    并且空清单告警、回环地址不计入发行方、占位符密度只统计正文（不含围栏代码块）。
//    本平台的扫描器与它【必须行为一致】——同一个 forbidden.txt 在两边跑，结果不能不同。
// 用法：node scripts/audit-scan.js [root...]   默认扫 ../docs 与 .（即 platform/）
// P6 追加（发布前扫描闸）：默认范围再加【发布产物 platform/web/dist/】——
//   发布产物本身也必须过闸（构建出来的静态站里不许有禁用表述）。
//   ⚠️ 这一趟【不认清单里的 @skip-path】：否则清单自己就能把闸关掉
//      （与「空清单 ≠ 已保护」同一类病）。
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, dirname, resolve, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PLATFORM_DIR, '..');

const TEXT_EXT = new Set(['.md', '.txt', '.js', '.json', '.sql', '.html', '.css', '.yml', '.yaml']);
const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'data', 'dist', 'build', 'coverage',
  'forbidden.txt', 'audit-scan.js', '*.test.js',
];

/**
 * 每个默认排除项的**理由**（报告里必须说清楚「为什么被排除」，不静默）。
 * ⚠️ 「排除项」本身是有代价的：排错了 ⇒ 真违规被藏起来 ⇒ 闸失效。
 *   ⇒ 理由写在这里，而不是「大家都知道」。
 */
const DEFAULT_EXCLUDE_REASONS = {
  'node_modules': '第三方依赖目录（不是本仓产物）',
  '.git': '版本库内部目录',
  'data': '运行期数据目录（库文件是二进制，与文档无关）',
  'dist': '构建产物目录（发布产物 platform/web/dist/ 由审计扫描器**单独**再扫一遍，那一趟不认本项排除）',
  'build': '构建产物目录',
  'coverage': '覆盖率报告目录',
  'forbidden.txt': '**禁用清单自身** —— 清单按设计必须逐字写出被禁词条，否则闸不生效 ⇒ 自己命中自己是恒真',
  'audit-scan.js': '扫描器自身（词条字面量写在源码里）',
  '*.test.js': '测试夹具（故意写错的样本，不是交付物）',
};

/**
 * 解析禁用清单。
 * 语法：
 *   <禁用词>[|<豁免正则1>,<豁免正则2>]   命中即违规；同行命中豁免正则 → 记为"更正语境"，不计违规但会出现在报告里
 *   @skip-path <路径正则>                整条路径跳过（相对仓库根；排除项会打印）
 *   # 开头为注释，空行忽略
 */
export function parseManifest(text) {
  const terms = [];
  const skipPaths = [];
  // ⚠️ 每条 @skip-path 的**理由**：取它上方那段连续的注释（清单里就写着理由，
  //    报告里必须把它**带出来** —— 「跳过了但不知道为什么」= 没登记）。
  const skipPathMeta = [];
  const errors = [];
  const seen = new Set();
  let commentBuf = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { commentBuf = []; continue; }
    if (line.startsWith('#')) {
      // 单独一行 '#' 是**分隔符** ⇒ 它之前的注释不属于下一条的由
      if (line === '#') commentBuf = [];
      else commentBuf.push(line.replace(/^#\s?/, ''));
      continue;
    }
    if (line.startsWith('@skip-path')) {
      const pattern = line.slice('@skip-path'.length).trim();
      const reason = commentBuf.join(' ');
      commentBuf = [];
      if (!pattern) {
        errors.push('@skip-path 后面必须跟路径正则');
        continue;
      }
      try {
        skipPaths.push(new RegExp(pattern));
        skipPathMeta.push({ pattern, regex: skipPaths[skipPaths.length - 1], reason });
      } catch (e) {
        errors.push(`@skip-path 正则非法：${pattern}（${e.message}）`);
      }
      continue;
    }
    commentBuf = [];
    const [term, exemptPart] = splitOnce(line, '|');
    const t = term.trim();
    if (!t) {
      errors.push(`清单里有一行只有分隔符没有词条：${line}`);
      continue;
    }
    if (seen.has(t)) {
      errors.push(`清单里有重复词条：${t}`);
      continue;
    }
    seen.add(t);
    let exemptRegex = null;
    if (exemptPart !== null) {
      const pattern = exemptPart.split(',').map((s) => s.trim()).filter(Boolean).join('|');
      if (pattern) {
        try {
          exemptRegex = new RegExp(pattern);
        } catch (e) {
          errors.push(`词条「${t}」的豁免正则非法：${pattern}（${e.message}）`);
        }
      }
    }
    terms.push({ term: t, exemptRegex });
  }

  if (terms.length === 0) {
    // ⛔ 空清单 = 闸未生效。这是最重要的一个失败。
    errors.push('禁用清单为空 —— 闸未生效（空清单 ≠ 已保护）。请在 scripts/forbidden.txt 写入真实禁用词条。');
  }
  return { terms, skipPaths, skipPathMeta, errors };
}

function splitOnce(line, ch) {
  const i = line.indexOf(ch);
  if (i < 0) return [line, null];
  return [line.slice(0, i), line.slice(i + 1)];
}

/**
 * 逐行扫描一段文本。
 */
export function scanText(text, terms, { file = '<text>' } = {}) {
  const violations = [];
  const exempted = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const { term, exemptRegex } of terms) {
      if (!line.includes(term)) continue;
      if (exemptRegex && exemptRegex.test(line)) {
        exempted.push({ file, line: idx + 1, term, text: line.trim() });
      } else {
        violations.push({ file, line: idx + 1, term, text: line.trim() });
      }
    }
  });
  return { violations, exempted };
}

/**
 * 某个路径命中了哪个排除项（没命中 ⇒ null）。
 * ⚠️ 返回**命中的那一条**（而不是布尔）—— 因为报告必须说清「为什么被排除」。
 */
function matchExclude(relPath, baseName, excludePaths) {
  for (const pattern of excludePaths) {
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
      if (re.test(baseName) || re.test(relPath)) return pattern;
    } else if (baseName === pattern || relPath.endsWith(sep + pattern)) {
      return pattern;
    }
  }
  return null;
}

function isExcluded(relPath, baseName, excludePaths) {
  return matchExclude(relPath, baseName, excludePaths) !== null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 evidence-chain 报出来的禁用词命中分成「落在已登记的豁免范围内」与「真违规」。
 *
 * 豁免来源**只有两类**，且两类都是本扫描器自己已经登记、并且在报告里打印过的排除项：
 *   ① @skip-path —— 清单里登记的整目录跳过（理由取自清单里该 @skip-path 上方的注释块）
 *   ② 默认排除 —— 清单自身 / 扫描器自身 / 测试夹具 / 依赖与构建目录
 * ⛔ 不许出现「第三类豁免」：那等于把闸自己关掉。
 *
 * ⚠️ 为什么需要这一步：共享 skill 的扫描器**只报命中、不管豁免**，
 *    它的输出「禁用词命中 46 处 —— 已证伪内容可能已回流」配上本扫描器的退出码 0
 *    ⇒ **宣称与行为相左**（正是本仓反复要消灭的那类问题）。
 *    ⇒ 这里把每一处命中**落到具体的豁免项上**（并带理由），
 *    没落到任何已登记豁免项上的 ⇒ **真违规 ⇒ 退出码非 0**（fail-closed）。
 *
 * @param {Array<{file:string,line:number,word:string,text:string}>} hits
 * @param {{skipPathMeta: Array, excludePaths: string[], repoRoot: string}} opts
 */
export function classifyEvidenceHits(hits, { skipPathMeta = [], excludePaths = DEFAULT_EXCLUDES, repoRoot = REPO_ROOT } = {}) {
  const exempted = [];
  const violations = [];
  for (const h of hits || []) {
    const abs = isAbsolute(h.file) ? h.file : resolve(repoRoot, h.file);
    const rel = relative(repoRoot, abs);
    const baseName = abs.split(sep).pop();
    const skip = (skipPathMeta || []).find((m) => m.regex.test(rel));
    if (skip) {
      exempted.push({ ...h, kind: '@skip-path', label: skip.pattern, reason: skip.reason || '（清单里未写理由）' });
      continue;
    }
    const ex = matchExclude(rel, baseName, excludePaths);
    if (ex) {
      exempted.push({ ...h, kind: '默认排除', label: ex, reason: DEFAULT_EXCLUDE_REASONS[ex] || '（未登记理由）' });
      continue;
    }
    violations.push(h);
  }
  return { exempted, violations };
}

/** 把豁免命中按「豁免项」归组 ⇒ 一句话说明「命中 N 处，落在哪几个豁免项上，各是什么理由」 */
export function groupExemptions(exempted) {
  const byKey = new Map();
  for (const e of exempted || []) {
    const key = `${e.kind}｜${e.label}`;
    if (!byKey.has(key)) byKey.set(key, { kind: e.kind, label: e.label, reason: e.reason, n: 0 });
    byKey.get(key).n += 1;
  }
  return [...byKey.values()]
    .map((g) => `${g.kind} ${g.label}（${g.n} 处；理由：${g.reason}）`)
    .join('；');
}

/**
 * 扫描一组目录/文件。
 */
export function scanRoots(roots, { terms, skipPaths = [], excludePaths = DEFAULT_EXCLUDES }) {
  const violations = [];
  const exempted = [];
  const scannedFiles = [];
  const excludedPaths = [];
  const visited = new Set();

  const walk = (target) => {
    const abs = resolve(target);
    if (visited.has(abs)) return;
    visited.add(abs);
    if (!existsSync(abs)) return;

    const info = statSync(abs);
    const rel = relative(REPO_ROOT, abs);

    if (skipPaths.some((re) => re.test(rel))) {
      excludedPaths.push({ path: rel, reason: '@skip-path' });
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        if (isExcluded(rel ? join(rel, entry) : entry, entry, excludePaths)) {
          excludedPaths.push({ path: relative(REPO_ROOT, join(abs, entry)), reason: '默认排除' });
          continue;
        }
        walk(join(abs, entry));
      }
      return;
    }
    if (!TEXT_EXT.has(extname(abs).toLowerCase())) return;
    if (isExcluded(rel, abs.split(sep).pop(), excludePaths)) {
      excludedPaths.push({ path: rel, reason: '默认排除' });
      return;
    }
    const text = readFileSync(abs, 'utf8');
    scannedFiles.push(rel);
    const r = scanText(text, terms, { file: rel });
    violations.push(...r.violations);
    exempted.push(...r.exempted);
  };

  for (const root of roots) walk(root);
  return { violations, exempted, scannedFiles, excludedPaths };
}

/**
 * 命令行入口。
 * P4 已有：node scripts/audit-scan.js [root...]
 * P6 追加：--forbidden <path>  指定别的清单（试跑用，不动默认清单）
 *          --json             机器可读输出
 *          --evidence-chain <path>
 *          可选增强：复用 evidence-chain skill 的 audit-evidence.js。
 *          ⚠️ 平台自身必须能独立跑：找不到该脚本时只打印一行说明并继续，
 *             绝不影响本闸结论（工具失败不应成为跳过检查的理由）。
 */
export function main(argv = []) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..');

  let manifestPath = join(here, 'forbidden.txt');
  let evidenceChainPath = null;
  let asJson = false;
  const roots = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { asJson = true; continue; }
    if (a === '--forbidden') {
      // ⛔ 缺值不许静默回落默认清单：参数写错（漏了路径）时回落 = 用错清单 = 假绿。
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('[audit-scan] --forbidden 后面必须跟清单路径');
        return 2;
      }
      manifestPath = value;
      i += 1;
      continue;
    }
    if (a === '--evidence-chain') { evidenceChainPath = argv[i + 1] || null; i += 1; continue; }
    if (a.startsWith('--')) {
      // ⛔ 未知参数不许当扫描路径吞掉（那等于「扫了 0 个文件还报通过」）。
      console.error(`[audit-scan] 未知参数：${a}`);
      console.error('[audit-scan] 用法：node scripts/audit-scan.js [--json] [--forbidden <path>] [--evidence-chain <path>] [root...]');
      return 2;
    }
    roots.push(a);
  }

  if (!existsSync(manifestPath)) {
    console.error('[audit-scan] 禁用清单缺失：scripts/forbidden.txt —— 闸未生效，发布中止');
    return 2;
  }
  const parsed = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (parsed.errors.length) {
    console.error('[audit-scan] 禁用清单不合规：');
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 2;
  }

  // 默认扫描范围：仓库 docs/ + platform/ + 发布产物 platform/web/dist/（存在才扫）
  const targets = roots.length ? roots : [join(repoRoot, 'docs'), join(repoRoot, 'platform')];
  const distDir = join(repoRoot, 'platform', 'web', 'dist');

  const report = scanRoots(targets, { terms: parsed.terms, skipPaths: parsed.skipPaths });

  // 发布产物单独扫一遍：
  // ⚠️ P4 的 DEFAULT_EXCLUDES 里有 'dist'，主扫描会把它当构建目录跳过 —— 但这里要扫的
  //    恰恰是【我们自己发布的静态站】，所以显式传 excludePaths: []（只扫我们自己产出的文件）。
  // ⛔ skipPaths 固定为空：发布产物这道闸不许被清单里的 @skip-path 关掉
  //    （清单自己就能把闸关掉 —— 与「空清单 ≠ 已保护」同一类病）。
  const release = { dir: relative(repoRoot, distDir), present: false, scannedFiles: 0 };
  if (!roots.length && existsSync(distDir)) {
    release.present = true;
    const distReport = scanRoots([distDir], {
      terms: parsed.terms,
      skipPaths: [],
      excludePaths: [],
    });
    report.violations.push(...distReport.violations);
    report.exempted.push(...distReport.exempted);
    report.scannedFiles.push(...distReport.scannedFiles);
    report.excludedPaths.push(...distReport.excludedPaths);
    release.scannedFiles = distReport.scannedFiles.length;
  }
  const evidence = runEvidenceChain(evidenceChainPath, targets, manifestPath);

  // ── evidence-chain 增强的命中 ⇒ 落到「已登记的豁免项」或「真违规」 ──
  // ⛔ 这一步是「宣称与行为自洽」的关键：共享 skill 只报命中、不管豁免，
  //    它说「命中 N 处 —— 可能已回流」，而本扫描器退出码 0 ⇒ 自相矛盾。
  //    ⇒ 这里把每一处命中**归到具体的豁免项**（带理由）；
  //    归不到任何已登记豁免项的 ⇒ 真违规 ⇒ 退出码非 0（fail-closed）。
  const evidenceVerdict = { exempted: [], violations: [] };
  if (evidence.available && evidence.json) {
    const r = classifyEvidenceHits(evidence.json.forbiddenHits, {
      skipPathMeta: parsed.skipPathMeta,
      excludePaths: DEFAULT_EXCLUDES,
      repoRoot,
    });
    evidenceVerdict.exempted = r.exempted;
    evidenceVerdict.violations = r.violations;
  }

  // ⛔ 静默的空产出比报错更危险：一份文件都没扫到 = 闸没生效 = 报错退出（退出码 2）。
  const emptyScan = report.scannedFiles.length === 0;

  if (asJson) {
    console.log(JSON.stringify({
      manifest: manifestPath,
      terms: parsed.terms.length,
      scannedFiles: report.scannedFiles.length,
      gateEffective: !emptyScan,
      releaseArtifacts: release,
      violations: report.violations,
      exempted: report.exempted,
      excludedPaths: report.excludedPaths,
      evidenceChain: {
        available: evidence.available,
        path: evidence.path,
        reason: evidence.reason || null,
        exemptedHits: evidenceVerdict.exempted,
        violationHits: evidenceVerdict.violations,
      },
    }, null, 2));
  } else {
    console.log(`[audit-scan] 词条 ${parsed.terms.length} 条｜扫描 ${report.scannedFiles.length} 个文件`);
    console.log(release.present
      ? `[audit-scan] 发布产物 ${release.dir}：扫描 ${release.scannedFiles} 个文件（发布产物本身也必须过闸）`
      : `[audit-scan] 发布产物 ${release.dir}：不存在（构建之后才会有产物；发布产物本身也必须过闸）`);
    console.log(`[audit-scan] 排除 ${report.excludedPaths.length} 项（排除不静默）：`);
    for (const e of report.excludedPaths.slice(0, 50)) console.log(`  - ${e.path}（${e.reason}）`);
    if (report.exempted.length) {
      console.log(`[audit-scan] 豁免命中 ${report.exempted.length} 处（更正语境，不计违规）：`);
      for (const e of report.exempted) console.log(`  - ${e.file}:${e.line} 「${e.term}」`);
    }
    if (report.violations.length) {
      console.error(`[audit-scan] ✗ 发现 ${report.violations.length} 处禁用表述：`);
      for (const v of report.violations) console.error(`  - ${v.file}:${v.line} 「${v.term}」 ${v.text}`);
    } else if (emptyScan) {
      console.error('[audit-scan] 扫描范围内没有任何可扫描的文件 —— 闸未生效（静默的空产出比报错更危险）');
    } else {
      console.log('[audit-scan] ✓ 未发现禁用表述');
    }
    if (evidence.available) {
      console.log(`[audit-scan] evidence-chain 增强报告（${evidence.path}）：`);
      console.log(evidence.output.trim());
      // ⛔ **判定必须与输出同源**：报告说「命中 N 处」，就必须说清这 N 处落在哪、
      //    哪些是真违规。含糊的「已证伪内容可能已回流」+ 退出码 0 = 假绿。
      if (evidenceVerdict.violations.length) {
        console.error(`[audit-scan] ✗ evidence-chain 增强发现 ${evidenceVerdict.violations.length} 处**未豁免**的禁用表述（同一份 forbidden.txt）：`);
        for (const v of evidenceVerdict.violations) {
          console.error(`  - ${relative(repoRoot, isAbsolute(v.file) ? v.file : resolve(repoRoot, v.file))}:${v.line} 「${v.word}」 ${v.text}`);
        }
      } else if (evidenceVerdict.exempted.length) {
        console.log(`[audit-scan] evidence-chain 增强：禁用词命中 ${evidenceVerdict.exempted.length} 处 —— 全部落在已登记的豁免范围内（${groupExemptions(evidenceVerdict.exempted)}）⇒ 不计违规`);
      } else {
        console.log('[audit-scan] evidence-chain 增强：禁用词命中 0 处 ⇒ 与本扫描器同一份 forbidden.txt，结论一致');
      }
    } else {
      console.log(`[audit-scan] evidence-chain 增强不可用：${evidence.reason}（不影响本闸结论）`);
    }
  }

  if (report.violations.length) return 1;
  // ⛔ 增强扫描器发现的**未豁免**命中同样必须让闸失败（fail-closed）
  if (evidenceVerdict.violations.length) return 1;
  if (emptyScan) {
    if (asJson) console.error('[audit-scan] 扫描范围内没有任何可扫描的文件 —— 闸未生效（静默的空产出比报错更危险）');
    return 2;
  }
  return 0;
}

/**
 * 可选增强：复用 evidence-chain skill 的 audit-evidence.js。
 * ⛔ 平台自身必须能独立跑：找不到就返回 available=false，不影响闸结论。
 *
 * ⚠️ **必须传 `--forbidden <本仓清单>`**：共享 skill 默认读的是**它自己旁边**那份
 *    forbidden.txt，与本仓的不是同一份 ⇒ 两边跑的其实不是同一个闸
 *    （文件头「同一个 forbidden.txt 在两边跑，结果不能不同」的承诺此前是**假的**）。
 *
 * ⚠️ **跑两遍**（一遍取人看的报告、一遍取机器判定用的结构化命中）：
 *    文本报告里只有 basename、没有路径 ⇒ **没法**判断命中落在「已登记的豁免范围」里
 *    还是落在真违规上 ⇒ 就会出现「输出报『禁用词命中 N 处 —— 可能已回流』但退出码 0」
 *    的自相矛盾。两遍扫的是同一批文件（多花约 0.2s，换来判定与输出同源）。
 */
function runEvidenceChain(scriptPath, targets, manifestPath) {
  const candidates = [
    scriptPath,
    process.env.HOME
      ? join(process.env.HOME, '.minimax', 'skills', 'evidence-chain', 'scripts', 'audit-evidence.js')
      : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      // ① 人看的报告
      const res = spawnSync(process.execPath, [p, ...targets, '--forbidden', manifestPath], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
      // ② 机器判定用的结构化命中
      const resJson = spawnSync(process.execPath, [p, ...targets, '--forbidden', manifestPath, '--json'], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
      let json = null;
      try { json = JSON.parse(resJson.stdout); } catch { json = null; }
      if (!json || !Array.isArray(json.forbiddenHits)) {
        return {
          available: false,
          path: p,
          output: `${res.stdout || ''}${res.stderr || ''}`,
          reason: 'evidence-chain 扫描器的 --json 输出无法解析（版本不兼容？）—— 不参与判定，但报告照常打印',
        };
      }
      return {
        available: true,
        path: p,
        status: res.status,
        output: `${res.stdout || ''}${res.stderr || ''}`,
        json,
      };
    } catch (err) {
      return { available: false, path: p, reason: `执行失败：${err.message}` };
    }
  }
  return { available: false, path: null, reason: '未找到 evidence-chain 扫描器（可选增强）' };
}

// ⚠️ 必须按 realpath 比较：macOS 的 /tmp → /private/tmp、/var → /private/var 都是符号链接，
// 直接比字符串会不相等 ⇒ isMain 判 false ⇒ 脚本【什么都不做、退出码 0】＝静默放行。
// 对一道发布闸来说，「静默通过」是最坏的失败模式（R-AUD-03 的同类病）。
function realPathOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}
const isMain = process.argv[1] && realPathOrSelf(process.argv[1]) === realPathOrSelf(fileURLToPath(import.meta.url));
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}

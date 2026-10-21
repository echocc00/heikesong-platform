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
import { join, relative, dirname, resolve, extname, sep } from 'node:path';
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
 * 解析禁用清单。
 * 语法：
 *   <禁用词>[|<豁免正则1>,<豁免正则2>]   命中即违规；同行命中豁免正则 → 记为"更正语境"，不计违规但会出现在报告里
 *   @skip-path <路径正则>                整条路径跳过（相对仓库根；排除项会打印）
 *   # 开头为注释，空行忽略
 */
export function parseManifest(text) {
  const terms = [];
  const skipPaths = [];
  const errors = [];
  const seen = new Set();

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@skip-path')) {
      const pattern = line.slice('@skip-path'.length).trim();
      if (!pattern) {
        errors.push('@skip-path 后面必须跟路径正则');
        continue;
      }
      try {
        skipPaths.push(new RegExp(pattern));
      } catch (e) {
        errors.push(`@skip-path 正则非法：${pattern}（${e.message}）`);
      }
      continue;
    }
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
  return { terms, skipPaths, errors };
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

function isExcluded(relPath, baseName, excludePaths) {
  for (const pattern of excludePaths) {
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
      if (re.test(baseName) || re.test(relPath)) return true;
    } else if (baseName === pattern || relPath.endsWith(sep + pattern)) {
      return true;
    }
  }
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const evidence = runEvidenceChain(evidenceChainPath, targets);

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
      evidenceChain: evidence,
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
    } else {
      console.log(`[audit-scan] evidence-chain 增强不可用：${evidence.reason}（不影响本闸结论）`);
    }
  }

  if (report.violations.length) return 1;
  if (emptyScan) {
    if (asJson) console.error('[audit-scan] 扫描范围内没有任何可扫描的文件 —— 闸未生效（静默的空产出比报错更危险）');
    return 2;
  }
  return 0;
}

/**
 * 可选增强：复用 evidence-chain skill 的 audit-evidence.js。
 * ⛔ 平台自身必须能独立跑：找不到就返回 available=false，不影响闸结论。
 */
function runEvidenceChain(scriptPath, targets) {
  const candidates = [
    scriptPath,
    process.env.HOME
      ? join(process.env.HOME, '.minimax', 'skills', 'evidence-chain', 'scripts', 'audit-evidence.js')
      : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const res = spawnSync(process.execPath, [p, ...targets], { encoding: 'utf8' });
      return {
        available: true,
        path: p,
        status: res.status,
        output: `${res.stdout || ''}${res.stderr || ''}`,
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

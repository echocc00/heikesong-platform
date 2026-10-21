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
 */
export function main(argv = []) {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, 'forbidden.txt');
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

  const roots = argv.length ? argv : [join(here, '..', '..', 'docs'), join(here, '..')];
  const report = scanRoots(roots, { terms: parsed.terms, skipPaths: parsed.skipPaths });

  console.log(`[audit-scan] 词条 ${parsed.terms.length} 条｜扫描 ${report.scannedFiles.length} 个文件`);
  console.log(`[audit-scan] 排除 ${report.excludedPaths.length} 项（排除不静默）：`);
  for (const e of report.excludedPaths.slice(0, 50)) console.log(`  - ${e.path}（${e.reason}）`);
  if (report.exempted.length) {
    console.log(`[audit-scan] 豁免命中 ${report.exempted.length} 处（更正语境，不计违规）：`);
    for (const e of report.exempted) console.log(`  - ${e.file}:${e.line} 「${e.term}」`);
  }
  if (report.violations.length) {
    console.error(`[audit-scan] ✗ 发现 ${report.violations.length} 处禁用表述：`);
    for (const v of report.violations) console.error(`  - ${v.file}:${v.line} 「${v.term}」 ${v.text}`);
    return 1;
  }
  console.log('[audit-scan] ✓ 未发现禁用表述');
  return 0;
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

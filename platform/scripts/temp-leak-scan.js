// scripts/temp-leak-scan.js — 测试临时目录泄漏闸
//
// 为什么需要这道闸：
//   测试普遍用 `mkdtempSync(join(tmpdir(), 'hks-xxx-'))` 建临时目录。
//   清理写在**用例体末尾** ⇒ 一旦中途断言失败，清理那几行根本执行不到；
//   而且还有**压根没写清理**的用例。
//   macOS 的 $TMPDIR 按用户隔离且系统会清 ⇒ 本机**看不见**这种泄漏；
//   Linux 的 /tmp 是共享的 ⇒ 真机实测（8.133.200.235 / Debian 12）：
//   一次全量跑就在 /tmp 堆出 80+ 个 hks-* 目录，跑得越多堆得越多，
//   终将把磁盘吃满。⇒ 这是「在开发机隐形、在服务器致命」的一类缺陷。
//
// 规则溯源：
//   - 本闸守的是 P6 真机跨平台复现（E21）带出的缺陷：真机一次全量跑泄漏 80+ 目录。
//   - 修法见 test-helpers/tmp.js：把本进程的临时目录重定向到专属根目录，退出时整体回收。
//
// 静态规则（默认）：
//   R1  用到 tmpdir() 的测试文件**必须** import test-helpers/tmp.js 并调用 isolateTempDir()
//       —— 否则它的临时目录没有任何回收机制。
//   R2  isolateTempDir() 的调用行必须**早于**文件里第一处 tmpdir( 的出现行
//       —— os.tmpdir() 每次调用都重读环境变量，隔离必须在第一次求值之前生效。
//
// 动态检查（--run，额外跑一遍全量测试并对临时目录做差分）：
//   跑完测试后临时目录里有**新出现**的残留目录 ⇒ 判违规。
//   ⚠️ 默认**只报告不删除** —— 闸不该替用户删东西（别人的目录也可能在里面）。
//      要清理加 --clean（只删本次跑新出现的那些）。
//
// 用法：
//   node scripts/temp-leak-scan.js [root...]     默认扫 platform/test
//   node scripts/temp-leak-scan.js --json
//   node scripts/temp-leak-scan.js --run          附带动态差分检查
//   node scripts/temp-leak-scan.js --run --clean  动态检查并清掉本次新出现的残留
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');

const HELPER_SPECIFIER = '../test-helpers/tmp.js';

/** 递归收集 .js 文件（不引第三方 glob）。 */
function collectJsFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectJsFiles(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 扫描一个目录里的测试文件，返回违规项。
 *
 * @param {string} rootDir 待扫描目录
 * @returns {{file: string, rule: string, message: string}[]}
 */
export function scanTempLeakUsage(rootDir) {
  const violations = [];
  for (const file of collectJsFiles(rootDir)) {
    if (!file.endsWith('.test.js')) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const rel = relative(PLATFORM_DIR, file);

    // 第一处 tmpdir( 的行号（-1 = 没有）
    let firstUse = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('tmpdir(')) { firstUse = i; break; }
    }
    if (firstUse < 0) continue; // 不用临时目录的文件不归本闸管

    const importsHelper = lines.some((l) => l.includes(HELPER_SPECIFIER));
    const callIdx = lines.findIndex((l) => /^\s*isolateTempDir\(\)\s*;?\s*$/.test(l));

    if (!importsHelper) {
      violations.push({
        file: rel, rule: 'R1',
        message: '用到了 tmpdir()，但没有 import test-helpers/tmp.js ⇒ 临时目录没有任何回收机制',
      });
      continue;
    }
    if (callIdx < 0) {
      violations.push({
        file: rel, rule: 'R1',
        message: 'import 了 test-helpers/tmp.js，但**没有调用** isolateTempDir() ⇒ 隔离没有生效',
      });
      continue;
    }
    if (callIdx > firstUse) {
      violations.push({
        file: rel, rule: 'R2',
        message: `isolateTempDir() 在第 ${callIdx + 1} 行，晚于第一处 tmpdir( 的第 ${firstUse + 1} 行`
          + ' ⇒ os.tmpdir() 已经求值过，隔离太晚了',
      });
    }
  }
  return violations;
}

/** 临时目录快照（只取目录项的名字）。 */
function snapTmp() {
  const set = new Set();
  let entries;
  try { entries = readdirSync(tmpdir()); } catch { return set; }
  for (const e of entries) {
    try { if (statSync(join(tmpdir(), e)).isDirectory()) set.add(e); } catch { /* 并发删除 */ }
  }
  return set;
}

/**
 * 动态差分：跑一遍全量测试，看临时目录里有没有新留下的残留。
 * @returns {{leftover: string[], exitCode: number|null}}
 */
export function runAndDiff(opts = {}) {
  const before = snapTmp();
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test'], {
    cwd: opts.cwd || PLATFORM_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const after = snapTmp();
  const leftover = [...after].filter((e) => !before.has(e)).sort();
  if (opts.clean) {
    for (const e of leftover) {
      try { rmSync(join(tmpdir(), e), { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
  return { leftover, exitCode: r.status };
}

/**
 * 命令行入口。
 * @returns {number} 0 = 通过；1 = 有违规；2 = 用法错误
 */
export function main(argv = []) {
  let asJson = false;
  let doRun = false;
  let doClean = false;
  const roots = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { asJson = true; continue; }
    if (a === '--run') { doRun = true; continue; }
    if (a === '--clean') { doClean = true; continue; }
    if (a.startsWith('--')) {
      console.error('[temp-leak-scan] 未知参数：' + a);
      console.error('[temp-leak-scan] 用法：node scripts/temp-leak-scan.js [--json] [--run] [--clean] [root...]');
      return 2;
    }
    roots.push(a);
  }

  const targets = roots.length ? roots : [join(PLATFORM_DIR, 'test')];
  const violations = [];
  for (const t of targets) {
    if (!existsSync(t)) {
      console.error('[temp-leak-scan] 扫描路径不存在：' + t);
      return 2;
    }
    violations.push(...scanTempLeakUsage(t));
  }

  let dynamic = null;
  if (doRun) {
    dynamic = runAndDiff({ clean: doClean });
  }

  const ok = violations.length === 0 && (!dynamic || dynamic.leftover.length === 0);
  if (asJson) {
    console.log(JSON.stringify({
      ok,
      violations,
      dynamic: dynamic ? { leftover: dynamic.leftover, exitCode: dynamic.exitCode } : null,
    }, null, 2));
    return ok ? 0 : 1;
  }

  console.log(`[temp-leak-scan] 扫描 ${targets.length} 个路径，违规 ${violations.length} 项`);
  for (const v of violations) {
    console.error(`  ❌ [${v.rule}] ${v.file}：${v.message}`);
  }
  if (dynamic) {
    console.log(`[temp-leak-scan] 动态差分：测试退出码 ${dynamic.exitCode}，新留下 ${dynamic.leftover.length} 个临时目录`);
    for (const d of dynamic.leftover) console.error(`  ❌ 残留目录：${join(tmpdir(), d)}`);
    if (dynamic.leftover.length && doClean) console.log('[temp-leak-scan] 已按 --clean 清掉上述残留');
  }
  if (ok) console.log('[temp-leak-scan] 通过');
  else console.error('[temp-leak-scan] 不通过');
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

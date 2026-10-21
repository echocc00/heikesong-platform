// platform/test-helpers/tmp.js — 测试临时目录隔离与退出回收（测试专用共享工具）
//
// ⛔ 它是**测试辅助工具**，不是被测代码：放在 test-helpers/ 下，
//    零依赖守卫（test/zero-deps.test.js 的 SCAN_DIRS 含 'test-helpers'）会一起扫，
//    本文件只用 Node 标准库（node:fs / node:os / node:path），符合「零 npm 依赖」承诺。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
//   测试普遍用 `mkdtempSync(join(tmpdir(), 'hks-xxx-'))` 建临时目录，
//   但清理写在**用例体末尾**：
//       const s = setup();
//       ...断言...
//       s.close();
//       rmSync(s.dataDir, { recursive: true, force: true });
//   一旦中途断言失败抛错，**后面那几行根本执行不到** ——
//   临时目录（连同里面的 SQLite 库）就留在系统临时目录里。
//   而且还有**压根没写清理**的用例（漏写比漏执行更常见）。
//
//   macOS 的 $TMPDIR 由系统定期清理，**看不见**这种泄漏；
//   Linux 的 /tmp 不会自动清 —— 真机实测（8.133.200.235 / Debian 12）：
//   一次全量跑就在 /tmp 堆出 80+ 个 hks-* 目录，跑得越多堆得越多。
//   ⇒ 泄漏在开发机上是隐形的，在服务器上是会**把磁盘吃满**的。
//
// ── 做法 ────────────────────────────────────────────────────────────────
//   把本进程的临时目录重定向到一个**属于本进程专属**的根目录，
//   进程退出时把整个根目录删掉。
//
//   · `os.tmpdir()` 在 POSIX 下**每次调用都重读 process.env.TMPDIR**（不缓存），
//     所以本模块一旦被导入，后面所有 `join(tmpdir(), ...)` 都会落进专属根目录。
//   · Windows 下 os.tmpdir() 认的是 TEMP / TMP，所以三个变量一起设（跨平台一致）。
//   · **调用点一行不改**：132 处 `mkdtempSync(join(tmpdir(), 'x-'))` 原样保留，
//     测试文件只多一行 import + 一行调用 —— 计划块里的测试代码改动最小。
//
// ── 为什么用「重定向环境变量」而不是「统一包装 mkdtempSync」 ──────────────
//   包装要改 132 处调用点（46 个文件），且只能覆盖**显式创建**的目录；
//   重定向覆盖本进程里**一切**经由 tmpdir() 得到的路径
//   （包括 mkdirSync 建的、拼出来的字面量路径），漏网之鱼更少。
//
// ── 边界（说清楚，不夸大）────────────────────────────────────────────────
//   · 只在**进程正常退出**时回收。被 SIGKILL / 超时强杀时不回收
//     （Node 的 'exit' 事件在这些情况下不触发）—— 那种情况由
//     scripts/temp-leak-scan.js 的差分闸去报，不靠这里兜底。
//   · 只隔离**本进程**。子进程会继承 TMPDIR/TEMP/TMP 环境变量，
//     于是子进程写的临时文件也落在这个根目录里 —— 这是想要的
//     （子进程退出前不会被提前删掉）。
//
// ⛔ 纯函数、零依赖、零 IO（除创建/删除临时目录外）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 本进程专属临时根目录；null = 还没隔离。 */
let root = null;

/**
 * 隔离本进程的临时目录。
 *
 * 幂等：重复调用只返回同一个根目录（不会套娃建目录）。
 *
 * @returns {string} 本进程专属的临时根目录
 */
export function isolateTempDir() {
  if (root) return root;
  // ⚠️ 必须在改环境变量**之前**取真实临时目录 —— 取到的就是系统的那个。
  const realTmp = tmpdir();
  root = mkdtempSync(join(realTmp, 'hks-proc-'));
  // POSIX 认 TMPDIR；Windows 认 TEMP / TMP —— 三个一起设，跨平台行为一致。
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  process.on('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 回收失败不能影响测试结果（退出阶段抛错会盖掉真实失败原因）。
    }
  });
  return root;
}

/**
 * 本进程专属临时根目录（未隔离时返回 null）。
 *
 * @returns {string|null}
 */
export function tempRoot() {
  return root;
}

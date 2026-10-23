// platform/test/sandbox-rm-stub.test.js — 测试沙箱的 `rm` 桩机器闸
//
// ⚠️ **为什么要有这个闸**（2026-10-23 实测抓到的真缺陷）：
//   agent 的 bash 里 `rm` 被 shim 成「可恢复删除」⇒ 转发 `mavis-trash --rm-compatible`
//   ⇒ 走访达（osascript + Finder）⇒ **目标落在系统临时区时，访达会弹管理员授权框**；
//   osascript 被模态框阻塞住不返回 ⇒ 命令挂死、整轮测试被拖成分钟级；
//   而每轮测试都**新建**一个同名临时目录 ⇒ 弹窗一轮一个地反复出现，
//   手工删文件也删不掉（下一轮又造一个新的同名文件）。
//
//   ⇒ 三个 `source` 真脚本的部署测试（deploy-demo-site / deploy-tls-port / deploy-plain-http）
//      的**回滚路径**里那几条 `rm -f` 每次都会撞上它
//      （`deploy-demo-site.sh` 的 `rm -f "$NGINX_LINK"`、`install.sh` 的 `rm -f "$NGINX_SITE"` 等）。
//   ⇒ `deploy-assets.test.js` **早就踩过并写了注释与桩**（它 source 的是 install.sh），
//      但另外三个**同型**测试没跟着补 ⇒ **这是个只补了一半的坑**。
//
//   本闸把「凡是建 PATH 影子沙箱的测试 ⇒ 必须给 `rm` 打桩」固化成机器闸，
//   免得第 5 个同类测试再踩一次。
//
// 运行：node --test（cwd = platform/）

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readdirSync, readFileSync, existsSync, mkdtempSync,
  writeFileSync, chmodSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 必须**在第一次求值系统临时目录之前**隔离本进程的临时目录
//    （scripts/temp-leak-scan.js 的 R1/R2 闸按**原始行**扫，注释里出现同样的字样也算行）。
//    本用例要在临时目录里造一个 PATH 影子沙箱；不隔离的话临时目录**没有任何回收机制**
//    （开发机上被系统悄悄清掉、服务器上把磁盘堆满）。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 扫出所有「会跑 shell」的测试文件。
 *
 * 判据两件套（**或**关系，命中任一即算）：
 *   ① 在 `binDir` 里造桩（`join(binDir, '…')`）—— 说明它会遮蔽 PATH；
 *   ② 直接 spawn 一个 shell 解释器（`bash` / `sh`）—— 它跑起来的脚本里的
 *      `rm` 会落到**宿主机**的 PATH 上（也就是那个 shim）。
 * ⛔ 只判 ① 不够：将来若有测试不建 binDir、却照样 `spawnSync('bash', …)`，
 *    它的 `rm` 依然会走 shim ⇒ 弹窗照旧。
 */
function shellRunningTestFiles() {
  return readdirSync(here)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => ({ name: f, src: readFileSync(join(here, f), 'utf8') }))
    .filter(({ src }) => (
      /join\(\s*binDir\s*,/.test(src)
      || /export PATH="\$\{binDir\}:\$PATH"/.test(src)
      || /(?:spawnSync|execFileSync|execSync|spawn)\(\s*['"](?:ba)?sh['"]/.test(src)
    ));
}

test('闸：凡是会跑 shell 的测试，都必须给 `rm` 打桩（转发给真正的 /bin/rm）', () => {
  const files = shellRunningTestFiles();
  // ⚠️ 下限断言是**防呆**：闸最怕的是「扫不到任何东西却一直绿」
  //    （本仓在 E153 吃过同款亏：审计漏掉阶段 ⇒ 漂移永远查不出来）。
  //    若沙箱被重构没了，请**同步更新本闸的下限**。
  assert.ok(
    files.length >= 5,
    `只扫到 ${files.length} 个会跑 shell 的测试（预期 ≥5）⇒ 扫描规则可能失效了；`
    + '若这些测试确已重构，请同步更新本闸的下限。'
  );

  const bad = [];
  for (const { name, src } of files) {
    // 桩的判据：在 binDir 里造一个名为 `rm` 的可执行文件
    if (!/join\(\s*binDir\s*,\s*'rm'\s*\)/.test(src)) {
      bad.push(`${name}（binDir 里没有 rm 桩）`);
      continue;
    }
    // 桩必须转发给**真正的** rm（不是别的什么，也不是空转）
    if (!/\/bin\/rm|\/usr\/bin\/rm/.test(src)) {
      bad.push(`${name}（桩没有指向真正的 rm）`);
      continue;
    }
    // 桩必须可执行（chmod 0o755）
    if (!/chmodSync\(\s*rmStub\s*,\s*0o755\s*\)/.test(src)) {
      bad.push(`${name}（rm 桩没有 chmod 0o755 ⇒ 不可执行）`);
    }
  }
  assert.deepEqual(bad, [], `这些测试会跑 shell 却没把 rm 桩补齐：\n${bad.join('\n')}`);
});

test('闸：桩必须真的挡住 shim —— 沙箱里的 `command -v rm` 要落在 binDir 里', () => {
  // 行为断言（不是只扫源码）：造一个**同款**沙箱，跑 `command -v rm`。
  // 若没有桩，这条命令会解析到宿主机的 shim（/Users/mac/.minimax/shims/rm 之类）
  // ⇒ 删除会走「可恢复删除」⇒ 访达弹窗 + 可能挂死。
  const tmp = mkdtempSync(join(tmpdir(), 'hks-rmstub-'));
  try {
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });

    const realRm = ['/bin/rm', '/usr/bin/rm'].find((p) => existsSync(p)) || 'rm';
    const rmStub = join(binDir, 'rm');
    writeFileSync(rmStub, `#!/bin/sh\nexec ${realRm} "$@"\n`);
    chmodSync(rmStub, 0o755);

    const target = join(tmp, 'victim.conf');
    writeFileSync(target, 'x');

    const script = [
      'set -uo pipefail',
      `export PATH="${binDir}:$PATH"`,
      'resolved="$(command -v rm)"',
      'rm -f "$1"',
      'printf "%s" "$resolved"',
    ].join('\n');

    const r = spawnSync('bash', ['-c', script, 'bash', target], { encoding: 'utf8' });
    assert.equal(r.status, 0, `沙箱跑挂了：${r.stderr}`);

    // ① 解析到的是沙箱里的桩，不是宿主机的 shim
    assert.equal(
      r.stdout.trim(),
      rmStub,
      `沙箱里的 rm 解析到了 ${r.stdout.trim()}（应是沙箱桩 ${rmStub}）`
    );
    // ② 删除真的发生了
    assert.equal(existsSync(target), false, 'rm -f 之后目标文件应当不存在');
  } finally {
    // ⚠️ 清理用 **node 自己的** rmSync，不走 shell ⇒ 不会再次踩到 shim。
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('闸：本仓的部署脚本回滚路径里确实有 `rm`（说明这个桩是必需的，不是多余的）', () => {
  // 反向自检：如果哪天部署脚本不再用 `rm` 删文件，这个闸的前提就没了，
  //    应该被改掉，而不是留着当摆设。
  const deployDir = join(here, '..', 'deploy');
  const scripts = readdirSync(deployDir).filter((f) => f.endsWith('.sh'));
  const withRm = scripts.filter((f) => /rm -f|rm -rf/.test(readFileSync(join(deployDir, f), 'utf8')));
  assert.ok(
    withRm.length > 0,
    'deploy/ 下的脚本里已经没有任何 rm 了 ⇒ 本闸的前提消失，请复核并改掉本闸'
  );
});

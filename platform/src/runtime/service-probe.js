// src/runtime/service-probe.js — 同步探测「服务还在不在应答」
//
// 为什么需要它（E169 / F5b）：
//   「服务确实停了（正常退出时 server.js 会删掉 pid 文件）」与
//   「服务还在跑、只是 pid 文件没了（被误删 / 被第二个实例覆盖）」——
//   **只看 pid 文件时这两种情况长得一模一样**，
//   而恢复的后果天差地别：
//     · 前者 ⇒ 恢复正是该做的事；
//     · 后者 ⇒ 恢复会把正在被写入的库文件换掉 ⇒ 丢数据 / 库损坏。
//   ⇒ 唯一的分辨证据是「服务还在不在应答」—— 本模块提供它。
//
// ⚠️ 为什么是**同步**的：`scripts/restore.js` 与它的调用方（含既有回归用例）
//    全部是同步的 ⇒ 探测也必须同步。Node 没有同步 HTTP 客户端，
//    ⇒ 用「起一个子进程跑一次 fetch」来实现（零第三方依赖、跨平台、~40ms）。
//
// ⚠️ 为什么探测的是 /api/health 而不是「端口能不能连上」：
//    连得上只能证明「那儿有个东西」，不能证明「那是本平台的服务」；
//    /api/health 会返回 `{ ok: true }` ⇒ 能确认是我们自己的服务。
//    （顺带避免「端口被别的进程占了」造成误判。）
import { spawnSync } from 'node:child_process';
import { readPortFile } from './pidfile.js';

const HOST = '127.0.0.1';

/**
 * 探测数据目录上的服务是否还在应答。
 *
 * @param {string} dataDir 数据目录（端口文件所在处）
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {{ alive: boolean, port: number|null, reason: string }}
 */
export function probeService(dataDir, { timeoutMs = 5000 } = {}) {
  const port = readPortFile(dataDir);
  if (!port) {
    // 没有端口文件 ⇒ 本数据目录上**从未**有服务登记过监听端口 ⇒ 没服务在跑。
    return { alive: false, port: null, reason: '没有端口文件（本数据目录上没有服务登记过监听端口）' };
  }
  const url = `http://${HOST}:${port}/api/health`;
  // 子进程里的脚本：拿到 200 且 body.ok === true 才算「活着」。
  const code = `
    const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(${Math.max(500, timeoutMs - 500)}) });
    const b = await r.json().catch(() => null);
    process.exit(r.ok && b && b.ok === true ? 0 : 1);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.error) {
    // 探测本身失败（起不来子进程 / 超时）⇒ **不能据此断言服务已停**
    // ⇒ 按「活着」处理（保守 fail closed），但要说明是探测失败。
    return { alive: true, port, reason: `探测 ${url} 失败（${res.error.code ?? res.error.message}）—— 拿不到「服务已停」的证据` };
  }
  if (res.status === 0) {
    return { alive: true, port, reason: `探测 ${url} 有应答且 /api/health 返回 ok ⇒ 服务仍在运行` };
  }
  return { alive: false, port, reason: `探测 ${url} 无应答（退出码 ${res.status}）⇒ 服务未在运行` };
}

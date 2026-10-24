// src/runtime/service-state.js — 「服务还在不在跑」的判定（写库闸的底座）
//
// 为什么把它从 scripts/restore.js 里搬出来（2026-10-25 评审 P1-4a）：
//   恢复脚本需要「服务是否已停」的判定，**写库脚本**（seed / migrate）也需要同一份判定
//   —— 但后者在 `src/` 一侧，而 `src/` 不该反向依赖 `scripts/`（依赖方向反了）。
//   ⇒ 把判定下沉到 `src/runtime/`，`scripts/restore.js` 改为**转出**（对外契约不变）。
//
// ⚠️ 这份判定的铁律是 **fail-closed**（拿不到「服务已停」的证据 ⇒ 一律按「还在跑」处理）：
//   理由：判错的代价不对称 ——
//     · 误判「还在跑」⇒ 运维多停一次服务，代价是几分钟；
//     · 误判「已停」⇒ 在服务正在写库时改 schema / 恢复备份 ⇒ **丢数据 / 库损坏**。
//
// 依据：设计文档 §14.2 单写者约束 —— 同一个 SQLite 文件只允许一个写进程
//   （并发写会撞 SQLITE_BUSY / 517，见 README 的头号架构承诺）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readPidFile, pidFilePath, isProcessAlive } from './pidfile.js';
import { probeService } from './service-probe.js';

/**
 * 服务是否还在跑。优先看 pid 文件（跨平台），Linux 上再兜底 systemd。
 *
 * @param {{ dataDir?: string, serviceName?: string }} [opts]
 * @returns {{ running: boolean, reason: string, pid?: number, stale?: boolean }}
 */
export function checkServiceState({ dataDir = './data', serviceName = 'heikesong' } = {}) {
  const pid = readPidFile(dataDir);
  if (pid && isProcessAlive(pid)) {
    return { running: true, reason: `pid 文件显示进程 ${pid} 仍在运行`, pid };
  }
  // ⚠️ pid 文件在，但内容**不是合法 pid**（写坏了）→ 证明不了服务已停 → 保守判为「还在跑」。
  //    依据：设计文档 §14.2【决策】恢复前必须先停服务 —— 这条是**安全闸**，
  //    拿不到证据时必须拒绝，而不是当成「服务没在跑」。
  //    运维确认服务确实停了，删掉这个 pid 文件即可继续。
  // ⚠️ 判据是「**读不出合法 pid**」（`!pid`），**不是**「文件存在」——
  //    文件存在但内容合法、只是进程已退出 ⇒ 那是**陈旧残留**，走下面的探测分支，
  //    不能被这条「内容无法解析」误伤（这条曾经把陈旧残留判成「还在跑」，
  //    被 test/restore.test.js 的既有用例当场抓住）。
  if (!pid && existsSync(pidFilePath(dataDir))) {
    return { running: true, reason: 'pid 文件存在但内容无法解析，无法确认服务已停止' };
  }
  // ⚠️⚠️ pid 文件**不存在**，或它指向的进程**已退出** ⇒「进程已停」这个证据**不成立**
  //   ⇒ 必须**主动探测服务本身**（E169 / F5b）。
  //   为什么不能只看 pid 文件：「服务确实停了」（正常退出时 server.js 会删掉 pid 文件）
  //   与「服务还在跑、只是 pid 文件没了」（被误删 / 被第二个实例覆盖）**看起来一模一样**，
  //   而恢复的后果天差地别：
  //     · 前者 ⇒ 恢复正是该做的事；
  //     · 后者 ⇒ 恢复会把正在被写入的库文件换掉 ⇒ 丢数据 / 库损坏。
  //   ⇒ 唯一能分辨的证据是「服务还在不在应答」（见 src/runtime/service-probe.js）。
  const probe = probeService(dataDir);
  if (probe.alive) {
    return {
      running: true,
      reason: pid
        ? `pid 文件显示进程 ${pid} 已退出，但 ${probe.reason} ⇒ 服务仍在运行`
        : `pid 文件缺失，但 ${probe.reason} ⇒ 服务仍在运行（拿不到「服务已停」的证据，保守拒绝恢复）`,
      ...(pid ? { pid, stale: true } : {}),
    };
  }
  if (pid) {
    return { running: false, reason: `pid 文件存在但进程 ${pid} 已退出（可能是异常终止的残留）`, pid, stale: true };
  }
  // ⚠️ 用「**能力探测**」而不是「平台判断」：/run/systemd/system 这个目录
  //    **只在 systemd 体系上存在**（macOS / Windows 上不存在；Linux 容器里也可能没有）
  //    ⇒ 它的存在性本身就是「这台机器有 systemd」的判据。
  //    ⛔ 不能写 `process.platform === 'linux'`：那会把平台分支带进 src/
  //    （违反 R-OPS-02：运行时代码不得有平台分支 —— 见 test/portability.test.js）。
  if (existsSync('/run/systemd/system')) {
    try {
      const res = spawnSync('systemctl', ['is-active', serviceName], { encoding: 'utf8' });
      if (res.status === 0 && String(res.stdout).trim() === 'active') {
        return { running: true, reason: `systemd 服务 ${serviceName} 处于 active` };
      }
    } catch {
      // systemctl 不可用 → 忽略这一路探测
    }
  }
  return { running: false, reason: '未发现运行中的服务进程' };
}

/**
 * 写库前的**单写者闸**：服务还在跑 ⇒ 直接拒绝执行。
 *
 * 依据：设计文档 §14.2 单写者约束 + README「SQLite 只允许单写进程」。
 *   适用对象：**批量写 / 改 schema** 的运维脚本（seed / migrate）。
 *   ⚠️ **不适用**于 backup（读，走 SQLite 官方 backup API，与服务并发安全）
 *      与 prune（只删已过期行，短事务，见 scripts/prune.js 的论证）。
 *
 * @param {{ dataDir?: string, serviceName?: string, action?: string }} [opts]
 * @returns {object} checkServiceState 的结果（服务已停时）
 * @throws {Error} 带 `code = 'SERVICE_STILL_RUNNING'` —— 调用方须转成人话错误并退出码 1
 */
export function assertServiceStopped({
  dataDir = './data',
  serviceName = 'heikesong',
  action = '写库操作',
} = {}) {
  const state = checkServiceState({ dataDir, serviceName });
  if (state.running) {
    const err = new Error(
      `拒绝执行${action}：${state.reason}。`
      + '单写者约束：同一个 SQLite 文件只允许一个写进程（并发写会撞 SQLITE_BUSY / 517）。'
      + '请先停掉服务再执行本操作。',
    );
    err.code = 'SERVICE_STILL_RUNNING';
    throw err;
  }
  return state;
}

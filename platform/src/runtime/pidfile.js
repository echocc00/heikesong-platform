// src/runtime/pidfile.js — 进程 pid 文件 + 运行时端口文件
// 用途：让「恢复前必须先停服务」这条约束【可被机器检查】，而不是靠人记得停。
// 依据：设计文档 §14.2 单写者约束 —— 多个进程同时写同一个 SQLite 文件会导致 SQLITE_BUSY / 数据损坏。
// 跨平台：process.kill(pid, 0) 在 macOS / Linux / Windows 上都可用。
//
// ⚠️ 为什么还要一个**端口文件**（app.port）：
//    pid 文件回答「进程还活着吗」，端口文件回答「服务在哪儿听着」。
//    两者缺一不可 —— 只看 pid 文件时，「服务还活着但 pid 文件被删了」与
//    「服务确实停了（正常退出时 server.js 会删掉 pid 文件）」**看起来一模一样**，
//    而这两种情况下恢复的后果天差地别：
//      · 前者 ⇒ 恢复会替换掉正在被写入的库文件 ⇒ 丢数据 / 库损坏；
//      · 后者 ⇒ 恢复正是该做的事。
//    ⇒ 恢复闸在 pid 文件缺失或陈旧时，会用端口文件去**主动探测**服务是否还在应答
//      （见 src/runtime/service-probe.js）—— 这是唯一能分辨这两种情况的证据。
//
// ⚠️ **pid 文件同时是「单写者闸」的独占锁**（2026-10-25 评审 P1-4b）：
//    修复前 server.js 的时序是「① 检查 pid 文件有没有别人 → ……（开库、跑迁移、
//    建应用、listen 几百毫秒）…… → ② listen 成功后写自己的 pid」⇒
//    两个实例**同时**启动时，两个都能通过 ① ⇒ 一起开库、一起写 ⇒ SQLITE_BUSY。
//    ⇒ 现在改成**独占创建**（claimPidFile）：`openSync(path, 'wx')` 是原子的
//      「不存在才创建」⇒ 天然互斥 ⇒ 只有一个实例能拿到闸。
import {
  writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync,
  openSync, writeSync, closeSync, fsyncSync,
} from 'node:fs';
import { join } from 'node:path';

export function pidFilePath(dataDir) {
  return join(dataDir, 'app.pid');
}

/** 端口文件：记录本进程**实际**监听的端口（PORT=0 时是内核分配的端口，不是 0）。 */
export function portFilePath(dataDir) {
  return join(dataDir, 'app.port');
}

/**
 * **独占**地占住 pid 文件（单写者闸的原子原语）。
 *
 * ⚠️ 为什么必须是 `openSync(path, 'wx')`（O_CREAT | O_EXCL）：
 *    「先看文件在不在、再写」在并发下是**有洞的**（TOCTOU）——
 *    两个实例可以同时看到「文件不存在」，然后都写进去。
 *    O_EXCL 让「创建」本身成为原子操作：内核保证**只有一个**调用者成功。
 *
 * ⚠️ 拿到闸之后**立刻**把自己的 pid 写进去：别的实例读到的是「一个活着的 pid」
 *    ⇒ 它们会直接拒绝启动，而不是「文件存在但读不出 pid」那种说不清的状态。
 *
 * ⚠️ **fail-closed**：文件存在但内容读不出合法 pid ⇒ **无法证明**上一个实例已死
 *    ⇒ 拒绝启动（而不是当成陈旧残留抢过来）。
 *    运维确认服务确实停了，删掉这个 pid 文件即可继续。
 *    （与 src/runtime/service-state.js 的同一口径：拿不到证据就拒绝。）
 *
 * @param {string} dataDir
 * @param {number} [pid]
 * @returns {{ ok: true, pid: number } | { ok: false, pid: number|null, reason: string }}
 */
export function claimPidFile(dataDir, pid = process.pid) {
  mkdirSync(dataDir, { recursive: true });
  const p = pidFilePath(dataDir);
  // 只重试一次：第一次撞到 EEXIST 时若判定为「陈旧残留」⇒ 清掉后再试一次。
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(p, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readPidFile(dataDir);
      if (existing && isProcessAlive(existing)) {
        return { ok: false, pid: existing, reason: `pid 文件显示进程 ${existing} 仍在运行` };
      }
      if (existing === null) {
        // 文件存在但内容不是合法 pid ⇒ 拿不到「拥有者已死」的证据 ⇒ 拒绝（fail-closed）
        return { ok: false, pid: null, reason: 'pid 文件存在但内容无法解析，无法确认上一个实例已退出' };
      }
      // 陈旧残留（进程已退出）⇒ 清掉后重试一次
      try { unlinkSync(p); } catch { /* 已被别人清掉 ⇒ 重试时自然成功 */ }
      continue;
    }
    try {
      writeSync(fd, String(pid));
      // fsync：让「pid 文件一定有完整内容」这件事在崩溃后也成立
      //（否则可能留下一个**空文件** ⇒ 下次启动只能 fail-closed 地让人手工清理）。
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ok: true, pid };
  }
  return { ok: false, pid: null, reason: '无法独占 pid 文件（可能刚被并发启动的实例抢走）' };
}

/**
 * 释放 pid 文件 —— **只释放自己的**。
 *
 * ⚠️ 为什么不能无条件删：万一这个文件已经是别人的了（陈旧残留被接管等），
 *    删掉它就等于**把别人的单写者闸拆了** ⇒ 下一个实例可能同时开库。
 *
 * @returns {boolean} 是否真的删掉了
 */
export function releasePidFile(dataDir, pid = process.pid) {
  const p = pidFilePath(dataDir);
  if (!existsSync(p)) return false;
  if (readPidFile(dataDir) !== pid) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function writePortFile(dataDir, port) {
  mkdirSync(dataDir, { recursive: true });
  const p = portFilePath(dataDir);
  writeFileSync(p, String(port), 'utf8');
  return p;
}

export function removePidFile(dataDir) {
  const p = pidFilePath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

export function removePortFile(dataDir) {
  const p = portFilePath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

export function readPidFile(dataDir) {
  const p = pidFilePath(dataDir);
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function readPortFile(dataDir) {
  const p = portFilePath(dataDir);
  if (!existsSync(p)) return null;
  const port = Number(readFileSync(p, 'utf8').trim());
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * 进程是否还活着。
 * ESRCH = 不在；EPERM = 在但没权限（仍算活着）。
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

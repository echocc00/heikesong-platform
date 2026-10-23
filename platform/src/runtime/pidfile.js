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
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function pidFilePath(dataDir) {
  return join(dataDir, 'app.pid');
}

/** 端口文件：记录本进程**实际**监听的端口（PORT=0 时是内核分配的端口，不是 0）。 */
export function portFilePath(dataDir) {
  return join(dataDir, 'app.port');
}

export function writePidFile(dataDir, pid = process.pid) {
  mkdirSync(dataDir, { recursive: true });
  const p = pidFilePath(dataDir);
  writeFileSync(p, String(pid), 'utf8');
  return p;
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

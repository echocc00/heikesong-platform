// scripts/restore.js — 从备份恢复
//
// ⛔ 恢复前必须先停服务：SQLite 拒绝在有其他连接写同一文件时安全替换文件；
//    强行替换会丢数据或损坏库（且服务可能继续往被换掉的旧 inode 写）。
//    本脚本用【pid 文件 + systemd 探测】把这条约束变成机器检查。
// ⚠️ 恢复后必须删掉旧的 -wal / -shm：它们属于旧库，留着会污染新库。
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync, existsSync, renameSync, unlinkSync, readdirSync, mkdirSync, realpathSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPidFile, pidFilePath, isProcessAlive } from '../src/runtime/pidfile.js';
import { currentVersion } from '../src/db/migrate.js';

/** 列出备份文件（新 → 旧）：文件名是 UTC 时间戳，字典序倒排即时间倒序。 */
function listBackupFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .map((f) => join(dir, f));
}

/** 服务是否还在跑。优先看 pid 文件（跨平台），Linux 上再兜底 systemd。 */
export function checkServiceState({ dataDir = './data', serviceName = 'heikesong' } = {}) {
  const pid = readPidFile(dataDir);
  if (pid && isProcessAlive(pid)) {
    return { running: true, reason: `pid 文件显示进程 ${pid} 仍在运行`, pid };
  }
  if (pid) {
    return { running: false, reason: `pid 文件存在但进程 ${pid} 已退出（可能是异常终止的残留）`, pid, stale: true };
  }
  // ⚠️ pid 文件在，但内容不是合法 pid（写坏了）→ 证明不了服务已停 → 保守判为「还在跑」。
  //    依据：设计文档 §14.2【决策】恢复前必须先停服务 —— 这条是**安全闸**，
  //    拿不到证据时必须拒绝，而不是当成「服务没在跑」。
  //    运维确认服务确实停了，删掉这个 pid 文件即可继续。
  if (existsSync(pidFilePath(dataDir))) {
    return { running: true, reason: 'pid 文件存在但内容无法解析，无法确认服务已停止' };
  }
  if (process.platform === 'linux' && existsSync('/run/systemd/system')) {
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
 * 校验备份文件：能不能打开 + 完整性检查。
 *
 * ⚠️ 只读打开一个 WAL 标志的库时，SQLite 会在文件旁建出 `-wal` 与 `-shm`
 *   （sqlite.org/wal.html：只读 WAL 库靠 wal-index 读，索引文件建在库文件旁）。
 *   实测：readOnly 打开备份产物 → 留下 `xxx.db-wal`(0B) 与 `xxx.db-shm`(32KB)，
 *   且关库后**不删**。而保留策略只认 `*.db` → 这些残留永不被清理 → 备份目录无限膨胀。
 *   ⇒ 记下「打开前有没有」，关库后把【本次自己造出来的】删掉；
 *     打开前就存在的 -wal（可能带真实数据）一律保留不动。
 */
export function verifyBackupFile(path) {
  if (!existsSync(path)) return { ok: false, integrity: 'missing', schemaVersion: null, error: `备份文件不存在：${path}` };
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  const walBefore = existsSync(walPath);
  const shmBefore = existsSync(shmPath);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    let schemaVersion = null;
    try {
      schemaVersion = currentVersion(db);
    } catch {
      schemaVersion = null; // 备份里没有迁移表（还没 migrate 过）——不算损坏
    }
    db.close();
    db = null;
    if (integrity !== 'ok') {
      return { ok: false, integrity: String(integrity), schemaVersion, error: `备份完整性检查未通过：${integrity}` };
    }
    return { ok: true, integrity: 'ok', schemaVersion };
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    return { ok: false, integrity: 'unopenable', schemaVersion: null, error: `备份文件无法打开：${err.message}` };
  } finally {
    // 只删「本次打开造出来的」sidecar，绝不碰打开前就存在的 -wal（可能带真实数据）
    if (!walBefore) { try { if (existsSync(walPath)) unlinkSync(walPath); } catch { /* ignore */ } }
    if (!shmBefore) { try { if (existsSync(shmPath)) unlinkSync(shmPath); } catch { /* ignore */ } }
  }
}

/**
 * 恢复。返回 { ok, steps, error? }，不抛异常（便于测试与 CLI 共用）。
 */
export function restoreDatabase({
  dataDir = './data',
  backupFile = null,
  backupDir = null,
  filename = 'app.db',
  now = new Date(),
  force = false,
} = {}) {
  const steps = [];

  // 1. 选定备份文件
  let backupPath = backupFile;
  if (!backupPath) {
    const dir = backupDir || join(dataDir, 'backups');
    const all = listBackupFiles(dir);
    if (!all.length) return { ok: false, steps, error: `没有可用的备份：${dir}` };
    backupPath = all[0];
  }
  steps.push(`使用备份：${basename(backupPath)}`);

  // 2. 停服务检查
  const state = checkServiceState({ dataDir });
  if (state.running && !force) {
    return { ok: false, steps, error: `服务仍在运行，拒绝恢复（${state.reason}）。请先停服务再恢复。` };
  }
  steps.push(`服务状态：${state.reason}`);

  // 3. 备份完整性
  const check = verifyBackupFile(backupPath);
  if (!check.ok) return { ok: false, steps, error: `备份不可用（完整性检查未通过）：${check.error}` };
  steps.push(`备份完整性：ok（schema 版本 ${check.schemaVersion ?? '未知'}）`);

  // 4. 落到临时文件并再验一次
  const dbPath = join(dataDir, filename);
  const tmpPath = `${dbPath}.restore.tmp`;
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(backupPath, tmpPath);
  const tmpCheck = verifyBackupFile(tmpPath);
  if (!tmpCheck.ok) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, steps, error: `落盘后的临时文件校验失败：${tmpCheck.error}` };
  }
  steps.push('备份已落到临时文件并复验通过');

  // 5. 旧库留存 + 换库
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  if (existsSync(dbPath)) {
    const before = `${dbPath}.before-restore-${stamp}`;
    renameSync(dbPath, before);
    steps.push(`旧库已留存为 ${basename(before)}`);
  }
  // ⚠️ 旧 -wal / -shm 属于旧库，必须删掉，否则新库打开时会读到不相干的 WAL
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      unlinkSync(p);
      steps.push(`已删除旧 ${suffix} 文件（属于旧库）`);
    }
  }
  renameSync(tmpPath, dbPath);
  steps.push(`新库已就位：${dbPath}`);

  return { ok: true, steps, backup: basename(backupPath) };
}

const here = dirname(fileURLToPath(import.meta.url));

// ⚠️ 符号链接入口：与 src/server.js 同一处判定（两边都 realpath 再比）——
//    见 src/server.js 的注释：Node 会把主入口 realpath 化，
//    而 process.argv[1] 保留链接路径 → 字符串全等为假 → 脚本静默不执行。
// ⚠️ realpathSync 吃的是**路径**，不是 file:// URL —— 必须先 fileURLToPath
//    （实测：直接 realpathSync(import.meta.url) 抛 ENOENT ⇒ isMain 恒假 ⇒
//      命令行跑起来什么都不干、退出码 0）。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const backupFile = args.find((a) => !a.startsWith('--')) || null;
  const result = restoreDatabase({ dataDir, backupFile, force: args.includes('--force') });
  for (const s of result.steps) console.log(`[restore] ${s}`);
  if (!result.ok) {
    console.error(`[restore] 失败：${result.error}`);
    process.exit(1);
  }
  console.log('[restore] 成功。请重新启动服务： systemctl restart heikesong');
}

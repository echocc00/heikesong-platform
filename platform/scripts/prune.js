// scripts/prune.js — 清理过期数据（会话 + 限频计数）
//
// 依据：设计文档 §14.2「运维生命周期」+ 2026-10-25 评审轮 P2-7a
//   · `purgeExpiredSessions`（src/db/repo/sessions.js）早就在仓储层实现了，
//     但**零调用方** ⇒ 过期会话永远堆在表里（服务端的 resolveSession 只在
//     「有人正好拿着那个过期 token 来访问」时才顺手删一行）。
//   · 限频计数同理：每次登录失败 / 评分提交 / 申诉提交都写一行，
//     窗口过了也不删 ⇒ 这张表只增不减。
//
// ⚠️ **为什么 prune 不走单写者闸**（与 seed / migrate 的区别，刻意为之）：
//   · 单写者闸（src/runtime/service-state.js 的 assertServiceStopped）拦的是
//     **批量写 / 改 schema** 的脚本 —— 那类操作与服务并发会写坏数据
//     （seed 会让规则与账号对不上；migrate 会让运行中的服务撞「no such column」）。
//   · 本脚本只做两件事：**删掉已经过期、没人再引用的行**：
//       ① sessions 里 expires_at 已过的会话 —— 服务端早已不再认它们
//          （resolveSession 命中过期行本来就会删行）；
//       ② rate_limit_events 里窗口早已结束的事件 —— 判据见仓储层注释
//          （24 小时 ≫ 本仓最宽的窗口 perHour = 1 小时 ⇒ 删掉的行对任何判定都不可见）。
//   · 两者的写入都是**短事务**，WAL + busy_timeout(5000) 会与服务端的写**串行化**
//     （README 的原话就是「单写者约束：SQLite 只允许单写进程，**写入串行化**」）
//     ⇒ 不可能与服务并发写坏数据。
//   · ⚠️ 反过来看：若把 prune 也用闸拦住，systemd timer 就必须**先停服务**才能清理
//     ⇒ 为了删几行过期数据而中断比赛服务 ⇒ 运维上更糟。
//   ⇒ 结论：**prune 与服务并发安全，故不受单写者闸约束**（这是刻意的区分，不是漏了）。
//
// ⚠️ 为什么删旧行**不会**削弱限频：见
//    src/db/repo/rate-limit.js 的 deleteRateLimitEventsOlderThan 注释。
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { purgeExpiredSessions } from '../src/db/repo/sessions.js';
import { deleteRateLimitEventsOlderThan } from '../src/db/repo/rate-limit.js';

/** 限频计数的保留时长（秒）。默认 24 小时 ≫ 本仓最宽的窗口（perHour = 1 小时）。 */
export const RATE_LIMIT_RETENTION_SECONDS = 86400;

/**
 * 清理过期数据。
 *
 * @param {object} db
 * @param {{ now?: Date, rateLimitRetentionSeconds?: number }} [opts]
 * @returns {{ sessions: number, rateLimit: number }} 各删了多少行
 */
export function pruneExpiredData(db, {
  now = new Date(),
  rateLimitRetentionSeconds = RATE_LIMIT_RETENTION_SECONDS,
} = {}) {
  const sessions = purgeExpiredSessions(db, { now });
  const rateLimit = deleteRateLimitEventsOlderThan(db, {
    now,
    retentionSeconds: rateLimitRetentionSeconds,
  });
  return { sessions, rateLimit };
}

// ── 命令行入口 ────────────────────────────────────────────────
// ⚠️ 符号链接入口：与 src/server.js / scripts/restore.js 同一处判定（两边都 realpath 再比）
//    —— Node 会把主入口 realpath 化，而 process.argv[1] 保留链接路径
//    ⇒ 字符串全等为假 ⇒ 脚本静默不执行、退出码 0。
const here = dirname(fileURLToPath(import.meta.url));
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const { db, close } = openDatabase({ dataDir });
  try {
    const result = pruneExpiredData(db);
    console.log(`[prune] 过期会话已清理：${result.sessions} 行`);
    console.log(`[prune] 过期限频计数已清理：${result.rateLimit} 行`);
  } finally {
    close();
  }
}

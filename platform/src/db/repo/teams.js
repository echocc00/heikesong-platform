// src/db/repo/teams.js — 战队仓储
// 依据：INTERFACES.md §2（teams 列清单）+ R-REG-01（建队即认领任务包）
import { randomUUID } from 'node:crypto';

const UPDATABLE = new Set([
  'name', 'captain_id', 'task_package_id', 'tier', 'status', 'milestones_json',
]);

export function insertTeam(db, {
  editionId,
  name,
  captainId,
  taskPackageId = null,
  tier = null,
  status = 'forming',
  milestones = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO teams (
       id, edition_id, name, captain_id, task_package_id, tier, status,
       milestones_json, created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id, editionId, name, captainId, taskPackageId, tier, status,
    milestones ? JSON.stringify(milestones) : null, now,
  );
  return getTeam(db, id);
}

export function getTeam(db, id) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

export function listTeamRows(db, {
  editionId = null, taskPackageId = null, captainId = null, status = null,
} = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  if (taskPackageId) { where.push('task_package_id = ?'); params.push(taskPackageId); }
  if (captainId) { where.push('captain_id = ?'); params.push(captainId); }
  if (status) { where.push('status = ?'); params.push(status); }
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare(`SELECT * FROM teams WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`)
    .all(...params);
}

export function updateTeamRow(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'milestones_json' && patch[k] && typeof patch[k] === 'object'
        ? JSON.stringify(patch[k])
        : patch[k],
    );
    db.prepare(`UPDATE teams SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getTeam(db, id);
}

// R-REG-01 + 顶层文档：每个任务包 2–3 支战队（上限在服务层校验）
export function countActiveTeamsByPackage(db, taskPackageId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM teams WHERE task_package_id = ? AND deleted_at IS NULL')
    .get(taskPackageId).n;
}

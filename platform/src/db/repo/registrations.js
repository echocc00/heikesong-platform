// src/db/repo/registrations.js — 报名仓储
// 依据：INTERFACES.md §2（registrations 列清单）+ 设计文档 §5.2
import { randomUUID } from 'node:crypto';

const UPDATABLE = new Set([
  'level', 'level_final', 'decided_by', 'decided_at', 'decision_note', 'status',
]);

export function insertRegistration(db, {
  editionId,
  userId,
  answers,
  dimensionScores = null,
  rawScore = null,
  level = null,
  status = 'submitted',
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO registrations (
       id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
       level, level_final, decided_by, decided_at, decision_note,
       status, created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    id, editionId, userId,
    JSON.stringify(answers),
    dimensionScores ? JSON.stringify(dimensionScores) : null,
    rawScore, level, status, now,
  );
  return getRegistration(db, id);
}

export function getRegistration(db, id) {
  return db
    .prepare('SELECT * FROM registrations WHERE id = ? AND deleted_at IS NULL')
    .get(id) ?? null;
}

export function findActiveRegistration(db, userId, editionId) {
  return db
    .prepare(
      `SELECT * FROM registrations
       WHERE user_id = ? AND edition_id = ? AND deleted_at IS NULL`,
    )
    .get(userId, editionId) ?? null;
}

export function listRegistrationRows(db, {
  editionId = null, status = null, level = null, limit = 200, offset = 0,
} = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (level) { where.push('level = ?'); params.push(level); }
  params.push(limit, offset);
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
    .prepare(
      `SELECT * FROM registrations WHERE ${where.join(' AND ')}
       ORDER BY created_at, rowid LIMIT ? OFFSET ?`,
    )
    .all(...params);
}

/**
 * 某人**报名过的届期** id 列表（去重、升序）。
 *
 * ⚠️ **为什么需要它**（2026-10-23 审计 F33）：
 *    三池读取接口的 `editionId` 是**可选**的 ⇒ 缺省时原实现查的是**全表**
 *    （`listPoolTalentRows(db, null)` ⇒ 不带 WHERE）⇒ 登录用户不带 editionId
 *    就能读到**其它届期**的参赛者姓名、单位、积分、MBA 状态。
 *    ⇒ 缺省届期的正确来源是**viewer 自己的报名记录**（他属于哪一届）。
 *    ⚠️ 推导不出**唯一**届期时（没报名过 / 报过多届）⇒ 调用方必须 fail-closed（不给），
 *    本函数只负责如实返回事实，不替调用方决定。
 */
export function listEditionIdsByUser(db, userId) {
  return db
    .prepare(`SELECT DISTINCT edition_id FROM registrations
              WHERE user_id = ? AND deleted_at IS NULL
              ORDER BY edition_id`)
    .all(userId)
    .map((r) => r.edition_id);
}

export function updateRegistrationRow(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    db.prepare(`UPDATE registrations SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getRegistration(db, id);
}

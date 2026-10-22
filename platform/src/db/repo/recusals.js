// src/db/repo/recusals.js — 回避记录（R-JDG-09 留档）
// 依据：S7 §4.2（回避必须留档，赛后 6 个月可查）
import { randomUUID } from 'node:crypto';

export function insertRecusal(db, { stageId, judgeId, teamId = null, reason, source = 'declared', auditBy = null, action = 'recused', now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, judgeId, teamId, reason, source, now, auditBy, action);
  return db.prepare('SELECT * FROM recusal_records WHERE id = ?').get(id);
}

export function listRecusals(db, { stageId, judgeId = null } = {}) {
  if (judgeId) {
    return db
      .prepare('SELECT * FROM recusal_records WHERE stage_id = ? AND judge_id = ? ORDER BY declared_at, rowid')
      .all(stageId, judgeId);
  }
  // ⚠️ `declared_at` 并列时必须有**确定性**兜底（全局约定 #43：用 rowid，不用随机 UUID）。
  //    「取最后一条记录」是回避撤销语义的基础（同秒申报两条时必须可复现）。
  return db.prepare('SELECT * FROM recusal_records WHERE stage_id = ? ORDER BY declared_at, rowid').all(stageId);
}

// ── 【P10 评委前置】回避台账的**读口** ─────────────────────────────────────
//
// ⚠️ 为什么另起一个函数，**不改** listRecusals：
//   listRecusals 是领域层在用的**原始行**读取（assertNotRecused / reinstateRecusal
//   都要拿 `action` / `declared_at` 的原始值，且 reinstateRecusal 取「最后一条」）。
//   改它的返回形状 ⇒ 会牵动回避的**撤销语义**（checkRecusal 取最后一条记录）——
//   ⇒ 读口另起函数，原始行一个字节都不动。
//
// ⚠️ 队伍名/评委名不是敏感数据：榜单本来就公开队名（R1/R2 公示口径）。
//    但**可见性在 API 层**裁决（全局约束「前端隐藏 = 数据已泄露」）——
//    这里只负责「取数 + 确定性排序」，「谁能看哪些行」由服务层按 viewer 决定。
//
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43）：
//    `id` 是 `crypto.randomUUID()` ⇒ 随机 UUID ⇒ 不能当排序键；
//    `declared_at` 是 ISO 字符串（毫秒精度）⇒ 同刻并列时必须有 rowid 兜底。
export function listRecusalViews(db, { stageId, judgeId = null } = {}) {
  const where = ['r.stage_id = ?'];
  const params = [stageId];
  if (judgeId) {
    where.push('r.judge_id = ?');
    params.push(judgeId);
  }
  return db
    .prepare(
      `SELECT r.id                AS id,
              r.stage_id          AS stageId,
              r.judge_id          AS judgeId,
              r.team_id           AS teamId,
              r.reason            AS reason,
              r.source            AS source,
              r.declared_at       AS createdAt,
              r.audit_by          AS auditBy,
              r.action            AS status,
              t.name              AS teamName,
              u.name              AS judgeName
         FROM recusal_records r
         LEFT JOIN teams t ON t.id = r.team_id
         LEFT JOIN users u ON u.id = r.judge_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.declared_at, r.rowid`,
    )
    .all(...params);
}

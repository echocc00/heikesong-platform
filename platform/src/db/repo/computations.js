// src/db/repo/computations.js — 计算快照与赛段结果
// 依据：设计文档 §12（可复算：input + output + trace 三件套）+ §8【决策】（compute 是显式动作）
// ⚠️ 本文件**不含裸 SQL 之外的任何逻辑**，全部 SQL 收在此处（全局约束「SQL 边界」）。
import { randomUUID } from 'node:crypto';

export function nextRevision(db, { stageId, kind, teamId = null }) {
  // ⚠️ **P4 扩展**（本函数由 P2 建立）：P4 需要「同一赛段内按队伍各自编号」，
  //    所以加了一个**可选**的 teamId 收窄条件。
  //    ⛔ 不传 teamId 时**行为与 P2 一字不差**（P2 的调用点
  //       `nextRevision(db, { stageId, kind })` 不受影响）。
  //    ⛔ 绝不在本文件里**再定义一个 nextRevision** —— 同名导出重复声明会让整个
  //       模块抛 SyntaxError，`src/services/compute.js` 连带**整个平台**都加载不了。
  const where = ['stage_id = ?', 'kind = ?'];
  const params = [stageId, kind];
  if (teamId != null) { where.push('team_id = ?'); params.push(teamId); }
  const row = db
    .prepare(`SELECT MAX(revision) AS rev FROM computation_snapshots WHERE ${where.join(' AND ')}`)
    .get(...params);
  return (row?.rev ?? 0) + 1;
}

/** 三件套快照：input + output + trace（P4 的 recomputeAndDiff 依赖它重放） */
export function insertSnapshot(db, { kind, editionId = null, stageId = null, teamId = null, ruleVersion, input, output, trace, revision, now, id = randomUUID() }) {
  // ⚠️ **P4 扩展**：加了可选的 `id`（默认仍是随机 UUID）——
  //    P4 的审计留痕需要「自己指定 id 以便测试与外部引用」。
  //    不传 id 时行为与 P2 一字不差。
  db.prepare(
    `INSERT INTO computation_snapshots
       (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, editionId, stageId, teamId, ruleVersion, JSON.stringify(input), JSON.stringify(output), JSON.stringify(trace), revision, now);
  return id;
}

export function getSnapshot(db, id) {
  return db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(id) ?? null;
}

/**
 * 取快照并**校验它属于该赛段**。
 * ⚠️ 父代理预审修正（Critical，D-26）：接口是
 *    `GET /api/stages/:stageId/computations/:computationId`，
 *    但原实现只按 id 取 —— 路径里的 stageId 形同虚设，
 *    任何有 `audit:read` 的人都能拿**别的赛段**的计算快照来读（跨赛段越权读）。
 *    现在传入 stageId 时必须匹配，不匹配返回 null（上层回 404）。
 */
export function getSnapshotInStage(db, { id, stageId = null }) {
  const row = getSnapshot(db, id);
  if (!row) return null;
  if (stageId != null && row.stage_id !== stageId) return null;
  return row;
}

export function listSnapshots(db, { stageId, kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = ? ORDER BY revision').all(stageId, kind);
  }
  return db.prepare('SELECT * FROM computation_snapshots WHERE stage_id = ? ORDER BY revision').all(stageId);
}

/**
 * 重算前清场：名次/并列/积分一律置 NULL，并删掉「本轮已无评分」的旧结果行。
 * ⚠️ 父代理预审修正（Important，I2）：`upsertStageResult` 的 ON CONFLICT 只更新
 *    total / seat_p / seat_e / computation_id —— **rank / tied_with / points 原样保留**。
 *    于是「P3 已经发过榜 → 之后又重算一次」的结果是：**旧名次 + 新总分**并排躺在同一行上，
 *    榜单自相矛盾。撤掉某队的全部打分后重算，旧行也仍在（total 还是老的）。
 *    现在重算前先清场（P3 会在新一轮计算后重新填名次与积分）。
 * @param {string[]} keepTeamIds 本轮**有**评分的队伍；不在名单里的旧行一律删除
 */
export function resetStageResults(db, { stageId, keepTeamIds = [] }) {
  db.prepare('UPDATE stage_results SET rank = NULL, tied_with = NULL, points = NULL WHERE stage_id = ?').run(stageId);
  if (keepTeamIds.length) {
    const placeholders = keepTeamIds.map(() => '?').join(', ');
    db
      .prepare(`DELETE FROM stage_results WHERE stage_id = ? AND team_id NOT IN (${placeholders})`)
      .run(stageId, ...keepTeamIds);
    return;
  }
  db.prepare('DELETE FROM stage_results WHERE stage_id = ?').run(stageId);
}

/** 赛段结果：rank / tied_with / points 由 P3 填（P2 显式留空，不假装有名次） */
export function upsertStageResult(db, { stageId, teamId, total, seatP, seatE, computationId, now }) {
  db.prepare(
    `INSERT INTO stage_results (id, stage_id, team_id, total, seat_p, seat_e, computation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (stage_id, team_id) DO UPDATE SET total = excluded.total, seat_p = excluded.seat_p,
       seat_e = excluded.seat_e, computation_id = excluded.computation_id, created_at = excluded.created_at`,
  ).run(randomUUID(), stageId, teamId, total, seatP, seatE, computationId, now);
  return db.prepare('SELECT * FROM stage_results WHERE stage_id = ? AND team_id = ?').get(stageId, teamId);
}

// ── P4 追加：按「最近优先」列快照（审计列表用）────────────────────────
// 依据：设计文档 §12「可复算：input + output + trace 三件套」
//   ⛔ 重算走 revision + 1，旧 revision 保留（设计文档 §11.1「事后篡改」防护）。
// ⚠️ 与 P2 的 listSnapshots 语义**不同**，不是同一件事的第二个名字：
//    · listSnapshots(stageId)  =「某赛段的全部快照，按 revision 升序」→ 给**重放**用
//    · listComputationRows()   =「最近的快照，倒序 + 可分页」→ 给**审计列表**用
export function listComputationRows(db, { kind = null, stageId = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (stageId) { where.push('stage_id = ?'); params.push(stageId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM computation_snapshots ${clause}`).get(...params).n;
  // ⛔ 确定性排序：破并列键用 SQLite 隐式 `rowid`，**不用 `id`** ——
  //    `id` 是 randomUUID() ⇒ 同 `created_at` 的两条记录**次序随机**。
  //    全局约束同 `src/db/repo/audit-log.js`（P4-13 根因修复）。
  const rows = db.prepare(
    `SELECT * FROM computation_snapshots ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

// src/db/repo/computations.js — 计算快照与赛段结果
// 依据：设计文档 §12（可复算：input + output + trace 三件套）+ §8【决策】（compute 是显式动作）
// ⚠️ 本文件**不含裸 SQL 之外的任何逻辑**，全部 SQL 收在此处（全局约束「SQL 边界」）。
import { randomUUID } from 'node:crypto';

export function nextRevision(db, { stageId, kind }) {
  const row = db
    .prepare('SELECT MAX(revision) AS rev FROM computation_snapshots WHERE stage_id = ? AND kind = ?')
    .get(stageId, kind);
  return (row?.rev ?? 0) + 1;
}

/** 三件套快照：input + output + trace（P4 的 recomputeAndDiff 依赖它重放） */
export function insertSnapshot(db, { kind, editionId = null, stageId = null, teamId = null, ruleVersion, input, output, trace, revision, now }) {
  const id = randomUUID();
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

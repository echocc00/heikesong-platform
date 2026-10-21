// src/db/repo/stage-teams.js — 赛段队伍名册（赛段级队伍边界）
// 依据：P2 计划 D-33 的**已知限制**——「名册目前是**届期级**（stages → edition_id → teams），
//   赛段级队伍边界需要一张 `stage_team` 表 —— 登记在 P3」。
//   本文件是那条承诺的兑现：把「某队属于本赛段」从**届期粒度**落到**赛段粒度**。
//
// ⚠️ 为什么必须有这张表（不建的后果）：
//   只有届期名册时，**同届期另一赛段的队伍**也能被写进本赛段 —— 评分 / 企业确认 /
//   行为分 / 里程碑签字都会记到一支「没在这个赛段参赛」的队头上 → 外队进榜。
//   届期级判定挡不住这种情况（同届期的队就是合法的），**只有赛段级名册能挡**。
//
// ⛔ 归属：本文件是 **P3 建立**（P2 计划 D-33 明确「登记在 P3」）。
//    P2 的 `services/review.js` 的 `assertTeamInStage` 仍是**届期级**判定 ——
//    切换到赛段级需要「名册有数据时优先赛段级、否则回落到届期级」的口径，
//    属 P3 Task 7 的服务层接线范围（见 P3 计划偏差表 3c）。
//
// ⚠️ 登记的**触发时机**（赛段开启时把该届参赛队登记进来）属 **P5 的工作流**；
//    本阶段只提供「表 + 仓储」，写入由后续流程调用 —— 表本身不是死表。
import { randomUUID } from 'node:crypto';

/**
 * 把队伍登记进赛段名册。
 * @returns {number} 实际登记的队数
 * ⚠️ 重复登记会撞唯一约束（stage_id, team_id）→ **抛错**，不静默忽略。
 *    幂等判定是**服务层**的事（它要先查再决定），仓储层不吞异常。
 */
export function registerStageTeams(db, { stageId, teamIds, now }) {
  const ids = Array.isArray(teamIds) ? teamIds : [teamIds];
  const stmt = db.prepare(
    `INSERT INTO stage_team (id, stage_id, team_id, registered_at) VALUES (?, ?, ?, ?)`,
  );
  let n = 0;
  for (const teamId of ids) {
    stmt.run(randomUUID(), stageId, teamId, now);
    n += 1;
  }
  return n;
}

/** 某赛段名册里的全部队伍 id（按登记时间、再按 id 排序 → 确定性）。 */
export function listStageTeamIds(db, stageId) {
  return db
    .prepare('SELECT team_id FROM stage_team WHERE stage_id = ? ORDER BY registered_at ASC, id ASC')
    .all(stageId)
    .map((r) => r.team_id);
}

/** 该队是否在赛段名册内。 */
export function isTeamInStage(db, stageId, teamId) {
  const row = db
    .prepare('SELECT 1 AS x FROM stage_team WHERE stage_id = ? AND team_id = ?')
    .get(stageId, teamId);
  return row != null;
}

/** 赛段名册是否已登记过任何队伍（区分「名册为空」与「名册未启用」）。 */
export function hasStageRoster(db, stageId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stageId);
  return Number(row?.n ?? 0) > 0;
}

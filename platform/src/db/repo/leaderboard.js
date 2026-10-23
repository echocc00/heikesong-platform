// src/db/repo/leaderboard.js — 榜单相关 SQL
// 依据：INTERFACES.md §0「数据层」条——所有 SQL 收在 src/db/repo/，service/handler 内禁止裸 SQL。
import { randomUUID } from 'node:crypto';

export function getStage(db, stageId) {
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId) ?? null;
}

export function listEditionStages(db, editionId) {
  return db.prepare('SELECT * FROM stages WHERE edition_id = ? ORDER BY key ASC').all(editionId);
}

export function listStageResults(db, stageId) {
  return db.prepare(`
    SELECT sr.id, sr.stage_id, sr.team_id, sr.rank, sr.total, sr.seat_p, sr.seat_e,
           sr.tied_with, sr.points, sr.computation_id, sr.created_at,
           t.name AS team_name, t.task_package_id, t.edition_id
    FROM stage_results sr JOIN teams t ON t.id = sr.team_id
    WHERE sr.stage_id = ? ORDER BY sr.rank ASC, sr.team_id ASC`).all(stageId);
}

export function getTeam(db, teamId) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(teamId) ?? null;
}

/**
 * 回写赛段结果的**名次 / 并列数 / 积分**（E170 / F7）。
 *
 * ⚠️ 为什么这三列此前永远是 NULL：
 *   P2 建表时留了三列空位并约定「**P3 来填**」，而 P3 从来没填 ——
 *   全仓唯一碰这三列的 SQL 是 `resetStageResults` 的 `SET rank = NULL, tied_with = NULL, points = NULL`
 *   （**只置 NULL**）⇒ 公开榜单的 `rank` / `points` / `tiedWith` 恒为 null，
 *   而排序退化成 `team_id` 序（**低分队排在高分队前面**）⇒ 榜单的名次是错的。
 *   （与本仓已修的 E149/E150「服务写好了但没有路由触达」同款病根：P2 留了坑，P3 没填。）
 *
 * @param {number} rank      名次（1 起）
 * @param {number} tiedWith  **与本队并列的队伍数**（0 = 不并列）。
 *   ⚠️ 口径：领域层的 `rankTeams` 给的是「并列组里除自己外的队 id 数组」，
 *      而本列是 INTEGER ⇒ 落库的是**个数**（0/1/2…），与 P3 计划里的夹具口径一致。
 * @param {number} points    本赛段名次积分
 */
export function updateStageResultRanking(db, { stageId, teamId, rank, tiedWith = 0, points = null }) {
  db.prepare(
    'UPDATE stage_results SET rank = ?, tied_with = ?, points = ? WHERE stage_id = ? AND team_id = ?',
  ).run(rank, tiedWith, points, stageId, teamId);
}

export function listTeamMembers(db, teamId) {
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL').all(teamId);
}

export function listTeamIdsByUser(db, userId) {
  if (!userId) return [];
  return db.prepare('SELECT team_id FROM team_members WHERE user_id = ? AND left_at IS NULL')
    .all(userId).map((r) => r.team_id);
}

export function isTeamMember(db, teamId, userId) {
  if (!userId) return false;
  return Boolean(db.prepare(
    'SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL',
  ).get(teamId, userId));
}

export function listUserNames(db, userIds) {
  const ids = (Array.isArray(userIds) ? userIds : []).filter(Boolean);
  if (!ids.length) return {};
  const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const out = {};
  for (const r of rows) out[r.id] = r.name;
  return out;
}

/** 互评分：队伍收到的互评均分（破同分链第 3 项） */
export function listPeerScoreTotals(db, stageId) {
  return db.prepare(`SELECT to_team_id AS team_id, AVG(score) AS peer_score, COUNT(*) AS n
    FROM peer_reviews WHERE stage_id = ? GROUP BY to_team_id`).all(stageId);
}

/** 企业确认原始分：队伍的企业确认均分（破同分链第 4 项） */
export function listEnterpriseRawTotals(db, stageId) {
  return db.prepare(`SELECT team_id, AVG(raw_score) AS enterprise_raw, COUNT(*) AS n
    FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL GROUP BY team_id`).all(stageId);
}

/** 加时陈述复议分（破同分链第 2 项，仅决赛） */
/**
 * ⛔ P11 · **已删除**：`listTiebreakVoteTotals`（原按 `tiebreak_votes` 直接 AVG 的聚合）。
 *
 *    为什么删：它是 `src/services/tiebreak.js::getTiebreakExtraScores` 的**孪生实现**，
 *    少了两条口径：
 *      ① 「只消费**已关闭**的轮次」—— 开放中的轮次，其当前均值会被当成最终复议分消费
 *         ⇒ **榜单随投票进行而漂移**（破同分必须可复算 ⇒ 这条直接违规）；
 *      ② 「同一队多轮取**最新一轮**」。
 *    ⇒ 排名路径已统一走服务层（src/services/leaderboard.js 的 buildStageRanking），
 *      留着一份语义不同又没人调的实现 = 下一个改口径的人会踩坑。
 *    （机器闸 docs/tools/dead-service-scan.mjs 的存在意义就在这里。）
 */

/** 最近一次计算快照：降级告警的来源（P2 写，P3 读） */
export function getLatestComputation(db, stageId) {
  return db.prepare(`SELECT * FROM computation_snapshots WHERE stage_id = ? AND kind = 'stage_score'
    ORDER BY revision DESC, created_at DESC LIMIT 1`).get(stageId) ?? null;
}

export function insertSnapshot(db, { id, editionId, stageId, scope, payloadJson, createdAt }) {
  db.prepare('INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, editionId, stageId ?? null, scope, payloadJson, createdAt);
}

/**
 * 某赛段的发榜快照列表（按发榜时间升序）。
 * ⛔ P11：原先**没有任何读口**能回答「这个赛段发了榜没有」⇒ 前端刷新页面后
 *    就不知道自己刚做过什么。排序兜底用 SQLite 隐式 `rowid`（不用随机 id 列）。
 */
export function listSnapshotsByStage(db, stageId) {
  return db.prepare('SELECT id, stage_id, scope, created_at FROM leaderboard_snapshots WHERE stage_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(stageId);
}

export function insertAuditLog(db, { id = randomUUID(), actorId, action, entity, entityId, detailJson, createdAt }) {
  db.prepare('INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, actorId ?? null, action, entity ?? null, entityId ?? null, detailJson ?? null, createdAt);
}

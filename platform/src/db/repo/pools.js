// src/db/repo/pools.js — 三池仓储（写 + 读）
// 依据：设计文档 §5.4；R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池
// ⛔ 写入只允许经由 src/services/pools.js 的同步服务（单一计算点）；
//    本文件不提供任何"手工加一行"的对外函数。
import { randomUUID } from 'node:crypto';

// ── 项目池 ──────────────────────────────────────────────────────────
export function insertPoolProject(
  db,
  { id = randomUUID(), editionId, teamId, title, industry = null, stageReached = null,
    tier = null, businessValue = null, summary = null, now },
) {
  db.prepare(
    `INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier,
       business_value, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, teamId, title, industry, stageReached, tier, businessValue, summary, now);
  return id;
}

export function updatePoolProject(
  db,
  id,
  { title, industry = null, stageReached = null, tier = null, businessValue = null, summary = null },
) {
  return db
    .prepare(
      `UPDATE pool_projects
          SET title = ?, industry = ?, stage_reached = ?, tier = ?, business_value = ?, summary = ?
        WHERE id = ?`,
    )
    .run(title, industry, stageReached, tier, businessValue, summary, id).changes;
}

export function deletePoolProject(db, id) {
  return db.prepare('DELETE FROM pool_projects WHERE id = ?').run(id).changes;
}

export function listPoolProjectRows(db, editionId = null) {
  return editionId
    ? db.prepare('SELECT * FROM pool_projects WHERE edition_id = ? ORDER BY team_id').all(editionId)
    : db.prepare('SELECT * FROM pool_projects ORDER BY edition_id, team_id').all();
}

// ── 人才池 ──────────────────────────────────────────────────────────
export function insertPoolTalent(
  db,
  { id = randomUUID(), editionId, userId, name, org = null, totalPoints = 0, mbaStatus = null,
    stagesJoined = 0, skillsJson = '[]', now },
) {
  db.prepare(
    `INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status,
       stages_joined, skills_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, editionId, name, org, totalPoints, mbaStatus, stagesJoined, skillsJson, now);
  return id;
}

export function updatePoolTalent(
  db,
  id,
  { name, org = null, totalPoints = 0, mbaStatus = null, stagesJoined = 0, skillsJson = '[]' },
) {
  return db
    .prepare(
      `UPDATE pool_talents
          SET name = ?, org = ?, total_points = ?, mba_status = ?, stages_joined = ?, skills_json = ?
        WHERE id = ?`,
    )
    .run(name, org, totalPoints, mbaStatus, stagesJoined, skillsJson, id).changes;
}

export function deletePoolTalent(db, id) {
  return db.prepare('DELETE FROM pool_talents WHERE id = ?').run(id).changes;
}

export function listPoolTalentRows(db, editionId = null) {
  return editionId
    ? db.prepare('SELECT * FROM pool_talents WHERE edition_id = ? ORDER BY total_points DESC, user_id').all(editionId)
    : db.prepare('SELECT * FROM pool_talents ORDER BY edition_id, total_points DESC, user_id').all();
}

// ── 资源池 ──────────────────────────────────────────────────────────
export function insertPoolResource(
  db,
  { id = randomUUID(), editionId, enterpriseId, enterpriseName = null, kind, detail = null, now },
) {
  db.prepare(
    `INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, enterpriseId, enterpriseName, kind, detail, now);
  return id;
}

export function updatePoolResource(db, id, { enterpriseName = null, kind, detail = null }) {
  return db
    .prepare('UPDATE pool_resources SET enterprise_name = ?, kind = ?, detail = ? WHERE id = ?')
    .run(enterpriseName, kind, detail, id).changes;
}

export function deletePoolResource(db, id) {
  return db.prepare('DELETE FROM pool_resources WHERE id = ?').run(id).changes;
}

export function listPoolResourceRows(db, editionId = null) {
  return editionId
    ? db.prepare('SELECT * FROM pool_resources WHERE edition_id = ? ORDER BY enterprise_id, kind').all(editionId)
    : db.prepare('SELECT * FROM pool_resources ORDER BY edition_id, enterprise_id, kind').all();
}

// src/db/repo/self-reviews.js — 自评测
import { randomUUID } from 'node:crypto';

export function findSelfReviewsByRequestId(db, { stageId, teamId = null, requestId }) {
  if (!requestId) return [];
  if (teamId) {
    return db
      .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND request_id = ?')
      .all(stageId, teamId, requestId);
  }
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND request_id = ?')
    .all(stageId, requestId);
}

export function findSelfReview(db, { stageId, teamId, dimension }) {
  return db
    .prepare('SELECT * FROM self_reviews WHERE stage_id = ? AND team_id = ? AND dimension = ?')
    .get(stageId, teamId, dimension) ?? null;
}

export function insertSelfReview(db, { stageId, teamId, dimension, rawScore, requestId = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO self_reviews (id, stage_id, team_id, dimension, raw_score, submitted_at, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, teamId, dimension, rawScore, now, requestId);
  return db.prepare('SELECT * FROM self_reviews WHERE id = ?').get(id);
}

export function updateSelfReviewScore(db, { id, rawScore, now }) {
  db.prepare('UPDATE self_reviews SET raw_score = ?, submitted_at = ? WHERE id = ?').run(rawScore, now, id);
  return db.prepare('SELECT * FROM self_reviews WHERE id = ?').get(id);
}

export function listSelfReviews(db, stageId) {
  return db.prepare('SELECT * FROM self_reviews WHERE stage_id = ? ORDER BY team_id, dimension').all(stageId);
}

// ── 【P10 评委前置】自评的「我交过哪些」读口 ────────────────────────────────
//
// ⚠️ **口径与写入口完全一致**（src/http/routes/review.js 的 POST /self-review）：
//    「自评只能由**本队成员**提交」⇒ 「我的自评」= **我参与的队**的自评。
//    ⛔ 不是「评委的自评」——自评是队伍行为（R-JDG-13：不加分，只触发说明与提问）。
//
// ⚠️ **队长也算参与**（与正式站 listMyTeams 同一口径）：队长不一定有 team_members 行。
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43，不用随机 UUID 的 id）。
export function listSelfReviewsForViewer(db, { stageId, userId }) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT sr.team_id    AS teamId,
              sr.dimension  AS dimension,
              sr.raw_score  AS rawScore,
              sr.submitted_at AS createdAt
         FROM self_reviews sr
         JOIN teams t ON t.id = sr.team_id
        WHERE sr.stage_id = ?
          AND ( t.captain_id = ?
                OR EXISTS (SELECT 1 FROM team_members m
                            WHERE m.team_id = t.id AND m.user_id = ? AND m.left_at IS NULL) )
        ORDER BY sr.team_id, sr.dimension, sr.rowid`,
    )
    .all(stageId, userId, userId);
}

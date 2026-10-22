// src/db/repo/peer-reviews.js — 互评
import { randomUUID } from 'node:crypto';

export function findPeerReviewsByRequestId(db, { stageId, fromTeamId = null, requestId }) {
  if (!requestId) return [];
  if (fromTeamId) {
    return db
      .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND request_id = ?')
      .all(stageId, fromTeamId, requestId);
  }
  // 赛段级查找：用于「同一个 requestId 是否被用于了不同内容」的判定
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND request_id = ?')
    .all(stageId, requestId);
}

export function findPeerReview(db, { stageId, fromTeamId, toTeamId }) {
  return db
    .prepare('SELECT * FROM peer_reviews WHERE stage_id = ? AND from_team_id = ? AND to_team_id = ?')
    .get(stageId, fromTeamId, toTeamId) ?? null;
}

export function insertPeerReview(db, { stageId, fromTeamId, toTeamId, score, requestId = null, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, fromTeamId, toTeamId, score, requestId, now);
  return db.prepare('SELECT * FROM peer_reviews WHERE id = ?').get(id);
}

export function updatePeerReviewScore(db, { id, score, now }) {
  db.prepare('UPDATE peer_reviews SET score = ?, created_at = ? WHERE id = ?').run(score, now, id);
  return db.prepare('SELECT * FROM peer_reviews WHERE id = ?').get(id);
}

export function listPeerReviews(db, stageId) {
  return db.prepare('SELECT * FROM peer_reviews WHERE stage_id = ? ORDER BY from_team_id, to_team_id').all(stageId);
}

// ── 【P10 评委前置】互评的「我交过哪些」读口 ────────────────────────────────
//
// ⚠️ **口径与写入口完全一致**（src/http/routes/review.js 的 POST /peer-reviews）：
//    「提交者必须是**发起队**的在册成员」⇒ 所以「我的互评」= **我参与的那些队发起的互评**。
//    ⛔ 不是「我打过分」——互评是「队 → 队」的行为，记录里没有评委维度。
//
// ⚠️ **队长也算参与**（与正式站 listMyTeams 同一口径，src/services/team.js）：
//    建队时只写 `teams.captain_id`，**不一定**有 team_members 行
//    ⇒ 只查 team_members 会把队长漏掉（队长的互评就消失了）。
//
// ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约定 #43）：
//    `id` 是 randomUUID（随机）⇒ 不能排序；`from/to_team_id` 是 UUID ⇒ 也不是稳定序。
export function listPeerReviewsForViewer(db, { stageId, userId }) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT pr.from_team_id AS fromTeamId,
              pr.to_team_id   AS toTeamId,
              pr.score        AS score,
              pr.created_at   AS createdAt
         FROM peer_reviews pr
         JOIN teams t ON t.id = pr.from_team_id
        WHERE pr.stage_id = ?
          AND ( t.captain_id = ?
                OR EXISTS (SELECT 1 FROM team_members m
                            WHERE m.team_id = t.id AND m.user_id = ? AND m.left_at IS NULL) )
        ORDER BY pr.from_team_id, pr.to_team_id, pr.rowid`,
    )
    .all(stageId, userId, userId);
}

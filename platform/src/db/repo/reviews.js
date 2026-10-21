// src/db/repo/reviews.js — 评委打分、校准打分、增量统计
// 依据：S7 §3.1（评委宽严归一化的原始分来源）+ 设计文档 §6.2 Step 2（mean/stdev 增量维护）
import { randomUUID } from 'node:crypto';

export function findReviewsByRequestId(db, { stageId, judgeId, requestId }) {
  if (!requestId) return [];
  return db
    .prepare('SELECT * FROM stage_reviews WHERE stage_id = ? AND judge_id = ? AND request_id = ?')
    .all(stageId, judgeId, requestId);
}

export function findReview(db, { stageId, judgeId, teamId, dimension }) {
  return db
    .prepare('SELECT * FROM stage_reviews WHERE stage_id = ? AND judge_id = ? AND team_id = ? AND dimension = ?')
    .get(stageId, judgeId, teamId, dimension) ?? null;
}

export function insertReview(db, { stageId, judgeId, teamId, dimension, rawScore, requestId = null, calibrated = 0, now }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at, request_id, calibrated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stageId, judgeId, teamId, dimension, rawScore, now, requestId, calibrated);
  return db.prepare('SELECT * FROM stage_reviews WHERE id = ?').get(id);
}

/** 改分：同一 (赛段,评委,队伍,维度) 覆盖写，request_id 保留首次提交的那一个 */
export function updateReviewScore(db, { id, rawScore, now }) {
  db.prepare('UPDATE stage_reviews SET raw_score = ?, submitted_at = ? WHERE id = ?').run(rawScore, now, id);
  return db.prepare('SELECT * FROM stage_reviews WHERE id = ?').get(id);
}

export function listReviews(db, { stageId, judgeId = null, teamId = null } = {}) {
  const where = ['stage_id = ?'];
  const params = [stageId];
  if (judgeId) { where.push('judge_id = ?'); params.push(judgeId); }
  if (teamId) { where.push('team_id = ?'); params.push(teamId); }
  // ⚠️ 父代理预审修正（Important，I5 的同源问题）：软删除的打分**不得**再计入计算。
  //    `stage_reviews` 有 `deleted_at` 列（软删除语义：评分只增不改，删除用软删除），
  //    但这里原来不滤 —— 删掉的分还在榜单里。
  return db
    .prepare(`SELECT * FROM stage_reviews WHERE ${where.join(' AND ')} AND calibrated = 0 AND deleted_at IS NULL ORDER BY team_id, dimension, judge_id`)
    .all(...params);
}

export function listReviewCells(db, stageId) {
  return db
    .prepare('SELECT DISTINCT team_id, dimension FROM stage_reviews WHERE stage_id = ? AND calibrated = 0')
    .all(stageId);
}

export function insertCalibration(db, { stageId, judgeId, dimension, rawScore, now }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO calibrations (id, stage_id, judge_id, dimension, raw_score, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, stageId, judgeId, dimension, rawScore, now);
  return id;
}

export function listCalibrations(db, stageId) {
  return db.prepare('SELECT * FROM calibrations WHERE stage_id = ? ORDER BY created_at').all(stageId);
}

/** score_stats：增量维护 n / mean / sum_sq（stdev 由 sum_sq 现算） */
export function getScoreStat(db, judgeId, dimension) {
  return db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judgeId, dimension) ?? null;
}

export function upsertScoreStat(db, { judgeId, dimension, n, mean, sumSq, now }) {
  db.prepare(
    `INSERT INTO score_stats (judge_id, dimension, n, mean, sum_sq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (judge_id, dimension) DO UPDATE SET n = excluded.n, mean = excluded.mean,
       sum_sq = excluded.sum_sq, updated_at = excluded.updated_at`,
  ).run(judgeId, dimension, n, mean, sumSq, now);
  return getScoreStat(db, judgeId, dimension);
}

/** 从 (n, mean, sum_sq) 现算样本标准差 */
export function stdevFromStats(n, mean, sumSq) {
  if (n < 2) return 0;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * 增量更新某个 (评委, 维度) 的统计量。
 * @param {number[]} added 新增的原始分
 * @param {number[]} removed 被改分替换掉的旧原始分
 */
export function applyScoreStatDelta(db, { judgeId, dimension, added = [], removed = [], now }) {
  const cur = getScoreStat(db, judgeId, dimension);
  const n0 = cur?.n ?? 0;
  const mean0 = cur?.mean ?? 0;
  const sumSq0 = cur?.sum_sq ?? 0;
  const sum0 = n0 * mean0;

  const addSum = added.reduce((a, v) => a + v, 0);
  const remSum = removed.reduce((a, v) => a + v, 0);
  const addSq = added.reduce((a, v) => a + v * v, 0);
  const remSq = removed.reduce((a, v) => a + v * v, 0);

  const n1 = n0 + added.length - removed.length;
  const sum1 = sum0 + addSum - remSum;
  const sumSq1 = sumSq0 + addSq - remSq;
  const mean1 = n1 > 0 ? sum1 / n1 : 0;

  upsertScoreStat(db, { judgeId, dimension, n: n1, mean: mean1, sumSq: sumSq1, now });
  return { judgeId, dimension, n: n1, mean: mean1, sumSq: sumSq1, stdev: stdevFromStats(n1, mean1, sumSq1) };
}

// src/services/tiebreak.js — 加时陈述与一票破同分
//
// 依据：S7 §3.3（R-JDG-19 同分加时陈述：决赛同分 → 10 分钟加时陈述 → 企业席+评委席共同复议
//       → 仍同分按企业确认原始分）+ 设计文档 §6.4【决策】加时陈述用独立表 + 唯一约束。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 7 处修正，读代码前先看这段】
//   ① **关闭一个不存在的轮次 → 裸 TypeError 漏到调用方**：
//      `closeTiebreakRoundRow` 对不存在的 id 是 0 行受影响 → 返回 null →
//      紧接着 `round.stage_id` 抛「Cannot read properties of null」，
//      而它**不是 AppError** → HTTP 层只能回通用文案「请求无效」。现在 404。
//   ② **UNIQUE 兜底正则过宽** —— `/UNIQUE|constraint/i` 会把「外键失败」也当成
//      「重复投票」→ 409 → 真实错误被伪装成幂等冲突。收紧为只认唯一约束。
//   ③ **投票分没有 0–100 区间校验** → 1000 分进票 → 复议分破 100。
//   ④ **投票人不校验是否有投票权** —— 观察员、回避中的评委都能投票（R-JDG-09 / R-JDG-11）。
//   ⑤ **轮次排序不确定** —— 只按 `created_at` 排，而同一秒开启的两个轮次时间戳相同，
//      SQLite 的 ORDER BY 对并列行不保证稳定 → 「多轮取最新一轮」取到哪一轮随缘
//      → **破同分链的结果不可复算**。现在加 `rowid` 兜底。
//   ⑥ **未关闭的轮次也被算进复议分** —— `getTiebreakExtraScores` 取了全部轮次，
//      一个还在开放投票的轮次，其**当前均值**会被当成最终复议分消费
//      → 榜单随投票进行而漂移。现在只消费 `status='closed'` 的轮次。
//   ⑦ **开轮次不校验「同分组」是否合法** —— 可以开一个只有一支队伍的「同分」轮次；
//      同一赛段也能同时开两个 open 轮次 → 票分散在两轮里。
import {
  insertTiebreakRound,
  getTiebreakRound,
  listTiebreakRounds,
  closeTiebreakRoundRow,
  insertTiebreakVote,
  listTiebreakVotes,
} from '../db/repo/tiebreak.js';
import { getStageJudge, listStageTeams } from '../db/repo/stages.js';
import { listRecusals } from '../db/repo/recusals.js';
import { checkRecusal } from '../domain/review-eligibility.js';
import { writeAuditLog } from '../audit/log.js';
import { appError } from '../errors.js';

function fail(status, code, message) {
  // ⚠️ 必须用 P0 的 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    P0 终审 I-C 的错误分支是 `err instanceof AppError ? err.message : '请求无效'` ——
  //    裸 Error 不是 AppError → message 被替换成通用文案「请求无效」。
  return appError(status, code, message);
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * 开启一轮加时陈述（S7 §3.3：10 分钟）
 *
 * ⛔ 同分组至少两支队伍（去重后）；同一赛段不允许已有 open 轮次 ——
 *    否则票会分散在两个轮次里，破同分链取到的是哪一轮随缘。
 */
export function openTiebreakRound({ db, stageId, tiedTeamIds = [], statementMinutes = 10, actorId, now }) {
  const unique = [...new Set(tiedTeamIds)];
  if (unique.length < 2) {
    throw fail(400, 'NO_TIED_TEAMS', '没有同分队伍，无需加时陈述（至少需要两支同分队伍）');
  }
  // ⛔ 同分组的队伍必须真实存在且属于本赛段 —— 否则会开出一个「指向幽灵队伍」的轮次，
  //    投票时在外键上炸（而且错误信息是原始 SQL 原文）。
  const roster = new Set(listStageTeams(db, stageId).map((t) => t.teamId));
  const unknown = unique.filter((id) => !roster.has(id));
  if (unknown.length) {
    throw fail(400, 'TIED_TEAM_NOT_IN_STAGE', '同分组里有队伍不属于本赛段或不存在', { unknown });
  }
  if (listTiebreakRounds(db, { stageId, status: 'open' }).length) {
    throw fail(409, 'TIEBREAK_ROUND_ALREADY_OPEN', '该赛段已有一轮进行中的加时陈述，请先关闭');
  }
  const round = insertTiebreakRound(db, {
    stageId,
    kind: 'statement',
    tiedTeamIds: unique,
    statementDeadline: addMinutes(now, statementMinutes),
    createdBy: actorId,
    now,
  });
  writeAuditLog(db, {
    actorId, action: 'tiebreak.open', entity: 'stage', entityId: stageId,
    detail: { roundId: round.id, tiedTeamIds: unique }, now,
  });
  return round;
}

/**
 * 投票（一人一队一票由数据库主键保证）
 *
 * ⛔ 投票人必须**有投票权**（R-JDG-11：观察员无投票权）且**未回避**该队（R-JDG-09）。
 */
export function castTiebreakVote({ db, roundId, voterId, teamId, score, now }) {
  const round = getTiebreakRound(db, roundId);
  if (!round) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  if (round.status !== 'open') throw fail(409, 'TIEBREAK_ROUND_CLOSED', '该轮加时陈述已关闭');

  const seat = getStageJudge(db, round.stage_id, voterId);
  if (!seat) throw fail(403, 'NOT_ASSIGNED_JUDGE', '该投票人未被分配到本赛段');
  if (seat.seat === 'observer') {
    throw fail(403, 'OBSERVER_NO_VOTE', '观察员无投票权，不能参与破同分投票');
  }
  const recusal = checkRecusal({
    judge: { userId: voterId },
    team: { teamId },
    recusalRecords: listRecusals(db, { stageId: round.stage_id, judgeId: voterId }),
  });
  if (recusal.recused) {
    throw fail(403, 'RECUSED', `该投票人已回避本队（原因：${recusal.record?.reason ?? '未填写'}）`);
  }

  const tied = JSON.parse(round.tied_team_ids_json);
  if (!tied.includes(teamId)) throw fail(400, 'TEAM_NOT_IN_TIE_GROUP', '该队伍不在同分组中');
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw fail(400, 'SCORE_OUT_OF_RANGE', '投票分必须是 0–100 之间的数字');
  }
  try {
    return insertTiebreakVote(db, { roundId, voterId, teamId, score, now });
  } catch (err) {
    // ⚠️ 只认「唯一约束」这一种失败 —— 外键失败等其他错误必须继续往上抛，
    //    否则真实错误会被伪装成「重复投票」。
    if (/UNIQUE constraint failed: tiebreak_votes/i.test(String(err.message))) {
      throw fail(409, 'DUPLICATE_TIEBREAK_VOTE', '同一人对同一队伍只能投一次');
    }
    throw err;
  }
}

function tally(votes) {
  const buckets = new Map();
  for (const v of votes) {
    if (!buckets.has(v.team_id)) buckets.set(v.team_id, []);
    buckets.get(v.team_id).push(v.score);
  }
  const out = {};
  for (const [teamId, scores] of buckets) {
    out[teamId] = {
      count: scores.length,
      sum: scores.reduce((a, b) => a + b, 0),
      mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    };
  }
  return out;
}

export function getTiebreakRoundState({ db, roundId }) {
  const round = getTiebreakRound(db, roundId);
  if (!round) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  const votes = listTiebreakVotes(db, roundId);
  return { round, votes, tallies: tally(votes) };
}

/** 关闭轮次（幂等：已关闭则原样返回） */
export function closeTiebreakRound({ db, roundId, actorId, now }) {
  const existing = getTiebreakRound(db, roundId);
  if (!existing) throw fail(404, 'TIEBREAK_ROUND_NOT_FOUND', '加时陈述轮次不存在');
  const round = existing.status === 'closed' ? existing : closeTiebreakRoundRow(db, roundId, now);
  const votes = listTiebreakVotes(db, roundId);
  writeAuditLog(db, {
    actorId, action: 'tiebreak.close', entity: 'stage', entityId: round.stage_id,
    detail: { roundId, votes: votes.length }, now,
  });
  return { round, tallies: tally(votes) };
}

/**
 * 加时陈述复议分（供 P3 的破同分链 tiebreak_extra 项消费）
 *
 * ⛔ **只消费已关闭的轮次** —— 还在开放投票的轮次，其当前均值不是最终复议分，
 *    榜单不能随着投票进行而漂移。
 */
export function getTiebreakExtraScores({ db, stageId, teamIds = [] }) {
  const rounds = listTiebreakRounds(db, { stageId, status: 'closed' });
  const scores = {};
  for (const round of rounds) {
    const votes = listTiebreakVotes(db, round.id);
    const t = tally(votes);
    for (const [teamId, bucket] of Object.entries(t)) {
      if (teamIds.length && !teamIds.includes(teamId)) continue;
      // 同一队多轮取最新一轮（轮次列表已按 created_at, rowid 确定排序）
      scores[teamId] = bucket.mean;
    }
  }
  return scores;
}

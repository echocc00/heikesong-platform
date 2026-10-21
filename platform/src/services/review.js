// src/services/review.js — 评审提交类用例
//
// 依据：INTERFACES.md §3 服务层 + S7 §3.1 / §4.3 + S10 §0.4。
//   幂等：同一 request_id 重复提交只生效一次（⛔ 不用「先查再插」判断重复灌分，
//         唯一约束在数据库层；这里只对 request_id 做幂等短路）。
//   增量：写 stage_reviews 后增量更新 score_stats（n / mean / sum_sq），
//         stdev 由 sum_sq 现算 —— 避免每次发榜全表重算（成本随评委数×队伍数相乘增长）。
//   ⛔ 但每次发榜仍会做一次全量重算并落快照（可复算要求能从原始数据重放）。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 6 处修正，读代码前先看这段】
//   ① **「先抢键」与「写数据」必须同事务**：原来抢键成功后写数据失败（如评委被回避 → 403），
//      键已经占住 → 客户端用同一个 requestId 重试会被判成「重复请求」，
//      返回 `submitted: 0` —— **评委以为提交成功了，实际一条都没落库**。
//      现在「抢键 + 写数据 + 更新统计 + 审计」在**一个事务**里，要么全成要么全回滚。
//   ② **同一个 requestId 被用于不同内容 → 409 响亮报错**（原来静默继续写）。
//      幂等的含义是「同一个 requestId 只生效一次」；若内容变了，那是**客户端复用 requestId**
//      的 bug —— 静默写进去会让「这个 request 到底写了什么」永远说不清。
//   ③ **分数没有 0–100 区间校验** → 评委提交 1000 分会污染 score_stats 与后续归一化。
//      与 Task 4 的企业确认分同类。
//   ④ **评分进度把「已有打分记录」当成「应评队伍」** —— 某个队**完全没人打分**时，
//      它根本不在名单里 → 进度显示 100% 而实际有队没被评。必须用赛段真实队伍名册。
//   ⑤ **赛段不存在 → 外键原文漏到调用方**。现在先校验 → 404。
//   ⑥ **互评的幂等键主体不能从 items 推导**（原来用 fromTeams.join('+')）——
//      items 变了主体也变 → 键抢不到自己 → 幂等被绕过。现在主体是提交方，
//      并用「同 requestId 内容比对」兜住复用。
import {
  findReviewsByRequestId,
  findReview,
  insertReview,
  updateReviewScore,
  listReviews,
  listReviewCells,
  insertCalibration,
  applyScoreStatDelta,
} from '../db/repo/reviews.js';
import { listStageJudges, getStageJudge, getStage, listStageTeams } from '../db/repo/stages.js';
import { claimRequestKey } from '../db/repo/request-keys.js';
import { insertEnterpriseConfirmation, listEnterpriseConfirmations } from '../db/repo/enterprise-confirmations.js';
import { findPeerReviewsByRequestId, findPeerReview, insertPeerReview, updatePeerReviewScore } from '../db/repo/peer-reviews.js';
import { findSelfReviewsByRequestId, findSelfReview, insertSelfReview, updateSelfReviewScore } from '../db/repo/self-reviews.js';
import { insertRecusal, listRecusals } from '../db/repo/recusals.js';
import { writeAuditLog } from '../audit/log.js';
import { checkRecusal, checkPeerEligibility } from '../domain/review-eligibility.js';
import { appError } from '../errors.js';

function fail(status, code, message, detail) {
  // ⚠️ 必须用 P0 的 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    P0 终审 I-C 的错误分支是 `err instanceof AppError ? err.message : '请求无效'` ——
  //    裸 Error 不是 AppError → message 被替换成通用文案「请求无效」，
  //    计划里想给用户看的中文文案会被**吞掉**。
  return appError(status, code, message, detail || undefined);
}

/**
 * 单事务执行：要么全成功，要么全回滚。
 * ⛔ 用 `BEGIN IMMEDIATE`（不是默认的 DEFERRED）：立即取写锁，
 *    避免「抢键」与「写数据」之间被另一个连接插进来。
 */
function inTransaction(db, fn) {
  const nested = db.isTransaction === true;
  if (!nested) db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    if (!nested) db.exec('COMMIT');
    return out;
  } catch (err) {
    if (!nested) db.exec('ROLLBACK');
    throw err;
  }
}

/** 同一 requestId 被用于**不同内容** → 409（响亮报错，不静默继续写） */
function assertSameRequestContent({ prior, currentKeys, label }) {
  const priorKeys = [...new Set(prior.map((p) => p.key))].sort();
  const cur = [...new Set(currentKeys)].sort();
  if (priorKeys.length !== cur.length || priorKeys.some((k, i) => k !== cur[i])) {
    throw fail(
      409,
      'REQUEST_ID_REUSED',
      `同一个 requestId 被用于了不同的${label}内容 —— 每次提交必须使用唯一的 requestId`,
    );
  }
}

/** 分数必须在 0–100（否则会污染 score_stats 与后续归一化） */
function assertScoreInRange(score, label) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw fail(400, 'SCORE_OUT_OF_RANGE', `${label}必须是 0–100 之间的数字`, { score });
  }
  return score;
}

function assertStageExists(db, stageId) {
  if (!getStage(db, stageId)) {
    throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  }
}

/**
 * 队伍必须在本赛段名册内。
 * ⚠️ 父代理预审修正（Important，I1 / I5）：
 *   ① 原来写入口**不校验队伍** → 评委能给**别的届期**的队打分，
 *      那支队会被算进本赛段榜单（外队进榜）。
 *   ② 队伍不存在时直接撞外键 → `FOREIGN KEY constraint failed` 漏到 HTTP 层
 *      → **500**（而不是三态状态码要求的 404）。
 * 现在统一按「本赛段名册」判定，不在册 → 404。
 * ⚠️ 名册的粒度目前是**届期级**（stages → edition_id → teams），
 *    赛段级队伍边界需要一张 stage_team 表 —— 登记在 P3（见 P2 计划「已知限制」）。
 */
function assertTeamInStage(db, stageId, teamId, label = '队伍') {
  if (!teamId) {
    throw fail(400, 'MISSING_TEAM_ID', `缺少${label}`);
  }
  const roster = listStageTeams(db, stageId).map((t) => t.teamId);
  if (!roster.includes(teamId)) {
    throw fail(404, 'TEAM_NOT_IN_STAGE', `${label} ${teamId} 不在本赛段名册内`);
  }
}

function assertVotingJudge(db, stageId, judgeId) {
  const seat = getStageJudge(db, stageId, judgeId);
  if (!seat) throw fail(403, 'NOT_ASSIGNED_JUDGE', '该评委未被分配到本赛段');
  if (seat.seat === 'observer') {
    // R-JDG-11：观察员无投票权
    throw fail(403, 'OBSERVER_NO_VOTE', '观察员无投票权，不能提交评分');
  }
  return seat;
}

function assertNotRecused(db, stageId, judgeId, teamId) {
  const records = listRecusals(db, { stageId, judgeId });
  const check = checkRecusal({ judge: { userId: judgeId }, team: { teamId }, recusalRecords: records });
  if (check.recused) {
    throw fail(403, 'RECUSED', `该评委已回避本队（原因：${check.record?.reason ?? '未填写'}）`);
  }
}

/**
 * 提交评委打分（幂等 + 增量 score_stats）。
 * @param {object} input
 * @param {Array} input.items [{ teamId, dimension, rawScore }]
 */
export function submitReviews({ db, stageId, judgeId, items = [], requestId = null, now }) {
  assertStageExists(db, stageId);
  assertVotingJudge(db, stageId, judgeId);
  // 队伍必须在本赛段名册内（外队进榜 / 不存在 → 404）
  for (const item of items) {
    assertTeamInStage(db, stageId, item.teamId);
  }

  // 幂等快速路径：同一次请求已经生效过 → 直接返回上次结果，不重复落数据
  if (requestId) {
    const prior = findReviewsByRequestId(db, { stageId, judgeId, requestId });
    if (prior.length) {
      assertSameRequestContent({
        prior: prior.map((r) => ({ key: `${r.team_id}::${r.dimension}` })),
        currentKeys: items.map((i) => `${i.teamId}::${i.dimension}`),
        label: '评分',
      });
      return { stageId, judgeId, requestId, submitted: 0, items: prior };
    }
  }

  return inTransaction(db, () => {
    // 抢键：抢不到 = 同一次请求已被另一次并发提交处理 → 幂等短路
    if (requestId) {
      const claimed = claimRequestKey(db, { scope: 'review', stageId, subjectId: judgeId, requestId, now });
      if (!claimed) {
        const prior = findReviewsByRequestId(db, { stageId, judgeId, requestId });
        assertSameRequestContent({
          prior: prior.map((r) => ({ key: `${r.team_id}::${r.dimension}` })),
          currentKeys: items.map((i) => `${i.teamId}::${i.dimension}`),
          label: '评分',
        });
        return { stageId, judgeId, requestId, submitted: 0, items: prior };
      }
    }

    const written = [];
    // 改分留痕：旧分与新分一起进审计（父代理预审 Minor 7）
    // ⚠️ 原来只记「条数」—— 评委改分后，**当时榜单用的是几分**再也还原不出来。
    const changed = [];
    // 按维度分桶的增量（新增分 / 被改分替换掉的旧分）——score_stats 必须同步修正
    const byDimension = new Map();
    const bucketOf = (dimension) => {
      if (!byDimension.has(dimension)) byDimension.set(dimension, { added: [], removed: [] });
      return byDimension.get(dimension);
    };

    for (const item of items) {
      assertNotRecused(db, stageId, judgeId, item.teamId);
      assertScoreInRange(item.rawScore, '评委打分');
      const bucket = bucketOf(item.dimension);
      const existing = findReview(db, { stageId, judgeId, teamId: item.teamId, dimension: item.dimension });
      if (existing) {
        // 改分：覆盖写并同步修正统计量（n 不变，mean/sum_sq 修正）
        updateReviewScore(db, { id: existing.id, rawScore: item.rawScore, now });
        bucket.removed.push(existing.raw_score);
        bucket.added.push(item.rawScore);
        changed.push({ teamId: item.teamId, dimension: item.dimension, from: existing.raw_score, to: item.rawScore });
      } else {
        const row = insertReview(db, {
          stageId, judgeId, teamId: item.teamId, dimension: item.dimension,
          rawScore: item.rawScore, requestId, calibrated: 0, now,
        });
        written.push(row);
        bucket.added.push(item.rawScore);
      }
    }

    // 增量更新 score_stats（stdev 由 sum_sq 现算）
    for (const [dimension, bucket] of byDimension) {
      applyScoreStatDelta(db, { judgeId, dimension, added: bucket.added, removed: bucket.removed, now });
    }

    writeAuditLog(db, {
      actorId: judgeId, action: 'review.submit', entity: 'stage', entityId: stageId,
      detail: { requestId, count: items.length, changed }, now,
    });

    return { stageId, judgeId, requestId, submitted: written.length, items: written };
  });
}

/**
 * 评分进度：已交 / 应交 / 缺谁 / 维度进度
 *
 * ⚠️ **应交队伍必须来自赛段真实名册**（`listStageTeams`），
 *    而不是「已有打分记录里出现过的队伍」—— 后者会让「完全没人打分的队」从名单里消失，
 *    进度显示 100% 而实际有队没被评。
 * ⚠️ **维度列表**默认取「已出现过的维度」；调用方（Task 8 的 API 层）可以传
 *    `dimensions` 显式指定规则里的维度全集，否则「从未有人评过的维度」不会出现在进度里。
 */
export function getReviewState({ db, stageId, viewer, dimensions = null }) {
  assertStageExists(db, stageId);
  const seat = viewer?.userId ? getStageJudge(db, stageId, viewer.userId) : null;
  const isAdmin = viewer?.isAdmin === true;
  const all = listReviews(db, { stageId });
  const cells = listReviewCells(db, stageId);
  const observedTeams = [...new Set(cells.map((c) => c.team_id))].sort();
  const observedDimensions = [...new Set(cells.map((c) => c.dimension))].sort();
  // 赛段真实名册；名册为空时退回已出现的队伍（赛段还没建队的情况）
  const roster = listStageTeams(db, stageId).map((t) => t.teamId);
  const teams = roster.length ? roster : observedTeams;
  const dimList = Array.isArray(dimensions) && dimensions.length ? [...dimensions].sort() : observedDimensions;
  const judges = listStageJudges(db, stageId).filter((j) => j.seat !== 'observer');

  const dimensionProgress = {};
  for (const dim of dimList) {
    const total = isAdmin ? judges.length * teams.length : teams.length;
    const submitted = all.filter((r) => r.dimension === dim && (isAdmin || r.judge_id === viewer.userId)).length;
    dimensionProgress[dim] = { submitted, total };
  }

  const missing = [];
  if (isAdmin) {
    for (const j of judges) {
      for (const t of teams) {
        for (const dim of dimList) {
          const hit = all.find((r) => r.judge_id === j.user_id && r.team_id === t && r.dimension === dim);
          if (!hit) missing.push({ judgeId: j.user_id, teamId: t, dimension: dim });
        }
      }
    }
  } else if (seat) {
    for (const t of teams) {
      for (const dim of dimList) {
        const hit = all.find((r) => r.judge_id === viewer.userId && r.team_id === t && r.dimension === dim);
        if (!hit) missing.push({ teamId: t, dimension: dim });
      }
    }
  }

  const submitted = isAdmin ? all.length : all.filter((r) => r.judge_id === viewer?.userId).length;
  const total = isAdmin ? judges.length * teams.length * dimList.length : teams.length * dimList.length;
  return { submitted, total, missing, dimensionProgress };
}

/** 校准打分（R-JDG-12）：写 calibrations，【不计入评分】 */
export function submitCalibration({ db, stageId, judgeId, items = [], now }) {
  assertStageExists(db, stageId);
  assertVotingJudge(db, stageId, judgeId);
  return inTransaction(db, () => {
    for (const item of items) {
      assertScoreInRange(item.rawScore, '校准打分');
      insertCalibration(db, { stageId, judgeId, dimension: item.dimension, rawScore: item.rawScore, now });
    }
    writeAuditLog(db, {
      actorId: judgeId, action: 'review.calibrate', entity: 'stage', entityId: stageId,
      detail: { count: items.length }, now,
    });
    return { stageId, judgeId, submitted: items.length };
  });
}

/** 企业确认（R2 双签 + R-JDG-14 签字必须有内容） */
export function submitEnterpriseConfirmation({ db, stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId = null, signatoryUserId = null, content = '', now }) {
  // R-JDG-14：空白签字不予采信
  if (!content || !String(content).trim()) {
    throw fail(400, 'SIGNATURE_CONTENT_REQUIRED', '企业签字必须填写内容（解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色）');
  }
  assertScoreInRange(rawScore, '企业确认分');
  assertTeamInStage(db, stageId, teamId);
  const row = insertEnterpriseConfirmation(db, {
    stageId, teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content, now,
  });
  writeAuditLog(db, {
    actorId: signatoryUserId, action: 'enterprise.confirm', entity: 'team', entityId: teamId,
    detail: { stageId, dimension, rawScore, hasCrossJudge: !!crossJudgeId }, now,
  });
  return row;
}

/**
 * 互评（幂等；资格由 checkPeerEligibility 把关）
 *
 * ⚠️ 幂等键的 `subjectId` 用**提交方**（actorId），⛔ 不用 items 推导 ——
 *    items 变了主体也变 → 键抢不到自己 → 幂等被绕过。
 *    主体退化成 '*' 时（没有 actorId），靠「同 requestId 内容比对」兜住复用。
 */
export function submitPeerReviews({ db, stageId, items = [], requestId = null, actorId = null, now }) {
  assertStageExists(db, stageId);
  const subject = actorId ?? '*';
  // 互评的两端都必须是本赛段名册内的队伍（外队 / 不存在 → 404）
  for (const item of items) {
    assertTeamInStage(db, stageId, item.fromTeamId, '发起队');
    assertTeamInStage(db, stageId, item.toTeamId, '被评队');
  }

  if (requestId) {
    const prior = findPeerReviewsByRequestId(db, { stageId, requestId });
    if (prior.length) {
      assertSameRequestContent({
        prior: prior.map((r) => ({ key: `${r.from_team_id}->${r.to_team_id}` })),
        currentKeys: items.map((i) => `${i.fromTeamId}->${i.toTeamId}`),
        label: '互评',
      });
      return { stageId, submitted: 0, items: prior };
    }
  }

  return inTransaction(db, () => {
    if (requestId) {
      const claimed = claimRequestKey(db, { scope: 'peer_review', stageId, subjectId: subject, requestId, now });
      if (!claimed) {
        const prior = findPeerReviewsByRequestId(db, { stageId, requestId });
        assertSameRequestContent({
          prior: prior.map((r) => ({ key: `${r.from_team_id}->${r.to_team_id}` })),
          currentKeys: items.map((i) => `${i.fromTeamId}->${i.toTeamId}`),
          label: '互评',
        });
        return { stageId, submitted: 0, items: prior };
      }
    }

    // R-RNK-07：只对该赛段有真实交付物的队伍开放互评
    // P2 阶段以「该赛段已有评委打分记录」作为「有真实交付物」的判据；
    // P5 的任务清单落地后改为按交付物表判定（改这一处即可）。
    const scoredTeams = [...new Set(listReviews(db, { stageId }).map((r) => r.team_id))].sort();
    const eligibility = checkPeerEligibility({
      teams: scoredTeams.map((teamId) => ({ teamId })),
      deliverables: scoredTeams.map((teamId) => ({ teamId, hasRealDeliverable: true })),
    });
    const eligible = new Set(eligibility.eligible);

    const written = [];
    for (const item of items) {
      if (item.fromTeamId === item.toTeamId) {
        throw fail(400, 'SELF_PEER_REVIEW', '不能给自己互评');
      }
      if (!eligible.has(item.fromTeamId) || !eligible.has(item.toTeamId)) {
        throw fail(403, 'PEER_REVIEW_INELIGIBLE', '只有该赛段有真实交付物的队伍可参与互评');
      }
      assertScoreInRange(item.score, '互评分');
      const existing = findPeerReview(db, { stageId, fromTeamId: item.fromTeamId, toTeamId: item.toTeamId });
      if (existing) {
        updatePeerReviewScore(db, { id: existing.id, score: item.score, now });
        written.push(existing);
      } else {
        written.push(insertPeerReview(db, {
          stageId, fromTeamId: item.fromTeamId, toTeamId: item.toTeamId, score: item.score, requestId, now,
        }));
      }
    }

    writeAuditLog(db, {
      actorId, action: 'peer_review.submit', entity: 'stage', entityId: stageId,
      detail: { requestId, count: items.length }, now,
    });
    return { stageId, submitted: written.length, items: written };
  });
}

/** 自评测（幂等） */
export function submitSelfReviews({ db, stageId, teamId, items = [], requestId = null, now }) {
  assertStageExists(db, stageId);
  assertTeamInStage(db, stageId, teamId);
  if (requestId) {
    const prior = findSelfReviewsByRequestId(db, { stageId, teamId, requestId });
    if (prior.length) {
      assertSameRequestContent({
        prior: prior.map((r) => ({ key: r.dimension })),
        currentKeys: items.map((i) => i.dimension),
        label: '自评',
      });
      return { stageId, teamId, submitted: 0, items: prior };
    }
  }
  return inTransaction(db, () => {
    if (requestId) {
      const claimed = claimRequestKey(db, { scope: 'self_review', stageId, subjectId: teamId, requestId, now });
      if (!claimed) {
        const prior = findSelfReviewsByRequestId(db, { stageId, teamId, requestId });
        assertSameRequestContent({
          prior: prior.map((r) => ({ key: r.dimension })),
          currentKeys: items.map((i) => i.dimension),
          label: '自评',
        });
        return { stageId, teamId, submitted: 0, items: prior };
      }
    }
    const written = [];
    for (const item of items) {
      assertScoreInRange(item.rawScore, '自评分');
      const existing = findSelfReview(db, { stageId, teamId, dimension: item.dimension });
      if (existing) {
        updateSelfReviewScore(db, { id: existing.id, rawScore: item.rawScore, now });
        written.push(existing);
      } else {
        written.push(insertSelfReview(db, {
          stageId, teamId, dimension: item.dimension, rawScore: item.rawScore, requestId, now,
        }));
      }
    }
    writeAuditLog(db, {
      actorId: null, action: 'self_review.submit', entity: 'team', entityId: teamId,
      detail: { requestId, count: items.length }, now,
    });
    return { stageId, teamId, submitted: written.length, items: written };
  });
}

/** 回避申报（R-JDG-09）：必须留档 */
/**
 * 撤销回避（R-JDG-09 的「撤销」语义；终审修正 M-4 补上写路径）。
 *
 * ⛔ 领域层 `checkRecusal` 取**最后一条**记录，`action='reinstated'` 覆盖前面的 `'recused'` ——
 *    所以撤销的实现是**再写一条**记录，而不是 UPDATE 前一条（记录只增不改，可复算）。
 * ⚠️ 撤销必须与申报**同一队伍范围**（stage 级回避的 team_id 为 null）——
 *    否则「赛段级回避」会被一支队的撤销记录意外盖掉。
 */
export function reinstateRecusal({ db, stageId, judgeId, teamId = null, reason, actorId = null, now }) {
  assertStageExists(db, stageId);
  if (!reason || !String(reason).trim()) {
    throw fail(400, 'RECUSAL_REASON_REQUIRED', '撤销回避必须填写原因（误报 / 利益关系已澄清 / 其他）');
  }
  if (!getStageJudge(db, stageId, judgeId)) {
    throw fail(404, 'JUDGE_NOT_ASSIGNED', '该评委未被分配到本赛段');
  }
  const scoped = listRecusals(db, { stageId, judgeId })
    .filter((r) => (r.team_id ?? null) === (teamId ?? null));
  const latest = scoped.length ? scoped[scoped.length - 1] : null;
  if (!latest) {
    throw fail(404, 'RECUSAL_NOT_FOUND', '没有找到可撤销的回避记录');
  }
  if (latest.action !== 'recused') {
    throw fail(409, 'RECUSAL_NOT_ACTIVE', '该回避已经被撤销过了');
  }
  const row = insertRecusal(db, {
    stageId, judgeId, teamId, reason, source: 'reinstated', auditBy: actorId, action: 'reinstated', now,
  });
  writeAuditLog(db, {
    actorId, action: 'recusal.reinstate', entity: 'stage', entityId: stageId,
    detail: { judgeId, teamId, reason, supersedes: latest.id }, now,
  });
  return row;
}

export function declareRecusal({ db, stageId, judgeId, teamId = null, reason, actorId = null, now }) {
  assertStageExists(db, stageId);
  if (!reason || !String(reason).trim()) {
    throw fail(400, 'RECUSAL_REASON_REQUIRED', '回避必须填写原因（供应方 / 投资方 / 前雇主）');
  }
  if (teamId != null) {
    assertTeamInStage(db, stageId, teamId);
  }
  const row = insertRecusal(db, {
    stageId, judgeId, teamId, reason, source: 'declared', auditBy: actorId, action: 'recused', now,
  });
  writeAuditLog(db, {
    actorId: actorId ?? judgeId, action: 'recusal.declare', entity: 'stage', entityId: stageId,
    detail: { judgeId, teamId, reason }, now,
  });
  return row;
}

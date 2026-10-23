// src/services/review.js — 评审提交类用例 + 评审读口
//
// 依据：INTERFACES.md §3 服务层 + S7 §3.1 / §4.3 + S10 §0.4。
//   幂等：同一 request_id 重复提交只生效一次（⛔ 不用「先查再插」判断重复灌分，
//         唯一约束在数据库层；这里只对 request_id 做幂等短路）。
//   增量：写 stage_reviews 后增量更新 score_stats（n / mean / sum_sq），
//         stdev 由 sum_sq 现算 —— 避免每次发榜全表重算（成本随评委数×队伍数相乘增长）。
//   ⛔ 但每次发榜仍会做一次全量重算并落快照（可复算要求能从原始数据重放）。
//
// ⚠️ **读口也在这一层**（P10 补齐）：`getReviewBoard`（评审工作台，附带
//    `myPeerReviews` / `mySelfReviews` / `myCalibrations`）与 `getRecusalLedger`
//    （回避台账）—— ⛔ 可见性一律在**服务层（= API 层）**裁决，
//    前端拿到的就已经是「该给他看的」（全局约束：前端隐藏 = 数据已泄露）。
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
  listCalibrationsForJudge,
  applyScoreStatDelta,
} from '../db/repo/reviews.js';
import { listStageJudges, getStageJudge, getStage, listStageTeams, listStageTeamRows } from '../db/repo/stages.js';
import { hasStageRoster, listStageTeamIds } from '../db/repo/stage-teams.js';
import { claimRequestKey } from '../db/repo/request-keys.js';
import {
  insertEnterpriseConfirmation,
  listEnterpriseConfirmations,
  getEnterpriseConfirmationById,
  findActiveEnterpriseConfirmation,
  softDeleteEnterpriseConfirmation,
} from '../db/repo/enterprise-confirmations.js';
import {
  findPeerReviewsByRequestId,
  findPeerReview,
  insertPeerReview,
  updatePeerReviewScore,
  listPeerReviewsForViewer,
} from '../db/repo/peer-reviews.js';
import {
  findSelfReviewsByRequestId,
  findSelfReview,
  insertSelfReview,
  updateSelfReviewScore,
  listSelfReviewsForViewer,
} from '../db/repo/self-reviews.js';
import { insertRecusal, listRecusals, listRecusalViews } from '../db/repo/recusals.js';
import { getUserById } from '../db/repo/users.js';
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
 *
 * ⛔⛔ **P11 · E156：名册粒度改为「赛段级优先、届期级兜底」**
 *   原来这里用的是**届期级**名册（`listStageTeams` = 同届期的所有队）
 *   ⇒ **同届期另一赛段的队伍照样能被写进本赛段**（外队进榜）。
 *   `stage_team` 表（P3 建、P11 · W5 才有写入方）就是为关这个闸门而存在的，
 *   但它此前**只写不读**（`hasStageRoster` 在生产上零调用方）。
 *   现在按 P3 计划偏差表 3c 的口径实现：
 *     · **赛段级名册有数据** ⇒ 以它为准（外队进榜被挡住）；
 *     · **赛段级名册为空**（赛段刚建、还没报名册）⇒ 回落到届期级
 *       （否则会把所有评分都拒掉 —— 那是「全死」，比外队进榜更糟）。
 */
function assertTeamInStage(db, stageId, teamId, label = '队伍') {
  if (!teamId) {
    throw fail(400, 'MISSING_TEAM_ID', `缺少${label}`);
  }
  const roster = resolveStageRoster(db, stageId);
  if (!roster.includes(teamId)) {
    throw fail(404, 'TEAM_NOT_IN_STAGE', `${label} ${teamId} 不在本赛段名册内`);
  }
}

/**
 * 解析「本赛段名册」（P11 · E156 抽出来的**唯一入口**）。
 *
 * ⚠️ **必须走这个函数，不要再直接调 `listStageTeams`** ——
 *    直接调 = 届期级口径 = 外队进榜的闸门没关上。
 *    （P3 计划偏差表 3c：名册有数据时优先赛段级、否则回落到届期级。）
 *
 * @returns {string[]} 本赛段可写的队伍 id 列表
 */
export function resolveStageRoster(db, stageId) {
  // 赛段级名册有登记 ⇒ 以它为准（**外队进榜在这里被挡住**）
  if (hasStageRoster(db, stageId)) {
    return listStageTeamIds(db, stageId);
  }
  // 没有登记 ⇒ 回落到届期级（赛段刚建、名册还没录 ⇒ 不能把评分全拒了）
  return listStageTeams(db, stageId).map((t) => t.teamId);
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
  // 赛段真实名册（P11 · E156：赛段级优先、届期级兜底）；名册为空时退回已出现的队伍（赛段还没建队的情况）
  const roster = resolveStageRoster(db, stageId);
  const teams = roster.length ? roster : observedTeams;
  const dimList = Array.isArray(dimensions) && dimensions.length ? [...dimensions].sort() : observedDimensions;
  const judges = listStageJudges(db, stageId).filter((j) => j.seat !== 'observer');

  // ⛔ P9.1 修正（真机复验抓出）：**有投票权的席位数**必须同时决定 `total` 与 `dimensionProgress`。
  //    原来非评委视角的 `total` 照算「队伍数 × 维度数」，可 `missing` 只在下面
  //    `else if (seat)` 分支里填 ⇒ **没有本赛段席位**的账号拿到
  //    `{submitted: 0, total: 20, missing: []}` —— 三个数自相矛盾：
  //    前端据此把「missing 为空」当成「都交了」，于是同一屏上
  //    「0 我的已交 / 应交 20 格 / 完成度 0%」与「本赛段的评分都交了」并排出现。
  //    口径：**没有席位 ⇒ 这个人在这个赛段没有任何属于他的格子 ⇒ total 必须是 0**。
  //    （写路径本来就被 `assertVotingJudge` 挡住 —— 这里是让「读到的数」与「写得到的」一致。）
  const seatCount = isAdmin ? judges.length : (seat ? 1 : 0);

  const dimensionProgress = {};
  for (const dim of dimList) {
    const total = seatCount * teams.length;
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
  const total = seatCount * teams.length * dimList.length;
  return { submitted, total, missing, dimensionProgress };
}

/**
 * 评审工作台（**只读**）：一次拿齐前端拼评分表单要的三样东西。
 *
 * ⚠️ 为什么需要这个函数（P8）：
 *   前端要显示「本赛段有哪些队伍 + 有哪些可打分维度 + 我已经给了多少分」，
 *   而这三样东西原先**分散在三个地方，且都没有对外读口**：
 *     名册   → listStageTeams（仓储层，且**只有 teamId、没有队名**）
 *     维度   → rules.scoring[stage.scoring_config_key].dimensions（规则文件）
 *     我的分 → stage_reviews（**没有任何读端点**）
 *   ⇒ 前端要么拼三个请求（慢），更要命的是**三个口径会各自漂移**
 *      （名册口径与维度口径不在一处 ⇒ 前端拼出来的表可能自相矛盾）。
 *
 * ⛔ **只返回本人的分**（`myScores`）：改分要回填本人已给的分；
 *    别人的分不该出现在评审页上（全局可见性由 filterVisibleScores 管，本页不需要那份全局数组）。
 */
export function getReviewBoard({ db, stageId, viewer, rules = null }) {
  const stage = getStage(db, stageId);
  if (!stage) throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const config = rules?.scoring?.[stage.scoring_config_key];
  if (!config) {
    throw fail(500, 'SCORING_CONFIG_MISSING', `赛段 ${stageId} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  }
  const dimensions = (config.dimensions ?? []).map((d) => ({
    key: d.key,
    name: d.name,
    weight: d.weight,
    seat: d.seat,
  }));
  // 评委只能给**评委席**维度打分（与 POST /reviews 的维度白名单同一口径）
  const judgeDimensions = dimensions.filter((d) => d.seat === 'judge');
  const teams = listStageTeamRows(db, stageId);
  const myScores = listReviews(db, { stageId, judgeId: viewer?.userId ?? null })
    .map((r) => ({ teamId: r.team_id, dimension: r.dimension, rawScore: r.raw_score }));
  // ── 【P10 评委前置】三个「我已经交过哪些」 ──────────────────────────────
  // ⚠️ **同族口径**：`myScores` 只返回本人 ⇒ 这三个字段也**只返回当前 viewer 自己的**。
  //    ⛔ **组委会也只看自己的**（不实现「看全部」）——
  //    「看全部」要额外判定（谁能看别人的互评/自评？评委能看同赛段其他评委的？
  //    答案必须是「不能」）⇒ 一律不做，避免出现「有的页面看得到、有的看不到」的漂移。
  //    若将来要放开，必须**同时**放开 `myScores` 并写清口径（否则评审页会出现两套口径）。
  //
  // ⚠️ **三者的「我的」含义各不相同**（与各自的写入口对齐）：
  //   myPeerReviews  互评是「队 → 队」的行为 ⇒ 「我的」= **我参与的那些队**发起的互评
  //                  （写入口：提交者必须是发起队的在册成员）
  //   mySelfReviews  自评是**队伍**行为（R-JDG-13 不加分）⇒ 「我的」= **我参与的队**的自评
  //                  （写入口：只能由本队成员提交）
  //   myCalibrations 校准是**评委个人**行为（R-JDG-12 对齐宽严尺度）⇒ 「我的」= judge_id = 自己
  const viewerUserId = viewer?.userId ?? null;
  const myPeerReviews = listPeerReviewsForViewer(db, { stageId, userId: viewerUserId })
    .map((r) => ({ fromTeamId: r.fromTeamId, toTeamId: r.toTeamId, score: r.score }));
  const mySelfReviews = listSelfReviewsForViewer(db, { stageId, userId: viewerUserId })
    .map((r) => ({ teamId: r.teamId, dimension: r.dimension, rawScore: r.rawScore }));
  const myCalibrations = listCalibrationsForJudge(db, { stageId, judgeId: viewerUserId })
    .map((r) => ({ dimension: r.dimension, rawScore: r.rawScore }));
  const progress = getReviewState({
    db,
    stageId,
    viewer: { userId: viewer?.userId ?? null, isAdmin: viewer?.isAdmin === true },
    dimensions: judgeDimensions.map((d) => d.key),
  });
  return {
    stage: {
      id: stage.id,
      key: stage.key,
      name: stage.name,
      kind: stage.kind,
      status: stage.status,
      scoringConfigKey: stage.scoring_config_key,
    },
    dimensions,
    judgeDimensions,
    teams,
    myScores,
    // ⚠️ 【P10 评委前置】三个「我已经交过哪些」——**只含当前 viewer 自己的**（同 myScores 口径）。
    myPeerReviews,
    mySelfReviews,
    myCalibrations,
    // ⚠️ **scope 必须带上**（P8 DP-99）：getReviewState 对两种身份返回的是**两套口径** ——
    //    组委会 = 全赛段（已交 N 格 / 缺了谁的哪一格），评委 = 只看自己（我还差几格）。
    //    前端拿到同一个 {submitted,total,missing} 却不知道是哪套口径 ⇒
    //    标签必然有一半是错的（这正是 P7 的 B1「数字与标签对不上」的同款事故）。
    progress: { ...progress, scope: viewer?.isAdmin === true ? 'stage' : 'mine' },
  };
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
  // ⚠️ **F9（Medium，2026-10-23 审计 §3.4「写端点错误语义不一致」）**：
  //    `enterprise_confirmations.enterprise_id` 与 `signatory_user_id` 都是
  //    `REFERENCES users(id)` 的外键 —— 原来**直接 INSERT**，让外键约束去兜底 ⇒
  //    引用一个不存在的出题企业时，数据库抛 `FOREIGN KEY constraint failed`
  //    ⇒ HTTP 层只能回 **500**（外键错误没有映射到 4xx），
  //    客户端分不清「你填错了企业 id」和「服务端坏了」。
  //    ⇒ 与 `services/workflow.js` 的 `createWorkflow`（先查 edition / taskPackage ⇒ 404）、
  //      `services/taskPackage.js` 的 `submitTaskPackage`（先查届期 ⇒ 404）**逐字同源**：
  //      业务层先判外键目标的存在性 ⇒ 404（资源不存在），而不是让约束错误冒到 HTTP 层。
  //    ⚠️ 错误码沿用全仓既有命名 `USER_NOT_FOUND`（与 `services/stage.js` 派评委时同款）。
  if (!getUserById(db, enterpriseId)) {
    throw fail(404, 'USER_NOT_FOUND', '用户不存在', { userId: enterpriseId });
  }
  assertTeamInStage(db, stageId, teamId);
  // ⛔ P11 · E148②：同格重签原来直接撞唯一索引 `idx_enterprise_confirmations_cell`
  //    → SQLite 抛 UNIQUE constraint → **HTTP 500「服务内部错误」**（违反设计文档 §7.3 的三态口径）。
  //    现在先查同格是否已有**未撤回**的确认 ⇒ 明确报 409，并告诉客户端「要改请走改签」。
  const existing = findActiveEnterpriseConfirmation(db, { stageId, teamId, dimension, enterpriseId });
  if (existing) {
    throw fail(409, 'CONFIRMATION_EXISTS',
      '该队伍在该维度已有企业确认（同一格只能有一条）。要更正请用「改签」，要撤销请用「撤回」。',
      { confirmationId: existing.id });
  }
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
 * ⛔ P11 · E141：**撤回企业确认**（逆向路径）。
 *
 * ⚠️ **为什么必须有它**（E141 实测）：
 *   企业确认一旦落库就**没有任何改动的途径** ⇒
 *   ① 签错了（内容写错 / 分数写错）只能永远错下去；
 *   ② **缺跨领域评委签字**（R2 双签只签了一半）的确认**没法补签** ⇒
 *      该队的企业席按 R2 计 0 分并挂 warning，而**产品内没有任何办法把它修好**。
 *   ⇒ 只有正向流程、没有逆向流程，是本项目这一类 bug 的共同病根。
 *
 * ⚠️ 撤回是**软删**（deleted_at）：企业确认是计分证据，事后要能查「谁在什么时候签过、后来撤了」。
 * ⚠️ 撤回**不自动重算**：计分与发榜都是显式动作（设计文档 §869），
 *    这里只把「需要重算」这件事显式告诉调用方（needsRecompute）。
 *
 * @param {object} args
 * @param {boolean} [args.isCommittee] 组委会可撤任何人的（代录与纠错都需要）
 */
export function withdrawEnterpriseConfirmation({ db, id, stageId, actorId, isCommittee = false, now }) {
  const row = getEnterpriseConfirmationById(db, id);
  // ⛔ 单条不满足 → 404（不泄露「这条曾经存在过」）
  if (!row) throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  if (stageId && row.stage_id !== stageId) {
    throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  }
  // ⛔ 权限：只有**签字的那家出题企业**本人或组委会能撤。
  //    跨领域评委**不能**撤（撤了就把人家的签字也一起撤了 —— 那不是他的权限范围）。
  if (!isCommittee && row.enterprise_id !== actorId) {
    throw fail(403, 'FORBIDDEN', '只有签字的出题企业（或组委会）可以撤回这条企业确认');
  }
  softDeleteEnterpriseConfirmation(db, id, now);
  writeAuditLog(db, {
    actorId, action: 'enterprise.confirm.withdraw', entity: 'team', entityId: row.team_id,
    detail: {
      stageId: row.stage_id, confirmationId: id, dimension: row.dimension,
      rawScore: row.raw_score, hasCrossJudge: !!row.cross_judge_id,
      reason: '企业确认被撤回（软删，证据留痕）',
    },
    now,
  });
  return {
    id, withdrawn: true, teamId: row.team_id, stageId: row.stage_id, dimension: row.dimension,
    needsRecompute: true,
    hint: '撤回已生效：该队的企业席计分已变化，请重新计算并重新发榜。',
  };
}

/**
 * ⛔ P11 · E141：**改签企业确认**（正向纠错 + R2「后补」路径）。
 *
 * ⚠️ **改签 = 软删旧行 + 追加新行**（同格），不是就地覆盖 ——
 *    企业确认是**计分证据**（INTERFACES.md §0「追加式」：只增不改，更正走新记录）。
 *    历史留在旧行的 deleted_at 与审计日志里。
 *
 * ⛔ **谁可以改什么**（三条硬边界）：
 *   ① 内容与分数 ⇒ 只有**签字的那家出题企业**本人或组委会（换内容 = 换这家企业的主张）；
 *   ② **后补跨领域签字** ⇒ 本赛段评委可以给自己补签（crossJudgeId = 自己）；
 *   ③ **撤销自己的补签** ⇒ 当前 cross_judge_id 本人可以把它清掉（不能动别人的）。
 *
 * ⚠️ 这三条同时解决了两个问题：
 *   · E148①「写端点要不要强制 crossJudgeId」—— **不强制**（R2 是计分口径，不是写入校验），
 *     改由「后补」路径补齐 ⇒ 不改变 S7 语义；
 *   · E141「缺双签恒 0 分且产品内修不了」—— 现在能补签了。
 */
export function resignEnterpriseConfirmation({
  db, id, stageId, actorId, isCommittee = false,
  rawScore = null, content = null, crossJudgeId = undefined, now,
}) {
  const row = getEnterpriseConfirmationById(db, id);
  if (!row) throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  if (stageId && row.stage_id !== stageId) {
    throw fail(404, 'CONFIRMATION_NOT_FOUND', '企业确认不存在或已被撤回');
  }
  const isEnterprise = row.enterprise_id === actorId;
  const setCross = crossJudgeId !== undefined;
  const nextCrossJudgeId = setCross ? (crossJudgeId || null) : row.cross_judge_id;
  const changes = {};

  // ① 内容 / 分数
  if (rawScore !== null || content !== null) {
    if (!isCommittee && !isEnterprise) {
      throw fail(403, 'FORBIDDEN', '只有签字的出题企业（或组委会）可以更正企业确认的内容与分数');
    }
    if (rawScore !== null) {
      assertScoreInRange(rawScore, '企业确认分');
      if (rawScore !== row.raw_score) changes.rawScore = { from: row.raw_score, to: rawScore };
    }
    if (content !== null) {
      if (!String(content).trim()) {
        throw fail(400, 'SIGNATURE_CONTENT_REQUIRED', '企业签字必须填写内容（解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色）');
      }
      if (content !== row.content) changes.content = { from: row.content, to: content };
    }
  }

  // ② 跨领域签字人
  if (setCross && nextCrossJudgeId !== row.cross_judge_id) {
    if (!isCommittee) {
      // 后补：自己给自己补签（本赛段评委）
      const isBackfill = nextCrossJudgeId === actorId;
      // 撤自己的补签：当前就是他签的
      const isSelfRevoke = nextCrossJudgeId === null && row.cross_judge_id === actorId;
      if (!isBackfill && !isSelfRevoke) {
        throw fail(403, 'FORBIDDEN', '跨领域评委只能给自己补签，或撤销自己已补的签字');
      }
    }
    if (nextCrossJudgeId) {
      if (nextCrossJudgeId === row.enterprise_id) {
        throw fail(400, 'CROSS_JUDGE_SAME_AS_SIGNATORY', '跨领域评委签字人不能与出题企业签字人相同');
      }
      if (!getStageJudge(db, row.stage_id, nextCrossJudgeId)) {
        throw fail(404, 'JUDGE_NOT_ASSIGNED', '跨领域评委不在本赛段名单内');
      }
    }
    changes.crossJudgeId = { from: row.cross_judge_id, to: nextCrossJudgeId };
  }

  if (!Object.keys(changes).length) {
    throw fail(400, 'NOTHING_TO_CHANGE', '没有要改的内容：改签必须至少变更一项（内容 / 分数 / 跨领域签字人）');
  }

  // 软删旧行 + 追加新行（同格）⇒ 唯一索引仍然只允许一条「有效」确认
  softDeleteEnterpriseConfirmation(db, id, now);
  const fresh = insertEnterpriseConfirmation(db, {
    stageId: row.stage_id,
    teamId: row.team_id,
    enterpriseId: row.enterprise_id,
    dimension: row.dimension,
    rawScore: rawScore !== null ? rawScore : row.raw_score,
    crossJudgeId: nextCrossJudgeId,
    signatoryUserId: row.signatory_user_id,
    content: content !== null ? content : row.content,
    now,
  });
  writeAuditLog(db, {
    actorId, action: 'enterprise.confirm.resign', entity: 'team', entityId: row.team_id,
    detail: {
      stageId: row.stage_id, replacedId: id, confirmationId: fresh.id, dimension: row.dimension,
      changes,
    },
    now,
  });
  return {
    ...fresh,
    replacedId: id,
    needsRecompute: true,
    hint: '改签已生效：该队的企业席计分已变化，请重新计算并重新发榜。',
  };
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

/**
 * 回避台账（**读**）—— P10 评委前置页的「已回避清单」数据源。
 *
 * ⚠️ 为什么以前没有这个读口（这正是 P10 补上的缺口）：
 *   全仓只有 `POST /api/stages/:stageId/recusals`，**没有**配套的 GET ——
 *   `recusal_records` 只在计算（computeStage）与复核（checkRecusal）里被读。
 *   ⇒ 前端只能显示「本次会话里我刚提交过的那一条」，
 *      历史上申报过的、别的评委申报过的（组委会要看的），**全都看不到**。
 *
 * ⛔ **可见性在服务层（= API 层）裁决**（全局约束「可见性在 API 层过滤，
 *    前端隐藏 = 数据已泄露」）：
 *   · **本人**（普通登录用户）⇒ 只看**自己**的回避记录；
 *   · **组委会**（`stage:compute`，与 POST /recusals 的 isCommittee 口径一致）
 *     ⇒ 看**全部**（含别的评委的记录）。
 *   ⛔ 「看全部」**只给组委会** —— 回避原因是利益冲突（供应方 / 投资方 / 前雇主），
 *      让所有评委互相看见对方的回避理由，等于把「谁跟哪支队有关系」广播出去。
 *
 * ⚠️ **记录只增不改**（R-JDG-09 留档）：撤销是**再写一条** `action='reinstated'`，
 *    所以台账里同一支队的回避会有**两行**（原申报 + 撤销）——
 *    这是「留档 + 可复算」的语义，**不是**重复行。
 *    每行都带自己的 `status`（recused / reinstated），前端按需取最后一条。
 *
 * ⚠️ 三态状态码：赛段不存在 → 404；赛段存在但没有记录 → **200 + `{ items: [] }`**（不是 404）。
 */
export function getRecusalLedger({ db, stageId, viewer }) {
  assertStageExists(db, stageId);
  const isAdmin = viewer?.isAdmin === true;
  // ⛔ 非组委会一律收窄到「本人」—— 判定在**这里**（服务层），不在前端。
  const judgeId = isAdmin ? null : (viewer?.userId ?? null);
  const rows = listRecusalViews(db, { stageId, judgeId });
  return {
    items: rows.map((r) => ({
      id: r.id,
      stageId: r.stageId,
      judgeId: r.judgeId,
      judgeName: r.judgeName,
      teamId: r.teamId,
      teamName: r.teamName,
      reason: r.reason,
      source: r.source,
      auditBy: r.auditBy,
      createdAt: r.createdAt,
      // ⚠️ `status` = 记录自身的动作（recused 生效 / reinstated 撤销）
      status: r.status,
    })),
  };
}

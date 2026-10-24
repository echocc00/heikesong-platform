// src/services/readiness.js — S-7~S-10 业务就绪度闸（E181，2026-10-27）
//
// 规则溯源：设计文档 §1.3.1「S-7~S-10：怎么量、今天有没有机器检查」
//   · S-8 评审无漏评 —— 数据来源：`stage_reviews` 空缺 + 计算 trace 的 `normalization` 段
//     ⇒ spec §1.3.1 原文：「⚠️ **部分**：`judge_pool_invalid` / `normalization_fallback`
//       已在 trace 里**显式产出**（S-5），但**没有**「漏评覆盖率」的汇总闸」⇒ **待补**。
//   · S-9 按时发榜 —— 数据来源：`leaderboard_snapshots.created_at` vs 赛段 `ends_at`
//     ⇒ spec §1.3.1 原文：「⚠️ **部分**：发榜时刻已入库，但**没有**「超 72 小时」的告警」⇒ **待补**。
//   · S-10 闭环时效与产出 —— 申诉 SLA 已由 rules/compliance.json 的 `appeal.slaHours` 驱动
//     （M0-2 落地）；「完赛认定数 > 0」**需要真实赛事数据** ⇒ 本文件**不假装能算**。
//
// ⚠️ **本文件为什么从「真实表」读，而不是从「临时表」读**：
//    E181 的做法是 —— 先用一份**预演数据集**（同样的表结构、装在临时库里）让功能可被评审；
//    真实赛事数据到位后**直接灌进同一套表** ⇒ 本文件的代码**一行都不用改**。
//    ⇒ ⛔ 本文件里**不许**出现任何「预演/演示专用」的分支（那会让预演数据与真实数据走两套口径）。
//
// ⚠️ **口径纪律（S-8 的「应交」怎么算）**：
//    应交格子 = **有投票权席位数 × 赛段名册队数 × 评委席维度数**
//    —— 判据取自 `services/review.js` 的 `getReviewState`（**不另起一套**）：
//    ① 名册用 `resolveStageRoster`（赛段级优先、届期级兜底）—— 与外队进榜拦截同一口径；
//    ② 席位排除 `observer`（R-JDG-11：观察员无投票权）；
//    ③ 维度只算 `seat === 'judge'` 的（`enterprise` 维度走企业确认、`self` 维度走自评，
//       **都不落在 `stage_reviews`** —— 写路径 `POST /api/stages/:id/reviews` 白名单同款）。
//    ⇒ **复用 getReviewState 而不是重算一遍**，是为了让「闸里看到的覆盖率」与
//      「评审工作台上显示的进度」**永远是同一个数**（同款纪律见 services/review.js:348
//      「三样东西原先分散在三个地方，且三个口径会各自漂移」）。
//
// ⚠️ **fail-closed 的两处**：
//    ① `expected === 0`（没有席位 / 没有名册 / 没有维度）⇒ 覆盖率**不可判定**，
//       本文件返回 `status: 'not_applicable'` + `coveragePercent: null`，
//       **绝不返回 100%**（那是把「没东西可评」说成「全都评了」）。
//    ② `submitted > expected`（数据异常：写路径禁止非评委席维度进 `stage_reviews`）
//       ⇒ 覆盖率封顶 100% 并显式给出 `overSubmitted: true` + `warnings`，**不静默吞掉**。
import { getStage } from '../db/repo/stages.js';
import { listStages } from '../db/repo/stages.js';
import { listSnapshotsByStage } from '../db/repo/leaderboard.js';
import { listTeamRows } from '../db/repo/teams.js';
import { hasStageRoster, listStageTeamIds } from '../db/repo/stage-teams.js';
import { getReviewState } from './review.js';
import { AppError } from '../errors.js';

const HOUR_MS = 3600 * 1000;

/** 阈值全部来自 rules/compliance.json 的 `readiness` 段 —— 代码里**不硬编码**任何数字。 */
function thresholdsOf(rules) {
  const r = rules?.compliance?.readiness ?? {};
  return {
    minReviewCoveragePercent: Number(r.minReviewCoveragePercent ?? 90),
    publishDeadlineHours: Number(r.publishDeadlineHours ?? 72),
    minTeamsForScale: Number(r.minTeamsForScale ?? 4),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * S-8：某赛段的评审覆盖率（漏评闸）。
 *
 * @param {object} db
 * @param {string} stageId
 * @param {object} [rules] 规则集（用于取维度全集与阈值）
 * @returns {object} 覆盖率报告
 */
function reviewCoverage({ db, stageId, rules = null }) {
  const stage = getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const config = rules?.scoring?.[stage.scoring_config_key];
  if (!config) {
    throw new AppError(500, 'SCORING_CONFIG_MISSING', `赛段 ${stageId} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  }
  const judgeDimensions = (config.dimensions ?? []).filter((d) => d.seat === 'judge').map((d) => d.key);
  const { minReviewCoveragePercent } = thresholdsOf(rules);

  // ⚠️ **「这段开打了没有」的前置判断**：名册（stage_team）没登记 ⇒ 这段还没开打。
  //    ⇒ 此时**不给覆盖率结论**（not_applicable），而不是给一个基于届期兜底名册算出来的数。
  //    ⛔ 为什么不用 `resolveStageRoster` 的届期兜底名册：
  //       它回落到「本届全部队伍」⇒ 一个**根本没开的赛段**也会算出覆盖率
  //       （4 队 × 4 席 × 5 维 = 80 格，没交 ⇒ 0%）⇒ 把「还没开始」说成「全部漏评」。
  //    ⇒ 闸用**赛段级名册**（stage_team），与 S-9 的发榜时限判据**同一把尺**。
  //    ✅ 口径一致性：名册登记过之后，`getReviewState` 内部用的 `resolveStageRoster`
  //       也正是 stage_team ⇒ 闸里的数与评审工作台上的数**同一个**。
  if (!hasStageRoster(db, stageId)) {
    return {
      stageId: stage.id,
      stageKey: stage.key,
      stageName: stage.name,
      status: 'not_applicable',
      statusNote: '赛段名册未登记 ⇒ 这段还没开打（不判定覆盖率）',
      expected: null,
      submitted: null,
      coveragePercent: null,
      thresholdPercent: minReviewCoveragePercent,
      complete: false,
      overSubmitted: false,
      missingCount: null,
      missing: [],
      byDimension: {},
      warnings: [],
    };
  }

  // ⚠️ 复用 getReviewState 的**管理员口径**（isAdmin ⇒ 应交/已交/缺谁 全量）
  const progress = getReviewState({
    db,
    stageId,
    viewer: { userId: null, isAdmin: true },
    dimensions: judgeDimensions,
  });

  const expected = progress.total;
  const submitted = progress.submitted;
  const warnings = [];
  const overSubmitted = submitted > expected;
  if (overSubmitted) {
    warnings.push(
      `已交格子数（${submitted}）大于应交格子数（${expected}）⇒ 数据异常：`
      + 'stage_reviews 里出现了不该存在的维度评分（写路径本应挡住）',
    );
  }
  if (expected === 0) {
    // ⛔ fail-closed：没有应交格子 ⇒ **不可判定**，不是 100%
    return {
      stageId: stage.id,
      stageKey: stage.key,
      stageName: stage.name,
      status: 'not_applicable',
      statusNote: '没有应交格子（无投票权席位 / 无名册 / 无评委席维度）⇒ 覆盖率不可判定',
      expected: 0,
      submitted: 0,
      coveragePercent: null,
      thresholdPercent: minReviewCoveragePercent,
      complete: false,
      overSubmitted: false,
      missingCount: 0,
      missing: [],
      byDimension: progress.dimensionProgress ?? {},
      warnings,
    };
  }
  const coveragePercent = round2(Math.min(submitted, expected) / expected * 100);
  return {
    stageId: stage.id,
    stageKey: stage.key,
    stageName: stage.name,
    status: 'measurable',
    statusNote: null,
    expected,
    submitted,
    coveragePercent,
    thresholdPercent: minReviewCoveragePercent,
    complete: coveragePercent >= minReviewCoveragePercent,
    overSubmitted,
    missingCount: progress.missing.length,
    // ⚠️ missing 的条数 = 席位数 × 队数 × 维度数 —— 大赛段可能上千条
    //    ⇒ 列表**截断**并给出总数（完整清单走详情端点 / 预演报告脚本）。
    missing: progress.missing.slice(0, 200),
    byDimension: progress.dimensionProgress ?? {},
    warnings,
  };
}

/**
 * S-9：赛段发榜时限（超期未发榜告警）。
 *
 * 判定口径：从赛段 `ends_at` 起算，到**第一条发榜快照**的 `created_at` 为止。
 * ⚠️ 为什么取「第一条」：一次发榜会写 3 个 scope 的快照（rank/business/personal，
 *    `services/leaderboard.js` 的 SCOPES），它们 `createdAt` 相同 ⇒ 取最早的一条即发榜时刻。
 *
 * @param {object} db
 * @param {string|null} [editionId] 届期；不传则扫全部赛段
 * @param {object} [rules]
 * @param {string|null} [now] ISO 时刻（不传取当前时间）
 */
function publishDeadlines({ db, editionId = null, rules = null, now = null }) {
  const { publishDeadlineHours } = thresholdsOf(rules);
  const at = now ?? new Date().toISOString();
  const atMs = Date.parse(at);
  const stages = listStages(db, editionId ? { editionId } : {});

  const rows = stages.map((stage) => {
    const endsAt = stage.ends_at;
    const endsMs = Date.parse(endsAt);
    // ⚠️ **赛段级名册（stage_team）**，不是届期级兜底名册 —— 与 S-8 同一把尺。
    //    理由见 reviewCoverage 的注释：没登记名册的赛段**还没开打** ⇒ 不该判它「超期没发榜」。
    const roster = listStageTeamIds(db, stage.id);
    const snapshots = listSnapshotsByStage(db, stage.id);
    const publishedAt = snapshots.length ? snapshots[0].created_at : null;

    const base = {
      stageId: stage.id,
      stageKey: stage.key,
      stageName: stage.name,
      endsAt,
      publishedAt,
      rosterSize: roster.length,
      deadlineHours: publishDeadlineHours,
      delayHours: null,
      overdue: false,
    };

    if (!Number.isFinite(endsMs)) {
      // ⛔ 赛段没有可解析的结束时间 ⇒ 不可判定（不假装它是「没超期」）
      return { ...base, state: 'unknown_end', overdue: false, note: '赛段结束时间不可解析 ⇒ 不可判定' };
    }
    if (atMs < endsMs) {
      return { ...base, state: 'not_due', overdue: false, note: '赛段尚未结束' };
    }
    if (!roster.length) {
      // ⚠️ 没有名册的赛段**不计入超期**（还没建队 / 这段没真办）
      //    ⇒ 但**照样列出来**（人能看到），并写明原因。
      return { ...base, state: 'no_roster', overdue: false, note: '赛段没有名册 ⇒ 不计入超期（但请确认这段是否真的不办）' };
    }
    if (!publishedAt) {
      // ⛔ **E182 · F3（2026-10-28）：与「已发榜」分支同一把尺**。
      //    修复前这一支 `overdue: true` 是**无条件**的 ⇒ 赛段结束 **1 小时**没发榜就报红，
      //    而已发榜的同一时刻要 >72h 才算 late ⇒ **同一条 SLA 两种不对称判定**
      //    ⇒ 试赛第一天就会误报一片红（而真超期的那一条反而淹没在噪声里）。
      //    现在两支都按 `delayHours > publishDeadlineHours` 判。
      //    ⚠️ **state 仍是 'never_published'**：它与 'late' 是**两件事**
      //    （「一次都没发过」vs「发过但晚」）⇒ 报告里要能分开看。
      const delayHours = round2((atMs - endsMs) / HOUR_MS);
      const late = delayHours > publishDeadlineHours;
      return {
        ...base,
        state: 'never_published',
        overdue: late,
        delayHours,
        note: late
          ? `赛段已结束 ${delayHours} 小时仍未发榜（时限 ${publishDeadlineHours} 小时，超期 ${round2(delayHours - publishDeadlineHours)} 小时）`
          : `赛段已结束 ${delayHours} 小时，尚未到发榜时限（${publishDeadlineHours} 小时）`,
      };
    }
    const delayHours = round2((Date.parse(publishedAt) - endsMs) / HOUR_MS);
    const late = delayHours > publishDeadlineHours;
    return {
      ...base,
      state: late ? 'late' : 'published',
      overdue: late,
      delayHours,
      note: late
        ? `发榜比时限晚 ${round2(delayHours - publishDeadlineHours)} 小时（时限 ${publishDeadlineHours} 小时）`
        : '按时发榜',
    };
  });

  const overdue = rows.filter((r) => r.overdue);
  return {
    now: at,
    deadlineHours: publishDeadlineHours,
    stageCount: rows.length,
    overdueCount: overdue.length,
    overdueStageIds: overdue.map((r) => r.stageId),
    stages: rows,
  };
}

/**
 * S-7~S-10 汇总：把能算的算出来，把**不能算的明说不能算**。
 *
 * ⛔ **不许在这里把「没数据」写成「达标」**：
 *   · S-7 规模：队伍数可算（但「报名数」口径需真实赛事数据校准）；
 *   · S-8 评审覆盖：可算（见 reviewCoverage）；
 *   · S-9 按时发榜：可算（见 publishDeadlines）；
 *   · S-10 闭环时效：申诉 SLA 部分可算（review-state 已有），「完赛认定数」**需要真实数据**。
 */
export function readinessSummary({ db, editionId = null, rules = null, now = null }) {
  const at = now ?? new Date().toISOString();
  const { minTeamsForScale } = thresholdsOf(rules);
  const teams = editionId ? listTeamRows(db, { editionId }) : listTeamRows(db, {});
  const coverage = editionId
    ? listStages(db, { editionId }).map((s) => reviewCoverage({ db, stageId: s.id, rules }))
    : listStages(db, {}).map((s) => reviewCoverage({ db, stageId: s.id, rules }));
  const deadlines = publishDeadlines({ db, editionId, rules, now: at });

  const measurable = coverage.filter((c) => c.status === 'measurable');
  const worst = measurable.length
    ? measurable.reduce((a, b) => (b.coveragePercent < a.coveragePercent ? b : a))
    : null;

  return {
    now: at,
    editionId: editionId ?? null,
    s7: {
      // 数据来源：teams 行数（spec §1.3.1「`teams` / `registrations` 行数」）
      teamCount: teams.length,
      thresholdTeams: minTeamsForScale,
      met: teams.length >= minTeamsForScale,
      note: '只数了**队伍数**；「报名数」口径（registrations 行数与去重规则）待真实赛事数据校准',
    },
    s8: {
      stageCount: coverage.length,
      measurableCount: measurable.length,
      worstStageId: worst?.stageId ?? null,
      worstCoveragePercent: worst?.coveragePercent ?? null,
      met: measurable.length > 0 && measurable.every((c) => c.complete),
      stages: coverage,
    },
    s9: {
      stageCount: deadlines.stageCount,
      overdueCount: deadlines.overdueCount,
      overdueStageIds: deadlines.overdueStageIds,
      met: deadlines.overdueCount === 0,
      deadlineHours: deadlines.deadlineHours,
      stages: deadlines.stages,
    },
    s10: {
      // 申诉 SLA 已由 services/review-state.js 落地（M0-2）；这里只做**状态声明**
      met: null,
      note: '申诉 SLA 部分已落地（rules/compliance.json 的 appeal.slaHours）；'
        + '「完赛认定数 > 0」与「按时发榜率 ≥ 90%」**需要真实赛事数据** ⇒ 本闸不判定',
    },
  };
}

// src/services/compute.js — 赛段计算（显式动作）
//
// 依据：INTERFACES.md §3 + 设计文档 §8【决策】与 §12。
//   ⛔ compute 是【显式动作，不自动触发】：发榜影响奖金，必须有明确的操作者与时间戳。
//   每次计算产出三件套（input + output + trace）写入 computation_snapshots → 榜单可复算。
//   ⛔ 但计算用的是【原始数据全量重算】，不是 score_stats 增量值 —— 可复算要求能从原始数据重放。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 4 处修正，读代码前先看这段】
//   ① **仓储返回的是 snake_case 行，规格却把三张表的原始行直接喂给领域层** ——
//      企业确认 / 互评 / 自评三张表全部被**静默忽略**：
//        · enterprise_confirmations 的列是 team_id / enterprise_id / raw_score /
//          cross_judge_id / signatory_user_id，而领域层读的是 teamId / rawScore / …
//          → 领域层按 `c.teamId === team.teamId` 过滤，一条都匹配不上
//          → 每支队都拿到「没有企业确认」→ 企业席恒为 0 分（初赛 10% / 决赛 25% 直接蒸发）。
//        · 互评分（trace.perTeam.peerScore）恒为 null。
//        · 自评测恒为空 → 决赛的「自评测 5%」维度恒缺分。
//      现在三张表都**显式映射**成领域层的驼峰形状。
//   ② **「抢 revision + 写快照 + 写结果 + 写审计」不在同一事务** →
//      中途失败会留下「有快照没结果」或「结果指向不存在的快照」的半成品。
//      现在整段在一个 `BEGIN IMMEDIATE` 事务里。
//   ③ **没有任何评分的队伍也写进了 stage_results**（total = 0）→
//      它们会被 P3 排进榜单。设计文档 §11 明写「不参与排名」。
//      现在只写「P 席有分」的队伍。
//   ④ **计算快照可跨赛段读取**（D-26）→ 见 db/repo/computations.js 的 getSnapshotInStage。
import { getStage, listStageTeams as listStageTeamsRows, listStageJudges } from '../db/repo/stages.js';
import { listReviews, listScoreStats } from '../db/repo/reviews.js';
import { listEnterpriseConfirmations } from '../db/repo/enterprise-confirmations.js';
import { listPeerReviews } from '../db/repo/peer-reviews.js';
import { listSelfReviews } from '../db/repo/self-reviews.js';
import { listRecusals } from '../db/repo/recusals.js';
import { listUsersForDetection } from '../db/repo/users.js';
import { upsertStageResult, getSnapshotInStage, resetStageResults } from '../db/repo/computations.js';
import { writeAuditLog } from '../audit/log.js';
import { scoreStage } from '../domain/scoring.js';
import { checkRecusal } from '../domain/review-eligibility.js';
import { checkJudgePool } from '../domain/judge-pool.js';
import { recordComputation } from './audit.js';
import { runDetection } from './anticheat.js';
import { appError } from '../errors.js';

function fail(status, code, message) {
  // ⚠️ 必须用 P0 的 AppError（**不是** `new Error()` + 挂 .status/.code）：
  //    P0 终审 I-C 的错误分支是 `err instanceof AppError ? err.message : '请求无效'` ——
  //    裸 Error 不是 AppError → message 被替换成通用文案「请求无效」。
  return appError(status, code, message);
}

/**
 * 队伍名册（需要 P1 的 teams / task_packages）。
 * ⚠️ 只吞「表还没建」这一种错误（表未就绪时返回空并由调用方记 warning）；
 *    其它错误（SQL 写错、约束冲突）**必须上抛** —— 静默返回空名册会让
 *    R1 / R4 判定整段跳过，榜单分数静默出错。
 */
export function listStageTeams(db, stageId) {
  try {
    // SQL 在仓储层（src/db/repo/stages.js）；本文件**不含 SQL**。
    return listStageTeamsRows(db, stageId);
  } catch (err) {
    const msg = String(err?.message ?? '');
    if (/no such table/i.test(msg)) return [];
    throw err;
  }
}

/** 单事务执行：要么全成功，要么全回滚（⛔ BEGIN IMMEDIATE：立即取写锁） */
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

/** 仓储行（snake_case）→ 领域层形状（camelCase）—— 见文件头修正 ① */
function mapConfirmations(rows) {
  return rows.map((c) => ({
    teamId: c.team_id,
    enterpriseId: c.enterprise_id,
    dimension: c.dimension,
    rawScore: c.raw_score,
    crossJudgeId: c.cross_judge_id ?? null,
    signatoryUserId: c.signatory_user_id ?? null,
    content: c.content ?? '',
  }));
}

function mapPeerReviews(rows) {
  return rows.map((p) => ({
    fromTeamId: p.from_team_id,
    toTeamId: p.to_team_id,
    score: p.score,
  }));
}

function mapSelfReviews(rows) {
  return rows.map((r) => ({
    teamId: r.team_id,
    dimension: r.dimension,
    rawScore: r.raw_score,
  }));
}

/**
 * 计算一个赛段的分数并落快照。
 * @param {object} input
 * @param {string} input.rules 规则集合（rules.scoring.initial / rules.scoring.final）
 */
export function computeStage({ db, stageId, actorId, now, rules }) {
  const stage = getStage(db, stageId);
  if (!stage) throw fail(404, 'STAGE_NOT_FOUND', '赛段不存在');
  if (!rules?.scoring) {
    // fail-fast：没有规则就不算，绝不用默认值凑一个榜单
    throw fail(500, 'RULES_MISSING', '缺少规则配置，拒绝计算');
  }
  const config = rules.scoring[stage.scoring_config_key];
  if (!config) throw fail(500, 'SCORING_CONFIG_MISSING', `赛段 ${stageId} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  // ⚠️ judgePool 段缺失 = 评委池下限/席构成**无法校验** —— 那种情况下算出来的榜单
  //    不可能合规。与其「静默按默认值 0/0/1 算」，不如当场拒绝计算。
  if (!config.judgePool) {
    throw fail(500, 'JUDGE_POOL_CONFIG_MISSING', `权重表 ${stage.scoring_config_key} 缺少 judgePool 段，拒绝计算`);
  }

  const judges = listStageJudges(db, stageId).map((j) => ({ judgeId: j.user_id, seat: j.seat }));

  // 回避的评委对该队的打分不计入（R-JDG-09）
  const recusalRecords = listRecusals(db, { stageId });
  const allReviews = listReviews(db, { stageId });
  const excluded = [];
  const submissions = [];
  for (const r of allReviews) {
    const check = checkRecusal({
      judge: { userId: r.judge_id },
      team: { teamId: r.team_id },
      recusalRecords,
    });
    if (check.recused) {
      excluded.push({ judgeId: r.judge_id, teamId: r.team_id, dimension: r.dimension });
      continue;
    }
    submissions.push({ judgeId: r.judge_id, teamId: r.team_id, dimension: r.dimension, rawScore: r.raw_score });
  }

  const teams = listStageTeams(db, stageId);
  const confirmations = mapConfirmations(listEnterpriseConfirmations(db, { stageId }));
  const peerReviews = mapPeerReviews(listPeerReviews(db, stageId));
  const selfReviews = mapSelfReviews(listSelfReviews(db, stageId));

  const result = scoreStage({
    config,
    judges,
    submissions,
    enterpriseConfirmations: confirmations,
    peerReviews,
    teams,
    selfReviews,
  });

  if (excluded.length) {
    result.warnings.push({
      code: 'recusal_excluded',
      message: `因回避剔除 ${excluded.length} 条打分（记录见 recusal_records）`,
    });
  }

  // ⚠️ 终审修正 I-2：R-JDG-10（评委池下限）/ R-JDG-11（席构成）的校验原来**零调用方** ——
  //    `checkJudgePool` 只有自己的单元测试在跑 → 1 名评委、0 企业席的赛段照样能算出
  //    total=72 的榜单，规则里的 minJudgesPerDimension:7 / minEnterpriseSeatShare:0.30
  //    形同虚设。**后果**：组委会可以在不合规的池子上发榜，而快照里看不出池子不合规。
  //    口径：**不阻断发榜，但必须显式暴露** —— 与本阶段其余「业务状态类」判定一致
  //    （自评差异 / 企业席规则 / 归一化降级 都是「算 + 显式告警」）。
  //    「池子不合规就不许发榜」是**组委会口径**，要加这道闸只需在 compute 路由上判
  //    `warnings` 里的 `judge_pool_invalid`，不必改领域层。
  const judgePool = checkJudgePool({ judges, config: config.judgePool });
  if (!judgePool.ok) {
    result.warnings.push({
      code: 'judge_pool_invalid',
      message: `评委池不合规（${judgePool.errors.length} 项）：${judgePool.errors.map((e) => e.code).join(', ')}`,
      errors: judgePool.errors,
      stats: judgePool.stats,
    });
  }

  // 三件套快照
  const input = {
    config,
    judges,
    submissions,
    excludedReviews: excluded,
    enterpriseConfirmations: confirmations,
    peerReviews,
    selfReviews,
    teams,
    // ⚠️ 池子构成与合规性必须进快照：事后复算时要能看出「当次发榜的评委池合不合规」
    //    （R-AUD-01 可复算 / 可审计）。只放 warnings 不够 —— warnings 不进 input。
    judgePool: { ok: judgePool.ok, errors: judgePool.errors, stats: judgePool.stats },
    ruleVersion: config.version ?? 'unknown',
  };
  // trace 里也留一份：trace 是「计算过程」的完整留痕
  result.trace = { ...(result.trace ?? {}), judgePool: { ok: judgePool.ok, errors: judgePool.errors, stats: judgePool.stats } };

  const out = inTransaction(db, () => {
    const scoredTeamIds = [];
    // ⛔ P11：快照改走**服务层**的 recordComputation（原来这里直接调仓储层 insertSnapshot），
    //    于是 `computation_snapshots` 有了**两个写者**：compute.js 自己拼参数写一份，
    //    services/audit.js 的 recordComputation 又写一份（还带一条 `computation.record` 审计）。
    //    两份实现必然漂 ⇒ 统一到一个写者，服务层那层（校验 + 审计）才是**唯一**入口。
    const { id: computationId, revision } = recordComputation({
      db,
      kind: 'stage_score',
      editionId: stage.edition_id,
      stageId,
      ruleVersion: config.version ?? 'unknown',
      input,
      output: { teams: result.teams, warnings: result.warnings },
      trace: result.trace,
      actorId,
      now,
    });

    for (const t of result.teams) {
      // 没有 P 席评分的队伍不写结果行（不参与排名，见文件头修正 ③）
      const hasPSeat = Object.entries(t.perDimension).some(
        ([key, d]) => config.dimensions.some((dim) => dim.key === key && dim.seat !== 'enterprise') && d.mean != null,
      );
      if (!hasPSeat) continue;
      scoredTeamIds.push(t.teamId);
    }

    // ⛔ 重算前清场：名次/并列/积分置 NULL + 删掉本轮已无评分的旧行
    //    （否则「旧名次 + 新总分」会并排躺在同一行上 —— 父代理预审修正 I2）
    resetStageResults(db, { stageId, keepTeamIds: scoredTeamIds });

    for (const teamId of scoredTeamIds) {
      const t = result.teams.find((x) => x.teamId === teamId);
      upsertStageResult(db, {
        stageId, teamId: t.teamId, total: t.total, seatP: t.seatP, seatE: t.seatE, computationId, now,
      });
    }

    writeAuditLog(db, {
      actorId,
      action: 'stage.compute',
      entity: 'stage',
      entityId: stageId,
      detail: { computationId, revision, teams: result.teams.length, warnings: result.warnings.length },
      now,
    });

    return { computationId, revision, teams: result.teams, warnings: result.warnings, trace: result.trace };
  });

  // ⛔ P11：反作弊检测**必须有一个生产触发点**。
  //    此前 `runDetection`（设计 §11.1「检测 → 进人工复核队列」）**只有单测在调**，
  //    路由表里没有任何一条路能触达它 ⇒ 生产上**永远不会建出 flag** ⇒
  //    「复核队列」页永远是空的 ⇒ 整条防串通/防刷分链是死的。
  //    ⇒ 挂在「算完之后」这个时机：数据齐了才检测得出来。
  //    ⛔ 检测 ≠ 处罚：只建 flag（status='open'），不改分、不封号、不自动裁决（裁决是人的动作）。
  //    ⛔ 检测失败**不许**让计算失败（计算本身已经落库成功）⇒ 降级成一条显式告警，不静默。
  try {
    const detection = runDetection({
      db,
      stageId,
      peerReviews: peerReviews.map((p) => ({ judgeId: p.fromTeamId, teamId: p.toTeamId, score: p.score })),
      // 提交事件（用于「刷分」突发检测）：评委在某时刻提交了一条打分
      events: allReviews.map((r) => ({ subjectId: r.judge_id, at: r.submitted_at })),
      scoreStats: listScoreStats(db),
      users: listUsersForDetection(db),
      // ⚠️ 名次相关的检测（detectTiedMutualPeerRate）需要**最终名次**，
      //    而名次是发榜时（破同分链跑完）才有的 ⇒ 计算阶段给不了，这里传空。
      //    设计 §11.1 的核心要求「两位评委对全部重叠项目给出完全相同的相对顺序」
      //    （detectIdenticalPeerPattern）**不需要名次** ⇒ 已覆盖。
      results: [],
      rules,
      now,
    });
    if (detection?.created?.length) {
      out.warnings.push({
        code: 'anticheat_flags_created',
        message: `本轮检测出 ${detection.created.length} 条疑似异常，已进人工复核队列（只告警，不改分）`,
        flags: detection.created.length,
      });
    }
  } catch (err) {
    out.warnings.push({
      code: 'anticheat_detection_failed',
      message: `反作弊检测未能完成：${String(err?.message ?? err)}（检测失败不影响已算出的分数）`,
    });
  }

  return out;
}

/** 读取计算快照（三件套）；给了 stageId 时必须属于该赛段（D-26） */
export function getComputation({ db, id, stageId = null }) {
  const row = getSnapshotInStage(db, { id, stageId });
  if (!row) throw fail(404, 'COMPUTATION_NOT_FOUND', '计算快照不存在');
  return {
    id: row.id,
    kind: row.kind,
    ruleVersion: row.rule_version,
    revision: row.revision,
    createdAt: row.created_at,
    input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json),
    trace: JSON.parse(row.trace_json),
  };
}

// src/domain/scoring.js — 赛段评分总装（★ 全项目最重要的纯函数）
//
// 依据：设计文档 §6.2 Step 1–10 + §12 trace 结构 + S7 §3.1 / §3.2 / §3.3 / §4.3。
//   需求：R-JDG-01（初赛/决赛两套权重表）｜R-JDG-04（双席加权总分 (1−w_E)×P + w_E×E）
//        ｜R-JDG-13（自评测差异检测）｜R-JDG-19（加时陈述复议分进 trace）
//
// ⛔ 行为分（behavior score）在本模块【完全不参与】：
//   S10 §8 第三条风险原文：「行为分被当成主评分……⭐ 算法层面强制分离，不依赖人的自觉」
//   「分轨必须是算法层面的，不是纪律层面的」。
//   → 实现方式：入参对象里【根本不存在】行为分字段；本函数只解构白名单字段，
//     调用方即使传入 behaviorScore / behaviorPoints 也会被丢弃。
//     对应的单元测试见 test/scoring.test.js「行为分变化不影响总分」。
//
// 【尺度说明】P 与 E 必须在同一尺度上，S7 §3.1 的 z 单位与企业席分（0–100）不可通约。
//   本实现把 z 还原回 0–100 再加权：维度分 = 全局均值 + 截尾 z 均值 × 全局标准差。
//   当评委完全同质时该式退化为原始分均值（详见 src/domain/trim.js 顶部说明）。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【告警文案分层 2026-10-23 —— 本文件产出的每条 warning 都是两层】
//   { code, message, detail?, ...原有字段 }
//   ⛔ **触发条件与口径一个字没改**（那是 P2 的计算逻辑，有大量测试钉着）；
//      这一轮只改【文案怎么分层】：
//   ① `message` —— **只给人读**。禁止出现英文维度键（feasibility / self_eval …）、
//      队伍 id、评委 id、内部原因码（partial:judge_sample_too_small …）。
//      维度中文名取 config.dimensions[].name（取不到就不写维度名，**不许退回英文 key**）。
//   ② `detail` —— **内部明细**（评委 id + 原因码、队伍 id、原始片段），
//      只给有 `audit:read` 的人看 ⇒ 由 API 层（src/services/leaderboard.js）裁剪。
//   ③ `code` —— **保留**（审计与机器判据要用），只是前端不再把它当正文渲染。
//   ⚠️ 队伍名领域层取不到（纯函数没有 db；SQL 只能写在 src/db/repo/）⇒ 正文不写队伍名。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 4 处修正，读代码前先看这段】
//   ① **自评能填补评委席维度 → 自评加分路径**（本文件最严重的一处）。
//      原实现里，评委席维度若没有评委打分，会去 `selfReviews` 里找同维度的自评记录顶上；
//      「精确命中」分支还完全绕过了对齐规则（自评 95 分 / 评委 80 分 → 直接用 95 分进榜）。
//      这与 R-JDG-13「不成立则自评分对齐评委分（**不加分**）」和 S10 §8「自评不得变成加分项」
//      直接冲突 —— 团队可以自己给自己加分。
//      现在：**评委席维度只由评委打分**；评委没打分就是没打分（该维度权重记 0 + warning）。
//      自评记录只能填 **seat='self'** 的维度。
//   ② **对齐规则在「精确命中」分支失效**（同 ① 的另一面）。
//      现在自评维度的取值也走同一套对齐判定：命中 `written_explanation` 时改用评委分。
//   ③ **自评席维度的分写回了 `dimScores`** → 污染后续队伍的 `perDimension`，
//      且让「评委分」查表可能取到**别的队伍的自评分**。
//      现在自评席维度单独放在 `selfDimScores`，与评委维度的 `dimScores` 完全隔离。
//   ④ **「没有任何评分」判定被企业席污染** → `team_no_reviews` 永远不会触发，
//      任何在名册里的队都会拿到一条 total=0 的结果行（进而被排进榜单）。
//      现在「是否参评」只看 **P 席**（评委席 + 自评席）有没有分。

import { normalizeScores } from './normalization.js';
import { trimOutliers, seatScore } from './trim.js';
import { applyEnterpriseRules } from './enterprise-seat.js';
import { detectSelfEvalDiff } from './self-eval.js';

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 按维度权重取加权平均（只算有分的维度）；一个都没有 → null */
function weightedAverage(scores, dims) {
  let num = 0;
  let den = 0;
  for (const d of dims) {
    const v = scores[d.key];
    if (!Number.isFinite(v)) continue;
    num += d.weight * v;
    den += d.weight;
  }
  return den > 0 ? num / den : null;
}

/**
 * 维度 key → 中文名（config.dimensions[].name）。
 * ⚠️ 取不到就返回 **null**，**不许退回英文 key**：
 *    告警正文是给人读的（公开榜单页会把它们原样展示给每一个访客），
 *    英文维度键（feasibility / self_eval …）属于**内部标识**，
 *    出现在正文里等于把内部工作语言摊给所有人。
 * @returns {string|null}
 */
function dimensionLabel(dimensions, key) {
  const hit = (Array.isArray(dimensions) ? dimensions : []).find((d) => d.key === key);
  const name = hit?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * 分差取 2 位小数（去掉浮点噪声）。
 * ⚠️ 为什么不用 toFixed(2)：toFixed 会补零（15.20），而 15.200000000000003
 *    这种二进制误差的正解是「四舍五入到 2 位小数」⇒ 15.2（见 S-5 文案层）。
 * @returns {string} 便于直接拼进文案（不会把 15.200000000000003 漏给人看）
 */
function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100);
}

/**
 * @param {object} input
 * @param {object} input.config rules.scoring.initial | rules.scoring.final
 * @param {Array<{judgeId:string, seat:string}>} input.judges 评委池
 * @param {Array<{judgeId:string, teamId:string, dimension:string, rawScore:number}>} input.submissions
 * @param {Array} input.enterpriseConfirmations 企业确认（R2 双签）
 * @param {Array<{fromTeamId:string, toTeamId:string, score:number}>} input.peerReviews
 * @param {Array<{teamId:string, packageEnterpriseId:string|null, isFreeBrief:boolean}>} input.teams
 *   可选：R1 / R4 需要知道队伍的任务包归属与是否自由命题。缺失时相关判定跳过并记 warning。
 * @param {Array<{teamId:string, dimension:string, rawScore:number}>} input.selfReviews
 *   可选：决赛「自评测」维度需要。缺失时该维度无分并记 warning。
 */
export function scoreStage({
  config,
  judges = [],
  submissions = [],
  enterpriseConfirmations = [],
  peerReviews = [],
  teams = [],
  selfReviews = [],
} = {}) {
  // ⚠️ 刻意只解构白名单字段：任何行为分相关字段都不会进入本函数（分轨在算法层）
  const warnings = [];
  const steps = [];
  const normalization = {};
  const traceWeights = {};

  const dimensions = config?.dimensions ?? [];
  for (const d of dimensions) traceWeights[d.key] = d.weight;

  const judgeDims = dimensions.filter((d) => d.seat === 'judge');
  const enterpriseDims = dimensions.filter((d) => d.seat === 'enterprise');
  const selfDims = dimensions.filter((d) => d.seat === 'self');
  const selfSeatKeys = selfDims.map((d) => d.key);
  const pSeatKeys = [...judgeDims.map((d) => d.key), ...selfSeatKeys];
  const selfSeatKeySet = new Set(selfSeatKeys);
  const selfThreshold = config.selfEvalThreshold ?? 10;

  // 评委池：观察员无投票权（R-JDG-11），其打分一律不计入
  const votingIds = new Set(judges.filter((j) => j.seat !== 'observer').map((j) => j.judgeId));
  if (!judges.length) {
    warnings.push({ code: 'judge_roster_missing', message: '没有评委池信息，宽严归一化无法判定，判定已跳过' });
  }

  // ── Step 1｜分组：按维度收集原始分 ──────────────────────────────────
  const byDim = new Map();
  for (const s of submissions) {
    if (!votingIds.has(s.judgeId)) continue;
    if (!byDim.has(s.dimension)) byDim.set(s.dimension, []);
    byDim.get(s.dimension).push(s);
  }

  // ── Step 2/3/4｜逐维度归一化 → 去极值 → 还原到 0–100 ────────────────
  // dimScores 只装**评委席**维度；自评席维度另装 selfDimScores（父代理预审修正 ③）
  const dimScores = new Map(); // dim -> Map(teamId -> { score, zMean, z, raw })
  for (const [dim, rows] of byDim) {
    const pool = [...new Set(rows.map((r) => r.judgeId))].sort();
    const dimTeams = [...new Set(rows.map((r) => r.teamId))].sort();

    const scoreOf = new Map(); // judgeId -> Map(teamId -> rawScore)
    const seriesOf = new Map(); // judgeId -> number[]（该评委在本维度对全部参赛队的分）
    for (const j of pool) {
      scoreOf.set(j, new Map());
      const series = [];
      for (const t of dimTeams) {
        const hit = rows.find((r) => r.judgeId === j && r.teamId === t);
        if (!hit) continue;
        scoreOf.get(j).set(t, hit.rawScore);
        series.push(hit.rawScore);
      }
      seriesOf.set(j, series);
    }

    const agg = { normalized: true, fallbackReason: null, judgeSampleSizes: {}, judgeReasons: {} };
    for (const j of pool) agg.judgeSampleSizes[j] = seriesOf.get(j).length;

    const perTeam = new Map();
    for (const teamId of dimTeams) {
      const samples = pool.map((j) => ({
        judgeId: j,
        value: scoreOf.get(j).get(teamId) ?? null,
        series: seriesOf.get(j),
      }));
      const res = normalizeScores({
        samples,
        strategy: config.normalizationStrategy ?? 'zscore',
        config,
      });

      for (const j of pool) {
        const st = res.judgeStats[j];
        if (st && st.fallbackReason) {
          agg.normalized = false;
          agg.judgeReasons[j] = st.fallbackReason;
          if (!agg.fallbackReason) agg.fallbackReason = st.fallbackReason;
        }
      }

      const zValues = pool
        .map((j) => ({ judgeId: j, z: res.values[j] }))
        .filter((v) => Number.isFinite(v.z));
      const trimmed = trimOutliers({ values: zValues, minJudges: config.minJudgesForTrim ?? 5 });
      // z 单位 → 原始分单位（与 E 同尺度，才能加权成一个总分）
      const score = clamp(res.stats.mean + trimmed.mean * res.stats.stdev, 0, 100);
      // 该队该维度的【原始分】均值（trace 的 raw 必须是原始分，不是 z）
      const rawScores = pool
        .map((j) => scoreOf.get(j).get(teamId))
        .filter((v) => Number.isFinite(v));

      steps.push({
        step: 'trim',
        dimension: dim,
        teamId,
        trimmed: trimmed.trimmed,
        removed: trimmed.removed,
      });

      perTeam.set(teamId, {
        score,
        zMean: trimmed.mean,
        z: res.values,
        raw: mean(rawScores),
      });
    }

    dimScores.set(dim, perTeam);
    normalization[dim] = agg;
    if (agg.fallbackReason) {
      const degraded = Object.entries(agg.judgeReasons).map(([j, r]) => `${j}:${r}`).join('、');
      const label = dimensionLabel(dimensions, dim);
      warnings.push({
        code: 'normalization_fallback',
        // ⚠️ 文案分层（S-5 / C-05 的「显式展示」不变）：
        //    正文只给人话 —— 英文维度键与「评委 id : 原因码」是**内部明细**，进 detail。
        message: label
          ? `维度「${label}」的评委宽严归一化已降级 —— 本维度未按评委宽严做校正`
          : '相关维度的评委宽严归一化已降级 —— 本维度未按评委宽严做校正',
        detail: `降级明细（评委 id : 原因码）：${degraded}`,
        dimension: dim,
      });
    }
  }

  // ── Step 5｜企业席 E + R1/R2/R3/R4 ───────────────────────────────────
  const roster = teams.length
    ? teams
    : [...new Set([...byDim.values()].flat().map((r) => r.teamId))].map((teamId) => ({
        teamId,
        packageEnterpriseId: null,
        isFreeBrief: false,
      }));
  if (!teams.length) {
    warnings.push({
      code: 'team_roster_missing',
      // ⚠️ 文案分层（E184）：**正文只给人话** —— 内部规则号（R1 / R4）进 detail，
      //    不进正文（内部规则号与 `code` 同一类：内部工作语言）。
      message: '没有队伍名册（无法判断任务包归属与自由命题标记），相关判定按「不适用」处理',
      detail: '规则 R1 / R4 需要任务包归属与自由命题标记',
    });
  }
  const ent = applyEnterpriseRules({
    confirmations: enterpriseConfirmations,
    teams: roster,
    judges,
    config,
  });
  warnings.push(...ent.warnings);

  // ── Step 7｜自评测差异检测（R-JDG-13） ───────────────────────────────
  // ⛔ 检测不依赖权重表里有没有「自评测」维度：只要团队提交了自评，就要检测并留痕。
  const selfAligned = new Set();
  if (selfReviews.length) {
    const judgeScores = [];
    for (const [dim, perTeam] of dimScores) {
      for (const [teamId, cell] of perTeam) {
        judgeScores.push({ teamId, dimension: dim, score: cell.raw });
      }
    }
    const { flags } = detectSelfEvalDiff({
      selfReviews,
      judgeScores,
      threshold: config.selfEvalThreshold ?? 10,
    });
    for (const flag of flags) {
      if (flag.action === 'written_explanation') {
        // 须书面说明自评理由；不成立则自评分对齐评委分（不加分）
        selfAligned.add(`${flag.teamId}::${flag.dimension}`);
        warnings.push({
          code: 'self_eval_written_explanation',
          // ⚠️ round2：${flag.d} 是二进制浮点差值，直接拼会露出 15.200000000000003。
          message: `自评分比评委分高 ${round2(flag.d)} 分，须提交书面说明；不成立则自评分对齐评委分（不加分）`,
          detail: `队伍 ${flag.teamId} / 维度 ${flag.dimension}：自评分与评委分相差 ${round2(flag.d)} 分`,
          teamId: flag.teamId,
          dimension: flag.dimension,
        });
      } else {
        warnings.push({
          code: 'self_eval_judge_question',
          message: `自评分比评委分低 ${round2(Math.abs(flag.d))} 分，评委须向团队提问（只提问，不改分）`,
          detail: `队伍 ${flag.teamId} / 维度 ${flag.dimension}：自评分与评委分相差 ${round2(flag.d)} 分`,
          teamId: flag.teamId,
          dimension: flag.dimension,
        });
      }
    }
  }

  // ── 逐队装配（P 席 / E 席 / 总分） ───────────────────────────────────
  const teamIds = [
    ...new Set([
      ...[...byDim.values()].flat().map((r) => r.teamId),
      ...roster.map((t) => t.teamId),
    ]),
  ].sort();

  const peerByTeam = new Map();
  for (const p of peerReviews) {
    if (!peerByTeam.has(p.toTeamId)) peerByTeam.set(p.toTeamId, []);
    peerByTeam.get(p.toTeamId).push(p.score);
  }

  // 自评席维度的分（与评委维度隔离，父代理预审修正 ③）
  const selfDimScores = new Map(); // dim -> Map(teamId -> { score, zMean, z, raw })
  // 每队的席位权重分母（seatP 的真实分母）
  const seatWeightSums = new Map();

  const teamsOut = [];
  for (const teamId of teamIds) {
    const effW = { ...(ent.weights[teamId] ?? {}) };
    for (const d of dimensions) if (effW[d.key] == null) effW[d.key] = d.weight;

    // R4：企业项由评委的「需求真实性」分替代
    let enterpriseScore = ent.seatE[teamId];
    const r4 = ent.r4Substitute[teamId];
    if (r4 && enterpriseScore === null) {
      const substitute = dimScores.get(r4.dimension)?.get(teamId)?.score ?? 0;
      enterpriseScore = substitute;
      if (substitute === 0 && !dimScores.get(r4.dimension)?.has(teamId)) {
        // ⚠️ 父代理预审修正（Important，I4）：替代维度**没有评委分**时，
        //    企业席会静默变成 0 分（自由命题组白丢 20%），而告警却写着
        //    「改由评委打分」—— 队伍和组委会都看不出来少了这一块。
        //    现在必须显式说清楚：替代维度没分，企业项按 0 分计。
        const r4Label = dimensionLabel(dimensions, r4.dimension);
        warnings.push({
          code: 'R4_substitute_no_scores',
          // ⚠️ 文案分层（E184）：正文不写内部规则号「R4」⇒ 进 detail
          message: r4Label
            ? `自由命题组触发替代规则，但替代维度「${r4Label}」上该队没有任何评委打分，企业项按 0 分计`
            : '自由命题组触发替代规则，但替代维度上该队没有任何评委打分，企业项按 0 分计',
          detail: `队伍 ${teamId} / 替代维度 ${r4.dimension}（规则 R4：自由命题组由评委代评）`,
          teamId,
          dimension: r4.dimension,
        });
      }
    }

    // 席位权重：企业席封顶（R3 已在 applyEnterpriseRules 内封顶）→ 评委席补足到 1 − w_E
    const eKeys = enterpriseDims.map((d) => d.key);
    let wE = eKeys.reduce((acc, k) => acc + (effW[k] ?? 0), 0);
    const cap = Number(config.wEnterprise ?? 0);
    if (wE > cap + 1e-12) wE = cap;
    let wP = pSeatKeys.reduce((acc, k) => acc + (effW[k] ?? 0), 0);
    const factor = wP > 0 ? (1 - wE) / wP : 0;
    for (const k of pSeatKeys) effW[k] = (effW[k] ?? 0) * factor;
    wP = 1 - wE;

    // 评委席 + 自评席的维度分
    const pScores = {};

    // ── 评委席维度：只由评委打分 ────────────────────────────────────
    // ⛔ 自评**永不**填补评委席维度（父代理预审修正 ①）；
    //    ⛔ 而且自评席维度**绝不能**取评委打分记录（父代理预审修正 ⑤）：
    //    评委若能对 `seat='self'` 的维度打分，就能把「自评只能本队成员提交」
    //    这道闸门整个绕过去 —— 评委自己填 100 分，自评栏就归他了。
    for (const k of pSeatKeys) {
      if (selfSeatKeySet.has(k)) continue;
      const cell = dimScores.get(k)?.get(teamId);
      if (cell) pScores[k] = cell.score;
      // 评委没打分就是没打分 —— 该维度权重记 0，并由 seatScore().missing 统一出 warning。
    }

    // 评委席（不含自评席）的加权分 —— 自评席维度的对照基准（R-JDG-13 同一尺度）
    const judgeSeatAvg = weightedAverage(pScores, judgeDims);

    // ── 自评席维度 ─────────────────────────────────────────────────
    for (const k of selfSeatKeys) {
      const selfRows = selfReviews.filter((r) => r.teamId === teamId);
      const exact = selfRows.find((r) => r.dimension === k);
      if (exact) {
        const raw = exact.rawScore;
        // ⛔ D-29：自评分必须与「该队评委席分」比 —— 高出阈值就对齐（**不加分**）。
        //    自评席维度没有同维度的评委分可比，若放任不管，队伍把自评维度填到 100
        //    就是白拿 5% 的加权分 —— 正是 S7 §4.3 说的「一旦自评可以加分，它就变成了纯粹的博弈项」。
        if (judgeSeatAvg != null) {
          const d = raw - judgeSeatAvg;
          if (d > selfThreshold) {
            pScores[k] = judgeSeatAvg;
            warnings.push({
              code: 'self_eval_written_explanation',
              message: `自评分比评委席分高 ${round2(d)} 分，须提交书面说明；不成立则自评分对齐评委席分（不加分）`,
              detail: `队伍 ${teamId} / 维度 ${k}：自评分与评委席分相差 ${round2(d)} 分`,
              teamId,
              dimension: k,
            });
            continue;
          }
          if (d < -selfThreshold) {
            warnings.push({
              code: 'self_eval_judge_question',
              message: `自评分比评委席分低 ${round2(Math.abs(d))} 分，评委须向团队提问（只提问，不改分）`,
              detail: `队伍 ${teamId} / 维度 ${k}：自评分与评委席分相差 ${round2(d)} 分`,
              teamId,
              dimension: k,
            });
          }
        }
        pScores[k] = raw;
      } else {
        // 没有该维度的自评 → 用「本队对评委维度的自评」加权平均（命中对齐的用评委分）
        let num = 0;
        let den = 0;
        for (const jd of judgeDims) {
          const row = selfRows.find((r) => r.dimension === jd.key);
          if (!row) continue;
          const judgeSide = dimScores.get(jd.key)?.get(teamId)?.score;
          const value = selfAligned.has(`${teamId}::${jd.key}`) && judgeSide != null ? judgeSide : row.rawScore;
          num += jd.weight * value;
          den += jd.weight;
        }
        if (den > 0) pScores[k] = num / den;
      }
    }

    // ⚠️ seatScore 的权重必须【只含本席位】的维度，否则另一席位的维度会被算成 missing
    const pWeights = {};
    for (const k of pSeatKeys) pWeights[k] = effW[k] ?? 0;
    const pSeat = seatScore({ dimensionScores: pScores, weights: pWeights });
    for (const missing of pSeat.missing) {
      const missingLabel = dimensionLabel(dimensions, missing);
      warnings.push({
        code: 'dimension_no_scores',
        // ⚠️ 队伍名在领域层**取不到**：scoreStage 是纯函数（无 db），
        //    队伍名要查 teams 表 ⇒ SQL 只能写在 src/db/repo/ ⇒ 这里不写队伍名，
        //    队伍 id 与英文维度键进 detail（只给有 audit:read 的人看）。
        message: missingLabel
          ? `有队伍在「${missingLabel}」维度上没有任何评分，该维度权重记 0`
          : '有队伍在某个维度上没有任何评分，该维度权重记 0',
        detail: `队伍 ${teamId} / 维度 ${missing}`,
        teamId,
        dimension: missing,
      });
    }
    const seatP = pSeat.score;
    // 席位分的**真实分母**（缺分维度被剔除后的权重和）——
    // 不记进 trace 的话，从 trace 复算 seatP 会得到不同的数（父代理预审 Minor 8）。
    seatWeightSums.set(teamId, pSeat.weightSum);

    let seatE = 0;
    if (wE > 0) {
      const eScores = {};
      const eWeights = {};
      for (const k of eKeys) {
        eScores[k] = enterpriseScore ?? 0;
        eWeights[k] = effW[k] ?? 0;
      }
      seatE = seatScore({ dimensionScores: eScores, weights: eWeights }).score;
    }

    // 总分 = (1 − w_E) × P + w_E × E（S7 §3.1；w_E 为该队生效值，R1 时为 0）
    const total = (1 - wE) * seatP + wE * seatE;

    // 自评席维度的分进 trace（否则发榜页看不到该维度的来由）
    for (const k of selfSeatKeySet) {
      if (pScores[k] == null) continue;
      if (!selfDimScores.has(k)) selfDimScores.set(k, new Map());
      selfDimScores.get(k).set(teamId, { score: pScores[k], zMean: null, z: {}, raw: pScores[k] });
    }

    const perDimension = {};
    for (const d of dimensions) {
      const isEnterprise = d.seat === 'enterprise';
      const cell = isEnterprise
        ? null
        : (selfSeatKeySet.has(d.key) ? selfDimScores.get(d.key)?.get(teamId) : dimScores.get(d.key)?.get(teamId));
      perDimension[d.key] = {
        weight: effW[d.key] ?? 0,
        raw: isEnterprise ? (enterpriseScore ?? null) : (cell?.raw ?? null),
        z: isEnterprise ? null : (cell?.zMean ?? null),
        mean: isEnterprise ? (enterpriseScore ?? null) : (cell?.score ?? null),
      };
    }

    teamsOut.push({ teamId, seatP, seatE, total, perDimension });
  }

  // 没有任何评分的队伍不参与排名（设计文档 §11）
  // ⚠️ 判定只看 **P 席**（评委席 + 自评席）：企业席缺分时企业项按 0 分计，
  //    若把它算作「有评分」，则名册里没被任何人评过的队会拿到 total=0 的结果行，
  //    进而被排进榜单 —— 与「不参与排名」相悖（父代理预审修正 ④）。
  for (const t of teamsOut) {
    const hasAny = pSeatKeys.some((k) => t.perDimension[k]?.mean != null);
    if (!hasAny) {
      warnings.push({
        code: 'team_no_reviews',
        message: '有队伍没有任何评分，不参与排名',
        detail: `队伍 ${t.teamId}`,
        teamId: t.teamId,
      });
    }
  }

  const perTeam = {};
  for (const t of teamsOut) {
    const raw = {};
    const z = {};
    for (const [k, v] of Object.entries(t.perDimension)) {
      raw[k] = v.raw;
      z[k] = v.z;
    }
    perTeam[t.teamId] = {
      raw,
      z,
      seatP: t.seatP,
      seatE: t.seatE,
      total: t.total,
      seatPWeightSum: seatWeightSums.get(t.teamId) ?? 0,
      peerScore: peerByTeam.has(t.teamId) ? mean(peerByTeam.get(t.teamId)) : null,
    };
  }

  return {
    teams: teamsOut,
    warnings,
    trace: { normalization, steps, weights: traceWeights, perTeam },
  };
}

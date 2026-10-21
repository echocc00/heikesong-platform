// src/domain/enterprise-seat.js — 企业席得分 E 与 R1 / R2 / R3 / R4
//
// 依据：S7 §2.4 R1–R4（分赛道 / 双签 / 权重封顶 / 自由命题组）+ S7 §3.1 评分公式 + §4.1 签字内容。
//   R-JDG-05 ← R1；R-JDG-06 ← R2；R-JDG-07 ← R3；R-JDG-08 ← R4；R-JDG-14（签字必须有内容）。
//
// ⚠️ R1 与 R2 的区别（本文件最容易做错的一处）：
//   R1（非本赛道）→ 该队【企业项权重】降为 0（该项不参与该队加权，权重让给评委席）
//   R2（缺双签）  → 该队【企业席分数】按 0 分计（权重保留，总分因此被扣）
//   两者都是 S7 原文，语义不同，不要合并。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 8 处修正，读代码前先看这段】
//   ① **R-JDG-14「签字必须有内容」零校验**：content 为空/纯空白的确认照样计入分数。
//      领域层会被 `computeStage` 从库里读数据时调用 —— 服务层的写入口校验挡不住
//      历史数据与旁路写入。现在内容不合规的确认**无效**。
//   ② **确认分没有 0–100 区间校验**：rawScore = 1000 直接进企业席 →
//      总分公式 (1−w_E)×P + w_E×E → 榜单破 100 分。现在越界的确认**无效**。
//   ③ **自由命题组的有效判定错误地依赖 `packageEnterpriseId`** —— 自由命题组
//      本来就没有「本赛道企业」（packageEnterpriseId 为 null），
//      于是它的企业确认**永远**无法被认定有效 → 永远触发 R4，
//      且同时发出「没有企业确认」的**误导性告警**（明明有确认记录）。
//      现在自由组按「双签齐全 + 内容合规 + 分数合法」判有效，与赛道无关。
//   ④ **R4 触发但替代维度不可用 → 规则静默失效**：demandKey 不在维度表里时，
//      警告说「改由评委打分」，但 r4Substitute 为空、企业项按 0 分计
//      —— **队伍被无故扣掉企业席权重，且没人知道为什么**。现在 fail-fast 抛错。
//   ⑤ **R4 生效时仍发「没有企业确认」告警** → 误导（自由组没有企业确认是预期状态）。
//   ⑥ **配置里没有 enterprise 维度 → 企业确认被完全忽略**，却告警说「没有有效的
//      企业确认记录」—— 实为配置缺陷。现在 fail-fast 抛错。
//   ⑦ **R1 命中时 seatE 是 `null`** —— 但计划只说「R4 生效时为 null」。
//      现在 null 的**唯一含义**是「R4 待评委维度替代」，R1 记 0（其权重本已是 0）。
//   ⑧ `wEnterprise` 非法（NaN / 字符串）→ 静默不封顶。现在 fail-fast 抛错。

/**
 * @param {object} input
 * @param {Array} input.confirmations
 *   [{ teamId, enterpriseId, dimension, rawScore, crossJudgeId, signatoryUserId, content }]
 * @param {Array} input.teams [{ teamId, packageEnterpriseId, isFreeBrief }]
 * @param {Array} input.judges 评委池（**当前未使用**，预留企业席归属校验）
 * @param {object} input.config rules.scoring.initial | rules.scoring.final
 * @returns {{seatE:Object<string, number|null>, weights:Object<string,Object<string,number>>,
 *            warnings:Array<{code:string,message:string,teamId?:string}>,
 *            r4Substitute:Object<string,{dimension:string}>}}
 *   `seatE[teamId] === null` 的**唯一**含义是「R4 生效，待评委维度替代」，
 *   由 `r4Substitute[teamId].dimension` 指明替代维度。
 */
export function applyEnterpriseRules({ confirmations = [], teams = [], judges = [], config = {} } = {}) {
  const warnings = [];
  const seatE = {};
  const weights = {};
  const r4Substitute = {};

  const dimensions = Array.isArray(config.dimensions) ? config.dimensions : [];
  const enterpriseKeys = dimensions.filter((d) => d.seat === 'enterprise').map((d) => d.key);
  const enterpriseKey = enterpriseKeys[0] ?? null;

  // ── 配置 fail-fast（坏规则宁可炸掉，也不要静默算出错的 E） ─────────────
  if (!dimensions.length) {
    throw new TypeError('规则配置里没有 dimensions —— 无法计算企业席');
  }
  if (!enterpriseKeys.length) {
    throw new TypeError(
      '规则配置里没有 seat="enterprise" 的维度 —— 企业席是双席制的基本组成',
    );
  }
  const demandKey = config.freeBrief?.judgeDimension ?? null;
  const rawWEnterprise = config.wEnterprise ?? 0;
  if (typeof rawWEnterprise !== 'number' || !Number.isFinite(rawWEnterprise) || rawWEnterprise < 0) {
    throw new TypeError(
      `规则配置项 wEnterprise 非法：${JSON.stringify(rawWEnterprise)}（必须是 ≥0 的有限数）`,
    );
  }
  const wEnterprise = rawWEnterprise;

  for (const team of teams) {
    const base = {};
    for (const d of dimensions) base[d.key] = d.weight;
    const eff = { ...base };

    const mine = (confirmations ?? []).filter(
      (c) => c.teamId === team.teamId && enterpriseKeys.includes(c.dimension),
    );
    // 自由命题组没有「本赛道企业」概念 → R1 不适用（否则会与 R4 打架）
    const outOfTrack = team.isFreeBrief
      ? []
      : mine.filter((c) => c.enterpriseId !== team.packageEnterpriseId);
    // 自由命题组按「内容合规」判有效，与 packageEnterpriseId 无关（父代理预审修正 ③）
    const inTrack = team.isFreeBrief
      ? mine
      : mine.filter((c) => c.enterpriseId === team.packageEnterpriseId);

    // ── 有效性三层判定 ──────────────────────────────────────────────────
    //   ① 双签：出题企业签字 + ≥1 名跨领域评委签字，缺任一即不成立（R2）
    //   ② 内容：R-JDG-14「企业签字必须有内容」（解决哪个环节/落地时间/我方角色）
    //   ③ 分数：必须在 0–100，否则企业席会算出破 100 分的总分
    const classified = inTrack.map((c) => {
      if (!c.crossJudgeId || !c.signatoryUserId) return { c, reason: 'dual_signature' };
      if (typeof c.content !== 'string' || !c.content.trim()) return { c, reason: 'content' };
      if (!Number.isFinite(c.rawScore) || c.rawScore < 0 || c.rawScore > 100) {
        return { c, reason: 'score_range' };
      }
      return { c, reason: null };
    });
    const valid = classified.filter((x) => x.reason === null).map((x) => x.c);
    const failed = classified.filter((x) => x.reason !== null);
    const hasReason = (reason) => failed.some((x) => x.reason === reason);

    // R4 只在「该队**完全没有**企业确认」时接管；确认存在但无效 → 按无效处理
    const r4Candidate = Boolean(team.isFreeBrief) && inTrack.length === 0;
    if (r4Candidate && (!demandKey || base[demandKey] == null)) {
      // 规则要替代却替代不了 → 宁可炸掉，也不能「警告说替代、实际按 0 分计」
      throw new TypeError(
        `自由命题组 ${team.teamId} 触发 R4，但替代维度 ${JSON.stringify(demandKey)} 不在维度表里 —— `
        + '规则无法执行（企业项既不能由企业打分，也没有评委维度可替代）',
      );
    }

    let score = null;

    if (outOfTrack.length) {
      // R1：企业评委给非本企业题目打分 → 该队企业项权重自动降为 0
      if (enterpriseKey) eff[enterpriseKey] = 0;
      warnings.push({
        code: 'R1_out_of_track',
        message: '企业席评了非本企业题目，该队「企业确认」权重降为 0',
        teamId: team.teamId,
      });
    }

    if (hasReason('dual_signature')) {
      // R2：缺双签 → 该项按 0 分计（权重保留）
      score = 0;
      warnings.push({
        code: 'R2_missing_dual_signature',
        message: '企业确认缺双签（出题企业签字 / 跨领域评委签字），该项按 0 分计',
        teamId: team.teamId,
      });
    } else if (hasReason('content')) {
      // R-JDG-14：签字必须有内容
      score = 0;
      warnings.push({
        code: 'R_JDG14_missing_content',
        message: '企业确认缺签字内容（R-JDG-14 要求写明解决哪个环节 / 落地时间 / 我方角色），该项按 0 分计',
        teamId: team.teamId,
      });
    } else if (hasReason('score_range')) {
      // 分数越界 → 该项按 0 分计（绝不让破 100 分的分进榜）
      score = 0;
      warnings.push({
        code: 'enterprise_score_out_of_range',
        message: '企业确认分不在 0–100 区间，该项按 0 分计',
        teamId: team.teamId,
      });
    } else if (valid.length) {
      score = valid.reduce((acc, c) => acc + c.rawScore, 0) / valid.length;
    } else if (!outOfTrack.length && !r4Candidate) {
      score = 0;
      warnings.push({
        code: 'no_enterprise_confirmation',
        message: '该队没有有效的企业确认记录，企业席按 0 分计',
        teamId: team.teamId,
      });
    }

    // R1：权重已归 0，分数无意义 —— 但记 0 而不是 null，
    // 让 `seatE === null` 的唯一含义留给 R4（父代理预审修正 ⑦）
    if (outOfTrack.length && score === null) score = 0;

    // R4：自由命题组无企业签字 → 该项改由评委按「需求真实性的公开证据」打分
    if (r4Candidate) {
      eff[demandKey] = 0;                      // 替代维度从评委席移出，避免双重计分
      if (enterpriseKey) eff[enterpriseKey] = base[demandKey]; // 权重搬到企业席
      r4Substitute[team.teamId] = { dimension: demandKey };
      score = null;                            // 具体分数由评分流水线用评委维度分填充
      warnings.push({
        code: 'R4_free_brief_judge_scored',
        message: '自由命题组无企业签字，「企业确认」项改由评委按需求真实性的公开证据打分',
        teamId: team.teamId,
      });
    }

    // R3：企业席合计权重 ≤ wEnterprise（25% 决赛 / 10% 初赛），超出即封顶
    if (enterpriseKey && wEnterprise > 0) {
      let wE = 0;
      for (const key of enterpriseKeys) wE += eff[key] ?? 0;
      if (wE > wEnterprise + 1e-12) {
        const factor = wE === 0 ? 0 : wEnterprise / wE;
        for (const key of enterpriseKeys) eff[key] = (eff[key] ?? 0) * factor;
        warnings.push({
          code: 'R3_enterprise_weight_capped',
          message: `企业席合计权重 ${wE} 超过上限 ${wEnterprise}，已封顶`,
          teamId: team.teamId,
        });
      }
    }

    seatE[team.teamId] = score;
    weights[team.teamId] = eff;
  }

  return { seatE, weights, warnings, r4Substitute };
}

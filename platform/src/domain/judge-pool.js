// src/domain/judge-pool.js — 评委池规模与席构成校验
//
// 依据：S7 §3.4（R-JDG-10 评委池下限：初赛每维度 ≥7 人 / 决赛 ≥9 人；
//       R-JDG-11 席构成：企业席 ≥30%，专家席 ≤50%，其余观察员【无投票权】）
// 规则数值全部来自 rules/scoring-*.json 的 judgePool 段（⛔ 不硬编码）。
//
// 纯函数：无 IO、无 Date.now()、无 Math.random()。
//
// 【父代理预审修正 2026-10-21 —— 本文件有 3 处修正，读代码前先看这段】
//   ① **配置项非法时，对应的校验被静默跳过**：`Number('x')` = NaN，
//      `minJudges > 0` 恒为 false → 「人数不足」这条校验**整条失效**，
//      组委会会以为评委池合规。现在配置 fail-fast 抛错。
//   ② **席类型写错的评委被静默消失**：既不计入 voting 也不计入 observer，
//      `stats.total` 与 `voting + observer` **对不上**，却没有任何告警 ——
//      而且这些评委本该属于哪个席会影响占比判断。现在报错 `unknown_seat`。
//   ③ **重复 judgeId 被当成两个人** → 专家席/企业席占比算错。现在报错 `duplicate_judge`，
//      且统计按**去重后**的评委算（stats 反映真实人数，error 标记问题）。

/**
 * @param {object} input
 * @param {Array<{judgeId:string, seat:string}>} input.judges
 * @param {object} input.config rules.scoring.*.judgePool
 * @returns {{ok:boolean, errors:Array<{code:string,message:string}>, stats:object}}
 */
export function checkJudgePool({ judges = [], config = {} } = {}) {
  const votingSeats = config.votingSeats ?? ['judge', 'enterprise'];
  const nonVotingSeats = config.nonVotingSeats ?? ['observer'];

  // ── 配置 fail-fast（坏配置会让整条校验静默失效） ─────────────────────
  const readNumber = (key, fallback, label) => {
    const raw = config[key] ?? fallback;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new TypeError(
        `评委池配置项 ${key} 非法：${JSON.stringify(raw)}（必须是有限数）`,
      );
    }
    return raw;
  };
  const minJudges = readNumber('minJudgesPerDimension', 0);
  const minEnterpriseShare = readNumber('minEnterpriseSeatShare', 0);
  const maxExpertShare = readNumber('maxExpertSeatShare', 1);

  const errors = [];

  // ── 去重 + 识别异常数据 ──────────────────────────────────────────────
  const seenIds = new Set();
  const unique = [];
  const duplicated = [];
  for (const j of judges) {
    if (seenIds.has(j.judgeId)) {
      duplicated.push(j.judgeId);
      continue;
    }
    seenIds.add(j.judgeId);
    unique.push(j);
  }
  if (duplicated.length) {
    errors.push({
      code: 'duplicate_judge',
      message: `评委名单里有 ${duplicated.length} 个重复的 judgeId：${[...new Set(duplicated)].join(', ')}`,
    });
  }

  const knownSeats = new Set([...votingSeats, ...nonVotingSeats]);
  const unknownSeat = unique.filter((j) => !knownSeats.has(j.seat));
  if (unknownSeat.length) {
    errors.push({
      code: 'unknown_seat',
      message: `有 ${unknownSeat.length} 名评委的席类型不在 votingSeats / nonVotingSeats 名单里：${[...new Set(unknownSeat.map((j) => j.seat))].join(', ')}`,
    });
  }

  const voting = unique.filter((j) => votingSeats.includes(j.seat));
  const nonVoting = unique.filter((j) => nonVotingSeats.includes(j.seat));
  const enterprise = voting.filter((j) => j.seat === 'enterprise');
  const expert = voting.filter((j) => j.seat === 'judge');

  // 评委池按赛段统一组织（冲突裁决 C-05 第 1 条：专家席跨任务包评分以保证样本量 ≥5）
  // → 每个评委维度都覆盖全部有投票权的评委
  const perDimension = {};
  if (minJudges > 0 && voting.length < minJudges) {
    errors.push({
      code: 'judge_pool_too_small',
      message: `评委池人数 ${voting.length} 低于下限 ${minJudges}（每维度有投票权的评委数不足）`,
    });
  }
  perDimension.all = voting.length;

  const votingCount = voting.length || 1;
  const enterpriseShare = enterprise.length / votingCount;
  const expertShare = expert.length / votingCount;

  if (minEnterpriseShare > 0 && enterpriseShare < minEnterpriseShare - 1e-9) {
    errors.push({
      code: 'enterprise_share_too_low',
      message: `企业席占比 ${(enterpriseShare * 100).toFixed(1)}% 低于下限 ${(minEnterpriseShare * 100).toFixed(1)}%`,
    });
  }
  if (maxExpertShare < 1 && expertShare > maxExpertShare + 1e-9) {
    errors.push({
      code: 'expert_share_too_high',
      message: `专家席占比 ${(expertShare * 100).toFixed(1)}% 超过上限 ${(maxExpertShare * 100).toFixed(1)}%`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      total: judges.length,
      voting: voting.length,
      enterprise: enterprise.length,
      expert: expert.length,
      observer: nonVoting.length,
      unknownSeat: unknownSeat.length,
      enterpriseShare,
      expertShare,
      perDimension,
    },
  };
}

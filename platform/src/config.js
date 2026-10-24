// src/config.js — 规则配置加载与 fail-fast 校验
// 依据：设计文档 §6.7 + §2 第二条结论。
//   60 条机制件级需求全部来自尚未被组委会确认的设计 → 全部走配置。
//   校验不过就拒绝启动，绝不降级为默认值 —— 否则会安静地算出一个错位的榜单。
//   ⚠️ 9 份配置**全部**都要有内容校验（不只是能被 JSON.parse 出来）：
//      "能读出 JSON" 不等于 "配置是对的"。漏检的那几份一旦写错，症状要到
//      P2/P3 算分、算榜单时才爆出来 —— 而那时榜单可能已经发出去了。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 交叉引用校验用的常量（fail-fast 的「引用真实存在」那一类）：
//   · TASK_PACKAGE_STATUSES —— task_packages.status 的取值域（唯一写入方
//     src/services/taskPackage.js 的状态机：submitted → assessed → published | returned）。
//   · RESOURCE_KINDS —— 资源池的分组类型（唯一产生方 src/domain/pool-derive.js）。
//   · LEDGER_POINT_KINDS —— points_ledger.kind 的取值域（契约 INTERFACES.md §4 明列）。
// ⚠️ 这三个模块都是**叶子模块**（不 import 本文件）⇒ 不会形成循环依赖。
import { TASK_PACKAGE_STATUSES } from './db/repo/taskPackages.js';
import { RESOURCE_KINDS } from './domain/pool-derive.js';

const FILES = {
  scoringInitial: 'scoring-initial.json',
  scoringFinal: 'scoring-final.json',
  tiebreak: 'tiebreak.json',
  ranks: 'ranks.json',
  behavior: 'behavior-points.json',
  visibility: 'visibility.json',
  registration: 'registration-scoring.json',
  solvability: 'solvability.json',
  milestones: 'milestones.default.json',
  teamFormation: 'team-formation.json',
  schedule: 'schedule.json',
  compliance: 'compliance.json',
  points: 'points.json',
  criteria: 'criteria.json',
  pools: 'pools.json',
  audit: 'audit.json',                     // ← P4 新增
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`规则配置读取失败 ${path}: ${err.message}`);
  }
}

// 归一化策略四选一（设计文档 §6.2 裁决：可切换）
const VALID_NORMALIZATIONS = ['zscore', 'median', 'trimmed', 'bayes'];
// 归一化的兜底策略二选一（rule-decisions.md C-05 裁决）：
//   global —— 退回全局均值方差（S7 §3.1 原文）；raw —— 直接用原始分。
//   缺这个键 = 样本不足时的归一化行为无定义，必须当场拒绝。
const VALID_FALLBACKS = ['global', 'raw'];
// 里程碑确认方只有两种：企业侧确认 / 评委确认
const VALID_CONFIRMERS = ['enterprise', 'judge'];
// points_ledger.kind 的取值域。
// 依据：INTERFACES.md §4「points_ledger(id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
//        -- kind: stage_rank | mvp | roadshow | personal_rollup」。
// ⛔ 这不是「随便列几个」：kind 写错一个字母 → 该笔积分被静默丢弃（口径外 kind
//    只告警不计入）→ 榜单少一分且没人知道。配置里引用不存在的 kind 必须当场拒绝。
const LEDGER_POINT_KINDS = new Set(['stage_rank', 'mvp', 'roadshow', 'personal_rollup']);

function weightSum(dimensions) {
  return dimensions.reduce((a, d) => a + (typeof d.weight === 'number' ? d.weight : 0), 0);
}

function hasDuplicateKeys(items) {
  const keys = items.map((i) => i?.key).filter((k) => k !== undefined);
  return new Set(keys).size !== keys.length;
}

// 数组元素必须是非 null 对象 —— 否则下面访问 item.key / item.points 会抛 TypeError。
// 校验器的第一职责是**自己不崩**、给出可读错误，而不是把裸 TypeError 抛给调用方。
function hasBadItem(items) {
  return items.some((i) => i === null || typeof i !== 'object');
}

// 维度必须都有 key —— 否则算分时无法把分数映射回维度。
function hasMissingKey(items) {
  return items.some((i) => typeof i.key !== 'string' || !i.key);
}

/**
 * 赛程总天数（M0-1 可达性闸用）。
 *
 * ⚠️ rules/schedule.json 的日期是「月-日」（相对日序，落到具体日历日期由 edition 偏移）。
 *    这里按**真实日历日**换算成日序（固定用 2026 年 —— 非闰年，2 月 29 日会顺延到 3 月 1 日，
 *    对「跨多少天」这个量级无影响）⇒ 跨月也能算对。
 * @returns {number} 总天数（含首尾）；无法解析时返回 0。
 */
function competitionDays(stages) {
  if (!Array.isArray(stages) || !stages.length) return 0;
  const dayOf = (value) => {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Math.floor(Date.UTC(2026, month - 1, day) / 86_400_000);
  };
  const spans = [];
  for (const st of stages) {
    const start = dayOf(st?.start);
    const end = dayOf(st?.end);
    if (start === null || end === null) continue;
    spans.push([Math.min(start, end), Math.max(start, end)]);
  }
  if (!spans.length) return 0;
  const first = Math.min(...spans.map(([a]) => a));
  const last = Math.max(...spans.map(([, b]) => b));
  return Math.max(0, last - first + 1);
}

/**
 * 行为分可达性（M0-1）：一支队伍在**整个赛程内**最多能拿多少行为分。
 *
 * ⛔ 为什么必须算「赛程内」而不是「理论上」：次数约束里的 `cadence`（每周一次）
 *    是**按时间**封顶的 ⇒ 赛程只有 31 天时，「每周一次」最多兑现 5 次 ⇒
 *    **把 cadence 事件算成无限次 ⇒ 会算出「完赛线可达」的假绿结论**。
 *    （这正是 M0-1 之前那条规则的病根：理论上限 60+ 但真实赛程内只有 33 分。）
 *
 * 各项事件的兑现次数：
 *   · `countBy: 'milestone'` ⇒ 一支队伍最多有的里程碑条数（rules/milestones.default.json）
 *   · `once` 且无 cadence ⇒ 1 次
 *   · `once` 且有 cadence{windowDays, maxCount} ⇒ 滚动窗口在赛程内能开的窗口数 × maxCount
 */
function behaviorReachability(behavior, rules) {
  const days = competitionDays(rules?.schedule?.stages);
  const milestoneCount = Array.isArray(rules?.milestones?.items) ? rules.milestones.items.length : 0;
  const events = Array.isArray(behavior?.events) ? behavior.events : [];
  let maxPoints = 0;
  for (const e of events) {
    const points = Number(e?.points) || 0;
    let occurrences = 1;
    if (e?.countBy === 'milestone') {
      occurrences = milestoneCount;
    } else if (e?.cadence) {
      const windowDays = Number(e.cadence.windowDays) || 0;
      const maxCount = Number(e.cadence.maxCount) || 1;
      // 赛程 D 天、窗口 W 天、每窗口 C 次 ⇒ 最多能塞进 ceil(D×C / W) 次
      occurrences = windowDays > 0 ? Math.ceil((days * maxCount) / windowDays) : maxCount;
    }
    maxPoints += points * occurrences;
  }
  return { days, milestoneCount, maxPoints };
}

/**
 * 把配置对象摊平收集到 out。
 * 「有 id 的是一份配置，没 id 的是命名空间」（scoring = { initial, final }）。
 */
function collectConfigObjects(value, out) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (typeof value.id === 'string') {
    out.push(value);
    return;
  }
  for (const inner of Object.values(value)) {
    collectConfigObjects(inner, out);
  }
}

/**
 * 校验全部规则配置。**任何一条不通过都必须 fail-fast**（loadRules 会抛错拒绝启动）。
 * @param {object} rules 分组后的配置（loadRules 传入）
 * @param {number|null} [expectedCount] 应当存在的配置份数（loadRules 传 FILES 的键数）。
 *   传了才能发现「整份配置没被识别到」；不传时只做 version 相关的检查。
 */
export function validateRules(rules, expectedCount = null) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  // ── 版本号一致性 ─────────────────────────────────────────
  // 所有配置的 version 必须全等。version 会写进计算 trace（设计原则
  // 「每次计算留 trace」）—— 版本号漂移 = 审计链在说谎：trace 上标注的版本
  // 与实际生效的规则对不上，事后复算无法自证。
  //
  // ⚠️ 2026-10-21 修正（P1 Task 3 验收发现，与 P2–P6 漂移审计的 I-2 同一条）：
  //    原来这里是**硬编码的 9 项**列表 —— P1 新增 3 份配置（teamFormation /
  //    schedule / compliance）之后，它们的 version 漂移**根本不会被发现**，
  //    这条校验对新增配置形同虚设（实跑：把新配置改成一个异版本号，零报错）。
  //    改成**自动派生**：按「有 id 的就是一份配置」把配置对象摊平，
  //    加多少份配置都自动覆盖 —— 不再需要改这里。
  //
  //    「有 id 的是配置，没 id 的是命名空间」（如 scoring = { initial, final }）。
  //    用 id 而不是 version 做识别：一份配置**缺了 version** 时仍能被认出来，
  //    否则它会被当成命名空间 → 「缺少 version」这条检查反而失效。
  const configObjects = [];
  for (const value of Object.values(rules ?? {})) {
    collectConfigObjects(value, configObjects);
  }
  const configCount = configObjects.length;
  // 每份都必须**有** version —— 只校验「存在的那几份全等」是不够的：
  // 缺一份时 loadRules 对外报的 version 会取到别人的值，等于说谎。
  const missingVersion = configObjects.filter(
    (c) => c.version === undefined || c.version === null || c.version === '',
  ).length;
  if (missingVersion > 0) {
    push(`规则配置有 ${missingVersion} 份缺少 version 字段`);
  }
  // 份数对不上 = 有配置**没被识别到**（如整份配置读成了空对象）→ 必须报错。
  if (expectedCount !== null && configCount !== expectedCount) {
    push(`规则配置应有 ${expectedCount} 份，实际只识别到 ${configCount} 份`);
  }
  const distinct = [...new Set(configObjects.map((c) => c.version).filter((v) => v !== undefined && v !== null && v !== ''))];
  // ⚠️ distinct 是**数组**（Set 被展开），判重数用 .length —— 用 .size 会拿到
  //    undefined，比较恒为 false，这条校验会静默失效。
  if (distinct.length > 1) {
    push(`规则配置 version 不一致：${distinct.join(' / ')} —— ${configCount} 份配置必须同版本`);
  }

  // ── 评分配置 ──────────────────────────────────────────────
  for (const key of ['initial', 'final']) {
    const cfg = rules?.scoring?.[key];
    if (!cfg) {
      push(`scoring.${key} 缺失`);
      continue;
    }
    if (!Array.isArray(cfg.dimensions) || cfg.dimensions.length === 0) {
      push(`scoring.${key}.dimensions 缺失或为空`);
      continue;
    }
    if (hasBadItem(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 含非对象元素`);
      continue;
    }
    const sum = weightSum(cfg.dimensions);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`scoring.${key} 权重合计 = ${sum.toFixed(4)}，必须等于 1（100%）`);
    }
    const ent = cfg.dimensions.find((d) => d.seat === 'enterprise');
    if (!ent) {
      push(`scoring.${key} 缺少 seat=enterprise 的维度`);
    } else if (Math.abs(ent.weight - cfg.wEnterprise) > 1e-9) {
      push(
        `scoring.${key} wEnterprise=${cfg.wEnterprise} 与企业确认维度权重 ${ent.weight} 不一致`,
      );
    }
    if (typeof cfg.wEnterprise !== 'number' || cfg.wEnterprise < 0 || cfg.wEnterprise > 1) {
      push(`scoring.${key} wEnterprise 必须在 0..1`);
    }
    // ── P2 追加：评委池 / 自由命题替代维度 / 归一化策略参数 ──
    // ⛔ 为什么要在这里 fail-fast（而不是等到运行时才报）：
    //    这些字段直接决定「谁有投票权」「自由命题组的企业项由谁顶」——
    //    写错时不会崩，会**静默算出一份错的榜单**（与「权重合计≠100% 拒绝启动」同一类病）。
    const pool = cfg.judgePool;
    if (!pool) {
      push(`scoring.${key} 缺少 judgePool 段（R-JDG-10 / R-JDG-11）`);
    } else {
      if (!(Number(pool.minJudgesPerDimension) > 0)) {
        push(`scoring.${key} judgePool.minJudgesPerDimension 必须 > 0`);
      }
      if (Number(pool.minEnterpriseSeatShare) < 0 || Number(pool.minEnterpriseSeatShare) > 1) {
        push(`scoring.${key} judgePool.minEnterpriseSeatShare 必须在 0..1`);
      }
      if (Number(pool.maxExpertSeatShare) < 0 || Number(pool.maxExpertSeatShare) > 1) {
        push(`scoring.${key} judgePool.maxExpertSeatShare 必须在 0..1`);
      }
      if (!Array.isArray(pool.votingSeats) || !pool.votingSeats.length) {
        push(`scoring.${key} judgePool.votingSeats 缺失`);
      }
      if (!Array.isArray(pool.nonVotingSeats) || !pool.nonVotingSeats.length) {
        push(`scoring.${key} judgePool.nonVotingSeats 缺失`);
      }
    }
    const demand = cfg.freeBrief?.judgeDimension;
    if (!demand) {
      push(`scoring.${key} 缺少 freeBrief.judgeDimension（R-JDG-08 R4）`);
    } else if (!cfg.dimensions.some((d) => d.key === demand && d.seat === 'judge')) {
      push(`scoring.${key} freeBrief.judgeDimension=${demand} 必须是一个评委席维度`);
    }
    if (cfg.selfEvalThreshold != null && Number(cfg.selfEvalThreshold) < 0) {
      push(`scoring.${key} selfEvalThreshold 必须 ≥ 0`);
    }
    if (cfg.trimmedIterations != null && !(Number.isInteger(cfg.trimmedIterations) && cfg.trimmedIterations >= 1)) {
      push(`scoring.${key} trimmedIterations 必须是 ≥1 的整数`);
    }
    // ⚠️ **F45（2026-10-23 审计）去极值门槛是**整数阶跃**，必须由配置**显式声明**：
    //    S7 §3.2 原文「要求该维度有效评委数 ≥ 5，不足则不去极值」⇒ 4 个评委与 5 个评委
    //    处在**不同的估计量**上（这是规格明写的阶跃，不是缺陷）。
    //    ⚠️ 为什么要「显式声明」而不是只靠注释：没有声明 ⇒ 没人知道这个阶跃是**刻意**的
    //    ⇒ 下一个人看到「4 评委 vs 5 评委不一致」会当成 bug 去「修」，把规格改坏。
    //    ⇒ 声明 + 机器闸：声明的语义与实现不一致时，配置必须**报错**，不许悄悄生效。
    if (cfg.trimPolicy !== 'threshold') {
      push(
        `scoring.${key}.trimPolicy 必须是 "threshold"`
        + '（S7 §3.2：评委数不足 minJudgesForTrim 时**整档不去极值** —— 整数阶跃是刻意的）',
      );
    }
    if (!Number.isInteger(cfg.minJudgesForTrim) || cfg.minJudgesForTrim < 1) {
      push(`scoring.${key} minJudgesForTrim 必须是 ≥1 的整数`);
    }
    // ⚠️ **F46（2026-10-23 审计）归一化样本数的口径必须由配置**显式声明**：
    //    `minSamplesForJudgeNormalization` 的「样本数」= **该评委在本赛段评过的队伍数**
    //    （不是「被评分队伍的样本数」）⇒ 队伍数少于该门槛的赛段里，评委宽严归一化
    //    会**整段回退**到全局口径（S7 §3.1 + C-05 的既定行为）。
    //    ⚠️ 同样：没有声明 ⇒ 没人知道这个口径 ⇒ 会被当成 bug「修成别的意思」。
    if (cfg.minSamplesScope !== 'judge_ratings_count') {
      push(
        `scoring.${key}.minSamplesScope 必须是 "judge_ratings_count"`
        + '（S7 §3.1：样本数 = 该评委在本赛段评过的队伍数）',
      );
    }
    if (!Number.isInteger(cfg.minSamplesForJudgeNormalization) || cfg.minSamplesForJudgeNormalization < 1) {
      push(`scoring.${key} minSamplesForJudgeNormalization 必须是 ≥1 的整数`);
    }
    if (cfg.bayesPriorStrength != null && !(Number.isFinite(cfg.bayesPriorStrength) && cfg.bayesPriorStrength >= 0)) {
      push(`scoring.${key} bayesPriorStrength 必须是 ≥0 的有限数`);
    }
    if (!VALID_NORMALIZATIONS.includes(cfg.normalizationStrategy)) {
      push(`scoring.${key} normalizationStrategy 非法`);
    }
    // C-05 裁决：兜底策略可配 —— "global" 退回全局均值方差（S7 §3.1 原文），
    // "raw" 直接用原始分。缺这个键 = 样本不足时归一化怎么走没有定义。
    if (!VALID_FALLBACKS.includes(cfg.fallback)) {
      push(`scoring.${key}.fallback 必须是 ${VALID_FALLBACKS.join(' / ')}（C-05 裁决）`);
    }
    // C-01 裁决：初赛企业确认权重锁定 10%（由 S7 §2.1 权重表合计正好 100% 反推）。
    // 只靠测试锁不住 —— 同时改 wEnterprise 与企业维度权重（保持合计 100%）能绕过测试，
    // 所以校验器也要锁。改动此项须同步改 rule-decisions.md 的 C-01。
    if (cfg.conflictRef === 'C-01' && Math.abs(cfg.wEnterprise - 0.10) > 1e-9) {
      push(`scoring.${key}.wEnterprise 必须为 0.10（C-01 裁决）`);
    }
    if (hasMissingKey(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 存在缺少 key 的维度`);
    }
    if (hasDuplicateKeys(cfg.dimensions)) {
      push(`scoring.${key}.dimensions 存在重复 key`);
    }
  }

  // ── 破同分链 ──────────────────────────────────────────────
  const chain = rules?.tiebreak?.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    push('tiebreak.chain 缺失或为空');
  } else if (hasBadItem(chain)) {
    push('tiebreak.chain 含非对象元素');
  } else {
    const last = chain[chain.length - 1];
    if (!last.deterministic) {
      push('tiebreak.chain 必须以确定性兜底项结尾（deterministic: true），否则榜单不可复算');
    }
    if (!chain.some((c) => c.key === 'total')) {
      push('tiebreak.chain 缺少总分项');
    }
    if (hasDuplicateKeys(chain)) {
      push('tiebreak.chain 存在重复 key');
    }
    // C-03 落地要求：有序链的**每一项**都要标注来源文档与生效条件
    // （生效条件 = scope，已有；来源文档 = source，必须有）。
    if (chain.some((c) => typeof c.source !== 'string' || !c.source)) {
      push('tiebreak.chain 存在缺少 source 的项（C-03 要求逐项标注来源文档）');
    }
    // ⚠️ **F43（2026-10-23 审计）：`tied_only` 的项必须排在 `total` 之后** ——
    //    `tied_only` 声明的是「这一键**只做破同分**，从不进入主排序」（R-RNK-05：
    //    互评在评审分里的占比恒为 0% ≤ 20%）。
    //    ⚠️ 本引擎的排序是**字典序** ⇒ `always` 与 `tied_only` 在运行时**等价**
    //    ⇒ 「声明」拦不住任何人，**只有链序**能破坏它，而链序是配置 ⇒ 必须机器闸。
    //    ⚠️ **配置层也要拦一道**（不只是领域层的 assertChainInvariants）：
    //    领域层那道只在**真的算分时**才触发 ⇒ 配置被改坏了却没人跑分，就没人知道。
    const totalIdx = chain.findIndex((c) => c.key === 'total');
    chain.forEach((c, i) => {
      if ((c.scope || 'always') !== 'tied_only') return;
      if (i <= totalIdx) {
        push(
          `tiebreak.chain 的「${c.key}」是 tied_only（只做破同分），必须排在 total 之后`
          + '（R-RNK-05：互评从不进入主排序 —— 排在 total 之前就变成主排序键了）',
        );
      }
    });
  }

  // ── 段位 ─────────────────────────────────────────────────
  const tiers = rules?.ranks?.tiers;
  const tierKeys = new Set();
  if (!Array.isArray(tiers) || tiers.length === 0) {
    push('ranks.tiers 缺失或为空');
  } else if (hasBadItem(tiers)) {
    push('ranks.tiers 含非对象元素');
  } else {
    for (const t of tiers) tierKeys.add(t.key);
    for (let i = 1; i < tiers.length; i += 1) {
      if (tiers[i].minMilestones <= tiers[i - 1].minMilestones) {
        push(`ranks.tiers 门槛必须严格递增（第 ${i + 1} 档）`);
      }
    }
    if (hasDuplicateKeys(tiers)) {
      push('ranks.tiers 存在重复 key');
    }
  }

  // ── 报名等级 ─────────────────────────────────────────────
  const levels = rules?.registration?.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    push('registration.levels 缺失或为空');
  } else if (hasBadItem(levels)) {
    push('registration.levels 含非对象元素');
  } else {
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i].minScore > levels[i - 1].minScore) {
        push(`registration.levels 阈值必须单调不增（第 ${i + 1} 级）`);
      }
    }
    if (hasDuplicateKeys(levels)) {
      push('registration.levels 存在重复 key');
    }
  }
  const regDims = rules?.registration?.dimensions;
  if (!Array.isArray(regDims) || regDims.length === 0) {
    push('registration.dimensions 缺失或为空');
  } else if (hasBadItem(regDims)) {
    push('registration.dimensions 含非对象元素');
  } else {
    if (hasMissingKey(regDims)) {
      push('registration.dimensions 存在缺少 key 的维度');
    }
    const sum = weightSum(regDims);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`registration.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }

  // ── 可解性 ───────────────────────────────────────────────
  const sol = rules?.solvability;
  if (!Array.isArray(sol?.dimensions) || sol.dimensions.length === 0) {
    push('solvability.dimensions 缺失或为空');
  } else if (hasBadItem(sol.dimensions)) {
    push('solvability.dimensions 含非对象元素');
  } else {
    if (hasMissingKey(sol.dimensions)) {
      push('solvability.dimensions 存在缺少 key 的维度');
    }
    const sum = weightSum(sol.dimensions);
    if (Math.abs(sum - 1) > 1e-9) {
      push(`solvability.dimensions 权重合计 = ${sum.toFixed(4)}，必须等于 1`);
    }
  }
  if (!Array.isArray(sol?.grades) || sol.grades.length === 0) {
    push('solvability.grades 缺失或为空');
  } else if (hasBadItem(sol.grades)) {
    push('solvability.grades 含非对象元素');
  } else if (hasDuplicateKeys(sol.grades)) {
    push('solvability.grades 存在重复 key');
  } else {
    // 反向区间（minScore > maxScore）永远匹配不到任何分数 —— 当场拒绝。
    for (const g of sol.grades) {
      if (typeof g.minScore !== 'number' || typeof g.maxScore !== 'number'
        || g.minScore > g.maxScore) {
        push(
          `solvability.grades 等级 ${g.key} 的区间非法`
          + `（minScore=${g.minScore}, maxScore=${g.maxScore}）`,
        );
      }
    }
    // A/B/C/D 是**互斥**的评分区间：重叠会让同一个分数落进两个等级，
    // 评级结果取决于查表顺序 —— 不可复算。
    const sorted = [...sol.grades].sort((a, b) => a.minScore - b.minScore);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].minScore <= sorted[i - 1].maxScore) {
        push(
          `solvability.grades 分值区间重叠：${sorted[i - 1].key}`
          + `(${sorted[i - 1].minScore}-${sorted[i - 1].maxScore}) 与 `
          + `${sorted[i].key}(${sorted[i].minScore}-${sorted[i].maxScore})`,
        );
      }
    }
  }
  // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**vetoes 完全没有校验**）：
  //    原来这里只校验 dimensions 与 grades，`solvability.vetoes` 一个字都没查 ——
  //    否决项写成空数组、或两条同名、或 `auto.dimension` 指向一个不存在的维度，
  //    全都能通过校验、直到算分时才出问题（或者干脆**静默失效**）。
  //    现在校验：非空、key 唯一、label 非空、`auto` 的形状与指向的维度存在。
  if (!Array.isArray(sol?.vetoes) || sol.vetoes.length === 0) {
    push('solvability.vetoes 缺失或为空（R-ENT-07 三条一票否决）');
  } else if (hasBadItem(sol.vetoes)) {
    push('solvability.vetoes 含非对象元素');
  } else if (hasDuplicateKeys(sol.vetoes)) {
    push('solvability.vetoes 存在重复 key');
  } else {
    const dimensionKeys = new Set((sol.dimensions ?? []).map((d) => d.key));
    for (const v of sol.vetoes) {
      if (typeof v.label !== 'string' || !v.label) {
        push(`solvability.vetoes ${v.key} 缺少 label`);
      }
      if (v.auto === undefined || v.auto === null) continue;
      if (typeof v.auto !== 'object' || typeof v.auto.dimension !== 'string'
        || typeof v.auto.equals !== 'number') {
        push(`solvability.vetoes ${v.key} 的 auto 必须是 { dimension: string, equals: number }`);
      } else if (dimensionKeys.size && !dimensionKeys.has(v.auto.dimension)) {
        push(`solvability.vetoes ${v.key} 的 auto.dimension 引用了不存在的维度 ${v.auto.dimension}`);
      }
    }
  }

  // ── 行为分 ───────────────────────────────────────────────
  // 行为分只用于破同分、不进总分（分轨强制）；但它仍有自己的阈值与上限，必须校验。
  const behavior = rules?.behavior;
  if (!behavior) {
    push('behavior 缺失');
  } else {
    if (typeof behavior.maxWeightShare !== 'number'
      || behavior.maxWeightShare < 0 || behavior.maxWeightShare > 1) {
      push('behavior.maxWeightShare 必须在 0..1');
    }
    if (typeof behavior.completionThreshold !== 'number'
      || behavior.completionThreshold < 0 || behavior.completionThreshold > 100) {
      push('behavior.completionThreshold 必须在 0..100');
    }
    // ⚠️ sortUse **不是可配置项**，它是 R-PTS-08 的硬保证：行为分只能做破同分，
    //    绝不能变成主评分（决赛名次 0% / 奖金 0%）。
    //    链不变量里的那处检查（assertChainInvariants）在生产链路上【拿不到 behaviorConfig】，
    //    属于「建好却从不校验」的同款病根 —— 所以必须在这里 fail-fast：
    //    配置被改成 'primary' 之类的值时**拒绝启动**，而不是带着违规口径上线。
    if (behavior.sortUse !== 'tiebreak_only') {
      push('behavior.sortUse 必须是 tiebreak_only（R-PTS-08：行为分只做破同分，不进总分/奖金）');
    }
    if (!Array.isArray(behavior.events) || behavior.events.length === 0) {
      push('behavior.events 缺失或为空');
    } else if (hasBadItem(behavior.events)) {
      push('behavior.events 含非对象元素');
    } else {
      if (hasDuplicateKeys(behavior.events)) {
        push('behavior.events 存在重复 key');
      }
      for (const e of behavior.events) {
        if (typeof e.points !== 'number' || e.points <= 0) {
          push(`behavior.events 事件 ${e.key} 的 points 必须为正数`);
        }
        // ⚠️ **每个行为事件都必须有次数约束**（F38）：修复前 5 个事件里只有 1 个有 `once`
        //    ⇒ 其余 4 个**无上限** ⇒ 提交 40 次 `weekly_progress` = 80 分 > 完赛线 60
        //    ⇒ 「完赛认定」一分钟内可达 ⇒ 而行为分是破同分链的倒数第二个键
        //    ⇒ 刷行为分 = 决定同分队伍排名 = 决定 10/8/5 赛段积分 = 决定钱。
        //    ⇒ 这是「配置在说谎」的同款病根：`once` 写在规则里却没人执行 ⇒ 必须 fail-fast。
        if (!e.once) {
          push(`behavior.events 事件 ${e.key} 必须有 once 次数约束（否则可无限提交刷分）`);
        }
        if (e.cadence !== undefined) {
          const c = e.cadence;
          if (!c || typeof c !== 'object'
            || !Number.isFinite(c.windowDays) || c.windowDays <= 0
            || !Number.isInteger(c.maxCount) || c.maxCount <= 0) {
            push(`behavior.events 事件 ${e.key} 的 cadence 必须是 { windowDays>0, maxCount>=1 }`);
          }
        }
        // ⚠️ **M0-1**：`countBy` 只允许 'milestone'（按里程碑计次）。
        //    写错拼写必须当场拒绝 —— 否则「按主体计次」会**静默失效**
        //    （回到终身一次 ⇒ 完赛线又不可达），而症状要到算分时才看得见。
        if (e.countBy !== undefined && e.countBy !== 'milestone') {
          push(`behavior.events 事件 ${e.key} 的 countBy 非法（合法取值：milestone）`);
        }
      }
      // ⚠️ **M0-1 可达性机器闸**：完赛线必须在**真实赛程内**够得着。
      //    ⛔ 为什么这道闸必须有：次数约束里的 `cadence`（每周一次）是**按时间**封顶的
      //    ⇒ 赛程 31 天时最多兑现 5 次 ⇒ 只看「理论事件上限」会算出假绿的「可达」。
      //    （M0-1 之前正是这个病：理论上限 60+ 但赛程内只有 33 分 ⇒ 完赛线不可达。）
      const reach = behaviorReachability(behavior, rules);
      if (reach.days > 0 && reach.milestoneCount > 0
        && reach.maxPoints < behavior.completionThreshold) {
        push(
          `behavior 完赛线不可达：按 rules/schedule.json 的赛程（${reach.days} 天）`
          + `与 rules/milestones.default.json 的里程碑条数（${reach.milestoneCount}），`
          + `行为分上限只有 ${reach.maxPoints} 分 < 完赛线 ${behavior.completionThreshold} 分`
          + ' —— 没有任何队伍能被认定为完赛',
        );
      }
    }
  }

  // ── 可见性 ───────────────────────────────────────────────
  // 段位引用必须真实存在 —— 悬空引用会让"公示门槛"静默失效，
  // 而症状要到 P3 算榜单、对可见性过滤时才出现。
  const vis = rules?.visibility;
  if (!vis) {
    push('visibility 缺失');
  } else {
    for (const field of ['publicFromTier', 'privateBelowTier']) {
      const ref = vis.rank?.[field];
      if (typeof ref !== 'string' || !ref) {
        push(`visibility.rank.${field} 缺失`);
      } else if (tierKeys.size > 0 && !tierKeys.has(ref)) {
        push(`visibility.rank.${field} 引用了不存在的段位 ${ref}`);
      }
    }
  }

  // ── 里程碑 ───────────────────────────────────────────────
  const ms = rules?.milestones;
  if (!ms) {
    push('milestones 缺失');
  } else {
    if (!Array.isArray(ms.items) || ms.items.length === 0) {
      push('milestones.items 缺失或为空');
    } else if (hasBadItem(ms.items)) {
      push('milestones.items 含非对象元素');
    } else {
      if (hasDuplicateKeys(ms.items)) {
        push('milestones.items 存在重复 key');
      }
      for (const it of ms.items) {
        if (!VALID_CONFIRMERS.includes(it.confirmedBy)) {
          push(`milestones.items 里程碑 ${it.key} 的 confirmedBy=${it.confirmedBy} 非法`);
        }
        // ⛔ **E182 · F4（2026-10-28）：计分类里程碑的确认方必须是「企业」**。
        //
        // ⚠️ **为什么这道闸成立（依据是实现，不是凭空造规则）**：
        //    里程碑的「达成」在实现里**只有一条路径**：
        //      src/services/tier.js：`achieved = requires_signoff === 0 || 有未撤回签字`
        //      而 `requires_signoff` 在表上是 `INTEGER NOT NULL DEFAULT 1` ⇒ 恒为 1
        //      ⇒ 达成 ⇔ `milestone_signoffs` 里有**未撤回**的一行
        //    而 `milestone_signoffs.enterprise_id TEXT NOT NULL` ⇒ **结构上企业专用**
        //    且 `hasActiveSignoff` 只看「有没有未撤回的行」，**不区分是谁签的**
        //    ⇒ 配置若写 `judge`，评委的确认**没有任何落库路径** ⇒ 该里程碑**永远达不成**
        //      ⇒ 行为分（countBy='milestone' 的达成闸）与段位对它一律不认。
        //    ⇒ 口径依据 R-PTS-12：里程碑与段位**共享「企业签字」这一个数据源**。
        //
        // ⚠️ **「配置不许说谎」纪律**：这条配置此前**只被校验、从未被消费**
        //    （`confirmedBy` 在全仓没有任何读取点）⇒ 一份写着 `judge` 的配置
        //    看上去「评委确认里程碑」，实际是「这个里程碑谁都确认不了」。
        //    ⇒ 现在它在启动时就被拒绝，而不是让运营在试赛时才发现。
        if (it.countsTowardTier && it.confirmedBy !== 'enterprise') {
          push(
            `milestones.items 里程碑 ${it.key} 的 confirmedBy=${it.confirmedBy} 与实现矛盾：`
            + '计分类里程碑的「达成」判定读的是 milestone_signoffs 表（enterprise_id NOT NULL ⇒ 结构上企业专用），'
            + '且与段位共享同一个数据源（R-PTS-12）'
            + ' ⇒ 评委确认的里程碑在实现里**永远达不成**（评委的确认没有落库路径）',
          );
        }
      }
      if (!ms.items.some((it) => it.countsTowardTier)) {
        push('milestones.items 没有任何 countsTowardTier=true 的里程碑，段位将永远无法晋升');
      }
    }
  }

  // ── 组队规则（R-REG-02 / R-REG-04 / R-REG-05 已定，不可被配置改掉）──
  const tf = rules.teamFormation;
  if (!tf) {
    errors.push('teamFormation 缺失');
  } else {
    if (!(tf.teamSize?.min >= 2)) {
      errors.push('teamFormation.teamSize.min 必须 ≥ 2（R-REG-02 已定：不接受 1 人组队）');
    }
    if (tf.teamSize?.max < tf.teamSize?.min) {
      errors.push('teamFormation.teamSize.max 必须 ≥ min');
    }
    if (tf.captainMustBeMba !== true) {
      errors.push('teamFormation.captainMustBeMba 必须为 true（R-REG-05 已定：组长必须一堂 MBA 在籍）');
    }
    if (!(tf.teamsPerPackage?.min >= 1) || tf.teamsPerPackage?.max < tf.teamsPerPackage?.min) {
      errors.push('teamFormation.teamsPerPackage 必须满足 1 ≤ min ≤ max（R-REG-01：每任务包 2–3 队）');
    }
    const mixSum = (tf.packageQuotaMix?.enterprise ?? 0) + (tf.packageQuotaMix?.free ?? 0);
    if (Math.abs(mixSum - 1) > 1e-9) {
      errors.push(`teamFormation.packageQuotaMix 合计 = ${mixSum.toFixed(4)}，必须等于 1`);
    }
    if (tf.singleMemberTriggersMerge !== true) {
      errors.push('teamFormation.singleMemberTriggersMerge 必须为 true（R-REG-04 已定）');
    }
    if (!(tf.singleMemberMergeDeadlineDays > 0)) {
      errors.push('teamFormation.singleMemberMergeDeadlineDays 必须为正整数');
    }
  }

  // ── 赛程时间轴（R-STG-01）──
  const stages = rules.schedule?.stages;
  if (!Array.isArray(stages) || stages.length !== 5) {
    errors.push('schedule.stages 必须是 5 个赛段（R-STG-01）');
  } else {
    // ⚠️ 父代理预审修正（规格自相矛盾，原实现会让服务器**拒绝启动**）：
    //    原来判 `stages[i].start <= stages[i - 1].end`（要求严格递增），
    //    但 R-STG-01 的赛段表本身就是**交接式相接**的：
    //      S1 调研 10/1-10/10 → S2 任务 10/10-13 → S3 开发 10/13-25
    //      → S4 路演 10/26-28 → S5 落地 10/29-31
    //    （见 docs/requirements-traceability.md 的 R-STG-01 一行）
    //    上一段的**结束当天就是下一段的开始日** → `start == 上一段 end` 恒成立
    //    → 原规则会让计划自带的 schedule.json 校验失败 → **fail-fast 拒绝启动**
    //    → P1 一上线就是死的。父代理预审实跑复现：18 条用例全红，
    //    报错「schedule.stages 必须按时间递增（第 3 段）」。
    //    正确的判据是**不许重叠**（`start < 上一段 end`），相接是合法的；
    //    同时补一条「本段 end 不得早于本段 start」。
    for (let i = 1; i < stages.length; i += 1) {
      if (stages[i].start < stages[i - 1].end) {
        errors.push(`schedule.stages 第 ${i + 1} 段与上一段时间重叠（R-STG-01）`);
      }
    }
    for (const st of stages) {
      if (st.end < st.start) {
        errors.push(`schedule.stages ${st.key} 的结束日早于开始日`);
      }
    }
  }

  // ── 合规与 IP（R-ENT-11 / R-ENT-12）──
  if (!rules.compliance?.redLines?.length) {
    errors.push('compliance.redLines 不得为空（R-ENT-12 合规红线）');
  }
  if (!rules.compliance?.ipOwnership?.team) {
    errors.push('compliance.ipOwnership.team 缺失（R-ENT-11 团队保留 IP）');
  }
  // ⚠️ M0-2：申诉裁决时限（SLA）必须是正数 —— 0 / 负数 = 「没有时限」，
  //    而没有时限的 SLA 等于没有 SLA（裁决队列可以无限期积压）。
  if (rules.compliance?.appeal?.slaHours !== undefined) {
    const hours = Number(rules.compliance.appeal.slaHours);
    if (!(Number.isFinite(hours) && hours > 0)) {
      errors.push('compliance.appeal.slaHours 必须是正数（申诉裁决时限）');
    }
  }
  // ⚠️ E181（2026-10-27）：S-7~S-10 的三个阈值（规模门槛 / 覆盖率下限 / 发榜时限）
  //    必须落在合法区间 —— 这三个数直接决定「就绪度闸」判不判达标。
  //    · 覆盖率下限在 (0, 100]：0 = 「没有格子也算达标」⇒ 闸形同虚设；
  //      > 100 = 永远不可能达标 ⇒ 闸永远红。
  //    · 时限与门槛必须 > 0（0 / 负数 = 「没有门槛」）。
  if (rules.compliance?.readiness !== undefined) {
    const rd = rules.compliance.readiness;
    const pct = Number(rd.minReviewCoveragePercent);
    if (!(Number.isFinite(pct) && pct > 0 && pct <= 100)) {
      errors.push('compliance.readiness.minReviewCoveragePercent 必须在 (0, 100]（评审覆盖率下限）');
    }
    const deadline = Number(rd.publishDeadlineHours);
    if (!(Number.isFinite(deadline) && deadline > 0)) {
      errors.push('compliance.readiness.publishDeadlineHours 必须是正数（发榜时限）');
    }
    const teams = Number(rd.minTeamsForScale);
    if (!(Number.isFinite(teams) && teams > 0)) {
      errors.push('compliance.readiness.minTeamsForScale 必须是正数（规模门槛）');
    }
  }

  // ── 报名问卷（R-REG-11）──
  const q = rules.registration?.questions;
  if (!q?.dimensionItems) {
    errors.push('registration.questions.dimensionItems 缺失（R-REG-11）');
  } else {
    for (const d of rules.registration.dimensions) {
      const items = q.dimensionItems[d.key] ?? [];
      if (items.length !== 5) {
        errors.push(`registration.questions.dimensionItems.${d.key} 必须是 5 题（SABC v1 §六：3 维各 5 题）`);
      }
    }
  }
  const funnel = rules.registration?.funnel;
  if (!Array.isArray(funnel) || funnel.length !== 5) {
    errors.push('registration.funnel 必须是 5 阶段（R-REG-10）');
  } else {
    for (let i = 1; i < funnel.length; i += 1) {
      const prev = funnel[i - 1].rate;
      const cur = funnel[i].rate;
      if (prev !== null && cur !== null && cur > prev) {
        errors.push(`registration.funnel 必须逐级收窄（第 ${i + 1} 段）`);
      }
    }
  }

  // ── 任务卡配比（R-ENT-09）──
  const tm = rules.solvability?.taskMix;
  if (tm) {
    const sum = (tm.enterprise ?? 0) + (tm.free ?? 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errors.push(`solvability.taskMix 合计 = ${sum.toFixed(4)}，必须等于 1（R-ENT-09：70% B 端 + 30% 自由）`);
    }
    const splitSum = Object.values(tm.enterpriseGradeSplit ?? {}).reduce((a, b) => a + b, 0);
    if (Object.keys(tm.enterpriseGradeSplit ?? {}).length && Math.abs(splitSum - (tm.enterprise ?? 0)) > 1e-9) {
      errors.push(`solvability.taskMix.enterpriseGradeSplit 合计 = ${splitSum.toFixed(4)}，必须等于 enterprise = ${tm.enterprise}`);
    }
  }

  // ── 名次积分（P3）────────────────────────────────────────
  const pts = rules.points;
  if (!pts) {
    errors.push('points 缺失');
  } else {
    if (!Array.isArray(pts.stagePoints) || !pts.stagePoints.length) {
      errors.push('points.stagePoints 缺失或为空');
    } else if (Number.isFinite(pts.stagePointsOnlyTopN)
      && pts.stagePointsOnlyTopN !== pts.stagePoints.length) {
      errors.push(`points.stagePointsOnlyTopN=${pts.stagePointsOnlyTopN} 与 stagePoints 长度 ${pts.stagePoints.length} 不一致`);
    }
    if (pts.tieRankStyle !== '1224') errors.push(`points.tieRankStyle 必须是 "1224"（当前 ${pts.tieRankStyle}）`);
    if (!pts.mvp || pts.mvp.perPackage !== 1) errors.push('points.mvp.perPackage 必须是 1（每个任务包 1 个 MVP，任务书 §七）');
    if (!pts.personal || typeof pts.personal.lifetime !== 'boolean') errors.push('points.personal.lifetime 必须是布尔值');
    // ── 个人积分口径的**唯一规则来源**（R-RNK-10）─────────────────────
    // ⚠️ 这三项（atomicKinds / rollupKind / includeMvpVote）是个人积分口径的全部依据：
    //    缺任何一项，口径就是**未定义**的（两处实现各按各的理解算 ⇒ 两个名次）。
    //    原来 atomicKinds / rollupKind 散在 rules.pools.talentPointKinds 里，
    //    而 rules.points.personal 只有 lifetime / includeMvpVote ⇒ 规则有两份、且不一致。
    const personal = pts.personal;
    if (personal) {
      if (!Array.isArray(personal.atomicKinds) || personal.atomicKinds.length === 0) {
        errors.push('points.personal.atomicKinds 必须是非空数组（个人积分的原子 kind 白名单）');
      } else {
        for (const k of personal.atomicKinds) {
          if (!LEDGER_POINT_KINDS.has(k)) {
            errors.push(`points.personal.atomicKinds 含不存在的积分 kind：${k}（合法取值：${[...LEDGER_POINT_KINDS].join(' / ')}）`);
          }
        }
      }
      if (typeof personal.rollupKind !== 'string' || !personal.rollupKind) {
        errors.push('points.personal.rollupKind 必须是非空字符串（个人积分汇总快照的 kind）');
      } else if (!LEDGER_POINT_KINDS.has(personal.rollupKind)) {
        errors.push(`points.personal.rollupKind 引用了不存在的积分 kind：${personal.rollupKind}`);
      }
      if (personal.includeMvpVote !== undefined && typeof personal.includeMvpVote !== 'boolean') {
        errors.push('points.personal.includeMvpVote 必须是布尔值');
      }
    }
  }

  // ── 段位附加条件（P3）────────────────────────────────────
  const crit = rules.criteria;
  if (!crit?.tier) {
    errors.push('criteria.tier 缺失');
  } else {
    if (!Array.isArray(crit.tier.dataOrPrototypeMilestones) || !crit.tier.dataOrPrototypeMilestones.length) {
      errors.push('criteria.tier.dataOrPrototypeMilestones 缺失或为空');
    }
    if (!Array.isArray(crit.tier.businessDepartmentKeywords) || !crit.tier.businessDepartmentKeywords.length) {
      errors.push('criteria.tier.businessDepartmentKeywords 缺失或为空');
    }
  }

  // ── MVP 决胜链（P3）──────────────────────────────────────
  // ⛔ 综合分并列时必须有决胜链，且必须以确定性键收尾 —— 否则同分 MVP 由输入顺序决定，
  //    换台机器重算可能选出不同的 MVP。
  if (!crit?.mvp || !Array.isArray(crit.mvp.tiebreak) || !crit.mvp.tiebreak.length) {
    errors.push('criteria.mvp.tiebreak 缺失或为空');
  } else {
    const known = new Set(['roadshow_points', 'team_id']);
    for (const k of crit.mvp.tiebreak) {
      if (!known.has(k)) errors.push(`criteria.mvp.tiebreak 含未知决胜键：${k}`);
    }
    if (crit.mvp.tiebreak.at(-1) !== 'team_id') {
      errors.push('criteria.mvp.tiebreak 必须以 team_id 收尾（确定性兜底）');
    }
  }

  // ── 审计与防作弊（P4）────────────────────────────────────
  const audit = rules.audit;
  if (!audit) {
    errors.push('audit 缺失');
  } else {
    for (const [name, profile] of Object.entries(audit.rateLimit ?? {})) {
      for (const layer of ['lock', 'sliding', 'perMinute', 'perHour']) {
        const l = profile?.[layer];
        if (!l) continue;
        if (layer === 'lock' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.lock.seconds 必须是正整数`);
        }
        // ⚠️ lock.mode 必须显式合法：cooldown（冷却锁）/ mutex（互斥锁）。
        //    漏配 ⇒ 服务层按默认走，配置与行为对不上 ⇒ 「配置在说谎」的老毛病。
        if (layer === 'lock' && !['cooldown', 'mutex'].includes(l.mode)) {
          errors.push(`audit.rateLimit.${name}.lock.mode 必须是 cooldown 或 mutex（当前：${JSON.stringify(l.mode)}）`);
        }
        if (layer !== 'lock' && !(Number.isInteger(l.max) && l.max > 0)) {
          errors.push(`audit.rateLimit.${name}.${layer}.max 必须是正整数`);
        }
        // ⚠️ perMinute / perHour 的窗口长度是**结构决定的**（一分钟 / 一小时）——
        //    服务层写死 60_000 / 3_600_000 毫秒，配置里没有、也**不该有** seconds：
        //    配了也不会生效（配置说了不算 = 说谎）。
        //    只有滑动窗口（sliding）的窗口长度与提交锁（lock）的持有时长是可配的。
        if (layer === 'sliding' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.sliding.seconds 必须是正整数`);
        }
      }
    }
    const lv = audit.antiCheat?.lowVariance;
    if (!lv || !(Number.isFinite(lv.min) && Number.isFinite(lv.max)) || lv.min >= lv.max) {
      errors.push('audit.antiCheat.lowVariance 必须满足 min < max');
    }
    if (!(Number.isInteger(audit.antiCheat?.identicalPeer?.minOverlap) && audit.antiCheat.identicalPeer.minOverlap >= 2)) {
      errors.push('audit.antiCheat.identicalPeer.minOverlap 必须 ≥ 2（重叠项目太少没有判定力）');
    }
    if (!(Number.isInteger(audit.retention?.archiveMonths) && audit.retention.archiveMonths > 0)) {
      errors.push('audit.retention.archiveMonths 必须是正整数（R-JDG-17 赛后 6 个月可查）');
    }
    if (!Array.isArray(audit.reviewState?.appealAllowedTiers) || audit.reviewState.appealAllowedTiers.length === 0) {
      errors.push('audit.reviewState.appealAllowedTiers 不得为空');
    }
    // ⚠️ **M0-2 交叉引用**：可申诉档位必须是**真实存在的段位** ——
    //    写错一个拼写 ⇒ 那支队永远**进不了申诉门**（静默失效：队列里看不到原因）。
    for (const t of audit.reviewState?.appealAllowedTiers ?? []) {
      if (tierKeys.size && !tierKeys.has(t)) {
        errors.push(`audit.reviewState.appealAllowedTiers 引用了不存在的段位 ${t}`);
      }
    }
    // ⚠️ **M0-2**：程序性错误白名单必须是非空字符串数组（空数组 = 不限制 = 白名单形同虚设）。
    const kinds = audit.reviewState?.appealReasonKinds;
    if (kinds !== undefined
      && (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => typeof k !== 'string' || !k))) {
      errors.push('audit.reviewState.appealReasonKinds 必须是非空字符串数组（程序性错误白名单）');
    }
    // ⚠️ **M0-5 跨规则阈值校验**：来源维度的限频必须**比账号维度更紧**。
    //    ⛔ 为什么这是硬约束（不是建议）：登录路由的判定顺序是
    //      ① **来源预检**（只读，在 scrypt **之前**）→ ② 口令校验 → ③ **账号配额**（在失败分支里消耗）
    //      ⇒ 两条计数**同时增长**（每次失败各记一次）。
    //      ⇒ 若来源阈值不更紧，**永远是账号配额先触顶** ⇒ 第 11 次请求就被账号配额挡在 ③
    //      ⇒ 来源预检（①）永远轮不到触发 ⇒ **挡不住 CPU 打爆**（scrypt 照跑）。
    //    实测（2026-10-24 评审轮）：来源阈值设成 20 时，第 11 次就由账号配额挡下，
    //    来源计数停在 10 ⇒ 预检形同虚设。
    const ipSlidingMax = audit.rateLimit?.loginAttemptByIp?.sliding?.max;
    const acctSlidingMax = audit.rateLimit?.loginAttempt?.sliding?.max;
    if (Number.isInteger(ipSlidingMax) && Number.isInteger(acctSlidingMax) && ipSlidingMax >= acctSlidingMax) {
      errors.push(
        `audit.rateLimit.loginAttemptByIp.sliding.max（${ipSlidingMax}）必须严格小于 `
        + `audit.rateLimit.loginAttempt.sliding.max（${acctSlidingMax}）`
        + ' —— 来源预检在口令校验**之前**跑、账号配额在**之后**消耗；'
        + '来源阈值不更紧 ⇒ 永远是账号配额先触顶 ⇒ 来源预检永远不触发 ⇒ CPU 保护落空',
      );
    }
  }

  // ── 三池与工作流（P5）────────────────────────────────────────────
  const pools = rules.pools;
  if (!pools) {
    errors.push('pools 缺失');
  } else {
    // R-OPS-14：禁止岗位制——claimMode 只允许 self_claim_only，写别的值直接拒绝启动
    if (pools.workflow?.claimMode !== 'self_claim_only') {
      errors.push('pools.workflow.claimMode 必须是 self_claim_only（R-OPS-14 禁止岗位制，不允许其他取值）');
    }
    if (!Number.isInteger(pools.publicTokenTtlDays) || pools.publicTokenTtlDays <= 0) {
      errors.push('pools.publicTokenTtlDays 必须是正整数');
    }
    if (!Array.isArray(pools.publicScopes) || !pools.publicScopes.includes('all')) {
      errors.push('pools.publicScopes 必须包含 all');
    }
    // ⚠️ 交叉引用校验：配置里写的取值必须**真实存在**。
    //    原来这一段只校验「形状」，不校验「引用」：
    //    · packageStatusFilter 里写错一个 status 拼写 → 过滤掉**全部**任务包
    //      → 资源池空掉，而且**不报任何错**（空集是合法结果）；
    //    · resourceKinds 写错 → 与派生端（RESOURCE_KINDS）对不上，配置在骗人。
    if (!Array.isArray(pools.packageStatusFilter)) {
      errors.push('pools.packageStatusFilter 必须是数组（空数组 = 不按状态过滤）');
    } else {
      for (const st of pools.packageStatusFilter) {
        if (!TASK_PACKAGE_STATUSES.includes(st)) {
          errors.push(
            `pools.packageStatusFilter 含不存在的任务包状态：${st}`
            + `（合法取值：${TASK_PACKAGE_STATUSES.join(' / ')}）`,
          );
        }
      }
    }
    if (!Array.isArray(pools.resourceKinds) || pools.resourceKinds.length === 0) {
      errors.push('pools.resourceKinds 必须是非空数组');
    } else {
      for (const k of pools.resourceKinds) {
        if (!RESOURCE_KINDS.includes(k)) {
          errors.push(
            `pools.resourceKinds 含不存在的资源类型：${k}`
            + `（合法取值：${RESOURCE_KINDS.join(' / ')}）`,
          );
        }
      }
    }
    if (pools.talentTotalScope !== 'lifetime') {
      errors.push('pools.talentTotalScope 必须是 lifetime（R-RNK-10 个人积分终生上榜）');
    }
    if (!pools.taskEvidence?.requireRunnableOrBlocker) {
      errors.push('pools.taskEvidence.requireRunnableOrBlocker 必须为 true（R-STG-04）');
    }
  }
  return errors;
}

export function loadRules(rulesDir) {
  const rules = {};
  for (const [key, file] of Object.entries(FILES)) {
    rules[key] = readJson(join(rulesDir, file));
  }

  // 重组成嵌套结构，供调用方按语义取用
  const grouped = {
    scoring: { initial: rules.scoringInitial, final: rules.scoringFinal },
    tiebreak: rules.tiebreak,
    ranks: rules.ranks,
    behavior: rules.behavior,
    visibility: rules.visibility,
    registration: rules.registration,
    solvability: rules.solvability,
    milestones: rules.milestones,
    teamFormation: rules.teamFormation,
    schedule: rules.schedule,
    compliance: rules.compliance,
    points: rules.points,
    criteria: rules.criteria,
    pools: rules.pools,
    audit: rules.audit,                    // ← P4 新增
  };

  const errors = validateRules(grouped, Object.keys(FILES).length);
  if (errors.length) {
    const list = errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`规则配置校验失败，拒绝启动：\n${list}`);
  }

  const versions = Object.values(grouped)
    .map((r) => r.version)
    .filter(Boolean);
  const version = versions.length ? versions[0] : 'unknown';

  return { rules: grouped, version };
}

// ── P3 追加：默认规则加载器 ────────────────────────────────────
// 用途：服务层在调用方没有显式注入 rules 时用它，避免"静默用默认规则"的降级。
// ⚠️ 只在没有注入时兜底；注入的 rules 优先（配置文件里的值永远是权威）。
let defaultRulesCache = null;

export function getDefaultRules() {
  if (!defaultRulesCache) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
    defaultRulesCache = loadRules(dir).rules;
  }
  return defaultRulesCache;
}

// src/config.js — 规则配置加载与 fail-fast 校验
// 依据：设计文档 §6.7 + §2 第二条结论。
//   60 条机制件级需求全部来自尚未被组委会确认的设计 → 全部走配置。
//   校验不过就拒绝启动，绝不降级为默认值 —— 否则会安静地算出一个错位的榜单。
//   ⚠️ 9 份配置**全部**都要有内容校验（不只是能被 JSON.parse 出来）：
//      "能读出 JSON" 不等于 "配置是对的"。漏检的那几份一旦写错，症状要到
//      P2/P3 算分、算榜单时才爆出来 —— 而那时榜单可能已经发出去了。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function validateRules(rules) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  // ── 版本号一致性 ─────────────────────────────────────────
  // 9 份配置的 version 必须全等。version 会写进计算 trace（设计原则
  // 「每次计算留 trace」）—— 版本号漂移 = 审计链在说谎：trace 上标注的版本
  // 与实际生效的规则对不上，事后复算无法自证。
  const versionValues = [
    rules?.scoring?.initial?.version,
    rules?.scoring?.final?.version,
    rules?.tiebreak?.version,
    rules?.ranks?.version,
    rules?.behavior?.version,
    rules?.visibility?.version,
    rules?.registration?.version,
    rules?.solvability?.version,
    rules?.milestones?.version,
  ].filter((v) => v !== undefined && v !== null && v !== '');
  // 9 份必须**都有** version —— 只校验「存在的那几份全等」是不够的：
  // 缺一份时 loadRules 对外报的 version 会取到别人的值，等于说谎。
  if (versionValues.length < 9) {
    push(`规则配置有 ${9 - versionValues.length} 份缺少 version 字段`);
  }
  if (versionValues.length > 1) {
    const distinct = [...new Set(versionValues)];
    // ⚠️ distinct 是**数组**（Set 被展开），判重数用 .length —— 用 .size 会拿到
    //    undefined，比较恒为 false，这条校验会静默失效。
    if (distinct.length > 1) {
      push(`规则配置 version 不一致：${distinct.join(' / ')} —— 9 份配置必须同版本`);
    }
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
      }
      if (!ms.items.some((it) => it.countsTowardTier)) {
        push('milestones.items 没有任何 countsTowardTier=true 的里程碑，段位将永远无法晋升');
      }
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
  };

  const errors = validateRules(grouped);
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

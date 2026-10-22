// src/domain/event-info.js — 赛事规则投影（落地页的数据源）
// 依据：P9「UI 重构：落地页 + 科技感设计系统」；赛制的唯一出处是 platform/rules/*.json
//
// ⚠️⚠️ **为什么这个文件在 domain 层（而不是 services/ 或直接写在前端）**：
//   落地页要「介绍赛事与赛制」⇒ 前端需要赛段起止与交付物、评审维度权重、段位表、
//   筛选漏斗、组队规则、名次积分、破同分链、合规红线。
//   这些**全部**只在 `platform/rules/*.json` 里（赛制的唯一出处），
//   而 rules 是**服务端**配置、浏览器读不到 ⇒ 必须由服务端投影出去。
//
//   ⇒ 放在 domain 层的理由是**一份实现、两处使用**：
//     · src/services/public-api.js 的 GET /api/event-info（正式平台）
//     · web/api.demo.js 的同形状端点（公网演示站）
//   两者 import **同一个函数** ⇒ 演示站与正式站的落地页内容**不可能漂移**
//   （P8 的教训：演示适配器曾把「错误的形状」锁进测试 ⇒ 形状必须同源，不能各写一份）。
//
// ⛔⛔ **白名单投影，不是整体倒 rules**：
//   rules 里大量字段是**内部工作备注**（「此为待组委会确认口径」「首届后回测」「占位题面」…），
//   整体倒出去 = 把内部待办状态公开发布。
//   ⇒ 这里**逐字段白名单**挑出「参赛者有权知道的赛制」，其余一律不带。
//
// ⛔ **公开的是「规则」，不是「数据」**：
//   规则（权重、赛程、段位）本来就该公开 —— 参赛者有权知道自己被怎么评；
//   而**分数、名次、企业名、签字人**由 applyVisibility 负责，不在这个文件里。
//
// ⛔ **零依赖、零 IO、纯函数**：领域层要能进浏览器（build-demo.js 会把 src/domain 整目录
//    拷进静态产物），所以这里不得 import 任何 Node 内置模块。
//    ⇒ 不 import src/errors.js（它带 node:crypto），「规则未加载」由**调用方**抛业务错误。

/**
 * 数值兜底：把可能是 undefined / null / 非数字的值转成有限数。
 * ⚠️ 不用 `Number(x) || 0`：Number('abc') 是 NaN（falsy → 0，恰好对），
 *    但 Number(Infinity) 是 Infinity（truthy ⇒ 会被原样带出去 ⇒ 前端渲染成 "Infinity"）。
 *    ⇒ 这里显式判有限。
 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 字符串兜底。 */
function str(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** 布尔兜底（只认真值 true）。 */
function bool(value) {
  return value === true;
}

/** 数组兜底：非数组一律当空数组（配置写错形状时不炸）。 */
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 评分维度投影：只带 key / 名称 / 权重 / 席位。
 * ⚠️ 不带任何内部说明（配置里那些「冲突裁决」「占位」备注是内部工作语言）。
 */
function dimensions(cfg) {
  return arr(cfg?.dimensions).map((d) => ({
    key: str(d?.key),
    name: str(d?.name),
    weight: num(d?.weight),
    seat: str(d?.seat),
  }));
}

/**
 * 赛事规则投影（纯函数）。
 *
 * @param {object} rules 已加载的规则配置（src/config.js 的 loadRules 结果）
 * @returns {object} 落地页用的赛制数据（**形状恒定**：缺配置也给空数组，不给 undefined）
 */
export function buildEventInfo(rules) {
  const r = rules ?? {};
  const schedule = r.schedule ?? {};
  const initial = r.scoring?.initial ?? {};
  const final = r.scoring?.final ?? {};
  const ranks = r.ranks ?? {};
  const registration = r.registration ?? {};
  const formation = r.teamFormation ?? {};
  const points = r.points ?? {};
  const behavior = r.behavior ?? {};
  const compliance = r.compliance ?? {};
  const visibility = r.visibility ?? {};

  return {
    /** 赛段表（脊）：起止是**相对日序**（月-日），由届期起始日落到日历。 */
    stages: arr(schedule.stages).map((s) => ({
      key: str(s?.key),
      name: str(s?.name),
      start: str(s?.start),
      end: str(s?.end),
      deliverables: arr(s?.deliverables).map((d) => str(d)),
      hardRequirement: s?.hardRequirement !== false,
      // ⛔ **不带 note**：rules 里的 note 是**内部溯源说明**
      //    （「R-STG-05：任务书 §六…以甲方投决积分为主」——带内部文档编号与原文引用）。
      //    ⇒ 「这个赛段不做硬性要求」这件事由 hardRequirement（布尔）表达就够了，
      //      落地页据此自己写一句话；把 note 原文倒出去等于把内部工作语言公开。
    })),
    advancement: {
      rate: num(schedule.advancement?.rate),
      finalTopN: num(schedule.advancement?.finalTopN),
    },
    scoring: {
      initial: { dimensions: dimensions(initial) },
      final: { dimensions: dimensions(final) },
    },
    /** 段位（阶）。benefits 按段位键取，取不到就是空数组。 */
    tiers: arr(ranks.tiers).map((t) => ({
      key: str(t?.key),
      name: str(t?.name),
      minMilestones: num(t?.minMilestones),
      requiresBusinessSignoff: bool(t?.requiresBusinessSignoff),
      requiresDataOrPrototype: bool(t?.requiresDataOrPrototype),
      benefits: arr(ranks.benefits?.[str(t?.key)]).map((b) => str(b)),
    })),
    /** 段位**永不解锁**的东西（避免落地页暗示段位能换奖金）。 */
    tierNeverUnlocks: arr(ranks.neverUnlocks).map((x) => str(x)),
    /** 报名筛选漏斗（流）：rate 为 null 表示比例待定（如辅导期）。 */
    funnel: arr(registration.funnel).map((f) => ({
      key: str(f?.key),
      label: str(f?.label),
      rate: f?.rate === null || f?.rate === undefined ? null : num(f.rate),
    })),
    /** 报名画像三维度 + 分级门槛（落地页用来说明「怎么筛人」）。 */
    registration: {
      dimensions: arr(registration.dimensions).map((d) => ({
        key: str(d?.key),
        label: str(d?.label),
        weight: num(d?.weight),
      })),
      levels: arr(registration.levels).map((l) => ({
        key: str(l?.key),
        label: str(l?.label),
        minScore: num(l?.minScore),
      })),
    },
    /** 组队规则。 */
    formation: {
      teamMin: num(formation.teamSize?.min),
      teamMax: num(formation.teamSize?.max),
      captainMustBeMba: bool(formation.captainMustBeMba),
      teamsPerPackageMin: num(formation.teamsPerPackage?.min),
      teamsPerPackageMax: num(formation.teamsPerPackage?.max),
      enterpriseQuota: num(formation.packageQuotaMix?.enterprise),
      freeQuota: num(formation.packageQuotaMix?.free),
    },
    /** 名次积分与 MVP 口径。 */
    scoringPoints: {
      stagePoints: arr(points.stagePoints).map((n) => num(n)),
      stagePointsOnlyTopN: num(points.stagePointsOnlyTopN),
      mvpStagesCounted: num(points.mvp?.stagesCounted),
      tieRankStyle: str(points.tieRankStyle),
    },
    /** 破同分链：只给标签与顺序（说明「同分怎么决」）。 */
    tiebreak: arr(r.tiebreak?.chain).map((c, i) => ({
      order: i + 1,
      key: str(c?.key),
      label: str(c?.label),
      scope: str(c?.scope),
      deterministic: bool(c?.deterministic),
    })),
    /** 行为分（过程参与度）：只给标签与分值。 */
    behaviorEvents: arr(behavior.events).map((e) => ({
      key: str(e?.key),
      label: str(e?.label),
      points: num(e?.points),
    })),
    behaviorMaxWeightShare: num(behavior.maxWeightShare),
    /** 合规红线（报名页与落地页都要明示）。 */
    redLines: arr(compliance.redLines).map((x) => ({
      key: str(x?.key),
      label: str(x?.label),
    })),
    /** 分层公开门槛：C 段及以上公开。 */
    visibility: {
      publicFromTier: str(visibility.rank?.publicFromTier),
    },
  };
}

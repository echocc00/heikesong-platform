// src/domain/pool-derive.js — 三池派生纯函数
// 依据：设计文档 §5.4；R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池；R-RNK-10 个人积分终生上榜
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。所有时间与规则由参数传入。
//
// ⭐ 本文件是【三池派生值的唯一计算点】。
//    任何别处都不要再自己求一次个人积分 —— 那正是"两处算出不同结果"的温床。
//    （个人积分本身的口径已经收敛到 src/domain/pool-derive.js 之外的
//      src/domain/personal-points.js —— 本文件只做**委派**，不再自己实现一套口径。）

import { computePersonalTotals } from './personal-points.js';

/** 资源池的分组类型（企业题 / 自由题）—— 派生源的 is_free_brief 决定。
 *  依据：设计文档 §5.4「资源池 = 企业侧资源」+ R-POOL-03。 */
export const RESOURCE_KINDS = ['enterprise_brief', 'free_brief'];

function pick(row, camel, snake) {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

/**
 * 同刻（同时间戳）记录的兜底比较键。
 *
 * ⚠️ 为什么是 rowid 而不是 id：
 *    这三张表的 id 列**全是 randomUUID()**（src/db/repo/points.js、tiers.js、
 *    registrations.js 的头部注释都写明了「排序兜底键不得用随机 UUID」）。
 *    拿 randomUUID 当排序键 ⇒ 同一批写入的记录顺序逐次运行都不同 ⇒ 不可复算。
 *    rowid 是 SQLite 的**隐式行号 = 写入次序**：确定性、且与
 *    src/db/repo/tiers.js 的 `ORDER BY computed_at DESC, rowid DESC` 同一口径。
 */
function tiebreakOf(row) {
  const raw = row?.rowid;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 确定性字符串比较：按码位（code point）逐字符比。
 *
 * ⛔ 不用 localeCompare（Global Constraints「确定性排序」明确点名禁用）：
 *    localeCompare 的结果依赖运行环境的 ICU 数据与 locale —— 同一份数据在两台
 *    机器（或同一台机器的两个 locale）上可能排出**不同顺序** ⇒ 榜单不可复算。
 *    这与「破同分链必须以确定性键收尾」是同一条纪律（设计文档 §6.7）。
 */
function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * 个人积分聚合（R-RNK-10 终生上榜）—— **委派**给唯一计算点。
 *
 * ⚠️ 口径**不在本文件**：R-RNK-10 曾有两套独立实现（这里的 aggregatePersonalPoints
 *    与 src/domain/points.js 的 computePersonalPoints），读不同的规则文件、按不同的口径算，
 *    同一份流水能算出两个不同的名次。现在两边都委托 src/domain/personal-points.js。
 *
 * ledger: [{ userId, kind, points, stageId }]
 * 返回：{ byUser: { [userId]: { userId, total, stagesJoined, breakdown } }, warnings: [] }
 *   （输出形状与本 Task 最初交付时**逐字一致** —— services/pools.js 与既有测试不受影响）
 */
export function aggregatePersonalPoints({ ledger = [], pointsConfig = {} } = {}) {
  const { byUser, warnings } = computePersonalTotals({ ledger, pointsConfig });
  const out = {};
  for (const [userId, agg] of Object.entries(byUser)) {
    out[userId] = {
      userId,
      total: agg.total,
      stagesJoined: agg.stagesJoined,
      breakdown: agg.breakdown,
    };
  }
  return { byUser: out, warnings };
}

/** 项目池派生：teams + stage_results + tier_records（+ task_packages 取标题与痛点） */
export function derivePoolProjects({ teams = [], packages = [], stageResults = [], stages = [], tierRecords = [] } = {}) {
  const pkgById = new Map(packages.map((p) => [p.id, p]));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // 赛段先后顺序按 starts_at 排（拿不到 starts_at 的排最后）
  const orderedStages = [...stages].sort((a, b) => {
    const ax = String(a.startsAt ?? a.starts_at ?? '');
    const bx = String(b.startsAt ?? b.starts_at ?? '');
    if (ax === bx) return compareIds(a.id, b.id);
    return ax < bx ? -1 : 1;
  });
  const stageOrder = new Map(orderedStages.map((s, i) => [s.id, i]));

  const furthest = new Map();
  for (const r of stageResults) {
    const teamId = pick(r, 'teamId', 'team_id');
    const stageId = pick(r, 'stageId', 'stage_id');
    if (!teamId || !stageId) continue;
    const order = stageOrder.has(stageId) ? stageOrder.get(stageId) : -1;
    const prev = furthest.get(teamId);
    if (!prev || order > prev.order) furthest.set(teamId, { order, stageId });
  }

  const latestTier = new Map();
  for (const t of tierRecords) {
    if (pick(t, 'deletedAt', 'deleted_at')) continue;
    const teamId = pick(t, 'teamId', 'team_id');
    if (!teamId) continue;
    const at = String(pick(t, 'computedAt', 'computed_at') ?? '');
    // ⚠️ 同刻（computed_at 完全相同）的多条段位记录：靠 **rowid** 兜底。
    //    兜底键由【仓储层的 ORDER BY】保证（src/db/repo/pool-sources.js：
    //    ORDER BY tr.team_id, tr.computed_at, tr.rowid —— rowid = 写入次序，确定性、
    //    ⛔ 不是 randomUUID），域函数**不再依赖入参顺序**：
    //    它只按行内携带的 rowid 显式比较 ⇒ 同一份数据无论以什么顺序喂进来，结果都一样。
    //    （口径与 src/db/repo/tiers.js 的 `ORDER BY computed_at DESC, rowid DESC` 一致：
    //    同刻时**后写入**的那条算数。）
    const key = tiebreakOf(t);
    const prev = latestTier.get(teamId);
    if (!prev || at > prev.at || (at === prev.at && (key === null || prev.key === null || key >= prev.key))) {
      latestTier.set(teamId, {
        at,
        key,
        tier: t.tier ?? null,
        signoffs: Number(pick(t, 'businessSignoffCount', 'business_signoff_count') ?? 0),
      });
    }
  }

  const rows = [];
  for (const team of teams) {
    const pkg = pkgById.get(pick(team, 'taskPackageId', 'task_package_id'));
    const title = pkg?.title || team.name || String(team.id);
    const stage = furthest.get(team.id);
    const tierRec = latestTier.get(team.id);
    const pain = pkg ? pick(pkg, 'painPoint', 'pain_point') : null;
    const summary = `${team.name ?? ''}｜${title}${pain ? `｜${String(pain).slice(0, 200)}` : ''}`;
    rows.push({
      teamId: team.id,
      title,
      industry: null, // 一期无行业字段来源 → 显式 NULL（不臆造）
      stageReached: stage ? (stageById.get(stage.stageId)?.stage_key ?? null) : null,
      tier: tierRec?.tier ?? team.tier ?? null,
      businessValue: tierRec && Number.isFinite(tierRec.signoffs) ? tierRec.signoffs : null,
      summary,
    });
  }
  rows.sort((a, b) => compareIds(a.teamId, b.teamId));
  return rows;
}

/** 人才池派生：points_ledger 聚合 + users 取档案 + registrations 取技能画像 */
export function derivePoolTalents({ users = [], ledger = [], registrations = [], pointsConfig = {} } = {}) {
  const { byUser, warnings } = aggregatePersonalPoints({ ledger, pointsConfig });
  const userById = new Map(users.map((u) => [u.id, u]));

  const latestReg = new Map();
  for (const r of registrations) {
    if (pick(r, 'deletedAt', 'deleted_at')) continue;
    const userId = pick(r, 'userId', 'user_id');
    if (!userId) continue;
    const at = String(pick(r, 'createdAt', 'created_at') ?? '');
    // ⚠️ 同刻（created_at 完全相同）的多条报名记录：兜底键同样是 **rowid**
    //    （仓储层 ORDER BY user_id, created_at, rowid 保证顺序；行内 rowid 让域函数
    //    显式比较 ⇒ 不依赖入参顺序）。
    //    注：同一人同一届**最多一条有效报名**（registrations 的部分唯一索引
    //    (user_id, edition_id) WHERE deleted_at IS NULL）⇒ 这条兜底在真实数据上
    //    不会被触发；留着是为了「万一有」时结果仍然确定，而不是靠运气。
    const key = tiebreakOf(r);
    const prev = latestReg.get(userId);
    if (!prev || at > prev.at || (at === prev.at && (key === null || prev.key === null || key >= prev.key))) {
      latestReg.set(userId, { at, key, reg: r });
    }
  }

  const rows = [];
  for (const [userId, agg] of Object.entries(byUser)) {
    const user = userById.get(userId);
    if (!user) {
      warnings.push({ code: 'talent_user_missing', userId });
      continue;
    }
    const reg = latestReg.get(userId)?.reg ?? null;
    const skills = parseSkills(reg ? pick(reg, 'dimensionScoresJson', 'dimension_scores_json') : null, warnings, userId);
    rows.push({
      userId,
      name: user.name ?? '',
      org: user.org ?? null,
      mbaStatus: pick(user, 'mbaStatus', 'mba_status') ?? null,
      totalPoints: agg.total,
      stagesJoined: agg.stagesJoined,
      skills,
    });
  }
  rows.sort((a, b) => b.totalPoints - a.totalPoints || compareIds(a.userId, b.userId));
  return { rows, warnings };
}

/** 资源池派生：task_packages（企业侧资源），按（企业 × 类型）分组 */
export function derivePoolResources({ packages = [] } = {}) {
  const groups = new Map();
  for (const p of packages) {
    if (pick(p, 'deletedAt', 'deleted_at')) continue;
    const enterpriseId = pick(p, 'enterpriseId', 'enterprise_id') ?? 'unknown';
    const kind = pick(p, 'isFreeBrief', 'is_free_brief') ? 'free_brief' : 'enterprise_brief';
    const key = `${enterpriseId}::${kind}`;
    if (!groups.has(key)) {
      groups.set(key, {
        enterpriseId,
        kind,
        enterpriseName: pick(p, 'enterpriseName', 'enterprise_name') ?? null,
        titles: [],
        details: [],
      });
    }
    const g = groups.get(key);
    if (p.title) g.titles.push(p.title);
    const pain = pick(p, 'painPoint', 'pain_point');
    if (pain) g.details.push(String(pain).slice(0, 500));
  }

  const rows = [];
  for (const g of groups.values()) {
    const detail = g.titles.length
      ? `${g.titles.join(' / ')}${g.details.length ? `：${g.details.join(' / ')}` : ''}`
      : null;
    rows.push({
      enterpriseId: g.enterpriseId,
      enterpriseName: g.enterpriseName,
      kind: g.kind,
      detail,
      // ⚠️ 这里**不再**产出 packageCount：
      //    契约 §6 的 pool_resources 列清单里没有这一列，仓储层也没有落库 ⇒
      //    算出来就是**算完即丢**（T3-C7 登记过的信息损失）。
      //    修法二选一：① 从派生结构去掉（本处，代价最小、契约零改动）；
      //              ② 给 pool_resources 增列并在仓储层落库 —— 那要改**已发布**的
      //                 006_pools.sql（迁移按版本号记账，改内容不会重跑 ⇒ 老库漂移）
      //                 或新增 007 迁移 + 改契约列清单 —— 与「本 Task 一列未动」相悖。
      //    结论：取①。条数没有真丢：detail 里已经带着全部标题（' / ' 分隔），
      //    条数可由它数出来。
    });
  }
  rows.sort((a, b) => compareIds(a.enterpriseId, b.enterpriseId) || compareIds(a.kind, b.kind));
  return rows;
}

function parseSkills(raw, warnings, userId) {
  if (!raw) return [];
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    warnings.push({ code: 'skills_parse_failed', userId });
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj)
    .sort()
    .map((key) => ({ key, score: Number(obj[key]) || 0 }));
}

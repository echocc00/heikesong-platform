// src/domain/pool-derive.js — 三池派生纯函数
// 依据：设计文档 §5.4；R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池；R-RNK-10 个人积分终生上榜
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。所有时间与规则由参数传入。
//
// ⭐ 本文件是【三池派生值的唯一计算点】。
//    任何别处都不要再自己求一次个人积分 —— 那正是"两处算出不同结果"的温床。

export const ATOMIC_POINT_KINDS = ['stage_rank', 'mvp', 'roadshow'];
export const ROLLUP_POINT_KIND = 'personal_rollup';

function pick(row, camel, snake) {
  return row[camel] !== undefined ? row[camel] : row[snake];
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
 * 个人积分聚合（R-RNK-10 终生上榜）。
 * ledger: [{ userId, kind, points, stageId }]
 * 口径：
 *   · 有 personal_rollup 行 → 以 rollup 为准（它就是"已汇总"的行）
 *   · 否则累加 atomic 行（stage_rank / mvp / roadshow）
 *   · 两者都存在且不一致 → 以 rollup 为准，并产出显式 warning（不静默）
 * 返回：{ byUser: { [userId]: { total, stagesJoined, breakdown } }, warnings: [] }
 */
export function aggregatePersonalPoints({ ledger = [], pointsConfig = {} } = {}) {
  const atomicKinds = pointsConfig?.talentPointKinds?.atomic ?? ATOMIC_POINT_KINDS;
  const rollupKind = pointsConfig?.talentPointKinds?.rollup ?? ROLLUP_POINT_KIND;
  const eps = 1e-9;
  const byUser = new Map();
  const warnings = [];

  for (const row of ledger) {
    const userId = pick(row, 'userId', 'user_id');
    if (!userId) continue;
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId, atomic: 0, rollup: 0, atomicRows: 0, rollupRows: 0, stages: new Set(),
      });
    }
    const acc = byUser.get(userId);
    const points = Number(row.points) || 0;
    if (row.kind === rollupKind) {
      acc.rollup += points;
      acc.rollupRows += 1;
    } else if (atomicKinds.includes(row.kind)) {
      acc.atomic += points;
      acc.atomicRows += 1;
    } else {
      warnings.push({ code: 'points_kind_ignored', userId, kind: row.kind });
    }
    const stageId = pick(row, 'stageId', 'stage_id');
    if (stageId) acc.stages.add(stageId);
  }

  const out = {};
  for (const acc of byUser.values()) {
    let total;
    if (acc.rollupRows > 0) {
      total = acc.rollup;
      if (acc.atomicRows > 0 && Math.abs(acc.rollup - acc.atomic) > eps) {
        warnings.push({
          code: 'points_ledger_kind_conflict',
          userId: acc.userId,
          rollup: acc.rollup,
          atomic: acc.atomic,
        });
      }
    } else {
      total = acc.atomic;
    }
    out[acc.userId] = {
      userId: acc.userId,
      total,
      stagesJoined: acc.stages.size,
      breakdown: { atomic: acc.atomic, rollup: acc.rollup },
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
    const prev = latestTier.get(teamId);
    if (!prev || at >= prev.at) {
      latestTier.set(teamId, {
        at,
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
    const prev = latestReg.get(userId);
    if (!prev || at >= prev.at) latestReg.set(userId, { at, reg: r });
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
      packageCount: g.titles.length,
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

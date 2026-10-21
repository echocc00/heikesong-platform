// src/services/pools.js — 三池派生同步与只读查询
// 依据：INTERFACES.md §6（P5 产出）；设计文档 §5.4 三池底座
//   R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池 / R-POOL-04 增长飞轮闭环
//   R-RNK-10 个人积分终生上榜（积分口径见 rules/pools.json）
//   顶层文档 §3.1 S2 —— 一切按 edition（届期）隔离：多期多城复制不改表结构
//
// ⛔ 本阶段【只做底座，不做前台页面】（设计文档 §1.2）：只有仓储 + 同步服务 + 只读 API。
// ⛔ 同步是【幂等重建】：按派生源全量重算并覆盖，不是增量累加。
// ⛔ 派生值只有一个计算点：src/domain/pool-derive.js。
import { randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { derivePoolProjects, derivePoolTalents, derivePoolResources, aggregatePersonalPoints } from '../domain/pool-derive.js';
import * as poolRepo from '../db/repo/pools.js';
import * as srcRepo from '../db/repo/pool-sources.js';
// ⛔ 事务助手复用 P4 的 withTransaction（src/db/tx.js，SAVEPOINT），**不再自建一份**：
//    自建 BEGIN IMMEDIATE 的版本在「调用方已经开了事务」时会抛
//    "cannot start a transaction within a transaction"，而 Task 4 的
//    POST /api/pools/sync 极可能把同步包在别的事务里 —— 同一件事两处实现，
//    正是「同一动作在两份材料里被标成一手与二手」的同构风险。
//    依据：本计划偏差章节 F.2（P5 消费 P4 的 src/db/tx.js）；设计文档 §11「事务回滚，无部分写入」。
import { withTransaction } from '../db/tx.js';

function nowIso(now) {
  return now ?? new Date().toISOString();
}

function requireEdition(editionId) {
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  return editionId;
}

function packageStatuses(rules) {
  const list = rules?.pools?.packageStatusFilter;
  return Array.isArray(list) ? list : [];
}

/**
 * 项目池同步：teams + stage_results + tier_records → pool_projects。
 * 幂等：以（edition_id, team_id）为自然键 upsert，并删掉本届时不再成立的行。
 */
export function syncPoolProjects({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  const source = {
    teams: srcRepo.listEditionTeams(db, editionId),
    packages: srcRepo.listEditionPackages(db, editionId, { statuses: packageStatuses(rules) }),
    stageResults: srcRepo.listEditionStageResults(db, editionId),
    stages: srcRepo.listEditionStages(db, editionId),
    tierRecords: srcRepo.listEditionTierRecords(db, editionId),
  };
  const rows = derivePoolProjects(source);

  return withTransaction(db, () => {
    const existing = poolRepo.listPoolProjectRows(db, editionId);
    const byTeam = new Map(existing.map((r) => [r.team_id, r]));
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const prev = byTeam.get(row.teamId);
      if (prev) {
        poolRepo.updatePoolProject(db, prev.id, row);
        updated += 1;
      } else {
        poolRepo.insertPoolProject(db, {
          id: randomUUID(), editionId, ...row, now: at,
        });
        inserted += 1;
      }
      byTeam.delete(row.teamId);
    }
    let removed = 0;
    for (const stale of byTeam.values()) {
      poolRepo.deletePoolProject(db, stale.id);
      removed += 1;
    }
    return { editionId, inserted, updated, removed, total: rows.length, at };
  });
}

/**
 * 人才池同步：points_ledger 聚合 → pool_talents。
 * ⭐ 幂等重建：按派生源重算，不是累加。
 * ⭐ 同一用户所有届次的行一起刷新 → 同一人在任何一行里的积分都相同（不做"两份算法"）。
 * ⭐ 写完自检：用【同一个】纯函数重算比对，不一致即抛错。
 */
export function syncPoolTalents({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  // ⚠️ 个人积分口径的**唯一规则来源**是 rules.points（personal 组）：
  //    规则曾散在 rules.pools.talentPointKinds 与 rules.points.personal 两处，
  //    两处口径还不一样 ⇒ 现在只认 rules.points（见 src/domain/personal-points.js）。
  const pointsConfig = rules?.points;

  const editionUsers = srcRepo.listEditionUsers(db, editionId);
  const ledger = [];
  for (const u of editionUsers) ledger.push(...srcRepo.listUserLedger(db, u.id));

  const { rows, warnings } = derivePoolTalents({
    users: editionUsers,
    ledger,
    registrations: srcRepo.listEditionRegistrations(db, editionId),
    pointsConfig,
  });

  return withTransaction(db, () => {
    const allRows = poolRepo.listPoolTalentRows(db, null);
    const rowsOfUser = new Map();
    for (const r of allRows) {
      if (!rowsOfUser.has(r.user_id)) rowsOfUser.set(r.user_id, []);
      rowsOfUser.get(r.user_id).push(r);
    }
    let inserted = 0;
    let updated = 0;
    // 跨届期连带写入的计数：同一个人**别的届期**的行也被一起刷新了
    // （保证「同一人在任何一行里的积分都相同」）—— 这部分写入原来**不计数**，
    // 同步结果里看不见 ⇒ 误以为「什么都没写」。单列一个计数，不混进 updated。
    let updatedOtherEditions = 0;
    for (const row of rows) {
      const mine = rowsOfUser.get(row.userId) ?? [];
      const inThisEdition = mine.find((r) => r.edition_id === editionId);
      if (inThisEdition) {
        poolRepo.updatePoolTalent(db, inThisEdition.id, {
          name: row.name,
          org: row.org,
          totalPoints: row.totalPoints,
          mbaStatus: row.mbaStatus,
          stagesJoined: row.stagesJoined,
          skillsJson: JSON.stringify(row.skills),
        });
        updated += 1;
      } else {
        poolRepo.insertPoolTalent(db, {
          id: randomUUID(),
          editionId,
          userId: row.userId,
          name: row.name,
          org: row.org,
          totalPoints: row.totalPoints,
          mbaStatus: row.mbaStatus,
          stagesJoined: row.stagesJoined,
          skillsJson: JSON.stringify(row.skills),
          now: at,
        });
        inserted += 1;
      }
      // 同一用户其他届次的行一起刷新，保证"同一人在任何一行里的积分都相同"
      for (const other of mine) {
        if (other.edition_id === editionId) continue;
        poolRepo.updatePoolTalent(db, other.id, {
          name: row.name,
          org: row.org,
          totalPoints: row.totalPoints,
          mbaStatus: row.mbaStatus,
          stagesJoined: row.stagesJoined,
          skillsJson: JSON.stringify(row.skills),
        });
        updatedOtherEditions += 1;
      }
    }
    // 本届时不再成立的人（没有积分记录了）从本届时移除
    const alive = new Set(rows.map((r) => r.userId));
    let removed = 0;
    for (const r of allRows) {
      if (r.edition_id !== editionId) continue;
      if (alive.has(r.user_id)) continue;
      poolRepo.deletePoolTalent(db, r.id);
      removed += 1;
    }

    // ⭐ 唯一真源自检：写入后用【同一个】纯函数重算比对。
    // ⚠️ **必须在 withTransaction 回调内**：放在事务外时，事务已经 RELEASE，
    //    此时抛错只能让调用方看到 500，**脏值已经提交**（自检形同虚设）。
    //    放在事务内抛错 ⇒ SAVEPOINT 回滚 ⇒ 脏值一条都不落地。
    for (const r of poolRepo.listPoolTalentRows(db, editionId)) {
      const expect = aggregatePersonalPoints({
        ledger: srcRepo.listUserLedger(db, r.user_id),
        pointsConfig,
      }).byUser[r.user_id];
      if (!expect || Math.abs(expect.total - r.total_points) > 1e-9) {
        throw appError(
          500,
          'POOL_TALENT_POINTS_MISMATCH',
          `人才池积分与积分流水不一致：${r.user_id}（派生值必须只有一个计算点）`,
        );
      }
    }
    return {
      editionId, inserted, updated, updatedOtherEditions, removed, total: rows.length, at, warnings,
    };
  });
}

/** 资源池同步：task_packages → pool_resources（按企业 × 类型分组）。 */
export function syncPoolResources({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  const packages = srcRepo.listEditionPackages(db, editionId, { statuses: packageStatuses(rules) });
  const rows = derivePoolResources({ packages });

  return withTransaction(db, () => {
    const existing = poolRepo.listPoolResourceRows(db, editionId);
    const byKey = new Map(existing.map((r) => [`${r.enterprise_id}::${r.kind}`, r]));
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const key = `${row.enterpriseId}::${row.kind}`;
      const prev = byKey.get(key);
      if (prev) {
        poolRepo.updatePoolResource(db, prev.id, {
          enterpriseName: row.enterpriseName,
          kind: row.kind,
          detail: row.detail,
        });
        updated += 1;
      } else {
        poolRepo.insertPoolResource(db, {
          id: randomUUID(), editionId, ...row, now: at,
        });
        inserted += 1;
      }
      byKey.delete(key);
    }
    let removed = 0;
    for (const stale of byKey.values()) {
      poolRepo.deletePoolResource(db, stale.id);
      removed += 1;
    }
    return { editionId, inserted, updated, removed, total: rows.length, at };
  });
}

function canReadPool(db, viewer, editionId) {
  if (!viewer) return false;
  return can(viewer, 'pool:read', { scopeType: 'edition', scopeId: editionId }, db);
}

function applyLimit(rows, limit) {
  if (!Number.isInteger(limit) || limit <= 0) return rows;
  return rows.slice(0, limit);
}

/** 项目池只读查询。⛔ 列表不满足 → 空数组（200 + 空集）。 */
export function listPoolProjects({ db, filter = {}, viewer }) {
  if (!canReadPool(db, viewer, filter.editionId ?? null)) return [];
  const rows = poolRepo.listPoolProjectRows(db, filter.editionId ?? null);
  return applyLimit(rows, filter.limit).map((r) => ({
    id: r.id,
    editionId: r.edition_id,
    teamId: r.team_id,
    title: r.title,
    industry: r.industry,
    stageReached: r.stage_reached,
    tier: r.tier,
    businessValue: r.business_value,
    summary: r.summary,
  }));
}

/** 人才池只读查询。 */
export function listPoolTalents({ db, filter = {}, viewer }) {
  if (!canReadPool(db, viewer, filter.editionId ?? null)) return [];
  let rows = poolRepo.listPoolTalentRows(db, filter.editionId ?? null);
  if (filter.userId) rows = rows.filter((r) => r.user_id === filter.userId);
  if (Number.isFinite(filter.minPoints)) rows = rows.filter((r) => r.total_points >= filter.minPoints);
  return applyLimit(rows, filter.limit).map((r) => ({
    id: r.id,
    editionId: r.edition_id,
    userId: r.user_id,
    name: r.name,
    org: r.org,
    totalPoints: r.total_points,
    mbaStatus: r.mba_status,
    stagesJoined: r.stages_joined,
    skills: safeParse(r.skills_json),
  }));
}

/** 资源池只读查询。 */
export function listPoolResources({ db, filter = {}, viewer }) {
  if (!canReadPool(db, viewer, filter.editionId ?? null)) return [];
  let rows = poolRepo.listPoolResourceRows(db, filter.editionId ?? null);
  if (filter.enterpriseId) rows = rows.filter((r) => r.enterprise_id === filter.enterpriseId);
  if (filter.kind) rows = rows.filter((r) => r.kind === filter.kind);
  return applyLimit(rows, filter.limit).map((r) => ({
    id: r.id,
    editionId: r.edition_id,
    enterpriseId: r.enterprise_id,
    enterpriseName: r.enterprise_name,
    kind: r.kind,
    detail: r.detail,
  }));
}

function safeParse(raw) {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

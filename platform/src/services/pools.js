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
import { can, isCommitteeActor, listAssignments } from '../auth/permissions.js';
import { derivePoolProjects, derivePoolTalents, derivePoolResources, aggregatePersonalPoints } from '../domain/pool-derive.js';
import * as poolRepo from '../db/repo/pools.js';
import * as srcRepo from '../db/repo/pool-sources.js';
import { listEditionIdsByUser } from '../db/repo/registrations.js';
import { getEdition } from '../db/repo/editions.js';
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

/**
 * 届期必须**真实存在**（F9 · Medium，2026-10-23 审计 §3.4「写端点错误语义不一致」）。
 *
 * ⚠️ 原来这里**只判空**、不判存在性 ⇒ `POST /api/pools/sync` 引用一个**不存在的届期**时，
 *    同步 0 行、回 **200**，像真的一样。
 *    ⇒ 而其它所有带 `editionId` 的写端点都是 **404 EDITION_NOT_FOUND**
 *      （services/team.js 的 createTeam / services/taskPackage.js 的 submitTaskPackage /
 *        services/workflow.js 的 createWorkflow / routes/public-tokens.js 的 resolveEditionId）
 *      ⇒ 同一个「届期不存在」在两个端点上是两种语义，客户端没法据此判断。
 *    ⇒ 口径对齐：**资源不存在 ⇒ 404**，三态状态码（设计文档 §7.3）。
 *
 * ⚠️ 口径与 `services/workflow.js` 的 `createWorkflow`（先查 edition ⇒ 404）**逐字同源**。
 * ⚠️ **单独一个函数、不改 `requireEdition` 的签名**：保持既有调用点逐字不变
 *    （计划块 `docs/superpowers/plans/` 由父会话统一同步；改动既有行会被
 *    `docs/tools/plan-block-audit.mjs` 判成「真重写」⇒ 平白制造计划漂移）。
 */
function requireEditionExists(db, editionId) {
  if (!getEdition(db, editionId)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
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
  requireEditionExists(db, editionId);
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
  requireEditionExists(db, editionId);
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
  requireEditionExists(db, editionId);
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

/**
 * 「这个人能不能读这一届的池」—— **三池读取的唯一闸门**。
 *
 * ⚠️ **F33 的残留面（2026-10-24 评审）**：
 *    F33 第一版只修了「**缺省**届期」那条路径（从报名记录推导、推导不出唯一届期就空集）。
 *    但**显式传 `editionId` 的路径当时没有任何届期校验** ⇒ 只要带上别的届期 id，
 *    这里走的是 `can()` 的**角色分支** —— 而角色授权是**全局**的
 *    （INTERFACES.md:22 明文「超管 / role_capability 授权一律不做行级过滤」）
 *    ⇒ 任何持有 `pool:read` 的登录用户都能读到**其它届期**参赛者的
 *    姓名、单位、积分、MBA 状态、参赛赛段数 ⇒ **届期隔离仍然是破的**。
 *    ⚠️ 角色本身确实持有 `pool:read`（captain / member / enterprise / enterprise_admin
 *    四个角色都有 —— 见 scripts/seed.js）⇒ 光靠 `can()` 表达不了「他属于哪一届」。
 *
 * ⇒ **修法与 F30 / F42 同一把尺子**（同一族根因：角色授权无行级过滤）：
 *   ① 能力点闸（`can`）：他没有 `pool:read` ⇒ 不给；
 *   ② **领域事实闸**：非组委会 ⇒ 他必须**与该届有关联**（报名 / 出题 / 企业确认）。
 *      组委会（admin 角色或超管）可以跨届调度 ⇒ 直接放行。
 *
 * ⚠️ **为什么关联要四条事实的并集**（不是只认报名）：**企业侧不报名** ——
 *    企业通过提交任务卡、在赛段上做企业确认来参与（`submitRegistration` 只面向选手）。
 *    ⇒ 只认报名会把「本该看人才池的企业」挡在门外（业务回归）。
 *    第四条（积分记录）保证「池成员定义」与「读池资格」是**同一个口径**。
 *
 * ⚠️ **失败方向**：拿不到证据 ⇒ **不给**（fail-closed）。
 *    「他与这一届无关」与「他与这一届有关」一样，都是**可以查出来的事实**，
 *    不存在「查不出来 ⇒ 放行」的中间态。
 */
function canReadPool(db, viewer, editionId) {
  if (!viewer) return false;
  if (!can(viewer, 'pool:read', { scopeType: 'edition', scopeId: editionId }, db)) return false;
  // ⚠️ 组委会按**身份**判定（admin 角色 / 超管），与 F30 / F42 / F40 同一口径。
  if (isCommitteeActor(db, viewer)) return true;
  if (!viewer.id) return false;
  // ⚠️ **显式的届期作用域授权，本身就是授权** ⇒ 直接放行。
  //    这条是既有契约（test/pools-sync.test.js「有 edition 作用域授权的用户
  //    读得到本届时，读不到别届」）：`assignments` 里 scope_type='edition'
  //    且 scope_id=该届 ⇒ 授权人**点名了这一届** ⇒ 不需要再叠加领域事实闸。
  //    ⛔ 少了这一条就会把该契约打破（实测：加了领域事实闸后，
  //    那条既有用例从 2 行变成 0 行 ⇒ 作用域授权被领域事实闸覆盖掉了）。
  if (hasEditionScopedGrant(db, viewer.id, 'pool:read', editionId)) return true;
  // ⚠️ 走到这里说明授权来自**角色**（全局）或 **global 授权**（也是全局）
  //    ⇒ 它们表达不了「他属于哪一届」⇒ 必须补一条**领域事实**闸。
  return srcRepo.listPoolEditionIds(db, viewer.id).includes(editionId);
}

/**
 * 他有没有被**显式授予**某个届期的某能力点（`assignments.scope_type='edition'`）。
 *
 * ⚠️ **比较口径与 can() 保持一致**：`scope_id` 是 TEXT 列、`editionId` 可能是数字
 *    ⇒ 统一按**字符串**比较（与 src/auth/permissions.js 的 scopeIdEquals 同款纪律，
 *    否则 can() 说「有权」而这里说「无权」⇒ 两者结论相反 ⇒ 违反 INTERFACES.md:22）。
 */
function hasEditionScopedGrant(db, userId, capability, editionId) {
  if (!userId || editionId === null || editionId === undefined) return false;
  return listAssignments(db, { userId, capability }).some(
    (a) => a.scope_type === 'edition' && String(a.scope_id ?? '') === String(editionId),
  );
}

/**
 * 解析「这次读池属于哪一届」（2026-10-23 审计 F33）。
 *
 * ⚠️ **原来缺 editionId 就是全表**：`listPoolTalentRows(db, null)` 不带 WHERE
 *    ⇒ 登录用户不带 editionId 就能读到**其它届期**的参赛者姓名、单位、积分、MBA 状态、
 *    参赛赛段数 ⇒ **届期隔离形同虚设**（届期隔离是平台级约束：设计文档 §3.1 S2）。
 *    而闸门 `canReadPool` 也拦不住 —— `scopeId` 传 `null` 时，
 *    `pool:read` 的角色授权照样命中（角色授权是全局的，INTERFACES.md:22）。
 *
 * ⇒ 修法：**缺省届期从 viewer 自己的报名记录推导**（他属于哪一届，就只能看哪一届）。
 *    ⚠️ **推导不出唯一届期 ⇒ 不给**（fail-closed）：没报名过、或报过多届的人，
 *    「他该看哪一届」没有唯一答案 ⇒ 列表不满足 ⇒ 返回**空集**（200 + 空集），
 *    绝不能退化成「全表」。
 *
 * ⚠️ **缺省用「报名」、显式用「三条事实的并集」—— 这个不对称是故意的**：
 *    · **缺省**时平台要替用户**猜**「你要看哪一届」⇒ 只按**报名**猜
 *      （他作为**选手**属于哪一届）⇒ 猜不出唯一答案就不给（上面那条 fail-closed）。
 *    · **显式**时用户已经**点名**了哪一届 ⇒ 平台要回答的是「你有没有资格看这一届」
 *      ⇒ 判据是**关联**（报名 / 出题 / 企业确认 / 积分）—— 企业侧不报名，
 *      只认报名会把该看的人才池的企业挡在门外。
 *    ⇒ 两条路径**共用** `canReadPool` 的领域事实闸 ⇒ 缺省推导出来的届期
 *      必然也在关联集合里（报名 ⊂ 关联），不会自相矛盾。
 */
function resolvePoolEditionId(db, viewer, editionId) {
  if (editionId) return editionId;
  if (!viewer?.id) return null;
  const ids = listEditionIdsByUser(db, viewer.id);
  return ids.length === 1 ? ids[0] : null;
}

function applyLimit(rows, limit) {
  if (!Number.isInteger(limit) || limit <= 0) return rows;
  return rows.slice(0, limit);
}

/** 项目池只读查询。⛔ 列表不满足 → 空数组（200 + 空集）。 */
export function listPoolProjects({ db, filter = {}, viewer }) {
  const editionId = resolvePoolEditionId(db, viewer, filter.editionId);
  if (!editionId) return [];
  if (!canReadPool(db, viewer, editionId)) return [];
  const rows = poolRepo.listPoolProjectRows(db, editionId);
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
  const editionId = resolvePoolEditionId(db, viewer, filter.editionId);
  if (!editionId) return [];
  if (!canReadPool(db, viewer, editionId)) return [];
  let rows = poolRepo.listPoolTalentRows(db, editionId);
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
  const editionId = resolvePoolEditionId(db, viewer, filter.editionId);
  if (!editionId) return [];
  if (!canReadPool(db, viewer, editionId)) return [];
  let rows = poolRepo.listPoolResourceRows(db, editionId);
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

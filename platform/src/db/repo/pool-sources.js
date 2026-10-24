// src/db/repo/pool-sources.js — 三池的【派生源】读取
// 依据：INTERFACES.md §6
//   pool_projects  ← teams + stage_results + tier_records（+ task_packages 取标题）
//   pool_talents   ← points_ledger 聚合（+ users / registrations 取档案）
//   pool_resources ← task_packages（企业侧资源）
// ⛔ 只读。本文件不写任何表 —— 派生源是上游阶段的事实，本阶段只能读。
//
// ⚠️ 排序兜底键一律用 **SQLite 隐式 rowid**（写入次序），⛔ 不用 `id` 列：
//    这几张表的 id 全是 randomUUID()（src/db/repo/points.js、tiers.js、registrations.js
//    的头部注释都写明了同一条纪律）—— 拿随机 UUID 当排序键 ⇒ 同一批写入的记录
//    顺序逐次运行都不同 ⇒ 榜单不可复算。
//    依据：硬约束「任何排序兜底键不得用随机 UUID」+ src/db/repo/points.js 的
//    `ORDER BY created_at ASC, rowid ASC` 同款口径。
//    ⛔ rowid 必须**同时**出现在 SELECT 里：域函数要靠它做同刻记录的显式比较，
//    这样「同一份数据无论以什么顺序喂进纯函数，结果都一样」。
export function getEdition(db, editionId) {
  return db.prepare('SELECT * FROM editions WHERE id = ?').get(editionId) ?? null;
}

/**
 * 某人**与哪些届期有关联**（去重、升序）—— 三池读取的届期授权依据。
 *
 * ⚠️ **为什么不能只看报名**（2026-10-24 评审，F33 的残留面）：
 *    F33 的第一版修法把「缺省届期」从 **viewer 自己的报名记录**推导。
 *    但**显式传 `editionId` 的那条路径没有任何届期校验** ⇒ 只要带上别的届期 id，
 *    `canReadPool` 走的是 `can()` 的**角色分支**（角色授权是全局的，
 *    INTERFACES.md:22 明文）⇒ 任何持有 `pool:read` 的登录用户
 *    （captain / member / enterprise / enterprise_admin 四个角色都持有）
 *    都能读到**其它届期**参赛者的姓名、单位、积分、MBA 状态。
 *    ⇒ 修法必须补一条**领域事实**闸（与 F30 / F42 同一把尺子）：
 *      非组委会 ⇒ viewer 必须**与该届有关联**。
 *
 * ⚠️ **为什么关联是四条事实的并集，而不是「报名过」一条**：
 *    **企业侧不报名** —— 企业通过①提交任务卡、②在赛段上做企业确认来参与，
 *    而 `submitRegistration` 只面向选手（种子数据里只有队长/组员报名）。
 *    ⇒ 只认报名会把「本该看人才池的企业」也挡在门外（业务回归）。
 *    ⇒ 四条事实：
 *      ① 报名           registrations(user_id)
 *      ② 出题 / 代提交   task_packages(enterprise_id | submitted_by)
 *      ③ 企业确认        enterprise_confirmations(enterprise_id) → stages.edition_id
 *      ④ 积分记录        points_ledger(user_id)
 *         —— ④ 之所以要加：池成员的定义**本身就是**「该届有积分的人」
 *            （见同文件 listEditionUsers）⇒ 「谁在这个池里」与「谁能看这个池」
 *            必须是**同一个口径**，否则会出现「你在池里，却看不到这个池」。
 *
 * ⚠️ **本函数只如实返回事实，不替调用方决定放不放行**（放行判定在服务层：
 *    src/services/pools.js 的 canReadPool）—— 与同文件 listEditionIdsByUser 同款纪律。
 */
export function listPoolEditionIds(db, userId) {
  return db
    .prepare(
      `SELECT edition_id FROM (
         SELECT DISTINCT edition_id FROM registrations
          WHERE user_id = ? AND deleted_at IS NULL
         UNION
         SELECT DISTINCT edition_id FROM task_packages
          WHERE deleted_at IS NULL AND (enterprise_id = ? OR submitted_by = ?)
         UNION
         SELECT DISTINCT s.edition_id
            FROM enterprise_confirmations ec
            JOIN stages s ON s.id = ec.stage_id
           WHERE ec.deleted_at IS NULL AND ec.enterprise_id = ?
         UNION
         SELECT DISTINCT edition_id FROM points_ledger WHERE user_id = ?
       ) ORDER BY edition_id`,
    )
    .all(userId, userId, userId, userId, userId)
    .map((r) => r.edition_id);
}

export function listEditionTeams(db, editionId) {
  return db
    .prepare('SELECT id, name, task_package_id, tier FROM teams WHERE edition_id = ? AND deleted_at IS NULL ORDER BY id')
    .all(editionId);
}

export function listEditionPackages(db, editionId, { statuses = [] } = {}) {
  const base = `SELECT id, edition_id, enterprise_id, enterprise_name, title, pain_point, expected_delivery,
                       grade, status, is_free_brief, deleted_at
                  FROM task_packages WHERE edition_id = ? AND deleted_at IS NULL`;
  if (!statuses.length) {
    return db.prepare(`${base} ORDER BY id`).all(editionId);
  }
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`${base} AND status IN (${placeholders}) ORDER BY id`).all(editionId, ...statuses);
}

export function listEditionStages(db, editionId) {
  // ⚠️ P2 的 DDL 里 "key" 是带引号的标识符（SQLite 关键字），必须写成 "key" AS stage_key
  return db
    .prepare('SELECT id, "key" AS stage_key, name, kind, starts_at, ends_at, status FROM stages WHERE edition_id = ? ORDER BY starts_at, id')
    .all(editionId);
}

export function listEditionStageResults(db, editionId) {
  return db
    .prepare(
      `SELECT sr.stage_id, sr.team_id, sr.rank, sr.total, sr.points, sr.tied_with
         FROM stage_results sr
         JOIN stages s ON s.id = sr.stage_id
        WHERE s.edition_id = ?
        ORDER BY sr.stage_id, sr.rank, sr.team_id`,
    )
    .all(editionId);
}

export function listStageResultsWithTeams(db, stageId) {
  return db
    .prepare(
      `SELECT sr.team_id, sr.rank, sr.total, sr.points, sr.tied_with, t.name AS team_name
         FROM stage_results sr
         LEFT JOIN teams t ON t.id = sr.team_id
        WHERE sr.stage_id = ?
        ORDER BY sr.rank, sr.team_id`,
    )
    .all(stageId);
}

// tier_records 没有 edition_id → 通过 teams 关联到届期
// ⚠️ ORDER BY 必须带**兜底键**：同一支队的两条段位记录可能 computed_at 完全相同
//    （tier_records 没有 (team_id, computed_at) 唯一约束，重算日志天然允许同刻）。
//    排序键相等时 SQLite **不保证**返回顺序 ⇒ 「取哪条」本来是不确定的。
//    兜底键用 rowid（写入次序）⇒ 与 src/db/repo/tiers.js 的
//    `ORDER BY computed_at DESC, rowid DESC` 同一口径（同刻时后写入的那条算数）。
export function listEditionTierRecords(db, editionId) {
  return db
    .prepare(
      `SELECT tr.team_id, tr.tier, tr.milestone_count, tr.business_signoff_count, tr.computed_at, tr.deleted_at,
              tr.rowid AS rowid
         FROM tier_records tr
         JOIN teams t ON t.id = tr.team_id
        WHERE t.edition_id = ?
        ORDER BY tr.team_id, tr.computed_at, tr.rowid`,
    )
    .all(editionId);
}

export function listEditionLedger(db, editionId) {
  return db
    .prepare(
      `SELECT id, edition_id, stage_id, team_id, user_id, kind, points, created_at
         FROM points_ledger WHERE edition_id = ? ORDER BY user_id, created_at, rowid`,
    )
    .all(editionId);
}

// 终生累计（R-RNK-10）：个人积分跨届期累加
export function listUserLedger(db, userId) {
  return db
    .prepare(
      `SELECT id, edition_id, stage_id, team_id, user_id, kind, points, created_at
         FROM points_ledger WHERE user_id = ? ORDER BY created_at, rowid`,
    )
    .all(userId);
}

export function listEditionUsers(db, editionId) {
  return db
    .prepare('SELECT id, name, org, mba_status FROM users WHERE id IN (SELECT DISTINCT user_id FROM points_ledger WHERE edition_id = ?) ORDER BY id')
    .all(editionId);
}

export function listAllUsers(db) {
  return db.prepare('SELECT id, name, org, mba_status FROM users WHERE active = 1 ORDER BY id').all();
}

export function listEditionRegistrations(db, editionId) {
  return db
    .prepare(
      `SELECT id, user_id, dimension_scores_json, level, created_at, deleted_at,
              rowid AS rowid
         FROM registrations WHERE edition_id = ? ORDER BY user_id, created_at, rowid`,
    )
    .all(editionId);
}

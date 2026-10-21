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

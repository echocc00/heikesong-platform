// src/db/repo/stages.js — 赛段与评委席
// 依据：设计文档 §5.2 / §12 + INTERFACES.md §3 + S7 §3.4（评委池与席构成）
import { randomUUID } from 'node:crypto';

export function insertStage(db, {
  editionId, key, name, kind, startsAt, endsAt, freezeAt = null, scoringConfigKey,
  status = 'draft', now,
}) {
  const id = randomUUID();
  // ⚠️ `stages` 表**没有** created_at 列（created_at 在 stage_reviews / enterprise_confirmations
  //    等「评分行为」表上，赛段本身不是行为）—— 所以这里**不能**多传一个 now，
  //    否则参数个数与占位符对不上 → "column index out of range"。
  //    `now` 保留在签名里是为了调用方接口统一（传不传都行）。
  void now;
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, key, name, kind, startsAt, endsAt, freezeAt, scoringConfigKey, status);
  return getStage(db, id);
}

export function getStage(db, id) {
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(id) ?? null;
}

export function listStages(db, { editionId } = {}) {
  if (editionId) return db.prepare('SELECT * FROM stages WHERE edition_id = ? ORDER BY starts_at').all(editionId);
  return db.prepare('SELECT * FROM stages ORDER BY starts_at').all();
}

/**
 * 赛段**摘要**列表（P7 新增，给前端做赛段选择器 / 赛事时间线）。
 *
 * ⚠️ 为什么另起一个函数而不是直接复用 listStages()：
 *    listStages 返回 `SELECT *`（含 freeze_at / scoring_config_key 等内部字段），
 *    那是对内形状；对外只暴露「哪一段、叫什么、什么时候、什么状态」这四项。
 *    ⛔ 仍然**不做任何可见性过滤** —— 赛段时间线是公开赛事信息，
 *    真正需要按人过滤的是评分与名单（那些走 /api/leaderboard 等端点）。
 */
export function listStageSummaries(db, { editionId } = {}) {
  const sql = `SELECT id, "key" AS key, name, kind, status, starts_at AS startsAt, ends_at AS endsAt
                 FROM stages ${editionId ? 'WHERE edition_id = ?' : ''}
                ORDER BY starts_at, id`;
  return editionId ? db.prepare(sql).all(editionId) : db.prepare(sql).all();
}

/**
 * 赛段**名册**（带队名与任务包标题）—— P8 新增，给前端「评审打分页」用。
 *
 * ⚠️ 为什么不能直接用 `listStageTeams`：
 *    `listStageTeams` 只返回 `{ teamId, packageEnterpriseId, isFreeBrief }` ——
 *    **没有队名**。前端要渲染「队伍名 + 任务包」，没有队名就没法显示。
 *    ⇒ 这里 JOIN 出队名与任务包标题。
 *
 * ⚠️ 名册口径与 listStageTeams **保持一致**（同一张表、同一 edition 口径、同样过滤软删除）：
 *    两个函数口径一旦分叉，评审页看到的队伍就会和计算时算的队伍**不是同一批** ——
 *    那是最难查的一类 bug（榜单里凭空少一支队）。
 *
 * ⚠️ **排序兜底键用 SQLite 隐式 `rowid`**（全局约束）：
 *    `t.id` 是 `crypto.randomUUID()` ⇒ **随机 UUID** ⇒ 排序随机 ⇒ 列表顺序每次刷新都可能变。
 *    `created_at` 相等时由 `rowid`（插入顺序）兜底 ⇒ 顺序确定。
 */
export function listStageTeamRows(db, stageId) {
  return db
    .prepare(
      `SELECT t.id AS team_id, t.name AS team_name, t.task_package_id,
              tp.title AS package_title, tp.enterprise_id AS package_enterprise_id,
              COALESCE(tp.is_free_brief, 0) AS is_free_brief
       FROM teams t
       LEFT JOIN task_packages tp ON tp.id = t.task_package_id
       WHERE t.edition_id = (SELECT edition_id FROM stages WHERE id = ?)
         AND t.deleted_at IS NULL
       ORDER BY t.created_at, t.rowid`,
    )
    .all(stageId)
    .map((r) => ({
      id: r.team_id,
      name: r.team_name,
      taskPackageId: r.task_package_id ?? null,
      taskPackageTitle: r.package_title ?? null,
      enterpriseId: r.package_enterprise_id ?? null,
      isFreeBrief: !!r.is_free_brief,
    }));
}

/**
 * 默认利益冲突声明正文（评委被分配到赛段时即签署）。
 * 评委可另行声明存在冲突 → `has_conflict = 1` → 逐案回避（R-JDG-09 / R-JDG-18）。
 */
export const DEFAULT_CONFLICT_STATEMENT =
  '本人确认与本届参赛队伍及其出题企业不存在利益关系；如存在关联，本人将主动申报并逐案回避。';

/**
 * 把评委分配到赛段。
 *
 * ⚠️ 父代理预审修正（Important，R-JDG-18：**机制写下来了，但没接线**）：
 *    原来这里只 `INSERT stage_judges` —— `conflict_declarations` 表建了、
 *    `stage_judges.conflict_declared_at` / `conflict_declaration_id` 两列也留了，
 *    却**没有任何代码写入或读取它们** → 需求溯源表里的 R-JDG-18
 *    「评委须签署利益冲突声明」在产品上**静默失效**，CI 全绿。
 *    与 P1 Task 3 的 A1（`registration:write` 被注册却从不校验）、
 *    P1 Task 4 的 T4-5（未做六维评估也能签 A 级）**同一类病根**。
 *    现在：**分配评委即签署声明** —— 声明落 `conflict_declarations`，
 *    并把声明 id 与签署时间回填到 `stage_judges`。
 *
 * ⚠️ 两条 INSERT 必须在**同一个事务**里 —— 否则「声明写了但席位没写成」会留下孤儿声明。
 */
export function assignStageJudge(db, {
  stageId, userId, seat, scopeType = 'global', scopeId = null, now, declaration = null,
}) {
  const declarationId = randomUUID();
  const nested = db.isTransaction === true;
  if (!nested) db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO conflict_declarations (id, stage_id, judge_id, declared_at, has_conflict, statement, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      declarationId, stageId, userId, now,
      declaration?.hasConflict === true ? 1 : 0,
      declaration?.statement ?? DEFAULT_CONFLICT_STATEMENT,
      now,
    );
    db.prepare(
      `INSERT INTO stage_judges (stage_id, user_id, seat, scope_type, scope_id, assigned_at,
                                 conflict_declared_at, conflict_declaration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(stageId, userId, seat, scopeType, scopeId, now, now, declarationId);
    if (!nested) db.exec('COMMIT');
  } catch (err) {
    if (!nested) db.exec('ROLLBACK');
    throw err;
  }
  return listStageJudges(db, stageId);
}

/** 评委池：seat = judge 专家席 / enterprise 企业席 / observer 观察员（无投票权） */
export function listStageJudges(db, stageId) {
  return db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? ORDER BY user_id').all(stageId);
}

export function getStageJudge(db, stageId, userId) {
  return db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?').get(stageId, userId) ?? null;
}

/**
 * 某赛段的队伍名册（需要 P1 的 teams / task_packages）。
 * ⚠️ 表未就绪（P1 尚未落地）时**抛错**，由调用方兜底 —— 仓储层不吞异常。
 */
export function listStageTeams(db, stageId) {
  return db
    .prepare(
      `SELECT t.id AS team_id, tp.enterprise_id AS package_enterprise_id,
              COALESCE(tp.is_free_brief, 0) AS is_free_brief
       FROM teams t
       LEFT JOIN task_packages tp ON tp.id = t.task_package_id
       WHERE t.edition_id = (SELECT edition_id FROM stages WHERE id = ?)
         AND t.deleted_at IS NULL
       ORDER BY t.created_at, t.rowid`,
    )
    .all(stageId)
    .map((r) => ({
      teamId: r.team_id,
      packageEnterpriseId: r.package_enterprise_id ?? null,
      isFreeBrief: !!r.is_free_brief,
    }));
}

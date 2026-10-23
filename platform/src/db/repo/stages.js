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

/**
 * 改赛段配置（**逆向路径**：改配置）。
 *
 * ⚠️ 为什么没有 `updated_at` 列：`stages` 表（003_review.sql）**只有** created 语义上的
 *    「赛段本身不是行为表」这一口径 —— 详见 insertStage 的注释。
 *    ⇒「什么时候改的」由 `audit_log` 的 `stage.update` 承担（可复算，见设计文档 §12），
 *      **不在 stages 表上另开一列**（那会让「表结构 = 事实」这条口径分叉）。
 *
 * ⛔ **只改这五项**：name / starts_at / ends_at / freeze_at / scoring_config_key。
 *    `id` / `edition_id` / `key` / `kind` / `status` **不可改**：
 *    · key 与 edition 变了 = 这个赛段「变成另一个赛段」⇒ 历史评分全部张冠李戴；
 *    · kind 变了 = 权重表与席构成的语义变了（同上）；
 *    · status 的迁移（draft → open → frozen → computed）是**独立的动作**，
 *      不塞进「改配置」里（那会让「改个名字」顺手把赛段开闸了）。
 *
 * @param {*} db
 * @param {string} id 赛段 id
 * @param {string|null} [name] 传 undefined = 不改；传 null = 清空（本表这几列都不允许 null，调用方保证）
 * @returns {object} 改完后的赛段行
 */
export function updateStageConfig(db, {
  id, name, startsAt, endsAt, freezeAt, scoringConfigKey,
}) {
  const sets = [];
  const params = [];
  // ⚠️ 用 `undefined` 判「有没有传」而不是 `null`：
  //    freeze_at 允许为 null（未设冻结时间），传 null 是「清空」而不是「不改」。
  const put = (col, val) => {
    if (val === undefined) return;
    sets.push(`${col} = ?`);
    params.push(val);
  };
  put('name', name);
  put('starts_at', startsAt);
  put('ends_at', endsAt);
  put('freeze_at', freezeAt);
  put('scoring_config_key', scoringConfigKey);
  if (!sets.length) return getStage(db, id);
  params.push(id);
  db.prepare(`UPDATE stages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getStage(db, id);
}

/**
 * 撤掉一个评委席（**逆向路径**：撤评委）。
 *
 * ⚠️ **只删 stage_judges 一行，不删 conflict_declarations**：
 *    利益冲突声明是「事前签署」的历史事实（R-JDG-17：赛后 6 个月可查），
 *    撤席不等于「这份声明没发生过」⇒ 删掉它就是篡改审计证据。
 *    （声明表对 stage_judges 没有外键 ⇒ 留着不会孤儿。）
 *
 * @returns {number} 实际删除的行数（0 = 本来就没分配）
 */
export function removeStageJudgeRow(db, { stageId, userId }) {
  const res = db
    .prepare('DELETE FROM stage_judges WHERE stage_id = ? AND user_id = ?')
    .run(stageId, userId);
  return Number(res?.changes ?? 0);
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
  // ⚠️ E158：补 freeze_at / scoring_config_key 两个字段。
  //    起因：「赛段配置」页（设计 §9「赛段配置与权重表」）刷新后要能回填
  //    「冻结时间」与「用的哪张权重表」—— 摘要里没有这两项 ⇒ 页面只能把
  //    PATCH 的 body 留空（服务端语义「不传=不改」），改配置时**看不出当前值**。
  //    ⛔ 公开面不变宽：freezeAt 是赛程信息（与 startsAt/endsAt 同类）；
  //       scoringConfigKey 只是「用 initial 还是 final 这张权重表」——
  //       而两张权重表的维度与权重早已由 `GET /api/event-info` 公开。
  const sql = `SELECT id, "key" AS key, name, kind, status, starts_at AS startsAt, ends_at AS endsAt,
                       freeze_at AS freezeAt, scoring_config_key AS scoringConfigKey
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
 * 评委**候选池**（组委会派评委时可选的人）。
 *
 * ⚠️ 为什么不用 `listAllUsers`（pool-sources.js）：
 *   那个函数返回**全部在册用户**（不分角色、不分届期），机器闸的 allow.json 已把它
 *   明确判为「未被消费是语义上正确的结果」—— 顶层文档 §3.1 S2「一切按 edition 隔离」。
 *   ⇒ 评委候选池**不是「全部用户」**，而是「**持有评委类角色**的人」。
 *
 * ⚠️ 角色集合的来源（P0 seed.js 的 ROLE_CAPABILITIES）：
 *   `judge` 专家席 / `enterprise` 企业席 / `observer` 观察员（无投票权）。
 *   ⛔ 角色本身**不带 edition_id**（一人可跨多届当评委）⇒ 这里不做届期过滤，
 *     与 S2 的隔离要求不冲突：S2 隔离的是**参赛者/队伍/积分**这类赛事数据，
 *     评委是**组委会资源**，跨届复用是正常的。
 *
 * ⚠️ 排序兜底键用 SQLite 隐式 `rowid`（全局约束）：
 *   `u.created_at` 相等时由 `rowid`（插入顺序）兜底 ⇒ 顺序确定，不随机。
 *
 * @param {object} db
 * @returns {Array<{id: string, name: string, org: string|null}>}
 */
export function listStageJudgeCandidates(db) {
  return db
    .prepare(
      `SELECT DISTINCT u.id AS id, u.name AS name, u.org AS org
         FROM users u
         JOIN user_roles r ON r.user_id = u.id
        WHERE u.active = 1
          AND r.role_key IN ('judge', 'enterprise', 'observer')
        ORDER BY u.created_at, u.rowid`,
    )
    .all();
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

// src/db/repo/signoff-board.js — 企业签字台 / 企业双签清单的读端点 SQL
//
// ⚠️ **为什么这个文件存在（P10 · W4-b）**：
//   P9 真机取证发现 31 个「只有接口没有界面」的功能点。企业签字这条线上：
//     · 里程碑签字 `POST /api/milestones/:id/signoff` —— **有写端点，无读端点**；
//     · 撤回签字 `POST /api/milestones/:id/signoff/withdraw` —— **有写端点，无读端点**；
//     · 企业双签 `POST /api/stages/:stageId/enterprise-confirmations` —— **有写端点，
//       「谁来签第二签（跨领域评委）」这一关键信息没有任何读出口**。
//   而前端要调这两个写端点，**必须**先拿到两个 id：
//     · `milestoneId`（写端点的路径参数）；
//     · `signoffId`（撤回请求体的字段）。
//   现有的读端点一个都不给：
//     · `GET /api/teams/:id/performance-card` → items 只有 key/label/achieved/signed（**无 id**）；
//     · `GET /api/teams/:id` → milestones 来自 `teams.milestones_json`（**只有 key/label/countsTowardTier**）；
//     · `GET /api/stages/:stageId/review-board` → 只有 stage/dimensions/teams/myScores/progress（**无评委名单**）。
//   ⇒ 「只有接口没有界面」不是「少一个按钮」，是**连点都点不出来**。
//   ⇒ 这里补**读口**：可见性过滤全部落在 SQL 的 WHERE 里（不是查全量再在 JS 里 filter ——
//     见 src/auth/permissions.js 顶部的「权限过滤必须在 SQL 的 WHERE 里」约束）。
//
// ⛔ **SQL 只放这一层**（全局约束「所有 SQL 字符串必须收在 platform/src/db/repo/ 下」，
//    机器闸：platform/test/sql-boundary.test.js）。
//
// ⚠️ **确定性排序是全局约束**：所有 ORDER BY 都必须带兜底键。
//   本文件的 id 全部是 `crypto.randomUUID()`（**随机 UUID**）⇒ 拿 id 排序 = 每次刷新顺序都可能变
//   （与 src/db/repo/teams.js 里那条注释同一个教训）。
//   ⇒ 兜底键统一用 SQLite 的隐式 `rowid`（插入顺序，单调递增）。

/**
 * 企业出题的队伍（含届期）—— 用来判「这个企业席能签哪些队的里程碑」。
 *
 * ⚠️ 口径与 `listSignoffWorklist` 里的 `tp.enterprise_id = ?` **必须一致**：
 *    两个口径一旦分叉，服务端就会返回「我能签的队」与「实际列出来的队」不是同一批
 *    （最典型的「榜单里凭空少一支队」类 bug）。
 *
 * @param {string} enterpriseId 出题企业的 user id
 * @returns {Array<{teamId:string, editionId:string, teamName:string}>}
 */
export function listEnterprisesTeams(db, enterpriseId) {
  return db
    .prepare(
      `SELECT t.id AS team_id, t.edition_id, t.name AS team_name
         FROM teams t
         JOIN task_packages tp ON tp.id = t.task_package_id
        WHERE tp.enterprise_id = ? AND t.deleted_at IS NULL
        ORDER BY t.created_at, t.rowid`,
    )
    .all(enterpriseId)
    .map((r) => ({ teamId: r.team_id, editionId: r.edition_id, teamName: r.team_name }));
}

/**
 * 里程碑签字台清单（⛔ 可见性在 SQL 里过滤）。
 *
 * ⚠️ **「有效签字」的口径**：一个里程碑可能被签过多次（签 → 撤回 → 再签），
 *   所以「当前有效的那一条」必须**按规则挑**，不能随便取一条：
 *     ① 还有没被撤回的（revoked_at IS NULL）⇒ 取其中**最新**的；
 *     ② 全被撤回了 ⇒ 取**最近**被撤回的那一条（前端据此显示「已撤回」）。
 *   实现：CTE 里用 `ROW_NUMBER() OVER (PARTITION BY s.milestone_id
 *                      ORDER BY (s.revoked_at IS NULL) DESC, s.signed_at DESC, s.rowid DESC)`
 *   —— 未撤回的排前面，组内按签字时间倒序，最后用 rowid 兜底（确定性）。
 *
 * ⚠️ **签字人不公开**（R-ENT-04「签字不公开」）：
 *   这里**只回传签字内容（department / content）**，不回传签字人姓名。
 *   「是不是我签的」用布尔位 `signoff_enterprise_id === viewer.id` 在服务层判断。
 *
 * @param {object} o
 * @param {string} o.enterpriseId       当前用户 id
 * @param {string[]|null} o.editionIds  届期白名单（null = 不按届期过滤）
 * @param {boolean} o.includeAllTeams   true = 组委会视角（不过滤「谁出的题」）
 * @param {boolean} o.includeAllSignoffs true = 组委会视角（看**任何人**的签字）
 * @param {boolean} o.requireStageEdition true = 只看「有赛段」的届期（组委会视角）
 */
export function listSignoffWorklist(db, {
  enterpriseId,
  editionIds = null,
  includeAllTeams = false,
  includeAllSignoffs = false,
  requireStageEdition = false,
}) {
  const ids = (Array.isArray(editionIds) ? editionIds : []).filter(Boolean);
  const editionSql = ids.length
    ? `AND t.edition_id IN (${ids.map(() => '?').join(',')})`
    : '';
  const rows = db
    .prepare(
      `WITH eff AS (
         SELECT s.id, s.milestone_id, s.enterprise_id, s.department, s.content, s.signed_at, s.revoked_at,
                ROW_NUMBER() OVER (
                  PARTITION BY s.milestone_id
                  ORDER BY (s.revoked_at IS NULL) DESC, s.signed_at DESC, s.rowid DESC
                ) AS rn
           FROM milestone_signoffs s
          WHERE (? = 1 OR s.enterprise_id = ?)
       )
       SELECT m.id AS milestone_id,
              m.team_id,
              m.key,
              m.label,
              m.counts_toward_tier,
              t.name AS team_name,
              t.edition_id,
              e.id AS signoff_id,
              e.enterprise_id AS signoff_enterprise_id,
              e.department,
              e.content,
              e.signed_at,
              e.revoked_at
         FROM milestones m
         JOIN teams t ON t.id = m.team_id
         LEFT JOIN task_packages tp ON tp.id = t.task_package_id
         LEFT JOIN eff e ON e.milestone_id = m.id AND e.rn = 1
        WHERE t.deleted_at IS NULL
          AND (? = 1 OR tp.enterprise_id = ?)
          AND (? = 0 OR EXISTS (SELECT 1 FROM stages st WHERE st.edition_id = t.edition_id))
          ${editionSql}
        ORDER BY t.created_at, t.rowid, m.fixed_at, m.key, m.rowid`,
    )
    .all(
      includeAllSignoffs ? 1 : 0,
      enterpriseId,
      includeAllTeams ? 1 : 0,
      enterpriseId,
      requireStageEdition ? 1 : 0,
      ...ids,
    );
  return rows.map((r) => ({
    milestoneId: r.milestone_id,
    teamId: r.team_id,
    teamName: r.team_name,
    editionId: r.edition_id,
    key: r.key,
    label: r.label,
    countsTowardTier: r.counts_toward_tier === 1,
    signoffId: r.signoff_id ?? null,
    signoffEnterpriseId: r.signoff_enterprise_id ?? null,
    department: r.department ?? null,
    content: r.content ?? null,
    signedAt: r.signed_at ?? null,
    revokedAt: r.revoked_at ?? null,
  }));
}

/**
 * 某赛段的企业确认记录（⛔ 可见性在 SQL 里过滤）。
 *
 * ⚠️ **为什么不用 `listEnterpriseConfirmations`**（src/db/repo/enterprise-confirmations.js）：
 *   那个函数按 stage_id 取**全部**企业的确认记录。企业席用它 ⇒ 会看到别家企业的签字
 *   （R-ENT-04「签字不公开」+ R-JDG-06 的 R1「非本赛道签字把该队企业项权重归零」——
 *    看到「别家企业给我们的队签了」对出题企业没有任何可操作性，只会制造混乱）。
 *   ⇒ 这里多一个 enterpriseId 参数，把过滤放进 WHERE。
 *
 * ⚠️ **排序兜底**：ORDER BY created_at, rowid（created_at 常相等 ⇒ rowid 兜底）。
 */
export function listEnterpriseConfirmationRows(db, { stageId, enterpriseId = null }) {
  const base = `SELECT id, stage_id, team_id, enterprise_id, dimension, raw_score,
                       cross_judge_id, signatory_user_id, content, created_at
                  FROM enterprise_confirmations
                 WHERE stage_id = ? AND deleted_at IS NULL`;
  if (enterpriseId) {
    return db
      .prepare(`${base} AND enterprise_id = ? ORDER BY created_at, rowid`)
      .all(stageId, enterpriseId);
  }
  return db.prepare(`${base} ORDER BY created_at, rowid`).all(stageId);
}

/**
 * 某赛段的**跨领域评委候选**（⛔ 排除当前用户自己）。
 *
 * ⚠️ **为什么必须排除「我自己」**：
 *   后端 `POST /api/stages/:stageId/enterprise-confirmations` 明确拒绝
 *   `crossJudgeId === enterpriseId`（400 CROSS_JUDGE_SAME_AS_SIGNATORY，
 *   见 src/http/routes/review.js）。⇒ 前端如果把「我」放进候选里，
 *   用户选了就是一次必失败的请求（真实用户会以为是页面坏了）。
 *   ⇒ 排除在**服务端**做（前端不做可见性判断）。
 *
 * ⚠️ **口径与写端点一致**：写端点只要求 `getStageJudge(stageId, crossJudgeId)` 存在
 *   （**不校验席别**）⇒ 候选表也**不按席别过滤**，否则会出现
 *   「候选表是空的、但后端其实接受」这种前后端口径不一致。
 *   席别（seat）照实回传给前端，由前端**展示**（不拿它做授权判断）。
 *
 * ⚠️ `users.active = 1`：停用的用户不该再当签字人（与 src/db/repo/users.js 的
 *   getUserById 口径一致 —— 那个函数也过滤 active）。
 *
 * ⚠️ 排序：ORDER BY u.name, sj.rowid（name 可能重复 ⇒ rowid 兜底；id 是随机 UUID 不能用来排序）。
 */
export function listStageJudgeCandidates(db, { stageId, excludeUserId = null }) {
  const params = [stageId];
  let excludeSql = '';
  if (excludeUserId) {
    excludeSql = 'AND sj.user_id <> ?';
    params.push(excludeUserId);
  }
  return db
    .prepare(
      `SELECT sj.user_id AS user_id, u.name AS name, sj.seat AS seat
         FROM stage_judges sj
         JOIN users u ON u.id = sj.user_id AND u.active = 1
        WHERE sj.stage_id = ? ${excludeSql}
        ORDER BY u.name, sj.rowid`,
    )
    .all(...params)
    .map((r) => ({ userId: r.user_id, name: r.name, seat: r.seat }));
}

// ⚠️ **登记在案的后端缺口（本任务不改，写在这里免得下一个人再查一遍）**：
//   「企业确认」**没有撤回 / 改签路径** —— 仓储层有 softDeleteEnterpriseConfirmation，
//   但全仓扫描**没有任何调用方**（没有对外端点）；而唯一索引
//   `idx_enterprise_confirmations_cell (stage_id, team_id, dimension, enterprise_id)
//    WHERE deleted_at IS NULL` 又让「同格重复签」直接撞库。
//   ⇒ 一条**缺双签**的企业确认（cross_judge_id 为 NULL）落库后，
//     按 R2（src/domain/enterprise-seat.js）**该项按 0 分计**，且无法从产品内修复。
//   ⇒ 本任务的界面**如实显示**这个状态并指出需要组委会处理（不假装有办法修）。
//   ⇒ 真正的前端流程是「一次提交就带齐双签」（本界面强制选跨领域评委），
//     从源头避免产生「半条确认」。

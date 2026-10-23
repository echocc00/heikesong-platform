// src/auth/permissions.js — 权限判定
// 依据：设计文档 §7.1 / §7.2。
//   权限不靠角色枚举，靠「能力 + 授权记录」。
//   can() 是唯一判定入口；scopeClause() 把行级过滤下推到 SQL。
// ⛔ 本文件**不含裸 SQL**：assignments 的 SQL 收在 src/db/repo/assignments.js
//    （预审修正 I6-2 —— Files 段落声明了这个文件，却没有任何一步创建它；
//     全局约束「SQL 边界」：所有 SQL 收进 src/db/repo/）。
//    唯一例外是 scopeClause() —— 它按契约**生成** WHERE 片段给调用方拼进 SQL，
//    自己不执行任何查询。
import { randomUUID } from 'node:crypto';
import {
  insertAssignment,
  deleteAssignmentById,
  listAssignmentsByUserAndCapability,
  hasRoleCapability,
  capabilityExists,
} from '../db/repo/assignments.js';
import { userExists, getUserById } from '../db/repo/users.js';
import { listUserRoles } from '../db/repo/roles.js';
import { appError } from '../errors.js';

/**
 * 「这个人是不是超管」——**本文件唯一的超管标志口径**。
 *
 * ⚠️ **为什么要有这个函数（2026-10-23 审计 F48）**：
 *    本仓有两种用户形状，两者的超管标志**键名不同**：
 *      · 库行形状（snake_case）：`is_superadmin: 0|1`（`users` 表的列，`getUserById` 的产物）
 *      · 对外形状（camelCase）：`isSuperadmin: boolean`（`toPublicUser()` 的产物）
 *    此前**各写各的**：`can()` 认两种，而 `tier.js` / `performance-card.js` / `workflow.js` /
 *    `milestone.js` **只认 `is_superadmin === 1`**，`signoff-board.js` 认两种
 *    ⇒ 同一个「形状不一致」散落在 5 个文件里（同一口径写多份 ⇒ 必然漂移）。
 *    ⇒ **产出点**（`toPublicUser()`）现在**同时**带两种键 ⇒ 一处改动，全仓的「形状不一致」
 *      一次消掉：拿到对外形状的服务层也能认到超管（不再超管静默降级）。
 *    ⇒ 本文件内也统一走这里（can / canScoped / isCommitteeActor 三处不再各写各的）。
 *
 * ⛔ **只认这两种、且严格比较**（`is_superadmin === 1` / `isSuperadmin === true`）：
 *    放宽成「truthy」会让 `is_superadmin: '0'`（字符串）也被当成超管 —— 失败方向必须是"少给权限"。
 *
 * ⚠️ **已知取舍（不是漏洞，写清楚以免下次又被当成 bug 改掉）**：
 *    本函数**信任传入对象**的超管标志，不查库。理由：
 *      ① `can()` 是全项目**唯一**权限入口；多认一种形状是为了消除「**超管静默降级**」
 *         （症状：管理员登进去什么都点不动，极难定位）；失败方向是 fail-closed（少给权限）。
 *      ② `scopeClause()` 那一侧**只信库**（`su.is_superadmin = 1`）。
 *      ③ **生产链路上 `ctx.user` 永远是库里的行**（`server.js` 用 `getUserById` 装配 ctx）
 *         ⇒ 库行形状下两侧**必然一致**（机器闸见 test/audit-findings.test.js 的 F48 用例）。
 *      ④ 「对象自称超管、但库里没有这一行」⇒ `can()` 放行而 `scopeClause()` 过滤 ——
 *         这是**已知取舍**，不是现网漏洞（没有可达路径能把这样的对象喂进 `ctx.user`）。
 *
 * @param {object|null} user 库行形状或对外形状
 * @returns {boolean}
 */
function isSuperadminUser(user) {
  if (!user) return false;
  return user.is_superadmin === 1 || user.isSuperadmin === true;
}

/**
 * 「组委会」判定：admin 角色（或超管）。
 *
 * ⛔ **为什么不能写成 `can(user, 'team:manage', { scopeType: 'team', scopeId })`**：
 *    `role_capabilities` **没有 scope 列** ⇒ 角色授予的能力点一律是**全局**的
 *    （INTERFACES.md:22 明文：「超管 / role_capability 授权一律不做行级过滤」）。
 *    而 `captain` 角色**也**持有 `team:manage` ⇒ 任何队长都能通过「带 scope 的 can()」
 *    ⇒ 「任意队长可汰换他队成员 / 改挂他队任务包」这类**跨队越权**
 *    （2026-10-23 审计 F14 / F29 / F30 / F40 / F42）。
 *    ⇒ 组委会是**身份**（admin 角色），不是「作用域化的能力」⇒ 单独判定。
 *    ⛔ 这**不违反**「判定只有 can() 一个入口」：那条约束管的是**能力点**判定；
 *       身份事实（本队队长 `teams.captain_id`、本组成员 `team_members`、
 *       本企业 `task_packages.enterprise_id`）本来就是各调用点自己判的。
 *
 * @param {object} db
 * @param {object|null} user 用户行或 toPublicUser 形状
 * @returns {boolean}
 */
export function isCommitteeActor(db, user) {
  if (!user || !db) return false;
  if (isSuperadminUser(user)) return true;
  if (!user.id) return false;
  return listUserRoles(db, user.id).includes('admin');
}

/**
 * 「这件事的企业主体是不是你」判定（2026-10-23 审计 F30 / F42）。
 *
 * ⛔ **为什么不能用 `can()` 表达这件事**：
 *    `can()` 判的是**能力点**（这个角色/授权有没有「签字」「重评」这个权限），
 *    而 F30 / F42 的问题是**另一层**：拿到了能力点的企业 A，能不能对**企业 B 的**题动手。
 *    角色能力是全局的（INTERFACES.md:22）⇒ `can()` 对此**表达不了**。
 *    ⇒ 这里判的是**领域事实**（跟 `isCommitteeActor()` 同一个性质）：
 *      ① 提交人本人 —— 他出的题，他当然能重评；
 *      ② 出题企业本人 —— enterprise_id 指向的用户；
 *      ③ 同一企业（org 相同）—— 企业管理员代表本企业行事。
 *
 * ⚠️ **同企业判定要求 `org` 非空**：org 为空 ⇒ 两个不相干的企业账号都算「同企业」吗？
 *    不。空值一律**判否**（fail-closed）—— 宁可少给权限，不可把甲公司当成乙公司。
 *
 * @param {object} db
 * @param {string} actorId 行动者用户 id
 * @param {{enterpriseId?: string|null, submittedBy?: string|null}} subject 归属事实
 * @returns {boolean}
 */
export function isEnterpriseOwner(db, actorId, { enterpriseId = null, submittedBy = null } = {}) {
  if (!db || !actorId) return false;
  if (submittedBy && String(submittedBy) === String(actorId)) return true;
  if (!enterpriseId) return false;
  if (String(enterpriseId) === String(actorId)) return true;
  const actor = getUserById(db, actorId);
  const issuer = getUserById(db, enterpriseId);
  if (!actor || !issuer) return false;
  return Boolean(actor.org) && actor.org === issuer.org;
}

export function grantAssignment(
  db,
  { userId, capability, scopeType, scopeId = null, grantedBy = null },
) {
  // ⛔ 评审修正（Important）：授权前先校验入参。
  //    原来直接 INSERT，让 SQLite 的原始外键错误「FOREIGN KEY constraint failed」
  //    抛到 HTTP 层 —— 既只能回 500（没有 .status），又把表结构暴露给客户端。
  //    这与 I5-3（users.phone 重复）是同一类问题，当时修了，这儿漏了。
  if (!capabilityExists(db, capability)) {
    throw appError(400, 'CAPABILITY_UNKNOWN', `能力点未注册：${capability}`);
  }
  if (!userExists(db, userId)) {
    throw appError(404, 'USER_NOT_FOUND', `用户不存在：${userId}`);
  }
  const id = randomUUID();
  insertAssignment(db, {
    id,
    userId,
    capability,
    scopeType,
    scopeId,
    grantedBy,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export function revokeAssignment(db, assignmentId) {
  return deleteAssignmentById(db, assignmentId);
}

// 契约（INTERFACES.md:76）：listAssignments(db, { userId, capability })
// ⛔ 预审修正（I6-1）：原来写成 (db, userId, capability) —— P1–P6 按契约调用
//    会把对象当 userId 绑定（node:sqlite 抛错/查不到）。统一为契约形式。
export function listAssignments(db, { userId, capability }) {
  return listAssignmentsByUserAndCapability(db, userId, capability);
}

function roleGrants(db, userId, capability) {
  // SQL 在 src/db/repo/assignments.js（hasRoleCapability）
  return hasRoleCapability(db, userId, capability);
}

/**
 * 比较 scope_id：统一按**字符串**比较。
 *
 * ⛔ 终审修正（Important，I-4）：assignments.scope_id 是 TEXT 列，取回是字符串；
 *    而 ctx.scopeId 若来自 parseInt() / 数字字面量就是 number。
 *    原来用严格相等 `row.scope_id === ctx.scopeId` → 字符串 '42' ≠ 数字 42 → false；
 *    但 scopeClause 走 SQL 的**类型亲和** → `a.scope_id = 42` 能匹配上 TEXT '42'。
 *    于是同一个用户：can() 说「没权限」、scopeClause 把行放出来 —— **相反结论**。
 *    这直接违反 INTERFACES.md:22「两者必须给出相同结论」。
 *    （P0 枚举的一致性场景没覆盖数字 id，所以 P0-4 当时判「达标」——
 *      但契约说的是**一般情形**。）
 */
function scopeIdEquals(stored, given) {
  if (stored === null || stored === undefined) return false;
  if (given === null || given === undefined) return false;
  return String(stored) === String(given);
}

export function can(user, capability, ctx = null, db = null) {
  if (!user) return false;
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 —— 传入没有 active 字段的
  //    精简对象 { id, is_superadmin: 1 } 时，被停用的用户会被判为有权。
  //    只有**明确带 active 且为假**才拒绝。
  if (user.active !== undefined && !user.active) return false;
  // ⚠️ 超管标志**同时认两种形状**：仓储层行是 `is_superadmin: 0|1`（snake_case），
  //    toPublicUser() 的对外形状是 `isSuperadmin: boolean`（camelCase）。
  //    can() 是全项目**唯一**权限入口（P1–P6 全部依赖）。若只认一种形状，
  //    调用方传错形状会让**超管静默失去全部权限** —— 症状是"管理员登进去
  //    什么都点不动"，极难定位。多认一种形状，把这类静默降级从根上消除。
  //    （失败方向是 fail-closed：认不出超管只会少给权限，不会多给。）
  //    ⚠️ 口径统一到 isSuperadminUser()（2026-10-23 审计 F48）：全仓只有**一处**判超管，
  //    不再各写各的（同一口径写多份 ⇒ 必然漂移）。
  //    ⚠️ **已知取舍（不是漏洞）**：这一侧信任**传入对象**的超管标志，scopeClause() 那一侧
  //    只信**数据库**（`su.is_superadmin = 1`）。生产链路上 `ctx.user` 永远是库里的行
  //    （server.js 用 getUserById 装配 ctx）⇒ 两侧在生产上**必然一致**；
  //    「对象自称超管但库里不是」是已知取舍（详见 isSuperadminUser 的注释）。
  if (isSuperadminUser(user)) return true;
  if (!db) return false;
  // ⛔ 评审修正（Minor→Important）：缺 user.id 时**不能**拿去绑定 SQLite 参数 ——
  //    node:sqlite 抛 TypeError → 整个请求变 500。
  //    权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉"。
  if (!user.id) return false;

  // 角色能力
  if (roleGrants(db, user.id, capability)) return true;

  // 资源级授权
  return assignmentGrants(db, user, capability, ctx);
}

/**
 * 资源级授权判定（assignments）—— `can()` 的**作用域化那一半**。
 *
 * ⛔ **为什么要有它**（2026-10-23 审计 F14 / F29 / F41）：
 *    `can()` 里「角色能力命中即 return true」，而**角色授权是全局的**
 *    （role_capabilities 没有 scope 列 —— INTERFACES.md:22 明文：
 *      「超管 / role_capability 授权一律不做行级过滤」）。
 *    ⇒ 「带 scope 的 can()」**表达不了**「我对**这一支**队伍有权限」：
 *      只要用户持有该能力点的任意角色（captain / member / observer …），
 *      `can(user, 'team:read', {scopeType:'team', scopeId: 别人的队})` 也是 true
 *      ⇒ **任意登录用户可读任意队伍名单**（F41）、**任意队长可汰换他队成员**（F14）。
 *    ⇒ 需要「作用域受限」时，调用方用 `canScoped()`（只看 assignments）
 *      或 `isCommitteeActor()`（组委会身份），**不要**直接用带 scope 的 can()。
 *
 * @param {object|null} user
 * @param {string} capability
 * @param {{scopeType?: string, scopeId?: any}|null} ctx
 * @param {object} db
 * @returns {boolean}
 */
export function canScoped(user, capability, ctx = null, db = null) {
  if (!user) return false;
  if (user.active !== undefined && !user.active) return false;
  // ⚠️ 与 can() **同口径**（isSuperadminUser）——两者必须给出相同结论。
  if (isSuperadminUser(user)) return true;
  if (!db || !user.id) return false;
  return assignmentGrants(db, user, capability, ctx);
}

/** assignments 表的授权判定（can() 与 canScoped() 共用，保证两者结论一致）。 */
function assignmentGrants(db, user, capability, ctx) {
  const rows = listAssignments(db, { userId: user.id, capability });
  for (const row of rows) {
    if (row.scope_type === 'global') return true;
    if (!ctx) continue;
    if (row.scope_type === ctx.scopeType && scopeIdEquals(row.scope_id, ctx.scopeId)) return true;
  }
  return false;
}

/**
 * 生成行级过滤的 SQL 片段。
 * ⛔ 关键：权限过滤必须在 SQL 的 WHERE 里，不能"先查全量再在 JS 里 filter"，
 *    否则单条读取接口会绕过列表过滤导致越权（设计文档 §7.2 约束 2）。
 *
 * 语义（2026-10-20 预审修正 C6-2 定稿）：
 *   scopeClause 只做**行级过滤** —— 把用户的授权映射到资源表的每一行。
 *   「用户对某一个具体资源有没有权限」是 can() 的职责（走 ctx），不是 scopeClause 的。
 *
 *   模式一（行级，推荐）：传 scopeType + alias
 *     SQL  : ... AND (a.scope_type = 'global' OR (a.scope_type = ? AND a.scope_id = <alias>.id))
 *     params: [userId, capability, scopeType]
 *   模式二（单资源）：传 scopeType + scopeId（不传 alias）
 *     SQL  : ... AND (a.scope_type = 'global' OR (a.scope_type = ? AND a.scope_id = ?))
 *     params: [userId, capability, scopeType, scopeId]
 *     ⚠️ 模式二是**单资源守卫**（回答「用户对 scopeId 这个资源有没有权限」），
 *        用法是配合 `WHERE t.id = ?` 一起用；它本身不是行过滤器 —— 行过滤用模式一。
 *   都不传：只认 global 授权
 *     params: [userId, capability]
 *
 * ⚠️ alias 与 scopeId **互斥**：同时给 → 抛错（fail-fast，不静默挑一个）。
 * ⚠️ 给了 scopeType 但 alias 与 scopeId 都没给 → 抛错（fail-fast）。
 * ⚠️ **params 的个数必须永远等于 SQL 里的占位符个数** —— 2026-10-20 预审实测：
 *    原实现 SQL 3 个占位符却推了 4 个值 → `column index out of range`。
 * ⚠️ 上级作用域**不隐式下推**：edition 授权不自动覆盖其下的 task_package
 *    （要覆盖必须显式再授权一条 task_package 的记录）。
 *
 * ⚠️ 这三个校验抛的是**普通 Error**，不是 AppError —— 终审 Minor M-8 澄清：
 *    它们表达的是**程序员错误**（调用方把参数组合写错了），
 *    而 AppError 表达的是**客户端输入错误**（「客户端提交的东西不合法」这一类要回给用户的领域失败）。
 *    grantAssignment() 同样校验入参却用 AppError，因为它校验的是
 *    **客户端传来的** capability / userId（客户端能触发）；
 *    这里校验的是**调用方在代码里写死的组合**（客户端触发不了）。
 *    两种错误风格是**有意不同**的，不是漏改。
 */
export function scopeClause(userId, capability, { scopeType, scopeId, alias = null } = {}) {
  const hasScopeId = scopeId !== undefined && scopeId !== null;
  if (alias && hasScopeId) {
    throw new Error('scopeClause：alias 与 scopeId 互斥，只能给一个');
  }
  if (scopeType && !alias && !hasScopeId) {
    throw new Error('scopeClause：给了 scopeType 就必须给 alias（行级）或 scopeId（单资源）');
  }
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    // alias 是 SQL 标识符（会被拼进 SQL），必须限制成安全的标识符字符
    throw new Error(`scopeClause：alias 必须是合法 SQL 标识符：${alias}`);
  }

  const scopeCond = [];
  const scopeParams = [];

  if (scopeType) {
    if (alias) {
      scopeCond.push(`(a.scope_type = ? AND a.scope_id = ${alias}.id)`);
      scopeParams.push(scopeType);
    } else {
      scopeCond.push(`(a.scope_type = ? AND a.scope_id = ?)`);
      // ⛔ 终审修正（Important，I-4）：scopeId 统一按**字符串**绑定。
      //    assignments.scope_id 声明为 TEXT。实测（node:sqlite）：
      //    `WHERE scope_id = ?` 绑**整数** 42 匹配不上 TEXT '42'；
      //    绑**字符串** '42' 或写 SQL 字面量 42 才能匹配上。
      //    原因：绑定参数**没有类型亲和**，SQLite 不会把列的 TEXT 亲和
      //    应用到它身上（列↔列比较则会应用）。
      //    不归一的后果：scopeId 来自 parseInt() 时，
      //    scopeClause 说「这行不可见」、can() 说「有权」—— 契约要求的
      //    「两者必须给出相同结论」被打破（INTERFACES.md:22）。
      scopeParams.push(scopeType, String(scopeId));
    }
  }
  const scopeSql = scopeCond.length ? ` OR ${scopeCond.join(' OR ')}` : '';

  // ⛔ 评审修正（Important）：**超管与角色授权不做行级过滤**。
  //    原来这段 SQL 只认 assignments，于是：
  //      超管        → can() = true，但 scopeClause 过滤出 0 行
  //      角色授权用户 → can() = true，但 scopeClause 过滤出 0 行
  //    can() 与 scopeClause 对同一用户给出**相反结论** —— 这直接违反
  //    INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...)」：
  //    一个说"有权限"，另一个说"看不到任何行"。
  //    P0 没有调用方，但 P2 计划明写「行级 scope 由 P3/P4 的 scopeClause 补齐」——
  //    P3/P4 的列表接口一接，超管和角色授权用户就会看到空列表。
  //    设计文档 §7.1 的判定顺序是：超管 → true；role_capability 命中 → true。
  //    两者都是**无作用域**的授权，因此行级过滤对它们一律不设限。
  //
  // ⚠️ 占位符顺序必须与 params 顺序**逐字对应**：
  //    ①users.id(启用) ②assignments.user_id ③assignments.capability
  //    ④scopeType[⑤scopeId] ⑥超管.user_id ⑦角色.user_id ⑧角色.capability
  //
  // ⚠️ **超管这一段只信数据库**（`su.is_superadmin = 1`），而 can() 那一侧
  //    信任**传入对象**的超管标志（isSuperadminUser，两种形状都认）——
  //    这是一处**有意为之的取舍**，不是分歧（2026-10-23 审计 F48）：
  //      · 这一侧生成的是 SQL 片段，**只能查库**（没有「传入对象」可用）；
  //        而 can() 是 JS 函数，可以直接读传入对象。
  //      · 生产链路上 `ctx.user` 永远是库里的行（server.js 用 getUserById 装配 ctx）
  //        ⇒ 两侧在生产上**必然一致**。
  //      · 「对象自称超管但库里不是」⇒ 两侧结论相反 —— 已知取舍，不是现网漏洞
  //        （没有可达路径能把这样的对象喂进 ctx.user）；理由与边界见 isSuperadminUser。
  //      · 机器闸：同一个**真实用户**（库里分别是超管 / 非超管），
  //        can() 与 scopeClause() 的结论必须永远一致（库行形状 + 对外形状都测）——
  //        见 test/audit-findings.test.js 的「F48 …」用例。
  const sql = `(
    EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.active = 1)
    AND (
      EXISTS (SELECT 1 FROM assignments a
               WHERE a.user_id = ? AND a.capability = ?
                 AND (a.scope_type = 'global'${scopeSql}))
      OR EXISTS (SELECT 1 FROM users su WHERE su.id = ? AND su.is_superadmin = 1)
      OR EXISTS (SELECT 1 FROM user_roles ur
                  JOIN role_capabilities rc ON rc.role_id = ur.role_key
                  WHERE ur.user_id = ? AND rc.capability = ?)
    )
  )`;

  return {
    sql,
    params: [userId, userId, capability, ...scopeParams, userId, userId, capability],
  };
}

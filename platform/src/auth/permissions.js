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
import { userExists } from '../db/repo/users.js';
import { appError } from '../errors.js';

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
  if (user.is_superadmin === 1 || user.isSuperadmin === true) return true;
  if (!db) return false;
  // ⛔ 评审修正（Minor→Important）：缺 user.id 时**不能**拿去绑定 SQLite 参数 ——
  //    node:sqlite 抛 TypeError → 整个请求变 500。
  //    权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉"。
  if (!user.id) return false;

  // 角色能力
  if (roleGrants(db, user.id, capability)) return true;

  // 资源级授权
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

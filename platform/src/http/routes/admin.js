// src/http/routes/admin.js — 管理端点（2026-10-24 独立评审补记）
//
// 规则溯源：2026-10-24 独立评审 P0「登录限频的定向 DoS 面」
//   评审原话：「登录限频按手机号 60s/10 次锁定，知道评委手机号的人
//              可以在打分窗口把他锁在门外」。
//   评审给的三个修法里，本仓**采纳两条**、**明确否决一条**：
//   ① 按来源 IP 的独立配额 → **采纳**（src/server.js 的登录路由 +
//      rules/audit.json 的 `loginAttemptByIp` profile）；
//   ② 「账号存在且密码错」与「账号不存在」分别计数 → **否决**：
//      那会让「账号存在」与「账号不存在」的**配额耗尽时机不同**
//      ⇒ 攻击者拿不存在的号试到 N 次拿 429、拿真实号试却还拿 401
//      ⇒ **重新打开了用户枚举**。而本仓在登录路由与
//      src/services/rate-limit.js 里都在**刻意**让这两种情况的
//      **错误码与耗时完全一致**（连 scrypt 都照样跑一遍）。
//      ⇒ 否决理由写在 src/services/rate-limit.js 的 loginSubjectKey 注释里，
//         别只看这里。
//   ③ 管理员手动解锁 → **采纳但改了形态**（本文件）：复核发现「受害者被锁在门外」
//     在本仓语义下**不成立**（正确口令永远能登录）⇒ 「按人解锁」没有用武之地；
//     真正会被挡的是**来源维度**（前置预检，fail-closed）⇒ 端点改为支持
//     `{ all: true }` ⇒ **整体解除登录限频**（限频误伤整个出口时的应急出口）。
//
// ⛔ 权限口径：`audit:write`（裁决复核项与申诉）—— **只有组委会持有**
//    （见 scripts/seed.js 的 ROLE_CAPABILITIES）。
// ⛔ 必须写审计日志：解锁是「**人工干预安全闸**」⇒ 必须留痕（谁、何时、解了谁）。
//    ⛔ 留痕里**只存限频主体的哈希**（`login:<sha256前16位>`）——
//    那张表会进备份 ⇒ 不把明文手机号复制到第二张表（与限频表同一纪律）。
// ⛔ 三态语义：未登录 → 401；无能力点 → 403；手机号不存在 → 404。
import { unlockLoginAttempts, clearAllLoginLimiters } from '../../services/rate-limit.js';
import { getUserByPhone } from '../../db/repo/users.js';
import { insertAuditLogRow } from '../../db/repo/audit-log.js';
import { can } from '../../auth/permissions.js';
import { unauthenticated, forbidden, appError } from '../../errors.js';

function requireLogin(user) {
  if (!user) throw unauthenticated();
}

/**
 * 注册管理端点。
 * @param {object} router 路由表
 * @param {object} deps   { db }
 */
export function registerAdminRoutes(router, { db }) {
  /**
   * POST /api/admin/login-unlock —— 清掉某个手机号的登录限频计数。
   *
   * ⚠️ **为什么这是管理员能力点、而不是「谁都能解锁自己的」**：
   *    如果允许本人自助解锁 ⇒ 攻击者先耗尽受害者配额、再让受害者自助解锁
   *    ⇒ 限频等于没有。⇒ 只能由**组委会**执行（且必须留痕）。
   */
  router.add('POST', '/api/admin/login-unlock', async ({ user, body }) => {
    requireLogin(user);
    if (!can(user, 'audit:write', null, db)) throw forbidden('无权解锁登录限频');

    const all = body?.all === true;

    // ① **整体解除**（应急）：来源维度的预检是**前置**的 ⇒ 某个出口 IP 被误判成
    //    攻击源时，**整个出口的人都会被挡**（含正确口令）⇒ 必须有一条人能立刻
    //    执行的通道。只清**登录**限频；申诉/评分/评委小时配额**不动**。
    if (all) {
      const removed = clearAllLoginLimiters(db);
      insertAuditLogRow(db, {
        actorId: user.id,
        action: 'auth.login_limit_clear_all',
        entity: 'rate_limit',
        entityId: null,
        detailJson: JSON.stringify({ scope: 'login', removed }),
        createdAt: new Date().toISOString(),
      });
      return { status: 200, body: { cleared: removed, scope: 'login' } };
    }

    // ② **按人解锁**
    const phone = String(body?.phone ?? '').trim();
    if (!phone) throw appError(400, 'INVALID_REQUEST', 'phone 必填（或传 all: true 整体解除）');

    const target = getUserByPhone(db, phone);
    if (!target) throw appError(404, 'USER_NOT_FOUND', '该手机号没有对应的用户');

    const result = unlockLoginAttempts(db, phone);

    // ⚠️ 解锁是**人工干预安全闸** ⇒ 必须留痕（谁、何时、解了谁）
    insertAuditLogRow(db, {
      actorId: user.id,
      action: 'auth.login_unlock',
      entity: 'user',
      entityId: target.id,
      // ⚠️ 只存限频主体的哈希，不存明文手机号
      detailJson: JSON.stringify({ subjectKey: result.subjectKey, removed: result.removed }),
      createdAt: new Date().toISOString(),
    });

    return { status: 200, body: { unlocked: result.removed, userId: target.id } };
  });
}

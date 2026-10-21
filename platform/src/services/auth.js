// src/services/auth.js — 账号凭据服务（改口令 / 强制下线）
//
// 依据：
//   · 设计文档 §7.5「强制下线 | POST /api/auth/logout-all 吊销该用户全部 session」
//     —— 这条规格**一直写在设计文档里、但端点没实现**；本文件把它兑现。
//   · 设计文档 §7.5「密码」行：`node:crypto` scrypt / 每用户独立 salt /
//     `timingSafeEqual` 比对（口令哈希与比对都在 src/auth/password.js）。
//
// ⚠️ 为什么必须有「改口令」：
//   口令是 seed **一次定死**的（scripts/seed.js 幂等、不覆盖已有管理员），
//   而平台原来**没有改口令端点** ⇒ 部署方只能一直用 seed 出来的那个初始口令，
//   哪怕它已经出现在日志、截图、聊天记录里。
//   这是**每次部署都会撞上**的产品缺口，不是运维小事。
//
// ⛔ 本文件只做**与 SQL 无关**的判定与编排；SQL 全在 src/db/repo/（全局约束）。
// ⛔ 错误一律走 AppError（INTERFACES.md §0：AppError 是全项目唯一的错误类型）。
//
// ⚠️ 口令策略只约束「**通过本端点设置**的新口令」：
//   存量账号（seed 出来的、历史导入的）仍可照常登录 ——
//   不能因为新增了一条策略就把老账号**锁死**在外。

import { AppError } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { getCredentialsById, updatePasswordHash } from '../db/repo/users.js';
import { revokeAllSessions, revokeAllSessionsExcept } from '../auth/session.js';

/** 新口令最少位数。 */
export const PASSWORD_MIN_LENGTH = 8;
/** 新口令最多位数（防超长口令把 scrypt 拖成 DoS —— 口令是要做 KDF 的输入）。 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * 校验新口令是否符合策略。
 *
 * @param {unknown} newPassword
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
export function checkPasswordPolicy(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    return { ok: false, code: 'PASSWORD_REQUIRED', message: '新口令不能为空' };
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_SHORT',
      message: `新口令至少 ${PASSWORD_MIN_LENGTH} 位`,
    };
  }
  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_LONG',
      message: `新口令最长 ${PASSWORD_MAX_LENGTH} 位`,
    };
  }
  return { ok: true };
}

/**
 * 改口令。
 *
 * 流程：取存量哈希 → 校验**原口令** → 校验新口令策略 → 拒绝与原口令相同
 *      → 写新哈希 → 吊销**其它设备**的会话（当前这次保留）。
 *
 * ⚠️ 为什么原口令错返回 **401** 而不是 400：它是**认证失败**，不是请求不合法
 *    （新口令太弱才是 400）。语义必须分清，客户端才能对症处理。
 * ⚠️ 为什么吊销其它会话：口令泄露的典型后果是「攻击者在别的设备上登录着」。
 *    只改哈希、不吊销那些会话 ⇒ 泄露的口令仍然能用。改完必须让它们失效。
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.userId
 * @param {unknown} args.oldPassword 原口令
 * @param {unknown} args.newPassword 新口令
 * @param {string|null} [args.keepSessionToken] 要保留的当前会话（明文 token）
 * @returns {{ok: true, revokedSessions: number}}
 */
export function changePassword({ db, userId, oldPassword, newPassword, keepSessionToken = null }) {
  const cred = getCredentialsById(db, userId);
  if (!cred || cred.active !== 1) {
    throw new AppError(401, 'UNAUTHENTICATED', '未登录');
  }
  // 原口令错 ⇒ 与登录同一套比对（scrypt + timingSafeEqual）
  if (!verifyPassword(String(oldPassword ?? ''), cred.password_hash)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', '原口令不正确');
  }
  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) {
    throw new AppError(400, policy.code, policy.message);
  }
  // 与原口令相同 ⇒ 不算「改」成功（用户多半是以为改掉了，其实没改）
  if (verifyPassword(String(newPassword), cred.password_hash)) {
    throw new AppError(400, 'PASSWORD_REUSED', '新口令不能与原口令相同');
  }
  updatePasswordHash(db, userId, hashPassword(String(newPassword)));
  const revoked = revokeAllSessionsExcept(db, userId, keepSessionToken);
  return { ok: true, revokedSessions: revoked };
}

/**
 * 强制下线：吊销该用户**全部**会话（含当前这次）。
 *
 * 依据：设计文档 §7.5「强制下线 | POST /api/auth/logout-all 吊销该用户全部 session」。
 * 与改口令的差别：**连当前会话一起删**（语义就是「把他踢下线」）。
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.userId
 * @returns {{ok: true, revokedSessions: number}}
 */
export function logoutAllSessions({ db, userId }) {
  return { ok: true, revokedSessions: revokeAllSessions(db, userId) };
}

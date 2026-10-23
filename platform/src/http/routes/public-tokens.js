// src/http/routes/public-tokens.js — 公开访问令牌的管理端点（签发 / 列表 / 吊销）
//
// 依据：设计文档 §8「公开榜单 API + 赛程日历 iCal 订阅」。
//   两个公开端点**早就存在**（src/http/routes/public.js）：
//     GET /api/public/leaderboard?token=…&editionId=…
//     GET /api/public/calendar.ics?token=…&editionId=…
//   而且**必须带 token**（公开 ≠ 无鉴权）—— 但整个平台**没有任何创建 token 的入口**
//   ⇒ 这两个公开接口实际上谁也用不了。
//   本文件补的就是这条缺失的**管理链路**：签发 / 列表 / 吊销。
// 溯源：INTERFACES.md §6 `public_tokens(token, scope, edition_id, expires_at, created_at)`
//   + src/services/public-api.js（签发与校验）+ src/db/repo/public-tokens.js（仓储）。
//
// ⛔ 三条红线：
//   ① **明文只出现一次**：签发响应里给一次明文；库里只存 SHA-256；列表接口**永远不给明文**。
//      列表给的是「行标识（哈希）+ 不可逆短标识（哈希前 8 位）」—— 两者**都不能当令牌用**
//      （公开接口会把传入值再哈希一次比对：sha256(哈希) ≠ 哈希 ⇒ 拿哈希当令牌必然 403）。
//   ② **权限只由 can() 裁决**（src/auth/permissions.js）：本文件**绝不按角色硬编码**。
//   ③ **三态状态码**（设计文档 §7.3）：列表类不满足 → 200 + 空集；单条不满足 → 404；
//      能力 / 规则被禁用 → 403。领域错误一律 appError(status, code, message, detail)（**status 在前**）。
//
// ⚠️ 本文件**只接线，不重写服务层**：
//    「只存哈希」「明文只返回一次」「scope 白名单」这三条纪律都在
//    src/services/public-api.js 的 createPublicToken 里实现 —— 这里再实现一遍就会漂移。
import { appError } from '../../errors.js';
import { createPublicToken, hashPublicToken } from '../../services/public-api.js';
import {
  deletePublicToken, findPublicToken, listPublicTokens,
} from '../../db/repo/public-tokens.js';
import { writeAuditLog } from '../../audit/log.js';
import { getEdition, listEditions } from '../../db/repo/editions.js';
import { pickCurrentEdition } from './registration.js';

/** 短标识长度：哈希前 8 位（十六进制）—— 够人眼分辨是哪一枚，又不可逆。 */
const TOKEN_HINT_LENGTH = 8;

/** 当前时间（ISO）。抽出来是为了让「同一请求内的时间」一致。 */
function nowIso() {
  return new Date().toISOString();
}

/** 哈希 → 短标识（不可逆，仅供人辨认）。 */
export function tokenHint(tokenHash) {
  return String(tokenHash ?? '').slice(0, TOKEN_HINT_LENGTH);
}

/**
 * 权限闸门：管理公开令牌需要 `stage:compute` 能力点。
 *
 * ⛔ **只走 can()**（src/auth/permissions.js）：权限模型是「能力 + 授权记录」，
 *    不按角色枚举（设计文档 §7.1）—— 本文件**一个字都不许**出现角色名判断。
 * ⚠️ 先判 global（组委会/全局授权），再兜一次 stage（赛段级授权）：
 *    只判 global 会把「只被授权了某个赛段」的账号挡在门外；只判 stage 则全局授权反而进不来。
 *    ⚠️ 现状：这三个端点的路径里**没有** `:stageId` 参数 ⇒ 赛段分支目前拿不到 scopeId
 *    ⇒ 实际生效的是全局授权（含角色能力与超管）。分支保留是为了口径完整、不给后来人留坑。
 */
function assertCanManageTokens(ctx) {
  if (!ctx.user) throw appError(401, 'UNAUTHENTICATED', '未登录');
  const globalOk = ctx.can('stage:compute', { scopeType: 'global' });
  const stageOk = ctx.can('stage:compute', { scopeType: 'stage', scopeId: ctx.params?.stageId ?? null });
  if (!globalOk && !stageOk) {
    throw appError(403, 'FORBIDDEN', '没有管理公开访问令牌的权限（需要 stage:compute 能力点）');
  }
}

/**
 * 届期解析：显式给了 → 不存在就 404；没给 → 取【当届】。
 *
 * ⚠️ **必须复用 registration.js 的 pickCurrentEdition**，不要另写一套：
 *    「当届」的口径（全项目已经统一过一次）= 尚未结束（ends_at >= 今天）的最早一届，
 *    都没有就退回最后一届（src/http/routes/registration.js 的文件头与 server.js 的
 *    resolveEditionId 都用它）—— 另写一套 ⇒ 同一个平台出现两个「当届」。
 */
function resolveEditionId(db, editionId) {
  const wanted = String(editionId ?? '').trim();
  if (wanted) {
    if (!getEdition(db, wanted)) throw appError(404, 'EDITION_NOT_FOUND', '届期不存在');
    return wanted;
  }
  const edition = pickCurrentEdition(listEditions(db));
  if (!edition) throw appError(404, 'EDITION_NOT_FOUND', '尚无届期');
  return edition.id;
}

/**
 * 有效期天数（可选）。
 * ⚠️ **为什么在这里校验**：服务层对不合法的 ttlDays 会**静默回落**到
 *    rules.pools.publicTokenTtlDays ⇒ 调用方以为签了 7 天、实际是 30 天，
 *    而响应里看不出差别。宁可 400 报错，也不给一个「看起来生效其实没生效」的参数。
 */
function parseTtlDays(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw appError(400, 'INVALID_REQUEST', 'ttlDays 必须是正整数（天）');
  }
  return n;
}

/**
 * 过期时间（可选）。
 * ⛔ **必须校验**：非法日期一旦存进库，公开接口的过期判定
 *    `new Date(row.expires_at).getTime() <= now` 会变成 NaN 比较（恒为 false）
 *    ⇒ **一枚永不过期的令牌**。这是安全洞，不能指望服务层兜底。
 */
function parseExpiresAt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw appError(400, 'INVALID_REQUEST', 'expiresAt 必须是合法的日期时间');
  }
  return d.toISOString();
}

/**
 * 注册公开访问令牌的管理端点。
 *
 * ⚠️ 签名只有 router：db / rules 都从 **ctx** 取（server.js 的 ctx 里有 db 与 rules）
 *    ⇒ 集成人只要在 createApp 里加一行 `registerPublicTokenRoutes(router)`。
 *
 * @param {object} router createRouter() 的返回值
 */
export function registerPublicTokenRoutes(router) {
  // ── 签发 ────────────────────────────────────────────────────────
  // ⛔ 响应里的 `token` 是**明文**，只在这里出现一次；库里只存哈希。
  router.add('POST', '/api/public/tokens', async (ctx) => {
    assertCanManageTokens(ctx);
    const body = ctx.body ?? {};
    const editionId = resolveEditionId(ctx.db, body.editionId);
    // ⚠️ scope 缺省 = 'all'；**是否合法由服务层裁决**（rules.pools.publicScopes），
    //    路由层不重复实现白名单 —— 两份白名单必然漂移。
    const scope = body.scope === undefined || body.scope === null || body.scope === ''
      ? 'all'
      : String(body.scope);
    const ttlDays = parseTtlDays(body.ttlDays);
    const expiresAt = parseExpiresAt(body.expiresAt);
    const created = createPublicToken({
      db: ctx.db,
      scope,
      editionId,
      expiresAt,
      ttlDays,
      rules: ctx.rules,
      now: nowIso(),
    });
    // 哈希由**同一个**函数算（services/public-api.js 的 hashPublicToken）
    // ⇒ 与库里存的那一列逐字相同（审计里的 entityId 与短标识都靠它）。
    const tokenHash = hashPublicToken(created.token);
    // ⛔ 审计必须写；⛔ detail 里**绝不能出现明文 token**（只放 scope / 届期 / 短标识）。
    writeAuditLog(ctx.db, {
      actorId: ctx.user.id,
      action: 'public_token.issue',
      entity: 'public_token',
      entityId: tokenHash,
      detail: {
        scope: created.scope,
        editionId: created.editionId,
        tokenHint: tokenHint(tokenHash),
        expiresAt: created.expiresAt,
      },
      now: nowIso(),
    });
    return created;
  });

  // ── 列表 ────────────────────────────────────────────────────────
  // ⚠️ **没有令牌 → 200 + 空数组**（不是 404）：列表类「不满足」按三态口径是空集。
  // ⛔ 列表**绝不给明文**（库里也没有）—— 但也**不能把哈希当令牌发出去**：
  //    哈希不是可用的令牌（公开接口会再哈希一次），发它等于给用户一个坏东西。
  //    ⇒ 只给：scope / 届期 / 过期时间 / 创建时间 / 行标识(id) / 短标识(tokenHint) / 是否已过期。
  router.add('GET', '/api/public/tokens', async (ctx) => {
    assertCanManageTokens(ctx);
    const editionId = ctx.query?.editionId ? String(ctx.query.editionId) : null;
    const rows = listPublicTokens(ctx.db, { editionId });
    const at = Date.now();
    const items = rows.map((row) => ({
      // ⚠️ id 是**行标识**（= 库里那列哈希）：DELETE /api/public/tokens/:id 要用它。
      //    它不是可用的令牌（再哈希一次就对不上）⇒ 泄露它不等于泄露凭据。
      id: row.token,
      scope: row.scope,
      editionId: row.edition_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      tokenHint: tokenHint(row.token),
      expired: new Date(row.expires_at).getTime() <= at,
    }));
    return { items };
  });

  // ── 吊销 ────────────────────────────────────────────────────────
  // ⚠️ **404 语义**：吊销一个不存在的令牌 = 「单条不满足」⇒ 404，
  //    不返回 200 假装成功（否则调用方以为吊销了，它其实还在生效）。
  router.add('DELETE', '/api/public/tokens/:id', async (ctx) => {
    assertCanManageTokens(ctx);
    const id = String(ctx.params?.id ?? '').trim();
    if (!id) throw appError(404, 'NOT_FOUND', '公开访问令牌不存在');
    // 先查出来：审计 detail 要带 scope / 届期（吊销之后就查不到了）。
    const row = findPublicToken(ctx.db, id);
    if (!row) throw appError(404, 'NOT_FOUND', '公开访问令牌不存在');
    const changes = deletePublicToken(ctx.db, id);
    if (!changes) throw appError(404, 'NOT_FOUND', '公开访问令牌不存在');
    // ⛔ 审计必须写；⛔ detail 里**绝不能出现明文 token**。
    writeAuditLog(ctx.db, {
      actorId: ctx.user.id,
      action: 'public_token.revoke',
      entity: 'public_token',
      entityId: id,
      detail: {
        scope: row.scope,
        editionId: row.edition_id,
        tokenHint: tokenHint(id),
      },
      now: nowIso(),
    });
    return { ok: true };
  });
}

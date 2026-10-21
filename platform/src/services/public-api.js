// src/services/public-api.js — 公开榜单 API（无需登录，token 鉴权）与赛程日历
// 依据：INTERFACES.md §6（P5 产出）；设计文档 §8「公开榜单 API + 赛程 iCal 订阅」
//   R-RNK-04 滚动榜单全程公开 + 分层公开；【冲突】C-02 段位公示范围已裁决
//
// ⛔ 本模块【不是"默认给全量"】：公开响应必须先过 applyVisibility（P3 产出），
//    再做字段白名单投影。D 段队伍不公示排名；B 榜评分与签字人不公开；
//    企业名不公示；互评来源不公示。前端隐藏 = 数据已泄露 —— 过滤必须在服务端完成。
import { createHash, randomBytes } from 'node:crypto';
import { appError } from '../errors.js';
import { applyVisibility } from '../domain/visibility.js';
import * as tokenRepo from '../db/repo/public-tokens.js';
import * as srcRepo from '../db/repo/pool-sources.js';

export const PUBLIC_NOTICE =
  'A 榜赛段名次全程公开；D 段不公示排名；B 榜评分与签字人不公开；企业名不公示；互评来源不公示。';

function nowIso(now) {
  return now ?? new Date().toISOString();
}

export function hashPublicToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 签发公开令牌。
 * ⛔ 库里只存 SHA-256（与 P0 的 sessions.token_hash 同一纪律）；明文只在这里返回一次。
 */
export function createPublicToken({
  db, scope = 'all', editionId, expiresAt, now, ttlDays, rules,
}) {
  const at = nowIso(now);
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  const allowed = rules?.pools?.publicScopes ?? ['leaderboard', 'calendar', 'all'];
  if (!allowed.includes(scope)) {
    throw appError(400, 'PUBLIC_SCOPE_INVALID', `scope 必须是 ${allowed.join(' / ')} 之一`);
  }
  const token = randomBytes(32).toString('base64url');
  const ttl = Number.isInteger(ttlDays) && ttlDays > 0
    ? ttlDays
    : (rules?.pools?.publicTokenTtlDays ?? 30);
  const expires = expiresAt ?? new Date(new Date(at).getTime() + ttl * 86400000).toISOString();
  tokenRepo.insertPublicToken(db, {
    token: hashPublicToken(token), scope, editionId, expiresAt: expires, now: at,
  });
  return { token, scope, editionId, expiresAt: expires };
}

/**
 * 校验公开令牌。
 * ⛔ 四种失败一律 403（无 token / 无效 / 过期 / 跨届期 / scope 不符），不返回 401：
 *    公开接口本来就没有"登录"这回事，401 会让调用方误以为该去登录。
 */
export function resolvePublicToken({
  db, token, now, requiredScope = 'all', editionId = null,
}) {
  const at = nowIso(now);
  if (!token || !String(token).trim()) {
    throw appError(403, 'PUBLIC_TOKEN_MISSING', '缺少公开访问 token');
  }
  const row = tokenRepo.findPublicToken(db, hashPublicToken(String(token)));
  if (!row) throw appError(403, 'PUBLIC_TOKEN_INVALID', 'token 无效');
  if (new Date(row.expires_at).getTime() <= new Date(at).getTime()) {
    throw appError(403, 'PUBLIC_TOKEN_EXPIRED', 'token 已过期');
  }
  if (editionId && row.edition_id !== editionId) {
    throw appError(403, 'PUBLIC_TOKEN_EDITION_MISMATCH', 'token 不适用于该届期');
  }
  if (requiredScope && requiredScope !== 'all' && row.scope !== 'all' && row.scope !== requiredScope) {
    throw appError(403, 'PUBLIC_TOKEN_SCOPE_MISMATCH', 'token 权限范围不足');
  }
  return { scope: row.scope, editionId: row.edition_id, expiresAt: row.expires_at };
}

/**
 * 公开榜单。
 * @param db       数据库
 * @param token    公开令牌（query 参数）
 * @param editionId 届期
 * @param rules    规则集（【追加的可选参数】：可见性规则与段位表都来自这里；
 *                 不给就拒绝出数，绝不用"默认口径"凑一份能看的榜单出来）
 * @param now      时间（【追加的可选参数】，便于测试注入）
 */
export function getPublicLeaderboard({ db, token, editionId, rules, now }) {
  const at = nowIso(now);
  if (!rules?.visibility || !rules?.ranks) {
    throw appError(500, 'RULES_MISSING', '缺少可见性规则，拒绝出数（不用默认口径凑数）');
  }
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  resolvePublicToken({ db, token, now: at, requiredScope: 'leaderboard', editionId });

  const warnings = [];
  const stages = srcRepo.listEditionStages(db, editionId);
  const tierByTeam = buildTierMap(srcRepo.listEditionTierRecords(db, editionId));

  const out = stages.map((stage) => {
    const raw = buildStagePayload(db, stage, tierByTeam);
    let filterOk = true;
    let visibleRows = null;
    try {
      // ⛔ 必须显式过可见性过滤（P3 产出）—— 公开接口是最容易泄露的地方
      const visible = applyVisibility({
        payload: raw,
        viewer: { id: null, isPublic: true },
        visibilityConfig: rules.visibility,
        context: { scope: 'rank', public: true, stageId: stage.id, editionId },
      });
      visibleRows = extractRows(visible, raw, warnings, stage.id);
    } catch (err) {
      // 过滤失败不静默：记 warning，并用【严格投影】兜底（宁可少给，不可多给）
      filterOk = false;
      warnings.push({
        code: 'visibility_filter_failed',
        stageId: stage.id,
        message: String(err?.message ?? err),
      });
    }
    let rows = raw.rows;
    if (filterOk && visibleRows) {
      const allowed = new Set(visibleRows.map(identity).filter(Boolean));
      rows = raw.rows.filter((r) => allowed.has(identity(r)));
    }
    return {
      stageId: stage.id,
      stageKey: stage.stage_key,
      stageName: stage.name,
      rows: projectPublicRows(rows, rules, warnings, stage.id),
    };
  });

  return {
    editionId,
    generatedAt: at,
    scope: 'rank',
    notice: PUBLIC_NOTICE,
    warnings,
    stages: out,
  };
}

function identity(row) {
  return row.teamId ?? row.team_id ?? row.id ?? null;
}

function buildTierMap(tierRecords) {
  const map = new Map();
  for (const t of tierRecords) {
    if (t.deleted_at) continue;
    const teamId = t.team_id;
    const at = String(t.computed_at ?? '');
    const prev = map.get(teamId);
    if (!prev || at >= prev.at) map.set(teamId, { at, tier: t.tier });
  }
  return map;
}

function buildStagePayload(db, stage, tierByTeam) {
  const results = srcRepo.listStageResultsWithTeams(db, stage.id);
  const rows = results.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    rank: r.rank,
    total: r.total,
    points: r.points,
    tiedWith: r.tied_with,
    tier: tierByTeam.get(r.team_id)?.tier ?? null,
  }));
  return { scope: 'rank', stageId: stage.id, rows };
}

function extractRows(visible, raw, warnings, stageId) {
  if (!visible || typeof visible !== 'object') {
    warnings.push({ code: 'visibility_payload_shape_unexpected', stageId });
    return raw.rows;
  }
  if (Array.isArray(visible.rows)) return visible.rows;
  if (Array.isArray(visible.teams)) return visible.teams;
  warnings.push({ code: 'visibility_payload_shape_unexpected', stageId });
  return raw.rows;
}

/**
 * 公开字段白名单投影 + 段位下限。
 * ⛔ allowlist（只列要给什么），不是 denylist（列不给什么）—— 后者漏一个字段就是一次泄露。
 * 段位未知 = 视为未达 C 段 = 不公示（fail-closed，宁可少给不可多给）。
 */
function projectPublicRows(rows, rules, warnings, stageId) {
  const order = new Map((rules.ranks?.tiers ?? []).map((t, i) => [t.key, i]));
  const minKey = rules.visibility?.rank?.publicFromTier ?? 'C';
  const minOrder = order.has(minKey) ? order.get(minKey) : 0;
  const out = [];
  let hidden = 0;
  for (const r of rows) {
    const tier = r.tier ?? null;
    const tierOrder = tier && order.has(tier) ? order.get(tier) : -1;
    if (tierOrder < minOrder) {
      hidden += 1;
      continue;
    }
    out.push({
      rank: r.rank ?? null,
      teamName: r.teamName ?? r.team_name ?? null,
      tier,
      total: r.total ?? null,
      points: r.points ?? null,
      tiedWith: r.tiedWith ?? r.tied_with ?? null,
    });
  }
  if (hidden > 0) {
    warnings.push({ code: 'tier_below_public_threshold_hidden', stageId, count: hidden });
  }
  return out;
}

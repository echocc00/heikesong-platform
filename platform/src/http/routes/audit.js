// src/http/routes/audit.js — P4 的 7 个接口
// 依据：INTERFACES.md §5「API（P4）」——路径与语义逐字对齐。
//   GET  /api/audit/computations/:id          计算快照（三件套）
//   GET  /api/audit/computations/:id/diff     复算 diff
//   GET  /api/audit/log                       审计日志
//   GET  /api/audit/flags                     复核队列
//   POST /api/audit/flags/:id/resolve         裁决复核项
//   POST /api/appeals                         提交申诉
//   POST /api/appeals/:id/decide              裁决申诉
// ⛔ 三态语义：列表不满足 → 200 + 空集（服务层已处理）；单条不满足 → 404；未登录 → 401。
// ⛔ 限频触发 → 429 + Retry-After（由 server.js 的错误分支统一加头）。
import { getComputation, recomputeAndDiff, listAuditLog } from '../../services/audit.js';
import { listFlags, resolveFlag } from '../../services/anticheat.js';
import { assertRateLimit } from '../../services/rate-limit.js';
import { withIdempotency } from '../../services/idempotency.js';
import { can } from '../../auth/permissions.js';
import { unauthenticated, forbidden } from '../../errors.js';

function requireLogin(user) {
  if (!user) throw unauthenticated();
}

/**
 * Task 5 的复核与申诉状态机（src/services/review-state.js）由**并行 Task** 落地。
 *
 * ⛔ 这里**不能**用静态 import：server.js 顶层 import 本文件 → 该模块一旦缺失，
 *    **整个平台加载不了**（createApp 抛错 → 全站 500，连只读的审计接口都起不来）。
 *    所以改成**动态 import**：
 *      · 模块在 → 正常调用（Task 5 合入后自动生效，本文件一个字都不用再改）；
 *      · 模块不在 → 503 REVIEW_STATE_UNAVAILABLE（fail closed，绝不静默放行）。
 *
 * ⛔ 期望的调用形态（Task 5「Interfaces」一节逐字对齐，本文件只按这个形状调）：
 *      fileAppeal({ db, subjectType, subjectId, filedBy, reason, now, rules }) → appeal
 *      decideAppeal({ db, appealId, decision, decidedBy, note, now, rules })
 *        → { appeal, transitions, recomputeRequired }
 *      listAppeals({ db, filter, viewer }) → { rows, total }
 */
async function loadReviewState() {
  try {
    return await import('../../services/review-state.js');
  } catch {
    return null;
  }
}

/** Task 5 未落地时的统一响应：503 + 明确的 code（不是 500 通用文案，调用方能分辨）。 */
function reviewStateUnavailable() {
  return {
    status: 503,
    body: {
      error: {
        code: 'REVIEW_STATE_UNAVAILABLE',
        message: '复核与申诉状态机尚未就绪（src/services/review-state.js 未落地）',
      },
    },
  };
}

function pickFilter(query = {}) {
  const out = {};
  for (const key of ['action', 'entity', 'entityId', 'since', 'until', 'status', 'kind', 'stageId', 'subjectType', 'subjectId']) {
    if (query[key] !== undefined && query[key] !== '') out[key] = query[key];
  }
  // ⛔ limit / offset 必须是**有限正整数**：Number('abc') = NaN → 直接绑进 SQL
  //    会让 node:sqlite 抛 TypeError → 整个请求变 500（客户端一个 query 参数就能打挂接口）。
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (Number.isInteger(limit) && limit > 0) out.limit = limit;
  }
  if (query.offset !== undefined) {
    const offset = Number(query.offset);
    if (Number.isInteger(offset) && offset >= 0) out.offset = offset;
  }
  return out;
}

export function registerAuditRoutes(router, { db, rules }) {
  const now = () => new Date().toISOString();

  router.add('GET', '/api/audit/computations/:id', async ({ user, params }) => {
    requireLogin(user);
    return getComputation({ db, id: params.id, viewer: user });
  });

  router.add('GET', '/api/audit/computations/:id/diff', async ({ user, params }) => {
    requireLogin(user);
    if (!can(user, 'audit:read', null, db)) throw forbidden('无权复算');
    return recomputeAndDiff({ db, id: params.id, actorId: user.id, now: now(), rules });
  });

  router.add('GET', '/api/audit/log', async ({ user, query }) => {
    requireLogin(user);
    return listAuditLog({ db, filter: pickFilter(query), viewer: user, rules, now: now() });
  });

  router.add('GET', '/api/audit/flags', async ({ user, query }) => {
    requireLogin(user);
    return listFlags({ db, filter: pickFilter(query), viewer: user });
  });

  router.add('POST', '/api/audit/flags/:id/resolve', async ({ user, params, body }) => {
    requireLogin(user);
    if (!can(user, 'audit:write', null, db)) throw forbidden('无权裁决复核项');
    return resolveFlag({
      db,
      flagId: params.id,
      status: body?.status,
      reviewerId: user.id,
      reason: body?.reason,
      evidence: Array.isArray(body?.evidence) ? body.evidence : [],
      now: now(),
    });
  });

  router.add('POST', '/api/appeals', async ({ user, body }) => {
    requireLogin(user);
    if (!can(user, 'appeal:write', null, db)) throw forbidden('无权提交申诉');
    const reviewState = await loadReviewState();
    if (!reviewState) return reviewStateUnavailable();
    const submit = () => {
      // 限频：申诉提交必须限频。触发即 429 + retryAfterSeconds，⛔ 绝不静默丢包。
      assertRateLimit({
        db,
        subjectKey: `appeal:${user.id}`,
        rule: 'appealSubmit',
        now: now(),
        limits: rules?.audit?.rateLimit,
        subjects: { default: `appeal:${user.id}` },
      });
      return reviewState.fileAppeal({
        db,
        subjectType: body?.subjectType,
        subjectId: body?.subjectId,
        filedBy: user.id,
        reason: body?.reason,
        now: now(),
        rules,
      });
    };
    // 幂等：同一 requestId 重复提交**只生效一次**，重复请求返回**首次的响应**（不重新提一次申诉）。
    // ⚠️ 限频放在 fn() **里面**：重放**不消耗配额、不取提交锁** ——
    //    否则「5 秒提交锁」会把合法重试也打成 429，客户端就分不清
    //    「重复提交（该给我首次的响应）」与「被限频（该等一会儿）」。
    // ⛔ requestId 是**可选**的：不传就走普通提交路径，语义完全不变。
    if (body?.requestId) {
      const out = withIdempotency({
        db,
        key: String(body.requestId),
        scope: `appeal:${user.id}`,
        requestId: String(body.requestId),
        now: now(),
      }, submit);
      return out.result;
    }
    return submit();
  });
  router.add('POST', '/api/appeals/:id/decide', async ({ user, params, body }) => {
    requireLogin(user);
    if (!can(user, 'audit:write', null, db)) throw forbidden('无权裁决申诉');
    const reviewState = await loadReviewState();
    if (!reviewState) return reviewStateUnavailable();
    return reviewState.decideAppeal({
      db,
      appealId: params.id,
      decision: body?.decision,
      decidedBy: user.id,
      note: body?.note,
      now: now(),
      rules,
    });
  });

  // 申诉列表挂在 /api/audit/log 的同族路径下，供委员会用（不新增 INTERFACES 之外的必选接口）
  router.add('GET', '/api/appeals', async ({ user, query }) => {
    requireLogin(user);
    const reviewState = await loadReviewState();
    if (!reviewState) return reviewStateUnavailable();
    return reviewState.listAppeals({ db, filter: pickFilter(query), viewer: user });
  });
}

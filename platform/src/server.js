// src/server.js — 进程入口 + 可测的应用装配
// 溯源需求：R-OPS-06（演示模式挂载 /src/domain/* 与 /rules/*；⛔ 默认不挂 ⇒ 生产部署一律 404）
// 依据：设计文档 §4.1 / §14.1
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { openDatabase } from './db/sqlite.js';
import { applyMigrations } from './db/migrate.js';
import { isRetryableDbError } from './db/tx.js';
import { loadRules, validateRules } from './config.js';
import { createRouter } from './http/router.js';
import { json, error, text } from './http/respond.js';
import { responseHeaders, corsPreflightHeaders } from './http/security-headers.js';
import { registerWorkflowRoutes } from './http/routes/workflow.js';
import { registerPoolsRoutes } from './http/routes/pools.js';
import { registerPublicRoutes } from './http/routes/public.js';
import { readJsonBody } from './http/body.js';
import { serveStatic } from './http/static.js';
import { parseSsePath, openSseStream, sendSseEvent, sendSseComment, reviewEvents } from './http/sse.js';
import { createSession, resolveSession, revokeSession } from './auth/session.js';
import { can } from './auth/permissions.js';
import { verifyPassword, hashPassword } from './auth/password.js';
import { changePassword, logoutAllSessions } from './services/auth.js';
import { assertRateLimit, loginSubjectKey } from './services/rate-limit.js';
import { getUserById, getCredentialsByPhone, toPublicUser } from './db/repo/users.js';
import { listUserRoles } from './db/repo/roles.js';
import { listUserCapabilities } from './db/repo/assignments.js';
import { getStage, getStageJudge, listStageSummaries } from './db/repo/stages.js';
import { listWorkflowSummaries } from './db/repo/workflows.js';
import { appError, AppError } from './errors.js';
import { registerRegistrationRoutes, pickCurrentEdition } from './http/routes/registration.js';
import { registerTaskPackageRoutes } from './http/routes/taskPackage.js';
import { registerTeamRoutes } from './http/routes/team.js';
import { registerReviewRoutes } from './http/routes/review.js';
import { registerMilestoneRoutes } from './http/routes/milestone.js';
import { registerSignoffRoutes } from './http/routes/signoff.js';
import { registerBehaviorRoutes } from './http/routes/behavior.js';
import { registerAuditRoutes } from './http/routes/audit.js';
import { registerPublishRoutes } from './http/routes/publish.js';
import { registerTiebreakRoutes } from './http/routes/tiebreak.js';
import { registerStageRoutes } from './http/routes/stages.js';
import { registerPublicTokenRoutes } from './http/routes/public-tokens.js';
import { getLeaderboard, getRollingLeaderboard } from './services/leaderboard.js';
import { getPerformanceCard } from './services/performance-card.js';
import { getTeamTier, getTierBoard } from './services/tier.js';
import { listEditions, getEdition } from './db/repo/editions.js';
import { writePidFile, removePidFile, writePortFile, removePortFile, readPidFile, isProcessAlive } from './runtime/pidfile.js';

const here = dirname(fileURLToPath(import.meta.url));

// 演示模式的静态挂载：/src/domain/* 与 /rules/* 在 platform/ 下，不在 web/ 下。
// ⛔ 只读、只挂这两个白名单目录，不开放整个 platform/。
//
// ⚠️⛔ **默认不挂**（2026-10-21 漂移审计修正 I-5）：
//    这两个目录里是**领域层算法源码**（打分 / 破同分 / 防作弊判定）与**全部规则配置**
//    （权重表、破同分链、行为分、段位表）。无条件挂载 = 公网可读全部源码与配置。
//    本阶段正是「部署到公网 + nginx + systemd」的阶段，所以这道门必须有。
//    只有显式设了 DEMO_MODE=1 才挂；deploy/ 里的 systemd 与 docker-compose
//    **不得**设 DEMO_MODE=1（生产部署下这两个路径一律 404）。
const DEMO_MOUNTS = process.env.DEMO_MODE === '1' ? [
  { prefix: '/src/domain/', dir: join(here, '..', 'src', 'domain') },
  { prefix: '/rules/', dir: join(here, '..', 'rules') },
] : [];

function serveMounted(req, res) {
  if (!DEMO_MOUNTS.length) return false;
  for (const m of DEMO_MOUNTS) {
    if (!req.url || !req.url.startsWith(m.prefix)) continue;
    const rel = req.url.split('?')[0].slice(m.prefix.length);
    if (!rel) continue;
    // 浅拷贝一个只带 url/headers 的请求代理（serveStatic 只读这两个字段）
    const proxy = { url: `/${rel}`, headers: req.headers || {} };
    if (serveStatic(m.dir, proxy, res)) return true;
  }
  return false;
}

/**
 * ⛔ 评审修正（Important）：登录失败路径的**计时侧信道**。
 *
 * 原来写成 `!!cred && verifyPassword(...)` —— `!!cred` 短路 ⇒ **用户不存在时
 * 根本不跑 scrypt**。scrypt（N=16384）约需 20ms，评审实测
 * 「用户存在 20.18ms / 用户不存在 0.18ms」，**115 倍**差距 ——
 * 攻击者据此枚举手机号是否注册。
 * 规格 I7-1 要求「密码错 / 用户不存在一律 401、不区分二者、避免用户枚举」，
 * 响应层做到了，**时间层没做到** —— 安全目标只完成了一半。
 *
 * 做法：用户不存在时也拿一个**同参数**的哑元哈希跑一次 scrypt，
 * 让两条路径的耗时对齐。哑元哈希延迟生成（不必在模块加载时付这 20ms）。
 */
let dummyPasswordHash = null;
function dummyHash() {
  if (!dummyPasswordHash) dummyPasswordHash = hashPassword('dummy-password-for-constant-time-login');
  return dummyPasswordHash;
}

// 会话 Cookie（设计文档 §7.5）：HttpOnly + SameSite=Lax + Path=/ + Secure(生产)
function sessionCookie(token, maxAge, secure) {
  const parts = [
    `hk_session=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 畸形百分号编码（如 '%E0%A4%A'）会让 decodeURIComponent 抛 URIError。
 * router 内部已把这类段视为「不匹配」，这里再判一次是为了把
 * 「请求本身非法（400）」与「没这个接口（404）」区分开。
 */
function hasMalformedEncoding(path) {
  try {
    decodeURIComponent(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * Allow 头的值：该路径上注册的方法 + HEAD（GET 隐含 HEAD）+ OPTIONS。
 *
 * ⚠️ F27（缺陷报告 2026-10-23 §3.5，:1637-1671）：OPTIONS 原来 404 ⇒ 跨源预检失败。
 *    修法 ② 原文：「在 src/server.js 里统一处理 OPTIONS，回 Allow + Access-Control-Allow-Methods」。
 *    ⚠️ Allow 必须**如实**（RFC 9110 §9.3.2）：只写 GET 的端点不能被列成 POST。
 */
function allowHeader(methods) {
  const set = new Set(methods);
  if (set.has('GET')) set.add('HEAD');
  set.add('OPTIONS');
  return [...set].sort().join(', ');
}

/**
 * 领域错误码：Node 内置错误的 .code（如 ERR_INVALID_ARG_TYPE）不是领域码，
 * 不能原样回给客户端 —— 那会暴露内部实现细节。
 *
 * ⚠️ 终审修正（Important，I-C）：本函数此前**零断言** ——
 *    改成恒返回 'BAD_REQUEST' 全量测试照样全绿。而客户端 `web/api.js`
 *    确实消费 `data.error.code`（用来分流错误），契约 INTERFACES.md「错误」纪律
 *    也明写「HTTP 层只把 .status / .code 转出去，**不外泄** Node 的 ERR_* 与 SQLite 原文」。
 *    导出是为了能直接测这条边界（与 static.js 的 isSameFile 同一手法）。
 */
export function domainCode(err, fallback) {
  const code = err && err.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) && !code.startsWith('ERR_')) {
    return code;
  }
  return fallback;
}

/**
 * 届期解析：显式传了 → 不存在就 404；没传 → 取【当届】（与 /api/registration-criteria 同一口径）。
 * ⚠️ 「当届」= 尚未结束（ends_at >= 今天）的最早一届，都没有就退回最后一届（pickCurrentEdition）。
 *    理由：榜单 / 段位榜都是「本届」视图，前端不必先查一遍届期再传进来。
 */
function resolveEditionId(db, editionId) {
  if (editionId) {
    if (!getEdition(db, editionId)) throw new AppError(404, 'EDITION_NOT_FOUND', '届期不存在');
    return editionId;
  }
  const edition = pickCurrentEdition(listEditions(db));
  if (!edition) throw new AppError(404, 'EDITION_NOT_FOUND', '尚无届期');
  return edition.id;
}

export function createApp({ db, rules, webDir }) {
  // ⛔ 评审修正（Important）：webDir 缺失必须在**构造期**就拒绝。
  //    原来它在第一个静态请求上才炸（serveStatic 在 try/catch 之外）→
  //    未捕获异常 → **整个进程退出**（评审实测退出码 1、客户端零响应）。
  //    这与项目原则「校验不过就拒绝启动，绝不降级为默认值」冲突。
  if (typeof webDir !== 'string' || webDir === '') {
    throw new Error('createApp 缺少 webDir（静态资源目录）');
  }
  // fail-fast：规则不合法直接拒绝启动
  const errors = validateRules(rules);
  if (errors.length) {
    throw new Error(`规则配置校验失败，拒绝启动：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const router = createRouter();
  // 注册 P1 报名端点（提交 / 查询 / 列表 / 改级 / 公开筛选标准）
  registerRegistrationRoutes({ router, db, rules });
  // 注册 P1 任务卡端点（提交 / 列表 / 六维评估 / 分级签约）
  registerTaskPackageRoutes({ router, db, rules });
  // 注册 P1 战队端点（建队 / 我的战队 / 成员增删汰换 / 战队修改）
  registerTeamRoutes({ router, db, rules });
  // P2 评审 API（报名/组队等 P1 路由由 P1 追加，不要互相覆盖）
  registerReviewRoutes(router);
  // P3 写入路由（企业里程碑签字 / 行为分事件）
  registerMilestoneRoutes(router);
  registerBehaviorRoutes(router);
  // P10 · W4-b：企业签字台**读**端点（里程碑签字清单 + 企业双签待签清单）
  // ⚠️ 可见性在服务层过滤（src/services/signoff-board.js）—— 前端只负责呈现。
  registerSignoffRoutes(router);
  // P11 · E149：赛段发榜端点（**计算与发榜是两个独立动作**）
  // ⛔ 原先服务层的 publishLeaderboard 没有任何路由能触达 ⇒ 名次积分 / 段位记录 /
  //    榜单快照 / 发榜审计四样全都不写，段位权益永远不解锁。
  registerPublishRoutes(router);
  // P11 · W2-b：加时陈述 / 一票破同分（服务层 181 行早就写好且测过，**但一直没有路由**）
  // ⛔ 同 E149 的病根：实现齐了、产品路径接不上 ⇒ 破同分的人工环节整条不可用。
  registerTiebreakRoutes(router);
  // P11 · W5：赛段生命周期端点（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
  // ⛔ 真机实测生产库 `stages` = 0 ⇒ 评审打分 / 发榜 / 破同分 / 企业签字台
  //    全部以 `:stageId` 为路径参数 ⇒ **一个都进不去**（E150）。
  //    设计文档 §9 明写「赛段配置与权重表」这个界面，但 §8 的 API 清单里
  //    **没有任何建赛段的端点** ⇒ 这里补上（与 E149 同一个病根：设计漏了一条）。
  registerStageRoutes(router, { db, rules });
  // P11 · W2-c：公开访问令牌的管理链路（签发 / 列表 / 吊销）
  // ⛔ 没有创建入口 ⇒ 公开榜单与公开日历两个接口**谁也用不了**。
  registerPublicTokenRoutes(router);
  // 生产环境 Cookie 加 Secure；开发环境不加（http://127.0.0.1 会被浏览器拒收）
  //
  // ⚠️ COOKIE_SECURE 是**显式覆盖**（不设 = 跟随 NODE_ENV）：
  //    「纯 HTTP + 非标准端口」的对外面（复用既有主机、443 被占时）需要
  //    **既保持 NODE_ENV=production 的其它行为**、又让 Cookie 不带 Secure
  //    （否则浏览器直接拒收 ⇒ 登录失效）。
  //    ⛔ 不设这个变量时行为与以前**完全一致**（跟随 NODE_ENV）。
  //
  // ⚠️ 只有**显式的 'false'** 才关掉 Secure；其它取值（含拼错的 'flase'）
  //    一律按「要 Secure」处理 —— 失败即安全：
  //    拼错 ⇒ 浏览器拒收 Cookie ⇒ 登录失败（症状明显），
  //    而不是「静默把会话 Cookie 明文发出去」（症状不可见）。
  const secureCookies = process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE !== 'false'
    : process.env.NODE_ENV === 'production';

  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));
  // P4 审计 API（7 个接口 + 申诉列表）：计算快照 / 复算 diff / 审计日志 / 复核队列 / 申诉
  registerAuditRoutes(router, { db, rules });

  // ── P3 榜单与积分 ───────────────────────────────────────────
  // ⚠️ 路由优先级由 P0 的 router **逐段比较**决定：静态段胜参数段
  //    （P0 终审 C4-1 修的就是「比参数段个数」那个错版）。
  //    ⇒ '/api/leaderboard/rolling' 与 '/api/leaderboard/tier' 都不会被
  //    '/api/leaderboard/:stageId' 劫持。
  router.add('GET', '/api/leaderboard/rolling', async (ctx) => {
    const editionId = resolveEditionId(ctx.db, ctx.query.editionId);
    return getRollingLeaderboard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
  });
  // ⚠️ 静态段 'tier' 优先于参数段 ':stageId'（router 逐段比较：静态胜参数）
  router.add('GET', '/api/leaderboard/tier', async (ctx) => {
    const editionId = resolveEditionId(ctx.db, ctx.query.editionId);
    return getTierBoard({ db: ctx.db, editionId, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/leaderboard/:stageId', async (ctx) => {
    const scope = ctx.query.scope || 'rank';
    return getLeaderboard({ db: ctx.db, stageId: ctx.params.stageId, scope, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/teams/:id/performance-card', async (ctx) => {
    return getPerformanceCard({ db: ctx.db, teamId: ctx.params.id, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/teams/:id/tier', async (ctx) => {
    return getTeamTier({ db: ctx.db, teamId: ctx.params.id, viewer: ctx.user, rules: ctx.rules });
  });
  router.add('GET', '/api/me', async ({ user }) => {
    if (!user) {
      // ⛔ 终审修正（Important，I-5）：领域错误必须走 AppError。
      //    原来手搓 `new Error()` 再挂 .status/.code —— 运行时行为对，
      //    但 INTERFACES.md:21 定义了 AppError 是**唯一**的错误类型，
      //    P1–P6 的 handler 会照抄本文件 → 树起第二套错误类型，
      //    下游 `e instanceof AppError` 分支就再也进不去了。
      throw appError(401, 'UNAUTHENTICATED', '未登录');
    }
    // ⚠️ P7：带上**角色键**（roles）—— 前端要按角色分区导航（用户端 / 管理员端 / 组委会端），
    //    没有它前端只能做出「所有人看到同一个菜单」的水平导航。
    //    ⛔ roles 只用于导航入口分区，**不是授权依据**（授权仍由 can() 在服务端裁决）。
    // ⚠️ W1-b（DP-105）：再带上**能力点**（capabilities）—— 前端要按能力点拦分区级路由，
    //    授权模型是「能力 + 授权记录」，只看角色会漏掉「被直接授权」的人。
    //    ⛔ capabilities 同样**只是提示**，不是授权依据（服务端仍然是唯一裁决者）。
    return {
      user: toPublicUser(user, listUserRoles(db, user.id), listUserCapabilities(db, user.id)),
    };
  });

  // ── P7：赛段时间线 / 工作流列表（给前端做选择器与入口页）────────────
  // ⚠️ 为什么补这两个只读端点：
  //    打磨前端时发现「赛段榜没有赛段可选」「任务清单页没有入口」——
  //    仓储层本来就有 listStages / listWorkflowsByEdition，只是**没有端点**，
  //    前端只能靠人肉拼 URL ⇒ 页面在生产上是走不通的。
  router.add('GET', '/api/stages', async ({ query }) => {
    // 赛段时间线是公开赛事信息（与 /api/registration-criteria 同口径：公开透明）。
    const editionId = query.editionId ? resolveEditionId(db, query.editionId) : null;
    return { items: listStageSummaries(db, editionId ? { editionId } : {}) };
  });

  router.add('GET', '/api/workflows', async ({ user, query }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    if (!can(user, 'task_package:read', { scopeType: 'global' }, db)) {
      throw appError(403, 'FORBIDDEN', '没有查看任务清单的权限');
    }
    const editionId = resolveEditionId(db, query.editionId);
    return { items: listWorkflowSummaries(db, editionId) };
  });

  // ── P5 路由 ────────────────────────────────────────────────
  registerWorkflowRoutes(router, { db, rules });
  registerPoolsRoutes(router, { db, rules });
  registerPublicRoutes(router, { db, rules });

  // ⛔ 预审修正（I7-1）：P0 原本**没有登录接口** → README 宣称的「能登录的空系统」不成立，
  //    Task 5 产出的 createSession 也没有任何调用方。补上登录/登出。
  router.add('POST', '/api/auth/login', async ({ body }) => {
    const phone = String(body?.phone ?? '').trim();
    const password = String(body?.password ?? '');
    const cred = getCredentialsByPhone(db, phone);
    // 用户不存在与密码错误返回**同一个**错误码 → 避免用户枚举（响应层）
    // ⛔ 而且**耗时也必须一致**（时间层）：用户不存在时照样跑一次 scrypt，
    //    否则两条路径差 100 倍 → 枚举手机号。见 dummyHash() 的注释。
    const passwordOk = verifyPassword(password, cred ? cred.password_hash : dummyHash());
    const ok = !!cred && cred.active === 1 && passwordOk;
    if (!ok) {
      // ⚠️ 限频（F4 附带项）：登录端点原来**完全无限频** ——
      //    实测 30 次错误口令全部 401、零 429 ⇒ 可无限爆破口令。
      //    ⛔ 只统计**失败**的尝试：正常用户登录成功不消耗配额
      //    （否则多设备/多标签页反复登录会被自己的配额挡住）。
      //    配额用尽 ⇒ 429 + Retry-After（server.js 的错误分支统一加头），不再回 401。
      //    ⚠️ 放在口令校验**之后**：先校验、再计数 —— 只有「真的错了」才消耗配额。
      const loginSubject = loginSubjectKey(phone);
      assertRateLimit({
        db,
        subjectKey: loginSubject,
        rule: 'loginAttempt',
        now: new Date().toISOString(),
        limits: rules?.audit?.rateLimit,
        subjects: { default: loginSubject },
      });
      // ⛔ 终审修正（Important，I-5）：同上，必须走 AppError。
      throw appError(401, 'INVALID_CREDENTIALS', '手机号或密码不正确');
    }
    const { token, expiresAt } = createSession(db, cred.id);
    const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return {
      status: 200,
      // ⚠️ P7：登录响应同样带 roles —— 否则登录后前端拿不到角色，
      //    导航要等下一次 /api/me 才分区（用户会看到「刚登录还是访客菜单」）。
      // ⚠️ W1-b（DP-105）：同样带 capabilities —— 否则登录后前端拿不到能力点，
      //    登录完直接点组委会页面会被前端拦下（而服务端其实是放行的）。
      body: {
        user: toPublicUser(
          getUserById(db, cred.id),
          listUserRoles(db, cred.id),
          listUserCapabilities(db, cred.id),
        ),
      },
      headers: { 'Set-Cookie': sessionCookie(token, maxAge, secureCookies) },
    };
  });

  router.add('POST', '/api/auth/logout', async ({ sessionToken }) => {
    if (sessionToken) revokeSession(db, sessionToken);
    return {
      status: 200,
      body: { ok: true },
      headers: { 'Set-Cookie': sessionCookie('', 0, secureCookies) },
    };
  });

  // ── P6 追加：改口令 + 强制下线 ──────────────────────────────────────
  // ⚠️ 为什么这两个端点到现在才补：
  //    设计文档 §7.5 早就写了「强制下线 | POST /api/auth/logout-all」，
  //    但端点清单里从来没有它 —— 规格写了、代码没做。
  //    而「改口令」的缺口更实在：口令是 seed 一次定死的（scripts/seed.js 幂等），
  //    没有改口令端点 ⇒ 部署方只能一直用 seed 出来的初始口令。
  router.add('POST', '/api/auth/password', async ({ user, body, sessionToken }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const r = changePassword({
      db,
      userId: user.id,
      oldPassword: body?.oldPassword,
      newPassword: body?.newPassword,
      // 当前这次会话保留 ⇒ 改完不用立刻重新登录；别的设备上的会话全部作废
      keepSessionToken: sessionToken,
    });
    return { status: 200, body: { ok: true, revokedSessions: r.revokedSessions } };
  });

  router.add('POST', '/api/auth/logout-all', async ({ user }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    // 语义是「把他踢下线」⇒ **含当前会话**一起删
    const r = logoutAllSessions({ db, userId: user.id });
    return {
      status: 200,
      body: { ok: true, revokedSessions: r.revokedSessions },
      headers: { 'Set-Cookie': sessionCookie('', 0, secureCookies) },
    };
  });

  async function handle(req, res) {
    // ⛔ 评审修正（Important）：`handle` 是 async，而 `http.createServer(app.handle)`
    //    **不会接管 rejected promise** → handler 里任何逸出的异常都变成未捕获异常
    //    → 整个服务器进程退出（客户端零响应）。
    //    最外层兜一层：任何异常都变成 500，绝不把进程带走。
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[server]', err);
      try {
        if (!res.headersSent) {
          json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
        } else {
          res.destroy();
        }
      } catch {
        // 连 500 都写不出去（连接已断）—— 只能放弃，不能再抛
      }
    }
  }

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.startsWith('/api/')) {
      try {
        // ⛔ 预审修正（C4-2）：router.match 必须**在 try 块内**。
        //    原来它在 try 之外 → 畸形百分号编码抛出的 URIError 越过 catch
        //    → Node 默认未捕获异常退出 → 整个服务器进程死亡。
        // ── P2：SSE（评审进度推送）────────────────────────────────
        // ⚠️ 必须**独立于 router**，且**在 router.match 之前**：
        //    P0 的 router handler 约定是「返回一个值 → server.js 统一 json() 序列化
        //    并结束响应」；SSE 要**长期持有这条连接**（多次推帧）——
        //    挂到 router 上会被 json() 提前收尾，客户端只收到第一帧就断。
        //    放在 router.match 之前还有第二个原因：SSE 路径**不在 router 里**，
        //    若先 match 会直接走 404 分支。
        const ssePath = req.method === 'GET' ? parseSsePath(url) : null;
        if (ssePath) {
          const sseToken = parseCookie(req.headers?.cookie || '')['hk_session'];
          const sseSession = sseToken ? resolveSession(db, sseToken) : null;
          const sseUser = sseSession ? getUserById(db, sseSession.userId) : null;
          if (!sseUser) {
            error(res, 401, 'UNAUTHENTICATED', '未登录');
            return;
          }
          // ⛔ 权限闸门（父代理预审修正）：**登录还不够**。
          //    进度事件流会暴露「谁在什么时候提交了评分」——
          //    任何登录用户都能订阅任意赛段 = 评委行踪可被任意账号看到。
          //    与 review-state 同一套口径：组委会 / 有 score:read 的人 / 本赛段评委。
          const sseStage = getStage(db, ssePath.stageId);
          const sseIsJudge = sseStage
            ? getStageJudge(db, ssePath.stageId, sseUser.id) != null
            : false;
          const sseAllowed = can(sseUser, 'score:read', { scopeType: 'stage', scopeId: ssePath.stageId }, db)
            || can(sseUser, 'score:read', { scopeType: 'global' }, db)
            || can(sseUser, 'stage:compute', { scopeType: 'stage', scopeId: ssePath.stageId }, db)
            || can(sseUser, 'stage:compute', { scopeType: 'global' }, db)
            || sseIsJudge;
          if (!sseAllowed) {
            error(res, 403, 'FORBIDDEN', '没有订阅评审进度的权限');
            return;
          }
          openSseStream(res);
          const topic = `stage:${ssePath.stageId}`;
          reviewEvents.add(res, topic);
          // ⛔ 客户端断开时必须摘掉订阅者 —— 否则连接泄漏，进程内存单调增长。
          //    同一处把心跳定时器也清掉（否则定时器会一直跑）。
          const heartbeat = setInterval(() => sendSseComment(res, 'ping'), 25000);
          if (typeof heartbeat.unref === 'function') heartbeat.unref();
          res.on('close', () => {
            clearInterval(heartbeat);
            reviewEvents.remove(res);
          });
          // 首帧必须给：EventSource 的 onopen 拿不到业务数据，客户端靠它确认订阅成功。
          sendSseEvent(res, 'connected', { stageId: ssePath.stageId, at: new Date().toISOString() });
          return;
        }
        // ── F27：OPTIONS 统一处理（跨源预检 / 能力探测）────────────
        // ⚠️ 修法（缺陷报告 §3.5 F27 ②）：OPTIONS 原来一律 404 ⇒ 跨源预检直接失败。
        //    现在：**该路径上有注册路由** ⇒ 回 204 + Allow（如实列出支持的方法）
        //    + 预检头（CORS 开启时才有，见 security-headers.js）；
        //    **没有注册路由** ⇒ 仍然 404（OPTIONS 不是万能 204）。
        if (req.method === 'OPTIONS') {
          const methods = router.allowedMethods(url);
          if (!methods.length) {
            error(res, 404, 'NOT_FOUND', `无此接口: ${req.method} ${url}`);
            return;
          }
          const allow = allowHeader(methods);
          res.writeHead(204, {
            ...responseHeaders(req),
            Allow: allow,
            ...corsPreflightHeaders(req, allow),
          });
          res.end();
          return;
        }
        const match = router.match(req.method, url);
        if (!match) {
          // 畸形 URL 编码 → 400（请求本身非法）；真没这个接口 → 404
          if (hasMalformedEncoding(url)) {
            error(res, 400, 'BAD_REQUEST', 'URL 编码非法');
            return;
          }
          error(res, 404, 'NOT_FOUND', `无此接口: ${req.method} ${url}`);
          return;
        }
        const sessionToken = parseCookie(req.headers?.cookie || '')['hk_session'];
        const session = sessionToken ? resolveSession(db, sessionToken) : null;
        // ⛔ 预审修正（C7-2）：resolveSession 返回 { userId, expiresAt }（契约 INTERFACES.md:67），
        //    原来读 session.user_id（undefined）→ node:sqlite 绑定 undefined 抛错 → 500。
        const user = session ? getUserById(db, session.userId) : null;
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
          ? await readJsonBody(req)
          : null;
        const ctx = {
          user,
          session,
          sessionToken,
          db,
          rules,
          params: match.params,
          body,
          query: Object.fromEntries(new URL(url, 'http://x').searchParams),
          can: (capability, c) => can(user, capability, c, db),
        };
        const result = await match.handler(ctx);
        // 原文响应（.ics 等）：P0 的 handler 统一 json() 序列化，这里走 text()
        if (result && typeof result === 'object' && result.__rawText === true) {
          text(res, 200, String(result.body ?? ''), result.contentType || 'text/plain; charset=utf-8');
          return;
        }
        // ⛔ 预审修正（I7-4）：handler 返回约定 ——
        //   undefined → 200（保持原行为）；{ status, body }（可选 headers）→ 按返回值应答。
        if (result && typeof result === 'object' && typeof result.status === 'number') {
          const { status, body: payload } = result;
          if (status === 204) {
            // ⚠️ F28：204 也是一条响应 ⇒ 同样带安全头（口径见 security-headers.js）。
            res.writeHead(204, responseHeaders(req));
            res.end();
            return;
          }
          json(res, status, payload ?? null, result.headers || {});
          return;
        }
        json(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) {
          // ⛔ 预审修正（I7-3）：内部错误原文不外泄 ——
          //    SQLite 错误带表名列名，Node 错误带内部实现细节。只进日志。
          console.error('[server]', err);
          // ⚠️ **SQLite 的并发冲突是可重试的**（F8）：517（SQLITE_BUSY_SNAPSHOT）
          //    与 5/6（BUSY / LOCKED）都是「另一个连接正占着写锁」⇒ 稍后重试即可
          //    ⇒ 回 **503 + Retry-After**，而不是让用户看到一个「服务内部错误」的 500。
          if (isRetryableDbError(err)) {
            json(res, 503, { error: { code: 'DB_BUSY', message: '数据库正忙，请稍后重试' } }, { 'Retry-After': '1' });
            return;
          }
          json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
          return;
        }
        const code = domainCode(err, 'BAD_REQUEST');
        // ⛔ 终审修正（Important，I-C 延伸）：**只透传领域错误（AppError）的 message**。
        //    AppError 的 message 是我们自己写的中文文案（"该手机号已注册"…），可以给用户看；
        //    而裸 Error / Node 内置错误 / SQLite 错误的 message 里含**内部原文**
        //    （表名列名、SQL 参数位置、文件路径）——
        //    契约 INTERFACES.md「错误」纪律明写「不外泄 Node 的 ERR_* 与 SQLite 原文」。
        //    实测（修复前）：handler 抛 `e.status=400; e.code='ERR_SQLITE_ERROR'` 时，
        //    响应体是 {"code":"BAD_REQUEST","message":"users.phone UNIQUE constraint failed"}
        //    —— code 挡住了，message 没挡住。
        const message = err instanceof AppError ? err.message : '请求无效';
        // ── P4 追加：限频要带 Retry-After，调用方才知道多久能重试（不静默丢包）──
        const extraHeaders = {};
        if (code === 'RATE_LIMITED' && err.detail?.retryAfterSeconds) {
          extraHeaders['Retry-After'] = String(err.detail.retryAfterSeconds);
        }
        if (status === 413) {
          // 请求体超限：连接已不可用 → 关掉，不复用
          json(res, 413, { error: { code, message } }, { Connection: 'close' });
          return;
        }
        // detail 同理：**只透传 AppError 的 detail** —— detail 可能含表名 / 列名
        //（问卷缺项说明是我们自己写的文案，可给前端看；裸 Error 的 detail 不行）。
        error(res, status, code, message, err instanceof AppError ? err.detail : undefined, extraHeaders);
      }
      return;
    }
    // ⛔ 评审修正（Important）：静态分支原来在 try/catch **之外** ——
    //    serveStatic 抛出的任何异常都会逸出 handle → 进程死亡。
    //    现在它在自己的 try 里；异常一律回 404，不影响进程。
    // ⚠️ F27：HEAD 也走静态分支（HEAD 与 GET 共享同一套响应头，只是不带响应体；
    //    探针常探 `/` 而不是 `/api/health` ⇒ 静态页也必须能被 HEAD 命中）。
    //    Node 自己会丢弃 HEAD 的响应体（ServerResponse._hasBody = false），
    //    而 Content-Length 照发（探针要靠它判断体量）。
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        if (serveStatic(webDir, req, res)) return;
        // 演示模式（DEMO_MODE=1）：领域层与规则配置不在 web/ 下，挂出去。
        // ⚠️ serveStatic 的签名不变（webDir, req, res）——这里只换 webDir，不改它。
        if (serveMounted(req, res)) return;
      } catch (err) {
        console.error('[server] 静态服务异常', err);
      }
    }
    error(res, 404, 'NOT_FOUND', '页面不存在');
  }

  return { router, handle };
}

function parseCookie(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // ⛔ 预审修正（m7-2）：畸形编码不能抛 URIError —— 原样透传该 cookie 值
      value = raw;
    }
    out[name] = value;
  }
  return out;
}

// ── 进程启动 ────────────────────────────────────────────────
// ⚠️ 符号链接入口：Node 会把主入口 **realpath 化**，import.meta.url 是**真实路径**，
//    而 process.argv[1] 是**链接路径** → 字符串全等为假 → 服务器静默不启动、退出码 0
//    （评审实测：stdout 为空、exit 0、从未监听）。两边都 realpath 再比。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const port = Number(process.env.PORT || 8080);
  const webDir = join(here, '..', 'web');
  const migrationsDir = join(here, '..', 'db', 'migrations');
  const rulesDir = join(here, '..', 'rules');

  const { rules, version } = loadRules(rulesDir);

  // ── 单写者闸（E169 / F5）────────────────────────────────────────
  // 依据：README 的头号架构承诺「SQLite 只允许单写进程」+ 设计文档 §14.2。
  // 修复前：pid 文件在 listen **之前**写、而且**从不检查**是否已有实例
  //        ⇒ 同一个 DATA_DIR 可以同时起两个服务、两个都启动成功
  //        ⇒ F8 已证明这种双写会直接撞出 SQLITE_BUSY / 517。
  // ⚠️ 必须在**开库之前**判：库一打开就可能与对方抢写锁了。
  const livePid = readPidFile(dataDir);
  if (livePid && livePid !== process.pid && isProcessAlive(livePid)) {
    console.error(
      `[server] 拒绝启动：数据目录 ${dataDir} 已被进程 ${livePid} 占用。`
      + '单写者约束：同一个 SQLite 文件只允许一个写进程（并发写会撞 SQLITE_BUSY / 517）。'
      + '请先停掉那个进程再启动本实例。',
    );
    process.exit(1);
  }
  // ⚠️ pid 文件指向**已死**进程 ⇒ 上次崩溃留下的残留 ⇒ 允许接管（并覆盖它）。
  //    不允许接管 ⇒ 崩一次就再也起不来（运维得手工删 pid 文件才能重启）。

  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const app = createApp({ db, rules, webDir });

  const server = http.createServer(app.handle);
  // ⛔ 预审修正（m7-1）：显式绑 127.0.0.1（默认是 0.0.0.0，会暴露到局域网/公网），
  //    日志与实际绑定保持一致；云主机部署时再显式改成 '0.0.0.0'。
  // ⛔ 启动期错误（端口被占 EADDRINUSE 等）必须有**人话**报错 + 明确退出码。
  //    没有 'error' 处理器时，listen 的错误会变成未捕获异常 ⇒ 日志里是一坨栈、
  //    退出码也不是 1 ⇒ 运维看不出「到底为什么没起来」。
  server.on('error', (err) => {
    console.error(`[server] 启动失败：${err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    // ── P6：写 pid 文件 + 端口文件 ───────────────────────────────
    // ⚠️ 必须挪到 **listen 成功之后**（E169 / F13）：
    //    修复前写在 listen 之前 ⇒ 启动失败（端口被占）时也把 pid 文件覆盖成自己的 pid
    //    ⇒ 留下一个指向**已死进程**的陈旧 pid ⇒ 恢复闸误判「服务没在跑」。
    // ⚠️ 端口文件记的是**实际**监听端口（PORT=0 时是内核分配的，不是 0）——
    //    恢复闸靠它去主动探测「服务还在不在」（见 src/runtime/service-probe.js）。
    const actualPort = server.address()?.port ?? port;
    writePidFile(dataDir);
    writePortFile(dataDir, actualPort);
    console.log(`heikesong-platform 启动于 http://127.0.0.1:${actualPort}（规则版本 ${version}）`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => {
        // ── P6：退出前删 pid 文件（否则留下陈旧 pid）─────────────
        removePidFile(dataDir);
        removePortFile(dataDir);
        // ────────────────────────────────────────────────────────
        close();
        process.exit(0);
      });
    });
  }
}

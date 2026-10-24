// src/services/rate-limit.js — 三层限频 + 评委级每小时配额
// 依据：设计文档 §11.1「三层限频：滑动窗口计数 + 提交锁 + 每分钟配额；再加评委级配额（每人每小时打分次数上限）」
//   借鉴 CTFd api/v1/challenges.py 的三层限频思路（Apache-2.0），只读思路独立实现。
//   溯源：R-AUD-05 空结果必须显式报错 —— 限频触发必须返回 429 + retryAfterSeconds，⛔ 绝不静默丢包。
//   ⛔ 计数落 rate_limit_events 表：只在内存计数 = 进程重启即失效 = 等于没有限频。
import {
  countBucket, incrementBucket, slidingWindowCount, slidingWindowEvents, acquireLock, releaseLock,
  deleteRateLimitEventsBySubject, deleteRateLimitEventsByRulePrefix,
} from '../db/repo/rate-limit.js';
import { appError, rateLimited } from '../errors.js';
import { createHash } from 'node:crypto';

/**
 * 登录限频的 subject key = 手机号的哈希。
 *
 * ⚠️ 为什么存哈希、不存明文手机号：限频计数落在 `rate_limit_events` 表，
 *    那张表会进数据库文件、进备份 ⇒ 存明文等于把手机号复制到第二张表里，
 *    没必要扩大暴露面。
 * ⚠️ 为什么按**手机号**限频、而不是按 IP：ctx 上**没有可信的客户端 IP**
 *    （服务可能挂在 nginx 后面，x-forwarded-for 由客户端随便填）。
 *    按账号限频挡的是「爆破某一个账号的口令」—— 审计实测的就是这个场景
 *    （30 次错误口令全部 401、零 429）。
 *
 * ⚠️ **已知缺口（2026-10-24 评审补记）**：只按手机号限频 ⇒ **挡不住定向 DoS**：
 *    知道评委手机号的人只要连续输错口令，就能把**受害者本人**的配额耗光
 *    （配额是按手机号记的）⇒ 受害者在自己想登录时反被 429 挡在门外
 *    —— 在打分窗口里就是「评委进不去系统」。
 *    ⇒ 补法：**加一个按来源 IP 的独立配额**（loginIpSubjectKey）。
 *
 * ⚠️⚠️ **复核后的更正（2026-10-24，评审说法的"受害者被锁在门外"不成立）**：
 *    复核实测：限频判定**只在「口令校验失败」的分支里**执行
 *    （src/server.js 的登录路由：`if (!ok) { assertRateLimit(...); throw 401; }`）
 *    ⇒ **受害者只要输对口令，登录永远不会被挡** ⇒ 「把评委锁在门外」这个后果
 *    **不存在**。评审那条描述与实现对不上。
 *    ⇒ **但真正的问题在隔壁**：限频判定发生在 **scrypt 之后** ⇒
 *      **被限流的请求照样跑一遍 scrypt** ⇒ 限频只把 401 换成 429，
 *      **挡不住 CPU 打爆**（⇒ 这才是真实的 DoS 面）。
 *    ⇒ 于是修法改成两步：① **只读预检前置**（挡住 ⇒ scrypt 根本不跑）
 *      ② **来源维度的独立配额**（IP 配额前置 ⇒ 攻击者的请求被廉价挡下）。
 *    ⇒ 「正确口令永远能登录」这条**不变量必须保住** —— 它正是对
 *      「账号被锁死」的根本防护（限频只罚失败，不罚成功）。
 *    ⚠️ **为什么不采用「账号存在与否分开计数」**（评审的第二条建议）：
 *      那会让「账号存在」与「账号不存在」的**配额耗尽时机不同**
 *      ⇒ 攻击者拿一个不存在的号试到 N 次得到 429、再拿一个真实号试却还得到 401
 *      ⇒ **重新打开了用户枚举**（本文件与 src/server.js 登录路由都在**刻意**
 *      让「用户不存在」与「口令错误」的**错误码与耗时完全一致**）。
 *      ⇒ 明确**不做**这条，并在此写清楚理由。
 */
export function loginSubjectKey(phone) {
  return `login:${createHash('sha256').update(String(phone ?? '')).digest('hex').slice(0, 16)}`;
}

/**
 * 登录限频的**来源 IP** 维度 subject key（2026-10-24 评审补记）。
 *
 * ⚠️ 为什么要 hash 一层：限频计数落在 `rate_limit_events` 表 ⇒ 那张表会进
 *    数据库文件、进备份 ⇒ 直接存 IP 等于把访问来源复制到第二张表。
 *    ⇒ 与手机号同一口径：**只存哈希**。
 * ⚠️ IP 的可信度由**传输层**保证（见 src/http/security-headers.js 的 clientIp）：
 *    对端是回环（同机 nginx）时才采信 X-Real-IP / X-Forwarded-For 末段；
 *    否则一律用 socket.remoteAddress。**本函数不判断可信度，只负责生成 key。**
 */
export function loginIpSubjectKey(ip) {
  return `login-ip:${createHash('sha256').update(String(ip ?? '')).digest('hex').slice(0, 16)}`;
}

function bucketKey(kind, ms, unit) {
  return `${kind}:${Math.floor(ms / unit)}`;
}

/**
 * 检查限频。通过则消耗配额，不通过则返回 allowed=false + retryAfterSeconds。
 * @param {object} args
 * @param {string} args.subjectKey 被限的主体
 * @param {string} args.rule       限频 profile 名（对应 rules.audit.rateLimit.<rule>）
 * @param {object} args.limits     rules.audit.rateLimit
 * @param {object} [args.subjects] 额外的 subject 维度，如 { judge: 'judge:u1' }
 */
export function checkRateLimit({
  db, subjectKey, rule, now = new Date().toISOString(), limits, subjects = null,
  // ⚠️ **consume: false = 只读预检**（不消耗配额、不取锁）—— 2026-10-24 评审轮新增。
  //    用途：**昂贵操作之前**先挡一道（见 src/server.js 的登录路由）。
  //    为什么要拆开「判定」与「消耗」：登录路由里 scrypt 校验是**昂贵**的，
  //    而限频原本**在 scrypt 之后**才判定 ⇒ 被限流的请求**照样跑一遍 scrypt**
  //    ⇒ 限频**挡不住 CPU 打爆**（它只把 401 换成 429）。
  //    ⇒ 改成：① 只读预检（挡住 ⇒ 昂贵操作根本不发生）② 判定通过才做昂贵操作
  //      ③ 昂贵操作**失败**了才消耗配额（成功登录不消耗 —— 与既有口径一致）。
  consume = true,
}) {
  if (!subjectKey) throw appError(400, 'INVALID_REQUEST', '限频必须给 subjectKey');
  if (!rule) throw appError(400, 'INVALID_REQUEST', '限频必须给 rule');
  const profile = limits?.[rule];
  if (!profile) {
    // ⛔ 没有配置就放行 = 限频形同虚设。直接报错。
    throw appError(500, 'RATE_LIMIT_NOT_CONFIGURED', `限频规则未配置: ${rule}（rules/audit.json 缺该 profile）`);
  }

  const nowMs = Date.parse(now);
  const resolved = { default: subjectKey, ...(subjects ?? {}) };
  const subjectOf = (layer) => resolved[layer?.subject ?? 'default'] ?? subjectKey;

  const layers = [];

  // ── 只读判定（不消耗配额）────────────────────────────────
  if (profile.sliding) {
    const key = subjectOf(profile.sliding);
    const count = slidingWindowCount(db, {
      subjectKey: key, rule: `sliding:${rule}`, now, windowSeconds: profile.sliding.seconds,
    });
    layers.push({
      layer: 'sliding',
      allowed: count < profile.sliding.max,
      count,
      max: profile.sliding.max,
      retryAfterSeconds: count < profile.sliding.max
        ? 0
        : slidingRetryAfter(db, {
          subjectKey: key, rule: `sliding:${rule}`, now, windowSeconds: profile.sliding.seconds, max: profile.sliding.max,
        }),
    });
  }
  if (profile.perMinute) {
    const key = subjectOf(profile.perMinute);
    const bucket = bucketKey('m', nowMs, 60_000);
    const count = countBucket(db, { subjectKey: key, rule: `minute:${rule}`, bucket });
    layers.push({
      layer: 'perMinute',
      allowed: count < profile.perMinute.max,
      count,
      max: profile.perMinute.max,
      retryAfterSeconds: count < profile.perMinute.max
        ? 0
        : Math.max(1, Math.ceil(((Math.floor(nowMs / 60_000) + 1) * 60_000 - nowMs) / 1000)),
    });
  }
  if (profile.perHour) {
    const key = subjectOf(profile.perHour);
    const bucket = bucketKey('h', nowMs, 3_600_000);
    const count = countBucket(db, { subjectKey: key, rule: `hour:${rule}`, bucket });
    layers.push({
      layer: 'perHour',
      allowed: count < profile.perHour.max,
      count,
      max: profile.perHour.max,
      retryAfterSeconds: count < profile.perHour.max
        ? 0
        : Math.max(1, Math.ceil(((Math.floor(nowMs / 3_600_000) + 1) * 3_600_000 - nowMs) / 1000)),
    });
  }

  const blocked = layers.find((l) => !l.allowed);
  if (blocked) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: blocked.retryAfterSeconds,
      layers,
    };
  }

  // ── 取提交锁（防并发灌分）──────────────────────────────
  // ⚠️ 锁有两种语义，由**配置**决定（rules/audit.json 的 lock.mode）：
  //    · cooldown（默认）：拿到后 N 秒内谁都拿不到 —— 适合「申诉」这种
  //      短时间内重复提交本身就是滥用的场景。
  //    · mutex：锁只在**本次请求处理期间**存在，请求结束即释放 ——
  //      挡的是「**同时**在跑」的两笔提交，挡不住「先后两次」。
  //      ⚠️ 评分路径必须用 mutex：评委「改分」是先后两次提交，
  //        冷却锁会把第二次挡成 429 ⇒「改分必须把旧分写进审计」这条核心契约直接失效。
  //    `release` 句柄只在 mutex 语义下给出；cooldown 语义下为 null（调用方 `?.()` 即可）。
  let release = null;
  if (profile.lock && consume) {
    const key = subjectOf(profile.lock);
    const lock = acquireLock(db, {
      subjectKey: key, rule: `lock:${rule}`, now, lockSeconds: profile.lock.seconds,
      // ⚠️ durable（F19）：锁也是「消耗配额」的一部分 ⇒ 业务失败也得留下这把锁，
      //    否则「5 秒提交锁」形同虚设（失败一次就能立刻再提交）。
      durable: true,
    });
    if (!lock.acquired) {
      layers.push({ layer: 'lock', allowed: false, retryAfterSeconds: lock.retryAfterSeconds });
      return { allowed: false, remaining: 0, retryAfterSeconds: lock.retryAfterSeconds, layers, release: null };
    }
    layers.push({ layer: 'lock', allowed: true, retryAfterSeconds: 0 });
    if ((profile.lock.mode ?? 'cooldown') === 'mutex') {
      release = () => releaseLock(db, { subjectKey: key, rule: `lock:${rule}` });
    }
  }

  // ── 消耗配额（落库）────────────────────────────────────
  // ⚠️ durable（F19）：计数写在**业务事务**里 ⇒ 业务一抛错就被一起回滚
  //    ⇒ 「加个 requestId 就能绕过限频」⇒ 唯一的限频端点形同虚设。
  //    ⇒ durable = true：写入立即执行 + 登记回滚日志 ⇒ 回滚后重放 ⇒ 计数存活。
  if (consume && profile.sliding) {
    const key = subjectOf(profile.sliding);
    incrementBucket(db, {
      subjectKey: key, rule: `sliding:${rule}`, bucket: bucketKey('s', nowMs, 1000), now, durable: true,
    });
  }
  if (consume && profile.perMinute) {
    const key = subjectOf(profile.perMinute);
    incrementBucket(db, {
      subjectKey: key, rule: `minute:${rule}`, bucket: bucketKey('m', nowMs, 60_000), now, durable: true,
    });
  }
  if (consume && profile.perHour) {
    const key = subjectOf(profile.perHour);
    incrementBucket(db, {
      subjectKey: key, rule: `hour:${rule}`, bucket: bucketKey('h', nowMs, 3_600_000), now, durable: true,
    });
  }

  const remaining = layers.length
    ? Math.min(...layers.filter((l) => Number.isInteger(l.max)).map((l) => Math.max(0, l.max - l.count - 1)))
    : 0;

  return { allowed: true, remaining, retryAfterSeconds: 0, layers, release };
}

// 滑动窗口的等待时间：等到窗口内最早的若干次记录滑出窗口，才腾得出一个名额。
function slidingRetryAfter(db, { subjectKey, rule, now, windowSeconds, max }) {
  const events = slidingWindowEvents(db, { subjectKey, rule, now, windowSeconds });
  const total = events.reduce((a, e) => a + e.count, 0);
  if (total < max) return 0;
  let need = total - max + 1;
  for (const e of events) {
    if (need <= 0) break;
    need -= e.count;
    if (need <= 0) {
      const outAt = Date.parse(e.window_start) + windowSeconds * 1000;
      return Math.max(1, Math.ceil((outAt - Date.parse(now)) / 1000));
    }
  }
  return Math.max(1, windowSeconds);
}

/**
 * 限频断言：不通过抛 429（AppError），detail.retryAfterSeconds 必填。
 * HTTP 层据此返回 429 + Retry-After 响应头（⛔ 不静默丢包）。
 */
export function assertRateLimit(args) {
  const result = checkRateLimit(args);
  if (!result.allowed) {
    throw rateLimited(
      `触发限频（${args.rule}），请 ${result.retryAfterSeconds} 秒后重试`,
      { retryAfterSeconds: result.retryAfterSeconds, rule: args.rule, layers: result.layers },
    );
  }
  return result;
}

/**
 * 管理员解锁：清掉某个手机号的**登录限频计数**（2026-10-24 评审补记）。
 *
 * ⚠️ **为什么需要这条人工兜底**：登录限频按**账号**记 ⇒ 定向攻击可以把
 *    受害者本人锁在门外（打分窗口里 = 评委进不去）。
 *    「按来源限频」那层是**自动**防护，但它挡不住**分布式**来源。
 *    ⇒ 必须留一条**人能立刻执行的**通道：组委会发现某人被锁 ⇒ 清计数 ⇒ 他马上能登录。
 *
 * ⚠️ **只清这个手机号的**：按 subject 删（`login:<hash>`）⇒ 不影响其它账号的计数
 *    （按 rule 删会把全场的登录限频一起清掉 ⇒ 闸门等于失效）。
 *
 * @param {object} db
 * @param {string} phone 目标手机号
 * @returns {{subjectKey: string, removed: number}} subjectKey 便于审计留痕（**不含明文手机号**的哈希）
 */
export function unlockLoginAttempts(db, phone) {
  const subjectKey = loginSubjectKey(phone);
  const removed = deleteRateLimitEventsBySubject(db, subjectKey);
  return { subjectKey, removed };
}

/**
 * 应急解除**全部**登录限频计数（账号维度 + 来源维度）—— 管理员用。
 *
 * ⚠️ **什么时候需要它**：来源维度的预检是**前置**的（判定在 scrypt 之前）
 *    ⇒ 它**连正确口令一起挡** ⇒ 一旦某个出口 IP 被误判成攻击源
 *    （共享出口的办公室/校园网），**整个出口的人都会被挡**。
 *    ⇒ 这条是「限频误伤」的**唯一**应急出口。
 * ⚠️ **只清登录限频**：申诉提交（appealSubmit）/ 评分提交（reviewSubmit）
 *    / 评委小时配额（judgeHourly）的计数**不动** ⇒ 那些闸门不会被顺手关掉。
 *
 * @param {object} db
 * @returns {number} 删除的行数
 */
export function clearAllLoginLimiters(db) {
  return deleteRateLimitEventsByRulePrefix(db, 'loginAttempt');
}

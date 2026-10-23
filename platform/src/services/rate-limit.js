// src/services/rate-limit.js — 三层限频 + 评委级每小时配额
// 依据：设计文档 §11.1「三层限频：滑动窗口计数 + 提交锁 + 每分钟配额；再加评委级配额（每人每小时打分次数上限）」
//   借鉴 CTFd api/v1/challenges.py 的三层限频思路（Apache-2.0），只读思路独立实现。
//   溯源：R-AUD-05 空结果必须显式报错 —— 限频触发必须返回 429 + retryAfterSeconds，⛔ 绝不静默丢包。
//   ⛔ 计数落 rate_limit_events 表：只在内存计数 = 进程重启即失效 = 等于没有限频。
import {
  countBucket, incrementBucket, slidingWindowCount, slidingWindowEvents, acquireLock, releaseLock,
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
 * ⚠️ 已知缺口：同一 IP 换着账号喷（credential stuffing）挡不住 ——
 *    那需要可信的客户端 IP，属于部署形态问题，不在本次缺陷修复范围内。
 */
export function loginSubjectKey(phone) {
  return `login:${createHash('sha256').update(String(phone ?? '')).digest('hex').slice(0, 16)}`;
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
  if (profile.lock) {
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
  if (profile.sliding) {
    const key = subjectOf(profile.sliding);
    incrementBucket(db, {
      subjectKey: key, rule: `sliding:${rule}`, bucket: bucketKey('s', nowMs, 1000), now, durable: true,
    });
  }
  if (profile.perMinute) {
    const key = subjectOf(profile.perMinute);
    incrementBucket(db, {
      subjectKey: key, rule: `minute:${rule}`, bucket: bucketKey('m', nowMs, 60_000), now, durable: true,
    });
  }
  if (profile.perHour) {
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

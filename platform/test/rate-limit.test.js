import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { checkRateLimit, assertRateLimit } from '../src/services/rate-limit.js';
import { withIdempotency } from '../src/services/idempotency.js';
import { countBucket, incrementBucket } from '../src/db/repo/rate-limit.js';
import { insertIdempotency } from '../src/db/repo/idempotency.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const LIMITS = {
  // 带提交锁的 profile：同一 subject 在锁有效期内只允许一次
  appealSubmit: {
    lock: { seconds: 5 },
    sliding: { seconds: 60, max: 3 },
    perMinute: { max: 5 },
  },
  // 不带锁的 profile：单独验证滑动窗口与每分钟配额
  slidingOnly: {
    sliding: { seconds: 60, max: 3 },
    perMinute: { max: 5 },
  },
  judgeHourly: {
    perHour: { max: 4 },
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4rl-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

test('未配限频规则时直接报错（不静默用默认值放行）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => checkRateLimit({ db, subjectKey: 'u1', rule: 'notConfigured', now: '2026-10-20T00:00:00.000Z', limits: LIMITS }),
    (e) => e.status === 500 && /未配置/.test(e.message),
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动窗口：超出配额后 allowed=false 且给出 retryAfterSeconds', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    const r = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1, '必须告诉调用方等多久');
  assert.equal(blocked.remaining, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('限频计数必须落库：换一个 db 连接（模拟进程重启）仍然超限', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  }
  // 计数写在 rate_limit_events 表里，不是内存
  const bucket = `s:${Math.floor(Date.parse(now) / 1000)}`;
  const stored = countBucket(db, { subjectKey: 'appeal:u1', rule: 'sliding:slidingOnly', bucket });
  assert.equal(stored, 3, '计数必须落在 rate_limit_events 表');

  // 模拟进程重启：新开一个连接读同一个库
  const { db: db2, close: close2 } = openDatabase({ dataDir });
  const afterRestart = checkRateLimit({ db: db2, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(afterRestart.allowed, false, '进程重启不能让限频失效');
  close2();
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交锁：并发同 subject 的第二次请求被拒，且给出剩余秒数', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  const first = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'appealSubmit', now, limits: LIMITS });
  assert.equal(first.allowed, true);
  const second = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'appealSubmit', now: '2026-10-20T00:00:01.000Z', limits: LIMITS });
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterSeconds >= 1);
  assert.equal(second.layers.find((l) => l.layer === 'lock').allowed, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('每分钟配额：每分钟独立计数', () => {
  const { db, close, dataDir } = setup();
  const limits = { m: { perMinute: { max: 1 } } };
  const a = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:00:10.000Z', limits });
  const b = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:00:20.000Z', limits });
  const c = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:01:05.000Z', limits });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, false);
  assert.equal(c.allowed, true, '进入下一分钟后配额重置');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('评委级每小时配额：按 judge 维度单独计数', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 4; i += 1) {
    const r = checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  const other = checkRateLimit({ db, subjectKey: 'judge:u2', rule: 'judgeHourly', now, limits: LIMITS });
  assert.equal(other.allowed, true, '不同评委互不影响');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('assertRateLimit 超限抛 429 且 detail 带 retryAfterSeconds', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    assertRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  }
  assert.throws(
    () => assertRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS }),
    (e) => e.status === 429 && e.code === 'RATE_LIMITED' && e.detail.retryAfterSeconds >= 1,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：同一 request_id 重复提交只生效一次，且返回首次的响应', () => {
  const { db, close, dataDir } = setup();
  let calls = 0;
  const fn = () => { calls += 1; return { accepted: true, n: calls }; };

  const first = withIdempotency({ db, key: 'req_1', scope: 'appeal.submit', requestId: 'req_1' }, fn);
  const second = withIdempotency({ db, key: 'req_1', scope: 'appeal.submit', requestId: 'req_1' }, fn);

  assert.equal(calls, 1, '业务函数只能被调用一次');
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result, '重复请求必须返回【首次的响应】');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：不同 scope 的同一个 key 互不影响', () => {
  const { db, close, dataDir } = setup();
  let calls = 0;
  const fn = () => { calls += 1; return { n: calls }; };
  withIdempotency({ db, key: 'req_1', scope: 'appeal.submit' }, fn);
  withIdempotency({ db, key: 'req_1', scope: 'review.submit' }, fn);
  assert.equal(calls, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：业务函数失败时不留下幂等记录（可以重试）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => withIdempotency({ db, key: 'req_x', scope: 'appeal.submit' }, () => { throw new Error('业务失败'); }),
    /业务失败/,
  );
  let calls = 0;
  const r = withIdempotency({ db, key: 'req_x', scope: 'appeal.submit' }, () => { calls += 1; return { ok: true }; });
  assert.equal(calls, 1, '失败后应该还能重试');
  assert.equal(r.replayed, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('限频：缺 subjectKey / rule 一律 400（不静默放行）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => checkRateLimit({ db, rule: 'slidingOnly', now: '2026-10-20T00:00:00.000Z', limits: LIMITS }),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => checkRateLimit({ db, subjectKey: 'u1', now: '2026-10-20T00:00:00.000Z', limits: LIMITS }),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('layers：每层都要报出 layer / count / max / allowed', () => {
  const { db, close, dataDir } = setup();
  const r = checkRateLimit({
    db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: '2026-10-20T00:00:00.000Z', limits: LIMITS,
  });
  const sliding = r.layers.find((l) => l.layer === 'sliding');
  assert.equal(sliding.count, 0);
  assert.equal(sliding.max, 3);
  assert.equal(sliding.allowed, true);
  assert.ok(r.layers.some((l) => l.layer === 'perMinute'), '每分钟配额也要单独成层');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('subjects：限频层可以指定用哪个 subject 维度计数', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  const limits = { judgeSubmit: { sliding: { seconds: 60, max: 2, subject: 'judge' } } };
  for (let i = 0; i < 2; i += 1) {
    const r = checkRateLimit({
      db, subjectKey: 'stage:s1', rule: 'judgeSubmit', now, limits, subjects: { judge: 'judge:u1' },
    });
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = checkRateLimit({
    db, subjectKey: 'stage:s1', rule: 'judgeSubmit', now, limits, subjects: { judge: 'judge:u1' },
  });
  assert.equal(blocked.allowed, false, '必须按 judge 维度计数，而不是按默认 subjectKey');

  const bucket = `s:${Math.floor(Date.parse(now) / 1000)}`;
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:judgeSubmit', bucket }), 2);
  assert.equal(
    countBucket(db, { subjectKey: 'stage:s1', rule: 'sliding:judgeSubmit', bucket }),
    0,
    '默认 subject 不得被计数',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动窗口：窗口滑出后配额自动恢复', () => {
  const { db, close, dataDir } = setup();
  const t0 = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: t0, limits: LIMITS }).allowed,
      true,
    );
  }
  assert.equal(
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: t0, limits: LIMITS }).allowed,
    false,
  );
  // 61 秒后：最早那次的记录已滑出 60 秒窗口 ⇒ 配额必须恢复
  const later = '2026-10-20T00:01:01.000Z';
  assert.equal(
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: later, limits: LIMITS }).allowed,
    true,
    '窗口滑出后必须恢复放行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交锁：锁到期后可以再次获取', () => {
  const { db, close, dataDir } = setup();
  const limits = { lockOnly: { lock: { seconds: 5 } } };
  const t0 = '2026-10-20T00:00:00.000Z';
  assert.equal(checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'lockOnly', now: t0, limits }).allowed, true);
  const blocked = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'lockOnly', now: '2026-10-20T00:00:01.000Z', limits });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'lockOnly', now: '2026-10-20T00:00:06.000Z', limits }).allowed,
    true,
    '锁过期后必须重新放行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('被拒绝的请求不消耗配额（只有放行的请求才计数）', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  }
  const bucket = `s:${Math.floor(Date.parse(now) / 1000)}`;
  assert.equal(countBucket(db, { subjectKey: 'appeal:u1', rule: 'sliding:slidingOnly', bucket }), 3);
  const blocked = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  assert.equal(
    countBucket(db, { subjectKey: 'appeal:u1', rule: 'sliding:slidingOnly', bucket }),
    3,
    '被拒绝的请求不得消耗配额',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('remaining 随配额消耗递减（放行后还能再做几次）', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  const a = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(a.remaining, 2, '滑动窗口还剩 2 次（3 - 已用 1）');
  const b = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(b.remaining, 1);
  const c = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(c.remaining, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('每分钟配额：超限给出本分钟剩余秒数，且计数落在 m:<epoch分> 桶', () => {
  const { db, close, dataDir } = setup();
  const limits = { m: { perMinute: { max: 1 } } };
  const now = '2026-10-20T00:00:10.000Z';
  assert.equal(checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now, limits }).allowed, true);
  const blocked = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:00:20.000Z', limits });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 40, '本分钟还剩 40 秒');
  const bucket = `m:${Math.floor(Date.parse(now) / 60_000)}`;
  assert.equal(countBucket(db, { subjectKey: 'x:1', rule: 'minute:m', bucket }), 1, '分钟桶必须按 epoch 分对齐');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('评委级每小时配额：超限给出本小时剩余秒数，且计数落在 h:<epoch时> 桶', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 4; i += 1) {
    checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
  }
  const blocked = checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 3600, '本小时还剩 3600 秒');
  const bucket = `h:${Math.floor(Date.parse(now) / 3_600_000)}`;
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'hour:judgeHourly', bucket }), 4, '小时桶必须按 epoch 时对齐');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动窗口：retryAfterSeconds 指向最早那次滑出窗口的时刻', () => {
  const { db, close, dataDir } = setup();
  const limits = { s: { sliding: { seconds: 60, max: 2 } } };
  const t0 = '2026-10-20T00:00:00.000Z';
  checkRateLimit({ db, subjectKey: 'a:1', rule: 's', now: t0, limits });
  checkRateLimit({ db, subjectKey: 'a:1', rule: 's', now: '2026-10-20T00:00:30.000Z', limits });
  const blocked = checkRateLimit({ db, subjectKey: 'a:1', rule: 's', now: '2026-10-20T00:00:30.000Z', limits });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 30, '最早那次在 00:01:00 滑出窗口 ⇒ 还差 30 秒');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：缺 key / scope 一律 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => withIdempotency({ db, scope: 'appeal.submit' }, () => ({ ok: true })),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => withIdempotency({ db, key: 'req_1' }, () => ({ ok: true })),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：业务失败时业务副作用一并回滚（不能留下「做了一半」的账）', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  assert.throws(
    () => withIdempotency({ db, key: 'req_roll', scope: 'appeal.submit', requestId: 'req_roll', now }, () => {
      incrementBucket(db, { subjectKey: 'appeal:u1', rule: 'side:effect', bucket: 'b1', now });
      throw new Error('业务失败');
    }),
    /业务失败/,
  );
  assert.equal(
    countBucket(db, { subjectKey: 'appeal:u1', rule: 'side:effect', bucket: 'b1' }),
    0,
    '业务副作用必须随幂等键一起回滚',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：并发下别人先写入了 → 以库里的首次响应为准', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  let calls = 0;
  const fn = () => {
    calls += 1;
    // 模拟「另一个请求抢先写入了同一个幂等键」
    insertIdempotency(db, {
      key: 'req_c', scope: 'appeal.submit', requestId: 'req_c', response: { accepted: true, by: 'other' }, now,
    });
    return { accepted: true, by: 'self' };
  };
  const r = withIdempotency({ db, key: 'req_c', scope: 'appeal.submit', requestId: 'req_c', now }, fn);
  assert.equal(calls, 1);
  assert.equal(r.replayed, true, '键已被别人占用 ⇒ 必须按重放处理');
  assert.deepEqual(r.result, { accepted: true, by: 'other' }, '以库里的首次响应为准');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：重放返回的 storedAt 是首次落库的时间', () => {
  const { db, close, dataDir } = setup();
  const t0 = '2026-10-20T00:00:00.000Z';
  const t1 = '2026-10-20T00:05:00.000Z';
  const first = withIdempotency({ db, key: 'req_t', scope: 'appeal.submit', requestId: 'req_t', now: t0 }, () => ({ ok: true }));
  const second = withIdempotency({ db, key: 'req_t', scope: 'appeal.submit', requestId: 'req_t', now: t1 }, () => ({ ok: true }));
  assert.equal(first.storedAt, t0);
  assert.equal(second.storedAt, t0, '重放必须返回首次落库时间');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

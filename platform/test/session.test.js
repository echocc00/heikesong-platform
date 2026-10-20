import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
} from '../src/auth/session.js';

// 真实迁移目录（platform/db/migrations）：会话表必须真的被建出来。
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sess-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const user = createUser(db, { name: '会话甲', phone: '13900000002', password: 'pw' });
  return { db, close, dataDir, user };
}

test('库里只存 token_hash（SHA-256 十六进制），不存在明文 token', () => {
  const { db, close, dataDir, user } = setup();
  const { token } = createSession(db, user.id);
  const rows = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(user.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.length, 64);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  // 整张表里任何一列都不含明文 token
  for (const row of db.prepare('SELECT * FROM sessions').all()) {
    assert.ok(!Object.values(row).includes(token));
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('过期 token 解析为 null，并顺手删掉该行', () => {
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 1, now });
  assert.ok(resolveSession(db, token, { now: new Date('2026-01-01T12:00:00.000Z'), ttlDays: 1 }));
  const later = new Date('2026-01-03T00:00:00.000Z');
  assert.equal(resolveSession(db, token, { now: later, ttlDays: 1 }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('revokeAllSessions 之后该用户的全部会话都失效', () => {
  const { db, close, dataDir, user } = setup();
  const a = createSession(db, user.id);
  const b = createSession(db, user.id);
  assert.ok(resolveSession(db, a.token));
  assert.ok(resolveSession(db, b.token));
  revokeAllSessions(db, user.id);
  assert.equal(resolveSession(db, a.token), null);
  assert.equal(resolveSession(db, b.token), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('有效会话被访问时滑动续期（expires_at 顺延 ttlDays）', () => {
  // 依据：设计文档 §7.5「绝对过期 + 滑动续期」
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token, expiresAt } = createSession(db, user.id, { ttlDays: 1, now });
  assert.equal(expiresAt, '2026-01-02T00:00:00.000Z');
  const later = new Date('2026-01-01T06:00:00.000Z');
  const got = resolveSession(db, token, { now: later, ttlDays: 1 });
  assert.ok(got);
  assert.equal(got.expiresAt, '2026-01-02T06:00:00.000Z');
  // 库里也确实续期了
  const row = db.prepare('SELECT expires_at FROM sessions').get();
  assert.equal(row.expires_at, '2026-01-02T06:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('会话有绝对过期上限：持续使用也不能无限续命', () => {
  // ⚠️ 评审修正（Important）：设计文档 §7.5 明写「绝对过期 + 滑动续期」，
  //    原来**只实现了滑动续期** —— 只要一直有人在用，这个会话就永不过期。
  //    （评审探针实测：ttl=1 天的会话每 12 小时碰一次，跨 5 天 10/10 次全部存活。）
  //    绝对上限从**签发时刻**算起，到点一律作废，不因使用频率而延后。
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  // 签发于 2026-01-01，绝对上限 10 天 → 硬边界是 2026-01-11T00:00:00.000Z
  const { token } = createSession(db, user.id, { ttlDays: 1, absoluteTtlDays: 10, now });
  // 每 12 小时碰一次 → 滑动续期一直把 expires_at 往后推（签发后 10 天内一直有效）
  for (let h = 12; h < 10 * 24; h += 12) {
    const at = new Date(now.getTime() + h * 3600_000);
    assert.ok(
      resolveSession(db, token, { now: at, ttlDays: 1, absoluteTtlDays: 10 }),
      `第 ${h} 小时应仍然有效（滑动续期生效中）`,
    );
  }
  // 越过绝对上限 → 一律作废并删行（哪怕上一分钟刚用过）
  assert.equal(resolveSession(db, token, {
    now: new Date('2026-01-11T00:00:00.000Z'), ttlDays: 1, absoluteTtlDays: 10,
  }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('即使 expires_at 被改到绝对上限之后，到点仍作废', () => {
  // 绝对上限**不依赖** expires_at：库里的行即使被改成很远的将来（历史数据 / 被篡改），
  // 到硬边界也必须作废 —— 否则"绝对过期"就只是一个装饰性字段。
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 1, absoluteTtlDays: 10, now });
  db.prepare("UPDATE sessions SET expires_at = '2026-12-31T00:00:00.000Z' WHERE user_id = ?").run(user.id);
  assert.equal(resolveSession(db, token, {
    now: new Date('2026-01-11T00:00:00.000Z'), ttlDays: 1, absoluteTtlDays: 10,
  }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动续期不得越过绝对上限', () => {
  // ttl(30 天) > absolute(10 天) 时，expires_at 必须被夹在绝对上限上，
  // 否则库里记的过期时间会比真实可用的时间更晚 —— 审计链在说谎。
  const { db, close, dataDir, user } = setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { token } = createSession(db, user.id, { ttlDays: 30, absoluteTtlDays: 10, now });
  const row = db.prepare('SELECT expires_at FROM sessions').get();
  assert.equal(row.expires_at, '2026-01-11T00:00:00.000Z');
  const got = resolveSession(db, token, {
    now: new Date('2026-01-05T00:00:00.000Z'), ttlDays: 30, absoluteTtlDays: 10,
  });
  assert.equal(got.expiresAt, '2026-01-11T00:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('会话 token 是 32 字节随机（base64url 43 字符）', () => {
  // ⚠️ 评审修正（Minor）：token 熵此前没有任何断言钉住。
  const { db, close, dataDir, user } = setup();
  const a = createSession(db, user.id).token;
  const b = createSession(db, user.id).token;
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b, '两个会话的 token 必须不同');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⛔ 复核发现（Important）：绝对过期的**默认值**与**环境变量覆盖**此前零断言 ——
//    把默认值改成 9999 天、或把 SESSION_ABSOLUTE_TTL_DAYS 覆盖逻辑改坏，
//    全量测试照样全绿。而这条是「令牌泄露后最坏能用到什么时候」的硬边界。
test('绝对过期默认是 30 天，且可由 SESSION_ABSOLUTE_TTL_DAYS 覆盖', async () => {
  const { sessionAbsoluteTtlDays } = await import('../src/auth/session.js');
  const original = process.env.SESSION_ABSOLUTE_TTL_DAYS;
  try {
    delete process.env.SESSION_ABSOLUTE_TTL_DAYS;
    assert.equal(sessionAbsoluteTtlDays(), 30, '绝对过期默认必须是 30 天（设计文档 §7.5）');

    process.env.SESSION_ABSOLUTE_TTL_DAYS = '7';
    assert.equal(sessionAbsoluteTtlDays(), 7, '必须能被 SESSION_ABSOLUTE_TTL_DAYS 覆盖');

    // 非法值必须回落到默认值，而不是变成 NaN / 0 / 负数
    process.env.SESSION_ABSOLUTE_TTL_DAYS = 'abc';
    assert.equal(sessionAbsoluteTtlDays(), 30, '非法值必须回落到默认值');
    process.env.SESSION_ABSOLUTE_TTL_DAYS = '-1';
    assert.equal(sessionAbsoluteTtlDays(), 30, '负数必须回落到默认值');
    process.env.SESSION_ABSOLUTE_TTL_DAYS = '0';
    assert.equal(sessionAbsoluteTtlDays(), 30, '0 必须回落到默认值');
  } finally {
    if (original === undefined) delete process.env.SESSION_ABSOLUTE_TTL_DAYS;
    else process.env.SESSION_ABSOLUTE_TTL_DAYS = original;
  }
});

test('滑动续期不得突破绝对过期上限（设计文档 §7.5）', async () => {
  const { db, close, dataDir, user } = setup();
  const { createSession, resolveSession } = await import('../src/auth/session.js');
  const issuedAt = new Date('2026-10-01T00:00:00.000Z');
  // 签发时给了 100 天，但绝对上限只有 30 天 → 不得超过 30 天
  const { token, expiresAt } = createSession(db, user.id, {
    ttlDays: 100, absoluteTtlDays: 30, now: issuedAt,
  });
  const issuedPlus30 = new Date(issuedAt.getTime() + 30 * 86400_000).toISOString();
  assert.equal(expiresAt, issuedPlus30, '会话有效期不得越过绝对上限');

  // 第 20 天使用 → 滑动续期到「第 20 天 + 100 天」，但仍不得超过签发 + 30 天
  const day20 = new Date(issuedAt.getTime() + 20 * 86400_000);
  const renewed = resolveSession(db, token, {
    ttlDays: 100, absoluteTtlDays: 30, now: day20,
  });
  assert.ok(renewed, '第 20 天会话仍应有效');
  assert.equal(renewed.expiresAt, issuedPlus30, '滑动续期不得突破绝对上限');

  // 第 31 天 → 一律作废（即使刚用过）
  const day31 = new Date(issuedAt.getTime() + 31 * 86400_000);
  assert.equal(
    resolveSession(db, token, { ttlDays: 100, absoluteTtlDays: 30, now: day31 }),
    null,
    '超过绝对上限后必须作废',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

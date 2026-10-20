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

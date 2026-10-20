import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser, getUserById, listUsers, toPublicUser } from '../src/db/repo/users.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-users-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

test('重复手机号抛 409 领域错误，不漏原始 SQLite 错误', () => {
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000003', password: 'pw' });
  assert.throws(
    () => createUser(db, { name: '乙', phone: '13900000003', password: 'pw' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PHONE_TAKEN');
      assert.ok(!/UNIQUE constraint/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('仓储层的行与对外形状都不含 password_hash', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900000004', password: 'pw' });
  assert.equal(user.password_hash, undefined);
  assert.equal(getUserById(db, user.id).password_hash, undefined);
  for (const row of listUsers(db)) {
    assert.equal(row.password_hash, undefined);
  }
  const pub = toPublicUser(user);
  assert.equal(pub.password_hash, undefined);
  assert.equal(pub.passwordHash, undefined);
  assert.equal(pub.id, user.id);
  assert.equal(pub.mbaStatus, user.mba_status);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  createUser,
  getUserById,
  getCredentialsByPhone,
  listUsers,
  toPublicUser,
  deactivateUser,
} from '../src/db/repo/users.js';
import { verifyPassword } from '../src/auth/password.js';
import { AppError } from '../src/errors.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

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
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
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
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('库里存的是 scrypt 哈希，不是明文口令', () => {
  // ⚠️ 评审修正（Important）：Task 5 的核心命题就是"口令哈希入库"，
  //    但原来**没有任何断言**证明这一点 —— 把 hashPassword(password) 换成
  //    String(password)（明文入库），Task 5 自己的用例全绿。
  //    这里直接读库里的 password_hash 验三件事：格式是 scrypt$、不等于明文、验签通过。
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000009', password: 'pw-plain' });
  const cred = getCredentialsByPhone(db, '13900000009');
  assert.ok(cred.password_hash.startsWith('scrypt$'), '库里必须是 scrypt 哈希');
  assert.notEqual(cred.password_hash, 'pw-plain', '库里不能是明文口令');
  assert.equal(verifyPassword('pw-plain', cred.password_hash), true);
  assert.equal(verifyPassword('other', cred.password_hash), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('toPublicUser 对带哈希的行也不漏 password_hash（对外键集合精确）', () => {
  // ⚠️ 评审修正（Important）：原来断言的是 toPublicUser(createUser(...))，
  //    而 createUser 的返回值**本来就没有** password_hash 键 ——
  //    "输出里没有 password_hash"对任何"照抄缺失键"的实现都成立 = 恒真断言。
  //    （评审实测：往 toPublicUser 里加上 password_hash 字段，全量 79/79 仍绿。）
  //    这里改用 getCredentialsByPhone —— 那一行**确实带** password_hash，
  //    再把对外键集合也精确断言住（多泄一个字段同样会红）。
  const { db, close, dataDir } = setup();
  createUser(db, { name: '甲', phone: '13900000010', password: 'pw' });
  const cred = getCredentialsByPhone(db, '13900000010');
  assert.ok(cred.password_hash, '前提：这一行确实带 password_hash');
  const pub = toPublicUser(cred);
  assert.equal(pub.password_hash, undefined);
  assert.equal(pub.passwordHash, undefined);
  assert.deepEqual(
    Object.keys(pub).sort(),
    ['active', 'capabilities', 'createdAt', 'id', 'isSuperadmin', 'is_superadmin', 'mbaStatus', 'name', 'org', 'phone', 'roles'],
    '对外形状的键集合必须精确等于约定的字段（多一个也算泄露）'
    + '｜⚠️ P7 新增 roles：前端要按角色分区导航（三端拆分），必须知道「你是谁」。'
    + 'roles 是**角色键列表**（admin/captain/judge/…），不是能力也不是授权记录 —— '
    + '它不构成任何授权依据（可见性始终在 API 层过滤），因此不属于「泄露」。'
    + '｜⚠️ W1-b（DP-105）新增 capabilities：前端要按**能力点**拦分区级路由，'
    + '必须知道这个人持有哪些能力点。它是**能力点键列表**（audit:read/…），'
    + '同样只是提示、不构成授权依据，因此不属于「泄露」。'
    + '｜⚠️ F48（2026-10-23 审计）新增 is_superadmin：对外形状**同时**带'
    + '`isSuperadmin`（布尔）与 `is_superadmin`（0|1）——服务层读超管标志的写法'
    + '历史上不统一（tier/workflow/performance-card/milestone 只认 `is_superadmin === 1`）'
    + '⇒ 只带驼峰时超管**静默降级**。两个键说的是同一件事（本人是不是超管），'
    + '不是新信息 ⇒ 不构成泄露。',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('停用用户的手机号不能被再次注册（查重不看 active）（终审 I-6-7）', () => {
  // ⛔ 终审发现（Important）：查重函数刻意**不看 active**（源码注释明写）——
  //    否则停用用户可以被**冒名重新注册**（别人拿他的手机号注册新账号）。
  //    这条不变量此前没有任何断言钉住：给查重加上 `AND active = 1` 全量测试照样全绿。
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900000007', password: 'pw' });
  deactivateUser(db, user.id);
  assert.throws(
    () => createUser(db, { name: '乙冒名', phone: '13900000007', password: 'pw' }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PHONE_TAKEN');
      return true;
    },
    '停用用户的手机号不得被再次注册',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

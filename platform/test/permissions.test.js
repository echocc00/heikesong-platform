// platform/test/permissions.test.js —— capability + assignment 权限模型
//
// 规则溯源（本文件每条断言对应的来源文档与章节）：
//   - 「权限不靠角色枚举，靠『能力 + 授权记录』」→ 设计文档 §7.1 / §7.2
//   - 「can() 是唯一判定入口」→ 设计文档 §7.1；跨阶段契约见 INTERFACES.md:76
//   - 「权限过滤必须在 SQL 的 WHERE 里，不能先查全量再在 JS 里 filter」
//     → 设计文档 §7.2 约束 2
//   - 「上级作用域不隐式下推（edition 授权不自动覆盖其下的 task_package）」
//     → 设计文档 §7.2 作用域约定
//   - 「所有 SQL 收进 src/db/repo/」→ 全局约束「SQL 边界」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { can, grantAssignment, listAssignments, scopeClause } from '../src/auth/permissions.js';
import { createUser } from '../src/db/repo/users.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations',
);

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-perm-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO capabilities (key, description) VALUES
      ('score:write', '评分写入'),
      ('team:read', '战队读取');
    INSERT INTO roles (key, description) VALUES ('judge', '评委');
  `);
  const user = createUser(db, { name: '评委甲', phone: '13900000001', password: 'pw' });
  return { db, close, dataDir, user };
}

/** 造两张资源行：r_ok 有权、r_no 无权（用来真跑 scopeClause 生成的 SQL） */
function seedResources(db) {
  db.exec('CREATE TABLE fake_resources (id TEXT PRIMARY KEY, title TEXT)');
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('r_ok', '有权'), ('r_no', '无权')");
}

test('超级管理员拥有一切能力', () => {
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('没有授权时能力为 false', () => {
  const { db, close, dataDir, user } = setup();
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('角色能力命中即为 true', () => {
  // ⛔ 预审修正（I6-3）：原用例插完数据就 close()，**一条断言都没有** ——
  //    实现坏掉时它照样 PASS，"跑测试确认通过"证明不了角色能力这条路径。
  const { db, close, dataDir, user } = setup();
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('assignment 精确匹配 scope 时为 true', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id,
    capability: 'score:write',
    scopeType: 'task_package',
    scopeId: 'tp_7',
    grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_7' }, db), true);
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_8' }, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('global scope 匹配任何资源', () => {
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', { scopeType: 'task_package', scopeId: 'tp_x' }, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAssignments 按契约签名（对象参数）返回该用户该能力的授权', () => {
  // ⛔ 预审修正（I6-1）：契约是 listAssignments(db, { userId, capability })
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  const rows = listAssignments(db, { userId: user.id, capability: 'score:write' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].scope_type, 'global');
  assert.equal(listAssignments(db, { userId: user.id, capability: 'team:read' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 行级过滤真跑 SQL：有权那行在结果里、无权那行不在', () => {
  // ⛔ 预审修正（C6-2）：原用例只断言 sql.includes('?')（恒真）→ 实现坏掉也 PASS。
  //    现在真执行 SQL：造两张资源行，一张有权一张无权。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), ['r_ok']);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 单资源模式：scopeId 命中才放行', () => {
  // 模式二是**单资源守卫**：它回答「用户对 scopeId 这个资源有没有权限」，
  // 用法是配合 `WHERE t.id = ?` 一起用（P1 的单条读取接口就是这种用法），
  // 它本身不是行过滤器 —— 行过滤用模式一（alias）。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: 'r_ok', grantedBy: user.id,
  });
  const allowed = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_ok' });
  const denied = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'r_no' });
  const ok = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + allowed.sql)
    .all('r_ok', ...allowed.params);
  const no = db.prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + denied.sql)
    .all('r_no', ...denied.params);
  assert.deepEqual(ok.map((r) => r.id), ['r_ok']);
  assert.deepEqual(no.map((r) => r.id), []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 的占位符个数恒等于 params 个数', () => {
  // ⛔ 预审修正（C6-2）：原实现 SQL 3 个占位符却推 4 个值 → column index out of range。
  const { db, close, dataDir, user } = setup();
  const modes = [
    scopeClause(user.id, 'score:write'),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' }),
    scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId: 'tp_1' }),
  ];
  for (const { sql, params } of modes) {
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(placeholders, params.length);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause：alias 与 scopeId 互斥，同时给直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias: 't', scopeId: 'tp_1' }),
    /互斥/,
  );
});

test('scopeClause：给了 scopeType 却没给 alias / scopeId 直接抛错', () => {
  assert.throws(
    () => scopeClause('u_1', 'score:write', { scopeType: 'task_package' }),
    /alias|scopeId/,
  );
});

test('停用用户判 false；没有 active 字段的精简对象不当成停用', () => {
  // ⛔ 预审修正（m6-1）：原来写 user.active === 0 ——
  //    传入 { id, is_superadmin: 1 }（无 active 字段）时，被停用的用户会被判为有权。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0 }, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, is_superadmin: 0, active: 0 }, 'score:write', null, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('超管标志两种形状都认（仓储行 / toPublicUser 的驼峰形状）', () => {
  // ⛔ 跨 Task 接口缝：can() 只认 snake_case 时，调用方传 toPublicUser() 的
  //    驼峰形状会让**超管静默失去全部权限**（症状：管理员登进去什么都点不动）。
  //    can() 是全项目唯一权限入口，必须两种形状都认。
  const { db, close, dataDir, user } = setup();
  user.is_superadmin = 1;
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(can({ id: user.id, isSuperadmin: true, active: true }, 'score:write', null, db), true);
  // 反向：非超管的驼峰形状不能被误判成超管
  assert.equal(
    can({ id: user.id, isSuperadmin: false, active: true }, 'score:write', null, db),
    false,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

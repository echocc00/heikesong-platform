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
import { can, grantAssignment, revokeAssignment, listAssignments, scopeClause } from '../src/auth/permissions.js';
import { createUser } from '../src/db/repo/users.js';
import { AppError } from '../src/errors.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

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

test('scopeId 为**数字**时，can() 与 scopeClause() 必须给出相同结论', () => {
  // ⛔ 终审修正（Important，I-4）：assignments.scope_id 是 TEXT 列，取回是字符串；
  //    而 ctx.scopeId 若来自 parseInt() 就是数字。
  //    原来 can() 用严格相等 `row.scope_id === ctx.scopeId` → '42' ≠ 42 → false；
  //    但 scopeClause 走 SQL 的**类型亲和** → `a.scope_id = 42` 能匹配上 TEXT '42'。
  //    于是同一个用户：can() 说「没权限」、scopeClause 把行放出来 —— **相反结论**。
  //    这直接违反 INTERFACES.md:22「两者必须给出相同结论」。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  // 造一行 id 是**数字形态**的资源（存成 TEXT '42'），用来对照数字 scopeId
  db.exec("INSERT INTO fake_resources (id, title) VALUES ('42', '数字 id 资源')");
  grantAssignment(db, {
    userId: user.id, capability: 'score:write',
    scopeType: 'task_package', scopeId: '42', grantedBy: user.id,
  });

  // 数字形式：can() 必须判有权
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: 42 }, db),
    true,
    '数字 scopeId 时 can() 必须判有权（scope_id 存的是 TEXT "42"）',
  );

  // 字符串形式：结论必须相同（两条路径不能分裂）
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: '42' }, db),
    true,
    '字符串 scopeId 时 can() 必须判有权',
  );

  // 契约要求：can() 与 scopeClause() 的结论一致 —— 数字形式下 scopeClause 放行的行，
  // can() 也必须放行（否则「能看见行但没权限」/「有权却看不见行」）
  for (const scopeId of ['42', 42]) {
    // 模式二（单资源）：scopeId 直接进 SQL 的 WHERE
    const single = scopeClause(user.id, 'score:write', { scopeType: 'task_package', scopeId });
    const singleRows = db
      .prepare('SELECT t.id FROM fake_resources t WHERE t.id = ? AND ' + single.sql)
      .all('42', ...single.params)
      .map((r) => r.id);
    assert.deepEqual(
      singleRows,
      ['42'],
      `scopeId=${JSON.stringify(scopeId)} 时 scopeClause（单资源模式）应放行该行`,
    );
    assert.equal(
      can(user, 'score:write', { scopeType: 'task_package', scopeId }, db),
      true,
      `scopeId=${JSON.stringify(scopeId)} 时 can() 与 scopeClause 结论必须一致`,
    );

    // 模式一（行级）：scopeId 不进 SQL，改用 alias 比 resource.id
    const rowLevel = scopeClause(user.id, 'score:write', { scopeType: 'task_package', alias: 't' });
    const rowRows = db
      .prepare('SELECT t.id FROM fake_resources t WHERE ' + rowLevel.sql)
      .all(...rowLevel.params)
      .map((r) => r.id);
    assert.deepEqual(
      rowRows,
      ['42'],
      `scopeId=${JSON.stringify(scopeId)} 时 scopeClause（行级模式）应放行该行`,
    );
    assert.equal(
      can(user, 'score:write', { scopeType: 'task_package', scopeId }, db),
      true,
      `scopeId=${JSON.stringify(scopeId)} 时 can() 与 scopeClause（行级模式）结论必须一致`,
    );
  }

  // 反例对照：无关的 scopeId 两边都必须拒绝（防止「一律放行」的恒绿断言）
  assert.equal(
    can(user, 'score:write', { scopeType: 'task_package', scopeId: 43 }, db),
    false,
    '数字 scopeId 不得放宽匹配：43 与 42 不是同一个资源',
  );

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 的占位符个数恒等于 params 个数', () => {  // ⛔ 预审修正（C6-2）：原实现 SQL 3 个占位符却推 4 个值 → column index out of range。
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

test('scopeClause 对超管不做行级过滤（与 can() 一致）', () => {
  // ⛔ 评审修正（Important）：can() 与 scopeClause 曾对超管给出**相反结论** ——
  //    can() = true（超管什么都能干），scopeClause 却过滤出 0 行。
  //    这直接违反 INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...)」：
  //    一个说"有权限"，另一个说"看不到任何行"。
  //    P0 没有调用方，但 P2 计划明写「行级 scope 由 P3/P4 的 scopeClause 补齐」——
  //    P3/P4 的列表接口一接，超管就会看到空列表。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), true);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['r_no', 'r_ok'], '超管应看到全部行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对角色授权用户不做行级过滤（与 can() 一致）', () => {
  // ⛔ 评审修正（Important）：同上，但走的是 role_capabilities 这条路。
  //    设计文档 §7.1 的判定顺序是「超管 → true；role_capability 命中 → true」，
  //    两者都是**无作用域**授权 → 行级过滤对它们一律不设限。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare("INSERT INTO role_capabilities (role_id, capability) VALUES ('judge','score:write')").run();
  db.prepare("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'judge')").run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), true);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['r_no', 'r_ok'], '角色授权用户应看到全部行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('scopeClause 对**停用**用户不放开行级过滤', () => {
  // 与 can() 保持一致：停用用户 can() = false，行级过滤也不能给他行。
  const { db, close, dataDir, user } = setup();
  seedResources(db);
  db.prepare('UPDATE users SET is_superadmin = 1, active = 0 WHERE id = ?').run(user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(can(row, 'score:write', {}, db), false);
  const { sql, params } = scopeClause(user.id, 'score:write', {
    scopeType: 'task_package', alias: 't',
  });
  const rows = db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params);
  assert.deepEqual(rows.map((r) => r.id), [], '停用用户不应看到任何行');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('alias 必须是合法 SQL 标识符（SQL 注入防护）', () => {
  // ⚠️ 评审修正（Important）：这道护栏此前**零测试覆盖** ——
  //    把白名单整行删掉，13 条用例照样全绿（评审实测）。
  //    alias 会被拼进 SQL 字符串，注入面必须钉住。
  const payloads = [
    't; DROP TABLE users',
    't x',
    't/*c*/',
    '"t"',
    '`t`',
    't)',
    't,',
    '1t',
    't-1',
  ];
  for (const alias of payloads) {
    assert.throws(
      () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias }),
      /alias/,
      `alias=${JSON.stringify(alias)} 必须被拒绝`,
    );
  }
  for (const alias of ['t', 'tp', '_x', 'T1', 'task_package']) {
    assert.doesNotThrow(
      () => scopeClause('u_1', 'score:write', { scopeType: 'task_package', alias }),
      `alias=${alias} 是合法标识符，不该被拒`,
    );
  }
});

test('grantAssignment 对未注册能力点/不存在用户抛领域错误，不漏原始 SQLite 错误', () => {
  // ⚠️ 评审修正（Important）：原来直接 INSERT → SQLite 原始外键错误
  //    「FOREIGN KEY constraint failed」冒到 HTTP 层（只能回 500，且泄露表结构）。
  //    这与 I5-3（users.phone 重复）是同一类问题 —— 当时修了，这儿漏了。
  const { db, close, dataDir, user } = setup();
  assert.throws(
    () => grantAssignment(db, {
      userId: user.id, capability: 'no:such:cap', scopeType: 'global', scopeId: null,
    }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 400);
      assert.equal(err.code, 'CAPABILITY_UNKNOWN');
      assert.ok(!/FOREIGN KEY/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  assert.throws(
    () => grantAssignment(db, {
      userId: 'no_such_user', capability: 'score:write', scopeType: 'global', scopeId: null,
    }),
    (err) => {
      assert.ok(err instanceof AppError, '领域错误必须是 AppError（契约 INTERFACES.md「错误」纪律）');
      assert.equal(err.status, 404);
      assert.equal(err.code, 'USER_NOT_FOUND');
      assert.ok(!/FOREIGN KEY/.test(err.message), '不能把 SQLite 原文漏到 HTTP 层');
      return true;
    },
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('revokeAssignment 撤销后该条授权失效', () => {
  // ⚠️ 评审修正（Minor）：revokeAssignment 是 INTERFACES.md 契约里的 API，
  //    但此前**零测试覆盖**（变异「撤销空转」全绿）。
  const { db, close, dataDir, user } = setup();
  const id = grantAssignment(db, {
    userId: user.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can(user, 'score:write', null, db), true);
  assert.equal(revokeAssignment(db, id), 1);
  assert.equal(can(user, 'score:write', null, db), false);
  assert.equal(listAssignments(db, { userId: user.id, capability: 'score:write' }).length, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('can() 对缺 id 的用户 fail-closed 返回 false，而不是抛错', () => {
  // ⚠️ 评审修正：原来直接拿 undefined 去绑定 SQLite 参数 → TypeError → 整个请求 500。
  //    权限判定的失败方向必须是"少给权限"，不是"整个服务崩掉"。
  const { db, close, dataDir } = setup();
  assert.equal(can({}, 'score:write', {}, db), false);
  assert.equal(can({ id: undefined }, 'score:write', {}, db), false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('停用用户（布尔形状）判 false', () => {
  // ⚠️ 评审修正：active 的**布尔形状**（正是 toPublicUser 产出的形状）此前没被钉住 ——
  //    把判断改回 `user.active === 0` 时，`false === 0` 为 false → 停用用户被放行。
  const { db, close, dataDir, user } = setup();
  grantAssignment(db, {
    userId: user.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: user.id,
  });
  assert.equal(can({ id: user.id, active: false, isSuperadmin: false }, 'score:write', null, db), false);
  assert.equal(can({ id: user.id, active: true, isSuperadmin: false }, 'score:write', null, db), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-mig2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

test('P1 的 7 张表都建出来了', () => {
  const { db, close, dataDir } = setup();
  const names = tableNames(db);
  for (const t of [
    'editions', 'cities', 'task_packages',
    'registrations', 'registration_events', 'teams', 'team_members',
  ]) {
    assert.ok(names.includes(t), `缺少表 ${t}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('registrations 的列与 INTERFACES.md §2 逐字一致', () => {
  const { db, close, dataDir } = setup();
  const cols = columnsOf(db, 'registrations');
  const expected = [
    'id', 'edition_id', 'user_id', 'answers_json', 'dimension_scores_json',
    'raw_score', 'level', 'level_final', 'decided_by', 'decided_at',
    'decision_note', 'status', 'created_at', 'deleted_at',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `registrations 缺少列 ${c}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('task_packages 的列与 INTERFACES.md §2 逐字一致', () => {
  const { db, close, dataDir } = setup();
  const cols = columnsOf(db, 'task_packages');
  const expected = [
    'id', 'edition_id', 'enterprise_id', 'enterprise_name', 'title', 'pain_point',
    'expected_delivery', 'acceptance_criteria', 'grade', 'status',
    'solvability_score', 'solvability_grade', 'commitment', 'agreement',
    'is_free_brief', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at',
    'deleted_at',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `task_packages 缺少列 ${c}`);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('teams / team_members / registration_events 的列齐全', () => {
  const { db, close, dataDir } = setup();
  const teams = columnsOf(db, 'teams');
  for (const c of ['id', 'edition_id', 'name', 'captain_id', 'task_package_id', 'tier', 'status', 'created_at', 'deleted_at']) {
    assert.ok(teams.includes(c), `teams 缺少列 ${c}`);
  }
  const members = columnsOf(db, 'team_members');
  for (const c of ['team_id', 'user_id', 'role', 'joined_at', 'left_at']) {
    assert.ok(members.includes(c), `team_members 缺少列 ${c}`);
  }
  const events = columnsOf(db, 'registration_events');
  for (const c of ['id', 'registration_id', 'from_status', 'to_status', 'actor_id', 'reason', 'created_at']) {
    assert.ok(events.includes(c), `registration_events 缺少列 ${c}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('软删除列存在且可空', () => {
  const { db, close, dataDir } = setup();
  for (const t of ['task_packages', 'registrations', 'teams']) {
    const info = db.prepare(`PRAGMA table_info(${t})`).all();
    const col = info.find((c) => c.name === 'deleted_at');
    assert.ok(col, `${t} 缺少 deleted_at`);
    assert.equal(col.notnull, 0, `${t}.deleted_at 必须可空`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('外键真的生效：edition_id 不存在时插入失败', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900001001', password: 'pw', mbaStatus: 'mba' });
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO registrations (id, edition_id, user_id, answers_json, status, created_at)
           VALUES ('r1', 'edition_missing', ?, '{}', 'submitted', '2026-10-20T00:00:00.000Z')`,
        )
        .run(user.id),
    /FOREIGN KEY|constraint/i,
    '外键未被强制',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('同一 userId + editionId 不能重复报名（幂等守卫在数据库层）', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900001002', password: 'pw', mbaStatus: 'mba' });
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('e1', '首届', '上海', '2026-10-01', '2026-10-31', '2026-10-20T00:00:00.000Z')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO registrations (id, edition_id, user_id, answers_json, status, created_at)
     VALUES (?, 'e1', ?, '{}', 'submitted', '2026-10-20T00:00:00.000Z')`,
  );
  ins.run('r1', user.id);
  assert.throws(() => ins.run('r2', user.id), /UNIQUE|constraint/i, '重复报名未被拦截');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('一个用户只能同时属于一个战队（部分唯一索引）', () => {
  const { db, close, dataDir } = setup();
  const user = createUser(db, { name: '甲', phone: '13900001003', password: 'pw', mbaStatus: 'mba' });
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('e1', '首届', '上海', '2026-10-01', '2026-10-31', '2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO teams (id, edition_id, name, captain_id, status, created_at)
     VALUES ('t1', 'e1', '一队', ?, 'forming', '2026-10-20T00:00:00.000Z')`,
  ).run(user.id);
  const ins = db.prepare(
    `INSERT INTO team_members (id, team_id, user_id, role, joined_at, left_at)
     VALUES (?, 't1', ?, 'member', '2026-10-20T00:00:00.000Z', NULL)`,
  );
  ins.run('m1', user.id);
  assert.throws(
    () => ins.run('m2', user.id),
    /UNIQUE|constraint/i,
    '同一用户同时加入两个战队未被拦截',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

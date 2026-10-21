import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  syncPoolProjects, syncPoolTalents, syncPoolResources,
  listPoolProjects, listPoolTalents, listPoolResources,
} from '../src/services/pools.js';
import {
  aggregatePersonalPoints, derivePoolProjects, derivePoolTalents, derivePoolResources,
} from '../src/domain/pool-derive.js';
import { computePersonalPoints } from '../src/domain/points.js';
import * as poolSourcesRepo from '../src/db/repo/pool-sources.js';
import { loadRules, validateRules } from '../src/config.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

// 统一的注入时间：所有断言都基于它，时间口径才可复算
const NOW = '2026-10-20T00:00:00.000Z';
// 超管：读三池时不需要任何授权记录
const SUPER = { id: 'u_a', is_superadmin: 1, active: 1 };

function setup(extraSql = '') {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5pool-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000021', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_b', '乙', '13900000022', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_c', '丙', '13900000023', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z'),
           ('ed_2', '第二届', '杭州', '2027-10-01', '2027-10-31', '2027-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_2', 'ed_1', 'ent_2', '某零售', '门店补货助手', '人工盘点慢', '可演示原型', '能跑', 'B',
      'approved', 8, 'B', '对标试点', '对标试点协议', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_3', 'ed_1', 'ent_1', '某银行', '反欺诈评分', '欺诈识别难', '可演示原型', '能跑', 'B',
      'approved', 8, 'B', '对标试点', '对标试点协议', 1, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_4', 'ed_2', 'ent_1', '某银行', '风控助手二代', '审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2027-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_b', 'tp_2', 'D', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_3', 'ed_2', '三队', 'u_a', 'tp_4', 'C', 'active', '2027-10-01T00:00:00.000Z', NULL);
    -- ⚠️ P1 建了部分唯一索引 idx_team_members_active(user_id) WHERE left_at IS NULL：
    --    「同一人只能同时在一个战队」。所以 u_a 离开第一届的队之后，才能进第二届的队。
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
           ('tm_2', 'u_b', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_3', 'u_a', 'captain', '2027-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '任务', 'initial', '2026-10-10', '2026-10-13', NULL, 'initial', 'computed'),
           ('st_3', 'ed_2', 's1', '调研', 'initial', '2027-10-01', '2027-10-10', NULL, 'initial', 'draft');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_3', 'st_2', 'tm_1', 1, 88.0, 86.0, 92.0, 0, 10, NULL, '2026-10-13T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL);
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z'),
           ('pl_2', 'ed_1', 'st_2', 'tm_1', 'u_a', 'mvp', 5, '2026-10-13T00:00:00.000Z'),
           ('pl_3', 'ed_2', 'st_3', 'tm_3', 'u_a', 'stage_rank', 8, '2027-10-10T00:00:00.000Z');
    INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
      level, level_final, decided_by, decided_at, decision_note, status, created_at, deleted_at)
    VALUES ('rg_1', 'ed_1', 'u_a', '{}', '{"direction":5,"capability":4,"collaboration":5}', 80,
      'S', 'S', 'u_c', '2026-10-01T00:00:00.000Z', NULL, 'registered', '2026-10-01T00:00:00.000Z', NULL);
  `);
  if (extraSql) db.exec(extraSql);
  return { db, close, dataDir };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

function snapshot(db) {
  return {
    projects: db.prepare('SELECT * FROM pool_projects ORDER BY edition_id, team_id').all(),
    talents: db.prepare('SELECT * FROM pool_talents ORDER BY edition_id, user_id').all(),
    resources: db.prepare('SELECT * FROM pool_resources ORDER BY edition_id, enterprise_id, kind').all(),
  };
}

function syncAll(db, now = NOW) {
  syncPoolProjects({ db, editionId: 'ed_1', now });
  syncPoolTalents({ db, editionId: 'ed_1', now });
  syncPoolResources({ db, editionId: 'ed_1', now });
}

function counts(result) {
  return {
    inserted: result.inserted, updated: result.updated, removed: result.removed, total: result.total,
  };
}

test('项目池从 teams + stage_results + tier_records 派生', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const rows = listPoolProjects({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 2);
  const t1 = rows.find((r) => r.teamId === 'tm_1');
  assert.equal(t1.title, '零售风控助手', '项目名来自任务包标题');
  assert.equal(t1.stageReached, 's2', 'stage_reached 取该队到达的最远赛段');
  assert.equal(t1.tier, 'C', 'tier 取段位记录');
  assert.equal(t1.businessValue, 1, 'business_value 取企业业务签字数');
  assert.ok(String(t1.summary).includes('一队'));
  assert.ok(String(t1.summary).includes('人工审批慢'), '摘要里带任务包痛点');
  const t2 = rows.find((r) => r.teamId === 'tm_2');
  assert.equal(t2.stageReached, 's1');
  assert.equal(t2.tier, 'D');
  assert.equal(t2.businessValue, 0, 'business_value 原样取企业业务签字数（不是恒为 1）');
  cleanup(db, close, dataDir);
});

test('人才池从 points_ledger 聚合，且积分是终生累计（R-RNK-10）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const rows = listPoolTalents({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 1, '没有积分记录的人不进人才池');
  const t = rows[0];
  assert.equal(t.userId, 'u_a');
  assert.equal(t.totalPoints, 23, '10 + 5 + 8（含第二届）= 终生累计 23');
  assert.equal(t.stagesJoined, 3, '参与过的赛段数按 distinct stage 算');
  assert.equal(t.skills.length, 3, '技能来自报名画像维度分');
  assert.deepEqual(
    t.skills.map((s) => s.key),
    ['capability', 'collaboration', 'direction'],
    '技能键按字典序（确定性排序）',
  );
  assert.equal(t.name, '甲', '档案名来自 users');
  assert.equal(t.org, '学堂', '所属单位来自 users');
  assert.equal(t.mbaStatus, 'mba');
  cleanup(db, close, dataDir);
});

test('资源池从 task_packages 按（企业 × 类型）分组', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  const rows = listPoolResources({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 3, '某银行的企业题 + 某银行的自由题 + 某零售的企业题');
  const bank = rows.filter((r) => r.enterpriseId === 'ent_1');
  assert.equal(bank.length, 2);
  assert.deepEqual(bank.map((r) => r.kind).sort(), ['enterprise_brief', 'free_brief']);
  cleanup(db, close, dataDir);
});

test('同步是幂等重建：连跑两次，三池内容完全一致', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const first = snapshot(db);
  syncAll(db);
  const second = snapshot(db);
  assert.deepEqual(second, first, '连跑两次同步结果必须一致');
  cleanup(db, close, dataDir);
});

test('同步是重建不是累加：改了积分流水，重跑同步后积分按新值重算', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const before = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a').p;
  assert.equal(before, 23);

  db.prepare('UPDATE points_ledger SET points = 3 WHERE id = ?').run('pl_1');
  syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-21T00:00:00.000Z' });

  const after = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a').p;
  assert.equal(after, 16, '3 + 5 + 8 = 16（重算）；若实现成累加会是 23');
  cleanup(db, close, dataDir);
});

test('派生值唯一真源：库里的 total_points 与积分流水聚合一致', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  const sum = db
    .prepare('SELECT COALESCE(SUM(points), 0) AS s FROM points_ledger WHERE user_id = ?')
    .get('u_a').s;
  assert.equal(row.p, sum, '人才池积分必须等于积分流水之和（唯一计算点）');
  cleanup(db, close, dataDir);
});

test('没有 pool:read 能力的用户读到空数组（列表不满足 → 200 + 空集）', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const rows = listPoolProjects({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_c', is_superadmin: 0, active: 1 },
  });
  assert.deepEqual(rows, []);
  cleanup(db, close, dataDir);
});

// ── 幂等重建的【判别性】用例 ────────────────────────────────────────
// 期望值「恰好相同」区分不出两种算法 ⇒ 这里比的是**第二次同步的计数**与**行身份**：
//   · 累加实现：第二次 inserted=0/updated=0，库里积分翻倍
//   · 删了重建：内容相同但 inserted=2、行 id 全变
//   · 真正的幂等重建：第二次 inserted=0/updated=N，行 id 不变，值不变

test('幂等判别性：第二次同步是覆盖（inserted=0, updated=N），第三次与第二次完全一致', () => {
  const { db, close, dataDir } = setup();
  const first = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(first), { inserted: 2, updated: 0, removed: 0, total: 2 });
  const second = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(
    counts(second),
    { inserted: 0, updated: 2, removed: 0, total: 2 },
    '第二次必须覆盖既有行，而不是再插一批',
  );
  const third = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(third), counts(second), '稳态：第三次与第二次的计数必须一致');
  cleanup(db, close, dataDir);
});

test('幂等判别性：重复同步后行 id 不变（是覆盖同一行，不是删了重建）', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const before = snapshot(db);
  syncAll(db);
  const after = snapshot(db);
  assert.equal(after.projects.length, before.projects.length);
  assert.deepEqual(
    after.projects.map((r) => r.id),
    before.projects.map((r) => r.id),
    '项目池行 id 必须稳定',
  );
  assert.deepEqual(
    after.talents.map((r) => r.id),
    before.talents.map((r) => r.id),
    '人才池行 id 必须稳定',
  );
  assert.deepEqual(
    after.resources.map((r) => r.id),
    before.resources.map((r) => r.id),
    '资源池行 id 必须稳定',
  );
  cleanup(db, close, dataDir);
});

test('幂等判别性：重复同步后积分不变（重建不是累加，不会变成 23+23=46）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  assert.equal(row.p, 23, '跑三次仍是 23：增量累加会得到 69');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_talents').get().n,
    1,
    '跑三次仍只有一行',
  );
  cleanup(db, close, dataDir);
});

test('人才池幂等判别性：第二次同步 inserted=0 / updated=1，行数不增', () => {
  const { db, close, dataDir } = setup();
  const first = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(first), { inserted: 1, updated: 0, removed: 0, total: 1 });
  const second = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(second), { inserted: 0, updated: 1, removed: 0, total: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pool_talents').get().n, 1);
  cleanup(db, close, dataDir);
});

test('同步结果回显注入的 now 与 editionId（时间口径可复算）', () => {
  const { db, close, dataDir } = setup();
  const r = syncPoolProjects({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(r.at, '2026-10-20T00:00:00.000Z');
  assert.equal(r.editionId, 'ed_1');
  const t = syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(t.at, '2026-10-20T00:00:00.000Z');
  const res = syncPoolResources({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(res.at, '2026-10-20T00:00:00.000Z');
  cleanup(db, close, dataDir);
});

// ── 移除路径（派生源变了就重跑同步，不做增量修补）──────────────────

test('派生源消失后重跑同步：该项目从项目池移除（removed 计数准确）', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  db.prepare('UPDATE teams SET deleted_at = ? WHERE id = ?').run('2026-10-19T00:00:00.000Z', 'tm_2');
  const second = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(second), { inserted: 0, updated: 1, removed: 1, total: 1 });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_projects').get().n,
    1,
    '被软删的队伍对应的项目行必须消失',
  );
  cleanup(db, close, dataDir);
});

test('任务包被软删后重跑同步：资源池对应行被移除', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  db.prepare('UPDATE task_packages SET deleted_at = ? WHERE id = ?').run('2026-10-19T00:00:00.000Z', 'tp_3');
  const second = syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  assert.equal(second.removed, 1);
  assert.equal(second.total, 2);
  const rows = listPoolResources({ db, filter: { editionId: 'ed_1' }, viewer: SUPER });
  assert.equal(rows.filter((r) => r.kind === 'free_brief').length, 0, '自由题资源行必须消失');
  cleanup(db, close, dataDir);
});

test('积分流水被撤回后重跑同步：本人从本届人才池移除', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  db.prepare('DELETE FROM points_ledger WHERE id = ?').run('pl_1');
  db.prepare('DELETE FROM points_ledger WHERE id = ?').run('pl_2');
  const second = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.equal(second.removed, 1);
  assert.equal(second.total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pool_talents').get().n, 0);
  cleanup(db, close, dataDir);
});

test('段位记录有多条时，取 computed_at 最新的一条', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_3', 'tm_2', 'C', 3, 2, '[]', '2026-10-15T00:00:00.000Z', NULL);
  `);
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT tier, business_value FROM pool_projects WHERE team_id = ?').get('tm_2');
  assert.equal(row.tier, 'C', '后算的段位记录覆盖先算的');
  assert.equal(row.business_value, 2);
  cleanup(db, close, dataDir);
});

test('报名记录被软删后重跑同步：技能仍取有效的那一条', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
      level, level_final, decided_by, decided_at, decision_note, status, created_at, deleted_at)
    VALUES ('rg_2', 'ed_1', 'u_a', '{}', '{"zzz":1}', 10, 'S', 'S', 'u_c',
      '2026-10-02T00:00:00.000Z', NULL, 'registered', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
  `);
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT skills_json FROM pool_talents WHERE user_id = ?').get('u_a');
  const skills = JSON.parse(row.skills_json);
  assert.deepEqual(
    skills.map((s) => s.key),
    ['capability', 'collaboration', 'direction'],
    '软删的报名画像不进技能',
  );
  cleanup(db, close, dataDir);
});

test('段位记录被软删后重跑同步：项目池回落到队伍自身的 tier', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  db.prepare('UPDATE tier_records SET deleted_at = ? WHERE id = ?').run('2026-10-19T00:00:00.000Z', 'tr_1');
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT tier, business_value FROM pool_projects WHERE team_id = ?').get('tm_1');
  assert.equal(row.tier, 'C', '软删段位记录后回落到 teams.tier');
  assert.equal(row.business_value, null, '没有段位记录就没有商业签字数（不臆造）');
  cleanup(db, close, dataDir);
});

// ── 届期隔离与终生口径 ──────────────────────────────────────────────

test('同一人在两届都有行时，积分在两行上完全相同（终生累计，不做两份算法）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_2', now: NOW });
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const rows = db.prepare('SELECT edition_id, total_points FROM pool_talents ORDER BY edition_id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.edition_id), ['ed_1', 'ed_2']);
  assert.deepEqual(
    rows.map((r) => r.total_points),
    [23, 23],
    '两届都是终生口径 23（若按届期算则是 15 与 8）',
  );
  cleanup(db, close, dataDir);
});

test('跨届期刷新：改了流水后只同步一届，同一人的另一届那行也必须跟着变', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_2', now: NOW });
  db.prepare('UPDATE points_ledger SET points = 20 WHERE id = ?').run('pl_3');
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const rows = db.prepare('SELECT edition_id, total_points FROM pool_talents ORDER BY edition_id').all();
  assert.deepEqual(
    rows.map((r) => r.total_points),
    [35, 35],
    '同一人在任何一行里的积分都必须相同（不做两份算法：10+5+20=35）',
  );
  cleanup(db, close, dataDir);
});

test('届期隔离：同步一届不会动到另一届的资源池', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  syncPoolResources({ db, editionId: 'ed_2', now: NOW });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_resources WHERE edition_id = ?').get('ed_1').n,
    3,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_resources WHERE edition_id = ?').get('ed_2').n,
    1,
  );
  // 再同步 ed_1：ed_2 的资源行一个都不能少
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_resources WHERE edition_id = ?').get('ed_2').n,
    1,
    '同步一届不能把另一届的资源行当成陈旧行删掉',
  );
  cleanup(db, close, dataDir);
});

test('届期隔离：同步一届不会动到另一届的项目池', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const ed1Before = db.prepare('SELECT id, title FROM pool_projects WHERE edition_id = ?').all('ed_1');
  syncPoolProjects({ db, editionId: 'ed_2', now: NOW });
  const ed1After = db.prepare('SELECT id, title FROM pool_projects WHERE edition_id = ?').all('ed_1');
  assert.deepEqual(ed1After, ed1Before, 'ed_1 的行一个都不该被 ed_2 的同步改到');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_projects WHERE edition_id = ?').get('ed_2').n,
    1,
    'ed_2 只有三队一个项目',
  );
  cleanup(db, close, dataDir);
});

// ── 可见性 / 过滤 ────────────────────────────────────────────────────

test('有 edition 作用域授权的用户读得到本届时，读不到别届', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO capabilities (key, description) VALUES ('pool:read', '读取三池');
    INSERT INTO assignments (id, user_id, capability, scope_type, scope_id, granted_by, created_at)
    VALUES ('as_1', 'u_c', 'pool:read', 'edition', 'ed_1', 'u_a', '2026-10-01T00:00:00.000Z');
  `);
  syncAll(db);
  const viewer = { id: 'u_c', is_superadmin: 0, active: 1 };
  assert.equal(listPoolProjects({ db, filter: { editionId: 'ed_1' }, viewer }).length, 2);
  assert.deepEqual(listPoolProjects({ db, filter: { editionId: 'ed_2' }, viewer }), []);
  cleanup(db, close, dataDir);
});

test('被停用的用户读到空数组（列表不满足 → 空集，不给半截数据）', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const rows = listPoolTalents({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 0 },
  });
  assert.deepEqual(rows, []);
  cleanup(db, close, dataDir);
});

test('列表过滤：limit / userId / minPoints / enterpriseId / kind 生效', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_d', '丁', '13900000024', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_4', 'ed_1', 'st_1', 'tm_2', 'u_d', 'stage_rank', 4, '2026-10-10T00:00:00.000Z');
  `);
  syncAll(db);
  const all = listPoolTalents({ db, filter: { editionId: 'ed_1' }, viewer: SUPER });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.userId), ['u_a', 'u_d'], '积分倒序');
  assert.equal(listPoolTalents({ db, filter: { editionId: 'ed_1', limit: 1 }, viewer: SUPER }).length, 1);
  assert.equal(listPoolProjects({ db, filter: { editionId: 'ed_1', limit: 1 }, viewer: SUPER }).length, 1);
  assert.equal(listPoolResources({ db, filter: { editionId: 'ed_1', limit: 2 }, viewer: SUPER }).length, 2);
  assert.deepEqual(
    listPoolTalents({ db, filter: { editionId: 'ed_1', userId: 'u_d' }, viewer: SUPER }).map((r) => r.userId),
    ['u_d'],
  );
  assert.deepEqual(
    listPoolTalents({ db, filter: { editionId: 'ed_1', minPoints: 10 }, viewer: SUPER }).map((r) => r.userId),
    ['u_a'],
  );
  assert.equal(
    listPoolResources({ db, filter: { editionId: 'ed_1', enterpriseId: 'ent_1' }, viewer: SUPER }).length,
    2,
  );
  assert.deepEqual(
    listPoolResources({ db, filter: { editionId: 'ed_1', kind: 'free_brief' }, viewer: SUPER })
      .map((r) => r.enterpriseId),
    ['ent_1'],
  );
  cleanup(db, close, dataDir);
});

// ── 规则口径（rules/pools.json 才是口径的唯一来源）───────────────────

test('规则口径：packageStatusFilter 只让白名单状态的任务包进资源池', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_5', 'ed_1', 'ent_3', '某保险', '理赔助手', '理赔慢', '可演示原型', '能跑', 'B',
      'submitted', 8, 'B', '对标试点', '对标试点协议', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL);
  `);
  const unfiltered = syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  assert.equal(unfiltered.total, 4, '默认不过滤状态');
  const filtered = syncPoolResources({
    db, editionId: 'ed_1', now: NOW, rules: { pools: { packageStatusFilter: ['approved'] } },
  });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.removed, 1, '口径变了，被排除的行要移出去');
  const rows = listPoolResources({ db, filter: { editionId: 'ed_1' }, viewer: SUPER });
  assert.ok(!rows.some((r) => r.enterpriseId === 'ent_3'), '未审批的任务包不进资源池');
  cleanup(db, close, dataDir);
});

test('规则口径：rules.points.personal.atomicKinds 决定哪些 kind 计入积分', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({
    db,
    editionId: 'ed_1',
    now: NOW,
    // ⚠️ 口径的唯一规则来源是 rules.points.personal（不再是 rules.pools.talentPointKinds）
    rules: { points: { personal: { atomicKinds: ['stage_rank'], rollupKind: 'personal_rollup' } } },
  });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  assert.equal(row.p, 18, '口径外只剩 stage_rank：10 + 8 = 18（默认口径是 23）');
  cleanup(db, close, dataDir);
});

// ── 错误与写后自检 ───────────────────────────────────────────────────

test('editionId 缺失 → AppError 400（EDITION_REQUIRED）', () => {
  const { db, close, dataDir } = setup();
  const check = (e) => e?.status === 400 && e?.code === 'EDITION_REQUIRED';
  assert.throws(() => syncPoolProjects({ db, now: NOW }), check);
  assert.throws(() => syncPoolTalents({ db, now: NOW }), check);
  assert.throws(() => syncPoolResources({ db, now: NOW }), check);
  cleanup(db, close, dataDir);
});

test('写后自检：库里的积分被改坏时，同步必须抛错（派生值只能有一个计算点）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  // 用触发器模拟「写入路径与重算路径算出不同结果」——正常实现走不到这一步，
  // 这里钉住的是：写完之后**确实**会用同一个纯函数重算比对，不一致就报错。
  db.exec(`
    CREATE TRIGGER trg_corrupt AFTER UPDATE ON pool_talents
    BEGIN
      UPDATE pool_talents SET total_points = total_points + 1 WHERE rowid = NEW.rowid;
    END;
  `);
  assert.throws(
    () => syncPoolTalents({ db, editionId: 'ed_1', now: NOW }),
    (e) => e?.status === 500 && e?.code === 'POOL_TALENT_POINTS_MISMATCH',
  );
  cleanup(db, close, dataDir);
});

// ── 领域纯函数（唯一计算点本身）────────────────────────────────────

test('领域纯函数：aggregatePersonalPoints 以 rollup 为准，并与 atomic 冲突时显式告警', () => {
  const { byUser, warnings } = aggregatePersonalPoints({
    ledger: [
      { user_id: 'u_x', kind: 'stage_rank', points: 10, stage_id: 'st_1' },
      { user_id: 'u_x', kind: 'personal_rollup', points: 12, stage_id: 'st_2' },
    ],
  });
  assert.equal(byUser.u_x.total, 12, '有 rollup 行时以 rollup 为准');
  assert.equal(byUser.u_x.breakdown.atomic, 10);
  assert.equal(byUser.u_x.breakdown.rollup, 12);
  assert.equal(byUser.u_x.stagesJoined, 2);
  assert.ok(
    warnings.some((w) => w.code === 'points_ledger_kind_conflict' && w.userId === 'u_x'),
    '两种口径不一致必须显式告警，不能静默',
  );
});

test('领域纯函数：未知 kind 被忽略并显式告警', () => {
  const { byUser, warnings } = aggregatePersonalPoints({
    ledger: [{ user_id: 'u_x', kind: 'weird_kind', points: 99 }],
  });
  assert.equal(byUser.u_x.total, 0, '口径外的 kind 不计入');
  assert.ok(warnings.some((w) => w.code === 'points_kind_ignored' && w.kind === 'weird_kind'));
});

test('领域纯函数：没有赛段的流水不计入赛段数；数组型画像不算技能', () => {
  const agg = aggregatePersonalPoints({
    ledger: [
      { user_id: 'u_x', kind: 'stage_rank', points: 5, stage_id: 'st_1' },
      { user_id: 'u_x', kind: 'stage_rank', points: 3 },
    ],
  });
  assert.equal(agg.byUser.u_x.stagesJoined, 1, '没有赛段的流水不占赛段数');
  assert.equal(agg.byUser.u_x.total, 8, '积分照算');

  const { rows } = derivePoolTalents({
    users: [{ id: 'u_x', name: '甲', org: null, mba_status: 'other' }],
    ledger: [{ user_id: 'u_x', kind: 'stage_rank', points: 5 }],
    registrations: [{ user_id: 'u_x', dimension_scores_json: '[1,2]', created_at: '2026-10-01' }],
  });
  assert.deepEqual(rows[0].skills, [], '画像不是对象就没有技能');
});

test('领域纯函数：derivePoolTalents 对缺失用户与坏技能 JSON 显式告警', () => {
  const { rows, warnings } = derivePoolTalents({
    users: [{ id: 'u_y', name: '乙', org: null, mba_status: 'other' }],
    ledger: [
      { user_id: 'u_x', kind: 'stage_rank', points: 3 },
      { user_id: 'u_y', kind: 'stage_rank', points: 4 },
    ],
    registrations: [
      { user_id: 'u_y', dimension_scores_json: '{不是 JSON', created_at: '2026-10-01' },
    ],
  });
  assert.equal(rows.length, 1, '查不到档案的人不进人才池');
  assert.equal(rows[0].userId, 'u_y');
  assert.deepEqual(rows[0].skills, [], '坏 JSON 不炸，技能为空');
  assert.ok(warnings.some((w) => w.code === 'talent_user_missing' && w.userId === 'u_x'));
  assert.ok(warnings.some((w) => w.code === 'skills_parse_failed' && w.userId === 'u_y'));
});

test('领域纯函数：derivePoolProjects 在任务包缺失时用队名兜底，最远赛段按 starts_at 定', () => {
  const rows = derivePoolProjects({
    teams: [{ id: 'tm_9', name: '九队', task_package_id: 'tp_missing', tier: 'C' }],
    packages: [],
    stageResults: [{ team_id: 'tm_9', stage_id: 'st_b' }, { team_id: 'tm_9', stage_id: 'st_a' }],
    stages: [
      { id: 'st_a', stage_key: 's1', starts_at: '2026-10-01' },
      { id: 'st_b', stage_key: 's2', starts_at: '2026-10-10' },
    ],
    tierRecords: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '九队', '任务包缺失时用队名兜底');
  assert.equal(rows[0].stageReached, 's2', '最远赛段按 starts_at 排序后取最远');
  assert.equal(rows[0].tier, 'C', '没有段位记录时用队伍自身的 tier');
  assert.equal(rows[0].businessValue, null);
});

test('领域纯函数：三个派生的排序都是确定性的（同一输入必得同一顺序）', () => {
  const projects = derivePoolProjects({
    teams: [
      { id: 'tm_2', name: '二队', task_package_id: 'tp_2', tier: 'D' },
      { id: 'tm_1', name: '一队', task_package_id: 'tp_1', tier: 'C' },
    ],
    packages: [],
    stageResults: [],
    stages: [],
    tierRecords: [],
  });
  assert.deepEqual(projects.map((r) => r.teamId), ['tm_1', 'tm_2'], '项目池按 teamId 升序');

  const talents = derivePoolTalents({
    users: [
      { id: 'u_b', name: '乙', org: null, mba_status: 'other' },
      { id: 'u_a', name: '甲', org: null, mba_status: 'mba' },
      { id: 'u_c', name: '丙', org: null, mba_status: 'other' },
    ],
    ledger: [
      { user_id: 'u_b', kind: 'stage_rank', points: 5 },
      { user_id: 'u_a', kind: 'stage_rank', points: 3 },
      { user_id: 'u_c', kind: 'stage_rank', points: 5 },
    ],
    registrations: [],
  });
  assert.deepEqual(
    talents.rows.map((r) => r.userId),
    ['u_b', 'u_c', 'u_a'],
    '先按积分倒序；积分相同时按 userId 升序（并列也必须可复算）',
  );

  const resources = derivePoolResources({
    packages: [
      { id: 'tp_9', enterprise_id: 'ent_2', enterprise_name: '某零售', title: 'B', pain_point: 'p', is_free_brief: 1 },
      { id: 'tp_8', enterprise_id: 'ent_2', enterprise_name: '某零售', title: 'A', pain_point: 'p', is_free_brief: 0 },
    ],
  });
  assert.deepEqual(
    resources.map((r) => r.kind),
    ['enterprise_brief', 'free_brief'],
    '同一企业的两种类型按 kind 升序（与输入顺序无关）',
  );
});

// ── 规则配置的 fail-fast（rules/pools.json 是口径的唯一来源）─────────

test('仓库自带的 rules/pools.json 能通过 fail-fast 校验（配置本身是对的）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.pools.id, 'pools');
  assert.equal(rules.pools.workflow.claimMode, 'self_claim_only');
});

test('规则校验：claimMode 不是 self_claim_only 会被拒绝启动（R-OPS-14 禁止岗位制）', () => {
  const { rules } = loadRules(rulesDir);
  const errors = validateRules({
    ...rules,
    pools: { ...rules.pools, workflow: { claimMode: 'by_role' } },
  });
  assert.ok(
    errors.some((e) => e.includes('claimMode')),
    `必须报错（实际 ${JSON.stringify(errors)}）`,
  );
});

test('规则校验：publicTokenTtlDays / publicScopes / talentTotalScope / taskEvidence 不合规都拒绝启动', () => {
  const { rules } = loadRules(rulesDir);
  const bad = [
    [{ ...rules.pools, publicTokenTtlDays: 0 }, 'publicTokenTtlDays'],
    [{ ...rules.pools, publicScopes: ['leaderboard'] }, 'publicScopes'],
    [{ ...rules.pools, talentTotalScope: 'edition' }, 'talentTotalScope'],
    [{ ...rules.pools, taskEvidence: { ...rules.pools.taskEvidence, requireRunnableOrBlocker: false } }, 'requireRunnableOrBlocker'],
  ];
  for (const [pools, keyword] of bad) {
    const errors = validateRules({ ...rules, pools });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `${keyword} 不合规必须报错（实际 ${JSON.stringify(errors)}）`,
    );
  }
});

test('★ 规则校验：交叉引用必须真实存在（引用不存在的取值一律拒绝启动）', () => {
  const { rules } = loadRules(rulesDir);
  // packageStatusFilter 写错一个拼写 ⇒ 过滤掉**全部**任务包 ⇒ 资源池空掉且不报任何错
  const badPools = [
    [{ ...rules.pools, packageStatusFilter: ['apprved'] }, 'packageStatusFilter 含不存在的任务包状态'],
    [{ ...rules.pools, packageStatusFilter: 'approved' }, 'packageStatusFilter 必须是数组'],
    [{ ...rules.pools, resourceKinds: ['nope'] }, 'resourceKinds 含不存在的资源类型'],
    [{ ...rules.pools, resourceKinds: [] }, 'resourceKinds 必须是非空数组'],
  ];
  for (const [pools, keyword] of badPools) {
    const errors = validateRules({ ...rules, pools });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `必须报「${keyword}」（实际 ${JSON.stringify(errors)}）`,
    );
  }
  // 个人积分口径的规则来源（atomicKinds / rollupKind）必须指向真实的 kind
  const badPoints = [
    [{ ...rules.points, personal: { ...rules.points.personal, atomicKinds: [] } }, 'atomicKinds 必须是非空数组'],
    [{ ...rules.points, personal: { ...rules.points.personal, atomicKinds: ['nope'] } }, 'atomicKinds 含不存在的积分 kind'],
    [{ ...rules.points, personal: { ...rules.points.personal, rollupKind: '' } }, 'rollupKind 必须是非空字符串'],
    [{ ...rules.points, personal: { ...rules.points.personal, rollupKind: 'nope' } }, 'rollupKind 引用了不存在的积分 kind'],
  ];
  for (const [points, keyword] of badPoints) {
    const errors = validateRules({ ...rules, points });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `必须报「${keyword}」（实际 ${JSON.stringify(errors)}）`,
    );
  }
});

test('领域纯函数：起始时间相同的赛段按 id 兜底定先后（与输入顺序无关）', () => {
  const rows = derivePoolProjects({
    teams: [{ id: 'tm_1', name: '一队', task_package_id: null, tier: 'C' }],
    packages: [],
    stageResults: [{ team_id: 'tm_1', stage_id: 'st_y' }, { team_id: 'tm_1', stage_id: 'st_x' }],
    stages: [
      { id: 'st_y', stage_key: 's9', starts_at: '2026-11-01' },
      { id: 'st_x', stage_key: 's8', starts_at: '2026-11-01' },
    ],
    tierRecords: [],
  });
  assert.equal(rows[0].stageReached, 's9', '同起始时间时按赛段 id 定先后（st_x < st_y）');
});

test('领域纯函数：derivePoolResources 跳过软删的任务包', () => {
  const rows = derivePoolResources({
    packages: [
      {
        id: 'tp_1', enterprise_id: 'ent_1', enterprise_name: '某银行', title: 'A', pain_point: 'p1', is_free_brief: 0,
      },
      {
        id: 'tp_2', enterprise_id: 'ent_1', enterprise_name: '某银行', title: 'B', pain_point: 'p2', is_free_brief: 0, deleted_at: '2026-10-02',
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, 'A：p1', '软删的任务包不计入资源池（明细里只剩没软删的那条）');
  assert.equal('packageCount' in rows[0], false, '契约的 pool_resources 没有这一列 ⇒ 不再产出算了就丢的字段');
});

// ═══════════════════════════════════════════════════════════════════
// P5 Task 3 修复轮（verifier 审查修复）新增用例
//   · I-2：同刻并列的确定性（段位记录 / 报名记录）
//   · I-1：变异口径的判别性用例（探针固定装置里原本缺的判别输入）
//   · I-3：个人积分口径唯一化后的跨模块一致性
//   · M-1：写后自检必须在事务内（不一致 ⇒ 回滚，脏值不落地）
//   · M-2：跨届期连带写入要单独计数
// ═══════════════════════════════════════════════════════════════════

// ── I-2：同刻并列的确定性 ───────────────────────────────────────────

test('★ 同刻的段位记录：按 rowid（写入次序）定先后，结果唯一且可复算', () => {
  // ⚠️ 两条 computed_at **完全相同**的段位记录，且 id 的字典序与插入次序**故意相反**：
  //    先插 'z-first-inserted'（字典序最大），后插 'a-second-inserted'（字典序最小）。
  //    ⇒ 「按 id 排」会选中 z-first，「按插入次序排」会选中 a-second，两种实现结果不同
  //    ⇒ 断言有判别力（不是「恰好相同」的无效断言）。
  const { db, close, dataDir } = setup(`
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count,
                              reasons_json, computed_at, deleted_at)
    VALUES ('z-first-inserted', 'tm_1', 'A', 9, 9, '[]', '2026-10-20T00:00:00.000Z', NULL),
           ('a-second-inserted', 'tm_1', 'B', 5, 5, '[]', '2026-10-20T00:00:00.000Z', NULL);
  `);
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT tier, business_value FROM pool_projects WHERE team_id = ?').get('tm_1');
  assert.equal(row.tier, 'B', '同刻时取**后写入**的那条（rowid 兜底，与 repo/tiers.js 同口径）');
  assert.equal(row.business_value, 5, '商业签字数跟着同一条走');
  assert.notEqual(row.tier, 'A', '不能按 id 字典序选（那是随机 UUID 排出来的顺序，不可复算）');
  // 再同步一次：结果必须稳定（幂等重建，不是「碰巧这次对了」）
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const again = db.prepare('SELECT tier FROM pool_projects WHERE team_id = ?').get('tm_1');
  assert.equal(again.tier, 'B', '重跑一次结果不变');
  cleanup(db, close, dataDir);
});

test('★ 同刻的段位记录：结果与入参顺序无关（兜底键由行内 rowid 决定）', () => {
  const tierRecords = [
    { team_id: 'tm_1', tier: 'A', business_signoff_count: 9, computed_at: '2026-10-20T00:00:00.000Z', rowid: 11 },
    { team_id: 'tm_1', tier: 'B', business_signoff_count: 5, computed_at: '2026-10-20T00:00:00.000Z', rowid: 12 },
  ];
  const teams = [{ id: 'tm_1', name: '一队', task_package_id: null, tier: 'C' }];
  const forward = derivePoolProjects({ teams, tierRecords });
  const backward = derivePoolProjects({ teams, tierRecords: [...tierRecords].reverse() });
  assert.equal(forward[0].tier, 'B', 'rowid 大的那条算数');
  assert.equal(backward[0].tier, 'B', '同一份数据换个顺序喂进来，结果必须一样');
  assert.deepEqual(forward[0], backward[0], '整个派生行都必须一样（不只是 tier）');
});

test('★ 同刻的报名记录：结果与入参顺序无关（兜底键由行内 rowid 决定）', () => {
  const registrations = [
    { user_id: 'u_x', dimension_scores_json: '{"b":2}', created_at: '2026-10-20T00:00:00.000Z', rowid: 21 },
    { user_id: 'u_x', dimension_scores_json: '{"a":1}', created_at: '2026-10-20T00:00:00.000Z', rowid: 22 },
  ];
  const base = {
    users: [{ id: 'u_x', name: '甲', org: null, mba_status: 'other' }],
    ledger: [{ user_id: 'u_x', kind: 'stage_rank', points: 5 }],
  };
  const forward = derivePoolTalents({ ...base, registrations });
  const backward = derivePoolTalents({ ...base, registrations: [...registrations].reverse() });
  assert.deepEqual(forward.rows[0].skills, [{ key: 'a', score: 1 }], 'rowid 大的那条算数');
  assert.deepEqual(forward.rows[0].skills, backward.rows[0].skills, '同一份数据换个顺序喂进来，技能画像必须一样');
});

test('同一人同一届最多一条有效报名（部分唯一索引）—— 同刻并列在真实数据上不可能出现', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => db.prepare(`
      INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json,
                                raw_score, level, level_final, decided_by, decided_at, decision_note,
                                status, created_at, deleted_at)
      VALUES ('rg_dup', 'ed_1', 'u_a', '{}', '{"a":1}', 10, 'S', 'S', 'u_c', '2026-10-01T00:00:00.000Z',
              NULL, 'registered', '2026-10-01T00:00:00.000Z', NULL)
    `).run(),
    /UNIQUE constraint failed/,
    '同一人同一届的有效报名只能有一条（这条约束是「同刻并列不可能出现」的根据）',
  );
  cleanup(db, close, dataDir);
});

// ── I-1：变异探针固定装置里原本缺的判别输入 ─────────────────────────

test('★ user_id 为空的流水行被跳过（不产出 null 键）', () => {
  // 真实写入方 src/db/repo/points.js 的 insertLedgerEntry 写的是 `userId ?? null`
  // ⇒ points_ledger.user_id 是**可空**列（schema 里没有 NOT NULL），这条流水真实存在。
  // 一旦不跳过，榜单上会多出一个 userId=null 的幽灵用户。
  const { byUser } = aggregatePersonalPoints({
    ledger: [
      { user_id: null, kind: 'stage_rank', points: 7 },
      { user_id: 'u_x', kind: 'stage_rank', points: 5 },
    ],
  });
  assert.deepEqual(Object.keys(byUser), ['u_x'], '空 user_id 的行不能造出一个 null 键');
  assert.equal(byUser.u_x.total, 5, '其余人的积分不受影响');
});

test('★ 画像分不是数字时按 0 计（不产生 NaN）', () => {
  const { rows } = derivePoolTalents({
    users: [{ id: 'u_x', name: '甲', org: null, mba_status: 'other' }],
    ledger: [{ user_id: 'u_x', kind: 'stage_rank', points: 5 }],
    registrations: [{ user_id: 'u_x', dimension_scores_json: '{"direction":"N/A"}', created_at: '2026-10-01' }],
  });
  assert.deepEqual(rows[0].skills, [{ key: 'direction', score: 0 }], '非数值画像分兜底 0，不是 NaN');
});

// ── I-3：个人积分口径唯一化后的跨模块一致性 ─────────────────────────

test('★ 跨模块一致性：榜单与人才池对同一份流水给出的每人 total 完全相同', () => {
  const { rules } = loadRules(rulesDir);
  const ledger = [
    { userId: 'u_x', kind: 'stage_rank', points: 10, stageId: 'st_1' },
    { userId: 'u_x', kind: 'personal_rollup', points: 12, stageId: 'st_2' },
    { userId: 'u_y', kind: 'weird', points: 99 },
  ];
  const agg = aggregatePersonalPoints({ ledger, pointsConfig: rules.points });
  const board = computePersonalPoints({ ledger, pointsConfig: rules.points });
  for (const row of board.rows) {
    const same = agg.byUser[row.userId];
    assert.ok(same, `人才池也必须有 ${row.userId}`);
    assert.equal(row.total, same.total, `${row.userId} 的 total 两边必须完全相同`);
  }
  assert.equal(agg.byUser.u_x.total, 12, '有 rollup 行时以 rollup 为准（12，不是 10+12）');
  assert.equal(agg.byUser.u_y.total, 0, '未知 kind 不计入');
  assert.equal(board.rows.find((r) => r.userId === 'u_y')?.total, 0, '未知 kind 在榜单上也不计入');
  assert.ok(!('null' in agg.byUser), '不产出 null 键');
  assert.deepEqual(
    board.rows.find((r) => r.userId === 'u_x').byKind,
    { stage_rank: 10, personal_rollup: 12 },
    '分项来源（byKind）必须真的给出来 —— 榜单要能看出分从哪来',
  );
  assert.equal(board.excludedEntries, 1, '口径外的那一行计入排除条数（不静默）');
});

test('★ 口径真的来自规则文件本身（rules/points.json 的 personal 组）', () => {
  const { rules } = loadRules(rulesDir);
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW, rules: { points: rules.points } });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  // u_a 的流水：stage_rank 10 + mvp 5 + 另一届的 stage_rank 8 = 23
  assert.equal(row.p, 23, '按仓库自带的规则文件算，u_a 是 23（mvp 与 roadshow 都在白名单里）');
  cleanup(db, close, dataDir);
});

test('★ rollupKind 是配置项：真的被读到了（换成另一个合法 kind，口径就变）', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_ub_rank', 'ed_1', 'st_1', 'tm_2', 'u_b', 'stage_rank', 4, '2026-10-10T00:00:00.000Z'),
           ('pl_roll', 'ed_1', 'st_1', 'tm_2', 'u_b', 'mvp', 7, '2026-10-14T00:00:00.000Z');
  `);
  syncPoolTalents({
    db,
    editionId: 'ed_1',
    now: NOW,
    rules: { points: { personal: { atomicKinds: ['stage_rank', 'mvp'], rollupKind: 'mvp' } } },
  });
  // u_b 的流水：stage_rank 4 + mvp 7 —— rollupKind 指向 mvp ⇒ 以 mvp 之和（7）为准，不是 4+7
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_b');
  assert.equal(row.p, 7, 'rollupKind=mvp ⇒ 以 mvp 之和为准（rollupKind 必须真的被读到）');
  cleanup(db, close, dataDir);
});

test('★ 派生源读取必须把 rowid 带出来（域函数同刻并列的兜底键）', () => {
  const { db, close, dataDir } = setup();
  const tiers = poolSourcesRepo.listEditionTierRecords(db, 'ed_1');
  assert.equal(tiers.length, 2);
  for (const r of tiers) {
    assert.ok(Number.isFinite(r.rowid), '段位记录必须带 rowid —— 域函数靠它做同刻并列的显式比较');
  }
  const regs = poolSourcesRepo.listEditionRegistrations(db, 'ed_1');
  assert.equal(regs.length, 1);
  for (const r of regs) {
    assert.ok(Number.isFinite(r.rowid), '报名记录必须带 rowid');
  }
  cleanup(db, close, dataDir);
});

test('★ 派生源读取的排序：同刻并列必须有确定性兜底键（⛔ 不得用随机 UUID 的 id 列）', () => {
  // ⚠️ 这是**源码扫描**测试（不是行为测试）：排序键相等时 SQLite **不保证**返回顺序，
  //    而「不保证」的东西没法用行为断言钉住 —— 只能把「必须带兜底键」这条纪律本身钉住。
  //    背景：points_ledger / tier_records / registrations 的 id 列全是 randomUUID()
  //    （src/db/repo/points.js、tiers.js、registrations.js 的头部注释同款纪律），
  //    拿它当排序兜底键 ⇒ 同一批写入的记录顺序逐次运行都不同 ⇒ 不可复算。
  const src = readFileSync(join(here, '..', 'src', 'db', 'repo', 'pool-sources.js'), 'utf8');
  const orders = [...src.matchAll(/ORDER BY ([^\n`]+)/g)].map((m) => m[1].trim());
  assert.ok(orders.length >= 4, `扫描器必须真的扫到 ORDER BY（防「一条都不判违规」的假绿）：${JSON.stringify(orders)}`);
  for (const o of orders) {
    assert.ok(
      !/(computed_at|created_at)[^,]*,\s*id\s*$/.test(o),
      `ORDER BY ${o} 用了 id 列当兜底键 —— 那三张表的 id 是 randomUUID（顺序逐次运行都不同）`,
    );
  }
  for (const needle of [
    'ORDER BY tr.team_id, tr.computed_at, tr.rowid',
    'FROM registrations WHERE edition_id = ? ORDER BY user_id, created_at, rowid',
    'FROM points_ledger WHERE user_id = ? ORDER BY created_at, rowid',
  ]) {
    assert.ok(src.includes(needle), `pool-sources.js 必须保留确定性兜底键：${needle}`);
  }
});

// ── M-1：写后自检必须在事务内 ───────────────────────────────────────

test('★ 写后自检不一致时：脏值必须被回滚（自检在 withTransaction 内）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const before = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  db.exec(`
    CREATE TRIGGER trg_corrupt AFTER UPDATE ON pool_talents
    BEGIN
      UPDATE pool_talents SET total_points = total_points + 1 WHERE rowid = NEW.rowid;
    END;
  `);
  assert.throws(
    () => syncPoolTalents({ db, editionId: 'ed_1', now: NOW }),
    (e) => e?.status === 500 && e?.code === 'POOL_TALENT_POINTS_MISMATCH',
  );
  const after = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  assert.equal(
    after.p, before.p,
    '不一致时整批写入必须回滚 —— 自检在事务外的话，脏值已经提交了',
  );
  cleanup(db, close, dataDir);
});

// ── M-2：跨届期连带写入要单独计数 ───────────────────────────────────

test('同步计数：跨届期连带写入单独计数（updatedOtherEditions）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  // u_a 的积分流水跨 ed_1 / ed_2 两届 ⇒ 同步任一届都会把两届的行都刷新
  const second = syncPoolTalents({ db, editionId: 'ed_2', now: NOW });
  assert.equal(second.inserted, 1, '本届时新建一行');
  assert.equal(second.updated, 0, '本届时没有可更新的行');
  assert.equal(second.updatedOtherEditions, 1, '别届期被连带刷新的那一行单独计数（原来完全不计数）');
  const third = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.equal(third.updated, 1, '本届时那一行算 updated');
  assert.equal(third.updatedOtherEditions, 1, '别届期那一行算 updatedOtherEditions（不混进 updated）');
  cleanup(db, close, dataDir);
});

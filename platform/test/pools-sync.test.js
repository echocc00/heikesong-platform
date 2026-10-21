import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { loadRules, validateRules } from '../src/config.js';

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

test('规则口径：talentPointKinds 决定哪些 kind 计入积分', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({
    db,
    editionId: 'ed_1',
    now: NOW,
    rules: { pools: { talentPointKinds: { atomic: ['stage_rank'], rollup: 'personal_rollup' } } },
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
    [{ ...rules.pools, talentPointKinds: { rollup: 'personal_rollup' } }, 'talentPointKinds'],
  ];
  for (const [pools, keyword] of bad) {
    const errors = validateRules({ ...rules, pools });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `${keyword} 不合规必须报错（实际 ${JSON.stringify(errors)}）`,
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
  assert.equal(rows[0].packageCount, 1, '软删的任务包不计入资源池');
});
